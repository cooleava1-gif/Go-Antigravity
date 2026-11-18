const fs = require('node:fs');
const path = require('node:path');

// The launcher runs the backend straight from disk (easyag-node.exe backend/server.js), so
// editing a module while it is running leaves the process serving stale code. Users cannot
// tell that apart from a bug in the new code, so watch the source tree and say so in the UI.
const WATCHED_DIRS = ['core', 'features', 'adapters', 'desktop', 'ui'];
const WATCHED_ROOT_FILES = ['index.html', 'server.js', 'package.json'];
const WATCHED_EXTENSIONS = new Set(['.js', '.cjs', '.json', '.css', '.html']);
const SKIP_DIRS = new Set(['node_modules', '.git', '_attic']);

function newestSourceMtime(rootDir) {
  let newest = 0;
  const visit = directory => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || entry.name.includes('.bak-')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!WATCHED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch { /* a file removed mid-walk is not a change we need to report */ }
    }
  };
  for (const name of WATCHED_DIRS) visit(path.join(rootDir, name));
  for (const name of WATCHED_ROOT_FILES) {
    try {
      const stat = fs.statSync(path.join(rootDir, name));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch { /* optional files */ }
  }
  return newest;
}

function createSourceGuard({ rootDir, now = () => Date.now(), ttlMs = 15000 } = {}) {
  const bootedAt = now();
  const bootedMtime = newestSourceMtime(rootDir);
  let cachedAt = 0;
  let cached = null;
  return {
    bootedAt,
    bootedMtime,
    check() {
      const current = now();
      if (cached && current - cachedAt < ttlMs) return cached;
      cachedAt = current;
      // One second of slack absorbs filesystem timestamp granularity on FAT/exFAT volumes.
      cached = {
        bootedAt,
        changed: newestSourceMtime(rootDir) > bootedMtime + 1000
      };
      return cached;
    }
  };
}

module.exports = { createSourceGuard, newestSourceMtime };
