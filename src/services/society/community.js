const { crud } = require('./factory');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyGallery, SocietyDocument, SocietyDocumentType, SocietyEmergencyNumber,
  SocietyLostAndFound, SocietyEvent, SocietyEventUser, SocietyNotification,
  SocietyCounter, SocietyUnitOccupancy,
} = require('../../db/models/society');

/**
 * The community modules: galleries, documents, emergency numbers, lost & found,
 * events and the resident notification inbox.
 *
 * Mostly factory CRUD. What is written out by hand is the handful of rules the
 * factory cannot express — a reference number that must be minted atomically,
 * an event that fills up and starts a wait-list, a document that is a private
 * file rather than a public URL.
 */

/* -------------------------------- galleries -------------------------------- */

/**
 * Society and block galleries are one collection discriminated by
 * `galleryType`. The legacy `blockgalleries` endpoints read the same rows with
 * `galleryType: 'Block'` (SOCIETY-PLAN.md §2.2) — there is no second copy.
 */
const galleries = crud({
  Model: SocietyGallery,
  listKey: 'galleries',
  searchFields: ['title', 'description'],
  filterFields: ['galleryType', 'eventId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/** Removes one image from a gallery, leaving the gallery itself. */
async function removeImage(ctx, id, image, actorId) {
  if (!image) throw badRequest('Name the image to remove.');
  const gallery = await SocietyGallery.findOneAndUpdate(
    { societyId: ctx.societyId, _id: id, isDeleted: false },
    { $pull: { images: image }, $set: { updatedBy: actorId || null } },
    { new: true },
  ).lean();
  if (!gallery) throw notFound('Gallery not found');
  return gallery;
}

const blockGalleries = {
  list: (ctx, query) => galleries.list(ctx, { ...query, galleryType: 'Block' }),
  detail: (ctx, id) => galleries.detail(ctx, id),
  create: (ctx, data, actorId) => galleries.create(ctx, { ...data, galleryType: 'Block' }, actorId),
  update: (ctx, id, data, actorId) => galleries.update(ctx, id, data, actorId),
  remove: (ctx, id, actorId) => galleries.remove(ctx, id, actorId),
};

/* -------------------------------- documents -------------------------------- */

const documentTypes = crud({
  Model: SocietyDocumentType,
  listKey: 'documentTypes',
  searchFields: ['typeName'],
  filterFields: ['status'],
  unique: ['typeName'],
  pageParam: 'limit',
  sort: { typeName: 1 },
});

/**
 * Society documents. `documentFile` is a PRIVATE file: bye-laws and AGM minutes
 * routinely name residents and their dues, so the path points into
 * `privateUploadDir` and is served through `/app/files/:kind/:id` after a
 * permission check, never as a public URL. The source stored an S3 link.
 */
const documents = crud({
  Model: SocietyDocument,
  listKey: 'documents',
  searchFields: ['documentName', 'documentDescription'],
  filterFields: ['documentTypeId', 'status'],
  populate: ['documentTypeId'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

async function removeDocumentType(ctx, id, actorId) {
  const inUse = await SocietyDocument.countDocuments({
    societyId: ctx.societyId, documentTypeId: id, isDeleted: false,
  });
  if (inUse > 0) throw conflict(`Cannot delete this type — ${inUse} document(s) use it.`);
  return documentTypes.remove(ctx, id, actorId);
}

/* ---------------------------- emergency numbers ----------------------------- */

const emergencyNumbers = crud({
  Model: SocietyEmergencyNumber,
  listKey: 'emergencyNumbers',
  searchFields: ['name', 'emergencyNumber'],
  filterFields: ['status'],
  pageParam: 'limit',
  sort: { name: 1 },
});

/* ------------------------------ lost and found ------------------------------ */

const lostAndFound = crud({
  Model: SocietyLostAndFound,
  listKey: 'items',
  searchFields: ['itemName', 'description', 'itemId'],
  filterFields: ['type', 'status', 'category'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

/** `LF-001`, minted atomically — see `SocietyCounter` for why not read-then-add. */
async function reportLostItem(ctx, data, actor = {}) {
  const societyCode = ctx.society?.societyCode
    || (await require('../../db/models/society').Society.findById(ctx.societyId)
      .select('societyCode').lean())?.societyCode;

  const reporter = actor.userId
    ? await SocietyUnitOccupancy.findOne({
      societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
    }).select('_id').lean()
    : null;

  return lostAndFound.create(ctx, {
    ...data,
    itemId: await SocietyCounter.nextRef({
      societyCode, kind: 'lost-found', date: 'ALL', prefix: 'LF', width: 3,
    }),
    reportedBy: reporter?._id || actor.adminId || null,
    reporterModel: reporter ? 'SocietyUnitOccupancy' : 'SocietyAdmin',
  }, actor.adminId || null);
}

async function claimItem(ctx, id, actor) {
  const item = await SocietyLostAndFound.findOneAndUpdate(
    {
      societyId: ctx.societyId, _id: id, isDeleted: false, status: 'ACTIVE',
    },
    { $set: { status: 'CLAIMED', claimedBy: actor.memberId || null, claimedAt: new Date() } },
    { new: true },
  ).lean();
  if (!item) throw notFound('No unclaimed item with that id.');
  return item;
}

/* --------------------------------- events ----------------------------------- */

const events = crud({
  Model: SocietyEvent,
  listKey: 'events',
  searchFields: ['title', 'description', 'venue'],
  filterFields: ['status', 'eventType'],
  pageParam: 'limit',
  sort: { eventStart: -1 },
});

/**
 * Registers a resident, moving them to the wait-list once the event is full.
 *
 * The counters are moved with a conditional `$inc` that names the limit, so two
 * simultaneous registrations for the last seat cannot both take it — the second
 * matches no document and falls through to the wait-list.
 */
async function register(ctx, eventId, actor) {
  const event = await SocietyEvent.findOne({
    societyId: ctx.societyId, _id: eventId, isDeleted: false,
  }).lean();
  if (!event) throw notFound('Event not found');
  if (event.status === 'CANCELLED') throw badRequest('That event has been cancelled.');

  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).populate('unitId', 'unitNumber blockId floorId').lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  const limit = event.registrationLimit;
  let waiting = false;

  if (limit) {
    const took = await SocietyEvent.findOneAndUpdate(
      { societyId: ctx.societyId, _id: eventId, registrationCount: { $lt: limit } },
      { $inc: { registrationCount: 1 } },
      { new: true },
    ).lean();
    if (!took) {
      await SocietyEvent.updateOne({ societyId: ctx.societyId, _id: eventId }, { $inc: { waitingCount: 1 } });
      waiting = true;
    }
  } else {
    await SocietyEvent.updateOne({ societyId: ctx.societyId, _id: eventId }, { $inc: { registrationCount: 1 } });
  }

  try {
    const row = await SocietyEventUser.create({
      societyId: ctx.societyId,
      eventId,
      userId: actor.userId,
      firstName: occupancy.firstName,
      lastName: occupancy.lastName,
      email: occupancy.email,
      phoneNumber: occupancy.mobileNumber,
      countryCode: occupancy.countryCode,
      unitId: occupancy.unitId?._id || occupancy.unitId,
      unitNumber: occupancy.unitId?.unitNumber,
      blockId: occupancy.unitId?.blockId,
      floorId: occupancy.unitId?.floorId,
      isRegistration: !waiting,
      isWaiting: waiting,
    });
    return row.toObject();
  } catch (err) {
    if (err.code === 11000) {
      // Give the seat back — they already had one.
      await SocietyEvent.updateOne(
        { societyId: ctx.societyId, _id: eventId },
        { $inc: waiting ? { waitingCount: -1 } : { registrationCount: -1 } },
      );
      throw conflict('You are already registered for this event.');
    }
    throw err;
  }
}

const registrations = (ctx, eventId, query = {}) => {
  const filter = { societyId: ctx.societyId, eventId, isDeleted: false };
  if (query.waiting !== undefined) filter.isWaiting = query.waiting === 'true' || query.waiting === true;
  return SocietyEventUser.find(filter).sort({ createdAt: 1 }).lean();
};

/* ------------------------------ notifications -------------------------------- */

/** The resident's inbox. Unread first is what the bell badge counts. */
async function inbox(ctx, userId, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit, 10) || 20);
  const filter = { societyId: ctx.societyId, userId, isDeleted: false };
  if (query.status) filter.status = query.status;

  const [rows, total, unread] = await Promise.all([
    SocietyNotification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * size).limit(size).lean(),
    SocietyNotification.countDocuments(filter),
    SocietyNotification.countDocuments({
      societyId: ctx.societyId, userId, isDeleted: false, status: 'UNREAD',
    }),
  ]);

  return {
    notifications: rows,
    unreadCount: unread,
    pagination: { total, page, limit: size, totalPages: Math.ceil(total / size) },
  };
}

async function markRead(ctx, userId, { notificationId } = {}) {
  const filter = {
    societyId: ctx.societyId, userId, isDeleted: false, status: 'UNREAD',
  };
  if (notificationId) filter._id = notificationId;
  const res = await SocietyNotification.updateMany(filter, { $set: { status: 'READ' } });
  return { read: res.modifiedCount || 0 };
}

module.exports = {
  galleries: { ...galleries, removeImage },
  blockGalleries,
  documentTypes: { ...documentTypes, remove: removeDocumentType },
  documents,
  emergencyNumbers,
  lostAndFound: { ...lostAndFound, report: reportLostItem, claim: claimItem },
  events: { ...events, register, registrations },
  inbox,
  markRead,
};
