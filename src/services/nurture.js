const {
  NurtureSequence, NurtureEnrollment, Lead, Contact, Project, User, Tenant, Template, Stage,
} = require('../db/models');
const { EVENTS, on } = require('../lib/events');
const config = require('../config');
const messaging = require('./messaging');
const followupsService = require('./followups');
const timeline = require('./timeline');

/**
 * Spec §19: simple cadence, not a workflow canvas.
 *
 * A sequence is matched on project + stage (+ optional sub-stage or tag), a
 * lead is enrolled once, and each step either sends a templated message or
 * creates a task for the current lead owner (§19.4). Stop conditions are
 * checked before every step, so a booked or lost lead never gets nurtured.
 */

/** §19.1: the most specific active sequence that matches this lead. */
async function matchSequence({ tenantId, lead }) {
  const sequences = await NurtureSequence.find({
    tenantId,
    active: true,
    projectId: { $in: [lead.projectId || null, null] },
    stageId: { $in: [lead.stageId, null] },
  }).lean();
  if (!sequences.length) return null;

  const score = (s) => (s.projectId ? 4 : 0) + (s.stageId ? 2 : 0) + (s.subStageId ? 1 : 0);
  const eligible = sequences.filter((s) => !s.subStageId || String(s.subStageId) === String(lead.subStageId || ''));
  return eligible.sort((a, b) => score(b) - score(a))[0] || null;
}

async function enroll({ tenantId, lead, sequence }) {
  const resolved = sequence || await matchSequence({ tenantId, lead });
  if (!resolved || !resolved.steps?.length) return null;

  const existing = await NurtureEnrollment.findOne({ tenantId, sequenceId: resolved._id, leadId: lead._id }).lean();
  if (existing) return existing;

  const firstStep = [...resolved.steps].sort((a, b) => a.stepNumber - b.stepNumber)[0];
  return NurtureEnrollment.create({
    tenantId,
    sequenceId: resolved._id,
    leadId: lead._id,
    contactId: lead.contactId,
    nextStepNumber: firstStep.stepNumber,
    nextRunAt: new Date(Date.now() + (firstStep.delayDays || 0) * 86400000),
  });
}

/** §19.3: everything that ends a cadence. */
async function stopFor({ tenantId, leadId, reason }) {
  const result = await NurtureEnrollment.updateMany(
    { tenantId, leadId, status: 'ACTIVE' },
    { $set: { status: 'STOPPED', stoppedReason: reason } },
  );
  return result.modifiedCount || 0;
}

async function shouldStop({ tenantId, sequence, lead, contact }) {
  if (!lead || lead.archived) return 'Lead archived';
  if (lead.status === 'TERMINAL') {
    if (lead.bookedAt && sequence.stopOnBooked) return 'Lead booked';
    if (!lead.bookedAt && sequence.stopOnLost) return 'Lead lost';
  }
  if (sequence.stopOnStageIds?.some((id) => String(id) === String(lead.stageId))) return 'Stage reached';
  if (contact?.consent?.dnd) return 'Contact is do-not-contact';
  return null;
}

/**
 * §107: run the steps that are due. Each enrollment advances at most one step
 * per tick, and `nextRunAt` is written before the side effect, so a retry after
 * a crash cannot send the same step twice.
 */
async function tick({ tenantId = null, now = new Date(), limit = 100 } = {}) {
  const filter = { status: 'ACTIVE', nextRunAt: { $lte: now } };
  if (tenantId) filter.tenantId = tenantId;

  const due = await NurtureEnrollment.find(filter).setOptions({ allowCrossTenant: !tenantId }).limit(limit).lean();
  const result = { ran: 0, stopped: 0 };

  for (const enrollment of due) {
    const scope = enrollment.tenantId;
    const [sequence, lead, contact, tenant] = await Promise.all([
      NurtureSequence.findOne({ tenantId: scope, _id: enrollment.sequenceId }).lean(),
      Lead.findOne({ tenantId: scope, _id: enrollment.leadId }).lean(),
      Contact.findOne({ tenantId: scope, _id: enrollment.contactId }).lean(),
      Tenant.findById(scope).lean(),
    ]);
    if (!sequence || !sequence.active) {
      await NurtureEnrollment.updateOne({ tenantId: scope, _id: enrollment._id }, { $set: { status: 'STOPPED', stoppedReason: 'Sequence disabled' } });
      continue;
    }

    const stop = await shouldStop({ tenantId: scope, sequence, lead, contact });
    if (stop) {
      await NurtureEnrollment.updateOne({ tenantId: scope, _id: enrollment._id }, { $set: { status: 'STOPPED', stoppedReason: stop } });
      result.stopped += 1;
      continue;
    }

    const steps = [...sequence.steps].filter((s) => s.active !== false).sort((a, b) => a.stepNumber - b.stepNumber);
    const step = steps.find((s) => s.stepNumber === enrollment.nextStepNumber) || steps.find((s) => s.stepNumber > enrollment.nextStepNumber);
    if (!step) {
      await NurtureEnrollment.updateOne({ tenantId: scope, _id: enrollment._id }, { $set: { status: 'COMPLETED' } });
      continue;
    }

    // Advance the cursor first: a failure mid-step must not replay the step.
    const upcoming = steps.find((s) => s.stepNumber > step.stepNumber);
    await NurtureEnrollment.updateOne({ tenantId: scope, _id: enrollment._id }, {
      $set: {
        lastStepAt: now,
        nextStepNumber: upcoming ? upcoming.stepNumber : step.stepNumber + 1,
        nextRunAt: upcoming ? new Date(now.getTime() + (upcoming.delayDays || 0) * 86400000) : null,
        status: upcoming ? 'ACTIVE' : 'COMPLETED',
      },
    });

    await runStep({ tenantId: scope, tenant, sequence, step, lead, contact }).catch((err) => {
      console.error(JSON.stringify({ level: 'error', scope: 'nurture', step: step.stepNumber, message: err.message }));
    });
    result.ran += 1;
  }
  return result;
}

async function runStep({ tenantId, tenant, sequence, step, lead, contact }) {
  if (step.kind === 'TASK') {
    // §19.4: automated tasks belong to the current lead owner.
    if (!lead.ownerUserId) return;
    await followupsService.create({
      tenantId,
      actor: null,
      leadId: lead._id,
      actionTypeId: step.actionTypeId,
      dueAt: new Date(Date.now() + 3600000),
      note: step.note || `Nurture step ${step.stepNumber}: ${sequence.name}`,
      createdVia: 'NURTURE',
      silent: true,
    }).catch(() => {});
    await timeline.log({
      tenantId, leadId: lead._id, contactId: lead.contactId, type: 'NURTURE_STEP_SENT',
      title: `Nurture task created — ${sequence.name} step ${step.stepNumber}`, actorType: 'SYSTEM',
      meta: { sequenceId: String(sequence._id), stepNumber: step.stepNumber },
    });
    return;
  }

  const [template, project, owner] = await Promise.all([
    step.templateId ? Template.findOne({ tenantId, _id: step.templateId, active: true }).lean() : null,
    lead.projectId ? Project.findOne({ tenantId, _id: lead.projectId }).lean() : null,
    lead.ownerUserId ? User.findOne({ tenantId, _id: lead.ownerUserId }).lean() : null,
  ]);
  if (!template) return;

  const log = await messaging.send({
    tenantId,
    channel: step.channel || template.channel,
    contact,
    leadId: lead._id,
    templateId: template._id,
    template,
    purpose: 'NURTURE',
    vars: messaging.templateVars({ contact, lead, project, owner, tenant, appUrl: config.appUrl }),
  });

  await timeline.log({
    tenantId, leadId: lead._id, contactId: lead.contactId, type: 'NURTURE_STEP_SENT',
    title: `Nurture ${(step.channel || template.channel).toLowerCase()} — ${sequence.name} step ${step.stepNumber}`,
    actorType: 'SYSTEM',
    meta: { sequenceId: String(sequence._id), stepNumber: step.stepNumber, messageStatus: log.status },
  });
}

/** Wire the cadence to the lifecycle: enroll on stage change, stop on the end. */
function registerListeners() {
  on(EVENTS.LEAD_STAGE_CHANGED, async ({ tenantId, lead, stage }) => {
    if (stage.terminal) {
      await stopFor({ tenantId, leadId: lead._id, reason: stage.semanticType === 'BOOKED' ? 'Lead booked' : 'Lead closed' });
      return;
    }
    const fresh = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    if (fresh) await enroll({ tenantId, lead: fresh });
  });

  on(EVENTS.BOOKING_CREATED, async ({ tenantId, leadId }) => {
    await stopFor({ tenantId, leadId, reason: 'Lead booked' });
  });
}

const list = ({ tenantId }) => NurtureSequence.find({ tenantId })
  .sort({ name: 1 }).populate('projectId', 'name').populate('stageId', 'name').lean();

module.exports = { matchSequence, enroll, stopFor, shouldStop, tick, list, registerListeners };
