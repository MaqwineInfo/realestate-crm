const { crud } = require('./factory');
const gst = require('./gst');
const messaging = require('./messaging');
const money = require('../../lib/money');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyBill, SocietyBillCategory, SocietyUnitBill, SocietyUnitBillPayment,
  SocietyMaintenance, SocietyBalanceSheet, SocietyUnit, SocietyUnitOccupancy,
  SocietyNotification, SocietyUser,
} = require('../../db/models/society');

/**
 * Bills and maintenance: the two ways a society charges a unit.
 *
 * They are the same shape — a *definition* that fans out into per-unit
 * `SocietyUnitBill` rows — so the fan-out lives once, in `fanOut()`. A bill is
 * raised on demand; a maintenance rule recurs. That is the only difference, and
 * it is why the canonical model separates them where the legacy service
 * conflated the rule with the debt (SOCIETY-PLAN.md §2.2).
 *
 * Money is integer paise throughout, and GST goes through
 * `services/society/gst.js` so `base + gst === total` exactly.
 */

const categories = crud({
  Model: SocietyBillCategory,
  listKey: 'billCategories',
  searchFields: ['name', 'description'],
  filterFields: ['status'],
  unique: ['name'],
  pageParam: 'limit',
  sort: { name: 1 },
});

const balanceSheets = crud({
  Model: SocietyBalanceSheet,
  listKey: 'balanceSheets',
  searchFields: ['name', 'accountCode'],
  filterFields: ['type', 'balanceSheetType', 'status', 'blockId'],
  unique: ['accountCode'],
  pageParam: 'limit',
  sort: { name: 1 },
});

const bills = crud({
  Model: SocietyBill,
  listKey: 'bills',
  searchFields: ['name', 'description'],
  filterFields: ['billCategoryId', 'publishStatus', 'status', 'balanceSheetId'],
  populate: ['billCategoryId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

const maintenances = crud({
  Model: SocietyMaintenance,
  listKey: 'maintenances',
  searchFields: ['title', 'description'],
  filterFields: ['maintenanceType', 'publishStatus', 'status', 'balanceSheetId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/* --------------------------------- fan-out ---------------------------------- */

/**
 * The units a definition applies to.
 *
 * `selectionType` is the source's vocabulary: everything, the units in some
 * blocks, or an explicit list.
 */
async function targetUnits(ctx, def) {
  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (def.selectionType === 'BLOCK' && def.blockIds?.length) {
    filter.blockId = { $in: def.blockIds };
  } else if (def.selectionType === 'UNIT') {
    const ids = def.targetUnitIds?.length ? def.targetUnitIds : def.unitIds;
    if (!ids?.length) throw badRequest('Choose at least one unit.');
    filter._id = { $in: ids };
  }
  return SocietyUnit.find(filter).select('_id residentType occupancyStatus').lean();
}

/**
 * What one unit owes, given who is in it.
 *
 * A vacant flat still owes its share of common costs, which is what
 * `priceCloseUnit` is for — the source's name for it, kept.
 */
function priceFor(def, unit) {
  if (unit.occupancyStatus !== 'OCCUPIED') return def.priceCloseUnitMinor || 0;
  if (unit.residentType === 'Tenant') return def.priceTenantMinor || 0;
  return def.priceOwnerMinor || 0;
}

/**
 * Creates the per-unit rows for a definition.
 *
 * **Idempotent.** `SocietyUnitBill` has a unique index on (bill, unit) and on
 * (maintenance, unit, period), and this inserts unordered — so a retry after a
 * partial failure fills the gaps instead of double-billing everyone it already
 * reached. That matters because a maintenance run is a scheduled job over four
 * hundred units and the third batch is the one that fails.
 */
async function fanOut(ctx, def, { type, billingPeriod = null }) {
  const units = await targetUnits(ctx, def);
  if (!units.length) return { inserted: 0, skipped: 0, totalMinor: 0 };

  const docs = [];
  let totalMinor = 0;

  for (const unit of units) {
    const gross = priceFor(def, unit);
    if (!gross) continue;

    const breakdown = gst.calculate({
      gstPercentage: def.gstPercentage,
      gstAmountType: def.gstAmountType,
      billType: def.billType,
    }, gross);
    totalMinor += breakdown.totalAmountMinor;

    docs.push({
      societyId: ctx.societyId,
      [type === 'BILL' ? 'billId' : 'maintenanceId']: def._id,
      type,
      unitId: unit._id,
      amountMinor: breakdown.totalAmountMinor,
      baseAmountMinor: breakdown.baseAmountMinor,
      gstAmountMinor: breakdown.gstAmountMinor,
      gstPercentage: breakdown.gstPercentage,
      gstAmountType: def.gstAmountType || null,
      dueDate: def.dueDate,
      billingPeriod: billingPeriod || undefined,
      lateFeeConfig: {
        enabled: Boolean(def.lateFee),
        amountMinor: def.lateFeeAmountMinor || 0,
        type: 'FIXED',
      },
    });
  }

  let inserted = 0;
  let skipped = 0;
  let unitIds = [];
  try {
    const made = await SocietyUnitBill.insertMany(docs, { ordered: false });
    inserted = made.length;
    unitIds = made.map((d) => d.unitId);
  } catch (err) {
    const dupes = (err.writeErrors || []).filter((e) => (e.err?.code || e.code) === 11000);
    if (dupes.length !== (err.writeErrors || []).length) throw err;
    inserted = docs.length - dupes.length;
    skipped = dupes.length;
    const failed = new Set(dupes.map((d) => String(docs[d.index]?.unitId)));
    unitIds = docs.map((d) => d.unitId).filter((u) => !failed.has(String(u)));
  }

  return {
    inserted, skipped, totalMinor, unitIds,
  };
}

/** Publishing a bill is what creates the debt, and tells the residents. */
async function publishBill(ctx, id, actorId) {
  const bill = await SocietyBill.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!bill) throw notFound('Bill not found');

  const result = await fanOut(ctx, bill, { type: 'BILL' });
  await SocietyBill.updateOne({ societyId: ctx.societyId, _id: id }, {
    $set: { publishStatus: 'PUBLISHED', publishedAt: bill.publishedAt || new Date(), updatedBy: actorId },
  });

  /**
   * Only the units this call actually billed are told. A re-publish inserts
   * nothing and therefore notifies nobody — which is what makes a retry safe
   * without needing a separate `notificationSent` flag.
   */
  if (result.inserted) {
    await notifyUnits(ctx, {
      unitIds: result.unitIds,
      title: `New bill: ${bill.name}`,
      body: 'A new charge has been raised for your unit.',
      type: 'BILL',
      referenceId: bill._id,
    });
  }
  return result;
}

async function createBill(ctx, data, actorId) {
  const bill = await bills.create(ctx, data, actorId);
  if (data.publishStatus === 'PUBLISHED') {
    const out = await publishBill(ctx, bill._id, actorId);
    return { ...bill, publishStatus: 'PUBLISHED', generated: out };
  }
  return bill;
}

/* ------------------------------ maintenance runs ------------------------------ */

/** The period a run covers — month-wise rules bill a calendar month. */
function periodFor(def, when = new Date()) {
  if (def.maintenanceType !== 'MONTH_WISE') {
    return { startDate: def.startDate || when, endDate: def.endDate || null };
  }
  const start = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), 1));
  const end = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + 1, 0));
  return { startDate: start, endDate: end };
}

/**
 * Generates one period's bills for a maintenance rule.
 *
 * Safe to call twice for the same period: the (maintenance, unit, period)
 * unique index turns the second attempt into skips.
 */
async function runMaintenance(ctx, id, { when = new Date(), actorId = null } = {}) {
  const def = await SocietyMaintenance.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!def) throw notFound('Maintenance not found');

  const billingPeriod = periodFor(def, when);
  const result = await fanOut(ctx, def, { type: 'MAINTENANCE', billingPeriod });

  await SocietyMaintenance.updateOne({ societyId: ctx.societyId, _id: id }, {
    $set: {
      publishStatus: 'PUBLISHED',
      publishedAt: def.publishedAt || new Date(),
      lastRunDate: when,
      nextRunDate: def.autoGenerate ? nextRun(def, when) : null,
      updatedBy: actorId,
    },
  });

  if (result.inserted) {
    await notifyUnits(ctx, {
      unitIds: result.unitIds,
      title: `Maintenance due: ${def.title}`,
      body: 'Your maintenance bill for this period is ready.',
      type: 'MAINTENANCE',
      referenceId: def._id,
    });
  }
  return result;
}

const nextRun = (def, from) => (def.maintenanceType === 'MONTH_WISE'
  ? new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
  : null);

/**
 * The scheduler's sweep. Cross-society by design — it runs for the platform.
 */
async function runDueMaintenance(now = new Date()) {
  const due = await SocietyMaintenance.find({
    autoGenerate: true,
    status: 'ACTIVE',
    isDeleted: false,
    nextRunDate: { $lte: now },
  }).setOptions({ allowCrossSociety: true }).lean();

  let generated = 0;
  for (const def of due) {
    // eslint-disable-next-line no-await-in-loop
    const out = await runMaintenance({ societyId: def.societyId }, def._id, { when: now });
    generated += out.inserted;
  }
  return { rules: due.length, generated };
}

/* --------------------------------- payments ---------------------------------- */

/**
 * Records money against a unit bill.
 *
 * Part payment is real, so payments are their own rows and the bill's status is
 * derived from their sum — a single `paidAmount` field could not say when each
 * instalment arrived or how. The bill flips to PAID only when the outstanding
 * balance reaches zero.
 */
async function recordPayment(ctx, unitBillId, data, actorId) {
  const bill = await SocietyUnitBill.findOne({
    societyId: ctx.societyId, _id: unitBillId, isDeleted: false,
  }).lean();
  if (!bill) throw notFound('Bill not found');

  /**
   * `amount` is rupees from a form; `amountMinor` is already paise. Running
   * both through `toMinor()` multiplied an internal caller's paise by a
   * hundred — a ₹500 payment arrived as ₹50,000 and was rejected as larger
   * than the bill. The two inputs are read differently, deliberately.
   */
  const amountMinor = data.amountMinor !== undefined
    ? Math.round(Number(data.amountMinor))
    : money.toMinor(data.amount);
  if (!amountMinor || amountMinor <= 0) throw badRequest('Enter an amount greater than zero.');

  const outstanding = await outstandingFor(ctx, bill);
  if (amountMinor > outstanding) {
    throw badRequest(`That is more than the ${money.format(outstanding)} outstanding.`);
  }

  try {
    await SocietyUnitBillPayment.create({
      societyId: ctx.societyId,
      unitBillId,
      unitId: bill.unitId,
      amountMinor,
      paidDate: data.paidDate ? new Date(data.paidDate) : new Date(),
      paymentMethod: data.paymentMethod || 'Cash',
      transactionId: data.transactionId || null,
      notes: data.notes || null,
      recordedBy: actorId || null,
    });
  } catch (err) {
    // A gateway retry must not book the same money twice.
    if (err.code === 11000) throw conflict('That transaction has already been recorded.');
    throw err;
  }

  const left = await outstandingFor(ctx, bill);
  if (left <= 0) {
    await SocietyUnitBill.updateOne(
      { societyId: ctx.societyId, _id: unitBillId }, { $set: { status: 'PAID' } },
    );
  }
  return { unitBillId, paidMinor: amountMinor, outstandingMinor: Math.max(0, left) };
}

async function outstandingFor(ctx, bill) {
  const paid = await SocietyUnitBillPayment.aggregate([
    { $match: { societyId: ctx.societyId, unitBillId: bill._id, isDeleted: false } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]);
  const total = (bill.amountMinor || 0) + (bill.lateFeeApplied ? (bill.lateFeeAmountMinor || 0) : 0);
  return total - (paid[0]?.total || 0);
}

/** Who has paid and who has not, for one definition. */
async function paymentStatus(ctx, { billId, maintenanceId }) {
  const match = { societyId: ctx.societyId, isDeleted: false };
  if (billId) match.billId = billId;
  if (maintenanceId) match.maintenanceId = maintenanceId;

  const rows = await SocietyUnitBill.find(match)
    .populate('unitId', 'unitNumber blockNumber')
    .lean();

  const paid = await SocietyUnitBillPayment.aggregate([
    { $match: { societyId: ctx.societyId, unitBillId: { $in: rows.map((r) => r._id) }, isDeleted: false } },
    { $group: { _id: '$unitBillId', total: { $sum: '$amountMinor' } } },
  ]);
  const paidBy = new Map(paid.map((p) => [String(p._id), p.total]));

  const units = rows.map((r) => {
    const settled = paidBy.get(String(r._id)) || 0;
    return {
      ...r,
      paidMinor: settled,
      outstandingMinor: Math.max(0, (r.amountMinor || 0) - settled),
    };
  });

  return {
    units,
    summary: {
      count: units.length,
      billedMinor: units.reduce((a, u) => a + (u.amountMinor || 0), 0),
      collectedMinor: units.reduce((a, u) => a + u.paidMinor, 0),
      outstandingMinor: units.reduce((a, u) => a + u.outstandingMinor, 0),
      paidUnits: units.filter((u) => u.outstandingMinor === 0).length,
    },
  };
}

/* --------------------------------- resident ----------------------------------- */

/** A resident's own bills, across every unit they hold. */
async function forResident(ctx, userId, query = {}) {
  const own = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId, isCurrent: true, isDeleted: false,
  }).select('unitId').lean();
  if (!own.length) {
    return { bills: [], pagination: { total: 0, page: 1, limit: 10, totalPages: 0 } };
  }

  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit, 10) || 20);
  const filter = {
    societyId: ctx.societyId, unitId: { $in: own.map((o) => o.unitId) }, isDeleted: false,
  };
  if (query.status) filter.status = query.status;

  const [rows, total] = await Promise.all([
    SocietyUnitBill.find(filter)
      .populate('billId', 'name description')
      .populate('maintenanceId', 'title description')
      .sort({ dueDate: -1 }).skip((page - 1) * size).limit(size)
      .lean(),
    SocietyUnitBill.countDocuments(filter),
  ]);

  return {
    bills: rows,
    pagination: { total, page, limit: size, totalPages: Math.ceil(total / size) },
  };
}

async function unitBillDetail(ctx, id) {
  const bill = await SocietyUnitBill.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  })
    .populate('billId', 'name description')
    .populate('maintenanceId', 'title description')
    .populate('unitId', 'unitNumber blockNumber')
    .lean();
  if (!bill) throw notFound('Bill not found');

  const payments = await SocietyUnitBillPayment.find({
    societyId: ctx.societyId, unitBillId: id, isDeleted: false,
  }).sort({ paidDate: -1 }).lean();

  return {
    ...bill,
    payments,
    outstandingMinor: await outstandingFor(ctx, bill),
    tax: gst.split(bill.gstAmountMinor || 0),
  };
}

/* ------------------------------- notification --------------------------------- */

async function notifyUnits(ctx, {
  unitIds = null, title, body, type, referenceId,
}) {
  const filter = {
    societyId: ctx.societyId, isCurrent: true, isDeleted: false, userId: { $ne: null }, memberRole: 'PRIMARY',
  };
  if (unitIds) filter.unitId = { $in: unitIds };

  const residents = await SocietyUnitOccupancy.find(filter).select('userId unitId memberId').lean();
  if (!residents.length) return { notified: 0 };

  await SocietyNotification.insertMany(residents.map((r) => ({
    societyId: ctx.societyId,
    userId: r.userId,
    unitId: r.unitId,
    memberId: r.memberId || undefined,
    title,
    body,
    type,
    subType: 'RAISED',
    referenceId,
  })));

  const users = await SocietyUser.find({
    _id: { $in: residents.map((r) => r.userId) }, isDeleted: false,
  }).select('fcmToken').lean();
  await messaging.push({ tokens: users.map((u) => u.fcmToken), title, body, data: { type } });

  return { notified: residents.length };
}

/** Money collected and owed across the society — the finance tiles. */
async function societyStats(ctx) {
  const [billed, collected] = await Promise.all([
    SocietyUnitBill.aggregate([
      { $match: { societyId: ctx.societyId, isDeleted: false } },
      { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amountMinor' } } },
    ]),
    SocietyUnitBillPayment.aggregate([
      { $match: { societyId: ctx.societyId, isDeleted: false } },
      { $group: { _id: null, total: { $sum: '$amountMinor' } } },
    ]),
  ]);

  const byStatus = Object.fromEntries(billed.map((b) => [b._id, b]));
  const billedMinor = billed.reduce((a, b) => a + b.amount, 0);
  const collectedMinor = collected[0]?.total || 0;

  return {
    billedMinor,
    collectedMinor,
    outstandingMinor: billedMinor - collectedMinor,
    paidCount: byStatus.PAID?.n || 0,
    unpaidCount: byStatus.UNPAID?.n || 0,
  };
}

module.exports = {
  categories,
  balanceSheets,
  bills: { ...bills, create: createBill, publish: publishBill },
  maintenances: { ...maintenances, run: runMaintenance, runDue: runDueMaintenance },
  fanOut,
  priceFor,
  periodFor,
  recordPayment,
  outstandingFor,
  paymentStatus,
  forResident,
  unitBillDetail,
  societyStats,
};
