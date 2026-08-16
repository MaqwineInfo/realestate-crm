const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Project, SiteVisit, Lead, Contact, Stage, VisitOutcome, ActionType, LeadSource,
  Followup, Activity, Unit, Tenant, AssignmentPool,
} = require('../../src/db/models');
const tzLib = require('../../src/lib/tz');

const tomorrowInput = () => tzLib.toDateInput(new Date(Date.now() + 86400000), 'Asia/Kolkata');

test('site visits and QR walk-ins (§24, §25, §84)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  t.after(async () => { await h.stopServer(); });

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Visit Rep', email: 'visit@alpha.test', roleName: 'Sales User',
  });
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { memberIds: [seller._id], cursor: 0 } });

  const projectsService = require('../../src/services/projects');
  const project = await projectsService.create({
    tenantId, actor: orgA.admin, data: { name: 'Visit Gardens', status: 'ACTIVE', city: 'Pune' },
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
  const outcomes = Object.fromEntries((await VisitOutcome.find({ tenantId }).lean()).map((o) => [o.name, o]));
  const leadsService = require('../../src/services/leads');

  const rep = h.client();
  await rep.login('visit@alpha.test');

  const makeLead = async (mobile, name) => {
    const { lead } = await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: name, primaryMobile: mobile, sourceId: source._id, projectId: project._id, ownerUserId: seller._id },
    });
    return lead;
  };

  let leadA;
  let visitId;

  await t.test('scheduling a visit moves the stage to Visit Planned (§84)', async () => {
    leadA = await makeLead('9950000001', 'Visit Customer');
    await rep.get(`/app/leads/${leadA._id}`);

    const res = await rep.submit(`/api/leads/${leadA._id}/visits`, {
      projectId: String(project._id),
      date: tomorrowInput(),
      time: '11:00',
      visitingWith: 'DIRECT',
      visitorCount: '2',
    }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);

    const visit = await SiteVisit.findOne({ tenantId, leadId: leadA._id }).lean();
    assert.ok(visit);
    assert.equal(visit.status, 'PLANNED');
    visitId = visit._id;

    const lead = await Lead.findOne({ tenantId, _id: leadA._id }).lean();
    assert.equal(String(lead.stageId), String(stages.VISIT_PLANNED._id));
    assert.equal(lead.visitCount, 1);
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'VISIT_SCHEDULED' }));
  });

  await t.test("today's visits tile shows the visit (§8.2)", async () => {
    const visitsService = require('../../src/services/visits');
    await visitsService.schedule({
      tenantId, tenant: orgA.tenant, actor: orgA.admin, leadId: leadA._id,
      projectId: project._id, scheduledAt: new Date(), salesUserId: seller._id,
    });
    const dash = await rep.get('/app/dashboard?tile=visits');
    assert.equal(dash.status, 200);
    assert.match(h.queueSection(dash.text), /Visit Customer/);
    assert.equal(h.tileCounts(dash.text)["Today's visits"], 1);
  });

  await t.test('completing a visit demands an outcome (§24.3, §52.4)', async () => {
    const res = await rep.submit(`/api/visits/${visitId}/complete`, {
      notes: 'Showed two units',
    }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);
    assert.match((await rep.get(`/app/leads/${leadA._id}`)).text, /correct the highlighted fields|outcome/i);
    assert.equal((await SiteVisit.findOne({ tenantId, _id: visitId }).lean()).status, 'PLANNED');
  });

  await t.test('completing a visit on an active lead still demands a next action (§55.1)', async () => {
    const res = await rep.submit(`/api/visits/${visitId}/complete`, {
      outcomeId: String(outcomes.Interested._id),
      notes: 'Liked the 3 BHK',
    }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);
    assert.match((await rep.get(`/app/leads/${leadA._id}`)).text, /cannot be left without one/i);
    assert.equal(
      (await SiteVisit.findOne({ tenantId, _id: visitId }).lean()).status, 'PLANNED',
      'nothing was written — the visit is still open',
    );
  });

  await t.test('with an outcome and a next action it completes and moves the stage (§24.3, §84)', async () => {
    const res = await rep.submit(`/api/visits/${visitId}/complete`, {
      outcomeId: String(outcomes['Highly Interested']._id),
      notes: 'Wants a corner unit',
      nextActionTypeId: String(actions.COST_SHEET._id),
      nextDate: tomorrowInput(),
      nextTime: '16:00',
    }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);

    const visit = await SiteVisit.findOne({ tenantId, _id: visitId }).lean();
    assert.equal(visit.status, 'COMPLETED');
    assert.ok(visit.completedAt);
    assert.equal(String(visit.outcomeId), String(outcomes['Highly Interested']._id));

    const lead = await Lead.findOne({ tenantId, _id: leadA._id }).lean();
    assert.equal(String(lead.stageId), String(stages.VISIT_DONE._id), 'semantic mapping moved the stage');
    assert.equal(lead.completedVisitCount, 1);
    assert.ok(lead.nextActionAt, 'the lead leaves with its next action');
    assert.ok(await Followup.findOne({ tenantId, leadId: leadA._id, status: 'PENDING' }));
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'VISIT_COMPLETED' }));
  });

  await t.test('one lead can have many visits across projects (§24, §55.15)', async () => {
    const second = await projectsService.create({
      tenantId, actor: orgA.admin, data: { name: 'Visit Heights', status: 'ACTIVE' },
    });
    await rep.submit(`/api/leads/${leadA._id}/visits`, {
      projectId: String(second._id), date: tomorrowInput(), time: '09:00',
    }, `/app/leads/${leadA._id}`);

    const visits = await SiteVisit.find({ tenantId, leadId: leadA._id }).lean();
    assert.ok(visits.length >= 3);
    assert.equal(new Set(visits.map((v) => String(v.projectId))).size, 2, 'visits span two projects');
  });

  await t.test('a visit can be cancelled or marked no-show', async () => {
    const open = await SiteVisit.findOne({ tenantId, leadId: leadA._id, status: 'PLANNED' }).lean();
    const res = await rep.submit(`/api/visits/${open._id}/cancel`, {
      reason: 'Customer travelling', noShow: '1',
    }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);
    assert.equal((await SiteVisit.findOne({ tenantId, _id: open._id }).lean()).status, 'NO_SHOW');
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'VISIT_NO_SHOW' }));
  });

  /* -------------------------------- §25 QR -------------------------------- */

  await t.test('a QR walk-in creates contact, lead and visit without an OTP (§25.2)', async () => {
    const proj = await Project.findOne({ tenantId, _id: project._id }).lean();
    const anon = h.client();

    const form = await anon.get(`/visit/${proj.qrToken}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /Visit Gardens/);
    assert.ok(!form.text.includes('OTP'));

    const res = await anon.post(`/visit/${proj.qrToken}`, {
      name: 'Walkin Wanda', mobile: '9950000099', visitingWith: 'DIRECT', visitorCount: '3',
    });
    assert.equal(res.status, 302);
    assert.match(res.location, /done=1/);

    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919950000099' }).lean();
    assert.ok(contact, 'contact created from the walk-in');
    const lead = await Lead.findOne({ tenantId, contactId: contact._id }).lean();
    assert.ok(lead);
    assert.equal(String(lead.ownerUserId), String(seller._id), 'assigned by round robin');
    assert.ok(lead.slaTargetSeconds, 'the SLA clock started');

    const visit = await SiteVisit.findOne({ tenantId, leadId: lead._id }).lean();
    assert.ok(visit, 'the visit itself was recorded');
    assert.equal(visit.viaQr, true);
    assert.equal(visit.status, 'IN_PROGRESS');
    assert.equal(visit.visitorCount, 3);

    const sourceUsed = await LeadSource.findOne({ tenantId, _id: lead.latestSourceId }).lean();
    assert.equal(sourceUsed.category, 'QR');
  });

  await t.test('a returning walk-in is a re-inquiry, not a second contact (§13.2)', async () => {
    const proj = await Project.findOne({ tenantId, _id: project._id }).lean();
    const anon = h.client();
    await anon.post(`/visit/${proj.qrToken}`, { name: 'Walkin Wanda', mobile: '9950000099', visitingWith: 'DIRECT' });

    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919950000099' }), 1);
    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919950000099' }).lean();
    assert.equal(await Lead.countDocuments({ tenantId, contactId: contact._id, projectId: project._id }), 1);
    const lead = await Lead.findOne({ tenantId, contactId: contact._id }).lean();
    assert.equal(lead.inquiryCount, 2);
    assert.equal(await SiteVisit.countDocuments({ tenantId, leadId: lead._id }), 2, 'both visits recorded');
  });

  await t.test('a channel-partner walk-in records the partner (§25.1)', async () => {
    const proj = await Project.findOne({ tenantId, _id: project._id }).lean();
    const anon = h.client();
    await anon.post(`/visit/${proj.qrToken}`, {
      name: 'Broker Brought', mobile: '9950000088',
      visitingWith: 'CHANNEL_PARTNER', cpName: 'Acme Realty', cpMobile: '9950000077',
    });

    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919950000088' }).lean();
    const visit = await SiteVisit.findOne({ tenantId, contactId: contact._id }).lean();
    assert.equal(visit.visitingWith, 'CHANNEL_PARTNER');
    assert.equal(visit.channelPartnerName, 'Acme Realty');
    assert.ok(visit.channelPartnerContactId, 'the partner is a contact too');
    assert.ok(await Contact.findOne({ tenantId, normalizedMobile: '+919950000077' }));
  });

  await t.test('a bad QR token reveals nothing', async () => {
    const anon = h.client();
    assert.equal((await anon.get('/visit/not-a-real-token')).status, 404);
    const res = await anon.post('/visit/not-a-real-token', { name: 'X', mobile: '9950000066' });
    assert.equal(res.status, 404);
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919950000066' }), 0);
  });

  await t.test('the walk-in form refuses an unusable mobile without creating anything', async () => {
    const proj = await Project.findOne({ tenantId, _id: project._id }).lean();
    const anon = h.client();
    const before = await Lead.countDocuments({ tenantId });
    const res = await anon.post(`/visit/${proj.qrToken}`, { name: 'No Number', mobile: '123' });
    assert.equal(res.status, 400);
    assert.match(res.text, /valid mobile/i);
    assert.equal(await Lead.countDocuments({ tenantId }), before);
  });

  /* ------------------------------ §64 mini site ---------------------------- */

  await t.test('an unpublished mini site is not reachable (§26.2)', async () => {
    const proj = await Project.findOne({ tenantId, _id: project._id }).lean();
    const anon = h.client();
    assert.equal((await anon.get(`/p/${proj.slug}`)).status, 404);
  });

  await t.test('a published mini site shows configurations and captures a lead (§64)', async () => {
    const admin = h.client();
    await admin.login('admin@alpha.test');
    await admin.get(`/app/projects/${project._id}`);
    await admin.submit(`/api/projects/${project._id}/mini-site`, {
      published: '1', showStartingPrice: '1', showConfigurationAvailability: '1',
    }, `/app/projects/${project._id}`);

    const proj = await Project.findOne({ tenantId, _id: project._id }).lean();
    assert.equal(proj.miniSite.published, true);

    const anon = h.client();
    const page = await anon.get(`/p/${proj.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Visit Gardens/);
    assert.ok(!page.text.includes('101'), 'unit-level inventory stays private by default (§64.2)');

    const res = await anon.post(`/p/${proj.slug}/inquire`, {
      name: 'Site Visitor', mobile: '9950000055', message: 'Send me the brochure',
    });
    assert.equal(res.status, 302);

    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919950000055' }).lean();
    assert.ok(contact);
    const lead = await Lead.findOne({ tenantId, contactId: contact._id }).lean();
    assert.equal(String(lead.projectId), String(project._id), 'the project is mapped automatically (§64.3)');
    const src = await LeadSource.findOne({ tenantId, _id: lead.latestSourceId }).lean();
    assert.equal(src.category, 'WEBSITE');
  });

  await t.test('a tenant can switch off automatic stage moves on visits (§84)', async () => {
    await Tenant.updateOne({ _id: tenantId }, { $set: { 'settings.autoStageOnVisit': false } });
    const tenant = await Tenant.findById(tenantId).lean();

    const leadB = await makeLead('9950000044', 'No Auto Stage');
    const before = await Lead.findOne({ tenantId, _id: leadB._id }).lean();
    const visitsService = require('../../src/services/visits');
    await visitsService.schedule({
      tenantId, tenant, actor: orgA.admin, leadId: leadB._id, projectId: project._id,
      scheduledAt: new Date(Date.now() + 86400000), salesUserId: seller._id,
    });
    const after = await Lead.findOne({ tenantId, _id: leadB._id }).lean();
    assert.equal(String(after.stageId), String(before.stageId), 'the custom pipeline is respected');

    await Tenant.updateOne({ _id: tenantId }, { $set: { 'settings.autoStageOnVisit': true } });
  });
});
