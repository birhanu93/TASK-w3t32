/**
 * Shared no-mock integration test harness.
 *
 * Spins up a real PostgreSQL-backed Koa app: runs migrations, seeds the full
 * role/permission matrix, creates a user per role, and exposes HTTP request
 * helpers plus direct DB access so tests can assert DB side-effects.
 *
 * Every new integration suite should build on this helper — it keeps the
 * rollback/migrate/seed setup in one place and guarantees the same role
 * layout as production so tests exercise real RBAC paths.
 *
 * Required env:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD  (defaults to localhost / training_assessment_test)
 *   or TEST_DATABASE_URL
 */

const http = require('http');
const jwt = require('jsonwebtoken');
const knex = require('knex');
const argon2 = require('argon2');
const config = require('../../src/config');

function buildDb() {
  const connection = process.env.TEST_DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'training_assessment_test',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };
  return knex({
    client: 'pg',
    connection,
    pool: { min: 1, max: 5 },
    migrations: {
      directory: __dirname + '/../../src/db/migrations',
      tableName: 'knex_migrations',
    },
  });
}

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

const ALL_PERMISSIONS = [
  ...new Set(Object.values(ROLE_PERMISSIONS).flat()),
];

function makeToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, roles: user.roles || [] },
    config.jwt.secret,
    { expiresIn: '1h' }
  );
}

function makeExpiredToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email, roles: user.roles || [] },
    config.jwt.secret,
    { expiresIn: '-1s' }
  );
}

/**
 * Build a fresh Koa app with the provided routes mounted.
 * Re-requires middleware/routes after pointing require.cache at the test db
 * so the real code runs against the integration database.
 */
function buildApp({ db, routeModules }) {
  const Koa = require('koa');
  const bodyParser = require('koa-bodyparser');
  const json = require('koa-json');

  const connPath = require.resolve('../../src/db/connection');
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: db };

  const modulesToClear = [
    '../../src/middleware/auth',
    '../../src/middleware/rbac',
    '../../src/middleware/audit',
    '../../src/middleware/errorHandler',
    '../../src/services/assessmentEngine',
    ...routeModules,
  ];
  for (const p of modulesToClear) {
    try {
      delete require.cache[require.resolve(p)];
    } catch {
      // module may not be on disk yet — ignore
    }
  }

  const errorHandler = require('../../src/middleware/errorHandler');
  const { auditMiddleware } = require('../../src/middleware/audit');

  const app = new Koa();
  app.use(errorHandler());
  app.use(bodyParser({ jsonLimit: '10mb' }));
  app.use(json());
  app.use(auditMiddleware());

  for (const routePath of routeModules) {
    const router = require(routePath);
    app.use(router.routes());
    app.use(router.allowedMethods());
  }
  return app;
}

async function request(server, method, path, { body, headers = {} } = {}) {
  const port = server.address().port;
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`http://localhost:${port}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, body: data };
}

/**
 * Full-stack bootstrap: migrates, seeds roles/permissions, creates one user per
 * role, mounts the requested routes on an HTTP server, and returns handles
 * to the live pieces.
 *
 * Every user is created with the same real argon2 hash for the provided
 * password, so login-path tests can exercise the genuine hash verify code
 * path without mocks.
 */
async function setupIntegration({ routeModules, prefix = 'int', password = 'IntegrationPass1!' }) {
  const db = buildDb();
  await db.migrate.rollback(undefined, true);
  await db.migrate.latest();

  const roleNames = ['Administrator', 'Operations Manager', 'Coach', 'Reviewer', 'Participant'];
  const roles = {};
  for (const name of roleNames) {
    const [row] = await db('roles').insert({ name }).returning('*');
    roles[name] = row;
  }

  const perms = {};
  for (const name of ALL_PERMISSIONS) {
    const [row] = await db('permissions').insert({ name }).returning('*');
    perms[name] = row;
  }

  for (const [roleName, permNames] of Object.entries(ROLE_PERMISSIONS)) {
    for (const p of permNames) {
      await db('role_permissions').insert({ role_id: roles[roleName].id, permission_id: perms[p].id });
    }
  }

  // Real argon2 hash so login actually works
  const { encryptField } = require('../../src/utils/fieldEncryption');
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
  const encryptedHash = encryptField(passwordHash);

  const usernameByRole = {
    Administrator: `${prefix}_admin`,
    'Operations Manager': `${prefix}_ops`,
    Coach: `${prefix}_coach`,
    Reviewer: `${prefix}_reviewer`,
    Participant: `${prefix}_participant`,
  };

  const users = {};
  for (const roleName of roleNames) {
    const username = usernameByRole[roleName];
    const [row] = await db('users')
      .insert({
        username,
        email: `${username}@test.com`,
        password_hash: encryptedHash,
        full_name: `${roleName} User`,
      })
      .returning('*');
    await db('user_roles').insert({ user_id: row.id, role_id: roles[roleName].id });
    users[roleName] = { ...row, roles: [roleName] };
  }

  const tokens = {};
  for (const [roleName, user] of Object.entries(users)) {
    tokens[roleName] = makeToken(user);
  }

  const app = buildApp({ db, routeModules });
  const server = http.createServer(app.callback());
  await new Promise((r) => server.listen(0, r));

  async function teardown() {
    if (server) server.close();
    await db.migrate.rollback(undefined, true);
    await db.destroy();
  }

  function auth(role) {
    return { Authorization: `Bearer ${tokens[role]}` };
  }

  return {
    db,
    server,
    users,
    tokens,
    roles,
    perms,
    password,
    auth,
    teardown,
    req: (method, path, opts) => request(server, method, path, opts),
  };
}

module.exports = {
  buildDb,
  buildApp,
  request,
  makeToken,
  makeExpiredToken,
  setupIntegration,
  ROLE_PERMISSIONS,
  ALL_PERMISSIONS,
};
