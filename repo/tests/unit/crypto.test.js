const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  encrypt,
  decrypt,
  generateCertificateCode,
  verifyCertificateCode,
  sha256,
  deterministicHash,
} = require('../../src/utils/crypto');

describe('crypto utilities', () => {
  // ── AES-256-GCM encrypt/decrypt ─────────────────────────────────────
  describe('encrypt / decrypt', () => {
    it('should round-trip a simple string', () => {
      const plaintext = 'hello world';
      const ciphertext = encrypt(plaintext);
      assert.equal(decrypt(ciphertext), plaintext);
    });

    it('should round-trip an empty string', () => {
      const ciphertext = encrypt('');
      assert.equal(decrypt(ciphertext), '');
    });

    it('should round-trip unicode characters', () => {
      const text = 'こんにちは世界 🌍';
      assert.equal(decrypt(encrypt(text)), text);
    });

    it('should round-trip long strings', () => {
      const text = 'a'.repeat(10000);
      assert.equal(decrypt(encrypt(text)), text);
    });

    it('should produce different ciphertexts for the same input (random IV)', () => {
      const a = encrypt('test');
      const b = encrypt('test');
      assert.notEqual(a, b);
    });

    it('ciphertext should have 3 colon-separated parts (iv:tag:data)', () => {
      const parts = encrypt('x').split(':');
      assert.equal(parts.length, 3);
      // IV = 32 hex chars (16 bytes), tag = 32 hex chars (16 bytes)
      assert.equal(parts[0].length, 32);
      assert.equal(parts[1].length, 32);
    });

    it('should throw on tampered ciphertext', () => {
      const ct = encrypt('secret');
      const parts = ct.split(':');
      parts[2] = 'ff' + parts[2].slice(2); // flip a byte
      assert.throws(() => decrypt(parts.join(':')));
    });

    it('should throw on tampered auth tag', () => {
      const ct = encrypt('secret');
      const parts = ct.split(':');
      parts[1] = '00'.repeat(16);
      assert.throws(() => decrypt(parts.join(':')));
    });
  });

  // ── Certificate HMAC ────────────────────────────────────────────────
  describe('generateCertificateCode / verifyCertificateCode', () => {
    const certId = 'cert-001';
    const userId = 'user-001';
    const issuedAt = '2026-04-16T00:00:00.000Z';

    it('should generate a 64-char hex string (SHA-256)', () => {
      const code = generateCertificateCode(certId, userId, issuedAt);
      assert.equal(code.length, 64);
      assert.match(code, /^[0-9a-f]{64}$/);
    });

    it('should be deterministic', () => {
      const a = generateCertificateCode(certId, userId, issuedAt);
      const b = generateCertificateCode(certId, userId, issuedAt);
      assert.equal(a, b);
    });

    it('should verify a valid code', () => {
      const code = generateCertificateCode(certId, userId, issuedAt);
      assert.equal(verifyCertificateCode(code, certId, userId, issuedAt), true);
    });

    it('should reject a tampered code', () => {
      const code = generateCertificateCode(certId, userId, issuedAt);
      const bad = 'ff' + code.slice(2);
      assert.equal(verifyCertificateCode(bad, certId, userId, issuedAt), false);
    });

    it('should reject when certId differs', () => {
      const code = generateCertificateCode(certId, userId, issuedAt);
      assert.equal(verifyCertificateCode(code, 'wrong-id', userId, issuedAt), false);
    });

    it('should reject when userId differs', () => {
      const code = generateCertificateCode(certId, userId, issuedAt);
      assert.equal(verifyCertificateCode(code, certId, 'wrong-user', issuedAt), false);
    });

    it('should reject when issuedAt differs', () => {
      const code = generateCertificateCode(certId, userId, issuedAt);
      assert.equal(verifyCertificateCode(code, certId, userId, '2025-01-01T00:00:00.000Z'), false);
    });

    it('should produce different codes for different inputs', () => {
      const a = generateCertificateCode('a', userId, issuedAt);
      const b = generateCertificateCode('b', userId, issuedAt);
      assert.notEqual(a, b);
    });
  });

  // ── SHA-256 ─────────────────────────────────────────────────────────
  describe('sha256', () => {
    it('should return a 64-char hex string', () => {
      const hash = sha256({ key: 'value' });
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it('should be deterministic', () => {
      const a = sha256({ a: 1 });
      const b = sha256({ a: 1 });
      assert.equal(a, b);
    });

    it('should differ for different inputs', () => {
      assert.notEqual(sha256({ a: 1 }), sha256({ a: 2 }));
    });

    it('should handle strings', () => {
      const hash = sha256('hello');
      assert.equal(hash.length, 64);
    });

    it('should handle arrays', () => {
      const hash = sha256([1, 2, 3]);
      assert.equal(hash.length, 64);
    });

    it('should handle null', () => {
      const hash = sha256(null);
      assert.equal(hash.length, 64);
    });
  });

  // ── Deterministic Hash ──────────────────────────────────────────────
  describe('deterministicHash', () => {
    it('should return a number in [0, 1)', () => {
      const val = deterministicHash('user-1', 'test-1');
      assert.equal(typeof val, 'number');
      assert.ok(val >= 0, `${val} should be >= 0`);
      assert.ok(val < 1, `${val} should be < 1`);
    });

    it('should be deterministic', () => {
      const a = deterministicHash('user-1', 'test-1');
      const b = deterministicHash('user-1', 'test-1');
      assert.equal(a, b);
    });

    it('should differ for different user IDs', () => {
      const a = deterministicHash('user-1', 'test-1');
      const b = deterministicHash('user-2', 'test-1');
      assert.notEqual(a, b);
    });

    it('should differ for different test IDs', () => {
      const a = deterministicHash('user-1', 'test-1');
      const b = deterministicHash('user-1', 'test-2');
      assert.notEqual(a, b);
    });

    it('should distribute roughly uniformly', () => {
      // Generate 1000 hashes and check they span the range
      const values = [];
      for (let i = 0; i < 1000; i++) {
        values.push(deterministicHash(`user-${i}`, 'test'));
      }
      const min = Math.min(...values);
      const max = Math.max(...values);
      assert.ok(min < 0.05, 'should have values near 0');
      assert.ok(max > 0.95, 'should have values near 1');
    });
  });
});
