const { v4: uuid } = require('uuid');

exports.seed = async function (knex) {
  // Clear existing
  await knex('user_roles').del();
  await knex('role_permissions').del();
  await knex('permissions').del();
  await knex('roles').del();

  // ── Roles ─────────────────────────────────────────────────────────────
  // 'OManager' is supported as a role alias for 'Operations Manager' in RBAC middleware.
  // The canonical DB role is 'Operations Manager'; the alias is resolved at runtime.
  const roles = [
    { id: uuid(), name: 'Administrator', description: 'Full system access' },
    { id: uuid(), name: 'Operations Manager', description: 'Manages plans, campaigns, content config, and data operations. Alias: OManager' },
    { id: uuid(), name: 'Reviewer', description: 'Reviews content and moderation cases' },
    { id: uuid(), name: 'Coach', description: 'Manages training plans, views participant data, approves outliers' },
    { id: uuid(), name: 'Participant', description: 'End user: enrolls in plans, submits logs, earns rankings' },
  ];
  await knex('roles').insert(roles);

  // ── Permissions ───────────────────────────────────────────────────────
  const permissions = [
    // User management
    { id: uuid(), name: 'users.list', description: 'List all users' },
    { id: uuid(), name: 'users.read', description: 'View user details' },
    { id: uuid(), name: 'users.manage_roles', description: 'Assign/remove roles' },
    { id: uuid(), name: 'users.deactivate', description: 'Deactivate/activate users' },
    // Plans
    { id: uuid(), name: 'plans.create', description: 'Create training plans' },
    { id: uuid(), name: 'plans.update', description: 'Update training plans' },
    { id: uuid(), name: 'plans.delete', description: 'Delete training plans' },
    // Activity logs
    { id: uuid(), name: 'activity_logs.view_all', description: 'View all users activity logs' },
    { id: uuid(), name: 'activity_logs.approve_outlier', description: 'Approve outlier submissions' },
    // Assessments
    { id: uuid(), name: 'assessments.manage_rules', description: 'Create/update assessment rules' },
    { id: uuid(), name: 'assessments.compute_any', description: 'Compute scores for any user' },
    // Rankings
    { id: uuid(), name: 'rankings.manage_config', description: 'Configure ranking thresholds' },
    // Content
    { id: uuid(), name: 'content.moderate', description: 'Review and moderate content' },
    { id: uuid(), name: 'content.manage_categories', description: 'Manage violation categories' },
    { id: uuid(), name: 'content.manage_topics', description: 'Manage content topics' },
    // Campaigns
    { id: uuid(), name: 'campaigns.manage', description: 'Create/update campaigns and coupons' },
    { id: uuid(), name: 'campaigns.analytics', description: 'View campaign analytics' },
    // Messages
    { id: uuid(), name: 'messages.send', description: 'Send messages to users' },
    { id: uuid(), name: 'messages.manage_templates', description: 'Create/update message templates' },
    { id: uuid(), name: 'messages.broadcast', description: 'Broadcast messages' },
    // Data
    { id: uuid(), name: 'data.export', description: 'Export data' },
    { id: uuid(), name: 'data.import', description: 'Import data' },
    { id: uuid(), name: 'data.backup', description: 'Create backups' },
    { id: uuid(), name: 'data.consistency_check', description: 'Run consistency checks' },
    // Resources / ACL
    { id: uuid(), name: 'resources.manage_acl', description: 'Manage resource ACLs' },
    // Audit
    { id: uuid(), name: 'audit.view', description: 'View audit logs' },
  ];
  await knex('permissions').insert(permissions);

  // ── Role → Permission mappings ────────────────────────────────────────
  const adminRole = roles.find((r) => r.name === 'Administrator');
  const opsRole = roles.find((r) => r.name === 'Operations Manager');
  const reviewerRole = roles.find((r) => r.name === 'Reviewer');
  const coachRole = roles.find((r) => r.name === 'Coach');

  // Admin gets everything
  const adminPerms = permissions.map((p) => ({
    role_id: adminRole.id,
    permission_id: p.id,
  }));
  await knex('role_permissions').insert(adminPerms);

  // Ops Manager
  const opsPermNames = [
    'users.list', 'users.read', 'plans.create', 'plans.update',
    'activity_logs.view_all', 'assessments.manage_rules', 'rankings.manage_config',
    'content.manage_topics', 'campaigns.manage', 'campaigns.analytics',
    'messages.send', 'messages.manage_templates', 'messages.broadcast',
    'data.export', 'data.consistency_check',
  ];
  const opsPerms = permissions
    .filter((p) => opsPermNames.includes(p.name))
    .map((p) => ({ role_id: opsRole.id, permission_id: p.id }));
  await knex('role_permissions').insert(opsPerms);

  // Reviewer
  const reviewerPermNames = ['content.moderate', 'content.manage_categories'];
  const reviewerPerms = permissions
    .filter((p) => reviewerPermNames.includes(p.name))
    .map((p) => ({ role_id: reviewerRole.id, permission_id: p.id }));
  await knex('role_permissions').insert(reviewerPerms);

  // Coach
  const coachPermNames = [
    'plans.create', 'plans.update', 'activity_logs.view_all',
    'activity_logs.approve_outlier', 'assessments.compute_any',
    'messages.send',
  ];
  const coachPerms = permissions
    .filter((p) => coachPermNames.includes(p.name))
    .map((p) => ({ role_id: coachRole.id, permission_id: p.id }));
  await knex('role_permissions').insert(coachPerms);

  // ── Default message templates ─────────────────────────────────────────
  await knex('message_templates').del();
  await knex('message_templates').insert([
    {
      id: uuid(),
      name: 'enrollment_confirmation',
      version: 1,
      category: 'enrollment',
      subject_template: 'Welcome to {{plan_name}}!',
      body_template: 'Hi {{user_name}},\n\nYou have been successfully enrolled in "{{plan_name}}". Your training starts on {{start_date}}.\n\nGood luck!',
      required_placeholders: JSON.stringify(['plan_name', 'user_name', 'start_date']),
    },
    {
      id: uuid(),
      name: 'waitlist_promotion',
      version: 1,
      category: 'waitlist',
      subject_template: 'A spot opened up in {{plan_name}}!',
      body_template: 'Hi {{user_name}},\n\nA spot has opened up in "{{plan_name}}". You have been promoted from the waitlist and are now enrolled.\n\nYour training starts on {{start_date}}.',
      required_placeholders: JSON.stringify(['plan_name', 'user_name', 'start_date']),
    },
    {
      id: uuid(),
      name: 'schedule_change',
      version: 1,
      category: 'schedule',
      subject_template: 'Schedule change for {{plan_name}}',
      body_template: 'Hi {{user_name}},\n\nThe schedule for "{{plan_name}}" has been updated. The new {{change_type}} is {{new_value}}.\n\nPlease check your plan for details.',
      required_placeholders: JSON.stringify(['plan_name', 'user_name', 'change_type', 'new_value']),
    },
    {
      id: uuid(),
      name: 'score_release',
      version: 1,
      category: 'score_release',
      subject_template: 'Your {{assessment_type}} score is ready',
      body_template: 'Hi {{user_name}},\n\nYour {{assessment_type}} assessment score has been computed. Your score: {{score}}/100.\n\nCurrent level: {{level}}.\n\nKeep up the great work!',
      required_placeholders: JSON.stringify(['user_name', 'assessment_type', 'score', 'level']),
    },
  ]);

  // ── Default violation categories ──────────────────────────────────────
  await knex('violation_categories').del();
  await knex('violation_categories').insert([
    {
      id: uuid(),
      name: 'Inappropriate Language',
      description: 'Content contains profanity or offensive language',
      severity: 3,
      keyword_list: JSON.stringify(['profanity_placeholder']),
      file_type_allowlist: JSON.stringify([]),
      blocked_fingerprints: JSON.stringify([]),
    },
    {
      id: uuid(),
      name: 'File Policy',
      description: 'File does not meet size or type requirements',
      severity: 2,
      keyword_list: JSON.stringify([]),
      file_type_allowlist: JSON.stringify(['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'video/mp4']),
      max_file_size_bytes: 52428800, // 50MB
      blocked_fingerprints: JSON.stringify([]),
    },
  ]);
};
