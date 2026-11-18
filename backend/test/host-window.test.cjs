'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../desktop/host.js'), 'utf8');
function fixture(testMode = false) {
  const calls = [], logs = [];
  const child = new EventEmitter();
  let unreferenced = false;
  child.unref = () => { unreferenced = true; };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: { platform: 'win32' }, require(name) {
    assert.equal(name, 'node:child_process');
    return { spawn(command, args, options) {
      calls.push({ command, args: Array.from(args), options: { ...options } });
      return child;
    } };
  } });
  const host = module.exports.createHost({ testMode, events: { log: (...args) => logs.push(args) } });
  return { child, calls, logs, host, isUnreferenced: () => unreferenced };
}

test('independent host opens a file through the system opener, without a shell or window helper', () => {
  const h = fixture();
  const file = 'C:/syn thetic/folder (test)/file.txt';
  h.host.hide();
  assert.equal(h.calls.length, 0);
  h.host.open(file);
  assert.deepEqual(h.calls, [{ command: 'explorer.exe', args: [file],
    options: { detached: true, stdio: 'ignore', windowsHide: true } }]);
  assert.equal(h.isUnreferenced(), true);
  h.child.emit('error', new Error('synthetic open failure'));
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0][2], 'tag-warn');
});

test('test host does not invoke any system opener', () => {
  const h = fixture(true);
  h.host.open('http://127.0.0.1:19823');
  assert.equal(h.calls.length, 0);
});
