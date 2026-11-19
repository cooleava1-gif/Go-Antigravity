// Local composer geometry checks adapted for the desktop context widget.
function installContextWidget(win, doc, enabled, report) {
  win.__goagyContext?.dispose();
  if (!enabled) return;
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let node, shadow, button, card, composer, data, route = '', pending, lastFetch = 0, sequence = 0, disposed = false;
  let observer, resizeObserver, frame;
  const conversationId = () => {
    const id = win.location.pathname.match(/\/c\/([^/]+)/)?.[1];
    return id && GUID.test(id) ? id.toLowerCase() : null;
  };
  const visible = element => element?.isConnected && !element.closest('[hidden],[inert]')
    && element.getClientRects().length && win.getComputedStyle(element).visibility !== 'hidden';
  function safeLayout(pair) {
    const style = win.getComputedStyle(pair.row), branchStyle = win.getComputedStyle(pair.branch);
    if (!['flex', 'inline-flex'].includes(style.display) || style.flexDirection !== 'row'
      || ['absolute', 'fixed'].includes(style.position) || ['absolute', 'fixed'].includes(branchStyle.position)
      || pair.row.closest('header,[role="banner"]')) return false;
    const r = pair.row.getBoundingClientRect(), e = pair.editor.getBoundingClientRect(), p = pair.row.parentElement.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && e.width > 0 && e.height > 0
      && Math.max(0, r.top - e.bottom, e.top - r.bottom) <= 48
      && Math.min(r.bottom, e.bottom) - Math.max(r.top, e.top) <= 2
      && Math.min(r.right, e.right) > Math.max(r.left, e.left) && p.height <= e.height + r.height + 96;
  }
  function findComposer() {
    const editors = [...doc.querySelectorAll('[contenteditable="true"][role="textbox"],[contenteditable="true"][role="combobox"]')].filter(visible);
    const pairs = [];
    for (const anchor of doc.querySelectorAll('[data-testid="model-selector-trigger"]')) {
      if (!visible(anchor)) continue;
      for (const editor of editors) {
        let row = anchor.parentElement, distance = 0;
        while (row?.parentElement && !row.parentElement.contains(editor) && row.parentElement !== doc.body) { row = row.parentElement; distance++; }
        if (!row || row.contains(editor) || !row.parentElement?.contains(editor) || [doc.body, doc.documentElement].includes(row.parentElement)) continue;
        let branch = anchor;
        while (branch.parentElement !== row) branch = branch.parentElement;
        const pair = { row, branch, editor, anchor, distance };
        if (safeLayout(pair)) pairs.push(pair);
      }
    }
    // Deliberately no generic combobox or title-label fallback: ambiguous layouts stay untouched.
    pairs.sort((a, b) => a.distance - b.distance);
    return pairs.length && (pairs.length === 1 || pairs[0].distance < pairs[1].distance) ? pairs[0] : null;
  }
  function hideCard() {
    if (!card) return;
    if (card.hasAttribute('popover') && card.matches(':popover-open')) card.hidePopover();
    card.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }
  function positionCard() {
    if (!card || card.hidden || !node?.isConnected) return;
    const r = button.getBoundingClientRect(), width = Math.min(312, win.innerWidth - 16);
    card.style.width = Math.max(0, width) + 'px';
    card.style.left = Math.max(8, Math.min(r.left, win.innerWidth - width - 8)) + 'px';
    const height = card.getBoundingClientRect().height;
    card.style.top = Math.max(8, Math.min(r.top - height - 8, win.innerHeight - height - 8)) + 'px';
  }
  function showCard() {
    if (!node?.isConnected || node.hidden) return;
    hideCard();
    card.hidden = false;
    if (card.hasAttribute('popover') && !card.matches(':popover-open')) card.showPopover();
    button.setAttribute('aria-expanded', 'true');
    positionCard();
  }
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const compact = value => !number(value) ? '—' : value >= 1000000
    ? (value / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M'
    : value >= 1000 ? (value / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : String(value);
  function render() {
    if (!shadow) return;
    const context = data?.context, session = data?.session, tokens = data?.tokens;
    const percentage = number(context?.usedFraction) ? Math.round(context.usedFraction * 100) : null;
    const percentageText = percentage === null ? '—' : String(Math.min(999, percentage)) + (percentage > 999 ? '+' : '') + '%';
    const set = (id, value) => { shadow.getElementById(id).textContent = value; };
    set('context-value', percentageText);
    set('context-percent', percentageText);
    shadow.getElementById('context-fill').style.strokeDashoffset = String(31.416 * (1 - Math.max(0, Math.min(1, context?.usedFraction ?? 0))));
    button.setAttribute('aria-label', percentage !== null ? `上下文已用约 ${percentage}%，点击查看详情` : '上下文估算暂不可用，点击查看详情');
    button.dataset.tone = percentage >= 90 ? 'high' : percentage >= 75 ? 'medium' : 'normal';
    button.title = percentage !== null ? `上下文已用约 ${percentage}% · 点击查看详情` : '上下文估算暂不可用 · 点击查看详情';
    shadow.getElementById('context-percent').hidden = percentage === null;
    shadow.getElementById('estimate').hidden = percentage === null;
    set('usage', number(context?.usedTokens)
      ? `约 ${compact(context.usedTokens)}${number(context.maxTokens) ? ' / ' + compact(context.maxTokens) : ''} tokens` : '等待上下文数据');
    const domModel = typeof composer?.anchor?.textContent === 'string' ? composer.anchor.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const model = context?.model || tokens?.model || domModel;
    set('model', model || '');
    shadow.getElementById('model-row').hidden = !model;
    const metric = (id, value, text) => {
      shadow.getElementById(id + '-row').hidden = !number(value);
      set(id, number(value) ? text : '');
      return number(value);
    };
    const input = metric('input', tokens?.inputTokens, compact(tokens?.inputTokens));
    const output = metric('output', tokens?.outputTokens, compact(tokens?.outputTokens));
    shadow.getElementById('token-stats').hidden = !input && !output;
    const ttft = metric('ttft', session?.averageTtftSeconds, number(session?.averageTtftSeconds) ? session.averageTtftSeconds.toFixed(2) + ' 秒' : '');
    const tps = metric('speed', session?.averageTokensPerSecond, number(session?.averageTokensPerSecond) ? session.averageTokensPerSecond.toFixed(1) + ' tok/s' : '');
    shadow.getElementById('performance-stats').hidden = !ttft && !tps;
    shadow.getElementById('ttft').title = `有效样本 ${session?.ttftSamples || 0}/${session?.requestCount || 0}；首字耗时均值`;
    shadow.getElementById('speed').title = `有效样本 ${session?.tpsSamples || 0}/${session?.requestCount || 0}；按流式时长加权，输出口径：${session?.tpsBasis === 'response' ? '可见输出' : session?.tpsBasis === 'all-output' ? '总输出' : '混合'}`;
    const requests = number(session?.requestCount) && session.requestCount > 0 ? `${session.requestCount} 次请求` : '';
    set('updated', data?.state === 'live' ? requests || '当前对话' : pending ? '正在读取…' : '暂无统计');
    shadow.getElementById('updated').title = data?.state === 'live' && number(data.sampledAt)
      ? `更新于 ${new Date(data.sampledAt).toLocaleTimeString()}；上下文为最近请求开始时的宿主估算，Token 为宿主累计口径` : '';
    positionCard();
  }
  function createNode() {
    node = doc.createElement('span');
    node.id = 'goagy-context-monitor';
    node.style.cssText = 'display:flex;flex:0 1 auto;min-width:0;max-width:80px;margin:0 4px;position:relative;overflow:visible;';
    shadow = node.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font:11px system-ui,sans-serif;color:inherit}.strip{display:flex;align-items:center;min-width:0}button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:5px;background:transparent;padding:3px;white-space:nowrap}
      .indicator{display:flex;align-items:center;justify-content:center;gap:5px;height:24px;box-sizing:border-box;min-width:42px;font-variant-numeric:tabular-nums}.indicator svg{width:12px;height:12px;flex:none}.ring-track{opacity:.2}.ring-fill{transform:rotate(-90deg);transform-origin:6px 6px}.indicator[data-tone=normal]{color:inherit}
      button:hover,button:focus-visible{background:color-mix(in srgb,currentColor 10%,transparent)}button:focus-visible{outline:1px solid currentColor}button[data-tone=medium]{color:var(--vscode-editorWarning-foreground,#b88620)}button[data-tone=high]{color:var(--vscode-errorForeground,#db6860)}
      .card{box-sizing:border-box;position:fixed;inset:auto;margin:0;z-index:2147483000;max-height:calc(100vh - 16px);overflow:auto;padding:14px;border-radius:9px;border:1px solid var(--vscode-widget-border,#7775);background:var(--vscode-editorWidget-background,Canvas);color:var(--vscode-editor-foreground,CanvasText);box-shadow:0 8px 24px #0003;font:12px system-ui,sans-serif;line-height:1.5;font-variant-numeric:tabular-nums}
      [hidden]{display:none!important}.head{display:flex;justify-content:space-between;align-items:center;gap:8px}.head strong{font-weight:600}.head button{font-size:16px;line-height:1}.summary{display:flex;align-items:baseline;gap:6px}.summary b{font-size:16px;font-weight:600}.estimate{font-size:10px;opacity:.65;border:1px solid currentColor;border-radius:3px;padding:0 3px}.usage{margin:4px 0 12px;opacity:.7}h3{font-size:11px;font-weight:600;opacity:.65;margin:0 0 7px}.group{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);padding-top:10px;margin-top:10px}dl{margin:0}dl div{display:flex;gap:12px;justify-content:space-between;margin:5px 0}dt{opacity:.7}dd{margin:0;max-width:66%;text-align:right;overflow-wrap:anywhere}.note{font-size:10px;line-height:1.5;opacity:.6;margin:7px 0 0}.performance{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.performance div{display:block;margin:0}.performance dd{text-align:left;max-width:none;margin-top:2px}.foot{border-top:1px solid color-mix(in srgb,currentColor 13%,transparent);padding-top:9px;margin-top:10px}
    </style><div id="strip" class="strip"><button id="trigger" class="indicator" type="button" aria-expanded="false" aria-controls="details" aria-label="上下文估算">
      <svg viewBox="0 0 12 12" aria-hidden="true"><circle class="ring-track" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle id="context-fill" class="ring-fill" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="31.416" stroke-dashoffset="31.416"/></svg><span id="context-value">—</span></button></div>
    <section id="details" class="card" role="region" aria-label="上下文与当前对话统计" hidden>
      <div class="head"><div class="summary"><strong>上下文已用</strong><b id="context-percent">—</b><span id="estimate" class="estimate">估算</span></div><button id="close" type="button" aria-label="关闭详情">×</button></div>
      <p id="usage" class="usage"></p>
      <dl><div id="model-row"><dt>模型</dt><dd id="model"></dd></div></dl>
      <div id="token-stats" class="group"><h3>本对话 Token</h3><dl><div id="input-row"><dt>输入</dt><dd id="input"></dd></div><div id="output-row"><dt>输出</dt><dd id="output"></dd></div></dl></div>
      <div id="performance-stats" class="group"><dl class="performance"><div id="ttft-row"><dt>平均 TTFT</dt><dd id="ttft"></dd></div><div id="speed-row"><dt>平均 TPS</dt><dd id="speed"></dd></div></dl></div>
      <p class="note foot" id="updated"></p></section>`;
    button = shadow.getElementById('trigger');
    card = shadow.getElementById('details');
    if (typeof card.showPopover === 'function') card.setAttribute('popover', 'manual');
    button.addEventListener('click', () => { if (card.hidden) showCard(); else hideCard(); });
    shadow.getElementById('close').addEventListener('click', () => { hideCard(); button.focus({ preventScroll: true }); });
    // Keep host focus handlers from swallowing our clicks, without cancelling keyboard defaults.
    for (const type of ['pointerdown', 'mousedown', 'click']) node.addEventListener(type, event => event.stopPropagation());
    render();
  }
  function fit() {
    if (!node?.isConnected || !composer) return;
    node.hidden = false;
    node.style.display = 'flex';
    const r = node.getBoundingClientRect(), row = composer.row.getBoundingClientRect();
    let blocked = r.width + 1 < shadow.getElementById('strip').scrollWidth || r.right > row.right + 1 || r.left < row.left - 1 || !safeLayout(composer);
    const localControls = new Set(composer.row.parentElement.querySelectorAll('button,input,[role="button"],[role="combobox"]'));
    const controls = new Set([...localControls, ...doc.querySelectorAll('button,input,[role="button"],[role="combobox"]')]);
    if (!blocked) for (const control of controls) {
      if (!visible(control)) continue;
      const c = control.getBoundingClientRect();
      const left = Math.max(r.left, c.left), right = Math.min(r.right, c.right), top = Math.max(r.top, c.top), bottom = Math.min(r.bottom, c.bottom);
      const overlap = right - left > 1 && bottom - top > 1;
      if (localControls.has(control)) {
        if ((control.clientWidth > 0 && control.scrollWidth > control.clientWidth + 1) || overlap) { blocked = true; break; }
      } else if (overlap && typeof doc.elementFromPoint === 'function') {
        const hit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        if (hit === control || control.contains(hit)) { blocked = true; break; }
      }
    }
    node.hidden = blocked;
    node.style.display = blocked ? 'none' : 'flex';
    if (blocked) hideCard();
  }
  function syncTheme() {
    if (!node || !composer) return;
    node.style.color = win.getComputedStyle(composer.row).color;
    let background;
    for (let element = composer.editor; element && element !== doc.documentElement; element = element.parentElement) {
      const value = win.getComputedStyle(element).backgroundColor;
      if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') { background = value; break; }
    }
    if (card) {
      if (background) card.style.background = background;
      if (node.style.color) card.style.color = node.style.color;
    }
  }
  function syncRoute() {
    const next = conversationId();
    if (next === route) return;
    route = next; pending = null; data = null; lastFetch = 0;
    hideCard(); render();
  }
  function mount() {
    syncRoute();
    const found = route && findComposer();
    if (!found) { hideCard(); node?.remove(); composer = null; resizeObserver?.disconnect(); return; }
    const changed = composer?.row !== found.row || composer?.branch !== found.branch;
    composer = found;
    if (!node) createNode();
    if (!node.isConnected || changed) {
      hideCard(); found.row.insertBefore(node, found.branch.nextSibling);
      resizeObserver?.disconnect();
      if (typeof win.ResizeObserver === 'function') {
        resizeObserver ||= new win.ResizeObserver(schedule);
        for (const target of [found.row, found.editor, found.branch]) resizeObserver.observe(target);
      }
    }
    syncTheme(); fit(); positionCard();
  }
  function refresh() {
    if (!enabled || disposed || doc.hidden || !route || !node?.isConnected || node.hidden) return;
    if (pending && Date.now() - pending.at < 25000) return;
    if (Date.now() - lastFetch < 3000) return;
    if (pending || (data?.sampledAt && Date.now() - data.sampledAt > 30000)) data = null;
    const requestId = String(++sequence);
    pending = { requestId, conversationId: route, at: Date.now() }; lastFetch = Date.now();
    try { report({ type: 'context-metrics', requestId, conversationId: route }); }
    catch { pending = null; data = null; }
    render();
  }
  function receive(requestId, result) {
    if (disposed || !pending || pending.requestId !== requestId || pending.conversationId !== conversationId()
      || result?.conversationId !== pending.conversationId) return;
    pending = null; data = result; render(); fit();
  }
  function schedule() {
    if (disposed || frame !== undefined) return;
    frame = win.requestAnimationFrame(() => { frame = undefined; if (!disposed) { mount(); refresh(); } });
  }
  const onPointer = event => { if (!event.composedPath().includes(node)) hideCard(); };
  const onKey = event => { if (event.key === 'Escape') { const focused = Boolean(shadow?.activeElement); hideCard(); if (focused) button?.focus({ preventScroll: true }); } };
  doc.addEventListener('pointerdown', onPointer);
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('scroll', schedule, true);
  win.addEventListener('resize', schedule);
  observer = new win.MutationObserver(records => {
    if (records.some(record => record.target !== node && !node?.contains(record.target))) schedule();
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });
  const timer = win.setInterval(() => { mount(); refresh(); }, 1000);
  win.__goagyContext = { receive, dispose() {
    disposed = true; pending = null; data = null; hideCard(); node?.remove();
    win.clearInterval(timer); if (frame !== undefined) win.cancelAnimationFrame(frame);
    observer.disconnect(); resizeObserver?.disconnect();
    doc.removeEventListener('pointerdown', onPointer); doc.removeEventListener('keydown', onKey);
    doc.removeEventListener('scroll', schedule, true); win.removeEventListener('resize', schedule);
    delete win.__goagyContext;
  } };
  mount(); refresh();
}

module.exports = { installContextWidget };
