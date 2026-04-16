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
  delete require.cache[require.resolve('../../src/routes/assessments')];
  delete require.cache[require.resolve('../../src/services/assessmentEngine')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/assessments');
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

describe('GET /api/assessments/rules', () => {
  it('should return rules list', async () => {
    const db = (t) => {
      if (t === 'assessment_rules') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/assessments/rules', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/assessments/rules/active/:type', () => {
  it('should return 404 when no active rule', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/assessments/rules/active/fitness', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return active rule', async () => {
    const rule = { id: 'r1', assessment_type: 'fitness', version: 1, is_active: true };
    const db = (t) => chain(rule);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/assessments/rules/active/fitness', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.assessment_type, 'fitness');
  });
});

describe('POST /api/assessments/rules', () => {
  it('should return 400 when missing fields', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/assessments/rules', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { assessment_type: 'fitness' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 when weights do not sum to 1.00', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/assessments/rules', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {
        assessment_type: 'fitness',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 0.3, min_bound: 0, max_bound: 100 },
          { name: 'run', type: 'time_seconds', weight: 0.3, min_bound: 60, max_bound: 600 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('1.00'));
  });

  it('should return 400 for invalid scoring type', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/assessments/rules', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {
        assessment_type: 'fitness',
        scoring_items: [
          { name: 'x', type: 'invalid_type', weight: 1.0, min_bound: 0, max_bound: 100 },
        ],
      },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 when item missing required fields', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/assessments/rules', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {
        assessment_type: 'fitness',
        scoring_items: [{ name: 'x', weight: 1.0 }],
      },
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/assessments/compute', () => {
  it('should return 400 without assessment_type', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/assessments/compute', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/assessments/scores/me', () => {
  it('should return score history', async () => {
    const db = (t) => {
      if (t === 'computed_scores') return chain([{ count: '0' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/assessments/scores/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/assessments/scores/:id', () => {
  it('should return 404 for non-existent score', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/assessments/scores/fake', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/assessments/check-outlier', () => {
  it('should return 400 without required fields', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/assessments/check-outlier', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { activity_type: 'run' },
    });
    assert.equal(res.status, 400);
  });
});
