# Requirements coverage

Maps the source spec to the code that implements it and the test that proves it.
A module is not "done" until its rows are green. Run `npm test` to re-verify.

Status: ✅ implemented + tested · 🚧 in progress · ⬜ not started (later phase)

## Phase 1 — Foundation

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §4.2, §122.4 | Tenant isolation on every entity and request | `db/tenantGuard.js`, `middleware/auth.js` | `tenant-isolation.test.js` (8) | ✅ |
| §4.3 | Organization setup fields | `db/models/Tenant.js`, `routes/setup.js` | `contacts-setup.test.js` "organization settings" | ✅ |
| §5.1 | Email+password login, forgot, reset, logout, invite, activation | `services/auth.js`, `routes/auth.js` | `auth.test.js` (10) | ✅ |
| §5.2 | Invited/Active/Suspended/Inactive; inactive cannot log in; history intact | `db/models/User.js`, `routes/setup.js` | `auth.test.js`, `contacts-setup.test.js` | ✅ |
| §6.1 | Five default roles, renameable/cloneable | `lib/permissions.js`, `db/seed.js` | `contacts-setup.test.js` "default masters", "role permissions" | ✅ |
| §6.2 | Granular permission catalog | `lib/permissions.js`, `views/pages/setup/role-edit.ejs` | `contacts-setup.test.js` "role permissions" | ✅ |
| §6.3 | own / team / all data scope | `lib/access.js` | `leads.test.js` "sales user only sees own", "manager sees team" | ✅ |
| §7.1 | Route paths | `routes/*.js` | `pages.test.js` (21 screens) | ✅ |
| §9.1 | Contact field set | `db/models/Contact.js` | `contacts-setup.test.js` | ✅ |
| §9.2 | Mobile is the duplicate key; email is a warning, never a merge | `services/contacts.js`, `lib/phone.js` | `lib.test.js`, `contacts-setup.test.js` | ✅ |
| §9.3 | Dynamic tags, case-insensitively unique | `db/models/Tag.js`, `routes/setup.js` | `contacts-setup.test.js` "master item" | ✅ |
| §10.1 | Lead field set incl. source history + SLA fields | `db/models/Lead.js` | `leads.test.js` "creating a lead" | ✅ |
| §10.2 | Active vs Terminal derived from stage config | `services/leads.js` | `leads.test.js` "marking lost" | ✅ |
| §11 | Dynamic stages/sub-stages with semantic types | `db/models/Stage.js`, `services/stages.js`, `routes/setup.js` | `contacts-setup.test.js` "custom stage … renamed" | ✅ |
| §11.5, §52.2 | Sub-stage must belong to stage; terminal ≠ next action | `services/stages.js`, `routes/setup.js` | `leads.test.js`, `contacts-setup.test.js` | ✅ |
| §15 | Ownership + transfer, full history retained | `services/leads.js` | `leads.test.js` "a transfer keeps the whole history" | ✅ |
| §21 | Unified activity timeline, append-oriented | `services/timeline.js`, `db/models/Activity.js` | `leads.test.js` | ✅ |
| §22 | Internal notes with @mentions → notification + deep link | `services/timeline.js`, `services/listeners.js` | `leads.test.js` "notes with @mentions" | ✅ |
| §41 | Source history never overwritten | `db/models/Lead.js`, `services/leads.js` | `leads.test.js` "creating a lead" | ✅ |
| §46 | Search by name / mobile / email | `services/contacts.js` | `contacts-setup.test.js` "search finds a contact" | ✅ |
| §56 | Audit trail with before/after on sensitive actions | `services/audit.js` | `leads.test.js`, `contacts-setup.test.js` | ✅ |
| §57 | Soft delete / archive only | `services/contacts.js`, models | `contacts-setup.test.js` (deactivate, not delete) | ✅ |
| §67 | Channel opt-out / DND flags | `db/models/Contact.js`, `routes/contacts.js` | `contacts-setup.test.js` "opt-out flags" | ✅ |
| §68 | Friendly errors, never raw technical detail | `middleware/errors.js`, `lib/errors.js` | `pages.test.js` "friendly 404" | ✅ |
| §69 | Useful empty states with a CTA | `views/partials/empty.ejs` | `pages.test.js` | ✅ |
| §72 | UTC storage, tenant-timezone "today" | `lib/tz.js` | `lib.test.js` (incl. DST boundary) | ✅ |
| §73 | Fixed-precision money, never float | `lib/money.js` | `lib.test.js` | ✅ |
| §74 | RBAC server-side, CSRF, rate limiting, session hardening, scrypt | `middleware/*`, `lib/password.js`, `app.js` | `auth.test.js`, `contacts-setup.test.js` "non-admin cannot reach setup" | ✅ |
| §78 | System defaults for a new tenant | `db/seed.js` | `contacts-setup.test.js` "default masters" | ✅ |
| §80 | System fields not casually editable | `services/leads.js` (`EDITABLE_FIELDS`) | `leads.test.js` | ✅ |
| §81 | Reopen a lost lead, preserving history | `services/leads.js` | `leads.test.js` "a lost lead can be reopened" | ✅ |
| §82 | Lost requires a reason; follow-ups cancelled | `services/leads.js` | `leads.test.js` "marking lost" | ✅ |
| §83 | Booked/Blocked unreachable from the stage dropdown | `services/leads.js` | `leads.test.js` (two cases) | ✅ |
| §95 | Setup dependency: deactivate, never delete | `routes/setup.js` | `contacts-setup.test.js` (stage in use, user with leads) | ✅ |
| §102 | Deactivated owner must not orphan open work | `routes/setup.js` | `contacts-setup.test.js` "user still holding active leads" | ✅ |
| §112 | Screen inventory (phase-1 subset) | `views/pages/**` | `pages.test.js` | ✅ |

## Phase 2 — Sales execution core

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §8.1–8.3 | Sales work tiles, counts matching their lists, quick actions | `services/dashboard.js`, `views/pages/dashboard/index.ejs` | `followups.test.js`, `capture.test.js` | ✅ 4 of 5 tiles (visits tile lands with §24) |
| §8.4 | Manager exception dashboard + snapshot + panels | `services/dashboard.js` (`managerTiles`) | `distribution-sla.test.js` "Unassigned", `pages.test.js` | ✅ |
| §12.2, §12.3 | Capture payload + full capture workflow | `services/capture.js`, `routes/public.js` | `capture.test.js` "inbound lead creates…" | ✅ |
| §13.1–13.4 | Re-inquiry: same project, other project, reopen after lost | `services/capture.js` | `capture.test.js` (4 cases) | ✅ |
| §14.1–14.3 | Round robin, active-only, unassigned fallback | `services/distribution.js` | `distribution-sla.test.js` (5 cases incl. 9-way concurrency) | ✅ |
| §16.1–16.5 | Configurable SLA, warn → escalate → auto-reassign, metrics | `services/sla.js`, `db/models/SlaRule.js`, `jobs/scheduler.js` | `distribution-sla.test.js` (8 cases) | ✅ |
| §16.2, §55.3 | Genuine first action stops the clock; a click does not | `services/followups.js` | `followups.test.js`, `distribution-sla.test.js` | ✅ |
| §17 | Acknowledgement by project + source, fallback channel, failure handling | `services/acknowledgement.js`, `services/messaging.js` | `capture.test.js` (3 cases) | ✅ |
| §18.1–18.6 | Follow-up engine, completion drawer, missed reconciliation | `services/followups.js`, `routes/followups.js` | `followups.test.js` (13 cases) | ✅ |
| §18.3, §55.1, §55.2 | No active lead without a next action | `services/followups.js` (`applyOutcome`) | `followups.test.js` (3 cases) | ✅ |
| §45 | Notification types for assignment, SLA, mention, re-inquiry, unassigned | `services/notifications.js`, `services/listeners.js` | `distribution-sla.test.js`, `leads.test.js` | ✅ |
| §49 | Integration records, encrypted secrets, webhook keys, health | `db/models/Integration.js`, `lib/secretbox.js`, `routes/setup-communication.js` | `capture.test.js`, `lib.test.js` | ✅ |
| §50, §120 | Finish an action and land back on the same queue | `routes/followups.js` (`returnTo`) | `followups.test.js` (2 cases) | ✅ |
| §61 | Business event model | `lib/events.js` | exercised throughout | ✅ |
| §63, §98 | Webhook auth, signature, raw storage, idempotency | `routes/public.js`, `db/models/WebhookEvent.js` | `capture.test.js` (4 cases) | ✅ |
| §66 | Communication history + delivery callbacks | `db/models/MessageLog.js`, `services/messaging.js` | `capture.test.js` | ✅ |
| §92 | Response time, on-time follow-up definitions | `services/leads.js`, `services/followups.js` | `distribution-sla.test.js`, `followups.test.js` | ✅ |
| §96 | Resolved SLA target stored on the lead | `services/sla.js` | `distribution-sla.test.js` "stamped on the lead" | ✅ |
| §97 | Integration health screen | `routes/dashboard.js`, `views/pages/setup/health.ejs` | `capture.test.js` "fails loudly" | ✅ |
| §106, §107 | Retryable idempotent background jobs | `jobs/scheduler.js` | `followups.test.js`, `distribution-sla.test.js` | ✅ |
| §113, §114 | Complete-action and first-action drawers in spec field order | `views/partials/quick-action-drawer.ejs`, `public/js/app.js` | `followups.test.js` | ✅ |
| §19 | Nurture cadence | — | — | ⬜ deferred to phase 4 (shares campaign templates) |
| §8.5 | Management outcome dashboard | — | — | ⬜ needs booking/revenue data (phase 3) |

## Phase 3 — Real estate sales

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §24 | Site visits: many per lead, across projects | `services/visits.js` | `visits.test.js` (7 cases) | ✅ |
| §24.3, §52.4 | Completion requires an outcome, and a next action while active | `services/visits.js` | `visits.test.js` "demands an outcome", "demands a next action" | ✅ |
| §25 | QR walk-in without OTP, CP capture, rate limited | `routes/public.js`, `services/visits.js` | `visits.test.js` (5 QR cases) | ✅ |
| §26 | Project setup powering inventory, mini site, pricing, AI | `services/projects.js`, `db/models/Project.js` | `deals.test.js`, `pages.test.js` | ✅ |
| §27 | Project → tower → floor → unit, unique unit numbers, bulk generation | `services/projects.js`, `db/models/Unit.js` | `deals.test.js` "hierarchy generates units" | ✅ |
| §28, §53 | Live inventory, statuses, state machine, list + floor grid | `services/inventory.js` | `deals.test.js`, `marketing.test.js` (HOLD→BOOKED refused) | ✅ |
| §29 | Shortlist rules; removal never changes inventory | `services/inventory.js` | `deals.test.js` "shortlisting respects unit status" | ✅ |
| §30, §85 | Cost-sheet engine computed server-side, versioned, shareable | `services/pricing.js`, `services/costsheets.js` | `deals.test.js` (4 cases) | ✅ |
| §31 | Configurable discount approval, no self-approval, re-approval on change | `services/approvals.js` | `deals.test.js` (3 cases) | ✅ |
| §32, §86 | Unit blocking, atomic conflict, stored expiry | `services/blocks.js` | `deals.test.js` (3 cases incl. simultaneous race) | ✅ |
| §32.4 | Expiry reminder → auto-release → lead still needs a next action | `services/blocks.js`, `jobs/scheduler.js` | `deals.test.js` "an expiring block" | ✅ |
| §33, §87 | Booking validations and the full side-effect saga | `services/bookings.js` | `deals.test.js` (4 cases incl. saga recovery) | ✅ |
| §34 | Payment plan stored, no receivables | `db/models/PaymentPlan.js` | `deals.test.js` | ✅ |
| §35, §36 | Resale and rental opportunities from buyer purpose | `services/opportunities.js` | `deals.test.js` (3 cases) | ✅ |
| §64 | Mini project website + lead capture, inventory disclosure controls | `routes/public.js`, `views/pages/public/mini-site.ejs` | `visits.test.js` (2 cases) | ✅ |
| §84 | Semantic stage mapping on visit schedule/complete, tenant-switchable | `services/visits.js` | `visits.test.js` (2 cases) | ✅ |
| §96 | Resolved rules stored on the transaction | `services/blocks.js`, `services/sla.js` | `deals.test.js`, `distribution-sla.test.js` | ✅ |

## Phase 4 — Marketing

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §19 | Nurture cadence: trigger, steps, stop conditions, owner tasks | `services/nurture.js` | `marketing.test.js` (6 cases) | ✅ |
| §37.2, §37.3 | Contact-book filters, saved segments, recipient snapshot | `services/segments.js` | `marketing.test.js` (2 cases) | ✅ |
| §38 | WhatsApp/SMS/email campaigns, count before send, no double send | `services/campaigns.js` | `marketing.test.js` (3 cases) | ✅ |
| §39, §93 | Spend → leads → visits → blocks → bookings → revenue; CPL/ROAS | `services/attribution.js` | `marketing.test.js` "ties spend to real bookings" | ✅ |
| §40 | Multi-touch history preserved; model switchable both ways | `services/attribution.js` | `marketing.test.js` "switching the attribution model" | ✅ |
| §67, §102 | Opt-out excluded from campaigns and reported | `services/messaging.js` | `marketing.test.js` "excludes opted-out contacts" | ✅ |
| §119 | Full marketing lineage for a booked lead | `services/attribution.js` | `marketing.test.js` "full marketing lineage" | ✅ |

## Phase 5 — Intelligence, reports and the management view

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §8.5 | Management outcome dashboard with funnel and drilldown | `services/reports.js`, `views/pages/dashboard/management.ejs` | `ai-reports.test.js` "management view" | ✅ |
| §42.2–42.6 | Lead summary, next action, priority, unit match, project Q&A | `services/ai.js` | `ai-reports.test.js` (6 cases) | ✅ |
| §42.7, §108 | AI cannot mutate, invent, or cross tenant/permission lines | `services/ai.js`, `routes/reports.js` | `ai-reports.test.js` (3 cases) | ✅ |
| §43.2–43.6 | The five report families | `services/reports.js` | `ai-reports.test.js` (5 cases) | ✅ |
| §44, §92 | Execution and outcome metrics with spec definitions | `services/reports.js` | `ai-reports.test.js` "spec definitions" | ✅ |
| §46 | Global search across name, mobile, email, lead, project, unit | `routes/reports.js` | `ai-reports.test.js` "global search" | ✅ |
| §56 | Audit trail screen, read-only | `routes/dashboard.js`, `views/pages/setup/audit.ejs` | `pages.test.js`, audit assertions throughout | ✅ |
| §76 | Exports respect scope and filters, and are audited | `routes/reports.js` | `ai-reports.test.js` (2 cases) | ✅ |
| §118 | Every KPI links to the records behind it | report views, `services/reports.js` | `ai-reports.test.js` "one truth" | ✅ |

## V1.1 — Connected flow, form clarity & UX

Source: `Real_Estate_CRM_V1_1_Connected_Flow_Enhancement_Spec.md`. Planning and the
three documented deviations live in `V1_1-PLAN.md`.

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §5, §91, §123 | Dashboard search, exact-mobile tenant-wide lookup, ownership-safe results | `routes/reports.js` (`/api/search`), `public/js/app.js` | `search.test.js` (10) | ✅ |
| §6, §94, §95 | Pulsing NEW badge, badge order, reduced-motion fallback | `views/partials/lead-badges.ejs`, `public/css/app.css` | `funnel-temperature.test.js`, `search.test.js` | ✅ |
| §7–§12 | Full real-estate lead form + server validation | `routes/leads.js`, `views/pages/leads/new.ejs` | `lead-form.test.js` (8 of 15) | ✅ |
| §8.2, §13 | Live duplicate lookup and the existing-contact decision tree | `services/capture.js` (`inspectExisting`), `routes/leads.js` | `lead-form.test.js` (5 cases) | ✅ |
| §14, §96, §97 | HOT/WARM/COLD temperature, auto scoring, manual override, decay sweep | `services/temperature.js`, `db/models/Lead.js`, `jobs/scheduler.js` | `funnel-temperature.test.js` (6 cases) | ✅ |
| §17, §18, §86, §93 | Stage funnel from real history; completed vs skipped | `db/models/LeadStageHistory.js`, `services/stageHistory.js`, `views/partials/lead-funnel.ejs` | `funnel-temperature.test.js` (5 cases) | ✅ |
| §19, §20 | Stage/sub-stage as a parent/child tree everywhere | `views/pages/setup/stages.ejs`, `public/js/app.js` | `contacts-setup.test.js`, smoke | ✅ |
| §21, §92 | Merged outcome + next action, quick date presets, no raw stage dropdown | `views/partials/quick-action-drawer.ejs`, `views/pages/leads/workspace.ejs` | `followups.test.js`, `deal-flow.test.js` | ✅ |
| §23, §24, §25, §81, §82 | Requirement, next-action (incl. missing state) and deal cards with the CTA chain | `views/pages/leads/workspace.ejs` | `deal-flow.test.js` "CTA chain" | ✅ |
| §26–§30, §36, §37 | Guided project stepper, draft-first, resumable | `routes/projects.js`, `views/pages/projects/detail.ejs` | `project-setup.test.js` (3 cases) | ✅ |
| §31, §87, §88 | Project media and documents, categories, customer/AI visibility | `db/models/ProjectAsset.js`, `services/projectAssets.js` | `project-setup.test.js` (5 cases) | ✅ |
| §32.2 | Unit generation preview before mass creation | `services/projects.js` (`previewUnits`) | `project-setup.test.js`, `full-lifecycle.test.js` | ✅ |
| §35, §101 | Structured payment plans, 100% rule, legacy plans stay usable | `db/models/PaymentPlan.js`, `services/paymentPlans.js` | `project-setup.test.js` (5 cases) | ✅ |
| §38–§43 | Quotation flow: unit picker → plan → price → preview | `routes/deals.js`, `views/pages/deals/cost-sheet-new.ejs` | `deal-flow.test.js` (3 cases) | ✅ |
| §41, §44, §80 | Payment schedule with real amounts; snapshot frozen onto the quotation | `services/paymentPlans.js` (`schedule`, `snapshotOf`), `db/models/CostSheet.js` | `deal-flow.test.js` "freezes the plan", `project-setup.test.js` | ✅ |
| §45–§48 | Block unit picker, quotation priority, expiry stated before confirming | `routes/deals.js`, `views/pages/deals/block-new.ejs` | `deal-flow.test.js` (2 cases) | ✅ |
| §49–§55 | Mark Booked CTA, readiness checklist, unit selection, success screen | `routes/deals.js`, `views/pages/deals/booking-new.ejs`, `booking.ejs` | `deal-flow.test.js` (4 cases) | ✅ |
| §57 | Block-expired warning on the lead | `views/pages/leads/workspace.ejs` | smoke | ✅ |
| §58–§65, §90 | Integration API console: cURL, payloads, every response, signature docs, test console | `views/pages/setup/integrations.ejs`, `routes/setup-communication.js` | `integration-console.test.js` (5 cases) | ✅ |
| §66–§76 | Lead allocation setup, project→default fallback, preview, validation | `services/allocation.js`, `services/distribution.js`, `views/pages/setup/lead-allocation.ejs` | `allocation.test.js` (12) | ✅ |
| §77 | Lead list: temperature column and filter, dependent sub-stage filter | `services/leads.js`, `views/pages/leads/list.ejs` | `integration-console.test.js`, smoke | ✅ |
| §84 | Reopen with the next action in one flow | `services/leads.js` (`reopen`), `routes/leads.js` | `deal-flow.test.js` "reopening" | ✅ |
| §99 | Report updates: temperature, mode, timeline, funding, next action | `services/reports.js`, `routes/reports.js` | `integration-console.test.js` (3 cases) | ✅ |
| §100 | AI priority response carries the temperature band | `services/ai.js` | `ai-reports.test.js` | ✅ |
| §104 | Project readiness validation | `services/projects.js` (`readiness`) | `project-setup.test.js` "names every gap" | ✅ *(warns, see `V1_1-PLAN.md` §6)* |
| §105 | Human-readable quotation number | `services/costsheets.js` (`nextQuotationNumber`) | `deal-flow.test.js` | ✅ |
| §125 | Regression list — nothing in it broke | — | the whole suite, incl. `full-lifecycle.test.js` | ✅ |
| §106 | Human-readable booking number | — | — | ⬜ optional, not built |

**Bug found and fixed while building this:** CSRF ran before the multipart body was
parsed, so an upload form's `_csrf` field was unreadable. `middleware/csrf.js` now defers
verification for an explicit route allowlist and those routes verify once their body
exists — with a test asserting a bad token is still refused.

**Latent bug found and fixed:** `reports.rangeFor` ended the default range at "now", which
hid same-day bookings (dated midday) from every morning report. It now ends at the end of
today in the tenant's timezone.

## End-to-end verification

`tests/journeys/full-lifecycle.test.js` runs the whole product as one continuous
session — 57 steps, every form posted over HTTP with a real CSRF token, asserting
both the response and the state it left behind:

| Block | What it drives |
|---|---|
| 1. Setup | org settings, SLA thresholds, custom role + permissions, user invites and activation, stages/sub-stages, all four flat masters, templates, acknowledgement rules, nurture sequence, integration + key rotation |
| 2. Project | project create/edit/status, tower + floors, unit types, bulk unit generation, manual unit, hold/release, six pricing components, payment plan, project SLA override, mini-site publish |
| 3. Capture | website webhook, QR walk-in with channel partner, mini-site inquiry, manual entry, re-inquiry on the same mobile |
| 4. Sales day | New Leads tile → refused call → accepted call + next action → follow-up add/reschedule/cancel/complete-from-queue → visit schedule/reschedule/complete → shortlist → cost sheet + approval + share → block/release/re-block → booking → post-booking lockout |
| 5. Lifecycle | lost with reason, reopen, transfer, requirement edit, system-field protection, @mention |
| 6. SLA | warn → escalate → auto-reassign on a neglected lead |
| 7. Management | manager exceptions, management funnel, all five reports + CSV exports, scoped reporting, search, audit trail |
| 8. Marketing | contact create/edit/consent, campaign audience count → send → opt-out exclusion → double-send refusal, ad spend entry/edit, attribution switch, delivery callback |
| 9. Long tail | AI endpoints, resale queue, notifications, password change, deactivation guard, every scheduler job, and a final assertion that **no attended active lead anywhere lacks a next action** |

Two live checks run against the real server (`npm run smoke`):

- **`scripts/smoke-screens.js`** — crawls all 65 app screens as admin, manager and
  sales, plus 8 public routes, asserting clean pages and no leaked template errors.
- **`scripts/smoke-wiring.js`** — resolves all 473 interactive hooks: every
  `data-drawer` has its drawer, every quick action and form posts to a route that
  exists, every POST form carries a CSRF token. This catches dead buttons, which
  no HTTP-level test can see.

## Deliberately not built

| Spec | Item | Why |
|---|---|---|
| §77 | CSV lead/contact import | The spec itself scopes it to V1.1 |
| §3.2 | Everything in the out-of-scope list | Excluded by the spec |
| §42 | LLM-backed AI driver | The deterministic driver satisfies §42 without a key; §42.7 becomes structural |
| §49 | Live provider credentials | Mock drivers record real delivery state; swapping in a live driver is one file |

## V2.0 Phase 1 — Post-booking foundation & collections

Source: `Real_Estate_CRM_V2_Connected_CP_HRMS_Post_Booking_Collections_Spec.md`.
Test file: `tests/api/post-booking.test.js` (24 cases).

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §108, §266 | Post-booking initialization, in the exact order, idempotent | `services/postBooking.js`, `services/bookings.js` | "booking initializes its post-booking data", "initialization is idempotent" | ✅ |
| §324.1 | A valid booking is never undone by post-booking failure | `services/bookings.js` (try/catch + `booking.post_initialize` job) | `full-lifecycle.test.js` 4.10 | ✅ |
| §110, §111 | Booking list with money, KYC and collection columns + filters | `services/postBooking.js` `list()`, `routes/bookings.js`, `views/pages/bookings/list.ejs` | "the booking list and workspace show the money" | ✅ |
| §109, §113 | Booking workspace: overview, collections, timeline, progress strip | `views/pages/bookings/workspace.ejs` | "the booking list and workspace show the money" | ✅ |
| §112 | `postBookingStatus` derived, kept apart from commercial status | `services/postBooking.js` `derivePostBookingStatus()` | "booking initializes its post-booking data" | ✅ |
| §114, §115, §344.7 | Schedule from the frozen quotation/plan snapshot, never live pricing | `services/postBooking.js` `planSnapshotFor()`, `db/models/Booking.js` | "a later payment plan edit cannot move an existing schedule" | ✅ |
| §132, §133, §135 | `BookingInstallment`, due rules, TBD never invented | `db/models/BookingInstallment.js`, `services/installments.js` | "due dates resolve per rule, and TBD is never invented" | ✅ |
| §136 | Stored status + derived OVERDUE | `services/installments.js` | "due dates resolve…", "the overdue sweep flags a passed due date" | ✅ |
| §137 | Payment schedule timeline UI | `views/pages/bookings/workspace.ejs` | "the booking list and workspace show the money" | ✅ |
| §147, §148 | Collection owner; collection pool with its own cursor | `services/collections.js` `resolveOwner()`, `services/distribution.js`, `AssignmentPool.poolType` | "booking initializes its post-booking data" | ✅ |
| §149 | Pool members must hold collection permission | `services/allocation.js` | "collection cannot be handed to someone who cannot collect" | ✅ |
| §150, §151 | Collection dashboard tiles + financial snapshot | `services/collections.js` `tiles()`, `snapshot()` | "collection tiles and their drilldown agree" | ✅ |
| §152, §222, §223 | Work queue rows, tabs, filters, sort | `services/collections.js` `queue()`, `views/pages/collections/queue.ejs` | "collection tiles and their drilldown agree" | ✅ |
| §153, §201 | Manager aging buckets | `services/collections.js` `aging()` | "the overdue sweep flags a passed due date" | ✅ |
| §154, §155, §156 | `CollectionFollowUp`, action types, outcomes | `db/models/CollectionFollowUp.js`, `services/collectionFollowups.js` | "collection follow-up can be scheduled against an installment" | ✅ |
| §157, §324.18 | Outstanding money always leaves a next action behind | `services/collectionFollowups.js` `requireNextAction()` | "closing a follow-up while money is owed demands the next one" | ✅ |
| §158, §159, §161 | Promise to pay: amount + date, capped at outstanding, one save | `db/models/CollectionPromise.js`, `views/partials/collection-drawer.ejs` | "a promise to pay needs an amount and a date, and is capped", "the drawer saves outcome, promise and next action in one go" | ✅ |
| §160 | Promise becomes MISSED after its date | `services/collectionFollowups.js` `promiseSweep()` | "an unkept promise becomes MISSED after its date" | ✅ |
| §162, §189 | Post-booking timeline, separate from the lead's | `services/timeline.js` `forBooking()`, `Activity.bookingId` | "booking initializes its post-booking data" | ✅ |
| §183, §220, §324.6 | Collection ownership never touches sales credit | `services/collections.js` `transferOwner()` | "transferring collection never touches sales credit" | ✅ |
| §180, §181, §221 | Booking/collection permissions, two new default roles | `lib/permissions.js` | "collection transfer needs permission", "the new owner sees it in their own queue" | ✅ |
| §188 | Sweeps: post-init retry, overdue refresh, missed follow-ups, missed promises | `jobs/scheduler.js` | "a pending follow-up whose time passed becomes MISSED", "the overdue sweep flags…" | ✅ |
| §198 | Collection audit: owner change, due-date change | `services/audit.js` calls in `collections.js`, `installments.js` | "transferring collection…", "a due date can be fixed…" | ✅ |
| §199, §200 | Commercials read-only; no amount amendment UI | `views/pages/bookings/workspace.ejs` | "booking commercials are read-only after the sale", "amounts have no edit path at all" | ✅ |
| §242, §241 | Denormalized booking totals, one writer | `services/collections.js` `recalcBooking()` | "the schedule sums to the booking value exactly" | ✅ |
| §267 | Integer minor units; remainder on the final installment | `services/installments.js` `amountsFor()` | "the schedule sums to the booking value exactly" | ✅ |
| §268 | Due-date change with reason + audit, expectation preserved | `services/installments.js` `setDueDate()` | "a due date can be fixed, with a reason and an audit trail" | ✅ |
| §279 | Tile count equals its drilldown | `services/collections.js` `filterFor()` (one definition, both readers) | "collection tiles and their drilldown agree" | ✅ |
| §294 | Unassigned collection is visible, not silent | `services/postBooking.js` (admin notification) | — (covered by owner-resolution path) | ✅ |
| §2.3 | Tenant isolation on every new entity | `db/tenantGuard.js` on all three new models | "another tenant cannot see or touch this booking" | ✅ |
| §139–§146 | Payment links, gateway, receipts, allocation, reversal | — | — | ⬜ Phase 2 |
| §116–§131 | Customer booking form, secure link, KYC | — | — | ⬜ Phase 2 |
| §163 | Payment reminder automation | — | — | ⬜ Phase 2 |
| §168–§170 | Booking, collection and collection-performance reports | — | — | ⬜ Phase 2 |

## V2.0 Phase 2 — Customer booking form, KYC, payments & receipts

Test file: `tests/api/booking-customer.test.js` (38 cases).

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §116, §288 | Prepare, generate, copy and send the customer link | `services/bookingForm.js`, `views/pages/bookings/workspace.ejs` | "the workspace generates a customer link and shows it once" | ✅ |
| §117 | Unguessable token, hash-only storage, expiry, revoke, optional OTP | `db/models/BookingCustomerLink.js`, `services/bookingForm.js` | "…shows it once", "generating a second link revokes the first" | ✅ |
| §118, §324.2 | Commercial section read-only; customer cannot edit price/unit/plan | `services/bookingForm.js` (field allowlist) | "the customer submits applicants and a declaration" | ✅ |
| §118 | "Report an issue" becomes an internal note | `services/bookingForm.js` `reportIssue()` | "reported issues become an internal note, never an edit" | ✅ |
| §119–§122 | Individual / company applicant, multiple co-applicants | `db/models/BookingApplicant.js` | "the customer submits applicants and a declaration" | ✅ |
| §123 | `BookingApplicant` is not a CRM Contact | `db/models/BookingApplicant.js` | (model-level; §185 distinction) | ✅ |
| §124 | Declaration with timestamp, IP, user agent, form version | `Booking.customerDeclaration` | "the customer submits applicants and a declaration" | ✅ |
| §125 | Dynamic KYC document types, seeded defaults | `db/models/KycDocumentType.js`, `services/kyc.js` | "a new tenant starts with a KYC checklist…" | ✅ |
| §126 | Customer and internal upload, same service path | `services/kyc.js` `upload()` | "the customer uploads a document straight into private storage" | ✅ |
| §127 | Per-document and overall KYC status, derived | `services/kyc.js` `rollup()` | "KYC status is derived from the documents, never typed in" | ✅ |
| §128 | Correction flow; old file retained, never overwritten | `services/kyc.js`, `BookingKycDocument.supersededById` | "a replacement supersedes and never overwrites", "a rejection…reopens KYC" | ✅ |
| §129 | KYC queue with tiles and missing-document column | `services/kyc.js` `queue()`, `views/pages/bookings/kyc-queue.ejs` | "the KYC queue counts what the list shows" | ✅ |
| §130 | Separate view / edit / review permissions | `lib/permissions.js` | "a sales user cannot review KYC or reverse a receipt" | ✅ |
| §131, §344.23 | Private storage, permission-checked download, audit, masked numbers | `lib/privateFiles.js`, `routes/files.js`, `lib/secretbox.js` | "a KYC file needs permission, and its download is audited" | ✅ |
| §138, §269 | Customer sees paid / outstanding / next due — and nothing internal | `services/bookingForm.js` `customerView()` | "the customer sees their booking, read-only" | ✅ |
| §139 | `PAYMENT_GATEWAY` integration category, provider-agnostic adapter | `db/models/Integration.js`, `services/payments.js` DRIVERS | "the gateway webhook verifies its signature and is idempotent" | ✅ |
| §140, §141, §344.26 | `PaymentRequest`; amount ≤ outstanding; creating a link is not a payment | `services/payments.js` | "a payment link is capped…", "creating a link is not a payment" | ✅ |
| §142 | Signed, idempotent callback; raw event stored; receipt created | `services/payments.js` `handleWebhook()` | "the gateway webhook verifies its signature and is idempotent" | ✅ |
| §143 | Manual receipt with mode, reference, proof; cash can be disabled | `services/receipts.js` | "a manual payment records, allocates and recalculates", "cash can be switched off" | ✅ |
| §144, §324.5 | `BookingReceipt`, numbered, never deleted | `db/models/BookingReceipt.js` | "a receipt is reversed with a reason, never deleted" | ✅ |
| §145 | Allocations sum to the receipt; no credit ledger | `services/receipts.js` `record()` | "a manual receipt must allocate in full" | ✅ |
| §146 | Reversal recalculates installment, booking and totals | `services/receipts.js` `reverse()` | "a receipt is reversed…", "reversing restores the installment status too" | ✅ |
| §163 | Reminder bands, opt-in per tenant, idempotent per band | `services/paymentReminders.js` | "reminders are off until a tenant switches them on", "a paid installment is never chased" | ✅ |
| §164 | One customer page: summary, applicants, KYC, plan, payments | `views/pages/public/booking-form.ejs` | "the customer sees their booking, read-only" | ✅ |
| §166 | Document section with visibility | workspace `documents` tab | smoke (`?tab=documents`) | ✅ |
| §168 | Collection report with aging, modes, PTP, links | `services/postBookingReports.js` | "the three post-booking reports render and export" | ✅ |
| §169 | Booking & KYC report | `services/postBookingReports.js` | same | ✅ |
| §170 | Collection performance, amount AND percentage | `services/postBookingReports.js` | same | ✅ |
| §192 | Rate limits, expiry/revoke messaging, no indexing | `routes/public.js` | "a wrong or unknown token gives nothing away", "a revoked link closes…" | ✅ |
| §193 | MIME allowlist, size cap, safe key, no executables | `lib/privateFiles.js` | "an executable is refused whatever it claims to be" | ✅ |
| §231 | Post-booking template purposes, seeded | `db/models/Template.js`, `db/seed.js` | "a new tenant starts with a KYC checklist and message templates" | ✅ |
| §264 | New tenant settings + setup screen | `db/models/Tenant.js`, `routes/setup-communication.js`, `views/pages/setup/post-booking.ejs` | smoke (`/app/setup/post-booking`) | ✅ |
| §289 | Reopen for correction, approved data kept | `services/bookingForm.js` `reopen()` | "a rejection without a note is refused, and a rejection reopens KYC" | ✅ |
| §291 | Link status as the provider reports it; nothing invented | `services/payments.js`, workspace payment-links table | "the customer payment page shows the amount and no internals" | ✅ |
| §297 | Payment acknowledgement, never called a tax receipt | `services/receipts.js` `acknowledge()` | "paying settles the link, creates a receipt…" | ✅ |
| §321 | Exports carry filters, scope and audit; never a KYC document | `routes/reports.js` | "the three post-booking reports render and export" | ✅ |
| §167 | Booking form PDF snapshot | — | — | ⬜ print view deferred (decision 2.12) |

## V2.0 Phase 3 — Channel Partner

Test file: `tests/api/channel-partner.test.js` (43 cases).

| Spec | Requirement | Code | Test | Status |
|---|---|---|---|---|
| §7, §16–§17 | Company and individual partners, shared profile shape | `db/models/partnerProfile.js`, `ChannelPartner`, `ChannelPartnerRegistration` | "an application is not a partner until it is approved" | ✅ |
| §12–§15 | Registration list, statuses, 7-step stepper, entry points | `services/channelPartners.js`, `views/pages/channel-partners/registration-form.ejs` | "an application is not a partner…", smoke | ✅ |
| §13, §186 | Application → partner only on approval, idempotent | `services/channelPartners.js` `reviewRegistration()` | "approval creates the partner…", "approving twice does not create a second partner" | ✅ |
| §14 | Internal / invite / public self-registration, all reviewed | `routes/cp-portal.js` `/cp/register` | "public self-registration is off unless the tenant enables it" | ✅ |
| §18, §217, §324.11 | GujRERA recorded, private certificate, versioned renewals | `db/models/PartnerReraDocument.js`, `services/rera.js` | "the RERA certificate is stored privately as version 1", "a RERA renewal versions rather than overwrites" | ✅ |
| §19, §20 | RERA policy gates; expiry banner; submission blocked | `services/rera.js` `leadSubmissionBlock()`, `expiryBanner()` | "an application cannot be submitted without RERA", "an expired certificate blocks new submissions" | ✅ |
| §21 | Bank details masked, sealed, revealed only by audited action | `partnerProfile`, `routes/channel-partners.js` reveal-bank | "the bank account number is masked and sealed, never plain" | ✅ |
| §22, §23, §219 | Company team, portal roles, exit keeps history | `ChannelPartnerMember`, `services/channelPartners.js` | "a deactivated member loses access and keeps their history" | ✅ |
| §24, §308 | Separate portal identity; invite → activate | `db/models/PartnerPortalUser.js`, `middleware/partnerAuth.js`, `services/partnerPortal.js` | "the partner activates their own login", "a partner session can never reach an internal route" | ✅ |
| §25, §26, §307 | Project empanelment gates submission; expiry stops new leads only | `PartnerProjectEmpanelment`, `channelPartners.empanelmentBlock()` | "a partner cannot submit for a project they are not empanelled on", "empanelment opens the project" | ✅ |
| §27–§30 | Partner workspace, internal overview, portal dashboards | `views/pages/channel-partners/workspace.ejs`, `views/pages/cp/dashboard.ejs` | smoke + "the internal dashboard and reports agree" | ✅ |
| §31, §32, §344.9 | Portal submission reuses `capture.handleInquiry`; identity server-derived | `services/partnerLeads.js` `submit()` | "a partner submission runs the normal capture path" | ✅ |
| §33, §184, §324.7 | CP attribution is a separate dimension from owner and source | `Lead.channelPartnerId` + `partnerAttributionStatus` | "a partner submission…", "a second partner claiming… creates a conflict" | ✅ |
| §34, §35, §324.8 | `PartnerLeadClaim`; protection window; conflict never overwrites | `services/partnerLeads.js` `assessClaim()` | "a second partner claiming…", "a direct lead is defended by tenant policy" | ✅ |
| §36 | Claim review screen and audited decisions | `partnerLeads.reviewClaim()`, `views/pages/channel-partners/claims.ejs` | "the claim queue lets a reviewer decide, and audits it" | ✅ |
| §37, §271 | Partner sees only safe fields; no internal notes or KYC | `partnerLeads.partnerVisibleLead()`, `services/partnerPortal.js` | "the partner sees only safe fields about their lead", "the partner sees eligibility progress, never the receipts" | ✅ |
| §38 | Site visit carries the partner; no duplicate visit record | `partnerLeads.stampVisit()` + visit listener | "a visit on a partner lead carries the partner" | ✅ |
| §39, §324.9 | Booking freezes CP attribution and the commission rule | `services/bookings.js`, `PartnerCommissionEntitlement` | "a booking freezes the partner attribution and accrues commission" | ✅ |
| §40, §41, §306 | Rule scope most-specific-wins; forward-only changes | `services/commissions.js` `resolveRule()`, rule `specificity` | "editing the rule later cannot change what was earned" | ✅ |
| §42, §206 | Entitlement with four separate money figures | `PartnerCommissionEntitlement`, `commissions.summaryFor()` | "a booking freezes…", "the internal dashboard and reports agree" | ✅ |
| §43 | Collection-driven eligibility, event- and job-driven | `commissions.evaluate()`, `services/listeners.js` | "crossing the collection threshold makes it eligible" | ✅ |
| §44–§48, §324.10 | Invoice from eligible lines; claim capped; double-invoicing prevented | `services/partnerInvoices.js` `claimCeiling()` | "a partner can only invoice the eligible amount", "a second invoice cannot double-claim" | ✅ |
| §49 | Review screen with partner, RERA, booking, collection context | `views/pages/channel-partners/invoice-detail.ejs` | "the reviewer sees the whole picture and approves" | ✅ |
| §50, §344.14 | Operational payout tracking, capped at the invoice | `PartnerPayout`, `partnerInvoices.recordPayout()` | "a payout is recorded operationally and cannot exceed the invoice" | ✅ |
| §51, §204–§206 | CP performance and invoice reports; conversion definitions | `services/partnerReports.js` | "the internal dashboard and reports agree with the records" | ✅ |
| §52, §53, §188 | CP notifications; `cp.rera_expiry`, `cp.commission_eligibility` jobs | `jobs/scheduler.js`, `rera.expirySweep()`, `commissions.eligibilitySweep()` | "an expired certificate blocks new submissions" | ✅ |
| §9–§11 | Internal dashboard tiles, funnel, top performers by chosen column | `partnerReports.dashboard()`, `topPerformers()` | "the top-performer table ranks by the column asked for" | ✅ |
| §178 | CP permission set, scoped where it matters | `lib/permissions.js` | "a sales user cannot review claims" | ✅ |
| §181 | Channel Partner Manager default role | `lib/permissions.js` DEFAULT_ROLES | used throughout the suite | ✅ |
| §196 | Audit: approval, RERA verification, team, empanelment, claims, rules, invoice, payout | `services/audit.js` calls across the CP services | "…and audits it", "verifying the certificate is audited" | ✅ |
| §216 | Duplicate detection on PAN/GSTIN/mobile/RERA; never auto-merged | `channelPartners.findDuplicates()`, `rera.assertNumberFree()` | "a second application with the same PAN is flagged", "a RERA number cannot belong to two partners" | ✅ |
| §218 | Suspension: read-only portal, history intact | `channelPartners.setStatus()`, `middleware/partnerAuth.js` | "suspension makes the portal read-only and keeps history" | ✅ |
| §228 | Reversal may un-eligible; never claws back invoiced or paid | `commissions.evaluate()` | "a reversal after invoicing flags review, never a clawback", "an uninvoiced entitlement does fall back" | ✅ |
| §264, §265 | CP tenant settings and project overrides | `Tenant.settings`, `Project.channelPartnerEnabled` | "public self-registration is off unless the tenant enables it" | ✅ |
| §272 | Invoice tax values stored, never computed | `PartnerInvoice`, invoice views | "a partner can only invoice the eligible amount" | ✅ |
| §298 | Invoice PDF private; partner reads only their own | `routes/cp-portal.js`, `routes/files.js` | "the invoice PDF is private, and the partner reads only their own" | ✅ |
| §309, §310 | Honest submission acknowledgement and portal statuses | `routes/cp-portal.js`, `views/pages/cp/leads.ejs` | "a second partner claiming…" (portal shows conflict, not attribution) | ✅ |
| §311, §312 | Team and project performance tables | `partnerPortal.teamPerformance()`, `projectPerformance()` | smoke + dashboard render | ✅ |
| §313–§315 | Eligibility UI, multi-booking invoices, correction keeps history | `views/pages/cp/invoices.ejs`, `PartnerInvoice.previousVersions` | "a partner can only invoice the eligible amount" | ✅ |
| §2.3 | Tenant isolation on every CP entity | `db/tenantGuard.js` on all 11 models | "another tenant cannot see or touch this partner" | ✅ |
| §243 | CP summary counters | computed by aggregation instead (decision) | — | ✅ substance |
