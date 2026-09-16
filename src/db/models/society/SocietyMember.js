const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A resident's society-facing profile — the person, not their tenancy.
 *
 * `SocietyUser` is the login, `SocietyUnitOccupancy` is which unit they hold
 * and when, and this is the profile the app and the member directory render.
 * One member per user, enforced by a sparse unique index on `userId` so that
 * members created by an admin before the person has ever logged in (userId
 * null) do not collide with each other.
 *
 * `settings.visitor` is what makes gate auto-approval work: a guest, cab or
 * family visitor arriving for this member skips the approval prompt when the
 * matching flag is on.
 */
const memberSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },

  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  mobileNumber: { type: String, required: true, trim: true },
  countryCode: { type: String, default: '+91' },
  email: { type: String, trim: true, lowercase: true, default: null },
  gender: { type: String, enum: [...enums.gender, null], default: null },
  age: { type: String, default: null },
  profilePhoto: { type: String, default: null },
  image: { type: String, default: null },

  settings: {
    visitor: {
      guestAutoApproval: { type: Boolean, default: false },
      cabAutoApproval: { type: Boolean, default: false },
      familyVisitorAutoApproval: { type: Boolean, default: false },
      notifications: { type: Boolean, default: true },
    },
  },

  status: { type: String, enum: enums.memberStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
}, { timestamps: true, collection: 'society_members' });

memberSchema.plugin(societyGuard);
/**
 * Partial, not sparse. `sparse` only skips documents where the field is
 * ABSENT — an explicit `userId: null` still indexes, so the second member
 * created before their user account exists collides with the first on null.
 * A partial index on "is actually an ObjectId" is the constraint that was
 * meant: one member per user, any number of members without one yet.
 */
memberSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } },
);
memberSchema.index({ societyId: 1, mobileNumber: 1 });
memberSchema.index({ societyId: 1, status: 1, isDeleted: 1 });

module.exports = model('SocietyMember', memberSchema);
