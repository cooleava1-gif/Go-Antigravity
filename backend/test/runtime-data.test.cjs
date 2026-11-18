'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { resolveDataDirectory } = require('../core/runtime-data');

const checkout = path.join(os.tmpdir(), 'synthetic-go-antigravity');
const backendRoot = path.join(checkout, 'backend');

test('default data directory ignores old runtime and local app-data settings', () => {
  const legacy = path.join(os.tmpdir(), 'synthetic-old-data');
  assert.equal(resolveDataDirectory(backendRoot, { EASYAG_DATA_DIR: legacy, LOCALAPPDATA: legacy }),
    path.join(checkout, '.go-antigravity-data'));
  assert.equal(resolveDataDirectory(backendRoot, { GO_ANTIGRAVITY_DATA_DIR: '  ' }),
    path.join(checkout, '.go-antigravity-data'));
});

test('explicit independent relative data directory resolves from checkout, not cwd', () => {
  assert.equal(resolveDataDirectory(backendRoot, { GO_ANTIGRAVITY_DATA_DIR: '  fixture data  ' }),
    path.join(checkout, 'fixture data'));
});

test('explicit independent absolute data directory stays absolute', () => {
  const absolute = path.join(os.tmpdir(), 'synthetic-custom-go-antigravity-data');
  assert.equal(resolveDataDirectory(backendRoot, { GO_ANTIGRAVITY_DATA_DIR: absolute }), absolute);
});
