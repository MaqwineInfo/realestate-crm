const {
  ChannelPartner, PartnerLeadClaim, Lead, Contact, Project, Tenant, SiteVisit,
} = require('../db/models');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const phone = require('../lib/phone');
const tzLib = require('../lib/tz');
const capture = require('./capture');
const channelPartners = require('./channelPartners');
const rera = require('./rera');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §31–§37: a partner submits a customer.
 *
 * The two rules that shape this file, both non-negotiable:
 *
 *   §32/§344.9 — the submission goes through the SAME `capture.handleInquiry`
 *   every other channel uses. There is no parallel CP lead table for sales users
 *   to work separately; dedup, allocation, SLA and acknowledgement all still
 *   happen exactly once.
 *
 *   §35/§324.8 — a disputed claim creates a CONFLICT for review. It never
 *   silently overwrites an existing partner association, owner or source.
 */

/** §35: how long an accepted association is protected, project override first. */
async function protectionDays({ tenantId, tenant, project }) {
  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
  if (project?.cpLeadProtectionDaysOverride != null) return project.cpLeadProtectionDaysOverride;
  return settings.cpLeadProtectionDays ?? 90;
}

/**
 * §35: decide what this submission means, given what already exists. Returns
 * { status, conflictReason, existing } — and writes nothing.
 */
async function assessClaim({
  tenantId, tenant, partner, contact, project, now = new Date(),
}) {
  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};

  // Blocks that belong to the partner rather than the customer come first: a
  // suspended or lapsed partner is not a source dispute, it is a compliance stop.
  if (partner.status !== 'ACTIVE') {
    return { status: 'CONFLICT', conflictReason: 'PARTNER_NOT_ACTIVE', note: `Partner is ${partner.status.toLowerCase()}.` };
  }
  const reraBlock = await rera.leadSubmissionBlock({ tenantId, tenant, partner });
  if (reraBlock) return { status: 'CONFLICT', conflictReason: 'RERA_INVALID', note: reraBlock };
  const empanelmentBlock = await channelPartners.empanelmentBlock({
    tenantId, tenant, partner, projectId: project?._id, now,
  });
  if (empanelmentBlock) {
    return { status: 'CONFLICT', conflictReason: 'PROJECT_NOT_EMPANELLED', note: empanelmentBlock };
  }

  if (!contact) return { status: 'ACCEPTED' };            // brand new customer

  // Is there already a live lead for this customer on this project?
  const existing = await Lead.findOne({
    tenantId,
    contactId: contact._id,
    ...(project ? { projectId: project._id } : {}),
    status: { $ne: 'TERMINAL' },
    archived: { $ne: true },
  }).sort({ latestInquiryAt: -1 }).lean();

  if (!existing) {
    // A booked lead for the same project is not a conflict — that sale is done.
    return { status: 'ACCEPTED' };
  }

  // Same partner coming back: a re-inquiry, not a dispute.
  if (existing.channelPartnerId && String(existing.channelPartnerId) === String(partner._id)) {
    return { status: 'ACCEPTED', existing, reinquiry: true };
  }

  // Another partner holds it. Protection decides, and a human reviews (§35).
  if (existing.channelPartnerId) {
    const held = await PartnerLeadClaim.findOne({
      tenantId,
      leadId: existing._id,
      channelPartnerId: existing.channelPartnerId,
      status: 'ACCEPTED',
    }).sort({ submittedAt: -1 }).lean();
    const protectedUntil = held?.protectionUntil;
    return {
      status: 'CONFLICT',
      conflictReason: 'ANOTHER_PARTNER_ACTIVE',
      note: protectedUntil && new Date(protectedUntil) > now
        ? `Another partner's association is protected until ${tzLib.formatDate(protectedUntil, tenant?.timezone || 'UTC')}.`
        : 'This customer is already associated with another channel partner.',
      existing,
    };
  }

  // A direct or marketing lead already exists: tenant policy decides (§35).
  const mode = settings.cpClaimConflictMode || 'REVIEW';
  if (mode === 'AUTO_REJECT') {
    return {
      status: 'REJECTED',
      conflictReason: 'DIRECT_LEAD_ACTIVE',
      note: 'An active direct inquiry already exists for this customer.',
      existing,
    };
  }
  if (mode === 'ACCEPT_IF_INACTIVE_FOR_N_DAYS') {
    const idleDays = Number(settings.cpClaimInactiveDays ?? 30);
    const lastTouch = existing.lastActivityAt || existing.latestInquiryAt || existing.createdAt;
    const idle = (now - new Date(lastTouch)) / 86400000;
    if (idle >= idleDays) return { status: 'ACCEPTED', existing, tookOverIdle: true };
    return {
      status: 'CONFLICT',
      conflictReason: 'DIRECT_LEAD_ACTIVE',
      note: `An active direct inquiry was worked ${Math.floor(idle)} day(s) ago; the threshold is ${idleDays}.`,
      existing,
    };
  }
  return {
    status: 'CONFLICT',
    conflictReason: 'DIRECT_LEAD_ACTIVE',
    note: 'An active direct inquiry already exists for this customer.',
    existing,
  };
}

/**
 * §31/§32: the submission itself. The partner identity is ALWAYS the
 * authenticated one — §31 is explicit that a partner id from the browser is
 * never trusted, so callers pass the session's partner, not the form's.
 */
async function submit({
  tenantId, tenant, partner, member = null, payload, actor = null, submittedByType = 'PARTNER', now = new Date(),
}) {
  if (!partner) throw forbidden('No channel partner identity on this submission.');
  const mobile = phone.normalizeMobile(payload.mobile, tenant?.callingCode);
  if (!mobile) throw badRequest('Enter a valid mobile number.');
  if (!String(payload.name || '').trim()) throw badRequest('Enter the customer’s name.');

  const project = payload.projectId
    ? await Project.findOne({ tenantId, _id: payload.projectId }).lean()
    : null;
  if (payload.projectId && !project) throw badRequest('Choose a project.');

  const contact = await Contact.findOne({ tenantId, normalizedMobile: mobile }).lean();
  const assessment = await assessClaim({ tenantId, tenant, partner, contact, project, now });

  /**
   * The claim is written FIRST, whatever the assessment says. A rejected or
   * conflicted submission still has to be visible — a partner who submitted in
   * good faith and got nothing back is how source disputes start.
   */
  const claim = await PartnerLeadClaim.create({
    tenantId,
    claimNumber: await channelPartners.nextNumber({
      tenantId, model: PartnerLeadClaim, field: 'claimNumber', prefix: 'CPL',
    }),
    channelPartnerId: partner._id,
    channelPartnerMemberId: member?._id,
    contactId: contact?._id,
    projectId: project?._id,
    submittedAt: now,
    submittedMobile: mobile,
    submittedName: String(payload.name).trim(),
    status: assessment.status === 'ACCEPTED' ? 'PENDING' : assessment.status,
    conflictReason: assessment.conflictReason,
    conflictNote: assessment.note,
    existingLeadId: assessment.existing?._id,
    existingOwnerUserId: assessment.existing?.ownerUserId,
    existingSourceId: assessment.existing?.latestSourceId,
    existingChannelPartnerId: assessment.existing?.channelPartnerId,
    note: payload.note,
    requirement: {
      configuration: payload.configuration,
      budgetMinMinor: payload.budgetMinMinor,
      budgetMaxMinor: payload.budgetMaxMinor,
      requirement: payload.requirement,
      preferredVisitDate: payload.preferredVisitDate,
    },
  });

  // §35: a conflicted or rejected claim creates NO lead and changes nothing.
  if (assessment.status !== 'ACCEPTED') {
    await timeline.log({
      tenantId,
      channelPartnerId: partner._id,
      type: assessment.status === 'CONFLICT' ? 'CP_CLAIM_CONFLICT' : 'CP_CLAIM_REJECTED',
      title: assessment.status === 'CONFLICT'
        ? `Claim needs review — ${String(payload.name).trim()}`
        : `Claim rejected — ${String(payload.name).trim()}`,
      body: assessment.note,
      actor,
      actorType: submittedByType === 'PARTNER' ? 'INTEGRATION' : 'USER',
      meta: { claimId: String(claim._id), reason: assessment.conflictReason },
    });
    if (assessment.status === 'CONFLICT') {
      emit(EVENTS.CP_CLAIM_CONFLICT, { tenantId, claimId: claim._id, channelPartnerId: partner._id });
      await notifications.notifyMany({
        tenantId,
        userIds: [
          ...(await notifications.adminUserIds(tenantId)),
          ...(assessment.existing?.ownerUserId ? [assessment.existing.ownerUserId] : []),
        ],
        domain: 'CHANNEL_PARTNER',
        type: 'CP_CLAIM_CONFLICT',
        title: 'Channel partner claim needs review',
        body: `${channelPartners.displayNameOf(partner.profile)} claimed ${String(payload.name).trim()}. ${assessment.note || ''}`.trim(),
        link: '/app/channel-partners/claims',
        severity: 'WARNING',
      });
    }
    return { claim, lead: null, assessment };
  }

  /* ---- accepted: run the ordinary capture path (§32) ---- */
  const result = await capture.handleInquiry({
    tenantId,
    tenant,
    actor,
    createdVia: 'INTEGRATION',
    payload: {
      name: String(payload.name).trim(),
      mobile: payload.mobile,
      email: payload.email,
      projectId: project?._id,
      sourceCategory: 'CHANNEL_PARTNER',
      source: 'Channel Partner',
      sourceDetail: channelPartners.displayNameOf(partner.profile),
      message: payload.note,
      budgetMinMinor: payload.budgetMinMinor,
      budgetMaxMinor: payload.budgetMaxMinor,
      capturedAt: now,
    },
  });

  const days = await protectionDays({ tenantId, tenant, project });
  await PartnerLeadClaim.updateOne({ tenantId, _id: claim._id }, {
    $set: {
      status: 'ACCEPTED',
      leadId: result.lead._id,
      contactId: result.contact._id,
      protectionUntil: new Date(now.getTime() + days * 86400000),
      reviewedAt: now,
    },
  });

  /**
   * §33/§184/§324.7: the partner is stamped onto the lead as a SEPARATE
   * dimension. The owner assigned by allocation and the marketing source
   * history are both left alone.
   */
  await Lead.updateOne({ tenantId, _id: result.lead._id }, {
    $set: {
      channelPartnerId: partner._id,
      channelPartnerMemberId: member?._id || null,
      partnerLeadClaimId: claim._id,
      partnerAttributionStatus: 'ACCEPTED',
    },
  });

  await timeline.log({
    tenantId,
    leadId: result.lead._id,
    contactId: result.contact._id,
    type: 'REINQUIRY',
    title: `Submitted by channel partner ${channelPartners.displayNameOf(partner.profile)}`,
    body: payload.note,
    actorType: 'INTEGRATION',
    actorLabel: channelPartners.displayNameOf(partner.profile),
    at: now,
    meta: { claimId: String(claim._id), channelPartnerId: String(partner._id) },
  });
  await timeline.log({
    tenantId,
    channelPartnerId: partner._id,
    type: 'CP_LEAD_SUBMITTED',
    title: `Lead submitted — ${String(payload.name).trim()}`,
    body: project ? project.name : undefined,
    actorType: submittedByType === 'PARTNER' ? 'INTEGRATION' : 'USER',
    actor,
    at: now,
    meta: {
      claimId: String(claim._id),
      leadId: String(result.lead._id),
      memberId: member ? String(member._id) : null,
    },
  });
  emit(EVENTS.CP_LEAD_SUBMITTED, {
    tenantId, claimId: claim._id, channelPartnerId: partner._id, leadId: result.lead._id,
  });

  const owner = result.lead.ownerUserId;
  if (owner) {
    await notifications.notify({
      tenantId,
      userId: owner,
      domain: 'CHANNEL_PARTNER',
      type: 'CP_LEAD_SUBMITTED',
      title: 'Channel partner lead assigned',
      body: `${String(payload.name).trim()} · via ${channelPartners.displayNameOf(partner.profile)}`,
      link: `/app/leads/${result.lead._id}`,
      leadId: result.lead._id,
      severity: 'WARNING',
    });
  }

  return {
    claim: await PartnerLeadClaim.findOne({ tenantId, _id: claim._id }).lean(),
    lead: result.lead,
    contact: result.contact,
    assessment,
    isReinquiry: result.isReinquiry,
  };
}

/**
 * §36/§324.8: the internal decision on a conflicted claim. Accepting attaches
 * the partner to the existing lead; rejecting leaves everything as it was.
 * Either way the decision is recorded and audited.
 */
async function reviewClaim({
  tenantId, tenant, actor, claimId, decision, note, now = new Date(),
}) {
  if (!['ACCEPTED', 'REJECTED', 'KEEP_EXISTING'].includes(decision)) {
    throw badRequest('Choose accept, reject, or keep the existing partner.');
  }
  const claim = await PartnerLeadClaim.findOne({ tenantId, _id: claimId }).lean();
  if (!claim) throw notFound('Claim not found.');
  if (!['PENDING', 'CONFLICT'].includes(claim.status)) throw badRequest('This claim has already been decided.');
  if (decision !== 'ACCEPTED' && !String(note || '').trim()) throw badRequest('Give a reason for the decision.');

  const partner = await ChannelPartner.findOne({ tenantId, _id: claim.channelPartnerId }).lean();

  if (decision === 'ACCEPTED') {
    // The claim may target an existing lead, or need one created now.
    let leadId = claim.leadId || claim.existingLeadId;
    if (!leadId) {
      const project = claim.projectId ? await Project.findOne({ tenantId, _id: claim.projectId }).lean() : null;
      const result = await capture.handleInquiry({
        tenantId,
        tenant,
        actor,
        createdVia: 'MANUAL',
        payload: {
          name: claim.submittedName,
          mobile: claim.submittedMobile,
          projectId: project?._id,
          sourceCategory: 'CHANNEL_PARTNER',
          source: 'Channel Partner',
          sourceDetail: channelPartners.displayNameOf(partner?.profile || {}),
          message: claim.note,
          capturedAt: now,
        },
      });
      leadId = result.lead._id;
    }

    const project = claim.projectId ? await Project.findOne({ tenantId, _id: claim.projectId }).lean() : null;
    const days = await protectionDays({ tenantId, tenant, project });

    // §324.8: the previous partner's accepted claim is superseded explicitly,
    // by a person, on the record — never silently.
    const previous = await PartnerLeadClaim.find({
      tenantId, leadId, status: 'ACCEPTED', _id: { $ne: claim._id },
    }).lean();
    for (const old of previous) {
      await PartnerLeadClaim.updateOne({ tenantId, _id: old._id }, {
        $set: {
          status: 'REJECTED',
          reviewedBy: actor?._id,
          reviewedAt: now,
          reviewNote: `Superseded by claim ${claim.claimNumber} after review.`,
        },
      });
    }

    await PartnerLeadClaim.updateOne({ tenantId, _id: claim._id }, {
      $set: {
        status: 'ACCEPTED',
        leadId,
        reviewedBy: actor?._id,
        reviewedAt: now,
        reviewNote: note,
        protectionUntil: new Date(now.getTime() + days * 86400000),
      },
    });
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $set: {
        channelPartnerId: claim.channelPartnerId,
        channelPartnerMemberId: claim.channelPartnerMemberId || null,
        partnerLeadClaimId: claim._id,
        partnerAttributionStatus: 'ACCEPTED',
      },
    });
    emit(EVENTS.CP_CLAIM_ACCEPTED, { tenantId, claimId: claim._id, leadId });
  } else {
    await PartnerLeadClaim.updateOne({ tenantId, _id: claim._id }, {
      $set: {
        status: 'REJECTED',
        reviewedBy: actor?._id,
        reviewedAt: now,
        reviewNote: note,
      },
    });
    // §324.8: rejecting a claim leaves the lead's owner, source and existing
    // partner association exactly as they were.
    if (claim.leadId) {
      await Lead.updateOne(
        { tenantId, _id: claim.leadId, partnerLeadClaimId: claim._id },
        { $set: { partnerAttributionStatus: 'REJECTED' } },
      );
    }
  }

  await timeline.log({
    tenantId,
    channelPartnerId: claim.channelPartnerId,
    type: decision === 'ACCEPTED' ? 'CP_CLAIM_ACCEPTED' : 'CP_CLAIM_REJECTED',
    title: `Claim ${claim.claimNumber} ${decision === 'ACCEPTED' ? 'accepted' : 'rejected'}`,
    body: note,
    actor,
    meta: { claimId: String(claim._id), decision },
  });
  // §196: every claim decision is audited.
  await audit.record({
    tenantId, actor, entity: 'PartnerLeadClaim', entityId: claim._id, action: 'REVIEW',
    before: { status: claim.status }, after: { status: decision === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED', note },
  });
  return PartnerLeadClaim.findOne({ tenantId, _id: claim._id }).lean();
}

/** §36: the review queue, with the context a reviewer needs to decide. */
async function claimQueue({ tenantId, query = {}, page = 1, limit = 25 }) {
  const filter = { tenantId };
  filter.status = query.status || 'CONFLICT';
  if (query.channelPartnerId) filter.channelPartnerId = query.channelPartnerId;
  if (query.projectId) filter.projectId = query.projectId;

  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total, counts] = await Promise.all([
    PartnerLeadClaim.find(filter).sort({ submittedAt: -1 }).skip(skip).limit(limit)
      .populate('channelPartnerId', 'profile partnerCode status')
      .populate('existingChannelPartnerId', 'profile partnerCode')
      .populate('projectId', 'name')
      .populate('existingOwnerUserId', 'name')
      .populate('existingSourceId', 'name')
      .populate('contactId', 'displayName primaryMobile')
      .lean(),
    PartnerLeadClaim.countDocuments(filter),
    Promise.all(PartnerLeadClaim.STATUSES.map(async (status) => ({
      status,
      count: await PartnerLeadClaim.countDocuments({ tenantId, status }),
    }))),
  ]);
  return {
    items, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit, counts,
    activeStatus: filter.status,
  };
}

/**
 * §38: stamp the partner onto a site visit for a partner-sourced lead. Called
 * from the visit listener so no separate CP visit record ever exists.
 */
async function stampVisit({ tenantId, visitId }) {
  const visit = await SiteVisit.findOne({ tenantId, _id: visitId }).lean();
  if (!visit || visit.channelPartnerId) return null;
  const lead = await Lead.findOne({ tenantId, _id: visit.leadId })
    .select('channelPartnerId channelPartnerMemberId partnerAttributionStatus').lean();
  if (!lead?.channelPartnerId || lead.partnerAttributionStatus !== 'ACCEPTED') return null;

  await SiteVisit.updateOne({ tenantId, _id: visitId }, {
    $set: {
      channelPartnerId: lead.channelPartnerId,
      channelPartnerMemberId: lead.channelPartnerMemberId || null,
    },
  });
  return lead.channelPartnerId;
}

/**
 * §37/§271: what a partner is allowed to see about their own lead. Built by
 * picking fields rather than by hiding them, so a new internal field cannot
 * leak into the portal by default.
 */
function partnerVisibleLead({ lead, stage, visit, booking }) {
  return {
    id: lead._id,
    customerName: lead.contactId?.displayName,
    project: lead.projectId?.name,
    submittedAt: lead.firstInquiryAt,
    stage: stage?.name || null,
    visitStatus: visit ? visit.status : 'NONE',
    visitAt: visit?.scheduledAt || null,
    bookingStatus: booking ? booking.status : 'NONE',
    bookingNumber: booking?.bookingNumber || null,
    lastUpdate: lead.lastActivityAt,
  };
}

module.exports = {
  assessClaim, submit, reviewClaim, claimQueue, stampVisit, protectionDays, partnerVisibleLead,
};
