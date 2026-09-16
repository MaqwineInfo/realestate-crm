const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * Photo galleries — either an event album or a building/block album.
 *
 * `galleryType` discriminates, and one of `eventId` / `blockId` is meaningful
 * depending on which. `blockId` is an array because a building album can span
 * several blocks.
 *
 * This also backs the legacy `blockgalleries` collection through the façade
 * (SOCIETY-PLAN.md §2.2): a legacy block gallery is a row here with
 * `galleryType: 'Block'`.
 *
 * Gallery images are public files — they are meant to be shared by link.
 */
const gallerySchema = new Schema({
  galleryType: { type: String, enum: enums.galleryType, required: true, index: true },
  eventId: { type: Schema.Types.ObjectId, ref: 'SocietyEvent' },
  blockId: { type: [Schema.Types.ObjectId], ref: 'SocietyBlock', default: [] },

  title: { type: String, default: '', trim: true },
  description: { type: String, default: '' },
  images: { type: [String], default: [] },

  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_galleries' });

gallerySchema.plugin(societyGuard);
gallerySchema.index({ societyId: 1, galleryType: 1, isDeleted: 1 });
gallerySchema.index({ societyId: 1, createdAt: -1 });

module.exports = model('SocietyGallery', gallerySchema);
