const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A poll put to residents — AGM motions, gate-timing changes, colour schemes.
 *
 * Targeting mirrors `SocietyNotice`: block/floor/unit arrays plus a resident
 * type, so a poll can go to owners of one block only.
 *
 * `options[].voteCount`, `totalVotes` and `totalVoters` are denormalised
 * counters. They are maintained with atomic `$inc` alongside the
 * `SocietyPollVote` write, never by counting rows on read — a poll screen that
 * recounted every vote on every open would be the slowest page in the product.
 * `eligibleVotersCount` is snapshotted at publish so turnout stays meaningful
 * even after residents move in or out.
 *
 * `settings.allowChangeVote` is why `SocietyPollVote` keeps a `voteHistory`.
 */
const pollOptionSchema = new Schema({
  text: { type: String, required: true, trim: true, maxlength: 500 },
  order: { type: Number, default: 0 },
  voteCount: { type: Number, default: 0 },
}, { _id: true });

const pollSchema = new Schema({
  pollId: { type: String },

  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, trim: true, maxlength: 2000 },

  pollType: { type: String, enum: enums.pollType, default: 'SINGLE_CHOICE' },
  maxSelections: { type: Number, default: null, min: 1 },
  options: [pollOptionSchema],

  targetBlocks: [{ type: Schema.Types.Mixed }],
  targetFloors: [{ type: Schema.Types.Mixed }],
  targetUnits: [{ type: Schema.Types.Mixed }],
  residentType: { type: String, enum: enums.residentType, default: 'ALL', index: true },

  publishStatus: { type: String, enum: enums.pollStatus, default: 'DRAFT', index: true },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin' },
  votingStartAt: { type: Date, default: null },
  votingEndAt: { type: Date, default: null, index: true },

  settings: {
    allowAnonymous: { type: Boolean, default: false },
    showResultsDuring: { type: Boolean, default: true },
    showResultsAfter: { type: Boolean, default: true },
    allowChangeVote: { type: Boolean, default: false },
  },

  totalVotes: { type: Number, default: 0 },
  totalVoters: { type: Number, default: 0 },
  eligibleVotersCount: { type: Number, default: 0 },
  notificationSent: { type: Boolean, default: false },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_polls' });

pollSchema.plugin(societyGuard);
/**
 * Partial, not sparse: `sparse` still indexes an explicit `null`, so every
 * document that leaves this unset would collide with the first. See the note
 * on `SocietyMember.userId`.
 */
pollSchema.index(
  { pollId: 1 },
  { unique: true, partialFilterExpression: { pollId: { $type: 'string' } } },
);
pollSchema.index({ societyId: 1, createdAt: -1 });
pollSchema.index({ societyId: 1, publishStatus: 1 });
pollSchema.index({ societyId: 1, isDeleted: 1, publishStatus: 1 });
pollSchema.index({ societyId: 1, votingEndAt: 1 });
/** The close-poll sweep: published, past its end time. */
pollSchema.index({ publishStatus: 1, votingEndAt: 1 });

module.exports = model('SocietyPoll', pollSchema);
