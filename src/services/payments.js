const crypto = require('node:crypto');
const {
  Booking, BookingInstallment, PaymentRequest, Integration, Contact, Project, Unit, Tenant, WebhookEvent,
} = require('../db/models');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const config = require('../config');
const money = require('../lib/money');
const secretbox = require('../lib/secretbox');
const installmentsService = require('./installments');
const timeline = require('./timeline');
const messaging = require('./messaging');
const audit = require('./audit');

/**
 * V2 §139–§142: payment links.
 *
 * The rule that shapes everything here (§344.26): creating a link is NOT a
 * payment. Nothing in this file moves an installment or a booking total — only
 * a confirmed receipt does that, through services/receipts.
 *
 * Providers plug in as drivers, exactly like messaging. The shipped driver is
 * `mock`: it mints a link on our own domain and records the same states a live
 * gateway reports, so the whole flow — create, send, callback, receipt — is
 * real and testable before any credentials exist.
 */

const DRIVERS = {
  /**
   * No gateway configured. The "link" is a page on this app showing the amount
   * and status; the payment itself is recorded by a collections user (§143), or
   * simulated in a non-production install to exercise the callback path.
   */
  async mock({ paymentRequest, token }) {
    return {
      providerLinkId: `mock-link-${paymentRequest._id}`,
      paymentUrl: `${config.appUrl.replace(/\/$/, '')}/pay/${token}`,
    };
  },
};

/** §139: the active gateway, or null when a tenant has not connected one. */
const gatewayFor = ({ tenantId }) => Integration.findOne({
  tenantId, category: 'PAYMENT_GATEWAY', active: true, status: { $ne: 'DISABLED' },
}).lean();

/**
 * §141: what a link may be raised for. The ceiling is the installment's own
 * outstanding amount — a link for more than is owed is how a customer ends up
 * with a credit balance this version deliberately cannot represent (§145).
 */
async function allowedAmount({ tenantId, booking, installment, settings }) {
  const openOnInstallment = await PaymentRequest.find({
    tenantId,
    bookingId: booking._id,
    installmentId: installment?._id,
    status: { $in: ['CREATED', 'SENT', 'OPEN'] },
  }).select('amountMinor').lean();
  const alreadyRequested = openOnInstallment.reduce((sum, p) => sum + p.amountMinor, 0);
  const ceiling = installment ? installment.outstandingMinor : booking.outstandingMinor;
  return { ceiling: Math.max(0, ceiling - alreadyRequested), alreadyRequested, allowPartial: settings.collectionAllowPartialPaymentLink !== false };
}

async function createLink({
  tenantId, tenant, actor, bookingId, installmentId, amountMinor, expiresInDays,
}) {
  const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
  if (!booking) throw notFound('Booking not found.');
  if (booking.status === 'CANCELLED') throw badRequest('This booking is cancelled.');

  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
  const installment = installmentId
    ? await BookingInstallment.findOne({ tenantId, _id: installmentId, bookingId }).lean()
    : null;
  if (installmentId && !installment) throw badRequest('That installment does not belong to this booking.');
  if (installment && installment.status === 'PAID') throw badRequest('That installment is already paid.');

  const { ceiling, allowPartial } = await allowedAmount({ tenantId, booking, installment, settings });
  if (ceiling <= 0) {
    throw badRequest('There is nothing outstanding to collect on that installment — an open link already covers it.');
  }
  const amount = amountMinor || ceiling;
  if (!(amount > 0)) throw badRequest('Enter the amount to collect.');
  // §247: the error a user actually needs, in their own terms.
  if (amount > ceiling) {
    throw badRequest(`The payment link amount is higher than the ${installment ? 'selected installment’s' : 'booking’s'} outstanding amount (${money.format(ceiling, { currency: tenant?.currency, locale: tenant?.locale })}).`);
  }
  if (amount < ceiling && !allowPartial) {
    throw badRequest('Partial payment links are switched off for this organization.');
  }

  const gateway = await gatewayFor({ tenantId });
  const driverName = gateway?.driver && DRIVERS[gateway.driver] ? gateway.driver : 'mock';
  const days = Number(expiresInDays || settings.paymentLinkExpiryDays || 3);
  const token = crypto.randomBytes(24).toString('base64url');

  const paymentRequest = await PaymentRequest.create({
    tenantId,
    bookingId,
    installmentId: installment?._id,
    amountMinor: amount,
    currency: tenant?.currency || 'INR',
    provider: gateway?.provider || 'MANUAL',
    driver: driverName,
    integrationId: gateway?._id,
    tokenHash: PaymentRequest.hash(token),
    expiresAt: new Date(Date.now() + days * 86400000),
    status: 'CREATED',
    createdBy: actor?._id,
  });

  const issued = await DRIVERS[driverName]({ tenantId, gateway, paymentRequest, token, amount });
  await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, {
    $set: { providerLinkId: issued.providerLinkId, paymentUrl: issued.paymentUrl },
  });

  await timeline.log({
    tenantId,
    bookingId,
    type: 'PAYMENT_LINK_CREATED',
    title: `Payment link created for ${money.format(amount, { currency: tenant?.currency, locale: tenant?.locale })}`,
    body: installment ? installment.milestone : 'Against the booking',
    actor,
    meta: {
      paymentRequestId: String(paymentRequest._id),
      installmentId: installment ? String(installment._id) : null,
      amountMinor: amount,
      provider: paymentRequest.provider,
    },
  });
  await audit.record({
    tenantId, actor, entity: 'PaymentRequest', entityId: paymentRequest._id, action: 'CREATE',
    after: { bookingId: String(bookingId), amountMinor: amount, provider: paymentRequest.provider },
  });
  emit(EVENTS.COLLECTION_PAYMENT_LINK_CREATED, {
    tenantId, bookingId, paymentRequestId: paymentRequest._id, amountMinor: amount,
  });

  return {
    paymentRequest: await PaymentRequest.findOne({ tenantId, _id: paymentRequest._id }).lean(),
    url: issued.paymentUrl,
    token,
  };
}

/** §141: hand the link over. Sending is recorded; it is still not a payment. */
async function shareLink({
  tenantId, tenant, actor, paymentRequestId, channel = 'WHATSAPP', templateId,
}) {
  const paymentRequest = await PaymentRequest.findOne({ tenantId, _id: paymentRequestId }).lean();
  if (!paymentRequest) throw notFound('Payment link not found.');
  if (!['CREATED', 'SENT', 'OPEN'].includes(paymentRequest.status)) {
    throw badRequest('That payment link is no longer active.');
  }
  const booking = await Booking.findOne({ tenantId, _id: paymentRequest.bookingId }).lean();
  const [contact, project, unit] = await Promise.all([
    Contact.findOne({ tenantId, _id: booking.contactId }).lean(),
    Project.findOne({ tenantId, _id: booking.projectId }).select('name').lean(),
    Unit.findOne({ tenantId, _id: booking.unitId }).select('unitNumber').lean(),
  ]);

  if (channel !== 'COPY') {
    await messaging.send({
      tenantId,
      channel,
      contact,
      purpose: 'ACKNOWLEDGEMENT',
      templateId,
      body: templateId ? undefined : 'Hello {{contact.first_name|there}}, here is your payment link for {{project.name}} {{unit.number}} — {{payment.amount}}: {{payment.url}}',
      subject: templateId ? undefined : `Payment link — ${project?.name || ''}`.trim(),
      vars: {
        contact: { first_name: contact?.firstName || contact?.displayName },
        project: { name: project?.name },
        unit: { number: unit?.unitNumber },
        booking: { number: booking.bookingNumber },
        payment: {
          url: paymentRequest.paymentUrl,
          amount: money.format(paymentRequest.amountMinor, { currency: tenant?.currency, locale: tenant?.locale }),
        },
      },
      sentBy: actor?._id,
    });
  }

  await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, {
    $set: {
      status: paymentRequest.status === 'CREATED' ? 'SENT' : paymentRequest.status,
      sharedAt: new Date(),
      sharedChannel: channel,
    },
  });
  await timeline.log({
    tenantId,
    bookingId: paymentRequest.bookingId,
    type: 'PAYMENT_LINK_SENT',
    title: `Payment link shared by ${channel.toLowerCase()}`,
    actor,
    meta: { paymentRequestId: String(paymentRequest._id), channel },
  });
  return PaymentRequest.findOne({ tenantId, _id: paymentRequest._id }).lean();
}

async function cancelLink({ tenantId, actor, paymentRequestId, reason }) {
  const paymentRequest = await PaymentRequest.findOne({ tenantId, _id: paymentRequestId });
  if (!paymentRequest) throw notFound('Payment link not found.');
  if (paymentRequest.status === 'PAID') throw badRequest('That link has already been paid.');
  paymentRequest.status = 'CANCELLED';
  paymentRequest.failureReason = reason;
  await paymentRequest.save();
  await timeline.log({
    tenantId,
    bookingId: paymentRequest.bookingId,
    type: 'PAYMENT_LINK_CANCELLED',
    title: 'Payment link cancelled',
    body: reason,
    actor,
    meta: { paymentRequestId: String(paymentRequest._id) },
  });
  await audit.record({
    tenantId, actor, entity: 'PaymentRequest', entityId: paymentRequest._id, action: 'CANCEL',
    after: { reason },
  });
  return paymentRequest;
}

/** The customer's view of one link (public page). Nothing internal on it. */
async function resolveToken({ token }) {
  if (!token || String(token).length < 16) throw notFound('This payment link is not valid.');
  const paymentRequest = await PaymentRequest.findOne({ tokenHash: PaymentRequest.hash(token) })
    .setOptions({ allowCrossTenant: true }).lean();
  if (!paymentRequest) throw notFound('This payment link is not valid.');

  const tenantId = paymentRequest.tenantId;
  if (['CREATED', 'SENT', 'OPEN'].includes(paymentRequest.status)
      && paymentRequest.expiresAt && new Date(paymentRequest.expiresAt) < new Date()) {
    await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, { $set: { status: 'EXPIRED' } });
    paymentRequest.status = 'EXPIRED';
  }

  const booking = await Booking.findOne({ tenantId, _id: paymentRequest.bookingId })
    .populate('projectId', 'name')
    .populate('unitId', 'unitNumber')
    .lean();
  const [tenant, contact, installment] = await Promise.all([
    Tenant.findById(tenantId).lean(),
    Contact.findOne({ tenantId, _id: booking.contactId }).select('displayName firstName').lean(),
    paymentRequest.installmentId
      ? BookingInstallment.findOne({ tenantId, _id: paymentRequest.installmentId }).lean()
      : null,
  ]);

  // §291: record that it was opened, because this driver genuinely knows.
  if (['CREATED', 'SENT'].includes(paymentRequest.status)) {
    await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, {
      $set: { status: 'OPEN', openedAt: paymentRequest.openedAt || new Date() },
    });
    paymentRequest.status = 'OPEN';
  }
  return { paymentRequest, booking, tenant, contact, installment };
}

/**
 * §142: the gateway callback. Same security shape as the V1 lead webhook —
 * signature verified, raw event stored first, idempotency key unique — because
 * a payment replay is worse than a duplicate lead.
 */
function verifySignature({ integration, req }) {
  const sealed = integration.secrets?.get?.('signingSecret') ?? integration.secrets?.signingSecret;
  if (!sealed) return null;                       // Nothing configured: nothing to verify.
  const secret = secretbox.open(sealed) || sealed;
  const provided = req.get('x-webhook-signature') || req.get('x-razorpay-signature') || '';
  if (!provided) return 'Missing signature.';
  // Same construction as the V1 lead webhook, so one mental model covers both.
  const expected = crypto.createHmac('sha256', secret)
    .update(JSON.stringify(req.body || {}))
    .digest('hex');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Invalid signature.';
  return null;
}

/**
 * Normalises a provider payload into the two facts that matter: which link was
 * paid and with what reference.
 */
function normalizeCallback(payload = {}) {
  const body = payload.payload?.payment?.entity || payload.payment || payload;
  return {
    providerLinkId: payload.providerLinkId || body.payment_link_id || body.linkId || payload.linkId,
    gatewayPaymentId: payload.gatewayPaymentId || body.id || payload.paymentId,
    status: String(payload.event || body.status || payload.status || '').toLowerCase(),
    amountMinor: Number(payload.amountMinor ?? body.amount ?? NaN),
    paidAt: payload.paidAt || body.created_at,
  };
}

const SUCCESS = ['paid', 'captured', 'success', 'succeeded', 'payment.captured', 'payment_link.paid'];
const FAILURE = ['failed', 'payment.failed', 'cancelled'];

/**
 * Applies one confirmed callback. Idempotent on `gatewayPaymentId`: a provider
 * retry finds the receipt already there and changes nothing.
 */
async function applyCallback({ tenantId, event }) {
  const normalized = normalizeCallback(event);
  if (!normalized.providerLinkId) throw badRequest('The callback did not identify a payment link.');

  const paymentRequest = await PaymentRequest.findOne({ tenantId, providerLinkId: normalized.providerLinkId }).lean();
  if (!paymentRequest) throw notFound('Unknown payment link.');

  if (FAILURE.includes(normalized.status)) {
    await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, {
      $set: { status: 'FAILED', failureReason: `Provider reported ${normalized.status}` },
    });
    return { applied: 'FAILED', paymentRequestId: paymentRequest._id };
  }
  if (!SUCCESS.includes(normalized.status)) {
    return { applied: 'IGNORED', status: normalized.status };
  }

  if (paymentRequest.status === 'PAID') {
    return { applied: 'ALREADY_PAID', paymentRequestId: paymentRequest._id, receiptId: paymentRequest.receiptId };
  }
  const amountMinor = Number.isFinite(normalized.amountMinor) && normalized.amountMinor > 0
    ? normalized.amountMinor
    : paymentRequest.amountMinor;
  if (amountMinor !== paymentRequest.amountMinor) {
    // A short or over payment is a human decision, not something to guess at.
    await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, {
      $set: { failureReason: `Provider reported ${amountMinor} against a link for ${paymentRequest.amountMinor}` },
    });
    throw conflict('The amount the gateway reported does not match this payment link. It needs manual review.');
  }

  const receipts = require('./receipts');
  const receipt = await receipts.record({
    tenantId,
    actor: null,
    bookingId: paymentRequest.bookingId,
    amountMinor,
    paymentDate: normalized.paidAt ? new Date(normalized.paidAt) : new Date(),
    mode: 'ONLINE',
    reference: normalized.gatewayPaymentId,
    gatewayPaymentId: normalized.gatewayPaymentId,
    paymentRequestId: paymentRequest._id,
    createdByType: 'GATEWAY',
    allocations: paymentRequest.installmentId
      ? [{ installmentId: paymentRequest.installmentId, amountMinor }]
      : null,
  });

  await PaymentRequest.updateOne({ tenantId, _id: paymentRequest._id }, {
    $set: {
      status: 'PAID',
      paidAt: receipt.paymentDate,
      gatewayPaymentId: normalized.gatewayPaymentId,
      receiptId: receipt._id,
    },
  });
  return { applied: 'PAID', paymentRequestId: paymentRequest._id, receiptId: receipt._id };
}

/**
 * The public webhook entry point. Stores the raw delivery before doing anything
 * with it, so a payload that breaks processing is still on disk to replay.
 */
async function handleWebhook({ webhookKey, req }) {
  const integration = await Integration.findOne({ webhookKey, active: true, category: 'PAYMENT_GATEWAY' })
    .setOptions({ allowCrossTenant: true }).lean();
  if (!integration) return { status: 404, body: { ok: false, error: 'Unknown webhook endpoint.' } };

  const tenantId = integration.tenantId;
  const signatureError = verifySignature({ integration, req });
  if (signatureError) return { status: 401, body: { ok: false, error: signatureError } };

  const normalized = normalizeCallback(req.body);
  const idempotencyKey = normalized.gatewayPaymentId
    || req.get('x-idempotency-key')
    || crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');

  let stored;
  try {
    stored = await WebhookEvent.create({
      tenantId,
      integrationId: integration._id,
      provider: integration.provider,
      kind: 'PAYMENT',
      idempotencyKey,
      payload: req.body,
      headers: { 'user-agent': req.get('user-agent') },
    });
  } catch (err) {
    // The unique index did its job: this exact delivery has been seen already.
    if (err.code === 11000) return { status: 200, body: { ok: true, duplicate: true } };
    throw err;
  }

  try {
    const result = await applyCallback({ tenantId, event: req.body });
    await WebhookEvent.updateOne({ tenantId, _id: stored._id }, {
      $set: { status: 'PROCESSED', processedAt: new Date(), result },
    });
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    await WebhookEvent.updateOne({ tenantId, _id: stored._id }, {
      $set: { status: 'FAILED', error: err.message, processedAt: new Date() },
    });
    return { status: err.status && err.status < 500 ? err.status : 500, body: { ok: false, error: err.message } };
  }
}

/**
 * The mock driver's stand-in for a customer paying. Refuses outright unless the
 * link was issued by the mock driver — a real gateway's link can only ever be
 * settled by that gateway's callback.
 */
async function simulatePayment({ token }) {
  const { paymentRequest } = await resolveToken({ token });
  if (paymentRequest.driver !== 'mock') throw badRequest('This link is settled by the payment provider.');
  if (paymentRequest.status === 'PAID') return { alreadyPaid: true };
  if (!['CREATED', 'SENT', 'OPEN'].includes(paymentRequest.status)) {
    throw badRequest('This payment link is no longer active.');
  }
  return applyCallback({
    tenantId: paymentRequest.tenantId,
    event: {
      providerLinkId: paymentRequest.providerLinkId,
      gatewayPaymentId: `mock-pay-${crypto.randomBytes(6).toString('hex')}`,
      status: 'paid',
      amountMinor: paymentRequest.amountMinor,
    },
  });
}

/** §188: links that nobody used. Expiry is a state, not a silent absence. */
async function expireSweep({ tenantId = null, now = new Date(), limit = 500 } = {}) {
  const filter = { status: { $in: ['CREATED', 'SENT', 'OPEN'] }, expiresAt: { $lt: now } };
  if (tenantId) filter.tenantId = tenantId;
  const stale = await PaymentRequest.find(filter).setOptions({ allowCrossTenant: !tenantId }).limit(limit).lean();
  for (const paymentRequest of stale) {
    await PaymentRequest.updateOne({ tenantId: paymentRequest.tenantId, _id: paymentRequest._id }, {
      $set: { status: 'EXPIRED' },
    });
  }
  return { scanned: stale.length, expired: stale.length };
}

const forBooking = ({ tenantId, bookingId }) => PaymentRequest.find({ tenantId, bookingId })
  .sort({ createdAt: -1 })
  .populate('createdBy', 'name')
  .lean();

module.exports = {
  DRIVERS, gatewayFor, allowedAmount, createLink, shareLink, cancelLink, resolveToken,
  handleWebhook, applyCallback, simulatePayment, expireSweep, forBooking, normalizeCallback,
  verifySignature,
};
