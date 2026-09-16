const { Schema, model } = require('mongoose');
const societyGuard = require('../../societyGuard');

/**
 * A resident's in-app notification.
 *
 * Separate from this codebase's `Notification` model, which belongs to CRM
 * staff and carries CRM domains and links. This one is addressed to a
 * `SocietyUser` and always points back at the thing that caused it through
 * `type` / `subType` / `referenceId`, which is how the app deep-links.
 *
 * Rows are written by `services/society/notifications.js` at the same time the
 * push is handed to `services/messaging.js`, so a resident with notifications
 * disabled or a dead FCM token still sees it in the app.
 */
const notificationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'SocietyUser', required: true, index: true },
  unitId: { type: Schema.Types.ObjectId, ref: 'SocietyUnit', required: true, index: true },
  memberId: { type: Schema.Types.ObjectId, ref: 'SocietyMember', index: true },

  title: { type: String, required: true },
  body: { type: String, required: true },

  type: { type: String, required: true },
  subType: { type: String, required: true },
  referenceId: { type: Schema.Types.ObjectId, required: true },
  payload: { type: Map, of: String, default: {} },

  status: { type: String, enum: ['UNREAD', 'READ'], default: 'UNREAD', index: true },
  isDeleted: { type: Boolean, default: false },
}, { timestamps: true, collection: 'society_notifications' });

notificationSchema.plugin(societyGuard);
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, status: 1 });
notificationSchema.index({ societyId: 1, userId: 1, status: 1 });

module.exports = model('SocietyNotification', notificationSchema);
