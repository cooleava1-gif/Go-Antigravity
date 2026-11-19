import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createAuth, validatePin } from './lib/auth.mjs';
import { createHandler } from './lib/http.mjs';
import { DesktopAdapter } from './lib/desktop.mjs';
import { createNativeProxy } from './lib/native-proxy.mjs';

export function createMobileServer({ pin = String(randomInt(10000000, 100000000)), adapter = new DesktopAdapter(), now, sessionTimers } = {}) {
  validatePin(pin);
  const auth = createAuth({ pin, now, timers: sessionTimers });
  const compatibility = createHandler({ adapter, authorize: auth.authorize });
  const native = createNativeProxy({ adapter, authorize: auth.authorize, release: auth.release });
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/pocket-login') {
        if (req.method === 'GET' || req.method === 'HEAD') auth.loginPage(req, res);
        else await auth.login(req, res);
        return;
      }
      if (!auth.authorize(req)) {
        const read = req.method === 'GET' || req.method === 'HEAD';
        const api = path === '/api' || path.startsWith('/api/') || path === '/mobile/api' || path.startsWith('/mobile/api/');
        const appPage = path === '/' || path === '/mobile' || path === '/mobile/' || path.startsWith('/c/');
        const navigation = req.headers['sec-fetch-dest'] === 'document' || req.headers['sec-fetch-mode'] === 'navigate' || /(?:^|,)\s*text\/html(?:\s*;|\s*,|$)/i.test(String(req.headers.accept || ''));
        if (read && !api && (appPage || navigation)) auth.loginPage(req, res);
        else { res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '请先完成 Pocket 登录' })); }
        return;
      }
      if (Number(req.headers['content-length'] || 0) > 16 * 1024 * 1024) { res.writeHead(413); res.end('Request too large'); req.resume(); return; }
      await (path === '/mobile' || path.startsWith('/mobile/') ? compatibility(req, res) : native.handle(req, res));
    })().catch(() => { if (!res.headersSent) res.writeHead(400, { 'cache-control': 'no-store' }); if (!res.writableEnded) res.end('Invalid request'); });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (req, socket, head) => { void native.upgrade(req, socket, head); });
  let disposed = false;
  function dispose() {
    if (disposed) return; disposed = true;
    auth.dispose(); compatibility.dispose(); native.dispose(); server.closeAllConnections();
  }
  const closeServer = server.close;
  server.close = function (...args) {
    // Native upgrades are not part of closeAllConnections; release them before close waits.
    dispose();
    return closeServer.apply(this, args);
  };
  server.once('close', dispose);
  async function close() {
    dispose();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  return { server, pin, close };
}
export async function startServer({ env = process.env, emit = value => console.log(JSON.stringify(value)) } = {}) {
  const runtime = createMobileServer({ pin: env.GO_ANTIGRAVITY_MOBILE_PIN || undefined });
  try { await new Promise((resolve, reject) => { runtime.server.once('error', reject); runtime.server.listen({ port: 3082, host: '127.0.0.1', exclusive: true }, resolve); }); }
  catch { await runtime.close(); throw new Error('SERVER_START_FAILED'); }
  emit({ ready: true, local: 'http://127.0.0.1:3082/', pin: runtime.pin, pid: process.pid });
  return runtime;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startServer().then(runtime => {
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (closing) return; closing = true; void runtime.close().then(() => { process.exitCode = 0; }); });
  }).catch(() => { console.log(JSON.stringify({ error: 'SERVER_START_FAILED' })); process.exitCode = 1; });
}
