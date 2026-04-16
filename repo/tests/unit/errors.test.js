const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AppError, Errors } = require('../../src/utils/errors');

describe('AppError', () => {
  it('should be an instance of Error', () => {
    const err = new AppError(400, 'TEST', 'test message');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof AppError);
  });

  it('should set status, code, message, details', () => {
    const err = new AppError(422, 'VALIDATION', 'bad field', { field: 'name' });
    assert.equal(err.status, 422);
    assert.equal(err.code, 'VALIDATION');
    assert.equal(err.message, 'bad field');
    assert.deepEqual(err.details, { field: 'name' });
  });

  it('should default details to null', () => {
    const err = new AppError(500, 'X', 'msg');
    assert.equal(err.details, null);
  });
});

describe('Errors factory', () => {
  it('badRequest returns 400', () => {
    const err = Errors.badRequest('bad');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'BAD_REQUEST');
    assert.equal(err.message, 'bad');
  });

  it('badRequest with details', () => {
    const err = Errors.badRequest('bad', { field: 'x' });
    assert.deepEqual(err.details, { field: 'x' });
  });

  it('unauthorized returns 401 with default message', () => {
    const err = Errors.unauthorized();
    assert.equal(err.status, 401);
    assert.equal(err.code, 'UNAUTHORIZED');
    assert.equal(err.message, 'Authentication required');
  });

  it('unauthorized with custom message', () => {
    const err = Errors.unauthorized('custom');
    assert.equal(err.message, 'custom');
  });

  it('forbidden returns 403', () => {
    const err = Errors.forbidden();
    assert.equal(err.status, 403);
    assert.equal(err.code, 'FORBIDDEN');
    assert.equal(err.message, 'Access denied');
  });

  it('forbidden with custom message', () => {
    const err = Errors.forbidden('nope');
    assert.equal(err.message, 'nope');
  });

  it('notFound returns 404', () => {
    const err = Errors.notFound();
    assert.equal(err.status, 404);
    assert.equal(err.message, 'Resource not found');
  });

  it('notFound with custom message', () => {
    const err = Errors.notFound('User not found');
    assert.equal(err.message, 'User not found');
  });

  it('conflict returns 409', () => {
    const err = Errors.conflict('duplicate');
    assert.equal(err.status, 409);
    assert.equal(err.code, 'CONFLICT');
  });

  it('locked returns 423', () => {
    const err = Errors.locked('account locked');
    assert.equal(err.status, 423);
    assert.equal(err.code, 'LOCKED');
  });

  it('tooMany returns 429', () => {
    const err = Errors.tooMany('rate limited');
    assert.equal(err.status, 429);
    assert.equal(err.code, 'TOO_MANY_REQUESTS');
  });

  it('internal returns 500 with default message', () => {
    const err = Errors.internal();
    assert.equal(err.status, 500);
    assert.equal(err.message, 'Internal server error');
  });

  it('internal with custom message', () => {
    const err = Errors.internal('oops');
    assert.equal(err.message, 'oops');
  });
});
