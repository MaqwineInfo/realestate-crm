const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const { scopeFilter, scopeOf, can } = require('../lib/access');
const { forbidden, badRequest, notFound } = require('../lib/errors');
const {
  Booking, Project, User, CollectionFollowUp, BookingReceipt, KycDocumentType, Template,
} = require('../db/models');
const postBooking = require('../services/postBooking');
const collections = require('../services/collections');
const collectionFollowups = require('../services/collectionFollowups');
const installments = require('../services/installments');
const bookingForm = require('../services/bookingForm');
const kyc = require('../services/kyc');
const payments = require('../services/payments');
const receipts = require('../services/receipts');

/**
 * V2 §109–§113 (booking workspace) and §150/§222/§223 (collections as a work
 * queue). Thin routes: every rule lives in the services.
 */
const router = express.Router();
router.use('/app/bookings', requireAuth);
router.use('/app/collections', requireAuth);
router.use('/api/bookings', requireAuth);
router.use('/api/collection-followups', requireAuth);
router.use('/api/kyc-documents', requireAuth);
router.use('/api/payment-requests', requireAuth);
router.use('/api/receipts', requireAuth);

/* -------------------------------- booking list ---------------------------- */

router.get('/app/bookings', requirePermission('booking.view', 'collection.view'), async (req, res, next) => {
  try {
    /**
     * §183: two different owners can grant sight of a booking — the salesperson
     * who sold it and the user who collects on it. A user sees the union of
     * whichever of the two scopes they hold; an 'all' scope on either wins.
     */
    const [salesScope, collectionScope] = await Promise.all([
      scopeFilter(req.user, 'booking.view', 'salespersonId'),
      scopeFilter(req.user, 'collection.view', 'collectionOwnerUserId'),
    ]);
    if (!salesScope && !collectionScope) throw forbidden('You do not have permission to view bookings.');
    const narrow = [salesScope, collectionScope].filter((sc) => sc && Object.keys(sc).length);
    const unrestricted = [salesScope, collectionScope].some((sc) => sc && !Object.keys(sc).length);
    const scope = unrestricted ? {} : (narrow.length > 1 ? { $or: narrow } : narrow[0]);

    const result = await postBooking.list({
      tenantId: req.tenantId, scope, query: req.query,
      page: Number(req.query.page || 1), tz: res.locals.zone,
    });
    const [projects, owners] = await Promise.all([
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean(),
    ]);
    res.render('pages/bookings/list', {
      title: 'Bookings', ...result, projects, owners,
    });
  } catch (err) { next(err); }
});

/* --------------------------- KYC review queue (§129) ---------------------- */

router.get('/app/bookings/kyc', requirePermission('booking.kyc.view', 'booking.view'), async (req, res, next) => {
  try {
    const result = await kyc.queue({
      tenantId: req.tenantId, user: req.user, query: req.query, page: Number(req.query.page || 1),
    });
    if (!result) throw forbidden('You do not have permission to view KYC.');
    const projects = await Project.find({ tenantId: req.tenantId, archived: { $ne: true } })
      .select('name').sort({ name: 1 }).lean();
    res.render('pages/bookings/kyc-queue', {
      title: 'KYC review',
      ...result,
      projects,
      activeStatus: kyc.QUEUE_STATUSES.includes(req.query.kycStatus) ? req.query.kycStatus : null,
    });
  } catch (err) { next(err); }
});

/* ----------------------------- booking workspace -------------------------- */

router.get('/app/bookings/:id', requirePermission('booking.view', 'collection.view'), async (req, res, next) => {
  try {
    const detail = await collections.bookingDetail({
      tenantId: req.tenantId, bookingId: req.params.id, zone: res.locals.zone,
    });
    await postBooking.assertCanView({ user: req.user, booking: detail.booking });
    const booking = detail.booking;

    const tabs = ['overview', 'customer', 'collections', 'documents', 'timeline'];
    const [collectionUsers, formStatus, checklist, paymentRequests, receiptRows, kycTypes] = await Promise.all([
      can(req.user, 'collection.assign')
        ? User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean()
        : [],
      bookingForm.statusFor({ tenantId: req.tenantId, bookingId: req.params.id }),
      kyc.checklist({ tenantId: req.tenantId, bookingId: req.params.id }),
      payments.forBooking({ tenantId: req.tenantId, bookingId: req.params.id }),
      receipts.forBooking({ tenantId: req.tenantId, bookingId: req.params.id }),
      KycDocumentType.find({ tenantId: req.tenantId, active: true }).sort({ displayOrder: 1 }).lean(),
    ]);

    res.render('pages/bookings/workspace', {
      title: booking.bookingNumber || 'Booking',
      ...detail,
      tab: tabs.includes(req.query.tab) ? req.query.tab : 'overview',
      tabs,
      collectionUsers,
      justBooked: req.query.created === '1',
      actionTypes: CollectionFollowUp.ACTION_TYPES,
      outcomes: CollectionFollowUp.OUTCOMES,
      formStatus,
      checklist,
      paymentRequests,
      receipts: receiptRows,
      kycTypes,
      receiptModes: BookingReceipt.MODES,
      allowCash: req.tenant?.settings?.collectionAllowCash !== false,
      // The token exists for one request only — right after generation (§117).
      freshLink: req.session.freshCustomerLink?.bookingId === String(req.params.id)
        ? req.session.freshCustomerLink
        : null,
      returnTo: req.originalUrl,
    });
    delete req.session.freshCustomerLink;
  } catch (err) { next(err); }
});

/* ------------------------------ collection queue -------------------------- */

router.get('/app/collections', requirePermission('collection.dashboard', 'collection.view'), async (req, res, next) => {
  try {
    const tab = collections.TABS.includes(req.query.tab) ? req.query.tab : 'due-today';
    const [tiles, queue, snapshot, aging, projects, owners] = await Promise.all([
      collections.tiles({ tenantId: req.tenantId, user: req.user, zone: res.locals.zone }),
      collections.queue({
        tenantId: req.tenantId, user: req.user, tab, query: req.query,
        page: Number(req.query.page || 1), zone: res.locals.zone,
      }),
      collections.snapshot({ tenantId: req.tenantId, user: req.user, zone: res.locals.zone }),
      collections.aging({ tenantId: req.tenantId, user: req.user, zone: res.locals.zone }),
      Project.find({ tenantId: req.tenantId, archived: { $ne: true } }).select('name').sort({ name: 1 }).lean(),
      can(req.user, 'collection.assign')
        ? User.find({ tenantId: req.tenantId, status: 'ACTIVE' }).select('name').sort({ name: 1 }).lean()
        : [],
    ]);

    res.render('pages/collections/queue', {
      title: 'Collections',
      tiles,
      ...queue,
      snapshot,
      aging,
      projects,
      owners,
      actionTypes: CollectionFollowUp.ACTION_TYPES,
      outcomes: CollectionFollowUp.OUTCOMES,
      isManagerView: ['team', 'all'].includes(scopeOf(req.user, 'collection.view')),
      returnTo: req.originalUrl,
    });
  } catch (err) { next(err); }
});

/* --------------------------------- actions -------------------------------- */

const transferSchema = z.object({
  newOwnerUserId: f.objectId,
  reason: f.requiredText(300, 'Give a reason for the transfer.'),
  includePending: f.checkbox,
  returnTo: f.optionalText(300),
});

router.post('/api/bookings/:id/collection-owner', requirePermission('collection.assign'), validate(transferSchema), async (req, res, next) => {
  try {
    await collections.transferOwner({
      tenantId: req.tenantId, actor: req.user, bookingId: req.params.id,
      newOwnerUserId: req.data.newOwnerUserId, reason: req.data.reason,
      includePending: req.data.includePending !== false,
    });
    req.session.flash = { type: 'success', message: 'Collection transferred. The salesperson keeps the sale.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}`));
  } catch (err) { next(err); }
});

const followupSchema = z.object({
  installmentId: f.optionalId,
  actionType: z.enum(CollectionFollowUp.ACTION_TYPES),
  date: f.optionalText(20),
  time: f.optionalText(10),
  note: f.optionalText(2000),
  assignedUserId: f.optionalId,
  returnTo: f.optionalText(300),
});

router.post('/api/bookings/:id/collection-followups', requirePermission('collection.followup'), validate(followupSchema), async (req, res, next) => {
  try {
    const booking = await Booking.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!booking) throw forbidden('Booking not found.');
    await collections.assertCanWork({ user: req.user, booking });

    const dueAt = collectionFollowups.resolveNextDueAt({
      next: { date: req.data.date, time: req.data.time }, tz: res.locals.zone,
    });
    await collectionFollowups.create({
      tenantId: req.tenantId, actor: req.user, bookingId: req.params.id,
      installmentId: req.data.installmentId, actionType: req.data.actionType,
      dueAt, assignedUserId: req.data.assignedUserId, note: req.data.note,
    });
    req.session.flash = { type: 'success', message: 'Collection follow-up scheduled.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}`));
  } catch (err) { next(err); }
});

const completeSchema = z.object({
  outcome: z.enum(CollectionFollowUp.OUTCOMES),
  note: f.optionalText(2000),
  promisedAmount: f.moneyAmount,
  promisedDate: f.optionalText(20),
  nextActionType: f.enumField(CollectionFollowUp.ACTION_TYPES),
  nextDate: f.optionalText(20),
  nextTime: f.optionalText(10),
  nextNote: f.optionalText(500),
  returnTo: f.optionalText(300),
});

router.post('/api/collection-followups/:id/complete', requirePermission('collection.followup'), validate(completeSchema), async (req, res, next) => {
  try {
    const followup = await CollectionFollowUp.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!followup) throw forbidden('Collection follow-up not found.');
    const booking = await Booking.findOne({ tenantId: req.tenantId, _id: followup.bookingId }).lean();
    await collections.assertCanWork({ user: req.user, booking });

    const d = req.data;
    await collectionFollowups.complete({
      tenantId: req.tenantId,
      actor: req.user,
      followUpId: req.params.id,
      outcome: d.outcome,
      note: d.note,
      promise: { amountMinor: d.promisedAmount, date: d.promisedDate },
      next: {
        actionType: d.nextActionType, date: d.nextDate, time: d.nextTime, note: d.nextNote,
      },
      tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: 'Collection follow-up saved.' };
    res.redirect(safeReturn(req, '/app/collections'));
  } catch (err) { next(err); }
});

const dueDateSchema = z.object({
  actualDueDate: f.requiredText(20, 'Choose the new due date.'),
  reason: f.requiredText(300, 'Give a reason for the due date change.'),
  returnTo: f.optionalText(300),
});

/**
 * §268/§200: the only schedule change V2 allows. Amounts are never editable —
 * a commercial amendment is a different, privileged flow.
 */
router.post('/api/bookings/:id/installments/:installmentId/due-date', requirePermission('collection.adjust_due_date'), validate(dueDateSchema), async (req, res, next) => {
  try {
    await installments.setDueDate({
      tenantId: req.tenantId, actor: req.user, bookingId: req.params.id,
      installmentId: req.params.installmentId,
      actualDueDate: req.data.actualDueDate, reason: req.data.reason, tz: res.locals.zone,
    });
    await collections.recalcBooking({
      tenantId: req.tenantId, bookingId: req.params.id, tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: 'Due date updated.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=collections`));
  } catch (err) { next(err); }
});

/**
 * §108: post-booking initialization is normally automatic. This exists for the
 * booking whose initialization failed — it is idempotent, so pressing it twice
 * changes nothing.
 */
router.post('/api/bookings/:id/initialize', requirePermission('booking.edit'), async (req, res, next) => {
  try {
    await postBooking.initialize({
      tenantId: req.tenantId, bookingId: req.params.id, actor: req.user, tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: 'Post-booking data initialized.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}`));
  } catch (err) { next(err); }
});

/* --------------------- customer booking form (§116, §288) ----------------- */

const linkSchema = z.object({
  sections: f.stringList,
  reason: f.optionalText(300),
  returnTo: f.optionalText(300),
});

router.post('/api/bookings/:id/customer-link', requirePermission('booking.customer_link.create'), validate(linkSchema), async (req, res, next) => {
  try {
    const result = await bookingForm.createLink({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, bookingId: req.params.id,
      sections: req.data.sections,
    });
    /**
     * §117: the token is shown once, on the page the user lands on, and is not
     * recoverable afterwards — the record holds only its hash. It rides in the
     * session rather than the URL so it never reaches a server log or a referer
     * header.
     */
    req.session.freshCustomerLink = {
      bookingId: String(req.params.id),
      url: result.url,
      expiresAt: result.link.expiresAt,
    };
    req.session.flash = { type: 'success', message: 'Customer link generated. Copy or send it now — it is shown only once.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=customer`));
  } catch (err) { next(err); }
});

const sendSchema = z.object({
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL']),
  url: f.requiredText(400, 'Generate the link first.'),
  templateId: f.optionalId,
  returnTo: f.optionalText(300),
});

router.post('/api/bookings/:id/customer-link/send', requirePermission('booking.customer_link.create'), validate(sendSchema), async (req, res, next) => {
  try {
    const token = String(req.data.url).split('/booking-form/')[1];
    await bookingForm.sendLink({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, bookingId: req.params.id,
      token, channel: req.data.channel, templateId: req.data.templateId,
    });
    req.session.flash = { type: 'success', message: `Customer link sent by ${req.data.channel.toLowerCase()}.` };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=customer`));
  } catch (err) { next(err); }
});

router.post('/api/bookings/:id/customer-link/revoke', requirePermission('booking.customer_link.create'), async (req, res, next) => {
  try {
    await bookingForm.revokeLink({ tenantId: req.tenantId, actor: req.user, bookingId: req.params.id });
    req.session.flash = { type: 'success', message: 'Customer link revoked.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=customer`));
  } catch (err) { next(err); }
});

/** §289: reopen for correction. Approved data is kept. */
router.post('/api/bookings/:id/customer-link/reopen', requirePermission('booking.kyc.review'), validate(linkSchema), async (req, res, next) => {
  try {
    const result = await bookingForm.reopen({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, bookingId: req.params.id,
      sections: req.data.sections?.length ? req.data.sections : undefined,
      reason: req.data.reason,
    });
    req.session.freshCustomerLink = {
      bookingId: String(req.params.id), url: result.url, expiresAt: result.link.expiresAt,
    };
    req.session.flash = { type: 'success', message: 'Form reopened. Send the new link to the customer.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=customer`));
  } catch (err) { next(err); }
});

/* ------------------------------- KYC (§126–§128) -------------------------- */

const multer = require('multer');
const config = require('../config');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const csrf = require('../middleware/csrf');

/** Internal upload on the customer's behalf — same service path as §126. */
router.post('/api/bookings/:id/kyc/documents', requirePermission('booking.kyc.edit'), (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return next(badRequest('That file could not be read. Check the size and try again.'));
    // Multipart bodies are parsed here, so the CSRF token is only readable now.
    try { csrf.verify(req); } catch (tokenError) { return next(tokenError); }
    next();
  });
}, async (req, res, next) => {
  try {
    await kyc.upload({
      tenantId: req.tenantId,
      bookingId: req.params.id,
      applicantId: req.body.applicantId,
      documentTypeId: req.body.documentTypeId,
      file: req.file,
      documentNumber: req.body.documentNumber,
      expiryDate: req.body.expiryDate || undefined,
      uploadedByType: 'INTERNAL_USER',
      actor: req.user,
      tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: 'Document uploaded.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=customer`));
  } catch (err) { next(err); }
});

const reviewSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED', 'UNDER_REVIEW']),
  note: f.optionalText(500),
  returnTo: f.optionalText(300),
});

router.post('/api/kyc-documents/:id/review', requirePermission('booking.kyc.review'), validate(reviewSchema), async (req, res, next) => {
  try {
    const result = await kyc.review({
      tenantId: req.tenantId, actor: req.user, documentId: req.params.id,
      decision: req.data.decision, note: req.data.note, tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: `Document ${req.data.decision.replace(/_/g, ' ').toLowerCase()}. KYC is now ${result.kycStatus.replace(/_/g, ' ').toLowerCase()}.` };
    res.redirect(safeReturn(req, '/app/bookings/kyc'));
  } catch (err) { next(err); }
});

/* --------------------------- payment links (§141) ------------------------- */

const paymentLinkSchema = z.object({
  installmentId: f.optionalId,
  amount: f.moneyAmount,
  channel: f.enumField(['WHATSAPP', 'SMS', 'EMAIL', 'COPY']),
  returnTo: f.optionalText(300),
});

router.post('/api/bookings/:id/payment-links', requirePermission('collection.payment_link'), validate(paymentLinkSchema), async (req, res, next) => {
  try {
    const booking = await Booking.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!booking) throw notFound('Booking not found.');
    await collections.assertCanWork({ user: req.user, booking });

    const result = await payments.createLink({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user, bookingId: req.params.id,
      installmentId: req.data.installmentId, amountMinor: req.data.amount,
    });
    if (req.data.channel && req.data.channel !== 'COPY') {
      await payments.shareLink({
        tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
        paymentRequestId: result.paymentRequest._id, channel: req.data.channel,
      });
    }
    req.session.flash = {
      type: 'success',
      message: req.data.channel && req.data.channel !== 'COPY'
        ? `Payment link created and sent by ${req.data.channel.toLowerCase()}.`
        : `Payment link created: ${result.url}`,
    };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=collections`));
  } catch (err) { next(err); }
});

router.post('/api/payment-requests/:id/share', requirePermission('collection.payment_link'), async (req, res, next) => {
  try {
    await payments.shareLink({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      paymentRequestId: req.params.id, channel: req.body.channel || 'WHATSAPP',
    });
    req.session.flash = { type: 'success', message: 'Payment link shared.' };
    res.redirect(safeReturn(req, '/app/collections'));
  } catch (err) { next(err); }
});

router.post('/api/payment-requests/:id/cancel', requirePermission('collection.payment_link'), async (req, res, next) => {
  try {
    await payments.cancelLink({
      tenantId: req.tenantId, actor: req.user, paymentRequestId: req.params.id,
      reason: req.body.reason || 'Cancelled by the collections team',
    });
    req.session.flash = { type: 'success', message: 'Payment link cancelled.' };
    res.redirect(safeReturn(req, '/app/collections'));
  } catch (err) { next(err); }
});

/* ------------------------- receipts (§143–§146) --------------------------- */

/**
 * §143: record a payment. Multipart, because a proof of payment is part of the
 * same action — the CSRF token is verified after the body is parsed.
 */
router.post('/api/bookings/:id/receipts', requirePermission('collection.record_payment'), (req, res, next) => {
  upload.single('proof')(req, res, (err) => {
    if (err) return next(badRequest('That file could not be read. Check the size and try again.'));
    try { csrf.verify(req); } catch (tokenError) { return next(tokenError); }
    next();
  });
}, async (req, res, next) => {
  try {
    const booking = await Booking.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!booking) throw notFound('Booking not found.');
    await collections.assertCanWork({ user: req.user, booking });

    const money = require('../lib/money');
    const raw = req.body;
    // An explicit allocation grid wins; otherwise the service spreads it oldest first.
    const allocations = [];
    const ids = [].concat(raw.allocationInstallmentId || []);
    const amounts = [].concat(raw.allocationAmount || []);
    ids.forEach((installmentId, index) => {
      const value = amounts[index];
      if (installmentId && value) {
        allocations.push({ installmentId, amountMinor: money.toMinor(value) });
      }
    });

    await receipts.record({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      bookingId: req.params.id,
      amountMinor: money.toMinor(raw.amount),
      paymentDate: raw.paymentDate,
      mode: raw.mode,
      reference: raw.reference,
      bank: raw.bank,
      note: raw.note,
      allocations: allocations.length ? allocations : null,
      proofFile: req.file,
      tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: 'Payment recorded.' };
    res.redirect(safeReturn(req, `/app/bookings/${req.params.id}?tab=collections`));
  } catch (err) { next(err); }
});

const reverseSchema = z.object({
  reason: f.requiredText(500, 'Give a reason for the reversal.'),
  returnTo: f.optionalText(300),
});

/** §146/§324.5: reversal, never deletion. */
router.post('/api/receipts/:id/reverse', requirePermission('collection.reverse_receipt'), validate(reverseSchema), async (req, res, next) => {
  try {
    const receipt = await BookingReceipt.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!receipt) throw notFound('Receipt not found.');
    const booking = await Booking.findOne({ tenantId: req.tenantId, _id: receipt.bookingId }).lean();
    await collections.assertCanWork({ user: req.user, booking });

    await receipts.reverse({
      tenantId: req.tenantId, tenant: req.tenant, actor: req.user,
      receiptId: req.params.id, reason: req.data.reason, tz: res.locals.zone,
    });
    req.session.flash = { type: 'success', message: 'Receipt reversed. The original record is kept.' };
    res.redirect(safeReturn(req, `/app/bookings/${receipt.bookingId}?tab=collections`));
  } catch (err) { next(err); }
});

/** Only ever redirect somewhere inside the app. */
function safeReturn(req, fallback) {
  const target = req.data?.returnTo || req.body?.returnTo;
  return typeof target === 'string' && target.startsWith('/app/') ? target : fallback;
}

module.exports = router;
