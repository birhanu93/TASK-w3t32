const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ROLE_ALIASES, resolveRoleAlias } = require('../../src/middleware/rbac');

describe('RBAC role aliases', () => {
  it('should map OManager to Operations Manager', () => {
    assert.equal(resolveRoleAlias('OManager'), 'Operations Manager');
  });

  it('should pass through canonical names unchanged', () => {
    assert.equal(resolveRoleAlias('Administrator'), 'Administrator');
    assert.equal(resolveRoleAlias('Coach'), 'Coach');
    assert.equal(resolveRoleAlias('Reviewer'), 'Reviewer');
    assert.equal(resolveRoleAlias('Participant'), 'Participant');
  });

  it('should pass through Operations Manager as-is', () => {
    assert.equal(resolveRoleAlias('Operations Manager'), 'Operations Manager');
  });

  it('should pass through unknown roles unchanged', () => {
    assert.equal(resolveRoleAlias('SuperAdmin'), 'SuperAdmin');
  });

  it('ROLE_ALIASES should include OManager entry', () => {
    assert.ok('OManager' in ROLE_ALIASES);
    assert.equal(ROLE_ALIASES['OManager'], 'Operations Manager');
  });
});
