const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A wing or tower inside a society. `orderNo` fixes display order so blocks do
 * not reshuffle alphabetically when one is renamed mid-project.
 *
 * Both unique indexes are partial on `isDeleted: false`: a deleted block must
 * not reserve its name or its position forever.
 */
const blockSchema = new Schema({
  blockName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  orderNo: { type: Number, required: true },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_blocks' });

blockSchema.plugin(societyGuard);
blockSchema.index({ societyId: 1, isDeleted: 1 });
blockSchema.index({ societyId: 1, blockName: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
blockSchema.index({ societyId: 1, orderNo: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });

module.exports = model('SocietyBlock', blockSchema);
