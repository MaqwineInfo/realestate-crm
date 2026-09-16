/**
 * The hand-written half of the OpenAPI document.
 *
 * Everything mechanical — which endpoints exist, what each returns, which token
 * opens it, what a record's fields are — is read from the code. What lives here
 * is what the code cannot say: what a group of endpoints is *for*, which of them
 * are load-bearing, and what a realistic record looks like.
 *
 * Three sections:
 *   TAGS       the navigation, grouped by who is calling
 *   RESOURCES  path prefix -> tag + the service whose crud config describes it
 *   examples   a field-name -> sample-value dictionary, so every generated
 *              example reads like one coherent society rather than "string"
 */

/* ─────────────────────────────── tags ─────────────────────────────── */

const TAGS = [
  {
    name: 'Auth · society admin',
    description: 'OTP sign-in for a chairman or committee member. Scoped by society '
      + 'code, because an admin phone number is unique only within a society. Issues a '
      + 'token on the **admin** secret.',
  },
  {
    name: 'Auth · resident',
    description: 'OTP sign-in for the resident app. Mobile number only — no society '
      + 'code, because one person may hold flats in several societies. Issues a token on '
      + 'the **user** secret, which the admin routes will not accept.\n\n'
      + '"Register" does not create anybody: a resident exists because an admin added '
      + 'them or their onboarding request was approved.',
  },
  {
    name: 'Super admin · societies',
    description: 'Platform-level society lifecycle: create a society, generate its '
      + 'structure, read its statistics, work the onboarding pipeline.',
  },
  {
    name: 'Super admin · people & configuration',
    description: 'Developers, roles, platform admins, pipeline stages and the identity '
      + 'directory.',
  },
  {
    name: 'Society admin · the society',
    description: 'Everything a chairman does to the building itself: blocks, floors, '
      + 'units, occupancy, staff, and the society record.',
  },
  {
    name: 'Society admin · members & committee',
    description: 'Residents, their families, and who holds which committee seat.',
  },
  {
    name: 'Society admin · complaints',
    description: 'The complaint desk. Every status change goes through one transition '
      + 'function, so the history is complete by construction rather than by discipline.',
  },
  {
    name: 'Society admin · communication',
    description: 'Notices, polls, events, galleries, documents, emergency numbers, '
      + 'lost & found. Publishing fans out to the residents a notice targets.',
  },
  {
    name: 'Society admin · amenities',
    description: 'Amenities, their slots, packages, pricing and bookings.',
  },
  {
    name: 'Society admin · billing',
    description: 'Bill categories, balance sheets, bills, maintenance runs, penalties '
      + 'and payments.\n\n**All money on the wire is a decimal string of rupees.** '
      + 'Storage is integer paise; the conversion happens once, at this boundary.',
  },
  {
    name: 'Society admin · parking',
    description: 'Levels, slots, allocations and vehicles. A slot has exactly one '
      + 'holder, enforced by a unique index rather than by a read-then-write.',
  },
  {
    name: 'Society admin · visitors & staff',
    description: 'The visitor log the office sees, and staff attendance.',
  },
  {
    name: 'Resident app · identity & society',
    description: 'Who the caller is, which societies they belong to, and how they '
      + 'claim a flat in a new one.',
  },
  {
    name: 'Resident app · home & billing',
    description: 'What this household owes, what they have paid, and their penalties.',
  },
  {
    name: 'Resident app · community',
    description: 'Notices, polls, events, documents, lost & found and notifications, '
      + 'filtered to what this resident is actually targeted by.',
  },
  {
    name: 'Resident app · amenities',
    description: 'Browsing amenities, checking availability and booking a slot.',
  },
  {
    name: 'Resident app · parking & visitors',
    description: 'Requesting a parking slot, registering a vehicle, pre-approving a '
      + 'visitor and answering the gate.',
  },
  {
    name: 'Resident app · property listings',
    description: 'A resident advertising their own flat to the society. Only an owner '
      + 'of that exact flat may list it, and a flat carries one live listing.',
  },
  {
    name: 'Gate device',
    description: 'The guard\'s own surface. Authenticated by a resident-audience token '
      + 'whose holder has a **live posting** to this society — ending the posting locks '
      + 'them out on the next request, not when the token expires.',
  },
  {
    name: 'Staff attendance',
    description: 'Clock-in and clock-out at the gate. Accepts either a society admin or '
      + 'a posted guard.',
  },
  {
    name: 'Legacy façade',
    description: 'The first-generation URLs, kept working. Each one is a thin mapping '
      + 'onto the same service the current surface uses — the same rows, never a second '
      + 'copy (SOCIETY-PLAN.md §2.2). Prefer the current paths for new work.',
  },
];

/* ──────────────────────────── resources ──────────────────────────── */

/**
 * `prefix` is matched longest-first against the endpoint path.
 * `service` names the module under `services/society/`, optionally with the
 * accessor holding the crud instance (`parking.levels`), from which the
 * generator reads the model, the list envelope key and the filterable fields.
 * `model` is the alternative for endpoints the crud factory never wrapped: it
 * names a model directly, and `listKey` says what its array is called.
 */
const RESOURCES = [
  // ── auth ──────────────────────────────────────────────────────────
  { prefix: '/api/v1/auth', tag: 'Auth · society admin' },
  { prefix: '/api/v1/app/users', tag: 'Auth · resident', service: 'users.identity' },

  // ── super admin ───────────────────────────────────────────────────
  { prefix: '/api/v1/super-admin/society-admins', tag: 'Super admin · people & configuration', service: 'admins' },
  { prefix: '/api/v1/super-admin/society', tag: 'Super admin · societies', service: 'societies' },
  { prefix: '/api/v1/super-admin/developers', tag: 'Super admin · people & configuration', service: 'developers' },
  { prefix: '/api/v1/super-admin/leads', tag: 'Super admin · societies', service: 'inquiries' },
  { prefix: '/api/v1/super-admin/roles', tag: 'Super admin · people & configuration', service: 'roles' },
  { prefix: '/api/v1/super-admin/stages', tag: 'Super admin · people & configuration', service: 'stages.stages' },
  { prefix: '/api/v1/super-admin/users', tag: 'Super admin · people & configuration', service: 'users.identity' },

  // ── society admin ─────────────────────────────────────────────────
  { prefix: '/api/v1/society-admin/society-admins', tag: 'Society admin · the society', service: 'admins' },
  { prefix: '/api/v1/society-admin/society-documents', tag: 'Society admin · communication', service: 'community.documents' },
  // The `/society-admin/society/*` prefix carries the whole building, not just
  // the society record, so its sub-resources are named individually — otherwise
  // every one of the 38 endpoints under it would be documented as a "society".
  { prefix: '/api/v1/society-admin/society/blocks-with-floors', tag: 'Society admin · the society', service: 'blocks' },
  { prefix: '/api/v1/society-admin/society/blocks', tag: 'Society admin · the society', service: 'blocks' },
  { prefix: '/api/v1/society-admin/society/floors', tag: 'Society admin · the society', service: 'floors' },
  { prefix: '/api/v1/society-admin/society/units', tag: 'Society admin · the society', service: 'units' },
  { prefix: '/api/v1/society-admin/society/employee-types', tag: 'Society admin · the society', service: 'employees.types' },
  { prefix: '/api/v1/society-admin/society/employees', tag: 'Society admin · the society', service: 'employees.types' },
  { prefix: '/api/v1/society-admin/society/attendance', tag: 'Staff attendance' },
  { prefix: '/api/v1/society-admin/society/resident-onboarding-requests', tag: 'Society admin · members & committee' },
  { prefix: '/api/v1/society-admin/society/tenants', tag: 'Society admin · members & committee', service: 'members' },
  { prefix: '/api/v1/society-admin/society', tag: 'Society admin · the society', service: 'societies' },
  { prefix: '/api/v1/society-admin/committee-members', tag: 'Society admin · members & committee', service: 'committee' },
  { prefix: '/api/v1/society-admin/users/service-users', tag: 'Society admin · members & committee', service: 'users.identity' },
  { prefix: '/api/v1/society-admin/users/internal-users', tag: 'Society admin · members & committee', service: 'users.identity' },
  { prefix: '/api/v1/society-admin/users', tag: 'Society admin · members & committee', service: 'members' },
  { prefix: '/api/v1/society-admin/complaints', tag: 'Society admin · complaints', service: 'complaints' },
  { prefix: '/api/v1/society-admin/notices', tag: 'Society admin · communication', service: 'notices' },
  { prefix: '/api/v1/society-admin/polls', tag: 'Society admin · communication', service: 'polls' },
  { prefix: '/api/v1/society-admin/events', tag: 'Society admin · communication', service: 'community.events' },
  { prefix: '/api/v1/society-admin/feedbacks', tag: 'Society admin · communication' },
  { prefix: '/api/v1/society-admin/building-galleries', tag: 'Society admin · communication', service: 'community.galleries' },
  { prefix: '/api/v1/society-admin/emergency-numbers', tag: 'Society admin · communication', service: 'community.emergencyNumbers' },
  { prefix: '/api/v1/society-admin/lost-found', tag: 'Society admin · communication', service: 'community.lostAndFound' },
  { prefix: '/api/v1/society-admin/amenities/type', tag: 'Society admin · amenities', service: 'amenities.types' },
  { prefix: '/api/v1/society-admin/amenities/bookings', tag: 'Society admin · amenities', service: 'amenities.bookings' },
  { prefix: '/api/v1/society-admin/amenities', tag: 'Society admin · amenities', service: 'amenities' },
  { prefix: '/api/v1/society-admin/balance-sheet', tag: 'Society admin · billing', service: 'billing.balanceSheets' },
  { prefix: '/api/v1/society-admin/bill', tag: 'Society admin · billing', service: 'billing.bills' },
  { prefix: '/api/v1/society-admin/maintenance', tag: 'Society admin · billing', service: 'billing.maintenances' },
  { prefix: '/api/v1/society-admin/penalties', tag: 'Society admin · billing', service: 'penalties' },
  { prefix: '/api/v1/society-admin/parking/levels', tag: 'Society admin · parking', service: 'parking.levels' },
  { prefix: '/api/v1/society-admin/parking', tag: 'Society admin · parking', service: 'parking.slots' },
  { prefix: '/api/v1/society-admin/visitors', tag: 'Society admin · visitors & staff', service: 'visitors.logs' },
  { prefix: '/api/v1/society-admin/property-listing', tag: 'Resident app · property listings', service: 'propertyListings' },

  // ── gate & attendance ─────────────────────────────────────────────
  { prefix: '/api/v1/gatekeeper/lost-found', tag: 'Gate device', service: 'community.lostAndFound' },
  { prefix: '/api/v1/gatekeeper', tag: 'Gate device', service: 'visitors.logs' },
  { prefix: '/api/v1/attendance', tag: 'Staff attendance' },

  // ── resident app ──────────────────────────────────────────────────
  { prefix: '/api/v1/app/society', tag: 'Resident app · identity & society', service: 'societies' },
  { prefix: '/api/v1/app/members', tag: 'Resident app · identity & society', service: 'members' },
  // A resident sees their own per-unit charges, not the society-wide bill the
  // chairman raised — a different collection, and one the crud factory never
  // wraps, so the model is named directly.
  { prefix: '/api/v1/app/bills', tag: 'Resident app · home & billing', model: 'SocietyUnitBill', listKey: 'bills' },
  { prefix: '/api/v1/society-admin/bill/unit-bills', tag: 'Society admin · billing', model: 'SocietyUnitBill', listKey: 'unitBills' },
  { prefix: '/api/v1/app/penalty', tag: 'Resident app · home & billing', service: 'penalties' },
  { prefix: '/api/v1/app/complaints', tag: 'Resident app · community', service: 'complaints' },
  { prefix: '/api/v1/app/notices', tag: 'Resident app · community', service: 'notices' },
  { prefix: '/api/v1/app/polls', tag: 'Resident app · community', service: 'polls' },
  { prefix: '/api/v1/app/events', tag: 'Resident app · community', service: 'community.events' },
  { prefix: '/api/v1/app/document', tag: 'Resident app · community', service: 'community.documents' },
  { prefix: '/api/v1/app/building-gallery', tag: 'Resident app · community', service: 'community.galleries' },
  { prefix: '/api/v1/app/emergency', tag: 'Resident app · community', service: 'community.emergencyNumbers' },
  { prefix: '/api/v1/app/lost-found', tag: 'Resident app · community', service: 'community.lostAndFound' },
  { prefix: '/api/v1/app/notifications', tag: 'Resident app · community' },
  { prefix: '/api/v1/app/amenity/types', tag: 'Resident app · amenities', service: 'amenities.types' },
  { prefix: '/api/v1/app/amenity/bookings', tag: 'Resident app · amenities', service: 'amenities.bookings' },
  { prefix: '/api/v1/app/amenity/list-bookings', tag: 'Resident app · amenities', service: 'amenities.bookings' },
  { prefix: '/api/v1/app/amenity/create-booking', tag: 'Resident app · amenities', service: 'amenities.bookings' },
  { prefix: '/api/v1/app/amenity', tag: 'Resident app · amenities', service: 'amenities' },
  { prefix: '/api/v1/app/parkings', tag: 'Resident app · parking & visitors', service: 'parking.slots' },
  { prefix: '/api/v1/app/vehicles', tag: 'Resident app · parking & visitors', service: 'parking.vehicles' },
  { prefix: '/api/v1/app/visitors', tag: 'Resident app · parking & visitors', service: 'visitors.logs' },
  { prefix: '/api/v1/app/property-listing', tag: 'Resident app · property listings', service: 'propertyListings' },

  // ── legacy façade ─────────────────────────────────────────────────
  { prefix: '/api/v1/society-users/employees', tag: 'Legacy façade', service: 'employees.types' },
  { prefix: '/api/v1/society-users/committee', tag: 'Legacy façade', service: 'committee' },
  { prefix: '/api/v1/society-users', tag: 'Legacy façade', service: 'members' },
  { prefix: '/api/v1/society-galleries', tag: 'Legacy façade', service: 'community.galleries' },
  { prefix: '/api/v1/society', tag: 'Legacy façade', service: 'societies' },
  { prefix: '/api/v1/blocks', tag: 'Legacy façade', service: 'blocks' },
  { prefix: '/api/v1/floors', tag: 'Legacy façade', service: 'floors' },
  { prefix: '/api/v1/units', tag: 'Legacy façade', service: 'units' },
  { prefix: '/api/v1/amenity/pricing', tag: 'Legacy façade', service: 'amenityPricing' },
  { prefix: '/api/v1/amenity/terms', tag: 'Legacy façade', service: 'amenityPricing.terms' },
  { prefix: '/api/v1/amenity/bookings', tag: 'Legacy façade', service: 'amenities.bookings' },
  { prefix: '/api/v1/amenity', tag: 'Legacy façade', service: 'amenities' },
  { prefix: '/api/v1/complaints', tag: 'Legacy façade', service: 'complaints' },
  { prefix: '/api/v1/notices', tag: 'Legacy façade', service: 'notices' },
  { prefix: '/api/v1/maintenances', tag: 'Legacy façade', service: 'billing.maintenances' },
  { prefix: '/api/v1/penalties', tag: 'Legacy façade', service: 'penalties' },
  { prefix: '/api/v1/parking/levels', tag: 'Legacy façade', service: 'parking.levels' },
  { prefix: '/api/v1/parking/vehicles', tag: 'Legacy façade', service: 'parking.vehicles' },
  { prefix: '/api/v1/parking', tag: 'Legacy façade', service: 'parking.slots' },
  { prefix: '/api/v1/visitor', tag: 'Legacy façade', service: 'visitors.logs' },
];

/* ─────────────────────────── example values ─────────────────────────── */

/**
 * One coherent society, so a reader can follow a record from one endpoint to
 * the next instead of meeting "string" forty times. Matched on the field name,
 * longest key first, then falling back to the field's type.
 */
const VALUES = {
  societyName: 'Riverfront Residency',
  societyCode: 'SOC-2026-001',
  societyAddress: '12 Riverside Marg, Ahmedabad',
  blockName: 'Block A',
  blockNumber: 'A',
  blockLetter: 'A',
  floorNumber: 3,
  unitNumber: 'A-301',
  mobileNumber: '9876543210',
  alternateNumber: '9876543211',
  phoneNumber: '9876543210',
  contactNumber: '9876543210',
  countryCode: '+91',
  firstName: 'Nisha',
  lastName: 'Patel',
  fullName: 'Nisha Patel',
  employeeName: 'Ramesh Solanki',
  contactPersonName: 'Hemant Shah',
  email: 'nisha@example.com',
  otp: '123456',
  city: 'Ahmedabad',
  state: 'Gujarat',
  pincode: '380001',
  street: '12 Riverside Marg',
  street1: '12 Riverside Marg',
  description: 'Water supply will be off from 10am to 2pm on Saturday.',
  text: 'Water supply will be off from 10am to 2pm on Saturday.',
  title: 'Water tank cleaning',
  comment: 'Plumber booked for Thursday morning.',
  notes: 'Resident called to confirm.',
  reason: 'Slot needed for a visitor vehicle.',
  purposeOfVisit: 'Parcel delivery',
  relation: 'Son',
  amenityName: 'Community Hall',
  slotNumber: 12,
  levelName: 'Basement 1',
  vehicleNumber: 'GJ01AB1234',
  passNumber: 'VP-000148',
  complaintId: 'CM-SOC-2026-001-004',
  billNumber: 'BILL-2026-0007',
  receiptNumber: 'RCPT-2026-0031',
  invoiceNumber: 'INV-2026-0031',
  noticeNumber: 'NOT-2026-0009',
  ifscCode: 'HDFC0001234',
  accountNumber: '50100123456789',
  gstNumber: '24AABCU9603R1ZM',
  panNumber: 'AABCU9603R',
  upiId: 'riverfront@hdfcbank',
  fcmToken: 'fZ1kQ8m0T-6…device-token',
  bloodGroup: 'B+',
  gender: 'Female',
  age: 34,
  capacity: 80,
  page: 1,
  perPage: 10,
  limit: 10,
  search: 'Nisha',

  // A live record, not a deleted one — the two soft-delete columns must agree
  // with `isDeleted: false` or the sample contradicts itself.
  deletedAt: null,
  deletedBy: null,
  isDeleted: false,

  // Targeting takes either the literal 'All' or a list of ids, which is why
  // the column is untyped.
  targetBlocks: ['All'],
  targetFloors: ['All'],
  targetUnits: ['All'],

  // Where the first enum member is not the interesting one.
  publishStatus: 'PUBLISHED',
  priority: 'Medium',
  approvalStatus: 'PENDING',
};

/** A sample for one field, by name then by type. */
function valueFor(fieldPath, path) {
  const leaf = fieldPath.split('.').pop();
  if (leaf in VALUES) return VALUES[leaf];
  if (path?.enumValues?.length) return path.enumValues.find((v) => v !== null);
  if (path?.instance === 'Date') return '2026-09-08T09:30:00.000Z';
  if (path?.instance === 'Boolean') return false;
  if (path?.instance === 'Number') return 0;
  return undefined;
}

/* ───────────────── hand-written summaries ───────────────── */

/**
 * Overrides for the endpoints whose name cannot be derived, and for the ones
 * where the derived name is true but says nothing about why they matter.
 * Keyed `METHOD /path` exactly as Express declares it.
 */
const OVERRIDES = {
  // ── auth ──
  'POST /api/v1/auth/send-otp': 'Send a sign-in code to a society admin',
  'POST /api/v1/auth/resend-otp': 'Resend the sign-in code',
  'POST /api/v1/auth/verify-otp': 'Exchange the code for an admin token',
  'POST /api/v1/auth/logout': 'Revoke the token',
  'POST /api/v1/app/users/register': 'Send a sign-in code to a resident',
  'POST /api/v1/app/users/resend-otp': 'Resend the resident sign-in code',
  'POST /api/v1/app/users/verify-otp': 'Exchange the code for a resident token',
  'POST /api/v1/app/users/logout': 'Revoke the resident token',
  'GET /api/v1/app/users/profile': 'The signed-in resident',
  'PUT /api/v1/app/users/profile': 'Edit the signed-in resident',

  // ── the resident app's view of societies ──
  'GET /api/v1/app/society': 'Browse societies to join',
  'GET /api/v1/app/society/:id/details': 'Every flat in a building, grouped block by floor',
  'GET /api/v1/app/society/user/society-details': 'The building the caller lives in',
  'GET /api/v1/app/society/my-societies': 'Societies the caller holds a flat in',
  'POST /api/v1/app/society/register-resident': 'Claim a flat — raises a request, grants nothing',
  'POST /api/v1/app/society/society-request': 'Enquire about onboarding a new society',

  // ── the gate ──
  'POST /api/v1/gatekeeper/entry': 'Record an arrival at the gate',
  'PUT /api/v1/gatekeeper/allow-entry': 'Admit a visitor the resident approved',
  'PUT /api/v1/gatekeeper/exit': 'Sign a visitor out',
  'GET /api/v1/gatekeeper/expected': 'Arrivals expected today',
  'GET /api/v1/gatekeeper/stats': 'Who is inside right now',
  'DELETE /api/v1/gatekeeper/entry': 'Withdraw an arrival recorded in error',
  'GET /api/v1/gatekeeper/list': 'The gate log',
  'GET /api/v1/app/notifications/getMyNotifications': "This resident's notifications",
  'GET /api/v1/attendance/employees': 'Staff who can clock in at this gate',
  'GET /api/v1/society-admin/society/resident-onboarding-requests': 'Flat claims awaiting a decision',
  'GET /api/v1/gatekeeper/members': 'Look a resident up before calling them',
  'PUT /api/v1/app/visitors/process-entry': 'Approve or refuse a visitor for your own flat',
  'POST /api/v1/app/visitors/create': 'Pre-approve a visitor for your own flat',

  // ── attendance ──
  'POST /api/v1/attendance/clock-in': 'Start a shift',
  'PUT /api/v1/attendance/clock-out': 'End a shift',
  'GET /api/v1/attendance/status': 'Whether the caller is on site',
  'GET /api/v1/attendance/monthly-report': 'Days present and hours worked, by employee',

  // ── things whose name is not derivable ──
  'PATCH /api/v1/app/notifications/markAsRead/:id': 'Mark one notification read',
  'PUT /api/v1/society-admin/society/resident-onboarding-requests/:requestId':
    'Approve or reject a flat claim',
  'POST /api/v1/society-admin/parking/spot/:id/process': 'Approve or reject a parking request',
  'POST /api/v1/app/polls/vote/:id': 'Cast a vote — one per resident, enforced by the database',
  'POST /api/v1/app/amenity/create-booking': 'Book a slot — refused if it is already taken',
  'POST /api/v1/society-admin/bill/:id/publish': 'Publish a bill, raising one per unit',
  'POST /api/v1/society-admin/maintenance/:id/run': 'Run a maintenance charge for this period',
};

module.exports = { TAGS, RESOURCES, OVERRIDES, examples: { valueFor, VALUES } };
