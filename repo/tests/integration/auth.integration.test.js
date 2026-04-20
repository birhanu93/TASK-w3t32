/**
 * DB-backed HTTP integration tests for auth + users endpoints.
 *
 * Covers the full auth surface with contract-level assertions:
 *   - Request payload effects (DB row created/updated)
 *   - Response schema fields (shape, required keys, redactions)
 *   - DB side-effects (audit rows, user_roles, failed_login_attempts, lockouts)
 *   - Auth/permission boundaries (unauthenticated, wrong role, own resource)
 *   - Negative-path error payloads (validation, conflict, not found)
 *
 * No mocks: real argon2, real Koa + middleware, real PostgreSQL via Knex.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration, makeToken, makeExpiredToken } = require('../helpers/integrationHarness');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/users',
  '../../src/routes/audit',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'auth_int' });
});
after(async () => { if (harness) await harness.teardown(); });

describe('Auth: /register', () => {
  it('creates a user, returns redacted body, JWT token, and writes audit row', async () => {
    const body = {
      username: 'newcomer',
      email: 'newcomer@test.com',
      password: 'Newc0merPass1!',
      full_name: 'Fresh Newcomer',
    };
    const res = await harness.req('POST', '/api/auth/register', { body });

    assert.equal(res.status, 201);
    // Response schema
    assert.ok(res.body.user, 'should return user object');
    assert.equal(res.body.user.username, 'newcomer');
    assert.equal(res.body.user.email, 'newcomer@test.com');
    assert.equal(res.body.user.full_name, 'Fresh Newcomer');
    assert.ok(res.body.user.id, 'should return id');
    assert.ok(res.body.user.created_at, 'should return created_at');
    assert.ok(!('password_hash' in res.body.user), 'password_hash must never be returned');
    assert.ok(typeof res.body.token === 'string' && res.body.token.length > 20, 'should return JWT token');

    // Token is valid and decodable with the server secret
    const decoded = jwt.verify(res.body.token, config.jwt.secret);
    assert.equal(decoded.id, res.body.user.id);
    assert.equal(decoded.username, 'newcomer');

    // DB side-effects: user row + Participant role + audit row
    const dbUser = await harness.db('users').where('id', res.body.user.id).first();
    assert.ok(dbUser, 'user row created');
    assert.equal(dbUser.username, 'newcomer');
    assert.ok(dbUser.password_hash.length > 20, 'password hash stored (encrypted)');
    assert.notEqual(dbUser.password_hash, 'Newc0merPass1!', 'password not stored in plaintext');

    const userRoles = await harness.db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', res.body.user.id)
      .pluck('roles.name');
    assert.deepEqual(userRoles, ['Participant'], 'new user should get Participant role by default');

    const auditRows = await harness.db('audit_logs')
      .where({ action: 'user.register', resource_id: res.body.user.id });
    assert.equal(auditRows.length, 1, 'exactly one register audit row');
    assert.ok(auditRows[0].after_hash, 'register audit must have after_hash');
  });

  it('rejects short password with 400 and explicit message', async () => {
    const res = await harness.req('POST', '/api/auth/register', {
      body: { username: 'shortpw', email: 'short@test.com', password: 'abc', full_name: 'S' },
    });
    assert.equal(res.status, 400);
    assert.ok(/at least/.test(res.body.error.message), 'should mention min length');
    const dbUser = await harness.db('users').where('username', 'shortpw').first();
    assert.ok(!dbUser, 'no user row should be created on validation failure');
  });

  it('rejects missing required fields with 400', async () => {
    const res = await harness.req('POST', '/api/auth/register', {
      body: { username: 'onlyname' },
    });
    assert.equal(res.status, 400);
    assert.ok(/required/i.test(res.body.error.message));
  });

  it('returns 409 when username or email already exists', async () => {
    await harness.req('POST', '/api/auth/register', {
      body: { username: 'dup', email: 'dup@test.com', password: 'DupPassword123!', full_name: 'Dup' },
    });
    const res = await harness.req('POST', '/api/auth/register', {
      body: { username: 'dup', email: 'different@test.com', password: 'DupPassword123!', full_name: 'Dup2' },
    });
    assert.equal(res.status, 409);
    assert.ok(/already exists/i.test(res.body.error.message));
  });
});

describe('Auth: /login', () => {
  it('returns user with roles + JWT on correct credentials, resets failed attempts', async () => {
    const res = await harness.req('POST', '/api/auth/login', {
      body: { username: 'auth_int_admin', password: harness.password },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'auth_int_admin');
    assert.deepEqual(res.body.user.roles, ['Administrator']);
    assert.ok(!('password_hash' in res.body.user), 'password_hash never exposed');
    const decoded = jwt.verify(res.body.token, config.jwt.secret);
    assert.equal(decoded.username, 'auth_int_admin');
    assert.ok(Array.isArray(decoded.roles) && decoded.roles.includes('Administrator'));

    const dbUser = await harness.db('users').where('username', 'auth_int_admin').first();
    assert.equal(dbUser.failed_login_attempts, 0);
    assert.ok(dbUser.last_login_at, 'last_login_at updated');
    assert.equal(dbUser.locked_until, null);
  });

  it('returns 401 + increments failed_login_attempts on wrong password', async () => {
    const before = await harness.db('users').where('username', 'auth_int_coach').first();
    const res = await harness.req('POST', '/api/auth/login', {
      body: { username: 'auth_int_coach', password: 'WrongPassword123!' },
    });
    assert.equal(res.status, 401);
    assert.ok(/invalid credentials/i.test(res.body.error.message));
    const after = await harness.db('users').where('username', 'auth_int_coach').first();
    assert.equal(after.failed_login_attempts, before.failed_login_attempts + 1);

    const audit = await harness.db('audit_logs')
      .where({ action: 'user.login_failed', actor_id: after.id })
      .orderBy('created_at', 'desc')
      .first();
    assert.ok(audit, 'login_failed audit row written');
    assert.ok(audit.before_hash || audit.after_hash, 'login_failed audit must have hash');
  });

  it('locks account after N failed attempts and returns 423 thereafter', async () => {
    // Use a fresh user so we do not pollute other tests
    await harness.req('POST', '/api/auth/register', {
      body: { username: 'lockvictim', email: 'lockvictim@test.com', password: 'LockVictim12!', full_name: 'Lock Victim' },
    });
    const maxFails = config.password.maxFailedAttempts;
    for (let i = 0; i < maxFails; i++) {
      await harness.req('POST', '/api/auth/login', {
        body: { username: 'lockvictim', password: 'wrong-pass-xyz' },
      });
    }
    const locked = await harness.db('users').where('username', 'lockvictim').first();
    assert.ok(locked.locked_until && new Date(locked.locked_until) > new Date(), 'locked_until should be set in the future');
    assert.equal(locked.failed_login_attempts, 0, 'attempts reset after lockout');

    const res = await harness.req('POST', '/api/auth/login', {
      body: { username: 'lockvictim', password: 'LockVictim12!' },
    });
    assert.equal(res.status, 423);
    assert.ok(/locked/i.test(res.body.error.message));
  });

  it('returns 403 for deactivated accounts (not the generic invalid-credentials 401)', async () => {
    await harness.req('POST', '/api/auth/register', {
      body: { username: 'deactme', email: 'deactme@test.com', password: 'DeactMe12345!', full_name: 'Deact' },
    });
    await harness.db('users').where('username', 'deactme').update({ is_active: false });
    const res = await harness.req('POST', '/api/auth/login', {
      body: { username: 'deactme', password: 'DeactMe12345!' },
    });
    assert.equal(res.status, 403);
    assert.ok(/deactivated/i.test(res.body.error.message));
  });

  it('returns 401 for unknown username (does NOT reveal account existence)', async () => {
    const res = await harness.req('POST', '/api/auth/login', {
      body: { username: 'never-existed', password: 'anything-at-all' },
    });
    assert.equal(res.status, 401);
    assert.ok(/invalid credentials/i.test(res.body.error.message));
    assert.ok(!/not found/i.test(res.body.error.message), 'must not leak existence');
  });
});

describe('Auth: /me', () => {
  it('returns profile with roles, no password_hash', async () => {
    const res = await harness.req('GET', '/api/auth/me', { headers: harness.auth('Administrator') });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'auth_int_admin');
    assert.deepEqual(res.body.roles, ['Administrator']);
    assert.ok(!('password_hash' in res.body));
  });

  it('rejects missing token with 401', async () => {
    const res = await harness.req('GET', '/api/auth/me');
    assert.equal(res.status, 401);
  });

  it('rejects expired token with 401', async () => {
    const token = makeExpiredToken(harness.users['Participant']);
    const res = await harness.req('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  });

  it('rejects token signed with a different secret with 401', async () => {
    const bogus = jwt.sign({ id: harness.users['Participant'].id }, 'not-the-real-secret', { expiresIn: '1h' });
    const res = await harness.req('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${bogus}` } });
    assert.equal(res.status, 401);
  });

  it('returns 401 when the user in the token has been hard-deleted', async () => {
    const ghost = { id: '00000000-0000-0000-0000-000000000099', username: 'ghost', email: 'ghost@test.com', roles: ['Participant'] };
    const token = makeToken(ghost);
    const res = await harness.req('GET', '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  });
});

describe('Auth: /me update + password change', () => {
  it('updates full_name and profile, does NOT touch username or email', async () => {
    const res = await harness.req('PUT', '/api/auth/me', {
      headers: harness.auth('Participant'),
      body: { full_name: 'Renamed Participant', profile: { bio: 'new bio' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.full_name, 'Renamed Participant');
    // username stays the same
    assert.equal(res.body.username, 'auth_int_participant');
    assert.ok(res.body.profile);
  });

  it('rejects change-password with wrong current_password', async () => {
    const res = await harness.req('POST', '/api/auth/change-password', {
      headers: harness.auth('Reviewer'),
      body: { current_password: 'wrong', new_password: 'SomeNewPass12!' },
    });
    assert.equal(res.status, 401);
    assert.ok(/current password/i.test(res.body.error.message));
  });

  it('rejects change-password when new_password is too short', async () => {
    const res = await harness.req('POST', '/api/auth/change-password', {
      headers: harness.auth('Reviewer'),
      body: { current_password: harness.password, new_password: 'short' },
    });
    assert.equal(res.status, 400);
    assert.ok(/at least/.test(res.body.error.message));
  });

  it('changes password, invalidates old password, accepts new one on login', async () => {
    // Use Coach so we don't break other login tests for other roles
    const newPass = 'BrandNewCoach1!';
    const change = await harness.req('POST', '/api/auth/change-password', {
      headers: harness.auth('Coach'),
      body: { current_password: harness.password, new_password: newPass },
    });
    assert.equal(change.status, 200);
    assert.ok(/changed/i.test(change.body.message));

    const oldLogin = await harness.req('POST', '/api/auth/login', {
      body: { username: 'auth_int_coach', password: harness.password },
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await harness.req('POST', '/api/auth/login', {
      body: { username: 'auth_int_coach', password: newPass },
    });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.user.username, 'auth_int_coach');

    const audit = await harness.db('audit_logs')
      .where({ action: 'user.change_password', actor_id: harness.users['Coach'].id });
    assert.ok(audit.length >= 1, 'change_password audit row written');
    assert.ok(audit[0].after_hash, 'change_password audit has after_hash');
  });
});

describe('Users: role & deactivation (privileged endpoints)', () => {
  let victim;
  before(async () => {
    // Create a stable victim user for role churn
    const [row] = await harness.db('users').insert({
      username: 'role_victim',
      email: 'role_victim@test.com',
      password_hash: 'stub-not-usable-for-login',
      full_name: 'Role Victim',
    }).returning('*');
    victim = row;
  });

  it('Admin can list users, Participant gets 403', async () => {
    const ok = await harness.req('GET', '/api/users', { headers: harness.auth('Administrator') });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.data));
    assert.ok(ok.body.data.length >= 5, 'all seeded users should be visible');
    assert.ok(ok.body.pagination && typeof ok.body.pagination.total === 'number');
    for (const row of ok.body.data) {
      assert.ok(!('password_hash' in row), 'password_hash must never be returned in list');
    }

    const denied = await harness.req('GET', '/api/users', { headers: harness.auth('Participant') });
    assert.equal(denied.status, 403);
  });

  it('Admin assigns a role: DB row written, audit recorded, second assign 409', async () => {
    const res = await harness.req('POST', `/api/users/${victim.id}/roles`, {
      headers: harness.auth('Administrator'),
      body: { role_name: 'Coach' },
    });
    assert.equal(res.status, 201);
    assert.ok(/assigned/i.test(res.body.message));

    const row = await harness.db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', victim.id)
      .where('roles.name', 'Coach')
      .first();
    assert.ok(row, 'user_roles row should exist for Coach');

    const audit = await harness.db('audit_logs')
      .where({ action: 'user.assign_role', resource_id: victim.id })
      .orderBy('created_at', 'desc').first();
    assert.ok(audit, 'audit recorded');
    assert.ok(audit.after_hash, 'assign_role audit must have after_hash');

    const dup = await harness.req('POST', `/api/users/${victim.id}/roles`, {
      headers: harness.auth('Administrator'),
      body: { role_name: 'Coach' },
    });
    assert.equal(dup.status, 409);
  });

  it('Admin removes a role; DELETE endpoint actually removes the DB row', async () => {
    const res = await harness.req('DELETE', `/api/users/${victim.id}/roles/Coach`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    const remaining = await harness.db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', victim.id)
      .where('roles.name', 'Coach').first();
    assert.ok(!remaining, 'role should be removed');
  });

  it('removing a role the user does not have returns 404 (not silent success)', async () => {
    const res = await harness.req('DELETE', `/api/users/${victim.id}/roles/Reviewer`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 404);
  });

  it('assign_role to non-existent role returns 404', async () => {
    const res = await harness.req('POST', `/api/users/${victim.id}/roles`, {
      headers: harness.auth('Administrator'),
      body: { role_name: 'NotARealRole' },
    });
    assert.equal(res.status, 404);
  });

  it('deactivate then activate updates is_active and emits two audit rows', async () => {
    const d = await harness.req('POST', `/api/users/${victim.id}/deactivate`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(d.status, 200);
    let row = await harness.db('users').where('id', victim.id).first();
    assert.equal(row.is_active, false);

    const a = await harness.req('POST', `/api/users/${victim.id}/activate`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(a.status, 200);
    row = await harness.db('users').where('id', victim.id).first();
    assert.equal(row.is_active, true);

    const deactAudit = await harness.db('audit_logs').where({ action: 'user.deactivate', resource_id: victim.id });
    const actAudit = await harness.db('audit_logs').where({ action: 'user.activate', resource_id: victim.id });
    assert.ok(deactAudit.length >= 1);
    assert.ok(actAudit.length >= 1);
  });

  it('Operations Manager lacks users.manage_roles — 403 when trying to assign', async () => {
    const res = await harness.req('POST', `/api/users/${victim.id}/roles`, {
      headers: harness.auth('Operations Manager'),
      body: { role_name: 'Reviewer' },
    });
    assert.equal(res.status, 403);
  });
});

describe('Audit: /api/audit/logs (audit.view-gated)', () => {
  it('Admin can page through audit logs produced by the tests above', async () => {
    const res = await harness.req('GET', '/api/audit/logs?per_page=5&page=1', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length > 0, 'previous auth/user tests must have written audit rows');
    assert.ok(res.body.pagination.total > 0);
    assert.equal(res.body.pagination.page, 1);

    for (const row of res.body.data) {
      assert.ok(row.id && row.action, 'each audit row has id + action');
    }
  });

  it('Participant without audit.view gets 403', async () => {
    const res = await harness.req('GET', '/api/audit/logs', { headers: harness.auth('Participant') });
    assert.equal(res.status, 403);
  });

  it('Admin can filter by action — filter is reflected in response rows', async () => {
    const res = await harness.req('GET', '/api/audit/logs?action=user.register', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    for (const row of res.body.data) {
      assert.ok(row.action.includes('user.register'), `expected user.register, got ${row.action}`);
    }
  });

  it('/api/audit/logs/:id returns 404 for unknown id', async () => {
    const res = await harness.req('GET', '/api/audit/logs/00000000-0000-0000-0000-000000000099', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 404);
  });
});
