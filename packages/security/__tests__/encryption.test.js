const { createFieldCipher, generateFieldEncryptionKey } = require('../src');

describe('field encryption', () => {
  test('generateFieldEncryptionKey produces a usable 32-byte base64 key', () => {
    const key = generateFieldEncryptionKey();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
  });

  test('encrypt then decrypt round-trips the original value', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });

    const encrypted = cipher.encrypt('4242-4242-4242-4242');

    expect(encrypted).not.toContain('4242');
    expect(cipher.decrypt(encrypted)).toBe('4242-4242-4242-4242');
  });

  test('accepts a hex-encoded key', () => {
    const hexKey = require('crypto').randomBytes(32).toString('hex');
    const cipher = createFieldCipher({ key: hexKey });

    expect(cipher.decrypt(cipher.encrypt('secret'))).toBe('secret');
  });

  test('accepts a raw Buffer key', () => {
    const cipher = createFieldCipher({ key: require('crypto').randomBytes(32) });

    expect(cipher.decrypt(cipher.encrypt('secret'))).toBe('secret');
  });

  test('two encryptions of the same value produce different ciphertext (random IV)', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });

    expect(cipher.encrypt('same-value')).not.toBe(cipher.encrypt('same-value'));
  });

  test('decrypting with the wrong key throws instead of returning garbage', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const other = createFieldCipher({ key: generateFieldEncryptionKey() });

    expect(() => other.decrypt(cipher.encrypt('secret'))).toThrow();
  });

  test('a tampered ciphertext fails to decrypt (authenticated encryption)', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });
    const encrypted = cipher.encrypt('secret');
    const [iv, authTag, ciphertext] = encrypted.split('.');
    const tampered = [iv, authTag, `${ciphertext.slice(0, -2)}zz`].join('.');

    expect(() => cipher.decrypt(tampered)).toThrow();
  });

  test('rejects a key of the wrong length', () => {
    expect(() => createFieldCipher({ key: Buffer.from('too-short') })).toThrow(/32-byte/);
  });

  test('rejects encrypting null or undefined', () => {
    const cipher = createFieldCipher({ key: generateFieldEncryptionKey() });

    expect(() => cipher.encrypt(null)).toThrow();
    expect(() => cipher.encrypt(undefined)).toThrow();
  });
});

describe('createFieldCipher.decrypt: what is refused', () => {
  const { createFieldCipher: make, generateFieldEncryptionKey: newKey } = require('../src');

  test('a payload that is not three dotted parts is refused', () => {
    const cipher = make({ key: newKey() });
    for (const payload of ['', null, undefined, 'abc', 'a.b', 'a.b.c.d']) {
      expect(() => cipher.decrypt(payload)).toThrow(/malformed/);
    }
  });

  test('a truncated authentication tag is refused, even when its bytes are the real ones', () => {
    const cipher = make({ key: newKey() });
    const [iv, tag, data] = cipher.encrypt('secret').split('.');
    const full = Buffer.from(tag, 'base64url');
    for (const length of [4, 8, 12, 15]) {
      const short = full.subarray(0, length).toString('base64url');
      expect(() => cipher.decrypt([iv, short, data].join('.'))).toThrow();
    }
  });

  test('a changed nonce (IV) is refused', () => {
    const cipher = make({ key: newKey() });
    const [iv, tag, data] = cipher.encrypt('secret').split('.');
    const other = Buffer.from(iv, 'base64url');
    other[0] ^= 1;
    expect(() => cipher.decrypt([other.toString('base64url'), tag, data].join('.'))).toThrow();
    expect(() => cipher.decrypt(['', tag, data].join('.'))).toThrow();
  });

  test('a key string that decodes to neither 32 bytes of base64 nor of hex is refused, as is a key of another type', () => {
    expect(() => make({ key: 'trop-court' })).toThrow(/32-byte key encoded as base64 or hex/);
    expect(() => make({ key: 'ab'.repeat(31) })).toThrow(/32-byte/);
    expect(() => make({})).toThrow(/Buffer or a base64\/hex string/);
    expect(() => make({ key: 12345 })).toThrow(/Buffer or a base64\/hex string/);
  });
});
