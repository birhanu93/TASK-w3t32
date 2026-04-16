const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// normalizeValue is a pure function — test it directly
const { normalizeValue } = require('../../src/services/assessmentEngine');

describe('assessmentEngine.normalizeValue', () => {
  describe('rep_count (higher is better)', () => {
    it('should return 0 for value at min_bound', () => {
      const score = normalizeValue(0, { type: 'rep_count', min_bound: 0, max_bound: 100 });
      assert.equal(score, 0);
    });

    it('should return 100 for value at max_bound', () => {
      const score = normalizeValue(100, { type: 'rep_count', min_bound: 0, max_bound: 100 });
      assert.equal(score, 100);
    });

    it('should return 50 for midpoint value', () => {
      const score = normalizeValue(50, { type: 'rep_count', min_bound: 0, max_bound: 100 });
      assert.equal(score, 50);
    });

    it('should clamp below min to 0', () => {
      const score = normalizeValue(-10, { type: 'rep_count', min_bound: 0, max_bound: 100 });
      assert.equal(score, 0);
    });

    it('should clamp above max to 100', () => {
      const score = normalizeValue(150, { type: 'rep_count', min_bound: 0, max_bound: 100 });
      assert.equal(score, 100);
    });

    it('should handle non-zero min_bound', () => {
      const score = normalizeValue(30, { type: 'rep_count', min_bound: 20, max_bound: 40 });
      assert.equal(score, 50);
    });
  });

  describe('time_seconds (lower is better — inverted)', () => {
    it('should return 100 for value at min_bound (fastest)', () => {
      const score = normalizeValue(10, { type: 'time_seconds', min_bound: 10, max_bound: 60 });
      assert.equal(score, 100);
    });

    it('should return 0 for value at max_bound (slowest)', () => {
      const score = normalizeValue(60, { type: 'time_seconds', min_bound: 10, max_bound: 60 });
      assert.equal(score, 0);
    });

    it('should return 50 for midpoint', () => {
      const score = normalizeValue(35, { type: 'time_seconds', min_bound: 10, max_bound: 60 });
      assert.equal(score, 50);
    });

    it('should clamp above max to 0', () => {
      const score = normalizeValue(100, { type: 'time_seconds', min_bound: 10, max_bound: 60 });
      assert.equal(score, 0);
    });

    it('should clamp below min to 100', () => {
      const score = normalizeValue(5, { type: 'time_seconds', min_bound: 10, max_bound: 60 });
      assert.equal(score, 100);
    });
  });

  describe('combined_completion (higher is better)', () => {
    it('should behave like rep_count (higher = better)', () => {
      const score = normalizeValue(75, { type: 'combined_completion', min_bound: 0, max_bound: 100 });
      assert.equal(score, 75);
    });
  });

  describe('edge cases', () => {
    it('should return 50 when min === max (division by zero guard)', () => {
      const score = normalizeValue(42, { type: 'rep_count', min_bound: 42, max_bound: 42 });
      assert.equal(score, 50);
    });

    it('should handle string numeric values', () => {
      const score = normalizeValue('50', { type: 'rep_count', min_bound: '0', max_bound: '100' });
      assert.equal(score, 50);
    });

    it('should return a number between 0 and 100 inclusive', () => {
      for (let v = -10; v <= 110; v += 5) {
        const score = normalizeValue(v, { type: 'rep_count', min_bound: 0, max_bound: 100 });
        assert.ok(score >= 0 && score <= 100, `score ${score} out of range for value ${v}`);
      }
    });
  });
});
