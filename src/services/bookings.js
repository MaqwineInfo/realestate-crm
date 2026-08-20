const {
  Booking, Unit, Lead, UnitBlock, CostSheet, PaymentPlan, Followup, Contact,
} = require('../db/models');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const inventory = require('./inventory');
const costsheets = require('./costsheets');
const leadsService = require('./leads');
const stagesService = require('./stages');
const timeline = require('./timeline');
const audit = require('./audit');
const opportunities = require('./opportunities');

/**
 * Spec §33 + §87: booking is the highest-impact write in the product.
 *
 * With no transactions available on a standalone mongod, this runs as an
 * ordered saga whose FIRST step is the atomic claim on the unit. Everything
 * after that is idempotent and keyed by the booking id, so `resume()` can
 * finish a run that died half way — and two simultaneous bookings on one unit
 * still produce exactly one booking.
 */

async function createBooking({
  tenantId, tenant, actor, leadId, unitId, costSheetId, bookingDate, finalPriceMinor,
  bookingAmountMinor, discountMinor = 0, paymentPlanId, buyerPurpose, investment, rental, notes,
}) {
  /* ---- 1. Validate everything before a single write (§33.3) ---- */
  const [lead, unit] = await Promise.all([
    Lead.findOne({ tenantId, _id: leadId }).lean(),
    Unit.findOne({ tenantId, _id: unitId }).lean(),
  ]);
  if (!lead) throw notFound('Lead not found.');
  if (!unit) throw notFound('Unit not found.');
  if (!bookingDate) throw badRequest('Booking date cannot be blank.');
  if (!buyerPurpose) throw badRequest('Buyer purpose is required.');
  if (!paymentPlanId) throw badRequest('Select a payment plan.');
  if (!(finalPriceMinor > 0)) throw badRequest('Enter the final booking price.');
  if (bookingAmountMinor < 0) throw badRequest('Booking amount cannot be negative.');

  const plan = await PaymentPlan.findOne({ tenantId, _id: paymentPlanId, projectId: unit.projectId }).lean();
  if (!plan) throw badRequest('Choose a payment plan that belongs to this project.');

  const existingBooking = await Booking.findOne({ tenantId, unitId, status: { $ne: 'CANCELLED' } }).lean();
  if (existingBooking) throw conflict('This unit is already booked.');

  // §33.3: the price must match an approved cost sheet where approval was needed.
  let costSheet = null;
  if (costSheetId) {
    costSheet = await CostSheet.findOne({ tenantId, _id: costSheetId, leadId }).lean();
    if (!costSheet) throw badRequest('That cost sheet does not belong to this lead.');
    if (String(costSheet.unitId) !== String(unitId)) throw badRequest('That cost sheet is for a different unit.');
    costsheets.assertBookable(costSheet);
    if (costSheet.approvalRequired && finalPriceMinor !== costSheet.finalConsiderationMinor) {
      throw badRequest('The final price must match the approved cost sheet.');
    }
  }

  // §33.3 + §102: an active block must belong to this lead, or be overridden.
  const activeBlock = await UnitBlock.findOne({ tenantId, unitId, status: 'ACTIVE' }).lean();
  if (activeBlock && String(activeBlock.leadId) !== String(leadId)) {
    throw conflict('This unit is blocked for another customer.');
  }
  if (unit.status === 'BLOCKED' && !activeBlock) {
    throw conflict('This unit is blocked. Refresh and try again.');
  }
  // §53 has no HOLD → BOOKED edge: an internal hold is resolved first, so a
  // held unit can never be sold out from under whoever placed the hold.
  if (unit.status === 'HOLD') {
    throw badRequest('This unit is on hold. Release the hold or block it for this customer before booking.');
  }

  /* ---- 2. Claim the unit. The contended resource is decided here. ---- */
  const claimed = await inventory.claim({
    tenantId,
    unitId,
    fromStatuses: activeBlock ? ['BLOCKED'] : ['AVAILABLE'],
    toStatus: 'BOOKED',
    set: { heldForLeadId: leadId },
  });
  if (!claimed) {
    throw conflict('This unit was just taken by another booking. Refresh inventory and try again.');
  }

  /* ---- 3. The booking record itself ---- */
  let booking;
  try {
    booking = await Booking.create({
      tenantId,
      leadId,
      contactId: lead.contactId,
      projectId: unit.projectId,
      unitId,
      blockId: activeBlock?._id,
      costSheetId: costSheet?._id,
      bookingDate: new Date(bookingDate),
      finalPriceMinor,
      bookingAmountMinor,
      discountMinor: costSheet?.discountMinor ?? discountMinor,
      paymentPlanId,
      buyerPurpose,
      investment: buyerPurpose === 'INVESTMENT' ? investment : undefined,
      rental: buyerPurpose === 'RENTAL_INCOME' ? rental : undefined,
      salespersonId: lead.ownerUserId || actor._id,
      /**
       * V2 §39/§324.9: the channel-partner attribution is frozen here too. A
       * later edit to the partner master cannot rewrite the commercial history
       * of a sale, and the salesperson still owns the sale (§184).
       */
      channelPartnerId: lead.partnerAttributionStatus === 'ACCEPTED' ? lead.channelPartnerId : null,
      channelPartnerMemberId: lead.partnerAttributionStatus === 'ACCEPTED' ? lead.channelPartnerMemberId : null,
      partnerLeadClaimId: lead.partnerAttributionStatus === 'ACCEPTED' ? lead.partnerLeadClaimId : null,
      // §119: freeze attribution at the moment of sale.
      sourceId: lead.latestSourceId,
      originalSourceId: lead.originalSourceId,
      campaignId: lead.campaignId,
      firstTouchCampaignId: lead.firstTouchCampaignId,
      lastTouchCampaignId: lead.lastTouchCampaignId,
      notes,
      createdBy: actor._id,
    });
  } catch (err) {
    // Nothing else was written yet, so handing the unit back is safe and complete.
    await inventory.releaseClaim({
      tenantId, unitId, expectedStatus: 'BOOKED', toStatus: activeBlock ? 'BLOCKED' : 'AVAILABLE',
    });
    if (err.code === 11000) throw conflict('This unit is already booked.');
    throw err;
  }

  /* ---- 4..n. Idempotent tail, resumable if this process dies ---- */
  await completeSaga({ tenantId, tenant, actor, bookingId: booking._id });
  return Booking.findOne({ tenantId, _id: booking._id }).lean();
}

/**
 * §33.4 side effects. Every step is safe to repeat, so `resume()` can call this
 * again after a crash without doubling anything up.
 */
async function completeSaga({ tenantId, tenant = null, actor, bookingId }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking || booking.sagaComplete) return booking;

  const [unit, lead] = await Promise.all([
    Unit.findOne({ tenantId, _id: booking.unitId }).lean(),
    Lead.findOne({ tenantId, _id: booking.leadId }).lean(),
  ]);

  await Unit.updateOne({ tenantId, _id: booking.unitId }, {
    $set: { currentBookingId: booking._id }, $unset: { currentBlockId: '' },
  });

  if (booking.blockId) {
    await UnitBlock.updateOne(
      { tenantId, _id: booking.blockId, status: 'ACTIVE' },
      { $set: { status: 'CONVERTED', releasedAt: new Date() } },
    );
  }

  // Lead becomes terminal through the booking action, never a dropdown (§83).
  const bookedStage = await stagesService.bySemantic({ tenantId, semanticType: 'BOOKED' });
  if (bookedStage && lead && String(lead.stageId) !== String(bookedStage._id)) {
    await leadsService.changeStage({
      tenantId, actor, leadId: booking.leadId, stageId: bookedStage._id, viaAction: true,
      sourceAction: 'BOOKING', note: `Unit ${unit?.unitNumber} booked`,
    });
  }
  await Lead.updateOne({ tenantId, _id: booking.leadId }, {
    $set: { bookedAt: booking.bookingDate, bookingId: booking._id, status: 'TERMINAL' },
    $unset: { activeBlockId: '', nextFollowupId: '', nextActionAt: '', nextActionTypeId: '' },
  });

  // §33.4: no future sales follow-up is required once the deal is done.
  await Followup.updateMany(
    { tenantId, leadId: booking.leadId, status: { $in: ['PENDING', 'MISSED'] } },
    { $set: { status: 'CANCELLED', cancelledReason: 'Lead booked' } },
  );

  await timeline.log({
    tenantId,
    leadId: booking.leadId,
    contactId: booking.contactId,
    type: 'BOOKING_COMPLETED',
    title: `Unit ${unit?.unitNumber} booked`,
    actor,
    at: booking.bookingDate,
    meta: {
      bookingId: String(booking._id),
      unitId: String(booking.unitId),
      finalPriceMinor: booking.finalPriceMinor,
      buyerPurpose: booking.buyerPurpose,
    },
  });

  // §35/§36: today's booking is tomorrow's resale or rental opportunity.
  await opportunities.createFromBooking({ tenantId, booking, actor });

  await Booking.updateOne({ tenantId, _id: booking._id }, { $set: { sagaComplete: true } });

  /**
   * V2 §108 / §324.1: post-booking setup runs here, inline, so a booking is
   * immediately collectable — but inside its own try/catch, because a valid
   * booking is never undone or blocked by post-booking failure. Anything that
   * fails here is picked up by the `booking.post_initialize` job.
   *
   * Deliberately a direct call rather than an event listener: the schedule must
   * exist by the time this function returns, and an event is fire-and-forget.
   */
  try {
    // Required lazily: post-booking reads bookings, so the import is circular.
    await require('./postBooking').initialize({
      tenantId, bookingId: booking._id, actor, tz: tenant?.timezone || 'UTC',
    });
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', scope: 'post-booking-init', bookingId: String(booking._id), message: err.message,
    }));
  }

  emit(EVENTS.BOOKING_CREATED, { tenantId, bookingId: booking._id, leadId: booking.leadId });
  emit(EVENTS.UNIT_BOOKED, { tenantId, unitId: booking.unitId, bookingId: booking._id });
  await audit.record({
    tenantId, actor, entity: 'Booking', entityId: booking._id, action: 'CREATE',
    after: { unitId: booking.unitId, finalPriceMinor: booking.finalPriceMinor, buyerPurpose: booking.buyerPurpose },
  });
  return Booking.findOne({ tenantId, _id: booking._id }).lean();
}

/**
 * §87/§98 recovery: finish any booking whose side effects did not complete.
 * Runs from the scheduler, so a process death mid-saga self-heals.
 */
async function resumeIncomplete({ tenantId = null, limit = 20 } = {}) {
  const filter = { sagaComplete: false, status: 'BOOKED' };
  if (tenantId) filter.tenantId = tenantId;
  const stuck = await Booking.find(filter).setOptions({ allowCrossTenant: !tenantId }).limit(limit).lean();
  for (const booking of stuck) {
    await completeSaga({ tenantId: booking.tenantId, actor: null, bookingId: booking._id });
  }
  return { resumed: stuck.length };
}

const forLead = ({ tenantId, leadId }) => Booking.find({ tenantId, leadId })
  .populate('unitId', 'unitNumber')
  .populate('paymentPlanId', 'name')
  .lean();

async function get({ tenantId, bookingId }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId })
    .populate('unitId')
    .populate('projectId', 'name')
    .populate('contactId', 'displayName primaryMobile email')
    .populate('salespersonId', 'name')
    .populate('paymentPlanId')
    .lean();
  if (!booking) throw notFound('Booking not found.');
  return booking;
}

module.exports = { createBooking, completeSaga, resumeIncomplete, forLead, get };
