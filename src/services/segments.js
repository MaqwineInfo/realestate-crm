const {
  Contact, Lead, SavedSegment, Booking, SiteVisit,
} = require('../db/models');
const tz = require('../lib/tz');

/**
 * Spec §37.2/§37.3: the Contact Book audience builder.
 *
 * A segment is a filter, evaluated fresh every time (dynamic). The campaign
 * that sends to it keeps its own recipient snapshot, so "who did we message"
 * stays answerable even after the segment changes.
 */

/**
 * Turns the §37.2 filter set into a contact query. Lead-shaped filters
 * (project, stage, source, purpose, visit, booking) resolve to contact ids
 * first, because the audience is always a list of people.
 */
async function resolveContactFilter({ tenantId, filters = {}, zone = 'UTC' }) {
  const contactFilter = { tenantId, status: 'ACTIVE' };

  if (filters.tagId) contactFilter.tagIds = filters.tagId;
  if (filters.city) contactFilter.city = new RegExp(`^${escapeRegex(filters.city)}$`, 'i');
  if (filters.ownerUserId) contactFilter.ownerUserId = filters.ownerUserId;
  if (filters.createdFrom || filters.createdTo) {
    contactFilter.createdAt = {};
    if (filters.createdFrom) contactFilter.createdAt.$gte = tz.fromLocalInput(filters.createdFrom, '00:00', zone);
    if (filters.createdTo) contactFilter.createdAt.$lte = tz.fromLocalInput(filters.createdTo, '23:59', zone);
  }
  if (filters.lastActivityWithinDays) {
    contactFilter.lastActivityAt = { $gte: tz.addLocalDays(new Date(), -Number(filters.lastActivityWithinDays), zone) };
  }

  const leadFilter = { tenantId };
  let needsLeadLookup = false;
  for (const [key, field] of [
    ['projectId', 'projectId'], ['stageId', 'stageId'], ['sourceId', 'latestSourceId'],
    ['campaignId', 'campaignId'], ['purpose', 'purpose'], ['leadStatus', 'status'],
  ]) {
    if (filters[key]) { leadFilter[field] = filters[key]; needsLeadLookup = true; }
  }

  let contactIds = null;
  if (needsLeadLookup) {
    const leads = await Lead.find(leadFilter).select('contactId').lean();
    contactIds = new Set(leads.map((l) => String(l.contactId)));
  }

  if (filters.hasVisited === '1') {
    const visits = await SiteVisit.find({ tenantId, status: 'COMPLETED' }).select('contactId').lean();
    contactIds = intersect(contactIds, visits.map((v) => String(v.contactId)));
  }
  if (filters.hasBooked === '1') {
    const bookings = await Booking.find({ tenantId, status: { $ne: 'CANCELLED' } }).select('contactId').lean();
    contactIds = intersect(contactIds, bookings.map((b) => String(b.contactId)));
  }

  if (contactIds) contactFilter._id = { $in: [...contactIds] };
  return contactFilter;
}

function intersect(current, incoming) {
  const next = new Set(incoming);
  if (!current) return next;
  return new Set([...current].filter((id) => next.has(id)));
}

/** §38.1 step 5: the recipient count shown before anyone presses send. */
async function count({ tenantId, filters, zone }) {
  const filter = await resolveContactFilter({ tenantId, filters, zone });
  return Contact.countDocuments(filter);
}

async function preview({ tenantId, filters, zone, limit = 25 }) {
  const filter = await resolveContactFilter({ tenantId, filters, zone });
  const [items, total] = await Promise.all([
    Contact.find(filter).sort({ createdAt: -1 }).limit(limit)
      .select('displayName primaryMobile normalizedMobile email consent city').lean(),
    Contact.countDocuments(filter),
  ]);
  return { items, total };
}

/** The full audience, used at send time. */
async function recipients({ tenantId, filters, zone, limit = 5000 }) {
  const filter = await resolveContactFilter({ tenantId, filters, zone });
  return Contact.find(filter).limit(limit).lean();
}

const list = ({ tenantId }) => SavedSegment.find({ tenantId, active: true }).sort({ name: 1 }).lean();

const save = ({ tenantId, actor, name, description, filters }) => SavedSegment.findOneAndUpdate(
  { tenantId, name },
  { tenantId, name, description, filters, createdBy: actor?._id, active: true },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
);

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { resolveContactFilter, count, preview, recipients, list, save };
