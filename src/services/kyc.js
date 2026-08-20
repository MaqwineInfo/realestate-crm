const {
  Booking, BookingApplicant, BookingKycDocument, KycDocumentType, Contact,
} = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const { scopeFilter } = require('../lib/access');
const privateFiles = require('../lib/privateFiles');
const secretbox = require('../lib/secretbox');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §125–§131: customer KYC.
 *
 * Three rules shape this file:
 *   1. files are private and only reachable through a permission check (§131);
 *   2. a replacement never destroys what the customer sent before (§128);
 *   3. the overall status is DERIVED from the documents, never typed in (§127) —
 *      so "verified" cannot be clicked while a mandatory document is missing.
 */

/** §125: the defaults a new tenant starts with. All editable afterwards. */
const DEFAULT_TYPES = [
  { code: 'PAN', name: 'PAN card', appliesTo: 'INDIVIDUAL', mandatory: true, numberRequired: true, displayOrder: 1 },
  { code: 'AADHAAR_FRONT', name: 'Aadhaar — front', appliesTo: 'INDIVIDUAL', mandatory: true, displayOrder: 2 },
  { code: 'AADHAAR_BACK', name: 'Aadhaar — back', appliesTo: 'INDIVIDUAL', mandatory: true, displayOrder: 3 },
  { code: 'PHOTO', name: 'Passport photo', appliesTo: 'INDIVIDUAL', mandatory: true, displayOrder: 4 },
  { code: 'PASSPORT', name: 'Passport', appliesTo: 'INDIVIDUAL', mandatory: false, expiryRequired: true, displayOrder: 5 },
  { code: 'DRIVING_LICENCE', name: 'Driving licence', appliesTo: 'INDIVIDUAL', mandatory: false, expiryRequired: true, displayOrder: 6 },
  { code: 'CANCELLED_CHEQUE', name: 'Cancelled cheque', appliesTo: 'BOTH', mandatory: false, displayOrder: 7 },
  { code: 'COMPANY_PAN', name: 'Company PAN', appliesTo: 'COMPANY', mandatory: true, numberRequired: true, displayOrder: 8 },
  { code: 'GST_CERTIFICATE', name: 'GST certificate', appliesTo: 'COMPANY', mandatory: false, displayOrder: 9 },
  { code: 'INCORPORATION', name: 'Incorporation certificate', appliesTo: 'COMPANY', mandatory: true, displayOrder: 10 },
  { code: 'OTHER', name: 'Other document', appliesTo: 'BOTH', mandatory: false, displayOrder: 99 },
];

async function seedDefaultTypes({ tenantId }) {
  const existing = await KycDocumentType.countDocuments({ tenantId });
  if (existing) return { created: 0 };
  await KycDocumentType.insertMany(DEFAULT_TYPES.map((t) => ({ ...t, tenantId, isSystem: true, active: true })));
  return { created: DEFAULT_TYPES.length };
}

const typesFor = ({ tenantId, applicantType }) => KycDocumentType.find({
  tenantId,
  active: true,
  ...(applicantType ? { appliesTo: { $in: [applicantType, 'BOTH'] } } : {}),
}).sort({ displayOrder: 1, name: 1 }).lean();

/**
 * §290: the checklist the reviewer and the customer both see — one row per
 * (applicant × document type), each row carrying its live document if there is
 * one. MISSING is a real state here, not an absence of data.
 */
async function checklist({ tenantId, bookingId }) {
  const [applicants, types, documents] = await Promise.all([
    BookingApplicant.find({ tenantId, bookingId }).sort({ displayOrder: 1, createdAt: 1 }).lean(),
    KycDocumentType.find({ tenantId, active: true }).sort({ displayOrder: 1, name: 1 }).lean(),
    BookingKycDocument.find({ tenantId, bookingId, active: true }).lean(),
  ]);

  const byKey = new Map(documents.map((d) => [`${d.bookingApplicantId}:${d.documentTypeId}`, d]));
  const rows = applicants.map((applicant) => {
    const applicable = types.filter((t) => t.appliesTo === 'BOTH' || t.appliesTo === applicant.type);
    const items = applicable.map((type) => {
      const document = byKey.get(`${applicant._id}:${type._id}`) || null;
      return {
        type,
        document,
        status: document ? document.reviewStatus : 'MISSING',
        mandatory: type.mandatory,
      };
    });
    return {
      applicant,
      items,
      missingMandatory: items.filter((i) => i.mandatory && i.status === 'MISSING').length,
      needsResubmission: items.filter((i) => i.status === 'RESUBMISSION_REQUIRED').length,
    };
  });

  const flat = rows.flatMap((r) => r.items);
  const mandatory = flat.filter((i) => i.mandatory);
  return {
    applicants: rows,
    types,
    // §281: completion is only ever shown alongside the status, never instead of it.
    completionPct: mandatory.length
      ? Math.round((mandatory.filter((i) => i.status === 'APPROVED').length / mandatory.length) * 100)
      : 0,
    missingMandatory: mandatory.filter((i) => i.status === 'MISSING'),
    resubmissions: flat.filter((i) => i.status === 'RESUBMISSION_REQUIRED'),
  };
}

/**
 * §127: derive the booking's overall KYC status from its documents, and let
 * `collections.recalcBooking` fold that into `postBookingStatus` (§112) so
 * there is still exactly one writer of the operational status.
 */
async function rollup({ tenantId, bookingId, actor = null, tz = 'UTC' }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  const { applicants, missingMandatory, resubmissions } = await checklist({ tenantId, bookingId });
  const items = applicants.flatMap((a) => a.items);
  const mandatory = items.filter((i) => i.mandatory);
  const present = items.filter((i) => i.status !== 'MISSING');

  let status;
  if (resubmissions.length) status = 'CORRECTION_REQUIRED';
  else if (!present.length) status = 'NOT_STARTED';
  else if (missingMandatory.length) status = 'PARTIAL';
  else if (mandatory.length && mandatory.every((i) => i.status === 'APPROVED')) status = 'VERIFIED';
  else if (items.some((i) => i.status === 'UNDER_REVIEW')) status = 'UNDER_REVIEW';
  else status = 'SUBMITTED';

  // Per-applicant status, same rules on that applicant's own rows.
  for (const row of applicants) {
    const own = row.items;
    const ownMandatory = own.filter((i) => i.mandatory);
    let applicantStatus;
    if (row.needsResubmission) applicantStatus = 'CORRECTION_REQUIRED';
    else if (!own.some((i) => i.status !== 'MISSING')) applicantStatus = 'NOT_STARTED';
    else if (row.missingMandatory) applicantStatus = 'PARTIAL';
    else if (ownMandatory.length && ownMandatory.every((i) => i.status === 'APPROVED')) applicantStatus = 'VERIFIED';
    else if (own.some((i) => i.status === 'UNDER_REVIEW')) applicantStatus = 'UNDER_REVIEW';
    else applicantStatus = 'SUBMITTED';
    if (applicantStatus !== row.applicant.kycStatus) {
      await BookingApplicant.updateOne({ tenantId, _id: row.applicant._id }, { $set: { kycStatus: applicantStatus } });
    }
  }

  if (status === booking.kycStatus) return { status, changed: false };

  await Booking.updateOne({ tenantId, _id: bookingId }, { $set: { kycStatus: status } });
  await require('./collections').recalcBooking({ tenantId, bookingId, tz });

  const titles = {
    SUBMITTED: 'KYC submitted for review',
    UNDER_REVIEW: 'KYC under review',
    CORRECTION_REQUIRED: 'KYC correction required',
    VERIFIED: 'KYC verified',
    PARTIAL: 'KYC partially uploaded',
    NOT_STARTED: 'KYC reset',
  };
  const types = {
    SUBMITTED: 'KYC_SUBMITTED',
    VERIFIED: 'KYC_VERIFIED',
    CORRECTION_REQUIRED: 'KYC_CORRECTION_REQUIRED',
  };
  await timeline.log({
    tenantId,
    bookingId,
    type: types[status] || 'KYC_DOCUMENT_REVIEWED',
    title: titles[status] || `KYC ${status.toLowerCase()}`,
    actor,
    actorType: actor ? 'USER' : 'SYSTEM',
    meta: { from: booking.kycStatus, to: status },
  });

  if (status === 'SUBMITTED') emit(EVENTS.BOOKING_KYC_SUBMITTED, { tenantId, bookingId });
  if (status === 'VERIFIED') emit(EVENTS.BOOKING_KYC_VERIFIED, { tenantId, bookingId });
  if (status === 'CORRECTION_REQUIRED') emit(EVENTS.BOOKING_KYC_CORRECTION_REQUIRED, { tenantId, bookingId });

  // The people who have to act on it: the reviewer queue and the collection owner.
  if (['SUBMITTED', 'CORRECTION_REQUIRED'].includes(status)) {
    const contact = await Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName').lean();
    await notifications.notifyMany({
      tenantId,
      userIds: [booking.collectionOwnerUserId, booking.salespersonId].filter(Boolean),
      domain: 'BOOKING',
      type: `KYC_${status}`,
      title: titles[status],
      body: contact?.displayName,
      link: `/app/bookings/${bookingId}?tab=customer`,
      bookingId,
      severity: status === 'CORRECTION_REQUIRED' ? 'WARNING' : 'INFO',
    });
  }
  return { status, changed: true, from: booking.kycStatus };
}

/**
 * §126: one uploaded document. Same path for a customer upload and an internal
 * one — only `uploadedByType` differs, and only the customer path is reachable
 * without a session.
 */
async function upload({
  tenantId, bookingId, applicantId, documentTypeId, file, documentNumber, expiryDate,
  uploadedByType = 'INTERNAL_USER', actor = null, tz = 'UTC',
}) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  const applicant = await BookingApplicant.findOne({ tenantId, _id: applicantId, bookingId }).lean();
  if (!applicant) throw badRequest('That applicant does not belong to this booking.');
  const type = await KycDocumentType.findOne({ tenantId, _id: documentTypeId, active: true }).lean();
  if (!type) throw badRequest('Choose an active document type.');
  if (type.appliesTo !== 'BOTH' && type.appliesTo !== applicant.type) {
    throw badRequest(`${type.name} does not apply to this applicant.`);
  }
  if (!file?.buffer?.length) throw badRequest('Choose a file to upload.');

  // §193: server-side validation, per document type where it is configured.
  privateFiles.assertAcceptable({
    mimeType: file.mimetype,
    size: file.size,
    allowed: type.allowedMimeTypes?.length ? type.allowedMimeTypes : undefined,
    maxBytes: type.maxBytes || undefined,
  });
  if (type.expiryRequired && !expiryDate) throw badRequest(`${type.name} needs an expiry date.`);
  if (type.numberRequired && !documentNumber) throw badRequest(`${type.name} needs its document number.`);

  const stored = await privateFiles.store({
    tenantId, scope: 'kyc', mimeType: file.mimetype, buffer: file.buffer,
  });

  // §128: the previous version is retired, never overwritten.
  const previous = await BookingKycDocument.findOne({
    tenantId, bookingApplicantId: applicantId, documentTypeId, active: true,
  }).lean();

  const document = await BookingKycDocument.create({
    tenantId,
    bookingId,
    bookingApplicantId: applicantId,
    documentTypeId,
    storageKey: stored.storageKey,
    fileLabel: type.name,
    mimeType: file.mimetype,
    bytes: stored.bytes,
    documentNumberMasked: documentNumber ? privateFiles.maskNumber(documentNumber) : undefined,
    documentNumberSealed: documentNumber ? secretbox.seal(documentNumber) : undefined,
    expiryDate: expiryDate ? new Date(expiryDate) : undefined,
    uploadedByType,
    uploadedByUserId: actor?._id,
    reviewStatus: 'UPLOADED',
  });

  if (previous) {
    await BookingKycDocument.updateOne({ tenantId, _id: previous._id }, {
      $set: { active: false, supersededById: document._id },
    });
  }

  await timeline.log({
    tenantId,
    bookingId,
    type: 'KYC_DOCUMENT_UPLOADED',
    title: `${type.name} uploaded${uploadedByType === 'CUSTOMER' ? ' by the customer' : ''}`,
    body: previous ? 'Replaces an earlier upload.' : undefined,
    actor,
    actorType: uploadedByType === 'CUSTOMER' ? 'INTEGRATION' : 'USER',
    meta: { documentId: String(document._id), applicantId: String(applicantId), replaced: !!previous },
  });
  await rollup({ tenantId, bookingId, actor, tz });
  return document;
}

/** §127/§128: the reviewer's decision on one document. */
async function review({ tenantId, actor, documentId, decision, note, tz = 'UTC' }) {
  const allowed = ['APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED', 'UNDER_REVIEW'];
  if (!allowed.includes(decision)) throw badRequest('Choose a review decision.');
  const document = await BookingKycDocument.findOne({ tenantId, _id: documentId, active: true }).lean();
  if (!document) throw notFound('That document is not the current version.');
  if (decision !== 'APPROVED' && !String(note || '').trim()) {
    // §128: "rejected" with no reason gives the customer nothing to act on.
    throw badRequest('Tell the customer what to fix.');
  }

  await BookingKycDocument.updateOne({ tenantId, _id: document._id }, {
    $set: { reviewStatus: decision, reviewNote: note, reviewedBy: actor?._id, reviewedAt: new Date() },
  });
  const type = await KycDocumentType.findOne({ tenantId, _id: document.documentTypeId }).select('name').lean();
  await timeline.log({
    tenantId,
    bookingId: document.bookingId,
    type: 'KYC_DOCUMENT_REVIEWED',
    title: `${type?.name || 'Document'} — ${decision.replace(/_/g, ' ').toLowerCase()}`,
    body: note,
    actor,
    meta: { documentId: String(document._id), decision },
  });
  await audit.record({
    tenantId, actor, entity: 'BookingKycDocument', entityId: document._id, action: 'REVIEW',
    before: { reviewStatus: document.reviewStatus }, after: { reviewStatus: decision, note },
  });
  const result = await rollup({ tenantId, bookingId: document.bookingId, actor, tz });
  return { document, kycStatus: result.status };
}

/** §131: the audited reveal of a masked document number. */
async function revealNumber({ tenantId, actor, documentId }) {
  const document = await BookingKycDocument.findOne({ tenantId, _id: documentId }).lean();
  if (!document) throw notFound('Document not found.');
  if (!document.documentNumberSealed) return null;
  await audit.record({
    tenantId, actor, entity: 'BookingKycDocument', entityId: document._id, action: 'REVEAL_NUMBER',
  });
  return secretbox.open(document.documentNumberSealed);
}

/* ------------------------------ internal queue ---------------------------- */

const QUEUE_STATUSES = ['NOT_STARTED', 'PARTIAL', 'SUBMITTED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'VERIFIED'];

async function queueScope({ user }) {
  const [sales, collection] = await Promise.all([
    scopeFilter(user, 'booking.view', 'salespersonId'),
    scopeFilter(user, 'collection.view', 'collectionOwnerUserId'),
  ]);
  if (!sales && !collection) return null;
  const narrow = [sales, collection].filter((sc) => sc && Object.keys(sc).length);
  const unrestricted = [sales, collection].some((sc) => sc && !Object.keys(sc).length);
  if (unrestricted) return {};
  return narrow.length > 1 ? { $or: narrow } : narrow[0];
}

/** §129: the review queue. Tiles and list share one filter, as everywhere else. */
async function queue({ tenantId, user, query = {}, page = 1, limit = 25 }) {
  const scope = await queueScope({ user });
  if (!scope) return null;
  const base = { tenantId, ...scope, status: { $ne: 'CANCELLED' }, postBookingInitAt: { $ne: null } };

  const tiles = await Promise.all(QUEUE_STATUSES.map(async (status) => ({
    status,
    label: status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()),
    count: await Booking.countDocuments({ ...base, kycStatus: status }),
  })));

  const filter = { ...base };
  if (QUEUE_STATUSES.includes(query.kycStatus)) filter.kycStatus = query.kycStatus;
  if (query.projectId) filter.projectId = query.projectId;

  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    Booking.find(filter).sort({ bookingDate: -1 }).skip(skip).limit(limit)
      .populate('contactId', 'displayName primaryMobile')
      .populate('projectId', 'name')
      .populate('unitId', 'unitNumber')
      .populate('collectionOwnerUserId', 'name')
      .lean(),
    Booking.countDocuments(filter),
  ]);

  // "Missing documents" is the column reviewers actually work from (§129).
  const withMissing = await Promise.all(items.map(async (booking) => {
    const list = await checklist({ tenantId, bookingId: booking._id });
    return {
      ...booking,
      missingMandatory: list.missingMandatory.map((i) => i.type.name),
      completionPct: list.completionPct,
    };
  }));

  return {
    tiles, items: withMissing, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit,
  };
}

module.exports = {
  DEFAULT_TYPES, QUEUE_STATUSES,
  seedDefaultTypes, typesFor, checklist, rollup, upload, review, revealNumber, queue,
};
