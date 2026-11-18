const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Adding an account through Google's own consent screen, aligned with cockpit-tools:
// open the authorize URL in the browser (or copy it to any browser / incognito window),
// Google redirects back to our loopback API with a single-use code (or user pastes the
// callback URL manually), and the code is exchanged for tokens that join the pool.
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALLBACK_PATH = '/oauth-callback';
const FLOW_TTL_MS = 10 * 60 * 1000;

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode'
];

function buildAuthUrl({ clientId, redirectUri, state, loginHint }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  if (loginHint && String(loginHint).trim()) {
    params.set('login_hint', String(loginHint).trim());
  }
  return `${AUTH_URL}?${params.toString()}`;
}

// Single-use CSRF tokens with metadata for cockpit-tools style OAuth modal (copy link,
// manual callback paste, or cancel).
function createFlowStore({ ttlMs = FLOW_TTL_MS, now = () => Date.now() } = {}) {
  const flows = new Map();
  let latestState = null;
  const sweep = () => {
    for (const [state, entry] of flows) {
      if (entry.expiresAt <= now()) {
        flows.delete(state);
        if (latestState === state) latestState = null;
      }
    }
  };
  return {
    begin(meta = {}) {
      sweep();
      const state = randomUUID();
      const createdAt = now();
      flows.set(state, { state, createdAt, expiresAt: createdAt + ttlMs, ...meta });
      latestState = state;
      return state;
    },
    attach(state, meta = {}) {
      sweep();
      const entry = flows.get(state);
      if (!entry) return null;
      Object.assign(entry, meta);
      return { ...entry };
    },
    active() {
      sweep();
      if (latestState && flows.has(latestState)) return { ...flows.get(latestState) };
      const last = [...flows.values()].pop();
      return last ? { ...last } : null;
    },
    consume(state) {
      sweep();
      if (!flows.has(state)) return null;
      const entry = flows.get(state);
      flows.delete(state);
      if (latestState === state) latestState = [...flows.keys()].pop() || null;
      return entry;
    },
    cancel(state = null) {
      sweep();
      if (state) {
        flows.delete(state);
        if (latestState === state) latestState = [...flows.keys()].pop() || null;
      } else {
        flows.clear();
        latestState = null;
      }
    },
    get size() { sweep(); return flows.size; }
  };
}

// Parses manual callback URL or authorization code input (aligned with cockpit-tools
// submit_oauth_callback_url).
function parseCallbackInput(rawInput, fallbackState = null) {
  const text = String(rawInput || '').trim();
  if (!text) throw new Error('请粘贴 Google 授权回调链接或授权码');
  if (/^https?:\/\//i.test(text) || text.startsWith('/oauth-callback') || text.includes('code=')) {
    let url;
    try {
      url = text.startsWith('http')
        ? new URL(text)
        : new URL(text.startsWith('/') ? text : `/oauth-callback?${text.replace(/^\?/, '')}`, 'http://127.0.0.1');
    } catch {
      throw new Error('回调链接格式无效，请复制浏览器地址栏完整 URL');
    }
    const error = url.searchParams.get('error');
    if (error) throw new Error(`Google 返回授权错误：${error}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || fallbackState;
    if (!code) throw new Error('回调链接中缺少 code 参数');
    if (!state) throw new Error('回调链接中缺少 state 参数，请重新发起授权');
    return { code: code.trim(), state: state.trim() };
  }
  if (!fallbackState) throw new Error('当前没有进行中的授权会话，请先点击「授权添加」');
  return { code: text, state: fallbackState };
}

// Parses single refresh_token or cockpit-tools JSON / JSON array token import payload.
function assertUnmaskedToken(token, masked = false) {
  if (masked || /…|[.]{3}|[*]{3}/u.test(token)) {
    throw new Error('脱敏令牌不能导入；请使用包含完整令牌的导出内容或重新授权');
  }
}

function parseTokenImportInput(rawInput, defaultEmail = null) {
  const text = String(rawInput || '').trim();
  if (!text) throw new Error('请填写 refresh_token 或 JSON 令牌内容');
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('JSON 格式解析失败，请检查括号与引号');
    }
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.accounts) ? parsed.accounts : [parsed]);
    const results = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rt = item.refresh_token || item.refreshToken || item.token?.refresh_token || item.token?.refreshToken;
      if (typeof rt === 'string' && rt.trim()) {
        assertUnmaskedToken(rt, item.refreshTokenMasked === true || item.refresh_token_masked === true
          || item.token?.refreshTokenMasked === true || item.token?.refresh_token_masked === true);
        results.push({
          refreshToken: rt.trim(),
          email: (item.email || item.user?.email || defaultEmail || '').trim() || null,
          name: (item.name || item.displayName || '').trim() || null
        });
      }
    }
    if (!results.length) throw new Error('JSON 中未找到有效的 refresh_token 字段');
    return results;
  }
  assertUnmaskedToken(text);
  return [{
    refreshToken: text,
    email: defaultEmail ? String(defaultEmail).trim() || null : null,
    name: null
  }];
}

function openInBrowser(url, platform = process.platform, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    if (platform === 'win32') {
      child = spawnProcess('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true });
    } else if (platform === 'darwin') {
      child = spawnProcess('open', [url]);
    } else {
      child = spawnProcess('xdg-open', [url]);
    }
    child.once('error', reject);
    child.once('close', code => (code === 0 ? resolve() : reject(new Error(`打开浏览器失败（退出码 ${code}）`))));
  });
}

module.exports = {
  buildAuthUrl,
  createFlowStore,
  parseCallbackInput,
  parseTokenImportInput,
  openInBrowser,
  AUTH_URL,
  CALLBACK_PATH,
  FLOW_TTL_MS,
  SCOPES
};
