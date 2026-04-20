const db = require('../db/connection');
const { sha256 } = require('../utils/crypto');
const { Errors } = require('../utils/errors');

/**
 * Action prefixes that always require hash context because they mutate
 * security- or permission-relevant state.  Even callers that bypass
 * ctx.audit() and call writeAuditLog() directly will be blocked if they
 * omit beforeState/afterState for these actions.
 */
const SECURITY_RELEVANT_ACTIONS = [
  'user.register',
  'user.login',
  'user.login_failed',
  'user.change_password',
  'user.assign_role',
  'user.remove_role',
  'user.deactivate',
  'user.activate',
  'acl.create',
  'acl.delete',
];

/**
 * Writes an immutable audit record.
 * Called explicitly by routes after privileged actions, and automatically
 * by the audit enforcement middleware for all mutating requests.
 *
 * Audit write failures propagate — privileged actions must not succeed
 * without a durable audit record.
 *
 * @param {Object} opts
 * @param {boolean} opts.requireHashes - When true, at least one of beforeState/afterState must be provided.
 *   Automatically set to true for security-relevant actions (see SECURITY_RELEVANT_ACTIONS).
 */
async function writeAuditLog({
  actorId,
  action,
  resourceType,
  resourceId,
  beforeState = null,
  afterState = null,
  details = {},
  ipAddress = null,
  requireHashes = false,
}) {
  // Security-relevant actions always require hash context
  const effectiveRequireHashes = requireHashes || SECURITY_RELEVANT_ACTIONS.includes(action);

  if (effectiveRequireHashes && !beforeState && !afterState) {
    throw Errors.internal(
      `Audit record for ${action} on ${resourceType}/${resourceId} rejected: before/after state hashes are required for privileged writes`
    );
  }
  await db('audit_logs').insert({
    actor_id: actorId,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    before_hash: beforeState ? sha256(beforeState) : null,
    after_hash: afterState ? sha256(afterState) : null,
    details: JSON.stringify(details),
    ip_address: ipAddress,
  });
}

/**
 * Middleware that attaches the audit helper to ctx AND automatically
 * records an audit entry for every mutating (POST/PUT/PATCH/DELETE)
 * request by an authenticated user that completes successfully.
 *
 * Route-level ctx.audit() calls add detailed before/after state.
 * This middleware guarantees a baseline record exists even if the
 * route forgets to call ctx.audit().
 *
 * Audit write failures cause the request to fail with 500 — privileged
 * actions must not succeed without a durable audit record.
 */
function auditMiddleware() {
  return async (ctx, next) => {
    // Track whether route-level audit was already called
    let routeAuditCalled = false;

    ctx.audit = (params) => {
      routeAuditCalled = true;
      return writeAuditLog({
        actorId: ctx.state.user?.id,
        ipAddress: ctx.ip,
        requireHashes: true,
        ...params,
      });
    };

    await next();

    // Auto-audit all mutating requests that were authenticated
    const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (
      mutatingMethods.includes(ctx.method) &&
      ctx.state.user?.id &&
      ctx.status < 400 &&
      !routeAuditCalled
    ) {
      // Derive resource info from the request path
      const pathParts = ctx.path.split('/').filter(Boolean); // e.g. ['api','plans','123']
      const resourceType = pathParts[1] || 'unknown'; // e.g. 'plans'
      // Only accept a path segment as resourceId if it looks like a UUID —
      // otherwise routes like /api/rankings/compute would try to store
      // 'compute' in the uuid-typed resource_id column and 500 the request.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const resourceId = pathParts[2] && UUID_RE.test(pathParts[2]) ? pathParts[2] : null;

      // Auto-audit captures the response body as afterState to produce a real hash.
      // For DELETE methods, the request body serves as beforeState.
      const afterState = ctx.body && typeof ctx.body === 'object' ? ctx.body : null;
      const beforeState = ctx.method === 'DELETE' && ctx.request.body ? ctx.request.body : null;

      // Audit failures must propagate — no silent swallowing
      await writeAuditLog({
        actorId: ctx.state.user.id,
        action: `${ctx.method.toLowerCase()}.${resourceType}`,
        resourceType,
        resourceId,
        beforeState,
        afterState,
        details: {
          method: ctx.method,
          path: ctx.path,
          status: ctx.status,
          auto_recorded: true,
        },
        ipAddress: ctx.ip,
        requireHashes: true,
      });
    }
  };
}

module.exports = { writeAuditLog, auditMiddleware, SECURITY_RELEVANT_ACTIONS };
