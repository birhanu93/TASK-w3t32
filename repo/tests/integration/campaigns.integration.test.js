/**
 * DB-backed HTTP integration tests for the campaigns surface.
 *
 * Contract-level coverage for: campaign CRUD, rollout-phase validation,
 * phased advance-rollout, A/B assignment (deterministic), placements,
 * coupons (validation + ranges), idempotent analytics event ingestion,
 * funnel + A/B analytics reads.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration } = require('../helpers/integrationHarness');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/campaigns',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'camp_int' });
});
after(async () => { if (harness) await harness.teardown(); });

describe('Campaigns: CRUD', () => {
  let campaignId;

  it('Admin creates a campaign with AB config; DB row has JSON variants stored', async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: {
        name: 'Camp One',
        description: 'First campaign',
        ab_test_id: 'camp-one-ab',
        ab_variants: [
          { name: 'control', weight: 0.5 },
          { name: 'treatment', weight: 0.5 },
        ],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Camp One');
    assert.equal(res.body.ab_test_id, 'camp-one-ab');
    assert.ok(res.body.id);
    campaignId = res.body.id;

    const dbRow = await harness.db('campaigns').where('id', campaignId).first();
    assert.ok(dbRow);
    assert.equal(dbRow.status, 'draft', 'campaigns should start in draft');
    assert.ok(Array.isArray(dbRow.ab_variants) ? dbRow.ab_variants.length === 2 : JSON.parse(dbRow.ab_variants).length === 2);

    const audit = await harness.db('audit_logs')
      .where({ action: 'campaign.create', resource_id: campaignId }).first();
    assert.ok(audit, 'campaign.create audit row should exist');
    assert.ok(audit.after_hash, 'campaign.create audit must have after_hash');
  });

  it('rejects create without name with 400', async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { description: 'no name' },
    });
    assert.equal(res.status, 400);
    assert.ok(/name is required/i.test(res.body.error.message));
  });

  it('rejects create when start_at >= end_at', async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Bad window', start_at: '2026-05-01', end_at: '2026-04-01' },
    });
    assert.equal(res.status, 400);
    assert.ok(/start_at must be before end_at/i.test(res.body.error.message));
  });

  it('rejects rollout_phases with invalid percents', async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Bad phases', rollout_phases: [{ percent: 10 }, { percent: 100 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(/Invalid rollout phase/i.test(res.body.error.message));
  });

  it('rejects rollout_phases that are not strictly ascending', async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Bad asc', rollout_phases: [{ percent: 50 }, { percent: 25 }, { percent: 100 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(/ascending/i.test(res.body.error.message));
  });

  it('rejects rollout_phases that do not end at 100', async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Bad end', rollout_phases: [{ percent: 5 }, { percent: 25 }] },
    });
    assert.equal(res.status, 400);
    assert.ok(/end at 100/i.test(res.body.error.message));
  });

  it('Participant cannot list/read campaigns (403)', async () => {
    const listRes = await harness.req('GET', '/api/campaigns', {
      headers: harness.auth('Participant'),
    });
    assert.equal(listRes.status, 403);

    const detailRes = await harness.req('GET', `/api/campaigns/${campaignId}`, {
      headers: harness.auth('Participant'),
    });
    assert.equal(detailRes.status, 403);
  });

  it('GET /:id returns campaign + nested placements + coupons arrays', async () => {
    const res = await harness.req('GET', `/api/campaigns/${campaignId}`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, campaignId);
    assert.ok(Array.isArray(res.body.placements));
    assert.ok(Array.isArray(res.body.coupons));
  });

  it('GET /:id for unknown returns 404', async () => {
    const res = await harness.req('GET', '/api/campaigns/00000000-0000-0000-0000-000000000099', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 404);
  });

  it('PUT /:id blocks direct current_rollout_percent updates', async () => {
    const res = await harness.req('PUT', `/api/campaigns/${campaignId}`, {
      headers: harness.auth('Administrator'),
      body: { current_rollout_percent: 50 },
    });
    assert.equal(res.status, 400);
    assert.ok(/advance-rollout/i.test(res.body.error.message));
  });

  it('PUT /:id updates writable fields, records audit before/after hashes', async () => {
    const res = await harness.req('PUT', `/api/campaigns/${campaignId}`, {
      headers: harness.auth('Administrator'),
      body: { description: 'Updated description' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.description, 'Updated description');

    const dbRow = await harness.db('campaigns').where('id', campaignId).first();
    assert.equal(dbRow.description, 'Updated description');

    const audit = await harness.db('audit_logs')
      .where({ action: 'campaign.update', resource_id: campaignId })
      .orderBy('created_at', 'desc').first();
    assert.ok(audit);
    assert.ok(audit.before_hash && audit.after_hash, 'campaign.update must have both hashes');
  });
});

describe('Campaigns: phased rollout', () => {
  let campaignId;

  before(async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: {
        name: 'Phased',
        rollout_phases: [{ percent: 5 }, { percent: 25 }, { percent: 50 }, { percent: 100 }],
      },
    });
    campaignId = res.body.id;
    // activate so advance-rollout is permitted
    await harness.db('campaigns').where('id', campaignId).update({ status: 'active' });
  });

  it('cannot advance a campaign whose status is neither active nor scheduled', async () => {
    const [draft] = await harness.db('campaigns').insert({ name: 'Draft', status: 'draft' }).returning('*');
    const res = await harness.req('POST', `/api/campaigns/${draft.id}/advance-rollout`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 400);
    assert.ok(/cannot advance rollout/i.test(res.body.error.message));
  });

  it('advances rollout one step at a time and records audit with from/to details', async () => {
    const first = await harness.req('POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.advanced_to, 5);
    assert.equal(first.body.campaign.current_rollout_percent, 5);

    const second = await harness.req('POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.advanced_to, 25);

    const audit = await harness.db('audit_logs')
      .where({ action: 'campaign.advance_rollout', resource_id: campaignId })
      .orderBy('created_at', 'desc').first();
    assert.ok(audit, 'audit row exists');
    const details = typeof audit.details === 'string' ? JSON.parse(audit.details) : audit.details;
    assert.equal(details.from, 5);
    assert.equal(details.to, 25);
  });

  it('once at 100%, further advance calls are rejected', async () => {
    await harness.db('campaigns').where('id', campaignId).update({ current_rollout_percent: 100 });
    const res = await harness.req('POST', `/api/campaigns/${campaignId}/advance-rollout`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 400);
    assert.ok(/100%/.test(res.body.error.message));
  });
});

describe('Campaigns: A/B assignment', () => {
  let campaignId;

  before(async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: {
        name: 'AB Test',
        ab_test_id: 'determ-test',
        ab_variants: [
          { name: 'A', weight: 0.5 },
          { name: 'B', weight: 0.5 },
        ],
      },
    });
    campaignId = res.body.id;
    await harness.db('campaigns').where('id', campaignId).update({ status: 'active', current_rollout_percent: 100 });
  });

  it('assignment is deterministic for the same user', async () => {
    const a = await harness.req('GET', `/api/campaigns/${campaignId}/ab-assignment`, {
      headers: harness.auth('Participant'),
    });
    const b = await harness.req('GET', `/api/campaigns/${campaignId}/ab-assignment`, {
      headers: harness.auth('Participant'),
    });
    assert.equal(a.status, 200);
    assert.equal(a.body.test_id, 'determ-test');
    assert.ok(['A', 'B'].includes(a.body.variant));
    assert.equal(a.body.variant, b.body.variant, 'deterministic assignment per user');
  });

  it('rejects assignment when campaign has no ab_test_id', async () => {
    const [camp] = await harness.db('campaigns').insert({ name: 'NoAB', status: 'active' }).returning('*');
    const res = await harness.req('GET', `/api/campaigns/${camp.id}/ab-assignment`, {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 400);
    assert.ok(/no A\/B test/i.test(res.body.error.message));
  });

  it('returns variant=null with reason when user is outside rollout band', async () => {
    await harness.db('campaigns').where('id', campaignId).update({ current_rollout_percent: 0 });
    const res = await harness.req('GET', `/api/campaigns/${campaignId}/ab-assignment`, {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.variant, null);
    assert.ok(/rollout group/i.test(res.body.reason));

    // restore
    await harness.db('campaigns').where('id', campaignId).update({ current_rollout_percent: 100 });
  });
});

describe('Campaigns: placements', () => {
  let campaignId;
  before(async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Placements host' },
    });
    campaignId = res.body.id;
    await harness.db('campaigns').where('id', campaignId).update({ status: 'active' });
  });

  it('requires slot field', async () => {
    const res = await harness.req('POST', `/api/campaigns/${campaignId}/placements`, {
      headers: harness.auth('Administrator'),
      body: { content: {} },
    });
    assert.equal(res.status, 400);
    assert.ok(/slot is required/i.test(res.body.error.message));
  });

  it('persists placement and returns it in campaign detail', async () => {
    const res = await harness.req('POST', `/api/campaigns/${campaignId}/placements`, {
      headers: harness.auth('Administrator'),
      body: { slot: 'homepage_banner', content: { headline: 'Hi' }, priority: 7 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.slot, 'homepage_banner');
    assert.equal(res.body.priority, 7);
    assert.equal(res.body.campaign_id, campaignId);

    const detail = await harness.req('GET', `/api/campaigns/${campaignId}`, {
      headers: harness.auth('Administrator'),
    });
    assert.ok(detail.body.placements.some((p) => p.slot === 'homepage_banner'));
  });

  it('GET /placements/active returns only active-campaign placements for the slot', async () => {
    const res = await harness.req('GET', '/api/campaigns/placements/active?slot=homepage_banner', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    for (const p of res.body) {
      assert.equal(p.slot, 'homepage_banner');
    }
  });

  it('GET /placements/active requires slot query param', async () => {
    const res = await harness.req('GET', '/api/campaigns/placements/active', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 400);
    assert.ok(/slot/i.test(res.body.error.message));
  });
});

describe('Campaigns: coupons', () => {
  let campaignId;
  before(async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Coupon host' },
    });
    campaignId = res.body.id;
  });

  it('rejects coupon outside fixed discount range', async () => {
    const res = await harness.req('POST', '/api/campaigns/coupons', {
      headers: harness.auth('Administrator'),
      body: { campaign_id: campaignId, code: 'TOOMUCH', discount_type: 'fixed', discount_value: 200 },
    });
    assert.equal(res.status, 400);
    assert.ok(/Fixed discount/i.test(res.body.error.message));
  });

  it('rejects coupon outside percent discount range', async () => {
    const res = await harness.req('POST', '/api/campaigns/coupons', {
      headers: harness.auth('Administrator'),
      body: { campaign_id: campaignId, code: 'TOOBIG', discount_type: 'percent', discount_value: 95 },
    });
    assert.equal(res.status, 400);
    assert.ok(/Percent discount/i.test(res.body.error.message));
  });

  it('creates a coupon; code uppercased; audit row written', async () => {
    const res = await harness.req('POST', '/api/campaigns/coupons', {
      headers: harness.auth('Administrator'),
      body: { campaign_id: campaignId, code: 'save10', discount_type: 'percent', discount_value: 10, min_spend: 50 },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.code, 'SAVE10', 'code uppercased');

    const audit = await harness.db('audit_logs').where({ action: 'coupon.create', resource_id: res.body.id }).first();
    assert.ok(audit);
    assert.ok(audit.after_hash);
  });

  it('validate: valid coupon returns discount for supplied spend', async () => {
    const res = await harness.req('POST', '/api/campaigns/coupons/validate', {
      headers: harness.auth('Participant'),
      body: { code: 'save10', spend_amount: 200 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.discount, 20); // 10% of 200
  });

  it('validate: insufficient spend → valid=false with explicit reason', async () => {
    const res = await harness.req('POST', '/api/campaigns/coupons/validate', {
      headers: harness.auth('Participant'),
      body: { code: 'save10', spend_amount: 10 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
    assert.ok(/Minimum spend/i.test(res.body.reason));
  });

  it('validate: unknown code → valid=false', async () => {
    const res = await harness.req('POST', '/api/campaigns/coupons/validate', {
      headers: harness.auth('Participant'),
      body: { code: 'doesnotexist' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, false);
  });
});

describe('Campaigns: analytics events (idempotent)', () => {
  let campaignId;
  before(async () => {
    const res = await harness.req('POST', '/api/campaigns', {
      headers: harness.auth('Administrator'),
      body: { name: 'Events host', ab_test_id: 'evt-ab', ab_variants: [{ name: 'a', weight: 1 }] },
    });
    campaignId = res.body.id;
  });

  it('rejects event without idempotency_key', async () => {
    const res = await harness.req('POST', '/api/campaigns/events', {
      headers: harness.auth('Participant'),
      body: { event_type: 'view' },
    });
    assert.equal(res.status, 400);
    assert.ok(/idempotency_key/i.test(res.body.error.message));
  });

  it('ingests a new event (201) and returns duplicate on replay', async () => {
    const body = {
      idempotency_key: 'evt-key-1',
      event_type: 'conversion',
      event_name: 'purchase',
      campaign_id: campaignId,
      ab_variant: 'a',
      funnel_name: 'checkout',
      funnel_step: 1,
      properties: { amount: 42 },
    };
    const first = await harness.req('POST', '/api/campaigns/events', {
      headers: harness.auth('Participant'),
      body,
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.idempotency_key, 'evt-key-1');
    assert.equal(first.body.campaign_id, campaignId);

    const second = await harness.req('POST', '/api/campaigns/events', {
      headers: harness.auth('Participant'),
      body,
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'duplicate');
    assert.equal(second.body.event.idempotency_key, 'evt-key-1');

    const rows = await harness.db('analytics_events').where('idempotency_key', 'evt-key-1');
    assert.equal(rows.length, 1, 'only one row despite replay');
  });

  it('analytics/funnel requires funnel_name', async () => {
    const res = await harness.req('GET', '/api/campaigns/analytics/funnel', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 400);
    assert.ok(/funnel_name/i.test(res.body.error.message));
  });

  it('analytics/funnel returns per-step counts with a conversion_rate on first step of 1', async () => {
    const res = await harness.req('GET', '/api/campaigns/analytics/funnel?funnel_name=checkout', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.funnel_name, 'checkout');
    assert.ok(Array.isArray(res.body.steps));
    if (res.body.steps.length > 0) {
      assert.equal(res.body.steps[0].conversion_rate, 1);
      assert.equal(res.body.steps[0].drop_off, 0);
      assert.equal(typeof res.body.steps[0].count, 'number');
      assert.equal(typeof res.body.steps[0].unique_users, 'number');
    }
  });

  it('analytics/ab-test returns variants keyed object', async () => {
    const res = await harness.req('GET', '/api/campaigns/analytics/ab-test/evt-ab', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.test_id, 'evt-ab');
    assert.equal(typeof res.body.variants, 'object');
    assert.ok(res.body.variants.a, 'variant a should have at least one event');
    assert.ok(typeof res.body.variants.a.conversion === 'object');
  });

  it('analytics endpoints require campaigns.analytics permission (Participant=403)', async () => {
    const res = await harness.req('GET', '/api/campaigns/analytics/funnel?funnel_name=checkout', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 403);
  });
});
