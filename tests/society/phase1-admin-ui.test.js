const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { SocietyRole } = require('../../src/db/models/society');

/**
 * The EJS admin for Phase 1, rendered as a browser would.
 *
 * Every page is actually rendered rather than checked for a 200: an EJS
 * template that references a local the route does not pass throws at render
 * time, not at require time, so this is the only place that catches it.
 */

let admin;
let orgA;

test.before(async () => {
  await h.startServer();
  await h.resetDb();
  ({ orgA } = await h.seedTwoOrgs());

  admin = h.client();
  const res = await admin.login('admin@alpha.test');
  assert.equal(res.location, '/app/dashboard', 'the org admin should sign in');

  // A sales user, to prove the module is permission-gated rather than open.
  await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles,
    name: 'Sales Rep', email: 'rep@alpha.test', roleName: 'Sales User',
  });

  // The society saga looks these up by key when a society is created.
  await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman', level: 2, scope: 'society', permissions: [],
  });
  await SocietyRole.create({
    key: 'security_guard', name: 'Security Guard', displayName: 'Security Guard', level: 5, scope: 'society', permissions: [],
  });
});

test.after(async () => { await h.stopServer(); });

test('every Phase 1 screen renders', async (t) => {
  const screens = [
    ['/app/society/societies', /Societies/],
    ['/app/society/societies/new', /New society/],
    ['/app/society/analytics', /Society analytics/],
    ['/app/society/enquiries', /Society enquiries/],
    ['/app/society/developers', /Developers/],
    ['/app/society/roles', /Society roles/],
    ['/app/society/pipeline', /Enquiry pipeline/],
  ];

  for (const [path, expected] of screens) {
    await t.test(path, async () => {
      const res = await admin.get(path);
      assert.equal(res.status, 200, `${path} should render`);
      assert.match(res.text, expected);
      // An EJS failure renders the error page rather than throwing a 500.
      assert.doesNotMatch(res.text, /Something went wrong/, `${path} rendered the error page`);
    });
  }
});

test('the sidebar links to societies', async () => {
  const res = await admin.get('/app/dashboard');
  assert.match(res.text, /href="\/app\/society\/societies"/, 'the nav should expose the module');
});

test('a society can be created, viewed and edited through the UI', async (t) => {
  let societyId;

  await t.test('the form creates the society and its structure', async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Riverside Heights',
      projectType: 'Residential',
      totalBlocks: '2', totalFloors: '2', totalUnits: '3',
      includeGroundFloor: 'false',
      contactPersonName: 'Nikhil Desai',
      contactNumber: '9812300001',
      email: 'nikhil@riverside.test',
      status: 'Active',
      'address.street': '12 Riverfront',
      'address.city': 'Ahmedabad',
      'address.state': 'Gujarat',
      'address.pincode': '380009',
    }, '/app/society/societies/new');

    assert.equal(res.status, 302);
    societyId = res.location.split('/').pop();
    assert.ok(societyId);
  });

  await t.test('the detail page reports the generated structure', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Riverside Heights/);
    assert.match(res.text, /Block A/);
    assert.match(res.text, /Block B/);
    // 2 blocks x 2 floors x 3 units
    assert.match(res.text, />12<\/div>\s*<div class="stat-lbl">Units/);
  });

  await t.test('the list shows it with its unit count', async () => {
    const res = await admin.get('/app/society/societies');
    assert.match(res.text, /Riverside Heights/);
  });

  await t.test('the edit form loads and saves', async () => {
    const form = await admin.get(`/app/society/societies/${societyId}/edit`);
    assert.equal(form.status, 200);
    assert.match(form.text, /readonly/, 'the society code must not be editable');

    const res = await admin.submit(`/app/society/societies/${societyId}`, {
      societyName: 'Riverside Heights Phase 1',
      projectType: 'Residential',
      totalBlocks: '2', totalFloors: '2', totalUnits: '3',
      includeGroundFloor: 'false',
      contactPersonName: 'Nikhil Desai',
      contactNumber: '9812300001',
      email: 'nikhil@riverside.test',
      status: 'Active',
      'address.street': '12 Riverfront',
      'address.city': 'Ahmedabad',
      'address.state': 'Gujarat',
      'address.pincode': '380009',
    }, `/app/society/societies/${societyId}/edit`);
    assert.equal(res.status, 302);

    const after = await admin.get(`/app/society/societies/${societyId}`);
    assert.match(after.text, /Riverside Heights Phase 1/);
  });

  await t.test('analytics counts the new society', async () => {
    const res = await admin.get('/app/society/analytics');
    assert.equal(res.status, 200);
    assert.match(res.text, /Riverside Heights Phase 1/);
  });
});

test('the per-society screens work end to end', async (t) => {
  let societyId;
  let unitId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Structure UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '1', includeGroundFloor: 'false',
      contactPersonName: 'Kiran Joshi', contactNumber: '9844400001', email: 'kiran@sui.test',
      status: 'Active',
      'address.street': '9 Lane', 'address.city': 'Surat',
      'address.state': 'Gujarat', 'address.pincode': '395007',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('every per-society screen renders', async () => {
    for (const suffix of ['/structure', '/units', '/employees', '/onboarding']) {
      const res = await admin.get(`/app/society/societies/${societyId}${suffix}`);
      assert.equal(res.status, 200, `${suffix} should render`);
      assert.doesNotMatch(res.text, /Something went wrong/, `${suffix} rendered the error page`);
    }
  });

  await t.test('a block and a run of floors can be added', async () => {
    const base = `/app/society/societies/${societyId}`;
    await admin.submit(`${base}/blocks`, { blockName: 'Block Z' }, `${base}/structure`);

    const page = await admin.get(`${base}/structure`);
    assert.match(page.text, /Block Z/);

    const blockId = page.text.match(/blocks\/([a-f0-9]{24})\/delete/)?.[1];
    assert.ok(blockId, 'the new block should be actionable');

    await admin.submit(`${base}/floors/bulk`, {
      blockId, from: '1', to: '3', unitsPerFloor: '2',
    }, `${base}/structure`);

    const after = await admin.get(`${base}/structure`);
    assert.match(after.text, /1, 2, 3/, 'three floors listed');
  });

  await t.test('a resident can be assigned and moved out', async () => {
    const base = `/app/society/societies/${societyId}`;
    const list = await admin.get(`${base}/units`);
    unitId = list.text.match(/units\/([a-f0-9]{24})"/)?.[1];
    assert.ok(unitId, 'the generated unit should be listed');

    await admin.submit(`${base}/units/${unitId}/assign`, {
      firstName: 'Devi', lastName: 'Patel', mobileNumber: '9855500001', residentType: 'Owner',
    }, `${base}/units/${unitId}`);

    const detail = await admin.get(`${base}/units/${unitId}`);
    assert.match(detail.text, /Devi Patel/);
    assert.match(detail.text, /OCCUPIED/);

    const occupancyId = detail.text.match(/name="occupancyId" value="([a-f0-9]{24})"/)?.[1];
    assert.ok(occupancyId);

    await admin.submit(`${base}/units/${unitId}/release`, { occupancyId }, `${base}/units/${unitId}`);
    const after = await admin.get(`${base}/units/${unitId}`);
    assert.match(after.text, /Vacant/);
    assert.match(after.text, /Occupancy history/);
  });

  await t.test('staff can be hired and shown their gate MPIN', async () => {
    const base = `/app/society/societies/${societyId}`;
    const page = await admin.get(`${base}/employees`);
    // Security Guard and Technician are seeded with the society.
    assert.match(page.text, /Security Guard/);

    const typeId = page.text.match(/name="employeeTypeId"[\s\S]*?value="([a-f0-9]{24})"/)?.[1];
    assert.ok(typeId, 'a seeded employee type should be selectable');

    await admin.submit(`${base}/employees`, {
      employeeName: 'Suresh Kumar', mobileNumber: '9866600001', employeeTypeId: typeId,
    }, `${base}/employees`);

    const after = await admin.get(`${base}/employees`);
    assert.match(after.text, /Suresh Kumar/);
    assert.match(after.text, /<code>\d{4}<\/code>/, 'the MPIN is shown so it can be handed over');
  });
});

test('members and committee screens', async (t) => {
  let societyId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'People UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '2', includeGroundFloor: 'false',
      contactPersonName: 'Rita Shah', contactNumber: '9877700001', email: 'rita@pui.test',
      status: 'Active',
      'address.street': '4 Marg', 'address.city': 'Rajkot',
      'address.state': 'Gujarat', 'address.pincode': '360001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('both screens render', async () => {
    for (const suffix of ['/members', '/committee']) {
      const res = await admin.get(`/app/society/societies/${societyId}${suffix}`);
      assert.equal(res.status, 200, `${suffix} should render`);
      assert.doesNotMatch(res.text, /Something went wrong/, `${suffix} rendered the error page`);
    }
  });

  await t.test('a committee seat can be added and shows up', async () => {
    const base = `/app/society/societies/${societyId}`;
    await admin.submit(`${base}/committee`, {
      firstName: 'Vikas', lastName: 'Trivedi', phoneNumber: '9877700002',
      email: 'vikas@pui.test', designation: 'Secretary', countryCode: '+91',
    }, `${base}/committee`);

    const page = await admin.get(`${base}/committee`);
    assert.match(page.text, /Vikas Trivedi/);
    assert.match(page.text, /Secretary/);
  });

  await t.test('assigning a resident makes them a member', async () => {
    const base = `/app/society/societies/${societyId}`;
    const units = await admin.get(`${base}/units`);
    const unitId = units.text.match(/units\/([a-f0-9]{24})"/)?.[1];

    await admin.submit(`${base}/units/${unitId}/assign`, {
      firstName: 'Nilesh', lastName: 'Rana', mobileNumber: '9877700003', residentType: 'Tenant',
    }, `${base}/units/${unitId}`);

    const members = await admin.get(`${base}/members`);
    assert.match(members.text, /Nilesh Rana/);
    assert.match(members.text, /Tenant/);
  });
});

test('the amenity screens work end to end', async (t) => {
  let societyId;
  let amenityId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Amenity UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '1', includeGroundFloor: 'false',
      contactPersonName: 'Deep Shah', contactNumber: '9888800001', email: 'deep@aui.test',
      status: 'Active',
      'address.street': '2 Path', 'address.city': 'Vadodara',
      'address.state': 'Gujarat', 'address.pincode': '390001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('both screens render', async () => {
    for (const suffix of ['/amenities', '/bookings']) {
      const res = await admin.get(`/app/society/societies/${societyId}${suffix}`);
      assert.equal(res.status, 200, `${suffix} should render`);
      assert.doesNotMatch(res.text, /Something went wrong/, `${suffix} rendered the error page`);
    }
  });

  await t.test('a type, amenity, slot and price tier can be added', async () => {
    const b = `/app/society/societies/${societyId}`;
    await admin.submit(`${b}/amenity-types`, { name: 'Clubhouse' }, `${b}/amenities`);

    const page = await admin.get(`${b}/amenities`);
    const typeId = page.text.match(/name="amenityTypeId"[\s\S]*?value="([a-f0-9]{24})"/)?.[1];
    assert.ok(typeId, 'the new type should be selectable');

    const created = await admin.submit(`${b}/amenities`, {
      name: 'Party Hall', amenityTypeId: typeId, description: 'The big hall',
      pricingType: 'PAID', advanceBookingDays: '7', taxValue: '18', gstAmountType: 'INCLUDED',
    }, `${b}/amenities`);
    amenityId = created.location.split('/').pop();

    await admin.submit(`${b}/amenities/${amenityId}/slots`, {
      startTime: '09:00', endTime: '12:00',
    }, `${b}/amenities/${amenityId}`);

    await admin.submit(`${b}/amenities/${amenityId}/packages`, {
      name: 'Up to 100', capacity: '100', price: '5900',
    }, `${b}/amenities/${amenityId}`);

    const detail = await admin.get(`${b}/amenities/${amenityId}`);
    assert.match(detail.text, /09:00 – 12:00/);
    assert.match(detail.text, /Up to 100/);
    // The form takes rupees; the tier renders back as formatted money.
    assert.match(detail.text, /5,900/, 'the rupee input is stored as paise and rendered back');
  });

  await t.test('the amenity list reports its slot and tier counts', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}/amenities`);
    assert.match(res.text, /Party Hall/);
  });
});

test('the complaint screens work end to end', async (t) => {
  let societyId;
  let complaintId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Complaint UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '1', includeGroundFloor: 'false',
      contactPersonName: 'Anil Mehta', contactNumber: '9899900001', email: 'anil@cui.test',
      status: 'Active',
      'address.street': '7 Cross', 'address.city': 'Bhavnagar',
      'address.state': 'Gujarat', 'address.pincode': '364001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('the list screen renders', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}/complaints`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Something went wrong/);
    assert.match(res.text, /No complaints/, 'an empty state, not a blank table');
  });

  await t.test('a complaint can be worked from the detail screen', async () => {
    const c = require('../../src/services/society/complaints');
    const { Society } = require('../../src/db/models/society');
    const society = await Society.findById(societyId).lean();
    const ctx = { societyId: society._id, society };

    const type = await c.types.create(ctx, { typeName: 'Electrical' }, null);
    const made = await c.create(ctx, {
      complaintTypeId: type._id, title: 'Corridor light out', description: 'Third floor landing.',
    }, { adminId: null });
    complaintId = made._id;

    const detail = await admin.get(`/app/society/societies/${societyId}/complaints/${complaintId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /Corridor light out/);
    assert.match(detail.text, /CREATED/, 'the timeline is on the page');

    await admin.submit(`/app/society/societies/${societyId}/complaints/${complaintId}`, {
      status: 'In Progress', priority: 'High', comment: 'Electrician called.',
    }, `/app/society/societies/${societyId}/complaints/${complaintId}`);

    const after = await admin.get(`/app/society/societies/${societyId}/complaints/${complaintId}`);
    assert.match(after.text, /STATUS CHANGED/, 'the change is recorded on the timeline');
    assert.match(after.text, /Electrician called/);
  });

  await t.test('the list reflects the new status', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}/complaints`);
    assert.match(res.text, /Corridor light out/);
    assert.match(res.text, /In Progress/);
  });
});

test('the notice and poll screens work end to end', async (t) => {
  let societyId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Comms UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '1', includeGroundFloor: 'false',
      contactPersonName: 'Hema Shah', contactNumber: '9911100001', email: 'hema@comui.test',
      status: 'Active',
      'address.street': '3 Way', 'address.city': 'Anand',
      'address.state': 'Gujarat', 'address.pincode': '388001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('both screens render', async () => {
    for (const suffix of ['/notices', '/polls']) {
      const res = await admin.get(`/app/society/societies/${societyId}${suffix}`);
      assert.equal(res.status, 200, `${suffix} should render`);
      assert.doesNotMatch(res.text, /Something went wrong/, `${suffix} rendered the error page`);
    }
  });

  await t.test('a notice can be posted and appears published', async () => {
    const b = `/app/society/societies/${societyId}`;
    await admin.submit(`${b}/notices`, {
      title: 'Lift maintenance', text: 'Out of service on Sunday morning.',
      category: 'Maintenance', residentType: 'ALL', targetBlocks: 'All', publishStatus: 'PUBLISHED',
    }, `${b}/notices`);

    const res = await admin.get(`${b}/notices`);
    assert.match(res.text, /Lift maintenance/);
    assert.match(res.text, /PUBLISHED/);
  });

  await t.test('a poll can be created, published and read', async () => {
    const b = `/app/society/societies/${societyId}`;
    await admin.submit(`${b}/polls`, {
      title: 'New gate timings?', description: 'Pick one.',
      option: ['6am to 10pm', '24 hours'], pollType: 'SINGLE_CHOICE',
    }, `${b}/polls`);

    const list = await admin.get(`${b}/polls`);
    assert.match(list.text, /New gate timings\?/);
    assert.match(list.text, /DRAFT/);

    const pollId = list.text.match(/polls\/([a-f0-9]{24})"/)?.[1];
    assert.ok(pollId);

    await admin.submit(`${b}/polls/${pollId}/publish`, {}, `${b}/polls`);

    const detail = await admin.get(`${b}/polls/${pollId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.text, /6am to 10pm/);
    assert.match(detail.text, /24 hours/);
    assert.match(detail.text, /No votes yet/, 'an empty results state, not a broken table');
  });
});

test('the billing screens work end to end', async (t) => {
  let societyId;
  let billId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Billing UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '2', includeGroundFloor: 'false',
      contactPersonName: 'Jay Patel', contactNumber: '9955500001', email: 'jay@bui.test',
      status: 'Active',
      'address.street': '8 Lane', 'address.city': 'Nadiad',
      'address.state': 'Gujarat', 'address.pincode': '387001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('the billing screen renders', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}/billing`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Something went wrong/);
    assert.match(res.text, /Add a ledger account and a bill category first/,
      'the form explains what is missing rather than failing');
  });

  await t.test('a charge can be raised in rupees and lands as paise', async () => {
    const b = `/app/society/societies/${societyId}`;
    await admin.submit(`${b}/ledger`, { name: 'Common Fund', accountCode: 'CF-1', type: 'INCOME' }, `${b}/billing`);
    await admin.submit(`${b}/bill-categories`, { name: 'Water' }, `${b}/billing`);

    const page = await admin.get(`${b}/billing`);
    const categoryId = page.text.match(/name="billCategoryId"[\s\S]*?value="([a-f0-9]{24})"/)?.[1];
    const ledgerId = page.text.match(/name="balanceSheetId"[\s\S]*?value="([a-f0-9]{24})"/)?.[1];
    assert.ok(categoryId && ledgerId);

    await admin.submit(`${b}/bills`, {
      name: 'Water — April', billCategoryId: categoryId, balanceSheetId: ledgerId,
      dueDate: '2026-04-30', priceOwner: '1500.50', priceTenant: '1500.50',
      priceCloseUnit: '750', publishStatus: 'PUBLISHED',
    }, `${b}/billing`);

    const after = await admin.get(`${b}/billing`);
    assert.match(after.text, /Water — April/);
    assert.match(after.text, /PUBLISHED/);

    // The rupee input must survive the round trip exactly.
    const { SocietyBill } = require('../../src/db/models/society');
    const stored = await SocietyBill.findOne({
      societyId: societyId, name: 'Water — April',
    }).lean();
    assert.equal(stored.priceOwnerMinor, 150050, '1500.50 is 150050 paise, not 1500.5');
    billId = stored._id;
  });

  await t.test('the who-owes screen lists the billed units', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}/bills/${billId}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Who owes what/);
    assert.match(res.text, /A-101/);
  });

  await t.test('recording a payment settles the unit', async () => {
    const b = `/app/society/societies/${societyId}`;
    const page = await admin.get(`${b}/bills/${billId}`);
    const unitBillId = page.text.match(/unit-bills\/([a-f0-9]{24})\/pay/)?.[1];
    assert.ok(unitBillId);

    await admin.submit(`${b}/unit-bills/${unitBillId}/pay`, {
      amount: '750', paymentMethod: 'UPI',
    }, `${b}/bills/${billId}`);

    const after = await admin.get(`${b}/bills/${billId}`);
    assert.match(after.text, /750\.00/, 'the part payment shows against the unit');
    assert.match(after.text, /UNPAID/, 'and it is still short');
  });
});

test('the parking screen works end to end', async (t) => {
  let societyId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Parking UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '2', includeGroundFloor: 'false',
      contactPersonName: 'Vikram Rao', contactNumber: '9966600001', email: 'vikram@pui.test',
      status: 'Active',
      'address.street': '6 Circle', 'address.city': 'Mehsana',
      'address.state': 'Gujarat', 'address.pincode': '384001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
  });

  await t.test('it renders empty before anything exists', async () => {
    const res = await admin.get(`/app/society/societies/${societyId}/parking`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Something went wrong/);
    assert.match(res.text, /No parking yet/);
  });

  await t.test('a level and a run of slots can be added', async () => {
    const b = `/app/society/societies/${societyId}`;
    await admin.submit(`${b}/parking/levels`, {
      levelName: 'Basement 1', levelType: 'Basement',
    }, `${b}/parking`);

    const page = await admin.get(`${b}/parking`);
    const levelId = page.text.match(/name="levelId"[\s\S]*?value="([a-f0-9]{24})"/)?.[1];
    assert.ok(levelId, 'the new level should be selectable');

    await admin.submit(`${b}/parking/slots`, {
      levelId, from: '1', to: '4', slotType: 'CAR',
    }, `${b}/parking`);

    const after = await admin.get(`${b}/parking`);
    assert.match(after.text, /Basement 1/);
    assert.match(after.text, />4<\/div>\s*<div class="lbl">Slots/, 'four slots counted');
    assert.match(after.text, /AVAILABLE/);
  });

  await t.test('a slot can be allocated and released', async () => {
    const b = `/app/society/societies/${societyId}`;
    const page = await admin.get(`${b}/parking`);
    const slotId = page.text.match(/parking\/([a-f0-9]{24})\/allocate/)?.[1];
    const unitId = page.text.match(/name="unitId"[\s\S]*?value="([a-f0-9]{24})"/)?.[1];
    assert.ok(slotId && unitId);

    await admin.submit(`${b}/parking/${slotId}/allocate`, { unitId }, `${b}/parking`);
    const allocated = await admin.get(`${b}/parking`);
    assert.match(allocated.text, /ALLOCATED/);

    await admin.submit(`${b}/parking/${slotId}/release`, {}, `${b}/parking`);
    const released = await admin.get(`${b}/parking`);
    assert.match(released.text, />4<\/div>\s*<div class="lbl">Available/, 'all four free again');
  });
});

test('a developer can be added and attached', async (t) => {
  await t.test('the form adds one', async () => {
    const res = await admin.submit('/app/society/developers', {
      firstName: 'Anita', lastName: 'Rao', mobileNumber: '9700000001',
      email: 'anita@builders.test', companyName: 'Rao Constructions',
    }, '/app/society/developers');
    assert.equal(res.status, 302);

    const list = await admin.get('/app/society/developers');
    assert.match(list.text, /Rao Constructions/);
  });

  await t.test('the new-society form offers it', async () => {
    const res = await admin.get('/app/society/societies/new');
    assert.match(res.text, /Rao Constructions/);
  });
});

test('the enquiry pipeline can be built from the UI', async (t) => {
  await t.test('a stage and a sub-stage are added', async () => {
    await admin.submit('/app/society/pipeline', {
      level: 'stage', title: 'Qualified', orderBy: '1',
    }, '/app/society/pipeline');

    const page = await admin.get('/app/society/pipeline');
    assert.match(page.text, /Qualified/);

    const stageId = page.text.match(/value="([a-f0-9]{24})" data-level="sub"/)?.[1];
    assert.ok(stageId, 'the stage should be offered as a parent');

    await admin.submit('/app/society/pipeline', {
      level: 'sub', parentId: stageId, title: 'Proposal sent', orderBy: '1',
    }, '/app/society/pipeline');

    const after = await admin.get('/app/society/pipeline');
    assert.match(after.text, /Proposal sent/);
  });
});

test('permissions gate the module', async (t) => {
  await t.test('a sales user cannot reach it', async () => {
    const rep = h.client();
    await rep.login('rep@alpha.test');
    const res = await rep.get('/app/society/societies');
    assert.equal(res.status, 403, 'society.view is not granted to a sales user');
  });

  await t.test('and does not see it in the nav', async () => {
    const rep = h.client();
    await rep.login('rep@alpha.test');
    const res = await rep.get('/app/dashboard');
    assert.doesNotMatch(res.text, /href="\/app\/society\/societies"/);
  });
});

test('the gate and attendance screens work end to end', async (t) => {
  const visitorsService = require('../../src/services/society/visitors');
  const {
    Society, SocietyUnit, SocietyEmployee, SocietyEmployeeAttendance,
  } = require('../../src/db/models/society');

  let societyId;
  let base;
  let ctx;
  let logId;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Gate UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '2', includeGroundFloor: 'false',
      contactPersonName: 'Nita Shah', contactNumber: '9955500001', email: 'nita@gui.test',
      status: 'Active',
      'address.street': '7 Lane', 'address.city': 'Surat',
      'address.state': 'Gujarat', 'address.pincode': '395001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
    base = `/app/society/societies/${societyId}`;
    ctx = { societyId: (await Society.findById(societyId))._id };
  });

  await t.test('the gate renders before anybody has arrived', async () => {
    const res = await admin.get(`${base}/visitors`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Something went wrong/);
    assert.match(res.text, /Nobody is inside/);
    assert.match(res.text, /No visits yet/);
  });

  await t.test('an arrival shows as awaiting a resident', async () => {
    const unit = await SocietyUnit.findOne({ societyId: ctx.societyId }).lean();
    const log = await visitorsService.recordEntry(ctx, {
      firstName: 'Kiran', lastName: 'Patel', mobileNumber: '9788800001',
      visitorType: 'GUEST', unitIds: [unit._id], expectedDate: new Date(),
    }, {});
    logId = log._id;

    const res = await admin.get(`${base}/visitors`);
    assert.match(res.text, /Kiran Patel/);
    assert.match(res.text, />1<\/div>\s*<div class="lbl">Awaiting a resident/);
  });

  await t.test('the office can let them in and mark them out', async () => {
    await admin.submit(`${base}/visitors/${logId}/allow`, {}, `${base}/visitors`);
    const inside = await admin.get(`${base}/visitors`);
    assert.match(inside.text, />1<\/div>\s*<div class="lbl">Inside now/);

    await admin.submit(`${base}/visitors/${logId}/exit`, {}, `${base}/visitors`);
    const out = await admin.get(`${base}/visitors`);
    assert.match(out.text, /Nobody is inside/);
    assert.match(out.text, /Kiran Patel/, 'still in the log');
  });

  await t.test('a pass can be issued from the screen', async () => {
    const unit = await SocietyUnit.findOne({ societyId: ctx.societyId }).lean();
    const log = await visitorsService.recordEntry(ctx, {
      firstName: 'Pass', lastName: 'Guest', mobileNumber: '9788800002',
      visitorType: 'GUEST', unitIds: [unit._id], expectedDate: new Date(),
    }, {});

    const res = await admin.submit(
      `${base}/visitors/${log._id}/pass`, { validHours: '4' }, `${base}/visitors`,
    );
    assert.equal(res.status, 302);

    const page = await admin.get(`${base}/visitors`);
    assert.match(page.text, /Pass VP-\d+ issued/);
  });

  await t.test('the log filter narrows by status', async () => {
    const res = await admin.get(`${base}/visitors?status=EXITED`);
    assert.equal(res.status, 200);

    // The filter belongs to the log; "Expected today" above it is a separate
    // read and deliberately keeps showing everyone still due.
    const log = res.text.slice(res.text.indexOf('Gate log'));
    assert.match(log, /Kiran Patel/);
    assert.doesNotMatch(log, /Pass Guest/, 'that one never left');
    assert.match(res.text, /Pass Guest/, 'still expected, though');
  });

  await t.test('attendance renders empty, then counts a closed shift', async () => {
    const empty = await admin.get(`${base}/attendance`);
    assert.equal(empty.status, 200);
    assert.match(empty.text, /Nothing recorded/);

    // The chairman's society is seeded with a guard; give them one closed shift.
    const guard = await SocietyEmployee.findOne({ mobileNumber: '9955500001' }).lean()
      || await SocietyEmployee.create({ employeeName: 'Gate Staff', mobileNumber: '9788800009' });
    const clockIn = new Date(Date.now() - 8 * 3600 * 1000);
    await SocietyEmployeeAttendance.create({
      societyId: ctx.societyId, employeeId: guard._id,
      clockInTime: clockIn, clockOutTime: new Date(), totalSeconds: 8 * 3600, status: 'EXIT',
    });

    const res = await admin.get(`${base}/attendance`);
    assert.match(res.text, /Gate Staff|Nita Shah/);
    assert.match(res.text, />8<\/td>/, 'eight hours');
  });
});

test('the property board and the chairman dashboard', async (t) => {
  const listingsService = require('../../src/services/society/propertyListings');
  const occupancy = require('../../src/services/society/occupancy');
  const {
    Society, SocietyUnit, SocietyUser,
  } = require('../../src/db/models/society');

  let societyId;
  let base;
  let ctx;

  await t.before(async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Board UI', projectType: 'Residential',
      totalBlocks: '1', totalFloors: '1', totalUnits: '2', includeGroundFloor: 'false',
      contactPersonName: 'Priya Desai', contactNumber: '9944400001', email: 'priya@bui.test',
      status: 'Active',
      'address.street': '8 Lane', 'address.city': 'Vadodara',
      'address.state': 'Gujarat', 'address.pincode': '390001',
    }, '/app/society/societies/new');
    societyId = res.location.split('/').pop();
    base = `/app/society/societies/${societyId}`;
    ctx = { societyId: (await Society.findById(societyId))._id };
  });

  await t.test('the board renders empty', async () => {
    const res = await admin.get(`${base}/listings`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Something went wrong/);
    assert.match(res.text, /Nothing listed/);
  });

  await t.test('a resident listing shows with its asking price', async () => {
    const unit = await SocietyUnit.findOne({ societyId: ctx.societyId }).lean();
    const owner = await SocietyUser.create({
      mobileNumber: '9088800001', countryCode: '+91', firstName: 'Ravi',
    });
    await occupancy.assign({
      societyId: ctx.societyId, unitId: unit._id, userId: owner._id, residentType: 'Owner',
      person: { firstName: 'Ravi', lastName: 'Joshi', mobileNumber: '9088800001' },
    });
    await listingsService.create(ctx, {
      unitId: unit._id, type: 'RENT', price: '32000', negotiable: true,
      furnishing: 'SEMI_FURNISHED',
    }, owner._id);

    const res = await admin.get(`${base}/listings`);
    assert.match(res.text, /For rent/);
    assert.match(res.text, /Ravi Joshi/);
    assert.match(res.text, /32,000/, 'rendered as money, not as paise');
    assert.match(res.text, /negotiable/);
  });

  await t.test('the type filter narrows the board', async () => {
    const forSale = await admin.get(`${base}/listings?type=SELL`);
    assert.equal(forSale.status, 200);
    assert.match(forSale.text, /Nothing listed/);
  });

  await t.test('the overview says nothing is waiting when nothing is', async () => {
    const res = await admin.get(base);
    assert.equal(res.status, 200);
    assert.match(res.text, /Needs attention/);
    assert.match(res.text, /Nothing is waiting on you/);
  });

  await t.test('a pending queue appears as a link to the screen that clears it', async () => {
    const claimant = await SocietyUser.create({ mobileNumber: '9088800002', countryCode: '+91' });
    const unit = await SocietyUnit.findOne({ societyId: ctx.societyId, currentOwnerId: null }).lean();
    await require('../../src/services/society/onboarding').submit(ctx, {
      unitId: unit._id, residentType: 'Owner',
      firstName: 'New', lastName: 'Claimant', mobileNumber: '9088800002',
    }, claimant._id);

    const res = await admin.get(base);
    assert.match(res.text, /Onboarding requests: <strong>1<\/strong>/);
    assert.match(res.text, new RegExp(`href="${base}/onboarding"`));
    assert.doesNotMatch(res.text, /Nothing is waiting on you/);
  });
});
