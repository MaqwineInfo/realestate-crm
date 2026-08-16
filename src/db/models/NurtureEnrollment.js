const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §19: one lead's position in a sequence. One enrollment per lead+sequence. */
const nurtureEnrollmentSchema = new Schema({
  sequenceId: { type: Schema.Types.ObjectId, ref: 'NurtureSequence', required: true, index: true },
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  enrolledAt: { type: Date, default: Date.now },
  nextStepNumber: { type: Number, default: 1 },
  nextRunAt: { type: Date, index: true },
  lastStepAt: { type: Date },
  status: { type: String, enum: ['ACTIVE', 'COMPLETED', 'STOPPED', 'PAUSED'], default: 'ACTIVE', index: true },
  stoppedReason: { type: String },
}, { timestamps: true });

nurtureEnrollmentSchema.plugin(tenantGuard);
nurtureEnrollmentSchema.index({ tenantId: 1, sequenceId: 1, leadId: 1 }, { unique: true });
nurtureEnrollmentSchema.index({ tenantId: 1, status: 1, nextRunAt: 1 });

module.exports = model('NurtureEnrollment', nurtureEnrollmentSchema);
