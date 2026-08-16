const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §32: Block Unit is both a lead stage and an inventory transaction (§55.12).
 *
 * §96: `expiryAt` is resolved and stored when the block is created, so changing
 * the project's block duration later never moves an existing block's deadline.
 */
const unitBlockSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true, index: true },
  costSheetId: { type: Schema.Types.ObjectId, ref: 'CostSheet' },
  proposedPriceMinor: { type: Number },
  tokenAmountMinor: { type: Number, min: 0 },
  blockedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  blockedAt: { type: Date, default: Date.now },
  expiryAt: { type: Date, required: true, index: true },
  reminderSentAt: { type: Date },
  status: {
    type: String,
    enum: ['ACTIVE', 'CONVERTED', 'RELEASED', 'EXPIRED', 'CANCELLED'],
    default: 'ACTIVE',
    index: true,
  },
  releasedAt: { type: Date },
  releasedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  releaseReason: { type: String, maxlength: 300 },
  notes: { type: String, maxlength: 500 },
}, { timestamps: true });

unitBlockSchema.plugin(tenantGuard);
// The block-expiry sweep reads exactly this index (§60).
unitBlockSchema.index({ tenantId: 1, status: 1, expiryAt: 1 });

module.exports = model('UnitBlock', unitBlockSchema);
