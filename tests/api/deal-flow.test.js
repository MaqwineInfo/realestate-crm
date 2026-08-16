const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, LeadSource, Project, Tower, UnitType, Unit, PricingComponent, PaymentPlan,
  CostSheet, UnitBlock, Booking, Stage, SubStage, ActionType, Followup,
} = require('../../src/db/models');

/**
 * V1.1 §119–§121: the connected deal flow.
 *
 * Shortlist → Generate Quotation → Block Unit → Mark Booked, with a real unit
 * picker at every step and no raw ids typed anywhere. The backend rules were
 * already right; these tests are about the path the user actually walks.
 */
test('connected deal flow (V1.1 §38–§55)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Deal Rep', email: 'deal@alpha.test', roleName: 'Sales User',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

  const project = await Project.create({
    tenantId, name: 'Deal Towers', status: 'ACTIVE', city: 'Pune', code: 'DT', developerName: 'Deal Estates',
  });
  const tower = await Tower.create({ tenantId, projectId: project._id, name: 'Tower A', code: 'A' });
  const unitType = await UnitType.create({
    tenantId, projectId: project._id, name: '3 BHK', superBuiltUpArea: 1300, defaultBaseRateMinor: 520000,
  });
  const unitA = await Unit.create({
    tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
    unitNumber: 'A-801', floorNumber: 8, saleableArea: 1300, facing: 'East', status: 'AVAILABLE',
  });
  const unitB = await Unit.create({
    tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
    unitNumber: 'A-802', floorNumber: 8, saleableArea: 1300, facing: 'West', status: 'AVAILABLE',
  });
  await PricingComponent.create({
    tenantId, projectId: project._id, name: 'Base price', kind: 'BASE',
    calcType: 'PER_AREA', rateMinor: 520000, areaBasis: 'SALEABLE', displayOrder: 1,
  });
  const plan = await PaymentPlan.create({
    tenantId,
    projectId: project._id,
    name: 'Construction linked',
    type: 'CONSTRUCTION_LINKED',
    active: true,
    milestones: [
      { sequence: 1, label: 'On booking', percentage: 10, dueRule: 'ON_BOOKING', displayOrder: 1 },
      { sequence: 2, label: 'Plinth', percentage: 40, dueRule: 'CONSTRUCTION', displayOrder: 2 },
      { sequence: 3, label: 'Structure', percentage: 40, dueRule: 'CONSTRUCTION', displayOrder: 3 },
      { sequence: 4, label: 'Possession', percentage: 10, dueRule: 'ON_POSSESSION', displayOrder: 4 },
    ],
  });

  const rep = h.client();
  await rep.login('deal@alpha.test');

  const admin = h.client();
  await admin.login('admin@alpha.test');

  const created = await admin.submit('/api/leads', {
    firstName: 'Deal', lastName: 'Customer', primaryMobile: '9330000001',
    sourceId: String(source._id), projectId: String(project._id),
    assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
  }, '/app/leads/new');
  const leadId = created.location.split('?')[0].split('/').pop();

  // The lead has to be attended before it can move down the deal path.
  const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await rep.submit(`/api/leads/${leadId}/log-action`, {
    actionTypeId: String(actions.CALL._id),
    stageId: String(stages.CONNECTED._id),
    nextActionTypeId: String(actions.SITE_VISIT._id), nextDate: soon, nextTime: '11:00',
  }, `/app/leads/${leadId}`);

  let sheetId;

  t.after(async () => { await h.stopServer(); });

  await t.test('the workspace offers the whole CTA chain (§81)', async () => {
    await rep.submit(`/api/leads/${leadId}/shortlists`, { unitId: String(unitA._id) }, `/app/leads/${leadId}`);
    const page = await rep.get(`/app/leads/${leadId}`);
    assert.match(page.text, /Generate quotation/);
    assert.match(page.text, /Block unit/);
    assert.match(page.text, /Mark booked/);
    assert.match(page.text, /id="deal"/, 'the deal card exists');
  });

  /* ------------------------------ §39–§43 -------------------------------- */

  await t.test('the quotation opens on a real unit picker (§40)', async () => {
    const page = await rep.get(`/app/leads/${leadId}/cost-sheets/new?step=unit`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Shortlisted for this lead/);
    assert.match(page.text, /A-801/, 'the shortlisted unit is offered');
    assert.match(page.text, /A-802/, 'and so is the rest of available inventory');
    assert.match(page.text, /All available units/);
  });

  await t.test('the payment plan step shows the schedule with real amounts (§41)', async () => {
    const planStep = await rep.get(`/app/leads/${leadId}/cost-sheets/new?unitId=${unitA._id}&step=plan`);
    assert.match(planStep.text, /Construction linked/);
    assert.match(planStep.text, /10% On booking/);

    const priced = await rep.get(
      `/app/leads/${leadId}/cost-sheets/new?unitId=${unitA._id}&paymentPlanId=${plan._id}&step=price`,
    );
    assert.match(priced.text, /Payment schedule/);
    assert.match(priced.text, /Final consideration/);
    // 1300 sqft × ₹5,200 = ₹67,60,000 → 10% = ₹6,76,000
    assert.match(priced.text, /6,76,000/, 'the installment amount is computed, not just the percentage');
  });

  await t.test('saving freezes the plan onto the quotation (§44)', async () => {
    const res = await rep.submit(`/api/leads/${leadId}/cost-sheets`, {
      unitId: String(unitA._id), paymentPlanId: String(plan._id),
    }, `/app/leads/${leadId}/cost-sheets/new?unitId=${unitA._id}`);
    assert.equal(res.status, 302);
    sheetId = res.location.split('/').pop();

    const sheet = await CostSheet.findOne({ tenantId, _id: sheetId }).lean();
    assert.equal(sheet.paymentPlanName, 'Construction linked');
    assert.equal(sheet.paymentPlanRows.length, 4);
    assert.equal(sheet.paymentPlanBasis, 'FINAL_CONSIDERATION');
    assert.match(sheet.quotationNumber, /^QTN-DT-\d{4}-00001$/, 'a number a human can read out');

    // Change the project plan afterwards — the issued quotation must not move.
    await PaymentPlan.updateOne({ tenantId, _id: plan._id }, {
      $set: {
        milestones: [
          { sequence: 1, label: 'Everything on booking', percentage: 100, dueRule: 'ON_BOOKING', displayOrder: 1 },
        ],
      },
    });
    const after = await CostSheet.findOne({ tenantId, _id: sheetId }).lean();
    assert.equal(after.paymentPlanRows.length, 4, 'the customer’s copy is unchanged');

    const costsheets = require('../../src/services/costsheets');
    const schedule = costsheets.scheduleFor(after);
    assert.equal(schedule.length, 4);
    assert.equal(
      schedule.reduce((s, r) => s + r.amountMinor, 0),
      after.finalConsiderationMinor,
      'the schedule totals the consideration exactly',
    );

    // Put the project plan back for the booking steps below.
    await PaymentPlan.updateOne({ tenantId, _id: plan._id }, {
      $set: {
        milestones: [
          { sequence: 1, label: 'On booking', percentage: 10, dueRule: 'ON_BOOKING', displayOrder: 1 },
          { sequence: 2, label: 'Plinth', percentage: 40, dueRule: 'CONSTRUCTION', displayOrder: 2 },
          { sequence: 3, label: 'Structure', percentage: 40, dueRule: 'CONSTRUCTION', displayOrder: 3 },
          { sequence: 4, label: 'Possession', percentage: 10, dueRule: 'ON_POSSESSION', displayOrder: 4 },
        ],
      },
    });
  });

  await t.test('the quotation page offers Block this unit (§45)', async () => {
    const page = await rep.get(`/app/cost-sheets/${sheetId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Block this unit/);
    assert.match(page.text, /Payment schedule/);
    assert.match(page.text, /QTN-DT-/);
  });

  /* ------------------------------ §46–§48 -------------------------------- */

  await t.test('the block flow picks a unit and states the deadline first (§46, §48)', async () => {
    const picker = await rep.get(`/app/leads/${leadId}/blocks/new`);
    assert.equal(picker.status, 200);
    assert.match(picker.text, /Shortlisted for this customer/);
    assert.match(picker.text, /A-801/);

    const commercial = await rep.get(`/app/leads/${leadId}/blocks/new?unitId=${unitA._id}`);
    assert.match(commercial.text, /Block valid until/);
    assert.match(commercial.text, /Confirm block/);
    // §47: the live quotation for this unit is preselected.
    assert.match(commercial.text, new RegExp(`value="${sheetId}"[^>]*selected`));
    assert.equal(await UnitBlock.countDocuments({ tenantId, leadId }), 0, 'looking does not block');
  });

  await t.test('confirming the block holds the unit and moves the stage (§48)', async () => {
    const res = await rep.submit(`/api/leads/${leadId}/blocks`, {
      unitId: String(unitA._id), costSheetId: sheetId, tokenAmount: '100000',
    }, `/app/leads/${leadId}/blocks/new?unitId=${unitA._id}`);
    assert.equal(res.status, 302);

    const block = await UnitBlock.findOne({ tenantId, leadId, status: 'ACTIVE' }).lean();
    assert.ok(block, 'the block exists');
    assert.ok(block.expiryAt, 'with the deadline stored on it');
    assert.equal((await Unit.findOne({ tenantId, _id: unitA._id }).lean()).status, 'BLOCKED');

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(String(lead.stageId), String(stages.BLOCKED._id), 'the stage followed the action');
    assert.equal(lead.status, 'ACTIVE', 'and the lead is still open');
  });

  /* ------------------------------ §49–§55 -------------------------------- */

  await t.test('Mark Booked prefills from the block and passes its checklist (§51.1, §53)', async () => {
    const page = await rep.get(`/app/leads/${leadId}/bookings/new`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Mark booked/);
    assert.match(page.text, /Unit blocked for this customer/);
    assert.match(page.text, /Payment plan configured/);
    assert.match(page.text, /Discount approval complete/);
    assert.doesNotMatch(page.text, /type="submit" disabled/, 'the CTA is live once the checklist clears');
    assert.match(page.text, /A-801/);
  });

  await t.test('the checklist blocks the CTA when a prerequisite is missing (§50, §53)', async () => {
    // A second lead with no block, on a project whose plans are all inactive.
    const other = await admin.submit('/api/leads', {
      firstName: 'Unready', primaryMobile: '9330000002',
      sourceId: String(source._id), projectId: String(project._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    const otherId = other.location.split('?')[0].split('/').pop();

    await PaymentPlan.updateOne({ tenantId, _id: plan._id }, { $set: { active: false } });
    const page = await rep.get(`/app/leads/${otherId}/bookings/new?unitId=${unitB._id}`);
    assert.match(page.text, /No active payment plan on this project/);
    assert.match(page.text, /disabled/, 'the confirm button is disabled');
    await PaymentPlan.updateOne({ tenantId, _id: plan._id }, { $set: { active: true } });
  });

  await t.test('booking without a block offers a unit picker rather than a dead end (§51.2)', async () => {
    const other = await Lead.findOne({ tenantId, 'contactId': { $exists: true }, projectId: project._id })
      .sort({ createdAt: -1 }).lean();
    const page = await rep.get(`/app/leads/${other._id}/bookings/new`);
    assert.match(page.text, /Choose the unit/);
    assert.match(page.text, /A-802/, 'available inventory is offered');
    assert.match(page.text, /Block a unit first/, 'and the recommended path is signposted');
  });

  await t.test('the booking completes and the success screen states what happened (§54)', async () => {
    const sheet = await CostSheet.findOne({ tenantId, _id: sheetId }).lean();
    const res = await rep.submit(`/api/leads/${leadId}/bookings`, {
      unitId: String(unitA._id),
      costSheetId: sheetId,
      bookingDate: new Date().toISOString().slice(0, 10),
      finalPrice: String(sheet.finalConsiderationMinor / 100),
      bookingAmount: '500000',
      paymentPlanId: String(plan._id),
      buyerPurpose: 'SELF_USE',
    }, `/app/leads/${leadId}/bookings/new`);
    assert.equal(res.status, 302);

    const page = await rep.get(res.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /BOOKING COMPLETED|Booking completed/i);
    assert.match(page.text, /A-801/);

    const booking = await Booking.findOne({ tenantId, leadId }).lean();
    assert.ok(booking.sagaComplete, 'the side-effect saga finished');
    assert.equal((await Unit.findOne({ tenantId, _id: unitA._id }).lean()).status, 'BOOKED');
    assert.equal((await UnitBlock.findOne({ tenantId, _id: booking.blockId }).lean()).status, 'CONVERTED');

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.status, 'TERMINAL');
    assert.ok(lead.bookedAt);
    assert.equal(await Followup.countDocuments({ tenantId, leadId, status: 'PENDING' }), 0, 'follow-ups closed');
  });

  /* --------------------------------- §84 ---------------------------------- */

  await t.test('reopening a lost lead sets its next action in the same flow (§84)', async () => {
    const lost = await admin.submit('/api/leads', {
      firstName: 'Comeback', primaryMobile: '9330000003',
      sourceId: String(source._id), assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    const lostId = lost.location.split('?')[0].split('/').pop();
    const reason = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    await admin.submit(`/api/leads/${lostId}/stage`, {
      stageId: String(stages.LOST._id), subStageId: String(reason._id),
    }, `/app/leads/${lostId}`);

    const page = await admin.get(`/app/leads/${lostId}`);
    assert.match(page.text, /Next action<\/legend>/, 'the reopen drawer asks for it');

    const res = await admin.submit(`/api/leads/${lostId}/reopen`, {
      stageId: String(stages.CONNECTED._id),
      reason: 'Customer called back',
      nextActionTypeId: String(actions.CALL._id),
      nextDate: soon,
      nextTime: '15:00',
    }, `/app/leads/${lostId}`);
    assert.equal(res.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: lostId }).lean();
    assert.equal(lead.status, 'ACTIVE');
    assert.ok(lead.nextActionAt, 'it comes back with a next action, not a gap');
    assert.ok(lead.lostAt, 'and keeps its lost history');
  });
});
