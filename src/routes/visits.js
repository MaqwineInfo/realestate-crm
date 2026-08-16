const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const tzLib = require('../lib/tz');
const { SiteVisit, Unit } = require('../db/models');
const { notFound } = require('../lib/errors');
const visitsService = require('../services/visits');

/** Spec §24 + §51.4: scheduling and completing site visits. */
const router = express.Router();
router.use('/api/visits', requireAuth);
router.use('/api/leads', requireAuth);
router.use('/app/visits', requireAuth);

const scheduleSchema = z.object({
  projectId: f.optionalId,
  date: f.requiredText(10, 'Choose the visit date.'),
  time: f.requiredText(5, 'Choose the visit time.'),
  salesUserId: f.optionalId,
  visitingWith: f.enumField(['DIRECT', 'CHANNEL_PARTNER']),
  channelPartnerName: f.optionalText(120),
  channelPartnerMobile: f.optionalText(20),
  visitorCount: f.optionalNumber,
  notes: f.optionalText(2000),
  returnTo: f.optionalText(200),
});

router.post('/api/leads/:id/visits', requirePermission('visit.create'), validate(scheduleSchema), async (req, res, next) => {
  try {
    await visitsService.schedule({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      leadId: req.params.id,
      projectId: req.data.projectId,
      scheduledAt: tzLib.fromLocalInput(req.data.date, req.data.time, res.locals.zone),
      salesUserId: req.data.salesUserId,
      visitingWith: req.data.visitingWith || 'DIRECT',
      channelPartnerName: req.data.channelPartnerName,
      channelPartnerMobile: req.data.channelPartnerMobile,
      visitorCount: req.data.visitorCount,
      notes: req.data.notes,
    });
    req.session.flash = { type: 'success', message: 'Site visit scheduled.' };
    res.redirect(safeReturn(req.data.returnTo, `/app/leads/${req.params.id}`));
  } catch (err) { next(err); }
});

const completeSchema = z.object({
  outcomeId: f.objectId,
  notes: f.optionalText(2000),
  unitsShownIds: f.stringList,
  shortlistUnitIds: f.stringList,
  stageId: f.optionalId,
  nextActionTypeId: f.optionalId,
  nextDate: f.optionalText(10),
  nextTime: f.optionalText(5),
  returnTo: f.optionalText(200),
});

/** §24.3: outcome is mandatory, and an active lead leaves with a next action. */
router.post('/api/visits/:id/complete', requirePermission('visit.complete'), validate(completeSchema), async (req, res, next) => {
  try {
    const visit = await SiteVisit.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!visit) throw notFound('Site visit not found.');

    await visitsService.complete({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      visitId: visit._id,
      outcomeId: req.data.outcomeId,
      notes: req.data.notes,
      unitsShownIds: req.data.unitsShownIds,
      shortlistUnitIds: req.data.shortlistUnitIds,
      stageId: req.data.stageId,
      tz: res.locals.zone,
      next: {
        actionTypeId: req.data.nextActionTypeId,
        date: req.data.nextDate,
        time: req.data.nextTime,
      },
    });
    req.session.flash = { type: 'success', message: 'Visit completed and the next action is set.' };
    res.redirect(safeReturn(req.data.returnTo, `/app/leads/${visit.leadId}`));
  } catch (err) { next(err); }
});

router.post('/api/visits/:id/reschedule', requirePermission('visit.edit'), async (req, res, next) => {
  try {
    const visit = await SiteVisit.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!visit) throw notFound('Site visit not found.');
    await visitsService.reschedule({
      tenantId: req.tenantId,
      actor: req.user,
      visitId: visit._id,
      scheduledAt: tzLib.fromLocalInput(req.body.date, req.body.time || '10:00', res.locals.zone),
      note: req.body.note,
    });
    req.session.flash = { type: 'success', message: 'Visit rescheduled.' };
    res.redirect(`/app/leads/${visit.leadId}`);
  } catch (err) { next(err); }
});

router.post('/api/visits/:id/cancel', requirePermission('visit.cancel'), async (req, res, next) => {
  try {
    const visit = await SiteVisit.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!visit) throw notFound('Site visit not found.');
    await visitsService.cancel({
      tenantId: req.tenantId, actor: req.user, visitId: visit._id,
      reason: req.body.reason, noShow: req.body.noShow === '1',
    });
    req.session.flash = { type: 'success', message: 'Visit closed.' };
    res.redirect(`/app/leads/${visit.leadId}`);
  } catch (err) { next(err); }
});

/** Units a visit can record as "shown", for the completion drawer. */
router.get('/api/visits/:id/units', requirePermission('visit.complete'), async (req, res, next) => {
  try {
    const visit = await SiteVisit.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!visit) throw notFound('Site visit not found.');
    const units = await Unit.find({ tenantId: req.tenantId, projectId: visit.projectId, active: true })
      .select('unitNumber status').sort({ unitNumber: 1 }).limit(200).lean();
    res.json({ ok: true, units });
  } catch (err) { next(err); }
});

const safeReturn = (value, fallback) => (typeof value === 'string' && value.startsWith('/app/') ? value : fallback);

module.exports = router;
