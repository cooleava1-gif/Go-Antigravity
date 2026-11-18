const path = require('node:path');

function resolveDataDirectory(backendRoot, environment) {
  const configured = environment.GO_ANTIGRAVITY_DATA_DIR?.trim();
  return path.resolve(path.dirname(backendRoot), configured || '.go-antigravity-data');
}

module.exports = { resolveDataDirectory };
