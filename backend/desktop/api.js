const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { publicSettings } = require('../core/settings');
const { UPDATES_DISABLED, UPDATES_DISABLED_MESSAGE } = require('../features/updater');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 64 * 1024) throw new Error('请求内容过大');
  }
  return body ? JSON.parse(body) : {};
}

async function readMobileBody(request) {
  try { return await readBody(request); }
  catch { throw Object.assign(new Error('手机访问请求格式无效'), { status: 400 }); }
}

function serveFile(response, base, relative) {
  const target = path.resolve(base, relative);
  if (!target.startsWith(path.resolve(base) + path.sep)) return json(response, { ok: false, error: '无效路径' }, 403);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(response, { ok: false, error: '文件不存在' }, 404);
  response.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const stream = fs.createReadStream(target);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

// Serving index.html with the boot token inlined is the only way the page can prove it is the
// one the shell just loaded: the token never appears in a URL, a file on disk or a header that a
// stale tab could replay. EventSource cannot send headers, so /api/events accepts ?token= too.
const TOKEN_PLACEHOLDER = '<!--GO_ANTIGRAVITY_BOOT_TOKEN-->';
function serveIndex(response, base, token) {
  const target = path.resolve(base, 'index.html');
  let html;
  try {
    html = fs.readFileSync(target, 'utf8');
  } catch {
    return json(response, { ok: false, error: '文件不存在' }, 404);
  }
  if (html.includes(TOKEN_PLACEHOLDER)) {
    html = html.replace(TOKEN_PLACEHOLDER, `<script>window.__GO_ANTIGRAVITY_TOKEN__=${JSON.stringify(token)};</script>`);
  }
  response.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(html);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function createApi(app) {
  const streams = new Map();

  // Google redirects the browser here; the page renders the outcome and the account is added
  // before responding. Kept outside the route table so the token gate above can exempt it.
  const callbackPage = (title, detail, nonce, autoClose = false) => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>`
    + `<style nonce="${nonce}">body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e6e6;`
    + `display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}`
    + `.box{background:#1a1d24;border:1px solid #2a2e37;border-radius:12px;padding:32px 40px;max-width:420px;text-align:center}`
    + `h1{font-size:18px;margin:0 0 12px}p{font-size:13px;color:#9aa0aa;margin:0;line-height:1.7}</style></head>`
    + `<body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></div>`
    + (autoClose ? `<script nonce="${nonce}">setTimeout(function(){try{window.close();}catch(e){}},2000);</script>` : '')
    + `</body></html>`;

  const handleOAuthCallback = async (response, url) => {
    const nonce = randomBytes(18).toString('base64');
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    });
    const denied = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (denied) return response.end(callbackPage('授权未完成', `Google 返回：${denied}。请回到 Go-Antigravity 重新点击「授权添加」。`, nonce));
    if (!code || !state) return response.end(callbackPage('回调参数缺失', '链接中缺少 code 或 state，请重新发起授权。', nonce));
    try {
      const result = await app.completeOAuth({ code, state });
      const email = result.account?.email;
      return response.end(callbackPage('授权成功', `账户${email ? ` ${email} ` : ' '}已加入 Go-Antigravity 账户池；回到 Go-Antigravity 点击「切换」即可生效。`, nonce, true));
    } catch (error) {
      return response.end(callbackPage('授权失败', `${error.message}。请回到 Go-Antigravity 重新点击「授权添加」。`, nonce));
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
        return json(response, { ok: false, error: '无效的本地请求' }, 403);
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      const route = url.pathname;
      const method = request.method;
      const origin = request.headers.origin;
      if (method !== 'GET' && origin && origin !== `http://${host}`) {
        return json(response, { ok: false, error: '不允许跨站修改设置' }, 403);
      }
      if (method === 'GET' && route === '/') return serveIndex(response, app.rootDir, app.apiToken);
      if (method === 'GET' && route.startsWith('/assets/')) {
        return serveFile(response, path.join(app.rootDir, 'assets'), decodeURIComponent(route.slice('/assets/'.length)));
      }
      if (method === 'GET' && route === '/api/ping') { response.end('pong'); return; }
      // A browser redirected here from Google cannot carry our session token, and this is the
      // only browser-facing route that changes state. It is protected by the one-shot `state`
      // (10 min TTL, consumed on use) instead — without this exemption the whole OAuth flow
      // dead-ends on a 401 page.
      if (method === 'GET' && route === '/oauth-callback') return handleOAuthCallback(response, url);
      // Everything below is state-bearing: require the per-boot token handed to the page.
      const presented = request.headers['x-go-antigravity-token'] || url.searchParams.get('token') || '';
      if (!app.apiToken || presented !== app.apiToken) {
        return json(response, { ok: false, error: '本地会话已失效，请重新打开 Go-Antigravity 窗口' }, 401);
      }
      if (route === '/api/update') {
        return json(response, { ok: false, code: UPDATES_DISABLED, error: UPDATES_DISABLED_MESSAGE }, 410);
      }
      if (method === 'GET' && route === '/api/status') return json(response, app.status());
      if (method === 'GET' && route === '/api/logs') {
        const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10);
        return json(response, app.events.logs(Number.isFinite(limit) ? limit : 100));
      }
      if (method === 'GET' && route === '/api/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.write(': connected\n\n');
        const send = item => {
          if (response.destroyed) return;
          if (!response.write(`data: ${JSON.stringify(item)}\n\n`)) response.destroy();
        };
        app.events.on('message', send);
        streams.set(response, send);
        response.on('close', () => { app.events.off('message', send); streams.delete(response); });
        return;
      }
      if (method === 'POST' && route === '/api/config') {
        const data = await readBody(request);
        await app.configure(data);
        return json(response, { ok: true, settings: publicSettings(app.settings.get()) });
      }
      if (method === 'GET' && route === '/api/mobile/status') {
        return json(response, { ok: true, mobile: app.mobile.snapshot() });
      }
      if (method === 'POST' && route === '/api/mobile/start') {
        const data = await readMobileBody(request);
        if (!data || typeof data !== 'object' || Array.isArray(data)) return json(response, { ok: false, error: '请求内容必须是对象' }, 400);
        const mobile = await app.mobile.start({ pin: data.pin });
        return json(response, { ok: true, mobile });
      }
      if (method === 'POST' && route === '/api/mobile/stop') {
        const mobile = await app.mobile.stop('manual');
        return json(response, { ok: true, mobile });
      }
      if (method === 'POST' && route === '/api/mobile/config') {
        const mobile = app.configureMobile(await readMobileBody(request));
        return json(response, { ok: true, mobile });
      }
      if (method === 'GET' && route === '/api/kernel/status') {
        return json(response, { ok: true, kernel: app.kernelStatus() });
      }
      if (method === 'POST' && route === '/api/kernel/apply') {
        const data = await readBody(request);
        // Keep kernel changes behind POST and forward only the two supported setting keys.
        const kernelInput = {
          promptTier: data?.promptTier,
          contextMode: data?.contextMode
        };
        const result = await app.applyKernel(kernelInput);
        return json(response, { ok: true, ...result, kernel: app.kernelStatus() }, result.ok ? 200 : 409);
      }
      if (method === 'GET' && route === '/api/proxy/status') {
        return json(response, { ok: true, proxy: app.proxyStatus() });
      }
      if (method === 'POST' && route === '/api/proxy/check') {
        // Same probe the launcher runs before spawning AG, exposed so the user can verify the
        // exit without launching anything.
        //
        // Always 200, deliberately unlike /api/kernel/apply: "geo-blocked" is this endpoint's
        // expected output, not a failure to perform the check. Answering 409 would make the shared
        // request() helper throw the verdict away — and the verdict is the entire point.
        const probe = await app.proxyCheck('manual');
        return json(response, { ok: true, probe, proxy: app.proxyStatus() });
      }
      if (method === 'POST' && route === '/api/launch') {
        const result = await app.session.launch();
        return json(response, result, result.ok ? 200 : 409);
      }
      if (method === 'GET' && route === '/api/accounts') {
        return json(response, { ok: true, accounts: await app.accountsSnapshot() });
      }
      // Masked export stays a plain GET; the full-token export is a POST that must spell out
      // its intent, so nothing can pull every refresh token with a stray `?tokens=1` URL.
      if (method === 'GET' && route === '/api/accounts/export') {
        return json(response, { ok: true, ...app.exportAccounts({ includeTokens: false }) });
      }
      if (method === 'POST' && route === '/api/accounts/export') {
        const data = await readBody(request);
        const includeTokens = data?.includeTokens === true;
        if (includeTokens && data?.confirm !== 'export-tokens') {
          return json(response, { ok: false, error: '导出完整令牌需要显式确认（confirm: "export-tokens"）' }, 400);
        }
        if (includeTokens) {
          const total = app.exportAccounts({ includeTokens: false }).count;
          app.events.log('SYSTEM', `已导出含完整 refresh_token 的账户池（${total} 个账户），请注意保管`, 'tag-warn');
        }
        return json(response, { ok: true, ...app.exportAccounts({ includeTokens }) });
      }
      if (method === 'POST' && route === '/api/accounts/select') {
        const data = await readBody(request);
        return json(response, { ok: true, accounts: app.selectAccount(data.id) });
      }
      if (method === 'POST' && route === '/api/accounts/switch') {
        const data = await readBody(request);
        const result = await app.switchAccount(data.id);
        return json(response, { ok: true, ...result });
      }
      if (method === 'POST' && route === '/api/accounts/capture') {
        const result = await app.captureCurrentAccount();
        return json(response, { ok: true, accounts: result });
      }
      if (method === 'POST' && route === '/api/accounts/add') {
        const data = await readBody(request);
        const accounts = await app.addAccount(data);
        return json(response, { ok: true, accounts });
      }
      if (method === 'POST' && route === '/api/accounts/oauth/start') {
        const data = await readBody(request);
        const result = await app.startOAuth({
          openBrowser: data?.openBrowser !== false,
          loginHint: typeof data?.loginHint === 'string' ? data.loginHint : null,
          accountId: typeof data?.accountId === 'string' ? data.accountId : null
        });
        return json(response, { ok: true, ...result });
      }
      if (method === 'POST' && route === '/api/accounts/oauth/submit') {
        const data = await readBody(request);
        const result = await app.completeOAuth(data);
        return json(response, { ok: true, ...result });
      }
      if (method === 'POST' && route === '/api/accounts/oauth/cancel') {
        return json(response, app.cancelOAuth());
      }
      if (method === 'POST' && route === '/api/accounts/quota') {
        const data = await readBody(request);
        // "all" is a long serial job; it now returns a task handle immediately and streams
        // progress over /api/events instead of blocking the request past the UI timeout.
        if (data.all) return json(response, { ok: true, ...app.startQuotaRefreshAll() });
        const result = await app.refreshAccountQuota(data.id);
        return json(response, { ok: true, ...result });
      }
      if (method === 'POST' && route === '/api/accounts/quota/refresh-all') {
        return json(response, { ok: true, ...app.startQuotaRefreshAll() });
      }
      if (method === 'POST' && route === '/api/accounts/remove') {
        const data = await readBody(request);
        return json(response, { ok: true, accounts: app.removeAccount(data.id) });
      }
      if (method === 'POST' && route === '/api/theme') {
        const data = await readBody(request);
        if (data.theme === 'light' || data.theme === 'dark') app.host.setTheme?.(data.theme);
        return json(response, { ok: true });
      }
      if (method === 'POST' && route === '/api/hide') { app.host.hide(); return json(response, { ok: true }); }
      if (method === 'POST' && route === '/api/quit') {
        json(response, { ok: true });
        void app.close('收到退出请求');
        return;
      }
      return json(response, { ok: false, error: 'not found', url: request.url }, 404);
    } catch (error) {
      app.events.log('SYSTEM', error.message, 'tag-warn');
      if (!response.headersSent) json(response, { ok: false, error: error.message }, error.status || 400);
      else response.end();
    }
  });
  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
      });
    },
    close() {
      for (const [response, send] of streams) {
        app.events.off('message', send);
        response.end();
      }
      streams.clear();
      server.close();
      server.closeIdleConnections();
    }
  };
}

module.exports = { createApi };
