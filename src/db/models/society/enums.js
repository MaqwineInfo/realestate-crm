/**
 * Society enums — the union of the three source `config/data.js` files.
 *
 * Where all three agree, there is one entry. Where they disagree on a key that
 * names the same field, the canonical (admin + user) value wins and the legacy
 * variant is kept under a `LEGACY_` name, because the compatibility façade
 * (SOCIETY-PLAN.md §2.2) still has to accept and emit it.
 *
 * Silently merging the two would have produced enums like
 * `['ACTIVE','INACTIVE','Draft','Published','Expired','Archived']` on notice
 * status — a field that accepts six values of which any two mean the same
 * thing is not a constraint, it is decoration.
 */
const enums = {
  // ---- common -------------------------------------------------------------
  commonStatus: ['ACTIVE', 'INACTIVE', 'DELETED'],
  bloodGroupTypes: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  paidStatus: ['PAID', 'UNPAID'],
  createdByRole: ['ADMIN', 'MEMBER'],

  // ---- society & structure ------------------------------------------------
  projectType: ['Residential', 'Commercial', 'Mixed Use'],
  unitStatus: ['AVAILABLE', 'UNAVAILABLE'],
  occupancyStatus: ['VACANT', 'OCCUPIED'],
  residentTypeUnit: ['Owner', 'Vacant', 'Tenant'],
  residentTypeOccupancy: ['Owner', 'Tenant'],
  memberRole: ['PRIMARY', 'FAMILY'],
  relation: ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Brother', 'Sister', 'Other'],
  agreementStatus: ['ACTIVE', 'EXPIRING_SOON', 'EXPIRED'],
  unitNamingPattern: ['101,102', '1,2,3,4', 'Block+Floor+1,2,3', 'Other'],
  unitTypes: ['1BHK', '2BHK', '3BHK', '4BHK', '5BHK', 'Shop', 'Office', 'Penthouse', 'Duplex', 'Studio', 'Other'],
  memberStatus: ['ACTIVE', 'INACTIVE', 'PENDING'],
  gender: ['Male', 'Female', 'Other'],
  roleScope: ['global', 'society'],

  // ---- enquiry ------------------------------------------------------------
  inquiryStatus: ['Pending', 'Approve', 'Reject'],

  // ---- notices ------------------------------------------------------------
  // Canonical: admin + user drive publication off `publishStatus`.
  publishStatus: ['DRAFT', 'SCHEDULED', 'PUBLISHED'],
  residentType: ['ALL', 'OWNER', 'TENANT'],
  noticeContentType: ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'],
  noticeCategory: [
    'Maintenance', 'Events', 'Security', 'Financial', 'Administrative',
    'Health', 'Amenities', 'Emergency', 'Guidelines', 'General',
  ],
  // Legacy façade only — a separate `status` field on the same document.
  LEGACY_noticeStatus: ['Draft', 'Published', 'Expired', 'Archived'],
  LEGACY_noticePriority: ['Low', 'Medium', 'High', 'Urgent'],
  LEGACY_noticeTarget: ['All', 'Members', 'Committee', 'Staff', 'Specific Units', 'Specific Blocks'],
  LEGACY_noticeCategory: [
    'General', 'Maintenance', 'Meeting', 'Event', 'Payment', 'Rule',
    'Announcement', 'Emergency', 'Water Cut', 'Electricity Cut', 'Other',
  ],

  // ---- complaints ---------------------------------------------------------
  complaintStatus: ['Open', 'In Progress', 'On Hold', 'Reopen', 'Close', 'Dismiss'],
  complaintPriority: ['Low', 'Medium', 'High', 'Urgent'],
  complaintContentType: ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'],
  LEGACY_complaintCategory: [
    'PLUMBING', 'ELECTRICAL', 'CLEANING', 'SECURITY', 'MAINTENANCE',
    'PARKING', 'LIFT', 'GARDENING', 'AMENITY', 'OTHER',
  ],
  LEGACY_complaintTaskStatus: ['PENDING', 'ASSIGNED', 'RESOLVED', 'CLOSED', 'REJECTED'],

  // ---- maintenance & billing ---------------------------------------------
  maintenanceType: ['FIXED', 'MONTH_WISE'],
  maintenanceAmountType: ['FIXED'],
  maintenanceLateFeeType: ['FIXED'],
  billSelectionType: ['ALL', 'BLOCK', 'UNIT'],
  unitBillStatus: ['PAID', 'UNPAID'],
  paymentMethod: ['Cash', 'Cheque', 'Bank Transfer', 'UPI', 'Card', 'Online', 'Other'],
  LEGACY_maintenanceStatus: ['Draft', 'Published', 'Paid', 'Overdue', 'Cancelled', 'Partially Paid'],
  LEGACY_maintenanceTypes: ['Monthly', 'Special', 'Emergency', 'Annual', 'Quarterly', 'One Time'],
  LEGACY_paymentStatus: ['Pending', 'Paid', 'Partial', 'Overdue', 'Waived'],
  LEGACY_lateFeeConfig: ['Fixed', 'Percentage', 'Daily'],

  // ---- balance sheet ------------------------------------------------------
  balanceSheetType: ['COMMON', 'BLOCK'],
  balanceSheetAccountType: ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY'],

  // ---- parking ------------------------------------------------------------
  PARKING_LEVEL_TYPE: ['Basement', 'Ground', 'Upper'],
  PARKING_NAMING_TYPE: ['WITH_NAME', 'WITHOUT_NAME'],
  PARKING_SLOT_TYPE: ['CAR', 'BIKE', 'BICYCLE', 'HANDICAPPED', 'EV_CHARGING'],
  PARKING_OWNERSHIP_TYPE: ['MEMBER', 'VISITOR', 'RESERVED', 'COMMERCIAL'],
  PARKING_STATUS: ['AVAILABLE', 'ALLOCATED', 'PENDING_REQUEST', 'UNDER_MAINTENANCE', 'BLOCKED'],
  PARKING_ASSIGNMENT_TYPE: ['PERMANENT', 'TEMPORARY'],
  PARKING_ALLOCATION_ACTION: [
    'REQUESTED', 'REQUEST_APPROVED', 'REQUEST_REJECTED', 'ALLOCATED',
    'DEALLOCATED', 'TRANSFERRED', 'STATUS_CHANGED',
  ],
  VEHICLE_TYPE: ['Car', 'Bike'],
  VEHICLE_CATEGORY: ['MEMBER', 'VISITOR', 'STAFF', 'DELIVERY'],

  // ---- visitors -----------------------------------------------------------
  visitorTypes: ['GUEST', 'DELIVERY_COURIER', 'CAB_AUTO', 'COMMON_ENTRY', 'VENDOR'],
  visitorStatus: [
    'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'ENTERED', 'EXITED',
    'ACTIVE', 'EXPIRED', 'CANCELLED', 'NOT_ARRIVED',
  ],
  visitorApprovalStatus: ['PENDING', 'APPROVED', 'REJECTED'],
  visitFrequency: ['ONCE', 'FREQUENT'],
  validTillOptions: ['1_HOUR', '2_HOURS', '4_HOURS', '8_HOURS', '12_HOURS', '24_HOURS'],

  // ---- amenities ----------------------------------------------------------
  AMENITY_STATUS: ['Available', 'Booked', 'Inactive', 'Under Maintenance'],
  BOOKING_STATUS: [
    'Pending Approval', 'Approved', 'Rejected', 'Confirmed',
    'Active', 'Completed', 'Cancelled',
  ],
  BOOKING_ACTION: ['Approve', 'Reject', 'Modify'],
  TIME_SLOT: ['Morning', 'Afternoon', 'Evening', 'Weekend', 'Holiday'],
  LEGACY_AMENITY_TYPE: [
    'Hall', 'Gym', 'Swimming Pool', 'Clubhouse', 'Sports Court',
    'Party Hall', 'Garden', 'Library', 'Other',
  ],

  // ---- lost & found -------------------------------------------------------
  lostAndFoundTypes: ['LOST', 'FOUND'],
  lostAndFoundCategories: ['KEYS', 'WALLET', 'ELECTRONICS', 'DOCUMENTS', 'JEWELRY', 'CLOTHING', 'OTHER'],
  lostAndFoundStatus: ['ACTIVE', 'CLAIMED', 'EXPIRED'],

  // ---- polls --------------------------------------------------------------
  pollType: ['SINGLE_CHOICE', 'MULTIPLE_CHOICE'],
  pollStatus: ['DRAFT', 'PUBLISHED', 'CLOSED'],

  // ---- property listings --------------------------------------------------
  propertyListingType: ['RENT', 'SELL'],
  propertyListingStatus: ['ACTIVE', 'SOLD', 'RENTED', 'INACTIVE'],
  furnishingStatus: ['FULLY_FURNISHED', 'SEMI_FURNISHED', 'UNFURNISHED'],

  // ---- gallery ------------------------------------------------------------
  galleryType: ['Event', 'Block'],
};

module.exports = enums;
