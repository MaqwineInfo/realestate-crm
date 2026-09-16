const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/** Water, electricity, clubhouse — the kinds of one-off bill a society raises. */
const billCategorySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  photo: { type: String, default: null, trim: true },
  description: { type: String, maxlength: 500, default: null, trim: true },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_billcategories' });

billCategorySchema.plugin(societyGuard);
billCategorySchema.index({ societyId: 1, isDeleted: 1, status: 1 });
billCategorySchema.index(
  { societyId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

module.exports = model('SocietyBillCategory', billCategorySchema);
