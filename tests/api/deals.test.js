const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Project, Tower, UnitType, Unit, PricingComponent, PaymentPlan, ApprovalRule, Approval,
  CostSheet, UnitBlock, Booking, Lead, LeadSource, Stage, SubStage, ActionType,
  ResaleOpportunity, RentalOpportunity, Activity, Followup, Notification, UnitShortlist,
} = require('../../src/db/models');
const money = require('../../src/lib/money');
const tzLib = require('../../src/lib/tz');

/** Builds a project with towers, units and a full pricing profile. */
async function buildProject({ tenantId, orgA, name = 'Skyline Heights' }) {
  const projectsService = require('../../src/services/projects');
  const project = await projectsService.create({
    tenantId, actor: orgA.admin, data: { name, status: 'ACTIVE', city: 'Ahmedabad' },
  });
  const tower = await projectsService.addTower({
    tenantId, actor: orgA.admin, projectId: project._id, data: { name: 'Tower A', code: 'A', floorCount: 3 },
  });
  const unitType = await projectsService.addUnitType({
    tenantId,
    projectId: project._id,
    data: {
      name: '3 BHK', propertyType: 'APARTMENT', bedrooms: 3,
      carpetArea: 900, builtUpArea: 1100, superBuiltUpArea: 1250,
      defaultBaseRateMinor: money.toMinor('5000'),
    },
  });
  await projectsService.generateUnits({
    tenantId, actor: orgA.admin, projectId: project._id, towerId: tower._id,
    unitTypeId: unitType._id, unitsPerFloor: 2,
  });

  // §30.1: base + floor rise + PLC + parking + GST.
  await PricingComponent.create([
    { tenantId, projectId: project._id, name: 'Base price', kind: 'BASE', calcType: 'PER_AREA', rateMinor: money.toMinor('5000'), areaBasis: 'SALEABLE', displayOrder: 1 },
    { tenantId, projectId: project._id, name: 'Floor rise', kind: 'FLOOR_RISE', calcType: 'PER_AREA', rateMinor: money.toMinor('25'), areaBasis: 'SALEABLE', displayOrder: 2 },
    { tenantId, projectId: project._id, name: 'Club membership', kind: 'CLUB', calcType: 'FIXED', rateMinor: money.toMinor('150000'), displayOrder: 3 },
    { tenantId, projectId: project._id, name: 'GST', kind: 'TAX', calcType: 'PERCENTAGE', percentage: 5, displayOrder: 9 },
    { tenantId, projectId: project._id, name: 'Stamp duty', kind: 'STAMP_DUTY', calcType: 'PERCENTAGE', percentage: 4.9, displayOrder: 10 },
  ]);

  const plan = await PaymentPlan.create({
    tenantId, projectId: project._id, name: 'Construction linked', type: 'CONSTRUCTION_LINKED',
  });
  return { project, tower, unitType, plan };
}

test('inventory, cost sheets, blocking and booking (§27–§36)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  t.after(async () => { await h.stopServer(); });

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Deal Seller', email: 'deal@alpha.test', roleName: 'Sales User',
  });
  const manager = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Deal Manager', email: 'dealmgr@alpha.test', roleName: 'Sales Manager',
  });

  const { project, tower, unitType, plan } = await buildProject({ tenantId, orgA });
  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const leadsService = require('../../src/services/leads');
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

  const makeLead = async (mobile, name) => {
    const { lead } = await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: name, primaryMobile: mobile, sourceId: source._id, projectId: project._id, ownerUserId: seller._id },
    });
    return lead;
  };

  const admin = h.client();
  await admin.login('admin@alpha.test');
  const rep = h.client();
  await rep.login('deal@alpha.test');

  await t.test('the hierarchy generates units with unique numbers (§27)', async () => {
    const units = await Unit.find({ tenantId, projectId: project._id }).sort({ unitNumber: 1 }).lean();
    assert.equal(units.length, 6, '3 floors × 2 units');
    assert.deepEqual(units.map((u) => u.unitNumber), ['101', '102', '201', '202', '301', '302']);
    assert.ok(units.every((u) => u.status === 'AVAILABLE'));

    // §27: the unique index really is enforced.
    await assert.rejects(
      () => Unit.create({ tenantId, projectId: project._id, towerId: tower._id, unitNumber: '101' }),
      /duplicate key/i,
    );

    // Re-running the generator adds nothing (it skips existing numbers).
    const projectsService = require('../../src/services/projects');
    const again = await projectsService.generateUnits({
      tenantId, actor: orgA.admin, projectId: project._id, towerId: tower._id,
      unitTypeId: unitType._id, unitsPerFloor: 2,
    });
    assert.equal(again.created, 0);
  });

  await t.test('the pricing engine computes the sheet server-side (§30, §85)', async () => {
    const pricing = require('../../src/services/pricing');
    const unit = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '301' }).lean();
    const result = await pricing.compute({ tenantId, unitId: unit._id });

    // 1250 sqft × ₹5000 = ₹62,50,000 base; floor rise ₹25 × 1250 × 3 floors = ₹93,750.
    assert.equal(result.basePriceMinor, money.toMinor('6250000'));
    const floorRise = result.lines.find((l) => l.kind === 'FLOOR_RISE');
    assert.equal(floorRise.amountMinor, money.toMinor('93750'));
    assert.equal(result.grossAmountMinor, money.toMinor('6250000') + money.toMinor('93750') + money.toMinor('150000'));

    // GST is 5% of the net, and stamp duty stays out of the total (§30.1).
    const gst = money.percentOf(result.grossAmountMinor, 5);
    assert.equal(result.taxAndChargesMinor, gst);
    assert.equal(result.finalConsiderationMinor, result.grossAmountMinor + gst);
    assert.ok(result.informationalLines.some((l) => l.kind === 'STAMP_DUTY'));
    assert.ok(!result.lines.some((l) => l.kind === 'STAMP_DUTY'), 'informational lines are not in the total');
  });

  await t.test('a discount is capped at the gross and reduces the tax base', async () => {
    const pricing = require('../../src/services/pricing');
    const unit = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '101' }).lean();
    const plain = await pricing.compute({ tenantId, unitId: unit._id });
    const discounted = await pricing.compute({ tenantId, unitId: unit._id, discountMinor: money.toMinor('100000') });

    assert.equal(discounted.discountMinor, money.toMinor('100000'));
    assert.ok(discounted.taxAndChargesMinor < plain.taxAndChargesMinor, 'tax follows the discounted value');
    assert.equal(
      discounted.finalConsiderationMinor,
      discounted.grossAmountMinor - discounted.discountMinor + discounted.taxAndChargesMinor,
    );

    const absurd = await pricing.compute({ tenantId, unitId: unit._id, discountMinor: money.toMinor('99999999') });
    assert.equal(absurd.discountMinor, absurd.grossAmountMinor, 'a discount can never exceed the gross');
    assert.ok(absurd.finalConsiderationMinor >= 0);
  });

  let leadA;
  let unit101;

  await t.test('shortlisting respects unit status (§29.2)', async () => {
    leadA = await makeLead('9900000001', 'Deal Customer');
    unit101 = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '101' }).lean();

    await rep.get(`/app/leads/${leadA._id}`);
    const res = await rep.submit(`/api/leads/${leadA._id}/shortlists`, { unitId: String(unit101._id) }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);

    const entries = await UnitShortlist.find({ tenantId, leadId: leadA._id, active: true }).lean();
    assert.equal(entries.length, 1);
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'UNIT_SHORTLISTED' }));

    // Removing it must not touch inventory (§29.2).
    await rep.submit(`/api/leads/${leadA._id}/shortlists/${unit101._id}/remove`, {}, `/app/leads/${leadA._id}`);
    assert.equal((await Unit.findOne({ tenantId, _id: unit101._id }).lean()).status, 'AVAILABLE');
    await rep.submit(`/api/leads/${leadA._id}/shortlists`, { unitId: String(unit101._id) }, `/app/leads/${leadA._id}`);
  });

  let sheetId;

  await t.test('a cost sheet saves the computed numbers and versions itself (§30.5)', async () => {
    await rep.get(`/app/leads/${leadA._id}/cost-sheets/new?unitId=${unit101._id}`);
    const res = await rep.submit(`/api/leads/${leadA._id}/cost-sheets`, {
      unitId: String(unit101._id), paymentPlanId: String(plan._id),
    }, `/app/leads/${leadA._id}/cost-sheets/new?unitId=${unit101._id}`);
    assert.equal(res.status, 302);
    sheetId = res.location.split('/').pop();

    const sheet = await CostSheet.findOne({ tenantId, _id: sheetId }).lean();
    assert.equal(sheet.version, 1);
    assert.equal(sheet.status, 'DRAFT');
    assert.ok(sheet.finalConsiderationMinor > 0);
    assert.ok(sheet.lines.length >= 3);

    // A second sheet for the same unit supersedes the first.
    const second = await rep.submit(`/api/leads/${leadA._id}/cost-sheets`, {
      unitId: String(unit101._id), paymentPlanId: String(plan._id),
    }, `/app/leads/${leadA._id}/cost-sheets/new?unitId=${unit101._id}`);
    const newId = second.location.split('/').pop();
    assert.equal((await CostSheet.findOne({ tenantId, _id: newId }).lean()).version, 2);
    assert.equal((await CostSheet.findOne({ tenantId, _id: sheetId }).lean()).status, 'SUPERSEDED');
    sheetId = newId;
  });

  await t.test('a discount over the threshold goes for approval and locks the sheet (§31)', async () => {
    await ApprovalRule.create({
      tenantId,
      projectId: null,
      name: 'Over 2% needs the manager',
      triggerType: 'DISCOUNT_PERCENTAGE',
      minThreshold: 2,
      level: 1,
      approverUserIds: [manager._id],
    });

    const res = await rep.submit(`/api/leads/${leadA._id}/cost-sheets`, {
      unitId: String(unit101._id), discount: '500000', paymentPlanId: String(plan._id),
    }, `/app/leads/${leadA._id}/cost-sheets/new?unitId=${unit101._id}`);
    const pendingId = res.location.split('/').pop();
    const sheet = await CostSheet.findOne({ tenantId, _id: pendingId }).lean();

    assert.ok(sheet.discountPercentage > 2);
    assert.equal(sheet.status, 'APPROVAL_PENDING');
    assert.equal(sheet.approvalRequired, true);

    const approval = await Approval.findOne({ tenantId, entityId: sheet._id }).lean();
    assert.ok(approval);
    assert.equal(approval.status, 'PENDING');
    assert.equal(approval.requestedDiscountMinor, sheet.discountMinor);
    assert.ok(await Notification.findOne({ tenantId, userId: manager._id, type: 'DISCOUNT_APPROVAL_REQUESTED' }));

    // §31.3: the requester cannot approve their own discount.
    const selfApprove = await rep.submit(`/api/approvals/${approval._id}`, { decision: 'APPROVE' }, `/app/leads/${leadA._id}`);
    assert.notEqual(selfApprove.status, 200);
    assert.equal((await Approval.findOne({ tenantId, _id: approval._id }).lean()).status, 'PENDING');

    // Nor can it be shared or booked while pending.
    const shareAttempt = await rep.submit(`/api/cost-sheets/${sheet._id}/share`, {}, `/app/cost-sheets/${sheet._id}`);
    assert.equal(shareAttempt.status, 302);
    assert.equal((await CostSheet.findOne({ tenantId, _id: sheet._id }).lean()).status, 'APPROVAL_PENDING');

    const mgr = h.client();
    await mgr.login('dealmgr@alpha.test');
    await mgr.get('/app/approvals');
    const decided = await mgr.submit(`/api/approvals/${approval._id}`, { decision: 'APPROVE', note: 'Fine for this one' }, '/app/approvals');
    assert.equal(decided.status, 302);

    const approved = await CostSheet.findOne({ tenantId, _id: sheet._id }).lean();
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.approvedAt);
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'DISCOUNT_APPROVED' }));
    sheetId = approved._id;
  });

  await t.test('changing the discount after approval invalidates it (§31.3, §102)', async () => {
    const res = await rep.submit(`/api/leads/${leadA._id}/cost-sheets`, {
      unitId: String(unit101._id), discount: '600000', paymentPlanId: String(plan._id),
    }, `/app/leads/${leadA._id}/cost-sheets/new?unitId=${unit101._id}`);
    const newSheet = await CostSheet.findOne({ tenantId, _id: res.location.split('/').pop() }).lean();

    assert.equal(newSheet.status, 'APPROVAL_PENDING', 'the new discount needs its own approval');
    assert.equal((await CostSheet.findOne({ tenantId, _id: sheetId }).lean()).status, 'SUPERSEDED');

    const mgr = h.client();
    await mgr.login('dealmgr@alpha.test');
    const approval = await Approval.findOne({ tenantId, entityId: newSheet._id, status: 'PENDING' }).lean();
    await mgr.get('/app/approvals');
    await mgr.submit(`/api/approvals/${approval._id}`, { decision: 'APPROVE' }, '/app/approvals');
    sheetId = newSheet._id;
  });

  await t.test('sharing produces a public link that shows only customer-visible lines', async () => {
    const res = await rep.submit(`/api/cost-sheets/${sheetId}/share`, {}, `/app/cost-sheets/${sheetId}`);
    assert.equal(res.status, 302);
    const sheet = await CostSheet.findOne({ tenantId, _id: sheetId }).lean();
    assert.equal(sheet.status, 'SHARED');
    assert.ok(sheet.shareToken);

    const anon = h.client();
    const page = await anon.get(`/share/cost-sheet/${sheet.shareToken}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Cost breakdown/);
    assert.match(page.text, /Deal Customer/);
  });

  let blockId;

  await t.test('blocking a unit moves inventory, stage and expiry together (§32, §55.12)', async () => {
    const res = await rep.submit(`/api/leads/${leadA._id}/blocks`, {
      unitId: String(unit101._id), costSheetId: String(sheetId), tokenAmount: '100000',
    }, `/app/leads/${leadA._id}`);
    assert.equal(res.status, 302);

    const unit = await Unit.findOne({ tenantId, _id: unit101._id }).lean();
    assert.equal(unit.status, 'BLOCKED');
    assert.equal(String(unit.heldForLeadId), String(leadA._id));

    const blockRecord = await UnitBlock.findOne({ tenantId, unitId: unit101._id, status: 'ACTIVE' }).lean();
    assert.ok(blockRecord);
    assert.ok(blockRecord.expiryAt, 'the resolved expiry is stored on the block (§96)');
    blockId = blockRecord._id;

    const lead = await Lead.findOne({ tenantId, _id: leadA._id }).lean();
    const blockStage = await Stage.findOne({ tenantId, semanticType: 'BLOCKED' }).lean();
    assert.equal(String(lead.stageId), String(blockStage._id), 'the lead stage followed the inventory action');
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'UNIT_BLOCKED' }));
  });

  await t.test('a second user cannot block the same unit (§32.5, §68)', async () => {
    const otherLead = await makeLead('9900000002', 'Second Customer');
    const res = await rep.submit(`/api/leads/${otherLead._id}/blocks`, {
      unitId: String(unit101._id),
    }, `/app/leads/${otherLead._id}`);
    assert.equal(res.status, 302);
    const page = await rep.get(`/app/leads/${otherLead._id}`);
    assert.match(page.text, /just blocked by another user/i);
    assert.equal(await UnitBlock.countDocuments({ tenantId, unitId: unit101._id, status: 'ACTIVE' }), 1);
  });

  await t.test('two simultaneous blocks produce exactly one winner (§32.5)', async () => {
    const blocks = require('../../src/services/blocks');
    const unit202 = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '202' }).lean();
    const leadX = await makeLead('9900000010', 'Racer One');
    const leadY = await makeLead('9900000011', 'Racer Two');

    const results = await Promise.allSettled([
      blocks.block({ tenantId, tenant: orgA.tenant, actor: seller, leadId: leadX._id, unitId: unit202._id }),
      blocks.block({ tenantId, tenant: orgA.tenant, actor: seller, leadId: leadY._id, unitId: unit202._id }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'exactly one block succeeded');
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /just blocked by another user/i);
    assert.equal(await UnitBlock.countDocuments({ tenantId, unitId: unit202._id, status: 'ACTIVE' }), 1);
    assert.equal((await Unit.findOne({ tenantId, _id: unit202._id }).lean()).status, 'BLOCKED');
  });

  await t.test('an expiring block reminds, then releases the unit (§32.4)', async () => {
    const blocks = require('../../src/services/blocks');
    const unit302 = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '302' }).lean();
    const leadZ = await makeLead('9900000012', 'Expiry Customer');
    const record = await blocks.block({ tenantId, tenant: orgA.tenant, actor: seller, leadId: leadZ._id, unitId: unit302._id });

    // Move the deadline inside the reminder window.
    await UnitBlock.updateOne({ tenantId, _id: record._id }, { $set: { expiryAt: new Date(Date.now() + 3600000) } });
    const reminded = await blocks.expirySweep({ tenantId });
    assert.ok(reminded.reminded >= 1);
    assert.ok(await Notification.findOne({ tenantId, type: 'BLOCK_EXPIRING', leadId: leadZ._id }));

    // Running again must not remind twice.
    const second = await blocks.expirySweep({ tenantId });
    assert.equal(second.reminded, 0);

    // Now let it expire.
    await UnitBlock.updateOne({ tenantId, _id: record._id }, { $set: { expiryAt: new Date(Date.now() - 1000) } });
    const expired = await blocks.expirySweep({ tenantId });
    assert.equal(expired.expired, 1);

    const unit = await Unit.findOne({ tenantId, _id: unit302._id }).lean();
    assert.equal(unit.status, 'AVAILABLE', 'the unit is back in inventory');
    assert.equal((await UnitBlock.findOne({ tenantId, _id: record._id }).lean()).status, 'EXPIRED');

    // §32.4.7: the lead stays active and still needs a next action.
    const lead = await Lead.findOne({ tenantId, _id: leadZ._id }).lean();
    assert.equal(lead.status, 'ACTIVE');
    assert.ok(await Activity.findOne({ tenantId, leadId: leadZ._id, type: 'BLOCK_EXPIRED' }));
  });

  let bookingId;

  await t.test('booking runs its side effects end to end (§33.4)', async () => {
    const sheet = await CostSheet.findOne({ tenantId, _id: sheetId }).lean();
    await rep.get(`/app/leads/${leadA._id}/bookings/new`);
    const res = await rep.submit(`/api/leads/${leadA._id}/bookings`, {
      unitId: String(unit101._id),
      costSheetId: String(sheet._id),
      bookingDate: tzLib.toDateInput(new Date(), 'Asia/Kolkata'),
      finalPrice: String(sheet.finalConsiderationMinor / 100),
      bookingAmount: '200000',
      paymentPlanId: String(plan._id),
      buyerPurpose: 'INVESTMENT',
      expectedExitDate: tzLib.toDateInput(new Date(Date.now() + 40 * 86400000), 'Asia/Kolkata'),
      expectedExitPrice: '8000000',
    }, `/app/leads/${leadA._id}/bookings/new`);
    assert.equal(res.status, 302, 'booking accepted');
    bookingId = res.location.split('?')[0].split('/').pop();

    const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.ok(booking, 'booking created');
    assert.equal(booking.sagaComplete, true);
    assert.equal(booking.buyerPurpose, 'INVESTMENT');

    assert.equal((await Unit.findOne({ tenantId, _id: unit101._id }).lean()).status, 'BOOKED');
    assert.equal((await UnitBlock.findOne({ tenantId, _id: blockId }).lean()).status, 'CONVERTED');

    const lead = await Lead.findOne({ tenantId, _id: leadA._id }).lean();
    assert.equal(lead.status, 'TERMINAL');
    assert.ok(lead.bookedAt);
    assert.equal(lead.nextActionAt, undefined, 'no future sales follow-up is required (§33.4)');
    assert.equal(await Followup.countDocuments({ tenantId, leadId: leadA._id, status: 'PENDING' }), 0);

    // §35: the investor booking creates the future resale opportunity.
    const opportunity = await ResaleOpportunity.findOne({ tenantId, bookingId: booking._id }).lean();
    assert.ok(opportunity, 'resale opportunity created');
    assert.equal(opportunity.expectedAskingPriceMinor, money.toMinor('8000000'));
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'BOOKING_COMPLETED' }));
    assert.ok(await Activity.findOne({ tenantId, leadId: leadA._id, type: 'RESALE_OPPORTUNITY_CREATED' }));

    // §119: attribution is frozen onto the booking.
    assert.ok(booking.originalSourceId);
  });

  await t.test('the same unit cannot be booked twice (§33.3)', async () => {
    const leadB = await makeLead('9900000003', 'Late Customer');
    const res = await rep.submit(`/api/leads/${leadB._id}/bookings`, {
      unitId: String(unit101._id),
      bookingDate: tzLib.toDateInput(new Date(), 'Asia/Kolkata'),
      finalPrice: '6000000',
      bookingAmount: '100000',
      paymentPlanId: String(plan._id),
      buyerPurpose: 'SELF_USE',
    }, `/app/leads/${leadB._id}`);
    assert.equal(res.status, 302);
    assert.equal(await Booking.countDocuments({ tenantId, unitId: unit101._id, status: 'BOOKED' }), 1);
  });

  await t.test('booking without a payment plan or buyer purpose is refused (§52.7)', async () => {
    const bookings = require('../../src/services/bookings');
    const unit201 = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '201' }).lean();
    const leadC = await makeLead('9900000004', 'Incomplete Customer');

    await assert.rejects(() => bookings.createBooking({
      tenantId, actor: seller, leadId: leadC._id, unitId: unit201._id,
      bookingDate: new Date(), finalPriceMinor: 100000, bookingAmountMinor: 1000,
      buyerPurpose: 'SELF_USE',
    }), /payment plan/i);

    await assert.rejects(() => bookings.createBooking({
      tenantId, actor: seller, leadId: leadC._id, unitId: unit201._id,
      bookingDate: new Date(), finalPriceMinor: 100000, bookingAmountMinor: 1000,
      paymentPlanId: plan._id,
    }), /buyer purpose/i);

    assert.equal((await Unit.findOne({ tenantId, _id: unit201._id }).lean()).status, 'AVAILABLE', 'a refused booking leaves inventory alone');
  });

  await t.test('a price that does not match an approved cost sheet is refused (§33.3)', async () => {
    const bookings = require('../../src/services/bookings');
    const unit201 = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '201' }).lean();
    const leadD = await makeLead('9900000005', 'Mismatch Customer');

    const costsheets = require('../../src/services/costsheets');
    const sheet = await costsheets.create({
      tenantId, actor: seller, leadId: leadD._id, unitId: unit201._id,
      discountMinor: money.toMinor('500000'), paymentPlanId: plan._id,
    });
    assert.equal(sheet.status, 'APPROVAL_PENDING');

    // Not approved yet → cannot book at all.
    await assert.rejects(() => bookings.createBooking({
      tenantId, actor: seller, leadId: leadD._id, unitId: unit201._id, costSheetId: sheet._id,
      bookingDate: new Date(), finalPriceMinor: sheet.finalConsiderationMinor,
      bookingAmountMinor: 100000, paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
    }), /discount approval/i);

    const approvals = require('../../src/services/approvals');
    const approval = await Approval.findOne({ tenantId, entityId: sheet._id, status: 'PENDING' }).lean();
    const managerUser = { ...manager.toObject(), role: { ...orgA.roles['Sales Manager'].toObject(), permissions: orgA.roles['Sales Manager'].permissions } };
    await approvals.decide({ tenantId, actor: managerUser, approvalId: approval._id, decision: 'APPROVE' });

    // Approved, but a different price is still refused.
    await assert.rejects(() => bookings.createBooking({
      tenantId, actor: seller, leadId: leadD._id, unitId: unit201._id, costSheetId: sheet._id,
      bookingDate: new Date(), finalPriceMinor: sheet.finalConsiderationMinor - 100000,
      bookingAmountMinor: 100000, paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
    }), /must match the approved cost sheet/i);

    assert.equal((await Unit.findOne({ tenantId, _id: unit201._id }).lean()).status, 'AVAILABLE');
  });

  await t.test('an interrupted booking saga is finished by the resume job (§87)', async () => {
    const bookings = require('../../src/services/bookings');
    const inventory = require('../../src/services/inventory');
    const unit102 = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '102' }).lean();
    const leadE = await makeLead('9900000006', 'Saga Customer');

    // Simulate a crash right after the unit claim and the booking insert.
    await inventory.claim({ tenantId, unitId: unit102._id, fromStatuses: ['AVAILABLE'], toStatus: 'BOOKED' });
    const partial = await Booking.create({
      tenantId,
      leadId: leadE._id,
      contactId: leadE.contactId,
      projectId: project._id,
      unitId: unit102._id,
      bookingDate: new Date(),
      finalPriceMinor: money.toMinor('6000000'),
      bookingAmountMinor: money.toMinor('100000'),
      paymentPlanId: plan._id,
      buyerPurpose: 'RENTAL_INCOME',
      rental: { expectedRentMinor: money.toMinor('35000'), expectedRentalStartDate: new Date(Date.now() + 60 * 86400000) },
      salespersonId: seller._id,
      sagaComplete: false,
    });

    const leadBefore = await Lead.findOne({ tenantId, _id: leadE._id }).lean();
    assert.equal(leadBefore.status, 'ACTIVE', 'side effects have not run yet');

    const result = await bookings.resumeIncomplete({ tenantId });
    assert.ok(result.resumed >= 1);

    const leadAfter = await Lead.findOne({ tenantId, _id: leadE._id }).lean();
    assert.equal(leadAfter.status, 'TERMINAL', 'the saga completed on resume');
    assert.equal((await Booking.findOne({ tenantId, _id: partial._id }).lean()).sagaComplete, true);
    assert.ok(await RentalOpportunity.findOne({ tenantId, bookingId: partial._id }), 'rental opportunity created');

    // Running resume again changes nothing.
    const again = await bookings.resumeIncomplete({ tenantId });
    assert.equal(again.resumed, 0);
    assert.equal(await RentalOpportunity.countDocuments({ tenantId, bookingId: partial._id }), 1);
  });

  await t.test('resale and rental reminders fire once per lead-time band (§35.1)', async () => {
    const opportunities = require('../../src/services/opportunities');
    const first = await opportunities.reminderSweep({ tenantId });
    assert.ok(first.resale + first.rental >= 1);
    const second = await opportunities.reminderSweep({ tenantId });
    assert.equal(second.resale + second.rental, 0, 'no duplicate reminder in the same band');
  });

  await t.test('the opportunity queues render with their management summary (§94)', async () => {
    const page = await admin.get('/app/opportunities/resale');
    assert.equal(page.status, 200);
    assert.match(page.text, /Resale opportunities/);
    assert.match(page.text, /Deal Customer/);

    const rentalPage = await admin.get('/app/opportunities/rental');
    assert.equal(rentalPage.status, 200);
    assert.match(rentalPage.text, /Saga Customer/);
  });

  await t.test('inventory counts reflect every state change', async () => {
    const projectsService = require('../../src/services/projects');
    const stats = await projectsService.inventoryStats({ tenantId, projectId: project._id });
    assert.equal(stats.total, 6);
    assert.equal(stats.booked, 2, '101 and 102');
    assert.equal(stats.blocked, 1, '202 from the race');
    assert.equal(stats.available, 3);
  });
});
