'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVault } = require('../core/vault');
const { createMobileSecrets, validateTunnelToken } = require('../core/mobile-secrets');
const { createApplication } = require('../desktop/application');
const { createSettings } = require('../core/settings');
const { writeJson } = require('../core/storage');
const TOKEN = 'synthetic-cloudflare-token-12345';
const NEXT = 'synthetic-cloudflare-replacement-67890';
const EVIDENCE = process.env.TEST_EVIDENCE_ROOT || path.join(os.tmpdir(), 'go-antigravity-enhancements-20261118');
function directory(t) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(EVIDENCE, 'named-token-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixtureVault(options = {}) {
  const vault = createVault({ readKey: async () => Buffer.alloc(32, 7), writeKey: async () => { throw Error('No OS store'); }, ...options });
  await vault.unlock(); return vault;
}
const safeUnavailable = error => error.code === 'MOBILE_CREDENTIAL_UNAVAILABLE' && error.status === 503 && !error.message.includes(TOKEN);
test('mobile token persists encrypted across reopened store and blank save preserves while explicit clear persists', async t => {
  const dir = directory(t), vault = await fixtureVault();
  let store = createMobileSecrets(dir, { vault });
  assert.deepEqual(store.status(), { configured: false, available: false });
  store.prepare({ tunnelToken: TOKEN }).commit();
  const file = path.join(dir, 'mobile-vault.json'), encrypted = fs.readFileSync(file, 'utf8');
  assert.ok(encrypted.includes('enc:v1:')); assert.equal(encrypted.includes(TOKEN), false);
  store = createMobileSecrets(dir, { vault: await fixtureVault() });
  assert.equal(store.token(), TOKEN); assert.deepEqual(store.status(), { configured: true, available: true });
  assert.equal(store.prepare({ tunnelToken: '' }), null); assert.equal(fs.readFileSync(file, 'utf8'), encrypted);
  assert.throws(() => store.prepare({ tunnelToken: NEXT, clearTunnelToken: true }), error => error.code === 'MOBILE_TOKEN_INVALID');
  store.prepare({ tunnelToken: '', clearTunnelToken: true }).commit();
  store = createMobileSecrets(dir, { vault }); assert.equal(store.token(), null);
  assert.deepEqual(store.status(), { configured: false, available: false });
});
test('locked plaintext and corrupt vaults fail closed and allow explicit clear without fallback writes', async t => {
  const dir = directory(t), good = await fixtureVault();
  createMobileSecrets(dir, { vault: good }).prepare({ tunnelToken: TOKEN }).commit();
  const file = path.join(dir, 'mobile-vault.json'), before = fs.readFileSync(file, 'utf8');
  for (const vault of [undefined, await fixtureVault({ plaintext: true }), { canOpen: () => true, sealEnabled: () => true, open() { throw Error(TOKEN); }, seal() { return TOKEN; } }]) {
    const store = createMobileSecrets(dir, { vault });
    assert.deepEqual(store.status(), { configured: true, available: false });
    assert.throws(() => store.token(), safeUnavailable);
    assert.throws(() => store.prepare({ tunnelToken: NEXT }), safeUnavailable);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  fs.writeFileSync(file, JSON.stringify({ version: 1, tunnelToken: TOKEN }));
  const plaintext = createMobileSecrets(dir, { vault: good });
  assert.throws(() => plaintext.token(), safeUnavailable);
  plaintext.prepare({ clearTunnelToken: true }).commit(); assert.equal(plaintext.token(), null);
});
test('failed atomic token save retains previous memory and reopened ciphertext and sanitizes errors', async t => {
  const dir = directory(t), vault = await fixtureVault();
  createMobileSecrets(dir, { vault }).prepare({ tunnelToken: TOKEN }).commit();
  const store = createMobileSecrets(dir, { vault, write() { throw Error(NEXT); } });
  assert.throws(() => store.prepare({ tunnelToken: NEXT }).commit(), error => error.code === 'MOBILE_CREDENTIAL_SAVE_FAILED' && !error.message.includes(NEXT));
  assert.equal(store.token(), TOKEN); assert.equal(createMobileSecrets(dir, { vault }).token(), TOKEN);
});
test('token validator rejects controls whitespace command injection wrong types and oversize without echoing input', () => {
  for (const value of [null, 123, {}, '', ' ', TOKEN + '\n', TOKEN + '\r', TOKEN + '\u0000', 'a;b', 'a&b', '$(whoami)', '"quoted"', 'a'.repeat(16385)]) {
    assert.throws(() => validateTunnelToken(value), error => error.code === 'MOBILE_TOKEN_INVALID' && error.message === '隧道 Token 格式无效。');
  }
  assert.equal(validateTunnelToken('eyFake_-+/=') , 'eyFake_-+/=');
});
async function appFixture(t, options = {}) {
  const dataDir = directory(t), mobileVault = await fixtureVault();
  const app = await createApplication({ rootDir: path.resolve(__dirname, '../..'), dataDir, testMode: true, mobileVault, ...options });
  t.after(() => app.close('synthetic mobile test'));
  return { app, dataDir, mobileVault };
}
test('mobile API contract saves blank preserves clears and excludes token from settings snapshots events and account exports', async t => {
  const { app, dataDir, mobileVault } = await appFixture(t);
  const events = []; app.events.publish = event => events.push(event);
  const value = app.configureMobile({ mode: 'fixed', fixedUrl: 'https://mobile.example.test/', tunnelToken: TOKEN });
  assert.equal(value.fixedUrl, 'https://mobile.example.test'); assert.equal(value.tunnelTokenConfigured, true); assert.equal(value.fixedAuth, 'token');
  app.configureMobile({ tunnelToken: '', autoStart: true });
  assert.equal(createMobileSecrets(dataDir, { vault: mobileVault }).token(), TOKEN);
  const publicText = JSON.stringify([app.mobile.snapshot(), events, app.exportAccounts({ includeTokens: true })]);
  assert.equal(publicText.includes(TOKEN), false); assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8').includes(TOKEN), false);
  assert.throws(() => app.configureMobile({ tunnelToken: NEXT, clearTunnelToken: true }), error => error.code === 'MOBILE_TOKEN_INVALID');
  const cleared = app.configureMobile({ clearTunnelToken: true }); assert.equal(cleared.tunnelTokenConfigured, false);
  assert.equal(createMobileSecrets(dataDir, { vault: mobileVault }).token(), null);
});
test('mobile configuration settings failure leaves prior secret unchanged and secret failure restores settings', async t => {
  const { app, dataDir, mobileVault } = await appFixture(t);
  app.configureMobile({ mode: 'fixed', fixedUrl: 'https://mobile.example.test', tunnelToken: TOKEN });
  const previous = app.settings.get(), update = app.settings.update;
  app.settings.update = () => { throw Error(NEXT); };
  assert.throws(() => app.configureMobile({ tunnelToken: NEXT }), error => error.code === 'MOBILE_CREDENTIAL_SAVE_FAILED' && !error.message.includes(NEXT));
  assert.throws(() => createMobileSecrets(dataDir, { vault: mobileVault }).token(), safeUnavailable);
  app.settings.update = update;
  assert.equal(createMobileSecrets(dataDir, { vault: mobileVault, settings: app.settings }).token(), TOKEN);
  const second = await appFixture(t);
  second.app.configureMobile({ mode: 'fixed', fixedUrl: previous.mobileFixedUrl, tunnelToken: TOKEN });
  const secondPrevious = second.app.settings.get(), file = path.join(second.dataDir, 'mobile-vault.json'), original = fs.readFileSync(file);
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => second.app.configureMobile({ autoStart: true, clearTunnelToken: true }), error => error.code === 'MOBILE_CREDENTIAL_SAVE_FAILED');
  assert.deepEqual(second.app.settings.get(), secondPrevious); assert.equal(second.app.mobile.snapshot().tunnelTokenConfigured, true);
  fs.rmdirSync(file); fs.writeFileSync(file, original);
  assert.equal(createMobileSecrets(second.dataDir, { vault: second.mobileVault, settings: second.app.settings }).token(), TOKEN);
});
test('default test mode never falls back to plaintext credentials', async t => {
  const { app, dataDir } = await appFixture(t, { mobileVault: undefined });
  assert.throws(() => app.configureMobile({ tunnelToken: TOKEN }), safeUnavailable);
  assert.equal(fs.existsSync(path.join(dataDir, 'mobile-vault.json')), false);
});
test('active configuration guard preserves blank tokens but rejects set and clear without changing persisted credentials', async t => {
  const { app, dataDir, mobileVault } = await appFixture(t);
  app.configureMobile({ tunnelToken: TOKEN });
  let guards = 0;
  app.mobile.assertConfigMutable = () => { guards++; throw Object.assign(Error('locked'), { code: 'MOBILE_CONFIG_LOCKED', status: 409 }); };
  app.configureMobile({ tunnelToken: '' }); assert.equal(guards, 0);
  for (const input of [{ tunnelToken: NEXT }, { clearTunnelToken: true }]) {
    assert.throws(() => app.configureMobile(input), error => error.code === 'MOBILE_CONFIG_LOCKED' && error.status === 409);
    assert.equal(createMobileSecrets(dataDir, { vault: mobileVault }).token(), TOKEN);
  }
  assert.equal(guards, 2);
});

const journalPath = dir => path.join(dir, 'mobile-vault-transaction.json');
const vaultPath = dir => path.join(dir, 'mobile-vault.json');
const priorMobile = { mobileAutoStart: false, mobileMode: 'fixed', mobileFixedUrl: 'https://old.example.test' };
const nextMobile = { mobileAutoStart: true, mobileMode: 'fixed', mobileFixedUrl: 'https://new.example.test' };
async function transactionFixture(t, initial = TOKEN) {
  const dir = directory(t), vault = await fixtureVault(), settings = createSettings(path.join(dir, 'settings.json'));
  settings.update(priorMobile);
  if (initial) createMobileSecrets(dir, { vault }).prepare({ tunnelToken: initial }).commit();
  return { dir, vault, settings };
}
function beforeImage(dir, settings) {
  return { version: 1, settings: Object.fromEntries(Object.keys(priorMobile).map(key => [key, settings.get()[key]])),
    secret: fs.existsSync(vaultPath(dir)) ? JSON.parse(fs.readFileSync(vaultPath(dir), 'utf8')) : { version: 1, tunnelToken: null } };
}
test('journal reopens every rename boundary with a complete prior generation or the completed new generation', async t => {
  for (const initial of [null, TOKEN]) for (const clear of [false, true]) for (const stage of ['journal', 'settings', 'secret', 'complete']) {
    await t.test([initial ? 'old-token' : 'no-vault', clear ? 'clear' : 'set', stage].join(' '), async t => {
      const { dir, vault, settings } = await transactionFixture(t, initial), before = beforeImage(dir, settings);
      writeJson(journalPath(dir), before);
      const nextSecret = { version: 1, tunnelToken: clear ? null : vault.seal(NEXT) };
      if (stage !== 'journal') settings.update(nextMobile);
      if (['secret', 'complete'].includes(stage)) writeJson(vaultPath(dir), nextSecret);
      if (stage === 'complete') fs.unlinkSync(journalPath(dir));
      settings.update({ port: 19876 }); // Recovery must not revert unrelated preferences.
      const reopenedSettings = createSettings(path.join(dir, 'settings.json'));
      const store = createMobileSecrets(dir, { vault, settings: reopenedSettings });
      const expected = stage === 'complete' ? (clear ? null : NEXT) : initial;
      assert.equal(store.token(), expected);
      for (const key of Object.keys(priorMobile)) assert.equal(reopenedSettings.get()[key], (stage === 'complete' ? nextMobile : priorMobile)[key]);
      assert.equal(reopenedSettings.get().port, 19876); assert.equal(fs.existsSync(journalPath(dir)), false);
      assert.equal(createMobileSecrets(dir, { vault }).token(), expected);
    });
  }
});
test('failed secret save plus failed settings rollback keeps a durable encrypted-only journal and blocks blank changes until reopen recovery', async t => {
  const { dir, vault, settings } = await transactionFixture(t), update = settings.update;
  let settingsCalls = 0;
  settings.update = function (value) { if (++settingsCalls === 2) throw Error(TOKEN); return update.call(this, value); };
  const store = createMobileSecrets(dir, { vault, settings, write(file, value) {
    if (file === vaultPath(dir)) throw Error(NEXT); return writeJson(file, value);
  } });
  assert.throws(() => store.prepare({ tunnelToken: NEXT }).commit(nextMobile), error => error.code === 'MOBILE_CREDENTIAL_SAVE_FAILED' && !error.message.includes(NEXT));
  assert.equal(settings.get().mobileFixedUrl, nextMobile.mobileFixedUrl); assert.equal(fs.existsSync(journalPath(dir)), true);
  const journal = fs.readFileSync(journalPath(dir), 'utf8');
  assert.equal(journal.includes(TOKEN), false); assert.equal(journal.includes(NEXT), false); assert.match(journal, /enc:v1:/);
  assert.throws(() => store.assertReady(), safeUnavailable); assert.throws(() => store.prepare({ tunnelToken: '' }), safeUnavailable);
  assert.throws(() => store.prepare({ clearTunnelToken: true }), safeUnavailable);
  settings.update = update;
  const reopened = createMobileSecrets(dir, { vault, settings });
  assert.equal(reopened.token(), TOKEN); assert.equal(settings.get().mobileFixedUrl, priorMobile.mobileFixedUrl);
  assert.equal(settings.get().mobileAutoStart, false); assert.equal(fs.existsSync(journalPath(dir)), false);
});
test('journal creation failure leaves old state untouched and cleanup failure remains blocked until idempotent recovery', async t => {
  const { dir, vault, settings } = await transactionFixture(t), before = JSON.stringify(settings.get());
  const failed = createMobileSecrets(dir, { vault, settings, write() { throw Error(NEXT); } });
  assert.throws(() => failed.prepare({ tunnelToken: NEXT }).commit(nextMobile), error => error.code === 'MOBILE_CREDENTIAL_SAVE_FAILED');
  assert.equal(JSON.stringify(settings.get()), before); assert.equal(failed.token(), TOKEN); assert.equal(fs.existsSync(journalPath(dir)), false);
  const blocked = createMobileSecrets(dir, { vault, settings, remove() { throw Error(NEXT); } });
  assert.throws(() => blocked.prepare({ clearTunnelToken: true }).commit(nextMobile), error => error.code === 'MOBILE_CREDENTIAL_SAVE_FAILED');
  assert.throws(() => blocked.token(), safeUnavailable); assert.equal(fs.existsSync(journalPath(dir)), true);
  assert.equal(settings.get().mobileFixedUrl, priorMobile.mobileFixedUrl);
  const stillBlocked = createMobileSecrets(dir, { vault, settings, remove() { throw Error(TOKEN); } });
  assert.throws(() => stillBlocked.token(), safeUnavailable);
  assert.equal(stillBlocked.recover(), false); assert.equal(fs.existsSync(journalPath(dir)), true);
  const recovered = createMobileSecrets(dir, { vault, settings });
  assert.equal(recovered.token(), TOKEN); assert.equal(recovered.recover(), true); assert.equal(fs.existsSync(journalPath(dir)), false);
});
test('malformed unreadable or unversioned journals remain fail closed without overwriting settings or credentials', async t => {
  for (const malformed of ['{', {}, { version: 2 }, { version: 1, settings: priorMobile, secret: { version: 1, tunnelToken: TOKEN } },
    { version: 1, settings: { ...priorMobile, port: 19876 }, secret: { version: 1, tunnelToken: null } },
    { version: 1, settings: { ...priorMobile, mobileFixedUrl: 'https://good.example.test/path' }, secret: { version: 1, tunnelToken: null } },
    { version: 1, settings: priorMobile, secret: { version: 1, tunnelToken: 'enc:v1:bad' } }]) {
    const { dir, vault, settings } = await transactionFixture(t), before = JSON.stringify(settings.get()), encrypted = fs.readFileSync(vaultPath(dir), 'utf8');
    fs.writeFileSync(journalPath(dir), typeof malformed === 'string' ? malformed : JSON.stringify(malformed));
    const store = createMobileSecrets(dir, { vault, settings });
    assert.throws(() => store.token(), safeUnavailable); assert.throws(() => store.prepare({ tunnelToken: '' }), safeUnavailable);
    assert.equal(store.recover(), false); assert.equal(JSON.stringify(settings.get()), before); assert.equal(fs.readFileSync(vaultPath(dir), 'utf8'), encrypted);
  }
  const { dir, vault, settings } = await transactionFixture(t); fs.mkdirSync(journalPath(dir));
  const store = createMobileSecrets(dir, { vault, settings }); assert.throws(() => store.assertReady(), safeUnavailable); assert.equal(store.recover(), false);
});
test('locked or authenticated-corrupt journal before-images block all recovery and preserve journal across reopen', async t => {
  const { dir, vault, settings } = await transactionFixture(t), before = beforeImage(dir, settings);
  writeJson(journalPath(dir), before); settings.update(nextMobile);
  const locked = createMobileSecrets(dir, { vault: { canOpen: () => false, sealEnabled: () => true }, settings });
  assert.equal(locked.recover(), false); assert.throws(() => locked.assertReady(), safeUnavailable);
  assert.equal(settings.get().mobileFixedUrl, nextMobile.mobileFixedUrl); assert.equal(fs.existsSync(journalPath(dir)), true);
  const payload = Buffer.from(before.secret.tunnelToken.slice('enc:v1:'.length), 'base64'); payload[payload.length - 1] ^= 1;
  before.secret.tunnelToken = 'enc:v1:' + payload.toString('base64'); writeJson(journalPath(dir), before);
  const corrupt = createMobileSecrets(dir, { vault, settings });
  assert.equal(corrupt.recover(), false); assert.throws(() => corrupt.token(), safeUnavailable);
  assert.equal(settings.get().mobileFixedUrl, nextMobile.mobileFixedUrl); assert.equal(fs.existsSync(journalPath(dir)), true);
  const again = createMobileSecrets(dir, { vault, settings }); assert.throws(() => again.assertReady(), safeUnavailable);
});

test('pending journal blocks real application quick fixed manual automatic and legacy settings entry points until recovery', async t => {
  const { dir, vault, settings } = await transactionFixture(t);
  writeJson(journalPath(dir), { version: 1, settings: priorMobile, secret: JSON.parse(fs.readFileSync(vaultPath(dir), 'utf8')) });
  const file = vaultPath(dir), original = fs.readFileSync(file); fs.unlinkSync(file); fs.mkdirSync(file);
  const app = await createApplication({ rootDir: path.resolve(__dirname, '../..'), dataDir: dir, testMode: true, mobileVault: vault });
  t.after(() => app.close('journal fixture'));
  assert.equal(app.mobile.snapshot().fixedAuth, null); assert.equal(app.mobile.snapshot().tunnelTokenConfigured, true);
  for (const input of [{ tunnelToken: '' }, { autoStart: true }, { tunnelToken: NEXT }, { clearTunnelToken: true }]) assert.throws(() => app.configureMobile(input), safeUnavailable);
  await assert.rejects(() => app.configure({ mobileMode: 'quick' }), safeUnavailable);
  assert.match((await app.mobile.start()).lastError, /凭据暂不可用/);
  const before = settings.get(); settings.update({ mobileMode: 'quick', mobileAutoStart: true });
  // The manager shares app.settings, so exercise automatic entry with its in-memory quick setting.
  app.settings.update({ mobileMode: 'quick', mobileAutoStart: true });
  assert.match((await app.mobile.onAgStart()).lastError, /凭据暂不可用/);
  assert.match((await app.mobile.start()).lastError, /凭据暂不可用/);
  fs.rmdirSync(file); fs.writeFileSync(file, original);
  const restored = createSettings(path.join(dir, 'settings.json'));
  assert.equal(createMobileSecrets(dir, { vault, settings: restored }).token(), TOKEN);
  assert.equal(restored.get().mobileMode, before.mobileMode); assert.equal(restored.get().mobileAutoStart, before.mobileAutoStart);
});
