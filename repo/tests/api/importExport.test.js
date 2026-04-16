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
  delete require.cache[require.resolve('../../src/routes/importExport')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/importExport');
  const app = new Koa();
  app.use(errorHandler()); app.use(bodyParser({ jsonLimit: '50mb' })); app.use(json()); app.use(auditMiddleware());
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

describe('POST /api/data/export', () => {
  it('should return 400 for invalid table', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { table: 'invalid_table' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for invalid format', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { table: 'users', format: 'xml' },
    });
    assert.equal(res.status, 400);
  });

  it('should export data as JSON', async () => {
    const db = (t) => {
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'plans') return chain([]);
      if (t === 'import_jobs') return chain([{ id: 'j1', type: 'export', status: 'completed' }]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'plans', format: 'json' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.job);
    assert.ok(Array.isArray(res.body.data));
  });
});

describe('POST /api/data/import', () => {
  it('should return 400 for invalid table', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/import', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { table: 'invalid', data: [] },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 without data', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/import', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { table: 'plans' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 403 for non-Admin', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/import', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'users', data: [] },
    });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/data/jobs', () => {
  it('should return jobs list for admin', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'import_jobs') return chain([{ count: '0' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/data/jobs', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/data/jobs/:id', () => {
  it('should return 404 for non-existent job', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'import_jobs') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/data/jobs/fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });
});
