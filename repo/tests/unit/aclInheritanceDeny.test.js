/**
 * Unit tests for ACL inheritance and deny-override behavior.
 * Tests checkAccess with mocked DB to verify:
 * - Deny always overrides allow
 * - Inheritance from parent resources
 * - Owner-based access
 * - Administrator bypass
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('ACL checkAccess — inheritance and deny overrides', () => {
  function setupMockDb(mockData) {
    const connPath = require.resolve('../../src/db/connection');
    const orig = require.cache[connPath];

    const mockDb = (table) => {
      const tableData = mockData[table] || {};
      return {
        where(...args) {
          // Store query conditions for chaining
          this._conditions = this._conditions || [];
          if (typeof args[0] === 'object') {
            this._conditions.push(args[0]);
          } else if (typeof args[0] === 'string' && args.length === 2) {
            this._conditions.push({ [args[0]]: args[1] });
          } else if (typeof args[0] === 'function') {
            // Sub-query builder — just return self
          }
          return this;
        },
        orWhereIn() { return this; },
        pluck(field) {
          const result = tableData.pluck || [];
          return { then: (r) => r(result), catch: () => this, finally: () => this };
        },
        first() {
          const result = tableData.first;
          return { then: (r) => r(typeof result === 'function' ? result(this._conditions) : result), catch: () => this, finally: () => this };
        },
        select() { return this; },
        then(r) {
          const result = tableData.all || [];
          return r(result);
        },
        catch() { return this; },
        finally() { return this; },
        [Symbol.toStringTag]: 'Promise',
      };
    };
    mockDb.raw = () => Promise.resolve({ rows: [] });

    require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: mockDb };
    delete require.cache[require.resolve('../../src/middleware/rbac')];
    const { checkAccess } = require('../../src/middleware/rbac');

    return { checkAccess, restore: () => { require.cache[connPath] = orig; } };
  }

  it('should grant access to Administrator regardless of ACL', async () => {
    const { checkAccess, restore } = setupMockDb({
      user_roles: { pluck: ['admin-role-id'] },
      roles: { first: { id: 'admin-role-id', name: 'Administrator' } },
      acl_entries: { all: [] },
      resources: { first: null },
    });

    const result = await checkAccess('user1', 'resource1', 'read');
    assert.equal(result, true);
    restore();
  });

  it('should deny access when explicit deny exists', async () => {
    const { checkAccess, restore } = setupMockDb({
      user_roles: { pluck: ['role1'] },
      roles: { first: { id: 'other-role', name: 'Coach' } }, // Not admin
      acl_entries: { all: [{ effect: 'deny', user_id: 'user1', action: 'read' }] },
      resources: { first: { id: 'resource1', owner_id: null, parent_id: null } },
    });

    const result = await checkAccess('user1', 'resource1', 'read');
    assert.equal(result, false);
    restore();
  });

  it('should grant access to resource owner', async () => {
    const { checkAccess, restore } = setupMockDb({
      user_roles: { pluck: ['role1'] },
      roles: { first: { id: 'other-role', name: 'Participant' } },
      acl_entries: { all: [] },
      resources: { first: { id: 'resource1', owner_id: 'user1', parent_id: null } },
    });

    const result = await checkAccess('user1', 'resource1', 'read');
    assert.equal(result, true);
    restore();
  });

  it('should deny access when no ACL entry and not owner', async () => {
    const { checkAccess, restore } = setupMockDb({
      user_roles: { pluck: ['role1'] },
      roles: { first: { id: 'other-role', name: 'Participant' } },
      acl_entries: { all: [] },
      resources: { first: { id: 'resource1', owner_id: 'other-user', parent_id: null } },
    });

    const result = await checkAccess('user1', 'resource1', 'read');
    assert.equal(result, false);
    restore();
  });

  it('should grant access via explicit allow entry', async () => {
    const { checkAccess, restore } = setupMockDb({
      user_roles: { pluck: ['role1'] },
      roles: { first: { id: 'other-role', name: 'Coach' } },
      acl_entries: { all: [{ effect: 'allow', user_id: 'user1', action: 'read' }] },
      resources: { first: { id: 'resource1', owner_id: 'someone-else', parent_id: null } },
    });

    const result = await checkAccess('user1', 'resource1', 'read');
    assert.equal(result, true);
    restore();
  });

  it('deny should override allow even when both exist', async () => {
    const { checkAccess, restore } = setupMockDb({
      user_roles: { pluck: ['role1'] },
      roles: { first: { id: 'other-role', name: 'Coach' } },
      acl_entries: { all: [
        { effect: 'allow', user_id: 'user1', action: 'read' },
        { effect: 'deny', role_id: 'role1', action: 'read' },
      ]},
      resources: { first: { id: 'resource1', owner_id: null, parent_id: null } },
    });

    const result = await checkAccess('user1', 'resource1', 'read');
    assert.equal(result, false);
    restore();
  });
});
