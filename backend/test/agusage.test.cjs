'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgUsage, displayModelName, mapModelEnumToFamily } = require('../core/agusage');

const AT = Date.UTC(2026, 10, 24, 4, 30, 0);

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agusage-'));
  fs.mkdirSync(path.join(root, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
  return root;
}

function transcript(root, cascade, lines) {
  const dir = path.join(root, 'brain', cascade, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  fs.utimesSync(path.join(dir, 'transcript.jsonl'), new Date(AT), new Date(AT));
}

function model(index, model, input, cacheRead, output, iso) {
  return {
    step_index: index,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: iso || new Date(AT).toISOString(),
    model,
    input_tokens: input,
    cache_read_tokens: cacheRead,
    output_tokens: output
  };
}

function varint(value) {
  const bytes = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function varField(field, value) {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

function lenField(field, body) {
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}

const LEGACY_DB = path.join('..', '..');

function writeLegacyDb(root, cascade, steps) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'conversations', cascade + '.db'));
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
  const insert = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
  for (const step of steps) {
    const usage = Buffer.concat([
      varField(1, step.modelEnum || 1417),
      varField(2, step.input),
      varField(3, step.output),
      varField(9, step.thinking || 0),
      varField(10, step.response || step.output)
    ]);
    const meta = Buffer.concat([
      lenField(1, varField(1, Math.floor(AT / 1000))),
      lenField(9, usage)
    ]);
    insert.run(step.idx, 15, meta);
  }
  db.close();
}

test('transcripts are the source of truth and cache reads count toward the total', () => {
  const root = workspace();
  transcript(root, 'aaaaaaaa-0000-0000-0000-000000000001', [
    model(1, 'gemini-4-hydrogen-xhigh', 1000, 4000, 100),
    model(2, 'gemini-4-hydrogen-xhigh', 500, 8000, 50),
    { step_index: 3, source: 'USER', type: 'USER_INPUT', created_at: new Date(AT).toISOString() }
  ]);
  const usage = createAgUsage({ rootDir: root, now: () => AT + 60000 }).snapshot(true);
  assert.equal(usage.today.requests, 2);
  assert.equal(usage.today.inputTokens, 1500);
  assert.equal(usage.today.cacheReadTokens, 12000);
  assert.equal(usage.today.outputTokens, 150);
  assert.equal(usage.today.totalTokens, 13650);
  assert.deepEqual(usage.today.models.map(m => m.name), ['Gemini 4 Hydrogen']);
  assert.equal(usage.conversationCount, 1);
  assert.equal(usage.ledger, false);
});

test('duplicate steps are counted once and unknown slugs stay readable', () => {
  const root = workspace();
  transcript(root, 'bbbbbbbb-0000-0000-0000-000000000002', [
    model(1, 'gemini-4-neon-xhigh', 10, 20, 1),
    model(1, 'gemini-4-neon-xhigh', 10, 20, 1),
    model(2, 'claude-sonnet-5-5-medium', 7, 0, 3),
    model(3, 'mystery-model-9', 5, 0, 5)
  ]);
  const usage = createAgUsage({ rootDir: root, now: () => AT + 60000 }).snapshot(true);
  assert.equal(usage.today.requests, 3);
  // 10+20+1 (neon) + 7+3 (sonnet) + 5+5 (unknown slug); the duplicate step is dropped.
  assert.equal(usage.today.totalTokens, 51);
  const names = usage.today.models.map(m => m.name).sort();
  assert.deepEqual(names, ['Claude Sonnet', 'Gemini 4 Neon', 'mystery-model-9']);
});

test('cascades without a transcript fall back to the protobuf steps table', () => {
  const root = workspace();
  writeLegacyDb(root, 'cccccccc-0000-0000-0000-000000000003', [
    { idx: 1, input: 900, output: 90, thinking: 30, response: 60 },
    { idx: 2, input: 100, output: 10 }
  ]);
  const usage = createAgUsage({ rootDir: root, now: () => AT + 60000 }).snapshot(true);
  assert.equal(usage.today.requests, 2);
  assert.equal(usage.today.inputTokens, 1000);
  assert.equal(usage.today.outputTokens, 100);
  assert.equal(usage.today.thinkingTokens, 30);
  assert.equal(usage.today.cacheReadTokens, 0);
  assert.equal(usage.today.totalTokens, 1100);
  assert.deepEqual(usage.today.models.map(m => m.name), ['Gemini 4 Argon']);
});

test('a transcript wins over the database for the same cascade', () => {
  const root = workspace();
  const cascade = 'dddddddd-0000-0000-0000-000000000004';
  transcript(root, cascade, [model(1, 'gemini-4-argon-high', 10, 20, 5)]);
  writeLegacyDb(root, cascade, [{ idx: 1, input: 9000, output: 9000 }]);
  const usage = createAgUsage({ rootDir: root, now: () => AT + 60000 }).snapshot(true);
  assert.equal(usage.today.requests, 1);
  assert.equal(usage.today.totalTokens, 35);
});

test('the ledger keeps history when Antigravity deletes a conversation', () => {
  const root = workspace();
  const dataDir = path.join(root, 'data');
  transcript(root, 'eeeeeeee-0000-0000-0000-000000000005', [model(1, 'gemini-4-hydrogen-xhigh', 100, 900, 10)]);
  const first = createAgUsage({ rootDir: root, dataDir, now: () => AT + 60000 }).snapshot(true);
  assert.equal(first.today.totalTokens, 1010);
  assert.equal(first.ledger, true);

  fs.rmSync(path.join(root, 'brain'), { recursive: true, force: true });
  const empty = path.join(root, 'gone');
  fs.mkdirSync(path.join(empty, 'brain'), { recursive: true });
  fs.mkdirSync(path.join(empty, 'conversations'), { recursive: true });
  const second = createAgUsage({ rootDir: empty, dataDir, now: () => AT + 120000 }).snapshot(true);
  assert.equal(second.ledger, true);
  assert.equal(second.today.requests, 1);
  assert.equal(second.today.totalTokens, 1010);
  assert.equal(second.conversationCount, 1);
});

test('ledger failures degrade to the live scan instead of throwing', () => {
  const root = workspace();
  transcript(root, 'ffffffff-0000-0000-0000-000000000006', [model(1, 'gemini-4-neon-xhigh', 3, 4, 5)]);
  fs.writeFileSync(path.join(root, 'data'), 'not a directory');
  const usage = createAgUsage({ rootDir: root, dataDir: path.join(root, 'data'), now: () => AT + 60000 }).snapshot(true);
  assert.equal(usage.today.totalTokens, 12);
  assert.equal(usage.ledger, false);
});

test('model naming accepts enum fallbacks and slug families', () => {
  assert.equal(displayModelName('gemini-4-hydrogen-tiered-high'), 'Gemini 4 Hydrogen');
  assert.equal(displayModelName('gemini-4-neon-xhigh'), 'Gemini 4 Neon');
  assert.equal(displayModelName('gemini-3.8-flash'), 'Gemini 3.8 Flash');
  assert.equal(displayModelName('claude-opus-5-5-high'), 'Claude Opus');
  assert.equal(displayModelName('gpt-oss-120b'), 'GPT-OSS 120B');
  assert.equal(displayModelName(''), '其他模型');
  assert.equal(mapModelEnumToFamily(1528), 'Gemini 4 Hydrogen');
  assert.equal(mapModelEnumToFamily(1535), 'Gemini 4 Neon');
  assert.equal(mapModelEnumToFamily(1417), 'Gemini 4 Argon');
  assert.equal(mapModelEnumToFamily(999999), '其他模型');
});
