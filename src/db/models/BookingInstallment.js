const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V2 §132: one row per milestone of the booking's payment schedule.
 *
 * Generated once from the FROZEN payment plan snapshot on the booking (which
 * itself came from the quotation, §114/§115) — never from today's project
 * master, so editing a payment plan can never rewrite a live schedule.
 *
 * `status` is stored; OVERDUE is derived (§136) because it changes with the
 * clock rather than with a write, and two screens must never disagree about it.
 */
const STATUSES = ['UPCOMING', 'DUE', 'PARTIAL', 'PAID', 'CANCELLED'];

/**
 * §133 due rules. The V1.1 PaymentPlan enum is deliberately left alone and
 * translated on the way in (see services/installments.js), so the existing
 * payment-plan setup screen keeps working unchanged.
 */
const DUE_RULES = [
  'BOOKING_DATE', 'DAYS_AFTER_BOOKING', 'FIXED_DATE',
  'EXPECTED_MILESTONE_DATE', 'POSSESSION_DATE', 'MANUAL_TRIGGER',
];

const bookingInstallmentSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  sequence: { type: Number, required: true },
  milestone: { type: String, required: true, maxlength: 120 },
  percentage: { type: Number, min: 0, max: 100 },
  scheduledAmountMinor: { type: Number, required: true, min: 0 },

  dueRule: { type: String, enum: DUE_RULES, default: 'MANUAL_TRIGGER' },
  dueOffsetDays: { type: Number, min: 0 },
  /**
   * §135: the date the rule resolves to. Null means "TBD" — a construction
   * milestone whose date nobody knows yet. A TBD date is never invented, and a
   * TBD installment is never overdue.
   */
  expectedDueDate: { type: Date, default: null },
  /** §268: set when an authorized user fixes the real date. Wins over expected. */
  actualDueDate: { type: Date, default: null },

  amountReceivedMinor: { type: Number, default: 0, min: 0 },
  outstandingMinor: { type: Number, default: 0 },
  status: { type: String, enum: STATUSES, default: 'UPCOMING', index: true },
  paidAt: { type: Date },
  customerNote: { type: String, maxlength: 300 },
  note: { type: String, maxlength: 500 },
  /**
   * §163: which reminder bands have already gone out for this installment
   * ("BEFORE_7", "DUE", "AFTER_1"...). Storing the band is what makes the
   * reminder job idempotent — a tick that runs twice cannot message twice.
   */
  remindersSent: [{ type: String }],
}, { timestamps: true });

bookingInstallmentSchema.plugin(tenantGuard);
// §240: one row per sequence per booking makes generation idempotent.
bookingInstallmentSchema.index({ tenantId: 1, bookingId: 1, sequence: 1 }, { unique: true });
bookingInstallmentSchema.index({ tenantId: 1, status: 1, expectedDueDate: 1 });

/** The date this installment is actually payable on, or null while TBD. */
bookingInstallmentSchema.virtual('dueDate').get(function dueDate() {
  return this.actualDueDate || this.expectedDueDate || null;
});

module.exports = model('BookingInstallment', bookingInstallmentSchema);
module.exports.STATUSES = STATUSES;
module.exports.DUE_RULES = DUE_RULES;
