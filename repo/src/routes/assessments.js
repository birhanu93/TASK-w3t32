const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');
const assessmentEngine = require('../services/assessmentEngine');

const router = new Router({ prefix: '/api/assessments' });

// ── Assessment Rules CRUD ───────────────────────────────────────────────

// List rules
router.get('/rules', authenticate(), async (ctx) => {
  const { assessment_type, active_only } = ctx.query;
  let query = db('assessment_rules');
  if (assessment_type) query = query.where('assessment_type', assessment_type);
  if (active_only === 'true') query = query.where('is_active', true);
  ctx.body = await query.orderBy('assessment_type').orderBy('version', 'desc');
});

// Get active rule for a type
router.get('/rules/active/:type', authenticate(), async (ctx) => {
  const rule = await assessmentEngine.getActiveRule(ctx.params.type);
  if (!rule) throw Errors.notFound('No active rule for this assessment type');
  ctx.body = rule;
});

// Create rule version
router.post('/rules', authenticate(), requirePermission('assessments.manage_rules'), async (ctx) => {
  const { assessment_type, scoring_items, outlier_config, description } = ctx.request.body;

  if (!assessment_type || !scoring_items) {
    throw Errors.badRequest('assessment_type and scoring_items are required');
  }

  // Validate each item has required fields and valid values
  for (const item of scoring_items) {
    if (!item.name || !item.type || item.weight === undefined || item.min_bound === undefined || item.max_bound === undefined) {
      throw Errors.badRequest('Each scoring item must have name, type, weight, min_bound, and max_bound');
    }
    if (!['time_seconds', 'rep_count', 'combined_completion'].includes(item.type)) {
      throw Errors.badRequest(`Invalid scoring type: ${item.type}`);
    }

    const weight = Number(item.weight);
    const minBound = Number(item.min_bound);
    const maxBound = Number(item.max_bound);

    // Reject non-finite values (NaN, Infinity, -Infinity)
    if (!Number.isFinite(weight)) {
      throw Errors.badRequest(`Item "${item.name}": weight must be a finite number (got ${item.weight})`);
    }
    if (!Number.isFinite(minBound)) {
      throw Errors.badRequest(`Item "${item.name}": min_bound must be a finite number (got ${item.min_bound})`);
    }
    if (!Number.isFinite(maxBound)) {
      throw Errors.badRequest(`Item "${item.name}": max_bound must be a finite number (got ${item.max_bound})`);
    }

    // Weight must be in (0, 1]
    if (weight <= 0) {
      throw Errors.badRequest(`Item "${item.name}": weight must be greater than 0 (got ${weight})`);
    }
    if (weight > 1) {
      throw Errors.badRequest(`Item "${item.name}": weight must not exceed 1 (got ${weight})`);
    }

    // min_bound must be strictly less than max_bound
    if (minBound >= maxBound) {
      throw Errors.badRequest(`Item "${item.name}": min_bound (${minBound}) must be less than max_bound (${maxBound})`);
    }
  }

  // Validate weights sum to 1.00
  const weightSum = scoring_items.reduce((sum, item) => sum + Number(item.weight), 0);
  if (Math.abs(weightSum - 1.0) > 0.001) {
    throw Errors.badRequest(`Scoring item weights must sum to 1.00 (got ${weightSum.toFixed(4)})`);
  }

  // Auto-increment version
  const latest = await db('assessment_rules')
    .where('assessment_type', assessment_type)
    .orderBy('version', 'desc')
    .first();
  const version = latest ? latest.version + 1 : 1;

  // Deactivate previous active version
  await db('assessment_rules')
    .where({ assessment_type, is_active: true })
    .update({ is_active: false, updated_at: new Date() });

  const [rule] = await db('assessment_rules')
    .insert({
      assessment_type,
      version,
      scoring_items: JSON.stringify(scoring_items),
      outlier_config: outlier_config ? JSON.stringify(outlier_config) : undefined,
      description,
      created_by: ctx.state.user.id,
    })
    .returning('*');

  await ctx.audit({
    action: 'assessment_rule.create',
    resourceType: 'assessment_rule',
    resourceId: rule.id,
    afterState: rule,
    details: { assessment_type, version },
  });

  ctx.status = 201;
  ctx.body = rule;
});

// ── Score Computation ───────────────────────────────────────────────────

// Compute score for current user
router.post('/compute', authenticate(), async (ctx) => {
  const { assessment_type, window_start, window_end } = ctx.request.body;
  if (!assessment_type) throw Errors.badRequest('assessment_type is required');

  const result = await assessmentEngine.computeScore(ctx.state.user.id, assessment_type, {
    windowStart: window_start,
    windowEnd: window_end,
  });

  ctx.status = 201;
  ctx.body = result;
});

// Compute score for a specific user (Coach/Admin)
router.post('/compute/:userId', authenticate(), requirePermission('assessments.compute_any'), async (ctx) => {
  const { assessment_type, window_start, window_end } = ctx.request.body;
  if (!assessment_type) throw Errors.badRequest('assessment_type is required');

  const result = await assessmentEngine.computeScore(ctx.params.userId, assessment_type, {
    windowStart: window_start,
    windowEnd: window_end,
  });

  ctx.status = 201;
  ctx.body = result;
});

// ── Score History ───────────────────────────────────────────────────────

// Get scores for current user
router.get('/scores/me', authenticate(), async (ctx) => {
  const { assessment_type, page = 1, per_page = 20 } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('computed_scores').where('user_id', ctx.state.user.id);
  if (assessment_type) {
    query = query.whereIn('assessment_rule_id',
      db('assessment_rules').where('assessment_type', assessment_type).select('id')
    );
  }

  const [{ count }] = await query.clone().count();
  const scores = await query.orderBy('computed_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: scores,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// Get single score with full traceability
router.get('/scores/:id', authenticate(), async (ctx) => {
  const score = await db('computed_scores').where('id', ctx.params.id).first();
  if (!score) throw Errors.notFound('Score not found');

  // Only owner or privileged roles
  if (score.user_id !== ctx.state.user.id) {
    const roles = await db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', ctx.state.user.id)
      .pluck('roles.name');
    if (!roles.some((r) => ['Administrator', 'Operations Manager', 'Coach'].includes(r))) {
      throw Errors.forbidden();
    }
  }

  // Fetch the rule that was used
  const rule = await db('assessment_rules').where('id', score.assessment_rule_id).first();

  ctx.body = {
    ...score,
    rule: {
      id: rule.id,
      assessment_type: rule.assessment_type,
      version: rule.version,
      scoring_items: rule.scoring_items,
    },
  };
});

// ── Outlier Detection Check ─────────────────────────────────────────────
router.post('/check-outlier', authenticate(), async (ctx) => {
  const { activity_type, value } = ctx.request.body;
  if (!activity_type || value === undefined) {
    throw Errors.badRequest('activity_type and value are required');
  }

  const result = await assessmentEngine.detectOutlier(
    ctx.state.user.id,
    activity_type,
    value
  );

  ctx.body = result;
});

module.exports = router;
