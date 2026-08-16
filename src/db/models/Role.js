const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §6: custom roles. Nothing beyond the seeded defaults is hard-coded. */
const roleSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, maxlength: 250 },
  // key -> true | 'own' | 'team' | 'all'
  permissions: { type: Schema.Types.Mixed, default: () => ({}) },
  isSystem: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  active: { type: Boolean, default: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

roleSchema.plugin(tenantGuard);
roleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('Role', roleSchema);
