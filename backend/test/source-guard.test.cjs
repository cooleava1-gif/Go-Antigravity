const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSourceGuard, newestSourceMtime } = require('../features/source-guard');

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-antigravity-guard-test-'));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows lock */ } });
  for (const name of ['core', 'ui']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core', 'a.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(dir, 'ui', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  return dir;
}

test('启动后源码未改动时不上报漂移', () => {
  const root = tempRoot();
  const guard = createSourceGuard({ rootDir: root, ttlMs: 0 });
  assert.ok(guard.bootedMtime > 0);
  assert.equal(guard.check().changed, false);
});

test('源码在启动后被修改时上报漂移', () => {
  const root = tempRoot();
  const guard = createSourceGuard({ rootDir: root, ttlMs: 0 });
  const file = path.join(root, 'core', 'a.js');
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(file, 'module.exports = 2;');
  fs.utimesSync(file, future, future);

  assert.equal(guard.check().changed, true);
  assert.ok(newestSourceMtime(root) > guard.bootedMtime);
});

test('归档目录、备份文件与 node_modules 不参与漂移判断', () => {
  const root = tempRoot();
  const base = newestSourceMtime(root);
  for (const dir of ['_attic', 'node_modules', '.git']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const file = path.join(root, dir, 'old.js');
    fs.writeFileSync(file, 'x');
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);
  }
  fs.writeFileSync(path.join(root, 'core', 'a.js.bak-20260101'), 'x');

  assert.equal(newestSourceMtime(root), base);
});
