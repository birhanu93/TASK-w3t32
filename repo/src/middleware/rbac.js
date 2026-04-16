const db = require('../db/connection');
const { Errors } = require('../utils/errors');

/**
 * Role aliases: maps shorthand names to canonical DB role names.
 * Allows both 'OManager' and 'Operations Manager' to match.
 */
const ROLE_ALIASES = {
  'OManager': 'Operations Manager',
  'Operations Manager': 'Operations Manager',
};

/**
 * Expand a role name through aliases. Returns canonical name.
 */
function resolveRoleAlias(roleName) {
  return ROLE_ALIASES[roleName] || roleName;
}

/**
 * RBAC middleware — checks that the authenticated user has one of the required roles.
 * Supports role aliases (e.g., 'OManager' matches 'Operations Manager').
 * @param  {...string} allowedRoles - Role names (e.g., 'Administrator', 'Coach', 'OManager')
 */
function requireRole(...allowedRoles) {
  // Expand aliases in allowed roles list
  const expandedAllowed = new Set();
  for (const r of allowedRoles) {
    expandedAllowed.add(r);
    expandedAllowed.add(resolveRoleAlias(r));
    // Also add reverse lookups: if 'Operations Manager' is allowed, also match 'OManager'
    for (const [alias, canonical] of Object.entries(ROLE_ALIASES)) {
      if (canonical === r || alias === r) {
        expandedAllowed.add(alias);
        expandedAllowed.add(canonical);
      }
    }
  }

  return async (ctx, next) => {
    const userId = ctx.state.user?.id;
    if (!userId) throw Errors.unauthorized();

    const userRoles = await db('user_roles')
      .join('roles', 'roles.id', 'user_roles.role_id')
      .where('user_roles.user_id', userId)
      .select('roles.name');

    const roleNames = userRoles.map((r) => r.name);
    ctx.state.roles = roleNames;

    // Check if any user role (or its alias) matches the allowed set
    const hasRole = roleNames.some((r) =>
      expandedAllowed.has(r) || expandedAllowed.has(resolveRoleAlias(r))
    );
    if (!hasRole) {
      throw Errors.forbidden(`Requires one of: ${allowedRoles.join(', ')}`);
    }
    await next();
  };
}

/**
 * Permission-based authorization middleware.
 * Checks that the authenticated user holds ALL of the required permissions
 * via the role_permissions join (roles → role_permissions → permissions).
 *
 * @param  {...string} requiredPermissions - Permission names (e.g., 'users.list', 'data.export')
 */
function requirePermission(...requiredPermissions) {
  return async (ctx, next) => {
    const userId = ctx.state.user?.id;
    if (!userId) throw Errors.unauthorized();

    // Fetch all permission names for this user via their roles
    const userPermissions = await db('user_roles')
      .join('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
      .join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('user_roles.user_id', userId)
      .pluck('permissions.name');

    const permSet = new Set(userPermissions);
    ctx.state.permissions = userPermissions;

    const missing = requiredPermissions.filter((p) => !permSet.has(p));
    if (missing.length > 0) {
      throw Errors.forbidden(`Missing permissions: ${missing.join(', ')}`);
    }
    await next();
  };
}

/**
 * Resource-level ACL middleware.
 * Checks ACL entries for a specific resource + action, supporting:
 *  - Explicit deny overrides (deny always wins)
 *  - Inheritance from parent resources (folder/topic ownership)
 *  - Role-based and user-based entries
 */
function requireAccess(action, getResourceId) {
  return async (ctx, next) => {
    const userId = ctx.state.user?.id;
    if (!userId) throw Errors.unauthorized();

    const resourceId = typeof getResourceId === 'function'
      ? getResourceId(ctx)
      : ctx.params[getResourceId || 'resourceId'];

    if (!resourceId) throw Errors.badRequest('Resource ID required');

    const hasAccess = await checkAccess(userId, resourceId, action);
    if (!hasAccess) {
      throw Errors.forbidden(`No ${action} access to this resource`);
    }
    await next();
  };
}

/**
 * Check access by walking up the resource hierarchy.
 * Deny entries override any allow.
 */
async function checkAccess(userId, resourceId, action) {
  // Get user's role IDs
  const userRoles = await db('user_roles')
    .where('user_id', userId)
    .pluck('role_id');

  // Check if user is Administrator (bypass ACL)
  const adminRole = await db('roles').where('name', 'Administrator').first();
  if (adminRole && userRoles.includes(adminRole.id)) return true;

  // Walk up the resource tree collecting ACL entries
  let currentId = resourceId;
  const visited = new Set();
  let hasAllow = false;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);

    const entries = await db('acl_entries')
      .where('resource_id', currentId)
      .where('action', action)
      .where(function () {
        this.where('user_id', userId).orWhereIn('role_id', userRoles);
      });

    for (const entry of entries) {
      if (entry.effect === 'deny') return false; // Deny always overrides
      if (entry.effect === 'allow') hasAllow = true;
    }

    // Check resource ownership
    const resource = await db('resources').where('id', currentId).first();
    if (resource?.owner_id === userId) hasAllow = true;
    currentId = resource?.parent_id;
  }

  return hasAllow;
}

/**
 * Filter a list of resources to only those the user can access.
 * Returns resource IDs the user is allowed to perform `action` on.
 */
async function filterAccessible(userId, resourceIds, action) {
  if (resourceIds.length === 0) return [];

  // Check if user is Administrator (bypass ACL)
  const userRoles = await db('user_roles')
    .where('user_id', userId)
    .pluck('role_id');
  const adminRole = await db('roles').where('name', 'Administrator').first();
  if (adminRole && userRoles.includes(adminRole.id)) return resourceIds;

  const accessible = [];
  for (const resourceId of resourceIds) {
    if (await checkAccess(userId, resourceId, action)) {
      accessible.push(resourceId);
    }
  }
  return accessible;
}

module.exports = { requireRole, requirePermission, requireAccess, checkAccess, filterAccessible, ROLE_ALIASES, resolveRoleAlias };
