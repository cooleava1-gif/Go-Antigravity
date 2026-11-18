#!/usr/bin/env node
// 用途：在把日志/账本发给别人（或贴进 issue、聊天窗口）之前，就地抹掉可能残留的凭据。
// 默认只报告不修改，加 --write 才会真正改写文件。
//
//   node scripts/scrub-secrets.cjs                      # 扫描默认数据目录
//   node scripts/scrub-secrets.cjs D:\path\to\data --write
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactSecrets, containsSecret } = require('../core/redact');

const args = process.argv.slice(2);
const write = args.includes('--write');
const target = args.find(arg => !arg.startsWith('--'))
  || process.env.EASYAG_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'com.easyag.launcher.tauri');

if (!fs.existsSync(target)) {
  console.error(`数据目录不存在：${target}`);
  process.exit(1);
}

const files = fs.readdirSync(target)
  .filter(name => /^easyag\.log(\.previous)?$/.test(name) || /^accounts(\.bak-[^.]+)?\.json$/.test(name))
  .map(name => path.join(target, name));

let hits = 0;
const touched = [];

function scrubLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let changed = false;
  const output = lines.map(line => {
    if (!line.trim()) return line;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.message === 'string' && containsSecret(entry.message)) {
        hits += 1;
        entry.message = redactSecrets(entry.message);
        changed = true;
        return JSON.stringify(entry);
      }
      return line;
    } catch {
      return containsSecret(line) ? (hits += 1, changed = true, redactSecrets(line)) : line;
    }
  });
  if (!changed) return false;
  if (write) fs.writeFileSync(file, output.join('\n'), 'utf8');
  return true;
}

function scrubAccounts(file) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return scrubLog(file);
  }
  let changed = false;
  for (const account of Array.isArray(state?.accounts) ? state.accounts : []) {
    if (typeof account.lastError === 'string' && containsSecret(account.lastError)) {
      hits += 1;
      account.lastError = redactSecrets(account.lastError);
      changed = true;
    }
    if (account.quota && typeof account.quota.error === 'string' && containsSecret(account.quota.error)) {
      hits += 1;
      account.quota.error = redactSecrets(account.quota.error);
      changed = true;
    }
  }
  if (!changed) return false;
  if (write) fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return true;
}

for (const file of files) {
  const name = path.basename(file);
  const changed = name.startsWith('accounts') ? scrubAccounts(file) : scrubLog(file);
  if (changed) touched.push(name);
}

console.log(`扫描目录：${target}`);
console.log(`命中凭据：${hits} 处`);
if (!touched.length) {
  console.log('干净，没有需要处理的内容。');
} else if (write) {
  console.log(`已脱敏：${touched.join(', ')}`);
} else {
  console.log(`待脱敏：${touched.join(', ')}（加 --write 才会真正改写）`);
}
