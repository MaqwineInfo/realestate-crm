const { Notification, User } = require('../db/models');

/**
 * Spec §45: V1 delivers in-app notifications. Email/WhatsApp delivery is opt-in
 * per user and routed through the messaging adapters when those are configured.
 */
async function notify({
  tenantId, userId, type, title, body, link, leadId, bookingId, severity = 'INFO', domain = 'SALES',
}) {
  if (!userId) return null;
  return Notification.create({
    tenantId, userId, type, title, body, link, leadId, bookingId, domain, severity, at: new Date(),
  });
}

async function notifyMany({ tenantId, userIds = [], ...rest }) {
  const unique = [...new Set(userIds.filter(Boolean).map(String))];
  return Promise.all(unique.map((userId) => notify({ tenantId, userId, ...rest })));
}

async function unreadFor({ tenantId, userId, limit = 20 }) {
  const [items, count] = await Promise.all([
    Notification.find({ tenantId, userId }).sort({ at: -1 }).limit(limit).lean(),
    Notification.countDocuments({ tenantId, userId, readAt: null }),
  ]);
  return { items, count };
}

async function markRead({ tenantId, userId, ids }) {
  const filter = { tenantId, userId, readAt: null };
  if (ids?.length) filter._id = { $in: ids };
  await Notification.updateMany(filter, { $set: { readAt: new Date() } });
}

/** Managers/admins to alert for tenant-level exceptions (§14.3, §97). */
async function adminUserIds(tenantId) {
  const users = await User.find({ tenantId, status: 'ACTIVE' }).populate('roleId', 'isAdmin').lean();
  return users.filter((u) => u.roleId?.isAdmin).map((u) => u._id);
}

module.exports = { notify, notifyMany, unreadFor, markRead, adminUserIds };
