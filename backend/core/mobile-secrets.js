'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('./storage');
const { isEncrypted } = require('./vault');
const { normalizeMobileUrl } = require('./settings');

const credentialError = (code = 'MOBILE_CREDENTIAL_UNAVAILABLE') => Object.assign(new Error(
  code === 'MOBILE_CREDENTIAL_SAVE_FAILED' ? '手机隧道凭据保存失败，请重试。' : '手机隧道凭据暂不可用，请解锁本地加密存储或重新配置。'
), { code, status: code === 'MOBILE_CREDENTIAL_SAVE_FAILED' ? 500 : 503 });
const invalidToken = () => Object.assign(new Error('隧道 Token 格式无效。'), { code: 'MOBILE_TOKEN_INVALID', status: 400 });
function validateTunnelToken(value) {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9._~+/-]+=*$(?![\s\S])/.test(value)) throw invalidToken();
  return value;
}
const mobileFields = ['mobileAutoStart', 'mobileMode', 'mobileFixedUrl'];
const mobileSettings = value => Object.fromEntries(mobileFields.map(key => [key, value[key]]));
function validCiphertext(value) {
  if (!isEncrypted(value) || value.length > 22000) return false;
  const payload = value.slice('enc:v1:'.length);
  return /^[A-Za-z0-9+/]+=*$(?![\s\S])/.test(payload) && Buffer.from(payload, 'base64').length > 28 &&
    Buffer.from(payload, 'base64').toString('base64') === payload;
}
function validState(value) {
  return value && Object.keys(value).every(key => ['version', 'tunnelToken', 'unavailable'].includes(key)) &&
    value.version === 1 && (value.tunnelToken === null || validCiphertext(value.tunnelToken)) &&
    (value.unavailable === undefined || value.unavailable === true);
}
function validJournal(value) {
  const prior = value?.settings;
  try {
    return value?.version === 1 && Object.keys(value).length === 3 && validState(value.secret) && prior &&
      Object.keys(prior).length === mobileFields.length && mobileFields.every(key => Object.hasOwn(prior, key)) &&
      typeof prior.mobileAutoStart === 'boolean' && ['quick', 'fixed'].includes(prior.mobileMode) &&
      normalizeMobileUrl(prior.mobileFixedUrl) === prior.mobileFixedUrl;
  } catch { return false; }
}

// Separate from settings and account exports. Never use the vault's plaintext fallback.
function createMobileSecrets(dataDir, { vault, settings, write = writeJson, remove = fs.unlinkSync } = {}) {
  const file = path.join(dataDir, 'mobile-vault.json');
  // Before-images contain only ciphertext and ordinary mobile settings, never a token.
  // The journal is removed last; its presence blocks every launch until rollback completes.
  const journalFile = path.join(dataDir, 'mobile-vault-transaction.json');
  let sealed = null, unreadable = false, pending = false, journal = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.version !== 1 || !(saved.tunnelToken === null || typeof saved.tunnelToken === 'string')) throw Error();
    sealed = saved.tunnelToken;
    unreadable = saved.unavailable === true || (sealed !== null && !isEncrypted(sealed));
  } catch (error) { if (error.code !== 'ENOENT') unreadable = true; }
  try { journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')); pending = true; }
  catch (error) { if (error.code !== 'ENOENT') pending = true; }
  function assertReady() { if (pending) throw credentialError(); }
  function canUseVault() {
    try { return vault?.canOpen?.() === true && vault?.sealEnabled?.() === true; } catch { return false; }
  }
  function token() {
    assertReady();
    if (unreadable || (sealed !== null && (!isEncrypted(sealed) || !canUseVault()))) throw credentialError();
    if (sealed === null) return null;
    try { return validateTunnelToken(vault.open(sealed)); } catch { throw credentialError(); }
  }
  function status() {
    const configured = pending || sealed !== null || unreadable;
    let available = false;
    if (configured) { try { available = Boolean(token()); } catch {} }
    return { configured, available };
  }
  function recover(target = settings) {
    if (!pending) return true;
    if (!validJournal(journal) || !target) return false;
    try {
      if (journal.secret.tunnelToken !== null) {
        if (!canUseVault()) return false;
        validateTunnelToken(vault.open(journal.secret.tunnelToken));
      }
      target.update(journal.settings);
      write(file, journal.secret);
      remove(journalFile);
      sealed = journal.secret.tunnelToken; unreadable = journal.secret.unavailable === true;
      pending = false; journal = null;
      return true;
    } catch { return false; }
  }
  // Preparation validates/encrypts without mutation. A before-image is durable before
  // either state file changes; a failed rollback remains fail-closed across reopen.
  function prepare(input) {
    assertReady();
    if (input.clearTunnelToken !== undefined && typeof input.clearTunnelToken !== 'boolean') throw invalidToken();
    if (input.tunnelToken !== undefined && typeof input.tunnelToken !== 'string') throw invalidToken();
    const value = input.tunnelToken;
    const set = value !== undefined && value !== '';
    if (set && input.clearTunnelToken === true) throw invalidToken();
    if (!set && input.clearTunnelToken !== true) return null;
    let next = null;
    if (set) {
      validateTunnelToken(value);
      if (!canUseVault()) throw credentialError();
      try {
        next = vault.seal(value);
        if (!isEncrypted(next) || vault.open(next) !== value) throw Error();
      } catch { throw credentialError(); }
    }
    return { commit(patch = {}) {
      assertReady();
      if (!settings) {
        try { write(file, { version: 1, tunnelToken: next }); } catch { throw credentialError('MOBILE_CREDENTIAL_SAVE_FAILED'); }
        sealed = next; unreadable = false;
        return;
      }
      const prior = { version: 1, tunnelToken: validCiphertext(sealed) ? sealed : null, ...(unreadable || (sealed !== null && !validCiphertext(sealed)) ? { unavailable: true } : {}) };
      const before = { version: 1, settings: mobileSettings(settings.get()), secret: prior };
      try { write(journalFile, before); }
      catch { // A writer may report failure after rename; re-read before allowing starts.
        try { journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')); pending = true; }
        catch (error) { if (error.code !== 'ENOENT') pending = true; }
        throw credentialError('MOBILE_CREDENTIAL_SAVE_FAILED');
      }
      pending = true; journal = before;
      try {
        settings.update(patch);
        write(file, { version: 1, tunnelToken: next });
        remove(journalFile);
        sealed = next; unreadable = false; pending = false; journal = null;
      } catch {
        recover();
        throw credentialError('MOBILE_CREDENTIAL_SAVE_FAILED');
      }
    } };
  }
  if (pending && settings) recover();
  return { token, status, prepare, assertReady, recover };
}

module.exports = { createMobileSecrets, validateTunnelToken, credentialError };
