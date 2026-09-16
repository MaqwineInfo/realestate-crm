const { crud } = require('./factory');
const gst = require('./gst');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyAmenity, SocietyAmenityType, SocietyAmenitySlot, SocietyAmenityPackage,
  SocietyAmenityBooking, SocietyUnitOccupancy, Society,
} = require('../../db/models/society');

/**
 * Amenities: the facility, its bookable slots, its price tiers, and bookings.
 *
 * The one thing worth knowing before changing anything here: **double booking
 * is prevented by a unique index, not by a check**. `SocietyAmenityBooking` has
 * a multikey unique index over `(amenityId, bookingDate, slotIds)` partial on
 * CONFIRMED. `create()` writes optimistically and turns the duplicate-key error
 * into a 409. The source instead read for conflicts first and wrote second,
 * inside a transaction that does not exist on a standalone `mongod` — so two
 * residents tapping Book together both got the hall.
 */

const types = crud({
  Model: SocietyAmenityType,
  listKey: 'amenityTypes',
  searchFields: ['name'],
  filterFields: ['status'],
  unique: ['name'],
  pageParam: 'limit',
  sort: { name: 1 },
});

const base = crud({
  Model: SocietyAmenity,
  listKey: 'amenities',
  searchFields: ['name', 'description'],
  filterFields: ['status', 'amenityTypeId', 'pricingType'],
  unique: ['name'],
  populate: ['amenityTypeId'],
  pageParam: 'limit',
  sort: { name: 1 },
});

/** An amenity with its slots and packages — what the booking screen needs. */
async function detail(ctx, id) {
  const amenity = await base.detail(ctx, id);
  const [slots, packages] = await Promise.all([
    SocietyAmenitySlot.find({ societyId: ctx.societyId, amenityId: id, isDeleted: false })
      .sort({ startTime: 1 }).lean(),
    SocietyAmenityPackage.find({ societyId: ctx.societyId, amenityId: id, isDeleted: false })
      .sort({ capacity: 1 }).lean(),
  ]);
  return { ...amenity, slots, packages };
}

const setStatus = (ctx, id, status, actorId) => base.update(ctx, id, { status }, actorId);

/* ---------------------------- slots and packages ---------------------------- */

const slots = crud({
  Model: SocietyAmenitySlot,
  listKey: 'slots',
  filterFields: ['amenityId', 'status'],
  pageParam: 'limit',
  sort: { startTime: 1 },
});

const packages = crud({
  Model: SocietyAmenityPackage,
  listKey: 'packages',
  filterFields: ['amenityId', 'status'],
  unique: ['name'],
  pageParam: 'limit',
  sort: { capacity: 1 },
});

/** `HH:mm` to minutes, so overnight windows compare correctly. */
const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h * 60) + m;
};

async function addSlot(ctx, amenityId, data, actorId) {
  await base.detail(ctx, amenityId);
  const start = minutes(data.startTime);
  const end = minutes(data.endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) throw badRequest('Give both times as HH:mm.');
  // A window that ends before it starts is overnight, not invalid.
  const isOvernight = end <= start;
  return slots.create(ctx, { ...data, amenityId, isOvernight }, actorId);
}

const addPackage = async (ctx, amenityId, data, actorId) => {
  await base.detail(ctx, amenityId);
  return packages.create(ctx, { ...data, amenityId }, actorId);
};

/* -------------------------------- pricing --------------------------------- */

/**
 * What a booking will cost, before it is made.
 *
 * A free amenity is free whatever package is chosen — that is the amenity's
 * setting, not the package's, so it is checked first.
 */
async function quote(ctx, { amenityId, packageId, slotIds = [] }) {
  const amenity = await SocietyAmenity.findOne({
    societyId: ctx.societyId, _id: amenityId, isDeleted: false,
  }).lean();
  if (!amenity) throw notFound('Amenity not found');

  if (amenity.pricingType === 'FREE') {
    return {
      pricingType: 'FREE',
      baseAmountMinor: 0,
      gstAmountMinor: 0,
      totalAmountMinor: 0,
      gstPercentage: 0,
      slotCount: slotIds.length,
    };
  }

  let priceMinor = 0;
  let pkg = null;
  if (packageId) {
    pkg = await SocietyAmenityPackage.findOne({
      societyId: ctx.societyId, _id: packageId, amenityId, isDeleted: false,
    }).lean();
    if (!pkg) throw badRequest('That package does not belong to this amenity.');
    priceMinor = pkg.priceMinor || 0;
  }

  const breakdown = gst.calculate(amenity, priceMinor);
  return {
    ...breakdown,
    pricingType: 'PAID',
    packageId: pkg?._id || null,
    packageName: pkg?.name || null,
    slotCount: slotIds.length,
    gstSplit: gst.split(breakdown.gstAmountMinor, amenity.gstType),
  };
}

/* ------------------------------- availability ------------------------------- */

/**
 * Which of an amenity's slots are free on a date.
 *
 * One query for the day's confirmed bookings, then a set difference — not a
 * query per slot.
 */
async function availability(ctx, amenityId, dateStr) {
  const amenity = await SocietyAmenity.findOne({
    societyId: ctx.societyId, _id: amenityId, isDeleted: false,
  }).lean();
  if (!amenity) throw notFound('Amenity not found');

  const date = dayStart(dateStr);
  const [all, booked] = await Promise.all([
    SocietyAmenitySlot.find({
      societyId: ctx.societyId, amenityId, isDeleted: false, status: 'ACTIVE',
    }).sort({ startTime: 1 }).lean(),
    SocietyAmenityBooking.find({
      societyId: ctx.societyId,
      amenityId,
      bookingDate: date,
      status: 'CONFIRMED',
      isDeleted: false,
    }).select('slotIds').lean(),
  ]);

  const taken = new Set(booked.flatMap((b) => b.slotIds.map(String)));
  return {
    amenityId,
    date,
    slots: all.map((s) => ({ ...s, available: !taken.has(String(s._id)) })),
    availableCount: all.filter((s) => !taken.has(String(s._id))).length,
  };
}

/** Midnight UTC for the given day — bookings are per-date, not per-instant. */
function dayStart(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) throw badRequest('Give a valid booking date.');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/* -------------------------------- bookings --------------------------------- */

const bookings = crud({
  Model: SocietyAmenityBooking,
  listKey: 'bookings',
  filterFields: ['amenityId', 'status', 'paymentStatus', 'userId', 'unitId'],
  populate: ['amenityId'],
  pageParam: 'limit',
  sort: { bookingDate: -1 },
});

/**
 * Creates a booking, letting the database arbitrate the race.
 *
 * The write is attempted and E11000 becomes "already booked". That is the whole
 * concurrency story: no read-then-write window exists, so two simultaneous
 * requests cannot both succeed regardless of timing or transaction support.
 */
async function book(ctx, data, actor) {
  const {
    amenityId, slotIds = [], packageId = null, bookingDate,
  } = data;
  if (!slotIds.length) throw badRequest('Choose at least one slot.');

  const amenity = await SocietyAmenity.findOne({
    societyId: ctx.societyId, _id: amenityId, isDeleted: false,
  }).lean();
  if (!amenity) throw notFound('Amenity not found');
  if (amenity.status !== 'ACTIVE') throw badRequest('That amenity is not available for booking.');

  const date = dayStart(bookingDate);
  assertWithinBookingWindow(amenity, date);

  const valid = await SocietyAmenitySlot.countDocuments({
    societyId: ctx.societyId, amenityId, _id: { $in: slotIds }, isDeleted: false, status: 'ACTIVE',
  });
  if (valid !== slotIds.length) throw badRequest('One of those slots does not belong to this amenity.');

  const occupancy = await resolveResident(ctx, data, actor);
  const price = await quote(ctx, { amenityId, packageId, slotIds });

  try {
    const created = await SocietyAmenityBooking.create({
      societyId: ctx.societyId,
      amenityId,
      slotIds,
      packageId,
      bookingDate: date,
      memberId: occupancy._id,
      userId: occupancy.userId,
      unitId: occupancy.unitId,
      status: 'CONFIRMED',
      pricingType: price.pricingType,
      totalAmountMinor: price.totalAmountMinor,
      baseAmountMinor: price.baseAmountMinor,
      gstAmountMinor: price.gstAmountMinor,
      gstPercentage: price.gstPercentage,
      paymentStatus: price.totalAmountMinor > 0 ? 'PENDING' : 'PAID',
      upiLink: price.totalAmountMinor > 0 ? await upiLinkFor(ctx, price.totalAmountMinor, amenity) : null,
    });
    return created.toObject();
  } catch (err) {
    if (err.code === 11000) {
      throw conflict('One of those slots has just been booked by someone else.');
    }
    throw err;
  }
}

/** `advanceBookingDays` caps how far ahead residents may book. */
function assertWithinBookingWindow(amenity, date) {
  const today = dayStart(new Date());
  if (date < today) throw badRequest('That date is in the past.');
  const limit = new Date(today);
  limit.setUTCDate(limit.getUTCDate() + (amenity.advanceBookingDays || 7));
  if (date > limit) {
    throw badRequest(`Bookings open ${amenity.advanceBookingDays || 7} day(s) in advance.`);
  }
}

/**
 * Whose booking this is.
 *
 * A resident books for themselves — their occupancy is looked up, never taken
 * from the request, so they cannot book against another flat. An admin books on
 * someone's behalf and must name the unit.
 */
async function resolveResident(ctx, data, actor = {}) {
  if (actor.userId) {
    const own = await SocietyUnitOccupancy.findOne({
      societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
      ...(data.unitId ? { unitId: data.unitId } : {}),
    }).lean();
    if (!own) throw badRequest('You are not registered as a resident of this society.');
    return own;
  }

  if (!data.unitId) throw badRequest('unitId is required when booking on behalf of a resident.');
  const filter = {
    societyId: ctx.societyId, unitId: data.unitId, isCurrent: true, isDeleted: false,
  };
  if (data.memberId) filter._id = data.memberId;
  else filter.memberRole = 'PRIMARY';

  const occupancy = await SocietyUnitOccupancy.findOne(filter).lean();
  if (!occupancy) throw badRequest('That unit has no current resident to book for.');
  return occupancy;
}

/** A UPI deep link against the society's own VPA, for the payment QR. */
async function upiLinkFor(ctx, amountMinor, amenity) {
  const society = await Society.findById(ctx.societyId).select('upiDetails societyName').lean();
  const vpa = society?.upiDetails?.upiId;
  if (!vpa) return null;
  const rupees = (amountMinor / 100).toFixed(2);
  const name = encodeURIComponent(society.upiDetails.upiDisplayName || society.societyName);
  const note = encodeURIComponent(`${amenity.name} booking`);
  return `upi://pay?pa=${encodeURIComponent(vpa)}&pn=${name}&am=${rupees}&cu=INR&tn=${note}`;
}

/**
 * Cancelling frees the slot: the unique index is partial on CONFIRMED, so
 * moving the row out of that status releases it for someone else the moment
 * this write lands.
 */
async function cancel(ctx, id, { reason } = {}, actorId) {
  const booking = await SocietyAmenityBooking.findOneAndUpdate(
    {
      societyId: ctx.societyId, _id: id, status: 'CONFIRMED', isDeleted: false,
    },
    {
      $set: {
        status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actorId || null, cancellationReason: reason || null,
      },
    },
    { new: true },
  ).lean();
  if (!booking) throw notFound('No confirmed booking to cancel.');
  return booking;
}

const BOOKING_STATUSES = ['CONFIRMED', 'CANCELLED', 'COMPLETED', 'NO_SHOW'];

async function setBookingStatus(ctx, id, status, actorId) {
  if (!BOOKING_STATUSES.includes(status)) throw badRequest('Unknown booking status.');
  if (status === 'CANCELLED') return cancel(ctx, id, {}, actorId);

  const booking = await SocietyAmenityBooking.findOneAndUpdate(
    { societyId: ctx.societyId, _id: id, isDeleted: false },
    { $set: { status } },
    { new: true },
  ).lean();
  if (!booking) throw notFound('Booking not found');
  return booking;
}

/** An admin confirming that a UPI transfer actually arrived. */
async function verifyPayment(ctx, id, { transactionId, paymentType }, actorId) {
  const booking = await SocietyAmenityBooking.findOneAndUpdate(
    {
      societyId: ctx.societyId, _id: id, isDeleted: false, paymentStatus: { $ne: 'PAID' },
    },
    {
      $set: {
        paymentStatus: 'PAID',
        paidAt: new Date(),
        transactionId: transactionId || null,
        paymentType: paymentType || 'UPI',
        verifiedBy: actorId || null,
        verifiedAt: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!booking) throw notFound('No unpaid booking to verify.');
  return booking;
}

/** Bookings in a date range, for the admin calendar. */
async function calendar(ctx, { from, to, amenityId }) {
  const filter = {
    societyId: ctx.societyId, isDeleted: false, status: { $ne: 'CANCELLED' },
  };
  if (amenityId) filter.amenityId = amenityId;
  if (from || to) {
    filter.bookingDate = {};
    if (from) filter.bookingDate.$gte = dayStart(from);
    if (to) filter.bookingDate.$lte = dayStart(to);
  }
  const rows = await SocietyAmenityBooking.find(filter)
    .populate('amenityId', 'name calendarColor')
    .populate('unitId', 'unitNumber')
    .sort({ bookingDate: 1 })
    .lean();

  return {
    events: rows.map((b) => ({
      id: b._id,
      title: `${b.amenityId?.name || 'Amenity'} — ${b.unitId?.unitNumber || ''}`.trim(),
      date: b.bookingDate,
      color: b.amenityId?.calendarColor || '#3B82F6',
      status: b.status,
      paymentStatus: b.paymentStatus,
    })),
  };
}

/** A booking rendered as an invoice, with the tax split spelled out. */
async function invoice(ctx, id) {
  const booking = await SocietyAmenityBooking.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  })
    .populate('amenityId', 'name gstType taxValue')
    .populate('unitId', 'unitNumber blockNumber')
    .lean();
  if (!booking) throw notFound('Booking not found');

  const society = await Society.findById(ctx.societyId)
    .select('societyName address taxInformation').lean();

  return {
    booking,
    society,
    tax: gst.split(booking.gstAmountMinor || 0, booking.amenityId?.gstType),
  };
}

module.exports = {
  types,
  ...base,
  detail,
  setStatus,
  slots,
  packages,
  addSlot,
  addPackage,
  quote,
  availability,
  bookings,
  book,
  cancel,
  setBookingStatus,
  verifyPayment,
  calendar,
  invoice,
  dayStart,
};
