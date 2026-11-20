// Discovery of the local Antigravity language service: which process owns it, which TCP
// ports it listens on, and where its log announces the HTTP endpoint and CSRF token.
//
// discoverProcesses() resolves to one record per candidate process:
//   { pid: number, command: string, ports: Set<number> }
// A candidate is a process whose executable is the language service binary started with
// --standalone. win32 runs one PowerShell CIM query restricted to the current user's owner
// SID and pairs it with `netstat.exe -ano -p tcp`; darwin uses `ps` plus `lsof -Fpn`; linux
// reads the process file descriptors and the kernel TCP tables under /proc. A process that
// exits while it is being inspected keeps its row and simply reports no verified port.
//
// serverFromDiscovery(log, rows) converts that discovery plus the tail of the server log into
// { pid, port, csrf } for the single usable backend, and throws the user-facing message that
// describes why no backend can be selected. logPaths(profile) lists the log files worth
// reading, most specific first.
//
// parsePs / parseNetstat / parseLsof expose the text parsers for diagnostics and tests.
// Every external command runs with a bounded output buffer and a short timeout, and a probe
// that fails degrades to "nothing discovered" instead of failing the caller.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const spawn = promisify(execFile);
const PROBE_LIMITS = { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 };
const MIN_PORT = 1;
const MAX_PORT = 65535;
const LOG_FILE = path.join('logs', 'language_server.log');
const DARWIN_LOG = path.join('Library', 'Logs', 'Antigravity', 'language_server.log');

function usablePort(value) {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

function listeningPorts(map, pid, port) {
  if (!map.has(pid)) map.set(pid, new Set());
  map.get(pid).add(port);
}

// netstat.exe -ano prints one socket per row; only established listeners are interesting:
//   TCP  127.0.0.1:53342  0.0.0.0:0  LISTENING  4820
function parseNetstat(text) {
  const listeners = new Map();
  for (const row of text.split(/\r?\n/)) {
    const cells = row.trim().split(/\s+/);
    if (cells.length !== 5 || cells[0].toUpperCase() !== 'TCP' || cells[3].toUpperCase() !== 'LISTENING') continue;
    if (!/^\d+$/.test(cells[4])) continue;
    const address = cells[1], digits = address.slice(address.lastIndexOf(':') + 1);
    if (!/^\d+$/.test(digits)) continue;
    const port = Number(digits);
    if (!usablePort(port)) continue;
    listeningPorts(listeners, Number(cells[4]), port);
  }
  return listeners;
}

// The bundled binary is named language_server, optionally followed by its platform and then its
// architecture; the architecture suffix never appears without the platform. It is the argv[0]
// of a `ps -axo args=` line, possibly as an absolute path.
const SERVICE_NAMES = new Set(['language_server']);
for (const system of ['linux', 'macos', 'darwin']) {
  SERVICE_NAMES.add('language_server_' + system);
  SERVICE_NAMES.add('language_server_' + system + '_x64');
  SERVICE_NAMES.add('language_server_' + system + '_arm64');
}
const STANDALONE_FLAG = /(?:^|\s)--standalone\b/;

function isServiceCommand(command) {
  if (!STANDALONE_FLAG.test(command)) return false;
  return command.split(/\s+/).some(argument => {
    const name = argument.slice(Math.max(argument.lastIndexOf('/'), argument.lastIndexOf('\\')) + 1);
    return SERVICE_NAMES.has(name);
  });
}

// `ps -ww -axo pid=,uid=,args=` yields "  pid   uid  command ..." per candidate. The
// command is kept with its original spacing, since callers may echo it back for diagnostics.
function psFields(line) {
  const text = line.trim(), spans = [];
  let cursor = 0;
  while (spans.length < 2) {
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    const start = cursor;
    while (cursor < text.length && !/\s/.test(text[cursor])) cursor += 1;
    if (start === cursor) return null;
    spans.push([start, cursor]);
  }
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return { pid: text.slice(...spans[0]), uid: text.slice(...spans[1]), command: text.slice(cursor) };
}

function parsePs(text, uid) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = psFields(line);
    if (!fields || !fields.command) continue;
    if (!/^\d+$/.test(fields.pid) || !/^\d+$/.test(fields.uid)) continue;
    if (Number(fields.uid) !== uid) continue;
    if (!isServiceCommand(fields.command)) continue;
    found.push({ pid: Number(fields.pid), command: fields.command });
  }
  return found;
}

// `lsof -Fpn` emits a `p<pid>` record followed by `n<address>:<port>` records for that pid.
function parseLsof(text) {
  const listeners = new Map();
  let current = null, owner = 0;
  for (const record of text.split(/\r?\n/)) {
    const tag = record.slice(0, 1), value = record.slice(1);
    if (tag === 'p' && /^\d+$/.test(value)) {
      owner = Number(value);
      current = new Set();
      listeners.set(owner, current);
      continue;
    }
    // A record without a real process id proves nothing about a listener.
    if (tag !== 'n' || !current || !owner) continue;
    const digits = value.slice(value.lastIndexOf(':') + 1).trim();
    if (/^\d+$/.test(digits)) current.add(Number(digits));
  }
  return listeners;
}

// Get-CimInstance returns a single object for one hit and an array for several; a hit without a
// usable ProcessId is useless, and a query that matched nothing prints nothing at all.
function parseWindowsQuery(stdout) {
  const payload = stdout.replace(/^\uFEFF/, '').trim();
  if (!payload) return [];
  const parsed = JSON.parse(payload);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(entry => Number.isSafeInteger(entry?.ProcessId) && entry.ProcessId > 0);
}

// Only the language service of the current Windows user may be selected: another logged-in
// session runs its own backend, and answering from it would expose the wrong account.
const WINDOWS_QUERY = [
  '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;',
  'Get-CimInstance -ClassName Win32_Process -Filter "Name=\'language_server.exe\'" |',
  'ForEach-Object {',
  '  if ((Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -ne $me) { return }',
  String.raw`  if ($_.CommandLine -notmatch '(^|\s)--standalone(\s|=|$)') { return }`,
  '  [pscustomobject]@{ ProcessId = $_.ProcessId; CommandLine = $_.CommandLine }',
  '} | ConvertTo-Json -Compress'
].join(' ');

async function windowsHosts(execute) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], PROBE_LIMITS);
  const processes = parseWindowsQuery(stdout);
  if (!processes.length) return [];
  const { stdout: table } = await execute('netstat.exe', ['-ano', '-p', 'tcp'], PROBE_LIMITS);
  const listeners = parseNetstat(table);
  return processes.map(entry => ({ pid: entry.ProcessId, command: entry.CommandLine, ports: listeners.get(entry.ProcessId) || new Set() }));
}

async function psCandidates(execute, uid) {
  const { stdout } = await execute('ps', ['-ww', '-axo', 'pid=,uid=,args='], PROBE_LIMITS);
  return parsePs(stdout, uid);
}

async function darwinHosts(execute, uid) {
  const rows = await psCandidates(execute, uid);
  if (!rows.length) return [];
  const listing = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', rows.map(row => row.pid).join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'], PROBE_LIMITS)
    .catch(error => {
      // lsof exits 1 when one of the requested processes vanished mid-scan; the records it did
      // print are still valid, so keep them instead of losing the whole discovery.
      if (error.code === 1) return { stdout: error.stdout || '' };
      throw error;
    });
  const listeners = parseLsof(listing.stdout);
  return rows.map(row => ({ ...row, ports: listeners.get(row.pid) || new Set() }));
}

// Every socket the process holds appears as a socket:[inode] symlink; the kernel tables under
// /proc then map that inode to the local address it is bound to. State 0A is TCP_LISTEN.
async function socketInodes(pid) {
  const inodes = new Set();
  for (const handle of await fs.readdir(`/proc/${pid}/fd`)) {
    const target = await fs.readlink(`/proc/${pid}/fd/${handle}`).catch(() => '');
    const socket = /^socket:\[(\d+)\]$/.exec(target);
    if (socket) inodes.add(socket[1]);
  }
  return inodes;
}

function collectListening(table, inodes, ports) {
  for (const line of table.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== '0A' || !inodes.has(fields[9])) continue;
    const port = parseInt(fields[1].split(':')[1], 16);
    if (port > 0 && port <= MAX_PORT) ports.add(port);
  }
}

async function procPorts(pid) {
  const ports = new Set();
  try {
    const inodes = await socketInodes(pid);
    for (const name of ['tcp', 'tcp6']) {
      const table = await fs.readFile(`/proc/${pid}/net/${name}`, 'utf8').catch(() => '');
      collectListening(table, inodes, ports);
    }
  } catch { /* Exited or not inspectable: no verified port. */ }
  return ports;
}

async function linuxHosts(execute, uid) {
  const rows = await psCandidates(execute, uid);
  if (!rows.length) return [];
  return Promise.all(rows.map(async row => ({ ...row, ports: await procPorts(row.pid) })));
}

const HOST_QUERIES = new Map([
  ['win32', ({ execute }) => windowsHosts(execute)],
  ['darwin', ({ execute, uid }) => darwinHosts(execute, uid)],
  ['linux', ({ execute, uid }) => linuxHosts(execute, uid)]
]);

async function discoverProcesses({ platform = process.platform, execute = spawn, uid = process.getuid?.() } = {}) {
  const query = HOST_QUERIES.get(platform);
  if (!query) throw new Error('不支持的系统');
  return query({ execute, uid });
}

// The log repeats "listening on random port at <port> for HTTP" for every endpoint it opens;
// the newest still-open port wins, so the announcements are read in reverse order.
const HTTP_ANNOUNCEMENT = /listening on random port at (\d+) for HTTP(?:$|\s)/;

function announcedPorts(log) {
  const ports = [];
  for (const line of log.split(/\r?\n/)) {
    const match = HTTP_ANNOUNCEMENT.exec(line);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

function csrfFromCommand(command) {
  if (typeof command !== 'string') return null;
  const tokens = command.split(/\s+/);
  for (const [index, token] of tokens.entries()) {
    if (token !== '--csrf_token' && !token.startsWith('--csrf_token=')) continue;
    const raw = token === '--csrf_token' ? tokens[index + 1] : token.slice('--csrf_token='.length);
    const unquoted = String(raw ?? '').replace(/^"/, '');
    const end = unquoted.indexOf('"');
    return (end < 0 ? unquoted : unquoted.slice(0, end)) || null;
  }
  return null;
}

function serverFromDiscovery(log, rows) {
  if (rows.length !== 1) throw new Error(rows.length ? '多个 AG 后台，暂不采集' : '等待 AG 本地服务');
  const [row] = rows;
  const port = announcedPorts(log).reverse().find(value => row.ports.has(value));
  const csrf = csrfFromCommand(row.command);
  if (!port || !csrf) throw new Error('当前 AG 本地接口暂不可用');
  return { pid: row.pid, port, csrf };
}

function logPaths(profile) {
  const candidates = [];
  if (process.platform === 'darwin') candidates.push(path.join(os.homedir(), DARWIN_LOG));
  candidates.push(path.join(profile, LOG_FILE));
  return [...new Set(candidates)];
}

module.exports = { discoverProcesses, serverFromDiscovery, logPaths, parsePs, parseNetstat, parseLsof };
