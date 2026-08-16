const { Schema, model } = require('mongoose');
const tenantGuard = require('../tenantGuard');

/**
 * Spec §5.2: Invited / Active / Suspended / Inactive. Only Active users can log
 * in or receive round-robin leads; historical ownership survives deactivation
 * (§5.2, §95, §102 "Owner Deactivated").
 */
const userSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true },
  mobile: { type: String, trim: true },
  normalizedMobile: { type: String, index: true },
  passwordHash: { type: String },
  roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
  // §6.3 "team" data scope: a manager's team is themselves plus their reports.
  managerId: { type: Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE'], default: 'INVITED', index: true },
  photoUrl: { type: String },
  timezone: { type: String },
  notificationPrefs: {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: false },
  },
  lastLoginAt: { type: Date },
  // §5.1 invitation + reset. Only hashes are stored.
  inviteTokenHash: { type: String },
  inviteExpiresAt: { type: Date },
  resetTokenHash: { type: String },
  resetExpiresAt: { type: Date },
}, { timestamps: true });

userSchema.plugin(tenantGuard);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });
userSchema.index({ tenantId: 1, status: 1 });

userSchema.methods.canLogin = function canLogin() {
  return this.status === 'ACTIVE' && !!this.passwordHash;
};

userSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.passwordHash;
    delete ret.inviteTokenHash;
    delete ret.resetTokenHash;
    return ret;
  },
});

module.exports = model('User', userSchema);
