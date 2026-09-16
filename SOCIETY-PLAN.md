# Society Management — Architecture & Build Plan

Porting the Society Management System from `real-estate-os-dev` (3 Node microservices,
~100k LOC) and `R-Core-Replica` (React admin, 64 screens) into this codebase as a native
module: Express 5 + EJS + Mongoose, one process, no build step.

Written the way [V2-PLAN.md](V2-PLAN.md) was: the decisions taken, the places the source is
followed in substance rather than to the letter, and the phases.

---

## 1. What is being ported

### 1.1 Source inventory (measured, not estimated)

| Source service | Models | Endpoints | Role |
|---|---:|---:|---|
| `society-admin-services` | 54 | **260** | super-admin, chairman/society-admin, gatekeeper, attendance |
| `society-services` | 24 | **130** | first-generation society service |
| `society-user-services` | 44 | **85** | resident mobile app (`/app/*`) |
| **Total** | **60 canonical collections** | **475** (472 reachable) | |

Method split: 236 GET, 92 POST, 83 PUT, 55 DELETE, 9 PATCH.

> **460 of 468 declared endpoints are real.** Three are literal copy-paste duplicates in
> the source — `GET /super-admin/society/stats` is registered twice in one file,
> and `PUT`/`DELETE /units/:unitId` twice each in another, with identical
> handlers. Express keeps the first registration, so the later ones are dead
> code. The port builds 472.
>
> The 475 figure is generated, not counted by hand. `scripts/society-extract-contract.js`
> walks the three route trees, resolves `router.use()` mount chains, and emits
> [`docs/society-endpoints.json`](docs/society-endpoints.json) — one row per endpoint with
> service, source file, method, mount prefix and route. That file is the contract of record
> for this build. **Nothing is "done" until every row in it resolves.**

### 1.2 Two generations, not three peers

All three services connect with the identical `ENTRYTRACKING_DB_URL` + `DB_NAME` env vars,
which reads at first like one shared database behind three route surfaces. Diffing the
schemas showed otherwise: `society-admin-services` and `society-user-services` are one
generation of the data model, and `society-services` is an earlier one that redeclares the
same collection names with incompatible documents. Same env var *names*, different
deployments. The evidence is in §2.2.

So the port is:

- **one** canonical model per collection — the admin/user pair, fields unioned (**60 models**)
- **one** service layer holding the business rules
- **three** thin route surfaces reproducing the three wire contracts exactly, with the
  legacy surface mapped onto the canonical models by a façade
- plus **one** EJS admin UI over the same service layer

Not three parallel stacks, and not one merged schema either.

### 1.3 The 29 functional modules

Society enquiry & leads · developers · societies & onboarding · society stages/sub-stages/child-stages ·
roles & permissions · platform admins · blocks · floors · units · unit occupancy · members ·
family members · resident onboarding requests · committee members · society employees ·
employee types & assignments · attendance · amenity types/amenities/slots/packages/bookings/payments ·
complaints & types & history · notices · maintenance & bills & bill categories & unit bills ·
penalties · balance sheet · parking levels/slots/allocations · vehicles · visitors & gatekeeper &
visitor passes · SOS · lost & found · polls & votes · events · society documents & types ·
emergency numbers · galleries (society + block) · feedback · property listings (rent & sell) ·
notifications · terms & conditions.

---

## 2. Decisions taken

These four were settled before planning, and the rest of this document follows from them.

| # | Decision | Consequence |
|---|---|---|
| D1 | **All three surfaces in scope; the legacy 130 ship as a compatibility façade** | 475 endpoints over **59** collections. Revised during Phase 0 — see §2.2 |
| D2 | **The mobile wire contract is matched exactly** | Same paths, same `{ message, result }` envelope, same JWT + `x-society-id` headers, same field names. The existing app must work unchanged. |
| D3 | **Society is platform-level, above tenants** | Society collections do **not** carry `tenantId` and are **not** covered by `tenantGuard` |
| D4 | **Standalone now, integration seams named** | No coupling to Lead/Project/Contact yet; the seams are declared and stubbed |

### 2.2 Why D1 changed: the legacy service is a different generation, not a peer

The initial read of the source concluded that all three services shared one database, because
all three connect with the identical `ENTRYTRACKING_DB_URL` + `DB_NAME` env vars. Diffing the
schemas before writing the models showed that conclusion was wrong. Same env var *names*,
different deployments.

`society-services` and the admin/user pair declare **incompatible documents under the same
collection names**:

| Collection | `society-services` | admin + user pair |
|---|---|---|
| `notices` | `noticeNumber` **required + unique**, `description`, `status`, `priority`, `targetAudience` | no `noticeNumber` at all, `text`, `publishStatus`, `contentType`, Mixed targets |
| `units` | `unitType`, `unitStatus`, `memberId`, `area` | 30+ cost fields, `currentOwnerId`, `occupancyStatus`, `societyCode` |
| `complaints` | `complaintNumber`, `category`, `images`, `taskStatus` | `complaintId`, `complaintTypeId`, `contentType`/`contentData` |
| `maintenances` | a **per-unit bill** — `unitId`, `ownerAmount`, `paidAmount`, `transactionId` | a **recurring rule** — `autoGenerate`, `nextRunDate`, `priceOwner`; the bill lives in `unitbills` |

`noticeNumber` settles it: `required: true, unique: true` in the legacy schema and absent from
the newer pair. Every notice the newer services create would collide on that index. These were
never running against one database.

**Confirmed against the live databases.** The developer machine carries all of them, and they
are separate deployments exactly as the schemas implied:

| Database | Collections | Which generation |
|---|---:|---|
| `shivalik_r_society_dev` | 20 | legacy — holds `amenities`, `amenitypricings`, `blockgalleries`, `parkingslots`, `parkingallocations` |
| `shivalik_r_society-admin_dev` | 46 | newer — holds `amenity` (singular), `amenitytypes`, `balancesheets` |
| `shivalik_r_society-user_dev` | 35 | newer |
| `shivalik_r_society_new_dev` | 54 | newer, consolidated — the admin and user sets in one database |

`shivalik_r_society_new_dev` at 54 collections is the admin/user pair sharing one schema, which
is the canonical set this port builds (53, plus that database's migration changelog). The
legacy service has never shared it.

**Resolution — compatibility façade.** The newer pair is the canonical data model. The 130
legacy endpoints keep their exact URLs and response shapes, but are backed by the canonical
collections through a mapping layer in `services/society/legacy/`. Nothing is dropped and no
second copy of the data exists.

Six legacy concepts have no equivalent in the newer pair and become real collections rather
than façades: `visitorpasses`, `termsandconditions`, `amenitypricings`, `parkingallocations`
(the newer `parkings` holds only the *current* assignment, so this is the audit trail),
`complaintcounters` and `maintenancecounters`.

Four canonical models absorb legacy fields that would otherwise have nowhere to live:
`units` gains `unitType`/`area`, `notices` gains `priority`/`targetAudience`/`noticeNumber`,
`complaints` gains `taskStatus`/`complaintFor`, `parkings` gains
`slotType`/`section`/`floor`/`area`/`coordinates`/`hasEVCharging`.

**53 canonical + 6 legacy-only = 59 collections.**

One case does not map cleanly and is called out rather than papered over: legacy
`/maintenances` is a per-unit bill with payment fields (`paidAmount`, `paymentMethod`,
`transactionId`), while canonical `maintenances` is the rule and `unitbills` is the bill —
which carries no payment record. The façade reads from `unitbills` joined to `maintenances`,
and a `unitbillpayments` collection is added in Phase 8 to hold what the legacy shape needs.
That is the one place the façade required a canonical addition rather than a mapping.

### 2.3 The `users` collection is declared twice, incompatibly, inside one service

Found while porting the identity models. `society-admin-services` declares the `users`
collection in two files with contradictory shapes and contradictory unique indexes, and both
are actively used by live controllers:

| Declaration | Shape | Unique index | Used by |
|---|---|---|---|
| `models/userServiceUsers.js` | identity — `mobileNumber`, `otp`, `role`, `isSocietyAdmin`, `fcmToken` | `mobileNumber` | `getUserServiceUsers`, `updateUserSocietyAdminFlag`, … |
| `models/users.js` | unit-resident — `societyId`, `unitNumber`, plus a full 20-field cost sheet | `{societyId, unitNumber}` | `getUsersBySociety`, `getAllUnits`, `getUnitStats`, committee/society/parking controllers, `authJwt` |

No document can satisfy both, and the `{societyId, unitNumber}` unique index collides on nulls
for every identity row. `society-user-services` mirrors only the identity shape.

**Resolution.** `models/users.js` is a pre-`units` leftover — its fields *are* `SocietyUnit`'s
fields, and its endpoints' own route comments describe them as unit queries ("Get all units
listing", "Get unit statistics for a society"). So:

- `SocietyUser` takes the identity shape and owns the `users` collection.
- The unit-resident shape is not ported; it already exists as `SocietyUnit`.
- The `/users/society/:societyId`, `/all`, `/stats` and `/unit/:unitNumber` endpoints keep
  their URLs and response shapes and are served from `SocietyUnit` — the same façade
  technique §2.2 uses for the legacy 130.

### 2.4 Society collections are prefixed `society_`

Found by a failing Phase 1 test, not by inspection. The society module shares the CRM's
database, and five society models had defaulted to collection names the CRM already owned:

| Collection | CRM model | Society model |
|---|---|---|
| `users` | `User` | `SocietyUser` |
| `roles` | `Role` | `SocietyRole` |
| `floors` | `Floor` | `SocietyFloor` |
| `units` | `Unit` | `SocietyUnit` |
| `notifications` | `Notification` | `SocietyNotification` |

Sharing a collection also means sharing its indexes. Generating a society's structure inserted
**one** floor instead of six, because the CRM's unique `tenantId_1_towerId_1_number_1` index
sits on `floors`, a society floor has none of those three fields, and after the first insert
every subsequent one collided on nulls.

Every society collection is now prefixed `society_` — not only the five that clashed, so a
model written in Phase 9 cannot reintroduce this. Collection names are not wire-visible, so
the contract is unaffected. `tests/society/model-parity.test.js` enforces both the prefix and
the absence of collisions.

### 2.1 D3 is a deliberate hole in an existing guarantee — read this

This codebase enforces tenant isolation at the schema level: `db/tenantGuard.js` makes any
query that fails to constrain `tenantId` **throw before it reaches Mongo**. That is why the
CRM has never leaked across organizations.

Society collections sit outside that guarantee by design. To keep it from becoming an
accident:

- `db/societyGuard.js` — a plugin cloned from `tenantGuard` that enforces `societyId` on every
  society-scoped collection with exactly the same "throw, don't leak" behaviour.
- `db/platformScoped.js` — a one-line marker plugin applied to the genuinely global
  collections (`societies`, `developers`, `roles`, `admins`, `societyinquiry`, `societystages`,
  `users`). It adds no field. Its only job is to make "this model is intentionally
  un-guarded" a thing you can read in the file and grep for, instead of an omission.
- A test asserts every model under `db/models/society/` carries exactly one of the two.

A society-scoped query missing `societyId` fails as loudly as a CRM query missing `tenantId`.

---

## 3. Architecture

### 3.1 Layout

```
src/
  db/
    societyGuard.js              # societyId enforcement (clone of tenantGuard)
    platformScoped.js            # explicit "global, un-guarded" marker
    models/society/              # 64 models, one per collection
      index.js                   # single import point, mirrors db/models/index.js
  lib/society/
    envelope.js                  # toJson / makeDataTablesResponse — the source's wire shape
    jwt.js                       # sign + verify (JWT_SECRET_USER, JWT_SECRET_ADMIN)
    serialize.js                 # paise -> the source's string/number money shape
  middleware/
    societyAuth.js               # the 6 verifiers, ported behaviour-for-behaviour
  services/society/              # ~40 modules — ALL business rules live here
  routes/society-api/            # /api/v1/*  — the three exact wire contracts
  routes/society-admin/          # /app/society/* + /api/society/* — EJS admin
  views/pages/society/           # ~64 EJS pages
  jobs/society/                  # notice scheduler, maintenance run, poll close, agreement expiry
docs/
  society-endpoints.json         # the 475-row contract of record
scripts/
  society-extract-contract.js    # regenerates it from the source tree
```

### 3.2 Four surfaces, one service layer

```
   /api/v1/auth,super-admin,        /api/v1/app/*        /api/v1/society,blocks,
   society-admin,gatekeeper,        (resident app)       floors,units,parking,...
   attendance   (260)                    (85)                  (130)
          │                               │                      │
          └───────────────┬───────────────┴──────────────────────┘
                          │            JWT + x-society-id, { message, result }
                          │            mounted BEFORE the CSRF gate (stateless)
                          │
                  services/society/*          ◄──── /app/society/* EJS admin
                  (all business rules)               session + CSRF + CRM RBAC
                          │
                  db/models/society/*
```

The EJS admin does **not** speak the mobile contract. It uses this codebase's own idiom —
session cookie, CSRF token, `requirePermission`, zod validation — and calls the same service
functions. One set of rules, four ways in. A rule fixed once is fixed everywhere.

### 3.3 Mount map — verified free of collisions

Checked against every existing router in `src/app.js`. No path in the society surface
collides with `/app/*`, `/api/*`, `/cp/*` or the public routes.

| Mount | Source | Auth | Count |
|---|---|---|---:|
| `/api/v1/auth/*` | admin | public / JWT | 4 |
| `/api/v1/super-admin/*` | admin | `superAdminVerifyToken` | 51 |
| `/api/v1/society-admin/*` | admin | `societyAdminVerifyToken` + `x-society-id` | 187 |
| `/api/v1/gatekeeper/*` | admin | `securityGuardVerifyToken` | 13 |
| `/api/v1/attendance/*` | admin | `societyAdminOrSecurityGuard` | 5 |
| `/api/v1/app/*` | user | `userVerifyToken` | 85 |
| `/api/v1/{society,blocks,floors,units,society-users,parking,notices,complaints,maintenances,society-galleries,amenity,visitor,penalties}` | legacy | mixed | 130 |
| `/app/society/*`, `/api/society/*` | new | session + CSRF + RBAC | 69 screens |

Sums to 475. Note that `gatekeeper` mounts a second route file at its own root
(`gatekeeperRoutes.js` → `router.use("/", visitorRoutes)`), which is where 7 of its 13
endpoints come from — worth knowing before anyone re-derives the count and finds 468.

### 3.4 Identity

Five identities, following the `/cp/*` precedent in this codebase — a portal identity sets
its own request fields and **never** `req.user`, so it cannot satisfy an internal route even
if one is mounted by mistake.

| Identity | Middleware | Sets | Reaches |
|---|---|---|---|
| Platform super-admin | `superAdminVerifyToken` | `req.societyAdmin` | `/api/v1/super-admin/*` |
| Chairman / society admin | `societyAdminVerifyToken` | `req.societyAdmin`, `req.societyId` | `/api/v1/society-admin/*` |
| Security guard | `securityGuardVerifyToken` | `req.societyEmployee` | `/api/v1/gatekeeper/*` |
| Resident | `userVerifyToken` | `req.societyUser` | `/api/v1/app/*` |
| CRM staff user | existing `requireAuth` | `req.user` | `/app/society/*` only |

`x-society-id` is honoured exactly as the source does, including its error codes
(`401` empty token, `400` society id required, `401` access denied).

### 3.5 Duplicate reconciliation

One collection, one model. Where the three source declarations disagree, the
`society-admin-services` version wins (it is the newest superset) and the divergence is
recorded in a comment on the model.

Four cases need a decision rather than a merge:

| Case | Finding | Resolution |
|---|---|---|
| `amenity` vs `amenities` | **Different collection names** — admin/user use `amenity`, legacy uses `amenities`. Two parallel amenity systems. | Keep both. `SocietyAmenity` and `SocietyAmenityLegacy`. Do not merge — the legacy contract's 19 endpoints read the other collection. |
| `complainthistories` vs `complaintHistories` | **Case mismatch between admin and user services.** MongoDB collection names are case-sensitive, so admin writes one collection and the resident app reads a different one. | **This is a live bug in the source.** Port to the lowercase name, and ship a one-off merge migration. Flagged in §6. |
| `admins` | Declared 3× with different shapes (`admin.js`, `admins.js` ×2) | Union of fields; admin-services shape wins |
| parking | `parkings` (new) vs `parkingslots` + `parkingallocations` + `vehicleassignments` (legacy) | Keep all four — the legacy 26-endpoint parking contract depends on the old three |

### 3.6 Cross-service HTTP calls become local calls

The society services make 105 outbound HTTP calls to five sibling services. Each collapses to
a local module.

| Called service | Calls | Distinct endpoints | Becomes |
|---|---:|---:|---|
| `user-services` | 92 | 12 | `services/society/users.js` over the local `users` collection (same DB) |
| `event-services` | 5 | 2 | `services/society/events.js` |
| `channel-sales-services` | 6 | 1 | **seam** → this codebase's existing ChannelPartner module |
| `feedback-services` | 1 | 1 | `services/society/feedback.js` |
| `community-services` | 1 | 1 | `services/society/userGroups.js` |

The 12 `user-services` endpoints to internalize: `users/detail`, `users/create/public-user`,
`common/access-token-valid`, `users/update/society-access/:id`, `users/validate-otp`,
`users/admin/assign-role`, `users/internal/update-society-role/:id`,
`users/find/website-leads-users-list`, `users/find/society-leads-users-list`,
`users/count-add/website-leads`, `users/count-add/society-leads`, `user-group/create`.

### 3.7 Infrastructure substitutions

Everything the source reaches for already has an equivalent here, except one.

| Source | Here | Note |
|---|---|---|
| RabbitMQ + 4 workers (notice, maintenance, poll, pollVote) | `src/jobs/scheduler.js` | Already exists and already runs scheduled work |
| Firebase FCM push | a `push` driver in `services/messaging.js` + `Notification` rows | Mock driver by default, exactly like WhatsApp/SMS/email today |
| AWS S3 + CloudFront | `uploadDir` / `privateUploadDir` | See §3.8 |
| SendGrid, nodemailer | existing email adapter | |
| NETSMS / Spider WhatsApp + SMS | existing WhatsApp + SMS adapters | |
| joi, express-validator | zod + `lib/fields` | Validation *messages* preserved — they are part of the wire contract |
| moment, moment-timezone | `lib/tz.js` | |
| exceljs, json2csv, @fast-csv | existing CSV export | |
| node-cron | existing scheduler | |
| bcryptjs | `lib/password.js` | |
| **jsonwebtoken** | **added** | The only genuinely new dependency |

One new dependency for 475 endpoints.

### 3.8 Files: what is public and what is not

This codebase keeps customer-sensitive files outside `public/` and serves them only through
`/app/files/:kind/:id`, which checks session, permission, tenant and visibility, then writes
an audit row. Society files are classified on the same principle:

- **Private** — rent agreements, police verification documents, society documents, resident
  KYC, balance sheets, complaint attachments containing unit detail
- **Public** — society logo, building and block galleries, notice attachments, event images,
  amenity photos, property listing photos

New `kind` values are added to `routes/files.js` with their own permission checks.

### 3.9 Money

The source stores money as `String` (`unitBasicRate: String`) and as floating-point numbers,
in bills, maintenance, penalties, amenity pricing and the unit cost fields.

This codebase stores money as integer minor units everywhere; `lib/money.js` is the only
place decimals exist. Rounding drift in maintenance and GST across thousands of units is
exactly what that rule exists to prevent.

**Resolution:** store integer paise internally, and serialize back to the source's
string/number shape at the `/api/v1/*` boundary in `lib/society/serialize.js`. The mobile
contract stays byte-compatible; the arithmetic stops drifting. This is the one place where
the port deliberately does something better than the source rather than copying it.

### 3.10 Integration seams (D4 — declared, not built)

Named now so they are cheap later, and so nobody designs them out:

1. **CRM `Project` → Society** — the reference admin has `AddConvertSociety.tsx`
2. **Society enquiry → CRM `Lead`** — `societyInquiryLeadService.js` is the source's own
   half of this
3. **Resident → CRM `Contact`**
4. **Channel-sales CP array → this codebase's ChannelPartner module** (§3.6)

Each is a single named function in `services/society/seams.js` that currently returns null
and is called from the one place it will eventually matter.

---

## 3.11 The API document

`docs/society-openapi.json` — OpenAPI 3.1 for all 460 endpoints. Browsable at
**`/app/society/api-docs`** (Swagger UI, behind the CRM session and `society.view`),
downloadable from `/app/society/api-docs/openapi.json` for Postman or a client generator.

Regenerate with **`npm run society:openapi`**.

**It is generated, and that is the point.** A hand-written API document is wrong within a
week and nobody finds out until somebody has built a client against it. Everything
mechanical is read from the code:

| What the document says | Where it comes from |
|---|---|
| Which endpoints exist | walking the mounted Express routers |
| Which token opens each one | the middleware actually guarding that route |
| Whether `x-society-id` is required | which verifier is on the chain |
| Every field, type and enum of a record | the Mongoose schema |
| Money fields, in rupees | the model's own `MONEY_FIELDS` |
| List envelope key, page param, filters | the crud factory's resolved `config` |

What is hand-written is confined to `scripts/society-openapi/catalog.js`: tag prose, a
prefix→resource map, hand-written summaries for the endpoints whose name cannot be derived,
and a dictionary of sample values so every example reads like one coherent society rather
than forty copies of `"string"`.

`tests/society/openapi.test.js` closes the loop: it fails if the committed document is
behind the routes, if an endpoint in the contract has no entry, if the document describes a
route that is not mounted, or — the one that matters most — **if what the document says
about authentication disagrees with the middleware**. A security note that drifts is worse
than no note.

Three things it will not show, deliberately: OTP columns (`select: false`, never
serialized), storage-only money columns (`amountMinor` is documented as `amount`, a decimal
string), and server-owned fields in request examples.

---

## 4. How "nothing is missed" is enforced

Four mechanical gates, not diligence.

1. **Contract parity test** ✅ **460/460.** `tests/society/contract.test.js` reads all 475
   declared rows of `docs/society-endpoints.json`, resolves each to its final mount path, and
   asserts it maps to a real handler. 15 rows are `reachable: false` — route files the source
   never mounted — leaving **460 real endpoints, all of them ported**. The suite prints
   progress on every run.
2. **Model parity test.** Asserts all 64 collections exist, each with exactly one of
   `societyGuard` / `platformScoped`, and that no society model name collides with an
   existing CRM model.
3. **Screen parity** ✅. `tests/society/screens.test.js` renders all 35 society screens
   against a seeded society and asserts none leaks a template error, plus that a missing or
   malformed society id is a friendly 404 rather than a 500. It is a separate suite from the
   CRM's `tests/api/pages.test.js` because a suite only builds the models its directory asks
   for — see the note on `modelSetsFor` below.
4. **Journey test** ✅. `tests/society/journey.test.js` — one continuous session, 34 steps,
   in the style of `tests/journeys/full-lifecycle.test.js`: an app enquiry → society created →
   structure generated → chairman signs in → resident claims a flat → approved → maintenance
   billed and paid → complaint raised and closed → notice and poll published and answered →
   amenity booked (and double-booking refused) → visitor approved, admitted and signed out →
   flat listed for sale. It ends by asserting no record leaked out of its society and that
   the resident's token still cannot act as the chairman.

---

## 5. Phases

Each phase is independently shippable, ends green, and shrinks the contract allow-list by a
known number. Endpoint counts sum to 475.

| # | Phase | Endpoints | Screens | Delivers |
|---|---|---:|---:|---|
| 0 | **Foundations** ✅ | 0 | 0 | `societyGuard`, `platformScoped`, envelope, JWT + 6 verifiers, internalized `users` slice, push driver, society file kinds, `society.*` permission group, all 60 models, CRUD factory, contract + model parity tests |
| 1 | **Platform & society lifecycle** ✅ | 54 | 7 | developers, roles, admins, society CRUD + code generation, stages/sub-stages/child-stages, enquiry + history + lead service, onboarding, auto structure generation, analytics |
| 2 | **Structure, staff and onboarding** ✅ | 61 | 6 | blocks, floors, units, unit occupancy, block naming + simple-structure helpers, society setup screens |
| 3 | **Members, family and committee** ✅ | 41 | 2 | members, family members, occupancy links, resident onboarding requests, committee, approval flow |
| 4 | ~~Employees & attendance~~ — delivered across Phases 2 and 9 ✅ | 24 | 4 | employees, employee types, assignments, attendance, system employee type seeding |
| 5 | ~~Resident identity~~ — delivered as Phase 10 ✅ | 14 | 0 | OTP login, profile, society info, notifications — the app's front door |
| 6 | **Communication** ✅ | 73 | 3 | notices + scheduler, polls + votes + close job, events, galleries (society + block), documents + types, emergency numbers, feedback, lost & found |
| 7 | ~~Complaints~~ — delivered as Phase 5 ✅ | 32 | 2 | complaints, types, history (incl. the case-mismatch fix + migration), counters, notification hooks |
| 8 | ~~Money~~ — delivered as Phase 7 ✅ | 45 | 2 | bill categories, bills, unit bills, maintenance + counters + run job, GST, penalties, balance sheet, PDF receipts |
| 9 | ~~Amenities~~ — delivered as Phase 4 ✅ | 54 | 3 | types, amenities, slots, packages, bookings, legacy pricing, payments, statistics |
| 10 | ~~Parking & vehicles~~ — delivered as Phase 8 ✅ | 42 | 1 | levels, slots, allocations, vehicles, assignments |
| 11 | ~~Security~~ — delivered as Phase 9 ✅ | 30 | 2 | visitors, visitor logs, passes, gatekeeper flows, pre-approval, in/out reports, staff attendance |
| 12 | ~~Listings, dashboards, hardening~~ — delivered as Phase 10 ✅ | 24 | 2 | property listings, resident front door, app society browse/join, legacy society CRUD façade, all four integration seams, chairman dashboard, full 460-row parity, screen crawl + journey |
| | **Total** | **475** | **69** | |

Phases 1–4 are sequential (each builds on the previous). Phases 6–11 are independent of one
another once 0–5 are in, so they can be reordered to whatever you need first.

---

## 5.1 Notes from the build

**A test suite gets its models from its directory, not its filename.** `tests/helpers.js`
used to decide by filename prefix, which meant `tests/society/journey.test.js` and
`screens.test.js` silently ran with the CRM indexes only — so every uniqueness rule in the
society module was absent while they ran, and the journey's double-booking assertion passed
because nothing was there to stop the second booking. A directory cannot be misspelled into
silence the way a prefix can.

**A Mongoose `ValidationError` is a 400.** `middleware/errors.js` now turns one into a bad
request carrying the field-level message. Until it did, a mistyped enum on any society
endpoint — `priority: 'MEDIUM'` where the column takes `'Medium'` — came back as an opaque
500 with the reason only in the server log.

**An unmatched `/api/v1` request is a 404.** It used to fall through the society routers to
the CRM's CSRF gate, so a mobile client with a typo in a URL was told its CSRF token was
invalid.

Things found while implementing that are worth knowing before the next phase.

**The CRUD factory.** `services/society/factory.js` builds list / detail / create / update /
soft-delete from a description, because most of the 472 endpoints are exactly that over one
collection. It is not a base class and nothing inherits from it — it returns plain functions,
and a resource with real behaviour (societies, roles, enquiries) writes that behaviour itself
and uses the factory only for the generic half. The list envelope is configuration, not house
style: the three source services disagree on their own pagination shape (`perPage` with
`hasNextPage` in one, `limit` without it in another) and D2 requires matching each.

**Index creation is now explicit.** `mongoose.set('autoIndex', false)` plus an
`ensureIndexes()` that covers both model sets. The default fires a `createIndex` for every
index on every model the first time that model is used; with ~130 models across the two
modules and a test database per suite, that was enough to take the local `mongod` down
mid-run — the same failure the `--test-concurrency=4` cap already exists to avoid.

**Fixed rather than copied.** The source's society-code generator re-rolled three random
digits until it found a free one — a loop that slows with every society and cannot terminate
past the thousandth in a year; it is a `SocietyCounter` `$inc` now. OTPs are stored hashed
rather than as plaintext digits. The two hardcoded OTP bypass phone numbers in the source's
production login path (`7575007347` → `000000`, `9712586365` → `141414`) are **not** ported;
`SOCIETY_OTP_DEV_CODE` covers the same need in development only. Five unique indexes that
permanently burned a name on soft-delete are now partial on `isDeleted: false`.

**Occupancy has one write path.** `services/society/occupancy.js` is the only place that
creates or ends a tenure. The source implemented the rules twice — the legacy assign endpoint
overwrote the previous resident with no history and no owner check, while onboarding approval
closed prior tenants and refused a second owner — so which screen you used decided what the
data meant. Both routes go through the one module now: at most one primary owner, a new tenant
ends the previous tenancy, nothing is deleted, and the unit's cached `residentType` /
`occupancyStatus` are recomputed rather than set by hand. `units.update()` strips those fields
so no other route can forge them.

**Sparse is not partial.** Five unique indexes were declared `sparse: true`, which only skips
documents where the field is *absent* — an explicit `null` still indexes, so the second
document written without that field collides with the first. `SocietyMember.userId` hit this
the moment two residents were added before either had a login; `noticeNumber` and
`receiptNumber` would have hit it too, both having `default: null`. All are
`partialFilterExpression` on the field actually having a value now.

**Test databases are dropped on the way out.** WiredTiger writes a file per collection and per
index; two dozen suites each holding every model, kept across every run, pushed the mongod data
directory past 38,000 files until mongod aborted on startup because its diagnostics subsystem
could not create a temp file. `tests/helpers.js` drops the suite database in `stopServer`.

**A resident may only write their own household.** The app sends `societyId` and `unitId` as
query parameters, so every family and settings operation resolves the caller's own PRIMARY
occupancy in that unit first and hangs the change off it. Passing someone else's `unitId`
finds no occupancy and 404s rather than editing their household — asserted from both sides in
`phase3-members.test.js`.

**A guard mounted on one prefix left three open.** `router.use(B, societyAdminVerifyToken)`
covered `/society-admin/society` only; the `/committee-members`, `/users` and
`/society-admins` prefixes added in Phase 3 hung off siblings and were reachable with no token
at all. The guard now iterates an explicit `GUARDED` list, and a test probes every prefix
unauthenticated so a new one cannot be added without noticing.

**The local mongod needed rescuing twice.** Two things compounded: my `ensureIndexes()` built
all 130 models in every test database, and macOS gives launchd services a
`launchctl limit maxfiles` of 256 — so four concurrent suites exhausted mongod's file-handle
budget and it fatally aborted on its own diagnostics temp file. `ensureIndexes({ include })`
now builds only the model sets a suite uses (`tests/helpers.js` picks them by suite name), and
suites drop their database on exit. Recovering mongod after the crashes reclaimed ~23,000
orphaned index files. **This machine's `maxfiles` limit is still 256 and is worth raising.**

**Double booking is now impossible, not merely checked.** `SocietyAmenityBooking` carries a
multikey unique index over `(amenityId, bookingDate, slotIds)`, partial on `CONFIRMED`.
`amenities.book()` writes optimistically and turns E11000 into a 409. The source read for
conflicts and then wrote, inside a transaction a standalone `mongod` does not provide — so the
window was real. `phase4-amenities.test.js` fires ten simultaneous requests at one slot and
asserts exactly one row exists afterwards. Cancelling moves the booking out of `CONFIRMED`,
which releases the slot the moment the write lands, with no extra bookkeeping.

**GST is computed in paise and always reconciles.** `services/society/gst.js` replaces the
source's `Math.round(x * 100) / 100` float arithmetic. For an inclusive price the base is
derived and the tax is the *remainder*, so `base + gst === total` exactly rather than the two
being rounded apart; the CGST/SGST split gives the odd paisa to CGST for the same reason. A
property test walks odd amounts to prove the halves always sum.

**Tests build only the indexes that enforce something.** The two model sets declare ~795
indexes, of which ~70 are unique. The other 725 are query plans — they change how fast a read
is, never whether a write is allowed, so no assertion depends on them. Building all of them in
every suite database cost minutes per run and exhausted mongod's file handles;
`ensureIndexes({ uniqueOnly: true })` in tests cut it by 11x. Production still builds everything.

**A complaint can only move through one function.** `complaints.transition()` applies the
change, writes the `SocietyComplaintHistory` row and notifies the resident, in that order. The
source changed status in five controllers and logged history in three, so a complaint's
timeline depended on which screen moved it. Nothing else in the module writes `status`,
`assignedTo` or `resolution` — the resident edit route strips them — and a test walks a
complaint through create → assign → in-progress → close → reopen and asserts the timeline
reads back complete, including a change made through the legacy surface.

**The history collection bug is now untestable-by-construction.** One model, one collection.
A test asserts the database holds exactly one collection whose name matches
`complainthistor*`, which is what would have caught the original
`complainthistories`/`complaintHistories` split.

**Notice targeting is evaluated in one function.** `notices.targets()` decides whether a
notice is addressed to an occupancy, and both the resident feed and the notification fan-out
call it — so what a resident sees in the app and what they are pushed cannot disagree. The
target arrays are `Mixed` and accept either an ObjectId or the literal `"All"`, which the
source's clients both send; `isEveryone()` absorbs that quirk once. `notificationSent` makes
re-publishing safe, which matters because the scheduler retries.

**Poll counters move with the vote, not on read.** `totalVotes`, `totalVoters` and each
option's `voteCount` are denormalised and moved by atomic `$inc` alongside the vote row.
Changing a vote decrements the old option and increments the new one without touching
`totalVoters` — a changed vote is not a new voter. `eligibleVotersCount` is snapshotted at
publish so turnout is measured against a fixed denominator. The unique index on
(poll, user, unit) is what makes one-vote-per-flat true under concurrency; a test fires six
simultaneous first votes and asserts one row.

**Bills and maintenance share one fan-out.** Both are a *definition* that produces per-unit
`SocietyUnitBill` rows, so `fanOut()` exists once. It is idempotent by index — (bill, unit) and
(maintenance, unit, period) are unique — so a retried maintenance run over four hundred units
fills the gaps instead of double-billing everyone it already reached. Notifications go only to
the units a call actually created rows for, which makes a re-publish silent without needing a
separate flag.

**Three money bugs, all caught by tests rather than review:**

- `recordPayment` ran both `amount` (rupees) and `amountMinor` (paise) through `toMinor()`, so
  an internal caller's ₹500 arrived as ₹50,000 and was rejected as larger than the bill. The
  two inputs are read differently now — which is exactly the mistake the paise discipline
  exists to prevent, made at the one place the two representations meet.
- `penalties.invoice()` split the tax from `base.detail()`'s output, which has already been
  wire-serialized — so `gstAmountMinor` was gone and every invoice showed a zero split. It
  reads the stored document for the split now.
- **`aggregate()` does not cast a string `societyId` to an ObjectId** the way `find()` does, so
  every endpoint that took the society from a query parameter and then aggregated matched
  nothing and returned zeroes, silently. `toSocietyId()` in the route helpers coerces once,
  centrally, and every context builder goes through it. Nine aggregations were affected.

**A parking slot is held by a conditional update, never a read-then-write.** Every transition
names the status it expects — `AVAILABLE → PENDING_REQUEST → ALLOCATED → AVAILABLE` — so a
`findOneAndUpdate` that matches nothing means somebody moved first and the caller gets a 409.
Ten simultaneous requests for one slot produce one request row; two admins allocating the same
slot produce one holder. The slot carries only the *current* holder;
`SocietyParkingAllocation` is the audit trail, with the location denormalised so history still
reads after a level is renamed.

**The extractor was counting commented-out routes.** `// router.post('/rules', …)` matched the
regex, and the legacy parking service has six such lines whose handlers were deleted. Stripping
comments dropped the declared count from 475 to 468 and the real target from 467 to **460** —
7 endpoints that could never have been built because they do not exist.

**Two CRM test bugs fixed in passing.** `tests/journeys/full-lifecycle.test.js` asserted on
rows written by event listeners, which `lib/events.js` dispatches through `setImmediate`
without awaiting (§61) — so the assertion raced the write and failed whenever the runner was
busy. `tests/helpers.js` gained an `eventually()` poll helper and the test now waits for the
behaviour instead of racing it. And `tests/api/post-booking.test.js` computed "tomorrow" as
`Date.now() + 24h` sliced to a UTC date, while the app resolves every "today" boundary in the
tenant's timezone (§72). After 18:30 UTC those disagree, so the suite failed every evening.
It now derives the date through `lib/tz.js` like the app does.

---

## 6. Resolved before Phase 0

1. **The `complainthistories` / `complaintHistories` case mismatch** (§3.5) — resolved, not
   migrated. There is no history data to preserve, so the port uses **one** canonical
   collection, `complainthistories` (Mongoose's own pluralization of `ComplaintHistory`), for
   both the admin surface and the resident app. The bug cannot recur because there is only
   one model declaring it.
2. **No existing data.** This starts from an empty database. No import script, and the money
   string→paise conversion (§3.9) is simply how the models are written rather than a
   migration. `npm run seed` gains a society demo fixture.
3. **JWT secrets are this project's own.** `SOCIETY_JWT_SECRET_USER` and
   `SOCIETY_JWT_SECRET_ADMIN` live in this codebase's `config.js` and `.env.example`. Since
   nothing is being cut over, there are no in-flight tokens to honour — the app re-authenticates
   against this system. The *contract shape* is still matched exactly (D2); only the signing
   key is ours.
4. **All admin UI is EJS in this codebase.** No React is ported. The 69 reference screens are
   rebuilt as EJS pages under `src/views/pages/society/`, using this project's existing
   partials, drawer pattern, `pagination.ejs`, `empty.ejs` and progressive-enhancement script.
   The React tree is read as a specification of behaviour, never as code to translate.
5. **The legacy 130 stay in scope** per D1.
