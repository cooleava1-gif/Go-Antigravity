'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../features/mobile-access.js'), 'utf8');
const PUBLIC_URL = 'https://first-random-test.trycloudflare.com';
const FIXED_URL = 'https://mobile.example.test';
const LOCAL_URL = 'http://127.0.0.1:3082/';
const ready = { tunnelReady: true, mode: 'quick', publicUrl: PUBLIC_URL, local: LOCAL_URL };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fakeClock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const add = (fn, ms, interval) => {
    const timer = { id: ++nextId, at: now + ms, ms, fn, interval, unrefed: false,
      unref() { this.unrefed = true; return this; } };
    timers.set(timer.id, timer); return timer;
  };
  return {
    timers,
    setTimeout: (fn, ms) => add(fn, ms, false),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearTimeout: timer => timers.delete(timer?.id),
    clearInterval: timer => timers.delete(timer?.id),
    advance(ms) {
      const end = now + ms;
      for (let loops = 0; loops < 1000; loops++) {
        const timer = [...timers.values()].filter(item => item.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!timer) break;
        now = timer.at;
        if (timer.interval) timer.at += timer.ms; else timers.delete(timer.id);
        timer.fn();
      }
      now = end;
    },
  };
}
function child(pid) {
  const value = new EventEmitter();
  value.pid = pid; value.exitCode = null; value.signalCode = null;
  value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
  value.kill = () => { value.exit(0); return true; };
  value.exit = (code = 0) => { value.exitCode = code; value.emit('exit', code, null); };
  value.line = valueToWrite => value.stdout.emit('data', Buffer.from(JSON.stringify(valueToWrite) + '\n'));
  return value;
}
function harness(options = {}) {
  const clock = fakeClock();
  const h = { clock, calls: [], requests: [], published: [], logs: [], children: [], config: {}, launched: false,
    localOk: true, tunnelOk: true, external: false, cleanupCode: 0, cleanupThrows: false, ...options };
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, Buffer, AbortController, Promise,
    __dirname: path.resolve(__dirname, '../features'),
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    process: { platform: 'win32', execPath: 'fallback-node.exe', env: { KEEP: 'yes', GOAGY_POCKET_PIN: 'old-parent-pin', ...options.env },
      kill() { if (h.originAlive ?? h.launched) return true; throw Object.assign(Error('gone'), { code: 'ESRCH' }); } },
    require(name) {
      if (name === 'node:fs') return { existsSync: target => {
        (h.checkedFiles ||= []).push(target);
        return h.available !== false && (h.missingFile === undefined || !target.endsWith(h.missingFile));
      } };
      if (name === 'node:child_process') return { spawn() { throw Error('Unexpected real spawn'); } };
      if (name === 'node:net') return { createConnection() { throw Error('Unexpected real network'); } };
      return require(name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'mobile-access.js' });
  h.spawnProcess = (file, args, config) => {
    h.calls.push({ file, args, config });
    if (file === 'taskkill') {
      if (h.cleanupThrows) throw Error('raw credential 87654321');
      const killer = child(9000 + h.calls.length);
      queueMicrotask(() => {
        if (h.cleanupCode === 0) {
          const ownedChild = h.children.find(item => String(item.pid) === args[1]);
          ownedChild?.exit(0); h.launched = false;
        }
        killer.exit(h.cleanupCode);
      });
      return killer;
    }
    if (h.spawnThrows) throw Error('raw secret 87654321');
    h.launched = true;
    const spawned = child(4000 + h.children.length);
    spawned.initial = (overrides = {}) => spawned.line({ ready: true, local: LOCAL_URL,
      lan: 'http://192.0.2.10:3082/', pin: config.env.GOAGY_POCKET_PIN, pid: 5000 + h.children.length, ...overrides });
    spawned.final = (overrides = {}) => spawned.line({ ...ready, mode: config.env.GOAGY_POCKET_MODE,
      publicUrl: config.env.GOAGY_POCKET_MODE === 'fixed' ? config.env.GOAGY_POCKET_FIXED_URL : (h.publicUrl || PUBLIC_URL), ...overrides });
    spawned.ready = () => { spawned.initial(); spawned.final(); };
    h.children.push(spawned);
    return spawned;
  };
  h.fetchImpl = async (url, init) => {
    h.requests.push({ url, init });
    if (h.fetch) return await h.fetch(url, init, h);
    if (url === LOCAL_URL) {
      if (!h.launched && !h.external) throw Error('connection refused');
      return { ok: h.localOk, status: h.localOk ? 200 : 503 };
    }
    if (!h.launched && !h.external) throw Error('connection refused');
    return { ok: h.tunnelOk, status: h.tunnelOk ? 200 : 503 };
  };
  h.manager = module.exports.createMobileAccess({
    events: { publish: value => h.published.push(value), log: (...args) => h.logs.push(args) },
    settings: { get: () => h.config }, secrets: options.secrets, testMode: true,
    ...(options.projectDir ? { projectDir: options.projectDir } : {}),
    ...(options.noSpawner ? {} : { spawnProcess: h.spawnProcess }),
    ...(options.noFetch ? {} : { fetchImpl: h.fetchImpl }),
  });
  h.primaryCalls = () => h.calls.filter(call => call.file !== 'taskkill');
  h.killCalls = () => h.calls.filter(call => call.file === 'taskkill');
  h.run = async (input = {}) => {
    const promise = h.manager.start(input); await flush();
    h.children.at(-1)?.ready(); await flush();
    return await promise;
  };
  return h;
}

test('snapshot defaults to portable quick mode without a stale public URL or credential', async () => {
  const h = harness({ noSpawner: true, noFetch: true });
  assert.deepEqual(JSON.parse(JSON.stringify(h.manager.snapshot())), {
    state: 'stopped', mode: 'quick', fixedUrl: '', fixedConfigured: false, tunnelTokenConfigured: false, fixedAuth: null, publicUrl: null, startupPhase: null,
    localUrl: LOCAL_URL, pin: null, autoStart: false,
    managed: false, lastError: null, startedAt: null, available: true,
  });
  await h.manager.close();
});

test('invalid PIN values fail before process work and never appear in errors', async () => {
  const h = harness(); await flush();
  for (const pin of ['1234567', '123456789', 'abcdefgh', 12345678, '', null, '12345678\n', '12345678\r', '12345678\r\n']) {
    await assert.rejects(h.manager.start({ pin }), error => error.message === 'PIN 必须为 8 位数字。');
  }
  assert.equal(h.calls.length, 0); assert.equal(h.manager.snapshot().state, 'stopped');
  await h.manager.close();
});

test('test mode without injected spawner fails closed and never uses real spawn or fetch', async () => {
  const h = harness({ noSpawner: true, noFetch: true });
  const result = await h.manager.start();
  assert.equal(result.state, 'error'); assert.equal(result.managed, false);
  assert.equal(result.pin, null); assert.match(result.lastError, /测试模式/);
  await h.manager.close();
});

test('unavailable project does not spawn', async () => {
  const h = harness({ available: false });
  const result = await h.manager.start();
  assert.equal(result.available, false); assert.equal(result.state, 'error');
  assert.equal(h.calls.length, 0); await h.manager.close();
});

test('spawns current Node and portable tunnel with isolated environment and snapshot', async () => {
  const h = harness(); const result = await h.run({ pin: '01234567' });
  assert.equal(result.state, 'running'); assert.equal(result.pin, '01234567');
  assert.equal(result.managed, true); assert.equal(typeof result.startedAt, 'number');
  const call = h.primaryCalls()[0];
  assert.equal(call.file, 'fallback-node.exe');
  assert.equal(JSON.stringify(call.args), JSON.stringify(['tunnel.mjs']));
  assert.equal(call.config.env.GOAGY_POCKET_MODE, 'quick');
  assert.equal(call.config.env.GOAGY_POCKET_FIXED_URL, '');
  assert.equal(result.mode, 'quick'); assert.equal(result.publicUrl, PUBLIC_URL);
  assert.equal(call.config.env.GOAGY_POCKET_PIN, '01234567'); assert.equal(call.config.env.KEEP, 'yes');
  assert.equal(call.config.cwd, path.resolve(__dirname, '../mobile'));
  assert.ok(h.checkedFiles.every(file => ['tunnel.mjs', 'server.mjs'].includes(path.basename(file))));
  assert.equal(call.config.windowsHide, true);
  assert.equal(JSON.stringify(call.config.stdio), JSON.stringify(['ignore', 'pipe', 'pipe']));
  assert.ok(h.published.some(value => value.mobile.state === 'running'));
  await h.manager.close();
});

test('uses process.execPath without a bundled runtime and generates eight digits', async () => {
  const h = harness(); const result = await h.run();
  assert.match(result.pin, /^\d{8}$/); assert.equal(h.primaryCalls()[0].file, 'fallback-node.exe');
  assert.equal(h.primaryCalls()[0].config.env.GOAGY_POCKET_PIN, result.pin); await h.manager.close();
});

test('concurrent and repeated starts share one child and keep its original PIN', async () => {
  const h = harness(); const a = h.manager.start({ pin: '12345678' });
  const b = h.manager.start({ pin: '87654321' });
  assert.equal(a, b); await flush(); assert.equal(h.primaryCalls().length, 1);
  h.children[0].ready(); const [one, two] = await Promise.all([a, b]);
  assert.equal(one.pin, '12345678'); assert.equal(two.pin, one.pin);
  assert.equal((await h.manager.start()).pin, one.pin); assert.equal(h.primaryCalls().length, 1);
  await h.manager.close();
});

test('only initial identity then exact tunnel readiness and both health checks can run', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  const spawned = h.children[0];
  spawned.line(ready); await flush(); // Final readiness alone is insufficient.
  assert.equal(h.manager.snapshot().state, 'starting');
  spawned.initial();
  spawned.stdout.emit('data', Buffer.from('not JSON\n')); await flush();
  assert.equal(h.manager.snapshot().state, 'starting');
  const text = JSON.stringify(ready) + '\n';
  spawned.stdout.emit('data', Buffer.from(text.slice(0, 19))); await flush();
  assert.equal(h.manager.snapshot().state, 'starting');
  spawned.stdout.emit('data', Buffer.from(text.slice(19))); await flush();
  assert.equal((await pending).state, 'running');
  assert.ok(h.requests.some(value => value.url === 'http://127.0.0.1:20382/ready'));
  assert.ok(h.requests.every(value => value.init.method === 'HEAD' && !value.url.includes('token=')));
  await h.manager.close();
});

test('unexpected quick URL fails and cleans up only the owned PID', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  h.children[0].initial(); h.children[0].line({ ...ready, publicUrl: 'https://untrusted.example/87654321' });
  const result = await pending;
  assert.equal(result.state, 'error'); assert.equal(result.pin, null); assert.equal(result.managed, false);
  assert.equal(h.killCalls().length, 1);
  assert.equal(JSON.stringify(h.killCalls()[0].args), JSON.stringify(['/PID', '4000', '/T', '/F']));
  assert.doesNotMatch(result.lastError, /87654321|untrusted/); await h.manager.close();
});

test('initial server identity rejects a wrong URL, wrong PIN, or invalid PID without exposing details', async () => {
  for (const overrides of [{ local: 'http://127.0.0.1:3083/' }, { pin: '87654321' },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '5000', null].map(pid => ({ pid }))]) {
    const h = harness(); const pending = h.manager.start({ pin: '11112222' }); await flush();
    h.children[0].initial(overrides); h.children[0].line(ready);
    const result = await pending;
    assert.equal(result.state, 'error'); assert.equal(result.pin, null); assert.equal(result.managed, false);
    assert.equal(h.killCalls().length, 1); assert.doesNotMatch(result.lastError, /87654321|3083/);
    await h.manager.close();
  }
});

test('exit while startup health is pending cannot report running', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  const gate = deferred(); h.fetch = () => gate.promise; h.children[0].ready(); await flush();
  h.children[0].exit(1); h.fetch = null; h.launched = false; gate.resolve({ ok: true, status: 200 });
  const result = await pending;
  assert.equal(result.state, 'error'); assert.equal(result.managed, false);
  assert.equal(h.killCalls().length, 0); assert.equal(h.published.some(value => value.mobile.state === 'running'), false);
  await h.manager.close();
});

test('startup health cannot publish stale final URL after recovery begins before running', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  const spawned = h.children[0], gate = deferred(); spawned.initial();
  h.fetch = () => gate.promise; spawned.final({ publicUrl: 'https://first-startup.trycloudflare.com' }); await flush();
  spawned.line({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL });
  spawned.final({ publicUrl: 'https://replacement-startup.trycloudflare.com' }); await flush();
  assert.equal(h.manager.snapshot().publicUrl, null); assert.equal(h.manager.snapshot().state, 'degraded');
  h.fetch = null; gate.resolve({ ok: true, status: 200 }); await pending; await flush();
  assert.equal(h.manager.snapshot().state, 'running');
  assert.equal(h.manager.snapshot().publicUrl, 'https://replacement-startup.trycloudflare.com');
  assert.equal(h.published.some(v => v.mobile.publicUrl === 'https://first-startup.trycloudflare.com'), false);
  assert.equal(h.primaryCalls().length, 1); await h.manager.close();
});
test('coalesced initial final and recovery lines retain a chunked replacement through launch completion', async () => {
  const h = harness(); const pending = h.manager.start(); await flush(); const spawned = h.children[0]; spawned.initial();
  const replacement = JSON.stringify({ ...ready, publicUrl: 'https://coalesced-new.trycloudflare.com' }) + '\n';
  spawned.stdout.emit('data', Buffer.from(JSON.stringify({ ...ready, publicUrl: 'https://coalesced-old.trycloudflare.com' }) + '\n' +
    JSON.stringify({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL }) + '\n' + replacement.slice(0, 31)));
  await pending; assert.equal(h.manager.snapshot().state, 'degraded'); assert.equal(h.manager.snapshot().publicUrl, null);
  spawned.stdout.emit('data', Buffer.from(replacement.slice(31))); await flush();
  assert.equal(h.manager.snapshot().state, 'running'); assert.equal(h.manager.snapshot().publicUrl, 'https://coalesced-new.trycloudflare.com');
  assert.equal(h.published.some(v => v.mobile.publicUrl === 'https://coalesced-old.trycloudflare.com'), false); await h.manager.close();
});
test('terminal runtime error during startup health cannot be overwritten by a late healthy result', async () => {
  const h = harness(); const pending = h.manager.start(); await flush(); const spawned = h.children[0], gate = deferred();
  h.fetch = () => gate.promise; spawned.ready(); await flush();
  spawned.line({ error: 'TUNNEL_RECOVERY_EXHAUSTED' }); h.fetch = null; gate.resolve({ ok: true, status: 200 });
  assert.equal((await pending).state, 'error');
  assert.equal(h.published.some(v => v.mobile.state === 'running'), false); await h.manager.close();
});

test('handled wrapper exit releases ownership after listeners and known origin disappear, allowing retry', async () => {
  const h = harness(); await h.run(); h.launched = false; h.children[0].exit(1); await flush();
  assert.equal(h.manager.snapshot().state, 'error'); assert.equal(h.manager.snapshot().managed, false);
  assert.equal(h.killCalls().length, 0); assert.equal((await h.run()).state, 'running');
  await h.manager.close(); assert.equal(h.killCalls().length, 1);
});

test('unexpected wrapper exit keeps ownership if a listener or its known origin remains', async () => {
  for (const keepOrigin of [false, true]) {
    const h = harness(); await h.run(); h.originAlive = keepOrigin;
    h.launched = !keepOrigin; h.children[0].exit(1); await flush();
    assert.equal(h.manager.snapshot().state, 'error'); assert.equal(h.manager.snapshot().managed, true);
    assert.equal(h.killCalls().length, 0); await h.manager.start(); assert.equal(h.primaryCalls().length, 1);
    h.launched = false; h.originAlive = false;
    assert.equal((await h.manager.stop()).state, 'stopped'); await h.manager.close();
  }
});

test('external listener is detected asynchronously and is never adopted or killed', async () => {
  const h = harness({ external: true }); await flush();
  assert.equal(h.manager.snapshot().state, 'external'); assert.equal(h.manager.snapshot().managed, false);
  assert.equal((await h.manager.start()).state, 'external');
  await h.manager.stop(); await h.manager.close();
  assert.equal(h.calls.length, 0); assert.equal(h.manager.snapshot().pin, null);
});

test('external status polls every five seconds and recovers once the listener disappears', async () => {
  const h = harness({ external: true }); await flush();
  const timer = [...h.clock.timers.values()].find(item => item.interval);
  assert.equal(timer.ms, 5000); assert.equal(timer.unrefed, true);
  h.external = false; h.clock.advance(5000); await flush();
  assert.equal(h.manager.snapshot().state, 'stopped'); assert.equal(h.calls.length, 0);
  assert.equal(h.clock.timers.size, 0); assert.equal((await h.run()).state, 'running');
  await h.manager.close();
});

test('late external poll cannot overwrite a new launch and close cancels external polling', async () => {
  const h = harness({ external: true }); await flush();
  const gate = deferred(); h.fetch = () => gate.promise; h.clock.advance(5000); await flush();
  h.external = false; h.fetch = null; const pending = h.manager.start(); await flush();
  gate.resolve(null); await flush(); assert.equal(h.manager.snapshot().state, 'starting');
  h.children[0].ready(); assert.equal((await pending).state, 'running'); await h.manager.close();
  const external = harness({ external: true }); await flush();
  external.fetch = () => new Promise(() => {}); external.clock.advance(5000); await flush();
  await external.manager.close(); assert.equal(external.clock.timers.size, 0); assert.equal(external.calls.length, 0);
});

test('startup timeout covers the supervisor 120-second budget plus cleanup margin', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  const timer = [...h.clock.timers.values()].find(item => item.ms === 125000);
  assert.ok(timer); assert.equal(timer.unrefed, true);
  h.clock.advance(125000); await flush();
  const result = await pending;
  assert.equal(result.state, 'error'); assert.match(result.lastError, /启动超时/);
  assert.equal(result.managed, false); assert.equal(h.killCalls().length, 1);
  assert.equal(h.clock.timers.size, 0); await h.manager.close();
});

test('unhealthy startup and spawn errors use fixed safe errors and clean up', async () => {
  const h = harness({ tunnelOk: false }); const result = await h.run({ pin: '87654321' });
  assert.equal(result.state, 'error'); assert.equal(result.managed, false); assert.equal(h.killCalls().length, 1);
  assert.match(result.lastError, /健康检查失败/); await h.manager.close();
  const broken = harness({ spawnThrows: true }); const error = await broken.manager.start({ pin: '87654321' });
  assert.equal(error.state, 'error'); assert.doesNotMatch(error.lastError, /87654321|secret/);
  await broken.manager.close();
});

test('child error during startup is sanitized and kills its owned tree', async () => {
  const h = harness(); const pending = h.manager.start({ pin: '87654321' }); await flush();
  h.children[0].emit('error', Error('credential 87654321')); const result = await pending;
  assert.equal(result.state, 'error'); assert.doesNotMatch(result.lastError, /87654321|credential/);
  assert.equal(h.killCalls().length, 1); await h.manager.close();
});

test('stop cancels preflight before spawning and suppresses a late external result', async () => {
  const gate = deferred(); const h = harness({ fetch: () => gate.promise });
  const pending = h.manager.start(); await flush();
  const stopped = h.manager.stop('user'); await flush();
  gate.resolve({ ok: true, status: 200 });
  assert.equal((await stopped).state, 'stopped'); assert.ok(['stopping', 'stopped'].includes((await pending).state));
  assert.equal(h.calls.length, 0); await flush(); assert.equal(h.manager.snapshot().state, 'stopped');
  await h.manager.close();
});

test('concurrent stops cancel startup, perform one tree cleanup, and ignore late ready data', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  const first = h.manager.stop(); const second = h.manager.stop(); assert.equal(first, second);
  h.children[0].ready(); const result = await first; await pending; await flush();
  assert.equal(result.state, 'stopped'); assert.equal(h.manager.snapshot().pin, null);
  assert.equal(h.killCalls().length, 1); assert.equal(h.clock.timers.size, 0);
  await h.manager.close(); assert.equal(h.killCalls().length, 1);
});

test('start during stop waits for cleanup and starts exactly one replacement', async () => {
  const h = harness(); await h.run();
  const stopped = h.manager.stop(); const restarted = h.manager.start({ pin: '22223333' });
  const joined = h.manager.start({ pin: '33334444' });
  await stopped; await flush(); assert.equal(h.primaryCalls().length, 2);
  h.children[1].ready(); assert.equal((await restarted).pin, '22223333');
  assert.equal((await joined).state, 'running'); assert.equal((await joined).pin, '22223333');
  assert.equal(h.killCalls().length, 1); await h.manager.close(); assert.equal(h.killCalls().length, 2);
});

test('failed owned cleanup retains ownership for retry instead of spawning another tree', async () => {
  const h = harness(); await h.run(); h.cleanupCode = 1;
  const failed = await h.manager.stop();
  assert.equal(failed.state, 'error'); assert.equal(failed.managed, true); assert.equal(failed.pin, null);
  await h.manager.start(); assert.equal(h.primaryCalls().length, 1);
  h.cleanupCode = 0; const retried = await h.manager.stop();
  assert.equal(retried.state, 'stopped'); assert.equal(retried.managed, false); assert.equal(h.killCalls().length, 2);
  await h.manager.close();
});

test('health monitoring runs every five seconds, degrades, and recovers', async () => {
  const h = harness(); await h.run();
  const timer = [...h.clock.timers.values()].find(item => item.interval);
  assert.equal(timer.ms, 5000); assert.equal(timer.unrefed, true);
  h.tunnelOk = false; h.clock.advance(5000); await flush();
  assert.equal(h.manager.snapshot().state, 'degraded'); assert.match(h.manager.snapshot().lastError, /健康检查失败/);
  h.tunnelOk = true; h.clock.advance(5000); await flush();
  assert.equal(h.manager.snapshot().state, 'running'); assert.equal(h.manager.snapshot().lastError, null);
  await h.manager.close(); assert.equal(h.clock.timers.size, 0);
});

test('late healthy probe after stop cannot revive the stopped instance or publish running', async () => {
  const h = harness(); await h.run(); const gate = deferred(); h.fetch = () => gate.promise;
  h.clock.advance(5000); await flush(); await h.manager.stop();
  const count = h.published.length; gate.resolve({ ok: true, status: 200 }); await flush();
  assert.equal(h.manager.snapshot().state, 'stopped'); assert.equal(h.published.length, count);
  await h.manager.close();
});

test('raw output and child PIN are never logged or copied into snapshot/error events', async () => {
  const h = harness(); const pending = h.manager.start({ pin: '11112222' }); await flush();
  const spawned = h.children[0];
  spawned.line({ ignored: true, pin: '87654321', credentials: 'super-secret' });
  spawned.stderr.emit('data', Buffer.from('password=87654321 super-secret\n'));
  spawned.stdout.emit('data', Buffer.from('x'.repeat(9000) + '\n'));
  spawned.ready(); await pending; await h.manager.close();
  assert.doesNotMatch(JSON.stringify(h.logs), /11112222|87654321|super-secret|password/);
  assert.doesNotMatch(JSON.stringify(h.published), /87654321|super-secret|password/);
  assert.equal(h.manager.snapshot().pin, null);
});

test('AG automatic lifecycle honors default off and stops only its own autostarted instance', async () => {
  const h = harness(); await h.manager.onAgStart(); assert.equal(h.calls.length, 0);
  h.config.mobileAutoStart = true; const pending = h.manager.onAgStart(); await flush();
  h.children[0].ready(); assert.equal((await pending).autoStart, true);
  assert.equal((await h.manager.onAgExit()).state, 'stopped'); assert.equal(h.killCalls().length, 1);
  await h.run(); await h.manager.onAgStart();
  assert.equal((await h.manager.onAgExit()).state, 'running'); assert.equal(h.killCalls().length, 1);
  await h.manager.close(); assert.equal(h.killCalls().length, 2);
});

test('manual start claims an autostarted instance and AG exit preserves it', async () => {
  const h = harness(); h.config.mobileAutoStart = true;
  const pending = h.manager.onAgStart(); await flush(); h.children[0].ready(); await pending;
  await h.manager.start(); assert.equal((await h.manager.onAgExit()).state, 'running');
  await h.manager.close(); assert.equal(h.killCalls().length, 1);
});

test('automatic start catches failures; close cancels startup and permanently prevents restart', async () => {
  const h = harness({ spawnThrows: true }); h.config.mobileAutoStart = true;
  assert.equal((await h.manager.onAgStart()).state, 'error'); await h.manager.close();
  const running = harness(); const pending = running.manager.start(); await flush();
  assert.equal((await running.manager.close()).state, 'stopped'); await pending;
  assert.equal((await running.manager.start()).state, 'stopped');
  running.config.mobileAutoStart = true; await running.manager.onAgStart();
  assert.equal(running.primaryCalls().length, 1); assert.equal(running.killCalls().length, 1);
});

test('portable project and Node overrides pass through only the expected child environment', async () => {
  const h = harness({ env: { GOAGY_POCKET_PROJECT: 'D:/portable/mobile', GOAGY_POCKET_NODE: 'D:/runtime/node.exe',
    GOAGY_POCKET_CF_CONFIG: 'D:/private/config.yml', GOAGY_POCKET_MODE: 'fixed' } });
  const result = await h.run(); const call = h.primaryCalls()[0];
  assert.equal(call.file, 'D:/runtime/node.exe'); assert.equal(call.config.cwd, 'D:/portable/mobile');
  assert.equal(call.config.env.GOAGY_POCKET_MODE, 'quick');
  assert.equal(call.config.env.GOAGY_POCKET_CF_CONFIG, undefined);
  assert.equal(result.mode, 'quick');
  assert.doesNotMatch(JSON.stringify(h.published) + JSON.stringify(h.logs), /private|config\.yml/);
  assert.ok(h.checkedFiles.every(file => ['tunnel.mjs', 'server.mjs'].includes(path.basename(file))));
  await h.manager.close();
  const explicit = harness({ projectDir: 'D:/explicit/mobile', env: { GOAGY_POCKET_PROJECT: 'D:/ignored/mobile' } });
  await explicit.run(); assert.equal(explicit.primaryCalls()[0].config.cwd, 'D:/explicit/mobile');
  await explicit.manager.close();
});

test('availability checks runtime entry files without requiring cloudflared to exist first', async () => {
  for (const missingFile of ['tunnel.mjs', 'server.mjs']) {
    const h = harness({ missingFile }); const result = await h.manager.start();
    assert.equal(result.available, false); assert.equal(result.state, 'error'); assert.equal(h.calls.length, 0);
    await h.manager.close();
  }
  const h = harness({ missingFile: 'cloudflared.exe' });
  const pending = h.manager.start(); await flush(); assert.equal(h.manager.snapshot().available, true);
  h.children[0].line({ error: 'CLOUDFLARED_NOT_FOUND', raw: 'credential=87654321' });
  const result = await pending;
  assert.equal(result.state, 'error'); assert.match(result.lastError, /cloudflared/);
  assert.equal(result.publicUrl, null); assert.equal(h.killCalls().length, 1);
  assert.doesNotMatch(JSON.stringify(h.published) + JSON.stringify(h.logs), /credential|87654321/);
  await h.manager.close();
});

test('explicit fixed mode normalizes an HTTPS origin and only publishes the healthy active URL', async () => {
  const h = harness({ config: { mobileMode: 'fixed', mobileFixedUrl: FIXED_URL + '/' } });
  const stopped = h.manager.snapshot();
  assert.equal(stopped.mode, 'fixed'); assert.equal(stopped.fixedUrl, FIXED_URL);
  assert.equal(stopped.fixedConfigured, true); assert.equal(stopped.publicUrl, null);
  const pending = h.manager.start(); await flush();
  const call = h.primaryCalls()[0];
  assert.equal(call.config.env.GOAGY_POCKET_MODE, 'fixed'); assert.equal(call.config.env.GOAGY_POCKET_FIXED_URL, FIXED_URL);
  assert.equal(h.manager.snapshot().publicUrl, null);
  h.children[0].ready(); const running = await pending;
  assert.equal(running.state, 'running'); assert.equal(running.publicUrl, FIXED_URL);
  const stoppedAgain = await h.manager.stop(); assert.equal(stoppedAgain.publicUrl, null);
  assert.equal(stoppedAgain.fixedUrl, FIXED_URL); await h.manager.close();
});

test('fixed URL defaults only from explicit environment or settings with settings taking precedence', async () => {
  const env = { GOAGY_POCKET_FIXED_URL: FIXED_URL };
  const fallback = harness({ env, config: { mobileMode: 'fixed' } });
  assert.equal((await fallback.run()).publicUrl, FIXED_URL); await fallback.manager.close();
  const explicit = harness({ env, config: { mobileMode: 'fixed', mobileFixedUrl: 'https://other.example.test:8443' } });
  assert.equal((await explicit.run()).publicUrl, 'https://other.example.test:8443'); await explicit.manager.close();
  const empty = harness({ env, config: { mobileMode: 'fixed', mobileFixedUrl: '' } });
  assert.equal((await empty.manager.start()).state, 'error'); assert.equal(empty.calls.length, 0);
  assert.equal(empty.manager.snapshot().fixedConfigured, false); await empty.manager.close();
});

test('invalid transport configuration fails before any child spawn and hides untrusted values', async () => {
  const cases = [
    { mobileMode: 'unexpected-87654321' }, { mobileMode: 'fixed' }, { mobileMode: '' },
    ...['http://mobile.example.test', 'https://mobile.example.test/path', 'https://mobile.example.test?token=87654321',
      'https://mobile.example.test#secret', 'https://user:87654321@mobile.example.test',
      'https://mobile.example.test/..', 'https://mobile.example.test\n', 'javascript:87654321', {}, 123].map(mobileFixedUrl => ({ mobileMode: 'fixed', mobileFixedUrl })),
  ];
  for (const config of cases) {
    const h = harness({ config }); const result = await h.manager.start();
    assert.equal(result.state, 'error', JSON.stringify(config)); assert.equal(h.calls.length, 0);
    assert.equal(result.publicUrl, null); assert.equal(result.pin, null);
    assert.doesNotMatch(JSON.stringify(h.published) + JSON.stringify(h.logs), /87654321|javascript|token|unexpected/);
    await h.manager.close();
  }
});

test('quick mode accepts random exact trycloudflare origins and rejects injected or deceptive URLs', async () => {
  for (const publicUrl of ['https://one.trycloudflare.com', 'https://random-123-test.trycloudflare.com']) {
    const h = harness({ publicUrl }); const result = await h.run();
    assert.equal(result.state, 'running'); assert.equal(result.publicUrl, publicUrl); await h.manager.close();
  }
  for (const publicUrl of [undefined, null, {}, 123, '', 'http://one.trycloudflare.com',
    'https://one.trycloudflare.com/', 'https://one.trycloudflare.com:443', 'https://one.trycloudflare.com:8443',
    'https://one.trycloudflare.com/path', 'https://one.trycloudflare.com?pin=87654321',
    'https://one.trycloudflare.com#87654321', 'https://user:87654321@one.trycloudflare.com',
    'https://one.trycloudflare.com.evil.test', 'https://one.trycloudflare.com@evil.test',
    'https://evil.test/https://one.trycloudflare.com', 'https://one.two.trycloudflare.com',
    'https://UPPER.trycloudflare.com', 'https://one.trycloudflare.com\n', 'https://one.trycloudflare.com\r\n',
    ' https://one.trycloudflare.com', 'https://one.trycloudflare.com ', 'https://one.trycloudflare.com\u0000']) {
    const h = harness(); const pending = h.manager.start(); await flush();
    h.children[0].initial(); h.children[0].final({ publicUrl }); const result = await pending;
    assert.equal(result.state, 'error', JSON.stringify(publicUrl)); assert.equal(result.publicUrl, null);
    assert.equal(result.pin, null); assert.equal(h.killCalls().length, 1);
    assert.doesNotMatch(JSON.stringify(h.published) + JSON.stringify(h.logs), /87654321|evil\.test|UPPER/);
    await h.manager.close();
  }
});

test('fixed mode rejects every final URL except its configured exact origin', async () => {
  for (const publicUrl of [PUBLIC_URL, FIXED_URL + '/', FIXED_URL + '/path', FIXED_URL + '?pin=87654321',
    FIXED_URL + '.evil.test', 'https://user:87654321@mobile.example.test']) {
    const h = harness({ config: { mobileMode: 'fixed', mobileFixedUrl: FIXED_URL } });
    const pending = h.manager.start(); await flush(); h.children[0].initial(); h.children[0].final({ publicUrl });
    const result = await pending; assert.equal(result.state, 'error'); assert.equal(result.publicUrl, null);
    assert.equal(h.killCalls().length, 1); assert.doesNotMatch(result.lastError, /87654321|evil/);
    await h.manager.close();
  }
});

test('final readiness requires exact mode and local address even with a valid public URL', async () => {
  for (const overrides of [{ mode: undefined }, { mode: 'fixed' }, { local: 'http://127.0.0.1:3083/' }]) {
    const h = harness(); const pending = h.manager.start(); await flush();
    h.children[0].initial(); h.children[0].final(overrides); const result = await pending;
    assert.equal(result.state, 'error'); assert.equal(result.publicUrl, null); await h.manager.close();
  }
});

test('a new run clears its previous random URL and ignores stale output from earlier children', async () => {
  const h = harness(); assert.equal((await h.run()).publicUrl, PUBLIC_URL);
  const old = h.children[0]; assert.equal((await h.manager.stop()).publicUrl, null);
  const pending = h.manager.start(); await flush(); assert.equal(h.manager.snapshot().publicUrl, null);
  old.ready(); await flush(); assert.equal(h.manager.snapshot().state, 'starting');
  const nextUrl = 'https://second-random-test.trycloudflare.com';
  h.children[1].initial(); h.children[1].final({ publicUrl: nextUrl });
  assert.equal((await pending).publicUrl, nextUrl);
  h.children[1].exit(1); await flush(); assert.equal(h.manager.snapshot().publicUrl, null);
  h.launched = false; await h.manager.stop(); await h.manager.close();
});

test('per-run configuration is captured before asynchronous preflight and cannot be switched underneath readiness', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  h.config.mobileMode = 'fixed'; h.config.mobileFixedUrl = FIXED_URL;
  assert.equal(h.manager.snapshot().mode, 'quick'); assert.equal(h.manager.snapshot().fixedUrl, '');
  h.children[0].ready(); const result = await pending;
  assert.equal(result.mode, 'quick'); assert.equal(result.publicUrl, PUBLIC_URL);
  assert.equal(h.primaryCalls()[0].config.env.GOAGY_POCKET_MODE, 'quick');
  await h.manager.stop(); assert.equal(h.manager.snapshot().mode, 'fixed');
  assert.equal((await h.run()).publicUrl, FIXED_URL); await h.manager.close();
});

test('configuration guard rejects starting running degraded cleanup-retained and external states with 409', async () => {
  const isConflict = error => error.code === 'MOBILE_CONFIG_LOCKED' && error.status === 409;
  const h = harness(); assert.doesNotThrow(() => h.manager.assertConfigMutable());
  const pending = h.manager.start(); assert.throws(() => h.manager.assertConfigMutable(), isConflict);
  await flush(); h.children[0].ready(); await pending; assert.throws(() => h.manager.assertConfigMutable(), isConflict);
  h.tunnelOk = false; h.clock.advance(5000); await flush();
  assert.throws(() => h.manager.assertConfigMutable(), isConflict);
  h.cleanupCode = 1; const stopping = h.manager.stop();
  assert.throws(() => h.manager.assertConfigMutable(), isConflict); await stopping;
  assert.throws(() => h.manager.assertConfigMutable(), isConflict);
  h.cleanupCode = 0; await h.manager.stop(); assert.doesNotThrow(() => h.manager.assertConfigMutable());
  await h.manager.close();
  const external = harness({ external: true }); await flush();
  assert.throws(() => external.manager.assertConfigMutable(), isConflict); await external.manager.close();
});

test('runtime error protocol maps only canned text and never returns child-provided error details', async () => {
  for (const error of ['FIXED_CONFIG_REQUIRED', 'TUNNEL_START_FAILED', 'INVALID_MODE', 'INVALID_FIXED_URL',
    'INVALID_CONFIG_PATH', 'SERVER_START_FAILED', 'TUNNEL_EXITED', 'SERVER_EXITED',
    'raw credential 87654321', '__proto__', {}, null]) {
    const h = harness(); const pending = h.manager.start({ pin: '11112222' }); await flush();
    h.children[0].line({ error, credentials: 'super-secret-87654321' }); const result = await pending;
    assert.equal(result.state, 'error'); assert.equal(result.pin, null); assert.equal(result.publicUrl, null);
    assert.equal(h.killCalls().length, 1);
    assert.doesNotMatch(JSON.stringify(h.published) + JSON.stringify(h.logs), /87654321|credential|super-secret|__proto__/);
    await h.manager.close();
  }
});

test('oversized protocol lines are discarded as a whole and never establish readiness', async () => {
  const h = harness(); const pending = h.manager.start(); await flush(); const spawned = h.children[0];
  spawned.initial();
  const oversized = JSON.stringify({ ...ready, ignored: 'x'.repeat(8192) });
  spawned.stdout.emit('data', Buffer.from(oversized.slice(0, 4000)));
  spawned.stdout.emit('data', Buffer.from(oversized.slice(4000) + '\n'));
  await flush(); assert.equal(h.manager.snapshot().state, 'starting');
  spawned.final(); assert.equal((await pending).state, 'running'); await h.manager.close();
});

test('a safe missing-cloudflared runtime error remains friendly when the wrapper immediately exits', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  h.children[0].line({ error: 'CLOUDFLARED_NOT_FOUND' }); h.launched = false; h.children[0].exit(1);
  const result = await pending; assert.equal(result.state, 'error'); assert.match(result.lastError, /cloudflared/);
  assert.equal(result.managed, false); assert.equal(h.killCalls().length, 0); await h.manager.close();
});

test('a slow successful supervisor is not killed by the former 70-second deadline', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  h.children[0].initial(); h.clock.advance(71000); await flush();
  assert.equal(h.manager.snapshot().state, 'starting');
  h.children[0].final(); assert.equal((await pending).state, 'running');
  assert.equal(h.killCalls().length, 0); await h.manager.close();
});

test('startup phases are sanitized and recovered URL handoff preserves PIN and origin', async () => {
  const h = harness(); const pending = h.manager.start({ pin: '11112222' }); await flush();
  const spawned = h.children[0];
  spawned.line({ phase: 'public', mode: 'quick', local: LOCAL_URL, secret: 'private' });
  assert.equal(h.manager.snapshot().startupPhase, 'public');
  spawned.ready(); await pending;
  spawned.line({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL }); await flush();
  assert.equal(h.manager.snapshot().state, 'degraded'); assert.equal(h.manager.snapshot().publicUrl, null);
  assert.equal(h.manager.snapshot().pin, '11112222'); assert.equal(h.manager.snapshot().startupPhase, 'recovering');
  h.clock.advance(5000); await flush(); assert.equal(h.manager.snapshot().state, 'degraded');
  spawned.final({ publicUrl: 'https://recovered.trycloudflare.com' }); await flush();
  assert.equal(h.manager.snapshot().state, 'running'); assert.equal(h.manager.snapshot().startupPhase, null);
  assert.equal(h.manager.snapshot().publicUrl, 'https://recovered.trycloudflare.com');
  assert.equal(h.primaryCalls().length, 1); assert.equal(h.killCalls().length, 0);
  assert.doesNotMatch(JSON.stringify(h.logs), /11112222|private/); await h.manager.close();
});
test('transient local recovery verification retries without reviving stale URL or spawning', async () => {
  const h = harness(); await h.run(); const spawned = h.children[0];
  spawned.line({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL });
  h.localOk = false; spawned.final({ publicUrl: 'https://new-ready.trycloudflare.com' }); await flush();
  assert.equal(h.manager.snapshot().state, 'degraded'); assert.equal(h.manager.snapshot().publicUrl, null);
  h.localOk = true; h.clock.advance(5000); await flush();
  assert.equal(h.manager.snapshot().state, 'running'); assert.equal(h.manager.snapshot().publicUrl, 'https://new-ready.trycloudflare.com');
  assert.equal(h.primaryCalls().length, 1); await h.manager.close();
});
test('Stop during recovered readiness validation ignores a late probe and stale child protocol', async () => {
  const h = harness(); await h.run(); const spawned = h.children[0], gate = deferred();
  spawned.line({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL });
  h.fetch = () => gate.promise; spawned.final({ publicUrl: 'https://late.trycloudflare.com' }); await flush();
  await h.manager.stop(); gate.resolve({ ok: true, status: 200 }); spawned.final(); await flush();
  assert.equal(h.manager.snapshot().state, 'stopped'); assert.equal(h.manager.snapshot().publicUrl, null);
  assert.equal(h.manager.snapshot().pin, null); assert.equal(h.primaryCalls().length, 1); await h.manager.close();
});
test('late handoff and monitor probes cannot publish an earlier recovery generation', async () => {
  const h = harness(); await h.run(); const spawned = h.children[0];
  const recovery = () => spawned.line({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL });
  const oldProbe = deferred(); recovery(); h.fetch = () => oldProbe.promise;
  spawned.final({ publicUrl: 'https://old-generation.trycloudflare.com' }); await flush();
  h.clock.advance(5000); await flush(); recovery();
  h.fetch = null; h.localOk = false;
  spawned.final({ publicUrl: 'https://latest-generation.trycloudflare.com' }); await flush();
  oldProbe.resolve({ ok: true, status: 200 }); await flush();
  assert.equal(h.manager.snapshot().state, 'degraded'); assert.equal(h.manager.snapshot().publicUrl, null);
  assert.equal(h.published.some(v => v.mobile.publicUrl === 'https://old-generation.trycloudflare.com'), false);
  h.localOk = true; h.clock.advance(5000); await flush();
  assert.equal(h.manager.snapshot().publicUrl, 'https://latest-generation.trycloudflare.com');
  await h.manager.close();
});
test('recovery handoff verification has a bounded deadline when the local service remains unhealthy', async () => {
  const h = harness(); await h.run(); const spawned = h.children[0];
  spawned.line({ tunnelStatus: 'recovering', mode: 'quick', local: LOCAL_URL });
  h.localOk = false; spawned.final({ publicUrl: 'https://unhealthy.trycloudflare.com' }); await flush();
  h.clock.advance(95000); await flush();
  assert.equal(h.manager.snapshot().state, 'error'); assert.equal(h.manager.snapshot().pin, null);
  assert.equal(h.manager.snapshot().publicUrl, null); assert.match(h.manager.snapshot().lastError, /恢复验证超时/);
  assert.equal(h.primaryCalls().length, 1); await h.manager.close();
});

test('terminal recovery budget failure clears URL and PIN with a canned actionable error', async () => {
  const h = harness(); await h.run();
  h.children[0].line({ error: 'TUNNEL_RECOVERY_EXHAUSTED', detail: 'private 87654321' }); await flush();
  assert.equal(h.manager.snapshot().state, 'error'); assert.equal(h.manager.snapshot().publicUrl, null);
  assert.equal(h.manager.snapshot().pin, null); assert.match(h.manager.snapshot().lastError, /恢复次数/);
  assert.doesNotMatch(JSON.stringify(h.published), /87654321|private/); await h.manager.close();
});

test('stored named token wins external config and remains absent from argv snapshots events and quick environment', async () => {
  const secret = 'synthetic-cloudflare-token-12345';
  const secrets = { status: () => ({ configured: true, available: true }), token: () => secret };
  const env = { TUNNEL_TOKEN: 'inherited-token', GOAGY_POCKET_CF_CONFIG: 'D:/private/config.yml', CF_TUNNEL_TOKEN: 'other-token' };
  const h = harness({ secrets, env, config: { mobileMode: 'fixed', mobileFixedUrl: FIXED_URL } });
  assert.equal(h.manager.snapshot().fixedAuth, 'token'); const running = await h.run();
  const call = h.primaryCalls()[0]; assert.equal(call.config.env.TUNNEL_TOKEN, secret);
  assert.equal(call.config.env.GOAGY_POCKET_CF_CONFIG, undefined); assert.equal(call.config.env.CF_TUNNEL_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(call.args) + JSON.stringify(running) + JSON.stringify(h.published) + JSON.stringify(h.logs), /synthetic-cloudflare-token|inherited-token|other-token|private/);
  await h.manager.close();
  const quick = harness({ secrets, env }); await quick.run(); const childEnv = quick.primaryCalls()[0].config.env;
  for (const key of ['TUNNEL_TOKEN', 'CF_TUNNEL_TOKEN', 'GOAGY_POCKET_CF_CONFIG']) assert.equal(childEnv[key], undefined);
  await quick.manager.close();
});
test('inaccessible stored credential reports configured but blocks named start without leaking or config fallback', async () => {
  const h = harness({ config: { mobileMode: 'fixed', mobileFixedUrl: FIXED_URL }, env: { GOAGY_POCKET_CF_CONFIG: 'D:/private/config.yml' },
    secrets: { status: () => ({ configured: true, available: false }), token() { throw Error('synthetic-secret-private'); } } });
  assert.equal(h.manager.snapshot().tunnelTokenConfigured, true); assert.equal(h.manager.snapshot().fixedAuth, null);
  const result = await h.manager.start(); assert.equal(result.state, 'error'); assert.equal(h.calls.length, 0);
  assert.match(result.lastError, /凭据暂不可用/); assert.doesNotMatch(JSON.stringify(result) + JSON.stringify(h.published), /synthetic-secret|private/);
  await h.manager.close();
});

test('unresolved credential transaction blocks quick fixed manual and automatic before probes or spawn', async () => {
  for (const mode of ['quick', 'fixed']) {
    let checks = 0;
    const h = harness({ config: { mobileMode: mode, mobileFixedUrl: FIXED_URL, mobileAutoStart: true },
      env: { GOAGY_POCKET_CF_CONFIG: 'D:/private/config.yml' },
      secrets: { status: () => ({ configured: true, available: false }), assertReady() { checks++; throw Error('synthetic-secret-private'); } } });
    await flush(); h.requests.length = 0;
    for (const run of [() => h.manager.start(), () => h.manager.onAgStart()]) {
      const value = await run(); assert.equal(value.state, 'error'); assert.equal(value.fixedAuth, null);
      assert.match(value.lastError, /凭据暂不可用/); assert.equal(h.calls.length, 0); assert.equal(h.requests.length, 0);
      assert.doesNotMatch(JSON.stringify(value) + JSON.stringify(h.published), /synthetic-secret|private/);
    }
    assert.equal(checks, 2); await h.manager.close();
  }
});

test('the first terminal protocol result wins within a single output chunk', async () => {
  const h = harness(); const pending = h.manager.start(); await flush();
  const spawned = h.children[0];
  spawned.stdout.emit('data', Buffer.from(JSON.stringify({ error: 'CLOUDFLARED_NOT_FOUND' }) + '\n' +
    JSON.stringify({ ready: true, local: LOCAL_URL, pin: h.primaryCalls()[0].config.env.GOAGY_POCKET_PIN, pid: 5000 }) + '\n' +
    JSON.stringify(ready) + '\n'));
  const result = await pending; assert.equal(result.state, 'error'); assert.match(result.lastError, /cloudflared/);
  assert.equal(result.publicUrl, null); assert.equal(h.published.some(value => value.mobile.state === 'running'), false);
  await h.manager.close();
});
