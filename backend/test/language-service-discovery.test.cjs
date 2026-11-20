const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverProcesses, serverFromDiscovery } = require('../adapters/desktop/language-service-discovery');

test('Windows usage discovery matches the logged HTTP port to a listener of this process', async () => {
  const command = 'language_server.exe --standalone --csrf_token=fixture';
  const execute = async (file, args) => {
    if (file === 'powershell.exe') {
      assert.ok(args.at(-1).includes(String.raw`(^|\s)--standalone(\s|=|$)`),
        'The PowerShell filter must receive the whitespace escapes');
      return { stdout: JSON.stringify({ ProcessId: 21, CommandLine: command }) };
    }
    assert.equal(file, 'netstat.exe');
    return { stdout: '  TCP  127.0.0.1:4100  0.0.0.0:0  LISTENING  21\r\n' +
      '  TCP  [::1]:4200  [::]:0  LISTENING  22\r\n' };
  };
  const rows = await discoverProcesses({ platform: 'win32', execute });
  const log = 'listening on random port at 4100 for HTTP\nlistening on random port at 4200 for HTTP\n';
  assert.deepEqual(serverFromDiscovery(log, rows), { pid: 21, port: 4100, csrf: 'fixture' });
  assert.throws(() => serverFromDiscovery(log, [...rows, { ...rows[0], pid: 22 }]), /多个/);
});
