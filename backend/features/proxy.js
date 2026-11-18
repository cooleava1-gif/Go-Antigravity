function buildProxyLaunch(port, cdpPort, environment = process.env) {
  const proxy = `http://127.0.0.1:${port}`;
  const bypass = 'localhost,127.0.0.1,::1,[::1]';
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--proxy-server=${proxy}`,
    `--proxy-bypass-list=localhost;127.0.0.1;[::1]`
  ];
  const env = {
    ...environment,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: bypass, no_proxy: bypass
  };
  // Antigravity is an Electron app: when the launcher itself was started from an Electron
  // host (VS Code, another Electron terminal, a wrapper script) this variable is inherited,
  // the AG binary runs as plain Node and exits immediately - which the user sees as
  // "启动后立刻退出". It must never be forwarded to the child process.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return { args, env };
}

module.exports = { buildProxyLaunch };
