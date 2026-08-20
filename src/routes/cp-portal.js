const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const {
  currentPartner, requirePartner, requirePartnerWrite, requirePartnerCapability,
} = require('../middleware/partnerAuth');
const validate = require('../middleware/validate');
const csrf = require('../middleware/csrf');
const f = require('../lib/fields');
const config = require('../config');
const money = require('../lib/money');
const { badRequest, forbidden, notFound } = require('../lib/errors');
const { ChannelPartnerMember, PartnerInvoice, Tenant } = require('../db/models');
const partnerPortal = require('../services/partnerPortal');
const partnerLeads = require('../services/partnerLeads');
const commissions = require('../services/commissions');
const partnerInvoices = require('../services/partnerInvoices');
const channelPartners = require('../services/channelPartners');
const rera = require('../services/rera');

/**
 * V2 §24, §29–§31, §37, §271: the external partner portal.
 *
 * A separate identity from the internal app (§24: "Partner users must never
 * receive access to /app/* internal routes"). Nothing here sets `req.user`, and
 * every read is scoped to the authenticated partner by the service layer.
 */
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

// The portal's own session resolution, ahead of every /cp route.
router.use('/cp', currentPartner);

const shell = (res, view, locals) => res.render(`pages/cp/${view}`, { portalNav: true, ...locals });

/* --------------------------------- auth --------------------------------- */

router.get('/cp/login', (req, res) => {
  if (req.partnerUser) return res.redirect('/cp/dashboard');
  res.render('pages/cp/login', { title: 'Partner login', next: req.query.next });
});

router.post('/cp/login', async (req, res, next) => {
  req.app.locals.limiters.auth(req, res, async () => {
    try {
      const { portalUser } = await partnerPortal.login({
        email: req.body.email, plain: req.body.password,
      });
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.partnerUserId = String(portalUser._id);
        const target = typeof req.body.next === 'string' && req.body.next.startsWith('/cp/')
          ? req.body.next : '/cp/dashboard';
        res.redirect(target);
      });
    } catch (err) { next(err); }
  });
});

router.post('/cp/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/cp/login'));
});

router.get('/cp/activate/:token', (req, res) => {
  res.render('pages/cp/activate', { title: 'Set your password', token: req.params.token });
});

router.post('/cp/activate/:token', async (req, res, next) => {
  req.app.locals.limiters.auth(req, res, async () => {
    try {
      const portalUser = await partnerPortal.activate({
        token: req.params.token, plain: req.body.password,
      });
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.partnerUserId = String(portalUser._id);
        req.session.flash = { type: 'success', message: 'Your password is set. Welcome.' };
        res.redirect('/cp/dashboard');
      });
    } catch (err) { next(err); }
  });
});

/* ------------------------------- dashboard ------------------------------ */

router.get('/cp/dashboard', requirePartner, async (req, res, next) => {
  try {
    const [data, projectRows] = await Promise.all([
      partnerPortal.dashboard({ session: req.partnerSession }),
      partnerPortal.projectPerformance({ session: req.partnerSession }),
    ]);
    const team = req.partnerSession.isCompanyAdmin
      ? await partnerPortal.teamPerformance({ session: req.partnerSession })
      : [];
    const recent = await partnerPortal.leads({ session: req.partnerSession, page: 1, limit: 5 });
    shell(res, 'dashboard', {
      title: 'Partner dashboard', ...data, projectRows, team, recent: recent.rows,
    });
  } catch (err) { next(err); }
});

/* --------------------------------- leads -------------------------------- */

router.get('/cp/leads', requirePartner, async (req, res, next) => {
  try {
    const result = await partnerPortal.leads({
      session: req.partnerSession, query: req.query, page: Number(req.query.page || 1),
    });
    shell(res, 'leads', { title: 'My leads', ...result });
  } catch (err) { next(err); }
});

router.get('/cp/leads/new', requirePartner, requirePartnerWrite, requirePartnerCapability('canSubmitLeads'), async (req, res, next) => {
  try {
    const projects = await partnerPortal.submittableProjects({ session: req.partnerSession });
    const block = await rera.leadSubmissionBlock({
      tenantId: req.tenantId, tenant: req.tenant, partner: req.partner,
    });
    shell(res, 'lead-new', { title: 'Submit a lead', projects, reraBlock: block });
  } catch (err) { next(err); }
});

const leadSchema = z.object({
  projectId: f.optionalId,
  name: f.requiredText(150, 'Enter the customer’s name.'),
  mobile: f.requiredText(20, 'Enter the customer’s mobile number.'),
  email: f.email,
  requirement: f.optionalText(500),
  configuration: f.optionalText(80),
  budgetMin: f.moneyAmount,
  budgetMax: f.moneyAmount,
  preferredVisitDate: f.optionalText(20),
  note: f.optionalText(1000),
});

/**
 * §31/§344: the partner identity comes from the session, never from the form.
 * There is no partner id in this schema on purpose.
 */
router.post('/cp/leads', requirePartner, requirePartnerWrite, requirePartnerCapability('canSubmitLeads'), validate(leadSchema), async (req, res, next) => {
  try {
    const result = await partnerLeads.submit({
      tenantId: req.tenantId,
      tenant: req.tenant,
      partner: req.partner,
      member: req.partnerSession.member,
      submittedByType: 'PARTNER',
      payload: {
        projectId: req.data.projectId,
        name: req.data.name,
        mobile: req.data.mobile,
        email: req.data.email,
        requirement: req.data.requirement,
        configuration: req.data.configuration,
        budgetMinMinor: req.data.budgetMin,
        budgetMaxMinor: req.data.budgetMax,
        preferredVisitDate: req.data.preferredVisitDate,
        note: req.data.note,
      },
    });
    // §309: acknowledge honestly — a conflict is not an accepted attribution.
    req.session.flash = {
      type: result.claim.status === 'ACCEPTED' ? 'success' : 'info',
      message: result.claim.status === 'ACCEPTED'
        ? `Lead submitted. Reference ${result.claim.claimNumber} · accepted.`
        : `Lead submitted. Reference ${result.claim.claimNumber} · ${result.claim.status.toLowerCase().replace('_', ' ')}. ${result.claim.conflictNote || ''}`.trim(),
    };
    res.redirect('/cp/leads');
  } catch (err) { next(err); }
});

/* -------------------------------- visits -------------------------------- */

router.get('/cp/visits', requirePartner, async (req, res, next) => {
  try {
    const { SiteVisit } = require('../db/models');
    const result = await partnerPortal.leads({ session: req.partnerSession, page: 1, limit: 200 });
    const leadIds = result.rows.map((r) => r.claim.leadId).filter(Boolean);
    const visits = await SiteVisit.find({ tenantId: req.tenantId, leadId: { $in: leadIds } })
      .sort({ scheduledAt: -1 })
      .select('leadId status scheduledAt projectId outcomeId')
      .populate('projectId', 'name')
      .lean();
    const byLead = new Map(result.rows.map((r) => [String(r.claim.leadId), r.visible]));
    shell(res, 'visits', {
      title: 'Site visits',
      // §38: the partner sees the plan and whether it happened — not the outcome
      // notes, which are internal unless a tenant chooses otherwise.
      rows: visits.map((v) => ({
        customerName: byLead.get(String(v.leadId))?.customerName,
        project: v.projectId?.name,
        scheduledAt: v.scheduledAt,
        status: v.status,
      })),
    });
  } catch (err) { next(err); }
});

/* ------------------------------- bookings ------------------------------- */

router.get('/cp/bookings', requirePartner, async (req, res, next) => {
  try {
    const rows = await partnerPortal.bookings({ session: req.partnerSession });
    shell(res, 'bookings', { title: 'My bookings', rows });
  } catch (err) { next(err); }
});

/* --------------------------------- team --------------------------------- */

router.get('/cp/team', requirePartner, async (req, res, next) => {
  try {
    if (!req.partnerSession.isCompanyAdmin) throw forbidden('Only a company administrator can manage the team.');
    const [members, performance] = await Promise.all([
      ChannelPartnerMember.find({ tenantId: req.tenantId, channelPartnerId: req.partner._id })
        .sort({ active: -1, name: 1 }).lean(),
      partnerPortal.teamPerformance({ session: req.partnerSession }),
    ]);
    shell(res, 'team', { title: 'My team', members, performance });
  } catch (err) { next(err); }
});

const cpMemberSchema = z.object({
  memberId: f.optionalId,
  name: f.requiredText(150, 'Enter the member’s name.'),
  mobile: f.optionalText(20),
  email: f.optionalText(150),
  designation: f.optionalText(120),
  canSubmitLeads: f.checkbox,
});

router.post('/cp/team', requirePartner, requirePartnerWrite, validate(cpMemberSchema), async (req, res, next) => {
  try {
    if (!req.partnerSession.isCompanyAdmin) throw forbidden('Only a company administrator can manage the team.');
    await channelPartners.saveMember({
      tenantId: req.tenantId,
      tenant: req.tenant,
      channelPartnerId: req.partner._id,
      memberId: req.data.memberId,
      // §23: a partner admin can add staff but cannot grant themselves invoice
      // rights or company-wide visibility — that stays an internal decision.
      data: { ...req.data, portalRole: 'SALES_MEMBER', canCreateInvoice: false, canViewCompanyLeads: false },
    });
    req.session.flash = { type: 'success', message: 'Team saved.' };
    res.redirect('/cp/team');
  } catch (err) { next(err); }
});

/* ------------------------------- invoices ------------------------------- */

router.get('/cp/invoices', requirePartner, async (req, res, next) => {
  try {
    const [invoices, eligible, summary] = await Promise.all([
      PartnerInvoice.find({ tenantId: req.tenantId, channelPartnerId: req.partner._id })
        .sort({ createdAt: -1 }).lean(),
      commissions.eligibleForInvoice({ tenantId: req.tenantId, channelPartnerId: req.partner._id }),
      commissions.summaryFor({ tenantId: req.tenantId, channelPartnerId: req.partner._id }),
    ]);
    shell(res, 'invoices', {
      title: 'Invoices',
      invoices,
      eligible,
      summary,
      canCreate: req.partnerSession.isCompanyAdmin || !!req.partnerSession.member?.canCreateInvoice,
    });
  } catch (err) { next(err); }
});

const cpInvoiceSchema = z.object({
  invoiceId: f.optionalId,
  invoiceNumber: f.requiredText(60, 'Enter your invoice number.'),
  invoiceDate: f.requiredText(20, 'Enter the invoice date.'),
  gstin: f.optionalText(20),
  pan: f.optionalText(12),
  gstAmount: f.moneyAmount,
  otherAdjustment: f.moneyAmount,
  note: f.optionalText(1000),
}).passthrough();

/** §45/§314: build the invoice from eligible lines only. */
router.post('/cp/invoices', requirePartner, requirePartnerWrite, validate(cpInvoiceSchema), async (req, res, next) => {
  try {
    if (!req.partnerSession.isCompanyAdmin && !req.partnerSession.member?.canCreateInvoice) {
      throw forbidden('Your portal account cannot create invoices.');
    }
    const ids = [].concat(req.body.entitlementId || []);
    const amounts = [].concat(req.body.claimAmount || []);
    const lines = ids.map((entitlementId, index) => ({
      commissionEntitlementId: entitlementId,
      invoiceClaimAmountMinor: money.toMinor(amounts[index] || 0),
    })).filter((line) => line.commissionEntitlementId && line.invoiceClaimAmountMinor > 0);

    const invoice = await partnerInvoices.saveDraft({
      tenantId: req.tenantId,
      tenant: req.tenant,
      channelPartnerId: req.partner._id,
      invoiceId: req.data.invoiceId || null,
      // f.moneyAmount has already parsed these into minor units.
      data: {
        ...req.data,
        gstAmountMinor: req.data.gstAmount,
        otherAdjustmentMinor: req.data.otherAdjustment,
      },
      lines,
      portalUser: req.partnerUser,
    });
    req.session.flash = { type: 'success', message: 'Invoice saved as a draft. Attach the PDF and submit it.' };
    res.redirect(`/cp/invoices/${invoice._id}`);
  } catch (err) { next(err); }
});

router.get('/cp/invoices/:id', requirePartner, async (req, res, next) => {
  try {
    const detail = await partnerInvoices.detail({ tenantId: req.tenantId, invoiceId: req.params.id });
    // A partner may only ever open their own invoice (§298).
    if (String(detail.invoice.channelPartnerId?._id || detail.invoice.channelPartnerId) !== String(req.partner._id)) {
      throw notFound('Invoice not found.');
    }
    const eligible = await commissions.eligibleForInvoice({
      tenantId: req.tenantId, channelPartnerId: req.partner._id,
    });
    shell(res, 'invoice-detail', { title: detail.invoice.invoiceNumber || 'Invoice', ...detail, eligible });
  } catch (err) { next(err); }
});

router.post('/cp/invoices/:id/pdf', requirePartner, requirePartnerWrite, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return next(badRequest('That file could not be read. Try a smaller file.'));
    try { csrf.verify(req); } catch (tokenError) { return next(tokenError); }
    next();
  });
}, async (req, res, next) => {
  try {
    await partnerInvoices.attachPdf({
      tenantId: req.tenantId, invoiceId: req.params.id, channelPartnerId: req.partner._id, file: req.file,
    });
    req.session.flash = { type: 'success', message: 'Invoice PDF attached.' };
    res.redirect(`/cp/invoices/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/cp/invoices/:id/submit', requirePartner, requirePartnerWrite, async (req, res, next) => {
  try {
    await partnerInvoices.submit({
      tenantId: req.tenantId, tenant: req.tenant, invoiceId: req.params.id,
      channelPartnerId: req.partner._id, portalUser: req.partnerUser,
    });
    req.session.flash = { type: 'success', message: 'Invoice submitted for review.' };
    res.redirect(`/cp/invoices/${req.params.id}`);
  } catch (err) { next(err); }
});

/** §298: a partner downloads their own invoice PDF, and nobody else's. */
router.get('/cp/invoices/:id/pdf', requirePartner, async (req, res, next) => {
  try {
    const invoice = await PartnerInvoice.findOne({
      tenantId: req.tenantId, _id: req.params.id, channelPartnerId: req.partner._id,
    }).lean();
    if (!invoice?.invoicePdf?.storageKey) throw notFound('That file could not be found.');
    const privateFiles = require('../lib/privateFiles');
    const bytes = await privateFiles.read(invoice.invoicePdf.storageKey);
    res.setHeader('Content-Type', invoice.invoicePdf.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${privateFiles.downloadName(invoice.invoicePdf.fileLabel, invoice.invoicePdf.mimeType)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(bytes);
  } catch (err) { next(err); }
});

/* ---------------------------- profile & RERA ---------------------------- */

router.get('/cp/profile', requirePartner, async (req, res, next) => {
  try {
    const history = await rera.historyFor({ tenantId: req.tenantId, channelPartnerId: req.partner._id });
    shell(res, 'profile', {
      title: 'My profile',
      history,
      reraBanner: rera.expiryBanner({
        partner: req.partner, zone: res.locals.zone, locale: req.tenant?.locale,
      }),
    });
  } catch (err) { next(err); }
});

/** §217: the partner uploads their own renewal. The old version is kept. */
router.post('/cp/profile/rera', requirePartner, requirePartnerWrite, (req, res, next) => {
  upload.single('certificate')(req, res, (err) => {
    if (err) return next(badRequest('That file could not be read. Try a smaller file.'));
    try { csrf.verify(req); } catch (tokenError) { return next(tokenError); }
    next();
  });
}, async (req, res, next) => {
  try {
    await rera.addVersion({
      tenantId: req.tenantId,
      channelPartnerId: req.partner._id,
      data: req.body,
      file: req.file,
      uploadedByType: 'PARTNER',
    });
    req.session.flash = {
      type: 'success',
      message: 'Certificate uploaded. It will be active once our team verifies it.',
    };
    res.redirect('/cp/profile');
  } catch (err) { next(err); }
});

/* ----------------------- public self registration ----------------------- */

/** §14: only when the tenant switched it on. */
router.get('/cp/register', async (req, res, next) => {
  try {
    // No session: the tenant is resolved from the single active organization,
    // which is how every other public route in this product works.
    const tenant = await Tenant.findOne({ status: 'ACTIVE' }).lean();
    if (!tenant?.settings?.cpPublicRegistrationEnabled) {
      return res.status(404).render('pages/public/not-found', { title: 'Not found' });
    }
    res.render('pages/cp/register', { title: 'Become a channel partner', tenant, submitted: req.query.submitted === '1' });
  } catch (err) { next(err); }
});

router.post('/cp/register', async (req, res, next) => {
  req.app.locals.limiters.public(req, res, async () => {
    try {
      const tenant = await Tenant.findOne({ status: 'ACTIVE' }).lean();
      if (!tenant?.settings?.cpPublicRegistrationEnabled) throw forbidden('Public registration is not enabled.');
      const registration = await channelPartners.createRegistration({
        tenantId: tenant._id, tenant, data: req.body, submissionSource: 'PUBLIC_SELF',
      });
      // §14: a self-registration still requires internal approval — it is
      // submitted straight away so the CP team can see it.
      await channelPartners.submitRegistration({
        tenantId: tenant._id, tenant, registrationId: registration._id,
      }).catch(() => null);
      res.redirect('/cp/register?submitted=1');
    } catch (err) { next(err); }
  });
});

module.exports = router;
