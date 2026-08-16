const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §9: the master identity of a person. One Contact, many Leads (§2.5).
 * `normalizedMobile` is the duplicate key (§9.2) and is indexed for the fast
 * exact-mobile search §46 requires.
 */
const contactSchema = new Schema({
  firstName: { type: String, required: true, trim: true, maxlength: 80 },
  lastName: { type: String, trim: true, maxlength: 80, default: '' },
  displayName: { type: String, trim: true, maxlength: 161 },
  primaryMobile: { type: String, required: true, trim: true },
  normalizedMobile: { type: String, required: true },
  altMobile: { type: String, trim: true },
  normalizedAltMobile: { type: String },
  email: { type: String, trim: true, lowercase: true },
  altEmail: { type: String, trim: true, lowercase: true },
  gender: { type: String, trim: true },
  city: { type: String, trim: true },
  state: { type: String, trim: true },
  country: { type: String, trim: true },
  pincode: { type: String, trim: true },
  address: { type: String, maxlength: 500 },
  tagIds: [{ type: Schema.Types.ObjectId, ref: 'Tag', index: true }],
  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE', index: true },
  // §67: campaign sending must respect these; operational contact is unaffected.
  consent: {
    whatsappOptOut: { type: Boolean, default: false },
    smsOptOut: { type: Boolean, default: false },
    emailOptOut: { type: Boolean, default: false },
    dnd: { type: Boolean, default: false },
    reason: { type: String },
    updatedAt: { type: Date },
    source: { type: String },
  },
  inquiryCount: { type: Number, default: 0 },
  lastInquiryAt: { type: Date },
  lastActivityAt: { type: Date },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdVia: { type: String, default: 'MANUAL' },
}, { timestamps: true });

contactSchema.plugin(tenantGuard);
// §60: exact mobile lookup is the hottest query in the product.
contactSchema.index({ tenantId: 1, normalizedMobile: 1 }, { unique: true });
contactSchema.index({ tenantId: 1, email: 1 });
contactSchema.index({ tenantId: 1, normalizedAltMobile: 1 });
contactSchema.index({ tenantId: 1, createdAt: -1 });
contactSchema.index({ tenantId: 1, displayName: 'text', primaryMobile: 'text', email: 'text' });

contactSchema.pre('validate', function setDisplayName() {
  if (!this.displayName) {
    this.displayName = [this.firstName, this.lastName].filter(Boolean).join(' ').trim();
  }
});

module.exports = model('Contact', contactSchema);
