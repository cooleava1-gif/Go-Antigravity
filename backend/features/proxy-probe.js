'use strict';
// Pre-launch proxy self-check.
//
// Why this exists: when the local proxy client is not running, is listening on another port, or
// refuses to forward, AG itself is the first component to notice — and it reports that as an
// opaque "HTTP 400 Bad Request / User location is not supported for the API use." dialog with no
// hint that the launcher's proxy is at fault. The probe below reproduces the same request a
// fraction of a second before AG is spawned, so the launcher can refuse the launch and name the
// actual cause.
//
// It talks to generativelanguage.googleapis.com — a Google API frontend AG also reaches — with no
// credentials, which is enough to prove the tunnel carries traffic and to tell a dead or refusing
// proxy apart from a working one. It is NOT enough to answer the geo gate: Google decides that
// after authenticating the caller, and AG's real backend (daily-cloudcode-pa.googleapis.com)
// answers every unauthenticated request with 401 UNAUTHENTICATED long before any region check. A
// refused exit region is therefore invisible here and is caught after launch by the log watcher in
// features/ag-log-watch.js, which reads AG's own verdict. What this probe still guarantees is that
// it follows exactly the same proxy route as AG's own traffic, so a rule-based proxy that only
// routes Google still gets a truthful answer, and a proxy that reports its own error page is
// caught instead of passing.
//
// No dependency is added on purpose: the launcher ships as a single-file backend next to `ws`, and
// a CONNECT + TLS + HTTP/1.1 request is ~80 lines here versus a new runtime dependency.
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');

const PROBE_HOST = 'generativelanguage.googleapis.com';
const PROBE_PORT = 443;
const PROBE_PATH = '/v1beta/models';
// The literal string Google returns when the client IP is outside the supported regions. Matched
// against the decoded body so a gzipped or chunked response still counts.
const GEO_GATE = 'User location is not supported';
const DEFAULT_TIMEOUT_MS = 8000;
const PORT_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 256 * 1024;
const USER_AGENT = 'Go-Antigravity (proxy-preflight)';

// Failure codes. `ok` and `geo-blocked` are the two outcomes that depend on Google's answer;
// everything else means the proxy itself never delivered a request.
const CODES = {
  OK: 'ok',
  GEO_BLOCKED: 'geo-blocked',
  PROXY_DOWN: 'proxy-down',
  PROXY_REJECTED: 'proxy-rejected',
  TIMEOUT: 'timeout',
  BAD_RESPONSE: 'bad-response'
};

function portLabel(port) {
  return `127.0.0.1:${port}`;
}

function adviceFor(code, port) {
  switch (code) {
    case CODES.PROXY_DOWN:
      return `请先启动代理客户端，并把 Go-Antigravity 设置里的代理端口改成实际端口（当前按 ${portLabel(port)} 探测）`;
    case CODES.PROXY_REJECTED:
      return '代理收到了请求但拒绝转发：检查代理的规则模式/系统代理开关，或更换节点';
    case CODES.TIMEOUT:
      return '代理没有在时限内应答：节点可能已失效，换一个节点再试';
    case CODES.GEO_BLOCKED:
      return '更换代理节点到 Google 受支持的地区（美、日等）后重试';
    case CODES.BAD_RESPONSE:
      return '代理返回的不是 Google 的响应：节点可能已失效，更换节点后重试';
    default:
      return '';
  }
}

function messageFor(code, { port, status, ms }) {
  switch (code) {
    case CODES.OK:
      return `代理出口正常 · Google 可达（${ms}ms）`;
    case CODES.GEO_BLOCKED:
      return `Google 拒绝服务：当前代理出口地区不受支持（HTTP ${status} User location is not supported for the API use.）`;
    case CODES.PROXY_DOWN:
      return `本地代理未运行：${portLabel(port)} 连不上`;
    case CODES.PROXY_REJECTED:
      return status
        ? `代理拒绝转发到 Google（CONNECT 返回 HTTP ${status}）`
        : '与 Google 的加密通道建立失败：代理有应答，但隧道被中断';
    case CODES.TIMEOUT:
      return `经代理访问 Google 超时（${ms}ms）`;
    case CODES.BAD_RESPONSE:
      return `代理返回了非 Google 的响应（HTTP ${status || '无状态码'}）`;
    default:
      return '代理自检失败';
  }
}

// A proxy in front of a dead node answers with its own HTML error page, so an HTTP status alone
// cannot tell "Google answered" from "the proxy answered". Google API frontends always answer
// with JSON, which is what actually separates the two cases.
function looksLikeGoogleAnswer(status, body) {
  if (status >= 200 && status < 400) return true;
  try {
    const parsed = JSON.parse(body);
    return Boolean(parsed && typeof parsed === 'object' && (parsed.error || parsed.models));
  } catch {
    return false;
  }
}

// Decode only a complete chunked message. Returning a partial prefix can turn a truncated
// response into valid JSON (or hide the geo gate), so every delimiter and the final trailer
// terminator must be present before any body is handed to the caller.
function dechunkStrict(buffer) {
  const parts = [];
  let offset = 0;
  let total = 0;
  const chunkLine = /^[0-9a-f]+(?:[ \t]*;[ \t]*[!#$%&'*+.^_\x60|~0-9a-z-]+(?:[ \t]*=[ \t]*(?:[!#$%&'*+.^_\x60|~0-9a-z-]+|"(?:[\t \x21\x23-\x5b\x5d-\xff]|\\[\t \x21-\x7e\x80-\xff])*"))?)*$/i;
  const trailerLine = /^[!#$%&'*+.^_\x60|~0-9a-z-]+:[\t \x21-\x7e\x80-\xff]*$/i;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new Error('Incomplete chunk size');
    const line = buffer.toString('latin1', offset, lineEnd);
    if (!chunkLine.test(line)) throw new Error('Invalid chunk size or extension');
    const size = Number.parseInt(line.split(';', 1)[0], 16);
    if (!Number.isSafeInteger(size)) throw new Error('Invalid chunk size');
    offset = lineEnd + 2;
    if (size === 0) {
      while (offset < buffer.length) {
        const trailerEnd = buffer.indexOf('\r\n', offset);
        if (trailerEnd < 0) break;
        if (trailerEnd === offset) {
          if (trailerEnd + 2 !== buffer.length) throw new Error('Data after chunk terminator');
          return Buffer.concat(parts, total);
        }
        if (!trailerLine.test(buffer.toString('latin1', offset, trailerEnd))) {
          throw new Error('Invalid chunk trailer');
        }
        offset = trailerEnd + 2;
      }
      throw new Error('Incomplete chunk trailer');
    }
    if (size > MAX_BODY_BYTES - total || size > buffer.length - offset - 2) {
      throw new Error('Incomplete or oversized chunk');
    }
    const end = offset + size;
    if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new Error('Invalid chunk delimiter');
    parts.push(buffer.subarray(offset, end));
    total += size;
    offset = end + 2;
  }
  throw new Error('Missing chunk terminator');
}

function dechunk(buffer) {
  try { return dechunkStrict(buffer); } catch { return Buffer.alloc(0); }
}

function headerCodings(headers, name) {
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
  return values.length ? values.join(',').toLowerCase().split(',').map(value => value.trim()) : [];
}

function decodeCoding(bytes, coding) {
  if (coding === 'identity') return bytes;
  if (coding === 'gzip' || coding === 'x-gzip') return zlib.gunzipSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
  if (coding === 'deflate') return zlib.inflateSync(bytes, { maxOutputLength: MAX_BODY_BYTES });
  throw new Error('Unsupported HTTP encoding');
}

function decodeBodyStrict(buffer, headers = {}) {
  let bytes = buffer;
  if (bytes.length > MAX_BODY_BYTES) throw new Error('HTTP body exceeds probe limit');
  const transfer = headerCodings(headers, 'transfer-encoding');
  const chunked = transfer.indexOf('chunked');
  if (chunked >= 0 && (chunked !== transfer.length - 1 || transfer.lastIndexOf('chunked') !== chunked)) {
    throw new Error('Chunked must be the final transfer encoding');
  }
  // Encodings are listed in application order. Remove transfer framing first, then content
  // encodings, walking each list backwards (e.g. gzip -> chunked becomes dechunk -> gunzip).
  for (let index = transfer.length - 1; index >= 0; index -= 1) {
    bytes = transfer[index] === 'chunked' ? dechunkStrict(bytes) : decodeCoding(bytes, transfer[index]);
  }
  const content = headerCodings(headers, 'content-encoding');
  for (let index = content.length - 1; index >= 0; index -= 1) bytes = decodeCoding(bytes, content[index]);
  return bytes.toString('utf8');
}

function decodeBody(buffer, headers) {
  try { return decodeBodyStrict(buffer, headers); } catch { return ''; }
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // Encoding fields are lists; overwriting an earlier line loses a layer of compression.
    if ((name === 'content-encoding' || name === 'transfer-encoding') && Object.hasOwn(headers, name)) {
      headers[name] += ', ' + value;
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

// Reads until `marker` shows up, then detaches its own listener so the socket can be handed to
// tls.connect() without two readers racing for the same bytes.
function readUntil(socket, marker) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const onData = chunk => {
      seen += chunk.toString('latin1');
      if (seen.includes(marker)) {
        socket.removeListener('data', onData);
        resolve(seen.slice(0, seen.indexOf(marker) + marker.length));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => {
      socket.removeListener('data', onData);
      resolve(seen);
    });
  });
}

function readAll(socket, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = chunk => {
      total += chunk.length;
      chunks.push(chunk);
      if (total >= cap) {
        socket.removeListener('data', onData);
        resolve(Buffer.concat(chunks));
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('end', () => {
      socket.removeListener('data', onData);
      resolve(Buffer.concat(chunks));
    });
    socket.once('close', () => {
      socket.removeListener('data', onData);
      resolve(Buffer.concat(chunks));
    });
  });
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.once('error', reject);
    socket.once('connect', () => resolve(socket));
  });
}

function tlsReady(socket, servername) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername });
    secure.once('error', reject);
    secure.once('secureConnect', () => resolve(secure));
  });
}

// Speaks to the proxy with CONNECT, then to Google over the resulting tunnel. Returns the raw
// shape the interpreter understands; it never throws for a network condition.
//
// `secure: false` keeps the request in plain HTTP once the tunnel is up. That is not a fallback for
// the Google probe — it is what the egress lookup needs, because the one free geo service that
// answers on plain HTTP is the second source it tries.
async function tunnelRequest({
  proxyPort,
  host = PROBE_HOST,
  port = PROBE_PORT,
  path = PROBE_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  secure = true
}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const raw = await connectTcp('127.0.0.1', proxyPort).catch(error => {
    return { error };
  });
  if (raw.error) {
    // ECONNREFUSED is the normal "proxy client is not running" answer; anything else on a
    // loopback connect means the port is filtered, which is the same user-visible problem.
    return { stage: 'connect', status: null, headers: {}, body: '', error: raw.error, ms: elapsed() };
  }
  try {
    raw.setTimeout(timeoutMs);
    raw.on('timeout', () => raw.destroy());
    raw.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    const head = await readUntil(raw, '\r\n\r\n');
    if (raw.destroyed) return { stage: 'timeout', status: null, headers: {}, body: '', ms: elapsed() };
    const statusLine = head.split('\r\n')[0] || '';
    const connectStatus = Number(statusLine.split(/\s+/)[1]);
    if (!Number.isInteger(connectStatus) || connectStatus < 200 || connectStatus >= 300) {
      return { stage: 'connect', status: connectStatus || null, headers: {}, body: '', ms: elapsed() };
    }
    // The raw socket already has our readUntil listener attached; TLS must own the byte stream.
    raw.removeAllListeners('data');
    let stream = raw;
    if (secure) {
      const encrypted = await tlsReady(raw, host).catch(error => ({ error }));
      if (encrypted.error) {
        return { stage: 'tls', status: null, headers: {}, body: '', error: encrypted.error, ms: elapsed() };
      }
      stream = encrypted;
    }
    stream.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: application/json\r\n`
      + `Accept-Encoding: identity\r\nUser-Agent: ${USER_AGENT}\r\nConnection: close\r\n\r\n`
    );
    const response = await readAll(stream, MAX_BODY_BYTES);
    const split = response.indexOf('\r\n\r\n');
    const headText = split < 0 ? response.toString('latin1') : response.toString('latin1', 0, split);
    const bodyBuffer = split < 0 ? Buffer.alloc(0) : response.subarray(split + 4);
    const status = Number((headText.split('\r\n')[0] || '').split(/\s+/)[1]);
    const headers = parseHeaders(headText);
    let body = '';
    let decodeError = null;
    try { body = decodeBodyStrict(bodyBuffer, headers); } catch (error) { decodeError = error; }
    return {
      stage: 'http',
      status: Number.isInteger(status) ? status : null,
      headers,
      body,
      ...(decodeError ? { error: decodeError } : {}),
      ms: elapsed()
    };
  } catch (error) {
    return { stage: 'tls', status: null, headers: {}, body: '', error, ms: elapsed() };
  } finally {
    raw.destroy();
  }
}

// Cheap first step: is anything at all listening on the loopback port? Without it a dead proxy
// costs the full TLS timeout before the user learns the proxy client was never started.
function checkPort(port, timeoutMs = PORT_TIMEOUT_MS) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = ok => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => done(true));
  });
}

function interpret({ status, body, ms, error, stage }, { port } = {}) {
  const geoBlocked = typeof body === 'string' && body.includes(GEO_GATE);
  if (geoBlocked) {
    return {
      ok: false, code: CODES.GEO_BLOCKED, status, ms,
      message: messageFor(CODES.GEO_BLOCKED, { port, status, ms }),
      advice: adviceFor(CODES.GEO_BLOCKED, port),
      error: null
    };
  }
  // A refused CONNECT carries no body at all, so it has to be classified before the body
  // heuristics below — otherwise a proxy that answers "502" is reported as a non-Google response
  // and the user is told to change nodes when the real problem is the proxy's rule mode.
  if (stage === 'connect' && status !== null && status !== undefined) {
    return {
      ok: false, code: CODES.PROXY_REJECTED, status, ms,
      message: messageFor(CODES.PROXY_REJECTED, { port, status, ms }),
      advice: adviceFor(CODES.PROXY_REJECTED, port),
      error: null
    };
  }
  if (status === null || status === undefined) {
    const detail = String(error?.message || error || '');
    // 'timeout' is what the outer race substitutes; ETIMEDOUT is what the socket timeout raises.
    const timedOut = stage === 'timeout' || /ETIMEDOUT|timed out|Timeout/i.test(detail);
    // ECONNREFUSED on a loopback connect is the ordinary "proxy client is not running". Anything
    // else with no status means the proxy answered but the tunnel never completed — reporting that
    // as "本地代理未运行" would send the user hunting for a process that is already running.
    const refused = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EACCES|EPERM/i.test(detail);
    const code = timedOut ? CODES.TIMEOUT : refused ? CODES.PROXY_DOWN : CODES.PROXY_REJECTED;
    return {
      ok: false, code, status: null, ms,
      message: messageFor(code, { port, status: null, ms }),
      advice: adviceFor(code, port),
      error: error ? detail : null
    };
  }
  if ((stage === 'http' && error) || !looksLikeGoogleAnswer(status, body)) {
    return {
      ok: false, code: CODES.BAD_RESPONSE, status, ms,
      message: messageFor(CODES.BAD_RESPONSE, { port, status, ms }),
      advice: adviceFor(CODES.BAD_RESPONSE, port),
      error: null
    };
  }
  return {
    ok: true, code: CODES.OK, status, ms,
    message: messageFor(CODES.OK, { port, status, ms }),
    advice: '',
    error: null
  };
}

function result(interpreted, port, timeoutMs) {
  return {
    ok: interpreted.ok,
    code: interpreted.code,
    status: interpreted.status,
    ms: interpreted.ms,
    port,
    timeoutMs,
    at: Date.now(),
    message: interpreted.message,
    advice: interpreted.advice,
    error: interpreted.error,
    // Filled in by probeProxy only on a green probe; null everywhere else so the UI has one shape
    // to read and the field never goes missing between an ok and a failed result.
    egress: null
  };
}

// Where the proxy actually puts us. Google's Cloud Code gate judges the origin of the request, so
// this is the one fact that explains a 400 the preflight itself cannot see — and after a node
// switch it is the fastest way to confirm the fix actually took.
//
// Two sources, raced rather than chained. Both report the same exit address, so a slow or
// rate-limited service must not cost a second round trip: ipinfo.io is HTTPS and richest, and
// ip-api.com answers on plain HTTP because a proxy that will not CONNECT to port 80 must not be the
// reason a probe that already succeeded suddenly loses its exit label. The whole lookup is bounded
// and best-effort: it runs only after the main probe is green, and it never turns a working proxy
// into a failed one.
const EGRESS_SOURCES = [
  { name: 'ipinfo.io', host: 'ipinfo.io', port: 443, path: '/json', secure: true },
  { name: 'ip-api.com', host: 'ip-api.com', port: 80, path: '/json', secure: false }
];
const COUNTRY_NAMES = {
  CN: '中国', HK: '香港', TW: '台湾', JP: '日本', KR: '韩国', SG: '新加坡', US: '美国', CA: '加拿大',
  GB: '英国', DE: '德国', FR: '法国', NL: '荷兰', AU: '澳大利亚', IN: '印度', RU: '俄罗斯', TR: '土耳其'
};

function normalizeEgress(payload, source) {
  if (!payload || typeof payload !== 'object') return null;
  const ip = String(payload.ip || payload.query || '').trim();
  if (!ip) return null;
  // ipinfo sends country as the two-letter code; ip-api sends both the code and the long name.
  const code = String(payload.countryCode || payload.country || '').trim().toUpperCase();
  const long = String(payload.country || '').trim();
  return {
    ip,
    country: code.length === 2 ? code : '',
    countryName: COUNTRY_NAMES[code] || (long && long !== code ? long : code),
    region: String(payload.regionName || payload.region || '').trim(),
    city: String(payload.city || '').trim(),
    org: String(payload.as || payload.org || payload.isp || '').trim(),
    source
  };
}

// First source that yields an exit wins; the rest are abandoned rather than awaited. Rejections are
// folded to null so one broken service cannot cancel the others — the answer we want is the same
// from either, and a service that never answers must not withhold the one that did.
async function firstEgress(sources, request) {
  const pending = sources.map((source, index) => request(source)
    .then(value => ({ index, value }))
    .catch(() => ({ index, value: null })));
  const settled = new Set();
  while (settled.size < pending.length) {
    const next = await Promise.race(pending.filter((_, index) => !settled.has(index)));
    settled.add(next.index);
    if (next.value) return next.value;
  }
  return null;
}

async function lookupEgress({
  proxyPort,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tunnelRequest: tunnelRequestImpl = tunnelRequest,
  sources = EGRESS_SOURCES
} = {}) {
  const budget = Math.max(1000, Math.min(timeoutMs, 5000));
  let done = null;
  const guard = new Promise(resolve => { done = resolve; });
  // The socket timeout covers one request, but not a proxy that accepts the CONNECT and then goes
  // quiet — the same hang the main probe guards against.
  const timer = setTimeout(() => done(null), budget);
  try {
    return await Promise.race([firstEgress(sources, async source => {
      const response = await tunnelRequestImpl({
        proxyPort, host: source.host, port: source.port, path: source.path, timeoutMs, secure: source.secure
      });
      // A non-200 is not an answer: ipinfo rate-limits with a 429 whose body has no address in it,
      // so the source is skipped rather than reported as "exit unknown".
      if (response.stage !== 'http' || response.status === null) return null;
      let payload = null;
      try { payload = JSON.parse(response.body); } catch { return null; }
      return normalizeEgress(payload, source.name);
    }), guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the whole preflight. Both network steps are injectable so tests never touch the network.
 *
 * @param {object}  [options]
 * @param {number}  options.port          local proxy port to probe
 * @param {number} [options.timeoutMs]    per-step budget
 * @param {Function} [options.checkPort]  (port, timeoutMs) => Promise<boolean>
 * @param {Function} [options.tunnelRequest] (options) => Promise<{stage,status,headers,body,ms}>
 * @param {Function} [options.egressLookup] (options) => Promise<object|null>
 * @param {boolean} [options.skipPortCheck] skip the cheap loopback probe
 * @returns {Promise<object>} normalised probe result
 */
async function probeProxy({
  port,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  checkPort: checkPortImpl = checkPort,
  tunnelRequest: tunnelRequestImpl = tunnelRequest,
  egressLookup: egressLookupImpl = lookupEgress,
  skipPortCheck = false
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return result({
      ok: false, code: CODES.PROXY_DOWN, status: null, ms: 0,
      message: `代理端口无效：${port}`,
      advice: '请在 Go-Antigravity 设置里填写 1–65535 之间的端口',
      error: null
    }, port, timeoutMs);
  }
  if (!skipPortCheck && !await checkPortImpl(port, Math.min(timeoutMs, PORT_TIMEOUT_MS))) {
    return result({
      ok: false, code: CODES.PROXY_DOWN, status: null, ms: 0,
      message: messageFor(CODES.PROXY_DOWN, { port, status: null, ms: 0 }),
      advice: adviceFor(CODES.PROXY_DOWN, port),
      error: 'ECONNREFUSED'
    }, port, timeoutMs);
  }
  // Belt and braces: the socket timeout above only covers the CONNECT/TLS phases, so a proxy that
  // accepts the tunnel and then never answers would otherwise hang the launcher forever.
  let onTimeout = null;
  const guard = new Promise(resolve => { onTimeout = resolve; });
  const timer = setTimeout(
    () => onTimeout({ stage: 'timeout', status: null, headers: {}, body: '' }),
    timeoutMs + 500
  );
  const base = await (async () => {
    try {
      return result(interpret(await Promise.race([
        tunnelRequestImpl({ proxyPort: port, timeoutMs }),
        guard
      ]), { port, timeoutMs }), port, timeoutMs);
    } finally {
      // Clearing matters: an uncleared timer keeps this long-lived launcher's event loop alive for
      // the whole budget after a probe that already finished.
      clearTimeout(timer);
    }
  })();
  // The exit label is only worth a round trip once the tunnel is known good, and a failed probe has
  // nothing useful to say about the exit anyway.
  if (!base.ok) return base;
  const egress = await egressLookupImpl({ proxyPort: port, timeoutMs });
  return egress ? { ...base, egress } : base;
}

module.exports = {
  probeProxy,
  checkPort,
  tunnelRequest,
  lookupEgress,
  normalizeEgress,
  interpret,
  looksLikeGoogleAnswer,
  decodeBody,
  dechunk,
  parseHeaders,
  CODES,
  PROBE_HOST,
  PROBE_PATH,
  GEO_GATE,
  EGRESS_SOURCES,
  DEFAULT_TIMEOUT_MS,
  PORT_TIMEOUT_MS
};
