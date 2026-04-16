/**
 * Tests for internal operational endpoint protection.
 * /api/metrics must require admin auth.
 * /health must remain public.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Koa = require('koa');
const Router = require('koa-router');
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

  // Clear cached modules that depend on db
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  delete require.cache[require.resolve('../../src/middleware/metrics')];

  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const { authenticate } = require('../../src/middleware/auth');
  const { requireRole } = require('../../src/middleware/rbac');
  const { metricsMiddleware, getMetrics, persistMetricsSnapshot } = require('../../src/middleware/metrics');

  const app = new Koa();
  app.use(errorHandler());
  app.use(metricsMiddleware());
  app.use(bodyParser());
  app.use(json());
  app.use(auditMiddleware());

  const healthRouter = new Router();

  healthRouter.get('/health', async (ctx) => {
    ctx.body = { status: 'healthy', timestamp: new Date().toISOString() };
  });

  healthRouter.get('/api/metrics', authenticate(), requireRole('Administrator'), async (ctx) => {
    ctx.body = getMetrics();
  });

  healthRouter.post('/api/metrics/snapshot', authenticate(), requireRole('Administrator'), async (ctx) => {
    persistMetricsSnapshot();
    ctx.body = { message: 'snapshot persisted', metrics: getMetrics() };
  });

  app.use(healthRouter.routes());
  app.use(healthRouter.allowedMethods());

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

describe('GET /health (public)', () => {
  it('should return 200 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'healthy');
  });
});

describe('GET /api/metrics (admin-only)', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/metrics');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([{ name: 'Participant' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/metrics', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return 403 for Coach', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([{ name: 'Coach' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/metrics', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return 403 for Operations Manager', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([{ name: 'Operations Manager' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/metrics', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return metrics for Administrator', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([{ name: 'Administrator' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/metrics', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.total_requests, 'number');
    assert.equal(typeof res.body.p95_latency_ms, 'number');
    assert.ok(res.body.started_at);
    assert.ok(res.body.snapshot_at);
  });
});

describe('POST /api/metrics/snapshot (admin-only)', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/metrics/snapshot');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([{ name: 'Participant' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/metrics/snapshot', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should persist snapshot for Administrator', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([{ name: 'Administrator' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/metrics/snapshot', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.metrics);
  });
});
