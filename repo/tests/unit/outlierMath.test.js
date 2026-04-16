/**
 * Deterministic tests for outlier detection math.
 *
 * Validates:
 *  - Z-score computation against known values
 *  - Current log exclusion from its own baseline (excludeLogId)
 *  - Threshold boundary behavior (exactly at 3σ vs beyond)
 *  - Edge cases: stdDev=0, fewer than 2 trailing logs, all-identical values
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// We need to test detectOutlier with a mock DB, so we intercept the module
function loadWithMockDb(mockDb) {
  const connPath = require.resolve('../../src/db/connection');
  const orig = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
  delete require.cache[require.resolve('../../src/services/assessmentEngine')];
  const engine = require('../../src/services/assessmentEngine');
  require.cache[connPath] = orig;
  return engine;
}

function createChainWithTracking(resolveValue) {
  const calls = [];
  function buildChain(rv) {
    const chain = {};
    const methods = [
      'where', 'whereNot', 'whereIn', 'orderBy', 'limit', 'offset',
      'orWhere', 'clone', 'join', 'select', 'first', 'count',
      'insert', 'update', 'del', 'returning',
    ];
    for (const m of methods) {
      chain[m] = function (...args) {
        calls.push({ method: m, args });
        return chain;
      };
    }
    chain.pluck = function (...args) {
      calls.push({ method: 'pluck', args });
      // Return a thenable that resolves to rv
      const pluckChain = { ...chain };
      pluckChain.then = (resolve) => resolve(rv);
      pluckChain[Symbol.toStringTag] = 'Promise';
      pluckChain.catch = () => pluckChain;
      pluckChain.finally = () => pluckChain;
      return pluckChain;
    };
    chain.then = (resolve) => resolve(rv);
    chain[Symbol.toStringTag] = 'Promise';
    chain.catch = () => chain;
    chain.finally = () => chain;
    return chain;
  }
  return { chain: buildChain(resolveValue), calls };
}

describe('Outlier detection math — deterministic', () => {
  it('should compute correct z-score for known distribution', async () => {
    // Trailing values: [10, 10, 10, 10, 10] → mean=10, stdDev=0
    // With stdDev=0, should not flag as outlier
    const { chain, calls } = createChainWithTracking([10, 10, 10, 10, 10]);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'pushups', 100);

    assert.equal(result.isOutlier, false, 'stdDev=0 should never flag outlier');
    assert.equal(result.mean, 10);
    assert.equal(result.stdDev, 0);
  });

  it('should flag value beyond 3 standard deviations', async () => {
    // Trailing values: 30 identical values of 50, except one of 51
    // mean ≈ 50.0333, population stdDev ≈ 0.1826
    // A value of 100 has z = (100 - 50.0333) / 0.1826 ≈ 273.5 >> 3
    const trailing = Array(29).fill(50).concat([51]);
    const { chain } = createChainWithTracking(trailing);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'pushups', 100);

    assert.equal(result.isOutlier, true, 'Value 100 should be flagged with trailing ~50');
    assert.ok(result.zScore > 3, `zScore ${result.zScore} should exceed threshold 3`);
  });

  it('should NOT flag value within 3 standard deviations', async () => {
    // Trailing: [40, 45, 50, 55, 60] → mean=50, variance=50, stdDev≈7.07
    // Value 65: z = |65-50| / 7.07 ≈ 2.12 < 3 → NOT outlier
    const trailing = [40, 45, 50, 55, 60];
    const { chain } = createChainWithTracking(trailing);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'pushups', 65);

    assert.equal(result.isOutlier, false);
    const expectedMean = 50;
    const expectedStdDev = Math.sqrt(50);
    const expectedZ = Math.abs(65 - expectedMean) / expectedStdDev;
    assert.ok(Math.abs(result.mean - expectedMean) < 0.001, `mean should be ${expectedMean}`);
    assert.ok(Math.abs(result.stdDev - expectedStdDev) < 0.001, `stdDev should be ~${expectedStdDev}`);
    assert.ok(Math.abs(result.zScore - expectedZ) < 0.001, `zScore should be ~${expectedZ}`);
  });

  it('should return isOutlier=false when fewer than 2 trailing logs', async () => {
    const { chain } = createChainWithTracking([42]);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'pushups', 999);

    assert.equal(result.isOutlier, false);
    assert.equal(result.mean, null);
    assert.equal(result.stdDev, null);
  });

  it('should return isOutlier=false with empty trailing history', async () => {
    const { chain } = createChainWithTracking([]);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'pushups', 999);

    assert.equal(result.isOutlier, false);
  });

  it('should pass excludeLogId to whereNot for current log exclusion', async () => {
    const calls = [];
    function buildTrackedChain(rv) {
      const chain = {};
      const methods = [
        'where', 'orderBy', 'limit', 'offset',
        'orWhere', 'clone', 'join', 'select', 'first', 'count',
        'insert', 'update', 'del', 'returning',
      ];
      for (const m of methods) {
        chain[m] = function (...args) { calls.push({ method: m, args }); return chain; };
      }
      chain.whereNot = function (...args) {
        calls.push({ method: 'whereNot', args });
        return chain;
      };
      chain.pluck = function (...args) {
        calls.push({ method: 'pluck', args });
        const pluckChain = { ...chain };
        pluckChain.then = (resolve) => resolve(rv);
        pluckChain[Symbol.toStringTag] = 'Promise';
        pluckChain.catch = () => pluckChain;
        pluckChain.finally = () => pluckChain;
        return pluckChain;
      };
      chain.then = (resolve) => resolve(rv);
      chain[Symbol.toStringTag] = 'Promise';
      chain.catch = () => chain;
      chain.finally = () => chain;
      return chain;
    }

    const mockDb = (t) => buildTrackedChain([50, 50, 50]);
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    await engine.detectOutlier('user1', 'pushups', 50, 'log-id-123');

    const whereNotCall = calls.find((c) => c.method === 'whereNot');
    assert.ok(whereNotCall, 'detectOutlier must call whereNot to exclude current log');
    assert.equal(whereNotCall.args[0], 'id');
    assert.equal(whereNotCall.args[1], 'log-id-123');
  });

  it('should compute exact z-score for a hand-calculated example', async () => {
    // Trailing: [10, 20, 30, 40, 50] → mean=30, variance=200, stdDev=√200≈14.142
    // Value 80: z = |80-30| / 14.142 ≈ 3.536 > 3 → outlier
    const trailing = [10, 20, 30, 40, 50];
    const { chain } = createChainWithTracking(trailing);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'run', 80);

    const expectedMean = 30;
    const expectedVar = ((10 - 30) ** 2 + (20 - 30) ** 2 + (30 - 30) ** 2 + (40 - 30) ** 2 + (50 - 30) ** 2) / 5;
    const expectedStdDev = Math.sqrt(expectedVar);
    const expectedZ = Math.abs(80 - expectedMean) / expectedStdDev;

    assert.equal(expectedVar, 200);
    assert.ok(Math.abs(result.mean - expectedMean) < 0.0001);
    assert.ok(Math.abs(result.stdDev - expectedStdDev) < 0.0001);
    assert.ok(Math.abs(result.zScore - expectedZ) < 0.0001);
    assert.equal(result.isOutlier, true, `z=${expectedZ.toFixed(3)} should exceed threshold`);
  });

  it('value exactly at 3σ boundary should NOT be flagged (strictly greater than)', async () => {
    // Trailing: [0, 10] → mean=5, variance=25, stdDev=5
    // Value at exactly mean + 3*stdDev = 5 + 15 = 20 → z = exactly 3.0
    // Config threshold is > 3, so exactly 3 should NOT be flagged
    const trailing = [0, 10];
    const { chain } = createChainWithTracking(trailing);
    const mockDb = (t) => chain;
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const engine = loadWithMockDb(mockDb);
    const result = await engine.detectOutlier('user1', 'run', 20);

    assert.ok(Math.abs(result.zScore - 3.0) < 0.0001, 'zScore should be exactly 3.0');
    assert.equal(result.isOutlier, false, 'Exactly at 3σ should NOT be flagged (> not >=)');
  });
});

describe('Weighted score aggregation math', () => {
  it('normalizeValue should produce exact weighted sums for a two-item rule', () => {
    const { normalizeValue } = require('../../src/services/assessmentEngine');

    // Item 1: rep_count, weight=0.6, min=0, max=100, raw=70 → normalized=70, weighted=42
    // Item 2: time_seconds, weight=0.4, min=10, max=60, raw=20 → normalized=80, weighted=32
    // Total = 42 + 32 = 74
    const n1 = normalizeValue(70, { type: 'rep_count', min_bound: 0, max_bound: 100 });
    const n2 = normalizeValue(20, { type: 'time_seconds', min_bound: 10, max_bound: 60 });

    assert.equal(n1, 70);
    assert.equal(n2, 80);

    const total = Math.round((n1 * 0.6 + n2 * 0.4) * 100) / 100;
    assert.equal(total, 74, 'Weighted sum should be exactly 74');
  });

  it('normalizeValue weights summing to 1.0 should produce valid total_score range', () => {
    const { normalizeValue } = require('../../src/services/assessmentEngine');

    // Three items with weights summing to 1.0
    const items = [
      { type: 'rep_count', min_bound: 0, max_bound: 50, weight: 0.5 },
      { type: 'time_seconds', min_bound: 100, max_bound: 300, weight: 0.3 },
      { type: 'combined_completion', min_bound: 0, max_bound: 100, weight: 0.2 },
    ];
    const rawValues = [25, 200, 80]; // mid, mid, high

    let totalWeighted = 0;
    for (let i = 0; i < items.length; i++) {
      const norm = normalizeValue(rawValues[i], items[i]);
      assert.ok(norm >= 0 && norm <= 100, `Normalized ${norm} out of range`);
      totalWeighted += norm * items[i].weight;
    }

    // rep_count: (25-0)/(50-0)*100 = 50, weighted = 25
    // time_seconds: (300-200)/(300-100)*100 = 50, weighted = 15
    // combined: (80-0)/(100-0)*100 = 80, weighted = 16
    // Total = 56
    const total = Math.round(totalWeighted * 100) / 100;
    assert.equal(total, 56, 'Weighted total should be exactly 56');
    assert.ok(total >= 0 && total <= 100, 'Total must be in [0, 100]');
  });
});
