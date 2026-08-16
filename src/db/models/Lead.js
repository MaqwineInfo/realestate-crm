const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §10: a sales opportunity linked to a Contact. One Contact, many Leads.
 *
 * Two field groups here are system-owned and must never be casually edited
 * (§80): the source-history fields (original/firstTouch, §41) and the SLA
 * measurement fields (§16.5).
 */
const leadSchema = new Schema({
  contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },

  ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  previousOwnerUserId: { type: Schema.Types.ObjectId, ref: 'User' },
  assignmentPoolId: { type: Schema.Types.ObjectId, ref: 'AssignmentPool' },

  stageId: { type: Schema.Types.ObjectId, ref: 'Stage', required: true, index: true },
  subStageId: { type: Schema.Types.ObjectId, ref: 'SubStage' },
  // Denormalised from the stage so queues can filter without a join (§10.2).
  status: { type: String, enum: ['ACTIVE', 'TERMINAL'], default: 'ACTIVE', index: true },

  // §41: source history is never overwritten. Only `latest*` moves on re-inquiry.
  sourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource', required: true },
  sourceDetail: { type: String },
  originalSourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource', required: true },
  latestSourceId: { type: Schema.Types.ObjectId, ref: 'LeadSource', required: true },
  campaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign', index: true },
  firstTouchCampaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign' },
  lastTouchCampaignId: { type: Schema.Types.ObjectId, ref: 'MarketingCampaign' },
  adSetExternalId: { type: String },
  adExternalId: { type: String },

  firstInquiryAt: { type: Date, required: true },
  latestInquiryAt: { type: Date, required: true, index: true },
  inquiryCount: { type: Number, default: 1 },
  isReinquiry: { type: Boolean, default: false },
  reinquiryPendingAt: { type: Date },      // cleared when the owner acknowledges (§8.2 tile)
  relatedPreviousLeadId: { type: Schema.Types.ObjectId, ref: 'Lead' },

  // §16.5 SLA measurement.
  capturedAt: { type: Date, required: true },
  assignedAt: { type: Date },
  firstGenuineActionAt: { type: Date },
  firstResponseSeconds: { type: Number },
  slaTargetSeconds: { type: Number },
  slaStatus: {
    type: String,
    enum: ['PENDING', 'WITHIN_SLA', 'AT_RISK', 'BREACHED', 'REASSIGNED'],
    default: 'PENDING',
    index: true,
  },
  slaBreached: { type: Boolean, default: false },
  slaBreachSeconds: { type: Number },
  slaWarningSentAt: { type: Date },
  slaEscalatedAt: { type: Date },
  reassignmentCount: { type: Number, default: 0 },

  // Manual queue-sort control (§8.2). Deliberately NOT the sales temperature —
  // V1.1 §98 keeps these separate so queue ordering stays under human control.
  priority: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM', index: true },
  priorityScore: { type: Number, default: 0 },

  // V1.1 §14: sales temperature. Auto-scored from recorded activity, pinnable
  // by an authorized user with a reason (§14.6).
  temperatureScore: { type: Number, default: 45, min: 0, max: 100 },
  temperature: { type: String, enum: ['HOT', 'WARM', 'COLD'], default: 'WARM', index: true },
  temperatureMode: { type: String, enum: ['AUTO', 'MANUAL'], default: 'AUTO' },
  temperatureOverrideBy: { type: Schema.Types.ObjectId, ref: 'User' },
  temperatureOverrideAt: { type: Date },
  temperatureOverrideReason: { type: String, maxlength: 500 },
  temperatureUpdatedAt: { type: Date },

  // Requirement (§79). Money is integer minor units (§73).
  budgetMinMinor: { type: Number, min: 0 },
  budgetMaxMinor: { type: Number, min: 0 },
  preferredConfigurations: [{ type: String }],
  preferredFacing: { type: String },
  // V1.1 §10: facing is a multi-select. The legacy single value above is still
  // read when this list is empty, so no existing lead needs migrating.
  preferredFacings: [{ type: String }],
  preferredFloorMin: { type: Number },
  preferredFloorMax: { type: Number },
  areaMin: { type: Number },
  areaMax: { type: Number },
  areaBasis: { type: String, enum: ['CARPET', 'BUILT_UP', 'SALEABLE'] },
  purpose: { type: String, enum: ['SELF_USE', 'INVESTMENT', 'RENTAL_INCOME', 'OTHER'] },
  preferredLocation: { type: String, maxlength: 200 },
  requirementNote: { type: String, maxlength: 2000 },

  // V1.1 §10.1: real-estate qualification. All optional — capture speed wins,
  // and a half-filled qualification is still better than a note nobody reads.
  possessionPreference: { type: String, enum: ['READY', 'NEAR_POSSESSION', 'UNDER_CONSTRUCTION', 'ANY'] },
  purchaseTimeline: { type: String, enum: ['IMMEDIATE', 'DAYS_0_30', 'MONTHS_1_3', 'MONTHS_3_6', 'MONTHS_6_PLUS', 'EXPLORING'] },
  fundingType: { type: String, enum: ['SELF_FUNDED', 'HOME_LOAN', 'MIXED', 'UNKNOWN'] },
  loanStatus: { type: String, enum: ['NOT_STARTED', 'EXPLORING', 'PRE_APPROVED', 'APPROVED'] },
  decisionMaker: { type: String, enum: ['SELF', 'SPOUSE', 'FAMILY', 'BUSINESS_PARTNER', 'OTHER'] },

  // V1.1 §9.1/§9.2: who sent them, when the source is a referral or a portal.
  referrerName: { type: String, maxlength: 120 },
  referrerMobile: { type: String, maxlength: 20 },
  referrerContactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
  portalLeadId: { type: String, maxlength: 80 },
  listingReference: { type: String, maxlength: 120 },
  notesSummary: { type: String, maxlength: 2000 },
  aiSummary: { type: String },
  aiSummaryAt: { type: Date },
  aiSuggestedAction: { type: String },

  // Denormalised next action so the work queues are a single indexed read (§60).
  nextFollowupId: { type: Schema.Types.ObjectId, ref: 'Followup' },
  nextActionAt: { type: Date, index: true },
  nextActionTypeId: { type: Schema.Types.ObjectId, ref: 'ActionType' },
  lastActivityAt: { type: Date },

  visitCount: { type: Number, default: 0 },
  completedVisitCount: { type: Number, default: 0 },
  shortlistCount: { type: Number, default: 0 },

  lostReasonSubStageId: { type: Schema.Types.ObjectId, ref: 'SubStage' },
  lostNote: { type: String },
  lostAt: { type: Date },
  bookedAt: { type: Date },
  bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
  activeBlockId: { type: Schema.Types.ObjectId, ref: 'UnitBlock' },

  archived: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdVia: { type: String, default: 'MANUAL' },
}, { timestamps: true });

leadSchema.plugin(tenantGuard);
// §60 index list.
leadSchema.index({ tenantId: 1, ownerUserId: 1, status: 1 });
leadSchema.index({ tenantId: 1, ownerUserId: 1, nextActionAt: 1 });
leadSchema.index({ tenantId: 1, stageId: 1 });
leadSchema.index({ tenantId: 1, projectId: 1 });
leadSchema.index({ tenantId: 1, latestInquiryAt: -1 });
leadSchema.index({ tenantId: 1, slaStatus: 1 });
leadSchema.index({ tenantId: 1, sourceId: 1 });
leadSchema.index({ tenantId: 1, campaignId: 1 });
leadSchema.index({ tenantId: 1, contactId: 1, projectId: 1, status: 1 });
// The New Leads tile: assigned, active, never genuinely attended (§8.2).
leadSchema.index({ tenantId: 1, ownerUserId: 1, firstGenuineActionAt: 1, status: 1 });

module.exports = model('Lead', leadSchema);
