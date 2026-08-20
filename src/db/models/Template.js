const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §17.2/§17.3 and §38: message templates with {{variable}} placeholders. */
const templateSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  channel: { type: String, enum: ['WHATSAPP', 'SMS', 'EMAIL'], required: true, index: true },
  /** V2 §231 adds the post-booking purposes to the V1 set. */
  purpose: {
    type: String,
    enum: [
      'ACKNOWLEDGEMENT', 'CAMPAIGN', 'NURTURE', 'GENERAL',
      'BOOKING_FORM_REQUEST', 'KYC_REQUEST', 'KYC_CORRECTION',
      'PAYMENT_UPCOMING', 'PAYMENT_DUE', 'PAYMENT_OVERDUE', 'PAYMENT_LINK', 'RECEIPT_ACK',
      // §233: partner-facing messages.
      'CP_REGISTRATION_STATUS', 'CP_PORTAL_INVITE', 'CP_RERA_EXPIRY',
      'CP_CLAIM_STATUS', 'CP_COMMISSION_ELIGIBLE', 'CP_INVOICE_STATUS',
    ],
    default: 'GENERAL',
  },
  subject: { type: String, maxlength: 200 },
  body: { type: String, required: true, maxlength: 4000 },
  // Provider-registered template name, where the channel requires one.
  providerTemplateId: { type: String },
  active: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

templateSchema.plugin(tenantGuard);
templateSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('Template', templateSchema);
