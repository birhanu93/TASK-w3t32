const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptField,
  decryptField,
  encryptFields,
  decryptFields,
  ENC_PREFIX,
} = require('../../src/utils/fieldEncryption');

describe('fieldEncryption', () => {
  describe('encryptField / decryptField', () => {
    it('should round-trip a string value', () => {
      const encrypted = encryptField('secret_value');
      assert.ok(encrypted.startsWith(ENC_PREFIX));
      assert.equal(decryptField(encrypted), 'secret_value');
    });

    it('should pass through null', () => {
      assert.equal(encryptField(null), null);
      assert.equal(decryptField(null), null);
    });

    it('should pass through undefined', () => {
      assert.equal(encryptField(undefined), undefined);
      assert.equal(decryptField(undefined), undefined);
    });

    it('should handle plaintext values on decrypt (pre-migration)', () => {
      assert.equal(decryptField('plaintext_hash'), 'plaintext_hash');
    });

    it('should produce different ciphertexts for same input', () => {
      const a = encryptField('test');
      const b = encryptField('test');
      assert.notEqual(a, b); // random IV
    });

    it('should handle empty string', () => {
      const encrypted = encryptField('');
      assert.equal(decryptField(encrypted), '');
    });
  });

  describe('encryptFields / decryptFields', () => {
    it('should encrypt specified fields in object', () => {
      const obj = { password_hash: 'myhash', username: 'alice' };
      const encrypted = encryptFields(obj, ['password_hash']);
      assert.ok(encrypted.password_hash.startsWith(ENC_PREFIX));
      assert.equal(encrypted.username, 'alice'); // not encrypted
    });

    it('should decrypt specified fields in object', () => {
      const obj = { password_hash: 'myhash', username: 'alice' };
      const encrypted = encryptFields(obj, ['password_hash']);
      const decrypted = decryptFields(encrypted, ['password_hash']);
      assert.equal(decrypted.password_hash, 'myhash');
      assert.equal(decrypted.username, 'alice');
    });

    it('should handle null object', () => {
      assert.equal(encryptFields(null, ['x']), null);
      assert.equal(decryptFields(null, ['x']), null);
    });

    it('should skip fields not present in object', () => {
      const obj = { a: 1 };
      const result = encryptFields(obj, ['nonexistent']);
      assert.deepEqual(result, { a: 1 });
    });

    it('should handle multiple fields', () => {
      const obj = { a: 'secret1', b: 'secret2', c: 'public' };
      const encrypted = encryptFields(obj, ['a', 'b']);
      assert.ok(encrypted.a.startsWith(ENC_PREFIX));
      assert.ok(encrypted.b.startsWith(ENC_PREFIX));
      assert.equal(encrypted.c, 'public');

      const decrypted = decryptFields(encrypted, ['a', 'b']);
      assert.equal(decrypted.a, 'secret1');
      assert.equal(decrypted.b, 'secret2');
    });
  });
});
