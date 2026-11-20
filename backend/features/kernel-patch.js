// Go-Antigravity kernel patcher — prompt tiers and context-window unlock.
//
// This module owns its binary format decoder, patch planner and transaction checks. It does not
// load a third-party patcher or delegate binary writes to an external runtime.
//
// Local safety model: accept AMD64 PE32+ template ranges only within unambiguous,
// file-backed sections. Validate the current image against its pristine same-build backup;
// use backup slot offsets for equal-length replacements and preserve the identity template.
// Stage configuration changes, verify binary readback, and attempt rollback on failure.
// Unrecognized layouts and failed recovery are reported rather than assumed safe.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const payloads = require('./kernel-prompt-payloads.json');

const TEMPLATE_PREFIX = 'google3/third_party/jetski/prompt/template_provider/templates/';
const SYSTEM_PREFIX = TEMPLATE_PREFIX + 'system_prompts/';
const IDENTITY_SLOT = 'system_prompts/identity.tmpl';
const IDENTITY_MARKER = 'You are Antigravity, a powerful agentic AI coding assistant';

// Slot byte capacities measured on the smallest (IDE) kernel. Exceeding them is a hard error,
// never a truncation: a truncated template silently changes AG's behaviour.
const SLOT_CAPACITY = Object.freeze({
  'system_prompts/guidelines.tmpl': 691,
  'system_prompts/function_call.tmpl': 605,
  'system_prompts/communication_style.tmpl': 2792
});

const AD_SLOTS = Object.freeze(['system_prompts/slash_commands.tmpl', 'system_prompts/plugins.tmpl']);

const BLOAT_SLOTS = Object.freeze([
  'system_prompts/artifacts.tmpl',
  'system_prompts/persistent_context.tmpl',
  'system_prompts/knowledge_items.tmpl',
  'system_prompts/planning_mode_artifacts.tmpl',
  'system_prompts/conversation_transcript.tmpl',
  'system_prompts/slash_commands.tmpl',
  'system_prompts/plugins.tmpl'
]);

const CORE_SLOTS = Object.freeze(['system_prompts/guidelines.tmpl', 'system_prompts/function_call.tmpl', 'system_prompts/communication_style.tmpl']);

// The removed "custom prompt" tier wrote this marker into the first core slot. Detection keeps it so
// a kernel patched by an older build is still identified (and can be restored) instead of being
// reported as an unknown image; nothing writes it any more.
const LEGACY_CUSTOM_MARKER = 'GO-ANTIGRAVITY:CUSTOM:';

// Go template comment used to pad a shortened slot back to its original byte length. Wrapping the
// filler in `{{- /* ... */ -}}` keeps it out of the rendered prompt AND out of the output, so the
// slot's declared size never has to change and every PE section offset stays valid.
const PAD_OPEN = '{{- /*';
const PAD_CLOSE = '*/ -}}';

// Byte signatures for `utils.GetCheckpointConfig` and `DefaultSerializer.populateContextWindowMetadata`.
// Each entry carries the stock bytes plus the 512K and 900K replacements, all the same length, so a
// patch can never move an instruction boundary.
const CONTEXT_SIGNATURES = Object.freeze([
  {
    id: 'cli_main_256k_cap',
    desc: 'CLI/Desktop GetCheckpointConfig 主路径 256K (0x3e800) cmovb 封顶',
    stock: '8b54244c81fa00e80300be00e803000f42f289742450',
    k512: '8b54244c81fa00d00700be00d007000f42f289742450',
    k900: '8b54244c81fa00e8030089d690909090909089742450'
  },
  {
    id: 'cli_fallback_256k_cap',
    desc: 'CLI/Desktop GetCheckpointConfig 兜底 256K (0x3e800) 赋值',
    stock: '837a14007f07c7400c00e80300',
    k512: '837a14007f07c7400c00d00700',
    k900: '837a14007f07c7400ca0bb0d00'
  },
  {
    id: 'cli_serializer_max_ctx',
    desc: 'CLI/Desktop populateContextWindowMetadata 前端上限显示值',
    stock: '4889442470488b8c24a80100008908b830000000',
    k512: '4889442470c70000d0070090909090b830000000',
    k900: '4889442470c70000000f0090909090b830000000'
  },
  {
    id: 'ide_main_128k_cap',
    desc: 'IDE GetCheckpointConfig 主路径 128K (0x1f400) cmovb 封顶',
    stock: '8b4c245429d181f900f40100ba00f401000f42d18954244c',
    k512: '8b4c245429d181f900d00700ba00d007000f42d18954244c',
    k900: '8b4c245429d181f900f4010089ca9090909090908954244c'
  }
]);

// `genericsystemprompt.applyEdits` runs a substring check over the template at startup on CLI
// v2.29+; a shortened template fails it and the process panics with code=2. Replacing the
// `je` (equal) with a `jmp` turns the check into an unconditional pass.
const APPLY_EDITS_PREFIX = '488b71104889742458488b711848897424384889d1';
const APPLY_EDITS_TAIL_STOCK = '4883f8010f8474ffffff';
const APPLY_EDITS_TAIL_BYPASS = '4883f801e975ffffff90';

const PROMPT_TIERS = Object.freeze({
  stock: { key: 'stock', label: '官方原版', short: '官方', visible: true, legacy: false, payloadVersion: null, detail: '从同版本原始 .bak 还原全部官方模板及提示词校验字节；上下文设置独立控制' },
  '1': { key: '1', label: '旧 1 档 · 兼容识别', short: '旧 1 档', visible: false, legacy: true, payloadVersion: 1, detail: '旧版清空两个辅助模板；仅识别和还原，请显式选择新版档位' },
  '2': { key: '2', label: '旧 2 档 · 兼容识别', short: '旧 2 档', visible: false, legacy: true, payloadVersion: 1, detail: '旧版清空七个辅助模板；仅识别和还原，请显式选择新版档位' },
  '3': { key: '3', label: '精简', short: '精简', visible: true, legacy: false, payloadVersion: 2, detail: '保留全部辅助模板，以较短文本重写三个核心槽；保留必要证据、工具与失败回读规则' },
  '4': { key: '4', label: '均衡（兼容识别）', short: '均衡', visible: false, legacy: false, payloadVersion: 2, detail: '保留全部辅助模板，重写三个核心槽，保留旧版均衡载荷以便识别和还原' },
  // Detection-only: the custom-prompt feature was removed, so a kernel that still carries its header
  // must stay identifiable and restorable, but it can never be selected as a target again.
  custom: { key: 'custom', label: '自定义（已移除）', short: '旧自定义', visible: false, legacy: true, payloadVersion: 3, detail: '已移除的本地自定义提示词档位；仅用于识别旧内核状态，可用官方原版还原' }
});

const CONTEXT_MODES = Object.freeze({
  stock: { key: 'stock', label: '官方默认 (256K / 128K)', short: '默认', tokens: 0, configValue: null },
  '512k': { key: '512k', label: '解锁 512K 上下文', short: '512K', tokens: 512000, configValue: '512K' },
  '900k': { key: '900k', label: '解锁 900K / 1M 上下文', short: '900K', tokens: 983040, configValue: '900K' }
});

function normalizePromptTier(value) {
  if (value === undefined || value === null || value === '') return 'stock';
  const key = String(value).trim().toLowerCase().replace(/^tier/, '');
  if (['0', 'restore', 'stock', 'official', 'reset', 'default'].includes(key)) return 'stock';
  if (key === 'balanced') return '4';
  if (key === 'compact') return '3';
  // The custom tier is gone. An old saved preference resolves to stock instead of failing
  // validation, which would silently reset every other setting to its default.
  if (key === 'custom' || key === 'replace') return 'stock';
  return Object.hasOwn(PROMPT_TIERS, key) ? key : null;
}

function normalizeContextMode(value) {
  if (value === undefined || value === null || value === '') return 'stock';
  const key = String(value).trim().toLowerCase();
  if (key === 'restore' || key === 'stock' || key === 'reset' || key === 'default') return 'stock';
  if (key === '512k' || key === '512') return '512k';
  if (key === '900k' || key === '1m' || key === '900' || key === 'max') return '900k';
  return null;
}

// The removed custom tier stored a fixed self-describing header at the start of the guidelines slot.
// Only detection survives: that text cannot be resolved back into a prompt any more, and a stock
// restore re-seeds every slot from the pristine backup anyway.
function hasLegacyCustomHeader(text) {
  return text.startsWith(LEGACY_CUSTOM_MARKER);
}

function localAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

// Kept as a function (not a constant) so tests and the GO_ANTIGRAVITY_AG_EXE override both work, and so a
// relocated AG installation is picked up without editing this file.
function resolveTargets(env = process.env) {
  const local = localAppDataDir();
  const explicit = env.GO_ANTIGRAVITY_AG_EXE ? path.resolve(env.GO_ANTIGRAVITY_AG_EXE) : null;
  const appDir = explicit ? path.dirname(explicit) : path.join(local, 'Programs', 'antigravity');
  return [
    {
      id: 'desktop',
      label: 'Antigravity 桌面端 / CLI 内核 (language_server.exe)',
      path: path.join(appDir, 'resources', 'bin', 'language_server.exe'),
      backupPath: path.join(appDir, 'resources', 'bin', 'language_server.exe.bak')
    },
    {
      id: 'ide',
      label: 'Antigravity IDE 插件内核 (language_server_windows_x64.exe)',
      path: path.join(local, 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe'),
      backupPath: path.join(local, 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'bin', 'language_server_windows_x64.exe.bak')
    }
  ];
}

// ============================================================================
// PE64 + Go embed.FS template parser
// ============================================================================

function readU16(buffer, offset) {
  if (offset < 0 || offset + 2 > buffer.length) return null;
  return buffer.readUInt16LE(offset);
}

function readU32(buffer, offset) {
  if (offset < 0 || offset + 4 > buffer.length) return null;
  return buffer.readUInt32LE(offset);
}

function readU64(buffer, offset) {
  if (offset < 0 || offset + 8 > buffer.length) return null;
  return buffer.readBigUInt64LE(offset);
}

function parseSections(buffer) {
  if (readU16(buffer, 0) !== 0x5a4d) throw new Error('不是有效的 PE 文件（MZ 签名不匹配）');
  const peOffset = readU32(buffer, 0x3c);
  if (peOffset === null || peOffset < 0x40 || peOffset + 24 > buffer.length) throw new Error('不是有效的 PE 文件（找不到 PE 头）');
  if (readU32(buffer, peOffset) !== 0x00004550) throw new Error('不是有效的 PE 文件（PE 签名不匹配）');
  if (readU16(buffer, peOffset + 4) !== 0x8664) throw new Error('不支持的 PE 架构（需要 AMD64）');
  const sectionCount = readU16(buffer, peOffset + 6);
  const optionalHeaderSize = readU16(buffer, peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  // PE32+ has 112 fixed optional-header bytes before any data directories.
  if (optionalHeaderSize < 112 || optionalHeaderOffset + optionalHeaderSize > buffer.length) throw new Error('PE 可选头长度无效或越界');
  if (readU16(buffer, optionalHeaderOffset) !== 0x20b) throw new Error('不支持的 PE 可选头（需要 PE32+）');
  const imageBase = readU64(buffer, optionalHeaderOffset + 24);
  const tableOffset = optionalHeaderOffset + optionalHeaderSize;
  const tableEnd = tableOffset + sectionCount * 40;
  if (sectionCount === 0 || tableEnd > buffer.length) throw new Error('PE 节表为空或越界');
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const offset = tableOffset + index * 40;
    const section = {
      virtualSize: readU32(buffer, offset + 8),
      virtualAddress: readU32(buffer, offset + 12),
      rawSize: readU32(buffer, offset + 16),
      rawPointer: readU32(buffer, offset + 20)
    };
    section.rawEnd = section.rawPointer + section.rawSize;
    // Raw alignment padding is file-backed; a larger virtual tail is not.
    section.virtualEnd = section.virtualAddress + Math.max(section.virtualSize, section.rawSize);
    if (section.rawSize > 0 && (section.rawPointer < tableEnd || section.rawEnd > buffer.length)) throw new Error('PE 原始节数据越界或覆盖头部');
    if (section.virtualEnd > 0x100000000 || imageBase + BigInt(section.virtualEnd) > 0x10000000000000000n) throw new Error('PE 节虚拟地址越界');
    for (const other of sections) {
      if (section.rawSize > 0 && other.rawSize > 0 && section.rawPointer < other.rawEnd && other.rawPointer < section.rawEnd) throw new Error('PE 原始节数据重叠，映射不唯一');
      if (section.virtualEnd > section.virtualAddress && other.virtualEnd > other.virtualAddress
        && section.virtualAddress < other.virtualEnd && other.virtualAddress < section.virtualEnd) throw new Error('PE 节虚拟地址重叠，映射不唯一');
    }
    sections.push(section);
  }
  return { imageBase, sections };
}

function offsetToVa(offset, sections, imageBase, length = 1) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) return null;
  for (const section of sections) {
    if (offset >= section.rawPointer && offset < section.rawEnd && length <= section.rawEnd - offset) {
      return imageBase + BigInt(section.virtualAddress) + BigInt(offset - section.rawPointer);
    }
  }
  return null;
}

function vaToOffset(va, sections, imageBase, length) {
  if (typeof va !== 'bigint' || typeof length !== 'bigint' || length <= 0n || va < imageBase) return null;
  const rva = va - imageBase;
  if (rva > 0xffffffffn) return null;
  for (const section of sections) {
    const delta = rva - BigInt(section.virtualAddress);
    if (delta >= 0n && delta < BigInt(section.rawSize) && length <= BigInt(section.rawSize) - delta) {
      // Convert only after the full uint64 range is bounded by validated raw bytes.
      return section.rawPointer + Number(delta);
    }
  }
  return null;
}

// A slot is "stripped" when its whole payload is a Go template comment, which renders to nothing.
function activeTemplateText(text) {
  const index = text.lastIndexOf(PAD_OPEN);
  if (index >= 0 && text.endsWith(PAD_CLOSE)) {
    const inner = text.slice(index + PAD_OPEN.length, text.length - PAD_CLOSE.length);
    if (/^ *$/.test(inner)) return text.slice(0, index);
  }
  return text;
}

function computeActiveBytes(text) {
  const activeText = activeTemplateText(text);
  return { active: Buffer.byteLength(activeText, 'utf8'), stripped: activeText.length === 0 };
}

function parseEmbedTemplates(buffer) {
  const { imageBase, sections } = parseSections(buffer);
  const anchor = Buffer.from(SYSTEM_PREFIX + 'identity.tmpl', 'utf8');
  const anchorOffset = buffer.indexOf(anchor);
  if (anchorOffset === -1) throw new Error('在内核中找不到 identity.tmpl 路径字符串（版本不受支持？）');
  if (buffer.indexOf(anchor, anchorOffset + 1) !== -1) throw new Error('identity.tmpl 路径字符串不唯一，当前版本不受支持');
  const anchorVa = offsetToVa(anchorOffset, sections, imageBase, anchor.length);
  if (anchorVa === null) throw new Error('无法把 identity.tmpl 文件偏移映射到虚拟地址');

  // Go's embed.FS stores a flat []file slice; each entry is {name *string, nameLen, data *string,
  // dataLen, ...}. Locating identity.tmpl's entry gives us the slice, and the sibling entries sit
  // at a fixed 48-byte stride around it.
  const needle = Buffer.alloc(16);
  needle.writeBigUInt64LE(anchorVa, 0);
  needle.writeBigUInt64LE(BigInt(anchor.length), 8);
  const entryOffset = buffer.indexOf(needle);
  if (entryOffset === -1) throw new Error('无法定位 identity.tmpl 的 embed.FS 条目');
  if (buffer.indexOf(needle, entryOffset + 1) !== -1) throw new Error('identity.tmpl embed.FS 条目不唯一，当前版本不受支持');
  if (offsetToVa(entryOffset, sections, imageBase, 48) === null) throw new Error('identity.tmpl embed.FS 条目跨越原始节边界');

  const slots = new Map();
  for (let step = -12; step <= 12; step++) {
    const entry = entryOffset + step * 48;
    if (offsetToVa(entry, sections, imageBase, 48) === null) continue;
    const nameVa = readU64(buffer, entry);
    const nameLength64 = readU64(buffer, entry + 8);
    const dataVa = readU64(buffer, entry + 16);
    const dataLength64 = readU64(buffer, entry + 24);
    if (nameLength64 === 0n || nameLength64 >= 240n || dataLength64 === 0n) continue;
    const nameOffset = vaToOffset(nameVa, sections, imageBase, nameLength64);
    const dataOffset = vaToOffset(dataVa, sections, imageBase, dataLength64);
    if (nameOffset === null || dataOffset === null) continue;
    const nameLength = Number(nameLength64);
    const dataLength = Number(dataLength64);
    const fullName = buffer.toString('utf8', nameOffset, nameOffset + nameLength);
    if (!fullName.startsWith(SYSTEM_PREFIX)) continue;
    const name = fullName.slice(TEMPLATE_PREFIX.length);
    if (slots.has(name)) throw new Error('模板槽位名称重复：' + name);
    for (const other of slots.values()) {
      if (dataOffset < other.dataOffset + other.dataLength && other.dataOffset < dataOffset + dataLength) {
        throw new Error('模板数据槽位重叠：' + name + ' / ' + other.name);
      }
    }
    const text = buffer.toString('utf8', dataOffset, dataOffset + dataLength);
    const { active, stripped } = computeActiveBytes(text);
    slots.set(name, {
      name,
      dataOffset,
      dataLength,
      activeBytes: active,
      stripped,
      preview: stripped ? '[已剥离 — 渲染为空]' : activeTemplateText(text).replace(/\s+/g, ' ').trim().slice(0, 120)
    });
  }
  if (slots.size === 0) throw new Error('没有解析到任何 embed.FS 提示词模板');
  return slots;
}

function writePaddedTemplate(buffer, slot, text) {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length > slot.dataLength) {
    throw new Error(`模板 ${slot.name} 超出槽位容量：需要 ${encoded.length} 字节，可用 ${slot.dataLength} 字节`);
  }
  const padLength = slot.dataLength - encoded.length;
  const padding = padLength >= PAD_OPEN.length + PAD_CLOSE.length
    ? Buffer.from(PAD_OPEN + ' '.repeat(padLength - PAD_OPEN.length - PAD_CLOSE.length) + PAD_CLOSE, 'utf8')
    : Buffer.alloc(padLength, 0x20);
  encoded.copy(buffer, slot.dataOffset);
  padding.copy(buffer, slot.dataOffset + encoded.length);
  return encoded.length;
}

// ============================================================================
// Prompt tiers
// ============================================================================

function payloadFor(tier, slot, version = payloads.version) {
  const groups = version === 1 ? payloads.legacyTiers : version === payloads.version ? payloads.tiers : null;
  const group = groups?.['tier' + tier];
  const key = slot.endsWith('guidelines.tmpl') ? 'guidelines' : slot.endsWith('function_call.tmpl') ? 'functionCall' : 'communicationStyle';
  if (!group || typeof group[key] !== 'string') throw new Error('未知的提示词载荷版本或档位');
  return group[key];
}

function matchesPaddedTemplate(buffer, slot, text) {
  if (!slot || Buffer.byteLength(text, 'utf8') > slot.dataLength) return false;
  const expected = Buffer.alloc(slot.dataLength);
  writePaddedTemplate(expected, { ...slot, dataOffset: 0 }, text);
  return buffer.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).equals(expected);
}

// Only identity and the three core templates are load-bearing. Antigravity ships a different
// auxiliary set per build (44.9.x dropped knowledge_items, planning_mode_artifacts and plugins and
// added skills, test_funcmap and helpers/*), so helper slots are matched against what the kernel has.
function presentSlots(slots, names) {
  return names.filter(name => slots.has(name));
}

// Distinguishes a template set that this build never shipped from one that exists but failed to
// parse: the embed.FS name blob still carries every declared path, so a declared-but-unparsed
// helper means a malformed or half-written image rather than a newer Antigravity release.
function declaresTemplate(buffer, name) {
  return buffer.includes(Buffer.from(TEMPLATE_PREFIX + name, 'utf8'));
}

function detectPromptState(slots, buffer) {
  const state = (tier, payloadVersion = null) => ({ tier, payloadVersion, legacy: payloadVersion === 1 });
  if ([IDENTITY_SLOT, ...CORE_SLOTS].some(name => !slots.has(name))) return state('unknown');
  if ([...BLOAT_SLOTS, ...AD_SLOTS].some(name => !slots.has(name) && declaresTemplate(buffer, name))) return state('unknown');
  const bloat = presentSlots(slots, BLOAT_SLOTS);
  const ad = presentSlots(slots, AD_SLOTS);
  const stripped = name => slots.get(name).stripped === true;
  const allStripped = names => names.length > 0 && names.every(name => stripped(name) && matchesPaddedTemplate(buffer, slots.get(name), ''));
  const noStripped = names => names.every(name => !stripped(name));
  // A kernel written by the removed custom tier still starts with its self-describing header.
  const guidelines = slots.get(CORE_SLOTS[0]);
  if (hasLegacyCustomHeader(buffer.toString('utf8', guidelines.dataOffset, guidelines.dataOffset + guidelines.dataLength)) && noStripped(bloat)) {
    return { tier: 'custom', payloadVersion: 3, legacy: true };
  }
  for (const version of [payloads.version, 1]) {
    for (const tier of ['3', '4']) {
      const helpersMatch = version === 1 ? allStripped(bloat) : noStripped(bloat);
      if (helpersMatch && CORE_SLOTS.every(name => matchesPaddedTemplate(buffer, slots.get(name), payloadFor(tier, name, version)))) {
        return state(tier, version);
      }
    }
  }
  // A marker alone is never a version signature. Reject partial/mixed known payloads and padding.
  const rewritten = CORE_SLOTS.some(name => {
    const slot = slots.get(name);
    const text = buffer.toString('utf8', slot.dataOffset, slot.dataOffset + slot.dataLength);
    // Only a trailing whitespace-only pad comment counts as a write of ours: official templates also
    // open with PAD_OPEN, so the bare opener cannot be treated as a patch signature.
    // legacy marker from earlier builds: kernels patched under the old name still start with it
    return activeTemplateText(text) !== text || text.startsWith(LEGACY_CUSTOM_MARKER) || text.startsWith('Goagy ') || [1, payloads.version].some(version =>
      ['3', '4'].some(tier => text.startsWith(payloadFor(tier, name, version).slice(0, 40))));
  });
  if (rewritten) return state('unknown');
  if (allStripped(bloat)) return state('2', 1);
  if (allStripped(ad) && noStripped(bloat.filter(name => !ad.includes(name)))) return state('1', 1);
  return noStripped(bloat) ? state('stock') : state('unknown');
}

function detectPromptTier(slots, buffer) {
  return detectPromptState(slots, buffer).tier;
}

function findApplyEditsTail(buffer) {
  const prefix = Buffer.from(APPLY_EDITS_PREFIX, 'hex');
  const stock = Buffer.from(APPLY_EDITS_TAIL_STOCK, 'hex');
  const bypass = Buffer.from(APPLY_EDITS_TAIL_BYPASS, 'hex');
  const prefixOffset = buffer.indexOf(prefix);
  if (prefixOffset === -1 || buffer.indexOf(prefix, prefixOffset + 1) !== -1) return null;
  // The prefix is followed by a 5-byte `call strings.Count`, then the 10-byte tail under test.
  const tailOffset = prefixOffset + prefix.length + 5;
  if (tailOffset + 10 > buffer.length) return null;
  const current = buffer.subarray(tailOffset, tailOffset + 10);
  if (current.equals(stock)) return { offset: tailOffset, stock, bypass };
  if (current.equals(bypass)) return { offset: tailOffset, stock, bypass, alreadyBypassed: true };
  return null;
}

// Applies a tier to `buffer`, always re-seeding every slot from `backup` first. This is what makes
// tier switching idempotent: no matter what the file looked like before, the result depends only
// on (backup, tier).
function applyPromptTier(buffer, backup, tier, slots, payloadVersion = payloads.version) {
  if (!Object.hasOwn(PROMPT_TIERS, tier)) throw new Error('未知的提示词档位：' + tier);
  if (tier === 'custom') throw new Error('自定义提示词档位已移除，请选择官方原版或精简');
  const backupSlots = parseEmbedTemplates(backup);
  if ([IDENTITY_SLOT, ...CORE_SLOTS].some(name => !backupSlots.has(name))) {
    throw new Error('内核缺少必要模板槽位，当前版本不受支持');
  }
  const unparsed = [...AD_SLOTS, ...BLOAT_SLOTS].find(name => !backupSlots.has(name) && declaresTemplate(backup, name));
  if (unparsed) throw new Error('模板槽位 ' + unparsed + ' 已声明但无法解析，当前内核不受支持');
  const identity = backupSlots.get(IDENTITY_SLOT);
  const originalIdentity = backup.subarray(identity.dataOffset, identity.dataOffset + identity.dataLength);
  if (!originalIdentity.includes(Buffer.from(IDENTITY_MARKER))) {
    throw new Error('严重错误：identity.tmpl 身份校验区不完整，已中止写入');
  }
  // Older kernels run a startup substring check over the (shortened) templates in
  // genericsystemprompt.applyEdits and panic with code=2 when it fails, so that jump must be patched.
  // Builds that no longer contain that code (44.9+) have nothing to bypass; a build that still
  // carries it must show the exact stock signature or the write is not safe.
  const applyEdits = findApplyEditsTail(backup);
  const startupCheckShipped = backup.includes(Buffer.from('genericsystemprompt', 'utf8'));
  if (tier !== 'stock' && (applyEdits ? applyEdits.alreadyBypassed : startupCheckShipped)) {
    throw new Error('未找到唯一的原始 applyEdits 校验签名，当前内核版本不受支持');
  }
  const rewritten = tier === '3' || tier === '4';
  // Validate every replacement before mutating even the in-memory output buffer.
  if (rewritten) {
    for (const name of CORE_SLOTS) {
      const text = payloadFor(tier, name, payloadVersion);
      const capacity = Math.min(SLOT_CAPACITY[name], backupSlots.get(name).dataLength);
      if (Buffer.byteLength(text, 'utf8') > capacity) throw new Error(
        '模板 ' + name + ' 载荷 ' + Buffer.byteLength(text, 'utf8') + ' 字节超过容量上限 ' + capacity + ' 字节');
    }
  }
  for (const slot of backupSlots.values()) {
    backup.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).copy(buffer, slot.dataOffset);
  }
  let strippedBytes = 0;
  if (tier !== 'stock') {
    const wanted = tier === '1' ? AD_SLOTS : tier === '2' || payloadVersion === 1 ? BLOAT_SLOTS : [];
    const strippedSlots = presentSlots(backupSlots, wanted);
    for (const name of strippedSlots) {
      const slot = backupSlots.get(name);
      writePaddedTemplate(buffer, slot, '');
      strippedBytes += slot.dataLength;
    }
    if (rewritten) for (const name of CORE_SLOTS) writePaddedTemplate(buffer, backupSlots.get(name), payloadFor(tier, name, payloadVersion));
  }
  if (applyEdits) (tier === 'stock' ? applyEdits.stock : applyEdits.bypass).copy(buffer, applyEdits.offset);
  if (!buffer.subarray(identity.dataOffset, identity.dataOffset + identity.dataLength).equals(originalIdentity)) {
    throw new Error('严重错误：identity.tmpl 身份校验区被改动，已中止写入');
  }
  const coreBytes = rewritten ? CORE_SLOTS.reduce((sum, name) => sum + Buffer.byteLength(payloadFor(tier, name, payloadVersion), 'utf8'), 0) : null;
  const message = tier === 'stock' ? '已从同版本备份还原全部官方模板及提示词校验字节'
    : '已应用 [' + PROMPT_TIERS[tier].label + ']：' + (rewritten ? '重写三个核心模板，载荷 ' + coreBytes + ' 字节' : '旧版兼容模板')
      + '；' + (strippedBytes ? '清空辅助模板 ' + strippedBytes + ' 字节' : '保留全部辅助模板');
  return {
    message,
    strippedBytes,
    coreBytes,
    payloadVersion: rewritten ? payloadVersion : tier === 'stock' ? null : 1,
    slotCount: backupSlots.size
  };
}

// ============================================================================
// Context window unlock
// ============================================================================

function detectContextMode(buffer) {
  // A kernel only counts as "unlocked" when every signature it actually carries has been
  // rewritten; a mixed state means a partial write and must not be sold as a working unlock.
  const present = CONTEXT_SIGNATURES.filter(signature => buffer.includes(Buffer.from(signature.stock, 'hex'))
    || buffer.includes(Buffer.from(signature.k512, 'hex')) || buffer.includes(Buffer.from(signature.k900, 'hex')));
  if (present.length === 0) return 'stock';
  if (present.every(signature => buffer.includes(Buffer.from(signature.stock, 'hex')))) return 'stock';
  if (present.every(signature => buffer.includes(Buffer.from(signature.k900, 'hex')))) return '900k';
  if (present.every(signature => buffer.includes(Buffer.from(signature.k512, 'hex')))) return '512k';
  // Partially rewritten: surface the strongest single rewrite so the UI can flag it as abnormal.
  if (present.some(signature => buffer.includes(Buffer.from(signature.k900, 'hex')))) return '900k';
  return '512k';
}

function inspectContextGates(buffer) {
  const gates = [];
  for (const signature of CONTEXT_SIGNATURES) {
    for (const [mode, hex] of [['stock', signature.stock], ['512k', signature.k512], ['900k', signature.k900]]) {
      const bytes = Buffer.from(hex, 'hex');
      for (let offset = buffer.indexOf(bytes); offset !== -1; offset = buffer.indexOf(bytes, offset + bytes.length)) {
        gates.push({ id: signature.id, desc: signature.desc, mode, offset });
      }
    }
  }
  return gates;
}

function applyContextPatch(buffer, backup, mode) {
  const logs = [];
  for (const signature of CONTEXT_SIGNATURES) {
    const stock = Buffer.from(signature.stock, 'hex');
    // Anchor every occurrence on the pristine backup, including repeated gates in one build.
    const replacement = Buffer.from(mode === '512k' ? signature.k512 : mode === '900k' ? signature.k900 : signature.stock, 'hex');
    for (let offset = backup.indexOf(stock); offset !== -1; offset = backup.indexOf(stock, offset + stock.length)) {
      replacement.copy(buffer, offset);
      logs.push({ id: signature.id, desc: signature.desc, mode, offset });
    }
  }
  if (mode !== 'stock' && logs.length === 0) throw new Error('未找到可改写的上下文封顶签名，当前内核版本不受支持');
  const actual = inspectContextGates(buffer);
  if (actual.length !== logs.length || actual.some(gate => gate.mode !== mode
    || !logs.some(expected => expected.id === gate.id && expected.offset === gate.offset))) {
    throw new Error('上下文封顶签名校验失败：并非所有 gate 都处于目标档位');
  }
  return logs;
}

// Config and binary changes share a staged transaction. A stable sidecar records this tool's
// contextWindow ownership; restoration never overwrites unrelated, later user edits.
const CONTEXT_STATE_SUFFIX = '.go-antigravity-context.json';
let kernelTransactionActive = false;

function readOptional(file) {
  try { return fs.readFileSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function jsonObject(text) {
  const object = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error('配置内容必须是 JSON 对象');
  return object;
}

// Scan top-level member spans after JSON.parse validates the complete document. Local edits
// preserve the BOM, whitespace, newline style, and every unrelated member verbatim.
function jsonMembers(text) {
  const members = [];
  let cursor = text.indexOf('{') + 1;
  const whitespace = () => { while (cursor < text.length && /\s/.test(text[cursor])) cursor++; };
  const stringEnd = start => {
    let end = start + 1;
    while (end < text.length) {
      if (text.charCodeAt(end) === 92) { end += 2; continue; }
      if (text[end++] === '"') return end;
    }
    throw new Error('配置字符串未闭合');
  };
  while (cursor < text.length) {
    whitespace();
    if (text[cursor] === '}') break;
    const start = cursor, keyEnd = stringEnd(cursor);
    const key = JSON.parse(text.slice(cursor, keyEnd));
    cursor = keyEnd;
    whitespace();
    cursor++; // colon (already validated)
    whitespace();
    const valueStart = cursor;
    if (text[cursor] === '"') cursor = stringEnd(cursor);
    else if (text[cursor] === '{' || text[cursor] === '[') {
      let depth = 0;
      do {
        if (text[cursor] === '"') { cursor = stringEnd(cursor); continue; }
        if (text[cursor] === '{' || text[cursor] === '[') depth++;
        else if (text[cursor] === '}' || text[cursor] === ']') depth--;
        cursor++;
      } while (depth > 0);
    } else while (cursor < text.length && !/[\s,}]/.test(text[cursor])) cursor++;
    members.push({ key, start, keyEnd, valueStart, valueEnd: cursor });
    whitespace();
    if (text[cursor] === ',') cursor++;
    else break;
  }
  if (new Set(members.map(member => member.key)).size !== members.length) throw new Error('配置含重复 JSON 字段，拒绝修改');
  return members;
}

function editContextMember(text, literal) {
  const members = jsonMembers(text);
  const index = members.findIndex(member => member.key === 'contextWindow');
  if (index !== -1) {
    const member = members[index];
    if (literal !== null) return text.slice(0, member.valueStart) + literal + text.slice(member.valueEnd);
    if (members[index + 1]) return text.slice(0, member.start) + text.slice(members[index + 1].start);
    const start = index ? members[index - 1].valueEnd : member.start;
    return text.slice(0, start) + text.slice(member.valueEnd);
  }
  if (literal === null) return text;
  const open = text.indexOf('{');
  if (!members.length) return text.slice(0, open + 1) + '"contextWindow": ' + literal + text.slice(open + 1);
  const first = members[0], last = members[members.length - 1];
  const gap = text.slice(open + 1, first.start), colon = text.slice(first.keyEnd, first.valueStart);
  return text.slice(0, last.valueEnd) + ',' + gap + '"contextWindow"' + colon + literal + text.slice(last.valueEnd);
}

function sameBytes(a, b) { return a === null ? b === null : b !== null && a.equals(b); }

function prepareContextConfig(mode, homeDir) {
  const value = CONTEXT_MODES[mode].configValue;
  const files = [path.join(homeDir, '.gemini', 'config', 'config.json'), path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json')];
  const entries = [], logs = [];
  for (const file of files) {
    try {
      if (!fs.existsSync(path.dirname(file))) continue;
      const before = readOptional(file), stateFile = file + CONTEXT_STATE_SUFFIX, stateBefore = readOptional(stateFile);
      const text = before === null ? '{}\n' : before.toString('utf8');
      if (before !== null && !Buffer.from(text).equals(before)) throw new Error('配置不是有效 UTF-8，拒绝修改');
      const object = jsonObject(text);
      jsonMembers(text);
      let state = null;
      if (stateBefore !== null) {
        const stateText = stateBefore.toString('utf8');
        if (!Buffer.from(stateText).equals(stateBefore)) throw new Error('恢复记录不是有效 UTF-8，拒绝修改');
        state = jsonObject(stateText);
        jsonMembers(stateText);
        if (state.version !== 1 || typeof state.existed !== 'boolean'
          || (state.existed ? typeof state.originalText !== 'string' : state.originalText !== null)
          || typeof state.appliedText !== 'string' || !['512K', '900K'].includes(state.appliedValue)) {
          throw new Error('不认识的上下文恢复记录，拒绝修改');
        }
        if (state.existed) { jsonObject(state.originalText); jsonMembers(state.originalText); }
        const applied = jsonObject(state.appliedText);
        jsonMembers(state.appliedText);
        if (applied.contextWindow !== state.appliedValue) throw new Error('上下文恢复记录不一致');
        if (before === null || object.contextWindow !== state.appliedValue) throw new Error('contextWindow 已被外部修改，拒绝覆盖');
      }
      let after = before, stateAfter = stateBefore;
      if (value === null) {
        if (!state) continue; // Stock must not delete an unowned custom setting.
        const original = state.existed ? state.originalText : '{}\n';
        const originalMember = jsonMembers(original).find(member => member.key === 'contextWindow');
        const literal = originalMember ? original.slice(originalMember.valueStart, originalMember.valueEnd) : null;
        const onlyOwnedChange = text === editContextMember(original, JSON.stringify(state.appliedValue));
        const restored = onlyOwnedChange ? original : editContextMember(text, literal);
        after = !state.existed && (onlyOwnedChange || Object.keys(jsonObject(restored)).length === 0)
          ? null : Buffer.from(restored);
        stateAfter = null;
      } else if (object.contextWindow !== value) {
        if (!state) state = { version: 1, existed: before !== null, originalText: before === null ? null : text };
        const updated = editContextMember(text, JSON.stringify(value));
        if (jsonObject(updated).contextWindow !== value) throw new Error('上下文字段修改后校验失败');
        state.appliedText = updated;
        state.appliedValue = value;
        after = Buffer.from(updated);
        stateAfter = Buffer.from(JSON.stringify(state, null, 2) + '\n');
      }
      if (!sameBytes(stateBefore, stateAfter)) entries.push({ file: stateFile, before: stateBefore, after: stateAfter });
      if (!sameBytes(before, after)) entries.push({ file, before, after });
      if (!sameBytes(before, after) || !sameBytes(stateBefore, stateAfter)) logs.push('已同步 ' + file + ' → contextWindow: ' + (value || '(恢复原值)'));
    } catch (error) { throw new Error('同步 ' + file + ' 失败：' + error.message); }
  }
  return { entries, logs };
}

function stageSnapshot(entry, key, bytes) {
  if (bytes === null) return;
  const temp = entry.file + '.go-antigravity-' + randomUUID() + '.tmp';
  entry[key] = temp; // Register before writing so partial/failed stages are cleaned too.
  entry[key + 'Verified'] = false;
  const mode = entry.before === null ? 0o600 : fs.statSync(entry.file).mode & 0o777;
  fs.writeFileSync(temp, bytes, { flag: 'wx', mode });
  const fd = fs.openSync(temp, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!fs.readFileSync(temp).equals(bytes)) throw new Error('暂存文件回读校验失败');
  entry[key + 'Verified'] = true;
}

function stageEntries(entries) {
  for (const entry of entries) {
    try {
      if (!sameBytes(readOptional(entry.file), entry.before)) throw new Error('文件已被外部修改');
      // A kernel image is only ever rewritten in place, byte for byte, so the original bytes of the
      // changed ranges are enough to undo a failed write. Staging a full copy of the image would
      // double the disk cost of every patch for a recovery path that never needs the whole file;
      // only entries without a same-size binary rewrite still keep that snapshot.
      if (entry.binary && entry.before && entry.after && entry.before.length === entry.after.length) {
        entry.rangeRollback = true;
      } else {
        stageSnapshot(entry, 'rollbackFile', entry.before);
      }
      if (!entry.binary) stageSnapshot(entry, 'stagedFile', entry.after);
    } catch (error) { throw new Error('暂存 ' + entry.file + ' 失败：' + error.message); }
  }
}

function commitEntry(entry) {
  if (!sameBytes(readOptional(entry.file), entry.before)) throw new Error('文件已被外部修改：' + entry.file);
  entry.attempted = true;
  if (entry.after === null) fs.unlinkSync(entry.file);
  else fs.renameSync(entry.stagedFile, entry.file);
  if (!sameBytes(readOptional(entry.file), entry.after)) throw new Error('配置写入后回读校验失败：' + entry.file);
}

function restoreEntry(entry) {
  if (entry.before === null) {
    if (readOptional(entry.file) !== null) fs.unlinkSync(entry.file);
  } else if (entry.rollbackFileVerified) {
    fs.renameSync(entry.rollbackFile, entry.file);
  } else {
    // The inverse of the forward write: only the ranges that differ between the two images.
    writeChangedRanges(entry.file, entry.after, entry.before);
  }
  if (!sameBytes(readOptional(entry.file), entry.before)) throw new Error('回读与本轮原始内容不一致');
}

function rollbackEntries(entries, errors) {
  const preservedBackups = new Set();
  for (const entry of [...entries].reverse()) {
    if (!entry.attempted || preservedBackups.has(entry.file)) continue;
    try {
      if (sameBytes(readOptional(entry.file), entry.before)) continue;
      restoreEntry(entry);
    } catch (error) {
      // Materialise a recovery copy only when the inverse write itself failed, so the expensive
      // snapshot exists exactly in the case a human has to repair the file by hand.
      let recoveryError = '';
      if (entry.before !== null && !entry.rollbackFileVerified) {
        try { stageSnapshot(entry, 'rollbackFile', entry.before); }
        catch (snapshotError) { recoveryError = '；恢复快照创建失败：' + snapshotError.message; }
      }
      entry.keepRecovery = entry.rollbackFileVerified === true;
      let recovery = entry.keepRecovery ? '；恢复快照：' + entry.rollbackFile : recoveryError || '；无已校验恢复快照';
      if (entry.binary && entry.backupPath) {
        // The backup was committed and verified before this image was touched. Never delete the
        // only durable original just because its inverse write or recovery snapshot failed.
        preservedBackups.add(entry.backupPath);
        recovery += '；保留原始备份：' + entry.backupPath;
      }
      errors.push('回滚 ' + entry.file + ' 失败：' + error.message + recovery);
    }
  }
}

// NTFS file compression is transparent on read and typically halves a pristine kernel image, the one
// large file this tool keeps on disk. Best effort by design: a non-NTFS volume, a locked image or a
// missing compact.exe must never turn a completed patch into a failure.
function compressBackup(file) {
  if (process.platform !== 'win32' || !file || !fs.existsSync(file)) return Promise.resolve(false);
  const compact = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'compact.exe');
  return new Promise(resolve => {
    // Some callers (tests) replace child_process with a thrower; a compression miss must never turn
    // a completed patch into a rollback.
    // No /f: NTFS recompresses an uncompressed file anyway, while an already compressed backup is
    // left alone, so repeated applies cost a metadata call instead of rewriting 194 MB.
    try { execFile(compact, ['/c', '/q', file], { windowsHide: true, timeout: 30000 }, error => resolve(!error)); }
    catch { resolve(false); }
  });
}

function cleanupEntries(entries, errors) {
  for (const entry of entries) {
    for (const key of ['stagedFile', 'rollbackFile']) {
      if (!entry[key] || (key === 'rollbackFile' && entry.keepRecovery)) continue;
      try { fs.unlinkSync(entry[key]); }
      catch (error) { if (error.code !== 'ENOENT') errors.push('清理 ' + entry[key] + ' 失败：' + error.message); }
    }
  }
}

function syncContextWindowConfig(mode, homeDir = os.homedir(), errors = []) {
  if (kernelTransactionActive) {
    const message = '内核变更事务正在进行，请稍后重试';
    errors.push(message);
    return [message];
  }
  const entries = [], logs = [];
  try {
    const prepared = prepareContextConfig(mode, homeDir);
    entries.push(...prepared.entries);
    stageEntries(entries);
    for (const entry of entries) commitEntry(entry);
    logs.push(...prepared.logs);
  } catch (error) {
    logs.push(error.message);
    errors.push(error.message);
    rollbackEntries(entries, errors);
  } finally { cleanupEntries(entries, errors); }
  return logs;
}

function detectConfiguredContextCap(homeDir = os.homedir()) {
  const file = path.join(homeDir, '.gemini', 'config', 'config.json');
  try {
    const value = jsonObject(fs.readFileSync(file, 'utf8')).contextWindow;
    const key = String(value || '').toUpperCase();
    if (key === '900K' || key === '1M') return 983040;
    if (key === '512K') return 512000;
  } catch { /* No config yet: the kernel default applies. */ }
  return 0;
}

// ============================================================================
// Writing a possibly-running binary
// ============================================================================

function writeChangedRanges(file, oldBuffer, newBuffer) {
  if (oldBuffer.length !== newBuffer.length) {
    fs.writeFileSync(file, newBuffer);
    return newBuffer.length;
  }
  const handle = fs.openSync(file, 'r+');
  try {
    let written = 0;
    let index = 0;
    while (index < newBuffer.length) {
      if (oldBuffer[index] === newBuffer[index]) {
        index++;
        continue;
      }
      const start = index;
      while (index < newBuffer.length && oldBuffer[index] !== newBuffer[index]) index++;
      // (buffer, bufferOffset, length, position): the payload is already sliced to the changed
      // range, so its own offset is 0 and the file position carries the real target.
      fs.writeSync(handle, newBuffer.subarray(start, index), 0, index - start, start);
      written += index - start;
    }
    return written;
  } finally {
    fs.closeSync(handle);
  }
}

// Pass paths as data, including portable installations with spaces or quotes in the directory.
function kernelProcessCount(paths, stop = false) {
  const script = path.join(__dirname, 'kernel-processes.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
  if (stop) args.push('-StopTargets');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, {
      windowsHide: true, timeout: 15000,
      env: { ...process.env, GO_ANTIGRAVITY_KERNEL_TARGET_PATHS: JSON.stringify(paths) }
    }, (error, stdout) => {
      if (error || !/^\d+$/.test(String(stdout).trim())) {
        reject(new Error('无法确认或关闭此用户的目标内核，请手动退出 Antigravity 后重试'));
      } else resolve(Number(stdout));
    });
  });
}

async function languageServerRunning() {
  return (await kernelProcessCount(resolveTargets().map(target => target.path))) > 0;
}

// Windows lets a running .exe be renamed inside its own directory, so a patched kernel can be put
// in place without killing the language server (which would drop the user's open conversations).
async function writeBinaryWithUnlock(file, oldBuffer, newBuffer) {
  if (oldBuffer.equals(newBuffer)) return { written: 0, strategy: 'unchanged' };
  try {
    return { written: writeChangedRanges(file, oldBuffer, newBuffer), strategy: 'in-place' };
  } catch { /* The image is locked by a running process; fall through. */ }

  const stale = `${file}.old_run`;
  try { fs.unlinkSync(stale); } catch { /* Nothing stale to clear. */ }
  if (fs.existsSync(file)) {
    try {
      fs.renameSync(file, stale);
      try {
        fs.writeFileSync(file, newBuffer);
        try { fs.unlinkSync(stale); } catch { /* Best effort. */ }
        return { written: newBuffer.length, strategy: 'rename-replace' };
      } catch (error) {
        try { fs.renameSync(stale, file); } catch { /* The original name is gone; reported below. */ }
        throw error;
      }
    } catch { /* Rename blocked too (leftover .old_run still held): fall through to the kill path. */ }
  }

  await kernelProcessCount([file], true);
  for (const wait of [40, 80, 150]) {
    await new Promise(resolve => setTimeout(resolve, wait));
    try { fs.unlinkSync(stale); } catch { /* Still held; the next attempt may succeed. */ }
    try { return { written: writeChangedRanges(file, oldBuffer, newBuffer), strategy: 'kill-and-write' }; }
    catch { /* Retry. */ }
  }
  return { written: writeChangedRanges(file, oldBuffer, newBuffer), strategy: 'kill-and-write' };
}

// ============================================================================
// Inspection and application
// ============================================================================

function inspectTarget(target) {
  const base = {
    id: target.id,
    label: target.label,
    path: target.path,
    backupPath: target.backupPath,
    exists: false,
    backupExists: fs.existsSync(target.backupPath),
    promptTier: 'stock',
    promptPayloadVersion: null,
    promptLegacy: false,
    contextMode: 'stock',
    slots: [],
    gates: [],
    error: null
  };
  if (!fs.existsSync(target.path)) return base;
  let buffer;
  try {
    buffer = fs.readFileSync(target.path);
  } catch (error) {
    return { ...base, exists: true, error: `读取内核失败：${error.message}` };
  }
  try {
    const slots = parseEmbedTemplates(buffer);
    const list = [...slots.values()].sort((a, b) => a.name.localeCompare(b.name));
    const prompt = detectPromptState(slots, buffer);
    return {
      ...base,
      exists: true,
      sizeBytes: buffer.length,
      promptTier: prompt.tier,
      promptPayloadVersion: prompt.payloadVersion,
      promptLegacy: prompt.legacy,
      contextMode: detectContextMode(buffer),
      slots: list,
      activeSlotBytes: list.reduce((sum, slot) => sum + slot.activeBytes, 0),
      totalSlotCapacity: list.reduce((sum, slot) => sum + slot.dataLength, 0),
      gates: inspectContextGates(buffer)
    };
  } catch (error) {
    return { ...base, exists: true, sizeBytes: buffer.length, error: error.message };
  }
}

function inspectKernel(options = {}) {
  const targets = options.targets || resolveTargets(options.env);
  return {
    platformSupported: process.platform === 'win32',
    targets: targets.map(inspectTarget)
  };
}

// Applies the requested tier/mode to every installed kernel. Only the requested axes are touched:
// passing promptTier alone leaves the context bytes exactly as they are, and vice versa.
// The backup is the only source of truth for slot contents and patch offsets, so it must describe
// the SAME build as the file being patched. After an AG upgrade the offsets move, and re-seeding
// slots from a stale backup would silently corrupt a perfectly good kernel. Comparing the parsed
// layout (offset + length per slot, plus every context signature offset) catches that cheaply.
function verifyPristineKernel(buffer) {
  const slots = parseEmbedTemplates(buffer);
  const identity = slots.get(IDENTITY_SLOT);
  if (!identity || !buffer.toString('utf8', identity.dataOffset, identity.dataOffset + identity.dataLength).includes(IDENTITY_MARKER)) {
    throw new Error('identity.tmpl 身份校验区不完整，不能作为原始备份');
  }
  const modifiedPrompt = detectPromptTier(slots, buffer) !== 'stock';
  if (modifiedPrompt || inspectContextGates(buffer).some(gate => gate.mode !== 'stock') || findApplyEditsTail(buffer)?.alreadyBypassed) {
    throw new Error('检测到已修改的提示词、上下文或 applyEdits 标记，不能作为原始备份；请使用同版本官方原始内核');
  }
}

function verifyBackupMatches(current, backup, { allowLegacyCustomRestore = false } = {}) {
  if (backup.length !== current.length) {
    return `备份与当前内核大小不一致（备份 ${backup.length} 字节 / 当前 ${current.length} 字节），Antigravity 可能已升级`;
  }
  const backupSlots = parseEmbedTemplates(backup);
  const currentSlots = parseEmbedTemplates(current);
  const names = [...new Set([...backupSlots.keys(), ...currentSlots.keys()])].sort();
  for (const name of names) {
    const a = backupSlots.get(name), b = currentSlots.get(name);
    if (!a || !b) return `备份缺少模板槽位 ${name}，Antigravity 可能已升级`;
    if (a.dataOffset !== b.dataOffset || a.dataLength !== b.dataLength) {
      return `模板槽位 ${name} 在备份与当前内核中的位置不同，Antigravity 可能已升级`;
    }
  }
  const identity = backupSlots.get(IDENTITY_SLOT);
  if (!identity || !backup.subarray(identity.dataOffset, identity.dataOffset + identity.dataLength)
    .equals(current.subarray(identity.dataOffset, identity.dataOffset + identity.dataLength))) {
    return 'identity.tmpl 身份校验区与备份不一致';
  }
  const backupGates = inspectContextGates(backup), currentGates = inspectContextGates(current);
  for (const signature of CONTEXT_SIGNATURES) {
    // Compare every occurrence regardless of mode, so repeated gates cannot hide a build change.
    const locate = gates => gates.filter(gate => gate.id === signature.id).map(gate => gate.offset).sort((a, b) => a - b).join(',');
    if (locate(backupGates) !== locate(currentGates)) {
      return `上下文封顶签名 ${signature.id} 位置不同，Antigravity 可能已升级`;
    }
  }
  const prompt = detectPromptState(currentSlots, current);
  if (prompt.tier === 'unknown') return '提示词处于未知、部分或混合状态，拒绝写入';
  if (prompt.tier === 'custom' && !allowLegacyCustomRestore) return '提示词处于已移除的自定义档位，请先恢复官方原版再应用其他设置';
  if (new Set(currentGates.map(gate => gate.mode)).size > 1) return '上下文封顶签名处于混合状态，拒绝写入';
  // Reconstruct only an exact known patch plan, then compare every byte. Layout alone cannot
  // establish build identity; no unrelated code, auxiliary text or PE metadata may differ.
  const expected = Buffer.from(backup);
  if (prompt.tier === 'custom') {
    // An explicit stock restore may discard the retired core text, but nothing outside the three
    // old custom slots and the known startup-check bypass may differ from this pristine build.
    const applyEdits = findApplyEditsTail(backup);
    if (!applyEdits || applyEdits.alreadyBypassed) return '未找到唯一的原始 applyEdits 校验签名，当前内核版本不受支持';
    for (const name of CORE_SLOTS) {
      const slot = backupSlots.get(name);
      current.subarray(slot.dataOffset, slot.dataOffset + slot.dataLength).copy(expected, slot.dataOffset);
    }
    applyEdits.bypass.copy(expected, applyEdits.offset);
  } else {
    try { applyPromptTier(expected, backup, prompt.tier, backupSlots, prompt.payloadVersion || payloads.version); }
    catch (error) { return error.message; }
  }
  for (const gate of currentGates) {
    const signature = CONTEXT_SIGNATURES.find(item => item.id === gate.id);
    const hex = gate.mode === '512k' ? signature.k512 : gate.mode === '900k' ? signature.k900 : signature.stock;
    Buffer.from(hex, 'hex').copy(expected, gate.offset);
  }
  if (!expected.equals(current)) return '当前内核与备份在已知补丁区域之外或非完整已知载荷处不同，可能版本不匹配或被篡改';
  return null;
}

async function applyKernelPatch(request = {}, options = {}) {
  if (kernelTransactionActive) return { ok: false, logs: [], errors: ['内核变更事务正在进行，请稍后重试'] };
  kernelTransactionActive = true;
  try { return await applyKernelPatchTransaction(request, options); }
  finally { kernelTransactionActive = false; }
}

async function applyKernelPatchTransaction({ promptTier, contextMode } = {}, options = {}) {
  const targets = options.targets || resolveTargets(options.env);
  const homeDir = options.homeDir || os.homedir();
  const logs = [], errors = [], entries = [], plans = [], successLogs = [];
  // An explicit request for the removed tier is rejected instead of silently degrading to stock:
  // only a saved preference from an older build is migrated by normalizePromptTier.
  const requestedTier = promptTier === undefined || promptTier === null ? null : String(promptTier).trim().toLowerCase().replace(/^tier/, '');
  if (requestedTier === 'custom' || requestedTier === 'replace') throw new Error('自定义提示词档位已移除，请选择官方原版或精简');
  const tier = promptTier === undefined || promptTier === null ? null : normalizePromptTier(promptTier);
  const mode = contextMode === undefined || contextMode === null ? null : normalizeContextMode(contextMode);
  if (promptTier !== undefined && promptTier !== null && tier === null) throw new Error('未知的提示词档位：' + promptTier);
  if (contextMode !== undefined && contextMode !== null && mode === null) throw new Error('未知的上下文档位：' + contextMode);
  if (tier === '1' || tier === '2') throw new Error('旧提示词档位仅兼容识别和还原，请选择官方原版、均衡或精简');
  if (tier === null && mode === null) throw new Error('没有需要应用的内核变更');

  // Validate every target before creating any backup or modifying any live file.
  for (const target of targets) {
    if (!fs.existsSync(target.path)) continue;
    try {
      const current = fs.readFileSync(target.path), saved = readOptional(target.backupPath);
      const backup = saved === null ? current : saved;
      verifyPristineKernel(backup);
      const mismatch = verifyBackupMatches(current, backup, { allowLegacyCustomRestore: tier === 'stock' });
      if (mismatch) throw new Error(mismatch + '；请恢复同版本官方原始内核和备份后重试');
      const next = Buffer.from(current), targetLogs = ['▶ ' + target.label];
      let promptResult = null;
      if (tier !== null) {
        promptResult = applyPromptTier(next, backup, tier, undefined, payloads.version);
        targetLogs.push('[提示词] ' + promptResult.message);
      }
      if (mode !== null) {
        const gates = applyContextPatch(next, backup, mode);
        targetLogs.push('[上下文] ' + (gates.length ? '已改写 ' + gates.length + ' 处封顶判断 → ' + CONTEXT_MODES[mode].label : '未找到可改写的封顶签名'));
      }
      if (saved === null) entries.push({ file: target.backupPath, before: null, after: backup });
      const binary = { file: target.path, before: current, after: next, binary: true, backupPath: target.backupPath };
      if (!next.equals(current)) entries.push(binary);
      plans.push({ targetLogs, changed: !next.equals(current), promptResult });
    } catch (error) { errors.push(target.path + '：' + error.message); }
  }
  if (plans.length === 0 && errors.length === 0) errors.push('未找到可应用的 Antigravity 内核');
  if (errors.length) return { ok: false, logs, errors, promptTier: tier, contextMode: mode };
  try {
    const config = mode === null ? { entries: [], logs: [] } : prepareContextConfig(mode, homeDir);
    entries.push(...config.entries);
    stageEntries(entries);
    for (const entry of entries) {
      if (!entry.binary) { commitEntry(entry); continue; }
      if (!sameBytes(readOptional(entry.file), entry.before)) throw new Error('文件已被外部修改：' + entry.file);
      entry.attempted = true; // A writer can change bytes before throwing or failing verification.
      try {
        const result = await writeBinaryWithUnlock(entry.file, entry.before, entry.after);
        if (!fs.readFileSync(entry.file).equals(entry.after)) throw new Error('内核写入后回读校验失败，磁盘内容与目标状态不一致');
        successLogs.push('[完成] 已写入 ' + result.written + ' 字节（' + result.strategy + '）：' + entry.file);
      } catch (error) { throw new Error(entry.file + '：' + error.message); }
    }
    for (const plan of plans) {
      logs.push(...plan.targetLogs);
      if (!plan.changed) logs.push('[跳过] 内核已处于目标状态，无需写入');
    }
    // Compress every pristine backup once the image is known good: a brand new .bak immediately, an
    // older one left uncompressed by a previous build on the next successful apply.
    const freshBackups = new Set(entries
      .filter(entry => entry.before === null && targets.some(target => target.backupPath === entry.file))
      .map(entry => entry.file));
    for (const target of targets) {
      if (!fs.existsSync(target.backupPath)) continue;
      if (await compressBackup(target.backupPath) && freshBackups.has(target.backupPath)) {
        successLogs.push('[完成] 已为备份启用 NTFS 压缩：' + target.backupPath);
      }
    }
    logs.push(...successLogs, ...config.logs);
  } catch (error) {
    logs.push(error.message);
    errors.push(error.message);
    rollbackEntries(entries, errors);
    if (!errors.some(message => message.startsWith('回滚 '))) logs.push('[回滚] 已恢复本轮所有已变更目标');
  } finally { cleanupEntries(entries, errors); }
  const promptResult = plans.map(plan => plan.promptResult).find(Boolean);
  return {
    ok: errors.length === 0,
    logs,
    errors,
    promptTier: tier,
    contextMode: mode
  };
}

async function killLanguageServers() {
  const paths = resolveTargets().map(target => target.path);
  const wasRunning = (await kernelProcessCount(paths, true)) > 0;
  return { wasRunning, stillRunning: wasRunning && (await kernelProcessCount(paths)) > 0 };
}

module.exports = {
  AD_SLOTS,
  BLOAT_SLOTS,
  CORE_SLOTS,
  CONTEXT_SIGNATURES,
  PROMPT_TIERS,
  CONTEXT_MODES,
  SLOT_CAPACITY,
  payloads,
  normalizePromptTier,
  normalizeContextMode,
  compressBackup,
  resolveTargets,
  parseEmbedTemplates,
  computeActiveBytes,
  writePaddedTemplate,
  detectPromptTier,
  detectPromptState,
  detectContextMode,
  inspectContextGates,
  applyPromptTier,
  applyContextPatch,
  syncContextWindowConfig,
  detectConfiguredContextCap,
  inspectKernel,
  applyKernelPatch,
  verifyBackupMatches,
  killLanguageServers,
  languageServerRunning
};
