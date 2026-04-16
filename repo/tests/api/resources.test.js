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
  delete require.cache[require.resolve('../../src/routes/resources')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/resources');
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

describe('GET /api/resources', () => {
  it('should return resource list', async () => {
    const db = (t) => chain([{ count: '0' }]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/resources', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/resources', () => {
  it('should return 400 without type/name', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { type: 'folder' },
    });
    assert.equal(res.status, 400);
  });

  it('should create resource', async () => {
    const resource = { id: 'r1', type: 'folder', name: 'Docs', owner_id: FIXTURES.participantUser.id };
    const db = (t) => {
      if (t === 'resources') return chain([resource]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { type: 'folder', name: 'Docs' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Docs');
  });
});

describe('POST /api/resources/:id/acl', () => {
  it('should return 400 without action', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { user_id: 'u1' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 without user_id or role_id', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { action: 'read' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for invalid action', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { user_id: 'u1', action: 'fly' },
    });
    assert.equal(res.status, 400);
  });

  it('should create ACL entry', async () => {
    const entry = { id: 'acl1', resource_id: 'r1', user_id: 'u1', action: 'read', effect: 'allow' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'acl_entries') return chain([entry]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/resources/r1/acl', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { user_id: 'u1', action: 'read' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'read');
  });
});
