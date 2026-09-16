const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A resident's request to be linked to a unit, awaiting chairman approval.
 *
 * The app-side half of member registration: someone installs the app, claims a
 * unit and uploads proof; the chairman approves, and only then does
 * `services/society/members.js` create the `SocietyMember` and
 * `SocietyUnitOccupancy` rows. Nothing here grants access on its own.
 *
 * `familyMembers` is a free-form array carried through from the app's
 * registration form and materialised into occupancy rows on approval.
 *
 * Ownership proof, rent agreement and police verification are private files.
 */
const onboardingRequestSchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true, index: true },
  residentType: { type: String, enum: enums.residentTypeOccupancy, required: true },

  ownershipProofUrl: { type: String, default: null },
  rentAgreement: { type: String, default: null },
  policeVerification: { type: String, default: null },
  agreementStartDate: { type: Date, default: null },
  agreementEndDate: { type: Date, default: null },

  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, default: null, trim: true },
  email: { type: String, default: null, trim: true, lowercase: true },
  countryCode: { type: String, default: '+91' },
  mobileNumber: { type: String, required: true, trim: true },
  gender: { type: String, enum: [...enums.gender, null], default: null },
  bloodGroup: { type: String, enum: [...enums.bloodGroupTypes, null], default: null },

  familyMembers: { type: Array, default: [] },

  status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending', index: true },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  approvedAt: { type: Date, default: null },
  rejectedReason: { type: String, default: null },
}, { timestamps: true, collection: 'society_residentonboardingrequests' });

onboardingRequestSchema.plugin(societyGuard);
onboardingRequestSchema.index({ societyId: 1, status: 1, createdAt: -1 });
onboardingRequestSchema.index({ societyId: 1, unitId: 1, status: 1 });
onboardingRequestSchema.index({ userId: 1, status: 1 });

module.exports = model('SocietyResidentOnboardingRequest', onboardingRequestSchema);
