const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * One resident's vote in one poll.
 *
 * The unique index on (poll, user, unit) is the one-person-one-vote rule, and
 * it includes `unitId` deliberately: someone who owns two flats gets a vote per
 * flat, which is how society resolutions actually work.
 *
 * Changing a vote rewrites `selectedOptions` and appends the previous choice to
 * `voteHistory`, so an audit can show a vote moved without a second row
 * inflating the count.
 */
const pollVoteSchema = new Schema({
  pollId: { type: Schema.Types.ObjectId, ref: 'SocietyPoll', required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true, index: true },
  occupancyId: { type: Schema.Types.ObjectId, ref: 'SocietyUnitOccupancy', required: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true },

  selectedOptions: [{ type: Schema.Types.ObjectId, required: true }],
  votedAt: { type: Date, default: Date.now },
  isAnonymous: { type: Boolean, default: false },
  voteHistory: [{
    selectedOptions: [Schema.Types.ObjectId],
    changedAt: Date,
  }],
}, { timestamps: true, collection: 'society_pollvotes' });

pollVoteSchema.plugin(societyGuard);
pollVoteSchema.index({ pollId: 1, userId: 1, unitId: 1 }, { unique: true });
pollVoteSchema.index({ pollId: 1, selectedOptions: 1 });
pollVoteSchema.index({ societyId: 1, pollId: 1 });

module.exports = model('SocietyPollVote', pollVoteSchema);
