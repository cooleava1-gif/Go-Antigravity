// Context/quota ring for the Antigravity composer.
//
// installContextWidget() is injected into the Antigravity renderer, so it has to stay one
// self-contained function: no imports, no module state and nothing captured from this file,
// because callers serialize the function source and re-evaluate it inside the page.
//
// Contract
//   installContextWidget(win, doc, enabled, report)
//   * disposes whatever sits on win.__goAntigravityContext, then does nothing else when the
//     feature is disabled;
//   * locates the composer row that holds both a model-selector trigger and a rich-text
//     editor, and accepts it only when the layout is provably horizontal, statically
//     positioned, hugging the editor, and unambiguous against every other candidate;
//   * mounts a shadow-DOM span holding a 12px usage ring plus a details popover clamped to the
//     viewport, and hides the widget instead of overlapping composer or foreign controls;
//   * requests metrics with report({ type: 'context-metrics', requestId, conversationId }) --
//     one request in flight, at most one per route every 3s -- and accepts the answer only
//     through win.__goAntigravityContext.receive(requestId, payload) while the request id,
//     the payload's conversation and the current route still agree;
//   * follows host colours, re-measures on scroll, resize and mutation, and exposes dispose()
//     which removes every node, observer, timer and listener it created.
// Only read-only host figures are shown: nothing is stored and nothing leaves the process.
function installContextWidget(win, doc, enabled, report) {
  win.__goAntigravityContext?.dispose();
  if (!enabled) return;

  const HOST_ID = 'go-antigravity-context-monitor';
  const CONVERSATION_ROUTE = /\/c\/([^/]+)/;
  const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EDITOR_QUERY = '[contenteditable="true"][role="textbox"],[contenteditable="true"][role="combobox"]';
  const ANCHOR_QUERY = '[data-testid="model-selector-trigger"]';
  const CONTROL_QUERY = 'button,input,[role="button"],[role="combobox"]';
  const POINTER_EVENTS = ['pointerdown', 'mousedown', 'click'];
  const REQUEST_FRESH_MS = 25000;
  const REQUEST_GAP_MS = 3000;
  const SAMPLE_FRESH_MS = 30000;
  const RING_LENGTH = 31.416;
  const PANEL_WIDTH = 312;
  const PANEL_GAP = 8;
  const PERCENT_CEILING = 999;

  let host, shadow, trigger, panelNode, composer, sample;
  let route = '';
  let inflight = null;
  let requestedAt = 0;
  let sequence = 0;
  let closed = false;
  let mutations, resizes, frame;

  const STYLE = `<style>
:host{font:11px system-ui,sans-serif;color:inherit}
.strip{display:flex;align-items:center;min-width:0}
button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:5px;background:transparent;padding:3px;white-space:nowrap}
button:hover,button:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent)}
button:focus-visible{outline:1px solid currentColor}
button[data-tone=medium]{color:var(--vscode-editorWarning-foreground,#b88620)}
button[data-tone=high]{color:var(--vscode-errorForeground,#db6860)}
.indicator{display:flex;align-items:center;justify-content:center;gap:5px;height:24px;box-sizing:border-box;min-width:42px;font-variant-numeric:tabular-nums}
.indicator[data-tone=normal]{color:inherit}
.indicator svg{width:12px;height:12px;flex:none}
.ring-track{opacity:.2}
.ring-fill{transform:rotate(-90deg);transform-origin:6px 6px}
.card{box-sizing:border-box;position:fixed;inset:auto;margin:0;z-index:2147483000;max-height:calc(100vh - 16px);overflow:auto;padding:14px;border-radius:9px;border:1px solid var(--vscode-widget-border,#7775);background:var(--vscode-editorWidget-background,Canvas);color:var(--vscode-editor-foreground,CanvasText);box-shadow:0 8px 24px #0003;font:12px system-ui,sans-serif;line-height:1.5;font-variant-numeric:tabular-nums}
[hidden]{display:none!important}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px}
.head strong{font-weight:600}
.head button{font-size:16px;line-height:1}
.summary{display:flex;align-items:baseline;gap:6px}
.summary b{font-size:16px;font-weight:600}
.estimate{font-size:10px;opacity:.65;border:1px solid currentColor;border-radius:3px;padding:0 3px}
.usage{margin:4px 0 12px;opacity:.7}
h3{font-size:11px;font-weight:600;opacity:.65;margin:0 0 7px}
.group{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);padding-top:10px;margin-top:10px}
dl{margin:0}
dl div{display:flex;gap:12px;justify-content:space-between;margin:5px 0}
dt{opacity:.7}
dd{margin:0;max-width:66%;text-align:right;overflow-wrap:anywhere}
.note{font-size:10px;line-height:1.5;opacity:.6;margin:7px 0 0}
.performance{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.performance div{display:block;margin:0}
.performance dd{text-align:left;max-width:none;margin-top:2px}
.foot{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);padding-top:9px;margin-top:10px}
</style>`;

  const STRIP = `<div id="strip" class="strip">
  <button id="trigger" class="indicator" type="button" aria-expanded="false" aria-controls="details" aria-label="上下文估算">
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <circle class="ring-track" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <circle id="context-fill" class="ring-fill" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH}"/>
    </svg>
    <span id="context-value">—</span>
  </button>
</div>`;

  const PANEL = `<section id="details" class="card" role="region" aria-label="上下文与当前对话统计" hidden>
  <div class="head">
    <div class="summary"><strong>上下文已用</strong><b id="context-percent">—</b><span id="estimate" class="estimate">估算</span></div>
    <button id="close" type="button" aria-label="关闭详情">×</button>
  </div>
  <p id="usage" class="usage"></p>
  <dl><div id="model-row"><dt>模型</dt><dd id="model"></dd></div></dl>
  <div id="token-stats" class="group">
    <h3>本对话 Token</h3>
    <dl>
      <div id="input-row"><dt>输入</dt><dd id="input"></dd></div>
      <div id="output-row"><dt>输出</dt><dd id="output"></dd></div>
    </dl>
  </div>
  <div id="performance-stats" class="group">
    <dl class="performance">
      <div id="ttft-row"><dt>平均 TTFT</dt><dd id="ttft"></dd></div>
      <div id="speed-row"><dt>平均 TPS</dt><dd id="speed"></dd></div>
    </dl>
  </div>
  <p class="note foot" id="updated"></p>
</section>`;

  const MARKUP = STYLE + STRIP + PANEL;

  // ---- readings and formatting -------------------------------------------
  const isMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

  const abbreviate = value => {
    if (!isMetric(value)) return '—';
    if (value >= 1000000) return (value / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(value);
  };

  const currentRoute = () => {
    const candidate = win.location.pathname.match(CONVERSATION_ROUTE)?.[1];
    return candidate && CONVERSATION_ID.test(candidate) ? candidate.toLowerCase() : null;
  };

  const composerModel = () => {
    const text = composer?.anchor?.textContent;
    return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  };

  // A control counts only when it is attached, not inside a hidden/inert subtree, painted, and
  // visibly rendered; a zero-size or display:none element is not occupying composer space.
  const isVisible = element => Boolean(element?.isConnected)
    && !element.closest('[hidden],[inert]')
    && element.getClientRects().length > 0
    && win.getComputedStyle(element).visibility !== 'hidden';

  const intersect = (a, b) => {
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    return { left, right, top, bottom, wide: right - left > 1, tall: bottom - top > 1 };
  };

  // ---- details popover ----------------------------------------------------
  const closePanel = () => {
    if (!panelNode) return;
    if (panelNode.hasAttribute('popover') && panelNode.matches(':popover-open')) panelNode.hidePopover();
    panelNode.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false');
  };

  const placePanel = () => {
    if (!panelNode || panelNode.hidden || !host?.isConnected) return;
    const anchor = trigger.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, win.innerWidth - PANEL_GAP * 2);
    panelNode.style.width = Math.max(0, width) + 'px';
    panelNode.style.left = Math.max(PANEL_GAP, Math.min(anchor.left, win.innerWidth - width - PANEL_GAP)) + 'px';
    const height = panelNode.getBoundingClientRect().height;
    panelNode.style.top = Math.max(PANEL_GAP, Math.min(anchor.top - height - PANEL_GAP, win.innerHeight - height - PANEL_GAP)) + 'px';
  };

  const openPanel = () => {
    if (!host?.isConnected || host.hidden) return;
    closePanel();
    panelNode.hidden = false;
    if (panelNode.hasAttribute('popover') && !panelNode.matches(':popover-open')) panelNode.showPopover();
    trigger.setAttribute('aria-expanded', 'true');
    placePanel();
  };

  // ---- payload to view model ---------------------------------------------
  // One description of the current sample is computed, then written to the shadow tree. A
  // metric that is absent, negative or not finite stays blank instead of showing a zero.
  const sampleView = () => {
    const context = sample?.context, session = sample?.session, tokens = sample?.tokens;
    const percent = isMetric(context?.usedFraction) ? Math.round(context.usedFraction * 100) : null;
    const model = context?.model || tokens?.model || composerModel();
    const input = isMetric(tokens?.inputTokens), output = isMetric(tokens?.outputTokens);
    const ttft = isMetric(session?.averageTtftSeconds), speed = isMetric(session?.averageTokensPerSecond);
    const requests = isMetric(session?.requestCount) && session.requestCount > 0 ? `${session.requestCount} 次请求` : '';
    const basis = session?.tpsBasis === 'response' ? '可见输出' : session?.tpsBasis === 'all-output' ? '总输出' : '混合';
    return {
      text: percent === null ? '—' : String(Math.min(PERCENT_CEILING, percent)) + (percent > PERCENT_CEILING ? '+' : '') + '%',
      ring: String(RING_LENGTH * (1 - Math.max(0, Math.min(1, context?.usedFraction ?? 0)))),
      label: percent === null ? '上下文估算暂不可用，点击查看详情' : `上下文已用约 ${percent}%，点击查看详情`,
      title: percent === null ? '上下文估算暂不可用 · 点击查看详情' : `上下文已用约 ${percent}% · 点击查看详情`,
      tone: percent >= 90 ? 'high' : percent >= 75 ? 'medium' : 'normal',
      estimated: percent !== null,
      usage: isMetric(context?.usedTokens)
        ? `约 ${abbreviate(context.usedTokens)}${isMetric(context.maxTokens) ? ' / ' + abbreviate(context.maxTokens) : ''} tokens`
        : '等待上下文数据',
      model,
      tokens: [
        { row: 'input-row', cell: 'input', shown: input, text: input ? abbreviate(tokens.inputTokens) : '' },
        { row: 'output-row', cell: 'output', shown: output, text: output ? abbreviate(tokens.outputTokens) : '' }
      ],
      latency: [
        { row: 'ttft-row', cell: 'ttft', shown: ttft, text: ttft ? session.averageTtftSeconds.toFixed(2) + ' 秒' : '' },
        { row: 'speed-row', cell: 'speed', shown: speed, text: speed ? session.averageTokensPerSecond.toFixed(1) + ' tok/s' : '' }
      ],
      showTokens: input || output,
      showLatency: ttft || speed,
      ttftNote: `有效样本 ${session?.ttftSamples || 0}/${session?.requestCount || 0}；首字耗时均值`,
      speedNote: `有效样本 ${session?.tpsSamples || 0}/${session?.requestCount || 0}；按流式时长加权，输出口径：${basis}`,
      updated: sample?.state === 'live' ? requests || '当前对话' : inflight ? '正在读取…' : '暂无统计',
      updatedNote: sample?.state === 'live' && isMetric(sample.sampledAt)
        ? `更新于 ${new Date(sample.sampledAt).toLocaleTimeString()}；上下文为最近请求开始时的宿主估算，Token 为宿主累计口径`
        : ''
    };
  };

  const paint = () => {
    if (!shadow) return;
    const view = sampleView();
    const write = (id, value) => { shadow.getElementById(id).textContent = value; };
    write('context-value', view.text);
    write('context-percent', view.text);
    shadow.getElementById('context-fill').style.strokeDashoffset = view.ring;
    shadow.getElementById('context-percent').hidden = !view.estimated;
    shadow.getElementById('estimate').hidden = !view.estimated;
    trigger.setAttribute('aria-label', view.label);
    trigger.dataset.tone = view.tone;
    trigger.title = view.title;
    write('usage', view.usage);
    write('model', view.model);
    shadow.getElementById('model-row').hidden = !view.model;
    for (const row of view.tokens) {
      shadow.getElementById(row.row).hidden = !row.shown;
      write(row.cell, row.text);
    }
    shadow.getElementById('token-stats').hidden = !view.showTokens;
    for (const row of view.latency) {
      shadow.getElementById(row.row).hidden = !row.shown;
      write(row.cell, row.text);
    }
    shadow.getElementById('performance-stats').hidden = !view.showLatency;
    shadow.getElementById('ttft').title = view.ttftNote;
    shadow.getElementById('speed').title = view.speedNote;
    write('updated', view.updated);
    shadow.getElementById('updated').title = view.updatedNote;
    placePanel();
  };

  // ---- composer layout ----------------------------------------------------
  // The row must be a horizontal flex row in normal flow, must not sit in a page banner and
  // must share vertical space with the editor; anything else is treated as an unknown layout.
  const fitsComposer = pair => {
    const rowStyle = win.getComputedStyle(pair.row), branchStyle = win.getComputedStyle(pair.branch);
    if (!['flex', 'inline-flex'].includes(rowStyle.display) || rowStyle.flexDirection !== 'row') return false;
    if (['absolute', 'fixed'].includes(rowStyle.position) || ['absolute', 'fixed'].includes(branchStyle.position)) return false;
    if (pair.row.closest('header,[role="banner"]')) return false;
    const row = pair.row.getBoundingClientRect(), editor = pair.editor.getBoundingClientRect();
    const holder = pair.row.parentElement.getBoundingClientRect();
    if (!(row.width > 0 && row.height > 0 && editor.width > 0 && editor.height > 0)) return false;
    const clearance = Math.max(0, row.top - editor.bottom, editor.top - row.bottom);
    const sharedHeight = Math.min(row.bottom, editor.bottom) - Math.max(row.top, editor.top);
    const sharedWidth = Math.min(row.right, editor.right) - Math.max(row.left, editor.left);
    return clearance <= 48 && sharedHeight <= 2 && sharedWidth > 0
      && holder.height <= editor.height + row.height + 96;
  };

  // Walk up from the trigger until the level that also contains the editor, and keep the child
  // of that level as the branch the widget is inserted after.
  const pairFor = (anchor, editor) => {
    let row = anchor.parentElement, distance = 0;
    while (row?.parentElement && !row.parentElement.contains(editor) && row.parentElement !== doc.body) {
      row = row.parentElement;
      distance += 1;
    }
    if (!row || row.contains(editor)) return null;
    const holder = row.parentElement;
    if (!holder?.contains(editor) || holder === doc.body || holder === doc.documentElement) return null;
    let branch = anchor;
    while (branch.parentElement !== row) branch = branch.parentElement;
    const candidate = { row, branch, editor, anchor, distance };
    return fitsComposer(candidate) ? candidate : null;
  };

  // Two equally close candidates mean the layout is ambiguous, and nothing is mounted.
  const uniqueClosest = candidates => {
    if (!candidates.length) return null;
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates.length === 1 || candidates[0].distance < candidates[1].distance ? candidates[0] : null;
  };

  // No generic combobox or title-label fallback: an unproven layout is left alone.
  const locateComposer = () => {
    const editors = [...doc.querySelectorAll(EDITOR_QUERY)].filter(isVisible);
    const candidates = [];
    for (const anchor of doc.querySelectorAll(ANCHOR_QUERY)) {
      if (!isVisible(anchor)) continue;
      for (const editor of editors) {
        const candidate = pairFor(anchor, editor);
        if (candidate) candidates.push(candidate);
      }
    }
    return uniqueClosest(candidates);
  };

  // The widget may never sit on top of a control: it hides as soon as it would clip its own
  // content, leave the composer row, or cover a composer button or any other host control.
  const measure = () => {
    if (!host?.isConnected || !composer) return;
    host.hidden = false;
    host.style.display = 'flex';
    const box = host.getBoundingClientRect(), row = composer.row.getBoundingClientRect();
    let blocked = box.width + 1 < shadow.getElementById('strip').scrollWidth
      || box.right > row.right + 1 || box.left < row.left - 1 || !fitsComposer(composer);
    const local = new Set(composer.row.parentElement.querySelectorAll(CONTROL_QUERY));
    if (!blocked) {
      const controls = new Set([...local, ...doc.querySelectorAll(CONTROL_QUERY)]);
      for (const control of controls) {
        if (!isVisible(control)) continue;
        const area = intersect(box, control.getBoundingClientRect());
        if (local.has(control)) {
          const crowded = control.clientWidth > 0 && control.scrollWidth > control.clientWidth + 1;
          if (crowded || (area.wide && area.tall)) { blocked = true; break; }
          continue;
        }
        if (!area.wide || !area.tall || typeof doc.elementFromPoint !== 'function') continue;
        const hit = doc.elementFromPoint((area.left + area.right) / 2, (area.top + area.bottom) / 2);
        if (hit === control || control.contains(hit)) { blocked = true; break; }
      }
    }
    host.hidden = blocked;
    host.style.display = blocked ? 'none' : 'flex';
    if (blocked) closePanel();
  };

  // Inherit the composer text colour and the nearest painted surface behind the editor.
  const adoptTheme = () => {
    if (!host || !composer) return;
    host.style.color = win.getComputedStyle(composer.row).color;
    let backdrop;
    for (let element = composer.editor; element && element !== doc.documentElement; element = element.parentElement) {
      const value = win.getComputedStyle(element).backgroundColor;
      if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') { backdrop = value; break; }
    }
    if (!panelNode) return;
    if (backdrop) panelNode.style.background = backdrop;
    if (host.style.color) panelNode.style.color = host.style.color;
  };

  // ---- shadow root --------------------------------------------------------
  const buildHost = () => {
    host = doc.createElement('span');
    host.id = HOST_ID;
    host.style.cssText = 'display:flex;flex:0 1 auto;min-width:0;max-width:80px;margin:0 4px;position:relative;overflow:visible;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = MARKUP;
    trigger = shadow.getElementById('trigger');
    panelNode = shadow.getElementById('details');
    if (typeof panelNode.showPopover === 'function') panelNode.setAttribute('popover', 'manual');
    trigger.addEventListener('click', () => (panelNode.hidden ? openPanel() : closePanel()));
    shadow.getElementById('close').addEventListener('click', () => {
      closePanel();
      trigger.focus({ preventScroll: true });
    });
    // Keep our clicks out of the host composer's own focus handling without cancelling
    // keyboard defaults, which still belong to the page.
    for (const type of POINTER_EVENTS) host.addEventListener(type, event => event.stopPropagation());
    paint();
  };

  // ---- lifecycle ----------------------------------------------------------
  const trackRoute = () => {
    const next = currentRoute();
    if (next === route) return;
    route = next;
    inflight = null;
    sample = null;
    requestedAt = 0;
    closePanel();
    paint();
  };

  const attach = () => {
    trackRoute();
    const found = route ? locateComposer() : null;
    if (!found) {
      closePanel();
      host?.remove();
      composer = null;
      resizes?.disconnect();
      return;
    }
    const relocated = composer?.row !== found.row || composer?.branch !== found.branch;
    composer = found;
    if (!host) buildHost();
    if (!host.isConnected || relocated) {
      closePanel();
      found.row.insertBefore(host, found.branch.nextSibling);
      resizes?.disconnect();
      if (typeof win.ResizeObserver === 'function') {
        resizes ||= new win.ResizeObserver(queueSync);
        for (const target of [found.row, found.editor, found.branch]) resizes.observe(target);
      }
    }
    adoptTheme();
    measure();
    placePanel();
  };

  // At most one unanswered request per conversation, and no more than one every 3s. A sample
  // older than 30s is dropped rather than displayed as current.
  const requestMetrics = () => {
    if (!enabled || closed || doc.hidden || !route || !host?.isConnected || host.hidden) return;
    const now = Date.now();
    if (inflight && now - inflight.at < REQUEST_FRESH_MS) return;
    if (now - requestedAt < REQUEST_GAP_MS) return;
    if (inflight || (sample?.sampledAt && now - sample.sampledAt > SAMPLE_FRESH_MS)) sample = null;
    sequence += 1;
    const requestId = String(sequence);
    inflight = { requestId, conversationId: route, at: now };
    requestedAt = now;
    try {
      report({ type: 'context-metrics', requestId, conversationId: route });
    } catch {
      inflight = null;
      sample = null;
    }
    paint();
  };

  // A late answer is dropped when the request id, the requesting conversation, the answer's
  // conversation and the route on screen no longer agree.
  const acceptMetrics = (requestId, result) => {
    if (closed || !inflight || inflight.requestId !== requestId) return;
    if (inflight.conversationId !== currentRoute() || result?.conversationId !== inflight.conversationId) return;
    inflight = null;
    sample = result;
    paint();
    measure();
  };

  const queueSync = () => {
    if (closed || frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (closed) return;
      attach();
      requestMetrics();
    });
  };

  const dismissOnPointer = event => { if (!event.composedPath().includes(host)) closePanel(); };
  const dismissOnEscape = event => {
    if (event.key !== 'Escape') return;
    const focused = Boolean(shadow?.activeElement);
    closePanel();
    if (focused) trigger?.focus({ preventScroll: true });
  };

  doc.addEventListener('pointerdown', dismissOnPointer);
  doc.addEventListener('keydown', dismissOnEscape);
  doc.addEventListener('scroll', queueSync, true);
  win.addEventListener('resize', queueSync);
  mutations = new win.MutationObserver(records => {
    if (records.some(record => record.target !== host && !host?.contains(record.target))) queueSync();
  });
  mutations.observe(doc.documentElement, { childList: true, subtree: true });
  const ticker = win.setInterval(() => { attach(); requestMetrics(); }, 1000);
  win.__goAntigravityContext = {
    receive: acceptMetrics,
    dispose() {
      closed = true;
      inflight = null;
      sample = null;
      closePanel();
      host?.remove();
      win.clearInterval(ticker);
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      mutations.disconnect();
      resizes?.disconnect();
      doc.removeEventListener('pointerdown', dismissOnPointer);
      doc.removeEventListener('keydown', dismissOnEscape);
      doc.removeEventListener('scroll', queueSync, true);
      win.removeEventListener('resize', queueSync);
      delete win.__goAntigravityContext;
    }
  };
  attach();
  requestMetrics();
}

module.exports = { installContextWidget };
