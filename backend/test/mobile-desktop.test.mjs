import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopAdapter } from '../mobile/lib/desktop.mjs';

const exe = 'C:/Programs/Antigravity/resources/bin/language_server.exe';
const valid = { pid: 41, exe, cmd: '--csrf_token="fixture"', ports: [41100, 41101] };

function adapterFor(stdout) {
  const probes = [];
  const adapter = new DesktopAdapter({
    platform: 'win32',
    execute: async () => ({ stdout }),
    fetch: async (url, options) => {
      probes.push(new URL(url).port);
      if (url.endsWith('/healthz')) return { ok: !url.includes(':41100/') };
      assert.equal(options.headers['x-codeium-csrf-token'], 'fixture');
      return { ok: true, json: async () => ({}) };
    }
  });
  return { adapter, probes };
}

test('mobile discovery requires the desktop path, a token, a live listener and a successful RPC', async () => {
  const { adapter, probes } = adapterFor(JSON.stringify([
    { ...valid, exe: 'C:/foreign/language_server.exe' },
    { ...valid, cmd: '--antigravity-cli --csrf_token=fixture' },
    { ...valid, cmd: '--csrf_token=""' }, { ...valid, cmd: '' }, valid
  ]));
  assert.deepEqual(await adapter.discover(), { base: 'http://127.0.0.1:41101', token: 'fixture', pid: 41, exe });
  assert.deepEqual(probes, ['41100', '41101', '41101']);
});

test('mobile discovery refuses empty results and multiple verified instances', async () => {
  for (const stdout of ['', '[]']) await assert.rejects(adapterFor(stdout).adapter.discover(), /未连接/);
  const { adapter } = adapterFor(JSON.stringify([valid, { ...valid, pid: 42, ports: [41102] }]));
  await assert.rejects(adapter.discover(), /多个/);
  assert.equal(adapter.endpoint, null);
});
