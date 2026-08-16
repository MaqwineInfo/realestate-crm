const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §36: the rental counterpart of §35, with its own team assignment. */
const rentalOpportunitySchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  expectedAvailableDate: { type: Date, index: true },
  expectedRentMinor: { type: Number, min: 0 },
  furnishing: { type: String, enum: ['FURNISHED', 'SEMI_FURNISHED', 'UNFURNISHED'] },
  assignedUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  status: { type: String, enum: ['UPCOMING', 'IN_DISCUSSION', 'LISTED', 'RENTED', 'DROPPED'], default: 'UPCOMING', index: true },
  nextActionAt: { type: Date },
  nextActionNote: { type: String, maxlength: 300 },
  notes: { type: String, maxlength: 1000 },
  reminderSentAt: { type: Date },
}, { timestamps: true });

rentalOpportunitySchema.plugin(tenantGuard);
rentalOpportunitySchema.index({ tenantId: 1, expectedAvailableDate: 1, status: 1 });

module.exports = model('RentalOpportunity', rentalOpportunitySchema);
