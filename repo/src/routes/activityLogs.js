const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');
const { flagOutlierIfNeeded } = require('../services/assessmentEngine');

const router = new Router({ prefix: '/api/activity-logs' });

// ── Submit activity log ─────────────────────────────────────────────────
router.post('/', authenticate(), async (ctx) => {
  const {
    task_id, plan_id, activity_type, value, unit,
    dimensions, metadata, performed_at,
  } = ctx.request.body;

  if (!activity_type || value === undefined || !performed_at) {
    throw Errors.badRequest('activity_type, value, and performed_at are required');
  }

  const [log] = await db('activity_logs')
    .insert({
      user_id: ctx.state.user.id,
      task_id,
      plan_id,
      activity_type,
      value,
      unit,
      dimensions: dimensions ? JSON.stringify(dimensions) : '{}',
      metadata: metadata ? JSON.stringify(metadata) : '{}',
      performed_at,
    })
    .returning('*');

  // Auto-check outlier against trailing-30/3σ rules
  const outlierResult = await flagOutlierIfNeeded(log.id, ctx.state.user.id, activity_type, value);

  // Re-read if flagged so response reflects the outlier status
  if (outlierResult.isOutlier) {
    const updated = await db('activity_logs').where('id', log.id).first();
    ctx.status = 201;
    ctx.body = { ...updated, outlier_detection: outlierResult };
    return;
  }

  ctx.status = 201;
  ctx.body = { ...log, outlier_detection: outlierResult };
});

// ── List activity logs for current user ─────────────────────────────────
router.get('/me', authenticate(), async (ctx) => {
  const { page = 1, per_page = 50, activity_type, plan_id, from, to } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('activity_logs').where('user_id', ctx.state.user.id);
  if (activity_type) query = query.where('activity_type', activity_type);
  if (plan_id) query = query.where('plan_id', plan_id);
  if (from) query = query.where('performed_at', '>=', from);
  if (to) query = query.where('performed_at', '<=', to);

  const [{ count }] = await query.clone().count();
  const logs = await query.orderBy('performed_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: logs,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// ── List activity logs for a user (Coach/Admin) ─────────────────────────
router.get('/user/:userId', authenticate(), requirePermission('activity_logs.view_all'), async (ctx) => {
  const { page = 1, per_page = 50, activity_type } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('activity_logs').where('user_id', ctx.params.userId);
  if (activity_type) query = query.where('activity_type', activity_type);

  const [{ count }] = await query.clone().count();
  const logs = await query.orderBy('performed_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: logs,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// ── Get single log ──────────────────────────────────────────────────────
router.get('/:id', authenticate(), async (ctx) => {
  const log = await db('activity_logs').where('id', ctx.params.id).first();
  if (!log) throw Errors.notFound('Activity log not found');

  // Users can only see their own unless privileged
  if (log.user_id !== ctx.state.user.id) {
    const roles = await db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', ctx.state.user.id)
      .pluck('roles.name');
    if (!roles.some((r) => ['Administrator', 'Operations Manager', 'Coach'].includes(r))) {
      throw Errors.forbidden();
    }
  }

  ctx.body = log;
});

// ── Approve outlier ─────────────────────────────────────────────────────
router.post('/:id/approve-outlier', authenticate(), requirePermission('activity_logs.approve_outlier'), async (ctx) => {
  const log = await db('activity_logs').where('id', ctx.params.id).first();
  if (!log) throw Errors.notFound('Activity log not found');
  if (!log.is_outlier) throw Errors.badRequest('Log is not flagged as outlier');

  const [updated] = await db('activity_logs')
    .where('id', ctx.params.id)
    .update({
      outlier_approved: true,
      outlier_approved_by: ctx.state.user.id,
      updated_at: new Date(),
    })
    .returning('*');

  await ctx.audit({
    action: 'activity_log.approve_outlier',
    resourceType: 'activity_log',
    resourceId: ctx.params.id,
    beforeState: log,
    afterState: updated,
    details: { user_id: log.user_id },
  });

  ctx.body = updated;
});

// ── Batch submit (offline-first sync) ───────────────────────────────────
router.post('/batch', authenticate(), async (ctx) => {
  const { logs } = ctx.request.body;
  if (!Array.isArray(logs) || logs.length === 0) {
    throw Errors.badRequest('logs array is required');
  }

  const inserted = [];
  let outliersFlagged = 0;
  for (const log of logs) {
    const [record] = await db('activity_logs')
      .insert({
        user_id: ctx.state.user.id,
        task_id: log.task_id,
        plan_id: log.plan_id,
        activity_type: log.activity_type,
        value: log.value,
        unit: log.unit,
        dimensions: log.dimensions ? JSON.stringify(log.dimensions) : '{}',
        metadata: log.metadata ? JSON.stringify(log.metadata) : '{}',
        performed_at: log.performed_at,
      })
      .returning('*');

    // Auto-check outlier against trailing-30/3σ rules
    const outlierResult = await flagOutlierIfNeeded(
      record.id, ctx.state.user.id, log.activity_type, log.value
    );
    if (outlierResult.isOutlier) {
      outliersFlagged++;
      const updated = await db('activity_logs').where('id', record.id).first();
      inserted.push({ ...updated, outlier_detection: outlierResult });
    } else {
      inserted.push({ ...record, outlier_detection: outlierResult });
    }
  }

  ctx.status = 201;
  ctx.body = { inserted: inserted.length, outliers_flagged: outliersFlagged, logs: inserted };
});

module.exports = router;
