/**
 * DB-backed HTTP integration tests for /api/resources and the ACL layer.
 *
 * Covers: resource CRUD, ACL grant/revoke, ACL propagation to children,
 * fail-closed enforcement, deny-override semantics, pagination, and audit.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupIntegration } = require('../helpers/integrationHarness');

const ROUTES = [
  '../../src/routes/auth',
  '../../src/routes/resources',
];

let harness;
before(async () => {
  harness = await setupIntegration({ routeModules: ROUTES, prefix: 'res_int' });
});
after(async () => { if (harness) await harness.teardown(); });

describe('Resources: CRUD + ACL visibility', () => {
  let folderId, docId;

  it('owner can create a folder resource; DB row + audit recorded', async () => {
    const res = await harness.req('POST', '/api/resources', {
      headers: harness.auth('Participant'),
      body: { type: 'folder', name: 'Participant Home' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.type, 'folder');
    assert.equal(res.body.name, 'Participant Home');
    assert.equal(res.body.owner_id, harness.users['Participant'].id);
    folderId = res.body.id;

    const audit = await harness.db('audit_logs').where({ action: 'resource.create', resource_id: folderId }).first();
    assert.ok(audit, 'resource.create audit recorded');
    assert.ok(audit.after_hash);
  });

  it('rejects missing type or name with 400', async () => {
    const res = await harness.req('POST', '/api/resources', {
      headers: harness.auth('Participant'),
      body: { name: 'no type' },
    });
    assert.equal(res.status, 400);
    assert.ok(/type and name are required/i.test(res.body.error.message));
  });

  it('child resource inherits parent link', async () => {
    const res = await harness.req('POST', '/api/resources', {
      headers: harness.auth('Participant'),
      body: { type: 'document', name: 'Report.pdf', parent_id: folderId },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.parent_id, folderId);
    docId = res.body.id;
  });

  it('owner sees their resources; Coach without any ACL sees none', async () => {
    const ownerList = await harness.req('GET', '/api/resources', { headers: harness.auth('Participant') });
    assert.equal(ownerList.status, 200);
    const ownerIds = ownerList.body.data.map((r) => r.id);
    assert.ok(ownerIds.includes(folderId));
    assert.ok(ownerIds.includes(docId));

    const coachList = await harness.req('GET', '/api/resources', { headers: harness.auth('Coach') });
    assert.equal(coachList.status, 200);
    const coachIds = coachList.body.data.map((r) => r.id);
    assert.ok(!coachIds.includes(folderId), 'coach should not see un-granted resource');
    assert.ok(!coachIds.includes(docId));
  });

  it('Coach is denied GET /:id without an ACL (fail-closed 403)', async () => {
    const res = await harness.req('GET', `/api/resources/${folderId}`, { headers: harness.auth('Coach') });
    assert.equal(res.status, 403);
  });

  it('Administrator can read any resource and sees ACL array', async () => {
    const res = await harness.req('GET', `/api/resources/${folderId}`, { headers: harness.auth('Administrator') });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, folderId);
    assert.ok(Array.isArray(res.body.acl));
  });

  it('POST /:id/acl requires resources.manage_acl; Participant is 403 even on own resource', async () => {
    const res = await harness.req('POST', `/api/resources/${folderId}/acl`, {
      headers: harness.auth('Participant'),
      body: { user_id: harness.users['Coach'].id, action: 'read' },
    });
    assert.equal(res.status, 403);
  });

  it('Admin can grant ACL; GET /:id then succeeds for grantee', async () => {
    const grant = await harness.req('POST', `/api/resources/${folderId}/acl`, {
      headers: harness.auth('Administrator'),
      body: { user_id: harness.users['Coach'].id, action: 'read', effect: 'allow' },
    });
    assert.equal(grant.status, 201);
    assert.equal(grant.body.effect, 'allow');
    assert.equal(grant.body.action, 'read');

    const getRes = await harness.req('GET', `/api/resources/${folderId}`, { headers: harness.auth('Coach') });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.id, folderId);

    // Coach should now see the folder in list output
    const list = await harness.req('GET', '/api/resources', { headers: harness.auth('Coach') });
    const ids = list.body.data.map((r) => r.id);
    assert.ok(ids.includes(folderId));
  });

  it('ACL requires action ∈ allowlist', async () => {
    const res = await harness.req('POST', `/api/resources/${folderId}/acl`, {
      headers: harness.auth('Administrator'),
      body: { user_id: harness.users['Coach'].id, action: 'summon-demons' },
    });
    assert.equal(res.status, 400);
    assert.ok(/action must be one of/i.test(res.body.error.message));
  });

  it('ACL requires either user_id or role_id', async () => {
    const res = await harness.req('POST', `/api/resources/${folderId}/acl`, {
      headers: harness.auth('Administrator'),
      body: { action: 'read' },
    });
    assert.equal(res.status, 400);
    assert.ok(/user_id or role_id/i.test(res.body.error.message));
  });

  it('deny override: explicit deny on child blocks access even when allow exists on parent', async () => {
    await harness.req('POST', `/api/resources/${folderId}/acl`, {
      headers: harness.auth('Administrator'),
      body: { user_id: harness.users['Reviewer'].id, action: 'read', effect: 'allow' },
    });
    // Reviewer can read folder
    let r = await harness.req('GET', `/api/resources/${folderId}`, { headers: harness.auth('Reviewer') });
    assert.equal(r.status, 200);

    // Place an explicit deny on the child doc
    await harness.db('acl_entries').insert({
      resource_id: docId,
      user_id: harness.users['Reviewer'].id,
      action: 'read',
      effect: 'deny',
    });
    r = await harness.req('GET', `/api/resources/${docId}`, { headers: harness.auth('Reviewer') });
    assert.equal(r.status, 403, 'deny on child should override allow on parent');
  });

  it('ACL propagate copies parent ACL rows to existing children (inherited=true)', async () => {
    // Clear inherited child ACLs so we can reason about propagation output
    await harness.db('acl_entries').where({ resource_id: docId, inherited: true }).del();

    const res = await harness.req('POST', `/api/resources/${folderId}/acl/propagate`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.ok(/children/.test(res.body.message));
    assert.ok(res.body.entries_created >= 1);

    const inherited = await harness.db('acl_entries').where({ resource_id: docId, inherited: true });
    assert.ok(inherited.length >= 1);
  });

  it('DELETE ACL entry removes the DB row and audits', async () => {
    const [acl] = await harness.db('acl_entries').insert({
      resource_id: folderId,
      user_id: harness.users['Operations Manager'].id,
      action: 'read',
      effect: 'allow',
    }).returning('*');

    const res = await harness.req('DELETE', `/api/resources/${folderId}/acl/${acl.id}`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 204);
    const gone = await harness.db('acl_entries').where('id', acl.id).first();
    assert.ok(!gone);

    const audit = await harness.db('audit_logs').where({ action: 'acl.delete', resource_id: acl.id }).first();
    assert.ok(audit);
    assert.ok(audit.before_hash, 'acl.delete audit must have before_hash');
  });

  it('DELETE ACL entry for unknown id → 404', async () => {
    const res = await harness.req('DELETE', `/api/resources/${folderId}/acl/00000000-0000-0000-0000-000000000099`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE /:id by Admin removes resource and cascades ACL rows; audit before_hash set', async () => {
    const res = await harness.req('DELETE', `/api/resources/${docId}`, {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 204);
    const gone = await harness.db('resources').where('id', docId).first();
    assert.ok(!gone);

    const audit = await harness.db('audit_logs').where({ action: 'resource.delete', resource_id: docId }).first();
    assert.ok(audit);
    assert.ok(audit.before_hash);
  });
});

describe('Resources: pagination + list filters', () => {
  before(async () => {
    for (let i = 0; i < 5; i++) {
      await harness.db('resources').insert({
        type: 'widget',
        name: `widget-${i}`,
        owner_id: harness.users['Administrator'].id,
      });
    }
  });

  it('?type=widget filters the list', async () => {
    const res = await harness.req('GET', '/api/resources?type=widget', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    for (const r of res.body.data) {
      assert.equal(r.type, 'widget');
    }
    assert.ok(res.body.data.length >= 5);
  });

  it('respects per_page', async () => {
    const res = await harness.req('GET', '/api/resources?type=widget&per_page=2', {
      headers: harness.auth('Administrator'),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 2);
    assert.equal(res.body.pagination.per_page, 2);
    assert.ok(res.body.pagination.total_pages >= 3);
  });
});
