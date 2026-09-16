const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * One visit: expected, approved, entered, exited.
 *
 * `unitApprovals` is an array because a visitor can be headed to more than one
 * flat (a contractor doing three units), and each resident approves
 * independently — a single `approvalStatus` could not express "402 said yes,
 * 403 has not answered". The scalar `approvalStatus` is the rolled-up view the
 * gate screen reads.
 *
 * A frequent pass is modelled as a parent log (`isFrequentPass`, with
 * `fromDate`/`toDate`) plus one child log per actual arrival pointing back
 * through `parentPassId` — so a maid's daily entries are individually
 * timestamped without re-approving the pass each morning.
 *
 * `createdBy` records which surface raised it: the gate device, the resident
 * app pre-approving a guest, or an admin.
 */
const visitorLogSchema = new Schema({
  visitorId: { type: Schema.Types.ObjectId, ref: 'SocietyVisitor', required: true },

  unitIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyUnit' }],
  unitApprovals: [{
    unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit' },
    status: { type: String, enum: enums.visitorApprovalStatus, default: 'PENDING' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'SocietyMember' },
    approvedAt: { type: Date },
  }],
  targetOccupancyIds: [{ type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy' }],

  visitorType: { type: String, enum: enums.visitorTypes, required: true },
  visitorCount: { type: Number, default: 1 },
  vehicleNumber: { type: String, trim: true, uppercase: true, default: null },
  vehicleType: { type: String, trim: true, default: null },
  photo: { type: String, default: null },
  purposeOfVisit: { type: String, trim: true, default: null },

  visitFrequency: { type: String, enum: enums.visitFrequency, default: 'ONCE' },
  expectedDate: { type: Date, default: null },
  expectedTime: { type: String, default: null },
  validTill: { type: String, enum: enums.validTillOptions, default: '24_HOURS' },
  validTillDate: { type: Date, default: null },

  fromDate: { type: Date, default: null },
  toDate: { type: Date, default: null },
  fromTime: { type: String, default: null },
  toTime: { type: String, default: null },
  isFrequentPass: { type: Boolean, default: false },
  parentPassId: { type: Schema.Types.ObjectId, ref: 'SocietyVisitorLog', default: null, index: true },

  status: { type: String, enum: enums.visitorStatus, default: 'PENDING_APPROVAL', index: true },
  approvalStatus: { type: String, enum: enums.visitorApprovalStatus, default: 'PENDING' },

  createdBy: { type: String, enum: ['GATEKEEPER', 'MEMBER', 'ADMIN'], default: 'GATEKEEPER', index: true },
  createdByMemberId: { type: Schema.Types.ObjectId, ref: 'SocietyMember', default: null, index: true },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'SocietyMember', default: null },
  approvedAt: { type: Date, default: null },

  inTime: { type: Date, default: null },
  outTime: { type: Date, default: null },
  enteredBy: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', default: null },
  exitBy: { type: Schema.Types.ObjectId, ref: 'SocietyEmployee', default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_visitorlogs' });

visitorLogSchema.plugin(societyGuard);
visitorLogSchema.index({ societyId: 1, status: 1, inTime: -1 });
visitorLogSchema.index({ societyId: 1, inTime: -1 });
visitorLogSchema.index({ societyId: 1, unitIds: 1, inTime: -1 });
visitorLogSchema.index({ visitorId: 1, inTime: -1 });
visitorLogSchema.index({ societyId: 1, vehicleNumber: 1, inTime: -1 });
visitorLogSchema.index({ societyId: 1, isFrequentPass: 1, fromDate: 1, toDate: 1, status: 1 });
visitorLogSchema.index({ parentPassId: 1, inTime: -1 });
visitorLogSchema.index({ societyId: 1, createdBy: 1, expectedDate: 1, status: 1 });

module.exports = model('SocietyVisitorLog', visitorLogSchema);
