const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §9.3: dynamic contact tags. Duplicate names are blocked case-insensitively. */
const tagSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  nameLower: { type: String, required: true },
  category: { type: String, trim: true, maxlength: 60 },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

tagSchema.plugin(tenantGuard);
tagSchema.index({ tenantId: 1, nameLower: 1 }, { unique: true });

tagSchema.pre('validate', function setLower() {
  if (this.name) this.nameLower = this.name.trim().toLowerCase();
});

module.exports = model('Tag', tagSchema);
