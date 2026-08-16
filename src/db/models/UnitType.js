const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/** Spec §27.3: the configuration a unit belongs to (2BHK, Shop, Plot, Villa…). */
const unitTypeSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  propertyType: {
    type: String,
    enum: ['APARTMENT', 'VILLA', 'PLOT', 'SHOP', 'OFFICE', 'PENTHOUSE', 'OTHER'],
    default: 'APARTMENT',
  },
  bedrooms: { type: Number, min: 0 },
  bathrooms: { type: Number, min: 0 },
  carpetArea: { type: Number, min: 0 },
  builtUpArea: { type: Number, min: 0 },
  superBuiltUpArea: { type: Number, min: 0 },
  balconyArea: { type: Number, min: 0 },
  areaUnit: { type: String, default: 'sqft' },
  description: { type: String, maxlength: 1000 },
  // Money in integer minor units per area unit (§73).
  defaultBaseRateMinor: { type: Number, min: 0 },
  floorPlanUrl: { type: String },
  active: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
}, { timestamps: true });

unitTypeSchema.plugin(tenantGuard);
unitTypeSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });

module.exports = model('UnitType', unitTypeSchema);
