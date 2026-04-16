const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/plans' });

// ── List plans ──────────────────────────────────────────────────────────
router.get('/', authenticate(), async (ctx) => {
  const { page = 1, per_page = 20, status } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('plans');
  if (status) query = query.where('status', status);

  const [{ count }] = await query.clone().count();
  const plans = await query.orderBy('created_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: plans,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// ── Get plan ────────────────────────────────────────────────────────────
router.get('/:id', authenticate(), async (ctx) => {
  const plan = await db('plans').where('id', ctx.params.id).first();
  if (!plan) throw Errors.notFound('Plan not found');

  const tasks = await db('tasks').where('plan_id', plan.id).orderBy('sort_order');

  // Enrollment details are only visible to privileged roles (Admin, Ops, Coach)
  // or the plan creator. Participants only see their own enrollment status.
  const userRoles = await db('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', ctx.state.user.id)
    .pluck('roles.name');

  const isPrivileged = userRoles.some((r) =>
    ['Administrator', 'Operations Manager', 'OManager', 'Coach'].includes(r)
  ) || plan.created_by === ctx.state.user.id;

  let enrollments;
  if (isPrivileged) {
    enrollments = await db('plan_enrollments')
      .where('plan_id', plan.id)
      .join('users', 'users.id', 'plan_enrollments.user_id')
      .select('plan_enrollments.*', 'users.username', 'users.full_name');
  } else {
    // Participants only see their own enrollment
    enrollments = await db('plan_enrollments')
      .where({ plan_id: plan.id, user_id: ctx.state.user.id })
      .select('*');
  }

  ctx.body = { ...plan, tasks, enrollments };
});

// ── Create plan ─────────────────────────────────────────────────────────
router.post('/', authenticate(), requirePermission('plans.create'), async (ctx) => {
  const { title, description, start_date, end_date, config: planConfig } = ctx.request.body;
  if (!title) throw Errors.badRequest('title is required');

  const [plan] = await db('plans')
    .insert({
      title,
      description,
      start_date,
      end_date,
      config: planConfig ? JSON.stringify(planConfig) : '{}',
      created_by: ctx.state.user.id,
    })
    .returning('*');

  await ctx.audit({
    action: 'plan.create',
    resourceType: 'plan',
    resourceId: plan.id,
    afterState: plan,
  });

  ctx.status = 201;
  ctx.body = plan;
});

// ── Update plan ─────────────────────────────────────────────────────────
router.put('/:id', authenticate(), requirePermission('plans.update'), async (ctx) => {
  const before = await db('plans').where('id', ctx.params.id).first();
  if (!before) throw Errors.notFound('Plan not found');

  const { title, description, status, start_date, end_date, config: planConfig } = ctx.request.body;
  const updates = { updated_at: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (status !== undefined) updates.status = status;
  if (start_date !== undefined) updates.start_date = start_date;
  if (end_date !== undefined) updates.end_date = end_date;
  if (planConfig !== undefined) updates.config = JSON.stringify(planConfig);

  const [plan] = await db('plans').where('id', ctx.params.id).update(updates).returning('*');

  await ctx.audit({
    action: 'plan.update',
    resourceType: 'plan',
    resourceId: plan.id,
    beforeState: before,
    afterState: plan,
  });

  ctx.body = plan;
});

// ── Delete plan ─────────────────────────────────────────────────────────
router.delete('/:id', authenticate(), requirePermission('plans.delete'), async (ctx) => {
  const plan = await db('plans').where('id', ctx.params.id).first();
  if (!plan) throw Errors.notFound('Plan not found');

  await db('plans').where('id', ctx.params.id).del();

  await ctx.audit({
    action: 'plan.delete',
    resourceType: 'plan',
    resourceId: ctx.params.id,
    beforeState: plan,
  });

  ctx.status = 204;
});

// ── Enroll in plan ──────────────────────────────────────────────────────
router.post('/:id/enroll', authenticate(), async (ctx) => {
  const plan = await db('plans').where('id', ctx.params.id).first();
  if (!plan) throw Errors.notFound('Plan not found');
  if (plan.status !== 'active') throw Errors.badRequest('Plan is not active');

  const existing = await db('plan_enrollments')
    .where({ plan_id: ctx.params.id, user_id: ctx.state.user.id })
    .first();
  if (existing) throw Errors.conflict('Already enrolled');

  const [enrollment] = await db('plan_enrollments')
    .insert({ plan_id: ctx.params.id, user_id: ctx.state.user.id })
    .returning('*');

  ctx.status = 201;
  ctx.body = enrollment;
});

// ── Tasks CRUD within a plan ────────────────────────────────────────────
router.get('/:id/tasks', authenticate(), async (ctx) => {
  const tasks = await db('tasks').where('plan_id', ctx.params.id).orderBy('sort_order');
  ctx.body = tasks;
});

router.post('/:id/tasks', authenticate(), requirePermission('plans.update'), async (ctx) => {
  const { title, description, sort_order, type, config: taskConfig } = ctx.request.body;
  if (!title) throw Errors.badRequest('title is required');

  const [task] = await db('tasks')
    .insert({
      plan_id: ctx.params.id,
      title,
      description,
      sort_order: sort_order || 0,
      type: type || 'exercise',
      config: taskConfig ? JSON.stringify(taskConfig) : '{}',
    })
    .returning('*');

  ctx.status = 201;
  ctx.body = task;
});

router.put('/:planId/tasks/:taskId', authenticate(), requirePermission('plans.update'), async (ctx) => {
  const { title, description, sort_order, type, config: taskConfig } = ctx.request.body;
  const updates = { updated_at: new Date() };
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (sort_order !== undefined) updates.sort_order = sort_order;
  if (type !== undefined) updates.type = type;
  if (taskConfig !== undefined) updates.config = JSON.stringify(taskConfig);

  const [task] = await db('tasks')
    .where({ id: ctx.params.taskId, plan_id: ctx.params.planId })
    .update(updates)
    .returning('*');

  if (!task) throw Errors.notFound('Task not found');
  ctx.body = task;
});

router.delete('/:planId/tasks/:taskId', authenticate(), requirePermission('plans.update'), async (ctx) => {
  const task = await db('tasks')
    .where({ id: ctx.params.taskId, plan_id: ctx.params.planId })
    .first();
  if (!task) throw Errors.notFound('Task not found');

  await db('tasks')
    .where({ id: ctx.params.taskId, plan_id: ctx.params.planId })
    .del();

  await ctx.audit({
    action: 'task.delete',
    resourceType: 'task',
    resourceId: ctx.params.taskId,
    beforeState: task,
    details: { plan_id: ctx.params.planId },
  });

  ctx.status = 204;
});

module.exports = router;
