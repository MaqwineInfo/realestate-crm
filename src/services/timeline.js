const { Activity, Lead, Contact } = require('../db/models');

/**
 * Spec §21: every meaningful event lands on one chronological timeline.
 * Services call log() rather than writing Activity documents directly, so the
 * lead/contact "last activity" denormalisation can never drift.
 */
async function log({
  tenantId, leadId, contactId, bookingId, channelPartnerId, type, title, body, meta,
  actor, actorType = 'USER', at = new Date(), mentionUserIds, attachments, editable = false,
}) {
  const activity = await Activity.create({
    tenantId,
    leadId,
    contactId,
    bookingId,
    channelPartnerId,
    type,
    title,
    body,
    meta: meta || {},
    actorType: actor ? actorType : (actorType === 'USER' ? 'SYSTEM' : actorType),
    actorUserId: actor?._id,
    actorLabel: actor?.name || (actorType === 'USER' ? undefined : 'System'),
    at,
    mentionUserIds,
    attachments,
    editable,
  });

  if (leadId) {
    await Lead.updateOne({ tenantId, _id: leadId }, { $set: { lastActivityAt: at } });
  }
  if (contactId) {
    await Contact.updateOne({ tenantId, _id: contactId }, { $set: { lastActivityAt: at } });
  }
  return activity;
}

/**
 * V2 §162/§189: the post-booking timeline. Deliberately a different read from
 * `forLead` — the sales story and the collection story are shown separately,
 * even though they share one append-only collection.
 */
async function forBooking({ tenantId, bookingId, limit = 50, before }) {
  const filter = { tenantId, bookingId };
  if (before) filter.at = { $lt: new Date(before) };
  return Activity.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .populate('actorUserId', 'name')
    .lean();
}

/**
 * V2 §189: the channel-partner timeline — registration, compliance, claims and
 * commission. A third anchor on the same append-only collection.
 */
async function forPartner({ tenantId, channelPartnerId, limit = 60, before }) {
  const filter = { tenantId, channelPartnerId };
  if (before) filter.at = { $lt: new Date(before) };
  return Activity.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .populate('actorUserId', 'name')
    .lean();
}

/** Newest-first page of a lead's timeline. */
async function forLead({ tenantId, leadId, limit = 50, before }) {
  const filter = { tenantId, leadId };
  if (before) filter.at = { $lt: new Date(before) };
  return Activity.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(limit)
    .populate('actorUserId', 'name')
    .lean();
}

/**
 * Spec §22: internal notes with @mentions. No separate chat module — a mention
 * is a timeline note plus a notification with a deep link back to the lead.
 */
async function addNote({ tenantId, leadId, contactId, actor, body, mentionUserIds = [] }) {
  const activity = await log({
    tenantId, leadId, contactId, type: 'NOTE_ADDED',
    title: 'Note added', body, actor, editable: true,
    mentionUserIds,
  });

  if (mentionUserIds.length) {
    const { EVENTS, emit } = require('../lib/events');
    emit(EVENTS.USER_MENTIONED, {
      tenantId, leadId, mentionUserIds, byName: actor?.name || 'Someone',
      snippet: String(body).slice(0, 140),
    });
  }
  return activity;
}

/**
 * Resolves "@Name" text to real users. Matching whole names against the note is
 * exact where a regex would have to guess where a multi-word name ends.
 * ponytail: loads the tenant's active users; fine at CRM team sizes.
 */
async function resolveMentions({ tenantId, body }) {
  const text = String(body || '');
  if (!text.includes('@')) return [];
  const { User } = require('../db/models');
  const users = await User.find({ tenantId, status: 'ACTIVE' }).select('_id name').lean();
  const haystack = text.toLowerCase();
  return users
    .filter((u) => u.name && haystack.includes(`@${u.name.toLowerCase()}`))
    .map((u) => u._id);
}

module.exports = { log, forLead, addNote, resolveMentions, forBooking, forPartner };
