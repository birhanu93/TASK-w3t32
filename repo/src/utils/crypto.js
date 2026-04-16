const crypto = require('crypto');
const config = require('../config');

/**
 * AES-256-GCM encryption for sensitive fields at rest.
 */
function encrypt(plaintext) {
  const key = Buffer.from(config.encryption.key, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(config.encryption.algorithm, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(ciphertext) {
  const [ivHex, tagHex, encrypted] = ciphertext.split(':');
  const key = Buffer.from(config.encryption.key, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(config.encryption.algorithm, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * HMAC-SHA256 for certificate verification codes.
 * Computed from: certificateId + userId + issuedAt + secret
 */
function generateCertificateCode(certificateId, userId, issuedAt) {
  const data = `${certificateId}:${userId}:${issuedAt}`;
  return crypto
    .createHmac('sha256', config.certificate.secret)
    .update(data)
    .digest('hex');
}

function verifyCertificateCode(code, certificateId, userId, issuedAt) {
  const expected = generateCertificateCode(certificateId, userId, issuedAt);
  return crypto.timingSafeEqual(Buffer.from(code, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * SHA-256 hash for content fingerprinting and audit before/after hashes.
 */
function sha256(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/**
 * Deterministic hash for A/B test assignment.
 * Returns a float [0, 1) based on userId + testId.
 */
function deterministicHash(userId, testId) {
  const hash = crypto
    .createHash('sha256')
    .update(`${userId}:${testId}`)
    .digest('hex');
  // Take first 8 hex chars → 32-bit int → normalize to [0, 1)
  const intVal = parseInt(hash.substring(0, 8), 16);
  return intVal / 0xffffffff;
}

module.exports = {
  encrypt,
  decrypt,
  generateCertificateCode,
  verifyCertificateCode,
  sha256,
  deterministicHash,
};
