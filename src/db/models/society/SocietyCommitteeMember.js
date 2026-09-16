const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * The elected committee — chairman, secretary, treasurer and the rest.
 *
 * Distinct from `SocietyAdmin`: this is the published roster residents see on
 * the app, and holding a seat does not by itself grant admin access. An admin
 * account created for a committee member links back through
 * `SocietyAdmin.committeeMemberId`.
 */
const committeeMemberSchema = new Schema({
  firstName: { type: String, trim: true, required: true },
  lastName: { type: String, trim: true, default: '' },
  email: { type: String, trim: true, lowercase: true, required: true },
  countryCode: { type: String, trim: true, required: true },
  phoneNumber: { type: String, trim: true, required: true },

  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true },
  roleId: { type: Schema.Types.ObjectId, ref: 'SocietyRole' },
  designation: { type: String, trim: true },
  bloodGroup: { type: String, enum: [...enums.bloodGroupTypes, null], default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
}, { timestamps: true, collection: 'society_committeemembers' });

committeeMemberSchema.plugin(societyGuard);
committeeMemberSchema.index({ societyId: 1, isDeleted: 1 });
committeeMemberSchema.index({ societyId: 1, userId: 1, isDeleted: 1 });

module.exports = model('SocietyCommitteeMember', committeeMemberSchema);
