import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { validateTunnelToken } from '../core/mobile-secrets.js';

export const LOCAL_URL = 'http://127.0.0.1:3082/';
export const METRICS_URL = 'http://127.0.0.1:20382/ready';
const runtimeDir = dirname(fileURLToPath(import.meta.url));
const repository = resolve(runtimeDir, '../..');
const safeErrors = new Set(['CLOUDFLARED_NOT_FOUND', 'FIXED_CONFIG_REQUIRED', 'TUNNEL_START_FAILED', 'TUNNEL_PUBLIC_PENDING', 'TUNNEL_RECOVERY_EXHAUSTED']);
const fail = code => Object.assign(new Error(code), { code });
export function parseQuickUrl(value) {
  return typeof value === 'string' && !/\s/.test(value) && /^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/.test(value) ? value : null;
}
export function parseFixedUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 2048 || !/^https:\/\//.test(value)) throw fail('TUNNEL_START_FAILED');
  let url; try { url = new URL(value); } catch { throw fail('TUNNEL_START_FAILED'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' || value.includes('\\') || /[\s\u0000-\u001f\u007f]/.test(value)) throw fail('TUNNEL_START_FAILED');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw fail('TUNNEL_START_FAILED');
  if (value !== url.origin && value !== url.origin + '/') throw fail('TUNNEL_START_FAILED');
  return url.origin;
}
export function parseRuntimeOptions(env = process.env) {
  const mode = env.GOAGY_POCKET_MODE === undefined || env.GOAGY_POCKET_MODE === '' ? 'quick' : env.GOAGY_POCKET_MODE;
  if (mode !== 'quick' && mode !== 'fixed') throw fail('TUNNEL_START_FAILED');
  if (mode === 'quick') return { mode, publicUrl: null, config: null };
  if (env.TUNNEL_TOKEN) {
    try { validateTunnelToken(env.TUNNEL_TOKEN); } catch { throw fail('FIXED_CONFIG_REQUIRED'); }
    return { mode, publicUrl: parseFixedUrl(env.GOAGY_POCKET_FIXED_URL), config: null, auth: 'token' };
  }
  if (!env.GOAGY_POCKET_CF_CONFIG) throw fail('FIXED_CONFIG_REQUIRED');
  if (!isAbsolute(env.GOAGY_POCKET_CF_CONFIG) || !/\.ya?ml$/i.test(env.GOAGY_POCKET_CF_CONFIG) || /[\u0000-\u001f]/.test(env.GOAGY_POCKET_CF_CONFIG)) throw fail('FIXED_CONFIG_REQUIRED');
  return { mode, publicUrl: parseFixedUrl(env.GOAGY_POCKET_FIXED_URL), config: env.GOAGY_POCKET_CF_CONFIG };
}
export async function validateExternalConfig(path, root = repository) {
  try {
    const [actual, repo] = await Promise.all([realpath(path), realpath(root)]);
    const rel = relative(repo, actual);
    if (!rel || (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel))) throw Error();
    if (!(await stat(actual)).isFile()) throw Error();
    await access(actual, constants.R_OK);
    return actual;
  } catch { throw fail('FIXED_CONFIG_REQUIRED'); }
}
export function buildCloudflaredArgs(options) {
  const common = ['--metrics', '127.0.0.1:20382', '--no-autoupdate', '--protocol', options.protocol || 'http2'];
  // cloudflared tunnel-level flags must precede the named tunnel's run subcommand.
  return options.mode === 'fixed'
    ? ['tunnel', '--config', options.config || join(runtimeDir, 'quick-config.yml'), ...common, 'run']
    : ['tunnel', '--config', join(runtimeDir, 'quick-config.yml'), '--url', LOCAL_URL, ...common];
}
export function cloudflaredEnvironment(env, mode) {
  // Connector transports must not inherit loopback interception proxies. Keep named credentials.
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:https?|all|no)_proxy$/i.test(key) &&
    (mode === 'fixed' || !/^(?:TUNNEL_|CF_TUNNEL|CLOUDFLARED_)/i.test(key))));
}
export function originEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:TUNNEL_|CF_TUNNEL|CLOUDFLARED_|GOAGY_POCKET_(?:CF_CONFIG|TUNNEL_TOKEN))/i.test(key)));
}
export async function findCloudflared(env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [];
  if (env.GOAGY_CLOUDFLARED) candidates.push(env.GOAGY_CLOUDFLARED);
  else {
    if (platform === 'win32') {
      for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']]) if (base) candidates.push(join(base, 'cloudflared', exe));
      if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe));
    }
    for (const base of String(env.PATH || env.Path || '').split(delimiter).filter(Boolean)) candidates.push(join(base, exe));
  }
  for (const candidate of candidates) {
    try { if ((await stat(candidate)).isFile()) { await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK); return resolve(candidate); } } catch {}
  }
  throw fail('CLOUDFLARED_NOT_FOUND');
}
// Oversized lines are discarded rather than retaining raw cloudflared log data.
export function createLineReader(onLine, maxLength = 4096) {
  const decoder = new StringDecoder('utf8'); let pending = '', dropping = false;
  function consume(text) {
    for (const piece of text.split(/(?<=\n)/)) {
      const ended = piece.endsWith('\n');
      if (!dropping && pending.length + piece.length <= maxLength) pending += piece;
      else { pending = ''; dropping = true; }
      if (ended) { if (!dropping) onLine(pending.trim()); pending = ''; dropping = false; }
    }
  }
  return { push(chunk) { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); }, end() { consume(decoder.end()); if (pending && !dropping) onLine(pending.trim()); pending = ''; }, get bufferedLength() { return pending.length; } };
}
export function quickUrlFromLine(line) {
  for (const match of line.matchAll(/(?:^|[\s|])(https:\/\/[^\s|"'<>]+)/g)) { const url = parseQuickUrl(match[1]); if (url) return url; }
  return null;
}
async function assertPortsFree() {
  const held = [];
  try {
    for (const port of [3082, 20382]) {
      const server = createServer(); held.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); });
    }
  } catch { throw fail('TUNNEL_START_FAILED'); }
  finally { await Promise.all(held.filter(s => s.listening).map(s => new Promise(resolve => s.close(resolve)))); }
}
function directProbe(url, { signal, requestImpl, metrics = false, timeoutMs }) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return; }
    let req, response, timer, finished = false;
    const finish = value => {
      if (finished) return; finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort); response?.destroy(); req?.destroy(); resolve(value);
    };
    const abort = () => finish(false);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, timeoutMs);
    try {
      // A private agent avoids Node's optional environment-proxy global agent.
      req = requestImpl(url, { method: metrics ? 'GET' : 'HEAD', agent: false,
        headers: { accept: metrics ? 'application/json' : 'text/html', 'cache-control': 'no-cache' } }, res => {
        response = res; res.on('error', abort);
        if (!metrics) {
          finish(res.statusCode === 200 && /^text\/html(?:;|$)/i.test(String(res.headers['content-type'] || '')) &&
            String(res.headers['content-security-policy'] || '').includes("form-action 'self'"));
          return;
        }
        let text = '';
        res.on('data', chunk => { text += chunk; if (text.length > 4096) finish(false); });
        res.on('end', () => {
          try { const value = JSON.parse(text); finish(res.statusCode === 200 && Number.isFinite(value?.readyConnections) && value.readyConnections > 0); }
          catch { finish(false); }
        });
      });
      req.on('error', abort); req.end();
    } catch { finish(false); }
  });
}
export function metricsReady({ signal, requestImpl = httpRequest } = {}) {
  return directProbe(METRICS_URL, { signal, requestImpl, metrics: true, timeoutMs: 1500 });
}
export function publicReady(url, { signal, requestImpl = httpsRequest, timeoutMs = 6000 } = {}) {
  return directProbe(url, { signal, requestImpl, timeoutMs });
}
export function createTunnelSupervisor({
  env = process.env, spawnChild = spawn, resolveBinary = findCloudflared,
  checkConfig = validateExternalConfig, checkPorts = assertPortsFree,
  probeReady = metricsReady, probePublic = publicReady, emit = value => console.log(JSON.stringify(value)),
  serverTimeout = 30000, tunnelTimeout = 90000, pollMs = 300, killGrace = 1200,
  fallbackMs = 8000, healthMs = 5000, failureLimit = 3, maxRestarts = 2,
  retryMs = 1000, resetAfter = 600000, probeTimeout = 1500, publicProbeTimeout = 6000,
  now = Date.now,
} = {}) {
  let server, attempt, stopped = false, ready = false, serverReady = false, starting = false, options, binary;
  let timeout, retryTimer, retryResolve, restarting = null, restarts = 0, startupFallback = false;
  let startResolve, startReject, doneResolve;
  const children = new Set(), kills = new WeakMap();
  const done = new Promise(resolve => { doneResolve = resolve; });
  const started = new Promise((resolve, reject) => { startResolve = resolve; startReject = reject; });
  function phase(value) { if (!stopped) emit({ phase: value, mode: options.mode, local: LOCAL_URL }); }
  function active(item) { return !stopped && attempt === item && !item.controller.signal.aborted; }
  function invalidate(item) {
    if (!item) return;
    clearTimeout(item.pollTimer); clearTimeout(item.fallbackTimer); item.controller.abort();
  }
  // Hard deadlines cover hung injected transports and the full DNS/TLS/HTTP operation.
  async function bounded(probe, args, signal, ms) {
    if (signal.aborted) return false;
    const controller = new AbortController(); let timer, abort;
    const cancelled = new Promise(resolve => {
      abort = () => { controller.abort(); resolve(false); };
      signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, ms);
    });
    try { return await Promise.race([Promise.resolve().then(() => probe(...args, { signal: controller.signal })).then(value => value === true, () => false), cancelled]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  function bind(child, item) {
    children.add(child);
    child.once('error', () => {
      if (stopped) return;
      if (item && active(item)) void restart(item); else if (!item) void stop(1, 'TUNNEL_START_FAILED');
    });
    child.once('exit', () => {
      children.delete(child);
      if (stopped) return;
      if (item && active(item)) void restart(item); else if (!item) void stop(1, 'TUNNEL_START_FAILED');
    });
    return child;
  }
  function kill(child) {
    if (!child || !children.has(child)) return Promise.resolve(true);
    if (kills.has(child)) return kills.get(child);
    const promise = new Promise(resolve => {
      let timer, finished = false;
      const finish = value => { if (finished) return; finished = true; clearTimeout(timer); child.off('exit', exited); resolve(value); };
      const exited = () => finish(true);
      child.once('exit', exited);
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        timer = setTimeout(() => finish(!children.has(child)), killGrace);
      }, killGrace);
      try { child.kill('SIGTERM'); } catch { finish(false); }
    });
    kills.set(child, promise); return promise;
  }
  async function stop(code = 0, reason) {
    if (stopped) return done;
    stopped = true; clearTimeout(timeout); clearTimeout(retryTimer); retryResolve?.(); invalidate(attempt);
    if (reason) emit({ error: safeErrors.has(reason) ? reason : 'TUNNEL_START_FAILED' });
    if (!ready) startReject(fail(reason || 'TUNNEL_START_FAILED'));
    // Signal only handles created here; failed termination never permits a replacement.
    const terminated = await Promise.all([...children].map(child => kill(child)));
    const result = terminated.every(Boolean) ? code : 1;
    doneResolve(result); return result;
  }
  async function checkReady(item) {
    if (!active(item)) return;
    if (item.busy) { item.recheck = true; return; }
    clearTimeout(item.pollTimer); item.busy = true; item.recheck = false;
    let delay = item.ready ? healthMs : pollMs;
    try {
      const edge = await bounded(probeReady, [], item.controller.signal, probeTimeout);
      if (!active(item)) return;
      item.edgeReady = edge;
      if (!edge) {
        item.healthySince = null;
        if (item.ready && ++item.failures >= failureLimit) { void restart(item); return; }
      } else {
        item.failures = 0;
        if (item.ready) {
          item.healthySince ??= now();
          if (now() - item.healthySince >= resetAfter) restarts = 0;
        } else if (item.publicUrl) {
          phase('public');
          const reachable = await bounded(probePublic, [item.publicUrl], item.controller.signal, publicProbeTimeout);
          if (!active(item)) return;
          if (reachable && children.has(server) && children.has(item.child)) {
            item.ready = true; item.healthySince = now(); clearTimeout(timeout); clearTimeout(item.fallbackTimer);
            const status = { tunnelReady: true, mode: options.mode, publicUrl: item.publicUrl, local: LOCAL_URL };
            ready = true; emit(status); startResolve(status); delay = healthMs;
          } else delay = Math.max(pollMs, retryMs);
        }
      }
    } catch {} finally { item.busy = false; }
    if (active(item)) item.pollTimer = setTimeout(() => { void checkReady(item); }, item.recheck ? 0 : delay);
  }
  function launchTunnel(protocol) {
    if (stopped) return;
    const item = { controller: new AbortController(), protocol, publicUrl: options.publicUrl,
      ready: false, busy: false, edgeReady: false, failures: 0, healthySince: null };
    attempt = item; phase('connector');
    try {
      item.child = bind(spawnChild(binary, buildCloudflaredArgs({ ...options, protocol }), {
        cwd: runtimeDir, env: { ...cloudflaredEnvironment(originEnvironment(env), options.mode),
          ...(options.auth === 'token' ? { TUNNEL_TOKEN: env.TUNNEL_TOKEN } : {}) }, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      }), item);
      const scan = () => createLineReader(line => {
        if (!active(item) || options.mode !== 'quick') return;
        const found = quickUrlFromLine(line);
        if (found && !item.publicUrl) { item.publicUrl = found; void checkReady(item); }
      });
      for (const stream of [item.child.stdout, item.child.stderr]) {
        const reader = scan(); stream?.on('data', chunk => reader.push(chunk)); stream?.once('end', () => reader.end());
      }
      // HTTP/2 avoids a blocked-UDP cold-start delay. Try QUIC once if TCP cannot register.
      if (ready || !startupFallback) item.fallbackTimer = setTimeout(() => {
        if (active(item) && !item.edgeReady) void restart(item);
      }, fallbackMs);
      void checkReady(item);
    } catch { void restart(item); }
  }
  async function restart(item) {
    if (!active(item) || restarting) return;
    if (!ready) {
      if (startupFallback) { void stop(1, 'TUNNEL_START_FAILED'); return; }
      startupFallback = true;
    } else {
      if (restarts >= maxRestarts) { void stop(1, 'TUNNEL_RECOVERY_EXHAUSTED'); return; }
      restarts++;
      emit({ tunnelStatus: 'recovering', mode: options.mode, local: LOCAL_URL });
      clearTimeout(timeout); timeout = setTimeout(() => { void stop(1, 'TUNNEL_START_FAILED'); }, tunnelTimeout);
    }
    invalidate(item);
    const work = (async () => {
      if (!await kill(item.child)) { void stop(1, 'TUNNEL_START_FAILED'); return; }
      if (stopped) return;
      await new Promise(resolve => { retryResolve = resolve; retryTimer = setTimeout(resolve, retryMs); });
      retryResolve = null; clearTimeout(retryTimer);
      // Release the lock before spawn so synchronous replacement failures are not dropped.
      if (restarting === work) restarting = null;
      if (!stopped) launchTunnel(item.protocol === 'http2' ? 'quic' : 'http2');
    })();
    restarting = work;
    try { await work; } finally { if (restarting === work) restarting = null; }
  }
  async function prepareTunnel() {
    clearTimeout(timeout);
    timeout = setTimeout(() => { void stop(1, attempt?.edgeReady ? 'TUNNEL_PUBLIC_PENDING' : 'TUNNEL_START_FAILED'); }, tunnelTimeout);
    try {
      binary = await resolveBinary(env);
      if (!stopped) launchTunnel('http2');
    } catch (error) { void stop(1, error.code === 'CLOUDFLARED_NOT_FOUND' ? error.code : 'TUNNEL_START_FAILED'); }
  }
  async function start() {
    if (starting || stopped) return started;
    starting = true;
    timeout = setTimeout(() => { void stop(1, 'TUNNEL_START_FAILED'); }, serverTimeout);
    try {
      options = parseRuntimeOptions(env); phase('origin');
      if (options.config) options.config = await checkConfig(options.config);
      if (stopped) return started;
      await checkPorts(); if (stopped) return started;
      server = bind(spawnChild(process.execPath, [join(runtimeDir, 'server.mjs')], { cwd: runtimeDir, env: originEnvironment(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false }));
      const reader = createLineReader(line => {
        if (serverReady || stopped) return;
        let value; try { value = JSON.parse(line); } catch { return; }
        if (value?.ready === true && value.local === LOCAL_URL && /^[a-zA-Z0-9]{8,64}$/.test(value.pin) && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid === server.pid) {
          serverReady = true; emit({ ready: true, local: LOCAL_URL, pin: value.pin, pid: value.pid }); void prepareTunnel();
        } else if (value?.error) void stop(1, 'TUNNEL_START_FAILED');
      });
      server.stdout?.on('data', chunk => reader.push(chunk)); server.stdout?.once('end', () => reader.end());
      server.stderr?.on('data', () => {});
    } catch (error) { void stop(1, safeErrors.has(error.code) ? error.code : 'TUNNEL_START_FAILED'); }
    return started;
  }
  return { start, stop, done };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const supervisor = createTunnelSupervisor();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void supervisor.stop(0); });
  await supervisor.start().catch(() => {});
  process.exitCode = await supervisor.done;
}
