const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Contact, Lead, Tag, Template, MarketingCampaign, CommunicationCampaign, MessageLog,
  Project, LeadSource, Tenant, Booking, PaymentPlan, Unit, UnitType, Stage, ActionType,
  NurtureSequence, NurtureEnrollment, Followup, Activity, AssignmentPool,
} = require('../../src/db/models');
const money = require('../../src/lib/money');

test('contact book, campaigns and attribution (§37–§40, §93)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  t.after(async () => { await h.stopServer(); });

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Mkt Rep', email: 'mkt@alpha.test', roleName: 'Sales User',
  });
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { memberIds: [seller._id], cursor: 0 } });

  const projectsService = require('../../src/services/projects');
  const project = await projectsService.create({
    tenantId, actor: orgA.admin, data: { name: 'Campaign Towers', status: 'ACTIVE', city: 'Ahmedabad' },
  });
  const investorTag = await Tag.findOne({ tenantId, nameLower: 'investor' }).lean();

  const admin = h.client();
  await admin.login('admin@alpha.test');

  /* --------------------------- audience & segments -------------------------- */

  await t.test('the audience filter counts exactly who would be messaged (§37.2)', async () => {
    const contactsService = require('../../src/services/contacts');
    for (const [name, mobile, city, tagged] of [
      ['Ira Investor', '9700100001', 'Ahmedabad', true],
      ['Bala Buyer', '9700100002', 'Ahmedabad', false],
      ['Nita NRI', '9700100003', 'Mumbai', true],
    ]) {
      await contactsService.create({
        tenantId, tenant: orgA.tenant, actor: orgA.admin,
        payload: { firstName: name.split(' ')[0], lastName: name.split(' ')[1], primaryMobile: mobile, city, tagIds: tagged ? [investorTag._id] : [] },
      });
    }

    const segments = require('../../src/services/segments');
    assert.equal(await segments.count({ tenantId, filters: {} }), 3);
    assert.equal(await segments.count({ tenantId, filters: { tagId: investorTag._id } }), 2);
    assert.equal(await segments.count({ tenantId, filters: { city: 'ahmedabad' } }), 2, 'city match is case-insensitive');
    assert.equal(await segments.count({ tenantId, filters: { tagId: investorTag._id, city: 'Mumbai' } }), 1);
  });

  let campaignId;

  await t.test('a campaign shows its recipient count before it sends (§38.4)', async () => {
    const page = await admin.get(`/app/campaigns/communication/new?tagId=${investorTag._id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /2 contacts/);

    const template = await Template.findOne({ tenantId, channel: 'WHATSAPP' }).lean();
    const res = await admin.submit('/api/campaigns/communication', {
      name: 'Investor offer', channel: 'WHATSAPP', templateId: String(template._id),
      tagId: String(investorTag._id), saveSegmentAs: 'Investors',
    }, `/app/campaigns/communication/new?tagId=${investorTag._id}`);
    assert.equal(res.status, 302);
    campaignId = res.location.split('/').pop();

    const campaign = await CommunicationCampaign.findOne({ tenantId, _id: campaignId }).lean();
    assert.equal(campaign.status, 'DRAFT', 'saving does not send');
    assert.equal(await MessageLog.countDocuments({ tenantId, campaignId }), 0);

    const { SavedSegment } = require('../../src/db/models');
    assert.ok(await SavedSegment.findOne({ tenantId, name: 'Investors' }), 'the audience was saved as a segment');
  });

  await t.test('sending excludes opted-out contacts and counts them (§67, §102)', async () => {
    const optedOut = await Contact.findOne({ tenantId, normalizedMobile: '+919700100001' });
    optedOut.consent.whatsappOptOut = true;
    await optedOut.save();

    await admin.get(`/app/campaigns/${campaignId}`);
    const res = await admin.submit(`/api/campaigns/${campaignId}/send`, {}, `/app/campaigns/${campaignId}`);
    assert.equal(res.status, 302);

    const campaign = await CommunicationCampaign.findOne({ tenantId, _id: campaignId }).lean();
    assert.equal(campaign.status, 'SENT');
    assert.equal(campaign.recipientCount, 2);
    assert.equal(campaign.sentCount, 1);
    assert.equal(campaign.excludedCount, 1, 'the opted-out contact was excluded, not silently dropped');

    const skipped = await MessageLog.findOne({ tenantId, campaignId, status: 'SKIPPED' }).lean();
    assert.match(skipped.skippedReason, /opted out/i);

    const sent = await MessageLog.findOne({ tenantId, campaignId, status: 'SENT' }).lean();
    assert.match(sent.body, /Nita|Ira/, 'the template was rendered per recipient');
  });

  await t.test('a campaign cannot be sent twice (§38.4)', async () => {
    const before = await MessageLog.countDocuments({ tenantId, campaignId });
    const res = await admin.submit(`/api/campaigns/${campaignId}/send`, {}, `/app/campaigns/${campaignId}`);
    assert.equal(res.status, 302);
    assert.match((await admin.get(`/app/campaigns/${campaignId}`)).text, /already sent/i);
    assert.equal(await MessageLog.countDocuments({ tenantId, campaignId }), before, 'no duplicate messages');
  });

  /* ------------------------------- attribution ------------------------------ */

  await t.test('campaign performance ties spend to real bookings (§39.2, §93)', async () => {
    const captureService = require('../../src/services/capture');
    const tenant = await Tenant.findById(tenantId).lean();

    const cheapButUseless = await MarketingCampaign.create({
      tenantId, name: 'Cheap clicks', platform: 'META', projectId: project._id, spendMinor: money.toMinor('100000'),
    });
    const pricyButGood = await MarketingCampaign.create({
      tenantId, name: 'Quality intent', platform: 'GOOGLE', projectId: project._id, spendMinor: money.toMinor('100000'),
    });

    // Campaign A: three leads, nothing happens.
    for (let i = 0; i < 3; i += 1) {
      await captureService.handleInquiry({
        tenantId, tenant,
        payload: { name: `Cheap ${i}`, mobile: `97002000${10 + i}`, projectId: project._id, campaignId: cheapButUseless._id },
      });
    }
    // Campaign B: one lead that goes all the way to a booking.
    const { lead } = await captureService.handleInquiry({
      tenantId, tenant,
      payload: { name: 'Quality Buyer', mobile: '9700300010', projectId: project._id, campaignId: pricyButGood._id },
    });

    const unitType = await UnitType.create({
      tenantId, projectId: project._id, name: '2 BHK', superBuiltUpArea: 1000, defaultBaseRateMinor: money.toMinor('5000'),
    });
    const unit = await Unit.create({
      tenantId, projectId: project._id, unitTypeId: unitType._id, unitNumber: 'C-101', saleableArea: 1000, floorNumber: 1,
    });
    const plan = await PaymentPlan.create({ tenantId, projectId: project._id, name: 'Down payment' });

    await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { firstGenuineActionAt: new Date(), completedVisitCount: 1 } });
    const bookings = require('../../src/services/bookings');
    await bookings.createBooking({
      tenantId, actor: orgA.admin, leadId: lead._id, unitId: unit._id,
      bookingDate: new Date(), finalPriceMinor: money.toMinor('5000000'),
      bookingAmountMinor: money.toMinor('100000'), paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
    });

    const attribution = require('../../src/services/attribution');
    const result = await attribution.performance({ tenantId, tenant });

    const cheap = result.rows.find((r) => String(r._id) === String(cheapButUseless._id));
    const good = result.rows.find((r) => String(r._id) === String(pricyButGood._id));

    assert.equal(cheap.leads, 3);
    assert.equal(cheap.bookings, 0);
    assert.equal(cheap.roas, 0, 'spend with no revenue');
    assert.ok(cheap.cplMinor < good.cplMinor, 'the useless campaign has the better CPL');

    assert.equal(good.leads, 1);
    assert.equal(good.bookings, 1);
    assert.equal(good.revenueMinor, money.toMinor('5000000'));
    assert.ok(good.roas > 1, 'and yet it is the campaign that actually works (§91)');
    assert.equal(good.costPerBookingMinor, money.toMinor('100000'));
  });

  await t.test('switching the attribution model changes the answer, not the data (§40.2)', async () => {
    const attribution = require('../../src/services/attribution');
    const captureService = require('../../src/services/capture');
    const tenant = await Tenant.findById(tenantId).lean();

    const first = await MarketingCampaign.create({ tenantId, name: 'First touch camp', platform: 'META', spendMinor: money.toMinor('50000') });
    const last = await MarketingCampaign.create({ tenantId, name: 'Last touch camp', platform: 'GOOGLE', spendMinor: money.toMinor('50000') });

    const { lead } = await captureService.handleInquiry({
      tenantId, tenant,
      payload: { name: 'Multi Touch', mobile: '9700400010', projectId: project._id, campaignId: first._id },
    });
    // A second inquiry from a different campaign.
    await captureService.handleInquiry({
      tenantId, tenant,
      payload: { name: 'Multi Touch', mobile: '9700400010', projectId: project._id, campaignId: last._id },
    });

    const touches = await require('../../src/db/models').InquiryTouch.countDocuments({ tenantId, leadId: lead._id });
    assert.equal(touches, 2, 'both touches are kept (§40.1)');

    const stored = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(String(stored.firstTouchCampaignId), String(first._id));
    assert.equal(String(stored.lastTouchCampaignId), String(last._id));

    const lastTouch = await attribution.performance({ tenantId, tenant: { settings: { attributionModel: 'LAST_TOUCH' } } });
    assert.equal(lastTouch.rows.find((r) => String(r._id) === String(last._id)).leads, 1);
    assert.equal(lastTouch.rows.find((r) => String(r._id) === String(first._id)).leads, 0);

    const firstTouch = await attribution.performance({ tenantId, tenant: { settings: { attributionModel: 'FIRST_TOUCH' } } });
    assert.equal(firstTouch.rows.find((r) => String(r._id) === String(first._id)).leads, 1);
    assert.equal(firstTouch.rows.find((r) => String(r._id) === String(last._id)).leads, 0);
  });

  await t.test('a booked lead exposes its full marketing lineage (§119)', async () => {
    const attribution = require('../../src/services/attribution');
    const booked = await Lead.findOne({ tenantId, bookedAt: { $ne: null } }).lean();
    const lineage = await attribution.lineage({ tenantId, tenant: orgA.tenant, leadId: booked._id });

    assert.ok(lineage.firstTouch, 'first touch preserved');
    assert.ok(lineage.lastTouch, 'last touch preserved');
    assert.ok(lineage.attributionModel);
    assert.ok(lineage.attributed, 'and the campaign that gets the credit');
  });

  await t.test('the performance page renders both models', async () => {
    const page = await admin.get('/app/campaigns/performance');
    assert.equal(page.status, 200);
    assert.match(page.text, /Quality intent/);
    assert.match(page.text, /ROAS|Cost\/booking/);

    const switched = await admin.submit('/api/campaigns/attribution', { attributionModel: 'FIRST_TOUCH' }, '/app/campaigns/performance');
    assert.equal(switched.status, 302);
    assert.equal((await Tenant.findById(tenantId).lean()).settings.attributionModel, 'FIRST_TOUCH');
    assert.equal((await admin.get('/app/campaigns/performance')).status, 200);
  });
});

test('nurture cadence (§19)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  t.after(async () => { await h.stopServer(); });

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Nurture Rep', email: 'nurture@alpha.test', roleName: 'Sales User',
  });
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
  const template = await Template.findOne({ tenantId, channel: 'WHATSAPP' }).lean();
  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const leadsService = require('../../src/services/leads');
  const nurture = require('../../src/services/nurture');

  const sequence = await NurtureSequence.create({
    tenantId,
    name: 'Connected follow-through',
    stageId: stages.CONNECTED._id,
    steps: [
      { stepNumber: 1, delayDays: 0, kind: 'MESSAGE', channel: 'WHATSAPP', templateId: template._id },
      { stepNumber: 2, delayDays: 3, kind: 'TASK', actionTypeId: actions.CALL._id, note: 'Check in' },
    ],
  });

  const makeLead = async (mobile, name) => {
    const { lead } = await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: name, primaryMobile: mobile, sourceId: source._id, ownerUserId: seller._id },
    });
    return lead;
  };

  await t.test('a lead entering the trigger stage is enrolled once (§19.1)', async () => {
    const lead = await makeLead('9800100001', 'Nurture One');
    await leadsService.changeStage({ tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.CONNECTED._id });
    await new Promise((r) => setTimeout(r, 150)); // events dispatch asynchronously

    const enrollments = await NurtureEnrollment.find({ tenantId, leadId: lead._id }).lean();
    assert.equal(enrollments.length, 1);
    assert.equal(enrollments[0].status, 'ACTIVE');
    assert.equal(enrollments[0].nextStepNumber, 1);

    // Re-entering the same stage must not enroll twice.
    await leadsService.changeStage({ tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.NOT_CONNECTED._id, subStageId: (await require('../../src/db/models').SubStage.findOne({ tenantId, stageId: stages.NOT_CONNECTED._id }).lean())._id });
    await leadsService.changeStage({ tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.CONNECTED._id });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await NurtureEnrollment.countDocuments({ tenantId, leadId: lead._id }), 1);
  });

  await t.test('due steps run and the cadence advances (§19.2)', async () => {
    const lead = await Lead.findOne({ tenantId, normalizedMobile: null }).lean() || await Lead.findOne({ tenantId }).lean();
    const result = await nurture.tick({ tenantId });
    assert.ok(result.ran >= 1);

    const enrollment = await NurtureEnrollment.findOne({ tenantId, sequenceId: sequence._id }).lean();
    assert.equal(enrollment.nextStepNumber, 2, 'moved on to the next step');
    assert.ok(enrollment.nextRunAt > new Date(), 'and it is scheduled for later');

    assert.ok(await MessageLog.findOne({ tenantId, purpose: 'NURTURE' }), 'the message step sent');
    assert.ok(await Activity.findOne({ tenantId, type: 'NURTURE_STEP_SENT' }), 'and it is on the timeline');
    assert.ok(lead);
  });

  await t.test('a step is never run twice by a repeated tick (§106)', async () => {
    const before = await MessageLog.countDocuments({ tenantId, purpose: 'NURTURE' });
    await nurture.tick({ tenantId });
    assert.equal(await MessageLog.countDocuments({ tenantId, purpose: 'NURTURE' }), before);
  });

  await t.test('a task step creates work for the current lead owner (§19.4)', async () => {
    const enrollment = await NurtureEnrollment.findOne({ tenantId, sequenceId: sequence._id });
    await NurtureEnrollment.updateOne({ tenantId, _id: enrollment._id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    await nurture.tick({ tenantId });

    const task = await Followup.findOne({ tenantId, leadId: enrollment.leadId, createdVia: 'NURTURE' }).lean();
    assert.ok(task, 'a follow-up was created');
    assert.equal(String(task.assignedUserId), String(seller._id), 'assigned to the lead owner');
  });

  await t.test('booking or losing a lead stops the cadence (§19.3)', async () => {
    const lead = await makeLead('9800100002', 'Nurture Two');
    await leadsService.changeStage({ tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.CONNECTED._id });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await NurtureEnrollment.countDocuments({ tenantId, leadId: lead._id, status: 'ACTIVE' }), 1);

    const lostReason = await require('../../src/db/models').SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    await leadsService.changeStage({
      tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.LOST._id, subStageId: lostReason._id,
    });
    await new Promise((r) => setTimeout(r, 150));

    const enrollment = await NurtureEnrollment.findOne({ tenantId, leadId: lead._id }).lean();
    assert.equal(enrollment.status, 'STOPPED');
    assert.match(enrollment.stoppedReason, /closed|lost/i);
  });

  await t.test('a do-not-contact customer is dropped from the cadence (§19.3)', async () => {
    const lead = await makeLead('9800100003', 'Nurture Three');
    await leadsService.changeStage({ tenantId, actor: orgA.admin, leadId: lead._id, stageId: stages.CONNECTED._id });
    await new Promise((r) => setTimeout(r, 150));

    await Contact.updateOne({ tenantId, _id: lead.contactId }, { $set: { 'consent.dnd': true } });
    await NurtureEnrollment.updateOne({ tenantId, leadId: lead._id }, { $set: { nextRunAt: new Date(Date.now() - 1000) } });
    await nurture.tick({ tenantId });

    const enrollment = await NurtureEnrollment.findOne({ tenantId, leadId: lead._id }).lean();
    assert.equal(enrollment.status, 'STOPPED');
    assert.match(enrollment.stoppedReason, /do-not-contact/i);
  });
});
