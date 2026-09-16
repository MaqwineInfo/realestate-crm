const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');
const enums = require('./enums');

/** Bye-laws, AGM minutes, audit reports — the document categories a society defines. */
const documentTypeSchema = new Schema({
  typeName: { type: String, required: true, trim: true },
  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'society_documenttypes' });

documentTypeSchema.plugin(societyGuard);
documentTypeSchema.index({ societyId: 1, isDeleted: 1 });
documentTypeSchema.index(
  { societyId: 1, typeName: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

module.exports = model('SocietyDocumentType', documentTypeSchema);
