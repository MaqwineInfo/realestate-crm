const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Contact, Role, Stage, SubStage, ActionType, Tag, User, Tenant, AuditLog, Lead, LeadSource,
} = require('../../src/db/models');

test('contact book (§9, §37, §67)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const c = h.client();
  await c.login('admin@alpha.test');

  t.after(async () => { await h.stopServer(); });

  let contactId;

  await t.test('a contact is created with a normalized mobile', async () => {
    await c.get('/app/contacts/new');
    const res = await c.submit('/api/contacts', {
      firstName: 'Ravi', lastName: 'Desai', primaryMobile: '0 98200 11223',
      email: 'RAVI@Example.com ', city: 'Mumbai',
    }, '/app/contacts/new');
    assert.equal(res.status, 302);
    contactId = res.location.split('/').pop();

    const contact = await Contact.findOne({ tenantId, _id: contactId }).lean();
    assert.equal(contact.normalizedMobile, '+919820011223');
    assert.equal(contact.email, 'ravi@example.com', 'email is normalized too');
    assert.equal(contact.displayName, 'Ravi Desai');
  });

  await t.test('the same mobile cannot be entered twice (§9.2)', async () => {
    const res = await c.submit('/api/contacts', {
      firstName: 'Duplicate', primaryMobile: '+919820011223',
    }, '/app/contacts/new');
    assert.equal(res.status, 302);
    assert.match((await c.get('/app/contacts/new')).text, /already exists/i);
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919820011223' }), 1);
  });

  await t.test('an alternate mobile equal to the primary is rejected (§52.1)', async () => {
    await c.submit('/api/contacts', {
      firstName: 'Same', primaryMobile: '9820011999', altMobile: '9820011999',
    }, '/app/contacts/new');
    assert.match((await c.get('/app/contacts/new')).text, /different from the primary/i);
  });

  await t.test('a matching email on a different mobile is a warning, never a merge (§9.2)', async () => {
    await c.submit('/api/contacts', {
      firstName: 'Ravi', lastName: 'Twin', primaryMobile: '9820011224', email: 'ravi@example.com',
    }, '/app/contacts/new');
    assert.equal(await Contact.countDocuments({ tenantId, email: 'ravi@example.com' }), 2, 'both records survive');

    const page = await c.get(`/app/contacts/${contactId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /never merged automatically/i);
  });

  await t.test('opt-out flags are stored for campaign filtering (§67)', async () => {
    const res = await c.submit(`/api/contacts/${contactId}/consent`, {
      whatsappOptOut: '1', dnd: '1', reason: 'Customer asked',
    }, `/app/contacts/${contactId}`);
    assert.equal(res.status, 302);
    const contact = await Contact.findOne({ tenantId, _id: contactId }).lean();
    assert.equal(contact.consent.whatsappOptOut, true);
    assert.equal(contact.consent.dnd, true);
    assert.equal(contact.consent.smsOptOut, false);
    assert.ok(contact.consent.updatedAt);
  });

  await t.test('search finds a contact by any spelling of the mobile (§46)', async () => {
    const res = await c.get('/app/contacts?q=' + encodeURIComponent('098200 11223'));
    assert.equal(res.status, 200);
    assert.match(res.text, /Ravi Desai/);
  });

  await t.test('the contact page lists every inquiry that person made (§2.5)', async () => {
    const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
    const leadsService = require('../../src/services/leads');
    await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { contactId, sourceId: source._id, ownerUserId: orgA.admin._id },
    });
    const res = await c.get(`/app/contacts/${contactId}`);
    assert.match(res.text, /1 inquiry/);
  });
});

test('setup and configuration (§47, §78, §95)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const c = h.client();
  await c.login('admin@alpha.test');

  t.after(async () => { await h.stopServer(); });

  await t.test('a new tenant gets the documented default masters (§78)', async () => {
    const stages = await Stage.find({ tenantId }).sort({ displayOrder: 1 }).lean();
    assert.deepEqual(stages.map((s) => s.name), [
      'New Lead', 'Not Connected', 'Connected', 'Site Visit Planned',
      'Site Visit Done', 'Block Unit', 'Booked', 'Lost',
    ]);
    assert.equal(stages.find((s) => s.name === 'Booked').terminal, true);
    assert.equal(stages.find((s) => s.name === 'Booked').requiresNextAction, false);
    assert.equal(stages.find((s) => s.name === 'Connected').terminal, false);

    assert.equal(await ActionType.countDocuments({ tenantId }), 9);
    assert.equal(await SubStage.countDocuments({ tenantId }), 13);
    // V2 §181 adds Channel Partner Manager, Collection Manager and Collection
    // Executive to the five V1 roles.
    assert.equal(await Role.countDocuments({ tenantId }), 8);
    assert.ok(await Tag.countDocuments({ tenantId }) >= 6);
  });

  await t.test('an admin can add and deactivate a master item', async () => {
    await c.get('/app/setup/action-types');
    const res = await c.submit('/api/setup/action-types', { name: 'Send Payment Plan', semantic: 'OTHER' }, '/app/setup/action-types');
    assert.equal(res.status, 302);
    const created = await ActionType.findOne({ tenantId, name: 'Send Payment Plan' }).lean();
    assert.ok(created);

    await c.submit(`/api/setup/action-types/${created._id}/toggle`, {}, '/app/setup/action-types');
    assert.equal((await ActionType.findOne({ tenantId, _id: created._id }).lean()).active, false);
  });

  await t.test('a duplicate master name is refused with a readable message', async () => {
    await c.submit('/api/setup/action-types', { name: 'Call' }, '/app/setup/action-types');
    assert.match((await c.get('/app/setup/action-types')).text, /already in use/i);
  });

  await t.test('a custom stage can be added and renamed without breaking automation (§11.3)', async () => {
    await c.get('/app/setup/stages');
    const res = await c.submit('/api/setup/stages', {
      name: 'Negotiation', semanticType: 'CUSTOM_ACTIVE', displayOrder: '5', colorToken: 'amber', requiresNextAction: '1',
    }, '/app/setup/stages');
    assert.equal(res.status, 302);

    const stage = await Stage.findOne({ tenantId, name: 'Negotiation' }).lean();
    assert.equal(stage.semanticType, 'CUSTOM_ACTIVE');

    // Renaming the seeded Connected stage must not change its semantic type.
    const connected = await Stage.findOne({ tenantId, semanticType: 'CONNECTED' }).lean();
    await c.submit(`/api/setup/stages/${connected._id}`, {
      name: 'Spoke To Customer', semanticType: 'CONNECTED', displayOrder: String(connected.displayOrder),
      colorToken: connected.colorToken, requiresNextAction: '1',
    }, '/app/setup/stages');

    const renamed = await Stage.findOne({ tenantId, _id: connected._id }).lean();
    assert.equal(renamed.name, 'Spoke To Customer');
    assert.equal(renamed.semanticType, 'CONNECTED', 'automation still recognises it');
  });

  await t.test('a terminal stage is forced to not require a next action (§11.5)', async () => {
    await c.submit('/api/setup/stages', {
      name: 'Archived Deal', semanticType: 'CUSTOM_TERMINAL', terminal: '1', requiresNextAction: '1',
    }, '/app/setup/stages');
    const stage = await Stage.findOne({ tenantId, name: 'Archived Deal' }).lean();
    assert.equal(stage.terminal, true);
    assert.equal(stage.requiresNextAction, false);
  });

  await t.test('a stage holding active leads cannot be deactivated (§95)', async () => {
    const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
    const leadsService = require('../../src/services/leads');
    await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: 'Stage', primaryMobile: '9333300001', sourceId: source._id, ownerUserId: orgA.admin._id },
    });
    const newStage = await Stage.findOne({ tenantId, semanticType: 'NEW' }).lean();
    await c.submit(`/api/setup/stages/${newStage._id}/toggle`, {}, '/app/setup/stages');
    assert.equal((await Stage.findOne({ tenantId, _id: newStage._id }).lean()).active, true, 'still active');
    assert.match((await c.get('/app/setup/stages')).text, /active lead/i);
  });

  await t.test('inviting a user produces a single-use activation link (§5.1)', async () => {
    const role = await Role.findOne({ tenantId, name: 'Sales User' }).lean();
    await c.get('/app/setup/users');
    const res = await c.submit('/api/setup/users', {
      name: 'New Joiner', email: 'joiner@alpha.test', roleId: String(role._id),
    }, '/app/setup/users');
    assert.equal(res.status, 302);

    const page = await c.get('/app/setup/users');
    const link = page.text.match(/\/accept-invite\?token=([A-Za-z0-9_-]+)/);
    assert.ok(link, 'the admin is shown the activation link');
    assert.equal((await User.findOne({ tenantId, email: 'joiner@alpha.test' }).lean()).status, 'INVITED');

    const invited = h.client();
    const activated = await invited.submit('/accept-invite', {
      token: link[1], password: 'Password1', confirm: 'Password1',
    }, `/accept-invite?token=${link[1]}`);
    assert.equal(activated.location, '/app/dashboard');
    assert.equal((await User.findOne({ tenantId, email: 'joiner@alpha.test' }).lean()).status, 'ACTIVE');
    assert.equal((await invited.get('/app/dashboard')).status, 200);
  });

  await t.test('a user still holding active leads cannot be deactivated (§102)', async () => {
    const seller = await User.findOne({ tenantId, email: 'joiner@alpha.test' }).lean();
    const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
    const leadsService = require('../../src/services/leads');
    await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: 'Owned', primaryMobile: '9333300002', sourceId: source._id, ownerUserId: seller._id },
    });

    await c.submit(`/api/setup/users/${seller._id}/status`, { status: 'INACTIVE' }, '/app/setup/users');
    assert.equal((await User.findOne({ tenantId, _id: seller._id }).lean()).status, 'ACTIVE');
    assert.match((await c.get('/app/setup/users')).text, /Transfer them first/i);
  });

  await t.test('role permissions are editable and audited (§6, §56)', async () => {
    const role = await Role.findOne({ tenantId, name: 'Sales User' }).lean();
    await c.get(`/app/setup/roles/${role._id}`);
    const res = await c.submit(`/api/setup/roles/${role._id}`, {
      name: 'Sales Executive',
      'perm.lead.view': 'team',
      'perm.lead.create': '1',
      'perm.lead.transfer': '1',
    }, `/app/setup/roles/${role._id}`);
    assert.equal(res.status, 302);

    const updated = await Role.findOne({ tenantId, _id: role._id }).lean();
    assert.equal(updated.name, 'Sales Executive');
    assert.equal(updated.permissions['lead.view'], 'team');
    assert.equal(updated.permissions['lead.transfer'], true);
    assert.equal(updated.permissions['lead.mark_lost'], undefined, 'unchecked permissions are removed');

    const logged = await AuditLog.findOne({ tenantId, entity: 'Role', action: 'PERMISSIONS_CHANGE' }).lean();
    assert.ok(logged, 'permission changes are audited');
    assert.ok(logged.before && logged.after);
  });

  await t.test('a non-admin cannot reach setup at all (§74)', async () => {
    const sales = h.client();
    await sales.login('joiner@alpha.test');
    assert.equal((await sales.get('/app/setup/users')).status, 403);
    assert.equal((await sales.get('/app/setup/roles')).status, 403);

    const role = await Role.findOne({ tenantId, name: 'Organization Admin' }).lean();
    const attempt = await sales.submit(`/api/setup/roles/${role._id}`, { 'perm.setup.roles': '1' }, '/app/dashboard');
    assert.notEqual(attempt.status, 200);
    const unchanged = await Role.findOne({ tenantId, _id: role._id }).lean();
    assert.equal(unchanged.isAdmin, true);
  });

  await t.test('organization settings drive currency and timezone display (§72, §73)', async () => {
    await c.get('/app/setup/organization');
    const res = await c.submit('/api/setup/organization', {
      name: 'Alpha Realty', timezone: 'Asia/Dubai', currency: 'AED', locale: 'en-AE',
    }, '/app/setup/organization');
    assert.equal(res.status, 302);
    const tenant = await Tenant.findById(tenantId).lean();
    assert.equal(tenant.timezone, 'Asia/Dubai');
    assert.equal(tenant.currency, 'AED');

    const lead = await Lead.findOne({ tenantId, budgetMinMinor: { $ne: null } }).lean();
    if (lead) {
      const page = await c.get(`/app/leads/${lead._id}`);
      assert.equal(page.status, 200);
    }
  });
});
