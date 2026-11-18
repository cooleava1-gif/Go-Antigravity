const test = require('node:test');
const assert = require('node:assert');
const {
  buildAuthUrl,
  createFlowStore,
  parseCallbackInput,
  parseTokenImportInput,
  CALLBACK_PATH
} = require('../core/agoauth');

test('授权链接带上 offline 与一次性 state', () => {
  const url = new URL(buildAuthUrl({
    clientId: 'client-id',
    redirectUri: `http://127.0.0.1:19823${CALLBACK_PATH}`,
    state: 'state-1',
    loginHint: 'a@example.com'
  }));

  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('login_hint'), 'a@example.com');
  assert.ok(url.searchParams.get('scope').includes('cloud-platform'));
});

test('state 只能消费一次', () => {
  const store = createFlowStore();
  const state = store.begin({ loginHint: 'a@example.com' });

  const entry = store.consume(state);
  assert.equal(entry.state, state);
  assert.equal(entry.loginHint, 'a@example.com', 'consume 要把会话信息交回给调用方');
  assert.equal(store.consume(state), null);
  assert.equal(store.active(), null);
});

test('过期 state 会被清理', () => {
  let now = 1_000;
  const store = createFlowStore({ ttlMs: 5_000, now: () => now });
  const state = store.begin();
  assert.equal(store.size, 1);

  now += 6_000;
  assert.equal(store.size, 0);
  assert.equal(store.consume(state), null);
});

test('取消授权会话后 state 失效', () => {
  const store = createFlowStore();
  const state = store.begin();
  store.cancel();
  assert.equal(store.consume(state), null);
});

test('回调链接解析出 code 与 state', () => {
  const result = parseCallbackInput('http://127.0.0.1:19823/oauth-callback?code=abc123&state=xyz');
  assert.deepEqual(result, { code: 'abc123', state: 'xyz' });
});

test('回调链接缺少 state 时回落到当前会话', () => {
  const result = parseCallbackInput('http://127.0.0.1:19823/oauth-callback?code=abc123', 'fallback');
  assert.deepEqual(result, { code: 'abc123', state: 'fallback' });
});

test('授权被拒绝时给出明确错误', () => {
  assert.throws(
    () => parseCallbackInput('http://127.0.0.1:19823/oauth-callback?error=access_denied&state=x'),
    /access_denied/
  );
});

test('只粘贴授权码时必须先发起会话', () => {
  assert.throws(() => parseCallbackInput('4/0AX4XfWh'), /请先点击「授权添加」/);
  assert.deepEqual(parseCallbackInput('4/0AX4XfWh', 'state-9'), { code: '4/0AX4XfWh', state: 'state-9' });
});

test('JSON 数组批量导入', () => {
  const entries = parseTokenImportInput(JSON.stringify([
    { refresh_token: 'rt-1', email: 'a@example.com' },
    { token: { refresh_token: 'rt-2' }, user: { email: 'b@example.com' } },
    { nothing: true }
  ]));

  assert.equal(entries.length, 2);
  assert.equal(entries[0].refreshToken, 'rt-1');
  assert.equal(entries[1].email, 'b@example.com');
});

test('脱敏标记和可识别掩码不能作为刷新令牌导入', () => {
  for (const input of [
    { refreshToken: 'synthetic-token', refreshTokenMasked: true },
    { refresh_token: 'synthetic-token', refresh_token_masked: true },
    { token: { refreshToken: 'synthetic-token', refreshTokenMasked: true } },
    { refreshToken: 'synthe…oken' }, { refreshToken: '***' }, { refreshToken: 'synthe...oken' }
  ]) assert.throws(() => parseTokenImportInput(JSON.stringify(input)), /脱敏令牌不能导入/);
  for (const input of ['***', 'synthe…oken', 'synthe...oken']) {
    assert.throws(() => parseTokenImportInput(input), /脱敏令牌不能导入/);
  }
  assert.equal(parseTokenImportInput(JSON.stringify({ accounts: [{ refreshToken: 'synthetic-full-token', refreshTokenMasked: false }] }))[0].refreshToken, 'synthetic-full-token');
});

test('裸 refresh_token 导入', () => {
  const entries = parseTokenImportInput('1//0gABCDEF');
  assert.deepEqual(entries, [{ refreshToken: '1//0gABCDEF', email: null, name: null }]);
  assert.throws(() => parseTokenImportInput('   '), /refresh_token/);
  assert.throws(() => parseTokenImportInput('[{"foo":1}]'), /refresh_token/);
});
