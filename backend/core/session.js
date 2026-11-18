const { spawn } = require('node:child_process');
const { buildProxyLaunch } = require('../features/proxy');

class Session {
  constructor({ settings, desktop, cdp, events, host, testMode = false, spawnProcess = spawn, onStart = () => {}, onBeforeLaunch = null, onExit = null, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { settings, desktop, cdp, events, host, testMode, spawnProcess, onStart, onBeforeLaunch, onExit, wait });
    this.phase = 'idle';
    this.child = null;
    this.closed = false;
    this.generation = 0;
  }

  snapshot() {
    return { phase: this.phase, clientRunning: this.phase === 'running', pid: this.child?.pid || null };
  }

  change(phase) {
    this.phase = phase;
    this.events.publish(this.snapshot());
  }

  async launch() {
    if (this.closed) return { ok: false, error: 'EasyAG 正在退出' };
    if (this.phase === 'running') return { ok: true, alreadyRunning: true };
    if (this.finishing || this.phase === 'preparing' || this.phase === 'launching') return { ok: false, error: '正在启动，请稍候' };
    const generation = ++this.generation;
    this.change('preparing');
    try {
      const target = this.desktop.locate();
      if (!target.exists) throw new Error('未找到 Antigravity: ' + target.appExe);
      if (await this.desktop.running()) throw new Error('请先退出已打开的 AG，再通过 EasyAG 启动以接入代理环境');
      if (this.closed || generation !== this.generation) throw new Error('启动已取消');
      const settings = this.settings.get();
      this.change('launching');
      // Runs while AG is provably closed, so a pre-launch patch can never fight a running
      // language_server for the file. A failure here aborts the launch like any other.
      if (this.onBeforeLaunch) await this.onBeforeLaunch();
      if (this.closed || generation !== this.generation) throw new Error('启动已取消');
      const launch = buildProxyLaunch(settings.port, this.cdp.port);
      const child = this.spawnProcess(target.appExe, launch.args, {
        env: launch.env, detached: false, stdio: 'ignore', windowsHide: false
      });
      this.child = child;
      let spawnError;
      child.once('error', error => { spawnError = error; });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (spawnError) throw spawnError;
      child.once('exit', () => {
        if (this.child !== child || this.closed || this.finishing || this.phase !== 'running') return;
        this.child = null;
        this.handoffPromise = this.confirmExit(generation);
        void this.handoffPromise.catch(error => this.events.log('SYSTEM', error.message, 'tag-warn'));
      });
      if (this.closed || generation !== this.generation) {
        child.kill();
        throw new Error('启动已取消');
      }
      if (child.exitCode !== null && child.exitCode !== undefined) throw new Error('Antigravity 启动后立即退出');
      this.onStart();
      this.change('running');
      this.cdp.start();
      this.events.log('SYSTEM', `Antigravity 已启动（本地代理 127.0.0.1:${settings.port}），增强功能正在连接`, 'tag-proxy');
      this.host.hide();
      return { ok: true };
    } catch (error) {
      this.child = null;
      if (!this.closed) this.change('error');
      this.events.log('SYSTEM', error.message, 'tag-alert');
      return { ok: false, error: error.message };
    }
  }

  async attachExisting() {
    if (this.closed || this.phase !== 'idle' || this.testMode) return;
    const generation = this.generation;
    if (!await this.desktop.running() || this.closed || this.phase !== 'idle' || generation !== this.generation || this.finishing) return;
    this.onStart();
    this.change('running');
    this.cdp.start();
    this.events.log('SYSTEM', '已连接现有 AG 实例', 'tag-proxy');
    this.startMonitor(generation);
  }

  active(generation) {
    return !this.closed && !this.finishing && this.phase === 'running' && generation === this.generation;
  }

  startMonitor(generation) {
    clearInterval(this.monitor);
    // Only attached/replacement processes need polling; the original child has an exit event.
    this.monitor = setInterval(() => { void this.monitorExit(generation); }, 10000);
    this.monitor.unref();
  }

  async monitorExit(generation) {
    if (this.monitoring || !this.active(generation)) return;
    this.monitoring = true;
    try { await this.confirmExit(generation); }
    catch (error) { this.events.log('SYSTEM', error.message, 'tag-warn'); }
    finally { this.monitoring = false; }
  }

  async confirmExit(generation) {
    // An updater may replace the original main process. Keep CDP alive across its short
    // process-free gap; never spawn/kill anything or run account/kernel startup hooks again.
    for (const delay of [0, 1000, 2000]) {
      if (!this.active(generation)) return;
      if (delay) await this.wait(delay);
      if (!this.active(generation)) return;
      let running;
      try { running = await this.desktop.running({ strict: true }); }
      catch (error) {
        if (this.active(generation)) {
          this.events.log('SYSTEM', `暂时无法确认 AG 进程状态：${error.message}`, 'tag-warn');
          this.startMonitor(generation);
        }
        return; // An unavailable process query is not evidence that AG has exited.
      }
      if (!this.active(generation)) return;
      if (running) {
        if (!this.monitor) this.startMonitor(generation);
        this.events.publish(this.snapshot());
        return;
      }
    }
    if (this.active(generation)) await this.finish('Antigravity 已关闭');
  }

  async finish(reason) {
    if (this.finishing) return this.finishing;
    ++this.generation; // Invalidate child-exit probes and attached-process polls before any await.
    this.child = null;
    this.finishing = (async () => {
      clearInterval(this.monitor);
      this.monitor = null;
      // Anything started when AG came up has to be torn down here: this is the single exit path —
      // the child exiting, the attach poll giving up, and close() all funnel through it. A teardown
      // failure must not block the shutdown, so it is logged and swallowed.
      if (this.onExit) {
        try {
          await this.onExit();
        } catch (error) {
          this.events.log('SYSTEM', `AG 退出收尾失败：${error.message}`, 'tag-warn');
        }
      }
      await this.cdp.stop();
      this.child = null;
      this.change('idle');
      this.events.log('SYSTEM', reason, 'tag-proxy');
      return { ok: true };
    })();
    try { return await this.finishing; } finally { this.finishing = null; }
  }

  async close(reason) {
    this.closed = true;
    this.generation++;
    return this.finish(reason);
  }
}

module.exports = { Session };
