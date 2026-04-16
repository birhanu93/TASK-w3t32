const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computePercentile } = require('../../src/services/assessmentEngine');

describe('computePercentile', () => {
  it('should return 100th percentile with no peers', () => {
    const result = computePercentile('all', [], 80);
    assert.equal(result.cohort, 'all');
    assert.equal(result.percentile, 100);
    assert.equal(result.peer_count, 0);
  });

  it('should compute correct percentile when user scores higher than all peers', () => {
    const peers = [
      { total_score: 50 },
      { total_score: 60 },
      { total_score: 70 },
    ];
    const result = computePercentile('all', peers, 80);
    assert.equal(result.percentile, 100); // 3/3 peers are below
    assert.equal(result.peer_count, 3);
  });

  it('should compute correct percentile when user scores lower than all peers', () => {
    const peers = [
      { total_score: 80 },
      { total_score: 90 },
      { total_score: 95 },
    ];
    const result = computePercentile('all', peers, 50);
    assert.equal(result.percentile, 0); // 0/3 peers are below
  });

  it('should compute correct percentile for middle score', () => {
    const peers = [
      { total_score: 40 },
      { total_score: 60 },
      { total_score: 80 },
      { total_score: 90 },
    ];
    const result = computePercentile('plan:abc', peers, 70);
    // 2 out of 4 are below (40, 60) → 50th percentile
    assert.equal(result.percentile, 50);
    assert.equal(result.cohort, 'plan:abc');
  });

  it('should handle ties correctly', () => {
    const peers = [
      { total_score: 70 },
      { total_score: 70 },
      { total_score: 70 },
    ];
    const result = computePercentile('all', peers, 70);
    // 0 peers are strictly below → 0th percentile
    assert.equal(result.percentile, 0);
  });

  it('should accept custom cohort names', () => {
    const result = computePercentile('custom:team-alpha', [{ total_score: 50 }], 80);
    assert.equal(result.cohort, 'custom:team-alpha');
  });
});
