const { Lead, Contact, Followup, InquiryTouch, Stage, User } = require('../db/models');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const { canActOn } = require('../lib/access');
const tzLib = require('../lib/tz');
const audit = require('./audit');
const timeline = require('./timeline');
const stagesService = require('./stages');
const stageHistory = require('./stageHistory');
const contactsService = require('./contacts');

/** Fields a user may edit directly. Everything else moves through an action (§80). */
const EDITABLE_FIELDS = [
  'budgetMinMinor', 'budgetMaxMinor', 'preferredConfigurations', 'preferredFacing',
  'preferredFacings', 'preferredFloorMin', 'preferredFloorMax', 'areaMin', 'areaMax',
  'areaBasis', 'purpose', 'preferredLocation', 'requirementNote', 'priority', 'projectId',
  // V1.1 §10.1 qualification
  'possessionPreference', 'purchaseTimeline', 'fundingType', 'loanStatus', 'decisionMaker',
];

/**
 * Spec §10 + §12.3. Creates the lead, its first inquiry touch and the timeline
 * entry, and starts the SLA clock. Source history is written once and never
 * overwritten afterwards (§41).
 */
async function create({ tenantId, tenant, actor, data, createdVia = 'MANUAL' }) {
  let contact;
  if (data.contactId) {
    contact = await Contact.findOne({ tenantId, _id: data.contactId });
    if (!contact) throw notFound('Contact not found.');
  } else {
    const result = await contactsService.findOrCreate({
      tenantId, tenant, actor, createdVia, payload: data,
    });
    contact = result.contact;
  }

  const newStage = await stagesService.bySemantic({ tenantId, semanticType: 'NEW' });
  if (!newStage) throw badRequest('No "New Lead" stage is configured. Add one in Setup → Stages.');
  if (!data.sourceId) throw badRequest('Select a lead source.');

  const now = data.capturedAt ? new Date(data.capturedAt) : new Date();
  const ownerUserId = data.ownerUserId || null;

  const lead = await Lead.create({
    tenantId,
    contactId: contact._id,
    projectId: data.projectId || undefined,
    ownerUserId: ownerUserId || undefined,
    stageId: newStage._id,
    status: 'ACTIVE',
    sourceId: data.sourceId,
    originalSourceId: data.sourceId,
    latestSourceId: data.sourceId,
    sourceDetail: data.sourceDetail,
    campaignId: data.campaignId || undefined,
    firstTouchCampaignId: data.campaignId || undefined,
    lastTouchCampaignId: data.campaignId || undefined,
    adSetExternalId: data.adSetExternalId,
    adExternalId: data.adExternalId,
    firstInquiryAt: now,
    latestInquiryAt: now,
    capturedAt: now,
    assignedAt: ownerUserId ? now : undefined,
    slaStatus: 'PENDING',
    budgetMinMinor: data.budgetMinMinor,
    budgetMaxMinor: data.budgetMaxMinor,
    preferredConfigurations: data.preferredConfigurations || [],
    preferredFacings: data.preferredFacings || [],
    preferredFloorMin: data.preferredFloorMin,
    preferredFloorMax: data.preferredFloorMax,
    areaMin: data.areaMin,
    areaMax: data.areaMax,
    areaBasis: data.areaBasis,
    purpose: data.purpose,
    preferredLocation: data.preferredLocation,
    requirementNote: data.requirementNote,
    // V1.1 §10.1
    possessionPreference: data.possessionPreference,
    purchaseTimeline: data.purchaseTimeline,
    fundingType: data.fundingType,
    loanStatus: data.loanStatus,
    decisionMaker: data.decisionMaker,
    // V1.1 §9.1/§9.2
    referrerName: data.referrerName,
    referrerMobile: data.referrerMobile,
    referrerContactId: data.referrerContactId,
    portalLeadId: data.portalLeadId,
    listingReference: data.listingReference,
    relatedPreviousLeadId: data.relatedPreviousLeadId,
    createdBy: actor?._id,
    createdVia,
  });

  // V1.1 §18: the journey starts here, so the funnel can tell "went through New"
  // from "New simply sorts first".
  await stageHistory.record({
    tenantId, leadId: lead._id, stageId: newStage._id, actor, sourceAction: 'CAPTURE', at: now,
  });

  await InquiryTouch.create({
    tenantId,
    contactId: contact._id,
    leadId: lead._id,
    projectId: data.projectId || undefined,
    sourceId: data.sourceId,
    sourceDetail: data.sourceDetail,
    campaignId: data.campaignId || undefined,
    externalCampaignId: data.externalCampaignId,
    adSetExternalId: data.adSetExternalId,
    adExternalId: data.adExternalId,
    formExternalId: data.formExternalId,
    at: now,
    isFirstTouch: true,
    landingUrl: data.landingUrl,
    utm: data.utm,
    message: data.message,
    webhookEventId: data.webhookEventId,
  });

  await Contact.updateOne(
    { tenantId, _id: contact._id },
    { $inc: { inquiryCount: 1 }, $set: { lastInquiryAt: now } },
  );

  await timeline.log({
    tenantId, leadId: lead._id, contactId: contact._id, type: 'LEAD_CREATED',
    title: 'Lead created', actor, actorType: actor ? 'USER' : 'SYSTEM', at: now,
    meta: { via: createdVia, sourceId: String(data.sourceId) },
  });

  emit(EVENTS.LEAD_CREATED, { tenantId, lead, contact });

  if (ownerUserId) {
    await recordAssignment({ tenantId, lead, ownerUserId, contact, actor, reason: 'INITIAL' });
  }

  await audit.record({ tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'CREATE', after: { contactId: contact._id, sourceId: data.sourceId } });
  return { lead, contact };
}

/** Shared by manual assignment, round robin and SLA auto-reassignment. */
async function recordAssignment({ tenantId, lead, ownerUserId, contact, actor, reason = 'ASSIGNED' }) {
  const at = new Date();
  await Lead.updateOne(
    { tenantId, _id: lead._id },
    { $set: { ownerUserId, assignedAt: at, slaStatus: 'PENDING' } },
  );
  const named = contact || await Contact.findOne({ tenantId, _id: lead.contactId }).select('displayName').lean();
  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'LEAD_ASSIGNED',
    title: 'Lead assigned', actor, actorType: actor ? 'USER' : 'SYSTEM', at,
    meta: { ownerUserId: String(ownerUserId), reason },
  });
  emit(EVENTS.LEAD_ASSIGNED, {
    tenantId, lead, ownerUserId, contactName: named?.displayName || 'A customer', reason,
  });
}

/**
 * §16.2 / §55.3: the SLA stops only on a genuine action. This is called from
 * the follow-up completion path, which has already guaranteed that a next
 * action exists — clicking a phone icon never reaches here.
 */
async function recordFirstGenuineAction({ tenantId, lead, at = new Date() }) {
  if (lead.firstGenuineActionAt) return lead;
  const base = lead.assignedAt || lead.capturedAt;
  const seconds = Math.max(0, Math.round((at.getTime() - new Date(base).getTime()) / 1000));
  const target = lead.slaTargetSeconds;
  // A lead that already breached stays breached even if a later owner answers
  // quickly — the reassignment restarts the clock, not the history (§16.5).
  const withinSla = (!target || seconds <= target) && !lead.slaBreached;

  await Lead.updateOne({ tenantId, _id: lead._id }, {
    $set: {
      firstGenuineActionAt: at,
      firstResponseSeconds: seconds,
      slaStatus: withinSla ? 'WITHIN_SLA' : 'BREACHED',
      slaBreached: !withinSla,
      ...(withinSla ? {} : { slaBreachSeconds: seconds - target }),
    },
  });
  emit(EVENTS.LEAD_FIRST_ACTION_COMPLETED, { tenantId, leadId: lead._id, seconds, withinSla });
  return { ...lead, firstGenuineActionAt: at, firstResponseSeconds: seconds };
}

/** §7/§70 lead list: search, filters, sort, pagination — all server-side. */
async function list({ tenantId, scope, query = {}, page = 1, limit = 25, tz = 'UTC' }) {
  if (!scope) throw forbidden('You do not have permission to view leads.');
  const filter = { tenantId, archived: { $ne: true }, ...scope };

  if (query.stageId) filter.stageId = query.stageId;
  // V1.1 §77: the sub-stage filter is meaningless without its parent, so the UI
  // keeps it disabled until a stage is chosen and the query mirrors that.
  if (query.subStageId && query.stageId) filter.subStageId = query.subStageId;
  if (query.temperature) filter.temperature = query.temperature;
  if (query.projectId) filter.projectId = query.projectId;
  if (query.ownerUserId) filter.ownerUserId = query.ownerUserId;
  if (query.sourceId) filter.latestSourceId = query.sourceId;
  if (query.priority) filter.priority = query.priority;
  if (query.slaStatus) filter.slaStatus = query.slaStatus;
  if (query.status) filter.status = query.status;
  if (query.purpose) filter.purpose = query.purpose;
  if (query.unassigned === '1') filter.ownerUserId = null;

  if (query.from || query.to) {
    filter.latestInquiryAt = {};
    if (query.from) filter.latestInquiryAt.$gte = tzLib.fromLocalInput(query.from, '00:00', tz);
    if (query.to) filter.latestInquiryAt.$lte = tzLib.fromLocalInput(query.to, '23:59', tz);
  }

  if (query.q) {
    const contactIds = await matchingContactIds({ tenantId, term: query.q });
    filter.contactId = { $in: contactIds };
  }

  const sort = { [query.sortBy || 'latestInquiryAt']: query.sortDir === 'asc' ? 1 : -1 };
  const skip = (Math.max(1, Number(page)) - 1) * limit;

  const [items, total] = await Promise.all([
    Lead.find(filter).sort(sort).skip(skip).limit(limit)
      .populate('contactId', 'displayName primaryMobile normalizedMobile email city')
      .populate('projectId', 'name')
      .populate('stageId', 'name colorToken semanticType terminal')
      .populate('subStageId', 'name')
      .populate('ownerUserId', 'name')
      .populate('latestSourceId', 'name category')
      .populate('nextActionTypeId', 'name semantic')
      .lean(),
    Lead.countDocuments(filter),
  ]);
  return { items, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit };
}

async function matchingContactIds({ tenantId, term }) {
  const contacts = await contactsService.list({ tenantId, query: { q: term }, limit: 200 });
  return contacts.items.map((c) => c._id);
}

async function get({ tenantId, leadId }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId })
    .populate('contactId')
    .populate('projectId', 'name city status')
    .populate('stageId')
    .populate('subStageId', 'name')
    .populate('ownerUserId', 'name email mobile')
    .populate('sourceId', 'name category')
    .populate('originalSourceId', 'name category')
    .populate('latestSourceId', 'name category')
    .populate('nextActionTypeId', 'name semantic')
    .lean();
  if (!lead) throw notFound('Lead not found.');
  return lead;
}

/** Permission + data-scope check for a single lead (§6.3). */
async function assertCanView(user, lead) {
  const allowed = await canActOn(user, 'lead.view', lead.ownerUserId?._id || lead.ownerUserId);
  // Unassigned leads are visible to anyone who can see beyond their own book.
  if (!allowed && lead.ownerUserId) throw notFound('Lead not found.');
  if (!allowed && !lead.ownerUserId) {
    const { scopeOf } = require('../lib/access');
    if (scopeOf(user, 'lead.view') === 'own') throw notFound('Lead not found.');
  }
}

async function updateDetails({ tenantId, actor, leadId, payload }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId });
  if (!lead) throw notFound('Lead not found.');
  const before = lead.toObject();

  for (const field of EDITABLE_FIELDS) {
    if (payload[field] !== undefined) lead[field] = payload[field];
  }
  if (lead.budgetMinMinor != null && lead.budgetMaxMinor != null && lead.budgetMaxMinor < lead.budgetMinMinor) {
    throw badRequest('Maximum budget cannot be lower than the minimum budget.');
  }
  await lead.save();

  const changes = audit.diff(before, lead.toObject(), EDITABLE_FIELDS);
  if (changes.changed) {
    await audit.record({ tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'UPDATE', ...changes });
  }
  return lead;
}

/**
 * §83: Booked and Block Unit are reached through the booking/block actions, not
 * a stage dropdown, or stage and inventory drift apart. `viaAction` is passed
 * only by those services.
 */
async function changeStage({
  tenantId, actor, leadId, stageId, subStageId, note, lostNote,
  viaAction = false, sourceAction = 'MANUAL_OUTCOME', at = new Date(),
}) {
  const lead = await Lead.findOne({ tenantId, _id: leadId });
  if (!lead) throw notFound('Lead not found.');

  const stage = await stagesService.requireStage({ tenantId, stageId });
  if (String(stage._id) !== String(lead.stageId)) stagesService.assertSelectable(stage);

  if (!viaAction && ['BOOKED', 'BLOCKED'].includes(stage.semanticType)) {
    throw badRequest(stage.semanticType === 'BOOKED'
      ? 'Bookings are recorded through the Booking action so inventory stays in step.'
      : 'Units move to Block Unit through the Block action so inventory stays in step.');
  }

  const subStage = await stagesService.validateStagePair({ tenantId, stage, subStageId });

  // §82: a lost lead needs a reason.
  if (stage.semanticType === 'LOST' && !subStage) {
    throw badRequest('Select a lost reason.');
  }

  const previousStageId = lead.stageId;
  lead.stageId = stage._id;
  lead.subStageId = subStage?._id;
  lead.status = stage.terminal ? 'TERMINAL' : 'ACTIVE';

  if (stage.semanticType === 'LOST') {
    lead.lostAt = at;
    lead.lostReasonSubStageId = subStage?._id;
    lead.lostNote = lostNote || note;
  }
  await lead.save();

  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId,
    type: stage.semanticType === 'LOST' ? 'LEAD_LOST' : 'STAGE_CHANGED',
    title: stage.semanticType === 'LOST' ? `Marked lost — ${subStage?.name || ''}`.trim() : `Stage changed to ${stage.name}`,
    body: note || lostNote,
    actor, at,
    meta: { fromStageId: String(previousStageId), toStageId: String(stage._id), subStage: subStage?.name },
  });

  // V1.1 §18: record the transition so the funnel reflects the real journey.
  await stageHistory.record({
    tenantId, leadId: lead._id, stageId: stage._id, subStageId: subStage?._id,
    actor, sourceAction, note: note || lostNote, at,
  });

  // §82: no future follow-ups survive a terminal stage.
  if (stage.terminal) await cancelPendingFollowups({ tenantId, leadId: lead._id, reason: `Lead ${stage.name}` });

  emit(EVENTS.LEAD_STAGE_CHANGED, { tenantId, lead, stage, previousStageId });
  await audit.record({
    tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'STAGE_CHANGE',
    before: { stageId: previousStageId }, after: { stageId: stage._id, subStageId: subStage?._id },
  });
  return lead;
}

async function cancelPendingFollowups({ tenantId, leadId, reason }) {
  await Followup.updateMany(
    { tenantId, leadId, status: 'PENDING' },
    { $set: { status: 'CANCELLED', cancelledReason: reason } },
  );
  await Lead.updateOne({ tenantId, _id: leadId }, { $unset: { nextFollowupId: '', nextActionAt: '', nextActionTypeId: '' } });
}

/** §15: transfer keeps the entire history attached to the lead. */
async function transfer({ tenantId, actor, leadId, toUserId, reason, note }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId });
  if (!lead) throw notFound('Lead not found.');

  const toUser = await User.findOne({ tenantId, _id: toUserId }).lean();
  if (!toUser) throw notFound('That user could not be found.');
  if (toUser.status !== 'ACTIVE') throw badRequest('Leads can only be transferred to an active user.');
  if (String(lead.ownerUserId || '') === String(toUserId)) throw badRequest('That user already owns this lead.');

  const fromUser = lead.ownerUserId ? await User.findOne({ tenantId, _id: lead.ownerUserId }).lean() : null;
  lead.previousOwnerUserId = lead.ownerUserId;
  lead.ownerUserId = toUser._id;
  await lead.save();

  // Pending follow-ups follow the lead unless they were deliberately delegated.
  await Followup.updateMany(
    { tenantId, leadId: lead._id, status: 'PENDING', assignedUserId: fromUser?._id },
    { $set: { assignedUserId: toUser._id } },
  );

  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'LEAD_TRANSFERRED',
    title: `Lead transferred from ${fromUser?.name || 'Unassigned'} to ${toUser.name} by ${actor?.name || 'System'}`,
    body: note,
    actor,
    meta: { fromUserId: fromUser?._id ? String(fromUser._id) : null, toUserId: String(toUser._id), reason },
  });
  emit(EVENTS.LEAD_ASSIGNED, {
    tenantId, lead, ownerUserId: toUser._id, contactName: (await Contact.findOne({ tenantId, _id: lead.contactId }).select('displayName').lean())?.displayName, reason: 'TRANSFER',
  });
  await audit.record({
    tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'TRANSFER',
    before: { ownerUserId: fromUser?._id }, after: { ownerUserId: toUser._id, reason, note },
  });
  return lead;
}

/**
 * §81 + V1.1 §84: reopen a lost lead, preserving the lost history.
 *
 * V1.1 folds the next action into the same flow, because a reopened lead is an
 * active lead and an active lead needs one. When `next` is supplied it is
 * validated and created here, so the reopen cannot leave the gap the rest of the
 * product spends its time preventing.
 */
async function reopen({ tenantId, actor, leadId, stageId, ownerUserId, reason, next, tz }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId });
  if (!lead) throw notFound('Lead not found.');
  if (lead.status !== 'TERMINAL') throw badRequest('This lead is already active.');
  if (lead.bookedAt) throw badRequest('A booked lead cannot be reopened. Create a new inquiry instead.');

  const stage = await stagesService.requireStage({ tenantId, stageId });
  stagesService.assertSelectable(stage);
  if (stage.terminal) throw badRequest('Choose an active stage to reopen into.');

  lead.stageId = stage._id;
  lead.subStageId = undefined;
  lead.status = 'ACTIVE';
  if (ownerUserId) lead.ownerUserId = ownerUserId;
  await lead.save();

  await stageHistory.record({
    tenantId, leadId: lead._id, stageId: stage._id, actor, sourceAction: 'REOPEN', note: reason,
  });

  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'LEAD_REOPENED',
    title: `Lead reopened into ${stage.name}`, body: reason, actor,
    meta: { previousLostAt: lead.lostAt, reason },
  });
  // §84: the reopened lead leaves with its next action already scheduled.
  if (next?.actionTypeId) {
    const followupsService = require('./followups');
    const dueAt = followupsService.resolveNextDueAt({ next, tz: tz || 'UTC' });
    await followupsService.create({
      tenantId,
      actor,
      leadId: lead._id,
      actionTypeId: next.actionTypeId,
      dueAt,
      note: next.note,
    });
  }

  await audit.record({ tenantId, actor, entity: 'Lead', entityId: lead._id, action: 'REOPEN', after: { stageId: stage._id, reason } });
  return lead;
}

/** Work-queue counts and lists live in services/dashboard; this is the raw guard. */
const isActive = (lead) => lead.status === 'ACTIVE';

module.exports = {
  EDITABLE_FIELDS, create, recordAssignment, recordFirstGenuineAction, list, get,
  assertCanView, updateDetails, changeStage, cancelPendingFollowups, transfer, reopen, isActive,
};
