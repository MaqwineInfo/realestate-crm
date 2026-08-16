# Real Estate CRM — Complete Guide

Everything in one document: what this CRM is, what every word in it means, how to set it
up from an empty database, and exactly what happens — when, where, and what next — as a
lead travels from an ad click to a booked unit and attributed revenue.

Companion document: **[FUNCTIONALITY.md](FUNCTIONALITY.md)** — the flat reference of every
screen, every endpoint, every field and every permission.

Source of truth for behaviour: `Real_Estate_CRM_V1_Master_Product_Spec.md`, extended by
`Real_Estate_CRM_V1_1_Connected_Flow_Enhancement_Spec.md`. Plain section markers like
`§18.3` point at the V1 master spec; `V1.1 §14` points at the enhancement spec.
Implementation-to-test mapping: `docs/REQUIREMENTS-COVERAGE.md`.
Planning, gap analysis and the three documented deviations: `V1_1-PLAN.md`.

**What V1.1 added** — the same product, connected up: a dashboard search that answers
"do we already know this caller", a stage funnel built from real history, HOT/WARM/COLD
temperature, a full real-estate capture form that refuses to duplicate a customer, a
guided project stepper with media and structured payment plans, and one unbroken chain of
buttons from shortlist to booking with a real unit picker at every step.

---

## Table of contents

1. [What this product is](#1-what-this-product-is)
2. [The mental model in one page](#2-the-mental-model-in-one-page)
3. [Vocabulary — every entity, defined](#3-vocabulary--every-entity-defined)
4. [Installation and first run](#4-installation-and-first-run)
5. [Setup order — configuring an organization from zero](#5-setup-order--configuring-an-organization-from-zero)
6. [The full journey — connected, step by step](#6-the-full-journey--connected-step-by-step)
7. [The non-negotiable rules](#7-the-non-negotiable-rules)
8. [Background automation — what runs without a human](#8-background-automation--what-runs-without-a-human)
9. [Notifications — who is told what, and when](#9-notifications--who-is-told-what-and-when)
10. [Permissions and data scope](#10-permissions-and-data-scope)
11. [Money, time, tenancy and concurrency](#11-money-time-tenancy-and-concurrency)
12. [Integrations — connecting the outside world](#12-integrations--connecting-the-outside-world)
13. [Public, customer-facing surfaces](#13-public-customer-facing-surfaces)
14. [Reports and what each number means](#14-reports-and-what-each-number-means)
15. [The AI assistant](#15-the-ai-assistant)
16. [Operating the system](#16-operating-the-system)
17. [Error messages and what they actually mean](#17-error-messages-and-what-they-actually-mean)
18. [Architecture map](#18-architecture-map)

---

## 1. What this product is

A **multi-tenant real estate sales CRM**. One deployment serves many developer
organizations; each organization's data is invisible to every other, enforced at the
database-query layer rather than by convention.

It is built around one opinion: **a CRM is a work engine, not a database with forms.**
The dashboard is a queue of work, not a report. Every screen exists to answer "what do I
do next", and the system refuses to let an active lead exist without a scheduled next
action.

Technology: Node.js + Express 5 + EJS server-rendered views + MongoDB (Mongoose).
No frontend build step, no SPA, no bundler. One stylesheet, one progressive-enhancement
script.

Scope covered: lead capture from any channel, distribution, response SLA, follow-up
discipline, site visits, project and unit inventory, cost sheets and discount approvals,
unit blocking, bookings, resale/rental opportunities, contact segmentation, communication
campaigns, ad-spend attribution, five report families, and a grounded AI assistant.

---

## 2. The mental model in one page

```
        ┌── Meta / Google / portals / website (webhook)
        ├── Project QR walk-in form
CAPTURE ┼── Project mini-site inquiry            ─────►  CONTACT  (one per mobile)
        ├── Manual entry by a salesperson                   │
        └── Re-inquiry from an existing contact             │  one contact, many leads
                                                            ▼
                                                          LEAD  (one opportunity)
                                                            │
     ┌──────────────────────────────────────────────────────┤
     │  automatic on capture:                               │
     │  • SLA clock starts (target stamped on the lead)      │
     │  • round-robin assignment picks an owner              │
     │  • acknowledgement message goes to the customer       │
     │  • "New lead assigned" notification to the owner      │
     └──────────────────────────────────────────────────────┤
                                                            ▼
                                          ┌──── SALES DASHBOARD tiles ────┐
                                          │ New leads · Today's follow-ups │
                                          │ Today's visits · Missed        │
                                          │ Re-inquiries                   │
                                          └───────────────┬───────────────┘
                                                          │  the ONE rule
                                                          ▼
              FIRST GENUINE ACTION  ── outcome + a scheduled next action ──► SLA clock stops
                                                          │
                                                          ▼
      follow-up ⇄ follow-up ⇄ SITE VISIT ──► SHORTLIST ──► COST SHEET ──► [discount approval]
                                                          │                        │
                                                          ▼                        ▼
                                                    BLOCK UNIT  ◄──── shareable customer link
                                                (atomic; expires on a timer)
                                                          │
                                                          ▼
                                                      BOOKING  ──► unit BOOKED, lead TERMINAL
                                                          │
                                          ┌───────────────┴───────────────┐
                                          ▼                               ▼
                            RESALE / RENTAL opportunity        ATTRIBUTION: spend → revenue
                              (investor bookings)               (first-touch or last-touch)
```

Three ideas hold the whole thing together:

| Idea | Meaning |
|---|---|
| **One contact per mobile number** | The normalized mobile is the identity key. A person who inquires five times is one contact with five inquiries — never five contacts. |
| **A lead is one opportunity, not one person** | The same contact can have a live lead on Project A and a booked lead on Project B at the same time. |
| **An active lead always has a next action** | Enforced in one function. Every path that closes a piece of work goes through it, so no new feature can bypass it. |

---

## 3. Vocabulary — every entity, defined

### Organization and people

| Term | Definition | Where it lives |
|---|---|---|
| **Tenant / Organization** | One real estate developer. The isolation boundary — every record carries a `tenantId` and no query may cross it. Holds timezone, currency, locale, calling code, and all operational settings. | `db/models/Tenant.js` |
| **Settings** | Tenant-level switches: attribution model, all five SLA thresholds, business hours, block duration, auto-stage-on-visit, QR channel-partner rules, whether a re-inquiry restarts the SLA clock. | `Tenant.settings` |
| **User** | One person who logs in. Statuses: `INVITED` (link sent, no password yet) → `ACTIVE` → `SUSPENDED` / `INACTIVE`. A non-active user cannot log in, but all their history stays attached to their name. Users are never deleted. | `db/models/User.js` |
| **Role** | A named permission set. Five ship by default; all are editable, renameable and cloneable. `isAdmin: true` short-circuits every permission check. | `db/models/Role.js`, `lib/permissions.js` |
| **Permission** | One capability key, e.g. `unit.block`. Most are booleans. Three are **scoped**: `lead.view`, `contact.view`, `report.view` resolve to `own` / `team` / `all`. | `lib/permissions.js` |
| **Data scope** | `own` = records you own. `team` = you plus your direct reports (`managerId` points at you). `all` = the whole organization. Resolved server-side on every request. | `lib/access.js` |
| **Assignment pool** | The round-robin rotation: an ordered list of member users, an escalation list, and a cursor. One default pool per organization; optional per-project pools override it. | `db/models/AssignmentPool.js` |

### The customer

| Term | Definition |
|---|---|
| **Contact** | The master identity of a human being. Keyed by `normalizedMobile` (E.164, e.g. `+919876543210`). Holds name, alternate mobile, emails, city/state/pincode/address, tags, owner, consent flags, and rolled-up `inquiryCount` / `lastInquiryAt` / `lastActivityAt`. Archived, never deleted. |
| **Tag** | A free-form label on a contact (`Investor`, `NRI`, `Channel Partner`…). Tenant-managed, case-insensitively unique, used for segmentation. |
| **Consent** | Four flags per contact: `whatsappOptOut`, `smsOptOut`, `emailOptOut`, and `dnd` (blocks everything). Campaign and nurture sends respect them; acknowledgements and manual one-off messages do not (they are operational, not marketing). |

### The opportunity

| Term | Definition |
|---|---|
| **Lead** | One sales opportunity, linked to exactly one contact and optionally one project. Carries requirement (budget range, configurations, facing, floor range, area range, purpose), source history, SLA measurement fields, denormalised next-action fields, and counters. |
| **Inquiry touch** | An immutable record of one inbound inquiry event: which source, which campaign, which ad/adset/form, landing URL, UTM tags, the message, and whether it was the first touch. Many touches per lead. This is what makes multi-touch attribution possible and reversible. |
| **Lead source** | Where the inquiry came from (`Facebook Ads`, `99acres`, `Walk-in`…). Each has a **category** (`META`, `GOOGLE`, `PROPERTY_PORTAL`, `WEBSITE`, `QR`, `WALK_IN`, `REFERRAL`, `MANUAL`, `API`…) that drives capture routing and reporting. |
| **Source history** | Three fields that are written once and never overwritten: `originalSourceId` (where they first came from) and `sourceId`, plus `latestSourceId` which is the only one that moves on a re-inquiry. |
| **Re-inquiry** | The same contact inquiring again. See §6.2 for the exact decision tree — same project vs other project vs already-lost vs already-booked all behave differently. |
| **Lead temperature** | V1.1 §14. `HOT` / `WARM` / `COLD`, scored 0–100 from recorded activity, with every contributing signal listed. **Not the same as priority** — priority is a manual queue-sort control, temperature is a read of the deal. A brand-new unattended lead is always WARM, never COLD; a closed lead shows Booked or Lost instead. An authorized user can pin it manually with a reason, and hand it back to automatic scoring. |
| **Stage history** | V1.1 §18. An entered/exited row per stage, which is what lets the funnel tell "went through Site Visit Planned" from "Site Visit Planned merely sorts earlier". |
| **Stage funnel** | V1.1 §17. The journey strip on the lead workspace: ✓ completed · ● current · ○ future, with genuinely skipped stages struck through. Lost is drawn as an exit branch, not as a step everyone walks through. |
| **Stage** | The tenant-configurable pipeline step (`New Lead`, `Connected`, `Site Visit Done`, `Booked`, `Lost`…). Renameable and reorderable. |
| **Semantic type** | The machine-readable meaning behind a stage: `NEW`, `NOT_CONNECTED`, `CONNECTED`, `VISIT_PLANNED`, `VISIT_DONE`, `BLOCKED`, `BOOKED`, `LOST`. **Automation resolves stages by semantic type, never by name**, so renaming "Connected" to "Spoke to customer" breaks nothing. |
| **Terminal stage** | A stage that ends the lead (`Booked`, `Lost`). Sets the lead's `status` to `TERMINAL`, cancels all pending follow-ups, and is the only case where a next action is not required. |
| **Sub-stage** | A required or optional qualifier under a stage: `Not Connected → No Answer / Busy / Switched Off / Wrong Number`, `Lost → Budget / Location / Competitor / …`. A sub-stage must belong to the stage it is saved with. A `Lost` stage always demands one — that is the lost reason. |
| **Status** | Derived from the stage: `ACTIVE` or `TERMINAL`. Denormalised onto the lead so queues filter without a join. |

### The work

| Term | Definition |
|---|---|
| **Action type** | A kind of interaction that can be scheduled or logged: `Call`, `WhatsApp`, `Meeting`, `Site Visit`, `Send Cost Sheet`, `Send Brochure`, `Video Call`, `Email`, `Other`. Each has a `semantic` that decides which timeline event it produces. |
| **Follow-up** | One scheduled piece of work: action type + due date/time + assignee + note + priority. Statuses: `PENDING` → `COMPLETED` / `CANCELLED`, or `MISSED` once its due time passes while still pending. |
| **Next action** | The pending follow-up furthest forward in time on a lead, denormalised onto the lead as `nextFollowupId` / `nextActionAt` / `nextActionTypeId`. **This is the field the entire product defends.** |
| **First genuine action** | The first time a real outcome was recorded on a lead *and* a next action was set. Clicking a phone icon does not count. Stored as `firstGenuineActionAt`, and it is what stops the SLA clock and clears the lead from the New Leads tile. |
| **Activity / timeline** | The append-oriented chronological log of everything that happened to a lead: creation, assignment, calls, notes, stage changes, visits, shortlists, cost sheets, blocks, bookings, SLA warnings, nurture sends, acknowledgements. |
| **Note** | A free-text internal timeline entry. `@Name` in the body resolves to a real user and fires a notification with a deep link. |
| **Site visit** | A planned or completed visit, with project, date/time, sales user, visitor count, `visitingWith` (`DIRECT` or `CHANNEL_PARTNER`), units shown, and an outcome. Statuses: `PLANNED` / `CONFIRMED` / `IN_PROGRESS` → `COMPLETED` / `CANCELLED` / `NO_SHOW`. A lead can have many visits across many projects. |
| **Visit outcome** | Required when a visit is completed (`Highly Interested`, `Budget Mismatch`, `Not Interested`…). Each is flagged `isNegative` or not, which the AI reads as an objection. |

### The real estate

| Term | Definition |
|---|---|
| **Project** | A development. Holds identity (name, developer, RERA), location, commercials (starting price, configurations, area range, possession date), marketing content (overview, USPs, amenities, highlights, media), a **QR token** for the walk-in form, a **slug** for the mini site, and mini-site display switches. Statuses: `DRAFT` / `ACTIVE` / `ON_HOLD` / `SOLD_OUT` / `ARCHIVED`. Only `ACTIVE` projects can publish a mini site. |
| **Tower** | A tower/block/wing/phase/cluster inside a project. Creating one with a `floorCount` auto-creates that many Floor records. |
| **Floor** | One level inside a tower. |
| **Unit type** | A configuration (`2 BHK`, `3 BHK`, `Shop`) with carpet / built-up / super built-up areas and a default base rate. |
| **Unit** | One sellable asset: unit number (unique within its tower), floor number, three area figures, facing, view, PLC category, parking slots, optional per-unit rate or absolute value override, and **status**. |
| **Unit status** | `AVAILABLE` → `HOLD` (internal, informal) → `BLOCKED` (held for a specific lead, with an expiry) → `BOOKED` → `REGISTERED`, plus `NOT_FOR_SALE`. The full legal transition table is in [FUNCTIONALITY.md](FUNCTIONALITY.md#unit-status-state-machine). |
| **Shortlist** | A lead's list of units of interest. Adding or removing one **never** changes unit status — it is a note about intent, not a hold. |
| **Pricing component** | One line of the rate card: `BASE`, `FLOOR_RISE`, `PLC`, `VIEW`, `PARKING`, `MAINTENANCE`, `CORPUS`, `CLUB`, `INFRASTRUCTURE`, `TAX`, `STAMP_DUTY`, `REGISTRATION`, `OTHER`. Each has a calc type (`FIXED`, `PER_AREA`, `PERCENTAGE`, `PER_UNIT_COUNT`), an area basis, applicability filters (unit types, towers, floor range, effective dates) and visibility flags. |
| **Cost sheet / Quotation** | A **versioned, server-computed** price quotation for one lead + one unit. Never edited after sharing — a change produces v2 and marks v1 `SUPERSEDED`. Statuses: `DRAFT` / `APPROVAL_PENDING` / `APPROVED` / `REJECTED` / `SHARED` / `SUPERSEDED`. V1.1 calls it a **Quotation** everywhere in the UI, gives it a readable number (`QTN-RFH-2026-00042`), and freezes the payment schedule onto it. The database model is still `CostSheet`. |
| **Payment plan snapshot** | V1.1 §44. The milestone rows as they stood when a quotation was issued, copied onto the quotation itself. Editing the project's plan afterwards cannot change a number a customer is already holding. |
| **Discount approval** | A sign-off request raised automatically when a cost sheet's discount crosses a configured threshold. The approver can only approve/reject/request-change — never edit the numbers. Nobody self-approves unless their role explicitly allows it. |
| **Unit block** | A time-boxed hold of one unit for one lead, with an expiry timestamp stored on the record, an optional token amount and an optional linked cost sheet. Statuses: `ACTIVE` → `RELEASED` / `EXPIRED` / `CONVERTED`. |
| **Booking** | The sale. Freezes the final price, discount, payment plan, salesperson and the full attribution snapshot at the moment of sale. |
| **Payment plan** | A named schedule (`Construction linked`, `Down payment`, `Flexi`, `Custom`) with **structured milestone rows** — sequence, label, percentage, due rule, offset days (V1.1 §35). A plan whose rows do not total exactly 100% cannot be active; a plan with no rows at all is a legacy V1 plan, still selectable, labelled "Schedule not configured". The CRM still does not run receivables. |
| **Project asset** | V1.1 §31. An uploaded image or document on a project, with a category, a `customerVisible` flag and, for documents, an `aiUsable` flag. Internal by default. Archived, never deleted. |
| **Buyer purpose** | Why they bought: `SELF_USE`, `INVESTMENT`, `RENTAL_INCOME`, `OTHER`. Investment and rental bookings automatically create future opportunities. |
| **Resale / rental opportunity** | A light follow-up queue created from an investment or rental-income booking, with the expected exit/rental date, expected price/rent and an assigned owner. Reminders fire at 90, 60 and 30 days out. |

### Marketing and communication

| Term | Definition |
|---|---|
| **Marketing campaign** | An ad campaign with **spend**: platform (`META`, `GOOGLE`, `LINKEDIN`, `PROPERTY_PORTAL`, `OFFLINE`, `OTHER`), optional project, dates, `spendMinor`, external campaign id and tracking code. Entered manually or synced. |
| **Attribution model** | Tenant-wide choice between `FIRST_TOUCH` and `LAST_TOUCH`. **Nothing is rewritten when you switch** — attribution is derived from the stored touch history on every read, so both answers are always available. |
| **Communication campaign** | A WhatsApp / SMS / email blast to a filtered contact audience, using a template. Statuses: `DRAFT` / `SCHEDULED` / `SENDING` / `SENT` / `PAUSED` / `FAILED`. |
| **Saved segment** | A named, reusable audience filter. Evaluated fresh every time (dynamic); the campaign that sends to it keeps its own recipient counts so "who did we message" stays answerable. |
| **Template** | Reusable message content with `{{contact.first_name}}`-style placeholders and optional `{{project.name\|our projects}}` fallbacks. Purposes: `ACKNOWLEDGEMENT`, `CAMPAIGN`, `NURTURE`, `GENERAL`. |
| **Acknowledgement rule** | "When a lead arrives for project X from source Y, send template Z on channel C, falling back to channel C2." Most specific rule wins: project+source → project → source → catch-all. |
| **Nurture sequence** | A simple cadence, not a workflow canvas. Matched on project + stage (+ optional sub-stage), with steps that each wait N days then either send a templated message or create a task for the lead's current owner. Stops on booked / lost / a configured stage / contact DND. |
| **Message log** | One record per attempted send: channel, purpose, recipient, rendered body, provider, provider message id, and lifecycle status `QUEUED` → `SENT` → `DELIVERED` → `READ` → `REPLIED`, or `FAILED` / `SKIPPED` (with the reason it was skipped). |
| **Integration** | A connected external system: messaging providers (WhatsApp/SMS/email), inbound lead sources (Meta Lead Ads, Google Ads, portals, website), telephony. Holds a driver name, encrypted secrets, an unguessable `webhookKey`, defaults, and live health state. |
| **Webhook event** | The raw stored copy of every inbound webhook delivery, with an `idempotencyKey` uniquely indexed so a provider retry can never create a second lead. |

### System

| Term | Definition |
|---|---|
| **Notification** | An in-app alert for one user: type, title, body, deep link, severity (`INFO` / `WARNING` / `CRITICAL`), read state. |
| **Audit log** | An append-only record of sensitive changes with before/after values, actor, IP, user agent and session id. Read-only in the app — nothing can edit or delete it. |
| **SLA rule** | Response thresholds. Organization defaults live on tenant settings; a per-project `SlaRule` overrides them. The resolved target is **stamped onto the lead at capture**, so editing the rule later never rewrites history. |
| **Business event** | An internal pub/sub signal (`lead.assigned`, `booking.created`, `unit.block_expiring`…). Notifications, nurture and downstream automation subscribe; a failing listener can never fail the sale action that emitted it. |

---

## 4. Installation and first run

### Prerequisites

- Node.js 20+ (uses `node --test`, `node --watch`, `crypto.timingSafeEqual`, native `Intl`)
- MongoDB 6+ running locally or reachable by URI

### Install

```bash
npm install
cp .env.example .env
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` refuses to boot with the default session secret and enables secure cookies + 7-day static caching. |
| `PORT` | `3000` | HTTP port. |
| `APP_URL` | `http://localhost:3000` | Used to build invite links, mini-site URLs and cost-sheet share links. Must be the externally reachable URL. |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/real_estate_crm` | Database. Point at a replica set to enable real transactions (see §11). |
| `SESSION_SECRET` | `dev-only-insecure-secret` | Session signing key. **Mandatory in production.** |
| `SESSION_MAX_AGE_MS` | `43200000` (12 h) | Rolling session lifetime. |
| `SECRETS_KEY` | derived from `SESSION_SECRET` | AES-256-GCM key for sealing integration secrets. Set it explicitly in production so rotating the session secret does not orphan stored secrets. |
| `SCHEDULER_TICK_MS` | `60000` | How often background jobs run. |
| `UPLOAD_DIR` | `public/uploads` | Upload destination. |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MB) | Upload size cap. |

### Seed and run

```bash
npm run seed     # creates the "Skyline Developers" demo organization
npm run dev      # http://localhost:3000  (auto-restarts on change)
npm start        # production start
```

`npm run seed` is safe to re-run — it does nothing if the demo tenant already exists.

Demo logins, password `Password1`:

| Email | Role | Sees |
|---|---|---|
| `admin@skyline.test` | Organization Admin | everything, including all setup |
| `manager@skyline.test` | Sales Manager | own + direct reports' work, team exceptions |
| `priya@skyline.test` | Sales User | only their own leads |
| `vikram@skyline.test` | Sales User | only their own leads |

The seed also builds a working dataset: a priced 4-tower project with 24 generated units,
two ad campaigns with spend, five captured leads in different journey states (new, worked,
visited, booked), a completed visit, a cost sheet, a block, a real booking with a resale
opportunity, and one deliberately overdue follow-up so the Missed tile is not empty.

### What happens at boot

`src/server.js` does four things before listening:

1. connects to MongoDB;
2. **waits for indexes to build** — uniqueness rules here are business rules (one contact
   per mobile, unique unit number), so a fresh database must not accept a duplicate in the
   window before its unique index exists;
3. registers event listeners (notifications, nurture);
4. starts the in-process scheduler.

It then logs which transaction mode is active. `GET /healthz` reports the same.

---

## 5. Setup order — configuring an organization from zero

A brand-new tenant already receives working defaults (§78): 8 stages with sub-stages, 9
action types, 8 visit outcomes, 17 lead sources, 6 tags, 5 roles, two acknowledgement
templates with an active WhatsApp→SMS rule, three simulated messaging providers, and a
ready inbound webhook endpoint. So the list below is *refinement*, not from-scratch data
entry — but doing it in this order avoids re-work, because each step feeds the next.

### Step 1 — Organization (`/app/setup/organization`)

Name, legal name, **timezone**, **currency**, **locale**, website, address.

Set timezone first. Every "today" boundary on every dashboard, tile and report resolves
through it, and every date/time you type into a form is interpreted in it. Currency and
locale drive all money formatting (`en-IN` gives you lakh/crore short forms).

### Step 2 — Roles (`/app/setup/roles`)

Review the five defaults. Clone one rather than editing a shipped role if you want a
variant. Inside a role, each permission is a checkbox — except the three scoped ones,
which are dropdowns (`none` / `own` / `team` / `all`).

Two permissions worth deliberate thought:

- `discount.approve_own` — allows self-approval. Off everywhere by default, intentionally.
- `inventory.view_prices` — a user without it sees inventory but no prices anywhere,
  including in AI answers.

### Step 3 — Users (`/app/setup/users`)

Invite by name + email + role + manager. The manager link is what makes `team` scope mean
anything: a Sales Manager sees themselves plus everyone whose `managerId` points at them.

No email provider is configured out of the box, so the **activation link is displayed on
screen once** after inviting. Copy it and send it. It expires in 7 days. The invitee sets
their own password at that link and becomes `ACTIVE`.

Deactivating a user is blocked while they still own active leads or pending follow-ups —
the system tells you how many and makes you transfer them first, so open work is never
silently orphaned.

### Step 4 — Stages and sub-stages (`/app/setup/stages`)

Rename freely; the semantic type is what automation uses. For each stage set:

- **Semantic type** — the meaning. Leave `Booked` and `Lost` mapped as terminal.
- **Terminal** — ends the lead. Automatically forces "requires next action" off.
- **Requires sub-stage** — e.g. `Not Connected` and `Lost` should both require one.
- **Requires next action** — leave on for every active stage.

A stage cannot be deactivated while active leads sit in it; the error tells you how many.

### Step 5 — Master data (`/app/setup/action-types`, `/visit-outcomes`, `/sources`, `/tags`)

Four flat lists sharing one screen pattern. Add, reorder by display order, and
**deactivate — never delete**, so history stays readable.

- Action types carry a **behaviour** (`semantic`) that decides the timeline event produced.
- Lead sources carry a **category** that drives capture routing and reporting grouping.

### Step 6 — Response SLA (`/app/setup/sla`)

Organization defaults, in minutes:

| Setting | Default | Meaning |
|---|---|---|
| Response target | 5 | The number SLA compliance is measured against. |
| Warning | 5 | Owner is nudged. |
| Escalation | 10 | Marked breached; managers are told. |
| Auto-reassign | 15 | Handed to the next user in the rotation. |
| Max auto-reassignments | 2 | Cap, so a lead cannot ping-pong forever. |
| Business hours only | off | When on, the clock only counts working seconds. |
| Business hours | 09:30–19:00, Mon–Sat | The working window. |
| Re-inquiry restarts SLA | on | A re-inquiry on an unattended lead restarts the response clock. |

Thresholds must run in order: warning ≤ escalation ≤ auto-reassign. The form refuses
otherwise. Per-project overrides are added on the same screen and beat the defaults.

### Step 7 — Lead allocation (`/app/setup/lead-allocation`)

The default assignment pool is created with the organization. On this screen you can see
and edit what was previously invisible database state:

- **Members, in rotation order** — reorder with the ↑↓ buttons; the order *is* the rotation.
- **Next assignments** — a read-only preview of who gets the next six leads. Looking at it
  never advances the cursor, and the cursor itself is deliberately not editable: "who is
  next" is a consequence of the rotation, not a setting.
- **Escalation users** — who hears about unassignable leads and SLA breaches.
- **Project rules** — one active rule per project, taking precedence for that project's leads.

Members who are later suspended stay listed but are flagged and skipped at assignment time,
so a broken rotation is visible rather than silent.

**The fallback chain** (V1.1 §72): project rule → default pool → Unassigned. If a project's
rule has no eligible member the default pool takes over and the fallback is logged, rather
than the project's leads falling into a hole.

### Step 8 — Templates and acknowledgement (`/app/setup/templates`)

Write templates per channel. Available placeholders:

```
{{contact.first_name}} {{contact.last_name}} {{contact.name}} {{contact.mobile}} {{contact.email}}
{{project.name}} {{project.city}} {{project.mini_site_url}}
{{owner.name}} {{owner.mobile}} {{owner.email}}
{{organization.name}}
```

Any placeholder accepts a fallback after a pipe: `{{project.name|our projects}}` — a
generic inquiry has no project, and "thanks for your interest in ." is not worth sending.

Then create acknowledgement rules: project + source + channel + template, with a fallback
channel and template. Resolution is most-specific-wins.

### Step 9 — Integrations (`/app/setup/integrations`)

Add a provider per category. Inbound categories (`META_LEAD_ADS`, `GOOGLE_ADS`,
`LINKEDIN_ADS`, `PROPERTY_PORTAL`, `WEBSITE_WEBHOOK`) automatically get a **webhook key**,
producing a URL to paste into the provider:

```
POST {APP_URL}/api/webhooks/leads/{webhookKey}
```

Set a **default project** and **default source** on the integration so payloads that omit
them still land correctly. If the provider signs its payloads, paste the signing secret —
it is sealed with AES-256-GCM on the way in and is never rendered again, only masked.

The key can be rotated at any time; rotating invalidates the old URL immediately.

### Step 10 — Projects: the guided stepper (`/app/projects/new`)

V1.1 turns project setup into seven steps. Step 1 saves a **draft** immediately — the
project gets its id, QR token and mini-site slug straight away, so everything after it has
somewhere to live. You can leave and resume at any step via `?step=…`.

| Step | What it holds |
|---|---|
| 1 · Basics | Name, developer, code, type, property types, RERA, possession, overview |
| 2 · Location | Address, landmark, city, state, pincode, coordinates, map URL |
| 3 · Sales & configuration | Starting price, area range, sales contact, booking terms, USPs, amenities, and **structured unit types** |
| 4 · Media & documents | Images (cover, gallery, master plan, floor plan, location map, amenity, construction) and documents (brochure, RERA certificate, legal, price list, specifications, approved plan, sales kit) |
| 5 · Towers & units | Towers with auto-created floors, then unit generation |
| 6 · Pricing & payment plans | Pricing components and structured payment schedules |
| 7 · Mini site & review | Readiness summary, status, mini-site controls, walk-in QR |

**Unit generation always previews first** (V1.1 §32.2). You see every unit number the
pattern would produce, floor by floor, with existing numbers struck through as "will be
skipped", and only then confirm. `{floor}{index:02}` gives `301, 302, 303, 304`;
`{tower}-{floor}{index:02}` gives `A-301`.

**Media and documents** are internal by default. `Customer visible` is what lets a file
reach a mini site or a quotation; documents additionally carry `AI usable`, which decides
whether the grounded assistant may read them. Files are archived, never deleted, so a
quotation already shared keeps resolving. Uploads are validated on the server by MIME type
against the declared kind — the browser's `accept` attribute is a hint to the user, not a
control.

**Payment plans** need a schedule that totals exactly 100% before they can be active. A V1
plan that is only a name stays selectable and is labelled "Schedule not configured", so
nothing that already worked stops working.

**Readiness** (step 7) lists every gap: blocking items with ✕, recommendations with !.
It **warns rather than blocks** — you can activate and even publish an incomplete project,
because pre-launch marketing pages for projects with no inventory yet are a real workflow.
The gaps are named; the decision is yours.

### Step 11 — Nurture sequences (`/app/setup/nurture`)

Optional. Name it, scope it to a project and/or stage, add steps (delay in days + either a
message template or a task action type), and set stop conditions. Leads enroll
automatically on stage change.

### Step 12 — Marketing campaigns (`/app/campaigns/performance`)

Add each ad campaign with its spend so attribution has a denominator. Choose the
organization's attribution model (first touch or last touch) on the same screen.

### Setup dependency rules

Two rules apply everywhere in setup:

- **Deactivate, never delete.** Anything that could appear in history is toggled inactive
  so old records stay readable.
- **Blocked while in use.** Stages holding active leads and users holding open work cannot
  be deactivated; the error tells you exactly what to move first.

---

## 6. The full journey — connected, step by step

This is the "if it's connected, then when and where and what next" section. Each step
states the **trigger**, what the system **writes**, what it **notifies**, and what the
human **must do next**.

### 6.1 Capture — a lead arrives

**Four entry points, one code path.** A webhook delivery, a QR walk-in, a mini-site
inquiry and manual entry all converge on the same capture service, so they cannot drift
apart in behaviour.

What happens, in order:

1. **Normalize the mobile.** No valid mobile → the inquiry is rejected with a friendly
   error. This is non-negotiable: without an identity key there is no deduplication.
2. **Resolve the source.** By explicit id, then by name, then by category. If nothing
   matches, a source is *created* rather than dropping an inbound inquiry.
3. **Resolve the project.** By id, then by name. May legitimately be none.
4. **Find or create the contact** by normalized mobile. If found, blank fields are
   enriched from the payload — an inbound payload never overwrites something a human
   already corrected.
5. **Decide: new lead or re-inquiry?** (see 6.2).
6. For a genuinely new lead: create it in the `NEW` stage, write the first
   **inquiry touch**, increment the contact's inquiry count, log `LEAD_CREATED`.
7. **Start the SLA clock** — the resolved target is stamped onto the lead as
   `slaTargetSeconds`, so a later rule change cannot retroactively rewrite this lead.
8. **Assign** by round robin, if unowned (see 6.3).
9. **Acknowledge** the customer (see 6.4).

**Where it lands:** on the owner's dashboard, in the **New leads** tile.
**What next:** the owner must record a first genuine action (6.5).

### 6.2 Re-inquiry — the same person comes back

The decision tree, evaluated only when the contact already exists:

| Existing lead for the same project | What happens |
|---|---|
| An **active** lead exists | Attach a touch to it. `latestSourceId` and `lastTouchCampaignId` move; `originalSourceId` and `firstTouchCampaignId` never do. The lead is flagged `reinquiryPendingAt` and appears on the **Re-inquiries** tile. |
| A **lost** lead exists | The same, plus the lead is revived: status back to `ACTIVE`, stage back to `NEW`, with `LEAD_REOPENED` on the timeline. The lost history stays intact. |
| A **booked** lead exists | Left completely alone. A brand-new lead is created — this is a genuine second purchase conversation. |
| Inquiry is for a **different project** | A brand-new lead. Same contact, separate opportunity. |

If "re-inquiry restarts SLA" is on and the lead has still never been genuinely attended,
the response clock restarts. If the lead is unowned, round robin assigns it.

**Where it lands:** the **Re-inquiries** tile.
**What next:** working the lead (logging any action) clears it from that tile.

### 6.3 Distribution — who gets the lead

Round robin over the project pool if one exists, otherwise the organization default pool.

- Only `ACTIVE` members are eligible; suspended and inactive users are skipped.
- The rotation cursor is advanced with a **single atomic increment**, so two leads captured
  in the same millisecond read different cursor values and can never land on the same
  person by accident. (Verified by a 9-way concurrency test.)
- Manual transfers deliberately do **not** move the cursor.
- **Nobody eligible?** The lead stays in the Unassigned queue, the SLA clock keeps running,
  and the pool's escalation users (or all admins) get a `CRITICAL` notification linking
  straight to `/app/leads?unassigned=1`.

On assignment: `assignedAt` is stamped, `slaStatus` resets to `PENDING`, a `LEAD_ASSIGNED`
timeline entry is written, and the new owner is notified.

### 6.4 Acknowledgement — the customer hears back immediately

The most specific matching rule (project+source → project → source → any) fires a templated
message on its channel. If it fails or is skipped, the **fallback channel** is tried.

Either way, the outcome lands on the lead's timeline as `ACKNOWLEDGEMENT_SENT` or
`ACKNOWLEDGEMENT_FAILED` with the reason. A messaging failure **never** blocks lead
creation, and the failing integration is flagged `ATTENTION_REQUIRED` and surfaced on
`/app/setup/health`.

### 6.4b The phone rings — dashboard search

**Where:** the search bar at the top of `/app/dashboard`. A customer calls; the salesperson
types the number while it is still ringing.

An **exact normalized mobile** is looked up **tenant-wide** — the one deliberate widening of
data scope in the product, because "does this person already exist and who owns them" has
to be answerable or the team creates duplicate contacts. It widens *visibility of
ownership*, not access:

| Who is asking | What they get |
|---|---|
| The owner, or anyone whose scope covers the lead | The full result card, with an Open lead button |
| Any other salesperson on own-only scope | Name, project, stage, owner, and the sentence *"This lead belongs to another sales user."* — no timeline, notes, pricing, requirement or source history |
| Another tenant | Nothing. Ever. |

Fuzzy name search keeps normal scope. Mobile search fires after 4 digits, text after 2, both
debounced. **No match on a real mobile** offers *Create new lead* with the number prefilled.

### 6.5 The first genuine action — the moment that matters

**Where:** the New leads tile, or the lead workspace. The quick-action drawer opens with
these fields, in this order:

| Field | Required | Meaning |
|---|---|---|
| What did you do | yes | Action type — call, WhatsApp, meeting… |
| Outcome | conditional | Sub-stage. Required if the resulting stage demands one. |
| Move to stage | no | Where the lead ends up. Defaults to staying put. |
| Note | no | What was said. |
| **Next action type** | **yes, unless closing** | The gate. |
| **Next date + time** | **yes, unless closing** | Must be in the future. |
| Next note | no | Context for future-you. |

Saving runs one function — `services/followups.js applyOutcome()` — in a deliberate order,
because a standalone MongoDB has no multi-document transactions:

1. Work out the resulting stage; validate the stage/sub-stage pair.
2. **Validate the next action before writing anything.** If it is missing or in the past,
   nothing at all is written and the user sees
   *"Set the next action before saving — an active lead cannot be left without one."*
3. **Create the next follow-up first.**
4. Close the current follow-up (if this was completing one), recording whether it was
   completed on time.
5. Write the interaction and outcome to the timeline.
6. Move the stage, if the outcome caused one.
7. Re-sync the lead's denormalised next-action fields, then **stop the SLA clock**.

That ordering means an interrupted run can only ever leave one harmless extra pending
follow-up — never an attended active lead with no next action.

Quick date presets — *Later today · Tomorrow · +2 days · +7 days* — fill the date in one
tap; the server still validates the real timestamp.

**Effects:** `firstGenuineActionAt` and `firstResponseSeconds` are set;
`slaStatus` becomes `WITHIN_SLA` or `BREACHED`; the pulsing NEW badge stops; the lead
leaves the New leads tile and appears in **Today's follow-ups** (or a future day's); the
stage funnel advances; and automatic temperature scoring starts.

There is deliberately **no standalone "change stage" form** any more (V1.1 §92). A stage
change without a recorded outcome and a next action is exactly the disconnected update this
release exists to remove — it happens in this one drawer or not at all.

**Important:** a lead that already breached stays breached even if a new owner answers
quickly after a reassignment. A reassignment restarts the clock, not the history.

### 6.6 The follow-up loop — daily work

**Today's follow-ups** = pending, due inside today in the tenant's timezone.
**Missed** = pending or missed, already past due. Sorted overdue-first, then by due time,
then by lead priority.

From a queue row you can, without leaving the page:

| Action | Result |
|---|---|
| Complete | Opens the same drawer as 6.5. Requires an outcome and a next action. |
| Reschedule | Moves the due date/time. Must be in the future. Lead stays active with a next action. |
| Cancel | Closes the follow-up. If the lead is still active it now has **no** next action — the flash message says so explicitly and the lead resurfaces as work. |

After completing from a queue, you land **back on the same queue**, not on the lead — the
`returnTo` parameter carries the origin so momentum is not broken.

### 6.7 Site visit

**Scheduling** (from the lead workspace): project, date, time, sales user, direct or with a
channel partner (name, and mobile if the organization requires it), visitor count, notes.

If "auto-stage on visit" is on, the lead moves to the `VISIT_PLANNED` stage. The assigned
sales user is notified if it is not the person scheduling.

**Completing** requires, in order:

1. **Outcome** — mandatory, from the visit outcomes master.
2. Notes; units shown; units to shortlist right now.
3. **The next action** — validated *before* the visit is marked complete, so a rejected
   next action leaves the visit still open rather than half-closed.

On completion the lead's completed-visit counter increments, selected units are
shortlisted, `VISIT_COMPLETED` lands on the timeline, and — if auto-stage is on — the lead
moves to `VISIT_DONE`, all through the same `applyOutcome()` gate.

Cancelling offers a **no-show** flag, which is recorded distinctly from a cancellation.

### 6.8 Shortlist

Available and held units can be shortlisted, as can a unit already blocked *for this same
lead*. Anything booked, registered or blocked for someone else is refused by name:
*"Unit A-401 is booked and cannot be shortlisted."*

Removing a shortlist entry **never** changes inventory status.

### 6.9 Quotation — the price

**Four visible steps** (V1.1 §39): select unit → payment plan → price & discount → save.
The unit step is a real picker — shortlisted units first, then filterable available
inventory with tower, configuration, facing and status filters. Nobody types a unit id.

Choosing a payment plan shows the schedule with **real amounts**, not just percentages:

```
Final consideration ₹67,60,000 · Construction linked
  10%  On booking      ₹6,76,000
  40%  Plinth         ₹27,04,000
  40%  Structure      ₹27,04,000
  10%  Possession      ₹6,76,000
                      ──────────
                      ₹67,60,000
```

Amounts are computed in integer minor units and **the last milestone absorbs the rounding
remainder**, so the schedule always totals the consideration exactly — which is the only
property a customer will actually check.

Saving **freezes the plan onto the quotation** (V1.1 §44). Editing the project's payment
plan afterwards cannot change a number a customer is already holding. The quotation also
gets a readable number — `QTN-<project code>-<year>-<sequence>` — for use on the phone.

**Every price in this product comes from one engine.** The browser may display a total; it
never supplies one.

Calculation order:

```
1. charge components   base, floor rise, PLC, parking, club, infrastructure…
2. gross               = sum of those
3. discount            capped at gross, so it can never go negative
4. tax components      charged after the discount, on their configured base
5. FINAL CONSIDERATION = gross − discount + tax
```

Stamp duty and registration are **informational**: shown to the customer, never rolled into
the final consideration.

Per-unit overrides beat the rate card: `baseValueOverrideMinor` beats `baseRateMinor`,
which beats the unit type's default rate, which beats the component rate.

Saving a sheet:

- computes totals server-side and stores every line as it stood at that moment;
- assigns **version 1**, or version N+1 marking the previous one `SUPERSEDED`;
- invalidates any pending approval on the superseded version — a granted approval does not
  carry over to new numbers;
- checks the discount against approval rules and, if one matches, raises the request and
  parks the sheet in `APPROVAL_PENDING`.

### 6.10 Discount approval

The first matching rule by threshold wins, with project-specific rules beating
organization-wide ones at the same level. Approvers are: the rule's named users → all
active users in the rule's approver role → anyone holding `discount.approve`.

At `/app/approvals`, an approver sees the requested figures and can **approve**, **reject**
or **request change** with a note. They cannot edit the numbers — the discount that was
requested is the discount that gets locked in. Self-approval is refused unless the role
carries `discount.approve_own`.

| Decision | Cost sheet becomes | Requester is |
|---|---|---|
| Approve | `APPROVED` with approver + timestamp | notified `INFO` |
| Reject | `REJECTED` — create a new version to try again | notified `WARNING` |
| Request change | back to `DRAFT` | notified `WARNING` |

### 6.11 Sharing a cost sheet

Sharing mints an unguessable token and locks the version. A sheet that is pending approval,
rejected, or superseded cannot be shared, and one that required approval must actually
carry it.

The customer opens `{APP_URL}/share/cost-sheet/{token}` — no login, no session, read-only,
and it stops resolving once a newer version supersedes it.

### 6.12 Blocking a unit

**Where:** the Block unit CTA on the lead, or *Block this unit* on a valid quotation. It
opens a picker (shortlisted units, then filterable inventory), then a commercial step that
preselects the live quotation for that unit — approved, else shared, else any bookable one —
and **states the deadline before you confirm**:

> Block valid until **18 Aug 2026 · 6:30 PM** — from this project's block rule.
> You are blocking A-804 for Rahul Shah until then.

Overriding the duration needs `unit.override_block_expiry`.

**The most contended operation in the product.** Everything that can be validated is
validated first — lead is open, unit exists, cost sheet belongs to this lead and this unit
and is bookable — and only then does the unit move.

The move itself is a **single atomic conditional update**: `AVAILABLE`-or-`HOLD` →
`BLOCKED`, only if it is still in one of those states. Two users clicking Block on the same
unit at the same instant produce exactly one block and one friendly message for the loser:

> *"This unit was just blocked by another user. Refresh inventory and select another unit."*

If writing the block record then fails, the unit is handed straight back to inventory
rather than being left blocked with no block behind it.

On success: the expiry deadline is **computed and stored now** (project override → tenant
default → 48 h), the lead moves to the `BLOCKED` stage through the action (not a dropdown),
and `UNIT_BLOCKED` lands on the timeline with the deadline.

### 6.13 Block expiry

| When | What happens |
|---|---|
| Inside the reminder window (default 6 h before expiry) | The person who blocked it gets a `WARNING` notification; a reminder entry lands on the timeline. Sent once. |
| At expiry | The block becomes `EXPIRED`, the unit returns to `AVAILABLE`, the lead's active-block link is cleared, and the owner gets a `CRITICAL` notification: *"The unit is back in inventory. The lead still needs a next action."* |

Both sweeps are idempotent — a repeated run cannot double-remind or double-release.
The lead stays **active** throughout; losing a block is not losing a customer.

### 6.14 Booking — "Mark booked"

**Where:** the Mark booked CTA on the lead workspace, primary once a block exists. The page
opens with a **readiness checklist** — unit selected, unit available or blocked for this
customer, payment plan configured, price available, discount approval complete — and the
confirm button stays disabled until every line clears, each failing line saying why. With an
active block the unit is prefilled and locked; without one, the same unit picker appears
alongside a signpost back to the recommended shortlist → quote → block → book path.

Validated before a single write: lead and unit exist, booking date present, buyer purpose
present, payment plan present and belonging to this project, final price positive, booking
amount non-negative, no existing booking on the unit, cost sheet (if given) belongs to this
lead and unit and is bookable, and — where approval was required — **the final price must
match the approved cost sheet exactly**.

Two conflict rules:

- A unit **blocked for another customer** is refused.
- A unit on internal **HOLD** is refused: resolve the hold or block it for this customer
  first, so a held unit can never be sold out from under whoever placed the hold.

Then the saga runs, first step first:

1. **Atomic claim** on the unit → `BOOKED`. Whoever wins here owns the sale. If the booking
   record then fails to write, the unit is handed back to exactly where it came from.
2. Booking record created, freezing final price, discount, plan, salesperson and the
   **full attribution snapshot** — source, original source, campaign, first-touch and
   last-touch campaign — as they stood at the moment of sale.
3. The idempotent tail: link the booking to the unit, convert the block, move the lead to
   the `BOOKED` stage through the action, mark it `TERMINAL`, **cancel every pending
   follow-up** (the deal is done), write `BOOKING_COMPLETED`, and create the resale or
   rental opportunity from the buyer purpose.

If the process dies mid-tail, the `bookings.resume` job finishes it on the next tick. Every
tail step is safe to repeat.

**After booking:** a success screen states plainly what happened — customer, project, unit,
price, date — and the lead is closed. It cannot be reopened; a returning customer starts a
new inquiry. Quotations can no longer be created against it.

### 6.15 Resale and rental opportunities

An `INVESTMENT` booking creates a resale opportunity; a `RENTAL_INCOME` booking creates a
rental one, carrying the expected exit/rental date, expected price/rent and furnishing.

Ownership goes to a dedicated "Resale team" / "Rental team" assignment pool if one is
configured, otherwise to the salesperson who already knows the customer.

Reminders fire once per band at **90, 60 and 30 days** before the expected date, to the
assigned owner, linking to `/app/opportunities/resale` or `/rental`.

### 6.16 Attribution — closing the loop back to spend

Nothing is written. Attribution is **derived on every read** from the stored touch history,
which is what makes the model switchable in both directions with no data loss.

Per campaign, the funnel is counted from the leads attributed to it under the current
model: leads → connected → visits → blocks → bookings → revenue. From those:

```
CPL              = spend ÷ leads
Cost per visit   = spend ÷ leads with a completed visit
Cost per booking = spend ÷ bookings
ROAS             = revenue ÷ spend        (revenue ÷ spend is ROAS, and it is not ROI)
```

Leads that match no campaign are reported as an explicit **unattributed** row rather than
being quietly dropped.

---

## 7. The non-negotiable rules

These are enforced structurally — not by convention, and not by the UI.

| # | Rule | Where it is enforced | What you see if you try to break it |
|---|---|---|---|
| 1 | **An active lead may never end an interaction without a future next action.** | `services/followups.js` → `applyOutcome()`. Every close-out path routes through it: completing a follow-up, logging a first action, completing a site visit. | *"Set the next action before saving — an active lead cannot be left without one."* |
| 2 | A next action must be in the **future**. | same | *"The next action must be scheduled in the future."* |
| 3 | **One contact per mobile number.** Email is a warning, never an auto-merge. | `services/contacts.js` + a unique index | *"A contact with this mobile number already exists."* |
| 4 | **Source history is never overwritten.** Only `latestSourceId` moves. | `services/leads.js`, `services/capture.js` | — (silent invariant, asserted by tests) |
| 5 | **Booked and Blocked are unreachable from the stage dropdown.** | `changeStage()` refuses unless called by the booking/block service | *"Bookings are recorded through the Booking action so inventory stays in step."* |
| 6 | **Marking a lead lost requires a reason** (a sub-stage), and cancels every pending follow-up. | `changeStage()` | *"Select a lost reason."* |
| 7 | **Two users cannot block or book the same unit.** | Single atomic conditional update on `Unit.status` | *"This unit was just blocked by another user…"* |
| 8 | **Prices come from the server**, never the form. | `services/pricing.js` is the only price producer | — |
| 9 | **A shared cost sheet is never edited** — changes create a new version. | `services/costsheets.js` | *"A newer version of this cost sheet exists."* |
| 10 | **Approvers cannot edit the figures they approve**, and cannot self-approve. | `services/approvals.js` | *"You cannot approve your own discount request."* |
| 11 | **The SLA clock stops on a genuine action, never a click.** | `recordFirstGenuineAction()`, reachable only from `applyOutcome()` | — |
| 12 | **A query that forgets its tenant scope throws** before reaching MongoDB. | `db/tenantGuard.js` Mongoose plugin | a loud crash in development, not a silent leak |
| 13 | **Setup data is deactivated, never deleted**, and not while in use. | `routes/setup.js` | *"3 active lead(s) still sit in this stage. Move them first."* |
| 14 | **A deactivated user cannot orphan open work.** | `routes/setup.js` | *"Priya still owns 4 active lead(s) and 2 pending follow-up(s). Transfer them first."* |
| 15 | **Opted-out contacts are excluded from campaigns and counted**, not silently dropped. | `services/messaging.js` | the send summary reports the exclusions |
| 16 | **The AI has no write path.** | `services/ai.js` — read-only by construction | — |

---

## 8. Background automation — what runs without a human

One in-process scheduler, one tick per minute (`SCHEDULER_TICK_MS`), seven independent
jobs. Every job is **idempotent** — a crashed run simply happens again next minute, and a
repeated run cannot double-send, double-remind or double-reassign, because each step is
guarded by a stored timestamp.

| Job | What it does | Guard that makes a retry safe |
|---|---|---|
| `sla` | Warns → escalates → auto-reassigns unattended leads | `slaWarningSentAt`, `slaEscalatedAt`, `reassignmentCount` |
| `followups.missed` | Flips overdue pending follow-ups to `MISSED` on active leads | status transition is one-way |
| `blocks.expiry` | Reminds before expiry, then releases expired blocks | `reminderSentAt`, block `status` |
| `bookings.resume` | Finishes any booking whose side effects did not complete | `sagaComplete` flag |
| `opportunities.reminders` | 90/60/30-day resale and rental nudges | one reminder per band via `reminderSentAt` |
| `campaigns.scheduled` | Sends campaigns whose scheduled time has arrived | status claimed atomically `SCHEDULED` → `SENDING` |
| `nurture` | Advances due nurture enrollments by one step | the cursor advances **before** the side effect |

Health for every job — last run, duration, ok/error — is on `/app/setup/health`.

> Single-node design. If this ever runs on more than one instance, add a claim document per
> job name so only one node runs a tick. It is marked in the code.

---

## 9. Notifications — who is told what, and when

| Trigger | Who is told | Severity | Links to |
|---|---|---|---|
| Lead assigned (round robin, transfer, reassignment) | new owner | WARNING | the lead |
| No eligible user to assign to | pool escalation users, else admins | CRITICAL | the unassigned queue |
| SLA warning threshold crossed | owner | WARNING | the lead |
| SLA escalation threshold crossed | escalation users / admins | CRITICAL | the lead |
| Auto-reassignment | previous owner, new owner, and managers | WARNING / CRITICAL / WARNING | the lead |
| Re-inquiry received | owner | WARNING | the lead |
| `@mention` in a note | mentioned users | INFO | the lead |
| Site visit scheduled for someone else | that sales user | INFO | the lead |
| Discount approval requested | approvers | WARNING | the approvals queue |
| Discount approved / rejected | requester | INFO / WARNING | the lead |
| Block expiring soon | whoever blocked it | WARNING | the lead |
| Block expired | whoever blocked it | CRITICAL | the lead |
| Resale / rental opportunity due | assigned owner | INFO | the opportunity queue |

Unread notifications appear on the dashboard and at `/app/notifications`.

---

## 10. Permissions and data scope

Two independent questions are asked on every request:

1. **Can this user do this at all?** — a boolean permission check.
2. **On whose records?** — the data scope, for the three scoped permissions.

An admin role short-circuits both. Everything is resolved server-side from the session
user's role; nothing the browser sends influences it.

### The default roles

| Role | Sees | Can do | Cannot do |
|---|---|---|---|
| **Organization Admin** | everything | everything | — |
| **Sales Manager** | team (self + direct reports) | full sales cycle, approve discounts, transfer leads, release blocks, team reports and exports | setup screens |
| **Sales User** | own only | full sales cycle on their own leads: capture, follow-up, visits, shortlist, cost sheet, discount request, block, book | approve discounts, release someone else's block, see other people's leads |
| **Marketing User** | all leads and contacts (read) | campaigns, spend, segments, attribution settings, tags, templates, exports | work leads, touch inventory, book |
| **Management Viewer** | all (read-only) | management dashboard, all reports, exports | change anything |

### Where scope actually bites

- **Lead list and workspace** — the filter is applied in the query. Another user's lead
  returns *"Lead not found."* — not a 403, so the existence of the record is not leaked.
- **Unassigned leads** — visible to anyone whose scope is wider than `own`.
- **Reports** — every report and every CSV export applies the same scope. A Sales User
  exporting the sales report gets only their own row.
- **Follow-ups** — you can only work a follow-up assigned to you or to someone in your scope.
- **Prices** — without `inventory.view_prices` you see inventory but no prices, including in
  AI unit recommendations and project Q&A.
- **The AI** — sees exactly what the asking user may see. No exceptions.

---

## 11. Money, time, tenancy and concurrency

### Money

Every monetary value in the database is an **integer in minor units** (paise/cents).
`lib/money.js` is the only place a decimal exists, and only for display. There is no
floating-point arithmetic anywhere in the pricing path.

Input parsing accepts what people actually type — `12,50,000.50`, `₹85,00,000`, `5500`.
Display uses the tenant's locale: `en-IN` yields `₹1.25 Cr` / `₹45.00 L` in dense rows and
full currency formatting elsewhere.

### Time

All timestamps are stored in **UTC**. Every "today" boundary resolves through `lib/tz.js`
in the tenant's timezone, so no two screens can disagree about what today means.

Day arithmetic is done on the local calendar, not by adding 86,400,000 ms — a local day is
23 or 25 hours long across a DST boundary, and the tests cover exactly that case.

Form inputs (`YYYY-MM-DD` + `HH:mm`) are interpreted in the tenant timezone and converted
to UTC on the way in; every rendered date is converted back on the way out.

When "business hours only" is on, the SLA clock counts **working seconds only** — a lead
that arrives at 10 pm does not breach overnight.

### Tenant isolation

A Mongoose plugin on every tenant-scoped model refuses any `find`, `update`, `delete`,
`count`, `distinct` or aggregation that does not constrain `tenantId`. It throws before the
query reaches MongoDB. Genuine system-wide work — seeding, cross-tenant background sweeps,
webhook key lookups — opts out explicitly with `allowCrossTenant: true`.

Tenant context comes from the session, never from a URL or body parameter.

### Concurrency without transactions

MongoDB offers multi-document transactions only on a replica set. On a standalone `mongod`
this app follows the spec's fallback: **every contended write is a single-document atomic
conditional update, and multi-step flows are ordered idempotent sagas.**

| Contended thing | How it is made safe |
|---|---|
| Round-robin cursor | atomic `$inc` inside `findOneAndUpdate` |
| Unit block | conditional status update naming the expected current status |
| Unit booking | same, as the saga's first step, with compensating rollback |
| Campaign send | atomic status claim `DRAFT/SCHEDULED/PAUSED` → `SENDING` |
| Webhook redelivery | uniquely indexed idempotency key |
| Booking side effects | `sagaComplete` flag + a resume job |

To upgrade to real transactions, point `MONGO_URI` at a replica set — `db.withTx()` uses
one automatically when the connection supports it, with **no code change**:

```yaml
# /opt/homebrew/etc/mongod.conf
replication:
  replSet: rs0
```

then once: `mongosh --eval 'rs.initiate()'`. `GET /healthz` reports which mode is live.

### Security

| Control | Implementation |
|---|---|
| Passwords | scrypt with per-user salt; strength validated on set |
| Sessions | MongoDB-backed, httpOnly, sameSite=lax, secure in production, rolling 12 h, **regenerated on login** so a fixated pre-login id cannot be reused |
| CSRF | synchroniser token in the session, sent as `_csrf` field or `x-csrf-token` header, compared in constant time |
| Rate limiting | 30 requests / 15 min on auth; 40 / 10 min on public capture endpoints |
| Headers | helmet with a strict CSP: `default-src 'self'`, no framing, same-origin referrer |
| Secrets | integration secrets sealed with AES-256-GCM, never rendered again — only masked |
| Errors | users never see raw technical detail; the real error goes to the structured log |
| Login enumeration | password is verified *before* the organization chooser appears, and forgot-password always responds identically |

---

## 12. Integrations — connecting the outside world

### Inbound leads

```
POST {APP_URL}/api/webhooks/leads/{webhookKey}
Content-Type: application/json
```

The key identifies **both the tenant and the integration**. A tenant id is never read from
the body. Unknown key → `404`.

**Payload mapping.** The normalizer accepts the field names providers actually send, and
flattens a nested `data` object:

| Meaning | Accepted keys |
|---|---|
| External id (idempotency) | `externalId`, `lead_id`, `leadgen_id`, `id` |
| Name | `name`, `full_name`, `fullName`, or `firstName`/`lastName` |
| Mobile *(required)* | `mobile`, `phone`, `phone_number`, `contact_number` |
| Email | `email` |
| City | `city` |
| Message | `message`, `requirement`, `comments` |
| Project | `projectId`, `project`, `project_name` |
| Source | `sourceId`, `source`, `sourceCategory`, `sourceDetail`, `form_name` |
| Ad identifiers | `campaignId`/`campaign_id`, `adsetId`/`adset_id`, `adId`/`ad_id`, `formId`/`form_id` |
| Landing page | `landingUrl`, `landing_url`, `page_url` |
| UTM | `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` |
| Timestamp | `capturedAt`, `created_time` |

Missing project or source fall back to the integration's configured defaults.

**Signature verification.** If a signing secret is stored, the request must carry
`x-signature` or `x-hub-signature-256` as `sha256=<hmac of the raw JSON body>`, compared in
constant time. A provider that cannot sign is admitted on the unguessable key alone.

**Idempotency.** Every delivery is stored raw *before* processing, keyed by external id →
`x-idempotency-key` header → SHA-256 of the body. The key is uniquely indexed, so an exact
redelivery returns `200 {ok: true, duplicate: true, leadId}` and is not reprocessed.

**Responses:**

| Status | Meaning |
|---|---|
| `201` | Lead created or re-inquiry recorded. Returns `leadId`, `contactId`, `reinquiry`. |
| `200` | Duplicate delivery, already processed. |
| `400` | Payload rejected (typically no valid mobile). |
| `401` | Missing or invalid signature. |
| `404` | Unknown webhook key. |
| `500` | Processing failed — stored, marked `FAILED`, and surfaced on the health screen. |

A capture failure is never silent: the webhook event is marked failed with its error, the
integration is flagged `ATTENTION_REQUIRED`, and both appear on `/app/setup/health`.

### Delivery callbacks

```
POST {APP_URL}/api/webhooks/messages/{webhookKey}
{"events":[{"messageId":"...","status":"DELIVERED"}]}
```

Accepts a single object or an `events` array. Valid statuses: `QUEUED`, `SENT`,
`DELIVERED`, `READ`, `REPLIED`, `FAILED`. Out-of-order callbacks can never walk a message
backwards (except to `FAILED`).

### Outbound messaging

WhatsApp, SMS and email share one send path. Until real credentials exist, the default
**mock driver** records exactly the same message log, delivery state and events a live
driver would — so campaign counters, delivery reporting and the timeline stay honest and
testable. Adding a live provider means adding one entry to the driver map.

Every send, real or simulated, is logged with its rendered body. Sends blocked by consent
are logged as `SKIPPED` with the reason, so exclusions are auditable.

### Ad platform sync

Marketing campaign spend is entered manually today; the sync adapter refreshes non-manual
campaigns and stamps `lastSyncAt`, which the UI shows.

---

## 13. Public, customer-facing surfaces

Three routes carry no session at all. They are mounted **ahead of the CSRF gate** because
they authenticate by unguessable token or integration key and have no session to forge.

| Surface | URL | What it does |
|---|---|---|
| **QR walk-in form** | `/visit/{qrToken}` | The project is resolved from the token in the URL, never from an editable field. Captures name, mobile, email, visitor count and channel-partner details, then creates/reuses the contact, opens or attaches the project lead, and logs an `IN_PROGRESS` site visit. No OTP in V1. Rate limited. |
| **Project mini site** | `/p/{slug}` | Published projects only. Shows overview, USPs, amenities, configurations, payment plans and — only if the tenant opts in — **configuration-level** availability counts. Unit-level inventory stays private. The inquiry form captures with source "Website / Mini site" and preserves UTM parameters. |
| **Shared cost sheet** | `/share/cost-sheet/{token}` | Read-only customer view of one exact version. Stops resolving once superseded. |

Each project gets its QR token automatically on creation. The mini site must be explicitly
published, and only an `ACTIVE` project can publish one.

---

## 14. Reports and what each number means

Five report families, no more — and every KPI links back to the records behind it, produced
by the same query that produced the number.

| Report | One row per | Answers |
|---|---|---|
| **Leads** | lead | Where is every lead, who owns it, how fast was it answered, did it visit, block, book? |
| **Sales** | user | Who is executing, and who is closing? |
| **Projects** | project | Which projects convert, and what is left to sell? |
| **Campaigns** | ad campaign | Which spend produced revenue? |
| **Activities** | activity type / user | What did the team actually do? |

### Metric definitions

These are fixed so a number always means one thing:

| Metric | Definition |
|---|---|
| **Response time** | Seconds from assignment (or capture, if never assigned) to the first genuine action. |
| **Median response** | The median, not the mean — one forgotten lead should not distort a whole team's number. |
| **SLA compliance %** | Leads answered within their **stamped** target ÷ leads requiring a response. |
| **Connected** | Leads with a first genuine action recorded. |
| **Follow-up discipline %** | Follow-ups completed on or before their due time ÷ follow-ups due in the period. |
| **Lead → visit %** | Leads with at least one *completed* visit ÷ leads. |
| **Visit → booking %** | Bookings ÷ leads with a completed visit. |
| **Lead → booking %** | Bookings ÷ leads. |
| **Revenue** | Sum of final booking price for non-cancelled bookings in the period. |
| **CPL / cost per visit / cost per booking** | Campaign spend ÷ the respective count. |
| **ROAS** | Revenue ÷ spend. Deliberately not called ROI. |

Default date range is the last 30 days, resolved in the tenant timezone. Filters (project,
owner, stage, source, campaign, purpose, status) apply to the report and to its CSV export
identically, and every export is audited with the filters that produced it.

The **management dashboard** (`/app/dashboard/management`) assembles the same numbers into
one funnel — leads → connected → visits → blocks → bookings → revenue — alongside marketing
totals, per-project performance and the resale/rental pipeline.

---

## 15. The AI assistant

Five capabilities, all read-only:

| Capability | What it returns |
|---|---|
| **Lead summary** | Factual bullets assembled from this lead's own records: requirement, stage and inquiry history, visits and outcomes, shortlist, latest cost sheet, active block, recorded objection, last activity, and whether a next action exists. |
| **Next action suggestion** | A rule-based recommendation with its reason — "Block the unit: a cost sheet exists but no unit is held." The user still decides and still has to record it. |
| **Priority score** | 0–100 with **every contributing signal listed and its points shown**, so the number is explainable rather than magic. Labelled assistive, not a probability of closing. |
| **Unit recommendations** | Only currently available units, priced by the same engine the cost sheet uses. Budget and configuration are treated as **requirements, not hints** — it says "nothing matches" rather than quietly offering a 2 BHK to someone who asked for a 3 BHK. |
| **Project Q&A** | Grounded answers on availability by configuration or budget, the price of a named unit, possession date, amenities, payment plans and facing. |

**Why "never invent a unit, price or availability" is structural rather than a promise:**
the driver is deterministic and grounded — every sentence is assembled from rows this
tenant actually has, filtered by what the asking user may see. There is no generative step
that *could* invent anything, and there is no write path at all. When data is not
configured, it says so instead of guessing.

Swapping in an LLM later means feeding it the same context bundle and keeping the same
guardrails.

---

## 16. Operating the system

### Health

| Check | Where |
|---|---|
| Process + DB + transaction mode | `GET /healthz` (no auth) |
| Integration status, recent webhook failures, background job health | `/app/setup/health` |
| Every sensitive change, with before/after, actor, IP | `/app/setup/audit` |

An integration flips to `ATTENTION_REQUIRED` the moment a send or a capture fails, with the
error and a failure count. It returns to `CONNECTED` on the next success.

### Tests

```bash
npm test        # 315 tests: unit, API, journey and concurrency, per-file test databases
npm run smoke   # live checks against a running server
```

`npm test` includes `tests/journeys/full-lifecycle.test.js`, which drives the entire product
as one continuous session — 57 steps from empty organization to booked unit and attributed
revenue, every form posted over HTTP with a real CSRF token exactly as a browser would. Its
final assertion is that **no attended active lead anywhere lacks a next action.**

`npm run smoke` needs the server running. It crawls all 59 app screens as each role plus the
public pages, then resolves every drawer trigger, quick action, form action and CSRF token
in the rendered HTML — 320 interactive hooks. That is how dead buttons get caught, which no
HTTP-level test can see.

### Logging

Structured single-line JSON to stdout, with scope tags (`request`, `scheduler`, `webhook.leads`,
`events`, `nurture`, `audit`). 5xx responses log the full stack; the user sees a friendly
message.

### Backups

Everything is in MongoDB. Uploaded media lives under `UPLOAD_DIR`. Back up both.

### Adding a second organization

`db/seed.js` exports `createOrganization()`, which creates the tenant, seeds all masters and
roles, creates the admin user and the default assignment pool in one call. There is no
public self-signup route in V1.

---

## 17. Error messages and what they actually mean

| Message | Cause | Fix |
|---|---|---|
| *Set the next action before saving — an active lead cannot be left without one.* | The core rule. | Fill in next action type + date + time, or move the lead to a terminal stage. |
| *The next action must be scheduled in the future.* | Past date/time. | Pick a future slot. |
| *Select a lost reason.* | Marking lost with no sub-stage. | Choose one. |
| *Bookings are recorded through the Booking action so inventory stays in step.* | Tried to reach `Booked` from the stage dropdown. | Use the Booking action. |
| *This unit was just blocked by another user…* | Genuine race — someone won by milliseconds. | Refresh inventory, pick another unit. |
| *This unit is on hold. Release the hold or block it for this customer before booking.* | Unit is on internal HOLD. | Release the hold or block it for this lead first. |
| *The final price must match the approved cost sheet.* | Booking price differs from the approved figure. | Book at the approved price, or create a new cost sheet and get it approved. |
| *This cost sheet needs discount approval before the unit can be booked.* | Approval required but not granted. | Get it approved, or create a version without the discount. |
| *A newer version of this cost sheet exists.* | Acting on a superseded version. | Use the latest version. |
| *You cannot approve your own discount request.* | Self-approval without `discount.approve_own`. | Another approver must decide. |
| *This project has no base price configured…* | No `BASE` pricing component. | Add one in project setup. |
| *No "New Lead" stage is configured. Add one in Setup → Stages.* | No stage with semantic type `NEW`. | Add or reactivate one. |
| *3 active lead(s) still sit in this stage. Move them first.* | Deactivating a stage in use. | Move those leads. |
| *Priya still owns 4 active lead(s) and 2 pending follow-up(s). Transfer them first.* | Deactivating a user with open work. | Transfer the work. |
| *A contact with this mobile number already exists.* | Duplicate mobile. | Open the existing contact and add the inquiry there. |
| *This lead is closed. Reopen it before…* | Acting on a terminal lead. | Reopen it (booked leads cannot be reopened — start a new inquiry). |
| *Your session expired. Refresh the page and try again.* | CSRF token mismatch, usually a stale tab. | Refresh. |
| *Lead not found.* | Either genuinely missing, **or** outside your data scope. | Ask an owner or a manager. The wording is deliberate — it does not confirm the record exists. |
| *This campaign is already sent.* | Double-send attempt. | None needed — the guard worked. |

---

## 18. Architecture map

```
src/
  config.js          env + constants, refuses insecure production boot
  server.js          connect → build indexes → register listeners → start scheduler → listen
  app.js             middleware order: helmet → body → static → session → rate limits →
                     currentUser → locals → PUBLIC ROUTES → csrf → app routes → errors
  db/
    index.js         connection, index build, transaction detection, withTx()
    tenantGuard.js   the isolation plugin
    models/          49 Mongoose models
    seed.js          tenant defaults, role seeding, createOrganization(), demo workload
  lib/
    access.js        can() / scopeOf() / scopeFilter() / canActOn()
    permissions.js   the permission catalog + the five default roles
    money.js         integer minor units; the only place decimals exist
    tz.js            UTC storage, tenant-timezone boundaries, DST-correct day maths
    businessHours.js working-seconds arithmetic for the SLA clock
    phone.js         E.164 normalization — the duplicate identity key
    password.js      scrypt hashing, token minting, strength rules
    secretbox.js     AES-256-GCM seal/open for integration secrets
    events.js        the business event bus
    errors.js        AppError + typed helpers
    fields.js        shared zod field builders
  middleware/
    auth.js          session → user → tenant; requireAuth, requirePermission
    csrf.js          synchroniser token
    validate.js      zod → req.data
    locals.js        tenant-bound view helpers (money, dates, phone)
    errors.js        friendly errors; JSON or HTML by Accept header
  services/          ALL business rules live here — routes stay thin
  routes/            one file per domain, declaring its /app/* pages and /api/* endpoints
  views/             EJS pages and partials
  jobs/scheduler.js  the seven background jobs
public/              one stylesheet, one progressive-enhancement script
scripts/             route listing + the two smoke crawlers
tests/               unit/, api/, journeys/
```

**Layering rule:** routes validate and delegate; services own every business rule; models
own shape and indexes. A rule that lives in a route can be bypassed by adding another
route — which is exactly why the next-action rule lives in one function that every path
must pass through.

**Design notes worth knowing:**

- `/api/*` endpoints serve both browser form posts and `fetch` calls. The `Accept` header
  decides the response format, not the path — so the UI stays on plain HTML forms and still
  gets a real API shape.
- Timeline entries are written through one `timeline.log()` helper, so the lead's and
  contact's `lastActivityAt` denormalisation can never drift.
- Notifications and nurture subscribe to business events rather than being called from
  inside the services that cause them, so a failing listener can never fail a sale.
