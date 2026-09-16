const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A visitor as a person — recognised across visits by mobile number.
 *
 * Separate from `SocietyVisitorLog`, which is one arrival. Keeping the person
 * distinct is what lets the gate screen recognise a returning courier and
 * prefill their details instead of retyping them at every entry.
 */
const visitorSchema = new Schema({
  mobileNumber: { type: String, required: true, trim: true },
  countryCode: { type: String, default: '+91', trim: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, trim: true, default: '' },

  visitorType: { type: String, enum: enums.visitorTypes, default: 'GUEST' },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: null },
  vehicleType: { type: String, trim: true, default: null },
  photo: { type: String, default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_visitors' });

visitorSchema.plugin(societyGuard);
visitorSchema.index({ societyId: 1, mobileNumber: 1, isDeleted: 1 });

module.exports = model('SocietyVisitor', visitorSchema);
