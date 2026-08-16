const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §24: one lead may have many visits, across the same or different projects. */
const STATUSES = ['PLANNED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];

const siteVisitSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  scheduledAt: { type: Date, required: true, index: true },
  endAt: { type: Date },
  salesUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: STATUSES, default: 'PLANNED', index: true },

  // §24.1: direct visit or brought by a channel partner.
  visitingWith: { type: String, enum: ['DIRECT', 'CHANNEL_PARTNER'], default: 'DIRECT' },
  channelPartnerContactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
  channelPartnerName: { type: String, trim: true },
  channelPartnerMobile: { type: String, trim: true },
  visitorCount: { type: Number, min: 1, default: 1 },

  notes: { type: String, maxlength: 2000 },
  unitsShownIds: [{ type: Schema.Types.ObjectId, ref: 'Unit' }],
  outcomeId: { type: Schema.Types.ObjectId, ref: 'VisitOutcome' },
  completedAt: { type: Date },
  completedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  cancelledReason: { type: String, maxlength: 300 },
  // §25: set when the visit was captured by scanning the project QR code.
  viaQr: { type: Boolean, default: false },
}, { timestamps: true });

siteVisitSchema.plugin(tenantGuard);
// §60: today's visits per sales user.
siteVisitSchema.index({ tenantId: 1, scheduledAt: 1, salesUserId: 1 });
siteVisitSchema.index({ tenantId: 1, projectId: 1, status: 1 });

module.exports = model('SiteVisit', siteVisitSchema);
module.exports.STATUSES = STATUSES;
