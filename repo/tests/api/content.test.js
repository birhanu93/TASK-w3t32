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
  delete require.cache[require.resolve('../../src/routes/content')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/content');
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

describe('GET /api/content', () => {
  it('should return content list', async () => {
    const db = (t) => chain([{ count: '0' }]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/content', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/content/:id', () => {
  it('should return 404 for non-existent item', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/content/fake', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });
});

describe('POST /api/content', () => {
  it('should return 400 without title/content_type', async () => {
    const db = (t) => chain([]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/content', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { title: 'Test' },
    });
    assert.equal(res.status, 400);
  });

  it('should create content with pre-screening', async () => {
    const item = { id: 'c1', title: 'Clean Article', content_type: 'article', status: 'pending_review' };
    const db = (t) => {
      if (t === 'violation_categories') return chain([]);
      if (t === 'content_items') return chain([item]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/content', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { title: 'Clean Article', content_type: 'article' },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.screening);
    assert.equal(res.body.screening.passed, true);
  });

  it('should flag content with keyword violations', async () => {
    const violationCat = {
      name: 'Bad Words', keyword_list: ['forbidden'], file_type_allowlist: [],
      blocked_fingerprints: [], is_active: true,
    };
    const item = { id: 'c2', title: 'forbidden content', content_type: 'article' };
    let contentCalls = 0;
    const db = (t) => {
      if (t === 'violation_categories') return chain([violationCat]);
      if (t === 'content_items') return chain([item]);
      if (t === 'moderation_cases') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/content', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { title: 'forbidden content', content_type: 'article' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.screening.passed, false);
    assert.ok(res.body.screening.violations.length > 0);
  });
});

describe('PUT /api/content/:id', () => {
  it('should return 404 for non-existent', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/content/fake', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { title: 'Updated' },
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/content/:id', () => {
  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/content/c1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });
});

describe('GET /api/content/topics/list', () => {
  it('should return topics', async () => {
    const db = (t) => chain([]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/content/topics/list', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/content/topics', () => {
  it('should return 400 without name', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/content/topics', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /api/content/violation-categories', () => {
  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      if (t === 'violation_categories') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/content/violation-categories', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    // Route /violation-categories is registered before /:id so permission check is enforced
    assert.equal(res.status, 403, 'Participant must get 403 for violation-categories');
  });

  it('should return categories for Reviewer', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Reviewer);
      if (t === 'violation_categories') return chain([{ id: 'vc1', name: 'Spam' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/content/violation-categories', {
      headers: { Authorization: authHeader(FIXTURES.reviewerUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/content/violation-categories', () => {
  it('should return 400 without name', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/content/violation-categories', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });
});
