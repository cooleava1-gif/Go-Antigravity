const bundledPackage = require('../package.json');

const UPDATES_DISABLED = 'UPDATES_DISABLED';
const UPDATES_DISABLED_MESSAGE = '此独立版本已永久禁用代码与词典在线更新';

// Kept for older local consumers: downloaded runtime directories are never executable roots.
function resolveRuntimeRoot(bundledRoot) {
  return bundledRoot;
}

class Updater {
  currentState() {
    return {
      name: bundledPackage.name,
      edition: bundledPackage.edition,
      version: bundledPackage.version,
      bundledVersion: bundledPackage.version,
      dictVersion: '内置词典',
      lastCheckedAt: null,
      restartRequired: false,
      updatesEnabled: false
    };
  }

  async checkAndApply() {
    throw Object.assign(new Error(UPDATES_DISABLED_MESSAGE), {
      code: UPDATES_DISABLED,
      status: 410
    });
  }
}

module.exports = { Updater, resolveRuntimeRoot, UPDATES_DISABLED, UPDATES_DISABLED_MESSAGE };
