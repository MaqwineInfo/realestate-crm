const crypto = require('node:crypto');
const {
  ChannelPartner, ChannelPartnerRegistration, ChannelPartnerMember, PartnerPortalUser,
  PartnerProjectEmpanelment, PartnerReraDocument, PartnerLeadClaim, PartnerCommissionEntitlement,
  PartnerInvoice, Project, Tenant,
} = require('../db/models');
const { badRequest, notFound, conflict, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const phone = require('../lib/phone');
const privateFiles = require('../lib/privateFiles');
const secretbox = require('../lib/secretbox');
const rera = require('./rera');
const timeline = require('./timeline');
const notifications = require('./notifications');
const messaging = require('./messaging');
const audit = require('./audit');

/**
 * V2 §7–§30: partner registration, approval, team and project empanelment.
 *
 * The shape that matters: an APPLICATION is not a PARTNER. Approval is the one
 * transition that creates the partner record (§13), which is what keeps a
 * half-finished or rejected application from behaving like an active partner.
 *
 * §218/§219: partners and members are suspended or deactivated, never deleted —
 * historical leads, bookings and attribution stay exactly as they were.
 */

const STEP_COUNT = 7;

/* ------------------------------ numbering -------------------------------- */

async function nextNumber({ tenantId, model, field, prefix }) {
  const year = new Date().getFullYear();
  const full = `${prefix}-${year}-`;
  const latest = await model.findOne({ tenantId, [field]: new RegExp(`^${full}`) })
    .sort({ [field]: -1 }).select(field).lean();
  const next = latest ? Number(String(latest[field]).slice(full.length)) + 1 : 1;
  return `${full}${String(next).padStart(5, '0')}`;
}

/* ------------------------------- profile --------------------------------- */

/**
 * §16–§21: what a partner told us about themselves. Bank account numbers are
 * masked for display and sealed for storage (§21) — only an explicitly
 * permitted, audited action ever sees the full value.
 */
function buildProfile({ data, tenant, existing = {} }) {
  const partnerType = data.partnerType || existing.partnerType;
  if (!['COMPANY', 'INDIVIDUAL'].includes(partnerType)) throw badRequest('Choose whether this is a company or an individual partner.');

  const profile = { ...existing, partnerType };
  const text = [
    'primaryContactName', 'email', 'address', 'city', 'state', 'pincode',
    'legalName', 'tradeName', 'constitutionType', 'companyRegistrationNumber',
    'registeredAddress', 'correspondenceAddress', 'website',
    'signatoryName', 'signatoryEmail', 'billingAddress', 'defaultInvoiceTaxMode', 'msmeNumber',
  ];
  for (const field of text) {
    if (data[field] !== undefined && data[field] !== '') profile[field] = data[field];
  }
  for (const field of ['pan', 'gstin']) {
    if (data[field] !== undefined && data[field] !== '') profile[field] = String(data[field]).toUpperCase().trim();
  }
  if (data.mobile) {
    profile.mobile = data.mobile;
    profile.normalizedMobile = phone.normalizeMobile(data.mobile, tenant?.callingCode);
  }
  if (data.signatoryMobile) profile.signatoryMobile = data.signatoryMobile;
  if (data.yearsInBusiness !== undefined && data.yearsInBusiness !== '') {
    profile.yearsInBusiness = Number(data.yearsInBusiness);
  }

  const bank = { ...(existing.bank || {}) };
  for (const field of ['accountHolderName', 'bankName', 'branch']) {
    if (data[field] !== undefined && data[field] !== '') bank[field] = data[field];
  }
  if (data.ifsc) bank.ifsc = String(data.ifsc).toUpperCase().trim();
  if (data.accountNumber) {
    bank.accountNumberMasked = privateFiles.maskNumber(data.accountNumber);
    bank.accountNumberSealed = secretbox.seal(String(data.accountNumber).trim());
  }
  profile.bank = bank;

  // §16: a partner without a way to reach them is not a partner.
  if (!profile.primaryContactName && !profile.legalName) throw badRequest('Enter the partner’s name.');
  if (!profile.normalizedMobile) throw badRequest('Enter a valid mobile number.');
  if (!profile.email) throw badRequest('Enter an email address.');
  if (partnerType === 'COMPANY' && !profile.legalName) throw badRequest('Enter the company’s legal name.');
  return profile;
}

const displayNameOf = (profile = {}) => profile.tradeName || profile.legalName || profile.primaryContactName || 'Channel partner';

/* --------------------------- duplicate detection -------------------------- */

/**
 * §216: never auto-merge. Two partners sharing a PAN is a commercial dispute,
 * so the match is surfaced and an admin decides.
 */
async function findDuplicates({ tenantId, profile, excludeRegistrationId = null, excludePartnerId = null }) {
  const checks = [
    ['pan', profile.pan],
    ['gstin', profile.gstin],
    ['normalizedMobile', profile.normalizedMobile],
  ].filter(([, value]) => !!value);
  if (!checks.length) return [];

  const or = checks.map(([field, value]) => ({ [`profile.${field}`]: value }));
  const [partners, registrations] = await Promise.all([
    ChannelPartner.find({
      tenantId, $or: or, ...(excludePartnerId ? { _id: { $ne: excludePartnerId } } : {}),
    }).select('profile status partnerCode').lean(),
    ChannelPartnerRegistration.find({
      tenantId,
      $or: or,
      status: { $nin: ['REJECTED', 'APPROVED'] },
      ...(excludeRegistrationId ? { _id: { $ne: excludeRegistrationId } } : {}),
    }).select('profile status registrationNumber').lean(),
  ]);

  const matchedOn = (candidate) => checks
    .filter(([field, value]) => candidate.profile?.[field] === value)
    .map(([field]) => field);

  return [
    ...partners.map((p) => ({
      channelPartnerId: p._id,
      label: `${displayNameOf(p.profile)} (${p.partnerCode || 'partner'})`,
      matchedOn: matchedOn(p),
    })),
    ...registrations.map((r) => ({
      registrationId: r._id,
      label: `${displayNameOf(r.profile)} (${r.registrationNumber || 'application'}, ${r.status.toLowerCase()})`,
      matchedOn: matchedOn(r),
    })),
  ];
}

/* ------------------------------ registration ----------------------------- */

/** §14: an internal user, an invited partner, or a public self-registration. */
async function createRegistration({
  tenantId, tenant, actor = null, data, submissionSource = 'INTERNAL',
}) {
  if (submissionSource === 'PUBLIC_SELF') {
    const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
    if (!settings.cpPublicRegistrationEnabled) throw forbidden('Public partner registration is not enabled.');
  }
  const profile = buildProfile({ data, tenant });
  const registration = await ChannelPartnerRegistration.create({
    tenantId,
    registrationNumber: await nextNumber({
      tenantId, model: ChannelPartnerRegistration, field: 'registrationNumber', prefix: 'CPR',
    }),
    profile,
    status: 'DRAFT',
    submissionSource,
    completedSteps: [1, 2],
    createdBy: actor?._id,
  });
  await audit.record({
    tenantId, actor, entity: 'ChannelPartnerRegistration', entityId: registration._id, action: 'CREATE',
    after: { registrationNumber: registration.registrationNumber, partnerType: profile.partnerType },
  });
  return registration;
}

/** §15: save one step of the stepper without pretending the whole thing is done. */
async function updateRegistration({ tenantId, tenant, actor, registrationId, data, step = null }) {
  const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
  if (!registration) throw notFound('Registration not found.');
  if (['APPROVED', 'REJECTED'].includes(registration.status)) {
    throw badRequest('This application has already been decided.');
  }
  const profile = buildProfile({ data, tenant, existing: registration.profile });
  const completed = new Set(registration.completedSteps || []);
  if (step) completed.add(Number(step));

  await ChannelPartnerRegistration.updateOne({ tenantId, _id: registrationId }, {
    $set: { profile, completedSteps: [...completed].sort((a, b) => a - b) },
  });
  return ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
}

/** §12/§15 step 7: hand it to the internal reviewer. */
async function submitRegistration({ tenantId, tenant, actor = null, registrationId }) {
  const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
  if (!registration) throw notFound('Registration not found.');
  if (!['DRAFT', 'CORRECTION_REQUIRED'].includes(registration.status)) {
    throw badRequest('This application has already been submitted.');
  }

  const policy = await rera.policyFor({ tenantId, tenant });
  if (policy.required) {
    const certificate = await PartnerReraDocument.findOne({ tenantId, registrationId, active: true }).lean();
    if (!certificate) throw badRequest('A RERA certificate is required before this application can be submitted.');
  }

  // §216: the duplicate check runs at submission, when there is something to check.
  const duplicates = await findDuplicates({
    tenantId, profile: registration.profile, excludeRegistrationId: registration._id,
  });

  await ChannelPartnerRegistration.updateOne({ tenantId, _id: registrationId }, {
    $set: {
      status: 'SUBMITTED',
      submittedAt: new Date(),
      possibleDuplicates: duplicates.map((d) => ({
        channelPartnerId: d.channelPartnerId,
        registrationId: d.registrationId,
        matchedOn: d.matchedOn,
      })),
    },
  });

  emit(EVENTS.CP_REGISTRATION_SUBMITTED, { tenantId, registrationId, duplicates: duplicates.length });
  await notifications.notifyMany({
    tenantId,
    userIds: await notifications.adminUserIds(tenantId),
    domain: 'CHANNEL_PARTNER',
    type: 'CP_REGISTRATION_SUBMITTED',
    title: 'Channel partner application submitted',
    body: `${displayNameOf(registration.profile)}${duplicates.length ? ` · ${duplicates.length} possible duplicate` : ''}`,
    link: `/app/channel-partners/registrations/${registrationId}`,
    severity: duplicates.length ? 'WARNING' : 'INFO',
  });
  return ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
}

/**
 * §13/§186: the review decision. APPROVED is the only path that creates a
 * partner, and it is idempotent — a double click cannot create two partners.
 */
async function reviewRegistration({
  tenantId, tenant, actor, registrationId, decision, note, invite = false,
}) {
  const allowed = ['UNDER_REVIEW', 'CORRECTION_REQUIRED', 'APPROVED', 'REJECTED'];
  if (!allowed.includes(decision)) throw badRequest('Choose a review decision.');
  const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
  if (!registration) throw notFound('Registration not found.');
  if (registration.status === 'APPROVED' && decision === 'APPROVED' && registration.channelPartnerId) {
    return { registration, partner: await ChannelPartner.findOne({ tenantId, _id: registration.channelPartnerId }).lean() };
  }
  if (['APPROVED', 'REJECTED'].includes(registration.status)) {
    throw badRequest('This application has already been decided.');
  }
  if (decision !== 'UNDER_REVIEW' && decision !== 'APPROVED' && !String(note || '').trim()) {
    throw badRequest('Tell the partner what needs to change.');
  }

  const now = new Date();
  const base = {
    status: decision,
    reviewedBy: actor?._id,
    reviewedAt: now,
    reviewNote: note,
  };

  if (decision !== 'APPROVED') {
    await ChannelPartnerRegistration.updateOne({ tenantId, _id: registrationId }, {
      $set: {
        ...base,
        ...(decision === 'CORRECTION_REQUIRED' ? { correctionNote: note } : {}),
        ...(decision === 'REJECTED' ? { rejectionReason: note } : {}),
      },
    });
    if (decision === 'REJECTED') emit(EVENTS.CP_REGISTRATION_REJECTED, { tenantId, registrationId });
    await audit.record({
      tenantId, actor, entity: 'ChannelPartnerRegistration', entityId: registrationId, action: 'REVIEW',
      before: { status: registration.status }, after: { status: decision, note },
    });
    return { registration: await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean(), partner: null };
  }

  /* ---- approval: the application becomes a partner (§13) ---- */
  const policy = await rera.policyFor({ tenantId, tenant });
  const certificate = await PartnerReraDocument.findOne({ tenantId, registrationId, active: true }).lean();
  if (policy.required && !certificate) throw badRequest('This application has no RERA certificate.');
  if (policy.requireVerifiedForActivation && certificate?.verificationStatus !== 'VERIFIED') {
    throw badRequest('Verify the RERA certificate before approving this partner.');
  }

  const partner = await ChannelPartner.create({
    tenantId,
    partnerCode: await nextNumber({ tenantId, model: ChannelPartner, field: 'partnerCode', prefix: 'CP' }),
    profile: registration.profile,
    status: 'ACTIVE',
    registrationId: registration._id,
    activatedAt: now,
    createdBy: actor?._id,
  });

  // The certificate moves from the application to the partner it created.
  if (certificate) {
    await PartnerReraDocument.updateMany({ tenantId, registrationId }, {
      $set: { channelPartnerId: partner._id },
    });
    await rera.syncPartner({ tenantId, channelPartnerId: partner._id });
  }

  await ChannelPartnerRegistration.updateOne({ tenantId, _id: registrationId }, {
    $set: { ...base, channelPartnerId: partner._id, approvedAt: now, approvedBy: actor?._id },
  });

  await timeline.log({
    tenantId,
    channelPartnerId: partner._id,
    type: 'CP_REGISTRATION_APPROVED',
    title: 'Registration approved — partner activated',
    body: note,
    actor,
    meta: { registrationId: String(registrationId), partnerCode: partner.partnerCode },
  });
  emit(EVENTS.CP_REGISTRATION_APPROVED, { tenantId, registrationId, channelPartnerId: partner._id });
  await audit.record({
    tenantId, actor, entity: 'ChannelPartnerRegistration', entityId: registrationId, action: 'APPROVE',
    after: { channelPartnerId: String(partner._id), partnerCode: partner.partnerCode },
  });

  // §308: "Approve & Invite" in one action.
  let portalUser = null;
  if (invite) {
    portalUser = await invitePortalUser({
      tenantId, tenant, actor, channelPartnerId: partner._id,
      name: partner.profile.primaryContactName || displayNameOf(partner.profile),
      email: partner.profile.email,
      mobile: partner.profile.mobile,
      role: partner.profile.partnerType === 'COMPANY' ? 'COMPANY_ADMIN' : 'SALES_MEMBER',
    });
  }
  return { registration: await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean(), partner, portalUser };
}

/* --------------------------- partner lifecycle --------------------------- */

/** §218: suspension stops new business without touching history. */
async function setStatus({ tenantId, actor, channelPartnerId, status, reason }) {
  if (!ChannelPartner.STATUSES.includes(status)) throw badRequest('Choose a valid partner status.');
  const partner = await ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean();
  if (!partner) throw notFound('Channel partner not found.');
  if (status !== 'ACTIVE' && !String(reason || '').trim()) throw badRequest('Give a reason.');

  await ChannelPartner.updateOne({ tenantId, _id: channelPartnerId }, {
    $set: {
      status,
      ...(status === 'SUSPENDED' ? { suspendedAt: new Date(), suspensionReason: reason } : {}),
      ...(status === 'ACTIVE' ? { suspensionReason: undefined } : {}),
    },
  });
  // §218: the portal goes read-only rather than dark, so a partner can still
  // see their own history and invoices.
  if (status !== 'ACTIVE') {
    await PartnerPortalUser.updateMany(
      { tenantId, channelPartnerId, status: 'ACTIVE' },
      { $set: { status: 'SUSPENDED' } },
    );
  } else {
    await PartnerPortalUser.updateMany(
      { tenantId, channelPartnerId, status: 'SUSPENDED' },
      { $set: { status: 'ACTIVE' } },
    );
  }

  await timeline.log({
    tenantId,
    channelPartnerId,
    type: status === 'ACTIVE' ? 'CP_PARTNER_ACTIVATED' : 'CP_PARTNER_SUSPENDED',
    title: `Partner ${status.toLowerCase()}`,
    body: reason,
    actor,
    meta: { from: partner.status, to: status },
  });
  await audit.record({
    tenantId, actor, entity: 'ChannelPartner', entityId: channelPartnerId, action: 'SET_STATUS',
    before: { status: partner.status }, after: { status, reason },
  });
  return ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean();
}

/* -------------------------------- team ---------------------------------- */

/** §22/§23: company team members and what each may do in the portal. */
async function saveMember({ tenantId, tenant, actor, channelPartnerId, memberId = null, data }) {
  const partner = await ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean();
  if (!partner) throw notFound('Channel partner not found.');
  if (!String(data.name || '').trim()) throw badRequest('Enter the member’s name.');

  const payload = {
    name: String(data.name).trim(),
    mobile: data.mobile,
    normalizedMobile: data.mobile ? phone.normalizeMobile(data.mobile, tenant?.callingCode) : undefined,
    email: data.email ? String(data.email).toLowerCase().trim() : undefined,
    designation: data.designation,
    portalRole: ChannelPartnerMember.PORTAL_ROLES.includes(data.portalRole) ? data.portalRole : 'SALES_MEMBER',
    reraNumber: data.reraNumber,
    canSubmitLeads: data.canSubmitLeads !== false,
    canViewCompanyLeads: !!data.canViewCompanyLeads,
    canCreateInvoice: !!data.canCreateInvoice,
    portalLoginEnabled: !!data.portalLoginEnabled,
  };

  let member;
  if (memberId) {
    member = await ChannelPartnerMember.findOne({ tenantId, _id: memberId, channelPartnerId });
    if (!member) throw notFound('Team member not found.');
    Object.assign(member, payload);
    await member.save();
  } else {
    member = await ChannelPartnerMember.create({
      tenantId, channelPartnerId, ...payload, createdBy: actor?._id,
    });
  }

  await timeline.log({
    tenantId,
    channelPartnerId,
    type: 'CP_TEAM_CHANGED',
    title: `${memberId ? 'Updated' : 'Added'} team member ${member.name}`,
    actor,
    meta: { memberId: String(member._id), portalRole: member.portalRole },
  });
  // §196: team access changes are audited.
  await audit.record({
    tenantId, actor, entity: 'ChannelPartnerMember', entityId: member._id,
    action: memberId ? 'UPDATE' : 'CREATE', after: payload,
  });
  return member;
}

/** §219: an exited member keeps their history and loses their access. */
async function setMemberActive({ tenantId, actor, memberId, active }) {
  const member = await ChannelPartnerMember.findOne({ tenantId, _id: memberId });
  if (!member) throw notFound('Team member not found.');
  member.active = !!active;
  member.exitedAt = active ? undefined : new Date();
  if (!active) member.portalLoginEnabled = false;
  await member.save();

  if (!active) {
    await PartnerPortalUser.updateMany(
      { tenantId, channelPartnerMemberId: memberId },
      { $set: { status: 'INACTIVE' } },
    );
  }
  await timeline.log({
    tenantId,
    channelPartnerId: member.channelPartnerId,
    type: 'CP_TEAM_CHANGED',
    title: `${member.name} ${active ? 'reactivated' : 'deactivated'}`,
    body: active ? undefined : 'Their submitted leads stay under their name.',
    actor,
    meta: { memberId: String(memberId), active: !!active },
  });
  await audit.record({
    tenantId, actor, entity: 'ChannelPartnerMember', entityId: memberId,
    action: active ? 'ACTIVATE' : 'DEACTIVATE',
  });
  return member;
}

/* --------------------------- portal invitations -------------------------- */

/** §24/§308: create the partner's own login and send them an activation link. */
async function invitePortalUser({
  tenantId, tenant, actor, channelPartnerId, memberId = null, name, email, mobile, role = 'SALES_MEMBER',
}) {
  const partner = await ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean();
  if (!partner) throw notFound('Channel partner not found.');
  const cleanEmail = String(email || '').toLowerCase().trim();
  if (!cleanEmail) throw badRequest('An email address is needed to invite a portal user.');

  const existing = await PartnerPortalUser.findOne({ tenantId, email: cleanEmail }).lean();
  if (existing && String(existing.channelPartnerId) !== String(channelPartnerId)) {
    throw conflict('That email already has a partner portal login with another partner.');
  }

  // Same token scheme as internal invites: raw to the user, hash to the database.
  const { raw: token, hash: tokenHash } = require('../lib/password').newToken();
  const payload = {
    tenantId,
    channelPartnerId,
    channelPartnerMemberId: memberId,
    name: name || partner.profile.primaryContactName || 'Partner user',
    email: cleanEmail,
    mobile,
    normalizedMobile: mobile ? phone.normalizeMobile(mobile, tenant?.callingCode) : undefined,
    role: PartnerPortalUser.ROLES.includes(role) ? role : 'SALES_MEMBER',
    status: 'INVITED',
    inviteTokenHash: tokenHash,
    inviteExpiresAt: new Date(Date.now() + 7 * 86400000),
    createdBy: actor?._id,
  };

  const portalUser = existing
    ? await PartnerPortalUser.findOneAndUpdate({ tenantId, _id: existing._id }, { $set: payload }, { returnDocument: 'after' }).lean()
    : await PartnerPortalUser.create(payload);

  const config = require('../config');
  const url = `${config.appUrl.replace(/\/$/, '')}/cp/activate/${token}`;
  await messaging.send({
    tenantId,
    channel: 'EMAIL',
    contact: { email: cleanEmail, firstName: payload.name, displayName: payload.name },
    purpose: 'ACKNOWLEDGEMENT',
    subject: 'Your partner portal access',
    body: `Hello ${payload.name}, your channel partner portal access is ready. Set your password here: ${url}`,
    sentBy: actor?._id,
  });
  if (memberId) {
    await ChannelPartnerMember.updateOne({ tenantId, _id: memberId }, { $set: { portalLoginEnabled: true } });
  }

  await timeline.log({
    tenantId,
    channelPartnerId,
    type: 'CP_PORTAL_INVITED',
    title: `Portal invitation sent to ${cleanEmail}`,
    actor,
    meta: { portalUserId: String(portalUser._id), role: payload.role },
  });
  await audit.record({
    tenantId, actor, entity: 'PartnerPortalUser', entityId: portalUser._id, action: 'INVITE',
    after: { email: cleanEmail, role: payload.role },
  });
  // The token is returned once, for the "copy link" affordance.
  return { portalUser, token, url };
}

/* ------------------------- project empanelment -------------------------- */

/** §25/§26: which projects this partner may sell. */
async function saveEmpanelment({
  tenantId, actor, channelPartnerId, projectId, status = 'PENDING', effectiveFrom, effectiveTo,
  commissionRuleId, notes,
}) {
  const [partner, project] = await Promise.all([
    ChannelPartner.findOne({ tenantId, _id: channelPartnerId }).lean(),
    Project.findOne({ tenantId, _id: projectId }).lean(),
  ]);
  if (!partner) throw notFound('Channel partner not found.');
  if (!project) throw badRequest('Choose a project in this organization.');
  if (project.channelPartnerEnabled === false) {
    throw badRequest(`${project.name} is not open to channel partners.`);
  }
  if (!PartnerProjectEmpanelment.STATUSES.includes(status)) throw badRequest('Choose a valid empanelment status.');

  const set = {
    status,
    effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : undefined,
    effectiveTo: effectiveTo ? new Date(effectiveTo) : undefined,
    commissionRuleId: commissionRuleId || undefined,
    notes,
    ...(status === 'APPROVED' ? { approvedBy: actor?._id, approvedAt: new Date() } : {}),
  };
  const before = await PartnerProjectEmpanelment.findOne({ tenantId, channelPartnerId, projectId }).lean();
  const empanelment = await PartnerProjectEmpanelment.findOneAndUpdate(
    { tenantId, channelPartnerId, projectId },
    { $set: set, $setOnInsert: { tenantId, channelPartnerId, projectId, createdBy: actor?._id } },
    { upsert: true, returnDocument: 'after' },
  ).lean();

  await timeline.log({
    tenantId,
    channelPartnerId,
    type: 'CP_EMPANELMENT_CHANGED',
    title: `${project.name} — empanelment ${status.toLowerCase()}`,
    body: notes,
    actor,
    meta: { projectId: String(projectId), from: before?.status, to: status },
  });
  // §196: empanelment decisions are audited.
  await audit.record({
    tenantId, actor, entity: 'PartnerProjectEmpanelment', entityId: empanelment._id, action: 'UPSERT',
    before: before ? { status: before.status } : undefined, after: { status, projectId: String(projectId) },
  });
  return empanelment;
}

/**
 * §26/§307: may this partner submit for this project right now? Returns null
 * when they may, or the reason they may not.
 */
async function empanelmentBlock({ tenantId, tenant, partner, projectId, now = new Date() }) {
  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
  if (!settings.cpRequireProjectEmpanelment) return null;
  if (!projectId) return 'Choose a project.';

  const project = await Project.findOne({ tenantId, _id: projectId }).select('name channelPartnerEnabled').lean();
  if (!project) return 'That project does not exist.';
  if (project.channelPartnerEnabled === false) return `${project.name} is not open to channel partners.`;

  const empanelment = await PartnerProjectEmpanelment.findOne({
    tenantId, channelPartnerId: partner._id, projectId,
  });
  if (!empanelment) return `This partner is not empanelled for ${project.name}.`;
  if (!empanelment.isLive(now)) {
    return empanelment.status === 'APPROVED'
      ? `The empanelment for ${project.name} is not in effect today.`
      : `The empanelment for ${project.name} is ${empanelment.status.toLowerCase()}.`;
  }
  return null;
}

/* --------------------------------- reads -------------------------------- */

async function get({ tenantId, channelPartnerId }) {
  const partner = await ChannelPartner.findOne({ tenantId, _id: channelPartnerId })
    .populate('ownerUserId', 'name')
    .lean();
  if (!partner) throw notFound('Channel partner not found.');
  return partner;
}

/** Everything the partner workspace needs, in one read (§27/§28). */
async function workspace({ tenantId, channelPartnerId, zone = 'UTC', locale = 'en-IN' }) {
  const partner = await get({ tenantId, channelPartnerId });
  const [members, empanelments, reraHistory, claims, entitlements, invoices, events] = await Promise.all([
    ChannelPartnerMember.find({ tenantId, channelPartnerId }).sort({ active: -1, name: 1 }).lean(),
    PartnerProjectEmpanelment.find({ tenantId, channelPartnerId })
      .populate('projectId', 'name').populate('commissionRuleId', 'name').lean(),
    rera.historyFor({ tenantId, channelPartnerId }),
    PartnerLeadClaim.find({ tenantId, channelPartnerId }).sort({ submittedAt: -1 }).limit(100)
      .populate('projectId', 'name').populate('leadId', 'stageId status').lean(),
    PartnerCommissionEntitlement.find({ tenantId, channelPartnerId })
      .populate('bookingId', 'bookingNumber finalPriceMinor totalReceivedMinor scheduledTotalMinor contactId')
      .populate('projectId', 'name').lean(),
    PartnerInvoice.find({ tenantId, channelPartnerId }).sort({ createdAt: -1 }).lean(),
    timeline.forPartner({ tenantId, channelPartnerId, limit: 60 }),
  ]);

  const portalUsers = await PartnerPortalUser.find({ tenantId, channelPartnerId })
    .select('name email role status lastLoginAt').lean();

  return {
    partner,
    members,
    empanelments,
    reraHistory,
    claims,
    entitlements,
    invoices,
    portalUsers,
    events,
    reraBanner: rera.expiryBanner({ partner, zone, locale }),
  };
}

/** §12: the registration list, with its filters. */
async function listRegistrations({ tenantId, query = {}, page = 1, limit = 25, zone = 'UTC' }) {
  const filter = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.partnerType) filter['profile.partnerType'] = query.partnerType;
  if (query.city) filter['profile.city'] = new RegExp(String(query.city).trim(), 'i');
  if (query.q) {
    const term = new RegExp(String(query.q).trim(), 'i');
    filter.$or = [
      { registrationNumber: term },
      { 'profile.legalName': term },
      { 'profile.tradeName': term },
      { 'profile.primaryContactName': term },
      { 'profile.normalizedMobile': new RegExp(String(query.q).replace(/\D/g, '')) },
    ];
  }
  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    ChannelPartnerRegistration.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('reviewedBy', 'name').populate('channelPartnerId', 'partnerCode status').lean(),
    ChannelPartnerRegistration.countDocuments(filter),
  ]);

  // The RERA position lives on its certificate, so fetch it for the list.
  const ids = items.map((i) => i._id);
  const certificates = await PartnerReraDocument.find({ tenantId, registrationId: { $in: ids }, active: true }).lean();
  const byRegistration = new Map(certificates.map((c) => [String(c.registrationId), c]));
  const empanelments = await PartnerProjectEmpanelment.find({
    tenantId, channelPartnerId: { $in: items.map((i) => i.channelPartnerId).filter(Boolean) },
  }).select('channelPartnerId').lean();

  return {
    items: items.map((item) => ({
      ...item,
      rera: byRegistration.get(String(item._id)) || null,
      empanelmentCount: empanelments.filter((e) => String(e.channelPartnerId) === String(item.channelPartnerId)).length,
    })),
    total,
    page: Number(page),
    pages: Math.ceil(total / limit) || 1,
    limit,
  };
}

/** §8/§9: the partner list, with the RERA and expiry filters that matter. */
async function listPartners({ tenantId, query = {}, page = 1, limit = 25, now = new Date() }) {
  const filter = { tenantId };
  if (query.status) filter.status = query.status;
  if (query.partnerType) filter['profile.partnerType'] = query.partnerType;
  if (query.reraStatus) filter.reraStatus = query.reraStatus;
  if (query.city) filter['profile.city'] = new RegExp(String(query.city).trim(), 'i');
  if (query.expiringDays) {
    const days = Number(query.expiringDays);
    filter.reraExpiryDate = { $ne: null, $lte: new Date(now.getTime() + days * 86400000) };
  }
  if (query.q) {
    const term = new RegExp(String(query.q).trim(), 'i');
    filter.$or = [
      { partnerCode: term },
      { reraNumber: term },
      { 'profile.legalName': term },
      { 'profile.tradeName': term },
      { 'profile.primaryContactName': term },
      { 'profile.normalizedMobile': new RegExp(String(query.q).replace(/\D/g, '')) },
    ];
  }

  const skip = (Math.max(1, Number(page)) - 1) * limit;
  const [items, total] = await Promise.all([
    ChannelPartner.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ChannelPartner.countDocuments(filter),
  ]);
  return { items, total, page: Number(page), pages: Math.ceil(total / limit) || 1, limit };
}

module.exports = {
  STEP_COUNT, buildProfile, displayNameOf, findDuplicates, nextNumber,
  createRegistration, updateRegistration, submitRegistration, reviewRegistration,
  setStatus, saveMember, setMemberActive, invitePortalUser,
  saveEmpanelment, empanelmentBlock, get, workspace, listRegistrations, listPartners,
};
