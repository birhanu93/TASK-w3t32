const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('audit enforcement middleware', () => {
  // We need to test the auto-audit behavior by calling the middleware directly
  // with a mock ctx that simulates a mutating request

  it('should auto-audit mutating requests when route does not call ctx.audit', async () => {
    // Mock db
    const inserts = [];
    const mockDb = (table) => {
      return {
        insert(data) {
          inserts.push({ table, data });
          return { then: (r) => r([]) };
        },
        where: () => ({ then: (r) => r([]) }),
      };
    };
    mockDb.raw = () => Promise.resolve({ rows: [] });

    // Swap db connection
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { auditMiddleware } = require('../../src/middleware/audit');

    const ctx = {
      method: 'POST',
      path: '/api/plans',
      state: { user: { id: 'user-1' } },
      status: 201,
      body: { id: 'plan-1', title: 'New Plan' }, // response body serves as afterState for hashing
      ip: '127.0.0.1',
    };

    await auditMiddleware()(ctx, async () => {
      // Route handler does NOT call ctx.audit
    });

    // Auto-audit should have been triggered
    const auditInsert = inserts.find((i) => i.table === 'audit_logs');
    assert.ok(auditInsert, 'Should have inserted audit_log');
    assert.equal(auditInsert.data.actor_id, 'user-1');
    assert.equal(auditInsert.data.action, 'post.plans');
    assert.equal(JSON.parse(auditInsert.data.details).auto_recorded, true);
    assert.ok(auditInsert.data.after_hash, 'Auto-audit should capture afterState hash from response body');

    // Restore
    require.cache[connPath] = orig;
  });

  it('should NOT auto-audit when route calls ctx.audit explicitly', async () => {
    const inserts = [];
    const mockDb = (table) => ({
      insert(data) { inserts.push({ table, data }); return { then: (r) => r([]) }; },
    });
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { auditMiddleware } = require('../../src/middleware/audit');

    const ctx = {
      method: 'POST',
      path: '/api/plans',
      state: { user: { id: 'user-1' } },
      status: 201,
      ip: '127.0.0.1',
    };

    await auditMiddleware()(ctx, async () => {
      // Route calls ctx.audit explicitly with state for hashing
      await ctx.audit({ action: 'plan.create', resourceType: 'plan', resourceId: 'p1', afterState: { id: 'p1' } });
    });

    // Should only have the explicit audit, not the auto-audit
    const auditInserts = inserts.filter((i) => i.table === 'audit_logs');
    assert.equal(auditInserts.length, 1);
    assert.equal(auditInserts[0].data.action, 'plan.create');

    require.cache[connPath] = orig;
  });

  it('should NOT auto-audit GET requests', async () => {
    const inserts = [];
    const mockDb = (table) => ({
      insert(data) { inserts.push({ table, data }); return { then: (r) => r([]) }; },
    });
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { auditMiddleware } = require('../../src/middleware/audit');

    const ctx = {
      method: 'GET',
      path: '/api/plans',
      state: { user: { id: 'user-1' } },
      status: 200,
      ip: '127.0.0.1',
    };

    await auditMiddleware()(ctx, async () => {});

    const auditInserts = inserts.filter((i) => i.table === 'audit_logs');
    assert.equal(auditInserts.length, 0);

    require.cache[connPath] = orig;
  });

  it('should NOT auto-audit unauthenticated requests', async () => {
    const inserts = [];
    const mockDb = (table) => ({
      insert(data) { inserts.push({ table, data }); return { then: (r) => r([]) }; },
    });
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { auditMiddleware } = require('../../src/middleware/audit');

    const ctx = {
      method: 'POST',
      path: '/api/auth/register',
      state: {},
      status: 201,
      ip: '127.0.0.1',
    };

    await auditMiddleware()(ctx, async () => {});

    const auditInserts = inserts.filter((i) => i.table === 'audit_logs');
    assert.equal(auditInserts.length, 0);

    require.cache[connPath] = orig;
  });

  it('should reject security-relevant actions that lack hashes even without requireHashes flag', async () => {
    const inserts = [];
    const mockDb = (table) => ({
      insert(data) { inserts.push({ table, data }); return { then: (r) => r([]) }; },
    });
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { writeAuditLog, SECURITY_RELEVANT_ACTIONS } = require('../../src/middleware/audit');

    // Every security-relevant action should be rejected without state
    for (const action of SECURITY_RELEVANT_ACTIONS) {
      await assert.rejects(
        () => writeAuditLog({
          actorId: 'user-1',
          action,
          resourceType: 'user',
          resourceId: 'user-1',
          // intentionally omit beforeState and afterState
          // intentionally omit requireHashes (defaults to false)
        }),
        (err) => {
          assert.ok(err.message.includes('before/after state hashes are required'),
            `${action} should require hashes`);
          return true;
        }
      );
    }

    require.cache[connPath] = orig;
  });

  it('should allow security-relevant actions that provide state hashes', async () => {
    const inserts = [];
    const mockDb = (table) => ({
      insert(data) { inserts.push({ table, data }); return { then: (r) => r([]) }; },
    });
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { writeAuditLog } = require('../../src/middleware/audit');

    // Should succeed when afterState is provided
    await writeAuditLog({
      actorId: 'user-1',
      action: 'user.register',
      resourceType: 'user',
      resourceId: 'user-1',
      afterState: { id: 'user-1', username: 'test' },
    });

    const auditInsert = inserts.find((i) => i.table === 'audit_logs');
    assert.ok(auditInsert, 'Should have inserted audit_log');
    assert.ok(auditInsert.data.after_hash, 'Should have after_hash');
    assert.equal(auditInsert.data.after_hash.length, 64, 'Hash should be SHA-256');

    require.cache[connPath] = orig;
  });

  it('should NOT auto-audit failed requests (status >= 400)', async () => {
    const inserts = [];
    const mockDb = (table) => ({
      insert(data) { inserts.push({ table, data }); return { then: (r) => r([]) }; },
    });
    mockDb.raw = () => Promise.resolve({ rows: [] });

    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];
    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/audit')];

    const { auditMiddleware } = require('../../src/middleware/audit');

    const ctx = {
      method: 'POST',
      path: '/api/plans',
      state: { user: { id: 'user-1' } },
      status: 400,
      ip: '127.0.0.1',
    };

    await auditMiddleware()(ctx, async () => {});

    const auditInserts = inserts.filter((i) => i.table === 'audit_logs');
    assert.equal(auditInserts.length, 0);

    require.cache[connPath] = orig;
  });
});
