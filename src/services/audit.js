const { AuditLog } = require('../db/models');

/**
 * Spec §56: audit the changes that matter, with before/after values, and never
 * let an audit failure break the business action that triggered it.
 */
async function record({ tenantId, actor, entity, entityId, action, before, after, req }) {
  try {
    await AuditLog.create({
      tenantId,
      userId: actor?._id,
      userName: actor?.name,
      entity,
      entityId,
      action,
      before: before ?? undefined,
      after: after ?? undefined,
      ip: req?.ip,
      userAgent: req?.get?.('user-agent'),
      sessionId: req?.sessionID,
      at: new Date(),
    });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', scope: 'audit', entity, action, message: err.message }));
  }
}

/** Only the fields that actually changed, so the log stays readable. */
function diff(before = {}, after = {}, fields) {
  const keys = fields || [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const b = {}; const a = {};
  for (const key of keys) {
    if (String(before?.[key] ?? '') !== String(after?.[key] ?? '')) {
      b[key] = before?.[key];
      a[key] = after?.[key];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}

module.exports = { record, diff };
