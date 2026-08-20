const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { can } = require('../lib/access');
const { forbidden, notFound } = require('../lib/errors');
const {
  BookingKycDocument, BookingReceipt, Booking, PartnerReraDocument, PartnerInvoice,
} = require('../db/models');
const privateFiles = require('../lib/privateFiles');
const postBooking = require('../services/postBooking');
const audit = require('../services/audit');

/**
 * V2 §131: the only way bytes leave the private upload directory.
 *
 * There is no static route into `PRIVATE_UPLOAD_DIR`, so every read passes
 * through here: session → permission for that kind of file → tenant + booking
 * visibility → audit → stream. A storage key on its own grants nothing.
 */
const router = express.Router();
router.use('/app/files', requireAuth);

/**
 * Each kind names the permission that governs it and how to find the row. Adding
 * a kind (CP invoice, RERA certificate, HR face image) means adding an entry —
 * it cannot accidentally inherit an unchecked path.
 */
const KINDS = {
  'kyc-document': {
    permission: 'booking.kyc.view',
    async load({ tenantId, id }) {
      const document = await BookingKycDocument.findOne({ tenantId, _id: id }).lean();
      if (!document) return null;
      return {
        bookingId: document.bookingId,
        storageKey: document.storageKey,
        mimeType: document.mimeType,
        label: document.fileLabel || 'document',
        entity: 'BookingKycDocument',
        entityId: document._id,
      };
    },
  },
  'receipt-proof': {
    permission: 'collection.view',
    async load({ tenantId, id }) {
      const receipt = await BookingReceipt.findOne({ tenantId, _id: id }).lean();
      if (!receipt?.proof?.storageKey) return null;
      return {
        bookingId: receipt.bookingId,
        storageKey: receipt.proof.storageKey,
        mimeType: receipt.proof.mimeType,
        label: receipt.proof.fileLabel || `Receipt ${receipt.receiptNo}`,
        entity: 'BookingReceipt',
        entityId: receipt._id,
      };
    },
  },
  'rera-certificate': {
    permission: 'cp.partner.view',
    async load({ tenantId, id }) {
      const document = await PartnerReraDocument.findOne({ tenantId, _id: id }).lean();
      if (!document?.certificate?.storageKey) return null;
      return {
        storageKey: document.certificate.storageKey,
        mimeType: document.certificate.mimeType,
        label: document.certificate.fileLabel || `RERA ${document.registrationNumber}`,
        entity: 'PartnerReraDocument',
        entityId: document._id,
      };
    },
  },
  // §298: an invoice PDF is private. Internal reviewers read it here; a partner
  // reads their own through the portal route, which checks ownership instead.
  'cp-invoice': {
    permission: 'cp.invoice.view',
    async load({ tenantId, id }) {
      const invoice = await PartnerInvoice.findOne({ tenantId, _id: id }).lean();
      if (!invoice?.invoicePdf?.storageKey) return null;
      return {
        storageKey: invoice.invoicePdf.storageKey,
        mimeType: invoice.invoicePdf.mimeType,
        label: invoice.invoicePdf.fileLabel || `Invoice ${invoice.invoiceRef}`,
        entity: 'PartnerInvoice',
        entityId: invoice._id,
      };
    },
  },
};

router.get('/app/files/:kind/:id', async (req, res, next) => {
  try {
    const kind = KINDS[req.params.kind];
    if (!kind) throw notFound('That file could not be found.');
    if (!can(req.user, kind.permission)) throw forbidden('You do not have permission to open this file.');

    const target = await kind.load({ tenantId: req.tenantId, id: req.params.id });
    if (!target) throw notFound('That file could not be found.');

    // The file belongs to a booking, so booking visibility decides access too.
    if (target.bookingId) {
      const booking = await Booking.findOne({ tenantId: req.tenantId, _id: target.bookingId })
        .select('salespersonId collectionOwnerUserId').lean();
      if (!booking) throw notFound('That file could not be found.');
      await postBooking.assertCanView({ user: req.user, booking });
    }

    const bytes = await privateFiles.read(target.storageKey);
    // §131: reads of customer documents are audited, not just permitted.
    await audit.record({
      tenantId: req.tenantId, actor: req.user, entity: target.entity, entityId: target.entityId,
      action: 'DOWNLOAD', req,
    });

    res.setHeader('Content-Type', target.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${privateFiles.downloadName(target.label, target.mimeType)}"`);
    // Never cached by a shared proxy, never indexed.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.send(bytes);
  } catch (err) { next(err); }
});

module.exports = router;
