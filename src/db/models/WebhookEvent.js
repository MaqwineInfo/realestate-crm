const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §63 + §98: every inbound webhook is stored raw before it is processed,
 * and `idempotencyKey` is uniquely indexed per tenant + integration — a
 * provider redelivering the same lead cannot create a second inquiry.
 * §106: failures stay queryable so lead-capture problems are visible.
 */
const webhookEventSchema = new Schema({
  integrationId: { type: Schema.Types.ObjectId, ref: 'Integration', index: true },
  provider: { type: String },
  kind: { type: String, default: 'LEAD' },
  idempotencyKey: { type: String, required: true },
  payload: { type: Schema.Types.Mixed },
  headers: { type: Schema.Types.Mixed },
  receivedAt: { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ['RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED'], default: 'RECEIVED', index: true },
  error: { type: String },
  attempts: { type: Number, default: 0 },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
}, { timestamps: true });

webhookEventSchema.plugin(tenantGuard);
webhookEventSchema.index({ tenantId: 1, integrationId: 1, idempotencyKey: 1 }, { unique: true });
webhookEventSchema.index({ tenantId: 1, status: 1, receivedAt: -1 });

module.exports = model('WebhookEvent', webhookEventSchema);
