'use strict';
// Watches AG's own language-server log for the one failure the preflight cannot see.
//
// The preflight probes generativelanguage.googleapis.com with no credentials. Google decides the
// region gate after it has authenticated the caller, so an exit region it refuses produces a green
// preflight and a red AG: the first and only witness is language_server.log, which prints
//
//   FAILED_PRECONDITION (code 400): User location is not supported for the API use.
//
// a second or two after the first request goes out. Without this, the user's only signal is AG's
// own dialog — the same opaque text that made this bug take a day to diagnose.
//
// Scope: tail only. The file is rewritten on every AG start, so the watcher seeds from the current
// end of file when AG comes up and reports only lines appended after that. That way an error left
// over from yesterday never fires on today's launch, and a launch that never talks to Google never
// fires at all.
const fs = require('node:fs');
const path = require('node:path');

const GEO_GATE = 'User location is not supported';
const DEFAULT_POLL_MS = 2000;
// One dialog per incident. A user who sends five messages while the node is wrong gets one
// explanation, not five identical ones.
const DEFAULT_COOLDOWN_MS = 60000;
// AG's log is capped well below this by the Go logger, so one read always covers the gap.
const MAX_SCAN_BYTES = 256 * 1024;

function resolveLogPath(appData) {
  if (!appData) return null;
  return path.join(appData, 'Antigravity', 'logs', 'language_server.log');
}

/**
 * @param {object}   [options]
 * @param {object}   options.events        events bus with log(channel, message, tag)
 * @param {string}   [options.appData]     %APPDATA%, where AG keeps its logs
 * @param {string}   [options.logPath]     explicit log file, overrides appData
 * @param {number}   [options.pollMs]      tail interval
 * @param {number}   [options.cooldownMs]  minimum gap between two reports
 * @param {Function} [options.describeEgress] () => string, one extra line naming the proxy exit
 * @param {object}   [options.fs]          fs stand-in for tests
 * @param {Function} [options.now]         () => ms, for tests
 * @param {Function} [options.onStateChange] (watching) => void, for tests
 */
function createAgLogWatcher({
  events,
  appData = process.env.APPDATA,
  logPath = resolveLogPath(appData),
  pollMs = DEFAULT_POLL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  describeEgress = () => '',
  fs: fsImpl = fs,
  now = () => Date.now(),
  onStateChange = () => {}
} = {}) {
  let timer = null;
  let handle = null;
  let offset = 0;
  let lastReported = 0;
  let watching = false;

  function report() {
    lastReported = now();
    events.log('PROXY', 'AG 的模型请求被 Google 地域闸门拒绝（HTTP 400 · User location is not supported for the API use）', 'tag-alert');
    // The exit is the cause, so it goes on its own line rather than at the end of a sentence.
    const egress = describeEgress();
    if (egress) events.log('PROXY', egress, 'tag-warn');
    events.log('PROXY', '这与 Go-Antigravity 无关，也不需要重装：把代理节点换到 Google 受支持的地区（美、日等）再重试', 'tag-warn');
  }

  function scan() {
    let stat;
    try { stat = fsImpl.statSync(logPath); } catch { return; }
    // Rotation or truncation: AG rewrites the file when it starts, so a shrink means a new session
    // and the old handle is stale.
    if (stat.size < offset) {
      offset = 0;
      if (handle !== null) {
        try { fsImpl.closeSync(handle); } catch { /* already gone */ }
        handle = null;
      }
    }
    if (stat.size === offset) return;
    const length = Math.min(stat.size - offset, MAX_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    try {
      if (handle === null) handle = fsImpl.openSync(logPath, 'r');
      fsImpl.readSync(handle, buffer, 0, length, offset);
    } catch { return; }
    offset += length;
    if (now() - lastReported < cooldownMs) return;
    if (buffer.toString('utf8').includes(GEO_GATE)) report();
  }

  return {
    get watching() { return watching; },
    get logPath() { return logPath; },
    start() {
      if (watching) return;
      watching = true;
      // Seed from the current end of file: everything before this point belongs to a previous run.
      try { offset = fsImpl.statSync(logPath).size; } catch { offset = 0; }
      onStateChange(true);
      timer = setInterval(scan, pollMs);
      // Never the reason the launcher stays alive when the user quits.
      timer.unref?.();
      // One immediate pass: AG may have failed between being spawned and this hook running.
      scan();
    },
    stop() {
      watching = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (handle !== null) {
        try { fsImpl.closeSync(handle); } catch { /* already gone */ }
        handle = null;
      }
      onStateChange(false);
    }
  };
}

module.exports = { createAgLogWatcher, resolveLogPath, GEO_GATE, DEFAULT_POLL_MS, DEFAULT_COOLDOWN_MS };
