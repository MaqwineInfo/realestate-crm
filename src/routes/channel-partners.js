const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const csrf = require('../middleware/csrf');
const f = require('../lib/fields');
const config = require('../config');
const money = require('../lib/money');
const { can } = require('../lib/access');
const { badRequest, notFound } = require('../lib/errors');
const {
  ChannelPartner, ChannelPartnerRegistration, PartnerCommissionRule, PartnerInvoice, Project,
} = require('../db/models');
const channelPartners = require('../services/channelPartners');
const rera = require('../services/rera');
const partnerLeads = require('../services/partnerLeads');
const commissions = require('../services/commissions');
const partnerInvoices = require('../services/partnerInvoices');
const partnerReports = require('../services/partnerReports');

/**
 * V2 §8: the internal channel-partner screens. Thin routes; the rules live in
 * the services. The partner-facing portal is a separate router with a separate
 * identity (routes/cp-portal.js).
 */
const router = express.Router();
router.use('/app/channel-partners', requireAuth);
router.use('/api/channel-partners', requireAuth);
router.use('/api/channel-partner-claims', requireAuth);
router.use('/api/partner-invoices', requireAuth);
router.use('/api/setup/cp', requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const withFile = (field) => (req, res, next) => {
  upload.single(field)(req, res, (err) => {
    if (err) return next(badRequest('That file could not be read. Check the size and try again.'));
    try { csrf.verify(req); } catch (tokenError) { return next(tokenError); }
    next();
  });
};

function safeReturn(req, fallback) {
  const target = req.data?.returnTo || req.body?.returnTo;
  return typeof target === 'string' && target.startsWith('/app/') ? target : fallback;
}

/* ------------------------------- dashboard ------------------------------- */

router.get('/app/channel-partners/dashboard', requirePermission('cp.dashboard'), async (req, res, next) => {
  try {
    const [data, performers, projects] = await Promise.all([
      partnerReports.dashboard({ tenantId: req.tenantId, query: req.query, zone: res.locals.zone }),
      partnerReports.topPerformers({ tenantId: req.tenantId, query: req.query, zone: res.locals.zone }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/channel-partners/dashboard', {
      title: 'Channel partners', data, performers, projects,
      rankBy: req.query.rankBy || 'bookings',
    });
  } catch (err) { next(err); }
});

/* ------------------------------ partner list ---------------------------- */

router.get('/app/channel-partners', requirePermission('cp.partner.view'), async (req, res, next) => {
  try {
    const result = await channelPartners.listPartners({
      tenantId: req.tenantId, query: req.query, page: Number(req.query.page || 1),
    });
    res.render('pages/channel-partners/list', { title: 'Channel partners', ...result });
  } catch (err) { next(err); }
});

/* ----------------------------- registrations ---------------------------- */

router.get('/app/channel-partners/registrations', requirePermission('cp.registration.view'), async (req, res, next) => {
  try {
    const result = await channelPartners.listRegistrations({
      tenantId: req.tenantId, query: req.query, page: Number(req.query.page || 1), zone: res.locals.zone,
    });
    res.render('pages/channel-partners/registrations', {
      title: 'Partner registrations',
      ...result,
      statuses: ChannelPartnerRegistration.STATUSES,
    });
  } catch (err) { next(err); }
});

router.get('/app/channel-partners/registrations/new', requirePermission('cp.partner.create'), (req, res) => {
  res.render('pages/channel-partners/registration-form', {
    title: 'New channel partner',
    registration: null,
    step: 1,
    rera: null,
    projects: [],
  });
});

router.get('/app/channel-partners/registrations/:id', requirePermission('cp.registration.view'), async (req, res, next) => {
  try {
    const registration = await ChannelPartnerRegistration.findOne({ tenantId: req.tenantId, _id: req.params.id })
      .populate('reviewedBy', 'name').populate('channelPartnerId', 'partnerCode status').lean();
    if (!registration) throw notFound('Registration not found.');

    const { PartnerReraDocument } = require('../db/models');
    const [certificate, projects, duplicates] = await Promise.all([
      PartnerReraDocument.findOne({ tenantId: req.tenantId, registrationId: registration._id, active: true }).lean(),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true }, channelPartnerEnabled: { $ne: false } })
        .select('name').sort({ name: 1 }).lean(),
      channelPartners.findDuplicates({
        tenantId: req.tenantId, profile: registration.profile, excludeRegistrationId: registration._id,
      }),
    ]);
    const step = Math.min(channelPartners.STEP_COUNT, Math.max(1, Number(req.query.step || 1)));
    res.render('pages/channel-partners/registration-form', {
      title: registration.registrationNumber || 'Registration',
      registration,
      step,
      rera: certificate,
      duplicates,
      projects,
      canReview: can(req.user, 'cp.registration.review'),
    });
  } catch (err) { next(err); }
});

const profileSchema = z.object({
  partnerType: f.enumField(['COMPANY', 'INDIVIDUAL']),
  primaryContactName: f.optionalText(150),
  mobile: f.optionalText(20),
  email: f.optionalText(150),
  city: f.optionalText(80),
  state: f.optionalText(80),
  address: f.optionalText(500),
  pincode: f.optionalText(12),
  legalName: f.optionalText(200),
  tradeName: f.optionalText(200),
  constitutionType: f.optionalText(40),
  pan: f.optionalText(12),
  gstin: f.optionalText(20),
  companyRegistrationNumber: f.optionalText(40),
  registeredAddress: f.optionalText(500),
  correspondenceAddress: f.optionalText(500),
  website: f.optionalText(200),
  yearsInBusiness: f.optionalNumber,
  signatoryName: f.optionalText(150),
  signatoryMobile: f.optionalText(20),
  signatoryEmail: f.optionalText(150),
  accountHolderName: f.optionalText(150),
  bankName: f.optionalText(120),
  accountNumber: f.optionalText(30),
  ifsc: f.optionalText(15),
  branch: f.optionalText(120),
  billingAddress: f.optionalText(500),
  defaultInvoiceTaxMode: f.optionalText(30),
  msmeNumber: f.optionalText(40),
  step: f.optionalNumber,
  returnTo: f.optionalText(300),
}).passthrough();

router.post('/api/channel-partners/registrations', requirePermission('cp.partner.create'), validate(profileSchema), async (req, res, next) => {
  try {
    const registration = await channelPartners.createRegistration({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, data: req.data,
    });
    req.session.flash = { type: 'success', message: 'Application started. Continue through the steps.' };
    res.redirect(`/app/channel-partners/registrations/${registration._id}?step=2`);
  } catch (err) { next(err); }
});

router.post('/api/channel-partners/registrations/:id', requirePermission('cp.partner.create', 'cp.partner.edit'), validate(profileSchema), async (req, res, next) => {
  try {
    await channelPartners.updateRegistration({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      registrationId: req.params.id, data: req.data, step: req.data.step,
    });
    const next_ = Math.min(channelPartners.STEP_COUNT, Number(req.data.step || 1) + 1);
    req.session.flash = { type: 'success', message: 'Saved.' };
    res.redirect(`/app/channel-partners/registrations/${req.params.id}?step=${next_}`);
  } catch (err) { next(err); }
});

/** §18: the GujRERA step. Multipart, because the certificate comes with it. */
router.post('/api/channel-partners/registrations/:id/rera', requirePermission('cp.partner.create', 'cp.partner.edit'), withFile('certificate'), async (req, res, next) => {
  try {
    const registration = await ChannelPartnerRegistration.findOne({
      tenantId: req.tenantId, _id: req.params.id,
    }).lean();
    if (!registration) throw notFound('Registration not found.');
    await rera.addVersion({
      tenantId: req.tenantId,
      actor: req.user,
      registrationId: registration._id,
      data: req.body,
      file: req.file,
    });
    await channelPartners.updateRegistration({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      registrationId: req.params.id, data: registration.profile, step: 3,
    });
    req.session.flash = { type: 'success', message: 'RERA certificate recorded.' };
    res.redirect(`/app/channel-partners/registrations/${req.params.id}?step=4`);
  } catch (err) { next(err); }
});

router.post('/api/channel-partners/registrations/:id/submit', requirePermission('cp.partner.create', 'cp.partner.edit'), async (req, res, next) => {
  try {
    await channelPartners.submitRegistration({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, registrationId: req.params.id,
    });
    req.session.flash = { type: 'success', message: 'Application submitted for review.' };
    res.redirect(`/app/channel-partners/registrations/${req.params.id}`);
  } catch (err) { next(err); }
});

const reviewSchema = z.object({
  decision: z.enum(['UNDER_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED']),
  note: f.optionalText(1000),
  invite: f.checkbox,
  returnTo: f.optionalText(300),
});

/** §13/§308: the review decision, with "Approve & invite" in one action. */
router.post('/api/channel-partners/registrations/:id/review', requirePermission('cp.registration.review'), validate(reviewSchema), async (req, res, next) => {
  try {
    const result = await channelPartners.reviewRegistration({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      registrationId: req.params.id, decision: req.data.decision, note: req.data.note,
      invite: req.data.invite === true,
    });
    if (result.portalUser?.url) {
      // §117-style: the activation link is shown once, on the next page.
      req.session.freshPortalInvite = {
        partnerId: String(result.partner._id),
        url: result.portalUser.url,
        email: result.portalUser.portalUser.email,
      };
    }
    req.session.flash = {
      type: 'success',
      message: result.partner
        ? `Approved. ${channelPartners.displayNameOf(result.partner.profile)} is now an active partner.`
        : 'Decision saved.',
    };
    res.redirect(result.partner
      ? `/app/channel-partners/${result.partner._id}`
      : `/app/channel-partners/registrations/${req.params.id}`);
  } catch (err) { next(err); }
});

/* ------------------------------- claims --------------------------------- */

router.get('/app/channel-partners/claims', requirePermission('cp.claim.view'), async (req, res, next) => {
  try {
    const [result, projects] = await Promise.all([
      partnerLeads.claimQueue({
        tenantId: req.tenantId, query: req.query, page: Number(req.query.page || 1),
      }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/channel-partners/claims', {
      title: 'Partner lead claims', ...result, projects,
      canReview: can(req.user, 'cp.claim.review'),
    });
  } catch (err) { next(err); }
});

const claimReviewSchema = z.object({
  decision: z.enum(['ACCEPTED', 'REJECTED', 'KEEP_EXISTING']),
  note: f.optionalText(500),
  returnTo: f.optionalText(300),
});

router.post('/api/channel-partner-claims/:id/review', requirePermission('cp.claim.review'), validate(claimReviewSchema), async (req, res, next) => {
  try {
    await partnerLeads.reviewClaim({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      claimId: req.params.id,
      decision: req.data.decision === 'KEEP_EXISTING' ? 'REJECTED' : req.data.decision,
      note: req.data.decision === 'KEEP_EXISTING'
        ? `Existing partner kept. ${req.data.note || ''}`.trim()
        : req.data.note,
    });
    req.session.flash = { type: 'success', message: 'Claim decision recorded.' };
    res.redirect(safeReturn(req, '/app/channel-partners/claims'));
  } catch (err) { next(err); }
});

/* ------------------------------- invoices ------------------------------- */

router.get('/app/channel-partners/invoices', requirePermission('cp.invoice.view'), async (req, res, next) => {
  try {
    const result = await partnerInvoices.list({
      tenantId: req.tenantId, query: req.query, page: Number(req.query.page || 1),
    });
    res.render('pages/channel-partners/invoices', {
      title: 'Partner invoices', ...result, statuses: PartnerInvoice.STATUSES,
    });
  } catch (err) { next(err); }
});

router.get('/app/channel-partners/invoices/:id', requirePermission('cp.invoice.view'), async (req, res, next) => {
  try {
    const detail = await partnerInvoices.detail({ tenantId: req.tenantId, invoiceId: req.params.id });
    res.render('pages/channel-partners/invoice-detail', {
      title: detail.invoice.invoiceNumber || detail.invoice.invoiceRef,
      ...detail,
      canReview: can(req.user, 'cp.invoice.review'),
      canPay: can(req.user, 'cp.invoice.mark_paid'),
      showBank: can(req.user, 'cp.partner.view_bank'),
    });
  } catch (err) { next(err); }
});

const invoiceReviewSchema = z.object({
  decision: z.enum(['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CORRECTION_REQUIRED']),
  note: f.optionalText(1000),
  returnTo: f.optionalText(300),
});

router.post('/api/partner-invoices/:id/review', requirePermission('cp.invoice.review'), validate(invoiceReviewSchema), async (req, res, next) => {
  try {
    await partnerInvoices.review({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      invoiceId: req.params.id, decision: req.data.decision, note: req.data.note,
    });
    req.session.flash = { type: 'success', message: 'Invoice decision recorded.' };
    res.redirect(safeReturn(req, `/app/channel-partners/invoices/${req.params.id}`));
  } catch (err) { next(err); }
});

const payoutSchema = z.object({
  amount: f.moneyAmount,
  payoutDate: f.optionalText(20),
  transactionReference: f.optionalText(120),
  deduction: f.moneyAmount,
  deductionNote: f.optionalText(300),
  note: f.optionalText(500),
  returnTo: f.optionalText(300),
});

/** §50: record that money left. Not an accounting entry. */
router.post('/api/partner-invoices/:id/payment', requirePermission('cp.invoice.mark_paid'), validate(payoutSchema), async (req, res, next) => {
  try {
    await partnerInvoices.recordPayout({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, invoiceId: req.params.id,
      amountMinor: req.data.amount, payoutDate: req.data.payoutDate,
      transactionReference: req.data.transactionReference,
      deductionMinor: req.data.deduction || 0, deductionNote: req.data.deductionNote, note: req.data.note,
    });
    req.session.flash = { type: 'success', message: 'Payout recorded.' };
    res.redirect(safeReturn(req, `/app/channel-partners/invoices/${req.params.id}`));
  } catch (err) { next(err); }
});

router.post('/api/partner-invoices/:id/processing', requirePermission('cp.invoice.mark_paid'), async (req, res, next) => {
  try {
    await partnerInvoices.markProcessing({ tenantId: req.tenantId, actor: req.user, invoiceId: req.params.id });
    req.session.flash = { type: 'success', message: 'Marked as payment processing.' };
    res.redirect(safeReturn(req, `/app/channel-partners/invoices/${req.params.id}`));
  } catch (err) { next(err); }
});

/* --------------------------- partner workspace -------------------------- */

router.get('/app/channel-partners/:id', requirePermission('cp.partner.view'), async (req, res, next) => {
  try {
    const data = await channelPartners.workspace({
      tenantId: req.tenantId, channelPartnerId: req.params.id,
      zone: res.locals.zone, locale: req.tenant?.locale,
    });
    const tabs = ['overview', 'team', 'projects', 'leads', 'bookings', 'commission', 'invoices', 'documents', 'audit'];
    const [projects, funnel, summary, rules] = await Promise.all([
      Project.find({ tenantId: req.tenantId, archived: { $ne: true }, channelPartnerEnabled: { $ne: false } })
        .select('name').sort({ name: 1 }).lean(),
      partnerReports.funnelFor({ tenantId: req.tenantId, channelPartnerId: req.params.id }),
      commissions.summaryFor({ tenantId: req.tenantId, channelPartnerId: req.params.id }),
      can(req.user, 'cp.commission.view') ? commissions.listRules({ tenantId: req.tenantId }) : [],
    ]);

    res.render('pages/channel-partners/workspace', {
      title: channelPartners.displayNameOf(data.partner.profile),
      ...data,
      tab: tabs.includes(req.query.tab) ? req.query.tab : 'overview',
      tabs,
      projects,
      funnel,
      conversions: partnerReports.conversions(funnel),
      summary,
      rules,
      // §21: bank details are a separate permission from seeing the partner.
      showBank: can(req.user, 'cp.partner.view_bank'),
      freshInvite: req.session.freshPortalInvite?.partnerId === String(req.params.id)
        ? req.session.freshPortalInvite : null,
      returnTo: req.originalUrl,
    });
    delete req.session.freshPortalInvite;
  } catch (err) { next(err); }
});

const statusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'INACTIVE', 'EXPIRED']),
  reason: f.optionalText(500),
  returnTo: f.optionalText(300),
});

router.post('/api/channel-partners/:id/status', requirePermission('cp.partner.edit'), validate(statusSchema), async (req, res, next) => {
  try {
    await channelPartners.setStatus({
      tenantId: req.tenantId, actor: req.user, channelPartnerId: req.params.id,
      status: req.data.status, reason: req.data.reason,
    });
    req.session.flash = { type: 'success', message: 'Partner status updated. History is unchanged.' };
    res.redirect(safeReturn(req, `/app/channel-partners/${req.params.id}`));
  } catch (err) { next(err); }
});

const memberSchema = z.object({
  memberId: f.optionalId,
  name: f.requiredText(150, 'Enter the member’s name.'),
  mobile: f.optionalText(20),
  email: f.optionalText(150),
  designation: f.optionalText(120),
  portalRole: f.enumField(['COMPANY_ADMIN', 'SALES_MEMBER']),
  reraNumber: f.optionalText(60),
  canSubmitLeads: f.checkbox,
  canViewCompanyLeads: f.checkbox,
  canCreateInvoice: f.checkbox,
  portalLoginEnabled: f.checkbox,
  returnTo: f.optionalText(300),
});

router.post('/api/channel-partners/:id/team', requirePermission('cp.team.manage'), validate(memberSchema), async (req, res, next) => {
  try {
    await channelPartners.saveMember({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      channelPartnerId: req.params.id, memberId: req.data.memberId, data: req.data,
    });
    req.session.flash = { type: 'success', message: 'Team saved.' };
    res.redirect(safeReturn(req, `/app/channel-partners/${req.params.id}?tab=team`));
  } catch (err) { next(err); }
});

router.post('/api/channel-partners/:id/team/:memberId/toggle', requirePermission('cp.team.manage'), async (req, res, next) => {
  try {
    const { ChannelPartnerMember } = require('../db/models');
    const member = await ChannelPartnerMember.findOne({
      tenantId: req.tenantId, _id: req.params.memberId, channelPartnerId: req.params.id,
    }).lean();
    if (!member) throw notFound('Team member not found.');
    await channelPartners.setMemberActive({
      tenantId: req.tenantId, actor: req.user, memberId: req.params.memberId, active: !member.active,
    });
    req.session.flash = { type: 'success', message: 'Team member updated. Their history is kept.' };
    res.redirect(safeReturn(req, `/app/channel-partners/${req.params.id}?tab=team`));
  } catch (err) { next(err); }
});

const inviteSchema = z.object({
  memberId: f.optionalId,
  name: f.optionalText(150),
  email: f.requiredEmail,
  mobile: f.optionalText(20),
  role: f.enumField(['COMPANY_ADMIN', 'SALES_MEMBER']),
  returnTo: f.optionalText(300),
});

router.post('/api/channel-partners/:id/portal-invite', requirePermission('cp.team.manage'), validate(inviteSchema), async (req, res, next) => {
  try {
    const result = await channelPartners.invitePortalUser({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, channelPartnerId: req.params.id,
      memberId: req.data.memberId, name: req.data.name, email: req.data.email,
      mobile: req.data.mobile, role: req.data.role,
    });
    req.session.freshPortalInvite = {
      partnerId: String(req.params.id), url: result.url, email: req.data.email,
    };
    req.session.flash = { type: 'success', message: 'Invitation sent. The activation link is shown once below.' };
    res.redirect(safeReturn(req, `/app/channel-partners/${req.params.id}?tab=team`));
  } catch (err) { next(err); }
});

const empanelmentSchema = z.object({
  projectId: f.objectId,
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'EXPIRED']),
  effectiveFrom: f.optionalText(20),
  effectiveTo: f.optionalText(20),
  commissionRuleId: f.optionalId,
  notes: f.optionalText(1000),
  returnTo: f.optionalText(300),
});

router.post('/api/channel-partners/:id/empanelments', requirePermission('cp.project_empanelment.manage'), validate(empanelmentSchema), async (req, res, next) => {
  try {
    await channelPartners.saveEmpanelment({
      tenantId: req.tenantId, actor: req.user, channelPartnerId: req.params.id,
      projectId: req.data.projectId, status: req.data.status,
      effectiveFrom: req.data.effectiveFrom, effectiveTo: req.data.effectiveTo,
      commissionRuleId: req.data.commissionRuleId, notes: req.data.notes,
    });
    req.session.flash = { type: 'success', message: 'Empanelment saved.' };
    res.redirect(safeReturn(req, `/app/channel-partners/${req.params.id}?tab=projects`));
  } catch (err) { next(err); }
});

/** §217: a renewal, uploaded by the CP team on the partner's behalf. */
router.post('/api/channel-partners/:id/rera', requirePermission('cp.partner.edit'), withFile('certificate'), async (req, res, next) => {
  try {
    await rera.addVersion({
      tenantId: req.tenantId, actor: req.user, channelPartnerId: req.params.id,
      data: req.body, file: req.file,
    });
    req.session.flash = { type: 'success', message: 'RERA certificate recorded. The previous version is kept.' };
    res.redirect(`/app/channel-partners/${req.params.id}?tab=documents`);
  } catch (err) { next(err); }
});

const reraVerifySchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  note: f.optionalText(500),
  returnTo: f.optionalText(300),
});

router.post('/api/channel-partners/:id/rera/:documentId/verify', requirePermission('cp.registration.review', 'cp.partner.edit'), validate(reraVerifySchema), async (req, res, next) => {
  try {
    await rera.verify({
      tenantId: req.tenantId, actor: req.user, reraDocumentId: req.params.documentId,
      decision: req.data.decision, note: req.data.note,
    });
    req.session.flash = { type: 'success', message: `RERA certificate ${req.data.decision.toLowerCase()}.` };
    res.redirect(safeReturn(req, `/app/channel-partners/${req.params.id}?tab=documents`));
  } catch (err) { next(err); }
});

/** §21: the full bank account number, behind its own permission and audited. */
router.post('/api/channel-partners/:id/reveal-bank', requirePermission('cp.partner.view_bank'), async (req, res, next) => {
  try {
    const partner = await ChannelPartner.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!partner) throw notFound('Channel partner not found.');
    const sealed = partner.profile?.bank?.accountNumberSealed;
    await require('../services/audit').record({
      tenantId: req.tenantId, actor: req.user, entity: 'ChannelPartner', entityId: partner._id,
      action: 'REVEAL_BANK', req,
    });
    req.session.flash = {
      type: 'info',
      message: sealed
        ? `Account number: ${require('../lib/secretbox').open(sealed)}`
        : 'No bank account number on file.',
    };
    res.redirect(`/app/channel-partners/${req.params.id}?tab=overview`);
  } catch (err) { next(err); }
});

/* ------------------------- commission rules setup ----------------------- */

router.get('/app/setup/channel-partner', requirePermission('cp.commission.manage_rules'), async (req, res, next) => {
  try {
    const [rules, projects, partners] = await Promise.all([
      commissions.listRules({ tenantId: req.tenantId }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      ChannelPartner.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('profile partnerCode').lean(),
    ]);
    res.render('pages/setup/channel-partner', {
      title: 'Channel partner',
      rules,
      projects,
      partners,
      settings: req.tenant.settings || {},
      bases: PartnerCommissionRule.BASES,
      rateTypes: PartnerCommissionRule.RATE_TYPES,
      triggers: PartnerCommissionRule.TRIGGERS,
    });
  } catch (err) { next(err); }
});

const ruleSchema = z.object({
  ruleId: f.optionalId,
  name: f.requiredText(120, 'Name this rule.'),
  projectId: f.optionalId,
  channelPartnerId: f.optionalId,
  partnerType: f.enumField(['COMPANY', 'INDIVIDUAL']),
  basis: f.enumField(PartnerCommissionRule.BASES),
  rateType: f.enumField(PartnerCommissionRule.RATE_TYPES),
  rate: f.optionalNumber,
  fixedAmount: f.moneyAmount,
  eligibilityTrigger: f.enumField(PartnerCommissionRule.TRIGGERS),
  collectionThresholdPct: f.optionalNumber,
  effectiveFrom: f.optionalText(20),
  effectiveTo: f.optionalText(20),
  notes: f.optionalText(1000),
}).passthrough();

router.post('/api/setup/cp/commission-rules', requirePermission('cp.commission.manage_rules'), validate(ruleSchema), async (req, res, next) => {
  try {
    await commissions.saveRule({
      tenantId: req.tenantId, actor: req.user, ruleId: req.data.ruleId || null, data: req.data,
    });
    req.session.flash = { type: 'success', message: 'Commission rule saved. It applies to bookings from now on.' };
    res.redirect('/app/setup/channel-partner');
  } catch (err) { next(err); }
});

router.post('/api/setup/cp/commission-rules/:id/toggle', requirePermission('cp.commission.manage_rules'), async (req, res, next) => {
  try {
    await commissions.toggleRule({ tenantId: req.tenantId, actor: req.user, ruleId: req.params.id });
    res.redirect('/app/setup/channel-partner');
  } catch (err) { next(err); }
});

const cpSettingsSchema = z.object({
  cpPublicRegistrationEnabled: f.checkbox,
  cpRequireRera: f.checkbox,
  cpRequireVerifiedReraForActivation: f.checkbox,
  cpRequireValidReraForLeadSubmission: f.checkbox,
  cpLeadProtectionDays: f.optionalNumber,
  cpClaimConflictMode: f.enumField(['AUTO_REJECT', 'REVIEW', 'ACCEPT_IF_INACTIVE_FOR_N_DAYS']),
  cpClaimInactiveDays: f.optionalNumber,
  cpRequireProjectEmpanelment: f.checkbox,
  cpReraExpiryReminderDays: f.optionalText(60),
}).passthrough();

router.post('/api/setup/cp/settings', requirePermission('cp.commission.manage_rules'), validate(cpSettingsSchema), async (req, res, next) => {
  try {
    const { Tenant } = require('../db/models');
    const d = req.data;
    const bands = String(d.cpReraExpiryReminderDays || '').split(',')
      .map((n) => Number(String(n).trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 365);
    await Tenant.updateOne({ _id: req.tenantId }, {
      $set: {
        'settings.cpPublicRegistrationEnabled': !!d.cpPublicRegistrationEnabled,
        'settings.cpRequireRera': !!d.cpRequireRera,
        'settings.cpRequireVerifiedReraForActivation': !!d.cpRequireVerifiedReraForActivation,
        'settings.cpRequireValidReraForLeadSubmission': !!d.cpRequireValidReraForLeadSubmission,
        'settings.cpLeadProtectionDays': Math.min(730, Math.max(0, Number(d.cpLeadProtectionDays || 90))),
        'settings.cpClaimConflictMode': d.cpClaimConflictMode || 'REVIEW',
        'settings.cpClaimInactiveDays': Math.min(365, Math.max(1, Number(d.cpClaimInactiveDays || 30))),
        'settings.cpRequireProjectEmpanelment': !!d.cpRequireProjectEmpanelment,
        ...(bands.length ? { 'settings.cpReraExpiryReminderDays': [...new Set(bands)].sort((a, b) => b - a) } : {}),
      },
    });
    req.session.flash = { type: 'success', message: 'Channel partner settings saved.' };
    res.redirect('/app/setup/channel-partner');
  } catch (err) { next(err); }
});

module.exports = router;
