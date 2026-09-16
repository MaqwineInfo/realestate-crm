const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/** Fire, ambulance, the society office — the numbers the app shows under SOS. */
const emergencyNumberSchema = new Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  countryCode: { type: String, default: '' },
  emergencyNumber: { type: String, default: '', trim: true },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_emergencynumbers' });

emergencyNumberSchema.plugin(societyGuard);
emergencyNumberSchema.index({ societyId: 1, isDeleted: 1, status: 1 });

module.exports = model('SocietyEmergencyNumber', emergencyNumberSchema);
