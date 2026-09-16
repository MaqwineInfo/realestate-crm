const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/** Third level of the society-enquiry pipeline. See `SocietyStage`. */
const childStageSchema = new Schema({
  societySubStageId: { type: Schema.Types.ObjectId, ref: 'SocietySubStage', index: true },
  title: { type: String, default: '', trim: true },
  orderBy: { type: Number, default: 0 },
  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_childstages' });

childStageSchema.plugin(platformScoped);
childStageSchema.index({ societySubStageId: 1, isDeleted: 1, orderBy: 1 });

module.exports = model('SocietyChildStage', childStageSchema);
