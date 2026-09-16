const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A notice board post, optionally scheduled and optionally targeted.
 *
 * Two status fields, both real and both needed:
 *  - `publishStatus` (DRAFT / SCHEDULED / PUBLISHED) is the lifecycle the
 *    scheduler job drives.
 *  - `status` (ACTIVE / INACTIVE) is the admin's visibility toggle on an
 *    already-published notice.
 * Collapsing them would lose the ability to hide a published notice without
 * reverting it to a draft.
 *
 * The target arrays are `Mixed` because the source accepts either an ObjectId
 * or the literal string "All" in the same array. Kept as-is for contract
 * parity; `services/society/notices.js` normalises on read.
 *
 * `noticeNumber`, `priority` and `targetAudience` exist for the legacy façade
 * (SOCIETY-PLAN.md §2.2) — the canonical surfaces do not write them. Unlike the
 * legacy schema, `noticeNumber` is optional and its unique index is sparse, so
 * canonical notices that never set it do not collide on null.
 */
const noticeSchema = new Schema({
  title: { type: String, trim: true, default: null, index: true },
  text: { type: String, required: true, trim: true },
  category: { type: String, trim: true, enum: enums.noticeCategory, default: 'General', index: true },

  targetBlocks: [{ type: Schema.Types.Mixed }],
  targetFloors: [{ type: Schema.Types.Mixed }],
  targetUnits: [{ type: Schema.Types.Mixed }],
  residentType: { type: String, enum: enums.residentType, default: 'ALL', index: true },

  contentType: { type: String, enum: enums.noticeContentType, default: 'TEXT' },
  contentData: { type: Schema.Types.Mixed, default: null },

  publishStatus: { type: String, enum: enums.publishStatus, default: 'DRAFT', index: true },
  publishedAt: { type: Date, default: null },
  publishedBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  scheduledAt: { type: Date, default: null, index: true },
  scheduledBy: { type: Schema.Types.ObjectId, ref: 'SocietyAdmin', default: null },
  /** Set once the scheduler has pushed; keeps a retry from notifying twice. */
  notificationSent: { type: Boolean, default: false },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE', index: true },

  /** Legacy façade only. */
  noticeNumber: { type: String, trim: true, default: null },
  priority: { type: String, enum: [...enums.LEGACY_noticePriority, null], default: null },
  targetAudience: { type: String, enum: [...enums.LEGACY_noticeTarget, null], default: null },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_notices' });

noticeSchema.plugin(societyGuard);
noticeSchema.index({ societyId: 1, createdAt: -1 });
noticeSchema.index({ societyId: 1, isDeleted: 1 });
noticeSchema.index({ societyId: 1, publishStatus: 1 });
noticeSchema.index({ societyId: 1, residentType: 1 });
noticeSchema.index({ societyId: 1, category: 1, status: 1 });
/** The scheduler's sweep: due, not yet pushed. */
noticeSchema.index({ publishStatus: 1, scheduledAt: 1, notificationSent: 1 });
/**
 * Partial, not sparse: `sparse` still indexes an explicit `null`, so every
 * document that leaves this unset would collide with the first. See the note
 * on `SocietyMember.userId`.
 */
noticeSchema.index(
  { noticeNumber: 1 },
  { unique: true, partialFilterExpression: { noticeNumber: { $type: 'string' } } },
);

module.exports = model('SocietyNotice', noticeSchema);
