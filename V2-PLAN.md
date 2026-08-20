# V2.0 — Channel Partner + HRMS + Post-Booking / KYC / Collections — Implementation Plan

Source: `Real_Estate_CRM_V2_Connected_CP_HRMS_Post_Booking_Collections_Spec.md`
Baseline: V1 + V1.1 shipped (`src/` = 22k lines, 21 API suites green).

**Rule:** V2 extends. Nothing in the Lead → Follow-up → Visit → Quotation → Block →
Booking path gets rewritten. V2 starts at `booking.created` (spec §344.4).

---

## 1. What already exists that V2 plugs into

| V2 needs | Already in the codebase | Verdict |
|---|---|---|
| Booking snapshot | `Booking` (finalPriceMinor, paymentPlanId, costSheetId, salespersonId, attribution frozen) | reuse; add plan-row snapshot + collection totals |
| Frozen payment plan | `CostSheet.paymentPlanRows[]` (V1.1 §44) already snapshots sequence/label/percentage/dueRule/dueOffsetDays | **reuse as-is** — installments generate from this |
| Round-robin allocation | `AssignmentPool` + `services/distribution.js` (atomic `$inc` cursor) | reuse with a `poolType` field |
| Events | `lib/events.js` (in-process bus, listeners never break the emitter) | reuse, add event names |
| Jobs | `jobs/scheduler.js` (1-min tick, idempotent jobs, health page) | reuse, add job entries |
| Timeline | `services/timeline.js` → `Activity` | reuse, add `bookingId` / `channelPartnerId` / `employeeId` |
| Notifications | `services/notifications.js` + `/app/notifications` | reuse, add `domain` for filtering |
| Messaging + templates | `services/messaging.js`, `Template.purpose` | reuse, extend purpose enum + variables |
| Webhooks | `/api/webhooks/leads/:webhookKey` pattern: `WebhookEvent` raw store, signature verify, unique idempotency key | **copy this exact pattern** for payments |
| Secrets / sensitive values | `lib/secretbox.js` (AES-256-GCM seal/open/mask) | reuse for Aadhaar/PAN/bank account |
| Uploads | `services/projectAssets.js` — server-side MIME check, random storage key | reuse the shape, **but private dir** (see §3.4) |
| Permissions | `lib/permissions.js` CATALOG + scoped own/team/all + `lib/access.js` | reuse, add groups |
| Lead capture / dedup / SLA | `services/capture.js` | CP lead submission calls it — no parallel lead pipeline |
| Public token links | `CostSheet.shareToken` + `/q/:token` pattern | same pattern for `/booking-form/:token` |

Missing entirely: every CP entity, every HRMS entity, every post-booking entity,
`/app/bookings` list, `/app/collections`. `SiteVisit.channelPartnerName/Mobile` and
`Lead.referrerName/Mobile` are loose text fields from V1.1 — they stay, and get
optionally linked to real `ChannelPartner` records (no destructive migration).

---

## 2. Decisions taken (recorded so they are not re-litigated)

1. **Post-booking init is a listener + retry sweep, not a saga step.** `booking.created`
   → `postBooking.initialize()`, idempotent on `Booking.postBookingInitAt`. Scheduler job
   `booking.post_initialize_retry` finishes anything that failed. A booking is never
   undone by post-booking failure (§324.1). Reuses the existing `resumeIncomplete` shape.
2. **Installments come from `CostSheet.paymentPlanRows`,** falling back to
   `PaymentPlan.milestones` only when the booking had no quotation. Booking also gets its
   own `paymentPlanRows` snapshot copy so an old booking is readable without the quotation.
3. **Collection pool = `AssignmentPool` + `poolType: 'LEAD' | 'COLLECTION'`.** A separate
   document means a separate cursor, which is what §148 actually requires. No second
   pool model, no second round-robin implementation.
4. **`CollectionFollowUp` is its own collection** (§154 is explicit). Sales `Followup` is untouched.
5. **One `Activity` collection, scoped by id.** `bookingId` / `channelPartnerId` / `employeeId`
   added alongside `leadId`. §189 wants separate *timelines*, not separate storage —
   filtered queries give that. Lead timeline keeps showing only `BOOKING_COMPLETED`.
6. **Booking carries denormalized collection totals** (`totalReceivedMinor`, `outstandingMinor`,
   `nextDueAt`, `nextDueAmountMinor`, `overdueMinor`, `overdueDaysMax`, `paymentProgressPct`,
   `kycStatus`, `postBookingStatus`, `collectionOwnerUserId`). Exactly one writer:
   `services/collections.recalcBooking(bookingId)`, called after every receipt, reversal,
   due-date change and daily by `collection.overdue_refresh`. §241/§242.
7. **Money stays integer minor units** (`lib/money.js`). Percentage rounding remainder goes
   to the last installment (§267).
8. **Sensitive files live outside `public/`.** New `PRIVATE_UPLOAD_DIR`, plus one
   permission-checked streaming route. KYC / RERA certificate / face image / invoice PDF /
   payment proof / cancelled cheque all go there. Nothing sensitive is ever served by the
   static handler (§131, §84, §344.23).
9. **Aadhaar/PAN/bank account: sealed + masked.** `secretbox.seal()` for the full value,
   a `…1234` display string on the document, full value only behind an audited
   permission-checked reveal action.
10. **Payment gateway is one adapter interface with a MANUAL provider shipped.** Real
    provider (Razorpay/PhonePe) plugs into `Integration` with `category: 'PAYMENT_GATEWAY'`
    when keys exist. Webhook copies the lead-webhook security pattern verbatim. Creating a
    payment link is never a payment (§344.26).
11. **CP portal is a separate session identity.** `req.session.partnerUserId` +
    `middleware/partnerAuth.js`; partner portal roles (`COMPANY_ADMIN`/`SALES_MEMBER`) are a
    small hardcoded map, *not* the internal `Role` catalog (§23). A partner session can never
    resolve `/app/*` (asserted in tests).
12. **PDF = print-styled HTML page.** No PDF dependency added. Booking Form and CP invoice
    "PDF" are `?print=1` views the browser prints/saves; uploaded partner invoice PDFs are
    stored as files. Upgrade to a real renderer only if the user asks.
13. **HR attendance: raw immutable `AttendancePunch` + computed `AttendanceDay`.**
    Regularization adds a correction punch and recalculates; it never edits or deletes raw
    punches (§344.19). Geofence = haversine in `lib/geo.js` (~10 lines), server-computed only.
14. **Employee ≠ User.** `Employee.userId` nullable, unique-per-tenant when set. Exit runs a
    blocking open-work check (leads, follow-ups, visits, collection bookings, approvals)
    before the linked User can be deactivated (§56, §215).
15. **Face approval is an image-approval workflow.** Provider sync is a no-op adapter until a
    real face-attendance provider exists. Face approval never approves attendance (§212).
16. **No booking cancellation, no commercial amendment, no amount amendment UI** (§199, §200,
    §229). Booking commercials are read-only once booked. Due-date change is the one
    permitted adjustment.

---

## 3. Phases

Each phase = models → service (rules) → routes (thin) → views → tests, matching the
existing house style. Phase order follows spec §325.

### Phase 1 — Booking foundation & collections engine ✅ SHIPPED

**Models:** `BookingInstallment`, `CollectionFollowUp`, `CollectionPromise`
**Model edits:** `Booking` (+plan snapshot, collection totals, `collectionOwnerUserId`,
`postBookingStatus`, `kycStatus`, `postBookingInitAt`), `AssignmentPool` (+`poolType`),
`Activity` (+`bookingId`), `Notification` (+`domain`), `Tenant.settings` (post-booking keys)

**Services:** `postBooking.js` (initialize, order per §266), `installments.js` (generate,
due-date resolution §133–§135, rounding §267), `collections.js` (recalcBooking, queues,
owner transfer, aging §201, priority sort §202), `collectionFollowups.js` (complete → next
action required while outstanding §157, PTP create/miss §158–§160)

**Routes:** `/app/bookings` list+filters, `/app/bookings/:id` workspace (Overview /
Collections / Timeline tabs; other tabs land in Ph2–3), `/app/collections` work queue with
tabs (§223), `/app/dashboard?view=collections`, `POST /api/bookings/:id/collection-owner`,
`POST /api/bookings/:id/collection-followups`, `POST /api/collection-followups/:id/complete`
**Setup:** `/app/setup/post-booking/collection-allocation`
**Permissions:** `booking.view` (scoped), `booking.edit`, `collection.*` (§180)
**Jobs:** `collection.overdue_refresh`, `collection.followups_missed`, `collection.promise_missed`,
`booking.post_initialize_retry`
**Events:** `booking.post_initialized`, `collection.installment_due`, `.installment_overdue`,
`.followup_due`, `.promise_created`, `.promise_missed`
**Tests:** installment generation sums exactly to final price; due-date rules; idempotent
re-init; recalc after payment; queue tile count == list count (§279); next-action-required
rule; owner transfer leaves `salespersonId` untouched; tenant isolation.

### Phase 2 — Customer booking form, KYC, payments ✅ SHIPPED

**Models:** `BookingCustomerLink`, `BookingApplicant`, `KycDocumentType`, `BookingKycDocument`,
`PaymentRequest`, `BookingReceipt`, `ReceiptAllocation`
**New lib:** `lib/privateFiles.js` (store/stream/sign), `middleware/partnerAuth.js` deferred to Ph3

**Services:** `bookingForm.js` (token issue/revoke/expiry, optional OTP, submit, reopen),
`kyc.js` (checklist, per-document review, correction flow, overall status rollup §127),
`payments.js` (link create with `amount <= outstanding` guard, provider adapter, callback),
`receipts.js` (record, allocate — full allocation required §145, reverse-never-delete §146)

**Routes:** public `GET|POST /booking-form/:token` (+`/kyc` upload) under the existing
rate limiter; `POST /api/webhooks/payments/:webhookKey`; internal
`/app/bookings/:id/customer-form`, `/app/bookings/kyc` queue, `POST .../customer-link`,
`.../customer-link/revoke`, `.../kyc/review`, `.../payment-links`, `.../receipts`,
`POST /api/receipts/:id/reverse`, `GET /app/files/:kind/:id` (permission-checked download)
**Setup:** booking-form settings, KYC document types, payment reminders, payment gateway
(existing integrations screen, new category)
**Reports:** `/app/reports/bookings`, `/app/reports/collections`, `/app/reports/collection-performance`
**Jobs:** `booking.payment_reminders` (§163 bands), `booking.payment_due`
**Tests:** expired/revoked token rejected; customer cannot post commercial fields; MIME/size
rejection; KYC correction round trip; webhook signature + replay idempotency; link amount >
outstanding rejected; reversal restores outstanding; KYC file never reachable without permission.

### Phase 3 — Channel Partner ✅ SHIPPED

**Models:** `ChannelPartnerRegistration`, `ChannelPartner`, `ChannelPartnerMember`,
`PartnerPortalUser`, `PartnerReraDocument` (versioned §217), `PartnerProjectEmpanelment`,
`PartnerLeadClaim`, `PartnerCommissionRule`, `PartnerCommissionEntitlement`, `PartnerInvoice`
(lines embedded), `PartnerPayout`
**Model edits:** `Lead` (+`channelPartnerId`, `channelPartnerMemberId`, `partnerLeadClaimId`,
`partnerAttributionStatus`), `SiteVisit` (+ids), `Booking` (+CP attribution snapshot),
`Activity` (+`channelPartnerId`), `Tenant.settings` (cp keys), `Project` (+cp overrides)

**Services:** `channelPartners.js` (registration state machine, duplicate detection §216,
approve → activate + portal invite), `rera.js` (versioning, verification, expiry bands),
`partnerLeads.js` (submission → `capture.js`, claim + conflict rules §35 — review, never
overwrite), `commissions.js` (rule resolution most-specific-wins, entitlement, collection-
threshold eligibility §43 hooked to `recalcBooking`), `partnerInvoices.js` (eligible-uninvoiced
cap §48, review flow, payout)

**Routes:** internal `/app/channel-partners{,/dashboard,/registrations,/registrations/:id,
/:id,/:id/team,/:id/projects,/:id/leads,/:id/bookings,/:id/commissions,/claims,/invoices,
/invoices/:id}`; portal `/cp/{login,dashboard,leads,leads/new,visits,bookings,team,invoices,
profile,rera}` + optional public `/cp/register`
**Setup:** CP settings, RERA settings, lead protection, commission rules, invoice approval
**Reports:** `/app/reports/channel-partners`, `/app/reports/cp-invoices`
**Jobs:** `cp.rera_expiry`, `cp.commission_eligibility`
**Tests:** portal session cannot reach `/app/*`; CP identity server-derived; duplicate RERA/PAN
blocked; conflict claim creates review and leaves owner/source intact; invoice > eligible
rejected; double invoicing prevented; threshold crossing flips entitlement to ELIGIBLE;
reversal below threshold does not revoke a paid commission (flags review §228).

### Phase 4 — HRMS foundation

**Models:** `Employee`, `Department`, `Designation`, `Job`, `Branch`, `SeatingOffice`, `Shift`,
`EmployeeShiftAssignment`
**Services:** `employees.js` (stepper create/edit, code uniqueness, exit open-work check +
transfer §215), `hrOrg.js` (masters), `shifts.js` (most-specific effective assignment §75)
**Routes:** `/app/hrms/employees{,/new,/:id}`, `/app/hrms/shifts{,/roster}`,
`/app/hrms/setup/{departments,designations,jobs,branches,offices}`
**Permissions:** `hr.*` (§179) · **Tests:** code uniqueness per tenant; exit blocked with open
work; shift resolution; User↔Employee 1:1.

### Phase 5 — HR operations

**Models:** `AttendancePunch`, `AttendanceDay`, `AttendanceRegularization`, `FaceApprovalRequest`,
`LeaveType`, `LeaveGroup` (+entitlements), `EmployeeLeaveGroup`, `LeaveBalance`, `LeaveRequest`,
`Holiday`, `WeekOffPolicy`
**New lib:** `lib/geo.js` (haversine)
**Services:** `attendance.js` (calculation order §80, overnight shifts §208, multi-punch §209,
missing punch §210, out-of-range flag §211), `regularization.js`, `faceApproval.js`,
`leave.js` (validation §97, approval modes §96, balance + accrual, recalculates AttendanceDay §213),
`holidays.js`, `weekOff.js`
**Routes:** `/app/hrms/dashboard` (the 9-tile grid §58, drilldowns §60), `/app/hrms/attendance`,
`/app/hrms/punches`, `/app/hrms/face-approvals`, `/app/hrms/attendance/regularization`,
`/app/hrms/leave/*`, `/app/hrms/holidays`, `/app/hrms/week-offs`,
`/app/hrms/reports/{attendance,attendance-muster,leave}`, plus employee self-service views
**Jobs:** `hr.attendance_calculate`, `hr.attendance_missing_punch`, `hr.leave_accrual`
**Tests:** tenant-timezone day boundaries; overnight shift attribution; late/early/grace;
out-of-range ≠ absent; missing punch; regularization keeps raw punch; leave approval flips
AttendanceDay; overlap and balance rejection; muster codes; tile count == drilldown count.

### Cross-cutting, done inside the phase that first needs it

Nav additions (Bookings / Channel Partners / HRMS / Collections), dashboard view switch
(§4), management dashboard sections (§171), reports hub (§172), global search extension
(§173–§176, permission-gated), notification domains (§190), audit entries (§196–§198),
template purposes + variables (§231–§234), new default roles (§181), empty/error states,
mobile responsiveness, and a `docs/REQUIREMENTS-COVERAGE.md` row per V2 section.

---

## 3b. Phase 1 as built — decisions that moved during the build

1. **Post-booking init is a direct call inside the booking saga, not an event listener.**
   Wrapped in try/catch so a failure can never touch the sale, with
   `booking.post_initialize` sweeping anything that failed. An event is
   fire-and-forget; the schedule has to exist by the time the booking returns.
2. **`/app/dashboard?view=collections` redirects to `/app/collections`.** One
   implementation of the tiles and the queue, so §279 cannot be violated by drift.
3. **`Booking.status` untouched.** `postBookingStatus` is derived and stored beside it (§112).
4. **The queue lists bookings, not installments.** One customer is one row of work; a booking
   that is both overdue and due today shows once, under the more urgent of the two.
5. **A plan whose percentages do not total 100 generates the schedule as configured** and the
   workspace states the gap. Absorbing the shortfall into the last installment would invent
   money the customer never agreed to.
6. **"Payments received today" tile deferred to Phase 2** with receipts. A tile with no data
   source behind it is a lie, not a placeholder.
7. **The old `/app/bookings/:id` receipt page is now the workspace**; the "Booking completed"
   celebration survives as the `?created=1` banner, and the investor/rental cards moved onto
   the overview tab.

## 3c. Phase 2 as built — decisions that moved during the build

1. **The customer link token is shown exactly once**, on the page returned right after
   generation, and rides there in the session rather than the URL so it never lands in a
   server log or a referer header. Only its SHA-256 is stored, so it cannot be recovered —
   losing it means generating a new one.
2. **Generating a link closes the previous one, submitted or not.** Exactly one usable
   customer link per booking; the newest is the truth.
3. **No Aadhaar number field exists anywhere** (the agreed decision). PAN is the only
   sensitive number collected: masked for display, sealed with `secretbox`, revealed only by
   an audited action.
4. **`ReceiptAllocation` is the single source of truth for "how much was received".**
   Installment and booking figures are recomputed by summing live allocations, so a reversal
   cannot leave a stale total anywhere.
5. **A payment with no matching installments is refused, not parked.** V2 has no credit
   ledger (§145), so an over-payment is rejected with the exact surplus named rather than
   silently held somewhere nobody looks.
6. **The mock gateway link points at our own `/pay/:token` page**, which states plainly that
   online payment is not enabled and (outside production) offers a simulate action, so the
   link → callback → receipt path is exercisable before any credentials exist. `simulatePayment`
   refuses any link a real provider issued.
7. **Reminder idempotency is stored per band on the installment** (`remindersSent`), so a
   minute-by-minute job cannot become a minute-by-minute nuisance. Recorded even when the
   send is skipped for consent — retrying every minute would not change the outcome.
8. **`/app/files/:kind/:id` is the only way out of private storage**, with a per-kind
   permission map. A new kind must be added explicitly; it cannot inherit an unchecked path.
9. **Post-booking reports sit on `booking.report` / `collection.report`,** not `report.view`,
   so a collections user gets the money reports without the whole sales pipeline (§276).

## 3d. Phase 3 as built — decisions that moved during the build

1. **One shared `partnerProfile` sub-schema** for the application and the approved partner. They
   are the same 30 fields; two copies is how the two drift apart.
2. **`LeadSource` gained a `CHANNEL_PARTNER` category.** A partner submission has a real
   marketing source — "arrived via a partner" — while the partner itself is recorded separately
   on the lead, so §33's "Google Ads + ABC Realty" case still holds.
3. **A claim is written even when it is refused.** A partner who submitted in good faith and got
   nothing back is how source disputes start, so CONFLICT and REJECTED claims are records with
   reasons, visible in their portal.
4. **A portal login with no member record is the partner themselves** and is not constrained by
   a member row that does not exist. Capability limits apply to company staff, who have one.
   (Found by the tests: an individual partner could not submit a lead.)
5. **§228 evaluation no longer short-circuits on PAID** — a fully paid entitlement is exactly
   what has to be flagged when collection falls back. Nothing is ever clawed back; it becomes
   `REVIEW_REQUIRED` with the reason attached.
6. **RERA expiry announcement is decided by what has already been announced** (the timeline),
   not by a status another code path may have flipped first.
7. **Commission accrual is a direct call in post-booking initialization step 9**, inside its own
   try/catch, with `cp.commission_eligibility` as the retry — same shape as the rest of §266.
8. **Two real bugs the tests caught:** GST was double-converted to minor units (₹5,000 became
   ₹5,00,000), and the public registration form was missing its CSRF token.
9. **`npm test` is capped at four suites at a time** (`--test-concurrency=4`). Phase 3 added
   ~40 indexes across eleven models; twenty-four suites creating all of them at once was enough
   to kill a local `mongod` mid-run (fatal assertion in its diagnostic-data writer). The cap
   addresses the cause rather than the symptom.

## 4. Followed in substance, not to the letter

1. **One `Activity` collection** for lead/booking/CP/employee timelines (decision 2.5).
2. **`AssignmentPool.poolType`** instead of a separate `CollectionPool` model (decision 2.3).
3. **Print-styled HTML instead of generated PDFs** (decision 2.12).
4. **Face/biometric provider is a stub adapter** until a real provider exists (decision 2.15).
5. **Booking form "PDF" is deferred, not silently dropped** — §167 asks for a PDF snapshot
   after submission. The print-styled view is not built yet; the data it needs (applicants,
   checklist, declaration, timestamps) is all stored, so it is a view away.
6. **Invoice lines embedded in `PartnerInvoice`** rather than a `PartnerInvoiceLine` collection —
   lines are never queried independently of their invoice.
7. **CP summary counters (§243) are computed by aggregation,** not denormalized. Booking
   collection totals *are* denormalized because they drive every queue and dashboard tile.

---

## 5. Risks

- **Money correctness** — installments, allocations, reversals, commission caps. Mitigated by
  integer minor units, single-writer recalc, and a test per invariant.
- **Volume** — ~45 new models, ~120 new routes. Sequenced so each phase ships working and
  testable on its own; nothing in a later phase is required for an earlier one to be useful.
- **Sensitive data** — KYC, biometric, bank. Private storage + permission-checked streaming +
  audit are built in Phase 2 before any sensitive file exists, not retrofitted.
- **Attendance edge cases** — timezone, overnight, DST. `lib/tz.js` already handles tenant
  timezone; attendance dates are computed there, never from server UTC.

---

## 6. Answered before build (2026-08-20)

1. **Scope:** all 5 phases, straight through.
2. **Payment gateway:** MANUAL provider only. Payment links are internal requests; receipts
   are entered manually. The webhook endpoint is built and tested against a signed test
   provider so a real gateway drops in later without touching collections.
3. **Face attendance:** image-approval workflow only (§83 minimum). Punches come from
   web/mobile with server-side geofence. No device/provider adapter.
4. **KYC:** no Aadhaar *number* field anywhere — document image only. Booking link is a long
   unguessable token + expiry + revoke; `bookingLinkRequireOtp` exists as a tenant setting,
   default **off**.
5. **PDF:** print-styled HTML (`?print=1`), no PDF dependency. Assumed, not blocking.
