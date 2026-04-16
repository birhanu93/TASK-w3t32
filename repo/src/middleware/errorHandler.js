const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

module.exports = function errorHandler() {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof AppError) {
        ctx.status = err.status;
        ctx.body = {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details && { details: err.details }),
          },
        };
      } else {
        logger.error({ err, path: ctx.path, method: ctx.method }, 'Unhandled error');
        ctx.status = 500;
        ctx.body = {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Internal server error',
          },
        };
      }
    }
  };
};
