const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * The society-enquiry sales pipeline, three levels deep:
 * `SocietyStage` → `SocietySubStage` → `SocietyChildStage`.
 *
 * Platform-scoped — these are the platform's own pipeline for selling the
 * product *to* societies, so they exist before any society does. Distinct from
 * this codebase's `Stage`/`SubStage`, which are the CRM's lead pipeline for
 * selling flats; the two never mix.
 *
 * `orderBy` fixes pipeline order independently of name.
 */
const stageSchema = new Schema({
  title: { type: String, default: '', trim: true },
  orderBy: { type: Number, default: 0 },
  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, {
  timestamps: true,
  collection: 'society_stages',
  toObject: { virtuals: true },
  toJSON: { virtuals: true },
});

stageSchema.plugin(platformScoped);
stageSchema.index({ isDeleted: 1, status: 1, orderBy: 1 });

stageSchema.virtual('subStages', {
  ref: 'SocietySubStage', localField: '_id', foreignField: 'societyStageId',
});

module.exports = model('SocietyStage', stageSchema);
