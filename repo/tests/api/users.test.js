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
  delete require.cache[require.resolve('../../src/routes/users')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];

  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/users');
  const app = new Koa();
  app.use(errorHandler());
  app.use(bodyParser());
  app.use(json());
  app.use(auditMiddleware());
  app.use(router.routes());
  app.use(router.allowedMethods());

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

describe('GET /api/users', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'GET', '/api/users');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant role', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'GET', '/api/users', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return paginated users for admin with full pagination envelope', async () => {
    const db = (t) => {
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'users') return chain([{ count: '2' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'GET', '/api/users', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data), 'data must be an array');
    assert.deepEqual(res.body.pagination, { page: 1, per_page: 20, total: 2, total_pages: 1 });
  });
});

describe('GET /api/users/:id', () => {
  it('should return 404 for non-existent user', async () => {
    const db = (t) => {
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'users') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'GET', '/api/users/nonexistent', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return user for admin', async () => {
    let callNum = 0;
    const db = (t) => {
      if (t === 'user_roles') {
        callNum++;
        if (callNum === 1) return chain(ROLE_PERMISSIONS.Administrator);
        return chain(['Participant']);
      }
      if (t === 'users') return chain({ id: 'u1', username: 'test', email: 't@t.com', is_active: true });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'GET', '/api/users/u1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'test');
  });
});

describe('POST /api/users/:id/roles', () => {
  it('should return 400 with an error message naming role_name', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'POST', '/api/users/u1/roles', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
    assert.match(res.body.error.message, /role_name/);
  });

  it('should return 404 with an error envelope when role not found', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'roles') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'POST', '/api/users/u1/roles', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { role_name: 'NonExistent' },
    });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
    assert.match(res.body.error.message, /not found/i);
  });
});

describe('POST /api/users/:id/deactivate', () => {
  it('should deactivate user for admin', async () => {
    const db = (t) => {
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'users') return chain({ is_active: true });
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'POST', '/api/users/u1/deactivate', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.includes('deactivated'));
  });
});

describe('POST /api/users/:id/activate', () => {
  it('should activate user for admin', async () => {
    const db = (t) => {
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'users') return chain({ is_active: true });
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'POST', '/api/users/u1/activate', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.includes('activated'));
  });
});

describe('DELETE /api/users/:id/roles/:roleName', () => {
  it('should return 404 when role not found', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'roles') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await req(app, 'DELETE', '/api/users/u1/roles/Fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });
});
