const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('../helpers');
const {
  Lead, Contact, InquiryTouch, Activity, Integration, WebhookEvent, MessageLog,
  LeadSource, Project, Stage, SubStage, AssignmentPool, Tenant,
} = require('../../src/db/models');

test('lead capture, webhooks and re-inquiry (§12, §13, §17, §63, §98)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  t.after(async () => { await h.stopServer(); });

  const rep = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Capture Rep', email: 'cap@alpha.test', roleName: 'Sales User',
  });
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { memberIds: [rep._id], cursor: 0 } });

  const webhook = await Integration.findOne({ tenantId, category: 'WEBSITE_WEBHOOK' }).lean();
  const post = (body, key = webhook.webhookKey, headers = {}) => h.client()
    .postJson(`/api/webhooks/leads/${key}`, body, { headers });

  const projectA = await Project.create({ tenantId, name: 'Skyline Heights', status: 'ACTIVE' });
  const projectB = await Project.create({ tenantId, name: 'Riverside Villas', status: 'ACTIVE' });

  await t.test('an inbound lead creates the contact, the lead, the touch and the SLA clock (§12.3)', async () => {
    const res = await post({
      name: 'Meera Shah',
      phone: '98250 11223',
      email: 'meera@example.com',
      city: 'Ahmedabad',
      project: 'Skyline Heights',
      lead_id: 'ext-1001',
      campaign_id: 'camp-77',
      utm_source: 'facebook',
      message: 'Looking for a 3BHK',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.ok, true);

    const lead = await Lead.findOne({ tenantId, _id: res.data.leadId }).lean();
    const contact = await Contact.findOne({ tenantId, _id: res.data.contactId }).lean();
    assert.equal(contact.normalizedMobile, '+919825011223');
    assert.equal(contact.displayName, 'Meera Shah');
    assert.equal(String(lead.projectId), String(projectA._id), 'the project was resolved by name');
    assert.equal(String(lead.ownerUserId), String(rep._id), 'round robin assigned it');
    assert.ok(lead.slaTargetSeconds, 'the SLA clock started');
    assert.equal(lead.slaStatus, 'PENDING');
    assert.equal(lead.firstGenuineActionAt, undefined);

    const touch = await InquiryTouch.findOne({ tenantId, leadId: lead._id }).lean();
    assert.equal(touch.isFirstTouch, true);
    assert.equal(touch.externalCampaignId, 'camp-77');
    assert.equal(touch.utm.source, 'facebook');

    const event = await WebhookEvent.findOne({ tenantId, idempotencyKey: 'ext-1001' }).lean();
    assert.equal(event.status, 'PROCESSED');
    assert.equal(String(event.leadId), String(lead._id));
  });

  await t.test('the acknowledgement goes out and lands on the timeline (§17)', async () => {
    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919825011223' }).lean();
    const message = await MessageLog.findOne({ tenantId, contactId: contact._id, purpose: 'ACKNOWLEDGEMENT' }).lean();
    assert.ok(message, 'an acknowledgement was sent');
    assert.equal(message.channel, 'WHATSAPP');
    assert.equal(message.status, 'SENT');
    assert.match(message.body, /Meera/, 'the template variables were rendered');
    assert.match(message.body, /Skyline Heights/);
    assert.ok(!message.body.includes('{{'), 'no placeholder survived');

    const activity = await Activity.findOne({ tenantId, type: 'ACKNOWLEDGEMENT_SENT' }).lean();
    assert.ok(activity);
  });

  await t.test('the captured lead shows up on the owner\'s New Leads tile (§8.2)', async () => {
    const c = h.client();
    await c.login('cap@alpha.test');
    const dash = await c.get('/app/dashboard?tile=new');
    assert.match(h.queueSection(dash.text), /Meera Shah/);
  });

  await t.test('a redelivered webhook does not create a second inquiry (§98)', async () => {
    const before = await Lead.countDocuments({ tenantId });
    const touchesBefore = await InquiryTouch.countDocuments({ tenantId });

    const res = await post({ name: 'Meera Shah', phone: '9825011223', lead_id: 'ext-1001', project: 'Skyline Heights' });
    assert.equal(res.status, 200);
    assert.equal(res.data.duplicate, true);

    assert.equal(await Lead.countDocuments({ tenantId }), before);
    assert.equal(await InquiryTouch.countDocuments({ tenantId }), touchesBefore, 'not even a touch was added');
  });

  await t.test('the same person inquiring again on the same project is a re-inquiry, not a duplicate (§13.2)', async () => {
    const before = await Lead.findOne({ tenantId, projectId: projectA._id }).lean();
    const originalSourceId = before.originalSourceId;

    const portalSource = await LeadSource.findOne({ tenantId, name: '99acres' }).lean();
    const res = await post({
      name: 'Meera Shah', phone: '+91 98250 11223', project: 'Skyline Heights',
      lead_id: 'ext-1002', sourceId: String(portalSource._id),
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reinquiry, true);
    assert.equal(String(res.data.leadId), String(before._id), 'the same opportunity, not a new one');

    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919825011223' }), 1, 'still one contact');
    assert.equal(await Lead.countDocuments({ tenantId, contactId: before.contactId, projectId: projectA._id }), 1);

    const after = await Lead.findOne({ tenantId, _id: before._id }).lean();
    assert.equal(String(after.originalSourceId), String(originalSourceId), 'the original source is untouched (§55.6)');
    assert.equal(String(after.latestSourceId), String(portalSource._id), 'only the latest source moved');
    assert.equal(after.inquiryCount, 2);
    assert.equal(after.isReinquiry, true);
    assert.ok(after.reinquiryPendingAt);

    assert.equal(await InquiryTouch.countDocuments({ tenantId, leadId: before._id }), 2, 'both touches kept (§40)');
    assert.ok(await Activity.findOne({ tenantId, leadId: before._id, type: 'REINQUIRY' }));
  });

  await t.test('the re-inquiry surfaces on its own tile and clears once worked (§8.2)', async () => {
    const c = h.client();
    await c.login('cap@alpha.test');
    const dash = await c.get('/app/dashboard?tile=reinquiry');
    assert.match(h.queueSection(dash.text), /Meera Shah/);

    const lead = await Lead.findOne({ tenantId, isReinquiry: true }).lean();
    const { ActionType } = require('../../src/db/models');
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
    const tz = require('../../src/lib/tz');

    await c.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      nextActionTypeId: String(actions.CALL._id),
      nextDate: tz.toDateInput(new Date(Date.now() + 86400000), 'Asia/Kolkata'),
      nextTime: '11:00',
    }, `/app/leads/${lead._id}`);

    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(after.reinquiryPendingAt, undefined, 'cleared from the tile once worked');
    assert.equal(after.inquiryCount, 2, 'the history stays');
  });

  await t.test('the same person on a different project gets their own lead (§13.3)', async () => {
    const res = await post({
      name: 'Meera Shah', phone: '9825011223', project: 'Riverside Villas', lead_id: 'ext-1003',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reinquiry, false);

    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919825011223' }).lean();
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919825011223' }), 1);
    assert.equal(await Lead.countDocuments({ tenantId, contactId: contact._id }), 2, 'one opportunity per project');
    const newLead = await Lead.findOne({ tenantId, _id: res.data.leadId }).lean();
    assert.equal(String(newLead.projectId), String(projectB._id));
  });

  await t.test('a lost lead is reopened by a new inquiry, keeping the lost history (§13.4)', async () => {
    const lead = await Lead.findOne({ tenantId, projectId: projectB._id }).lean();
    const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
    const reason = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    const leadsService = require('../../src/services/leads');
    await leadsService.changeStage({
      tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.LOST._id, subStageId: reason._id,
    });
    assert.equal((await Lead.findOne({ tenantId, _id: lead._id }).lean()).status, 'TERMINAL');

    const res = await post({
      name: 'Meera Shah', phone: '9825011223', project: 'Riverside Villas', lead_id: 'ext-1004',
    });
    assert.equal(res.status, 201);
    assert.equal(String(res.data.leadId), String(lead._id), 'the same lead came back to life');

    const reopened = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(reopened.status, 'ACTIVE');
    assert.ok(reopened.lostAt, 'the previous lost event is preserved');
    assert.ok(await Activity.findOne({ tenantId, leadId: lead._id, type: 'LEAD_REOPENED' }));
  });

  await t.test('an unknown webhook key is rejected', async () => {
    const res = await post({ name: 'Nobody', phone: '9999999999' }, 'not-a-real-key');
    assert.equal(res.status, 404);
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919999999999' }), 0);
  });

  await t.test('a payload with no usable mobile fails loudly and stays visible (§106)', async () => {
    const res = await post({ name: 'No Number', lead_id: 'ext-bad-1' });
    assert.equal(res.status, 400);

    const event = await WebhookEvent.findOne({ tenantId, idempotencyKey: 'ext-bad-1' }).lean();
    assert.equal(event.status, 'FAILED');
    assert.match(event.error, /mobile/i);

    const integration = await Integration.findOne({ tenantId, _id: webhook._id }).lean();
    assert.equal(integration.status, 'ATTENTION_REQUIRED');

    const admin = h.client();
    await admin.login('admin@alpha.test');
    const health = await admin.get('/app/setup/health');
    assert.equal(health.status, 200);
    assert.match(health.text, /ext-bad-1|mobile/i);
  });

  await t.test('a signed integration rejects a bad signature (§63)', async () => {
    const secretbox = require('../../src/lib/secretbox');
    const signed = await Integration.create({
      tenantId,
      category: 'PROPERTY_PORTAL',
      provider: 'housing',
      webhookKey: crypto.randomBytes(12).toString('base64url'),
      secrets: { signingSecret: secretbox.seal('super-secret') },
    });

    const body = { name: 'Signed Lead', phone: '9825099001', lead_id: 'sig-1' };
    const bad = await post(body, signed.webhookKey, { 'x-signature': 'sha256=deadbeef' });
    assert.equal(bad.status, 401);

    const digest = `sha256=${crypto.createHmac('sha256', 'super-secret').update(JSON.stringify(body)).digest('hex')}`;
    const good = await post(body, signed.webhookKey, { 'x-signature': digest });
    assert.equal(good.status, 201);
    assert.ok(await Contact.findOne({ tenantId, normalizedMobile: '+919825099001' }));
  });

  await t.test('a stored secret is never rendered back to the browser (§49.1)', async () => {
    const admin = h.client();
    await admin.login('admin@alpha.test');
    const page = await admin.get('/app/setup/integrations');
    assert.equal(page.status, 200);
    assert.ok(!page.text.includes('super-secret'), 'the plaintext secret never leaves the server');
    assert.ok(!/v1\.[A-Za-z0-9_-]{10,}/.test(page.text), 'not even the sealed ciphertext is rendered');

    // The API representation drops secrets entirely (§49.1).
    const stored = await Integration.findOne({ tenantId, provider: 'housing' });
    assert.equal(stored.toJSON().secrets, undefined);
    assert.ok(stored.secrets.get('signingSecret').startsWith('v1.'), 'it is stored sealed, not in the clear');
  });

  await t.test("one tenant's webhook key cannot reach another tenant's data (§4.2)", async () => {
    const res = await post({ name: 'Cross Tenant', phone: '9825088001', lead_id: 'cross-1' });
    assert.equal(res.status, 201);
    assert.equal(await Contact.countDocuments({ tenantId: orgB.tenant._id, normalizedMobile: '+919825088001' }), 0);
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919825088001' }), 1);
  });

  await t.test('provider delivery callbacks move the message forward, never backward (§66)', async () => {
    const message = await MessageLog.findOne({ tenantId, status: 'SENT' }).lean();
    const messaging = require('../../src/services/messaging');
    await messaging.applyDeliveryUpdate({ tenantId, providerMessageId: message.providerMessageId, status: 'DELIVERED' });
    assert.equal((await MessageLog.findOne({ tenantId, _id: message._id }).lean()).status, 'DELIVERED');

    await messaging.applyDeliveryUpdate({ tenantId, providerMessageId: message.providerMessageId, status: 'SENT' });
    assert.equal(
      (await MessageLog.findOne({ tenantId, _id: message._id }).lean()).status, 'DELIVERED',
      'an out-of-order callback cannot undo delivery',
    );
  });

  await t.test('acknowledgement failure never blocks the lead (§17.4)', async () => {
    const messaging = require('../../src/services/messaging');
    const original = messaging.DRIVERS.mock;
    messaging.DRIVERS.mock = async () => { throw new Error('provider unavailable'); };
    try {
      const res = await post({ name: 'Ack Fail', phone: '9825077001', lead_id: 'ackfail-1' });
      assert.equal(res.status, 201, 'the lead was still captured');
      const lead = await Lead.findOne({ tenantId, _id: res.data.leadId }).lean();
      assert.ok(lead.ownerUserId, 'and still assigned');
      const failed = await Activity.findOne({ tenantId, leadId: lead._id, type: 'ACKNOWLEDGEMENT_FAILED' }).lean();
      assert.ok(failed, 'the failure is on the timeline');
    } finally {
      messaging.DRIVERS.mock = original;
    }
  });

  await t.test('opted-out contacts are skipped with a reason (§67)', async () => {
    const messaging = require('../../src/services/messaging');
    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919825011223' });
    contact.consent.dnd = true;
    await contact.save();

    const log = await messaging.send({
      tenantId, channel: 'WHATSAPP', contact: contact.toObject(), purpose: 'CAMPAIGN', body: 'Offer',
    });
    assert.equal(log.status, 'SKIPPED');
    assert.match(log.skippedReason, /do-not-contact/i);
  });

  await t.test('a re-inquiry restarts the response timer when the tenant asks for it (§13.2)', async () => {
    const tenant = await Tenant.findById(tenantId).lean();
    assert.equal(tenant.settings.reinquiryRestartsSla, true);

    const captureService = require('../../src/services/capture');
    const { lead } = await captureService.handleInquiry({
      tenantId, tenant, payload: { name: 'Timer Test', mobile: '9825066001', project: 'Skyline Heights' },
    });
    await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { slaStatus: 'AT_RISK' } });

    await captureService.handleInquiry({
      tenantId, tenant, payload: { name: 'Timer Test', mobile: '9825066001', project: 'Skyline Heights' },
    });
    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(after.slaStatus, 'PENDING', 'the clock restarted for the new inquiry');
  });
});
