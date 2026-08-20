/** Single import point for models, so services never reach into file paths. */
module.exports = {
  // Organization & access
  Tenant: require('./Tenant'),
  User: require('./User'),
  Role: require('./Role'),
  AssignmentPool: require('./AssignmentPool'),

  // Masters (§78)
  Stage: require('./Stage'),
  SubStage: require('./SubStage'),
  ActionType: require('./ActionType'),
  VisitOutcome: require('./VisitOutcome'),
  LeadSource: require('./LeadSource'),
  Tag: require('./Tag'),

  // Contact & lead
  Contact: require('./Contact'),
  Lead: require('./Lead'),
  LeadStageHistory: require('./LeadStageHistory'),
  InquiryTouch: require('./InquiryTouch'),
  Activity: require('./Activity'),
  Followup: require('./Followup'),
  SiteVisit: require('./SiteVisit'),

  // Project & inventory
  Project: require('./Project'),
  ProjectAsset: require('./ProjectAsset'),
  Tower: require('./Tower'),
  Floor: require('./Floor'),
  UnitType: require('./UnitType'),
  Unit: require('./Unit'),
  PaymentPlan: require('./PaymentPlan'),
  PricingComponent: require('./PricingComponent'),

  // Deal
  UnitShortlist: require('./UnitShortlist'),
  CostSheet: require('./CostSheet'),
  ApprovalRule: require('./ApprovalRule'),
  Approval: require('./Approval'),
  UnitBlock: require('./UnitBlock'),
  Booking: require('./Booking'),
  ResaleOpportunity: require('./ResaleOpportunity'),
  RentalOpportunity: require('./RentalOpportunity'),

  // Post-booking & collections (V2 Part C)
  BookingCustomerLink: require('./BookingCustomerLink'),
  BookingApplicant: require('./BookingApplicant'),
  KycDocumentType: require('./KycDocumentType'),
  BookingKycDocument: require('./BookingKycDocument'),
  BookingInstallment: require('./BookingInstallment'),
  PaymentRequest: require('./PaymentRequest'),
  BookingReceipt: require('./BookingReceipt'),
  ReceiptAllocation: require('./ReceiptAllocation'),
  CollectionFollowUp: require('./CollectionFollowUp'),
  CollectionPromise: require('./CollectionPromise'),

  // Channel partner (V2 Part A)
  ChannelPartnerRegistration: require('./ChannelPartnerRegistration'),
  ChannelPartner: require('./ChannelPartner'),
  ChannelPartnerMember: require('./ChannelPartnerMember'),
  PartnerPortalUser: require('./PartnerPortalUser'),
  PartnerReraDocument: require('./PartnerReraDocument'),
  PartnerProjectEmpanelment: require('./PartnerProjectEmpanelment'),
  PartnerLeadClaim: require('./PartnerLeadClaim'),
  PartnerCommissionRule: require('./PartnerCommissionRule'),
  PartnerCommissionEntitlement: require('./PartnerCommissionEntitlement'),
  PartnerInvoice: require('./PartnerInvoice'),
  PartnerPayout: require('./PartnerPayout'),

  // Marketing
  SavedSegment: require('./SavedSegment'),
  CommunicationCampaign: require('./CommunicationCampaign'),
  MarketingCampaign: require('./MarketingCampaign'),
  NurtureSequence: require('./NurtureSequence'),
  NurtureEnrollment: require('./NurtureEnrollment'),

  // Operations
  SlaRule: require('./SlaRule'),
  Integration: require('./Integration'),
  WebhookEvent: require('./WebhookEvent'),
  Template: require('./Template'),
  AckRule: require('./AckRule'),
  MessageLog: require('./MessageLog'),
  Notification: require('./Notification'),
  AuditLog: require('./AuditLog'),
};
