const { AckRule, Template, Project, User, Contact } = require('../db/models');
const messaging = require('./messaging');
const timeline = require('./timeline');
const config = require('../config');

/**
 * Spec §17: automatic acknowledgement, configured by Project + Source.
 * §17.4 is the important part — if the message fails, the lead still exists,
 * the failure is on the timeline, and the admin can see it in Setup.
 */

/** Most specific rule wins: project+source, then project, then source, then any. */
async function resolveRule({ tenantId, projectId, sourceId }) {
  const rules = await AckRule.find({
    tenantId,
    active: true,
    projectId: { $in: [projectId || null, null] },
    sourceId: { $in: [sourceId || null, null] },
  }).lean();
  if (!rules.length) return null;

  const score = (rule) => (rule.projectId ? 2 : 0) + (rule.sourceId ? 1 : 0);
  return rules.sort((a, b) => score(b) - score(a) || (b.priority || 0) - (a.priority || 0))[0];
}

async function sendFor({ tenantId, tenant, lead, contact }) {
  const rule = await resolveRule({ tenantId, projectId: lead.projectId, sourceId: lead.latestSourceId || lead.sourceId });
  if (!rule) return null;

  const [template, project, owner, freshContact] = await Promise.all([
    Template.findOne({ tenantId, _id: rule.templateId, active: true }).lean(),
    lead.projectId ? Project.findOne({ tenantId, _id: lead.projectId }).lean() : null,
    lead.ownerUserId ? User.findOne({ tenantId, _id: lead.ownerUserId }).lean() : null,
    contact || Contact.findOne({ tenantId, _id: lead.contactId }).lean(),
  ]);
  if (!template) return null;

  const vars = messaging.templateVars({
    contact: freshContact, lead, project, owner, tenant, appUrl: config.appUrl,
  });

  let log = await messaging.send({
    tenantId, channel: rule.channel, contact: freshContact, leadId: lead._id,
    templateId: template._id, template, vars, purpose: 'ACKNOWLEDGEMENT',
  });

  // §17.1: fall back to the secondary channel when the preferred one cannot go.
  if (['FAILED', 'SKIPPED'].includes(log.status) && rule.fallbackChannel && rule.fallbackTemplateId) {
    const fallback = await Template.findOne({ tenantId, _id: rule.fallbackTemplateId, active: true }).lean();
    if (fallback) {
      log = await messaging.send({
        tenantId, channel: rule.fallbackChannel, contact: freshContact, leadId: lead._id,
        templateId: fallback._id, template: fallback, vars, purpose: 'ACKNOWLEDGEMENT',
      });
    }
  }

  const delivered = ['SENT', 'DELIVERED', 'READ'].includes(log.status);
  await timeline.log({
    tenantId,
    leadId: lead._id,
    contactId: lead.contactId,
    type: delivered ? 'ACKNOWLEDGEMENT_SENT' : 'ACKNOWLEDGEMENT_FAILED',
    title: delivered
      ? `Acknowledgement sent on ${rule.channel.toLowerCase()}`
      : `Acknowledgement not sent (${log.skippedReason || log.error || 'provider error'})`,
    actorType: 'SYSTEM',
    meta: { channel: rule.channel, messageLogId: String(log._id), status: log.status },
  });
  return log;
}

module.exports = { resolveRule, sendFor };
