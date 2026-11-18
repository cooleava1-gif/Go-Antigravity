const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { writeJson } = require('./storage');
const { redactSecrets } = require('./redact');
const { isEncrypted } = require('./vault');

// Token-pool registry. Antigravity keeps its IDE login in a system credential, so an
// "account" here is just a set of OAuth tokens + cached quota metadata: switching means
// rewriting the credential (see core/agcred.js) and restarting AG.
//
// Every entry is a real Google account's long-lived refresh token, so this file is the most
// valuable thing EasyAG owns. Loading therefore never destroys data silently: anything that
// cannot be read as the current schema is copied to accounts.bak-<timestamp>.json first, and
// salvageable accounts are migrated instead of dropped.
const STATE_VERSION = 2;
const BACKUP_KEEP = 5;
const BACKUP_PATTERN = /^accounts\.bak-(\d{8}-\d{6})(?:-\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?\.json$/i;
const ACCOUNT_FIELDS = ['id', 'name', 'email', 'accessToken', 'refreshToken', 'expiryTs', 'source', 'clientType', 'tier', 'quota', 'createdAt', 'lastSwitchedAt', 'status', 'lastError', 'lastErrorAt'];
// Fields that never leave the disk in the clear once the vault is unlocked.
const TOKEN_FIELDS = ['refreshToken', 'accessToken'];
const LOCKED_MESSAGE = '本地令牌无法解密（主密钥缺失或已变更），请重新授权';

// Key order in the file is irrelevant to meaning, so compare canonically; otherwise every
// boot would look like a "repair" and write a backup for an untouched account pool.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Only the fields actually present in the file take part in the comparison: a record written by
// an older build simply lacks newer optional fields (status, lastErrorAt...), and filling in a
// default is not a repair. A conflicting value, however, does mean the file needs rewriting.
function sameAccount(raw, normalized) {
  if (!raw || typeof raw !== 'object') return false;
  for (const key of ACCOUNT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (stableStringify(raw[key]) !== stableStringify(normalized[key])) return false;
  }
  return raw.refreshToken === normalized.refreshToken;
}

function maskToken(token) {
  const text = String(token || '');
  if (text.length <= 10) return '***';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function freshState() {
  return { version: STATE_VERSION, accounts: [], activeId: null };
}

function stamp() {
  const d = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

// Keep a short rolling window of pre-change snapshots so a bad migration or a corrupted
// write can always be undone by hand, without letting backups grow without bound.
function backupFile(dataDir, raw, { prune = true } = {}) {
  const target = path.join(dataDir, `accounts.bak-${stamp()}-${randomUUID()}.json`);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, raw);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (cause) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* retain the backup error */ }
    }
    if (created) {
      try { fs.unlinkSync(target); } catch { /* original file is still intact */ }
    }
    const error = new Error('账户池原文件备份失败，已停止恢复以保留原文件', { cause });
    error.code = 'ACCOUNT_BACKUP_FAILED';
    throw error;
  }
  if (!prune) return target;
  try {
    const backups = fs.readdirSync(dataDir)
      .filter(name => BACKUP_PATTERN.test(name))
      .map(name => ({ name, stat: fs.lstatSync(path.join(dataDir, name)) }))
      .filter(entry => entry.stat.isFile())
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name));
    // Never prune the snapshot just flushed, even when clocks or timestamp resolution tie.
    const obsolete = backups.filter(entry => path.join(dataDir, entry.name) !== target)
      .slice(0, Math.max(0, backups.length - BACKUP_KEEP));
    for (const entry of obsolete) {
      try { fs.unlinkSync(path.join(dataDir, entry.name)); } catch { /* best effort */ }
    }
  } catch { /* pruning is cosmetic */ }
  return target;
}

// Seal the parsed pre-repair snapshot, not normalized survivors: dropped/duplicate records
// and unknown fields are part of the recovery data too. Preserve existing ciphertext as-is.
function backupParsedState(dataDir, raw, parsed, vault) {
  if (!vault?.sealEnabled()) return backupFile(dataDir, raw);
  const sealTokens = value => {
    if (Array.isArray(value)) return value.map(sealTokens);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      TOKEN_FIELDS.includes(key) && typeof item === 'string' && item && !vault.isEncrypted(item)
        ? vault.seal(item) : sealTokens(item)]));
  };
  let sealed;
  try {
    sealed = JSON.stringify(sealTokens(parsed), null, 2) + '\n';
  } catch (cause) {
    const error = new Error('账户池灾备令牌加密失败，已停止恢复以保留原文件', { cause });
    error.code = 'ACCOUNT_BACKUP_FAILED';
    throw error;
  }
  // Adding a protected backup must not delete or rewrite any historical recovery copy.
  return backupFile(dataDir, sealed, { prune: false });
}

// Disk -> memory: ciphertext becomes plaintext here, and only here. When the vault cannot open
// a value (master key lost, file copied from another machine) the ciphertext is kept as-is and
// the account is flagged `locked`, so the UI can ask for re-authorization instead of the loader
// silently dropping a valid record.
function decryptRecord(raw, vault, notice) {
  if (!vault || !raw || typeof raw !== 'object') return raw;
  let record = raw;
  let locked = false;
  for (const field of TOKEN_FIELDS) {
    const value = raw[field];
    if (!vault.isEncrypted(value)) continue;
    try {
      const plaintext = vault.open(value);
      if (record === raw) record = { ...raw };
      record[field] = plaintext;
    } catch (error) {
      locked = true;
      notice(`${raw.email || raw.name || '某账户'} 的本地令牌无法解密：${error.message}`, 'warn');
    }
  }
  if (locked) {
    if (record === raw) record = { ...raw };
    record.locked = true;
  }
  return record;
}

// Memory -> disk: seal a copy, never the live object. The runtime keeps plaintext so the
// credential writer and the token refresher keep working unchanged.
function sealRecord(account, vault) {
  if (!vault || !vault.sealEnabled()) return account;
  let sealed = null;
  for (const field of TOKEN_FIELDS) {
    const value = account[field];
    if (typeof value !== 'string' || !value || vault.isEncrypted(value)) continue;
    if (!sealed) sealed = { ...account };
    sealed[field] = vault.seal(value);
  }
  return sealed || account;
}

// Older layouts may carry profile-directory accounts (no refresh token) or partially filled
// records. Anything that still holds a refresh token is recoverable; the rest is reported.
function normalizeAccount(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken.trim() : '';
  if (!refreshToken) return null;
  const quota = raw.quota && typeof raw.quota === 'object' ? raw.quota : null;
  // A record we could not decrypt keeps its ciphertext. The lock is a *runtime* verdict, never
  // persisted: if the master key comes back (or the file was opened in plaintext mode once), the
  // account must return to its stored status instead of staying "expired" forever.
  const locked = raw.locked === true || isEncrypted(refreshToken);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : randomUUID(),
    name: String(raw.name || raw.email || `账户 ${index + 1}`).slice(0, 40),
    email: typeof raw.email === 'string' && raw.email ? raw.email : null,
    accessToken: typeof raw.accessToken === 'string' ? raw.accessToken : '',
    refreshToken,
    expiryTs: Number(raw.expiryTs) || 0,
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'manual',
    clientType: typeof raw.clientType === 'string' ? raw.clientType : null,
    tier: raw.tier || quota?.tier || null,
    quota,
    createdAt: Number(raw.createdAt) || Date.now(),
    lastSwitchedAt: Number(raw.lastSwitchedAt) || null,
    status: raw.status === 'expired' || raw.status === 'pending' ? raw.status : 'ok',
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    lastErrorAt: Number(raw.lastErrorAt) || null,
    locked
  };
}

function migrateState(parsed, notice, vault) {
  const from = parsed?.version;
  const list = Array.isArray(parsed?.accounts) ? parsed.accounts
    : Array.isArray(parsed?.items) ? parsed.items : [];
  const seen = new Set();
  const accounts = [];
  let dropped = 0;
  list.forEach((raw, index) => {
    const account = normalizeAccount(decryptRecord(raw, vault, notice), index);
    if (!account || seen.has(account.refreshToken)) {
      dropped += 1;
      return;
    }
    seen.add(account.refreshToken);
    accounts.push(account);
  });
  const activeId = accounts.some(item => item.id === parsed?.activeId) ? parsed.activeId : accounts[0]?.id || null;
  if (dropped > 0) {
    notice(`账户池迁移：保留 ${accounts.length} 个账户，跳过 ${dropped} 条缺少 refresh_token 或无令牌的旧记录`, 'warn');
  } else if (accounts.length) {
    notice(`账户池已从 v${from ?? '?'} 迁移到 v${STATE_VERSION}，共 ${accounts.length} 个账户`, 'info');
  }
  return { version: STATE_VERSION, accounts, activeId };
}

function loadState(file, dataDir, notice, vault = null) {
  const raw = (() => {
    try {
      return fs.readFileSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      notice(`读取账户池失败：${error.message}`, 'warn');
      throw error;
    }
  })();
  if (raw === null) return { state: freshState(), dirty: false, needsEncrypt: false };

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    const saved = backupFile(dataDir, raw);
    notice(`账户池文件无法解析（${error.message}），已备份为 ${saved ? path.basename(saved) : '（备份失败）'} 并重新开始`, 'warn');
    return { state: freshState(), dirty: true, needsEncrypt: false };
  }

  const looksUsable = parsed && typeof parsed === 'object'
    && parsed.version === STATE_VERSION
    && Array.isArray(parsed.accounts);
  if (!looksUsable) {
    const saved = backupParsedState(dataDir, raw, parsed, vault);
    const migrated = migrateState(parsed, notice, vault);
    if (saved) {
      notice(`账户池结构需升级（v${parsed?.version ?? '?'} → v${STATE_VERSION}），原文件已备份为 ${path.basename(saved)}`, 'info');
    }
    return { state: migrated, dirty: true, needsEncrypt: false };
  }

  // Same schema: still normalize, because a hand-edited record must not crash the launcher.
  const accounts = [];
  let repaired = false;
  let plaintextTokens = false;
  parsed.accounts.forEach((raw, index) => {
    const record = decryptRecord(raw, vault, notice);
    const account = normalizeAccount(record, index);
    if (!account) { repaired = true; return; }
    if (!sameAccount(record, account)) repaired = true;
    // Judge the *file* contents, not the decrypted copy: after the first encrypted save every
    // boot would otherwise look like "needs encrypting" and rewrite the pool for nothing.
    if (vault?.sealEnabled() && TOKEN_FIELDS.some(field => {
      const value = raw[field];
      return typeof value === 'string' && value && !vault.isEncrypted(value);
    })) plaintextTokens = true;
    accounts.push(account);
  });
  const activeId = accounts.some(item => item.id === parsed.activeId) ? parsed.activeId : accounts[0]?.id || null;
  if (repaired) {
    const saved = backupParsedState(dataDir, raw, parsed, vault);
    notice(`账户池存在不完整记录，已规范化${saved ? `（原文件备份为 ${path.basename(saved)}）` : ''}`, 'info');
  }
  // `needsEncrypt` is deliberately separate from `dirty`: upgrading a plaintext pool must not
  // write a plaintext backup, otherwise the "安全" step leaves a copy of the old secrets behind.
  return { state: { version: STATE_VERSION, accounts, activeId }, dirty: repaired, needsEncrypt: plaintextTokens && !repaired };
}

function createAccounts(dataDir, { onNotice = () => {}, vault = null } = {}) {
  const file = path.join(dataDir, 'accounts.json');
  const notice = (message, level = 'info') => {
    try { onNotice(message, level); } catch { /* logging must never block loading */ }
  };
  const loaded = loadState(file, dataDir, notice, vault);
  let state = loaded.state;
  const serialize = () => ({
    ...state,
    accounts: state.accounts.map(account => {
      const sealed = sealRecord(account, vault);
      const { locked, ...persisted } = sealed;   // 运行时状态，不落盘
      return persisted;
    })
  });
  const save = () => writeJson(file, serialize());
  // Persist migrated/repaired state once right away, so the next launch does not migrate and
  // re-back-up the same file again.
  if (loaded.needsEncrypt) {
    save();
    notice(`账户池已升级为本地加密存储（${state.accounts.length} 个账户的令牌不再明文落盘）`, 'info');
  }
  if (loaded.dirty || !fs.existsSync(file)) save();
  const find = id => state.accounts.find(account => account.id === id) || null;
  // Runtime-only generations let asynchronous callers reject stale results, including a
  // same-token reauthorization or an account removed and recreated while awaiting I/O.
  let nextCredentialRevision = 0;
  const credentialRevisions = new Map();
  const reviseCredentials = id => credentialRevisions.set(id, ++nextCredentialRevision);
  for (const account of state.accounts) reviseCredentials(account.id);
  const credentialKey = account => JSON.stringify([account.accessToken, account.refreshToken,
    account.expiryTs, account.clientType, Boolean(account.locked)]);
  // All disk-writing mutators share one synchronous transaction. Restore the original
  // objects too: asynchronous callers may still hold a reference returned by find/all.
  // Mutators only replace account fields, so their previous field values are sufficient.
  const transact = mutate => (...args) => {
    const previousState = { ...state, accounts: [...state.accounts] };
    const previousAccounts = previousState.accounts.map(account => [account, { ...account }]);
    const previousRevisions = new Map(credentialRevisions);
    const previousRevision = nextCredentialRevision;
    try {
      return mutate(...args);
    } catch (error) {
      for (const [account, previous] of previousAccounts) {
        for (const key of Object.keys(account)) {
          if (!Object.hasOwn(previous, key)) delete account[key];
        }
        Object.assign(account, previous);
      }
      state = previousState;
      credentialRevisions.clear();
      for (const [id, revision] of previousRevisions) credentialRevisions.set(id, revision);
      nextCredentialRevision = previousRevision;
      throw error;
    }
  };
  const clearCredentialCache = account => {
    account.accessToken = '';
    account.expiryTs = 0;
    account.clientType = null;
    account.quota = null;
    account.tier = null;
    account.status = 'pending';
    account.lastError = null;
    account.lastErrorAt = null;
  };
  const publicView = (account, liveRefreshToken) => ({
    id: account.id,
    name: account.name,
    email: account.email || null,
    source: account.source,
    expiryTs: account.expiryTs || null,
    clientType: account.clientType || null,
    tier: account.quota?.tier || account.tier || null,
    quota: account.quota || null,
    lastSwitchedAt: account.lastSwitchedAt || null,
    status: account.locked ? 'expired' : (account.status || 'ok'),
    locked: Boolean(account.locked),
    lastError: account.locked ? LOCKED_MESSAGE : (account.lastError || null),
    lastErrorAt: account.locked ? (account.lastErrorAt || Date.now()) : (account.lastErrorAt || null),
    isLive: Boolean(liveRefreshToken) && account.refreshToken === liveRefreshToken
  });

  const snapshot = (liveRefreshToken = null) => ({
    activeId: state.activeId,
    liveId: state.accounts.find(account => account.refreshToken === liveRefreshToken)?.id || null,
    items: state.accounts.map(account => publicView(account, liveRefreshToken))
  });

  const upsert = transact(({ id = null, name, email, accessToken, refreshToken, expiryTs, source, clientType, quota, select = false, status = 'ok' }) => {
    if (!refreshToken) throw new Error('缺少 refresh_token');
    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
    let account = (id ? state.accounts.find(item => item.id === id) : null)
      || state.accounts.find(item => item.refreshToken === refreshToken)
      || (normalizedEmail ? state.accounts.find(item => (item.email || '').trim().toLowerCase() === normalizedEmail) : null);
    if (account) {
      if (account.refreshToken !== refreshToken) clearCredentialCache(account);
      account.accessToken = accessToken || account.accessToken;
      account.refreshToken = refreshToken;
      account.expiryTs = expiryTs || account.expiryTs;
      if (source) account.source = source;
      if (clientType) account.clientType = clientType;
      if (quota) {
        account.quota = quota;
        if (quota.tier) account.tier = quota.tier;
      }
      if (email && !account.email) {
        account.email = email;
        account.name = String(name || email).slice(0, 40);
      }
      // A fresh token means a fresh verdict from Google; drop the stale error badge and any
      // 'could not decrypt' lock from a previous key.
      account.locked = false;
      account.status = status;
      account.lastError = null;
      account.lastErrorAt = null;
    } else {
      account = {
        id: randomUUID(),
        name: String(name || email || `账户 ${state.accounts.length + 1}`).slice(0, 40),
        email: email || null,
        accessToken: accessToken || '',
        refreshToken,
        expiryTs: expiryTs || 0,
        source: source || 'manual',
        clientType: clientType || null,
        tier: quota?.tier || null,
        quota: quota || null,
        createdAt: Date.now(),
        status,
        lastError: null,
        lastErrorAt: null
      };
      state.accounts.push(account);
    }
    if (select || !state.activeId) state.activeId = account.id;
    reviseCredentials(account.id);
    save();
    return account;
  });

  return {
    file,
    snapshot,
    active: () => find(state.activeId),
    all: () => [...state.accounts],
    find,
    credentialRevision: id => find(id) ? credentialRevisions.get(id) : null,
    select: transact(id => {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      state.activeId = account.id;
      save();
      return snapshot();
    }),
    upsert,
    updateTokens: transact((id, { accessToken, refreshToken, expiryTs, clientType, email, name }) => {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      const before = credentialKey(account);
      // A validated OAuth refresh may rotate the refresh token without changing the
      // account. Keep its last known quota/verdict if a later quota request fails.
      const completeRotation = typeof accessToken === 'string' && Boolean(accessToken)
        && Number.isFinite(Number(expiryTs)) && Number(expiryTs) > 0;
      if (refreshToken && account.refreshToken !== refreshToken && !completeRotation) clearCredentialCache(account);
      if (accessToken) account.accessToken = accessToken;
      if (refreshToken) { account.refreshToken = refreshToken; account.locked = false; }
      if (expiryTs) account.expiryTs = expiryTs;
      if (clientType) account.clientType = clientType;
      if (email && !account.email) {
        account.email = email;
        if (!account.name || /^账户 \d+$|登录账户|授权账户/.test(account.name)) {
          account.name = String(name || email).slice(0, 40);
        }
      }
      if (credentialKey(account) !== before) reviseCredentials(id);
      save();
      return account;
    }),
    // Unconditional assignment (unlike updateTokens): used to undo a half-finished switch.
    restoreTokens: transact((id, tokens = {}) => {
      const account = find(id);
      if (!account) return null;
      reviseCredentials(id);
      for (const key of ['accessToken', 'refreshToken', 'expiryTs', 'clientType']) {
        if (tokens[key] === undefined) continue;
        account[key] = tokens[key];
        if (key === 'refreshToken') account.locked = false;
      }
      save();
      return account;
    }),
    updateQuota: transact((id, quota) => {
      const account = find(id);
      if (!account) return null;
      account.quota = quota && quota.error ? { ...quota, error: redactSecrets(quota.error) } : quota;
      if (quota?.tier) account.tier = quota.tier;
      save();
      return account;
    }),
    markSwitched: transact(id => {
      const account = find(id);
      if (!account) return null;
      account.lastSwitchedAt = Date.now();
      save();
      return account;
    }),
    // 'ok' | 'pending' (imported but not validated yet) | 'expired' (Google rejected the
    // refresh token, so the account needs a new authorization instead of a retry).
    markStatus: transact((id, { status = 'ok', error = null } = {}) => {
      const account = find(id);
      if (!account) return null;
      account.status = status;
      account.lastError = error ? redactSecrets(String(error)) : null;
      account.lastErrorAt = error ? Date.now() : null;
      save();
      return account;
    }),
    // Portable pool snapshot: tokens are masked unless explicitly requested, so the default
    // export can be pasted into an issue or a chat without leaking credentials.
    exportPool({ includeTokens = false } = {}) {
      return {
        version: STATE_VERSION,
        exportedAt: new Date().toISOString(),
        activeId: state.activeId,
        accounts: state.accounts.map(account => ({
          id: account.id,
          name: account.name,
          email: account.email || null,
          source: account.source,
          tier: account.tier || account.quota?.tier || null,
          status: account.locked ? 'expired' : (account.status || 'ok'),
          locked: Boolean(account.locked),
          refreshToken: includeTokens ? account.refreshToken : maskToken(account.refreshToken),
          refreshTokenMasked: !includeTokens,
          createdAt: account.createdAt || null,
          lastSwitchedAt: account.lastSwitchedAt || null,
          quota: account.quota
            ? { tier: account.quota.tier, tierName: account.quota.tierName, updatedAt: account.quota.updatedAt }
            : null
        }))
      };
    },
    remove: transact(id => {
      const account = find(id);
      if (!account) throw new Error('账户不存在');
      reviseCredentials(id);
      state.accounts = state.accounts.filter(item => item.id !== id);
      if (state.activeId === id) state.activeId = state.accounts[0]?.id || null;
      save();
      return snapshot();
    })
  };
}

module.exports = { createAccounts, normalizeAccount, migrateState, STATE_VERSION };
