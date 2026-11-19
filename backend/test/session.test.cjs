'use strict';
// Session tests. `onBeforeLaunch` is the hook that lets the launcher patch the kernel while AG is
// provably closed; if it runs at the wrong moment (or swallows a failure) it either races a running
// language_server for the file handle or silently launches an unpatched AG.
const test = require('node:test');
const assert = require('node:assert');
const { Session } = require('../core/session');

function stubDesktop(overrides = {}) {
  return {
    locate: () => ({ appExe: 'C:/antigravity/Antigravity.exe', exists: true }),
    running: async () => false,
    ...overrides
  };
}

function stubChild() {
  const child = {
    pid: 4242,
    exitCode: null,
    once(event, handler) {
      (child.listeners[event] ||= []).push(handler);
      // The real child_process emits 'spawn' on the next tick; without that the launch promise
      // would never settle and the test would hang instead of failing.
      if (event === 'spawn') queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    listeners: {},
    emit(event) { for (const handler of child.listeners[event] || []) handler(); },
    kill() {}
  };
  return child;
}

function makeSession({ settings, child, hooks = {}, desktop, events: eventsOverride } = {}) {
  const events = eventsOverride || { published: [], log: () => {}, publish(snapshot) { this.published.push(snapshot); } };
  const cdp = { port: 9333, start() {}, stop: async () => {} };
  const session = new Session({
    settings: settings || { get: () => ({ port: 7890 }) },
    desktop: desktop || stubDesktop(),
    cdp,
    events,
    host: { hide() {} },
    testMode: false,
    wait: async () => {},
    spawnProcess: () => child,
    onStart: () => {},
    ...hooks
  });
  return { session, events, cdp };
}

test('onBeforeLaunch 在 AG 已确认退出之后、spawn 之前运行', async () => {
  const order = [];
  const child = stubChild();
  const { session } = makeSession({
    child,
    hooks: { onBeforeLaunch: async () => { order.push('before-launch'); } }
  });
  const original = session.spawnProcess;
  session.spawnProcess = (...args) => { order.push('spawn'); return original(...args); };

  const result = await session.launch();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepStrictEqual(order, ['before-launch', 'spawn']);
  assert.equal(session.phase, 'running');
});

test('onBeforeLaunch 抛错时终止启动，不会拉起一个没打补丁的 AG', async () => {
  const child = stubChild();
  const { session, events } = makeSession({
    child,
    hooks: { onBeforeLaunch: async () => { throw new Error('内核补丁失败：EBUSY'); } }
  });
  const result = await session.launch();
  assert.equal(result.ok, false);
  assert.match(result.error, /内核补丁失败/);
  assert.equal(session.phase, 'error');
  assert.ok(events.published.some(snapshot => snapshot.phase === 'error'));
});

test('异步 onBeforeLaunch 期间退出时不会再调用 spawn', async () => {
  let resume, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  let spawned = 0;
  const { session } = makeSession({
    child: stubChild(),
    hooks: { onBeforeLaunch: async () => { entered(); await paused; } }
  });
  session.spawnProcess = () => { spawned++; return stubChild(); };
  const launching = session.launch();
  await ready;
  await session.close('synthetic cancellation');
  resume();
  const result = await launching;
  assert.equal(result.ok, false);
  assert.match(result.error, /启动已取消/);
  assert.equal(spawned, 0);
  assert.equal(session.phase, 'idle');
});

test('没有 onBeforeLaunch 时启动照常进行', async () => {
  const { session } = makeSession({ child: stubChild() });
  const result = await session.launch();
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('AG 已在运行时拒绝启动，onBeforeLaunch 不会被调用', async () => {
  const child = stubChild();
  const { session } = makeSession({
    child,
    desktop: stubDesktop({ running: async () => true }),
    hooks: { onBeforeLaunch: async () => { throw new Error('不应被调用'); } }
  });
  const result = await session.launch();
  assert.equal(result.ok, false);
  assert.match(result.error, /请先退出已打开的 AG/);
});

test('启动被取消（并发 launch）时不会执行补丁钩子', async () => {
  const child = stubChild();
  let called = 0;
  const { session } = makeSession({
    child,
    hooks: { onBeforeLaunch: async () => { called += 1; } }
  });
  const first = session.launch();
  const second = await session.launch();
  assert.equal(second.ok, false);
  assert.match(second.error, /正在启动/);
  await first;
  assert.equal(called, 1, '只有真正推进到 launching 的那一次才跑钩子');
});

// onExit is the mirror of onStart: anything the launcher starts when AG comes up (today: the log
// watcher that catches the 400 the preflight cannot see) has to be torn down on every exit path, or
// it keeps tailing a dead process for the rest of the launcher's life.
function stubEvents() {
  return { published: [], logged: [], log(channel, message, tag) { this.logged.push({ channel, message, tag }); }, publish(snapshot) { this.published.push(snapshot); } };
}

test('AG 自己退出时 onExit 收尾钩子运行', async () => {
  const child = stubChild();
  let stopped = 0;
  const { session } = makeSession({
    child,
    hooks: { onExit: () => { stopped += 1; } }
  });
  await session.launch();
  child.emit('exit');
  // finish() is a short async chain; poll for it rather than guessing a delay.
  for (let i = 0; i < 50 && session.phase !== 'idle'; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(stopped, 1);
  assert.equal(session.phase, 'idle');
});

test('用户关闭 AG 或退出 Goagy 时 onExit 同样运行', async () => {
  let stopped = 0;
  const { session } = makeSession({
    child: stubChild(),
    hooks: { onExit: () => { stopped += 1; } }
  });
  await session.launch();
  await session.close('Goagy 退出');
  assert.equal(stopped, 1);
});

test('onExit 抛错不会阻塞关机，只留一条警告', async () => {
  const events = stubEvents();
  const { session } = makeSession({
    child: stubChild(),
    events,
    hooks: { onExit: () => { throw new Error('句柄占用中'); } }
  });
  await session.launch();
  const result = await session.close('Goagy 退出');
  assert.equal(result.ok, true, '收尾失败不能让关机卡住');
  assert.equal(session.phase, 'idle');
  const warning = events.logged.find(line => line.tag === 'tag-warn');
  assert.ok(warning, '失败必须留痕，否则没人知道守望其实没停下来');
  assert.match(warning.message, /句柄占用中/);
});
