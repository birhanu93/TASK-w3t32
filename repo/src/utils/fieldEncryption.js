/**
 * Field-level AES-256-GCM encryption for sensitive database fields.
 *
 * Encrypted values are prefixed with 'enc:' to distinguish them from plaintext.
 * This allows gradual migration and safe decrypt-on-read behavior.
 */
const { encrypt, decrypt } = require('./crypto');

const ENC_PREFIX = 'enc:';

/**
 * Encrypt a field value for storage. Returns prefixed ciphertext.
 * Null/undefined values pass through unchanged.
 */
function encryptField(value) {
  if (value === null || value === undefined) return value;
  return ENC_PREFIX + encrypt(String(value));
}

/**
 * Decrypt a field value on read. Handles both encrypted (prefixed) and
 * plaintext values transparently.
 */
function decryptField(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' && value.startsWith(ENC_PREFIX)) {
    return decrypt(value.slice(ENC_PREFIX.length));
  }
  return value; // Already plaintext (pre-migration data)
}

/**
 * Encrypt specified fields in an object before DB write.
 */
function encryptFields(obj, fieldNames) {
  if (!obj) return obj;
  const result = { ...obj };
  for (const field of fieldNames) {
    if (result[field] !== undefined) {
      result[field] = encryptField(result[field]);
    }
  }
  return result;
}

/**
 * Decrypt specified fields in an object after DB read.
 */
function decryptFields(obj, fieldNames) {
  if (!obj) return obj;
  const result = { ...obj };
  for (const field of fieldNames) {
    if (result[field] !== undefined) {
      result[field] = decryptField(result[field]);
    }
  }
  return result;
}

module.exports = { encryptField, decryptField, encryptFields, decryptFields, ENC_PREFIX };
