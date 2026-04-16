/**
 * Comprehensive security tests covering:
 * - Permission enforcement (requirePermission)
 * - ACL object/list isolation
 * - Inactive-account auth denial
 * - Audit-write failure handling
 * - Config fail-fast on missing secrets
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { FIXTURES, getPermissionsForUser, ROLE_PERMISSIONS, makeToken } = require('../setup');

// ─── Permission Enforcement ────────────────────────────────────────────

describe('requirePermission middleware', () => {
  function chain(v) {
    const c = new Proxy({}, { get(_, p) {
      if (p === 'then') return (r) => r(v);
      if (p === 'catch' || p === 'finally') return () => c;
      if (p === Symbol.toStringTag) return 'Promise';
      return () => c;
    }});
    return c;
  }

  function setupRbac(permissions) {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    const db = (t) => {
      if (t === 'user_roles') return chain(permissions);
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
    delete require.cache[require.resolve('../../src/middleware/rbac')];
    const { requirePermission } = require('../../src/middleware/rbac');
    require.cache[connPath] = orig;
    return requirePermission;
  }

  it('should allow user with required permission', async () => {
    const requirePermission = setupRbac(['users.list', 'users.read']);
    const ctx = { state: { user: { id: 'u1' } } };
    let nextCalled = false;
    await requirePermission('users.list')(ctx, async () => { nextCalled = true; });
    assert.ok(nextCalled);
  });

  it('should deny user missing required permission', async () => {
    const requirePermission = setupRbac(['plans.create']);
    const ctx = { state: { user: { id: 'u1' } } };
    await assert.rejects(
      () => requirePermission('users.list')(ctx, async () => {}),
      (err) => err.status === 403 && err.message.includes('Missing permissions')
    );
  });

  it('should deny user with no permissions at all', async () => {
    const requirePermission = setupRbac([]);
    const ctx = { state: { user: { id: 'u1' } } };
    await assert.rejects(
      () => requirePermission('audit.view')(ctx, async () => {}),
      (err) => err.status === 403
    );
  });

  it('should require ALL listed permissions (AND semantics)', async () => {
    const requirePermission = setupRbac(['users.list']);
    const ctx = { state: { user: { id: 'u1' } } };
    await assert.rejects(
      () => requirePermission('users.list', 'users.read')(ctx, async () => {}),
      (err) => err.status === 403 && err.message.includes('users.read')
    );
  });

  it('should deny unauthenticated requests (no user)', async () => {
    const requirePermission = setupRbac([]);
    const ctx = { state: {} };
    await assert.rejects(
      () => requirePermission('audit.view')(ctx, async () => {}),
      (err) => err.status === 401
    );
  });

  it('admin should have all permissions', () => {
    const adminPerms = getPermissionsForUser(FIXTURES.adminUser);
    assert.ok(adminPerms.includes('users.list'));
    assert.ok(adminPerms.includes('audit.view'));
    assert.ok(adminPerms.includes('data.import'));
    assert.ok(adminPerms.includes('content.moderate'));
    assert.ok(adminPerms.length >= 26);
  });

  it('participant should have no permissions', () => {
    const perms = getPermissionsForUser(FIXTURES.participantUser);
    assert.equal(perms.length, 0);
  });

  it('coach should not have admin-only permissions', () => {
    const perms = getPermissionsForUser(FIXTURES.coachUser);
    assert.ok(!perms.includes('users.manage_roles'));
    assert.ok(!perms.includes('users.deactivate'));
    assert.ok(!perms.includes('data.import'));
    assert.ok(!perms.includes('audit.view'));
  });

  it('reviewer should only have content moderation permissions', () => {
    const perms = getPermissionsForUser(FIXTURES.reviewerUser);
    assert.ok(perms.includes('content.moderate'));
    assert.ok(perms.includes('content.manage_categories'));
    assert.ok(!perms.includes('users.list'));
    assert.ok(!perms.includes('data.export'));
    assert.equal(perms.length, 2);
  });
});

// ─── ACL Deny Override and Inheritance ─────────────────────────────────

describe('ACL deny override', () => {
  function setupAcl() {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];

    // Resources: parent → child
    const resources = {
      'parent-1': { id: 'parent-1', parent_id: null, owner_id: 'other-user' },
      'child-1': { id: 'child-1', parent_id: 'parent-1', owner_id: 'other-user' },
    };

    // ACL entries
    const aclEntries = [
      // Allow on parent
      { resource_id: 'parent-1', user_id: 'u1', role_id: null, action: 'read', effect: 'allow' },
      // Deny on child overrides parent's allow
      { resource_id: 'child-1', user_id: 'u1', role_id: null, action: 'read', effect: 'deny' },
    ];

    const db = (table) => {
      if (table === 'user_roles') return chain([]);
      if (table === 'roles') return chain(null); // no admin role match
      if (table === 'resources') {
        return {
          where: (col, val) => ({
            first: () => Promise.resolve(resources[val]),
            then: (r) => r(resources[val]),
            catch: () => {},
            finally: () => {},
          }),
          then: (r) => r([]),
          catch: () => {},
          finally: () => {},
        };
      }
      if (table === 'acl_entries') {
        return {
          where: (col, resourceId) => ({
            where: (col2, action) => ({
              where: (fn) => {
                const entries = aclEntries.filter(
                  (e) => e.resource_id === resourceId && e.action === action
                );
                return {
                  then: (r) => r(entries),
                  catch: () => {},
                  finally: () => {},
                };
              },
              then: (r) => r(aclEntries.filter((e) => e.resource_id === resourceId)),
              catch: () => {},
              finally: () => {},
            }),
            then: (r) => r([]),
            catch: () => {},
            finally: () => {},
          }),
          then: (r) => r([]),
          catch: () => {},
          finally: () => {},
        };
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
    delete require.cache[require.resolve('../../src/middleware/rbac')];
    const rbac = require('../../src/middleware/rbac');
    require.cache[connPath] = orig;
    return rbac;
  }

  function chain(v) {
    const c = new Proxy({}, { get(_, p) {
      if (p === 'then') return (r) => r(v);
      if (p === 'catch' || p === 'finally') return () => c;
      if (p === Symbol.toStringTag) return 'Promise';
      return () => c;
    }});
    return c;
  }

  it('deny entry on child should override parent allow', async () => {
    const { checkAccess } = setupAcl();
    const result = await checkAccess('u1', 'child-1', 'read');
    assert.equal(result, false);
  });
});

// ─── Inactive Account Denial ───────────────────────────────────────────

describe('inactive account auth denial', () => {
  function chain(v) {
    const c = new Proxy({}, { get(_, p) {
      if (p === 'then') return (r) => r(v);
      if (p === 'catch' || p === 'finally') return () => c;
      if (p === Symbol.toStringTag) return 'Promise';
      return () => c;
    }});
    return c;
  }

  it('authenticate should reject deactivated user tokens', async () => {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    const db = (t) => {
      if (t === 'users') return chain({ is_active: false });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
    delete require.cache[require.resolve('../../src/middleware/auth')];
    const { authenticate } = require('../../src/middleware/auth');
    require.cache[connPath] = orig;

    const token = makeToken(FIXTURES.participantUser);
    const ctx = { headers: { authorization: `Bearer ${token}` }, state: {} };
    await assert.rejects(
      () => authenticate()(ctx, async () => {}),
      (err) => err.status === 403 && err.message.includes('deactivated')
    );
  });

  it('authenticate should allow active user tokens', async () => {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    const db = (t) => {
      if (t === 'users') return chain({ is_active: true });
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
    delete require.cache[require.resolve('../../src/middleware/auth')];
    const { authenticate } = require('../../src/middleware/auth');
    require.cache[connPath] = orig;

    const token = makeToken(FIXTURES.adminUser);
    const ctx = { headers: { authorization: `Bearer ${token}` }, state: {} };
    let nextCalled = false;
    await authenticate()(ctx, async () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.equal(ctx.state.user.id, FIXTURES.adminUser.id);
  });
});

// ─── Audit Write Failure Handling ──────────────────────────────────────

describe('audit write failure propagation', () => {
  function chain(v) {
    const c = new Proxy({}, { get(_, p) {
      if (p === 'then') return (r) => r(v);
      if (p === 'catch' || p === 'finally') return () => c;
      if (p === Symbol.toStringTag) return 'Promise';
      return () => c;
    }});
    return c;
  }

  it('writeAuditLog failure should propagate (not be silently caught)', async () => {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    const db = (t) => {
      if (t === 'audit_logs') {
        return {
          insert: () => { throw new Error('DB write failed'); },
          then: (r) => r([]),
          catch: () => {},
          finally: () => {},
        };
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
    delete require.cache[require.resolve('../../src/middleware/audit')];
    const { writeAuditLog } = require('../../src/middleware/audit');
    require.cache[connPath] = orig;

    await assert.rejects(
      () => writeAuditLog({
        actorId: 'u1',
        action: 'test.action',
        resourceType: 'test',
        resourceId: 'r1',
      }),
      { message: 'DB write failed' }
    );
  });

  it('auto-audit on mutating request should propagate failures', async () => {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    const db = (t) => {
      if (t === 'audit_logs') {
        return {
          insert: () => { throw new Error('Audit DB down'); },
          then: (r) => r([]),
          catch: () => {},
          finally: () => {},
        };
      }
      return chain([]);
    };
    db.raw = () => Promise.resolve({ rows: [] });
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };
    delete require.cache[require.resolve('../../src/middleware/audit')];
    const { auditMiddleware } = require('../../src/middleware/audit');
    require.cache[connPath] = orig;

    const ctx = {
      method: 'POST',
      path: '/api/test/123',
      state: { user: { id: 'u1' } },
      status: 201,
      body: { id: '123', data: 'some response' }, // provide body so afterState hash can be computed
      ip: '127.0.0.1',
    };

    await assert.rejects(
      () => auditMiddleware()(ctx, async () => {}),
      { message: 'Audit DB down' }
    );
  });
});

// ─── Config Fail-Fast on Missing Secrets ───────────────────────────────

describe('config secret validation', () => {
  it('should auto-generate secrets in test env', () => {
    // We're running in NODE_ENV=test, so secrets should be auto-generated
    assert.ok(config.jwt.secret);
    assert.ok(config.jwt.secret.length >= 128); // 64 bytes as hex
    assert.ok(config.encryption.key);
    assert.ok(config.encryption.key.length >= 64); // 32 bytes as hex
    assert.ok(config.certificate.secret);
    assert.ok(config.certificate.secret.length >= 128); // 64 bytes as hex
  });

  it('should have correct encryption algorithm', () => {
    assert.equal(config.encryption.algorithm, 'aes-256-gcm');
  });
});

// ─── Role-Permission Mapping Consistency ───────────────────────────────

describe('role-permission mapping', () => {
  it('operations manager should not have destructive permissions', () => {
    const perms = ROLE_PERMISSIONS['Operations Manager'];
    assert.ok(!perms.includes('data.import'), 'ops should not import');
    assert.ok(!perms.includes('data.backup'), 'ops should not backup');
    assert.ok(!perms.includes('users.manage_roles'), 'ops should not manage roles');
    assert.ok(!perms.includes('users.deactivate'), 'ops should not deactivate users');
    assert.ok(!perms.includes('plans.delete'), 'ops should not delete plans');
  });

  it('coach permissions should be scoped to training', () => {
    const perms = ROLE_PERMISSIONS.Coach;
    assert.ok(perms.includes('plans.create'));
    assert.ok(perms.includes('activity_logs.approve_outlier'));
    assert.ok(!perms.includes('campaigns.manage'));
    assert.ok(!perms.includes('content.moderate'));
  });

  it('all roles should have valid permission names', () => {
    const validPerms = new Set([
      'users.list', 'users.read', 'users.manage_roles', 'users.deactivate',
      'plans.create', 'plans.update', 'plans.delete',
      'activity_logs.view_all', 'activity_logs.approve_outlier',
      'assessments.manage_rules', 'assessments.compute_any',
      'rankings.manage_config',
      'content.moderate', 'content.manage_categories', 'content.manage_topics',
      'campaigns.manage', 'campaigns.analytics',
      'messages.send', 'messages.manage_templates', 'messages.broadcast',
      'data.export', 'data.import', 'data.backup', 'data.consistency_check',
      'resources.manage_acl', 'audit.view',
    ]);
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of perms) {
        assert.ok(validPerms.has(p), `${role} has unknown permission: ${p}`);
      }
    }
  });
});
