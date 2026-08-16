const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { LeadSource } = require('../../src/db/models');

/**
 * Every page a phase-1 user can reach must render. A template that throws only
 * shows up as a 500, so this walks the whole navigation surface.
 */
test('every screen renders', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();

  const source = await LeadSource.findOne({ tenantId: orgA.tenant._id, category: 'MANUAL' }).lean();
  const leadsService = require('../../src/services/leads');
  const { lead } = await leadsService.create({
    tenantId: orgA.tenant._id,
    tenant: orgA.tenant,
    actor: orgA.admin,
    data: { firstName: 'Render', lastName: 'Check', primaryMobile: '9700000001', sourceId: source._id, ownerUserId: orgA.admin._id },
  });

  const c = h.client();
  await c.login('admin@alpha.test');

  t.after(async () => { await h.stopServer(); });

  const pages = [
    '/app/dashboard',
    '/app/dashboard?tile=new',
    '/app/dashboard?tile=today',
    '/app/dashboard?tile=missed',
    '/app/dashboard?tile=reinquiry',
    '/app/notifications',
    '/app/profile',
    '/app/leads',
    '/app/leads?q=Render&status=ACTIVE',
    '/app/leads/new',
    `/app/leads/${lead._id}`,
    '/app/contacts',
    '/app/contacts/new',
    '/app/setup/organization',
    '/app/setup/users',
    '/app/setup/roles',
    '/app/setup/stages',
    '/app/setup/action-types',
    '/app/setup/visit-outcomes',
    '/app/setup/sources',
    '/app/setup/tags',
    '/app/setup/sla',
    '/app/setup/templates',
    '/app/setup/integrations',
    '/app/setup/health',
    '/app/dashboard?view=team',
    '/app/dashboard?view=team&tile=sla',
    '/app/dashboard?view=team&tile=unassigned',
    '/app/dashboard?view=team&tile=visits',
    '/app/dashboard?tile=visits',
    '/app/dashboard/management',
    '/app/projects',
    '/app/projects/new',
    '/app/inventory',
    '/app/campaigns/communication',
    '/app/campaigns/communication/new',
    '/app/campaigns/performance',
    '/app/approvals',
    '/app/opportunities/resale',
    '/app/opportunities/rental',
    '/app/reports/leads',
    '/app/reports/sales',
    '/app/reports/projects',
    '/app/reports/campaigns',
    '/app/reports/activities',
    '/app/search?q=Render',
    '/app/setup/nurture',
  ];

  for (const path of pages) {
    await t.test(`GET ${path}`, async () => {
      const res = await c.get(path);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
      assert.ok(res.text.includes('</html>'), `${path} rendered a truncated page`);
      assert.ok(!/<%|Cannot read properties|is not defined/.test(res.text), `${path} leaked a template error`);
    });
  }

  await t.test('an unknown page returns a friendly 404, not a stack trace', async () => {
    const res = await c.get('/app/nope');
    assert.equal(res.status, 404);
    assert.match(res.text, /could not be found/i);
    assert.ok(!res.text.includes('at Object.'), 'no stack trace is exposed (§68)');
  });

  await t.test('the health endpoint reports the transaction mode', async () => {
    const res = await c.get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.db, 'up');
  });
});
