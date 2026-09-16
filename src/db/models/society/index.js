/**
 * Single import point for the society models, mirroring `db/models/index.js`
 * so services never reach into file paths.
 *
 * Every model here carries exactly one of `societyGuard` (society-scoped) or
 * `platformScoped` (deliberately global) — asserted by
 * `tests/society/model-parity.test.js`. None carries `tenantGuard`: societies
 * sit above tenants in this build (SOCIETY-PLAN.md D3).
 */
module.exports = {
  // Platform & access
  Society: require('./Society'),
  SocietyDeveloper: require('./SocietyDeveloper'),
  SocietyUser: require('./SocietyUser'),
  SocietyAdmin: require('./SocietyAdmin'),
  SocietyRole: require('./SocietyRole'),
  SocietyTokenBlacklist: require('./SocietyTokenBlacklist'),
  SocietyCounter: require('./SocietyCounter'),

  // Enquiry pipeline
  SocietyStage: require('./SocietyStage'),
  SocietySubStage: require('./SocietySubStage'),
  SocietyChildStage: require('./SocietyChildStage'),
  SocietyInquiry: require('./SocietyInquiry'),
  SocietyInquiryHistory: require('./SocietyInquiryHistory'),

  // Structure
  SocietyBlock: require('./SocietyBlock'),
  SocietyFloor: require('./SocietyFloor'),
  SocietyUnit: require('./SocietyUnit'),
  SocietyUnitOccupancy: require('./SocietyUnitOccupancy'),

  // People
  SocietyMember: require('./SocietyMember'),
  SocietyFamilyMember: require('./SocietyFamilyMember'),
  SocietyCommitteeMember: require('./SocietyCommitteeMember'),
  SocietyResidentOnboardingRequest: require('./SocietyResidentOnboardingRequest'),

  // Staff
  SocietyEmployee: require('./SocietyEmployee'),
  SocietyEmployeeType: require('./SocietyEmployeeType'),
  SocietyEmployeeAssignment: require('./SocietyEmployeeAssignment'),
  SocietyEmployeeAttendance: require('./SocietyEmployeeAttendance'),

  // Communication
  SocietyNotice: require('./SocietyNotice'),
  SocietyNotification: require('./SocietyNotification'),
  SocietyPoll: require('./SocietyPoll'),
  SocietyPollVote: require('./SocietyPollVote'),
  SocietyEvent: require('./SocietyEvent'),
  SocietyEventUser: require('./SocietyEventUser'),
  SocietyGallery: require('./SocietyGallery'),
  SocietyDocument: require('./SocietyDocument'),
  SocietyDocumentType: require('./SocietyDocumentType'),
  SocietyEmergencyNumber: require('./SocietyEmergencyNumber'),
  SocietyLostAndFound: require('./SocietyLostAndFound'),

  // Complaints
  SocietyComplaint: require('./SocietyComplaint'),
  SocietyComplaintType: require('./SocietyComplaintType'),
  SocietyComplaintHistory: require('./SocietyComplaintHistory'),

  // Money
  SocietyBalanceSheet: require('./SocietyBalanceSheet'),
  SocietyBillCategory: require('./SocietyBillCategory'),
  SocietyBill: require('./SocietyBill'),
  SocietyUnitBill: require('./SocietyUnitBill'),
  SocietyUnitBillPayment: require('./SocietyUnitBillPayment'),
  SocietyMaintenance: require('./SocietyMaintenance'),
  SocietyPenalty: require('./SocietyPenalty'),

  // Amenities
  SocietyAmenityType: require('./SocietyAmenityType'),
  SocietyAmenity: require('./SocietyAmenity'),
  SocietyAmenitySlot: require('./SocietyAmenitySlot'),
  SocietyAmenityPackage: require('./SocietyAmenityPackage'),
  SocietyAmenityBooking: require('./SocietyAmenityBooking'),
  SocietyAmenityPricing: require('./SocietyAmenityPricing'),
  SocietyTermsAndConditions: require('./SocietyTermsAndConditions'),

  // Parking & vehicles
  SocietyParkingLevel: require('./SocietyParkingLevel'),
  SocietyParking: require('./SocietyParking'),
  SocietyParkingAllocation: require('./SocietyParkingAllocation'),
  SocietyVehicle: require('./SocietyVehicle'),

  // Visitors & security
  SocietyVisitor: require('./SocietyVisitor'),
  SocietyVisitorLog: require('./SocietyVisitorLog'),
  SocietyVisitorPass: require('./SocietyVisitorPass'),

  // Listings
  SocietyPropertyListing: require('./SocietyPropertyListing'),
};
