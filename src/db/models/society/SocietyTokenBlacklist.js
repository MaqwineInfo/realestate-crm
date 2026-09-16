const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');

/**
 * Revoked admin JWTs.
 *
 * A society JWT lives 7–30 days and there is no session store to drop it from,
 * so logout has to be recorded somewhere the next request will look. This is
 * that list; `middleware/societyAuth.js` checks it before trusting a token.
 */
const tokenBlacklistSchema = new Schema({
  token: { type: String, required: true, index: true },
  adminId: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', index: true },
  /**
   * Mongo drops the row once the token could no longer have been valid anyway,
   * so the list stays the size of "recently revoked" rather than growing for
   * the life of the deployment.
   */
  expiresAt: { type: Date, default: null },
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_tokenblacklists' });

tokenBlacklistSchema.plugin(platformScoped);
tokenBlacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('SocietyTokenBlacklist', tokenBlacklistSchema);
