const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §30.4/§30.5: a versioned quote. A shared sheet is never edited in place —
 * a new version supersedes it and the old one stays readable.
 *
 * Every amount here is an integer in minor units and is recomputed server-side
 * from the unit and the project pricing profile (§85).
 */
const lineSchema = new Schema({
  componentId: { type: Schema.Types.ObjectId, ref: 'PricingComponent' },
  name: { type: String, required: true },
  kind: { type: String },
  calcType: { type: String },
  basis: { type: String },
  quantity: { type: Number },
  rateMinor: { type: Number },
  percentage: { type: Number },
  amountMinor: { type: Number, required: true },
  customerVisible: { type: Boolean, default: true },
  edited: { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
}, { _id: false });

const costSheetSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'Unit', required: true, index: true },
  version: { type: Number, required: true, default: 1 },
  supersedesId: { type: Schema.Types.ObjectId, ref: 'CostSheet' },

  lines: [lineSchema],
  basePriceMinor: { type: Number, default: 0 },
  grossAmountMinor: { type: Number, default: 0 },
  discountMinor: { type: Number, default: 0 },
  discountPercentage: { type: Number, default: 0 },
  taxAndChargesMinor: { type: Number, default: 0 },
  finalConsiderationMinor: { type: Number, default: 0 },
  currency: { type: String, default: 'INR' },

  paymentPlanId: { type: Schema.Types.ObjectId, ref: 'PaymentPlan' },
  /**
   * V1.1 §44: the schedule as it stood when this quotation was issued.
   *
   * Without this, editing a project's payment plan silently rewrites every
   * quotation ever shared against it — including one a customer is holding.
   */
  paymentPlanName: { type: String },
  paymentPlanBasis: { type: String },
  paymentPlanRows: [{
    sequence: Number,
    label: String,
    percentage: Number,
    dueRule: String,
    dueOffsetDays: Number,
    customerNote: String,
  }],
  // V1.1 §105: a number a human can read out over the phone.
  quotationNumber: { type: String, index: true },
  validUntil: { type: Date },
  status: {
    type: String,
    enum: ['DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'SHARED', 'EXPIRED', 'SUPERSEDED'],
    default: 'DRAFT',
    index: true,
  },
  // §31: set when the discount crossed a threshold and needed sign-off.
  approvalRequired: { type: Boolean, default: false },
  approvalId: { type: Schema.Types.ObjectId, ref: 'Approval' },
  approvedAt: { type: Date },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  // §30.3 step 10: tokenised link for sharing the sheet with the customer.
  shareToken: { type: String, index: true },
  sharedAt: { type: Date },
  notes: { type: String, maxlength: 2000 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

costSheetSchema.plugin(tenantGuard);
costSheetSchema.index({ tenantId: 1, leadId: 1, version: -1 });
costSheetSchema.index({ tenantId: 1, unitId: 1, status: 1 });

module.exports = model('CostSheet', costSheetSchema);
