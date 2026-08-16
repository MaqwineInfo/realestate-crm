const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, Unit, UnitType, PaymentPlan, PricingComponent, LeadSource, Stage, ActionType,
  VisitOutcome, Booking, MarketingCampaign, AssignmentPool, Project, Contact,
} = require('../../src/db/models');
const money = require('../../src/lib/money');

/** A project with priced inventory, plus a lead that walks the whole journey. */
async function scenario({ tenantId, orgA, seller }) {
  const projectsService = require('../../src/services/projects');
  const project = await projectsService.create({
    tenantId,
    actor: orgA.admin,
    data: {
      name: 'Insight Residences', status: 'ACTIVE', city: 'Ahmedabad',
      possessionDate: new Date('2027-12-01'), amenities: ['Clubhouse', 'Gym', 'Pool'],
    },
  });
  const tower = await projectsService.addTower({
    tenantId, actor: orgA.admin, projectId: project._id, data: { name: 'Tower A', code: 'A', floorCount: 2 },
  });
  const type3 = await projectsService.addUnitType({
    tenantId, projectId: project._id,
    data: { name: '3 BHK', bedrooms: 3, superBuiltUpArea: 1200, defaultBaseRateMinor: money.toMinor('5000') },
  });
  const type2 = await projectsService.addUnitType({
    tenantId, projectId: project._id,
    data: { name: '2 BHK', bedrooms: 2, superBuiltUpArea: 800, defaultBaseRateMinor: money.toMinor('5000') },
  });
  await PricingComponent.create({
    tenantId, projectId: project._id, name: 'Base price', kind: 'BASE',
    calcType: 'PER_AREA', rateMinor: money.toMinor('5000'), areaBasis: 'SALEABLE', displayOrder: 1,
  });
  await projectsService.generateUnits({
    tenantId, actor: orgA.admin, projectId: project._id, towerId: tower._id, unitTypeId: type3._id, unitsPerFloor: 2,
  });
  await Unit.create({
    tenantId, projectId: project._id, towerId: tower._id, unitTypeId: type2._id,
    unitNumber: 'S-1', saleableArea: 800, floorNumber: 1, facing: 'East',
  });
  const plan = await PaymentPlan.create({ tenantId, projectId: project._id, name: 'Down payment' });
  return { project, tower, type3, type2, plan };
}

test('practical sales AI (§42, §108)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  t.after(async () => { await h.stopServer(); });

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'AI Rep', email: 'ai@alpha.test', roleName: 'Sales User',
  });
  const { project, type3 } = await scenario({ tenantId, orgA, seller });
  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const leadsService = require('../../src/services/leads');
  const ai = require('../../src/services/ai');

  const { lead } = await leadsService.create({
    tenantId, tenant: orgA.tenant, actor: orgA.admin,
    data: {
      firstName: 'Anita', lastName: 'Rao', primaryMobile: '9600000001', sourceId: source._id,
      projectId: project._id, ownerUserId: seller._id,
      budgetMinMinor: money.toMinor('5000000'), budgetMaxMinor: money.toMinor('7000000'),
      preferredConfigurations: ['3 BHK'], purpose: 'INVESTMENT',
    },
  });

  const rep = h.client();
  await rep.login('ai@alpha.test');

  await t.test('the summary is assembled from real records and says so (§42.2)', async () => {
    const res = await rep.get(`/api/ai/leads/${lead._id}/summary`, { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.generated, true);
    assert.ok(res.data.bullets.length >= 3);

    const text = res.data.bullets.join(' ');
    assert.match(text, /3 BHK/, 'quotes the captured requirement');
    assert.match(text, /Insight Residences/);
    assert.match(text, /No site visit has happened yet/);
    assert.match(text, /no next action scheduled/i, 'names the actual gap');
  });

  await t.test('the suggested next action follows the state of the deal (§42.3)', async () => {
    let res = await rep.get(`/api/ai/leads/${lead._id}/next-action`, { headers: { accept: 'application/json' } });
    assert.equal(res.data.action, 'Call now');
    assert.match(res.data.why, /never been genuinely attended/);
    assert.equal(res.data.decidedBy, 'user', 'the user decides, not the assistant (§42.3)');

    // Work the lead, and the suggestion moves on.
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
    const tz = require('../../src/lib/tz');
    await rep.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      nextActionTypeId: String(actions.CALL._id),
      nextDate: tz.toDateInput(new Date(Date.now() + 86400000), 'Asia/Kolkata'),
      nextTime: '10:00',
    }, `/app/leads/${lead._id}`);

    res = await rep.get(`/api/ai/leads/${lead._id}/next-action`, { headers: { accept: 'application/json' } });
    assert.equal(res.data.action, 'Schedule a site visit');
  });

  await t.test('priority is scored from signals and shows its working (§42.4)', async () => {
    const res = await rep.get(`/api/ai/leads/${lead._id}/priority`, { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.ok(typeof res.data.score === 'number');
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(res.data.level));
    assert.ok(res.data.signals.length, 'every point is attributed to a signal');
    assert.match(res.data.caveat, /assistive/i, 'presented as assistive, not a probability');
  });

  await t.test('recommendations only ever contain real, available, affordable units (§42.5)', async () => {
    const res = await rep.get(`/api/ai/leads/${lead._id}/units`, { headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.ok(res.data.units.length, 'found matching units');

    for (const unit of res.data.units) {
      const real = await Unit.findOne({ tenantId, _id: unit._id }).lean();
      assert.ok(real, 'the unit exists');
      assert.equal(real.status, 'AVAILABLE', 'and is actually sellable');
      assert.ok(unit.priceMinor <= money.toMinor('7000000') * 1.05, 'and is inside the budget');
      assert.equal(unit.unitTypeId.name, '3 BHK', 'and matches the requirement');
    }

    // Block every 3 BHK and the recommendation empties out rather than inventing one.
    await Unit.updateMany({ tenantId, projectId: project._id, unitTypeId: type3._id }, { $set: { status: 'BLOCKED' } });
    const after = await rep.get(`/api/ai/leads/${lead._id}/units`, { headers: { accept: 'application/json' } });
    assert.equal(after.data.units.length, 0);
    assert.match(after.data.note, /No available unit/i);
    await Unit.updateMany({ tenantId, projectId: project._id, unitTypeId: type3._id }, { $set: { status: 'AVAILABLE' } });
  });

  await t.test('project Q&A answers from configured data only (§42.6)', async () => {
    const ask = (q) => rep.get(`/api/ai/ask?projectId=${project._id}&q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });

    let res = await ask('What is the possession date?');
    assert.match(res.data.answer, /2027/);

    res = await ask('What amenities are available?');
    assert.match(res.data.answer, /Clubhouse/);

    res = await ask('What 3BHK units are available under 70 lakh?');
    assert.match(res.data.answer, /available/i);
    assert.match(res.data.answer, /3 BHK/i);

    res = await ask('Which unit has east facing?');
    assert.match(res.data.answer, /S-1|east/i);

    res = await ask('What is the final cost of unit 101?');
    assert.match(res.data.answer, /101/);

    // §42.6/§42.7: missing configuration is reported, never invented.
    const bare = await Project.create({ tenantId, name: 'Unconfigured Project', status: 'ACTIVE' });
    res = await rep.get(`/api/ai/ask?projectId=${bare._id}&q=${encodeURIComponent('What is the payment plan?')}`, { headers: { accept: 'application/json' } });
    assert.match(res.data.answer, /No payment plan is configured/i);

    res = await rep.get(`/api/ai/ask?projectId=${bare._id}&q=${encodeURIComponent('What is the possession date?')}`, { headers: { accept: 'application/json' } });
    assert.match(res.data.answer, /not been configured/i);

    res = await rep.get(`/api/ai/ask?projectId=${project._id}&q=${encodeURIComponent('What is the cost of unit Z-999?')}`, { headers: { accept: 'application/json' } });
    assert.match(res.data.answer, /no unit Z-999/i, 'a unit that does not exist is not invented');
  });

  await t.test('the assistant has no write path at all (§42.7)', async () => {
    assert.deepEqual(ai.GUARDRAILS, {
      canChangeStage: false,
      canBlockUnit: false,
      canBookUnit: false,
      canApproveDiscount: false,
      canAlterInventory: false,
      canSendCampaign: false,
      canInventFacts: false,
    });

    // Every AI route is a GET, so there is no mutation surface to protect.
    const before = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    await rep.get(`/api/ai/leads/${lead._id}/summary`, { headers: { accept: 'application/json' } });
    await rep.get(`/api/ai/leads/${lead._id}/priority`, { headers: { accept: 'application/json' } });
    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(String(after.stageId), String(before.stageId));
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'nothing was written');
  });

  await t.test('the assistant cannot reach another tenant (§108)', async () => {
    const intruder = h.client();
    await intruder.login('admin@beta.test');
    const res = await intruder.get(`/api/ai/leads/${lead._id}/summary`, { headers: { accept: 'application/json' } });
    assert.equal(res.status, 404);
    assert.ok(orgB.tenant);
  });

  await t.test('a user without price permission gets answers without prices (§108)', async () => {
    const { Role } = require('../../src/db/models');
    const role = await Role.findOne({ tenantId, name: 'Sales User' });
    const saved = { ...role.permissions };
    role.permissions = { ...saved, 'inventory.view_prices': undefined };
    delete role.permissions['inventory.view_prices'];
    role.markModified('permissions');
    await role.save();

    const noPrices = h.client();
    await noPrices.login('ai@alpha.test');
    const res = await noPrices.get(`/api/ai/ask?projectId=${project._id}&q=${encodeURIComponent('What is the final cost of unit 101?')}`, { headers: { accept: 'application/json' } });
    assert.match(res.data.answer, /do not have permission to view prices/i);

    role.permissions = saved;
    role.markModified('permissions');
    await role.save();
  });
});

test('reports and the management view (§43, §44, §8.5, §76)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  t.after(async () => { await h.stopServer(); });

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Report Rep', email: 'rep@alpha.test', roleName: 'Sales User',
  });
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { memberIds: [seller._id], cursor: 0 } });
  const { project, plan } = await scenario({ tenantId, orgA, seller });

  const campaign = await MarketingCampaign.create({
    tenantId, name: 'Report campaign', platform: 'META', projectId: project._id, spendMinor: money.toMinor('200000'),
  });

  const captureService = require('../../src/services/capture');
  const leads = [];
  for (let i = 0; i < 4; i += 1) {
    const { lead } = await captureService.handleInquiry({
      tenantId,
      tenant: orgA.tenant,
      payload: { name: `Report Lead ${i}`, mobile: `96001000${10 + i}`, projectId: project._id, campaignId: campaign._id },
    });
    leads.push(lead);
  }

  // Lead 0: responded, visited, booked. Lead 1: responded only. Leads 2–3: untouched.
  await Lead.updateOne({ tenantId, _id: leads[0]._id }, {
    $set: { firstGenuineActionAt: new Date(), firstResponseSeconds: 120, completedVisitCount: 1 },
  });
  await Lead.updateOne({ tenantId, _id: leads[1]._id }, {
    $set: { firstGenuineActionAt: new Date(), firstResponseSeconds: 600, slaBreached: true },
  });

  const unit = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '101' }).lean();
  const bookings = require('../../src/services/bookings');
  await bookings.createBooking({
    tenantId, actor: orgA.admin, leadId: leads[0]._id, unitId: unit._id,
    bookingDate: new Date(), finalPriceMinor: money.toMinor('6000000'),
    bookingAmountMinor: money.toMinor('100000'), paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
  });

  const admin = h.client();
  await admin.login('admin@alpha.test');

  await t.test('the lead report lists every lead with its journey (§43.2)', async () => {
    const reports = require('../../src/services/reports');
    const { rows } = await reports.leadReport({ tenantId, query: {}, zone: 'Asia/Kolkata', scope: {} });
    assert.equal(rows.length, 4);
    const booked = rows.find((r) => String(r._id) === String(leads[0]._id));
    assert.equal(booked.bookingValueMinor, money.toMinor('6000000'));
    assert.ok(booked.contactId.displayName);

    const page = await admin.get('/app/reports/leads');
    assert.equal(page.status, 200);
    assert.match(page.text, /Report Lead 0/);
  });

  await t.test('the sales report uses the spec definitions (§43.3, §92)', async () => {
    const reports = require('../../src/services/reports');
    const { rows } = await reports.salesReport({ tenantId, query: {}, zone: 'Asia/Kolkata', scope: {} });
    const row = rows.find((r) => r.name === 'Report Rep');
    assert.ok(row, 'the owner appears');
    assert.equal(row.leads, 4);
    assert.equal(row.responded, 2);
    // §92: SLA compliance = responded within SLA ÷ leads requiring response.
    assert.equal(row.slaCompliancePct, 25, '1 of 4 answered inside the target');
    assert.equal(row.medianResponseSeconds, 600);
    assert.equal(row.leadToVisitPct, 25);
    assert.equal(row.leadToBookingPct, 25);
  });

  await t.test('the project report ties the funnel to live inventory (§43.4)', async () => {
    const reports = require('../../src/services/reports');
    const { rows } = await reports.projectReport({ tenantId, query: {}, zone: 'Asia/Kolkata', scope: {} });
    const row = rows.find((r) => String(r.project._id) === String(project._id));
    assert.equal(row.leads, 4);
    assert.equal(row.bookings, 1);
    assert.equal(row.revenueMinor, money.toMinor('6000000'));
    assert.equal(row.bookedUnits, 1);
    assert.ok(row.available >= 3);
  });

  await t.test('the campaign report reaches the same revenue as the project report (§43.5)', async () => {
    const reports = require('../../src/services/reports');
    const [campaigns, projects] = await Promise.all([
      reports.campaignReport({ tenantId, tenant: orgA.tenant, query: {}, zone: 'Asia/Kolkata' }),
      reports.projectReport({ tenantId, query: {}, zone: 'Asia/Kolkata', scope: {} }),
    ]);
    const campaignRevenue = campaigns.totals.revenueMinor;
    const projectRevenue = projects.rows.reduce((sum, r) => sum + r.revenueMinor, 0);
    assert.equal(campaignRevenue, projectRevenue, 'two reports, one truth');
    assert.equal(campaigns.totals.bookings, 1);
    assert.equal(campaigns.totals.costPerBookingMinor, money.toMinor('200000'));
  });

  await t.test('the activity report summarises what the team did (§43.6)', async () => {
    const page = await admin.get('/app/reports/activities');
    assert.equal(page.status, 200);
    assert.match(page.text, /Activity by type/);
  });

  await t.test('the management view shows the business funnel (§8.5)', async () => {
    const page = await admin.get('/app/dashboard/management');
    assert.equal(page.status, 200);
    assert.match(page.text, /Business funnel/);
    assert.match(page.text, /Booking revenue/);
    assert.match(page.text, /ROAS/);

    const reports = require('../../src/services/reports');
    const summary = await reports.managementSummary({ tenantId, tenant: orgA.tenant, zone: 'Asia/Kolkata' });
    assert.equal(summary.funnel.leads, 4);
    assert.equal(summary.funnel.connected, 2);
    assert.equal(summary.funnel.bookings, 1);
    assert.equal(summary.funnel.revenueMinor, money.toMinor('6000000'));
  });

  await t.test('exports respect filters and are audited (§76)', async () => {
    const res = await admin.get('/app/reports/leads/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.text.split('\n')[0], /Lead ID,Contact,Mobile/);
    assert.equal(res.text.trim().split('\n').length, 5, 'header plus four leads');

    const { AuditLog } = require('../../src/db/models');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Report', action: 'EXPORT' }), 'the export is audited');
  });

  await t.test('a sales user only reports on their own data (§6.3, §76)', async () => {
    const rep = h.client();
    await rep.login('rep@alpha.test');
    const page = await rep.get('/app/reports/leads');
    assert.equal(page.status, 200);

    const other = await h.addUser({
      tenant: orgA.tenant, roles: orgA.roles, name: 'Other Rep', email: 'other@alpha.test', roleName: 'Sales User',
    });
    const leadsService = require('../../src/services/leads');
    const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
    await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: 'Hidden', primaryMobile: '9600200001', sourceId: source._id, ownerUserId: other._id },
    });

    const scoped = await rep.get('/app/reports/leads');
    assert.ok(!scoped.text.includes('Hidden'), "another rep's lead is not in this report");
  });

  await t.test('global search finds a customer by mobile (§46)', async () => {
    const res = await admin.get('/app/search?q=' + encodeURIComponent('96001000 10'));
    assert.equal(res.status, 200);
    assert.match(res.text, /Report Lead 0/);

    const byUnit = await admin.get('/app/search?q=101');
    assert.match(byUnit.text, /Insight Residences/);
  });
});
