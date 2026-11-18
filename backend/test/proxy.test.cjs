const test = require('node:test');
const assert = require('node:assert');
const { buildProxyLaunch } = require('../features/proxy');

test('启动参数带上本地代理与随机调试端口', () => {
  const { args } = buildProxyLaunch(7897, 9333);
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:7897'));
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.some(arg => arg.startsWith('--proxy-bypass-list=')));
});

test('代理环境变量同时写入大小写两种形式', () => {
  const { env } = buildProxyLaunch(7890, 9333, { PATH: '/usr/bin' });
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.equal(env[key], 'http://127.0.0.1:7890');
  }
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1,[::1]');
  assert.equal(env.no_proxy, env.NO_PROXY);
  assert.equal(env.PATH, '/usr/bin');
});

test('不把 ELECTRON_RUN_AS_NODE 传给 AG，否则 AG 会退化成 node 直接退出', () => {
  const { env } = buildProxyLaunch(7890, 9333, {
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    PATH: '/usr/bin'
  });
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
  assert.equal('ELECTRON_NO_ATTACH_CONSOLE' in env, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('调用方传入的环境对象不会被就地修改', () => {
  const source = { ELECTRON_RUN_AS_NODE: '1' };
  buildProxyLaunch(7890, 9333, source);
  assert.equal(source.ELECTRON_RUN_AS_NODE, '1');
});
