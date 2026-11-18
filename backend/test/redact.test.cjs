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
  assert.equal(containsSecret(redactSecrets('Authorization: Bearer ya29.a0AfH6SMBexampleToken')), false);
  assert.equal(containsSecret(redactSecrets('secret=FAKE-SECRET-not-a-real-one')), false);
  assert.match(redactSecrets('token 1//05FAKErefreshTOKENforTESTonly0000ZZZZ ended'), /1\/\/05…/);
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
