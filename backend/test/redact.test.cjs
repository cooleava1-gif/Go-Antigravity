const test = require('node:test');
const assert = require('node:assert');
const { redactSecrets, containsSecret } = require('../core/redact');

const CURL_LINE = 'Command failed: curl.exe -s --http1.1 --max-time 25 -X POST --proxy http://127.0.0.1:7897 '
  + '--data-urlencode client_id=1234567890-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com '
  + '--data-urlencode client_secret=FAKE-SECRET-not-a-real-one '
  + '--data-urlencode refresh_token=1//05FAKErefreshTOKENforTESTonly0000000000ZZZZ '
  + '--data-urlencode grant_type=refresh_token https://oauth2.googleapis.com/token';

test('整条 curl 命令行里的 secret 与 refresh_token 都会被抹掉', () => {
  const clean = redactSecrets(CURL_LINE);
  assert.equal(containsSecret(clean), false, clean);
  assert.match(clean, /client_secret=\*\*\*/);
  assert.match(clean, /refresh_token=\*\*\*/);
  assert.match(clean, /client_id=1234567890/, '非敏感参数保留，便于排查');
});

test('JSON 载荷里的令牌字段也会被抹掉', () => {
  const json = '{"refresh_token":"1//0gABCDEFGHIJKLMNOP","access_token":"ya29.a0AfH6SMBx","email":"a@example.com"}';
  const clean = redactSecrets(json);
  assert.equal(containsSecret(clean), false, clean);
  assert.match(clean, /"refresh_token":"\*\*\*"/);
  assert.match(clean, /"access_token":"\*\*\*"/);
  assert.match(clean, /a@example\.com/, '邮箱不属于凭据，保留可读性');
});

test('Authorization 头与散落的令牌形态都会被处理', () => {
  const line = 'Authorization: Bearer ya29.a0AfH6SMBexampleToken';
  assert.equal(containsSecret(line), true);
  const clean = redactSecrets(line);
  assert.equal(containsSecret(clean), false, clean);
  // The Bearer rule masks the credential; the Authorization rule keeps the scheme readable.
  assert.match(clean, /Authorization: Bearer \*\*\*/);
  // Idempotent: redacting the redacted output changes nothing.
  assert.equal(redactSecrets(clean), clean);
  assert.equal(containsSecret(redactSecrets('secret=FAKE-SECRET-not-a-real-one')), false);
  assert.match(redactSecrets('token 1//05FAKErefreshTOKENforTESTonly0000ZZZZ ended'), /token \*\*\* ended/);
});

test('普通日志不会被误伤', () => {
  const normal = '账户池迁移：保留 2 个账户，跳过 1 条缺少 refresh_token 的旧记录（curl 退出码 7）';
  assert.equal(redactSecrets(normal), normal);
  assert.equal(containsSecret(normal), false);
});

test('空值与对象不会抛错', () => {
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets({}).includes('[object Object]'), true);
});

test('named tunnel token spellings and quoting are redacted without hiding public status fields', () => {
  const secret = 'synthetic-cloudflare-secret-12345';
  for (const key of ['tunnelToken', 'TUNNEL_TOKEN', 'tunnel-token', 'cf_tunnel_token', 'CLOUDFLARED_TOKEN']) {
    for (const line of [key + '=' + secret, '"' + key + '":"' + secret + '"', "'" + key + "'='" + secret + "'"]) {
      assert.equal(containsSecret(line), true); const clean = redactSecrets(line);
      assert.equal(clean.includes(secret), false); assert.equal(containsSecret(clean), false);
    }
  }
  for (const line of ['--token ' + secret, '--token=' + secret, '--token "' + secret + '"']) {
    assert.equal(containsSecret(line), true); assert.equal(redactSecrets(line).includes(secret), false);
  }
  const normal = JSON.stringify({ tunnelTokenConfigured: true, fixedAuth: 'token', fixedUrl: 'https://mobile.example.test' });
  assert.equal(redactSecrets(normal), normal); assert.equal(containsSecret(normal), false);
});

// F5: common credential shapes that the original RULES table missed.
test('Cookie / API-key / 裸 token 形态都会被脱敏', () => {
  const cases = [
    // Cookie 头：整头遮蔽（保留头名），因为 Cookie 值整体都是凭据
    ['Cookie: session_id=synthetic-session-value-1234567890', /^Cookie: \*\*\*$/],
    ['Set-Cookie: sid=another-synthetic-session-value; Path=/', /^Set-Cookie: \*\*\*$/],
    // 非 Bearer 的 Authorization 头：保留 scheme，遮蔽凭据
    ['Authorization: Basic c3ludGhldGljLXVzZXI6c3ludGhldGljLXBhc3N3b3Jk', /Authorization: Basic \*\*\*/],
    ['Authorization: Token synthetic-api-token-value-1234', /Authorization: Token \*\*\*/],
    // API key 形态
    ['x-api-key=synthetic-api-key-value-1234567890', /x-api-key=\*\*\*/],
    ['api_key: synthetic-api-key-value-1234567890', /api_key=\*\*\*/],
    ['{"api_key":"synthetic-api-key-value-1234567890","ok":true}', /"api_key":"\*\*\*"/],
    ['apikey=synthetic-api-key-value-1234567890', /apikey=\*\*\*/],
    ['webhook_secret=synthetic-webhook-secret-123456', /webhook_secret=\*\*\*/],
    // 裸 token 键
    ['token=synthetic-bare-token-value-1234567890', /token=\*\*\*/],
    ['"token": "synthetic-bare-token-value-1234567890"', /"token":"\*\*\*"/],
    // 无键名的 JWT
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMtdXNlciJ9.eyJzeW50aGV0aWMtc2lnbmF0dXJlIiw', /jwt\.\*\*\*/]
  ];
  for (const [line, mask] of cases) {
    assert.equal(containsSecret(line), true, '应识别为含秘密: ' + line);
    const clean = redactSecrets(line);
    assert.equal(containsSecret(clean), false, '脱敏后不应仍含秘密: ' + clean);
    assert.match(clean, mask, '应保留键名并遮蔽值: ' + clean);
    assert.equal(redactSecrets(clean), clean, '重复脱敏应保持不变');
    if (line.startsWith('{')) assert.equal(JSON.parse(clean).ok, true);
  }
});

test('新增规则不吞普通日志文本', () => {
  const normal = [
    '登录成功：token 类型为 Bearer，用户 alice@example.com',
    '配置项 token 已设置，值为 true',
    'HTTP 429，稍后重试，当前配额 90%',
    'curl 退出码 7，代理没开',
  ];
  for (const line of normal) {
    assert.equal(redactSecrets(line), line, line);
    assert.equal(containsSecret(line), false, line);
  }
});
