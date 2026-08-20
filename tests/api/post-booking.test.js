const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Booking, BookingInstallment, CollectionFollowUp, CollectionPromise, Activity, AuditLog,
  LeadSource, Project, Tower, UnitType, Unit, PricingComponent, PaymentPlan, Stage, ActionType,
} = require('../../src/db/models');

/**
 * V2 Phase 1 — post-booking foundation and the collections work queue.
 *
 * The invariants under test are the ones §324 calls non-negotiable: a booking is
 * never undone by post-booking setup, the schedule comes from the frozen plan,
 * collection ownership never touches sales credit, a tile count equals its
 * drilldown, and outstanding money always leaves a next action behind.
 */
test('post-booking, payment schedule and collections (V2 §108–§161)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Book Rep', email: 'rep@alpha.test', roleName: 'Sales User',
  });
  const collector = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Collect Exec', email: 'coll@alpha.test',
    roleName: 'Collection Executive',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

  const project = await Project.create({
    tenantId, name: 'Collect Heights', status: 'ACTIVE', city: 'Pune', code: 'CH', developerName: 'Collect Estates',
  });
  const tower = await Tower.create({ tenantId, projectId: project._id, name: 'Tower A', code: 'A' });
  const unitType = await UnitType.create({
    tenantId, projectId: project._id, name: '3 BHK', superBuiltUpArea: 1000, defaultBaseRateMinor: 1000000,
  });
  const unit = await Unit.create({
    tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
    unitNumber: 'A-804', floorNumber: 8, saleableArea: 1000, status: 'AVAILABLE',
  });
  await PricingComponent.create({
    tenantId, projectId: project._id, name: 'Base price', kind: 'BASE',
    calcType: 'PER_AREA', rateMinor: 1000000, areaBasis: 'SALEABLE', displayOrder: 1,
  });
  /**
   * Percentages chosen so the rounding remainder is real: 33.33 × 3 of a
   * ₹1,00,00,000 consideration does not divide evenly.
   */
  const plan = await PaymentPlan.create({
    tenantId,
    projectId: project._id,
    name: 'Construction linked',
    type: 'CONSTRUCTION_LINKED',
    active: true,
    milestones: [
      { sequence: 1, label: 'On booking', percentage: 10, dueRule: 'ON_BOOKING', displayOrder: 1 },
      { sequence: 2, label: 'Within 30 days', percentage: 33.33, dueRule: 'DAYS_AFTER_BOOKING', dueOffsetDays: 30, displayOrder: 2 },
      { sequence: 3, label: 'Plinth', percentage: 33.33, dueRule: 'CONSTRUCTION', displayOrder: 3 },
      { sequence: 4, label: 'Possession', percentage: 23.34, dueRule: 'ON_POSSESSION', displayOrder: 4 },
    ],
  });

  const admin = h.client();
  await admin.login('admin@alpha.test');
  const rep = h.client();
  await rep.login('rep@alpha.test');
  const exec = h.client();
  await exec.login('coll@alpha.test');

  const created = await admin.submit('/api/leads', {
    firstName: 'Rahul', lastName: 'Shah', primaryMobile: '9330000501',
    sourceId: String(source._id), projectId: String(project._id),
    assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
  }, '/app/leads/new');
  const leadId = created.location.split('?')[0].split('/').pop();

  const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await rep.submit(`/api/leads/${leadId}/log-action`, {
    actionTypeId: String(actions.CALL._id),
    stageId: String(stages.CONNECTED._id),
    nextActionTypeId: String(actions.SITE_VISIT._id), nextDate: soon, nextTime: '11:00',
  }, `/app/leads/${leadId}`);

  // Quotation → booking, through the real services so the snapshot chain is real.
  const costsheets = require('../../src/services/costsheets');
  const bookingsService = require('../../src/services/bookings');
  const sheet = await costsheets.create({
    tenantId, actor: seller, leadId, unitId: unit._id, paymentPlanId: plan._id,
  });
  const booking = await bookingsService.createBooking({
    tenantId,
    tenant: orgA.tenant,
    actor: seller,
    leadId,
    unitId: unit._id,
    costSheetId: sheet._id,
    bookingDate: new Date(),
    finalPriceMinor: sheet.finalConsiderationMinor,
    bookingAmountMinor: 100000000,
    paymentPlanId: plan._id,
    buyerPurpose: 'SELF_USE',
  });

  t.after(async () => { await h.stopServer(); });

  /**
   * A browser form post bounces validation failures back to the page with a
   * flash (see middleware/errors), which hides the status code. These
   * assertions are about the rule, not the redirect, so they post as JSON —
   * the same route, the same guards, a readable status.
   */
  const failing = async (client, path, body, page = '/app/collections') => {
    const token = await client.csrf(page);
    return client.postJson(path, { _csrf: token, ...body });
  };

  /* --------------------------- §108 / §266 init --------------------------- */

  await t.test('booking initializes its post-booking data (§266)', async () => {
    const fresh = await Booking.findOne({ tenantId, _id: booking._id }).lean();
    assert.ok(fresh.postBookingInitAt, 'the initialization marker is set');
    assert.match(fresh.bookingNumber, /^BKG-CH-\d{4}-00001$/, 'a number a human can read out');
    assert.equal(fresh.paymentPlanName, 'Construction linked');
    assert.equal(fresh.paymentPlanRows.length, 4, 'the plan is frozen onto the booking');
    assert.ok(fresh.collectionOwnerUserId, 'a collection owner was resolved');
    assert.equal(fresh.kycStatus, 'NOT_STARTED');
    assert.equal(fresh.postBookingStatus, 'KYC_PENDING');

    const events = await Activity.find({ tenantId, bookingId: booking._id }).lean();
    const types = events.map((e) => e.type);
    assert.ok(types.includes('POST_BOOKING_INITIALIZED'));
    assert.ok(types.includes('SCHEDULE_GENERATED'));
    assert.ok(types.includes('COLLECTION_ASSIGNED'));
    // §189: the post-booking story does not leak into the lead's timeline.
    const onLead = await Activity.countDocuments({ tenantId, leadId, type: 'SCHEDULE_GENERATED' });
    assert.equal(onLead, 0);
  });

  await t.test('the schedule sums to the booking value exactly (§267)', async () => {
    const rows = await BookingInstallment.find({ tenantId, bookingId: booking._id }).sort({ sequence: 1 }).lean();
    assert.equal(rows.length, 4);
    const total = rows.reduce((sum, r) => sum + r.scheduledAmountMinor, 0);
    assert.equal(total, booking.finalPriceMinor, 'the remainder lands on the final installment');

    const fresh = await Booking.findOne({ tenantId, _id: booking._id }).lean();
    assert.equal(fresh.scheduledTotalMinor, booking.finalPriceMinor);
    assert.equal(fresh.outstandingMinor, booking.finalPriceMinor);
    assert.equal(fresh.totalReceivedMinor, 0);
    assert.equal(fresh.paymentProgressPct, 0);
  });

  await t.test('due dates resolve per rule, and TBD is never invented (§135)', async () => {
    const rows = await BookingInstallment.find({ tenantId, bookingId: booking._id }).sort({ sequence: 1 }).lean();
    assert.equal(rows[0].dueRule, 'BOOKING_DATE');
    assert.ok(rows[0].expectedDueDate, 'booking-date milestones have a date');
    assert.equal(rows[0].status, 'DUE', 'and are due immediately');

    assert.equal(rows[1].dueRule, 'DAYS_AFTER_BOOKING');
    const gapDays = Math.round((rows[1].expectedDueDate - rows[0].expectedDueDate) / 86400000);
    assert.equal(gapDays, 30);
    assert.equal(rows[1].status, 'UPCOMING');

    assert.equal(rows[2].dueRule, 'EXPECTED_MILESTONE_DATE');
    assert.equal(rows[2].expectedDueDate, null, 'a construction milestone with no date stays TBD');
    assert.equal(rows[3].dueRule, 'POSSESSION_DATE');
    assert.equal(rows[3].expectedDueDate, null, 'the project has no possession date, so neither does this');

    // §136: a TBD installment is never overdue.
    const installments = require('../../src/services/installments');
    assert.equal(installments.isOverdue(rows[2], { tz: 'Asia/Kolkata' }), false);
  });

  await t.test('initialization is idempotent (§108)', async () => {
    const postBooking = require('../../src/services/postBooking');
    await postBooking.initialize({ tenantId, bookingId: booking._id });
    await postBooking.initialize({ tenantId, bookingId: booking._id, force: true });
    assert.equal(await BookingInstallment.countDocuments({ tenantId, bookingId: booking._id }), 4);
    const numbers = await Booking.findOne({ tenantId, _id: booking._id }).select('bookingNumber').lean();
    assert.match(numbers.bookingNumber, /00001$/, 'and does not burn a new number each run');
  });

  await t.test('a later payment plan edit cannot move an existing schedule (§344.7)', async () => {
    await PaymentPlan.updateOne({ tenantId, _id: plan._id }, {
      $set: { milestones: [{ sequence: 1, label: 'Everything now', percentage: 100, dueRule: 'ON_BOOKING' }] },
    });
    const rows = await BookingInstallment.find({ tenantId, bookingId: booking._id }).lean();
    assert.equal(rows.length, 4, 'the customer’s schedule is unchanged');
  });

  /* ---------------------------- §109–§113 screens ------------------------- */

  await t.test('the booking list and workspace show the money (§110, §113)', async () => {
    const list = await admin.get('/app/bookings');
    assert.equal(list.status, 200);
    assert.match(list.text, /BKG-CH-/);
    assert.match(list.text, /Rahul Shah/);
    assert.match(list.text, /A-804/);

    const page = await admin.get(`/app/bookings/${booking._id}?tab=collections`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Payment schedule/);
    assert.match(page.text, /On booking/);
    assert.match(page.text, /Within 30 days/);
    assert.match(page.text, /TBD/, 'an unknown construction date says so');
    assert.match(page.text, /Construction linked/);
  });

  await t.test('booking commercials are read-only after the sale (§199)', async () => {
    const page = await admin.get(`/app/bookings/${booking._id}`);
    assert.match(page.text, /Read-only once booked/);
    assert.doesNotMatch(page.text, /name="finalPrice/, 'no form can retype the price');
  });

  /* --------------------------- §150 / §279 queue -------------------------- */

  await t.test('collection tiles and their drilldown agree (§279)', async () => {
    const queue = await admin.get('/app/collections');
    assert.equal(queue.status, 200);
    const counts = h.tileCounts(queue.text);
    assert.equal(counts['Due today'], 1, 'the booking-date installment is due today');
    assert.equal(counts.Overdue, 0);
    assert.equal(counts['All my bookings'], 1);

    const dueToday = await admin.get('/app/collections?tab=due-today');
    assert.match(dueToday.text, /Rahul Shah/);
    assert.match(dueToday.text, /1 booking/);

    const overdue = await admin.get('/app/collections?tab=overdue');
    assert.match(overdue.text, /No overdue collections/);
  });

  await t.test('a booking with no next action says so (§157)', async () => {
    const queue = await admin.get('/app/collections?tab=all');
    assert.match(queue.text, /No next action/);
  });

  /* ---------------------------- §154–§161 work ---------------------------- */

  let followUpId;

  await t.test('collection follow-up can be scheduled against an installment (§154)', async () => {
    const rows = await BookingInstallment.find({ tenantId, bookingId: booking._id }).sort({ sequence: 1 }).lean();
    const res = await admin.submit(`/api/bookings/${booking._id}/collection-followups`, {
      actionType: 'CALL', installmentId: String(rows[0]._id), date: soon, time: '16:30',
      note: 'Chase the booking amount.',
    }, `/app/bookings/${booking._id}`);
    assert.equal(res.status, 302);

    const followup = await CollectionFollowUp.findOne({ tenantId, bookingId: booking._id }).lean();
    assert.ok(followup);
    assert.equal(followup.status, 'PENDING');
    followUpId = followup._id;
  });

  await t.test('closing a follow-up while money is owed demands the next one (§157)', async () => {
    const res = await failing(admin, `/api/collection-followups/${followUpId}/complete`, {
      outcome: 'NO_ANSWER', note: 'Rang out.',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /Set the next collection action/);
    const followup = await CollectionFollowUp.findOne({ tenantId, _id: followUpId }).lean();
    assert.equal(followup.status, 'PENDING', 'and the current one stays open');
  });

  await t.test('a promise to pay needs an amount and a date, and is capped (§158)', async () => {
    const missing = await failing(admin, `/api/collection-followups/${followUpId}/complete`, {
      outcome: 'PROMISE_TO_PAY', nextActionType: 'CALL', nextDate: soon, nextTime: '11:00',
    });
    assert.equal(missing.status, 400);
    assert.match(missing.data.error.message, /amount the customer promised/);

    const tooMuch = await failing(admin, `/api/collection-followups/${followUpId}/complete`, {
      outcome: 'PROMISE_TO_PAY', promisedAmount: '99999999', promisedDate: soon,
      nextActionType: 'CALL', nextDate: soon, nextTime: '11:00',
    });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.data.error.message, /higher than the outstanding/);
  });

  await t.test('the drawer saves outcome, promise and next action in one go (§161)', async () => {
    const res = await admin.submit(`/api/collection-followups/${followUpId}/complete`, {
      outcome: 'PROMISE_TO_PAY', note: 'Will transfer on Friday.',
      promisedAmount: '500000', promisedDate: soon,
      nextActionType: 'WHATSAPP', nextDate: soon, nextTime: '17:00', nextNote: 'Send the reminder.',
    }, '/app/collections');
    assert.equal(res.status, 302);

    const closed = await CollectionFollowUp.findOne({ tenantId, _id: followUpId }).lean();
    assert.equal(closed.status, 'COMPLETED');
    assert.equal(closed.outcome, 'PROMISE_TO_PAY');
    assert.ok(closed.nextFollowUpId, 'the next action exists');
    assert.ok(closed.promiseId, 'and so does the promise');

    const promise = await CollectionPromise.findOne({ tenantId, _id: closed.promiseId }).lean();
    assert.equal(promise.promisedAmountMinor, 50000000);
    assert.equal(promise.status, 'OPEN');
    assert.equal(promise.baselineReceivedMinor, 0, 'fulfilment is measured from here');

    const next = await CollectionFollowUp.findOne({ tenantId, _id: closed.nextFollowUpId }).lean();
    assert.equal(next.actionType, 'WHATSAPP');
    assert.equal(next.status, 'PENDING');
  });

  await t.test('an open promise shows on the queue and in its own tile (§151)', async () => {
    const queue = await admin.get('/app/collections?tab=ptp-today');
    // The promise is dated tomorrow, so today's tile is empty — and says why.
    assert.match(queue.text, /No promises due today/);
    const all = await admin.get('/app/collections?tab=all');
    assert.match(all.text, /Promised/);
  });

  await t.test('an unkept promise becomes MISSED after its date (§160)', async () => {
    const promise = await CollectionPromise.findOne({ tenantId, status: 'OPEN' }).lean();
    await CollectionPromise.updateOne({ tenantId, _id: promise._id }, {
      $set: { promisedDate: new Date(Date.now() - 86400000) },
    });
    const result = await require('../../src/services/collectionFollowups').promiseSweep({ tenantId });
    assert.equal(result.missed, 1);
    const after = await CollectionPromise.findOne({ tenantId, _id: promise._id }).lean();
    assert.equal(after.status, 'MISSED');
    assert.equal(after.fulfilledAmountMinor, 0);

    const events = await Activity.find({ tenantId, bookingId: booking._id, type: 'PROMISE_MISSED' }).lean();
    assert.equal(events.length, 1);
  });

  await t.test('a pending follow-up whose time passed becomes MISSED (§188)', async () => {
    const pending = await CollectionFollowUp.findOne({ tenantId, status: 'PENDING' }).lean();
    await CollectionFollowUp.updateOne({ tenantId, _id: pending._id }, {
      $set: { dueAt: new Date(Date.now() - 3600000) },
    });
    const result = await require('../../src/services/collectionFollowups').markMissed({ tenantId });
    assert.equal(result.missed, 1);

    const queue = await admin.get('/app/collections?tab=missed-followup');
    assert.match(queue.text, /Rahul Shah/);
    const counts = h.tileCounts(queue.text);
    assert.equal(counts['Missed follow-ups'], 1);
  });

  /* ------------------------- §183 / §220 ownership ------------------------ */

  await t.test('transferring collection never touches sales credit (§183, §220)', async () => {
    const before = await Booking.findOne({ tenantId, _id: booking._id }).lean();
    const res = await admin.submit(`/api/bookings/${booking._id}/collection-owner`, {
      newOwnerUserId: String(collector._id), reason: 'Handing to collections desk', includePending: '1',
    }, `/app/bookings/${booking._id}`);
    assert.equal(res.status, 302);

    const after = await Booking.findOne({ tenantId, _id: booking._id }).lean();
    assert.equal(String(after.collectionOwnerUserId), String(collector._id));
    assert.equal(String(after.salespersonId), String(before.salespersonId), 'the salesperson is untouched');

    const moved = await CollectionFollowUp.find({
      tenantId, bookingId: booking._id, status: { $in: ['PENDING', 'MISSED'] },
    }).lean();
    assert.ok(moved.length, 'there is open work');
    assert.ok(moved.every((f) => String(f.assignedUserId) === String(collector._id)), 'and it moved too');

    const logged = await AuditLog.findOne({ tenantId, entity: 'Booking', action: 'TRANSFER_COLLECTION' }).lean();
    assert.ok(logged, 'the transfer is audited (§198)');
  });

  await t.test('the new owner sees it in their own queue, the old one does not', async () => {
    const mine = await exec.get('/app/collections?tab=all');
    assert.equal(mine.status, 200);
    assert.match(mine.text, /Rahul Shah/);

    const sellerClient = h.client();
    await sellerClient.login('rep@alpha.test');
    const theirs = await sellerClient.get('/app/collections?tab=all');
    assert.doesNotMatch(theirs.text, /Rahul Shah/, 'a sales user only sees what they collect');
  });

  await t.test('collection transfer needs permission (§180)', async () => {
    const res = await failing(exec, `/api/bookings/${booking._id}/collection-owner`, {
      newOwnerUserId: String(seller._id), reason: 'Nope',
    }, `/app/bookings/${booking._id}`);
    assert.equal(res.status, 403);
  });

  await t.test('collection cannot be handed to someone who cannot collect (§149)', async () => {
    const marketer = await h.addUser({
      tenant: orgA.tenant, roles: orgA.roles, name: 'Marketer', email: 'mkt@alpha.test', roleName: 'Marketing User',
    });
    const res = await failing(admin, `/api/bookings/${booking._id}/collection-owner`, {
      newOwnerUserId: String(marketer._id), reason: 'Wrong desk',
    }, `/app/bookings/${booking._id}`);
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /does not have collection permission/);
  });

  /* ------------------------------ §268 due date --------------------------- */

  await t.test('a due date can be fixed, with a reason and an audit trail (§268)', async () => {
    const tbd = await BookingInstallment.findOne({ tenantId, bookingId: booking._id, sequence: 3 }).lean();
    assert.equal(tbd.expectedDueDate, null);

    const noReason = await failing(
      admin,
      `/api/bookings/${booking._id}/installments/${tbd._id}/due-date`,
      { actualDueDate: soon },
      `/app/bookings/${booking._id}`,
    );
    assert.equal(noReason.status, 422, 'a due date change without a reason is refused');

    const res = await admin.submit(
      `/api/bookings/${booking._id}/installments/${tbd._id}/due-date`,
      { actualDueDate: soon, reason: 'Plinth completed, milestone now dated' },
      `/app/bookings/${booking._id}`,
    );
    assert.equal(res.status, 302);

    const after = await BookingInstallment.findOne({ tenantId, _id: tbd._id }).lean();
    assert.ok(after.actualDueDate, 'the real date is stored separately from the expected one');
    assert.equal(after.expectedDueDate, null, 'and the original expectation is not overwritten');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'BookingInstallment' }).lean());

    const event = await Activity.findOne({
      tenantId, bookingId: booking._id, type: 'INSTALLMENT_DUE_DATE_CHANGED',
    }).lean();
    assert.ok(event);
  });

  await t.test('amounts have no edit path at all (§200)', async () => {
    const page = await admin.get(`/app/bookings/${booking._id}?tab=collections`);
    assert.doesNotMatch(page.text, /name="scheduledAmount/);
    assert.match(page.text, /Amounts and percentages are fixed/);
  });

  /* ---------------------------- overdue + isolation ----------------------- */

  await t.test('the overdue sweep flags a passed due date (§188)', async () => {
    const first = await BookingInstallment.findOne({ tenantId, bookingId: booking._id, sequence: 1 }).lean();
    await BookingInstallment.updateOne({ tenantId, _id: first._id }, {
      $set: { expectedDueDate: new Date(Date.now() - 5 * 86400000) },
    });
    await require('../../src/services/collections').overdueRefresh({ tenantId });

    const after = await Booking.findOne({ tenantId, _id: booking._id }).lean();
    assert.ok(after.overdueMinor > 0, 'the booking now carries an overdue amount');
    assert.ok(after.overdueDaysMax >= 4);

    const queue = await exec.get('/app/collections?tab=overdue');
    const counts = h.tileCounts(queue.text);
    assert.equal(counts.Overdue, 1);
    assert.match(queue.text, /days overdue/);
  });

  await t.test('another tenant cannot see or touch this booking (§2.3)', async () => {
    const other = h.client();
    await other.login('admin@beta.test');
    const page = await other.get(`/app/bookings/${booking._id}`);
    assert.equal(page.status, 404);

    const res = await failing(other, `/api/bookings/${booking._id}/collection-owner`, {
      newOwnerUserId: String(orgB.admin._id), reason: 'Cross tenant',
    }, '/app/dashboard');
    assert.ok([403, 404].includes(res.status), `cross-tenant write refused (got ${res.status})`);
    const unchanged = await Booking.findOne({ tenantId, _id: booking._id }).lean();
    assert.equal(String(unchanged.collectionOwnerUserId), String(collector._id));
  });
});
