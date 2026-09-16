const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/** Second level of the society-enquiry pipeline. See `SocietyStage`. */
const subStageSchema = new Schema({
  societyStageId: { type: Schema.Types.ObjectId, ref: 'SocietyStage', index: true },
  title: { type: String, default: '', trim: true },
  orderBy: { type: Number, default: 0 },
  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, {
  timestamps: true,
  collection: 'society_substages',
  toObject: { virtuals: true },
  toJSON: { virtuals: true },
});

subStageSchema.plugin(platformScoped);
subStageSchema.index({ societyStageId: 1, isDeleted: 1, orderBy: 1 });

subStageSchema.virtual('childStages', {
  ref: 'SocietyChildStage', localField: '_id', foreignField: 'societySubStageId',
});

module.exports = model('SocietySubStage', subStageSchema);
