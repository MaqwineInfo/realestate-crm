# V1.1 Connected Flow — Gap Analysis & Implementation Plan

Source: `Real_Estate_CRM_V1_1_Connected_Flow_Enhancement_Spec.md`
Baseline: current V1 codebase (all 30 V1 modules shipped, 315 tests green).

**Override rule:** V1.1 wins on UI/form/flow. Stable backend safety rules stay.
Nothing in §125 (regression list) may break.

---

## 1. Gap analysis

Legend: ✅ already built · 🟡 partial · ❌ missing

| V1.1 § | Requirement | Status | What is actually missing |
|---|---|---|---|
| 2 | All existing invariants | ✅ | Nothing — `applyOutcome()`, atomic claims, semantic stages, mobile identity, server pricing all intact. |
| 3 | Setup nav shows every item | 🟡 | Sidebar links only `/app/setup/users`. No Lead Allocation entry. |
| 4 | Dashboard = search + 5 tiles | 🟡 | Tiles exist. No search on the dashboard itself. |
| 5 | `/api/search` + ownership-safe access states | ❌ | Only the full page `/app/search`. No `access: EDIT/READ/OWNERSHIP_ONLY`, no tenant-wide exact-mobile lookup. |
| 6 | Pulsing NEW badge | ❌ | No badge, no animation, no `prefers-reduced-motion` handling. |
| 7–12 | Full real-estate lead form | 🟡 | Missing: state, pincode, altMobile, campaign, assignment mode, area basis, facing, floor range, possession preference, purchase timeline, funding type, loan status, decision maker, CP/referral block, portal reference, live duplicate lookup. |
| 13 | Existing-contact decision tree in the manual form | ❌ | Capture service has the re-inquiry tree; the manual form does not surface it. |
| 14 | HOT / WARM / COLD temperature | ❌ | Entirely absent. `Lead.priority` is a *manual queue-sort* field → §98 fallback applies: add temperature **separately**, do not repurpose priority. |
| 15–17 | Workspace IA + stage funnel | ❌ | No funnel component. |
| 18 | Stage history | ❌ | Only `STAGE_CHANGED` activity rows; no entered/exited pairs, so "completed vs skipped" cannot be derived reliably. |
| 19 | Parent/child stage setup screen | 🟡 | Sub-stages render as a flat list under a separate table. |
| 20 | Parent/child selection everywhere | ✅ | `data-substage-for` already filters children and hides the field when empty. |
| 21 | Merged outcome + next action, one save | 🟡 | The drawer exists and is correct, but is only wired to dashboard/queue rows. Workspace has separate stage + follow-up forms. No quick date presets. |
| 23 | Requirement card | 🟡 | Shown, but missing the new qualification fields. |
| 24 | Next action card + "missing" state | 🟡 | Next action shown; no explicit NEXT ACTION MISSING recovery card. |
| 25 | Deal card with state-aware CTAs | ❌ | Shortlist / cost sheets / blocks are separate sections; no connected CTA chain. |
| 26–30 | Project guided stepper | ❌ | One flat form, all fields at once. |
| 31 | Project media + documents | 🟡 | `media[]` subdocument exists on the model; **no upload route, no UI, no documents at all**. `multer` is installed but unused. |
| 32 | Unit generator with preview | 🟡 | Generation works; no preview-before-confirm. |
| 33–34 | Pricing UI | ✅ | Engine + UI adequate. |
| 35 | Structured payment plans | 🟡 | `milestones[]` exists (label/percentage/note) but no due rule, no sequence, no 100 % validation, no UI. |
| 36 | Mini site & review step + readiness | ❌ | Mini-site controls exist; no readiness summary. |
| 37 | Project detail tabs | 🟡 | Sections, not tabs; no Media/Documents/QR tab. |
| 38–43 | Quotation flow (4 steps) | 🟡 | Cost sheet create/share works; single-page form, no unit picker, no plan step, no schedule. |
| 44 | Payment plan snapshot on quotation | ❌ | Only `paymentPlanId` is stored — a later plan edit silently changes an issued quotation. |
| 45 | Quotation → Block CTA | ❌ | |
| 46–47 | Block unit picker | ❌ | Block form requires a raw `unitId`. |
| 48 | Block expiry UX + confirmation | 🟡 | Expiry computed and stored; not shown before confirming. |
| 49–50 | Mark Booked CTA in workspace | ❌ | Route exists; no visible CTA, no disabled-with-reason states. |
| 51–53 | Booking unit selection + readiness checklist | 🟡 | Prefills from block; no picker when unblocked, no checklist. |
| 54–55 | Booking success screen + friendly errors | 🟡 | Redirects to the booking page; error copy already friendly. |
| 56–57 | Deal state vs lead stage / expiry warning | 🟡 | Backend correct; no workspace warning after expiry. |
| 58–65 | Integration API console | ❌ | URL is shown; no cURL, no sample payload, no response docs, no signature doc, no test console. |
| 66–76 | Lead allocation setup | ❌ | `AssignmentPool` is fully functional but has **no UI whatsoever**. Project-pool → default-pool fallback (§72) not implemented. |
| 77 | Lead list temperature + dependent sub-stage filter | ❌ | |
| 79–81 | Connected payment plan flow + CTA chain | ❌ | |
| 82 | Action availability matrix | ❌ | |
| 83–84 | Lost / reopen in unified drawer | 🟡 | Both work; reopen is a separate form without a next action. |
| 85–86 | Visit completion UI order + funnel | 🟡 | Logic correct; presentation and funnel refresh missing. |
| 87–89 | Media visibility, cover image usage, QR panel | ❌ | |
| 90 | Integration health card detail | 🟡 | Health screen exists; card lacks copy/test/rotate inline. |
| 96–97 | Temperature API + lead model additions | ❌ | |
| 99 | Report updates | ❌ | |
| 101–103 | Plan migration, quotation versioning, booking plan consistency | 🟡 | Versioning ✅; migration and consistency rules ❌. |
| 104 | Project readiness validation | ❌ | |
| 105–106 | Human-readable quotation / booking numbers | ❌ | Optional. |
| 107 | Mobile responsiveness | 🟡 | Needs a pass over the new flows. |

---

## 2. Decisions taken (spec-sanctioned, recorded here so they are not re-litigated)

1. **Temperature is a new field set, not a rename of `priority`** (§98 fallback).
   `Lead.priority` stays exactly as it is — it is a manual field used to sort the
   follow-up queues, not an AI sales-intent signal. Adding temperature separately
   avoids a destructive migration and keeps queue sorting stable.
2. **`CostSheet` stays the backend entity; the UI word becomes "Quotation"** (§38, §134.15).
   No model rename, no data migration, no route churn.
3. **Stage history gets its own collection** (`LeadStageHistory`, §18). Deriving
   completed-vs-skipped from activity rows is unreliable because activities are
   append-only text, not entered/exited pairs.
4. **Media and documents are one collection** (`ProjectAsset`) with an `assetType`
   discriminator, not two near-identical ones. Existing `Project.media[]` stays
   readable; new uploads go to the new collection.
5. **File storage is local disk** under `UPLOAD_DIR`, via the already-installed
   `multer`. No cloud dependency added.
6. **Allocation keeps `AssignmentPool` as-is** and adds the missing project→default
   fallback plus a UI. No schema rename (§75: "match existing code style").
7. **Payment plan installments extend the existing `milestones[]`** rather than
   creating a parallel structure. Legacy rows keep working (§101).

---

## 3. Phases

Following the spec's own order (§133). Each phase ends green: `npm test` + `npm run smoke`.

### Phase A — Lead clarity
| # | Item | Spec | Touches |
|---|---|---|---|
| A1 | `LeadStageHistory` model + recording on every stage change | §18 | new model, `services/leads.js`, `services/stages.js` |
| A2 | Stage funnel component (completed / current / skipped / future) | §17, §86, §93 | new partial, workspace, CSS |
| A3 | Lead temperature: fields, auto-scoring service, manual override, `POST /api/leads/:id/temperature` | §14, §96, §97 | `Lead` model, new `services/temperature.js`, routes, listeners |
| A4 | Unified "Update Lead" drawer in the workspace + quick date presets | §21, §92 | workspace, `public/js/app.js` |
| A5 | Pulsing NEW badge + reduced-motion fallback | §6, §94, §95 | new partial, CSS |
| A6 | Dashboard global search + `GET /api/search` with access states | §5, §91, §123 | new route, dashboard view, JS |
| A7 | Next Action card incl. the MISSING recovery state; Deal card with CTA chain | §24, §25, §81, §82 | workspace |

### Phase B — Capture & allocation
| # | Item | Spec |
|---|---|---|
| B1 | Full lead form: all qualification fields + sections + collapse | §7–11 |
| B2 | Live duplicate lookup + existing-contact decision tree | §8.2, §13 |
| B3 | Assignment mode (Auto Allocate default / manual with permission) | §11.3, §74 |
| B4 | Server validation additions | §12 |
| B5 | Parent/child stage setup screen (tree) | §19 |
| B6 | Lead Allocation setup screen + pool CRUD + reorder + preview + fallback | §66–76 |
| B7 | Lead list: temperature column/filter, dependent sub-stage filter | §77 |

### Phase C — Project setup
| # | Item | Spec |
|---|---|---|
| C1 | Guided stepper, draft-first, resumable via `?step=` | §26–30, §36 |
| C2 | Media + documents: model, upload, categories, visibility, AI-usable | §31, §87, §88 |
| C3 | Structured payment plans with 100 % validation | §35, §101 |
| C4 | Unit generator preview | §32.2 |
| C5 | Project readiness validation + review step + detail tabs + QR panel | §37, §89, §104 |

### Phase D — Deal flow
| # | Item | Spec |
|---|---|---|
| D1 | Quotation 4-step flow with unit picker | §38–43 |
| D2 | Payment plan snapshot + installment amounts (deterministic rounding) | §41, §44, §80 |
| D3 | Block unit picker + commercial step + expiry confirmation | §45–48 |
| D4 | Mark Booked CTA, unit selection, readiness checklist, success screen | §49–55 |
| D5 | Block-expired workspace warning | §57 |
| D6 | Reopen-with-next-action in one flow | §84 |

### Phase E — Integrations & reporting
| # | Item | Spec |
|---|---|---|
| E1 | Integration API console: cURL, payload, responses, signature docs | §58–65, §90 |
| E2 | Test console (clearly labelled as creating a real lead) | §64 |
| E3 | Report updates (temperature, timeline, funding) | §99 |
| E4 | Full regression + the required test suites | §125–132 |

---

## 4. Required tests (§126–132)

Written **before** touching critical sales-state services (§134.25).

- **Lead form** — new contact, existing contact, same active project, same lost
  project, same booked project, different project, invalid mobile, budget/area/floor
  range violations, inactive manual owner, auto allocation.
- **Parent/child stages** — wrong-parent rejected, required child missing rejected,
  inactive child rejected, manual Booked rejected, manual Blocked rejected, Lost
  requires reason.
- **Funnel** — New→Connected, New→Connected→Visit Done, skipped stage stays
  uncompleted, Block via action, Booked via action, Lost branch, reopen.
- **Temperature** — unattended new = WARM + NEW, score to HOT, inactivity to COLD,
  manual override, override persistence, return to auto, Booked/Lost hide it.
- **Project stepper** — draft after basics, resume, media permission, document
  visibility, generation preview/confirm, sub-100 % plan cannot activate, quotation
  snapshots the plan.
- **Search** — owner exact mobile = EDIT, team scope normal, other salesperson exact
  mobile = OWNERSHIP_ONLY, name search cannot bypass scope, cross-tenant impossible.
- **Allocation** — default round robin, project override, inactive member skipped,
  manual transfer leaves the cursor alone, concurrent assignment safe, empty project
  pool falls back, unassigned escalation, SLA reassign skips the current owner.

---

## 5. Progress

| Phase | State |
|---|---|
| A — Lead clarity | ✅ **done** — 337 tests green (+22), 59/59 screens clean, 325 hooks resolve |
| B — Capture & allocation | ✅ **done** — 365 tests green (+28), 60/60 screens, 385 hooks |
| C — Project setup | ✅ **done** — 383 tests green (+18), 64 screens, 459 hooks |
| D — Deal flow | ✅ **done** — 396 tests green (+13), 65 screens, 467 hooks |
| E — Integrations & reporting | ✅ **done** — 405 tests green (+9), 65 screens, 473 hooks |

**All five phases complete.** 405 tests (was 315), 65 screens clean across three roles,
473 interactive hooks resolved, zero regressions in the §125 list.

## 6. Deviations from the spec, and why

Three places where the spec was followed in substance but not to the letter. Each is
called out here so the decision is visible rather than buried.

| § | Spec text | What was built | Why |
|---|---|---|---|
| §104 | "Before Active, **warn** if missing…" | Activation and mini-site publishing both warn and proceed; the review step lists every gap. | An earlier build blocked activation outright, which made the natural setup order impossible — you cannot add units to a project you are not allowed to activate. Blocking also breaks pre-launch marketing pages, which are a legitimate real-estate workflow. |
| §35.3 / §101 | 100% schedules; legacy plans stay selectable | A plan with **no** milestones is allowed to be active and is labelled "Schedule not configured". A plan **with** milestones must total exactly 100% to be active. | Reads both rules together: the 100% rule guards a schedule that exists, and §101 protects V1 plans that never had one. |
| §39 | unit → plan → price → preview | Guided links walk all four steps; arriving with a `unitId` already chosen jumps to price. | Clicking "Generate quotation" on a shortlisted unit has already answered step 1. The plan step stays one click away in the step nav. |

Two things the spec allows but this build deliberately did not do:

- **No `lead.override_temperature` permission** (§113 says do not add permissions for naming
  consistency) — `lead.edit` gates the override.
- **`CostSheet` was not renamed** (§134.15) — the UI says "Quotation", the model does not move.
