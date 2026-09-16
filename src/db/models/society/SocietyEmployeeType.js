const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * Security Guard, Technician, Housekeeping — the staff categories a society
 * defines. `roleId` links a type to the RBAC role its holders log in with, so
 * making someone a Security Guard is what grants them the gatekeeper surface.
 *
 * `isSystem` marks the two types seeded automatically on society creation
 * (source: `config/systemEmployeeTypes.js`); they cannot be deleted.
 */
const employeeTypeSchema = new Schema({
  typeName: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
  description: { type: String, trim: true, maxlength: 500, default: null },
  roleId: { type: Schema.Types.ObjectId, ref: 'SocietyRole', default: null, index: true },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },
  isSystem: { type: Boolean, default: false, index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_employeetypes' });

employeeTypeSchema.plugin(societyGuard);
employeeTypeSchema.index(
  { societyId: 1, typeName: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
employeeTypeSchema.index({ societyId: 1, status: 1, isDeleted: 1 });

module.exports = model('SocietyEmployeeType', employeeTypeSchema);
