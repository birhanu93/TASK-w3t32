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

describe('POST /api/data/restore', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/restore');
    assert.equal(res.status, 401);
  });

  it('should return 403 for non-Admin', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/restore', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { backup: {} },
    });
    assert.equal(res.status, 403);
  });

  it('should return 400 without backup object', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/restore', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for invalid table names in backup', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/restore', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { backup: { invalid_table: [] } },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('invalid_table'));
  });

  it('should support dry_run mode', async () => {
    // Include 'Administrator' role name so isAdmin() returns true
    const adminPermsWithRole = [...ROLE_PERMISSIONS.Administrator, 'Administrator'];
    const db = (t) => {
      if (t === 'user_roles') return chain(adminPermsWithRole);
      if (t === 'import_jobs') return chain([{ id: 'j1', type: 'restore' }]);
      if (t === 'audit_logs') return chain([]);
      if (t === 'users') return chain(null); // no existing record
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/restore', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {
        backup: { users: [{ id: 'u1', username: 'test' }] },
        dry_run: true,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.dry_run, true);
    assert.ok(res.body.tables_processed);
  });

  it('should perform actual restore for Admin', async () => {
    // Include 'Administrator' role name so isAdmin() returns true
    const adminPermsWithRole = [...ROLE_PERMISSIONS.Administrator, 'Administrator'];
    const db = (t) => {
      if (t === 'user_roles') return chain(adminPermsWithRole);
      if (t === 'import_jobs') return chain([{ id: 'j1', type: 'restore' }]);
      if (t === 'audit_logs') return chain([]);
      if (t === 'users') return chain(null); // no existing
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/data/restore', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {
        backup: { users: [{ id: 'u1', username: 'restored' }] },
        conflict_resolution: 'last_write_wins',
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.job_id);
    assert.ok(res.body.tables_processed.length > 0);
  });
});
