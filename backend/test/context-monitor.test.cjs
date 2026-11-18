'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextMonitor, summarizeMetadata, tokenCount, seconds } = require('../features/context-monitor');
const ID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const record = (usage, extra = {}, executionId) => ({ executionId, chatModel: { usage, ...extra } });

test('strict counts and durations preserve explicit zero without inventing absent time', () => {
  for (const value of [null, undefined, '', -1, 1.5, NaN, Infinity, {}, '1.5', ' 1']) assert.equal(tokenCount(value), null);
  assert.equal(tokenCount(0), 0);
  assert.equal(tokenCount('42'), 42);
  for (const value of [null, undefined, {}, { seconds: null }, { nanos: null }, { seconds: 1, nanos: 1e9 }, -1, 'unknown']) assert.equal(seconds(value), null);
  assert.equal(seconds(0), 0);
  assert.equal(seconds('0s'), 0);
  assert.equal(seconds({ seconds: '1', nanos: 500000000 }), 1.5);
});

test('host context is explicitly estimated and never allocated from prompt content', () => {
  const entry = record(undefined, { modelName: 'Synthetic model', chatStartMetadata: {
    contextWindowMetadata: { estimatedTokensUsed: 151000, maxContextTokens: 300000 } } });
  Object.defineProperty(entry.chatModel, 'messages', { get() { throw new Error('Prompt access forbidden'); } });
  const result = summarizeMetadata([entry]);
  assert.equal(result.context.usedTokens, 151000);
  assert.equal(result.context.usedFraction, 151000 / 300000);
  assert.equal(result.context.estimated, true);
  assert.equal(result.context.breakdown, null);
  assert.equal(result.context.model, 'Synthetic model');
  assert.equal(result.session.elapsedSeconds, null);
  assert.equal(result.session.toolSeconds, null);
});

test('latest context does not reuse stale history and only verified launch capacity overrides host', () => {
  const entries = [record({}, { chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 0, maxContextTokens: 300000 } } })];
  assert.equal(summarizeMetadata(entries).context.usedFraction, 0);
  assert.equal(summarizeMetadata(entries, null, { contextCap: 900000 }).context.maxTokens, 900000);
  assert.equal(summarizeMetadata(entries, null, { contextCap: Infinity }).context.maxTokens, 300000);
  assert.equal(summarizeMetadata([...entries, record({})]).context, null);
  assert.equal(summarizeMetadata([record({}, { chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 5 } } })]).context.maxTokens, null);
});

test('final duplicate request snapshots count once across message and execution aliases', () => {
  const result = summarizeMetadata([
    record({ inputTokens: 999, outputTokens: 999 }, {}, 'request-a'),
    record({ messageId: 'message-a', inputTokens: 100, outputTokens: 100, responseOutputTokens: 90, thinkingOutputTokens: 10, cacheReadInputTokens: 40 }, { streamingDuration: '3s', timeToFirstToken: '1s' }, 'request-a'),
    record({ messageId: 'message-a', inputTokens: 100, outputTokens: 100, responseOutputTokens: 90, thinkingOutputTokens: 10, cacheReadInputTokens: 40 }, { streamingDuration: '3s', timeToFirstToken: '1s' }),
    record({ messageId: 'message-b', inputTokens: 50, outputTokens: 10, responseOutputTokens: 10, thinkingOutputTokens: 0, cacheReadInputTokens: 0 }, { streamingDuration: '1s', timeToFirstToken: '3s' }, 'request-b')
  ]);
  assert.equal(result.tokens.steps, 2);
  assert.equal(result.tokens.inputTokens, 150);
  assert.equal(result.tokens.outputTokens, 110);
  assert.equal(result.tokens.thinkingTokens, 10);
  assert.equal(result.tokens.cacheReadTokens, 40);
  assert.equal(result.tokens.totalTokens, 260); // thinking/cache are never double added.
  assert.equal(result.tokens.scope, 'conversation');
  assert.equal(result.session.modelSeconds, 4);
  assert.equal(result.session.averageTtftSeconds, 2);
  assert.equal(result.session.averageTokensPerSecond, 25); // weighted output / duration.
  assert.equal(result.session.tpsBasis, 'response');
  assert.equal(result.speed.tokensPerSecond, 10);
});

test('transitive request identities merge while ID-less equal counts remain distinct', () => {
  const result = summarizeMetadata([
    record({ messageId: 'message', inputTokens: 1 }),
    record({ inputTokens: 2 }, {}, 'execution'),
    record({ messageId: 'message', inputTokens: 3 }, {}, 'execution'),
    record({ inputTokens: 10 }), record({ inputTokens: 10 })
  ]);
  assert.equal(result.tokens.steps, 3);
  assert.equal(result.tokens.inputTokens, 23);
});

test('missing usage is unknown rather than a zero or a partial lifetime total', () => {
  const complete = record({ messageId: 'a', inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, thinkingOutputTokens: 0 }, { streamingDuration: '0s', timeToFirstToken: '0s' });
  const full = summarizeMetadata([complete]);
  assert.equal(full.tokens.outputTokens, 0);
  assert.equal(full.tokens.cacheReadTokens, 0);
  assert.equal(full.session.modelSeconds, 0);
  assert.equal(full.session.averageTtftSeconds, 0);
  assert.equal(full.session.averageTokensPerSecond, null);
  const partial = summarizeMetadata([complete, record(undefined)]);
  assert.equal(partial.tokens.inputTokens, null);
  assert.equal(partial.tokens.outputTokens, null);
  assert.equal(partial.tokens.totalTokens, null);
  assert.equal(partial.tokens.coverage.inputTokens, 1);
  assert.equal(partial.session.modelSeconds, null);
  assert.equal(partial.session.requestCount, 2);
  assert.equal(summarizeMetadata([]).tokens, null);
  assert.equal(summarizeMetadata(null).session.elapsedSeconds, null);
});

test('cache rate and uncached input require a verified denominator; raw fields stay independent', () => {
  for (const inputTokens of [0, 10, 100]) {
    const { tokens } = summarizeMetadata([record({ inputTokens, outputTokens: 1, cacheReadInputTokens: 50 })]);
    assert.equal(tokens.inputTokens, inputTokens);
    assert.equal(tokens.cacheReadTokens, 50);
    assert.equal(tokens.cacheInputSemantics, 'unknown');
    assert.equal(tokens.uncachedInputTokens, null);
    assert.equal(tokens.cacheHitFraction, null);
  }
  assert.equal(summarizeMetadata([record({ responseOutputTokens: 5 })]).tokens.outputTokens, null);
  assert.equal(summarizeMetadata([record({ inputTokens: 1, outputTokens: 2 })]).tokens.cacheReadTokens, null);
});

test('timing samples remain independent, skip invalid intervals and retain finite output', () => {
  const result = summarizeMetadata([
    record({ outputTokens: 100, thinkingOutputTokens: 120 }, { streamingDuration: '1s', timeToFirstToken: '2s' }),
    record({ outputTokens: 10 }, { streamingDuration: null, timeToFirstToken: 0 }),
    record({ outputTokens: 0 }, { streamingDuration: '2s' })
  ]);
  assert.equal(result.session.modelSeconds, null);
  assert.equal(result.session.ttftSamples, 2);
  assert.equal(result.session.averageTtftSeconds, 1);
  assert.equal(result.session.tpsSamples, 1);
  assert.equal(result.session.averageTokensPerSecond, 0);
  assert.equal(result.session.tpsBasis, 'all-output');
  assert.equal(summarizeMetadata([record({ outputTokens: Number.MAX_SAFE_INTEGER }, { streamingDuration: Number.MIN_VALUE })]).speed, null);
  const overflow = summarizeMetadata([record({ inputTokens: Number.MAX_SAFE_INTEGER }), record({ inputTokens: 1 })]);
  assert.equal(overflow.tokens.inputTokens, null);
});

function client(options = {}) {
  return { discover: async () => ({ pid: 1, port: 2, csrf: 'synthetic-only' }),
    call: async () => ({ userStatus: { email: 'synthetic@example.invalid' } }),
    metadata: async () => [record({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })],
    reset() {}, ...options };
}

test('monitor samples conversation lifetime metadata afresh without account-wide accumulation', async () => {
  const monitor = new ContextMonitor(client({ metadata: async id => [record({ inputTokens: id === ID ? 12 : 3, outputTokens: 1 })] }));
  assert.equal((await monitor.sample(ID)).tokens.inputTokens, 12);
  assert.equal((await monitor.sample(OTHER)).tokens.inputTokens, 3);
  assert.equal((await monitor.sample(ID)).tokens.inputTokens, 12);
  monitor.reset();
  assert.equal(monitor.snapshot(), null);
});

test('monitor rejects account and host changes and never publishes a stale generation', async () => {
  let statusCalls = 0;
  const changedAccount = new ContextMonitor(client({ call: async () => ({ userStatus: { email: ++statusCalls === 1 ? 'one@example.invalid' : 'two@example.invalid' } }) }));
  assert.equal((await changedAccount.sample(ID)).state, 'unavailable');
  assert.equal(changedAccount.snapshot(), null);
  let servers = 0;
  const changedHost = new ContextMonitor(client({ discover: async () => ({ pid: ++servers, port: 2, csrf: 'synthetic-only' }) }));
  assert.equal((await changedHost.sample(ID)).state, 'unavailable');
  let resolve;
  const monitor = new ContextMonitor(client({ metadata: () => new Promise(done => { resolve = done; }) }));
  const first = monitor.sample(ID);
  assert.equal(monitor.sample(ID), first);
  while (!resolve) await Promise.resolve();
  monitor.reset();
  resolve([]);
  assert.equal((await first).state, 'unavailable');
  assert.equal(monitor.snapshot(), null);
});
