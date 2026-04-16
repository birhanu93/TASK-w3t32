const Router = require('koa-router');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const Ajv = require('ajv');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');
const { authenticate } = require('../middleware/auth');
const { requireRole, requirePermission } = require('../middleware/rbac');

const router = new Router({ prefix: '/api/data' });
const ajv = new Ajv({ allErrors: true });

// ── Sensitive field protection ──────────────────────────────────────────

// Fields that must NEVER appear in export output
const SENSITIVE_FIELDS = {
  users: ['password_hash', 'failed_login_attempts', 'locked_until'],
};

// Tables that require Administrator role for export/import (contain security data)
const ADMIN_ONLY_TABLES = ['users', 'user_roles', 'role_permissions', 'acl_entries'];

// Fields that must NOT be writable via import (security-critical)
const IMPORT_BLOCKED_FIELDS = {
  users: ['password_hash', 'failed_login_attempts', 'locked_until'],
  user_roles: [], // importing role assignments allowed only for admins (enforced above)
};

function redactSensitiveFields(records, table) {
  const fields = SENSITIVE_FIELDS[table];
  if (!fields || fields.length === 0) return records;
  return records.map((record) => {
    const redacted = { ...record };
    for (const field of fields) {
      delete redacted[field];
    }
    return redacted;
  });
}

function stripBlockedImportFields(records, table) {
  const fields = IMPORT_BLOCKED_FIELDS[table];
  if (!fields || fields.length === 0) return records;
  return records.map((record) => {
    const cleaned = { ...record };
    for (const field of fields) {
      delete cleaned[field];
    }
    return cleaned;
  });
}

async function isAdmin(userId) {
  const roles = await db('user_roles')
    .join('roles', 'roles.id', 'user_roles.role_id')
    .where('user_roles.user_id', userId)
    .pluck('roles.name');
  return roles.includes('Administrator');
}

// Allowed tables for import/export — includes all entity tables
const ALLOWED_TABLES = [
  'users', 'roles', 'permissions', 'role_permissions', 'user_roles',
  'plans', 'plan_enrollments', 'tasks', 'activity_logs', 'assessment_rules',
  'computed_scores', 'rankings', 'ranking_configs', 'certificates', 'content_items',
  'moderation_cases', 'appeals', 'campaigns', 'placements',
  'coupons', 'analytics_events', 'message_templates', 'messages', 'subscriptions',
  'resources', 'acl_entries', 'topics', 'violation_categories',
];

// Foreign key relationships for validation during import
const FK_DEPENDENCIES = {
  user_roles: { user_id: 'users', role_id: 'roles' },
  role_permissions: { role_id: 'roles', permission_id: 'permissions' },
  plan_enrollments: { plan_id: 'plans', user_id: 'users' },
  tasks: { plan_id: 'plans' },
  activity_logs: { user_id: 'users' },
  computed_scores: { user_id: 'users', assessment_rule_id: 'assessment_rules' },
  rankings: { user_id: 'users' },
  certificates: { user_id: 'users' },
  content_items: { author_id: 'users' },
  moderation_cases: { content_item_id: 'content_items' },
  appeals: { moderation_case_id: 'moderation_cases', appellant_id: 'users' },
  messages: { recipient_id: 'users' },
  subscriptions: { user_id: 'users' },
  placements: { campaign_id: 'campaigns' },
  coupons: { campaign_id: 'campaigns' },
  analytics_events: { user_id: 'users' },
  acl_entries: { resource_id: 'resources' },
};

// JSON schemas for validation
const TABLE_SCHEMAS = {
  activity_logs: {
    type: 'object',
    required: ['user_id', 'activity_type', 'value', 'performed_at'],
    properties: {
      user_id: { type: 'string', format: 'uuid' },
      activity_type: { type: 'string' },
      value: { type: 'number' },
      unit: { type: 'string' },
      performed_at: { type: 'string' },
    },
  },
  plans: {
    type: 'object',
    required: ['title', 'created_by'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      created_by: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['draft', 'active', 'completed', 'archived'] },
    },
  },
};

// ── Export ───────────────────────────────────────────────────────────────
router.post('/export', authenticate(), requirePermission('data.export'), async (ctx) => {
  const { table, format = 'json', filters = {} } = ctx.request.body;

  if (!table || !ALLOWED_TABLES.includes(table)) {
    throw Errors.badRequest(`table must be one of: ${ALLOWED_TABLES.join(', ')}`);
  }
  if (!['json', 'csv'].includes(format)) {
    throw Errors.badRequest('format must be json or csv');
  }

  // Admin-only tables require Administrator role
  if (ADMIN_ONLY_TABLES.includes(table) && !(await isAdmin(ctx.state.user.id))) {
    throw Errors.forbidden(`Exporting '${table}' requires Administrator role`);
  }

  let query = db(table);
  if (filters.from) query = query.where('created_at', '>=', filters.from);
  if (filters.to) query = query.where('created_at', '<=', filters.to);
  if (filters.user_id) query = query.where('user_id', filters.user_id);

  let data = await query.orderBy('created_at', 'desc');

  // Redact sensitive fields from export output
  data = redactSensitiveFields(data, table);

  // Create export job record
  const [job] = await db('import_jobs')
    .insert({
      initiated_by: ctx.state.user.id,
      type: 'export',
      format,
      target_table: table,
      status: 'completed',
      total_records: data.length,
      processed_records: data.length,
      started_at: new Date(),
      completed_at: new Date(),
    })
    .returning('*');

  await ctx.audit({
    action: 'data.export',
    resourceType: 'import_job',
    resourceId: job.id,
    afterState: job,
    details: { table, format, record_count: data.length },
  });

  if (format === 'csv') {
    if (data.length === 0) {
      ctx.body = { job, data: '' };
      return;
    }
    const csvData = stringify(data, { header: true });
    ctx.body = { job, data: csvData };
  } else {
    ctx.body = { job, data };
  }
});

// ── Import ──────────────────────────────────────────────────────────────
router.post('/import', authenticate(), requirePermission('data.import'), async (ctx) => {
  const { table, format = 'json', data, conflict_resolution = 'last_write_wins' } = ctx.request.body;

  if (!table || !ALLOWED_TABLES.includes(table)) {
    throw Errors.badRequest(`table must be one of: ${ALLOWED_TABLES.join(', ')}`);
  }
  if (!data) throw Errors.badRequest('data is required');

  // Admin-only tables require Administrator role
  if (ADMIN_ONLY_TABLES.includes(table) && !(await isAdmin(ctx.state.user.id))) {
    throw Errors.forbidden(`Importing into '${table}' requires Administrator role`);
  }

  // Create job
  const [job] = await db('import_jobs')
    .insert({
      initiated_by: ctx.state.user.id,
      type: 'import',
      format,
      target_table: table,
      status: 'validating',
      config: JSON.stringify({ conflict_resolution }),
      started_at: new Date(),
    })
    .returning('*');

  try {
    // Parse data
    let records;
    if (format === 'csv') {
      records = parse(data, { columns: true, skip_empty_lines: true, cast: true });
    } else {
      records = Array.isArray(data) ? data : [data];
    }

    // Strip security-critical fields that must not be importable
    records = stripBlockedImportFields(records, table);

    await db('import_jobs').where('id', job.id).update({ total_records: records.length });

    // Schema validation
    const validationErrors = [];
    const schema = TABLE_SCHEMAS[table];

    if (schema) {
      const validate = ajv.compile({ type: 'array', items: schema });
      if (!validate(records)) {
        validationErrors.push(...validate.errors.map((e) => `${e.instancePath}: ${e.message}`));
      }
    }

    if (validationErrors.length > 0) {
      await db('import_jobs').where('id', job.id).update({
        status: 'failed',
        validation_errors: JSON.stringify(validationErrors),
        completed_at: new Date(),
        updated_at: new Date(),
      });

      ctx.status = 400;
      ctx.body = { job_id: job.id, status: 'failed', validation_errors: validationErrors };
      return;
    }

    // FK validation: check that referenced entities exist
    const fkDeps = FK_DEPENDENCIES[table];
    if (fkDeps) {
      for (const record of records) {
        for (const [fkCol, refTable] of Object.entries(fkDeps)) {
          if (record[fkCol]) {
            const ref = await db(refTable).where('id', record[fkCol]).first();
            if (!ref) {
              validationErrors.push(
                `Record ${record.id || '(new)'}: ${fkCol}=${record[fkCol]} references missing ${refTable} row`
              );
            }
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      await db('import_jobs').where('id', job.id).update({
        status: 'failed',
        validation_errors: JSON.stringify(validationErrors),
        completed_at: new Date(),
        updated_at: new Date(),
      });

      ctx.status = 400;
      ctx.body = { job_id: job.id, status: 'failed', validation_errors: validationErrors };
      return;
    }

    // Process records
    await db('import_jobs').where('id', job.id).update({ status: 'processing' });

    let processed = 0;
    let errors = 0;
    const recordErrors = [];

    for (const record of records) {
      try {
        if (conflict_resolution === 'last_write_wins' && record.id) {
          const existing = await db(table).where('id', record.id).first();
          if (existing) {
            // Last-write-wins: compare updated_at
            if (record.updated_at && existing.updated_at &&
                new Date(record.updated_at) > new Date(existing.updated_at)) {
              await db(table).where('id', record.id).update({
                ...record,
                updated_at: new Date(record.updated_at),
              });
            }
            // else: skip, existing is newer
          } else {
            await db(table).insert(record);
          }
        } else if (conflict_resolution === 'merge_append' && record.id) {
          const existing = await db(table).where('id', record.id).first();
          if (existing) {
            // Merge: append-only for array/jsonb fields
            const updates = {};
            for (const [key, val] of Object.entries(record)) {
              if (key === 'id') continue;
              if (Array.isArray(val) && Array.isArray(existing[key])) {
                updates[key] = JSON.stringify([...existing[key], ...val]);
              } else {
                updates[key] = val;
              }
            }
            await db(table).where('id', record.id).update(updates);
          } else {
            await db(table).insert(record);
          }
        } else {
          await db(table).insert(record);
        }
        processed++;
      } catch (err) {
        errors++;
        recordErrors.push({ record_index: processed + errors - 1, error: err.message });
      }
    }

    await db('import_jobs').where('id', job.id).update({
      status: 'completed',
      processed_records: processed,
      error_records: errors,
      validation_errors: JSON.stringify(recordErrors),
      completed_at: new Date(),
      updated_at: new Date(),
    });

    await ctx.audit({
      action: 'data.import',
      resourceType: 'import_job',
      resourceId: job.id,
      afterState: { job_id: job.id, table, processed, errors },
      details: { table, format, processed, errors },
    });

    ctx.status = 201;
    ctx.body = { job_id: job.id, status: 'completed', processed, errors, record_errors: recordErrors };
  } catch (err) {
    await db('import_jobs').where('id', job.id).update({
      status: 'failed',
      error_message: err.message,
      completed_at: new Date(),
      updated_at: new Date(),
    });
    throw err;
  }
});

// ── Consistency Check ───────────────────────────────────────────────────
router.post('/consistency-check', authenticate(), requirePermission('data.consistency_check'), async (ctx) => {
  const report = {
    checked_at: new Date().toISOString(),
    foreign_key_issues: [],
    orphan_records: [],
  };

  // Check activity_logs → users
  const orphanLogs = await db.raw(`
    SELECT al.id, al.user_id FROM activity_logs al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE u.id IS NULL
    LIMIT 100
  `);
  if (orphanLogs.rows.length > 0) {
    report.orphan_records.push({
      table: 'activity_logs',
      missing_reference: 'users',
      count: orphanLogs.rows.length,
      sample_ids: orphanLogs.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check computed_scores → users
  const orphanScores = await db.raw(`
    SELECT cs.id, cs.user_id FROM computed_scores cs
    LEFT JOIN users u ON u.id = cs.user_id
    WHERE u.id IS NULL
    LIMIT 100
  `);
  if (orphanScores.rows.length > 0) {
    report.orphan_records.push({
      table: 'computed_scores',
      missing_reference: 'users',
      count: orphanScores.rows.length,
      sample_ids: orphanScores.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check messages → users
  const orphanMessages = await db.raw(`
    SELECT m.id, m.recipient_id FROM messages m
    LEFT JOIN users u ON u.id = m.recipient_id
    WHERE u.id IS NULL
    LIMIT 100
  `);
  if (orphanMessages.rows.length > 0) {
    report.orphan_records.push({
      table: 'messages',
      missing_reference: 'users (recipient)',
      count: orphanMessages.rows.length,
      sample_ids: orphanMessages.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check certificates → users
  const orphanCerts = await db.raw(`
    SELECT c.id, c.user_id FROM certificates c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE u.id IS NULL
    LIMIT 100
  `);
  if (orphanCerts.rows.length > 0) {
    report.orphan_records.push({
      table: 'certificates',
      missing_reference: 'users',
      count: orphanCerts.rows.length,
      sample_ids: orphanCerts.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check tasks → plans
  const orphanTasks = await db.raw(`
    SELECT t.id, t.plan_id FROM tasks t
    LEFT JOIN plans p ON p.id = t.plan_id
    WHERE p.id IS NULL
    LIMIT 100
  `);
  if (orphanTasks.rows.length > 0) {
    report.orphan_records.push({
      table: 'tasks',
      missing_reference: 'plans',
      count: orphanTasks.rows.length,
      sample_ids: orphanTasks.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check plan_enrollments → plans
  const orphanEnrollments = await db.raw(`
    SELECT pe.id, pe.plan_id FROM plan_enrollments pe
    LEFT JOIN plans p ON p.id = pe.plan_id
    WHERE p.id IS NULL
    LIMIT 100
  `);
  if (orphanEnrollments.rows.length > 0) {
    report.orphan_records.push({
      table: 'plan_enrollments',
      missing_reference: 'plans',
      count: orphanEnrollments.rows.length,
      sample_ids: orphanEnrollments.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check plan_enrollments → users
  const orphanEnrollUsers = await db.raw(`
    SELECT pe.id, pe.user_id FROM plan_enrollments pe
    LEFT JOIN users u ON u.id = pe.user_id
    WHERE u.id IS NULL
    LIMIT 100
  `);
  if (orphanEnrollUsers.rows.length > 0) {
    report.orphan_records.push({
      table: 'plan_enrollments',
      missing_reference: 'users',
      count: orphanEnrollUsers.rows.length,
      sample_ids: orphanEnrollUsers.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check rankings → users
  const orphanRankings = await db.raw(`
    SELECT r.id, r.user_id FROM rankings r
    LEFT JOIN users u ON u.id = r.user_id
    WHERE u.id IS NULL
    LIMIT 100
  `);
  if (orphanRankings.rows.length > 0) {
    report.orphan_records.push({
      table: 'rankings',
      missing_reference: 'users',
      count: orphanRankings.rows.length,
      sample_ids: orphanRankings.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check moderation_cases → content_items
  const orphanCases = await db.raw(`
    SELECT mc.id, mc.content_item_id FROM moderation_cases mc
    LEFT JOIN content_items ci ON ci.id = mc.content_item_id
    WHERE ci.id IS NULL
    LIMIT 100
  `);
  if (orphanCases.rows.length > 0) {
    report.orphan_records.push({
      table: 'moderation_cases',
      missing_reference: 'content_items',
      count: orphanCases.rows.length,
      sample_ids: orphanCases.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check appeals → moderation_cases
  const orphanAppeals = await db.raw(`
    SELECT a.id, a.moderation_case_id FROM appeals a
    LEFT JOIN moderation_cases mc ON mc.id = a.moderation_case_id
    WHERE mc.id IS NULL
    LIMIT 100
  `);
  if (orphanAppeals.rows.length > 0) {
    report.orphan_records.push({
      table: 'appeals',
      missing_reference: 'moderation_cases',
      count: orphanAppeals.rows.length,
      sample_ids: orphanAppeals.rows.slice(0, 10).map((r) => r.id),
    });
  }

  // Check acl_entries → resources
  const orphanAcl = await db.raw(`
    SELECT ae.id, ae.resource_id FROM acl_entries ae
    LEFT JOIN resources r ON r.id = ae.resource_id
    WHERE r.id IS NULL
    LIMIT 100
  `);
  if (orphanAcl.rows.length > 0) {
    report.orphan_records.push({
      table: 'acl_entries',
      missing_reference: 'resources',
      count: orphanAcl.rows.length,
      sample_ids: orphanAcl.rows.slice(0, 10).map((r) => r.id),
    });
  }

  report.total_issues = report.orphan_records.reduce((sum, r) => sum + r.count, 0);

  ctx.body = report;
});

// ── Backup ──────────────────────────────────────────────────────────────
router.post('/backup', authenticate(), requirePermission('data.backup'), async (ctx) => {
  const tables = ALLOWED_TABLES;
  const backup = {};

  for (const table of tables) {
    let rows = await db(table).select();
    // Redact sensitive fields from backup output
    rows = redactSensitiveFields(rows, table);
    backup[table] = rows;
  }

  const [job] = await db('import_jobs')
    .insert({
      initiated_by: ctx.state.user.id,
      type: 'backup',
      format: 'json',
      status: 'completed',
      total_records: Object.values(backup).reduce((sum, t) => sum + t.length, 0),
      processed_records: Object.values(backup).reduce((sum, t) => sum + t.length, 0),
      started_at: new Date(),
      completed_at: new Date(),
    })
    .returning('*');

  await ctx.audit({
    action: 'data.backup',
    resourceType: 'import_job',
    resourceId: job.id,
    afterState: job,
    details: { tables: tables.length },
  });

  ctx.body = { job, backup };
});

// ── Restore (full authenticated + audited workflow) ─────────────────────
router.post('/restore', authenticate(), requirePermission('data.import'), async (ctx) => {
  const { backup, conflict_resolution = 'last_write_wins', dry_run = false } = ctx.request.body;

  if (!backup || typeof backup !== 'object') {
    throw Errors.badRequest('backup object is required (keyed by table name)');
  }

  // Validate all table names
  const tableNames = Object.keys(backup);
  for (const t of tableNames) {
    if (!ALLOWED_TABLES.includes(t)) {
      throw Errors.badRequest(`Invalid table in backup: ${t}. Allowed: ${ALLOWED_TABLES.join(', ')}`);
    }
  }

  // Create restore job
  const totalRecords = Object.values(backup).reduce((s, arr) => s + (Array.isArray(arr) ? arr.length : 0), 0);
  const [job] = await db('import_jobs')
    .insert({
      initiated_by: ctx.state.user.id,
      type: 'restore',
      format: 'json',
      target_table: tableNames.join(','),
      status: 'validating',
      config: JSON.stringify({ conflict_resolution, dry_run }),
      total_records: totalRecords,
      started_at: new Date(),
    })
    .returning('*');

  const report = {
    job_id: job.id,
    tables_processed: [],
    total_inserted: 0,
    total_updated: 0,
    total_skipped: 0,
    total_errors: 0,
    errors: [],
    dry_run,
  };

  try {
    // Validation pass: check that all records in backup are arrays with valid structure
    for (const [table, records] of Object.entries(backup)) {
      if (!Array.isArray(records)) {
        report.errors.push({ table, error: 'Value must be an array of records' });
        report.total_errors++;
        continue;
      }

      // Schema validation for known schemas
      const schema = TABLE_SCHEMAS[table];
      if (schema) {
        const validate = ajv.compile({ type: 'array', items: schema });
        if (!validate(records)) {
          const errors = validate.errors.map((e) => `${e.instancePath}: ${e.message}`);
          report.errors.push({ table, validation_errors: errors });
          report.total_errors += errors.length;
        }
      }
    }

    if (report.total_errors > 0 && !dry_run) {
      await db('import_jobs').where('id', job.id).update({
        status: 'failed',
        validation_errors: JSON.stringify(report.errors),
        error_records: report.total_errors,
        completed_at: new Date(),
        updated_at: new Date(),
      });
      ctx.status = 400;
      ctx.body = report;
      return;
    }

    // Strip security-critical fields from all table records before processing
    for (const table of Object.keys(backup)) {
      if (Array.isArray(backup[table])) {
        backup[table] = stripBlockedImportFields(backup[table], table);
      }
    }

    // Admin-only tables in restore require Administrator role
    const hasAdminTables = tableNames.some((t) => ADMIN_ONLY_TABLES.includes(t));
    if (hasAdminTables && !(await isAdmin(ctx.state.user.id))) {
      const restrictedTables = tableNames.filter((t) => ADMIN_ONLY_TABLES.includes(t));
      throw Errors.forbidden(
        `Restoring tables [${restrictedTables.join(', ')}] requires Administrator role`
      );
    }

    // Processing pass
    await db('import_jobs').where('id', job.id).update({ status: 'processing' });

    // Process tables in dependency order (parents first, then dependent tables)
    const orderedTables = [
      'users', 'roles', 'permissions', 'role_permissions', 'user_roles',
      'resources', 'acl_entries', 'topics', 'violation_categories',
      'plans', 'plan_enrollments', 'tasks', 'activity_logs', 'assessment_rules',
      'ranking_configs', 'computed_scores', 'rankings', 'certificates', 'content_items',
      'moderation_cases', 'appeals', 'campaigns', 'placements',
      'coupons', 'analytics_events', 'message_templates', 'messages', 'subscriptions',
    ].filter((t) => backup[t] && backup[t].length > 0);

    for (const table of orderedTables) {
      const records = backup[table];
      let inserted = 0, updated = 0, skipped = 0, errors = 0;

      for (const record of records) {
        try {
          if (dry_run) {
            // In dry_run, just count what would happen
            if (record.id) {
              const existing = await db(table).where('id', record.id).first();
              if (existing) {
                if (conflict_resolution === 'last_write_wins') {
                  if (record.updated_at && existing.updated_at &&
                      new Date(record.updated_at) > new Date(existing.updated_at)) {
                    updated++;
                  } else {
                    skipped++;
                  }
                } else {
                  updated++;
                }
              } else {
                inserted++;
              }
            } else {
              inserted++;
            }
            continue;
          }

          if (record.id) {
            const existing = await db(table).where('id', record.id).first();
            if (existing) {
              if (conflict_resolution === 'last_write_wins') {
                if (record.updated_at && existing.updated_at &&
                    new Date(record.updated_at) > new Date(existing.updated_at)) {
                  await db(table).where('id', record.id).update({
                    ...record,
                    updated_at: new Date(record.updated_at),
                  });
                  updated++;
                } else {
                  skipped++;
                }
              } else if (conflict_resolution === 'overwrite') {
                await db(table).where('id', record.id).update(record);
                updated++;
              } else if (conflict_resolution === 'merge_append') {
                // Append-only merge: merge JSONB/array fields, keep existing scalars
                const updates = {};
                for (const [key, val] of Object.entries(record)) {
                  if (key === 'id') continue;
                  if (Array.isArray(val) && Array.isArray(existing[key])) {
                    updates[key] = JSON.stringify([...existing[key], ...val]);
                  } else if (val !== null && val !== undefined) {
                    updates[key] = val;
                  }
                }
                if (Object.keys(updates).length > 0) {
                  await db(table).where('id', record.id).update(updates);
                  updated++;
                } else {
                  skipped++;
                }
              } else {
                skipped++;
              }
            } else {
              await db(table).insert(record);
              inserted++;
            }
          } else {
            await db(table).insert(record);
            inserted++;
          }
        } catch (err) {
          errors++;
          report.errors.push({ table, record_id: record.id, error: err.message });
        }
      }

      report.tables_processed.push({ table, inserted, updated, skipped, errors });
      report.total_inserted += inserted;
      report.total_updated += updated;
      report.total_skipped += skipped;
      report.total_errors += errors;
    }

    const finalStatus = report.total_errors > 0 ? 'completed' : 'completed';
    await db('import_jobs').where('id', job.id).update({
      status: finalStatus,
      processed_records: report.total_inserted + report.total_updated,
      error_records: report.total_errors,
      validation_errors: JSON.stringify(report.errors),
      consistency_report: JSON.stringify(report.tables_processed),
      completed_at: new Date(),
      updated_at: new Date(),
    });

    await ctx.audit({
      action: 'data.restore',
      resourceType: 'import_job',
      resourceId: job.id,
      afterState: { job_id: job.id, tables: tableNames, inserted: report.total_inserted, updated: report.total_updated },
      details: {
        tables: tableNames,
        conflict_resolution,
        dry_run,
        inserted: report.total_inserted,
        updated: report.total_updated,
        skipped: report.total_skipped,
        errors: report.total_errors,
      },
    });

    ctx.status = dry_run ? 200 : 201;
    ctx.body = report;
  } catch (err) {
    await db('import_jobs').where('id', job.id).update({
      status: 'failed',
      error_message: err.message,
      completed_at: new Date(),
      updated_at: new Date(),
    });
    throw err;
  }
});

// ── Import Job Status ───────────────────────────────────────────────────
router.get('/jobs', authenticate(), requirePermission('data.export'), async (ctx) => {
  const { page = 1, per_page = 20 } = ctx.query;
  const offset = (page - 1) * per_page;

  const [{ count }] = await db('import_jobs').count();
  const jobs = await db('import_jobs').orderBy('created_at', 'desc').offset(offset).limit(per_page);

  ctx.body = {
    data: jobs,
    pagination: { page: +page, per_page: +per_page, total: +count, total_pages: Math.ceil(count / per_page) },
  };
});

router.get('/jobs/:id', authenticate(), requirePermission('data.export'), async (ctx) => {
  const job = await db('import_jobs').where('id', ctx.params.id).first();
  if (!job) throw Errors.notFound('Import job not found');
  ctx.body = job;
});

module.exports = router;
