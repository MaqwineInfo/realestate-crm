const express = require('express');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { can } = require('../lib/access');
const dashboardService = require('../services/dashboard');
const notifications = require('../services/notifications');
const stagesService = require('../services/stages');

const router = express.Router();
router.use('/app', requireAuth);
router.use('/api/notifications', requireAuth);

const SALES_TILES = ['new', 'today', 'missed', 'reinquiry'];
const MANAGER_TILES = ['unattended', 'sla', 'today', 'missed', 'reinquiry', 'unassigned'];

/**
 * Spec §8: one route, three audiences. The sales user gets a work queue, the
 * manager gets exceptions (§8.4). Management outcomes (§8.5) arrive with the
 * booking and revenue data in a later phase.
 */
router.get('/app/dashboard', async (req, res, next) => {
  try {
    /**
     * V2 §4: `?view=collections` is the documented way in. It redirects to the
     * one collections implementation rather than growing a second copy of the
     * queue here — the tiles and the list must never drift apart (§279).
     */
    if (req.query.view === 'collections') return res.redirect('/app/collections');
    const isTeamView = req.query.view === 'team' && can(req.user, 'dashboard.team');
    const zone = res.locals.zone;

    const key = isTeamView
      ? (MANAGER_TILES.includes(req.query.tile) ? req.query.tile : 'unattended')
      : (SALES_TILES.includes(req.query.tile) ? req.query.tile : 'new');

    const [tiles, queue, notifs, actionTypes, stages, subStages, visitOutcomes, snapshot] = await Promise.all([
      isTeamView
        ? dashboardService.managerTiles({ tenantId: req.tenantId, user: req.user, zone })
        : dashboardService.salesTiles({ tenantId: req.tenantId, user: req.user, zone }),
      isTeamView
        ? dashboardService.managerQueue({ tenantId: req.tenantId, user: req.user, zone, key })
        : dashboardService.salesQueue({ tenantId: req.tenantId, user: req.user, zone, key }),
      notifications.unreadFor({ tenantId: req.tenantId, userId: req.user._id, limit: 8 }),
      stagesService.listActionTypes({ tenantId: req.tenantId }),
      stagesService.listStages({ tenantId: req.tenantId }),
      stagesService.listSubStages({ tenantId: req.tenantId }),
      stagesService.listVisitOutcomes({ tenantId: req.tenantId }),
      isTeamView ? dashboardService.managerSnapshot({ tenantId: req.tenantId, user: req.user, zone }) : null,
    ]);

    res.render('pages/dashboard/index', {
      title: isTeamView ? 'Team dashboard' : 'Dashboard',
      tiles,
      activeTile: key,
      queue,
      snapshot,
      isTeamView,
      canSeeTeam: can(req.user, 'dashboard.team'),
      notifications: notifs.items,
      unreadCount: notifs.count,
      actionTypes,
      stages,
      subStages,
      visitOutcomes,
      returnTo: req.originalUrl,
    });
  } catch (err) { next(err); }
});

router.get('/app/notifications', async (req, res, next) => {
  try {
    const { items, count } = await notifications.unreadFor({ tenantId: req.tenantId, userId: req.user._id, limit: 50 });
    res.render('pages/dashboard/notifications', { title: 'Notifications', items, unreadCount: count });
  } catch (err) { next(err); }
});

router.post('/api/notifications/read', async (req, res, next) => {
  try {
    await notifications.markRead({ tenantId: req.tenantId, userId: req.user._id });
    res.redirect('/app/notifications');
  } catch (err) { next(err); }
});

router.get('/app/profile', (req, res) => {
  res.render('pages/dashboard/profile', { title: 'My profile' });
});

/** §97: integration and background-job health, for admins. */
router.get('/app/setup/health', requirePermission('setup.integrations'), async (req, res, next) => {
  try {
    const { Integration, WebhookEvent } = require('../db/models');
    const scheduler = require('../jobs/scheduler');
    const [integrations, recentFailures] = await Promise.all([
      Integration.find({ tenantId: req.tenantId }).sort({ category: 1 }).lean(),
      WebhookEvent.find({ tenantId: req.tenantId, status: 'FAILED' }).sort({ receivedAt: -1 }).limit(20).lean(),
    ]);
    res.render('pages/setup/health', {
      title: 'Integration health',
      integrations,
      recentFailures,
      jobs: scheduler.health(),
    });
  } catch (err) { next(err); }
});

/** §56: the audit trail. Read-only — nothing in the app can edit or delete it. */
router.get('/app/setup/audit', requirePermission('setup.organization', 'setup.roles'), async (req, res, next) => {
  try {
    const { AuditLog, User } = require('../db/models');
    const filter = { tenantId: req.tenantId };
    if (req.query.entity) filter.entity = req.query.entity;
    if (req.query.userId) filter.userId = req.query.userId;

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = 50;
    const [items, total, users, entities] = await Promise.all([
      AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
      User.find({ tenantId: req.tenantId }).select('name').sort({ name: 1 }).lean(),
      AuditLog.distinct('entity', { tenantId: req.tenantId }),
    ]);
    res.render('pages/setup/audit', {
      title: 'Audit trail',
      items,
      users,
      entities,
      page,
      pages: Math.ceil(total / limit) || 1,
      total,
    });
  } catch (err) { next(err); }
});

module.exports = router;
