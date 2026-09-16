const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A lost or found item posted to the community board.
 *
 * `reportedBy` is polymorphic via `reporterModel` because any of three very
 * different actors can post one: an admin, a resident (through their occupancy
 * row) or a guard who found something at the gate.
 *
 * `itemId` (LF-001) comes from `SocietyCounter`, not from reading the last row
 * — see that model for why the source's version raced.
 */
const lostAndFoundSchema = new Schema({
  itemId: { type: String, trim: true },

  type: { type: String, enum: enums.lostAndFoundTypes, required: true },
  category: { type: String, enum: [...enums.lostAndFoundCategories, null], default: null },
  itemName: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, trim: true, maxlength: 500 },
  image: { type: String, default: null, trim: true },

  status: { type: String, enum: enums.lostAndFoundStatus, default: 'ACTIVE' },

  reportedBy: { type: Schema.Types.ObjectId, refPath: 'reporterModel', index: true },
  reporterModel: {
    type: String,
    required: true,
    enum: ['SocietyAdmin', 'SocietyUnitOccupancy', 'SocietyEmployee'],
    default: 'SocietyAdmin',
  },

  claimedBy: { type: Schema.Types.ObjectId, ref: 'SocietyMember', default: null },
  claimedAt: { type: Date, default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_lostandfounds' });

lostAndFoundSchema.plugin(societyGuard);
/**
 * Partial, not sparse: `sparse` still indexes an explicit `null`, so every
 * document that leaves this unset would collide with the first. See the note
 * on `SocietyMember.userId`.
 */
lostAndFoundSchema.index(
  { itemId: 1 },
  { unique: true, partialFilterExpression: { itemId: { $type: 'string' } } },
);
lostAndFoundSchema.index({ societyId: 1, isDeleted: 1, status: 1, createdAt: -1 });
lostAndFoundSchema.index({ societyId: 1, type: 1, status: 1 });

module.exports = model('SocietyLostAndFound', lostAndFoundSchema);
