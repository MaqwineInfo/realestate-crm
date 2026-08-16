const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * V1.1 §31 + §87: project images and documents.
 *
 * One collection with an `assetType` discriminator rather than two near-identical
 * ones — the lifecycle, permissions and visibility rules are the same for both,
 * and the only real difference is which category list applies.
 *
 * `customerVisible` is the field that matters: an internal price list and a
 * customer brochure sit side by side here, and only one of them may ever reach a
 * mini site or a quotation.
 */
const IMAGE_CATEGORIES = [
  'COVER', 'GALLERY', 'MASTER_PLAN', 'FLOOR_PLAN', 'LOCATION_MAP', 'AMENITY', 'CONSTRUCTION', 'OTHER',
];
const DOCUMENT_CATEGORIES = [
  'BROCHURE', 'RERA_CERTIFICATE', 'LEGAL', 'PRICE_LIST', 'PAYMENT_PLAN', 'SPECIFICATIONS',
  'APPROVED_PLAN', 'FLOOR_PLAN', 'SALES_KIT', 'OTHER',
];

const projectAssetSchema = new Schema({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  assetType: { type: String, enum: ['IMAGE', 'DOCUMENT'], required: true },
  category: { type: String, required: true },
  title: { type: String, trim: true, maxlength: 150 },
  caption: { type: String, maxlength: 300 },

  fileName: { type: String, required: true },
  mimeType: { type: String },
  fileSize: { type: Number },
  storageKey: { type: String, required: true },
  url: { type: String, required: true },

  displayOrder: { type: Number, default: 0 },
  // §87: internal by default. Exposure is a decision, never an accident.
  customerVisible: { type: Boolean, default: false },
  // §31.2: may the grounded assistant read this document?
  aiUsable: { type: Boolean, default: false },
  internalNote: { type: String, maxlength: 500 },

  uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  uploadedAt: { type: Date, default: Date.now },
  // §31.4: a file referenced by history is archived, not deleted.
  archived: { type: Boolean, default: false },
}, { timestamps: true });

projectAssetSchema.plugin(tenantGuard);
projectAssetSchema.index({ tenantId: 1, projectId: 1, assetType: 1, displayOrder: 1 });
projectAssetSchema.index({ tenantId: 1, projectId: 1, category: 1 });

module.exports = model('ProjectAsset', projectAssetSchema);
module.exports.IMAGE_CATEGORIES = IMAGE_CATEGORIES;
module.exports.DOCUMENT_CATEGORIES = DOCUMENT_CATEGORIES;
