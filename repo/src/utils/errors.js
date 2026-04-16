class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const Errors = {
  badRequest: (msg, details) => new AppError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Access denied') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Resource not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg, details) => new AppError(409, 'CONFLICT', msg, details),
  locked: (msg) => new AppError(423, 'LOCKED', msg),
  tooMany: (msg) => new AppError(429, 'TOO_MANY_REQUESTS', msg),
  internal: (msg = 'Internal server error') => new AppError(500, 'INTERNAL_ERROR', msg),
};

module.exports = { AppError, Errors };
