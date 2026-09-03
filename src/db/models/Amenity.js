const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §26.6: amenities as a managed list rather than free text.
 *
 * Typed into a text box they drifted immediately — "Gym", "gym" and
 * "Gymnasium" all coexisted on different projects, so nothing could be
 * filtered, compared or shown consistently on a mini site.
 *
 * `group` is what makes the checklist readable once a tenant has fifty of them.
 */
const GROUPS = ['SPORTS', 'LEISURE', 'CONVENIENCE', 'SAFETY', 'GREEN', 'PARKING', 'OTHER'];

const amenitySchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  group: { type: String, enum: GROUPS, default: 'OTHER', index: true },
  displayOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

amenitySchema.plugin(tenantGuard);
amenitySchema.index({ tenantId: 1, name: 1 }, { unique: true });

module.exports = model('Amenity', amenitySchema);
module.exports.GROUPS = GROUPS;
