const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A resident's family member, as the mobile app manages them.
 *
 * Overlaps `SocietyUnitOccupancy` rows with `memberRole: 'FAMILY'` — the source
 * grew both and the resident app writes this one while the admin panel reads
 * the occupancy. Both are kept because both surfaces are contract-bound, and
 * `services/society/members.js` keeps them consistent from a single write path
 * rather than leaving two half-truths.
 *
 * `unitId` referenced the old `users` collection in the source (see
 * SOCIETY-PLAN.md §2.3); it points at `SocietyUnit` here, which is what those
 * ids always actually were.
 */
const familyMemberSchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true, index: true },
  parentMemberId: { type: Schema.Types.ObjectId, ref: 'SocietyMember', index: true },

  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  relation: { type: String, enum: [...enums.relation, null], default: null },
  gender: { type: String, enum: [...enums.gender, null], default: null },
  age: { type: String },
  mobileNumber: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
  profilePhoto: { type: String },
  bloodGroup: { type: String, enum: [...enums.bloodGroupTypes, null], default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_familymembers' });

familyMemberSchema.plugin(societyGuard);
familyMemberSchema.index({ societyId: 1, unitId: 1, isDeleted: 1 });
familyMemberSchema.index({ societyId: 1, parentMemberId: 1, isDeleted: 1 });

module.exports = model('SocietyFamilyMember', familyMemberSchema);
