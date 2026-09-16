const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/** Plumbing, Electrical, Lift — the per-society complaint categories. */
const complaintTypeSchema = new Schema({
  typeName: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
}, { timestamps: true, collection: 'society_complainttypes' });

complaintTypeSchema.plugin(societyGuard);
/**
 * Partial on `isDeleted: false` — the source made this unique outright, which
 * permanently burns a type name the moment it is soft-deleted.
 */
complaintTypeSchema.index(
  { societyId: 1, typeName: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
complaintTypeSchema.index({ societyId: 1, status: 1, isDeleted: 1 });

module.exports = model('SocietyComplaintType', complaintTypeSchema);
