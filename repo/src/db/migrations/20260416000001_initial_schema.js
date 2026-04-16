/**
 * Initial schema migration for Training Assessment & Content Governance Backend.
 * Creates all core tables, indexes, and constraints.
 */
exports.up = async function (knex) {
  // ── Users & Auth ──────────────────────────────────────────────────────
  await knex.schema.createTable('users', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('username', 255).notNullable().unique();
    t.string('email', 255).notNullable().unique();
    t.text('password_hash').notNullable();
    t.string('full_name', 500);
    t.jsonb('profile').defaultTo('{}');
    t.boolean('is_active').defaultTo(true);
    t.integer('failed_login_attempts').defaultTo(0);
    t.timestamp('locked_until');
    t.timestamp('last_login_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('created_at');
  });

  // ── Roles & Permissions ───────────────────────────────────────────────
  await knex.schema.createTable('roles', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 100).notNullable().unique();
    t.text('description');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('permissions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable().unique();
    t.text('description');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('role_permissions', (t) => {
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.uuid('permission_id').notNullable().references('id').inTable('permissions').onDelete('CASCADE');
    t.primary(['role_id', 'permission_id']);
  });

  await knex.schema.createTable('user_roles', (t) => {
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');
    t.uuid('assigned_by').references('id').inTable('users');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.primary(['user_id', 'role_id']);
    t.index('user_id');
  });

  // ── Resources & ACL ───────────────────────────────────────────────────
  await knex.schema.createTable('resources', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('type', 100).notNullable(); // folder, document, content_item, etc.
    t.string('name', 500).notNullable();
    t.uuid('parent_id').references('id').inTable('resources').onDelete('SET NULL');
    t.uuid('owner_id').references('id').inTable('users');
    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('type');
    t.index('parent_id');
    t.index('owner_id');
  });

  await knex.schema.createTable('acl_entries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('resource_id').notNullable().references('id').inTable('resources').onDelete('CASCADE');
    // Principal can be a user or role
    t.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    t.uuid('role_id').references('id').inTable('roles').onDelete('CASCADE');
    t.string('action', 50).notNullable(); // read, download, edit, delete, share, submit, approve
    t.enu('effect', ['allow', 'deny']).notNullable().defaultTo('allow');
    t.boolean('inherited').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('resource_id');
    t.index('user_id');
    t.index('role_id');
  });

  // ── Audit Log (immutable) ─────────────────────────────────────────────
  await knex.schema.createTable('audit_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('actor_id').references('id').inTable('users');
    t.string('action', 255).notNullable();
    t.string('resource_type', 100);
    t.uuid('resource_id');
    t.text('before_hash');
    t.text('after_hash');
    t.jsonb('details').defaultTo('{}');
    t.string('ip_address', 45);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('actor_id');
    t.index('created_at');
    t.index(['resource_type', 'resource_id']);
  });

  // ── Plans & Tasks ─────────────────────────────────────────────────────
  await knex.schema.createTable('plans', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('title', 500).notNullable();
    t.text('description');
    t.uuid('created_by').notNullable().references('id').inTable('users');
    t.enu('status', ['draft', 'active', 'completed', 'archived']).defaultTo('draft');
    t.date('start_date');
    t.date('end_date');
    t.jsonb('config').defaultTo('{}');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('created_by');
    t.index('status');
    t.index('created_at');
  });

  await knex.schema.createTable('plan_enrollments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('plan_id').notNullable().references('id').inTable('plans').onDelete('CASCADE');
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.enu('status', ['enrolled', 'waitlisted', 'completed', 'dropped']).defaultTo('enrolled');
    t.timestamp('enrolled_at').defaultTo(knex.fn.now());
    t.unique(['plan_id', 'user_id']);
    t.index('user_id');
  });

  await knex.schema.createTable('tasks', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('plan_id').notNullable().references('id').inTable('plans').onDelete('CASCADE');
    t.string('title', 500).notNullable();
    t.text('description');
    t.integer('sort_order').defaultTo(0);
    t.enu('type', ['exercise', 'assessment', 'rest', 'custom']).defaultTo('exercise');
    t.jsonb('config').defaultTo('{}'); // duration targets, rep targets, etc.
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('plan_id');
  });

  // ── Activity Logs ─────────────────────────────────────────────────────
  await knex.schema.createTable('activity_logs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('task_id').references('id').inTable('tasks').onDelete('SET NULL');
    t.uuid('plan_id').references('id').inTable('plans').onDelete('SET NULL');
    t.string('activity_type', 100).notNullable(); // e.g., 'run', 'pushups', 'assessment'
    t.decimal('value', 14, 4); // raw numeric value (seconds, reps, etc.)
    t.string('unit', 50); // seconds, reps, meters, etc.
    t.jsonb('dimensions').defaultTo('{}'); // strength, endurance, consistency scores
    t.jsonb('metadata').defaultTo('{}'); // device info, GPS, notes
    t.boolean('is_outlier').defaultTo(false);
    t.boolean('outlier_approved').defaultTo(false);
    t.uuid('outlier_approved_by').references('id').inTable('users');
    t.timestamp('performed_at').notNullable();
    t.timestamp('submitted_at').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('user_id');
    t.index('task_id');
    t.index('plan_id');
    t.index('created_at');
    t.index(['user_id', 'activity_type', 'performed_at']);
  });

  // ── Assessment Rules (versioned) ──────────────────────────────────────
  await knex.schema.createTable('assessment_rules', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('assessment_type', 100).notNullable();
    t.integer('version').notNullable();
    t.boolean('is_active').defaultTo(true);
    t.jsonb('scoring_items').notNullable();
    // scoring_items: [{
    //   name: string, type: 'time_seconds' | 'rep_count' | 'combined_completion',
    //   weight: number (all weights sum to 1.00),
    //   min_bound: number, max_bound: number,
    //   dimension: string (e.g. 'strength', 'endurance', 'consistency')
    // }]
    t.jsonb('outlier_config').defaultTo('{"std_dev_threshold": 3, "trailing_count": 30}');
    t.text('description');
    t.uuid('created_by').references('id').inTable('users');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.unique(['assessment_type', 'version']);
    // Partial unique index for one active version per type is handled via application logic + trigger
    t.index('assessment_type');
    t.index('is_active');
  });

  // ── Computed Scores ───────────────────────────────────────────────────
  await knex.schema.createTable('computed_scores', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('assessment_rule_id').notNullable().references('id').inTable('assessment_rules');
    t.decimal('total_score', 8, 4).notNullable(); // 0-100
    t.jsonb('item_scores').notNullable(); // per-item breakdown
    // item_scores: [{ name, raw_value, normalized_score, weight, weighted_score, log_ids: [] }]
    t.jsonb('dimensional_breakdown').defaultTo('{}'); // { strength: X, endurance: Y, ... }
    t.jsonb('peer_percentiles').defaultTo('{}'); // { cohort: 'all', percentile: 72 }
    t.jsonb('source_log_ids').notNullable().defaultTo('[]'); // traceability
    t.integer('rule_version').notNullable();
    t.integer('logs_included').defaultTo(0);
    t.integer('logs_excluded_outlier').defaultTo(0);
    t.timestamp('window_start');
    t.timestamp('window_end');
    t.timestamp('computed_at').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('user_id');
    t.index('assessment_rule_id');
    t.index('created_at');
    t.index(['user_id', 'computed_at']);
  });

  // ── Rankings ──────────────────────────────────────────────────────────
  await knex.schema.createTable('rankings', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('assessment_type', 100).notNullable();
    t.enu('level', ['none', 'bronze', 'silver', 'gold']).defaultTo('none');
    t.decimal('rolling_avg_score', 8, 4);
    t.timestamp('window_start');
    t.timestamp('window_end');
    t.timestamp('achieved_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.unique(['user_id', 'assessment_type']);
    t.index('user_id');
    t.index('level');
    t.index('created_at');
  });

  // ── Certificates ──────────────────────────────────────────────────────
  await knex.schema.createTable('certificates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('ranking_id').references('id').inTable('rankings');
    t.string('assessment_type', 100).notNullable();
    t.string('level', 20).notNullable();
    t.decimal('score', 8, 4).notNullable();
    t.string('verification_code', 512).notNullable().unique();
    t.jsonb('details').defaultTo('{}');
    t.timestamp('issued_at').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('user_id');
    t.index('verification_code');
    t.index('created_at');
  });

  // ── Content Items ─────────────────────────────────────────────────────
  await knex.schema.createTable('content_items', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('author_id').notNullable().references('id').inTable('users');
    t.string('title', 500).notNullable();
    t.text('body');
    t.string('content_type', 100).notNullable(); // article, video_link, image, document
    t.string('file_type', 50);
    t.integer('file_size');
    t.string('file_hash', 128); // SHA-256 fingerprint
    t.string('topic', 255);
    t.jsonb('tags').defaultTo('[]');
    t.enu('status', ['draft', 'pending_review', 'approved', 'rejected', 'archived']).defaultTo('draft');
    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('published_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('author_id');
    t.index('status');
    t.index('topic');
    t.index('created_at');
  });

  // ── Moderation Cases ──────────────────────────────────────────────────
  await knex.schema.createTable('moderation_cases', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('content_item_id').notNullable().references('id').inTable('content_items').onDelete('CASCADE');
    t.uuid('reported_by').references('id').inTable('users');
    t.uuid('reviewer_id').references('id').inTable('users');
    t.string('violation_category', 255);
    t.text('description');
    t.enu('status', ['open', 'under_review', 'resolved_approved', 'resolved_rejected', 'appealed', 'appeal_approved', 'appeal_rejected']).defaultTo('open');
    t.text('reviewer_comments');
    t.jsonb('auto_screening_results').defaultTo('{}');
    t.timestamp('decided_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('content_item_id');
    t.index('reviewer_id');
    t.index('status');
    t.index('created_at');
  });

  // ── Appeals ───────────────────────────────────────────────────────────
  await knex.schema.createTable('appeals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('moderation_case_id').notNullable().references('id').inTable('moderation_cases').onDelete('CASCADE');
    t.uuid('appellant_id').notNullable().references('id').inTable('users');
    t.uuid('reviewer_id').references('id').inTable('users');
    t.text('reason').notNullable();
    t.enu('status', ['pending', 'under_review', 'approved', 'rejected']).defaultTo('pending');
    t.text('reviewer_comments');
    t.timestamp('decided_at');
    t.timestamp('deadline').notNullable(); // 14 days from moderation decision
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('moderation_case_id');
    t.index('appellant_id');
    t.index('status');
    t.index('created_at');
  });

  // ── Campaigns ─────────────────────────────────────────────────────────
  await knex.schema.createTable('campaigns', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 500).notNullable();
    t.text('description');
    t.enu('status', ['draft', 'scheduled', 'active', 'paused', 'completed']).defaultTo('draft');
    t.timestamp('start_at');
    t.timestamp('end_at');
    // Phased rollout: 5% → 25% → 50% → 100%
    t.jsonb('rollout_phases').defaultTo('[{"percent":5},{"percent":25},{"percent":50},{"percent":100}]');
    t.integer('current_rollout_percent').defaultTo(0);
    t.jsonb('config').defaultTo('{}');
    // A/B test config
    t.string('ab_test_id', 255);
    t.jsonb('ab_variants').defaultTo('[]'); // [{name, weight}]
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('status');
    t.index('created_at');
  });

  // ── Placements ────────────────────────────────────────────────────────
  await knex.schema.createTable('placements', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
    t.string('slot', 255).notNullable(); // e.g., 'homepage_banner', 'plan_sidebar'
    t.jsonb('content').defaultTo('{}');
    t.integer('priority').defaultTo(0);
    t.timestamp('start_at');
    t.timestamp('end_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('campaign_id');
    t.index('slot');
    t.index(['start_at', 'end_at']);
  });

  // ── Coupons ───────────────────────────────────────────────────────────
  await knex.schema.createTable('coupons', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('campaign_id').references('id').inTable('campaigns').onDelete('SET NULL');
    t.string('code', 100).notNullable().unique();
    t.enu('discount_type', ['fixed', 'percent']).notNullable();
    t.decimal('discount_value', 10, 2).notNullable(); // $5-$50 or 5%-30%
    t.decimal('min_spend', 10, 2).defaultTo(0); // spend-threshold
    t.integer('max_uses').defaultTo(null);
    t.integer('times_used').defaultTo(0);
    t.boolean('is_active').defaultTo(true);
    t.timestamp('valid_from');
    t.timestamp('valid_until');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('code');
    t.index('campaign_id');
    t.index('is_active');
  });

  // ── Analytics Events ──────────────────────────────────────────────────
  await knex.schema.createTable('analytics_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('idempotency_key', 255).notNullable().unique();
    t.uuid('user_id').references('id').inTable('users');
    t.uuid('campaign_id').references('id').inTable('campaigns');
    t.string('event_type', 100).notNullable(); // impression, click, conversion, funnel_step
    t.string('event_name', 255);
    t.jsonb('properties').defaultTo('{}');
    t.string('ab_variant', 100);
    t.string('funnel_name', 255);
    t.integer('funnel_step');
    t.timestamp('occurred_at').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('user_id');
    t.index('campaign_id');
    t.index('event_type');
    t.index('idempotency_key');
    t.index('created_at');
    t.index(['funnel_name', 'funnel_step']);
  });

  // ── Messages ──────────────────────────────────────────────────────────
  await knex.schema.createTable('message_templates', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable();
    t.integer('version').notNullable();
    t.string('category', 100).notNullable(); // enrollment, waitlist, schedule, score_release
    t.text('subject_template').notNullable();
    t.text('body_template').notNullable();
    t.jsonb('required_placeholders').defaultTo('[]');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['name', 'version']);
    t.index('category');
    t.index('is_active');
  });

  await knex.schema.createTable('messages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('recipient_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.uuid('sender_id').references('id').inTable('users');
    t.uuid('template_id').references('id').inTable('message_templates');
    t.string('channel', 20).defaultTo('in_app'); // only in_app in offline mode
    t.string('subject', 500).notNullable();
    t.text('body').notNullable();
    t.boolean('is_read').defaultTo(false);
    t.timestamp('read_at');
    t.jsonb('metadata').defaultTo('{}');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('recipient_id');
    t.index('sender_id');
    t.index('is_read');
    t.index('created_at');
  });

  await knex.schema.createTable('subscriptions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('category', 100).notNullable();
    t.boolean('in_app_enabled').defaultTo(true);
    // email/sms disabled in offline mode
    t.boolean('email_enabled').defaultTo(false);
    t.boolean('sms_enabled').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.unique(['user_id', 'category']);
    t.index('user_id');
  });

  // ── Import/Export Jobs ────────────────────────────────────────────────
  await knex.schema.createTable('import_jobs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('initiated_by').notNullable().references('id').inTable('users');
    t.enu('type', ['import', 'export', 'backup', 'restore']).notNullable();
    t.enu('format', ['json', 'csv']).notNullable();
    t.enu('status', ['pending', 'validating', 'processing', 'completed', 'failed']).defaultTo('pending');
    t.string('target_table', 255);
    t.jsonb('config').defaultTo('{}'); // conflict resolution strategy, etc.
    t.jsonb('validation_errors').defaultTo('[]');
    t.jsonb('consistency_report').defaultTo('{}');
    t.integer('total_records').defaultTo(0);
    t.integer('processed_records').defaultTo(0);
    t.integer('error_records').defaultTo(0);
    t.text('file_path');
    t.text('error_message');
    t.timestamp('started_at');
    t.timestamp('completed_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('initiated_by');
    t.index('status');
    t.index('created_at');
  });

  // ── Violation Categories (configurable) ───────────────────────────────
  await knex.schema.createTable('violation_categories', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable().unique();
    t.text('description');
    t.integer('severity').defaultTo(1); // 1-5
    t.jsonb('keyword_list').defaultTo('[]');
    t.jsonb('file_type_allowlist').defaultTo('[]');
    t.integer('max_file_size_bytes');
    t.jsonb('blocked_fingerprints').defaultTo('[]'); // SHA-256 hashes
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // ── Topics (configurable) ─────────────────────────────────────────────
  await knex.schema.createTable('topics', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('name', 255).notNullable().unique();
    t.text('description');
    t.uuid('parent_id').references('id').inTable('topics').onDelete('SET NULL');
    t.integer('sort_order').defaultTo(0);
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index('parent_id');
  });

  // ── Ranking Configuration ─────────────────────────────────────────────
  await knex.schema.createTable('ranking_configs', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('assessment_type', 100).notNullable().unique();
    t.integer('window_days').defaultTo(14);
    t.jsonb('thresholds').defaultTo('{"bronze":60,"silver":75,"gold":90}');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // ── Immutable audit_logs: prevent UPDATE and DELETE ────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs table is immutable: % operations are not allowed', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
  `);
  await knex.raw(`
    CREATE TRIGGER audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
  `);

  // ── Partial unique index: one active rule per assessment type ─────────
  await knex.raw(`
    CREATE UNIQUE INDEX idx_assessment_rules_active_type
    ON assessment_rules (assessment_type)
    WHERE is_active = true
  `);

  // ── Partial unique index: one active message template per name ────────
  await knex.raw(`
    CREATE UNIQUE INDEX idx_message_templates_active_name
    ON message_templates (name)
    WHERE is_active = true
  `);
};

exports.down = async function (knex) {
  const tables = [
    'ranking_configs', 'topics', 'violation_categories',
    'import_jobs', 'subscriptions', 'messages', 'message_templates',
    'analytics_events', 'coupons', 'placements', 'campaigns',
    'appeals', 'moderation_cases', 'content_items',
    'certificates', 'rankings', 'computed_scores', 'assessment_rules',
    'activity_logs', 'tasks', 'plan_enrollments', 'plans',
    'audit_logs', 'acl_entries', 'resources',
    'user_roles', 'role_permissions', 'permissions', 'roles', 'users',
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
};
