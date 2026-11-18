'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { CdpHub, workbenchKey } = require('../adapters/desktop/cdp');
const { Session } = require('../core/session');
const vm = require('node:vm');
const { healthSource } = require('../adapters/desktop/renderer');
const { desktopRunning } = require('../adapters/desktop/discovery');

function probeDocument({ readyState = 'complete', hidden = false, tag, className = '', attrs = {}, text = '', textTag = 'span', background = 'transparent', backgroundImage = 'none', pseudo = 'none', bodyPseudo = 'none', shadow = false, count = 1, body = true } = {}) {
  const ignored = new Set(['script', 'style', 'template', 'noscript']);
  const controlTags = new Set(['input', 'textarea', 'select', 'button', 'iframe', 'webview', 'canvas', 'svg', 'img', 'video', 'audio', 'object', 'embed']);
  const classes = new Set(['monaco-editor', 'welcomePage', 'error', 'error-message', 'notification-toast', 'progress', 'loading']);
  const element = { localName: tag || 'div', shadowRoot: shadow ? {} : null, matches: () => ignored.has(tag), getClientRects: () => [1] };
  const bodyElement = { localName: 'body', isRoot: true, matches: () => false, getClientRects: () => [1], querySelectorAll: () => Array(count).fill(element) };
  let position = 0;
  const nodes = text ? [{ nodeValue: text, parentElement: { closest: () => ignored.has(textTag) } }] : [];
  return {
    window: { location: { href: 'vscode-file://vscode-app/synthetic/workbench.html' }, performance: { timeOrigin: 1 }, NodeFilter: { SHOW_TEXT: 4 },
      getComputedStyle: (_element, kind) => ({ content: kind ? (_element.isRoot ? bodyPseudo : pseudo) : 'normal', backgroundImage, backgroundColor: background, display: 'block', visibility: 'visible' }) },
    document: { readyState, hidden, body: body ? bodyElement : null,
      querySelector(selector) {
        assert.ok(selector.includes('input,textarea,select,button'));
        assert.ok(selector.includes('[contenteditable]:not([contenteditable="false"])'));
        return controlTags.has(tag) || (tag === 'a' && 'href' in attrs) || classes.has(className)
          || ('role' in attrs) || attrs['aria-busy'] === 'true' || ('contenteditable' in attrs && attrs.contenteditable !== 'false') ? element : null;
      },
      createTreeWalker: () => ({ nextNode() { this.currentNode = nodes[position++]; return !!this.currentNode; } }) }
  };
}

function evaluateProbe(options) { return vm.runInNewContext(healthSource, probeDocument(options)); }

async function fixture(t, { pageUrl = 'vscode-file://vscode-app/c:/synthetic/out/vs/code/electron-browser/workbench/workbench.html', state = 'blank' } = {}) {
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const commands = [];
  const model = { state, reloads: 0, documentId: 1, pageUrl, probes: 0 };
  ws.on('connection', socket => socket.on('message', async data => {
    const request = JSON.parse(String(data));
    commands.push(request);
    let result = {};
    if (request.method === 'Inspector.enable' && model.noInspector) {
      socket.send(JSON.stringify({ id: request.id, error: { message: 'Inspector domain unavailable' } })); return;
    }
    if (request.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'main' } } };
    if (request.method === 'Page.addScriptToEvaluateOnNewDocument') result = { identifier: 'synthetic-script' };
    if (request.method === 'Runtime.evaluate' && !request.params.returnByValue && model.crashOnInject && request.params.expression === 'void 0;') {
      socket.send(JSON.stringify({ method: 'Inspector.targetCrashed', params: {} }));
      socket.send(JSON.stringify({ id: request.id, error: { message: 'synthetic renderer crashed during injection' } })); return;
    }
    if (request.method === 'Runtime.evaluate' && request.params.returnByValue) {
      model.probes++;
      if (model.beforeProbe) await model.beforeProbe(socket);
      if (model.rejectProbe) { socket.send(JSON.stringify({ id: request.id, error: { message: 'synthetic probe rejected' } })); return; }
      let value;
      if (model.dom) {
        const context = probeDocument(model.dom);
        context.window.location.href = model.pageUrl;
        context.window.performance.timeOrigin = model.documentId;
        value = vm.runInNewContext(request.params.expression, context);
      } else value = { state: model.state, url: model.pageUrl, documentId: model.documentId };
      result = { result: { value } };
    }
    if (request.method === 'Page.reload') model.reloads++;
    socket.send(JSON.stringify({ id: request.id, result }));
  }));
  const target = { type: 'page', url: pageUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/page/synthetic' };
  let now = 0;
  const hub = new CdpHub({ source: () => 'void 0;', discover: async () => [target], now: () => now, blankGraceMs: 100 });
  hub.running = true;
  t.after(async () => { await hub.stop(); for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  return { hub, model, commands, target, ws, advance: ms => { now += ms; } };
}

test('recovery allowlist accepts only known local workbench documents', () => {
  for (const url of ['file:///c:/synthetic/workbench.html', 'vscode-file://vscode-app/c:/synthetic/workbench-jetski.html', 'app://local/workbench.desktop.main.html']) {
    assert.equal(workbenchKey(url + '?update=1#main'), url);
  }
  for (const url of ['https://example.invalid/workbench.html', 'http://localhost/workbench.html', 'about:blank', 'file:///c:/synthetic/auth.html', 'app://local/custom-workbench.html', 'invalid']) {
    assert.equal(workbenchKey(url), null, url);
  }
  assert.equal(new CdpHub({ source: () => '' }).blankGraceMs, 15000);
});

test('optional Inspector domain failure preserves injection and blank recovery', async t => {
  const { hub, model, advance } = await fixture(t);
  model.noInspector = true; await hub.tick();
  assert.equal(hub.status.injectCount, 1);
  advance(100); await hub.tick(); assert.equal(model.reloads, 1);
});

test('confirmed empty workbench gets one renderer reload after startup grace', async t => {
  const { hub, model, advance } = await fixture(t);
  await hub.tick();
  assert.equal(model.reloads, 0);
  advance(99); await hub.tick();
  assert.equal(model.reloads, 0);
  advance(1); await hub.tick();
  assert.equal(model.reloads, 1, 'an attached but empty completed workbench needs bounded renderer recovery');
  advance(1000); await hub.tick(); await hub.tick();
  assert.equal(model.reloads, 1, 'persistent blankness must not create a reload loop');
});

for (const [label, options] of [
  ['healthy workbench', { state: 'content' }],
  ['still loading workbench', { state: 'loading' }],
  ['auth page', { pageUrl: 'vscode-file://vscode-app/c:/synthetic/auth.html' }],
  ['external page', { pageUrl: 'https://example.invalid/workbench.html' }]
]) test(label + ' is never reloaded', async t => {
  const { hub, model, advance } = await fixture(t, options);
  await hub.tick(); advance(1000); await hub.tick(); advance(1000); await hub.tick();
  assert.equal(model.reloads, 0);
});

function sessionFixture({ running = async () => true, wait = async () => {} } = {}) {
  const child = new EventEmitter(); child.pid = 42; child.exitCode = null; child.kill = () => { throw new Error('no process restart is permitted'); };
  let starts = 0, stops = 0, startsHook = 0, exitsHook = 0;
  const cdp = { port: 9333, start() { starts++; }, async stop() { stops++; } };
  const session = new Session({ settings: { get: () => ({ port: 7890 }) }, desktop: { locate: () => ({ appExe: 'synthetic.exe', exists: true }), running: async () => false },
    cdp, onStart: () => { startsHook++; }, onExit: () => { exitsHook++; }, events: { log() {}, publish() {} }, host: { hide() {} }, spawnProcess: () => { queueMicrotask(() => child.emit('spawn')); return child; }, wait });
  return { session, child, cdp, running, stats: () => ({ starts, stops, startsHook, exitsHook }) };
}

test('update process handoff retains CDP and monitors replacement without respawn', async () => {
  const { session, child, running, stats } = sessionFixture();
  assert.equal((await session.launch()).ok, true);
  session.desktop.running = running;
  child.emit('exit');
  await session.handoffPromise;
  assert.equal(stats().startsHook, 1, 'an update handoff must not re-run startup credential/kernel hooks');
  assert.equal(session.phase, 'running', 'original child exit is not application exit during an updater handoff');
  assert.equal(stats().stops, 0);
  assert.ok(session.monitor, 'replacement process needs exit monitoring');
  await session.close('synthetic cleanup');
});

test('actual health probe classifies only complete empty documents as blank', () => {
  assert.equal(evaluateProbe({}).state, 'blank');
  assert.equal(evaluateProbe({ text: 'bootstrap()', textTag: 'script', tag: 'script' }).state, 'blank');
  for (const options of [
    { readyState: 'loading' }, { readyState: 'interactive' }, { hidden: true }, { body: false }
  ]) assert.equal(evaluateProbe(options).state, 'loading');
  for (const tag of ['input', 'textarea', 'select', 'button', 'iframe', 'webview', 'canvas', 'svg', 'img', 'video', 'audio', 'object', 'embed']) {
    assert.equal(evaluateProbe({ tag }).state, 'content', tag);
  }
  for (const options of [
    { text: 'Welcome' }, { text: 'Sign in' }, { text: 'Error starting application' },
    { attrs: { contenteditable: '' } }, { attrs: { contenteditable: 'true' } },
    { attrs: { role: 'textbox' } }, { attrs: { 'aria-busy': 'true' } },
    { tag: 'a', attrs: { href: '#login' } }, { className: 'monaco-editor' },
    { className: 'welcomePage' }, { className: 'error' }, { className: 'loading' },
    { background: 'rgb(255, 255, 255)' }, { backgroundImage: 'url(synthetic.png)' },
    { pseudo: '"Loading"' }, { count: 201 }
  ]) assert.equal(evaluateProbe(options).state, 'content', JSON.stringify(options));
});

test('body generated UI and shadow/custom elements prevent blank recovery', () => {
  for (const options of [{ bodyPseudo: '"Loading"', count: 0 }, { shadow: true }, { tag: 'synthetic-editor' }]) {
    assert.equal(evaluateProbe(options).state, 'content', JSON.stringify(options));
  }
});

test('crash during initial injection retains evidence for bounded recovery', async t => {
  const { hub, model, advance } = await fixture(t); model.crashOnInject = true;
  await hub.tick(); assert.equal(model.reloads, 0);
  advance(100); await hub.tick(); assert.equal(model.reloads, 1);
  advance(1000); await hub.tick(); assert.equal(model.reloads, 1);
  model.crashOnInject = false;
  const connection = [...hub.sessions.values()][0];
  hub.event({ method: 'Runtime.executionContextCreated', params: { context: { id: 2, auxData: { isDefault: true, frameId: 'main' } } } }, connection);
  await hub.tick(); assert.equal(hub.status.injectCount, 1, 'recovery must finish the failed initial injection');
});

test('actual probe expression drives synthetic CDP recovery', async t => {
  const { hub, model, advance } = await fixture(t);
  model.dom = {};
  await hub.tick(); advance(100); await hub.tick();
  assert.equal(model.reloads, 1);
});

test('content appearing on final probe cancels reload', async t => {
  const { hub, model, advance } = await fixture(t);
  await hub.tick(); advance(100);
  model.beforeProbe = async () => { if (model.probes === 3) model.state = 'content'; };
  await hub.tick();
  assert.equal(model.reloads, 0);
});

test('navigation and replacement document restart the blank grace', async t => {
  const { hub, model, advance } = await fixture(t);
  await hub.tick(); advance(99); model.documentId++;
  await hub.tick(); advance(99); await hub.tick();
  assert.equal(model.reloads, 0);
  advance(1); await hub.tick(); assert.equal(model.reloads, 1);
});

test('one-time reload budget survives target ID churn and stop/start', async t => {
  const { hub, model, target, advance } = await fixture(t);
  await hub.tick(); advance(100); await hub.tick(); assert.equal(model.reloads, 1);
  target.webSocketDebuggerUrl += '-replacement';
  advance(1000); await hub.tick(); advance(1000); await hub.tick(); assert.equal(model.reloads, 1);
  await hub.stop(); hub.start(); await hub.tick(); advance(1000); await hub.tick();
  assert.equal(model.reloads, 1);
});

test('probe rejection and disconnected sockets never reload', async t => {
  const { hub, model, advance } = await fixture(t);
  await hub.tick(); advance(100); model.rejectProbe = true; await hub.tick();
  assert.equal(model.reloads, 0); assert.match(hub.status.cdpError, /probe rejected/);
  model.rejectProbe = false;
  model.beforeProbe = async socket => { socket.terminate(); };
  await hub.tick(); assert.equal(model.reloads, 0);
});

test('stop while awaiting probe cancels pending recovery', async t => {
  const { hub, model, advance } = await fixture(t);
  await hub.tick(); advance(100);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  model.beforeProbe = async () => { entered(); await gate; };
  const tick = hub.tick(); await ready;
  const stop = hub.stop(); release(); await tick; await stop;
  assert.equal(model.reloads, 0); assert.equal(hub.sessions.size, 0);
});

test('confirmed renderer crash gets bounded reload, navigation cancels stale crash', async t => {
  const { hub, model, advance } = await fixture(t, { state: 'content' });
  await hub.tick(); const connection = [...hub.sessions.values()][0];
  hub.event({ method: 'Inspector.targetCrashed' }, connection);
  advance(99); await hub.tick(); assert.equal(model.reloads, 0);
  advance(1); await hub.tick(); assert.equal(model.reloads, 1);
  advance(1000); await hub.tick(); assert.equal(model.reloads, 1);
});

test('crashed renderer navigating to auth is never reloaded', async t => {
  const { hub, model, advance } = await fixture(t, { state: 'content' });
  await hub.tick(); const connection = [...hub.sessions.values()][0];
  hub.event({ method: 'Inspector.targetCrashed' }, connection);
  hub.event({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: 'app://local/auth.html' } } }, connection);
  advance(1000); await hub.tick(); assert.equal(model.reloads, 0);
});

test('true application exit finishes once after bounded handoff grace', async () => {
  const delays = [];
  const { session, child, stats } = sessionFixture({ wait: async ms => { delays.push(ms); } });
  await session.launch(); child.emit('exit'); await session.handoffPromise;
  assert.equal(session.phase, 'idle'); assert.deepEqual(delays, [1000, 2000]);
  assert.equal(stats().stops, 1); assert.equal(stats().exitsHook, 1); assert.equal(session.monitor, null);
});

test('replacement appearing within handoff grace retains session without rerunning hooks', async () => {
  let queries = 0;
  const { session, child, stats } = sessionFixture();
  await session.launch(); session.desktop.running = async () => ++queries >= 2;
  child.emit('exit'); await session.handoffPromise;
  assert.equal(session.phase, 'running'); assert.equal(stats().stops, 0); assert.equal(stats().startsHook, 1);
  session.desktop.running = async () => false; await session.monitorExit(session.generation);
  assert.equal(session.phase, 'idle'); assert.equal(stats().exitsHook, 1);
});

test('close during process query invalidates handoff and never restarts monitoring', async () => {
  let release;
  const { session, child, stats } = sessionFixture(); await session.launch();
  session.desktop.running = () => new Promise(resolve => { release = resolve; });
  child.emit('exit'); await session.close('synthetic close'); release(true); await session.handoffPromise;
  assert.equal(session.phase, 'idle'); assert.equal(session.monitor, null); assert.equal(stats().stops, 1);
});

test('explicit switch finish invalidates in-flight handoff before another launch', async () => {
  let release;
  const { session, child, stats } = sessionFixture(); await session.launch();
  session.desktop.running = () => new Promise(resolve => { release = resolve; });
  child.emit('exit'); const old = session.handoffPromise;
  await session.finish('synthetic account switch'); session.desktop.running = async () => false;
  await session.launch(); release(true); await old;
  assert.equal(session.phase, 'running'); assert.equal(stats().startsHook, 2); assert.equal(session.monitor, null);
  await session.close('synthetic cleanup');
});

test('unknown process status preserves reconnect monitoring rather than declaring exit', async () => {
  const { session, child, stats } = sessionFixture(); await session.launch();
  session.desktop.running = async options => { assert.equal(options.strict, true); throw new Error('synthetic tasklist timeout'); };
  child.emit('exit'); await session.handoffPromise;
  assert.equal(session.phase, 'running'); assert.ok(session.monitor); assert.equal(stats().stops, 0);
  await session.close('synthetic cleanup');
});

test('strict Windows process discovery propagates query errors without live processes', async () => {
  const options = { platform: 'win32', runProcess: async () => { throw new Error('synthetic tasklist timeout'); } };
  assert.equal(await desktopRunning(options), false);
  await assert.rejects(desktopRunning({ ...options, strict: true }), /tasklist timeout/);
  assert.equal(await desktopRunning({ platform: 'linux', strict: true, runProcess: async () => { throw Object.assign(new Error('no match'), { code: 1 }); } }), false);
});
