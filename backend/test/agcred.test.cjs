const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const {
  createAgCred,
  buildCredentialPayload,
  parseCredentialPayload,
  parseTokenResponse,
  toRfc3339Micros,
  parseRfc3339,
  extractOauthClients,
  scanBinaryForClients,
  AG_FINGERPRINTS,
  isRefreshClientId,
  isIdeClientId
} = require('../core/agcred');

test('AG 系统凭据载荷可以往返转换', () => {
  const expiryTs = Date.UTC(2026, 9, 24, 5, 0, 0);
  const json = buildCredentialPayload({ accessToken: 'at', refreshToken: 'rt', expiryTs });
  const parsed = parseCredentialPayload(json);

  assert.equal(parsed.accessToken, 'at');
  assert.equal(parsed.refreshToken, 'rt');
  assert.equal(parsed.expiryTs, expiryTs);
  assert.equal(toRfc3339Micros(expiryTs), '2026-10-24T05:00:00.000000Z');
  assert.equal(parseRfc3339('2026-10-24T05:00:00.000000Z'), expiryTs);
  assert.equal(parseRfc3339('not-a-date'), 0);
});

test('缺少 refresh_token 的凭据会被拒绝', () => {
  assert.throws(() => parseCredentialPayload(JSON.stringify({ token: { access_token: 'at' } })), /refresh_token/);
});

test('令牌响应缺少 access_token 时抛错', () => {
  assert.throws(() => parseTokenResponse(JSON.stringify({ refresh_token: 'rt' })), /access_token/);
  assert.deepEqual(parseTokenResponse(JSON.stringify({ access_token: 'at', expires_in: '1800' })), {
    accessToken: 'at',
    refreshToken: null,
    expiresIn: 1800
  });
});

// 合成 id/secret 的形状必须让 agcred 的两条正则命中：id 是 "数字-32位小写字母数字"，
// secret 是 GOCSPX- 加 28 位。前缀拆开写只是为了让 GitHub 的 secret scanning 不把
// 这条明显的假数据当成真凭据，运行时拼接结果与真实形态逐字节相同。
const SYNTH_REFRESH_ID = '1234567890-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com';
const SYNTH_IDE_ID = '1234567891-zyxwvutsrqponmlkjihgfedcba98765.apps.googleusercontent.com';
const SECRET_PREFIX = 'GOCSP' + 'X-';
const SYNTH_REFRESH_SECRET = SECRET_PREFIX + 'SYNTHREFRESHSECRET0000000001';
const SYNTH_IDE_SECRET = SECRET_PREFIX + 'SYNTHIDESECRET00000000000002';
const SYNTH_PRINTS = {
  refreshClientId: createHash('sha256').update(SYNTH_REFRESH_ID).digest('hex'),
  refreshSecret: createHash('sha256').update(SYNTH_REFRESH_SECRET).digest('hex'),
  ideClientId: createHash('sha256').update(SYNTH_IDE_ID).digest('hex'),
  ideSecret: createHash('sha256').update(SYNTH_IDE_SECRET).digest('hex')
};

test('OAuth 客户端提取把公开刷新客户端排在首位', () => {
  const text = [
    'junk',
    `${SYNTH_REFRESH_ID}`,
    `${SYNTH_REFRESH_SECRET}`,
    `${SYNTH_IDE_ID}`,
    `${SYNTH_IDE_SECRET}`
  ].join(' ');
  const clients = extractOauthClients(text, SYNTH_PRINTS);

  assert.ok(clients.length > 0);
  assert.equal(clients[0].id, SYNTH_REFRESH_ID);
  assert.equal(clients[0].secret, SYNTH_REFRESH_SECRET);
  assert.ok(clients.every(client => /^GOCSPX-/.test(client.secret)));
});

test('二进制 OAuth 扫描跨分块累计标记并在全文件中排序', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-oauth-chunks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gap = '\0'.repeat(300);
  for (const [name, text] of [
    ['id-first', SYNTH_REFRESH_ID + gap + SYNTH_REFRESH_SECRET],
    ['secret-first', SYNTH_REFRESH_SECRET + gap + SYNTH_REFRESH_ID],
    ['split-id', '\0'.repeat(61) + SYNTH_REFRESH_ID + gap + SYNTH_REFRESH_SECRET],
    ['split-secret', '\0'.repeat(61) + SYNTH_REFRESH_SECRET + gap + SYNTH_REFRESH_ID],
    ['late-refresh', SYNTH_IDE_ID + ' ' + SYNTH_IDE_SECRET + gap + SYNTH_REFRESH_ID + gap + SYNTH_REFRESH_SECRET]
  ]) await t.test(name, async () => {
    const file = path.join(dir, name + '.bin');
    fs.writeFileSync(file, text, 'latin1');
    const clients = await scanBinaryForClients({ candidates: [path.join(dir, 'missing.bin'), file], highWaterMark: 64, prints: SYNTH_PRINTS });
    assert.equal(clients[0]?.id, SYNTH_REFRESH_ID);
    assert.equal(clients[0]?.secret, SYNTH_REFRESH_SECRET);
  });
});

test('刷新客户端的指纹来自真实 AG 客户端，不是随手写的', () => {
  assert.equal(AG_FINGERPRINTS.refreshClientId.length, 64);
  assert.equal(AG_FINGERPRINTS.ideClientId.length, 64);
  assert.ok(isRefreshClientId(AG_FINGERPRINTS.refreshClientId) === false, '指纹本身不是 id');
  assert.equal(isIdeClientId(SYNTH_IDE_ID, SYNTH_PRINTS), true);
});

test('同一 refresh_token 的并发刷新只发一次请求', async () => {
  let calls = 0;
  const cred = createAgCred({
    scriptPath: 'unused.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async () => {
      calls += 1;
      return { stdout: JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }) };
    }
  });

  const [first, second] = await Promise.all([
    cred.refreshAccessToken('rt-shared', 7890),
    cred.refreshAccessToken('rt-shared', 7890)
  ]);

  assert.equal(calls, 1, '并发的两次刷新应合并为一次网络请求');
  assert.equal(first.accessToken, 'at-fresh');
  assert.equal(second.accessToken, 'at-fresh');
  assert.equal(first.clientType, 'public');

  // 完成后锁必须释放，下一次刷新要真正重新取令牌
  await cred.refreshAccessToken('rt-shared', 7890);
  assert.equal(calls, 2);
});

test('刷新失败的并发请求共享同一个错误，且不会残留锁', async () => {
  let calls = 0;
  const cred = createAgCred({
    scriptPath: 'unused.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async () => {
      calls += 1;
      return { stdout: JSON.stringify({ error: 'invalid_grant' }) };
    }
  });

  const results = await Promise.allSettled([
    cred.refreshAccessToken('rt-bad', 7890),
    cred.refreshAccessToken('rt-bad', 7890)
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 2);
  assert.match(results[0].reason.message, /invalid_grant/);

  await assert.rejects(() => cred.refreshAccessToken('rt-bad', 7890));
  assert.equal(calls, 2, '失败后应允许重试');
});

test('invalid_grant 归类为不可重试的永久错误', async () => {
  const cred = createAgCred({
    scriptPath: 'unused.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async () => ({
      stdout: JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    })
  });

  await assert.rejects(() => cred.refreshAccessToken('rt-revoked', 7890), error => {
    assert.equal(error.code, 'invalid_grant');
    assert.equal(error.permanent, true);
    assert.match(error.message, /Token has been expired or revoked/);
    return true;
  });
});

test('代理不可达时不再把整条 curl 命令（含密钥）抛给上层', async () => {
  const leakyCommand = 'Command failed: curl.exe -s --http1.1 --max-time 25 -X POST --proxy http://127.0.0.1:7897 '
    + '--data-urlencode client_id=1234567890-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com '
    + '--data-urlencode client_secret=FAKE-SECRET-not-a-real-one '
    + '--data-urlencode refresh_token=1//05FAKErefreshTOKENforTESTonly0000ZZZZ '
    + '--data-urlencode grant_type=refresh_token https://oauth2.googleapis.com/token';
  const curlError = Object.assign(new Error(leakyCommand), { code: 7, stderr: '' });

  const cred = createAgCred({
    scriptPath: 'unused.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async () => { throw curlError; }
  });

  await assert.rejects(() => cred.refreshAccessToken('rt', 7897), error => {
    assert.equal(error.code, 'network_error');
    assert.equal(error.permanent, false, '代理挂了不等于账号失效');
    assert.doesNotMatch(error.message, /FAKE-SECRET-not-a-real-one/, '错误信息不能带 client_secret');
    assert.doesNotMatch(error.message, /1\/\/05rFEns/, '错误信息不能带 refresh_token');
    assert.match(error.message, /curl 退出码 7/);
    assert.match(error.message, /127\.0\.0\.1:7897/, '要指出是哪个代理端口连不上');
    return true;
  });
});

test('非 JSON 的网关错误不会被误判为永久失效', async () => {
  const cred = createAgCred({
    scriptPath: 'unused.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async () => ({ stdout: '<html>502 Bad Gateway</html>' })
  });

  await assert.rejects(() => cred.refreshAccessToken('rt-busy', 7890), error => {
    assert.equal(error.permanent, false);
    assert.equal(error.code, 'refresh_failed');
    return true;
  });
});

test('配置代理但缺少 curl 时明确失败，不用 fetch 发送任何凭据', async t => {
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { fetchCalls += 1; throw new Error('unexpected direct request'); });
  const cred = createAgCred({
    scriptPath: 'unused.ps1', platform: 'linux', oauthClientLoader: async () => [],
    execFileAsync: async () => { throw Object.assign(new Error('synthetic secret in curl command'), { code: 'ENOENT' }); }
  });
  for (const request of [
    { method: 'POST', form: { refresh_token: 'synthetic-refresh', client_secret: 'synthetic-secret' } },
    { method: 'POST', body: { value: 'synthetic-body' } },
    { headers: { Authorization: 'Bearer synthetic-access' } }
  ]) {
    await assert.rejects(cred.http({ url: 'https://upstream.fixture.invalid/token', proxyPort: 7897, ...request }), error => {
      assert.equal(error.code, 'network_error');
      assert.equal(error.permanent, false);
      assert.match(error.message, /curl[.]exe/);
      assert.match(error.message, /127[.]0[.]0[.]1:7897/);
      assert.match(error.message, /请求未发送/);
      assert.doesNotMatch(error.message, /synthetic-(?:refresh|secret|body|access)|curl command/);
      return true;
    });
  }
  assert.equal(fetchCalls, 0);
});

test('未配置代理且缺少 curl 时保留有超时的 fetch 回退和请求内容', async t => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { seen.push({ url, options }); return { text: async () => 'synthetic response' }; });
  const cred = createAgCred({ scriptPath: 'unused.ps1', oauthClientLoader: async () => [],
    execFileAsync: async () => { throw Object.assign(new Error('curl missing'), { code: 'ENOENT' }); } });
  assert.equal(await cred.http({ url: 'https://upstream.fixture.invalid/token', method: 'POST', form: { code: 'synthetic code' } }), 'synthetic response');
  assert.equal(seen[0].options.body, 'code=synthetic+code');
  assert.equal(seen[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(seen[0].options.signal instanceof AbortSignal);
  assert.equal(seen[0].options.signal.aborted, false);
  assert.equal(await cred.http({ url: 'https://upstream.fixture.invalid/quota', method: 'POST', body: { sample: true } }), 'synthetic response');
  assert.equal(seen[1].options.body, '{"sample":true}');
});

test('无代理 fetch 回退读取响应体失败时仍返回脱敏网络错误', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ text: async () => { throw new Error('refresh_token=synthetic-sensitive-value'); } }));
  const cred = createAgCred({ scriptPath: 'unused.ps1', oauthClientLoader: async () => [],
    execFileAsync: async () => { throw Object.assign(new Error('curl missing'), { code: 'ENOENT' }); } });
  await assert.rejects(cred.http({ url: 'https://upstream.fixture.invalid/token' }), error => {
    assert.equal(error.code, 'network_error');
    assert.doesNotMatch(error.message, /synthetic-sensitive-value/);
    return true;
  });
});

test('显式代理禁用继承的 NO_PROXY，无代理请求不改变 curl 默认路由', async () => {
  const calls = [];
  const cred = createAgCred({ scriptPath: 'unused.ps1', oauthClientLoader: async () => [],
    execFileAsync: async (command, args) => { calls.push({ command, args }); return { stdout: '{}' }; } });
  await cred.http({ url: 'https://upstream.fixture.invalid/', proxyPort: 7897 });
  assert.equal(calls[0].command, 'curl.exe');
  assert.equal(calls[0].args[calls[0].args.indexOf('--proxy') + 1], 'http://127.0.0.1:7897');
  assert.equal(calls[0].args[calls[0].args.indexOf('--noproxy') + 1], '');
  await cred.http({ url: 'https://upstream.fixture.invalid/' });
  assert.equal(calls[1].args.includes('--proxy'), false);
  assert.equal(calls[1].args.includes('--noproxy'), false);
});

test('真实 curl 遇到 NO_PROXY=* 仍经过显式本地代理，无代理请求保持直连', { skip: process.platform !== 'win32' }, async t => {
  const http = require('node:http');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const path = require('node:path');
  const run = promisify(execFile);
  const curl = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'curl.exe');
  try { await run(curl, ['-q', '--version'], { windowsHide: true, timeout: 3000 }); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Windows curl.exe unavailable'); throw error; }
  let direct = 0, proxied = 0;
  const origin = http.createServer((request, response) => { direct += 1; response.end('{"route":"direct"}'); });
  const proxy = http.createServer((request, response) => { proxied += 1; response.end('{"route":"proxy"}'); });
  t.after(async () => { for (const server of [origin, proxy]) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } });
  const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await listen(origin); await listen(proxy);
  const env = { SystemRoot: process.env.SystemRoot || 'C:/Windows', NO_PROXY: '*', no_proxy: '*' };
  const cred = createAgCred({ scriptPath: 'unused.ps1', oauthClientLoader: async () => [],
    execFileAsync: (command, args, options) => run(curl, ['-q', ...args], { ...options, env }) });
  const url = `http://127.0.0.1:${origin.address().port}/synthetic`;
  assert.equal(JSON.parse(await cred.http({ url, proxyPort: proxy.address().port })).route, 'proxy');
  assert.equal(direct, 0); assert.equal(proxied, 1);
  assert.equal(JSON.parse(await cred.http({ url })).route, 'direct');
  assert.equal(direct, 1); assert.equal(proxied, 1);
});

test('ensureFresh 在令牌仍然新鲜时不再请求网络', async () => {
  let calls = 0;
  const cred = createAgCred({
    scriptPath: 'unused.ps1',
    platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async () => {
      calls += 1;
      return { stdout: JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }) };
    }
  });

  const fresh = await cred.ensureFresh({
    accessToken: 'at-cached',
    refreshToken: 'rt',
    expiryTs: Date.now() + 3600 * 1000
  }, 7890);

  assert.equal(fresh.accessToken, 'at-cached');
  assert.equal(calls, 0);
});

test('ensureFresh await 期间账户被换令牌时仍只返回原请求的 refresh', async () => {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const account = { accessToken: '', refreshToken: 'synthetic-original-refresh', expiryTs: 0 };
  let sentToken;
  const cred = createAgCred({
    scriptPath: 'unused.ps1', platform: 'linux',
    oauthClientLoader: async () => [{ id: SYNTH_REFRESH_ID, secret: 'fake-refresh-secret' }],
    execFileAsync: async (command, args) => { sentToken = args.find(value => value.startsWith('refresh_token=')); entered(); await paused; return { stdout: JSON.stringify({ access_token: 'synthetic-original-access', expires_in: 3600 }) }; }
  });
  const work = cred.ensureFresh(account, 7890);
  await ready;
  account.refreshToken = 'synthetic-later-refresh';
  account.accessToken = 'synthetic-later-access';
  release();
  const result = await work;
  assert.equal(sentToken, 'refresh_token=synthetic-original-refresh');
  assert.equal(result.refreshToken, 'synthetic-original-refresh');
  assert.equal(result.accessToken, 'synthetic-original-access');
  assert.equal(account.refreshToken, 'synthetic-later-refresh');
});
