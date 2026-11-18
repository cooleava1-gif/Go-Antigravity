// 令牌落盘加密。
//
// 设计取舍：
// - 每次存取都调用 PowerShell 走 DPAPI 太慢（一次 ~500ms，刷配额时会连着写好几回），
//   所以用「DPAPI 保护的主密钥 + AES-256-GCM」：主密钥只在启动时读一次，
//   之后加解密是纯 Node 同步调用。
// - 主密钥存在 Windows 凭据管理器（`go-antigravity:accounts-key`），它本身由 DPAPI 按当前
//   用户加密，因此 accounts.json 被拷到别的机器/别的 Windows 用户下都解不开。
// - 读不到主密钥时（非 Windows、PowerShell 故障）不阻塞使用：退回明文模式并明确告警。
const crypto = require('node:crypto');

const PREFIX = 'enc:v1:';
const KEY_TARGET = 'go-antigravity:accounts-key';
const KEY_BYTES = 32;
const IV_BYTES = 12;

function encode(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decode(key, value) {
  const payload = Buffer.from(String(value).slice(PREFIX.length), 'base64');
  if (payload.length <= IV_BYTES + 16) throw new Error('密文长度异常');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = payload.subarray(IV_BYTES + 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

const isEncrypted = value => typeof value === 'string' && value.startsWith(PREFIX);

/**
 * @param {object} options
 * @param {() => Promise<Buffer|null>} options.readKey  从凭据管理器读主密钥
 * @param {(key: Buffer) => Promise<void>} options.writeKey 首次使用时写入主密钥
 * @param {(message: string, cls?: string) => void} [options.log]
 * @param {boolean} [options.plaintext] 只加密以外的场景用：强制明文落盘（排障用）
 */
function createVault({ readKey, writeKey, log = () => {}, plaintext = false }) {
  let key = null;
  let reason = '尚未初始化';

  async function unlock() {
    try {
      const existing = await readKey();
      if (existing && existing.length === KEY_BYTES) {
        key = existing;
        reason = 'ok';
      } else if (existing) {
        // 密钥长度不对，说明凭据被别的东西占了；不覆盖，避免把旧数据永久锁死。
        reason = `凭据 ${KEY_TARGET} 长度异常（${existing.length} 字节）`;
      } else {
        const fresh = crypto.randomBytes(KEY_BYTES);
        await writeKey(fresh);
        const verify = await readKey();
        if (!verify || !verify.equals(fresh)) throw new Error('写入后回读不一致');
        key = fresh;
        reason = 'ok';
        log('已生成账户加密主密钥（存放于 Windows 凭据管理器）');
      }
    } catch (error) {
      key = null;
      reason = error.message || String(error);
      log(`账户加密不可用：${reason}；令牌将以明文保存`, 'tag-alert');
    }
    return Boolean(key);
  }

  const canOpen = () => Boolean(key);
  const sealEnabled = () => Boolean(key) && !plaintext;

  function seal(value) {
    if (typeof value !== 'string' || !value) return value;
    if (isEncrypted(value)) return value; // 已经是密文，避免二次加密
    if (!sealEnabled()) return value;
    return encode(key, value);
  }

  function open(value) {
    if (typeof value !== 'string' || !value) return value;
    if (!isEncrypted(value)) return value; // 旧文件的明文，读进内存后由上层重新加密
    if (!key) {
      const error = new Error(`无法解密本地令牌：${reason}`);
      error.code = 'vault_locked';
      throw error;
    }
    try {
      return decode(key, value);
    } catch {
      const error = new Error('无法解密本地令牌：密文损坏或主密钥已变更');
      error.code = 'vault_corrupt';
      throw error;
    }
  }

  return {
    unlock,
    seal,
    open,
    isEncrypted,
    canOpen,
    sealEnabled,
    get reason() { return reason; },
    keyTarget: KEY_TARGET
  };
}

/**
 * 生产用：主密钥存 Windows 凭据管理器（与 AG 凭据同一套 P/Invoke 脚本）。
 */
function createCredentialVault({ agcred, log, plaintext = false, platform = process.platform }) {
  return createVault({
    plaintext,
    log,
    readKey: async () => {
      if (platform !== 'win32') throw new Error('仅 Windows 支持凭据管理器');
      const encoded = await agcred.runScript('read', undefined, KEY_TARGET);
      if (!encoded) return null;
      return Buffer.from(encoded, 'base64');
    },
    writeKey: async key => {
      if (platform !== 'win32') throw new Error('仅 Windows 支持凭据管理器');
      await agcred.runScript('write', key.toString('base64'), KEY_TARGET);
    }
  });
}

module.exports = { createVault, createCredentialVault, isEncrypted, PREFIX, KEY_TARGET };
