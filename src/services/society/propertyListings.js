const { crud } = require('./factory');
const messaging = require('./messaging');
const serialize = require('../../lib/society/serialize');
const seams = require('./seams');
const money = require('../../lib/money');
const { badRequest, notFound, forbidden, conflict } = require('../../lib/errors');
const {
  SocietyPropertyListing, SocietyUnitOccupancy, SocietyNotification, SocietyUser,
} = require('../../db/models/society');
const enums = require('../../db/models/society/enums');

/**
 * Residents advertising their own flat to the rest of the society.
 *
 * Two things are load-bearing:
 *
 * 1. **Only an owner of that exact unit may list it**, and ownership is proved
 *    by a live `SocietyUnitOccupancy` row, not by anything in the request. The
 *    occupancy `_id` is what gets stored in `listedBy` — so when somebody moves
 *    out, the listing's authorship still points at the tenancy that made it.
 *
 * 2. **One live listing per flat**, enforced by the unique partial index on the
 *    model rather than by the read below. The read gives the friendly message;
 *    the index is what actually holds when two phones submit together.
 *
 * Price is integer paise like all money here (SOCIETY-PLAN.md §3.9) and is
 * serialized back to the source's plain number at the wire boundary.
 */

/**
 * `priceMinor` and `listedBy` are declared as filter fields because the factory
 * only forwards keys it knows about — anything else is dropped in silence, so a
 * price range or an ownership scope built here would simply not narrow
 * anything. The values passed for them are Mongo expressions, not scalars.
 */
const LIST = {
  Model: SocietyPropertyListing,
  listKey: 'listings',
  filterFields: ['type', 'status', 'furnishing', 'unitId', 'priceMinor', 'listedBy'],
  pageParam: 'perPage',
  sort: { createdAt: -1 },
};

/** The community board: who is offering it matters, so the lister is resolved. */
const base = crud({ ...LIST, populate: ['unitId', 'listedBy', 'societyId'] });

/** Your own listings: you know who listed them. */
const own = crud({ ...LIST, populate: ['unitId', 'societyId'] });

/** The occupancy that proves this user owns this unit, or nothing. */
const ownerOccupancy = (ctx, userId, unitId) => SocietyUnitOccupancy.findOne({
  societyId: ctx.societyId, userId, unitId, residentType: 'Owner', isCurrent: true, isDeleted: false,
}).lean();

/**
 * A price filter arrives in rupees because that is what the source's clients
 * send; storage is paise, so the bound is converted rather than the column.
 */
function priceFilter({ minPrice, maxPrice }) {
  if (minPrice === undefined && maxPrice === undefined) return null;
  const range = {};
  if (minPrice !== undefined && minPrice !== '') range.$gte = money.toMinor(minPrice);
  if (maxPrice !== undefined && maxPrice !== '') range.$lte = money.toMinor(maxPrice);
  return Object.keys(range).length ? range : null;
}

/**
 * The factory serializes money on the paths it owns; these four are hand-written,
 * so they convert at the same boundary rather than leaking paise to the app.
 */
const out = (doc) => serialize.forModel(SocietyPropertyListing, doc);
const inn = (data) => serialize.fromWire(data, SocietyPropertyListing.MONEY_FIELDS);

async function create(ctx, raw, userId) {
  const data = inn(raw);
  const occupancy = await ownerOccupancy(ctx, userId, data.unitId);
  if (!occupancy) throw forbidden('Only owners of this unit can create a listing');

  if (!enums.propertyListingType.includes(data.type)) throw badRequest('Invalid listing type');

  const live = await SocietyPropertyListing.findOne({
    societyId: ctx.societyId, unitId: data.unitId, status: 'ACTIVE', isDeleted: false,
  }).lean();
  if (live) throw badRequest('An active listing already exists for this unit and type');

  let created;
  try {
    created = await SocietyPropertyListing.create({
      ...data,
      societyId: ctx.societyId,
      unitId: data.unitId,
      listedBy: occupancy._id,
      status: 'ACTIVE',
    });
  } catch (err) {
    // The index, not the read above, is what actually stops the second tab.
    if (err.code === 11000) throw badRequest('An active listing already exists for this unit and type');
    throw err;
  }

  // Telling the neighbours is a courtesy, not part of the listing succeeding.
  announce(ctx, created, userId).catch(() => {});

  /**
   * Seam 4 (D4): a flat for sale is business for the channel-partner side. Not
   * awaited, for the same reason as the announcement.
   */
  seams.channelPartnerForListing({
    listingId: created._id, societyId: ctx.societyId,
  }).catch(() => {});

  return out(created.toObject());
}

/** Everyone in the society except the person who listed it. */
async function announce(ctx, listing, excludeUserId) {
  const residents = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, isCurrent: true, isDeleted: false, memberRole: 'PRIMARY',
    userId: { $ne: excludeUserId, $exists: true },
  }).select('userId unitId memberId').lean();
  if (!residents.length) return { notified: 0 };

  const title = listing.type === 'RENT' ? 'A flat is up for rent' : 'A flat is up for sale';
  const body = `${money.format(listing.priceMinor)}${listing.negotiable ? ' (negotiable)' : ''}`;

  await SocietyNotification.insertMany(residents.map((r) => ({
    societyId: ctx.societyId,
    userId: r.userId,
    unitId: r.unitId,
    memberId: r.memberId || undefined,
    title,
    body,
    type: 'PROPERTY_LISTING',
    subType: listing.type,
    referenceId: listing._id,
  })), { ordered: false });

  const users = await SocietyUser.find({
    _id: { $in: residents.map((r) => r.userId) }, isDeleted: false,
  }).select('fcmToken').lean();
  await messaging.push({
    tokens: users.map((u) => u.fcmToken),
    title,
    body,
    data: { type: 'PROPERTY_LISTING', listingId: String(listing._id) },
  });
  return { notified: residents.length };
}

/** The community board: active listings only. */
async function list(ctx, query = {}) {
  const price = priceFilter(query);
  return base.list(ctx, {
    ...query,
    status: 'ACTIVE',
    ...(price ? { priceMinor: price } : {}),
  });
}

/** A resident's own listings, in whatever state — including withdrawn ones. */
async function mine(ctx, userId, query = {}) {
  const held = await SocietyUnitOccupancy.find({
    societyId: ctx.societyId, userId, isCurrent: true, isDeleted: false,
  }).distinct('_id');
  if (!held.length) {
    return { listings: [], pagination: { total: 0, page: 1, perPage: 10, totalPages: 0 } };
  }
  return own.list(ctx, { ...query, listedBy: { $in: held } });
}

async function detail(ctx, id) {
  const listing = await SocietyPropertyListing.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).populate('unitId', 'unitNumber blockNumber floorNumber')
    .populate('listedBy', 'firstName lastName mobileNumber countryCode profilePhoto')
    .lean();
  if (!listing) throw notFound('Listing not found');
  return out(listing);
}

/** Ownership is re-proved on every write; a stale token is not authority. */
async function assertMine(ctx, id, userId) {
  const listing = await SocietyPropertyListing.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  });
  if (!listing) throw notFound('Listing not found');

  const held = await SocietyUnitOccupancy.exists({
    societyId: ctx.societyId, _id: listing.listedBy, userId, isCurrent: true, isDeleted: false,
  });
  if (!held) throw forbidden('Listing not found or unauthorized');
  return listing;
}

/**
 * The identity of a listing — which society, which flat, who listed it — is not
 * editable. Only the advertisement is.
 */
const IMMUTABLE = ['societyId', 'unitId', 'listedBy', 'createdAt', 'isDeleted', 'deletedAt', 'deletedBy'];

async function update(ctx, id, raw, userId) {
  await assertMine(ctx, id, userId);
  const patch = inn(raw);
  for (const key of IMMUTABLE) delete patch[key];

  if (patch.status && !enums.propertyListingStatus.includes(patch.status)) {
    throw badRequest('Invalid status');
  }

  try {
    return out(await SocietyPropertyListing.findOneAndUpdate(
      { societyId: ctx.societyId, _id: id, isDeleted: false },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean());
  } catch (err) {
    if (err.code === 11000) throw conflict('An active listing already exists for this unit and type');
    throw err;
  }
}

/**
 * Withdrawing frees the flat for a new listing, so the soft delete must also
 * clear `status` — leaving it ACTIVE would keep the unique index occupied by a
 * row nobody can see.
 */
async function remove(ctx, id, userId) {
  await assertMine(ctx, id, userId);
  return out(await SocietyPropertyListing.findOneAndUpdate(
    { societyId: ctx.societyId, _id: id, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: userId, status: 'INACTIVE' } },
    { new: true },
  ).lean());
}

module.exports = { ...base, create, list, mine, detail, update, remove, announce, priceFilter };
