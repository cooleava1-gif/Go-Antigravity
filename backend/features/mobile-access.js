'use strict';

const { spawn } = require('node:child_process');
const { randomInt } = require('node:crypto');
const { existsSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { URL } = require('node:url');
const LOCAL_URL = 'http://127.0.0.1:3082/';
const TUNNEL_READY = 'http://127.0.0.1:20382/ready';
const PROJECT_DIR = path.resolve(__dirname, '../mobile');
const QUICK_URL = /^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$(?![\s\S])/;
// Supervisor allows 30s origin + 90s connector/public readiness, plus manager margin.
const STARTUP_MS = 125000;
const HEALTH_MS = 5000;
const REQUEST_MS = 1500;
const CLEANUP_MS = 5000;

// The manager owns only children it spawned. Output and child errors are never logged.
function createMobileAccess({ events, settings, secrets, testMode = false, projectDir = process.env.GOAGY_POCKET_PROJECT || PROJECT_DIR, spawnProcess, fetchImpl } = {}) {
  const spawnChild = spawnProcess || spawn;
  const request = fetchImpl || (!testMode && globalThis.fetch);
  const canSpawn = !testMode || typeof spawnProcess === 'function';
  const available = () => existsSync(path.join(projectDir, 'tunnel.mjs')) && existsSync(path.join(projectDir, 'server.mjs'));
  let state = 'stopped', lastError = null, pin = null, startedAt = null, publicUrl = null;
  let owned = null, startPromise = null, stopPromise = null, closed = false, epoch = 0, cancellation = 0;
  let externalTimer = null, externalProbe = null;

  function autoStart() {
    try { return settings?.get()?.mobileAutoStart === true; } catch { return false; }
  }
  function configuration() {
    let values;
    try { values = settings?.get() || {}; } catch { values = {}; }
    const selectedMode = values.mobileMode ?? 'quick';
    const candidate = values.mobileFixedUrl ?? process.env.GOAGY_POCKET_FIXED_URL ?? '';
    let fixedUrl = '', error = null;
    if (!['quick', 'fixed'].includes(selectedMode)) error = '手机访问模式配置无效。';
    if (candidate !== '') {
      try {
        const url = new URL(candidate);
        if (typeof candidate !== 'string' || url.protocol !== 'https:' || url.username || url.password ||
            (candidate !== url.origin && candidate !== url.origin + '/')) throw new Error('origin');
        fixedUrl = url.origin;
      } catch { error = '固定域名必须为 HTTPS 来源地址，不能包含路径或凭据。'; }
    }
    if (selectedMode === 'fixed' && !fixedUrl && !error) error = '请先配置固定 HTTPS 域名。';
    return { mode: selectedMode === 'fixed' ? 'fixed' : 'quick', fixedUrl, error };
  }
  function credentialStatus() {
    try { return secrets?.status() || { configured: false, available: false }; }
    catch { return { configured: true, available: false }; }
  }
  function snapshot() {
    const credentials = credentialStatus();
    const config = owned?.config || configuration();
    return { state, mode: config.mode, fixedUrl: config.fixedUrl, fixedConfigured: Boolean(config.fixedUrl),
      tunnelTokenConfigured: credentials.configured, fixedAuth: credentials.available ? 'token' :
        (!credentials.configured && process.env.GOAGY_POCKET_CF_CONFIG ? 'config' : null),
      publicUrl, startupPhase: owned?.phase || null,
      localUrl: LOCAL_URL, pin, autoStart: autoStart(),
      managed: Boolean(owned?.child), lastError, startedAt, available: available() };
  }
  function assertConfigMutable() {
    if (owned || startPromise || stopPromise || ['starting', 'running', 'degraded', 'stopping', 'external'].includes(state)) {
      const error = new Error('请先停止手机访问后再修改连接配置。');
      error.code = 'MOBILE_CONFIG_LOCKED'; error.status = 409;
      throw error;
    }
  }
  function publish() {
    try { events?.publish?.({ mobile: snapshot() }); } catch { /* UI listeners cannot interrupt cleanup. */ }
  }
  function transition(next, error = null) {
    const changed = state !== next || lastError !== error;
    state = next; lastError = error;
    if (next === 'external' && !closed) watchExternal(); else stopExternalWatch();
    if (changed) {
      const labels = { stopped: '已停止', starting: '启动中', running: '运行中', degraded: '连接异常', stopping: '停止中', error: '启动失败', external: '外部进程占用' };
      try { events?.log?.('mobile', '手机访问：' + labels[next]); } catch {}
      publish();
    }
  }
  const current = op => owned === op && !op.cancelled && !closed;
  function cancel(op) {
    op.cancelled = true; op.phase = null;
    op.controller.abort();
    clearTimeout(op.startupTimer); clearTimeout(op.recoveryTimer);
    clearInterval(op.healthTimer);
    op.buffer = '';
  }

  // Bound even injected transports which fail to honor AbortSignal.
  async function fetchStatus(url, parentSignal) {
    if (!request || parentSignal?.aborted) return null;
    const controller = new AbortController();
    let timer, onAbort;
    const aborted = new Promise(resolve => {
      onAbort = () => { controller.abort(); resolve(null); };
      parentSignal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(onAbort, REQUEST_MS); timer.unref?.();
    });
    const response = Promise.resolve().then(() => request(url, {
      method: 'HEAD', redirect: 'manual', cache: 'no-store', headers: { accept: 'text/html' }, signal: controller.signal,
    })).then(value => {
      // HEAD bodies are normally empty; cancel unexpected bodies without retaining them.
      try { Promise.resolve(value?.body?.cancel?.()).catch(() => {}); } catch {}
      return value && { ok: value.ok === true, status: Number(value.status) || 0 };
    }, () => null);
    try { return await Promise.race([response, aborted]); }
    finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', onAbort); }
  }
  function portOccupied(signal, port = 3082) {
    if (testMode || fetchImpl) return fetchStatus(port === 3082 ? LOCAL_URL : TUNNEL_READY, signal).then(value => value !== null);
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(false); return; }
      let socket, timer, done = false;
      const finish = value => {
        if (done) return;
        done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        socket?.destroy(); resolve(value);
      };
      const abort = () => finish(false);
      try {
        socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => finish(true));
        socket.once('error', error => finish(error?.code !== 'ECONNREFUSED'));
        timer = setTimeout(() => finish(true), REQUEST_MS); timer.unref?.();
        signal?.addEventListener('abort', abort, { once: true });
      } catch { finish(true); }
    });
  }
  function stopExternalWatch() {
    clearInterval(externalTimer); externalTimer = null;
    externalProbe?.abort(); externalProbe = null;
  }
  function watchExternal() {
    if (externalTimer) return;
    externalTimer = setInterval(() => {
      if (closed || owned || state !== 'external' || externalProbe) return;
      const ticket = epoch, controller = new AbortController(); externalProbe = controller;
      void portOccupied(controller.signal).then(occupied => {
        if (!occupied && ticket === epoch && !closed && !owned && state === 'external') transition('stopped');
      }).catch(() => {}).finally(() => { if (externalProbe === controller) externalProbe = null; });
    }, HEALTH_MS);
    externalTimer.unref?.();
  }
  async function healthy(op) {
    const [local, tunnel] = await Promise.all([
      fetchStatus(LOCAL_URL, op.controller.signal), fetchStatus(TUNNEL_READY, op.controller.signal),
    ]);
    return Boolean(local?.ok && tunnel?.ok);
  }

  function cleanup(op) {
    if (op.cleanupPromise) return op.cleanupPromise;
    op.cleanupPromise = (async () => {
      const child = op.child;
      if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return true;
      // Do not taskkill an exited PID: Windows may already have reused it.
      // A handled wrapper exit is recoverable only when both listeners and its known origin are gone.
      if (op.exited) {
        const [local, tunnel] = await Promise.all([portOccupied(), portOccupied(undefined, 20382)]);
        if (local || tunnel) return false;
        if (op.serverPid) {
          try { process.kill(op.serverPid, 0); return false; }
          catch (error) { if (error?.code !== 'ESRCH') return false; }
        }
        return true;
      }

      if (process.platform !== 'win32') {
        return new Promise(resolve => {
          let done = false, timer;
          const finish = value => { if (done) return; done = true; clearTimeout(timer); child.removeListener('exit', exited); resolve(value); };
          const exited = () => finish(true);
          child.once('exit', exited);
          try { child.kill('SIGTERM'); } catch { finish(false); return; }
          timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
            finish(op.exited);
          }, CLEANUP_MS); timer.unref?.();
        });
      }
      return new Promise(resolve => {
        let killer, timer, done = false;
        const finish = value => {
          if (done) return;
          done = true; clearTimeout(timer); resolve(value);
        };
        try {
          // Never kill by image name or by the listening port.
          killer = spawnChild('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => finish(false));
          killer.once('exit', code => finish(code === 0));
          timer = setTimeout(() => {
            try { killer.kill(); } catch {}
            finish(false);
          }, CLEANUP_MS); timer.unref?.();
        } catch { finish(false); }
      });
    })().then(ok => {
      // Keep ownership on failure so stop/close can retry instead of abandoning a tree.
      if (!ok) op.cleanupPromise = null;
      return ok;
    });
    return op.cleanupPromise;
  }
  async function fail(op, message) {
    if (owned !== op) return snapshot();
    cancel(op); pin = null; startedAt = null; publicUrl = null;
    const ok = await cleanup(op);
    if (owned !== op || stopPromise) return snapshot();
    if (ok) owned = null;
    transition('error', ok ? message : '无法停止托管的手机进程树，请重试停止。');
    return snapshot();
  }
  function monitor(op) {
    op.healthTimer = setInterval(() => {
      if (!current(op) || op.checking) return;
      op.checking = true;
      const generation = op.generation, recoveredUrl = op.recoveredUrl;
      void healthy(op).then(ok => {
        if (!current(op) || op.generation !== generation || !['running', 'degraded'].includes(state)) return;
        if (op.recovering) {
          if (ok && recoveredUrl) completeRecovery(op, recoveredUrl, generation);
          return;
        }
        transition(ok ? 'running' : 'degraded', ok ? null : '手机访问健康检查失败。');
      }).finally(() => { op.checking = false; });
    }, HEALTH_MS);
    op.healthTimer.unref?.();
  }
  function completeRecovery(op, url, generation) {
    if (!current(op) || !op.running || !op.recovering || op.generation !== generation || op.recoveredUrl !== url) return;
    clearTimeout(op.recoveryTimer);
    op.recovering = false; op.recoveredUrl = null; op.phase = null;
    op.publicUrl = url; publicUrl = url; transition('running');
  }
  async function recovered(op, url, generation) {
    op.recoveredUrl = url;
    if (await healthy(op)) completeRecovery(op, url, generation);
  }
  function readOutput(op, chunk) {
    if (!current(op) || op.runtimeError) return;
    // Only bounded JSON lines are parsed; server identity is validated then discarded.

    const text = chunk.toString();
    for (const piece of text.split(/(\n)/)) {
      if (piece !== '\n') {
        if (!op.discardLine) {
          if (op.buffer.length + piece.length > 8192) { op.buffer = ''; op.discardLine = true; }
          else op.buffer += piece;
        }
        continue;
      }
      const line = op.buffer; op.buffer = '';
      if (op.discardLine) { op.discardLine = false; continue; }
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value && Object.hasOwn(value, 'error')) {
        const messages = {
          CLOUDFLARED_NOT_FOUND: '未找到 cloudflared，请安装后重试手机访问。',
          FIXED_CONFIG_REQUIRED: '固定域名隧道未配置，请检查固定域名设置。',
          TUNNEL_START_FAILED: 'Cloudflare 隧道无法启动，请检查网络后重试。',
          TUNNEL_PUBLIC_PENDING: '隧道已连接，但公网地址尚未就绪，请检查 DNS 或网络后重试。',
          TUNNEL_RECOVERY_EXHAUSTED: '隧道自动恢复次数已用尽，请检查网络后重新开启。',
        };
        op.readySeen = true;
        op.runtimeError = typeof value.error === 'string' && Object.hasOwn(messages, value.error)
          ? messages[value.error] : '手机访问运行时启动失败。';
        op.resolveReady(op.runtimeError);
        if (op.running) void fail(op, op.runtimeError);
        return;
      }
      if (value?.mode === op.config.mode && value.local === LOCAL_URL) {
        if (['origin', 'connector', 'public'].includes(value.phase) && !op.running && !op.readySeen) {
          if (op.phase !== value.phase) { op.phase = value.phase; publish(); }
          continue;
        }
        if (value.tunnelStatus === 'recovering' && op.tunnelAccepted && op.serverReady) {
          op.generation++; op.recovering = true; op.publicUrl = null; op.recoveredUrl = null; op.phase = 'recovering'; publicUrl = null;
          clearTimeout(op.recoveryTimer);
          op.recoveryTimer = setTimeout(() => {
            if (current(op) && op.recovering) void fail(op, '隧道恢复验证超时，请检查网络后重新开启。');
          }, 95000);
          op.recoveryTimer.unref?.();
          transition('degraded', '隧道连接中断，正在自动恢复。'); continue;
        }
      }
      if (op.readySeen && !op.tunnelAccepted) continue;
      if (value?.ready === true) {
        if (op.tunnelAccepted) continue;
        if (value.local !== LOCAL_URL || value.pin !== op.pin || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
          op.readySeen = true; op.resolveReady('手机服务返回了异常的就绪信息。'); return;
        } else { op.serverReady = true; op.serverPid = value.pid; }
        continue;
      }
      if (value?.tunnelReady !== true) continue;
      if (!op.serverReady) continue; // A final line alone cannot establish server ownership.
      const validUrl = typeof value.publicUrl === 'string' && (op.config.mode === 'quick'
        ? QUICK_URL.test(value.publicUrl) : value.publicUrl === op.config.fixedUrl);
      if (op.tunnelAccepted) {
        if (!op.recovering) continue;
        if (value.mode !== op.config.mode || value.local !== LOCAL_URL || !validUrl) {
          void fail(op, '手机服务返回了异常的就绪信息。'); return;
        }
        if (op.running) void recovered(op, value.publicUrl, op.generation);
        else op.recoveredUrl = value.publicUrl;
        continue;
      }
      op.readySeen = true;
      if (value.mode !== op.config.mode || value.local !== LOCAL_URL || !validUrl) {
        op.resolveReady('手机服务返回了异常的就绪信息。'); return;
      } else { op.tunnelAccepted = true; op.publicUrl = value.publicUrl; op.resolveReady(null); }
    }
  }
  async function launch(op) {
    let timeoutMessage = null;
    const readiness = new Promise(resolve => { op.resolveReady = resolve; });
    const abortReady = () => op.resolveReady('cancelled');
    op.controller.signal.addEventListener('abort', abortReady, { once: true });
    op.startupTimer = setTimeout(() => {
      timeoutMessage = '手机访问启动超时。';
      op.controller.abort();
    }, STARTUP_MS);
    op.startupTimer.unref?.();
    try {
      try { secrets?.assertReady?.(); } catch { return await fail(op, '手机隧道凭据暂不可用，请解锁本地加密存储或重新配置。'); }
      if (op.config.error) return await fail(op, op.config.error);
      if (!available()) return await fail(op, '手机访问项目不可用。');
      if (!canSpawn) return await fail(op, '测试模式已禁用真实手机进程。');
      if (await portOccupied(op.controller.signal)) {
        if (!current(op)) return snapshot();
        cancel(op); owned = null; pin = null; startedAt = null; publicUrl = null;
        transition('external', '3082 端口已被外部进程占用。');
        return snapshot();
      }
      if (!current(op) || op.controller.signal.aborted) {
        return timeoutMessage ? await fail(op, timeoutMessage) : snapshot();
      }
      const executable = process.env.GOAGY_POCKET_NODE || process.execPath;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:TUNNEL_|CF_TUNNEL|CLOUDFLARED_|GOAGY_POCKET_TUNNEL_TOKEN)/i.test(key)));
      if (op.config.mode === 'fixed') {
        try {
          const token = secrets?.token();
          if (token) { env.TUNNEL_TOKEN = token; delete env.GOAGY_POCKET_CF_CONFIG; }
        } catch { return await fail(op, '手机隧道凭据暂不可用，请解锁本地加密存储或重新配置。'); }
      } else delete env.GOAGY_POCKET_CF_CONFIG;
      op.child = spawnChild(executable, ['tunnel.mjs'], {
        cwd: projectDir, env: { ...env, GOAGY_POCKET_PIN: op.pin,
          GOAGY_POCKET_MODE: op.config.mode, GOAGY_POCKET_FIXED_URL: op.config.fixedUrl },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!op.child || typeof op.child.once !== 'function') throw new Error('spawn');
      pin = op.pin;
      op.child.once('error', () => {
        op.processError = '手机进程无法启动。';
        op.resolveReady(op.processError); op.controller.abort();
        if (current(op) && ['running', 'degraded'].includes(state)) void fail(op, '手机进程运行失败。');
      });
      op.child.once('exit', () => {
        op.exited = true; op.processError = '手机进程在启动完成前退出。';
        op.resolveReady(op.processError); op.controller.abort();
        if (current(op) && ['running', 'degraded'].includes(state)) void fail(op, '手机进程已退出。');
      });
      op.child.stdout?.on('data', chunk => readOutput(op, chunk));
      op.child.stderr?.on('data', () => {}); // Drain, but never retain or publish child diagnostics.
      publish();
      const readyError = await readiness;
      if (op.cancelled || owned !== op) return snapshot();
      if (timeoutMessage || op.runtimeError || op.processError || readyError) return await fail(op, timeoutMessage || op.runtimeError || op.processError || readyError);
      const generation = op.generation;
      const ok = await healthy(op);
      if (op.cancelled || owned !== op) return snapshot();
      if (timeoutMessage || op.runtimeError || op.processError) return await fail(op, timeoutMessage || op.runtimeError || op.processError);
      if (op.recovering || op.generation !== generation) {
        clearTimeout(op.startupTimer); op.running = true; startedAt = Date.now(); monitor(op);
        if (op.recoveredUrl) void recovered(op, op.recoveredUrl, op.generation);
        return snapshot();
      }
      if (!ok) return await fail(op, '手机访问启动后的健康检查失败。');
      clearTimeout(op.startupTimer);
      op.running = true; op.phase = null;
      publicUrl = op.publicUrl; startedAt = Date.now(); transition('running'); monitor(op);
      return snapshot();
    } catch { return await fail(op, '手机进程无法启动。'); }
    finally {
      clearTimeout(op.startupTimer);
      op.controller.signal.removeEventListener('abort', abortReady);
      op.pin = null;
    }
  }
  function begin(pinValue, automatic) {
    if (closed) return Promise.resolve(snapshot());
    if (stopPromise) {
      const ticket = cancellation;
      return stopPromise.then(() => ticket === cancellation && !closed ? begin(pinValue, automatic) : snapshot());
    }
    if (owned && !owned.cancelled) {
      if (!automatic) owned.automatic = false;
      return startPromise || Promise.resolve(snapshot());
    }
    if (owned) return Promise.resolve(snapshot()); // A failed cleanup retains exclusive ownership.
    const op = { id: ++epoch, pin: pinValue, automatic, controller: new AbortController(), cancelled: false,
      child: null, exited: false, buffer: '', discardLine: false, readySeen: false, serverReady: false,
      config: configuration(), publicUrl: null, phase: 'origin', running: false, recovering: false, generation: 0 };
    owned = op; pin = null; startedAt = null; publicUrl = null; transition('starting');
    const promise = launch(op);
    startPromise = promise;
    void promise.finally(() => { if (startPromise === promise) startPromise = null; });
    return promise;
  }
  function start({ pin: input } = {}) {
    if (input !== undefined && (typeof input !== 'string' || input.length !== 8 || !/^\d{8}$/.test(input))) {
      return Promise.reject(new TypeError('PIN 必须为 8 位数字。'));
    }
    return begin(input === undefined ? String(randomInt(0, 100000000)).padStart(8, '0') : input, false);
  }
  function stop() {
    ++epoch; ++cancellation;
    if (stopPromise) return stopPromise;
    const op = owned;
    if (!op) {
      pin = null; startedAt = null; publicUrl = null;
      // External processes remain explicitly external; Stop never adopts or signals them.
      if (state !== 'external') transition('stopped');
      return Promise.resolve(snapshot());
    }
    cancel(op); pin = null; startedAt = null; publicUrl = null; transition('stopping');
    const pendingStart = startPromise;
    const promise = (async () => {
      const ok = await cleanup(op);
      if (pendingStart) await pendingStart;
      if (owned === op && ok) owned = null;
      transition(ok ? 'stopped' : 'error', ok ? null : '无法停止托管的手机进程树，请重试停止。');
      return snapshot();
    })();
    stopPromise = promise;
    void promise.finally(() => { if (stopPromise === promise) stopPromise = null; });
    return promise;
  }
  async function close() { closed = true; stopExternalWatch(); return await stop('close'); }
  async function onAgStart() {
    if (!autoStart() || closed) return snapshot();
    try { return await begin(String(randomInt(0, 100000000)).padStart(8, '0'), true); }
    catch { return snapshot(); }
  }
  async function onAgExit() { return owned?.automatic ? await stop('ag-exit') : snapshot(); }

  // Detect pre-existing listeners without adopting them or delaying the caller.
  if (!testMode || fetchImpl) {
    const ticket = epoch;
    void portOccupied().then(occupied => {
      if (occupied && epoch === ticket && !closed && !owned && state === 'stopped') {
        transition('external', '3082 端口已被外部进程占用。');
      }
    }).catch(() => {});
  }
  return { snapshot, start, stop, close, onAgStart, onAgExit, assertConfigMutable };
}

module.exports = { createMobileAccess };
