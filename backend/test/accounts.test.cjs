const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccounts, STATE_VERSION } = require('../core/accounts');
const { createVault } = require('../core/vault');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyag-accounts-test-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } });
  return dir;
}

const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
const backups = dir => fs.readdirSync(dir).filter(name => name.startsWith('accounts.bak-'));

test('备份独占写入被拒时恢复显式失败且原文件逐字节保留', t => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  const raw = Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x00]);
  fs.writeFileSync(file, raw);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (String(target).startsWith(path.join(dir, 'accounts.bak-'))) {
      throw Object.assign(new Error('synthetic backup denied'), { code: 'EACCES' });
    }
    return open(target, ...args);
  });
  assert.throws(() => createAccounts(dir), error => {
    assert.equal(error.code, 'ACCOUNT_BACKUP_FAILED');
    assert.equal(error.cause.code, 'EACCES');
    assert.match(error.message, /备份失败.*停止恢复/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(backups(dir), []);
});

test('迁移和同版修复在备份写入被拒后同样保留原文件', t => {
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (path.basename(String(target)).startsWith('accounts.bak-')) {
      throw Object.assign(new Error('synthetic backup denied'), { code: 'EACCES' });
    }
    return open(target, ...args);
  });
  const cases = [
    JSON.stringify({ version: 1, items: [{ refreshToken: 'synthetic-legacy' }] }),
    JSON.stringify({ version: STATE_VERSION, accounts: [{ name: 'missing-token' }], activeId: null }),
    '  \r\n'
  ];
  for (const raw of cases) {
    const dir = tempDir();
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, raw);
    assert.throws(() => createAccounts(dir), { code: 'ACCOUNT_BACKUP_FAILED' });
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(backups(dir), []);
  }
});

test('备份 fsync 失败时拒绝覆盖原文且不留下伪完成备份', t => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  const raw = '{ truncated-original';
  fs.writeFileSync(file, raw);
  t.mock.method(fs, 'fsyncSync', () => { throw Object.assign(new Error('synthetic flush failure'), { code: 'EIO' }); });
  assert.throws(() => createAccounts(dir), { code: 'ACCOUNT_BACKUP_FAILED' });
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.deepEqual(backups(dir), []);
});

test('同一毫秒重复恢复各自保存原文且先刷盘再覆盖', t => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  const RealDate = Date;
  t.mock.method(global, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-11-17T10:00:00.123Z'])); }
  });
  const rawFiles = [Buffer.from('broken-first'), Buffer.from([0xff, 0x7b, 0x22, 0x00])];
  const events = [];
  const open = fs.openSync;
  const fsync = fs.fsyncSync;
  const rename = fs.renameSync;
  const backupDescriptors = new Set();
  t.mock.method(fs, 'openSync', (target, flags, mode) => {
    const descriptor = open(target, flags, mode);
    if (flags !== 'r' && String(target).startsWith(path.join(dir, 'accounts.bak-'))) {
      assert.equal(flags, 'wx');
      assert.equal(mode, 0o600);
      backupDescriptors.add(descriptor);
    }
    return descriptor;
  });
  t.mock.method(fs, 'fsyncSync', descriptor => {
    if (backupDescriptors.delete(descriptor)) events.push('backup-flushed');
    return fsync(descriptor);
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) events.push('state-replaced');
    return rename(from, to);
  });
  for (const raw of rawFiles) {
    fs.writeFileSync(file, raw);
    createAccounts(dir);
  }
  const names = backups(dir);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  const originals = names.map(name => fs.readFileSync(path.join(dir, name)).toString('hex')).sort();
  assert.deepEqual(originals, rawFiles.map(raw => raw.toString('hex')).sort());
  assert.deepEqual(events, ['backup-flushed', 'state-replaced', 'backup-flushed', 'state-replaced']);
});

test('新旧备份格式共同滚动保留五份且不删人工备份', () => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  const old = new Date(Date.now() - 10_000);
  for (let i = 0; i < 5; i++) {
    const backup = path.join(dir, `accounts.bak-20200101-00000${i}.json`);
    fs.writeFileSync(backup, `legacy-${i}`);
    fs.utimesSync(backup, old, old);
  }
  const manual = path.join(dir, 'accounts.bak-manual.json');
  fs.writeFileSync(manual, 'keep-manual');
  for (let i = 0; i < 7; i++) {
    const raw = `broken-${i}`;
    fs.writeFileSync(file, raw);
    createAccounts(dir);
    const managed = backups(dir).filter(name => name !== path.basename(manual));
    assert.equal(managed.length, 5);
    assert.ok(managed.some(name => fs.readFileSync(path.join(dir, name), 'utf8') === raw));
  }
  assert.equal(fs.readFileSync(manual, 'utf8'), 'keep-manual');
});

test('已有账户池读取失败时显式报错而非允许后续空池覆盖', t => {
  const dir = tempDir();
  const file = path.join(dir, 'accounts.json');
  const raw = '{ original-unreadable';
  fs.writeFileSync(file, raw);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('synthetic unreadable pool'), { code: 'EACCES' });
    return read(target, ...args);
  });
  assert.throws(() => createAccounts(dir), { code: 'EACCES' });
  assert.equal(read(file, 'utf8'), raw);
});

test('重新加载正常池不备份不重写', t => {
  const dir = tempDir();
  createAccounts(dir).upsert({ email: 'stable@example.com', refreshToken: 'synthetic-stable', accessToken: 'synthetic-access' });
  const raw = fs.readFileSync(path.join(dir, 'accounts.json'));
  t.mock.method(fs, 'renameSync', () => { throw new Error('normal reload must not save'); });
  assert.equal(createAccounts(dir).all().length, 1);
  assert.deepEqual(backups(dir), []);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'accounts.json')), raw);
});

test('替换 refresh 时废弃旧 access、过期时间、client、quota 和错误状态', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const before = accounts.upsert({ email: 'replace@example.com', refreshToken: 'old-refresh', accessToken: 'old-valid-access',
    expiryTs: Date.now() + 3600_000, clientType: 'old-client', quota: { tier: 'OLD', remaining: 80 } });
  accounts.markStatus(before.id, { status: 'expired', error: 'old invalid_grant' });
  before.locked = true;
  const revision = accounts.credentialRevision(before.id);
  const after = accounts.upsert({ email: 'REPLACE@example.com', refreshToken: 'new-refresh', status: 'pending' });
  assert.equal(after.id, before.id);
  assert.equal(after.accessToken, '');
  assert.equal(after.expiryTs, 0);
  assert.equal(after.clientType, null);
  assert.equal(after.quota, null);
  assert.equal(after.tier, null);
  assert.equal(after.status, 'pending');
  assert.equal(after.lastError, null);
  assert.equal(after.lastErrorAt, null);
  assert.equal(after.locked, false);
  assert.ok(accounts.credentialRevision(after.id) > revision);
  const reloaded = createAccounts(dir).find(after.id);
  assert.equal(reloaded.accessToken, '');
  assert.equal(reloaded.refreshToken, 'new-refresh');
  assert.equal(reloaded.quota, null);
});

test('新完整授权保留新 token/client/quota；refresh-only update 同样清缓存', () => {
  const accounts = createAccounts(tempDir());
  const created = accounts.upsert({ email: 'full@example.com', refreshToken: 'old-refresh', accessToken: 'old-access', expiryTs: 100,
    clientType: 'old-client', quota: { tier: 'OLD' } });
  const updated = accounts.upsert({ id: created.id, refreshToken: 'new-refresh', accessToken: 'new-access', expiryTs: 200,
    clientType: 'new-client', quota: { tier: 'NEW' } });
  assert.equal(updated.accessToken, 'new-access');
  assert.equal(updated.expiryTs, 200);
  assert.equal(updated.clientType, 'new-client');
  assert.deepEqual(updated.quota, { tier: 'NEW' });
  assert.equal(updated.tier, 'NEW');
  accounts.updateTokens(updated.id, { refreshToken: 'third-refresh' });
  assert.equal(updated.accessToken, '');
  assert.equal(updated.expiryTs, 0);
  assert.equal(updated.clientType, null);
  assert.equal(updated.quota, null);
  assert.equal(updated.status, 'pending');
});

test('已验证完整 refresh 轮换保留上次配额、tier 和账户状态', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const quota = { tier: 'PRO', updatedAt: 123, remaining: 55 };
  const first = accounts.upsert({ email: 'rotation@example.com', refreshToken: 'old-refresh', accessToken: 'old-access',
    expiryTs: 100, clientType: 'known-client', quota, status: 'ok' });
  const before = accounts.credentialRevision(first.id);
  accounts.updateTokens(first.id, { refreshToken: 'rotated-refresh', accessToken: 'validated-new-access', expiryTs: 200 });
  assert.equal(first.refreshToken, 'rotated-refresh');
  assert.equal(first.accessToken, 'validated-new-access');
  assert.equal(first.expiryTs, 200);
  assert.equal(first.clientType, 'known-client');
  assert.deepEqual(first.quota, quota);
  assert.equal(first.tier, 'PRO');
  assert.equal(first.status, 'ok');
  assert.ok(accounts.credentialRevision(first.id) > before);
  const reloaded = createAccounts(dir).find(first.id);
  assert.deepEqual(reloaded.quota, quota);
  assert.equal(reloaded.status, 'ok');
});

test('凭据代数对相同令牌重授权与删除重建递增而 metadata 更新不变', () => {
  const accounts = createAccounts(tempDir());
  const first = accounts.upsert({ email: 'revision@example.com', refreshToken: 'same-refresh', accessToken: 'same-access' });
  const initial = accounts.credentialRevision(first.id);
  assert.equal(typeof initial, 'number');
  accounts.select(first.id);
  accounts.updateQuota(first.id, { tier: 'NEW' });
  accounts.markStatus(first.id, { status: 'pending' });
  accounts.markSwitched(first.id);
  accounts.updateTokens(first.id, { email: 'revision@example.com' });
  assert.equal(accounts.credentialRevision(first.id), initial);
  accounts.upsert({ id: first.id, refreshToken: 'same-refresh', accessToken: 'same-access' });
  const authorized = accounts.credentialRevision(first.id);
  assert.ok(authorized > initial);
  accounts.updateTokens(first.id, { accessToken: 'changed-access' });
  const changed = accounts.credentialRevision(first.id);
  assert.ok(changed > authorized);
  accounts.restoreTokens(first.id, { accessToken: 'changed-access' });
  assert.ok(accounts.credentialRevision(first.id) > changed);
  const removed = accounts.credentialRevision(first.id);
  accounts.remove(first.id);
  assert.equal(accounts.credentialRevision(first.id), null);
  const imported = accounts.upsert({ id: first.id, email: first.email, refreshToken: first.refreshToken, accessToken: first.accessToken });
  assert.ok(accounts.credentialRevision(imported.id) > removed);
  assert.equal(accounts.credentialRevision('missing-id'), null);
  assert.doesNotMatch(fs.readFileSync(accounts.file, 'utf8'), /credentialRevision/);
});

test('删除后即使重建相同 ID 和相同令牌，凭据代数也不能复用', t => {
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const crypto = require('node:crypto');
  const filename = require.resolve('../core/accounts');
  const source = fs.readFileSync(filename, 'utf8');
  const localRequire = createRequire(filename);
  const fixedId = 'synthetic-reused-id';
  const module = { exports: {} };
  const load = vm.runInThisContext(`(function(require, module, exports) {${source}\n})`, { filename });
  load(name => name === 'node:crypto' ? { ...crypto, randomUUID: () => fixedId } : localRequire(name), module, module.exports);
  const accounts = module.exports.createAccounts(tempDir());
  const before = accounts.upsert({ refreshToken: 'same-refresh', accessToken: 'same-access' });
  const revision = accounts.credentialRevision(before.id);
  accounts.remove(before.id);
  assert.equal(accounts.credentialRevision(before.id), null);
  const after = accounts.upsert({ refreshToken: 'same-refresh', accessToken: 'same-access' });
  assert.equal(after.id, before.id);
  assert.equal(after.refreshToken, before.refreshToken);
  assert.equal(after.accessToken, before.accessToken);
  assert.ok(accounts.credentialRevision(after.id) > revision);
});

test('缺少账户池文件时建立空池并落盘', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  assert.deepEqual(accounts.snapshot().items, []);
  assert.equal(readState(dir).version, STATE_VERSION);
});

test('旧版账本迁移时保留带 refresh_token 的账户，而不是清库', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [
      { id: 'a1', name: '旧账户', email: 'a@example.com', refreshToken: 'rt-1', accessToken: 'at-1', expiryTs: 111 },
      { id: 'a2', name: '档案制账户', profileDir: 'C:/profiles/a2' },
      { refreshToken: 'rt-1' }
    ],
    activeId: 'a2'
  }));
  const notices = [];
  const accounts = createAccounts(dir, { onNotice: message => notices.push(message) });

  assert.equal(accounts.all().length, 1);
  assert.equal(accounts.all()[0].refreshToken, 'rt-1');
  assert.equal(accounts.all()[0].accessToken, 'at-1');
  // 被丢弃的 activeId 必须回退到仍然存在的账户
  assert.equal(accounts.snapshot().activeId, accounts.all()[0].id);
  assert.equal(readState(dir).version, STATE_VERSION);
  assert.equal(backups(dir).length, 1);
  assert.ok(notices.some(message => message.includes('迁移')));
});

test('损坏的账本先备份再重建，不会静默丢数据', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{ "version": 2, "accounts": [');
  const notices = [];
  const accounts = createAccounts(dir, { onNotice: message => notices.push(message) });

  assert.deepEqual(accounts.all(), []);
  const saved = backups(dir);
  assert.equal(saved.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, saved[0]), 'utf8'), '{ "version": 2, "accounts": [');
  assert.ok(notices.some(message => message.includes('无法解析')));
});

test('同邮箱重新授权会更新原条目而不是新增', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const first = accounts.upsert({ email: 'A@Example.com', refreshToken: 'rt-1', accessToken: 'at-1', source: 'google' });
  const second = accounts.upsert({ email: 'a@example.com', refreshToken: 'rt-2', accessToken: 'at-2', source: 'google' });

  assert.equal(accounts.all().length, 1);
  assert.equal(first.id, second.id);
  assert.equal(accounts.find(first.id).refreshToken, 'rt-2');
  assert.equal(accounts.find(first.id).accessToken, 'at-2');
});

test('删除账户后 activeId 回落到剩余账户', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const a = accounts.upsert({ email: 'a@example.com', refreshToken: 'rt-a', select: true });
  const b = accounts.upsert({ email: 'b@example.com', refreshToken: 'rt-b' });
  assert.equal(accounts.snapshot().activeId, a.id);

  const snapshot = accounts.remove(a.id);
  assert.equal(snapshot.activeId, b.id);
  assert.equal(snapshot.items.length, 1);
});

test('restoreTokens 能无条件回滚到切换前的令牌', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const account = accounts.upsert({ email: 'a@example.com', refreshToken: 'rt-old', accessToken: 'at-old', expiryTs: 1000 });
  accounts.updateTokens(account.id, { refreshToken: 'rt-new', accessToken: 'at-new', expiryTs: 2000 });

  accounts.restoreTokens(account.id, { refreshToken: 'rt-old', accessToken: 'at-old', expiryTs: 1000 });
  const restored = accounts.find(account.id);
  assert.equal(restored.refreshToken, 'rt-old');
  assert.equal(restored.accessToken, 'at-old');
  assert.equal(restored.expiryTs, 1000);
});

test('键序不同但内容相同的账本不会被误判为需要修复', () => {
  const dir = tempDir();
  // 与落盘顺序不同的字段顺序，内容完全合法
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    activeId: 'a1',
    accounts: [{
      refreshToken: 'rt-1',
      accessToken: 'at-1',
      email: 'a@example.com',
      name: '账户甲',
      id: 'a1',
      source: 'google',
      expiryTs: 111,
      clientType: 'public',
      quota: { tier: 'PRO', updatedAt: 5 },
      tier: 'PRO',
      createdAt: 1000,
      lastSwitchedAt: null
    }],
    version: STATE_VERSION
  }));
  const notices = [];
  const accounts = createAccounts(dir, { onNotice: message => notices.push(message) });

  assert.equal(accounts.all().length, 1);
  assert.deepEqual(notices, []);
  assert.equal(backups(dir).length, 0);
});

test('markStatus 记录失效，成功刷新后清空错误', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const account = accounts.upsert({ email: 'a@example.com', refreshToken: 'rt-a' });
  assert.equal(accounts.snapshot().items[0].status, 'ok');

  accounts.markStatus(account.id, { status: 'expired', error: 'invalid_grant: Token has been expired or revoked.' });
  const expired = accounts.snapshot().items[0];
  assert.equal(expired.status, 'expired');
  assert.match(expired.lastError, /invalid_grant/);
  assert.ok(expired.lastErrorAt > 0);

  accounts.markStatus(account.id, { status: 'ok', error: null });
  const healed = accounts.snapshot().items[0];
  assert.equal(healed.status, 'ok');
  assert.equal(healed.lastError, null);
  assert.equal(healed.lastErrorAt, null);
});

test('导入的账户可以处于待校验状态', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const account = accounts.upsert({ refreshToken: 'rt-new', status: 'pending' });
  assert.equal(accounts.find(account.id).status, 'pending');
});

test('exportPool 默认脱敏，显式要求时才导出完整令牌', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  accounts.upsert({ email: 'a@example.com', name: '甲', refreshToken: '1//0gABCDEFGHIJKLMNOP', select: true });
  accounts.upsert({ email: 'b@example.com', name: '乙', refreshToken: '1//0gQRSTUVWXYZ012345' });

  const masked = accounts.exportPool();
  assert.equal(masked.accounts.length, 2);
  assert.equal(masked.accounts[0].refreshTokenMasked, true);
  assert.equal(masked.accounts[0].refreshToken, '1//0gA…MNOP');
  assert.equal(masked.accounts[0].refreshToken.includes('ABCDEFGHIJKLMNOP'), false);
  assert.equal(masked.accounts[0].email, 'a@example.com');

  const full = accounts.exportPool({ includeTokens: true });
  assert.equal(full.accounts[0].refreshToken, '1//0gABCDEFGHIJKLMNOP');
  assert.equal(full.accounts[0].refreshTokenMasked, false);
});

test('live 标记只在令牌与系统凭据一致时出现', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  const account = accounts.upsert({ email: 'a@example.com', refreshToken: 'rt-a' });

  assert.equal(accounts.snapshot('rt-a').items[0].isLive, true);
  assert.equal(accounts.snapshot('rt-other').items[0].isLive, false);
  assert.equal(accounts.snapshot(null).items[0].isLive, false);
  assert.equal(accounts.snapshot('rt-a').liveId, account.id);
});

// Every mutator must leave both live references and the next save on the old generation
// when encryption or the atomic replacement fails. Only synthetic temporary pools are used.
for (const failure of ['rename', 'seal']) {
  test(`账户写盘事务在 ${failure} 失败后恢复完整旧代际`, async t => {
    const mutations = {
      'upsert existing': (store, a) => store.upsert({ id: a.id, refreshToken: 'failed-refresh', accessToken: 'failed-access',
        expiryTs: 2000, clientType: 'failed-client', source: 'failed-source', quota: { tier: 'FAILED' }, select: true, status: 'pending' }),
      'upsert new': store => store.upsert({ email: 'failed@example.com', refreshToken: 'failed-refresh', select: true }),
      'updateTokens rotation': (store, a) => store.updateTokens(a.id, { refreshToken: 'failed-refresh', accessToken: 'failed-access',
        expiryTs: 2000, clientType: 'failed-client' }),
      'updateTokens refresh only': (store, a) => store.updateTokens(a.id, { refreshToken: 'failed-refresh' }),
      restoreTokens: (store, a) => store.restoreTokens(a.id, { refreshToken: 'failed-refresh', accessToken: '', expiryTs: 0, clientType: null }),
      updateQuota: (store, a) => store.updateQuota(a.id, { tier: 'FAILED', remaining: 99 }),
      markSwitched: (store, a) => store.markSwitched(a.id),
      markStatus: (store, a) => store.markStatus(a.id, { status: 'pending', error: 'failed metadata' }),
      select: (store, a) => store.select(a.id),
      remove: (store, a, b) => store.remove(b.id)
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      await t.test(name, async t => {
        const dir = tempDir();
        const vault = await testVault();
        let now = 100;
        t.mock.method(Date, 'now', () => now);
        const accounts = createAccounts(dir, { vault });
        const a = accounts.upsert({ email: 'stable-a@example.com', refreshToken: 'stable-refresh-a', accessToken: 'stable-access-a',
          expiryTs: 1000, clientType: 'stable-client', quota: { tier: 'PRO', remaining: 55 }, status: 'expired' });
        accounts.markStatus(a.id, { status: 'expired', error: 'old verdict' });
        accounts.markSwitched(a.id);
        const b = accounts.upsert({ email: 'stable-b@example.com', refreshToken: 'stable-refresh-b', select: true });
        const references = accounts.all();
        const before = structuredClone(references);
        const persistedBefore = createAccounts(dir, { vault }).all();
        const activeId = accounts.snapshot().activeId;
        const revisions = references.map(account => accounts.credentialRevision(account.id));
        const bytes = fs.readFileSync(accounts.file);
        now = 200;
        const failureError = Object.assign(new Error(`synthetic ${failure} denied`), { code: failure === 'rename' ? 'EACCES' : 'SYNTHETIC_SEAL_FAILED' });
        const rename = fs.renameSync;
        const seal = vault.seal;
        let sealCalls = 0;
        const fault = failure === 'rename'
          ? t.mock.method(fs, 'renameSync', (source, target) => {
            if (target === accounts.file) throw failureError;
            return rename(source, target);
          })
          : t.mock.method(vault, 'seal', value => {
            if (++sealCalls === 2) throw failureError;
            return seal(value);
          });
        assert.throws(() => mutate(accounts, a, b), error => error === failureError);
        fault.mock.restore();

        assert.deepEqual(fs.readFileSync(accounts.file), bytes, 'failed save must preserve exact previous bytes');
        assert.deepEqual(accounts.all(), before, 'all runtime fields must roll back');
        assert.equal(accounts.snapshot().activeId, activeId, 'active selection must roll back');
        references.forEach((account, index) => {
          assert.strictEqual(accounts.find(account.id), account, 'previously returned live references must survive');
          assert.deepEqual(account, before[index], 'held references must also roll back');
          assert.equal(accounts.credentialRevision(account.id), revisions[index], 'failed credential generations must roll back');
        });
        assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);

        accounts.select(a.id);
        assert.deepEqual(accounts.all(), before, 'next successful save cannot publish any failed metadata or token');
        const reloaded = createAccounts(dir, { vault });
        assert.deepEqual(reloaded.all(), persistedBefore, 'next save must persist only the previous credential generation');
        assert.equal(reloaded.snapshot().activeId, a.id);
        assert.doesNotMatch(fs.readFileSync(accounts.file, 'utf8'), /stable-refresh|stable-access|failed-refresh|failed-access/);
        const maxRevision = Math.max(...revisions);
        accounts.updateTokens(a.id, { accessToken: 'successful-access' });
        assert.strictEqual(accounts.find(a.id), a);
        assert.equal(accounts.credentialRevision(a.id), maxRevision + 1, 'failed transaction must restore the revision counter');
        assert.equal(createAccounts(dir, { vault }).find(a.id).accessToken, 'successful-access');
      });
    }
  });
}

test('缺失账户的无操作 mutators 不尝试写盘', t => {
  const accounts = createAccounts(tempDir());
  t.mock.method(fs, 'renameSync', () => { throw new Error('no-op must not save'); });
  assert.equal(accounts.restoreTokens('missing'), null);
  assert.equal(accounts.updateQuota('missing', { tier: 'FAILED' }), null);
  assert.equal(accounts.markSwitched('missing'), null);
  assert.equal(accounts.markStatus('missing'), null);
});

// ---------- 令牌加密落盘 ----------

function testVault() {
  const store = { key: require('node:crypto').randomBytes(32) };
  const vault = createVault({ readKey: async () => store.key, writeKey: async () => {} });
  return vault.unlock().then(() => vault);
}

function seedPlaintextPool(dir) {
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({
    version: STATE_VERSION,
    activeId: 'acc-1',
    accounts: [{
      id: 'acc-1',
      name: 'tester',
      email: 'tester@example.com',
      accessToken: 'ya29.PLAINACCESS',
      refreshToken: '1//PLAINREFRESH',
      expiryTs: Date.now() + 3600_000,
      source: 'manual',
      status: 'ok'
    }]
  }, null, 2), 'utf8');
}

function repairBackupFixture(layout = 'accounts') {
  return {
    version: layout === 'items' ? 1 : STATE_VERSION,
    activeId: 'original-account',
    unknownTopLevel: { keep: true, array: [null, 42, { refreshToken: 'synthetic-nested-refresh' }] },
    [layout]: [
      { id: 'original-account', name: 'Original account', refreshToken: 'synthetic-repair-refresh', accessToken: 'synthetic-repair-access',
        expiryTs: 0, createdAt: 1, lastErrorAt: 0, unknownRecord: { keep: 'original', accessToken: 'synthetic-nested-access' } },
      { id: 'duplicate-account', refreshToken: 'synthetic-repair-refresh', accessToken: 'synthetic-duplicate-access', createdAt: 2, duplicateOnly: true },
      { id: 'dropped-account', accessToken: 'synthetic-dropped-access', unknownField: ['must', 'survive'] },
      null, 'unknown-record'
    ]
  };
}

function openBackupTokens(value, vault) {
  if (Array.isArray(value)) return value.map(item => openBackupTokens(item, vault));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['accessToken', 'refreshToken'].includes(key) && vault.isEncrypted(item) ? vault.open(item) : openBackupTokens(item, vault)]));
}

for (const layout of ['accounts', 'items']) {
  test(`可解析 ${layout} 修复灾备保留所有原始字段且不新增明文令牌`, async t => {
    const dir = tempDir();
    const file = path.join(dir, 'accounts.json');
    const parsed = repairBackupFixture(layout);
    const vault = await testVault();
    parsed[layout].push({ id: 'already-sealed', refreshToken: vault.seal('synthetic-existing-encrypted'), createdAt: 3, preserveCiphertext: true });
    // JSON's own __proto__ key must survive as data, rather than mutating a clone's prototype.
    Object.defineProperty(parsed, '__proto__', { value: { accessToken: 'synthetic-proto-access' }, enumerable: true });
    const raw = '\uFEFF' + JSON.stringify(parsed, null, 1);
    fs.writeFileSync(file, raw);
    const historical = new Map();
    for (let i = 0; i < 6; i++) {
      const name = `accounts.bak-20200101-00000${i}.json`;
      const content = `historical-${i}`;
      fs.writeFileSync(path.join(dir, name), content);
      historical.set(name, content);
    }
    const events = [];
    const open = fs.openSync;
    const flush = fs.fsyncSync;
    const rename = fs.renameSync;
    const descriptors = new Set();
    t.mock.method(fs, 'openSync', (target, flags, mode) => {
      const descriptor = open(target, flags, mode);
      if (flags !== 'r' && String(target).startsWith(path.join(dir, 'accounts.bak-'))) {
        assert.equal(flags, 'wx');
        assert.equal(mode, 0o600);
        descriptors.add(descriptor);
      }
      return descriptor;
    });
    t.mock.method(fs, 'fsyncSync', descriptor => {
      if (descriptors.delete(descriptor)) events.push('backup-flushed');
      return flush(descriptor);
    });
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === file) events.push('state-replaced');
      return rename(from, to);
    });
    const accounts = createAccounts(dir, { vault });
    assert.equal(accounts.find('original-account').refreshToken, 'synthetic-repair-refresh');
    assert.equal(accounts.find('dropped-account'), null);
    if (layout === 'items') assert.equal(accounts.find('duplicate-account'), null);
    const added = backups(dir).filter(name => !historical.has(name));
    assert.equal(added.length, 1);
    for (const [name, content] of historical) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), content);
    const backupRaw = fs.readFileSync(path.join(dir, added[0]), 'utf8');
    assert.doesNotMatch(backupRaw, /synthetic-/);
    const backup = JSON.parse(backupRaw);
    assert.equal(backup[layout][5].refreshToken, parsed[layout][5].refreshToken, 'existing ciphertext is not resealed');
    const expected = structuredClone(parsed);
    expected[layout][5].refreshToken = 'synthetic-existing-encrypted';
    assert.deepEqual(openBackupTokens(backup, vault), expected, 'decrypting backup recovers every original key, record and field');
    assert.deepEqual(events, ['backup-flushed', 'state-replaced']);

    // The encrypted pre-repair snapshot remains directly consumable by production recovery.
    const restoredDir = tempDir();
    fs.writeFileSync(path.join(restoredDir, 'accounts.json'), backupRaw);
    const restored = createAccounts(restoredDir, { vault });
    assert.deepEqual(restored.all(), createAccounts(dir, { vault }).all());
  });
}

test('可解析灾备密封或写备份失败保持原文件且恢复后可重试', async t => {
  for (const layout of ['accounts', 'items']) {
    for (const stage of ['seal', 'backup-open', 'backup-write', 'backup-flush', 'pool-seal', 'pool-rename']) {
      await t.test(`${layout} ${stage}`, async t => {
        const dir = tempDir();
        const file = path.join(dir, 'accounts.json');
        const raw = '\uFEFF' + JSON.stringify(repairBackupFixture(layout), null, 1);
        fs.writeFileSync(file, raw);
        const historical = path.join(dir, 'accounts.bak-manual.json');
        fs.writeFileSync(historical, 'existing-backup');
        const vault = await testVault();
        const failure = Object.assign(new Error(`synthetic ${stage} failure`), { code: 'EACCES' });
        const descriptors = new Set();
        const open = fs.openSync;
        const write = fs.writeFileSync;
        const flush = fs.fsyncSync;
        const rename = fs.renameSync;
        const seal = vault.seal;
        let sealed = 0;
        let backupFlushed = false;
        const mocks = [
          t.mock.method(vault, 'seal', value => {
            if ((stage === 'seal' && ++sealed === 2) || (stage === 'pool-seal' && backupFlushed)) throw failure;
            return seal(value);
          }),
          t.mock.method(fs, 'openSync', (target, flags, mode) => {
            const backup = String(target).startsWith(path.join(dir, 'accounts.bak-'));
            if (backup && stage === 'backup-open') throw failure;
            const descriptor = open(target, flags, mode);
            if (backup) descriptors.add(descriptor);
            return descriptor;
          }),
          t.mock.method(fs, 'writeFileSync', (target, ...args) => {
            if (descriptors.has(target) && stage === 'backup-write') throw failure;
            return write(target, ...args);
          }),
          t.mock.method(fs, 'fsyncSync', descriptor => {
            const backup = descriptors.delete(descriptor);
            if (backup && stage === 'backup-flush') throw failure;
            const result = flush(descriptor);
            if (backup) backupFlushed = true;
            return result;
          }),
          t.mock.method(fs, 'renameSync', (from, to) => {
            if (to === file && stage === 'pool-rename') throw failure;
            return rename(from, to);
          })
        ];
        const completedBackup = stage === 'pool-seal' || stage === 'pool-rename';
        assert.throws(() => createAccounts(dir, { vault }), error => completedBackup
          ? error === failure : error.code === 'ACCOUNT_BACKUP_FAILED' && error.cause === failure);
        for (const mock of mocks) mock.mock.restore();
        assert.equal(fs.readFileSync(file, 'utf8'), raw, 'original bytes including BOM stay untouched');
        assert.equal(fs.readFileSync(historical, 'utf8'), 'existing-backup');
        assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
        const added = backups(dir).filter(name => name !== path.basename(historical));
        assert.equal(added.length, completedBackup ? 1 : 0);
        for (const name of added) assert.doesNotMatch(fs.readFileSync(path.join(dir, name), 'utf8'), /synthetic-/);
        const retried = createAccounts(dir, { vault });
        assert.equal(retried.find('original-account').refreshToken, 'synthetic-repair-refresh');
        for (const name of backups(dir).filter(name => name !== path.basename(historical))) {
          assert.doesNotMatch(fs.readFileSync(path.join(dir, name), 'utf8'), /synthetic-/);
        }
      });
    }
  }
});

test('缺 vault、锁库或 JSON 不可解析时保留原始逐字节灾备', async t => {
  for (const mode of ['no-vault', 'locked', 'invalid-json']) {
    await t.test(mode, async () => {
      const dir = tempDir();
      const raw = mode === 'invalid-json' ? Buffer.from([0xff, 0x7b, 0x22, 0x00])
        : Buffer.from('\uFEFF' + JSON.stringify(repairBackupFixture()));
      fs.writeFileSync(path.join(dir, 'accounts.json'), raw);
      const vault = mode === 'locked' ? createVault({ readKey: async () => { throw new Error('synthetic locked'); }, writeKey: async () => {} })
        : mode === 'invalid-json' ? await testVault() : null;
      if (mode === 'locked') await vault.unlock();
      createAccounts(dir, { vault });
      assert.equal(backups(dir).length, 1);
      assert.deepEqual(fs.readFileSync(path.join(dir, backups(dir)[0])), raw);
    });
  }
});

test('正常已加密池重载无需新备份也不重写密文', async t => {
  const dir = tempDir();
  const vault = await testVault();
  const accounts = createAccounts(dir, { vault });
  accounts.upsert({ refreshToken: 'synthetic-normal-refresh', accessToken: 'synthetic-normal-access' });
  const raw = fs.readFileSync(accounts.file);
  t.mock.method(vault, 'seal', () => { throw new Error('normal reload must not seal'); });
  t.mock.method(fs, 'renameSync', () => { throw new Error('normal reload must not save'); });
  assert.equal(createAccounts(dir, { vault }).all().length, 1);
  assert.deepEqual(backups(dir), []);
  assert.deepEqual(fs.readFileSync(accounts.file), raw);
});

test('明文账户池在首次加载时自动加密，文件里再也看不到令牌', async () => {
  const dir = tempDir();
  seedPlaintextPool(dir);
  const vault = await testVault();
  const notices = [];
  const accounts = createAccounts(dir, { vault, onNotice: message => notices.push(message) });

  assert.equal(accounts.active().refreshToken, '1//PLAINREFRESH', '内存里仍然是明文');
  const onDisk = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.doesNotMatch(onDisk, /PLAINREFRESH/);
  assert.doesNotMatch(onDisk, /PLAINACCESS/);
  assert.match(onDisk, /enc:v1:/);
  assert.ok(notices.some(message => message.includes('本地加密存储')), notices.join(' | '));
  // 升级过程不该留下明文备份
  assert.deepEqual(backups(dir), []);
});

test('内存里被改写的令牌会以密文落盘，重新加载后仍是明文', async () => {
  const dir = tempDir();
  const vault = await testVault();
  const first = createAccounts(dir, { vault });
  const created = first.upsert({ name: 'a', email: 'a@example.com', refreshToken: '1//NEWTOKEN', accessToken: 'ya29.NEWACCESS', status: 'ok' });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), /NEWTOKEN/);

  const second = createAccounts(dir, { vault });
  const reloaded = second.find(created.id);
  assert.equal(reloaded.refreshToken, '1//NEWTOKEN');
  assert.equal(reloaded.accessToken, 'ya29.NEWACCESS');
  assert.equal(reloaded.locked, false);
});

test('主密钥缺失时账户不被丢弃，而是标为需重新授权', async () => {
  const dir = tempDir();
  const vault = await testVault();
  createAccounts(dir, { vault }).upsert({ name: 'keep-me', email: 'keep@example.com', refreshToken: '1//LOCKED', status: 'ok' });

  const notices = [];
  const broken = createVault({
    readKey: async () => { throw new Error('凭据管理器不可用'); },
    writeKey: async () => {}
  });
  await broken.unlock();
  const accounts = createAccounts(dir, { vault: broken, onNotice: message => notices.push(message) });

  const items = accounts.snapshot().items;
  assert.equal(items.length, 1, '解不开也必须保住记录');
  assert.equal(items[0].status, 'expired');
  assert.equal(items[0].locked, true);
  assert.match(items[0].lastError, /无法解密/);
  assert.ok(notices.length > 0, '要告诉用户为什么');
});

test('重新授权后 locked 标记会被清除', async () => {
  const dir = tempDir();
  const vault = await testVault();
  const accounts = createAccounts(dir, { vault });
  const created = accounts.upsert({ name: 'a', refreshToken: '1//OLD', status: 'ok' });
  const locked = accounts.find(created.id);
  locked.locked = true;
  locked.status = 'expired';

  accounts.upsert({ id: created.id, name: 'a', refreshToken: '1//FRESH', status: 'ok' });
  const after = accounts.find(created.id);
  assert.equal(after.locked, false);
  assert.equal(after.status, 'ok');
  assert.equal(after.refreshToken, '1//FRESH');
});

test('没有 vault 时保持明文行为（测试/非 Windows 环境）', () => {
  const dir = tempDir();
  const accounts = createAccounts(dir);
  accounts.upsert({ name: 'a', refreshToken: '1//PLAIN', status: 'ok' });
  assert.match(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), /1\/\/PLAIN/);
});

test('locked 只是运行时状态：不落盘，密钥恢复后账户回到原本状态', async () => {
  const dir = tempDir();
  const vault = await testVault();
  createAccounts(dir, { vault }).upsert({ name: 'a', email: 'a@example.com', refreshToken: '1//KEEP', status: 'ok' });

  const broken = createVault({ readKey: async () => { throw new Error('密钥不可用'); }, writeKey: async () => {} });
  await broken.unlock();
  const lockedRun = createAccounts(dir, { vault: broken });
  assert.equal(lockedRun.snapshot().items[0].status, 'expired', '本运行时表现为需重新授权');
  assert.equal(lockedRun.snapshot().items[0].locked, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), /"locked"/, 'locked 不能写进文件');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), /"status": "expired"/, '也不能把 expired 写死');

  const healed = createAccounts(dir, { vault });
  const item = healed.snapshot().items[0];
  assert.equal(item.locked, false);
  assert.equal(item.status, 'ok', '密钥回来以后必须自动恢复');
  assert.equal(healed.active().refreshToken, '1//KEEP');
});
