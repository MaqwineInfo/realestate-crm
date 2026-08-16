# Real Estate CRM V1.1 — Connected Flow, Form Clarity & UX Enhancement Specification

**Document Type:** Implementation Override / Enhancement Specification  
**Version:** 1.1  
**Product:** Multi-tenant Real Estate Sales CRM  
**Use With:** Current `CRM-GUIDE.md`, `FUNCTIONALITY.md`, and existing V1 codebase  
**Override Rule:** Where this document conflicts with an older UI/form/flow description, **this document wins**. Stable backend safety rules remain unless explicitly changed here.

---

# 1. Purpose

The current CRM is fundamentally strong. Do **not** redesign it from scratch.

This document fixes the missing clarity and connection points in the current implementation:

1. Full real-estate Lead Creation form.
2. Project Creation as a guided stepper.
3. Project images and document attachments.
4. Generate Quotation directly from a Lead with Payment Plan.
5. Unit picker for Block Unit.
6. Clear Mark Booked action from Lead Workspace.
7. Integration Setup with copyable cURL, payloads and response examples.
8. Stage → Sub-stage as true parent/child selection.
9. Lead Workspace stage funnel with completed/current/future clarity.
10. Stage outcome + next follow-up in one action flow.
11. HOT / WARM / COLD lead temperature.
12. Pulsing New Lead indicator.
13. Global Search directly on Dashboard with mobile-first tenant lookup.
14. Complete Lead Allocation Setup for Round Robin.

The product philosophy remains:

> **Minimum clicks. Maximum sales output.**

The primary journey remains:

```text
Capture → Respond → Follow Up → Visit → Shortlist → Quote → Block → Book → Measure
```

---

# 2. Existing Rules That Must Not Break

## 2.1 Active Lead Must Have a Next Action

After the first genuine interaction, an active lead cannot be saved without a future next action.

```text
Outcome
  ↓
Stage + Sub-stage
  ↓
Next Action + Date + Time
  ↓
Single Save
```

Exceptions: terminal stages such as Booked and Lost.

## 2.2 New Lead Clears Only After Genuine Work

A New Lead leaves the New Leads queue only after:

1. genuine action/outcome recorded; and
2. future next action created.

Clicking Call alone does not count.

## 2.3 Blocked and Booked Are Not Normal Dropdown Stages

Do not allow ordinary Stage selection to force semantic `BLOCKED` or `BOOKED`.

Use dedicated business actions:

```text
Block Unit → unit transaction + lead stage
Mark Booked → booking transaction + unit + lead + attribution
```

## 2.4 One Contact Per Normalized Mobile

Same mobile → reuse Contact.

A Contact may have multiple project inquiries/leads.

## 2.5 Price Is Server Controlled

Final price, quotation totals, discount effects and booking value validations remain server-authoritative.

## 2.6 Inventory Concurrency Remains Atomic

Two users cannot successfully block/book the same unit.

## 2.7 Dynamic Stage Names Remain Supported

Automation uses semantic stage type, not literal display name.

---

# 3. Navigation Changes

Main navigation remains:

```text
Dashboard
Leads
Projects
Inventory
Contacts
Campaigns
Reports
Setup
```

Setup should visibly contain:

```text
Organization
Users
Roles & Permissions
Lead Stages & Sub-stages
Lead Allocation
Response SLA
Action Types
Visit Outcomes
Lead Sources
Contact Tags
Templates & Acknowledgement
Nurture
Discount Approval Rules
Block Rules
Integrations
Attribution
Integration Health
Audit Trail
```

Add user-friendly route:

```text
GET /app/setup/lead-allocation
```

Existing `setup.distribution` permission remains authoritative.

---

# 4. Sales Dashboard — Updated Workbench

Recommended order:

```text
[ GLOBAL SEARCH ]

[ New Leads ] [ Today's Follow-ups ] [ Today's Visits ] [ Missed ] [ Re-Inquiry ]

[ Selected queue / records ]
```

Dashboard remains a work screen, not a chart-first analytics screen.

---

# 5. Dashboard Global Search

## 5.1 Placement

Add a prominent search bar at the top of `/app/dashboard`.

Placeholder:

```text
Search mobile, customer, lead ID, email, project or unit...
```

## 5.2 Primary Use Case

A customer calls. User enters the mobile number. CRM immediately answers:

- Does this customer exist?
- Which lead/project?
- Who owns it?
- Current stage?
- Next action?
- Can this user edit it?

## 5.3 Search Behavior

- Exact mobile matches rank first.
- Normalize mobile before lookup.
- Mobile search begins after 4 digits.
- Text search begins after 2 characters.
- Debounce 250–350 ms.

## 5.4 Scope Rules

### Exact mobile

Exact normalized mobile may search **tenant-wide** to identify ownership and prevent duplicates.

This does not grant full access.

### Other fuzzy search

Name/email/project/unit search continues to respect normal data scope.

## 5.5 Result Card

Show for a lead:

- Customer name
- Mobile
- Project
- Stage
- Sub-stage
- Lead Temperature
- Owner
- Next Action
- Latest Inquiry
- Re-Inquiry badge when relevant

## 5.6 Access States

### Current owner

```text
[ Open Lead ]
```

Editable according to role permissions.

### Team/all scoped user

Normal scoped access.

### Other salesperson with own-only scope

Exact mobile search returns only an ownership-safe result:

```text
Rahul Shah
Green Avenue
Owner: Priya Shah
Stage: Connected
This lead belongs to another sales user.
```

Do not expose timeline, notes, call recordings, quotation, pricing, private requirements or source history.

## 5.7 Search API

Keep full page:

```text
GET /app/search?q=
```

Add suggestion endpoint:

```text
GET /api/search?q=
```

Example:

```json
{
  "query": "9876543210",
  "results": [
    {
      "type": "lead",
      "leadId": "lead_123",
      "contactName": "Rahul Shah",
      "mobile": "+919876543210",
      "projectName": "Green Avenue",
      "stage": "Connected",
      "subStage": "Interested",
      "temperature": "HOT",
      "owner": {"id": "user_12", "name": "Priya Shah"},
      "access": "EDIT"
    }
  ]
}
```

Possible `access`:

```text
EDIT
READ
OWNERSHIP_ONLY
```

## 5.8 Search → Create Lead

If no mobile match:

```text
[ Create New Lead ]
```

Open:

```text
/app/leads/new?mobile=9876543210
```

and prefill mobile.

---

# 6. New Lead Pulsing Highlight

## 6.1 Trigger

Animate only if:

```text
stage.semanticType == NEW
AND firstGenuineActionAt == null
AND lead.status == ACTIVE
```

Never depend on literal stage name.

## 6.2 UI

Show:

```text
● New Lead
```

Use a gentle pulse/glow, not aggressive flashing.

Recommended 1.4–1.8 second animation cycle.

## 6.3 Locations

- Dashboard New Lead rows
- Lead list
- Lead Workspace header
- Stage Funnel current state

## 6.4 Accessibility

Respect `prefers-reduced-motion` and show a static emphasized badge.

Animation stops immediately after first genuine action.

---

# 7. Full Real Estate Lead Form

Route remains:

```text
GET  /app/leads/new
POST /api/leads
```

Do **not** use a long multi-step wizard for routine lead capture.

Use one page with clear sections:

```text
1. Customer
2. Inquiry & Source
3. Property Requirement
4. Qualification & Ownership
5. Notes
```

Advanced fields can collapse.

Only essential capture fields should be mandatory initially.

---

# 8. Lead Form — Customer Section

Put mobile first because it drives duplicate detection.

## 8.1 Fields

| Field | Backend | Required | Validation |
|---|---|---:|---|
| Mobile Number | `primaryMobile` | Yes | Normalize + valid phone |
| First Name | `firstName` | Yes | 1–80 chars |
| Last Name | `lastName` | No | 0–80 |
| Alternate Mobile | `altMobile` | No | Must differ from primary |
| Email | `email` | No | Valid email |
| City | `city` | No | |
| State | `state` | No | |
| Pincode | `pincode` | No | Country-aware where practical |

## 8.2 Duplicate Lookup

When valid mobile is entered:

```text
Normalize → Search Contact
```

### Existing Contact

Show:

```text
Existing Contact Found
Rahul Shah · +91 98765 43210
3 previous inquiries
[ Use This Contact ]
```

Do not create duplicate Contact.

### No Contact

Continue new customer creation.

---

# 9. Lead Form — Inquiry & Source

| Field | Required | Rule |
|---|---:|---|
| Lead Source | Yes | Dynamic source master |
| Source Detail | Conditional | Portal/form/referral detail |
| Marketing Campaign | No | Tenant campaign |
| Project | Recommended | Generic lead may remain blank |
| Assignment Mode | Yes | Auto Allocate default |
| Owner | Conditional | Manual only + permission |

## 9.1 Referral / Channel Partner

If source is Referral / Channel Partner, show:

- Search existing CP Contact
- CP/Referrer Name
- CP Mobile
- Contact reference

## 9.2 Portal

Optional:

- Portal Lead ID
- Listing reference

---

# 10. Lead Form — Property Requirement

When Project selected, use configured project masters rather than arbitrary text where possible.

| Field | Required | Notes |
|---|---:|---|
| Project | No/Recommended | |
| Property Type | No | Derived/filter from project |
| Preferred Configuration | No | Multi-select |
| Budget Min | No | Currency |
| Budget Max | No | >= Min |
| Area Min | No | |
| Area Max | No | >= Min |
| Area Basis | No | Carpet/Built-up/Saleable |
| Preferred Facing | No | Multi-select |
| Preferred Floor From | No | |
| Preferred Floor To | No | >= From |
| Purchase Purpose | No | Self Use/Investment/Rental/Other |
| Possession Preference | No | Ready/Near Possession/Under Construction/Any |
| Preferred Location | No | Useful when project blank |
| Requirement Note | No | Free text |

## 10.1 Additional Qualification

Optional fields:

### Purchase Timeline

```text
Immediate
0–30 Days
1–3 Months
3–6 Months
6+ Months
Exploring
```

### Funding Type

```text
Self Funded
Home Loan
Mixed
Unknown
```

### Loan Status

Show only if Funding includes loan:

```text
Not Started
Exploring
Pre-Approved
Approved
```

### Decision Maker

```text
Self
Spouse
Family
Business Partner
Other
```

These are useful for real-estate qualification but must not slow initial capture.

---

# 11. Lead Form — Qualification & Ownership

## 11.1 Lead Temperature

Default:

```text
Temperature: Auto
```

Authorized user can override to HOT/WARM/COLD with reason.

## 11.2 Stage

Fresh lead defaults to semantic `NEW`.

Do not force stage selection in normal capture.

Advanced capture may allow an active stage, but:

- Blocked cannot be selected manually.
- Booked cannot be selected manually.
- If chosen stage is already-attended active state, a valid Next Action must be supplied.

## 11.3 Assignment

Default:

```text
Auto Allocate
```

Manual assignment requires permission.

---

# 12. Lead Form Server Validation

Validate:

1. normalized mobile;
2. duplicate Contact logic;
3. valid Source;
4. tenant Project/Campaign;
5. budget max >= min;
6. area max >= min;
7. floor max >= min;
8. Stage/Sub-stage parent relationship;
9. manual Owner active;
10. assignment permission;
11. no direct Booked/Blocked stage;
12. active attended stage requires future next action.

---

# 13. Existing Contact Decision Tree in Manual Lead Form

## 13.1 Same Contact + Different Project

Create new Lead under same Contact.

## 13.2 Same Contact + Same Active Project

Show:

```text
An active lead already exists for this customer and project.
[ Open Existing Lead ] [ Record Re-Inquiry ]
```

Do not create duplicate active lead.

## 13.3 Same Contact + Same Lost Project

Show prior Lost date/reason.

Primary action:

```text
Record Re-Inquiry & Reopen
```

Preserve Lost history.

## 13.4 Same Contact + Same Booked Project

Allow:

```text
Create New Purchase Inquiry
```

because customer may buy another unit.

---

# 14. HOT / WARM / COLD Lead Temperature

The current explainable priority concept should become a salesperson-friendly **Lead Temperature** layer.

Do not confuse this with Follow-up Priority.

## 14.1 Fields

```text
temperatureScore          Integer 0–100
temperature               HOT | WARM | COLD
temperatureMode           AUTO | MANUAL
temperatureOverrideBy     User nullable
temperatureOverrideAt     Timestamp nullable
temperatureOverrideReason Text nullable
temperatureUpdatedAt      Timestamp
```

## 14.2 New Unattended Lead Rule

A brand-new lead must not appear Cold simply because it has no sales activity.

When `firstGenuineActionAt == null`:

```text
Temperature = WARM
NEW badge = active
```

After genuine action, auto scoring becomes active.

## 14.3 Recommended Auto Signals

| Signal | Points |
|---|---:|
| Active Unit Block | +35 |
| Approved/Shared Quotation | +20 |
| Completed Site Visit | +20 |
| Unit Shortlisted | +10 |
| Re-Inquiry | +10 |
| Budget Captured | +5 |
| Investment Intent | +5 |
| Meaningful activity in last 3 days | +10 |
| 3+ unsuccessful contact attempts | -10 |
| No meaningful activity 7–20 days | -10 |
| No meaningful activity 21+ days | -20 |
| First response SLA breached | -5 |

Clamp 0–100.

## 14.4 Mapping

```text
HOT   >= 60
WARM  30–59
COLD  < 30
```

## 14.5 Terminal Leads

Booked → show BOOKED, hide temperature.

Lost → show LOST, hide temperature.

## 14.6 Manual Override

Manual HOT/WARM/COLD:

- requires reason;
- logs timeline event;
- logs audit event;
- remains until Return to Auto.

## 14.7 Refresh Triggers

Recalculate Auto Temperature after:

- genuine action;
- re-inquiry;
- stage change;
- visit completion;
- shortlist add/remove;
- quotation create/approve/share;
- block create/release/expire;
- meaningful activity;
- SLA result;
- inactivity scheduler.

## 14.8 Filters

Add Temperature to:

- Dashboard queue filters
- Lead List
- Lead Report
- Manager views

---

# 15. Lead Workspace — New Information Architecture

The page must answer immediately:

1. Who is the customer?
2. Which project?
3. Where is the lead in the journey?
4. What has been completed?
5. What is the next action?
6. Which deal action is possible now?
7. What happened before?

---

# 16. Lead Workspace Header

Example:

```text
Rahul Shah                                    HOT
+91 98765 43210
Green Avenue

Owner: Priya Shah
Source: Meta Ads
Campaign: Green Avenue Launch
SLA: Within SLA
Next: Call · Today 4:30 PM
```

Quick actions:

```text
[ Call ] [ WhatsApp ] [ Update / Follow-up ] [ Schedule Visit ]
```

Deal actions:

```text
[ Shortlist Unit ] [ Generate Quotation ] [ Block Unit ] [ Mark Booked ]
```

State and permission determine availability.

---

# 17. Lead Stage Funnel / Journey Progress

Add directly under the Lead Header.

Example:

```text
✓ New Lead ─ ✓ Connected ─ ● Site Visit Done ─ ○ Block Unit ─ ○ Booked
```

Lost is shown as an exit branch rather than pretending every lead walks linearly through it.

## 17.1 Dynamic Source

Use Stage master ordered by `displayOrder`.

## 17.2 State Definitions

### Completed

Stage was actually entered and later exited.

### Current

`lead.stageId == stage.id`

### Not Visited / Skipped

No stage history.

### Future

Not yet visited and later in normal journey ordering.

## 17.3 Important Rule

Do not mark every earlier index as completed.

Example actual journey:

```text
New → Connected → Block Unit
```

Funnel:

```text
✓ New
✓ Connected
○ Visit Planned
○ Visit Done
● Block Unit
○ Booked
```

## 17.4 Current Sub-stage

Show under current stage:

```text
Connected
└─ Interested
```

## 17.5 Funnel Is Readable, Not a Free-Form Stage Editor

Click may show history/details.

Do not let a click force Booked/Blocked.

---

# 18. Stage History

Prefer deriving from reliable stage-change timeline if sufficient.

If dedicated structure is needed:

```text
LeadStageHistory
- tenantId
- leadId
- stageId
- subStageId
- enteredAt
- exitedAt
- changedBy
- sourceAction
- note
```

`sourceAction` examples:

```text
MANUAL_OUTCOME
FOLLOWUP_COMPLETE
VISIT_SCHEDULED
VISIT_COMPLETED
UNIT_BLOCKED
BOOKING
REOPEN
REINQUIRY
```

---

# 19. Stage & Sub-stage Parent / Child Setup

Route:

```text
/app/setup/stages
```

Required presentation:

```text
▾ Not Connected
  Semantic: NOT_CONNECTED
  Requires Sub-stage: Yes
    ├── No Answer
    ├── Busy
    ├── Switched Off
    └── Wrong Number
```

Each Stage:

- Edit
- Add Sub-stage
- Reorder
- Activate/Deactivate
- Expand/Collapse

Each Sub-stage:

- Edit
- Reorder inside parent
- Activate/Deactivate

Do not show sub-stages as an unrelated flat list.

---

# 20. Parent / Child Selection Everywhere

Operational forms must follow:

```text
Stage
  ↓
Filtered Sub-stage children only
```

If selected Stage has no children, hide Sub-stage.

If `requiresSubStage = true`, require it.

Ordinary outcome form hides/disables semantic:

```text
BLOCKED
BOOKED
```

Helper:

```text
Block Unit is completed through the Block Unit action.
Booked is completed through the Mark Booked action.
```

---

# 21. Merge Stage Outcome + Next Follow-up

Do not use two separate saves:

```text
Change Stage → Save → Add Follow-up → Save
```

Use one drawer:

```text
Update Lead & Set Next Action
```

## 21.1 Part A — What Happened

1. Action Type
2. Stage
3. Sub-stage
4. Note

## 21.2 Part B — What Happens Next

5. Next Action Type
6. Next Date
7. Next Time
8. Next Note
9. Assigned User if allowed

One primary button:

```text
Save & Set Next Action
```

If resulting stage terminal:

- hide next action section;
- button = `Save & Close Lead`.

## 21.3 Add Follow-up Only

If user is merely scheduling future work without completing current interaction, keep simple form:

- Action Type
- Date
- Time
- Note
- Assignee

No forced stage change.

## 21.4 Quick Date Presets

Optional:

```text
Later Today
Tomorrow
+2 Days
+7 Days
Custom
```

Server still validates exact future timestamp.

---

# 22. First Genuine Action Example

From New Leads queue:

```text
Action: Call
Stage: Connected
Sub-stage: Interested
Note: Wants 3 BHK
Next Action: Send Brochure
Date: Today
Time: 5:00 PM
```

Single Save causes:

- first genuine action recorded;
- SLA stops;
- Stage/Sub-stage updated;
- next follow-up created;
- New pulse stops;
- New Lead tile removes record;
- record enters correct follow-up queue.

---

# 23. Lead Requirement Card

Keep qualification visible in Lead Workspace:

- Configuration
- Budget
- Area
- Facing
- Floor preference
- Purpose
- Purchase timeline
- Funding type
- Loan status
- Possession preference

Edit via compact drawer.

Do not bury requirements only in notes.

---

# 24. Next Action Card

Always visible on active lead.

Example:

```text
NEXT ACTION
Call Customer
Tomorrow · 11:30 AM
Discuss final unit selection

[ Complete ] [ Reschedule ]
```

If legacy/broken data has attended active lead with no next action:

```text
NEXT ACTION MISSING
This active lead needs a follow-up.
[ Set Next Action ]
```

---

# 25. Deal Card

Add a dedicated connected Deal section.

## Early

```text
Shortlisted Units  0
Quotation          —
Block              —
Booking            —

[ Shortlist Unit ]
```

## Mid Funnel

```text
Shortlisted Units  3
Latest Quotation   ₹1.42 Cr · Approved
Block              —

[ View Units ] [ Block Unit ]
```

## Blocked

```text
Blocked Unit       A-804
Expires            18 Aug · 6:30 PM
Quotation          ₹1.42 Cr

[ Mark Booked ]
```

## Booked

```text
Booking            Completed
Unit               A-804
Final Price         ₹1.42 Cr

[ View Booking ]
```

---

# 26. Project Creation — Guided Stepper

Replace flat Project Create experience with:

```text
1. Project Basics
2. Location
3. Sales & Configuration
4. Media & Documents
5. Towers / Unit Structure
6. Pricing & Payment Plans
7. Mini Site & Review
```

Route remains `/app/projects/new` and existing Project model is preserved where possible.

---

# 27. Project Stepper Behavior

## 27.1 Draft First

After Step 1 saves:

- create Project as `DRAFT`;
- generate ID;
- generate QR token;
- generate slug candidate;
- allow upload/hierarchy child records.

## 27.2 Resume

User can leave and continue later.

Recommended route after creation:

```text
/app/projects/:id/edit?step=location
```

Other steps:

```text
?step=basics
?step=location
?step=sales
?step=media
?step=inventory
?step=pricing
?step=review
```

## 27.3 Step Validation

Validate current step on Next.

Run full readiness validation before Activate/Publish.

---

# 28. Project Step 1 — Basics

Fields:

| Field | Required | Notes |
|---|---:|---|
| Project Name | Yes | 2–150 chars |
| Developer / Brand | Yes | |
| Project Code | No | Tenant-unique if provided |
| Project Type | Yes | Residential/Commercial/Plotting/Villa/Mixed Use |
| Property Types | Yes | At least one |
| RERA Number | No | |
| RERA URL | No | URL |
| Possession Date | No | |
| Short Overview | No | |
| Cover Image | No initially | Recommended before publish |

Project initially stays Draft.

---

# 29. Project Step 2 — Location

Fields:

- Address
- Landmark
- City
- State
- Pincode
- Latitude
- Longitude
- Map URL
- Nearby landmarks/connectivity

Optional nearby item:

```text
Name
Category
Distance
Travel Time
```

---

# 30. Project Step 3 — Sales & Configuration

Fields:

- Starting Price
- Max/Display Price
- Area Min
- Area Max
- Sales Contact Name
- Sales Contact Mobile
- Booking Terms
- Key USPs
- Amenities
- Highlights
- Specifications

## 30.1 Structured Unit Types

Do not use only comma-separated configuration text.

Each Unit Type:

- Name
- Property Type
- Bedrooms
- Bathrooms
- Carpet Area
- Built-up Area
- Saleable/Super Area
- Default Base Rate
- Description
- Floor Plan attachment optional

CTA:

```text
+ Add Configuration
```

---

# 31. Project Step 4 — Media & Documents

Use existing `project.manage_media` permission.

## 31.1 Images

Categories:

- Cover Image
- Gallery
- Master Plan
- Floor Plan
- Location Map
- Amenity Images
- Construction / Other

Media record should contain:

```text
id
tenantId
projectId
category
fileName
mimeType
fileSize
storageKey
caption
displayOrder
customerVisible
uploadedBy
uploadedAt
```

## 31.2 Documents

Categories:

- Brochure
- RERA Certificate
- Legal/RERA Document
- Price List
- Payment Plan
- Specifications
- Approved Plan
- Floor Plan
- Sales Kit
- Other

Document fields:

- Title
- Category
- File
- Customer Shareable yes/no
- AI Usable yes/no
- Internal Note
- Uploaded By
- Uploaded At

## 31.3 Upload Validation

Images:

```text
JPG/JPEG/PNG/WEBP
```

Documents:

```text
PDF
DOC/DOCX where supported
XLS/XLSX only where needed
```

Use application upload size configuration; validate MIME server-side.

## 31.4 Suggested Endpoints

```text
POST   /api/projects/:id/media
PATCH  /api/projects/:id/media/:mediaId
DELETE /api/projects/:id/media/:mediaId

POST   /api/projects/:id/documents
PATCH  /api/projects/:id/documents/:documentId
DELETE /api/projects/:id/documents/:documentId
```

Historically referenced files should archive rather than disappear.

---

# 32. Project Step 5 — Towers / Unit Structure

Visually explain:

```text
Project
└── Tower / Block / Wing
    └── Floor
        └── Unit
```

## 32.1 Tower

- Name
- Code
- Type
- Number of Floors
- Display Order

Floors auto-generate as current implementation supports.

## 32.2 Unit Generator

Flow:

1. Tower
2. Unit Type
3. Units per floor
4. Number pattern
5. Applicable floors
6. Preview
7. Confirm

Example preview:

```text
Floor 3: A-301 A-302 A-303 A-304
Floor 4: A-401 A-402 A-403 A-404
```

Preview is mandatory before mass generation.

---

# 33. Project Step 6 — Pricing & Payment Plans

Use two tabs/cards:

```text
Pricing
Payment Plans
```

Both power quotation and booking.

---

# 34. Pricing UI

Keep existing pricing engine but present components clearly.

Example:

```text
Base Price
Calculation: Per Area
Rate: ₹5,500 / sq ft
Area Basis: Saleable
Applicable: All Units
```

Fields remain:

- Name
- Kind
- Calculation Type
- Rate/Percentage
- Area Basis
- Percentage Base
- Applicable Unit Types
- Towers
- Floor Range
- Effective Dates
- Mandatory
- Customer Visible
- Editable By Sales

---

# 35. Structured Payment Plans

Payment Plan must be more than a name because it will appear in Quotation.

## 35.1 Plan Fields

```text
Name
Description
Active
Display Order
Basis = Final Consideration (V1 default)
```

## 35.2 Installment Rows

Each plan has child rows:

| Field | Required | Notes |
|---|---:|---|
| Sequence | Yes | |
| Milestone / Label | Yes | On Booking / Plinth etc. |
| Percentage | Yes | |
| Due Rule | No | Booking/N Days/Construction/Possession/Custom |
| Due Offset Days | Conditional | |
| Customer Note | No | |
| Display Order | Yes | |

## 35.3 Validation

To activate percentage plan:

```text
Total = 100%
```

Draft may be incomplete.

## 35.4 Boundary

This schedule is for:

- quotation display;
- booking plan selection.

It does not create receivables, collection reminders or accounting entries.

---

# 36. Project Step 7 — Mini Site & Review

Show readiness summary:

```text
✓ Project basics
✓ Location
✓ 3 configurations
✓ 4 towers
✓ 96 units
✓ Pricing configured
✓ 2 payment plans
✓ Cover image
✓ Brochure
```

Mini-site controls:

- Publish
- Show Starting Price
- Show Configuration Availability
- Show General Availability
- CTA Headline
- Customer-visible documents

Actions:

```text
Save as Draft
Activate Project
Activate & Publish Mini Site
```

Only Active project can publish.

---

# 37. Project Detail After Creation

Use clear tabs:

```text
Overview
Inventory
Pricing
Payment Plans
Media & Documents
Mini Site
QR
```

Overview shows readiness and core summary.

---

# 38. Lead → Generate Quotation

Backend entity may remain `CostSheet` for compatibility.

User-facing action should be:

```text
[ Generate Quotation ]
```

Optional small label:

```text
Cost Sheet
```

Existing route may remain:

```text
/app/leads/:leadId/cost-sheets/new
```

---

# 39. Generate Quotation Flow

Use four clear steps:

```text
1. Select Unit
2. Payment Plan
3. Price & Discount
4. Preview & Share
```

---

# 40. Quotation — Select Unit

Default project from Lead.

Show first:

```text
Shortlisted for this Lead
```

Then:

```text
All Available Units
```

Filters:

- Tower
- Floor
- Configuration
- Facing
- Area
- Price
- Status

Unit card:

```text
A-804
Tower A · Floor 8
3 BHK · 1,850 sq ft
East Facing
₹1.42 Cr
AVAILABLE
```

---

# 41. Quotation — Payment Plan

Select active Payment Plan belonging to Project.

Example:

```text
Construction Linked Plan

10%  On Booking
20%  Excavation
20%  Plinth
20%  Structure 50%
20%  Structure Complete
10%  Possession
```

After final price is calculated, show installment amounts.

Example Final Consideration ₹1,42,00,000:

```text
10% = ₹14,20,000
20% = ₹28,40,000
...
```

Use integer minor units and deterministic rounding. Final installment absorbs rounding remainder so schedule total equals basis exactly.

---

# 42. Quotation — Price & Discount

Load server-computed:

- Base Value
- Floor Rise
- PLC
- Parking
- Maintenance
- Corpus
- Taxes
- Other Charges
- Discount
- Final Consideration

Detailed lines behind `View Full Breakdown`.

Discount triggers existing approval rules.

---

# 43. Quotation — Preview & Share

Include:

## Customer

- Name
- Mobile
- Email

## Project/Unit

- Project
- Unit
- Configuration
- Tower
- Floor
- Area
- Facing

## Pricing

- customer-visible lines
- discount
- taxes
- final consideration

## Payment Schedule

- selected plan
- milestone rows
- percentages
- actual installment amounts

## Commercial

- Valid Until
- Booking Terms
- Notes

Actions:

```text
Save Draft
Request Approval
Share Quotation
Print / PDF
```

---

# 44. Payment Plan Snapshot on Quotation

Do not let future Project Payment Plan edits change an already-created quotation.

Snapshot:

```text
paymentPlanId
paymentPlanName
paymentPlanBasis
paymentPlanRows[]
```

Quotation versioning remains intact.

---

# 45. Quotation → Block Connection

On valid quotation show:

```text
[ Block This Unit ]
```

Open Block flow with Unit + Quotation preselected.

Shortlisted Unit card should also show:

```text
[ Generate Quotation ]
```

---

# 46. Block Unit — Proper Unit Picker

Lead Workspace CTA:

```text
[ Block Unit ]
```

Do not require user to know raw `unitId`.

## 46.1 Picker Tabs

```text
Shortlisted Units
Available Inventory
```

## 46.2 Filters

- Tower/Block
- Floor
- Unit Type
- Facing
- Area
- Price

## 46.3 Unit Card

Show:

- Unit number
- Tower
- Floor
- Configuration
- Area
- Facing
- Live price if permitted
- Current status

Only existing backend-eligible states can be confirmed.

---

# 47. Block Unit — Commercial Step

After Unit select:

- Unit summary
- Quotation / Cost Sheet
- Token Amount
- Block Expiry
- Note

Quotation selector priority:

1. latest Approved same-unit quotation;
2. latest Shared same-unit quotation;
3. latest valid no-approval-needed quotation;
4. Block without quotation only if backend policy allows.

---

# 48. Block Expiry UX

Show computed expiry:

```text
Block Valid Until
18 Aug 2026 · 6:30 PM
Project Rule: 48 Hours
```

Only `unit.override_block_expiry` can override.

Confirmation:

```text
You are blocking A-804 for Rahul Shah until 18 Aug 2026, 6:30 PM.
[ Confirm Block Unit ]
```

On success:

```text
Unit → BLOCKED
Lead Stage → Block Unit
Block → ACTIVE
Timeline → UNIT_BLOCKED
```

Lead remains active and next action remains required.

---

# 49. Mark Booked / Book Unit — Fix the Clarity Problem

The current system is correct to use a dedicated Booking action.

The UI must make it obvious.

Add Lead Workspace CTA:

```text
[ Mark Booked ]
```

Helper:

```text
Complete unit booking and close this lead.
```

Do not add a weak stage-only Mark Booked endpoint.

---

# 50. Mark Booked Visibility

Show if:

```text
lead.status == ACTIVE
AND user has unit.book
AND project/unit can be resolved
```

Disable with clear reason if prerequisites missing.

Examples:

```text
No payment plan is configured for this project.
```

```text
Discount approval is pending.
```

---

# 51. Booking Unit Selection

## 51.1 Active Block Exists

Prefill/lock blocked Unit and Project.

Normal flow:

```text
Booking blocked unit A-804
```

## 51.2 No Active Block

If existing backend rules allow direct booking, open valid Unit Picker.

Hide/refuse:

- Booked
- Registered
- Not for Sale
- Blocked for another customer
- HOLD unless resolved per existing rule

Product should encourage:

```text
Shortlist → Quotation → Block → Book
```

without breaking legitimate direct-book behavior already supported.

---

# 52. Booking Form

## Unit

- Project
- Unit
- Configuration
- Tower
- Floor
- Area

## Commercial

- Final Booking Price
- Booking/Token Amount
- Approved Discount
- Selected Quotation
- Payment Plan

## Booking

- Booking Date
- Salesperson
- Buyer Purpose
- Notes

## Investment conditional

- Expected Exit Date
- Expected Exit Price
- Expected ROI %

## Rental conditional

- Expected Rental Start Date
- Expected Rent
- Furnishing

---

# 53. Booking Readiness Checklist

Show before confirmation:

```text
✓ Unit selected
✓ Unit available / blocked for this lead
✓ Payment plan selected
✓ Final price available
✓ Discount approval complete
✓ Buyer purpose selected
```

Any failed item disables primary CTA.

---

# 54. Booking Success

Show clear success screen/banner:

```text
BOOKING COMPLETED

Rahul Shah
Green Avenue
Unit A-804
₹1.42 Cr
16 Aug 2026
```

Actions:

```text
[ View Booking ] [ Open Lead ]
```

Lead page immediately shows:

```text
Stage: Booked
Status: Closed
```

Funnel updates to Booked.

Backend continues to:

- Unit → BOOKED
- Block → CONVERTED if present
- Lead → Booked/Terminal
- pending sales follow-ups cancelled
- attribution frozen
- resale/rental opportunity created where applicable

---

# 55. Booking Errors

Friendly messages:

### Unit taken

```text
This unit is no longer available. Refresh inventory and choose another unit.
```

### Approval pending

```text
This quotation requires discount approval before booking.
```

### Payment plan missing

```text
Select a valid payment plan for this project.
```

### Unit on Hold

```text
This unit is on internal Hold. Resolve the Hold before booking.
```

Never expose raw database errors.

---

# 56. Deal State vs Lead Stage

Implementation must understand:

```text
Lead Stage     = sales journey
Unit Status    = inventory state
Quotation      = commercial artifact
Block          = temporary inventory reservation
Booking        = final sales transaction
```

Example Block action:

```text
Lead Stage → Block Unit
Unit → BLOCKED
UnitBlock → ACTIVE
```

Booking:

```text
Booking → created
Unit → BOOKED
Block → CONVERTED
Lead Stage → Booked
Lead Status → TERMINAL
```

---

# 57. Block Expiry & Stage Funnel

If block expires:

```text
Unit BLOCKED → AVAILABLE
Block ACTIVE → EXPIRED
```

Do not mark lead Lost.

Show Lead warning:

```text
Previous block expired. No unit is currently blocked.
```

Keep user responsible for next outcome/stage because dynamic tenant pipelines may differ.

---

# 58. Integration Setup — API Console

For inbound lead integrations show:

```text
Endpoint
Method
Headers
Field Mapping
Sample Request
Copyable cURL
Success Responses
Duplicate Response
Error Responses
Signature Documentation
Send Test
Rotate Key
Health
```

---

# 59. Integration Endpoint Card

Example:

```text
Lead Capture API
POST https://crm.example.com/api/webhooks/leads/abc123xyz

[ Copy URL ] [ Copy cURL ] [ Send Test ] [ Rotate Key ]
```

---

# 60. Copyable cURL

Generate integration-specific URL.

```bash
curl --request POST \
  --url 'https://crm.example.com/api/webhooks/leads/abc123xyz' \
  --header 'Content-Type: application/json' \
  --header 'x-idempotency-key: demo-lead-001' \
  --data '{
    "externalId": "demo-lead-001",
    "name": "Rahul Shah",
    "mobile": "9876543210",
    "email": "rahul@example.com",
    "project": "Green Avenue",
    "source": "Website",
    "sourceDetail": "Project Landing Page",
    "message": "Interested in 3 BHK",
    "campaignId": "summer-launch-2026",
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "green-avenue-3bhk"
  }'
```

---

# 61. Full API Sample Payload

```json
{
  "externalId": "lead-100023",
  "firstName": "Rahul",
  "lastName": "Shah",
  "mobile": "9876543210",
  "email": "rahul@example.com",
  "city": "Ahmedabad",
  "project": "Green Avenue",
  "source": "Google Ads",
  "sourceDetail": "Search Lead Form",
  "campaignId": "cmp-123",
  "adsetId": "adset-456",
  "adId": "ad-789",
  "formId": "form-101",
  "landingUrl": "https://example.com/green-avenue",
  "utm_source": "google",
  "utm_medium": "cpc",
  "utm_campaign": "green_avenue_launch",
  "utm_term": "3 bhk ahmedabad",
  "utm_content": "responsive_search_ad",
  "message": "Looking for 3 BHK within 1.5 Cr",
  "capturedAt": "2026-08-16T17:30:00Z"
}
```

---

# 62. API Response Examples

## New Lead — 201

```json
{
  "ok": true,
  "leadId": "66c123...",
  "contactId": "66c100...",
  "reinquiry": false
}
```

## Re-Inquiry — 201

```json
{
  "ok": true,
  "leadId": "66c123...",
  "contactId": "66c100...",
  "reinquiry": true
}
```

## Duplicate Delivery — 200

```json
{
  "ok": true,
  "duplicate": true,
  "leadId": "66c123..."
}
```

## Missing Mobile — 400

```json
{
  "ok": false,
  "error": "A valid mobile number is required."
}
```

## Invalid Signature — 401

```json
{
  "ok": false,
  "error": "Invalid webhook signature."
}
```

## Unknown Webhook — 404

```json
{
  "ok": false,
  "error": "Webhook not found."
}
```

---

# 63. Integration Field Mapping Help

Show table:

| Meaning | Example Key |
|---|---|
| External Lead ID | `externalId` |
| Name | `name` |
| Mobile | `mobile` |
| Email | `email` |
| Project | `project` |
| Source | `source` |
| Campaign | `campaignId` |
| Message | `message` |
| UTM Source | `utm_source` |

Clearly show:

```text
Mobile is mandatory.
```

Default Project and Source remain configurable.

---

# 64. Integration Test Console

Add expandable:

```text
Test Lead Capture
```

Pre-fill sample JSON.

Actions:

```text
Validate Only
Send Test Lead
```

If dry-run is not built, clearly warn:

```text
This will create a real test lead in this organization.
```

After test show:

- HTTP status
- response JSON
- Contact ID
- Lead ID
- Re-Inquiry yes/no
- resolved Source
- resolved Project
- assigned Owner if appropriate

---

# 65. Integration Signature Documentation

If signing secret configured, show only documentation:

```text
X-Signature: sha256=<HMAC_SHA256(raw_body, signing_secret)>
```

Never re-render stored secret.

---

# 66. Lead Allocation Setup

Add complete setup screen for existing Round Robin concept.

Route:

```text
/app/setup/lead-allocation
```

Permission:

```text
setup.distribution
```

V1 method remains:

```text
ROUND_ROBIN
```

Do not add AI/workload/weighted allocation in this enhancement.

---

# 67. Allocation Mental Model

```text
Incoming Lead
    ↓
Project-specific active pool exists?
    ├─ Yes → Project Pool
    └─ No  → Default Sales Pool
                ↓
        Next ACTIVE member
                ↓
              Owner
```

---

# 68. Default Sales Pool

Every tenant should have exactly one active Default Pool.

Fields:

- Pool Name
- Type = Default
- Method = Round Robin
- Members
- Member Order
- Escalation Users
- Active
- Current/Next user display

Example:

```text
Default Sales Pool

Round Robin
1. Priya
2. Vikram
3. Rahul

Next Lead → Vikram

Escalation
Sales Manager
Admin
```

Do not let admin directly edit cursor.

---

# 69. Project-Specific Allocation Rule

Fields:

- Rule Name
- Project
- Method = Round Robin
- Members
- Member Order
- Escalation Users
- Active

Only one active project pool per project in V1.

Example:

```text
Green Avenue
→ Green Avenue Sales Team
→ Priya, Vikram, Rahul
```

---

# 70. Allocation Member UX

Ordered list:

```text
☰ Priya Shah
☰ Vikram Patel
☰ Rahul Mehta
```

Drag or move up/down.

Rules:

- no duplicate member;
- Active users only for new configuration;
- suspended/inactive skipped at runtime;
- flag invalid/inactive member visibly.

---

# 71. Allocation Preview

Informational preview:

```text
Next 6 assignments
1 → Vikram
2 → Rahul
3 → Priya
4 → Vikram
5 → Rahul
6 → Priya
```

Atomic backend cursor remains authoritative.

---

# 72. Allocation Fallback

Recommended V1.1 behavior:

1. Try Project Pool.
2. If it has no eligible member, try Default Pool.
3. If no eligible member anywhere:
   - leave Unassigned;
   - SLA continues;
   - notify escalation/admin.

Log fallback diagnostic.

---

# 73. SLA Auto-Reassignment

Auto-reassignment uses resolved pool.

Rules:

- skip inactive/suspended;
- skip current owner when another eligible user exists;
- respect max reassignment count;
- preserve history;
- manual transfer does not alter cursor.

---

# 74. Manual Lead Creation & Allocation

Lead form default:

```text
Assignment: Auto Allocate
```

Flow:

```text
Project → Project Pool → Default Pool → Round Robin
```

Manual assignment:

- permission required;
- target Active;
- logged;
- does not advance round-robin cursor.

---

# 75. Suggested Allocation Routes

If not already exposed:

```text
GET    /app/setup/lead-allocation
POST   /api/setup/assignment-pools
PATCH  /api/setup/assignment-pools/:id
POST   /api/setup/assignment-pools/:id/toggle
POST   /api/setup/assignment-pools/:id/reorder
```

Possible pool fields:

```text
name
scopeType = DEFAULT | PROJECT
projectId
method = ROUND_ROBIN
memberUserIds[]
escalationUserIds[]
active
cursor
```

Match existing code style rather than forcing exact naming if models already exist.

---

# 76. Allocation Validation

- one active Default Pool;
- one active Project Pool per project;
- at least one member before activation;
- tenant users only;
- no duplicate members;
- project belongs to tenant;
- method Round Robin only;
- deactivate rather than delete historical config.

---

# 77. Updated Lead List

Show:

- Customer
- Project
- Stage
- Sub-stage
- Temperature
- Owner
- Source
- Next Action
- SLA
- Latest Inquiry

New pulse appears only on unattended semantic NEW.

Filters add:

- Temperature
- dependent Sub-stage

Sub-stage filter remains disabled until Stage selected.

---

# 78. Recommended Lead Workspace Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Rahul Shah                            HOT                    │
│ +91... · Green Avenue · Owner Priya                          │
│ [Call] [WhatsApp] [Update] [Visit]                           │
├──────────────────────────────────────────────────────────────┤
│ STAGE FUNNEL                                                 │
│ ✓ New → ✓ Connected → ● Visit Done → ○ Block → ○ Booked     │
├──────────────────────────────────────────────────────────────┤
│ Timeline                                    Context          │
│                                              Next Action      │
│ Lead received                               Requirement      │
│ Call                                        Deal             │
│ Visit                                       AI Summary       │
│ Quotation                                   Source           │
└──────────────────────────────────────────────────────────────┘
```

---

# 79. Connected Payment Plan Flow

```text
PROJECT
  creates Payment Plans
       ↓
LEAD
  Generate Quotation
       ↓
select Project Payment Plan
       ↓
QUOTATION
  freezes payment plan snapshot
       ↓
BLOCK
  optionally references quotation
       ↓
BOOKING
  selected payment plan required
```

---

# 80. Quotation Payment Schedule Example

```text
Final Consideration: ₹1,42,00,000

10% On Booking             ₹14,20,000
20% Excavation             ₹28,40,000
20% Plinth                 ₹28,40,000
20% Structure              ₹28,40,000
20% Finishing              ₹28,40,000
10% Possession             ₹14,20,000
```

No receivable/accounting records are created.

---

# 81. Quotation → Block → Book Connected CTAs

## Shortlisted Unit

```text
[ Generate Quotation ]
```

## Valid Quotation

```text
[ Block This Unit ]
```

## Active Block

```text
[ Mark Booked ]
```

This connected CTA chain is mandatory UX.

---

# 82. Action Availability Matrix

| Lead State | Shortlist | Quotation | Block | Mark Booked |
|---|---:|---:|---:|---:|
| New Active | Yes | If unit | If eligible | If prerequisites |
| Connected | Yes | Yes | Yes | Yes |
| Visit Done | Yes | Yes | Yes | Yes |
| Blocked | Yes/View | Yes/version | View/Manage | **Primary** |
| Booked | View | View | No | View Booking |
| Lost | Reopen first | No | No | No |

Permissions always apply.

---

# 83. Lost Flow in Unified Drawer

Selecting Lost:

1. Stage = Lost
2. child Sub-stage required
3. Next Action section hides
4. warning:

```text
This will close the lead and cancel pending follow-ups.
```

5. Save

---

# 84. Reopen Lost Flow

Form:

- Reopen Reason
- Stage
- Sub-stage
- Owner
- Next Action Type
- Date
- Time

All in one flow.

Reopened active lead must have next action.

---

# 85. Site Visit Completion Updated UI

Existing logic remains; presentation becomes:

```text
1. Visit Outcome
2. Stage / Sub-stage
3. Units Shown
4. Units to Shortlist
5. Next Action
```

Single save.

---

# 86. Stage Funnel After Visit

When auto-stage is on:

Scheduling visit marks Visit Planned as current.

Completing visit marks Visit Done as current.

History marks entered/exited stages accurately.

---

# 87. Project Media Visibility

Every uploaded document/image should distinguish:

```text
Customer Visible
Internal Only
```

For documents additionally:

```text
AI Usable yes/no
```

Do not expose internal docs on mini site or quotation.

---

# 88. Project Image Usage

Cover image may be reused on:

- Project list card
- Project detail
- Mini site
- Quotation header if enabled

Gallery and floor plans remain category-specific.

---

# 89. Project QR

Project detail should show:

```text
QR Site Visit
[ Preview Form ] [ Download QR ] [ Copy Visit URL ]
```

No OTP in V1.

---

# 90. API Integration Health

Integration card:

```text
Website Webhook
CONNECTED

Default Project: Green Avenue
Default Source: Website

POST https://crm.../api/webhooks/leads/abc123

[ Copy cURL ] [ Test ] [ Rotate Key ] [ Disable ]

Last Success: 2 min ago
Failed Webhooks: 0
[ View Health ]
```

---

# 91. New Lead Search-to-Capture Flow

```text
Dashboard Global Search
       ↓
Search Mobile
       ↓
Existing?
 ├─ Yes → ownership/access result
 └─ No  → Create Lead with mobile prefilled
```

This must eliminate duplicate entry friction.

---

# 92. Stage Change UX

Do not permanently expose a raw Stage dropdown in header.

Use:

```text
[ Update Lead ]
```

and unified outcome drawer.

If user tries future Block/Booked in Funnel, explain the correct action instead of silently refusing.

---

# 93. Blocked / Booked Explanation

If user clicks Block Unit funnel stage:

```text
To move this lead to Block Unit, choose a unit and complete the Block Unit action.
[ Block Unit ]
```

If user clicks Booked:

```text
To mark this lead Booked, complete the Booking form so inventory and revenue remain accurate.
[ Mark Booked ]
```

This directly resolves the “lead is not marked booked” perception.

---

# 94. Lead Badge Semantics

Keep separate meanings:

```text
NEW            = unattended urgency
HOT/WARM/COLD  = sales temperature
Stage Funnel   = journey position
SLA            = response discipline
```

Example valid combination:

```text
NEW + WARM + Stage New Lead + SLA At Risk
```

---

# 95. Lead Row Badge Order

Dense row:

```text
[NEW] [HOT] [SLA RISK]
```

Do not overload with badges.

---

# 96. New Lead Temperature API

Suggested:

```text
POST /api/leads/:id/temperature
```

Manual body:

```json
{
  "mode": "MANUAL",
  "temperature": "HOT",
  "reason": "Customer confirmed booking decision this week"
}
```

Return to auto:

```json
{
  "mode": "AUTO"
}
```

Use existing `lead.edit` or add `lead.override_temperature` only if needed.

---

# 97. Lead Model Additions

Where absent:

```text
preferredFloorMin
preferredFloorMax
possessionPreference
purchaseTimeline
fundingType
loanStatus
decisionMaker

temperatureScore
temperature
temperatureMode
temperatureOverrideBy
temperatureOverrideAt
temperatureOverrideReason
temperatureUpdatedAt
```

Do not destructively change existing requirement fields.

---

# 98. Priority Compatibility

If current Lead priority is exactly HIGH/MEDIUM/LOW AI sales intent:

```text
HIGH → HOT
MEDIUM → WARM
LOW → COLD
```

If `priority` is used for another purpose, add temperature separately.

Claude must inspect current schema before migration.

---

# 99. Report Updates

Lead Report add:

- Temperature
- Temperature Mode
- Purchase Timeline
- Funding Type
- Stage
- Sub-stage
- Next Action

Sales Report may add:

- Hot Active Leads
- Warm Active Leads
- Cold Active Leads

Do not judge salesperson performance solely by temperature.

---

# 100. AI Compatibility

Existing AI priority endpoint can remain for backward compatibility.

Response may add:

```json
{
  "score": 72,
  "level": "HIGH",
  "temperature": "HOT",
  "signals": [],
  "caveat": "Assistive sales signal"
}
```

AI remains read-only and never changes temperature/stage by itself unless an explicit deterministic auto-temperature service does so.

---

# 101. Payment Plan Migration

If existing plans only contain name/description:

- preserve historical records;
- add installment rows;
- legacy plan remains selectable until tenant updates policy;
- show `Schedule not configured` when rows absent;
- new Active structured plans should require valid 100% schedule.

Do not rewrite historical quotation/booking data.

---

# 102. Quotation Versioning

Changing any price-relevant item, discount, unit or payment plan creates a new version.

Do not modify previously shared commercial numbers in place.

---

# 103. Booking Payment Plan Consistency

If Booking originates from Quotation:

Default Payment Plan = quotation snapshot/plan.

If user changes plan:

- validate project membership;
- if pricing changes because of plan, regenerate Quotation;
- if plan does not alter price, allow with explicit confirmation and audit/timeline note.

---

# 104. Project Readiness Validation

Before Active, warn if missing:

- no Unit Type;
- no sellable Unit;
- no Base pricing;
- no Payment Plan;
- no sales contact.

Before Mini Site Publish require Project Active and public content.

Images/documents may be recommended rather than hard-blocking unless tenant policy says otherwise.

---

# 105. Suggested Human-Readable Quotation Number

Optional:

```text
QTN-<PROJECTCODE>-<YYYY>-<SEQUENCE>
```

Example:

```text
QTN-GA-2026-00482 · V2
```

UUID remains authoritative.

---

# 106. Suggested Booking Number

Optional:

```text
BKG-GA-2026-00182
```

Do not delay core implementation if sequence infrastructure is not ready.

---

# 107. Mobile Responsiveness

Core enhanced flows must work on mobile browser:

- Dashboard Search
- New Lead form
- Lead Funnel
- Unified Follow-up drawer
- Unit Picker
- Quotation
- Block Unit
- Mark Booked

Project Setup can remain desktop-priority but should not be unusable on tablet.

---

# 108. Updated Screen Inventory

| Screen | Route | Purpose |
|---|---|---|
| Dashboard Search | `/app/dashboard` + `/api/search` | Instant lead/customer lookup |
| Full Lead Form | `/app/leads/new` | Real-estate capture + qualification |
| Lead Workspace Funnel | `/app/leads/:id` | Journey clarity |
| Generate Quotation | `/app/leads/:id/cost-sheets/new` | Unit + plan + price |
| Block Unit Picker | Lead action | Select inventory and block |
| Mark Booked | `/app/leads/:id/bookings/new` | Booking transaction |
| Project Stepper | `/app/projects/new`, `/:id/edit?step=` | Guided setup |
| Project Media | project step/tab | Images/documents |
| Lead Allocation | `/app/setup/lead-allocation` | Round Robin configuration |
| Integration API Console | `/app/setup/integrations` | cURL/request/response/test |

---

# 109. Updated Core Journey

```text
CAPTURE
  ↓
NEW LEAD  ← pulsing NEW badge
  ↓
FIRST GENUINE ACTION
  ├─ Stage
  ├─ Sub-stage
  └─ Next Action
  ↓
FOLLOW-UP LOOP
  ↓
SITE VISIT
  ↓
SHORTLIST UNIT
  ↓
GENERATE QUOTATION
  ├─ Unit
  ├─ Pricing
  ├─ Payment Plan
  └─ Discount Approval
  ↓
BLOCK UNIT
  ├─ Unit Picker
  └─ Expiry
  ↓
MARK BOOKED
  ├─ Unit
  ├─ Final Price
  ├─ Payment Plan
  └─ Buyer Purpose
  ↓
BOOKED / CLOSED
```

---

# 110. Example End-to-End User Journey

## Lead arrives

```text
NEW
WARM
SLA Pending
```

New badge pulses.

## User calls

```text
Action: Call
Stage: Connected
Sub-stage: Interested
Next: Site Visit tomorrow 4 PM
```

Save.

## Funnel

```text
✓ New → ● Connected → ○ Visit Planned → ○ Visit Done → ○ Block → ○ Booked
```

## Visit completed

```text
Outcome: Highly Interested
Units shown: A-804, A-1004
Shortlist: A-804
Next: Send Quotation
```

## Generate Quotation

```text
A-804
Construction Linked Plan
Final ₹1.42 Cr
```

## Block Unit

Picker defaults to shortlisted A-804.

Block for configured duration.

## Mark Booked

Lead Deal card now shows primary CTA.

Booking completes.

Result:

```text
Lead = BOOKED / CLOSED
Unit = BOOKED
Revenue = attributed
```

---

# 111. Setup Order After This Enhancement

```text
1. Organization
2. Roles
3. Users
4. Stages & Sub-stages
5. Lead Sources / Actions / Visit Outcomes / Tags
6. Lead Allocation
7. Response SLA
8. Templates & Acknowledgement
9. Integrations
10. Projects
    10.1 Basics
    10.2 Location
    10.3 Sales & Configurations
    10.4 Media & Documents
    10.5 Inventory
    10.6 Pricing
    10.7 Payment Plans
    10.8 Mini Site
11. Nurture
12. Campaigns
```

---

# 112. Suggested New/Clarified Routes

Potential additions:

```text
GET  /api/search?q=
POST /api/leads/:id/temperature

GET   /app/setup/lead-allocation
POST  /api/setup/assignment-pools
PATCH /api/setup/assignment-pools/:id
POST  /api/setup/assignment-pools/:id/toggle
POST  /api/setup/assignment-pools/:id/reorder

POST   /api/projects/:id/media
PATCH  /api/projects/:id/media/:mediaId
DELETE /api/projects/:id/media/:mediaId

POST   /api/projects/:id/documents
PATCH  /api/projects/:id/documents/:documentId
DELETE /api/projects/:id/documents/:documentId
```

Keep current core routes for follow-ups, blocks, cost sheets and bookings.

---

# 113. Permission Mapping

Existing permissions should remain primary:

```text
project.manage_media
setup.distribution
costsheet.create
unit.block
unit.book
lead.edit
```

Optional additions only if needed:

```text
lead.override_temperature
lead.search_tenant_mobile
```

Do not add permissions merely for naming consistency.

---

# 114. Acceptance — Lead Form

- Mobile duplicate lookup before Contact creation.
- Existing Contact reuse.
- Same active Contact+Project not duplicated.
- Source required.
- Project-specific requirements load correctly.
- Range validations work.
- Auto Allocate default.
- Manual assignment permission enforced.
- Full qualification optional at capture.
- Booked/Blocked unavailable as manual stage.
- Re-Inquiry behavior preserved.

---

# 115. Acceptance — Stage Funnel

- Dynamic ordered stages.
- Current obvious.
- Completed based on actual history.
- Skipped not falsely checked.
- Current Sub-stage visible.
- Lost shown appropriately.
- Booked/Blocked not manual transitions.
- Funnel refreshes immediately.

---

# 116. Acceptance — Unified Outcome + Next Action

- Stage first.
- Child Sub-stage filtered.
- Required child enforced.
- Next Action in same drawer.
- Active lead cannot save without future action.
- Terminal hides next action.
- One save keeps stage/follow-up/timeline consistent.

---

# 117. Acceptance — Temperature

- HOT/WARM/COLD visible.
- Unattended New Lead displays WARM + NEW.
- Score explainable.
- Manual override requires reason.
- Return to Auto works.
- Booked/Lost hide temperature.
- Filters work.

---

# 118. Acceptance — Project Stepper

- Step 1 creates Draft.
- Resume later works.
- Location separate.
- Configurations structured.
- Images categorized.
- Documents categorized + visibility.
- Hierarchy understandable.
- Unit generation preview.
- Pricing configured.
- Structured Payment Plans.
- Review/readiness visible.
- Mini-site status rules preserved.

---

# 119. Acceptance — Quotation

- Generate Quotation visible inside Lead.
- Shortlisted units first.
- Available inventory selectable.
- Payment Plan selected from Project.
- Schedule displayed with amounts.
- Server pricing remains authoritative.
- Discount approval preserved.
- Payment Plan snapshot stored.
- Share/PDF includes plan.
- Versioning preserved.

---

# 120. Acceptance — Block Unit

- CTA opens Unit Picker.
- Shortlisted first.
- Filters work.
- Price shown only with permission.
- Quotation can link.
- Expiry visible.
- Override permission respected.
- Atomic conflict behavior preserved.
- Lead stage and unit state synchronize.

---

# 121. Acceptance — Mark Booked

- Lead page clearly shows Mark Booked.
- No ordinary Booked stage dropdown.
- Active block prefills unit.
- Valid unit picker available when no block and policy permits.
- Payment plan mandatory.
- Discount approval mandatory where applicable.
- Existing booking service performs transaction.
- Unit becomes BOOKED.
- Lead becomes Booked/Terminal.
- Follow-ups close.
- Success view visible.
- Resale/rental behavior preserved.

---

# 122. Acceptance — Integration Console

- URL visible.
- Copy URL.
- Copy cURL.
- Sample JSON.
- New Lead response.
- Re-Inquiry response.
- Duplicate response.
- Error docs.
- Signature docs.
- Stored secret never exposed.
- Test action or clearly documented limitation.

---

# 123. Acceptance — Dashboard Search

- Search directly on Dashboard.
- Mobile normalized.
- Exact mobile identifies tenant-wide ownership.
- Owner can edit according to permissions.
- Team/all scope behaves normally.
- Other own-scope salesperson sees ownership-only result.
- Private timeline/data does not leak.
- No-result can prefill New Lead form.

---

# 124. Acceptance — Lead Allocation

- Setup has visible Lead Allocation menu.
- Default Pool editable.
- Project pools configurable.
- Round Robin only in V1.1.
- Member order editable.
- Inactive users skipped.
- Escalation users configured.
- Next user visible, cursor not editable.
- Manual transfer does not alter cursor.
- Empty pool fallback works.
- Unassigned escalation works.
- SLA reassignment uses pool.

---

# 125. Regression Requirements

Do not break:

- tenant isolation;
- authentication/CSRF;
- mobile duplicate rules;
- source history;
- Re-Inquiry;
- SLA history;
- next-action invariant;
- timeline;
- site visit logic;
- pricing authority;
- quotation versioning;
- discount approval;
- atomic block;
- block expiry;
- booking saga;
- attribution;
- reports;
- campaign consent;
- AI read-only behavior.

---

# 126. Required Tests — Lead Form

```text
new Contact + Lead
existing Contact
same active project
same lost project
same booked project
different project
invalid mobile
budget range invalid
area range invalid
floor range invalid
manual owner inactive
auto allocation
```

---

# 127. Required Tests — Parent Child Stages

```text
wrong-parent Sub-stage rejected
required Sub-stage missing rejected
inactive child rejected
Booked manual stage rejected
Blocked manual stage rejected
Lost requires reason
```

---

# 128. Required Tests — Funnel

```text
New → Connected
New → Connected → Visit Done
skipped stage remains uncompleted
Block through Block action
Booked through Booking action
Lost branch
Lost Reopen
```

---

# 129. Required Tests — Temperature

```text
unattended new = WARM + NEW
score to HOT
inactivity to COLD
manual override
manual override persistence
return to AUTO
Booked hides temp
Lost hides temp
```

---

# 130. Required Tests — Project Stepper

```text
Draft after Basics
resume step
media permission
document visibility
unit generation preview/confirm
payment plan not 100% cannot activate
quotation snapshots plan
```

---

# 131. Required Tests — Search

```text
owner exact mobile = EDIT
manager/team scope normal
other salesperson exact mobile = OWNERSHIP_ONLY
name search cannot bypass scope
cross-tenant impossible
```

---

# 132. Required Tests — Allocation

```text
default round robin
project override
inactive member skip
manual transfer cursor unchanged
concurrent assignments safe
empty project pool fallback
unassigned escalation
SLA reassign skips current owner when possible
```

---

# 133. Implementation Order

## Phase A — Lead Clarity

1. Stage Funnel
2. Unified Stage/Sub-stage + Next Action drawer
3. New Lead pulse
4. HOT/WARM/COLD
5. Dashboard Search

## Phase B — Capture & Allocation

6. Full Lead Form
7. Parent/Child Stage Setup/UI
8. Lead Allocation Setup

## Phase C — Project Setup

9. Project Stepper
10. Project Media/Documents
11. Structured Payment Plans

## Phase D — Deal Flow

12. Generate Quotation from Lead
13. Unit Picker for Block
14. Mark Booked CTA + booking picker/readiness
15. Connected Shortlist → Quote → Block → Book CTAs

## Phase E — Integrations

16. cURL/API console
17. Test console
18. Regression tests

---

# 134. Claude Development Instructions

When implementing this file:

1. Read existing `CRM-GUIDE.md` and `FUNCTIONALITY.md` first.
2. Inspect models/services/routes before changing schema.
3. Treat this file as an **override for missing/unclear UX and connected flows**, not permission to rewrite stable backend architecture.
4. Do not connect this CRM with ROS.
5. Do not make Booked a normal stage dropdown choice.
6. Do not make Blocked a normal stage dropdown choice.
7. Add visible Lead Workspace actions that call existing block/booking services.
8. Preserve `applyOutcome()` next-action invariant.
9. Preserve semantic Stage mapping.
10. Make Stage/Sub-stage dependent parent-child everywhere.
11. Build Funnel from actual history, not stage index assumption.
12. Keep Manual Lead Form complete but fast.
13. Create Project as Draft and implement resumable stepper.
14. Add Project Media/Documents under existing media permission.
15. Use UI word “Quotation” while keeping `CostSheet` backend if safer.
16. Snapshot Payment Plan into Quotation.
17. Keep all pricing server authoritative.
18. Use Unit Pickers instead of raw `unitId` UX.
19. Add clear Mark Booked CTA inside Lead Workspace.
20. Add Dashboard exact-mobile global lookup with ownership-safe results.
21. Add Lead Allocation Setup around existing Assignment Pool logic.
22. Keep allocation method Round Robin in this version.
23. Show copyable cURL and API responses without exposing secrets.
24. Do not redesign unrelated stable screens.
25. Add tests before modifying critical sales-state services.

---

# 135. Final V1.1 Product Standard

A salesperson opens CRM and sees:

```text
Search
New Leads
Today's Follow-ups
Today's Visits
Missed
Re-Inquiry
```

A new lead pulses.

The user calls and in one drawer records:

```text
Connected → Interested
Next: Site Visit tomorrow 4 PM
```

The Lead Workspace clearly shows:

```text
✓ New → ● Connected → ○ Visit → ○ Block → ○ Booked
```

After a Visit, the user Shortlists a Unit.

From the same Lead:

```text
Generate Quotation
```

The user selects Unit + Payment Plan and sees final price + installment schedule.

Then:

```text
Block Unit
```

A real unit picker opens.

Then:

```text
Mark Booked
```

The Booking transaction completes and automatically closes the Lead as Booked.

Admin can understand Project Creation step-by-step, upload images/documents, configure payment schedules, configure Lead Allocation, and copy a working cURL from Integrations.

No disconnected stage update.
No hidden raw unit ID.
No unclear booking action.
No duplicate customer capture.
No mystery allocation setup.
No developer guessing the webhook contract.

---

# 136. Final Principle

Every feature in this enhancement must make at least one of these faster or clearer:

```text
Capture
Respond
Follow Up
Visit
Quote
Block
Book
Measure
```

If implementation adds clicks without improving one of these outcomes, simplify it.
