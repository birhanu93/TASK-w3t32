const crypto = require('crypto');
const path = require('path');

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';

/**
 * Resolve a secret from environment.
 * In test mode, auto-generate if missing.
 * In development/production, fail fast — never silently generate security-critical secrets.
 */
function requireSecret(envVar, byteLength) {
  const value = process.env[envVar];
  if (value) return value;
  if (isTest) return crypto.randomBytes(byteLength).toString('hex');
  throw new Error(
    `Missing required secret: ${envVar}. ` +
    `Generate with: node -e "console.log(require('crypto').randomBytes(${byteLength}).toString('hex'))"`
  );
}

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  env,

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'training_assessment',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },

  jwt: {
    secret: requireSecret('JWT_SECRET', 64),
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  // AES-256 encryption key for sensitive fields at rest
  encryption: {
    key: requireSecret('ENCRYPTION_KEY', 32),
    algorithm: 'aes-256-gcm',
  },

  // HMAC secret for certificate verification codes
  certificate: {
    secret: requireSecret('CERTIFICATE_SECRET', 64),
  },

  // Password policy
  password: {
    minLength: 12,
    maxFailedAttempts: 10,
    lockoutMinutes: 15,
  },

  // Assessment defaults
  assessment: {
    outlierStdDevThreshold: 3,
    trailingSubmissionCount: 30,
  },

  // Ranking thresholds (rolling 14-day window)
  ranking: {
    windowDays: 14,
    thresholds: {
      bronze: 60,
      silver: 75,
      gold: 90,
    },
  },

  // Moderation
  moderation: {
    appealWindowDays: 14,
  },

  // Data directory for local storage
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), 'data'),
};

module.exports = config;
