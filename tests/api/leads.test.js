const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, Contact, Activity, LeadSource, Stage, SubStage, InquiryTouch, AuditLog,
} = require('../../src/db/models');

test('lead lifecycle (§10, §15, §55, §82, §83)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const manager = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Team Manager', email: 'mgr@alpha.test', roleName: 'Sales Manager',
  });
  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Sam Seller', email: 'sam@alpha.test', roleName: 'Sales User', managerId: manager._id,
  });
  const otherSeller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Ola Other', email: 'ola@alpha.test', roleName: 'Sales User',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const websiteSource = await LeadSource.findOne({ tenantId, category: 'WEBSITE' }).lean();
  const stages = Object.fromEntries(
    (await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]),
  );

  const admin = h.client();
  await admin.login('admin@alpha.test');

  let leadId;

  t.after(async () => { await h.stopServer(); });

  await t.test('creating a lead creates the contact, first touch and timeline entry', async () => {
    await admin.get('/app/leads/new');
    const res = await admin.submit('/api/leads', {
      firstName: 'Neha', lastName: 'Kapoor', primaryMobile: '98765 43210',
      email: 'neha@example.com', city: 'Ahmedabad',
      sourceId: String(source._id), ownerUserId: String(seller._id),
      budgetMinMinor: '4500000', budgetMaxMinor: '6000000', purpose: 'SELF_USE',
    }, '/app/leads/new');
    assert.equal(res.status, 302);
    assert.match(res.location, /^\/app\/leads\//);
    leadId = res.location.split('/').pop();

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.status, 'ACTIVE');
    assert.equal(String(lead.stageId), String(stages.NEW._id), 'starts in the New Lead stage');
    assert.equal(lead.slaStatus, 'PENDING');
    assert.equal(lead.firstGenuineActionAt, undefined, 'creating a lead is not a genuine action');
    assert.equal(lead.budgetMinMinor, 450000000, 'money is stored in integer paise');

    const contact = await Contact.findOne({ tenantId, _id: lead.contactId }).lean();
    assert.equal(contact.normalizedMobile, '+919876543210');
    assert.equal(contact.displayName, 'Neha Kapoor');
    assert.equal(contact.inquiryCount, 1);

    const touches = await InquiryTouch.find({ tenantId, leadId: lead._id }).lean();
    assert.equal(touches.length, 1);
    assert.equal(touches[0].isFirstTouch, true);

    const types = (await Activity.find({ tenantId, leadId: lead._id }).lean()).map((a) => a.type);
    assert.deepEqual(types.sort(), ['LEAD_ASSIGNED', 'LEAD_CREATED']);
  });

  await t.test('a second inquiry from the same mobile reuses the contact (§2.5, V1.1 §13)', async () => {
    // V1.1 §13.2: the form no longer creates a competing active lead silently.
    // It stops and makes the user choose, and writes nothing until they do.
    const asked = await admin.submit('/api/leads', {
      firstName: 'Neha', primaryMobile: '+91 98765 43210',
      sourceId: String(websiteSource._id), ownerUserId: String(seller._id),
    }, '/app/leads/new');
    assert.equal(asked.status, 200, 'the decision is shown instead of a redirect');
    assert.match(asked.text, /already has an open lead here/);
    assert.equal(await Lead.countDocuments({ tenantId }), 1, 'nothing was written');

    // §13.4: an explicit new inquiry is still allowed — the same person can have
    // more than one opportunity.
    const res = await admin.submit('/api/leads', {
      firstName: 'Neha', primaryMobile: '+91 98765 43210',
      sourceId: String(websiteSource._id), ownerUserId: String(seller._id),
      intent: 'NEW_INQUIRY',
    }, '/app/leads/new');
    assert.equal(res.status, 302);

    const contacts = await Contact.find({ tenantId, normalizedMobile: '+919876543210' }).lean();
    assert.equal(contacts.length, 1, 'no duplicate contact');
    const leads = await Lead.find({ tenantId, contactId: contacts[0]._id }).lean();
    assert.equal(leads.length, 2, 'a second opportunity for the same person');
    assert.equal(contacts[0].inquiryCount, 2);
  });

  await t.test('the new lead appears on the owner\'s New Leads tile (§8.2)', async () => {
    const c = h.client();
    await c.login('sam@alpha.test');
    const res = await c.get('/app/dashboard?tile=new');
    assert.equal(res.status, 200);
    assert.match(res.text, /Neha Kapoor/);
  });

  await t.test('a stage change is recorded with sub-stage validation (§52.2)', async () => {
    const wrongSub = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    const res = await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.CONNECTED._id), subStageId: String(wrongSub._id),
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);
    const page = await admin.get(`/app/leads/${leadId}`);
    assert.match(page.text, /does not belong to the selected stage/);

    const rightSub = await SubStage.findOne({ tenantId, stageId: stages.CONNECTED._id, name: 'Interested' }).lean();
    const ok = await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.CONNECTED._id), subStageId: String(rightSub._id), note: 'Wants a 3BHK',
    }, `/app/leads/${leadId}`);
    assert.equal(ok.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(String(lead.stageId), String(stages.CONNECTED._id));
    assert.equal(String(lead.subStageId), String(rightSub._id));
    assert.equal(lead.status, 'ACTIVE');
  });

  await t.test('Booked cannot be reached from the stage dropdown (§83)', async () => {
    const res = await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.BOOKED._id),
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);
    const page = await admin.get(`/app/leads/${leadId}`);
    assert.match(page.text, /Booking action/);

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.notEqual(String(lead.stageId), String(stages.BOOKED._id));
    assert.equal(lead.status, 'ACTIVE');
  });

  await t.test('Block Unit cannot be reached from the stage dropdown either (§83)', async () => {
    const res = await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.BLOCKED._id),
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);
    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.notEqual(String(lead.stageId), String(stages.BLOCKED._id));
  });

  await t.test('a transfer keeps the whole history and logs who did it (§15.3)', async () => {
    const before = await Activity.countDocuments({ tenantId, leadId });
    const res = await admin.submit(`/api/leads/${leadId}/transfer`, {
      toUserId: String(otherSeller._id), reason: 'Territory change', note: 'Ola covers west zone',
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(String(lead.ownerUserId), String(otherSeller._id));
    assert.equal(String(lead.previousOwnerUserId), String(seller._id));

    const after = await Activity.countDocuments({ tenantId, leadId });
    assert.ok(after > before, 'nothing is deleted, a transfer only adds to the timeline');

    const event = await Activity.findOne({ tenantId, leadId, type: 'LEAD_TRANSFERRED' }).lean();
    assert.match(event.title, /transferred from Sam Seller to Ola Other by Alpha Admin/);

    const audited = await AuditLog.findOne({ tenantId, entity: 'Lead', entityId: lead._id, action: 'TRANSFER' }).lean();
    assert.ok(audited, 'transfers are audited (§56)');
  });

  await t.test('a sales user only sees their own leads (§6.3)', async () => {
    const c = h.client();
    await c.login('sam@alpha.test');
    const res = await c.get('/app/leads');
    assert.equal(res.status, 200);
    // The transferred lead now belongs to Ola, so Sam must not see it.
    const rows = res.text.split('<tr>').filter((r) => r.includes('/app/leads/'));
    assert.ok(rows.every((r) => !r.includes(String(leadId))), 'the transferred lead is gone from Sam\'s list');

    const denied = await c.get(`/app/leads/${leadId}`);
    assert.equal(denied.status, 404);
  });

  await t.test('a manager sees their team\'s leads (§6.3)', async () => {
    const c = h.client();
    await c.login('mgr@alpha.test');
    const res = await c.get('/app/leads');
    assert.equal(res.status, 200);
    assert.match(res.text, /Neha Kapoor/, 'Sam reports to this manager');
  });

  await t.test('marking lost demands a reason and closes the lead (§82)', async () => {
    const noReason = await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.LOST._id),
    }, `/app/leads/${leadId}`);
    assert.equal(noReason.status, 302);
    assert.match((await admin.get(`/app/leads/${leadId}`)).text, /Select a lost reason|Select a Lost sub-stage/);
    assert.equal((await Lead.findOne({ tenantId, _id: leadId }).lean()).status, 'ACTIVE');

    const reason = await SubStage.findOne({ tenantId, stageId: stages.LOST._id, name: 'Budget' }).lean();
    const res = await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.LOST._id), subStageId: String(reason._id), note: 'Out of budget',
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.status, 'TERMINAL');
    assert.ok(lead.lostAt);
    assert.equal(String(lead.lostReasonSubStageId), String(reason._id));
    assert.ok(await Activity.findOne({ tenantId, leadId, type: 'LEAD_LOST' }));
  });

  await t.test('a lost lead can be reopened, keeping its lost history (§81)', async () => {
    const res = await admin.submit(`/api/leads/${leadId}/reopen`, {
      stageId: String(stages.CONNECTED._id), reason: 'Customer called back',
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.status, 'ACTIVE');
    assert.ok(lead.lostAt, 'the previous lost event is preserved');
    assert.ok(await Activity.findOne({ tenantId, leadId, type: 'LEAD_REOPENED' }));
  });

  await t.test('reopening into a terminal stage is refused', async () => {
    await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.LOST._id),
      subStageId: String((await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean())._id),
    }, `/app/leads/${leadId}`);

    await admin.submit(`/api/leads/${leadId}/reopen`, {
      stageId: String(stages.BOOKED._id), reason: 'nope',
    }, `/app/leads/${leadId}`);
    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.notEqual(String(lead.stageId), String(stages.BOOKED._id));
  });

  await t.test('notes with @mentions notify the mentioned user (§22)', async () => {
    const { Notification } = require('../../src/db/models');
    const res = await admin.submit(`/api/leads/${leadId}/notes`, {
      body: 'Spoke to the customer. @Ola Other please take the site visit.',
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);

    const note = await Activity.findOne({ tenantId, leadId, type: 'NOTE_ADDED' }).lean();
    assert.ok(note);
    assert.equal(note.mentionUserIds.length, 1);
    assert.equal(String(note.mentionUserIds[0]), String(otherSeller._id));

    await new Promise((r) => setTimeout(r, 120)); // events are dispatched async
    const notif = await Notification.findOne({ tenantId, userId: otherSeller._id, type: 'USER_MENTIONED' }).lean();
    assert.ok(notif, 'the mentioned user is notified');
    assert.match(notif.link, new RegExp(String(leadId)));
  });

  await t.test('validation errors come back as friendly field messages', async () => {
    const res = await admin.submit('/api/leads', {
      firstName: '', primaryMobile: '', sourceId: String(source._id),
    }, '/app/leads/new');
    assert.equal(res.status, 302);
    const page = await admin.get('/app/leads/new');
    assert.match(page.text, /correct the highlighted fields|Choose an existing contact/);
  });

  await t.test('an unparseable mobile is rejected before it becomes a duplicate key', async () => {
    await admin.submit('/api/leads', {
      firstName: 'Bad', primaryMobile: '12345', sourceId: String(source._id),
    }, '/app/leads/new');
    const page = await admin.get('/app/leads/new');
    assert.match(page.text, /valid mobile/i);
  });
});
