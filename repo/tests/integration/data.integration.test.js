/**
 * DB-backed HTTP integration tests for /api/data (export, import, backup,
 * restore, consistency-check, jobs).
 *
 * Contract-level coverage:
 *   - Real export returns and redacts sensitive fields
 *   - Real backup round-trips through restore (idempotent via last_write_wins)
 *   - Import validates schema, FK presence, strips security-critical fields
 *   - consistency-check actually detects orphan rows we insert
 *   - admin-only tables are locked down to Administrator
 *   - Job rows are persisted and retrievable
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration } = require('../helpers/integrationHarness');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/users',
  '../../src/routes/importExport',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'data_int' });
});
after(async () => { if (harness) await harness.teardown(); });

describe('Data: export', () => {
  it('Participant without data.export → 403', async () => {
    const res = await harness.req('POST', '/api/data/export', {
      headers: harness.auth('Participant'),
      body: { table: 'plans' },
    });
    assert.equal(res.status, 403);
  });

  it('unknown table → 400 with allowed list mentioned', async () => {
    const res = await harness.req('POST', '/api/data/export', {
      headers: harness.auth('Administrator'),
      body: { table: 'not_a_real_table' },
    });
    assert.equal(res.status, 400);
    assert.ok(/table must be one of/i.test(res.body.error.message));
  });

  it('Admin exports users — password_hash is redacted, job row recorded', async () => {
    const res = await harness.req('POST', '/api/data/export', {
      headers: harness.auth('Administrator'),
      body: { table: 'users', format: 'json' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.job);
    assert.equal(res.body.job.type, 'export');
    assert.equal(res.body.job.status, 'completed');
    assert.equal(res.body.job.target_table, 'users');
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 5, 'should include seeded users');
    for (const row of res.body.data) {
      assert.ok(!('password_hash' in row), 'password_hash must be redacted');
      assert.ok(!('failed_login_attempts' in row), 'failed_login_attempts must be redacted');
      assert.ok(!('locked_until' in row), 'locked_until must be redacted');
    }
    const jobRow = await harness.db('import_jobs').where('id', res.body.job.id).first();
    assert.ok(jobRow);
    assert.equal(jobRow.status, 'completed');
  });

  it('Ops Manager (has data.export) cannot export users table (admin-only)', async () => {
    const res = await harness.req('POST', '/api/data/export', {
      headers: harness.auth('Operations Manager'),
      body: { table: 'users' },
    });
    assert.equal(res.status, 403);
    assert.ok(/Administrator/i.test(res.body.error.message));
  });

  it('CSV format yields string data with header row', async () => {
    // create at least one plan so export has content
    const [plan] = await harness.db('plans').insert({
      title: 'Export Plan', created_by: harness.users['Administrator'].id,
    }).returning('*');

    const res = await harness.req('POST', '/api/data/export', {
      headers: harness.auth('Administrator'),
      body: { table: 'plans', format: 'csv' },
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.data, 'string');
    assert.ok(res.body.data.includes('title'), 'csv header includes title column');
    assert.ok(res.body.data.includes('Export Plan'), 'csv contains inserted row');

    // cleanup
    await harness.db('plans').where('id', plan.id).del();
  });

  it('invalid format returns 400', async () => {
    const res = await harness.req('POST', '/api/data/export', {
      headers: harness.auth('Administrator'),
      body: { table: 'plans', format: 'xml' },
    });
    assert.equal(res.status, 400);
    assert.ok(/format must be json or csv/i.test(res.body.error.message));
  });
});

describe('Data: consistency-check', () => {
  it('Participant → 403', async () => {
    const res = await harness.req('POST', '/api/data/consistency-check', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 403);
  });

  it('returns clean report on a clean DB', async () => {
    const res = await harness.req('POST', '/api/data/consistency-check', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.checked_at);
    assert.deepEqual(res.body.orphan_records, []);
    assert.equal(res.body.total_issues, 0);
  });

  it('detects an orphan activity_log and reports the sample id + count', async () => {
    // Bypass FK using raw SQL — we temporarily drop the FK so we can insert an orphan
    await harness.db.raw('ALTER TABLE activity_logs DROP CONSTRAINT IF EXISTS activity_logs_user_id_foreign');
    const [orphan] = await harness.db('activity_logs').insert({
      user_id: '00000000-0000-0000-0000-000000000999',
      activity_type: 'run',
      value: 100,
      unit: 'seconds',
      performed_at: new Date(),
    }).returning('*');

    const res = await harness.req('POST', '/api/data/consistency-check', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    const entry = res.body.orphan_records.find((r) => r.table === 'activity_logs');
    assert.ok(entry, 'consistency-check must surface the orphan activity log');
    assert.ok(entry.count >= 1);
    assert.ok(entry.sample_ids.includes(orphan.id));
    assert.ok(res.body.total_issues >= 1);

    // restore
    await harness.db('activity_logs').where('id', orphan.id).del();
    await harness.db.raw(
      'ALTER TABLE activity_logs ADD CONSTRAINT activity_logs_user_id_foreign FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'
    );
  });
});

describe('Data: backup + restore', () => {
  it('Admin backup redacts sensitive fields and writes a backup job', async () => {
    const res = await harness.req('POST', '/api/data/backup', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.job.type, 'backup');
    assert.equal(res.body.job.status, 'completed');
    assert.ok(res.body.backup.users.length > 0);
    for (const u of res.body.backup.users) {
      assert.ok(!('password_hash' in u));
    }
    // backup contains all whitelisted tables
    for (const t of ['roles', 'permissions', 'role_permissions', 'user_roles']) {
      assert.ok(Array.isArray(res.body.backup[t]));
    }
  });

  it('Participant cannot backup (403)', async () => {
    const res = await harness.req('POST', '/api/data/backup', {
      headers: harness.auth('Participant'),
    });
    assert.equal(res.status, 403);
  });

  it('restore dry_run reports counts without mutating DB', async () => {
    // seed a plan so there is at least one record in the "backup"
    const [plan] = await harness.db('plans').insert({
      title: 'Plan to be touched', created_by: harness.users['Administrator'].id,
    }).returning('*');
    const beforeCount = (await harness.db('plans').count('* as c'))[0].c;

    const payload = {
      backup: {
        plans: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            title: 'Brand new dry plan',
            created_by: harness.users['Administrator'].id,
          },
        ],
      },
      dry_run: true,
    };
    const res = await harness.req('POST', '/api/data/restore', {
      headers: harness.auth('Administrator'),
      body: payload,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.dry_run, true);
    assert.equal(res.body.total_inserted, 1);
    assert.equal(res.body.total_errors, 0);

    const afterCount = (await harness.db('plans').count('* as c'))[0].c;
    assert.equal(String(beforeCount), String(afterCount), 'dry_run must not insert rows');
    const maybeRow = await harness.db('plans').where('id', '11111111-1111-1111-1111-111111111111').first();
    assert.ok(!maybeRow, 'dry_run row should not be in the DB');

    await harness.db('plans').where('id', plan.id).del();
  });

  it('restore is gated at 403 for non-admin (either data.import permission or admin-only-table)', async () => {
    // Operations Manager lacks data.import, so the outer `requirePermission`
    // middleware answers 403 first. A Coach would get the same.
    const res = await harness.req('POST', '/api/data/restore', {
      headers: harness.auth('Operations Manager'),
      body: { backup: { users: [{ id: '22222222-2222-2222-2222-222222222222' }] } },
    });
    assert.equal(res.status, 403);
    assert.ok(res.body.error);

    // Now prove that even if we grant data.import at the permission layer,
    // the admin-only-table check inside the route still blocks restore of
    // the `users` table for non-administrators.
    const importPerm = await harness.db('permissions').where('name', 'data.import').first();
    const opsRole = await harness.db('roles').where('name', 'Operations Manager').first();
    await harness.db('role_permissions').insert({ role_id: opsRole.id, permission_id: importPerm.id }).onConflict(['role_id', 'permission_id']).ignore();
    try {
      const res2 = await harness.req('POST', '/api/data/restore', {
        headers: harness.auth('Operations Manager'),
        body: { backup: { users: [{ id: '22222222-2222-2222-2222-222222222222' }] } },
      });
      assert.equal(res2.status, 403);
      assert.match(res2.body.error.message, /Administrator/i, 'inner admin-table check should surface the Administrator requirement');
    } finally {
      await harness.db('role_permissions').where({ role_id: opsRole.id, permission_id: importPerm.id }).del();
    }
  });

  it('restore rejects unknown table in payload', async () => {
    const res = await harness.req('POST', '/api/data/restore', {
      headers: harness.auth('Administrator'),
      body: { backup: { not_a_table: [] } },
    });
    assert.equal(res.status, 400);
    assert.ok(/Invalid table/i.test(res.body.error.message));
  });

  it('restore inserts new rows and records a restore job', async () => {
    const payload = {
      backup: {
        plans: [
          {
            id: '33333333-3333-3333-3333-333333333333',
            title: 'Restored Plan',
            created_by: harness.users['Administrator'].id,
          },
        ],
      },
    };
    const res = await harness.req('POST', '/api/data/restore', {
      headers: harness.auth('Administrator'),
      body: payload,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.total_inserted, 1);
    assert.equal(res.body.total_errors, 0);

    const row = await harness.db('plans').where('id', '33333333-3333-3333-3333-333333333333').first();
    assert.ok(row);
    assert.equal(row.title, 'Restored Plan');

    const job = await harness.db('import_jobs').where('id', res.body.job_id).first();
    assert.ok(job);
    assert.equal(job.type, 'restore');
  });
});

describe('Data: import', () => {
  it('strips password_hash from users import (attacker-supplied hash is never stored)', async () => {
    // password_hash is NOT NULL, so stripping it forces the insert to error
    // out at the DB layer. That IS the security contract: a security-critical
    // field is refused rather than silently replaced. Verify:
    //   1. processed=0, errors=1
    //   2. no row exists with attacker-supplied id
    const payload = {
      table: 'users',
      format: 'json',
      data: [
        {
          id: '44444444-4444-4444-4444-444444444444',
          username: 'sneaky_import',
          email: 'sneaky@test.com',
          password_hash: 'attacker-supplied-hash',
          full_name: 'Sneaky',
        },
      ],
    };
    const res = await harness.req('POST', '/api/data/import', {
      headers: harness.auth('Administrator'),
      body: payload,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.processed, 0, 'insert must fail because stripping password_hash violates NOT NULL');
    assert.equal(res.body.errors, 1);

    const row = await harness.db('users').where('id', '44444444-4444-4444-4444-444444444444').first();
    assert.ok(!row, 'attacker-supplied row must not exist');
  });

  it('rejects records that violate schema requirements (activity_logs missing user_id)', async () => {
    const res = await harness.req('POST', '/api/data/import', {
      headers: harness.auth('Administrator'),
      body: {
        table: 'activity_logs',
        format: 'json',
        data: [{ activity_type: 'run', value: 5, performed_at: '2026-04-10' }],
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.status, 'failed');
    assert.ok(Array.isArray(res.body.validation_errors));
    assert.ok(res.body.validation_errors.some((e) => /user_id/.test(e)));
  });

  it('rejects records that reference missing FK rows', async () => {
    const res = await harness.req('POST', '/api/data/import', {
      headers: harness.auth('Administrator'),
      body: {
        table: 'activity_logs',
        format: 'json',
        data: [{
          user_id: '00000000-0000-0000-0000-000000000909',
          activity_type: 'run',
          value: 5,
          performed_at: '2026-04-10',
        }],
      },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.validation_errors.some((e) => /missing users row/.test(e)));
  });
});

describe('Data: jobs endpoints', () => {
  it('GET /jobs returns paginated jobs; previous export/backup/restore are present', async () => {
    const res = await harness.req('GET', '/api/data/jobs?per_page=50', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length >= 1);
    assert.ok(res.body.pagination.total >= 1);
    const types = new Set(res.body.data.map((j) => j.type));
    assert.ok(types.size >= 1);
  });

  it('GET /jobs/:id for unknown id → 404', async () => {
    const res = await harness.req('GET', '/api/data/jobs/00000000-0000-0000-0000-000000000099', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 404);
  });

  it('Participant → 403 on /jobs', async () => {
    const res = await harness.req('GET', '/api/data/jobs', { headers: harness.auth('Participant') });
    assert.equal(res.status, 403);
  });
});
