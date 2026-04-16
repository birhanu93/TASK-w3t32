const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../../src/config');

describe('config', () => {
  it('should have a port number', () => {
    assert.equal(typeof config.port, 'number');
    assert.ok(config.port > 0);
  });

  it('should have database config', () => {
    assert.ok(config.db.host);
    assert.ok(config.db.database);
    assert.ok(config.db.user);
    assert.equal(typeof config.db.port, 'number');
  });

  it('should have jwt config with secret and expiresIn', () => {
    assert.ok(config.jwt.secret);
    assert.ok(config.jwt.expiresIn);
  });

  it('should have encryption config with key and algorithm', () => {
    assert.ok(config.encryption.key);
    assert.equal(config.encryption.algorithm, 'aes-256-gcm');
  });

  it('should have certificate secret', () => {
    assert.ok(config.certificate.secret);
  });

  it('should have password policy', () => {
    assert.equal(config.password.minLength, 12);
    assert.equal(config.password.maxFailedAttempts, 10);
    assert.equal(config.password.lockoutMinutes, 15);
  });

  it('should have assessment defaults', () => {
    assert.equal(config.assessment.outlierStdDevThreshold, 3);
    assert.equal(config.assessment.trailingSubmissionCount, 30);
  });

  it('should have ranking thresholds', () => {
    assert.equal(config.ranking.windowDays, 14);
    assert.equal(config.ranking.thresholds.bronze, 60);
    assert.equal(config.ranking.thresholds.silver, 75);
    assert.equal(config.ranking.thresholds.gold, 90);
  });

  it('should have moderation config', () => {
    assert.equal(config.moderation.appealWindowDays, 14);
  });

  it('should have a data directory', () => {
    assert.ok(config.dataDir);
  });
});
