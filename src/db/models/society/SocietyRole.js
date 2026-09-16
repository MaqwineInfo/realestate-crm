const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * The society RBAC catalog — Chairman, Society Admin, Finance Admin, Security
 * Guard and so on.
 *
 * Separate from this codebase's own `Role` model, which governs CRM staff and
 * a different permission catalog entirely. A CRM user reaching `/app/society/*`
 * is authorised by `lib/permissions.js`; a society admin reaching
 * `/api/v1/society-admin/*` is authorised by this.
 *
 * `level` orders seniority (1 = platform super admin) and `scope` says whether
 * the role acts across all societies or inside one.
 *
 * Permissions are `resource:action` strings and support three wildcard forms,
 * which `hasPermission` resolves: `*:*`, `resource:*` and `*:action`.
 */
const roleSchema = new Schema({
  key: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  displayName: { type: String, required: true, trim: true },
  description: { type: String, default: null },
  level: { type: Number, required: true, min: 1, max: 10 },
  scope: { type: String, enum: enums.roleScope, default: 'global' },
  permissions: [{ type: String, required: true }],

  isActive: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
}, { timestamps: true, versionKey: false, collection: 'society_roles' });

roleSchema.plugin(platformScoped);
roleSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { isDeleted: false } });
roleSchema.index({ scope: 1, isActive: 1, level: 1 });

roleSchema.methods.hasPermission = function hasPermission(permission) {
  if (!this.permissions || !this.permissions.length) return false;
  if (this.permissions.includes('*:*')) return true;
  if (this.permissions.includes(permission)) return true;
  const [resource, action] = permission.split(':');
  return this.permissions.includes(`${resource}:*`) || this.permissions.includes(`*:${action}`);
};

roleSchema.statics.findByKey = function findByKey(key) {
  return this.findOne({ key, isDeleted: false, isActive: true });
};

module.exports = model('SocietyRole', roleSchema);
