# Functionality Reference

The flat, complete list: every screen, every endpoint, every field, every permission, every
state machine, every configurable setting.

For *why* things work this way and how the pieces connect end to end, read
**[CRM-GUIDE.md](CRM-GUIDE.md)**.

Covers V1 plus the V1.1 connected-flow release. Plain `§` markers point at the V1 master
spec; `V1.1 §` at the enhancement spec. Deviations are recorded in `V1_1-PLAN.md`.

Conventions used below:

- **Permission** — one of the keys from the catalog in §11. Multiple keys mean *any one*
  grants access. Admin roles bypass all checks.
- **Scope** — where a data scope (`own` / `team` / `all`) additionally applies.
- `/app/*` routes render HTML pages. `/api/*` routes accept form posts **and** `fetch`
  calls; the `Accept` header decides whether the response is a redirect or JSON.
- Every `/api/*` and `/app/*` route requires a session and a valid CSRF token on writes.
  The four public routes in §10 are the only exceptions.

---

## Contents

1. [Screen inventory](#1-screen-inventory)
2. [Authentication](#2-authentication)
3. [Dashboards and work queues](#3-dashboards-and-work-queues)
4. [Leads](#4-leads)
5. [Follow-ups and actions](#5-follow-ups-and-actions)
6. [Site visits](#6-site-visits)
7. [Contacts](#7-contacts)
8. [Projects and inventory](#8-projects-and-inventory)
9. [Deals: cost sheets, approvals, blocks, bookings](#9-deals-cost-sheets-approvals-blocks-bookings)
10. [Marketing](#10-marketing)
11. [Reports, search and AI](#11-reports-search-and-ai)
12. [Setup](#12-setup)
13. [Public endpoints](#13-public-endpoints)
14. [Permission catalog](#14-permission-catalog)
15. [State machines](#15-state-machines)
16. [Configuration reference](#16-configuration-reference)
17. [Default seed data](#17-default-seed-data)
18. [Background jobs](#18-background-jobs)
19. [Business events](#19-business-events)
20. [Timeline activity types](#20-timeline-activity-types)
21. [Data model index](#21-data-model-index)

---

## 1. Screen inventory

| Screen | Route | Permission | What it does |
|---|---|---|---|
| Sign in | `/login` | — | Email + password. Offers an organization chooser if the address exists in more than one. |
| Choose organization | (rendered by `/login`) | — | Appears only when the verified password matches users in multiple tenants. |
| Forgot password | `/forgot-password` | — | Always responds identically whether or not the address exists. |
| Set / reset password | `/reset-password`, `/accept-invite` | token | Password strength is validated; both fields must match. |
| Sales dashboard | `/app/dashboard` | any | Global search + 5 work tiles + the records behind the selected tile + unread notifications. |
| Team dashboard | `/app/dashboard?view=team` | `dashboard.team` | 7 exception tiles + today's snapshot + exception panels. |
| Management dashboard | `/app/dashboard/management` | `dashboard.management` | Business-outcome funnel, marketing totals, per-project rows, opportunity pipeline. |
| Notifications | `/app/notifications` | any | Full list with mark-all-read. |
| My profile | `/app/profile` | any | Details and password change. |
| Global search | `/app/search` | any | Contacts, leads, projects, units — each scoped to what you may see. |
| Lead list | `/app/leads` | `lead.view` | Server-side search, 9 filters, sort, pagination. |
| New lead | `/app/leads/new` | `lead.create` | Manual capture. |
| Lead workspace | `/app/leads/:id` | `lead.view` + scope | Everything about one lead: stage funnel, badges, timeline, requirement, next-action card, deal card with the CTA chain, temperature, follow-ups, visits, shortlist, quotations, blocks, sibling leads, all action drawers. |
| Generate quotation | `/app/leads/:id/cost-sheets/new` | `costsheet.create` | Four steps: unit picker → payment plan → price & discount → save. |
| Block unit | `/app/leads/:id/blocks/new` | `unit.block` | Unit picker, then the commercial step with the expiry stated before confirming. |
| Lead allocation | `/app/setup/lead-allocation` | `setup.distribution` | Round-robin pools, member order, next-up preview, escalation users, project rules. |
| Contact list | `/app/contacts` | `contact.view` | Search, tag/city/owner filters. |
| New contact | `/app/contacts/new` | `contact.create` | — |
| Contact detail | `/app/contacts/:id` | `contact.view` | Profile, every lead they ever had, consent flags, possible email duplicates. |
| Project list | `/app/projects` | `project.view` | With live inventory counts per project. |
| New / edit project | `/app/projects/new`, `/app/projects/:id/edit` | `project.create` / `project.edit` | The full project record. |
| Project detail / stepper | `/app/projects/:id?step=…` | `project.view` | Seven steps: basics · location · sales · media · inventory · pricing · review. Resumable from any of them. |
| Inventory picker | `/app/inventory` | `inventory.view` | Project chooser (skipped when there is only one). |
| Inventory | `/app/inventory/:projectId` | `inventory.view` | List view with 8 filters, or floor-grid view. Prices shown only with `inventory.view_prices`. |
| New cost sheet | `/app/leads/:id/cost-sheets/new` | `costsheet.create` | Pick unit → live computed preview → discount → payment plan. |
| Cost sheet | `/app/cost-sheets/:id` | `costsheet.create`, `inventory.view_prices` | Full breakdown, approval state, share link. |
| Discount approvals | `/app/approvals` | `discount.approve` | Pending queue with approve / reject / request-change. |
| Mark booked | `/app/leads/:id/bookings/new` | `unit.book` | Readiness checklist, prefilled from the active block, or a unit picker when there is none. |
| Booking | `/app/bookings/:id` | `unit.book`, `lead.view` | The confirmed sale. |
| Opportunities | `/app/opportunities/resale`, `/rental` | `lead.view` | Queue with 90/60/30-day windows and summary cards. |
| Communication campaigns | `/app/campaigns/communication` | `campaign.view` | List with delivery counters. |
| New campaign | `/app/campaigns/communication/new` | `campaign.create` | Audience builder with a live recipient count before sending. |
| Campaign detail | `/app/campaigns/:id` | `campaign.view` | Counters, recipient log, send button. |
| Campaign performance | `/app/campaigns/performance` | `campaign.view_performance` | Spend → leads → visits → blocks → bookings → revenue, CPL/ROAS, attribution switch. |
| Reports | `/app/reports/:kind` | `report.view` + scope | Leads, sales, projects, campaigns, activities. |
| Organization | `/app/setup/organization` | `setup.organization` | Identity, timezone, currency, locale. |
| Users | `/app/setup/users` | `setup.users` | Invite, role change, status change. |
| Roles | `/app/setup/roles`, `/app/setup/roles/:id` | `setup.roles` | Create/clone, and the full permission matrix editor. |
| Stages | `/app/setup/stages` | `setup.stages` | Stages and sub-stages with semantics and requirements. |
| Masters | `/app/setup/action-types`, `/visit-outcomes`, `/sources`, `/tags` | per-master | Four flat lists sharing one screen. |
| Response SLA | `/app/setup/sla` | `setup.sla` | Defaults, business hours, per-project overrides. |
| Templates & acknowledgement | `/app/setup/templates` | `setup.templates` | Message templates and acknowledgement rules. |
| Nurture | `/app/setup/nurture` | `setup.nurture` | Sequences with steps and stop conditions. |
| Integrations | `/app/setup/integrations` | `setup.integrations` | Providers, webhook URLs, key rotation. |
| Integration health | `/app/setup/health` | `setup.integrations` | Provider status, failed webhooks, background job health. |
| Audit trail | `/app/setup/audit` | `setup.organization`, `setup.roles` | Read-only, filterable by entity and user. |
| Error page | any failure | — | Friendly message, never raw technical detail. |

---

## 2. Authentication

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/login` | — | Redirects to the dashboard if already signed in. |
| POST | `/login` | `email`, `password`, `next` | Rate limited (30 / 15 min). Password is verified **before** any organization chooser appears, so the response cannot enumerate which organizations an address belongs to. `next` is only honoured when it starts with `/app/`. |
| POST | `/login/organization` | `userId` | Completes a multi-tenant login from the session's pending candidate list. |
| POST | `/logout` | — | Destroys the session. |
| GET/POST | `/forgot-password` | `email` | Rate limited. Always responds the same way. Outside production the reset link is shown on screen, because no email provider is configured. Token lives 1 hour. |
| GET/POST | `/reset-password` | `token`, `password`, `confirm` | Both passwords must match; strength is validated. |
| GET/POST | `/accept-invite` | `token`, `password`, `confirm` | Activates an `INVITED` user and signs them in. Invite token lives 7 days. |
| POST | `/app/profile/password` | `currentPassword`, `password`, `confirm` | Requires the current password. |

**Session behaviour:** MongoDB-backed, rolling 12 h, regenerated on every login. A user
deactivated mid-session — or whose role or tenant is disabled — has their session dropped
on their next request.

---

## 3. Dashboards and work queues

### Sales tiles (`/app/dashboard`)

| Tile | Exact filter |
|---|---|
| New leads | owned by me · `ACTIVE` · `firstGenuineActionAt` is null · not archived |
| Today's follow-ups | assigned to me · `PENDING` · due inside today in the tenant timezone |
| Today's visits | my visits scheduled today · status `PLANNED`/`CONFIRMED`/`IN_PROGRESS` |
| Missed follow-ups | assigned to me · `PENDING` or `MISSED` · due time already past |
| Re-inquiries | owned by me · `ACTIVE` · `reinquiryPendingAt` set |

The tile count and the tile list use the **same filter**, so a count and its records can
never disagree. Follow-up queues sort overdue-first, then by due time, then by lead
priority, and hide rows whose lead is no longer active.

### Manager tiles (`?view=team`)

Scope is the manager's team (self + direct reports), or the whole organization for `all`.

| Tile | Filter |
|---|---|
| Unattended new leads | team-owned · active · never genuinely attended |
| SLA missed | team-owned · active · `slaBreached` · still unattended |
| Today's team follow-ups | assigned to team · pending · due today |
| Today's visits | team visits today |
| Team missed follow-ups | assigned to team · overdue |
| Re-inquiries | team-owned · pending re-inquiry |
| Unassigned | tenant-wide · active · no owner |

**Snapshot** alongside: received today, connected today, responded today, breached today,
the five users with the most missed follow-ups, the five at-risk leads waiting longest, and
blocks expiring in the next 24 hours.

### Notifications

| Method | Path | Notes |
|---|---|---|
| GET | `/app/notifications` | Latest 50 with unread count. |
| POST | `/api/notifications/read` | Marks all of this user's unread notifications read. |

---

## 4. Leads

### List — `GET /app/leads`

Filters: `q` (name / mobile / email), `stageId`, `projectId`, `ownerUserId`, `sourceId`,
`priority`, `slaStatus`, `status`, `purpose`, `unassigned=1`, `from`, `to`.
Sort: `sortBy` (default `latestInquiryAt`), `sortDir`. 25 per page.
Archived leads are always excluded. The user's data scope is applied inside the query.

### Create — `POST /api/leads` · `lead.create`

| Field | Required | Notes |
|---|---|---|
| `contactId` | one of these two | Use an existing contact… |
| `firstName` + `primaryMobile` | one of these two | …or create one inline. |
| `lastName`, `email`, `city` | no | Contact enrichment. |
| `sourceId` | **yes** | A lead without a source is not allowed. |
| `sourceDetail` | no | Free text. |
| `projectId` | no | |
| `ownerUserId` | no | Defaults to the creating user. |
| `budgetMinMinor`, `budgetMaxMinor` | no | Parsed from typed currency into integer minor units. |
| `purpose` | no | `SELF_USE` / `INVESTMENT` / `RENTAL_INCOME` / `OTHER` |
| `preferredConfigurations` | no | List. |
| `requirementNote` | no | |

Creates the lead in the `NEW` stage, writes the first inquiry touch, increments the
contact's inquiry count, logs `LEAD_CREATED`, and records the assignment if an owner was set.

### Workspace — `GET /app/leads/:id`

Loads in one pass: the lead, its timeline, all stages / sub-stages / action types / visit
outcomes, active users, every follow-up, the contact's other leads, the shortlist with live
prices, all visits, all cost sheets, active blocks, and active projects — so every drawer on
the page can open without another round trip.

### Actions

| Method | Path | Permission | Fields | Rules |
|---|---|---|---|---|
| POST | `/api/leads/:id` | `lead.edit` | `projectId`, `budgetMinMinor`, `budgetMaxMinor`, `purpose`, `priority`, `preferredConfigurations`, `preferredFacing`, `areaMin`, `areaMax`, `requirementNote` | Only these fields are directly editable. System fields (source history, SLA measurements, counters) move only through actions. Max budget cannot be below min. |
| POST | `/api/leads/:id/stage` | `lead.edit`, `lead.mark_lost` | `stageId`, `subStageId`, `note` | Sub-stage must belong to the stage. `Lost` requires a reason. `Booked`/`Blocked` are refused — they belong to their own actions. A terminal stage cancels all pending follow-ups. |
| POST | `/api/leads/:id/transfer` | `lead.transfer` | `toUserId`, `reason` *(required)*, `note` | Target must be an active user and not the current owner. Pending follow-ups move with the lead. Full history is retained. Does **not** advance the round-robin cursor. |
| POST | `/api/leads/:id/reopen` | `lead.reopen_lost` | `stageId`, `ownerUserId`, `reason` *(required)* | Only for terminal leads, and never for booked ones. Target stage must be active and non-terminal. Lost history is preserved. |
| POST | `/api/leads/:id/notes` | `note.create` | `body` | `@Name` is resolved against active users and fires a notification with a deep link. |
| POST | `/api/leads/:id/temperature` | `lead.edit` | `mode` = `MANUAL` (+ `temperature`, `reason`) or `AUTO` | V1.1 §96. A manual pin needs a reason, is logged on the timeline and audited, and survives automatic recalculation until returned to auto. |
| GET | `/api/contacts/lookup?mobile=&projectId=` | `lead.create` | — | V1.1 §8.2. Live duplicate check while the capture form is being typed. Returns `kind`: `CONTACT_ONLY` / `ACTIVE_SAME_PROJECT` / `LOST_SAME_PROJECT`, plus `bookedHere` and the inquiry count. |
| GET | `/api/search?q=` | any | — | V1.1 §5.7. Suggestion endpoint for the dashboard. Returns `access`: `EDIT` / `READ` / `OWNERSHIP_ONLY`, and `createLeadHref` when an exact mobile finds nothing. |

---

## 5. Follow-ups and actions

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/leads/:id/followups` | `followup.create` | `actionTypeId`, `date`, `time`, `note`, `assignedUserId`, `priority`, `returnTo` |
| POST | `/api/followups/:id/complete` | `followup.complete` | `subStageId`, `stageId`, `note`, `nextActionTypeId`, `nextDate`, `nextTime`, `nextNote`, `returnTo` |
| POST | `/api/leads/:id/log-action` | `followup.complete`, `followup.create` | the same, plus a required `actionTypeId` |
| POST | `/api/followups/:id/reschedule` | `followup.edit_own`, `followup.edit_team` | `date`, `time`, `note`, `returnTo` |
| POST | `/api/followups/:id/cancel` | `followup.edit_own`, `followup.edit_team` | `reason` |

**Rules across all of them:**

- A terminal lead takes no new follow-ups — reopen it first.
- A new due time must be in the future (one minute of grace for clock skew).
- A follow-up may be assigned to someone other than the lead owner, but only to an **active**
  user.
- Completing requires an outcome **and** a next action, unless the resulting stage is
  terminal.
- `returnTo` is honoured only when it starts with `/app/`, so a completed follow-up lands
  back on the queue it came from.
- `log-action` additionally clears the lead from the Re-inquiries tile.

**Completion order** (`applyOutcome()`), deliberate because a standalone MongoDB has no
transactions:

```
1. resolve the resulting stage, validate the stage/sub-stage pair
2. validate the next action        ← nothing is written before this passes
3. create the next follow-up
4. close the current follow-up (recording whether it was on time)
5. write the interaction + outcome to the timeline
6. move the stage if the outcome caused one
7. re-sync the lead's next-action fields, then stop the SLA clock
```

---

## 6. Site visits

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/leads/:id/visits` | `visit.create` | `projectId`, `date`, `time`, `salesUserId`, `visitingWith` (`DIRECT`/`CHANNEL_PARTNER`), `channelPartnerName`, `channelPartnerMobile`, `visitorCount`, `notes`, `returnTo` |
| POST | `/api/visits/:id/complete` | `visit.complete` | `outcomeId` *(required)*, `notes`, `unitsShownIds[]`, `shortlistUnitIds[]`, `stageId`, `nextActionTypeId`, `nextDate`, `nextTime`, `returnTo` |
| POST | `/api/visits/:id/reschedule` | `visit.edit` | `date`, `time`, `note` |
| POST | `/api/visits/:id/cancel` | `visit.cancel` | `reason`, `noShow=1` |
| GET | `/api/visits/:id/units` | `visit.complete` | JSON list of the project's active units, for the completion drawer |

**Rules:**

- A closed lead cannot take a scheduled visit (the QR walk-in path is exempt).
- Channel-partner name is mandatory when `visitingWith=CHANNEL_PARTNER`; the mobile is
  mandatory too when the organization requires it.
- Completion demands an outcome, and the **next action is validated before the visit is
  marked complete** — a rejected next action leaves the visit open rather than half-closed.
- With auto-stage on, scheduling moves the lead to `VISIT_PLANNED` and completing moves it
  to `VISIT_DONE`.
- No-show is recorded distinctly from a cancellation.

---

## 7. Contacts

| Method | Path | Permission | Fields |
|---|---|---|---|
| GET | `/app/contacts` | `contact.view` + scope | filters: `q`, `tagId`, `city`, `ownerUserId` |
| POST | `/api/contacts` | `contact.create` | `firstName` *(req)*, `lastName`, `primaryMobile` *(req)*, `altMobile`, `email`, `city`, `state`, `pincode`, `address`, `tagIds[]` |
| GET | `/app/contacts/:id` | `contact.view` | Profile + every lead + possible email duplicates |
| POST | `/api/contacts/:id` | `contact.edit` | same field set |
| POST | `/api/contacts/:id/consent` | `contact.edit` | `whatsappOptOut`, `smsOptOut`, `emailOptOut`, `dnd`, `reason` |

**Rules:**

- The **normalized mobile is the duplicate key**. A clash is refused with a pointer to the
  existing contact.
- An alternate mobile must differ from the primary.
- A shared **email** produces a *warning list* on the detail screen, never an automatic
  merge — two different mobiles are two different people until a human says otherwise.
- Inbound payloads enrich blank fields only; they never overwrite a human correction.
- Contacts with history are archived, not deleted, and archiving is blocked while active
  leads exist.

---

## 8. Projects and inventory

### Project

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/projects` | `project.create` | Full project record; a QR token is minted automatically. |
| POST | `/api/projects/:id` | `project.edit` | Same fields. |
| POST | `/api/projects/:id/status` | `project.publish`, `project.edit` | `DRAFT` / `ACTIVE` / `ON_HOLD` / `SOLD_OUT` / `ARCHIVED`. Anything other than `ACTIVE` unpublishes the mini site. `ARCHIVED` also sets the archive flag — projects with leads are archived, never deleted. |
| POST | `/api/projects/:id/mini-site` | `project.manage_minisite` | `published`, `showAvailability`, `showConfigurationAvailability`, `showStartingPrice`, `ctaHeadline`. Only an active project may publish. |

Project fields: `name`, `developerName`, `code`, `status`, `reraNumber`, `reraUrl`,
`projectType` (`RESIDENTIAL`/`COMMERCIAL`/`PLOTTING`/`VILLA`/`MIXED_USE`), `propertyTypes[]`,
`address`, `landmark`, `city`, `state`, `pincode`, `latitude`, `longitude`, `mapUrl`,
`startingPriceMinor`, `priceRangeMaxMinor`, `configurations[]`, `areaMin`, `areaMax`,
`possessionDate`, `salesContactName`, `salesContactMobile`, `bookingTerms`, `keyUsps[]`,
`overview`, `amenities[]`, `highlights[]`.

### Hierarchy

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/projects/:id/towers` | `inventory.edit`, `project.edit` | `name`, `code`, `type` (`TOWER`/`BLOCK`/`WING`/`PHASE`/`CLUSTER`), `floorCount`, `displayOrder` — floors are created automatically |
| POST | `/api/projects/:id/unit-types` | `inventory.edit`, `project.edit` | `name`, `propertyType`, `bedrooms`, `bathrooms`, `carpetArea`, `builtUpArea`, `superBuiltUpArea`, `defaultBaseRateMinor`, `description` |
| POST | `/api/projects/:id/units/generate` | `inventory.edit` | `towerId`, `unitTypeId`, `unitsPerFloor` (1–50), `numberPattern`, `startIndex`, `confirm` — **without `confirm=1` this returns the preview and writes nothing** (V1.1 §32.2) |
| POST | `/api/projects/:id/units` | `inventory.edit` | one unit manually |
| POST | `/api/units/:unitId` | `inventory.edit` | edit a unit — **status is never editable here** |
| POST | `/api/units/:unitId/status` | `inventory.edit` | `status`, `reason` — an audited manual correction |

**Numbering patterns:** `{floor}` · `{tower}` · `{index}` · `{index:NN}` (zero-padded).
`{floor}{index:02}` → `301, 302, 303`. `{tower}-{floor}{index:02}` → `A-301`.
Existing unit numbers are skipped, so re-running after adding a floor is safe.

**Manual status change rules:** blocked and booked units must have their block released or
booking cancelled first; the transition must be legal in the state machine; the change is
audited with before/after and the given reason.

### Pricing

| Method | Path | Permission |
|---|---|---|
| POST | `/api/projects/:id/pricing` | `pricing.override`, `project.edit` |
| POST | `/api/projects/:id/pricing/:componentId` | `pricing.override`, `project.edit` |
| POST | `/api/projects/:id/payment-plans` | `project.edit` |
| POST | `/api/projects/:id/payment-plans/:planId` | `project.edit` |
| POST | `/api/projects/:id/payment-plans/:planId/toggle` | `project.edit` |
| POST | `/api/projects/:id/assets` | `project.manage_media` — multipart |
| POST | `/api/projects/:id/assets/:assetId` | `project.manage_media` |
| POST | `/api/projects/:id/assets/:assetId/archive` | `project.manage_media` |

**Payment plan fields** (V1.1 §35): `name`, `type`, `description`, `displayOrder`, plus
repeated milestone rows `msLabel`, `msPercentage`, `msDueRule`
(`ON_BOOKING` / `DAYS_AFTER_BOOKING` / `CONSTRUCTION` / `ON_POSSESSION` / `CUSTOM`),
`msDueOffsetDays`, `msNote`. An active plan with milestones must total exactly 100%;
a plan with no milestones is a legacy plan and stays selectable. Activation is only ever
changed by the toggle route, so editing a live plan never takes it offline.

**Asset fields** (V1.1 §31): `file` (multipart), `assetType` = `IMAGE` / `DOCUMENT`,
`category`, `title`, `caption`, `customerVisible`, `aiUsable`, `internalNote`,
`displayOrder`. Images accept JPG/PNG/WEBP, documents PDF/Word/Excel — validated server-side
against the declared type. A second `COVER` image demotes the previous one to gallery.
Archived files stay resolvable for anything already shared.

> The upload route parses its own multipart body, so its CSRF token is verified inside the
> route rather than by the global middleware. The deferral is an explicit route allowlist in
> `middleware/csrf.js`, and a test asserts a bad token is still refused.

Pricing component fields: `name`, `kind`, `calcType`, `rateMinor`, `percentage`, `areaBasis`
(`CARPET`/`BUILT_UP`/`SALEABLE`), `percentageBaseKinds[]`, `displayOrder`, `mandatory`,
`customerVisible`, `editableBySales`. Applicability may also be limited by unit types,
towers, floor range and effective dates.

**Calculation types:**

| `calcType` | Amount |
|---|---|
| `FIXED` | the rate, flat |
| `PER_AREA` | rate × the area on the configured basis |
| `PER_UNIT_COUNT` | rate × the unit's parking slots |
| `PERCENTAGE` | percentage of the sum of the named base kinds (or of base) |

Special kinds: `BASE` honours per-unit overrides first; `FLOOR_RISE` multiplies by floors
above its start floor; `TAX` is charged after the discount; `STAMP_DUTY` and `REGISTRATION`
are informational and excluded from the final consideration; `DISCOUNT` is entered per cost
sheet, not fixed in the rate card.

### Inventory browsing

`GET /app/inventory/:projectId` · `inventory.view`

Filters: `towerId`, `floorId`, `unitTypeId`, `status`, `facing`, `q` (unit number),
`areaMin`/`areaMax`, `priceMin`/`priceMax`. Two views: `list` (60 per page, with computed
prices) and `grid` (floor-by-floor, highest floor first). Prices are computed and shown
only for users with `inventory.view_prices`.

---

## 9. Deals: cost sheets, approvals, blocks, bookings

### Shortlist

| Method | Path | Permission |
|---|---|---|
| POST | `/api/leads/:id/shortlists` | `unit.shortlist` — body: `unitId`, `note`, `returnTo` |
| POST | `/api/leads/:id/shortlists/:unitId/remove` | `unit.shortlist` |

Allowed for `AVAILABLE` and `HOLD` units, and for a unit already blocked **for this same
lead**. Anything else is refused by name. Removal never changes inventory status.

### Cost sheet

| Method | Path | Permission | Fields |
|---|---|---|---|
| GET | `/app/leads/:id/cost-sheets/new` | `costsheet.create` | `?unitId=`, `?discount=` drive a live preview |
| POST | `/api/leads/:id/cost-sheets` | `costsheet.create` | `unitId`, `discount`, `paymentPlanId`, `notes`, `validUntil` |
| GET | `/app/cost-sheets/:id` | `costsheet.create`, `inventory.view_prices` | — |
| POST | `/api/cost-sheets/:id/share` | `costsheet.create` | mints the share token |

**Rules:** a closed lead cannot be quoted; booked / registered / not-for-sale units cannot
be quoted; the payment plan must belong to the unit's project; totals always come from the
engine; a new sheet supersedes the previous one for that lead+unit and invalidates its
pending approval; sharing is refused while pending approval, after rejection, or once
superseded.

**Computed outputs:** every line with its basis, quantity, rate and amount; `basePriceMinor`,
`grossAmountMinor`, `discountMinor`, `discountPercentage`, `taxAndChargesMinor`,
`finalConsiderationMinor`, plus informational lines listed separately.

### Approvals

| Method | Path | Permission | Fields |
|---|---|---|---|
| GET | `/app/approvals` | `discount.approve` | pending queue (admins see all) |
| POST | `/api/approvals/:id` | `discount.approve` | `decision` = `APPROVE` / `REJECT` / `CHANGE`, `note` |

Rule matching: the first rule whose threshold band contains the discount, lowest level
first, with project-specific rules beating organization-wide ones. Trigger type is either
`DISCOUNT_AMOUNT` or discount percentage.

Refusals: already decided; no `discount.approve` permission; self-approval without
`discount.approve_own`; not being one of the named approvers (admins excepted).

### Blocks

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/leads/:id/blocks` | `unit.block` | `unitId`, `costSheetId`, `tokenAmount`, `expiryHours`, `notes` |
| POST | `/api/blocks/:id/release` | `unit.release_block` | `reason` |

Expiry resolution: explicit override → project setting → tenant setting → 48 hours. The
deadline is computed and **stored on the block**, so later configuration changes cannot move
an existing deadline.

The unit transition is a single atomic conditional update from `AVAILABLE`/`HOLD` to
`BLOCKED`; losing the race produces a friendly conflict message. If the block record then
fails to write, the unit is handed straight back.

### Bookings

| Method | Path | Permission |
|---|---|---|
| GET | `/app/leads/:id/bookings/new` | `unit.book` |
| POST | `/api/leads/:id/bookings` | `unit.book` |
| GET | `/app/bookings/:id` | `unit.book`, `lead.view` |

| Field | Required | Notes |
|---|---|---|
| `unitId` | yes | |
| `costSheetId` | no | Must belong to this lead and unit, and be bookable. |
| `bookingDate` | yes | |
| `finalPrice` | yes | Must be > 0, and must match the approved sheet where approval was required. |
| `bookingAmount` | yes | Token/booking amount; cannot be negative. |
| `paymentPlanId` | yes | Must belong to the unit's project. |
| `buyerPurpose` | yes | `SELF_USE` / `INVESTMENT` / `RENTAL_INCOME` / `OTHER` |
| `expectedExitDate`, `expectedExitPrice`, `expectedRoiPercentage` | no | Investment purpose → creates a resale opportunity. |
| `expectedRentalStartDate`, `expectedRent`, `furnishing` | no | Rental purpose → creates a rental opportunity. |
| `purposeNotes`, `notes` | no | |

**Post-booking:** the unit is `BOOKED`, the block becomes `CONVERTED`, the lead is
`TERMINAL` in the `BOOKED` stage, every pending follow-up is cancelled, attribution is
frozen onto the booking record, and the resale/rental opportunity is created. A booked lead
can never be reopened.

### Opportunities

| Method | Path | Permission | Fields |
|---|---|---|---|
| GET | `/app/opportunities/:kind` | `lead.view` | `kind` = `resale` / `rental`; filters `status`, `mine=1`, `window` (days) |
| POST | `/api/opportunities/:kind/:id` | `lead.edit` | `status`, `assignedUserId`, `nextActionAt`, `nextActionNote`, `notes` |

---

## 10. Marketing

### Communication campaigns

| Method | Path | Permission | Fields |
|---|---|---|---|
| GET | `/app/campaigns/communication/new` | `campaign.create` | Audience filters echo back as query parameters with a live preview and count. |
| POST | `/api/campaigns/communication` | `campaign.create` | `name`, `channel`, `templateId`, `scheduledDate`, `scheduledTime`, `saveSegmentAs`, plus audience filters |
| POST | `/api/campaigns/:id/send` | `campaign.send` | — |

**Audience filters:** `tagId`, `city`, `ownerUserId`, `projectId`, `stageId`, `sourceId`,
`campaignId`, `purpose`, `leadStatus`, `hasVisited=1`, `hasBooked=1`, `createdFrom`,
`createdTo`, `lastActivityWithinDays`.

Lead-shaped filters resolve to contact ids first, because the audience is always a list of
people. Segments are dynamic (re-evaluated every time); the campaign keeps its own counts.

**Send rules:** the template channel must match the campaign channel; the status is claimed
atomically so a double click cannot double-send (*"This campaign is already sending."*);
opted-out contacts are logged as `SKIPPED` and reported as excluded; the summary reports
sent / excluded / failed. A mid-send failure marks the campaign `FAILED` with its error.

Counters shown: queued, sent, delivered, read, replied, failed, skipped.

### Marketing spend and attribution

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/campaigns/marketing` | `campaign.edit_spend` | `name`, `platform`, `projectId`, `externalCampaignId`, `trackingCode`, `startDate`, `endDate`, `spend`, `notes` |
| POST | `/api/campaigns/marketing/:id/spend` | `campaign.edit_spend` | `spend` |
| POST | `/api/campaigns/attribution` | `setup.attribution` | `attributionModel` = `FIRST_TOUCH` / `LAST_TOUCH` |

Switching the model rewrites nothing — attribution is derived from stored touch history on
every read.

### Nurture

| Method | Path | Permission |
|---|---|---|
| GET | `/app/setup/nurture` | `setup.nurture` |
| POST | `/api/setup/nurture` | `setup.nurture` |
| POST | `/api/setup/nurture/:id/toggle` | `setup.nurture` |

Sequence fields: `name`, `projectId`, `stageId`, `stopOnBooked`, `stopOnLost`, plus repeated
step rows: `stepDelay` (whole days), `stepKind` (`MESSAGE`/`TASK`), `stepTemplateId`,
`stepActionTypeId`, `stepNote`. At least one usable step is required.

Matching is most-specific-wins on project + stage + sub-stage. A lead is enrolled once. Stop
conditions: booked, lost, a configured stage reached, contact DND, sequence disabled, or the
lead archived.

---

## 11. Reports, search and AI

| Method | Path | Permission |
|---|---|---|
| GET | `/app/reports/:kind` | `report.view` + scope |
| GET | `/app/reports/:kind/export` | `report.export` — CSV, same scope and filters, audited |
| GET | `/app/dashboard/management` | `dashboard.management` |
| GET | `/app/search?q=` | any — each result type gated by its own permission and scope |

`kind` ∈ `leads` · `sales` · `projects` · `campaigns` · `activities`.
Filters: `from`, `to`, `projectId`, `ownerUserId`, `stageId`, `sourceId`, `campaignId`,
`purpose`, `status`. Default range: last 30 days in the tenant timezone.

**Search** covers contacts (name / email / mobile, normalized), leads (by id, plus every lead
of a matched contact), projects (by name) and units (by unit number).

### AI endpoints — all read-only

| Method | Path | Permission | Returns |
|---|---|---|---|
| GET | `/api/ai/leads/:id/summary` | `lead.view` + scope | factual bullets with their source |
| GET | `/api/ai/leads/:id/next-action` | `lead.view` | `{action, why, decidedBy: "user"}` |
| GET | `/api/ai/leads/:id/priority` | `lead.view` | `{score, level, signals[], caveat}` |
| GET | `/api/ai/leads/:id/units` | `lead.view` | matching available units + the basis used; prices only with `inventory.view_prices` |
| GET | `/api/ai/ask?q=&projectId=` | `project.view` | grounded answer + supporting rows |

**Priority signals and their points:** active block +35 · cost sheet prepared +20 ·
completed visit +20 · units shortlisted +10 · re-inquired +10 · budget captured +5 ·
investor intent +5 · active in the last 3 days +10 · no activity for 3+ weeks −10 ·
first response was late −5. Clamped to 0–100. `HIGH` ≥ 60, `MEDIUM` ≥ 30, else `LOW`.

**Q&A understands:** a named unit's price and status, possession/handover, amenities,
payment plans, facing, and availability by configuration and budget (`3 BHK under 80 lakh`,
`under 1.2 cr`). Anything it has no data for, it says so.

---

## 12. Setup

### Organization

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/setup/organization` | `setup.organization` | `name`, `legalName`, `timezone`, `currency` (3 letters), `locale`, `website`, `address` |

### Users

| Method | Path | Permission | Fields / rules |
|---|---|---|---|
| POST | `/api/setup/users` | `setup.users` | `name`, `email`, `mobile`, `roleId`, `managerId`. Creates an `INVITED` user and shows the activation link once. |
| POST | `/api/setup/users/:id/status` | `setup.users` | `ACTIVE` / `SUSPENDED` / `INACTIVE`. You cannot change your own status. Deactivation is blocked while the user holds active leads or pending follow-ups. |
| POST | `/api/setup/users/:id/role` | `setup.users` | `roleId`, `managerId` |

### Roles

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/api/setup/roles` | `setup.roles` | `name`, `description`, `cloneFromId` |
| POST | `/api/setup/roles/:id` | `setup.roles` | The whole permission matrix as `perm.<key>` fields. Unchecked or `none` values are dropped. Scoped keys carry `own`/`team`/`all`. Every change is audited with before/after. |

### Stages and sub-stages

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/setup/stages` | `setup.stages` | `name`, `semanticType`, `displayOrder`, `colorToken`, `terminal`, `requiresSubStage`, `requiresNextAction` |
| POST | `/api/setup/stages/:id` | `setup.stages` | same |
| POST | `/api/setup/stages/:id/toggle` | `setup.stages` | blocked while active leads sit in the stage |
| POST | `/api/setup/sub-stages` | `setup.substages`, `setup.stages` | `stageId`, `name`, `displayOrder`, `defaultActionTypeId`, `defaultFollowupOffsetHours`, `requiresNote` |
| POST | `/api/setup/sub-stages/:id/toggle` | `setup.substages`, `setup.stages` | — |

A terminal stage automatically has "requires next action" forced off.

### Flat masters

`GET /app/setup/:master` · `POST /api/setup/:master` · `POST /api/setup/:master/:id/toggle`

| Master | Permission | Extra field |
|---|---|---|
| `action-types` | `setup.action_types` | Behaviour: `CALL`, `WHATSAPP`, `MEETING`, `SITE_VISIT`, `COST_SHEET`, `BROCHURE`, `VIDEO_CALL`, `EMAIL`, `OTHER` |
| `visit-outcomes` | `setup.visit_outcomes` | — |
| `sources` | `setup.sources` | Category, which drives capture routing and reporting |
| `tags` | `setup.tags` | — |

Toggle deactivates; nothing here is ever deleted.

### SLA

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/setup/sla/defaults` | `setup.sla` | `slaResponseMinutes`, `slaWarningMinutes`, `slaEscalationMinutes`, `slaAutoReassignMinutes`, `slaMaxAutoReassignments`, `slaBusinessHoursOnly`, `businessStart`, `businessEnd`, `reinquiryRestartsSla` |
| POST | `/api/setup/sla/rules` | `setup.sla` | `projectId`, the same thresholds, `escalationUserIds[]` — upserted per project |
| POST | `/api/setup/sla/rules/:id/toggle` | `setup.sla` | — |

Validation: warning ≤ escalation ≤ auto-reassign.

### Templates and acknowledgement

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/setup/templates` | `setup.templates` | `name`, `channel`, `purpose`, `subject`, `body` |
| POST | `/api/setup/templates/:id` | `setup.templates` | same |
| POST | `/api/setup/ack-rules` | `setup.templates` | `projectId`, `sourceId`, `channel`, `templateId`, `fallbackChannel`, `fallbackTemplateId`, `sendDelayMinutes` |
| POST | `/api/setup/ack-rules/:id/toggle` | `setup.templates` | — |

The template's channel must match the rule's channel.

### Integrations

| Method | Path | Permission | Fields |
|---|---|---|---|
| POST | `/api/setup/integrations` | `setup.integrations` | `category`, `provider`, `name`, `defaultProjectId`, `defaultSourceId`, `signingSecret` |
| POST | `/api/setup/integrations/:id/rotate-key` | `setup.integrations` | mints a new webhook key; the old URL stops working immediately |
| POST | `/api/setup/integrations/:id/test` | `setup.integrations` | `mobile`, `name` — V1.1 §64. Sends a genuine delivery through the real capture path and reports the resolved source, project and owner. There is no dry-run mode, and the UI says so before you press it. |
| POST | `/api/setup/integrations/:id/toggle` | `setup.integrations` | enable / disable |

The integration row also opens an **API console** (V1.1 §58–§65) carrying the endpoint URL,
headers, field mapping, a sample payload, a copyable cURL, every response a provider will
actually receive (201 new, 201 re-inquiry, 200 duplicate, 400/401/404), and the signature
rule. The stored signing secret is never rendered.

### Lead allocation

| Method | Path | Permission | Fields |
|---|---|---|---|
| GET | `/app/setup/lead-allocation` | `setup.distribution` | — |
| POST | `/api/setup/assignment-pools` | `setup.distribution` | `name`, `scopeType` = `DEFAULT`/`PROJECT`, `projectId`, `memberUserIds[]`, `escalationUserIds[]` |
| POST | `/api/setup/assignment-pools/:id` | `setup.distribution` | same |
| POST | `/api/setup/assignment-pools/:id/toggle` | `setup.distribution` | — |
| POST | `/api/setup/assignment-pools/:id/reorder` | `setup.distribution` | `memberUserIds[]` in rotation order |

**Rules (V1.1 §76):** one active rule per project · at least one member before activation ·
active users of this tenant only · no duplicate members · round robin only in this version ·
deactivate rather than delete · the default pool cannot be emptied or switched off · the
rotation cursor is never editable, and the next-up preview never advances it.

Inbound categories (`META_LEAD_ADS`, `GOOGLE_ADS`, `LINKEDIN_ADS`, `PROPERTY_PORTAL`,
`WEBSITE_WEBHOOK`) receive a webhook key on creation. Signing secrets are sealed with
AES-256-GCM and are never rendered again — only masked.

### Audit

`GET /app/setup/audit` · `setup.organization`, `setup.roles` — filter by `entity` and
`userId`, 50 per page. Read-only: no route in the application can edit or delete an audit
record.

---

## 13. Public endpoints

No session. Mounted ahead of the CSRF gate. Rate limited at 40 requests / 10 minutes.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | `{ok, db, transactions}` — no auth |
| POST | `/api/webhooks/leads/:webhookKey` | Inbound lead capture. See the mapping table in [CRM-GUIDE §12](CRM-GUIDE.md#12-integrations--connecting-the-outside-world). |
| POST | `/api/webhooks/messages/:webhookKey` | Delivery status callbacks |
| GET/POST | `/visit/:qrToken` | QR walk-in form |
| GET | `/p/:slug` | Project mini site |
| POST | `/p/:slug/inquire` | Mini-site inquiry |
| GET | `/share/cost-sheet/:token` | Read-only customer cost sheet |

---

## 14. Permission catalog

| Group | Keys |
|---|---|
| **Dashboard** | `dashboard.own`, `dashboard.team`, `dashboard.management` |
| **Leads** | `lead.view` **(scoped)**, `lead.create`, `lead.edit`, `lead.transfer`, `lead.bulk_transfer`, `lead.mark_lost`, `lead.reopen_lost`, `lead.view_source`, `lead.view_attribution`, `lead.view_contact_details`, `lead.export` |
| **Activities** | `followup.create`, `followup.edit_own`, `followup.edit_team`, `followup.complete`, `note.create`, `note.mention`, `call.view_recording` |
| **Site visits** | `visit.create`, `visit.edit`, `visit.complete`, `visit.cancel`, `visit.view_team` |
| **Projects** | `project.view`, `project.create`, `project.edit`, `project.publish`, `project.manage_media`, `project.manage_minisite` |
| **Inventory** | `inventory.view`, `inventory.view_prices`, `inventory.edit`, `unit.shortlist`, `unit.block`, `unit.release_block`, `unit.override_block_expiry`, `unit.book` |
| **Pricing** | `costsheet.create`, `discount.apply`, `discount.request_approval`, `discount.approve`, `pricing.override` |
| **Contacts** | `contact.view` **(scoped)**, `contact.create`, `contact.edit`, `contact.export`, `contact.manage_tags` |
| **Campaigns** | `campaign.view`, `campaign.create`, `campaign.send`, `campaign.view_performance`, `campaign.edit_spend`, `campaign.export` |
| **Reports** | `report.view` **(scoped)**, `report.export` |
| **Setup** | `setup.users`, `setup.roles`, `setup.stages`, `setup.substages`, `setup.action_types`, `setup.visit_outcomes`, `setup.sla`, `setup.templates`, `setup.integrations`, `setup.attribution`, `setup.approval_rules`, `setup.block_rules`, `setup.distribution`, `setup.sources`, `setup.tags`, `setup.nurture`, `setup.organization` |

Scoped keys take `none` / `own` / `team` / `all`. Everything else is a boolean.
`discount.approve_own` is an additional role flag that permits self-approval; it is off in
every default role.

---

## 15. State machines

### Lead

```
                 ┌──────────── re-inquiry revives a lost lead ────────────┐
                 ▼                                                        │
   NEW ──► NOT_CONNECTED ⇄ CONNECTED ──► VISIT_PLANNED ──► VISIT_DONE ──► BLOCKED ──► BOOKED (terminal)
                 │              │              │               │              │
                 └──────────────┴──────────────┴───────────────┴──────────────┴──► LOST (terminal)
                                                                                     │
                                                                          reopen (never for booked)
```

- `status` is derived: any terminal stage → `TERMINAL`, otherwise `ACTIVE`.
- `BLOCKED` and `BOOKED` are reachable **only** through the Block and Booking actions.
- `LOST` requires a reason sub-stage and cancels all pending follow-ups.

### Unit status state machine

| From | May go to |
|---|---|
| `AVAILABLE` | `HOLD`, `BLOCKED`, `BOOKED`, `NOT_FOR_SALE` |
| `HOLD` | `AVAILABLE`, `BLOCKED` |
| `BLOCKED` | `AVAILABLE`, `BOOKED` |
| `BOOKED` | `REGISTERED` |
| `REGISTERED` | — |
| `NOT_FOR_SALE` | `AVAILABLE` |

There is deliberately **no `HOLD` → `BOOKED` edge**: an internal hold must be resolved
first, so a held unit can never be sold out from under whoever placed it.

### Lead temperature (V1.1 §14)

```
new lead ─────────────► WARM  (unattended; never COLD)
   │ first genuine action
   ▼
AUTO scoring ⇄ MANUAL pin (needs a reason)
   │                        └─ "return to auto" recomputes immediately
   ▼
HOT ≥ 60   ·   WARM 30–59   ·   COLD < 30        terminal lead → no temperature
```

Signals: active block +35 · approved/shared quotation +20 · completed visit +20 ·
shortlisted +10 · re-inquiry +10 · budget captured +5 · investor intent +5 ·
activity in the last 3 days +10 · 3+ unsuccessful contact attempts −10 ·
idle 7–20 days −10 · idle 21+ days −20 · SLA breached −5. Clamped 0–100.

Recalculated on first action, re-inquiry, stage change, follow-up completion, visit
completion, shortlist, quotation, block, block expiry and SLA breach — plus a
`temperature.decay` sweep for leads that go quiet, since nothing fires an event when
nothing happens.

### Stage history (V1.1 §18)

One row per stage entry with `enteredAt` / `exitedAt`, written by `services/stageHistory`
on every transition and tagged with its `sourceAction`: `CAPTURE`, `MANUAL_OUTCOME`,
`FOLLOWUP_COMPLETE`, `VISIT_SCHEDULED`, `VISIT_COMPLETED`, `UNIT_BLOCKED`, `BOOKING`,
`REOPEN`, `REINQUIRY`. The funnel derives `completed` from these rows alone — a stage that
merely sorts earlier is `skipped`, never ticked.

### Follow-up

`PENDING` → `COMPLETED` / `CANCELLED`; `PENDING` → `MISSED` (by the background job when its
due time passes on an active lead); `MISSED` → `COMPLETED` / `CANCELLED` / back to `PENDING`
via reschedule.

### Site visit

`PLANNED` / `CONFIRMED` / `IN_PROGRESS` → `COMPLETED` (outcome required) / `CANCELLED` /
`NO_SHOW`.

### Cost sheet

`DRAFT` → `APPROVAL_PENDING` → `APPROVED` → `SHARED`; `APPROVAL_PENDING` → `REJECTED`, or
back to `DRAFT` on "request change". Any version → `SUPERSEDED` when a newer one is created.

### Block

`ACTIVE` → `RELEASED` (manual) / `EXPIRED` (timer) / `CONVERTED` (booking).

### Approval

`PENDING` → `APPROVED` / `REJECTED` / `CHANGE_REQUESTED` / `INVALIDATED` (the sheet changed).

### Communication campaign

`DRAFT` / `SCHEDULED` / `PAUSED` → `SENDING` → `SENT`, or → `FAILED`.

### Message

`QUEUED` → `SENT` → `DELIVERED` → `READ` → `REPLIED`; or `FAILED` / `SKIPPED`.
Out-of-order callbacks can never move a message backwards, except to `FAILED`.

### User

`INVITED` → `ACTIVE` ⇄ `SUSPENDED` / `INACTIVE`. Never deleted.

### Project

`DRAFT` / `ACTIVE` / `ON_HOLD` / `SOLD_OUT` / `ARCHIVED`. Leaving `ACTIVE` unpublishes the
mini site.

### Opportunity

`UPCOMING` / `IN_DISCUSSION` / `LISTED` are the open states used by the summary cards.

---

## 16. Configuration reference

### Environment

| Variable | Default |
|---|---|
| `NODE_ENV` | `development` |
| `PORT` | `3000` |
| `APP_URL` | `http://localhost:3000` |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/real_estate_crm` |
| `SESSION_SECRET` | dev-only placeholder — **required in production** |
| `SESSION_MAX_AGE_MS` | `43200000` (12 h) |
| `SECRETS_KEY` | derived from `SESSION_SECRET` |
| `SCHEDULER_TICK_MS` | `60000` |
| `UPLOAD_DIR` | `public/uploads` |
| `MAX_UPLOAD_BYTES` | `10485760` |

### Tenant settings

| Setting | Default | Effect |
|---|---|---|
| `attributionModel` | `LAST_TOUCH` | Which campaign gets credit in reporting. |
| `slaResponseMinutes` | 5 | The compliance target. |
| `slaWarningMinutes` | 5 | Owner is warned. |
| `slaEscalationMinutes` | 10 | Marked breached; managers told. |
| `slaAutoReassignMinutes` | 15 | Handed to the next user. |
| `slaMaxAutoReassignments` | 2 | Cap on automatic hand-offs. |
| `slaBusinessHoursOnly` | `false` | Count working seconds only. |
| `businessHours` | 09:30–19:00, Mon–Sat | The working window. |
| `reinquiryRestartsSla` | `true` | Re-inquiry restarts the response clock on an unattended lead. |
| `blockDurationHours` | 48 | Default block lifetime. |
| `blockReminderHours` | 6 | Reminder window before expiry. |
| `autoStageOnVisit` | `true` | Visit scheduling/completion moves the stage. |
| `qrRequireCpMobile` | `false` | Channel-partner mobile mandatory on the QR form. |

Tenant identity: `timezone` (`Asia/Kolkata`), `currency` (`INR`), `locale` (`en-IN`),
`country` (`IN`), `callingCode` (`91`), `dateFormat` (`dd MMM yyyy`).

### Per-project overrides

SLA rule (all five thresholds + escalation users) · block duration hours · assignment pool ·
pricing components · payment plans · acknowledgement rules · nurture sequences · mini-site
display switches.

---

## 17. Default seed data

Created for every new tenant, and fully editable afterwards.

**Stages** — `New Lead` (NEW) · `Not Connected` (NOT_CONNECTED, requires sub-stage) ·
`Connected` (CONNECTED) · `Site Visit Planned` (VISIT_PLANNED) · `Site Visit Done`
(VISIT_DONE) · `Block Unit` (BLOCKED) · `Booked` (BOOKED, terminal) · `Lost` (LOST,
terminal, requires sub-stage).

**Sub-stages** — Not Connected: No Answer, Busy, Switched Off, Wrong Number · Connected:
Interested, Call Later, Details Shared, Budget Discussion · Lost: Budget, Location,
Competitor, Not Interested, Purchased Elsewhere.

**Action types** — Call, WhatsApp, Meeting, Site Visit, Send Cost Sheet, Send Brochure,
Video Call, Email, Other.

**Visit outcomes** — Highly Interested, Interested, Follow-up Required, Negotiation, Unit
Shortlisted, Budget Mismatch *(negative)*, Location Concern *(negative)*, Not Interested
*(negative)*.

**Lead sources** — Facebook Ads, Instagram Ads (META) · Google Ads (GOOGLE) · LinkedIn Ads
(LINKEDIN) · Housing, MagicBricks, 99acres (PROPERTY_PORTAL) · Website (WEBSITE) · Landing
Page (LANDING_PAGE) · IVR Call (IVR) · WhatsApp (WHATSAPP) · Chatbot (CHATBOT) · Project QR
/ Walk-in (QR) · Walk-in (WALK_IN) · Referral (REFERRAL) · Manual Entry (MANUAL) · API (API).

**Tags** — Investor, Member, Channel Partner, Past Customer, NRI, High Intent.

**Roles** — Organization Admin, Sales Manager, Sales User, Marketing User, Management Viewer.

**Communication** — a WhatsApp acknowledgement template and an SMS fallback, plus an active
catch-all acknowledgement rule (WhatsApp → SMS fallback).

**Integrations** — simulated WhatsApp, SMS and email providers on the mock driver, plus a
`WEBSITE_WEBHOOK` integration with a live webhook key ready to paste into a website form.

**Assignment pool** — "Default sales pool" containing the admin, with the admin as
escalation user.

---

## 18. Background jobs

One tick per minute. Every job is idempotent and independently retryable.

| Job | Cadence | Batch | What it does |
|---|---|---|---|
| `sla` | 1 min | 500 leads | Warns, escalates and auto-reassigns unattended leads. Only touches leads that are active, assigned, and never genuinely attended. |
| `followups.missed` | 1 min | 500 | Flips overdue pending follow-ups to `MISSED` on active leads and logs each one. |
| `blocks.expiry` | 1 min | 200 + 200 | Sends the pre-expiry reminder once, then releases expired blocks back to `AVAILABLE`. |
| `bookings.resume` | 1 min | 20 | Completes any booking whose side-effect tail did not finish. |
| `opportunities.reminders` | 1 min | 200 per type | Resale/rental nudges at 90, 60 and 30 days out, once per band. |
| `campaigns.scheduled` | 1 min | 10 | Sends campaigns whose scheduled time has passed. |
| `nurture` | 1 min | 100 | Advances due enrollments by one step, checking stop conditions first. |
| `temperature.decay` | 1 min | 500 | Recomputes temperature for automatic leads whose score is over 12 h stale — the only way inactivity can register, since nothing happens to fire an event. |

Last run, duration and error state per job are visible on `/app/setup/health`.

---

## 19. Business events

Emitted by services, consumed by notifications and nurture. A failing listener can never
fail the action that emitted the event.

```
lead.created                 followup.created            costsheet.created
lead.assigned                followup.completed          discount.approval_requested
lead.reinquiry_received      followup.missed             discount.approved
lead.first_action_completed                              discount.rejected
lead.sla_warning             visit.created               booking.created
lead.sla_breached            visit.completed
lead.reassigned              visit.cancelled             campaign.sent
lead.stage_changed                                       campaign.delivery_updated
                             unit.shortlisted
resale.opportunity_due       unit.blocked                contact.tag_added
rental.opportunity_due       unit.block_expiring         user.mentioned
                             unit.block_expired          integration.failed
                             unit.booked
```

---

## 20. Timeline activity types

`LEAD_CREATED` · `LEAD_ASSIGNED` · `LEAD_TRANSFERRED` · `LEAD_REASSIGNED` · `LEAD_REOPENED` ·
`LEAD_LOST` · `STAGE_CHANGED` · `REINQUIRY` · `NOTE_ADDED` · `CALL_COMPLETED` ·
`WHATSAPP_SENT` · `EMAIL_SENT` · `FOLLOWUP_CREATED` · `FOLLOWUP_CANCELLED` ·
`FOLLOWUP_MISSED` · `VISIT_SCHEDULED` · `VISIT_RESCHEDULED` · `VISIT_COMPLETED` ·
`VISIT_CANCELLED` · `VISIT_NO_SHOW` · `UNIT_SHORTLISTED` · `UNIT_SHORTLIST_REMOVED` ·
`COSTSHEET_CREATED` · `DISCOUNT_REQUESTED` · `DISCOUNT_APPROVED` · `DISCOUNT_REJECTED` ·
`UNIT_BLOCKED` · `BLOCK_EXPIRY_REMINDER` · `BLOCK_EXPIRED` · `BLOCK_RELEASED` ·
`BOOKING_COMPLETED` · `RESALE_OPPORTUNITY_CREATED` · `RENTAL_OPPORTUNITY_CREATED` ·
`ACKNOWLEDGEMENT_SENT` · `ACKNOWLEDGEMENT_FAILED` · `NURTURE_STEP_SENT` · `SLA_WARNING` ·
`SLA_BREACHED` · `TEMPERATURE_CHANGED` *(V1.1 §14.6)*.

Every entry carries: type, title, optional body, structured meta, actor (user or `SYSTEM` or
`INTEGRATION`), and its timestamp. Writing one also refreshes the lead's and contact's
`lastActivityAt`.

---

## 21. Data model index

51 Mongoose models under `src/db/models/`. Everything except `Tenant` carries a `tenantId`
and the isolation plugin.

| Area | Models |
|---|---|
| **Organization** | `Tenant`, `User`, `Role`, `AssignmentPool` |
| **Customer** | `Contact`, `Tag` |
| **Pipeline** | `Lead`, `LeadStageHistory`, `InquiryTouch`, `LeadSource`, `Stage`, `SubStage` |
| **Work** | `Followup`, `ActionType`, `Activity`, `SiteVisit`, `VisitOutcome` |
| **Real estate** | `Project`, `ProjectAsset`, `Tower`, `Floor`, `UnitType`, `Unit`, `PricingComponent`, `PaymentPlan` |
| **Deals** | `CostSheet`, `ApprovalRule`, `Approval`, `UnitShortlist`, `UnitBlock`, `Booking`, `ResaleOpportunity`, `RentalOpportunity` |
| **Marketing** | `MarketingCampaign`, `CommunicationCampaign`, `SavedSegment`, `Template`, `AckRule`, `NurtureSequence`, `NurtureEnrollment`, `MessageLog` |
| **Platform** | `SlaRule`, `Integration`, `WebhookEvent`, `Notification`, `AuditLog` |

**Key uniqueness constraints (they are business rules, and boot waits for them):**

- one contact per `(tenantId, normalizedMobile)`
- one unit number per `(tenantId, projectId, towerId, unitNumber)`
- one webhook event per `(tenantId, integrationId, idempotencyKey)`
- one user per `(tenantId, email)`
- names unique per tenant on stages, roles, templates, sequences and each master

**Lead indexes** are built for the queues that run constantly: `(tenant, owner, status)`,
`(tenant, owner, nextActionAt)`, `(tenant, owner, firstGenuineActionAt, status)` — the New
Leads tile — plus stage, project, source, campaign, SLA status, latest inquiry, and
`(tenant, contact, project, status)` for the re-inquiry lookup.
