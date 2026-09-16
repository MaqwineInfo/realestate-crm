const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A posting: this employee works at this society, in this role, from this date.
 *
 * The join between the platform-level `SocietyEmployee` and one society. One
 * active posting per employee per society, enforced partially on
 * `isDeleted: false` so a re-hire is possible.
 *
 * `mpin` is the 4-digit code a guard punches into the gate device instead of
 * an OTP round trip. It is unique **within a society** — two guards at the same
 * gate must not share one — and the index is partial on the field being a real
 * string, because most assignments have no MPIN and nulls would all collide.
 * Minting it is a retry-on-collision loop in `services/society/employees.js`;
 * the unique index is what actually makes that safe.
 *
 * `phoneLock` binds the assignment to one device.
 */
const assignmentSchema = new Schema({
  employeeId: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', required: true, index: true },
  employeeTypeId: { type: Schema.Types.ObjectId, ref: 'SocietyEmployeeType', required: true, index: true },

  dateOfJoining: { type: Date, required: true },
  dateOfLeaving: { type: Date, default: null },
  salaryPerMonthMinor: { type: Number, min: 0, default: null },

  phoneLock: { type: Boolean, default: false },
  mpin: { type: String, default: null },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_employeeassignments' });

assignmentSchema.plugin(societyGuard);
assignmentSchema.index({ societyId: 1, isDeleted: 1 });
assignmentSchema.index({ societyId: 1, employeeId: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
assignmentSchema.index({ societyId: 1, employeeTypeId: 1 });
assignmentSchema.index({ societyId: 1, status: 1, isDeleted: 1 });
assignmentSchema.index({ employeeId: 1, isDeleted: 1 });
assignmentSchema.index(
  { societyId: 1, mpin: 1 },
  { unique: true, partialFilterExpression: { mpin: { $type: 'string' }, isDeleted: false } },
);

module.exports = model('SocietyEmployeeAssignment', assignmentSchema);
module.exports.MONEY_FIELDS = ['salaryPerMonthMinor'];
