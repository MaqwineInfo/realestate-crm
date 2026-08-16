const { Followup, Lead, ActionType, User } = require('../db/models');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const tzLib = require('../lib/tz');
const timeline = require('./timeline');
const stagesService = require('./stages');
const leadsService = require('./leads');
const audit = require('./audit');

/**
 * Spec §18 — the heart of the CRM, and the single place the non-negotiable rule
 * lives (§55.1, §55.2, §18.3):
 *
 *   an active lead may never end an interaction without a future next action.
 *
 * Every path that closes a piece of work — completing a follow-up, logging a
 * first call, completing a site visit — goes through `applyOutcome()` below, so
 * the rule cannot be sidestepped by adding a new route.
 */

/** Timeline event that matches the kind of interaction that was logged. */
const ACTIVITY_FOR_SEMANTIC = {
  CALL: 'CALL_COMPLETED',
  WHATSAPP: 'WHATSAPP_SENT',
  EMAIL: 'EMAIL_SENT',
  SITE_VISIT: 'VISIT_COMPLETED',
  MEETING: 'NOTE_ADDED',
  VIDEO_CALL: 'NOTE_ADDED',
  COST_SHEET: 'NOTE_ADDED',
  BROCHURE: 'NOTE_ADDED',
  OTHER: 'NOTE_ADDED',
};

/** Resolves the next-action fields a drawer submitted into a due timestamp. */
function resolveNextDueAt({ next, tz, now = new Date() }) {
  if (!next) return null;
  if (next.dueAt) return new Date(next.dueAt);
  if (!next.date) return null;
  return tzLib.fromLocalInput(next.date, next.time || '09:00', tz);
}

/**
 * The gate. Given the stage a lead will be in after this interaction, decide
 * whether a next action is required and validate the one that was supplied.
 * Returns the validated next-action spec, or null when the lead is closing.
 */
async function requireNextAction({ tenantId, resultingStage, next, tz, now = new Date() }) {
  const terminal = resultingStage.terminal;
  if (terminal) return null; // §11.5 / §113: closing a lead needs no next action.

  if (!next || !next.actionTypeId) {
    throw badRequest('Set the next action before saving — an active lead cannot be left without one.');
  }
  const actionType = await ActionType.findOne({ tenantId, _id: next.actionTypeId, active: true }).lean();
  if (!actionType) throw badRequest('Choose an active next action type.');

  const dueAt = resolveNextDueAt({ next, tz, now });
  if (!dueAt || Number.isNaN(dueAt.getTime())) throw badRequest('Set the date and time for the next action.');
  // §18.6: a newly created next action must be in the future.
  if (dueAt.getTime() <= now.getTime() - 60000) {
    throw badRequest('The next action must be scheduled in the future.');
  }
  return { actionTypeId: actionType._id, actionType, dueAt, note: next.note, assignedUserId: next.assignedUserId };
}

/** Keeps the lead's denormalised next-action fields in step with reality. */
async function syncLeadNextAction({ tenantId, leadId }) {
  const upcoming = await Followup.findOne({ tenantId, leadId, status: 'PENDING' })
    .sort({ dueAt: 1 }).lean();
  if (upcoming) {
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $set: {
        nextFollowupId: upcoming._id,
        nextActionAt: upcoming.dueAt,
        nextActionTypeId: upcoming.actionTypeId,
      },
    });
  } else {
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $unset: { nextFollowupId: '', nextActionAt: '', nextActionTypeId: '' },
    });
  }
  return upcoming || null;
}

/** §18.1: schedule a follow-up. Used by drawers and by automation. */
async function create({
  tenantId, actor, leadId, actionTypeId, dueAt, assignedUserId, note, priority = 'NORMAL',
  siteVisitId, createdVia = 'MANUAL', allowPast = false, silent = false,
}) {
  const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
  if (!lead) throw notFound('Lead not found.');
  // §18.6: a terminal lead does not take new follow-ups; reopen it first.
  if (lead.status === 'TERMINAL') {
    throw badRequest('This lead is closed. Reopen it before scheduling a follow-up.');
  }
  const actionType = await ActionType.findOne({ tenantId, _id: actionTypeId, active: true }).lean();
  if (!actionType) throw badRequest('Choose an active action type.');

  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('Set the date and time for the follow-up.');
  if (!allowPast && due.getTime() <= Date.now() - 60000) {
    throw badRequest('The next action must be scheduled in the future.');
  }

  const owner = assignedUserId || lead.ownerUserId;
  if (!owner) throw badRequest('Assign an owner to this lead before scheduling work on it.');
  if (assignedUserId && String(assignedUserId) !== String(lead.ownerUserId)) {
    // §102: a follow-up may sit with someone else, but only a real active user.
    const target = await User.findOne({ tenantId, _id: assignedUserId, status: 'ACTIVE' }).lean();
    if (!target) throw badRequest('Follow-ups can only be assigned to an active user.');
  }

  const followup = await Followup.create({
    tenantId,
    leadId: lead._id,
    contactId: lead.contactId,
    actionTypeId: actionType._id,
    dueAt: due,
    assignedUserId: owner,
    note,
    priority,
    siteVisitId,
    createdBy: actor?._id,
    createdVia,
  });

  if (!silent) {
    await timeline.log({
      tenantId, leadId: lead._id, contactId: lead.contactId, type: 'FOLLOWUP_CREATED',
      title: `${actionType.name} scheduled`,
      body: note,
      actor,
      meta: { followupId: String(followup._id), dueAt: due, actionType: actionType.name },
    });
  }
  await syncLeadNextAction({ tenantId, leadId: lead._id });
  emit(EVENTS.FOLLOWUP_CREATED, { tenantId, leadId: lead._id, followup });
  return followup;
}

/**
 * Shared outcome handler for every "I did the thing, here is what happened"
 * flow (§18.4 complete follow-up, §114 first action, §24.3 visit completion).
 *
 * Ordering matters because a standalone mongod has no transactions (§87):
 * the next action is validated before anything is written and created before
 * the current work is closed, so an interrupted run can only ever leave an
 * extra pending follow-up — never an attended active lead without one.
 */
async function applyOutcome({
  tenantId, tenant, actor, lead, followup, actionTypeId, subStageId, stageId,
  note, next, tz, interactionTitle, now = new Date(), skipInteractionActivity = false,
  sourceAction,
}) {
  if (lead.status === 'TERMINAL') throw badRequest('This lead is already closed.');

  // 1. Work out where the lead ends up, and validate the pair (§52.2).
  const currentStage = await stagesService.requireStage({ tenantId, stageId: lead.stageId });
  let resultingStage = currentStage;
  let resolvedSubStageId = subStageId;

  if (stageId && String(stageId) !== String(lead.stageId)) {
    resultingStage = await stagesService.requireStage({ tenantId, stageId });
    stagesService.assertSelectable(resultingStage);
    // §83: booking and blocking own those stages.
    if (['BOOKED', 'BLOCKED'].includes(resultingStage.semanticType)) {
      throw badRequest(resultingStage.semanticType === 'BOOKED'
        ? 'Bookings are recorded through the Booking action so inventory stays in step.'
        : 'Units move to Block Unit through the Block action so inventory stays in step.');
    }
  }
  const subStage = await stagesService.validateStagePair({
    tenantId, stage: resultingStage, subStageId: resolvedSubStageId,
  });
  resolvedSubStageId = subStage?._id;
  if (resultingStage.semanticType === 'LOST' && !subStage) throw badRequest('Select a lost reason.');

  // 2. The gate: an active lead must have its next action, validated up front.
  const validatedNext = await requireNextAction({ tenantId, resultingStage, next, tz, now });

  // 3. Write the next action first (§87 saga ordering).
  let nextFollowup = null;
  if (validatedNext) {
    nextFollowup = await Followup.create({
      tenantId,
      leadId: lead._id,
      contactId: lead.contactId,
      actionTypeId: validatedNext.actionTypeId,
      dueAt: validatedNext.dueAt,
      assignedUserId: validatedNext.assignedUserId || lead.ownerUserId,
      note: validatedNext.note,
      createdBy: actor?._id,
    });
  }

  // 4. Close the current piece of work.
  if (followup) {
    await Followup.updateOne({ tenantId, _id: followup._id }, {
      $set: {
        status: 'COMPLETED',
        completedAt: now,
        completedBy: actor?._id,
        completionNote: note,
        completionSubStageId: resolvedSubStageId,
        completionOutcome: subStage?.name,
        completedOnTime: now <= new Date(followup.dueAt),
        nextFollowupId: nextFollowup?._id,
      },
    });
  }

  // 5. Timeline: the interaction, then the outcome.
  if (!skipInteractionActivity) {
    const actionType = actionTypeId
      ? await ActionType.findOne({ tenantId, _id: actionTypeId }).lean()
      : (followup ? await ActionType.findOne({ tenantId, _id: followup.actionTypeId }).lean() : null);
    await timeline.log({
      tenantId,
      leadId: lead._id,
      contactId: lead.contactId,
      type: ACTIVITY_FOR_SEMANTIC[actionType?.semantic] || 'NOTE_ADDED',
      title: interactionTitle
        || `${actionType?.name || 'Interaction'} completed${subStage ? ` — ${subStage.name}` : ''}`,
      body: note,
      actor,
      at: now,
      meta: {
        followupId: followup ? String(followup._id) : undefined,
        outcome: subStage?.name,
        actionType: actionType?.name,
      },
    });
  }

  if (followup) {
    emit(EVENTS.FOLLOWUP_COMPLETED, { tenantId, leadId: lead._id, followupId: followup._id, onTime: now <= new Date(followup.dueAt) });
  }

  // 6. Stage move, if the outcome caused one.
  if (String(resultingStage._id) !== String(lead.stageId) || String(resolvedSubStageId || '') !== String(lead.subStageId || '')) {
    await leadsService.changeStage({
      tenantId,
      actor,
      leadId: lead._id,
      stageId: resultingStage._id,
      subStageId: resolvedSubStageId,
      note,
      at: now,
      sourceAction: sourceAction || (followup ? 'FOLLOWUP_COMPLETE' : 'MANUAL_OUTCOME'),
    });
  }

  // 7. The lead's next action + the SLA stop (§16.2). Only reached once a
  //    genuine outcome AND a next action have both been saved (§55.3).
  await syncLeadNextAction({ tenantId, leadId: lead._id });
  const fresh = await Lead.findOne({ tenantId, _id: lead._id }).lean();
  if (!fresh.firstGenuineActionAt) {
    await leadsService.recordFirstGenuineAction({ tenantId, lead: fresh, at: now });
  }

  if (nextFollowup) {
    await timeline.log({
      tenantId, leadId: lead._id, contactId: lead.contactId, type: 'FOLLOWUP_CREATED',
      title: `Next action: ${validatedNext.actionType.name}`,
      actor,
      at: now,
      meta: { followupId: String(nextFollowup._id), dueAt: validatedNext.dueAt },
    });
    emit(EVENTS.FOLLOWUP_CREATED, { tenantId, leadId: lead._id, followup: nextFollowup });
  }

  return { nextFollowup, resultingStage, subStage };
}

/** §18.4: complete a scheduled follow-up. */
async function complete({ tenantId, tenant, actor, followupId, subStageId, stageId, note, next, tz }) {
  const followup = await Followup.findOne({ tenantId, _id: followupId }).lean();
  if (!followup) throw notFound('Follow-up not found.');
  if (!['PENDING', 'MISSED'].includes(followup.status)) {
    throw badRequest('This follow-up has already been closed.');
  }
  const lead = await Lead.findOne({ tenantId, _id: followup.leadId }).lean();
  if (!lead) throw notFound('Lead not found.');

  const result = await applyOutcome({
    tenantId, tenant, actor, lead, followup, subStageId, stageId, note, next, tz,
  });
  await audit.record({
    tenantId, actor, entity: 'Followup', entityId: followup._id, action: 'COMPLETE',
    after: { subStageId, stageId, nextFollowupId: result.nextFollowup?._id },
  });
  return result;
}

/**
 * §114 / §16.2: the first genuine action on a new lead. Logging the call alone
 * is not enough — this path still demands the next action, which is exactly
 * what clears the lead from the New Leads tile (§8.2).
 */
async function logAction({ tenantId, tenant, actor, leadId, actionTypeId, subStageId, stageId, note, next, tz }) {
  const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
  if (!lead) throw notFound('Lead not found.');
  if (!actionTypeId) throw badRequest('Select what you did.');

  const result = await applyOutcome({
    tenantId, tenant, actor, lead, followup: null, actionTypeId, subStageId, stageId, note, next, tz,
  });
  return result;
}

/** §18.1: cancel a follow-up. The lead still needs a next action if it is active. */
async function cancel({ tenantId, actor, followupId, reason }) {
  const followup = await Followup.findOne({ tenantId, _id: followupId });
  if (!followup) throw notFound('Follow-up not found.');
  if (followup.status !== 'PENDING' && followup.status !== 'MISSED') {
    throw badRequest('Only a pending follow-up can be cancelled.');
  }
  followup.status = 'CANCELLED';
  followup.cancelledReason = reason;
  await followup.save();

  await timeline.log({
    tenantId, leadId: followup.leadId, contactId: followup.contactId, type: 'FOLLOWUP_CANCELLED',
    title: 'Follow-up cancelled', body: reason, actor,
    meta: { followupId: String(followup._id) },
  });
  await syncLeadNextAction({ tenantId, leadId: followup.leadId });
  return followup;
}

/** §18.1: move a follow-up without completing it. */
async function reschedule({ tenantId, actor, followupId, dueAt, note, tz }) {
  const followup = await Followup.findOne({ tenantId, _id: followupId });
  if (!followup) throw notFound('Follow-up not found.');
  if (!['PENDING', 'MISSED'].includes(followup.status)) throw badRequest('This follow-up is already closed.');

  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('Choose a new date and time.');
  if (due.getTime() <= Date.now() - 60000) throw badRequest('Reschedule to a time in the future.');

  const previous = followup.dueAt;
  followup.dueAt = due;
  followup.status = 'PENDING';
  if (note) followup.note = note;
  await followup.save();

  await timeline.log({
    tenantId, leadId: followup.leadId, contactId: followup.contactId, type: 'FOLLOWUP_CREATED',
    title: 'Follow-up rescheduled', body: note, actor,
    meta: { followupId: String(followup._id), from: previous, to: due },
  });
  await syncLeadNextAction({ tenantId, leadId: followup.leadId });
  return followup;
}

/**
 * §18.5: a pending follow-up whose time has passed is Missed. Display derives
 * it from `dueAt`, and this job reconciles the stored status so reporting is
 * deterministic. Idempotent, so a retry after a crash is harmless.
 */
async function markMissed({ tenantId, now = new Date() } = {}) {
  const filter = { status: 'PENDING', dueAt: { $lt: now } };
  if (tenantId) filter.tenantId = tenantId;

  const due = await Followup.find(filter).setOptions({ allowCrossTenant: !tenantId }).limit(500).lean();
  let missed = 0;
  for (const followup of due) {
    const lead = await Lead.findOne({ tenantId: followup.tenantId, _id: followup.leadId }).lean();
    if (!lead || lead.status !== 'ACTIVE') continue;
    await Followup.updateOne({ tenantId: followup.tenantId, _id: followup._id }, { $set: { status: 'MISSED' } });
    await timeline.log({
      tenantId: followup.tenantId, leadId: followup.leadId, contactId: followup.contactId,
      type: 'FOLLOWUP_MISSED', title: 'Follow-up missed', actorType: 'SYSTEM',
      meta: { followupId: String(followup._id), dueAt: followup.dueAt },
    });
    emit(EVENTS.FOLLOWUP_MISSED, {
      tenantId: followup.tenantId, leadId: followup.leadId, followup, ownerUserId: followup.assignedUserId,
    });
    missed += 1;
  }
  return { scanned: due.length, missed };
}

/** Guard used by routes: can this user work this follow-up? */
async function assertCanWork(user, followup) {
  const { canActOn } = require('../lib/access');
  const allowed = await canActOn(user, 'lead.view', followup.assignedUserId);
  if (!allowed) throw forbidden('This follow-up belongs to another user.');
}

module.exports = {
  create, complete, logAction, cancel, reschedule, markMissed,
  syncLeadNextAction, requireNextAction, resolveNextDueAt, applyOutcome, assertCanWork,
};
