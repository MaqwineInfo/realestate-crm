const { crud } = require('./factory');
const { SocietyAmenityPricing, SocietyTermsAndConditions } = require('../../db/models/society');

/**
 * The legacy amenity pricing and terms collections.
 *
 * Kept as real collections (SOCIETY-PLAN.md §2.2) because the canonical model
 * prices through flat `SocietyAmenityPackage` tiers, which cannot express
 * per-slot rates, seasonal rates or discounts — and terms have no canonical
 * home at all. Only the legacy surface reads them.
 */
const pricing = crud({
  Model: SocietyAmenityPricing,
  listKey: 'pricings',
  searchFields: ['pricingName'],
  filterFields: ['amenityId', 'status'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

const terms = crud({
  Model: SocietyTermsAndConditions,
  listKey: 'terms',
  searchFields: ['title'],
  filterFields: ['amenityId', 'status'],
  pageParam: 'limit',
  sort: { version: -1 },
});

/** A new version rather than an edit: a booking made under the old terms keeps them. */
async function newVersion(ctx, data, actorId) {
  const latest = await SocietyTermsAndConditions.findOne({
    societyId: ctx.societyId, amenityId: data.amenityId || null, isDeleted: false,
  }).sort({ version: -1 }).select('version').lean();
  return terms.create(ctx, { ...data, version: (latest?.version || 0) + 1 }, actorId);
}

module.exports = { ...pricing, terms: { ...terms, create: newVersion } };
