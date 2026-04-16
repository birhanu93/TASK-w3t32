const Router = require('koa-router');
const db = require('../db/connection');
const config = require('../config');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/moderation' });

// ── Moderation Queue ────────────────────────────────────────────────────
router.get('/cases', authenticate(), requirePermission('content.moderate'), async (ctx) => {
  const { status, page = 1, per_page = 20 } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('moderation_cases')
    .join('content_items', 'content_items.id', 'moderation_cases.content_item_id')
    .select('moderation_cases.*', 'content_items.title as content_title', 'content_items.author_id');

  if (status) query = query.where('moderation_cases.status', status);

  const [{ count }] = await query.clone().count();
  const cases = await query.orderBy('moderation_cases.created_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: cases,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// ── Get case detail ─────────────────────────────────────────────────────
router.get('/cases/:id', authenticate(), requirePermission('content.moderate'), async (ctx) => {
  const modCase = await db('moderation_cases').where('id', ctx.params.id).first();
  if (!modCase) throw Errors.notFound('Moderation case not found');

  const content = await db('content_items').where('id', modCase.content_item_id).first();
  const appeals = await db('appeals').where('moderation_case_id', modCase.id);

  ctx.body = { ...modCase, content, appeals };
});

// ── Report content ──────────────────────────────────────────────────────
router.post('/report', authenticate(), async (ctx) => {
  const { content_item_id, violation_category, description } = ctx.request.body;
  if (!content_item_id) throw Errors.badRequest('content_item_id is required');

  const content = await db('content_items').where('id', content_item_id).first();
  if (!content) throw Errors.notFound('Content item not found');

  const [modCase] = await db('moderation_cases')
    .insert({
      content_item_id,
      reported_by: ctx.state.user.id,
      violation_category,
      description,
    })
    .returning('*');

  ctx.status = 201;
  ctx.body = modCase;
});

// ── Review case (approve/reject) ────────────────────────────────────────
router.post('/cases/:id/review', authenticate(), requirePermission('content.moderate'), async (ctx) => {
  const { decision, comments } = ctx.request.body;
  if (!['resolved_approved', 'resolved_rejected'].includes(decision)) {
    throw Errors.badRequest('decision must be resolved_approved or resolved_rejected');
  }

  const modCase = await db('moderation_cases').where('id', ctx.params.id).first();
  if (!modCase) throw Errors.notFound('Moderation case not found');

  const [updated] = await db('moderation_cases')
    .where('id', ctx.params.id)
    .update({
      status: decision,
      reviewer_id: ctx.state.user.id,
      reviewer_comments: comments,
      decided_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');

  // Update content item status based on decision
  const contentStatus = decision === 'resolved_approved' ? 'approved' : 'rejected';
  await db('content_items')
    .where('id', modCase.content_item_id)
    .update({ status: contentStatus, updated_at: new Date() });

  await ctx.audit({
    action: 'moderation.review',
    resourceType: 'moderation_case',
    resourceId: ctx.params.id,
    beforeState: modCase,
    afterState: updated,
    details: { decision, content_item_id: modCase.content_item_id },
  });

  ctx.body = updated;
});

// ── Appeals ─────────────────────────────────────────────────────────────

// Submit appeal (content author only, or Administrator)
router.post('/cases/:id/appeal', authenticate(), async (ctx) => {
  const { reason } = ctx.request.body;
  if (!reason) throw Errors.badRequest('reason is required');

  const modCase = await db('moderation_cases').where('id', ctx.params.id).first();
  if (!modCase) throw Errors.notFound('Moderation case not found');

  // Only the original content author or an Administrator can submit an appeal
  const contentItem = await db('content_items').where('id', modCase.content_item_id).first();
  if (!contentItem) throw Errors.notFound('Associated content item not found');

  const userRoles = await db('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', ctx.state.user.id)
    .pluck('roles.name');

  if (contentItem.author_id !== ctx.state.user.id && !userRoles.includes('Administrator')) {
    throw Errors.forbidden('Only the content author or an Administrator can submit an appeal');
  }

  if (!['resolved_rejected'].includes(modCase.status)) {
    throw Errors.badRequest('Can only appeal rejected decisions');
  }

  // Check appeal window (14 days from decision)
  if (!modCase.decided_at) throw Errors.badRequest('No decision date found');
  const deadline = new Date(modCase.decided_at);
  deadline.setDate(deadline.getDate() + config.moderation.appealWindowDays);

  if (new Date() > deadline) {
    throw Errors.badRequest('Appeal window has expired (14 days from decision)');
  }

  // Check no existing appeal
  const existing = await db('appeals')
    .where({ moderation_case_id: ctx.params.id, appellant_id: ctx.state.user.id })
    .first();
  if (existing) throw Errors.conflict('Appeal already submitted');

  const [appeal] = await db('appeals')
    .insert({
      moderation_case_id: ctx.params.id,
      appellant_id: ctx.state.user.id,
      reason,
      deadline,
    })
    .returning('*');

  // Update case status
  await db('moderation_cases')
    .where('id', ctx.params.id)
    .update({ status: 'appealed', updated_at: new Date() });

  ctx.status = 201;
  ctx.body = appeal;
});

// Review appeal
router.post('/appeals/:id/review', authenticate(), requirePermission('content.moderate'), async (ctx) => {
  const { decision, comments } = ctx.request.body;
  if (!['approved', 'rejected'].includes(decision)) {
    throw Errors.badRequest('decision must be approved or rejected');
  }

  const appeal = await db('appeals').where('id', ctx.params.id).first();
  if (!appeal) throw Errors.notFound('Appeal not found');

  const [updated] = await db('appeals')
    .where('id', ctx.params.id)
    .update({
      status: decision,
      reviewer_id: ctx.state.user.id,
      reviewer_comments: comments,
      decided_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');

  // Update moderation case and content status
  const caseStatus = decision === 'approved' ? 'appeal_approved' : 'appeal_rejected';
  await db('moderation_cases')
    .where('id', appeal.moderation_case_id)
    .update({ status: caseStatus, updated_at: new Date() });

  if (decision === 'approved') {
    const modCase = await db('moderation_cases').where('id', appeal.moderation_case_id).first();
    await db('content_items')
      .where('id', modCase.content_item_id)
      .update({ status: 'approved', updated_at: new Date() });
  }

  await ctx.audit({
    action: 'appeal.review',
    resourceType: 'appeal',
    resourceId: ctx.params.id,
    beforeState: appeal,
    afterState: updated,
    details: { decision, moderation_case_id: appeal.moderation_case_id },
  });

  ctx.body = updated;
});

module.exports = router;
