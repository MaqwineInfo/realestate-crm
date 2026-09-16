const { crud } = require('./factory');
const gst = require('./gst');
const messaging = require('./messaging');
const { notFound } = require('../../lib/errors');
const {
  SocietyPenalty, SocietyUnit, SocietyUnitOccupancy, SocietyNotification, SocietyUser,
} = require('../../db/models/society');

/**
 * Fines levied against a unit.
 *
 * A penalty carries its own tax breakdown rather than going through the bill
 * engine, because it is raised ad hoc by an admin and posted straight to a
 * ledger account. `baseAmount + gstAmount === totalAmount` is computed once
 * here, so the three can never disagree — the source stored them as three
 * independently-rounded floats.
 */
const base = crud({
  Model: SocietyPenalty,
  listKey: 'penalties',
  searchFields: ['description'],
  filterFields: ['unitId', 'status', 'paymentStatus', 'billType', 'balanceSheetId'],
  populate: ['unitId'],
  pageParam: 'limit',
  sort: { penaltyDate: -1 },
});

/** Derives the tax split from the amount, then notifies the unit. */
async function create(ctx, data, actorId) {
  const unit = await SocietyUnit.findOne({
    societyId: ctx.societyId, _id: data.unitId, isDeleted: false,
  }).select('unitNumber').lean();
  if (!unit) throw notFound('That unit does not exist in this society.');

  const breakdown = gst.calculate(data, Number(data.amountMinor) || 0);
  const penalty = await base.create(ctx, {
    ...data,
    baseAmountMinor: breakdown.baseAmountMinor,
    gstAmountMinor: breakdown.gstAmountMinor,
    totalAmountMinor: breakdown.totalAmountMinor,
  }, actorId);

  await notify(ctx, penalty, unit);
  return penalty;
}

/** Recomputes the tax whenever the amount or the tax settings move. */
async function update(ctx, id, data, actorId) {
  const current = await SocietyPenalty.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!current) throw notFound('Penalty not found');

  const merged = { ...current, ...data };
  const breakdown = gst.calculate(merged, Number(merged.amountMinor) || 0);

  return base.update(ctx, id, {
    ...data,
    baseAmountMinor: breakdown.baseAmountMinor,
    gstAmountMinor: breakdown.gstAmountMinor,
    totalAmountMinor: breakdown.totalAmountMinor,
  }, actorId);
}

async function notify(ctx, penalty, unit) {
  const residents = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, unitId: penalty.unitId, isCurrent: true, isDeleted: false,
    userId: { $ne: null },
  }).select('userId memberId').lean();
  if (!residents.length) return { notified: 0 };

  const title = `Penalty raised for ${unit?.unitNumber || 'your unit'}`;
  await SocietyNotification.insertMany(residents.map((r) => ({
    societyId: ctx.societyId,
    userId: r.userId,
    unitId: penalty.unitId,
    memberId: r.memberId || undefined,
    title,
    body: penalty.description,
    type: 'PENALTY',
    subType: 'RAISED',
    referenceId: penalty._id,
  })));

  const users = await SocietyUser.find({
    _id: { $in: residents.map((r) => r.userId) }, isDeleted: false,
  }).select('fcmToken').lean();
  await messaging.push({
    tokens: users.map((u) => u.fcmToken),
    title,
    body: penalty.description,
    data: { type: 'PENALTY', penaltyId: String(penalty._id) },
  });
  return { notified: residents.length };
}

/** `resend-notification/:penaltyId` — for when the resident says they saw nothing. */
async function resendNotification(ctx, id) {
  const penalty = await SocietyPenalty.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!penalty) throw notFound('Penalty not found');
  const unit = await SocietyUnit.findById(penalty.unitId).select('unitNumber').lean();
  return notify(ctx, penalty, unit);
}

/** A resident's own penalties, across every unit they hold. */
async function forResident(ctx, userId, query = {}) {
  const own = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!own.length) {
    return { penalties: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } };
  }
  return base.list(ctx, { ...query, unitId: { $in: own.map((o) => o.unitId) } });
}

/** A penalty rendered as an invoice, with the tax split spelled out. */
async function invoice(ctx, id) {
  /**
   * The split is computed from the STORED paise, not from `base.detail()`'s
   * output — that has already been wire-serialized, so `gstAmountMinor` is gone
   * and splitting it silently produced zeroes.
   */
  const raw = await SocietyPenalty.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!raw) throw notFound('Penalty not found');

  const penalty = await base.detail(ctx, id);
  const { Society } = require('../../db/models/society');
  const society = await Society.findById(ctx.societyId)
    .select('societyName address taxInformation').lean();

  return {
    penalty,
    society,
    tax: gst.split(raw.gstAmountMinor || 0, raw.gstType),
    gstAmountMinor: raw.gstAmountMinor || 0,
  };
}

module.exports = {
  ...base, create, update, resendNotification, forResident, invoice, notify,
};
