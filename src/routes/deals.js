const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const tzLib = require('../lib/tz');
const { badRequest, notFound } = require('../lib/errors');
const {
  Lead, Unit, CostSheet, UnitBlock, PaymentPlan, Project,
} = require('../db/models');
const inventoryService = require('../services/inventory');
const pricing = require('../services/pricing');
const costsheets = require('../services/costsheets');
const blocks = require('../services/blocks');
const bookings = require('../services/bookings');
const approvals = require('../services/approvals');
const opportunities = require('../services/opportunities');

/**
 * Spec §29–§33 + §115–§117: the deal path — shortlist → cost sheet → block →
 * booking. Every route here is thin; the rules live in the services.
 */
const router = express.Router();
router.use('/app', requireAuth);
router.use('/api', requireAuth);

/* -------------------------------- shortlist ------------------------------- */

router.post('/api/leads/:id/shortlists', requirePermission('unit.shortlist'), async (req, res, next) => {
  try {
    await inventoryService.shortlist({
      tenantId: req.tenantId, actor: req.user, leadId: req.params.id,
      unitId: req.body.unitId, note: req.body.note,
    });
    req.session.flash = { type: 'success', message: 'Unit shortlisted.' };
    res.redirect(req.body.returnTo?.startsWith('/app/') ? req.body.returnTo : `/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/api/leads/:id/shortlists/:unitId/remove', requirePermission('unit.shortlist'), async (req, res, next) => {
  try {
    await inventoryService.removeShortlist({
      tenantId: req.tenantId, actor: req.user, leadId: req.params.id, unitId: req.params.unitId,
    });
    req.session.flash = { type: 'success', message: 'Removed from the shortlist. Inventory is unchanged.' };
    res.redirect(`/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

/* -------------------------------- cost sheet ------------------------------ */

/**
 * §115 + V1.1 §39–§43: Generate Quotation, in four visible steps —
 * select unit → payment plan → price & discount → preview & share.
 *
 * The steps are query state on one page rather than a wizard with saved
 * partials: a quotation is cheap to rebuild and expensive to half-save.
 */
router.get('/app/leads/:id/cost-sheets/new', requirePermission('costsheet.create'), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ tenantId: req.tenantId, _id: req.params.id })
      .populate('contactId', 'displayName primaryMobile email')
      .populate('projectId', 'name')
      .lean();
    if (!lead) throw notFound('Lead not found.');

    const shortlisted = await inventoryService.shortlistFor({ tenantId: req.tenantId, leadId: lead._id });
    const unitId = req.query.unitId || shortlisted[0]?.unitId?._id;

    let unit = null;
    let preview = null;
    if (unitId) {
      unit = await inventoryService.getUnit({ tenantId: req.tenantId, unitId });
      preview = await pricing.compute({
        tenantId: req.tenantId,
        unitId,
        discountMinor: req.query.discount ? require('../lib/money').toMinor(req.query.discount) : 0,
      }).catch((err) => { res.locals.priceError = err.message; return null; });
    }

    // §40: the picker offers shortlisted units first, then real inventory —
    // nobody should have to know a unitId to quote a price.
    const projectId = unit?.projectId?._id || unit?.projectId || lead.projectId?._id || lead.projectId;
    const [available, facets, plans] = await Promise.all([
      projectId
        ? inventoryService.list({
          tenantId: req.tenantId,
          projectId,
          query: req.query,
          limit: 40,
          withPrices: require('../lib/access').can(req.user, 'inventory.view_prices'),
        })
        : { items: [], total: 0 },
      projectId ? inventoryService.facets({ tenantId: req.tenantId, projectId }) : { towers: [], floors: [], unitTypes: [] },
      projectId ? require('../services/paymentPlans').forProject({
        tenantId: req.tenantId, projectId, activeOnly: true,
      }) : [],
    ]);

    const paymentPlans = require('../services/paymentPlans');
    const selectedPlan = req.query.paymentPlanId
      ? plans.find((p) => String(p._id) === String(req.query.paymentPlanId))
      : null;

    res.render('pages/deals/cost-sheet-new', {
      title: 'Generate quotation',
      lead,
      shortlisted,
      unit,
      preview,
      plans: plans.map((p) => ({ ...p, configured: paymentPlans.isConfigured(p) })),
      selectedPlan,
      // §41: real amounts against each milestone, not just percentages.
      planSchedule: selectedPlan && preview
        ? paymentPlans.schedule({ plan: selectedPlan, basisMinor: preview.finalConsiderationMinor })
        : [],
      available: available.items,
      facets,
      discountInput: req.query.discount || '',
      /**
       * The guided path walks unit → plan → price (the picker links carry the
       * step). Arriving with a unit already chosen — from a shortlist row or a
       * saved link — goes straight to the price, because that is what was asked
       * for. The plan step stays one click away in the step nav.
       */
      step: ['unit', 'plan', 'price', 'preview'].includes(req.query.step)
        ? req.query.step
        : (unit ? 'price' : 'unit'),
    });
  } catch (err) { next(err); }
});

const costSheetSchema = z.object({
  unitId: f.objectId,
  discount: f.optionalText(20),
  paymentPlanId: f.optionalId,
  notes: f.optionalText(2000),
  validUntil: f.optionalText(10),
});

router.post('/api/leads/:id/cost-sheets', requirePermission('costsheet.create'), validate(costSheetSchema), async (req, res, next) => {
  try {
    const money = require('../lib/money');
    const sheet = await costsheets.create({
      tenantId: req.tenantId,
      actor: req.user,
      leadId: req.params.id,
      unitId: req.data.unitId,
      discountMinor: req.data.discount ? money.toMinor(req.data.discount) : 0,
      paymentPlanId: req.data.paymentPlanId,
      notes: req.data.notes,
      validUntil: req.data.validUntil ? new Date(req.data.validUntil) : undefined,
    });
    req.session.flash = {
      type: 'success',
      message: sheet.status === 'APPROVAL_PENDING'
        ? 'Cost sheet saved and sent for discount approval.'
        : 'Cost sheet saved.',
    };
    res.redirect(`/app/cost-sheets/${sheet._id}`);
  } catch (err) { next(err); }
});

router.get('/app/cost-sheets/:id', requirePermission('costsheet.create', 'inventory.view_prices'), async (req, res, next) => {
  try {
    const sheet = await costsheets.get({ tenantId: req.tenantId, costSheetId: req.params.id });
    // §41: amounts from this quotation's own frozen snapshot (§44).
    res.locals.schedule = costsheets.scheduleFor(sheet);
    res.render('pages/deals/cost-sheet', {
      title: `Cost sheet v${sheet.version}`,
      sheet,
      appUrl: require('../config').appUrl,
    });
  } catch (err) { next(err); }
});

router.post('/api/cost-sheets/:id/share', requirePermission('costsheet.create'), async (req, res, next) => {
  try {
    const sheet = await costsheets.share({ tenantId: req.tenantId, actor: req.user, costSheetId: req.params.id });
    req.session.flash = { type: 'success', message: 'Cost sheet shared. Copy the link below to send it.' };
    res.redirect(`/app/cost-sheets/${sheet._id}`);
  } catch (err) { next(err); }
});

/* -------------------------------- approvals ------------------------------- */

router.get('/app/approvals', requirePermission('discount.approve'), async (req, res, next) => {
  try {
    const pending = await approvals.pendingFor({ tenantId: req.tenantId, user: req.user });
    res.render('pages/deals/approvals', { title: 'Discount approvals', pending });
  } catch (err) { next(err); }
});

router.post('/api/approvals/:id', requirePermission('discount.approve'), async (req, res, next) => {
  try {
    await approvals.decide({
      tenantId: req.tenantId, actor: req.user, approvalId: req.params.id,
      decision: req.body.decision, note: req.body.note,
    });
    req.session.flash = { type: 'success', message: 'Decision recorded.' };
    res.redirect('/app/approvals');
  } catch (err) { next(err); }
});

/* ---------------------------------- block --------------------------------- */

/**
 * V1.1 §46–§48: the block flow gets a real unit picker and a confirmation that
 * states the deadline before it starts running. Nobody should have to know a raw
 * unitId to hold a unit for a customer.
 */
router.get('/app/leads/:id/blocks/new', requirePermission('unit.block'), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ tenantId: req.tenantId, _id: req.params.id })
      .populate('contactId', 'displayName primaryMobile')
      .populate('projectId', 'name blockDurationHours')
      .lean();
    if (!lead) throw notFound('Lead not found.');

    const shortlisted = await inventoryService.shortlistFor({ tenantId: req.tenantId, leadId: lead._id });
    // §46: the CTA always opens the picker. Auto-selecting the first shortlisted
    // unit would silently decide which unit a customer is getting.
    const unitId = req.query.unitId;
    const unit = unitId ? await inventoryService.getUnit({ tenantId: req.tenantId, unitId }) : null;
    const projectId = unit?.projectId?._id || unit?.projectId || lead.projectId?._id || lead.projectId;

    const [available, facets, sheets] = await Promise.all([
      projectId
        ? inventoryService.list({
          tenantId: req.tenantId,
          projectId,
          query: { status: 'AVAILABLE', ...req.query },
          limit: 40,
          withPrices: require('../lib/access').can(req.user, 'inventory.view_prices'),
        })
        : { items: [] },
      projectId ? inventoryService.facets({ tenantId: req.tenantId, projectId }) : { towers: [], floors: [], unitTypes: [] },
      costsheets.forLead({ tenantId: req.tenantId, leadId: lead._id }),
    ]);

    /**
     * §47: quotation priority — approved, then shared, then any bookable sheet
     * for this unit. The salesperson should not have to work out which of five
     * versions is the live one.
     */
    const forUnit = unit
      ? sheets.filter((s) => String(s.unitId?._id || s.unitId) === String(unit._id)
        && !['SUPERSEDED', 'REJECTED'].includes(s.status))
      : [];
    const suggestedSheet = forUnit.find((s) => s.status === 'APPROVED')
      || forUnit.find((s) => s.status === 'SHARED')
      || forUnit.find((s) => !s.approvalRequired)
      || null;

    // §48: show the deadline the tenant's own rules produce, before confirming.
    const expiryAt = unit
      ? await blocks.resolveExpiry({
        tenantId: req.tenantId,
        tenant: req.tenant,
        project: await Project.findOne({ tenantId: req.tenantId, _id: projectId }).lean(),
      })
      : null;

    res.render('pages/deals/block-new', {
      title: 'Block unit',
      lead,
      unit,
      shortlisted,
      available: available.items,
      facets,
      sheets: forUnit,
      suggestedSheet,
      expiryAt,
      canOverrideExpiry: require('../lib/access').can(req.user, 'unit.override_block_expiry'),
      step: unit ? 'commercial' : 'unit',
    });
  } catch (err) { next(err); }
});

const blockSchema = z.object({
  unitId: f.objectId,
  costSheetId: f.optionalId,
  tokenAmount: f.optionalText(20),
  expiryHours: f.optionalNumber,
  notes: f.optionalText(500),
});

/** §116: unit → customer → cost sheet → expiry → confirm. */
router.post('/api/leads/:id/blocks', requirePermission('unit.block'), validate(blockSchema), async (req, res, next) => {
  try {
    const money = require('../lib/money');
    await blocks.block({
      tenantId: req.tenantId,
      tenant: req.tenant,
      actor: req.user,
      leadId: req.params.id,
      unitId: req.data.unitId,
      costSheetId: req.data.costSheetId,
      tokenAmountMinor: req.data.tokenAmount ? money.toMinor(req.data.tokenAmount) : undefined,
      expiryHours: req.data.expiryHours,
      notes: req.data.notes,
    });
    req.session.flash = { type: 'success', message: 'Unit blocked. The expiry countdown has started.' };
    res.redirect(`/app/leads/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/api/blocks/:id/release', requirePermission('unit.release_block'), async (req, res, next) => {
  try {
    const block = await UnitBlock.findOne({ tenantId: req.tenantId, _id: req.params.id }).lean();
    if (!block) throw notFound('Block not found.');
    await blocks.release({
      tenantId: req.tenantId, actor: req.user, blockId: req.params.id, reason: req.body.reason,
    });
    req.session.flash = { type: 'success', message: 'Block released. The unit is available again.' };
    res.redirect(`/app/leads/${block.leadId}`);
  } catch (err) { next(err); }
});

/* --------------------------------- booking -------------------------------- */

/**
 * §117 + V1.1 §51–§53: the booking form.
 *
 * With an active block the unit is prefilled and locked (§51.1). Without one the
 * same unit picker the block flow uses is offered, because direct booking is a
 * legitimate path the backend already supports (§51.2) — it just should not be
 * the one the UI nudges you towards.
 */
router.get('/app/leads/:id/bookings/new', requirePermission('unit.book'), async (req, res, next) => {
  try {
    const lead = await Lead.findOne({ tenantId: req.tenantId, _id: req.params.id })
      .populate('contactId', 'displayName primaryMobile email')
      .populate('projectId', 'name')
      .populate('latestSourceId', 'name')
      .lean();
    if (!lead) throw notFound('Lead not found.');

    const activeBlocks = await blocks.activeFor({ tenantId: req.tenantId, leadId: lead._id });
    const sheets = await costsheets.forLead({ tenantId: req.tenantId, leadId: lead._id });
    const blockedUnitId = activeBlocks[0]?.unitId?._id;
    const unitId = blockedUnitId || req.query.unitId;
    const unit = unitId ? await inventoryService.getUnit({ tenantId: req.tenantId, unitId }) : null;

    const projectId = unit?.projectId?._id || unit?.projectId || lead.projectId?._id || lead.projectId;
    const [plans, available, facets] = await Promise.all([
      projectId ? require('../services/paymentPlans').forProject({
        tenantId: req.tenantId, projectId, activeOnly: true,
      }) : [],
      // Only offered when there is no block to book against (§51.2).
      !blockedUnitId && projectId
        ? inventoryService.list({
          tenantId: req.tenantId,
          projectId,
          query: { status: 'AVAILABLE', ...req.query },
          limit: 40,
          withPrices: require('../lib/access').can(req.user, 'inventory.view_prices'),
        })
        : { items: [] },
      projectId ? inventoryService.facets({ tenantId: req.tenantId, projectId }) : { towers: [], unitTypes: [] },
    ]);

    const bookableSheets = sheets.filter((s) => !unit || String(s.unitId?._id || s.unitId) === String(unit._id));
    const liveSheet = bookableSheets.find((s) => s.status === 'APPROVED')
      || bookableSheets.find((s) => s.status === 'SHARED')
      || bookableSheets.find((s) => !['SUPERSEDED', 'REJECTED'].includes(s.status))
      || null;

    /**
     * §53: the readiness checklist. Every one of these is a rule the booking
     * service enforces anyway — showing them up front turns a rejected submit
     * into a visible to-do list.
     */
    const pendingApproval = bookableSheets.some((s) => s.status === 'APPROVAL_PENDING');
    const checklist = [
      { label: 'Unit selected', ok: !!unit },
      {
        label: activeBlocks.length ? 'Unit blocked for this customer' : 'Unit available',
        ok: !!unit && (activeBlocks.length > 0 || unit.status === 'AVAILABLE'),
        hint: unit && unit.status === 'HOLD' ? 'This unit is on internal hold — resolve it first (§55).' : null,
      },
      { label: 'Payment plan configured', ok: plans.length > 0, hint: plans.length ? null : 'No active payment plan on this project.' },
      { label: 'Price available', ok: !!liveSheet || !!unit },
      {
        label: 'Discount approval complete',
        ok: !pendingApproval,
        hint: pendingApproval ? 'A quotation for this lead is still waiting for approval.' : null,
      },
    ];
    const ready = checklist.every((c) => c.ok);

    res.render('pages/deals/booking-new', {
      title: 'Mark booked',
      lead,
      unit,
      activeBlocks,
      sheets: bookableSheets,
      liveSheet,
      plans,
      available: available.items,
      facets,
      checklist,
      ready,
      schedule: liveSheet ? costsheets.scheduleFor(liveSheet) : [],
      today: tzLib.toDateInput(new Date(), res.locals.zone),
    });
  } catch (err) { next(err); }
});

const bookingSchema = z.object({
  unitId: f.objectId,
  costSheetId: f.optionalId,
  bookingDate: f.requiredText(10, 'Choose the booking date.'),
  finalPrice: f.requiredText(24, 'Enter the final booking price.'),
  bookingAmount: f.requiredText(24, 'Enter the booking/token amount.'),
  paymentPlanId: f.objectId,
  buyerPurpose: z.enum(['SELF_USE', 'INVESTMENT', 'RENTAL_INCOME', 'OTHER']),
  expectedExitDate: f.optionalText(10),
  expectedExitPrice: f.optionalText(24),
  expectedRoiPercentage: f.optionalNumber,
  expectedRentalStartDate: f.optionalText(10),
  expectedRent: f.optionalText(24),
  furnishing: f.enumField(['FURNISHED', 'SEMI_FURNISHED', 'UNFURNISHED']),
  purposeNotes: f.optionalText(500),
  notes: f.optionalText(1000),
});

router.post('/api/leads/:id/bookings', requirePermission('unit.book'), validate(bookingSchema), async (req, res, next) => {
  try {
    const money = require('../lib/money');
    const d = req.data;
    const booking = await bookings.createBooking({
      tenantId: req.tenantId,
      actor: req.user,
      leadId: req.params.id,
      unitId: d.unitId,
      costSheetId: d.costSheetId,
      bookingDate: tzLib.fromLocalInput(d.bookingDate, '12:00', res.locals.zone),
      finalPriceMinor: money.toMinor(d.finalPrice),
      bookingAmountMinor: money.toMinor(d.bookingAmount),
      paymentPlanId: d.paymentPlanId,
      buyerPurpose: d.buyerPurpose,
      investment: {
        expectedExitDate: d.expectedExitDate ? new Date(d.expectedExitDate) : undefined,
        expectedExitPriceMinor: d.expectedExitPrice ? money.toMinor(d.expectedExitPrice) : undefined,
        expectedRoiPercentage: d.expectedRoiPercentage,
        resaleInterest: true,
        notes: d.purposeNotes,
      },
      rental: {
        expectedRentalStartDate: d.expectedRentalStartDate ? new Date(d.expectedRentalStartDate) : undefined,
        expectedRentMinor: d.expectedRent ? money.toMinor(d.expectedRent) : undefined,
        furnishing: d.furnishing,
        rentalInterest: true,
        notes: d.purposeNotes,
      },
      notes: d.notes,
    });
    req.session.flash = { type: 'success', message: 'Booking confirmed.' };
    res.redirect(`/app/bookings/${booking._id}`);
  } catch (err) { next(err); }
});

router.get('/app/bookings/:id', requirePermission('unit.book', 'lead.view'), async (req, res, next) => {
  try {
    const booking = await bookings.get({ tenantId: req.tenantId, bookingId: req.params.id });
    res.render('pages/deals/booking', { title: 'Booking', booking });
  } catch (err) { next(err); }
});

/* ------------------------------ opportunities ----------------------------- */

router.get('/app/opportunities/:kind', requirePermission('lead.view'), async (req, res, next) => {
  try {
    const kind = req.params.kind === 'rental' ? 'rental' : 'resale';
    const [items, summary] = await Promise.all([
      opportunities.list({ tenantId: req.tenantId, kind, user: req.user, query: req.query, zone: res.locals.zone }),
      opportunities.summary({ tenantId: req.tenantId, zone: res.locals.zone }),
    ]);
    res.render('pages/deals/opportunities', {
      title: kind === 'rental' ? 'Rental opportunities' : 'Resale opportunities',
      kind,
      items,
      summary,
    });
  } catch (err) { next(err); }
});

router.post('/api/opportunities/:kind/:id', requirePermission('lead.edit'), async (req, res, next) => {
  try {
    const kind = req.params.kind === 'rental' ? 'rental' : 'resale';
    await opportunities.update({
      tenantId: req.tenantId,
      actor: req.user,
      kind,
      opportunityId: req.params.id,
      data: {
        status: req.body.status || undefined,
        assignedUserId: req.body.assignedUserId || undefined,
        nextActionAt: req.body.nextActionAt ? new Date(req.body.nextActionAt) : undefined,
        nextActionNote: req.body.nextActionNote,
        notes: req.body.notes,
      },
    });
    req.session.flash = { type: 'success', message: 'Opportunity updated.' };
    res.redirect(`/app/opportunities/${kind}`);
  } catch (err) { next(err); }
});

module.exports = router;
