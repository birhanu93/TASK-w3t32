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
  delete require.cache[require.resolve('../../src/routes/campaigns')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/campaigns');
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

describe('POST /api/campaigns', () => {
  it('should return 400 without name', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should create campaign', async () => {
    const campaign = { id: 'cam1', name: 'Summer Sale', status: 'draft' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'campaigns') return chain([campaign]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { name: 'Summer Sale' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Summer Sale');
  });
});

describe('PUT /api/campaigns/:id rollout phase validation', () => {
  it('should reject invalid rollout phase values on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', rollout_phases: null, start_at: null, end_at: null };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(existing);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 10 }, { percent: 50 }, { percent: 100 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('Invalid rollout phase 10%'));
  });

  it('should reject rollout phases not ending at 100 on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', start_at: null, end_at: null };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(existing);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must end at 100%'));
  });

  it('should reject non-ascending rollout phases on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', start_at: null, end_at: null };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain(existing);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 100 }, { percent: 50 }, { percent: 25 }, { percent: 5 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('strictly ascending'));
  });

  it('should accept valid rollout phases on update', async () => {
    const existing = { id: 'cam1', name: 'Existing', status: 'draft', start_at: null, end_at: null };
    const updated = { ...existing, rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }, { percent: 100 }] };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'campaigns') return chain([updated]); // first call returns existing, update returns updated
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/campaigns/cam1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }, { percent: 100 }] },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/campaigns/coupons', () => {
  it('should return 400 without required fields', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { code: 'TEST' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for fixed discount out of range', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { code: 'BIG', discount_type: 'fixed', discount_value: 100 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('$5'));
  });

  it('should return 400 for percent discount out of range', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { code: 'BIG', discount_type: 'percent', discount_value: 50 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('5%'));
  });
});

describe('POST /api/campaigns/coupons/validate', () => {
  it('should return 400 without code', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons/validate', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should return invalid for non-existent coupon', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/coupons/validate', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { code: 'NOPE' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
  });
});

describe('POST /api/campaigns/events', () => {
  it('should return 400 without required fields', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/events', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { idempotency_key: 'k1' },
    });
    assert.equal(res.status, 400);
  });

  it('should return duplicate for existing idempotency key', async () => {
    const existing = { id: 'e1', idempotency_key: 'k1', event_type: 'click' };
    const db = (t) => chain(existing);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/campaigns/events', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { idempotency_key: 'k1', event_type: 'click' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'duplicate');
  });
});

describe('GET /api/campaigns/analytics/funnel', () => {
  it('should return 400 without funnel_name', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/campaigns/analytics/funnel', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 400);
  });
});
