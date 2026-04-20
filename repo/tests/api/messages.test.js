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

describe('GET /api/messages/templates', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/templates');
    assert.equal(res.status, 401);
  });

  it('should return 403 for Participant (no messages.manage_templates)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/templates', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return templates list for Admin', async () => {
    const templates = [
      { id: 'tmpl1', name: 'enrollment_confirmation', version: 1, category: 'enrollment', is_active: true },
      { id: 'tmpl2', name: 'score_release', version: 1, category: 'score_release', is_active: true },
    ];
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'message_templates') return chain(templates);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/templates', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'Response should be an array');
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].name, 'enrollment_confirmation');
    assert.equal(res.body[1].category, 'score_release');
  });
});

describe('POST /api/messages/templates', () => {
  it('should return 400 with an error payload listing the required fields', async () => {
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
    assert.ok(res.body.error, 'should include error envelope');
    assert.match(res.body.error.message, /category|subject_template|body_template/i,
      'error must reference missing required fields');
  });

  it('should return 400 for invalid category with the allowed list in the message', async () => {
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
    assert.match(res.body.error.message, /category must be one of/i);
    assert.match(res.body.error.message, /enrollment/);
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

  it('should send direct message and return the persisted message body', async () => {
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
    assert.equal(res.body.id, 'm1');
    assert.equal(res.body.recipient_id, 'u1');
    assert.equal(res.body.subject, 'Hello');
    assert.equal(res.body.body, 'World');
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
  it('should return inbox with pagination and unread count', async () => {
    const db = (t) => chain([{ count: '0' }]);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/inbox', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data !== undefined, 'Response should contain data');
    assert.ok(res.body.pagination !== undefined, 'Response should contain pagination');
    assert.equal(res.body.pagination.page, 1);
    assert.equal(res.body.pagination.per_page, 20);
    assert.ok(res.body.unread_count !== undefined, 'Response should contain unread_count');
    assert.equal(typeof res.body.unread_count, 'number');
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

describe('POST /api/messages/mark-all-read', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/mark-all-read');
    assert.equal(res.status, 401);
  });

  it('should mark all unread messages as read and return count', async () => {
    const db = (t) => {
      if (t === 'messages') return chain(3); // 3 updated rows
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/mark-all-read', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.marked_read !== undefined, 'Response should include marked_read count');
    assert.equal(res.body.marked_read, 3);
  });

  it('should return 0 when no unread messages', async () => {
    const db = (t) => {
      if (t === 'messages') return chain(0);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/messages/mark-all-read', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.marked_read, 0);
  });
});

describe('GET /api/messages/subscriptions/me', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/subscriptions/me');
    assert.equal(res.status, 401);
  });

  it('should return subscription preferences for authenticated user', async () => {
    const subs = [
      { id: 's1', user_id: FIXTURES.participantUser.id, category: 'enrollment', in_app_enabled: true },
      { id: 's2', user_id: FIXTURES.participantUser.id, category: 'score_release', in_app_enabled: false },
    ];
    const db = (t) => {
      if (t === 'subscriptions') return chain(subs);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/subscriptions/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'Response should be an array');
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].category, 'enrollment');
    assert.equal(res.body[0].in_app_enabled, true);
    assert.equal(res.body[1].category, 'score_release');
    assert.equal(res.body[1].in_app_enabled, false);
  });

  it('should return empty array when no subscriptions exist', async () => {
    const db = (t) => {
      if (t === 'subscriptions') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/messages/subscriptions/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
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
