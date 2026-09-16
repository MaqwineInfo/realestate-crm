const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/**
 * A society document — bye-laws, AGM minutes, audit reports.
 *
 * `documentFile` is a **private** file. Society paperwork routinely names
 * residents and their dues, so it is written to `privateUploadDir` and served
 * only through `/app/files/society-document/:id` after a permission check,
 * never as a public URL. The source stored an S3 URL here.
 */
const documentSchema = new Schema({
  documentName: { type: String, required: true, trim: true },
  documentDescription: { type: String, default: '', trim: true },
  documentFile: { type: String, required: true },
  documentTypeId: { type: Schema.Types.ObjectId, ref: 'SocietyDocumentType', required: true, index: true },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_documents' });

documentSchema.plugin(societyGuard);
documentSchema.index({ societyId: 1, isDeleted: 1 });
documentSchema.index({ societyId: 1, documentTypeId: 1, isDeleted: 1 });

module.exports = model('SocietyDocument', documentSchema);
