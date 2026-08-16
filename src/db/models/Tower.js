const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §27.1: Project → Tower/Block → Floor → Unit. Not every project uses towers. */
const towerSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  code: { type: String, trim: true, uppercase: true, maxlength: 20 },
  type: { type: String, enum: ['TOWER', 'BLOCK', 'WING', 'PHASE', 'CLUSTER'], default: 'TOWER' },
  floorCount: { type: Number, min: 0, default: 0 },
  status: { type: String, enum: ['PLANNED', 'ACTIVE', 'SOLD_OUT', 'ON_HOLD'], default: 'ACTIVE' },
  displayOrder: { type: Number, default: 0 },
}, { timestamps: true });

towerSchema.plugin(tenantGuard);
towerSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });

module.exports = model('Tower', towerSchema);
