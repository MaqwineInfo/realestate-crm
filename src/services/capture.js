const {
  Lead, Contact, InquiryTouch, LeadSource, Project, Stage,
} = require('../db/models');
const { badRequest } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const phone = require('../lib/phone');
const contactsService = require('./contacts');
const leadsService = require('./leads');
const stagesService = require('./stages');
const distribution = require('./distribution');
const sla = require('./sla');
const acknowledgement = require('./acknowledgement');
const timeline = require('./timeline');

/**
 * Spec §12.3 capture workflow and §13 re-inquiry, in one place so every entry
 * point behaves identically: the lead-capture webhook (§63), the QR walk-in
 * form (§25), the mini-site CTA (§64) and manual entry.
 *
 * The non-negotiables it protects: one contact per mobile (§55.4), one contact
 * with many inquiries (§55.5), and a re-inquiry that never overwrites the
 * original source (§55.6).
 */

async function resolveSource({ tenantId, sourceId, sourceName, category = 'API' }) {
  if (sourceId) {
    const byId = await LeadSource.findOne({ tenantId, _id: sourceId }).lean();
    if (byId) return byId;
  }
  if (sourceName) {
    const byName = await LeadSource.findOne({ tenantId, name: new RegExp(`^${escapeRegex(sourceName)}$`, 'i') }).lean();
    if (byName) return byName;
  }
  const byCategory = await stagesService.sourceByCategory({ tenantId, category });
  if (byCategory) return byCategory;
  // A source is mandatory on a lead (§10.1), so create the missing one rather
  // than dropping an inbound inquiry on the floor.
  return LeadSource.create({ tenantId, name: sourceName || category, category });
}

async function resolveProject({ tenantId, projectId, projectName }) {
  if (projectId) {
    const byId = await Project.findOne({ tenantId, _id: projectId }).lean();
    if (byId) return byId;
  }
  if (projectName) {
    return Project.findOne({ tenantId, name: new RegExp(`^${escapeRegex(projectName)}$`, 'i') }).lean();
  }
  return null;
}

/**
 * The single entry point. Returns
 * { lead, contact, isNewContact, isNewLead, isReinquiry }.
 */
async function handleInquiry({
  tenantId, tenant, payload, actor = null, createdVia = 'INTEGRATION',
  webhookEventId = null, assign = true, acknowledge = true,
}) {
  const normalizedMobile = phone.normalizeMobile(payload.mobile || payload.primaryMobile, tenant.callingCode);
  if (!normalizedMobile) throw badRequest('A valid mobile number is required to capture a lead.');

  const [source, project] = await Promise.all([
    resolveSource({
      tenantId,
      sourceId: payload.sourceId,
      sourceName: payload.source,
      category: payload.sourceCategory || 'API',
    }),
    resolveProject({ tenantId, projectId: payload.projectId, projectName: payload.project }),
  ]);

  // 3–6. One contact per mobile; an inbound payload never overwrites human edits.
  const { contact, isNew: isNewContact } = await contactsService.findOrCreate({
    tenantId,
    tenant,
    actor,
    createdVia,
    payload: {
      firstName: payload.firstName || payload.name?.split(' ')[0] || 'Unknown',
      lastName: payload.lastName || payload.name?.split(' ').slice(1).join(' ') || '',
      primaryMobile: payload.mobile || payload.primaryMobile,
      email: payload.email,
      city: payload.city,
    },
  });

  const now = payload.capturedAt ? new Date(payload.capturedAt) : new Date();
  const touchData = {
    sourceId: source._id,
    sourceDetail: payload.sourceDetail,
    campaignId: payload.campaignId,
    externalCampaignId: payload.externalCampaignId,
    adSetExternalId: payload.adSetExternalId,
    adExternalId: payload.adExternalId,
    formExternalId: payload.formExternalId,
    landingUrl: payload.landingUrl,
    utm: payload.utm,
    message: payload.message,
    webhookEventId,
  };

  // §13: does this person already have an inquiry we should attach to?
  const existing = isNewContact ? null : await findRelatedLead({ tenantId, contact, project });

  if (existing) {
    const lead = await recordReinquiry({
      tenantId, tenant, contact, lead: existing, source, project, touchData, at: now, actor,
    });
    return { lead, contact, isNewContact: false, isNewLead: false, isReinquiry: true };
  }

  // A genuinely new opportunity: contact known or not.
  const { lead } = await leadsService.create({
    tenantId,
    tenant,
    actor,
    createdVia,
    data: {
      contactId: contact._id,
      projectId: project?._id,
      sourceId: source._id,
      sourceDetail: payload.sourceDetail,
      campaignId: payload.campaignId,
      externalCampaignId: payload.externalCampaignId,
      adSetExternalId: payload.adSetExternalId,
      adExternalId: payload.adExternalId,
      formExternalId: payload.formExternalId,
      landingUrl: payload.landingUrl,
      utm: payload.utm,
      message: payload.message,
      webhookEventId,
      capturedAt: now,
      budgetMinMinor: payload.budgetMinMinor,
      budgetMaxMinor: payload.budgetMaxMinor,
      requirementNote: payload.message,
      ownerUserId: payload.ownerUserId || null,
      relatedPreviousLeadId: payload.relatedPreviousLeadId,
    },
  });

  const fresh = await Lead.findOne({ tenantId, _id: lead._id }).lean();
  await sla.startClock({ tenantId, tenant, lead: fresh });

  if (assign && !fresh.ownerUserId) {
    await distribution.assignLead({ tenantId, lead: fresh, contact, actor });
  }
  if (acknowledge) {
    const assigned = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    await acknowledgement.sendFor({ tenantId, tenant, lead: assigned, contact });
  }

  return {
    lead: await Lead.findOne({ tenantId, _id: lead._id }).lean(),
    contact,
    isNewContact,
    isNewLead: true,
    isReinquiry: false,
  };
}

/**
 * §13.2–13.4: which existing lead, if any, this inquiry belongs to.
 * - active lead for the same project  → attach a touch to it
 * - lost lead for the same project    → reopen it, keeping the lost history
 * - booked lead for the same project  → leave it alone, start a new inquiry
 * - different project                 → new lead
 */
async function findRelatedLead({ tenantId, contact, project }) {
  const projectFilter = project ? { projectId: project._id } : { projectId: null };

  const active = await Lead.findOne({
    tenantId, contactId: contact._id, status: 'ACTIVE', archived: { $ne: true }, ...projectFilter,
  }).sort({ latestInquiryAt: -1 });
  if (active) return active;

  const lost = await Lead.findOne({
    tenantId, contactId: contact._id, status: 'TERMINAL', bookedAt: null, archived: { $ne: true }, ...projectFilter,
  }).sort({ latestInquiryAt: -1 });
  return lost || null;
}

/**
 * §13.1/§13.2: append a touch, move the *latest* source only, and surface the
 * lead on the Re-Inquiry tile. The original source is never touched (§55.6).
 */
async function recordReinquiry({ tenantId, tenant, contact, lead, source, project, touchData, at, actor }) {
  const wasTerminal = lead.status === 'TERMINAL';

  await InquiryTouch.create({
    tenantId,
    contactId: contact._id,
    leadId: lead._id,
    projectId: project?._id || lead.projectId,
    at,
    isFirstTouch: false,
    ...touchData,
  });

  const update = {
    $set: {
      latestSourceId: source._id,
      latestInquiryAt: at,
      isReinquiry: true,
      reinquiryPendingAt: at,
    },
    $inc: { inquiryCount: 1 },
  };
  if (touchData.campaignId) update.$set.lastTouchCampaignId = touchData.campaignId;
  await Lead.updateOne({ tenantId, _id: lead._id }, update);
  await Contact.updateOne({ tenantId, _id: contact._id }, {
    $inc: { inquiryCount: 1 }, $set: { lastInquiryAt: at },
  });

  // §13.4: a previously lost lead comes back to life, with its history intact.
  if (wasTerminal) {
    const reopenStage = await stagesService.bySemantic({ tenantId, semanticType: 'NEW' })
      || await Stage.findOne({ tenantId, terminal: false, active: true }).sort({ displayOrder: 1 }).lean();
    await Lead.updateOne({ tenantId, _id: lead._id }, {
      $set: { status: 'ACTIVE', stageId: reopenStage._id, subStageId: null },
    });
    await require('./stageHistory').record({
      tenantId, leadId: lead._id, stageId: reopenStage._id, sourceAction: 'REINQUIRY', at,
    });
    await timeline.log({
      tenantId, leadId: lead._id, contactId: contact._id, type: 'LEAD_REOPENED',
      title: 'Lead reopened by a new inquiry', actorType: 'SYSTEM', at,
      meta: { previousLostAt: lead.lostAt, sourceId: String(source._id) },
    });
  }

  await timeline.log({
    tenantId,
    leadId: lead._id,
    contactId: contact._id,
    type: 'REINQUIRY',
    title: `Re-inquiry received via ${source.name}`,
    actorType: actor ? 'USER' : 'INTEGRATION',
    actor,
    at,
    meta: {
      sourceId: String(source._id),
      campaignId: touchData.campaignId ? String(touchData.campaignId) : undefined,
      previousInquiryCount: lead.inquiryCount,
    },
  });

  const updated = await Lead.findOne({ tenantId, _id: lead._id }).lean();

  // §13.2: the tenant decides whether a re-inquiry restarts the response timer.
  if (tenant.settings?.reinquiryRestartsSla && !updated.firstGenuineActionAt) {
    await sla.startClock({ tenantId, tenant, lead: updated });
  }

  if (!updated.ownerUserId) {
    await distribution.assignLead({ tenantId, lead: updated, contact, actor });
  }

  emit(EVENTS.LEAD_REINQUIRY_RECEIVED, {
    tenantId,
    lead: updated,
    ownerUserId: updated.ownerUserId,
    contactName: contact.displayName,
  });

  return Lead.findOne({ tenantId, _id: lead._id }).lean();
}

/**
 * V1.1 §8.2 + §13: what the manual lead form should do about a mobile number
 * that already exists.
 *
 * The capture path has always resolved this silently. The manual form has to
 * resolve it *visibly*, because a salesperson typing a number needs to know they
 * are about to duplicate a colleague's customer before they press save.
 */
async function inspectExisting({ tenantId, tenant, mobile, projectId }) {
  const normalizedMobile = phone.normalizeMobile(mobile, tenant?.callingCode);
  if (!normalizedMobile) return null;

  const contact = await Contact.findOne({ tenantId, normalizedMobile }).lean();
  if (!contact) return null;

  const project = projectId ? await Project.findOne({ tenantId, _id: projectId }).lean() : null;
  const related = await findRelatedLead({ tenantId, contact, project });

  let kind = 'CONTACT_ONLY';
  if (related) kind = related.status === 'ACTIVE' ? 'ACTIVE_SAME_PROJECT' : 'LOST_SAME_PROJECT';

  const [leadCount, bookedHere] = await Promise.all([
    Lead.countDocuments({ tenantId, contactId: contact._id }),
    project
      ? Lead.countDocuments({ tenantId, contactId: contact._id, projectId: project._id, bookedAt: { $ne: null } })
      : 0,
  ]);

  return {
    kind,
    contact,
    // §13.4: a booked lead on the same project is not a duplicate — the customer
    // may genuinely be buying a second unit.
    bookedHere: bookedHere > 0,
    leadCount,
    lead: related
      ? {
        _id: related._id,
        status: related.status,
        stageId: related.stageId,
        projectId: related.projectId,
        lostAt: related.lostAt,
        lostNote: related.lostNote,
        ownerUserId: related.ownerUserId,
        latestInquiryAt: related.latestInquiryAt,
      }
      : null,
  };
}

/** Clears the Re-Inquiry tile once the owner has looked at it (§8.2). */
async function acknowledgeReinquiry({ tenantId, leadId }) {
  await Lead.updateOne({ tenantId, _id: leadId }, { $unset: { reinquiryPendingAt: '' } });
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  handleInquiry, findRelatedLead, recordReinquiry, acknowledgeReinquiry,
  resolveSource, resolveProject, inspectExisting,
};
