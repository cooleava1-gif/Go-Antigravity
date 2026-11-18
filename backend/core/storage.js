const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const activeWrites = new Set();

// Only this writer's PID-tagged names are eligible. Legacy UUID-only files have no
// provable owner and are deliberately left for a user-confirmed offline cleanup.
function pruneAbandonedWrites(file) {
  const directory = path.dirname(file);
  const basename = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${basename}\\.([1-9][0-9]{0,9})\\.(${UUID_PATTERN})\\.tmp$`);
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(directory)) {
      const match = pattern.exec(name);
      if (!match) continue;
      const owner = Number(match[1]);
      const temporary = path.resolve(directory, name);
      if (owner > 0x7fffffff || owner === process.pid || activeWrites.has(temporary)) continue;
      try {
        const stat = fs.lstatSync(temporary);
        if (!stat.isFile() || now - stat.mtimeMs < TEMP_MAX_AGE_MS) continue;
        // Signal zero only checks existence. EPERM and every unknown result are live/unknown.
        try { process.kill(owner, 0); continue; } catch (error) {
          if (error.code !== 'ESRCH') continue;
        }
        const current = fs.lstatSync(temporary);
        if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev
          || current.mtimeMs !== stat.mtimeMs || current.size !== stat.size) continue;
        fs.unlinkSync(temporary);
      } catch { /* cleanup must not interfere with a new write */ }
    }
  } catch { /* cleanup is best effort */ }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (arguments.length > 1) return fallback;
    throw error;
  }
}

// Rename only after the complete file has been flushed. Readers never see half a JSON document.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  pruneAbandonedWrites(file);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    activeWrites.add(path.resolve(temporary));
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    } finally {
      activeWrites.delete(path.resolve(temporary));
      // An exclusive-open failure never grants ownership of an existing file.
      if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}

module.exports = { readJson, writeJson };
