import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { createMobileServer } from '../mobile/server.mjs';

const HOST = 'pocket.example.test';
const ORIGIN = 'https://' + HOST;
const ROUTE = '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage';

async function listen(server) {
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return 'http://127.0.0.1:' + server.address().port;
}
function http(base, path, { method = 'GET', headers = {}, body } = {}) {
 return new Promise((resolve, reject) => {
  const req = request(base + path, { method, headers, agent: false }, res => {
   const chunks = [];
   res.on('data', chunk => chunks.push(chunk));
   res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.once('error', reject);
  req.end(body);
 });
}
function upgrade(base, headers) {
 return new Promise((resolve, reject) => {
  const socket = connect(Number(new URL(base).port), '127.0.0.1');
  let text = '';
  socket.setTimeout(3000, () => socket.destroy(Error('Synthetic upgrade timed out')));
  socket.once('error', reject);
  socket.on('data', chunk => {
   text += chunk;
   if (text.includes('\r\n\r\n')) { socket.destroy(); resolve(Number(text.split(' ')[1])); }
  });
  socket.once('connect', () => socket.write('GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' + headers.map(([name, value]) => name + ': ' + value + '\r\n').join('') + '\r\n'));
 });
}
async function fixture(t) {
 const received = [], sockets = new Set();
 let discoveries = 0;
 const upstream = createServer((req, res) => {
  received.push({ kind: 'http', headers: req.headers, path: req.url });
  req.resume();
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('synthetic-native-ok');
 });
 upstream.on('upgrade', (req, socket) => {
  received.push({ kind: 'ws', headers: req.headers, path: req.url });
  sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
 });
 const nativeBase = await listen(upstream);
 const runtime = createMobileServer({ pin: '12345678', adapter: { discover: async () => { discoveries++; return { base: nativeBase, token: 'synthetic-native-token' }; } } });
 t.after(async () => {
  await runtime.close();
  for (const socket of sockets) socket.destroy();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
 });
 const base = await listen(runtime.server);
 const login = await http(base, '/pocket-login', { method: 'POST', headers: { host: HOST, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=12345678' });
 assert.equal(login.status, 302);
 const cookie = login.headers['set-cookie'][0].split(';')[0];
 const post = headers => http(base, ROUTE, { method: 'POST', headers: { host: HOST, cookie, 'content-type': 'text/plain', ...headers }, body: '{"text":"synthetic-message"}' });
 const ws = headers => upgrade(base, [['Host', HOST], ['Cookie', cookie], ...headers]);
 return { base, nativeBase, cookie, post, ws, received, discoveries: () => discoveries };
}

const denied = [
 ['same-site sibling', { origin: 'https://hostile.example.test', 'sec-fetch-site': 'same-site' }],
 ['foreign Origin without Fetch Metadata', { origin: 'https://hostile.example.test' }],
 ['opaque Origin', { origin: 'null' }],
 ['invalid Origin', { origin: 'not-an-origin' }],
 ['Origin list', { origin: ORIGIN + ' https://hostile.example.test' }],
 ['comma-separated Origin', { origin: ORIGIN + ', https://hostile.example.test' }],
 ['Origin with credentials', { origin: 'https://user@' + HOST }],
 ['Origin with path', { origin: ORIGIN + '/path' }],
 ['Origin with query', { origin: ORIGIN + '?query' }],
 ['Origin with fragment', { origin: ORIGIN + '#fragment' }],
 ['non-HTTP Origin', { origin: 'ftp://' + HOST }],
 ['insecure public Origin', { origin: 'http://' + HOST }],
 ['different port', { origin: ORIGIN + ':8443' }],
 ['empty Origin', { origin: '' }],
 ['cross-site without Origin', { 'sec-fetch-site': 'cross-site' }],
 ['cross-site despite matching Origin', { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
 ['same-site without Origin', { 'sec-fetch-site': 'same-site' }],
 ['same-site despite matching Origin', { origin: ORIGIN, 'sec-fetch-site': 'same-site' }],
 ['invalid Fetch Metadata', { 'sec-fetch-site': 'same-origin, cross-site' }],
 ['untrusted forwarded host', { origin: 'https://hostile.example.test', 'x-forwarded-host': 'hostile.example.test', forwarded: 'host=hostile.example.test;proto=https' }],
];

for (const kind of ['HTTP POST', 'WebSocket upgrade']) {
 test('native ' + kind + ' rejects untrusted browser sources before discovery or forwarding', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const [label, headers] of denied) {
   const response = kind === 'HTTP POST' ? (await f.post(headers)).status : await f.ws(Object.entries(headers));
   assert.equal(response, 403, label);
   assert.equal(f.received.length, 0, label + ' must not reach native upstream');
   assert.equal(f.discoveries(), 0, label + ' must not discover native endpoint');
  }
 });
}

test('native HTTP and upgrade reject duplicate security headers even when values match', { timeout: 10000 }, async t => {
 const f = await fixture(t);
 assert.equal((await f.post({ origin: [ORIGIN, ORIGIN] })).status, 403);
 for (const extra of [
  [['Origin', ORIGIN], ['Origin', ORIGIN]],
  [['Origin', ORIGIN], ['Host', HOST]],
  [['Origin', ORIGIN], ['Sec-Fetch-Site', 'same-origin'], ['Sec-Fetch-Site', 'same-origin']],
 ]) assert.equal(await f.ws(extra), 403, JSON.stringify(extra));
 assert.equal(f.received.length, 0); assert.equal(f.discoveries(), 0);
});

test('native same-origin tunneled phone requests and local clients remain compatible', { timeout: 10000 }, async t => {
 const f = await fixture(t);
 for (const headers of [
  { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'x-forwarded-proto': 'https' },
  { origin: ORIGIN },
  { 'sec-fetch-site': 'same-origin' },
  {},
 ]) assert.equal((await f.post(headers)).status, 200);
 assert.equal((await http(f.base, '/?wsTransport=3', { headers: { host: HOST, cookie: f.cookie, 'sec-fetch-site': 'none' } })).status, 200);
 assert.equal((await http(f.base, ROUTE, { method: 'POST', headers: { cookie: f.cookie, origin: f.base, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, body: '{}' })).status, 200);
 for (const headers of [[['Origin', ORIGIN], ['Sec-Fetch-Site', 'same-origin']], [['Origin', ORIGIN]], []]) assert.equal(await f.ws(headers), 101);
 assert.equal(await upgrade(f.base, [['Host', new URL(f.base).host], ['Cookie', f.cookie], ['Origin', f.base]]), 101);
 assert.equal(f.received.length, 10);
 for (const forwarded of f.received) {
  assert.equal(forwarded.headers.origin, f.nativeBase);
  assert.equal(forwarded.headers['x-codeium-csrf-token'], 'synthetic-native-token');
  assert.ok(!forwarded.headers.cookie?.includes('go_antigravity_mobile_session='));
 }
});
