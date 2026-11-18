'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const bundledPackage = require('../package.json');
const { Updater, resolveRuntimeRoot } = require('../features/updater');
const { loadDictionary } = require('../features/i18n');
const { resolveDataDirectory } = require('../core/runtime-data');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function tree(dir) {
  const entries = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const target = path.join(dir, name);
    entries[name] = fs.statSync(target).isDirectory() ? tree(target) : fs.readFileSync(target, 'hex');
  }
  return entries;
}

function hostileData(dir) {
  writeJson(path.join(dir, 'hotfix', 'update-state.json'), {
    runtimeVersion: '999.0.0', dictVersion: 'downloaded', restartRequired: true, lastCheckedAt: 123
  });
  writeJson(path.join(dir, 'runtime', 'current', 'overlay-meta.json'), { version: '999.0.0' });
  fs.writeFileSync(path.join(dir, 'runtime', 'current', 'server.js'), 'throw new Error("saved overlay executed");');
}

test('saved update state cannot override bundled identity or request a restart', t => {
  const dir = fixture(t);
  hostileData(dir);
  writeJson(path.join(dir, 'package.json'), { name: 'upstream-overlay', version: '999.0.0' });
  const before = tree(dir);
  const updater = new Updater({ rootDir: dir, dataDir: dir });
  assert.deepEqual(updater.currentState(), {
    name: bundledPackage.name, edition: bundledPackage.edition,
    version: bundledPackage.version, bundledVersion: bundledPackage.version,
    dictVersion: '内置词典', lastCheckedAt: null, restartRequired: false, updatesEnabled: false
  });
  assert.deepEqual(tree(dir), before, 'constructing or reading updater must not rewrite saved data or package metadata');
});

test('all update arguments and environment sources are disabled without fetching, callbacks or writes', async t => {
  const dir = fixture(t);
  hostileData(dir);
  const before = tree(dir);
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('update side effect'); };
  const updater = new Updater({
    rootDir: dir, dataDir: dir, fetchBytes: forbidden,
    onDictionaryUpdated: forbidden, onRuntimeUpdated: forbidden,
    events: { log: forbidden, publish: forbidden }, settings: { get: forbidden, update: forbidden }
  });
  const previous = process.env.EASYAG_UPDATE_URL;
  process.env.EASYAG_UPDATE_URL = 'https://untrusted.invalid/manifest.json';
  t.after(() => {
    if (previous === undefined) delete process.env.EASYAG_UPDATE_URL;
    else process.env.EASYAG_UPDATE_URL = previous;
  });
  const unreadable = new Proxy({}, { get: forbidden });
  for (const input of [undefined, {}, { manifestUrl: 'https://untrusted.invalid/direct.json' }, unreadable]) {
    await assert.rejects(updater.checkAndApply(input), { code: 'UPDATES_DISABLED', status: 410 });
  }
  assert.equal(calls, 0);
  assert.deepEqual(tree(dir), before);
});

test('offline updater never imports network or filesystem code and never calls global fetch', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'features', 'updater.js'), 'utf8');
  const module = { exports: {} };
  const forbidden = () => assert.fail('offline updater attempted network or filesystem access');
  vm.runInNewContext(source, {
    module, exports: module.exports, fetch: forbidden,
    require: name => {
      assert.equal(name, '../package.json');
      return bundledPackage;
    }
  });
  const updater = new module.exports.Updater(new Proxy({}, { get: forbidden }));
  assert.equal(updater.currentState().version, bundledPackage.version);
  await assert.rejects(updater.checkAndApply({ manifestUrl: 'https://untrusted.invalid/' }), error =>
    error.code === 'UPDATES_DISABLED' && error.status === 410);
});

test('runtime root resolver ignores a newer saved executable overlay', t => {
  const dir = fixture(t);
  const bundledRoot = path.join(dir, 'bundle');
  fs.mkdirSync(bundledRoot);
  writeJson(path.join(bundledRoot, 'package.json'), { version: '1.0.0' });
  hostileData(dir);
  const before = tree(dir);
  assert.equal(resolveRuntimeRoot(bundledRoot, dir), bundledRoot);
  assert.deepEqual(tree(dir), before);
});

test('bundled dictionaries ignore downloaded overrides while retaining sanitization and merge order', t => {
  const dir = fixture(t);
  const rootDir = path.join(dir, 'bundle');
  const dataDir = path.join(dir, 'data');
  writeJson(path.join(rootDir, 'dicts', 'ui_v2.json'), { Hello: '内置', Shared: '界面', Bad: 4 });
  writeJson(path.join(rootDir, 'dicts', 'common.json'), { Shared: '通用', Common: '保留' });
  writeJson(path.join(dataDir, 'hotfix', 'dicts', 'ui_v2.json'), { Hello: '下载覆盖', Injected: '不应加载' });
  writeJson(path.join(dataDir, 'hotfix', 'dicts', 'common.json'), { Shared: '下载通用' });
  const before = tree(dir);
  assert.deepEqual(loadDictionary(rootDir, dataDir), { Hello: '内置', Shared: '通用', Common: '保留' });
  assert.deepEqual(tree(dir), before);
});

for (const explicitlyConfigured of [false, true]) test(`server boot uses only its source and independent data options (override=${explicitlyConfigured})`, async t => {
  const dir = fixture(t);
  hostileData(dir);
  const checkout = path.join(dir, 'bundle');
  const bundledRoot = path.join(checkout, 'backend');
  const expectedData = path.join(checkout, explicitlyConfigured ? 'explicit-data' : '.go-antigravity-data');
  const readyFile = path.join(dir, 'independent-ready.json');
  const stdin = {};
  const inputEvents = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const imports = [];
  let received;
  let started = 0;
  let signalStarted;
  const booted = new Promise(resolve => { signalStarted = resolve; });
  vm.runInNewContext(source, {
    __dirname: bundledRoot, console, setTimeout,
    process: {
      pkg: true, stdin,
      execPath: path.join(dir, 'legacy-runtime', 'easyag-node.exe'),
      env: {
        EASYAG_DATA_DIR: dir, EASYAG_TAURI: '1', EASYAG_READY_FILE: path.join(dir, 'old-ready.json'),
        EASYAG_TEST_MODE: '1', EASYAG_DISABLE_OVERLAY: '0', EASYAG_UPDATE_URL: 'https://untrusted.invalid/',
        ...(explicitlyConfigured ? {
          GO_ANTIGRAVITY_DATA_DIR: 'explicit-data', GO_ANTIGRAVITY_QT_HOST: '1',
          GO_ANTIGRAVITY_READY_FILE: readyFile, GO_ANTIGRAVITY_TEST_MODE: '1'
        } : {})
      },
      once() {}, on() {}, exit: code => assert.fail('unexpected exit ' + code)
    },
    require: name => {
      imports.push(name);
      if (name === './core/runtime-data') return { resolveDataDirectory };
      if (name === 'node:readline') return { createInterface: ({ input }) => {
        assert.equal(explicitlyConfigured, true, 'non-native boot must not open stdin');
        assert.equal(input, stdin);
        return { on(event) { inputEvents.push(event); return this; } };
      } };
      if (name === './desktop/application') return { createApplication: async options => {
        received = options;
        return { start: async () => { started++; signalStarted(); } };
      } };
      assert.fail('unexpected startup import ' + name);
    }
  });
  await booted;
  assert.equal(started, 1);
  assert.equal(received.rootDir, bundledRoot);
  assert.equal(received.dataDir, expectedData);
  assert.equal(received.readyFile, explicitlyConfigured ? readyFile : undefined);
  assert.equal(received.testMode, explicitlyConfigured);
  assert.equal(received.native, explicitlyConfigured);
  assert.deepEqual(inputEvents, explicitlyConfigured ? ['line', 'close'] : []);
  assert.equal(typeof received.onClose, 'function');
  assert.equal(imports.includes('./features/updater'), false);
});
