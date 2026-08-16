# Real Estate CRM V1 — Implementation Plan & Architecture

Source of truth: `Real_Estate_CRM_V1_Master_Product_Spec.md` (§ refs below point to it).
Nothing here adds scope beyond that document.

---

## 1. Stack decisions (and why nothing more)

| Need | Choice | Why not more |
|---|---|---|
| Runtime | Node 26 + Express 5 | as instructed |
| Views | EJS + native `include` partials | no layout engine dep needed |
| DB | **MongoDB + Mongoose** | chosen by product owner. Mongoose gives schema/index declaration and casting in one dep; §60 indexes declared on the schemas |
| Integrity | atomic `findOneAndUpdate` guards + `withTx()` helper | your `mongod` runs **standalone**, so multi-doc transactions are unavailable. §87 sanctions this: "if full transaction unsupported, use idempotent saga with recovery". Every contended write is a *single-document conditional update* — atomic in Mongo unconditionally. `withTx()` opens a real session when the connection supports one and runs plainly otherwise, so pointing at a replica set later upgrades integrity with **zero code change** (README documents the one-line `replSet` conf change) |
| Money | integer **minor units** (paise) + `lib/money.js` | §73 forbids float; avoids Decimal128 round-tripping and keeps aggregations exact |
| Passwords | `node:crypto` scrypt | stdlib beats bcrypt dep |
| Sessions | `express-session` + `connect-mongo` | server-side expiry/logout/deactivation (§5) |
| Validation | `zod` | ~60 mutating endpoints with real rules (§52) |
| Security | `helmet`, `express-rate-limit`, hand-rolled CSRF (~15 lines, double-submit) | `csurf` is deprecated |
| Uploads | `multer` + MIME/ext/size allowlist | §75 |
| Jobs | one `setInterval` tick (60s) over due-work SQL queries | §107 list; idempotent + retryable by construction, no queue infra |
| Events | `node:events` EventEmitter | §61 event names verbatim; drives notifications/audit/nurture/metrics |
| Tests | `node:test` + `fetch` against a booted app | stdlib runner; no supertest/jest |
| Cost sheet "PDF" | print-styled shareable HTML at a tokenised URL | §30.3 says "if implemented" |

New deps total: `express, ejs, mongoose, express-session, connect-mongo, zod, helmet, express-rate-limit, multer, dotenv`. That's it.

### Stated assumptions (§122.20 — no contradictions found, these are gaps)
1. **No provider credentials exist.** WhatsApp/SMS/Email/Telephony/Meta Ads/Google Ads/AI are built as **adapters** with a `mock` driver that persists a realistic send/delivery record and fires the same events a real driver would. Inbound webhook endpoints are real, verified and idempotent (§63, §98). Swapping in a live driver = one file per provider.
2. **AI (§42)** ships behind the same adapter: default driver is deterministic and grounded — it reads only tenant/permission-filtered CRM rows and template-renders summary/priority/next-action/unit-match. It literally cannot fabricate (§42.7, §108). Optional `anthropic` driver if you supply a key.
3. **Single-node deployment** → in-process scheduler and events. `ponytail:` comment marks the multi-node upgrade path (job-claim guard / external queue).
3b. **Your `mongod` is standalone**, so real transactions are off. Correctness rests on atomic conditional updates for every contended document plus ordered idempotent sagas (§87) — not on optimism. Running mongod with `replSet: rs0` (one line in `/opt/homebrew/etc/mongod.conf`, backward compatible with your other projects) makes `withTx()` upgrade to true transactions with no code change. I have **not** touched your mongod config.
4. **CSV import (§77) deferred** — the spec itself scopes it to V1.1. Everything else in §3.1's 30 modules is in.
5. Teams modelled as **assignment pools** (§14.1, §58) — one concept, serves round-robin, `team` data scope, and resale/rental team routing.
6. Booking = one unit per booking record; a lead may have multiple bookings historically (§59).

---

## 2. Folder structure

```
src/
  server.js              boot: migrate → seed-defaults → listen → start scheduler
  app.js                 express wiring, view engine, static, error handler
  config.js              env + tenant-independent constants
  db/
    index.js             mongoose connect, index sync, withTx() helper
    models/*.js          one Mongoose schema per collection (indexes declared here)
    seed.js              system defaults per new tenant (§78) + demo tenant
  lib/                   money, phone(E.164), tz(tenant "today"), ids(uuid), events,
                         password, template(render {{vars}}), errors, csrf
  middleware/            session→user→tenant, rbac(can/scope), validate(zod),
                         upload, rateLimit, notFound, errorHandler
  services/              ALL business rules live here, never in routes:
                         auth, users, roles, contacts, leads, capture, reinquiry,
                         distribution, sla, followups, visits, qr, projects,
                         inventory, shortlist, pricing, costsheets, approvals,
                         blocks, bookings, opportunities, campaigns, attribution,
                         nurture, notifications, audit, timeline, reports, ai, search
  routes/                one file per domain; each declares its /app/* (EJS) and
                         /api/* (JSON) paths; public/* for QR, mini-site, webhooks
  jobs/scheduler.js      sla, block-expiry, followup-missed, nurture, campaign send,
                         ad sync, resale/rental reminders  (§107)
  views/
    partials/            head, nav, flash, drawer, empty-state, pagination, filters
    pages/               dashboard/, leads/, projects/, inventory/, contacts/,
                         campaigns/, reports/, setup/, public/
public/  css/app.css  js/app.js (progressive enhancement only)  uploads/
tests/   unit/  api/  journeys/  concurrency/
docs/    REQUIREMENTS-COVERAGE.md   (spec § → code → test matrix)
```

UI is server-rendered EJS; drawers/quick-actions post to `/api/*` via `fetch` and re-render the affected fragment — that is how §50/§120 ("don't lose the work-list context, don't force refresh") is met without a SPA.

---

## 3. Data model (~45 collections, every tenant-scoped doc carries `tenantId`)

- **Org/Access**: `tenants`, `users`, `roles` (permissions JSON), `assignment_pools`, `pool_members`, `pool_pointers` (round-robin cursor), `invites`
- **Masters (§78, all tenant-editable)**: `stages`(+`semantic_type`,`terminal`,`requires_next_action`), `sub_stages`, `action_types`, `visit_outcomes`, `lead_sources`, `tags`, `payment_plans`
- **Contact**: `contacts` (normalized_mobile unique-ish index, consent/opt-out flags §67), `contact_tags`
- **Lead**: `leads` (full §10.1 field set incl. original/latest source, SLA fields), `inquiry_touches` (§40 multi-touch), `activities` (append-only timeline §21), `followups`, `notes+mentions` (folded into activities), `lead_transfers`
- **Project/Inventory**: `projects`, `project_media`, `project_documents` (visibility tag §65), `towers`, `floors`, `unit_types`, `units` (unique `tenant+project+tower+unit_number`), `pricing_components`, `mini_site_config`
- **Deal**: `unit_shortlists`, `cost_sheets` + `cost_sheet_lines` (versioned, immutable once shared), `approval_rules`, `approvals`, `unit_blocks`, `bookings`, `resale_opportunities`, `rental_opportunities`
- **Marketing**: `communication_campaigns`, `campaign_recipients` (snapshot at send §37.3), `saved_segments`, `marketing_campaigns`, `attribution_settings`
- **Config/Ops**: `sla_rules`, `block_rules`, `ack_rules`, `templates`, `nurture_sequences`, `nurture_steps`, `nurture_enrollments`, `integrations` (secrets encrypted, never re-rendered §49.1), `webhook_events` (raw payload + idempotency key), `notifications`, `audit_logs`

All §60 indexes declared on the schemas and synced at boot. Soft delete/archive only (§57). Sub-documents used only where the child never needs independent querying (cost-sheet lines, nurture steps, pool members); everything reportable stays a top-level collection.

---

## 4. The non-negotiable rules (§55) and where each is enforced

| Rule | Enforcement |
|---|---|
| Active lead always has a next action | `services/followups.complete()` is the single writer: it validates the next action *before* any write, then writes next-followup → completion → stage → timeline in that order, so an interrupted run leaves an extra pending follow-up (harmless, idempotently reconciled) and never an attended active lead without one. Routes cannot bypass it. |
| New Lead tile clears only on genuine action + next action | `first_genuine_action_at` is written by that same transaction only. Click-to-call alone writes a call activity, not the timestamp (§16.2, §101). |
| Mobile is the duplicate key | `lib/phone` E.164 normalize before every contact lookup (§9.2, §52.1) |
| One contact, many inquiries; re-inquiry never overwrites original source | `services/reinquiry`: same project → new `inquiry_touch` on existing lead + `latest_*` update; different project → new lead; lost → reopen with reactivation event (§13) |
| History survives transfer | transfers write a row + timeline event; nothing is deleted (§15) |
| SLA measured, escalates, auto-reassigns | `services/sla` computes state; scheduler tick fires warning → manager escalation → round-robin reassign, capped by `max_auto_reassignments` (§16.4) |
| Round robin, concurrency-safe | pointer advanced by an atomic `findOneAndUpdate` on the pool document, `$inc` + returned value decides the assignee — two concurrent captures cannot draw the same index (§14.2) |
| Block = stage + inventory action | `Unit.findOneAndUpdate({_id, status:'AVAILABLE'}, {$set:{status:'BLOCKED', blockId}})` — atomic; `null` result → "this unit was just blocked by another user" (§68). Block doc stores its own resolved `expiryAt` (§96). Same pattern for booking (`status:'BLOCKED'|'AVAILABLE'` precondition) |
| Blocks expire automatically | scheduler: reminder → expire → unit back to AVAILABLE → notify → lead stays active needing next action (§32.4) |
| Booking integrity | ordered saga (§87), unit claimed first by atomic guard so the contended resource is decided before anything else is written: claim unit → booking doc → block CONVERTED → lead terminal → cancel follow-ups/nurture → resale/rental opportunity → timeline. Each step idempotent and keyed by bookingId; a resume job reconciles any partial run (§98, §106) |
| Stage can't be dropdown-jumped to Booked/Blocked | stage service rejects transitions into `BOOKED`/`BLOCKED` semantics unless the booking/block service is the caller (§83) |
| Pricing recomputed server-side | `services/pricing.compute()` is the only source of totals; browser totals are display-only (§85) |
| Discount approval | threshold match → `Approval Pending`; changing an approved discount invalidates approval (§31.3); no self-approval |
| AI is assistive | AI service has read-only DB access, permission-filtered, returns suggestions only (§42.7, §108) |
| Tenant isolation | tenant-scoped models get a Mongoose pre-hook that **throws** if a query runs without `tenantId` in its filter — isolation is a schema-level guarantee, not a convention. Tests assert cross-tenant reads 404 and that the hook fires |

---

## 5. Routes

Exactly the paths in §7.1 for pages, §62 for APIs, plus public: `/p/:slug` (mini site §64), `/visit/:projectToken` (QR §25), `/api/webhooks/leads/:integrationKey`, `/api/webhooks/telephony/:key`, `/api/webhooks/campaigns/:key`, `/share/cost-sheet/:token`.

Per-domain route file pattern:
```
GET  /app/leads            → EJS list (filters preserved in querystring)
GET  /app/leads/:id        → workspace (timeline + context panel §20)
POST /api/leads/:id/followups/:fid/complete  → JSON + rendered fragment
```

---

## 6. UI

- One CSS file, CSS custom properties, grid/flex, mobile breakpoint. No framework, no build step.
- Reusable partials: work-tile, work-row (§8.3 density), drawer, searchable-select, filter-bar, empty-state (§69 copy used verbatim), timeline-item, confirm.
- Three dashboards behind one route, selected by permission (§8.1/8.4/8.5).
- **Complete-Action drawer** built exactly in §113 field order; **New-Lead first-action drawer** per §114; cost sheet §115; block §116; booking §117 (with confirmation, the only ordinary flow that gets one — §103.10/11).
- Every KPI is a link to its underlying records (§118).
- Mobile: dashboard, call, WhatsApp, follow-up, timeline, visit, shortlist, cost sheet, block all usable at 375px (§71).

---

## 7. Cross-cutting

- **Errors**: `AppError(code, userMessage)`; handler renders friendly copy from §68, logs the technical detail. Never leaks stack/SQL.
- **Audit** (§56): listener on mutation events writes user/ts/entity/action/before/after/ip. No user-facing delete.
- **Logging/observability** (§106): structured JSON lines; every job + webhook records outcome, retry count and last error; Setup → Integrations surfaces it (§97).
- **Timezone** (§72): UTC storage; tenant tz for every "today" boundary — a single `lib/tz.todayRange(tenant)` used by all dashboards/reports so counts can't disagree.
- **Reports** run as Mongo aggregation pipelines in `services/reports`, one pipeline per §43 family, each returning both the metric and the id list behind it so §118 drilldowns are the same query.

---

## 8. Verification strategy

**Unit** — money arithmetic, phone normalize, tz day boundary, pricing component calc (fixed/psf/%/taxable), discount→approval-level resolution, SLA state machine, round-robin rotation, priority scoring, template variable render.

**API/integration** — every mutating endpoint: happy path, permission denied, cross-tenant denied (must 404/403), validation failure.

**Journeys (E2E through real HTTP + HTML)**
1. Webhook lead → contact+lead created → round-robin assigned → ack queued → SLA running → appears in New Leads tile.
2. Same mobile again, same project → re-inquiry touch, **no** duplicate contact, Re-Inquiry tile, original source intact.
3. New lead worked: call logged alone does **not** clear the tile; action + next action does.
4. Complete follow-up without next action on an active lead → rejected; with one → both rows written, tile counts update.
5. Due follow-up → overdue → Missed tile.
6. SLA warn → escalate → auto-reassign, all three notifications, reassignment_count incremented.
7. Visit scheduled → stage VISIT_PLANNED → complete requires outcome + next action → VISIT_DONE.
8. QR scan (no OTP) → contact/lead/visit created from public form; rate-limited.
9. Project → tower → floor → units; inventory filters and floor grid.
10. Shortlist → cost sheet (server-computed) → discount over threshold → approval → approved version locked; editing discount re-triggers approval; shared version immutable.
11. Block → unit BLOCKED, lead stage Block Unit, expiry stored → reminder → auto-release → unit AVAILABLE, lead still needs next action.
12. Booking → all §33.3 validations → unit/block/lead/nurture side effects → resale opportunity created for Investment purpose.
13. Contact Book filter → segment → campaign send → opt-out excluded and counted (§102).
14. Marketing campaign spend → attributed funnel → CPL/cost-per-booking/ROAS match §93 formulas under both First and Last touch.
15. Reports: each of the 5 report families' numbers equal the record sets their drilldowns return.

**Concurrency** — two simultaneous block requests on one unit: exactly one 200, one friendly conflict, unit blocked once. Same for booking. Ten parallel captures into a 3-user pool distribute 4/3/3, never double-allocating. Because Mongo transactions are unavailable here, these tests are load-bearing, not decorative — plus a saga test that kills the booking flow after the unit claim and asserts the resume job completes it exactly once.

**Failure cases** — provider send failure doesn't block lead creation (§17.4); duplicate webhook delivery is a no-op (§98); no eligible user → Unassigned + manager notice (§14.3); deactivated owner's leads not orphaned (§102); block expiring while booking form open → revalidated on submit (§102).

**Regression/coverage** — `docs/REQUIREMENTS-COVERAGE.md` maps every §101 acceptance criterion and every §55 rule to the test that proves it. That file is the completion gate; I will not report a module done without its row green.

---

## 9. Build order (follows §100, each phase ends green before the next starts)

1. **Foundation** — project skeleton, migrations, seed defaults, auth, users, roles/permissions, tenant isolation, contacts, leads, stages, lead list, lead workspace.
2. **Sales execution core** — dashboards + work queues, follow-up engine + next-action rule, round robin, SLA + escalation, capture webhook, re-inquiry, timeline, notifications, acknowledgement.
3. **Real estate** — projects, hierarchy, inventory, QR visits, site visits, shortlist, pricing, cost sheets, approvals, blocks + expiry, booking, resale/rental.
4. **Marketing** — contact book, tags, segments, communication campaigns, ad campaign performance, attribution, mini site.
5. **Intelligence & reporting** — AI summary/priority/next-action/unit-match/Q&A, the 5 reports, exports, audit UI, integration health, setup screens.

Deliverable at the end: running app + seeded demo tenant + test suite + coverage matrix + README with run instructions.

---

## 10. Status — all five phases delivered

| Phase | State |
|---|---|
| 1 Foundation | ✅ tenant, auth, roles, contacts, leads, stages, workspace |
| 2 Sales execution | ✅ work queues, follow-up engine, round robin, SLA, capture, re-inquiry, acknowledgement |
| 3 Real estate | ✅ projects, hierarchy, inventory, visits, QR, shortlist, cost sheets, approvals, blocks, booking, opportunities |
| 4 Marketing | ✅ contact book, segments, campaigns, attribution, nurture, mini site |
| 5 Intelligence | ✅ AI, five reports, management dashboard, search, exports, audit trail |

`npm test` — 258 tests across unit, API, journey and concurrency suites.
`docs/REQUIREMENTS-COVERAGE.md` maps every implemented section to its code and its test.
