const Router = require('koa-router');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const db = require('../db/connection');
const config = require('../config');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { writeAuditLog } = require('../middleware/audit');
const { encryptField, decryptField } = require('../utils/fieldEncryption');

// Sensitive user fields encrypted at rest
const SENSITIVE_FIELDS = ['password_hash'];

const router = new Router({ prefix: '/api/auth' });

// ── Register ────────────────────────────────────────────────────────────
router.post('/register', async (ctx) => {
  const { username, email, password, full_name } = ctx.request.body;

  if (!username || !email || !password) {
    throw Errors.badRequest('username, email, and password are required');
  }
  if (password.length < config.password.minLength) {
    throw Errors.badRequest(`Password must be at least ${config.password.minLength} characters`);
  }

  const existing = await db('users')
    .where('username', username)
    .orWhere('email', email)
    .first();
  if (existing) {
    throw Errors.conflict('Username or email already exists');
  }

  const password_hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const [user] = await db('users')
    .insert({ username, email, password_hash: encryptField(password_hash), full_name })
    .returning(['id', 'username', 'email', 'full_name', 'created_at']);

  // Assign default Participant role
  const participantRole = await db('roles').where('name', 'Participant').first();
  if (participantRole) {
    await db('user_roles').insert({ user_id: user.id, role_id: participantRole.id });
  }

  await writeAuditLog({
    actorId: user.id,
    action: 'user.register',
    resourceType: 'user',
    resourceId: user.id,
    afterState: { id: user.id, username: user.username, email: user.email, created_at: user.created_at },
    details: { username, email },
  });

  const token = jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  ctx.status = 201;
  ctx.body = { user, token };
});

// ── Login ───────────────────────────────────────────────────────────────
router.post('/login', async (ctx) => {
  const { username, password } = ctx.request.body;
  if (!username || !password) {
    throw Errors.badRequest('username and password are required');
  }

  const user = await db('users').where('username', username).first();
  if (!user) throw Errors.unauthorized('Invalid credentials');

  // Check lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const remaining = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    throw Errors.locked(`Account locked. Try again in ${remaining} minutes.`);
  }

  // Reject deactivated accounts
  if (user.is_active === false) {
    throw Errors.forbidden('Account is deactivated');
  }

  const storedHash = decryptField(user.password_hash);
  const valid = await argon2.verify(storedHash, password);
  if (!valid) {
    const attempts = user.failed_login_attempts + 1;
    const updates = { failed_login_attempts: attempts };

    if (attempts >= config.password.maxFailedAttempts) {
      updates.locked_until = new Date(
        Date.now() + config.password.lockoutMinutes * 60 * 1000
      );
      updates.failed_login_attempts = 0;
    }

    const beforeState = {
      id: user.id,
      failed_login_attempts: user.failed_login_attempts,
      locked_until: user.locked_until,
    };
    await db('users').where('id', user.id).update(updates);
    const afterState = { id: user.id, ...updates };

    await writeAuditLog({
      actorId: user.id,
      action: 'user.login_failed',
      resourceType: 'user',
      resourceId: user.id,
      beforeState,
      afterState,
      details: { attempts },
    });

    throw Errors.unauthorized('Invalid credentials');
  }

  // Reset on success
  const loginBeforeState = {
    id: user.id,
    failed_login_attempts: user.failed_login_attempts,
    locked_until: user.locked_until,
    last_login_at: user.last_login_at,
  };
  const loginAt = new Date();
  await db('users').where('id', user.id).update({
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: loginAt,
  });

  // Fetch roles
  const roles = await db('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', user.id)
    .pluck('roles.name');

  const token = jwt.sign(
    { id: user.id, username: user.username, email: user.email, roles },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  await writeAuditLog({
    actorId: user.id,
    action: 'user.login',
    resourceType: 'user',
    resourceId: user.id,
    beforeState: loginBeforeState,
    afterState: { id: user.id, failed_login_attempts: 0, locked_until: null, last_login_at: loginAt },
  });

  ctx.body = {
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      full_name: user.full_name,
      roles,
    },
    token,
  };
});

// ── Get current user profile ────────────────────────────────────────────
router.get('/me', authenticate(), async (ctx) => {
  const user = await db('users')
    .where('id', ctx.state.user.id)
    .select('id', 'username', 'email', 'full_name', 'profile', 'created_at', 'updated_at')
    .first();
  if (!user) throw Errors.notFound('User not found');

  const roles = await db('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', user.id)
    .pluck('roles.name');

  ctx.body = { ...user, roles };
});

// ── Update profile ──────────────────────────────────────────────────────
router.put('/me', authenticate(), async (ctx) => {
  const { full_name, profile } = ctx.request.body;
  const updates = { updated_at: new Date() };
  if (full_name !== undefined) updates.full_name = full_name;
  if (profile !== undefined) updates.profile = JSON.stringify(profile);

  const before = await db('users').where('id', ctx.state.user.id).first();

  const [user] = await db('users')
    .where('id', ctx.state.user.id)
    .update(updates)
    .returning(['id', 'username', 'email', 'full_name', 'profile', 'updated_at']);

  await ctx.audit({
    action: 'user.update_profile',
    resourceType: 'user',
    resourceId: user.id,
    beforeState: before,
    afterState: user,
  });

  ctx.body = user;
});

// ── Change password ─────────────────────────────────────────────────────
router.post('/change-password', authenticate(), async (ctx) => {
  const { current_password, new_password } = ctx.request.body;
  if (!current_password || !new_password) {
    throw Errors.badRequest('current_password and new_password are required');
  }
  if (new_password.length < config.password.minLength) {
    throw Errors.badRequest(`Password must be at least ${config.password.minLength} characters`);
  }

  const user = await db('users').where('id', ctx.state.user.id).first();
  const storedHash = decryptField(user.password_hash);
  const valid = await argon2.verify(storedHash, current_password);
  if (!valid) throw Errors.unauthorized('Current password is incorrect');

  const password_hash = await argon2.hash(new_password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  await db('users').where('id', user.id).update({
    password_hash: encryptField(password_hash),
    updated_at: new Date(),
  });

  await ctx.audit({
    action: 'user.change_password',
    resourceType: 'user',
    resourceId: user.id,
    afterState: { id: user.id, password_changed: true },
  });

  ctx.body = { message: 'Password changed successfully' };
});

module.exports = router;
