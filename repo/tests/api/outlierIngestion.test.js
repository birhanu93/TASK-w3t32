/**
 * Tests for outlier enforcement wired into activity log ingestion.
 * Both single and batch submit must auto-check trailing-30/3σ and flag outliers.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const { FIXTURES, authHeader, ROLE_PERMISSIONS } = require('../setup');

function chain(v) {
  const c = new Proxy({}, { get(_, p) {
    if (p === 'then') return (r) => r(v);
    if (p === 'catch' || p === 'finally') return () => c;
    if (p === Symbol.toStringTag) return 'Promise';
    return () => c;
  }});
  return c;
}

function buildApp(db) {
  const connPath = require.resolve('../../src/db/connection');
  const orig = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
  delete require.cache[require.resolve('../../src/routes/activityLogs')];
  delete require.cache[require.resolve('../../src/services/assessmentEngine')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/activityLogs');
  const app = new Koa();
  app.use(errorHandler()); app.use(bodyParser()); app.use(json()); app.use(auditMiddleware());
  app.use(router.routes()); app.use(router.allowedMethods());
  require.cache[connPath] = orig;
  return app;
}

async function req(app, method, path, opts = {}) {
  const server = http.createServer(app.callback());
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const o = { method, headers: { 'Content-Type': 'application/json', ...opts.headers } };
    if (opts.body !== undefined) o.body = JSON.stringify(opts.body);
    const res = await fetch(`http://localhost:${port}${path}`, o);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  } finally { server.close(); }
}

describe('Outlier enforcement in single log submission', () => {
  it('should include outlier_detection in response', async () => {
    const insertedLog = { id: 'l1', activity_type: 'pushups', value: 50, user_id: 'u1' };
    // Mock: trailing query returns < 2 results → no outlier possible
    const db = (t) => {
      if (t === 'activity_logs') return chain([insertedLog]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { activity_type: 'pushups', value: 50, performed_at: '2026-04-16T10:00:00Z' },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.outlier_detection !== undefined, 'Response must include outlier_detection');
    assert.equal(res.body.outlier_detection.isOutlier, false);
  });

  it('should return isOutlier=false when fewer than 2 trailing logs', async () => {
    const insertedLog = { id: 'l1', activity_type: 'run', value: 100, user_id: 'u1' };
    // pluck returns only 1 value → not enough history
    let pluckCalled = false;
    const db = (t) => {
      if (t === 'activity_logs') {
        // The insert returns the record; the trailing query returns [100]
        const c = new Proxy({}, { get(_, p) {
          if (p === 'then') return (r) => r([insertedLog]);
          if (p === 'pluck') { pluckCalled = true; return () => chain([100]); }
          if (p === 'catch' || p === 'finally') return () => c;
          if (p === Symbol.toStringTag) return 'Promise';
          return () => c;
        }});
        return c;
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { activity_type: 'run', value: 100, performed_at: '2026-04-16T10:00:00Z' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.outlier_detection.isOutlier, false);
  });
});

describe('Outlier enforcement in batch log submission', () => {
  it('should include outlier_detection per log and outliers_flagged count', async () => {
    const log1 = { id: 'l1', activity_type: 'pushups', value: 50, user_id: 'u1' };
    const log2 = { id: 'l2', activity_type: 'run', value: 100, user_id: 'u1' };
    const db = (t) => {
      if (t === 'activity_logs') return chain([log1]); // returns for each insert + trailing
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs/batch', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {
        logs: [
          { activity_type: 'pushups', value: 50, performed_at: '2026-04-16T10:00:00Z' },
          { activity_type: 'run', value: 100, performed_at: '2026-04-16T11:00:00Z' },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.inserted, 2);
    assert.equal(typeof res.body.outliers_flagged, 'number');
    // Each log should have outlier_detection
    for (const log of res.body.logs) {
      assert.ok(log.outlier_detection !== undefined, 'Each log must include outlier_detection');
    }
  });
});
