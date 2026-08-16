const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const { Followup, Lead } = require('../db/models');
const { notFound } = require('../lib/errors');
const followupsService = require('../services/followups');
const captureService = require('../services/capture');

const router = express.Router();
router.use('/api/followups', requireAuth);
router.use('/api/leads', requireAuth);

/**
 * Spec §113: the completion drawer, in the field order the spec specifies.
 * The next-action fields are only optional here because a terminal stage is a
 * valid outcome — the service decides, never the form (§18.3).
 */
const completeSchema = z.object({
  subStageId: f.optionalId,
  stageId: f.optionalId,
  note: f.optionalText(2000),
  nextActionTypeId: f.optionalId,
  nextDate: f.optionalText(10),
  nextTime: f.optionalText(5),
  nextNote: f.optionalText(500),
  returnTo: f.optionalText(200),
});

const createSchema = z.object({
  actionTypeId: f.objectId,
  date: f.requiredText(10, 'Choose a date.'),
  time: f.optionalText(5),
  note: f.optionalText(2000),
  assignedUserId: f.optionalId,
  priority: f.enumField(['LOW', 'NORMAL', 'HIGH']),
  returnTo: f.optionalText(200),
});

const logActionSchema = completeSchema.extend({
  actionTypeId: f.objectId,
});

/** §51.3: add a follow-up from the compact form. */
router.post('/api/leads/:id/followups', requirePermission('followup.create'), validate(createSchema), async (req, res, next) => {
  try {
    const tz = res.locals.zone;
    const tzLib = require('../lib/tz');
    await followupsService.create({
      tenantId: req.tenantId,
      actor: req.user,
      leadId: req.params.id,
      actionTypeId: req.data.actionTypeId,
      dueAt: tzLib.fromLocalInput(req.data.date, req.data.time || '09:00', tz),
      assignedUserId: req.data.assignedUserId,
      note: req.data.note,
      priority: req.data.priority || 'NORMAL',
    });
    respond(req, res, 'Follow-up scheduled.', req.data.returnTo || `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

/** §18.4: complete a follow-up. The service enforces the next-action rule. */
router.post('/api/followups/:id/complete', requirePermission('followup.complete'), validate(completeSchema), async (req, res, next) => {
  try {
    const followup = await Followup.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!followup) throw notFound('Follow-up not found.');
    await followupsService.assertCanWork(req.user, followup);

    await followupsService.complete({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      followupId: followup._id,
      subStageId: req.data.subStageId,
      stageId: req.data.stageId,
      note: req.data.note,
      tz: res.locals.zone,
      next: {
        actionTypeId: req.data.nextActionTypeId,
        date: req.data.nextDate,
        time: req.data.nextTime,
        note: req.data.nextNote,
      },
    });
    // §50: hand the user straight back to the queue they came from.
    respond(req, res, 'Saved. Next action scheduled.', safeReturn(req.data.returnTo, `/app/leads/${followup.leadId}`));
  } catch (err) { next(err); }
});

/**
 * §114 / §16.2: the first genuine action on a new lead, and the general
 * "log what I just did" path. Requires an outcome AND a next action, which is
 * exactly what clears the lead from the New Leads tile.
 */
router.post('/api/leads/:id/log-action', requirePermission('followup.complete', 'followup.create'), validate(logActionSchema), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!lead) throw notFound('Lead not found.');
    const { canActOn } = require('../lib/access');
    if (lead.ownerUserId && !(await canActOn(req.user, 'lead.view', lead.ownerUserId))) {
      throw notFound('Lead not found.');
    }

    await followupsService.logAction({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      leadId: lead._id,
      actionTypeId: req.data.actionTypeId,
      subStageId: req.data.subStageId,
      stageId: req.data.stageId,
      note: req.data.note,
      tz: res.locals.zone,
      next: {
        actionTypeId: req.data.nextActionTypeId,
        date: req.data.nextDate,
        time: req.data.nextTime,
        note: req.data.nextNote,
      },
    });
    // Seeing and working a re-inquiry clears it from that tile (§8.2).
    await captureService.acknowledgeReinquiry({ tenantId: req.tenantId, leadId: lead._id });

    respond(req, res, 'Saved. Next action scheduled.', safeReturn(req.data.returnTo, `/app/leads/${lead._id}`));
  } catch (err) { next(err); }
});

const rescheduleSchema = z.object({
  date: f.requiredText(10, 'Choose a date.'),
  time: f.optionalText(5),
  note: f.optionalText(500),
  returnTo: f.optionalText(200),
});

router.post('/api/followups/:id/reschedule', requirePermission('followup.edit_own', 'followup.edit_team'), validate(rescheduleSchema), async (req, res, next) => {
  try {
    const followup = await Followup.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!followup) throw notFound('Follow-up not found.');
    await followupsService.assertCanWork(req.user, followup);

    const tzLib = require('../lib/tz');
    await followupsService.reschedule({
      tenantId: req.tenantId,
      actor: req.user,
      followupId: followup._id,
      dueAt: tzLib.fromLocalInput(req.data.date, req.data.time || '09:00', res.locals.zone),
      note: req.data.note,
    });
    respond(req, res, 'Follow-up rescheduled.', safeReturn(req.data.returnTo, `/app/leads/${followup.leadId}`));
  } catch (err) { next(err); }
});

router.post('/api/followups/:id/cancel', requirePermission('followup.edit_own', 'followup.edit_team'), async (req, res, next) => {
  try {
    const followup = await Followup.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!followup) throw notFound('Follow-up not found.');
    await followupsService.assertCanWork(req.user, followup);
    await followupsService.cancel({
      tenantId: req.tenantId, actor: req.user, followupId: followup._id, reason: req.body.reason,
    });
    respond(req, res, 'Follow-up cancelled. Set the next action to keep the lead moving.', `/app/leads/${followup.leadId}`);
  } catch (err) { next(err); }
});

const safeReturn = (value, fallback) => (typeof value === 'string' && value.startsWith('/app/') ? value : fallback);

const wantsJson = (req) => (req.get('accept') || '').includes('application/json');

function respond(req, res, message, redirectTo) {
  if (wantsJson(req)) return res.json({ ok: true, message, redirectTo });
  req.session.flash = { type: 'success', message };
  res.redirect(redirectTo);
}

module.exports = router;
