const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A resident complaint, from raised to closed.
 *
 * `complaintId` is the human-readable reference (CM-001). It is minted from
 * `SocietyCounter` rather than by reading the latest row — see that model for
 * why. Assignment goes to a `SocietyEmployee`, not an admin: the technician
 * does the work, the admin routes it.
 *
 * `taskStatus` and `complaintFor` exist for the legacy façade
 * (SOCIETY-PLAN.md §2.2); the canonical surfaces track state in `status`.
 */
const complaintSchema = new Schema({
  complaintId: { type: String, trim: true },

  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', default: null, index: true },
  complaintTypeId: { type: Schema.Types.ObjectId, ref: 'SocietyComplaintType', required: true, index: true },

  title: { type: String, required: true, trim: true, minlength: 5, maxlength: 200 },
  description: { type: String, required: true, trim: true, maxlength: 2000 },
  contentType: { type: String, enum: enums.complaintContentType, default: 'TEXT' },
  contentData: { type: Schema.Types.Mixed, default: null },

  status: { type: String, enum: enums.complaintStatus, default: 'Open', index: true },
  priority: { type: String, enum: enums.complaintPriority, default: 'Medium' },

  resolution: {
    notes: { type: String, default: null, maxlength: 1000 },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
    resolvedAt: { type: Date, default: null },
  },

  assignedTo: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', default: null },
  assignedAt: { type: Date, default: null },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },

  notes: { type: String, default: null, maxlength: 2000 },
  closedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  closedAt: { type: Date, default: null },

  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  createdByRole: { type: String, enum: enums.createdByRole, default: 'MEMBER' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },

  /** Legacy façade only. */
  taskStatus: { type: String, enum: [...enums.LEGACY_complaintTaskStatus, null], default: null },
  complaintFor: { type: String, trim: true, default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_complaints' });

complaintSchema.plugin(societyGuard);
/**
 * Partial, not sparse: `sparse` still indexes an explicit `null`, so every
 * document that leaves this unset would collide with the first. See the note
 * on `SocietyMember.userId`.
 */
complaintSchema.index(
  { complaintId: 1 },
  { unique: true, partialFilterExpression: { complaintId: { $type: 'string' } } },
);
complaintSchema.index({ societyId: 1, complaintTypeId: 1, status: 1 });
complaintSchema.index({ societyId: 1, status: 1, isDeleted: 1 });
complaintSchema.index({ societyId: 1, unitId: 1, createdAt: -1 });
complaintSchema.index({ societyId: 1, assignedTo: 1, status: 1 });
complaintSchema.index({ societyId: 1, createdAt: -1 });

module.exports = model('SocietyComplaint', complaintSchema);
