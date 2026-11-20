'use strict';
// Pin the defaults and the migration of previously saved kernel preferences.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, KERNEL_DEFAULTS, normalizeSettings, createSettings, publicSettings } = require('../core/settings');

test('mobile settings default to portable quick mode and retain explicit choices', () => {
  assert.strictEqual(DEFAULTS.mobileMode, 'quick');
  assert.strictEqual(DEFAULTS.mobileFixedUrl, '');
  assert.strictEqual(DEFAULTS.mobileAutoStart, false);
  withSettings(file => {
    const settings = createSettings(file);
    settings.update({ mobileMode: 'fixed', mobileFixedUrl: 'https://mobile.example.com/', mobileAutoStart: true });
    const saved = createSettings(file).get();
    assert.strictEqual(saved.mobileMode, 'fixed');
    assert.strictEqual(saved.mobileFixedUrl, 'https://mobile.example.com');
    assert.strictEqual(saved.mobileAutoStart, true);
    assert.strictEqual(saved.port, DEFAULTS.port);
  });
});
test('mobile settings reject malformed origins and invalid mode types', () => {
  for (const mobileFixedUrl of ['http://mobile.example.com', 'https://user:secret@mobile.example.com', 'https://mobile.example.com:444', 'https://mobile.example.com/path', 'https://mobile.example.com?secret=a', 'https://mobile.example.com#fragment', 'https://127.0.0.1', 'https://localhost', ' https://mobile.example.com', null, 1]) {
    assert.throws(() => normalizeSettings({ mobileFixedUrl }));
  }
  for (const mobileMode of ['named', true, null, 1]) assert.throws(() => normalizeSettings({ mobileMode }));
  assert.throws(() => normalizeSettings({ mobileAutoStart: 'yes' }));
  assert.strictEqual(normalizeSettings({ mobileFixedUrl: '' }).mobileFixedUrl, '');
});

function withSettings(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-settings-'));
  const file = path.join(dir, 'settings.json');
  try { return run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Written without a trailing newline on purpose. An earlier revision appended one through an
// over-escaped literal, which quietly made the fixture unparseable — every assertion then ran
// against readJson's fallback instead of the value under test, so "the default wins" looked like
// "the user's choice is preserved". Reading it back is the guard against that class of mistake.
function writeSettings(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), value, '夹具必须能被原样读回');
}

test('出厂默认是官方原版 + 256K 上下文，并开启启动前自动同步', () => {
  assert.strictEqual(DEFAULTS.promptTier, 'stock');
  assert.strictEqual(DEFAULTS.contextMode, '256k');
  assert.strictEqual(DEFAULTS.autoApplyKernelPatch, true);
  assert.deepStrictEqual(KERNEL_DEFAULTS, { promptTier: 'stock', contextMode: '256k' });
  // The custom prompt tier and its two settings keys were removed; nothing may reintroduce them.
  assert.strictEqual(Object.hasOwn(DEFAULTS, 'customSystemPrompt'), false);
  assert.strictEqual(Object.hasOwn(DEFAULTS, 'customPromptUpdatedAt'), false);
  // 原有的两个开关不受影响
  assert.strictEqual(DEFAULTS.enableI18n, true);
  assert.strictEqual(DEFAULTS.enableContextMonitor, true);
  // 代理自检默认开：不打开的话，死代理只会以 AG 的一句 "HTTP 400" 呈现
  assert.strictEqual(DEFAULTS.preflightProxy, true);
});

test('旧设置文件（没有内核三个键）升级后拿到新默认值', () => {
  withSettings(file => {
    writeSettings(file, { port: 10809 });
    const settings = createSettings(file);
    assert.strictEqual(settings.get().port, 10809, '既有端口必须保留');
    assert.strictEqual(settings.get().promptTier, 'stock');
    assert.strictEqual(settings.get().contextMode, '256k');
    assert.strictEqual(settings.get().autoApplyKernelPatch, true);
    assert.strictEqual(settings.get().preflightProxy, true);
  });
});

test('旧 900K 偏好迁到 512K，保留提示词及启动开关', () => {
  withSettings(file => {
    writeSettings(file, { promptTier: '2', contextMode: '900k', autoApplyKernelPatch: false });
    const settings = createSettings(file);
    assert.strictEqual(settings.get().promptTier, '2');
    assert.strictEqual(settings.get().contextMode, '512k');
    assert.strictEqual(settings.get().autoApplyKernelPatch, false);
    settings.update({ port: 7891 });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).contextMode, '512k');
  });
});

test('旧设置文件升级后开启启动前代理自检', () => {
  withSettings(file => {
    writeSettings(file, { port: 10809 });
    const settings = createSettings(file);
    assert.strictEqual(settings.get().preflightProxy, true, '没有这个键的旧文件必须拿到新默认值');
    assert.strictEqual(settings.get().port, 10809, '顺带确认旧端口没被默认值吃掉');
  });
});

test('用户关掉代理自检后不会被默认值重新打开', () => {
  withSettings(file => {
    writeSettings(file, { preflightProxy: false });
    assert.strictEqual(createSettings(file).get().preflightProxy, false);
  });
});

test('档位写法兼容大小写与 restore/stock 同义词', () => {
  assert.strictEqual(normalizeSettings({ promptTier: 'TIER3' }).promptTier, '3');
  assert.strictEqual(normalizeSettings({ promptTier: 'restore' }).promptTier, 'stock');
  assert.strictEqual(normalizeSettings({ contextMode: '1M' }).contextMode, '512k');
  assert.strictEqual(normalizeSettings({ contextMode: '512' }).contextMode, '512k');
  assert.strictEqual(normalizeSettings({ contextMode: 'reset' }).contextMode, '256k');
  assert.throws(() => normalizeSettings({ promptTier: '5' }), /promptTier/);
  assert.throws(() => normalizeSettings({ contextMode: '2m' }), /contextMode/);
  assert.throws(() => normalizeSettings({ autoApplyKernelPatch: 'yes' }), /autoApplyKernelPatch 必须是布尔值/);
  assert.throws(() => normalizeSettings({ preflightProxy: 'yes' }), /preflightProxy 必须是布尔值/);
});

test('settings retain older prompt versions and accept explicit v3 consent', () => {
  withSettings(file => {
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 3);
    writeSettings(file, { promptTier: '3' });
    const existing = createSettings(file);
    assert.strictEqual(existing.get().promptPayloadVersion, 1);
    existing.update({ port: 7891 });
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 1);
    existing.update({ promptPayloadVersion: 2 });
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 2);
    existing.update({ promptPayloadVersion: 3 });
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 3);
    assert.throws(() => existing.update({ promptPayloadVersion: 4 }), /promptPayloadVersion/);
  });
});

test('prompt tier aliases map to stable keys and the removed custom tier degrades to stock', () => {
  for (const [alias, expected] of [['official', 'stock'], ['balanced', '4'], ['compact', '3'], ['replace', 'stock'], ['custom', 'stock'], ['1', '1'], ['2', '2'], ['4', '4']]) {
    assert.strictEqual(normalizeSettings({ promptTier: alias }).promptTier, expected);
  }
  assert.strictEqual(normalizeSettings({ promptTier: 'TIER3' }).promptTier, '3');
  assert.strictEqual(normalizeSettings({ promptTier: 'CUSTOM' }).promptTier, 'stock');
});

test('设置文件损坏时回落默认值并告警，不输出原始内容或覆盖灾备', () => {
  withSettings(file => {
    const original = '{ synthetic-private-value 这不是 JSON';
    fs.writeFileSync(file, original);
    const notices = [];
    const settings = createSettings(file, { log: (...args) => notices.push(args) });
    assert.strictEqual(settings.get().promptTier, 'stock');
    assert.strictEqual(settings.get().contextMode, '256k');
    assert.strictEqual(settings.get().port, DEFAULTS.port);
    assert.strictEqual(notices.length, 1);
    assert.match(notices[0][0], /默认设置/);
    assert.strictEqual(notices[0][1], 'tag-alert');
    assert.strictEqual(JSON.stringify(notices).includes('synthetic-private-value'), false);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  });
});

test('首次启动不告警，有效JSON的非法设置也给出恢复提示', () => {
  withSettings(file => {
    const notices = [];
    const options = { log: (...args) => notices.push(args) };
    createSettings(file, options);
    assert.deepStrictEqual(notices, []);
    writeSettings(file, { port: 0 });
    assert.strictEqual(createSettings(file, options).get().port, DEFAULTS.port);
    assert.strictEqual(notices.length, 1);
  });
});

test('a settings file written by an older build still loads after the custom tier was removed', () => {
  const text = '本地自定义核心指令：先读取再断言。';
  assert.strictEqual(typeof publicSettings, 'function');
  withSettings(file => {
    writeSettings(file, { promptTier: 'custom', customSystemPrompt: text, customPromptUpdatedAt: 1730000000000 });
    const settings = createSettings(file);
    const loaded = settings.get();
    assert.strictEqual(loaded.promptTier, 'stock', '一个已打开的自定义档位回落到官方原版，而不是整体重置');
    assert.strictEqual(loaded.contextMode, '256k');
    assert.ok(!Object.hasOwn(loaded, 'customSystemPrompt'));
    assert.ok(!Object.hasOwn(loaded, 'customPromptUpdatedAt'));
    assert.strictEqual(JSON.stringify(publicSettings(loaded)).includes(text), false);
    // The next write drops the retired keys instead of carrying them forward.
    settings.update({ port: 7891 });
    const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(rewritten.port, 7891);
    assert.strictEqual(rewritten.promptTier, 'stock');
    assert.ok(!Object.hasOwn(rewritten, 'customSystemPrompt'));
    assert.ok(!Object.hasOwn(rewritten, 'customPromptUpdatedAt'));
  });
  // Retired keys are ignored rather than rejected, whatever shape an older client sends.
  for (const value of [null, 1, true, {}, [], 'x'.repeat(3970), '{{ template }}'])
    assert.doesNotThrow(() => normalizeSettings({ customSystemPrompt: value }));
});
