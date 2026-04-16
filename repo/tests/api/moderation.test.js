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
  delete require.cache[require.resolve('../../src/routes/moderation')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/moderation');
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

describe('GET /api/moderation/cases', () => {
  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/moderation/cases', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return cases for Reviewer', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Reviewer);
      if (t === 'moderation_cases') return chain([{ count: '0' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/moderation/cases', {
      headers: { Authorization: authHeader(FIXTURES.reviewerUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/moderation/report', () => {
  it('should return 400 without content_item_id', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/report', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should return 404 for non-existent content', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/report', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { content_item_id: 'fake' },
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/moderation/cases/:id/review', () => {
  it('should return 400 for invalid decision', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Reviewer);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/cases/c1/review', {
      headers: { Authorization: authHeader(FIXTURES.reviewerUser) },
      body: { decision: 'invalid' },
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/moderation/cases/:id/appeal', () => {
  it('should return 400 without reason', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/cases/c1/appeal', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should return 404 for non-existent case', async () => {
    const db = (t) => {
      if (t === 'moderation_cases') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/cases/fake/appeal', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { reason: 'I disagree' },
    });
    assert.equal(res.status, 404);
  });

  it('should return 403 when non-author attempts appeal', async () => {
    const modCase = { id: 'c1', status: 'resolved_rejected', decided_at: new Date().toISOString(), content_item_id: 'ci1' };
    const contentItem = { id: 'ci1', author_id: 'other-user-id' };
    const db = (t) => {
      if (t === 'moderation_cases') return chain(modCase);
      if (t === 'content_items') return chain(contentItem);
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/cases/c1/appeal', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { reason: 'I disagree' },
    });
    assert.equal(res.status, 403);
  });

  it('should return 400 when case is not rejected', async () => {
    const modCase = { id: 'c1', status: 'open', decided_at: null, content_item_id: 'ci1' };
    const contentItem = { id: 'ci1', author_id: FIXTURES.participantUser.id };
    const db = (t) => {
      if (t === 'moderation_cases') return chain(modCase);
      if (t === 'content_items') return chain(contentItem);
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/cases/c1/appeal', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { reason: 'I disagree' },
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/moderation/appeals/:id/review', () => {
  it('should return 400 for invalid decision', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Reviewer);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/moderation/appeals/a1/review', {
      headers: { Authorization: authHeader(FIXTURES.reviewerUser) },
      body: { decision: 'invalid' },
    });
    assert.equal(res.status, 400);
  });
});
