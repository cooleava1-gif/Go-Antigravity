const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { redactSecrets } = require('./redact');

class Events extends EventEmitter {
  constructor(dataDir) {
    super();
    this.setMaxListeners(0);
    this.file = path.join(dataDir, 'goagy.log');
    this.history = [];
  }

  log(category, message, cls = '') {
    // Single choke point: every line here is persisted to disk and streamed into the UI console,
    // so credentials must be stripped here instead of trusting each call site to be careful.
    const item = { at: new Date().toISOString(), category, message: redactSecrets(message), cls };
    this.history.push(item);
    if (this.history.length > 300) this.history.shift();
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 2 * 1024 * 1024) {
        fs.renameSync(this.file, this.file + '.previous');
      }
      fs.appendFileSync(this.file, JSON.stringify(item) + '\n');
    } catch { /* Logging must not prevent configuration recovery. */ }
    this.emit('message', item);
    return item;
  }

  publish(message) { this.emit('message', message); }
  logs(limit = 100) { return this.history.slice(-Math.min(Math.max(limit, 1), 300)); }
}

module.exports = { Events };
