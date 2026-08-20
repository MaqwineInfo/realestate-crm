const {
  Tenant, Booking, BookingInstallment, Contact, Project, Unit, Template, PaymentRequest,
} = require('../db/models');
const money = require('../lib/money');
const tzLib = require('../lib/tz');
const installmentsService = require('./installments');
const messaging = require('./messaging');
const timeline = require('./timeline');

/**
 * V2 §163: automated customer payment reminders.
 *
 * Off unless a tenant switches it on, because an organization that has not
 * decided its messaging policy should not start messaging customers because
 * the software shipped.
 *
 * Idempotent by band: each installment records which reminders have gone out
 * (`remindersSent`), so a minute-by-minute job cannot become a minute-by-minute
 * nuisance.
 */

/** Which band, if any, applies to an installment today (§163). */
function bandFor({ installment, settings, zone, now }) {
  const due = installmentsService.dueDateOf(installment);
  if (!due) return null;                              // TBD: nothing to remind about.
  const today = tzLib.startOfDay(now, zone);
  const dueDay = tzLib.startOfDay(due, zone);
  const days = Math.round((dueDay - today) / 86400000);

  if (days === 0) return 'DUE';
  if (days > 0) {
    const before = settings.collectionReminderDaysBefore || [7, 3, 1];
    return before.includes(days) ? `BEFORE_${days}` : null;
  }
  const after = settings.collectionReminderDaysAfter || [1, 7];
  return after.includes(-days) ? `AFTER_${-days}` : null;
}

const PURPOSE = {
  DUE: 'PAYMENT_DUE',
  BEFORE: 'PAYMENT_UPCOMING',
  AFTER: 'PAYMENT_OVERDUE',
};

const DEFAULT_BODY = {
  PAYMENT_UPCOMING: 'Hello {{contact.first_name|there}}, a payment of {{payment.amount}} for {{project.name}} {{unit.number}} is due on {{payment.due_date}}.{{payment.link_line}}',
  PAYMENT_DUE: 'Hello {{contact.first_name|there}}, your payment of {{payment.amount}} for {{project.name}} {{unit.number}} is due today.{{payment.link_line}}',
  PAYMENT_OVERDUE: 'Hello {{contact.first_name|there}}, a payment of {{payment.amount}} for {{project.name}} {{unit.number}} was due on {{payment.due_date}} and is still outstanding.{{payment.link_line}}',
};

const purposeFor = (band) => (band === 'DUE' ? PURPOSE.DUE : PURPOSE[band.split('_')[0]]);

/**
 * One tenant's due reminders. Returns what it sent so the scheduler's health
 * view is honest about whether anything is going out.
 */
async function runForTenant({ tenant, now = new Date(), limit = 200 }) {
  const settings = tenant.settings || {};
  if (!settings.collectionReminderEnabled) return { skipped: 'disabled', sent: 0 };
  const tenantId = tenant._id;
  const zone = tenant.timezone || 'UTC';
  const channel = settings.collectionReminderChannel || 'WHATSAPP';

  const before = settings.collectionReminderDaysBefore || [7, 3, 1];
  const after = settings.collectionReminderDaysAfter || [1, 7];
  const window = {
    from: tzLib.addLocalDays(now, -Math.max(0, ...after, 0), zone),
    to: tzLib.addLocalDays(now, Math.max(0, ...before, 0) + 1, zone),
  };

  const candidates = await BookingInstallment.find({
    tenantId,
    status: { $nin: ['PAID', 'CANCELLED'] },
    outstandingMinor: { $gt: 0 },
    $or: [
      { actualDueDate: { $gte: window.from, $lt: window.to } },
      { actualDueDate: null, expectedDueDate: { $gte: window.from, $lt: window.to } },
    ],
  }).limit(limit).lean();

  let sent = 0;
  for (const installment of candidates) {
    const band = bandFor({ installment, settings, zone, now });
    if (!band || (installment.remindersSent || []).includes(band)) continue;

    const booking = await Booking.findOne({ tenantId, _id: installment.bookingId }).lean();
    // §163: never chase a cancelled booking or a settled schedule.
    if (!booking || booking.status === 'CANCELLED' || booking.outstandingMinor <= 0) continue;

    const [contact, project, unit, openLink] = await Promise.all([
      Contact.findOne({ tenantId, _id: booking.contactId }).lean(),
      Project.findOne({ tenantId, _id: booking.projectId }).select('name').lean(),
      Unit.findOne({ tenantId, _id: booking.unitId }).select('unitNumber').lean(),
      PaymentRequest.findOne({
        tenantId, bookingId: booking._id, installmentId: installment._id,
        status: { $in: ['CREATED', 'SENT', 'OPEN'] },
      }).select('paymentUrl').lean(),
    ]);
    if (!contact) continue;

    const purpose = purposeFor(band);
    const template = await Template.findOne({ tenantId, purpose, channel, active: true }).lean();
    const due = installmentsService.dueDateOf(installment);
    const fmt = (minor) => money.format(minor, { currency: tenant.currency, locale: tenant.locale });

    const result = await messaging.send({
      tenantId,
      channel,
      contact,
      // An operational payment notice is not marketing; it follows the same
      // consent treatment as an acknowledgement (§163, §67).
      purpose: 'ACKNOWLEDGEMENT',
      template,
      body: template ? undefined : DEFAULT_BODY[purpose],
      subject: template ? undefined : `Payment ${band === 'DUE' ? 'due today' : band.startsWith('AFTER') ? 'overdue' : 'reminder'} — ${project?.name || ''}`.trim(),
      vars: {
        contact: { first_name: contact.firstName || contact.displayName },
        project: { name: project?.name },
        unit: { number: unit?.unitNumber },
        booking: {
          number: booking.bookingNumber,
          next_due_date: tzLib.formatDate(due, zone, tenant.locale),
          next_due_amount: fmt(installment.outstandingMinor),
        },
        payment: {
          amount: fmt(installment.outstandingMinor),
          due_date: tzLib.formatDate(due, zone, tenant.locale),
          milestone: installment.milestone,
          url: openLink?.paymentUrl || '',
          link_line: openLink?.paymentUrl ? ` Pay here: ${openLink.paymentUrl}` : '',
        },
      },
    });

    // Recorded even when the send was skipped (opted out, no number): the band
    // has been attempted, and retrying every minute would not change that.
    await BookingInstallment.updateOne({ tenantId, _id: installment._id }, {
      $addToSet: { remindersSent: band },
    });
    if (result?.status === 'SENT') {
      await timeline.log({
        tenantId,
        bookingId: booking._id,
        type: 'PAYMENT_REMINDER_SENT',
        title: `Payment reminder sent — ${installment.milestone}`,
        body: `${band.replace(/_/g, ' ').toLowerCase()} · ${channel.toLowerCase()}`,
        actorType: 'SYSTEM',
        meta: { installmentId: String(installment._id), band, channel },
      });
      sent += 1;
    }
  }
  return { scanned: candidates.length, sent };
}

/** §188 `booking.payment_reminders`. */
async function sweep({ tenantId = null, now = new Date() } = {}) {
  const filter = tenantId ? { _id: tenantId } : { status: 'ACTIVE' };
  const tenants = await Tenant.find(filter).lean();
  const results = {};
  for (const tenant of tenants) {
    if (!tenant.settings?.collectionReminderEnabled) continue;
    results[String(tenant._id)] = await runForTenant({ tenant, now });
  }
  return { tenants: Object.keys(results).length, results };
}

module.exports = { sweep, runForTenant, bandFor, DEFAULT_BODY };
