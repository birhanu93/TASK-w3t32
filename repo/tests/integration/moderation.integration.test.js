/**
 * DB-backed HTTP integration tests for content moderation: /api/moderation.
 *
 * Covers: report-content flow, case review (approved/rejected) with content
 * status change, appeal window + author-only appeal rights, appeal review +
 * cascading content status change, pagination, permission boundaries,
 * and audit rows for all privileged decisions.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration } = require('../helpers/integrationHarness');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/content',
  '../../src/routes/moderation',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'mod_int' });
});
after(async () => { if (harness) await harness.teardown(); });

async function createContent(authorRole, overrides = {}) {
  const [item] = await harness.db('content_items').insert({
    author_id: harness.users[authorRole].id,
    title: overrides.title || `Item by ${authorRole}`,
    content_type: 'article',
    body: overrides.body || 'Some content',
    status: 'approved',
  }).returning('*');
  return item;
}

describe('Moderation: report', () => {
  let content;
  before(async () => {
    content = await createContent('Participant');
  });

  it('any authenticated user can report a content item; DB row recorded', async () => {
    const res = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Coach'),
      body: { content_item_id: content.id, violation_category: 'spam', description: 'Unsolicited' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.content_item_id, content.id);
    assert.equal(res.body.reported_by, harness.users['Coach'].id);
    assert.equal(res.body.violation_category, 'spam');

    const dbRow = await harness.db('moderation_cases').where('id', res.body.id).first();
    assert.ok(dbRow);
    assert.equal(dbRow.description, 'Unsolicited');
  });

  it('requires content_item_id', async () => {
    const res = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Coach'),
      body: { description: 'No id' },
    });
    assert.equal(res.status, 400);
    assert.ok(/content_item_id/i.test(res.body.error.message));
  });

  it('returns 404 when content_item_id does not exist', async () => {
    const res = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Coach'),
      body: { content_item_id: '00000000-0000-0000-0000-000000000099' },
    });
    assert.equal(res.status, 404);
  });
});

describe('Moderation: cases list + detail (permission-gated)', () => {
  let content, caseId;
  before(async () => {
    content = await createContent('Participant', { title: 'Case host' });
    const res = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Administrator'),
      body: { content_item_id: content.id },
    });
    caseId = res.body.id;
  });

  it('Reviewer can list cases with pagination and joined content_title', async () => {
    const res = await harness.req('GET', '/api/moderation/cases', { headers: harness.auth('Reviewer') });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);
    const row = res.body.data.find((c) => c.id === caseId);
    assert.ok(row);
    assert.ok('content_title' in row, 'join output should expose content_title');
    assert.ok(res.body.pagination.total >= 1);
  });

  it('Participant cannot list cases (403)', async () => {
    const res = await harness.req('GET', '/api/moderation/cases', { headers: harness.auth('Participant') });
    assert.equal(res.status, 403);
  });

  it('Reviewer can fetch case detail including content + appeals', async () => {
    const res = await harness.req('GET', `/api/moderation/cases/${caseId}`, { headers: harness.auth('Reviewer') });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, caseId);
    assert.ok(res.body.content);
    assert.equal(res.body.content.id, content.id);
    assert.ok(Array.isArray(res.body.appeals));
  });

  it('returns 404 for missing case', async () => {
    const res = await harness.req('GET', '/api/moderation/cases/00000000-0000-0000-0000-000000000099', {
      headers: harness.auth('Reviewer'),
    });
    assert.equal(res.status, 404);
  });
});

describe('Moderation: case review — decision propagates to content_items', () => {
  let content, caseId;
  before(async () => {
    content = await createContent('Participant', { title: 'For rejection' });
    const res = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Participant'),
      body: { content_item_id: content.id, description: 'inappropriate' },
    });
    caseId = res.body.id;
  });

  it('rejects invalid decision values', async () => {
    const res = await harness.req('POST', `/api/moderation/cases/${caseId}/review`, {
      headers: harness.auth('Reviewer'),
      body: { decision: 'banned' },
    });
    assert.equal(res.status, 400);
    assert.ok(/decision must be/i.test(res.body.error.message));
  });

  it('reject → content becomes rejected; case status updated; audit with before/after hashes', async () => {
    const res = await harness.req('POST', `/api/moderation/cases/${caseId}/review`, {
      headers: harness.auth('Reviewer'),
      body: { decision: 'resolved_rejected', comments: 'violates policy' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'resolved_rejected');
    assert.equal(res.body.reviewer_id, harness.users['Reviewer'].id);
    assert.equal(res.body.reviewer_comments, 'violates policy');
    assert.ok(res.body.decided_at);

    const caseRow = await harness.db('moderation_cases').where('id', caseId).first();
    assert.equal(caseRow.status, 'resolved_rejected');
    const contentRow = await harness.db('content_items').where('id', content.id).first();
    assert.equal(contentRow.status, 'rejected');

    const audit = await harness.db('audit_logs')
      .where({ action: 'moderation.review', resource_id: caseId }).first();
    assert.ok(audit);
    assert.ok(audit.before_hash && audit.after_hash);
  });
});

describe('Moderation: appeals', () => {
  let content, caseId;
  before(async () => {
    content = await createContent('Participant', { title: 'Appealable' });
    const reportRes = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Participant'),
      body: { content_item_id: content.id },
    });
    caseId = reportRes.body.id;
    // Reject it so appeal is eligible
    await harness.req('POST', `/api/moderation/cases/${caseId}/review`, {
      headers: harness.auth('Reviewer'),
      body: { decision: 'resolved_rejected' },
    });
  });

  it('rejects appeal without reason', async () => {
    const res = await harness.req('POST', `/api/moderation/cases/${caseId}/appeal`, {
      headers: harness.auth('Participant'),
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(/reason is required/i.test(res.body.error.message));
  });

  it('non-author non-admin cannot appeal (403)', async () => {
    const res = await harness.req('POST', `/api/moderation/cases/${caseId}/appeal`, {
      headers: harness.auth('Coach'),
      body: { reason: 'I want to' },
    });
    assert.equal(res.status, 403);
  });

  it('author appeal creates row, sets deadline, flips case to appealed', async () => {
    const res = await harness.req('POST', `/api/moderation/cases/${caseId}/appeal`, {
      headers: harness.auth('Participant'),
      body: { reason: 'This was fair use' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.moderation_case_id, caseId);
    assert.equal(res.body.appellant_id, harness.users['Participant'].id);
    assert.equal(res.body.reason, 'This was fair use');
    assert.ok(res.body.deadline, 'deadline must be set');

    const caseRow = await harness.db('moderation_cases').where('id', caseId).first();
    assert.equal(caseRow.status, 'appealed');

    // Second attempt on the same case is rejected — but at the 'status'
    // gate, not the duplicate gate, because the first appeal flipped the
    // case to status=appealed (no longer resolved_rejected).
    const second = await harness.req('POST', `/api/moderation/cases/${caseId}/appeal`, {
      headers: harness.auth('Participant'),
      body: { reason: 'Trying again' },
    });
    assert.equal(second.status, 400);
    assert.match(second.body.error.message, /rejected decisions/i);
  });

  it('cannot appeal a case that has not been rejected', async () => {
    const fresh = await createContent('Participant', { title: 'Not rejected' });
    const report = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Participant'),
      body: { content_item_id: fresh.id },
    });
    const res = await harness.req('POST', `/api/moderation/cases/${report.body.id}/appeal`, {
      headers: harness.auth('Participant'),
      body: { reason: 'why' },
    });
    assert.equal(res.status, 400);
    assert.ok(/rejected decisions/i.test(res.body.error.message));
  });

  it('appeal after deadline is rejected', async () => {
    const lateContent = await createContent('Participant', { title: 'Too late' });
    const reportRes = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Participant'),
      body: { content_item_id: lateContent.id },
    });
    const lateCaseId = reportRes.body.id;
    await harness.req('POST', `/api/moderation/cases/${lateCaseId}/review`, {
      headers: harness.auth('Reviewer'),
      body: { decision: 'resolved_rejected' },
    });
    // force decided_at to a long time ago (> 14 days)
    const old = new Date('2020-01-01T00:00:00Z');
    await harness.db('moderation_cases').where('id', lateCaseId).update({ decided_at: old });

    const res = await harness.req('POST', `/api/moderation/cases/${lateCaseId}/appeal`, {
      headers: harness.auth('Participant'),
      body: { reason: 'way too late' },
    });
    assert.equal(res.status, 400);
    assert.ok(/Appeal window has expired/i.test(res.body.error.message));
  });

  it('Reviewer approving the appeal restores content to approved', async () => {
    const appeal = await harness.db('appeals')
      .where({ moderation_case_id: caseId }).first();
    assert.ok(appeal);

    const res = await harness.req('POST', `/api/moderation/appeals/${appeal.id}/review`, {
      headers: harness.auth('Reviewer'),
      body: { decision: 'approved', comments: 'On reconsideration, fine.' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'approved');
    assert.equal(res.body.reviewer_id, harness.users['Reviewer'].id);

    const caseRow = await harness.db('moderation_cases').where('id', caseId).first();
    assert.equal(caseRow.status, 'appeal_approved');
    const contentRow = await harness.db('content_items').where('id', content.id).first();
    assert.equal(contentRow.status, 'approved');

    const audit = await harness.db('audit_logs').where({ action: 'appeal.review', resource_id: appeal.id }).first();
    assert.ok(audit);
    assert.ok(audit.before_hash && audit.after_hash);
  });

  it('appeal review rejects invalid decision values', async () => {
    const fresh = await createContent('Participant', { title: 'For decision validation' });
    const report = await harness.req('POST', '/api/moderation/report', {
      headers: harness.auth('Participant'), body: { content_item_id: fresh.id },
    });
    await harness.req('POST', `/api/moderation/cases/${report.body.id}/review`, {
      headers: harness.auth('Reviewer'), body: { decision: 'resolved_rejected' },
    });
    const appeal = await harness.req('POST', `/api/moderation/cases/${report.body.id}/appeal`, {
      headers: harness.auth('Participant'), body: { reason: 'let me appeal' },
    });
    const res = await harness.req('POST', `/api/moderation/appeals/${appeal.body.id}/review`, {
      headers: harness.auth('Reviewer'),
      body: { decision: 'maybe' },
    });
    assert.equal(res.status, 400);
    assert.ok(/approved or rejected/i.test(res.body.error.message));
  });
});
