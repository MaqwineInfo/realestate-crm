const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A QR gate pass issued for a visit.
 *
 * One of the concepts that exists only in the legacy service and therefore
 * survives as a real collection (SOCIETY-PLAN.md §2.2) — the canonical
 * `SocietyVisitorLog` records the visit but has nowhere to put a scannable,
 * single-use, expiring token.
 *
 * `isUsed` plus `expiresAt` are what make it single-use: `services/society/
 * visitors.js` redeems it with a conditional update naming `isUsed: false`, so
 * two guards scanning the same QR cannot both admit the holder.
 *
 * The QR image is generated with this codebase's existing `qrcode` dependency,
 * the same one the walk-in QR sheet already uses.
 */
const visitorPassSchema = new Schema({
  passNumber: { type: String, required: true, trim: true },
  visitorLogId: { type: Schema.Types.ObjectId, ref: 'SocietyVisitorLog', required: true, index: true },

  visitorName: { type: String, trim: true, default: null },
  hostName: { type: String, trim: true, default: null },
  hostUnit: { type: String, trim: true, default: null },
  purposeOfVisit: { type: String, trim: true, default: null },
  passType: { type: String, trim: true, default: null },

  qrCode: { type: String, default: null },
  qrCodeImage: { type: String, default: null },

  issuedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: null, index: true },
  isUsed: { type: Boolean, default: false },
  usedAt: { type: Date, default: null },

  status: { type: String, trim: true, default: 'ACTIVE' },
  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_visitorpasses' });

visitorPassSchema.plugin(societyGuard);
visitorPassSchema.index({ passNumber: 1 }, { unique: true });
visitorPassSchema.index({ societyId: 1, isUsed: 1, expiresAt: 1 });
visitorPassSchema.index({ societyId: 1, visitorLogId: 1 });

module.exports = model('SocietyVisitorPass', visitorPassSchema);
