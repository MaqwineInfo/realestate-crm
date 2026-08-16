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

const projectSchema = new Schema({
  // Identity
  name: { type: String, required: true, trim: true, maxlength: 150 },
  developerName: { type: String, trim: true },
  code: { type: String, trim: true, uppercase: true },
  slug: { type: String, trim: true, lowercase: true },
  status: { type: String, enum: ['DRAFT', 'ACTIVE', 'ON_HOLD', 'SOLD_OUT', 'ARCHIVED'], default: 'DRAFT', index: true },
  reraNumber: { type: String, trim: true },
  reraUrl: { type: String, trim: true },
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
  configurations: [{ type: String }],
  areaMin: { type: Number },
  areaMax: { type: Number },
  areaUnit: { type: String, default: 'sqft' },
  possessionDate: { type: Date },
  salesContactName: { type: String },
  salesContactMobile: { type: String },
  bookingTerms: { type: String, maxlength: 2000 },
  keyUsps: [{ type: String }],

  // Project information
  overview: { type: String, maxlength: 5000 },
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
