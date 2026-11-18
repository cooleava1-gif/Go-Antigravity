const CLOUD_CODE_DAILY_URL = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUD_CODE_PROD_URL = 'https://cloudcode-pa.googleapis.com';
const AICODE_API_URL = 'https://aicode.googleapis.com';
const DEFAULT_AG_VERSION = '2.26.0';
const DEFAULT_AG_CL = '1005016104';

function normalizeSubscriptionTier(rawTier) {
  const text = String(rawTier || '').trim().toLowerCase();
  if (!text) return 'UNKNOWN';
  if (text.includes('ultra')) return 'ULTRA';
  if (text.includes('pro')) return 'PRO';
  if (text.includes('free')) return 'FREE';
  return 'FREE';
}

function extractProjectId(rawProject) {
  if (!rawProject) return null;
  if (typeof rawProject === 'string') {
    const clean = rawProject.trim();
    return clean && clean !== 'aicode-consumers' ? clean : null;
  }
  if (typeof rawProject === 'object' && typeof rawProject.id === 'string') {
    const clean = rawProject.id.trim();
    return clean && clean !== 'aicode-consumers' ? clean : null;
  }
  return null;
}

function clampPercentage(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

function formatResetCountdown(resetTime, nowMs = Date.now()) {
  if (!resetTime) return '';
  const targetMs = Date.parse(String(resetTime));
  if (!Number.isFinite(targetMs)) return '';
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return '已重置';
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (days === 0 && minutes > 0) parts.push(`${minutes}m`);
  return parts.length ? parts.join(' ') : '<1m';
}

// Antigravity shares 5h quota across Claude Opus/Sonnet/GPT-OSS (`3p-5h`) and across
// Gemini 3.8 Flash/Pro (`gemini-5h`), while Gemini 4 Argon has its own weekly bucket.
const MODEL_FAMILIES = [
  {
    key: 'gemini-argon',
    label: 'Gemini 4 Argon (周限)',
    window: 'weekly',
    match: (id, name) => /gemini-4-argon/i.test(id) || /gemini 4 argon/i.test(name) || /\bargon\b/i.test(name)
  },
  {
    key: 'claude',
    label: 'Claude (5h)',
    window: '5h',
    match: (id, name) => /claude-(?:opus|sonnet)/i.test(id) || /claude (?:opus|sonnet)/i.test(name)
  },
  {
    key: 'gemini',
    label: 'Gemini 3.8 (5h)',
    window: '5h',
    match: (id, name) => /gemini-3(?:\.8)?-flash/i.test(id) || /gemini 3(?:\.8)? flash/i.test(name) || /gemini-(?:3\.1|3|2\.5)-pro/i.test(id) || (/gemini.*pro/i.test(name) && !/argon/i.test(name))
  }
];

function scoreModelVariant(item) {
  let score = 0;
  const text = `${item.id} ${item.displayName}`;
  if (/5-5|5\.5|4-argon|3\.8/i.test(text)) score += 10;
  else if (/4-6|4\.6|3\.1/i.test(text)) score += 5;
  if (/high/i.test(text)) score += 3;
  else if (/medium|thinking/i.test(text)) score += 1;
  return score;
}

// Only known shared buckets are aliases. Equal percentages never establish identity.
const QUOTA_ALIASES = {
  claude: ['claude', '5h'], '3p-5h': ['claude', '5h'], 'claude:5h': ['claude', '5h'],
  '3p-weekly': ['claude', 'weekly'], 'claude:weekly': ['claude', 'weekly'],
  gemini: ['gemini', '5h'], 'gemini-5h': ['gemini', '5h'], 'gemini:5h': ['gemini', '5h'],
  'gemini-weekly': ['gemini', 'weekly'], 'gemini:weekly': ['gemini', 'weekly'],
  'gemini-argon': ['gemini-argon', 'weekly'],
  'gemini-argon-wtu-weekly': ['gemini-argon', 'weekly'], 'gemini-argon:weekly': ['gemini-argon', 'weekly']
};

function quotaIdentity(item) {
  if (typeof item?.quotaKey === 'string' && item.quotaKey.trim()) return item.quotaKey.trim();
  const id = String(item?.key || item?.id || item?.bucketId || item?.label || '').trim();
  const alias = Object.hasOwn(QUOTA_ALIASES, id.toLowerCase()) ? QUOTA_ALIASES[id.toLowerCase()] : null;
  const window = String(item?.window || alias?.[1] || '').trim().toLowerCase();
  return id ? (alias?.[0] || id) + ':' + window : '';
}

function filterQuotaWindows(windows, models = []) {
  const represented = new Set((Array.isArray(models) ? models : [])
    .filter(item => item && !item.disabled && Number.isFinite(item.percentage))
    .map(quotaIdentity));
  const seen = new Set();
  return (Array.isArray(windows) ? windows : []).filter(item => {
    const key = quotaIdentity(item);
    if (!key || represented.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => ({ ...item, quotaKey: quotaIdentity(item) }));
}

function summarizeModels(rawModels = {}) {
  const entries = [];
  const disabledEntries = [];
  for (const [id, info] of Object.entries(rawModels || {})) {
    if (!info || typeof info !== 'object') continue;
    const displayName = typeof info.displayName === 'string' && info.displayName.trim() ? info.displayName.trim() : '';
    if (!displayName && !/^(?:gemini|claude|gpt-oss)/i.test(id)) continue;
    if (info.disabled && !info.quotaInfo) {
      disabledEntries.push({
        id,
        displayName: displayName || id,
        tagTitle: info.tagTitle || '',
        tagDescription: info.tagDescription || ''
      });
      continue;
    }
    if (!info.quotaInfo) continue;
    const percentage = clampPercentage(info.quotaInfo.remainingFraction);
    if (percentage === null) continue;
    const resetTime = info.quotaInfo.resetTime || '';
    entries.push({ id, displayName: displayName || id, percentage, resetTime });
  }
  entries.sort((a, b) => scoreModelVariant(b) - scoreModelVariant(a));

  const picked = [];
  for (const family of MODEL_FAMILIES) {
    const matched = entries.find(item => family.match(item.id, item.displayName));
    if (matched) {
      picked.push({
        key: family.key,
        quotaKey: family.key + ':' + family.window,
        id: matched.id,
        label: matched.displayName || family.label,
        shortLabel: family.label,
        window: family.window || '5h',
        disabled: false,
        percentage: matched.percentage,
        resetTime: matched.resetTime,
        resetText: formatResetCountdown(matched.resetTime)
      });
      continue;
    }
    const disabledMatch = disabledEntries.find(item => family.match(item.id, item.displayName));
    if (disabledMatch) {
      picked.push({
        key: family.key,
        quotaKey: family.key + ':' + family.window,
        id: disabledMatch.id,
        label: disabledMatch.displayName || family.label,
        shortLabel: family.label,
        window: family.window || '5h',
        disabled: true,
        percentage: null,
        resetTime: '',
        resetText: '需付费 Pro/Ultra'
      });
    }
  }
  return picked;
}

function summarizeWindows(quotaSummary, models = []) {
  const windows = [];
  const groups = quotaSummary?.groups;
  if (!Array.isArray(groups)) return windows;
  const bucketLabels = {
    '3p-5h': 'Claude (5h)',
    'claude:5h': 'Claude (5h)',
    '3p-weekly': 'Claude (周限)',
    'claude:weekly': 'Claude (周限)',
    'gemini-5h': 'Gemini 3.8 (5h)',
    'gemini:5h': 'Gemini 3.8 (5h)',
    'gemini-weekly': 'Gemini (周限)',
    'gemini:weekly': 'Gemini (周限)',
    'gemini-argon-wtu-weekly': 'Gemini 4 Argon (周限)'
  };
  for (const group of groups) {
    for (const bucket of group?.buckets || []) {
      const id = String(bucket?.bucketId || '').trim();
      if (!id) continue;
      const percentage = clampPercentage(bucket?.remainingFraction);
      if (percentage === null) continue;
      const resetTime = bucket?.resetTime || '';
      windows.push({
        key: id,
        window: bucket?.window || (id.includes('5h') ? '5h' : 'weekly'),
        label: (Object.hasOwn(bucketLabels, id) ? bucketLabels[id] : null) || bucket?.displayName || id,
        percentage,
        resetTime,
        resetText: formatResetCountdown(resetTime)
      });
    }
  }
  // Sort 5h before weekly for consistent reading.
  windows.sort((a, b) => (a.window === '5h' ? -1 : 1) - (b.window === '5h' ? -1 : 1));
  return filterQuotaWindows(windows, models);
}

function mergeLiveUserStatus(quota, userStatus) {
  if (!userStatus || typeof userStatus !== 'object') return quota;
  const next = { ...(quota || {}) };
  const planInfo = userStatus.planStatus?.planInfo;
  if (planInfo || userStatus.planStatus) {
    next.planCredits = {
      availablePromptCredits: Number(userStatus.planStatus?.availablePromptCredits ?? 0),
      monthlyPromptCredits: Number(planInfo?.monthlyPromptCredits ?? 0),
      availableFlowCredits: Number(userStatus.planStatus?.availableFlowCredits ?? 0),
      monthlyFlowCredits: Number(planInfo?.monthlyFlowCredits ?? 0)
    };
  }
  if (!next.tier || next.tier === 'UNKNOWN') {
    const rawTier = userStatus.userTier?.id || planInfo?.planName || planInfo?.teamsTier;
    if (rawTier) {
      next.tier = normalizeSubscriptionTier(rawTier);
      next.tierName = userStatus.userTier?.name || planInfo?.planName || next.tier;
    }
  }
  const configs = userStatus.cascadeModelConfigData?.clientModelConfigs;
  if (Array.isArray(configs) && configs.length) {
    const rawMap = {};
    for (const cfg of configs) {
      if (!cfg?.label || !cfg?.quotaInfo) continue;
      const key = cfg.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      rawMap[key] = { displayName: cfg.label, quotaInfo: cfg.quotaInfo };
    }
    const liveModels = summarizeModels(rawMap);
    if (liveModels.length) {
      const byKey = new Map((next.models || []).map(item => [item.key, item]));
      for (const item of liveModels) byKey.set(item.key, item);
      next.models = MODEL_FAMILIES.map(f => byKey.get(f.key)).filter(Boolean);
    }
  }
  if (Array.isArray(next.windows)) next.windows = filterQuotaWindows(next.windows, next.models);
  return next;
}

function createAgQuota({ http, agVersion = DEFAULT_AG_VERSION } = {}) {
  if (typeof http !== 'function') throw new Error('createAgQuota 需要提供 http 请求函数');

  const userAgent = `antigravity/hub/${agVersion} (aidev_client; os_type=windows; arch=amd64; cl=${DEFAULT_AG_CL})`;

  async function postCloudCode(baseUrl, endpoint, accessToken, payload, proxyPort) {
    const stdout = await http({
      url: `${baseUrl}/${endpoint}`,
      method: 'POST',
      proxyPort,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        'x-goog-api-client': 'gl-node/22.21.1'
      },
      body: payload
    });
    if (!stdout || !String(stdout).trim()) throw new Error(`${endpoint} 返回空响应`);
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${endpoint} 返回无效响应`);
    if (parsed?.error) {
      const msg = parsed.error.message || parsed.error.status || JSON.stringify(parsed.error);
      const err = new Error(msg);
      err.code = parsed.error.code;
      throw err;
    }
    return parsed;
  }

  async function getAiCodeQuotaStatus(accessToken, projectId, proxyPort) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': userAgent
    };
    if (projectId) headers['X-Goog-User-Project'] = projectId;
    const stdout = await http({
      url: `${AICODE_API_URL}/v1alpha:fetchQuotaStatus`,
      method: 'GET',
      proxyPort,
      headers
    });
    if (!stdout || !String(stdout).trim()) return null;
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !parsed.error ? parsed : null;
  }

  async function fetchAccountQuota({ accessToken, email, proxyPort, preferredProjectId = null, isGcpTos = false }) {
    const baseUrl = isGcpTos && preferredProjectId ? CLOUD_CODE_PROD_URL : CLOUD_CODE_DAILY_URL;
    const warnings = [];
    let succeeded = 0;
    const lcaPayload = {
      metadata: {
        ideName: 'antigravity',
        ideType: 'ANTIGRAVITY',
        ideVersion: agVersion,
        pluginVersion: '2.35.1',
        platform: 'WINDOWS_AMD64',
        updateChannel: 'stable',
        pluginType: 'GEMINI'
      },
      mode: 'FULL_ELIGIBILITY_CHECK'
    };
    if (preferredProjectId && preferredProjectId !== 'aicode-consumers') {
      lcaPayload.cloudaicompanionProject = preferredProjectId;
    }

    // UNKNOWN means "we could not ask", which must stay distinguishable from a real FREE
    // tier: the two look identical in the UI if this defaults to 'FREE'.
    let tier = 'UNKNOWN';
    let rawTierId = null;
    let tierName = null;
    let projectId = extractProjectId(preferredProjectId);
    let detectedGcpTos = Boolean(isGcpTos);
    let credits = [];

    try {
      const lca = await postCloudCode(baseUrl, 'v1internal:loadCodeAssist', accessToken, lcaPayload, proxyPort);
      succeeded += 1;
      const paid = lca?.paidTier;
      const current = lca?.currentTier;
      rawTierId = paid?.id || current?.id || null;
      tierName = paid?.name || current?.name || null;
      if (rawTierId || tierName) tier = normalizeSubscriptionTier(rawTierId || tierName);
      projectId = extractProjectId(lca?.cloudaicompanionProject) || projectId;
      if (typeof current?.usesGcpTos === 'boolean') detectedGcpTos = current.usesGcpTos;
      const rawCredits = paid?.availableCredits || current?.availableCredits || [];
      credits = rawCredits
        .filter(c => c && c.creditType)
        .map(c => ({
          type: c.creditType,
          amount: c.creditAmount ?? null,
          minUsage: c.minimumCreditAmountForUsage ?? null
        }));
    } catch (error) {
      warnings.push(`订阅档位查询失败：${error.message}`);
    }

    const queryPayload = projectId ? { project: projectId } : {};
    let modelsRes = null;
    try {
      modelsRes = await postCloudCode(baseUrl, 'v1internal:fetchAvailableModels', accessToken, queryPayload, proxyPort);
      succeeded += 1;
    } catch (error) {
      warnings.push(`模型配额查询失败：${error.message}`);
    }
    let summaryRes = null;
    try {
      summaryRes = await postCloudCode(baseUrl, 'v1internal:retrieveUserQuotaSummary', accessToken, queryPayload, proxyPort);
      succeeded += 1;
    } catch { /* Summary is optional for free tier or transient errors */ }
    let quotaStatusRes = null;
    try {
      quotaStatusRes = await getAiCodeQuotaStatus(accessToken, projectId, proxyPort);
      if (quotaStatusRes) succeeded += 1;
    } catch { /* Supplementary endpoint is optional */ }

    if (!succeeded) {
      throw Object.assign(new Error(`所有配额接口均查询失败${warnings.length ? '：' + warnings.join('；') : ''}`), { code: 'quota_unavailable' });
    }

    const combinedModels = { ...(quotaStatusRes?.models || {}), ...(modelsRes?.models || {}) };
    const models = summarizeModels(combinedModels);
    const windows = summarizeWindows(summaryRes, models);
    if (!models.length && !summaryRes?.groups?.length && !modelsRes) {
      warnings.push('未取到任何配额数据');
    }

    return {
      email: email || null,
      tier,
      rawTierId,
      tierName: tierName || (tier === 'UNKNOWN' ? null : tier),
      projectId,
      isGcpTos: detectedGcpTos,
      credits,
      windows,
      models,
      warnings,
      updatedAt: Date.now(),
      error: null
    };
  }

  return { fetchAccountQuota };
}

module.exports = {
  createAgQuota,
  normalizeSubscriptionTier,
  extractProjectId,
  clampPercentage,
  formatResetCountdown,
  summarizeModels,
  summarizeWindows,
  mergeLiveUserStatus,
  MODEL_FAMILIES
};
