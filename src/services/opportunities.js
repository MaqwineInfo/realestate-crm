const { ResaleOpportunity, RentalOpportunity, AssignmentPool, User } = require('../db/models');
const { notFound, badRequest } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const tz = require('../lib/tz');
const notifications = require('./notifications');
const timeline = require('./timeline');

/**
 * Spec §35 + §36: an investor booking becomes a future resale opportunity, a
 * rental-income booking becomes a rental one. Deliberately a light queue with a
 * next action — not a second pipeline (§35.3).
 */

/** Reminder lead times from §35.1. */
const LEAD_TIME_DAYS = [90, 60, 30];

async function createFromBooking({ tenantId, booking, actor }) {
  if (booking.buyerPurpose === 'INVESTMENT') {
    const existing = await ResaleOpportunity.findOne({ tenantId, bookingId: booking._id }).lean();
    if (existing) return existing;

    const opportunity = await ResaleOpportunity.create({
      tenantId,
      bookingId: booking._id,
      contactId: booking.contactId,
      unitId: booking.unitId,
      projectId: booking.projectId,
      expectedAvailableDate: booking.investment?.expectedExitDate,
      expectedAskingPriceMinor: booking.investment?.expectedExitPriceMinor,
      expectedRoiPercentage: booking.investment?.expectedRoiPercentage,
      assignedUserId: await resaleOwner({ tenantId, booking }),
      notes: booking.investment?.notes,
    });
    await timeline.log({
      tenantId, leadId: booking.leadId, contactId: booking.contactId, type: 'RESALE_OPPORTUNITY_CREATED',
      title: 'Resale opportunity created from this booking', actor, actorType: actor ? 'USER' : 'SYSTEM',
      meta: { opportunityId: String(opportunity._id), expectedAvailableDate: opportunity.expectedAvailableDate },
    });
    return opportunity;
  }

  if (booking.buyerPurpose === 'RENTAL_INCOME') {
    const existing = await RentalOpportunity.findOne({ tenantId, bookingId: booking._id }).lean();
    if (existing) return existing;

    const opportunity = await RentalOpportunity.create({
      tenantId,
      bookingId: booking._id,
      contactId: booking.contactId,
      unitId: booking.unitId,
      projectId: booking.projectId,
      expectedAvailableDate: booking.rental?.expectedRentalStartDate,
      expectedRentMinor: booking.rental?.expectedRentMinor,
      furnishing: booking.rental?.furnishing,
      assignedUserId: await resaleOwner({ tenantId, booking, poolName: 'Rental team' }),
      notes: booking.rental?.notes,
    });
    await timeline.log({
      tenantId, leadId: booking.leadId, contactId: booking.contactId, type: 'RENTAL_OPPORTUNITY_CREATED',
      title: 'Rental opportunity created from this booking', actor, actorType: actor ? 'USER' : 'SYSTEM',
      meta: { opportunityId: String(opportunity._id), expectedAvailableDate: opportunity.expectedAvailableDate },
    });
    return opportunity;
  }
  return null;
}

/**
 * §35.3: a dedicated resale/rental team if one is configured as an assignment
 * pool, otherwise the salesperson who knows the customer.
 */
async function resaleOwner({ tenantId, booking, poolName = 'Resale team' }) {
  const pool = await AssignmentPool.findOne({ tenantId, name: poolName, active: true }).lean();
  if (pool?.memberIds?.length) {
    const active = await User.find({ tenantId, _id: { $in: pool.memberIds }, status: 'ACTIVE' }).select('_id').lean();
    if (active.length) return active[0]._id;
  }
  return booking.salespersonId;
}

/**
 * §35.1: surface upcoming exits at 90/60/30 days. Each opportunity is reminded
 * once per lead-time band, so the job is safe to re-run (§106).
 */
async function reminderSweep({ tenantId = null, now = new Date() } = {}) {
  const scope = tenantId ? { tenantId } : {};
  const result = { resale: 0, rental: 0 };

  for (const [Model, key, type, label] of [
    [ResaleOpportunity, 'resale', EVENTS.RESALE_OPPORTUNITY_DUE, 'Resale'],
    [RentalOpportunity, 'rental', EVENTS.RENTAL_OPPORTUNITY_DUE, 'Rental'],
  ]) {
    const horizon = new Date(now.getTime() + LEAD_TIME_DAYS[0] * 86400000);
    const due = await Model.find({
      ...scope,
      status: { $in: ['UPCOMING', 'IN_DISCUSSION'] },
      expectedAvailableDate: { $ne: null, $lte: horizon },
    }).setOptions({ allowCrossTenant: !tenantId }).limit(200).lean();

    for (const opportunity of due) {
      const daysOut = Math.ceil((new Date(opportunity.expectedAvailableDate) - now) / 86400000);
      const band = LEAD_TIME_DAYS.find((d) => daysOut <= d);
      if (band === undefined) continue;
      // One reminder per band: skip if the last one already covered this band.
      if (opportunity.reminderSentAt) {
        const previousDays = Math.ceil(
          (new Date(opportunity.expectedAvailableDate) - new Date(opportunity.reminderSentAt)) / 86400000,
        );
        const previousBand = LEAD_TIME_DAYS.find((d) => previousDays <= d);
        if (previousBand === band) continue;
      }

      await Model.updateOne({ tenantId: opportunity.tenantId, _id: opportunity._id }, { $set: { reminderSentAt: now } });
      await notifications.notify({
        tenantId: opportunity.tenantId,
        userId: opportunity.assignedUserId,
        type: `${label.toUpperCase()}_OPPORTUNITY_DUE`,
        title: `${label} opportunity in ${daysOut} days`,
        body: 'Reach out before the unit comes back to the market.',
        link: `/app/opportunities/${key}`,
        severity: 'INFO',
      });
      emit(type, { tenantId: opportunity.tenantId, opportunityId: opportunity._id, daysOut });
      result[key] += 1;
    }
  }
  return result;
}

const MODELS = { resale: ResaleOpportunity, rental: RentalOpportunity };

async function list({ tenantId, kind, user, query = {}, zone = 'UTC' }) {
  const Model = MODELS[kind];
  if (!Model) throw badRequest('Unknown opportunity type.');

  const filter = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.mine === '1') filter.assignedUserId = user._id;
  if (query.window) {
    const days = Number(query.window);
    filter.expectedAvailableDate = { $lte: tz.addLocalDays(new Date(), days, zone) };
  }
  return Model.find(filter)
    .sort({ expectedAvailableDate: 1 })
    .populate('contactId', 'displayName primaryMobile')
    .populate('unitId', 'unitNumber')
    .populate('projectId', 'name')
    .populate('assignedUserId', 'name')
    .lean();
}

async function update({ tenantId, actor, kind, opportunityId, data }) {
  const Model = MODELS[kind];
  if (!Model) throw badRequest('Unknown opportunity type.');
  const opportunity = await Model.findOne({ tenantId, _id: opportunityId });
  if (!opportunity) throw notFound('Opportunity not found.');

  for (const field of ['status', 'assignedUserId', 'nextActionAt', 'nextActionNote', 'notes',
    'expectedAvailableDate', 'expectedAskingPriceMinor', 'expectedRentMinor', 'furnishing']) {
    if (data[field] !== undefined) opportunity[field] = data[field];
  }
  await opportunity.save();
  return opportunity;
}

/** §94: the management cards. */
async function summary({ tenantId, zone = 'UTC', now = new Date() }) {
  const in30 = tz.addLocalDays(now, 30, zone);
  const in90 = tz.addLocalDays(now, 90, zone);
  const open = { $in: ['UPCOMING', 'IN_DISCUSSION', 'LISTED'] };

  const [resale30, resale90, rental30, valueRows, rentalCount] = await Promise.all([
    ResaleOpportunity.countDocuments({ tenantId, status: open, expectedAvailableDate: { $lte: in30 } }),
    ResaleOpportunity.countDocuments({ tenantId, status: open, expectedAvailableDate: { $lte: in90 } }),
    RentalOpportunity.countDocuments({ tenantId, status: open, expectedAvailableDate: { $lte: in30 } }),
    ResaleOpportunity.aggregate([
      { $match: { tenantId: toObjectId(tenantId), status: { $in: ['UPCOMING', 'IN_DISCUSSION', 'LISTED'] } } },
      { $group: { _id: null, total: { $sum: '$expectedAskingPriceMinor' } } },
    ]),
    RentalOpportunity.countDocuments({ tenantId, status: open }),
  ]);

  return {
    resaleNext30: resale30,
    resaleNext90: resale90,
    rentalNext30: rental30,
    expectedResaleValueMinor: valueRows[0]?.total || 0,
    rentalCount,
  };
}

const toObjectId = (value) => (typeof value === 'string'
  ? new (require('mongoose').Types.ObjectId)(value)
  : value);

module.exports = { createFromBooking, reminderSweep, list, update, summary, LEAD_TIME_DAYS };
