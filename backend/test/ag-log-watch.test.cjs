'use strict';
// Tests for the AG log watcher.
//
// This is the only component that can see the failure the preflight is blind to: Google decides the
// region gate after authenticating, so an exit region it refuses looks perfectly healthy to an
// unauthenticated probe. AG's own log is the first witness. If these tests stop passing, the user is
// back to an opaque "HTTP 400" dialog with no cause attached.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createAgLogWatcher, resolveLogPath, GEO_GATE } = require('../features/ag-log-watch');

const GEO_LINE = 'I1111 19:24:59.123456  181 errorreport.go:273] agent executor error: generating and executing: FAILED_PRECONDITION (code 400): User location is not supported for the API use.';
const NOISE = 'I1111 19:24:58.000000  181 server.go:123] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';

const POLL_MS = 5;
const SETTLE_MS = POLL_MS * 10;

// An in-memory stand-in for the log file. The watcher only ever needs size/read/close, so this is
// enough to drive it without touching the disk.
function fakeFs(initial = '') {
  let buffer = Buffer.from(initial, 'utf8');
  let nextHandle = 0;
  let openHandles = 0;
  return {
    get text() { return buffer.toString('utf8'); },
    get openHandles() { return openHandles; },
    append(text) { buffer = Buffer.concat([buffer, Buffer.from(text, 'utf8')]); },
    truncate(text = '') { buffer = Buffer.from(text, 'utf8'); },
    statSync() { return { size: buffer.length }; },
    openSync() { nextHandle += 1; openHandles += 1; return nextHandle; },
    readSync(handle, target, offset, length, position) {
      buffer.copy(target, offset, position, position + length);
      return length;
    },
    closeSync() { openHandles = Math.max(0, openHandles - 1); }
  };
}

// A log file that is not there yet, which is the normal state before AG has written anything.
function missingFs() {
  const error = new Error('ENOENT: no such file');
  error.code = 'ENOENT';
  return {
    statSync() { throw error; },
    openSync() { throw error; },
    readSync() { throw error; },
    closeSync() {}
  };
}

function fakeClock(start = 1000000) {
  let time = start;
  return { now: () => time, advance(ms) { time += ms; } };
}

function captureEvents() {
  const lines = [];
  return { lines, log(channel, message, tag) { lines.push({ channel, message, tag }); } };
}

// The clock is advanced before the wait, never after: no timer can fire between two synchronous
// statements, so every scan that observes the mutation also observes the advanced time.
async function settle() {
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
}

// A realistic exit description, so the default exercises the middle line of a report rather than
// silently skipping it. Tests that need it absent pass egress: '' explicitly.
const EXIT = '当前代理出口 198.51.100.7 · 美国 · Los Angeles · AS64496 EXAMPLE CLOUD LLC（经 127.0.0.1:7890）';

function build({ clock = fakeClock(), events = captureEvents(), fs: fsImpl = fakeFs(), egress = EXIT } = {}) {
  const watcher = createAgLogWatcher({
    events,
    logPath: 'C:/logs/language_server.log',
    pollMs: POLL_MS,
    describeEgress: () => egress,
    fs: fsImpl,
    now: clock.now
  });
  return { watcher, events, fs: fsImpl, clock };
}

test('启动前的旧报错不会被翻出来', async () => {
  const { watcher, events, fs: fsImpl, clock } = build({ fs: fakeFs(`${NOISE}\n${GEO_LINE}\n`) });
  watcher.start();
  clock.advance(60000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 0, '上一次 AG 跑崩留下的错误不该在本次启动时重演');
});

test('AG 运行期间出现地域拒绝时立刻报警，并带上出口', async () => {
  const { watcher, events, fs: fsImpl, clock } = build({
    egress: '当前代理出口 203.0.113.9 · 新加坡 · AS64497 EXAMPLE ORACLE（经 127.0.0.1:7890）'
  });
  watcher.start();
  fsImpl.append(`${NOISE}\n${GEO_LINE}\n`);
  clock.advance(2000);
  await settle();
  watcher.stop();

  const messages = events.lines.map(line => line.message);
  assert.ok(messages.some(text => text.includes('User location is not supported')), '必须原样点名 Google 的措辞');
  assert.ok(messages.some(text => text.includes('203.0.113.9')), '必须带上当前出口，这是唯一可执行的线索');
  assert.ok(messages.some(text => /换到 Google 受支持的地区/.test(text)), '必须给出下一步动作');
  assert.equal(events.lines[0].tag, 'tag-alert');
  assert.equal(events.lines.every(line => line.channel === 'PROXY'), true);
});

test('同一事件只报一次，不会每条消息都弹一遍', async () => {
  const { watcher, events, fs: fsImpl, clock } = build();
  watcher.start();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(500);
  await settle();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(500);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 3, '一次事件 = 三行（诊断 / 出口 / 建议），冷却期内重复行被吞掉');
});

test('冷却过后新的事件会再报一次', async () => {
  const { watcher, events, fs: fsImpl, clock } = build();
  watcher.start();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(60000);
  await settle();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(60000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 6, '两起独立事件各报一次');
});

test('拿不到出口时只报诊断和建议，不输出空行', async () => {
  const { watcher, events, fs: fsImpl, clock } = build({ egress: '' });
  watcher.start();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(2000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 2);
  assert.ok(events.lines.every(line => line.message.trim().length > 0));
});

test('无关日志行不会触发报警', async () => {
  const { watcher, events, fs: fsImpl, clock } = build();
  watcher.start();
  fsImpl.append(`${NOISE}\n${NOISE}\n`);
  clock.advance(5000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 0);
});

test('AG 重启导致日志被截断时，偏移量跟着重置', async () => {
  const { watcher, events, fs: fsImpl, clock } = build();
  watcher.start();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(60000);
  await settle();
  assert.equal(events.lines.length, 3);

  // AG rewrites the file when it starts; without the reset the watcher would read past the new
  // content forever and go permanently silent.
  fsImpl.truncate('');
  clock.advance(60000);
  await settle();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(120000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 6, '截断后必须能再次读到新内容');
});

test('日志文件不存在时不炸，只是安静地等', async () => {
  const { watcher, events, clock } = build({ fs: missingFs() });
  watcher.start();
  clock.advance(60000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 0);
});

test('stop 之后定时器与句柄都释放，不再有任何输出', async () => {
  const { watcher, events, fs: fsImpl, clock } = build();
  watcher.start();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(2000);
  await settle();
  assert.equal(events.lines.length, 3);
  watcher.stop();
  assert.equal(fsImpl.openHandles, 0, '句柄必须关闭，否则长驻 launcher 一直占着这个文件');

  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(120000);
  await settle();
  assert.equal(events.lines.length, 3, 'stop 之后不该再有任何扫描');
});

test('重复 start 不会开两套定时器', async () => {
  const { watcher, events, fs: fsImpl, clock } = build();
  watcher.start();
  watcher.start();
  fsImpl.append(`${GEO_LINE}\n`);
  clock.advance(2000);
  await settle();
  watcher.stop();
  assert.equal(events.lines.length, 3);
});

test('日志路径按 %APPDATA% 推导，缺省时返回 null 而不是乱拼路径', () => {
  // path.join is deliberately used, so the separator follows the platform: on Windows this has to be
  // a backslash, because AG wrote it that way and fs does not normalise for us.
  assert.equal(
    resolveLogPath('D:/AppData/Roaming'),
    path.join('D:/AppData/Roaming', 'Antigravity', 'logs', 'language_server.log')
  );
  assert.ok(resolveLogPath('D:/AppData/Roaming').includes('language_server.log'));
  assert.equal(resolveLogPath(''), null);
  assert.equal(resolveLogPath(undefined), null);
});

test('守望的是 Google 地域拒绝这一句话本身', () => {
  // The signature is the message text, not the status code: AG logs it inside a longer Go line, and
  // the numeric code alone would also match unrelated FAILED_PRECONDITIONs.
  assert.ok(GEO_LINE.includes(GEO_GATE));
  assert.equal(NOISE.includes(GEO_GATE), false);
});
