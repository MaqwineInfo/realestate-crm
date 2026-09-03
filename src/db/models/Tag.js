const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §9.3: dynamic contact tags. Duplicate names are blocked case-insensitively.
 *
 * `category` says which book the tag belongs to and is required at creation —
 * without it every tag surfaced on every screen, so nobody could tell a contact
 * tag from a partner one.
 */
const CATEGORIES = ['CONTACT', 'LEAD', 'CHANNEL_PARTNER', 'BOOKING'];
const tagSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  nameLower: { type: String, required: true },
  category: { type: String, enum: CATEGORIES, required: true, default: 'CONTACT', index: true },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

tagSchema.plugin(tenantGuard);
tagSchema.index({ tenantId: 1, nameLower: 1 }, { unique: true });

tagSchema.pre('validate', function setLower() {
  if (this.name) this.nameLower = this.name.trim().toLowerCase();
});

module.exports = model('Tag', tagSchema);
module.exports.CATEGORIES = CATEGORIES;
