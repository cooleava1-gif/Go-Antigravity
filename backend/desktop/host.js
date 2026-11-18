const { spawn } = require('node:child_process');

function createHost({ native, testMode, events }) {
  // Capture the launcher relationship before asynchronous startup work or an overlay switch.
  const backendPid = process.pid;
  const parentPid = process.ppid;
  const executable = process.execPath;
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
  let resizeTask;
  let cancelResize;
  let disposed = false;

  function resizeWindow() {
    if (disposed || !native || testMode || process.platform !== 'win32') return Promise.resolve(false);
    if (resizeTask) return resizeTask;
    const windowsPath = require('node:path').win32;
    if (!Number.isSafeInteger(backendPid) || backendPid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0 ||
        backendPid === parentPid || typeof executable !== 'string' || !windowsPath.isAbsolute(executable) ||
        typeof systemRoot !== 'string' || !windowsPath.isAbsolute(systemRoot)) return Promise.resolve(false);
    resizeTask = new Promise(resolve => {
      let child;
      let timer;
      let settled = false;
      const finish = (ok, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancelResize = undefined;
        if (terminate && child && child.exitCode === null && child.signalCode === null) {
          try { child.kill(); } catch {}
        }
        if (!ok && !disposed) {
          try { events?.log('SYSTEM', '原生窗口尺寸调整已跳过，可手动调整窗口。', 'tag-warn'); } catch {}
        }
        resolve(ok);
      };
      cancelResize = () => finish(false, true);
      try {
        const helper = require('node:path').join(__dirname, 'window-layout.ps1');
        const expectedPath = windowsPath.join(windowsPath.dirname(executable), 'Starbridge.exe');
        const powershell = windowsPath.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', helper, '-BackendPid', String(backendPid), '-ParentPid', String(parentPid), '-ExpectedPath', expectedPath],
        { windowsHide: true, stdio: 'ignore', shell: false });
        child.once('error', () => finish(false, true));
        child.once('close', code => finish(code === 0));
        timer = setTimeout(() => finish(false, true), 10000);
        timer.unref?.();
        child.unref?.();
      } catch { finish(false, true); }
    });
    return resizeTask;
  }
  function send(command) {
    if (!native || testMode) return;
    process.stdout.write(JSON.stringify(command) + '\n');
  }
  function open(file, { text = false } = {}) {
    if (testMode) return;
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const args = process.platform === 'darwin' && text ? ['-t', file] : [file];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => events.log('SYSTEM', '打开失败: ' + error.message, 'tag-warn'));
    child.unref();
  }
  return {
    open,
    resizeWindow,
    hide: () => send({ cmd: 'hide_easyag' }),
    show: () => send({ cmd: 'popup' }),
    setTheme: value => send({ cmd: 'theme', value }),
    dispose() { disposed = true; cancelResize?.(); }
  };
}

module.exports = { createHost };