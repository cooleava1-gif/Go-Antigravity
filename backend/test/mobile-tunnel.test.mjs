import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { LOCAL_URL, createTunnelSupervisor, metricsReady, publicReady, cloudflaredEnvironment, parseRuntimeOptions, buildCloudflaredArgs } from '../mobile/tunnel.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, ms = 1000) {
  const end = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() >= end) throw Error('Timed out waiting for local fixture');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
class Child extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.kills = []; this.exitCode = null; this.signalCode = null; }
  kill(signal) {
    this.kills.push(signal);
    if (this.refuseKill) return false;
    queueMicrotask(() => { this.signalCode = signal; this.emit('exit', null, signal); });
    return true;
  }
  die() { this.exitCode = 1; this.emit('exit', 1, null); }
}
function fixture(overrides = {}) {
  const h = { records: [], calls: [], children: [], edge: true, public: true };
  const spawn = (command, args, options) => {
    h.calls.push({ command, args, options });
    if (h.throwReplacement && h.calls.length >= 3) throw Error('private fixture credential');
    const child = new Child(100 + h.children.length); h.children.push(child); return child;
  };
  h.supervisor = createTunnelSupervisor({ env: {}, spawnChild: spawn, checkPorts: async () => {},
    resolveBinary: async () => '/mock/cloudflared', checkConfig: async p => p,
    probeReady: async () => h.edge, probePublic: async () => h.public, emit: record => h.records.push(record),
    serverTimeout: 500, tunnelTimeout: 500, fallbackMs: 30, retryMs: 2, healthMs: 3,
    pollMs: 2, killGrace: 5, probeTimeout: 15, publicProbeTimeout: 15, ...overrides });
  h.begin = async () => {
    h.pending = h.supervisor.start(); h.pending.catch(() => {});
    await until(() => h.children.length > 0);
    h.children[0].stdout.write(JSON.stringify({ ready: true, local: LOCAL_URL, pin: '12345678', pid: 100 }) + '\n');
    await until(() => h.children.length > 1);
  };
  h.url = (index = h.children.length - 1) => h.children[index].stderr.write('| https://fixture-' + index + '.trycloudflare.com |\n');
  h.ready = async () => { await h.begin(); h.url(); return await h.pending; };
  return h;
}
function responseFactory({ status = 200, body = '{}', headers = {} } = {}) {
  const calls = [];
  const requestImpl = (url, options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = status; res.headers = headers;
      callback(res); res.end(body);
    });
    calls.push({ url, options, req }); return req;
  };
  return { calls, requestImpl };
}

test('loopback readiness requires a positive numeric connection count, not status alone', async () => {
  for (const value of [0, -1, null, '1']) {
    const f = responseFactory({ body: JSON.stringify({ readyConnections: value }) });
    assert.equal(await metricsReady('http://127.0.0.1:20382/ready', { requestImpl: f.requestImpl }), false);
  }
  for (const f of [responseFactory({ body: 'not json' }), responseFactory({ status: 503, body: '{"readyConnections":1}' }), responseFactory({ body: 'x'.repeat(5000) })])
    assert.equal(await metricsReady('http://127.0.0.1:20382/ready', { requestImpl: f.requestImpl }), false);
  const f = responseFactory({ body: '{"readyConnections":2}' });
  assert.equal(await metricsReady('http://127.0.0.1:20382/ready', { requestImpl: f.requestImpl }), true);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:20382/ready');
  assert.equal(f.calls[0].options.method, 'GET'); assert.equal(f.calls[0].options.agent, false);
});
test('public HEAD verifies the unauthenticated PIN page and never follows redirects or sends credentials', async () => {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; form-action 'self'" };
  for (const status of [301, 302, 401, 403, 503, 530]) {
    const f = responseFactory({ status, headers }); assert.equal(await publicReady('https://fixture.trycloudflare.com', { requestImpl: f.requestImpl }), false);
  }
  assert.equal(await publicReady('https://fixture.trycloudflare.com', { requestImpl: responseFactory({ headers: { 'content-type': 'text/html' } }).requestImpl }), false);
  const f = responseFactory({ headers });
  assert.equal(await publicReady('https://fixture.trycloudflare.com', { requestImpl: f.requestImpl }), true);
  assert.equal(f.calls[0].options.method, 'HEAD'); assert.equal(f.calls[0].options.agent, false);
  assert.equal('cookie' in f.calls[0].options.headers, false); assert.equal('authorization' in f.calls[0].options.headers, false);
});
test('native public deadline includes DNS/TLS and Stop destroys a pending request', async () => {
  const calls = []; const requestImpl = () => {
    const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { req.destroyed = true; }; calls.push(req); return req;
  };
  const before = performance.now();
  assert.equal(await publicReady('https://fixture.trycloudflare.com', { requestImpl, timeoutMs: 15 }), false);
  assert.ok(performance.now() - before < 300); assert.equal(calls[0].destroyed, true);
  const controller = new AbortController(); const pending = publicReady('https://fixture.trycloudflare.com', { requestImpl, signal: controller.signal });
  controller.abort(); assert.equal(await pending, false); assert.equal(calls[1].destroyed, true);
});
test('both connector modes remove all proxy spellings while fixed credentials stay isolated', () => {
  const env = { PATH: 'bin', HTTP_PROXY: 'secret', https_proxy: 'secret', ALL_PROXY: 'secret', No_Proxy: 'secret', TUNNEL_TOKEN: 'named', GO_ANTIGRAVITY_MOBILE_PIN: '12345678' };
  assert.deepEqual(cloudflaredEnvironment(env, 'quick'), { PATH: 'bin' });
  assert.deepEqual(cloudflaredEnvironment(env, 'fixed'), { PATH: 'bin', TUNNEL_TOKEN: 'named' });
  assert.equal(env.HTTP_PROXY, 'secret');
});
test('HTTP2 healthy cold start has no fallback wait and URL chunks trigger readiness immediately', async t => {
  const f = fixture({ pollMs: 300, fallbackMs: 8000 }); t.after(() => f.supervisor.stop());
  await f.begin(); const before = performance.now();
  f.children[1].stderr.write('register https://api.trycloudflare.com\n| https://fixture-');
  f.children[1].stderr.write('1.trycloudflare.com |\n');
  const result = await f.pending; const elapsed = performance.now() - before;
  assert.equal(result.publicUrl, 'https://fixture-1.trycloudflare.com'); assert.ok(elapsed < 180, 'readiness must not wait a 300ms poll');
  assert.equal(f.calls[1].args[f.calls[1].args.indexOf('--protocol') + 1], 'http2');
  assert.equal(f.children.length, 2); assert.ok(f.records.some(r => r.phase === 'public'));
  t.diagnostic('URL-to-ready local fixture: ' + elapsed.toFixed(2) + 'ms; former polling floor up to300ms, no8s transport wait');
});
test('pending DNS or transient public failure does not rebuild a registered connector', async t => {
  let probes = 0;
  const f = fixture({ fallbackMs: 10, probePublic: async () => ++probes > 8 }); t.after(() => f.supervisor.stop());
  await f.begin(); f.url(); await f.pending;
  assert.ok(probes >= 9); assert.equal(f.children.length, 2); assert.equal(f.children[0].kills.length, 0);
  assert.equal(f.records.filter(r => r.tunnelStatus).length, 0);
});
test('unresolved public readiness reports propagation separately within its total budget', async () => {
  const f = fixture({ tunnelTimeout: 25, probePublic: async () => false });
  await f.begin(); f.url(); await assert.rejects(f.pending, /TUNNEL_PUBLIC_PENDING/);
  await f.supervisor.done; assert.equal(f.children.length, 2); assert.ok(f.children.every(c => c.kills.length));
});
test('stalled connector gets one alternate protocol after old child exits and preserves the origin', async t => {
  const f = fixture({ fallbackMs: 10 }); f.edge = false; t.after(() => f.supervisor.stop());
  await f.begin(); await until(() => f.children.length === 3);
  assert.ok(f.children[1].signalCode); assert.equal(f.children[0].kills.length, 0);
  assert.equal(f.calls[2].args[f.calls[2].args.indexOf('--protocol') + 1], 'quic');
  f.edge = true; f.children[1].stderr.write('https://stale.trycloudflare.com\n'); f.url();
  assert.equal((await f.pending).publicUrl, 'https://fixture-2.trycloudflare.com');
});
test('runtime recovery preserves origin/PIN, replaces stale URL, and accumulates a two-rebuild budget', async () => {
  const f = fixture(); await f.ready();
  for (let count = 0; count < 2; count++) {
    f.edge = false; const target = f.children.length + 1;
    await until(() => f.children.length === target);
    assert.equal(f.children[0].kills.length, 0);
    f.edge = true; f.url(); await until(() => f.records.filter(r => r.tunnelReady).length === count + 2);
  }
  f.edge = false; await f.supervisor.done;
  assert.equal(f.children.length, 4); assert.equal(f.records.at(-1).error, 'TUNNEL_RECOVERY_EXHAUSTED');
  assert.equal(f.records.filter(r => r.ready).length, 1); assert.equal(f.records.filter(r => r.tunnelStatus === 'recovering').length, 2);
  assert.ok(f.children.every(c => c.kills.length));
});
test('runtime replacement without edge readiness consumes the same bounded rebuild budget promptly', async () => {
  const f = fixture({ fallbackMs: 10 }); await f.ready();
  const before = performance.now(); f.edge = false; await f.supervisor.done;
  assert.ok(performance.now() - before < 250, 'stalled replacements must use the short recovery watchdog');
  assert.equal(f.children.length, 4); assert.equal(f.records.at(-1).error, 'TUNNEL_RECOVERY_EXHAUSTED');
  assert.equal(f.records.filter(r => r.ready).length, 1);
});

test('ten minutes continuous health resets cumulative recovery budget, intermittent health does not', async t => {
  let now = 0; const f = fixture({ now: () => now, resetAfter: 600000, maxRestarts: 1 }); t.after(() => f.supervisor.stop());
  await f.ready(); f.edge = false; await until(() => f.children.length === 3);
  f.edge = true; f.url(); await until(() => f.records.filter(r => r.tunnelReady).length === 2);
  now = 600001; await new Promise(resolve => setTimeout(resolve, 10));
  f.edge = false; await until(() => f.children.length === 4);
  f.edge = true; f.url(); await until(() => f.records.filter(r => r.tunnelReady).length === 3);
  assert.equal(f.children[0].kills.length, 0);
});
test('Stop during an uncancellable public probe aborts the signal and suppresses late readiness', async () => {
  let resolveProbe, signal;
  const f = fixture({ probePublic: (_url, options) => { signal = options.signal; return new Promise(resolve => { resolveProbe = resolve; }); } });
  await f.begin(); f.url(); await until(() => Boolean(signal));
  await f.supervisor.stop(); assert.equal(signal.aborted, true); await assert.rejects(f.pending);
  resolveProbe(true); await turn(); assert.equal(f.records.some(r => r.tunnelReady), false); assert.equal(f.children.length, 2);
});
test('Stop during fallback backoff prevents late replacement and startup promises settle', async () => {
  const f = fixture({ fallbackMs: 5, retryMs: 40 }); f.edge = false;
  await f.begin(); await until(() => f.children[1].kills.length > 0);
  await f.supervisor.stop(); await assert.rejects(f.pending);
  await new Promise(resolve => setTimeout(resolve, 55)); assert.equal(f.children.length, 2);
});
test('refused termination prevents replacement rather than overlapping connector listeners', async () => {
  const f = fixture({ fallbackMs: 5 }); f.edge = false;
  await f.begin(); f.children[1].refuseKill = true;
  await assert.rejects(f.pending, /TUNNEL_START_FAILED/); await f.supervisor.done;
  assert.equal(f.children.length, 2); assert.deepEqual(f.children[1].kills, ['SIGTERM', 'SIGKILL']);
});
test('synchronous replacement spawn failures settle promptly under the same cumulative budget', async () => {
  const f = fixture(); await f.ready(); f.throwReplacement = true;
  const before = performance.now(); f.edge = false; await f.supervisor.done;
  assert.ok(performance.now() - before < 250); assert.equal(f.calls.length, 4);
  assert.equal(f.records.at(-1).error, 'TUNNEL_RECOVERY_EXHAUSTED'); assert.equal(f.children.length, 2);
  assert.doesNotMatch(JSON.stringify(f.records), /private|credential/);
});
test('named token precedes external YAML and only connector environment contains it across recovery', async t => {
  const token = 'synthetic-cloudflare-token-12345';
  const env = { GO_ANTIGRAVITY_MOBILE_MODE: 'fixed', GO_ANTIGRAVITY_MOBILE_FIXED_URL: 'https://mobile.example.test', GO_ANTIGRAVITY_MOBILE_PIN: '12345678',
    TUNNEL_TOKEN: token, CF_TUNNEL_TOKEN: 'inherited-other', GO_ANTIGRAVITY_MOBILE_CF_CONFIG: 'invalid-relative-config.yml', HTTPS_PROXY: 'private-proxy' };
  const options = parseRuntimeOptions(env); assert.equal(options.auth, 'token'); assert.equal(options.config, null);
  const args = buildCloudflaredArgs(options); assert.equal(args.at(-1), 'run'); assert.ok(args.every(value => typeof value === 'string')); assert.equal(args.includes(token), false);
  let configReads = 0;
  const f = fixture({ env, checkConfig: async () => { configReads++; throw Error(token); } }); t.after(() => f.supervisor.stop());
  await f.begin(); await f.pending; assert.equal(configReads, 0);
  const origin = f.calls[0].options.env;
  assert.equal(origin.GO_ANTIGRAVITY_MOBILE_PIN, env.GO_ANTIGRAVITY_MOBILE_PIN);
  for (const key of ['TUNNEL_TOKEN', 'CF_TUNNEL_TOKEN', 'GO_ANTIGRAVITY_MOBILE_CF_CONFIG']) assert.equal(origin[key], undefined);
  assert.equal(f.calls[1].options.env.TUNNEL_TOKEN, token); assert.equal(f.calls[1].options.env.CF_TUNNEL_TOKEN, undefined);
  assert.equal(f.calls[1].options.env.HTTPS_PROXY, undefined);
  f.edge = false; await until(() => f.children.length === 3); f.edge = true;
  await until(() => f.records.filter(record => record.tunnelReady).length === 2);
  assert.equal(f.calls[2].options.env.TUNNEL_TOKEN, token); assert.equal(f.children[0].kills.length, 0);
  for (const call of f.calls.slice(1)) assert.ok(Object.keys(call.options.env).every(key => !/^GO_ANTIGRAVITY_MOBILE_/i.test(key)));
  assert.doesNotMatch(JSON.stringify(f.records) + JSON.stringify(f.calls.map(call => call.args)), /synthetic-cloudflare-token|inherited-other|private-proxy/);
});
test('invalid named token fails before origin spawn with a sanitized protocol error', async () => {
  for (const token of ['bad token', 'token\n', 'token;command', 'x'.repeat(16385)]) {
    const f = fixture({ env: { GO_ANTIGRAVITY_MOBILE_MODE: 'fixed', GO_ANTIGRAVITY_MOBILE_FIXED_URL: 'https://mobile.example.test', TUNNEL_TOKEN: token } });
    await assert.rejects(f.supervisor.start(), /FIXED_CONFIG_REQUIRED/); await f.supervisor.done;
    assert.equal(f.calls.length, 0); assert.deepEqual(f.records, [{ error: 'FIXED_CONFIG_REQUIRED' }]);
  }
});

test('asynchronous replacement error cannot create parallel retries and stays within budget', async () => {
  const f = fixture(); await f.ready(); f.edge = false;
  await until(() => f.children.length === 3);
  f.children[2].emit('error', Error('sensitive detail')); f.children[2].die();
  await until(() => f.children.length === 4);
  f.children[3].emit('error', Error('sensitive detail')); await f.supervisor.done;
  assert.equal(f.children.length, 4); assert.equal(f.records.at(-1).error, 'TUNNEL_RECOVERY_EXHAUSTED');
  assert.doesNotMatch(JSON.stringify(f.records), /sensitive/);
});


test('reservePort rejection during a restart fails immediately instead of waiting the full timeout', async () => {
 let reservations = 0;
 const f = fixture({
   reservePort: async () => { reservations++; if (reservations >= 2) throw Error('emulated port allocation failure'); return 40000 + reservations; },
 });
 await f.ready();
 // Force a restart: first edge failure triggers rebuild, which reserves a second port and fails.
 f.edge = false;
 const before = performance.now();
 const code = await f.supervisor.done;
 const elapsed = performance.now() - before;
 assert.equal(code, 1, 'supervisor must settle with failure');
 assert.ok(elapsed < 300, 'must fail fast, not wait the full tunnel timeout (got ' + elapsed.toFixed(1) + 'ms)');
 assert.equal(reservations, 2, 'first launch and one restart reservation only');
});
