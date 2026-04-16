const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission, requireAccess, filterAccessible } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/resources' });

// ── Resource CRUD ───────────────────────────────────────────────────────

router.get('/', authenticate(), async (ctx) => {
  const { type, parent_id, page = 1, per_page = 50 } = ctx.query;

  let query = db('resources');
  if (type) query = query.where('type', type);
  if (parent_id) query = query.where('parent_id', parent_id);

  const allResources = await query.orderBy('created_at', 'desc');

  // ACL-filter: only return resources the user can read
  const allIds = allResources.map((r) => r.id);
  const accessibleIds = await filterAccessible(ctx.state.user.id, allIds, 'read');
  const accessibleSet = new Set(accessibleIds);
  const filtered = allResources.filter((r) => accessibleSet.has(r.id));

  // Paginate post-filter
  const offset = (page - 1) * per_page;
  const paged = filtered.slice(offset, offset + Number(per_page));

  ctx.body = {
    data: paged,
    pagination: { page: +page, per_page: +per_page, total: filtered.length, total_pages: Math.ceil(filtered.length / per_page) },
  };
});

router.get('/:id', authenticate(), requireAccess('read', 'id'), async (ctx) => {
  const resource = await db('resources').where('id', ctx.params.id).first();
  if (!resource) throw Errors.notFound('Resource not found');

  const acls = await db('acl_entries').where('resource_id', resource.id);
  ctx.body = { ...resource, acl: acls };
});

router.post('/', authenticate(), async (ctx) => {
  const { type, name, parent_id, metadata } = ctx.request.body;
  if (!type || !name) throw Errors.badRequest('type and name are required');

  const [resource] = await db('resources')
    .insert({
      type,
      name,
      parent_id,
      owner_id: ctx.state.user.id,
      metadata: metadata ? JSON.stringify(metadata) : '{}',
    })
    .returning('*');

  await ctx.audit({
    action: 'resource.create',
    resourceType: 'resource',
    resourceId: resource.id,
    afterState: resource,
  });

  ctx.status = 201;
  ctx.body = resource;
});

router.delete('/:id', authenticate(), requireAccess('delete', 'id'), async (ctx) => {
  const resource = await db('resources').where('id', ctx.params.id).first();
  if (!resource) throw Errors.notFound('Resource not found');

  await db('resources').where('id', ctx.params.id).del();

  await ctx.audit({
    action: 'resource.delete',
    resourceType: 'resource',
    resourceId: ctx.params.id,
    beforeState: resource,
  });

  ctx.status = 204;
});

// ── ACL Management ──────────────────────────────────────────────────────

router.post('/:id/acl', authenticate(), requirePermission('resources.manage_acl'), async (ctx) => {
  const { user_id, role_id, action, effect = 'allow' } = ctx.request.body;
  if (!action) throw Errors.badRequest('action is required');
  if (!user_id && !role_id) throw Errors.badRequest('Either user_id or role_id is required');

  const validActions = ['read', 'download', 'edit', 'delete', 'share', 'submit', 'approve'];
  if (!validActions.includes(action)) {
    throw Errors.badRequest(`action must be one of: ${validActions.join(', ')}`);
  }

  const [entry] = await db('acl_entries')
    .insert({
      resource_id: ctx.params.id,
      user_id,
      role_id,
      action,
      effect,
    })
    .returning('*');

  await ctx.audit({
    action: 'acl.create',
    resourceType: 'acl_entry',
    resourceId: entry.id,
    afterState: entry,
    details: { resource_id: ctx.params.id, user_id, role_id, action: action, effect },
  });

  ctx.status = 201;
  ctx.body = entry;
});

router.delete('/:resourceId/acl/:aclId', authenticate(), requirePermission('resources.manage_acl'), async (ctx) => {
  const entry = await db('acl_entries').where('id', ctx.params.aclId).first();
  if (!entry) throw Errors.notFound('ACL entry not found');

  await db('acl_entries').where('id', ctx.params.aclId).del();

  await ctx.audit({
    action: 'acl.delete',
    resourceType: 'acl_entry',
    resourceId: ctx.params.aclId,
    beforeState: entry,
  });

  ctx.status = 204;
});

// Propagate ACL from parent (inheritance)
router.post('/:id/acl/propagate', authenticate(), requirePermission('resources.manage_acl'), async (ctx) => {
  const resource = await db('resources').where('id', ctx.params.id).first();
  if (!resource) throw Errors.notFound('Resource not found');

  // Find all children
  const children = await db('resources').where('parent_id', ctx.params.id);

  // Get parent ACL entries
  const parentAcls = await db('acl_entries').where('resource_id', ctx.params.id);

  let created = 0;
  for (const child of children) {
    for (const acl of parentAcls) {
      // Check if already exists
      const existing = await db('acl_entries')
        .where({
          resource_id: child.id,
          user_id: acl.user_id,
          role_id: acl.role_id,
          action: acl.action,
          inherited: true,
        })
        .first();

      if (!existing) {
        await db('acl_entries').insert({
          resource_id: child.id,
          user_id: acl.user_id,
          role_id: acl.role_id,
          action: acl.action,
          effect: acl.effect,
          inherited: true,
        });
        created++;
      }
    }
  }

  ctx.body = { message: `Propagated ACL to ${children.length} children`, entries_created: created };
});

module.exports = router;
