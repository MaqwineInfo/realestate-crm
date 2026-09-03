const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §26: project setup is deliberately detailed because one record powers
 * sales conversations, the mini site (§64), inventory, pricing, AI and campaign
 * content (§122.16). Money fields are integer minor units (§73).
 */
const mediaItemSchema = new Schema({
  kind: { type: String, enum: ['COVER', 'GALLERY', 'FLOOR_PLAN', 'MASTER_PLAN', 'LOCATION_MAP', 'VIDEO', 'BROCHURE'], required: true },
  name: { type: String },
  url: { type: String, required: true },
  mime: { type: String },
  size: { type: Number },
  displayOrder: { type: Number, default: 0 },
  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

/**
 * §26.4: the people standing at the site. One name and one number was never
 * enough — a project has a sales head, site executives and a relationship
 * manager, and a customer needs the right one.
 */
const siteContactSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  designation: { type: String, trim: true, maxlength: 80 },
  mobile: { type: String, trim: true, maxlength: 20 },
  normalizedMobile: { type: String, trim: true, maxlength: 20 },
  email: { type: String, trim: true, lowercase: true, maxlength: 150 },
  // The one whose number goes on the mini site and the QR page.
  isPrimary: { type: Boolean, default: false },
  displayOrder: { type: Number, default: 0 },
}, { _id: true });

/**
 * §26.5: one row per configuration — a 2 BHK and a 3 BHK have different areas,
 * different prices and often different possession dates. A comma-separated
 * string could hold none of that.
 */
const AREA_UNITS = ['sqft', 'sqyd', 'sqm', 'acre', 'guntha', 'bigha'];

const configurationSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  carpetArea: { type: Number, min: 0 },
  builtUpArea: { type: Number, min: 0 },
  saleableArea: { type: Number, min: 0 },
  areaUnit: { type: String, enum: AREA_UNITS, default: 'sqft' },
  priceMinor: { type: Number, min: 0 },
  possessionDate: { type: Date },
  unitCount: { type: Number, min: 0 },
  displayOrder: { type: Number, default: 0 },
}, { _id: true });

const projectSchema = new Schema({
  // Identity
  name: { type: String, required: true, trim: true, maxlength: 150 },
  developerName: { type: String, trim: true },
  code: { type: String, trim: true, uppercase: true },
  slug: { type: String, trim: true, lowercase: true },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ON_HOLD', 'SOLD_OUT', 'ARCHIVED'], default: 'DRAFT', index: true },
  reraNumber: { type: String, trim: true },
  reraUrl: { type: String, trim: true },
  // The tenant's own label (§26.1). `projectType` below stays the semantic the
  // mini site and reporting key off, so renaming never changes behaviour.
  projectTypeId: { type: Schema.Types.ObjectId, ref: 'ProjectType', index: true },
  projectType: { type: String, enum: ['RESIDENTIAL', 'COMMERCIAL', 'PLOTTING', 'VILLA', 'MIXED_USE'], default: 'RESIDENTIAL' },
  propertyTypes: [{ type: String }],

  // Location
  address: { type: String, maxlength: 500 },
  landmark: { type: String },
  city: { type: String, index: true },
  state: { type: String },
  pincode: { type: String },
  latitude: { type: Number },
  longitude: { type: Number },
  mapUrl: { type: String },

  // Sales
  startingPriceMinor: { type: Number, min: 0 },
  priceRangeMaxMinor: { type: Number, min: 0 },
  /**
   * §26.3: the scale the price was typed in. Amounts are always stored in minor
   * units; this only remembers how the figure was entered, so the edit form
   * shows "85 Crore" back rather than 850000000000 paise.
   */
  priceScale: { type: String, enum: ['ONE', 'THOUSAND', 'LAKH', 'CRORE'], default: 'LAKH' },
  configurations: [{ type: String }],
  areaMin: { type: Number },
  areaMax: { type: Number },
  areaUnit: { type: String, enum: AREA_UNITS, default: 'sqft' },
  possessionDate: { type: Date },
  /**
   * V2 §265: project-level partner settings. Null means "use the tenant
   * setting" — an override has to be chosen, never inherited by accident.
   */
  channelPartnerEnabled: { type: Boolean, default: true },
  cpLeadProtectionDaysOverride: { type: Number, default: null },
  collectionPoolId: { type: Schema.Types.ObjectId, ref: 'AssignmentPool', default: null },
  // Kept for the records that predate siteContacts; the form writes the array.
  salesContactName: { type: String },
  salesContactMobile: { type: String },
  siteContacts: [siteContactSchema],
  configurationDetails: [configurationSchema],
  bookingTerms: { type: String, maxlength: 2000 },
  keyUsps: [{ type: String }],

  // Project information
  overview: { type: String, maxlength: 5000 },
  // §26.6: the managed checklist. `amenities` keeps the free-typed values that
  // predate it so no existing project loses what someone wrote.
  amenityIds: [{ type: Schema.Types.ObjectId, ref: 'Amenity', index: true }],
  amenities: [{ type: String }],
  specifications: [{ label: String, value: String }],
  nearbyPlaces: [{ label: String, distance: String }],
  connectivity: [{ label: String, distance: String }],
  highlights: [{ type: String }],
  faq: [{ question: String, answer: String }],

  media: [mediaItemSchema],

  // §64 mini site
  miniSite: {
    published: { type: Boolean, default: false },
    // §64.2: never expose unit-level inventory publicly unless explicitly enabled.
    showAvailability: { type: Boolean, default: false },
    showConfigurationAvailability: { type: Boolean, default: true },
    showStartingPrice: { type: Boolean, default: true },
    ctaHeadline: { type: String },
    publishedAt: { type: Date },
  },

  // §25: public QR walk-in form token. Project identity is never trusted from
  // an editable client field (§25.3) — this token resolves tenant + project.
  qrToken: { type: String, index: true },

  archived: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

projectSchema.plugin(tenantGuard);
projectSchema.index({ tenantId: 1, name: 1 }, { unique: true });
// A partial index, not a sparse one: sparse skips only *missing* fields, so two
// projects with a null slug would collide on a unique sparse index.
projectSchema.index({ tenantId: 1, slug: 1 }, {
  unique: true,
  partialFilterExpression: { slug: { $type: 'string' } },
});
projectSchema.index({ tenantId: 1, status: 1 });

/** §64: the mini-site URL is /p/<slug>, so every project gets a stable one. */
projectSchema.pre('validate', function setSlug() {
  if (this.slug || !this.name) return;
  const base = this.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const suffix = require('node:crypto').randomBytes(3).toString('hex');
  this.slug = base ? `${base}-${suffix}` : suffix;
});

module.exports = model('Project', projectSchema);
module.exports.AREA_UNITS = AREA_UNITS;
