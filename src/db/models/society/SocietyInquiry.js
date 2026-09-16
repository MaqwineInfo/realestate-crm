const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * An enquiry from a society that wants to join the platform — the lead that
 * eventually becomes a `Society`.
 *
 * Platform-scoped: it exists before the society does, which is the whole point.
 *
 * Carries a full three-level pipeline position, an owner, a follow-up date and
 * source attribution, because the super-admin screens work it as a real sales
 * pipeline rather than an inbox. `SocietyInquiryHistory` records every move.
 *
 * `isAction` marks an enquiry as needing attention — the flag the work-queue
 * screen filters on.
 *
 * Integration seam (SOCIETY-PLAN.md §3.10): this is the record that would feed
 * this codebase's own `Lead` pipeline if the two are ever joined.
 */
const inquirySchema = new Schema({
  societyName: { type: String, required: true, trim: true, index: true },
  societyAddress: { type: String, required: true },

  firstName: { type: String, default: '', trim: true },
  lastName: { type: String, default: '', trim: true },
  mobileNumber: { type: String, default: '', trim: true },
  countryCode: { type: String, default: '' },
  email: { type: String, default: '', trim: true, lowercase: true },
  noOfUnit: { type: String, default: '' },
  notes: { type: String, default: '' },

  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  status: { type: String, enum: enums.inquiryStatus, default: 'Pending', index: true },

  stageId: { type: Schema.Types.ObjectId, ref: 'SocietyStage', index: true },
  subStageId: { type: Schema.Types.ObjectId, ref: 'SocietySubStage', index: true },
  childStageId: { type: Schema.Types.ObjectId, ref: 'SocietyChildStage', index: true },

  followupDate: { type: Date, default: null },
  isAction: { type: Boolean, default: false },
  comments: { type: String, default: '' },
  lastActionAt: { type: Date },

  sourceName: { type: String, default: '' },
  subSourceName: { type: String, default: '' },

  originalOwnerId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', index: true },
  currentOwnerId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', index: true },
  previousOwnerId: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  assignedAt: { type: Date },
  assignedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },

  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_inquiry' });

inquirySchema.plugin(platformScoped);
inquirySchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
inquirySchema.index({ currentOwnerId: 1, isAction: 1, followupDate: 1 });
inquirySchema.index({ stageId: 1, subStageId: 1, childStageId: 1 });

module.exports = model('SocietyInquiry', inquirySchema);
