const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../../src/config');
const { AppError } = require('../../src/utils/errors');
const { makeToken, makeExpiredToken, FIXTURES } = require('../setup');

// ─── Error Handler ──────────────────────────────────────────────────────
describe('errorHandler middleware', () => {
  // We require it fresh to avoid module cache issues
  const errorHandler = require('../../src/middleware/errorHandler');

  function makeCtx() {
    return { status: 200, body: null, path: '/test', method: 'GET' };
  }

  it('should catch AppError and set status/body', async () => {
    const mw = errorHandler();
    const ctx = makeCtx();
    await mw(ctx, async () => {
      throw new AppError(400, 'BAD_REQUEST', 'test error', { field: 'x' });
    });
    assert.equal(ctx.status, 400);
    assert.deepEqual(ctx.body, {
      error: { code: 'BAD_REQUEST', message: 'test error', details: { field: 'x' } },
    });
  });

  it('should omit details when null', async () => {
    const mw = errorHandler();
    const ctx = makeCtx();
    await mw(ctx, async () => {
      throw new AppError(404, 'NOT_FOUND', 'missing');
    });
    assert.equal(ctx.body.error.details, undefined);
  });

  it('should handle generic errors as 500', async () => {
    const mw = errorHandler();
    const ctx = makeCtx();
    await mw(ctx, async () => {
      throw new Error('unexpected');
    });
    assert.equal(ctx.status, 500);
    assert.equal(ctx.body.error.code, 'INTERNAL_ERROR');
  });

  it('should pass through when no error', async () => {
    const mw = errorHandler();
    const ctx = makeCtx();
    await mw(ctx, async () => {
      ctx.body = { ok: true };
    });
    assert.deepEqual(ctx.body, { ok: true });
  });
});

// ─── Auth Middleware ─────────────────────────────────────────────────────
describe('auth middleware', () => {
  // Mock db/connection so authenticate() can check is_active
  const connPath = require.resolve('../../src/db/connection');
  const origConn = require.cache[connPath];
  function chain(v) {
    const c = new Proxy({}, { get(_, p) {
      if (p === 'then') return (r) => r(v);
      if (p === 'catch' || p === 'finally') return () => c;
      if (p === Symbol.toStringTag) return 'Promise';
      return () => c;
    }});
    return c;
  }
  const mockDb = (t) => chain({ is_active: true });
  mockDb.raw = () => Promise.resolve({ rows: [] });
  require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
  // Clear auth module cache so it picks up the mock
  delete require.cache[require.resolve('../../src/middleware/auth')];

  const { authenticate, optionalAuth } = require('../../src/middleware/auth');

  function makeCtx(authHeaderValue) {
    return {
      headers: { authorization: authHeaderValue },
      state: {},
    };
  }

  describe('authenticate', () => {
    it('should set ctx.state.user for valid token', async () => {
      const token = makeToken(FIXTURES.adminUser);
      const ctx = makeCtx(`Bearer ${token}`);
      let nextCalled = false;
      await authenticate()(ctx, async () => { nextCalled = true; });
      assert.ok(nextCalled);
      assert.equal(ctx.state.user.id, FIXTURES.adminUser.id);
      assert.equal(ctx.state.user.username, FIXTURES.adminUser.username);
    });

    it('should throw 401 for missing header', async () => {
      const ctx = makeCtx(undefined);
      await assert.rejects(
        () => authenticate()(ctx, async () => {}),
        (err) => err.status === 401
      );
    });

    it('should throw 401 for non-Bearer header', async () => {
      const ctx = makeCtx('Basic abc123');
      await assert.rejects(
        () => authenticate()(ctx, async () => {}),
        (err) => err.status === 401
      );
    });

    it('should throw 401 for invalid token', async () => {
      const ctx = makeCtx('Bearer invalid.token.here');
      await assert.rejects(
        () => authenticate()(ctx, async () => {}),
        (err) => err.status === 401 && err.message === 'Invalid token'
      );
    });

    it('should throw 401 for expired token', async () => {
      const token = makeExpiredToken(FIXTURES.adminUser);
      const ctx = makeCtx(`Bearer ${token}`);
      await assert.rejects(
        () => authenticate()(ctx, async () => {}),
        (err) => err.status === 401 && err.message === 'Token has expired'
      );
    });
  });

  describe('optionalAuth', () => {
    it('should set user for valid token', async () => {
      const token = makeToken(FIXTURES.participantUser);
      const ctx = makeCtx(`Bearer ${token}`);
      let nextCalled = false;
      await optionalAuth()(ctx, async () => { nextCalled = true; });
      assert.ok(nextCalled);
      assert.equal(ctx.state.user.id, FIXTURES.participantUser.id);
    });

    it('should not fail for missing header', async () => {
      const ctx = makeCtx(undefined);
      let nextCalled = false;
      await optionalAuth()(ctx, async () => { nextCalled = true; });
      assert.ok(nextCalled);
      assert.equal(ctx.state.user, undefined);
    });

    it('should not fail for invalid token', async () => {
      const ctx = makeCtx('Bearer bad.token');
      let nextCalled = false;
      await optionalAuth()(ctx, async () => { nextCalled = true; });
      assert.ok(nextCalled);
      assert.equal(ctx.state.user, undefined);
    });

    it('should not fail for non-Bearer header', async () => {
      const ctx = makeCtx('Basic xxx');
      let nextCalled = false;
      await optionalAuth()(ctx, async () => { nextCalled = true; });
      assert.ok(nextCalled);
      assert.equal(ctx.state.user, undefined);
    });
  });
});

// ─── Metrics Middleware ─────────────────────────────────────────────────
describe('metrics middleware', () => {
  const { metricsMiddleware, getMetrics } = require('../../src/middleware/metrics');

  it('should track request count', async () => {
    const before = getMetrics().total_requests;
    const ctx = { method: 'GET', path: '/test', status: 200, state: {} };
    await metricsMiddleware()(ctx, async () => {});
    const after = getMetrics().total_requests;
    assert.ok(after > before);
  });

  it('should track errors', async () => {
    const before = getMetrics().total_errors;
    const ctx = { method: 'GET', path: '/fail', status: 500, state: {} };
    try {
      await metricsMiddleware()(ctx, async () => { throw new Error('boom'); });
    } catch { /* expected */ }
    const after = getMetrics().total_errors;
    assert.ok(after > before);
  });

  it('should re-throw errors', async () => {
    const ctx = { method: 'GET', path: '/fail', status: 500, state: {} };
    await assert.rejects(
      () => metricsMiddleware()(ctx, async () => { throw new Error('rethrow'); }),
      { message: 'rethrow' }
    );
  });

  it('getMetrics should return expected shape', () => {
    const m = getMetrics();
    assert.equal(typeof m.total_requests, 'number');
    assert.equal(typeof m.total_errors, 'number');
    assert.equal(typeof m.p95_latency_ms, 'number');
    assert.equal(typeof m.avg_latency_ms, 'number');
  });
});

// ─── Audit Middleware ───────────────────────────────────────────────────
describe('audit middleware', () => {
  const { auditMiddleware } = require('../../src/middleware/audit');

  it('should attach ctx.audit function', async () => {
    const ctx = { state: { user: { id: 'u1' } }, ip: '127.0.0.1' };
    let nextCalled = false;
    await auditMiddleware()(ctx, async () => {
      nextCalled = true;
      assert.equal(typeof ctx.audit, 'function');
    });
    assert.ok(nextCalled);
  });
});
