const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');
const enums = require('./enums');

/**
 * The builder or developer a society belongs to. Platform-scoped: a developer
 * exists before any of its societies do, and owns several of them.
 */
const developerSchema = new Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  countryCode: { type: String, default: '+91', trim: true },
  mobileNumber: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },

  logo: { type: String, default: null },
  companyName: { type: String, trim: true, default: null },
  website: { type: String, trim: true, default: null },

  address: {
    street: { type: String, trim: true, default: null },
    city: { type: String, trim: true, default: null },
    state: { type: String, trim: true, default: null },
    pincode: { type: String, trim: true, default: null },
  },

  status: { type: String, enum: enums.commonStatus, default: 'ACTIVE' },

  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
  deletedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser' },
}, { timestamps: true, collection: 'society_developers' });

developerSchema.plugin(platformScoped);
developerSchema.index({ mobileNumber: 1, isDeleted: 1 });
developerSchema.index({ email: 1, isDeleted: 1 });

module.exports = model('SocietyDeveloper', developerSchema);
