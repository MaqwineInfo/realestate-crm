const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A flat, shop or office. The leaf of the society hierarchy and the thing
 * almost everything else hangs off — bills, complaints, parking, visitors.
 *
 * Occupancy is deliberately NOT stored as a member reference on the unit.
 * `currentOwnerId` / `currentTenantId` point at `SocietyUnitOccupancy` rows,
 * which carry their own start/end dates — so a unit keeps its history when a
 * tenant moves out, instead of the previous resident being overwritten.
 * The denormalised `residentType` / `isOccupied` / `occupancyStatus` here are a
 * read cache for list screens; `SocietyUnitOccupancy` is the source of truth.
 *
 * Money is integer paise (SOCIETY-PLAN.md §3.9); the source stored every one of
 * these as a decimal String. Areas are Numbers for the same reason — they are
 * multiplied by rates. Both serialize back to the source's strings at the
 * `/api/v1/*` boundary.
 *
 * `unitType` and `area` exist only to absorb the legacy service's unit shape
 * (SOCIETY-PLAN.md §2.2); the canonical surfaces do not write them.
 */
const MONEY = { type: Number, min: 0, default: null };
const AREA = { type: Number, min: 0, default: null };
const LABEL = { type: String, trim: true, default: '' };

const unitSchema = new Schema({
  societyCode: { type: String, required: true, trim: true, uppercase: true, index: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'SocietyBlock', index: true },
  floorId: { type: Schema.Types.ObjectId, ref: 'SocietyFloor', index: true },
  blockNumber: { type: String, trim: true },
  floorNumber: { type: Number },
  unitNumber: { type: String, required: true, trim: true },

  currentOwnerId: { type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy', default: null },
  currentTenantId: { type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy', default: null },

  status: { type: String, enum: enums.unitStatus, default: 'AVAILABLE', index: true },
  booked: { type: Boolean, default: false },
  occupancyStatus: { type: String, enum: enums.occupancyStatus, default: 'VACANT', index: true },
  isOccupied: { type: Boolean, default: false },
  residentType: { type: String, enum: enums.residentTypeUnit, default: 'Vacant' },

  direction: LABEL,
  sbaArea: AREA,
  sbaType: LABEL,
  reraCarpetArea: AREA,
  reraCarpetType: LABEL,
  balconyArea: AREA,
  balconyType: LABEL,
  washArea: AREA,
  washType: LABEL,
  totalCarpetArea: AREA,
  totalCarpetType: LABEL,
  terraceCarpetArea: AREA,
  terraceCarpetType: LABEL,

  unitBasicRateMinor: MONEY,
  terraceAreaRateMinor: MONEY,
  floorRiseMinor: MONEY,
  otherChargesMinor: MONEY,
  carParkingChargesMinor: MONEY,
  maintenanceDepositMinor: MONEY,
  townshipMaintenanceDepositMinor: MONEY,
  infrastructureDevelopmentMinor: MONEY,
  townshipMaintenanceChargesFor2YearsMinor: MONEY,
  agreementValueMinor: MONEY,
  gstOnAgreementValueMinor: MONEY,
  finalUnitValueMinor: MONEY,
  stampDutyMinor: MONEY,
  registrationChargesMinor: MONEY,

  /** Legacy façade only (SOCIETY-PLAN.md §2.2). */
  unitType: { type: String, enum: [...enums.unitTypes, null], default: null },
  area: AREA,

  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_units' });

unitSchema.plugin(societyGuard);
unitSchema.index({ societyId: 1, unitNumber: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
unitSchema.index({ societyId: 1, blockId: 1, floorId: 1 });
unitSchema.index({ societyId: 1, occupancyStatus: 1, isDeleted: 1 });

module.exports = model('SocietyUnit', unitSchema);
module.exports.MONEY_FIELDS = [
  'unitBasicRateMinor', 'terraceAreaRateMinor', 'floorRiseMinor', 'otherChargesMinor',
  'carParkingChargesMinor', 'maintenanceDepositMinor', 'townshipMaintenanceDepositMinor',
  'infrastructureDevelopmentMinor', 'townshipMaintenanceChargesFor2YearsMinor',
  'agreementValueMinor', 'gstOnAgreementValueMinor', 'finalUnitValueMinor',
  'stampDutyMinor', 'registrationChargesMinor',
];
