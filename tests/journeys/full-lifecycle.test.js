const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Tenant, User, Role, Stage, SubStage, ActionType, VisitOutcome, LeadSource, Tag, Template,
  AckRule, Integration, NurtureSequence, SlaRule, Project, Tower, UnitType, Unit,
  PricingComponent, PaymentPlan, Contact, Lead, Followup, SiteVisit, UnitShortlist,
  CostSheet, Approval, ApprovalRule, UnitBlock, Booking, ResaleOpportunity, MarketingCampaign,
  CommunicationCampaign, MessageLog, Notification, AuditLog, AssignmentPool, Activity,
} = require('../../src/db/models');
const tzLib = require('../../src/lib/tz');

/**
 * End-to-end: the whole product driven through HTTP exactly as a browser would,
 * in one continuous run. Every step posts a real form with a real CSRF token
 * and asserts both the HTTP outcome and the state it left behind.
 *
 * This is deliberately not unit-shaped. It is the §88/§89/§90 daily journeys
 * plus the §123 "a successful V1 allows a company to…" checklist, executed in
 * order against one live organization.
 */
const inDays = (n) => tzLib.toDateInput(new Date(Date.now() + n * 86400000), 'Asia/Kolkata');

test('END-TO-END: a real estate company runs its whole sales operation', async (t) => {
  await h.startServer();
  await h.resetDb();
  t.after(async () => { await h.stopServer(); });

  const seed = require('../../src/db/seed');
  const org = await seed.createOrganization({
    name: 'Endtoend Estates',
    adminName: 'Asha Admin',
    adminEmail: 'admin@e2e.test',
    adminMobile: '9000011111',
    adminPassword: 'Password1',
  });
  const tenantId = org.tenant._id;

  const admin = h.client();
  const state = {};

  /* ══════════════ 1. The admin sets the organization up (§4, §47) ══════════ */

  await t.test('1.1 admin signs in and lands on their dashboard', async () => {
    const res = await admin.login('admin@e2e.test');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/app/dashboard');
    const dash = await admin.get('/app/dashboard');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Hello, Asha/);
  });

  await t.test('1.2 organization settings save (§4.3, §72, §73)', async () => {
    await admin.get('/app/setup/organization');
    const res = await admin.submit('/api/setup/organization', {
      name: 'Endtoend Estates', legalName: 'Endtoend Estates Pvt Ltd',
      timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN',
      website: 'https://endtoend.example.com', address: '12 Riverside Road, Ahmedabad',
    }, '/app/setup/organization');
    assert.equal(res.status, 302);
    const tenant = await Tenant.findById(tenantId).lean();
    assert.equal(tenant.legalName, 'Endtoend Estates Pvt Ltd');
    assert.equal(tenant.currency, 'INR');
  });

  await t.test('1.3 SLA thresholds are configurable and validated (§16.1)', async () => {
    await admin.get('/app/setup/sla');
    // Out-of-order thresholds are refused.
    await admin.submit('/api/setup/sla/defaults', {
      slaResponseMinutes: '5', slaWarningMinutes: '20', slaEscalationMinutes: '10',
      slaAutoReassignMinutes: '15', slaMaxAutoReassignments: '2',
    }, '/app/setup/sla');
    assert.match((await admin.get('/app/setup/sla')).text, /run in order/i);

    const res = await admin.submit('/api/setup/sla/defaults', {
      slaResponseMinutes: '5', slaWarningMinutes: '5', slaEscalationMinutes: '10',
      slaAutoReassignMinutes: '15', slaMaxAutoReassignments: '2',
      businessStart: '09:30', businessEnd: '19:00', reinquiryRestartsSla: '1',
    }, '/app/setup/sla');
    assert.equal(res.status, 302);
    const tenant = await Tenant.findById(tenantId).lean();
    assert.equal(tenant.settings.slaEscalationMinutes, 10);
    assert.equal(tenant.settings.reinquiryRestartsSla, true);
  });

  await t.test('1.4 a custom role is created and its permissions edited (§6)', async () => {
    await admin.get('/app/setup/roles');
    const created = await admin.submit('/api/setup/roles', {
      name: 'Site Executive', description: 'Handles walk-ins at the site',
      cloneFromId: String(org.roles['Sales User']._id),
    }, '/app/setup/roles');
    assert.equal(created.status, 302);

    const role = await Role.findOne({ tenantId, name: 'Site Executive' }).lean();
    assert.ok(role.permissions['lead.view'], 'cloned the source role');
    state.customRoleId = role._id;

    await admin.get(`/app/setup/roles/${role._id}`);
    const res = await admin.submit(`/api/setup/roles/${role._id}`, {
      name: 'Site Executive',
      'perm.lead.view': 'own',
      'perm.visit.create': '1',
      'perm.visit.complete': '1',
      'perm.followup.complete': '1',
      'perm.followup.create': '1',
      'perm.dashboard.own': '1',
    }, `/app/setup/roles/${role._id}`);
    assert.equal(res.status, 302);

    const updated = await Role.findOne({ tenantId, _id: role._id }).lean();
    assert.equal(updated.permissions['lead.view'], 'own');
    assert.equal(updated.permissions['lead.transfer'], undefined, 'unchecked permissions are dropped');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Role', action: 'PERMISSIONS_CHANGE' }));
  });

  await t.test('1.5 users are invited and activate themselves (§5.1)', async () => {
    const salesRole = await Role.findOne({ tenantId, name: 'Sales User' }).lean();
    const managerRole = await Role.findOne({ tenantId, name: 'Sales Manager' }).lean();

    await admin.get('/app/setup/users');
    await admin.submit('/api/setup/users', {
      name: 'Manoj Manager', email: 'manager@e2e.test', mobile: '9000022222', roleId: String(managerRole._id),
    }, '/app/setup/users');
    const managerLink = (await admin.get('/app/setup/users')).text.match(/\/accept-invite\?token=([A-Za-z0-9_-]+)/);
    assert.ok(managerLink, 'the admin is given an activation link');

    const managerClient = h.client();
    const activated = await managerClient.submit('/accept-invite', {
      token: managerLink[1], password: 'Password1', confirm: 'Password1',
    }, `/accept-invite?token=${managerLink[1]}`);
    assert.equal(activated.location, '/app/dashboard');
    state.manager = await User.findOne({ tenantId, email: 'manager@e2e.test' }).lean();
    assert.equal(state.manager.status, 'ACTIVE');

    for (const [name, email, mobile] of [['Priya Rep', 'priya@e2e.test', '9000033333'], ['Vikram Rep', 'vikram@e2e.test', '9000044444']]) {
      await admin.submit('/api/setup/users', {
        name, email, mobile, roleId: String(salesRole._id), managerId: String(state.manager._id),
      }, '/app/setup/users');
      const link = (await admin.get('/app/setup/users')).text.match(/\/accept-invite\?token=([A-Za-z0-9_-]+)/);
      const c = h.client();
      await c.submit('/accept-invite', { token: link[1], password: 'Password1', confirm: 'Password1' }, `/accept-invite?token=${link[1]}`);
    }
    state.priya = await User.findOne({ tenantId, email: 'priya@e2e.test' }).lean();
    state.vikram = await User.findOne({ tenantId, email: 'vikram@e2e.test' }).lean();
    assert.equal(state.priya.status, 'ACTIVE');
    assert.equal(String(state.priya.managerId), String(state.manager._id));

    // Reassign a user's role through the UI.
    const res = await admin.submit(`/api/setup/users/${state.vikram._id}/role`, {
      roleId: String(salesRole._id), managerId: String(state.manager._id),
    }, '/app/setup/users');
    assert.equal(res.status, 302);
  });

  await t.test('1.6 the distribution pool takes the new reps', async () => {
    await AssignmentPool.updateOne({ tenantId, isDefault: true }, {
      $set: { memberIds: [state.priya._id, state.vikram._id], escalationUserIds: [state.manager._id], cursor: 0 },
    });
    const pool = await AssignmentPool.findOne({ tenantId, isDefault: true }).lean();
    assert.equal(pool.memberIds.length, 2);
  });

  await t.test('1.7 pipeline masters are editable (§11, §78, §95)', async () => {
    await admin.get('/app/setup/stages');
    const stageRes = await admin.submit('/api/setup/stages', {
      name: 'Negotiation', semanticType: 'CUSTOM_ACTIVE', displayOrder: '6',
      colorToken: 'amber', requiresNextAction: '1',
    }, '/app/setup/stages');
    assert.equal(stageRes.status, 302);
    const negotiation = await Stage.findOne({ tenantId, name: 'Negotiation' }).lean();
    assert.ok(negotiation);

    await admin.submit('/api/setup/sub-stages', {
      stageId: String(negotiation._id), name: 'Price discussion', displayOrder: '1',
    }, '/app/setup/stages');
    assert.ok(await SubStage.findOne({ tenantId, stageId: negotiation._id, name: 'Price discussion' }));

    // Renaming a stage must not change its semantic type (§11.3).
    const connected = await Stage.findOne({ tenantId, semanticType: 'CONNECTED' }).lean();
    await admin.submit(`/api/setup/stages/${connected._id}`, {
      name: 'Spoke to customer', semanticType: 'CONNECTED', displayOrder: String(connected.displayOrder),
      colorToken: 'green', requiresNextAction: '1',
    }, '/app/setup/stages');
    const renamed = await Stage.findOne({ tenantId, _id: connected._id }).lean();
    assert.equal(renamed.name, 'Spoke to customer');
    assert.equal(renamed.semanticType, 'CONNECTED');

    // Deactivate a sub-stage, then the whole stage.
    const sub = await SubStage.findOne({ tenantId, stageId: negotiation._id }).lean();
    await admin.submit(`/api/setup/sub-stages/${sub._id}/toggle`, {}, '/app/setup/stages');
    assert.equal((await SubStage.findOne({ tenantId, _id: sub._id }).lean()).active, false);
    await admin.submit(`/api/setup/stages/${negotiation._id}/toggle`, {}, '/app/setup/stages');
    assert.equal((await Stage.findOne({ tenantId, _id: negotiation._id }).lean()).active, false);
    await admin.submit(`/api/setup/stages/${negotiation._id}/toggle`, {}, '/app/setup/stages');
  });

  await t.test('1.8 the flat masters all round-trip through their shared screen', async () => {
    for (const [slug, name, Model, extra] of [
      ['action-types', 'Send Payment Plan', ActionType, { semantic: 'OTHER' }],
      ['visit-outcomes', 'Wants a second visit', VisitOutcome, {}],
      ['sources', 'Hoarding', LeadSource, { category: 'OTHER' }],
      ['tags', 'Site Visit Done', Tag, {}],
    ]) {
      await admin.get(`/app/setup/${slug}`);
      const res = await admin.submit(`/api/setup/${slug}`, { name, displayOrder: '20', ...extra }, `/app/setup/${slug}`);
      assert.equal(res.status, 302, `${slug} create`);
      const doc = await Model.findOne({ tenantId, name }).lean();
      assert.ok(doc, `${slug} created`);

      await admin.submit(`/api/setup/${slug}/${doc._id}/toggle`, {}, `/app/setup/${slug}`);
      assert.equal((await Model.findOne({ tenantId, _id: doc._id }).lean()).active, false, `${slug} deactivated`);
      await admin.submit(`/api/setup/${slug}/${doc._id}/toggle`, {}, `/app/setup/${slug}`);
    }
  });

  await t.test('1.9 templates, acknowledgement and nurture are configured (§17, §19)', async () => {
    await admin.get('/app/setup/templates');
    await admin.submit('/api/setup/templates', {
      name: 'Site visit reminder', channel: 'WHATSAPP', purpose: 'NURTURE',
      body: 'Hi {{contact.first_name}}, shall we fix your visit to {{project.name|our project}} this weekend?',
    }, '/app/setup/templates');
    const template = await Template.findOne({ tenantId, name: 'Site visit reminder' }).lean();
    assert.ok(template);

    // Edit it back.
    await admin.submit(`/api/setup/templates/${template._id}`, {
      name: 'Site visit reminder', channel: 'WHATSAPP', purpose: 'NURTURE',
      body: 'Hi {{contact.first_name}}, can we fix your visit to {{project.name|our project}} this weekend?',
    }, '/app/setup/templates');
    assert.match((await Template.findOne({ tenantId, _id: template._id }).lean()).body, /can we fix/);

    // A rule whose channel disagrees with its template is refused.
    await admin.submit('/api/setup/ack-rules', {
      channel: 'SMS', templateId: String(template._id),
    }, '/app/setup/templates');
    assert.match((await admin.get('/app/setup/templates')).text, /channel must match/i);

    const ackBefore = await AckRule.countDocuments({ tenantId });
    await admin.submit('/api/setup/ack-rules', {
      channel: 'WHATSAPP', templateId: String(template._id),
    }, '/app/setup/templates');
    assert.equal(await AckRule.countDocuments({ tenantId }), ackBefore + 1);

    const seeded = await AckRule.findOne({ tenantId, projectId: null, channel: 'WHATSAPP' }).sort({ createdAt: 1 }).lean();
    await admin.submit(`/api/setup/ack-rules/${seeded._id}/toggle`, {}, '/app/setup/templates');
    assert.equal((await AckRule.findOne({ tenantId, _id: seeded._id }).lean()).active, false);
    await admin.submit(`/api/setup/ack-rules/${seeded._id}/toggle`, {}, '/app/setup/templates');

    // Nurture sequence with a message step and a task step.
    const connected = await Stage.findOne({ tenantId, semanticType: 'CONNECTED' }).lean();
    const callType = await ActionType.findOne({ tenantId, semantic: 'CALL' }).lean();
    await admin.get('/app/setup/nurture');
    const res = await admin.submit('/api/setup/nurture', {
      name: 'Warm lead cadence', stageId: String(connected._id),
      stopOnBooked: '1', stopOnLost: '1',
      stepDelay: ['2', '5'], stepKind: ['MESSAGE', 'TASK'],
      stepTemplateId: [String(template._id), ''], stepActionTypeId: ['', String(callType._id)],
      stepNote: ['', 'Check in on the customer'],
    }, '/app/setup/nurture');
    assert.equal(res.status, 302);
    const sequence = await NurtureSequence.findOne({ tenantId, name: 'Warm lead cadence' }).lean();
    assert.equal(sequence.steps.length, 2);
    assert.equal(sequence.steps[1].kind, 'TASK');

    await admin.submit(`/api/setup/nurture/${sequence._id}/toggle`, {}, '/app/setup/nurture');
    assert.equal((await NurtureSequence.findOne({ tenantId, _id: sequence._id }).lean()).active, false);
    await admin.submit(`/api/setup/nurture/${sequence._id}/toggle`, {}, '/app/setup/nurture');
  });

  await t.test('1.10 an inbound integration is created and its key rotated (§49, §63)', async () => {
    await admin.get('/app/setup/integrations');
    const res = await admin.submit('/api/setup/integrations', {
      category: 'META_LEAD_ADS', provider: 'meta', name: 'Meta Lead Ads', signingSecret: 'top-secret-hmac',
    }, '/app/setup/integrations');
    assert.equal(res.status, 302);

    const integration = await Integration.findOne({ tenantId, provider: 'meta' });
    assert.ok(integration.webhookKey, 'inbound integrations get a webhook URL');
    assert.ok(integration.secrets.get('signingSecret').startsWith('v1.'), 'the secret is sealed');
    const firstKey = integration.webhookKey;

    await admin.submit(`/api/setup/integrations/${integration._id}/rotate-key`, {}, '/app/setup/integrations');
    const rotated = await Integration.findOne({ tenantId, _id: integration._id }).lean();
    assert.notEqual(rotated.webhookKey, firstKey);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Integration', action: 'ROTATE_WEBHOOK_KEY' }));

    await admin.submit(`/api/setup/integrations/${integration._id}/toggle`, {}, '/app/setup/integrations');
    assert.equal((await Integration.findOne({ tenantId, _id: integration._id }).lean()).status, 'DISABLED');
    await admin.submit(`/api/setup/integrations/${integration._id}/toggle`, {}, '/app/setup/integrations');
  });

  /* ══════════════ 2. The project and its inventory (§26–§30) ══════════════ */

  await t.test('2.1 a project is created through the form (§26)', async () => {
    await admin.get('/app/projects/new');
    const res = await admin.submit('/api/projects', {
      name: 'Riverfront Heights', developerName: 'Endtoend Estates', code: 'RFH',
      status: 'ACTIVE', projectType: 'RESIDENTIAL', city: 'Ahmedabad', state: 'Gujarat',
      pincode: '380015', address: '12 Riverside Road', reraNumber: 'PR/GJ/AHM/0001',
      startingPriceMinor: '6500000', possessionDate: inDays(600),
      configurations: ['2 BHK', '3 BHK'], amenities: ['Clubhouse', 'Gym'],
      keyUsps: ['Riverfront view'], overview: 'Riverside apartments with a clubhouse.',
      salesContactName: 'Manoj Manager', salesContactMobile: '9000022222',
    }, '/app/projects/new');
    assert.equal(res.status, 302);
    // V1.1 §27.2: creation lands on the next step of the stepper, so the redirect
    // carries a query string.
    state.projectId = res.location.split('?')[0].split('/').pop();

    const project = await Project.findOne({ tenantId, _id: state.projectId }).lean();
    assert.equal(project.name, 'Riverfront Heights');
    assert.equal(project.status, 'ACTIVE');
    assert.deepEqual(project.configurations, ['2 BHK', '3 BHK'], 'comma lists arrive as arrays');
    assert.ok(project.qrToken, 'a walk-in QR token is minted');
    assert.ok(project.slug, 'and a mini-site slug');
    assert.equal(project.startingPriceMinor, 650000000, 'money stored in paise');
  });

  await t.test('2.2 a duplicate project name is refused', async () => {
    await admin.submit('/api/projects', { name: 'Riverfront Heights', status: 'ACTIVE' }, '/app/projects/new');
    assert.match((await admin.get('/app/projects/new')).text, /already exists/i);
    assert.equal(await Project.countDocuments({ tenantId, name: 'Riverfront Heights' }), 1);
  });

  await t.test('2.3 the project is edited and its status changed (§26.2)', async () => {
    await admin.get(`/app/projects/${state.projectId}/edit`);
    await admin.submit(`/api/projects/${state.projectId}`, {
      name: 'Riverfront Heights', status: 'ACTIVE', city: 'Ahmedabad',
      overview: 'Riverside apartments with a clubhouse and a 2-acre park.',
    }, `/app/projects/${state.projectId}/edit`);
    assert.match((await Project.findOne({ tenantId, _id: state.projectId }).lean()).overview, /2-acre park/);

    await admin.submit(`/api/projects/${state.projectId}/status`, { status: 'ON_HOLD' }, `/app/projects/${state.projectId}`);
    assert.equal((await Project.findOne({ tenantId, _id: state.projectId }).lean()).status, 'ON_HOLD');
    await admin.submit(`/api/projects/${state.projectId}/status`, { status: 'ACTIVE' }, `/app/projects/${state.projectId}`);
  });

  await t.test('2.4 towers, unit types and units are built from the UI (§27)', async () => {
    await admin.get(`/app/projects/${state.projectId}`);
    await admin.submit(`/api/projects/${state.projectId}/towers`, {
      name: 'Tower A', code: 'A', type: 'TOWER', floorCount: '4',
    }, `/app/projects/${state.projectId}`);
    const tower = await Tower.findOne({ tenantId, projectId: state.projectId }).lean();
    assert.ok(tower);
    assert.equal(await require('../../src/db/models').Floor.countDocuments({ tenantId, towerId: tower._id }), 4);
    state.towerId = tower._id;

    await admin.submit(`/api/projects/${state.projectId}/unit-types`, {
      name: '3 BHK', propertyType: 'APARTMENT', bedrooms: '3',
      carpetArea: '950', builtUpArea: '1150', superBuiltUpArea: '1300', defaultBaseRateMinor: '5200',
    }, `/app/projects/${state.projectId}`);
    const unitType = await UnitType.findOne({ tenantId, projectId: state.projectId, name: '3 BHK' }).lean();
    assert.equal(unitType.defaultBaseRateMinor, 520000);
    state.unitTypeId = unitType._id;

    // V1.1 §32.2: generation previews first — mass unit creation is the one setup
    // action that is painful to undo.
    const generateArgs = {
      towerId: String(tower._id), unitTypeId: String(unitType._id),
      unitsPerFloor: '3', numberPattern: '{floor}{index:02}', startIndex: '1',
    };
    const preview = await admin.submit(`/api/projects/${state.projectId}/units/generate`,
      generateArgs, `/app/projects/${state.projectId}`);
    assert.equal(preview.status, 200, 'the preview is shown, not the units');
    assert.match(preview.text, /will be created/);
    assert.match(preview.text, /101/, 'the actual unit numbers are on screen');
    assert.equal(await Unit.countDocuments({ tenantId, projectId: state.projectId }), 0, 'nothing written yet');

    const res = await admin.submit(`/api/projects/${state.projectId}/units/generate`,
      { ...generateArgs, confirm: '1' }, `/app/projects/${state.projectId}`);
    assert.equal(res.status, 302);
    assert.equal(await Unit.countDocuments({ tenantId, projectId: state.projectId }), 12, '4 floors × 3 units');

    // A one-off unit added by hand.
    await admin.get(`/app/inventory/${state.projectId}`);
    await admin.submit(`/api/projects/${state.projectId}/units`, {
      unitNumber: 'PH-1', towerId: String(tower._id), unitTypeId: String(unitType._id),
      floorNumber: '5', saleableArea: '2000', facing: 'East', parkingSlots: '2',
    }, `/app/inventory/${state.projectId}`);
    assert.ok(await Unit.findOne({ tenantId, unitNumber: 'PH-1' }));

    // The same number twice is refused.
    await admin.submit(`/api/projects/${state.projectId}/units`, {
      unitNumber: 'PH-1', towerId: String(tower._id),
    }, `/app/inventory/${state.projectId}`);
    assert.equal(await Unit.countDocuments({ tenantId, unitNumber: 'PH-1' }), 1);
  });

  await t.test('2.5 a unit is edited and put on hold, then released (§28.2, §53)', async () => {
    const unit = await Unit.findOne({ tenantId, unitNumber: 'PH-1' }).lean();
    await admin.submit(`/api/units/${unit._id}`, {
      unitNumber: 'PH-1', saleableArea: '2100', facing: 'North East', parkingSlots: '2',
      towerId: String(state.towerId), unitTypeId: String(state.unitTypeId), floorNumber: '5',
    }, `/app/inventory/${state.projectId}`);
    assert.equal((await Unit.findOne({ tenantId, _id: unit._id }).lean()).saleableArea, 2100);

    await admin.submit(`/api/units/${unit._id}/status`, { status: 'HOLD', reason: 'Held for the director' }, `/app/inventory/${state.projectId}`);
    assert.equal((await Unit.findOne({ tenantId, _id: unit._id }).lean()).status, 'HOLD');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Unit', action: 'STATUS_CHANGE' }));

    await admin.submit(`/api/units/${unit._id}/status`, { status: 'AVAILABLE' }, `/app/inventory/${state.projectId}`);
    assert.equal((await Unit.findOne({ tenantId, _id: unit._id }).lean()).status, 'AVAILABLE');
  });

  await t.test('2.6 pricing components and a payment plan are configured (§30.2, §34)', async () => {
    const components = [
      { name: 'Base price', kind: 'BASE', calcType: 'PER_AREA', rateMinor: '5200', areaBasis: 'SALEABLE', displayOrder: '1' },
      { name: 'Floor rise', kind: 'FLOOR_RISE', calcType: 'PER_AREA', rateMinor: '30', areaBasis: 'SALEABLE', displayOrder: '2' },
      { name: 'Club membership', kind: 'CLUB', calcType: 'FIXED', rateMinor: '200000', displayOrder: '3' },
      { name: 'Covered parking', kind: 'PARKING', calcType: 'PER_UNIT_COUNT', rateMinor: '250000', displayOrder: '4' },
      { name: 'GST', kind: 'TAX', calcType: 'PERCENTAGE', percentage: '5', displayOrder: '9' },
      { name: 'Stamp duty', kind: 'STAMP_DUTY', calcType: 'PERCENTAGE', percentage: '4.9', displayOrder: '10' },
    ];
    for (const component of components) {
      const res = await admin.submit(`/api/projects/${state.projectId}/pricing`, {
        ...component, mandatory: '1', customerVisible: '1',
      }, `/app/projects/${state.projectId}`);
      assert.equal(res.status, 302, `${component.name} saved`);
    }
    assert.equal(await PricingComponent.countDocuments({ tenantId, projectId: state.projectId }), 6);

    // Edit a component's rate.
    const base = await PricingComponent.findOne({ tenantId, projectId: state.projectId, kind: 'BASE' }).lean();
    await admin.submit(`/api/projects/${state.projectId}/pricing/${base._id}`, {
      name: 'Base price', kind: 'BASE', calcType: 'PER_AREA', rateMinor: '5500',
      areaBasis: 'SALEABLE', displayOrder: '1', mandatory: '1', customerVisible: '1',
    }, `/app/projects/${state.projectId}`);
    assert.equal((await PricingComponent.findOne({ tenantId, _id: base._id }).lean()).rateMinor, 550000);
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'PricingComponent', action: 'UPDATE' }), 'pricing edits are audited (§56)');

    await admin.submit(`/api/projects/${state.projectId}/payment-plans`, {
      name: 'Construction linked', type: 'CONSTRUCTION_LINKED',
      description: '10% on booking, 80% construction linked, 10% on possession.',
    }, `/app/projects/${state.projectId}`);
    state.planId = (await PaymentPlan.findOne({ tenantId, projectId: state.projectId }).lean())._id;
    assert.ok(state.planId);
  });

  await t.test('2.7 a project SLA override is added (§16.1)', async () => {
    await admin.get('/app/setup/sla');
    const res = await admin.submit('/api/setup/sla/rules', {
      projectId: String(state.projectId), responseMinutes: '3', warningMinutes: '3',
      escalationMinutes: '6', autoReassignMinutes: '9', maxAutoReassignments: '1',
      escalationUserIds: [String(state.manager._id)],
    }, '/app/setup/sla');
    assert.equal(res.status, 302);
    const rule = await SlaRule.findOne({ tenantId, projectId: state.projectId }).lean();
    assert.equal(rule.responseMinutes, 3);

    await admin.submit(`/api/setup/sla/rules/${rule._id}/toggle`, {}, '/app/setup/sla');
    assert.equal((await SlaRule.findOne({ tenantId, _id: rule._id }).lean()).active, false);
    await admin.submit(`/api/setup/sla/rules/${rule._id}/toggle`, {}, '/app/setup/sla');
  });

  await t.test('2.8 discount approval rules are seeded for the run', async () => {
    await ApprovalRule.create({
      tenantId, projectId: null, name: 'Over 2%', triggerType: 'DISCOUNT_PERCENTAGE',
      minThreshold: 2, level: 1, approverUserIds: [state.manager._id],
    });
    assert.equal(await ApprovalRule.countDocuments({ tenantId }), 1);
  });

  await t.test('2.9 the mini site is published with inventory disclosure controls (§64.2)', async () => {
    const res = await admin.submit(`/api/projects/${state.projectId}/mini-site`, {
      published: '1', showStartingPrice: '1', showConfigurationAvailability: '1',
    }, `/app/projects/${state.projectId}`);
    assert.equal(res.status, 302);
    const project = await Project.findOne({ tenantId, _id: state.projectId }).lean();
    assert.equal(project.miniSite.published, true);
    assert.equal(project.miniSite.showAvailability, false, 'unit-level inventory stays private');
    state.slug = project.slug;
    state.qrToken = project.qrToken;
  });

  /* ══════════════ 3. Lead capture from every channel (§12, §25, §64) ═══════ */

  await t.test('3.1 a lead arrives on the website webhook and is fully processed (§12.3)', async () => {
    const webhook = await Integration.findOne({ tenantId, category: 'WEBSITE_WEBHOOK' }).lean();
    const res = await h.client().postJson(`/api/webhooks/leads/${webhook.webhookKey}`, {
      name: 'Neha Kapoor', phone: '98250 70001', email: 'neha@example.com', city: 'Ahmedabad',
      project: 'Riverfront Heights', lead_id: 'web-1', utm_source: 'google', message: 'Need a 3 BHK',
    });
    assert.equal(res.status, 201);
    state.nehaLeadId = res.data.leadId;

    const lead = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();
    assert.equal(String(lead.projectId), String(state.projectId), 'project resolved by name');
    assert.ok(lead.ownerUserId, 'round robin assigned an owner');
    assert.equal(lead.slaTargetSeconds, 180, 'the project SLA override applied (3 min)');
    assert.equal(lead.slaStatus, 'PENDING');
    assert.ok(await MessageLog.findOne({ tenantId, leadId: lead._id, purpose: 'ACKNOWLEDGEMENT' }), 'acknowledged');
    assert.ok(await Notification.findOne({ tenantId, userId: lead.ownerUserId, type: 'LEAD_ASSIGNED' }));
  });

  await t.test('3.2 a walk-in checks in at the site QR (§25)', async () => {
    const anon = h.client();
    const form = await anon.get(`/visit/${state.qrToken}`);
    assert.equal(form.status, 200);
    assert.ok(!/otp/i.test(form.text), 'no OTP in V1');

    const res = await anon.post(`/visit/${state.qrToken}`, {
      name: 'Rohit Patel', mobile: '9825070002', visitingWith: 'CHANNEL_PARTNER',
      cpName: 'Acme Realty', cpMobile: '9825070099', visitorCount: '2',
    });
    assert.equal(res.status, 302);

    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919825070002' }).lean();
    const lead = await Lead.findOne({ tenantId, contactId: contact._id }).lean();
    const visit = await SiteVisit.findOne({ tenantId, leadId: lead._id }).lean();
    assert.equal(visit.viaQr, true);
    assert.equal(visit.channelPartnerName, 'Acme Realty');
    assert.ok(await Contact.findOne({ tenantId, normalizedMobile: '+919825070099' }), 'the CP is a contact too');
    state.rohitLeadId = lead._id;
  });

  await t.test('3.3 the mini site captures an inquiry (§64.3)', async () => {
    const anon = h.client();
    const page = await anon.get(`/p/${state.slug}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Riverfront Heights/);

    const res = await anon.post(`/p/${state.slug}/inquire`, {
      name: 'Meera Shah', mobile: '9825070003', email: 'meera@example.com', message: 'Send me the brochure',
    });
    assert.equal(res.status, 302);
    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919825070003' }).lean();
    const lead = await Lead.findOne({ tenantId, contactId: contact._id }).lean();
    assert.equal(String(lead.projectId), String(state.projectId));
    state.meeraLeadId = lead._id;
  });

  await t.test('3.4 a lead is entered by hand (§12)', async () => {
    const source = await LeadSource.findOne({ tenantId, category: 'REFERRAL' }).lean();
    await admin.get('/app/leads/new');
    const res = await admin.submit('/api/leads', {
      firstName: 'Arjun', lastName: 'Desai', primaryMobile: '9825070004', email: 'arjun@example.com',
      city: 'Ahmedabad', projectId: String(state.projectId), sourceId: String(source._id),
      ownerUserId: String(state.priya._id), budgetMinMinor: '7000000', budgetMaxMinor: '9000000',
      purpose: 'SELF_USE', requirementNote: 'Wants a high floor with a river view',
    }, '/app/leads/new');
    assert.equal(res.status, 302);
    state.arjunLeadId = res.location.split('/').pop();
    const lead = await Lead.findOne({ tenantId, _id: state.arjunLeadId }).lean();
    assert.equal(lead.budgetMaxMinor, 900000000);
    assert.equal(String(lead.ownerUserId), String(state.priya._id));
  });

  await t.test('3.5 the same mobile re-inquiring never duplicates the contact (§13.2, §55.4)', async () => {
    const webhook = await Integration.findOne({ tenantId, category: 'WEBSITE_WEBHOOK' }).lean();
    const before = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();

    const res = await h.client().postJson(`/api/webhooks/leads/${webhook.webhookKey}`, {
      name: 'Neha Kapoor', phone: '+91 98250 70001', project: 'Riverfront Heights', lead_id: 'web-2',
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.reinquiry, true);
    assert.equal(String(res.data.leadId), String(state.nehaLeadId), 'same opportunity');

    const after = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();
    assert.equal(after.inquiryCount, 2);
    assert.equal(String(after.originalSourceId), String(before.originalSourceId), 'original source untouched');
    assert.ok(after.reinquiryPendingAt);
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919825070001' }), 1);
  });

  /* ══════════════ 4. The salesperson's day (§88) ══════════════════════════ */

  await t.test('4.1 the rep opens their dashboard and sees the work waiting', async () => {
    const owner = (await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean()).ownerUserId;
    state.repEmail = String(owner) === String(state.priya._id) ? 'priya@e2e.test' : 'vikram@e2e.test';
    state.rep = h.client();
    await state.rep.login(state.repEmail);

    const dash = await state.rep.get('/app/dashboard');
    assert.equal(dash.status, 200);
    const tiles = h.tileCounts(dash.text);
    assert.ok(tiles['New leads'] >= 1, 'new leads waiting');
    assert.equal(tiles['Re-inquiries'], 1, 'the re-inquiry surfaced');
    assert.match(h.queueSection(dash.text), /Neha Kapoor/);
  });

  await t.test('4.2 a call with no next action is refused; with one it clears the tile (§55.1–3)', async () => {
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    const connected = await Stage.findOne({ tenantId, semanticType: 'CONNECTED' }).lean();
    const sub = await SubStage.findOne({ tenantId, stageId: connected._id, name: 'Interested' }).lean();

    const refused = await state.rep.submit(`/api/leads/${state.nehaLeadId}/log-action`, {
      actionTypeId: String(actions.CALL._id), stageId: String(connected._id), note: 'Spoke briefly',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(refused.status, 302);
    assert.match((await state.rep.get(`/app/leads/${state.nehaLeadId}`)).text, /cannot be left without one/i);
    assert.equal((await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean()).firstGenuineActionAt, undefined);

    const ok = await state.rep.submit(`/api/leads/${state.nehaLeadId}/log-action`, {
      actionTypeId: String(actions.CALL._id), stageId: String(connected._id), subStageId: String(sub._id),
      note: 'Wants a 3 BHK on a high floor',
      nextActionTypeId: String(actions.SITE_VISIT._id), nextDate: inDays(1), nextTime: '11:00',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(ok.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();
    assert.ok(lead.firstGenuineActionAt, 'the SLA clock stopped');
    assert.ok(lead.nextActionAt, 'and the lead carries its next action');
    assert.equal(lead.reinquiryPendingAt, undefined, 'the re-inquiry is acknowledged too');

    const dash = await state.rep.get('/app/dashboard');
    assert.ok(!h.queueSection(dash.text).includes('Neha Kapoor'), 'gone from New Leads');
  });

  await t.test('4.3 follow-ups can be added, rescheduled, cancelled and completed (§18)', async () => {
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

    await state.rep.submit(`/api/leads/${state.nehaLeadId}/followups`, {
      actionTypeId: String(actions.WHATSAPP._id), date: inDays(2), time: '15:00', note: 'Send the brochure',
    }, `/app/leads/${state.nehaLeadId}`);
    const extra = await Followup.findOne({ tenantId, leadId: state.nehaLeadId, note: 'Send the brochure' }).lean();
    assert.ok(extra);

    // A follow-up in the past is refused.
    await state.rep.submit(`/api/leads/${state.nehaLeadId}/followups`, {
      actionTypeId: String(actions.CALL._id), date: inDays(-3), time: '10:00',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.match((await state.rep.get(`/app/leads/${state.nehaLeadId}`)).text, /future/i);

    await state.rep.submit(`/api/followups/${extra._id}/reschedule`, {
      date: inDays(3), time: '16:30', note: 'Customer asked to move it',
    }, `/app/leads/${state.nehaLeadId}`);
    const moved = await Followup.findOne({ tenantId, _id: extra._id }).lean();
    assert.equal(tzLib.toDateInput(moved.dueAt, 'Asia/Kolkata'), inDays(3));

    await state.rep.submit(`/api/followups/${extra._id}/cancel`, { reason: 'Not needed' }, `/app/leads/${state.nehaLeadId}`);
    assert.equal((await Followup.findOne({ tenantId, _id: extra._id }).lean()).status, 'CANCELLED');

    // The lead still has its original next action, so the rule holds.
    const lead = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();
    assert.ok(lead.nextActionAt, 'cancelling one follow-up did not strand the lead');
  });

  await t.test('4.4 completing from the dashboard queue returns to that queue (§50)', async () => {
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    const due = await Followup.findOne({ tenantId, leadId: state.nehaLeadId, status: 'PENDING' }).lean();
    await Followup.updateOne({ tenantId, _id: due._id }, { $set: { dueAt: new Date() } });

    const dash = await state.rep.get('/app/dashboard?tile=today');
    assert.match(h.queueSection(dash.text), /Neha Kapoor/);

    const res = await state.rep.submit(`/api/followups/${due._id}/complete`, {
      returnTo: '/app/dashboard?tile=today',
      note: 'Confirmed the visit for tomorrow',
      nextActionTypeId: String(actions.SITE_VISIT._id), nextDate: inDays(1), nextTime: '11:00',
    }, '/app/dashboard?tile=today');
    assert.equal(res.location, '/app/dashboard?tile=today');
    assert.equal((await Followup.findOne({ tenantId, _id: due._id }).lean()).status, 'COMPLETED');
  });

  await t.test('4.5 a site visit is scheduled, rescheduled and completed (§24, §84)', async () => {
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    const outcomes = Object.fromEntries((await VisitOutcome.find({ tenantId }).lean()).map((o) => [o.name, o]));

    await state.rep.submit(`/api/leads/${state.nehaLeadId}/visits`, {
      projectId: String(state.projectId), date: inDays(1), time: '11:00',
      visitingWith: 'DIRECT', visitorCount: '2', notes: 'Bringing her husband',
    }, `/app/leads/${state.nehaLeadId}`);
    const visit = await SiteVisit.findOne({ tenantId, leadId: state.nehaLeadId }).lean();
    assert.ok(visit);
    const planned = await Stage.findOne({ tenantId, semanticType: 'VISIT_PLANNED' }).lean();
    assert.equal(String((await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean()).stageId), String(planned._id));

    await state.rep.submit(`/api/visits/${visit._id}/reschedule`, {
      date: inDays(2), time: '10:00', note: 'Moved a day',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(tzLib.toDateInput((await SiteVisit.findOne({ tenantId, _id: visit._id }).lean()).scheduledAt, 'Asia/Kolkata'), inDays(2));

    // Completion with no outcome is refused.
    await state.rep.submit(`/api/visits/${visit._id}/complete`, { notes: 'Went well' }, `/app/leads/${state.nehaLeadId}`);
    assert.equal((await SiteVisit.findOne({ tenantId, _id: visit._id }).lean()).status, 'PLANNED');

    const res = await state.rep.submit(`/api/visits/${visit._id}/complete`, {
      outcomeId: String(outcomes['Highly Interested']._id),
      notes: 'Loved the 3rd floor units',
      nextActionTypeId: String(actions.COST_SHEET._id), nextDate: inDays(3), nextTime: '12:00',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(res.status, 302);

    const done = await SiteVisit.findOne({ tenantId, _id: visit._id }).lean();
    assert.equal(done.status, 'COMPLETED');
    const visitDone = await Stage.findOne({ tenantId, semanticType: 'VISIT_DONE' }).lean();
    const lead = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();
    assert.equal(String(lead.stageId), String(visitDone._id));
    assert.equal(lead.completedVisitCount, 1);
    assert.ok(lead.nextActionAt);
  });

  await t.test('4.6 units are shortlisted and removed without touching inventory (§29)', async () => {
    const units = await Unit.find({ tenantId, projectId: state.projectId, status: 'AVAILABLE' }).sort({ unitNumber: 1 }).lean();
    state.unitA = units[0];
    state.unitB = units[1];

    for (const unit of [state.unitA, state.unitB]) {
      const res = await state.rep.submit(`/api/leads/${state.nehaLeadId}/shortlists`, {
        unitId: String(unit._id), note: 'Shown on the visit',
      }, `/app/leads/${state.nehaLeadId}`);
      assert.equal(res.status, 302);
    }
    assert.equal(await UnitShortlist.countDocuments({ tenantId, leadId: state.nehaLeadId, active: true }), 2);

    await state.rep.submit(`/api/leads/${state.nehaLeadId}/shortlists/${state.unitB._id}/remove`, {}, `/app/leads/${state.nehaLeadId}`);
    assert.equal(await UnitShortlist.countDocuments({ tenantId, leadId: state.nehaLeadId, active: true }), 1);
    assert.equal((await Unit.findOne({ tenantId, _id: state.unitB._id }).lean()).status, 'AVAILABLE', 'inventory untouched');
  });

  await t.test('4.7 a cost sheet is priced by the server and needs approval over threshold (§30, §31)', async () => {
    const page = await state.rep.get(`/app/leads/${state.nehaLeadId}/cost-sheets/new?unitId=${state.unitA._id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Final consideration/);

    const clean = await state.rep.submit(`/api/leads/${state.nehaLeadId}/cost-sheets`, {
      unitId: String(state.unitA._id), paymentPlanId: String(state.planId),
    }, `/app/leads/${state.nehaLeadId}/cost-sheets/new?unitId=${state.unitA._id}`);
    assert.equal(clean.status, 302);
    const v1 = await CostSheet.findOne({ tenantId, _id: clean.location.split('/').pop() }).lean();
    assert.equal(v1.status, 'DRAFT', 'no discount, no approval');
    assert.ok(v1.finalConsiderationMinor > 0);
    assert.ok(v1.lines.some((l) => l.kind === 'BASE'));

    const discounted = await state.rep.submit(`/api/leads/${state.nehaLeadId}/cost-sheets`, {
      unitId: String(state.unitA._id), discount: '400000', paymentPlanId: String(state.planId),
    }, `/app/leads/${state.nehaLeadId}/cost-sheets/new?unitId=${state.unitA._id}`);
    state.costSheetId = discounted.location.split('/').pop();
    const v2 = await CostSheet.findOne({ tenantId, _id: state.costSheetId }).lean();
    assert.equal(v2.version, 2);
    assert.equal(v2.status, 'APPROVAL_PENDING');
    assert.equal((await CostSheet.findOne({ tenantId, _id: v1._id }).lean()).status, 'SUPERSEDED');

    // Sharing and booking are both blocked while the approval is pending.
    await state.rep.submit(`/api/cost-sheets/${state.costSheetId}/share`, {}, `/app/cost-sheets/${state.costSheetId}`);
    assert.equal((await CostSheet.findOne({ tenantId, _id: state.costSheetId }).lean()).status, 'APPROVAL_PENDING');
  });

  await t.test('4.8 the manager approves it and the sheet is shared (§31.2, §30.3)', async () => {
    const managerClient = h.client();
    await managerClient.login('manager@e2e.test');

    const queue = await managerClient.get('/app/approvals');
    assert.equal(queue.status, 200);
    assert.match(queue.text, /Neha Kapoor/);

    const approval = await Approval.findOne({ tenantId, entityId: state.costSheetId, status: 'PENDING' }).lean();
    const res = await managerClient.submit(`/api/approvals/${approval._id}`, {
      decision: 'APPROVE', note: 'Fine for a corner unit',
    }, '/app/approvals');
    assert.equal(res.status, 302);

    const sheet = await CostSheet.findOne({ tenantId, _id: state.costSheetId }).lean();
    assert.equal(sheet.status, 'APPROVED');
    assert.ok(sheet.approvedAt);
    assert.ok(await Notification.findOne({ tenantId, type: 'DISCOUNT_APPROVED' }));

    const shared = await state.rep.submit(`/api/cost-sheets/${state.costSheetId}/share`, {}, `/app/cost-sheets/${state.costSheetId}`);
    assert.equal(shared.status, 302);
    const withToken = await CostSheet.findOne({ tenantId, _id: state.costSheetId }).lean();
    assert.equal(withToken.status, 'SHARED');

    const anon = h.client();
    const customerView = await anon.get(`/share/cost-sheet/${withToken.shareToken}`);
    assert.equal(customerView.status, 200);
    assert.match(customerView.text, /Cost breakdown/);
    assert.ok(!customerView.text.includes('internal'), 'internal lines stay internal');
  });

  await t.test('4.9 the unit is blocked, released, and blocked again (§32)', async () => {
    const first = await state.rep.submit(`/api/leads/${state.nehaLeadId}/blocks`, {
      unitId: String(state.unitA._id), costSheetId: String(state.costSheetId), tokenAmount: '100000',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(first.status, 302);
    assert.equal((await Unit.findOne({ tenantId, _id: state.unitA._id }).lean()).status, 'BLOCKED');
    const blockStage = await Stage.findOne({ tenantId, semanticType: 'BLOCKED' }).lean();
    assert.equal(String((await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean()).stageId), String(blockStage._id));

    const block = await UnitBlock.findOne({ tenantId, unitId: state.unitA._id, status: 'ACTIVE' }).lean();
    assert.ok(block.expiryAt, 'the expiry is stored on the block');

    // A rep cannot release someone's block; the manager can.
    const repRelease = await state.rep.submit(`/api/blocks/${block._id}/release`, { reason: 'Changed mind' }, `/app/leads/${state.nehaLeadId}`);
    assert.notEqual(repRelease.status, 200);
    assert.equal((await UnitBlock.findOne({ tenantId, _id: block._id }).lean()).status, 'ACTIVE');

    const managerClient = h.client();
    await managerClient.login('manager@e2e.test');
    await managerClient.get(`/app/leads/${state.nehaLeadId}`);
    const released = await managerClient.submit(`/api/blocks/${block._id}/release`, {
      reason: 'Customer wants a different floor',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(released.status, 302);
    assert.equal((await Unit.findOne({ tenantId, _id: state.unitA._id }).lean()).status, 'AVAILABLE');
    assert.equal((await UnitBlock.findOne({ tenantId, _id: block._id }).lean()).status, 'RELEASED');

    await state.rep.submit(`/api/leads/${state.nehaLeadId}/blocks`, {
      unitId: String(state.unitA._id), costSheetId: String(state.costSheetId), tokenAmount: '100000',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal((await Unit.findOne({ tenantId, _id: state.unitA._id }).lean()).status, 'BLOCKED');
  });

  await t.test('4.10 the booking closes the deal and fires every side effect (§33.4)', async () => {
    const sheet = await CostSheet.findOne({ tenantId, _id: state.costSheetId }).lean();
    const form = await state.rep.get(`/app/leads/${state.nehaLeadId}/bookings/new`);
    assert.equal(form.status, 200);
    assert.match(form.text, /Confirm booking/);

    // A price that disagrees with the approved sheet is refused.
    const mismatch = await state.rep.submit(`/api/leads/${state.nehaLeadId}/bookings`, {
      unitId: String(state.unitA._id), costSheetId: String(sheet._id), bookingDate: inDays(0),
      finalPrice: String(sheet.finalConsiderationMinor / 100 - 50000), bookingAmount: '500000',
      paymentPlanId: String(state.planId), buyerPurpose: 'SELF_USE',
    }, `/app/leads/${state.nehaLeadId}/bookings/new`);
    assert.equal(mismatch.status, 302);
    assert.equal(await Booking.countDocuments({ tenantId, unitId: state.unitA._id }), 0);

    const res = await state.rep.submit(`/api/leads/${state.nehaLeadId}/bookings`, {
      unitId: String(state.unitA._id), costSheetId: String(sheet._id), bookingDate: inDays(0),
      finalPrice: String(sheet.finalConsiderationMinor / 100), bookingAmount: '500000',
      paymentPlanId: String(state.planId), buyerPurpose: 'INVESTMENT',
      expectedExitDate: inDays(45), expectedExitPrice: '9500000', expectedRoiPercentage: '18',
    }, `/app/leads/${state.nehaLeadId}/bookings/new`);
    assert.equal(res.status, 302);
    // V2 §109: the redirect now opens the booking workspace with a created flag.
    state.bookingId = res.location.split('?')[0].split('/').pop();

    const booking = await Booking.findOne({ tenantId, _id: state.bookingId }).lean();
    assert.ok(booking, 'booking created');
    assert.equal(booking.sagaComplete, true);
    assert.equal((await Unit.findOne({ tenantId, _id: state.unitA._id }).lean()).status, 'BOOKED');
    assert.equal((await UnitBlock.findOne({ tenantId, unitId: state.unitA._id, status: 'CONVERTED' }).lean()) !== null, true);

    const lead = await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean();
    assert.equal(lead.status, 'TERMINAL');
    assert.equal(lead.nextActionAt, undefined, 'a booked lead needs no next action');
    assert.equal(await Followup.countDocuments({ tenantId, leadId: lead._id, status: 'PENDING' }), 0);
    assert.ok(await ResaleOpportunity.findOne({ tenantId, bookingId: booking._id }), 'investor resale opportunity created');

    const page = await state.rep.get(`/app/bookings/${state.bookingId}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Investor exit/);
  });

  await t.test('4.11 a closed lead refuses new work until it is reopened (§18.6, §81)', async () => {
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    await state.rep.submit(`/api/leads/${state.nehaLeadId}/followups`, {
      actionTypeId: String(actions.CALL._id), date: inDays(1), time: '10:00',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal(await Followup.countDocuments({ tenantId, leadId: state.nehaLeadId, status: 'PENDING' }), 0);

    // A booked lead cannot be reopened at all.
    const connected = await Stage.findOne({ tenantId, semanticType: 'CONNECTED' }).lean();
    await admin.submit(`/api/leads/${state.nehaLeadId}/reopen`, {
      stageId: String(connected._id), reason: 'Trying to reopen a booked lead',
    }, `/app/leads/${state.nehaLeadId}`);
    assert.equal((await Lead.findOne({ tenantId, _id: state.nehaLeadId }).lean()).status, 'TERMINAL');
  });

  /* ══════════════ 5. Losing, transferring and reopening (§15, §81, §82) ═══ */

  await t.test('5.1 a lead is marked lost with a reason and then reopened', async () => {
    const lost = await Stage.findOne({ tenantId, semanticType: 'LOST' }).lean();
    const reason = await SubStage.findOne({ tenantId, stageId: lost._id, name: 'Budget' }).lean();

    await admin.submit(`/api/leads/${state.meeraLeadId}/stage`, { stageId: String(lost._id) }, `/app/leads/${state.meeraLeadId}`);
    assert.equal((await Lead.findOne({ tenantId, _id: state.meeraLeadId }).lean()).status, 'ACTIVE', 'no reason, no close');

    await admin.submit(`/api/leads/${state.meeraLeadId}/stage`, {
      stageId: String(lost._id), subStageId: String(reason._id), note: 'Budget too tight',
    }, `/app/leads/${state.meeraLeadId}`);
    const closed = await Lead.findOne({ tenantId, _id: state.meeraLeadId }).lean();
    assert.equal(closed.status, 'TERMINAL');
    assert.ok(closed.lostAt);

    const connected = await Stage.findOne({ tenantId, semanticType: 'CONNECTED' }).lean();
    const res = await admin.submit(`/api/leads/${state.meeraLeadId}/reopen`, {
      stageId: String(connected._id), ownerUserId: String(state.vikram._id), reason: 'Budget improved',
    }, `/app/leads/${state.meeraLeadId}`);
    assert.equal(res.status, 302);
    const reopened = await Lead.findOne({ tenantId, _id: state.meeraLeadId }).lean();
    assert.equal(reopened.status, 'ACTIVE');
    assert.ok(reopened.lostAt, 'the lost history is preserved');
    assert.equal(String(reopened.ownerUserId), String(state.vikram._id));
  });

  await t.test('5.2 a transfer moves the lead and its open work, keeping history (§15.3)', async () => {
    const before = await Activity.countDocuments({ tenantId, leadId: state.arjunLeadId });
    const res = await admin.submit(`/api/leads/${state.arjunLeadId}/transfer`, {
      toUserId: String(state.vikram._id), reason: 'Territory change', note: 'Vikram covers the west zone',
    }, `/app/leads/${state.arjunLeadId}`);
    assert.equal(res.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: state.arjunLeadId }).lean();
    assert.equal(String(lead.ownerUserId), String(state.vikram._id));
    assert.equal(String(lead.previousOwnerUserId), String(state.priya._id));
    assert.ok(await Activity.countDocuments({ tenantId, leadId: state.arjunLeadId }) > before, 'history only grows');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Lead', action: 'TRANSFER' }));
  });

  await t.test('5.3 lead requirement details are edited from the workspace (§79, §80)', async () => {
    const res = await admin.submit(`/api/leads/${state.arjunLeadId}`, {
      budgetMinMinor: '7500000', budgetMaxMinor: '9500000', purpose: 'INVESTMENT',
      priority: 'HIGH', requirementNote: 'Wants the top floor, east facing',
    }, `/app/leads/${state.arjunLeadId}`);
    assert.equal(res.status, 302);
    const lead = await Lead.findOne({ tenantId, _id: state.arjunLeadId }).lean();
    assert.equal(lead.budgetMaxMinor, 950000000);
    assert.equal(lead.priority, 'HIGH');

    // The system-owned source fields are not editable this way (§80).
    const original = lead.originalSourceId;
    await admin.submit(`/api/leads/${state.arjunLeadId}`, {
      originalSourceId: String((await LeadSource.findOne({ tenantId, category: 'META' }).lean())._id),
      priority: 'HIGH',
    }, `/app/leads/${state.arjunLeadId}`);
    assert.equal(String((await Lead.findOne({ tenantId, _id: state.arjunLeadId }).lean()).originalSourceId), String(original));
  });

  await t.test('5.4 notes with @mentions notify the mentioned user (§22)', async () => {
    const res = await admin.submit(`/api/leads/${state.arjunLeadId}/notes`, {
      body: 'Site visit went well. @Vikram Rep please send the payment plan.',
    }, `/app/leads/${state.arjunLeadId}`);
    assert.equal(res.status, 302);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(await Notification.findOne({ tenantId, userId: state.vikram._id, type: 'USER_MENTIONED' }));
  });

  /* ══════════════ 6. SLA escalation on a neglected lead (§16) ═════════════ */

  await t.test('6.1 an unattended lead warns, escalates and reassigns (§16.4)', async () => {
    const sla = require('../../src/services/sla');
    const lead = await Lead.findOne({ tenantId, _id: state.rohitLeadId }).lean();
    const originalOwner = lead.ownerUserId;

    await Lead.updateOne({ tenantId, _id: lead._id }, {
      $set: { assignedAt: new Date(Date.now() - 4 * 60000), slaStatus: 'PENDING' },
    });
    await sla.tick({ tenantId });
    assert.equal((await Lead.findOne({ tenantId, _id: lead._id }).lean()).slaStatus, 'AT_RISK');
    assert.ok(await Notification.findOne({ tenantId, leadId: lead._id, type: 'SLA_WARNING' }));

    await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { assignedAt: new Date(Date.now() - 7 * 60000) } });
    await sla.tick({ tenantId });
    const breached = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(breached.slaBreached, true);
    assert.ok(await Notification.findOne({ tenantId, userId: state.manager._id, type: 'SLA_BREACHED' }));

    await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { assignedAt: new Date(Date.now() - 10 * 60000) } });
    await sla.tick({ tenantId });
    const reassigned = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.notEqual(String(reassigned.ownerUserId), String(originalOwner), 'passed to the next rep');
    assert.equal(reassigned.reassignmentCount, 1);
  });

  /* ══════════════ 7. The manager's and management's day (§89, §90) ════════ */

  await t.test('7.1 the manager sees exceptions, not a report (§8.4, §89)', async () => {
    const managerClient = h.client();
    await managerClient.login('manager@e2e.test');
    const team = await managerClient.get('/app/dashboard?view=team');
    assert.equal(team.status, 200);
    const tiles = h.tileCounts(team.text);
    assert.ok('Unattended new leads' in tiles);
    assert.ok('SLA missed' in tiles);
    assert.ok(tiles['SLA missed'] >= 1, 'the breached lead is visible to the manager');

    const sla = await managerClient.get('/app/dashboard?view=team&tile=sla');
    assert.equal(sla.status, 200);
    assert.match(h.queueSection(sla.text), /Rohit Patel/);
  });

  await t.test('7.2 management sees the funnel through to revenue (§8.5, §90)', async () => {
    const page = await admin.get('/app/dashboard/management');
    assert.equal(page.status, 200);
    assert.match(page.text, /Business funnel/);

    const reports = require('../../src/services/reports');
    const summary = await reports.managementSummary({ tenantId, tenant: org.tenant, zone: 'Asia/Kolkata' });
    assert.ok(summary.funnel.leads >= 4);
    assert.equal(summary.funnel.bookings, 1);
    assert.ok(summary.funnel.revenueMinor > 0);
    assert.ok(summary.opportunities.resaleNext90 >= 1);
  });

  await t.test('7.3 all five reports render and export (§43, §76)', async () => {
    for (const kind of ['leads', 'sales', 'projects', 'campaigns', 'activities']) {
      const page = await admin.get(`/app/reports/${kind}`);
      assert.equal(page.status, 200, `${kind} report renders`);

      const csv = await admin.get(`/app/reports/${kind}/export`);
      assert.equal(csv.status, 200, `${kind} export`);
      assert.match(csv.headers.get('content-type'), /text\/csv/);
      assert.ok(csv.text.split('\n')[0].includes(','), `${kind} csv has a header row`);
    }
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'Report', action: 'EXPORT' }));
  });

  await t.test('7.4 a rep only reports on their own leads (§6.3)', async () => {
    const page = await state.rep.get('/app/reports/leads');
    assert.equal(page.status, 200);
    // Arjun belongs to Vikram after the transfer; if this rep is Priya it must be hidden.
    if (state.repEmail === 'priya@e2e.test') {
      assert.ok(!page.text.includes('Arjun'), "another rep's lead is not in this report");
    }
  });

  await t.test('7.5 global search finds people, projects and units (§46)', async () => {
    const byMobile = await admin.get('/app/search?q=' + encodeURIComponent('098250 70001'));
    assert.equal(byMobile.status, 200);
    assert.match(byMobile.text, /Neha Kapoor/);

    const byUnit = await admin.get(`/app/search?q=${state.unitA.unitNumber}`);
    assert.match(byUnit.text, /Riverfront Heights/);

    const byProject = await admin.get('/app/search?q=Riverfront');
    assert.match(byProject.text, /Riverfront Heights/);
  });

  await t.test('7.6 the audit trail records the sensitive changes (§56)', async () => {
    const page = await admin.get('/app/setup/audit');
    assert.equal(page.status, 200);
    const actions = await AuditLog.distinct('action', { tenantId });
    for (const expected of ['PERMISSIONS_CHANGE', 'TRANSFER', 'STATUS_CHANGE', 'CREATE', 'EXPORT']) {
      assert.ok(actions.includes(expected), `${expected} is audited`);
    }
  });

  /* ══════════════ 8. Marketing (§37–§40) ═════════════════════════════════ */

  await t.test('8.1 a contact is created, edited and its consent set (§9, §67)', async () => {
    await admin.get('/app/contacts/new');
    const res = await admin.submit('/api/contacts', {
      firstName: 'Kavita', lastName: 'Iyer', primaryMobile: '9825070005',
      email: 'kavita@example.com', city: 'Ahmedabad',
    }, '/app/contacts/new');
    assert.equal(res.status, 302);
    const contactId = res.location.split('/').pop();

    await admin.get(`/app/contacts/${contactId}`);
    await admin.submit(`/api/contacts/${contactId}`, {
      firstName: 'Kavita', lastName: 'Iyer', primaryMobile: '9825070005',
      email: 'kavita.iyer@example.com', city: 'Gandhinagar',
    }, `/app/contacts/${contactId}`);
    const updated = await Contact.findOne({ tenantId, _id: contactId }).lean();
    assert.equal(updated.city, 'Gandhinagar');
    assert.equal(updated.email, 'kavita.iyer@example.com');

    await admin.submit(`/api/contacts/${contactId}/consent`, {
      whatsappOptOut: '1', reason: 'Asked not to be messaged',
    }, `/app/contacts/${contactId}`);
    const consented = await Contact.findOne({ tenantId, _id: contactId }).lean();
    assert.equal(consented.consent.whatsappOptOut, true);
    state.optedOutContactId = contactId;
  });

  await t.test('8.2 a campaign counts its audience, then sends and excludes opt-outs (§38, §67)', async () => {
    const template = await Template.findOne({ tenantId, channel: 'WHATSAPP', purpose: 'ACKNOWLEDGEMENT' }).lean();
    const build = await admin.get('/app/campaigns/communication/new?city=Gandhinagar');
    assert.equal(build.status, 200);
    assert.match(build.text, /1 contacts|1 contact/);

    const created = await admin.submit('/api/campaigns/communication', {
      name: 'Gandhinagar offer', channel: 'WHATSAPP', templateId: String(template._id),
      city: 'Gandhinagar', saveSegmentAs: 'Gandhinagar contacts',
    }, '/app/campaigns/communication/new?city=Gandhinagar');
    assert.equal(created.status, 302);
    const campaignId = created.location.split('/').pop();
    assert.equal(await MessageLog.countDocuments({ tenantId, campaignId }), 0, 'saving does not send');

    await admin.get(`/app/campaigns/${campaignId}`);
    const sent = await admin.submit(`/api/campaigns/${campaignId}/send`, {}, `/app/campaigns/${campaignId}`);
    assert.equal(sent.status, 302);

    const campaign = await CommunicationCampaign.findOne({ tenantId, _id: campaignId }).lean();
    assert.equal(campaign.status, 'SENT');
    assert.equal(campaign.recipientCount, 1);
    assert.equal(campaign.excludedCount, 1, 'the opted-out contact was excluded and counted');
    assert.equal(campaign.sentCount, 0);

    // A second send is refused.
    await admin.submit(`/api/campaigns/${campaignId}/send`, {}, `/app/campaigns/${campaignId}`);
    assert.match((await admin.get(`/app/campaigns/${campaignId}`)).text, /already sent/i);
  });

  await t.test('8.3 ad spend is entered, edited and attributed (§39, §40, §93)', async () => {
    await admin.get('/app/campaigns/performance');
    const res = await admin.submit('/api/campaigns/marketing', {
      name: 'Meta — riverfront 3 BHK', platform: 'META', projectId: String(state.projectId),
      startDate: inDays(-30), endDate: inDays(0), spend: '150000', externalCampaignId: 'meta-001',
    }, '/app/campaigns/performance');
    assert.equal(res.status, 302);
    const campaign = await MarketingCampaign.findOne({ tenantId, name: 'Meta — riverfront 3 BHK' }).lean();
    assert.equal(campaign.spendMinor, 15000000);

    await admin.submit(`/api/campaigns/marketing/${campaign._id}/spend`, { spend: '175000' }, '/app/campaigns/performance');
    assert.equal((await MarketingCampaign.findOne({ tenantId, _id: campaign._id }).lean()).spendMinor, 17500000);

    // Attribute the booked lead to it and check the funnel reads through.
    await Lead.updateOne({ tenantId, _id: state.nehaLeadId }, {
      $set: { campaignId: campaign._id, firstTouchCampaignId: campaign._id, lastTouchCampaignId: campaign._id },
    });
    const attribution = require('../../src/services/attribution');
    const perf = await attribution.performance({ tenantId, tenant: org.tenant });
    const row = perf.rows.find((r) => String(r._id) === String(campaign._id));
    assert.equal(row.leads, 1);
    assert.equal(row.bookings, 1);
    assert.ok(row.roas > 0, 'revenue against spend');
    assert.equal(row.costPerBookingMinor, 17500000);

    const switched = await admin.submit('/api/campaigns/attribution', { attributionModel: 'FIRST_TOUCH' }, '/app/campaigns/performance');
    assert.equal(switched.status, 302);
    assert.equal((await Tenant.findById(tenantId).lean()).settings.attributionModel, 'FIRST_TOUCH');
    assert.equal((await admin.get('/app/campaigns/performance')).status, 200);
  });

  await t.test('8.4 a provider delivery callback updates the message (§66)', async () => {
    const messaging = await Integration.findOne({ tenantId, category: 'WHATSAPP' });
    messaging.webhookKey = 'e2e-msg-key';
    await messaging.save();

    const log = await MessageLog.findOne({ tenantId, status: 'SENT' }).lean();
    const res = await h.client().postJson(`/api/webhooks/messages/${messaging.webhookKey}`, {
      messageId: log.providerMessageId, status: 'delivered',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.applied, 1);
    assert.equal((await MessageLog.findOne({ tenantId, _id: log._id }).lean()).status, 'DELIVERED');
  });

  /* ══════════════ 9. AI, opportunities and the long tail ═════════════════ */

  await t.test('9.1 the assistant answers from real data only (§42)', async () => {
    const summary = await admin.get(`/api/ai/leads/${state.arjunLeadId}/summary`, { headers: { accept: 'application/json' } });
    assert.equal(summary.status, 200);
    assert.ok(summary.data.bullets.length >= 3);

    const units = await admin.get(`/api/ai/leads/${state.arjunLeadId}/units`, { headers: { accept: 'application/json' } });
    for (const unit of units.data.units) {
      const real = await Unit.findOne({ tenantId, _id: unit._id }).lean();
      assert.equal(real.status, 'AVAILABLE');
    }

    const ask = await admin.get(`/api/ai/ask?projectId=${state.projectId}&q=` + encodeURIComponent('What 3 BHK units are available under 1 cr?'), { headers: { accept: 'application/json' } });
    assert.match(ask.data.answer, /available/i);
    const booked = await admin.get(`/api/ai/ask?projectId=${state.projectId}&q=` + encodeURIComponent(`What is the final cost of unit ${state.unitA.unitNumber}?`), { headers: { accept: 'application/json' } });
    assert.match(booked.data.answer, /booked/i, 'a booked unit is reported as booked, not offered');
  });

  await t.test('9.2 the resale queue is workable (§35)', async () => {
    const page = await admin.get('/app/opportunities/resale');
    assert.equal(page.status, 200);
    assert.match(page.text, /Neha Kapoor/);

    const opportunity = await ResaleOpportunity.findOne({ tenantId }).lean();
    const res = await admin.submit(`/api/opportunities/resale/${opportunity._id}`, {
      status: 'IN_DISCUSSION', nextActionNote: 'Call about the exit price',
    }, '/app/opportunities/resale');
    assert.equal(res.status, 302);
    assert.equal((await ResaleOpportunity.findOne({ tenantId, _id: opportunity._id }).lean()).status, 'IN_DISCUSSION');

    assert.equal((await admin.get('/app/opportunities/rental')).status, 200);
  });

  await t.test('9.3 notifications can be read, and the profile password changed (§45, §48)', async () => {
    const before = await Notification.countDocuments({ tenantId, userId: state.manager._id, readAt: null });
    assert.ok(before > 0);

    const managerClient = h.client();
    await managerClient.login('manager@e2e.test');
    await managerClient.get('/app/notifications');
    await managerClient.submit('/api/notifications/read', {}, '/app/notifications');
    assert.equal(await Notification.countDocuments({ tenantId, userId: state.manager._id, readAt: null }), 0);

    await managerClient.get('/app/profile');
    const wrong = await managerClient.submit('/app/profile/password', {
      currentPassword: 'WrongPass1', password: 'NewPassword1', confirm: 'NewPassword1',
    }, '/app/profile');
    assert.equal(wrong.status, 302);
    assert.match((await managerClient.get('/app/profile')).text, /current password is incorrect/i);

    await managerClient.submit('/app/profile/password', {
      currentPassword: 'Password1', password: 'NewPassword1', confirm: 'NewPassword1',
    }, '/app/profile');
    const fresh = h.client();
    assert.equal((await fresh.login('manager@e2e.test', 'NewPassword1')).location, '/app/dashboard');
  });

  await t.test('9.4 a user holding open work cannot be deactivated (§102)', async () => {
    const res = await admin.submit(`/api/setup/users/${state.vikram._id}/status`, { status: 'INACTIVE' }, '/app/setup/users');
    assert.equal(res.status, 302);
    assert.equal((await User.findOne({ tenantId, _id: state.vikram._id }).lean()).status, 'ACTIVE');
    assert.match((await admin.get('/app/setup/users')).text, /Transfer them first/i);
  });

  await t.test('9.5 the scheduler runs every job without error (§107)', async () => {
    const scheduler = require('../../src/jobs/scheduler');
    const results = await scheduler.runOnce();
    for (const [name, result] of Object.entries(results)) {
      assert.ok(!result?.error, `${name} ran clean: ${result?.error || ''}`);
    }
    assert.ok(Object.keys(results).length >= 6, 'every job is wired');
  });

  await t.test('9.6 the whole §123 V1 checklist is demonstrably true', async () => {
    const [contacts, leads, projects, units, visits, sheets, blocks, bookings, opportunities, campaigns] = await Promise.all([
      Contact.countDocuments({ tenantId }),
      Lead.countDocuments({ tenantId }),
      Project.countDocuments({ tenantId }),
      Unit.countDocuments({ tenantId }),
      SiteVisit.countDocuments({ tenantId }),
      CostSheet.countDocuments({ tenantId }),
      UnitBlock.countDocuments({ tenantId }),
      Booking.countDocuments({ tenantId }),
      ResaleOpportunity.countDocuments({ tenantId }),
      MarketingCampaign.countDocuments({ tenantId }),
    ]);
    assert.ok(contacts >= 6, 'contacts captured from four different channels');
    assert.ok(leads >= 4);
    assert.equal(projects, 1);
    assert.equal(units, 13);
    assert.ok(visits >= 2);
    assert.ok(sheets >= 2);
    assert.ok(blocks >= 2);
    assert.equal(bookings, 1);
    assert.equal(opportunities, 1);
    assert.equal(campaigns, 1);

    // And the one rule that must never be violated anywhere in the tenant:
    const stranded = await Lead.find({
      tenantId, status: 'ACTIVE', firstGenuineActionAt: { $ne: null }, nextActionAt: null,
    }).lean();
    assert.equal(stranded.length, 0, 'no attended active lead is left without a next action (§55.1)');
  });
});
