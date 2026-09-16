const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  SocietyRole, Society, SocietyUnit, SocietyUser, SocietyAmenity, SocietyAmenityType,
  SocietyPoll,
} = require('../../src/db/models/society');

/**
 * Every society screen, rendered as a browser would render it.
 *
 * `tests/api/pages.test.js` does this for the CRM but builds only the CRM
 * models, so the society module needs its own crawl. The point is the same: an
 * EJS template that references a local its route does not pass throws at render
 * time, not at require time, so nothing but actually rendering the page catches
 * it — and a detail screen with no record to show is exactly where that
 * happens.
 */

let admin;
let societyId;
let ids = {};

test.before(async () => {
  await h.startServer();
  await h.resetDb();
  await h.seedTwoOrgs();

  admin = h.client();
  const login = await admin.login('admin@alpha.test');
  assert.equal(login.location, '/app/dashboard');

  await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman', level: 2, scope: 'society', permissions: [],
  });
  await SocietyRole.create({
    key: 'security_guard', name: 'Security Guard', displayName: 'Security Guard', level: 5, scope: 'society', permissions: [],
  });

  const created = await admin.submit('/app/society/societies', {
    societyName: 'Crawl Test', projectType: 'Residential',
    totalBlocks: '1', totalFloors: '2', totalUnits: '4', includeGroundFloor: 'false',
    contactPersonName: 'Crawl Chair', contactNumber: '9922200001', email: 'chair@crawl.test',
    status: 'Active',
    'address.street': '10 Rd', 'address.city': 'Anand',
    'address.state': 'Gujarat', 'address.pincode': '388001',
  }, '/app/society/societies/new');
  societyId = created.location.split('/').pop();

  const society = await Society.findById(societyId).lean();
  const ctx = { societyId: society._id };

  const unit = await SocietyUnit.findOne(ctx).lean();
  const resident = await SocietyUser.create({
    mobileNumber: '9088000001', countryCode: '+91', firstName: 'Crawl', lastName: 'Resident',
  });
  await require('../../src/services/society/occupancy').assign({
    ...ctx, unitId: unit._id, userId: resident._id, residentType: 'Owner',
    person: { firstName: 'Crawl', lastName: 'Resident', mobileNumber: '9088000001' },
  });

  const amenityType = await SocietyAmenityType.create({ ...ctx, name: 'Hall' });
  const amenity = await SocietyAmenity.create({
    ...ctx, name: 'Party Hall', description: 'The big one', amenityTypeId: amenityType._id, capacity: 50,
  });

  const complaintType = await require('../../src/db/models/society')
    .SocietyComplaintType.create({ ...ctx, typeName: 'Lifts' });
  const complaint = await require('../../src/services/society/complaints').create(ctx, {
    title: 'Lift stuck', description: 'Between 2 and 3', unitId: unit._id,
    complaintTypeId: complaintType._id,
  }, resident._id);

  const poll = await SocietyPoll.create({
    ...ctx, title: 'Repaint the lobby?', options: [{ text: 'Yes' }, { text: 'No' }],
  });

  const models = require('../../src/db/models/society');
  const category = await models.SocietyBillCategory.create({ ...ctx, name: 'Maintenance' });
  const sheet = await models.SocietyBalanceSheet.create({
    ...ctx, name: 'FY 2026-27', startDate: new Date(), endDate: new Date(),
  });
  const bill = await require('../../src/services/society/billing').bills.create(ctx, {
    name: 'Quarterly maintenance', billCategoryId: category._id, balanceSheetId: sheet._id,
    amount: '1500', startDate: new Date(), endDate: new Date(), dueDate: new Date(),
    selectionType: 'ALL',
  }, null);

  const enquiry = await require('../../src/services/society/inquiries').create(ctx, {
    societyName: 'Prospect Towers', societyAddress: '4 Rd',
    firstName: 'Pro', lastName: 'Spect', mobileNumber: '9088000002',
  }, null);

  ids = {
    unitId: unit._id,
    amenityId: amenity._id,
    complaintId: complaint._id,
    pollId: poll._id,
    billId: bill._id,
    enquiryId: enquiry._id,
  };
});

test.after(async () => { await h.stopServer(); });

test('every society screen renders', async (t) => {
  const b = () => `/app/society/societies/${societyId}`;

  const screens = () => [
    '/app/society/societies',
    '/app/society/societies?q=Crawl',
    '/app/society/societies/new',
    '/app/society/developers',
    '/app/society/roles',
    '/app/society/enquiries',
    '/app/society/pipeline',
    '/app/society/analytics',
    `/app/society/enquiries/${ids.enquiryId}`,
    b(),
    `${b()}/edit`,
    `${b()}/structure`,
    `${b()}/units`,
    `${b()}/units/${ids.unitId}`,
    `${b()}/members`,
    `${b()}/committee`,
    `${b()}/employees`,
    `${b()}/onboarding`,
    `${b()}/notices`,
    `${b()}/polls`,
    `${b()}/polls/${ids.pollId}`,
    `${b()}/complaints`,
    `${b()}/complaints?status=OPEN`,
    `${b()}/complaints/${ids.complaintId}`,
    `${b()}/billing`,
    `${b()}/bills/${ids.billId}`,
    `${b()}/amenities`,
    `${b()}/amenities/${ids.amenityId}`,
    `${b()}/bookings`,
    `${b()}/parking`,
    `${b()}/listings`,
    `${b()}/listings?type=RENT`,
    `${b()}/visitors`,
    `${b()}/visitors?status=ENTERED`,
    `${b()}/attendance`,
  ];

  for (const path of screens()) {
    // eslint-disable-next-line no-await-in-loop
    await t.test(`GET ${path.replace(societyId, ':id')}`, async () => {
      const res = await admin.get(path);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
      assert.ok(res.text.includes('</html>'), 'rendered a truncated page');
      assert.ok(
        !/<%|Cannot read properties|is not defined|Something went wrong/.test(res.text),
        'leaked a template error',
      );
    });
  }
});

test('a society that does not exist is a friendly 404, not a 500', async (t) => {
  const missing = '6a9f00000000000000000001';

  for (const path of [
    `/app/society/societies/${missing}`,
    `/app/society/societies/${missing}/units`,
    `/app/society/societies/${missing}/billing`,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.test(`GET ${path.replace(missing, ':missing')}`, async () => {
      const res = await admin.get(path);
      assert.equal(res.status, 404);
      assert.ok(!res.text.includes('at Object.'), 'no stack trace is exposed (§68)');
    });
  }

  await t.test('and neither is an id that is not an id at all', async () => {
    const res = await admin.get('/app/society/societies/not-an-objectid');
    assert.equal(res.status, 404);
  });
});
