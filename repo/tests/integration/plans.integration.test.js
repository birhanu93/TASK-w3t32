/**
 * DB-backed HTTP integration tests for /api/plans and /api/activity-logs.
 *
 * Contract-level coverage: plan CRUD + role gating, task CRUD, enrollment
 * uniqueness, activity-log submission with outlier detection, per-user log
 * visibility, Coach/Admin privileged cross-user reads, outlier approval
 * gate, and 404/403 negative paths.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration } = require('../helpers/integrationHarness');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/plans',
  '../../src/routes/activityLogs',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'plan_int' });
});
after(async () => { if (harness) await harness.teardown(); });

describe('Plans: CRUD + RBAC', () => {
  let planId;

  it('Participant cannot create a plan (403)', async () => {
    const res = await harness.req('POST', '/api/plans', {
      headers: harness.auth('Participant'),
      body: { title: 'Forbidden' },
    });
    assert.equal(res.status, 403);
  });

  it('Coach creates plan; DB row persisted; audit row written', async () => {
    const res = await harness.req('POST', '/api/plans', {
      headers: harness.auth('Coach'),
      body: { title: 'Strength Plan', description: 'Push/Pull/Legs' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Strength Plan');
    assert.equal(res.body.created_by, harness.users['Coach'].id);
    planId = res.body.id;

    const dbRow = await harness.db('plans').where('id', planId).first();
    assert.equal(dbRow.description, 'Push/Pull/Legs');
    assert.equal(dbRow.status, 'draft');

    const audit = await harness.db('audit_logs').where({ action: 'plan.create', resource_id: planId }).first();
    assert.ok(audit);
    assert.ok(audit.after_hash);
  });

  it('create rejects missing title', async () => {
    const res = await harness.req('POST', '/api/plans', {
      headers: harness.auth('Coach'),
      body: { description: 'no title' },
    });
    assert.equal(res.status, 400);
    assert.ok(/title is required/i.test(res.body.error.message));
  });

  it('list returns pagination; filtering by status works', async () => {
    const all = await harness.req('GET', '/api/plans', { headers: harness.auth('Participant') });
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.body.data));
    assert.ok(all.body.data.length >= 1);

    const filtered = await harness.req('GET', '/api/plans?status=draft', { headers: harness.auth('Participant') });
    assert.equal(filtered.status, 200);
    for (const p of filtered.body.data) assert.equal(p.status, 'draft');
  });

  it('GET /:id returns tasks + enrollments arrays; Participant sees empty own-enrollment list', async () => {
    const res = await harness.req('GET', `/api/plans/${planId}`, { headers: harness.auth('Participant') });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, planId);
    assert.ok(Array.isArray(res.body.tasks));
    assert.ok(Array.isArray(res.body.enrollments));
  });

  it('Coach sees joined enrollment detail (username/full_name) but Participant does not', async () => {
    // Activate the plan so we can enroll
    await harness.req('PUT', `/api/plans/${planId}`, {
      headers: harness.auth('Coach'),
      body: { status: 'active' },
    });
    await harness.req('POST', `/api/plans/${planId}/enroll`, { headers: harness.auth('Participant') });

    const priv = await harness.req('GET', `/api/plans/${planId}`, { headers: harness.auth('Coach') });
    const partRow = priv.body.enrollments.find((e) => e.user_id === harness.users['Participant'].id);
    assert.ok(partRow);
    assert.equal(partRow.username, 'plan_int_participant');

    const plain = await harness.req('GET', `/api/plans/${planId}`, { headers: harness.auth('Reviewer') });
    for (const e of plain.body.enrollments) {
      assert.ok(!('username' in e), 'non-privileged must not see joined user fields');
    }
  });

  it('enrolling twice → 409', async () => {
    const res = await harness.req('POST', `/api/plans/${planId}/enroll`, { headers: harness.auth('Participant') });
    assert.equal(res.status, 409);
  });

  it('enroll on non-active plan → 400', async () => {
    const [draft] = await harness.db('plans').insert({
      title: 'Draft Only', created_by: harness.users['Coach'].id,
    }).returning('*');
    const res = await harness.req('POST', `/api/plans/${draft.id}/enroll`, { headers: harness.auth('Participant') });
    assert.equal(res.status, 400);
    assert.ok(/not active/i.test(res.body.error.message));
  });

  it('GET /:id returns 404 for unknown plan id', async () => {
    const res = await harness.req('GET', '/api/plans/00000000-0000-0000-0000-000000000099', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE requires plans.delete — Coach is blocked (403), Admin succeeds', async () => {
    const [todel] = await harness.db('plans').insert({
      title: 'To delete', created_by: harness.users['Coach'].id,
    }).returning('*');
    const coach = await harness.req('DELETE', `/api/plans/${todel.id}`, { headers: harness.auth('Coach') });
    assert.equal(coach.status, 403);

    const admin = await harness.req('DELETE', `/api/plans/${todel.id}`, { headers: harness.auth('Administrator') });
    assert.equal(admin.status, 204);
    const row = await harness.db('plans').where('id', todel.id).first();
    assert.ok(!row);
  });
});

describe('Plans: tasks', () => {
  let planId, taskId;

  before(async () => {
    const res = await harness.req('POST', '/api/plans', {
      headers: harness.auth('Coach'),
      body: { title: 'Task Host' },
    });
    planId = res.body.id;
  });

  it('Coach can create task; persisted with correct plan_id', async () => {
    const res = await harness.req('POST', `/api/plans/${planId}/tasks`, {
      headers: harness.auth('Coach'),
      body: { title: 'Push Ups', type: 'exercise', sort_order: 0 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.title, 'Push Ups');
    assert.equal(res.body.plan_id, planId);
    taskId = res.body.id;
  });

  it('list tasks returns ordered by sort_order', async () => {
    await harness.req('POST', `/api/plans/${planId}/tasks`, {
      headers: harness.auth('Coach'),
      body: { title: 'Squats', sort_order: 5 },
    });
    await harness.req('POST', `/api/plans/${planId}/tasks`, {
      headers: harness.auth('Coach'),
      body: { title: 'Pull Ups', sort_order: 2 },
    });
    const res = await harness.req('GET', `/api/plans/${planId}/tasks`, { headers: harness.auth('Participant') });
    assert.equal(res.status, 200);
    const orders = res.body.map((t) => t.sort_order);
    const sorted = [...orders].sort((a, b) => a - b);
    assert.deepEqual(orders, sorted, 'tasks should come back sorted by sort_order');
  });

  it('update task changes fields; unknown task returns 404', async () => {
    const ok = await harness.req('PUT', `/api/plans/${planId}/tasks/${taskId}`, {
      headers: harness.auth('Coach'),
      body: { title: 'Advanced Push Ups', sort_order: 3 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.title, 'Advanced Push Ups');
    assert.equal(ok.body.sort_order, 3);

    const notfound = await harness.req('PUT', `/api/plans/${planId}/tasks/00000000-0000-0000-0000-000000000099`, {
      headers: harness.auth('Coach'),
      body: { title: 'ghost' },
    });
    assert.equal(notfound.status, 404);
  });

  it('delete task removes row; audit row written', async () => {
    const res = await harness.req('DELETE', `/api/plans/${planId}/tasks/${taskId}`, {
      headers: harness.auth('Coach'),
    });
    assert.equal(res.status, 204);
    const row = await harness.db('tasks').where('id', taskId).first();
    assert.ok(!row);

    const audit = await harness.db('audit_logs').where({ action: 'task.delete', resource_id: taskId }).first();
    assert.ok(audit);
    assert.ok(audit.before_hash);
  });

  it('Reviewer cannot create task (lacks plans.update)', async () => {
    const res = await harness.req('POST', `/api/plans/${planId}/tasks`, {
      headers: harness.auth('Reviewer'),
      body: { title: 'Forbidden' },
    });
    assert.equal(res.status, 403);
  });
});

describe('Activity logs: submit + outlier detection + view scope', () => {
  it('requires activity_type, value, performed_at', async () => {
    const res = await harness.req('POST', '/api/activity-logs', {
      headers: harness.auth('Participant'),
      body: { activity_type: 'run' },
    });
    assert.equal(res.status, 400);
    assert.ok(/activity_type, value, and performed_at are required/.test(res.body.error.message));
  });

  it('submits a log for self; DB row has user_id = caller', async () => {
    const res = await harness.req('POST', '/api/activity-logs', {
      headers: harness.auth('Participant'),
      body: { activity_type: 'run', value: 12, unit: 'minutes', performed_at: new Date().toISOString() },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user_id, harness.users['Participant'].id);
    assert.equal(res.body.activity_type, 'run');
    assert.ok(res.body.outlier_detection);

    const row = await harness.db('activity_logs').where('id', res.body.id).first();
    assert.equal(row.user_id, harness.users['Participant'].id);
    assert.equal(row.activity_type, 'run');
  });

  it('GET /me returns only the caller\'s logs with pagination', async () => {
    const res = await harness.req('GET', '/api/activity-logs/me', { headers: harness.auth('Participant') });
    assert.equal(res.status, 200);
    for (const l of res.body.data) {
      assert.equal(l.user_id, harness.users['Participant'].id);
    }
    assert.ok(res.body.pagination);
  });

  it('GET /user/:userId requires activity_logs.view_all — Participant 403, Coach 200', async () => {
    const coachRes = await harness.req('GET', `/api/activity-logs/user/${harness.users['Participant'].id}`, {
      headers: harness.auth('Coach'),
    });
    assert.equal(coachRes.status, 200);
    assert.ok(Array.isArray(coachRes.body.data));

    const partRes = await harness.req('GET', `/api/activity-logs/user/${harness.users['Coach'].id}`, {
      headers: harness.auth('Participant'),
    });
    assert.equal(partRes.status, 403);
  });

  it('outlier approval gate: approving a non-outlier log returns 400', async () => {
    const insert = await harness.req('POST', '/api/activity-logs', {
      headers: harness.auth('Participant'),
      body: { activity_type: 'run', value: 13, performed_at: new Date().toISOString() },
    });
    const res = await harness.req('POST', `/api/activity-logs/${insert.body.id}/approve-outlier`, {
      headers: harness.auth('Coach'),
    });
    assert.equal(res.status, 400);
    assert.ok(/not flagged as outlier/i.test(res.body.error.message));
  });

  it('outlier approval: Coach approves a manually-flagged outlier, DB flips outlier_approved=true', async () => {
    // Insert then manually flag a log as outlier
    const [log] = await harness.db('activity_logs').insert({
      user_id: harness.users['Participant'].id,
      activity_type: 'run',
      value: 9999,
      performed_at: new Date(),
      is_outlier: true,
    }).returning('*');

    const res = await harness.req('POST', `/api/activity-logs/${log.id}/approve-outlier`, {
      headers: harness.auth('Coach'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.outlier_approved, true);
    assert.equal(res.body.outlier_approved_by, harness.users['Coach'].id);

    const row = await harness.db('activity_logs').where('id', log.id).first();
    assert.equal(row.outlier_approved, true);

    const audit = await harness.db('audit_logs').where({ action: 'activity_log.approve_outlier', resource_id: log.id }).first();
    assert.ok(audit);
    assert.ok(audit.before_hash && audit.after_hash);
  });

  it('batch submit returns inserted count + logs array', async () => {
    const res = await harness.req('POST', '/api/activity-logs/batch', {
      headers: harness.auth('Participant'),
      body: {
        logs: [
          { activity_type: 'run', value: 10, performed_at: new Date().toISOString() },
          { activity_type: 'run', value: 11, performed_at: new Date().toISOString() },
          { activity_type: 'run', value: 12, performed_at: new Date().toISOString() },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.inserted, 3);
    assert.equal(res.body.logs.length, 3);
    assert.equal(typeof res.body.outliers_flagged, 'number');
  });

  it('batch submit requires non-empty logs', async () => {
    const res = await harness.req('POST', '/api/activity-logs/batch', {
      headers: harness.auth('Participant'),
      body: { logs: [] },
    });
    assert.equal(res.status, 400);
    assert.ok(/logs array/i.test(res.body.error.message));
  });

  it('GET /:id cross-user read is forbidden for non-privileged', async () => {
    // Create a log owned by Coach
    const [log] = await harness.db('activity_logs').insert({
      user_id: harness.users['Coach'].id,
      activity_type: 'run',
      value: 20,
      performed_at: new Date(),
    }).returning('*');

    const res = await harness.req('GET', `/api/activity-logs/${log.id}`, {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 403);
  });
});
