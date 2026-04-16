const Router = require('koa-router');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/messages' });

// ── Template Rendering ──────────────────────────────────────────────────
/**
 * Render a template with strict placeholder validation.
 * Placeholders: {{placeholder_name}}
 */
function renderTemplate(template, data) {
  const placeholderRegex = /\{\{(\w+)\}\}/g;
  const missingPlaceholders = [];

  const rendered = template.replace(placeholderRegex, (match, key) => {
    if (data[key] === undefined || data[key] === null) {
      missingPlaceholders.push(key);
      return match;
    }
    return String(data[key]);
  });

  if (missingPlaceholders.length > 0) {
    throw Errors.badRequest(`Missing template placeholders: ${missingPlaceholders.join(', ')}`);
  }

  return rendered;
}

// ── Message Templates ───────────────────────────────────────────────────

router.get('/templates', authenticate(), requirePermission('messages.manage_templates'), async (ctx) => {
  const { category, active_only } = ctx.query;
  let query = db('message_templates');
  if (category) query = query.where('category', category);
  if (active_only === 'true') query = query.where('is_active', true);
  ctx.body = await query.orderBy('name').orderBy('version', 'desc');
});

router.post('/templates', authenticate(), requirePermission('messages.manage_templates'), async (ctx) => {
  const { name, category, subject_template, body_template, required_placeholders } = ctx.request.body;

  if (!name || !category || !subject_template || !body_template) {
    throw Errors.badRequest('name, category, subject_template, and body_template are required');
  }

  const validCategories = ['enrollment', 'waitlist', 'schedule', 'score_release'];
  if (!validCategories.includes(category)) {
    throw Errors.badRequest(`category must be one of: ${validCategories.join(', ')}`);
  }

  // Validate template placeholders
  const allPlaceholders = new Set();
  const regex = /\{\{(\w+)\}\}/g;
  let match;
  while ((match = regex.exec(subject_template)) !== null) allPlaceholders.add(match[1]);
  while ((match = regex.exec(body_template)) !== null) allPlaceholders.add(match[1]);

  if (required_placeholders) {
    for (const rp of required_placeholders) {
      if (!allPlaceholders.has(rp)) {
        throw Errors.badRequest(`Required placeholder "{{${rp}}}" not found in templates`);
      }
    }
  }

  // Auto-increment version
  const latest = await db('message_templates').where('name', name).orderBy('version', 'desc').first();
  const version = latest ? latest.version + 1 : 1;

  // Deactivate previous
  await db('message_templates').where({ name, is_active: true }).update({ is_active: false });

  const [tmpl] = await db('message_templates')
    .insert({
      name,
      version,
      category,
      subject_template,
      body_template,
      required_placeholders: required_placeholders ? JSON.stringify(required_placeholders) : '[]',
    })
    .returning('*');

  await ctx.audit({
    action: 'message_template.create',
    resourceType: 'message_template',
    resourceId: tmpl.id,
    afterState: tmpl,
    details: { name, version, category },
  });

  ctx.status = 201;
  ctx.body = tmpl;
});

// ── Send Message (in-app only) ──────────────────────────────────────────
router.post('/send', authenticate(), requirePermission('messages.send'), async (ctx) => {
  const { recipient_id, template_name, data, subject, body } = ctx.request.body;

  if (!recipient_id) throw Errors.badRequest('recipient_id is required');

  // Check subscription preferences
  const sub = await db('subscriptions')
    .where({ user_id: recipient_id })
    .first();

  let finalSubject, finalBody;

  if (template_name) {
    const template = await db('message_templates')
      .where({ name: template_name, is_active: true })
      .first();
    if (!template) throw Errors.notFound(`Active template "${template_name}" not found`);

    // Check subscription for this category
    const categorySub = await db('subscriptions')
      .where({ user_id: recipient_id, category: template.category })
      .first();
    if (categorySub && !categorySub.in_app_enabled) {
      ctx.body = { sent: false, reason: 'User has disabled in-app notifications for this category' };
      return;
    }

    finalSubject = renderTemplate(template.subject_template, data || {});
    finalBody = renderTemplate(template.body_template, data || {});

    const [msg] = await db('messages')
      .insert({
        recipient_id,
        sender_id: ctx.state.user.id,
        template_id: template.id,
        channel: 'in_app',
        subject: finalSubject,
        body: finalBody,
      })
      .returning('*');

    ctx.status = 201;
    ctx.body = msg;
  } else {
    if (!subject || !body) throw Errors.badRequest('subject and body required when not using template');

    const [msg] = await db('messages')
      .insert({
        recipient_id,
        sender_id: ctx.state.user.id,
        channel: 'in_app',
        subject,
        body,
      })
      .returning('*');

    ctx.status = 201;
    ctx.body = msg;
  }
});

// ── Broadcast to multiple recipients ────────────────────────────────────
router.post('/broadcast', authenticate(), requirePermission('messages.broadcast'), async (ctx) => {
  const { recipient_ids, template_name, data, subject, body } = ctx.request.body;
  if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
    throw Errors.badRequest('recipient_ids array is required');
  }

  let template = null;
  if (template_name) {
    template = await db('message_templates').where({ name: template_name, is_active: true }).first();
    if (!template) throw Errors.notFound(`Active template "${template_name}" not found`);
  }

  const sent = [];
  const skipped = [];

  for (const recipientId of recipient_ids) {
    // Check subscription
    if (template) {
      const sub = await db('subscriptions')
        .where({ user_id: recipientId, category: template.category })
        .first();
      if (sub && !sub.in_app_enabled) {
        skipped.push(recipientId);
        continue;
      }
    }

    const finalSubject = template ? renderTemplate(template.subject_template, data || {}) : subject;
    const finalBody = template ? renderTemplate(template.body_template, data || {}) : body;

    const [msg] = await db('messages')
      .insert({
        recipient_id: recipientId,
        sender_id: ctx.state.user.id,
        template_id: template?.id,
        channel: 'in_app',
        subject: finalSubject,
        body: finalBody,
      })
      .returning('*');

    sent.push(msg.id);
  }

  ctx.status = 201;
  ctx.body = { sent: sent.length, skipped: skipped.length, message_ids: sent };
});

// ── Inbox (current user) ───────────────────────────────────────────────
router.get('/inbox', authenticate(), async (ctx) => {
  const { page = 1, per_page = 20, is_read } = ctx.query;
  const offset = (page - 1) * per_page;

  let query = db('messages').where('recipient_id', ctx.state.user.id);
  if (is_read !== undefined) query = query.where('is_read', is_read === 'true');

  const [{ count }] = await query.clone().count();
  const messages = await query.orderBy('created_at', 'desc').offset(offset).limit(per_page);

  // Unread count
  const [{ count: unread }] = await db('messages')
    .where({ recipient_id: ctx.state.user.id, is_read: false })
    .count();

  ctx.body = {
    data: messages,
    unread_count: Number(unread),
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

// ── Read message ────────────────────────────────────────────────────────
router.get('/:id', authenticate(), async (ctx) => {
  const msg = await db('messages').where('id', ctx.params.id).first();
  if (!msg) throw Errors.notFound('Message not found');
  if (msg.recipient_id !== ctx.state.user.id && msg.sender_id !== ctx.state.user.id) {
    throw Errors.forbidden();
  }
  ctx.body = msg;
});

// ── Mark as read ────────────────────────────────────────────────────────
router.post('/:id/read', authenticate(), async (ctx) => {
  const msg = await db('messages').where('id', ctx.params.id).first();
  if (!msg) throw Errors.notFound('Message not found');
  if (msg.recipient_id !== ctx.state.user.id) throw Errors.forbidden();

  if (!msg.is_read) {
    await db('messages').where('id', ctx.params.id).update({ is_read: true, read_at: new Date() });
  }

  ctx.body = { message: 'Marked as read' };
});

// ── Mark all as read ────────────────────────────────────────────────────
router.post('/mark-all-read', authenticate(), async (ctx) => {
  const updated = await db('messages')
    .where({ recipient_id: ctx.state.user.id, is_read: false })
    .update({ is_read: true, read_at: new Date() });

  ctx.body = { marked_read: updated };
});

// ── Subscription Preferences ────────────────────────────────────────────
router.get('/subscriptions/me', authenticate(), async (ctx) => {
  ctx.body = await db('subscriptions').where('user_id', ctx.state.user.id);
});

router.put('/subscriptions', authenticate(), async (ctx) => {
  const { category, in_app_enabled } = ctx.request.body;
  if (!category) throw Errors.badRequest('category is required');

  // email/SMS always disabled in offline mode
  const existing = await db('subscriptions')
    .where({ user_id: ctx.state.user.id, category })
    .first();

  if (existing) {
    const [sub] = await db('subscriptions')
      .where('id', existing.id)
      .update({
        in_app_enabled: in_app_enabled !== undefined ? in_app_enabled : true,
        email_enabled: false,
        sms_enabled: false,
        updated_at: new Date(),
      })
      .returning('*');
    ctx.body = sub;
  } else {
    const [sub] = await db('subscriptions')
      .insert({
        user_id: ctx.state.user.id,
        category,
        in_app_enabled: in_app_enabled !== undefined ? in_app_enabled : true,
        email_enabled: false,
        sms_enabled: false,
      })
      .returning('*');
    ctx.status = 201;
    ctx.body = sub;
  }
});

module.exports = router;
