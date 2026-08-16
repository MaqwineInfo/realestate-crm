const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, Contact, LeadSource, Project, Stage, SubStage, InquiryTouch, User,
} = require('../../src/db/models');

/**
 * V1.1 §126: the full real-estate capture form.
 *
 * The theme running through all of it: the form is allowed to be long, but it is
 * never allowed to be wrong. Mobile decides identity, ranges have to make sense,
 * and an existing customer is surfaced rather than silently duplicated.
 */
test('full lead capture form (V1.1 §7–§13)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Sam Seller', email: 'sam@alpha.test', roleName: 'Sales User',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const referralSource = await LeadSource.findOne({ tenantId, category: 'REFERRAL' }).lean();
  const projectA = await Project.create({ tenantId, name: 'River Heights', status: 'ACTIVE' });
  const projectB = await Project.create({ tenantId, name: 'Palm Grove', status: 'ACTIVE' });
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));

  const admin = h.client();
  await admin.login('admin@alpha.test');

  t.after(async () => { await h.stopServer(); });

  await t.test('the form renders every capture section', async () => {
    const page = await admin.get('/app/leads/new');
    assert.equal(page.status, 200);
    for (const section of ['1 · Customer', '2 · Inquiry', '3 · Property requirement', '4 · Qualification', '5 · Notes']) {
      assert.ok(page.text.includes(section), `${section} is on the form`);
    }
    assert.match(page.text, /Auto allocate \(round robin\)/, 'auto allocation is the default');
    assert.match(page.text, /data-dup-mobile/, 'the mobile field drives duplicate lookup');
  });

  await t.test('a mobile from search arrives prefilled (§5.8)', async () => {
    const page = await admin.get('/app/leads/new?mobile=9812340000');
    assert.match(page.text, /name="primaryMobile"[^>]*value="9812340000"/);
  });

  await t.test('a new contact and lead capture the full qualification set', async () => {
    const res = await admin.submit('/api/leads', {
      firstName: 'Rahul', lastName: 'Shah', primaryMobile: '98123 40001',
      email: 'rahul@example.com', city: 'Ahmedabad', state: 'Gujarat', pincode: '380015',
      altMobile: '9812340099',
      sourceId: String(source._id), sourceDetail: 'Walk-in enquiry',
      projectId: String(projectA._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
      budgetMinMinor: '6500000', budgetMaxMinor: '8500000',
      areaMin: '1100', areaMax: '1400', areaBasis: 'SALEABLE',
      preferredFloorMin: '4', preferredFloorMax: '12',
      preferredConfigurations: '3 BHK', preferredFacings: 'East, North-East',
      purpose: 'SELF_USE', possessionPreference: 'READY',
      purchaseTimeline: 'MONTHS_1_3', fundingType: 'HOME_LOAN', loanStatus: 'PRE_APPROVED',
      decisionMaker: 'SPOUSE', preferredLocation: 'Near the riverfront',
      requirementNote: 'Wants a river view',
    }, '/app/leads/new');
    assert.equal(res.status, 302);

    const lead = await Lead.findOne({ tenantId, _id: res.location.split('/').pop() }).lean();
    assert.equal(lead.budgetMinMinor, 650000000, 'money is integer minor units');
    assert.equal(lead.areaBasis, 'SALEABLE');
    assert.equal(lead.preferredFloorMax, 12);
    assert.deepEqual(lead.preferredFacings, ['East', 'North-East']);
    assert.equal(lead.purchaseTimeline, 'MONTHS_1_3');
    assert.equal(lead.fundingType, 'HOME_LOAN');
    assert.equal(lead.loanStatus, 'PRE_APPROVED');
    assert.equal(lead.decisionMaker, 'SPOUSE');
    assert.equal(lead.possessionPreference, 'READY');
    assert.equal(String(lead.ownerUserId), String(seller._id));

    const contact = await Contact.findOne({ tenantId, _id: lead.contactId }).lean();
    assert.equal(contact.normalizedMobile, '+919812340001');
    assert.equal(contact.state, 'Gujarat');
    assert.equal(contact.pincode, '380015');
  });

  await t.test('a referral records who referred them (§9.1)', async () => {
    const res = await admin.submit('/api/leads', {
      firstName: 'Meera', primaryMobile: '9812340002',
      sourceId: String(referralSource._id),
      referrerName: 'Anil Patel', referrerMobile: '9898989898',
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    const lead = await Lead.findOne({ tenantId, _id: res.location.split('/').pop() }).lean();
    assert.equal(lead.referrerName, 'Anil Patel');
    assert.equal(lead.referrerMobile, '9898989898');
  });

  /* ------------------------- §12 server validation ------------------------ */

  await t.test('an invalid mobile is refused', async () => {
    const before = await Lead.countDocuments({ tenantId });
    const res = await admin.submit('/api/leads', {
      firstName: 'Bad', primaryMobile: '12', sourceId: String(source._id),
    }, '/app/leads/new');
    assert.equal(res.status, 302, 'bounced back with the error');
    assert.equal(await Lead.countDocuments({ tenantId }), before, 'nothing was created');
  });

  await t.test('a source is always required (§10.1)', async () => {
    const before = await Lead.countDocuments({ tenantId });
    await admin.submit('/api/leads', { firstName: 'NoSource', primaryMobile: '9812340003' }, '/app/leads/new');
    assert.equal(await Lead.countDocuments({ tenantId }), before);
  });

  await t.test('an inverted budget, area or floor range is refused (§12.5–12.7)', async () => {
    const before = await Lead.countDocuments({ tenantId });
    const cases = [
      { budgetMinMinor: '9000000', budgetMaxMinor: '5000000' },
      { areaMin: '1500', areaMax: '900' },
      { preferredFloorMin: '12', preferredFloorMax: '3' },
    ];
    for (const [i, extra] of cases.entries()) {
      const res = await admin.submit('/api/leads', {
        firstName: 'Range', primaryMobile: `981234100${i}`, sourceId: String(source._id), ...extra,
      }, '/app/leads/new');
      assert.equal(res.status, 302);
    }
    assert.equal(await Lead.countDocuments({ tenantId }), before, 'none of the three were created');
  });

  await t.test('a manual owner must be an active user (§12.9)', async () => {
    const suspended = await h.addUser({
      tenant: orgA.tenant, roles: orgA.roles, name: 'Gone Away', email: 'gone@alpha.test', roleName: 'Sales User',
    });
    await User.updateOne({ tenantId, _id: suspended._id }, { $set: { status: 'SUSPENDED' } });

    const before = await Lead.countDocuments({ tenantId });
    await admin.submit('/api/leads', {
      firstName: 'Orphan', primaryMobile: '9812340004', sourceId: String(source._id),
      assignmentMode: 'MANUAL', ownerUserId: String(suspended._id),
    }, '/app/leads/new');
    assert.equal(await Lead.countDocuments({ tenantId }), before);
  });

  /* --------------------- §13 existing-contact decisions -------------------- */

  await t.test('the same contact on a different project is simply a new lead (§13.1)', async () => {
    const res = await admin.submit('/api/leads', {
      firstName: 'Rahul', primaryMobile: '98123 40001',
      sourceId: String(source._id), projectId: String(projectB._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    assert.equal(res.status, 302, 'no decision needed — a different project is a different opportunity');

    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919812340001' }).lean();
    const leads = await Lead.find({ tenantId, contactId: contact._id }).lean();
    assert.equal(leads.length, 2);
    assert.equal(await Contact.countDocuments({ tenantId, normalizedMobile: '+919812340001' }), 1);
  });

  await t.test('the same contact on the same active project asks first (§13.2)', async () => {
    const before = await Lead.countDocuments({ tenantId });
    const res = await admin.submit('/api/leads', {
      firstName: 'Rahul', primaryMobile: '98123 40001',
      sourceId: String(source._id), projectId: String(projectA._id),
    }, '/app/leads/new');

    assert.equal(res.status, 200, 'the form comes back with the decision');
    assert.match(res.text, /already has an open lead here/);
    assert.match(res.text, /Record re-inquiry/);
    assert.equal(await Lead.countDocuments({ tenantId }), before, 'nothing was written');
  });

  await t.test('recording the re-inquiry appends a touch instead of a lead (§13.2)', async () => {
    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919812340001' }).lean();
    const target = await Lead.findOne({ tenantId, contactId: contact._id, projectId: projectA._id }).lean();
    const touchesBefore = await InquiryTouch.countDocuments({ tenantId, leadId: target._id });
    const leadsBefore = await Lead.countDocuments({ tenantId });

    const res = await admin.submit('/api/leads', {
      firstName: 'Rahul', primaryMobile: '98123 40001',
      sourceId: String(source._id), projectId: String(projectA._id), intent: 'REINQUIRY',
    }, '/app/leads/new');
    assert.equal(res.status, 302);
    assert.equal(res.location, `/app/leads/${target._id}`, 'lands on the existing lead');

    assert.equal(await Lead.countDocuments({ tenantId }), leadsBefore, 'no competing lead');
    assert.equal(await InquiryTouch.countDocuments({ tenantId, leadId: target._id }), touchesBefore + 1);

    const after = await Lead.findOne({ tenantId, _id: target._id }).lean();
    assert.ok(after.reinquiryPendingAt, 'it surfaces on the re-inquiry tile');
    assert.equal(String(after.originalSourceId), String(target.originalSourceId), 'original source untouched');
  });

  await t.test('a lost lead on the same project offers a reopen (§13.3)', async () => {
    const created = await admin.submit('/api/leads', {
      firstName: 'Kavita', primaryMobile: '9812340005',
      sourceId: String(source._id), projectId: String(projectB._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    const leadId = created.location.split('/').pop();
    const lostSub = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.LOST._id), subStageId: String(lostSub._id),
    }, `/app/leads/${leadId}`);

    const asked = await admin.submit('/api/leads', {
      firstName: 'Kavita', primaryMobile: '9812340005',
      sourceId: String(source._id), projectId: String(projectB._id),
    }, '/app/leads/new');
    assert.equal(asked.status, 200);
    assert.match(asked.text, /marked lost on this project/);

    const res = await admin.submit('/api/leads', {
      firstName: 'Kavita', primaryMobile: '9812340005',
      sourceId: String(source._id), projectId: String(projectB._id), intent: 'REINQUIRY',
    }, '/app/leads/new');
    assert.equal(res.status, 302);

    const reopened = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(reopened.status, 'ACTIVE', 'the lost lead came back to life');
    assert.ok(reopened.lostAt, 'and kept its lost history');
  });

  await t.test('a booked customer buying again starts a genuine new inquiry (§13.4)', async () => {
    const contact = await Contact.findOne({ tenantId, normalizedMobile: '+919812340001' }).lean();
    const booked = await Lead.findOne({ tenantId, contactId: contact._id, projectId: projectA._id });
    await Lead.updateOne({ tenantId, _id: booked._id }, {
      $set: { status: 'TERMINAL', bookedAt: new Date(), stageId: stages.BOOKED._id },
    });

    const before = await Lead.countDocuments({ tenantId });
    const res = await admin.submit('/api/leads', {
      firstName: 'Rahul', primaryMobile: '98123 40001',
      sourceId: String(source._id), projectId: String(projectA._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
    }, '/app/leads/new');
    assert.equal(res.status, 302, 'no decision prompt — a booked lead is not a duplicate');
    assert.equal(await Lead.countDocuments({ tenantId }), before + 1);
  });

  await t.test('the duplicate lookup answers before the form is submitted (§8.2)', async () => {
    const res = await admin.get(
      `/api/contacts/lookup?mobile=9812340001&projectId=${projectB._id}`,
      { headers: { accept: 'application/json' } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.found, true);
    assert.equal(res.data.displayName, 'Rahul Shah');
    assert.ok(res.data.leadCount >= 2);

    const miss = await admin.get('/api/contacts/lookup?mobile=9099999999', { headers: { accept: 'application/json' } });
    assert.equal(miss.data.found, false);
  });
});
