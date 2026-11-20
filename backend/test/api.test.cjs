const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { createApi } = require('../desktop/api');

const TOKEN = 'test-boot-token';

function stubApp(extra = {}) {
  const logged = [];
  return {
    logged,
    apiToken: TOKEN,
    rootDir: path.join(__dirname, '..'),
    events: {
      log: (category, message, cls) => logged.push({ category, message, cls }),
      on() {},
      off() {},
      publish() {}
    },
    ...extra
  };
}

function assertCallbackCsp(response, autoClose = false) {
  const csp = response.headers['content-security-policy'];
  assert.equal(typeof csp, 'string', '所有回调结果必须携带 CSP');
  const match = /(?:^|;\s*)script-src 'nonce-([A-Za-z0-9+/]+={0,2})'(?:;|$)/.exec(csp);
  assert.ok(match, '脚本只能通过本次响应的 nonce 授权');
  const nonce = match[1];
  assert.ok(Buffer.from(nonce, 'base64').length >= 16);
  assert.match(csp, /(?:^|;\s*)default-src 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)base-uri 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)form-action 'none'(?:;|$)/);
  assert.match(csp, /(?:^|;\s*)frame-ancestors 'none'(?:;|$)/);
  assert.ok(csp.includes("style-src 'nonce-" + nonce + "'"));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.ok(response.body.includes('<style nonce="' + nonce + '">'));
  const scripts = [...response.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  assert.equal(scripts.length, autoClose ? 1 : 0);
  if (autoClose) {
    assert.equal(scripts[0][1], ' nonce="' + nonce + '"');
    assert.equal(scripts[0][2], 'setTimeout(function(){try{window.close();}catch(e){}},2000);');
  }
  return nonce;
}

function request(port, { method = 'GET', route = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function withServer(app, task) {
  const api = createApi(app);
  const port = await api.listen(0);
  try {
    await task(port);
  } finally {
    api.close();
  }
}

test('拒绝非回环 Host 头的请求', async () => {
  await withServer(stubApp(), async port => {
    const response = await request(port, { route: '/api/ping', headers: { Host: 'evil.example.com' } });
    assert.equal(response.status, 403);
    assert.match(response.body, /无效的本地请求/);
  });
});

test('回环 Host 头可以访问只读接口', async () => {
  await withServer(stubApp(), async port => {
    const response = await request(port, { route: '/api/ping', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'pong');
  });
});

test('跨站 Origin 无法修改设置', async () => {
  const app = stubApp({ configure: async () => { throw new Error('不应被调用'); } });
  await withServer(app, async port => {
    const response = await request(port, {
      method: 'POST',
      route: '/api/config',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' }
    });
    assert.equal(response.status, 403);
    assert.match(response.body, /跨站/);
  });
});

test('静态资源不允许目录穿越', async () => {
  await withServer(stubApp(), async port => {
    const response = await request(port, {
      route: '/assets/..%2f..%2fserver.js',
      headers: { Host: `127.0.0.1:${port}` }
    });
    assert.ok([403, 404].includes(response.status), `unexpected status ${response.status}`);
  });
});

test('未知路由返回 404 JSON', async () => {
  await withServer(stubApp(), async port => {
    const response = await request(port, { route: '/api/nope', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(response.status, 404);
    assert.equal(JSON.parse(response.body).ok, false);
  });
});

// ---------- 会话令牌 ----------

test('缺少会话令牌的 /api/* 请求一律 401', async () => {
  const app = stubApp({ status: () => ({ ok: true }) });
  await withServer(app, async port => {
    for (const route of ['/api/status', '/api/logs', '/api/accounts', '/api/accounts/export']) {
      const response = await request(port, { route, headers: { Host: `127.0.0.1:${port}` } });
      assert.equal(response.status, 401, route);
      assert.match(response.body, /本地会话已失效/);
    }
  });
});

test('令牌不对（上一次运行遗留）同样拒绝', async () => {
  const app = stubApp({ status: () => ({ ok: true }) });
  await withServer(app, async port => {
    const response = await request(port, {
      route: '/api/status',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': 'stale-token-from-yesterday' }
    });
    assert.equal(response.status, 401);
  });
});

test('带上正确令牌即可正常访问', async () => {
  const app = stubApp({ status: () => ({ ok: true, phase: 'idle' }) });
  await withServer(app, async port => {
    const response = await request(port, {
      route: '/api/status',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN }
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).phase, 'idle');
  });
});

test('首页把令牌内联进 HTML，且不写进任何静态文件', async () => {
  await withServer(stubApp(), async port => {
    const response = await request(port, { route: '/', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(response.status, 200);
    assert.match(response.body, new RegExp(`window\\.__GO_ANTIGRAVITY_TOKEN__="${TOKEN}"`));
    assert.doesNotMatch(response.body, /GO_ANTIGRAVITY_BOOT_TOKEN/, '占位符必须被替换');
    assert.match(response.body, /Go-Antigravity/);
    assert.doesNotMatch(response.body, /\/ui\/|workspace-tabs|data-action=/, '握手页不能加载旧桌面');
  });
});

// ---------- 导出确认 ----------

test('脱敏导出是普通 GET', async () => {
  const app = stubApp({
    exportAccounts: ({ includeTokens }) => ({ pool: { accounts: [] }, count: 0, includeTokens })
  });
  await withServer(app, async port => {
    const response = await request(port, {
      route: '/api/accounts/export',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN }
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).includeTokens, false);
  });
});

test('GET 带 ?tokens=1 不再能导出完整令牌', async () => {
  const app = stubApp({
    exportAccounts: ({ includeTokens }) => ({ pool: { accounts: [] }, count: 0, includeTokens })
  });
  await withServer(app, async port => {
    const response = await request(port, {
      route: '/api/accounts/export?tokens=1',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN }
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).includeTokens, false, '旧参数必须被忽略');
  });
});

test('POST 导出完整令牌必须带显式确认，且会留痕', async () => {
  const logged = [];
  const app = stubApp({
    events: { log: (category, message, cls) => logged.push({ category, message, cls }), on() {}, off() {}, publish() {} },
    exportAccounts: ({ includeTokens }) => ({ pool: { accounts: [{ id: 'a' }] }, count: 1, includeTokens })
  });
  await withServer(app, async port => {
    const body = JSON.stringify({ includeTokens: true });
    const rejected = await request(port, {
      method: 'POST',
      route: '/api/accounts/export',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' },
      body
    });
    assert.equal(rejected.status, 400, '没有 confirm 字段时必须拒绝');
  });

  await withServer(app, async port => {
    const body = JSON.stringify({ includeTokens: true, confirm: 'export-tokens' });
    const ok = await request(port, {
      method: 'POST',
      route: '/api/accounts/export',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' },
      body
    });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).includeTokens, true);
  });
  assert.ok(logged.some(entry => /已导出含完整 refresh_token/.test(entry.message)), '导出完整令牌必须留痕');
});

test('OAuth 回调页不需要会话令牌（浏览器无法携带），其余接口仍需', async () => {
  const completed = [];
  const app = stubApp({
    completeOAuth: async ({ code, state }) => { completed.push({ code, state }); return { account: { email: 'new@example.com' } }; }
  });
  await withServer(app, async port => {
    const ok = await request(port, {
      route: '/oauth-callback?code=abc&state=xyz',
      headers: { Host: `127.0.0.1:${port}` }
    });
    assert.equal(ok.status, 200, '回调页必须能打开，否则整个授权流程 401 死锁');
    assert.match(ok.body, /授权成功/);
    assert.match(ok.body, /new@example\.com/);
    assert.deepEqual(completed, [{ code: 'abc', state: 'xyz' }]);

    // 同一路径缺少参数时给出可读提示，而不是 500
    const missing = await request(port, { route: '/oauth-callback', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(missing.status, 200);
    assert.match(missing.body, /回调参数缺失/);

    // 但 /api/* 依旧必须带令牌
    const guarded = await request(port, { route: '/api/status', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(guarded.status, 401);
  });
});

test('OAuth error 参数中的脚本与 HTML 只能作为转义文本显示', async () => {
  const payload = '</p><script>globalThis.injected=true</script><img src=x onerror="alert(1)"> & \'quoted\' &lt;b&gt;';
  const escaped = '&lt;/p&gt;&lt;script&gt;globalThis.injected=true&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39; &amp;lt;b&amp;gt;';
  const app = stubApp({ completeOAuth: async () => assert.fail('拒绝授权分支不应交换授权码') });
  await withServer(app, async port => {
    const response = await request(port, { route: '/oauth-callback?' + new URLSearchParams({ error: payload }) });
    assert.equal(response.status, 200);
    assert.match(response.body, /授权未完成/);
    assert.ok(response.body.includes(escaped));
    assert.ok(!response.body.includes(payload));
    assert.doesNotMatch(response.body, /<img\b|<script\b/i);
    assertCallbackCsp(response);
  });
});

test('OAuth 成功邮箱严格转义，自动关闭脚本使用每次独立的 CSP nonce', async () => {
  const email = '</p><script>alert("email")</script><svg onload=alert(1)>a&b\'@example.com';
  const escaped = '&lt;/p&gt;&lt;script&gt;alert(&quot;email&quot;)&lt;/script&gt;&lt;svg onload=alert(1)&gt;a&amp;b&#39;@example.com';
  const app = stubApp({ completeOAuth: async () => ({ account: { email } }) });
  await withServer(app, async port => {
    const route = '/oauth-callback?code=synthetic-code&state=synthetic-state';
    const response = await request(port, { route });
    assert.equal(response.status, 200);
    assert.match(response.body, /授权成功/);
    assert.ok(response.body.includes(escaped));
    assert.ok(!response.body.includes(email));
    assert.doesNotMatch(response.body, /<svg\b|<script>/i);
    const nonce = assertCallbackCsp(response, true);
    const next = await request(port, { route });
    assert.notEqual(assertCallbackCsp(next, true), nonce, 'nonce 不得跨响应复用');
  });
});

test('OAuth exception 消息中的标签和引号严格转义，失败页不运行脚本', async () => {
  const message = '</p><img src=x onerror="alert(1)"><script>alert(2)</script> & \'error\'';
  const escaped = '&lt;/p&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt; &amp; &#39;error&#39;';
  const app = stubApp({ completeOAuth: async () => { throw new Error(message); } });
  await withServer(app, async port => {
    const response = await request(port, { route: '/oauth-callback?code=synthetic-code&state=synthetic-state' });
    assert.equal(response.status, 200);
    assert.match(response.body, /授权失败/);
    assert.ok(response.body.includes(escaped));
    assert.ok(!response.body.includes(message));
    assert.doesNotMatch(response.body, /<img\b|<script\b/i);
    assertCallbackCsp(response);
  });
});

test('OAuth 无效或重放 state 不写账号，合法回调无需 boot token 仍可完成', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { createApplication } = require('../desktop/application');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-oauth-api-'));
  let exchanges = 0;
  let app;
  try {
    app = await createApplication({
      rootDir: path.join(__dirname, '..'), dataDir, testMode: true,
      kernelInspector: () => ({ platformSupported: true, targets: [] }),
      kernelPatcher: () => assert.fail('回调测试不应修改内核'),
      openUrl: () => assert.fail('回调测试不应打开浏览器'),
      agCred: {
        oauthClients: async () => [{ id: 'synthetic-client' }],
        exchangeAuthCode: async () => { exchanges++; return { refreshToken: 'synthetic-refresh', accessToken: 'synthetic-access' }; },
        userinfoProfile: async () => ({ email: 'synthetic@example.com', name: 'Synthetic account' }),
        readSystemCredential: async () => null,
        writeSystemCredential: () => assert.fail('回调测试不应写系统凭据')
      }
    });
    const port = await app.api.listen(0);
    app.apiPort = port;
    const flow = await app.startOAuth({ openBrowser: false });
    const original = JSON.stringify(app.accounts.all());
    const invalid = await request(port, { route: '/oauth-callback?code=synthetic-code&state=invalid-state' });
    assert.equal(invalid.status, 200);
    assert.match(invalid.body, /授权失败/);
    assert.match(invalid.body, /授权会话无效或已过期/);
    assertCallbackCsp(invalid);
    assert.equal(JSON.stringify(app.accounts.all()), original);
    assert.equal(exchanges, 0, '无效 state 不得交换令牌');
    const route = '/oauth-callback?' + new URLSearchParams({ code: 'synthetic-code', state: flow.state });
    const valid = await request(port, { route });
    assert.equal(valid.status, 200);
    assert.match(valid.body, /授权成功/);
    assertCallbackCsp(valid, true);
    assert.equal(exchanges, 1);
    assert.equal(app.accounts.all().length, 1);
    assert.equal(app.accounts.all()[0].email, 'synthetic@example.com');
    const saved = JSON.stringify(app.accounts.all());
    const replay = await request(port, { route });
    assert.match(replay.body, /授权失败/);
    assertCallbackCsp(replay);
    assert.equal(exchanges, 1, '已消费 state 不得再次交换令牌');
    assert.equal(JSON.stringify(app.accounts.all()), saved);
  } finally {
    if (app) await app.close('隔离 OAuth API 测试结束');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- 内核补丁 ----------

test('内核状态接口需要会话令牌，并返回档位词表供 UI 渲染', async () => {
  const app = stubApp({ kernelStatus: () => ({ desired: { promptTier: '3', contextMode: '512k' }, tiers: { stock: {}, '3': {}, custom: { visible: false, legacy: true } }, modes: { '256k': {}, '512k': {} }, targets: [] }) });
  await withServer(app, async port => {
    const denied = await request(port, { route: '/api/kernel/status', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(denied.status, 401);

    const ok = await request(port, { route: '/api/kernel/status', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.kernel.desired.promptTier, '3');
    assert.ok(body.kernel.tiers['3'], '档位词表必须随后端下发，UI 不重复定义');
    assert.strictEqual(body.kernel.tiers.custom.visible, false, '已移除的档位只用于识别旧内核状态');
    assert.deepStrictEqual(Object.keys(body.kernel.modes), ['256k', '512k']);
    assert.ok(!Object.hasOwn(body.kernel, 'customPrompt'));
    assert.equal(JSON.stringify(body.kernel).includes('自定义提示词全文'), false);
  });
});

test('应用内核补丁是 POST，失败时返回 409 且不带 ok:true', async () => {
  const calls = [];
  const app = stubApp({
    kernelStatus: () => ({ desired: {}, targets: [] }),
    applyKernel: async body => { calls.push(body); return { ok: false, logs: [], errors: ['写入失败：EBUSY'] }; }
  });
  await withServer(app, async port => {
    const get = await request(port, { route: '/api/kernel/apply', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(get.status, 404, '补丁应用不允许用 GET 触发');

    const failed = await request(port, {
      method: 'POST', route: '/api/kernel/apply',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptTier: '3', contextMode: '512k' })
    });
    assert.equal(failed.status, 409);
    assert.equal(JSON.parse(failed.body).ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].promptTier, '3');
    assert.equal(calls[0].contextMode, '512k');
  });
});

test('应用内核补丁成功时回传最新内核状态', async () => {
  const app = stubApp({
    kernelStatus: () => ({ desired: { promptTier: '3', contextMode: '512k' }, targets: [{ promptTier: '3', contextMode: '512k' }] }),
    applyKernel: async () => ({ ok: true, logs: ['[提示词] 已应用'], errors: [] })
  });
  await withServer(app, async port => {
    const ok = await request(port, {
      method: 'POST', route: '/api/kernel/apply',
      headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptTier: '3', contextMode: '512k' })
    });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.ok, true);
    assert.deepStrictEqual(body.kernel.targets, [{ promptTier: '3', contextMode: '512k' }]);
  });
});

test('public config/status and kernel apply never echo retired custom prompt fields', async () => {
  const secret = '本地自定义核心指令：只在内核里出现';
  const saved = { port: 7890, customSystemPrompt: secret, customPromptUpdatedAt: 1730000000000 };
  const calls = [];
  const app = stubApp({
    settings: { get: () => ({ ...saved }) },
    status: () => ({ port: 7890, kernel: { desired: { promptTier: 'stock', contextMode: '512k' }, targets: [] } }),
    configure: async body => { calls.push(['config', body]); },
    kernelStatus: () => ({ desired: { promptTier: 'stock', contextMode: '512k' }, targets: [] }),
    applyKernel: async body => { calls.push(['apply', body]); return { ok: true, logs: [], errors: [] }; }
  });
  await withServer(app, async port => {
    const headers = { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' };
    const status = await request(port, { route: '/api/status', headers });
    assert.equal(status.status, 200);
    assert.equal(status.body.includes(secret), false);
    assert.equal(status.body.includes('customSystemPrompt'), false);
    const kernel = await request(port, { route: '/api/kernel/status', headers });
    assert.equal(kernel.status, 200);
    assert.equal(kernel.body.includes(secret), false);
    assert.ok(!Object.hasOwn(JSON.parse(kernel.body).kernel, 'customPrompt'));
    const config = await request(port, { method: 'POST', route: '/api/config', headers, body: JSON.stringify({ port: 7891 }) });
    assert.equal(config.status, 200);
    assert.equal(config.body.includes(secret), false);
    assert.equal(config.body.includes('customSystemPrompt'), false);
    assert.equal(config.body.includes('customPromptUpdatedAt'), false);
    // Retired fields in the body are dropped instead of being forwarded to the patcher.
    const apply = await request(port, { method: 'POST', route: '/api/kernel/apply', headers, body: JSON.stringify({ promptTier: '3', contextMode: '512k', promptText: secret, clearCustomPrompt: true }) });
    assert.equal(apply.status, 200);
    const forwarded = calls.find(([kind]) => kind === 'apply')[1];
    assert.deepStrictEqual(forwarded, { promptTier: '3', contextMode: '512k' });
    assert.equal(JSON.stringify(forwarded).includes(secret), false);
  });
});

test('kernel apply keeps the API body limit without a custom text channel', async () => {
  const calls = [];
  const app = stubApp({
    kernelStatus: () => ({ desired: { promptTier: '3' }, targets: [] }),
    applyKernel: async body => { calls.push(body); return { ok: true, logs: [], errors: [] }; }
  });
  await withServer(app, async port => {
    const headers = { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' };
    const ok = await request(port, { method: 'POST', route: '/api/kernel/apply', headers, body: JSON.stringify({ promptTier: '3', contextMode: '512k', promptText: 'x'.repeat(3960) }) });
    assert.equal(ok.status, 200);
    assert.deepStrictEqual(calls[0], { promptTier: '3', contextMode: '512k' }, '大字段不再有通道，也不会被转发');
    const oversized = await request(port, { method: 'POST', route: '/api/kernel/apply', headers, body: JSON.stringify({ promptTier: '3', padding: 'y'.repeat(64 * 1024 + 1) }) });
    assert.equal(oversized.status, 400);
    assert.match(oversized.body, /请求内容过大|过大/);
    assert.equal(calls.length, 1);
  });
});

// ---------- 独立离线版本 ----------

test('旧更新接口对任意方法和请求体均返回 410，且不触发 updater', async () => {
  let calls = 0;
  const app = stubApp({ updater: { checkAndApply: async () => { calls++; throw new Error('不可执行更新'); } } });
  await withServer(app, async port => {
    for (const [method, body] of [
      ['POST', JSON.stringify({ manifestUrl: 'https://untrusted.invalid/overlay.json' })],
      ['POST', '{invalid JSON'],
      ['POST', 'x'.repeat(70 * 1024)],
      ['GET', null], ['PUT', '{}']
    ]) {
      const response = await request(port, {
        method, route: '/api/update', body,
        headers: { Host: '127.0.0.1:' + port, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json' }
      });
      assert.equal(response.status, 410);
      const result = JSON.parse(response.body);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'UPDATES_DISABLED');
      assert.match(result.error, /永久禁用/);
    }
  });
  assert.equal(calls, 0);
});

test('更新接口在请求体尚未结束时立即拒绝，不等待或解析正文', async () => {
  const app = stubApp();
  Object.defineProperty(app, 'updater', { get: () => assert.fail('旧更新接口不应读取 updater') });
  await withServer(app, async port => {
    const response = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/update',
        headers: { Host: '127.0.0.1:' + port, 'X-Go-Antigravity-Token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': '10000' }
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, body }); });
      });
      req.on('error', reject);
      req.setTimeout(2000, () => req.destroy(new Error('更新接口等待了未完成的正文')));
      req.write('{');
    });
    assert.equal(response.status, 410);
    assert.equal(JSON.parse(response.body).code, 'UPDATES_DISABLED');
  });
});

test('已禁用的更新接口仍保留本地会话与跨站校验', async () => {
  await withServer(stubApp(), async port => {
    const denied = await request(port, { method: 'POST', route: '/api/update' });
    assert.equal(denied.status, 401);
    const crossSite = await request(port, {
      method: 'POST', route: '/api/update',
      headers: { Host: '127.0.0.1:' + port, 'X-Go-Antigravity-Token': TOKEN, Origin: 'https://untrusted.invalid' }
    });
    assert.equal(crossSite.status, 403);
  });
});

// ---------- 代理自检 ----------

test('代理自检结果随 status 一起下发，端口与开关都在', async () => {
  const app = stubApp({ proxyStatus: () => ({ port: 7890, enabled: true, lastResult: { ok: true, code: 'ok', status: 400 } }) });
  await withServer(app, async port => {
    const denied = await request(port, { route: '/api/proxy/status', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(denied.status, 401);

    const ok = await request(port, { route: '/api/proxy/status', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.proxy.port, 7890);
    assert.equal(body.proxy.enabled, true);
    assert.equal(body.proxy.lastResult.code, 'ok');
  });
});

test('手动代理自检是 POST，地域被拒时也要把原因带回前端', async () => {
  const app = stubApp({
    proxyStatus: () => ({ port: 7897, enabled: true, lastResult: { ok: false, code: 'geo-blocked', status: 400, message: 'Google 拒绝服务', advice: '更换代理节点' } }),
    // The probe's whole job is to separate a blocked region from a dead node, so the endpoint
    // answers 200 with the verdict instead of a 409 that request() would throw away.
    proxyCheck: async () => ({ ok: false, code: 'geo-blocked', status: 400, message: 'Google 拒绝服务', advice: '更换代理节点' })
  });
  await withServer(app, async port => {
    const get = await request(port, { route: '/api/proxy/check', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(get.status, 404, '自检不允许用 GET 触发');

    const failed = await request(port, { method: 'POST', route: '/api/proxy/check', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(failed.status, 200);
    const body = JSON.parse(failed.body);
    assert.equal(body.probe.code, 'geo-blocked');
    assert.match(body.proxy.lastResult.advice, /更换代理节点/);
  });
});

test('手动代理自检通过时回传最新状态', async () => {
  const app = stubApp({
    proxyStatus: () => ({ port: 7890, enabled: true, lastResult: { ok: true, code: 'ok', status: 400, ms: 210 } }),
    proxyCheck: async () => ({ ok: true, code: 'ok', status: 400, ms: 210 })
  });
  await withServer(app, async port => {
    const ok = await request(port, { method: 'POST', route: '/api/proxy/check', headers: { Host: `127.0.0.1:${port}`, 'X-Go-Antigravity-Token': TOKEN } });
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.probe.ok, true);
    assert.equal(body.proxy.lastResult.ms, 210);
  });
});
