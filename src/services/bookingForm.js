const crypto = require('node:crypto');
const {
  Booking, BookingCustomerLink, BookingApplicant, Contact, CostSheet, Project, Unit, User, Tenant,
} = require('../db/models');
const { badRequest, notFound, forbidden } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const config = require('../config');
const phone = require('../lib/phone');
const privateFiles = require('../lib/privateFiles');
const secretbox = require('../lib/secretbox');
const tzLib = require('../lib/tz');
const installmentsService = require('./installments');
const kyc = require('./kyc');
const timeline = require('./timeline');
const messaging = require('./messaging');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §116–§124 + §164: the one customer-facing page for a booking.
 *
 * The hard boundary (§118, §324.2): the customer may declare who is buying and
 * upload their documents. They can never touch a commercial field — unit,
 * price, quotation or payment plan. Those are not on the form at all, and the
 * submit handler reads only from an allowlist, so adding a field to the HTML
 * cannot open a hole.
 */

const SECTIONS = ['APPLICANTS', 'KYC'];

/** §117: unguessable, single-copy token. Only its hash is stored. */
function mintToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: BookingCustomerLink.hash(token) };
}

const linkUrl = (token) => `${config.appUrl.replace(/\/$/, '')}/booking-form/${token}`;

/**
 * §116/§288: prepare the link. Any earlier usable link — active OR already
 * submitted — is closed first. Two live links to one booking means two versions
 * of the truth in two WhatsApp threads, and the newest one is the truth.
 */
async function createLink({ tenantId, tenant, actor, bookingId, sections = [] }) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  if (booking.status === 'CANCELLED') throw badRequest('This booking is cancelled.');

  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
  const days = Number(settings.bookingLinkExpiryDays || 7);
  const otpRequired = !!settings.bookingLinkRequireOtp;

  await BookingCustomerLink.updateMany(
    { tenantId, bookingId, status: { $in: ['ACTIVE', 'SUBMITTED'] } },
    { $set: { status: 'REVOKED', revokedAt: new Date(), revokedBy: actor?._id } },
  );

  const { token, tokenHash } = mintToken();
  const link = await BookingCustomerLink.create({
    tenantId,
    bookingId,
    tokenHash,
    expiresAt: new Date(Date.now() + days * 86400000),
    otpRequired,
    reopenSections: sections.filter((s) => SECTIONS.includes(s)),
    createdBy: actor?._id,
  });

  await timeline.log({
    tenantId,
    bookingId,
    type: 'CUSTOMER_LINK_CREATED',
    title: 'Customer form link generated',
    body: `Valid until ${tzLib.formatDate(link.expiresAt, tenant?.timezone || 'UTC')}.`,
    actor,
    meta: { linkId: String(link._id), otpRequired, sections: link.reopenSections },
  });
  await audit.record({
    tenantId, actor, entity: 'BookingCustomerLink', entityId: link._id, action: 'CREATE',
    after: { bookingId: String(bookingId), expiresAt: link.expiresAt, otpRequired },
  });
  emit(EVENTS.BOOKING_CUSTOMER_LINK_CREATED, { tenantId, bookingId, linkId: link._id });

  // The token is returned exactly once — it is not recoverable from the record.
  return { link, token, url: linkUrl(token) };
}

/** §116: hand the link to the customer over WhatsApp or email. */
async function sendLink({
  tenantId, tenant, actor, bookingId, token, channel = 'WHATSAPP', templateId,
}) {
  const link = await BookingCustomerLink.findOne({ tenantId, bookingId, status: 'ACTIVE' }).lean();
  if (!link) throw badRequest('Generate a customer link first.');
  if (!token) throw badRequest('The link can only be sent right after it is generated. Generate a new one.');
  if (BookingCustomerLink.hash(token) !== link.tokenHash) throw badRequest('That link is no longer current.');

  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  const [contact, project, unit] = await Promise.all([
    Contact.findOne({ tenantId, _id: booking.contactId }).lean(),
    Project.findOne({ tenantId, _id: booking.projectId }).select('name').lean(),
    Unit.findOne({ tenantId, _id: booking.unitId }).select('unitNumber').lean(),
  ]);

  const url = linkUrl(token);
  const vars = {
    contact: { first_name: contact?.firstName || contact?.displayName, full_name: contact?.displayName },
    booking: { number: booking.bookingNumber, customer_form_url: url },
    project: { name: project?.name },
    unit: { number: unit?.unitNumber },
  };
  const result = await messaging.send({
    tenantId,
    channel,
    contact,
    purpose: 'ACKNOWLEDGEMENT',
    templateId,
    body: templateId ? undefined : `Hello {{contact.first_name|there}}, please complete your booking form for {{project.name}} {{unit.number}}: {{booking.customer_form_url}}`,
    subject: templateId ? undefined : `Booking form — ${project?.name || ''}`.trim(),
    vars,
    sentBy: actor?._id,
  });

  await BookingCustomerLink.updateOne({ tenantId, _id: link._id }, {
    $set: { sentAt: new Date(), sentChannel: channel },
  });
  await timeline.log({
    tenantId,
    bookingId,
    type: 'CUSTOMER_LINK_SENT',
    title: `Customer form link sent by ${channel.toLowerCase()}`,
    actor,
    meta: { linkId: String(link._id), channel, messageStatus: result?.status },
  });
  return result;
}

async function revokeLink({ tenantId, actor, bookingId }) {
  const link = await BookingCustomerLink.findOne({ tenantId, bookingId, status: 'ACTIVE' });
  if (!link) throw badRequest('There is no active customer link to revoke.');
  link.status = 'REVOKED';
  link.revokedAt = new Date();
  link.revokedBy = actor?._id;
  await link.save();
  await timeline.log({
    tenantId, bookingId, type: 'CUSTOMER_LINK_REVOKED',
    title: 'Customer form link revoked', actor, meta: { linkId: String(link._id) },
  });
  await audit.record({
    tenantId, actor, entity: 'BookingCustomerLink', entityId: link._id, action: 'REVOKE',
  });
  return link;
}

/**
 * §117/§192: resolve a token from the URL. Every failure gives the same kind of
 * plain answer — a probe learns whether a token is live, which it would anyway
 * by trying it, but never anything about the booking behind it.
 */
async function resolveToken({ token, now = new Date() }) {
  if (!token || String(token).length < 20) throw notFound('This booking link is not valid.');
  const link = await BookingCustomerLink.findOne({ tokenHash: BookingCustomerLink.hash(token) })
    .setOptions({ allowCrossTenant: true }).lean();
  if (!link) throw notFound('This booking link is not valid.');

  if (link.status === 'REVOKED') {
    throw forbidden('This booking link is no longer active. Contact your sales representative for a new link.');
  }
  if (link.status !== 'SUBMITTED' && new Date(link.expiresAt) < now) {
    await BookingCustomerLink.updateOne({ tenantId: link.tenantId, _id: link._id }, { $set: { status: 'EXPIRED' } });
    throw forbidden('This booking link has expired. Contact your sales representative for a new link.');
  }
  if (link.status === 'EXPIRED') {
    throw forbidden('This booking link has expired. Contact your sales representative for a new link.');
  }
  return link;
}

/** §117: OTP, when the tenant asks for it. Verified against the booking mobile. */
async function sendOtp({ token, now = new Date() }) {
  const link = await resolveToken({ token, now });
  if (!link.otpRequired) return { required: false };
  const booking = await Booking.findOne({ tenantId: link.tenantId, _id: link.bookingId }).lean();
  const contact = await Contact.findOne({ tenantId: link.tenantId, _id: booking.contactId }).lean();
  if (!contact?.normalizedMobile) throw badRequest('This booking has no mobile number on file. Contact your sales representative.');

  const code = String(crypto.randomInt(100000, 999999));
  await BookingCustomerLink.updateOne({ tenantId: link.tenantId, _id: link._id }, {
    $set: {
      otpHash: BookingCustomerLink.hash(code),
      otpExpiresAt: new Date(now.getTime() + 10 * 60000),
      otpAttempts: 0,
    },
    $unset: { otpVerifiedAt: '' },
  });
  await messaging.send({
    tenantId: link.tenantId,
    channel: 'SMS',
    contact,
    purpose: 'ACKNOWLEDGEMENT',
    body: `Your booking form verification code is ${code}. It expires in 10 minutes.`,
  });
  return { required: true, sentTo: privateFiles.maskNumber(contact.normalizedMobile) };
}

async function verifyOtp({ token, code, now = new Date() }) {
  const link = await resolveToken({ token, now });
  if (!link.otpRequired) return { verified: true };
  if (!link.otpHash || !link.otpExpiresAt || new Date(link.otpExpiresAt) < now) {
    throw badRequest('That code has expired. Ask for a new one.');
  }
  // §192: a six-digit code needs a hard attempt ceiling or it is a four-hour
  // brute force, not a verification.
  if (link.otpAttempts >= 5) throw forbidden('Too many incorrect codes. Ask for a new one.');
  if (BookingCustomerLink.hash(String(code || '')) !== link.otpHash) {
    await BookingCustomerLink.updateOne({ tenantId: link.tenantId, _id: link._id }, { $inc: { otpAttempts: 1 } });
    throw badRequest('That code is not correct.');
  }
  await BookingCustomerLink.updateOne({ tenantId: link.tenantId, _id: link._id }, {
    $set: { otpVerifiedAt: now }, $unset: { otpHash: '', otpExpiresAt: '' },
  });
  return { verified: true };
}

/**
 * §164/§269: everything the customer may see, and nothing else. Internal
 * collection notes, aging, promises and commissions are not assembled here at
 * all — they cannot leak from a view model that never loads them.
 */
async function customerView({ link, now = new Date() }) {
  const tenantId = link.tenantId;
  const booking = await Booking.findOne({ tenantId, _id: link.bookingId })
    .populate('projectId', 'name city')
    .populate('unitId', 'unitNumber floorNumber saleableArea')
    .populate('salespersonId', 'name mobile email')
    .lean();
  if (!booking) throw notFound('This booking link is not valid.');

  const [tenant, contact, quotation, applicants, checklist, installments] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName firstName primaryMobile email').lean(),
    booking.costSheetId
      ? CostSheet.findOne({ tenantId, _id: booking.costSheetId })
        .select('quotationNumber version finalConsiderationMinor paymentPlanName shareToken').lean()
      : null,
    BookingApplicant.find({ tenantId, bookingId: booking._id }).sort({ displayOrder: 1, createdAt: 1 }).lean(),
    kyc.checklist({ tenantId, bookingId: booking._id }),
    installmentsService.forBooking({ tenantId, bookingId: booking._id }),
  ]);
  const zone = tenant?.timezone || 'UTC';

  const { PaymentRequest } = require('../db/models');
  const openLinks = await PaymentRequest.find({
    tenantId, bookingId: booking._id, status: { $in: ['CREATED', 'SENT', 'OPEN'] },
  }).select('amountMinor installmentId paymentUrl status expiresAt').lean();

  return {
    link,
    tenant,
    zone,
    contact,
    // §118: read-only commercial facts.
    commercial: {
      bookingNumber: booking.bookingNumber,
      project: booking.projectId,
      unit: booking.unitId,
      bookingDate: booking.bookingDate,
      finalPriceMinor: booking.finalPriceMinor,
      bookingAmountMinor: booking.bookingAmountMinor,
      paymentPlanName: booking.paymentPlanName,
      quotation,
      salesContact: booking.salespersonId,
    },
    // §138/§269: paid, outstanding, next due. No aging, no notes, no promises.
    payment: {
      totalReceivedMinor: booking.totalReceivedMinor,
      outstandingMinor: booking.outstandingMinor,
      nextDueAt: booking.nextDueAt,
      nextDueAmountMinor: booking.nextDueAmountMinor,
      installments: installments.map((i) => ({
        sequence: i.sequence,
        milestone: i.milestone,
        scheduledAmountMinor: i.scheduledAmountMinor,
        amountReceivedMinor: i.amountReceivedMinor,
        outstandingMinor: i.outstandingMinor,
        dueDate: installmentsService.dueDateOf(i),
        status: i.status,
        paymentUrl: openLinks.find((p) => String(p.installmentId) === String(i._id))?.paymentUrl || null,
        paymentAmountMinor: openLinks.find((p) => String(p.installmentId) === String(i._id))?.amountMinor || null,
      })),
    },
    applicants,
    checklist,
    kycStatus: booking.kycStatus,
    submitted: link.status === 'SUBMITTED',
    editable: link.status === 'ACTIVE',
    sections: link.reopenSections?.length ? link.reopenSections : SECTIONS,
  };
}

/** The fields a customer is allowed to send. Anything else is ignored outright. */
const INDIVIDUAL_FIELDS = [
  'name', 'mobile', 'email', 'dateOfBirth', 'occupation', 'employerName', 'nationality',
  'maritalStatus', 'relationship', 'permanentAddress', 'correspondenceAddress',
  'city', 'state', 'pincode', 'fundingType', 'loanBank',
];
const COMPANY_FIELDS = [
  'companyLegalName', 'gstin', 'cin', 'registeredAddress',
  'signatoryName', 'signatoryMobile', 'signatoryEmail',
];

function applicantPayload({ raw, tenant, role }) {
  const out = { applicantRole: role, type: raw.type === 'COMPANY' ? 'COMPANY' : 'INDIVIDUAL' };
  for (const field of [...INDIVIDUAL_FIELDS, ...COMPANY_FIELDS]) {
    if (raw[field] !== undefined && raw[field] !== '') out[field] = raw[field];
  }
  if (out.dateOfBirth) out.dateOfBirth = new Date(out.dateOfBirth);
  if (out.mobile) out.normalizedMobile = phone.normalizeMobile(out.mobile, tenant?.callingCode);
  // §131: PAN is masked for display and sealed for storage — never stored plain.
  if (raw.pan) {
    out.panMasked = privateFiles.maskNumber(raw.pan);
    out.panSealed = secretbox.seal(String(raw.pan).toUpperCase());
  }
  if (!out.name && out.companyLegalName) out.name = out.companyLegalName;
  return out;
}

/**
 * §119–§124: the customer's submission. Applicants are replaced wholesale for
 * the roles the customer may edit; KYC documents are untouched here — they
 * arrive one at a time through their own upload route.
 */
async function submit({
  token, body, ip, userAgent, now = new Date(),
}) {
  const link = await resolveToken({ token, now });
  if (link.status === 'SUBMITTED') throw badRequest('This form has already been submitted.');
  if (link.otpRequired && !link.otpVerifiedAt) throw forbidden('Verify the code sent to your mobile first.');

  const tenantId = link.tenantId;
  const booking = await Booking.findOne({ tenantId, _id: link.bookingId }).lean();
  if (!booking) throw notFound('This booking link is not valid.');
  if (booking.status === 'CANCELLED') throw forbidden('This booking is no longer active.');
  const tenant = await Tenant.findById(tenantId).lean();

  if (!body?.declaration) throw badRequest('Please confirm that the information is correct.');
  const primaryRaw = body.primary || {};
  if (!String(primaryRaw.name || '').trim()) throw badRequest('Enter the primary applicant’s full name.');
  if (!String(primaryRaw.mobile || '').trim()) throw badRequest('Enter the primary applicant’s mobile number.');

  const primary = applicantPayload({ raw: primaryRaw, tenant, role: 'PRIMARY' });
  const coApplicants = (Array.isArray(body.coApplicants) ? body.coApplicants : [])
    .filter((c) => String(c?.name || '').trim())
    .slice(0, 5)
    .map((raw, index) => ({
      ...applicantPayload({ raw, tenant, role: 'CO_APPLICANT' }),
      displayOrder: index + 1,
    }));

  // Replace the applicant set the customer owns. Existing KYC documents point at
  // applicant ids, so the primary applicant is updated in place rather than
  // recreated — deleting it would orphan its documents.
  const existingPrimary = await BookingApplicant.findOne({ tenantId, bookingId: booking._id, applicantRole: 'PRIMARY' });
  if (existingPrimary) {
    Object.assign(existingPrimary, primary, { updatedByType: 'CUSTOMER' });
    await existingPrimary.save();
  } else {
    await BookingApplicant.create({
      tenantId, bookingId: booking._id, ...primary, displayOrder: 0, updatedByType: 'CUSTOMER',
    });
  }

  const existingCo = await BookingApplicant.find({
    tenantId, bookingId: booking._id, applicantRole: 'CO_APPLICANT',
  }).lean();
  const keep = [];
  for (const [index, payload] of coApplicants.entries()) {
    const match = existingCo[index];
    if (match) {
      await BookingApplicant.updateOne({ tenantId, _id: match._id }, {
        $set: { ...payload, updatedByType: 'CUSTOMER' },
      });
      keep.push(String(match._id));
    } else {
      const created = await BookingApplicant.create({
        tenantId, bookingId: booking._id, ...payload, updatedByType: 'CUSTOMER',
      });
      keep.push(String(created._id));
    }
  }
  // A co-applicant the customer removed, and who carries no documents, goes.
  for (const stale of existingCo.filter((c) => !keep.includes(String(c._id)))) {
    const { BookingKycDocument } = require('../db/models');
    const docs = await BookingKycDocument.countDocuments({ tenantId, bookingApplicantId: stale._id });
    if (!docs) await BookingApplicant.deleteOne({ tenantId, _id: stale._id });
  }

  // §124: the declaration, with what the law may later want to see.
  await BookingCustomerLink.updateOne({ tenantId, _id: link._id }, {
    $set: {
      status: 'SUBMITTED',
      submittedAt: now,
    },
  });
  await Booking.updateOne({ tenantId, _id: booking._id }, {
    $set: {
      customerFormSubmittedAt: now,
      customerDeclaration: {
        confirmedAt: now,
        ip: ip || undefined,
        userAgent: userAgent ? String(userAgent).slice(0, 300) : undefined,
        formVersion: 'v2.0',
      },
    },
  });

  await timeline.log({
    tenantId,
    bookingId: booking._id,
    type: 'BOOKING_FORM_SUBMITTED',
    title: 'Customer submitted the booking form',
    actorType: 'INTEGRATION',
    actorLabel: 'Customer',
    at: now,
    meta: { linkId: String(link._id), coApplicants: coApplicants.length },
  });
  await kyc.rollup({ tenantId, bookingId: booking._id, tz: tenant?.timezone || 'UTC' });
  emit(EVENTS.BOOKING_FORM_SUBMITTED, { tenantId, bookingId: booking._id });

  const contact = await Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName').lean();
  await notifications.notifyMany({
    tenantId,
    userIds: [booking.collectionOwnerUserId, booking.salespersonId].filter(Boolean),
    domain: 'BOOKING',
    type: 'BOOKING_FORM_SUBMITTED',
    title: 'Booking form submitted',
    body: `${contact?.displayName || 'The customer'} completed their booking form.`,
    link: `/app/bookings/${booking._id}?tab=customer`,
    bookingId: booking._id,
  });
  return { bookingId: booking._id };
}

/**
 * §118: "this is wrong" from the customer becomes an internal note on the
 * booking. It never edits a commercial field.
 */
async function reportIssue({ token, message, now = new Date() }) {
  const link = await resolveToken({ token, now });
  if (!String(message || '').trim()) throw badRequest('Tell us what looks wrong.');
  const booking = await Booking.findOne({ tenantId: link.tenantId, _id: link.bookingId }).lean();

  await timeline.log({
    tenantId: link.tenantId,
    bookingId: link.bookingId,
    type: 'BOOKING_FORM_ISSUE_REPORTED',
    title: 'Customer reported an issue with the booking details',
    body: String(message).slice(0, 2000),
    actorType: 'INTEGRATION',
    actorLabel: 'Customer',
    at: now,
  });
  await notifications.notifyMany({
    tenantId: link.tenantId,
    userIds: [booking?.salespersonId, booking?.collectionOwnerUserId].filter(Boolean),
    domain: 'BOOKING',
    type: 'BOOKING_FORM_ISSUE',
    title: 'Customer reported an issue',
    body: String(message).slice(0, 200),
    link: `/app/bookings/${link.bookingId}?tab=timeline`,
    bookingId: link.bookingId,
    severity: 'WARNING',
  });
  return { ok: true };
}

/**
 * §289: reopen for correction. Approved data survives — only the sections named
 * become editable again, and a fresh token is minted for the customer.
 */
async function reopen({ tenantId, tenant, actor, bookingId, sections = SECTIONS, reason }) {
  if (!String(reason || '').trim()) throw badRequest('Say what the customer needs to correct.');
  const result = await createLink({ tenantId, tenant, actor, bookingId, sections });
  await timeline.log({
    tenantId,
    bookingId,
    type: 'BOOKING_FORM_REOPENED',
    title: 'Booking form reopened for correction',
    body: reason,
    actor,
    meta: { sections, linkId: String(result.link._id) },
  });
  return result;
}

/** Current link state for the workspace card (§288). */
async function statusFor({ tenantId, bookingId }) {
  const link = await BookingCustomerLink.findOne({ tenantId, bookingId })
    .sort({ createdAt: -1 })
    .populate('createdBy', 'name')
    .lean();
  if (!link) return { state: 'NOT_SENT', link: null };
  if (link.status === 'ACTIVE' && new Date(link.expiresAt) < new Date()) {
    return { state: 'EXPIRED', link };
  }
  return { state: link.status, link };
}

module.exports = {
  SECTIONS, createLink, sendLink, revokeLink, resolveToken, sendOtp, verifyOtp,
  customerView, submit, reportIssue, reopen, statusFor, linkUrl,
};
