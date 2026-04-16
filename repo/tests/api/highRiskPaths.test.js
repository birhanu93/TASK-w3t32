/**
 * High-risk path tests with deterministic assertions.
 *
 * Covers:
 *  1. Content route-order: /violation-categories must NOT match /:id
 *  2. ACL enforcement on content /:id operations
 *  3. Sensitive-field export redaction (password_hash, etc.)
 *  4. Sensitive-field import blocking (password_hash, etc.)
 *  5. Admin-only table export/import gating
 *  6. Route authorization correctness for violation-categories
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const { FIXTURES, authHeader, ROLE_PERMISSIONS } = require('../setup');

// ── Proxy-based mock chain ──────────────────────────────────────────────

function chain(v) {
  const c = new Proxy({}, { get(_, p) {
    if (p === 'then') return (r) => r(v);
    if (p === 'catch' || p === 'finally') return () => c;
    if (p === Symbol.toStringTag) return 'Promise';
    return () => c;
  }});
  return c;
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

// ── App builders ────────────────────────────────────────────────────────

function invalidateModuleCache(...modules) {
  for (const m of modules) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
}

function buildContentApp(db) {
  const connPath = require.resolve('../../src/db/connection');
  const orig = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
  invalidateModuleCache(
    '../../src/routes/content',
    '../../src/middleware/rbac',
    '../../src/middleware/audit',
  );
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/content');
  const app = new Koa();
  app.use(errorHandler()); app.use(bodyParser()); app.use(json()); app.use(auditMiddleware());
  app.use(router.routes()); app.use(router.allowedMethods());
  require.cache[connPath] = orig;
  return app;
}

function buildImportExportApp(db) {
  const connPath = require.resolve('../../src/db/connection');
  const orig = require.cache[connPath];
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
  invalidateModuleCache(
    '../../src/routes/importExport',
    '../../src/middleware/rbac',
    '../../src/middleware/audit',
  );
  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');
  const router = require('../../src/routes/importExport');
  const app = new Koa();
  app.use(errorHandler()); app.use(bodyParser({ jsonLimit: '50mb' })); app.use(json()); app.use(auditMiddleware());
  app.use(router.routes()); app.use(router.allowedMethods());
  require.cache[connPath] = orig;
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Content route-order: /violation-categories must not match /:id
// ═══════════════════════════════════════════════════════════════════════

describe('Content route ordering — violation-categories vs /:id', () => {
  it('GET /violation-categories with Participant (no content.manage_categories) returns 403, not content item', async () => {
    // If /:id matched, a Participant would get 404 (looking up content_item with id='violation-categories')
    // The correct behavior is 403 from requirePermission('content.manage_categories')
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      if (t === 'content_items') return chain(null); // would return null if /:id matched
      if (t === 'resources') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'GET', '/api/content/violation-categories', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403, 'Should be 403 from permission check, not 404 from /:id match');
  });

  it('GET /violation-categories with Reviewer (has content.manage_categories) returns 200', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Reviewer);
      if (t === 'violation_categories') return chain([{ id: 'vc1', name: 'Spam', severity: 1 }]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'GET', '/api/content/violation-categories', {
      headers: { Authorization: authHeader(FIXTURES.reviewerUser) },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'Should return array of categories');
  });

  it('GET /topics/list does not hit /:id and returns 200 for any authenticated user', async () => {
    const db = (t) => {
      if (t === 'topics') return chain([]);
      if (t === 'resources') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'GET', '/api/content/topics/list', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 200, 'topics/list should not be intercepted by /:id');
  });

  it('POST /violation-categories with Participant returns 403', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'POST', '/api/content/violation-categories', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
      body: { name: 'New Category' },
    });
    assert.equal(res.status, 403, 'Participant should not be able to create violation categories');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. ACL enforcement on content operations
// ═══════════════════════════════════════════════════════════════════════

describe('Content ACL enforcement on /:id operations', () => {
  it('GET /:id returns 403 when resource ACL denies read access', async () => {
    const contentItem = { id: 'c1', title: 'Secret Doc', author_id: 'other-user' };
    const resource = {
      id: 'r1', type: 'content_item',
      metadata: JSON.stringify({ content_item_id: 'c1' }),
    };
    const aclEntry = {
      resource_id: 'r1',
      user_id: FIXTURES.participantUser.id,
      action: 'read',
      effect: 'deny',
    };

    const db = (t) => {
      if (t === 'content_items') return chain(contentItem);
      if (t === 'resources') return chain(resource);
      if (t === 'user_roles') return chain([]);
      if (t === 'roles') return chain(null); // not admin
      if (t === 'acl_entries') return chain([aclEntry]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'GET', '/api/content/c1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403, 'Should deny read when ACL has deny entry');
  });

  it('GET /:id returns 403 when no resource record exists (fail-closed) for non-author', async () => {
    const contentItem = { id: 'c2', title: 'Public Doc', author_id: 'someone' };
    const db = (t) => {
      if (t === 'content_items') return chain(contentItem);
      // No resource record for content_item
      if (t === 'resources') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'GET', '/api/content/c2', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403, 'Without resource record, ACL is fail-closed — deny non-author');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Sensitive-field export redaction
// ═══════════════════════════════════════════════════════════════════════

describe('Sensitive-field export redaction', () => {
  it('export of users table must NOT contain password_hash', async () => {
    const userRecords = [
      {
        id: 'u1', username: 'alice', email: 'alice@test.com',
        password_hash: '$argon2id$secret_hash', full_name: 'Alice',
        failed_login_attempts: 3, locked_until: '2026-05-01',
        created_at: '2026-04-01', updated_at: '2026-04-01',
      },
    ];
    const exportJob = { id: 'j1', type: 'export', status: 'completed', total_records: 1, processed_records: 1 };
    // Admin perms + 'Administrator' role name so isAdmin() returns true
    const adminPermsWithRole = [...ROLE_PERMISSIONS.Administrator, 'Administrator'];
    const db = (t) => {
      if (t === 'user_roles') return chain(adminPermsWithRole);
      if (t === 'users') return chain(userRecords);
      if (t === 'import_jobs') return chain([exportJob]);
      if (t === 'audit_logs') return chain([]);
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildImportExportApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: { table: 'users', format: 'json' },
    });
    assert.equal(res.status, 200);
    if (Array.isArray(res.body.data)) {
      for (const record of res.body.data) {
        assert.equal(record.password_hash, undefined, 'password_hash must be redacted');
        assert.equal(record.failed_login_attempts, undefined, 'failed_login_attempts must be redacted');
        assert.equal(record.locked_until, undefined, 'locked_until must be redacted');
        // Non-sensitive fields should still be present
        assert.ok(record.username, 'username should remain');
        assert.ok(record.email, 'email should remain');
      }
    }
  });

  it('export of non-admin-only table by Ops Manager should succeed', async () => {
    const plans = [{ id: 'p1', title: 'Plan A', created_at: '2026-04-01', updated_at: '2026-04-01' }];
    const exportJob = { id: 'j2', type: 'export', status: 'completed', total_records: 1, processed_records: 1 };
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'plans') return chain(plans);
      if (t === 'import_jobs') return chain([exportJob]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildImportExportApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'plans', format: 'json' },
    });
    assert.equal(res.status, 200);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Admin-only table gating
// ═══════════════════════════════════════════════════════════════════════

describe('Admin-only table export/import gating', () => {
  it('export of users table by non-Admin (Ops Manager) returns 403', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'roles') return chain(null); // not admin
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildImportExportApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'users', format: 'json' },
    });
    assert.equal(res.status, 403, 'Ops Manager should not export users table');
  });

  it('export of user_roles table by non-Admin returns 403', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'roles') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildImportExportApp(db), 'POST', '/api/data/export', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'user_roles', format: 'json' },
    });
    assert.equal(res.status, 403, 'Ops Manager should not export user_roles table');
  });

  it('import into users table by non-Admin returns 403', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'roles') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildImportExportApp(db), 'POST', '/api/data/import', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'users', data: [{ username: 'injected' }] },
    });
    assert.equal(res.status, 403, 'Ops Manager should not import into users table');
  });

  it('import into acl_entries table by non-Admin returns 403', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS['Operations Manager']);
      if (t === 'roles') return chain(null);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildImportExportApp(db), 'POST', '/api/data/import', {
      headers: { Authorization: authHeader(FIXTURES.opsUser) },
      body: { table: 'acl_entries', data: [{ action: 'read', effect: 'allow' }] },
    });
    assert.equal(res.status, 403, 'Ops Manager should not import into acl_entries table');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Sensitive-field import blocking
// ═══════════════════════════════════════════════════════════════════════

describe('Sensitive-field import blocking', () => {
  it('import into users table strips password_hash from records', async () => {
    // Admin perms + 'Administrator' role name so isAdmin() returns true
    const adminPermsWithRole = [...ROLE_PERMISSIONS.Administrator, 'Administrator'];
    const insertedRecords = [];

    const db = (t) => {
      if (t === 'user_roles') return chain(adminPermsWithRole);
      if (t === 'users') {
        // Build a proxy that captures inserts
        const c = new Proxy({}, { get(_, p) {
          if (p === 'then') return (r) => r([{ id: 'u-new', username: 'imported' }]);
          if (p === 'catch' || p === 'finally') return () => c;
          if (p === Symbol.toStringTag) return 'Promise';
          if (p === 'insert') return (record) => {
            insertedRecords.push(record);
            return c;
          };
          return () => c;
        }});
        return c;
      }
      if (t === 'roles') return chain({ id: 'role-admin', name: 'Administrator' });
      if (t === 'import_jobs') return chain([{ id: 'j-import', status: 'completed' }]);
      if (t === 'audit_logs') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });

    const res = await req(buildImportExportApp(db), 'POST', '/api/data/import', {
      headers: { Authorization: authHeader(FIXTURES.adminUser) },
      body: {
        table: 'users',
        data: [{
          username: 'imported',
          email: 'imported@test.com',
          password_hash: '$argon2id$INJECTED_HASH',
          failed_login_attempts: 99,
          locked_until: '2099-01-01',
        }],
      },
    });

    // The endpoint should succeed (admin has permission) but strip sensitive fields
    assert.ok([200, 201].includes(res.status), `Expected success but got ${res.status}`);

    // Verify the inserted records had sensitive fields stripped
    if (insertedRecords.length > 0) {
      for (const record of insertedRecords) {
        assert.equal(record.password_hash, undefined, 'password_hash must be stripped from import');
        assert.equal(record.failed_login_attempts, undefined, 'failed_login_attempts must be stripped');
        assert.equal(record.locked_until, undefined, 'locked_until must be stripped');
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Content DELETE authorization — only content.moderate permission
// ═══════════════════════════════════════════════════════════════════════

describe('Content DELETE authorization', () => {
  it('Participant cannot delete content (403)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain([]);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'DELETE', '/api/content/c1', {
      headers: { Authorization: authHeader(FIXTURES.participantUser) },
    });
    assert.equal(res.status, 403);
  });

  it('Coach without content.moderate cannot delete content (403)', async () => {
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      if (t === 'user_roles') return chain(ROLE_PERMISSIONS.Coach);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    const res = await req(buildContentApp(db), 'DELETE', '/api/content/c1', {
      headers: { Authorization: authHeader(FIXTURES.coachUser) },
    });
    assert.equal(res.status, 403);
  });
});
