/**
 * DB-backed HTTP integration tests covering:
 *   - /api/assessments (rule versioning, validation, compute, scores)
 *   - /api/rankings (compute, leaderboard, certificates issuance + verify)
 *   - /api/messages (templates w/ versioning, send + subscriptions gating,
 *     broadcast, inbox + mark-read flows, /:id cross-user access boundary)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration } = require('../helpers/integrationHarness');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/activityLogs',
  '../../src/routes/assessments',
  '../../src/routes/rankings',
  '../../src/routes/messages',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'arm_int' });
});
after(async () => { if (harness) await harness.teardown(); });

// ── Assessments ─────────────────────────────────────────────────────────
describe('Assessments: rules', () => {
  it('creates rule v1; previous active versions deactivated on next insert', async () => {
    const create = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Administrator'),
      body: {
        assessment_type: 'pushup_strength',
        scoring_items: [
          { name: 'reps', type: 'rep_count', weight: 1.0, min_bound: 0, max_bound: 100 },
        ],
        description: 'v1',
      },
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.version, 1);
    assert.equal(create.body.is_active, true);

    const v2 = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Administrator'),
      body: {
        assessment_type: 'pushup_strength',
        scoring_items: [
          { name: 'reps', type: 'rep_count', weight: 1.0, min_bound: 0, max_bound: 120 },
        ],
        description: 'v2',
      },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version, 2);

    const oldRow = await harness.db('assessment_rules').where('id', create.body.id).first();
    assert.equal(oldRow.is_active, false, 'v1 deactivated after v2 creation');
  });

  it('rejects weights that do not sum to 1', async () => {
    const res = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Administrator'),
      body: {
        assessment_type: 'broken',
        scoring_items: [
          { name: 'a', type: 'rep_count', weight: 0.6, min_bound: 0, max_bound: 1 },
          { name: 'b', type: 'rep_count', weight: 0.2, min_bound: 0, max_bound: 1 },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(/weights must sum to 1/.test(res.body.error.message));
  });

  it('rejects min_bound >= max_bound', async () => {
    const res = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Administrator'),
      body: {
        assessment_type: 'broken-bounds',
        scoring_items: [{ name: 'a', type: 'rep_count', weight: 1.0, min_bound: 10, max_bound: 5 }],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(/min_bound.*must be less than max_bound/i.test(res.body.error.message));
  });

  it('rejects non-finite weight/min/max (NaN, Infinity)', async () => {
    const res = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Administrator'),
      body: {
        assessment_type: 'bad-floats',
        scoring_items: [{ name: 'a', type: 'rep_count', weight: 'NaN', min_bound: 0, max_bound: 1 }],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(/finite number/i.test(res.body.error.message));
  });

  it('Participant cannot create rules (403)', async () => {
    const res = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Participant'),
      body: { assessment_type: 'x', scoring_items: [] },
    });
    assert.equal(res.status, 403);
  });

  it('GET /rules filters by assessment_type', async () => {
    const res = await harness.req('GET', '/api/assessments/rules?assessment_type=pushup_strength', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    for (const r of res.body) assert.equal(r.assessment_type, 'pushup_strength');
  });

  it('GET /rules/active/:type returns only the active version, 404 on none', async () => {
    const res = await harness.req('GET', '/api/assessments/rules/active/pushup_strength', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.is_active, true);

    const nf = await harness.req('GET', '/api/assessments/rules/active/nonexistent', {
      headers: harness.auth('Participant'),
    });
    assert.equal(nf.status, 404);
  });
});

describe('Assessments: score history', () => {
  it('GET /scores/me returns empty page for participant with no scores', async () => {
    const res = await harness.req('GET', '/api/assessments/scores/me', { headers: harness.auth('Participant') });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.pagination.total, 0);
  });

  it('GET /scores/:id for unknown returns 404', async () => {
    const res = await harness.req('GET', '/api/assessments/scores/00000000-0000-0000-0000-000000000099', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 404);
  });

  it('GET /scores/:id enforces owner-or-privileged access', async () => {
    // seed a rule + score owned by Coach
    const [rule] = await harness.db('assessment_rules').insert({
      assessment_type: 'scope_test',
      version: 1,
      scoring_items: JSON.stringify([{ name: 'r', type: 'rep_count', weight: 1.0, min_bound: 0, max_bound: 1 }]),
    }).returning('*');
    const [score] = await harness.db('computed_scores').insert({
      user_id: harness.users['Coach'].id,
      assessment_rule_id: rule.id,
      total_score: 80,
      item_scores: JSON.stringify([]),
      source_log_ids: JSON.stringify([]),
      rule_version: 1,
    }).returning('*');

    const ownerRes = await harness.req('GET', `/api/assessments/scores/${score.id}`, { headers: harness.auth('Coach') });
    assert.equal(ownerRes.status, 200);
    assert.ok(ownerRes.body.rule);
    assert.equal(ownerRes.body.rule.assessment_type, 'scope_test');

    const partRes = await harness.req('GET', `/api/assessments/scores/${score.id}`, { headers: harness.auth('Participant') });
    assert.equal(partRes.status, 403);

    const adminRes = await harness.req('GET', `/api/assessments/scores/${score.id}`, { headers: harness.auth('Administrator') });
    assert.equal(adminRes.status, 200);
  });
});

// ── Rankings ────────────────────────────────────────────────────────────
describe('Rankings: compute + certificate issuance', () => {
  let ruleId;
  before(async () => {
    const res = await harness.req('POST', '/api/assessments/rules', {
      headers: harness.auth('Administrator'),
      body: {
        assessment_type: 'cert_test',
        scoring_items: [{ name: 'r', type: 'rep_count', weight: 1.0, min_bound: 0, max_bound: 100 }],
      },
    });
    ruleId = res.body.id;

    // seed several high scores for Participant so compute returns a gold level
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await harness.db('computed_scores').insert({
        user_id: harness.users['Participant'].id,
        assessment_rule_id: ruleId,
        total_score: 95,
        item_scores: JSON.stringify([]),
        source_log_ids: JSON.stringify([]),
        rule_version: 1,
        computed_at: new Date(now.getTime() - i * 24 * 3600 * 1000),
      });
    }
  });

  it('requires assessment_type', async () => {
    const res = await harness.req('POST', '/api/rankings/compute', {
      headers: harness.auth('Participant'),
      body: {},
    });
    assert.equal(res.status, 400);
    assert.ok(/assessment_type is required/i.test(res.body.error.message));
  });

  it('returns level=none when no scores in window', async () => {
    const res = await harness.req('POST', '/api/rankings/compute', {
      headers: harness.auth('Coach'),
      body: { assessment_type: 'no_scores' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.level, 'none');
    assert.equal(res.body.rolling_avg, 0);
  });

  it('computes gold level and issues a certificate; verification succeeds', async () => {
    const res = await harness.req('POST', '/api/rankings/compute', {
      headers: harness.auth('Participant'),
      body: { assessment_type: 'cert_test' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.ranking);
    assert.equal(res.body.ranking.level, 'gold');
    assert.equal(res.body.ranking.user_id, harness.users['Participant'].id);
    assert.ok(res.body.certificate, 'certificate should be issued on first gold achievement');
    assert.ok(res.body.certificate.verification_code);

    const verify = await harness.req('GET', `/api/rankings/certificates/verify/${res.body.certificate.verification_code}`);
    assert.equal(verify.status, 200);
    assert.equal(verify.body.valid, true);
    assert.equal(verify.body.certificate.level, 'gold');
    assert.equal(verify.body.certificate.user.username, 'arm_int_participant');

    // tampered code
    const bad = await harness.req('GET', `/api/rankings/certificates/verify/${res.body.certificate.verification_code}AA`);
    assert.equal(bad.body.valid, false);
  });

  it('second compute does not issue a duplicate certificate for the same level', async () => {
    const res = await harness.req('POST', '/api/rankings/compute', {
      headers: harness.auth('Participant'),
      body: { assessment_type: 'cert_test' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.certificate, null);
  });

  it('leaderboard returns participant at top with joined username', async () => {
    const res = await harness.req('GET', '/api/rankings/leaderboard?assessment_type=cert_test', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length >= 1);
    assert.equal(res.body.data[0].username, 'arm_int_participant');
    assert.ok(Number(res.body.data[0].rolling_avg_score) > 0);
  });

  it('GET /certificates/me returns participant\'s certificate', async () => {
    const res = await harness.req('GET', '/api/rankings/certificates/me', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 1);
    assert.equal(res.body[0].level, 'gold');
  });

  it('config endpoints require rankings.manage_config', async () => {
    const denied = await harness.req('GET', '/api/rankings/config', { headers: harness.auth('Participant') });
    assert.equal(denied.status, 403);

    const ok = await harness.req('POST', '/api/rankings/config', {
      headers: harness.auth('Administrator'),
      body: { assessment_type: 'cert_test', window_days: 7, thresholds: { bronze: 50, silver: 70, gold: 90 } },
    });
    assert.ok([200, 201].includes(ok.status));
    assert.equal(ok.body.window_days, 7);

    const get = await harness.req('GET', '/api/rankings/config', { headers: harness.auth('Administrator') });
    assert.ok(get.body.some((c) => c.assessment_type === 'cert_test' && c.window_days === 7));
  });
});

// ── Messages ────────────────────────────────────────────────────────────
describe('Messages: templates, send, inbox', () => {
  let templateName = 'welcome';

  it('Participant cannot list/create templates', async () => {
    const denied = await harness.req('GET', '/api/messages/templates', { headers: harness.auth('Participant') });
    assert.equal(denied.status, 403);
  });

  it('validates category enum on template create', async () => {
    const res = await harness.req('POST', '/api/messages/templates', {
      headers: harness.auth('Administrator'),
      body: { name: 'bad_cat', category: 'junk', subject_template: 'hi', body_template: 'hi' },
    });
    assert.equal(res.status, 400);
    assert.ok(/category must be one of/i.test(res.body.error.message));
  });

  it('validates required placeholders exist in template text', async () => {
    const res = await harness.req('POST', '/api/messages/templates', {
      headers: harness.auth('Administrator'),
      body: {
        name: 'missing_ph',
        category: 'enrollment',
        subject_template: 'Hi',
        body_template: 'Hello',
        required_placeholders: ['user_name'],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(/{{user_name}}.*not found/i.test(res.body.error.message));
  });

  it('creates template v1; creating same name yields v2 and deactivates v1', async () => {
    const v1 = await harness.req('POST', '/api/messages/templates', {
      headers: harness.auth('Administrator'),
      body: {
        name: templateName,
        category: 'enrollment',
        subject_template: 'Hi {{user_name}}',
        body_template: 'Welcome {{user_name}}',
        required_placeholders: ['user_name'],
      },
    });
    assert.equal(v1.status, 201);
    assert.equal(v1.body.version, 1);

    const v2 = await harness.req('POST', '/api/messages/templates', {
      headers: harness.auth('Administrator'),
      body: {
        name: templateName,
        category: 'enrollment',
        subject_template: 'Hey {{user_name}}',
        body_template: 'Welcome {{user_name}}, v2',
        required_placeholders: ['user_name'],
      },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version, 2);

    const v1Row = await harness.db('message_templates').where('id', v1.body.id).first();
    assert.equal(v1Row.is_active, false);
  });

  it('send with template renders placeholders; missing placeholder → 400', async () => {
    const missing = await harness.req('POST', '/api/messages/send', {
      headers: harness.auth('Administrator'),
      body: {
        recipient_id: harness.users['Participant'].id,
        template_name: templateName,
        data: {}, // user_name missing
      },
    });
    assert.equal(missing.status, 400);
    assert.ok(/Missing template placeholders/i.test(missing.body.error.message));

    const ok = await harness.req('POST', '/api/messages/send', {
      headers: harness.auth('Administrator'),
      body: {
        recipient_id: harness.users['Participant'].id,
        template_name: templateName,
        data: { user_name: 'Flo' },
      },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.recipient_id, harness.users['Participant'].id);
    assert.ok(ok.body.subject.includes('Flo'));
    assert.ok(ok.body.body.includes('Flo'));
  });

  it('send without template requires subject+body', async () => {
    const res = await harness.req('POST', '/api/messages/send', {
      headers: harness.auth('Administrator'),
      body: { recipient_id: harness.users['Participant'].id },
    });
    assert.equal(res.status, 400);
  });

  it('subscription opt-out blocks template-based send of that category', async () => {
    await harness.req('PUT', '/api/messages/subscriptions', {
      headers: harness.auth('Reviewer'),
      body: { category: 'enrollment', in_app_enabled: false },
    });
    const res = await harness.req('POST', '/api/messages/send', {
      headers: harness.auth('Administrator'),
      body: {
        recipient_id: harness.users['Reviewer'].id,
        template_name: templateName,
        data: { user_name: 'R' },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, false);
    assert.ok(/disabled/i.test(res.body.reason));
  });

  it('inbox returns user messages + unread_count; mark-all-read zeros unread', async () => {
    const inbox = await harness.req('GET', '/api/messages/inbox', { headers: harness.auth('Participant') });
    assert.equal(inbox.status, 200);
    assert.ok(Array.isArray(inbox.body.data));
    assert.ok(inbox.body.data.length >= 1);
    assert.ok(inbox.body.unread_count >= 1);

    const mark = await harness.req('POST', '/api/messages/mark-all-read', { headers: harness.auth('Participant') });
    assert.equal(mark.status, 200);
    assert.ok(mark.body.marked_read >= 1);

    const after = await harness.req('GET', '/api/messages/inbox', { headers: harness.auth('Participant') });
    assert.equal(after.body.unread_count, 0);
  });

  it('broadcast skips recipients with opt-outs and sends to remaining', async () => {
    const recipients = [harness.users['Participant'].id, harness.users['Reviewer'].id, harness.users['Coach'].id];
    const res = await harness.req('POST', '/api/messages/broadcast', {
      headers: harness.auth('Administrator'),
      body: {
        recipient_ids: recipients,
        template_name: templateName,
        data: { user_name: 'Crew' },
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.sent >= 2, 'participant + coach should receive');
    assert.ok(res.body.skipped >= 1, 'reviewer opted out earlier');
    assert.equal(res.body.sent + res.body.skipped, recipients.length);
  });

  it('GET /:id denies access to non-recipient non-sender', async () => {
    const [msg] = await harness.db('messages').insert({
      recipient_id: harness.users['Coach'].id,
      sender_id: harness.users['Administrator'].id,
      channel: 'in_app', subject: 'private', body: 'hi',
    }).returning('*');

    const denied = await harness.req('GET', `/api/messages/${msg.id}`, { headers: harness.auth('Participant') });
    assert.equal(denied.status, 403);

    const ok = await harness.req('GET', `/api/messages/${msg.id}`, { headers: harness.auth('Coach') });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.subject, 'private');
  });

  it('/:id/read marks the message read (and 403 for non-recipient)', async () => {
    const [msg] = await harness.db('messages').insert({
      recipient_id: harness.users['Administrator'].id,
      sender_id: harness.users['Coach'].id,
      channel: 'in_app', subject: 'to admin', body: 'hi',
    }).returning('*');

    const denied = await harness.req('POST', `/api/messages/${msg.id}/read`, { headers: harness.auth('Participant') });
    assert.equal(denied.status, 403);

    const ok = await harness.req('POST', `/api/messages/${msg.id}/read`, { headers: harness.auth('Administrator') });
    assert.equal(ok.status, 200);
    const row = await harness.db('messages').where('id', msg.id).first();
    assert.equal(row.is_read, true);
    assert.ok(row.read_at);
  });

  it('subscription update email/sms are forced false (offline-only)', async () => {
    const res = await harness.req('PUT', '/api/messages/subscriptions', {
      headers: harness.auth('Coach'),
      body: { category: 'schedule', in_app_enabled: true },
    });
    assert.ok([200, 201].includes(res.status));
    assert.equal(res.body.email_enabled, false);
    assert.equal(res.body.sms_enabled, false);
  });
});
