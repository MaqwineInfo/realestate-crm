const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §27.2. `number` drives floor-rise pricing; `name` is what sales says. */
const floorSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  towerId: { type: Schema.Types.ObjectId, ref: 'Tower', index: true },
  number: { type: Number, required: true },
  name: { type: String, trim: true, maxlength: 40 },
  displayOrder: { type: Number, default: 0 },
  floorRiseGroup: { type: String, trim: true },
}, { timestamps: true });

floorSchema.plugin(tenantGuard);
floorSchema.index({ tenantId: 1, towerId: 1, number: 1 }, { unique: true });

module.exports = model('Floor', floorSchema);
