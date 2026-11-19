const { installI18n } = require('../../features/i18n');
const { installContextWidget } = require('../../features/context-widget');

function rendererSource(dictionary, settings, binding) {
  return `(() => {
    if (window !== window.top) return;
    const generation = (window.__goAntigravityMountGeneration || 0) + 1;
    window.__goAntigravityMountGeneration = generation;
    function mount() {
      if (window.__goAntigravityMountGeneration !== generation) return;
      (${installI18n.toString()})(window, document, ${JSON.stringify(dictionary)}, ${settings.enableI18n});
      (${installContextWidget.toString()})(window, document, ${settings.enableContextMonitor === true}, event => {
        if (typeof window[${JSON.stringify(binding)}] === 'function') window[${JSON.stringify(binding)}](JSON.stringify(event));
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  })();`;
}

// Runs inside the renderer. Any application UI, editor, status/error view, or loading signal
// rules out automatic recovery; a blank root/background alone does not count as UI.
function workbenchHealth(window, document) {
  const url = window.location.href;
  const documentId = window.performance.timeOrigin;
  const result = state => ({ state, url, documentId });
  if (document.readyState !== 'complete' || !document.body || document.hidden) return result('loading');
  if (document.querySelector('input,textarea,select,button,a[href],iframe,webview,canvas,svg,img,video,audio,object,embed,[contenteditable]:not([contenteditable="false"]),[role],[aria-busy="true"],.monaco-editor,.welcomePage,.error,.error-message,.notification-toast,.progress,.loading')) return result('content');
  const walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (!text.parentElement?.closest('script,style,template,noscript') && text.nodeValue?.trim()) return result('content');
  }
  // CSS-generated content and painted panels can be meaningful even without text. Inspect
  // a bounded number of elements and refuse to guess on a larger or unsupported document.
  const elements = [...document.body.querySelectorAll('*')];
  if (elements.length > 200) return result('content');
  for (const element of [document.documentElement, document.body, ...elements].filter(Boolean)) {
    if (element.matches('script,style,template,noscript')) continue;
    // Shadow/custom hosts can contain an entire editor, including closed shadow trees.
    if (element.shadowRoot || element.localName?.includes('-')) return result('content');
    for (const pseudo of [null, '::before', '::after']) {
      const style = window.getComputedStyle(element, pseudo);
      if ((pseudo && style.content && !['none', 'normal', '""', "''"].includes(style.content))
        || (style.backgroundImage && style.backgroundImage !== 'none')) return result('content');
      if (!pseudo && element !== document.body && element !== document.documentElement && element.getClientRects().length && style.display !== 'none' && style.visibility !== 'hidden'
        && ((style.backgroundColor && !['transparent', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor))
          || ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].some(key => parseFloat(style[key]) > 0))) return result('content');
    }
  }
  return result('blank');
}

const healthSource = '(' + workbenchHealth.toString() + ')(window, document)';
const disposeSource = 'window.__goAntigravityMountGeneration = (window.__goAntigravityMountGeneration || 0) + 1; window.__goAntigravityI18n?.dispose(); window.__goAntigravityContext?.dispose();';
module.exports = { rendererSource, disposeSource, workbenchHealth, healthSource };
