const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/users' });

// ── List users (Admin/Operations Manager) ───────────────────────────────
router.get('/', authenticate(), requirePermission('users.list'), async (ctx) => {
  const { page = 1, per_page = 20, search, role, is_active } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('users')
    .select('id', 'username', 'email', 'full_name', 'is_active', 'created_at', 'updated_at');

  if (search) {
    query = query.where(function () {
      this.where('username', 'ilike', `%${search}%`)
        .orWhere('email', 'ilike', `%${search}%`)
        .orWhere('full_name', 'ilike', `%${search}%`);
    });
  }
  if (is_active !== undefined) {
    query = query.where('is_active', is_active === 'true');
  }
  if (role) {
    query = query.whereIn('id', function () {
      this.select('user_id').from('user_roles')
        .join('roles', 'roles.id', 'user_roles.role_id')
        .where('roles.name', role);
    });
  }

  const [{ count }] = await query.clone().count();
  const users = await query.orderBy('created_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: users,
    pagination: {
      page: Number(page),
      per_page: Number(per_page),
      total: Number(count),
      total_pages: Math.ceil(count / per_page),
    },
  };
});

// ── Get user by ID ──────────────────────────────────────────────────────
router.get('/:id', authenticate(), requirePermission('users.read'), async (ctx) => {
  const user = await db('users')
    .where('id', ctx.params.id)
    .select('id', 'username', 'email', 'full_name', 'profile', 'is_active', 'created_at', 'updated_at')
    .first();
  if (!user) throw Errors.notFound('User not found');

  const roles = await db('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', user.id)
    .pluck('roles.name');

  ctx.body = { ...user, roles };
});

// ── Assign role ─────────────────────────────────────────────────────────
router.post('/:id/roles', authenticate(), requirePermission('users.manage_roles'), async (ctx) => {
  const { role_name } = ctx.request.body;
  if (!role_name) throw Errors.badRequest('role_name is required');

  const role = await db('roles').where('name', role_name).first();
  if (!role) throw Errors.notFound('Role not found');

  const existing = await db('user_roles')
    .where({ user_id: ctx.params.id, role_id: role.id })
    .first();
  if (existing) throw Errors.conflict('User already has this role');

  const [assignment] = await db('user_roles').insert({
    user_id: ctx.params.id,
    role_id: role.id,
    assigned_by: ctx.state.user.id,
  }).returning('*');

  await ctx.audit({
    action: 'user.assign_role',
    resourceType: 'user',
    resourceId: ctx.params.id,
    afterState: assignment,
    details: { role_name },
  });

  ctx.status = 201;
  ctx.body = { message: `Role ${role_name} assigned` };
});

// ── Remove role ─────────────────────────────────────────────────────────
router.delete('/:id/roles/:roleName', authenticate(), requirePermission('users.manage_roles'), async (ctx) => {
  const role = await db('roles').where('name', ctx.params.roleName).first();
  if (!role) throw Errors.notFound('Role not found');

  const existingAssignment = await db('user_roles')
    .where({ user_id: ctx.params.id, role_id: role.id })
    .first();
  if (!existingAssignment) throw Errors.notFound('User does not have this role');

  await db('user_roles')
    .where({ user_id: ctx.params.id, role_id: role.id })
    .del();

  await ctx.audit({
    action: 'user.remove_role',
    resourceType: 'user',
    resourceId: ctx.params.id,
    beforeState: existingAssignment,
    details: { role_name: ctx.params.roleName },
  });

  ctx.body = { message: `Role ${ctx.params.roleName} removed` };
});

// ── Deactivate user ─────────────────────────────────────────────────────
router.post('/:id/deactivate', authenticate(), requirePermission('users.deactivate'), async (ctx) => {
  const before = await db('users').where('id', ctx.params.id).select('id', 'is_active').first();
  await db('users').where('id', ctx.params.id).update({ is_active: false, updated_at: new Date() });
  const after = await db('users').where('id', ctx.params.id).select('id', 'is_active').first();

  await ctx.audit({
    action: 'user.deactivate',
    resourceType: 'user',
    resourceId: ctx.params.id,
    beforeState: before,
    afterState: after,
  });

  ctx.body = { message: 'User deactivated' };
});

// ── Reactivate user ─────────────────────────────────────────────────────
router.post('/:id/activate', authenticate(), requirePermission('users.deactivate'), async (ctx) => {
  const before = await db('users').where('id', ctx.params.id).select('id', 'is_active').first();
  await db('users').where('id', ctx.params.id).update({ is_active: true, updated_at: new Date() });
  const after = await db('users').where('id', ctx.params.id).select('id', 'is_active').first();

  await ctx.audit({
    action: 'user.activate',
    resourceType: 'user',
    resourceId: ctx.params.id,
    beforeState: before,
    afterState: after,
  });

  ctx.body = { message: 'User activated' };
});

module.exports = router;
