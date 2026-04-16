const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db/connection');
const { Errors } = require('../utils/errors');

/**
 * JWT authentication middleware.
 * Extracts token from Authorization: Bearer <token> header.
 * Populates ctx.state.user with decoded payload.
 * Verifies the user is still active in the database.
 */
function authenticate() {
  return async (ctx, next) => {
    const header = ctx.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw Errors.unauthorized('Missing or invalid authorization header');
    }
    const token = header.slice(7);
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      ctx.state.user = decoded;
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw Errors.unauthorized('Token has expired');
      }
      throw Errors.unauthorized('Invalid token');
    }

    // Verify user still exists and is active (prevent deleted or deactivated users from using existing tokens)
    const user = await db('users').where('id', ctx.state.user.id).select('is_active').first();
    if (!user) {
      throw Errors.unauthorized('User no longer exists');
    }
    if (user.is_active === false) {
      throw Errors.forbidden('Account is deactivated');
    }

    await next();
  };
}

/**
 * Optional auth — sets ctx.state.user if token present, but doesn't fail.
 */
function optionalAuth() {
  return async (ctx, next) => {
    const header = ctx.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        ctx.state.user = jwt.verify(header.slice(7), config.jwt.secret);
      } catch {
        // Ignore invalid tokens in optional mode
      }
    }
    await next();
  };
}

module.exports = { authenticate, optionalAuth };
