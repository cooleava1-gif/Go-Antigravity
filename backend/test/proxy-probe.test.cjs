'use strict';
// Proxy preflight tests. The point of the probe is to catch, before AG is spawned, the two ways a
// proxy fails silently from the launcher's point of view: nothing listening on the port, and a
// node whose egress Google refuses ("User location is not supported"). If the probe ever reports
// ok for either of those, AG launches straight into the opaque HTTP 400 dialog it was meant to
// prevent — so these cases are pinned by status code, not by message text.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const zlib = require('node:zlib');
const { probeProxy: runProbeProxy, tunnelRequest, interpret, looksLikeGoogleAnswer, decodeBody, dechunk, parseHeaders, lookupEgress, normalizeEgress, EGRESS_SOURCES, CODES, GEO_GATE } = require('../features/proxy-probe');

function probeProxy(options) {
  return runProbeProxy({ egressLookup: async () => null, ...options });
}

const GOOGLE_AUTH_ERROR = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });

function stubTunnel(response) {
  return async () => ({ status: 200, headers: {}, body: '', ms: 12, ...response });
}

test('代理正常时返回 ok，并带上耗时', async () => {
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => true,
    tunnelRequest: stubTunnel({ status: 400, body: GOOGLE_AUTH_ERROR, ms: 240 })
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, CODES.OK);
  assert.equal(result.status, 400);
  assert.equal(result.ms, 240);
  assert.match(result.message, /代理出口正常/);
});

test('Google 地域封锁被识别为 geo-blocked，并带上换节点建议', async () => {
  const body = JSON.stringify({
    error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' }
  });
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => true,
    tunnelRequest: stubTunnel({ status: 400, body })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.GEO_BLOCKED);
  assert.equal(result.status, 400);
  assert.match(result.message, /User location is not supported/);
  assert.match(result.advice, /更换代理节点/);
});

test('地域封锁的判定不依赖状态码，只看 Google 的措辞', () => {
  // A future frontend could answer 403 for the same condition; the body is the stable signal.
  const verdict = interpret({ status: 403, body: GEO_GATE, ms: 5, error: null }, { port: 7890 });
  assert.equal(verdict.code, CODES.GEO_BLOCKED);
  assert.equal(verdict.ok, false);
});

test('端口无人监听时直接判定 proxy-down，不进入 TLS 流程', async () => {
  let tunnelCalls = 0;
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => false,
    tunnelRequest: async () => { tunnelCalls += 1; return { status: 200, body: '', headers: {}, ms: 1 }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PROXY_DOWN);
  assert.equal(tunnelCalls, 0, '端口都不通时不该再浪费一次 TLS 握手');
  assert.match(result.message, /127\.0\.0\.1:7890 连不上/);
  assert.match(result.advice, /启动代理客户端/);
});

test('代理拒绝转发（CONNECT 非 2xx）时判定 proxy-rejected', async () => {
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => true,
    tunnelRequest: stubTunnel({ stage: 'connect', status: 502 })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PROXY_REJECTED);
  assert.match(result.message, /CONNECT 返回 HTTP 502/);
});

test('代理返回自己的错误页而不是 Google 的应答时判定 bad-response', async () => {
  // A dead node behind a live proxy answers with its own HTML; an HTTP status alone would pass.
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => true,
    tunnelRequest: stubTunnel({ status: 502, body: '<html><body>502 Bad Gateway</body></html>' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.BAD_RESPONSE);
  assert.match(result.message, /非 Google 的响应/);
});

test('隧道阶段超时判定 timeout', async () => {
  const result = await probeProxy({
    port: 7890,
    timeoutMs: 50,
    checkPort: async () => true,
    tunnelRequest: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { stage: 'timeout', status: null, headers: {}, body: '' }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.TIMEOUT);
});

test('连接被拒绝判 proxy-down，即使绕过了端口预探测', () => {
  // skipPortCheck is what surfaces this path: the proxy was never listening at all.
  const verdict = interpret({ status: null, body: '', ms: 3, stage: 'connect', error: new Error('connect ECONNREFUSED 127.0.0.1:7890') }, { port: 7890 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.PROXY_DOWN);
});

test('隧道握手失败判 proxy-rejected，不谎称"代理没开"', () => {
  // A proxy that MITMs with a broken certificate reaches this branch. Telling the user the proxy
  // is not running would send them hunting for a process that is already up.
  const verdict = interpret({ status: null, body: '', ms: 9, stage: 'tls', error: new Error('wrong version number') }, { port: 7890 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES.PROXY_REJECTED);
});

test('端口非法时直接拒绝，不做任何网络动作', async () => {
  let tunnelCalls = 0;
  const result = await probeProxy({
    port: 0,
    checkPort: async () => true,
    tunnelRequest: async () => { tunnelCalls += 1; return { status: 200, headers: {}, body: '' }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PROXY_DOWN);
  assert.equal(tunnelCalls, 0);
});

test('skipPortCheck 时跳过环路探测，直接进隧道', async () => {
  let portCalls = 0;
  const result = await probeProxy({
    port: 7890,
    skipPortCheck: true,
    checkPort: async () => { portCalls += 1; return false; },
    tunnelRequest: stubTunnel({ status: 400, body: GOOGLE_AUTH_ERROR })
  });
  assert.equal(portCalls, 0);
  assert.equal(result.ok, true);
});

test('Google 的应答一律视为 JSON；HTML 错误页不算', () => {
  assert.equal(looksLikeGoogleAnswer(400, GOOGLE_AUTH_ERROR), true);
  assert.equal(looksLikeGoogleAnswer(200, '{"models": []}'), true);
  assert.equal(looksLikeGoogleAnswer(502, '<html>gateway error</html>'), false);
  assert.equal(looksLikeGoogleAnswer(502, 'not json at all'), false);
});

test('chunked 响应体能被正确拼接后再判定', () => {
  const payload = Buffer.from(JSON.stringify({ error: { message: GEO_GATE } }), 'utf8');
  const chunked = Buffer.concat([
    Buffer.from(`${payload.length.toString(16)}\r\n`, 'ascii'), payload, Buffer.from('\r\n0\r\n\r\n', 'ascii')
  ]);
  const decoded = decodeBody(chunked, { 'transfer-encoding': 'chunked' });
  assert.equal(decoded.includes(GEO_GATE), true);
});

test('gzip 响应体解压后再判定', async () => {
  const zlib = require('node:zlib');
  const body = zlib.gzipSync(Buffer.from(GEO_GATE, 'utf8'));
  const decoded = decodeBody(body, { 'content-encoding': 'gzip' });
  assert.equal(decoded.includes(GEO_GATE), true);
});

test('dechunk 忽略扩展名与尾块', () => {
  const buffer = Buffer.concat([
    Buffer.from('5;ext=1\r\nhello\r\n', 'ascii'),
    Buffer.from('1\r\n!\r\n', 'ascii'),
    Buffer.from('0\r\n\r\n', 'ascii')
  ]);
  assert.equal(dechunk(buffer).toString('utf8'), 'hello!');
});

test('响应头按小写归一，便于稳定读取', () => {
  const headers = parseHeaders('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Goog-Api-Client: gl-node/22\r\n\r\n');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-goog-api-client'], 'gl-node/22');
});

test('probe 结果带上端口与时间戳，供 UI 展示', async () => {
  const before = Date.now();
  const result = await probeProxy({ port: 7897, checkPort: async () => true, tunnelRequest: stubTunnel({ status: 400, body: GOOGLE_AUTH_ERROR }) });
  assert.equal(result.port, 7897);
  assert.ok(result.at >= before);
  assert.equal(typeof result.message, 'string');
});

// The exit region is the one fact that explains the 400 the preflight cannot see, so it travels with
// the probe result rather than being fetched separately by the UI.
const IPINFO_BODY = JSON.stringify({
  ip: '198.51.100.7', city: 'Los Angeles', region: 'California', country: 'US',
  org: 'AS64496 EXAMPLE CLOUD LLC', loc: '34.0522,-118.2437', timezone: 'America/Los_Angeles'
});
const IPAPI_BODY = JSON.stringify({
  status: 'success', country: 'United States', countryCode: 'US', region: 'CA', regionName: 'California',
  city: 'Los Angeles', isp: 'EXAMPLE CLOUD', org: 'EXAMPLE CLOUD LLC', as: 'AS64496 EXAMPLE CLOUD LLC',
  query: '192.0.2.55'
});

function stubEgress(bodies) {
  return async ({ host, secure }) => {
    if (!(host in bodies)) return { stage: 'connect', status: null, headers: {}, body: '', ms: 1 };
    return { stage: 'http', status: 200, headers: {}, body: bodies[host], ms: 1 };
  };
}

test('探测通过时把出口 IP 与国家一并带回来', async () => {
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => true,
    tunnelRequest: stubTunnel({ status: 400, body: GOOGLE_AUTH_ERROR }),
    egressLookup: async () => ({ ip: '198.51.100.7', country: 'US', countryName: '美国', city: 'Los Angeles', org: 'AS64496 EXAMPLE CLOUD LLC', source: 'ipinfo.io' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.egress.ip, '198.51.100.7');
  assert.equal(result.egress.countryName, '美国');
  assert.equal(result.egress.source, 'ipinfo.io');
});

test('探测失败时不去查出口，egress 保持 null', async () => {
  let looked = 0;
  const result = await probeProxy({
    port: 7890,
    checkPort: async () => false,
    tunnelRequest: stubTunnel({}),
    egressLookup: async () => { looked += 1; return null; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.egress, null);
  assert.equal(looked, 0, '隧道都没通时问不出出口，白白多一次往返');
});

test('ipinfo.io 的字段映射成统一形状', () => {
  const egress = normalizeEgress(JSON.parse(IPINFO_BODY), 'ipinfo.io');
  assert.equal(egress.ip, '198.51.100.7');
  assert.equal(egress.country, 'US');
  assert.equal(egress.countryName, '美国');
  assert.equal(egress.city, 'Los Angeles');
  assert.equal(egress.region, 'California');
  assert.equal(egress.org, 'AS64496 EXAMPLE CLOUD LLC');
  assert.equal(egress.source, 'ipinfo.io');
});

test('ip-api.com 的字段映射成同一种形状（国家名从代码表补）', () => {
  const egress = normalizeEgress(JSON.parse(IPAPI_BODY), 'ip-api.com');
  assert.equal(egress.ip, '192.0.2.55');
  assert.equal(egress.country, 'US');
  // countryCode wins over the long name, so the Chinese label comes from the table for both sources.
  assert.equal(egress.countryName, '美国');
  assert.equal(egress.city, 'Los Angeles');
  assert.equal(egress.org, 'AS64496 EXAMPLE CLOUD LLC');
});

test('查不到 IP 的应答视为没有出口，不返回半成品', () => {
  assert.equal(normalizeEgress({ status: 'fail', message: 'quota exceeded' }, 'ip-api.com'), null);
  assert.equal(normalizeEgress(null, 'ipinfo.io'), null);
  assert.equal(normalizeEgress('not an object', 'ipinfo.io'), null);
});

test('首选源答非所问时回落到第二个源', async () => {
  const seen = [];
  const egress = await lookupEgress({
    proxyPort: 7890,
    sources: EGRESS_SOURCES,
    tunnelRequest: async ({ host, secure, path }) => {
      seen.push({ host, secure, path });
      if (host === 'ipinfo.io') return { stage: 'http', status: 403, headers: {}, body: 'forbidden', ms: 1 };
      return { stage: 'http', status: 200, headers: {}, body: IPAPI_BODY, ms: 1 };
    }
  });
  assert.equal(egress.ip, '192.0.2.55');
  assert.equal(egress.source, 'ip-api.com');
  // The fallback must ask for plain HTTP: that is the only reason it can work at all.
  assert.equal(seen[0].secure, true);
  assert.equal(seen[1].secure, false);
  assert.equal(seen[1].path, '/json');
});

test('两个源都拿不到时返回 null，而不是抛错', async () => {
  const egress = await lookupEgress({
    proxyPort: 7890,
    sources: EGRESS_SOURCES,
    tunnelRequest: async () => ({ stage: 'connect', status: null, headers: {}, body: '', ms: 1 })
  });
  assert.equal(egress, null);
});

test('一个源答得慢，不会让另一个源已经拿到的答案超时作废', async () => {
  // Regression: the sources used to be chained, so a slow first source spent the shared budget
  // before the second one was even asked, and the whole lookup came back null — measured on the
  // real proxy, where ipinfo.io rate-limits (429) after ~3s and ip-api answers in ~2s.
  const started = Date.now();
  const egress = await lookupEgress({
    proxyPort: 7890,
    sources: EGRESS_SOURCES,
    tunnelRequest: async ({ host }) => {
      if (host === 'ipinfo.io') {
        await new Promise(resolve => setTimeout(resolve, 3000));
        return { stage: 'http', status: 429, headers: {}, body: '{"status":429}', ms: 3000 };
      }
      return { stage: 'http', status: 200, headers: {}, body: IPAPI_BODY, ms: 50 };
    }
  });
  assert.equal(egress.ip, '192.0.2.55');
  assert.equal(egress.source, 'ip-api.com');
  assert.ok(Date.now() - started < 2500, '快源的答案必须立刻返回，不等慢源');
});

test('慢源的晚到答案不会覆盖已经返回的结果', async () => {
  const egress = await lookupEgress({
    proxyPort: 7890,
    sources: EGRESS_SOURCES,
    tunnelRequest: async ({ host }) => {
      if (host === 'ipinfo.io') {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { stage: 'http', status: 200, headers: {}, body: IPINFO_BODY, ms: 200 };
      }
      return { stage: 'http', status: 200, headers: {}, body: IPAPI_BODY, ms: 5 };
    }
  });
  // Whichever answers first wins; the other is abandoned, so the result is one source or the other
  // but never a blend of the two.
  assert.ok(['ipinfo.io', 'ip-api.com'].includes(egress.source));
  assert.ok(egress.ip.length > 0);
});

test('一个源抛错不会带走另一个源的结果', async () => {
  const egress = await lookupEgress({
    proxyPort: 7890,
    sources: EGRESS_SOURCES,
    tunnelRequest: async ({ host }) => {
      if (host === 'ipinfo.io') throw new Error('socket hang up');
      return { stage: 'http', status: 200, headers: {}, body: IPAPI_BODY, ms: 5 };
    }
  });
  assert.equal(egress.ip, '192.0.2.55');
  assert.equal(egress.source, 'ip-api.com');
});

test('出口查询整体有超时兜底，不会挂住启动流程', async () => {
  const started = Date.now();
  const egress = await lookupEgress({
    proxyPort: 7890,
    timeoutMs: 1000,
    sources: [{ name: 'hung', host: 'hung.invalid', port: 443, path: '/json', secure: true }],
    tunnelRequest: () => new Promise(() => {})
  });
  assert.equal(egress, null);
  assert.ok(Date.now() - started < 4000, '兜底必须在远小于默认超时的预算内返回');
});

// Synthetic HTTP bodies and a loopback-only CONNECT peer: no real proxy or Google traffic.
function chunkBody(buffer) {
  const split = Math.max(1, Math.floor(buffer.length / 2));
  const parts = [buffer.subarray(0, split), buffer.subarray(split)].filter(part => part.length);
  return Buffer.concat([
    ...parts.flatMap((part, index) => [
      Buffer.from(part.length.toString(16) + ';part=' + index + '\r\n', 'latin1'),
      part, Buffer.from('\r\n', 'latin1')
    ]),
    Buffer.from('0;done=true\r\nX-Synthetic: complete\r\n\r\n', 'latin1')
  ]);
}

async function mockProxy(t, body, headerLines = [], status = 200) {
  const requests = [];
  const sockets = new Set();
  const response = Buffer.concat([
    Buffer.from(['HTTP/1.1 ' + status + ' Synthetic', ...headerLines, '', ''].join('\r\n'), 'latin1'),
    body
  ]);
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let pending = '';
    let connected = false;
    socket.on('data', chunk => {
      pending += chunk.toString('latin1');
      const end = pending.indexOf('\r\n\r\n');
      if (end < 0) return;
      requests.push(pending.slice(0, end));
      pending = pending.slice(end + 4);
      if (!connected) {
        connected = true;
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      } else {
        socket.end(response);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  return { port: server.address().port, requests };
}

test('正文解码保留 plain、gzip 和 deflate 支持', () => {
  const body = JSON.stringify({ error: { message: GEO_GATE + ' 合成地区' } });
  for (const [bytes, headers] of [
    [Buffer.from(body), {}],
    [zlib.gzipSync(Buffer.from(body)), { 'Content-Encoding': 'GZip' }],
    [zlib.deflateSync(Buffer.from(body)), { 'content-encoding': 'deflate' }]
  ]) assert.equal(decodeBody(bytes, headers), body);
});

test('chunked + gzip 先去分块后解压，保留地区判定正文', () => {
  const body = JSON.stringify({ error: { message: GEO_GATE + ' for the API use.' } });
  const headers = parseHeaders('HTTP/1.1 400 Synthetic\r\nTransfer-Encoding: ChUnKeD\r\nContent-Encoding: GZIP\r\n\r\n');
  const decoded = decodeBody(chunkBody(zlib.gzipSync(Buffer.from(body))), headers);
  assert.equal(decoded, body);
  assert.equal(interpret({ stage: 'http', status: 400, body: decoded, ms: 1 }).code, CODES.GEO_BLOCKED);
});

test('多行编码头按应用顺序合并并逆序解码', () => {
  const body = JSON.stringify({ models: ['synthetic'] });
  const headers = parseHeaders('HTTP/1.1 200 Synthetic\r\nContent-Encoding: gzip\r\ncontent-encoding: deflate\r\nTransfer-Encoding: GZIP\r\ntransfer-encoding: ChUnKeD\r\n\r\n');
  assert.equal(headers['content-encoding'], 'gzip, deflate');
  assert.equal(headers['transfer-encoding'], 'GZIP, ChUnKeD');
  const content = zlib.deflateSync(zlib.gzipSync(Buffer.from(body)));
  assert.equal(decodeBody(chunkBody(zlib.gzipSync(content)), headers), body);
  assert.equal(decodeBody(content, { 'CONTENT-ENCODING': ['gzip', 'deflate'] }), body);
});

test('分块扩展支持引号、转义和 trailer，零分块是有效空正文', () => {
  const bytes = Buffer.from('5;name="a; b\\\"c";flag\r\nhello\r\n0;end=1\r\nX-Trace: synthetic\r\n\r\n', 'latin1');
  assert.equal(dechunk(bytes).toString(), 'hello');
  assert.equal(decodeBody(Buffer.from('0\r\n\r\n'), { 'transfer-encoding': 'chunked' }), '');
});

test('畸形或未完整终止的分块不会泄漏部分正文', async t => {
  const invalid = {
    'missing size CRLF': '5',
    'non-hex size': 'Z\r\nhello\r\n0\r\n\r\n',
    'partial-hex size': '5garbage\r\nhello\r\n0\r\n\r\n',
    'signed size': '+5\r\nhello\r\n0\r\n\r\n',
    'prefixed size': '0x5\r\nhello\r\n0\r\n\r\n',
    'unsafe size': '20000000000000\r\nhello\r\n0\r\n\r\n',
    'short chunk': '6\r\nhello',
    'missing data CRLF': '5\r\nhelloXX0\r\n\r\n',
    'missing zero chunk': '5\r\nhello\r\n',
    'missing final CRLF': '5\r\nhello\r\n0\r\n',
    'incomplete trailer': '5\r\nhello\r\n0\r\nX-Test: value\r\n',
    'malformed trailer': '5\r\nhello\r\n0\r\nnot-a-header\r\n\r\n',
    'extra data': '5\r\nhello\r\n0\r\n\r\nextra',
    'empty extension': '5;\r\nhello\r\n0\r\n\r\n',
    'unclosed extension quote': '5;name="unfinished\r\nhello\r\n0\r\n\r\n'
  };
  for (const [name, body] of Object.entries(invalid)) {
    await t.test(name, () => {
      assert.equal(dechunk(Buffer.from(body)).length, 0);
      assert.equal(decodeBody(Buffer.from(body), { 'transfer-encoding': 'chunked' }), '');
    });
  }
});

test('畸形压缩体、编码列表和超限解压结果受控失败', () => {
  const validGzip = zlib.gzipSync(Buffer.from(GOOGLE_AUTH_ERROR));
  for (const [bytes, headers] of [
    [Buffer.from('not gzip'), { 'content-encoding': 'gzip' }],
    [validGzip.subarray(0, validGzip.length - 3), { 'content-encoding': 'gzip' }],
    [Buffer.from('not deflate'), { 'content-encoding': 'deflate' }],
    [Buffer.from(GOOGLE_AUTH_ERROR), { 'transfer-encoding': 'xchunked' }],
    [chunkBody(validGzip), { 'transfer-encoding': 'chunked, gzip' }],
    [chunkBody(validGzip), { 'transfer-encoding': 'chunked, chunked' }],
    [validGzip, { 'content-encoding': 'gzip,' }],
    [Buffer.from(GOOGLE_AUTH_ERROR), { 'content-encoding': 'unknown' }],
    [zlib.gzipSync(Buffer.alloc(256 * 1024 + 1, 65)), { 'content-encoding': 'gzip' }]
  ]) assert.equal(decodeBody(bytes, headers), '');
});

test('真实隧道解析路径识别 chunked+gzip 地区拒绝并阻止预检通过', async t => {
  const body = JSON.stringify({ error: { code: 400, message: GEO_GATE + ' for the API use.' } });
  const proxy = await mockProxy(t, chunkBody(zlib.gzipSync(Buffer.from(body))), [
    'Content-Encoding: GZIP', 'Transfer-Encoding: CHUNKED'
  ], 400);
  const result = await probeProxy({
    port: proxy.port,
    checkPort: async () => true,
    tunnelRequest: options => tunnelRequest({ ...options, host: 'probe.invalid', secure: false })
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.GEO_BLOCKED);
  assert.equal(result.status, 400);
  assert.equal(result.egress, null);
  assert.match(proxy.requests[0], /^CONNECT probe\.invalid:443 HTTP\/1\.1/);
  assert.match(proxy.requests[1], /^GET \/v1beta\/models HTTP\/1\.1/);
});

test('合法压缩分块出口正文进入地区字段解析业务路径', async t => {
  const proxy = await mockProxy(t, chunkBody(zlib.deflateSync(Buffer.from(IPINFO_BODY))), [
    'Content-Encoding: deflate', 'Transfer-Encoding: chunked'
  ]);
  const egress = await lookupEgress({
    proxyPort: proxy.port,
    sources: [{ name: 'ipinfo.io', host: 'region.invalid', port: 80, path: '/json', secure: false }]
  });
  assert.equal(egress.country, 'US');
  assert.equal(egress.countryName, '美国');
  assert.equal(egress.region, 'California');
  assert.equal(egress.ip, '198.51.100.7');
  assert.match(proxy.requests[0], /^CONNECT region\.invalid:80 HTTP\/1\.1/);
});

test('畸形 HTTP 200 编码响应不能被当作合法空成功', async t => {
  const plain = Buffer.from('{"models":[]}');
  const missingZero = Buffer.concat([Buffer.from(plain.length.toString(16) + '\r\n'), plain, Buffer.from('\r\n')]);
  for (const [name, bytes, headers] of [
    ['unfinished chunked', missingZero, ['Transfer-Encoding: chunked']],
    ['broken gzip', Buffer.from('not gzip'), ['Content-Encoding: gzip']],
    ['bad coding order', chunkBody(plain), ['Transfer-Encoding: chunked, gzip']]
  ]) {
    await t.test(name, async t => {
      const proxy = await mockProxy(t, bytes, headers);
      let raw = null;
      const result = await probeProxy({
        port: proxy.port,
        checkPort: async () => true,
        tunnelRequest: async options => {
          raw = await tunnelRequest({ ...options, host: 'probe.invalid', secure: false });
          return raw;
        }
      });
      assert.equal(raw.stage, 'http');
      assert.equal(raw.status, 200);
      assert.equal(raw.body, '');
      assert.ok(raw.error instanceof Error);
      assert.equal(result.ok, false);
      assert.equal(result.code, CODES.BAD_RESPONSE);
      assert.equal(result.error, null);
      assert.equal(result.egress, null);
    });
  }
});

test('完整零分块保持现有 HTTP 204 空正文成功语义', async t => {
  const proxy = await mockProxy(t, Buffer.from('0\r\n\r\n'), ['Transfer-Encoding: chunked'], 204);
  const raw = await tunnelRequest({ proxyPort: proxy.port, host: 'probe.invalid', secure: false });
  assert.equal(raw.body, '');
  assert.equal(raw.error, undefined);
  assert.equal(interpret(raw).code, CODES.OK);
});
