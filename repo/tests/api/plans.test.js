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
  delete require.cache[require.resolve('../../src/routes/plans')];
  delete require.cache[require.resolve('../../src/middleware/rbac')];
  delete require.cache[require.resolve('../../src/middleware/audit')];

  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/plans');
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

describe('GET /api/plans', () => {
  it('should return 401 without auth', async () => {
    const db = () => chain([]); db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/plans');
    assert.equal(res.status, 401);
  });

  it('should return plans list', async () => {
    const db = (t) => {
      if (t === 'plans') return chain([{ count: '0' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/plans', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/plans/:id', () => {
  it('should return 404 for non-existent plan', async () => {
    const db = (t) => {
      if (t === 'plans') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/plans/fake-id', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should return plan with tasks and enrollments', async () => {
    const plan = { id: 'p1', title: 'Test Plan', status: 'active' };
    const db = (t) => {
      if (t === 'plans') return chain(plan);
      if (t === 'tasks') return chain([]);
      if (t === 'plan_enrollments') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'GET', '/api/plans/p1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Test Plan');
    assert.ok(Array.isArray(res.body.tasks));
    assert.ok(Array.isArray(res.body.enrollments));
  });
});

describe('POST /api/plans', () => {
  it('should return 400 without title', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should create plan for Coach', async () => {
    const created = { id: 'p1', title: 'New Plan', status: 'draft' };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      if (t === 'plans') return chain([created]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
      body: { title: 'New Plan' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'New Plan');
  });

  it('should return 403 for Participant', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { title: 'Blocked' },
    });
    assert.equal(res.status, 403);
  });
});

describe('PUT /api/plans/:id', () => {
  it('should return 404 for non-existent plan', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'plans') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'PUT', '/api/plans/fake', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { title: 'Updated' },
    });
    assert.equal(res.status, 404);
  });
});

describe('DELETE /api/plans/:id', () => {
  it('should return 403 for non-Admin', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/plans/p1', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
    });
    assert.equal(res.status, 403);
  });
});

describe('POST /api/plans/:id/enroll', () => {
  it('should return 404 for non-existent plan', async () => {
    const db = (t) => {
      if (t === 'plans') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans/fake/enroll', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should reject enrollment in non-active plan', async () => {
    const db = (t) => {
      if (t === 'plans') return chain({ id: 'p1', status: 'draft' });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans/p1/enroll', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 400);
  });
});

describe('DELETE /api/plans/:planId/tasks/:taskId', () => {
  it('should return 404 for non-existent task', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      if (t === 'tasks') return chain(null); // .first() returns null
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/plans/p1/tasks/fake', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
    });
    assert.equal(res.status, 404);
  });

  it('should produce explicit audit with beforeState on task delete', async () => {
    const auditInserts = [];
    const task = { id: 't1', title: 'Push-ups', plan_id: 'p1', sort_order: 0 };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Administrator);
      if (t === 'tasks') return chain(task);
      if (t === 'audit_logs') {
        return {
          insert(data) { auditInserts.push(data); return { then: (r) => r([]) }; },
          where: () => ({ then: (r) => r([]) }),
        };
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'DELETE', '/api/plans/p1/tasks/t1', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
    });
    assert.equal(res.status, 204);

    const taskAudit = auditInserts.find((a) => a.action === 'task.delete');
    assert.ok(taskAudit, 'Should have task.delete audit record');
    assert.ok(taskAudit.before_hash, 'task.delete must have before_hash from fetched task');
    assert.equal(taskAudit.before_hash.length, 64, 'before_hash should be SHA-256');
  });
});

describe('POST /api/plans/:id/tasks', () => {
  it('should return 400 without title', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans/p1/tasks', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
      body: {},
    });
    assert.equal(res.status, 400);
  });

  it('should create task', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      if (t === 'tasks') return chain([{ id: 't1', title: 'Push-ups', plan_id: 'p1' }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildApp(db), 'POST', '/api/plans/p1/tasks', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
      body: { title: 'Push-ups' },
    });
    assert.equal(res.status, 201);
  });
});
