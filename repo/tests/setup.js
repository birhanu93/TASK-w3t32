/**
 * Test infrastructure: DB mock, app factory, auth helpers, common fixtures.
 *
 * Every route file does `require('../db/connection')` to get a knex instance.
 * We intercept that with a mock that returns chainable query-builder stubs.
 * This lets us test all routes without a live PostgreSQL connection.
 */

const jwt = require('jsonwebtoken');
const config = require('../src/config');

// ─── Chainable DB Mock ──────────────────────────────────────────────────

/** Build a chainable mock where every method returns `this`, except terminators. */
function createChain(resolveValue) {
  const chain = {};
  const methods = [
    'where', 'whereNot', 'whereIn', 'whereNotNull', 'whereNull',
    'orWhere', 'orWhereIn', 'andWhere',
    'join', 'leftJoin',
    'select', 'pluck', 'count', 'countDistinct', 'distinctOn',
    'orderBy', 'groupBy',
    'offset', 'limit',
    'clone', 'insert', 'update', 'del', 'delete', 'returning', 'raw',
    'first',
  ];
  for (const m of methods) {
    chain[m] = function () { return chain; };
  }
  // Terminators — return a thenable
  chain.then = (resolve) => resolve(resolveValue);
  chain[Symbol.toStringTag] = 'Promise';
  // Make it awaitable
  chain.catch = () => chain;
  chain.finally = () => chain;
  return chain;
}

/**
 * Creates a mock DB function.
 * `overrides` maps `tableName` to the value the chain should resolve to.
 * Additional per-method overrides can be set via the returned mockDb._methodOverrides.
 */
function createMockDb(overrides = {}) {
  const calls = [];

  const mockDb = function (tableName) {
    calls.push({ table: tableName });
    const defaultVal = overrides[tableName] !== undefined ? overrides[tableName] : [];
    return createChain(defaultVal);
  };

  mockDb.raw = function () {
    return Promise.resolve({ rows: overrides._raw || [] });
  };
  mockDb._calls = calls;
  return mockDb;
}

// ─── Auth Helpers ───────────────────────────────────────────────────────

// Maps roles to their permissions for test mocking
const ROLE_PERMISSIONS = {
  Administrator: [
    'users.list', 'users.read', 'users.manage_roles', 'users.deactivate',
    'plans.create', 'plans.update', 'plans.delete',
    'activity_logs.view_all', 'activity_logs.approve_outlier',
    'assessments.manage_rules', 'assessments.compute_any',
    'rankings.manage_config',
    'content.moderate', 'content.manage_categories', 'content.manage_topics',
    'campaigns.manage', 'campaigns.analytics',
    'messages.send', 'messages.manage_templates', 'messages.broadcast',
    'data.export', 'data.import', 'data.backup', 'data.consistency_check',
    'resources.manage_acl', 'audit.view',
  ],
  'Operations Manager': [
    'users.list', 'users.read',
    'plans.create', 'plans.update',
    'activity_logs.view_all',
    'assessments.manage_rules', 'rankings.manage_config',
    'content.manage_topics',
    'campaigns.manage', 'campaigns.analytics',
    'messages.send', 'messages.manage_templates', 'messages.broadcast',
    'data.export', 'data.consistency_check',
  ],
  Coach: [
    'plans.create', 'plans.update',
    'activity_logs.view_all', 'activity_logs.approve_outlier',
    'assessments.compute_any',
    'messages.send',
  ],
  Reviewer: [
    'content.moderate', 'content.manage_categories',
  ],
  Participant: [],
};

const FIXTURES = {
  adminUser: {
    id: 'a0000000-0000-0000-0000-000000000001',
    username: 'admin',
    email: 'admin@test.com',
    full_name: 'Admin User',
    roles: ['Administrator'],
  },
  opsUser: {
    id: 'a0000000-0000-0000-0000-000000000002',
    username: 'ops',
    email: 'ops@test.com',
    full_name: 'Ops Manager',
    roles: ['Operations Manager'],
  },
  coachUser: {
    id: 'a0000000-0000-0000-0000-000000000003',
    username: 'coach',
    email: 'coach@test.com',
    full_name: 'Coach User',
    roles: ['Coach'],
  },
  reviewerUser: {
    id: 'a0000000-0000-0000-0000-000000000004',
    username: 'reviewer',
    email: 'reviewer@test.com',
    full_name: 'Reviewer User',
    roles: ['Reviewer'],
  },
  participantUser: {
    id: 'a0000000-0000-0000-0000-000000000005',
    username: 'participant',
    email: 'participant@test.com',
    full_name: 'Participant User',
    roles: ['Participant'],
  },
  inactiveUser: {
    id: 'a0000000-0000-0000-0000-000000000006',
    username: 'inactive',
    email: 'inactive@test.com',
    full_name: 'Inactive User',
    roles: ['Participant'],
    is_active: false,
  },
};

function makeToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, roles: user.roles },
    config.jwt.secret,
    { expiresIn: '1h' }
  );
}

function makeExpiredToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    config.jwt.secret,
    { expiresIn: '-1s' }
  );
}

function authHeader(user) {
  return `Bearer ${makeToken(user)}`;
}

/**
 * Get permissions for a user fixture (based on their roles).
 */
function getPermissionsForUser(user) {
  const perms = new Set();
  for (const role of (user.roles || [])) {
    for (const p of (ROLE_PERMISSIONS[role] || [])) {
      perms.add(p);
    }
  }
  return [...perms];
}

module.exports = {
  createChain,
  createMockDb,
  FIXTURES,
  ROLE_PERMISSIONS,
  makeToken,
  makeExpiredToken,
  authHeader,
  getPermissionsForUser,
};
