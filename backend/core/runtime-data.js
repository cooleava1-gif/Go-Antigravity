const os = require('node:os');
const path = require('node:path');

function packagedDataDirectory(environment) {
  const base = environment.LOCALAPPDATA?.trim()
    || environment.APPDATA?.trim()
    || path.join(os.homedir(), 'AppData', 'Local');
  return path.resolve(base, 'Go-Antigravity');
}

function resolveDataDirectory(backendRoot, environment) {
  const configured = environment.GO_ANTIGRAVITY_DATA_DIR?.trim();
  if (configured) return path.resolve(path.dirname(backendRoot), configured);
  if (environment.GO_ANTIGRAVITY_PACKAGED === '1') return packagedDataDirectory(environment);
  return path.resolve(path.dirname(backendRoot), '.go-antigravity-data');
}

module.exports = { packagedDataDirectory, resolveDataDirectory };
