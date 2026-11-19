'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApi } = require('../desktop/api');
const { createApplication } = require('../desktop/application');
const { createSettings, normalizeSettings } = require('../core/settings');
const TOKEN = 'mobile-integration-boot-token';
function request(port, route, { method = 'GET', body, token = TOKEN, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Go-Antigravity-Token'] = token;
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body);
  });
}
function stub() {
  const calls = []; const logs = [];
  const snapshot = { state: 'running', publicUrl: 'https://mobile.example.com', localUrl: 'http://127.0.0.1:3082/', pin: '12345678', autoStart: false, managed: true };
  return { apiToken: TOKEN, rootDir: path.join(__dirname, '..'), calls, logs,
    events: { log: (...args) => logs.push(args), on() {}, off() {} },
    mobile: { snapshot: () => snapshot, start: async input => { calls.push(['start', input]); return snapshot; }, stop: async reason => { calls.push(['stop', reason]); return snapshot; } },
    configureMobile(input) { calls.push(['config', input]); return { ...snapshot, autoStart: input.autoStart }; }
  };
}
async function withApi(app, run) { const api = createApi(app); const port = await api.listen(0); try { await run(port); } finally { api.close(); } }
test('mobile endpoints require boot token and reject cross-origin writes', async () => {
  const app = stub(); await withApi(app, async port => {
    for (const [route, method] of [['status', 'GET'], ['start', 'POST'], ['stop', 'POST'], ['config', 'POST']]) {
      const denied = await request(port, '/api/mobile/' + route, { method, token: null, body: method === 'POST' ? '{}' : undefined });
      assert.equal(denied.status, 401);
    }
    const denied = await request(port, '/api/mobile/start', { method: 'POST', body: '{}', origin: 'https://example.invalid' });
    assert.equal(denied.status, 403); assert.equal(app.calls.length, 0);
  });
});
test('mobile routes wrap snapshots and pass only expected lifecycle inputs', async () => {
  const app = stub(); await withApi(app, async port => {
    const status = await request(port, '/api/mobile/status'); assert.equal(status.status, 200); assert.equal(status.data.mobile.state, 'running');
    const start = await request(port, '/api/mobile/start', { method: 'POST', body: JSON.stringify({ pin: '12345678', ignored: 'value' }) });
    assert.equal(start.data.ok, true); assert.equal(start.data.mobile.pin, '12345678');
    const stop = await request(port, '/api/mobile/stop', { method: 'POST', body: '{}' }); assert.equal(stop.data.ok, true);
    const config = await request(port, '/api/mobile/config', { method: 'POST', body: JSON.stringify({ autoStart: true }) }); assert.equal(config.data.mobile.autoStart, true);
    assert.deepEqual(app.calls, [['start', { pin: '12345678' }], ['stop', 'manual'], ['config', { autoStart: true }]]);
    assert.equal(app.logs.length, 0);
  });
});
test('malformed mobile bodies cannot leak a PIN through API logs', async () => {
  const app = stub(); await withApi(app, async port => {
    for (const route of ['start', 'config']) {
      const response = await request(port, '/api/mobile/' + route, { method: 'POST', body: '{pin:12345678' });
      assert.equal(response.status, 400); assert.equal(response.data.error, '手机访问请求格式无效');
    }
    assert.equal(JSON.stringify(app.logs).includes('12345678'), false);
    const response = await request(port, '/api/mobile/start', { method: 'POST', body: '[]' }); assert.equal(response.status, 400);
    assert.equal(app.calls.length, 0);
  });
});
test('mobile autostart is opt-in, persists, and does not persist PIN', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-mobile-settings-'));
  try { const file = path.join(dir, 'settings.json'); const settings = createSettings(file);
    assert.equal(settings.get().mobileAutoStart, false); settings.update({ mobileAutoStart: true, pin: '12345678' });
    assert.equal(createSettings(file).get().mobileAutoStart, true); assert.equal(fs.readFileSync(file, 'utf8').includes('12345678'), false);
    assert.throws(() => normalizeSettings({ mobileAutoStart: 'yes' }), /mobileAutoStart/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('real application exposes protected mobile API and test mode starts no child', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-mobile-app-'));
  const app = await createApplication({ rootDir: path.join(__dirname, '..'), dataDir: dir, testMode: true });
  try {
    assert.equal(typeof app.configureMobile, 'function'); assert.equal(typeof app.mobile.close, 'function');
    assert.equal(app.status().mobile.autoStart, false);
    assert.equal(app.status().mobile.mode, 'quick');
    assert.equal(app.status().mobile.publicUrl, null);
    const port = await app.api.listen(0);
    const configured = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify({ autoStart: true }) });
    assert.equal(configured.status, 200); assert.equal(configured.data.mobile.autoStart, true);
    const invalid = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify({ autoStart: 'true' }) }); assert.equal(invalid.status, 400);
    const changed = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify({ mode: 'fixed', fixedUrl: 'https://remote.example.com/' }) });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.mobile.mode, 'fixed');
    assert.equal(changed.data.mobile.fixedUrl, 'https://remote.example.com');
    for (const input of [{ mode: 'evil' }, { fixedUrl: 'http://remote.example.com' }, { fixedUrl: 'https://user:pass@remote.example.com' }, { fixedUrl: 'https://remote.example.com/path' }, { mode: 'quick', ignored: true }, {}]) {
      const rejected = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify(input) });
      assert.equal(rejected.status, 400);
      assert.equal(app.status().mobile.mode, 'fixed');
    }
    const mutable = app.mobile.assertConfigMutable;
    app.mobile.assertConfigMutable = () => { throw Object.assign(new Error('active configuration'), { status: 409 }); };
    const locked = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify({ mode: 'quick' }) });
    assert.equal(locked.status, 409);
    await assert.rejects(app.configure({ mobileMode: 'quick' }), /active configuration/);
    const allowed = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify({ autoStart: false }) });
    assert.equal(allowed.status, 200);
    app.mobile.assertConfigMutable = mutable;
    const reset = await request(port, '/api/mobile/config', { token: app.apiToken, method: 'POST', body: JSON.stringify({ mode: 'quick' }) });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.mobile.mode, 'quick');
    const started = await request(port, '/api/mobile/start', { token: app.apiToken, method: 'POST', body: '{}' });
    assert.notEqual(started.data.mobile?.state, 'running'); assert.notEqual(app.mobile.snapshot().managed, true);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8').includes('pin'), false);
  } finally { await app.close('mobile integration test'); fs.rmSync(dir, { recursive: true, force: true }); }
});
