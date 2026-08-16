const { Schema, model } = require('mongoose');

/** Spec §4.1–4.3: the tenant/organization. Not tenant-scoped itself. */
const settingsSchema = new Schema({
  // §40: primary reporting attribution model.
  attributionModel: { type: String, enum: ['FIRST_TOUCH', 'LAST_TOUCH'], default: 'LAST_TOUCH' },
  // §16.1 SLA defaults (minutes). Project-level overrides live on SlaRule.
  slaResponseMinutes: { type: Number, default: 5 },
  slaWarningMinutes: { type: Number, default: 5 },
  slaEscalationMinutes: { type: Number, default: 10 },
  slaAutoReassignMinutes: { type: Number, default: 15 },
  slaMaxAutoReassignments: { type: Number, default: 2 },
  // §72: does the SLA clock run 24x7 or only inside business hours?
  slaBusinessHoursOnly: { type: Boolean, default: false },
  businessHours: {
    start: { type: String, default: '09:30' },
    end: { type: String, default: '19:00' },
    days: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
  },
  // §13.2: optionally restart the response timer when an existing lead re-inquires.
  reinquiryRestartsSla: { type: Boolean, default: true },
  // §32.3: default unit block duration; project override allowed.
  blockDurationHours: { type: Number, default: 48 },
  blockReminderHours: { type: Number, default: 6 },
  // §84: let visit scheduling/completion move the lead stage automatically.
  autoStageOnVisit: { type: Boolean, default: true },
  // §25.1: is channel-partner mobile mandatory on the QR walk-in form?
  qrRequireCpMobile: { type: Boolean, default: false },
}, { _id: false });

const tenantSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  legalName: { type: String, trim: true, maxlength: 150 },
  country: { type: String, default: 'IN' },
  callingCode: { type: String, default: '91' },
  timezone: { type: String, default: 'Asia/Kolkata' },
  currency: { type: String, default: 'INR' },
  locale: { type: String, default: 'en-IN' },
  dateFormat: { type: String, default: 'dd MMM yyyy' },
  logoUrl: { type: String },
  website: { type: String },
  address: { type: String, maxlength: 500 },
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED'], default: 'ACTIVE' },
  settings: { type: settingsSchema, default: () => ({}) },
}, { timestamps: true });

module.exports = model('Tenant', tenantSchema);
