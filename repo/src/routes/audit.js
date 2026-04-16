const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/audit' });

// ── Query audit logs ────────────────────────────────────────────────────
router.get('/logs', authenticate(), requirePermission('audit.view'), async (ctx) => {
  const { actor_id, action, resource_type, resource_id, from, to, page = 1, per_page = 50 } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('audit_logs');
  if (actor_id) query = query.where('actor_id', actor_id);
  if (action) query = query.where('action', 'ilike', `%${action}%`);
  if (resource_type) query = query.where('resource_type', resource_type);
  if (resource_id) query = query.where('resource_id', resource_id);
  if (from) query = query.where('created_at', '>=', from);
  if (to) query = query.where('created_at', '<=', to);

  const [{ count }] = await query.clone().count();
  const logs = await query.orderBy('created_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: logs,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

router.get('/logs/:id', authenticate(), requirePermission('audit.view'), async (ctx) => {
  const log = await db('audit_logs').where('id', ctx.params.id).first();
  if (!log) throw Errors.notFound('Audit log not found');
  ctx.body = log;
});

module.exports = router;
