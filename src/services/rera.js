const { ChannelPartner, PartnerReraDocument, Tenant } = require('../db/models');
const { badRequest, notFound, conflict } = require('../lib/errors');
const { EVENTS, emit } = require('../lib/events');
const privateFiles = require('../lib/privateFiles');
const tzLib = require('../lib/tz');
const timeline = require('./timeline');
const notifications = require('./notifications');
const audit = require('./audit');

/**
 * V2 §18–§20, §217, §324.11: the partner's RERA registration.
 *
 * Versioned, never overwritten. A renewal creates version n+1 and retires the
 * previous one — "what were they registered as in March" is a compliance
 * question with a real answer, and losing it is not an option.
 *
 * The certificate file itself is private (lib/privateFiles), like every other
 * sensitive upload in this product.
 */

/** §19: the RERA policy in force for this tenant. */
async function policyFor({ tenantId, tenant = null }) {
  const settings = tenant?.settings || (await Tenant.findById(tenantId).lean())?.settings || {};
  return {
    required: settings.cpRequireRera !== false,
    requireVerifiedForActivation: !!settings.cpRequireVerifiedReraForActivation,
    requireValidForLeadSubmission: settings.cpRequireValidReraForLeadSubmission !== false,
    reminderDays: settings.cpReraExpiryReminderDays || [90, 60, 30, 7],
  };
}

/**
 * §216/§324.11: one RERA number cannot belong to two partners. Checked against
 * every version ever recorded, not just the active one — a lapsed certificate
 * still identifies whose it was.
 */
async function assertNumberFree({ tenantId, registrationNumber, channelPartnerId = null, registrationId = null }) {
  if (!registrationNumber) return;
  const clash = await PartnerReraDocument.findOne({
    tenantId,
    registrationNumber: new RegExp(`^${String(registrationNumber).trim()}$`, 'i'),
    ...(channelPartnerId ? { channelPartnerId: { $ne: channelPartnerId } } : {}),
    ...(registrationId && !channelPartnerId ? { registrationId: { $ne: registrationId } } : {}),
  }).lean();
  if (!clash) return;
  // The clash may be another draft application, which is still worth blocking.
  throw conflict('This RERA number is already registered with another channel partner.');
}

/**
 * §18/§217: record a certificate. `channelPartnerId` for a live partner,
 * `registrationId` while the application is still being filled in.
 */
async function addVersion({
  tenantId, actor = null, channelPartnerId = null, registrationId = null, channelPartnerMemberId = null,
  data = {}, file = null, uploadedByType = 'INTERNAL_USER',
}) {
  if (!channelPartnerId && !registrationId) throw badRequest('A RERA certificate needs a partner or an application.');
  const registrationNumber = String(data.registrationNumber || '').trim();
  if (!registrationNumber) throw badRequest('Enter the RERA registration number.');
  await assertNumberFree({ tenantId, registrationNumber, channelPartnerId, registrationId });

  const expiryDate = data.expiryDate ? new Date(data.expiryDate) : null;
  const issueDate = data.issueDate ? new Date(data.issueDate) : null;
  if (expiryDate && issueDate && expiryDate < issueDate) {
    throw badRequest('The expiry date cannot be before the issue date.');
  }

  let certificate;
  if (file?.buffer?.length) {
    // §18/§194: PDF preferred, images allowed; the server decides, not the browser.
    privateFiles.assertAcceptable({ mimeType: file.mimetype, size: file.size });
    const stored = await privateFiles.store({
      tenantId, scope: 'rera', mimeType: file.mimetype, buffer: file.buffer,
    });
    certificate = {
      storageKey: stored.storageKey,
      fileLabel: `RERA ${registrationNumber}`,
      mimeType: file.mimetype,
      bytes: stored.bytes,
    };
  }

  const scope = channelPartnerId ? { channelPartnerId } : { registrationId };
  const previous = await PartnerReraDocument.findOne({ tenantId, ...scope, active: true }).lean();
  const version = ((await PartnerReraDocument.findOne({ tenantId, ...scope }).sort({ version: -1 }).select('version').lean())?.version || 0) + 1;

  const document = await PartnerReraDocument.create({
    tenantId,
    ...scope,
    channelPartnerMemberId,
    version,
    authority: data.authority || 'GujRERA',
    registrationNumber,
    reraName: data.reraName,
    reraType: data.reraType,
    issueDate,
    expiryDate,
    certificate,
    verificationStatus: 'PENDING',
    uploadedByType,
    uploadedBy: actor?._id,
    active: true,
  });

  if (previous) {
    // §217: retired, not replaced.
    await PartnerReraDocument.updateOne({ tenantId, _id: previous._id }, {
      $set: { active: false, supersededById: document._id },
    });
  }
  if (channelPartnerId) {
    await syncPartner({ tenantId, channelPartnerId });
    await timeline.log({
      tenantId,
      channelPartnerId,
      type: 'CP_RERA_UPLOADED',
      title: version > 1 ? `RERA certificate renewed (v${version})` : 'RERA certificate recorded',
      body: `${registrationNumber}${expiryDate ? ` · expires ${tzLib.formatDate(expiryDate, 'UTC')}` : ''}`,
      actor,
      actorType: uploadedByType === 'PARTNER' ? 'INTEGRATION' : 'USER',
      meta: { reraDocumentId: String(document._id), version },
    });
  }
  await audit.record({
    tenantId, actor, entity: 'PartnerReraDocument', entityId: document._id, action: 'CREATE',
    after: { registrationNumber, version, expiryDate },
  });
  return document;
}

/** §18: an internal reviewer confirms the certificate is genuine. */
async function verify({ tenantId, actor, reraDocumentId, decision, note }) {
  if (!['VERIFIED', 'REJECTED'].includes(decision)) throw badRequest('Choose whether the certificate is verified or rejected.');
  const document = await PartnerReraDocument.findOne({ tenantId, _id: reraDocumentId }).lean();
  if (!document) throw notFound('RERA certificate not found.');
  if (decision === 'REJECTED' && !String(note || '').trim()) {
    throw badRequest('Say why the certificate was rejected.');
  }

  await PartnerReraDocument.updateOne({ tenantId, _id: document._id }, {
    $set: {
      verificationStatus: decision,
      verificationNote: note,
      verifiedBy: actor?._id,
      verifiedAt: new Date(),
    },
  });
  if (document.channelPartnerId) {
    await syncPartner({ tenantId, channelPartnerId: document.channelPartnerId });
    await timeline.log({
      tenantId,
      channelPartnerId: document.channelPartnerId,
      type: 'CP_RERA_VERIFIED',
      title: `RERA certificate ${decision.toLowerCase()}`,
      body: note,
      actor,
      meta: { reraDocumentId: String(document._id), decision },
    });
  }
  // §196: RERA verification is an audited decision.
  await audit.record({
    tenantId, actor, entity: 'PartnerReraDocument', entityId: document._id, action: 'VERIFY',
    before: { verificationStatus: document.verificationStatus }, after: { verificationStatus: decision, note },
  });
  return PartnerReraDocument.findOne({ tenantId, _id: document._id }).lean();
}

/**
 * Copies the active certificate's position onto the partner, so a list can
 * filter by expiry without a join. The document history stays authoritative.
 */
async function syncPartner({ tenantId, channelPartnerId, now = new Date() }) {
  const active = await PartnerReraDocument.findOne({ tenantId, channelPartnerId, active: true }).lean();
  if (!active) {
    await ChannelPartner.updateOne({ tenantId, _id: channelPartnerId }, {
      $set: { reraStatus: 'NONE' },
      $unset: { reraNumber: '', reraExpiryDate: '', activeReraDocumentId: '' },
    });
    return null;
  }
  const expired = active.expiryDate && new Date(active.expiryDate) < now;
  const status = expired ? 'EXPIRED' : active.verificationStatus;
  await ChannelPartner.updateOne({ tenantId, _id: channelPartnerId }, {
    $set: {
      reraNumber: active.registrationNumber,
      reraExpiryDate: active.expiryDate,
      reraStatus: status,
      activeReraDocumentId: active._id,
    },
  });
  if (expired && active.verificationStatus !== 'EXPIRED') {
    await PartnerReraDocument.updateOne({ tenantId, _id: active._id }, { $set: { verificationStatus: 'EXPIRED' } });
  }
  return { ...active, effectiveStatus: status };
}

/**
 * §19/§26: may this partner submit a lead right now? Returns null when they
 * may, or the reason they may not — the caller turns that into a claim
 * conflict rather than a silent drop.
 */
async function leadSubmissionBlock({ tenantId, tenant, partner }) {
  const policy = await policyFor({ tenantId, tenant });
  if (!policy.required || !policy.requireValidForLeadSubmission) return null;
  if (!partner.reraNumber) return 'This partner has no RERA certificate on file.';
  if (partner.reraStatus === 'EXPIRED') return 'This partner’s RERA certificate has expired.';
  if (partner.reraExpiryDate && new Date(partner.reraExpiryDate) < new Date()) {
    return 'This partner’s RERA certificate has expired.';
  }
  if (policy.requireVerifiedReraForActivation && partner.reraStatus !== 'VERIFIED') {
    return 'This partner’s RERA certificate has not been verified yet.';
  }
  return null;
}

/** §20: the banner a partner and the CP team both see. */
function expiryBanner({ partner, now = new Date(), zone = 'UTC', locale = 'en-IN' }) {
  if (!partner?.reraExpiryDate) return null;
  const expiry = new Date(partner.reraExpiryDate);
  const days = Math.ceil((tzLib.startOfDay(expiry, zone) - tzLib.startOfDay(now, zone)) / 86400000);
  if (days < 0) {
    return {
      tone: 'bad',
      message: `RERA certificate expired on ${tzLib.formatDate(expiry, zone, locale)}.`,
      days,
    };
  }
  if (days <= 90) {
    return {
      tone: days <= 30 ? 'bad' : 'warn',
      message: `RERA expires in ${days} day${days === 1 ? '' : 's'}. Upload the renewed certificate.`,
      days,
    };
  }
  return null;
}

/**
 * §53/§188 `cp.rera_expiry`. Nothing happens on the day a certificate lapses to
 * fire an event, so the bands have to be swept for. Idempotent: each band is
 * announced once per certificate version.
 */
async function expirySweep({ tenantId = null, now = new Date(), limit = 500 } = {}) {
  const tenants = await Tenant.find(tenantId ? { _id: tenantId } : { status: 'ACTIVE' }).lean();
  let notified = 0;
  let expired = 0;

  for (const tenant of tenants) {
    const policy = await policyFor({ tenantId: tenant._id, tenant });
    const zone = tenant.timezone || 'UTC';
    const horizon = tzLib.addLocalDays(now, Math.max(...policy.reminderDays, 0) + 1, zone);

    const partners = await ChannelPartner.find({
      tenantId: tenant._id,
      status: { $in: ['ACTIVE', 'SUSPENDED'] },
      reraExpiryDate: { $ne: null, $lt: horizon },
    }).limit(limit).lean();

    for (const partner of partners) {
      const expiry = new Date(partner.reraExpiryDate);
      const days = Math.ceil((tzLib.startOfDay(expiry, zone) - tzLib.startOfDay(now, zone)) / 86400000);
      const active = await PartnerReraDocument.findOne({
        tenantId: tenant._id, channelPartnerId: partner._id, active: true,
      }).lean();
      if (!active) continue;

      if (days < 0) {
        const announced = await require('../db/models').Activity.findOne({
          tenantId: tenant._id,
          channelPartnerId: partner._id,
          type: 'CP_RERA_EXPIRED',
          'meta.reraDocumentId': String(active._id),
        }).lean();
        if (!announced) {
          await syncPartner({ tenantId: tenant._id, channelPartnerId: partner._id, now });
          await timeline.log({
            tenantId: tenant._id,
            channelPartnerId: partner._id,
            type: 'CP_RERA_EXPIRED',
            title: `RERA certificate expired on ${tzLib.formatDate(expiry, zone, tenant.locale)}`,
            actorType: 'SYSTEM',
            meta: { reraDocumentId: String(active._id) },
          });
          emit(EVENTS.CP_RERA_EXPIRED, { tenantId: tenant._id, channelPartnerId: partner._id });
          await notifyCpTeam({
            tenantId: tenant._id,
            partner,
            title: 'Partner RERA expired',
            body: `${partner.profile?.tradeName || partner.profile?.legalName || 'A partner'}'s RERA certificate has expired.`,
            severity: 'CRITICAL',
          });
          expired += 1;
        }
        continue;
      }

      // §19: announce each configured band once.
      const band = policy.reminderDays.filter((d) => d >= days).sort((a, b) => a - b)[0];
      if (band === undefined) continue;
      const already = await require('../db/models').Activity.findOne({
        tenantId: tenant._id,
        channelPartnerId: partner._id,
        type: 'CP_RERA_EXPIRING',
        'meta.band': band,
        'meta.reraDocumentId': String(active._id),
      }).lean();
      if (already) continue;

      await timeline.log({
        tenantId: tenant._id,
        channelPartnerId: partner._id,
        type: 'CP_RERA_EXPIRING',
        title: `RERA expires in ${days} day${days === 1 ? '' : 's'}`,
        actorType: 'SYSTEM',
        meta: { band, days, reraDocumentId: String(active._id) },
      });
      emit(EVENTS.CP_RERA_EXPIRING, { tenantId: tenant._id, channelPartnerId: partner._id, days });
      await notifyCpTeam({
        tenantId: tenant._id,
        partner,
        title: `Partner RERA expiring in ${days} days`,
        body: `${partner.profile?.tradeName || partner.profile?.legalName || 'A partner'} needs to upload a renewed certificate.`,
        severity: days <= 30 ? 'WARNING' : 'INFO',
      });
      notified += 1;
    }
  }
  return { notified, expired };
}

/** Whoever runs channel partners hears about compliance (§52). */
async function notifyCpTeam({ tenantId, partner, title, body, severity = 'INFO' }) {
  const userIds = await notifications.adminUserIds(tenantId);
  if (partner.ownerUserId) userIds.push(partner.ownerUserId);
  await notifications.notifyMany({
    tenantId,
    userIds,
    domain: 'CHANNEL_PARTNER',
    type: 'CP_RERA',
    title,
    body,
    link: `/app/channel-partners/${partner._id}`,
    severity,
  });
}

const historyFor = ({ tenantId, channelPartnerId }) => PartnerReraDocument
  .find({ tenantId, channelPartnerId })
  .sort({ version: -1 })
  .populate('verifiedBy', 'name')
  .lean();

module.exports = {
  policyFor, assertNumberFree, addVersion, verify, syncPartner, leadSubmissionBlock,
  expiryBanner, expirySweep, historyFor,
};
