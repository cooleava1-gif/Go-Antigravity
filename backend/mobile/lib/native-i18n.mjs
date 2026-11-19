import { readFileSync } from 'node:fs';

export const NATIVE_I18N_PATH = '/__goagy-pocket/zh-cn.js';

const nativeLabels = {
  'Start Voice mode': '启动语音模式',
  'Search Conversations': '搜索对话',
  'Toggle Side Panel': '切换侧面板',
  'Agent permissions preset selector': '代理权限预设选择器',
  'New': '新',
  'Unavailable': '不可用'
};

// Dictionary order follows the desktop i18n contract.
function loadDictionary() {
  const dictionary = Object.create(null);
  for (const name of ['ui_v2.json', 'common.json']) {
    const source = JSON.parse(readFileSync(new URL('../vendor/upstream-i18n/' + name, import.meta.url), 'utf8'));
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [key, value] of Object.entries(source)) {
      if (!key || key.trim() !== key || key.length > 2000 || typeof value !== 'string' || !value || value.length > 2000) continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      dictionary[key] = value;
    }
  }
  return Object.assign(dictionary, nativeLabels);
}

// Adapted from the bundled upstream MIT-licensed installI18n implementation; see vendor provenance.
// Serialized as an external browser asset: no Node globals, tokens or requests.
function installChineseLocalization(dictionary) {
  'use strict';
  const runtimeKey = '__goagyPocketChineseLocalization';
  if (window[runtimeKey]) return;
  const attributes = ['placeholder', 'title', 'aria-label', 'data-placeholder'];
  const actualMessage = '[data-testid=user-message-content],[data-testid=planner-response-text],[data-quotable=true],[data-markdown-root]';
  const ignored = [
    'script', 'style', 'pre', 'code', actualMessage,
    '[data-testid*=message-content]', '.markdown', '.prose',
    '[data-testid=conversation-row-sidebar]',
    '[data-testid=breadcrumb-segment]',
    '[data-testid*=conversation-title]', '[data-testid*=chat-title]',
    '[data-conversation-title]', '.conversation-title', '.chat-title'
  ].join(',');
  const editable = 'textarea,input,[contenteditable]:not([contenteditable=false])';
  const fallbackMessage = '[data-message-id],[data-role=user],[data-role=assistant]';
  const model = '[data-testid=model-selector-trigger],[data-testid*=model-name],[data-model-name],.model-name';
  const translatedTexts = new WeakMap();
  const translatedAttributes = new WeakMap();

  function isIgnored(element) {
    if (!element) return false;
    if (element.closest(ignored)) return true;
    // Role/message wrappers may also contain action buttons. Only protect the
    // whole fallback when no precise content selector is present inside it.
    const fallback = element.closest(fallbackMessage);
    return Boolean(fallback && !fallback.querySelector(actualMessage));
  }

  function isModelValue(element, key) {
    if (key === 'New' || key === 'Unavailable' || key === 'Notice') return false;
    if (/^(?:Low|Medium|High)$/.test(key)) return true;
    if (element.closest(model)) return true;
    for (const attribute of ['data-model-base', 'data-model-label']) {
      const item = element.closest('[' + attribute + ']');
      if (item && key === item.getAttribute(attribute)) return true;
    }
    return false;
  }

  function translateValue(raw) {
    if (typeof raw !== 'string') return raw;
    const key = raw.trim();
    if (!key || !Object.hasOwn(dictionary, key) || dictionary[key] === key) return raw;
    // Callback preserves literal dollar replacement tokens and whitespace.
    return raw.replace(key, () => dictionary[key]);
  }

  function translateText(node) {
    const parent = node.parentElement;
    if (!node.isConnected || !parent || isIgnored(parent) || parent.closest(editable)) return;
    const raw = node.nodeValue;
    const key = raw?.trim();
    // Model identities and effort values remain data. Only menu badges translate.
    if (isModelValue(parent, key)) return;
    if (translatedTexts.get(node) === raw) return;
    const translated = translateValue(raw);
    if (translated !== raw) {
      translatedTexts.set(node, translated);
      node.nodeValue = translated;
    }
  }

  function translateAttribute(raw, element, name) {
    if (typeof raw !== 'string') return raw;
    if (name === 'aria-label') {
      // These two fixed accessibility prefixes are the only partial matches.
      // Copy the current model/permission value without interpreting it.
      for (const [prefix, translation] of [
        ['Select model, current: ', '选择模型，当前：'],
        ['Agent permissions preset selector, current: ', '代理权限预设选择器，当前：']
      ]) {
        if (raw.trim().startsWith(prefix)) return raw.replace(prefix, () => translation);
      }
    }
    const key = raw.trim();
    if (isModelValue(element, key)) return raw;
    return translateValue(raw);
  }

  function translateElement(element, attributeName) {
    if (!element.isConnected || isIgnored(element)) return;
    const editableAncestor = element.closest(editable);
    // Own accessibility/placeholder attributes are safe; typed text and nested
    // editable DOM stay untouched. The value property is never inspected.
    if (editableAncestor && editableAncestor !== element) return;
    let records = translatedAttributes.get(element);
    for (const name of attributeName ? [attributeName] : attributes) {
      const raw = element.getAttribute(name);
      if (records?.[name] === raw) continue;
      const translated = translateAttribute(raw, element, name);
      if (translated !== raw) {
        if (!records) {
          records = Object.create(null);
          translatedAttributes.set(element, records);
        }
        records[name] = translated;
        element.setAttribute(name, translated);
      }
    }
  }

  function translate(root) {
    if (!root?.isConnected) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (isIgnored(root)) return;
      translateElement(root);
      if (root.closest(editable)) return;
    }
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_ELEMENT | window.NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (isIgnored(node)) return window.NodeFilter.FILTER_REJECT;
          if (node.closest(editable)) {
            translateElement(node);
            return window.NodeFilter.FILTER_REJECT;
          }
        }
        return window.NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === 3) translateText(node);
      else translateElement(node);
    }
  }

  // WeakMaps never retain detached stream nodes. Process records directly with
  // no persistent pending-node set, timer, or removed-node traversal.
  const observer = new window.MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) translate(node);
      } else if (mutation.type === 'characterData') {
        translateText(mutation.target);
      } else if (mutation.type === 'attributes') {
        translateElement(mutation.target, mutation.attributeName);
      }
    }
  });
  window[runtimeKey] = { dispose() { observer.disconnect(); delete window[runtimeKey]; } };
  document.documentElement.lang = 'zh-CN';
  translate(document.documentElement);
  observer.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes
  });
}

const safeDictionary = JSON.stringify(loadDictionary()).replace(/[<>&\u2028\u2029]/g, character =>
  '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));

export const nativeI18nSource = ';(' + installChineseLocalization.toString() + ')(' + safeDictionary + ');\n';

export function injectChineseLocalization(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // HTML markup is ASCII; latin1 preserves every original byte around the insert.
  const html = buffer.toString('latin1');
  const tags = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/(head|body)\s*>/gi;
  let head = -1;
  let body = -1;
  for (const match of html.matchAll(tags)) {
    if (match[1]?.toLowerCase() === 'script') {
      const openTag = match[0].slice(0, match[0].indexOf('>') + 1);
      const src = /(?:\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
      if (src && (src[1] ?? src[2] ?? src[3]) === NATIVE_I18N_PATH) return buffer;
    } else if (match[2]?.toLowerCase() === 'head' && head === -1) head = match.index;
    else if (match[2]?.toLowerCase() === 'body' && body === -1) body = match.index;
  }
  const position = head !== -1 ? head : body !== -1 ? body : buffer.length;
  const script = Buffer.from('<script defer src="' + NATIVE_I18N_PATH + '"></script>');
  return Buffer.concat([buffer.subarray(0, position), script, buffer.subarray(position)]);
}
