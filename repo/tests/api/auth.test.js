/**
 * API tests for /api/auth routes.
 * Tests register, login, get profile, update profile, change password.
 * Uses mock DB via Module._cache manipulation.
 */
const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { FIXTURES, authHeader, makeToken, makeExpiredToken, ROLE_PERMISSIONS } = require('../setup');

// Stub argon2 to avoid native compilation issues in test
const argon2Stub = {
  argon2id: 2,
  hash: async () => '$argon2id$v=19$m=65536,t=3,p=4$fakesalt$fakehash',
  verify: async (hash, password) => password === 'correct_password' || password === 'ValidPassword123',
};

// ── Build a test app with mocked dependencies ──────────────────────────
function buildApp(dbMock) {
  // Override require cache for db/connection
  const connPath = require.resolve('../../src/db/connection');
  const origConn = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: dbMock };

  // Override argon2
  const argon2Path = require.resolve('argon2');
  const origArgon2 = require.cache[argon2Path];
  require.cache[argon2Path] = { id: argon2Path, filename: argon2Path, loaded: true, exports: argon2Stub };

  // Clear route cache so it picks up new mocks
  const routePath = require.resolve('../../src/routes/auth');
  delete require.cache[routePath];
  const auditPath = require.resolve('../../src/middleware/audit');
  delete require.cache[auditPath];
  const rbacPath = require.resolve('../../src/middleware/rbac');
  delete require.cache[rbacPath];

  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/auth');

  const app = new Koa();
  app.use(errorHandler());
  app.use(bodyParser());
  app.use(json());
  app.use(auditMiddleware());
  app.use(router.routes());
  app.use(router.allowedMethods());

  // Restore after building
  require.cache[connPath] = origConn;
  require.cache[argon2Path] = origArgon2;

  return app;
}

async function request(app, method, path, { body, headers = {} } = {}) {
  const server = http.createServer(app.callback());
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`http://localhost:${port}${path}`, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, body: data };
  } finally {
    server.close();
  }
}

// ── Chainable DB mock builder ──────────────────────────────────────────
function chain(resolveValue) {
  const c = new Proxy({}, {
    get(target, prop) {
      if (prop === 'then') return (resolve) => resolve(resolveValue);
      if (prop === 'catch' || prop === 'finally') return () => c;
      if (prop === Symbol.toStringTag) return 'Promise';
      return () => c;
    }
  });
  return c;
}

function makeDb(overrides = {}) {
  const fn = (table) => {
    if (overrides[table] !== undefined) return chain(overrides[table]);
    return chain([]);
  };
  fn.raw = () => Promise.resolve({ rows: [] });
  return fn;
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('Auth audit hash enforcement', () => {
  it('should write after_hash on user.register audit record', async () => {
    const auditInserts = [];
    const returnedUser = { id: 'new-id', username: 'newuser', email: 'new@test.com', full_name: null, created_at: new Date().toISOString() };
    let userQueryCount = 0;
    const smartDb = (table) => {
      if (table === 'audit_logs') {
        return {
          insert(data) { auditInserts.push(data); return { then: (r) => r([]) }; },
          where: () => ({ then: (r) => r([]) }),
        };
      }
      if (table === 'user_roles') return chain([]);
      if (table === 'roles') return chain({ id: 'role-id', name: 'Participant' });
      if (table === 'users') {
        userQueryCount++;
        if (userQueryCount === 1) return chain(null);
        return chain([returnedUser]);
      }
      return chain([]);
    };
    smartDb.raw = () => Promise.resolve({ rows: [] });

    const app = buildApp(smartDb);
    const res = await request(app, 'POST', '/api/auth/register', {
      body: { username: 'newuser', email: 'new@test.com', password: 'ValidPassword123' },
    });
    assert.equal(res.status, 201);

    const registerAudit = auditInserts.find((a) => a.action === 'user.register');
    assert.ok(registerAudit, 'Should have user.register audit record');
    assert.ok(registerAudit.after_hash, 'user.register must have after_hash');
    assert.equal(registerAudit.after_hash.length, 64, 'after_hash should be SHA-256 (64 hex chars)');
  });

  it('should write before_hash and after_hash on user.login audit record', async () => {
    const auditInserts = [];
    const user = {
      id: 'u1', username: 'test', email: 'test@test.com', full_name: 'Test',
      password_hash: '$argon2id$match', locked_until: null,
      failed_login_attempts: 0, is_active: true, last_login_at: null,
    };
    let callCount = 0;
    const db = (table) => {
      if (table === 'users') {
        callCount++;
        if (callCount === 1) return chain(user);
        return chain([]);
      }
      if (table === 'user_roles') return chain([]);
      if (table === 'audit_logs') {
        return {
          insert(data) { auditInserts.push(data); return { then: (r) => r([]) }; },
          where: () => ({ then: (r) => r([]) }),
        };
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'test', password: 'correct_password' },
    });
    assert.equal(res.status, 200);

    const loginAudit = auditInserts.find((a) => a.action === 'user.login');
    assert.ok(loginAudit, 'Should have user.login audit record');
    assert.ok(loginAudit.before_hash, 'user.login must have before_hash');
    assert.ok(loginAudit.after_hash, 'user.login must have after_hash');
    assert.equal(loginAudit.before_hash.length, 64);
    assert.equal(loginAudit.after_hash.length, 64);
  });

  it('should write before_hash and after_hash on user.login_failed audit record', async () => {
    const auditInserts = [];
    const user = {
      id: 'u1', username: 'test', password_hash: '$argon2id$fakehash',
      locked_until: null, failed_login_attempts: 0, is_active: true,
    };
    const db = (table) => {
      if (table === 'users') return chain(user);
      if (table === 'audit_logs') {
        return {
          insert(data) { auditInserts.push(data); return { then: (r) => r([]) }; },
          where: () => ({ then: (r) => r([]) }),
        };
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'test', password: 'wrong_password' },
    });
    assert.equal(res.status, 401);

    const failedAudit = auditInserts.find((a) => a.action === 'user.login_failed');
    assert.ok(failedAudit, 'Should have user.login_failed audit record');
    assert.ok(failedAudit.before_hash, 'user.login_failed must have before_hash');
    assert.ok(failedAudit.after_hash, 'user.login_failed must have after_hash');
    assert.equal(failedAudit.before_hash.length, 64);
    assert.equal(failedAudit.after_hash.length, 64);
  });
});

describe('POST /api/auth/register', () => {
  it('should return 400 when missing fields', async () => {
    const app = buildApp(makeDb());
    const res = await request(app, 'POST', '/api/auth/register', {
      body: { username: 'test' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });

  it('should return 400 when password too short', async () => {
    const app = buildApp(makeDb());
    const res = await request(app, 'POST', '/api/auth/register', {
      body: { username: 'test', email: 'test@test.com', password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('12'));
  });

  it('should return 409 when username exists', async () => {
    const db = makeDb({ users: { id: 'existing' } });
    const app = buildApp(db);
    const res = await request(app, 'POST', '/api/auth/register', {
      body: { username: 'existing', email: 'a@b.com', password: 'ValidPassword123' },
    });
    assert.equal(res.status, 409);
  });

  it('should return 201 with user and token on success', async () => {
    const returnedUser = { id: 'new-id', username: 'newuser', email: 'new@test.com', full_name: null, created_at: new Date().toISOString() };
    const db = (table) => {
      if (table === 'users') {
        // First call = check existing (returns null), second call = insert
        let callCount = 0;
        return chain(null); // .where().orWhere().first() → null (no existing)
      }
      if (table === 'roles') return chain({ id: 'role-id', name: 'Participant' });
      if (table === 'user_roles') return chain([]);
      if (table === 'audit_logs') return chain([]);
      return chain([]);
    };
    // More sophisticated mock for the register flow
    let userQueryCount = 0;
    const smartDb = (table) => {
      if (table === 'audit_logs') return chain([]);
      if (table === 'user_roles') return chain([]);
      if (table === 'roles') return chain({ id: 'role-id', name: 'Participant' });
      if (table === 'users') {
        userQueryCount++;
        if (userQueryCount === 1) return chain(null); // existing check
        return chain([returnedUser]); // insert returning
      }
      return chain([]);
    };
    smartDb.raw = () => Promise.resolve({ rows: [] });

    const app = buildApp(smartDb);
    const res = await request(app, 'POST', '/api/auth/register', {
      body: { username: 'newuser', email: 'new@test.com', password: 'ValidPassword123' },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.username, 'newuser');
  });
});

describe('POST /api/auth/login', () => {
  it('should return 400 when missing fields', async () => {
    const app = buildApp(makeDb());
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'test' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 401 for non-existent user', async () => {
    const app = buildApp(makeDb({ users: null }));
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'nobody', password: 'somepassword12' },
    });
    assert.equal(res.status, 401);
  });

  it('should return 423 when account is locked', async () => {
    const lockedUser = {
      id: 'u1',
      username: 'locked',
      password_hash: 'hash',
      locked_until: new Date(Date.now() + 600000).toISOString(),
      failed_login_attempts: 0,
    };
    const app = buildApp(makeDb({ users: lockedUser }));
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'locked', password: 'anypassword12' },
    });
    assert.equal(res.status, 423);
  });

  it('should return 401 for wrong password', async () => {
    const user = {
      id: 'u1',
      username: 'test',
      password_hash: '$argon2id$fakehash',
      locked_until: null,
      failed_login_attempts: 0,
    };
    const app = buildApp(makeDb({ users: user, audit_logs: [] }));
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'test', password: 'wrong_password' },
    });
    assert.equal(res.status, 401);
  });

  it('should return 200 with token for correct password', async () => {
    const user = {
      id: 'u1',
      username: 'test',
      email: 'test@test.com',
      full_name: 'Test',
      password_hash: '$argon2id$match',
      locked_until: null,
      failed_login_attempts: 0,
      is_active: true,
    };
    let callCount = 0;
    const db = (table) => {
      if (table === 'users') {
        callCount++;
        if (callCount === 1) return chain(user);  // find user
        return chain([]);  // update
      }
      if (table === 'user_roles') return chain([]);
      if (table === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await request(app, 'POST', '/api/auth/login', {
      body: { username: 'test', password: 'correct_password' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.user.id, 'u1');
  });
});

describe('GET /api/auth/me', () => {
  it('should return 401 without token', async () => {
    const app = buildApp(makeDb());
    const res = await request(app, 'GET', '/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('should return user profile with valid token', async () => {
    const user = {
      id: FIXTURES.participantUser.id,
      username: 'participant',
      email: 'p@test.com',
      full_name: 'Part',
      profile: {},
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const db = (table) => {
      if (table === 'users') return chain(user);
      if (table === 'user_roles') return chain(['Participant']);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await request(app, 'GET', '/api/auth/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'participant');
  });

  it('should return 401 with expired token', async () => {
    const app = buildApp(makeDb());
    const token = makeExpiredToken(FIXTURES.participantUser);
    const res = await request(app, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  });
});

describe('PUT /api/auth/me', () => {
  it('should update profile with valid token', async () => {
    const user = { id: FIXTURES.participantUser.id, username: 'p', full_name: 'Old', is_active: true };
    const updated = { ...user, full_name: 'New Name' };
    let callCount = 0;
    const db = (table) => {
      if (table === 'users') {
        callCount++;
        if (callCount === 1) return chain(user); // before
        return chain([updated]); // update returning
      }
      if (table === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await request(app, 'PUT', '/api/auth/me', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { full_name: 'New Name' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.full_name, 'New Name');
  });
});

describe('POST /api/auth/change-password', () => {
  it('should return 400 when missing fields', async () => {
    const app = buildApp(makeDb());
    const res = await request(app, 'POST', '/api/auth/change-password', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { current_password: 'x' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 400 when new password too short', async () => {
    const app = buildApp(makeDb({ users: { id: 'u1', password_hash: 'h', is_active: true } }));
    const res = await request(app, 'POST', '/api/auth/change-password', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { current_password: 'correct_password', new_password: 'short' },
    });
    assert.equal(res.status, 400);
  });

  it('should return 401 when current password is wrong', async () => {
    const app = buildApp(makeDb({ users: { id: 'u1', password_hash: 'h', is_active: true } }));
    const res = await request(app, 'POST', '/api/auth/change-password', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { current_password: 'wrong_password', new_password: 'NewValidPassword123' },
    });
    assert.equal(res.status, 401);
  });

  it('should return 200 on success', async () => {
    const db = (table) => {
      if (table === 'users') return chain({ id: 'u1', password_hash: 'h', is_active: true });
      if (table === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const app = buildApp(db);
    const res = await request(app, 'POST', '/api/auth/change-password', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { current_password: 'correct_password', new_password: 'ValidPassword123' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.includes('changed'));
  });
});
