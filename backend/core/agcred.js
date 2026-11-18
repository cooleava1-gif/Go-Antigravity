const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { redactSecrets } = require('./redact');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Antigravity >= 2.0 keeps its IDE login in a generic OS credential (Windows Credential
// Manager target "gemini:antigravity", macOS Keychain service "gemini", Linux secret-tool).
// Switching accounts therefore means rewriting that credential and restarting AG, which is
// how cockpit-tools and similar managers implement one-click switching. The payload is
// plain JSON - no encryption involved.
const CRED_TARGET = 'gemini:antigravity';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const REFRESH_MARGIN_SECONDS = 300;
const SCAN_CHUNK = 4 * 1024 * 1024;
const SCAN_CARRY = 1024;

function languageServerCandidates() {
  const roots = [];
  if (process.env.EASYAG_AG_EXE) roots.push(path.dirname(process.env.EASYAG_AG_EXE));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs/antigravity'));
  return roots.map(root => path.join(root, 'resources/bin/language_server.exe'));
}

// The OAuth client AG's AuthProvider refreshes tokens with - the same public client that
// cockpit-tools and Orbit-style managers authorize with. Verified end to end: a token issued
// to AG's other client (the one its login screen uses) is rejected with unauthorized_client,
// and once that token's access token expires about an hour later AG falls back to its login
// page. Authorizing with this client keeps every token EasyAG mints refreshable by AG itself.
// Secret matching uses SHA-256 fingerprints so no plaintext secret lives in the repository.
// Client ids are fingerprinted the same way. They are public identifiers rather than secrets,
// but keeping them out of the source has two concrete payoffs: GitHub secret scanning has
// nothing to trip over, and a rotated id fails loudly as "unknown client" instead of quietly
// matching a stale literal.
const AG_FINGERPRINTS = {
  refreshClientId: 'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea',
  refreshSecret: '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60',
  ideClientId: '69dee430c4e956f6b672b99a846566d6a86814999fc3b3b050697c0d65ea80c3',
  ideSecret: 'a2ddedc84850a9c48b7e01d61700848083bf0e10fb8d6c99c496803e8b48ced0'
};

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function isRefreshClientId(id, prints = AG_FINGERPRINTS) {
  return Boolean(id) && sha256Hex(id) === prints.refreshClientId;
}

function isIdeClientId(id, prints = AG_FINGERPRINTS) {
  return Boolean(id) && sha256Hex(id) === prints.ideClientId;
}

// Ids and secrets are separate strings in the binary. When the known SHA-256 fingerprint of
// the public refresh client's secret is present, rank that exact pair first so OAuth code
// exchange and token refresh succeed on the very first attempt without invalid_client noise.
// `prints` is injectable so the ranking rules can be tested without embedding real ids.
function extractOauthMarkers(text) {
  return {
    ids: [...new Set([...text.matchAll(/(\d{10,}-[a-z0-9]{32}\.apps\.googleusercontent\.com)/g)].map(match => match[1]))],
    secrets: [...new Set([...text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)].map(match => match[0]))]
  };
}

function extractOauthClients(text, prints = AG_FINGERPRINTS) {
  const { ids, secrets } = extractOauthMarkers(text);
  const clients = [];
  for (const id of ids) {
    for (const secret of secrets) clients.push({ id, secret });
  }
  const preferred = clients
    .filter(client => isRefreshClientId(client.id, prints))
    .sort((a, b) => (sha256Hex(b.secret) === prints.refreshSecret ? 1 : 0) - (sha256Hex(a.secret) === prints.refreshSecret ? 1 : 0))
    .slice(0, 2);
  const rest = clients
    .filter(client => !isRefreshClientId(client.id, prints))
    .sort((a, b) => {
      const scoreA = isIdeClientId(a.id, prints) && sha256Hex(a.secret) === prints.ideSecret ? 1 : 0;
      const scoreB = isIdeClientId(b.id, prints) && sha256Hex(b.secret) === prints.ideSecret ? 1 : 0;
      return scoreB - scoreA;
    });
  return [...preferred, ...rest].slice(0, 4);
}

async function scanBinaryForClients({ candidates = languageServerCandidates(), highWaterMark = SCAN_CHUNK, prints = AG_FINGERPRINTS } = {}) {
  for (const exe of candidates) {
    // Ids and secrets may live megabytes apart. Keep only matched strings across chunks,
    // then rank once the entire candidate has been read, including later preferred pairs.
    const ids = new Set(), secrets = new Set();
    try {
      const stream = fs.createReadStream(exe, { highWaterMark });
      let carry = '';
      for await (const chunk of stream) {
        const text = carry + chunk.toString('latin1');
        const markers = extractOauthMarkers(text);
        for (const id of markers.ids) ids.add(id);
        for (const secret of markers.secrets) secrets.add(secret);
        carry = text.slice(-SCAN_CARRY);
      }
    } catch { continue; /* discard incomplete reads and try the next candidate */ }
    const found = extractOauthClients([...ids, ...secrets].join('\n'), prints);
    if (found.length) return found;
  }
  return [];
}

let cachedBinaryClients = null;
async function loadOauthClients() {
  if (cachedBinaryClients && cachedBinaryClients.length) return cachedBinaryClients;
  const found = await scanBinaryForClients();
  if (found.length) cachedBinaryClients = found;
  return found;
}

function toRfc3339Micros(timestampMs) {
  const date = new Date(timestampMs);
  const pad = (value, size) => String(value).padStart(size, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` +
    `.${pad(date.getUTCMilliseconds(), 3)}000Z`;
}

function parseRfc3339(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function buildCredentialPayload({ accessToken, refreshToken, expiryTs }) {
  return JSON.stringify({
    token: {
      access_token: accessToken,
      token_type: 'Bearer',
      refresh_token: refreshToken,
      expiry: toRfc3339Micros(expiryTs || Date.now() + 3600 * 1000)
    },
    auth_method: 'consumer'
  });
}

function parseCredentialPayload(json) {
  const payload = JSON.parse(String(json || ''));
  const token = payload?.token || {};
  if (!token.refresh_token) throw new Error('AG 系统凭据缺少 refresh_token');
  return {
    accessToken: token.access_token || '',
    refreshToken: token.refresh_token,
    expiryTs: parseRfc3339(token.expiry)
  };
}

function parseTokenResponse(json) {
  const data = JSON.parse(String(json || ''));
  if (!data.access_token) throw new Error('令牌刷新响应缺少 access_token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 3600
  };
}

function describeTokenError(stdout) {
  try {
    const data = JSON.parse(String(stdout || ''));
    if (data.error) return `${data.error}${data.error_description ? `: ${data.error_description}` : ''}`;
  } catch { /* not a JSON error body */ }
  return null;
}

function tokenErrorCode(stdout) {
  try {
    const data = JSON.parse(String(stdout || ''));
    return typeof data?.error === 'string' ? data.error : null;
  } catch {
    return null;
  }
}

// Google answers invalid_grant / invalid_client when the refresh token was revoked, the account
// password changed, or AG rotated its OAuth client secret. Retrying cannot fix that: the account
// needs a fresh authorization, so the UI must offer "重新授权" instead of "重试".
const PERMANENT_TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

function tokenError(code, message) {
  const error = new Error(message);
  error.code = code || 'refresh_failed';
  error.permanent = PERMANENT_TOKEN_ERRORS.has(error.code);
  return error;
}

// curl exit codes users actually hit, translated into something actionable. The port matters:
// "7897 没开" is by far the most common cause of a failed refresh.
const CURL_EXIT_HINTS = {
  5: '无法解析代理地址',
  6: '域名解析失败（检查代理/DNS）',
  7: '无法连接本地代理，请先启动代理客户端或改正端口',
  28: '请求超时（代理不稳或上游太慢）',
  35: 'TLS 握手失败（代理可能不支持 CONNECT）',
  52: '服务端返回空响应',
  56: '连接被重置'
};

function describeNetworkFailure({ error, proxyPort, url }) {
  let host = '';
  try { host = new URL(url).host; } catch { host = '上游服务'; }
  const exitCode = typeof error?.code === 'number' ? error.code : null;
  const stderr = redactSecrets(String(error?.stderr || '').trim().split(/\r?\n/)[0] || '');
  const hint = (exitCode && CURL_EXIT_HINTS[exitCode]) || stderr || error?.message || '未知网络错误';
  const via = proxyPort ? `，经本地代理 127.0.0.1:${proxyPort}` : '';
  return `请求 ${host} 失败：${redactSecrets(hint)}${exitCode ? `（curl 退出码 ${exitCode}${via}）` : via ? `（${via.slice(1)}）` : ''}`;
}

function classifyClientType(clientId, prints = AG_FINGERPRINTS) {
  if (!clientId) return null;
  if (isIdeClientId(clientId, prints)) return 'ide';
  return 'public';
}

function createAgCred({ scriptPath, spawnProcess = spawn, execFileAsync = run, platform = process.platform, oauthClientLoader = loadOauthClients }) {
  const powershell = () => (platform === 'win32' ? 'powershell.exe' : 'pwsh');
  const oauthClients = async () => {
    try {
      return await oauthClientLoader();
    } catch { return []; }
  };

  // `target` selects which Windows credential to touch: AG's own login by default, or the
  // vault master key (`go-antigravity:accounts-key`) when the account pool needs encrypting.
  async function runScript(mode, stdinB64 = '', target = null) {
    return new Promise((resolve, reject) => {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Mode', mode];
      if (target) args.push('-Target', target);
      const child = spawnProcess(powershell(), args, {
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error((stderr || `agcred.ps1 exited with ${code}`).trim()));
      });
      if (child.stdin) {
        child.stdin.end(stdinB64);
      } else if (mode === 'write') {
        reject(new Error('无法向 agcred.ps1 写入输入'));
      }
    });
  }

  async function readSystemCredential() {
    if (platform !== 'win32') return null;
    const encoded = await runScript('read');
    if (!encoded) return null;
    return parseCredentialPayload(Buffer.from(encoded, 'base64').toString('utf8'));
  }

  async function writeSystemCredential({ accessToken, refreshToken, expiryTs }) {
    if (platform !== 'win32') throw new Error('当前平台不支持写入 AG 系统凭据');
    const payload = buildCredentialPayload({ accessToken, refreshToken, expiryTs });
    await runScript('write', Buffer.from(payload, 'utf8').toString('base64'));
  }

  async function http(request) {
    const { url, method = 'GET', form, body, headers = {}, proxyPort } = request;
    const args = ['-s', '--http1.1', '--max-time', '25', '-X', method];
    // An explicit route must override inherited NO_PROXY (including a blanket '*').
    if (proxyPort) args.push('--proxy', `http://127.0.0.1:${proxyPort}`, '--noproxy', '');
    for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
    if (form) {
      for (const [key, value] of Object.entries(form)) args.push('--data-urlencode', `${key}=${value}`);
    } else if (body !== undefined) {
      args.push('-d', typeof body === 'string' ? body : JSON.stringify(body));
    }
    args.push(url);
    try {
      const { stdout } = await execFileAsync('curl.exe', args, { windowsHide: true, timeout: 30000 });
      return stdout;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Native fetch does not implement our explicit HTTP proxy contract. Fail closed
        // rather than sending OAuth credentials directly when curl is unavailable.
        if (proxyPort) {
          throw tokenError('network_error', `未找到 curl.exe，无法使用本地代理 127.0.0.1:${proxyPort}；请求未发送，请安装或恢复 curl.exe 后重试`);
        }
        try {
          const response = await fetch(url, {
            method,
            signal: AbortSignal.timeout(25000),
            headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } : headers,
            body: form ? new URLSearchParams(form).toString() : (body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined)
          });
          return await response.text();
        } catch (fetchError) {
          throw tokenError('network_error', describeNetworkFailure({ error: fetchError, proxyPort, url }));
        }
      }
      // Never rethrow the raw execFile error: its message *is* the command line, and our command
      // lines carry the client secret, the refresh token and the Bearer access token.
      throw tokenError('network_error', describeNetworkFailure({ error, proxyPort, url }));
    }
  }

  // Google may hand back a rotated refresh token, so two concurrent refreshes of the same
  // token can overwrite each other and strand the account. Coalesce identical in-flight
  // refreshes (startup quota fetch, post-switch refresh, manual "刷新用量") into one request.
  const refreshInflight = new Map();

  async function performRefresh(refreshToken, proxyPort, { publicOnly = false } = {}) {
    const problems = [];
    let lastCode = null;
    const allClients = await oauthClients();
    if (!allClients.length) throw tokenError('no_client', '未能从本机 language_server.exe 提取 OAuth 客户端，请检查安装路径或内核版本兼容性');
    const clients = publicOnly
      ? allClients.filter(client => !isIdeClientId(client.id))
      : allClients;
    const effective = clients.length ? clients : allClients;
    for (const client of effective) {
      const stdout = await http({
        url: TOKEN_URL,
        method: 'POST',
        proxyPort,
        form: {
          client_id: client.id,
          client_secret: client.secret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }
      });
      try {
        const parsed = parseTokenResponse(stdout);
        return {
          ...parsed,
          clientId: client.id,
          clientType: classifyClientType(client.id)
        };
      } catch (error) {
        problems.push(error.message);
        const detail = describeTokenError(stdout);
        if (detail) problems.push(detail);
        lastCode = tokenErrorCode(stdout) || lastCode;
      }
    }
    throw tokenError(lastCode, `令牌刷新失败（${problems.join('; ')}）`);
  }

  function refreshAccessToken(refreshToken, proxyPort, options = {}) {
    const key = `${options.publicOnly ? 'public' : 'all'}|${proxyPort || ''}|${refreshToken}`;
    const pending = refreshInflight.get(key);
    if (pending) return pending;
    const task = performRefresh(refreshToken, proxyPort, options);
    refreshInflight.set(key, task);
    return task.finally(() => {
      if (refreshInflight.get(key) === task) refreshInflight.delete(key);
    });
  }

  // The authorization code is bound to the client that issued the auth URL, so try the
  // extracted clients in order - the right one accepts it on the first try.
  async function exchangeAuthCode({ code, redirectUri, proxyPort }) {
    const clients = await oauthClients();
    if (!clients.length) throw tokenError('no_client', '未能从本机 language_server.exe 提取 OAuth 客户端，请检查安装路径或内核版本兼容性');
    const problems = [];
    for (const client of clients) {
      const stdout = await http({
        url: TOKEN_URL,
        method: 'POST',
        proxyPort,
        form: {
          client_id: client.id,
          client_secret: client.secret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        }
      });
      try {
        const parsed = parseTokenResponse(stdout);
        return {
          ...parsed,
          clientId: client.id,
          clientType: classifyClientType(client.id)
        };
      } catch (error) {
        problems.push(error.message);
        const detail = describeTokenError(stdout);
        if (detail) problems.push(detail);
      }
    }
    throw new Error(`授权码兑换令牌失败（${problems.join('; ')}）`);
  }

  async function userinfoProfile(accessToken, proxyPort) {
    const stdout = await http({
      url: USERINFO_URL,
      proxyPort,
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = JSON.parse(stdout);
    return {
      email: data.email || null,
      name: data.name || data.given_name || null,
      picture: data.picture || null
    };
  }

  async function userinfoEmail(accessToken, proxyPort) {
    const profile = await userinfoProfile(accessToken, proxyPort);
    return profile.email;
  }

  async function ensureFresh(account, proxyPort, options = {}) {
    // The caller may replace an account in place while the refresh is awaiting HTTP.
    // Keep both the request token and the fallback refresh token from the same input.
    account = { ...account };
    const expiryTs = Number(account.expiryTs) || 0;
    if (!options.force && account.accessToken && expiryTs > Date.now() + REFRESH_MARGIN_SECONDS * 1000) {
      return {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiryTs,
        clientType: account.clientType || null
      };
    }
    const fresh = await refreshAccessToken(account.refreshToken, proxyPort, options);
    return {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken || account.refreshToken,
      expiryTs: Date.now() + fresh.expiresIn * 1000,
      clientId: fresh.clientId,
      clientType: fresh.clientType
    };
  }

  return {
    CRED_TARGET,
    http,
    runScript,
    readSystemCredential,
    writeSystemCredential,
    refreshAccessToken,
    exchangeAuthCode,
    oauthClients,
    userinfoProfile,
    userinfoEmail,
    ensureFresh
  };
}

module.exports = {
  createAgCred,
  buildCredentialPayload,
  parseCredentialPayload,
  parseTokenResponse,
  toRfc3339Micros,
  parseRfc3339,
  extractOauthClients,
  scanBinaryForClients,
  AG_FINGERPRINTS,
  isRefreshClientId,
  isIdeClientId,
  CRED_TARGET
};
