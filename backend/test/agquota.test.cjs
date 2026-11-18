const test = require('node:test');
const assert = require('node:assert');
const {
  createAgQuota,
  normalizeSubscriptionTier,
  clampPercentage,
  formatResetCountdown,
  summarizeModels,
  summarizeWindows,
  mergeLiveUserStatus
} = require('../core/agquota');

const fakeHttp = handlers => async ({ url }) => {
  for (const [needle, reply] of Object.entries(handlers)) {
    if (url.includes(needle)) return typeof reply === 'function' ? reply() : reply;
  }
  throw new Error(`unexpected request: ${url}`);
};

test('订阅档位归一化', () => {
  assert.equal(normalizeSubscriptionTier('g1-pro-tier'), 'PRO');
  assert.equal(normalizeSubscriptionTier('Google AI Ultra'), 'ULTRA');
  assert.equal(normalizeSubscriptionTier('free-tier'), 'FREE');
  assert.equal(normalizeSubscriptionTier(''), 'UNKNOWN');
});

test('百分比与倒计时格式', () => {
  assert.equal(clampPercentage(0.4567), 46);
  assert.equal(clampPercentage(2), 100);
  assert.equal(clampPercentage('x'), null);
  const now = Date.parse('2026-10-24T00:00:00Z');
  assert.equal(formatResetCountdown('2026-10-24T06:30:00Z', now), '6h 30m');
  assert.equal(formatResetCountdown('2026-10-23T00:00:00Z', now), '已重置');
});

test('模型按家族归并，Argon 优先', () => {
  const models = summarizeModels({
    'gemini-4-argon-high': { displayName: 'Gemini 4 Argon (High)', quotaInfo: { remainingFraction: 0.8, resetTime: '2030-01-01T00:00:00Z' } },
    'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.5 } },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.25 } },
    'gpt-oss-120b': { displayName: 'GPT-OSS 120B', disabled: true, tagTitle: '付费' }
  });

  assert.deepEqual(models.map(item => item.key), ['gemini-argon', 'claude', 'gemini']);
  assert.equal(models[0].percentage, 80);
  assert.equal(models[1].percentage, 25);
});

test('禁用模型在没有配额时标记为需付费', () => {
  const models = summarizeModels({
    'claude-opus-4-5': { displayName: 'Claude Opus 4.5', disabled: true, tagTitle: 'Pro only' }
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].disabled, true);
  assert.equal(models[0].resetText, '需付费 Pro/Ultra');
});

test('未被模型代表的 Argon 周窗口保留，5h 仍在前', () => {
  const windows = summarizeWindows({
    groups: [{ buckets: [
      { bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 0.9 },
      { bucketId: 'gemini-5h', remainingFraction: 0.6, resetTime: '2030-01-01T00:00:00Z' },
      { bucketId: '3p-weekly', remainingFraction: 0.3 }
    ] }]
  });

  assert.deepEqual(windows.map(item => item.key), ['gemini-5h', 'gemini-argon-wtu-weekly', '3p-weekly']);
  assert.equal(windows[0].window, '5h');
  assert.equal(windows[0].percentage, 60);
  assert.equal(windows[2].label, 'Claude (周限)');
});

test('同一语义窗口的别名只显示一次，相同余量的独立模型和周窗口保留', () => {
  const windows = summarizeWindows({ groups: [
    { buckets: [
      { bucketId: '3p-5h', remainingFraction: 0.5 },
      { bucketId: 'gemini-5h', remainingFraction: 0.5 },
      { bucketId: '3p-weekly', remainingFraction: 0 },
      { bucketId: 'custom', window: '5h', remainingFraction: 0.5 },
      { bucketId: 'custom', window: 'weekly', remainingFraction: 0.5 }
    ] },
    { buckets: [
      { bucketId: 'claude:5h', remainingFraction: 0.4 },
      { bucketId: 'gemini:5h', remainingFraction: 0.5 },
      { bucketId: 'claude:weekly', remainingFraction: 0 }
    ] }
  ] });
  assert.deepEqual(windows.map(item => [item.key, item.window, item.percentage]), [
    ['3p-5h', '5h', 50], ['gemini-5h', '5h', 50], ['custom', '5h', 50],
    ['3p-weekly', 'weekly', 0], ['custom', 'weekly', 50]
  ]);
});

test('模型与窗口共用语义标识，模型已代表的窗口不重复返回', async () => {
  const resetTime = '2030-01-01T00:00:00Z';
  const quota = createAgQuota({ http: fakeHttp({
    loadCodeAssist: '{}',
    fetchAvailableModels: JSON.stringify({ models: {
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.5, resetTime } },
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.5, resetTime } },
      'gemini-4-argon-high': { displayName: 'Gemini 4 Argon', quotaInfo: { remainingFraction: 0, resetTime } }
    } }),
    retrieveUserQuotaSummary: JSON.stringify({ groups: [{ buckets: [
      { bucketId: '3p-5h', remainingFraction: 0.5, resetTime },
      { bucketId: 'gemini-5h', remainingFraction: 0.5, resetTime },
      { bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 0, resetTime },
      { bucketId: '3p-weekly', remainingFraction: 0, resetTime }
    ] }] })
  }) });
  const result = await quota.fetchAccountQuota({ accessToken: 'synthetic-access' });
  assert.deepEqual(result.models.map(item => item.quotaKey), ['gemini-argon:weekly', 'claude:5h', 'gemini:5h']);
  assert.deepEqual(result.windows.map(item => [item.key, item.percentage]), [['3p-weekly', 0]]);
});

test('live 合并清理历史窗口别名，但保留周限和未开放模型的有效窗口', () => {
  const quota = { models: [{ key: 'claude', window: '5h', percentage: 70 }], windows: [
    { key: '3p-5h', window: '5h', percentage: 70 },
    { key: 'claude:5h', window: '5h', percentage: 70 },
    { key: '3p-weekly', window: 'weekly', percentage: 0 },
    { key: 'gemini-5h', window: '5h', percentage: 0 }
  ] };
  const merged = mergeLiveUserStatus(quota, { cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.7 } }
  ] } });
  assert.deepEqual(merged.windows.map(item => item.key), ['3p-weekly', 'gemini-5h']);
  assert.equal(quota.windows.length, 4);
  const disabled = summarizeModels({ 'claude-sonnet': { disabled: true } });
  assert.equal(summarizeWindows({ groups: [{ buckets: [{ bucketId: '3p-5h', remainingFraction: 0 }] }] }, disabled).length, 1);
});

test('live 模型覆盖后同余量的独立周窗口和未知桶仍完整保留', () => {
  const windows = summarizeWindows({ groups: [{ buckets: [
    { bucketId: '3p-5h', remainingFraction: 0.5 },
    { bucketId: '3p-weekly', remainingFraction: 0 },
    { bucketId: 'gemini-weekly', remainingFraction: 0 },
    { bucketId: 'custom-a', displayName: 'Distinct model A', window: 'weekly', remainingFraction: 0.5 },
    { bucketId: 'custom-b', displayName: 'Distinct model B', window: 'weekly', remainingFraction: 0.5 },
    { bucketId: 'constructor', displayName: 'Constructor quota', remainingFraction: 0.5 },
    { bucketId: 'toString', remainingFraction: 0.5 },
    { bucketId: '__proto__', remainingFraction: 0.5 }
  ] }] });
  const merged = mergeLiveUserStatus({ models: [], windows }, {
    cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.5 } }
    ] }
  });
  assert.deepEqual(merged.windows.map(item => item.key), [
    '3p-weekly', 'gemini-weekly', 'custom-a', 'custom-b', 'constructor', 'toString', '__proto__'
  ]);
  assert.deepEqual(merged.windows.map(item => item.percentage), [0, 0, 50, 50, 50, 50, 50]);
  assert.deepEqual(merged.windows.slice(2).map(item => item.label), [
    'Distinct model A', 'Distinct model B', 'Constructor quota', 'toString', '__proto__'
  ]);
  assert.equal(new Set(merged.windows.map(item => item.quotaKey)).size, merged.windows.length);
});

test('档位查询失败时保持 UNKNOWN，而不是伪装成 FREE', async () => {
  const quota = createAgQuota({
    http: fakeHttp({
      'loadCodeAssist': JSON.stringify({ error: { code: 500, message: 'boom' } }),
      'fetchAvailableModels': JSON.stringify({ models: {} })
    })
  });

  const result = await quota.fetchAccountQuota({ accessToken: 'at' });
  assert.equal(result.tier, 'UNKNOWN');
  assert.equal(result.tierName, null);
  assert.equal(result.error, null);
  assert.ok(result.warnings.some(message => message.includes('订阅档位')));
});

test('接口正常时返回档位与模型配额', async () => {
  const quota = createAgQuota({
    http: fakeHttp({
      'loadCodeAssist': JSON.stringify({ currentTier: { id: 'free-tier', name: 'Free' } }),
      'fetchAvailableModels': JSON.stringify({
        models: {
          'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.42 } }
        }
      }),
      'retrieveUserQuotaSummary': JSON.stringify({
        groups: [{ buckets: [{ bucketId: '3p-5h', remainingFraction: 0.1 }] }]
      })
    })
  });

  const result = await quota.fetchAccountQuota({ accessToken: 'at', email: 'a@example.com' });
  assert.equal(result.tier, 'FREE');
  assert.equal(result.email, 'a@example.com');
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].percentage, 42);
  assert.equal(result.windows.length, 1);
  assert.deepEqual(result.warnings, []);
});

test('档位缺失但模型可得时，warnings 会记录缺档', async () => {
  const quota = createAgQuota({
    http: fakeHttp({
      'loadCodeAssist': () => { throw new Error('network down'); },
      'fetchAvailableModels': JSON.stringify({ models: {} })
    })
  });

  const result = await quota.fetchAccountQuota({ accessToken: 'at' });
  assert.equal(result.tier, 'UNKNOWN');
  assert.ok(result.warnings.length >= 1);
});

test('live 用户状态可补齐 UNKNOWN 档位与模型', () => {
  const merged = mergeLiveUserStatus({ tier: 'UNKNOWN', models: [] }, {
    userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    cascadeModelConfigData: {
      clientModelConfigs: [{ label: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.7 } }]
    }
  });

  assert.equal(merged.tier, 'PRO');
  assert.equal(merged.tierName, 'Google AI Pro');
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].key, 'claude');
});

test('四路请求全部失败时拒绝返回 UNKNOWN 伪成功', async () => {
  let requests = 0;
  const quota = createAgQuota({ http: async () => { requests++; throw new Error('synthetic offline'); } });
  await assert.rejects(quota.fetchAccountQuota({ accessToken: 'synthetic-access' }), error => {
    assert.equal(error.code, 'quota_unavailable');
    assert.match(error.message, /所有配额接口均查询失败/);
    return true;
  });
  assert.equal(requests, 4);
});

test('空响应、错误响应及 null 不得被统计为上游成功', async t => {
  for (const reply of ['', 'null', 'false', '[]', JSON.stringify({ error: { message: 'synthetic denied' } })]) await t.test(reply || 'empty', async () => {
    const quota = createAgQuota({ http: async () => reply });
    await assert.rejects(quota.fetchAccountQuota({ accessToken: 'synthetic-access' }), error => error.code === 'quota_unavailable');
  });
});

test('任一配额接口部分成功仍返回可用结果', async t => {
  for (const endpoint of ['loadCodeAssist', 'fetchAvailableModels', 'retrieveUserQuotaSummary', 'fetchQuotaStatus']) await t.test(endpoint, async () => {
    const quota = createAgQuota({ http: async ({ url }) => {
      if (!url.includes(endpoint)) throw new Error('synthetic optional failure');
      if (endpoint === 'loadCodeAssist') return JSON.stringify({ currentTier: { id: 'g1-pro-tier' } });
      if (endpoint === 'retrieveUserQuotaSummary') return JSON.stringify({ groups: [{ buckets: [{ bucketId: '3p-weekly', remainingFraction: 0.4 }] }] });
      return JSON.stringify({ models: { 'claude-sonnet': { displayName: 'Claude Sonnet', quotaInfo: { remainingFraction: 0.6 } } } });
    } });
    const result = await quota.fetchAccountQuota({ accessToken: 'synthetic-access' });
    assert.equal(result.error, null);
    if (endpoint === 'loadCodeAssist') assert.equal(result.tier, 'PRO');
    else if (endpoint === 'retrieveUserQuotaSummary') assert.equal(result.windows[0].percentage, 40);
    else assert.equal(result.models[0].percentage, 60);
  });
});
