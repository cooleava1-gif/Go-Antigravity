'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../desktop/host.js'), 'utf8');
const helper = readFileSync(path.join(__dirname, '../desktop/window-layout.ps1'), 'utf8');
function harness(options = {}) {
  const calls = [], logs = [], writes = [], timers = new Set();
  const processInfo = { platform: 'win32', pid: 4100, ppid: 3100,
    execPath: 'D:\\Portable Folder\\easyag-node.exe', env: { SystemRoot: 'C:\\Windows' },
    stdout: { write: value => writes.push(value) }, ...options.process };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, __dirname: 'D:\\overlay\\desktop', process: processInfo,
    Promise, setTimeout(fn, ms) { const timer = { fn, ms, unref() { this.unrefed = true; } }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    require(name) {
      if (name !== 'node:child_process') return require(name);
      return { spawn(file, args, config) {
        calls.push({ file, args: Array.from(args), config });
        if (options.throwSpawn) throw new Error('secret raw spawn failure');
        const child = new EventEmitter();
        child.exitCode = null; child.signalCode = null; child.kills = 0;
        child.kill = () => { child.kills++; return true; };
        child.unref = () => { child.unrefed = true; };
        child.exit = (code = 0) => { child.exitCode = code; child.emit('exit', code, null); };
        child.close = (code = 0) => { child.exitCode = code; child.emit('close', code, null); };
        calls[calls.length - 1].child = child; return child;
      } };
    }
  }, { filename: 'host.js' });
  const host = module.exports.createHost({ native: true, testMode: false,
    events: { log: (...args) => logs.push(args) }, ...options.host });
  return { host, calls, logs, writes, timers, processInfo };
}

test('resize is gated to Windows native mode outside tests', async () => {
  for (const options of [{ host: { native: false } }, { host: { testMode: true } },
    { process: { platform: 'darwin' } }, { process: { platform: 'linux' } }]) {
    const h = harness(options); assert.equal(await h.host.resizeWindow(), false); assert.equal(h.calls.length, 0);
  }
});

test('invalid captured identities and nonabsolute runtime paths fail before spawn', async () => {
  for (const process of [{ pid: 0 }, { ppid: -1 }, { ppid: 1.1 }, { ppid: '3100' }, { ppid: 4100 },
    { pid: Number.MAX_SAFE_INTEGER + 1 }, { execPath: 'easyag-node.exe' }, { env: {} }, { env: { SystemRoot: 'Windows' } }]) {
    const h = harness({ process }); assert.equal(await h.host.resizeWindow(), false); assert.equal(h.calls.length, 0);
  }
});

test('resize passes exact captured identities and packaged shell path without a shell', async () => {
  const h = harness();
  // Later changes cannot redirect the captured parent or immutable executable directory.
  h.processInfo.ppid = 9999; h.processInfo.execPath = 'D:\\other\\node.exe';
  const pending = h.host.resizeWindow(); const call = h.calls[0];
  assert.equal(call.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join('D:\\overlay\\desktop', 'window-layout.ps1'), '-BackendPid', '4100', '-ParentPid', '3100',
    '-ExpectedPath', 'D:\\Portable Folder\\Starbridge.exe']);
  assert.equal(call.config.shell, false); assert.equal(call.config.windowsHide, true); assert.equal(call.config.stdio, 'ignore');
  assert.equal(call.config.detached, undefined); assert.equal(call.child.unrefed, true);
  const timer = [...h.timers][0]; assert.equal(timer.ms, 10000); assert.equal(timer.unrefed, true);
  call.child.close(0); assert.equal(await pending, true); assert.equal(h.timers.size, 0);
  assert.equal(h.writes.length, 0); assert.equal(h.logs.length, 0);
});

test('path punctuation is passed as an argument and never interpolated into source', async () => {
  const h = harness({ process: { execPath: 'D:\\portable $(&) folder\\easyag-node.exe' } });
  const pending = h.host.resizeWindow(); const call = h.calls[0];
  assert.equal(call.args.at(-1), 'D:\\portable $(&) folder\\Starbridge.exe');
  assert.equal(call.args.includes('-Command'), false); call.child.close(0); assert.equal(await pending, true);
});

test('resize shares a single task and never restarts after completion or failure', async () => {
  for (const code of [0, 1]) {
    const h = harness(); const first = h.host.resizeWindow(); const second = h.host.resizeWindow();
    assert.equal(first, second); assert.equal(h.calls.length, 1); h.calls[0].child.close(code);
    assert.equal(await first, code === 0); assert.equal(await h.host.resizeWindow(), code === 0); assert.equal(h.calls.length, 1);
  }
});

test('spawn failure and raw helper errors only produce a canned diagnostic', async () => {
  const thrown = harness({ throwSpawn: true }); assert.equal(await thrown.host.resizeWindow(), false);
  const h = harness(); const pending = h.host.resizeWindow();
  h.calls[0].child.emit('error', new Error('secret raw child diagnostics'));
  assert.equal(await pending, false); assert.equal(h.calls[0].child.kills, 1);
  h.calls[0].child.close(1); assert.equal(h.logs.length, 1); assert.equal(h.timers.size, 0);
  assert.doesNotMatch(JSON.stringify([thrown.logs, h.logs, h.writes]), /secret|diagnostics|Portable Folder/);
});

test('hard deadline cancels only the live helper once and ignores late success', async () => {
  const h = harness(); const pending = h.host.resizeWindow(); const child = h.calls[0].child;
  [...h.timers][0].fn(); assert.equal(await pending, false); assert.equal(child.kills, 1); assert.equal(h.timers.size, 0);
  child.close(0); h.host.dispose(); assert.equal(child.kills, 1); assert.equal(h.logs.length, 1);
});

test('dispose cancels a pending helper and permanently prevents more process work', async () => {
  const h = harness(); const pending = h.host.resizeWindow(); const child = h.calls[0].child;
  h.host.dispose(); h.host.dispose(); assert.equal(await pending, false); assert.equal(child.kills, 1);
  assert.equal(h.timers.size, 0); assert.equal(h.logs.length, 0); assert.equal(await h.host.resizeWindow(), false);
  assert.equal(h.calls.length, 1);
  const never = harness(); never.host.dispose(); assert.equal(await never.host.resizeWindow(), false); assert.equal(never.calls.length, 0);
});

test('exited helper PID is never killed during disposal or delayed close', async () => {
  const h = harness(); const pending = h.host.resizeWindow(); const child = h.calls[0].child;
  child.exit(0); h.host.dispose(); assert.equal(await pending, false); assert.equal(child.kills, 0);
  child.close(0); assert.equal(child.kills, 0);
});

test('existing native hide popup and theme bridge remains unchanged', () => {
  const h = harness(); h.host.hide(); h.host.show(); h.host.setTheme('dark');
  assert.deepEqual(h.writes.map(value => JSON.parse(value)), [{ cmd: 'hide_easyag' }, { cmd: 'popup' }, { cmd: 'theme', value: 'dark' }]);
  const testHost = harness({ host: { testMode: true } }); testHost.host.hide(); assert.equal(testHost.writes.length, 0);
});

test('candidate selection excludes Tauri helper window styles before real-window ambiguity', () => {
  assert.match(helper, /WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000/);
  assert.match(helper, /extendedStyle & \(WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE\)\) != 0\) return false/);
  assert.match(helper, /String\.Equals\(windowClass, "Tauri Window", StringComparison\.Ordinal\)/);
  assert.match(helper, /GetWindow\(window, 4\) == IntPtr\.Zero && Primary\(window\)/);
  assert.match(helper, /windows\.Count == 1 \? windows\[0\] : windows\.Count == 0 \? IntPtr\.Zero : new IntPtr\(-1\)/);
  assert.match(helper, /GetWindowLongPtrW/); assert.match(helper, /GetWindowLongW/);
});

test('helper fails closed on identity ambiguity and never requests activation or topmost', () => {
  assert.match(helper, /ParentProcessId -ne \$ParentPid/);
  assert.match(helper, /\$parentStarted -ge \$backendStarted/);
  assert.match(helper, /\$backend\.SessionId -ne \$session -or \$parent\.SessionId -ne \$session/);
  assert.match(helper, /parent\.MainModule\.FileName/); assert.match(helper, /OrdinalIgnoreCase/);
  assert.match(helper, /windows\.Count == 1/); assert.match(helper, /actual == \(uint\)owner/);
  assert.match(helper, /1180\.0 \* dpi \/ 96\.0/); assert.match(helper, /780\.0 \* dpi \/ 96\.0/);
  assert.match(helper, /Math\.Min/); assert.match(helper, /rcWork\.Left \+/); assert.match(helper, /rcWork\.Top \+/);
  assert.match(helper, /SetWindowPos\(window, IntPtr\.Zero, x, y, width, height, 0x4214\)/);
  assert.match(helper, /finally \{ SetThreadDpiAwarenessContext\(previous\); \}/);
  assert.match(helper, /ElapsedMilliseconds -lt 5000/); assert.match(helper, /IsIconic\(window\) \|\| IsZoomed\(window\)/);
  assert.doesNotMatch(helper, /extern.*(?:SetForegroundWindow|SetFocus|ShowWindow|SetWindowLong)/);
  assert.doesNotMatch(helper, /CommandLine|Get-Content|Invoke-Expression|Start-Process|Stop-Process|taskkill/i);
});