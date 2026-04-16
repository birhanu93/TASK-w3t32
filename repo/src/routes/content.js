const Router = require('koa-router');
const crypto = require('crypto');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission, checkAccess, filterAccessible } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/content' });

// ── Resource-level ACL helper for content items ─────────────────────────
// Fail-closed: if no resource record exists for this content item, deny
// access. Non-admin users must have an explicit ACL grant.
async function enforceContentACL(ctx, contentItemId, action) {
  const resource = await db('resources')
    .where({ type: 'content_item' })
    .whereRaw("(metadata->>'content_item_id')::text = ?", [String(contentItemId)])
    .first();
  if (!resource) {
    // Fail-closed: no ACL record means no access (except for the content author)
    const item = await db('content_items').where('id', contentItemId).select('author_id').first();
    if (item && item.author_id === ctx.state.user.id) return;
    throw Errors.forbidden(`No ${action} access to this content item (no ACL record)`);
  }
  const hasAccess = await checkAccess(ctx.state.user.id, resource.id, action);
  if (!hasAccess) {
    throw Errors.forbidden(`No ${action} access to this content item`);
  }
}

// ── Automated Pre-Screening ─────────────────────────────────────────────
async function preScreenContent(contentItem) {
  const results = { passed: true, violations: [] };
  const categories = await db('violation_categories').where('is_active', true);

  for (const cat of categories) {
    // Keyword check
    if (cat.keyword_list && cat.keyword_list.length > 0) {
      const text = `${contentItem.title} ${contentItem.body || ''}`.toLowerCase();
      for (const keyword of cat.keyword_list) {
        if (text.includes(keyword.toLowerCase())) {
          results.passed = false;
          results.violations.push({
            category: cat.name,
            type: 'keyword_match',
            detail: `Contains blocked keyword: "${keyword}"`,
          });
        }
      }
    }

    // File type check
    if (contentItem.file_type && cat.file_type_allowlist && cat.file_type_allowlist.length > 0) {
      if (!cat.file_type_allowlist.includes(contentItem.file_type)) {
        results.passed = false;
        results.violations.push({
          category: cat.name,
          type: 'file_type_blocked',
          detail: `File type "${contentItem.file_type}" not in allowlist`,
        });
      }
    }

    // File size check
    if (contentItem.file_size && cat.max_file_size_bytes) {
      if (contentItem.file_size > cat.max_file_size_bytes) {
        results.passed = false;
        results.violations.push({
          category: cat.name,
          type: 'file_size_exceeded',
          detail: `File size ${contentItem.file_size} exceeds limit ${cat.max_file_size_bytes}`,
        });
      }
    }

    // SHA-256 fingerprint check
    if (contentItem.file_hash && cat.blocked_fingerprints && cat.blocked_fingerprints.length > 0) {
      if (cat.blocked_fingerprints.includes(contentItem.file_hash)) {
        results.passed = false;
        results.violations.push({
          category: cat.name,
          type: 'fingerprint_blocked',
          detail: 'File fingerprint matches blocked content',
        });
      }
    }
  }

  return results;
}

// ── Topics Configuration ────────────────────────────────────────────────
// Static paths MUST be registered before /:id to avoid path-matching conflicts
router.get('/topics/list', authenticate(), async (ctx) => {
  ctx.body = await db('topics').where('is_active', true).orderBy('sort_order');
});

router.post('/topics', authenticate(), requirePermission('content.manage_topics'), async (ctx) => {
  const { name, description, parent_id, sort_order } = ctx.request.body;
  if (!name) throw Errors.badRequest('name is required');

  const [topic] = await db('topics')
    .insert({ name, description, parent_id, sort_order: sort_order || 0 })
    .returning('*');

  ctx.status = 201;
  ctx.body = topic;
});

// ── Violation Categories Configuration ──────────────────────────────────
router.get('/violation-categories', authenticate(), requirePermission('content.manage_categories'), async (ctx) => {
  ctx.body = await db('violation_categories').orderBy('severity', 'desc');
});

router.post('/violation-categories', authenticate(), requirePermission('content.manage_categories'), async (ctx) => {
  const { name, description, severity, keyword_list, file_type_allowlist, max_file_size_bytes, blocked_fingerprints } = ctx.request.body;
  if (!name) throw Errors.badRequest('name is required');

  const [cat] = await db('violation_categories')
    .insert({
      name,
      description,
      severity: severity || 1,
      keyword_list: keyword_list ? JSON.stringify(keyword_list) : '[]',
      file_type_allowlist: file_type_allowlist ? JSON.stringify(file_type_allowlist) : '[]',
      max_file_size_bytes,
      blocked_fingerprints: blocked_fingerprints ? JSON.stringify(blocked_fingerprints) : '[]',
    })
    .returning('*');

  await ctx.audit({
    action: 'violation_category.create',
    resourceType: 'violation_category',
    resourceId: cat.id,
    afterState: cat,
  });

  ctx.status = 201;
  ctx.body = cat;
});

// ── Content Items CRUD ──────────────────────────────────────────────────

router.get('/', authenticate(), async (ctx) => {
  const { page = 1, per_page = 20, status, topic, author_id } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('content_items');
  if (status) query = query.where('status', status);
  if (topic) query = query.where('topic', topic);
  if (author_id) query = query.where('author_id', author_id);

  const items = await query.orderBy('created_at', 'desc');

  // ACL-filter: if resource records exist for content items, respect ACL
  const resourceMap = {};
  const resources = await db('resources').where({ type: 'content_item' });
  for (const r of resources) {
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
    if (meta?.content_item_id) resourceMap[meta.content_item_id] = r.id;
  }

  const aclControlledIds = items
    .filter((i) => resourceMap[i.id])
    .map((i) => resourceMap[i.id]);

  let accessibleResourceIds = new Set();
  if (aclControlledIds.length > 0) {
    const allowed = await filterAccessible(ctx.state.user.id, aclControlledIds, 'read');
    accessibleResourceIds = new Set(allowed);
  }

  const filtered = items.filter((i) => {
    const resourceId = resourceMap[i.id];
    if (!resourceId) {
      // Fail-closed: no ACL record — only visible to the author
      return i.author_id === ctx.state.user.id;
    }
    return accessibleResourceIds.has(resourceId);
  });

  // Paginate post-filter
  const paged = filtered.slice(offset, offset + Number(per_page));

  ctx.body = {
    data: paged,
    pagination: { page: +page, per_page: +per_page, total: filtered.length, total_pages: Math.ceil(filtered.length / per_page) },
  };
});

router.post('/', authenticate(), async (ctx) => {
  const { title, body, content_type, file_type, file_size, file_hash, topic, tags, metadata } = ctx.request.body;
  if (!title || !content_type) throw Errors.badRequest('title and content_type are required');

  // Compute SHA-256 if body provided and no hash given
  const computedHash = file_hash || (body ? crypto.createHash('sha256').update(body).digest('hex') : null);

  const itemData = {
    author_id: ctx.state.user.id,
    title,
    body,
    content_type,
    file_type,
    file_size,
    file_hash: computedHash,
    topic,
    tags: tags ? JSON.stringify(tags) : '[]',
    metadata: metadata ? JSON.stringify(metadata) : '{}',
    status: 'pending_review',
  };

  // Run pre-screening
  const screening = await preScreenContent(itemData);

  const [item] = await db('content_items').insert(itemData).returning('*');

  // If pre-screening fails, auto-create moderation case
  if (!screening.passed) {
    await db('moderation_cases').insert({
      content_item_id: item.id,
      violation_category: screening.violations[0]?.category,
      description: 'Auto-flagged by pre-screening',
      auto_screening_results: JSON.stringify(screening),
    });
  }

  ctx.status = 201;
  ctx.body = { item, screening };
});

// Dynamic /:id routes AFTER all static paths
router.get('/:id', authenticate(), async (ctx) => {
  const item = await db('content_items').where('id', ctx.params.id).first();
  if (!item) throw Errors.notFound('Content item not found');
  await enforceContentACL(ctx, ctx.params.id, 'read');
  ctx.body = item;
});

router.put('/:id', authenticate(), async (ctx) => {
  const item = await db('content_items').where('id', ctx.params.id).first();
  if (!item) throw Errors.notFound('Content item not found');
  await enforceContentACL(ctx, ctx.params.id, 'edit');
  if (item.author_id !== ctx.state.user.id) {
    // Check permission-based authorization for non-authors
    const userPerms = await db('user_roles')
      .join('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('user_roles.user_id', ctx.state.user.id)
      .pluck('permissions.name');
    if (!userPerms.includes('content.moderate')) {
      throw Errors.forbidden();
    }
  }

  const { title, body, topic, tags, status, metadata } = ctx.request.body;
  const updates = { updated_at: new Date() };
  if (title !== undefined) updates.title = title;
  if (body !== undefined) updates.body = body;
  if (topic !== undefined) updates.topic = topic;
  if (tags !== undefined) updates.tags = JSON.stringify(tags);
  if (status !== undefined) updates.status = status;
  if (metadata !== undefined) updates.metadata = JSON.stringify(metadata);

  const [updated] = await db('content_items').where('id', ctx.params.id).update(updates).returning('*');

  await ctx.audit({
    action: 'content_item.update',
    resourceType: 'content_item',
    resourceId: ctx.params.id,
    beforeState: item,
    afterState: updated,
  });

  ctx.body = updated;
});

router.delete('/:id', authenticate(), requirePermission('content.moderate'), async (ctx) => {
  const item = await db('content_items').where('id', ctx.params.id).first();
  if (!item) throw Errors.notFound('Content item not found');
  await enforceContentACL(ctx, ctx.params.id, 'delete');

  await db('content_items').where('id', ctx.params.id).del();

  await ctx.audit({
    action: 'content_item.delete',
    resourceType: 'content_item',
    resourceId: ctx.params.id,
    beforeState: item,
  });

  ctx.status = 204;
});

module.exports = router;
