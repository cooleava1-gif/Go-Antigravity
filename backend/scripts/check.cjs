#!/usr/bin/env node
// Lightweight syntax gate: parses every backend module with `node --check` so a typo cannot
// reach the launcher. Deliberately does not cover semantics - that is what test/ is for.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', '_attic']);
const EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);
// The mobile web client uses browser ES modules inside this CommonJS package.

function walk(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (EXTENSIONS.has(path.extname(entry.name)) && !entry.name.startsWith('.')) found.push(full);
  }
  return found;
}

function check(file) {
  const relative = path.relative(ROOT, file);
  const isBrowser = relative.split(path.sep).slice(0, 2).join('/') === 'mobile/web';
  if (!isBrowser) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return;
  }
  const temporary = path.join(os.tmpdir(), `goagy-check-${process.pid}-${path.basename(file, '.js')}.mjs`);
  fs.copyFileSync(file, temporary);
  try {
    execFileSync(process.execPath, ['--check', temporary], { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

const files = walk(ROOT).sort();
const failures = [];
for (const file of files) {
  try {
    check(file);
  } catch (error) {
    failures.push({ file: path.relative(ROOT, file), detail: String(error.stderr || error.message).trim() });
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`✗ ${failure.file}\n${failure.detail}\n`);
  }
  console.error(`语法检查失败：${failures.length}/${files.length} 个文件`);
  process.exit(1);
}
console.log(`语法检查通过：${files.length} 个文件`);
