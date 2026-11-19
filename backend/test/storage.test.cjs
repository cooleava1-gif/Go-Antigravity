const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readJson, writeJson } = require('../core/storage');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-storage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function temporary(file, owner = 2147483001) {
  return `${file}.${owner}.${randomUUID()}.tmp`;
}

function seed(file, ageMs = 48 * 3600_000) {
  fs.writeFileSync(file, 'synthetic-leftover');
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(file, time, time);
  return file;
}

function missingOwner() {
  throw Object.assign(new Error('synthetic missing owner'), { code: 'ESRCH' });
}

test('atomic JSON saves flush before rename and reload their full value', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const events = [];
  const flush = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', descriptor => { events.push('flush'); return flush(descriptor); });
  t.mock.method(fs, 'renameSync', (from, to) => { events.push('rename'); return rename(from, to); });
  writeJson(file, { values: [1, 2], label: 'synthetic' });
  assert.deepEqual(events, ['flush', 'rename']);
  assert.deepEqual(readJson(file), { values: [1, 2], label: 'synthetic' });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('failed serialization, flush, or rename preserves the original and cleans owned temporary files', async t => {
  for (const stage of ['serialize', 'flush', 'rename']) {
    await t.test(stage, t => {
      const dir = tempDir(t);
      const file = path.join(dir, 'state.json');
      fs.writeFileSync(file, '{"original":true}');
      const cyclic = {};
      cyclic.self = cyclic;
      if (stage === 'flush') t.mock.method(fs, 'fsyncSync', () => { throw new Error('synthetic flush failed'); });
      if (stage === 'rename') t.mock.method(fs, 'renameSync', () => { throw new Error('synthetic rename failed'); });
      assert.throws(() => writeJson(file, stage === 'serialize' ? cyclic : { changed: true }));
      assert.equal(fs.readFileSync(file, 'utf8'), '{"original":true}');
      assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    });
  }
});

test('exclusive-open collision never deletes the file whose ownership was not acquired', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"original":true}');
  const open = fs.openSync;
  let collision;
  t.mock.method(fs, 'openSync', (target, flags, mode) => {
    if (String(target).startsWith(`${file}.`) && flags === 'wx') {
      collision = String(target);
      const descriptor = open(target, 'w', mode);
      fs.writeFileSync(descriptor, 'belongs-to-other-writer');
      fs.closeSync(descriptor);
      throw Object.assign(new Error('synthetic collision'), { code: 'EEXIST' });
    }
    return open(target, flags, mode);
  });
  assert.throws(() => writeJson(file, { changed: true }), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(collision, 'utf8'), 'belongs-to-other-writer');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"original":true}');
});

test('next write reclaims only old exact-name files owned by a demonstrably exited process', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.[1]+.json');
  const abandoned = seed(temporary(file));
  const fresh = seed(temporary(file), 60_000);
  const active = seed(temporary(file, 2147483002));
  const unknown = seed(temporary(file, 2147483003));
  const denied = seed(temporary(file, 2147483004));
  const self = seed(temporary(file, process.pid));
  const legacy = seed(`${file}.${randomUUID()}.tmp`);
  const foreign = seed(`${file}.manual.tmp`);
  const otherTarget = seed(temporary(path.join(dir, 'state.X1++.json')));
  const manualBackup = seed(`${file}.bak`);
  const invalidOwner = seed(temporary(file, 9999999999));
  const directory = temporary(file);
  fs.mkdirSync(directory);
  const old = new Date(Date.now() - 48 * 3600_000);
  fs.utimesSync(directory, old, old);
  const probes = [];
  t.mock.method(process, 'kill', (owner, signal) => {
    probes.push([owner, signal]);
    if (owner === 2147483002) return true;
    if (owner === 2147483003) throw new Error('synthetic unknown process state');
    if (owner === 2147483004) throw Object.assign(new Error('synthetic denied process state'), { code: 'EPERM' });
    return missingOwner();
  });
  writeJson(file, { next: true });
  assert.equal(fs.existsSync(abandoned), false);
  for (const kept of [fresh, active, unknown, denied, self, legacy, foreign, otherTarget, manualBackup, invalidOwner, directory]) {
    assert.equal(fs.existsSync(kept), true, kept);
  }
  assert.deepEqual(probes.map(item => item[0]).sort(), [2147483001, 2147483002, 2147483003, 2147483004]);
  assert.ok(probes.every(item => item[1] === 0));
  assert.deepEqual(readJson(file), { next: true });
});

test('symlink-like entries and differently cased foreign targets are not cleanup candidates', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const linkLike = seed(temporary(file));
  const foreign = seed(temporary(path.join(dir, 'STATE.JSON')));
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (target === linkLike) return { isFile: () => false };
    return lstat(target, ...args);
  });
  t.mock.method(process, 'kill', () => { throw new Error('excluded entry must not reach owner probe'); });
  writeJson(file, { next: true });
  assert.equal(fs.existsSync(linkLike), true);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(process.kill.mock.calls.length, 0);
});

test('modified leftover is retained if another writer changes it during the owner check', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const candidate = seed(temporary(file));
  t.mock.method(process, 'kill', () => {
    fs.writeFileSync(candidate, 'changed-by-another-writer');
    return missingOwner();
  });
  writeJson(file, { next: true });
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'changed-by-another-writer');
});

test('cleanup I/O failure does not prevent a new atomic save', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const candidate = seed(temporary(file));
  t.mock.method(process, 'kill', missingOwner);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', target => {
    if (target === candidate) throw Object.assign(new Error('synthetic cleanup denied'), { code: 'EACCES' });
    return unlink(target);
  });
  writeJson(file, { next: true });
  assert.equal(fs.existsSync(candidate), true);
  assert.deepEqual(readJson(file), { next: true });
});

test('readJson preserves fallback and BOM semantics', t => {
  const file = path.join(tempDir(t), 'state.json');
  assert.deepEqual(readJson(file, { absent: true }), { absent: true });
  fs.writeFileSync(file, '\uFEFF{"ready":true}');
  assert.deepEqual(readJson(file), { ready: true });
  fs.writeFileSync(file, 'broken');
  assert.throws(() => readJson(file));
});
