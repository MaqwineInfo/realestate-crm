const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * The society itself — the root of everything in this module.
 *
 * Platform-scoped (SOCIETY-PLAN.md D3): societies sit above tenants, so this
 * carries neither `tenantId` nor `societyId`. Every other society-scoped model
 * points here.
 *
 * `unitConfiguration` is a template, not a record: creating units copies these
 * defaults onto each one, so an operator sets the rate card once per society
 * instead of on four hundred units. Money in it is stored as integer paise
 * (`...Minor`) like everywhere else in this codebase and serialized back to the
 * source's decimal strings at the `/api/v1/*` boundary — see
 * `lib/society/serialize.js` and SOCIETY-PLAN.md §3.9.
 */
const MONEY = { type: Number, min: 0, default: null };
const AREA = { type: Number, min: 0, default: null };
const UNIT_LABEL = { type: String, trim: true, default: '' };

const unitConfigurationSchema = new Schema({
  direction: { type: String, trim: true, default: '' },
  unitStatus: { type: String, enum: enums.unitStatus, default: 'AVAILABLE' },

  sbaArea: AREA,
  sbaType: UNIT_LABEL,
  reraCarpetArea: AREA,
  reraCarpetType: UNIT_LABEL,
  balconyArea: AREA,
  balconyType: UNIT_LABEL,
  washArea: AREA,
  washType: UNIT_LABEL,
  totalCarpetArea: AREA,
  totalCarpetType: UNIT_LABEL,
  terraceCarpetArea: AREA,
  terraceCarpetType: UNIT_LABEL,

  unitBasicRateMinor: MONEY,
  terraceAreaRateMinor: MONEY,
  floorRiseMinor: MONEY,
  otherChargesMinor: MONEY,
  carParkingChargesMinor: MONEY,
  agreementValueMinor: MONEY,
  gstOnAgreementValueMinor: MONEY,
  basicUnitValueMinor: MONEY,
  finalUnitValueMinor: MONEY,
  stampDutyMinor: MONEY,
  registrationChargesMinor: MONEY,
  maintenanceDepositMinor: MONEY,
  townshipMaintenanceDepositMinor: MONEY,
  infrastructureDevelopmentMinor: MONEY,
  townshipMaintenanceChargesFor2YearsMinor: MONEY,
}, { _id: false });

const societySchema = new Schema({
  // Basic information
  societyName: { type: String, required: true, trim: true, index: true },
  societyCode: { type: String, required: true, unique: true, trim: true, uppercase: true, index: true },
  description: { type: String, trim: true, maxlength: 500 },
  logo: { type: String, default: null },

  // Project details
  projectType: { type: String, required: true, enum: enums.projectType, default: 'Residential' },
  totalUnits: { type: Number, default: 0, min: 0 },
  totalBlocks: { type: Number, default: 0, min: 0 },
  totalFloors: { type: Number, default: 0, min: 0 },
  /** Whether generated floors start at 0 (Ground) or 1. Drives structure generation. */
  includeGroundFloor: { type: Boolean, default: false },
  carpetAreaRange: { type: String, trim: true },
  onboardingDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  developerName: { type: String, trim: true },
  developerId: { type: Schema.Types.ObjectId, ref: 'SocietyDeveloper', default: null },
  planExpiryDate: { type: Date, default: null },
  territory: { type: String, trim: true, default: null },
  area: { type: String, trim: true, default: null },

  // Contact
  contactPersonName: { type: String, required: true, trim: true },
  contactNumber: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  alternateContact: { type: String, trim: true, default: null },

  address: {
    street: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true, index: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, required: true, trim: true },
  },

  legalDocuments: {
    rera: {
      number: { type: String, trim: true, default: null },
      reraCertificate: { type: String, default: null },
      expiryDate: { type: Date, default: null },
    },
    fireNoc: {
      number: { type: String, trim: true, default: null },
      fireNocDocument: { type: String, default: null },
      validityDate: { type: Date, default: null },
    },
    buCertificate: {
      number: { type: String, trim: true, default: null },
      buCertificate: { type: String, default: null },
      issueDate: { type: Date, default: null },
    },
    liftLicence: {
      number: { type: String, trim: true, default: null },
      liftLicenceDocument: { type: String, default: null },
      expiryDate: { type: Date, default: null },
    },
  },

  bankDetails: {
    bankName: { type: String, trim: true, default: null },
    accountNumber: { type: String, trim: true, default: null },
    accountHolderName: { type: String, trim: true, default: null },
    ifscCode: { type: String, trim: true, uppercase: true, default: null },
    branchName: { type: String, trim: true, default: null },
    branchAddress: { type: String, trim: true, default: null },
  },

  /** Drives the amenity-booking payment QR code. */
  upiDetails: {
    upiId: { type: String, trim: true, default: null },
    upiDisplayName: { type: String, trim: true, default: null },
  },

  taxInformation: {
    gstNumber: { type: String, trim: true, uppercase: true, default: null },
    gstCertificate: { type: String, default: null },
    panNumber: { type: String, trim: true, uppercase: true, default: null },
    tanNumber: { type: String, trim: true, uppercase: true, default: null },
  },

  financialYear: {
    fyStartMonth: { type: String, default: 'April' },
    currentFinancialYear: { type: String, default: null },
  },

  status: { type: String, required: true, enum: ['Pending', 'Active', 'Inactive'], default: 'Active', index: true },
  billingCycle: { type: String, required: true, enum: ['Monthly', 'Quarterly', 'Yearly'], default: 'Monthly' },
  registeredMembersCount: { type: Number, default: 0, min: 0 },

  unitConfiguration: { type: unitConfigurationSchema, default: () => ({}) },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  /** The chairman created alongside the society. */
  adminUserId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_societies' });

societySchema.plugin(platformScoped);

societySchema.index({ societyName: 'text', 'address.city': 'text' });
societySchema.index({ societyCode: 1, isDeleted: 1 });
societySchema.index({ status: 1, isDeleted: 1 });
societySchema.index({ projectType: 1 });
societySchema.index({ createdAt: -1 });

societySchema.virtual('fullAddress').get(function fullAddress() {
  if (!this.address) return '';
  return `${this.address.street}, ${this.address.city}, ${this.address.state} - ${this.address.pincode}`;
});

module.exports = model('Society', societySchema);
module.exports.MONEY_FIELDS = [
  'unitConfiguration.unitBasicRateMinor', 'unitConfiguration.terraceAreaRateMinor',
  'unitConfiguration.floorRiseMinor', 'unitConfiguration.otherChargesMinor',
  'unitConfiguration.carParkingChargesMinor', 'unitConfiguration.agreementValueMinor',
  'unitConfiguration.gstOnAgreementValueMinor', 'unitConfiguration.basicUnitValueMinor',
  'unitConfiguration.finalUnitValueMinor', 'unitConfiguration.stampDutyMinor',
  'unitConfiguration.registrationChargesMinor', 'unitConfiguration.maintenanceDepositMinor',
  'unitConfiguration.townshipMaintenanceDepositMinor',
  'unitConfiguration.infrastructureDevelopmentMinor',
  'unitConfiguration.townshipMaintenanceChargesFor2YearsMinor',
];
