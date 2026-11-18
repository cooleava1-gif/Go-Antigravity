const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSettings, normalizeSettings, assertLaunchSettingsMutable } = require('../core/settings');
const { createAccounts } = require('../core/accounts');
const { createAgCred } = require('../core/agcred');
const { createCredentialVault } = require('../core/vault');
const { createAgQuota, mergeLiveUserStatus } = require('../core/agquota');
const { createAgUsage } = require('../core/agusage');
const { createFlowStore, buildAuthUrl, parseCallbackInput, parseTokenImportInput, openInBrowser, CALLBACK_PATH } = require('../core/agoauth');
const { Events } = require('../core/events');
const { Session } = require('../core/session');
const { writeJson } = require('../core/storage');
const { loadDictionary } = require('../features/i18n');
const { Updater } = require('../features/updater');
const { CdpHub } = require('../adapters/desktop/cdp');
const { rendererSource } = require('../adapters/desktop/renderer');
const { createDesktopAdapter } = require('../adapters/desktop');
const { createHost } = require('./host');
const { createApi } = require('./api');
const { LanguageService } = require('../adapters/desktop/language-service');
const { ContextMonitor } = require('../features/context-monitor');
const { createSourceGuard } = require('../features/source-guard');
const { inspectKernel, applyKernelPatch, CONTEXT_MODES, PROMPT_TIERS, CONTEXT_SIGNATURES } = require('../features/kernel-patch');
const { probeProxy } = require('../features/proxy-probe');
const { createAgLogWatcher } = require('../features/ag-log-watch');
const { createMobileAccess } = require('../features/mobile-access');
const { createMobileSecrets, credentialError } = require('../core/mobile-secrets');

async function createApplication({ rootDir, dataDir, native = false, testMode = false, mobileVault, agCred, agQuota, agUsage, kernelInspector = inspectKernel, kernelPatcher = applyKernelPatch, openUrl = openInBrowser, onClose = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new Events(dataDir);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const agcred = agCred || createAgCred({ scriptPath: path.join(rootDir, 'tools', 'agcred.ps1') });
  // Account tokens are sealed at rest with a master key that lives in Windows Credential
  // Manager, so the key has to be read (one PowerShell spawn) before the pool is loaded.
  // Test mode skips the vault entirely: no credential store access, plaintext on disk.
  const vault = testMode ? null : createCredentialVault({
    agcred,
    plaintext: process.env.EASYAG_PLAINTEXT_TOKENS === '1',
    log: (message, level) => events.log('SYSTEM', message, level || 'tag-proxy')
  });
  if (vault) await vault.unlock();
  // Only tests may inject a synthetic vault; production reuses the unlocked account vault.
  const mobileSecrets = createMobileSecrets(dataDir, { vault: testMode ? mobileVault : vault, settings });
  const mobile = createMobileAccess({ events, settings, secrets: mobileSecrets, testMode });
  const accounts = createAccounts(dataDir, {
    vault,
    onNotice: (message, level) => events.log('SYSTEM', message, level === 'warn' ? 'tag-warn' : 'tag-proxy')
  });
  const agquota = agQuota || (typeof agcred.http === 'function' ? createAgQuota({ http: agcred.http }) : null);
  const agusage = agUsage || createAgUsage(testMode ? { conversationsDir: path.join(dataDir, 'conversations') } : {});
  const desktop = createDesktopAdapter(testMode);
  let dictionary = loadDictionary(rootDir);
  const host = createHost({ native, testMode, events });
  const languageService = new LanguageService({ profile: () => desktop.profile });
  const sourceGuard = createSourceGuard({ rootDir });
  const live = { at: 0, refreshToken: null, running: null };
  let quotaTask = null;
  let accountTransition = null;
  const tokenFields = ['accessToken', 'refreshToken', 'expiryTs', 'clientType'];
  const captureCredential = account => ({
    id: account.id, email: account.email, revision: accounts.credentialRevision(account.id),
    tokens: Object.fromEntries(tokenFields.map(key => [key, account[key]])),
    locked: Boolean(account.locked)
  });
  const credentialMatches = captured => {
    const current = accounts.find(captured.id);
    return Boolean(current) && accounts.credentialRevision(captured.id) === captured.revision
      && Boolean(current.locked) === captured.locked
      && tokenFields.every(key => current[key] === captured.tokens[key]);
  };
  const assertCredential = captured => {
    if (!credentialMatches(captured)) {
      throw Object.assign(new Error('账户授权已改变，已取消过时操作，请重试'), { status: 409, code: 'account_changed' });
    }
  };
  const capturePool = () => accounts.all().map(captureCredential);
  const assertUpsertCurrent = (captured, { id, email, refreshToken }) => {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const current = (id && accounts.find(id))
      || accounts.all().find(item => item.refreshToken === refreshToken)
      || (normalizedEmail && accounts.all().find(item => String(item.email || '').trim().toLowerCase() === normalizedEmail));
    const before = captured.find(item => item.id === (current?.id || id))
      || (!current && captured.find(item => item.tokens.refreshToken === refreshToken
        || (normalizedEmail && String(item.email || '').trim().toLowerCase() === normalizedEmail)));
    if (!current && !id && !before) return;
    if (!before) throw Object.assign(new Error('账户授权已改变，已取消过时操作，请重试'), { status: 409, code: 'account_changed' });
    assertCredential(before);
  };
  // Reading the login identity means spawning PowerShell (CredRead + Add-Type, ~0.5 s), so
  // it is cached for API reads and only probed in the background while AG is actually up.
  const LIVE_TTL_MS = 5000;
  const LIVE_POLL_MS = 30000;

  // A saved preference is not evidence about the running language server. Capture only
  // a fully inspected desktop kernel immediately before our own successful launch.
  let pendingContextCap = 0;
  let runningContextCap = 0;
  const effectiveContextCap = () => session?.phase === 'running' ? runningContextCap : 0;
  const contextMonitor = new ContextMonitor(languageService, {
    contextCap: effectiveContextCap,
    onSample: (sample, userStatus) => {
      if (userStatus?.email) {
        const matched = accounts.all().find(a => (a.email || '').toLowerCase() === userStatus.email.toLowerCase());
        if (matched) {
          const merged = mergeLiveUserStatus(matched.quota, userStatus);
          accounts.updateQuota(matched.id, merged);
        }
      }
      events.publish({ liveUsage: sample, tokenUsage: agusage.snapshot(), accounts: accounts.snapshot(live.refreshToken) });
    }
  });

  let session;
  let lastStatus = '';
  let kernelResult = null;
  let kernelInspection = null;
  const readKernelInspection = (refresh = true) => {
    if (refresh || !kernelInspection) kernelInspection = kernelInspector();
    return kernelInspection;
  };
  const runKernelPatch = async input => {
    try { return await kernelPatcher(input); }
    finally { kernelInspection = null; }
  };
  let proxyResult = null;
  // The last probe outcome is cached in memory only: re-probing on every SSE tick would open a
  // tunnel to Google three times a second for a badge that changes once per launch.
  let proxyCheckInFlight = null;
  const proxyStatus = () => ({
    port: settings.get().port,
    enabled: settings.get().preflightProxy,
    lastResult: proxyResult,
    // Whether the AG log watcher is tailing right now. Cheap and diagnostic: it answers "is the
    // thing that is supposed to catch the 400 actually running?" without opening another tunnel.
    logWatch: { watching: agLogWatcher.watching, logPath: agLogWatcher.logPath }
  });
  const runProxyCheck = async (trigger = 'launch') => {
    if (proxyCheckInFlight) return proxyCheckInFlight;
    proxyCheckInFlight = (async () => {
      const port = settings.get().port;
      const probe = await probeProxy({ port });
      proxyResult = { ...probe, trigger };
      return proxyResult;
    })();
    try {
      return await proxyCheckInFlight;
    } finally {
      proxyCheckInFlight = null;
    }
  };
  // The preflight cannot see a refused exit region, so the only witness left is AG's own log. This
  // tails it for as long as AG is up and reports the failure with the current exit named, which is
  // the difference between "HTTP 400" and "your proxy exits in Singapore and Google refuses that".
  const agLogWatcher = createAgLogWatcher({
    events,
    describeEgress: () => {
      const egress = proxyResult && proxyResult.egress;
      if (!egress) return '';
      const place = [egress.countryName, egress.city].filter(Boolean).join(' ');
      const parts = [`当前代理出口 ${egress.ip}`];
      if (place) parts.push(place);
      if (egress.org) parts.push(egress.org);
      return `${parts.join(' · ')}（经 127.0.0.1:${settings.get().port}）`;
    }
  });
  const kernelDesired = () => {
    const current = settings.get();
    return { promptTier: current.promptTier, contextMode: current.contextMode };
  };
  const cdp = new CdpHub({
    profile: () => desktop.profile,
    source: binding => rendererSource(dictionary, settings.get(), binding),
    onMetrics: id => settings.get().enableContextMonitor && session?.phase === 'running' && !testMode
      ? contextMonitor.sample(id) : Promise.resolve({ conversationId: id, state: 'unavailable', context: null, speed: null }),
    onStop: () => contextMonitor.reset(),
    onStatus: status => {
      const key = JSON.stringify([status.cdpSockets, status.cdpTargets, status.cdpError]);
      if (key === lastStatus) return;
      lastStatus = key;
      events.publish({ status: status.cdpSockets ? '增强功能已连接' : '等待连接', ...session.snapshot(), ...status });
    }
  });
  session = new Session({
    settings, desktop, cdp, events, host, testMode,
    onStart: () => {
      runningContextCap = session.child ? pendingContextCap : 0;
      pendingContextCap = 0;
      contextMonitor.reset();
      agLogWatcher.start();
      void mobile.onAgStart().catch(() => {});
    },
    // Mirrors onStart so a watcher never outlives the AG it was watching. Both the spawn path and
    // attachExisting call these, so the log is covered in either case.
    onExit: () => {
      pendingContextCap = runningContextCap = 0;
      contextMonitor.reset();
      agLogWatcher.stop();
      void mobile.onAgExit().catch(() => {});
    },
    // Runs after AG is known to be closed but before it is spawned, so a kernel patch can never
    // race a running language_server for the file handle.
    onBeforeLaunch: async () => {
      pendingContextCap = runningContextCap = 0;
      // Proxy first: a dead proxy means AG would only surface it as an opaque HTTP 400 dialog,
      // and there is no point rewriting the kernel for a launch that cannot reach Google anyway.
      if (settings.get().preflightProxy) {
        const probe = await runProxyCheck('launch');
        if (!probe.ok) {
          events.log('PROXY', probe.message, 'tag-alert');
          if (probe.advice) events.log('PROXY', probe.advice, 'tag-warn');
          // Thrown, not returned: the Session treats a hook failure exactly like any other launch
          // error, so AG is never spawned and the UI shows the reason.
          throw new Error(`代理自检未通过，已取消启动：${probe.message}${probe.advice ? `（${probe.advice}）` : ''}`);
        }
        events.log('PROXY', probe.message, 'tag-proxy');
      }
      const desired = kernelDesired();
      let inspection = readKernelInspection();
      const existing = inspection.targets.filter(target => target.exists);
      const automatic = {};
      // A numeric legacy preference is not consent to replace it with a new payload.
      // Context-only recovery must also leave every legacy prompt byte untouched.
      const allowPrompt = settings.get().promptPayloadVersion === 2
        && ["stock", "3", "4"].includes(desired.promptTier)
        && !existing.some(target => target.promptLegacy || target.promptPayloadVersion === 1);
      if (allowPrompt && existing.some(target => target.promptTier !== desired.promptTier)) automatic.promptTier = desired.promptTier;
      if (existing.some(target => target.contextMode !== desired.contextMode)) automatic.contextMode = desired.contextMode;
      if (settings.get().autoApplyKernelPatch && Object.keys(automatic).length) {
        events.log('SYSTEM', '检测到内核设置变化，正在同步已确认的选项', 'tag-proxy');
        const result = await runKernelPatch(automatic);
        for (const line of result.logs) events.log('KERNEL', line, result.ok ? 'tag-proxy' : 'tag-warn');
        for (const line of result.errors) events.log('KERNEL', line, 'tag-alert');
        kernelResult = { at: Date.now(), ok: result.ok, logs: result.logs, errors: result.errors, trigger: 'launch' };
        if (!result.ok) {
          events.publish({ kernel: app.kernelStatus() });
          throw new Error(`内核自动同步失败，已取消启动：${result.errors.join('；') || '请检查内核状态后重试'}`);
        }
        inspection = readKernelInspection();
        events.publish({ kernel: app.kernelStatus({ refresh: false }) });
      }
      const target = inspection.targets.find(item => item.id === 'desktop' && item.exists && !item.error);
      // CLI/Desktop/IDE builds contain different subsets of these signatures. Trust only
      // the gates actually recognized in this build, all agreeing on the same mode.
      if (target && target.gates?.length > 0
        && target.gates.every(gate => gate.mode === target.contextMode
          && CONTEXT_SIGNATURES.some(signature => signature.id === gate.id))) {
        pendingContextCap = CONTEXT_MODES[target.contextMode]?.tokens || 0;
      }
      await applyStartupAccount();
    }
  });
  // Launch preparation and switching both write the one desktop login. Reserve the same
  // transition before their first await; only the owning switch may request its restart.
  const launchSession = session.launch.bind(session);
  session.launch = async owner => {
    if (accountTransition && owner !== accountTransition) return { ok: false, error: '正在切换账户，请稍候再启动 AG' };
    const acquired = !accountTransition;
    const transition = accountTransition || {};
    if (acquired) accountTransition = transition;
    try { return await launchSession(); }
    finally { if (acquired && accountTransition === transition) accountTransition = null; }
  };
  const updater = new Updater();
  let closing;

  let liveReadRevision = 0;
  const refreshLive = async (force = false) => {
    if (!force && Date.now() - live.at < LIVE_TTL_MS) return live.refreshToken;
    live.at = Date.now();
    const revision = ++liveReadRevision;
    try {
      const credential = await agcred.readSystemCredential();
      if (revision === liveReadRevision) live.refreshToken = credential?.refreshToken || null;
    } catch { if (revision === liveReadRevision) live.refreshToken = null; }
    return live.refreshToken;
  };
  const accountsSnapshot = async () => accounts.snapshot(await refreshLive());
  const oauthFlows = createFlowStore();
  const oauthRedirectUri = () => `http://127.0.0.1:${app.apiPort}${CALLBACK_PATH}`;

  // Session calls this only after proving AG is closed and completing its launch checks.
  // A selected card must become the system login before the new process can read it.
  async function applyStartupAccount() {
    const account = accounts.active();
    if (!account) return;
    if (account.locked) throw new Error('启动账户的本地令牌无法解密，请先重新授权');
    const captured = captureCredential(account);
    const originalTokens = captured.tokens;
    const assertSelected = () => {
      if (session.closed || session.phase !== 'launching') throw new Error('启动已取消');
      if (accounts.active()?.id !== account.id || !credentialMatches(captured)) {
        throw new Error('启动账户已改变，已取消启动，请重试');
      }
    };
    assertSelected();
    let fresh;
    try {
      fresh = await agcred.ensureFresh({ ...account }, settings.get().port, { publicOnly: true });
    } catch (error) {
      assertSelected();
      const stillValid = account.accessToken && Number(account.expiryTs) > Date.now() + 60000;
      if (!stillValid) {
        const action = error.permanent ? '请先重新授权' : '已取消启动，请修复后重试';
        throw new Error('启动账户令牌无法刷新，' + action + '：' + error.message);
      }
      fresh = { accessToken: account.accessToken, refreshToken: account.refreshToken, expiryTs: account.expiryTs, clientType: account.clientType };
      events.log('SYSTEM', '启动账户刷新暂时失败，使用尚未过期的缓存令牌', 'tag-warn');
    }
    assertSelected();
    const previous = await agcred.readSystemCredential();
    assertSelected();
    const changed = ['accessToken', 'refreshToken', 'expiryTs'].some(key => previous?.[key] !== fresh[key]);
    let persistenceAttempted = false;
    try {
      if (changed) await agcred.writeSystemCredential(fresh);
      assertSelected();
      persistenceAttempted = true;
      accounts.updateTokens(account.id, fresh);
    } catch (error) {
      if (persistenceAttempted) {
        try { accounts.restoreTokens(account.id, originalTokens); } catch { /* the save error is reported below */ }
      }
      let restored = false;
      if (changed && previous?.refreshToken) {
        try { await agcred.writeSystemCredential(previous); restored = true; } catch { /* report below */ }
      }
      throw new Error('写入启动账户凭据失败，已取消启动' + (restored ? '并恢复原凭据' : '；请检查 AG 登录状态') + '：' + error.message);
    }
    liveReadRevision += 1;
    live.refreshToken = fresh.refreshToken;
    live.at = Date.now();
    events.publish({ accounts: accounts.snapshot(live.refreshToken) });
  }

  async function resolveProfile(accessToken, proxyPort) {
    if (typeof agcred.userinfoProfile === 'function') {
      return agcred.userinfoProfile(accessToken, proxyPort);
    }
    const email = await agcred.userinfoEmail(accessToken, proxyPort);
    return { email, name: null, picture: null };
  }

  const app = {
    rootDir, dataDir, events, settings, desktop, host, cdp, session, contextMonitor, updater, accounts, agcred, agquota, agusage, mobile,
    // Every boot gets a fresh token; the shell's page receives it inlined in index.html and
    // must present it on every /api/* call. A stale tab from a previous run cannot ride along.
    apiToken: randomUUID().replace(/-/g, ''),
    accountsSnapshot,
    status() {
      return {
        ...settings.get(), ...session.snapshot(), ...cdp.status, ...updater.currentState(),
        dictEntries: Object.keys(dictionary).length, capabilities: desktop.capabilities,
        accounts: accounts.snapshot(live.refreshToken),
        oauthFlow: oauthFlows.active(),
        liveUsage: contextMonitor.snapshot(),
        tokenUsage: agusage.snapshot(),
        quotaTask,
        bootedAt: sourceGuard.bootedAt,
        sourceChanged: sourceGuard.check().changed,
        kernel: app.kernelStatus({ refresh: false }),
        // The cached last outcome only, so the 3 s SSE tick never opens a tunnel to Google.
        proxy: proxyStatus(),
        mobile: mobile.snapshot()
      };
    },
    // Only physical inspection is cached for SSE ticks; desired settings and results stay live.
    // Explicit refresh and pre-launch checks still inspect installed kernels on demand.
    kernelStatus({ refresh = true } = {}) {
      const inspection = readKernelInspection(refresh);
      return {
        desired: kernelDesired(),
        promptPreferenceVersion: settings.get().promptPayloadVersion,
        autoApplyKernelPatch: settings.get().autoApplyKernelPatch,
        contextCap: effectiveContextCap(),
        desiredContextCap: CONTEXT_MODES[settings.get().contextMode].tokens,
        platformSupported: inspection.platformSupported,
        targets: inspection.targets,
        // Labels travel with the status so the UI never has to duplicate the tier descriptions
        // and drift away from what the patcher actually does.
        tiers: PROMPT_TIERS,
        modes: CONTEXT_MODES,
        lastResult: kernelResult
      };
    },
    // Cached last outcome plus the two inputs that produced it. Read-only and cheap, so the SSE
    // tick can carry it; only proxyCheck() opens a tunnel.
    proxyStatus() {
      return proxyStatus();
    },
    // Runs the same probe the launcher runs before spawning AG, on demand. Kept separate from
    // status() for the same reason as kernelStatus(): it opens a tunnel to Google.
    proxyCheck(trigger = 'manual') {
      return runProxyCheck(trigger);
    },
    // Persist a verified patch as the preference for the next launch. The running
    // instance keeps the capacity captured at its own launch until it exits.
    async applyKernel(input = {}) {
      const current = settings.get();
      const explicitAxes = input.promptTier !== undefined || input.contextMode !== undefined;
      const request = explicitAxes ? { ...input } : { contextMode: current.contextMode };
      const result = await runKernelPatch(request);
      for (const line of result.logs) events.log('KERNEL', line, result.ok ? 'tag-proxy' : 'tag-warn');
      for (const line of result.errors) events.log('KERNEL', line, 'tag-alert');
      kernelResult = { at: Date.now(), ok: result.ok, logs: result.logs, errors: result.errors, trigger: 'manual' };
      if (result.ok) {
        // A failed patch must not move the saved preference for subsequent launches.
        const saved = {};
        if (result.promptTier != null) saved.promptTier = result.promptTier;
        if (result.contextMode != null) saved.contextMode = result.contextMode;
        if (input.promptTier !== undefined && result.promptTier != null) saved.promptPayloadVersion = 2;
        await app.configure(saved);
      } else {
        events.publish({ kernel: app.kernelStatus() });
      }
      return { ok: result.ok, logs: result.logs, errors: result.errors };
    },
    selectAccount(id) {
      if (accountTransition || ['preparing', 'launching'].includes(session.phase)) {
        throw Object.assign(new Error('正在启动 AG，请稍候再选择启动账户'), { status: 409 });
      }
      accounts.select(id);
      const snapshot = accounts.snapshot(live.refreshToken);
      events.publish({ accounts: snapshot });
      return snapshot;
    },
    // Switch only after AG is confirmed closed. Process names and an old child PID
    // cannot prove ownership, so running or unknown instances require a manual exit.
    async switchAccount(id) {
      if (accountTransition || ['preparing', 'launching'].includes(session.phase)) {
        throw Object.assign(new Error('正在启动或切换 AG，请稍候再切换'), { status: 409 });
      }
      const transition = {};
      accountTransition = transition;
      try {
        const account = accounts.find(id);
        if (!account) throw new Error('账户不存在');
        if (account.locked) throw new Error('该账户的本地令牌无法解密，请点「重新授权」重新登录');
        const captured = captureCredential(account);
        const previousActiveId = accounts.snapshot().activeId;
        const assertCurrent = () => {
          assertCredential(captured);
          if (session.closed || accounts.snapshot().activeId !== previousActiveId
            || ['preparing', 'launching'].includes(session.phase)) {
            throw Object.assign(new Error('账户或启动状态已改变，已取消切换，请重试'), { status: 409 });
          }
        };
        const proxyPort = settings.get().port;
        let fresh;
        try {
          fresh = await agcred.ensureFresh({ ...account }, proxyPort, { publicOnly: true });
        } catch (error) {
          assertCurrent();
          const stillValid = account.accessToken && Number(account.expiryTs) > Date.now() + 60000;
          accounts.markStatus(id, {
            status: error.permanent || !stillValid ? 'expired' : (account.status === 'pending' ? 'pending' : 'ok'),
            error: error.message
          });
          events.publish({ accounts: accounts.snapshot(live.refreshToken) });
          if (!stillValid) {
            throw new Error(`账户「${account.email || account.name}」令牌无法刷新（${error.message}），请点击「授权添加」重新绑定`);
          }
          events.log('SYSTEM', `令牌预刷新失败（${error.message}），暂时使用未过期的缓存令牌；建议通过「授权添加」重新绑定`, 'tag-warn');
          fresh = { ...captured.tokens };
        }
        assertCurrent();
        let previousCredential;
        try {
          previousCredential = await agcred.readSystemCredential();
        } catch {
          // A missing credential is safe; an unreadable one cannot be backed up for rollback.
          throw Object.assign(new Error('无法读取 AG 原登录凭据，已取消账户切换；请确认系统凭据可读取后重试'), { status: 503, code: 'credential_read_failed' });
        }
        assertCurrent();
        let running;
        try { running = await desktop.running({ strict: true }); }
        catch {
          throw Object.assign(new Error('无法确认 AG 已退出，已取消账户切换；请先手动退出 AG 后重试'), { status: 409, code: 'ag_state_unknown' });
        }
        assertCurrent();
        if (running !== false) {
          throw Object.assign(new Error('AG 尚未确认关闭，已取消账户切换；请先手动退出 AG 后重试'), { status: 409, code: running === true ? 'ag_running' : 'ag_state_unknown' });
        }
        if (session.phase === 'running') {
          await session.finish('AG 已退出，正在清理原会话以切换账户');
          assertCurrent();
        }

        let persisted = null;
        try {
          await agcred.writeSystemCredential(fresh);
          assertCurrent();
          // No await between the final compare and pool writes. A failed synchronous save
          // may still mutate memory, so capture that owned revision for guarded rollback.
          try { accounts.updateTokens(id, fresh); }
          finally { if (accounts.find(id)) persisted = captureCredential(accounts.find(id)); }
          accounts.markSwitched(id);
          accounts.markStatus(id, { status: 'ok', error: null });
          accounts.select(id);
        } catch (error) {
          if (persisted && credentialMatches(persisted)) {
            const restoreSelection = accounts.snapshot().activeId === id;
            try { accounts.restoreTokens(id, captured.tokens); } catch { /* report original error */ }
            if (restoreSelection && previousActiveId && previousActiveId !== id) {
              try { accounts.select(previousActiveId); } catch { /* previous account may be gone */ }
            }
          }
          let restored = false;
          if (previousCredential?.refreshToken) {
            try { await agcred.writeSystemCredential(previousCredential); restored = true; } catch { /* report below */ }
          }
          await refreshLive(true).catch(() => {});
          events.publish({ accounts: accounts.snapshot(live.refreshToken) });
          const failure = persisted ? 'AG 新登录凭据已写入，但账户池保存失败' : '写入 AG 系统凭据失败';
          const recovery = restored ? '已回滚到原账户并恢复原登录凭据'
            : previousCredential?.refreshToken ? '原登录凭据未能恢复，请在 AG 内重新登录并确认当前账户'
              : '原先无可恢复的登录凭据，请在 AG 内重新登录并确认当前账户';
          events.log('SYSTEM', `${failure}；${recovery}`, 'tag-alert');
          throw new Error(`${failure}；${recovery}`);
        }
        await refreshLive(true);
        assertCredential(persisted);
        const snapshot = accounts.snapshot(live.refreshToken);
        events.log('SYSTEM', `已切换到账户「${account.name}」${account.email ? `（${account.email}）` : ''}，下次启动 AG 时生效`, 'tag-proxy');
        events.publish({ accounts: snapshot });
        if (!testMode && agquota) void app.refreshAccountQuota(id).catch(() => {});
        return { accounts: snapshot, restarted: false };
      } finally {
        if (accountTransition === transition) accountTransition = null;
      }
    },
    async captureCurrentAccount() {
      const captured = capturePool();
      const credential = await agcred.readSystemCredential();
      if (!credential) throw new Error('未检测到 AG 的登录凭据，请先在 AG 内登录或使用「授权添加」');
      const proxyPort = settings.get().port;
      let email = null;
      let displayName = null;
      let clientType = null;
      try {
        const fresh = await agcred.ensureFresh(credential, proxyPort);
        credential.accessToken = fresh.accessToken;
        credential.refreshToken = fresh.refreshToken;
        credential.expiryTs = fresh.expiryTs;
        clientType = fresh.clientType || null;
        const profile = await resolveProfile(fresh.accessToken, proxyPort);
        email = profile.email;
        displayName = profile.name;
      } catch {
        if (credential.accessToken) {
          try {
            const profile = await resolveProfile(credential.accessToken, proxyPort);
            email = profile.email;
            displayName = profile.name;
          } catch { /* offline */ }
        }
      }
      assertUpsertCurrent(captured, { email, refreshToken: credential.refreshToken });
      const account = accounts.upsert({
        email, name: displayName || email || 'AG 登录账户',
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiryTs: credential.expiryTs,
        clientType,
        source: 'current', select: true
      });
      await refreshLive(true);
      const snapshot = accounts.snapshot(live.refreshToken);
      events.log('SYSTEM', `已保存当前登录账户「${account.email || account.name}」`, 'tag-proxy');
      if (clientType === 'ide') {
        events.log('SYSTEM', '提示：该令牌由 AG 内置客户端签发，1 小时后可能无法自动续期；建议点击「授权添加」重新绑定以永久续期', 'tag-warn');
      }
      events.publish({ accounts: snapshot });
      if (!testMode && agquota) void app.refreshAccountQuota(account.id).catch(() => {});
      return snapshot;
    },
    async addAccount(input = {}) {
      const entries = parseTokenImportInput(input.rawInput || input.refreshToken, input.email);
      const addedIds = [];
      for (const entry of entries) {
        const account = accounts.upsert({
          email: entry.email,
          name: entry.name || entry.email,
          refreshToken: entry.refreshToken,
          source: 'manual',
          // Unverified until Google answers once; the background quota pass flips it to ok or
          // expired, so the card can show "待校验" instead of silently pretending it works.
          status: 'pending',
          select: true
        });
        addedIds.push(account.id);
      }
      const snapshot = accounts.snapshot(live.refreshToken);
      events.log('SYSTEM', `已导入 ${addedIds.length} 个账户令牌，正在后台校验`, 'tag-proxy');
      events.publish({ accounts: snapshot });
      if (!testMode) {
        void (async () => {
          for (const id of addedIds) {
            try { await app.refreshAccountQuota(id); } catch { /* the card shows the failure */ }
          }
        })();
      }
      return snapshot;
    },
    exportAccounts({ includeTokens = false } = {}) {
      const pool = accounts.exportPool({ includeTokens });
      events.log('SYSTEM', includeTokens ? '已导出含令牌的账户池（请妥善保管）' : '已导出脱敏账户池', 'tag-warn');
      return { pool, count: pool.accounts.length };
    },
    async startOAuth({ openBrowser = true, loginHint = null, accountId = null } = {}) {
      const clients = await agcred.oauthClients();
      if (!clients.length) throw new Error('未找到可用的 OAuth 客户端（无法读取 language_server.exe），请先安装 Antigravity');
      const redirectUri = oauthRedirectUri();
      const state = oauthFlows.begin({ loginHint, accountId });
      const authUrl = buildAuthUrl({ clientId: clients[0].id, redirectUri, state, loginHint });
      const activeFlow = oauthFlows.attach(state, { authUrl, redirectUri });
      if (openBrowser !== false) {
        try {
          await openUrl(authUrl);
          events.log('SYSTEM', '已打开浏览器授权页；也可直接复制下方授权链接到任意浏览器或无痕窗口完成登录', 'tag-proxy');
        } catch (error) {
          events.log('SYSTEM', `自动打开浏览器失败（${error.message}），请复制授权链接手动在浏览器打开`, 'tag-warn');
        }
      }
      events.publish({ oauthFlow: activeFlow });
      return { authUrl, state, redirectUri };
    },
    cancelOAuth() {
      oauthFlows.cancel();
      events.publish({ oauthFlow: null });
      return { ok: true };
    },
    async completeOAuth({ code, state, callbackUrl }) {
      const resolved = callbackUrl ? parseCallbackInput(callbackUrl, oauthFlows.active()?.state) : { code, state };
      const flow = oauthFlows.consume(resolved.state);
      if (!flow) throw new Error('授权会话无效或已过期，请重新点击「授权添加」');
      const captured = capturePool();
      if (flow.accountId && !accounts.find(flow.accountId)) throw new Error('重新授权账户已移除，请重新添加');
      const proxyPort = settings.get().port;
      const token = await agcred.exchangeAuthCode({ code: resolved.code, redirectUri: oauthRedirectUri(), proxyPort });
      if (!token.refreshToken) throw new Error('Google 未返回 refresh_token，无法加入账户池');
      let email = null;
      let displayName = null;
      try {
        const profile = await resolveProfile(token.accessToken, proxyPort);
        email = profile.email;
        displayName = profile.name;
      } catch { /* new accounts and legacy records without email can still use the token */ }
      assertUpsertCurrent(captured, { id: flow.accountId, email, refreshToken: token.refreshToken });
      const target = flow.accountId ? accounts.find(flow.accountId) : null;
      const expectedEmail = typeof target?.email === 'string' ? target.email.trim().toLowerCase() : '';
      if (expectedEmail) {
        const authorizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
        if (!authorizedEmail) {
          throw Object.assign(new Error('无法确认授权账户的邮箱，已取消重新授权；请稍后重试'), { status: 502 });
        }
        if (authorizedEmail !== expectedEmail) {
          throw Object.assign(new Error('授权账户与待重新授权的账户不一致，已取消覆盖；请使用原账户重新登录'), { status: 409 });
        }
      }
      const account = accounts.upsert({
        // Repair the verified target in place; legacy records without an email can still be
        // recovered when profile lookup is unavailable.
        id: flow.accountId || null,
        email, name: displayName || email || 'Google 授权账户',
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiryTs: Date.now() + token.expiresIn * 1000,
        clientType: token.clientType || 'public',
        source: 'google',
        select: true
      });
      await refreshLive(true);
      const snapshot = accounts.snapshot(live.refreshToken);
      events.log('SYSTEM', `已通过 Google 授权添加账户「${account.email || account.name}」`, 'tag-proxy');
      events.publish({ accounts: snapshot, oauthFlow: oauthFlows.active() });
      if (!testMode && agquota) void app.refreshAccountQuota(account.id).catch(() => {});
      return { account: snapshot.items.find(item => item.id === account.id) || null, accounts: snapshot };
    },
    async refreshAccountQuota(id) {
      const target = id ? accounts.find(id) : accounts.active();
      if (!target) throw new Error('请先选择要刷新配额的账户');
      if (!agquota) throw new Error('配额查询模块未启用');
      if (target.locked) throw new Error('该账户的本地令牌无法解密，请点「重新授权」重新登录');
      let captured = captureCredential(target);
      const previousQuota = target.quota;
      const proxyPort = settings.get().port;
      let fresh;
      try {
        fresh = await agcred.ensureFresh({ ...target }, proxyPort);
      } catch (error) {
        assertCredential(captured);
        accounts.markStatus(target.id, {
          status: error.permanent ? 'expired' : (target.status === 'pending' ? 'pending' : 'ok'),
          error: error.message
        });
        events.publish({ accounts: accounts.snapshot(live.refreshToken) });
        throw error;
      }
      assertCredential(captured);
      let email = target.email;
      let name = target.name;
      if (!email) {
        try {
          const profile = await resolveProfile(fresh.accessToken, proxyPort);
          email = profile.email;
          name = profile.name || email;
        } catch { /* ignore */ }
        assertCredential(captured);
      }
      accounts.updateTokens(target.id, { ...fresh, email, name });
      captured = captureCredential(accounts.find(target.id));
      let quota;
      try {
        quota = await agquota.fetchAccountQuota({
          accessToken: fresh.accessToken,
          email: email || target.name,
          proxyPort,
          preferredProjectId: previousQuota?.projectId || null,
          isGcpTos: Boolean(previousQuota?.isGcpTos)
        });
        if (quota?.error) throw new Error(quota.error);
      } catch (error) {
        assertCredential(captured);
        // Keep the last usable values while exposing that this attempt failed.
        accounts.updateQuota(target.id, { ...(previousQuota || {}), error: error.message, updatedAt: Date.now() });
        accounts.markStatus(target.id, { status: 'ok', error: error.message });
        events.publish({ accounts: accounts.snapshot(live.refreshToken) });
        throw error;
      }
      assertCredential(captured);
      if (!testMode && session.phase === 'running') {
        try {
          const liveStatus = await languageService.call('GetUserStatus', {});
          const liveEmail = liveStatus?.userStatus?.email;
          if (liveEmail && email && liveEmail.toLowerCase() === email.toLowerCase()) {
            quota = mergeLiveUserStatus(quota, liveStatus.userStatus);
          }
        } catch { /* local language_server is optional */ }
        assertCredential(captured);
      }
      accounts.updateQuota(target.id, quota);
      accounts.markStatus(target.id, { status: 'ok', error: null });
      const snapshot = accounts.snapshot(live.refreshToken);
      const tokenUsage = agusage.snapshot(true);
      events.publish({ accounts: snapshot, tokenUsage });
      return { quota, accounts: snapshot, tokenUsage };
    },
    // Refreshing every account is a long serial job (each one may spend up to ~25 s in token
    // refresh + 3 quota calls). Run it in the background and stream progress over SSE instead
    // of holding the HTTP request open until the UI timeout fires.
    startQuotaRefreshAll() {
      if (quotaTask && quotaTask.state === 'running') return { started: false, task: quotaTask };
      const targets = accounts.all()
        // Locked accounts cannot be refreshed at all; counting them as failures would just make
        // the progress bar red for something only re-authorization can fix.
        .filter(item => !item.locked)
        .map(item => ({ id: item.id, label: item.email || item.name }));
      quotaTask = {
        id: Date.now(),
        state: 'running',
        total: targets.length,
        done: 0,
        failed: 0,
        currentLabel: null,
        lastError: null,
        startedAt: Date.now(),
        finishedAt: null
      };
      events.publish({ quotaTask });
      void (async () => {
        for (const target of targets) {
          quotaTask.currentLabel = target.label;
          events.publish({ quotaTask });
          try {
            await app.refreshAccountQuota(target.id);
          } catch (error) {
            quotaTask.failed += 1;
            quotaTask.lastError = `${target.label}：${error.message}`;
          }
          quotaTask.done += 1;
          events.publish({ quotaTask, accounts: accounts.snapshot(live.refreshToken) });
        }
        quotaTask.state = 'done';
        quotaTask.currentLabel = null;
        quotaTask.finishedAt = Date.now();
        const snapshot = accounts.snapshot(live.refreshToken);
        const tokenUsage = agusage.snapshot(true);
        events.publish({ quotaTask, accounts: snapshot, tokenUsage });
        events.log('SYSTEM', `账户配额刷新完成（${quotaTask.done - quotaTask.failed}/${quotaTask.total} 成功）`, quotaTask.failed ? 'tag-warn' : 'tag-proxy');
      })();
      events.log('SYSTEM', `开始刷新 ${targets.length} 个账户的配额与令牌状态`, 'tag-proxy');
      return { started: true, task: quotaTask };
    },
    removeAccount(id) {
      const removed = accounts.snapshot().items.find(item => item.id === id);
      accounts.remove(id);
      const snapshot = accounts.snapshot(live.refreshToken);
      events.log('SYSTEM', `已删除账户「${removed?.name || id}」`, 'tag-warn');
      events.publish({ accounts: snapshot });
      return snapshot;
    },
    async reloadDictionary() {
      dictionary = loadDictionary(rootDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count });
      return { ok: true, dictEntries: count };
    },
    configureMobile(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length ||
          Object.keys(input).some(key => !['autoStart', 'mode', 'fixedUrl', 'tunnelToken', 'clearTunnelToken'].includes(key))) {
        throw Object.assign(new Error('手机远程设置格式无效'), { status: 400 });
      }
      const patch = {};
      if (input.autoStart !== undefined) patch.mobileAutoStart = input.autoStart;
      if (input.mode !== undefined) patch.mobileMode = input.mode;
      if (input.fixedUrl !== undefined) patch.mobileFixedUrl = input.fixedUrl;
      const previous = settings.get();
      const next = normalizeSettings(patch, previous);
      const credentialChange = mobileSecrets.prepare(input);
      if (credentialChange || next.mobileMode !== previous.mobileMode || next.mobileFixedUrl !== previous.mobileFixedUrl) mobile.assertConfigMutable();
      if (credentialChange) credentialChange.commit(patch);
      else { try { settings.update(patch); } catch { throw credentialError('MOBILE_CREDENTIAL_SAVE_FAILED'); } }
      const snapshot = mobile.snapshot();
      events.publish({ mobile: snapshot });
      return snapshot;
    },
    async configure(input) {
      const previous = settings.get();
      const normalized = normalizeSettings(input, previous);
      if (['mobileAutoStart', 'mobileMode', 'mobileFixedUrl'].some(key => normalized[key] !== previous[key])) mobileSecrets.assertReady();
      if (normalized.mobileMode !== previous.mobileMode || normalized.mobileFixedUrl !== previous.mobileFixedUrl) mobile.assertConfigMutable();
      assertLaunchSettingsMutable(input, previous, session.phase);
      const next = settings.update(input);
      if (next.port !== previous.port) {
        events.log('SYSTEM', `本地代理端口：${previous.port} → ${next.port}（重启 AG 后生效）`, 'tag-proxy');
      }
      if (next.enableContextMonitor !== previous.enableContextMonitor) contextMonitor.reset();
      await cdp.refresh();
      if (next.enableI18n !== previous.enableI18n) events.log('I18N', next.enableI18n ? '汉化已开启' : '汉化已关闭，原文已恢复', 'tag-i18n');
      if (next.enableContextMonitor !== previous.enableContextMonitor) events.log('SYSTEM', next.enableContextMonitor ? '上下文监控已开启（只读）' : '上下文监控已关闭，上下文圆环已移除', 'tag-proxy');
      return next;
    },
    async start() {
      const port = await api.listen(native ? 0 : 19823);
      app.apiPort = port;
      void host.resizeWindow();
      events.log('SYSTEM', `星桥工作台 桌面内核就绪，已载入 ${Object.keys(dictionary).length} 条汉化词条`, 'tag-proxy');
      if (process.env.EASYAG_READY_FILE) writeJson(process.env.EASYAG_READY_FILE, { port, pid: process.pid });
      if (!native && !testMode) host.open(`http://127.0.0.1:${port}`);
      void session.attachExisting().catch(error => events.log('SYSTEM', error.message, 'tag-warn'));
      void refreshLive(true).then(() => {
        if (!testMode && agquota && accounts.active()) {
          void app.refreshAccountQuota(accounts.active().id).catch(() => {});
        }
      }).catch(() => {});
      const liveTimer = setInterval(() => {
        const running = session.phase === 'running';
        const justStopped = live.running === true && !running;
        live.running = running;
        // Probe only while AG is up (its login can change inside AG), plus one final read
        // when it exits. Idle launchers must not keep spawning PowerShell every few seconds.
        if (!running && !justStopped) return;
        void refreshLive(true).catch(() => {});
      }, LIVE_POLL_MS);
      liveTimer.unref();
      return port;
    },
    close(reason) {
      if (closing) return closing;
      closing = (async () => {
        events.log('SYSTEM', '正在退出: ' + reason, 'tag-warn');
        await mobile.close();
        const result = await session.close(reason);
        host.dispose();
        api.close();
        onClose(result);
        return result;
      })();
      return closing;
    }
  };
  const api = createApi(app);
  app.api = api;
  return app;
}

module.exports = { createApplication };
