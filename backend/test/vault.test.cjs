const test = require('node:test');
const assert = require('node:assert');
const { createVault, isEncrypted, PREFIX, KEY_TARGET } = require('../core/vault');

function fakeStore(initial = null) {
  let stored = initial;
  return {
    readKey: async () => stored,
    writeKey: async key => { stored = Buffer.from(key); },
    peek: () => stored
  };
}

test('首次解锁会生成 32 字节主密钥并回读校验', async () => {
  const store = fakeStore();
  const vault = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  assert.equal(await vault.unlock(), true);
  assert.equal(vault.sealEnabled(), true);
  assert.equal(store.peek().length, 32);
  assert.equal(vault.keyTarget, KEY_TARGET);
});

test('同一个主密钥可以解回原文，密文带版本前缀', async () => {
  const store = fakeStore();
  const vault = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  await vault.unlock();
  const sealed = vault.seal('1//0gREFRESHTOKEN');
  assert.ok(sealed.startsWith(PREFIX));
  assert.equal(isEncrypted(sealed), true);
  assert.equal(vault.open(sealed), '1//0gREFRESHTOKEN');

  // 第二次启动复用同一把密钥
  const reopened = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  await reopened.unlock();
  assert.equal(reopened.open(sealed), '1//0gREFRESHTOKEN');
});

test('每次加密的随机 IV 不同（相同明文不会产生相同密文）', async () => {
  const store = fakeStore();
  const vault = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  await vault.unlock();
  assert.notEqual(vault.seal('same-token'), vault.seal('same-token'));
});

test('密文被篡改时拒绝解密，而不是返回垃圾', async () => {
  const store = fakeStore();
  const vault = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  await vault.unlock();
  const sealed = vault.seal('sensitive');
  const bytes = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  assert.throws(() => vault.open(PREFIX + bytes.toString('base64')), error => error.code === 'vault_corrupt');
});

test('没有主密钥时明文原样通过，但已有密文会明确拒绝', async () => {
  const failing = createVault({
    readKey: async () => { throw new Error('凭据管理器不可用'); },
    writeKey: async () => {}
  });
  assert.equal(await failing.unlock(), false);
  assert.equal(failing.sealEnabled(), false);
  assert.equal(failing.seal('plain-token'), 'plain-token', '不能假装加密了');
  assert.equal(failing.open('plain-token'), 'plain-token');

  const sealedElsewhere = (() => {
    const store = fakeStore();
    const vault = createVault({ readKey: store.readKey, writeKey: store.writeKey });
    return vault.unlock().then(() => vault.seal('other-machine'));
  })();
  assert.throws(() => failing.open(PREFIX + Buffer.from('AAAA').toString('base64')), error => error.code === 'vault_locked');
  assert.equal((await sealedElsewhere).startsWith(PREFIX), true);
});

test('强制明文模式只关闭加密写入，仍能读取既有密文', async () => {
  const store = fakeStore();
  const writer = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  await writer.unlock();
  const sealed = writer.seal('keep-me');

  const reader = createVault({ readKey: store.readKey, writeKey: store.writeKey, plaintext: true });
  await reader.unlock();
  assert.equal(reader.sealEnabled(), false);
  assert.equal(reader.seal('new-token'), 'new-token');
  assert.equal(reader.open(sealed), 'keep-me');
});

test('密钥长度异常的凭据不会被覆盖', async () => {
  const store = fakeStore(Buffer.from('too-short'));
  const vault = createVault({ readKey: store.readKey, writeKey: store.writeKey });
  assert.equal(await vault.unlock(), false);
  assert.equal(store.peek().toString(), 'too-short', '不能把可疑凭据直接覆盖掉');
});
