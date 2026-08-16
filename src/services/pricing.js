const { PricingComponent, Unit, UnitType, Floor, Project } = require('../db/models');
const money = require('../lib/money');
const { badRequest, notFound } = require('../lib/errors');

/**
 * Spec §30 + §85: the cost-sheet engine. This module is the ONLY place a price
 * is produced. The browser may display a total but never supplies one, and
 * every amount is an integer in minor units (§73).
 *
 * Order of calculation:
 *   1. charge components (base, floor rise, PLC, parking, club, …)
 *   2. gross = sum of those
 *   3. discount, capped at gross
 *   4. tax components, charged on their configured base after discount
 *   5. final consideration = gross − discount + tax
 *
 * Stamp duty and registration are informational (§30.1): they are shown to the
 * customer but never rolled into the final consideration.
 */
const INFORMATIONAL_KINDS = ['STAMP_DUTY', 'REGISTRATION'];
const TAX_KINDS = ['TAX'];

/** Area a component is charged on, honouring its configured basis. */
function areaFor(unit, unitType, basis) {
  const pick = {
    CARPET: unit.carpetArea ?? unitType?.carpetArea,
    BUILT_UP: unit.builtUpArea ?? unitType?.builtUpArea,
    SALEABLE: unit.saleableArea ?? unitType?.superBuiltUpArea,
  }[basis || 'SALEABLE'];
  return Number(pick || 0);
}

/** §30.2: does this component apply to this unit? */
function applies(component, { unit, floorNumber, at }) {
  if (!component.active) return false;
  if (component.effectiveFrom && at < new Date(component.effectiveFrom)) return false;
  if (component.effectiveTo && at > new Date(component.effectiveTo)) return false;

  if (component.applicableUnitTypeIds?.length
    && !component.applicableUnitTypeIds.some((id) => String(id) === String(unit.unitTypeId))) return false;
  if (component.applicableTowerIds?.length
    && !component.applicableTowerIds.some((id) => String(id) === String(unit.towerId))) return false;
  if (component.floorFrom != null && floorNumber < component.floorFrom) return false;
  if (component.floorTo != null && floorNumber > component.floorTo) return false;
  return true;
}

/** One component's amount, before discount and tax. */
function amountFor(component, ctx) {
  const { unit, unitType, floorNumber, baseSoFar } = ctx;

  if (component.kind === 'BASE') {
    // A per-unit override wins over the rate card (§27.4).
    if (unit.baseValueOverrideMinor) return unit.baseValueOverrideMinor;
    const rate = unit.baseRateMinor || unitType?.defaultBaseRateMinor || component.rateMinor || 0;
    return money.rateTimes(rate, areaFor(unit, unitType, component.areaBasis));
  }

  if (component.kind === 'FLOOR_RISE') {
    if (unit.floorRiseMinor) return unit.floorRiseMinor;
    const floorsAbove = Math.max(0, floorNumber - (component.floorFrom ?? 0));
    const perFloor = money.rateTimes(component.rateMinor || 0, areaFor(unit, unitType, component.areaBasis));
    return perFloor * floorsAbove;
  }

  switch (component.calcType) {
    case 'FIXED':
      return component.rateMinor || 0;
    case 'PER_AREA':
      return money.rateTimes(component.rateMinor || 0, areaFor(unit, unitType, component.areaBasis));
    case 'PER_UNIT_COUNT':
      return (component.rateMinor || 0) * Number(unit.parkingSlots || 0);
    case 'PERCENTAGE': {
      const base = component.percentageBaseKinds?.length
        ? money.sum(component.percentageBaseKinds.map((kind) => baseSoFar[kind] || 0))
        : (baseSoFar.BASE || 0);
      return money.percentOf(base, component.percentage || 0);
    }
    default:
      return 0;
    }
}

/**
 * Computes a full cost sheet for a unit.
 * `overrides` maps componentId → amountMinor for the lines a permitted user
 * edited; `discountMinor` is the requested discount (§30.3 step 6).
 */
async function compute({
  tenantId, unitId, discountMinor = 0, overrides = {}, at = new Date(),
}) {
  const unit = await Unit.findOne({ tenantId, _id: unitId }).lean();
  if (!unit) throw notFound('Unit not found.');

  const [unitType, floor, project, components] = await Promise.all([
    unit.unitTypeId ? UnitType.findOne({ tenantId, _id: unit.unitTypeId }).lean() : null,
    unit.floorId ? Floor.findOne({ tenantId, _id: unit.floorId }).lean() : null,
    Project.findOne({ tenantId, _id: unit.projectId }).lean(),
    PricingComponent.find({ tenantId, projectId: unit.projectId }).sort({ displayOrder: 1 }).lean(),
  ]);

  const floorNumber = unit.floorNumber ?? floor?.number ?? 0;
  const applicable = components.filter((c) => applies(c, { unit, floorNumber, at }));
  if (!applicable.some((c) => c.kind === 'BASE')) {
    throw badRequest('This project has no base price configured. Add pricing components in project setup.');
  }

  const ctx = { unit, unitType, floorNumber, baseSoFar: {} };
  const charges = [];
  const taxes = [];
  const informational = [];

  for (const component of applicable) {
    const isTax = TAX_KINDS.includes(component.kind);
    const isInfo = INFORMATIONAL_KINDS.includes(component.kind);
    if (component.kind === 'DISCOUNT') continue; // discount is entered per sheet, not fixed in the profile

    const overridden = Object.prototype.hasOwnProperty.call(overrides, String(component._id));
    const amount = overridden ? Math.max(0, Number(overrides[String(component._id)])) : amountFor(component, ctx);

    const line = {
      componentId: component._id,
      name: component.name,
      kind: component.kind,
      calcType: component.calcType,
      basis: component.areaBasis,
      quantity: component.calcType === 'PER_AREA' ? areaFor(unit, unitType, component.areaBasis) : undefined,
      rateMinor: component.rateMinor,
      percentage: component.percentage,
      amountMinor: amount,
      customerVisible: component.customerVisible,
      edited: overridden,
      displayOrder: component.displayOrder,
    };

    if (isInfo) { informational.push(line); continue; }
    if (isTax) { taxes.push({ component, line }); continue; }

    ctx.baseSoFar[component.kind] = (ctx.baseSoFar[component.kind] || 0) + amount;
    charges.push(line);
  }

  const basePriceMinor = money.sum(charges.filter((l) => l.kind === 'BASE').map((l) => l.amountMinor));
  const grossAmountMinor = money.sum(charges.map((l) => l.amountMinor));

  const requestedDiscount = Math.max(0, Math.round(Number(discountMinor) || 0));
  const appliedDiscount = Math.min(requestedDiscount, grossAmountMinor);
  const netBeforeTax = grossAmountMinor - appliedDiscount;

  // Taxes are charged after the discount, on their configured base.
  const taxLines = taxes.map(({ component, line }) => {
    if (line.edited) return line;
    if (component.calcType !== 'PERCENTAGE') return line;
    const base = component.percentageBaseKinds?.length
      ? money.sum(component.percentageBaseKinds.map((kind) => ctx.baseSoFar[kind] || 0))
      : netBeforeTax;
    const discountShare = component.percentageBaseKinds?.length && grossAmountMinor
      ? Math.round((base / grossAmountMinor) * appliedDiscount)
      : 0;
    return { ...line, amountMinor: money.percentOf(Math.max(0, base - discountShare), component.percentage || 0) };
  });

  const taxAndChargesMinor = money.sum(taxLines.map((l) => l.amountMinor));
  const finalConsiderationMinor = netBeforeTax + taxAndChargesMinor;

  return {
    unit,
    unitType,
    project,
    lines: [...charges, ...taxLines].sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0)),
    informationalLines: informational,
    basePriceMinor,
    grossAmountMinor,
    discountMinor: appliedDiscount,
    discountPercentage: grossAmountMinor ? Number(((appliedDiscount / grossAmountMinor) * 100).toFixed(4)) : 0,
    taxAndChargesMinor,
    finalConsiderationMinor,
    currency: project?.currency || undefined,
  };
}

/** §28.3: the indicative price shown on an inventory row, with no discount. */
async function quickPrice({ tenantId, unitId }) {
  try {
    const result = await compute({ tenantId, unitId });
    return result.finalConsiderationMinor;
  } catch {
    return null; // a project without pricing configured simply shows no price
  }
}

module.exports = { compute, quickPrice, applies, amountFor, areaFor, INFORMATIONAL_KINDS };
