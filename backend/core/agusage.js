const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'conversations');
const SNAPSHOT_TTL_MS = 5000;

function mapModelEnumToFamily(modelEnum) {
  if (modelEnum >= 1417 && modelEnum <= 1421) return 'Gemini 4 Argon';
  if (modelEnum >= 1318 && modelEnum <= 1325) return 'Gemini 3.8 Flash';
  if ((modelEnum >= 1400 && modelEnum <= 1402) || modelEnum === 1026) return 'Claude Opus';
  if ((modelEnum >= 1403 && modelEnum <= 1405) || modelEnum === 1035 || modelEnum === 1016) return 'Claude Sonnet';
  if (modelEnum === 1018 || modelEnum === 1050 || modelEnum === 1198 || modelEnum === 1021) return 'Gemini Flash';
  if (modelEnum >= 1300 && modelEnum < 1400) return 'Gemini Flash';
  return '其他模型';
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: Number(result), next: pos };
    shift += 7n;
    if (shift > 63n) break;
  }
  return { value: Number(result), next: pos };
}

function parseTimestampMs(buf) {
  let pos = 0;
  let seconds = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
      if (fieldNo === 1) seconds = v.value;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.next + len.value;
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else break;
  }
  return seconds > 0 ? seconds * 1000 : 0;
}

function parseModelUsageStats(buf) {
  let pos = 0;
  const stats = {
    modelEnum: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingOutputTokens: 0,
    responseOutputTokens: 0,
    cacheReadTokens: 0
  };
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
      if (fieldNo === 1) stats.modelEnum = v.value;
      else if (fieldNo === 2) stats.inputTokens = v.value;
      else if (fieldNo === 3) stats.outputTokens = v.value;
      else if (fieldNo === 8) stats.cacheReadTokens = v.value;
      else if (fieldNo === 9) stats.thinkingOutputTokens = v.value;
      else if (fieldNo === 10) stats.responseOutputTokens = v.value;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.next + len.value;
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else break;
  }
  return stats;
}

function parseStepMetadataBuffer(buf) {
  if (!buf || !buf.length) return null;
  let pos = 0;
  let createdAtMs = 0;
  let usage = null;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const fieldNo = tag.value >> 3;
    const wireType = tag.value & 7;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.next;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      if (len.next + len.value > buf.length) break;
      const sub = buf.subarray(len.next, len.next + len.value);
      pos = len.next + len.value;
      if (fieldNo === 1 && !createdAtMs) createdAtMs = parseTimestampMs(sub);
      else if (fieldNo === 9) usage = parseModelUsageStats(sub);
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 1) {
      pos += 8;
    } else break;
  }
  if (!usage || (usage.inputTokens <= 0 && usage.outputTokens <= 0 && usage.cacheReadTokens <= 0)) {
    return null;
  }
  return {
    ts: createdAtMs,
    modelFamily: mapModelEnumToFamily(usage.modelEnum),
    input: usage.inputTokens,
    output: usage.outputTokens,
    thinking: usage.thinkingOutputTokens,
    cacheRead: usage.cacheReadTokens
  };
}

function emptyBucket(label) {
  return {
    label,
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    total: 0,
    requests: 0,
    byModelMap: new Map()
  };
}

function addRecordToBucket(bucket, rec) {
  const total = rec.input + rec.output;
  bucket.input += rec.input;
  bucket.output += rec.output;
  bucket.thinking += rec.thinking;
  bucket.cacheRead += rec.cacheRead;
  bucket.total += total;
  bucket.requests += 1;
  let m = bucket.byModelMap.get(rec.modelFamily);
  if (!m) {
    m = { name: rec.modelFamily, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, requests: 0 };
    bucket.byModelMap.set(rec.modelFamily, m);
  }
  m.inputTokens += rec.input;
  m.outputTokens += rec.output;
  m.thinkingTokens += rec.thinking;
  m.totalTokens += total;
  m.requests += 1;
}

function finalizeBucket(bucket) {
  const models = [...bucket.byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return {
    label: bucket.label,
    inputTokens: bucket.input,
    outputTokens: bucket.output,
    thinkingTokens: bucket.thinking,
    cacheReadTokens: bucket.cacheRead,
    totalTokens: bucket.total,
    requests: bucket.requests,
    models
  };
}

function statSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    let walMtime = 0;
    let walSize = 0;
    try {
      const wst = fs.statSync(`${filePath}-wal`);
      walMtime = Math.floor(wst.mtimeMs);
      walSize = wst.size;
    } catch { /* no wal */ }
    return `${Math.floor(st.mtimeMs)}:${st.size}:${walMtime}:${walSize}`;
  } catch {
    return '';
  }
}

function createAgUsage({ conversationsDir = DEFAULT_CONVERSATIONS_DIR, now = () => Date.now() } = {}) {
  const fileCache = new Map();
  let lastSnapshot = null;
  let lastAt = 0;

  function readDbRecords(dbPath) {
    const sig = statSignature(dbPath);
    if (!sig) return [];
    const cached = fileCache.get(dbPath);
    if (cached && cached.sig === sig) return cached.records;

    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      return cached ? cached.records : [];
    }

    const records = [];
    let db;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      const rows = db.prepare('SELECT metadata FROM steps WHERE metadata IS NOT NULL').all();
      for (const row of rows) {
        if (!row?.metadata) continue;
        const parsed = parseStepMetadataBuffer(Buffer.from(row.metadata));
        if (parsed) records.push(parsed);
      }
      fileCache.set(dbPath, { sig, records });
    } catch {
      return cached ? cached.records : [];
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
    return records;
  }

  function snapshot(force = false) {
    const currentMs = now();
    if (!force && lastSnapshot && currentMs - lastAt < SNAPSHOT_TTL_MS) {
      return lastSnapshot;
    }
    lastAt = currentMs;

    const d = new Date(currentMs);
    const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const startOf7d = startOfToday - 6 * 86400 * 1000;
    const startOf30d = startOfToday - 29 * 86400 * 1000;

    const today = emptyBucket('今日');
    const days7 = emptyBucket('最近 7 天');
    const days30 = emptyBucket('最近 30 天');
    const all = emptyBucket('累计');

    let conversationsCount = 0;
    if (conversationsDir && fs.existsSync(conversationsDir)) {
      let files = [];
      try {
        files = fs.readdirSync(conversationsDir).filter(f => f.endsWith('.db'));
      } catch { files = []; }
      conversationsCount = files.length;
      for (const file of files) {
        const dbPath = path.join(conversationsDir, file);
        const stMtime = (() => { try { return fs.statSync(dbPath).mtimeMs; } catch { return 0; } })();
        const records = readDbRecords(dbPath);
        for (const rec of records) {
          const ts = rec.ts || stMtime;
          addRecordToBucket(all, rec);
          if (ts >= startOf30d) addRecordToBucket(days30, rec);
          if (ts >= startOf7d) addRecordToBucket(days7, rec);
          if (ts >= startOfToday) addRecordToBucket(today, rec);
        }
      }
    }

    lastSnapshot = {
      today: finalizeBucket(today),
      days7: finalizeBucket(days7),
      days30: finalizeBucket(days30),
      all: finalizeBucket(all),
      conversationCount: conversationsCount,
      updatedAt: currentMs
    };
    return lastSnapshot;
  }

  return { snapshot };
}

module.exports = {
  createAgUsage,
  resolveModelName: mapModelEnumToFamily,
  mapModelEnumToFamily,
  parseStepMetadataBuffer
};
