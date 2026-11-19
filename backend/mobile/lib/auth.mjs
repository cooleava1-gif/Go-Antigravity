import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'go_antigravity_mobile_session';
const LOGIN_LIMIT = 4096;
const SESSION_MS = 12 * 60 * 60 * 1000;
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function validatePin(pin) {
  if (typeof pin !== 'string' || !/^[a-zA-Z0-9]{8,64}$/.test(pin)) throw new Error('INVALID_PIN');
  return pin;
}
const page = Buffer.from(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity Pocket 登录</title><style>html{color-scheme:dark;font:16px system-ui;background:#11151c;color:#eef2f8}body{max-width:25rem;margin:12vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:14px;margin-top:12px;border-radius:10px;border:1px solid #4a576b}button{background:#b4d3ff;color:#12213b}p{line-height:1.6;color:#b7c1d0}</style><main><h1>Antigravity Pocket</h1><p>输入桌面“手机访问”面板显示的 PIN。请勿将 PIN 与访问地址一同公开。</p><form action="/pocket-login" method="post"><label for="pin">访问 PIN</label><input id="pin" name="token" type="password" autocomplete="current-password" minlength="8" maxlength="64" required autofocus><button type="submit">安全登录</button></form></main></html>`);
function finish(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(text);
}
export function createAuth({ pin, now = Date.now, timers = { setTimeout, clearTimeout } } = {}) {
  validatePin(pin);
  const sessions = new Map(), failures = new Map(), bindings = new WeakMap();
  let total = { start: now(), count: 0 }, disposed = false;
  function release(resource) {
    const binding = bindings.get(resource);
    if (!binding) return;
    bindings.delete(resource);
    resource.off('close', binding.detach);
    resource.off('finish', binding.detach);
    binding.session.resources.delete(resource);
    if (!binding.session.resources.size && binding.session.timer !== null) {
      timers.clearTimeout(binding.session.timer);
      binding.session.timer = null;
    }
  }
  function revoke(token) {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    if (session.timer !== null) timers.clearTimeout(session.timer);
    session.timer = null;
    for (const [resource, binding] of [...session.resources]) {
      release(resource);
      try { binding.cancel(); } catch {}
    }
  }
  function arm(token, session) {
    if (session.timer !== null || !session.resources.size) return;
    session.timer = timers.setTimeout(() => {
      session.timer = null;
      if (session.expires <= now()) revoke(token);
      else arm(token, session);
    }, Math.max(0, session.expires - now()));
    session.timer?.unref?.();
  }
  function authorize(req, resource, cancel = () => resource.destroy()) {
    if (disposed) return false;
    const cookies = String(req.headers.cookie || '').split(';');
    const values = cookies.filter(v => v.trim().startsWith(COOKIE + '=')).map(v => v.trim().slice(COOKIE.length + 1));
    const time = now();
    for (const [token, session] of sessions) {
      if (session.expires <= time) revoke(token);
      else if (values.length === 1 && constantTimeEqual(values[0], token)) {
        if (resource && !resource.destroyed && !resource.writableEnded && !bindings.has(resource)) {
          const binding = { session, cancel, detach: () => release(resource) };
          bindings.set(resource, binding);
          session.resources.set(resource, binding);
          resource.once('close', binding.detach);
          resource.once('finish', binding.detach);
          arm(token, session);
        }
        return true;
      }
    }
    return false;
  }
  function loginPage(req, res) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(req.method === 'HEAD' ? undefined : page);
  }
  function bucketFor(key) {
    const time = now();
    if (time - total.start >= 60000) total = { start: time, count: 0 };
    for (const [ip, item] of failures) if (time - item.start >= 60000) failures.delete(ip);
    return failures.get(key) || { start: time, count: 0 };
  }
  function limited(bucket) { return bucket.count >= 5 || total.count >= 100; }
  function rateLimit(res) { finish(res, 429, 'Too many attempts. Try again in one minute.', { 'retry-after': '60' }); }
  function failedAttempt(key, res, status, text) {
    const bucket = bucketFor(key);
    if (limited(bucket)) { rateLimit(res); return; }
    bucket.count++; total.count++; failures.delete(key); failures.set(key, bucket);
    if (failures.size > 512) failures.delete(failures.keys().next().value);
    if (!res.destroyed) finish(res, status, text);
  }
  async function login(req, res) {
    if (disposed) { finish(res, 503, 'Service unavailable'); return; }
    if (req.method !== 'POST') { finish(res, 405, 'Method not allowed', { allow: 'POST' }); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { finish(res, 403, 'Forbidden'); return; }
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) throw Error(); }
      catch { finish(res, 403, 'Forbidden'); return; }
    }
    // The listener is loopback-only. The aggregate bucket also bounds guesses when forwarded IPs change.
    const forwarded = String(req.headers['cf-connecting-ip'] || '');
    const key = /^[a-fA-F0-9:.]{3,64}$/.test(forwarded) ? forwarded : req.socket.remoteAddress || 'local';
    if (limited(bucketFor(key))) { rateLimit(res); return; }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/x-www-form-urlencoded' && type !== 'application/json') { finish(res, 415, 'Unsupported content type'); return; }
    try {
      if (Number(req.headers['content-length'] || 0) > LOGIN_LIMIT) { finish(res, 413, 'Request too large'); req.resume(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > LOGIN_LIMIT) { finish(res, 413, 'Request too large'); return; } chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const token = type === 'application/json' ? JSON.parse(raw).token : new URLSearchParams(raw).get('token');
      if (disposed) { finish(res, 503, 'Service unavailable'); return; }
      // Body reads yield: recheck and charge against the current buckets without another await.
      if (limited(bucketFor(key))) { rateLimit(res); return; }
      if (!constantTimeEqual(token, pin)) { failedAttempt(key, res, 401, 'PIN incorrect'); return; }
      failures.delete(key);
      const session = randomBytes(32).toString('base64url');
      sessions.set(session, { expires: now() + SESSION_MS, resources: new Map(), timer: null });
      while (sessions.size > 32) revoke(sessions.keys().next().value);
      // Secure is mandatory for tunnel HTTPS. Plain loopback HTTP remains usable for desktop health/login.
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      finish(res, 302, '', { location: '/', 'set-cookie': COOKIE + '=' + session + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + (secure ? '; Secure' : '') });
    } catch {
      // Malformed/aborted bodies count as failures; 403/413/415 rejections above do not.
      if (!res.writableEnded && !disposed) failedAttempt(key, res, 400, 'Invalid request');
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const token of [...sessions.keys()]) revoke(token);
    failures.clear();
  }
  return { authorize, release, login, loginPage, dispose };
}
