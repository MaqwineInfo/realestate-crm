const { Schema, model } = require('mongoose');
const platformScoped = require('../../platformScoped');

/**
 * A guard, technician, cleaner or other staff member — the person.
 *
 * Platform-scoped, not society-scoped, and that is deliberate in the source:
 * there is no `societyId` here and `mobileNumber` is unique across the whole
 * platform. Which societies someone works at lives in
 * `SocietySocietyEmployeeAssignment`, so one guard can be posted to two
 * societies without being duplicated — and cannot be registered twice by two
 * different societies under the same number.
 *
 * The ID proofs and police verification document are private files: they are
 * written to `privateUploadDir` and only reachable through
 * `/app/files/:kind/:id`, never by URL.
 */
const societyEmployeeSchema = new Schema({
  employeeName: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  mobileNumber: { type: String, required: true, trim: true },
  countryCode: { type: String, default: '+91', trim: true },
  email: { type: String, trim: true, lowercase: true, default: null },
  address: { type: String, trim: true, maxlength: 500, default: null },
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null, index: true, sparse: true },

  profilePicture: { type: String, default: null },
  idProofFront: { type: String, default: null },
  idProofBack: { type: String, default: null },
  policeVerificationDoc: { type: String, default: null },
  policeVerificationStatus: {
    type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'], default: 'PENDING',
  },

  isActive: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null },
  createdBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'SocietyUser', default: null },
}, { timestamps: true, collection: 'society_employees' });

societyEmployeeSchema.plugin(platformScoped);
societyEmployeeSchema.index(
  { mobileNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false }, name: 'mobileNumber_unique_active' },
);

module.exports = model('SocietyEmployee', societyEmployeeSchema);
