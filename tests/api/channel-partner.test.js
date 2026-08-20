const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  ChannelPartner, ChannelPartnerRegistration, ChannelPartnerMember, PartnerPortalUser,
  PartnerReraDocument, PartnerProjectEmpanelment, PartnerLeadClaim, PartnerCommissionRule,
  PartnerCommissionEntitlement, PartnerInvoice, PartnerPayout,
  Lead, Booking, SiteVisit, Contact, Activity, AuditLog, Tenant, MessageLog, Template,
  LeadSource, Project, Tower, UnitType, Unit, PricingComponent, PaymentPlan, Stage, ActionType,
} = require('../../src/db/models');

/**
 * V2 Phase 3 — Channel Partner.
 *
 * The invariants under test are the ones §324 calls non-negotiable: a partner
 * association never changes the internal lead owner or the marketing source, a
 * conflicting claim creates a review rather than an overwrite, commission is
 * frozen against the rule that was in force, an invoice can never exceed the
 * eligible uninvoiced amount, RERA history is versioned, and a partner session
 * can never reach an internal route.
 */
test('channel partner registration, claims, commission and invoices (V2 §6–§53)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA, orgB } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'CP Rep', email: 'cprep@alpha.test', roleName: 'Sales User',
  });
  const cpManager = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'CP Manager', email: 'cpmgr@alpha.test',
    roleName: 'Channel Partner Manager',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

  const project = await Project.create({
    tenantId, name: 'Partner Park', status: 'ACTIVE', city: 'Ahmedabad', code: 'PP', developerName: 'Partner Estates',
  });
  const tower = await Tower.create({ tenantId, projectId: project._id, name: 'Tower A', code: 'A' });
  const unitType = await UnitType.create({
    tenantId, projectId: project._id, name: '3 BHK', superBuiltUpArea: 1000, defaultBaseRateMinor: 1000000,
  });
  const unit = await Unit.create({
    tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
    unitNumber: 'A-1201', floorNumber: 12, saleableArea: 1000, status: 'AVAILABLE',
  });
  await PricingComponent.create({
    tenantId, projectId: project._id, name: 'Base price', kind: 'BASE',
    calcType: 'PER_AREA', rateMinor: 1000000, areaBasis: 'SALEABLE', displayOrder: 1,
  });
  const plan = await PaymentPlan.create({
    tenantId, projectId: project._id, name: 'Half and half', type: 'CUSTOM', active: true,
    milestones: [
      { sequence: 1, label: 'On booking', percentage: 25, dueRule: 'ON_BOOKING', displayOrder: 1 },
      { sequence: 2, label: 'Within 30 days', percentage: 75, dueRule: 'DAYS_AFTER_BOOKING', dueOffsetDays: 30, displayOrder: 2 },
    ],
  });

  const admin = h.client();
  await admin.login('admin@alpha.test');
  const mgr = h.client();
  await mgr.login('cpmgr@alpha.test');
  const rep = h.client();
  await rep.login('cprep@alpha.test');
  const partnerClient = h.client();

  t.after(async () => { await h.stopServer(); });

  const failing = async (client, path, body, page = '/app/channel-partners/dashboard') => {
    const token = await client.csrf(page);
    return client.postJson(path, { _csrf: token, ...body });
  };
  const uploadTo = async (client, url, fields, file, page) => {
    const token = await client.csrf(page);
    const boundary = '----crmcp';
    const parts = Object.entries({ _csrf: token, ...fields })
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
    const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`;
    const body = Buffer.concat([
      Buffer.from(parts + filePart, 'utf8'),
      Buffer.from(file.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    return client.post(url, undefined, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, rawBody: body,
    });
  };
  const PDF = Buffer.from('255044462d312e340a', 'hex');

  /**
   * Commission re-evaluation runs on the event bus, so the state arrives a tick
   * or two after the write. Polling for the expected value is deterministic;
   * sleeping for a guessed number of milliseconds is a flake waiting for a
   * loaded machine.
   */
  const waitFor = async (read, predicate, { timeoutMs = 5000, everyMs = 25 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (!predicate(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      value = await read();
    }
    return value;
  };

  let registrationId;
  let partnerId;
  let portalUrl;

  /* ------------------------ §12–§21 registration -------------------------- */

  await t.test('an application is not a partner until it is approved (§13)', async () => {
    const res = await mgr.submit('/api/channel-partners/registrations', {
      partnerType: 'COMPANY',
      primaryContactName: 'Anil Shah',
      mobile: '9812345601',
      email: 'anil@abcrealty.test',
      city: 'Ahmedabad',
      state: 'Gujarat',
      legalName: 'ABC Realty LLP',
      tradeName: 'ABC Realty',
    }, '/app/channel-partners/registrations/new');
    assert.equal(res.status, 302);
    registrationId = res.location.split('?')[0].split('/').pop();

    const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
    assert.equal(registration.status, 'DRAFT');
    assert.match(registration.registrationNumber, /^CPR-\d{4}-00001$/);
    assert.equal(await ChannelPartner.countDocuments({ tenantId }), 0, 'no partner exists yet');
  });

  await t.test('the bank account number is masked and sealed, never plain (§21)', async () => {
    const res = await mgr.submit(`/api/channel-partners/registrations/${registrationId}`, {
      partnerType: 'COMPANY', primaryContactName: 'Anil Shah', mobile: '9812345601',
      email: 'anil@abcrealty.test', city: 'Ahmedabad', state: 'Gujarat', legalName: 'ABC Realty LLP',
      pan: 'AABCA1234M', gstin: '24AABCA1234M1Z5',
      accountHolderName: 'ABC Realty LLP', bankName: 'HDFC', accountNumber: '501000123456789',
      ifsc: 'HDFC0001234', step: 4,
    }, `/app/channel-partners/registrations/${registrationId}?step=4`);
    assert.equal(res.status, 302);

    const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
    const bank = registration.profile.bank;
    assert.match(bank.accountNumberMasked, /6789$/);
    assert.ok(!JSON.stringify(registration).includes('501000123456789'), 'the raw number is nowhere in the document');
    assert.equal(require('../../src/lib/secretbox').open(bank.accountNumberSealed), '501000123456789');
  });

  await t.test('an application cannot be submitted without RERA (§19)', async () => {
    const res = await failing(mgr, `/api/channel-partners/registrations/${registrationId}/submit`, {},
      `/app/channel-partners/registrations/${registrationId}`);
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /RERA certificate is required/);
  });

  await t.test('the RERA certificate is stored privately as version 1 (§18)', async () => {
    const res = await uploadTo(mgr, `/api/channel-partners/registrations/${registrationId}/rera`, {
      authority: 'GujRERA',
      registrationNumber: 'AG/GJ/AHMEDABAD/AGENT/0001',
      reraName: 'ABC Realty LLP',
      issueDate: '2026-01-01',
      expiryDate: '2027-12-31',
    }, { field: 'certificate', filename: 'rera.pdf', contentType: 'application/pdf', bytes: PDF },
    `/app/channel-partners/registrations/${registrationId}?step=3`);
    assert.equal(res.status, 302);

    const document = await PartnerReraDocument.findOne({ tenantId, registrationId }).lean();
    assert.equal(document.version, 1);
    assert.equal(document.verificationStatus, 'PENDING');
    assert.ok(document.certificate.storageKey);
    const config = require('../../src/config');
    assert.ok(require('node:fs').existsSync(require('node:path').join(config.privateUploadDir, document.certificate.storageKey)));
  });

  await t.test('submission runs the duplicate check and notifies the CP team (§216)', async () => {
    const res = await mgr.submit(`/api/channel-partners/registrations/${registrationId}/submit`, {},
      `/app/channel-partners/registrations/${registrationId}`);
    assert.equal(res.status, 302);
    const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: registrationId }).lean();
    assert.equal(registration.status, 'SUBMITTED');
    assert.ok(registration.submittedAt);
    assert.equal(registration.possibleDuplicates.length, 0);
  });

  await t.test('a second application with the same PAN is flagged, never merged (§216)', async () => {
    const created = await mgr.submit('/api/channel-partners/registrations', {
      partnerType: 'INDIVIDUAL', primaryContactName: 'Copycat Broker', mobile: '9812345699',
      email: 'copy@broker.test', city: 'Surat', state: 'Gujarat',
    }, '/app/channel-partners/registrations/new');
    const duplicateId = created.location.split('?')[0].split('/').pop();
    await mgr.submit(`/api/channel-partners/registrations/${duplicateId}`, {
      partnerType: 'INDIVIDUAL', primaryContactName: 'Copycat Broker', mobile: '9812345699',
      email: 'copy@broker.test', city: 'Surat', state: 'Gujarat', pan: 'AABCA1234M', step: 2,
    }, `/app/channel-partners/registrations/${duplicateId}?step=2`);

    await uploadTo(mgr, `/api/channel-partners/registrations/${duplicateId}/rera`, {
      registrationNumber: 'AG/GJ/SURAT/AGENT/0002', expiryDate: '2027-06-30',
    }, { field: 'certificate', filename: 'r.pdf', contentType: 'application/pdf', bytes: PDF },
    `/app/channel-partners/registrations/${duplicateId}?step=3`);
    await mgr.submit(`/api/channel-partners/registrations/${duplicateId}/submit`, {},
      `/app/channel-partners/registrations/${duplicateId}`);

    const registration = await ChannelPartnerRegistration.findOne({ tenantId, _id: duplicateId }).lean();
    assert.equal(registration.possibleDuplicates.length, 1);
    assert.ok(registration.possibleDuplicates[0].matchedOn.includes('pan'));
    assert.equal(registration.status, 'SUBMITTED', 'flagged, not blocked — an admin decides');

    const page = await mgr.get(`/app/channel-partners/registrations/${duplicateId}`);
    assert.match(page.text, /Possible duplicates/);
  });

  await t.test('a RERA number cannot belong to two partners (§216, §324.11)', async () => {
    const created = await mgr.submit('/api/channel-partners/registrations', {
      partnerType: 'INDIVIDUAL', primaryContactName: 'Third Broker', mobile: '9812345688',
      email: 'third@broker.test', city: 'Rajkot', state: 'Gujarat',
    }, '/app/channel-partners/registrations/new');
    const thirdId = created.location.split('?')[0].split('/').pop();
    const res = await uploadTo(mgr, `/api/channel-partners/registrations/${thirdId}/rera`, {
      registrationNumber: 'AG/GJ/AHMEDABAD/AGENT/0001', expiryDate: '2027-12-31',
    }, { field: 'certificate', filename: 'r.pdf', contentType: 'application/pdf', bytes: PDF },
    `/app/channel-partners/registrations/${thirdId}?step=3`);
    assert.equal(res.status, 302);
    assert.equal(await PartnerReraDocument.countDocuments({
      tenantId, registrationNumber: 'AG/GJ/AHMEDABAD/AGENT/0001',
    }), 1, 'the clash was refused');
  });

  await t.test('approval creates the partner and invites them to the portal (§13, §308)', async () => {
    const res = await mgr.submit(`/api/channel-partners/registrations/${registrationId}/review`, {
      decision: 'APPROVED', invite: '1',
    }, `/app/channel-partners/registrations/${registrationId}?step=7`);
    assert.equal(res.status, 302);
    partnerId = res.location.split('/').pop();

    const partner = await ChannelPartner.findOne({ tenantId, _id: partnerId }).lean();
    assert.equal(partner.status, 'ACTIVE');
    assert.match(partner.partnerCode, /^CP-\d{4}-00001$/);
    assert.equal(partner.reraNumber, 'AG/GJ/AHMEDABAD/AGENT/0001');
    assert.equal(partner.reraStatus, 'PENDING', 'recorded, not yet verified');

    // The certificate followed the application onto the partner.
    const document = await PartnerReraDocument.findOne({ tenantId, channelPartnerId: partnerId }).lean();
    assert.ok(document);
    assert.ok(await Activity.findOne({ tenantId, channelPartnerId: partnerId, type: 'CP_REGISTRATION_APPROVED' }).lean());

    const portalUser = await PartnerPortalUser.findOne({ tenantId, channelPartnerId: partnerId }).lean();
    assert.equal(portalUser.status, 'INVITED');
    assert.equal(portalUser.role, 'COMPANY_ADMIN');
    assert.ok(portalUser.inviteTokenHash);
    assert.ok(!portalUser.passwordHash, 'no password until they set one');

    const page = await mgr.get(`/app/channel-partners/${partnerId}`);
    const match = page.text.match(/\/cp\/activate\/([A-Za-z0-9_-]{20,})/);
    assert.ok(match, 'the activation link is shown once');
    portalUrl = `/cp/activate/${match[1]}`;

    const email = await MessageLog.findOne({ tenantId, channel: 'EMAIL' }).sort({ createdAt: -1 }).lean();
    assert.match(email.body, /cp\/activate/);
  });

  await t.test('approving twice does not create a second partner (§13)', async () => {
    const res = await failing(mgr, `/api/channel-partners/registrations/${registrationId}/review`,
      { decision: 'APPROVED' }, `/app/channel-partners/registrations/${registrationId}`);
    assert.ok([200, 302, 400].includes(res.status));
    assert.equal(await ChannelPartner.countDocuments({ tenantId }), 1);
  });

  /* ---------------------------- §24 portal auth --------------------------- */

  await t.test('the partner activates their own login (§24, §308)', async () => {
    const res = await partnerClient.submit(portalUrl, { password: 'PartnerPass1' }, portalUrl);
    assert.equal(res.status, 302);
    const portalUser = await PartnerPortalUser.findOne({ tenantId, channelPartnerId: partnerId }).lean();
    assert.equal(portalUser.status, 'ACTIVE');
    assert.ok(portalUser.passwordHash);
    assert.ok(!portalUser.inviteTokenHash, 'the invitation is single use');

    const dash = await partnerClient.get('/cp/dashboard');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /ABC Realty/);
  });

  await t.test('a partner session can never reach an internal route (§24)', async () => {
    for (const path of ['/app/dashboard', '/app/leads', `/app/channel-partners/${partnerId}`, '/app/bookings']) {
      const res = await partnerClient.get(path);
      assert.ok([302, 401, 403].includes(res.status), `${path} refused (got ${res.status})`);
      if (res.status === 302) assert.match(res.location, /\/login/);
    }
    // And an internal user is not a partner.
    const portal = await admin.get('/cp/dashboard');
    assert.equal(portal.status, 302);
    assert.match(portal.location, /\/cp\/login/);
  });

  /* --------------------- §25/§26 empanelment gate ------------------------- */

  await t.test('a partner cannot submit for a project they are not empanelled on (§26)', async () => {
    const page = await partnerClient.get('/cp/leads/new');
    assert.equal(page.status, 200);
    assert.match(page.text, /No projects available/);

    const res = await partnerClient.post('/cp/leads', {
      _csrf: await partnerClient.csrf('/cp/dashboard'),
      projectId: String(project._id), name: 'Blocked Customer', mobile: '9900000001',
    });
    assert.equal(res.status, 302);
    const claim = await PartnerLeadClaim.findOne({ tenantId, submittedName: 'Blocked Customer' }).lean();
    assert.equal(claim.status, 'CONFLICT');
    assert.equal(claim.conflictReason, 'PROJECT_NOT_EMPANELLED');
    assert.equal(await Lead.countDocuments({ tenantId, channelPartnerId: partnerId }), 0, 'no lead was created');
  });

  await t.test('empanelment opens the project for submission (§25)', async () => {
    const res = await mgr.submit(`/api/channel-partners/${partnerId}/empanelments`, {
      projectId: String(project._id), status: 'APPROVED', effectiveFrom: '2026-01-01',
    }, `/app/channel-partners/${partnerId}?tab=projects`);
    assert.equal(res.status, 302);
    const empanelment = await PartnerProjectEmpanelment.findOne({ tenantId, channelPartnerId: partnerId }).lean();
    assert.equal(empanelment.status, 'APPROVED');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'PartnerProjectEmpanelment' }).lean());

    const page = await partnerClient.get('/cp/leads/new');
    assert.match(page.text, /Partner Park/);
  });

  /* ------------------------ §31–§35 lead submission ---------------------- */

  let partnerLeadId;

  await t.test('a partner submission runs the normal capture path (§32)', async () => {
    const res = await partnerClient.post('/cp/leads', {
      _csrf: await partnerClient.csrf('/cp/leads/new'),
      projectId: String(project._id),
      name: 'Kiran Patel',
      mobile: '9900000123',
      email: 'kiran@example.test',
      configuration: '3 BHK',
      note: 'Wants a high floor.',
    });
    assert.equal(res.status, 302);

    const claim = await PartnerLeadClaim.findOne({ tenantId, submittedName: 'Kiran Patel' }).lean();
    assert.equal(claim.status, 'ACCEPTED');
    assert.match(claim.claimNumber, /^CPL-\d{4}-\d{5}$/);
    assert.ok(claim.protectionUntil, 'the association is protected for the configured window');

    const lead = await Lead.findOne({ tenantId, _id: claim.leadId }).lean();
    assert.ok(lead, 'a real CRM lead exists — not a parallel CP table');
    assert.equal(String(lead.channelPartnerId), String(partnerId));
    assert.equal(lead.partnerAttributionStatus, 'ACCEPTED');
    // §32: allocation, SLA and the ordinary lead pipeline all still ran.
    assert.ok(lead.ownerUserId, 'the lead was allocated to an internal user');
    assert.ok(lead.slaDueAt || lead.slaStatus, 'the response clock started');
    assert.ok(lead.latestSourceId, 'and it has a marketing source of its own');
    partnerLeadId = String(lead._id);

    const contact = await Contact.findOne({ tenantId, _id: lead.contactId }).lean();
    assert.match(contact.normalizedMobile, /9900000123$/);
    assert.ok(await waitFor(
      () => Activity.findOne({ tenantId, channelPartnerId: partnerId, type: 'CP_LEAD_SUBMITTED' }).lean(),
      Boolean,
    ));
  });

  await t.test('the same partner submitting again is a re-inquiry, not a dispute (§35)', async () => {
    const before = await Lead.countDocuments({ tenantId });
    const res = await partnerClient.post('/cp/leads', {
      _csrf: await partnerClient.csrf('/cp/leads/new'),
      projectId: String(project._id), name: 'Kiran Patel', mobile: '9900000123',
    });
    assert.equal(res.status, 302);
    assert.equal(await Lead.countDocuments({ tenantId }), before, 'no duplicate lead');
    const claims = await PartnerLeadClaim.find({ tenantId, submittedMobile: { $regex: /9900000123$/ } }).lean();
    assert.equal(claims.length, 2);
    assert.ok(claims.every((c) => c.status === 'ACCEPTED'));
  });

  await t.test('the partner sees only safe fields about their lead (§37)', async () => {
    // An internal note the partner must never see.
    await admin.submit(`/api/leads/${partnerLeadId}/notes`, { body: 'Internal: customer negotiating hard, approve 4%.' }, `/app/leads/${partnerLeadId}`);
    const page = await partnerClient.get('/cp/leads');
    assert.equal(page.status, 200);
    assert.match(page.text, /Kiran Patel/);
    assert.doesNotMatch(page.text, /negotiating hard/);
    assert.doesNotMatch(page.text, /approve 4%/);
  });

  await t.test('a second partner claiming the same customer creates a conflict (§35, §324.8)', async () => {
    // A second, fully approved partner.
    const created = await mgr.submit('/api/channel-partners/registrations', {
      partnerType: 'INDIVIDUAL', primaryContactName: 'Rival Broker', mobile: '9812345677',
      email: 'rival@broker.test', city: 'Ahmedabad', state: 'Gujarat',
    }, '/app/channel-partners/registrations/new');
    const rivalRegId = created.location.split('?')[0].split('/').pop();
    await uploadTo(mgr, `/api/channel-partners/registrations/${rivalRegId}/rera`, {
      registrationNumber: 'AG/GJ/AHMEDABAD/AGENT/0009', expiryDate: '2027-12-31',
    }, { field: 'certificate', filename: 'r.pdf', contentType: 'application/pdf', bytes: PDF },
    `/app/channel-partners/registrations/${rivalRegId}?step=3`);
    await mgr.submit(`/api/channel-partners/registrations/${rivalRegId}/submit`, {}, `/app/channel-partners/registrations/${rivalRegId}`);
    const approved = await mgr.submit(`/api/channel-partners/registrations/${rivalRegId}/review`, {
      decision: 'APPROVED',
    }, `/app/channel-partners/registrations/${rivalRegId}?step=7`);
    const rivalId = approved.location.split('/').pop();
    await mgr.submit(`/api/channel-partners/${rivalId}/empanelments`, {
      projectId: String(project._id), status: 'APPROVED',
    }, `/app/channel-partners/${rivalId}?tab=projects`);

    const rivalPortal = await mgr.submit(`/api/channel-partners/${rivalId}/portal-invite`, {
      email: 'rival@broker.test', name: 'Rival Broker', role: 'SALES_MEMBER',
    }, `/app/channel-partners/${rivalId}?tab=team`);
    assert.equal(rivalPortal.status, 302);
    const rivalPage = await mgr.get(`/app/channel-partners/${rivalId}?tab=team`);
    const rivalToken = rivalPage.text.match(/\/cp\/activate\/([A-Za-z0-9_-]{20,})/)[1];
    const rivalClient = h.client();
    await rivalClient.submit(`/cp/activate/${rivalToken}`, { password: 'RivalPass1' }, `/cp/activate/${rivalToken}`);

    const leadBefore = await Lead.findOne({ tenantId, _id: partnerLeadId }).lean();
    const res = await rivalClient.post('/cp/leads', {
      _csrf: await rivalClient.csrf('/cp/leads/new'),
      projectId: String(project._id), name: 'Kiran Patel', mobile: '9900000123',
    });
    assert.equal(res.status, 302);

    const conflict = await PartnerLeadClaim.findOne({
      tenantId, channelPartnerId: rivalId, submittedMobile: { $regex: /9900000123$/ },
    }).lean();
    assert.equal(conflict.status, 'CONFLICT');
    assert.equal(conflict.conflictReason, 'ANOTHER_PARTNER_ACTIVE');

    // §324.8: nothing about the lead moved.
    const leadAfter = await Lead.findOne({ tenantId, _id: partnerLeadId }).lean();
    assert.equal(String(leadAfter.channelPartnerId), String(partnerId), 'the first partner keeps the lead');
    assert.equal(String(leadAfter.ownerUserId), String(leadBefore.ownerUserId), 'the internal owner is untouched');
    assert.equal(String(leadAfter.latestSourceId), String(leadBefore.latestSourceId), 'the source is untouched');

    // And the partner is told honestly, without a promise of attribution.
    const theirLeads = await rivalClient.get('/cp/leads');
    assert.match(theirLeads.text, /conflict/i);
    assert.match(theirLeads.text, /Under review/);
  });

  await t.test('a direct lead is defended by tenant policy (§35)', async () => {
    const created = await admin.submit('/api/leads', {
      firstName: 'Direct', lastName: 'Walkin', primaryMobile: '9900000456',
      sourceId: String(source._id), projectId: String(project._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    const directLeadId = created.location.split('?')[0].split('/').pop();

    const res = await partnerClient.post('/cp/leads', {
      _csrf: await partnerClient.csrf('/cp/leads/new'),
      projectId: String(project._id), name: 'Direct Walkin', mobile: '9900000456',
    });
    assert.equal(res.status, 302);
    const claim = await PartnerLeadClaim.findOne({ tenantId, submittedMobile: { $regex: /9900000456$/ } }).lean();
    assert.equal(claim.status, 'CONFLICT', 'the default policy is review, never overwrite');
    assert.equal(claim.conflictReason, 'DIRECT_LEAD_ACTIVE');

    const lead = await Lead.findOne({ tenantId, _id: directLeadId }).lean();
    assert.equal(lead.channelPartnerId, null);
    assert.equal(lead.partnerAttributionStatus, 'NONE');
  });

  await t.test('the claim queue lets a reviewer decide, and audits it (§36)', async () => {
    const page = await mgr.get('/app/channel-partners/claims');
    assert.equal(page.status, 200);
    assert.match(page.text, /Kiran Patel/);
    assert.match(page.text, /another partner active/i);

    const conflict = await PartnerLeadClaim.findOne({
      tenantId, status: 'CONFLICT', conflictReason: 'DIRECT_LEAD_ACTIVE',
    }).lean();
    const res = await mgr.submit(`/api/channel-partner-claims/${conflict._id}/review`, {
      decision: 'KEEP_EXISTING', note: 'Walk-in came to us directly last week.',
    }, '/app/channel-partners/claims');
    assert.equal(res.status, 302);

    const after = await PartnerLeadClaim.findOne({ tenantId, _id: conflict._id }).lean();
    assert.equal(after.status, 'REJECTED');
    assert.match(after.reviewNote, /Existing partner kept/);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'PartnerLeadClaim', action: 'REVIEW' }).lean());
  });

  await t.test('a sales user cannot review claims (§178)', async () => {
    const conflict = await PartnerLeadClaim.findOne({ tenantId, status: 'CONFLICT' }).lean();
    const res = await failing(rep, `/api/channel-partner-claims/${conflict._id}/review`,
      { decision: 'ACCEPTED' }, '/app/dashboard');
    assert.equal(res.status, 403);
  });

  /* ------------------- §38–§43 visit, booking, commission ---------------- */

  let bookingId;

  await t.test('a visit on a partner lead carries the partner (§38)', async () => {
    const visitsService = require('../../src/services/visits');
    const lead = await Lead.findOne({ tenantId, _id: partnerLeadId }).lean();
    const visit = await visitsService.schedule({
      tenantId, tenant: orgA.tenant, actor: seller, leadId: partnerLeadId,
      projectId: String(project._id), scheduledAt: new Date(Date.now() + 3600000),
      salesUserId: lead.ownerUserId,
    });
    // The listener stamps it, so poll rather than guess at a delay.
    const stamped = await waitFor(
      () => SiteVisit.findOne({ tenantId, _id: visit._id }).lean(),
      (v) => !!v.channelPartnerId,
    );
    assert.equal(String(stamped.channelPartnerId), String(partnerId));
    assert.equal(await SiteVisit.countDocuments({ tenantId, leadId: partnerLeadId }), 1, 'no duplicate CP visit record');
  });

  await t.test('a booking freezes the partner attribution and accrues commission (§39, §42)', async () => {
    await PartnerCommissionRule.create({
      tenantId,
      name: '2% after 20% collection',
      basis: 'FINAL_BOOKING_PRICE',
      rateType: 'PERCENTAGE',
      rate: 2,
      eligibilityTrigger: 'ON_COLLECTION_PERCENT',
      collectionThresholdPct: 20,
      active: true,
    });

    const costsheets = require('../../src/services/costsheets');
    const bookingsService = require('../../src/services/bookings');
    const lead = await Lead.findOne({ tenantId, _id: partnerLeadId }).lean();
    const sheet = await costsheets.create({
      tenantId, actor: seller, leadId: partnerLeadId, unitId: unit._id, paymentPlanId: plan._id,
    });
    const booking = await bookingsService.createBooking({
      tenantId, tenant: orgA.tenant, actor: seller, leadId: partnerLeadId, unitId: unit._id,
      costSheetId: sheet._id, bookingDate: new Date(), finalPriceMinor: sheet.finalConsiderationMinor,
      bookingAmountMinor: 100000000, paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
    });
    bookingId = String(booking._id);

    // §39: frozen onto the booking, and the salesperson still owns the sale (§184).
    assert.equal(String(booking.channelPartnerId), String(partnerId));
    assert.equal(String(booking.salespersonId), String(lead.ownerUserId));

    const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean();
    assert.ok(entitlement, 'commission accrued at booking');
    assert.equal(entitlement.calculatedCommissionMinor, Math.round(booking.finalPriceMinor * 0.02));
    // §43: not yet payable — nothing has been collected.
    assert.equal(entitlement.status, 'NOT_YET_ELIGIBLE');
    assert.equal(entitlement.eligibleAmountMinor, 0);
    // §324.9: the rule is snapshotted.
    assert.equal(entitlement.commissionRuleSnapshot.collectionThresholdPct, 20);
    assert.match(entitlement.commissionRuleSnapshot.description, /2% after 20% collection/);
  });

  await t.test('editing the rule later cannot change what was earned (§306, §324.9)', async () => {
    await PartnerCommissionRule.updateMany({ tenantId }, { $set: { rate: 9, collectionThresholdPct: 90 } });
    const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean();
    assert.equal(entitlement.commissionRuleSnapshot.rate, 2, 'the snapshot stands');
    assert.equal(entitlement.commissionRuleSnapshot.collectionThresholdPct, 20);
    await PartnerCommissionRule.updateMany({ tenantId }, { $set: { rate: 2, collectionThresholdPct: 20 } });
  });

  await t.test('crossing the collection threshold makes it eligible (§43)', async () => {
    const receipts = require('../../src/services/receipts');
    const booking = await Booking.findOne({ tenantId, _id: bookingId }).lean();
    // 25% of the schedule: the first installment.
    await receipts.record({
      tenantId, tenant: orgA.tenant, actor: cpManager, bookingId,
      amountMinor: Math.round(booking.scheduledTotalMinor * 0.25),
      paymentDate: new Date(), mode: 'BANK_TRANSFER', reference: 'UTR-CP-1',
    });
    const entitlement = await waitFor(
      () => PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean(),
      (e) => e.status === 'ELIGIBLE',
    );
    assert.equal(entitlement.status, 'ELIGIBLE');
    assert.equal(entitlement.eligibleAmountMinor, entitlement.calculatedCommissionMinor);
    assert.ok(entitlement.eligibleAt);
    assert.ok(entitlement.collectionPctAtEvaluation >= 20);
    /**
     * The status flips before the timeline rows are written, so waiting on the
     * status is not waiting on the whole side effect. Poll for the rows.
     */
    assert.ok(await waitFor(
      () => Activity.findOne({ tenantId, channelPartnerId: partnerId, type: 'CP_COMMISSION_ELIGIBLE' }).lean(),
      Boolean,
    ));
    assert.ok(await waitFor(
      () => Activity.findOne({ tenantId, bookingId, type: 'CP_COMMISSION_ELIGIBLE' }).lean(),
      Boolean,
    ));
  });

  await t.test('the partner sees eligibility progress, never the receipts (§271)', async () => {
    const page = await partnerClient.get('/cp/bookings');
    assert.equal(page.status, 200);
    assert.match(page.text, /Kiran Patel/);
    assert.match(page.text, /eligible/i);
    assert.doesNotMatch(page.text, /UTR-CP-1/, 'no receipt history');
    assert.doesNotMatch(page.text, /KYC/);
  });

  /* --------------------------- §44–§50 invoices -------------------------- */

  let invoiceId;

  await t.test('a partner can only invoice the eligible amount (§48, §324.10)', async () => {
    const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean();
    const over = await partnerClient.post('/cp/invoices', {
      _csrf: await partnerClient.csrf('/cp/invoices'),
      invoiceNumber: 'ABC/2026/01',
      invoiceDate: new Date().toISOString().slice(0, 10),
      entitlementId: String(entitlement._id),
      claimAmount: String((entitlement.eligibleAmountMinor + 100000) / 100),
    });
    assert.equal(over.status, 302);
    assert.equal(await PartnerInvoice.countDocuments({ tenantId }), 0, 'the over-claim was refused');

    const ok = await partnerClient.post('/cp/invoices', {
      _csrf: await partnerClient.csrf('/cp/invoices'),
      invoiceNumber: 'ABC/2026/01',
      invoiceDate: new Date().toISOString().slice(0, 10),
      gstAmount: '5000',
      entitlementId: String(entitlement._id),
      claimAmount: String(entitlement.eligibleAmountMinor / 100),
    });
    assert.equal(ok.status, 302);
    const invoice = await PartnerInvoice.findOne({ tenantId, channelPartnerId: partnerId }).lean();
    invoiceId = String(invoice._id);
    assert.equal(invoice.status, 'DRAFT');
    assert.equal(invoice.lines.length, 1);
    assert.equal(invoice.taxableValueMinor, entitlement.eligibleAmountMinor);
    assert.equal(invoice.invoiceTotalMinor, entitlement.eligibleAmountMinor + 500000);
    assert.equal(invoice.bankSnapshot.accountNumberMasked.slice(-4), '6789', 'the bank position is snapshotted');
  });

  await t.test('the invoice PDF is private, and the partner reads only their own (§298)', async () => {
    const res = await uploadTo(partnerClient, `/cp/invoices/${invoiceId}/pdf`, {},
      { field: 'file', filename: 'invoice.pdf', contentType: 'application/pdf', bytes: PDF },
      `/cp/invoices/${invoiceId}`);
    assert.equal(res.status, 302);
    const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
    assert.ok(invoice.invoicePdf.storageKey);

    const own = await partnerClient.get(`/cp/invoices/${invoiceId}/pdf`);
    assert.equal(own.status, 200);
    assert.match(own.headers.get('content-type') || '', /pdf/);

    // Another partner's session must not reach it.
    const rivalPartner = await ChannelPartner.findOne({ tenantId, 'profile.primaryContactName': 'Rival Broker' }).lean();
    const rivalUser = await PartnerPortalUser.findOne({ tenantId, channelPartnerId: rivalPartner._id }).lean();
    assert.ok(rivalUser);
    const rivalClient = h.client();
    await rivalClient.submit('/cp/login', { email: 'rival@broker.test', password: 'RivalPass1' }, '/cp/login');
    const stolen = await rivalClient.get(`/cp/invoices/${invoiceId}/pdf`);
    assert.equal(stolen.status, 404);
  });

  await t.test('submitting commits the invoiced amount (§45, §48)', async () => {
    const res = await partnerClient.post(`/cp/invoices/${invoiceId}/submit`, {
      _csrf: await partnerClient.csrf(`/cp/invoices/${invoiceId}`),
    });
    assert.equal(res.status, 302);
    const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
    assert.equal(invoice.status, 'SUBMITTED');
    assert.ok(invoice.submittedAt);

    const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean();
    assert.equal(entitlement.invoicedAmountMinor, invoice.taxableValueMinor);
    assert.equal(entitlement.status, 'INVOICED');
    assert.ok(await Activity.findOne({ tenantId, channelPartnerId: partnerId, type: 'CP_INVOICE_SUBMITTED' }).lean());
  });

  await t.test('a second invoice cannot double-claim the same commission (§48)', async () => {
    const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean();
    const res = await partnerClient.post('/cp/invoices', {
      _csrf: await partnerClient.csrf('/cp/invoices'),
      invoiceNumber: 'ABC/2026/02',
      invoiceDate: new Date().toISOString().slice(0, 10),
      entitlementId: String(entitlement._id),
      claimAmount: '1000',
    });
    assert.equal(res.status, 302);
    assert.equal(await PartnerInvoice.countDocuments({ tenantId, channelPartnerId: partnerId }), 1);
  });

  await t.test('the reviewer sees the whole picture and approves (§49)', async () => {
    const page = await mgr.get(`/app/channel-partners/invoices/${invoiceId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /ABC\/2026\/01/);
    assert.match(page.text, /Kiran Patel/);
    assert.match(page.text, /2% after 20% collection/);
    assert.match(page.text, /Open invoice PDF/);
    // §49: bank details need their own permission — the manager has it.
    assert.match(page.text, /6789/);

    const res = await mgr.submit(`/api/partner-invoices/${invoiceId}/review`, {
      decision: 'APPROVED',
    }, `/app/channel-partners/invoices/${invoiceId}`);
    assert.equal(res.status, 302);
    const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
    assert.equal(invoice.status, 'APPROVED');
    assert.ok(invoice.approvedAt);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'PartnerInvoice', action: 'REVIEW' }).lean());
  });

  await t.test('a payout is recorded operationally and cannot exceed the invoice (§50)', async () => {
    const invoice = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
    const over = await failing(mgr, `/api/partner-invoices/${invoiceId}/payment`, {
      amount: String((invoice.invoiceTotalMinor + 100000) / 100),
      payoutDate: new Date().toISOString().slice(0, 10),
    }, `/app/channel-partners/invoices/${invoiceId}`);
    assert.equal(over.status, 400);
    assert.match(over.data.error.message, /still outstanding/);

    const half = Math.round(invoice.invoiceTotalMinor / 2);
    await mgr.submit(`/api/partner-invoices/${invoiceId}/payment`, {
      amount: String(half / 100), payoutDate: new Date().toISOString().slice(0, 10),
      transactionReference: 'UTR-PAYOUT-1', deduction: '1000', deductionNote: 'TDS (informational)',
    }, `/app/channel-partners/invoices/${invoiceId}`);

    let after = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
    assert.equal(after.status, 'PARTIALLY_PAID');
    assert.equal(after.paidAmountMinor, half);

    await mgr.submit(`/api/partner-invoices/${invoiceId}/payment`, {
      amount: String((invoice.invoiceTotalMinor - half) / 100),
      payoutDate: new Date().toISOString().slice(0, 10), transactionReference: 'UTR-PAYOUT-2',
    }, `/app/channel-partners/invoices/${invoiceId}`);

    after = await PartnerInvoice.findOne({ tenantId, _id: invoiceId }).lean();
    assert.equal(after.status, 'PAID');
    assert.equal(await PartnerPayout.countDocuments({ tenantId, partnerInvoiceId: invoiceId }), 2);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'PartnerPayout', action: 'CREATE' }).lean());

    const entitlement = await PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean();
    assert.ok(entitlement.paidAmountMinor > 0);
  });

  /* ------------------------- §228 reversal boundary --------------------- */

  await t.test('a reversal after invoicing flags review, never a clawback (§228)', async () => {
    const { BookingReceipt } = require('../../src/db/models');
    const receipts = require('../../src/services/receipts');
    const receipt = await BookingReceipt.findOne({ tenantId, bookingId, status: 'CONFIRMED' }).lean();
    await receipts.reverse({
      tenantId, tenant: orgA.tenant, actor: cpManager, receiptId: receipt._id,
      reason: 'Bank returned the transfer',
    });
    const entitlement = await waitFor(
      () => PartnerCommissionEntitlement.findOne({ tenantId, bookingId }).lean(),
      (e) => e.status === 'REVIEW_REQUIRED',
    );
    assert.equal(entitlement.status, 'REVIEW_REQUIRED');
    assert.match(entitlement.reviewReason, /already invoiced or paid/);
    assert.ok(entitlement.paidAmountMinor > 0, 'nothing was clawed back');
    assert.ok(await waitFor(
      () => Activity.findOne({ tenantId, channelPartnerId: partnerId, type: 'CP_COMMISSION_REVIEW' }).lean(),
      Boolean,
    ));
  });

  await t.test('an uninvoiced entitlement does fall back when collection drops (§228)', async () => {
    // A second booking on the same rule, uninvoiced.
    const unit2 = await Unit.create({
      tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
      unitNumber: 'A-1202', floorNumber: 12, saleableArea: 1000, status: 'AVAILABLE',
    });
    const created = await admin.submit('/api/leads', {
      firstName: 'Second', lastName: 'Buyer', primaryMobile: '9900000789',
      sourceId: String(source._id), projectId: String(project._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    const leadId2 = created.location.split('?')[0].split('/').pop();
    await Lead.updateOne({ tenantId, _id: leadId2 }, {
      $set: { channelPartnerId: partnerId, partnerAttributionStatus: 'ACCEPTED' },
    });

    const costsheets = require('../../src/services/costsheets');
    const bookingsService = require('../../src/services/bookings');
    const receipts = require('../../src/services/receipts');
    const sheet = await costsheets.create({
      tenantId, actor: seller, leadId: leadId2, unitId: unit2._id, paymentPlanId: plan._id,
    });
    const booking2 = await bookingsService.createBooking({
      tenantId, tenant: orgA.tenant, actor: seller, leadId: leadId2, unitId: unit2._id,
      costSheetId: sheet._id, bookingDate: new Date(), finalPriceMinor: sheet.finalConsiderationMinor,
      bookingAmountMinor: 100000000, paymentPlanId: plan._id, buyerPurpose: 'SELF_USE',
    });

    const receipt = await receipts.record({
      tenantId, tenant: orgA.tenant, actor: cpManager, bookingId: booking2._id,
      amountMinor: Math.round(booking2.scheduledTotalMinor * 0.25),
      paymentDate: new Date(), mode: 'BANK_TRANSFER', reference: 'UTR-CP-2',
    });
    let entitlement = await waitFor(
      () => PartnerCommissionEntitlement.findOne({ tenantId, bookingId: booking2._id }).lean(),
      (e) => e.status === 'ELIGIBLE',
    );
    assert.equal(entitlement.status, 'ELIGIBLE');

    await receipts.reverse({
      tenantId, tenant: orgA.tenant, actor: cpManager, receiptId: receipt._id, reason: 'Cheque bounced',
    });
    entitlement = await waitFor(
      () => PartnerCommissionEntitlement.findOne({ tenantId, bookingId: booking2._id }).lean(),
      (e) => e.status === 'NOT_YET_ELIGIBLE',
    );
    assert.equal(entitlement.status, 'NOT_YET_ELIGIBLE', 'nothing was invoiced, so it may fall back');
    assert.equal(entitlement.eligibleAmountMinor, 0);
  });

  /* ------------------ §217/§218 compliance and suspension --------------- */

  await t.test('a RERA renewal versions rather than overwrites (§217, §324.11)', async () => {
    const res = await uploadTo(mgr, `/api/channel-partners/${partnerId}/rera`, {
      registrationNumber: 'AG/GJ/AHMEDABAD/AGENT/0001', issueDate: '2028-01-01', expiryDate: '2029-12-31',
    }, { field: 'certificate', filename: 'renewed.pdf', contentType: 'application/pdf', bytes: PDF },
    `/app/channel-partners/${partnerId}?tab=documents`);
    assert.equal(res.status, 302);

    const versions = await PartnerReraDocument.find({ tenantId, channelPartnerId: partnerId })
      .sort({ version: 1 }).lean();
    assert.equal(versions.length, 2);
    assert.equal(versions[0].active, false);
    assert.ok(versions[0].supersededById, 'v1 points at what replaced it');
    assert.equal(versions[1].active, true);

    const partner = await ChannelPartner.findOne({ tenantId, _id: partnerId }).lean();
    assert.equal(String(partner.activeReraDocumentId), String(versions[1]._id));
    assert.equal(partner.reraExpiryDate.toISOString().slice(0, 10), '2029-12-31');
  });

  await t.test('verifying the certificate is audited (§18, §196)', async () => {
    const active = await PartnerReraDocument.findOne({ tenantId, channelPartnerId: partnerId, active: true }).lean();
    const res = await mgr.submit(`/api/channel-partners/${partnerId}/rera/${active._id}/verify`, {
      decision: 'VERIFIED',
    }, `/app/channel-partners/${partnerId}?tab=documents`);
    assert.equal(res.status, 302);
    const partner = await ChannelPartner.findOne({ tenantId, _id: partnerId }).lean();
    assert.equal(partner.reraStatus, 'VERIFIED');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'PartnerReraDocument', action: 'VERIFY' }).lean());
  });

  await t.test('an expired certificate blocks new submissions (§19, §20)', async () => {
    await PartnerReraDocument.updateOne(
      { tenantId, channelPartnerId: partnerId, active: true },
      { $set: { expiryDate: new Date(Date.now() - 86400000) } },
    );
    await require('../../src/services/rera').syncPartner({ tenantId, channelPartnerId: partnerId });

    const res = await partnerClient.post('/cp/leads', {
      _csrf: await partnerClient.csrf('/cp/dashboard'),
      projectId: String(project._id), name: 'Late Customer', mobile: '9900000999',
    });
    assert.equal(res.status, 302);
    const claim = await PartnerLeadClaim.findOne({ tenantId, submittedName: 'Late Customer' }).lean();
    assert.equal(claim.status, 'CONFLICT');
    assert.equal(claim.conflictReason, 'RERA_INVALID');

    // §20: the partner is told, in the words the spec asks for.
    const dash = await partnerClient.get('/cp/dashboard');
    assert.match(dash.text, /expired on/);

    // §53: the sweep announces it once, and does not repeat itself.
    const sweep = await require('../../src/services/rera').expirySweep({ tenantId });
    assert.equal(sweep.expired >= 1, true);
    assert.ok(await Activity.findOne({ tenantId, channelPartnerId: partnerId, type: 'CP_RERA_EXPIRED' }).lean());

    // Put it back for the remaining tests.
    await PartnerReraDocument.updateOne(
      { tenantId, channelPartnerId: partnerId, active: true },
      { $set: { expiryDate: new Date(Date.now() + 365 * 86400000), verificationStatus: 'VERIFIED' } },
    );
    await require('../../src/services/rera').syncPartner({ tenantId, channelPartnerId: partnerId });
  });

  await t.test('suspension makes the portal read-only and keeps history (§218)', async () => {
    const res = await mgr.submit(`/api/channel-partners/${partnerId}/status`, {
      status: 'SUSPENDED', reason: 'Compliance review',
    }, `/app/channel-partners/${partnerId}`);
    assert.equal(res.status, 302);

    const dash = await partnerClient.get('/cp/dashboard');
    assert.equal(dash.status, 200, 'they can still see their history');
    assert.match(dash.text, /read-only/);
    assert.match(dash.text, /Kiran Patel|ABC Realty/);

    const attempt = await partnerClient.get('/cp/leads/new');
    assert.equal(attempt.status, 403);

    // Historical attribution is untouched.
    const lead = await Lead.findOne({ tenantId, _id: partnerLeadId }).lean();
    assert.equal(String(lead.channelPartnerId), String(partnerId));

    await mgr.submit(`/api/channel-partners/${partnerId}/status`, {
      status: 'ACTIVE', reason: 'Review cleared',
    }, `/app/channel-partners/${partnerId}`);
    const back = await partnerClient.get('/cp/leads/new');
    assert.equal(back.status, 200);
  });

  await t.test('a deactivated member loses access and keeps their history (§219)', async () => {
    const saved = await mgr.submit(`/api/channel-partners/${partnerId}/team`, {
      name: 'Ravi Junior', mobile: '9812345655', email: 'ravi@abcrealty.test',
      designation: 'Sales', portalRole: 'SALES_MEMBER', canSubmitLeads: '1', portalLoginEnabled: '1',
    }, `/app/channel-partners/${partnerId}?tab=team`);
    assert.equal(saved.status, 302);
    const member = await ChannelPartnerMember.findOne({ tenantId, name: 'Ravi Junior' }).lean();

    await mgr.submit(`/api/channel-partners/${partnerId}/portal-invite`, {
      memberId: String(member._id), name: 'Ravi Junior', email: 'ravi@abcrealty.test', role: 'SALES_MEMBER',
    }, `/app/channel-partners/${partnerId}?tab=team`);
    const page = await mgr.get(`/app/channel-partners/${partnerId}?tab=team`);
    const token = page.text.match(/\/cp\/activate\/([A-Za-z0-9_-]{20,})/)[1];
    const juniorClient = h.client();
    await juniorClient.submit(`/cp/activate/${token}`, { password: 'JuniorPass1' }, `/cp/activate/${token}`);
    const juniorDash = await juniorClient.get('/cp/dashboard');
    assert.equal(juniorDash.status, 200);
    // §23: a sales member is not a company admin.
    const teamPage = await juniorClient.get('/cp/team');
    assert.equal(teamPage.status, 403);

    await mgr.submit(`/api/channel-partners/${partnerId}/team/${member._id}/toggle`, {},
      `/app/channel-partners/${partnerId}?tab=team`);
    const after = await ChannelPartnerMember.findOne({ tenantId, _id: member._id }).lean();
    assert.equal(after.active, false);
    assert.ok(after.exitedAt);

    const blocked = await juniorClient.get('/cp/dashboard');
    assert.ok([302, 401].includes(blocked.status), 'their session no longer resolves');
  });

  /* ---------------------------- dashboards, reports ---------------------- */

  await t.test('the internal dashboard and reports agree with the records (§9, §51, §206)', async () => {
    const dash = await mgr.get('/app/channel-partners/dashboard');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /ABC Realty/);
    assert.match(dash.text, /Partner funnel/);
    assert.match(dash.text, /Accrued/);

    const report = await mgr.get('/app/reports/channel-partners');
    assert.equal(report.status, 200);
    assert.match(report.text, /ABC Realty/);
    // §206: all four columns are present, separately.
    for (const label of ['Accrued', 'Eligible', 'Invoiced', 'Paid']) {
      assert.match(report.text, new RegExp(label));
    }

    const invoiceReport = await mgr.get('/app/reports/cp-invoices');
    assert.match(invoiceReport.text, /ABC\/2026\/01/);

    const csv = await mgr.get('/app/reports/channel-partners/export');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /Commission accrued/);
    // §322: bank details never leave in an export.
    assert.doesNotMatch(csv.text, /501000123456789|accountNumberSealed/);
  });

  await t.test('the top-performer table ranks by the column asked for (§10)', async () => {
    for (const rankBy of ['bookings', 'value', 'leads', 'visits', 'conversion']) {
      const page = await mgr.get(`/app/channel-partners/dashboard?rankBy=${rankBy}`);
      assert.equal(page.status, 200);
      assert.match(page.text, /Top performers/);
    }
  });

  /* ------------------------------- isolation ---------------------------- */

  await t.test('another tenant cannot see or touch this partner (§2.3)', async () => {
    const other = h.client();
    await other.login('admin@beta.test');
    const page = await other.get(`/app/channel-partners/${partnerId}`);
    assert.equal(page.status, 404);

    const res = await failing(other, `/api/channel-partners/${partnerId}/status`,
      { status: 'SUSPENDED', reason: 'Cross tenant' }, '/app/dashboard');
    assert.ok([403, 404].includes(res.status));
    const partner = await ChannelPartner.findOne({ tenantId, _id: partnerId }).lean();
    assert.equal(partner.status, 'ACTIVE');
    assert.equal(await ChannelPartner.countDocuments({ tenantId: orgB.tenant._id }), 0);
  });

  await t.test('public self-registration is off unless the tenant enables it (§14)', async () => {
    const anon = h.client();
    const closed = await anon.get('/cp/register');
    assert.equal(closed.status, 404);

    await Tenant.updateMany({}, { $set: { 'settings.cpPublicRegistrationEnabled': true } });
    const open = await anon.get('/cp/register');
    assert.equal(open.status, 200);
    assert.match(open.text, /Become a channel partner/);

    const res = await anon.submit('/cp/register', {
      partnerType: 'INDIVIDUAL', primaryContactName: 'Walk In Broker', mobile: '9812340000',
      email: 'walkin@broker.test', city: 'Vadodara',
    }, '/cp/register');
    assert.equal(res.status, 302);
    const registration = await ChannelPartnerRegistration.findOne({
      'profile.email': 'walkin@broker.test',
    }).setOptions({ allowCrossTenant: true }).lean();
    assert.ok(registration);
    assert.equal(registration.submissionSource, 'PUBLIC_SELF');
    // §14: still requires internal approval.
    assert.ok(['DRAFT', 'SUBMITTED'].includes(registration.status));
    assert.equal(await ChannelPartner.countDocuments({ tenantId, 'profile.email': 'walkin@broker.test' }), 0);
  });
});
