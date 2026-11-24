const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');
const DEFAULT_CONVERSATIONS_DIR = path.join(DEFAULT_ROOT, 'conversations');
const DEFAULT_BRAIN_DIR = path.join(DEFAULT_ROOT, 'brain');
const TRANSCRIPT_PATH = path.join('.system_generated', 'logs', 'transcript.jsonl');
const SNAPSHOT_TTL_MS = 5000;

// Antigravity writes every model response twice: as a protobuf blob inside
// conversations/<cascade>.db (steps.metadata) and as one JSON line in
// brain/<cascade>/.system_generated/logs/transcript.jsonl. Only the transcript
// carries cache_read_tokens and the real model slug, and the protobuf model enum
// drifts with every Antigravity release, so the transcript is the source of
// truth and the database is the fallback for cascades that never wrote one.
function mapModelEnumToFamily(modelEnum) {
  if (modelEnum === 1528 || modelEnum === 1530 || modelEnum === 1531) return 'Gemini 4 Hydrogen';
  if (modelEnum >= 1534 && modelEnum <= 1536) return 'Gemini 4 Neon';
  if (modelEnum >= 1417 && modelEnum <= 1421) return 'Gemini 4 Argon';
  if (modelEnum >= 1318 && modelEnum <= 1325) return 'Gemini 3.8 Flash';
  if ((modelEnum >= 1400 && modelEnum <= 1402) || modelEnum === 1026) return 'Claude Opus';
  if ((modelEnum >= 1403 && modelEnum <= 1405) || modelEnum === 1035 || modelEnum === 1016) return 'Claude Sonnet';
  if (modelEnum === 1017 || modelEnum === 1409 || modelEnum === 1410) return 'Claude Haiku';
  if (modelEnum === 1018 || modelEnum === 1050 || modelEnum === 1198 || modelEnum === 1021) return 'Gemini Flash';
  if (modelEnum >= 1300 && modelEnum < 1400) return 'Gemini Flash';
  return '其他模型';
}

const GEMINI_VARIANT = /gemini[-_ ]?(\d+(?:\.\d+)?)[-_ ]?(hydrogen|neon|argon|carbon)/i;

// Turn Antigravity's model slug ("gemini-4-hydrogen-tiered-high") into the same
// family label the UI and the model enum map use.
function displayModelName(slug) {
  const raw = typeof slug === 'string' ? slug.trim() : '';
  if (!raw) return '其他模型';
  const variant = GEMINI_VARIANT.exec(raw);
  if (variant) {
    const name = variant[2].toLowerCase();
    return 'Gemini ' + variant[1] + ' ' + name.charAt(0).toUpperCase() + name.slice(1);
  }
  const flash = /gemini[-_ ]?(\d+(?:\.\d+)?)[-_ ]?flash/i.exec(raw);
  if (flash) return 'Gemini ' + flash[1] + ' Flash';
  if (/gemini/i.test(raw) && /flash/i.test(raw)) return 'Gemini Flash';
  if (/claude/i.test(raw) && /opus/i.test(raw)) return 'Claude Opus';
  if (/claude/i.test(raw) && /sonnet/i.test(raw)) return 'Claude Sonnet';
  if (/claude/i.test(raw) && /haiku/i.test(raw)) return 'Claude Haiku';
  const oss = /gpt-oss[-_ ]?(\d+[a-z]*)/i.exec(raw);
  if (oss) return 'GPT-OSS ' + oss[1].toUpperCase();
  if (/gpt-oss/i.test(raw)) return 'GPT-OSS';
  return raw;
}

function tokenValue(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
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

// Cached OpenAI/Claude-style accounting: a prompt that hits the cache still costs
// tokens, so the headline total is uncached input + cache reads + output.
function recordTotal(rec) {
  return rec.input + rec.cacheRead + rec.output;
}

function addRecordToBucket(bucket, rec) {
  const total = recordTotal(rec);
  bucket.input += rec.input;
  bucket.output += rec.output;
  bucket.thinking += rec.thinking;
  bucket.cacheRead += rec.cacheRead;
  bucket.total += total;
  bucket.requests += 1;
  let m = bucket.byModelMap.get(rec.modelFamily);
  if (!m) {
    m = { name: rec.modelFamily, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, totalTokens: 0, requests: 0 };
    bucket.byModelMap.set(rec.modelFamily, m);
  }
  m.inputTokens += rec.input;
  m.outputTokens += rec.output;
  m.thinkingTokens += rec.thinking;
  m.cacheReadTokens += rec.cacheRead;
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
      const wst = fs.statSync(filePath + '-wal');
      walMtime = Math.floor(wst.mtimeMs);
      walSize = wst.size;
    } catch { /* no wal */ }
    return Math.floor(st.mtimeMs) + ':' + st.size + ':' + walMtime + ':' + walSize;
  } catch {
    return '';
  }
}

const LEDGER_FILE = 'usage-ledger.db';

function openLedger(filePath) {
  if (!filePath) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return null;
  }
  let db;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS usage ('
      + 'id TEXT PRIMARY KEY, cascade TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, '
      + 'input INTEGER NOT NULL, cache_read INTEGER NOT NULL, output INTEGER NOT NULL, thinking INTEGER NOT NULL)');
    db.exec('CREATE INDEX IF NOT EXISTS usage_ts ON usage (ts)');
  } catch {
    try { db?.close(); } catch { /* ignore */ }
    return null;
  }
  return db;
}

function createAgUsage({ conversationsDir, brainDir, rootDir, dataDir, now = () => Date.now() } = {}) {
  const conversations = conversationsDir || (rootDir ? path.join(rootDir, 'conversations') : DEFAULT_CONVERSATIONS_DIR);
  const brain = brainDir || (rootDir ? path.join(rootDir, 'brain')
    : (conversationsDir ? path.join(path.dirname(conversationsDir), 'brain') : DEFAULT_BRAIN_DIR));
  const ledgerPath = dataDir ? path.join(dataDir, LEDGER_FILE) : '';
  const fileCache = new Map();
  const seenIds = new Set();
  let lastSnapshot = null;
  let lastAt = 0;

  function cachedRecords(key, sig, read) {
    if (!sig) return [];
    const hit = fileCache.get(key);
    if (hit && hit.sig === sig) return hit.records;
    let records = [];
    try {
      records = read();
    } catch {
      return hit ? hit.records : [];
    }
    fileCache.set(key, { sig, records });
    return records;
  }

  function readTranscriptRecords(filePath, cascade) {
    const sig = statSignature(filePath);
    return cachedRecords(filePath, sig, () => {
      const text = fs.readFileSync(filePath, 'utf8');
      const records = [];
      const seenSteps = new Set();
      let ordinal = 0;
      for (const line of text.split('\n')) {
        if (!line || line.indexOf('"input_tokens"') < 0) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (!entry || entry.source !== 'MODEL') continue;
        const input = tokenValue(entry.input_tokens);
        const cacheRead = tokenValue(entry.cache_read_tokens);
        const output = tokenValue(entry.output_tokens);
        if (!input && !cacheRead && !output) continue;
        ordinal += 1;
        const step = entry.step_index;
        const key = (step === undefined || step === null) ? 'n' + ordinal : String(step);
        if (seenSteps.has(key)) continue;
        seenSteps.add(key);
        const ts = Date.parse(entry.created_at || '');
        records.push({
          id: cascade + ':' + key,
          cascade,
          ts: Number.isFinite(ts) ? ts : 0,
          modelFamily: displayModelName(entry.model),
          input,
          output,
          thinking: 0,
          cacheRead
        });
      }
      return records;
    });
  }

  function readDbRecords(dbPath, cascade) {
    const sig = statSignature(dbPath);
    if (!sig) return [];
    return cachedRecords(dbPath, sig, () => {
      let DatabaseSync;
      try {
        ({ DatabaseSync } = require('node:sqlite'));
      } catch {
        return [];
      }
      const records = [];
      let db;
      try {
        db = new DatabaseSync(dbPath, { open: true, readOnly: true });
        const rows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL').all();
        for (const row of rows) {
          if (!row || !row.metadata) continue;
          const parsed = parseStepMetadataBuffer(Buffer.from(row.metadata));
          if (!parsed) continue;
          parsed.id = cascade + ':' + row.idx;
          parsed.cascade = cascade;
          records.push(parsed);
        }
      } finally {
        try { db?.close(); } catch { /* ignore */ }
      }
      return records;
    });
  }

  function listEntries(dir, suffix) {
    if (!dir) return [];
    try {
      return fs.readdirSync(dir).filter(name => name.endsWith(suffix));
    } catch {
      return [];
    }
  }

  // The ledger is opened only for the milliseconds a snapshot needs: a SQLite
  // handle left open blocks deleting the data directory on Windows.
  function persist(records) {
    const db = openLedger(ledgerPath);
    if (!db) return null;
    try {
      const pending = records.filter(rec => !seenIds.has(rec.id));
      if (pending.length) {
        const insert = db.prepare('INSERT OR IGNORE INTO usage (id, cascade, ts, model, input, cache_read, output, thinking) VALUES (?,?,?,?,?,?,?,?)');
        db.exec('BEGIN');
        try {
          for (const rec of pending) {
            insert.run(rec.id, rec.cascade || '', rec.ts, rec.modelFamily || '', rec.input, rec.cacheRead, rec.output, rec.thinking);
            seenIds.add(rec.id);
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* ignore */ }
          throw error;
        }
      }
      return db.prepare('SELECT cascade, ts, model, input, cache_read, output, thinking FROM usage').all()
        .map(row => ({
          cascade: row.cascade,
          ts: Number(row.ts) || 0,
          modelFamily: row.model || '其他模型',
          input: Number(row.input) || 0,
          cacheRead: Number(row.cache_read) || 0,
          output: Number(row.output) || 0,
          thinking: Number(row.thinking) || 0
        }));
    } catch {
      return null;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
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

    const collected = [];
    let indexed = 0;
    const cascades = new Set();

    for (const name of listEntries(brain, '')) {
      if (!name || name.startsWith('.')) continue;
      const transcript = path.join(brain, name, TRANSCRIPT_PATH);
      let mtime = 0;
      try { mtime = Math.floor(fs.statSync(transcript).mtimeMs); } catch { continue; }
      const records = readTranscriptRecords(transcript, name);
      if (!records.length) continue;
      indexed += 1;
      cascades.add(name);
      for (const rec of records) {
        if (!rec.ts) rec.ts = mtime;
        collected.push(rec);
      }
    }

    for (const file of listEntries(conversations, '.db')) {
      const cascadeId = file.slice(0, -3);
      if (cascades.has(cascadeId)) continue;
      const dbPath = path.join(conversations, file);
      let stMtime = 0;
      try { stMtime = fs.statSync(dbPath).mtimeMs; } catch { stMtime = 0; }
      const records = readDbRecords(dbPath, cascadeId);
      if (!records.length) continue;
      cascades.add(cascadeId);
      for (const rec of records) {
        if (!rec.ts) rec.ts = stMtime;
        collected.push(rec);
      }
    }

    const persisted = persist(collected);
    const records = persisted && persisted.length ? persisted : collected;

    const today = emptyBucket('今日');
    const days7 = emptyBucket('最近 7 天');
    const days30 = emptyBucket('最近 30 天');
    const all = emptyBucket('累计');
    const allCascades = new Set();
    for (const rec of records) {
      allCascades.add(rec.cascade);
      const ts = rec.ts || 0;
      addRecordToBucket(all, rec);
      if (ts >= startOf30d) addRecordToBucket(days30, rec);
      if (ts >= startOf7d) addRecordToBucket(days7, rec);
      if (ts >= startOfToday) addRecordToBucket(today, rec);
    }

    lastSnapshot = {
      today: finalizeBucket(today),
      days7: finalizeBucket(days7),
      days30: finalizeBucket(days30),
      all: finalizeBucket(all),
      conversationCount: allCascades.size,
      indexedConversations: indexed,
      ledger: Boolean(persisted && persisted.length),
      updatedAt: currentMs
    };
    return lastSnapshot;
  }

  return { snapshot };
}

module.exports = {
  createAgUsage,
  resolveModelName: displayModelName,
  displayModelName,
  mapModelEnumToFamily,
  parseStepMetadataBuffer
};
