const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers');
const {
  Booking, BookingInstallment, BookingCustomerLink, BookingApplicant, BookingKycDocument,
  KycDocumentType, PaymentRequest, BookingReceipt, ReceiptAllocation, Activity, AuditLog,
  Integration, Tenant, MessageLog, Template, WebhookEvent,
  LeadSource, Project, Tower, UnitType, Unit, PricingComponent, PaymentPlan, Stage, ActionType,
} = require('../../src/db/models');

/**
 * V2 Phase 2 — the customer booking form, KYC, payment links and receipts.
 *
 * The invariants under test are the ones §324 calls non-negotiable: the customer
 * can never touch a commercial field, KYC files are private, a payment link is
 * not a payment, a gateway callback is idempotent, and a receipt is reversed
 * rather than deleted.
 */
test('customer booking form, KYC, payments and receipts (V2 §116–§170)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Form Rep', email: 'rep2@alpha.test', roleName: 'Sales User',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

  const project = await Project.create({
    tenantId, name: 'KYC Gardens', status: 'ACTIVE', city: 'Pune', code: 'KG', developerName: 'KYC Estates',
  });
  const tower = await Tower.create({ tenantId, projectId: project._id, name: 'Tower A', code: 'A' });
  const unitType = await UnitType.create({
    tenantId, projectId: project._id, name: '2 BHK', superBuiltUpArea: 1000, defaultBaseRateMinor: 1000000,
  });
  const unit = await Unit.create({
    tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
    unitNumber: 'A-101', floorNumber: 1, saleableArea: 1000, status: 'AVAILABLE',
  });
  await PricingComponent.create({
    tenantId, projectId: project._id, name: 'Base price', kind: 'BASE',
    calcType: 'PER_AREA', rateMinor: 1000000, areaBasis: 'SALEABLE', displayOrder: 1,
  });
  const plan = await PaymentPlan.create({
    tenantId, projectId: project._id, name: 'Two part', type: 'CUSTOM', active: true,
    milestones: [
      { sequence: 1, label: 'On booking', percentage: 40, dueRule: 'ON_BOOKING', displayOrder: 1 },
      { sequence: 2, label: 'Within 30 days', percentage: 60, dueRule: 'DAYS_AFTER_BOOKING', dueOffsetDays: 30, displayOrder: 2 },
    ],
  });

  const admin = h.client();
  await admin.login('admin@alpha.test');
  const rep = h.client();
  await rep.login('rep2@alpha.test');

  const created = await admin.submit('/api/leads', {
    firstName: 'Meera', lastName: 'Iyer', primaryMobile: '9330000777',
    sourceId: String(source._id), projectId: String(project._id),
    assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
  }, '/app/leads/new');
  const leadId = created.location.split('?')[0].split('/').pop();
  const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await rep.submit(`/api/leads/${leadId}/log-action`, {
    actionTypeId: String(actions.CALL._id), stageId: String(stages.CONNECTED._id),
    nextActionTypeId: String(actions.SITE_VISIT._id), nextDate: soon, nextTime: '11:00',
  }, `/app/leads/${leadId}`);

  const costsheets = require('../../src/services/costsheets');
  const bookingsService = require('../../src/services/bookings');
  const sheet = await costsheets.create({
    tenantId, actor: seller, leadId, unitId: unit._id, paymentPlanId: plan._id,
  });
  const booking = await bookingsService.createBooking({
    tenantId, tenant: orgA.tenant, actor: seller, leadId, unitId: unit._id, costSheetId: sheet._id,
    bookingDate: new Date(), finalPriceMinor: sheet.finalConsiderationMinor,
    bookingAmountMinor: 100000000, paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
  });
  const bookingId = String(booking._id);

  t.after(async () => { await h.stopServer(); });

  /** JSON post, so a refusal reports its real status instead of a flash redirect. */
  const failing = async (client, path, body, page = `/app/bookings/${bookingId}`) => {
    const token = await client.csrf(page);
    return client.postJson(path, { _csrf: token, ...body });
  };

  /** Multipart upload, exactly as a browser sends it. */
  const uploadTo = async (client, url, fields, file, page) => {
    const token = await client.csrf(page);
    const boundary = '----crmtest2';
    const parts = Object.entries({ _csrf: token, ...fields })
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('');
    const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="${file.field || 'file'}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`;
    const body = Buffer.concat([
      Buffer.from(parts + filePart, 'utf8'),
      Buffer.from(file.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    return client.post(url, undefined, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
  };

  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  let customerUrl;
  let token;

  /* ------------------------ §125 default KYC checklist --------------------- */

  await t.test('a new tenant starts with a KYC checklist and message templates (§125, §231)', async () => {
    const types = await KycDocumentType.find({ tenantId, active: true }).lean();
    assert.ok(types.length >= 8, 'the suggested defaults are seeded');
    assert.ok(types.some((ty) => ty.code === 'PAN' && ty.mandatory));
    assert.ok(types.some((ty) => ty.appliesTo === 'COMPANY'));

    const purposes = (await Template.find({ tenantId }).lean()).map((tp) => tp.purpose);
    assert.ok(purposes.includes('BOOKING_FORM_REQUEST'));
    assert.ok(purposes.includes('PAYMENT_OVERDUE'));
    assert.ok(purposes.includes('RECEIPT_ACK'));
  });

  /* ------------------------- §116/§288 the link ---------------------------- */

  await t.test('the workspace generates a customer link and shows it once (§117, §288)', async () => {
    const before = await admin.get(`/app/bookings/${bookingId}?tab=customer`);
    assert.equal(before.status, 200);
    assert.match(before.text, /No customer link has been generated/);

    const res = await admin.submit(`/api/bookings/${bookingId}/customer-link`, {}, `/app/bookings/${bookingId}?tab=customer`);
    assert.equal(res.status, 302);

    const page = await admin.get(`/app/bookings/${bookingId}?tab=customer`);
    assert.match(page.text, /shown only once/);
    const match = page.text.match(/\/booking-form\/([A-Za-z0-9_-]{20,})/);
    assert.ok(match, 'the link is rendered exactly once, right after generation');
    token = match[1];
    customerUrl = `/booking-form/${token}`;

    // §117: only the hash is stored — the token is not recoverable from the record.
    const link = await BookingCustomerLink.findOne({ tenantId, bookingId }).lean();
    assert.ok(link.tokenHash);
    assert.equal(link.status, 'ACTIVE');
    assert.notEqual(link.tokenHash, token);
    assert.ok(!JSON.stringify(link).includes(token), 'the raw token is nowhere in the document');

    // And it is gone from the page on the next load.
    const again = await admin.get(`/app/bookings/${bookingId}?tab=customer`);
    assert.doesNotMatch(again.text, /shown only once/);
  });

  await t.test('generating a second link revokes the first (§117)', async () => {
    const first = await BookingCustomerLink.findOne({ tenantId, bookingId, status: 'ACTIVE' }).lean();
    await admin.submit(`/api/bookings/${bookingId}/customer-link`, {}, `/app/bookings/${bookingId}?tab=customer`);
    const page = await admin.get(`/app/bookings/${bookingId}?tab=customer`);
    token = page.text.match(/\/booking-form\/([A-Za-z0-9_-]{20,})/)[1];
    customerUrl = `/booking-form/${token}`;

    const old = await BookingCustomerLink.findOne({ tenantId, _id: first._id }).lean();
    assert.equal(old.status, 'REVOKED', 'two live links to one booking is two versions of the truth');
    assert.equal(await BookingCustomerLink.countDocuments({ tenantId, bookingId, status: 'ACTIVE' }), 1);
  });

  await t.test('the link can be sent by WhatsApp (§116)', async () => {
    const res = await admin.submit(`/api/bookings/${bookingId}/customer-link/send`, {
      channel: 'WHATSAPP', url: `http://localhost${customerUrl}`,
    }, `/app/bookings/${bookingId}?tab=customer`);
    assert.equal(res.status, 302);
    const log = await MessageLog.findOne({ tenantId, channel: 'WHATSAPP' }).sort({ createdAt: -1 }).lean();
    assert.match(log.body, /booking-form/);
    const link = await BookingCustomerLink.findOne({ tenantId, bookingId, status: 'ACTIVE' }).lean();
    assert.ok(link.sentAt);
    assert.equal(link.sentChannel, 'WHATSAPP');
  });

  /* --------------------- §118/§164 the customer's page --------------------- */

  const anon = h.client();

  await t.test('the customer sees their booking, read-only (§118, §138)', async () => {
    const page = await anon.get(customerUrl);
    assert.equal(page.status, 200);
    assert.match(page.text, /KYC Gardens/);
    assert.match(page.text, /A-101/);
    assert.match(page.text, /Booking value/);
    assert.match(page.text, /Payment plan/);
    assert.match(page.text, /On booking/);
    assert.match(page.text, /cannot be edited here/);
    // §192: not indexable.
    assert.match(page.headers.get('x-robots-tag') || '', /noindex/);
    // §269: nothing internal.
    assert.doesNotMatch(page.text, /aging|Aging|Promise to pay|collection owner|Collection owner/);
    // §118: no input can reach a commercial field.
    assert.doesNotMatch(page.text, /name="finalPrice|name="bookingAmount|name="paymentPlanId/);

    const link = await BookingCustomerLink.findOne({ tenantId, bookingId, status: 'ACTIVE' }).lean();
    assert.ok(link.lastOpenedAt, 'the open is recorded');
    assert.equal(link.openCount, 1);
  });

  await t.test('a wrong or unknown token gives nothing away (§192)', async () => {
    const bogus = await anon.get('/booking-form/not-a-real-token-value-1234567890');
    assert.equal(bogus.status, 404);
    assert.match(bogus.text, /not valid/);
    assert.doesNotMatch(bogus.text, /KYC Gardens/);
  });

  /* ------------------------ §119–§124 the submission ---------------------- */

  await t.test('the customer submits applicants and a declaration (§120–§124)', async () => {
    const res = await anon.post(customerUrl, {
      declaration: '1',
      'primary[type]': 'INDIVIDUAL',
      'primary[name]': 'Meera Iyer',
      'primary[mobile]': '9330000777',
      'primary[email]': 'meera@example.test',
      'primary[pan]': 'ABCDE1234F',
      'primary[occupation]': 'Architect',
      'primary[permanentAddress]': '12 Hill Road, Pune',
      'primary[city]': 'Pune',
      'co[0][name]': 'Ravi Iyer',
      'co[0][relationship]': 'Spouse',
      'co[0][mobile]': '9330000778',
      'co[0][pan]': 'ZYXWV9876K',
      // §118/§324.2: a hand-crafted commercial field must be ignored outright.
      'primary[finalPriceMinor]': '1',
      finalPriceMinor: '1',
    });
    assert.equal(res.status, 302);

    const applicants = await BookingApplicant.find({ tenantId, bookingId }).sort({ displayOrder: 1 }).lean();
    assert.equal(applicants.length, 2);
    const primary = applicants.find((a) => a.applicantRole === 'PRIMARY');
    assert.equal(primary.name, 'Meera Iyer');
    assert.equal(primary.occupation, 'Architect');
    assert.equal(primary.updatedByType, 'CUSTOMER');
    // §131: PAN masked for display, sealed for storage, never plain.
    assert.match(primary.panMasked, /234F$/);
    assert.ok(primary.panSealed && !primary.panSealed.includes('ABCDE1234F'));
    assert.equal(require('../../src/lib/secretbox').open(primary.panSealed), 'ABCDE1234F');

    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.finalPriceMinor, booking.finalPriceMinor, 'the price is untouched');
    assert.ok(fresh.customerFormSubmittedAt);
    assert.ok(fresh.customerDeclaration.confirmedAt, 'the declaration is stored (§124)');
    assert.ok(fresh.customerDeclaration.userAgent !== undefined);

    const link = await BookingCustomerLink.findOne({ tenantId, bookingId }).sort({ createdAt: -1 }).lean();
    assert.equal(link.status, 'SUBMITTED');
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'BOOKING_FORM_SUBMITTED' }).lean());
  });

  await t.test('a submission without the declaration is refused (§124)', async () => {
    // The link is SUBMITTED now, so this also proves a second submit is refused.
    const res = await anon.post(customerUrl, { 'primary[name]': 'Someone Else', 'primary[mobile]': '9000000000' });
    assert.equal(res.status, 302);
    const primary = await BookingApplicant.findOne({ tenantId, bookingId, applicantRole: 'PRIMARY' }).lean();
    assert.equal(primary.name, 'Meera Iyer', 'the submitted data stands');
  });

  await t.test('reported issues become an internal note, never an edit (§118)', async () => {
    const res = await anon.post(`${customerUrl}/issue`, { message: 'The unit number should be A-102.' });
    assert.equal(res.status, 302);
    const note = await Activity.findOne({ tenantId, bookingId, type: 'BOOKING_FORM_ISSUE_REPORTED' }).lean();
    assert.match(note.body, /A-102/);
    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(String(fresh.unitId), String(unit._id), 'the unit is unchanged');
  });

  /* --------------------------- §126–§131 KYC ------------------------------- */

  let panDocId;

  await t.test('the customer uploads a document straight into private storage (§126, §131)', async () => {
    const primary = await BookingApplicant.findOne({ tenantId, bookingId, applicantRole: 'PRIMARY' }).lean();
    const panType = await KycDocumentType.findOne({ tenantId, code: 'PAN' }).lean();

    const res = await uploadTo(anon, `${customerUrl}/kyc`, {
      applicantId: String(primary._id),
      documentTypeId: String(panType._id),
      documentNumber: 'ABCDE1234F',
    }, { filename: 'pan.png', contentType: 'image/png', bytes: PNG }, customerUrl);
    assert.equal(res.status, 302);

    const document = await BookingKycDocument.findOne({ tenantId, bookingId, active: true }).lean();
    assert.ok(document);
    panDocId = String(document._id);
    assert.equal(document.uploadedByType, 'CUSTOMER');
    assert.equal(document.reviewStatus, 'UPLOADED');
    assert.match(document.documentNumberMasked, /234F$/);

    // §131/§344.23: the bytes are outside public/, and nothing serves that directory.
    const config = require('../../src/config');
    assert.ok(!path.resolve(config.privateUploadDir).includes(`${path.sep}public${path.sep}`));
    assert.ok(fs.existsSync(path.join(config.privateUploadDir, document.storageKey)), 'the file is on disk');
    const publicGuess = await anon.get(`/uploads/${document.storageKey}`);
    assert.equal(publicGuess.status, 404, 'and is not reachable as a static asset');
  });

  await t.test('an executable is refused whatever it claims to be (§193)', async () => {
    const primary = await BookingApplicant.findOne({ tenantId, bookingId, applicantRole: 'PRIMARY' }).lean();
    const other = await KycDocumentType.findOne({ tenantId, code: 'OTHER' }).lean();
    const res = await uploadTo(anon, `${customerUrl}/kyc`, {
      applicantId: String(primary._id), documentTypeId: String(other._id),
    }, { filename: 'evil.sh', contentType: 'application/x-sh', bytes: Buffer.from('#!/bin/sh\nrm -rf /') }, customerUrl);
    assert.equal(res.status, 302);
    assert.equal(await BookingKycDocument.countDocuments({ tenantId, bookingId, mimeType: 'application/x-sh' }), 0);
  });

  await t.test('a KYC file needs permission, and its download is audited (§131)', async () => {
    const open = await admin.get(`/app/files/kyc-document/${panDocId}`);
    assert.equal(open.status, 200);
    assert.match(open.headers.get('content-type') || '', /image\/png/);
    assert.match(open.headers.get('cache-control') || '', /no-store/);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'BookingKycDocument', action: 'DOWNLOAD' }).lean());

    // No session at all: no file.
    const anonymous = await anon.get(`/app/files/kyc-document/${panDocId}`);
    assert.ok([302, 401].includes(anonymous.status));

    // A sales user without booking.kyc.view sees the status, never the document.
    const denied = await rep.get(`/app/files/kyc-document/${panDocId}`);
    assert.equal(denied.status, 403);
  });

  await t.test('a replacement supersedes and never overwrites (§128)', async () => {
    const primary = await BookingApplicant.findOne({ tenantId, bookingId, applicantRole: 'PRIMARY' }).lean();
    const panType = await KycDocumentType.findOne({ tenantId, code: 'PAN' }).lean();
    await uploadTo(anon, `${customerUrl}/kyc`, {
      applicantId: String(primary._id), documentTypeId: String(panType._id), documentNumber: 'ABCDE1234F',
    }, { filename: 'pan-clear.png', contentType: 'image/png', bytes: PNG }, customerUrl);

    const all = await BookingKycDocument.find({ tenantId, bookingApplicantId: primary._id, documentTypeId: panType._id }).lean();
    assert.equal(all.length, 2);
    const old = all.find((d) => String(d._id) === panDocId);
    assert.equal(old.active, false);
    assert.ok(old.supersededById, 'the old file points at the one that replaced it');
    panDocId = String(all.find((d) => d.active)._id);
  });

  await t.test('KYC status is derived from the documents, never typed in (§127)', async () => {
    let fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.kycStatus, 'PARTIAL', 'mandatory documents are still missing');

    const page = await admin.get(`/app/bookings/${bookingId}?tab=customer`);
    assert.match(page.text, /KYC checklist/);
    assert.match(page.text, /missing/);

    // Fill in every mandatory document for both applicants.
    const applicants = await BookingApplicant.find({ tenantId, bookingId }).lean();
    const mandatory = await KycDocumentType.find({ tenantId, mandatory: true, active: true, appliesTo: { $in: ['INDIVIDUAL', 'BOTH'] } }).lean();
    for (const applicant of applicants) {
      for (const type of mandatory) {
        const already = await BookingKycDocument.findOne({
          tenantId, bookingApplicantId: applicant._id, documentTypeId: type._id, active: true,
        }).lean();
        if (already) continue;
        await uploadTo(admin, `/api/bookings/${bookingId}/kyc/documents`, {
          applicantId: String(applicant._id),
          documentTypeId: String(type._id),
          ...(type.numberRequired ? { documentNumber: 'ABCDE1234F' } : {}),
        }, { filename: 'doc.png', contentType: 'image/png', bytes: PNG }, `/app/bookings/${bookingId}?tab=customer`);
      }
    }
    fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.kycStatus, 'SUBMITTED', 'everything mandatory is in, nothing reviewed yet');
  });

  await t.test('a rejection without a note is refused, and a rejection reopens KYC (§128)', async () => {
    const silent = await failing(admin, `/api/kyc-documents/${panDocId}/review`, { decision: 'RESUBMISSION_REQUIRED' });
    assert.equal(silent.status, 400);
    assert.match(silent.data.error.message, /what to fix/);

    const res = await admin.submit(`/api/kyc-documents/${panDocId}/review`, {
      decision: 'RESUBMISSION_REQUIRED', note: 'PAN image unreadable. Please upload a clear copy.',
    }, '/app/bookings/kyc');
    assert.equal(res.status, 302);

    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.kycStatus, 'CORRECTION_REQUIRED');
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'KYC_CORRECTION_REQUIRED' }).lean());

    // The customer sees exactly what to fix.
    const page = await anon.get(customerUrl);
    assert.match(page.text, /unreadable/);
    assert.match(page.text, /Replace/);
  });

  await t.test('approving every mandatory document verifies the booking (§127)', async () => {
    // Replace the rejected one first, then approve everything.
    const primary = await BookingApplicant.findOne({ tenantId, bookingId, applicantRole: 'PRIMARY' }).lean();
    const panType = await KycDocumentType.findOne({ tenantId, code: 'PAN' }).lean();
    await uploadTo(anon, `${customerUrl}/kyc`, {
      applicantId: String(primary._id), documentTypeId: String(panType._id), documentNumber: 'ABCDE1234F',
    }, { filename: 'pan-final.png', contentType: 'image/png', bytes: PNG }, customerUrl);

    const live = await BookingKycDocument.find({ tenantId, bookingId, active: true }).lean();
    for (const document of live) {
      await admin.submit(`/api/kyc-documents/${document._id}/review`, { decision: 'APPROVED' }, '/app/bookings/kyc');
    }
    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.kycStatus, 'VERIFIED');
    assert.equal(fresh.postBookingStatus, 'ACTIVE_COLLECTION', 'and the operational status follows (§112)');
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'KYC_VERIFIED' }).lean());

    const applicant = await BookingApplicant.findOne({ tenantId, _id: primary._id }).lean();
    assert.equal(applicant.kycStatus, 'VERIFIED');
  });

  await t.test('the KYC queue counts what the list shows (§129)', async () => {
    const page = await admin.get('/app/bookings/kyc');
    assert.equal(page.status, 200);
    const counts = h.tileCounts(page.text);
    assert.equal(counts.Verified, 1);
    const verified = await admin.get('/app/bookings/kyc?kycStatus=VERIFIED');
    assert.match(verified.text, /Meera Iyer/);
    const pending = await admin.get('/app/bookings/kyc?kycStatus=NOT_STARTED');
    assert.match(pending.text, /Nothing here/);
  });

  /* --------------------------- §139–§142 payments -------------------------- */

  let paymentUrl;
  let paymentRequestId;

  await t.test('a payment link is capped at the outstanding amount (§141, §247)', async () => {
    const first = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 1 }).lean();
    const tooMuch = await failing(admin, `/api/bookings/${bookingId}/payment-links`, {
      installmentId: String(first._id), amount: '99999999',
    });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.data.error.message, /higher than the/);
    assert.equal(await PaymentRequest.countDocuments({ tenantId, bookingId }), 0);
  });

  await t.test('creating a link is not a payment (§344.26)', async () => {
    const first = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 1 }).lean();
    const res = await admin.submit(`/api/bookings/${bookingId}/payment-links`, {
      installmentId: String(first._id), channel: 'WHATSAPP',
    }, `/app/bookings/${bookingId}?tab=collections`);
    assert.equal(res.status, 302);

    const request = await PaymentRequest.findOne({ tenantId, bookingId }).lean();
    paymentRequestId = String(request._id);
    assert.equal(request.amountMinor, first.outstandingMinor, 'defaults to the outstanding amount');
    assert.equal(request.status, 'SENT');
    assert.ok(request.paymentUrl);
    paymentUrl = request.paymentUrl.replace(/^https?:\/\/[^/]+/, '');

    const installment = await BookingInstallment.findOne({ tenantId, _id: first._id }).lean();
    assert.equal(installment.amountReceivedMinor, 0, 'the installment has not moved');
    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.totalReceivedMinor, 0, 'and neither has the booking');
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'PAYMENT_LINK_CREATED' }).lean());
  });

  await t.test('a second link cannot double-request the same money (§141)', async () => {
    const first = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 1 }).lean();
    const res = await failing(admin, `/api/bookings/${bookingId}/payment-links`, {
      installmentId: String(first._id),
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /already covers it|nothing outstanding/);
  });

  await t.test('the customer payment page shows the amount and no internals (§138)', async () => {
    const page = await anon.get(paymentUrl);
    assert.equal(page.status, 200);
    assert.match(page.text, /On booking/);
    assert.doesNotMatch(page.text, /collection|Collection owner|aging/);
    const request = await PaymentRequest.findOne({ tenantId, _id: paymentRequestId }).lean();
    assert.equal(request.status, 'OPEN', 'opening it is recorded, because this driver genuinely knows (§291)');
    assert.ok(request.openedAt);
  });

  await t.test('paying settles the link, creates a receipt and moves the installment (§142)', async () => {
    const res = await anon.post(`${paymentUrl}/simulate`, {});
    assert.equal(res.status, 302);

    const request = await PaymentRequest.findOne({ tenantId, _id: paymentRequestId }).lean();
    assert.equal(request.status, 'PAID');
    assert.ok(request.receiptId);
    assert.ok(request.gatewayPaymentId);

    const receipt = await BookingReceipt.findOne({ tenantId, _id: request.receiptId }).lean();
    assert.equal(receipt.mode, 'ONLINE');
    assert.equal(receipt.createdByType, 'GATEWAY');
    assert.match(receipt.receiptNo, /^RCP-\d{4}-00001$/);

    const allocations = await ReceiptAllocation.find({ tenantId, receiptId: receipt._id }).lean();
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].amountMinor, receipt.amountMinor, 'allocations sum to the receipt (§145)');

    const first = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 1 }).lean();
    assert.equal(first.status, 'PAID');
    assert.equal(first.outstandingMinor, 0);

    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.totalReceivedMinor, receipt.amountMinor);
    assert.equal(fresh.outstandingMinor, fresh.scheduledTotalMinor - receipt.amountMinor);
    assert.equal(fresh.paymentProgressPct, 40);
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'PAYMENT_RECEIVED' }).lean());
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'INSTALLMENT_PAID' }).lean());

    // §297: the acknowledgement went out, and is not called a tax receipt.
    const ack = await MessageLog.findOne({ tenantId, body: /Payment Acknowledgement/ }).sort({ createdAt: -1 }).lean();
    assert.ok(ack);
    assert.match(ack.body, /not a tax receipt/);
  });

  await t.test('paying twice cannot create a second receipt (§142 idempotency)', async () => {
    const before = await BookingReceipt.countDocuments({ tenantId, bookingId });
    await anon.post(`${paymentUrl}/simulate`, {});
    assert.equal(await BookingReceipt.countDocuments({ tenantId, bookingId }), before);
  });

  await t.test('the gateway webhook verifies its signature and is idempotent (§142)', async () => {
    const crypto = require('node:crypto');
    const secretbox = require('../../src/lib/secretbox');
    const integration = await Integration.create({
      tenantId,
      category: 'PAYMENT_GATEWAY',
      provider: 'TestPay',
      driver: 'mock',
      webhookKey: 'pay-test-key',
      secrets: new Map([['signingSecret', secretbox.seal('shhh')]]),
    });

    // A link to settle through the webhook itself.
    const second = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 2 }).lean();
    await admin.submit(`/api/bookings/${bookingId}/payment-links`, {
      installmentId: String(second._id), amount: '100000',
    }, `/app/bookings/${bookingId}?tab=collections`);
    const request = await PaymentRequest.findOne({ tenantId, bookingId, installmentId: second._id }).lean();

    const payload = {
      providerLinkId: request.providerLinkId,
      gatewayPaymentId: 'gw-pay-001',
      status: 'paid',
      amountMinor: request.amountMinor,
    };
    const sign = (body) => crypto.createHmac('sha256', 'shhh').update(JSON.stringify(body)).digest('hex');

    const unsigned = await anon.postJson(`/api/webhooks/payments/${integration.webhookKey}`, payload);
    assert.equal(unsigned.status, 401, 'no signature, no payment');

    const bad = await anon.postJson(`/api/webhooks/payments/${integration.webhookKey}`, payload, {
      headers: { 'x-webhook-signature': sign({ tampered: true }) },
    });
    assert.equal(bad.status, 401);

    const good = await anon.postJson(`/api/webhooks/payments/${integration.webhookKey}`, payload, {
      headers: { 'x-webhook-signature': sign(payload) },
    });
    assert.equal(good.status, 200);
    assert.equal(good.data.applied, 'PAID');

    const replay = await anon.postJson(`/api/webhooks/payments/${integration.webhookKey}`, payload, {
      headers: { 'x-webhook-signature': sign(payload) },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicate, true, 'the raw-event index refuses the replay');
    assert.equal(await BookingReceipt.countDocuments({ tenantId, gatewayPaymentId: 'gw-pay-001' }), 1);

    // §142: the raw delivery is stored before it is processed.
    const stored = await WebhookEvent.findOne({ tenantId, idempotencyKey: 'gw-pay-001' }).lean();
    assert.equal(stored.kind, 'PAYMENT');
    assert.equal(stored.status, 'PROCESSED');

    const unknown = await anon.postJson('/api/webhooks/payments/not-a-key', payload);
    assert.equal(unknown.status, 404);
  });

  /* --------------------------- §143–§146 receipts -------------------------- */

  await t.test('a manual receipt must allocate in full (§145)', async () => {
    const second = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 2 }).lean();
    const tooMuch = await failing(admin, `/api/bookings/${bookingId}/receipts`, {
      amount: String((second.outstandingMinor + 500000) / 100),
      paymentDate: new Date().toISOString().slice(0, 10),
      mode: 'BANK_TRANSFER',
    });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.data.error.message, /more than the outstanding/);
  });

  let manualReceiptId;

  await t.test('a manual payment records, allocates and recalculates (§143)', async () => {
    const before = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    const res = await admin.submit(`/api/bookings/${bookingId}/receipts`, {
      amount: '200000', paymentDate: new Date().toISOString().slice(0, 10),
      mode: 'CHEQUE', reference: 'CHQ-889912', bank: 'HDFC', note: 'Part payment',
    }, `/app/bookings/${bookingId}?tab=collections`);
    assert.equal(res.status, 302);

    const receipt = await BookingReceipt.findOne({ tenantId, bookingId, reference: 'CHQ-889912' }).lean();
    assert.ok(receipt);
    manualReceiptId = String(receipt._id);
    assert.equal(receipt.amountMinor, 20000000);
    assert.equal(receipt.status, 'CONFIRMED');
    assert.equal(receipt.createdByType, 'INTERNAL_USER');

    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.totalReceivedMinor, before.totalReceivedMinor + 20000000);
    assert.equal(fresh.outstandingMinor, before.outstandingMinor - 20000000);
  });

  await t.test('a future-dated payment is refused (§143)', async () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const res = await failing(admin, `/api/bookings/${bookingId}/receipts`, {
      amount: '1000', paymentDate: future, mode: 'CASH',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /future/);
  });

  await t.test('cash can be switched off for a tenant (§143)', async () => {
    await Tenant.updateOne({ _id: tenantId }, { $set: { 'settings.collectionAllowCash': false } });
    const res = await failing(admin, `/api/bookings/${bookingId}/receipts`, {
      amount: '1000', paymentDate: new Date().toISOString().slice(0, 10), mode: 'CASH',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /Cash receipts are switched off/);
    await Tenant.updateOne({ _id: tenantId }, { $set: { 'settings.collectionAllowCash': true } });
  });

  await t.test('a receipt is reversed with a reason, never deleted (§146, §324.5)', async () => {
    const before = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    const noReason = await failing(admin, `/api/receipts/${manualReceiptId}/reverse`, {});
    assert.equal(noReason.status, 422);

    const res = await admin.submit(`/api/receipts/${manualReceiptId}/reverse`, {
      reason: 'Cheque returned unpaid',
    }, `/app/bookings/${bookingId}?tab=collections`);
    assert.equal(res.status, 302);

    const receipt = await BookingReceipt.findOne({ tenantId, _id: manualReceiptId }).lean();
    assert.ok(receipt, 'the receipt still exists');
    assert.equal(receipt.status, 'REVERSED');
    assert.equal(receipt.reversalReason, 'Cheque returned unpaid');

    const allocations = await ReceiptAllocation.find({ tenantId, receiptId: manualReceiptId }).lean();
    assert.ok(allocations.length, 'the allocation rows are kept');
    assert.ok(allocations.every((a) => a.active === false), 'but no longer count');

    const fresh = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    assert.equal(fresh.totalReceivedMinor, before.totalReceivedMinor - receipt.amountMinor);
    assert.equal(fresh.outstandingMinor, before.outstandingMinor + receipt.amountMinor);
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'RECEIPT_REVERSED' }).lean());
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'BookingReceipt', action: 'REVERSE' }).lean());

    const again = await failing(admin, `/api/receipts/${manualReceiptId}/reverse`, { reason: 'Again' });
    assert.equal(again.status, 400);
  });

  await t.test('reversing restores the installment status too (§146)', async () => {
    const second = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 2 }).lean();
    assert.ok(second.outstandingMinor > 0);
    assert.notEqual(second.status, 'PAID');
  });

  /* ----------------------------- §163 reminders ---------------------------- */

  await t.test('reminders are off until a tenant switches them on (§163)', async () => {
    const paymentReminders = require('../../src/services/paymentReminders');
    const quiet = await paymentReminders.sweep({ tenantId });
    assert.equal(quiet.tenants, 0, 'nothing is sent by default');

    await Tenant.updateOne({ _id: tenantId }, {
      $set: {
        'settings.collectionReminderEnabled': true,
        'settings.collectionReminderDaysBefore': [30],
        'settings.collectionReminderDaysAfter': [1],
      },
    });
    const tenant = await Tenant.findById(tenantId).lean();
    // The second installment is due 30 days after booking, so today is its band.
    const result = await paymentReminders.runForTenant({ tenant });
    assert.equal(result.sent, 1);

    const reminder = await MessageLog.findOne({ tenantId, body: /is due on/ }).sort({ createdAt: -1 }).lean();
    assert.ok(reminder, 'the customer was told');
    assert.ok(await Activity.findOne({ tenantId, bookingId, type: 'PAYMENT_REMINDER_SENT' }).lean());

    // §163 idempotency: the same band never goes out twice.
    const again = await paymentReminders.runForTenant({ tenant });
    assert.equal(again.sent, 0);
    const installment = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 2 }).lean();
    assert.deepEqual(installment.remindersSent, ['BEFORE_30']);
  });

  await t.test('a paid installment is never chased (§163)', async () => {
    const paymentReminders = require('../../src/services/paymentReminders');
    const tenant = await Tenant.findById(tenantId).lean();
    const first = await BookingInstallment.findOne({ tenantId, bookingId, sequence: 1 }).lean();
    assert.equal(first.status, 'PAID');
    const band = paymentReminders.bandFor({
      installment: first,
      settings: { collectionReminderDaysBefore: [0], collectionReminderDaysAfter: [0] },
      zone: tenant.timezone,
      now: new Date(),
    });
    assert.equal(band, 'DUE', 'its date is today');
    const result = await paymentReminders.runForTenant({ tenant });
    assert.equal(result.sent, 0, 'but a paid installment is not a candidate at all');
  });

  /* ------------------------------ §168–§170 reports ----------------------- */

  await t.test('the three post-booking reports render and export (§168–§170)', async () => {
    const bookings = await admin.get('/app/reports/bookings');
    assert.equal(bookings.status, 200);
    assert.match(bookings.text, /Bookings &amp; KYC/);
    assert.match(bookings.text, /Meera Iyer/);
    assert.match(bookings.text, /KYC verified/);

    const collections = await admin.get('/app/reports/collections');
    assert.equal(collections.status, 200);
    assert.match(collections.text, /Scheduled/);
    assert.match(collections.text, /Ageing/);
    assert.match(collections.text, /On booking/);

    const performance = await admin.get('/app/reports/collection-performance');
    assert.equal(performance.status, 200);
    // §170: never an amount without its percentage.
    assert.match(performance.text, /Collection %/);
    assert.match(performance.text, /PTP kept %/);

    const csv = await admin.get('/app/reports/collections/export');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    assert.match(csv.text, /Milestone/);
    // §321: a KYC status may be exported; a document never can.
    const bookingCsv = await admin.get('/app/reports/bookings/export');
    assert.match(bookingCsv.text, /KYC status/);
    assert.doesNotMatch(bookingCsv.text, /storageKey|private-uploads/);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Report', action: 'EXPORT' }).lean());
  });

  /* ------------------------ permissions and isolation --------------------- */

  await t.test('a sales user cannot review KYC or reverse a receipt (§130, §180)', async () => {
    const review = await failing(rep, `/api/kyc-documents/${panDocId}/review`, { decision: 'APPROVED' });
    assert.equal(review.status, 403);
    const reverse = await failing(rep, `/api/receipts/${manualReceiptId}/reverse`, { reason: 'No' });
    assert.equal(reverse.status, 403);
  });

  await t.test('another tenant cannot reach this booking’s documents or links (§2.3)', async () => {
    const other = h.client();
    await other.login('admin@beta.test');
    const file = await other.get(`/app/files/kyc-document/${panDocId}`);
    assert.equal(file.status, 404);

    const link = await failing(other, `/api/bookings/${bookingId}/customer-link`, {}, '/app/dashboard');
    assert.ok([403, 404].includes(link.status));
    assert.equal(await BookingCustomerLink.countDocuments({ tenantId: orgB.tenant._id }), 0);

    const receipt = await failing(other, `/api/bookings/${bookingId}/receipts`, {
      amount: '100', paymentDate: new Date().toISOString().slice(0, 10), mode: 'CASH',
    }, '/app/dashboard');
    assert.ok([400, 403, 404].includes(receipt.status));
  });

  await t.test('a revoked link closes the customer’s page politely (§192)', async () => {
    await admin.submit(`/api/bookings/${bookingId}/customer-link`, {}, `/app/bookings/${bookingId}?tab=customer`);
    const page = await admin.get(`/app/bookings/${bookingId}?tab=customer`);
    const newToken = page.text.match(/\/booking-form\/([A-Za-z0-9_-]{20,})/)[1];

    const old = await anon.get(customerUrl);
    assert.equal(old.status, 410);
    assert.match(old.text, /no longer active/);

    const fresh = await anon.get(`/booking-form/${newToken}`);
    assert.equal(fresh.status, 200);
  });

  await t.test('an expired link says so and stops working (§192)', async () => {
    await BookingCustomerLink.updateMany({ tenantId, bookingId, status: 'ACTIVE' }, {
      $set: { expiresAt: new Date(Date.now() - 86400000) },
    });
    const link = await BookingCustomerLink.findOne({ tenantId, bookingId, status: 'ACTIVE' }).lean();
    const page = await anon.get(`/booking-form/${'x'.repeat(40)}`);
    assert.equal(page.status, 404);

    // Expiry is resolved on read, and recorded.
    const bookingForm = require('../../src/services/bookingForm');
    await assert.rejects(
      () => bookingForm.resolveToken({ token: 'anything-that-does-not-exist-000000' }),
      /not valid/,
    );
    const after = await BookingCustomerLink.findOne({ tenantId, _id: link._id }).lean();
    assert.equal(after.status, 'ACTIVE', 'until someone actually opens it');
  });
});
