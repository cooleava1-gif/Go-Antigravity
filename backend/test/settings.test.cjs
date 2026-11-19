'use strict';
// Settings defaults decide whether Goagy silently rewrites Antigravity's kernel, so they are
// pinned here: a fresh install must land on the shipped axes, and an existing settings file that
// predates them must adopt the new defaults instead of staying on "stock".
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-settings-'));
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

test('出厂默认是精简·防编造 + 512K 上下文，并开启启动前自动同步', () => {
  assert.strictEqual(DEFAULTS.promptTier, '3');
  assert.strictEqual(DEFAULTS.contextMode, '512k');
  assert.strictEqual(DEFAULTS.autoApplyKernelPatch, true);
  assert.deepStrictEqual(KERNEL_DEFAULTS, { promptTier: '3', contextMode: '512k' });
  assert.strictEqual(DEFAULTS.customSystemPrompt, '');
  assert.strictEqual(DEFAULTS.customPromptUpdatedAt, 0);
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
    assert.strictEqual(settings.get().promptTier, '3');
    assert.strictEqual(settings.get().contextMode, '512k');
    assert.strictEqual(settings.get().autoApplyKernelPatch, true);
    assert.strictEqual(settings.get().preflightProxy, true);
  });
});

test('已显式选过档位的用户不会被默认值覆盖', () => {
  withSettings(file => {
    writeSettings(file, { promptTier: '2', contextMode: '900k', autoApplyKernelPatch: false });
    const settings = createSettings(file);
    assert.strictEqual(settings.get().promptTier, '2');
    assert.strictEqual(settings.get().contextMode, '900k');
    assert.strictEqual(settings.get().autoApplyKernelPatch, false);
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
  assert.strictEqual(normalizeSettings({ contextMode: '1M' }).contextMode, '900k');
  assert.strictEqual(normalizeSettings({ contextMode: '512' }).contextMode, '512k');
  assert.strictEqual(normalizeSettings({ contextMode: 'reset' }).contextMode, 'stock');
  assert.throws(() => normalizeSettings({ promptTier: '5' }), /promptTier/);
  assert.throws(() => normalizeSettings({ contextMode: '2m' }), /contextMode/);
  assert.throws(() => normalizeSettings({ autoApplyKernelPatch: 'yes' }), /autoApplyKernelPatch 必须是布尔值/);
  assert.throws(() => normalizeSettings({ preflightProxy: 'yes' }), /preflightProxy 必须是布尔值/);
});

test('prompt payload version is v2 only for new installs or explicit saved consent', () => {
  withSettings(file => {
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 2);
    writeSettings(file, { promptTier: '3' });
    const existing = createSettings(file);
    assert.strictEqual(existing.get().promptPayloadVersion, 1);
    existing.update({ port: 7891 });
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 1);
    existing.update({ promptPayloadVersion: 2 });
    assert.strictEqual(createSettings(file).get().promptPayloadVersion, 2);
    assert.throws(() => existing.update({ promptPayloadVersion: 3 }), /promptPayloadVersion/);
  });
});

test('prompt tier aliases map to stable keys without dropping numeric legacy preferences', () => {
  for (const [alias, expected] of [['official', 'stock'], ['balanced', '4'], ['compact', '3'], ['replace', 'custom'], ['custom', 'custom'], ['1', '1'], ['2', '2'], ['4', '4']]) {
    assert.strictEqual(normalizeSettings({ promptTier: alias }).promptTier, expected);
  }
  assert.strictEqual(normalizeSettings({ promptTier: 'TIER3' }).promptTier, '3');
  assert.strictEqual(normalizeSettings({ promptTier: 'CUSTOM' }).promptTier, 'custom');
  assert.strictEqual(normalizeSettings({ contextMode: '1M' }).contextMode, '900k');
});

test('设置文件损坏时回落到默认档位，不会挡住启动', () => {
  withSettings(file => {
    fs.writeFileSync(file, '{ 这不是 JSON');
    const settings = createSettings(file);
    assert.strictEqual(settings.get().promptTier, '3');
    assert.strictEqual(settings.get().contextMode, '512k');
    assert.strictEqual(settings.get().port, DEFAULTS.port);
  });
});

test('custom prompt is stored locally but excluded from public settings', () => {
  const text = '本地自定义核心指令：先读取再断言。';
  assert.strictEqual(typeof publicSettings, 'function');
  withSettings(file => {
    const settings = createSettings(file);
    const updatedAt = 1730000000000;
    const saved = settings.update({ customSystemPrompt: text, customPromptUpdatedAt: updatedAt });
    assert.strictEqual(saved.customSystemPrompt, text);
    assert.strictEqual(saved.customPromptUpdatedAt, updatedAt);
    const reloaded = createSettings(file).get();
    assert.strictEqual(reloaded.customSystemPrompt, text);
    assert.strictEqual(reloaded.customPromptUpdatedAt, updatedAt);
    const publicValue = publicSettings(reloaded);
    assert.strictEqual(publicValue.promptTier, '3');
    assert.strictEqual(publicValue.contextMode, '512k');
    assert.ok(!Object.hasOwn(publicValue, 'customSystemPrompt'));
    assert.ok(!Object.hasOwn(publicValue, 'customPromptUpdatedAt'));
    assert.strictEqual(JSON.stringify(publicValue).includes(text), false);
    const cleared = settings.update({ customSystemPrompt: '', customPromptUpdatedAt: 0 });
    assert.strictEqual(cleared.customSystemPrompt, '');
    assert.strictEqual(cleared.customPromptUpdatedAt, 0);
  });
  for (const value of [null, 1, true, {}, [], 'x'.repeat(3970), 'has' + String.fromCharCode(0) + 'nul', '{{ template }}', 'a }} b']) {
    assert.throws(() => normalizeSettings({ customSystemPrompt: value }));
  }
  assert.throws(() => normalizeSettings({ customSystemPrompt: text, customPromptUpdatedAt: -1 }));
  assert.throws(() => normalizeSettings({ customSystemPrompt: text, customPromptUpdatedAt: 1.5 }));
  assert.strictEqual(normalizeSettings({ customSystemPrompt: '' }).customSystemPrompt, '');
});
