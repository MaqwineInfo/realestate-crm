# Real Estate CRM V1.1

A multi-tenant real estate sales CRM built to `Real_Estate_CRM_V1_Master_Product_Spec.md`,
extended by `Real_Estate_CRM_V1_1_Connected_Flow_Enhancement_Spec.md`.
Node.js + Express + EJS in one codebase. No frontend build step.

## Documentation

- **[CRM-GUIDE.md](CRM-GUIDE.md)** — how the product works: every term defined, setup from
  zero, and the full lead-to-booking journey with what triggers what and what happens next.
- **[FUNCTIONALITY.md](FUNCTIONALITY.md)** — the flat reference: every screen, endpoint,
  field, permission and state machine.
- **[V1_1-PLAN.md](V1_1-PLAN.md)** — the V1.1 connected-flow release: gap analysis, phases,
  and the three places the spec was followed in substance rather than to the letter.
- **[docs/REQUIREMENTS-COVERAGE.md](docs/REQUIREMENTS-COVERAGE.md)** — spec section → code → test.

## Run it

```bash
npm install
cp .env.example .env      # adjust if your Mongo is elsewhere
npm run seed              # demo organization with sample users
npm run dev               # http://localhost:3000
```

Demo logins (password `Password1`):

| Email | Role |
|---|---|
| admin@skyline.test | Organization Admin |
| manager@skyline.test | Sales Manager |
| priya@skyline.test | Sales User |
| vikram@skyline.test | Sales User |

## Tests

```bash
npm test          # 405 tests: unit, API, journey and concurrency, per-file test databases
npm run smoke     # live checks against a running server (see below)
```

`npm test` includes `tests/journeys/full-lifecycle.test.js`, which runs the entire
product as one continuous session — 57 steps from empty organization to booked unit
and attributed revenue, every form posted over HTTP exactly as a browser would.

`npm run smoke` needs the server running. It crawls all 65 screens as each role plus
the public pages, then resolves every drawer trigger, quick action, form action and
CSRF token in the rendered HTML — which is how dead buttons get caught.

`docs/REQUIREMENTS-COVERAGE.md` maps every implemented spec section to its code and its test.

## What is built

All 30 V1 modules from §3.1. The journey the spec optimises for works end to end:

**capture → round-robin assignment → SLA clock → first genuine action → follow-up
→ site visit → shortlist → cost sheet → discount approval → block → booking →
resale/rental opportunity**, with campaign spend attributed through to booking revenue.

| Area | Screens |
|---|---|
| Daily work | Sales dashboard (5 work tiles), lead workspace, complete-action drawer |
| Management | Team exception dashboard, management funnel, five reports, CSV export |
| Real estate | Projects, tower/floor/unit hierarchy, live inventory, floor grid, cost sheets, blocks, bookings |
| Customer-facing | QR walk-in form, project mini site, shared cost sheet |
| Marketing | Contact book, segments, campaigns, ad performance with first/last-touch attribution |
| Setup | Users, roles, stages, SLA, templates, acknowledgement, nurture, integrations, audit trail |

## Layout

```
src/
  config.js        env + constants
  db/              mongoose connection, models, tenant guard, seed
  lib/             money, phone, timezone, permissions, events, password, errors
  middleware/      auth/tenant resolution, RBAC, CSRF, validation, error handling
  services/        all business rules — routes stay thin
  routes/          one file per domain; declares its /app/* pages and /api/* endpoints
  views/           EJS pages and partials
public/            one stylesheet, one progressive-enhancement script
tests/             unit/, api/
```

## Things worth knowing

**Money** is stored as integer minor units (paise) everywhere — `lib/money.js` is the only
place decimals exist (§73).

**Time** is stored in UTC; every "today" boundary resolves through `lib/tz.js` in the
tenant's timezone, so no two screens can disagree about what today means (§72).

**Tenant isolation** is enforced by a Mongoose plugin: a query against a tenant-scoped
collection that does not constrain `tenantId` throws before it reaches Mongo (§4.2).

**Transactions.** MongoDB only offers multi-document transactions on a replica set.
On a standalone `mongod` this app follows §87 — every contended write is a single-document
atomic conditional update, and multi-step flows are ordered idempotent sagas. `db.withTx()`
uses a real transaction automatically when the connection supports one, so pointing
`MONGO_URI` at a replica set upgrades integrity with no code change:

```yaml
# /opt/homebrew/etc/mongod.conf
replication:
  replSet: rs0
```
then `mongosh --eval 'rs.initiate()'` once. `GET /healthz` reports which mode is active.

**Providers** (WhatsApp/SMS/email, ad platforms, telephony) are adapters. Until real
credentials are configured they use mock drivers that record realistic delivery state;
inbound webhooks are real, verified and idempotent.

**AI** (§42) runs on a deterministic, grounded driver: summaries, priority scores, next-action
suggestions, unit recommendations and project Q&A are assembled from rows this tenant actually
has, filtered by the asking user's permissions. It has no write path and no generative step, so
"never invent a unit, price or availability" (§42.7) is structural rather than a promise.

**The non-negotiable rule** (§55.1–3) lives in one function — `services/followups.js`
`applyOutcome()`. Every path that closes a piece of work goes through it, so an active lead
cannot be left without a next action by adding a new route.
