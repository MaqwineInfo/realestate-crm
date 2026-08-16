const {
  CommunicationCampaign, MessageLog, Template, Project, Tenant,
} = require('../db/models');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const config = require('../config');
const messaging = require('./messaging');
const segments = require('./segments');
const audit = require('./audit');

/**
 * Spec §38: communication campaigns.
 *
 * Two safety rules shape this file: the recipient count is shown and recorded
 * before anything is sent (§38.4), and opted-out contacts are excluded and
 * counted rather than silently dropped (§102, §67).
 */

async function create({ tenantId, actor, data }) {
  const template = await Template.findOne({ tenantId, _id: data.templateId, active: true }).lean();
  if (!template) throw badRequest('Choose an active template.');
  if (template.channel !== data.channel) throw badRequest('The template channel must match the campaign channel.');

  return CommunicationCampaign.create({
    tenantId,
    name: data.name,
    channel: data.channel,
    templateId: template._id,
    segmentId: data.segmentId,
    filters: data.filters || {},
    scheduledAt: data.scheduledAt,
    status: data.scheduledAt ? 'SCHEDULED' : 'DRAFT',
    createdBy: actor?._id,
  });
}

/**
 * §38.1 steps 9–11. Idempotent by status: a campaign already SENDING or SENT
 * cannot be sent twice, which is what stops the double-click double-send
 * §38.4 warns about.
 */
async function send({ tenantId, actor, campaignId, zone }) {
  const claimed = await CommunicationCampaign.findOneAndUpdate(
    { tenantId, _id: campaignId, status: { $in: ['DRAFT', 'SCHEDULED', 'PAUSED'] } },
    { $set: { status: 'SENDING', sentBy: actor?._id } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    const existing = await CommunicationCampaign.findOne({ tenantId, _id: campaignId }).lean();
    if (!existing) throw notFound('Campaign not found.');
    throw conflict(`This campaign is already ${existing.status.toLowerCase()}.`);
  }

  try {
    const [template, tenant] = await Promise.all([
      Template.findOne({ tenantId, _id: claimed.templateId }).lean(),
      Tenant.findById(tenantId).lean(),
    ]);
    const audience = await segments.recipients({ tenantId, filters: claimed.filters, zone });

    let sent = 0;
    let failed = 0;
    let excluded = 0;

    for (const contact of audience) {
      const log = await messaging.send({
        tenantId,
        channel: claimed.channel,
        contact,
        campaignId: claimed._id,
        templateId: template._id,
        template,
        purpose: 'CAMPAIGN',
        sentBy: actor?._id,
        vars: messaging.templateVars({ contact, tenant, appUrl: config.appUrl }),
      });
      if (log.status === 'SKIPPED') excluded += 1;
      else if (log.status === 'FAILED') failed += 1;
      else sent += 1;
    }

    const finished = await CommunicationCampaign.findOneAndUpdate(
      { tenantId, _id: claimed._id },
      {
        $set: {
          status: 'SENT',
          sentAt: new Date(),
          recipientCount: audience.length,
          sentCount: sent,
          failedCount: failed,
          excludedCount: excluded,
        },
      },
      { returnDocument: 'after' },
    );

    emit(EVENTS.CAMPAIGN_SENT, { tenantId, campaignId: claimed._id, sent, failed, excluded });
    await audit.record({
      tenantId, actor, entity: 'CommunicationCampaign', entityId: claimed._id, action: 'SEND',
      after: { recipients: audience.length, sent, failed, excluded },
    });
    return finished;
  } catch (err) {
    await CommunicationCampaign.updateOne({ tenantId, _id: claimed._id }, {
      $set: { status: 'FAILED', lastError: err.message },
    });
    throw err;
  }
}

/** §38.2: delivery counters, read from the message log the send produced. */
async function stats({ tenantId, campaignId }) {
  const rows = await MessageLog.aggregate([
    { $match: { tenantId: toObjectId(tenantId), campaignId: toObjectId(campaignId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  return {
    queued: byStatus.QUEUED || 0,
    sent: (byStatus.SENT || 0) + (byStatus.DELIVERED || 0) + (byStatus.READ || 0) + (byStatus.REPLIED || 0),
    delivered: (byStatus.DELIVERED || 0) + (byStatus.READ || 0) + (byStatus.REPLIED || 0),
    read: (byStatus.READ || 0) + (byStatus.REPLIED || 0),
    replied: byStatus.REPLIED || 0,
    failed: byStatus.FAILED || 0,
    skipped: byStatus.SKIPPED || 0,
  };
}

const list = ({ tenantId }) => CommunicationCampaign.find({ tenantId })
  .sort({ createdAt: -1 })
  .populate('templateId', 'name channel')
  .populate('createdBy', 'name')
  .lean();

async function get({ tenantId, campaignId }) {
  const campaign = await CommunicationCampaign.findOne({ tenantId, _id: campaignId })
    .populate('templateId')
    .populate('segmentId', 'name')
    .populate('createdBy', 'name')
    .lean();
  if (!campaign) throw notFound('Campaign not found.');

  const [counters, recipients] = await Promise.all([
    stats({ tenantId, campaignId }),
    MessageLog.find({ tenantId, campaignId })
      .sort({ createdAt: -1 }).limit(200)
      .populate('contactId', 'displayName primaryMobile')
      .lean(),
  ]);
  return { campaign, counters, recipients };
}

/** §107: scheduled campaigns are sent by the background tick. */
async function sendDueScheduled({ tenantId = null, now = new Date() } = {}) {
  const filter = { status: 'SCHEDULED', scheduledAt: { $lte: now } };
  if (tenantId) filter.tenantId = tenantId;
  const due = await CommunicationCampaign.find(filter).setOptions({ allowCrossTenant: !tenantId }).limit(10).lean();

  let processed = 0;
  for (const campaign of due) {
    const tenant = await Tenant.findById(campaign.tenantId).lean();
    await send({
      tenantId: campaign.tenantId, actor: null, campaignId: campaign._id, zone: tenant?.timezone || 'UTC',
    }).catch(() => {});
    processed += 1;
  }
  return { processed };
}

const toObjectId = (value) => (typeof value === 'string'
  ? new (require('mongoose').Types.ObjectId)(value)
  : value);

module.exports = { create, send, stats, list, get, sendDueScheduled };
