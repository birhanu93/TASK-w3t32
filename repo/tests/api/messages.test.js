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
  delete require.cache[require.resolve('../../src/routes/messages')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/messages');
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

describe('POST /api/messages/templates', () => {
  it('should return 400 with missing fields', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/templates', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { name: 'test' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 for invalid category', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/templates', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { name: 'test', category: 'invalid', subject_template: 'Hi', body_template: 'Hello' },
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/messages/send', () => {
  it('should return 400 without recipient_id', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/send', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 without subject/body when no template', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'subscriptions') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/send', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { recipient_id: 'u1' },
    });
    assert.equal(res.status, 400);
  });

  it('should send direct message', async () => {
    const msg = { id: 'm1', recipient_id: 'u1', subject: 'Hello', body: 'World' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      if (t === 'subscriptions') return chain(null);
      if (t === 'messages') return chain([msg]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/send', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
      body: { recipient_id: 'u1', subject: 'Hello', body: 'World' },
    });
    assert.equal(res.status, 201);
  });
});

describe('POST /api/messages/broadcast', () => {
  it('should return 400 without recipient_ids', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/broadcast', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/messages/inbox', () => {
  it('should return inbox for authenticated user', async () => {
    const db = (t) => chain([{ count: '0' }]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/inbox', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/messages/:id', () => {
  it('should return 404 for non-existent message', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/fake', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return 403 for other users message', async () => {
    const msg = { id: 'm1', recipient_id: 'other', sender_id: 'other2' };
    const db = (t) => chain(msg);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/m1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/messages/:id/read', () => {
  it('should return 404 for non-existent message', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/fake/read', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });
});

describe('PUT /api/messages/subscriptions', () => {
  it('should return 400 without category', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/messages/subscriptions', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });
});
