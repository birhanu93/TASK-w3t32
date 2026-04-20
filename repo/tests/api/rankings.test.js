const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const { FIXTURES, authHeader, ROLE_PERMISSIONS } = require('../setup');

function chain(v) {
  const c = new Proxy({}, {
    get(_, p) {
      if (p === 'then') return (r) => r(v);
      if (p === 'catch' || p === 'finally') return () => c;
      if (p === Symbol.toStringTag) return 'Promise';
      return () => c;
    },
  });
  return c;
}

function buildApp(db) {
  const connPath = require.resolve('../../src/db/connection');
  const orig = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
  delete require.cache[require.resolve('../../src/routes/rankings')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/rankings');
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

describe('POST /api/rankings/compute', () => {
  it('should return 400 with an error payload that names assessment_type', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/rankings/compute', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error, 'should include error envelope');
    assert.match(res.body.error.message, /assessment_type/, 'error message must mention assessment_type');
  });

  it('should return none level when no scores, with rolling_avg=0 and no certificate', async () => {
    const db = (t) => {
      if (t === 'ranking_configs') return chain(null);
      if (t === 'computed_scores') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/rankings/compute', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { assessment_type: 'fitness' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.level, 'none');
    assert.equal(res.body.rolling_avg, 0);
    assert.ok(!res.body.certificate, 'no certificate on none level');
  });
});

describe('GET /api/rankings/leaderboard', () => {
  it('should return paginated leaderboard with the exact pagination contract', async () => {
    const db = (t) => {
      if (t === 'rankings') return chain([{ count: '0' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/rankings/leaderboard', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data), 'data must be an array');
    assert.deepEqual(res.body.pagination, { page: 1, per_page: 50, total: 0, total_pages: 0 });
  });
});

describe('GET /api/rankings/me', () => {
  it('should return user rankings as an empty array for a fresh user', async () => {
    const db = (t) => chain([]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/rankings/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
  });
});

describe('GET /api/rankings/certificates/me', () => {
  it('should return user certificates array (empty for fresh user)', async () => {
    const db = (t) => chain([]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/rankings/certificates/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
  });
});

describe('GET /api/rankings/certificates/verify/:code', () => {
  it('should return valid=false with explicit "not found" message for unknown code', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/rankings/certificates/verify/fakecode');
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
    assert.match(res.body.message, /not found/i);
    assert.ok(!res.body.certificate, 'must not return certificate on invalid code');
  });
});

describe('GET /api/rankings/config', () => {
  it('should return 403 for Participant with an error envelope', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/rankings/config', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
    assert.ok(res.body.error, 'error envelope required on 403');
    assert.equal(typeof res.body.error.message, 'string');
  });

  it('should return configs array for admin (shape check)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'ranking_configs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/rankings/config', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'configs endpoint must return an array');
  });
});

describe('POST /api/rankings/config', () => {
  it('should return 400 with error message naming assessment_type', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/rankings/config', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.match(res.body.error.message, /assessment_type/);
  });
});
