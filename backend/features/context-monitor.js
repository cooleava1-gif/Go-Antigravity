const { createHash } = require('node:crypto');
const { GUID } = require('../adapters/desktop/language-service');

function tokenCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function seconds(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value)) value = Number(value.slice(0, -1));
  if (value && typeof value === 'object') {
    const whole = tokenCount('seconds' in value ? value.seconds : 0), nanos = tokenCount('nanos' in value ? value.nanos : 0);
    value = whole !== null && nanos !== null && nanos < 1e9 && ('seconds' in value || 'nanos' in value) ? whole + nanos / 1e9 : null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveModelName(chat, modelMap) {
  if (!chat || typeof chat !== 'object') return null;
  for (const direct of [chat.modelDisplayName, chat.modelName, chat.usage?.modelDisplayName, chat.usage?.modelName, chat.chatStartMetadata?.modelDisplayName]) {
    if (typeof direct === 'string' && direct.trim()) return direct.trim().slice(0, 100);
  }
  for (const raw of [chat.model, chat.usage?.model, chat.chatStartMetadata?.model, chat.modelOrAlias?.model, chat.modelOrAlias?.alias]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = raw.trim();
    if (modelMap instanceof Map && modelMap.has(key)) return modelMap.get(key).slice(0, 100);
    if (!/^MODEL_PLACEHOLDER_/i.test(key)) return key.replace(/^MODEL_/i, '').slice(0, 100);
  }
  return null;
}

function extractModelMap(status) {
  const map = new Map();
  const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs;
  if (Array.isArray(configs)) {
    for (const item of configs) {
      const label = typeof item?.label === 'string' && item.label.trim() ? item.label.trim() : null;
      if (!label) continue;
      for (const k of [item.modelOrAlias?.model, item.modelOrAlias?.alias, item.model]) {
        if (typeof k === 'string' && k.trim()) map.set(k.trim(), label);
      }
    }
  }
  return map;
}

// Some unlocked kernels still report the stock ceiling. Override it only with the capacity
// verified for this running launch; an unknown or attached instance uses host metadata.
function resolveCapacity(rawMax, contextCap) {
  const capacity = tokenCount(rawMax);
  if (contextCap > 0) return contextCap;
  return capacity !== null && capacity > 0 ? capacity : null;
}

function uniqueRequests(generators) {
  const byId = new Map(), groups = [];
  for (const [index, item] of generators.entries()) {
    const chat = item?.chatModel;
    if (!chat) continue;
    const keys = [['message', chat.usage?.messageId], ['execution', item.executionId]]
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([kind, value]) => kind + ':' + value.trim());
    const matches = [...new Set(keys.map(key => byId.get(key)).filter(Boolean))];
    const group = matches[0] || { keys: new Set(), active: true };
    if (!matches.length) groups.push(group);
    for (const duplicate of matches.slice(1)) {
      duplicate.active = false;
      for (const key of duplicate.keys) { group.keys.add(key); byId.set(key, group); }
    }
    for (const key of keys) { group.keys.add(key); byId.set(key, group); }
    group.chat = chat; group.index = index;
    // Without a stable request ID, preserve the row; identical counts can be
    // distinct requests and are not evidence of a duplicate.
  }
  return groups.filter(group => group.active).sort((a, b) => a.index - b.index).map(group => group.chat);
}

function summarizeMetadata(generators, modelMap, options = {}) {
  generators = Array.isArray(generators) ? generators : [];
  const contextCap = tokenCount(options.contextCap) || 0;
  const latestChat = generators.findLast(item => item?.chatModel)?.chatModel;
  const rawContext = latestChat?.chatStartMetadata?.contextWindowMetadata;
  const used = tokenCount(rawContext?.estimatedTokensUsed);
  const max = resolveCapacity(rawContext?.maxContextTokens, contextCap);
  const model = resolveModelName(latestChat, modelMap)
    || resolveModelName(generators.findLast(item => resolveModelName(item?.chatModel, modelMap))?.chatModel, modelMap);
  // No system/tool/conversation allocation is exposed by the verified host contract.
  // Never tokenize prompt bodies or turn aggregate usage into a context breakdown.
  const context = used === null ? null : { usedTokens: used, maxTokens: max,
    usedFraction: max ? used / max : null, model, estimated: true, breakdown: null };
  const requests = uniqueRequests(generators);
  const rows = requests.map(chat => ({
    inputTokens: tokenCount(chat.usage?.inputTokens ?? chat.usage?.promptTokens),
    outputTokens: tokenCount(chat.usage?.outputTokens),
    thinkingTokens: tokenCount(chat.usage?.thinkingOutputTokens),
    cacheReadTokens: tokenCount(chat.usage?.cacheReadInputTokens ?? chat.usage?.cachedTokens ?? chat.usage?.cacheReadTokens)
  }));
  const sum = values => values.length && values.every(value => value !== null)
    && Number.isSafeInteger(values.reduce((total, value) => total + value, 0))
    ? values.reduce((total, value) => total + value, 0) : null;
  const coverage = Object.fromEntries(['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens']
    .map(key => [key, rows.filter(row => row[key] !== null).length]));
  const tokens = requests.length ? {
    ...Object.fromEntries(Object.keys(coverage).map(key => [key, sum(rows.map(row => row[key]))])),
    steps: requests.length, model, scope: 'conversation', coverage,
    // inputTokens may include or exclude cache reads depending on the host. The
    // available schema does not establish this, so neither subtract nor add cache.
    inputBasis: 'host-reported', cacheInputSemantics: 'unknown',
    uncachedInputTokens: null, cacheHitFraction: null
  } : null;
  if (tokens) tokens.totalTokens = tokens.inputTokens !== null && tokens.outputTokens !== null
    ? sum([tokens.inputTokens, tokens.outputTokens]) : null;

  let speed = null, output = 0, streaming = 0, tpsSamples = 0, ttftTotal = 0, ttftSamples = 0;
  const durations = [], bases = new Set();
  for (const chat of requests) {
    const stat = chat.usage || {}, duration = seconds(chat.streamingDuration), ttft = seconds(chat.timeToFirstToken);
    durations.push(duration);
    if (ttft !== null) { ttftTotal += ttft; ttftSamples++; }
    const visible = tokenCount(stat.responseOutputTokens), allOutput = tokenCount(stat.outputTokens);
    const thinking = tokenCount(stat.thinkingOutputTokens);
    const response = visible ?? (allOutput !== null && thinking !== null
      ? (thinking <= allOutput ? allOutput - thinking : null) : allOutput);
    if (response === null || !(duration > 0) || !Number.isFinite(response / duration)) continue;
    const basis = visible !== null || (allOutput !== null && thinking !== null) ? 'response' : 'all-output';
    output += response; streaming += duration; tpsSamples++; bases.add(basis);
    speed = { tokensPerSecond: response / duration, ttftSeconds: ttft, basis,
      shortSample: duration < 1, model: resolveModelName(chat, modelMap) || model };
  }
  const finite = value => Number.isFinite(value) ? value : null;
  const modelSeconds = durations.length && durations.every(value => value !== null)
    ? finite(durations.reduce((total, value) => total + value, 0)) : null;
  const session = { scope: 'conversation', elapsedSeconds: null, modelSeconds, toolSeconds: null,
    averageTtftSeconds: ttftSamples ? finite(ttftTotal / ttftSamples) : null,
    averageTokensPerSecond: tpsSamples ? finite(output / streaming) : null,
    tpsBasis: bases.size === 1 ? [...bases][0] : bases.size ? 'mixed' : null,
    requestCount: requests.length, tpsSamples, ttftSamples,
    modelTimeSamples: durations.filter(value => value !== null).length };
  return { context, speed, tokens, session };
}

function accountScope(status) {
  const email = status?.userStatus?.email;
  if (typeof email !== 'string' || !email.trim()) throw new Error('暂无法确认当前账号');
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

class ContextMonitor {
  constructor(client, { onSample, contextCap = () => 0 } = {}) {
    this.client = client;
    this.onSample = onSample;
    this.contextCap = contextCap;
    this.generation = 0;
    this.pending = new Map();
    this.latest = null;
  }

  snapshot() {
    return this.latest;
  }

  sample(id) {
    if (!GUID.test(id)) return Promise.resolve({ conversationId: id, state: 'unavailable' });
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.pending.size >= 4) return Promise.resolve({ conversationId: id, state: 'unavailable' });
    const generation = this.generation;
    const task = this.collect(id, generation);
    this.pending.set(id, task);
    task.finally(() => { if (this.pending.get(id) === task) this.pending.delete(id); });
    return task;
  }

  async collect(id, generation) {
    const signal = AbortSignal.timeout(20000);
    try {
      const server = await this.client.discover();
      const firstStatus = await this.client.call('GetUserStatus', {}, signal);
      const identity = accountScope(firstStatus);
      const metadata = await this.client.metadata(id, signal);
      const cap = typeof this.contextCap === 'function' ? this.contextCap() : this.contextCap;
      const result = summarizeMetadata(metadata, extractModelMap(firstStatus), { contextCap: Number(cap) > 0 ? Number(cap) : 0 });
      const currentIdentity = accountScope(await this.client.call('GetUserStatus', {}, signal));
      const currentServer = await this.client.discover();
      if (generation !== this.generation || identity !== currentIdentity || server.pid !== currentServer.pid
        || server.csrf !== currentServer.csrf || server.port !== currentServer.port) throw new Error('采集作用域已改变');
      const payload = { conversationId: id, state: 'live', sampledAt: Date.now(), ...result };
      this.latest = payload;
      try { this.onSample?.(payload, firstStatus?.userStatus || null); } catch { /* ignore listener errors */ }
      return payload;
    } catch {
      return { conversationId: id, state: 'unavailable', context: null, speed: null };
    }
  }

  reset() {
    this.generation++;
    this.pending.clear();
    this.latest = null;
    this.client.reset();
  }
}

module.exports = { ContextMonitor, summarizeMetadata, tokenCount, seconds };
