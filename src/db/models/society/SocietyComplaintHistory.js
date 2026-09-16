const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * The audit trail on a complaint — every status change, comment and assignment.
 *
 * One canonical collection, `complainthistories`. The source declared this
 * twice under names differing only in case (`complainthistories` in the admin
 * service, `complaintHistories` in the resident app), and MongoDB collection
 * names are case-sensitive — so the admin panel was writing history the
 * resident app could not read, and vice versa. There is one model here and
 * therefore one collection; the bug cannot recur. See SOCIETY-PLAN.md §6.1.
 */
const ACTIONS = [
  'CREATED', 'STATUS_CHANGED', 'UPDATED', 'DELETED',
  'COMMENT_ADDED', 'MEDIA_ADDED', 'ASSIGNED', 'REOPENED',
];

const complaintHistorySchema = new Schema({
  complaintId: { type: Schema.Types.ObjectId, ref: 'SocietyComplaint', required: true, index: true },
  action: { type: String, enum: ACTIONS, required: true },

  previousStatus: { type: String, default: null },
  newStatus: { type: String, default: null },
  comment: { type: String, default: null, maxlength: 2000 },
  notes: { type: String, default: null, maxlength: 2000 },

  changedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  /** Denormalised so history still reads correctly after the actor is removed. */
  changedByName: { type: String, default: null },
  changedByRole: { type: String, enum: ['SocietyAdmin', 'User', 'System'], default: 'System' },

  contentType: { type: String, enum: [...enums.complaintContentType, null], default: null },
  contentData: { type: Schema.Types.Mixed, default: null },
  metadata: { type: Schema.Types.Mixed, default: null },

  isDeleted: { type: Boolean, default: false },
}, { timestamps: true, collection: 'society_complainthistories' });

complaintHistorySchema.plugin(societyGuard);
complaintHistorySchema.index({ complaintId: 1, createdAt: -1 });
complaintHistorySchema.index({ societyId: 1, createdAt: -1 });
complaintHistorySchema.index({ complaintId: 1, action: 1 });

module.exports = model('SocietyComplaintHistory', complaintHistorySchema);
module.exports.ACTIONS = ACTIONS;
