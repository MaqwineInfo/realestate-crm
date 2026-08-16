const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const { Integration, WebhookEvent, Tenant } = require('../db/models');
const captureService = require('../services/capture');
const messaging = require('../services/messaging');

/**
 * Routes with no session: lead-capture webhooks (§63), the QR walk-in form
 * (§25) and project mini sites (§64). They authenticate on an integration key
 * or signed token, so they are mounted ahead of the CSRF gate.
 */
const router = express.Router();

router.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    db: db.mongoose.connection.readyState === 1 ? 'up' : 'down',
    transactions: db.hasTransactions(),
  });
});

/**
 * §63: generic inbound lead webhook.
 *
 *   POST /api/webhooks/leads/:webhookKey
 *
 * The key identifies both tenant and integration — a tenant id is never taken
 * from the body (§4.2). Every delivery is stored raw before processing, and
 * `idempotencyKey` is uniquely indexed, so a provider retry cannot create a
 * second inquiry (§98).
 */
router.post('/api/webhooks/leads/:webhookKey', async (req, res) => {
  const limiter = req.app.locals.limiters.public;
  limiter(req, res, async () => {
    let event = null;
    try {
      const integration = await Integration.findOne({ webhookKey: req.params.webhookKey, active: true })
        .setOptions({ allowCrossTenant: true }).lean();
      if (!integration) return res.status(404).json({ ok: false, error: 'Unknown webhook endpoint.' });

      const tenantId = integration.tenantId;
      const signatureError = verifySignature({ integration, req });
      if (signatureError) return res.status(401).json({ ok: false, error: signatureError });

      const payload = normalizePayload(req.body, integration);
      const idempotencyKey = payload.externalId
        || req.get('x-idempotency-key')
        || crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');

      try {
        event = await WebhookEvent.create({
          tenantId,
          integrationId: integration._id,
          provider: integration.provider,
          idempotencyKey,
          payload: req.body,
          headers: { 'user-agent': req.get('user-agent') },
        });
      } catch (err) {
        if (err.code === 11000) {
          // §98: an exact redelivery is acknowledged, not reprocessed.
          const original = await WebhookEvent.findOne({ tenantId, integrationId: integration._id, idempotencyKey }).lean();
          return res.status(200).json({ ok: true, duplicate: true, leadId: original?.leadId });
        }
        throw err;
      }

      const tenant = await Tenant.findById(tenantId).lean();
      const result = await captureService.handleInquiry({
        tenantId,
        tenant,
        webhookEventId: event._id,
        createdVia: `INTEGRATION:${integration.provider}`,
        payload: {
          ...payload,
          projectId: payload.projectId || integration.defaultProjectId,
          sourceId: payload.sourceId || integration.defaultSourceId,
        },
      });

      await WebhookEvent.updateOne({ tenantId, _id: event._id }, {
        $set: { status: 'PROCESSED', leadId: result.lead._id, contactId: result.contact._id },
        $inc: { attempts: 1 },
      });
      await Integration.updateOne({ tenantId, _id: integration._id }, {
        $set: { lastSuccessAt: new Date(), lastSyncAt: new Date(), status: 'CONNECTED', failureCount: 0 },
      });

      res.status(201).json({
        ok: true,
        leadId: result.lead._id,
        contactId: result.contact._id,
        reinquiry: result.isReinquiry,
      });
    } catch (err) {
      // §106: capture failures must stay visible instead of vanishing.
      if (event) {
        await WebhookEvent.updateOne({ tenantId: event.tenantId, _id: event._id }, {
          $set: { status: 'FAILED', error: err.message }, $inc: { attempts: 1 },
        }).catch(() => {});
        await Integration.updateOne({ tenantId: event.tenantId, _id: event.integrationId }, {
          $set: { status: 'ATTENTION_REQUIRED', lastError: err.message, lastErrorAt: new Date() },
          $inc: { failureCount: 1 },
        }).catch(() => {});
      }
      console.error(JSON.stringify({ level: 'error', scope: 'webhook.leads', message: err.message }));
      res.status(err.status === 400 ? 400 : 500).json({ ok: false, error: err.expose ? err.message : 'Could not process this lead.' });
    }
  });
});

/** §66: provider delivery callbacks for sent messages. Idempotent by design. */
router.post('/api/webhooks/messages/:webhookKey', async (req, res) => {
  try {
    const integration = await Integration.findOne({ webhookKey: req.params.webhookKey, active: true })
      .setOptions({ allowCrossTenant: true }).lean();
    if (!integration) return res.status(404).json({ ok: false });

    const updates = Array.isArray(req.body?.events) ? req.body.events : [req.body];
    let applied = 0;
    for (const update of updates) {
      const log = await messaging.applyDeliveryUpdate({
        tenantId: integration.tenantId,
        providerMessageId: update.messageId || update.providerMessageId,
        status: String(update.status || '').toUpperCase(),
        error: update.error,
      });
      if (log) applied += 1;
    }
    res.json({ ok: true, applied });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', scope: 'webhook.messages', message: err.message }));
    res.status(500).json({ ok: false });
  }
});

/* ---------------------------- §25 QR site visit --------------------------- */

/**
 * The walk-in form. No OTP in V1 (§25) — the project is resolved from the
 * signed token in the URL, never from an editable field (§25.3), and the
 * endpoint is rate limited (§25.3).
 */
router.get('/visit/:qrToken', async (req, res, next) => {
  try {
    const { Project, Tenant } = require('../db/models');
    const project = await Project.findOne({ qrToken: req.params.qrToken })
      .setOptions({ allowCrossTenant: true }).lean();
    if (!project) return res.status(404).render('pages/public/not-found', { title: 'Not found' });
    const tenant = await Tenant.findById(project.tenantId).lean();

    res.render('pages/public/qr-visit', {
      title: `Welcome to ${project.name}`,
      project,
      tenant,
      requireCpMobile: !!tenant.settings?.qrRequireCpMobile,
      done: req.query.done === '1',
    });
  } catch (err) { next(err); }
});

router.post('/visit/:qrToken', (req, res, next) => req.app.locals.limiters.public(req, res, next), async (req, res, next) => {
  try {
    const { Project, Tenant, Contact } = require('../db/models');
    const visitsService = require('../services/visits');

    const project = await Project.findOne({ qrToken: req.params.qrToken })
      .setOptions({ allowCrossTenant: true }).lean();
    if (!project) return res.status(404).render('pages/public/not-found', { title: 'Not found' });

    const tenantId = project.tenantId;
    const tenant = await Tenant.findById(tenantId).lean();

    // §25.2: reuse the contact, open or create the project lead, log the visit.
    const result = await captureService.handleInquiry({
      tenantId,
      tenant,
      createdVia: 'QR',
      payload: {
        name: req.body.name,
        mobile: req.body.mobile,
        email: req.body.email,
        projectId: project._id,
        sourceCategory: 'QR',
        source: 'Project QR / Walk-in',
        sourceDetail: 'QR walk-in',
        message: req.body.notes,
      },
    });

    let channelPartnerContactId;
    if (req.body.visitingWith === 'CHANNEL_PARTNER' && req.body.cpMobile) {
      const contactsService = require('../services/contacts');
      const cp = await contactsService.findOrCreate({
        tenantId,
        tenant,
        createdVia: 'QR_CP',
        payload: { firstName: req.body.cpName || 'Channel Partner', primaryMobile: req.body.cpMobile },
      }).catch(() => null);
      channelPartnerContactId = cp?.contact?._id;
    }

    await visitsService.schedule({
      tenantId,
      tenant,
      actor: null,
      leadId: result.lead._id,
      projectId: project._id,
      scheduledAt: new Date(),
      salesUserId: result.lead.ownerUserId,
      status: 'IN_PROGRESS',
      visitingWith: req.body.visitingWith === 'CHANNEL_PARTNER' ? 'CHANNEL_PARTNER' : 'DIRECT',
      channelPartnerName: req.body.cpName,
      channelPartnerMobile: req.body.cpMobile,
      channelPartnerContactId,
      visitorCount: Number(req.body.visitorCount || 1),
      viaQr: true,
    });

    res.redirect(`/visit/${req.params.qrToken}?done=1`);
  } catch (err) {
    if (err.expose) {
      req.session = req.session || {};
      return res.status(400).render('pages/public/qr-visit', {
        title: 'Check in',
        project: await require('../db/models').Project.findOne({ qrToken: req.params.qrToken })
          .setOptions({ allowCrossTenant: true }).lean(),
        tenant: null,
        requireCpMobile: false,
        done: false,
        error: err.message,
      });
    }
    next(err);
  }
});

/* ----------------------------- §64 mini site ------------------------------ */

router.get('/p/:slug', async (req, res, next) => {
  try {
    const { Project, Tenant, UnitType, Unit, PaymentPlan } = require('../db/models');
    const project = await Project.findOne({ slug: req.params.slug }).setOptions({ allowCrossTenant: true }).lean();
    if (!project || !project.miniSite?.published) {
      return res.status(404).render('pages/public/not-found', { title: 'Not found' });
    }
    const tenantId = project.tenantId;
    const [tenant, unitTypes, plans] = await Promise.all([
      Tenant.findById(tenantId).lean(),
      UnitType.find({ tenantId, projectId: project._id, active: true }).sort({ displayOrder: 1 }).lean(),
      PaymentPlan.find({ tenantId, projectId: project._id, active: true }).lean(),
    ]);

    // §64.2: configuration-level availability only, and only if enabled.
    let availability = null;
    if (project.miniSite.showConfigurationAvailability) {
      const rows = await Unit.aggregate([
        { $match: { tenantId: project.tenantId, projectId: project._id, status: 'AVAILABLE', active: true } },
        { $group: { _id: '$unitTypeId', count: { $sum: 1 } } },
      ]);
      availability = Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
    }

    res.render('pages/public/mini-site', {
      title: project.name,
      project,
      tenant,
      unitTypes,
      plans,
      availability,
      sent: req.query.sent === '1',
    });
  } catch (err) { next(err); }
});

router.post('/p/:slug/inquire', (req, res, next) => req.app.locals.limiters.public(req, res, next), async (req, res, next) => {
  try {
    const { Project, Tenant } = require('../db/models');
    const project = await Project.findOne({ slug: req.params.slug }).setOptions({ allowCrossTenant: true }).lean();
    if (!project || !project.miniSite?.published) return res.status(404).render('pages/public/not-found', { title: 'Not found' });

    const tenant = await Tenant.findById(project.tenantId).lean();
    // §64.3: source is the mini site, project auto-mapped, UTM preserved.
    await captureService.handleInquiry({
      tenantId: project.tenantId,
      tenant,
      createdVia: 'MINI_SITE',
      payload: {
        name: req.body.name,
        mobile: req.body.mobile,
        email: req.body.email,
        message: req.body.message,
        projectId: project._id,
        sourceCategory: 'WEBSITE',
        source: 'Website',
        sourceDetail: 'Mini site',
        landingUrl: `${req.protocol}://${req.get('host')}/p/${project.slug}`,
        utm: {
          source: req.query.utm_source || req.body.utm_source,
          medium: req.query.utm_medium || req.body.utm_medium,
          campaign: req.query.utm_campaign || req.body.utm_campaign,
        },
      },
    });
    res.redirect(`/p/${project.slug}?sent=1`);
  } catch (err) { next(err); }
});

/* --------------------- §30.3 shared cost sheet (read-only) ---------------- */

router.get('/share/cost-sheet/:token', async (req, res, next) => {
  try {
    const costsheets = require('../services/costsheets');
    const sheet = await costsheets.getByToken(req.params.token);
    if (!sheet || sheet.status === 'SUPERSEDED') {
      return res.status(404).render('pages/public/not-found', { title: 'Not found' });
    }
    res.render('pages/public/cost-sheet', {
      title: 'Your cost sheet',
      sheet,
      tenant: sheet.tenantId,
      // §43: the schedule from this quotation's own snapshot (§44).
      schedule: costsheets.scheduleFor(sheet),
    });
  } catch (err) { next(err); }
});

/**
 * §63: optional shared-secret verification. A provider that signs its payloads
 * gets checked; one that cannot is admitted on the unguessable key alone.
 */
function verifySignature({ integration, req }) {
  const secret = integration.secrets?.signingSecret;
  if (!secret) return null;
  const { open } = require('../lib/secretbox');
  const expected = open(secret);
  if (!expected) return null;

  const provided = req.get('x-signature') || req.get('x-hub-signature-256');
  if (!provided) return 'Missing signature.';
  const digest = `sha256=${crypto.createHmac('sha256', expected).update(JSON.stringify(req.body || {})).digest('hex')}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(digest);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Invalid signature.';
  return null;
}

/** §12.2: accept the field names providers actually send. */
function normalizePayload(body = {}, integration) {
  const flat = body.data && typeof body.data === 'object' ? { ...body, ...body.data } : { ...body };
  return {
    externalId: flat.externalId || flat.lead_id || flat.leadgen_id || flat.id,
    name: flat.name || flat.full_name || flat.fullName,
    firstName: flat.firstName || flat.first_name,
    lastName: flat.lastName || flat.last_name,
    mobile: flat.mobile || flat.phone || flat.phone_number || flat.contact_number,
    email: flat.email,
    city: flat.city,
    message: flat.message || flat.requirement || flat.comments,
    projectId: flat.projectId,
    project: flat.project || flat.project_name,
    sourceId: flat.sourceId,
    source: flat.source || integration.provider,
    sourceCategory: flat.sourceCategory || categoryFor(integration.category),
    sourceDetail: flat.sourceDetail || flat.form_name,
    externalCampaignId: flat.campaignId || flat.campaign_id,
    adSetExternalId: flat.adsetId || flat.adset_id,
    adExternalId: flat.adId || flat.ad_id,
    formExternalId: flat.formId || flat.form_id,
    landingUrl: flat.landingUrl || flat.landing_url || flat.page_url,
    utm: {
      source: flat.utm_source, medium: flat.utm_medium, campaign: flat.utm_campaign,
      term: flat.utm_term, content: flat.utm_content,
    },
    capturedAt: flat.capturedAt || flat.created_time,
  };
}

const categoryFor = (integrationCategory) => ({
  META_LEAD_ADS: 'META',
  GOOGLE_ADS: 'GOOGLE',
  LINKEDIN_ADS: 'LINKEDIN',
  PROPERTY_PORTAL: 'PROPERTY_PORTAL',
  WEBSITE_WEBHOOK: 'WEBSITE',
}[integrationCategory] || 'API');

module.exports = router;
