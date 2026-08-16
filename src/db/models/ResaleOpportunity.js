const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §35: today's investor booking is tomorrow's resale lead. Deliberately a
 * lightweight queue with follow-up, not a second CRM pipeline (§35.3).
 */
const resaleOpportunitySchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  expectedAvailableDate: { type: Date, index: true },
  expectedAskingPriceMinor: { type: Number, min: 0 },
  expectedRoiPercentage: { type: Number },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  status: { type: String, enum: ['UPCOMING', 'IN_DISCUSSION', 'LISTED', 'CLOSED', 'DROPPED'], default: 'UPCOMING', index: true },
  nextActionAt: { type: Date },
  nextActionNote: { type: String, maxlength: 300 },
  notes: { type: String, maxlength: 1000 },
  reminderSentAt: { type: Date },
}, { timestamps: true });

resaleOpportunitySchema.plugin(tenantGuard);
resaleOpportunitySchema.index({ tenantId: 1, expectedAvailableDate: 1, status: 1 });

module.exports = model('ResaleOpportunity', resaleOpportunitySchema);
