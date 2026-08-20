# Real Estate CRM V2.0 — Channel Partner + HRMS + Post-Booking, KYC & Collections
## Master Connected Functional & Development Specification

**Document Type:** Implementation-Grade Product / Functional Specification  
**Version:** 2.0  
**Status:** Source of Truth for New Modules  
**Depends On:** Existing CRM V1 + V1.1 implementation is assumed complete and working  
**Architecture Style:** Extend existing CRM; do not rebuild stable Lead / Project / Inventory / Quotation / Block / Booking flows  
**Product Principle:** Minimum clicks. Maximum operational clarity. Every module must connect to the same customer, project, booking, employee and commercial history.

---

# 0. Purpose of This Document

The existing CRM is assumed functional through:

```text
Lead Capture
→ Follow-up
→ Site Visit
→ Shortlist
→ Quotation
→ Unit Block
→ Booking
```

This document extends the product in three major directions:

```text
A. CHANNEL PARTNER
Registration → Team → Lead Submission → Visit → Booking
→ Commission → Invoice → Payout Tracking

B. HRMS
Employee → Organization Structure → Shift → Attendance
→ Leave → Holiday / Week Off → HR Reports

C. POST-BOOKING
Booking → Customer Booking Form → Customer KYC
→ Payment Schedule → Payment Link → Collections Follow-up
→ Receipt Tracking → Collection Reports
```

These are **connected extensions**, not isolated applications.

---

# 1. Important Scope Change from Previous CRM Versions

Previous versions deliberately stopped at sales booking.

V2.0 intentionally extends the product beyond that boundary for:

- Channel Partner operations;
- lightweight HRMS;
- post-booking customer data and KYC;
- payment schedule tracking;
- collection follow-ups;
- payment-link / receipt tracking;
- Channel Partner invoice and payout tracking.

The following are **still out of scope** unless separately approved:

- general ledger;
- full accounting;
- bank reconciliation;
- GST return filing;
- payroll calculation;
- salary processing;
- PF/ESI statutory filing;
- construction ERP;
- procurement;
- vendor accounting;
- legal agreement drafting / execution;
- possession workflow;
- maintenance billing.

This V2.0 is an **operations system**, not a complete finance or payroll ERP.

---

# 2. Existing Rules That Must Not Break

All existing CRM invariants remain authoritative.

## 2.1 Lead Sales Flow

```text
Lead
→ Follow-up
→ Visit
→ Quotation
→ Block
→ Booking
```

Do not bypass existing Lead, Unit, Quotation, Block or Booking services.

## 2.2 Booking Remains a Dedicated Transaction

`Booked` must not become a normal Stage dropdown change.

Booking still:

- validates Lead;
- validates Unit;
- validates Quotation;
- validates Payment Plan;
- validates discount approval;
- claims Unit;
- creates Booking;
- converts Block where present;
- changes Lead to Booked/Terminal;
- closes pending sales follow-ups;
- freezes attribution.

**V2 begins after successful Booking.**

## 2.3 Tenant Isolation

Every new entity in this document must include:

```text
tenantId
```

No Channel Partner, HR, KYC, Booking or Collection query may cross tenants.

## 2.4 Existing Contact Identity

Customer Contact continues to use normalized mobile as primary identity key.

Post-booking must reference the existing Contact rather than creating duplicate customers.

## 2.5 Existing Project / Unit

Post-booking uses the already-booked:

```text
projectId
unitId
```

Do not recreate independent project/unit masters.

---

# 3. Updated Product Navigation

Recommended primary app navigation:

```text
Dashboard
Leads
Bookings
Channel Partners
Projects
Inventory
Contacts
Campaigns
HRMS
Reports
Setup
```

`Collections` is accessible:

- inside Bookings;
- from the Collections Dashboard;
- from the Dashboard view switch;
- through dedicated route.

Recommended dedicated route:

```text
/app/collections
```

---

# 4. Role-Based Dashboard Navigation

A user may have more than one responsibility.

Dashboard may support view switch based on permission:

```text
Sales
Collections
HRMS
Management
```

Example:

```text
/app/dashboard
/app/dashboard?view=collections
/app/dashboard?view=hrms
/app/dashboard/management
```

Do not show a view the user cannot access.

An employee may be:

```text
Sales User + Collection User
```

without creating two system accounts.

---

# 5. Major New Domain Map

```text
TENANT
│
├── CRM
│   ├── Contact
│   ├── Lead
│   ├── Project
│   ├── Unit
│   ├── Quotation
│   └── Booking
│
├── CHANNEL PARTNER
│   ├── Partner Registration
│   ├── Partner Entity
│   ├── Partner Team
│   ├── Partner Project Empanelment
│   ├── Partner Lead Claim
│   ├── Partner Commission
│   ├── Partner Invoice
│   └── Partner Payout
│
├── HRMS
│   ├── Employee
│   ├── Department
│   ├── Designation
│   ├── Job
│   ├── Branch
│   ├── Seating Office
│   ├── Shift
│   ├── Attendance
│   ├── Face Approval
│   ├── Leave
│   ├── Holiday
│   └── Week Off
│
└── POST BOOKING
    ├── Booking Workspace
    ├── Customer Booking Form
    ├── KYC
    ├── Payment Schedule
    ├── Payment Link
    ├── Receipt
    ├── Collection Assignment
    ├── Collection Follow-up
    └── Collection Reporting
```

---

# PART A — CHANNEL PARTNER MODULE

# 6. Channel Partner Product Goal

The Channel Partner module should answer:

```text
Who is this partner?
Is their registration/RERA valid?
Which company/team do they belong to?
Which projects are they approved to sell?
Which leads did they submit?
Which visits and bookings came from them?
How much business did they generate?
How much commission is eligible?
Which invoices are pending?
What has been paid?
```

Do not duplicate CRM Lead/Booking records.

Channel Partner attribution must connect directly to the existing sales records.

---

# 7. Channel Partner Types

Support:

```text
COMPANY
INDIVIDUAL
```

## 7.1 Company Channel Partner

A legal/business entity with one or more team members.

Examples of users:

- Owner
- Company Admin
- Sales Member

## 7.2 Individual Channel Partner

A single independent partner.

May still receive a portal login.

---

# 8. Channel Partner Main Screens

Internal CRM screens:

```text
/app/channel-partners
/app/channel-partners/dashboard
/app/channel-partners/registrations
/app/channel-partners/registrations/:id
/app/channel-partners/:id
/app/channel-partners/:id/team
/app/channel-partners/:id/projects
/app/channel-partners/:id/leads
/app/channel-partners/:id/bookings
/app/channel-partners/:id/commissions
/app/channel-partners/invoices
/app/channel-partners/invoices/:id
```

External Partner Portal:

```text
/cp/login
/cp/dashboard
/cp/leads
/cp/leads/new
/cp/visits
/cp/bookings
/cp/team
/cp/invoices
/cp/profile
/cp/rera
```

---

# 9. Channel Partner Internal Dashboard

Route:

```text
/app/channel-partners/dashboard
```

Primary tiles:

```text
Total Registered Partners
Active Company Partners
Active Individual Partners
Pending Registrations
RERA Expiring Soon
Leads Submitted
Site Visits Completed
Bookings
Booking Value
Commission Eligible
Invoices Pending Approval
Payout Pending
```

Date filters:

```text
Today
This Month
This Quarter
Custom
```

Project filter.

Partner Type filter.

---

# 10. Channel Partner Top Performer Section

Do not use one mysterious combined score by default.

Allow ranking by:

```text
Bookings
Booking Value
Leads Submitted
Site Visits
Lead → Visit Conversion
Visit → Booking Conversion
Lead → Booking Conversion
```

Default ranking:

```text
Bookings DESC
then Booking Value DESC
```

Table:

| Rank | Partner | Type | Leads | Visits | Bookings | Booking Value | Lead→Booking |
|---|---|---|---:|---:|---:|---:|---:|

Click Partner opens full Partner Workspace.

---

# 11. Channel Partner Funnel

Management should see:

```text
Partner Leads
→ Connected
→ Site Visits
→ Blocks
→ Bookings
→ Booking Value
```

Allow drilldown to exact Lead/Booking records.

---

# 12. Channel Partner Registration List

Route:

```text
/app/channel-partners/registrations
```

Columns:

- Registration ID
- Partner / Company Name
- Type
- Primary Contact
- Mobile
- City
- GujRERA Number
- RERA Expiry
- RERA Status
- Submitted Date
- Registration Status
- Project Empanelments
- Reviewer
- Action

Filters:

- Company / Individual
- Registration Status
- RERA Status
- City
- Project
- Date
- Expiring in 30 / 60 / 90 days

---

# 13. Channel Partner Registration Status

```text
DRAFT
SUBMITTED
UNDER_REVIEW
CORRECTION_REQUIRED
APPROVED
REJECTED
SUSPENDED
EXPIRED
```

`APPROVED` registration creates/activates the actual Channel Partner entity.

---

# 14. Channel Partner Registration Entry Points

Support:

## Internal

```text
Admin → Add Channel Partner
```

## Invite Link

Internal user creates registration link and sends to partner.

## Optional Public Self Registration

Tenant setting:

```text
cpPublicRegistrationEnabled
```

If enabled:

```text
/cp/register
```

All self-registrations still require internal approval.

---

# 15. Channel Partner Registration Stepper

Use:

```text
1. Partner Type & Contact
2. Business Details
3. GujRERA & Compliance
4. Bank & Invoice Details
5. Team
6. Project Empanelment
7. Review & Submit
```

For Individual Partner:

Skip Company Team step unless additional staff are allowed.

---

# 16. CP Registration Step 1 — Partner Type & Contact

Fields:

| Field | Required |
|---|---:|
| Partner Type | Yes |
| Primary Contact Name | Yes |
| Mobile | Yes |
| Email | Yes |
| City | Yes |
| State | Yes |
| Address | No |
| Pincode | No |

Normalize mobile.

Email format validation.

---

# 17. CP Registration Step 2 — Business Details

## COMPANY

Fields:

- Legal Company Name
- Trade / Display Name
- Constitution Type
- PAN
- GSTIN
- Company Registration Number optional
- Registered Address
- Correspondence Address
- Website
- Years in Business optional
- Authorized Signatory Name
- Authorized Signatory Mobile
- Authorized Signatory Email

## INDIVIDUAL

Fields:

- Full Name
- PAN
- GSTIN if available
- Business / Trade Name optional
- Address
- City
- State
- Pincode

Do not make GSTIN mandatory unless tenant policy requires.

---

# 18. CP Registration Step 3 — GujRERA

This module records Partner RERA registration evidence.

Fields:

```text
RERA Authority               default/configured "GujRERA"
RERA Registration Number
Certificate Issue Date
Certificate Expiry Date
Certificate Upload
RERA Name
RERA Type
Verification Status
Verification Note
Verified By
Verified At
```

Verification Status:

```text
PENDING
VERIFIED
REJECTED
EXPIRED
```

Certificate file:

- PDF preferred;
- image allowed if configured;
- server validates MIME;
- internal/private storage.

---

# 19. RERA Validity Rules

Tenant settings:

```text
cpRequireRera
cpRequireVerifiedReraForActivation
cpRequireValidReraForLeadSubmission
cpReraExpiryReminderDays
```

Recommended reminder bands:

```text
90 days
60 days
30 days
7 days
Expired
```

Do not silently delete an expired partner.

Change operating status according to tenant policy.

---

# 20. RERA Expiry Banner

Partner Workspace:

```text
RERA expires in 21 days.
Upload renewed certificate.
```

Expired:

```text
RERA certificate expired on 10 Aug 2026.
Lead submission is disabled by organization policy.
```

---

# 21. CP Registration Step 4 — Bank & Invoice Details

Fields:

- Account Holder Name
- Bank Name
- Account Number
- IFSC
- Branch
- Cancelled Cheque Upload
- PAN
- GSTIN
- Billing Address
- Default Invoice Tax Mode
- Optional MSME / other reference fields if tenant needs later

Account number should be masked in normal display.

Only authorized roles see full bank details.

---

# 22. CP Company Team Management

Route:

```text
/app/channel-partners/:id/team
```

Company can have many members.

Fields:

- Member Name
- Mobile
- Email
- Designation
- Partner Portal Role
- RERA Number optional
- RERA Certificate optional
- Active
- Can Submit Leads
- Can View Company Leads
- Can Create Invoice
- Portal Login Enabled

---

# 23. CP Team Roles

Recommended simple portal roles:

```text
COMPANY_ADMIN
SALES_MEMBER
```

Company Admin:

- team management;
- all company-submitted leads;
- company bookings;
- invoice management.

Sales Member:

- own submitted leads;
- own visits/bookings;
- no bank/settings access.

Do not reuse internal CRM role permissions for Partner Portal.

---

# 24. Partner Portal Authentication

Use a dedicated Partner Portal account layer.

Recommended:

```text
PartnerPortalUser
```

Fields:

- tenantId
- channelPartnerId
- channelPartnerMemberId optional
- email/mobile
- passwordHash
- role
- status
- lastLoginAt

Statuses:

```text
INVITED
ACTIVE
SUSPENDED
INACTIVE
```

Partner users must never receive access to `/app/*` internal routes.

---

# 25. CP Registration Step 5 — Project Empanelment

A Partner is not automatically approved for every Project.

Create:

```text
PartnerProjectEmpanelment
```

Fields:

- channelPartnerId
- projectId
- status
- effectiveFrom
- effectiveTo
- commissionRuleId
- notes
- approvedBy
- approvedAt

Status:

```text
PENDING
APPROVED
REJECTED
SUSPENDED
EXPIRED
```

---

# 26. CP Project Rules

Only APPROVED project empanelment can:

- submit project Lead, if tenant requires;
- receive commission;
- appear as active partner for project.

Tenant option:

```text
cpRequireProjectEmpanelment
```

---

# 27. Channel Partner Workspace

Header:

```text
ABC Realty
Company Channel Partner
ACTIVE

GujRERA: AG/GJ/AHMEDABAD/...
Valid until: 10 Dec 2026
```

Tabs:

```text
Overview
Team
Projects
Leads
Visits
Bookings
Commission
Invoices
Documents
Audit
```

---

# 28. Internal CP Overview

Cards:

- Registration
- RERA
- Active Projects
- Team Size
- Leads
- Visits
- Bookings
- Booking Value
- Commission Eligible
- Commission Invoiced
- Payout Paid

---

# 29. Partner Portal Dashboard — Company

Tiles:

```text
Leads Submitted
Active Leads
Visits Planned
Visits Completed
Bookings
Booking Value
Eligible Commission
Invoices Pending
Paid Commission
```

Additional:

```text
Team Performance
Recent Leads
Recent Bookings
Invoice Status
RERA Alert
```

---

# 30. Partner Portal Dashboard — Individual

Same metrics but no Team Performance / Team Management.

---

# 31. CP Lead Submission

Partner Portal:

```text
/cp/leads/new
```

Minimum fields:

- Project
- Customer Name
- Mobile
- Email optional
- Requirement
- Configuration
- Budget optional
- Preferred Visit Date optional
- Note

Partner identity is derived from authenticated Partner User.

Never trust partner ID from browser input.

---

# 32. CP Lead Submission Connects to Existing CRM Capture

Flow:

```text
CP submits
→ normalize customer mobile
→ find Contact
→ resolve existing Lead
→ create Partner Lead Claim / attribution
→ run existing Lead capture/re-inquiry logic
→ normal Lead Allocation
→ SLA
→ customer acknowledgement
→ internal owner notification
```

Do not create a separate CP Lead database that sales users have to work independently.

---

# 33. Channel Partner Lead Attribution Fields

Add to Lead where appropriate:

```text
channelPartnerId
channelPartnerMemberId
partnerLeadClaimId
partnerAttributionStatus
```

Do not overwrite existing marketing source history automatically.

Channel Partner attribution is a separate commercial attribution dimension.

A Lead may have:

```text
Marketing Source = Google Ads
Partner Association = ABC Realty
```

only when business rules approve it.

---

# 34. Partner Lead Claim

Entity:

```text
PartnerLeadClaim
```

Fields:

- tenantId
- channelPartnerId
- channelPartnerMemberId
- contactId
- leadId
- projectId
- submittedAt
- submittedMobile
- status
- conflictReason
- reviewedBy
- reviewedAt
- protectionUntil
- note

Status:

```text
PENDING
ACCEPTED
REJECTED
CONFLICT
EXPIRED
```

---

# 35. CP Lead Protection / Conflict Rule

Real-estate Partner source disputes must not be handled by silently replacing source.

Setup:

```text
CP Lead Protection Days
```

Optional project override.

Behavior:

### No existing same-project Lead

Accept CP association.

### Same active Lead already associated to same CP

Treat as CP re-inquiry.

### Same active Lead associated to another CP

Create:

```text
CONFLICT
```

Internal review required.

### Same active Direct/Marketing Lead

Create claim according to tenant policy:

```text
AUTO_REJECT
REVIEW
ACCEPT_IF_INACTIVE_FOR_N_DAYS
```

Recommended default product behavior:

```text
REVIEW
```

Do not silently overwrite existing ownership/source.

---

# 36. CP Claim Review Screen

Route:

```text
/app/channel-partners/claims
```

Show:

- Customer
- Mobile
- Project
- Existing Lead Owner
- Existing Source
- Existing CP
- New Claiming CP
- Existing Lead Date
- Claim Date
- Protection Status

Actions:

```text
Accept Claim
Reject Claim
Keep Existing Partner
```

Audit all decisions.

---

# 37. CP Lead Visibility

External Partner must see only allowed data.

Partner Lead card:

- Customer Name
- Project
- Submitted Date
- Current Stage
- Visit Status
- Booking Status
- Sales Contact optional
- Last public update

Do **not** expose:

- internal notes;
- internal user mentions;
- call recordings;
- discount approval notes;
- competing partner claim details;
- sensitive internal source history;
- management-only pricing notes.

---

# 38. CP Site Visits

Existing CRM Site Visit remains authoritative.

If a CP-submitted Lead gets a visit:

```text
SiteVisit.channelPartnerId
SiteVisit.channelPartnerMemberId
```

may derive from accepted claim.

Partner sees:

- planned date/time;
- completed status;
- outcome only if tenant marks it partner-visible.

No separate duplicate visit record.

---

# 39. CP Booking Attribution

On Booking:

snapshot:

```text
channelPartnerId
channelPartnerMemberId
partnerLeadClaimId
partnerCommissionRuleId
```

A later CP master edit must not rewrite historical Booking partner attribution.

---

# 40. Channel Partner Commission Rules

Required because Invoice Management needs a reliable eligible amount.

Route:

```text
/app/setup/channel-partner/commission-rules
```

Rule scope:

```text
Organization
Project
Specific Partner
Partner Type
```

More specific rule wins.

---

# 41. Commission Rule Fields

```text
Rule Name
Project
Partner optional
Basis
Rate Type
Rate
Eligibility Trigger
Collection Threshold %
Effective From
Effective To
Active
```

Basis:

```text
FINAL_BOOKING_PRICE
BASE_VALUE
FIXED_AMOUNT
```

Rate Type:

```text
PERCENTAGE
FIXED
```

Eligibility Trigger:

```text
ON_BOOKING
ON_TOKEN_RECEIVED
ON_COLLECTION_PERCENT
ON_FULL_PAYMENT
MANUAL
```

---

# 42. Commission Entitlement

Create:

```text
PartnerCommissionEntitlement
```

Fields:

- bookingId
- partnerId
- partnerMemberId
- commissionRuleSnapshot
- commissionBasisAmount
- commissionRate
- calculatedCommission
- eligibilityTrigger
- threshold
- eligibleAmount
- status
- eligibleAt
- invoicedAmount
- paidAmount

Status:

```text
ACCRUED
NOT_YET_ELIGIBLE
ELIGIBLE
PARTIALLY_INVOICED
INVOICED
PARTIALLY_PAID
PAID
CANCELLED
```

---

# 43. Collection-Driven Commission Eligibility

If rule:

```text
ON_COLLECTION_PERCENT = 20%
```

Booking collections calculate:

```text
totalReceived / finalBookingPrice
```

When threshold reached:

```text
Commission Entitlement → ELIGIBLE
```

Notify Partner and internal CP team.

This is one of the key connections between CP and Collections.

---

# 44. Channel Partner Invoice Management

Internal:

```text
/app/channel-partners/invoices
```

External:

```text
/cp/invoices
```

---

# 45. Partner Invoice Creation

Partner may create invoice only against eligible commission.

Flow:

```text
Eligible Commission
→ Select Booking / Entitlements
→ Invoice Details
→ Upload Invoice PDF
→ Submit
→ Internal Review
→ Approve / Reject / Correction
→ Mark Payout Processing
→ Paid
```

---

# 46. CP Invoice Fields

- Invoice ID
- Channel Partner
- Invoice Number
- Invoice Date
- Billing Entity Name
- GSTIN
- PAN
- Booking/Entitlement Lines
- Taxable Value
- GST Amount
- Other Tax/Adjustment
- Invoice Total
- Invoice PDF
- Bank Account Snapshot
- Note
- Status
- Submitted At
- Reviewed At
- Approved At
- Paid At
- Payment Reference

---

# 47. CP Invoice Status

```text
DRAFT
SUBMITTED
UNDER_REVIEW
CORRECTION_REQUIRED
APPROVED
REJECTED
PAYMENT_PROCESSING
PARTIALLY_PAID
PAID
CANCELLED
```

---

# 48. CP Invoice Line

Each line references:

```text
bookingId
commissionEntitlementId
eligibleCommission
invoiceClaimAmount
```

Validation:

```text
total claimed against entitlement
<= eligible uninvoiced amount
```

Prevent double invoicing.

---

# 49. CP Invoice Internal Review

Review screen shows:

- Partner details
- RERA status
- PAN/GST
- Invoice PDF
- Booking
- Customer
- Unit
- Booking value
- Collected amount / %
- Commission rule
- Eligible amount
- Claimed amount

Actions:

```text
Approve
Reject
Request Correction
```

---

# 50. CP Payout Tracking

Do not build accounting ledger.

Track operational payout:

```text
PENDING
PROCESSING
PARTIAL
PAID
```

Fields:

- payout date
- amount
- UTR / transaction reference
- deduction / withholding informational amount
- note
- entered by

---

# 51. CP Reports

Add Report family:

```text
Channel Partner Performance
```

Filters:

- Date
- Project
- Partner
- Partner Type
- RERA Status
- City

Metrics:

- Leads
- Connected
- Visits
- Blocks
- Bookings
- Booking Value
- Lead→Visit
- Visit→Booking
- Lead→Booking
- Commission Accrued
- Commission Eligible
- Invoiced
- Paid

Add:

```text
Channel Partner Invoice Report
```

with invoice/payout status.

---

# 52. CP Notifications

Internal notifications:

- new registration submitted;
- registration correction submitted;
- RERA expiring;
- RERA expired;
- lead claim conflict;
- CP lead submitted;
- booking from CP;
- commission became eligible;
- invoice submitted;
- invoice correction;
- invoice approved;
- payout marked paid.

External:

- registration status;
- lead claim accepted/rejected;
- visit planned;
- booking achieved;
- commission eligible;
- invoice status;
- payout paid;
- RERA expiry.

---

# 53. CP Background Jobs

Add:

```text
cp.rera_expiry
cp.commission_eligibility
cp.invoice_notifications
```

All jobs idempotent.

---

# PART B — HRMS MODULE

# 54. HRMS Product Goal

HRMS should answer:

```text
Who works here?
Where do they work?
What is their department/designation/job?
Which branch/office do they sit in?
What shift applies?
Who is present/absent/late/early?
Which punches are invalid or missing?
Who needs face approval?
Who is on leave?
What leave balance is available?
Which holidays/week-offs apply?
```

This HRMS is connected to CRM users.

---

# 55. Employee vs System User

Do not make Employee and User the same entity.

## User

Authentication + permissions.

## Employee

HR record.

Link:

```text
Employee.userId
```

nullable.

An Employee may exist without system login.

A system User may be linked to exactly one Employee within a tenant.

---

# 56. Employee Exit and CRM Work

Before Employee-linked User is deactivated:

system must check:

- active Leads;
- pending Follow-ups;
- Site Visits;
- Collection assignments;
- pending HR approvals.

Do not orphan CRM/Collection work.

Provide transfer workflow.

---

# 57. HRMS Main Navigation

```text
HRMS
├── Dashboard
├── Employees
├── Organization
│   ├── Departments
│   ├── Designations
│   ├── Jobs
│   ├── Branches
│   └── Seating Offices
├── Shifts
├── Attendance
│   ├── Daily Attendance
│   ├── Punches
│   ├── Face Approval Requests
│   └── Regularization
├── Leave
│   ├── Leave Requests
│   ├── Leave Balance
│   ├── Leave Types
│   ├── Leave Groups
│   └── Bulk Group Assignment
├── Holidays
├── Week Off
└── Reports
    ├── Attendance Report
    └── Attendance Muster
```

---

# 58. HRMS Dashboard

Route:

```text
/app/hrms/dashboard
```

Use the user's supplied reference layout:

```text
Present
Absent
Late In
Early Out

Out Of Range Punch In
Out Of Range Punch Out
Missing Punch
Face Approval

Today's Leave Requests
```

Use a clean 4-column responsive card grid.

Each tile contains:

- Label
- Count
- simple icon
- clickable entire card

No heavy charts above the cards.

---

# 59. HRMS Dashboard Tile Definitions

## Present

Employees whose calculated attendance status for selected day is Present/Half Day according to policy.

Default view date:

```text
Today
```

## Absent

Employees expected to work but:

- no approved Leave;
- not Holiday;
- not Week Off;
- attendance calculation = Absent.

## Late In

Attendance has:

```text
lateIn = true
```

## Early Out

Attendance has:

```text
earlyOut = true
```

## Out Of Range Punch In

First valid IN punch occurred outside allowed Seating Office geofence and is not approved.

## Out Of Range Punch Out

OUT punch occurred outside allowed geofence and is not approved.

## Missing Punch

Expected IN or OUT is missing.

## Face Approval

Pending Face Approval Requests.

## Today's Leave Requests

Leave Requests submitted/pending approval today or leave requests requiring action today based on selected HR workflow.

Recommended count definition:

```text
pending requests created today
```

with a separate filter available for all pending.

---

# 60. HRMS Dashboard Drilldown

Click Present:

```text
/app/hrms/attendance?date=today&status=PRESENT
```

Click Absent:

```text
...?status=ABSENT
```

Click Late In:

```text
...?flag=lateIn
```

Click Face Approval:

```text
/app/hrms/face-approvals?status=PENDING
```

---

# 61. HRMS Dashboard Filters

Top filters:

- Date
- Branch
- Seating Office
- Department
- Shift

Permissions determine whether user sees:

```text
Own
Team
All
```

---

# 62. Employee Table

Route:

```text
/app/hrms/employees
```

Columns:

- Employee Code
- Name
- Mobile
- Department
- Designation
- Job
- Branch
- Seating Office
- Shift
- Reporting Manager
- Joining Date
- Employment Status
- System Access
- Attendance Today

Filters:

- Name / code / mobile
- Department
- Designation
- Job
- Branch
- Office
- Shift
- Manager
- Status
- Joining date

---

# 63. Employee Status

```text
DRAFT
ACTIVE
ON_NOTICE
EXITED
INACTIVE
```

Do not delete Employee history.

---

# 64. Employee Create / Edit Stepper

Use:

```text
1. Personal
2. Employment
3. Organization & Reporting
4. Attendance & Shift
5. Leave
6. System Access & Documents
```

---

# 65. Employee Personal Fields

- Employee Code
- First Name
- Last Name
- Mobile
- Alternate Mobile
- Personal Email
- Work Email
- Date of Birth
- Gender optional
- Current Address
- Permanent Address
- City
- State
- Pincode
- Emergency Contact Name
- Emergency Contact Mobile
- Profile Photo

Employee Code unique per tenant.

---

# 66. Employee Employment Fields

- Date of Joining
- Employment Type
- Probation End Date
- Confirmation Date
- Notice Period Days
- Employment Status
- Exit Date
- Exit Reason

Employment Type:

```text
PERMANENT
CONTRACT
INTERN
CONSULTANT
TRAINEE
OTHER
```

Payroll fields are out of scope.

---

# 67. Organization & Reporting Fields

- Department
- Designation
- Job
- Branch
- Seating Office
- Reporting Manager
- Dotted-line Manager optional
- Work Location Type
- Cost Center optional informational
- Employee Grade optional

Work Location:

```text
OFFICE
FIELD
HYBRID
REMOTE
```

---

# 68. Department Master

Route:

```text
/app/hrms/setup/departments
```

Fields:

- Department Name
- Code
- Department Head Employee
- Parent Department optional
- Active

Supports hierarchy if needed.

---

# 69. Designation Master

Fields:

- Designation Name
- Code
- Level / Rank optional
- Description
- Active

Examples:

```text
Sales Executive
Senior Sales Executive
Sales Manager
VP Sales
HR Executive
```

---

# 70. Job Master

Clarification:

```text
Job = functional role/position template.
Designation = formal title assigned to Employee.
```

Job fields:

- Job Name
- Job Code
- Department
- Default Designation optional
- Job Description
- Responsibilities optional
- Default Shift optional
- Active

Recruitment/job-posting functionality is not included unless separately requested.

---

# 71. Branch Master

Fields:

- Branch Name
- Code
- Address
- City
- State
- Pincode
- Branch Head
- Active

A Branch is an organizational/business location.

---

# 72. Seating Office Master

A Seating Office is the physical attendance location.

It may belong to a Branch.

Fields:

- Office Name
- Code
- Branch
- Address
- Latitude
- Longitude
- Geofence Radius Meters
- Time Zone
- Active
- Attendance Enabled

A Branch may contain several Seating Offices.

---

# 73. Seating Office Geofence

For punches containing location:

calculate:

```text
distance(employeePunch, allowedOfficeCoordinates)
```

Set:

```text
IN_RANGE
OUT_OF_RANGE
UNKNOWN
```

Do not trust a browser-provided "inRange=true" flag.

Server calculates range where coordinates are available.

---

# 74. Shift Management

Route:

```text
/app/hrms/shifts
```

Shift fields:

- Shift Name
- Code
- Start Time
- End Time
- Overnight Shift boolean
- Grace In Minutes
- Grace Out Minutes
- Minimum Half-Day Minutes
- Minimum Full-Day Minutes
- Break Minutes
- Flexible Start optional
- Attendance Policy
- Active

---

# 75. Shift Assignment

Employee may have:

- Default Shift
- Temporary Shift Assignment
- Shift Roster

Entity:

```text
EmployeeShiftAssignment
```

Fields:

- employeeId
- shiftId
- effectiveFrom
- effectiveTo
- assignedBy
- note

Most-specific effective assignment wins.

---

# 76. Shift Roster

Optional simple roster:

```text
/app/hrms/shifts/roster
```

Month/week view.

Assign shift to one/many employees for specific date range.

Do not build advanced workforce optimization.

---

# 77. Attendance Punch

Entity:

```text
AttendancePunch
```

Fields:

- tenantId
- employeeId
- date
- timestamp
- punchType
- source
- latitude
- longitude
- seatingOfficeId
- rangeStatus
- faceStatus
- deviceId optional
- photoReference optional
- note
- createdBy
- correctionStatus

Punch Type:

```text
IN
OUT
```

Source:

```text
FACE
MOBILE
DEVICE
WEB
MANUAL
IMPORT
```

---

# 78. Daily Attendance Summary

Entity:

```text
AttendanceDay
```

One row per Employee per local date.

Fields:

- employeeId
- date
- shiftId
- expectedIn
- expectedOut
- firstIn
- lastOut
- workMinutes
- attendanceStatus
- lateIn
- lateMinutes
- earlyOut
- earlyMinutes
- missingPunch
- outOfRangeIn
- outOfRangeOut
- leaveId
- holidayId
- weekOffApplied
- regularizationStatus
- calculatedAt

---

# 79. Attendance Status

Primary status:

```text
PRESENT
ABSENT
HALF_DAY
ON_LEAVE
HOLIDAY
WEEK_OFF
NOT_APPLICABLE
```

Flags are separate:

```text
lateIn
earlyOut
missingPunch
outOfRangeIn
outOfRangeOut
```

Do not turn every exception into a competing attendance status.

---

# 80. Attendance Calculation Order

Recommended:

```text
1. Employee active on date?
2. Holiday?
3. Week Off?
4. Approved Leave?
5. Expected Shift?
6. Punches?
7. Work duration?
8. Late / Early?
9. Range flags?
10. Missing Punch?
```

Specific tenant Attendance Policy determines final thresholds.

---

# 81. Attendance Policy

Setup:

```text
/app/hrms/setup/attendance-policy
```

Fields:

- Grace In
- Grace Out
- Half Day Work Minutes
- Full Day Work Minutes
- Missing Punch Handling
- Out-of-range Requires Approval
- Auto Absent Time
- Field Employee Geofence Exemption
- Multiple Punch Handling
- Late/Early rounding behavior

Project/department override is not needed in first version unless required.

Shift may override key timing fields.

---

# 82. Face Approval Request

Route:

```text
/app/hrms/face-approvals
```

Entity:

```text
FaceApprovalRequest
```

Fields:

- employeeId
- requestType
- imageReference
- reason
- submittedAt
- status
- reviewerId
- reviewedAt
- reviewNote
- providerReference optional

Request Type:

```text
NEW_FACE
UPDATE_FACE
REPLACE_FACE
```

Status:

```text
PENDING
APPROVED
REJECTED
CANCELLED
```

---

# 83. Face Approval Workflow

Employee / HR uploads approved face image:

```text
Submit
→ Pending
→ HR Review
→ Approve / Reject
```

On approval:

- mark prior face inactive;
- store approved reference;
- sync to face-attendance provider if integration exists;
- audit action.

---

# 84. Biometric Data Security

Face data is sensitive.

Requirements:

- restrict permissions;
- private storage;
- signed URLs;
- audit downloads/access where practical;
- never expose images in generic Employee export;
- if provider returns biometric templates, do not store raw template unless necessary;
- encrypt provider secrets.

---

# 85. Attendance Regularization

Add because Missing Punch and Out-of-Range require a resolution path.

Route:

```text
/app/hrms/attendance/regularization
```

Employee/Manager may request:

- Missing In Punch
- Missing Out Punch
- Out Of Range In
- Out Of Range Out
- Incorrect Punch Time
- Attendance Status Correction

Fields:

- Employee
- Date
- Issue Type
- Requested In
- Requested Out
- Reason
- Attachment optional
- Status

---

# 86. Regularization Status

```text
PENDING
APPROVED
REJECTED
CANCELLED
```

On approval:

- add correction / approved manual punch;
- recalculate AttendanceDay;
- retain original punch history;
- audit before/after.

Never erase original raw punch.

---

# 87. Attendance Report

Route:

```text
/app/hrms/reports/attendance
```

One row per Employee per Date.

Columns:

- Date
- Employee Code
- Employee
- Department
- Branch
- Office
- Shift
- First In
- Last Out
- Work Hours
- Status
- Late In
- Early Out
- Missing Punch
- Out Of Range
- Leave
- Regularization

Filters:

- Date range
- Employee
- Department
- Branch
- Office
- Shift
- Attendance Status
- Exception

Export:

- CSV
- XLSX if existing export infrastructure supports
- PDF optional

---

# 88. Attendance Muster Report

Route:

```text
/app/hrms/reports/attendance-muster
```

Month matrix.

Rows:

```text
Employee
```

Columns:

```text
1 2 3 ... 31
```

Codes:

```text
P    Present
A    Absent
HD   Half Day
L    Leave
H    Holiday
WO   Week Off
MP   Missing Punch
```

Late/Early can show icon/tooltip rather than replacing primary code.

Totals at row end:

- Present Days
- Absent Days
- Leave Days
- Week Off
- Holidays
- Half Days
- Late Count
- Early Count

---

# 89. Leave Management — Main Screens

```text
/app/hrms/leave/requests
/app/hrms/leave/types
/app/hrms/leave/groups
/app/hrms/leave/group-assignments
/app/hrms/leave/balances
```

---

# 90. Leave Type

Fields:

- Name
- Code
- Paid / Unpaid
- Unit
- Default Annual Entitlement
- Carry Forward Allowed
- Max Carry Forward
- Negative Balance Allowed
- Half Day Allowed
- Attachment Required After N Days
- Minimum Notice Days
- Maximum Consecutive Days
- Active

Unit:

```text
DAY
HALF_DAY
```

---

# 91. Leave Group

A Leave Group defines entitlement rules for a set of Employees.

Example:

```text
Permanent Employee Leave Group
```

Contains:

```text
Casual Leave      7
Sick Leave        7
Privilege Leave  15
```

Entity:

```text
LeaveGroup
LeaveGroupEntitlement
```

---

# 92. Bulk Leave Group Assignment

Route:

```text
/app/hrms/leave/group-assignments
```

Filters:

- Branch
- Department
- Designation
- Job
- Employment Type

Select employees.

Choose Leave Group.

Effective Date.

Preview:

```text
45 employees will receive Permanent Employee Leave Group.
```

Confirm.

Audit bulk assignment.

---

# 93. Employee Leave Balance

Route:

```text
/app/hrms/leave/balances
```

Columns:

- Employee
- Leave Type
- Opening
- Credited
- Used
- Pending
- Adjusted
- Available
- Carry Forward

Allow authorized adjustment:

```text
+ / - Days
Reason mandatory
```

Audit every adjustment.

---

# 94. Leave Request

Fields:

- Employee
- Leave Type
- From Date
- To Date
- Full / Half Day
- Number of Leave Days
- Reason
- Attachment
- Contact During Leave optional
- Handover Note optional

System computes leave days using:

- Holiday Calendar
- Week Off
- Leave Type policy

---

# 95. Leave Request Status

```text
DRAFT
SUBMITTED
MANAGER_APPROVED
APPROVED
REJECTED
CANCELLED
```

If only one approval level configured:

```text
SUBMITTED → APPROVED/REJECTED
```

---

# 96. Leave Approval

Default recommended:

```text
Employee
→ Reporting Manager
→ HR (optional/configurable)
```

Tenant config:

```text
leaveApprovalMode = MANAGER_ONLY | MANAGER_THEN_HR | HR_ONLY
```

---

# 97. Leave Validation

Reject/flag:

- end before start;
- overlap existing approved leave;
- insufficient balance when negative not allowed;
- request exceeds max consecutive days;
- inactive Employee;
- invalid Leave Type;
- same-day duplicate.

Pending balance must reserve days where policy requires.

---

# 98. Holiday Management

Route:

```text
/app/hrms/holidays
```

Holiday fields:

- Name
- Date
- Holiday Type
- Branch
- Seating Office optional
- Description
- Active

Holiday Type:

```text
PUBLIC
COMPANY
OPTIONAL
```

In first version, Optional Holiday may be informational unless selection workflow is added.

---

# 99. Holiday Calendar

Allow:

- organization-wide;
- Branch-specific;
- Seating Office-specific.

Most specific active rule wins.

Prevent duplicate same-date/same-scope holidays.

---

# 100. Week Off Management

Route:

```text
/app/hrms/week-offs
```

Support:

```text
FIXED_WEEKDAY
ALTERNATE_WEEK
CUSTOM_DATE
```

Examples:

```text
Every Sunday
2nd & 4th Saturday
Every Saturday + Sunday
```

---

# 101. Week Off Policy

Fields:

- Name
- Applies To
- Branch / Department / Employee
- Weekday Rules
- Effective From
- Effective To
- Active

Specific Employee assignment overrides broader policy.

---

# 102. HRMS Employee Self-Service

Users linked to Employee may see:

```text
My Attendance
My Punches
My Leave
My Leave Balance
My Face Request
My Holiday Calendar
My Week Off
```

Do not expose company-wide Employee data unless permission grants.

---

# 103. HRMS to CRM Connection

Employee Workspace should display if linked User has:

```text
CRM Role
CRM Active Leads
Today's Follow-ups
Today's Visits
Collection Assignments
```

This is summary-only.

Do not duplicate CRM data into HRMS.

---

# 104. CRM Reports by HR Dimension

Existing Sales Report may optionally filter/group by:

- Department
- Branch
- Designation

because Sales Users are linked to Employees.

If no Employee link:

show:

```text
Unmapped User
```

---

# 105. HRMS Notifications

- face request submitted;
- face approved/rejected;
- missing punch;
- regularization submitted;
- regularization approved/rejected;
- leave submitted;
- leave approved/rejected;
- leave balance adjusted;
- shift changed;
- holiday added if notification configured.

---

# 106. HRMS Background Jobs

Add:

```text
hr.attendance_daily
hr.missing_punch
hr.leave_balance
hr.face_sync
```

## Attendance Daily

Recalculate current/recent dates as needed.

## Missing Punch

After shift completion + configured grace:

flag missing.

## Leave Balance

Run credit/carry-forward based on configured policy cadence.

Do not implement payroll.

---

# PART C — POST-BOOKING, CUSTOMER KYC & COLLECTIONS

# 107. Post-Booking Product Goal

After a Lead becomes Booked, the CRM must no longer become a dead end.

The system should answer:

```text
Has the customer completed the Booking Form?
Has KYC been uploaded?
Is KYC verified?
Which Quotation was selected?
Which Payment Plan applies?
What is due today?
What is overdue?
How much has been collected?
Who owns collection follow-up?
What did the customer promise to pay?
What payment links were sent?
```

---

# 108. Booking Event → New Post-Booking Initialization

On successful existing Booking:

emit:

```text
booking.created
```

New listener/service creates:

```text
BookingProfile / Booking Workspace data
Customer Booking Form
Payment Schedule
Collection Assignment
Post-booking timeline entry
```

A failure in post-booking initialization must **not undo a valid booking**.

Use idempotent initialization job:

```text
booking.post_booking_initialize
```

---

# 109. Booking Workspace

Route:

```text
/app/bookings/:id
```

Tabs:

```text
Overview
Customer & KYC
Quotation
Payment Plan
Collections
Documents
Channel Partner
Timeline
```

---

# 110. Booking List

Route:

```text
/app/bookings
```

Columns:

- Booking No.
- Customer
- Project
- Unit
- Booking Date
- Final Booking Value
- Quotation
- Payment Plan
- KYC Status
- Total Received
- Outstanding
- Next Due Date
- Overdue Amount
- Collection Owner
- Channel Partner
- Booking Status

---

# 111. Booking List Filters

- Search mobile/name/booking no/unit
- Project
- Unit
- Booking Date
- KYC Status
- Payment Status
- Collection Owner
- Channel Partner
- Overdue yes/no
- Due Date Range
- Buyer Purpose

---

# 112. Booking Status

Commercial booking remains valid.

Operational post-booking status:

```text
BOOKED
KYC_PENDING
KYC_SUBMITTED
KYC_VERIFIED
ACTIVE_COLLECTION
FULLY_PAID
CANCELLED
```

Recommended implementation:

Do **not** overload the existing sales Booking status if it is already stable.

Add derived:

```text
postBookingStatus
```

---

# 113. Booking Workspace Overview

Show:

```text
Customer
Project
Unit
Booking Date
Booking Value
Salesperson
Collection Owner
Channel Partner
Quotation
Payment Plan
KYC
Collected
Outstanding
Next Payment
```

Progress strip:

```text
✓ Booked
● Booking Form
○ KYC Verified
○ Payments In Progress
○ Fully Paid
```

This progress is post-booking only.

---

# 114. Quotation → Booking → Payment Plan Connection

The relationship must be explicit:

```text
Quotation
  ├── Unit
  ├── Final Consideration
  └── Payment Plan Snapshot
        ↓
Mark Booked
  Select / inherit Quotation
        ↓
Booking
  freezes Quotation ID
  freezes Payment Plan
        ↓
Booking Payment Schedule
```

Never rebuild commercial terms from today's Project master for an old Booking.

---

# 115. Booking Commercial Snapshot

Booking should freeze:

- quotationId
- quotationVersion
- unitId
- projectId
- finalBookingPrice
- discount
- paymentPlanId
- paymentPlanName
- paymentPlanSnapshotRows
- salesperson
- buyerPurpose
- source attribution
- CP attribution

Historical Booking must not change when Project pricing or Payment Plan is edited later.

---

# 116. Customer Booking Form

Internal route:

```text
/app/bookings/:id/customer-form
```

Public secure route:

```text
/booking-form/:token
```

The internal user prepares the form.

Then:

```text
Generate Customer Link
Copy Link
Send WhatsApp
Send Email
```

---

# 117. Booking Form Link Security

Entity:

```text
BookingCustomerLink
```

Fields:

- bookingId
- tokenHash
- status
- createdAt
- expiresAt
- lastOpenedAt
- submittedAt
- revokedAt

Status:

```text
ACTIVE
SUBMITTED
EXPIRED
REVOKED
```

Token must be unguessable.

Tenant settings:

```text
bookingLinkExpiryDays
bookingLinkRequireOtp
```

OTP may be optional/configurable.

If OTP is enabled:

verify against Booking customer mobile.

---

# 118. Customer Booking Form — Read-Only Commercial Section

Customer sees:

- Project
- Unit
- Booking Date
- Booking Value
- Quotation
- Selected Payment Plan
- Initial Booking Amount
- Sales Contact

Customer cannot edit these fields.

If incorrect:

```text
Report an Issue
```

creates internal Booking query/note.

---

# 119. Customer Booking Form — Applicant Type

Support:

```text
INDIVIDUAL
COMPANY
```

Default from existing Contact/Booking.

---

# 120. Primary Applicant Fields — Individual

- Full Name
- Mobile
- Email
- Date of Birth
- PAN
- Aadhaar Number optional/configurable
- Occupation
- Employer / Business Name
- Nationality
- Marital Status optional
- Permanent Address
- Correspondence Address
- City
- State
- Pincode
- Funding Type
- Loan Bank optional

Avoid unnecessary mandatory fields.

Tenant can configure required fields.

---

# 121. Company Applicant Fields

- Company Legal Name
- PAN
- GSTIN
- CIN optional
- Registered Address
- Authorized Signatory Name
- Authorized Signatory Mobile
- Authorized Signatory Email
- Signatory PAN
- Signatory KYC

---

# 122. Co-Applicant

Allow multiple.

Fields:

- Relationship
- Name
- Mobile
- Email
- PAN
- Aadhaar optional
- Address
- KYC documents

Do not create separate CRM Contact automatically unless tenant chooses.

Recommended:

store as BookingApplicant.

---

# 123. Booking Applicant Entity

```text
BookingApplicant
```

Fields:

- bookingId
- type
- applicantRole
- name
- mobile
- email
- DOB
- PAN
- Aadhaar masked/encrypted
- address
- occupation
- company fields
- KYC status

Applicant Role:

```text
PRIMARY
CO_APPLICANT
AUTHORIZED_SIGNATORY
```

---

# 124. Customer Declaration

Final form step:

```text
I confirm the information submitted is correct.
```

Store:

- confirmation timestamp;
- source IP where legally appropriate;
- user agent;
- submitted form version.

This is a data confirmation, not a legal e-signature unless e-sign is separately implemented.

---

# 125. KYC Document Types

Setup:

```text
/app/setup/post-booking/kyc-document-types
```

Dynamic document types.

Suggested defaults:

- PAN
- Aadhaar Front
- Aadhaar Back
- Passport
- Driving License
- Passport Photo
- Cancelled Cheque
- Company PAN
- GST Certificate
- Incorporation Certificate
- Other

Fields:

- Name
- Applies To
- Mandatory
- Allowed File Types
- Max Size
- Expiry Required
- Active

---

# 126. KYC Upload

Customer can upload directly from Booking Form link.

Document fields:

- bookingApplicantId
- documentTypeId
- fileReference
- documentNumber masked
- expiryDate optional
- uploadedByType
- uploadedAt
- reviewStatus
- reviewNote
- reviewedBy
- reviewedAt

Uploaded By:

```text
CUSTOMER
INTERNAL_USER
```

---

# 127. KYC Review Status

Per document:

```text
UPLOADED
UNDER_REVIEW
APPROVED
REJECTED
RESUBMISSION_REQUIRED
```

Overall Booking KYC:

```text
NOT_STARTED
PARTIAL
SUBMITTED
UNDER_REVIEW
CORRECTION_REQUIRED
VERIFIED
```

---

# 128. Customer KYC Correction Flow

Internal reviewer rejects a document:

```text
PAN image unreadable.
Please upload a clear copy.
```

System:

- sets document `RESUBMISSION_REQUIRED`;
- Booking KYC → CORRECTION_REQUIRED;
- sends customer new/reusable secure link notification;
- customer replaces document;
- retain old file as historical/audit reference, not active.

---

# 129. KYC Internal Queue

Route:

```text
/app/bookings/kyc
```

Tiles:

```text
Not Started
Partial
Submitted
Correction Required
Verified
```

List columns:

- Customer
- Project / Unit
- Booking Date
- KYC Status
- Missing Documents
- Submitted At
- Reviewer

---

# 130. KYC Permissions

Recommended:

```text
booking.kyc.view
booking.kyc.review
booking.kyc.edit
booking.customer_link.create
```

Sales users may view status without necessarily viewing sensitive document images.

---

# 131. KYC Security

Requirements:

- documents private;
- signed time-limited download URL;
- permission check on every download;
- sensitive document numbers masked;
- full number available only to authorized roles;
- access audited where practical;
- no KYC files in public static folders.

---

# 132. Booking Payment Schedule

Entity:

```text
BookingInstallment
```

Generated from the selected Payment Plan snapshot.

Fields:

- bookingId
- sequence
- milestone
- percentage
- scheduledAmount
- dueRule
- expectedDueDate
- actualDueDate
- amountReceived
- outstandingAmount
- status
- paidAt
- note

---

# 133. Payment Due Rules

Support:

```text
BOOKING_DATE
DAYS_AFTER_BOOKING
FIXED_DATE
EXPECTED_MILESTONE_DATE
POSSESSION_DATE
MANUAL_TRIGGER
```

This extends the Payment Plan rows.

---

# 134. Payment Plan Setup Extension

Project Payment Plan installment row should support:

- Milestone
- Percentage
- Due Rule
- Offset Days
- Expected Milestone Date optional
- Customer Note

At Quotation time:

snapshot.

At Booking time:

resolve expected dates.

---

# 135. Due Date Resolution

Examples:

## Booking

```text
Booking Date = 20 Aug 2026
Due Rule = BOOKING_DATE
→ 20 Aug 2026
```

## 30 Days Later

```text
DAYS_AFTER_BOOKING = 30
→ 19 Sep 2026
```

## Expected Construction Milestone

If expected date configured:

use it.

If not:

```text
Expected Due Date = TBD
```

and internal project/collection user sets actual due date when milestone occurs.

Do not invent a date.

---

# 136. Payment Schedule Status

Stored primary status:

```text
UPCOMING
DUE
PARTIAL
PAID
CANCELLED
```

Derived flag:

```text
OVERDUE
```

when:

```text
dueDate < today
AND outstanding > 0
```

---

# 137. Payment Schedule Timeline UI

Booking Workspace:

```text
PAYMENT PLAN

✓ Booking Amount
  ₹10,00,000
  Due 20 Aug 2026
  Paid 20 Aug 2026

● 1st Installment
  ₹20,00,000
  Due 20 Sep 2026
  Outstanding ₹20,00,000
  [Create Payment Link]

○ 2nd Installment
  ₹20,00,000
  Due 20 Oct 2026
```

---

# 138. Customer Booking Portal — Payment View

Secure Booking link shows:

```text
Payment Plan
Total Booking Value
Paid
Outstanding
Next Due
```

Installments.

For active payment link:

```text
[ Pay ₹20,00,000 ]
```

Do not expose internal collection notes.

---

# 139. Payment Gateway Integration

Setup:

```text
/app/setup/integrations
```

New category:

```text
PAYMENT_GATEWAY
```

Provider implementation can be Razorpay/PhonePe/other through adapter.

This spec is provider-agnostic.

---

# 140. Payment Link Entity

```text
PaymentRequest
```

Fields:

- bookingId
- installmentId optional
- amount
- currency
- provider
- providerLinkId
- paymentUrl
- status
- expiresAt
- createdBy
- createdAt
- sharedAt
- paidAt

Status:

```text
CREATED
SENT
OPEN
PAID
EXPIRED
CANCELLED
FAILED
```

---

# 141. Create Payment Link

From:

- Booking Payment Plan
- Collection Dashboard
- Collection Follow-up drawer

Flow:

```text
Select Installment
→ amount defaults to Outstanding
→ optional partial amount if permission/config allows
→ Create Link
→ Copy / WhatsApp / Email
```

Server validates:

```text
amount > 0
amount <= allowed outstanding
```

---

# 142. Gateway Callback

Public webhook:

```text
POST /api/webhooks/payments/:webhookKey
```

Use:

- signature verification;
- idempotency;
- raw event storage.

On confirmed successful payment:

```text
PaymentRequest → PAID
Receipt → created
BookingInstallment → allocated/recalculated
Booking totals → recalculated
Collection timeline → PAYMENT_RECEIVED
```

---

# 143. Manual Payment Receipt

Collections users may record offline payments.

Route/action:

```text
Record Payment
```

Fields:

- Booking
- Installment(s)
- Amount
- Payment Date
- Payment Mode
- Reference / UTR / Cheque No.
- Bank optional
- Proof upload optional
- Note

Payment Mode:

```text
ONLINE
BANK_TRANSFER
CHEQUE
CASH
OTHER
```

Tenant may disable Cash.

---

# 144. Receipt Entity

```text
BookingReceipt
```

Fields:

- bookingId
- receiptNo
- paymentDate
- amount
- mode
- reference
- gatewayPaymentId
- proof
- status
- createdBy
- createdAt
- reversedAt
- reversalReason

Status:

```text
RECORDED
CONFIRMED
REVERSED
```

No deletion.

---

# 145. Receipt Allocation

One Receipt may allocate to one or more installments.

Entity:

```text
ReceiptAllocation
```

Fields:

- receiptId
- installmentId
- amount

Validation:

```text
sum allocations = receipt amount
```

unless tenant supports unallocated advance.

Recommended V2:

Require full allocation to installment(s).

Avoid building a customer credit ledger in this version.

---

# 146. Receipt Reversal

Authorized user may reverse.

Requires:

- reason;
- permission;
- audit.

Reversal recalculates:

- installment received;
- outstanding;
- collection totals;
- CP commission eligibility if collection-based.

Do not delete receipt.

---

# 147. Collection Assignment

Each Booking has:

```text
collectionOwnerUserId
```

May be:

- Sales User
- Collection Executive
- other authorized User

Role name does not matter.

Permission controls behavior.

---

# 148. Collection Assignment Setup

Route:

```text
/app/setup/post-booking/collection-allocation
```

Recommended simple logic:

```text
Project-specific Collection Pool
→ Default Collection Pool
→ Booking Salesperson fallback
→ Unassigned
```

Method:

```text
ROUND_ROBIN
```

Reuse assignment-pool concepts but use a separate pool type.

Do not mix Lead allocation cursor with Collection allocation cursor.

---

# 149. Collection Pool

Fields:

- Pool Name
- Project optional
- Members
- Member Order
- Escalation Users
- Active
- Cursor

Members must have collection permission.

---

# 150. Collection Dashboard — Own Work

Route:

```text
/app/dashboard?view=collections
```

or:

```text
/app/collections
```

Primary work tiles:

```text
Due Today
Overdue
Upcoming 7 Days
Promise To Pay Today
Missed Collection Follow-ups
Payments Received Today
```

Financial snapshot:

```text
My Outstanding
My Due This Month
My Collected This Month
```

---

# 151. Collection Dashboard Tile Definitions

## Due Today

Installments where:

```text
dueDate = today
outstanding > 0
collectionOwner = me
```

## Overdue

```text
dueDate < today
outstanding > 0
```

## Upcoming 7 Days

```text
today < dueDate <= today + 7 days
```

## Promise To Pay Today

Active Promise To Pay date = today and amount outstanding.

## Missed Collection Follow-ups

Pending collection task due time < now.

## Payments Received Today

Receipts today for Bookings assigned to user according to report policy.

---

# 152. Collection Work Queue Row

Show:

```text
Rahul Shah
Green Avenue · A-804

1st Installment
Due: 20 Aug 2026
Due Amount: ₹20,00,000
Outstanding: ₹12,00,000
3 Days Overdue

Last: Call · Promised ₹5L
Next: Call Today 4:30 PM

[ Call ] [ WhatsApp ] [ Payment Link ] [ Open ]
```

---

# 153. Collection Manager Dashboard

Permissions with team/all scope see:

```text
Due Today Amount
Overdue Amount
Upcoming 7 Days
Collected Today
Collected This Month
Promise To Pay Today
Missed PTP
Collection Follow-up Missed
```

Aging:

```text
0–30 Days
31–60 Days
61–90 Days
90+ Days
```

Project summary.

Team summary.

---

# 154. Collection Follow-up

Do not reuse sales Lead Follow-up entity because Booking collection lifecycle is different.

Create:

```text
CollectionFollowUp
```

Fields:

- bookingId
- installmentId optional
- assignedUserId
- actionType
- dueAt
- status
- outcome
- note
- promisedAmount
- promisedDate
- paymentRequestId
- nextFollowUpId
- completedAt

---

# 155. Collection Action Types

Defaults:

```text
Call
WhatsApp
Email
Payment Link
Meeting
Other
```

Dynamic setup is optional.

Recommended:

reuse general action semantic but keep Collection FollowUp records separate.

---

# 156. Collection Outcomes

Defaults:

```text
CONNECTED
NO_ANSWER
CALL_LATER
PROMISE_TO_PAY
PAYMENT_LINK_SENT
PARTIAL_PAYMENT
PAID
DISPUTE
OTHER
```

---

# 157. Collection Follow-up Rule

Same CRM discipline principle:

If outstanding remains:

```text
Complete Current Collection Follow-up
→ set Next Collection Action
```

unless:

- installment becomes Paid;
- Booking Fully Paid;
- authorized Close/No Follow-up state.

---

# 158. Promise To Pay

If outcome:

```text
PROMISE_TO_PAY
```

require:

- Promised Date
- Promised Amount

Entity fields may live on Follow-up or separate PTP record.

Recommended:

```text
CollectionPromise
```

to preserve history.

---

# 159. Collection Promise Entity

Fields:

- bookingId
- installmentId
- promisedAmount
- promisedDate
- createdFromFollowupId
- status
- fulfilledAmount
- fulfilledAt
- missedAt

Status:

```text
OPEN
FULFILLED
PARTIAL
MISSED
CANCELLED
```

---

# 160. Promise to Pay Automation

At end of promised date:

if required amount not received:

```text
Promise → MISSED
```

Notify owner.

Show in:

```text
Missed Promise To Pay
```

manager exception.

---

# 161. Collection Quick Action Drawer

From queue:

```text
What happened?
Outcome
Note

If PTP:
Promised Amount
Promised Date

Optional:
Create / Send Payment Link

Next:
Action Type
Date
Time

[ Save & Next ]
```

If payment fully resolves outstanding:

Next Action not required.

---

# 162. Booking Collection Timeline

Inside Booking Workspace, timeline includes:

- schedule generated;
- installment due;
- reminder sent;
- collection assigned;
- call logged;
- PTP created;
- PTP missed;
- payment link created;
- payment link sent;
- payment received;
- receipt reversed;
- installment paid;
- booking fully paid.

Do not mix with original Lead timeline physically if data model would become confusing.

Booking Workspace may show:

```text
Sales Timeline
Post-Booking Timeline
```

or one unified presentation with source labels.

---

# 163. Customer Payment Reminder Automation

Optional tenant configuration.

Before due:

```text
7 days
3 days
1 day
```

On due:

```text
today
```

After due:

```text
1 day
7 days
```

Templates:

- WhatsApp
- SMS
- Email

Do not send if:

- installment paid;
- Booking cancelled;
- contact/channel opted out where applicable legal policy says marketing consent is relevant.

Operational payment notices may have different consent treatment; implementation should follow provider/legal requirements.

---

# 164. Booking Form + Payment Link Connection

Customer Booking link should show:

```text
Quotation
Payment Plan
KYC
Payment Schedule
Payment Links
```

This is the single customer-facing booking page.

Recommended sections:

```text
1. Booking Summary
2. Applicant Details
3. KYC Documents
4. Quotation
5. Payment Plan
6. Payment Status
```

---

# 165. Quotation Sharing After Booking

The Booking Workspace should continue to show the exact selected Quotation version.

Customer Booking portal may expose:

```text
View Quotation
```

Do not show a superseding later quotation unless Booking is formally amended by authorized process.

---

# 166. Post-Booking Document Section

Booking documents:

- Customer Booking Form PDF/print
- KYC files
- Quotation
- Payment Plan
- Payment receipts
- Payment proofs
- CP invoice references where internal
- Other Booking documents

Visibility:

```text
INTERNAL
CUSTOMER_VISIBLE
```

Partner visibility separate.

---

# 167. Booking Form PDF

After Customer submits:

allow internal generation of a PDF snapshot.

Must include:

- Booking details;
- Applicant data;
- document checklist;
- submission timestamp;
- declaration.

Do not embed full Aadhaar/PAN numbers unmasked unless authorized/legal requirement.

---

# 168. Collection Report

Add:

```text
/app/reports/collections
```

Filters:

- Date
- Project
- Customer
- Collection Owner
- Installment Status
- Due Date
- Aging
- Payment Mode

Metrics:

- Opening Outstanding optional
- Due Amount
- Received Amount
- Outstanding
- Due Today
- Overdue
- Collection %
- PTP Amount
- Missed PTP
- Payment Links Sent
- Payments Received

---

# 169. Booking & KYC Report

Add:

```text
/app/reports/bookings
```

Fields:

- Booking No.
- Customer
- Project
- Unit
- Booking Date
- Booking Value
- Quotation
- Payment Plan
- KYC Status
- Collected
- Outstanding
- Next Due
- Overdue
- Salesperson
- Collection Owner
- CP

---

# 170. Collection Performance Report

Group by Collection Owner:

- Assigned Bookings
- Due Amount
- Received Amount
- Collection %
- Overdue Amount
- Follow-ups Completed
- Missed Follow-ups
- PTP
- PTP Fulfilled %
- Payment Links
- Receipts

Do not compare raw collected amount without project/book size context only; show both amount and percentage.

---

# 171. Management Dashboard Extension

Existing Management Dashboard may add:

```text
POST-BOOKING
Bookings This Month
Booking Value
Collected This Month
Outstanding
Overdue
KYC Pending
KYC Verified

CHANNEL PARTNER
CP Bookings
CP Booking Value
Commission Eligible
CP Invoice Pending

HR
Present Today
Absent Today
Leave Today
```

Keep these below existing Sales / Marketing summary.

Do not make one dashboard overloaded.

Use collapsible sections or navigation tabs.

---

# 172. Reports Hub — Updated

Existing reports remain.

Add domain reports:

```text
SALES
- Leads
- Sales
- Projects
- Campaigns
- Activities

CHANNEL PARTNER
- CP Performance
- CP Invoices

POST-BOOKING
- Bookings & KYC
- Collections
- Collection Performance

HRMS
- Attendance
- Attendance Muster
- Leave
```

---

# 173. Global Search Extension

Existing Global Search should additionally find:

- Booking Number
- CP Company / Partner
- Employee Code
- Employee Name

Exact mobile search can show:

```text
Contact
Lead
Booking
Channel Partner
Employee
```

Results remain permission-scoped.

---

# 174. Booking Search Result

Show:

- Booking No.
- Customer
- Project
- Unit
- KYC Status
- Outstanding
- Collection Owner

Only users with Booking/Collection permission see commercial details.

---

# 175. Channel Partner Search Result

Show:

- Partner Name
- Company/Individual
- RERA Status
- Status

Do not expose bank details in search.

---

# 176. Employee Search Result

Show:

- Employee Code
- Name
- Department
- Designation
- Branch
- Status

Only HRMS permission.

---

# 177. New Setup Navigation

Add:

```text
Setup
├── Existing CRM Setup
│
├── Channel Partner
│   ├── Registration Settings
│   ├── RERA Settings
│   ├── Lead Protection
│   ├── Project Empanelment
│   ├── Commission Rules
│   └── Invoice Approval
│
├── Post-Booking
│   ├── Booking Form Settings
│   ├── KYC Document Types
│   ├── Collection Allocation
│   ├── Collection Outcomes
│   ├── Payment Reminders
│   └── Payment Gateway
│
└── HRMS
    ├── Attendance Policy
    ├── Departments
    ├── Designations
    ├── Jobs
    ├── Branches
    ├── Seating Offices
    ├── Shifts
    ├── Leave Types
    ├── Leave Groups
    ├── Holiday Calendar
    └── Week Off
```

Operational HR screens may also be under HRMS.

---

# 178. New Permissions — Channel Partner

Recommended internal permission keys:

```text
cp.dashboard
cp.registration.view
cp.registration.review
cp.partner.view
cp.partner.create
cp.partner.edit
cp.team.manage
cp.project_empanelment.manage
cp.claim.view
cp.claim.review
cp.commission.view
cp.commission.manage_rules
cp.invoice.view
cp.invoice.review
cp.invoice.mark_paid
cp.report.view
```

Scoped CP permissions may use:

```text
own
team
all
```

where useful.

---

# 179. New Permissions — HRMS

```text
hr.dashboard
hr.employee.view
hr.employee.create
hr.employee.edit
hr.employee.deactivate

hr.department.manage
hr.designation.manage
hr.job.manage
hr.branch.manage
hr.office.manage

hr.shift.view
hr.shift.manage
hr.shift.assign

hr.attendance.view
hr.attendance.edit
hr.attendance.regularize
hr.face_approval.view
hr.face_approval.review

hr.leave.view
hr.leave.request
hr.leave.approve
hr.leave.manage_types
hr.leave.manage_groups
hr.leave.adjust_balance

hr.holiday.manage
hr.weekoff.manage

hr.report.attendance
hr.report.muster
hr.report.leave
```

---

# 180. New Permissions — Booking & Collections

```text
booking.view
booking.edit
booking.customer_link.create

booking.kyc.view
booking.kyc.review
booking.kyc.edit

collection.dashboard
collection.view
collection.assign
collection.followup
collection.payment_link
collection.record_payment
collection.reverse_receipt
collection.report

booking.report
```

Use data scope where applicable:

```text
own
team
all
```

Especially:

```text
collection.view
booking.view
```

---

# 181. Suggested Default New Roles

Do not force; tenants can customize.

Suggested:

```text
Channel Partner Manager
HR Manager
HR Executive
Collection Manager
Collection Executive
Booking Executive
```

Existing Sales User can be granted collection permissions instead.

---

# 182. Employee Link for Permission Roles

HR Role and CRM Role are system User permissions.

Employee Designation is HR structure.

Do not infer permission from Designation automatically unless tenant config explicitly maps them.

---

# 183. Booking Ownership vs Collection Ownership

Keep separate:

```text
booking.salesUserId
booking.collectionOwnerUserId
```

Salesperson gets credit for Booking.

Collection Owner gets collection work.

Never overwrite Salesperson when collection ownership changes.

---

# 184. Channel Partner Ownership vs Sales Ownership

Keep separate:

```text
lead.ownerUserId
lead.channelPartnerId
```

The CP is the referral source/partner.

The internal Sales User is responsible for working the Lead.

---

# 185. Employee / User / Partner Distinction

Do not confuse:

```text
Contact = customer / business contact
User = internal login
Employee = HR record
Channel Partner = external business relationship
PartnerPortalUser = external CP login
BookingApplicant = legal/customer booking applicant
```

One real person could appear in more than one domain, but entities have different business meaning.

---

# 186. Core New State Machines

## CP Registration

```text
DRAFT
→ SUBMITTED
→ UNDER_REVIEW
→ APPROVED

UNDER_REVIEW
→ CORRECTION_REQUIRED
→ SUBMITTED

UNDER_REVIEW
→ REJECTED

APPROVED
→ SUSPENDED / EXPIRED
```

## CP Invoice

```text
DRAFT
→ SUBMITTED
→ UNDER_REVIEW
→ APPROVED
→ PAYMENT_PROCESSING
→ PAID

UNDER_REVIEW
→ CORRECTION_REQUIRED
→ SUBMITTED

UNDER_REVIEW
→ REJECTED
```

## Face Approval

```text
PENDING → APPROVED / REJECTED / CANCELLED
```

## Leave

```text
DRAFT
→ SUBMITTED
→ APPROVED / REJECTED

or

DRAFT
→ SUBMITTED
→ MANAGER_APPROVED
→ APPROVED / REJECTED
```

## KYC

```text
NOT_STARTED
→ PARTIAL
→ SUBMITTED
→ UNDER_REVIEW
→ VERIFIED

UNDER_REVIEW
→ CORRECTION_REQUIRED
→ SUBMITTED
```

## Installment

```text
UPCOMING
→ DUE
→ PARTIAL
→ PAID
```

Overdue is derived.

## Collection Follow-up

```text
PENDING
→ COMPLETED
→ next follow-up if outstanding

PENDING
→ MISSED
→ COMPLETED / RESCHEDULED
```

---

# 187. New Business Events

```text
cp.registration_submitted
cp.registration_approved
cp.registration_rejected
cp.rera_expiring
cp.rera_expired
cp.lead_submitted
cp.claim_conflict
cp.claim_accepted
cp.booking_created
cp.commission_eligible
cp.invoice_submitted
cp.invoice_approved
cp.invoice_paid

hr.employee_created
hr.employee_exited
hr.face_submitted
hr.face_approved
hr.attendance_exception
hr.regularization_submitted
hr.regularization_approved
hr.leave_submitted
hr.leave_approved
hr.leave_rejected

booking.post_initialized
booking.customer_link_created
booking.form_submitted
booking.kyc_submitted
booking.kyc_verified
booking.kyc_correction_required
collection.installment_due
collection.installment_overdue
collection.followup_due
collection.promise_created
collection.promise_missed
collection.payment_link_created
collection.payment_received
collection.receipt_reversed
collection.booking_fully_paid
```

---

# 188. New Background Jobs

```text
cp.rera_expiry
cp.commission_eligibility

hr.attendance_calculate
hr.attendance_missing_punch
hr.leave_accrual

booking.post_initialize_retry
booking.payment_due
booking.payment_reminders

collection.followups_missed
collection.promise_missed
collection.overdue_refresh
```

Every job:

- idempotent;
- observable in Integration/System Health;
- independently retryable.

---

# 189. Timeline Strategy

## Lead Timeline

Sales lifecycle only.

May show high-level:

```text
BOOKING_COMPLETED
```

## Booking Timeline

Post-booking operational detail.

## CP Timeline

Partner registration / compliance / invoice / payout.

## Employee Audit / Attendance Timeline

HR actions.

Do not dump every event into one giant Lead timeline.

---

# 190. Notification Center

Existing global Notification Center should support new domains.

Notification item:

- Domain icon/type
- Title
- Description
- Severity
- Deep link
- Read state

Filters:

```text
Sales
Booking
Collection
Channel Partner
HRMS
System
```

---

# 191. Public Routes — New

Public/no-session:

```text
/booking-form/:token
```

Optional payment-provider hosted link is external.

Gateway webhooks:

```text
/api/webhooks/payments/:webhookKey
```

CP registration public route if enabled:

```text
/cp/register
```

CP Portal itself uses authentication and is not public.

---

# 192. Booking Public Link Rate Limits

Apply rate limiting.

If OTP disabled:

- long unguessable token;
- expiry;
- revoke;
- no indexing;
- sensitive downloads separately signed.

If link expired:

```text
This booking link has expired. Contact your sales representative for a new link.
```

---

# 193. Customer Upload Validation

KYC upload:

- validate MIME;
- validate max bytes;
- safe storage key;
- malware scan where infrastructure supports;
- no executable formats;
- sanitize file names.

---

# 194. CP File Upload Validation

RERA Certificate / Invoice / Cancelled Cheque:

same file safety requirements.

---

# 195. HR File Upload Validation

Face image:

- allowed image MIME only;
- size limit;
- private.

Leave attachment:

- tenant-configured PDF/image.

---

# 196. Audit Requirements — Channel Partner

Audit:

- registration approval/rejection;
- RERA verification;
- team access changes;
- project empanelment;
- CP claim decision;
- commission rule;
- invoice review;
- payout mark.

---

# 197. Audit Requirements — HRMS

Audit:

- Employee changes;
- manager changes;
- attendance correction;
- face approval;
- leave balance adjustment;
- leave approval;
- shift assignment;
- office geofence changes;
- holiday/week-off changes.

---

# 198. Audit Requirements — Collections

Audit:

- collection owner change;
- due-date adjustment;
- payment link creation/cancel;
- manual receipt;
- receipt reversal;
- KYC approval;
- customer form correction;
- payment schedule change.

---

# 199. Post-Booking Commercial Change

A Booking commercial change after sale is high impact.

Do not let normal edit form change:

- Unit
- Booking Value
- Quotation
- Payment Plan

Add dedicated privileged amendment flow later if required.

V2 default:

```text
read-only once booked
```

except correction through Admin-supported process.

---

# 200. Payment Schedule Adjustment

Authorized user may adjust:

- expected milestone date;
- actual due date;
- note.

Do not change installment percentage/amount casually.

Any amount amendment requires high-level permission and audit.

Recommended V2:

No amount amendment UI.

Regenerate only through formal Booking Amendment future feature.

---

# 201. Collection Aging Buckets

Default:

```text
Current / Not Due
1–30 overdue
31–60 overdue
61–90 overdue
90+ overdue
```

Tenant may configure labels later.

---

# 202. Collection Dashboard Priority Sort

Recommended queue priority:

```text
1. Missed PTP
2. Highest days overdue
3. Due today
4. Follow-up overdue
5. Highest outstanding
6. Upcoming
```

Allow sort change.

---

# 203. Smart Collection Risk

Optional assistive label, not AI probability.

Example:

```text
HIGH ATTENTION
```

when:

- 30+ days overdue;
- 2+ missed PTP;
- multiple failed contacts.

Do not call it default risk score if not needed.

---

# 204. CP Top Performer Conversion Definitions

```text
Lead → Visit
= CP accepted leads with completed visit / CP accepted leads

Visit → Booking
= CP bookings / CP accepted leads with completed visit

Lead → Booking
= CP bookings / CP accepted leads
```

Rejected/conflict claims not counted as CP Leads.

---

# 205. CP Booking Value

Use:

```text
Booking.finalPrice
```

not current Unit list price.

---

# 206. CP Commission Reporting

Keep separate:

```text
Accrued
Eligible
Invoiced
Paid
```

Management must not confuse Accrued with currently payable.

---

# 207. HR Dashboard Date Logic

All HR Dashboard cards calculate date in:

```text
tenant timezone
```

not server UTC date.

---

# 208. Attendance Overnight Shift

If Shift crosses midnight:

```text
22:00 → 07:00
```

Attendance belongs to shift start date unless policy specifies otherwise.

Punch grouping must understand overnight.

---

# 209. Attendance Multiple Punches

For default summary:

```text
first IN
last OUT
```

may calculate gross work duration.

If break-level punch processing needed later, keep raw punches for future.

---

# 210. Missing Punch Logic

Examples:

```text
IN exists, no OUT after shift end + grace
→ Missing Punch

OUT exists, no IN
→ Missing Punch
```

Do not mark Absent automatically if valid work evidence exists; policy may classify exception/half-day.

---

# 211. Out-of-Range Exception

Out-of-range does not automatically mean Absent.

Store:

```text
Present + Out Of Range In
```

until approved/rejected according to policy.

This matches dashboard tile design.

---

# 212. Face Approval Does Not Equal Attendance Approval

Face Approval means approved identity reference for face-punch system.

It does not retroactively approve an invalid Attendance Punch unless an Attendance Regularization action also does so.

---

# 213. Leave & Attendance Synchronization

When Leave becomes Approved:

recalculate affected AttendanceDay.

When Leave cancelled:

recalculate.

When Holiday/Week Off changes:

recalculate impacted future/selected dates.

---

# 214. CRM Team and HR Reporting Manager

Current CRM `managerId` and HR Reporting Manager should be kept consistent where possible.

Recommended:

When Employee Reporting Manager changes:

offer:

```text
Also update CRM reporting manager?
```

Do not silently overwrite if user intentionally uses different CRM team structure.

---

# 215. HR Deactivation Workflow

Employee Exit:

```text
Mark Exit
→ show open system work
→ transfer CRM Leads
→ transfer Collection Bookings
→ transfer Approvals
→ deactivate User
```

Do not allow `EXITED` employee's User to remain active accidentally unless explicit override.

---

# 216. Channel Partner Registration Duplicate Detection

Company:

check:

- PAN
- GSTIN
- RERA number
- primary mobile

Individual:

check:

- mobile
- PAN
- RERA number

Do not auto-merge.

Show possible duplicate and require admin review.

---

# 217. CP RERA Renewal

Partner may upload new certificate.

Do not overwrite old certificate.

Create version/history:

```text
ReraDocument
version
effective dates
status
```

Active verified version is current.

---

# 218. CP Suspension

Suspended Partner:

- cannot submit new Leads;
- portal can be limited/read-only;
- historical Leads/Bookings remain;
- invoice/payment access according to tenant policy.

Do not remove historical attribution.

---

# 219. CP Company Member Exit

Inactive member:

- cannot login/submit;
- historical Lead submissions remain under their name;
- company-level reporting still includes them.

---

# 220. Collection Owner Transfer

Action:

```text
Transfer Collection
```

Fields:

- New Owner
- Reason
- Note
- Include pending Collection Follow-ups yes/no default yes

Log timeline.

Sales Lead ownership is unaffected.

---

# 221. Collection Role on Existing Sales User

No dedicated Employee record duplication.

Admin:

```text
Setup → Roles
```

can grant:

```text
collection.dashboard
collection.view = own
collection.followup
collection.payment_link
```

Then assigned Bookings appear automatically on Collection Dashboard.

---

# 222. Collection List Like Leads

User explicitly wants Bookings/Collections to work like Leads.

Recommended:

```text
/app/collections
```

List with work-oriented filters.

Columns:

- Customer
- Project/Unit
- Booking
- Collection Owner
- Next Due
- Due Amount
- Outstanding
- Aging
- Next Collection Action
- PTP
- Payment Status

Click opens Booking Workspace.

---

# 223. Collection Work Queue Tabs

Inside Collections:

```text
Due Today
Overdue
Upcoming
PTP Today
Missed Follow-up
All My Bookings
```

Counts and records use identical filters.

---

# 224. Booking Workspace Quick Actions

Header:

```text
[ Customer Link ]
[ KYC ]
[ Payment Link ]
[ Record Payment ]
[ Collection Follow-up ]
[ Transfer Collection ]
```

Permission-driven.

---

# 225. Booking Workspace Collection Card

```text
COLLECTION

Booking Value          ₹1.42 Cr
Received               ₹32.00 L
Outstanding            ₹1.10 Cr
Next Due               ₹20.00 L · 20 Sep
Overdue                 ₹0

Collection Owner        Priya
Next Action             Call · 18 Sep 11:00
```

---

# 226. Booking Workspace KYC Card

```text
KYC
Status: Correction Required

PAN                  Approved
Aadhaar Front        Resubmit
Cancelled Cheque     Missing

[ Review KYC ]
[ Resend Customer Link ]
```

---

# 227. Booking Workspace CP Card

If CP:

```text
CHANNEL PARTNER
ABC Realty
Claim: Accepted
Commission: ₹2.84 L
Eligible: ₹0
Rule: 2% after 20% collection
```

When threshold met:

```text
Eligible ₹2.84 L
```

---

# 228. Booking Payment Schedule and CP Connection

When receipt changes collection percentage:

trigger:

```text
cp.commission_eligibility
```

This must re-evaluate commission.

If receipt reversed and threshold falls below:

Do not silently revoke an already Paid commission.

Rules:

- if not yet invoiced → may return to NOT_YET_ELIGIBLE;
- if invoice/paid already exists → flag for manual review.

---

# 229. Booking Cancellation Boundary

Current Booking cannot simply be deleted.

If cancellation is added in future:

must reverse:

- inventory;
- payment schedule;
- receipts/finance handling;
- CP commission;
- attribution reporting;
- collection tasks.

Not included unless existing CRM already supports cancellation.

---

# 230. Customer Data Change Rules

Customer may edit Booking Form fields before final submit.

After submit:

internal reviewer can:

```text
Request Correction
```

Customer cannot change commercial fields.

After KYC VERIFIED:

editing core identity fields requires reopening KYC with audit.

---

# 231. Collection Payment Reminder Templates

Add template purposes:

```text
PAYMENT_UPCOMING
PAYMENT_DUE
PAYMENT_OVERDUE
PAYMENT_LINK
KYC_REQUEST
KYC_CORRECTION
BOOKING_FORM_REQUEST
CP_INVOICE
```

Existing messaging infrastructure can send.

---

# 232. Customer Link Messaging Variables

Examples:

```text
{{contact.first_name}}
{{booking.number}}
{{project.name}}
{{unit.number}}
{{booking.customer_form_url}}
{{booking.next_due_date}}
{{booking.next_due_amount}}
{{payment.url}}
{{collection.owner_name}}
```

---

# 233. CP Messaging Variables

```text
{{partner.name}}
{{partner.rera_number}}
{{partner.rera_expiry}}
{{partner.portal_url}}
{{invoice.number}}
{{commission.eligible_amount}}
{{booking.number}}
```

---

# 234. HR Messaging Variables

```text
{{employee.name}}
{{employee.code}}
{{leave.type}}
{{leave.from}}
{{leave.to}}
{{shift.name}}
{{attendance.date}}
```

---

# 235. New Data Model Index — Channel Partner

```text
ChannelPartnerRegistration
ChannelPartner
ChannelPartnerMember
PartnerPortalUser
PartnerReraDocument
PartnerProjectEmpanelment
PartnerLeadClaim
PartnerCommissionRule
PartnerCommissionEntitlement
PartnerInvoice
PartnerInvoiceLine
PartnerPayout
```

---

# 236. New Data Model Index — HRMS

```text
Employee
Department
Designation
Job
Branch
SeatingOffice
Shift
EmployeeShiftAssignment
AttendancePunch
AttendanceDay
AttendanceRegularization
FaceApprovalRequest
LeaveType
LeaveGroup
LeaveGroupEntitlement
EmployeeLeaveGroup
LeaveBalance
LeaveRequest
Holiday
WeekOffPolicy
```

---

# 237. New Data Model Index — Post-Booking

```text
BookingApplicant
BookingCustomerLink
KycDocumentType
BookingKycDocument
BookingInstallment
PaymentRequest
BookingReceipt
ReceiptAllocation
CollectionPool
CollectionFollowUp
CollectionPromise
```

---

# 238. Recommended Indexes — Channel Partner

```text
tenantId + reraNumber
tenantId + pan
tenantId + gstin
tenantId + primaryMobile
tenantId + registrationStatus
tenantId + reraExpiryDate
tenantId + channelPartnerId + projectId
tenantId + partnerLeadClaim status
tenantId + invoice status
```

---

# 239. Recommended Indexes — HRMS

```text
tenantId + employeeCode UNIQUE
tenantId + workEmail
tenantId + userId
tenantId + departmentId
tenantId + branchId
tenantId + seatingOfficeId
tenantId + employeeId + attendanceDate UNIQUE
tenantId + employeeId + punchTimestamp
tenantId + leaveStatus
tenantId + holidayDate
```

---

# 240. Recommended Indexes — Collections

```text
tenantId + bookingId
tenantId + collectionOwnerUserId
tenantId + expectedDueDate
tenantId + installmentStatus
tenantId + bookingId + sequence UNIQUE
tenantId + paymentRequest providerLinkId
tenantId + receiptNo
tenantId + collectionFollowUp dueAt
tenantId + promiseDate + status
```

---

# 241. Dashboard Performance

Dashboard counts must query indexed summary fields.

Do not scan:

- all punches;
- all receipts;
- all leads

for each card request.

Use:

- AttendanceDay;
- BookingInstallment;
- denormalized Booking collection totals;
- Partner summary queries.

---

# 242. Booking Collection Denormalized Totals

Recommended Booking fields:

```text
totalReceived
totalOutstanding
nextDueAt
nextDueAmount
overdueAmount
overdueDaysMax
paymentProgressPercentage
collectionOwnerUserId
kycStatus
```

Keep synchronized by collection service.

This makes Booking list and dashboard fast.

---

# 243. CP Summary Fields

Optional ChannelPartner counters:

```text
leadCount
visitCount
bookingCount
bookingValue
eligibleCommission
invoicedCommission
paidCommission
```

Either denormalize safely or calculate/report through aggregation.

Do not use counters as source of truth for money without reconciliation.

---

# 244. HR Dashboard Summary

Use AttendanceDay as source.

Do not derive present/absent from raw punches at page render.

---

# 245. Error UX — CP

Examples:

```text
This RERA number is already registered with another Channel Partner.
```

```text
This customer already has an active claim from another Channel Partner. The submission has been sent for review.
```

```text
No eligible commission is available for this invoice.
```

---

# 246. Error UX — HRMS

```text
This Employee still owns active CRM work. Transfer it before deactivating the User.
```

```text
This Leave Request overlaps an approved Leave.
```

```text
The selected Shift is inactive.
```

---

# 247. Error UX — Booking/Collections

```text
This Booking already has a customer form submission under review.
```

```text
The payment link amount is higher than the selected outstanding amount.
```

```text
This Receipt cannot be deleted. Reverse it with a reason instead.
```

---

# 248. Empty States — CP

```text
No Channel Partners registered yet.
[ Add Channel Partner ]
```

```text
No eligible commission yet.
Commission becomes available when configured booking/collection conditions are met.
```

---

# 249. Empty States — HR

```text
No Attendance recorded for this date.
```

```text
No pending Face Approval requests.
```

---

# 250. Empty States — Collections

```text
No payments due today.
```

```text
No overdue collections assigned to you.
```

---

# 251. Mobile Responsiveness — CP Portal

Partner Portal must work well on mobile.

Core mobile actions:

- submit Lead;
- view Lead;
- view Visit;
- view Booking;
- upload RERA;
- create/upload Invoice;
- view commission.

---

# 252. Mobile Responsiveness — Collections

Collection Executive commonly works on phone.

Core:

- work queue;
- call;
- WhatsApp;
- PTP;
- payment link;
- record payment;
- open Booking.

---

# 253. Mobile Responsiveness — HR

Employee self-service:

- view attendance;
- submit regularization;
- submit leave;
- upload face request.

Admin HR setup can remain desktop-first.

---

# 254. Suggested API — Channel Partner

```text
GET  /api/channel-partners
POST /api/channel-partners/registrations
GET  /api/channel-partners/registrations/:id
POST /api/channel-partners/registrations/:id/review

POST /api/channel-partners/:id/team
POST /api/channel-partners/:id/empanelments

POST /api/channel-partner-claims/:id/review

GET  /api/channel-partners/:id/performance

POST /api/channel-partners/invoices
POST /api/channel-partners/invoices/:id/submit
POST /api/channel-partners/invoices/:id/review
POST /api/channel-partners/invoices/:id/payment
```

Follow existing app route conventions where codebase prefers form POST rather than REST PATCH.

---

# 255. Suggested CP Portal API/Actions

```text
POST /cp/leads
POST /cp/team
POST /cp/invoices
POST /cp/invoices/:id/submit
POST /cp/profile/rera
```

Every call derives Channel Partner identity from portal session.

---

# 256. Suggested API — HRMS

```text
POST /api/hrms/employees
POST /api/hrms/employees/:id

POST /api/hrms/departments
POST /api/hrms/designations
POST /api/hrms/jobs
POST /api/hrms/branches
POST /api/hrms/offices

POST /api/hrms/shifts
POST /api/hrms/shift-assignments

POST /api/hrms/punches
POST /api/hrms/attendance/regularization
POST /api/hrms/attendance/regularization/:id/review

POST /api/hrms/face-approvals
POST /api/hrms/face-approvals/:id/review

POST /api/hrms/leave/requests
POST /api/hrms/leave/requests/:id/review
POST /api/hrms/leave/balances/:employeeId/adjust
```

---

# 257. Suggested API — Booking/KYC

```text
GET  /api/bookings/:id
POST /api/bookings/:id/customer-link
POST /api/bookings/:id/customer-link/revoke

POST /api/bookings/:id/kyc/review

GET  /booking-form/:token
POST /booking-form/:token
POST /booking-form/:token/kyc
```

---

# 258. Suggested API — Collections

```text
GET  /api/collections
POST /api/bookings/:id/collection-owner

POST /api/bookings/:id/collection-followups
POST /api/collection-followups/:id/complete

POST /api/bookings/:id/payment-links
POST /api/bookings/:id/receipts
POST /api/receipts/:id/reverse
```

---

# 259. Public Payment Callback

```text
POST /api/webhooks/payments/:webhookKey
```

Must use provider idempotency and signature verification.

---

# 260. Reports API

Extend:

```text
GET /app/reports/channel-partners
GET /app/reports/cp-invoices
GET /app/reports/bookings
GET /app/reports/collections
GET /app/reports/collection-performance

GET /app/hrms/reports/attendance
GET /app/hrms/reports/attendance-muster
GET /app/hrms/reports/leave
```

Exports must use same filters and permissions as on-screen report.

---

# 261. Setup API — CP

```text
POST /api/setup/cp/settings
POST /api/setup/cp/commission-rules
POST /api/setup/cp/commission-rules/:id/toggle
```

---

# 262. Setup API — HR

```text
POST /api/setup/hr/attendance-policy
POST /api/setup/hr/leave-types
POST /api/setup/hr/leave-groups
POST /api/setup/hr/holidays
POST /api/setup/hr/weekoffs
```

---

# 263. Setup API — Post Booking

```text
POST /api/setup/post-booking/settings
POST /api/setup/post-booking/kyc-types
POST /api/setup/post-booking/collection-pools
POST /api/setup/post-booking/reminders
```

---

# 264. New Tenant Settings

Suggested:

```text
cpPublicRegistrationEnabled
cpRequireRera
cpRequireVerifiedReraForActivation
cpRequireValidReraForLeadSubmission
cpReraExpiryReminderDays
cpLeadProtectionDays
cpClaimConflictMode
cpRequireProjectEmpanelment

bookingLinkExpiryDays
bookingLinkRequireOtp

collectionReminderEnabled
collectionAllowPartialPaymentLink

attendancePolicyId
leaveApprovalMode
```

---

# 265. Project-Level New Settings

Possible:

```text
channelPartnerEnabled
channelPartnerCommissionRuleId
cpLeadProtectionDaysOverride

collectionPoolId
bookingKycProfileId
paymentReminderProfileId
```

---

# 266. Booking Initialization — Exact Order

After Booking is successfully committed:

```text
1. Do not alter Lead Booking result.
2. Create/find post-booking initialization marker.
3. Snapshot Payment Plan from Booking/Quotation.
4. Create BookingInstallment rows.
5. Resolve Collection Owner.
6. Set KYC = NOT_STARTED.
7. Set postBookingStatus.
8. Create Booking timeline event.
9. Evaluate CP commission entitlement.
10. Notify collection/booking owner.
```

All steps idempotent.

---

# 267. Payment Schedule Rounding

For percentage plans:

```text
scheduled amounts sum exactly to final plan basis
```

Use integer minor units.

Any rounding remainder goes to final installment.

---

# 268. Due Date Change

Construction milestone may change.

Authorized action:

```text
Update Due Date
```

Fields:

- new due date
- reason
- note

Notify:

- Collection Owner
- Customer if reminder already sent and policy permits.

Audit before/after.

---

# 269. Customer Payment Visibility

Customer portal must show:

```text
Paid
Outstanding
Next Due
```

Do not show:

- internal aging category;
- internal PTP;
- collection notes;
- CP commission;
- sales commission.

---

# 270. Internal Collection Notes

Collection note is internal.

Customer-facing message is sent explicitly via Messaging action.

Do not automatically expose notes to customer link.

---

# 271. CP Portal Booking Visibility

Partner may see:

- Customer name
- Project
- Unit/configuration according to policy
- Booking Date
- Booking status
- Commission status

Do not show customer KYC or collection notes.

Partner may need Collection % only if commission rule depends on it.

Recommended display:

```text
Commission eligibility progress: 16% collected / 20% required
```

without exposing detailed receipt history unless tenant chooses.

---

# 272. CP Invoice Tax Data

The CRM stores invoice values supplied/reviewed.

It does not calculate statutory tax filing obligations.

Any TDS/GST presentation is informational unless finance integration is added.

---

# 273. HR Data Privacy

Employee personal data permissions must be narrower than generic CRM User view.

Examples:

Sales Manager may see:

- Employee name
- work role
- attendance team summary if permission

but not necessarily:

- personal address
- DOB
- private leave attachment
- face image.

---

# 274. Employee Document Expansion

Optional Employee documents:

- Profile Photo
- ID Proof
- Joining Letter
- Other HR documents

No payroll documents in V2 unless later required.

---

# 275. HR Report Scope

`own`:

Employee sees only self.

`team`:

Manager sees reporting Employees.

`all`:

HR sees organization.

Scope resolved from Employee reporting hierarchy.

---

# 276. Collection Report Scope

`own`:

Booking collectionOwner = user.

`team`:

collection owner linked Users reporting to manager.

`all`:

organization.

Do not use Lead owner for collection scope.

---

# 277. CP Report Scope

CP Manager internal users:

scope based on permission.

External CP:

hard-scoped to their Partner entity / company.

---

# 278. New Default Dashboard Behavior by Role

## Sales User

Sales Dashboard remains default.

## Collection Executive Only

Collection Dashboard default.

## HR User Only

HRMS Dashboard default.

## Multi-role User

Remember last Dashboard view or show allowed tabs.

## Management

Management Dashboard.

---

# 279. Dashboard Tile Counts Must Match Lists

Same invariant as Sales Dashboard:

```text
card count query == drilldown list query
```

Applies to HRMS and Collections.

No mismatched totals.

---

# 280. Collection KPIs Definitions

## Outstanding

```text
sum scheduled amount - confirmed receipts
```

for active Bookings.

## Due Today

Outstanding on installments due today.

## Overdue

Outstanding on installments with due date before today.

## Collection %

```text
total confirmed received / final booking value
```

or plan collectible basis.

Use one declared denominator consistently.

---

# 281. KYC Completion %

Optional:

```text
approved mandatory docs / total mandatory docs
```

Display only if useful.

Overall status remains primary.

---

# 282. HR Present Count Definition

Use unique Employees.

Do not count multiple punches.

---

# 283. HR Late In Count

Unique Employees with `lateIn=true`.

Not number of late punches.

---

# 284. CP Leads Submitted Metric

Count accepted Partner Lead Claims / CP-attributed Lead submissions.

Do not include rejected conflicts.

---

# 285. CP Site Visit Metric

Unique completed Site Visits linked to accepted CP attribution.

---

# 286. CP Booking Metric

Bookings with frozen accepted `channelPartnerId`.

---

# 287. CP Invoice Pending

Statuses:

```text
SUBMITTED
UNDER_REVIEW
CORRECTION_REQUIRED
APPROVED
PAYMENT_PROCESSING
```

Dashboard may separate:

```text
Pending Review
Pending Payout
```

---

# 288. Booking Form Send Flow

Inside Booking Workspace:

```text
Customer Form
Status: Not Sent

[ Generate Link ]
```

Then:

```text
Link Active until 27 Aug 2026
[ Copy ] [ WhatsApp ] [ Email ] [ Revoke ]
```

Once Submitted:

```text
Submitted 21 Aug 2026 10:35 AM
[ Review ]
```

---

# 289. Booking Form Reopen

If customer submitted but correction required:

authorized user:

```text
Request Correction
```

This reopens only selected editable sections/documents.

Do not discard existing approved data.

---

# 290. KYC Checklist UI

```text
Primary Applicant

✓ PAN
● Aadhaar Front — Under Review
✕ Aadhaar Back — Missing
✓ Photo

Co-applicant 1
...
```

Click item to review.

---

# 291. Payment Link Status UI

```text
₹20,00,000
Sent 20 Aug · WhatsApp
Opened 20 Aug · 6:12 PM
Status: OPEN
Expires 23 Aug
```

If provider doesn't support open tracking, do not invent.

---

# 292. Collection Follow-up History

Each call/message row:

- action
- outcome
- note
- promise if any
- payment link
- user
- timestamp
- next action

---

# 293. Booking Collection Assignment on Booking Create

Recommended:

```text
Project Collection Pool exists?
  Yes → round robin Collection User
  No  → Salesperson if they hold collection.followup
        else Default Collection Pool
        else Unassigned
```

Config may choose pool before salesperson fallback.

Document chosen tenant behavior.

---

# 294. Unassigned Collections

Collection Manager dashboard:

```text
Unassigned Bookings
```

Critical exception.

Booking remains valid.

---

# 295. Collections SLA

Do not introduce complex Collection SLA in V2 unless needed.

Use:

- due dates;
- overdue days;
- follow-up due time;
- PTP dates.

This is sufficient.

---

# 296. Booking Customer Communications

Booking communication timeline may include:

- customer form sent;
- KYC correction sent;
- payment reminder;
- payment link;
- receipt acknowledgement.

Use existing messaging infrastructure where possible.

---

# 297. Receipt Acknowledgement

Optional template after confirmed payment:

```text
Payment received
Amount
Date
Booking
Remaining Outstanding
```

Do not call it a tax receipt unless legally generated by finance system.

Label:

```text
Payment Acknowledgement
```

unless configured otherwise.

---

# 298. CP Invoice PDF Storage

Internal/private.

Partner may download own invoices.

Other CPs never see.

---

# 299. HR Attendance Manual Edit

Do not allow direct overwrite of AttendanceDay for normal users.

Use Regularization.

Admin correction may be a dedicated audited action.

---

# 300. HR Absence Correction

If absent due to missing punch:

Regularization approval recalculates Present/Half Day.

Dashboard counts update.

---

# 301. Employee Week Off Changes

Future dates use new policy.

Historical AttendanceDays should not silently rewrite after policy edit unless HR explicitly requests recalculation.

Store resolved policy references where practical.

---

# 302. Leave Balance Year Boundary

Leave balance entity keyed by:

```text
employeeId
leaveTypeId
leaveYear
```

Carry forward process creates next year's opening.

Do not mutate previous year final values.

---

# 303. Leave Group Change Mid-Year

When Employee changes Leave Group:

tenant policy:

```text
PRORATE
APPLY_FROM_DATE
MANUAL
```

V2 recommended:

```text
APPLY_FROM_DATE
```

and HR reviews balances.

Avoid hidden automatic destructive recalculation.

---

# 304. Shift Change Mid-Day

Do not allow normal shift reassignment after punches exist without explicit effective date and warning.

---

# 305. Seating Office Change

Changing Employee office affects future punches by effective assignment.

Do not retroactively mark old punches out-of-range.

Use effective dates if practical.

---

# 306. CP Commission Rule Change

New rule applies to Bookings after effective date.

Existing Booking stores commission rule snapshot.

Do not retroactively recalculate paid entitlement.

---

# 307. CP Project Empanelment Expiry

After expiry:

- new Partner Lead submission disabled for Project;
- existing Leads/Bookings remain;
- invoices/commission continue according to historical agreement.

---

# 308. CP Registration Approval → Portal Invite

On approval:

internal reviewer may:

```text
Approve & Invite Partner
```

Create Partner Portal Company Admin / Individual user.

Send activation link through configured message/email.

---

# 309. Partner Portal Lead Acknowledgement

After CP submits:

show:

```text
Lead submitted successfully.
Reference: CPL-2026-00124
Status: Accepted / Under Review
```

Do not promise attribution if conflict review pending.

---

# 310. CP Lead Submission Status

Portal status:

```text
ACCEPTED
UNDER_REVIEW
CONFLICT
REJECTED
```

If accepted, display CRM Lead stage separately.

---

# 311. Channel Partner Team Performance

Company dashboard table:

| Member | Leads | Visits | Bookings | Booking Value |
|---|---:|---:|---:|---:|

Only company data.

---

# 312. Channel Partner Project Performance

| Project | Leads | Visits | Bookings | Value | Commission |
|---|---:|---:|---:|---:|---:|

---

# 313. CP Invoice Eligibility UI

```text
ELIGIBLE COMMISSION

Green Avenue · BKG-GA-0012
Customer: Rahul Shah
Booking Value: ₹1.42 Cr
Collected: 25%
Rule: 2% after 20%
Eligible: ₹2.84 L

[ Add to Invoice ]
```

---

# 314. CP Invoice Multiple Bookings

Allow one Invoice to include multiple eligible lines.

All lines must:

- belong to same Partner;
- be eligible;
- not over-invoiced.

---

# 315. CP Invoice Correction

If internal requests correction:

Partner can:

- edit invoice number/date if policy allows;
- upload new invoice PDF;
- adjust line claim within eligible amount.

Preserve previous submitted version/audit.

---

# 316. HRMS Dashboard Visual Reference Rules

Use user's supplied visual style:

- white background;
- thin neutral borders;
- rounded rectangular cards;
- title upper-left;
- large numeric count below;
- circular light icon area on right;
- 4 cards per row on wide desktop;
- minimal text;
- large whitespace;
- cards are clickable;
- no heavy color fill.

Responsive:

```text
Desktop: 4 columns
Tablet: 2 columns
Mobile: 1 column
```

---

# 317. HRMS Dashboard Example

```text
Present                     327
Absent                      143
Late In                       4
Early Out                      0

Out Of Range Punch In          3
Out Of Range Punch Out         0
Missing Punch                  3
Face Approval                  1

Today's Leave Requests         0
```

Numbers are live data, not hard-coded.

---

# 318. Collections Dashboard Visual Style

Use same CRM design language.

Primary cards should show both count and amount where useful.

Example:

```text
Overdue
12 Bookings
₹46.20 L
```

Do not make every card contain many statistics.

---

# 319. CP Dashboard Visual Style

Use summary cards + funnel + top performer table.

Avoid excessive charts.

One simple trend chart may be added if existing design supports, but not required.

---

# 320. Booking Workspace Responsive Priority

Mobile order:

```text
Booking Summary
Next Due / Collection
KYC
Payment Plan
Quick Actions
Timeline
```

Desktop can use context sidebar.

---

# 321. Reports Download

Audit exports containing:

- customer KYC status;
- employee attendance;
- CP bank/invoice data;
- collection amounts.

Permissions required.

KYC documents themselves must never be included in generic CSV export.

---

# 322. Search Data Privacy

Exact mobile Global Search must not leak:

- Employee private HR data;
- CP bank;
- KYC;
- collection details

unless user has domain permission.

---

# 323. AI Extension — Optional Future-Safe

Do not make V2 depend on AI.

Possible read-only later:

```text
Collection Summary
Booking KYC Missing Document Summary
CP Performance Summary
Attendance Exception Summary
```

No AI approvals/payments/HR decisions.

---

# 324. Non-Negotiable New Rules

1. Successful Booking is never undone by post-booking initialization failure.
2. Customer Booking Form cannot edit commercial Booking fields.
3. Historical Quotation/Payment Plan is snapshotted.
4. KYC documents are private.
5. Payment receipt is reversed, never deleted.
6. Collection ownership never changes original Sales credit.
7. CP association never changes internal Lead owner.
8. CP claim conflict never silently overwrites an existing CP/source.
9. CP commission is based on frozen Booking/rule data.
10. CP Invoice cannot exceed eligible uninvoiced commission.
11. RERA history is versioned, not overwritten.
12. Employee is distinct from User.
13. Employee exit cannot silently orphan CRM/Collection work.
14. Raw Attendance Punch is never deleted by Regularization.
15. Attendance exception flags are separate from primary Present/Absent status.
16. Leave approval updates Attendance.
17. Dashboard count and drilldown must use same filters.
18. Collection completed work must keep a next action while outstanding remains.
19. Promise To Pay is tracked and can become Missed.
20. Tenant isolation applies to every new entity.

---

# 325. Build Order

## Phase 1 — Booking Foundation

1. Booking Workspace
2. Booking List
3. Post-booking initialization
4. Payment Plan snapshot → BookingInstallments
5. Collection owner
6. Collection Dashboard
7. Collection Follow-up

## Phase 2 — Customer & Payments

8. Customer Booking Form
9. Secure customer link
10. KYC types/upload/review
11. Payment links
12. Receipts
13. Payment reminders
14. Booking/Collection reports

## Phase 3 — Channel Partner

15. CP registration
16. GujRERA
17. CP company/team
18. Project empanelment
19. CP Lead submission/claim
20. CP dashboards
21. Commission rules
22. Commission entitlement
23. CP Invoice/payout
24. CP reports

## Phase 4 — HRMS Foundation

25. Employee
26. Department/Designation/Job
27. Branch/Seating Office
28. Shift
29. User/Employee connection

## Phase 5 — HR Operations

30. Punches
31. AttendanceDay
32. HR Dashboard
33. Face Approval
34. Regularization
35. Leave
36. Holiday
37. Week Off
38. Attendance/Muster reports

---

# 326. Acceptance Criteria — Channel Partner Registration

- [ ] Company and Individual types exist.
- [ ] Registration list exists.
- [ ] Stepper exists.
- [ ] GujRERA number and certificate supported.
- [ ] Certificate expiry tracked.
- [ ] Approval workflow works.
- [ ] Duplicate checks work.
- [ ] Company Team can be managed.
- [ ] Portal invite can be created after approval.
- [ ] RERA history is retained.

---

# 327. Acceptance Criteria — CP Lead Flow

- [ ] Partner can submit Lead.
- [ ] Existing CRM capture/dedup is reused.
- [ ] CP identity is server-derived.
- [ ] Same CP re-inquiry does not duplicate Contact.
- [ ] Conflicting CP claim does not overwrite attribution.
- [ ] Internal claim review works.
- [ ] Normal Lead allocation/SLA still works.
- [ ] CP sees only safe partner-visible Lead data.

---

# 328. Acceptance Criteria — CP Dashboard

- [ ] Internal dashboard has registration + performance + commission cards.
- [ ] Company dashboard shows company metrics.
- [ ] Individual dashboard shows own metrics.
- [ ] Top performer can rank by Bookings/Value/Leads/Visits.
- [ ] Metrics drill down to records.
- [ ] Date/project filters work.

---

# 329. Acceptance Criteria — CP Invoice

- [ ] Commission rule configured.
- [ ] Booking creates commission entitlement.
- [ ] Collection threshold can unlock entitlement.
- [ ] Partner can invoice only eligible amount.
- [ ] Invoice PDF upload works.
- [ ] Review status flow works.
- [ ] Payout reference can be recorded.
- [ ] Double invoicing prevented.
- [ ] Reports show Accrued/Eligible/Invoiced/Paid.

---

# 330. Acceptance Criteria — Employee

- [ ] Employee table exists.
- [ ] Employee Code unique.
- [ ] Department, Designation, Job, Branch, Office link.
- [ ] Reporting Manager link.
- [ ] Shift link.
- [ ] User link optional.
- [ ] Exit cannot orphan work.

---

# 331. Acceptance Criteria — HR Dashboard

- [ ] Present tile works.
- [ ] Absent tile works.
- [ ] Late In works.
- [ ] Early Out works.
- [ ] Out Of Range Punch In works.
- [ ] Out Of Range Punch Out works.
- [ ] Missing Punch works.
- [ ] Face Approval works.
- [ ] Today's Leave Requests works.
- [ ] Each count matches drilldown.
- [ ] Reference visual layout is followed.

---

# 332. Acceptance Criteria — Attendance

- [ ] Raw Punch stored.
- [ ] Daily Attendance summary calculated.
- [ ] Shift grace applied.
- [ ] Overnight Shift supported.
- [ ] Missing Punch identified.
- [ ] Out-of-range server calculated.
- [ ] Late/Early flags work.
- [ ] Regularization preserves original Punch.
- [ ] Approved Leave/Holiday/Week Off affect Attendance correctly.

---

# 333. Acceptance Criteria — Leave

- [ ] Leave Types.
- [ ] Leave Groups.
- [ ] Bulk Leave Group assignment.
- [ ] Employee-wise Balance.
- [ ] Leave Request.
- [ ] Approval.
- [ ] Overlap validation.
- [ ] Balance validation.
- [ ] Attendance sync.
- [ ] Leave report.

---

# 334. Acceptance Criteria — Booking Workspace

- [ ] Automatically initializes after Booking.
- [ ] Shows selected Quotation.
- [ ] Shows selected Payment Plan.
- [ ] Shows Customer/KYC.
- [ ] Shows Payment Schedule.
- [ ] Shows Collection owner.
- [ ] Shows CP if applicable.
- [ ] Does not modify original Booking transaction.

---

# 335. Acceptance Criteria — Customer Booking Form

- [ ] Link can be generated.
- [ ] Link can expire/revoke.
- [ ] Customer can review prefilled details.
- [ ] Commercial fields read-only.
- [ ] Primary Applicant supported.
- [ ] Co-applicant supported.
- [ ] KYC upload supported.
- [ ] Submit/declaration captured.
- [ ] Correction flow supported.
- [ ] Secure storage.

---

# 336. Acceptance Criteria — Payment Plan

- [ ] Booking schedule created from frozen Quotation/Plan.
- [ ] Percentages/amounts sum correctly.
- [ ] Expected due dates generated where rules allow.
- [ ] Unknown construction dates show TBD.
- [ ] Historical schedule does not change when Project plan changes.

---

# 337. Acceptance Criteria — Collections

- [ ] Collection owner exists.
- [ ] Own dashboard works.
- [ ] Due Today.
- [ ] Overdue.
- [ ] Upcoming 7 Days.
- [ ] PTP Today.
- [ ] Missed Follow-ups.
- [ ] Received Today.
- [ ] Booking list works like Lead list.
- [ ] Collection Follow-up has next-action discipline.
- [ ] PTP tracked.
- [ ] Transfer Collection works.
- [ ] Reports work.

---

# 338. Acceptance Criteria — Payment Links & Receipts

- [ ] Payment Link generated against Booking/Installment.
- [ ] Amount validated.
- [ ] Gateway callback idempotent.
- [ ] Receipt created.
- [ ] Installment updated.
- [ ] Manual Receipt works.
- [ ] Receipt allocations equal Receipt amount.
- [ ] Receipt reversal works.
- [ ] Receipt cannot be deleted.
- [ ] Collection totals recalculate.

---

# 339. Tests — CP

Add automated tests:

```text
company registration
individual registration
duplicate RERA
RERA expiry
approval
member permissions
project empanelment
CP lead new
CP lead duplicate/re-inquiry
claim conflict
claim acceptance
booking attribution
commission eligibility at booking
commission eligibility after collection threshold
invoice overclaim rejected
invoice double claim rejected
payout
```

---

# 340. Tests — HRMS

```text
employee create
duplicate employee code
user link
shift overnight
late in
early out
missing in
missing out
out-of-range
holiday
week off
approved leave
regularization
face approval
leave balance
leave overlap
bulk leave group assignment
employee exit with open CRM work
```

---

# 341. Tests — Booking/KYC

```text
post-booking init idempotent
quotation snapshot
payment plan snapshot
installment rounding
customer link expiry
customer link revoke
KYC upload
KYC correction
KYC verification
commercial field cannot be changed publicly
```

---

# 342. Tests — Collections

```text
collection owner assignment
due today
overdue
payment link amount validation
duplicate gateway callback
receipt allocation
receipt reversal
PTP
missed PTP
collection follow-up requires next action
fully paid removes next-action requirement
collection threshold unlocks CP commission
```

---

# 343. Regression Tests

Existing CRM must continue to pass:

- Lead duplicate;
- Re-inquiry;
- Round Robin;
- SLA;
- Follow-up next action;
- Stage funnel;
- Site Visit;
- Quotation;
- Discount approval;
- Block;
- Block expiry;
- Booking;
- Attribution;
- Sales Reports;
- Campaigns;
- Global Search;
- tenant isolation.

---

# 344. Claude / Coding Agent Instructions

When implementing this file:

1. Read existing `CRM-GUIDE.md`, `FUNCTIONALITY.md`, V1 Master and V1.1 enhancement first.
2. Assume existing CRM is functional.
3. Do not rewrite stable Lead/Project/Inventory/Quotation/Block/Booking services unnecessarily.
4. Start post-booking from successful existing `booking.created`.
5. Post-booking initialization must be idempotent.
6. Booking remains valid even if post-booking initialization temporarily fails.
7. Use Booking/Quotation snapshots; never use mutable live Project pricing for historical collections.
8. Keep CP, internal Sales ownership, Marketing source and Customer Contact as separate concepts.
9. CP lead conflict must create review, not overwrite.
10. Build CP registration as Company/Individual stepper.
11. Store GujRERA certificate privately and version renewals.
12. Create CP Commission entitlement before Invoice.
13. Connect commission eligibility to Collections when rule requires.
14. Do not build full accounting for CP payout.
15. Keep Employee separate from User.
16. Employee exit must transfer open CRM/Collection work.
17. Use user's HR Dashboard card layout.
18. Attendance uses raw immutable Punch + calculated Daily Summary.
19. Do not delete raw Punch when regularizing.
20. Out-of-range is an exception flag, not automatically absence.
21. Leave/Holiday/Week Off must feed Attendance calculation.
22. Build secure Booking Customer link.
23. KYC files must not live in public upload storage.
24. Customer cannot edit commercial Booking fields.
25. Payment Schedule comes from frozen selected Quotation Payment Plan.
26. Create PaymentRequest and Receipt; do not treat payment-link creation as payment.
27. Gateway callback must be signed/idempotent.
28. Receipt reversal, never delete.
29. Collections must work like CRM work queues: own work, exact tiles, quick actions, next action.
30. Collection ownership is independent of Sales ownership.
31. Add new report domains but preserve existing Sales report definitions.
32. Add setup screens only where rules genuinely need configuration.
33. Do not connect this CRM to ROS.
34. Preserve tenant isolation on every query.
35. Add permissions and tests before exposing sensitive KYC, HR, bank or payment data.

---

# 345. Final Connected Journey — Direct Customer

```text
LEAD
↓
FOLLOW-UP
↓
SITE VISIT
↓
QUOTATION + PAYMENT PLAN
↓
BLOCK
↓
BOOKED
↓
BOOKING WORKSPACE CREATED
├── Customer Form Link
├── KYC Upload
├── Frozen Quotation
├── Payment Schedule
└── Collection Owner
        ↓
INSTALLMENT DUE
        ↓
COLLECTION FOLLOW-UP
├── Call
├── WhatsApp
├── Promise To Pay
└── Payment Link
        ↓
PAYMENT RECEIVED
        ↓
RECEIPT
        ↓
INSTALLMENT PAID
        ↓
FULLY PAID
```

---

# 346. Final Connected Journey — Channel Partner Customer

```text
CP REGISTRATION
↓
GujRERA VERIFIED
↓
PROJECT EMPANELMENT
↓
CP SUBMITS LEAD
↓
PARTNER CLAIM ACCEPTED
↓
NORMAL CRM SALES FLOW
↓
BOOKING
├── Salesperson credit retained
├── CP attribution frozen
└── Commission Entitlement created
        ↓
COLLECTION THRESHOLD if configured
        ↓
COMMISSION ELIGIBLE
        ↓
CP INVOICE
        ↓
APPROVAL
        ↓
PAYOUT TRACKED
```

---

# 347. Final Connected Journey — Employee

```text
EMPLOYEE
↓
Department + Designation + Job
↓
Branch + Seating Office
↓
Shift
↓
Punch In / Out
↓
Attendance Day
├── Present / Absent
├── Late / Early
├── Out of Range
└── Missing Punch
        ↓
Regularization if required

Employee
↓
Leave Group
↓
Leave Balance
↓
Leave Request
↓
Approval
↓
Attendance recalculated
```

---

# 348. Product Standard

The expanded CRM must still feel simple.

The system is now larger, but users should see only their work.

A Sales User should not feel HRMS complexity.

A Collection User should open and immediately see:

```text
Who must I call for payment today?
```

An HR User should immediately see:

```text
Who is present, absent or needs approval?
```

A Channel Partner Manager should immediately see:

```text
Which partners are active and producing bookings?
```

A Channel Partner should immediately see:

```text
What did my leads convert into and what commission can I invoice?
```

A Booking Executive should immediately see:

```text
Which customers have not completed form/KYC?
```

The product succeeds when the modules are connected in data but **focused in user experience**.

---

# 349. Final Rule

For every new feature, ask:

```text
Does this remove manual tracking?
Does it clarify ownership?
Does it connect an existing record rather than duplicate it?
Does it show what the user must do next?
```

If not, simplify it before development.
