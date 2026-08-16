const { Contact, Tag, Lead } = require('../db/models');
const phone = require('../lib/phone');
const { badRequest, notFound, conflict } = require('../lib/errors');
const audit = require('./audit');

/**
 * Spec §9: the Contact is the master identity. Duplicate detection is by
 * normalized mobile first, with email only as a secondary warning — two
 * different mobiles are never auto-merged just because an email matches (§9.2).
 */

function normalize(payload, callingCode) {
  const normalizedMobile = phone.normalizeMobile(payload.primaryMobile, callingCode);
  if (!normalizedMobile) throw badRequest('Enter a valid mobile number.');

  const normalizedAltMobile = payload.altMobile ? phone.normalizeMobile(payload.altMobile, callingCode) : null;
  if (payload.altMobile && !normalizedAltMobile) throw badRequest('Enter a valid alternate mobile number.');
  // §52.1
  if (normalizedAltMobile && normalizedAltMobile === normalizedMobile) {
    throw badRequest('Alternate mobile must be different from the primary mobile.');
  }
  const email = phone.normalizeEmail(payload.email);
  if (email && !phone.isValidEmail(email)) throw badRequest('Enter a valid email address.');
  const altEmail = phone.normalizeEmail(payload.altEmail);
  if (altEmail && !phone.isValidEmail(altEmail)) throw badRequest('Enter a valid alternate email address.');

  return { normalizedMobile, normalizedAltMobile, email, altEmail };
}

const findByMobile = ({ tenantId, mobile, callingCode }) => {
  const normalized = phone.normalizeMobile(mobile, callingCode);
  return normalized ? Contact.findOne({ tenantId, normalizedMobile: normalized }) : null;
};

/** §9.2: same email, different mobile is a warning the user resolves, not a merge. */
async function possibleDuplicatesByEmail({ tenantId, email, excludeId }) {
  if (!email) return [];
  const filter = { tenantId, email, status: 'ACTIVE' };
  if (excludeId) filter._id = { $ne: excludeId };
  return Contact.find(filter).select('displayName primaryMobile email').lean();
}

async function create({ tenantId, tenant, actor, payload, createdVia = 'MANUAL' }) {
  const norm = normalize(payload, tenant?.callingCode);

  const existing = await Contact.findOne({ tenantId, normalizedMobile: norm.normalizedMobile });
  if (existing) {
    throw conflict('A contact with this mobile number already exists.', { contactId: existing._id });
  }

  const contact = await Contact.create({
    tenantId,
    firstName: payload.firstName,
    lastName: payload.lastName || '',
    primaryMobile: payload.primaryMobile,
    normalizedMobile: norm.normalizedMobile,
    altMobile: payload.altMobile,
    normalizedAltMobile: norm.normalizedAltMobile,
    email: norm.email,
    altEmail: norm.altEmail,
    gender: payload.gender,
    city: payload.city,
    state: payload.state,
    country: payload.country || tenant?.country,
    pincode: payload.pincode,
    address: payload.address,
    tagIds: payload.tagIds || [],
    ownerUserId: payload.ownerUserId || actor?._id,
    createdBy: actor?._id,
    createdVia,
  });

  await audit.record({ tenantId, actor, entity: 'Contact', entityId: contact._id, action: 'CREATE', after: contact.toObject() });
  return contact;
}

/**
 * Capture path (§12.3): reuse the contact when the mobile already exists,
 * enriching blank fields only — an inbound payload never overwrites data a
 * human has already corrected.
 */
async function findOrCreate({ tenantId, tenant, payload, actor, createdVia = 'INTEGRATION' }) {
  const norm = normalize(payload, tenant?.callingCode);
  const existing = await Contact.findOne({ tenantId, normalizedMobile: norm.normalizedMobile });
  if (existing) {
    const enrich = {};
    if (!existing.email && norm.email) enrich.email = norm.email;
    if (!existing.city && payload.city) enrich.city = payload.city;
    if (!existing.lastName && payload.lastName) enrich.lastName = payload.lastName;
    if (Object.keys(enrich).length) {
      Object.assign(existing, enrich);
      await existing.save();
    }
    return { contact: existing, isNew: false };
  }
  const contact = await create({ tenantId, tenant, actor, payload, createdVia });
  return { contact, isNew: true };
}

async function update({ tenantId, tenant, actor, contactId, payload }) {
  const contact = await Contact.findOne({ tenantId, _id: contactId });
  if (!contact) throw notFound('Contact not found.');
  const before = contact.toObject();

  if (payload.primaryMobile) {
    const norm = normalize(payload, tenant?.callingCode);
    if (norm.normalizedMobile !== contact.normalizedMobile) {
      const clash = await Contact.findOne({ tenantId, normalizedMobile: norm.normalizedMobile, _id: { $ne: contact._id } });
      if (clash) throw conflict('Another contact already uses this mobile number.', { contactId: clash._id });
    }
    contact.primaryMobile = payload.primaryMobile;
    contact.normalizedMobile = norm.normalizedMobile;
    contact.altMobile = payload.altMobile;
    contact.normalizedAltMobile = norm.normalizedAltMobile;
    contact.email = norm.email;
    contact.altEmail = norm.altEmail;
  }

  for (const field of ['firstName', 'lastName', 'gender', 'city', 'state', 'country', 'pincode', 'address', 'ownerUserId']) {
    if (payload[field] !== undefined) contact[field] = payload[field];
  }
  if (payload.tagIds) contact.tagIds = payload.tagIds;
  if (payload.displayName !== undefined) contact.displayName = payload.displayName || undefined;
  if (payload.consent) {
    contact.consent = { ...contact.consent?.toObject?.() ?? contact.consent, ...payload.consent, updatedAt: new Date() };
  }
  await contact.save();

  const changes = audit.diff(before, contact.toObject());
  if (changes.changed) {
    await audit.record({ tenantId, actor, entity: 'Contact', entityId: contact._id, action: 'UPDATE', ...changes });
  }
  return contact;
}

/** §37.2 filters + §46 search. Scope filter is supplied by the caller. */
async function list({ tenantId, scope = {}, query = {}, page = 1, limit = 25 }) {
  const filter = { tenantId, status: query.includeArchived ? { $in: ['ACTIVE', 'ARCHIVED'] } : 'ACTIVE', ...scope };

  if (query.q) {
    const term = String(query.q).trim();
    const normalized = phone.normalizeMobile(term);
    filter.$or = [
      { displayName: { $regex: escapeRegex(term), $options: 'i' } },
      { email: { $regex: escapeRegex(term), $options: 'i' } },
      ...(normalized ? [{ normalizedMobile: normalized }, { normalizedAltMobile: normalized }] : []),
      { primaryMobile: { $regex: escapeRegex(term), $options: 'i' } },
    ];
  }
  if (query.tagId) filter.tagIds = query.tagId;
  if (query.city) filter.city = query.city;
  if (query.ownerUserId) filter.ownerUserId = query.ownerUserId;

  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    Contact.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('ownerUserId', 'name').populate('tagIds', 'name').lean(),
    Contact.countDocuments(filter),
  ]);
  return { items, total, page: Number(page), pages: Math.ceil(total / limit) || 1 };
}

async function getWithHistory({ tenantId, contactId }) {
  const contact = await Contact.findOne({ tenantId, _id: contactId })
    .populate('ownerUserId', 'name').populate('tagIds', 'name').lean();
  if (!contact) throw notFound('Contact not found.');
  const leads = await Lead.find({ tenantId, contactId })
    .sort({ latestInquiryAt: -1 })
    .populate('projectId', 'name').populate('stageId', 'name colorToken')
    .populate('ownerUserId', 'name').populate('latestSourceId', 'name')
    .lean();
  return { contact, leads };
}

/** §57: contacts with history are archived, never deleted. */
async function archive({ tenantId, actor, contactId }) {
  const contact = await Contact.findOne({ tenantId, _id: contactId });
  if (!contact) throw notFound('Contact not found.');
  const activeLeads = await Lead.countDocuments({ tenantId, contactId, status: 'ACTIVE' });
  if (activeLeads) throw badRequest('This contact still has active leads. Close or transfer them first.');
  contact.status = 'ARCHIVED';
  await contact.save();
  await audit.record({ tenantId, actor, entity: 'Contact', entityId: contact._id, action: 'ARCHIVE' });
  return contact;
}

/** §9.3: tags are dynamic, tenant-managed, and case-insensitively unique. */
async function upsertTag({ tenantId, actor, name, category }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw badRequest('Enter a tag name.');
  const existing = await Tag.findOne({ tenantId, nameLower: trimmed.toLowerCase() });
  if (existing) {
    if (!existing.active) { existing.active = true; await existing.save(); }
    return existing;
  }
  return Tag.create({ tenantId, name: trimmed, category, createdBy: actor?._id });
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  normalize, findByMobile, possibleDuplicatesByEmail, create, findOrCreate,
  update, list, getWithHistory, archive, upsertTag, escapeRegex,
};
