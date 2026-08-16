const { Integration, MessageLog, Contact, Template } = require('../db/models');
const { EVENTS, emit } = require('../lib/events');

/**
 * Spec §17, §38, §49, §66: one send path for WhatsApp / SMS / Email.
 *
 * Real provider credentials do not exist yet, so the default driver is `mock`:
 * it records exactly the same MessageLog and events a live driver would, which
 * keeps campaign counters, delivery reporting and the timeline honest and
 * testable. Adding a live provider means adding one entry to DRIVERS.
 */

const DRIVERS = {
  /** Records a realistic send without contacting anyone. */
  async mock({ channel, to, body }) {
    return {
      ok: true,
      providerMessageId: `mock-${channel.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      status: 'SENT',
      note: `simulated ${channel} send to ${to}`,
    };
  },
};

/**
 * §17.3: {{contact.first_name}} style placeholders, with an optional fallback
 * after a pipe — {{project.name|our projects}}. A generic inquiry has no
 * project, and "thanks for your interest in ." is not a message worth sending.
 */
function render(text, vars) {
  if (!text) return '';
  return String(text).replace(/\{\{\s*([\w.]+)\s*(?:\|([^}]*))?\}\}/g, (_, path, fallback) => {
    const value = path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), vars);
    if (value === null || value === undefined || value === '') return (fallback || '').trim();
    return String(value);
  });
}

/** §67: campaign sends must respect opt-out; operational messages may not. */
function consentBlock({ contact, channel, purpose }) {
  const consent = contact?.consent || {};
  if (consent.dnd) return 'Contact is marked do-not-contact';
  if (purpose === 'ACKNOWLEDGEMENT' || purpose === 'MANUAL') return null;
  if (channel === 'WHATSAPP' && consent.whatsappOptOut) return 'Opted out of WhatsApp';
  if (channel === 'SMS' && consent.smsOptOut) return 'Opted out of SMS';
  if (channel === 'EMAIL' && consent.emailOptOut) return 'Opted out of email';
  return null;
}

const recipientFor = (contact, channel) => (channel === 'EMAIL' ? contact?.email : contact?.normalizedMobile);

async function providerFor({ tenantId, channel }) {
  return Integration.findOne({ tenantId, category: channel, active: true, status: { $ne: 'DISABLED' } }).lean();
}

/**
 * Sends one message and logs it. Never throws at the caller: §17.4 requires a
 * failed acknowledgement to be logged without blocking lead creation.
 */
async function send({
  tenantId, channel, contact, contactId, leadId, campaignId, templateId, template,
  vars = {}, purpose = 'MANUAL', sentBy, subject, body,
}) {
  const resolvedContact = contact || (contactId ? await Contact.findOne({ tenantId, _id: contactId }).lean() : null);
  const tpl = template || (templateId ? await Template.findOne({ tenantId, _id: templateId }).lean() : null);

  const renderedBody = render(body ?? tpl?.body, vars);
  const renderedSubject = render(subject ?? tpl?.subject, vars);
  const to = recipientFor(resolvedContact, channel);

  const base = {
    tenantId,
    channel,
    purpose,
    contactId: resolvedContact?._id,
    leadId,
    campaignId,
    templateId: tpl?._id,
    to,
    subject: renderedSubject || undefined,
    body: renderedBody,
    sentBy,
  };

  const blocked = consentBlock({ contact: resolvedContact, channel, purpose });
  if (blocked || !to) {
    return MessageLog.create({
      ...base,
      status: 'SKIPPED',
      skippedReason: blocked || `No ${channel === 'EMAIL' ? 'email address' : 'mobile number'} on file`,
    });
  }

  const integration = await providerFor({ tenantId, channel });
  const driverName = integration?.driver || 'mock';
  const driver = DRIVERS[driverName] || DRIVERS.mock;

  try {
    const result = await driver({ channel, to, body: renderedBody, subject: renderedSubject, integration });
    const log = await MessageLog.create({
      ...base,
      status: result.status || 'SENT',
      providerMessageId: result.providerMessageId,
      provider: integration?.provider || 'mock',
      sentAt: new Date(),
    });
    if (integration) {
      await Integration.updateOne({ tenantId, _id: integration._id }, {
        $set: { lastSuccessAt: new Date(), status: 'CONNECTED', failureCount: 0 },
      });
    }
    return log;
  } catch (err) {
    // §17.4 / §97: record the failure, flag the integration, never block the sale.
    const log = await MessageLog.create({
      ...base, status: 'FAILED', error: err.message, provider: integration?.provider || driverName,
    });
    if (integration) {
      await Integration.updateOne({ tenantId, _id: integration._id }, {
        $set: { status: 'ATTENTION_REQUIRED', lastError: err.message, lastErrorAt: new Date() },
        $inc: { failureCount: 1 },
      });
      emit(EVENTS.INTEGRATION_FAILED, { tenantId, integrationId: integration._id, message: err.message });
    }
    return log;
  }
}

/** Provider callback (§38, §66): move a message along its delivery lifecycle. */
async function applyDeliveryUpdate({ tenantId, providerMessageId, status, at = new Date(), error }) {
  const log = await MessageLog.findOne({ tenantId, providerMessageId });
  if (!log) return null;

  const allowed = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'REPLIED', 'FAILED'];
  if (!allowed.includes(status)) return log;
  // Never walk a message backwards on an out-of-order callback.
  if (allowed.indexOf(status) < allowed.indexOf(log.status) && status !== 'FAILED') return log;

  log.status = status;
  if (status === 'DELIVERED') log.deliveredAt = at;
  if (status === 'READ') log.readAt = at;
  if (status === 'FAILED') log.error = error;
  await log.save();

  emit(EVENTS.CAMPAIGN_DELIVERY_UPDATED, { tenantId, campaignId: log.campaignId, messageId: log._id, status });
  return log;
}

/** Variables available to every template (§17.3). */
function templateVars({ contact, lead, project, owner, tenant, appUrl }) {
  return {
    contact: {
      first_name: contact?.firstName || '',
      last_name: contact?.lastName || '',
      name: contact?.displayName || '',
      mobile: contact?.primaryMobile || '',
      email: contact?.email || '',
    },
    project: {
      name: project?.name || '',
      city: project?.city || '',
      mini_site_url: project?.slug && appUrl ? `${appUrl}/p/${project.slug}` : '',
    },
    owner: { name: owner?.name || '', mobile: owner?.mobile || '', email: owner?.email || '' },
    organization: { name: tenant?.name || '' },
    lead: { id: lead ? String(lead._id) : '' },
  };
}

module.exports = { send, render, templateVars, applyDeliveryUpdate, consentBlock, DRIVERS };
