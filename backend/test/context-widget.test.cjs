'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installContextWidget } = require('../features/context-widget');
const ID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function fixture({ width = 900, height = 800, background = 'rgb(30, 30, 30)', color = 'rgb(220, 220, 220)' } = {}) {
  let now = 100000, tick, observer, frame;
  const calls = [], events = new Map();
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  class Element {
    constructor(name, bounds = box(200, 480, 48, 24)) { Object.assign(this, { name, bounds, children: [], style: {}, dataset: {}, attributes: {}, listeners: new Map(), hidden: false, textContent: '', scrollWidth: bounds.width, clientWidth: bounds.width }); }
    get isConnected() { return this === root || Boolean(this.parentElement?.isConnected); }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, after) { child.remove(); const index = this.children.indexOf(after); this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this; }
    get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); this.parentElement = null; }
    contains(child) { return child === this || this.children.some(x => x.contains(child)); }
    closest(selector) { if (selector.includes('header')) return null; return this.hidden ? this : this.parentElement?.closest(selector) || null; }
    getBoundingClientRect() { return this.bounds; }
    getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [this.bounds]; }
    setAttribute(key, value) { this.attributes[key] = value; }
    hasAttribute(key) { return key in this.attributes; }
    matches(selector) { return selector === ':popover-open' && this.open; }
    showPopover() { this.open = true; }
    hidePopover() { this.open = false; }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    fire(type) { this.listeners.get(type)?.({ stopPropagation() {} }); }
    focus() { this.focused = true; }
    querySelectorAll() { return this.children.flatMap(x => [...(x.control ? [x] : []), ...x.querySelectorAll()]); }
    attachShadow() {
      const shadow = { map: new Map(), activeElement: null, html: '', getElementById(id) { return this.map.get(id); }, set innerHTML(value) {
        this.html = value;
        for (const match of value.matchAll(/id="([^"]+)"/g)) this.map.set(match[1], new Element(match[1]));
        this.map.get('details').hidden = true;
        this.map.get('details').bounds = box(0, 0, 312, 650);
      }, get innerHTML() { return this.html; } };
      this.shadowRoot = shadow; return shadow;
    }
  }
  const root = new Element('root', box(0, 0, width, height));
  const body = root.append(new Element('body', root.bounds));
  const container = body.append(new Element('container', box(80, 390, 680, 130)));
  const editor = container.append(new Element('editor', box(100, 400, 620, 72)));
  const row = container.append(new Element('row', box(100, 480, 620, 28)));
  const anchor = row.append(new Element('model', box(100, 480, 90, 28))); anchor.control = true; anchor.textContent = 'DOM model';
  const send = row.append(new Element('send', box(680, 480, 28, 28))); send.control = true;
  const doc = { body, documentElement: root, hidden: false, created: [],
    createElement(name) { const node = new Element(name); this.created.push(node); return node; },
    querySelectorAll(selector) { return selector.startsWith('[contenteditable') ? [editor] : selector.startsWith('[data-testid') ? [anchor] : [anchor, send]; },
    addEventListener(type, handler) { events.set(type, handler); }, removeEventListener(type) { events.delete(type); }, elementFromPoint() { return null; } };
  const win = { location: { pathname: '/c/' + ID }, innerWidth: width, innerHeight: height,
    getComputedStyle(el) { return { display: el === row ? 'flex' : 'block', flexDirection: 'row', position: 'static', visibility: 'visible', backgroundColor: el === container ? background : 'transparent', color }; },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    addEventListener(type, handler) { events.set(type, handler); }, removeEventListener(type) { events.delete(type); },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() { tick = null; },
    requestAnimationFrame(fn) { frame = fn; return 1; }, cancelAnimationFrame() { frame = null; } };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ window: win, document: doc, report: event => calls.push(event), Date: Clock });
  vm.runInContext('(' + installContextWidget.toString() + ')(window, document, true, report)', context);
  return { win, doc, row, anchor, send, calls, events, node: () => doc.created[0], shadow: () => doc.created[0].shadowRoot,
    advance(ms = 4000) { now += ms; tick?.(); }, mutate() { observer?.([{ target: body }]); frame?.(); frame = null; },
    receive(payload = {}) { const request = calls[calls.length - 1]; win.__easyagContext.receive(request.requestId, { conversationId: request.conversationId, state: 'live', sampledAt: now, ...payload }); },
    now: () => now };
}

const sample = { context: { usedTokens: 151000, maxTokens: 300000, usedFraction: 151000 / 300000, model: 'Synthetic model', estimated: true },
  tokens: { inputTokens: 8000, outputTokens: 2000, thinkingTokens: 500, cacheReadTokens: 6000, uncachedInputTokens: null, cacheHitFraction: null },
  session: { elapsedSeconds: null, modelSeconds: 20, toolSeconds: null, averageTtftSeconds: 1.25, averageTokensPerSecond: 75,
    tpsBasis: 'response', requestCount: 2, tpsSamples: 2, ttftSamples: 2 } };

test('serialized renderer mounts one compact ring with adjacent percentage and no branding or inscribed number', () => {
  const f = fixture(); f.receive(sample);
  const shadow = f.shadow();
  assert.equal(shadow.getElementById('context-value').textContent, '50%');
  assert.equal(shadow.getElementById('context-percent').textContent, '50%');
  assert.match(shadow.getElementById('usage').textContent, /约 151K \/ 300K tokens/);
  assert.doesNotMatch(shadow.html, /<text|ring-number|EasyAG|AG Pulse/);
  assert.match(shadow.html, /width:12px;height:12px/);
  assert.match(shadow.html, /估算/);
  assert.match(shadow.getElementById('trigger').attributes['aria-label'], /上下文已用约 50%/);
  assert.equal(f.row.children.filter(x => x.id === 'easyag-context-monitor').length, 1);
});

test('popover keeps only key measurable conversation data and removes unavailable breakdowns', () => {
  const f = fixture(); f.receive(sample); const s=f.shadow();
  assert.equal(s.getElementById('model').textContent, 'Synthetic model');
  for (const key of ['session-time','model-time','tool-time','cache-hit','uncached','cache-read','sample-count','speedNote','cacheNote']) assert.equal(s.getElementById(key), undefined);
  assert.doesNotMatch(s.html, /缓存命中率|未缓存输入|缓存读取|系统<|工具<|会话时长|工具用时/);
  assert.equal(s.getElementById('input').textContent, '8K');
  assert.equal(s.getElementById('output').textContent, '2K');
  assert.equal(s.getElementById('speed').textContent, '75.0 tok/s');
  assert.equal(s.getElementById('ttft').textContent, '1.25 秒');
  assert.equal(s.getElementById('updated').textContent, '2 次请求');
  assert.ok(s.getElementById('speed').title.includes('2/2'));
  assert.match(s.getElementById('speed').title, /按流式时长加权/);
  assert.match(s.html, /本对话 Token/);
  for (const key of ['input-row','output-row','ttft-row','speed-row','token-stats','performance-stats']) assert.equal(s.getElementById(key).hidden, false);
  s.getElementById('trigger').fire('click');
  assert.equal(s.getElementById('details').hidden, false);
  assert.equal(s.getElementById('trigger').attributes['aria-expanded'], 'true');
  s.activeElement = s.getElementById('close');
  f.events.get('keydown')({ key: 'Escape' });
  assert.equal(s.getElementById('details').hidden, true);
  assert.equal(s.getElementById('trigger').focused, true);
});

test('zero is shown while missing/null/invalid metrics and empty groups are hidden', () => {
  const f=fixture();
  f.receive({ context: { usedTokens: 0, maxTokens: 300000, usedFraction: 0 }, tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, session: { averageTtftSeconds: 0, averageTokensPerSecond: 0, modelSeconds: 0 } });
  const s=f.shadow();
  assert.equal(s.getElementById('context-value').textContent, '0%');
  assert.equal(s.getElementById('input').textContent, '0');
  assert.equal(s.getElementById('speed').textContent, '0.0 tok/s');
  assert.equal(s.getElementById('ttft').textContent, '0.00 秒');
  assert.equal(s.getElementById('input-row').hidden, false);
  assert.equal(s.getElementById('performance-stats').hidden, false);
  f.advance(); f.receive({ context: { usedTokens: 4, maxTokens: null, usedFraction: null }, tokens: null, session: null });
  assert.equal(s.getElementById('context-value').textContent, '—');
  assert.equal(s.getElementById('usage').textContent, '约 4 tokens');
  assert.equal(s.getElementById('context-percent').hidden, true);
  assert.equal(s.getElementById('estimate').hidden, true);
  assert.equal(s.getElementById('speed').textContent, '');
  assert.equal(s.getElementById('token-stats').hidden, true);
  assert.equal(s.getElementById('performance-stats').hidden, true);
  f.advance(); f.receive({tokens:{inputTokens:120,outputTokens:null},session:{averageTtftSeconds:NaN,averageTokensPerSecond:'42'}});
  assert.equal(s.getElementById('input-row').hidden,false);
  assert.equal(s.getElementById('output-row').hidden,true);
  assert.equal(s.getElementById('token-stats').hidden,false);
  assert.equal(s.getElementById('performance-stats').hidden,true);
});

test('route changes clear old totals, hide popover, and reject in-flight results for other conversations', () => {
  const f=fixture(); f.receive(sample); const s=f.shadow();
  s.getElementById('trigger').fire('click');
  f.advance(); const stale=f.calls[f.calls.length-1];
  f.win.location.pathname='/c/' + OTHER; f.advance();
  assert.equal(s.getElementById('details').hidden, true);
  assert.equal(s.getElementById('context-value').textContent, '—');
  assert.equal(s.getElementById('input').textContent, '');
  assert.equal(s.getElementById('input-row').hidden, true);
  f.win.__easyagContext.receive(stale.requestId, { ...sample, conversationId: ID });
  assert.equal(s.getElementById('context-value').textContent, '—');
  assert.equal(f.calls[f.calls.length-1].conversationId, OTHER);
  f.receive({ ...sample, context: { usedTokens: 1, maxTokens: 10, usedFraction: 0.1 } });
  assert.equal(s.getElementById('context-value').textContent, '10%');
});

test('popover clamps to narrow viewport and inherits both dark and light host colors', () => {
  for (const theme of [{background:'rgb(30, 30, 30)',color:'rgb(220, 220, 220)'},{background:'rgb(250, 250, 250)',color:'rgb(35, 35, 35)'}]) {
    const f=fixture({width:280,height:420,...theme}); f.receive(sample); const s=f.shadow();
    s.getElementById('trigger').fire('click'); const card=s.getElementById('details');
    assert.equal(card.style.width,'264px');
    assert.equal(card.style.left,'8px');
    assert.equal(card.style.top,'8px');
    assert.equal(card.style.background,theme.background);
    assert.equal(card.style.color,theme.color);
  }
});

test('collision, invalid routes, repeated injection and disposal preserve host controls', () => {
  const f=fixture();
  f.send.bounds={...f.node().bounds}; f.advance();
  assert.equal(f.node().hidden,true);
  f.send.bounds={left:680,top:480,right:708,bottom:508,width:28,height:28}; f.advance();
  assert.equal(f.node().hidden,false);
  f.win.location.pathname='/settings'; f.advance();
  assert.equal(f.node().isConnected,false);
  const calls=f.calls.length; f.advance(); assert.equal(f.calls.length,calls);
  f.win.__easyagContext.dispose(); assert.equal(f.win.__easyagContext,undefined);
  assert.equal(f.anchor.isConnected,true); assert.equal(f.send.isConnected,true);
  let disposed=0;
  installContextWidget({__easyagContext:{dispose(){disposed++;}}},{},false,()=>{});
  assert.equal(disposed,1);
});
