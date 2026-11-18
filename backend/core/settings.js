const fs = require('node:fs');
const { readJson, writeJson } = require('./storage');
const { normalizePromptTier, normalizeContextMode } = require('../features/kernel-patch');

const DEFAULTS = Object.freeze({
  port: 7890,
  enableI18n: true,
  enableContextMonitor: true,
  // New installs use balanced v2 core guidance and a 512K local ceiling. Existing files
  // without a payload version remain v1 preferences until an explicit prompt application.
  promptTier: '4',
  promptPayloadVersion: 2,
  contextMode: '512k',
  autoApplyKernelPatch: true,
  // Verified before every launch: a dead or misrouted proxy is what AG reports as an opaque
  // "HTTP 400 / User location is not supported" dialog, so the launcher checks the exit itself.
  preflightProxy: true,
  mobileAutoStart: false,
  mobileMode: 'quick',
  mobileFixedUrl: ''
});

const KERNEL_DEFAULTS = Object.freeze({ promptTier: DEFAULTS.promptTier, contextMode: DEFAULTS.contextMode });

function normalizeMobileUrl(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value !== value.trim()) throw new Error('固定域名必须是 HTTPS 地址');
  let url;
  try { url = new URL(value); } catch { throw new Error('固定域名必须是 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.search || url.hash || url.pathname !== '/' ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?[.])+[a-z]{2,}$/i.test(url.hostname) ||
      ![url.origin, url.origin + '/'].includes(value)) {
    throw new Error('固定域名只支持不含路径、端口或凭据的 HTTPS 域名');
  }
  return url.origin;
}

function normalizeSettings(input = {}, previous = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置必须是对象');
  const result = { ...DEFAULTS, ...previous };
  if (input.port !== undefined) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('代理端口必须是 1–65535 的整数');
    result.port = port;
  }
  for (const key of ['enableI18n', 'enableContextMonitor', 'autoApplyKernelPatch', 'preflightProxy', 'mobileAutoStart']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      result[key] = input[key];
    }
  }
  for (const [key, normalize] of [['promptTier', normalizePromptTier], ['contextMode', normalizeContextMode]]) {
    if (input[key] !== undefined) {
      const value = normalize(input[key]);
      if (value === null) throw new Error(`${key} 取值不受支持`);
      result[key] = value;
    }
  }
  if (input.promptPayloadVersion !== undefined) {
    if (![1, 2].includes(input.promptPayloadVersion)) throw new Error("promptPayloadVersion 取值不受支持");
    result.promptPayloadVersion = input.promptPayloadVersion;
  }
  if (input.mobileMode !== undefined) {
    if (!['quick', 'fixed'].includes(input.mobileMode)) throw new Error('手机远程模式必须是 quick 或 fixed');
    result.mobileMode = input.mobileMode;
  }
  if (input.mobileFixedUrl !== undefined) result.mobileFixedUrl = normalizeMobileUrl(input.mobileFixedUrl);
  return result;
}

function createSettings(file) {
  let value;
  const defaults = { ...DEFAULTS, promptPayloadVersion: fs.existsSync(file) ? 1 : 2 };
  try { value = normalizeSettings(readJson(file, {}), defaults); } catch { value = defaults; }
  return {
    get: () => ({ ...value }),
    update(input) {
      const next = normalizeSettings(input, value);
      writeJson(file, next);
      value = next;
      return this.get();
    }
  };
}

function assertLaunchSettingsMutable(input, previous, phase) {
  if (!['running', 'preparing', 'launching'].includes(phase)) return;
  if (input.port !== undefined && Number(input.port) !== previous.port) {
    throw new Error('代理端口将在 AG 退出后才能修改');
  }
}

module.exports = { DEFAULTS, KERNEL_DEFAULTS, normalizeMobileUrl, normalizeSettings, createSettings, assertLaunchSettingsMutable };
