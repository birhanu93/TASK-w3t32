/**
 * DB-backed integration HTTP tests for core application flows.
 *
 * Exercises auth, plans/tasks, campaigns, messages, data ops, and resources
 * against a real PostgreSQL database with no mocks.
 *
 * Requires a live PostgreSQL instance. Set TEST_DATABASE_URL or
 * DB_NAME=training_assessment_test to target a throwaway database.
 *
 * Run:
 *   NODE_ENV=test node --test tests/integration/flows.integration.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
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
  const Koa = require('koa');
  const bodyParser = require('koa-bodyparser');
  const json = require('koa-json');

  const connPath = require.resolve('../../src/db/connection');
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };

  const modulePaths = [
    '../../src/middleware/auth',
    '../../src/middleware/rbac',
    '../../src/middleware/audit',
    '../../src/middleware/errorHandler',
    '../../src/routes/auth',
    '../../src/routes/plans',
    '../../src/routes/campaigns',
    '../../src/routes/messages',
    '../../src/routes/importExport',
    '../../src/routes/resources',
    '../../src/routes/moderation',
    '../../src/routes/content',
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

  for (const routeModule of [
    '../../src/routes/auth',
    '../../src/routes/plans',
    '../../src/routes/campaigns',
    '../../src/routes/messages',
    '../../src/routes/importExport',
    '../../src/routes/resources',
    '../../src/routes/moderation',
    '../../src/routes/content',
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
let adminUser, opsUser, coachUser, reviewerUser, participantUser;
let adminToken, opsToken, coachToken, reviewerToken, participantToken;
let adminRoleId, opsRoleId, coachRoleId, reviewerRoleId, participantRoleId;

// ── Setup & Teardown ────────────────────────────────────────────────────

before(async () => {
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();

  // Seed all 5 roles
  const [adminRole] = await db('roles').insert({ name: 'Administrator' }).returning('*');
  const [opsRole] = await db('roles').insert({ name: 'Operations Manager' }).returning('*');
  const [coachRole] = await db('roles').insert({ name: 'Coach' }).returning('*');
  const [reviewerRole] = await db('roles').insert({ name: 'Reviewer' }).returning('*');
  const [participantRole] = await db('roles').insert({ name: 'Participant' }).returning('*');
  adminRoleId = adminRole.id;
  opsRoleId = opsRole.id;
  coachRoleId = coachRole.id;
  reviewerRoleId = reviewerRole.id;
  participantRoleId = participantRole.id;

  // Seed all permissions
  const permNames = [
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
  ];
  const perms = [];
  for (const name of permNames) {
    const [p] = await db('permissions').insert({ name }).returning('*');
    perms.push(p);
  }

  // Admin gets all permissions
  for (const p of perms) {
    await db('role_permissions').insert({ role_id: adminRole.id, permission_id: p.id });
  }

  // Ops Manager permissions
  const opsPermNames = ['users.list', 'users.read', 'plans.create', 'plans.update',
    'activity_logs.view_all', 'assessments.manage_rules', 'rankings.manage_config',
    'content.manage_topics', 'campaigns.manage', 'campaigns.analytics',
    'messages.send', 'messages.manage_templates', 'messages.broadcast',
    'data.export', 'data.consistency_check'];
  for (const p of perms.filter(p => opsPermNames.includes(p.name))) {
    await db('role_permissions').insert({ role_id: opsRole.id, permission_id: p.id });
  }

  // Coach permissions
  const coachPermNames = ['plans.create', 'plans.update', 'activity_logs.view_all',
    'activity_logs.approve_outlier', 'assessments.compute_any', 'messages.send'];
  for (const p of perms.filter(p => coachPermNames.includes(p.name))) {
    await db('role_permissions').insert({ role_id: coachRole.id, permission_id: p.id });
  }

  // Reviewer permissions
  const reviewerPermNames = ['content.moderate', 'content.manage_categories'];
  for (const p of perms.filter(p => reviewerPermNames.includes(p.name))) {
    await db('role_permissions').insert({ role_id: reviewerRole.id, permission_id: p.id });
  }

  // Create users
  const hash = '$argon2id$v=19$m=65536,t=3,p=4$fakesalt$fakehash';
  [adminUser] = await db('users').insert({ username: 'flow_admin', email: 'flow_admin@test.com', password_hash: hash, full_name: 'Flow Admin' }).returning('*');
  [opsUser] = await db('users').insert({ username: 'flow_ops', email: 'flow_ops@test.com', password_hash: hash, full_name: 'Flow Ops' }).returning('*');
  [coachUser] = await db('users').insert({ username: 'flow_coach', email: 'flow_coach@test.com', password_hash: hash, full_name: 'Flow Coach' }).returning('*');
  [reviewerUser] = await db('users').insert({ username: 'flow_reviewer', email: 'flow_reviewer@test.com', password_hash: hash, full_name: 'Flow Reviewer' }).returning('*');
  [participantUser] = await db('users').insert({ username: 'flow_participant', email: 'flow_part@test.com', password_hash: hash, full_name: 'Flow Participant' }).returning('*');

  // Assign roles
  await db('user_roles').insert({ user_id: adminUser.id, role_id: adminRoleId });
  await db('user_roles').insert({ user_id: opsUser.id, role_id: opsRoleId });
  await db('user_roles').insert({ user_id: coachUser.id, role_id: coachRoleId });
  await db('user_roles').insert({ user_id: reviewerUser.id, role_id: reviewerRoleId });
  await db('user_roles').insert({ user_id: participantUser.id, role_id: participantRoleId });

  // Generate tokens
  adminToken = makeToken({ ...adminUser, roles: ['Administrator'] });
  opsToken = makeToken({ ...opsUser, roles: ['Operations Manager'] });
  coachToken = makeToken({ ...coachUser, roles: ['Coach'] });
  reviewerToken = makeToken({ ...reviewerUser, roles: ['Reviewer'] });
  participantToken = makeToken({ ...participantUser, roles: ['Participant'] });

  // Start server
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
// 1. Auth flow: profile retrieval for all roles
// ═══════════════════════════════════════════════════════════════════════

describe('Auth flow: profile retrieval', () => {
  it('should return admin profile with correct fields', async () => {
    const res = await request(server, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'flow_admin');
    assert.equal(res.body.email, 'flow_admin@test.com');
    assert.ok(!res.body.password_hash, 'Should not expose password_hash');
  });

  it('should return participant profile', async () => {
    const res = await request(server, 'GET', '/api/auth/me', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'flow_participant');
  });

  it('should reject requests without token', async () => {
    const res = await request(server, 'GET', '/api/auth/me');
    assert.equal(res.status, 401);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Plans + Tasks CRUD flow
// ═══════════════════════════════════════════════════════════════════════

describe('Plans and Tasks flow', () => {
  let planId, taskId;

  it('should allow Coach to create a plan', async () => {
    const res = await request(server, 'POST', '/api/plans', {
      headers: { Authorization: `Bearer ${coachToken}` },
      body: { title: 'Integration Test Plan', description: 'Plan for testing' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Integration Test Plan');
    assert.equal(res.body.description, 'Plan for testing');
    assert.ok(res.body.id, 'Should return plan ID');
    planId = res.body.id;
  });

  it('should deny Participant from creating a plan', async () => {
    const res = await request(server, 'POST', '/api/plans', {
      headers: { Authorization: `Bearer ${participantToken}` },
      body: { title: 'Unauthorized Plan' },
    });
    assert.equal(res.status, 403);
  });

  it('should list plans with pagination', async () => {
    const res = await request(server, 'GET', '/api/plans', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data), 'data should be an array');
    assert.ok(res.body.data.length >= 1, 'Should have at least 1 plan');
    assert.ok(res.body.pagination.total >= 1);
    assert.equal(res.body.pagination.page, 1);
  });

  it('should get plan by ID with tasks and enrollments', async () => {
    const res = await request(server, 'GET', `/api/plans/${planId}`, {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, planId);
    assert.equal(res.body.title, 'Integration Test Plan');
    assert.ok(Array.isArray(res.body.tasks), 'Should include tasks array');
    assert.ok(Array.isArray(res.body.enrollments), 'Should include enrollments array');
  });

  it('should create tasks within a plan', async () => {
    const res = await request(server, 'POST', `/api/plans/${planId}/tasks`, {
      headers: { Authorization: `Bearer ${coachToken}` },
      body: { title: 'Push-ups', type: 'exercise', sort_order: 0 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Push-ups');
    assert.equal(res.body.type, 'exercise');
    assert.equal(res.body.plan_id, planId);
    taskId = res.body.id;
  });

  it('should list tasks for a plan', async () => {
    const res = await request(server, 'GET', `/api/plans/${planId}/tasks`, {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'Response should be an array');
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].title, 'Push-ups');
  });

  it('should update a task', async () => {
    const res = await request(server, 'PUT', `/api/plans/${planId}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${coachToken}` },
      body: { title: 'Modified Push-ups', sort_order: 1 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'Modified Push-ups');
    assert.equal(res.body.sort_order, 1);
  });

  it('should return 404 for non-existent plan', async () => {
    const res = await request(server, 'GET', '/api/plans/00000000-0000-0000-0000-000000000099', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Campaign + Placements + A/B Assignment flow
// ═══════════════════════════════════════════════════════════════════════

describe('Campaign flow with placements and A/B tests', () => {
  let campaignId;

  it('should create a campaign with A/B test config', async () => {
    const res = await request(server, 'POST', '/api/campaigns', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'Flow Test Campaign',
        description: 'Integration test campaign',
        ab_test_id: 'flow-test-ab',
        ab_variants: [
          { name: 'control', weight: 0.5 },
          { name: 'variant_a', weight: 0.5 },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Flow Test Campaign');
    assert.ok(res.body.id);
    campaignId = res.body.id;
  });

  it('should list campaigns with pagination', async () => {
    const res = await request(server, 'GET', '/api/campaigns', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);
    assert.ok(res.body.pagination);
    assert.equal(res.body.pagination.page, 1);
  });

  it('should get campaign by ID with placements and coupons', async () => {
    const res = await request(server, 'GET', `/api/campaigns/${campaignId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, campaignId);
    assert.equal(res.body.name, 'Flow Test Campaign');
    assert.ok(Array.isArray(res.body.placements), 'Should include placements');
    assert.ok(Array.isArray(res.body.coupons), 'Should include coupons');
  });

  it('should create placement for campaign', async () => {
    const res = await request(server, 'POST', `/api/campaigns/${campaignId}/placements`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { slot: 'homepage_banner', content: { text: 'Special offer!' }, priority: 10 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.slot, 'homepage_banner');
    assert.equal(res.body.priority, 10);
    assert.equal(res.body.campaign_id, campaignId);
  });

  it('should get A/B variant assignment', async () => {
    // Activate campaign and set rollout to 100%
    await db('campaigns').where('id', campaignId).update({
      status: 'active',
      current_rollout_percent: 100,
    });

    const res = await request(server, 'GET', `/api/campaigns/${campaignId}/ab-assignment`, {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.test_id, 'flow-test-ab');
    assert.ok(['control', 'variant_a'].includes(res.body.variant),
      `Variant should be control or variant_a, got: ${res.body.variant}`);
  });

  it('should return 404 for non-existent campaign', async () => {
    const res = await request(server, 'GET', '/api/campaigns/00000000-0000-0000-0000-000000000099', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 404);
  });

  it('should deny Participant from listing campaigns', async () => {
    const res = await request(server, 'GET', '/api/campaigns', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Messages: templates, send, mark-all-read, subscriptions
// ═══════════════════════════════════════════════════════════════════════

describe('Messages flow', () => {
  it('should create a message template', async () => {
    const res = await request(server, 'POST', '/api/messages/templates', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        name: 'flow_test_template',
        category: 'enrollment',
        subject_template: 'Welcome {{user_name}}',
        body_template: 'Hi {{user_name}}, you enrolled in {{plan_name}}!',
        required_placeholders: ['user_name', 'plan_name'],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'flow_test_template');
    assert.equal(res.body.version, 1);
    assert.equal(res.body.category, 'enrollment');
  });

  it('should list templates for Admin', async () => {
    const res = await request(server, 'GET', '/api/messages/templates', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    assert.ok(res.body.some(t => t.name === 'flow_test_template'));
  });

  it('should send a direct message', async () => {
    const res = await request(server, 'POST', '/api/messages/send', {
      headers: { Authorization: `Bearer ${coachToken}` },
      body: {
        recipient_id: participantUser.id,
        subject: 'Training Update',
        body: 'Your training plan has been updated.',
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.recipient_id, participantUser.id);
    assert.equal(res.body.subject, 'Training Update');
  });

  it('should retrieve inbox with unread count', async () => {
    const res = await request(server, 'GET', '/api/messages/inbox', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1, 'Should have at least 1 message');
    assert.equal(typeof res.body.unread_count, 'number');
    assert.ok(res.body.unread_count >= 1, 'Should have unread messages');
    assert.ok(res.body.pagination);
  });

  it('should mark all messages as read', async () => {
    const res = await request(server, 'POST', '/api/messages/mark-all-read', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.marked_read >= 1, 'Should have marked at least 1 as read');

    // Verify unread count is now 0
    const inbox = await request(server, 'GET', '/api/messages/inbox', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(inbox.body.unread_count, 0);
  });

  it('should get subscription preferences (initially empty)', async () => {
    const res = await request(server, 'GET', '/api/messages/subscriptions/me', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });

  it('should update subscription preferences', async () => {
    const res = await request(server, 'PUT', '/api/messages/subscriptions', {
      headers: { Authorization: `Bearer ${participantToken}` },
      body: { category: 'enrollment', in_app_enabled: false },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, 'enrollment');
    assert.equal(res.body.in_app_enabled, false);

    // Verify it's persisted
    const subs = await request(server, 'GET', '/api/messages/subscriptions/me', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(subs.body.length, 1);
    assert.equal(subs.body[0].category, 'enrollment');
    assert.equal(subs.body[0].in_app_enabled, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Data operations: consistency check + backup
// ═══════════════════════════════════════════════════════════════════════

describe('Data operations flow', () => {
  it('should run consistency check and return report', async () => {
    const res = await request(server, 'POST', '/api/data/consistency-check', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.checked_at, 'Should include checked_at timestamp');
    assert.ok(Array.isArray(res.body.orphan_records), 'Should include orphan_records');
    assert.ok(Array.isArray(res.body.foreign_key_issues), 'Should include foreign_key_issues');
    assert.equal(typeof res.body.total_issues, 'number');
  });

  it('should deny Participant from running consistency check', async () => {
    const res = await request(server, 'POST', '/api/data/consistency-check', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 403);
  });

  it('should create a full backup', async () => {
    const res = await request(server, 'POST', '/api/data/backup', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.job, 'Should include job record');
    assert.equal(res.body.job.type, 'backup');
    assert.equal(res.body.job.status, 'completed');
    assert.ok(res.body.backup, 'Should include backup data');
    assert.ok(res.body.backup.users, 'Backup should include users table');
    assert.ok(res.body.backup.plans, 'Backup should include plans table');
    // Verify sensitive fields are redacted
    if (res.body.backup.users.length > 0) {
      assert.ok(!res.body.backup.users[0].password_hash,
        'password_hash should be redacted from backup');
    }
  });

  it('should deny Participant from creating backup', async () => {
    const res = await request(server, 'POST', '/api/data/backup', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Resources + ACL flow
// ═══════════════════════════════════════════════════════════════════════

describe('Resources and ACL flow', () => {
  let parentResourceId, childResourceId, aclEntryId;

  it('should create a parent resource', async () => {
    const res = await request(server, 'POST', '/api/resources', {
      headers: { Authorization: `Bearer ${participantToken}` },
      body: { type: 'folder', name: 'My Documents' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.type, 'folder');
    assert.equal(res.body.name, 'My Documents');
    assert.equal(res.body.owner_id, participantUser.id);
    parentResourceId = res.body.id;
  });

  it('should create a child resource', async () => {
    const res = await request(server, 'POST', '/api/resources', {
      headers: { Authorization: `Bearer ${participantToken}` },
      body: { type: 'file', name: 'report.pdf', parent_id: parentResourceId },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.parent_id, parentResourceId);
    childResourceId = res.body.id;
  });

  it('should get resource by ID with ACL entries (admin)', async () => {
    const res = await request(server, 'GET', `/api/resources/${parentResourceId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, parentResourceId);
    assert.equal(res.body.name, 'My Documents');
    assert.ok(Array.isArray(res.body.acl), 'Should include acl array');
  });

  it('should create ACL entry for resource', async () => {
    const res = await request(server, 'POST', `/api/resources/${parentResourceId}/acl`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { user_id: coachUser.id, action: 'read', effect: 'allow' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.resource_id, parentResourceId);
    assert.equal(res.body.user_id, coachUser.id);
    assert.equal(res.body.action, 'read');
    assert.equal(res.body.effect, 'allow');
    aclEntryId = res.body.id;
  });

  it('should propagate ACL from parent to children', async () => {
    const res = await request(server, 'POST', `/api/resources/${parentResourceId}/acl/propagate`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.includes('1 children'), 'Should propagate to 1 child');
    assert.ok(res.body.entries_created >= 1, 'Should have created entries');

    // Verify child has inherited ACL
    const childAcls = await db('acl_entries')
      .where({ resource_id: childResourceId, inherited: true });
    assert.ok(childAcls.length >= 1, 'Child should have inherited ACL entries');
  });

  it('should delete ACL entry', async () => {
    const res = await request(server, 'DELETE', `/api/resources/${parentResourceId}/acl/${aclEntryId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 204);

    // Verify it's gone
    const entry = await db('acl_entries').where('id', aclEntryId).first();
    assert.ok(!entry, 'ACL entry should be deleted');
  });

  it('should delete resource', async () => {
    const res = await request(server, 'DELETE', `/api/resources/${childResourceId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 204);

    const resource = await db('resources').where('id', childResourceId).first();
    assert.ok(!resource, 'Resource should be deleted');
  });

  it('should deny non-admin from managing ACL', async () => {
    const res = await request(server, 'POST', `/api/resources/${parentResourceId}/acl`, {
      headers: { Authorization: `Bearer ${participantToken}` },
      body: { user_id: coachUser.id, action: 'read' },
    });
    assert.equal(res.status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Content + Moderation flow
// ═══════════════════════════════════════════════════════════════════════

describe('Content and Moderation flow', () => {
  let contentItemId, moderationCaseId;

  it('should create content item', async () => {
    const res = await request(server, 'POST', '/api/content', {
      headers: { Authorization: `Bearer ${participantToken}` },
      body: { title: 'My Training Log', content_type: 'article', body: 'Great workout today.' },
    });
    assert.equal(res.status, 201);
    // POST /api/content returns { item, screening }
    assert.ok(res.body.item, 'response should include item');
    assert.equal(res.body.item.title, 'My Training Log');
    assert.equal(res.body.item.author_id, participantUser.id);
    assert.ok(res.body.screening, 'response should include screening result');
    contentItemId = res.body.item.id;
  });

  it('should report content for moderation', async () => {
    const res = await request(server, 'POST', '/api/moderation/report', {
      headers: { Authorization: `Bearer ${adminToken}` },
      body: { content_item_id: contentItemId, description: 'Inappropriate' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.content_item_id, contentItemId);
    moderationCaseId = res.body.id;
  });

  it('should list moderation cases for Reviewer', async () => {
    const res = await request(server, 'GET', '/api/moderation/cases', {
      headers: { Authorization: `Bearer ${reviewerToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);
    assert.ok(res.body.pagination);
  });

  it('should get moderation case detail with content and appeals', async () => {
    const res = await request(server, 'GET', `/api/moderation/cases/${moderationCaseId}`, {
      headers: { Authorization: `Bearer ${reviewerToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, moderationCaseId);
    assert.ok(res.body.content, 'Should include content item');
    assert.equal(res.body.content.id, contentItemId);
    assert.ok(Array.isArray(res.body.appeals), 'Should include appeals array');
  });

  it('should deny Participant from viewing moderation cases', async () => {
    const res = await request(server, 'GET', '/api/moderation/cases', {
      headers: { Authorization: `Bearer ${participantToken}` },
    });
    assert.equal(res.status, 403);
  });
});
