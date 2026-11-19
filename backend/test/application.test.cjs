'use strict';
// api.test.cjs drives every route against a hand-written stub app. That is why a method the
// routes call but createApplication never returned could ship unnoticed: the stub supplied
// proxyStatus by hand, so the routes looked healthy while the real object 500'd on the first
// poll. These tests build the real application and exercise the same routes through it, so the
// public surface and the route table cannot drift apart again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { compileFunction } = require('node:vm');
const { createApplication } = require('../desktop/application');
const { CONTEXT_MODES, CONTEXT_SIGNATURES } = require('../features/kernel-patch');

const ROOT_DIR = path.join(__dirname, '..', '..');

async function withRealApp(task, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-app-'));
  const app = await createApplication({ rootDir: ROOT_DIR, dataDir, native: false, testMode: true, ...options });
  try {
    await task(app);
  } finally {
    await app.close('测试结束');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

// Load only application.js with isolated process and clock dependencies. Its other modules
// still run in testMode, and every credential/profile call below uses synthetic data.
async function withAccountApp(task, credentialOverrides = {}, appOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-account-p1-'));
  const calls = { processes: [], waits: [], writes: [], reads: 0, launches: 0, order: [] };
  const clock = { now: 1800000000000 };
  const fresh = { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiryTs: clock.now + 3600000, clientType: 'public' };
  let credential = { accessToken: 'synthetic-system-access', refreshToken: 'synthetic-system-refresh', expiryTs: clock.now + 3600000, clientType: 'public' };
  const agCred = {
    oauthClients: async () => [{ id: 'synthetic-oauth-client' }],
    exchangeAuthCode: async () => ({ ...fresh, expiresIn: 3600 }),
    userinfoProfile: async () => ({ email: 'authorized@example.com', name: 'Authorized account' }),
    ensureFresh: async (account, port, options) => {
      if (options !== undefined) assert.deepStrictEqual(options, { publicOnly: true });
      calls.order.push('refresh');
      return { ...fresh };
    },
    readSystemCredential: async () => { calls.reads++; return { ...credential }; },
    writeSystemCredential: async value => {
      calls.order.push('write');
      calls.writes.push({ ...value });
      credential = { ...value };
    },
    ...credentialOverrides
  };
  const appPath = require.resolve('../desktop/application');
  const appRequire = createRequire(appPath);
  const isolatedModule = { exports: {} };
  const load = compileFunction(fs.readFileSync(appPath, 'utf8'), ['require', 'module', 'exports', 'Date', 'setTimeout'], { filename: appPath });
  load(name => name === 'node:child_process' ? {
    spawn(command, args) {
      calls.processes.push({ command, args: [...args] });
      calls.order.push('kill:' + args.at(-1));
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }
  } : appRequire(name), isolatedModule, isolatedModule.exports,
  class extends Date { static now() { return clock.now; } },
  (callback, delay) => { calls.waits.push(delay); clock.now += delay; queueMicrotask(callback); });
  let app;
  try {
    app = await isolatedModule.exports.createApplication({
      rootDir: ROOT_DIR, dataDir, testMode: true, agCred,
      kernelInspector: () => ({ platformSupported: true, targets: [] }), ...appOptions
    });
    app.desktop.running = async options => { if (options !== undefined) assert.deepStrictEqual(options, { strict: true }); return false; };
    const realLaunch = app.session.launch.bind(app.session);
    app.session.launch = async () => { calls.launches++; calls.order.push('launch'); return { ok: true }; };
    await task(app, { calls, clock, fresh, credential: () => credential, realLaunch });
  } finally {
    if (app) await app.close('账号隔离测试结束');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function seedAccountPair(app, clock) {
  const target = app.accounts.upsert({ email: 'a@example.com', name: 'Account A', accessToken: 'synthetic-a-access', refreshToken: 'synthetic-a-refresh', expiryTs: clock.now + 3600000, clientType: 'public' });
  const selected = app.accounts.upsert({ email: 'b@example.com', name: 'Account B', accessToken: 'synthetic-b-access', refreshToken: 'synthetic-b-refresh', expiryTs: clock.now + 3600000, clientType: 'public', select: true });
  return { target, selected };
}

function request(port, token, { method = 'GET', route = '/', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: route,
      headers: { Host: `127.0.0.1:${port}`, 'X-Goagy-Token': token, 'Content-Type': 'application/json' }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

test('createApplication 暴露 api.js 用到的每一个方法', async () => {
  await withRealApp(app => {
    // Every name here is called from a route handler in desktop/api.js. A missing one turns into
    // "app.x is not a function" in the launcher log, which says nothing about which route broke.
    for (const name of ['status', 'configure', 'close', 'kernelStatus', 'applyKernel', 'proxyStatus', 'proxyCheck']) {
      assert.equal(typeof app[name], 'function', `app.${name} 必须存在`);
    }
    const proxy = app.proxyStatus();
    assert.deepStrictEqual(Object.keys(proxy).sort(), ['enabled', 'lastResult', 'logWatch', 'port']);
    assert.equal(typeof proxy.port, 'number');
    assert.equal(proxy.enabled, true, '启动前自检默认开启');
    // The log watcher is idle until AG is up, and it must report a path even when APPDATA is absent,
    // because the UI reads this to say whether the 400 catcher is actually running.
    assert.equal(proxy.logWatch.watching, false);
  });
});

test('真实 app 忽略旧更新状态与下载词典，拒绝更新后仍使用内置资源', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starbridge-app-isolation-'));
  const rootDir = path.join(dir, 'bundle');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(rootDir, 'dicts'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'hotfix', 'dicts'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'dicts', 'ui_v2.json'), JSON.stringify({ Hello: '内置词典' }));
  const stateFile = path.join(dataDir, 'hotfix', 'update-state.json');
  const savedState = JSON.stringify({ runtimeVersion: '999.0.0', restartRequired: true, dictVersion: 'downloaded' });
  fs.writeFileSync(stateFile, savedState);
  fs.writeFileSync(path.join(dataDir, 'hotfix', 'dicts', 'ui_v2.json'), JSON.stringify({ Injected: '下载词条' }));
  let app;
  try {
    app = await createApplication({
      rootDir, dataDir, testMode: true,
      kernelInspector: () => ({ platformSupported: true, targets: [] }),
      fetchBytes: () => assert.fail('独立版本不应下载更新')
    });
    const bundled = require('../package.json');
    const status = app.status();
    assert.equal(status.name, bundled.name);
    assert.equal(status.edition, bundled.edition);
    assert.equal(status.version, bundled.version);
    assert.equal(status.bundledVersion, bundled.version);
    assert.equal(status.updatesEnabled, false);
    assert.equal(status.restartRequired, false);
    assert.equal(status.dictEntries, 1);
    assert.equal((await app.reloadDictionary()).dictEntries, 1);
    await assert.rejects(app.updater.checkAndApply({ manifestUrl: 'https://untrusted.invalid/' }), { code: 'UPDATES_DISABLED', status: 410 });
    const port = await app.api.listen(0);
    const rejected = await request(port, app.apiToken, { method: 'POST', route: '/api/update', body: '{invalid JSON' });
    assert.equal(rejected.status, 410);
    assert.equal(JSON.parse(rejected.body).code, 'UPDATES_DISABLED');
    assert.equal(app.rootDir, rootDir);
    assert.equal(app.status().dictEntries, 1);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), savedState, '旧状态保留供备份，但不能生效');
  } finally {
    if (app) await app.close('测试结束');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 app 的 /api/proxy/status 返回 200，而不是 500', async () => {
  await withRealApp(async app => {
    const port = await app.api.listen(0);
    try {
      const denied = await request(port, 'wrong-token', { route: '/api/proxy/status' });
      assert.equal(denied.status, 401);

      const ok = await request(port, app.apiToken, { route: '/api/proxy/status' });
      assert.equal(ok.status, 200);
      const body = JSON.parse(ok.body);
      assert.equal(typeof body.proxy.port, 'number');
      assert.equal(body.proxy.enabled, true);
      // lastResult is null until something actually probed; the badge must survive that.
      assert.equal(body.proxy.lastResult, null);
      // The watcher state travels with the same payload, so the UI never needs a second call.
      assert.equal(body.proxy.logWatch.watching, false);
    } finally {
      app.api.close();
    }
  });
});

test('状态推送缓存物理内核检查，设置仍实时更新且 API 可强制刷新', async () => {
  let reads = 0;
  let observed = 'initial';
  await withRealApp(async app => {
    assert.equal(app.status().kernel.targets[0].observed, 'initial');
    for (let i = 0; i < 12; i++) app.status();
    assert.equal(reads, 1, 'SSE 状态推送不应重复扫描内核');
    app.settings.update({ promptTier: '0', contextMode: '900k', autoApplyKernelPatch: false });
    const live = app.status().kernel;
    assert.equal(live.desired.promptTier, 'stock');
    assert.equal(live.desired.contextMode, '900k');
    assert.equal(live.contextCap, 0);
    assert.equal(live.desiredContextCap, CONTEXT_MODES['900k'].tokens);
    assert.equal(live.autoApplyKernelPatch, false);
    assert.equal(reads, 1);
    observed = 'external-upgrade';
    const port = await app.api.listen(0);
    const response = await request(port, app.apiToken, { route: '/api/kernel/status' });
    assert.equal(response.status, 200);
    assert.equal(app.status().kernel.targets[0].observed, observed);
    assert.equal(reads, 2, '显式 API 刷新应重读物理内核并更新缓存');
  }, { kernelInspector: () => { reads++; return { platformSupported: true, targets: [{ observed }] }; } });
});

test('直接补丁调用成功、失败及抛错后均使内核检查缓存失效', async () => {
  let reads = 0;
  let observed = 'initial';
  let outcome = 'success';
  await withRealApp(async app => {
    app.status();
    observed = 'patched';
    assert.equal((await app.applyKernel({ promptTier: '4', contextMode: '512k' })).ok, true);
    assert.equal(app.status().kernel.targets[0].observed, observed);
    assert.equal(reads, 2);
    assert.equal(app.status().kernel.lastResult.ok, true);
    outcome = 'failure';
    observed = 'partial-failure';
    assert.equal((await app.applyKernel()).ok, false);
    assert.equal(app.status().kernel.targets[0].observed, observed);
    assert.equal(reads, 3);
    assert.equal(app.status().kernel.lastResult.ok, false);
    outcome = 'throw';
    observed = 'interrupted';
    await assert.rejects(app.applyKernel(), /simulated patch interruption/);
    assert.equal(app.status().kernel.targets[0].observed, observed);
    assert.equal(reads, 4);
  }, {
    kernelInspector: () => { reads++; return { platformSupported: true, targets: [{ observed }] }; },
    kernelPatcher: async input => {
      if (outcome === 'throw') throw new Error('simulated patch interruption');
      return { ok: outcome === 'success', ...input, logs: [], errors: outcome === 'failure' ? ['simulated failure'] : [] };
    }
  });
});

test('启动前无档位漂移时也刷新已缓存的外部内核状态', async () => {
  let reads = 0;
  let observed = 'initial';
  await withRealApp(async app => {
    app.settings.update({ preflightProxy: false });
    app.status();
    observed = 'external-upgrade';
    await app.session.onBeforeLaunch();
    assert.equal(app.status().kernel.targets[0].observed, observed);
    assert.equal(reads, 2);
  }, {
    kernelInspector: () => { reads++; return { platformSupported: true, targets: [{ exists: true, promptTier: '4', contextMode: '512k', observed }] }; },
    kernelPatcher: async () => { throw new Error('无漂移时不应执行补丁'); }
  });
});

function syntheticContextClient() {
  return {
    discover: async () => ({ pid: 17, port: 19, csrf: 'synthetic-only' }),
    call: async () => ({ userStatus: { email: 'synthetic@example.invalid' } }),
    metadata: async () => [{ chatModel: { chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 200000, maxContextTokens: 256000 } } } }],
    reset() {}
  };
}

function fakeLaunch(app, { fail = false } = {}) {
  let spawned = 0;
  app.desktop.locate = () => ({ exists: true, appExe: 'synthetic-never-executed.exe' });
  app.desktop.running = async () => false;
  app.cdp.start = () => {};
  app.cdp.stop = async () => {};
  app.host.hide = () => {};
  app.contextMonitor.client = syntheticContextClient();
  app.session.spawnProcess = () => {
    spawned++;
    const child = new EventEmitter();
    child.pid = 123456789;
    child.exitCode = null;
    child.kill = () => {};
    queueMicrotask(() => child.emit(fail ? 'error' : 'spawn', ...(fail ? [new Error('synthetic spawn failure')] : [])));
    return child;
  };
  return () => spawned;
}

function inspectedDesktop(mode) {
  return { platformSupported: true, targets: [{ id: 'desktop', exists: true, promptTier: '4', contextMode: mode,
    gates: CONTEXT_SIGNATURES.map(signature => ({ id: signature.id, mode })) }] };
}

test('仅保存目标档位不改变已有实例的实际使用率', async () => {
  let patches = 0;
  await withRealApp(async app => {
    app.session.phase = 'running';
    app.contextMonitor.client = syntheticContextClient();
    const id = '11111111-1111-1111-1111-111111111111';
    const before = (await app.contextMonitor.sample(id)).context;
    await app.configure({ contextMode: '900k', autoApplyKernelPatch: false });
    const after = (await app.contextMonitor.sample(id)).context;
    assert.equal(before.maxTokens, 256000);
    assert.deepStrictEqual(after, before);
    assert.equal(after.usedFraction, 0.78125);
    assert.equal(app.kernelStatus().contextCap, 0);
    assert.equal(app.kernelStatus().desiredContextCap, CONTEXT_MODES['900k'].tokens);
    assert.equal(patches, 0);
  }, { kernelInspector: () => inspectedDesktop('stock'), kernelPatcher: async () => { patches++; throw new Error('不应应用'); } });
});

test('本次成功启动锁定已验证容量，运行中保存或应用新档位不篡改它', async () => {
  let physical = '512k';
  await withRealApp(async app => {
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    const spawned = fakeLaunch(app);
    assert.equal((await app.session.launch()).ok, true);
    assert.equal(spawned(), 1);
    const id = '22222222-2222-2222-2222-222222222222';
    assert.equal((await app.contextMonitor.sample(id)).context.maxTokens, CONTEXT_MODES['512k'].tokens);
    await app.configure({ contextMode: '900k' });
    assert.equal((await app.applyKernel()).ok, true);
    assert.equal(app.kernelStatus().targets[0].contextMode, '900k');
    assert.equal(app.kernelStatus().contextCap, CONTEXT_MODES['512k'].tokens);
    assert.equal((await app.contextMonitor.sample(id)).context.maxTokens, CONTEXT_MODES['512k'].tokens);
    await app.session.finish('synthetic exit');
    assert.equal(app.kernelStatus().contextCap, 0);
    app.session.child = null;
    app.session.onStart(); // An attached instance has no verified launch identity.
    app.session.phase = 'running';
    assert.equal((await app.contextMonitor.sample(id)).context.maxTokens, 256000);
  }, { kernelInspector: () => inspectedDesktop(physical), kernelPatcher: async input => { physical = input.contextMode; return { ok: true, logs: [], errors: [] }; } });
});

test('未知或混合门限不推断容量，启动失败也不发布有效容量', async t => {
  for (const kind of ['missing', 'mixed', 'duplicate', 'spawn-error']) await t.test(kind, async () => {
    await withRealApp(async app => {
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      fakeLaunch(app, { fail: kind === 'spawn-error' });
      assert.equal((await app.session.launch()).ok, kind !== 'spawn-error');
      assert.equal(app.kernelStatus().contextCap, 0);
      assert.equal((await app.contextMonitor.sample('33333333-3333-3333-3333-333333333333')).context.maxTokens, 256000);
    }, { kernelInspector: () => {
      const result = inspectedDesktop('900k');
      if (kind === 'missing') result.targets[0].gates = [];
      if (kind === 'mixed') result.targets[0].gates[0].mode = 'stock';
      if (kind === 'duplicate') result.targets[0].gates.push({ ...result.targets[0].gates[0], mode: 'stock' });
      return result;
    } });
  });
});

test('单个构建只含已知签名子集时仍使用已验证容量', async () => {
  await withRealApp(async app => {
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    fakeLaunch(app);
    assert.equal((await app.session.launch()).ok, true);
    assert.equal(app.kernelStatus().contextCap, CONTEXT_MODES['512k'].tokens);
  }, { kernelInspector: () => {
    const result = inspectedDesktop('512k');
    result.targets[0].gates = result.targets[0].gates.slice(0, 1);
    return result;
  } });
});

test('自动补丁完成后按重新检查的实际容量启动', async () => {
  let physical = 'stock';
  let patches = 0;
  await withRealApp(async app => {
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: true, contextMode: '900k' });
    const spawned = fakeLaunch(app);
    assert.equal((await app.session.launch()).ok, true);
    assert.equal(spawned(), 1);
    assert.equal(patches, 1);
    assert.equal(app.kernelStatus().contextCap, CONTEXT_MODES['900k'].tokens);
    assert.equal((await app.contextMonitor.sample('44444444-4444-4444-4444-444444444444')).context.maxTokens, CONTEXT_MODES['900k'].tokens);
  }, { kernelInspector: () => inspectedDesktop(physical), kernelPatcher: async input => {
    patches++; physical = input.contextMode;
    return { ok: true, logs: [], errors: [] };
  } });
});

test('automatic context recovery never migrates legacy prompt bytes or old preferences', async t => {
  for (const [tier, version, legacy] of [['1', 1, true], ['2', 1, true], ['3', 1, true], ['4', 1, true], ['4', 2, true], ['4', 1, false]]) {
    await t.test(tier + '/' + version + '/' + legacy, async () => {
      const calls = [];
      await withRealApp(async app => {
        app.settings.update({ preflightProxy: false, contextMode: '900k', promptTier: tier, promptPayloadVersion: version });
        await app.session.onBeforeLaunch();
        assert.deepStrictEqual(calls, [{ contextMode: '900k' }]);
        assert.strictEqual(app.settings.get().promptPayloadVersion, version);
      }, { kernelInspector: () => {
        const result = inspectedDesktop('stock');
        Object.assign(result.targets[0], { promptTier: legacy ? tier : 'stock', promptLegacy: legacy, promptPayloadVersion: legacy ? 1 : null });
        return result;
      }, kernelPatcher: async input => { calls.push(input); return { ok: true, logs: [], errors: [] }; } });
    });
  }
});

test('explicit prompt apply records v2 consent while a context-only apply leaves it unchanged', async () => {
  const calls = [];
  await withRealApp(async app => {
    app.settings.update({ promptTier: '4', promptPayloadVersion: 1 });
    await app.applyKernel({ contextMode: '900k' });
    assert.deepStrictEqual(calls[0], { contextMode: '900k' });
    assert.strictEqual(app.settings.get().promptTier, '4');
    assert.strictEqual(app.settings.get().promptPayloadVersion, 1);
    await app.applyKernel({ promptTier: '4' });
    assert.deepStrictEqual(calls[1], { promptTier: '4' });
    assert.strictEqual(app.settings.get().promptPayloadVersion, 2);
  }, { kernelInspector: () => inspectedDesktop('stock'), kernelPatcher: async input => {
    calls.push(input); return { ok: true, logs: [], errors: [], promptTier: input.promptTier ?? null, contextMode: input.contextMode ?? null };
  } });
});

test('real app redacts custom prompt text from status while exposing kernel metadata', async () => {
  const text = '本地自定义核心指令全文：核验后汇报';
  await withRealApp(async app => {
    app.settings.update({ promptTier: 'custom', customSystemPrompt: text });
    const status = app.status();
    assert.ok(!Object.hasOwn(status, 'customSystemPrompt'));
    assert.ok(!Object.hasOwn(status, 'customPromptUpdatedAt'));
    assert.strictEqual(JSON.stringify(status).includes(text), false);
    const kernel = app.kernelStatus();
    assert.ok(kernel.customPrompt && typeof kernel.customPrompt === 'object');
    assert.strictEqual(kernel.customPrompt.available, true);
    assert.strictEqual(kernel.customPrompt.capacity, 3960);
    assert.strictEqual(kernel.customPrompt.bytes, Buffer.byteLength(text, 'utf8'));
    assert.strictEqual(kernel.desired.promptTier, 'custom');
    assert.strictEqual(typeof kernel.desired.customHash, 'string');
    assert.strictEqual(JSON.stringify(kernel).includes(text), false);
  }, { kernelInspector: () => ({ platformSupported: true, targets: [] }) });
});

test('custom apply persists text, honors saved-text fallback, and clearCustomPrompt clears it', async () => {
  const text = '本地自定义核心指令全文：核验后汇报';
  const calls = [];
  await withRealApp(async app => {
    await app.applyKernel({ promptTier: 'custom', promptText: text });
    assert.strictEqual(app.settings.get().promptTier, 'custom');
    assert.strictEqual(app.settings.get().customSystemPrompt, text);
    assert.ok(app.settings.get().customPromptUpdatedAt > 0);
    assert.strictEqual(app.settings.get().promptPayloadVersion, 2);
    await app.applyKernel({ promptTier: 'custom' });
    assert.strictEqual(app.settings.get().customSystemPrompt, text, 'saved text survives an apply without promptText');
    await app.applyKernel({ promptTier: 'stock', clearCustomPrompt: true });
    assert.strictEqual(app.settings.get().customSystemPrompt, '');
    assert.strictEqual(app.settings.get().customPromptUpdatedAt, 0);
  }, { kernelInspector: () => inspectedDesktop('stock'), kernelPatcher: async input => {
    calls.push(input); return { ok: true, logs: [], errors: [], promptTier: input.promptTier ?? null, contextMode: input.contextMode ?? null };
  } });
});

test('empty or omitted kernel apply never supplies implicit prompt migration consent', async t => {
  for (const [label, input] of [['empty', {}], ['omitted', undefined]]) {
    await t.test(label, async () => {
      const calls = [];
      await withRealApp(async app => {
        app.settings.update({ promptTier: '4', promptPayloadVersion: 1, contextMode: 'stock' });
        await app.applyKernel(input);
        assert.deepStrictEqual(calls, [{ contextMode: 'stock' }]);
        assert.strictEqual(app.settings.get().promptTier, '4');
        assert.strictEqual(app.settings.get().promptPayloadVersion, 1);
      }, { kernelInspector: () => inspectedDesktop('stock'), kernelPatcher: async input => {
        calls.push(input); return { ok: true, logs: [], errors: [], promptTier: input.promptTier ?? null, contextMode: input.contextMode ?? null };
      } });
    });
  }
});

test('启动前自动补丁失败必须阻止 spawn 并保留宿主容量', async () => {
  await withRealApp(async app => {
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: true, contextMode: '900k' });
    const spawned = fakeLaunch(app);
    const result = await app.session.launch();
    assert.equal(result.ok, false);
    assert.match(result.error, /内核自动同步失败.*已取消启动/);
    assert.equal(spawned(), 0);
    assert.equal(app.kernelStatus().contextCap, 0);
    assert.equal(app.kernelStatus().lastResult.ok, false);
  }, { kernelInspector: () => inspectedDesktop('stock'), kernelPatcher: async () => ({ ok: false, logs: [], errors: ['synthetic patch failure'] }) });
});

test('设为启动在 spawn 前同步所选账户，而选择本身不写系统凭据', async () => {
  await withAccountApp(async (app, { calls, clock, fresh, credential, realLaunch }) => {
    const { target, selected } = seedAccountPair(app, clock);
    app.selectAccount(target.id);
    app.selectAccount(selected.id);
    assert.equal(calls.writes.length, 0);
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    const spawned = fakeLaunch(app);
    assert.equal((await realLaunch()).ok, true);
    assert.equal(spawned(), 1);
    assert.deepStrictEqual(credential(), fresh);
    assert.equal(app.accounts.active().id, selected.id);
    assert.equal(selected.refreshToken, fresh.refreshToken);
    assert.equal(target.refreshToken, 'synthetic-a-refresh');
    assert.deepStrictEqual(calls.order, ['refresh', 'write']);
    assert.equal(calls.processes.length, 0);
  });
});

test('启动账号已与系统一致时无需重复写入，空账号池也不访问凭据', async t => {
  await t.test('matching', async () => {
    const fresh = { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiryTs: 1800003600000, clientType: 'public' };
    await withAccountApp(async (app, { calls, clock, realLaunch }) => {
      seedAccountPair(app, clock);
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      fakeLaunch(app);
      assert.equal((await realLaunch()).ok, true);
      assert.deepStrictEqual(calls.writes, []);
    }, { readSystemCredential: async () => ({ ...fresh }) });
  });
  await t.test('empty', async () => {
    await withAccountApp(async (app, { calls, realLaunch }) => {
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      fakeLaunch(app);
      assert.equal((await realLaunch()).ok, true);
      assert.equal(calls.reads, 0);
      assert.deepStrictEqual(calls.order, []);
    });
  });
});

test('启动账号锁定或刷新失效时不写凭据也不 spawn', async t => {
  for (const kind of ['locked', 'expired']) await t.test(kind, async () => {
    await withAccountApp(async (app, { calls, clock, realLaunch }) => {
      const { selected } = seedAccountPair(app, clock);
      if (kind === 'locked') selected.locked = true;
      else selected.expiryTs = clock.now - 1;
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      const spawned = fakeLaunch(app);
      const result = await realLaunch();
      assert.equal(result.ok, false);
      assert.match(result.error, /重新授权/);
      assert.equal(spawned(), 0);
      assert.equal(calls.writes.length, 0);
    }, { ensureFresh: async () => { throw Object.assign(new Error('synthetic refresh failure'), { permanent: true, code: 'invalid_grant' }); } });
  });
});

test('本地客户端缺失和网络刷新失败不会误提示重新授权', async t => {
  for (const code of ['no_client', 'network_error']) await t.test(code, async () => {
    await withAccountApp(async (app, { calls, clock, realLaunch }) => {
      const { selected } = seedAccountPair(app, clock);
      selected.expiryTs = clock.now - 1;
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      const spawned = fakeLaunch(app);
      const result = await realLaunch();
      assert.equal(result.ok, false);
      assert.doesNotMatch(result.error, /重新授权/);
      assert.match(result.error, /已取消启动.*修复后重试/);
      assert.equal(spawned(), 0);
      assert.equal(calls.writes.length, 0);
    }, { ensureFresh: async () => { throw Object.assign(new Error('synthetic local or network failure'), { code, permanent: false }); } });
  });
});

test('启动凭据写入失败先恢复原凭据并保持账号池，禁止 spawn', async () => {
  const writes = [];
  await withAccountApp(async (app, { clock, realLaunch }) => {
    seedAccountPair(app, clock);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    const spawned = fakeLaunch(app);
    const result = await realLaunch();
    assert.equal(result.ok, false);
    assert.match(result.error, /写入启动账户凭据失败.*恢复原凭据/);
    assert.equal(spawned(), 0);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].refreshToken, 'synthetic-new-refresh');
    assert.equal(writes[1].refreshToken, 'synthetic-system-refresh');
  }, { writeSystemCredential: async value => { writes.push({ ...value }); if (writes.length === 1) throw new Error('synthetic write failure'); } });
});

test('启动账号池保存失败恢复令牌与系统凭据且禁止 spawn', async () => {
  await withAccountApp(async (app, { calls, clock, credential, realLaunch }) => {
    const { selected } = seedAccountPair(app, clock);
    const previousQuota = { tier: 'PRO', models: [{ key: 'claude', percentage: 71 }], error: null };
    app.accounts.updateQuota(selected.id, previousQuota);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const original = app.accounts.updateTokens;
    app.accounts.updateTokens = (...args) => { original(...args); throw new Error('synthetic persistence failure'); };
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    const spawned = fakeLaunch(app);
    const result = await realLaunch();
    assert.equal(result.ok, false);
    assert.match(result.error, /synthetic persistence failure/);
    assert.equal(spawned(), 0);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(selected.refreshToken, 'synthetic-b-refresh');
    assert.deepStrictEqual(selected.quota, previousQuota);
    assert.equal(selected.tier, 'PRO'); assert.equal(selected.status, 'ok');
    assert.equal(credential().refreshToken, 'synthetic-system-refresh');
    assert.equal(calls.writes.length, 2);
  });
});

test('启动刷新、读取或写入期间退出均禁止 spawn，已开始的凭据写入会恢复', async t => {
  for (const point of ['refresh', 'read', 'write']) await t.test(point, async () => {
    let cancel;
    const writes = [];
    const previous = { accessToken: 'synthetic-system-access', refreshToken: 'synthetic-system-refresh', expiryTs: 1800003600000, clientType: 'public' };
    await withAccountApp(async (app, { calls, clock, realLaunch }) => {
      seedAccountPair(app, clock);
      const before = fs.readFileSync(app.accounts.file, 'utf8');
      cancel = () => app.session.close('synthetic cancellation');
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      const spawned = fakeLaunch(app);
      const result = await realLaunch();
      assert.equal(result.ok, false);
      assert.match(result.error, /启动已取消/);
      assert.equal(spawned(), 0);
      assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
      assert.equal(calls.processes.length, 0);
      assert.equal(writes.length, point === 'write' ? 2 : 0);
      if (point === 'write') assert.deepStrictEqual(writes[1], previous);
    }, {
      ensureFresh: async () => {
        if (point === 'refresh') await cancel();
        return { accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh', expiryTs: 1800003600000, clientType: 'public' };
      },
      readSystemCredential: async () => { if (point === 'read') await cancel(); return { ...previous }; },
      writeSystemCredential: async value => { writes.push({ ...value }); if (point === 'write' && writes.length === 1) await cancel(); }
    });
  });
});

test('启动凭据读取失败阻止写入；启动期间拒绝改选', async () => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  await withAccountApp(async (app, { calls, clock, realLaunch }) => {
    const { target } = seedAccountPair(app, clock);
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    const spawned = fakeLaunch(app);
    const launching = realLaunch();
    await ready;
    assert.throws(() => app.selectAccount(target.id), /正在启动 AG/);
    release();
    assert.equal((await launching).ok, false);
    assert.equal(spawned(), 0);
    assert.deepStrictEqual(calls.writes, []);
  }, { readSystemCredential: async () => { entered(); await new Promise(resolve => { release = resolve; }); throw new Error('synthetic read failure'); } });
});

test('异步读取期间账号被移除时不写凭据，写入期间被移除时恢复原凭据', async t => {
  for (const point of ['read', 'write']) await t.test(point, async () => {
    let change;
    const writes = [];
    await withAccountApp(async (app, { calls, clock, realLaunch }) => {
      const { selected } = seedAccountPair(app, clock);
      change = () => app.removeAccount(selected.id);
      app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
      const spawned = fakeLaunch(app);
      const result = await realLaunch();
      assert.equal(result.ok, false);
      assert.match(result.error, /启动账户已改变/);
      assert.equal(spawned(), 0);
      assert.equal(app.accounts.find(selected.id), null);
      if (point === 'read') assert.deepStrictEqual(writes, []);
      else {
        assert.equal(writes.length, 2);
        assert.equal(writes[1].refreshToken, 'synthetic-system-refresh');
      }
      assert.equal(calls.processes.length, 0);
    }, {
      readSystemCredential: async () => {
        if (point === 'read') change();
        return { accessToken: 'synthetic-system-access', refreshToken: 'synthetic-system-refresh', expiryTs: 1800003600000 };
      },
      writeSystemCredential: async value => { writes.push({ ...value }); if (point === 'write' && writes.length === 1) change(); }
    });
  });
});

test('脱敏导出与混合批量导入均在写入前拒绝，完整导出仍可往返', async () => {
  await withRealApp(async app => {
    app.accounts.upsert({ email: 'original@example.invalid', refreshToken: 'synthetic-original-refresh-token', select: true });
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const masked = app.exportAccounts().pool;
    await assert.rejects(app.addAccount({ rawInput: JSON.stringify(masked) }), /脱敏令牌不能导入/);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    await assert.rejects(app.addAccount({ rawInput: JSON.stringify([
      { email: 'new@example.invalid', refreshToken: 'synthetic-new-import' }, ...masked.accounts
    ]) }), /脱敏令牌不能导入/);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(app.accounts.all().length, 1);
    const full = app.exportAccounts({ includeTokens: true }).pool;
    await app.addAccount({ rawInput: JSON.stringify(full) });
    assert.equal(app.accounts.all().length, 1);
    assert.equal(app.accounts.active().refreshToken, 'synthetic-original-refresh-token');
  });
});

test('重授权 A 时选择 B 必须拒绝覆盖并保持账户池和选中项', async () => {
  await withAccountApp(async (app, { calls, clock }) => {
    const { target, selected } = seedAccountPair(app, clock);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const inMemory = JSON.stringify(app.accounts.all());
    const flow = await app.startOAuth({ openBrowser: false, accountId: target.id, loginHint: target.email });
    await assert.rejects(app.completeOAuth({ code: 'synthetic-code', state: flow.state }), /授权账户.*不一致/);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(JSON.stringify(app.accounts.all()), inMemory);
    assert.equal(app.accounts.snapshot().activeId, selected.id);
    assert.equal(calls.reads, 0);
    assert.deepStrictEqual(calls.writes, []);
  }, { userinfoProfile: async () => ({ email: 'b@example.com', name: 'Wrong identity' }) });
});

test('已有邮箱的重授权必须成功获得非空 profile 邮箱', async t => {
  for (const scenario of [
    { name: 'profile 请求失败', lookup: async () => { throw new Error('synthetic profile failure'); } },
    { name: 'profile 没有邮箱', lookup: async () => ({ name: 'No email' }) },
    { name: 'profile 邮箱为空白', lookup: async () => ({ email: '   ' }) },
    { name: 'profile 邮箱类型无效', lookup: async () => ({ email: 42 }) }
  ]) {
    await t.test(scenario.name, async () => {
      await withAccountApp(async (app, { calls, clock }) => {
        const { target, selected } = seedAccountPair(app, clock);
        target.locked = true;
        const before = fs.readFileSync(app.accounts.file, 'utf8');
        const inMemory = JSON.stringify(app.accounts.all());
        const flow = await app.startOAuth({ openBrowser: false, accountId: target.id });
        await assert.rejects(app.completeOAuth({ code: 'synthetic-code', state: flow.state }), /无法确认授权账户/);
        assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
        assert.equal(JSON.stringify(app.accounts.all()), inMemory);
        assert.equal(app.accounts.snapshot().activeId, selected.id);
        assert.equal(calls.reads, 0);
        assert.deepStrictEqual(calls.writes, []);
      }, { userinfoProfile: scenario.lookup });
    });
  }
});

test('同一身份重授权按大小写和空白规范化后修复原记录', async () => {
  await withAccountApp(async (app, { calls, clock, fresh }) => {
    const { target } = seedAccountPair(app, clock);
    target.email = 'A@Example.COM';
    target.locked = true;
    const flow = await app.startOAuth({ openBrowser: false, accountId: target.id });
    const result = await app.completeOAuth({ code: 'synthetic-code', state: flow.state });
    assert.equal(result.account.id, target.id);
    assert.equal(app.accounts.all().length, 2);
    assert.equal(target.accessToken, fresh.accessToken);
    assert.equal(target.refreshToken, fresh.refreshToken);
    assert.equal(target.expiryTs, fresh.expiryTs);
    assert.equal(target.locked, false);
    assert.equal(target.name, 'Account A');
    assert.equal(target.email, 'A@Example.COM');
    assert.equal(result.accounts.activeId, target.id);
    assert.deepStrictEqual(calls.writes, []);
  }, { userinfoProfile: async () => ({ email: '  a@EXAMPLE.com  ', name: 'Updated profile name' }) });
});

test('新增授权仍可在 profile 正常或不可用时添加账户', async t => {
  for (const available of [true, false]) {
    await t.test(available ? 'profile 正常' : 'profile 不可用', async () => {
      await withAccountApp(async (app, { calls, fresh }) => {
        const flow = await app.startOAuth({ openBrowser: false });
        const result = await app.completeOAuth({ code: 'synthetic-code', state: flow.state });
        assert.equal(app.accounts.all().length, 1);
        assert.equal(app.accounts.active().refreshToken, fresh.refreshToken);
        assert.equal(result.account.email, available ? 'new@example.com' : null);
        assert.equal(result.accounts.activeId, result.account.id);
        assert.deepStrictEqual(calls.writes, []);
      }, { userinfoProfile: async () => { if (!available) throw new Error('synthetic profile failure'); return { email: 'new@example.com', name: 'New account' }; } });
    });
  }
});

test('无邮箱的旧锁定记录在 profile 不可用时仍可重新授权修复', async () => {
  await withAccountApp(async (app, { fresh }) => {
    const target = app.accounts.upsert({ name: 'Legacy account', refreshToken: 'synthetic-legacy-refresh' });
    target.locked = true;
    const flow = await app.startOAuth({ openBrowser: false, accountId: target.id });
    const result = await app.completeOAuth({ code: 'synthetic-code', state: flow.state });
    assert.equal(app.accounts.all().length, 1);
    assert.equal(result.account.id, target.id);
    assert.equal(target.refreshToken, fresh.refreshToken);
    assert.equal(target.email, null);
    assert.equal(target.locked, false);
  }, { userinfoProfile: async () => { throw new Error('synthetic profile failure'); } });
});

test('原凭据读取拒绝在关闭会话或写入前取消且保留状态、代际并释放互斥', async t => {
  for (const phase of ['idle', 'running']) await t.test(phase, async () => {
    let rejectRead = true, reads = 0;
    const leaked = 'synthetic-read-error-refresh-secret';
    await withAccountApp(async (app, { calls, clock, fresh, credential }) => {
      const { target, selected } = seedAccountPair(app, clock);
      const before = fs.readFileSync(app.accounts.file, 'utf8');
      const memory = JSON.stringify(app.accounts.all());
      const revision = app.accounts.credentialRevision(target.id);
      const originalCredential = { ...credential() };
      const events = [];
      app.events.on('message', event => events.push(event));
      let finished = 0, runningProbes = 0;
      app.session.phase = phase;
      app.session.finish = async () => { finished++; };
      app.desktop.running = async () => { runningProbes++; return true; };
      await assert.rejects(app.switchAccount(target.id), error => {
        assert.equal(error.code, 'credential_read_failed');
        assert.equal(error.status, 503);
        assert.match(error.message, /无法读取.*原登录凭据.*取消账户切换/);
        assert.doesNotMatch(error.message, /已回滚|synthetic-read-error/);
        assert.equal(error.cause, undefined, '不能透传可能含令牌的底层异常');
        return true;
      });
      assert.equal(reads, 1);
      assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
      assert.equal(JSON.stringify(app.accounts.all()), memory);
      assert.equal(app.accounts.find(target.id), target, '保留已被异步操作持有的账户对象');
      assert.equal(app.accounts.credentialRevision(target.id), revision);
      assert.equal(app.accounts.snapshot().activeId, selected.id);
      assert.equal(app.session.phase, phase);
      assert.equal(app.session.closed, false);
      assert.equal(finished, 0);
      assert.equal(runningProbes, 0);
      assert.deepStrictEqual(calls.writes, []);
      assert.deepStrictEqual(calls.processes, []);
      assert.equal(calls.launches, 0);
      assert.deepStrictEqual(credential(), originalCredential);
      const observable = JSON.stringify(events) + JSON.stringify(app.events.logs())
        + (fs.existsSync(app.events.file) ? fs.readFileSync(app.events.file, 'utf8') : '');
      assert.ok(!observable.includes(leaked));
      assert.doesNotMatch(observable, /已回滚/);
      rejectRead = false;
      app.session.phase = 'idle';
      app.desktop.running = async () => false;
      assert.equal((await app.switchAccount(target.id)).accounts.activeId, target.id);
      assert.deepStrictEqual(calls.writes, [fresh], '读取异常后应释放切号互斥');
    }, { readSystemCredential: async () => {
      reads++;
      if (rejectRead) throw new Error(`synthetic unreadable refresh_token=${leaked}`);
      return { accessToken: 'synthetic-system-access', refreshToken: 'synthetic-system-refresh' };
    } });
  });
});

test('原系统凭据真实为空仍允许首次切号并持久化目标账户', async () => {
  let reads = 0;
  await withAccountApp(async (app, { calls, clock, fresh, credential }) => {
    const { target } = seedAccountPair(app, clock);
    const result = await app.switchAccount(target.id);
    assert.equal(reads, 2, '切号前读取和成功后的实时身份读取均接受 null');
    assert.equal(result.accounts.activeId, target.id);
    assert.equal(result.restarted, false);
    assert.deepStrictEqual(calls.writes, [fresh]);
    assert.deepStrictEqual(credential(), fresh);
    assert.equal(target.refreshToken, fresh.refreshToken);
    assert.equal(JSON.parse(fs.readFileSync(app.accounts.file, 'utf8')).activeId, target.id);
    assert.deepStrictEqual(calls.processes, []);
  }, { readSystemCredential: async () => { reads++; return null; } });
});

test('AG 运行中或严格查询未知时在任何会话清理与凭据写入前取消', async t => {
  for (const phase of ['idle', 'running']) for (const state of ['running', 'reject', 'undefined', 'null']) {
    await t.test(`${phase}/${state}`, async () => {
      await withAccountApp(async (app, { calls, clock, credential }) => {
        const { target, selected } = seedAccountPair(app, clock);
        const before = fs.readFileSync(app.accounts.file, 'utf8');
        const inMemory = JSON.stringify(app.accounts.all());
        const revision = app.accounts.credentialRevision(target.id);
        const originalCredential = { ...credential() };
        const child = { pid: 12345, kill: () => assert.fail('不能仅凭旧 child PID 终止进程') };
        let finished = 0, probes = 0, cdpStopped = 0;
        app.session.phase = phase;
        app.session.child = child;
        const generation = app.session.generation;
        const finish = app.session.finish.bind(app.session);
        app.session.finish = async (...args) => { finished++; return finish(...args); };
        const stop = app.cdp.stop.bind(app.cdp);
        app.cdp.stop = async (...args) => { cdpStopped++; return stop(...args); };
        app.desktop.running = async options => {
          assert.deepStrictEqual(options, { strict: true });
          probes++;
          if (state === 'reject') throw new Error('synthetic private process-query detail');
          return state === 'running' ? true : state === 'null' ? null : undefined;
        };
        await assert.rejects(app.switchAccount(target.id), error => {
          assert.equal(error.status, 409);
          assert.equal(error.code, state === 'running' ? 'ag_running' : 'ag_state_unknown');
          assert.match(error.message, /取消账户切换.*请先手动退出 AG/);
          assert.doesNotMatch(error.message, /synthetic private|已回滚/);
          return true;
        });
        assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
        assert.equal(JSON.stringify(app.accounts.all()), inMemory);
        assert.equal(app.accounts.credentialRevision(target.id), revision);
        assert.equal(app.accounts.snapshot().activeId, selected.id);
        assert.equal(target.lastSwitchedAt || null, null);
        assert.equal(app.session.phase, phase);
        assert.equal(app.session.child, child);
        assert.equal(app.session.generation, generation);
        assert.equal(finished, 0);
        assert.equal(cdpStopped, 0);
        assert.equal(probes, 1);
        assert.deepStrictEqual(calls.writes, []);
        assert.deepStrictEqual(calls.processes, []);
        assert.deepStrictEqual(calls.waits, []);
        assert.equal(calls.launches, 0);
        assert.equal(calls.reads, 1);
        assert.deepStrictEqual(credential(), originalCredential);
        app.desktop.running = async options => { assert.deepStrictEqual(options, { strict: true }); return false; };
        app.session.phase = 'idle';
        app.session.child = null;
        assert.equal((await app.switchAccount(target.id)).accounts.activeId, target.id, '取消后应释放互斥以便手动退出后重试');
      });
    });
  }
});

test('严格确认已退出后清理过时会话并切号，不自动重启且不调用终止命令', async () => {
  await withAccountApp(async (app, { calls, clock, fresh, credential }) => {
    const { target } = seedAccountPair(app, clock);
    app.session.phase = 'running';
    app.session.child = { pid: 12345, kill: () => assert.fail('已退出进程不应被终止') };
    let probes = 0, finished = 0;
    app.desktop.running = async options => {
      assert.deepStrictEqual(options, { strict: true });
      calls.order.push('running'); probes++; return false;
    };
    const finish = app.session.finish.bind(app.session);
    app.session.finish = async (...args) => { calls.order.push('finish'); finished++; return finish(...args); };
    const result = await app.switchAccount(target.id);
    assert.equal(probes, 1);
    assert.equal(finished, 1);
    assert.equal(app.session.phase, 'idle');
    assert.equal(app.session.child, null);
    assert.deepStrictEqual(calls.waits, []);
    assert.deepStrictEqual(calls.processes, []);
    assert.equal(result.accounts.activeId, target.id);
    assert.equal(target.refreshToken, fresh.refreshToken);
    assert.equal(target.accessToken, fresh.accessToken);
    assert.ok(target.lastSwitchedAt > 0);
    const persisted = JSON.parse(fs.readFileSync(app.accounts.file, 'utf8'));
    assert.equal(persisted.accounts.find(item => item.id === target.id).lastSwitchedAt, target.lastSwitchedAt);
    assert.deepStrictEqual(calls.writes, [fresh]);
    assert.deepStrictEqual(credential(), fresh);
    assert.equal(result.restarted, false);
    assert.equal(calls.launches, 0);
    assert.deepStrictEqual(calls.order, ['refresh', 'running', 'finish', 'write']);
  });
});

test('预刷新失败但缓存令牌仍有效时保留原有安全降级路径', async () => {
  await withAccountApp(async (app, { calls, clock }) => {
    const { target } = seedAccountPair(app, clock);
    const cached = { accessToken: target.accessToken, refreshToken: target.refreshToken, expiryTs: target.expiryTs, clientType: target.clientType };
    const result = await app.switchAccount(target.id);
    assert.equal(result.accounts.activeId, target.id);
    assert.deepStrictEqual(calls.writes, [cached]);
    assert.deepStrictEqual(calls.processes, []);
    assert.equal(result.restarted, false);
  }, { ensureFresh: async () => { throw new Error('synthetic transient refresh failure'); } });
});

test('凭据写入失败仍回滚原令牌、选中项和系统凭据且不重新启动', async () => {
  const writes = [];
  await withAccountApp(async (app, { calls, clock }) => {
    const { target, selected } = seedAccountPair(app, clock);
    const previousQuota = { tier: 'PRO', models: [{ key: 'claude', percentage: 71 }], error: null };
    app.accounts.updateQuota(target.id, previousQuota);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const original = { accessToken: target.accessToken, refreshToken: target.refreshToken, expiryTs: target.expiryTs, clientType: target.clientType };
    await assert.rejects(app.switchAccount(target.id), /写入 AG 系统凭据失败.*已回滚/);
    for (const [key, value] of Object.entries(original)) assert.equal(target[key], value);
    assert.deepStrictEqual(target.quota, previousQuota);
    assert.equal(target.tier, 'PRO'); assert.equal(target.status, 'ok');
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(app.accounts.snapshot().activeId, selected.id);
    assert.equal(writes.length, 2);
    assert.equal(writes[0].refreshToken, 'synthetic-new-refresh');
    assert.equal(writes[1].refreshToken, 'synthetic-system-refresh');
    assert.equal(calls.launches, 0);
  }, { writeSystemCredential: async value => { writes.push({ ...value }); if (writes.length === 1) throw new Error('synthetic credential write failure'); } });
});

test('切号池保存失败保留旧配额与档位且恢复原系统凭据并释放互斥', async () => {
  await withAccountApp(async (app, { calls, clock, fresh, credential }) => {
    const { target, selected } = seedAccountPair(app, clock);
    const previousQuota = { tier: 'PRO', models: [{ key: 'claude', percentage: 71 }], error: null };
    app.accounts.updateQuota(target.id, previousQuota);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const originalCredential = { ...credential() };
    const original = app.accounts.updateTokens;
    app.accounts.updateTokens = (...args) => { original(...args); throw new Error('synthetic switch persistence failure'); };
    await assert.rejects(app.switchAccount(target.id), /AG 新登录凭据已写入.*账户池保存失败.*已回滚到原账户/);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.deepStrictEqual(target.quota, previousQuota);
    assert.equal(target.tier, 'PRO'); assert.equal(target.status, 'ok');
    assert.equal(app.accounts.active().id, selected.id);
    assert.deepStrictEqual(calls.writes, [fresh, originalCredential]);
    assert.deepStrictEqual(credential(), originalCredential);
    assert.equal(calls.launches, 0);
    app.accounts.updateTokens = original;
    await app.switchAccount(target.id);
    assert.equal(app.accounts.active().id, target.id);
  });
});

test('读取原凭据成功后合成账户池 rename EACCES 恢复原系统凭据并保留旧池', async () => {
  await withAccountApp(async (app, { calls, clock, fresh, credential }) => {
    const { target, selected } = seedAccountPair(app, clock);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const memory = JSON.stringify(app.accounts.all());
    const revision = app.accounts.credentialRevision(target.id);
    const originalCredential = { ...credential() };
    const rename = fs.renameSync;
    let denied = 0;
    fs.renameSync = (from, to) => {
      if (to === app.accounts.file) {
        denied++;
        throw Object.assign(new Error('synthetic pool rename denied'), { code: 'EACCES' });
      }
      return rename(from, to);
    };
    try {
      await assert.rejects(app.switchAccount(target.id), /AG 新登录凭据已写入.*账户池保存失败.*已回滚到原账户/);
    } finally { fs.renameSync = rename; }
    assert.ok(denied > 0);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(JSON.stringify(app.accounts.all()), memory);
    assert.equal(app.accounts.find(target.id), target);
    assert.equal(app.accounts.credentialRevision(target.id), revision);
    assert.equal(app.accounts.snapshot().activeId, selected.id);
    assert.deepStrictEqual(calls.writes, [fresh, originalCredential]);
    assert.deepStrictEqual(credential(), originalCredential);
    assert.equal(calls.launches, 0);
    assert.deepStrictEqual(calls.processes, []);
    assert.equal((await app.switchAccount(target.id)).accounts.activeId, target.id);
  });
});

for (const mode of ['missing', 'restore-failed']) test(mode === 'missing'
  ? '原凭据为空且账户池保存失败时说明新凭据已写入且无法恢复，不误报回滚成功'
  : '恢复原系统凭据写入失败时明确未能恢复且不泄露底层错误', async () => {
  const poolSecret = 'synthetic-pool-error-refresh-secret';
  const restoreSecret = 'synthetic-restore-error-refresh-secret';
  let systemCredential = mode === 'missing' ? null
    : { accessToken: 'synthetic-prior-access', refreshToken: 'synthetic-prior-refresh' };
  const previousCredential = systemCredential && { ...systemCredential };
  const writes = [];
  await withAccountApp(async (app, { calls, clock, fresh }) => {
    const { target, selected } = seedAccountPair(app, clock);
    const before = fs.readFileSync(app.accounts.file, 'utf8');
    const memory = JSON.stringify(app.accounts.all());
    const revision = app.accounts.credentialRevision(target.id);
    const events = [];
    app.events.on('message', event => events.push(event));
    const rename = fs.renameSync;
    let denied = 0;
    fs.renameSync = (from, to) => {
      if (to === app.accounts.file) {
        denied++;
        throw Object.assign(new Error(`synthetic pool rename denied refresh_token=${poolSecret}`), { code: 'EACCES' });
      }
      return rename(from, to);
    };
    try {
      await assert.rejects(app.switchAccount(target.id), error => {
        assert.match(error.message, /AG 新登录凭据已写入.*账户池保存失败/);
        assert.match(error.message, mode === 'missing' ? /原先无可恢复的登录凭据/ : /原登录凭据未能恢复/);
        assert.match(error.message, /请在 AG 内重新登录并确认当前账户/);
        assert.doesNotMatch(error.message, /已回滚|synthetic-|refresh_token/);
        assert.equal(error.cause, undefined);
        return true;
      });
    } finally { fs.renameSync = rename; }
    assert.ok(denied > 0);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), before);
    assert.equal(JSON.stringify(app.accounts.all()), memory);
    assert.equal(app.accounts.find(target.id), target);
    assert.equal(app.accounts.credentialRevision(target.id), revision);
    assert.equal(app.accounts.snapshot().activeId, selected.id);
    assert.deepStrictEqual(writes, mode === 'missing' ? [fresh] : [fresh, previousCredential]);
    assert.deepStrictEqual(systemCredential, fresh, '原凭据无法恢复时系统仍持有新凭据');
    assert.equal(calls.launches, 0);
    assert.deepStrictEqual(calls.processes, []);
    const observable = JSON.stringify(events) + JSON.stringify(app.events.logs())
      + (fs.existsSync(app.events.file) ? fs.readFileSync(app.events.file, 'utf8') : '');
    for (const secret of [poolSecret, restoreSecret]) assert.ok(!observable.includes(secret));
    assert.doesNotMatch(observable, /已回滚到原账户|恢复原登录凭据/);
    assert.equal((await app.switchAccount(target.id)).accounts.activeId, target.id, '失败后应释放切号互斥');
  }, {
    readSystemCredential: async () => systemCredential && { ...systemCredential },
    writeSystemCredential: async value => {
      writes.push({ ...value });
      if (mode === 'restore-failed' && writes.length === 2) {
        throw new Error(`synthetic restore write denied refresh_token=${restoreSecret}`);
      }
      systemCredential = { ...value };
    }
  });
});

function controlledPromise() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function authorizeAccount(app, target) {
  const flow = await app.startOAuth({ openBrowser: false, accountId: target.id });
  return app.completeOAuth({ code: 'synthetic-new-authorization', state: flow.state });
}

test('过时配额请求在刷新或查询晚返回时不能污染较晚授权、导入或移除', async t => {
  for (const point of ['refresh', 'quota']) for (const failed of [false, true]) {
    for (const replacement of ['oauth', 'same-refresh-access', 'same-tokens', 'import', 'remove']) {
      await t.test([point, failed ? 'failure' : 'success', replacement].join('/'), async () => {
        const entered = controlledPromise(), paused = controlledPromise();
        let quotaCalls = 0;
        await withAccountApp(async (app, { clock, fresh }) => {
          const { target } = seedAccountPair(app, clock);
          const work = app.refreshAccountQuota(target.id).then(value => ({ value }), error => ({ error }));
          await entered.promise;
          if (replacement === 'oauth') await authorizeAccount(app, target);
          else if (replacement === 'same-refresh-access') app.accounts.upsert({
            id: target.id, email: target.email, refreshToken: target.refreshToken,
            accessToken: 'synthetic-later-access', expiryTs: clock.now + 7200000, clientType: 'public'
          });
          else if (replacement === 'same-tokens') app.accounts.upsert({ ...target });
          else if (replacement === 'import') await app.addAccount({ email: target.email, refreshToken: 'synthetic-imported-refresh-token' });
          else app.removeAccount(target.id);
          const after = fs.readFileSync(app.accounts.file, 'utf8'), memory = JSON.stringify(app.accounts.all());
          if (failed) paused.reject(Object.assign(new Error('synthetic stale invalid_grant'), { permanent: true }));
          else paused.resolve(point === 'refresh' ? { ...fresh, refreshToken: 'synthetic-stale-refresh' } : { tier: 'FREE', models: [], windows: [], error: null });
          const result = await work;
          assert.equal(result.error?.code, 'account_changed');
          assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), after);
          assert.equal(JSON.stringify(app.accounts.all()), memory);
          assert.equal(quotaCalls, point === 'quota' ? 1 : 0);
        }, {
          ensureFresh: async account => {
            if (point === 'refresh') { entered.resolve(); return paused.promise; }
            return { accessToken: account.accessToken, refreshToken: account.refreshToken, expiryTs: account.expiryTs, clientType: account.clientType };
          },
          userinfoProfile: async () => ({ email: 'a@example.com', name: 'Authorized A' })
        }, { agQuota: { fetchAccountQuota: async () => { quotaCalls++; entered.resolve(); return paused.promise; } } });
      });
    }
  }
});

test('并发切号拒绝第二请求且启动准备共享互斥，完成后可再次切号', async () => {
  const entered = controlledPromise(), paused = controlledPromise();
  let refreshCalls = 0;
  await withAccountApp(async (app, { calls, clock, realLaunch, credential }) => {
    const { target, selected } = seedAccountPair(app, clock);
    const first = app.switchAccount(target.id);
    await entered.promise;
    await assert.rejects(app.switchAccount(selected.id), error => error.status === 409);
    assert.throws(() => app.selectAccount(selected.id), error => error.status === 409);
    const launch = await realLaunch();
    assert.equal(launch.ok, false);
    assert.match(launch.error, /正在切换账户/);
    paused.resolve();
    assert.equal((await first).accounts.activeId, target.id);
    assert.equal(credential().refreshToken, target.refreshToken);
    assert.equal(refreshCalls, 1);
    assert.equal((await app.switchAccount(selected.id)).accounts.activeId, selected.id);
    assert.equal(credential().refreshToken, selected.refreshToken);
    assert.equal(calls.processes.length, 0);
  }, { ensureFresh: async account => { refreshCalls++; if (refreshCalls === 1) { entered.resolve(); await paused.promise; } return { ...account }; } });
});

test('切号异常后释放互斥且重授权不会被成功、失败或回滚覆盖', async t => {
  for (const point of ['refresh-success', 'refresh-failure', 'read', 'write-success', 'write-failure']) await t.test(point, async () => {
    const entered = controlledPromise(), paused = controlledPromise(), writes = [];
    let first = true;
    await withAccountApp(async (app, { clock, fresh }) => {
      const { target, selected } = seedAccountPair(app, clock);
      const work = app.switchAccount(target.id).then(value => ({ value }), error => ({ error }));
      await entered.promise;
      await authorizeAccount(app, target);
      const after = fs.readFileSync(app.accounts.file, 'utf8');
      paused.resolve();
      assert.ok((await work).error);
      assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), after);
      assert.equal(app.accounts.find(target.id).refreshToken, fresh.refreshToken);
      assert.equal(app.accounts.find(target.id).lastError, null);
      if (point.startsWith('write')) { assert.equal(writes.length, 2); assert.equal(writes[1].refreshToken, 'synthetic-system-refresh'); }
      else assert.equal(writes.length, 0);
      await app.switchAccount(selected.id);
      assert.equal(app.accounts.snapshot().activeId, selected.id);
    }, {
      ensureFresh: async account => {
        if (point.startsWith('refresh') && first) { first = false; entered.resolve(); await paused.promise; if (point.endsWith('failure')) throw Object.assign(new Error('synthetic stale refresh'), { permanent: true }); }
        return { accessToken: 'synthetic-old-result', refreshToken: account.refreshToken, expiryTs: account.expiryTs, clientType: 'public' };
      },
      readSystemCredential: async () => { if (point === 'read' && first) { first = false; entered.resolve(); await paused.promise; } return { accessToken: 'synthetic-system-access', refreshToken: 'synthetic-system-refresh', expiryTs: 1800003600000 }; },
      writeSystemCredential: async value => { writes.push({ ...value }); if (point.startsWith('write') && first) { first = false; entered.resolve(); await paused.promise; if (point.endsWith('failure')) throw new Error('synthetic late write failure'); } },
      userinfoProfile: async () => ({ email: 'a@example.com', name: 'Authorized A' })
    });
  });
});

test('启动刷新期间重授权保留新令牌并禁止启动或切号', async () => {
  const entered = controlledPromise(), paused = controlledPromise();
  await withAccountApp(async (app, { clock, fresh, realLaunch }) => {
    const { selected, target } = seedAccountPair(app, clock);
    app.settings.update({ preflightProxy: false, autoApplyKernelPatch: false });
    const spawned = fakeLaunch(app), work = realLaunch();
    await entered.promise;
    await assert.rejects(app.switchAccount(target.id), error => error.status === 409);
    await authorizeAccount(app, selected);
    const after = fs.readFileSync(app.accounts.file, 'utf8');
    paused.resolve();
    const result = await work;
    assert.equal(result.ok, false);
    assert.match(result.error, /启动账户已改变/);
    assert.equal(spawned(), 0);
    assert.equal(fs.readFileSync(app.accounts.file, 'utf8'), after);
    assert.equal(app.accounts.find(selected.id).refreshToken, fresh.refreshToken);
  }, { ensureFresh: async account => { entered.resolve(); await paused.promise; return { ...account }; }, userinfoProfile: async () => ({ email: 'b@example.com', name: 'Authorized B' }) });
});

test('四路配额全部失败保留旧 PRO 值、显示错误且批量统计失败', async () => {
  const { createAgQuota } = require('../core/agquota');
  const agQuota = createAgQuota({ http: async () => { throw new Error('synthetic offline'); } });
  await withAccountApp(async (app, { clock }) => {
    const account = app.accounts.upsert({ email: 'a@example.com', refreshToken: 'synthetic-pro-refresh', accessToken: 'synthetic-pro-access', expiryTs: clock.now + 3600000 });
    const old = { tier: 'PRO', tierName: 'Google AI Pro', projectId: 'synthetic-project', models: [{ key: 'claude', percentage: 71 }], windows: [{ key: '3p-weekly', percentage: 32 }], credits: [{ amount: 100 }], error: null, updatedAt: 1 };
    app.accounts.updateQuota(account.id, old);
    await assert.rejects(app.refreshAccountQuota(account.id), /所有配额接口均查询失败/);
    const failed = app.accounts.find(account.id);
    for (const key of ['tier', 'tierName', 'models', 'windows', 'credits', 'projectId']) assert.deepStrictEqual(failed.quota[key], old[key]);
    assert.match(failed.quota.error, /所有配额接口/);
    assert.match(failed.lastError, /所有配额接口/);
    const { task } = app.startQuotaRefreshAll();
    for (let turn = 0; task.state !== 'done' && turn < 100; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(task.state, 'done'); assert.equal(task.done, 1); assert.equal(task.failed, 1);
    assert.match(task.lastError, /所有配额接口/);
    assert.equal(failed.quota.tier, 'PRO');
  }, { ensureFresh: async account => ({ ...account, refreshToken: 'synthetic-rotated-refresh' }) }, { agQuota });
});

test('同邮箱导入的新 refresh 不得使用旧缓存令牌宣称校验成功', async () => {
  let refreshToken;
  await withAccountApp(async (app, { clock }) => {
    const { target } = seedAccountPair(app, clock);
    app.accounts.updateQuota(target.id, { tier: 'PRO', models: [{ key: 'claude', percentage: 80 }] });
    await app.addAccount({ email: target.email, refreshToken: 'synthetic-invalid-import' });
    assert.equal(target.accessToken, ''); assert.equal(target.expiryTs, 0); assert.equal(target.status, 'pending');
    await assert.rejects(app.refreshAccountQuota(target.id), /synthetic invalid_grant/);
    assert.equal(refreshToken, 'synthetic-invalid-import'); assert.equal(target.status, 'expired'); assert.equal(target.quota, null);
  }, { ensureFresh: async account => { refreshToken = account.refreshToken; throw Object.assign(new Error('synthetic invalid_grant'), { permanent: true }); } }, { agQuota: { fetchAccountQuota: async () => { throw new Error('must not query'); } } });
});
