const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');
const { deterministicHash } = require('../utils/crypto');

const router = new Router({ prefix: '/api/campaigns' });

// ── Rollout-phase validation ────────────────────────────────────────────
const VALID_ROLLOUT_PHASES = [5, 25, 50, 100];

function validateRolloutPhases(rollout_phases) {
  if (!Array.isArray(rollout_phases) || rollout_phases.length === 0) {
    throw Errors.badRequest('rollout_phases must be a non-empty array');
  }
  const percents = rollout_phases.map((p) => p.percent);
  for (const pct of percents) {
    if (!VALID_ROLLOUT_PHASES.includes(pct)) {
      throw Errors.badRequest(`Invalid rollout phase ${pct}%. Valid phases: ${VALID_ROLLOUT_PHASES.join(', ')}`);
    }
  }
  for (let i = 1; i < percents.length; i++) {
    if (percents[i] <= percents[i - 1]) {
      throw Errors.badRequest('Rollout phases must be in strictly ascending order');
    }
  }
  if (percents[percents.length - 1] !== 100) {
    throw Errors.badRequest('Rollout phases must end at 100%');
  }
}

// ── Campaign CRUD ───────────────────────────────────────────────────────

router.get('/', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const { status, page = 1, per_page = 20 } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('campaigns');
  if (status) query = query.where('status', status);

  const [{ count }] = await query.clone().count();
  const campaigns = await query.orderBy('created_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: campaigns,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

router.get('/:id', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const campaign = await db('campaigns').where('id', ctx.params.id).first();
  if (!campaign) throw Errors.notFound('Campaign not found');

  const placements = await db('placements').where('campaign_id', campaign.id);
  const coupons = await db('coupons').where('campaign_id', campaign.id);

  ctx.body = { ...campaign, placements, coupons };
});

router.post('/', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const { name, description, start_at, end_at, rollout_phases, ab_test_id, ab_variants, config: campaignConfig } = ctx.request.body;
  if (!name) throw Errors.badRequest('name is required');

  // Validate scheduling constraints
  if (start_at && end_at && new Date(start_at) >= new Date(end_at)) {
    throw Errors.badRequest('start_at must be before end_at');
  }

  // Validate rollout phases if provided — must follow the 5→25→50→100 progression
  if (rollout_phases) {
    validateRolloutPhases(rollout_phases);
  }

  const [campaign] = await db('campaigns')
    .insert({
      name,
      description,
      start_at,
      end_at,
      rollout_phases: rollout_phases ? JSON.stringify(rollout_phases) : undefined,
      ab_test_id,
      ab_variants: ab_variants ? JSON.stringify(ab_variants) : '[]',
      config: campaignConfig ? JSON.stringify(campaignConfig) : '{}',
    })
    .returning('*');

  await ctx.audit({
    action: 'campaign.create',
    resourceType: 'campaign',
    resourceId: campaign.id,
    afterState: campaign,
  });

  ctx.status = 201;
  ctx.body = campaign;
});

router.put('/:id', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const before = await db('campaigns').where('id', ctx.params.id).first();
  if (!before) throw Errors.notFound('Campaign not found');

  const { name, description, status, start_at, end_at, rollout_phases, current_rollout_percent, ab_test_id, ab_variants } = ctx.request.body;

  // Validate scheduling constraints
  const effectiveStart = start_at !== undefined ? start_at : before.start_at;
  const effectiveEnd = end_at !== undefined ? end_at : before.end_at;
  if (effectiveStart && effectiveEnd && new Date(effectiveStart) >= new Date(effectiveEnd)) {
    throw Errors.badRequest('start_at must be before end_at');
  }

  // Prevent direct manipulation of current_rollout_percent (must use advance-rollout)
  if (current_rollout_percent !== undefined) {
    throw Errors.badRequest('Cannot set current_rollout_percent directly; use POST /:id/advance-rollout');
  }

  // Validate rollout phases on update with the same strict rules as creation
  if (rollout_phases !== undefined) {
    validateRolloutPhases(rollout_phases);
  }

  const updates = { updated_at: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (start_at !== undefined) updates.start_at = start_at;
  if (end_at !== undefined) updates.end_at = end_at;
  if (rollout_phases !== undefined) updates.rollout_phases = JSON.stringify(rollout_phases);
  if (ab_test_id !== undefined) updates.ab_test_id = ab_test_id;
  if (ab_variants !== undefined) updates.ab_variants = JSON.stringify(ab_variants);

  const [campaign] = await db('campaigns').where('id', ctx.params.id).update(updates).returning('*');

  await ctx.audit({
    action: 'campaign.update',
    resourceType: 'campaign',
    resourceId: campaign.id,
    beforeState: before,
    afterState: campaign,
  });

  ctx.body = campaign;
});

// ── Phased Rollout ──────────────────────────────────────────────────────
router.post('/:id/advance-rollout', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const campaign = await db('campaigns').where('id', ctx.params.id).first();
  if (!campaign) throw Errors.notFound('Campaign not found');

  // Campaign must be active or scheduled to advance rollout
  if (!['active', 'scheduled'].includes(campaign.status)) {
    throw Errors.badRequest(`Cannot advance rollout: campaign status is "${campaign.status}" (must be active or scheduled)`);
  }

  const phases = campaign.rollout_phases || VALID_ROLLOUT_PHASES.map((p) => ({ percent: p }));
  const currentPercent = campaign.current_rollout_percent || 0;

  // Find the next phase — must be the immediate next step (no skipping)
  const nextPhase = phases.find((p) => p.percent > currentPercent);

  if (!nextPhase) {
    throw Errors.badRequest('Already at 100% rollout');
  }

  // Validate the progression follows the ramp: the next phase must be the immediate successor
  const currentIdx = phases.findIndex((p) => p.percent === currentPercent);
  const expectedNext = phases[currentIdx + 1] || phases[0]; // first phase if starting from 0
  if (currentPercent === 0) {
    // Starting rollout — must begin at the first defined phase
    if (nextPhase.percent !== phases[0].percent) {
      throw Errors.badRequest(`Rollout must start at ${phases[0].percent}%`);
    }
  } else if (nextPhase.percent !== expectedNext.percent) {
    throw Errors.badRequest(
      `Cannot skip rollout phases: current ${currentPercent}% → next must be ${expectedNext.percent}%`
    );
  }

  // Validate scheduling: if campaign has end_at, it must not have already ended
  if (campaign.end_at && new Date(campaign.end_at) < new Date()) {
    throw Errors.badRequest('Cannot advance rollout: campaign has already ended');
  }

  const [updated] = await db('campaigns')
    .where('id', ctx.params.id)
    .update({ current_rollout_percent: nextPhase.percent, updated_at: new Date() })
    .returning('*');

  await ctx.audit({
    action: 'campaign.advance_rollout',
    resourceType: 'campaign',
    resourceId: ctx.params.id,
    beforeState: campaign,
    afterState: updated,
    details: { from: currentPercent, to: nextPhase.percent },
  });

  ctx.body = { campaign: updated, advanced_to: nextPhase.percent };
});

// ── A/B Test Assignment ─────────────────────────────────────────────────
router.get('/:id/ab-assignment', authenticate(), async (ctx) => {
  const campaign = await db('campaigns').where('id', ctx.params.id).first();
  if (!campaign) throw Errors.notFound('Campaign not found');
  if (!campaign.ab_test_id) throw Errors.badRequest('Campaign has no A/B test');

  const variants = campaign.ab_variants || [];
  if (variants.length === 0) throw Errors.badRequest('No variants configured');

  // Deterministic assignment based on user ID + test ID
  const hashVal = deterministicHash(ctx.state.user.id, campaign.ab_test_id);

  // Check if user falls within rollout percentage
  if (campaign.current_rollout_percent < 100) {
    const rolloutHash = deterministicHash(ctx.state.user.id, `${campaign.ab_test_id}:rollout`);
    if (rolloutHash * 100 > campaign.current_rollout_percent) {
      ctx.body = { variant: null, reason: 'Not in rollout group' };
      return;
    }
  }

  // Assign variant based on cumulative weights
  let cumulative = 0;
  let assigned = variants[variants.length - 1];
  for (const variant of variants) {
    cumulative += variant.weight || (1 / variants.length);
    if (hashVal < cumulative) {
      assigned = variant;
      break;
    }
  }

  ctx.body = { variant: assigned.name, test_id: campaign.ab_test_id };
});

// ── Placements ──────────────────────────────────────────────────────────
router.post('/:id/placements', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const { slot, content, priority, start_at, end_at } = ctx.request.body;
  if (!slot) throw Errors.badRequest('slot is required');

  const [placement] = await db('placements')
    .insert({
      campaign_id: ctx.params.id,
      slot,
      content: content ? JSON.stringify(content) : '{}',
      priority: priority || 0,
      start_at,
      end_at,
    })
    .returning('*');

  ctx.status = 201;
  ctx.body = placement;
});

// Get active placements for a slot
router.get('/placements/active', authenticate(), async (ctx) => {
  const { slot } = ctx.query;
  if (!slot) throw Errors.badRequest('slot query param is required');

  const now = new Date();
  const placements = await db('placements')
    .join('campaigns', 'campaigns.id', 'placements.campaign_id')
    .where('placements.slot', slot)
    .where('campaigns.status', 'active')
    .where(function () {
      this.whereNull('placements.start_at').orWhere('placements.start_at', '<=', now);
    })
    .where(function () {
      this.whereNull('placements.end_at').orWhere('placements.end_at', '>=', now);
    })
    .orderBy('placements.priority', 'desc')
    .select('placements.*');

  ctx.body = placements;
});

// ── Coupons ─────────────────────────────────────────────────────────────
router.post('/coupons', authenticate(), requirePermission('campaigns.manage'), async (ctx) => {
  const { campaign_id, code, discount_type, discount_value, min_spend, max_uses, valid_from, valid_until } = ctx.request.body;

  if (!code || !discount_type || discount_value === undefined) {
    throw Errors.badRequest('code, discount_type, and discount_value are required');
  }

  // Validate ranges
  if (discount_type === 'fixed' && (discount_value < 5 || discount_value > 50)) {
    throw Errors.badRequest('Fixed discount must be between $5 and $50');
  }
  if (discount_type === 'percent' && (discount_value < 5 || discount_value > 30)) {
    throw Errors.badRequest('Percent discount must be between 5% and 30%');
  }

  const [coupon] = await db('coupons')
    .insert({
      campaign_id,
      code: code.toUpperCase(),
      discount_type,
      discount_value,
      min_spend: min_spend || 0,
      max_uses,
      valid_from,
      valid_until,
    })
    .returning('*');

  await ctx.audit({
    action: 'coupon.create',
    resourceType: 'coupon',
    resourceId: coupon.id,
    afterState: coupon,
    details: { code, discount_type, discount_value },
  });

  ctx.status = 201;
  ctx.body = coupon;
});

// Validate coupon
router.post('/coupons/validate', authenticate(), async (ctx) => {
  const { code, spend_amount } = ctx.request.body;
  if (!code) throw Errors.badRequest('code is required');

  const coupon = await db('coupons')
    .where({ code: code.toUpperCase(), is_active: true })
    .first();

  if (!coupon) {
    ctx.body = { valid: false, reason: 'Coupon not found or inactive' };
    return;
  }

  const now = new Date();
  if (coupon.valid_from && new Date(coupon.valid_from) > now) {
    ctx.body = { valid: false, reason: 'Coupon not yet valid' };
    return;
  }
  if (coupon.valid_until && new Date(coupon.valid_until) < now) {
    ctx.body = { valid: false, reason: 'Coupon has expired' };
    return;
  }
  if (coupon.max_uses && coupon.times_used >= coupon.max_uses) {
    ctx.body = { valid: false, reason: 'Coupon usage limit reached' };
    return;
  }
  if (spend_amount && Number(spend_amount) < Number(coupon.min_spend)) {
    ctx.body = { valid: false, reason: `Minimum spend of $${coupon.min_spend} required` };
    return;
  }

  let discount;
  if (coupon.discount_type === 'fixed') {
    discount = Number(coupon.discount_value);
  } else {
    discount = spend_amount ? (Number(spend_amount) * Number(coupon.discount_value)) / 100 : null;
  }

  ctx.body = { valid: true, coupon, discount };
});

// ── Analytics Event Ingestion ───────────────────────────────────────────
router.post('/events', authenticate(), async (ctx) => {
  const { idempotency_key, event_type, event_name, campaign_id, properties, ab_variant, funnel_name, funnel_step } = ctx.request.body;

  if (!idempotency_key || !event_type) {
    throw Errors.badRequest('idempotency_key and event_type are required');
  }

  // Idempotency check
  const existing = await db('analytics_events').where('idempotency_key', idempotency_key).first();
  if (existing) {
    ctx.body = { status: 'duplicate', event: existing };
    return;
  }

  const [event] = await db('analytics_events')
    .insert({
      idempotency_key,
      user_id: ctx.state.user.id,
      campaign_id,
      event_type,
      event_name,
      properties: properties ? JSON.stringify(properties) : '{}',
      ab_variant,
      funnel_name,
      funnel_step,
    })
    .returning('*');

  ctx.status = 201;
  ctx.body = event;
});

// ── Conversion Funnel Analytics ─────────────────────────────────────────
router.get('/analytics/funnel', authenticate(), requirePermission('campaigns.analytics'), async (ctx) => {
  const { funnel_name, campaign_id, from, to } = ctx.query;
  if (!funnel_name) throw Errors.badRequest('funnel_name is required');

  let query = db('analytics_events')
    .where('funnel_name', funnel_name)
    .groupBy('funnel_step')
    .orderBy('funnel_step')
    .select('funnel_step')
    .count('* as count')
    .countDistinct('user_id as unique_users');

  if (campaign_id) query = query.where('campaign_id', campaign_id);
  if (from) query = query.where('occurred_at', '>=', from);
  if (to) query = query.where('occurred_at', '<=', to);

  const steps = await query;

  // Calculate conversion rates
  const funnel = steps.map((step, i) => ({
    step: step.funnel_step,
    count: Number(step.count),
    unique_users: Number(step.unique_users),
    conversion_rate: i === 0 ? 1 : Number(step.unique_users) / Number(steps[0].unique_users),
    drop_off: i === 0 ? 0 : 1 - Number(step.unique_users) / Number(steps[i - 1].unique_users),
  }));

  ctx.body = { funnel_name, steps: funnel };
});

// ── A/B Test Results ────────────────────────────────────────────────────
router.get('/analytics/ab-test/:testId', authenticate(), requirePermission('campaigns.analytics'), async (ctx) => {
  const events = await db('analytics_events')
    .join('campaigns', 'campaigns.id', 'analytics_events.campaign_id')
    .where('campaigns.ab_test_id', ctx.params.testId)
    .whereNotNull('analytics_events.ab_variant')
    .groupBy('analytics_events.ab_variant', 'analytics_events.event_type')
    .select(
      'analytics_events.ab_variant',
      'analytics_events.event_type',
    )
    .count('* as count')
    .countDistinct('analytics_events.user_id as unique_users');

  // Group by variant
  const results = {};
  for (const row of events) {
    if (!results[row.ab_variant]) results[row.ab_variant] = {};
    results[row.ab_variant][row.event_type] = {
      count: Number(row.count),
      unique_users: Number(row.unique_users),
    };
  }

  ctx.body = { test_id: ctx.params.testId, variants: results };
});

module.exports = router;
