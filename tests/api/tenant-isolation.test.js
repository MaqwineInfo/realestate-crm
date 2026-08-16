const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { Lead, Contact, LeadSource, Stage } = require('../../src/db/models');
const leadsService = require('../../src/services/leads');

/** Spec §4.2 / §122.4: one tenant's data must never surface in another. */
test('tenant isolation', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();

  const sourceA = await LeadSource.findOne({ tenantId: orgA.tenant._id, category: 'MANUAL' }).lean();
  const { lead: leadA } = await leadsService.create({
    tenantId: orgA.tenant._id,
    tenant: orgA.tenant,
    actor: orgA.admin,
    data: {
      firstName: 'Alpha', lastName: 'Customer', primaryMobile: '9111100001',
      sourceId: sourceA._id, ownerUserId: orgA.admin._id,
    },
  });

  t.after(async () => { await h.stopServer(); });

  await t.test("another tenant's admin cannot open the lead", async () => {
    const c = h.client();
    await c.login('admin@beta.test');
    const res = await c.get(`/app/leads/${leadA._id}`);
    assert.equal(res.status, 404, 'must look like it does not exist, not like it is forbidden');
  });

  await t.test("another tenant's lead list is empty", async () => {
    const c = h.client();
    await c.login('admin@beta.test');
    const res = await c.get('/app/leads');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('Alpha Customer'));
  });

  await t.test("another tenant cannot mutate the lead", async () => {
    const c = h.client();
    await c.login('admin@beta.test');
    await c.get('/app/leads');
    const stageB = await Stage.findOne({ tenantId: orgB.tenant._id, semanticType: 'CONNECTED' }).lean();
    const res = await c.submit(`/api/leads/${leadA._id}/stage`, { stageId: String(stageB._id) }, '/app/leads');
    assert.notEqual(res.status, 200);

    const unchanged = await Lead.findOne({ tenantId: orgA.tenant._id, _id: leadA._id }).lean();
    assert.equal(String(unchanged.stageId), String(leadA.stageId));
  });

  await t.test('the same mobile can exist independently in both tenants', async () => {
    const contactsService = require('../../src/services/contacts');
    const created = await contactsService.create({
      tenantId: orgB.tenant._id,
      tenant: orgB.tenant,
      actor: orgB.admin,
      payload: { firstName: 'Beta', primaryMobile: '9111100001' },
    });
    assert.ok(created._id);
    const inA = await Contact.countDocuments({ tenantId: orgA.tenant._id, normalizedMobile: '+919111100001' });
    const inB = await Contact.countDocuments({ tenantId: orgB.tenant._id, normalizedMobile: '+919111100001' });
    assert.equal(inA, 1);
    assert.equal(inB, 1);
  });

  await t.test('a query without a tenant filter throws instead of leaking (§4.2)', async () => {
    await assert.rejects(() => Lead.find({ status: 'ACTIVE' }), /missing a tenantId filter/);
    await assert.rejects(() => Contact.findOne({ normalizedMobile: '+919111100001' }), /missing a tenantId filter/);
    await assert.rejects(
      () => Lead.aggregate([{ $group: { _id: '$stageId', n: { $sum: 1 } } }]),
      /must start with a \$match on tenantId/,
    );
  });

  await t.test('the guard accepts a tenant filter nested in $and', async () => {
    const rows = await Lead.find({ $and: [{ tenantId: orgA.tenant._id }, { status: 'ACTIVE' }] });
    assert.equal(rows.length, 1);
  });

  await t.test('an $or that misses one branch is still rejected', async () => {
    await assert.rejects(
      () => Lead.find({ $or: [{ tenantId: orgA.tenant._id }, { status: 'ACTIVE' }] }),
      /missing a tenantId filter/,
    );
  });
});
