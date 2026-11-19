import { request } from 'node:http';
import { DesktopAdapter } from './desktop.mjs';
import { NATIVE_I18N_PATH, nativeI18nSource, injectChineseLocalization } from './native-i18n.mjs';

const NATIVE_I18N_BYTES = Buffer.from(nativeI18nSource);

const HANDSHAKE_TIMEOUT = 20_000;
const MAX_HTML_BYTES = 16 * 1024 * 1024;
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function httpHeaders(source) {
 const headers = { ...source };
 const nominated = String(headers.connection || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
 for (const name of [...HOP_HEADERS, ...nominated]) delete headers[name];
 return headers;
}

function singleHeader(req, name) {
 const value = req.headers[name];
 let count = 0;
 for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
 return count > 1 || (value !== undefined && typeof value !== 'string') ? null : value;
}

function trustedSource(req) {
 const host = singleHeader(req, 'host');
 const origin = singleHeader(req, 'origin');
 const site = singleHeader(req, 'sec-fetch-site');
 if (!host || origin === null || site === null) return false;
 // Same-site siblings can send Strict cookies, but must never receive native CSRF privileges.
 if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
 if (site === 'none' && req.method !== 'GET' && req.method !== 'HEAD') return false;
 // Non-browser/local clients may omit both headers; supplied Origin is always checked.
 if (origin === undefined) return true;
 try {
  const source = new URL(origin);
  if (source.origin !== origin || source.host !== host.toLowerCase()) return false;
  // Public phone access is HTTPS through the tunnel. Do not trust forwarded host/protocol.
  return source.protocol === 'https:' || (source.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(source.hostname));
 } catch { return false; }
}

function upstreamHeaders(req, base, token, websocket = false) {
 const headers = websocket ? { ...req.headers } : httpHeaders(req.headers);
 headers.host = base.host;
 headers.origin = base.origin;
 headers['x-codeium-csrf-token'] = token;
 headers['accept-encoding'] = 'identity';
 // Pocket credentials belong to this gateway, never to the native upstream.
 if (headers.cookie) {
  const cookies = headers.cookie.split(';').filter(value => !value.trim().startsWith('goagy_pocket_session='));
  if (cookies.length) headers.cookie = cookies.join(';');
  else delete headers.cookie;
 }
 if (headers.referer) {
  try {
   const ref = new URL(headers.referer);
   headers.referer = base.origin + ref.pathname + ref.search + ref.hash;
  } catch { delete headers.referer; }
 }
 return headers;
}

function endpoint(value) {
 const base = new URL(value?.base);
 if (base.protocol !== 'http:' || base.username || base.password || typeof value.token !== 'string' || !value.token) throw new Error('Invalid native endpoint');
 return { base, token: value.token };
}

function jsonEnd(text, start) {
 let depth = 0, quoted = false, escaped = false;
 for (let i = start; i < text.length; i++) {
  const c = text[i];
  if (quoted) {
   if (escaped) escaped = false;
   else if (c === '\\') escaped = true;
   else if (c === '"') quoted = false;
  } else if (c === '"') quoted = true;
  else if (c === '{' || c === '[') depth++;
  else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
 }
 throw new Error('Invalid native app configuration');
}

// Only the server-produced JSON bootstrap changes; module scripts and asset URLs do not.
function rewriteHtml(bytes, token) {
 const html = bytes.toString('utf8');
 const assignment = /\bwindow\s*\.\s*__APP_CONFIG__\s*=\s*/g;
 let out = '', cursor = 0, match;
 while ((match = assignment.exec(html))) {
  const start = assignment.lastIndex;
  if (html[start] !== '{') throw new Error('Invalid native app configuration');
  const end = jsonEnd(html, start);
  const config = JSON.parse(html.slice(start, end));
  config.csrfToken = token;
  const json = JSON.stringify(config).replace(/[<>&\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  out += html.slice(cursor, start) + json;
  cursor = end;
  assignment.lastIndex = end;
 }
 return cursor ? Buffer.from(out + html.slice(cursor)) : bytes;
}

function sendError(res, status) {
 if (res.destroyed || res.writableEnded) return;
 if (res.headersSent) { res.destroy(); return; }
 const body = Buffer.from(status === 401 ? 'Pocket authentication required' : status === 403 ? 'Forbidden' : 'Native frontend unavailable');
 res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
 res.end(body);
}

function socketError(socket, status) {
 if (socket.destroyed || socket.writableEnded) return;
 const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 503 ? 'Service Unavailable' : status === 504 ? 'Gateway Timeout' : 'Bad Gateway';
 socket.end('HTTP/1.1 ' + status + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n');
}

function responseHead(res) {
 let text = 'HTTP/' + res.httpVersion + ' ' + res.statusCode + ' ' + (res.statusMessage || '') + '\r\n';
 for (let i = 0; i < res.rawHeaders.length; i += 2) text += res.rawHeaders[i] + ': ' + res.rawHeaders[i + 1] + '\r\n';
 return text + '\r\n';
}

export function createNativeProxy({ adapter = new DesktopAdapter(), authorize = () => false, release = () => {} } = {}) {
 const active = new Set();
 let disposed = false;

 async function handle(req, res) {
  let upstream, incoming, timer, stopped = false;
  const cleanup = () => {
   if (stopped) return;
   stopped = true;
   clearTimeout(timer);
   active.delete(cancel);
   release(res);
   req.off('aborted', cancel);
   req.off('error', cancel);
   res.off('close', onClose);
   res.off('finish', cleanup);
  };
  const cancel = () => {
   if (stopped) return;
   cleanup();
   upstream?.destroy();
   incoming?.destroy();
   res.destroy();
  };
  const fail = (status = 502) => {
   if (stopped) return;
   cleanup();
   upstream?.destroy();
   incoming?.destroy();
   sendError(res, status);
  };
  const onClose = () => { if (!res.writableFinished) cancel(); };
  active.add(cancel);
  req.once('aborted', cancel);
  req.once('error', cancel);
  res.once('close', onClose);
  res.once('finish', cleanup);
  try {
   if (!await authorize(req, res, cancel)) { if (!stopped) { cleanup(); sendError(res, 401); } return; }
   if (stopped || res.writableEnded || res.destroyed) { cleanup(); return; }
   if (!trustedSource(req)) { fail(403); return; }
   if (disposed) { fail(503); return; }
   const path = req.url || '/';
   const url = new URL(path, 'http://pocket.local');
   if (url.pathname === NATIVE_I18N_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
     res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store', 'content-length': 0 });
     res.end();
     return;
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': NATIVE_I18N_BYTES.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : NATIVE_I18N_BYTES);
    return;
   }
   const appNavigation = url.pathname === '/' || url.pathname.startsWith('/c/') || req.headers['sec-fetch-dest'] === 'document';
   if (req.method === 'GET' && appNavigation && !url.searchParams.has('wsTransport') && !url.searchParams.has('useWebSocket')) {
    const location = path + (path.includes('?') ? (path.endsWith('?') || path.endsWith('&') ? '' : '&') : '?') + 'wsTransport=3';
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
    return;
   }
   const ep = endpoint(await adapter.discover());
   if (stopped || disposed || res.destroyed) { cancel(); return; }
   upstream = request({ protocol: 'http:', hostname: ep.base.hostname, port: ep.base.port || 80, method: req.method, path, headers: upstreamHeaders(req, ep.base, ep.token), agent: false });
   timer = setTimeout(() => fail(504), HANDSHAKE_TIMEOUT);
   timer.unref?.();
   upstream.once('error', () => fail());
   upstream.once('response', response => {
    if (stopped) { response.destroy(); return; }
    clearTimeout(timer);
    incoming = response;
    response.once('error', () => fail());
    response.once('aborted', () => fail());
    const headers = httpHeaders(response.headers);
    const html = /^text\/html(?:;|$)/i.test(String(headers['content-type'] || ''));
    if (html) {
     headers['cache-control'] = 'no-store';
     for (const name of ['etag', 'last-modified', 'expires', 'content-md5', 'digest', 'content-length']) delete headers[name];
     if (req.method === 'HEAD') {
      res.writeHead(response.statusCode || 502, headers);
      response.resume();
      res.end();
      return;
     }
     if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') { fail(); return; }
     let size = 0;
     const chunks = [];
     response.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_HTML_BYTES) { fail(); return; }
      chunks.push(chunk);
     });
     response.once('end', () => {
      if (stopped) return;
      try {
       const bytes = injectChineseLocalization(rewriteHtml(Buffer.concat(chunks), ep.token));
       headers['content-length'] = bytes.length;
       res.writeHead(response.statusCode || 502, headers);
       res.end(bytes);
      } catch { fail(); }
     });
    } else {
     res.writeHead(response.statusCode || 502, headers);
     response.pipe(res);
    }
   });
   let requestBytes = 0;
   req.on('data', chunk => { requestBytes += chunk.length; if (requestBytes > 16 * 1024 * 1024) { req.unpipe(upstream); fail(413); req.resume(); } });
   req.pipe(upstream);
  } catch { fail(); }
 }

 async function upgrade(req, socket, head = Buffer.alloc(0)) {
  let upstream, peer, timer, stopped = false, upgraded = false;
  socket.pause();
  const cleanup = () => {
   if (stopped) return;
   stopped = true;
   clearTimeout(timer);
   active.delete(cancel);
   release(socket);
   socket.off('close', cancel);
   socket.off('end', cancel);
  };
  const cancel = () => {
   if (stopped) return;
   cleanup();
   upstream?.destroy();
   peer?.destroy();
   socket.destroy();
  };
  const fail = (status = 502) => {
   if (stopped) return;
   cleanup();
   upstream?.destroy();
   peer?.destroy();
   if (upgraded) socket.destroy();
   else socketError(socket, status);
  };
  active.add(cancel);
  socket.once('error', cancel);
  socket.once('close', cancel);
  socket.once('end', cancel);
  try {
   if (!await authorize(req, socket, cancel)) { if (!stopped) { cleanup(); socketError(socket, 401); } return; }
   if (stopped || socket.destroyed) { cleanup(); return; }
   if (!trustedSource(req)) { fail(403); return; }
   if (disposed) { fail(503); return; }
   const ep = endpoint(await adapter.discover());
   if (stopped || disposed || socket.destroyed) { cancel(); return; }
   upstream = request({ protocol: 'http:', hostname: ep.base.hostname, port: ep.base.port || 80, method: req.method || 'GET', path: req.url || '/', headers: upstreamHeaders(req, ep.base, ep.token, true), agent: false });
   timer = setTimeout(() => fail(504), HANDSHAKE_TIMEOUT);
   timer.unref?.();
   upstream.once('error', () => fail());
   // A ClientRequest can emit close before or just after upgrade: only sockets own the tunnel lifecycle.
   upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
    if (stopped) { upstreamSocket.destroy(); return; }
    clearTimeout(timer);
    upgraded = true;
    peer = upstreamSocket;
    peer.setTimeout(0);
    socket.setTimeout(0);
    peer.setNoDelay(true);
    socket.setNoDelay(true);
    peer.once('error', cancel);
    peer.once('close', cancel);
    peer.once('end', cancel);
    socket.write(responseHead(response));
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(peer);
    peer.pipe(socket);
    socket.resume();
    peer.resume();
   });
   upstream.once('response', response => {
    clearTimeout(timer);
    response.resume();
    fail(response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502);
   });
   // Send a coalesced browser first frame after HTTP headers, even when the upstream waits for it.
   if (head.length) upstream.once('finish', () => { if (!stopped) upstream.socket?.write(head); });
   upstream.end();
  } catch { fail(); }
 }

 function dispose() {
  if (disposed) return;
  disposed = true;
  for (const cancel of [...active]) cancel();
 }
 return { handle, upgrade, dispose };
}
