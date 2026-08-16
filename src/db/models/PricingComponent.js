const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §30.1/§30.2: the pricing profile for a project. A component says how it
 * is calculated, what it applies to, and who may change it.
 *
 * §85: these definitions are the only input to a cost sheet total. The browser
 * never supplies a price.
 */
const CALC_TYPES = ['FIXED', 'PER_AREA', 'PERCENTAGE', 'PER_UNIT_COUNT'];
const AREA_BASIS = ['CARPET', 'BUILT_UP', 'SALEABLE'];
const KINDS = [
  'BASE', 'FLOOR_RISE', 'PLC', 'VIEW', 'PARKING', 'MAINTENANCE', 'CORPUS', 'CLUB',
  'INFRASTRUCTURE', 'TAX', 'STAMP_DUTY', 'REGISTRATION', 'OTHER', 'DISCOUNT',
];

const pricingComponentSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  kind: { type: String, enum: KINDS, default: 'OTHER' },
  calcType: { type: String, enum: CALC_TYPES, required: true },
  // Rate in integer minor units; `percentage` is used when calcType is PERCENTAGE.
  rateMinor: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
  areaBasis: { type: String, enum: AREA_BASIS, default: 'SALEABLE' },
  // Which earlier component kinds a PERCENTAGE component is charged on.
  percentageBaseKinds: [{ type: String }],
  applicableUnitTypeIds: [{ type: Schema.Types.ObjectId, ref: 'UnitType' }],
  applicableTowerIds: [{ type: Schema.Types.ObjectId, ref: 'Tower' }],
  floorFrom: { type: Number },
  floorTo: { type: Number },
  effectiveFrom: { type: Date },
  effectiveTo: { type: Date },
  mandatory: { type: Boolean, default: true },
  taxable: { type: Boolean, default: false },
  customerVisible: { type: Boolean, default: true },
  editableBySales: { type: Boolean, default: false },
  requiresApprovalIfChanged: { type: Boolean, default: true },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

pricingComponentSchema.plugin(tenantGuard);
pricingComponentSchema.index({ tenantId: 1, projectId: 1, displayOrder: 1 });

module.exports = model('PricingComponent', pricingComponentSchema);
module.exports.CALC_TYPES = CALC_TYPES;
module.exports.AREA_BASIS = AREA_BASIS;
module.exports.KINDS = KINDS;
