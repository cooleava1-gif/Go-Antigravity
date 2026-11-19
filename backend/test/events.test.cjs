const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Events } = require('../core/events');
const { containsSecret } = require('../core/redact');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-events-test-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } });
  return dir;
}

test('日志落盘前会抹掉凭据，磁盘上不留明文', () => {
  const dir = tempDir();
  const events = new Events(dir);
  events.log('SYSTEM', 'Command failed: curl.exe --data-urlencode client_secret=FAKE-SECRET-not-a-real-one --data-urlencode refresh_token=1//05FAKErefreshTOKENforTESTonly0000ZZZZ https://oauth2.googleapis.com/token', 'tag-warn');

  const raw = fs.readFileSync(path.join(dir, 'goagy.log'), 'utf8');
  assert.equal(containsSecret(raw), false, raw);
  assert.match(raw, /client_secret=\*\*\*/);
  assert.match(raw, /refresh_token=\*\*\*/);

  // 推送给界面的同一条消息也必须是干净的
  const [entry] = events.logs(1);
  assert.equal(containsSecret(entry.message), false);
});

test('普通日志按原样保留', () => {
  const dir = tempDir();
  const events = new Events(dir);
  events.log('SYSTEM', 'Antigravity 已启动（本地代理 127.0.0.1:7897）', 'tag-proxy');
  assert.equal(events.logs(1)[0].message, 'Antigravity 已启动（本地代理 127.0.0.1:7897）');
});

test('日志超过上限会滚动到 .previous，历史仍不含凭据', () => {
  const dir = tempDir();
  const events = new Events(dir);
  fs.writeFileSync(path.join(dir, 'goagy.log'), 'x'.repeat(2 * 1024 * 1024 + 10));
  events.log('SYSTEM', '触发滚动 refresh_token=1//05FAKErefreshTOKENforTESTonly0000ZZZZ');

  assert.ok(fs.existsSync(path.join(dir, 'goagy.log.previous')));
  const current = fs.readFileSync(path.join(dir, 'goagy.log'), 'utf8');
  assert.equal(containsSecret(current), false);
});
