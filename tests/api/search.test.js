const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { Lead, LeadSource } = require('../../src/db/models');

/**
 * V1.1 §131: dashboard search.
 *
 * The one deliberate scope widening in the product lives here (§5.4): an exact
 * normalized mobile is looked up tenant-wide so the team stops creating duplicate
 * contacts. These tests exist to prove that widening leaks *ownership* and
 * nothing else — no timeline, no pricing, no requirement, and never across
 * tenants.
 */
test('dashboard search access states (V1.1 §5, §123)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const manager = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Mia Manager', email: 'mia@alpha.test', roleName: 'Sales Manager',
  });
  const owner = await h.addUser({
    tenant: orgA.tenant,
    roles: orgA.roles,
    name: 'Priya Owner',
    email: 'priya@alpha.test',
    roleName: 'Sales User',
    managerId: manager._id,
  });
  const stranger = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Vik Stranger', email: 'vik@alpha.test', roleName: 'Sales User',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();

  const admin = h.client();
  await admin.login('admin@alpha.test');
  const created = await admin.submit('/api/leads', {
    firstName: 'Rahul', lastName: 'Shah', primaryMobile: '9876543210',
    sourceId: String(source._id), ownerUserId: String(owner._id),
    budgetMaxMinor: '9000000', requirementNote: 'Wants a riverfront 3 BHK',
  }, '/app/leads/new');
  const leadId = created.location.split('/').pop();

  t.after(async () => { await h.stopServer(); });

  await t.test('the owner gets an editable result', async () => {
    const priya = h.client();
    await priya.login('priya@alpha.test');
    const res = await priya.get('/api/search?q=9876543210', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.results.length, 1);
    const hit = res.data.results[0];
    assert.equal(hit.access, 'EDIT');
    assert.equal(hit.contactName, 'Rahul Shah');
    assert.equal(hit.owner.name, 'Priya Owner');
    assert.equal(hit.isNew, true, 'an unworked lead is flagged new');
    assert.equal(hit.temperature, 'WARM');
  });

  await t.test('a manager sees their team member’s lead normally', async () => {
    const mia = h.client();
    await mia.login('mia@alpha.test');
    const res = await mia.get('/api/search?q=9876543210', { headers: { accept: 'application/json' } });
    assert.equal(res.data.results[0].access, 'EDIT');
    assert.equal(res.data.results[0].stage, 'New Lead');
  });

  await t.test('another own-scope salesperson gets ownership only, never the detail (§5.6)', async () => {
    const vik = h.client();
    await vik.login('vik@alpha.test');
    const res = await vik.get('/api/search?q=9876543210', { headers: { accept: 'application/json' } });
    assert.equal(res.data.results.length, 1, 'the customer is found, so no duplicate gets created');

    const hit = res.data.results[0];
    assert.equal(hit.access, 'OWNERSHIP_ONLY');
    assert.equal(hit.owner.name, 'Priya Owner', 'who owns it is the whole point');
    assert.equal(hit.contactName, 'Rahul Shah');
    // Everything a competitor for the same customer must not learn:
    assert.equal(hit.temperature, undefined);
    assert.equal(hit.nextActionAt, undefined);
    assert.equal(hit.subStage, undefined);
    assert.equal(hit.latestInquiryAt, undefined);
    assert.equal(JSON.stringify(hit).includes('riverfront'), false, 'no requirement detail leaks');
  });

  await t.test('name search cannot bypass data scope (§5.4)', async () => {
    const vik = h.client();
    await vik.login('vik@alpha.test');
    const res = await vik.get('/api/search?q=Rahul', { headers: { accept: 'application/json' } });
    assert.equal(res.data.results.length, 0, 'fuzzy search stays inside the caller’s scope');
  });

  await t.test('another tenant can never see the lead, even on an exact mobile', async () => {
    const beta = h.client();
    await beta.login('admin@beta.test');
    const res = await beta.get('/api/search?q=9876543210', { headers: { accept: 'application/json' } });
    assert.equal(res.data.results.length, 0);
  });

  await t.test('a mobile with no match offers capture with the number prefilled (§5.8)', async () => {
    const priya = h.client();
    await priya.login('priya@alpha.test');
    const res = await priya.get('/api/search?q=9000011111', { headers: { accept: 'application/json' } });
    assert.equal(res.data.results.length, 0);
    assert.match(res.data.createLeadHref, /^\/app\/leads\/new\?mobile=9000011111$/);
  });

  await t.test('short input does not trigger a lookup (§5.3)', async () => {
    const priya = h.client();
    await priya.login('priya@alpha.test');
    const res = await priya.get('/api/search?q=R', { headers: { accept: 'application/json' } });
    assert.deepEqual(res.data.results, []);
  });

  await t.test('the dashboard renders the search box', async () => {
    const priya = h.client();
    await priya.login('priya@alpha.test');
    const page = await priya.get('/app/dashboard');
    assert.match(page.text, /data-quick-search/);
    assert.match(page.text, /Search mobile, customer, lead ID/);
  });

  await t.test('an unassigned lead is not hidden from a wider scope', async () => {
    await Lead.updateOne({ tenantId, _id: leadId }, { $unset: { ownerUserId: '' } });
    const mia = h.client();
    await mia.login('mia@alpha.test');
    const res = await mia.get('/api/search?q=9876543210', { headers: { accept: 'application/json' } });
    assert.equal(res.data.results[0].access, 'EDIT');
    assert.equal(res.data.results[0].owner, null);
  });
});
