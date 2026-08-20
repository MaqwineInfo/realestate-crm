const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** V2 §125: which documents this organization asks for, configurable per tenant. */
const APPLIES_TO = ['INDIVIDUAL', 'COMPANY', 'BOTH'];

const kycDocumentTypeSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  code: { type: String, required: true, trim: true, uppercase: true, maxlength: 40 },
  appliesTo: { type: String, enum: APPLIES_TO, default: 'BOTH' },
  mandatory: { type: Boolean, default: false },
  // Empty means "the safe default set" from lib/privateFiles.
  allowedMimeTypes: [{ type: String }],
  maxBytes: { type: Number },
  expiryRequired: { type: Boolean, default: false },
  numberRequired: { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
}, { timestamps: true });

kycDocumentTypeSchema.plugin(tenantGuard);
kycDocumentTypeSchema.index({ tenantId: 1, code: 1 }, { unique: true });

module.exports = model('KycDocumentType', kycDocumentTypeSchema);
module.exports.APPLIES_TO = APPLIES_TO;
