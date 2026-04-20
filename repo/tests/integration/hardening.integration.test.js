/**
 * Integration tests for security hardening paths.
 *
 * These tests require a live PostgreSQL instance. They run migrations,
 * seed minimal data, and exercise the hardened code paths against real SQL.
 *
 * Set TEST_DATABASE_URL or DB_NAME=training_assessment_test to point at
 * a throwaway database. The suite drops/recreates all tables via knex
 * migrate:rollback + migrate:latest on setup.
 *
 * Run:
 *   NODE_ENV=test node --test tests/integration/hardening.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const Koa = require('koa');
const bodyParser = require('koa-bodyparser');
const json = require('koa-json');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const config = require('../../src/config');

// ── Test DB connection ──────────────────────────────────────────────────
const TEST_DB = process.env.TEST_DATABASE_URL || {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT, 10) || 5432,
  database: process.env.DB_NAME || 'training_assessment_test',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

const db = knex({
  client: 'pg',
  connection: TEST_DB,
  pool: { min: 1, max: 5 },
  migrations: {
    directory: __dirname + '/../../src/db/migrations',
    tableName: 'knex_migrations',
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────

function makeToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, roles: user.roles || [] },
    config.jwt.secret,
    { expiresIn: '1h' }
  );
}

function buildApp() {
  // Inject our test db into modules via require cache
  const connPath = require.resolve('../../src/db/connection');
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };

  // Clear cached routes/middleware so they pick up the test db
  const modulePaths = [
    '../../src/middleware/auth',
    '../../src/middleware/rbac',
    '../../src/middleware/audit',
    '../../src/middleware/errorHandler',
    '../../src/routes/auth',
    '../../src/routes/content',
    '../../src/routes/assessments',
    '../../src/routes/campaigns',
    '../../src/routes/importExport',
    '../../src/routes/users',
    '../../src/routes/resources',
    '../../src/routes/plans',
    '../../src/routes/activityLogs',
    '../../src/services/assessmentEngine',
  ];
  for (const p of modulePaths) {
    delete require.cache[require.resolve(p)];
  }

  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');

  const app = new Koa();
  app.use(errorHandler());
  app.use(bodyParser({ jsonLimit: '10mb' }));
  app.use(json());
  app.use(auditMiddleware());

  // Mount relevant routers
  for (const routeModule of [
    '../../src/routes/auth',
    '../../src/routes/content',
    '../../src/routes/assessments',
    '../../src/routes/campaigns',
    '../../src/routes/importExport',
    '../../src/routes/users',
    '../../src/routes/resources',
  ]) {
    const router = require(routeModule);
    app.use(router.routes());
    app.use(router.allowedMethods());
  }

  return app;
}

async function request(server, method, path, { body, headers = {} } = {}) {
  const port = server.address().port;
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`http://localhost:${port}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}

// ── Shared state ────────────────────────────────────────────────────────
let server;
let adminUser, participantUser, deletedUser;
let adminToken, participantToken, deletedUserToken;

// ── Setup & Teardown ────────────────────────────────────────────────────

before(async () => {
  // Run migrations
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();

  // Seed roles and permissions
  const [adminRole] = await db('roles').insert({ name: 'Administrator' }).returning('*');
  const [participantRole] = await db('roles').insert({ name: 'Participant' }).returning('*');

  // Seed key permissions
  const permNames = [
    'users.list', 'users.read', 'users.manage_roles', 'users.deactivate',
    'content.moderate', 'content.manage_categories', 'content.manage_topics',
    'campaigns.manage', 'campaigns.analytics',
    'assessments.manage_rules', 'assessments.compute_any',
    'data.export', 'data.import', 'data.backup', 'data.consistency_check',
    'resources.manage_acl', 'audit.view',
  ];
  const perms = [];
  for (const name of permNames) {
    const [p] = await db('permissions').insert({ name }).returning('*');
    perms.push(p);
  }
  // Grant all to admin
  for (const p of perms) {
    await db('role_permissions').insert({ role_id: adminRole.id, permission_id: p.id });
  }

  // Create users
  const hash = '$argon2id$v=19$m=65536,t=3,p=4$fakesalt$fakehash';
  [adminUser] = await db('users').insert({
    username: 'int_admin', email: 'int_admin@test.com', password_hash: hash, full_name: 'Integration Admin',
  }).returning('*');
  [participantUser] = await db('users').insert({
    username: 'int_participant', email: 'int_part@test.com', password_hash: hash, full_name: 'Integration Participant',
  }).returning('*');

  // Create a user we'll delete to test deleted-user token denial
  [deletedUser] = await db('users').insert({
    username: 'int_deleted', email: 'int_del@test.com', password_hash: hash, full_name: 'To Be Deleted',
  }).returning('*');

  // Assign roles
  await db('user_roles').insert({ user_id: adminUser.id, role_id: adminRole.id });
  await db('user_roles').insert({ user_id: participantUser.id, role_id: participantRole.id });
  await db('user_roles').insert({ user_id: deletedUser.id, role_id: participantRole.id });

  // Generate tokens BEFORE deleting the user (simulates token theft / delayed use)
  adminToken = makeToken({ ...adminUser, roles: ['Administrator'] });
  participantToken = makeToken({ ...participantUser, roles: ['Participant'] });
  deletedUserToken = makeToken({ ...deletedUser, roles: ['Participant'] });

  // Now hard-delete the "deleted" user (CASCADE cleans up user_roles)
  await db('users').where('id', deletedUser.id).del();

  // Start the test server
  const app = buildApp();
  server = http.createServer(app.callback());
  await new Promise((r) => server.listen(0, r));
});

after(async () => {
  if (server) server.close();
  await db.migrate.rollback(undefined, true);
  await db.destroy();
});

// ═══════════════════════════════════════════════════════════════════════
// 1. Deleted-user token denial
// ═══════════════════════════════════════════════════════════════════════

describe('Auth: deleted-user token rejection', () => {
  it('should return 401 when the user no longer exists in the database', async () => {
    const res = await request(server, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${deletedUserToken}` },
    });
    assert.equal(res.status, 401);
    assert.ok(res.body.error.message.includes('no longer exists'));
  });

  it('should return 403 when user is deactivated (not deleted)', async () => {
    // Deactivate the participant
    await db('users').where('id', participantUser.id).update({ is_active: false });
    const res = await request(server, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 403);
    assert.ok(res.body.error.message.includes('deactivated'));
    // Re-activate for subsequent tests
    await db('users').where('id', participantUser.id).update({ is_active: true });
  });

  it('should succeed for an active, existing user', async () => {
    const res = await request(server, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'int_admin');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Content ACL fail-closed enforcement
// ═══════════════════════════════════════════════════════════════════════

describe('Content ACL: fail-closed', () => {
  let contentItemId;

  before(async () => {
    // Create a content item owned by admin (no resource/ACL record)
    [{ id: contentItemId }] = await db('content_items').insert({
      author_id: adminUser.id,
      title: 'ACL Test Item',
      content_type: 'article',
      status: 'approved',
    }).returning('id');
  });

  it('should deny read access to non-author when no ACL record exists', async () => {
    const res = await request(server, 'GET', `/api/content/${contentItemId}`, {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 403);
    assert.ok(res.body.error.message.includes('no ACL record'));
  });

  it('should allow author to read their own content even without ACL record', async () => {
    const res = await request(server, 'GET', `/api/content/${contentItemId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'ACL Test Item');
  });

  it('should exclude non-author items without ACL from list endpoint', async () => {
    const res = await request(server, 'GET', '/api/content', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    const ids = res.body.data.map((i) => i.id);
    assert.ok(!ids.includes(contentItemId), 'Participant should not see admin-authored content without ACL');
  });

  it('should allow access when explicit ACL grant exists', async () => {
    // Create a resource record and ACL entry for participant
    const [resource] = await db('resources').insert({
      type: 'content_item',
      name: 'ACL Test Resource',
      owner_id: adminUser.id,
      metadata: JSON.stringify({ content_item_id: contentItemId }),
    }).returning('*');

    await db('acl_entries').insert({
      resource_id: resource.id,
      user_id: participantUser.id,
      action: 'read',
      effect: 'allow',
    });

    const res = await request(server, 'GET', `/api/content/${contentItemId}`, {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'ACL Test Item');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Audit record hash requirements
// ═══════════════════════════════════════════════════════════════════════

describe('Audit: immutable records with hashes', () => {
  it('should produce audit records with non-null hashes for content updates', async () => {
    // Create a content item
    const [item] = await db('content_items').insert({
      author_id: adminUser.id,
      title: 'Audit Hash Test',
      content_type: 'article',
      status: 'draft',
    }).returning('*');

    // Create resource/ACL for it so the update endpoint works
    const [resource] = await db('resources').insert({
      type: 'content_item',
      name: 'Audit Hash Resource',
      owner_id: adminUser.id,
      metadata: JSON.stringify({ content_item_id: item.id }),
    }).returning('*');
    await db('acl_entries').insert({
      resource_id: resource.id,
      user_id: adminUser.id,
      action: 'edit',
      effect: 'allow',
    });

    const res = await request(server, 'PUT', `/api/content/${item.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { title: 'Audit Hash Test Updated' },
    });
    assert.equal(res.status, 200);

    // Check audit log
    const auditLog = await db('audit_logs')
      .where({ action: 'content_item.update', resource_id: item.id })
      .first();
    assert.ok(auditLog, 'Audit record should exist');
    assert.ok(auditLog.before_hash, 'before_hash must not be null');
    assert.ok(auditLog.after_hash, 'after_hash must not be null');
    assert.notEqual(auditLog.before_hash, auditLog.after_hash, 'Hashes should differ after mutation');
    assert.equal(auditLog.before_hash.length, 64, 'Hash should be SHA-256 (64 hex chars)');
  });

  it('should reject audit records that lack hashes via writeAuditLog with requireHashes', async () => {
    // Directly call writeAuditLog to test the constraint
    const { writeAuditLog } = require('../../src/middleware/audit');
    await assert.rejects(
      () => writeAuditLog({
        actorId: adminUser.id,
        action: 'test.missing_hashes',
        resourceType: 'test',
        resourceId: adminUser.id,
        requireHashes: true,
        // intentionally omit beforeState and afterState
      }),
      (err) => {
        assert.ok(err.message.includes('before/after state hashes are required'));
        return true;
      }
    );
  });

  it('should prevent UPDATE on audit_logs via database trigger', async () => {
    const [log] = await db('audit_logs').insert({
      actor_id: adminUser.id,
      action: 'test.immutability',
      resource_type: 'test',
      before_hash: 'abc123',
      after_hash: 'def456',
    }).returning('*');

    await assert.rejects(
      () => db('audit_logs').where('id', log.id).update({ action: 'tampered' }),
      (err) => {
        assert.ok(err.message.includes('immutable'));
        return true;
      }
    );
  });

  it('should prevent DELETE on audit_logs via database trigger', async () => {
    const logs = await db('audit_logs').limit(1);
    if (logs.length > 0) {
      await assert.rejects(
        () => db('audit_logs').where('id', logs[0].id).del(),
        (err) => {
          assert.ok(err.message.includes('immutable'));
          return true;
        }
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Assessment rule validation
// ═══════════════════════════════════════════════════════════════════════

describe('Assessment rules: strict validation', () => {
  it('should reject weight <= 0', async () => {
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'test_validation',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 0, min_bound: 0, max_bound: 100 },
          { name: 'run', type: 'time_seconds', weight: 1.0, min_bound: 300, max_bound: 1800 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('greater than 0'));
  });

  it('should reject weight > 1', async () => {
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'test_validation',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 1.5, min_bound: 0, max_bound: 100 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must not exceed 1'));
  });

  it('should reject NaN weight', async () => {
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'test_validation',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 'not_a_number', min_bound: 0, max_bound: 100 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('finite number'));
  });

  it('should reject Infinity in min_bound (string form — JSON drops real Infinity)', async () => {
    // `JSON.stringify(Infinity)` is `null`, so we send "Infinity" as a
    // string. The route coerces via Number("Infinity") === Infinity and
    // isFinite rejects it.
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'test_validation',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 1.0, min_bound: 'Infinity', max_bound: 100 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('finite number'));
  });

  it('should reject min_bound >= max_bound', async () => {
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'test_validation',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 0.5, min_bound: 100, max_bound: 100 },
          { name: 'run', type: 'time_seconds', weight: 0.5, min_bound: 300, max_bound: 1800 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must be less than max_bound'));
  });

  it('should reject min_bound > max_bound', async () => {
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'test_validation',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 0.5, min_bound: 200, max_bound: 100 },
          { name: 'run', type: 'time_seconds', weight: 0.5, min_bound: 300, max_bound: 1800 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must be less than max_bound'));
  });

  it('should accept valid assessment rules', async () => {
    const res = await request(server, 'POST', '/api/assessments/rules', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        assessment_type: 'pft',
        scoring_items: [
          { name: 'pushups', type: 'rep_count', weight: 0.4, min_bound: 0, max_bound: 100, dimension: 'strength' },
          { name: '5k_run', type: 'time_seconds', weight: 0.6, min_bound: 900, max_bound: 2400, dimension: 'endurance' },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.version, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Campaign rollout transition checks
// ═══════════════════════════════════════════════════════════════════════

describe('Campaign rollout: progression enforcement', () => {
  let campaignId;

  before(async () => {
    const res = await request(server, 'POST', '/api/campaigns', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Rollout Test Campaign',
        description: 'Testing phase progression',
      },
    });
    assert.equal(res.status, 201);
    campaignId = res.body.id;
  });

  it('should reject advance-rollout on draft campaign', async () => {
    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must be active or scheduled'));
  });

  it('should allow advance after setting status to active', async () => {
    // Set status to active via direct DB update (PUT endpoint blocks current_rollout_percent)
    await db('campaigns').where('id', campaignId).update({ status: 'active' });

    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.advanced_to, 5, 'First phase must be 5%');
  });

  it('should advance to 25% on second call', async () => {
    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.advanced_to, 25);
  });

  it('should advance to 50% on third call', async () => {
    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.advanced_to, 50);
  });

  it('should advance to 100% on fourth call', async () => {
    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.advanced_to, 100);
  });

  it('should reject further advance at 100%', async () => {
    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('100%'));
  });

  it('should reject campaign creation with start_at >= end_at', async () => {
    const res = await request(server, 'POST', '/api/campaigns', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Bad Schedule',
        start_at: '2026-06-01T00:00:00Z',
        end_at: '2026-05-01T00:00:00Z',
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('start_at must be before end_at'));
  });

  it('should reject invalid rollout phases', async () => {
    const res = await request(server, 'POST', '/api/campaigns', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Bad Phases',
        rollout_phases: [{ percent: 10 }, { percent: 50 }, { percent: 100 }],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('Invalid rollout phase 10%'));
  });

  it('should reject rollout phases not ending at 100', async () => {
    const res = await request(server, 'POST', '/api/campaigns', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'No 100',
        rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('must end at 100%'));
  });

  it('should reject direct current_rollout_percent via PUT', async () => {
    const res = await request(server, 'PUT', `/api/campaigns/${campaignId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { current_rollout_percent: 75 },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.message.includes('advance-rollout'));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Import/restore conflict behavior
// ═══════════════════════════════════════════════════════════════════════

describe('Import/Restore: conflict handling', () => {
  it('should handle last_write_wins correctly for existing records', async () => {
    // Create a plan directly
    const [plan] = await db('plans').insert({
      title: 'Original Plan',
      description: 'Original',
      created_by: adminUser.id,
      status: 'draft',
      updated_at: new Date('2026-01-01'),
    }).returning('*');

    // Import with a newer timestamp — should overwrite
    const res = await request(server, 'POST', '/api/data/import', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        table: 'plans',
        data: [{
          id: plan.id,
          title: 'Updated Plan',
          description: 'Updated via import',
          created_by: adminUser.id,
          status: 'active',
          updated_at: new Date('2026-06-01').toISOString(),
        }],
        conflict_resolution: 'last_write_wins',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.processed, 1);

    // Verify the update
    const updated = await db('plans').where('id', plan.id).first();
    assert.equal(updated.title, 'Updated Plan');
  });

  it('should skip import when existing record is newer (last_write_wins)', async () => {
    const [plan] = await db('plans').insert({
      title: 'Newer Plan',
      description: 'Fresh',
      created_by: adminUser.id,
      status: 'active',
      updated_at: new Date('2026-12-01'),
    }).returning('*');

    const res = await request(server, 'POST', '/api/data/import', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        table: 'plans',
        data: [{
          id: plan.id,
          title: 'Stale Import',
          description: 'Old data',
          created_by: adminUser.id,
          updated_at: new Date('2026-01-01').toISOString(),
        }],
        conflict_resolution: 'last_write_wins',
      },
    });
    assert.equal(res.status, 201);

    // Should NOT have been updated
    const current = await db('plans').where('id', plan.id).first();
    assert.equal(current.title, 'Newer Plan');
  });

  it('should reject import of blocked fields (password_hash)', async () => {
    const res = await request(server, 'POST', '/api/data/import', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        table: 'users',
        data: [{
          id: adminUser.id,
          username: 'hacked',
          email: 'hack@evil.com',
          password_hash: 'injected_hash',
          updated_at: new Date('2099-01-01').toISOString(),
        }],
        conflict_resolution: 'last_write_wins',
      },
    });
    // The import should succeed but password_hash should be stripped
    // Verify password_hash was NOT changed
    const user = await db('users').where('id', adminUser.id).first();
    assert.notEqual(user.password_hash, 'injected_hash');
  });
});
