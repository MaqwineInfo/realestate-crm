# Real Estate CRM V1 — Master Product & Functional Specification

**Document Type:** Development-Grade Product Requirement + Functional Specification  
**Version:** 1.0  
**Status:** V1 Source of Truth  
**Product Type:** Multi-tenant SaaS Real Estate Sales Lifecycle CRM  
**Primary Principle:** Minimum clicks. Maximum sales output.  
**Core Promise:** Every lead is worked fast, every active lead always has a next action, and management can see exactly where leads, sales effort, inventory, and marketing money are converting.  
**Important Boundary:** This is an independent personal CRM product. It has **no dependency on, connection to, or reuse requirement from ROS**.

---

# 1. Product Vision

Build the simplest and most execution-focused real estate CRM possible.

The CRM should not behave like a traditional database where sales users first open a dashboard, then navigate to Leads, then filter records, then open a lead, then decide what to do.

The CRM should behave like a **daily sales work engine**.

When a sales user logs in, the system must immediately answer:

1. Which new leads must I call now?
2. Which follow-ups are due today?
3. Which site visits are planned today?
4. Which follow-ups have I missed?
5. Which customers have re-inquired?
6. What is the exact next action for each customer?
7. Which leads are at risk because response SLA was missed?
8. Which units can I offer this customer?
9. What should I do next to move the lead toward a booking?

The CRM should optimize the entire journey:

**Lead Capture → Fast Response → Follow-up → Site Visit → Unit Shortlist → Block Unit → Booking → Resale/Rental Opportunity**

The product must deliberately stop before becoming a full ERP.

---

# 2. Core Product Philosophy

## 2.1 Minimum Clicks, Maximum Output

The product should reduce navigation and repetitive form filling.

Daily sales work should happen primarily from:

- Dashboard work queues
- Lead workspace
- Follow-up drawer/modal
- Site visit action
- Unit shortlist/block action
- Cost sheet action
- Booking action

Avoid forcing users to move through multiple modules for common tasks.

## 2.2 Action First, Reporting Second

For sales users, the home screen is a work queue.

For managers, the home screen is a team exception and performance view.

For management, the home screen is a business outcome view.

Reporting must not dominate the sales user experience.

## 2.3 No Active Lead Without a Next Action

This is a hard business rule.

Any active lead must always have a valid future next action.

An active lead cannot complete a follow-up and remain without a next action.

Exceptions:

- Booked
- Lost
- Any future admin-defined terminal stage explicitly configured as `terminal = true`

## 2.4 Fast Lead Response Is a Product-Level KPI

Every new lead must have:

- Captured timestamp
- Assigned timestamp
- First genuine action timestamp
- First response duration
- SLA status
- Escalation history
- Reassignment history

## 2.5 One Contact, Multiple Inquiries

A person is a master Contact.

The same person may create multiple inquiries across:

- Projects
- Sources
- Campaigns
- Time periods

Do not create duplicate contacts for each inquiry.

## 2.6 Real Estate Depth Without ERP Complexity

The CRM should understand:

- Projects
- Towers/blocks
- Floors
- Units
- Unit types
- Price components
- Availability
- Cost sheets
- Unit blocking
- Booking
- Investor purpose
- Resale opportunity
- Rental opportunity

The CRM should **not** become:

- Accounting software
- Construction ERP
- Collection management system
- Agreement/document execution system
- Possession management system
- Maintenance system
- Full post-sales ERP

---

# 3. V1 Scope

## 3.1 Core Modules

V1 includes:

1. Authentication & Tenant Setup
2. Dashboard
3. Leads / Sales Work Queue
4. Unified Lead Workspace
5. Follow-up Engine
6. Site Visit Management
7. Project Setup
8. Mini Project Website / Sales Page
9. Unit Inventory
10. Pricing & Cost Sheet Engine
11. Unit Shortlist
12. Unit Blocking
13. Booking
14. Resale Opportunities
15. Rental Opportunities
16. Contact Book
17. Communication Campaigns
18. Marketing Campaign Performance
19. Telephony Integration
20. Lead Capture Integrations
21. Lead Distribution
22. Lead SLA / Escalation / Reassignment
23. Lead Nurturing
24. Practical Sales AI
25. Reports
26. User, Role & Permission Management
27. Admin Setup & Configuration
28. Notifications
29. Audit Trail
30. Integration Configuration

## 3.2 Explicitly Out of Scope for V1

Do not build unless later approved:

- Accounting
- Ledger
- Collections
- Demand letters
- Agreement generation/execution
- Registration management
- Construction progress
- Procurement
- Vendor management workflows
- Possession handover
- Customer service ticketing
- Facility management
- Society management
- HRMS
- Payroll
- Channel Partner commission accounting
- CP portal
- Customer portal
- Full predictive dialer
- AI autonomous calling
- AI autonomous stage changes
- AI autonomous pricing approvals
- Full workflow builder
- Full no-code custom object builder
- Generic ERP functionality

---

# 4. Product Model: Multi-Tenant SaaS

## 4.1 Tenant

Each real estate company is a separate **Tenant / Organization**.

A tenant owns its own:

- Users
- Roles
- Permissions
- Projects
- Leads
- Contacts
- Inventory
- Campaigns
- Reports
- Templates
- Stages
- Sub-stages
- Tags
- SLA rules
- Approval rules
- Integrations
- Notification preferences
- Audit logs

## 4.2 Tenant Isolation

Data from one tenant must never be visible to another tenant.

Every tenant-scoped database entity must include:

- `tenant_id`

Every authenticated request must resolve tenant context from the authenticated user/session, not from a freely editable client parameter alone.

## 4.3 Organization Setup

Initial organization onboarding fields:

| Field | Type | Required | Validation |
|---|---|---:|---|
| Organization Name | Text | Yes | 2–120 chars |
| Legal/Display Name | Text | No | 2–150 chars |
| Primary Admin Name | Text | Yes | 2–100 chars |
| Primary Admin Mobile | Phone | Yes | Valid country code + number |
| Primary Admin Email | Email | Yes | Valid format |
| Country | Select | Yes | Supported country master |
| Time Zone | Select | Yes | Default from country |
| Currency | Select | Yes | Default from country |
| Date Format | Select | Yes | Tenant preference |
| Company Logo | Image | No | PNG/JPG/WebP, max configured size |
| Website | URL | No | Valid URL |
| Address | Long text | No | Max 500 chars |

---

# 5. Authentication

## 5.1 V1 Authentication

Minimum:

- Email + password login
- Forgot password
- Reset password
- Session expiry
- Logout
- Admin-created user invitation
- User activation/deactivation

Optional but recommended if implementation cost is low:

- Mobile + OTP
- Google SSO

## 5.2 User Status

- Invited
- Active
- Suspended
- Inactive

Inactive/Suspended users cannot log in.

Their historical ownership and activities must remain intact.

---

# 6. Roles & Permissions

V1 uses **Custom Roles + Permissions**.

Do not hard-code business roles beyond system defaults.

## 6.1 Default Suggested Roles

System may pre-create:

- Organization Admin
- Sales Manager
- Sales User
- Marketing User
- Management Viewer

Tenant admin can:

- Rename roles
- Create roles
- Clone roles
- Change permissions
- Disable custom roles

## 6.2 Permission Structure

Permissions should be granular but understandable.

### Dashboard
- View own dashboard
- View team dashboard
- View management dashboard

### Leads
- View own leads
- View team leads
- View all leads
- Create lead
- Edit lead
- Transfer lead
- Bulk transfer lead
- Mark lost
- Reopen lost
- View lead source
- View campaign attribution
- View contact details
- Export leads

### Activities
- Create follow-up
- Edit own follow-up
- Edit team follow-up
- Complete follow-up
- Create note
- Mention user
- View call recording

### Site Visits
- Create visit
- Edit visit
- Complete visit
- Cancel visit
- View team visits

### Projects
- View projects
- Create project
- Edit project
- Publish project
- Manage project media
- Manage mini website

### Inventory
- View inventory
- View prices
- Edit inventory
- Shortlist unit
- Block unit
- Release block
- Override block expiry
- Book unit

### Pricing
- Create cost sheet
- Apply discount
- Request discount approval
- Approve discount
- Override pricing

### Contacts
- View contacts
- Create contacts
- Edit contacts
- Export contacts
- Manage tags

### Campaigns
- View campaigns
- Create communication campaign
- Send campaign
- View performance
- Edit spend
- Export campaign analytics

### Reports
- View own reports
- View team reports
- View organization reports
- Export reports

### Setup
- Manage users
- Manage roles
- Manage stages
- Manage sub-stages
- Manage action types
- Manage visit outcomes
- Manage SLA rules
- Manage templates
- Manage integrations
- Manage attribution settings
- Manage approval rules
- Manage block rules

## 6.3 Data Scope

Each role permission should support one of:

- Own
- Team
- All

Example:

`lead.view = own | team | all`

---

# 7. Global Navigation

Recommended desktop navigation:

1. **Dashboard**
2. **Leads**
3. **Projects**
4. **Inventory**
5. **Contacts**
6. **Campaigns**
7. **Reports**
8. **Setup**

User/Profile menu:

- My Profile
- Notification Preferences
- Organization
- Logout

## 7.1 Suggested Route Paths

```text
/login
/forgot-password

/app/dashboard

/app/leads
/app/leads/:leadId

/app/projects
/app/projects/new
/app/projects/:projectId
/app/projects/:projectId/edit
/app/projects/:projectId/site-page
/app/projects/:projectId/site-visit-qr

/app/inventory
/app/inventory/:projectId

/app/contacts
/app/contacts/:contactId

/app/campaigns
/app/campaigns/communication
/app/campaigns/communication/new
/app/campaigns/performance
/app/campaigns/:campaignId

/app/reports/leads
/app/reports/sales
/app/reports/projects
/app/reports/campaigns
/app/reports/activities

/app/setup/users
/app/setup/roles
/app/setup/stages
/app/setup/action-types
/app/setup/visit-outcomes
/app/setup/sla
/app/setup/lead-distribution
/app/setup/templates
/app/setup/tags
/app/setup/approval-rules
/app/setup/integrations
/app/setup/attribution
/app/setup/block-rules
/app/setup/organization
```

---

# 8. Dashboard

The dashboard is the most important screen in V1.

## 8.1 Sales User Dashboard

Primary work tiles:

1. **New Leads**
2. **Today's Follow-ups**
3. **Today's Visits**
4. **Missed Follow-ups**
5. **Re-Inquiry**

Each tile must be clickable and open an inline work list on the same dashboard or a pre-filtered lead list.

Preferred behavior:

- Do not navigate users through unnecessary intermediate screens.
- Allow quick actions directly from the work list.
- Preserve filters when returning from a lead.

## 8.2 Tile Definitions

### New Leads

A lead appears here when:

- Lead status is active
- Lead is assigned to current user
- No genuine first action + next action has been saved yet

A lead leaves this tile only when:

1. User records a genuine interaction/action, AND
2. User creates the next action/follow-up

Simply clicking call is not enough.

### Today's Follow-ups

Show incomplete follow-up actions with due date = today in tenant timezone.

Sort:

1. Overdue earlier today
2. Due time ascending
3. Lead priority descending

### Today's Visits

Show site visits scheduled for today.

Statuses:

- Planned
- Confirmed
- In Progress
- Completed
- Cancelled
- No Show

Default list excludes completed/cancelled unless user filters.

### Missed Follow-ups

Any incomplete follow-up where:

`due_at < current_time`

and lead is still active.

### Re-Inquiry

Show active leads/contacts where a new inquiry was received for an existing contact.

The card should show:

- Contact
- New source
- New campaign
- Project
- Previous owner
- Current owner
- Re-inquiry timestamp
- Previous inquiry count

## 8.3 Sales Work List Row

Each dashboard work item should show only action-relevant information:

- Customer name
- Mobile
- Project
- Stage / sub-stage
- Source
- Due time or lead age
- Next action type
- Priority indicator
- SLA indicator if relevant
- Quick action buttons

Recommended quick actions:

- Call
- WhatsApp
- Open Lead
- Complete Follow-up
- Schedule Visit

Avoid overcrowding the row.

## 8.4 Sales Manager Dashboard

Primary tiles:

- Unattended New Leads
- SLA Missed
- Today's Team Follow-ups
- Team Missed Follow-ups
- Today's Visits
- Re-Inquiries

Secondary snapshot:

- Leads received today
- Connected today
- Visits completed today
- Units blocked today
- Bookings today
- Team conversion

Manager exception panels:

- Users with high missed follow-ups
- Leads close to SLA breach
- Blocks expiring soon

## 8.5 Management Dashboard

Primary business funnel:

**Leads → Connected → Site Visits → Blocks → Bookings → Revenue**

Marketing summary:

- Spend
- Leads
- CPL
- Visits
- Cost per visit
- Bookings
- Cost per booking
- Revenue
- ROI

Project performance summary:

- Project
- Leads
- Visit conversion
- Block conversion
- Booking conversion
- Revenue

Sales performance summary:

- User/team
- Response time
- Follow-up discipline
- Visits
- Blocks
- Bookings
- Conversion

---

# 9. Contact Model

A Contact is the master identity of a person.

## 9.1 Contact Fields

| Field | Type | Required | Notes / Validation |
|---|---|---:|---|
| Contact ID | System UUID | Yes | Immutable |
| First Name | Text | Yes | 1–80 chars |
| Last Name | Text | No | 0–80 chars |
| Display Name | Computed/Text | Yes | Derived unless manually allowed |
| Primary Mobile | Phone | Yes | Normalized E.164 preferred |
| Alternate Mobile | Phone | No | Must differ from primary |
| Email | Email | No | Valid format |
| Alternate Email | Email | No | Valid format |
| Gender | Select | No | Configurable simple master if needed |
| City | Text/Select | No | |
| State | Text/Select | No | |
| Country | Select | No | |
| Pincode | Text | No | Country validation where practical |
| Address | Long Text | No | Max 500 |
| Tags | Multi-select | No | Dynamic |
| Owner User ID | User ref | No | Contact-level relationship manager if used |
| Created At | Timestamp | Yes | System |
| Updated At | Timestamp | Yes | System |
| Created By | User/System | Yes | |
| Status | Enum | Yes | Active/Archived |

## 9.2 Duplicate Detection

Primary duplicate key:

1. Normalized mobile number
2. Email as secondary validation

Rules:

- Same mobile → existing Contact by default.
- Same email but different mobile → warn user and show possible duplicate.
- Do not automatically merge two different mobiles only because email matches.
- Integrations receiving same mobile must attach the new inquiry to existing Contact.
- Maintain source history rather than overwriting original source.

## 9.3 Contact Tags

Tags are dynamic and tenant-managed.

Examples:

- Investor
- Member
- Lead
- Channel Partner
- Sales User
- Team
- Developer
- Past Customer
- 3BHK
- Ahmedabad
- NRI
- High Intent

A contact can have multiple tags.

Tag fields:

- Tag ID
- Name
- Optional category
- Active/inactive
- Created by
- Created at

Prevent duplicate tag names within the same tenant ignoring case.

---

# 10. Inquiry / Lead Model

A Lead represents a sales opportunity/inquiry linked to a Contact.

One Contact can have multiple Leads.

## 10.1 Lead Core Fields

| Field | Type | Required | Validation / Logic |
|---|---|---:|---|
| Lead ID | UUID | Yes | Immutable |
| Tenant ID | Ref | Yes | |
| Contact ID | Ref | Yes | |
| Project ID | Ref | Yes for project inquiry | Can be optional only for generic inquiry |
| Current Owner | User Ref | Yes | Must be active user when assigned |
| Team | Team/derived | No | Based on owner/team model |
| Stage | Stage Ref | Yes | Default New Lead |
| Sub-stage | Sub-stage Ref | Conditional | Must belong to selected stage |
| Lead Status | System | Yes | Active/Terminal |
| Source | Source Ref | Yes | |
| Source Detail | Text/Ref | No | Portal/form/IVR etc. |
| Campaign ID | Ref | No | |
| Ad Set ID | External Ref | No | |
| Ad ID | External Ref | No | |
| Original Source | System | Yes | Never overwritten |
| Latest Source | System | Yes | Updated on re-inquiry |
| First Touch Source | System | Yes | |
| Last Touch Source | System | Yes | |
| First Inquiry At | Timestamp | Yes | |
| Latest Inquiry At | Timestamp | Yes | |
| Assigned At | Timestamp | Yes | |
| First Genuine Action At | Timestamp | No | |
| First Response Seconds | Integer | No | Computed |
| SLA Status | Enum | Yes | Pending/Within SLA/At Risk/Breached |
| Priority | Enum/AI | Yes | Low/Medium/High or score |
| Budget Min | Money | No | >= 0 |
| Budget Max | Money | No | >= min |
| Preferred Configuration | Multi/select | No | |
| Purpose | Select | No | Self Use/Investment/Rental/Other |
| Notes Summary | Text | No | Human or AI summary |
| Lost Reason | Ref | Conditional | Required if lost |
| Lost At | Timestamp | Conditional | |
| Booked At | Timestamp | Conditional | |
| Created At | Timestamp | Yes | |
| Updated At | Timestamp | Yes | |

## 10.2 Lead State

System-level lead state:

- Active
- Terminal

Stage config determines whether a stage is terminal.

Default terminal stages:

- Booked
- Lost

---

# 11. Dynamic Stage & Sub-Stage Configuration

Stages and sub-stages are tenant-configurable.

## 11.1 Default Pipeline

Recommended default:

1. New Lead
2. Not Connected
3. Connected
4. Site Visit Planned
5. Site Visit Done
6. Block Unit
7. Booked
8. Lost

## 11.2 Stage Fields

- Stage ID
- Name
- Display Order
- Active
- Terminal boolean
- System semantic type
- Color token optional
- Requires sub-stage boolean
- Requires next action boolean
- Created by
- Updated by

## 11.3 Semantic Type

Even if tenants rename stages, the system may need semantic understanding.

Recommended semantic types:

- NEW
- NOT_CONNECTED
- CONNECTED
- VISIT_PLANNED
- VISIT_DONE
- BLOCKED
- BOOKED
- LOST
- CUSTOM_ACTIVE
- CUSTOM_TERMINAL

This preserves system automation while allowing display names to be dynamic.

## 11.4 Sub-Stage Fields

- Sub-stage ID
- Stage ID
- Name
- Display Order
- Active
- Optional default next action type
- Optional default follow-up offset
- Optional notes requirement

Examples:

Not Connected:
- No Answer
- Busy
- Switched Off
- Wrong Number

Connected:
- Interested
- Call Later
- Details Shared
- Budget Discussion

Lost:
- Budget
- Location
- Competitor
- Not Interested
- Purchased Elsewhere

## 11.5 Stage Validation

- Inactive stages cannot be selected on new changes.
- Historical records keep inactive stage references.
- Sub-stage must belong to selected stage.
- Terminal stage must not require a next action unless explicitly configured.
- Active stage defaults to requiring a next action.

---

# 12. Lead Capture Sources

V1 must support lead capture from:

- Facebook Ads
- Instagram Ads
- Google Ads
- LinkedIn Ads
- Housing
- MagicBricks
- 99acres
- Other property portals
- Website
- Custom web forms
- Landing pages
- Virtual IVR numbers
- WhatsApp bots
- AI chatbots
- Manual lead creation
- Project QR / Walk-in
- CSV import if implemented
- API / webhook

## 12.1 Source Master

Tenant can maintain source names.

Recommended system source categories:

- META
- GOOGLE
- LINKEDIN
- PROPERTY_PORTAL
- WEBSITE
- LANDING_PAGE
- IVR
- WHATSAPP
- CHATBOT
- QR
- WALK_IN
- REFERRAL
- MANUAL
- API
- OTHER

## 12.2 Capture Payload Minimum

Every incoming lead should attempt to capture:

- Name
- Mobile
- Email if available
- Project
- Source
- Campaign
- Campaign external ID
- Ad set external ID
- Ad external ID
- Form external ID
- Message/requirement
- Lead captured timestamp
- Raw payload reference/log for debugging

## 12.3 Capture Workflow

1. Receive payload.
2. Validate tenant/integration.
3. Normalize mobile/email.
4. Search Contact.
5. If existing:
   - Reuse Contact.
   - Create or update appropriate inquiry/lead.
   - Record re-inquiry activity.
6. If new:
   - Create Contact.
   - Create Lead.
7. Resolve Project.
8. Resolve Source/Campaign.
9. Assign owner via Round Robin.
10. Start SLA clock.
11. Trigger acknowledgement.
12. Notify owner.
13. Add activity timeline entry.
14. Show in New Lead queue.

---

# 13. Re-Inquiry Logic

Re-inquiry is a first-class concept.

## 13.1 When to Mark Re-Inquiry

If an incoming inquiry matches an existing Contact by normalized primary mobile and there is already previous inquiry history, record it as re-inquiry.

## 13.2 Same Project Re-Inquiry

If existing active Lead exists for same project:

Recommended V1 behavior:

- Do not create a duplicate active lead automatically.
- Append a new Inquiry Touch / Re-Inquiry record to the same Lead.
- Update latest source/campaign.
- Preserve original source.
- Update `latest_inquiry_at`.
- Surface in Re-Inquiry tile.
- Notify current owner.
- Optionally restart a configurable response timer for re-inquiry.

## 13.3 Different Project Re-Inquiry

Create a new Lead for that Contact under the new Project.

## 13.4 Previous Lead Terminal

If same project previously Lost:

- Create a new reactivated/re-inquiry instance or reopen based on tenant setting.
- Recommended V1: **reopen the same project lead only if historical continuity is desired**, but store reactivation event.
- If implementation simplicity is preferred: create new Lead linked to same Contact and same Project with `related_previous_lead_id`.

For reporting clarity, recommended implementation is:
- One lead opportunity per Contact + Project active cycle.
- Reopen if Lost and new inquiry arrives, while preserving previous lost event in timeline.

If same project previously Booked:
- Create a new inquiry only if customer is buying another unit.
- Do not overwrite booked lead.

---

# 14. Lead Distribution

V1 uses **Simple Round Robin**.

## 14.1 Distribution Scope

Recommended configurable assignment pool:

- Project-level eligible users

If no project-specific pool:

- Organization default sales pool

## 14.2 Round Robin Rules

- Only active users participate.
- Suspended/inactive users are skipped.
- Maintain last-assigned pointer per assignment pool.
- Distribution must be transaction-safe to prevent double allocation under concurrency.
- Manual reassignment must not corrupt round-robin pointer.

## 14.3 No Eligible User

If no user is eligible:

- Assign to Unassigned queue
- Notify configured manager/admin
- SLA still starts
- Dashboard manager sees Unassigned Leads exception

---

# 15. Lead Ownership & Transfer

V1 uses one primary Lead Owner.

## 15.1 Ownership Rules

- Lead has one active primary owner.
- Manual transfer is allowed with permission.
- Future stage-based automated reassignment may be supported later but is not required for core V1.

## 15.2 Transfer Fields

When transferring:

- New owner
- Transfer reason
- Optional note
- Timestamp
- Transferred by

## 15.3 Transfer Behavior

Full history remains attached:

- Calls
- Recordings
- Notes
- Follow-ups
- WhatsApp
- SMS
- Email
- Visits
- Shortlists
- Cost sheets
- Stage history
- Source history
- Previous owners

Create timeline event:

`Lead transferred from User A to User B by User C`

---

# 16. Lead Response SLA

Core product capability.

## 16.1 Configurable SLA

Tenant can configure:

- New lead response target in minutes
- Warning threshold
- Escalation threshold
- Auto-reassignment threshold
- Max auto-reassignments
- Escalation recipients
- Business hours behavior
- Optional project-specific override

Example:

- 0–5 min: Within SLA
- 5–10 min: At Risk
- 10 min: Manager escalation
- 15 min: Auto-reassign

Do not hard-code values.

## 16.2 Genuine First Action

A lead is considered genuinely attended only when:

1. User records a valid interaction outcome/action, AND
2. A next action is created if lead remains active

Examples of valid first action:

- Call completed with outcome
- WhatsApp interaction logged/sent with follow-up
- Meeting scheduled
- Site visit scheduled
- Meaningful manual contact action accepted by workflow

Clicking a phone icon without a completed/logged activity is not a genuine action.

## 16.3 SLA State

- Pending
- Within SLA
- At Risk
- Breached
- Reassigned

## 16.4 SLA Workflow

1. Lead captured.
2. Lead assigned.
3. SLA starts.
4. Notify user instantly.
5. Warning before breach.
6. Notify manager at configured threshold.
7. If unresolved at auto-reassign threshold:
   - select next eligible round-robin user
   - transfer lead
   - log event
   - notify previous owner
   - notify new owner
   - notify manager if configured
8. Stop SLA when genuine first action + next action is saved.

## 16.5 SLA Metrics

Store:

- `captured_at`
- `assigned_at`
- `first_genuine_action_at`
- `first_response_seconds`
- `sla_target_seconds`
- `sla_breached`
- `sla_breach_seconds`
- `reassignment_count`

---

# 17. Automatic Lead Acknowledgement

Acknowledgement is configurable by:

**Project + Lead Source**

## 17.1 Channels

- WhatsApp
- SMS
- Email

Recommended priority:

1. WhatsApp
2. SMS fallback if configured
3. Email optional

## 17.2 Template Rule

Admin can configure:

- Project
- Source
- Channel
- Template
- Active
- Fallback template
- Send delay (normally immediate)
- Business-hours constraint if needed

## 17.3 Template Variables

Examples:

- `{{contact.first_name}}`
- `{{project.name}}`
- `{{owner.name}}`
- `{{owner.mobile}}`
- `{{project.mini_site_url}}`

## 17.4 Failure

If acknowledgement fails:

- Log failed activity
- Do not block lead creation
- Retry according to provider-safe policy
- Show integration error to admin if persistent

---

# 18. Follow-up Engine

This is the heart of the CRM.

## 18.1 Follow-up Fields

| Field | Required | Notes |
|---|---:|---|
| Lead | Yes | |
| Contact | Derived | |
| Action Type | Yes | Dynamic master |
| Due Date | Yes | |
| Due Time | Yes | |
| Assigned User | Yes | Default lead owner |
| Status | Yes | Pending/Completed/Cancelled/Missed |
| Priority | No | Low/Normal/High |
| Note | No | |
| Created By | Yes | |
| Created At | Yes | |
| Completed At | Conditional | |
| Completion Outcome | Conditional | Configurable/action dependent |
| Next Follow-up ID | Conditional | Required if lead active |

## 18.2 Default Action Types

Dynamic admin-managed list.

Recommended defaults:

- Call
- WhatsApp
- Meeting
- Site Visit
- Send Cost Sheet
- Send Brochure
- Video Call
- Email
- Other

## 18.3 Hard Rule

If the lead remains active:

**Current Follow-up Complete → Next Action Required → Save**

Do not permit:

`Complete follow-up → active lead with no future next action`

## 18.4 Complete Follow-up Flow

1. User clicks Complete.
2. Show compact completion drawer.
3. Capture:
   - outcome/sub-stage if applicable
   - note
   - optional stage change
4. If resulting stage is active:
   - Action Type
   - Next Date
   - Next Time
5. Save:
   - current follow-up Completed
   - new next follow-up created
   - stage changes
   - timeline event
6. Close drawer.
7. Immediately load next work item when started from dashboard queue if appropriate.

## 18.5 Missed Follow-up

A pending follow-up becomes Missed when:

`due_at < current_time`

Do not require a batch process to permanently mutate status if query-based calculation is easier; however reporting must be deterministic.

If stored status is used, background scheduler can mark missed.

## 18.6 Follow-up Validation

- Due time must be future for newly created next action, except explicitly allowed immediate action.
- Cannot create follow-up for terminal lead unless reopening flow is used.
- Only allowed users can reassign follow-up owner.
- Site Visit action should link to Site Visit entity, not only free text.

---

# 19. Lead Nurturing / Cadence

Admin-configurable simple automation.

Do not build a complex no-code workflow canvas.

## 19.1 Nurture Sequence

Sequence can be configured by:

- Project
- Stage
- Optional sub-stage
- Optional contact tag/segment

## 19.2 Step Fields

- Step number
- Delay from trigger/previous step
- Channel/action type
- Template
- Stop condition
- Active

Examples:

- Day 0: acknowledgement
- Day 1: task for call
- Day 3: WhatsApp message
- Day 7: inventory update
- Day 15: project offer
- Day 30: reactivation message

## 19.3 Stop Conditions

Stop nurture when:

- Lead stage changes to configured stop stage
- Lead becomes Booked
- Lead becomes Lost if tenant chooses
- Customer opts out
- Manual user pause
- Contact becomes DND for channel

## 19.4 Ownership

Automated tasks should assign to current lead owner.

---

# 20. Unified Lead Workspace

The Lead Workspace is the main sales execution screen.

## 20.1 Header

Show:

- Contact name
- Mobile
- Email
- Project
- Stage
- Sub-stage
- Owner
- Source
- Campaign
- Lead priority
- SLA status
- Next action
- Re-inquiry badge if applicable

Primary buttons:

- Call
- WhatsApp
- Add Follow-up
- Schedule Visit
- Shortlist Unit
- Create Cost Sheet
- More

## 20.2 Lead Workspace Layout

Recommended desktop:

### Left/Main
Unified activity timeline.

### Right Context Panel
Compact summary:

- Customer requirement
- Budget
- Configuration
- Preferred location
- Shortlisted units
- Next action
- AI summary
- AI suggested next action
- Source/campaign
- Owner

Do not overload with too many tabs.

## 20.3 Optional Secondary Sections

Use drawers/expandable panels for:

- Details
- Visits
- Units
- Cost Sheets
- Documents
- Source History

Timeline remains primary.

---

# 21. Unified Activity Timeline

All meaningful events appear chronologically.

## 21.1 Timeline Event Types

- Lead created
- Lead assigned
- SLA warning
- Lead reassigned
- Re-inquiry
- Call started/completed
- Incoming call
- Missed call
- Recording available
- WhatsApp sent/received
- SMS sent
- Email sent
- Note added
- User mentioned
- Follow-up created
- Follow-up completed
- Follow-up missed
- Stage changed
- Sub-stage changed
- Site visit scheduled
- Site visit rescheduled
- Site visit completed
- Site visit cancelled
- Site visit no-show
- Unit shortlisted
- Unit removed from shortlist
- Cost sheet created
- Discount requested
- Discount approved/rejected
- Unit blocked
- Block expiry reminder
- Block expired/released
- Booking completed
- Lead transferred
- Resale opportunity created
- Rental opportunity created
- AI summary refreshed

## 21.2 Timeline Record

Recommended fields:

- Activity ID
- Tenant ID
- Lead ID
- Contact ID
- Type
- Actor type: user/system/integration/AI
- Actor ID
- Timestamp
- Short title
- Structured metadata JSON
- Optional note/body
- Optional attachment references
- Visibility: internal/customer-visible metadata if needed later

Timeline history should be append-oriented.

---

# 22. Internal Collaboration

Keep lightweight.

## 22.1 Notes

User can add internal note.

Fields:

- Lead
- Note body
- Mentions
- Author
- Timestamp
- Edited flag if editing allowed

## 22.2 @Mentions

Typing `@` shows permitted users.

Mention creates:

- Timeline note
- Notification for mentioned user
- Deep link to lead

No separate internal chat module in V1.

---

# 23. Telephony

V1 uses integrated telephony, not full AI/predictive dialer.

## 23.1 Capabilities

- Click-to-call
- Incoming call logging
- Outgoing call logging
- Call duration
- Call status
- Call recording URL/reference
- Missed call logging
- Virtual IVR mapping
- Known contact lookup
- Open matching lead when customer calls where integration supports it
- Manual/automatic call outcome

## 23.2 Call Outcome

Dynamic or system defaults:

- Connected
- No Answer
- Busy
- Switched Off
- Wrong Number
- Call Back
- Interested
- Not Interested

Do not force duplicate fields if stage/sub-stage captures same meaning; provider outcome may be mapped to CRM sub-stage.

## 23.3 Known Incoming Call

If mobile matches one Contact:

- Show Contact
- Show active leads
- Prefer current/most recent active lead
- Allow user to open lead

If multiple active leads:
- show compact choice

## 23.4 Unknown Incoming Call

Allow user to create new Contact + Lead with prefilled mobile.

---

# 24. Site Visit Management

One Contact/Lead may have multiple site visits across same or different projects.

## 24.1 Site Visit Fields

| Field | Required | Notes |
|---|---:|---|
| Site Visit ID | Yes | UUID |
| Lead ID | Yes | |
| Contact ID | Yes | derived |
| Project ID | Yes | |
| Date | Yes | |
| Start Time | Yes | |
| End Time | No | |
| Sales User | Yes | |
| Created By | Yes | |
| Status | Yes | Planned/Confirmed/In Progress/Completed/Cancelled/No Show |
| Visiting With | Yes | Direct/Channel Partner |
| Channel Partner Contact | Conditional | if CP |
| Notes | No | |
| Units Shown | No | multiple unit refs |
| Visit Outcome | Required on completion | Dynamic |
| Next Action | Required if lead active | |

## 24.2 Dynamic Visit Outcomes

Admin-managed.

Recommended defaults:

- Highly Interested
- Interested
- Follow-up Required
- Negotiation
- Unit Shortlisted
- Budget Mismatch
- Location Concern
- Not Interested

## 24.3 Complete Visit Rule

On Complete:

1. Select outcome.
2. Add notes if desired/required.
3. Select units shown if applicable.
4. Optionally shortlist units.
5. Stage may move to Site Visit Done based on config.
6. If lead active, create next action.
7. Save activity.

---

# 25. Project QR Site Visit

Each project can generate a QR code.

No OTP in V1.

## 25.1 Public QR Form

Recommended minimum:

- Name
- Mobile
- Visiting With:
  - Direct
  - Channel Partner / Broker

If Channel Partner:

- Search existing CP contact by mobile/name where practical
- Or enter CP Name
- CP Mobile optional/required based on tenant config

Optional:
- Email
- Number of visitors

Do not ask for excessive fields.

## 25.2 QR Workflow

1. Customer scans QR.
2. Public form loads project context.
3. Customer submits Name + Mobile + Visiting With.
4. Normalize mobile.
5. Search existing Contact.
6. If existing:
   - find/open active project lead or create project lead
   - record QR re-inquiry if relevant
7. If new:
   - create Contact
   - create Lead
   - Source = Project QR / Walk-in
   - assign round robin
8. Create Site Visit record for current visit.
9. Notify lead owner/site user as configured.
10. Log timeline activity.

## 25.3 QR Abuse Protection

Recommended basic controls:

- Rate limiting
- CAPTCHA only if abuse detected or configurable
- Server-side validation
- Tenant/project encoded securely
- Do not trust project ID solely from editable client field

---

# 26. Project Setup

Project Setup is detailed enough to power:

- Sales conversations
- Mini website
- Inventory
- AI
- Cost sheets
- Campaign content
- Unit recommendation

## 26.1 Project Core Fields

### Identity
- Project Name
- Developer/Brand
- Project Code
- Project Status
- RERA Number
- RERA URL
- Project Type
- Property Types

### Location
- Address
- Landmark
- City
- State
- Pincode
- Latitude
- Longitude
- Google Map URL optional

### Sales
- Starting Price
- Price Range
- Configurations
- Area Range
- Possession Date
- Sales Contact
- Booking Terms
- Key USPs

### Project Information
- Overview
- Amenities
- Specifications
- Nearby Places
- Connectivity
- Project highlights
- FAQ

### Media
- Cover image
- Gallery
- Floor plans
- Brochure
- Videos
- Master plan
- Location map
- Other sales documents

### Legal/Reference
- RERA documents
- Approved plans optional
- Sales reference docs
- Internal docs flag

## 26.2 Project Status

Suggested:

- Draft
- Active
- On Hold
- Sold Out
- Archived

Only Active projects are available for normal lead assignment and customer-facing mini site unless otherwise configured.

---

# 27. Project Hierarchy

Recommended hierarchy:

**Project → Tower/Block → Floor → Unit**

Not all project types require tower/block.

Hierarchy must tolerate:

- Plotting projects
- Villas
- Commercial
- Single-building
- Multi-tower

## 27.1 Tower / Block Fields

- Name
- Code
- Type
- Number of floors
- Status
- Sequence/order

## 27.2 Floor Fields

- Floor number/name
- Sort order
- Tower/block
- Floor rise group/rule if applicable

## 27.3 Unit Type / Configuration

Examples:

- 2 BHK
- 3 BHK
- 4 BHK
- Shop
- Office
- Plot
- Villa

Fields:

- Name
- Property type
- Bedrooms if residential
- Bathrooms optional
- Carpet area
- Built-up area
- Super built-up area
- Balcony area optional
- Configuration description
- Default base rate
- Default charges profile
- Floor plan media

## 27.4 Unit Fields

- Unit ID
- Project
- Tower/Block
- Floor
- Unit Number
- Unit Type
- Carpet Area
- Built-up Area
- Saleable/Super Area
- Facing
- View
- PLC category
- Base rate
- Base value override
- Floor rise
- Parking mapping
- Availability Status
- Current block reference
- Current booking reference
- Notes
- Active

Unique constraint recommended:

`tenant + project + tower/block + unit_number`

---

# 28. Live Sales Inventory

Inventory is sales inventory, not ERP inventory.

## 28.1 Unit Status

Core status:

- Available
- Hold
- Blocked
- Booked
- Registered

Optional:
- Not for Sale

## 28.2 Status Rules

### Available
Can be shortlisted, held, or blocked.

### Hold
Temporary internal hold if tenant uses it.

### Blocked
Linked to active Block record with expiry.

### Booked
Linked to Booking record.

### Registered
Optional post-booking informational state only.

## 28.3 Inventory View

Must support:

- Project selector
- Tower/block filter
- Floor filter
- Unit type
- Area
- Price range
- Facing
- Status

Recommended visual modes:

1. List/table
2. Floor-wise grid

Do not overbuild 3D inventory in V1.

---

# 29. Unit Shortlist

One Lead can shortlist multiple units.

## 29.1 Shortlist Record

- Lead ID
- Unit ID
- Shortlisted At
- Shortlisted By
- Rank/order optional
- Note optional
- Active/removed

## 29.2 Rules

- Available, Hold, or Blocked-by-same-lead units may be shortlisted.
- Booked units should not be newly shortlisted unless tenant allows reference comparison.
- Removing shortlist does not change inventory status.
- Shortlist appears in lead workspace.

---

# 30. Pricing & Cost Sheet Engine

V1 includes a full real-estate sales cost-sheet engine.

## 30.1 Pricing Component Types

Examples:

- Base Price
- Floor Rise
- PLC
- View Charge
- Parking
- Maintenance
- Corpus
- Club Membership
- Infrastructure Charge
- GST
- Stamp Duty informational
- Registration informational
- Other Charges
- Discount

Components must support:

- Fixed amount
- Per sq ft / sq m
- Percentage
- Formula/derived where needed
- Taxable/non-taxable classification if required for calculation
- Mandatory/optional
- Customer-visible/internal

## 30.2 Project Pricing Configuration

Admin should define a pricing profile per project/unit type.

Fields:

- Component name
- Calculation type
- Rate/value
- Base area type
- Percentage base
- Applicable unit types
- Applicable floors/towers
- Effective from/to
- Mandatory
- Editable by sales user
- Requires approval if changed
- Display order

## 30.3 Cost Sheet Creation Flow

From Lead:

1. Click Create Cost Sheet.
2. Select Project.
3. Select Unit.
4. System loads:
   - unit details
   - applicable base rate
   - area
   - project pricing components
5. System calculates default value.
6. Sales user may change only permitted fields.
7. If discount exceeds allowed threshold:
   - approval required
8. Preview.
9. Save version.
10. Generate shareable PDF/URL if implemented.
11. Log timeline activity.

## 30.4 Cost Sheet Fields

- Cost Sheet ID
- Lead
- Contact
- Project
- Unit
- Version
- Base price
- Component line items
- Gross amount
- Discount amount
- Discount percentage
- Tax/charges
- Final consideration
- Currency
- Valid until optional
- Approval status
- Created by
- Created at
- Shared at
- Status: Draft/Approval Pending/Approved/Shared/Expired/Superseded

## 30.5 Versioning

Do not overwrite a shared cost sheet.

New edits create a new version or explicit revision.

Historical versions remain accessible.

---

# 31. Discount Approval

Use **configurable multi-level approval based on discount amount or percentage**.

## 31.1 Approval Rule

Admin can define:

- Project or organization scope
- Trigger type:
  - Discount amount
  - Discount percentage
- Min threshold
- Max threshold
- Approval level
- Required role/user
- Sequence
- Active

Example:

- Up to 1%: Sales Manager
- >1% to 3%: Sales Head
- >3%: Management/Admin

## 31.2 Approval Flow

1. Sales user enters discount.
2. System calculates required approval.
3. Cost sheet becomes Approval Pending.
4. Approver receives notification.
5. Approver can:
   - Approve
   - Reject
   - Request Change
6. Decision recorded with:
   - user
   - timestamp
   - note
7. Approved pricing locks into that cost-sheet version.
8. Booking must use approved values if approval was required.

## 31.3 Rules

- User cannot self-approve unless permission explicitly allows.
- Approval cannot silently modify requested amount.
- Changed discount after approval invalidates prior approval and triggers new approval.

---

# 32. Unit Blocking

`Block Unit` is both:

- A Lead Stage
- An Inventory action/status

## 32.1 Block Fields

- Block ID
- Lead
- Contact
- Project
- Unit
- Blocked By
- Blocked At
- Expiry At
- Status
- Cost Sheet reference
- Proposed/final price
- Token/hold amount optional
- Notes
- Released At
- Release Reason

## 32.2 Block Status

- Active
- Converted to Booking
- Released Manually
- Expired
- Cancelled

## 32.3 Block Expiry

Admin configures block duration:

- Organization default
- Project override

Example:
- 24 hours
- 48 hours
- 72 hours

## 32.4 Expiry Workflow

1. Unit blocked.
2. Unit inventory status = Blocked.
3. Lead stage = Block Unit.
4. Schedule reminders.
5. Before expiry:
   - notify owner
   - optional manager
6. At expiry if not booked:
   - block status = Expired
   - unit status = Available
   - log timeline activity
   - notify owner
7. Lead remains active and requires next action.

## 32.5 Concurrency

Blocking must be transactional.

Two users must not successfully block the same available unit at the same time.

Use server-side lock/transaction/conditional update.

---

# 33. Booking

Booking is the final primary sales stage in V1.

## 33.1 Mandatory Booking Data

Minimum required:

- Customer
- Project
- Unit
- Final booking price
- Booking date
- Booking amount/token amount
- Buyer purpose
- Salesperson
- Source/campaign attribution
- Applicable discount
- Payment plan selected

## 33.2 Buyer Purpose

Required:

- Self Use
- Investment
- Rental Income
- Other if tenant allows

## 33.3 Booking Validation

- Unit must not be booked by another active booking.
- If unit blocked, booking must match valid block or authorized override.
- Final price must match approved cost sheet where approval was required.
- Booking date cannot be blank.
- Booking amount cannot be negative.
- Discount approval must be complete if required.

## 33.4 Booking Side Effects

On successful booking:

- Unit status → Booked
- Block status → Converted to Booking
- Lead stage → Booked
- Lead becomes terminal
- No future sales follow-up required
- Cancel/pause active nurture
- Mark open sales follow-ups completed/cancelled by system policy
- Create booking timeline activity
- Create resale/rental metadata based on buyer purpose
- Update campaign conversion metrics
- Update sales performance metrics

---

# 34. Payment Plan

V1 stores a selected sales payment plan; it does not manage future collections.

## 34.1 Payment Plan Setup

Project can define plans such as:

- Construction linked
- Down payment
- Flexi
- Custom sales plan

Fields:

- Name
- Description
- Installment schedule text/structured percentages
- Active

## 34.2 Boundary

Do not create receivables, collection reminders, or accounting ledger in V1.

---

# 35. Investor Exit / Resale Opportunity

At booking, if buyer purpose = Investment, capture:

- Expected Exit Date
- Expected Exit Price
- Expected ROI optional
- Resale interest flag
- Notes

## 35.1 Resale Opportunity Generation

System can surface upcoming investor exits based on configured lead time.

Example:

- 30 days before expected exit
- 60 days before
- 90 days before

## 35.2 Resale Opportunity Fields

- Opportunity ID
- Original Booking
- Contact
- Unit
- Expected availability date
- Expected asking price
- Assigned resale team/user
- Status
- Next action
- Notes

## 35.3 Resale Team

Resale opportunities can be assigned to a separate team using Role + Permission + assignment configuration.

Do not build a separate complex CRM pipeline in V1.

Use a lightweight opportunity queue with follow-up capability.

---

# 36. Rental Opportunity

If buyer purpose = Rental Income, capture:

- Expected rental start date
- Expected rent
- Furnished/Unfurnished preference
- Rental interest flag
- Notes

## 36.1 Rental Opportunity

Fields:

- Opportunity ID
- Booking
- Contact
- Unit
- Expected available date
- Expected rent
- Furnishing preference
- Assigned rental team/user
- Status
- Next action
- Notes

Separate team assignment supported.

---

# 37. Contact Book

One unified Contact Book.

## 37.1 Purpose

Used for:

- Customer history
- Lead identity
- Campaign segmentation
- Investor database
- Member database
- Channel Partner contacts
- Sales users if imported/represented as contacts when needed
- Developer contacts
- Other business relationships

## 37.2 Filters

- Tag
- Project
- Lead stage
- Source
- Campaign
- City
- Owner
- Buyer purpose
- Visit status
- Booking status
- Date created
- Last activity
- Last inquiry

## 37.3 Segments

Allow saved filter sets for campaigns.

Example:

`Tag = Investor AND City = Ahmedabad AND Project Interest = Project A`

A segment may be:

- Dynamic: recalculated at send time
- Static snapshot: optional if implemented

Recommended V1: dynamic saved filters + recipient snapshot captured when campaign is sent.

---

# 38. Communication Campaigns

Campaign channels:

- WhatsApp
- SMS
- Email

## 38.1 Campaign Creation Flow

1. Create Campaign
2. Name
3. Select Channel
4. Select audience:
   - Contact filter
   - Saved segment
5. Show estimated recipient count
6. Select template
7. Preview
8. Schedule now/later
9. Validate DND/consent/provider requirements
10. Send
11. Track delivery

## 38.2 Campaign Fields

- Campaign ID
- Name
- Type = Communication
- Channel
- Audience definition
- Recipient snapshot
- Template
- Schedule
- Status
- Created by
- Sent count
- Delivered count
- Failed count
- Read/open where provider supports
- Reply/click where provider supports
- Created At
- Sent At

## 38.3 Status

- Draft
- Scheduled
- Sending
- Sent
- Paused
- Failed
- Cancelled

## 38.4 Safety

Campaign send must require permission.

Show final recipient count before send.

Prevent accidental duplicate rapid sends where practical.

---

# 39. Marketing Campaign Performance

This is separate from communication campaign sending.

Purpose:

Show where marketing spend produces actual sales outcomes.

## 39.1 Data Sources

V1 supports both:

1. Automatic ad-platform sync
2. Manual campaign entry

Target integrations:

- Meta Ads
- Google Ads

LinkedIn can be supported if integration is available, but do not block V1 architecture.

## 39.2 Performance Funnel

Track:

**Spend → Leads → Connected → Site Visits → Blocks → Bookings → Revenue**

Derived:

- Cost per Lead
- Lead to Connected %
- Lead to Visit %
- Visit to Block %
- Block to Booking %
- Lead to Booking %
- Cost per Visit
- Cost per Block
- Cost per Booking
- Revenue
- ROI / ROAS where definition is configured

## 39.3 Campaign Fields

- Internal Campaign ID
- Platform
- External Campaign ID
- Name
- Project
- Start Date
- End Date
- Spend
- Impressions optional
- Clicks optional
- Leads
- Connected
- Visits
- Blocks
- Bookings
- Revenue
- Status
- Last Sync At

## 39.4 Manual Campaign

Manual entry fields:

- Campaign name
- Source/platform
- Project
- Date range
- Spend
- Notes
- Optional tracking code

Lead source/campaign mapping may be selected manually or through imported tracking identifier.

---

# 40. Multi-Touch Attribution

Preserve full touch history.

Admin chooses primary reporting model:

- First Touch
- Last Touch

## 40.1 Data to Store

For each inquiry touch:

- Contact
- Lead
- Source
- Campaign
- Ad set
- Ad
- Timestamp
- Landing/form
- UTM data if available

## 40.2 Reporting

Campaign reports use tenant-selected attribution model.

Changing reporting model must not delete history.

Management may switch reporting view if permission allows.

---

# 41. Lead Source History

Never overwrite source history.

Lead should expose:

- Original source
- Latest source
- First-touch campaign
- Last-touch campaign
- Full source timeline

Re-inquiry updates Latest Source only.

---

# 42. Practical Sales AI — V1

V1 AI is assistive, not autonomous.

## 42.1 AI Capabilities

1. Lead summary
2. Suggested next action
3. Lead priority
4. Suitable unit recommendation
5. Project/inventory Q&A

## 42.2 Lead Summary

Input may include:

- Lead details
- Stage/sub-stage
- Recent activities
- Calls metadata/transcripts if legally/provider available
- Notes
- Visits
- Shortlisted units
- Budget
- Requirements

Output:

- 2–5 concise bullets or short paragraph
- Current intent
- Main requirement
- Main objection
- Last meaningful activity
- Next expected action

AI summary must identify itself as generated if needed.

## 42.3 Suggested Next Action

AI may recommend:

- Call
- Share cost sheet
- Schedule visit
- Share inventory
- Follow up on objection
- Send payment plan

AI must not automatically complete activities or alter stage.

User decides.

## 42.4 Lead Priority

AI/system can score:

- High
- Medium
- Low

Signals may include:

- Recency
- Re-inquiry
- Response
- Site visit
- Unit shortlist
- Cost sheet
- Block intent
- Engagement
- Budget fit

Always show priority as assistive, not guaranteed likelihood.

## 42.5 Suitable Unit Recommendation

AI receives structured project/inventory data.

Inputs:

- Customer budget
- Configuration
- Area
- Floor preference
- Facing
- Purpose
- Price
- Availability

Only recommend units that are sellable/available according to current inventory permissions.

Never fabricate availability or price.

## 42.6 Project Q&A

Sales user can ask:

- What 3BHK units are available under X budget?
- What is the possession date?
- What amenities are available?
- What is the payment plan?
- Which unit has east facing?
- What is the final cost of unit A-804?

AI must ground answers in tenant project/inventory/pricing data.

If data is missing, say it is not configured.

## 42.7 AI Guardrails

AI cannot:

- Change lead stage automatically
- Block unit automatically
- Book unit automatically
- Approve discount
- Alter inventory
- Send campaign without user confirmation
- Invent project facts
- Invent pricing
- Invent unit availability

---

# 43. Reports

Keep reports few and strong.

V1 report families:

1. Lead Report
2. Sales Report
3. Project Report
4. Campaign Report
5. Activity Report

## 43.1 Common Filters

- Date range
- Project
- User
- Team
- Stage
- Sub-stage
- Source
- Campaign
- Lead status
- Buyer purpose
- City
- Tag

## 43.2 Lead Report

Columns/metrics:

- Lead ID
- Contact
- Project
- Owner
- Stage
- Sub-stage
- Source
- Campaign
- First inquiry
- Latest inquiry
- First response time
- SLA
- Next action
- Last activity
- Visit count
- Shortlist count
- Block status
- Booking status

## 43.3 Sales Report

Metrics:

- User
- Leads assigned
- Avg response time
- SLA compliance %
- Follow-ups due
- Follow-ups completed
- Missed follow-ups
- Follow-up discipline %
- Meaningful activities
- Visits planned
- Visits completed
- Blocks
- Bookings
- Booking revenue
- Lead-to-visit %
- Visit-to-booking %
- Lead-to-booking %

## 43.4 Project Report

Metrics:

- Leads
- Sources
- Connected
- Visits
- Blocks
- Bookings
- Revenue
- Inventory available
- Inventory blocked
- Inventory booked
- Conversion %
- Average booking value

## 43.5 Campaign Report

Metrics:

- Spend
- Leads
- CPL
- Connected
- Visits
- Cost per visit
- Blocks
- Cost per block
- Bookings
- Cost per booking
- Revenue
- ROI/ROAS
- Attribution model

## 43.6 Activity Report

Metrics:

- Calls
- Connected calls
- Call duration
- WhatsApp
- Email
- SMS
- Follow-ups
- Missed follow-ups
- Visits
- Notes
- Cost sheets
- Blocks

---

# 44. Sales Performance Model

Measure both execution and outcome.

## 44.1 Execution Metrics

- Median/average lead response time
- SLA compliance %
- Follow-up completion %
- Missed follow-up count/rate
- Meaningful activities
- Call connection rate
- Site visit scheduled
- Site visit completion

## 44.2 Outcome Metrics

- Blocks
- Bookings
- Revenue
- Lead-to-visit conversion
- Visit-to-block conversion
- Block-to-booking conversion
- Lead-to-booking conversion

Do not force a single score in V1 unless later approved.

Show metrics transparently.

---

# 45. Notifications

## 45.1 Notification Types

- New lead assigned
- SLA warning
- SLA breached
- Lead auto-reassigned
- User mentioned
- Follow-up due
- Follow-up missed
- Site visit upcoming
- Site visit changed
- Block expiring
- Block expired
- Discount approval requested
- Discount approved
- Discount rejected
- Re-inquiry received
- Resale opportunity approaching
- Rental opportunity approaching
- Integration failure for admin

## 45.2 Channels

V1:

- In-app

Optional/configurable:

- Email
- WhatsApp push/message
- Mobile push if app exists later

---

# 46. Search

Global search should support:

- Customer name
- Mobile
- Email
- Lead ID
- Project
- Unit number

Search results must respect permissions.

Exact mobile search should be fast.

---

# 47. Setup & System Configuration

Setup is admin-focused.

Recommended sections:

1. Organization
2. Users
3. Roles & Permissions
4. Lead Stages
5. Sub-stages
6. Action Types
7. Visit Outcomes
8. Lead Sources
9. Lead Distribution
10. SLA Rules
11. Acknowledgement Templates
12. Nurture Sequences
13. Contact Tags
14. Projects
15. Pricing Components
16. Block Expiry Rules
17. Discount Approval Rules
18. Attribution
19. Communication Providers
20. Ad Integrations
21. Telephony Integrations
22. Notification Preferences

---

# 48. Admin Profile

Admin profile should include:

- Name
- Email
- Mobile
- Profile photo
- Password/security
- Organization
- Time zone
- Notification preference

Organization admin additionally sees subscription/billing later if SaaS billing is implemented.

---

# 49. Integration Configuration

## 49.1 Integration Record

Store:

- Provider
- Type
- Tenant
- Status
- Connected by
- Connected at
- Last successful sync
- Last error
- Scopes
- Secret references encrypted
- Webhook status

Never expose raw secrets in UI after save.

## 49.2 Categories

- Meta Lead Ads
- Google Ads
- LinkedIn Ads
- Property portal API/email adapters
- Website webhook
- WhatsApp provider
- SMS provider
- Email provider
- Telephony provider
- AI provider

---

# 50. Dashboard-to-Work Interaction

Important UX rule:

Users should be able to start and finish common actions without losing context.

Example:

Dashboard → Today's Follow-ups → click lead → lead drawer/page → complete call → next action → save → automatically return to same filtered queue and optionally focus next record.

Avoid:

Dashboard → Leads → Filters → Search → Lead → Activity → Follow-up → Save → Dashboard again.

---

# 51. Lead Quick Action UX

## 51.1 Call

Click Call:

- initiate provider action
- create pending call activity if needed
- after call, prompt compact outcome drawer
- require next action if lead active

## 51.2 WhatsApp

Click WhatsApp:

- open integrated composer/template
- send/log message
- if being used as follow-up completion, require outcome + next action

## 51.3 Add Follow-up

Compact form:

- Action Type
- Date
- Time
- Note

## 51.4 Schedule Visit

Compact form:

- Project
- Date
- Time
- Sales user
- Visiting With
- CP if applicable
- Note

---

# 52. Validation Rules Summary

## 52.1 Contact

- Primary mobile required.
- Normalize before duplicate check.
- Email must be valid if provided.
- Alternate mobile cannot equal primary.

## 52.2 Lead

- Contact required.
- Owner required unless Unassigned exception.
- Stage required.
- Sub-stage must belong to stage.
- Active lead must have next action after first genuine action.
- Lost stage requires lost reason/sub-stage if configured.
- Booked stage must be reached through valid booking action unless privileged import.

## 52.3 Follow-up

- Action type required.
- Due date/time required.
- Active lead requires future next action.
- Completion cannot leave active lead without next action.

## 52.4 Visit

- Project/date/time/user required.
- Completion requires visit outcome.
- Active lead requires next action after completion.

## 52.5 Inventory

- Unit number unique within defined project hierarchy.
- Cannot block/book unavailable conflicting unit.
- Status transition must be authorized.

## 52.6 Pricing

- Monetary values >= 0 unless explicit discount line.
- Percentage must be within configured logical bounds.
- Approved discount changes require reapproval.

## 52.7 Booking

- Mandatory booking fields required.
- Unit must be valid.
- Discount approval complete.
- Buyer purpose required.
- Payment plan required.
- Final booking price required.

---

# 53. Inventory State Machine

Recommended transitions:

```text
AVAILABLE
  -> HOLD
  -> BLOCKED
  -> BOOKED
  -> REGISTERED

HOLD
  -> AVAILABLE
  -> BLOCKED

BLOCKED
  -> AVAILABLE   (release/expiry)
  -> BOOKED

BOOKED
  -> REGISTERED
```

Booking cancellation behavior is intentionally not fully modeled in V1 unless required.

If implemented, admin-only reversal with audit log is mandatory.

---

# 54. Default Lead Stage Transition Guidance

Dynamic stages are allowed, but default system flow:

```text
New Lead
  -> Not Connected
  -> Connected
  -> Site Visit Planned
  -> Site Visit Done
  -> Block Unit
  -> Booked

Any active stage
  -> Lost

Lost
  -> Reopened / Connected / New Lead semantic state on re-inquiry
```

Do not hard-block every backward transition.

Allow authorized corrections with audit history.

---

# 55. Business Rules — Non-Negotiable

1. Every active lead must have a next action after it has been attended.
2. Completing an active follow-up requires creating the next action.
3. New Lead is cleared only after genuine action + next action.
4. Mobile number is the primary duplicate identifier.
5. One Contact can have multiple inquiries.
6. Re-inquiry does not overwrite original source.
7. Lead history is never lost on transfer.
8. Lead response SLA is measured.
9. SLA can notify → escalate → auto-reassign.
10. V1 assignment uses Round Robin.
11. Stages/sub-stages are dynamic.
12. Block Unit is a lead stage and inventory state/action.
13. Unit blocks expire automatically based on configured rule.
14. Site visit completion requires outcome.
15. One lead can have multiple visits.
16. One lead can shortlist multiple units.
17. Booking requires complete minimum booking data.
18. Buyer purpose is required at booking.
19. Investor/Rental opportunities may be assigned to separate teams.
20. Campaign attribution preserves multi-touch history.
21. Tenant selects First Touch or Last Touch for primary reporting.
22. Project setup powers inventory, mini site, AI, pricing, and sales.
23. AI is assistive, not autonomous.
24. Product stops at Sales Lifecycle CRM, not ERP.

---

# 56. Audit Trail

Audit important changes.

Must include:

- User
- Timestamp
- Entity
- Entity ID
- Action
- Before value where appropriate
- After value where appropriate
- IP/session metadata if available

Critical audited actions:

- Role/permission changes
- Lead transfers
- Stage changes
- Contact merges
- Inventory status changes
- Unit block/release
- Pricing edits
- Discount request/approval
- Booking creation/edit
- Campaign sends
- Integration settings
- SLA settings

Audit logs should be immutable to normal users.

---

# 57. Soft Delete / Archive

Prefer soft delete/archive for business entities.

Do not permanently delete:

- Leads
- Contacts with history
- Bookings
- Cost sheets
- Activities
- Audit logs

Admin may archive where needed.

---

# 58. Data Model — Core Entities

Recommended entity map:

```text
Tenant
 ├── Users
 ├── Roles
 ├── Permissions
 ├── Teams / Assignment Pools
 ├── Projects
 │    ├── TowersBlocks
 │    │    ├── Floors
 │    │    │    └── Units
 │    ├── UnitTypes
 │    ├── PricingProfiles
 │    ├── PaymentPlans
 │    └── MiniSite
 ├── Contacts
 │    ├── ContactTags
 │    └── Leads
 │         ├── InquiryTouches
 │         ├── Activities
 │         ├── FollowUps
 │         ├── SiteVisits
 │         ├── UnitShortlists
 │         ├── CostSheets
 │         ├── UnitBlocks
 │         └── Bookings
 ├── ResaleOpportunities
 ├── RentalOpportunities
 ├── CommunicationCampaigns
 ├── MarketingCampaigns
 ├── LeadSources
 ├── Stages
 │    └── SubStages
 ├── ActionTypes
 ├── VisitOutcomes
 ├── SLARules
 ├── NurtureSequences
 ├── ApprovalRules
 ├── Integrations
 └── AuditLogs
```

---

# 59. Suggested Relational Relationships

- Contact 1:N Leads
- Lead 1:N InquiryTouches
- Lead 1:N Activities
- Lead 1:N FollowUps
- Lead 1:N SiteVisits
- Lead N:M Units through UnitShortlists
- Lead 1:N CostSheets
- Lead 1:N UnitBlocks historically
- Lead 1:N Bookings if multi-unit booking is allowed; otherwise 1:1 per booked lead
- Project 1:N Towers/Blocks
- Tower/Block 1:N Floors
- Floor 1:N Units
- Project 1:N UnitTypes
- Project 1:N PricingComponents/Profiles
- Project 1:N PaymentPlans
- Contact N:M Tags
- Campaign 1:N InquiryTouches via attribution mapping

---

# 60. Recommended Indexes / Performance Requirements

At minimum index:

- `(tenant_id, normalized_mobile)`
- `(tenant_id, email)`
- `(tenant_id, current_owner_id, lead_status)`
- `(tenant_id, current_owner_id, next_followup_at)`
- `(tenant_id, stage_id)`
- `(tenant_id, project_id)`
- `(tenant_id, latest_inquiry_at)`
- `(tenant_id, sla_status)`
- `(tenant_id, source_id)`
- `(tenant_id, campaign_id)`
- `(tenant_id, unit_status)`
- `(tenant_id, project_id, tower_id, floor_id, unit_number)`
- `(tenant_id, block_expiry_at, block_status)`
- `(tenant_id, site_visit_date, sales_user_id)`
- `(tenant_id, activity_timestamp)`
- external integration IDs where lookup is frequent

Exact database syntax depends on implementation stack.

---

# 61. Event / Automation Model

Recommended internal business events:

```text
lead.created
lead.assigned
lead.reinquiry_received
lead.first_action_completed
lead.sla_warning
lead.sla_breached
lead.reassigned
lead.stage_changed

followup.created
followup.completed
followup.missed

visit.created
visit.completed
visit.cancelled

unit.shortlisted
unit.blocked
unit.block_expiring
unit.block_expired
unit.booked

costsheet.created
discount.approval_requested
discount.approved
discount.rejected

booking.created

campaign.sent
campaign.delivery_updated

contact.tag_added

resale.opportunity_due
rental.opportunity_due
```

Use these events to decouple notifications, analytics, and automation.

---

# 62. API Behavior Guidance

Exact API names are implementation-specific, but keep resources explicit.

Suggested shape:

```text
POST   /api/leads
GET    /api/leads
GET    /api/leads/:id
PATCH  /api/leads/:id
POST   /api/leads/:id/transfer
POST   /api/leads/:id/stage
POST   /api/leads/:id/followups
POST   /api/leads/:id/visits
POST   /api/leads/:id/shortlists
POST   /api/leads/:id/cost-sheets
POST   /api/leads/:id/blocks
POST   /api/leads/:id/bookings

GET    /api/dashboard/sales
GET    /api/dashboard/manager
GET    /api/dashboard/management

GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
PATCH  /api/projects/:id

GET    /api/projects/:id/inventory
POST   /api/units
PATCH  /api/units/:id

GET    /api/contacts
GET    /api/contacts/:id
POST   /api/contacts

GET    /api/reports/leads
GET    /api/reports/sales
GET    /api/reports/projects
GET    /api/reports/campaigns
GET    /api/reports/activities
```

All mutation validation must happen server-side.

---

# 63. External Lead Webhook Guidance

Generic webhook endpoint should support:

- Tenant/integration authentication
- Idempotency key
- Source identifier
- Project mapping
- Contact payload
- Campaign metadata
- Raw payload storage reference
- Validation error logging

## 63.1 Idempotency

Duplicate delivery from provider must not create duplicate inquiry events.

Use:

- provider lead ID
- tenant
- integration ID

as unique idempotency key where available.

---

# 64. Mini Project Website / Sales Page

Each project can generate a shareable customer-facing page from configured project data.

## 64.1 Page Sections

Recommended:

1. Hero
2. Project overview
3. Key highlights
4. Configurations
5. Starting price
6. Amenities
7. Gallery
8. Floor plans
9. Location/connectivity
10. Payment plans
11. Download brochure
12. Sales contact / inquiry CTA

## 64.2 Inventory Disclosure

Do not expose exact internal live unit inventory publicly by default.

Tenant can choose whether to show:

- “Available”
- Configuration availability
- Starting price

Exact unit-wise price and availability should stay CRM-only unless configured.

## 64.3 Lead Capture

Mini site CTA can create lead with:

- Source = Mini Site / Website
- Project auto mapped
- campaign/UTM preserved

---

# 65. Project Documents & AI Knowledge

Documents may be tagged:

- Customer Shareable
- Internal Sales
- Pricing
- Legal Reference
- Floor Plan
- Brochure

AI should only use documents user is permitted to access.

Customer-facing share actions should only expose Customer Shareable assets.

---

# 66. Customer Communication History

Whenever possible, store outbound and inbound communication metadata in timeline.

At minimum:

- Channel
- Template/subject
- Sender
- Recipient
- Timestamp
- Delivery status
- Provider message ID
- Reply linkage where available

Do not store secrets.

---

# 67. Consent / Opt-Out

Campaign module must support channel restrictions.

Contact communication flags:

- WhatsApp Opt-Out
- SMS Opt-Out
- Email Opt-Out
- DND / Do Not Contact
- Reason
- Updated At
- Source

Sales users may still need operational communication depending on applicable law/provider policy, but campaign sending must respect opt-out.

---

# 68. Error Handling UX

Do not show raw technical errors.

Examples:

### Lead failed to assign
"Lead captured, but no active sales user is available. It has been moved to Unassigned."

### Unit block conflict
"This unit was just blocked by another user. Refresh inventory and select another unit."

### Campaign provider failure
"Campaign could not be sent to some recipients. Review failed recipients."

### Integration expired
"Meta connection needs attention. Reconnect from Setup → Integrations."

---

# 69. Empty States

Every module needs useful empty states.

Examples:

Dashboard New Leads:
"No new leads waiting. You're clear."

Projects:
"No projects yet. Create your first project to start capturing and selling inventory."

Inventory:
"Add towers/blocks and units to begin inventory management."

Campaign:
"No campaign data yet. Connect an ad platform or add a manual campaign."

Avoid decorative empty screens without CTA.

---

# 70. List Screen Standards

Every major list should support:

- Search
- Filter
- Sort
- Pagination/infinite load
- Saved filter where useful
- Column visibility only if necessary
- Bulk actions only where safe

Do not overbuild configurable tables.

---

# 71. Mobile Responsiveness

Even if V1 is desktop-first, core sales actions must work on mobile browser:

- Dashboard
- Call
- WhatsApp
- Follow-up
- Lead timeline
- Schedule visit
- Visit outcome
- Unit shortlist
- Cost sheet view
- Block unit

Admin configuration can be desktop-priority.

---

# 72. Time Zone Rules

Store timestamps in UTC.

Display in tenant/user configured timezone.

Dashboard “Today” uses tenant/user business timezone consistently.

SLA must clearly define whether it runs:

- 24x7
- Business hours only

Tenant-configurable.

---

# 73. Currency Rules

Tenant has default currency.

Project may use tenant currency in V1.

All monetary calculations must use fixed precision decimal, not floating-point binary arithmetic.

---

# 74. Security Requirements

Minimum:

- Tenant isolation
- RBAC on server
- Strong password hashing
- Encrypted provider secrets
- HTTPS only
- Rate limiting
- CSRF/XSS protection based on stack
- Input validation
- File upload validation
- Audit logs
- Secure session/token handling
- Webhook verification
- API authorization
- No client-trusted pricing calculation without server validation

---

# 75. File Upload Rules

For project media/documents:

- Validate MIME type
- Validate extension
- Limit file size
- Virus scanning if infrastructure supports
- Store metadata
- Use signed/private URLs for internal files
- Public URLs only for explicitly shareable assets

---

# 76. Data Export

Permitted roles may export:

- Leads
- Contacts
- Reports
- Campaign performance

Every export should:

- respect data scope
- respect active filters
- log export action in audit trail if practical

---

# 77. Import

CSV lead/contact import is useful but not core to the sales workflow.

If included in V1:

- Preview mapping
- Validate mobile
- Duplicate check
- Project/source mapping
- Error row report
- Do not create duplicates silently

If implementation bandwidth is limited, this may be V1.1.

---

# 78. System Defaults

New tenant should receive sensible defaults:

## Stages
- New Lead
- Not Connected
- Connected
- Site Visit Planned
- Site Visit Done
- Block Unit
- Booked
- Lost

## Action Types
- Call
- WhatsApp
- Meeting
- Site Visit
- Send Cost Sheet
- Send Brochure
- Video Call
- Email
- Other

## Visit Outcomes
- Highly Interested
- Interested
- Follow-up Required
- Negotiation
- Unit Shortlisted
- Budget Mismatch
- Location Concern
- Not Interested

## Buyer Purpose
- Self Use
- Investment
- Rental Income

Admin may customize supported masters without requiring development.

---

# 79. Lead Detail — Recommended Field Groups

## Customer
- Name
- Mobile
- Email
- City
- Tags

## Requirement
- Project
- Configuration
- Budget
- Purpose
- Area preference
- Floor preference
- Facing preference
- Notes

## Sales
- Owner
- Stage
- Sub-stage
- Priority
- Next action
- SLA

## Marketing
- Original source
- Latest source
- Campaign
- First touch
- Last touch
- Inquiry count

---

# 80. Lead Editing Rules

Do not allow users to casually change:

- Original source
- First inquiry timestamp
- System SLA fields
- Historical owner data
- Booked unit status
- Approved pricing

Use dedicated actions for business-sensitive changes.

---

# 81. Reopen Lost Lead

Recommended flow:

1. Re-inquiry received or authorized user clicks Reopen.
2. Capture reason.
3. Select active stage.
4. Assign owner if needed.
5. Require next action.
6. Log timeline.
7. Preserve previous lost reason/history.

---

# 82. Lost Lead

When moving to Lost:

Required:

- Lost reason/sub-stage
- Optional note

Behavior:

- Lead terminal
- Future follow-ups cancelled
- Nurture stopped unless tenant explicitly has lost-lead nurture
- Inventory shortlists retained historically
- Active unit block must be released or require explicit confirmation
- Timeline logs lost event

---

# 83. Booking vs Lead Stage Integrity

Do not allow normal users to simply change stage dropdown to Booked.

`Booked` stage must be reached through Booking action.

Similarly, Block Unit should preferably be reached through successful unit block action.

This prevents stage/inventory mismatch.

---

# 84. Site Visit Stage Integrity

When a visit is scheduled:

- lead stage may automatically move to semantic `VISIT_PLANNED` based on tenant config

When completed:

- lead stage may move to `VISIT_DONE`

Avoid forcing stage change if a tenant has custom pipeline; semantic mapping should control automation.

---

# 85. Pricing Integrity

All final price calculations must be recomputed server-side from:

- unit
- project pricing configuration
- approved overrides
- discount
- tax/charge rules

Never accept final total from browser without verification.

---

# 86. Block Integrity

Block action must atomically verify:

- unit current status
- existing active block
- booking conflict
- user permission
- expiry rule
- price/cost sheet reference if required

Then update block + unit + lead state consistently.

---

# 87. Booking Integrity

Booking action should preferably use a transaction to:

- validate unit
- create booking
- update unit
- update block
- update lead
- stop nurture/follow-ups
- create activity

If full transaction unsupported, use idempotent saga with recovery.

---

# 88. Sales User Daily Journey

## Morning Login

User sees:

- 6 New Leads
- 12 Today's Follow-ups
- 3 Today's Visits
- 2 Missed Follow-ups
- 1 Re-Inquiry

## Working a New Lead

1. Click New Lead tile.
2. First lead opens or inline row available.
3. Click Call.
4. Record Connected.
5. Select sub-stage Interested.
6. Set next action: Send Brochure, 11:30 AM.
7. Save.
8. Lead disappears from New Leads.
9. Next lead loads.

Target: as few interactions as safely possible.

## Completing Follow-up

1. Click due follow-up.
2. Perform action.
3. Click Complete.
4. Capture outcome.
5. Create next action.
6. Save.

---

# 89. Manager Daily Journey

Manager logs in and sees exceptions first:

- SLA breached
- Unattended leads
- Missed follow-ups
- Visits today
- Blocks expiring

Manager should be able to click metric and immediately see affected records.

Do not make manager reconstruct exceptions using reports.

---

# 90. Management Journey

Management wants answers:

- Are leads being attended quickly?
- Which projects are converting?
- Which salespeople execute well?
- Which campaigns waste money?
- Which campaigns produce bookings?
- What is current available/blocked/booked inventory?
- What is revenue from bookings?
- What is upcoming resale/rental opportunity?

Provide high-level dashboards + drilldown.

---

# 91. Campaign Decision Journey

Marketing/management should be able to compare:

Campaign A:
- Spend 100
- 100 leads
- 20 visits
- 5 bookings

Campaign B:
- Spend 100
- 150 leads
- 5 visits
- 0 bookings

System should make it clear that Campaign A is more commercially effective even if CPL is higher.

This is a key product differentiation.

---

# 92. Lead Response Metrics Definitions

Use explicit definitions.

### Lead Response Time
`first_genuine_action_at - assigned_at`

### SLA Compliance %
`leads responded within SLA / leads requiring response`

### Follow-up Discipline %
Recommended:
`completed on-time follow-ups / follow-ups due`

Define "on-time" consistently.

### Lead to Visit %
`unique leads with completed visit / leads received`

### Visit to Booking %
`booked leads with visit / unique leads with completed visit`

### Lead to Booking %
`booked leads / leads received`

Document denominator date logic in report UI.

---

# 93. Campaign Metric Definitions

### CPL
`Spend / Attributed Leads`

### Cost per Visit
`Spend / Attributed Completed Visits`

### Cost per Booking
`Spend / Attributed Bookings`

### ROAS
`Attributed Booking Revenue / Spend`

If ROI includes margin/profit, do not call ROAS ROI.

Recommended V1 label:
- ROAS for revenue/spend
- ROI only if cost/profit model later exists

---

# 94. Resale/Rental Dashboard

Keep lightweight.

Potential management cards:

- Resale opportunities in next 30 days
- Resale opportunities in next 90 days
- Rental opportunities in next 30 days
- Expected resale inventory value
- Expected rental inventory count

Assigned teams see their own upcoming opportunity list.

---

# 95. Setup Dependency Logic

Prevent invalid deletion.

Examples:

- Cannot delete a stage used historically; deactivate it.
- Cannot delete a project with leads; archive it.
- Cannot delete a unit with booking history.
- Cannot delete a tag from system history; can deactivate.
- Cannot delete a user with history; deactivate.
- Cannot delete an approval rule retroactively from existing approvals; archive/version.

---

# 96. Configuration Versioning

Important configurations should preserve effective history where possible:

- Pricing rules
- Approval rules
- Block expiry rules
- SLA rules

At minimum store the resolved rule/value on resulting transaction records.

Example:
A Block record stores its actual `expiry_at`, so later changes to project default do not change old blocks.

---

# 97. Integration Failure Monitoring

Admin Setup → Integrations should show:

- Connected / Attention Required
- Last sync
- Last successful event
- Last error
- Reconnect action

Lead capture integration failure should be high-priority.

---

# 98. Idempotency Requirements

Idempotency is critical for:

- Lead webhooks
- Campaign callbacks
- Telephony callbacks
- Unit block requests
- Booking creation
- Payment/token webhook if added
- Ad sync jobs

Duplicate provider events should not duplicate business records.

---

# 99. Activity Immutability

Users may correct notes if policy allows, but system events should not be editable.

Examples of immutable system activities:

- Lead created
- Source captured
- Stage change
- Transfer
- Block
- Booking
- Approval decision

---

# 100. Recommended V1 Build Order

## Phase 1 — Foundation
- Tenant
- Auth
- Users
- Roles/permissions
- Project basic setup
- Contact
- Lead
- Stages/sub-stages
- Lead list
- Lead workspace

## Phase 2 — Sales Execution Core
- Dashboard work queues
- Follow-up engine
- No-active-lead-without-next-action rule
- Round robin
- SLA
- notifications
- re-inquiry
- unified timeline

## Phase 3 — Real Estate Sales
- Site visits
- QR visit capture
- detailed project hierarchy
- inventory
- shortlist
- pricing
- cost sheets
- discount approvals
- block expiry
- booking

## Phase 4 — Marketing
- Contact Book
- dynamic tags
- communication campaigns
- source/campaign capture
- ad integrations
- attribution
- campaign performance

## Phase 5 — Intelligence & Extensions
- AI summary
- next action suggestion
- unit recommendation
- project Q&A
- resale
- rental
- advanced reporting

This is a recommended engineering order, not a product scope reduction.

---

# 101. Minimum Acceptance Criteria by Module

## Dashboard
- Sales user can see all 5 primary work queues.
- Counts match underlying filters.
- Clicking a tile shows exact records.
- User can initiate common actions without unnecessary navigation.

## Lead Capture
- New external lead creates Contact + Lead.
- Existing mobile creates re-inquiry behavior, not duplicate Contact.
- Lead is assigned round robin.
- acknowledgement triggers.
- SLA starts.

## Follow-up
- Cannot complete active follow-up without next action.
- Missed follow-up appears correctly.
- Next action visible on dashboard.

## SLA
- Warning/escalation/reassign fire according to config.
- First genuine action stops SLA.
- Simply clicking call does not stop SLA.

## Site Visit
- Multiple visits supported.
- Completion requires outcome.
- Active lead requires next action.
- QR can create/update lead without OTP.

## Project/Inventory
- Can create project hierarchy.
- Can create unit.
- Inventory statuses work.
- Conflicting unit block prevented.

## Cost Sheet
- Pricing components calculate correctly.
- Discount approval triggers at configured threshold.
- Shared historical version remains unchanged.

## Block
- Expiry configured.
- Reminder fires.
- Expired block auto-releases inventory.

## Booking
- Required fields enforced.
- Unit moves to Booked.
- Lead moves to Booked.
- Buyer purpose stored.
- Resale/rental opportunity initialized when applicable.

## Campaign
- Communication campaign can select filtered Contact Book audience.
- Marketing campaign can show spend-to-booking funnel.
- Attribution model selectable.

## AI
- Does not invent unavailable unit.
- Does not mutate sales state without user action.
- Can summarize and recommend based on CRM data.

---

# 102. Edge Cases

## Duplicate Lead Arrives During Active Call
Attach re-inquiry and notify owner; do not create duplicate contact.

## Same Mobile, Different Person Claim
Allow admin-reviewed split/override with audit trail.

## Owner Deactivated
Open active leads must be reassigned via admin flow; do not orphan silently.

## Project Archived
Historical leads remain accessible.
New inquiries should not auto-assign unless project reactivated or mapping changed.

## Unit Blocked While Cost Sheet Open
On block submit, revalidate unit availability.
Do not trust stale UI.

## Block Expires While Booking Form Open
Booking submission must revalidate block/unit.
If expired but unit still available, authorized flow may re-block or book based on rule.

## Discount Changed After Approval
Approval invalidated; require new approval.

## Re-Inquiry from New Campaign
Add new touch, update latest source/campaign, preserve first touch.

## Follow-up Owner Differs from Lead Owner
Allowed only if permission/config supports it; default next follow-up owner = lead owner.

## Visit Completed but Lead Lost
Completion flow can move stage to Lost with lost reason, no next action required.

## Campaign Contact Opted Out
Exclude from that channel and report excluded count.

---

# 103. UX Rules

1. Use drawers/modals for compact actions.
2. Use full pages for complex setup.
3. Keep dashboard action-centric.
4. Do not hide next action.
5. Use strong empty states.
6. Use searchable selects for project/user/contact/unit.
7. Auto-fill known data.
8. Avoid duplicate data entry.
9. Preserve work-list context.
10. Use confirmation only for destructive/high-impact actions.
11. Do not add confirmation for every ordinary save.
12. Show inline validation immediately.
13. Prefer one primary CTA per action flow.

---

# 104. Lead Card / Row Recommended Information Density

Always visible:

- Name
- Project
- Stage
- Next action/due
- Owner where relevant
- Source
- SLA/priority when relevant

On hover/expand:

- Mobile
- Budget
- Last activity
- Campaign

Do not show every lead field in every list.

---

# 105. Data Freshness

Live inventory and block status must be near real-time.

Dashboard counts may use short caching but must refresh after actions.

Campaign/ad spend may sync on scheduled interval depending on provider API.

Show `Last synced at` for external campaign data.

---

# 106. Observability

Engineering should capture:

- Lead webhook failures
- Assignment failures
- SLA job failures
- Notification failures
- Campaign callback failures
- Telephony webhook failures
- Block expiry job failures
- Ad sync failures
- AI errors

Each background job should be retryable and idempotent.

---

# 107. Background Jobs

Likely jobs:

- SLA warning/escalation
- Block expiry reminder
- Block auto-release
- Follow-up reminder
- Nurture sequence actions
- Campaign scheduling
- Campaign provider status sync
- Ad performance sync
- Resale opportunity reminder
- Rental opportunity reminder
- AI summary refresh where asynchronous architecture is used

---

# 108. Permission-Safe AI

AI context must respect user permissions.

A sales user with access only to Project A cannot ask AI about Project B private pricing.

AI retrieval must filter by:

- Tenant
- User permissions
- Project access
- Document visibility
- Inventory access

---

# 109. Data Retention

Do not hard-delete commercial history by default.

Tenant data export/deletion requirements can be added according to SaaS policy and applicable privacy law.

Store only necessary personal data.

---

# 110. Product Differentiators

The product wins through execution, not feature count.

## 110.1 Daily Work Clarity
User opens CRM and knows exactly what to do.

## 110.2 Response-Time Discipline
SLA is operational, not just a report.

## 110.3 Follow-up Discipline
No active lead disappears without a next action.

## 110.4 Dashboard = Workbench
Dashboard and lead execution are merged.

## 110.5 Real Estate-Aware Project Data
CRM understands project → tower → floor → unit → pricing.

## 110.6 Campaign-to-Booking Visibility
Management can stop wasting ad spend based on actual bookings, not just lead count.

## 110.7 Inventory + Sales Journey
Shortlist → Cost Sheet → Block → Book is connected.

## 110.8 Investor Lifecycle
Booking data becomes future resale/rental opportunity.

## 110.9 Practical AI
AI uses real project and inventory data to help sell, without replacing human control.

---

# 111. What We Must Avoid

Do not add features simply because other CRMs have them.

Avoid:

- Social feed
- Generic task management unrelated to leads
- Full chat
- Complex workflow canvas
- Unnecessary dashboards
- Too many report types
- ERP modules
- Finance/accounting
- Construction
- Heavy customization engine
- Excessive mandatory fields
- Long lead forms
- Too many clicks to log follow-up
- AI features without direct sales value

Every proposed new V1 feature should answer:

**Does this improve lead response, follow-up discipline, site visits, unit conversion, booking conversion, inventory clarity, or marketing ROI?**

If no, exclude it from V1.

---

# 112. Suggested Screen Inventory

## Public/Auth
- Login
- Forgot Password
- Reset Password
- Invite Acceptance
- QR Site Visit Form
- Mini Project Site

## App
- Dashboard
- Leads List
- Lead Workspace
- Projects List
- Project Create/Edit
- Project Detail
- Project Mini Site Preview
- Project QR
- Inventory
- Contacts
- Contact Detail
- Communication Campaigns
- Campaign Builder
- Campaign Performance
- Resale Opportunities
- Rental Opportunities
- Lead Report
- Sales Report
- Project Report
- Campaign Report
- Activity Report

## Setup
- Organization
- Users
- Roles
- Stages/Sub-stages
- Action Types
- Visit Outcomes
- Sources
- Distribution
- SLA
- Templates
- Nurture
- Tags
- Approval Rules
- Attribution
- Block Rules
- Integrations

---

# 113. Suggested Lead Workspace Quick Drawer: Complete Action

Fields in exact recommended order:

1. Current action summary — read only
2. Outcome / sub-stage
3. Note
4. Stage — only if relevant
5. **Next Action Type**
6. **Next Date**
7. **Next Time**
8. Save & Next

If resulting stage terminal, hide next action fields.

This drawer is central to minimal-click execution.

---

# 114. Suggested New Lead First-Action Drawer

After first meaningful contact:

1. Call/message outcome
2. Stage
3. Sub-stage
4. Requirement updates only if needed
5. Next Action Type
6. Date
7. Time
8. Save & Next

Do not force full lead profile completion before clearing New Lead.

---

# 115. Suggested Cost Sheet Quick Flow

1. Select shortlisted unit or search inventory.
2. System shows unit + price.
3. Show charges.
4. Discount field.
5. Final total.
6. If approval needed → Request Approval.
7. If approved/not needed → Save & Share.

Keep detailed component editing behind “Edit Breakdown”.

---

# 116. Suggested Block Flow

1. Unit
2. Customer
3. Approved/selected cost sheet
4. Block expiry shown
5. Optional token amount
6. Confirm Block

Then:

- inventory updates
- lead stage updates
- timeline updates
- expiry automation starts

---

# 117. Suggested Booking Flow

1. Customer
2. Project + Unit — locked from block where possible
3. Booking Date
4. Final Booking Price
5. Booking/Token Amount
6. Discount — display approved value
7. Payment Plan
8. Buyer Purpose
9. Purpose-specific fields
10. Source/Campaign summary
11. Confirm Booking

Use confirmation because booking is high impact.

---

# 118. Reporting Drilldown Rule

Every KPI number should be clickable where practical.

Example:

`Missed Follow-ups = 14`

Click → underlying 14 lead/action records.

`Bookings = 7`

Click → 7 booking records.

This builds trust in reporting.

---

# 119. Data Lineage for Marketing

For every booked lead, management should be able to inspect:

- First source
- First campaign
- Subsequent re-inquiries
- Last source
- Last campaign
- Selected attribution model
- Final attributed campaign

This is essential for campaign confidence.

---

# 120. Dashboard Refresh Behavior

After an action:

- Update affected tile count immediately in UI
- Invalidate/reload affected queue
- Update lead next action
- Update manager exception metrics if needed

Avoid requiring manual page refresh.

---

# 121. Suggested SaaS Architecture Principles

Technology-agnostic requirements:

- Multi-tenant
- API-first
- Event-aware
- Integration-safe
- Idempotent webhooks
- Server-side authorization
- Transaction-safe inventory
- Background jobs for timed automation
- Object storage for documents/media
- Search/index support for contacts/leads
- Structured analytics-ready event data

---

# 122. Claude Development Instructions

When using this document as an implementation source:

1. Treat business rules in Sections 55 and validation sections as authoritative.
2. Do not invent new V1 modules without explicit approval.
3. Do not connect this product to ROS.
4. Preserve multi-tenant isolation in every entity/API.
5. Prefer simple UX over generic enterprise complexity.
6. Any active lead must have a next action after attendance.
7. Do not clear New Lead on a superficial button click.
8. Keep dashboard as primary work surface.
9. Keep one Contact with multiple inquiries.
10. Preserve multi-touch marketing attribution.
11. Keep stages and sub-stages dynamic.
12. Use Round Robin in V1.
13. Treat Block Unit as both lead-stage milestone and inventory transaction.
14. Make block expiry automatic.
15. Enforce approval before unauthorized discount is used.
16. Treat project data as a reusable source for mini site, AI, inventory, pricing, and sales.
17. AI must never fabricate project or inventory facts.
18. Keep resale/rental lightweight.
19. Do not build ERP/post-sales scope.
20. Ask for clarification only if implementation encounters a direct contradiction in this source-of-truth document.

---

# 123. Final V1 Definition

A successful V1 allows a real estate company to:

1. Create its SaaS organization.
2. Create custom roles and permissions.
3. Create projects with detailed unit inventory.
4. Connect or capture leads from major channels.
5. Automatically deduplicate contacts.
6. Automatically distribute leads Round Robin.
7. Automatically acknowledge customers.
8. Measure response SLA.
9. Escalate and reassign unattended leads.
10. Give sales users a clear daily work dashboard.
11. Force every active lead to maintain a next action.
12. Manage dynamic stages/sub-stages.
13. Track all activity in one lead timeline.
14. Integrate calls/IVR.
15. Schedule and complete site visits.
16. Capture project walk-ins through QR without OTP.
17. Shortlist multiple units.
18. Generate detailed cost sheets.
19. Route discounts through approval.
20. Block units with expiry.
21. Complete bookings.
22. Capture buyer purpose.
23. Create future resale/rental opportunities.
24. Maintain one unified Contact Book with dynamic tags.
25. Run WhatsApp/SMS/Email campaigns.
26. Measure ad campaign spend through booking and revenue.
27. Preserve multi-touch attribution.
28. Provide a few powerful reports.
29. Measure execution + outcome.
30. Use practical AI to summarize, prioritize, recommend next steps, and recommend valid units.

The CRM should feel **smaller than competitors while producing more useful daily sales action**.

That is the V1 product standard.
