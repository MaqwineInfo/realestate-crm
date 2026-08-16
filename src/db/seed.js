const crypto = require('node:crypto');
const db = require('./index');
const {
  Tenant, User, Role, Stage, SubStage, ActionType, VisitOutcome, LeadSource, Tag, AssignmentPool,
  Template, AckRule, Integration,
} = require('./models');
const permissions = require('../lib/permissions');
const password = require('../lib/password');
const phone = require('../lib/phone');

/**
 * Spec §78: a new tenant receives sensible defaults so an admin can start
 * selling without configuring masters first. Everything here is editable
 * afterwards — none of it is hard-coded behaviour.
 */
const DEFAULT_STAGES = [
  { name: 'New Lead', semanticType: 'NEW', colorToken: 'blue', displayOrder: 1 },
  { name: 'Not Connected', semanticType: 'NOT_CONNECTED', colorToken: 'slate', displayOrder: 2, requiresSubStage: true },
  { name: 'Connected', semanticType: 'CONNECTED', colorToken: 'green', displayOrder: 3 },
  { name: 'Site Visit Planned', semanticType: 'VISIT_PLANNED', colorToken: 'violet', displayOrder: 4 },
  { name: 'Site Visit Done', semanticType: 'VISIT_DONE', colorToken: 'violet', displayOrder: 5 },
  { name: 'Block Unit', semanticType: 'BLOCKED', colorToken: 'amber', displayOrder: 6 },
  { name: 'Booked', semanticType: 'BOOKED', colorToken: 'green', displayOrder: 7, terminal: true, requiresNextAction: false },
  { name: 'Lost', semanticType: 'LOST', colorToken: 'red', displayOrder: 8, terminal: true, requiresNextAction: false, requiresSubStage: true },
];

const DEFAULT_SUB_STAGES = {
  'Not Connected': ['No Answer', 'Busy', 'Switched Off', 'Wrong Number'],
  Connected: ['Interested', 'Call Later', 'Details Shared', 'Budget Discussion'],
  Lost: ['Budget', 'Location', 'Competitor', 'Not Interested', 'Purchased Elsewhere'],
};

const DEFAULT_ACTION_TYPES = [
  ['Call', 'CALL'], ['WhatsApp', 'WHATSAPP'], ['Meeting', 'MEETING'], ['Site Visit', 'SITE_VISIT'],
  ['Send Cost Sheet', 'COST_SHEET'], ['Send Brochure', 'BROCHURE'], ['Video Call', 'VIDEO_CALL'],
  ['Email', 'EMAIL'], ['Other', 'OTHER'],
];

const DEFAULT_VISIT_OUTCOMES = [
  ['Highly Interested', false], ['Interested', false], ['Follow-up Required', false],
  ['Negotiation', false], ['Unit Shortlisted', false], ['Budget Mismatch', true],
  ['Location Concern', true], ['Not Interested', true],
];

const DEFAULT_SOURCES = [
  ['Facebook Ads', 'META'], ['Instagram Ads', 'META'], ['Google Ads', 'GOOGLE'], ['LinkedIn Ads', 'LINKEDIN'],
  ['Housing', 'PROPERTY_PORTAL'], ['MagicBricks', 'PROPERTY_PORTAL'], ['99acres', 'PROPERTY_PORTAL'],
  ['Website', 'WEBSITE'], ['Landing Page', 'LANDING_PAGE'], ['IVR Call', 'IVR'], ['WhatsApp', 'WHATSAPP'],
  ['Chatbot', 'CHATBOT'], ['Project QR / Walk-in', 'QR'], ['Walk-in', 'WALK_IN'], ['Referral', 'REFERRAL'],
  ['Manual Entry', 'MANUAL'], ['API', 'API'],
];

const DEFAULT_TAGS = ['Investor', 'Member', 'Channel Partner', 'Past Customer', 'NRI', 'High Intent'];

/** Creates the masters a tenant needs. Safe to re-run: it only fills gaps. */
async function seedTenantDefaults(tenantId) {
  const stageDocs = {};
  for (const stage of DEFAULT_STAGES) {
    stageDocs[stage.name] = await upsert(Stage, { tenantId, name: stage.name }, { tenantId, ...stage });
  }
  for (const [stageName, subs] of Object.entries(DEFAULT_SUB_STAGES)) {
    let order = 1;
    for (const name of subs) {
      await upsert(SubStage, { tenantId, stageId: stageDocs[stageName]._id, name },
        { tenantId, stageId: stageDocs[stageName]._id, name, displayOrder: order++ });
    }
  }
  let order = 1;
  for (const [name, semantic] of DEFAULT_ACTION_TYPES) {
    await upsert(ActionType, { tenantId, name }, { tenantId, name, semantic, displayOrder: order++, isSystem: true });
  }
  order = 1;
  for (const [name, isNegative] of DEFAULT_VISIT_OUTCOMES) {
    await upsert(VisitOutcome, { tenantId, name }, { tenantId, name, isNegative, displayOrder: order++ });
  }
  order = 1;
  for (const [name, category] of DEFAULT_SOURCES) {
    await upsert(LeadSource, { tenantId, name }, { tenantId, name, category, displayOrder: order++, isSystem: true });
  }
  for (const name of DEFAULT_TAGS) {
    await upsert(Tag, { tenantId, nameLower: name.toLowerCase() }, { tenantId, name });
  }
  await seedCommunicationDefaults(tenantId);
  return stageDocs;
}

/**
 * §17: a new tenant can acknowledge inbound leads immediately. §12.3 step 11
 * expects an acknowledgement to fire on capture, so the rule is active by
 * default and the admin can switch it off.
 */
async function seedCommunicationDefaults(tenantId) {
  const ackTemplate = await upsert(Template, { tenantId, name: 'Lead acknowledgement' }, {
    tenantId,
    name: 'Lead acknowledgement',
    channel: 'WHATSAPP',
    purpose: 'ACKNOWLEDGEMENT',
    isSystem: true,
    body: 'Hi {{contact.first_name}}, thanks for your interest in {{project.name|our projects}}. '
      + 'I am {{owner.name}} from {{organization.name}} and I will call you shortly. '
      + 'You can reach me on {{owner.mobile}}.',
  });

  const smsTemplate = await upsert(Template, { tenantId, name: 'Lead acknowledgement (SMS)' }, {
    tenantId,
    name: 'Lead acknowledgement (SMS)',
    channel: 'SMS',
    purpose: 'ACKNOWLEDGEMENT',
    isSystem: true,
    body: 'Hi {{contact.first_name}}, thanks for your interest in {{project.name|our projects}}. '
      + '{{owner.name}} from {{organization.name}} will call you shortly.',
  });

  await upsert(AckRule, { tenantId, projectId: null, sourceId: null, channel: 'WHATSAPP' }, {
    tenantId,
    projectId: null,
    sourceId: null,
    channel: 'WHATSAPP',
    templateId: ackTemplate._id,
    fallbackChannel: 'SMS',
    fallbackTemplateId: smsTemplate._id,
  });

  // Messaging providers run on the mock driver until real credentials are added
  // (§49) — sends are recorded, delivery state is real, nothing leaves the box.
  for (const [category, provider] of [['WHATSAPP', 'mock-whatsapp'], ['SMS', 'mock-sms'], ['EMAIL', 'mock-email']]) {
    await upsert(Integration, { tenantId, category }, {
      tenantId, category, provider, name: `${category} (simulated)`, driver: 'mock', status: 'CONNECTED',
    });
  }

  // A ready-to-use inbound lead endpoint (§63): POST /api/webhooks/leads/<key>
  await upsert(Integration, { tenantId, category: 'WEBSITE_WEBHOOK' }, {
    tenantId,
    category: 'WEBSITE_WEBHOOK',
    provider: 'website',
    name: 'Website / landing page capture',
    driver: 'mock',
    status: 'CONNECTED',
    webhookKey: crypto.randomBytes(18).toString('base64url'),
  });
}

async function seedRoles(tenantId) {
  const roles = {};
  for (const role of permissions.DEFAULT_ROLES) {
    roles[role.name] = await upsert(Role, { tenantId, name: role.name }, {
      tenantId,
      name: role.name,
      description: role.description,
      permissions: role.permissions,
      isAdmin: !!role.isAdmin,
      isSystem: true,
    });
  }
  return roles;
}

async function upsert(Model, filter, doc) {
  const existing = await Model.findOne(filter);
  if (existing) return existing;
  return Model.create(doc);
}

/**
 * Creates a whole organization: tenant, masters, roles, admin user and the
 * default round-robin pool. Used by onboarding and by the demo seed.
 */
async function createOrganization({ name, adminName, adminEmail, adminMobile, adminPassword, timezone, currency, locale, country, callingCode }) {
  const tenant = await Tenant.create({
    name,
    country: country || 'IN',
    callingCode: callingCode || '91',
    timezone: timezone || 'Asia/Kolkata',
    currency: currency || 'INR',
    locale: locale || 'en-IN',
  });

  const roles = await seedRoles(tenant._id);
  await seedTenantDefaults(tenant._id);

  const admin = await User.create({
    tenantId: tenant._id,
    name: adminName,
    email: String(adminEmail).toLowerCase(),
    mobile: adminMobile,
    normalizedMobile: adminMobile ? phone.normalizeMobile(adminMobile, tenant.callingCode) : undefined,
    roleId: roles['Organization Admin']._id,
    status: 'ACTIVE',
    passwordHash: await password.hash(adminPassword),
  });

  await AssignmentPool.create({
    tenantId: tenant._id,
    name: 'Default sales pool',
    isDefault: true,
    memberIds: [admin._id],
    escalationUserIds: [admin._id],
  });

  return { tenant, admin, roles };
}

/**
 * Demo data across the whole journey, so a fresh install is explorable:
 * a priced project, captured leads, a worked lead, a visit, a cost sheet,
 * a block, a booking, and the campaign spend behind it.
 */
async function seedDemoWorkload({ tenant, admin, users }) {
  const money = require('../lib/money');
  const {
    Project, Tower, UnitType, Unit, PricingComponent, PaymentPlan, MarketingCampaign,
    LeadSource, Stage, ActionType, VisitOutcome, Lead, SubStage,
  } = require('./models');
  const projectsService = require('../services/projects');
  const captureService = require('../services/capture');
  const followupsService = require('../services/followups');
  const visitsService = require('../services/visits');
  const inventoryService = require('../services/inventory');
  const costsheetsService = require('../services/costsheets');
  const blocksService = require('../services/blocks');
  const bookingsService = require('../services/bookings');

  const tenantId = tenant._id;
  const [priya, vikram] = users;

  const project = await projectsService.create({
    tenantId,
    actor: admin,
    data: {
      name: 'Skyline Greens',
      status: 'ACTIVE',
      city: 'Ahmedabad',
      developerName: 'Skyline Developers',
      possessionDate: new Date('2027-06-30'),
      startingPriceMinor: money.toMinor('5500000'),
      configurations: ['2 BHK', '3 BHK'],
      amenities: ['Clubhouse', 'Swimming pool', 'Gym', 'Kids play area'],
      keyUsps: ['Riverfront view', '5 min from ring road'],
      overview: 'A 4-tower residential development with 2 and 3 BHK homes beside the riverfront.',
    },
  });

  const tower = await projectsService.addTower({
    tenantId, actor: admin, projectId: project._id, data: { name: 'Tower A', code: 'A', floorCount: 6 },
  });
  const type3 = await projectsService.addUnitType({
    tenantId,
    projectId: project._id,
    data: { name: '3 BHK', bedrooms: 3, carpetArea: 950, builtUpArea: 1150, superBuiltUpArea: 1300, defaultBaseRateMinor: money.toMinor('5200') },
  });
  await projectsService.addUnitType({
    tenantId,
    projectId: project._id,
    data: { name: '2 BHK', bedrooms: 2, carpetArea: 700, builtUpArea: 860, superBuiltUpArea: 980, defaultBaseRateMinor: money.toMinor('5200') },
  });
  await projectsService.generateUnits({
    tenantId, actor: admin, projectId: project._id, towerId: tower._id, unitTypeId: type3._id, unitsPerFloor: 4,
  });

  await PricingComponent.insertMany([
    { tenantId, projectId: project._id, name: 'Base price', kind: 'BASE', calcType: 'PER_AREA', rateMinor: money.toMinor('5200'), areaBasis: 'SALEABLE', displayOrder: 1 },
    { tenantId, projectId: project._id, name: 'Floor rise', kind: 'FLOOR_RISE', calcType: 'PER_AREA', rateMinor: money.toMinor('30'), areaBasis: 'SALEABLE', displayOrder: 2 },
    { tenantId, projectId: project._id, name: 'Club membership', kind: 'CLUB', calcType: 'FIXED', rateMinor: money.toMinor('200000'), displayOrder: 3 },
    { tenantId, projectId: project._id, name: 'Covered parking', kind: 'PARKING', calcType: 'PER_UNIT_COUNT', rateMinor: money.toMinor('250000'), displayOrder: 4 },
    { tenantId, projectId: project._id, name: 'GST', kind: 'TAX', calcType: 'PERCENTAGE', percentage: 5, displayOrder: 9 },
    { tenantId, projectId: project._id, name: 'Stamp duty', kind: 'STAMP_DUTY', calcType: 'PERCENTAGE', percentage: 4.9, displayOrder: 10 },
  ]);
  const plan = await PaymentPlan.create({
    tenantId, projectId: project._id, name: 'Construction linked', type: 'CONSTRUCTION_LINKED',
    description: '10% on booking, 80% linked to construction, 10% on possession.',
  });

  const metaCampaign = await MarketingCampaign.create({
    tenantId, name: 'Meta — 3 BHK riverfront', platform: 'META', projectId: project._id,
    spendMinor: money.toMinor('180000'), startDate: new Date(Date.now() - 20 * 86400000),
  });
  const googleCampaign = await MarketingCampaign.create({
    tenantId, name: 'Google — buy flat Ahmedabad', platform: 'GOOGLE', projectId: project._id,
    spendMinor: money.toMinor('220000'), startDate: new Date(Date.now() - 20 * 86400000),
  });

  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
  const outcomes = Object.fromEntries((await VisitOutcome.find({ tenantId }).lean()).map((o) => [o.name, o]));

  const people = [
    ['Neha Kapoor', '9825011001', metaCampaign, 'worked'],
    ['Rohit Patel', '9825011002', googleCampaign, 'visited'],
    ['Meera Shah', '9825011003', metaCampaign, 'booked'],
    ['Arjun Desai', '9825011004', googleCampaign, 'new'],
    ['Kavita Iyer', '9825011005', metaCampaign, 'new'],
  ];

  const created = [];
  for (const [name, mobile, campaign, journey] of people) {
    const { lead } = await captureService.handleInquiry({
      tenantId,
      tenant,
      payload: {
        name, mobile, projectId: project._id, campaignId: campaign._id,
        sourceCategory: campaign.platform === 'META' ? 'META' : 'GOOGLE',
        source: campaign.platform === 'META' ? 'Facebook Ads' : 'Google Ads',
        message: '3 BHK, riverfront facing if possible',
      },
    });
    await Lead.updateOne({ tenantId, _id: lead._id }, {
      $set: {
        budgetMinMinor: money.toMinor('6500000'),
        budgetMaxMinor: money.toMinor('8500000'),
        preferredConfigurations: ['3 BHK'],
        purpose: journey === 'booked' ? 'INVESTMENT' : 'SELF_USE',
      },
    });
    created.push({ lead: await Lead.findOne({ tenantId, _id: lead._id }).lean(), journey });
  }

  const tomorrow = new Date(Date.now() + 86400000);

  for (const { lead, journey } of created) {
    if (journey === 'new') continue;
    const owner = String(lead.ownerUserId) === String(priya._id) ? priya : vikram;

    // A genuine first action plus the next one — the rule that clears New Leads.
    await followupsService.logAction({
      tenantId,
      tenant,
      actor: owner,
      leadId: lead._id,
      actionTypeId: actions.CALL._id,
      stageId: stages.CONNECTED._id,
      note: 'Spoke to the customer, wants a 3 BHK with a river view.',
      tz: tenant.timezone,
      next: { actionTypeId: actions.SITE_VISIT._id, dueAt: tomorrow },
    });

    if (journey === 'new') continue;

    const visit = await visitsService.schedule({
      tenantId, tenant, actor: owner, leadId: lead._id, projectId: project._id,
      scheduledAt: new Date(Date.now() + 3600000), salesUserId: owner._id,
    });

    if (journey === 'visited' || journey === 'booked') {
      await visitsService.complete({
        tenantId,
        tenant,
        actor: owner,
        visitId: visit._id,
        outcomeId: outcomes['Highly Interested']._id,
        notes: 'Loved the 4th floor units.',
        tz: tenant.timezone,
        next: { actionTypeId: actions.COST_SHEET._id, dueAt: tomorrow },
      });
    }

    if (journey === 'booked') {
      const unit = await Unit.findOne({ tenantId, projectId: project._id, unitNumber: '401' }).lean();
      await inventoryService.shortlist({ tenantId, actor: owner, leadId: lead._id, unitId: unit._id });
      const sheet = await costsheetsService.create({
        tenantId, actor: owner, leadId: lead._id, unitId: unit._id, paymentPlanId: plan._id,
      });
      await blocksService.block({
        tenantId, tenant, actor: owner, leadId: lead._id, unitId: unit._id,
        costSheetId: sheet._id, tokenAmountMinor: money.toMinor('100000'),
      });
      await bookingsService.createBooking({
        tenantId,
        actor: owner,
        leadId: lead._id,
        unitId: unit._id,
        costSheetId: sheet._id,
        bookingDate: new Date(),
        finalPriceMinor: sheet.finalConsiderationMinor,
        bookingAmountMinor: money.toMinor('500000'),
        paymentPlanId: plan._id,
        buyerPurpose: 'INVESTMENT',
        investment: {
          expectedExitDate: new Date(Date.now() + 45 * 86400000),
          expectedExitPriceMinor: money.toMinor('9500000'),
          resaleInterest: true,
        },
      });
    }
  }

  // One overdue follow-up so the Missed tile has something in it.
  const arjun = created.find((c) => c.journey === 'new');
  if (arjun) {
    await followupsService.create({
      tenantId,
      actor: admin,
      leadId: arjun.lead._id,
      actionTypeId: actions.CALL._id,
      dueAt: new Date(Date.now() - 7200000),
      note: 'Callback promised yesterday.',
      allowPast: true,
    });
    await followupsService.markMissed({ tenantId });
  }

  return { project };
}

/** `npm run seed` — a demo organization to click through. */
async function seedDemo() {
  await db.connect();
  const existing = await Tenant.findOne({ name: 'Skyline Developers' });
  if (existing) {
    console.log('Demo tenant already exists — nothing to do.');
    return existing;
  }

  const { tenant, admin, roles } = await createOrganization({
    name: 'Skyline Developers',
    adminName: 'Asha Mehta',
    adminEmail: 'admin@skyline.test',
    adminMobile: '9876500001',
    adminPassword: 'Password1',
  });

  const manager = await User.create({
    tenantId: tenant._id,
    name: 'Rahul Shah',
    email: 'manager@skyline.test',
    mobile: '9876500002',
    normalizedMobile: phone.normalizeMobile('9876500002'),
    roleId: roles['Sales Manager']._id,
    status: 'ACTIVE',
    passwordHash: await password.hash('Password1'),
  });

  for (const [name, email, mobile] of [
    ['Priya Nair', 'priya@skyline.test', '9876500003'],
    ['Vikram Rao', 'vikram@skyline.test', '9876500004'],
  ]) {
    await User.create({
      tenantId: tenant._id,
      name,
      email,
      mobile,
      normalizedMobile: phone.normalizeMobile(mobile),
      roleId: roles['Sales User']._id,
      managerId: manager._id,
      status: 'ACTIVE',
      passwordHash: await password.hash('Password1'),
    });
  }

  const salesUsers = await User.find({ tenantId: tenant._id, status: 'ACTIVE' }).select('_id').lean();
  await AssignmentPool.updateOne(
    { tenantId: tenant._id, isDefault: true },
    { $set: { memberIds: salesUsers.map((u) => u._id), escalationUserIds: [manager._id, admin._id] } },
  );

  const salesTeam = await User.find({ tenantId: tenant._id, email: { $in: ['priya@skyline.test', 'vikram@skyline.test'] } });
  await seedDemoWorkload({ tenant, admin, users: salesTeam });

  console.log(JSON.stringify({
    msg: 'Demo organization created',
    tenant: tenant.name,
    logins: ['admin@skyline.test', 'manager@skyline.test', 'priya@skyline.test', 'vikram@skyline.test'],
    password: 'Password1',
  }, null, 2));
  return tenant;
}

module.exports = { seedTenantDefaults, seedRoles, createOrganization, seedDemo, DEFAULT_STAGES };

if (require.main === module) {
  seedDemo().then(() => db.disconnect()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
