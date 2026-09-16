const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * Who lives in a unit, and when — the source of truth for residency.
 *
 * One row per person per tenure. A tenant moving out sets `isCurrent: false`
 * and `endDate` rather than being deleted, so the unit keeps its history and a
 * complaint raised last year still resolves to the person who raised it.
 *
 * Family members are rows too, with `memberRole: 'FAMILY'` and
 * `parentOccupancyId` pointing at the primary resident's row. That is why the
 * personal fields are duplicated here rather than only living on the member:
 * a family member may exist before they have a user account at all.
 *
 * The unique index is partial on both `isCurrent` and `userId` being a real
 * ObjectId — a unit may hold many past occupancies and many current family
 * members without accounts, but one user cannot be current in the same unit
 * twice.
 */
const occupancySchema = new Schema({
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  memberId: { type: Schema.Types.ObjectId, ref: 'SocietyMember', default: null },

  firstName: { type: String, trim: true, default: null },
  lastName: { type: String, trim: true, default: null },
  mobileNumber: { type: String, trim: true, default: null },
  countryCode: { type: String, default: '+91' },
  email: { type: String, trim: true, lowercase: true, default: null },
  gender: { type: String, enum: [...enums.gender, null], default: null },
  age: { type: String, default: null },
  profilePhoto: { type: String, default: null },
  bloodGroup: { type: String, enum: [...enums.bloodGroupTypes, null], default: null },

  /**
   * `notifications` sits INSIDE `visitor`, matching the source's shape and
   * `SocietyMember` — the resident app reads `settings.visitor.notifications`.
   */
  settings: {
    visitor: {
      guestAutoApproval: { type: Boolean, default: false },
      cabAutoApproval: { type: Boolean, default: false },
      familyVisitorAutoApproval: { type: Boolean, default: false },
      notifications: { type: Boolean, default: true },
    },
  },

  residentType: { type: String, enum: enums.residentTypeOccupancy, required: true },
  memberRole: { type: String, enum: enums.memberRole, required: true },
  parentOccupancyId: { type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy', default: null },
  relation: { type: String, enum: [...enums.relation, null], default: null },
  isPrimary: { type: Boolean, default: false },

  isCurrent: { type: Boolean, default: true, index: true },
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, default: null },

  /** Tenancy paperwork. Both are private files — never served by URL. */
  rentAgreement: { type: String, default: null },
  policeVerification: { type: String, default: null },
  agreementStartDate: { type: Date, default: null },
  agreementEndDate: { type: Date, default: null },
  agreementStatus: { type: String, enum: [...enums.agreementStatus, null], default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_unitoccupancy' });

occupancySchema.plugin(societyGuard);
occupancySchema.index({ societyId: 1, unitId: 1, isCurrent: 1 });
occupancySchema.index({ memberId: 1, isCurrent: 1 });
occupancySchema.index({ userId: 1, societyId: 1, isCurrent: 1 });
occupancySchema.index({ parentOccupancyId: 1, isCurrent: 1 });
occupancySchema.index({ societyId: 1, memberRole: 1, isCurrent: 1 });
occupancySchema.index({ societyId: 1, mobileNumber: 1, isCurrent: 1 });
occupancySchema.index(
  { unitId: 1, userId: 1, isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true, userId: { $type: 'objectId' } } },
);
occupancySchema.index({ societyId: 1, agreementStatus: 1, agreementEndDate: 1 });

module.exports = model('SocietyUnitOccupancy', occupancySchema);
