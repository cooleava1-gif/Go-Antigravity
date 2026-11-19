'use strict';
// Synthetic AMD64 PE32+ / Go embed.FS fixtures only; no installed binary is read or run.
// All process execution is stubbed, including writer fallback paths.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Every tested patcher uses a child_process stub, including all writer fallback paths.
function loadPatcher(fsOverrides = {}) {
  const filename = require.resolve('../features/kernel-patch');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const context = {
    module, Buffer, process, setTimeout,
    require(name) {
      if (name === 'node:fs') return { ...fs, ...fsOverrides };
      if (name === 'node:child_process') return { execFile() { throw new Error('process execution forbidden in kernel tests'); } };
      return localRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}

function setupPatchCase(t, buffer = buildKernel()) {
  const target = place(tempTarget(), buffer);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-kernel-home-'));
  t.after(() => {
    fs.rmSync(target.dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const config = path.join(home, '.gemini', 'config', 'config.json');
  const cliConfig = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const originalConfig = JSON.stringify({ theme: 'dark', contextWindow: '512K', other: { keep: true } }) + '\n';
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(path.dirname(cliConfig), { recursive: true });
  fs.writeFileSync(config, originalConfig);
  fs.writeFileSync(cliConfig, originalConfig);
  return { target, home, config, cliConfig, originalConfig };
}

function assertConfigUnchanged(fixture) {
  assert.strictEqual(fs.readFileSync(fixture.config, 'utf8'), fixture.originalConfig);
  assert.strictEqual(fs.readFileSync(fixture.cliConfig, 'utf8'), fixture.originalConfig);
}

const {
  AD_SLOTS, BLOAT_SLOTS, CORE_SLOTS, CONTEXT_SIGNATURES, PROMPT_TIERS, CONTEXT_MODES, SLOT_CAPACITY,
  CUSTOM_PROMPT_CAPACITY, validateCustomPrompt, customPromptMetadata,
  normalizePromptTier, normalizeContextMode, parseEmbedTemplates, computeActiveBytes, writePaddedTemplate,
  detectPromptTier, detectPromptState, detectContextMode, inspectContextGates, applyPromptTier, applyContextPatch,
  syncContextWindowConfig, detectConfiguredContextCap, inspectKernel, applyKernelPatch, resolveTargets,
  verifyBackupMatches
} = loadPatcher();

const RAW_PTR = 0x200;
const RAW_SIZE = 0x8000;
const V_ADDR = 0x1000;
const IMAGE_BASE = 0x140000000n;
const NAMES_OFF = 0x800;
const DATA_OFF = 0x1000;
const ENTRIES_OFF = 0x300;
const SIGNATURES_OFF = 0x5000;
const APPLY_EDITS_OFF = 0x5400;
const IDENTITY_MARKER = 'You are Antigravity, a powerful agentic AI coding assistant';

// Synthetic template entries place identity.tmpl within the parser's ±12-entry scan.
const TEMPLATES = [
  ['artifacts.tmpl', 400],
  ['communication_style.tmpl', 2792],
  ['conversation_transcript.tmpl', 800],
  ['function_call.tmpl', 605],
  ['guidelines.tmpl', 691],
  ['identity.tmpl', 200],
  ['knowledge_items.tmpl', 600],
  ['persistent_context.tmpl', 500],
  ['planning_mode_artifacts.tmpl', 450],
  ['plugins.tmpl', 700],
  ['slash_commands.tmpl', 900],
  ['tool_declarations.tmpl', 300],
  ['user_instructions.tmpl', 300]
];
const IDENTITY_INDEX = TEMPLATES.findIndex(([name]) => name === 'identity.tmpl');
const PREFIX = 'google3/third_party/jetski/prompt/template_provider/templates/system_prompts/';

function va(fileOffset) {
  return IMAGE_BASE + BigInt(V_ADDR + (fileOffset - RAW_PTR));
}

function buildKernel() {
  const file = Buffer.alloc(RAW_PTR + RAW_SIZE, 0);
  file.write('MZ', 0, 'ascii');
  file.writeUInt32LE(0x40, 0x3c);
  file.write('PE\0\0', 0x40, 'ascii');
  file.writeUInt16LE(0x8664, 0x44);
  file.writeUInt16LE(1, 0x46);
  file.writeUInt16LE(240, 0x54);
  file.writeUInt16LE(0x20b, 0x58);
  file.writeBigUInt64LE(IMAGE_BASE, 0x70);
  const table = 0x58 + 240;
  file.write('.text\0\0\0', table, 'ascii');
  file.writeUInt32LE(RAW_SIZE, table + 8);
  file.writeUInt32LE(V_ADDR, table + 12);
  file.writeUInt32LE(RAW_SIZE, table + 16);
  file.writeUInt32LE(RAW_PTR, table + 20);

  // Names blob, then data blob. Sizes are fixed up front so offsets never depend on content.
  let nameCursor = NAMES_OFF;
  let dataCursor = DATA_OFF;
  const placements = [];
  for (const [name, size] of TEMPLATES) {
    placements.push({ name, size, nameOffset: nameCursor, dataOffset: dataCursor });
    nameCursor += PREFIX.length + name.length;
    dataCursor += size;
  }
  for (const placement of placements) {
    file.write(PREFIX + placement.name, placement.nameOffset, 'utf8');
    const body = placement.name === 'identity.tmpl'
      ? IDENTITY_MARKER + ' ' + 'x'.repeat(placement.size - IDENTITY_MARKER.length - 1)
      : `${placement.name} official body `.padEnd(placement.size, '.').slice(0, placement.size);
    file.write(body, placement.dataOffset, 'utf8');
  }

  // Go embed.FS entry slice: {name *string, nameLen, data *string, dataLen, ...} = 48 bytes each.
  for (const [index, placement] of placements.entries()) {
    const entry = ENTRIES_OFF + index * 48;
    file.writeBigUInt64LE(va(placement.nameOffset), entry);
    file.writeBigUInt64LE(BigInt(PREFIX.length + placement.name.length), entry + 8);
    file.writeBigUInt64LE(va(placement.dataOffset), entry + 16);
    file.writeBigUInt64LE(BigInt(placement.size), entry + 24);
  }

  for (const [index, signature] of CONTEXT_SIGNATURES.entries()) {
    file.write(signature.stock, SIGNATURES_OFF + index * 64, 'hex');
  }
  file.write('488b71104889742458488b711848897424384889d1', APPLY_EDITS_OFF, 'hex');
  file.write('e800000000', APPLY_EDITS_OFF + 21, 'hex'); // 5-byte call strings.Count
  file.write('4883f8010f8474ffffff', APPLY_EDITS_OFF + 26, 'hex');
  return file;
}

function tempTarget(name = 'language_server.exe') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-kernel-'));
  return { dir, path: path.join(dir, 'bin', name), backupPath: path.join(dir, 'bin', `${name}.bak`) };
}

function place(target, buffer) {
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, buffer);
  return target;
}

function read(target) {
  return fs.readFileSync(target.path);
}

function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-home-'));
  try { return run(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('tier and mode normalisation accepts the documented spellings and rejects junk', () => {
  for (const value of ['0', 'restore', 'stock', 'reset', undefined, null, '']) {
    assert.strictEqual(normalizePromptTier(value), 'stock', `tier ${value}`);
  }
  for (const value of ['1', '2', '3', '4', 'tier4', 'TIER3']) {
    assert.ok(PROMPT_TIERS[normalizePromptTier(value)], `tier ${value}`);
  }
  assert.strictEqual(normalizePromptTier('9'), null);
  assert.strictEqual(normalizeContextMode('1m'), '900k');
  assert.strictEqual(normalizeContextMode('900K'), '900k');
  assert.strictEqual(normalizeContextMode('512'), '512k');
  assert.strictEqual(normalizeContextMode('restore'), 'stock');
  assert.strictEqual(normalizeContextMode('2m'), null);
  assert.strictEqual(CONTEXT_MODES['900k'].tokens, 983040);
  assert.strictEqual(CONTEXT_MODES['512k'].tokens, 512000);
  assert.strictEqual(CONTEXT_MODES.stock.tokens, 0);
});

test('resolveTargets honours GOAGY_AG_EXE for the desktop kernel', () => {
  const explicit = 'D:/portable/Antigravity/Antigravity.exe';
  const targets = resolveTargets({ GOAGY_AG_EXE: explicit });
  assert.strictEqual(targets[0].path, 'D:/portable/Antigravity/resources/bin/language_server.exe'.replace(/\//g, path.sep));
  assert.strictEqual(targets[0].backupPath, targets[0].path + '.bak');
  assert.strictEqual(targets[1].id, 'ide');
});

test('PE parser reads every template slot out of a synthetic kernel', () => {
  const slots = parseEmbedTemplates(buildKernel());
  assert.strictEqual(slots.size, TEMPLATES.length);
  for (const [name] of TEMPLATES) assert.ok(slots.has(`system_prompts/${name}`), name);
  const identity = slots.get('system_prompts/identity.tmpl');
  assert.ok(identity.activeBytes > 0);
  assert.strictEqual(identity.stripped, false);
});

const SECTION_TABLE = 0x58 + 240;

function splitKernelSection(buffer, boundary) {
  buffer.writeUInt16LE(2, 0x46);
  for (const [index, start, end] of [[0, RAW_PTR, boundary], [1, boundary, buffer.length]]) {
    const section = SECTION_TABLE + index * 40;
    buffer.fill(0, section, section + 40);
    buffer.writeUInt32LE(end - start, section + 8);
    buffer.writeUInt32LE(V_ADDR + start - RAW_PTR, section + 12);
    buffer.writeUInt32LE(end - start, section + 16);
    buffer.writeUInt32LE(start, section + 20);
  }
}

function invalidPeFixtures() {
  const cases = [
    ['missing MZ', buffer => buffer.write('ZZ', 0, 'ascii')],
    ['x86 machine', buffer => buffer.writeUInt16LE(0x14c, 0x44)],
    ['ARM64 machine', buffer => buffer.writeUInt16LE(0xaa64, 0x44)],
    ['PE32 magic', buffer => buffer.writeUInt16LE(0x10b, 0x58)],
    ['ROM magic', buffer => buffer.writeUInt16LE(0x107, 0x58)],
    ['short optional header', buffer => {
      const section = Buffer.from(buffer.subarray(SECTION_TABLE, SECTION_TABLE + 40));
      buffer.writeUInt16LE(32, 0x54);
      section.copy(buffer, 0x58 + 32);
    }],
    ['incomplete fixed optional header', buffer => {
      const section = Buffer.from(buffer.subarray(SECTION_TABLE, SECTION_TABLE + 40));
      buffer.writeUInt16LE(111, 0x54);
      section.copy(buffer, 0x58 + 111);
    }],
    ['raw section past EOF', buffer => buffer.writeUInt32LE(RAW_SIZE + 1, SECTION_TABLE + 16)],
    ['overflowing RVA span', buffer => buffer.writeUInt32LE(0xffffffff, SECTION_TABLE + 8)],
    ['overlapping raw sections', buffer => {
      buffer.writeUInt16LE(2, 0x46);
      const section = SECTION_TABLE + 40;
      buffer.writeUInt32LE(0x100, section + 8);
      buffer.writeUInt32LE(0xa000, section + 12);
      buffer.writeUInt32LE(0x100, section + 16);
      buffer.writeUInt32LE(0x7000, section + 20);
    }],
    ['overlapping virtual sections', buffer => {
      splitKernelSection(buffer, 0x7000);
      buffer.writeUInt32LE(V_ADDR + 0x100, SECTION_TABLE + 40 + 12);
    }],
    ['raw data overlaps headers', buffer => {
      const delta = RAW_PTR;
      buffer.writeUInt32LE(0, SECTION_TABLE + 20);
      buffer.writeUInt32LE(RAW_PTR + RAW_SIZE, SECTION_TABLE + 16);
      buffer.writeUInt32LE(RAW_PTR + RAW_SIZE, SECTION_TABLE + 8);
      for (let index = 0; index < TEMPLATES.length; index++) {
        const entry = ENTRIES_OFF + index * 48;
        for (const field of [0, 16]) buffer.writeBigUInt64LE(buffer.readBigUInt64LE(entry + field) + BigInt(delta), entry + field);
      }
    }]
  ];
  return cases.map(([name, mutate]) => {
    const buffer = buildKernel();
    mutate(buffer);
    return { name, buffer };
  });
}

function invalidTemplateFixtures() {
  const cases = [];
  const add = (name, slot, mutate) => {
    const buffer = buildKernel();
    mutate(buffer);
    cases.push({ name, slot: 'system_prompts/' + slot, buffer });
  };
  add('zero-filled virtual tail', 'communication_style.tmpl', buffer => {
    buffer.writeUInt32LE(0x1000, SECTION_TABLE + 16);
  });
  add('data crosses one raw section byte', 'artifacts.tmpl', buffer => {
    splitKernelSection(buffer, DATA_OFF + TEMPLATES[0][1] - 1);
  });
  add('name crosses one raw section byte', 'artifacts.tmpl', buffer => {
    splitKernelSection(buffer, NAMES_OFF + PREFIX.length + TEMPLATES[0][0].length - 1);
  });
  add('identity path crosses raw section', 'identity.tmpl', buffer => {
    const start = Number(buffer.readBigUInt64LE(ENTRIES_OFF + IDENTITY_INDEX * 48) - IMAGE_BASE) - V_ADDR + RAW_PTR;
    splitKernelSection(buffer, start + PREFIX.length + 'identity.tmpl'.length - 1);
  });
  add('identity entry crosses raw section', 'identity.tmpl', buffer => {
    splitKernelSection(buffer, ENTRIES_OFF + IDENTITY_INDEX * 48 + 47);
  });
  return cases;
}

test('PE parser rejects incompatible headers and malformed or ambiguous sections', async t => {
  for (const { name, buffer } of invalidPeFixtures()) {
    await t.test(name, () => {
      assert.throws(() => parseEmbedTemplates(buffer), /PE|MZ|架构|节|可选头/);
    });
  }
});

test('PE parser never exposes templates outside one complete raw section', async t => {
  for (const { name, slot, buffer } of invalidTemplateFixtures()) {
    await t.test(name, () => {
      let slots;
      try { slots = parseEmbedTemplates(buffer); } catch (error) {
        assert.match(error.message, /节|映射|槽位|条目/);
      }
      if (slots) assert.strictEqual(slots.has(slot), false, name + ' must not return an unsafe slot');
      const output = Buffer.from(buffer);
      assert.throws(() => applyPromptTier(output, buffer, '4'), /节|映射|槽位|条目/);
      assert.ok(output.equals(buffer), 'validation must precede every output write');
    });
  }
});

test('PE parser preserves exact raw ends, adjacent sections and 64-bit pointer precision', () => {
  const original = buildKernel();
  const split = Buffer.from(original);
  splitKernelSection(split, DATA_OFF);
  assert.strictEqual(parseEmbedTemplates(split).size, TEMPLATES.length, 'adjacent sections are unambiguous');
  const last = TEMPLATES.length - 1;
  const entry = ENTRIES_OFF + last * 48;
  const start = Number(original.readBigUInt64LE(entry + 16) - IMAGE_BASE) - V_ADDR + RAW_PTR;
  const rawPadding = Buffer.from(original);
  rawPadding.writeUInt32LE(RAW_SIZE - 0x200, SECTION_TABLE + 8);
  const tailStart = rawPadding.length - TEMPLATES[last][1];
  original.copy(rawPadding, tailStart, start, start + TEMPLATES[last][1]);
  rawPadding.writeBigUInt64LE(va(tailStart), entry + 16);
  const tailSlots = parseEmbedTemplates(rawPadding);
  assert.strictEqual(tailSlots.size, TEMPLATES.length, 'raw alignment padding stays file-backed');
  assert.strictEqual(tailSlots.get('system_prompts/' + TEMPLATES[last][0]).dataOffset, tailStart);
  const exactEnd = Buffer.from(original);
  exactEnd.writeUInt32LE(start + TEMPLATES[last][1] - RAW_PTR, SECTION_TABLE + 8);
  exactEnd.writeUInt32LE(start + TEMPLATES[last][1] - RAW_PTR, SECTION_TABLE + 16);
  assert.strictEqual(parseEmbedTemplates(exactEnd).size, TEMPLATES.length, 'exclusive raw end accepts an exact fit');
  const highBase = Buffer.from(original), nextBase = 0x20000000000000n;
  highBase.writeBigUInt64LE(nextBase, 0x70);
  for (let index = 0; index < TEMPLATES.length; index++) {
    for (const field of [0, 16]) {
      const offset = ENTRIES_OFF + index * 48 + field;
      highBase.writeBigUInt64LE(highBase.readBigUInt64LE(offset) - IMAGE_BASE + nextBase, offset);
    }
  }
  const slots = parseEmbedTemplates(highBase);
  assert.strictEqual(slots.size, TEMPLATES.length);
  for (const [name, slot] of parseEmbedTemplates(original)) {
    assert.strictEqual(slots.get(name).dataOffset, slot.dataOffset, name);
    assert.strictEqual(slots.get(name).dataLength, slot.dataLength, name);
  }
  for (const field of [8, 24]) {
    const invalid = Buffer.from(original);
    invalid.writeBigUInt64LE(0x20000000000001n, ENTRIES_OFF + field);
    assert.strictEqual(parseEmbedTemplates(invalid).has('system_prompts/artifacts.tmpl'), false, 'oversized uint64 is never rounded into a slot');
  }
});

test('invalid PE fixtures fail before backup creation or config publication', async t => {
  for (const { name, buffer } of [...invalidPeFixtures(), ...invalidTemplateFixtures()]) {
    await t.test(name, async t => {
      const fixture = setupPatchCase(t, buffer);
      const result = await applyKernelPatch({ promptTier: '4', contextMode: '512k' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(result.ok, false, name);
      assert.ok(read(fixture.target).equals(buffer));
      assert.strictEqual(fs.existsSync(fixture.target.backupPath), false);
      assertConfigUnchanged(fixture);
    });
  }
});

test('a stock kernel reports stock tier and stock context gates', () => {
  const buffer = buildKernel();
  const slots = parseEmbedTemplates(buffer);
  assert.strictEqual(detectPromptTier(slots, buffer), 'stock');
  assert.strictEqual(detectContextMode(buffer), 'stock');
  assert.strictEqual(inspectContextGates(buffer).length, CONTEXT_SIGNATURES.length);
  for (const gate of inspectContextGates(buffer)) assert.strictEqual(gate.mode, 'stock');
});

test('balanced v2 rewrites only core slots and preserves every auxiliary template and identity', () => {
  const original = buildKernel();
  const buffer = Buffer.from(original);
  const backup = Buffer.from(original);
  const slots = parseEmbedTemplates(original);
  applyPromptTier(buffer, backup, '4', slots);

  for (const name of BLOAT_SLOTS) {
    assert.strictEqual(slots.get(name).stripped, false, 'fixture sanity');
    const slot = slots.get(name);
    assert.ok(buffer.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).equals(original.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength)), name + ' preserved');
  }
  const guidelines = buffer.toString('utf8', slots.get('system_prompts/guidelines.tmpl').dataOffset, slots.get('system_prompts/guidelines.tmpl').dataOffset + slots.get('system_prompts/guidelines.tmpl').dataLength);
  assert.ok(guidelines.startsWith('Goagy balanced v2'));
  const style = buffer.toString('utf8', slots.get('system_prompts/communication_style.tmpl').dataOffset, slots.get('system_prompts/communication_style.tmpl').dataOffset + slots.get('system_prompts/communication_style.tmpl').dataLength);
  assert.ok(style.includes('Do not fabricate symbols'));
  assert.ok(buffer.toString('utf8', slots.get('system_prompts/identity.tmpl').dataOffset, slots.get('system_prompts/identity.tmpl').dataOffset + slots.get('system_prompts/identity.tmpl').dataLength).includes(IDENTITY_MARKER));
  assert.strictEqual(detectPromptTier(parseEmbedTemplates(buffer), buffer), '4');
  // Slot byte lengths never change, so no PE offset can move.
  assert.strictEqual(buffer.length, original.length);
  for (const [name, slot] of parseEmbedTemplates(buffer)) {
    assert.strictEqual(slot.dataLength, parseEmbedTemplates(original).get(name).dataLength, name);
  }
});

test('each tier is detected after being applied, and restore returns to the exact original', () => {
  const original = buildKernel();
  const buffer = Buffer.from(original);
  const backup = Buffer.from(original);
  const slots = parseEmbedTemplates(original);
  for (const tier of ['1', '2', '3', '4']) {
    applyPromptTier(buffer, backup, tier, slots);
    assert.strictEqual(detectPromptTier(parseEmbedTemplates(buffer), buffer), tier, `tier ${tier}`);
  }
  applyPromptTier(buffer, backup, 'stock', slots);
  assert.strictEqual(detectPromptTier(parseEmbedTemplates(buffer), buffer), 'stock');
  assert.ok(buffer.equals(original), 'restore must be byte-identical to the original image');
});

test('tier 1 only touches the two advertising slots', () => {
  const original = buildKernel();
  const buffer = Buffer.from(original);
  applyPromptTier(buffer, Buffer.from(original), '1', parseEmbedTemplates(original));
  const slots = parseEmbedTemplates(buffer);
  for (const name of AD_SLOTS) assert.strictEqual(slots.get(name).stripped, true, name);
  for (const name of BLOAT_SLOTS.filter(name => !AD_SLOTS.includes(name))) {
    assert.strictEqual(slots.get(name).stripped, false, name);
  }
  assert.strictEqual(slots.get('system_prompts/guidelines.tmpl').stripped, false);
});

test('tier switching is idempotent and independent of the previous tier', () => {
  const original = buildKernel();
  const backup = Buffer.from(original);
  const slots = parseEmbedTemplates(original);
  const once = Buffer.from(original);
  applyPromptTier(once, backup, '4', slots);
  const twice = Buffer.from(original);
  applyPromptTier(twice, backup, '3', slots);
  applyPromptTier(twice, backup, '4', slots);
  assert.ok(twice.equals(once), '4 after 3 must equal 4 applied directly');

  const patched = Buffer.from(once);
  applyPromptTier(patched, backup, '4', slots);
  assert.ok(patched.equals(once), 're-applying the active tier changes nothing');
});

test('the applyEdits startup check is bypassed for every non-stock tier and restored for stock', () => {
  const original = buildKernel();
  const backup = Buffer.from(original);
  const slots = parseEmbedTemplates(original);
  const stock = '4883f8010f8474ffffff';
  const bypass = '4883f801e975ffffff90';
  assert.ok(original.toString('hex').includes(stock));
  const buffer = Buffer.from(original);
  applyPromptTier(buffer, backup, '2', slots);
  assert.ok(!buffer.toString('hex').includes(stock), 'stock tail must be gone');
  assert.ok(buffer.toString('hex').includes(bypass), 'bypass tail must be present');
  applyPromptTier(buffer, backup, 'stock', slots);
  assert.ok(buffer.toString('hex').includes(stock), 'stock tail must be restored');
  assert.ok(!buffer.toString('hex').includes(bypass));
});

test('a damaged identity block aborts the patch instead of writing it', () => {
  const original = buildKernel();
  const backup = Buffer.from(original);
  const identity = parseEmbedTemplates(original).get('system_prompts/identity.tmpl');
  backup.write('TAMPERED', identity.dataOffset, 'utf8');
  assert.throws(() => applyPromptTier(Buffer.from(original), backup, '4', parseEmbedTemplates(original)), /identity\.tmpl/);
});

test('every prompt payload fits the smallest slot it can land in', () => {
  for (const tier of ['3', '4']) {
    for (const name of CORE_SLOTS) {
      const group = require('../features/kernel-prompt-payloads.json').tiers[tier === '3' ? 'tier3' : 'tier4'];
      const key = name.endsWith('guidelines.tmpl') ? 'guidelines' : name.endsWith('function_call.tmpl') ? 'functionCall' : 'communicationStyle';
      assert.ok(Buffer.byteLength(group[key]) <= SLOT_CAPACITY[name], `${tier}/${name} overflows`);
    }
  }
});

test('writePaddedTemplate refuses to overflow a slot and pads with a render-nothing comment', () => {
  const buffer = Buffer.alloc(64, 0x20);
  const slot = { name: 'guidelines.tmpl', dataOffset: 8, dataLength: 32 };
  assert.strictEqual(writePaddedTemplate(buffer, slot, 'abc'), 3);
  assert.strictEqual(buffer.toString('utf8', 8, 11), 'abc');
  const tail = buffer.toString('utf8', 11, 40);
  assert.ok(tail.startsWith('{{- /*') && tail.endsWith('*/ -}}'), tail);
  assert.strictEqual(computeActiveBytes(tail).active, 0);
  assert.throws(() => writePaddedTemplate(buffer, slot, 'x'.repeat(33)), /超出槽位容量/);
});

test('context patches rewrite every signature and are reversible', () => {
  const original = buildKernel();
  const backup = Buffer.from(original);
  for (const mode of ['900k', '512k', 'stock']) {
    const buffer = Buffer.from(original);
    const gates = applyContextPatch(buffer, backup, mode);
    assert.strictEqual(gates.length, CONTEXT_SIGNATURES.length, mode);
    assert.strictEqual(detectContextMode(buffer), mode, mode);
    for (const gate of gates) assert.ok(gate.offset >= 0);
  }
  const restored = Buffer.from(original);
  applyContextPatch(restored, backup, '900k');
  applyContextPatch(restored, backup, 'stock');
  assert.ok(restored.equals(original));
  // A patch is anchored on the backup, so re-applying over an already-patched image is a no-op.
  const again = Buffer.from(original);
  applyContextPatch(again, backup, '900k');
  applyContextPatch(again, backup, '900k');
  assert.strictEqual(detectContextMode(again), '900k');
});

test('context config sync writes and removes the contextWindow key', () => {
  withHome(home => {
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'config', 'config.json'), JSON.stringify({ theme: 'dark' }) + '\n');
    syncContextWindowConfig('900k', home);
    const written = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'config.json'), 'utf8'));
    assert.strictEqual(written.contextWindow, '900K');
    assert.strictEqual(written.theme, 'dark', 'unrelated keys must survive');
    assert.strictEqual(detectConfiguredContextCap(home), 983040);
    syncContextWindowConfig('stock', home);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'config.json'), 'utf8')).contextWindow, undefined);
    assert.strictEqual(detectConfiguredContextCap(home), 0);
  });
});

test('context config sync leaves a non-existent config directory alone', () => {
  withHome(home => {
    assert.strictEqual(detectConfiguredContextCap(home), 0);
    const logs = syncContextWindowConfig('900k', home);
    assert.ok(fs.existsSync(path.join(home, '.gemini', 'config')) === false, 'must not create config dirs');
    assert.strictEqual(logs.length, 0);
  });
});

test('a backup from a different build is refused instead of corrupting the kernel', () => {
  const original = buildKernel();
  // Simulate an AG upgrade: same file size, but the template slots moved.
  const upgraded = Buffer.from(original);
  const slots = parseEmbedTemplates(upgraded);
  const identity = slots.get('system_prompts/identity.tmpl');
  upgraded.write('You are Antigravity, a powerful agentic AI coding assistant', identity.dataOffset, 'utf8');
  upgraded.write('artifacts.tmpl official body', slots.get('system_prompts/artifacts.tmpl').dataOffset, 'utf8');
  const shifted = Buffer.from(original);
  const moved = parseEmbedTemplates(shifted);
  const victim = moved.get('system_prompts/guidelines.tmpl');
  // Re-point the guidelines entry at a different data offset, as a relayout would.
  const entry = ENTRIES_OFF + TEMPLATES.findIndex(([name]) => name === 'guidelines.tmpl') * 48;
  original.copy(shifted, 0x6800, victim.dataOffset, victim.dataOffset + victim.dataLength);
  shifted.writeBigUInt64LE(va(0x6800), entry + 16);
  assert.strictEqual(parseEmbedTemplates(shifted).get('system_prompts/guidelines.tmpl').dataOffset, 0x6800);
  assert.notStrictEqual(verifyBackupMatches(upgraded, shifted), null);
  assert.strictEqual(verifyBackupMatches(original, original), null);
});

test('inspectKernel reports a missing kernel without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-inspect-'));
  try {
    const result = inspectKernel({ targets: [{ id: 'desktop', label: 'x', path: path.join(dir, 'nope.exe'), backupPath: path.join(dir, 'nope.exe.bak') }] });
    assert.strictEqual(result.targets[0].exists, false);
    assert.strictEqual(result.targets[0].error, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyKernelPatch backs up once, patches, then reports a no-op second run', async () => {
  const target = place(tempTarget(), buildKernel());
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'goagy-home-'));
    // Leave config directories for products the user never ran untouched.
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    try {
      const first = await applyKernelPatch({ promptTier: '4', contextMode: '900k' }, { targets: [target], homeDir: home });
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.ok(fs.existsSync(target.backupPath), 'backup must be created');
      assert.ok(fs.readFileSync(target.backupPath).equals(buildKernel()), 'backup must remain pristine');
      assert.ok(read(target).toString('hex').includes('e975ffffff90'), 'applyEdits bypass applied');
      assert.strictEqual(detectContextMode(read(target)), '900k');
      assert.strictEqual(detectPromptTier(parseEmbedTemplates(read(target)), read(target)), '4');
      assert.strictEqual(detectConfiguredContextCap(home), 983040);

      const second = await applyKernelPatch({ promptTier: '4', contextMode: '900k' }, { targets: [target], homeDir: home });
      assert.strictEqual(second.ok, true);
      assert.ok(second.logs.some(line => line.includes('无需写入')), second.logs.join('\n'));
      assert.ok(read(target).equals(fs.readFileSync(target.backupPath)) === false, 'still patched');

      const restore = await applyKernelPatch({ promptTier: 'stock', contextMode: 'stock' }, { targets: [target], homeDir: home });
      assert.strictEqual(restore.ok, true, JSON.stringify(restore));
      assert.ok(read(target).equals(buildKernel()), 'restore must reproduce the pristine image');
      assert.strictEqual(detectConfiguredContextCap(home), 0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally { fs.rmSync(path.dirname(target.path), { recursive: true, force: true }); }
});

test('applying one axis leaves the other axis untouched', async () => {
  const original = buildKernel();
  const target = place(tempTarget(), original);
  try {
    await applyKernelPatch({ promptTier: '4' }, { targets: [target], homeDir: target.dir });
    const afterPrompt = read(target);
    assert.strictEqual(detectContextMode(afterPrompt), 'stock', 'prompt-only patch must not touch context bytes');
    assert.strictEqual(detectPromptTier(parseEmbedTemplates(afterPrompt), afterPrompt), '4');

    await applyKernelPatch({ contextMode: '900k' }, { targets: [target], homeDir: target.dir });
    const afterContext = read(target);
    assert.strictEqual(detectPromptTier(parseEmbedTemplates(afterContext), afterContext), '4', 'context-only patch must not reset prompt tiers');
    assert.strictEqual(detectContextMode(afterContext), '900k');

    await applyKernelPatch({ promptTier: 'stock', contextMode: 'stock' }, { targets: [target], homeDir: target.dir });
    assert.ok(read(target).equals(original));
  } finally { fs.rmSync(path.dirname(target.path), { recursive: true, force: true }); }
});

test('applyKernelPatch rejects unknown axes and reports a tampered backup as a failure', async () => {
  const target = place(tempTarget(), buildKernel());
  try {
    await assert.rejects(() => applyKernelPatch({ promptTier: '7' }, { targets: [target] }), /未知的提示词档位/);
    await assert.rejects(() => applyKernelPatch({ contextMode: '2m' }, { targets: [target] }), /未知的上下文档位/);
    await assert.rejects(() => applyKernelPatch({}, { targets: [target] }), /没有需要应用的内核变更/);

    await applyKernelPatch({ promptTier: '4' }, { targets: [target], homeDir: target.dir });
    const identity = parseEmbedTemplates(read(target)).get('system_prompts/identity.tmpl');
    const before = read(target);
    const backup = fs.readFileSync(target.backupPath);
    backup.write('BROKEN', identity.dataOffset, 'utf8');
    fs.writeFileSync(target.backupPath, backup);
    const failed = await applyKernelPatch({ promptTier: '3' }, { targets: [target], homeDir: target.dir });
    assert.strictEqual(failed.ok, false);
    assert.ok(failed.errors.some(line => line.includes('identity.tmpl')), failed.errors.join('\n'));
    assert.ok(read(target).equals(before), 'a failed patch must leave the previous state on disk');
  } finally { fs.rmSync(path.dirname(target.path), { recursive: true, force: true }); }
});

test('non-stock context refuses an otherwise valid kernel with zero known signatures', async t => {
  const original = buildKernel();
  for (const signature of CONTEXT_SIGNATURES) {
    const bytes = Buffer.from(signature.stock, 'hex');
    original.fill(0, original.indexOf(bytes), original.indexOf(bytes) + bytes.length);
  }
  assert.strictEqual(inspectContextGates(original).length, 0);
  assert.throws(() => applyContextPatch(Buffer.from(original), original, '900k'), /未找到.*签名/);
  const fixture = setupPatchCase(t, original);
  const result = await applyKernelPatch({ promptTier: '4', contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join('\n'), /未找到.*签名/);
  assert.ok(read(fixture.target).equals(original), 'neither axis may reach disk after context verification fails');
  assertConfigUnchanged(fixture);
});

test('context patch validates every occurrence and refuses an unanchored mixed gate', () => {
  const original = buildKernel();
  const duplicateOffset = SIGNATURES_OFF + 400;
  original.write(CONTEXT_SIGNATURES[0].stock, duplicateOffset, 'hex');
  const next = Buffer.from(original);
  const gates = applyContextPatch(next, original, '900k');
  assert.strictEqual(gates.length, CONTEXT_SIGNATURES.length + 1);
  assert.ok(inspectContextGates(next).every(gate => gate.mode === '900k'));
  applyContextPatch(next, original, 'stock');
  assert.ok(next.equals(original));

  const mixed = buildKernel();
  mixed.write(CONTEXT_SIGNATURES[0].stock, duplicateOffset, 'hex');
  const backup = buildKernel();
  assert.throws(() => applyContextPatch(mixed, backup, '900k'), /并非所有 gate/);
  assert.strictEqual(detectContextMode(mixed), '900k', 'aggregate mode alone conceals the stock duplicate');
  assert.ok(inspectContextGates(mixed).some(gate => gate.mode === 'stock'));
});

test('stale or unreadable backups fail without changing either config file', async t => {
  for (const kind of ['shifted', 'invalid-pe']) {
    await t.test(kind, async t => {
      const original = buildKernel();
      const fixture = setupPatchCase(t, original);
      const backup = Buffer.from(original);
      if (kind === 'shifted') {
        const slot = parseEmbedTemplates(backup).get('system_prompts/guidelines.tmpl');
        const entry = ENTRIES_OFF + TEMPLATES.findIndex(([name]) => name === 'guidelines.tmpl') * 48;
        backup.writeBigUInt64LE(va(slot.dataOffset + 64), entry + 16);
      } else backup.fill(0, 0x40, 0x44);
      fs.writeFileSync(fixture.target.backupPath, backup);
      const result = await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.length > 0);
      assert.ok(read(fixture.target).equals(original));
      assertConfigUnchanged(fixture);
    });
  }
});

test('modified kernels are never accepted as new or existing pristine backups', async t => {
  const mutations = {
    prompt(buffer, original) { applyPromptTier(buffer, original, '4'); },
    context(buffer) { buffer.write(CONTEXT_SIGNATURES[1].k512, SIGNATURES_OFF + 64, 'hex'); },
    applyEdits(buffer) { buffer.write('4883f801e975ffffff90', APPLY_EDITS_OFF + 26, 'hex'); },
    partialPrompt(buffer) {
      writePaddedTemplate(buffer, parseEmbedTemplates(buffer).get('system_prompts/plugins.tmpl'), '');
    },
    identity(buffer) {
      const identity = parseEmbedTemplates(buffer).get('system_prompts/identity.tmpl');
      buffer.write('BROKEN', identity.dataOffset, 'utf8');
    }
  };
  for (const [kind, mutate] of Object.entries(mutations)) {
    for (const existingBackup of [false, true]) {
      await t.test(kind + (existingBackup ? ' fake bak' : ' no bak'), async t => {
        const original = buildKernel();
        const modified = Buffer.from(original);
        mutate(modified, original);
        const fixture = setupPatchCase(t, modified);
        if (existingBackup) fs.writeFileSync(fixture.target.backupPath, modified);
        const result = await applyKernelPatch({ promptTier: 'stock', contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
        assert.strictEqual(result.ok, false, JSON.stringify(result));
        assert.match(result.errors.join('\n'), /不能作为原始备份/);
        assert.ok(read(fixture.target).equals(modified));
        assert.strictEqual(fs.existsSync(fixture.target.backupPath), existingBackup, 'rejected current bytes must not seed a backup');
        if (existingBackup) assert.ok(fs.readFileSync(fixture.target.backupPath).equals(modified));
        assertConfigUnchanged(fixture);
      });
    }
  }
});

test('a malformed current PE fails before creating a backup', async t => {
  const fixture = setupPatchCase(t, Buffer.from('not a PE image'));
  const before = read(fixture.target);
  const result = await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(fs.existsSync(fixture.target.backupPath), false);
  assert.ok(read(fixture.target).equals(before));
  assertConfigUnchanged(fixture);
});

test('a silent short write fails disk verification and never syncs config', async t => {
  const fixture = setupPatchCase(t);
  let calls = 0;
  const patcher = loadPatcher({ writeSync() { calls++; return 0; } });
  const result = await patcher.applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(result.ok, false);
  assert.ok(calls > 0, 'the injected writer must be reached');
  assert.match(result.errors.join('\n'), /内核写入后回读校验失败/);
  assert.ok(!result.logs.some(line => line.startsWith('[完成]')));
  assert.ok(read(fixture.target).equals(buildKernel()));
  assertConfigUnchanged(fixture);
});

test('disk readback checks every gate even when aggregate mode matches the request', async t => {
  const fixture = setupPatchCase(t);
  let once = false;
  let writes = 0;
  const patcher = loadPatcher({
    writeSync(fd, buffer, offset, length, position) {
      writes++;
      const written = fs.writeSync(fd, buffer, offset, length, position);
      if (!once) {
        once = true;
        const bytes = Buffer.from(CONTEXT_SIGNATURES[0].stock, 'hex');
        fs.writeSync(fd, bytes, 0, bytes.length, SIGNATURES_OFF);
      }
      return written;
    }
  });
  const result = await patcher.applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(result.ok, false);
  assert.ok(writes > 0);
  assert.ok(read(fixture.target).equals(buildKernel()), 'disk verification failure must roll back every changed byte');
  assert.match(result.errors.join('\n'), /回读校验失败/);
  assertConfigUnchanged(fixture);
});

test('any target failure rolls back the whole round before publishing config', async t => {
  for (const failure of ['stale-backup', 'write-error']) {
    await t.test(failure, async t => {
      const fixture = setupPatchCase(t);
      const failedTarget = place(tempTarget('failed.exe'), buildKernel());
      t.after(() => fs.rmSync(failedTarget.dir, { recursive: true, force: true }));
      if (failure === 'stale-backup') fs.writeFileSync(failedTarget.backupPath, Buffer.alloc(8));
      let deniedWrites = 0;
      const patcher = loadPatcher(failure === 'write-error' ? {
        openSync(file, flags) {
          if (file === failedTarget.path && flags === 'r+') { deniedWrites++; throw new Error('injected open failure'); }
          return fs.openSync(file, flags);
        },
        renameSync(from, to) {
          if (from === failedTarget.path) throw new Error('injected rename failure');
          return fs.renameSync(from, to);
        }
      } : {});
      const result = await patcher.applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target, failedTarget], homeDir: fixture.home });
      assert.strictEqual(result.ok, false);
      assert.ok(result.errors.some(line => line.includes(failedTarget.path)));
      assert.ok(read(fixture.target).equals(buildKernel()), 'earlier target must be restored');
      assert.ok(read(failedTarget).equals(buildKernel()));
      if (failure === 'write-error') assert.ok(deniedWrites > 0);
      assertConfigUnchanged(fixture);
    });
  }
});

test('no installed targets is a failure and cannot publish a context setting', async t => {
  const fixture = setupPatchCase(t);
  const absent = { ...fixture.target, path: path.join(fixture.target.dir, 'missing.exe') };
  for (const targets of [[], [absent]]) {
    const result = await applyKernelPatch({ contextMode: '900k' }, { targets, homeDir: fixture.home });
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join('\n'), /未找到.*内核/);
    assertConfigUnchanged(fixture);
  }
});

function filesUnder(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  }).sort();
}

function assertNoTransactionTemps(fixture) {
  for (const root of [fixture.home, fixture.target.dir]) {
    assert.deepStrictEqual(filesUnder(root).filter(file => /\.goagy-.*\.tmp$|\.old_run$/.test(file)), []);
  }
}

test('config parse, shape, stage and silent-stage failures fail closed before any binary changes', async t => {
  for (const failure of ['invalid-json', 'invalid-shape', 'duplicate-key', 'invalid-utf8', 'write-error', 'silent-write']) {
    await t.test(failure, async t => {
      const fixture = setupPatchCase(t);
      if (failure === 'invalid-json') fs.writeFileSync(fixture.config, '{broken json');
      if (failure === 'invalid-shape') fs.writeFileSync(fixture.config, '[]\n');
      if (failure === 'duplicate-key') fs.writeFileSync(fixture.config, '{"theme":1,"theme":2}\n');
      if (failure === 'invalid-utf8') fs.writeFileSync(fixture.config, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([255]), Buffer.from('"}')]));
      const before = fs.readFileSync(fixture.config), beforeCli = fs.readFileSync(fixture.cliConfig);
      let attempts = 0;
      const patcher = loadPatcher({
        writeFileSync(file, ...args) {
          if (String(file).startsWith(fixture.config + '.goagy-')) {
            attempts++;
            if (failure === 'write-error') throw new Error('injected config stage failure');
            if (failure === 'silent-write') return;
          }
          return fs.writeFileSync(file, ...args);
        }
      });
      const result = await patcher.applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(result.ok, false, JSON.stringify(result));
      assert.ok(result.errors.some(line => line.includes(fixture.config)));
      assert.ok(result.logs.some(line => line.includes(fixture.config) && line.includes('失败')));
      assert.ok(fs.readFileSync(fixture.config).equals(before));
      assert.ok(fs.readFileSync(fixture.cliConfig).equals(beforeCli));
      assert.ok(read(fixture.target).equals(buildKernel()));
      assert.strictEqual(fs.existsSync(fixture.target.backupPath), false);
      if (failure.includes('write')) assert.strictEqual(attempts, 1);
      const errors = [];
      assert.ok(Array.isArray(patcher.syncContextWindowConfig('900k', fixture.home, errors)));
      assert.ok(errors.some(line => line.includes(fixture.config)));
      assertNoTransactionTemps(fixture);
    });
  }
});

test('second config stage/rename faults restore both exact JSON texts and the previous binary state', async t => {
  for (const initialMode of ['stock', '512k']) {
    for (const failure of ['stage-partial', 'rename', 'rename-after-effect', 'rename-silent']) {
      await t.test(initialMode + '/' + failure, async t => {
        const fixture = setupPatchCase(t);
        if (initialMode !== 'stock') {
          const first = await applyKernelPatch({ contextMode: initialMode }, { targets: [fixture.target], homeDir: fixture.home });
          assert.strictEqual(first.ok, true, JSON.stringify(first));
        }
        const roots = [fixture.home, fixture.target.dir];
        const beforeFiles = roots.flatMap(filesUnder).sort();
        const snapshots = beforeFiles.map(file => [file, fs.readFileSync(file)]);
        const binaryBefore = read(fixture.target);
        let stageWrites = 0, faults = 0;
        const patcher = loadPatcher({
          writeFileSync(file, bytes, ...args) {
            if (failure === 'stage-partial' && String(file).startsWith(fixture.cliConfig + '.goagy-') && ++stageWrites === 2) {
              fs.writeFileSync(file, Buffer.from(bytes).subarray(0, 7), ...args);
              faults++;
              throw new Error('injected partial second config stage');
            }
            return fs.writeFileSync(file, bytes, ...args);
          },
          renameSync(from, to) {
            if (failure !== 'stage-partial' && to === fixture.cliConfig && faults++ === 0) {
              if (failure === 'rename-after-effect') fs.renameSync(from, to);
              if (failure === 'rename-silent') return;
              throw new Error('injected second config rename');
            }
            return fs.renameSync(from, to);
          }
        });
        const result = await patcher.applyKernelPatch({ promptTier: '4', contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
        assert.strictEqual(result.ok, false, JSON.stringify(result));
        assert.ok(faults > 0, 'fault injection must be reached');
        assert.ok(!result.logs.some(line => line.startsWith('[完成]')));
        assert.ok(read(fixture.target).equals(binaryBefore), 'binary restores prior state, including previously applied modes');
        assert.deepStrictEqual(roots.flatMap(filesUnder).sort(), beforeFiles, 'no new backup, state or temp file remains');
        for (const [file, bytes] of snapshots) assert.ok(fs.readFileSync(file).equals(bytes), file);
        assertNoTransactionTemps(fixture);
      });
    }
  }
});

test('stock restores original custom values and exact BOM/format while preserving later unrelated fields', async t => {
  const fixture = setupPatchCase(t);
  const original = '\uFEFF{\r\n\t"contextWindow" : "custom-384K",\r\n\t"theme" : "dark",\r\n\t"nested" : {"s":"escaped \\" } ","a":[1,{"x":true}]}\r\n}\r\n';
  fs.writeFileSync(fixture.config, original);
  fs.writeFileSync(fixture.cliConfig, original);
  const first = await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(detectConfiguredContextCap(fixture.home), 983040);
  const firstFiles = filesUnder(fixture.home);
  const sidecar = fixture.config + '.goagy-context.json';
  const saved = fs.readFileSync(sidecar);
  for (let index = 0; index < 3; index++) {
    const result = await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.deepStrictEqual(filesUnder(fixture.home), firstFiles);
    assert.ok(fs.readFileSync(sidecar).equals(saved), 'no-op does not replace the ownership record');
  }
  assert.strictEqual(syncContextWindowConfig('512k', fixture.home, []).length, 2);
  const cliUpdated = fs.readFileSync(fixture.cliConfig, 'utf8').replace('"dark"', '"light"').replace('\r\n}', ',\r\n\t"later" : {"keep":true}\r\n}');
  fs.writeFileSync(fixture.cliConfig, cliUpdated);
  const switched = await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(switched.ok, true, JSON.stringify(switched));
  const restored = await applyKernelPatch({ contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(restored.ok, true, JSON.stringify(restored));
  assert.strictEqual(fs.readFileSync(fixture.config, 'utf8'), original, 'unchanged config round trips byte-for-byte');
  assert.strictEqual(fs.readFileSync(fixture.cliConfig, 'utf8'), cliUpdated.replace('"512K"', '"custom-384K"'));
  assert.deepStrictEqual(filesUnder(fixture.home), [fixture.cliConfig, fixture.config].sort());
  assertNoTransactionTemps(fixture);
});

test('stock respects unowned fields, absent fields and files, and newly added user data', () => {
  for (const existed of [false, true]) {
    for (const laterEdit of [false, true]) {
      withHome(home => {
        const file = path.join(home, '.gemini', 'config', 'config.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const original = '{ "theme" : "dark" }\n';
        if (existed) fs.writeFileSync(file, original);
        const errors = [];
        syncContextWindowConfig('900k', home, errors);
        assert.deepStrictEqual(errors, []);
        if (laterEdit) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('}', ', "userAdded": 7}'));
        syncContextWindowConfig('stock', home, errors);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(fs.existsSync(file), existed || laterEdit);
        if (laterEdit) {
          const object = JSON.parse(fs.readFileSync(file, 'utf8'));
          assert.strictEqual(object.userAdded, 7);
          assert.strictEqual(Object.hasOwn(object, 'contextWindow'), false);
        } else if (existed) assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
        assert.deepStrictEqual(filesUnder(home), existed || laterEdit ? [file] : []);
      });
    }
  }
  withHome(home => {
    const file = path.join(home, '.gemini', 'config', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = '{"contextWindow":"custom","theme":"dark"}\n';
    fs.writeFileSync(file, original);
    syncContextWindowConfig('stock', home);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
    assert.deepStrictEqual(filesUnder(home), [file]);
  });
});

test('unknown recovery records and externally changed owned values fail closed', async t => {
  for (const kind of ['bad-json', 'unknown-version', 'external-change']) {
    await t.test(kind, async t => {
      const fixture = setupPatchCase(t);
      assert.strictEqual((await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home })).ok, true);
      const stateFile = fixture.config + '.goagy-context.json';
      if (kind === 'bad-json') fs.writeFileSync(stateFile, '{oops');
      if (kind === 'unknown-version') fs.writeFileSync(stateFile, '{"version":2}\n');
      if (kind === 'external-change') fs.writeFileSync(fixture.config, '{"contextWindow":"user-custom","theme":"new"}\n');
      const files = [...filesUnder(fixture.home), ...filesUnder(fixture.target.dir)];
      const snapshots = files.map(file => [file, fs.readFileSync(file)]);
      const result = await applyKernelPatch({ contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(result.ok, false, JSON.stringify(result));
      for (const [file, bytes] of snapshots) assert.ok(fs.readFileSync(file).equals(bytes), file);
      assertNoTransactionTemps(fixture);
    });
  }
});
test('stock failure restores owned state so a retry recovers the original custom values', async t => {
  const fixture = setupPatchCase(t);
  assert.strictEqual((await applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home })).ok, true);
  const roots = [fixture.home, fixture.target.dir], files = roots.flatMap(filesUnder).sort();
  const snapshots = files.map(file => [file, fs.readFileSync(file)]);
  let faults = 0;
  const patcher = loadPatcher({
    renameSync(from, to) {
      if (to === fixture.cliConfig && faults++ === 0) throw new Error('injected stock rename failure');
      return fs.renameSync(from, to);
    }
  });
  const failed = await patcher.applyKernelPatch({ contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(failed.ok, false, JSON.stringify(failed));
  for (const [file, bytes] of snapshots) assert.ok(fs.readFileSync(file).equals(bytes), file);
  assert.deepStrictEqual(roots.flatMap(filesUnder).sort(), files);
  const retry = await applyKernelPatch({ contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(retry.ok, true, JSON.stringify(retry));
  assertConfigUnchanged(fixture);
  assertNoTransactionTemps(fixture);
});

test('rollback failures explicitly report recovery snapshots and never claim completion', async t => {
  const fixture = setupPatchCase(t);
  const patcher = loadPatcher({
    renameSync(from, to) {
      if (to === fixture.cliConfig || to === fixture.target.path) throw new Error('injected rename/rollback lock');
      return fs.renameSync(from, to);
    }
  });
  const result = await patcher.applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.ok(result.errors.some(message => message.startsWith('回滚 ') && message.includes(fixture.target.path)));
  assert.ok(result.errors.some(message => message.includes('恢复快照：')));
  assert.ok(!result.logs.some(line => line.startsWith('[完成]') || line.startsWith('[回滚] 已恢复')));
  const recovery = filesUnder(fixture.target.dir).filter(file => /\.goagy-.*\.tmp$/.test(file));
  assert.strictEqual(recovery.length, 1, 'retain exactly the snapshot needed for explicit manual recovery');
  assert.ok(fs.readFileSync(recovery[0]).equals(buildKernel()));
  assertConfigUnchanged(fixture);
  assert.deepStrictEqual(filesUnder(fixture.home), [fixture.cliConfig, fixture.config].sort());
});

test('JSON member surgery handles every position and JSON value type without changing other bytes', () => {
  const customValues = [null, false, 384000, 'quoted " and slash ' + String.fromCharCode(92), { x: [1, { s: '}' }] }].map(value => JSON.stringify(value));
  for (const literal of customValues) {
    for (const position of ['first', 'middle', 'last', 'only']) {
      withHome(home => {
        const file = path.join(home, '.gemini', 'config', 'config.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const before = '"before": {"a":[true,"}"]}', context = '"contextWindow" : ' + literal, after = '"after": 1e3';
        const body = position === 'only' ? context : position === 'first' ? context + ', ' + after
          : position === 'last' ? before + ', ' + context : before + ', ' + context + ', ' + after;
        const original = '\uFEFF{ ' + body + ' }\r\n';
        fs.writeFileSync(file, original);
        const errors = [];
        syncContextWindowConfig('900k', home, errors);
        assert.deepStrictEqual(errors, [], original);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), original.replace(context, '"contextWindow" : "900K"'));
        syncContextWindowConfig('stock', home, errors);
        assert.deepStrictEqual(errors, []);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
        assert.deepStrictEqual(filesUnder(home), [file]);
      });
    }
  }
});

test('overlapping apply and direct sync cannot interleave with an active transaction', async t => {
  const fixture = setupPatchCase(t);
  const patcher = loadPatcher();
  const active = patcher.applyKernelPatch({ contextMode: '900k' }, { targets: [fixture.target], homeDir: fixture.home });
  const deniedPromise = patcher.applyKernelPatch({ contextMode: '512k' }, { targets: [fixture.target], homeDir: fixture.home });
  const errors = [];
  patcher.syncContextWindowConfig('stock', fixture.home, errors);
  assert.match(errors.join(' '), /事务正在进行/);
  const denied = await deniedPromise;
  assert.strictEqual(denied.ok, false);
  assert.match(denied.errors.join(' '), /事务正在进行/);
  const completed = await active;
  assert.strictEqual(completed.ok, true, JSON.stringify(completed));
  assert.strictEqual(detectContextMode(read(fixture.target)), '900k');
  assert.strictEqual(detectConfiguredContextCap(fixture.home), 983040);
  const restore = await patcher.applyKernelPatch({ contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(restore.ok, true, JSON.stringify(restore));
  assertConfigUnchanged(fixture);
  assertNoTransactionTemps(fixture);
});

test('official, compact and custom are visible while balanced and legacy keys remain readable', () => {
  assert.deepStrictEqual(Object.values(PROMPT_TIERS).filter(tier => tier.visible).map(tier => tier.key).sort(), ['3', 'custom', 'stock']);
  assert.strictEqual(normalizePromptTier('official'), 'stock');
  assert.strictEqual(normalizePromptTier('balanced'), '4');
  assert.strictEqual(normalizePromptTier('compact'), '3');
  assert.strictEqual(normalizePromptTier('custom'), 'custom');
  assert.strictEqual(normalizePromptTier('replace'), 'custom');
  for (const key of ['1', '2', '4']) {
    assert.strictEqual(normalizePromptTier(key), key);
    assert.strictEqual(PROMPT_TIERS[key].visible, false);
  }
  assert.strictEqual(normalizePromptTier('toString'), null);
  assert.strictEqual(normalizePromptTier('__proto__'), null);
});

test('custom prompt helpers enforce the exact 3960-byte UTF-8 contract', () => {
  const { createHash } = require('node:crypto');
  const prefix = '先读取再断言 · Unicode ✓ ';
  const text = prefix + 'x'.repeat(CUSTOM_PROMPT_CAPACITY - Buffer.byteLength(prefix, 'utf8'));
  assert.strictEqual(CUSTOM_PROMPT_CAPACITY, 3960);
  assert.strictEqual(validateCustomPrompt(text), text);
  const metadata = customPromptMetadata(text);
  assert.deepStrictEqual(metadata, {
    bytes: Buffer.byteLength(text, 'utf8'),
    hash: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    capacity: 3960
  });
  assert.strictEqual(metadata.hash.length, 64);
  assert.strictEqual(metadata.bytes, 3960);
  for (const invalid of ['', null, undefined, 1, {}, [], 'has\u0000nul', '{{ template }}', 'a }} b', '{{- /*', '*/ -}}', 'x'.repeat(3961), '✓'.repeat(1321)]) {
    assert.throws(() => validateCustomPrompt(invalid), /自定义|文本|UTF-8|NUL|模板|容量|3960|4088/);
  }
  assert.strictEqual(normalizeContextMode('1m'), '900k');
  assert.strictEqual(normalizeContextMode('max'), '900k');
  assert.strictEqual(CONTEXT_MODES['900k'].tokens, 983040);
  assert.strictEqual(CONTEXT_MODES['512k'].tokens, 512000);
});

test('custom prompt replaces exactly the three core slots and remains byte-verifiable', () => {
  const original = buildKernel(), slots = parseEmbedTemplates(original);
  const prefix = '仅替换核心指令层。';
  const text = prefix + 'A'.repeat(CUSTOM_PROMPT_CAPACITY - Buffer.byteLength(prefix, 'utf8'));
  assert.strictEqual(Buffer.byteLength(text, 'utf8'), 3960);
  assert.strictEqual(CORE_SLOTS.length, 3);
  const coreBytes = CORE_SLOTS.reduce((sum, name) => sum + slots.get(name).dataLength, 0);
  assert.strictEqual(coreBytes, 4088);
  const buffer = Buffer.from(original);
  const result = applyPromptTier(buffer, original, 'custom', undefined, undefined, text);
  assert.strictEqual(result.strippedBytes, 0);
  assert.strictEqual(buffer.length, original.length);
  const allowed = [...CORE_SLOTS.map(name => slots.get(name)), { dataOffset: APPLY_EDITS_OFF + 26, dataLength: 10 }];
  for (let offset = 0; offset < buffer.length; offset++) {
    if (buffer[offset] !== original[offset]) assert.ok(allowed.some(slot => offset >= slot.dataOffset && offset < slot.dataOffset + slot.dataLength), 'unexpected byte ' + offset);
  }
  for (const [name, slot] of slots) if (!CORE_SLOTS.includes(name)) {
    assert.ok(buffer.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).equals(original.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength)), name);
  }
  const state = detectPromptState(parseEmbedTemplates(buffer), buffer);
  assert.strictEqual(state.tier, 'custom');
  assert.strictEqual(state.payloadVersion, 3);
  assert.strictEqual(state.legacy, false);
  assert.strictEqual(state.customText, text);
  assert.strictEqual(state.customHash, customPromptMetadata(text).hash);
  assert.strictEqual(state.customBytes, 3960);
  assert.strictEqual(verifyBackupMatches(buffer, original), null);
  const restored = Buffer.from(buffer);
  applyPromptTier(restored, original, 'stock');
  assert.ok(restored.equals(original), 'custom prompt exact restore');
});

test('inspect and apply expose custom metadata without echoing full custom text', async t => {
  const fixture = setupPatchCase(t);
  const text = '自定义核心指令：核验后汇报。';
  const applied = await applyKernelPatch({ promptTier: 'custom', contextMode: '900k', promptText: text }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(applied.ok, true, JSON.stringify(applied));
  const inspected = inspectKernel({ targets: [fixture.target] }).targets[0];
  assert.strictEqual(inspected.customHash, customPromptMetadata(text).hash);
  assert.strictEqual(inspected.customBytes, Buffer.byteLength(text, 'utf8'));
  assert.strictEqual(JSON.stringify(inspected).includes(text), false);
  const restored = await applyKernelPatch({ promptTier: 'stock', contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
  assert.strictEqual(restored.ok, true, JSON.stringify(restored));
});

test('legacy payload fingerprints are frozen independently of current payload updates', () => {
  const { createHash } = require('node:crypto');
  const payloads = require('../features/kernel-prompt-payloads.json');
  assert.strictEqual(payloads.version, 2);
  const hashes = {
    tier3: 'ff933d9f9e2e0e705a67dbe4e8defcf8da4611e7be170504f7cc765964ec2f98',
    tier4: 'a24d654ee5f53d01ff87c848992b6869a5dcc13dbb8ccc56c3651bb2b3b5557b'
  };
  for (const [key, expected] of Object.entries(hashes)) {
    assert.strictEqual(createHash('sha256').update(JSON.stringify(payloads.legacyTiers[key])).digest('hex'), expected);
  }
});

test('new tiers fit measured UTF-8 budgets and retain essential evidence and tool rules', () => {
  const groups = require('../features/kernel-prompt-payloads.json').tiers;
  const budgets = { tier3: [459, 405, 1250], tier4: [614, 566, 2222] };
  for (const [tier, group] of Object.entries(groups)) {
    assert.deepStrictEqual(Object.values(group).map(text => Buffer.byteLength(text, 'utf8')), budgets[tier]);
    const text = Object.values(group).join('\n');
    for (const phrase of ['higher-priority instructions', 'before editing', 'unique', 'before retry', 'unverified assumptions', 'test outcomes', 'current sources', 'do not guarantee correctness']) {
      assert.ok(text.includes(phrase), tier + ': ' + phrase);
    }
    for (const invented of ['March 2026', 'read_file', 'edit_file', 'invoke_subagent', 'ArtifactMetadata', 'file:///']) {
      assert.ok(!text.includes(invented), tier + ': ' + invented);
    }
  }
  assert.ok(Object.values(groups.tier3).reduce((n, text) => n + Buffer.byteLength(text), 0)
    < Object.values(groups.tier4).reduce((n, text) => n + Buffer.byteLength(text), 0));
});

test('new tier writes are confined to three core slots and the known startup tail', () => {
  const original = buildKernel(), slots = parseEmbedTemplates(original);
  for (const tier of ['3', '4']) {
    const buffer = Buffer.from(original);
    const result = applyPromptTier(buffer, original, tier);
    assert.strictEqual(result.strippedBytes, 0);
    assert.strictEqual(result.payloadVersion, 2);
    assert.strictEqual(buffer.length, original.length);
    const allowed = [...CORE_SLOTS.map(name => slots.get(name)), { dataOffset: APPLY_EDITS_OFF + 26, dataLength: 10 }];
    for (let offset = 0; offset < buffer.length; offset++) {
      if (buffer[offset] !== original[offset]) assert.ok(allowed.some(slot => offset >= slot.dataOffset && offset < slot.dataOffset + slot.dataLength), 'unexpected byte ' + offset);
    }
    for (const [name, slot] of slots) if (!CORE_SLOTS.includes(name)) {
      assert.ok(buffer.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).equals(original.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength)), name);
    }
  }
});

test('legacy tiers keep precise payload versions and restore the exact control bytes', () => {
  const original = buildKernel();
  for (const tier of ['1', '2', '3', '4']) {
    const patched = Buffer.from(original);
    applyPromptTier(patched, original, tier, undefined, 1);
    const state = detectPromptState(parseEmbedTemplates(patched), patched);
    assert.strictEqual(state.tier, tier);
    assert.strictEqual(state.payloadVersion, 1);
    assert.strictEqual(state.legacy, true);
    assert.strictEqual(verifyBackupMatches(patched, original), null);
    applyPromptTier(patched, original, 'stock');
    assert.ok(patched.equals(original), 'legacy ' + tier + ' exact restore');
  }
});

test('all complete legacy and new prompt/context combinations match only their exact backup', () => {
  const original = buildKernel();
  for (const [tier, version] of [['stock', 2], ['1', 1], ['2', 1], ['3', 1], ['4', 1], ['3', 2], ['4', 2]]) {
    for (const mode of ['stock', '512k', '900k']) {
      const buffer = Buffer.from(original);
      applyPromptTier(buffer, original, tier, undefined, version);
      applyContextPatch(buffer, original, mode);
      assert.strictEqual(verifyBackupMatches(buffer, original), null, tier + '/' + version + '/' + mode);
      buffer[0x7000] ^= 1;
      assert.match(verifyBackupMatches(buffer, original), /区域之外|篡改/, 'same-layout changed code must fail');
    }
  }
});

test('marker-only, mixed, damaged and future prompt payloads are never reported as a known tier', () => {
  const original = buildKernel();
  const mutations = [
    buffer => { applyPromptTier(buffer, original, '4', undefined, 1); const slot = parseEmbedTemplates(buffer).get(CORE_SLOTS[0]); buffer[slot.dataOffset + 20] ^= 1; },
    buffer => { applyPromptTier(buffer, original, '4'); writePaddedTemplate(buffer, parseEmbedTemplates(buffer).get(CORE_SLOTS[1]), require('../features/kernel-prompt-payloads.json').tiers.tier3.functionCall); },
    buffer => { writePaddedTemplate(buffer, parseEmbedTemplates(buffer).get(CORE_SLOTS[0]), 'Argon Grounding Override'); },
    buffer => { writePaddedTemplate(buffer, parseEmbedTemplates(buffer).get(CORE_SLOTS[0]), 'Goagy balanced v3'); },
    buffer => { applyPromptTier(buffer, original, '4'); writePaddedTemplate(buffer, parseEmbedTemplates(buffer).get(BLOAT_SLOTS[0]), ''); }
  ];
  for (const mutate of mutations) {
    const buffer = Buffer.from(original);
    mutate(buffer);
    assert.strictEqual(detectPromptTier(parseEmbedTemplates(buffer), buffer), 'unknown');
    assert.notStrictEqual(verifyBackupMatches(buffer, original), null);
  }
  const changedCore = Buffer.from(original), slot = parseEmbedTemplates(original).get(CORE_SLOTS[0]);
  changedCore[slot.dataOffset + 10] ^= 1;
  assert.notStrictEqual(verifyBackupMatches(changedCore, original), null, 'unknown full-length core text also fails byte comparison');
});

test('unrecognized or ambiguous startup signatures and missing slots fail before output mutation', () => {
  for (const kind of ['missing-tail', 'duplicate-prefix', 'missing-slot', 'small-slot', 'duplicate-anchor', 'duplicate-entry', 'duplicate-slot', 'overlapping-slot', 'damaged-identity']) {
    const backup = buildKernel();
    if (kind === 'missing-tail') backup.fill(0, APPLY_EDITS_OFF, APPLY_EDITS_OFF + 36);
    if (kind === 'duplicate-prefix') backup.write('488b71104889742458488b711848897424384889d1', 0x7100, 'hex');
    const entry = ENTRIES_OFF + TEMPLATES.findIndex(([name]) => name === 'guidelines.tmpl') * 48;
    if (kind === 'missing-slot') backup.writeBigUInt64LE(0n, entry + 24);
    if (kind === 'small-slot') backup.writeBigUInt64LE(12n, entry + 24);
    if (kind === 'duplicate-anchor') backup.write(PREFIX + 'identity.tmpl', 0x7100, 'utf8');
    const identityEntry = ENTRIES_OFF + TEMPLATES.findIndex(([name]) => name === 'identity.tmpl') * 48;
    if (kind === 'duplicate-entry') backup.copy(backup, 0x7100, identityEntry, identityEntry + 16);
    if (kind === 'duplicate-slot') backup.copy(backup, entry, ENTRIES_OFF, ENTRIES_OFF + 16);
    if (kind === 'overlapping-slot') {
      const otherEntry = ENTRIES_OFF + TEMPLATES.findIndex(([name]) => name === 'function_call.tmpl') * 48;
      backup.writeBigUInt64LE(backup.readBigUInt64LE(otherEntry + 16), entry + 16);
    }
    if (kind === 'damaged-identity') {
      const identityOffset = Number(backup.readBigUInt64LE(identityEntry + 16) - IMAGE_BASE) - V_ADDR + RAW_PTR;
      backup.fill(0, identityOffset, identityOffset + 10);
    }
    const output = Buffer.from(backup), before = Buffer.from(output);
    assert.throws(() => applyPromptTier(output, backup, '4'), /签名|槽位|容量|不唯一|重叠|重复|身份/);
    assert.ok(output.equals(before), kind + ' must not mutate output');
  }
});

test('active byte accounting measures UTF-8 bytes and preserves unicode previews', () => {
  const slot = { name: 'synthetic', dataOffset: 0, dataLength: 80 };
  const buffer = Buffer.alloc(80);
  const text = '证据🧪';
  writePaddedTemplate(buffer, slot, text);
  assert.strictEqual(computeActiveBytes(buffer.toString('utf8')).active, Buffer.byteLength(text, 'utf8'));
  assert.strictEqual(computeActiveBytes(text).active, Buffer.byteLength(text, 'utf8'));
});

test('legacy status survives context-only changes and migrates only on explicit new prompt apply', async t => {
  for (const tier of ['1', '2', '3', '4']) {
    await t.test('legacy ' + tier, async t => {
      const original = buildKernel(), legacy = Buffer.from(original);
      applyPromptTier(legacy, original, tier, undefined, 1);
      const fixture = setupPatchCase(t, legacy);
      fs.writeFileSync(fixture.target.backupPath, original);
      const before = inspectKernel({ targets: [fixture.target] }).targets[0];
      assert.strictEqual(before.promptTier, tier);
      assert.strictEqual(before.promptPayloadVersion, 1);
      assert.strictEqual(before.promptLegacy, true);
      const context = await applyKernelPatch({ contextMode: '512k' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(context.ok, true, JSON.stringify(context));
      const after = inspectKernel({ targets: [fixture.target] }).targets[0];
      assert.strictEqual(after.promptTier, tier);
      assert.strictEqual(after.promptPayloadVersion, 1);
      for (const name of parseEmbedTemplates(legacy).keys()) {
        const slot = parseEmbedTemplates(legacy).get(name);
        assert.ok(read(fixture.target).subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).equals(legacy.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength)), name);
      }
      const explicit = await applyKernelPatch({ promptTier: 'balanced' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(explicit.ok, true, JSON.stringify(explicit));
      const upgraded = inspectKernel({ targets: [fixture.target] }).targets[0];
      assert.strictEqual(upgraded.promptTier, '4');
      assert.strictEqual(upgraded.promptPayloadVersion, 2);
      assert.strictEqual(upgraded.promptLegacy, false);
      const restore = await applyKernelPatch({ promptTier: 'stock', contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(restore.ok, true, JSON.stringify(restore));
      assert.ok(read(fixture.target).equals(original));
      assertConfigUnchanged(fixture);
    });
  }
});

test('public apply rejects new legacy selections without changing fixture files', async t => {
  const fixture = setupPatchCase(t);
  for (const tier of ['1', '2']) {
    await assert.rejects(() => applyKernelPatch({ promptTier: tier }, { targets: [fixture.target], homeDir: fixture.home }), /仅兼容识别和还原/);
    assert.ok(read(fixture.target).equals(buildKernel()));
    assert.strictEqual(fs.existsSync(fixture.target.backupPath), false);
    assertConfigUnchanged(fixture);
  }
});

test('same-layout tampering and mixed context fail closed without overwriting the prior state', async t => {
  for (const kind of ['code', 'core', 'auxiliary', 'mixed-context']) {
    await t.test(kind, async t => {
      const original = buildKernel(), changed = Buffer.from(original), slots = parseEmbedTemplates(original);
      if (kind === 'code') changed[0x7000] ^= 1;
      if (kind === 'core') changed[slots.get(CORE_SLOTS[0]).dataOffset + 5] ^= 1;
      if (kind === 'auxiliary') changed[slots.get(BLOAT_SLOTS[0]).dataOffset + 5] ^= 1;
      if (kind === 'mixed-context') changed.write(CONTEXT_SIGNATURES[0].k512, SIGNATURES_OFF, 'hex');
      const fixture = setupPatchCase(t, changed);
      fs.writeFileSync(fixture.target.backupPath, original);
      const result = await applyKernelPatch({ promptTier: '4', contextMode: 'stock' }, { targets: [fixture.target], homeDir: fixture.home });
      assert.strictEqual(result.ok, false, JSON.stringify(result));
      assert.ok(read(fixture.target).equals(changed));
      assert.ok(fs.readFileSync(fixture.target.backupPath).equals(original));
      assertConfigUnchanged(fixture);
      assertNoTransactionTemps(fixture);
    });
  }
});

test('optional synthetic artifacts retain exact sizes, hashes and restoration evidence', () => {
  const root = process.env.GOAGY_KERNEL_EVIDENCE_DIR;
  if (!root) return;
  const { createHash } = require('node:crypto');
  fs.mkdirSync(root, { recursive: true });
  const original = buildKernel(), artifacts = [{ name: 'synthetic-original.bin', bytes: original }];
  for (const [tier, version, name] of [['3', 2, 'synthetic-compact-v2.bin'], ['4', 2, 'synthetic-balanced-v2.bin'], ['4', 1, 'synthetic-legacy4-v1.bin']]) {
    const bytes = Buffer.from(original);
    applyPromptTier(bytes, original, tier, undefined, version);
    assert.strictEqual(bytes.length, original.length);
    assert.strictEqual(verifyBackupMatches(bytes, original), null);
    artifacts.push({ name, bytes });
  }
  const restored = Buffer.from(artifacts[3].bytes);
  applyPromptTier(restored, original, 'stock');
  assert.ok(restored.equals(original));
  artifacts.push({ name: 'synthetic-restored.bin', bytes: restored });
  const report = { scope: 'Synthetic PE64/embed.FS fixtures only; no installed binary or account/profile read; no runtime/model claim.', artifacts: [] };
  for (const artifact of artifacts) {
    const file = path.join(root, artifact.name);
    fs.writeFileSync(file, artifact.bytes);
    const readback = fs.readFileSync(file);
    assert.ok(readback.equals(artifact.bytes));
    report.artifacts.push({ file: artifact.name, bytes: readback.length, sha256: createHash('sha256').update(readback).digest('hex') });
  }
  fs.writeFileSync(path.join(root, 'synthetic-artifacts.json'), JSON.stringify(report, null, 2) + '\n');
});
