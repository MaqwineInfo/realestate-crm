const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * Every movement of a society enquiry: stage changes, reassignment, edits.
 *
 * Stores both sides of each transition (`previous*` / `new*`) rather than only
 * the new value, so the history reads correctly on its own without replaying
 * the whole chain to work out what changed.
 */
const inquiryHistorySchema = new Schema({
  inquiryId: { type: Schema.Types.ObjectId, ref: 'SocietyInquiry', required: true, index: true },
  actionBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  actionType: { type: String, default: '' },

  previousStageId: { type: Schema.Types.ObjectId, ref: 'SocietyStage' },
  newStageId: { type: Schema.Types.ObjectId, ref: 'SocietyStage' },
  previousSubStageId: { type: Schema.Types.ObjectId, ref: 'SocietySubStage' },
  newSubStageId: { type: Schema.Types.ObjectId, ref: 'SocietySubStage' },
  previousChildStageId: { type: Schema.Types.ObjectId, ref: 'SocietyChildStage' },
  newChildStageId: { type: Schema.Types.ObjectId, ref: 'SocietyChildStage' },
  previousOwnerId: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  newOwnerId: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },

  /** Snapshot of whatever the action changed, for edits with no stage move. */
  updatedObject: { type: Object },
  regUserId: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_inquiryhistories' });

inquiryHistorySchema.plugin(platformScoped);
inquiryHistorySchema.index({ inquiryId: 1, createdAt: -1 });

module.exports = model('SocietyInquiryHistory', inquiryHistorySchema);
