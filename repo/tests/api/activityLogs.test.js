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
  delete require.cache[require.resolve('../../src/routes/activityLogs')];
  delete require.cache[require.resolve('../../src/services/assessmentEngine')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/activityLogs');
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

describe('POST /api/activity-logs', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs');
    assert.equal(res.status, 401);
  });

  it('should return 400 when missing required fields', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { activity_type: 'run' },
    });
    assert.equal(res.status, 400);
  });

  it('should create activity log', async () => {
    const log = { id: 'l1', activity_type: 'pushups', value: 50, performed_at: '2026-04-16T10:00:00Z' };
    const db = (t) => {
      if (t === 'activity_logs') return chain([log]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { activity_type: 'pushups', value: 50, performed_at: '2026-04-16T10:00:00Z' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.activity_type, 'pushups');
  });
});

describe('GET /api/activity-logs/me', () => {
  it('should return paginated logs', async () => {
    const db = (t) => {
      if (t === 'activity_logs') return chain([{ count: '5' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/activity-logs/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/activity-logs/user/:userId', () => {
  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/activity-logs/user/u2', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('should return logs for Coach', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      if (t === 'activity_logs') return chain([{ count: '0' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/activity-logs/user/u2', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/activity-logs/:id', () => {
  it('should return 404 for non-existent log', async () => {
    const db = (t) => chain(null);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/activity-logs/fake', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return own log', async () => {
    const log = { id: 'l1', user_id: FIXTURES.participantUser.id, activity_type: 'run', is_active: true };
    const db = (t) => chain(log);
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/activity-logs/l1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('POST /api/activity-logs/:id/approve-outlier', () => {
  it('should return 404 for non-existent log', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'activity_logs') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs/fake/approve-outlier', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return 400 when not flagged as outlier', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      if (t === 'activity_logs') return chain({ id: 'l1', is_outlier: false });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs/l1/approve-outlier', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/activity-logs/batch', () => {
  it('should return 400 with empty array', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs/batch', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { logs: [] },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 without logs field', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs/batch', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should insert batch of logs', async () => {
    const db = (t) => {
      if (t === 'activity_logs') return chain([{ id: 'l1' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/activity-logs/batch', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: {
        logs: [
          { activity_type: 'run', value: 100, performed_at: '2026-04-16T10:00:00Z' },
          { activity_type: 'pushups', value: 50, performed_at: '2026-04-16T11:00:00Z' },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.inserted, 2);
  });
});
