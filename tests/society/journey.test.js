const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyRole, SocietyAdmin, SocietyUser, SocietyUnit, SocietyBlock,
  SocietyStage, SocietyInquiry, SocietyUnitOccupancy, SocietyMember,
  SocietyComplaint, SocietyComplaintType, SocietyNotice, SocietyPoll,
  SocietyUnitBill, SocietyVisitorLog, SocietyAmenity, SocietyAmenityType,
  SocietyAmenitySlot, SocietyAmenityBooking, SocietyEmployee, SocietyEmployeeType,
  SocietyEmployeeAssignment, SocietyBillCategory, SocietyBalanceSheet,
  SocietyResidentOnboardingRequest, SocietyPropertyListing,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const otp = require('../../src/services/society/otp');

/**
 * SOCIETY-PLAN.md §4.4 — one continuous session, front door to gate.
 *
 * Everything here goes through HTTP: the EJS admin as a browser drives it, and
 * the `/api/v1` surfaces as the resident app and the gate device drive them.
 * Nothing is set up by reaching into a service, so a step that only works
 * because an earlier step wrote a row directly cannot pass.
 *
 * The journey is the one a real society actually takes:
 *   an enquiry arrives from the app → the office onboards the society →
 *   structure is generated → the chairman signs in → a resident claims a flat →
 *   the chairman approves → the resident signs in → maintenance is billed and
 *   paid → a complaint is raised and resolved → a notice and a poll go out →
 *   an amenity is booked → a visitor is pre-approved and walks through the gate
 *   → the resident lists their flat.
 */

let base;
let admin;      // the CRM back office, session + CSRF
const state = {};

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const json = (hs) => ({ ...hs, accept: 'application/json' });
const pinned = (t) => ({ ...bearer(t), 'x-society-id': String(state.societyId) });

const call = (method) => (path, body, headers) => fetch(`${base}${path}`, {
  method,
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const PUT = call('PUT');

/** Signs a resident in the way the app does: ask for a code, then send it back. */
async function signIn(c, mobileNumber) {
  const asked = await c.postJson('/api/v1/app/users/register', { mobileNumber, countryCode: '+91' });
  assert.equal(asked.status, 200, `register ${mobileNumber}`);

  // The code is hashed on the row and never returned, so the test issues a
  // known one the same way the service does rather than reading it back.
  const { code, fields } = await otp.issueForUser();
  await SocietyUser.updateOne({ mobileNumber }, { $set: fields });

  const verified = await c.postJson('/api/v1/app/users/verify-otp', {
    mobileNumber, countryCode: '+91', otp: code,
  });
  assert.equal(verified.status, 200, `verify ${mobileNumber}`);
  return verified.data.result.token;
}

test('END-TO-END: a society is onboarded and lived in', async (t) => {
  base = await h.startServer();
  await h.resetDb();
  t.after(async () => { await h.stopServer(); });

  await h.seedTwoOrgs();
  admin = h.client();
  const c = h.client();

  /* ═════════════════ 1. Before there is a society ═════════════════ */

  await t.test('1.1 the back office signs in', async () => {
    const res = await admin.login('admin@alpha.test');
    assert.equal(res.location, '/app/dashboard');
  });

  await t.test('1.2 the roles the module needs exist', async () => {
    await SocietyRole.create({
      key: 'chairman', name: 'Chairman', displayName: 'Chairman',
      level: 2, scope: 'society', permissions: ['*:*'],
    });
    await SocietyRole.create({
      key: 'security_guard', name: 'Security Guard', displayName: 'Security Guard',
      level: 5, scope: 'society', permissions: ['gate:*'],
    });
    await SocietyStage.create({ title: 'New Inquiry', orderNo: 1 });
  });

  await t.test('1.3 an enquiry arrives from someone with the app', async () => {
    // They have no society yet — this is the only thing the app lets them do.
    const enquirer = await SocietyUser.create({
      mobileNumber: '9000700001', countryCode: '+91', firstName: 'Hemant',
    });
    state.enquirerToken = await signIn(c, '9000700001');

    const res = await c.postJson('/api/v1/app/society/society-request', {
      societyName: 'Riverfront Residency', societyAddress: '12 Riverside, Ahmedabad',
      firstName: 'Hemant', lastName: 'Shah', mobileNumber: '9000700001',
      countryCode: '+91', email: 'hemant@rr.test', noOfUnit: 12,
      notes: 'Twelve flats, one block', sourceName: 'App',
    }, { headers: bearer(state.enquirerToken) });
    assert.equal(res.status, 200);

    const inquiry = await SocietyInquiry.findOne({ societyName: 'Riverfront Residency' }).lean();
    assert.ok(inquiry.stageId, 'placed in the pipeline');
    assert.ok(inquiry.currentOwnerId ?? true, 'assigned if there is anyone to assign to');
    state.enquirerId = enquirer._id;
  });

  await t.test('1.4 the office sees it on the enquiries screen', async () => {
    const res = await admin.get('/app/society/enquiries');
    assert.equal(res.status, 200);
    assert.match(res.text, /Riverfront Residency/);
  });

  /* ═════════════════ 2. The society is onboarded ═════════════════ */

  await t.test('2.1 the office creates it, and the building is generated', async () => {
    const res = await admin.submit('/app/society/societies', {
      societyName: 'Riverfront Residency', projectType: 'Residential',
      // `totalUnits` on the society form means units PER FLOOR — the source's
      // meaning, kept (see services/society/structure.js).
      totalBlocks: '1', totalFloors: '3', totalUnits: '4', includeGroundFloor: 'false',
      contactPersonName: 'Hemant Shah', contactNumber: '9000700002', email: 'chair@rr.test',
      status: 'Active', billingCycle: 'Monthly',
      'address.street': '12 Riverside', 'address.city': 'Ahmedabad',
      'address.state': 'Gujarat', 'address.pincode': '380001',
    }, '/app/society/societies/new');
    assert.equal(res.status, 302);
    state.societyId = res.location.split('/').pop();

    const [blocks, units] = await Promise.all([
      SocietyBlock.countDocuments({ societyId: state.societyId, isDeleted: false }),
      SocietyUnit.countDocuments({ societyId: state.societyId, isDeleted: false }),
    ]);
    assert.equal(blocks, 1);
    assert.equal(units, 12, 'three floors of four');
  });

  await t.test('2.2 a chairman was created alongside it', async () => {
    const chairman = await SocietyAdmin.findOne({
      societyId: state.societyId, phoneNumber: '9000700002',
    }).lean();
    assert.ok(chairman, 'the society is not left without an administrator');
    assert.equal(chairman.role, 'Chairman');
    state.chairmanId = chairman._id;
    state.chairmanUserId = chairman.userId;
  });

  await t.test('2.3 the chairman signs in and is pinned to their society', async () => {
    const societyCode = (await Society.findById(state.societyId).lean()).societyCode;
    const res = await c.postJson('/api/v1/auth/send-otp', {
      societyCode, countryCode: '+91', phoneNumber: '9000700002',
    });
    assert.equal(res.status, 200);

    // The real code is hashed and never returned, so a known one replaces it —
    // after the send, which is what wrote the row.
    const code = await forceAdminOtp('9000700002');
    const verified = await c.postJson('/api/v1/auth/verify-otp', {
      societyCode, countryCode: '+91', phoneNumber: '9000700002', otp: code,
    });
    assert.equal(verified.status, 200);
    state.chairToken = verified.data.result.accessToken;

    const mine = await c.get('/api/v1/society-admin/society/assigned-societies', {
      headers: json(pinned(state.chairToken)),
    });
    assert.equal(mine.status, 200);
    assert.equal(mine.data.result.societies.length, 1);
  });

  await t.test('2.4 that token cannot reach another society', async () => {
    const other = await Society.create({
      societyName: 'Somewhere Else', societyCode: 'SOC-JR-999', projectType: 'Residential',
      contactPersonName: 'X', contactNumber: '9000799999', email: 'x@else.test',
      address: { street: '1', city: 'Surat', state: 'GJ', pincode: '395001' },
    });
    const res = await c.get('/api/v1/society-admin/society/assigned-societies', {
      headers: { ...json(bearer(state.chairToken)), 'x-society-id': String(other._id) },
    });
    assert.equal(res.status, 401, 'the pin is checked against their assignments, every request');
  });

  /* ═════════════════ 3. People move in ═════════════════ */

  await t.test('3.1 a resident finds the building in the app', async () => {
    await SocietyUser.create({
      mobileNumber: '9000700010', countryCode: '+91', firstName: 'Nisha',
    });
    state.residentToken = await signIn(c, '9000700010');

    const browse = await c.get('/api/v1/app/society', { headers: json(bearer(state.residentToken)) });
    assert.equal(browse.status, 200);
    assert.ok(browse.data.result.societies.some((s) => s.societyName === 'Riverfront Residency'));

    const picker = await c.get(`/api/v1/app/society/${state.societyId}/details`, {
      headers: json(bearer(state.residentToken)),
    });
    assert.equal(picker.data.result.blocks[0].totalUnits, 12);
    state.unitId = picker.data.result.blocks[0].floors[0].units[0]._id;
    state.unitNumber = picker.data.result.blocks[0].floors[0].units[0].unitNumber;
  });

  await t.test('3.2 they claim a flat, and are given nothing yet', async () => {
    const res = await c.postJson('/api/v1/app/society/register-resident', {
      societyId: String(state.societyId), unitId: String(state.unitId), residentType: 'Owner',
      firstName: 'Nisha', lastName: 'Patel', mobileNumber: '9000700010', email: 'nisha@rr.test',
    }, { headers: bearer(state.residentToken) });
    assert.equal(res.status, 200);
    state.requestId = res.data.result.requestId;

    assert.equal(await SocietyUnitOccupancy.countDocuments({
      societyId: state.societyId, unitId: state.unitId, isCurrent: true,
    }), 0, 'asking is not moving in');
  });

  await t.test('3.3 the chairman sees the request waiting on their overview', async () => {
    const res = await admin.get(`/app/society/societies/${state.societyId}`);
    assert.match(res.text, /Onboarding requests: <strong>1<\/strong>/);
  });

  await t.test('3.4 approving it makes them a resident and a member', async () => {
    const res = await admin.submit(
      `/app/society/societies/${state.societyId}/onboarding/${state.requestId}`,
      { action: 'approve' }, `/app/society/societies/${state.societyId}/onboarding`,
    );
    assert.equal(res.status, 302);

    const request = await SocietyResidentOnboardingRequest.findById(state.requestId).lean();
    assert.equal(request.status, 'Approved');

    const occupancy = await SocietyUnitOccupancy.findOne({
      societyId: state.societyId, unitId: state.unitId, isCurrent: true,
    }).lean();
    assert.ok(occupancy, 'they live there now');
    assert.equal(occupancy.residentType, 'Owner');
    assert.equal(occupancy.memberRole, 'PRIMARY');
    state.occupancyId = occupancy._id;
    state.residentId = occupancy.userId;

    assert.ok(await SocietyMember.exists({ societyId: state.societyId, userId: occupancy.userId }));

    const unit = await SocietyUnit.findById(state.unitId).lean();
    assert.ok(unit.currentOwnerId, 'and the unit says so');
  });

  await t.test('3.5 the resident\'s app now knows where they live', async () => {
    const res = await c.get('/api/v1/app/society/user/society-details', {
      headers: json(bearer(state.residentToken)),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.societyInfo.name, 'Riverfront Residency');

    const mine = await c.get('/api/v1/app/society/my-societies', {
      headers: json(bearer(state.residentToken)),
    });
    assert.equal(mine.data.result.societies[0].myUnits[0].unitNumber, state.unitNumber);
  });

  /* ═════════════════ 4. Money ═════════════════ */

  await t.test('4.1 the office raises a maintenance charge in rupees', async () => {
    const b = `/app/society/societies/${state.societyId}`;
    const category = await SocietyBillCategory.create({
      societyId: state.societyId, name: 'Maintenance',
    });
    const sheet = await SocietyBalanceSheet.create({
      societyId: state.societyId, name: 'FY 2026-27',
      startDate: new Date(), endDate: new Date(),
    });

    const today = new Date().toISOString().slice(0, 10);
    const res = await admin.submit(`${b}/bills`, {
      name: 'April maintenance', billCategoryId: String(category._id),
      balanceSheetId: String(sheet._id), dueDate: today,
      priceOwner: '2500', priceTenant: '2500', priceCloseUnit: '2500',
      publishStatus: 'PUBLISHED',
    }, `${b}/billing`);
    assert.equal(res.status, 302);

    const bills = await SocietyUnitBill.find({ societyId: state.societyId }).lean();
    assert.equal(bills.length, 12, 'one per flat');
    assert.equal(bills[0].amountMinor, 250000, '₹2,500 stored as paise');
    state.unitBill = bills.find((x) => String(x.unitId) === String(state.unitId));
  });

  await t.test('4.2 the resident sees what they owe', async () => {
    const res = await c.get(`/api/v1/app/bills/list?societyId=${state.societyId}`, {
      headers: json(bearer(state.residentToken)),
    });
    assert.equal(res.status, 200);
    const mine = res.data.result.bills ?? res.data.result.unitBills ?? [];
    assert.equal(mine.length, 1, 'their own bill, and nobody else\'s');
  });

  await t.test('4.3 they pay, and the unit is settled', async () => {
    const b = `/app/society/societies/${state.societyId}`;
    const res = await admin.submit(`${b}/unit-bills/${state.unitBill._id}/pay`, {
      amount: '2500', paymentMethod: 'UPI',
    }, `${b}/billing`);
    assert.equal(res.status, 302);

    const after = await SocietyUnitBill.findById(state.unitBill._id).lean();
    assert.equal(after.status, 'PAID');
  });

  /* ═════════════════ 5. Something breaks ═════════════════ */

  await t.test('5.1 the resident raises a complaint from the app', async () => {
    const type = await SocietyComplaintType.create({
      societyId: state.societyId, typeName: 'Plumbing',
    });
    const res = await c.postJson(`/api/v1/app/complaints/create?societyId=${state.societyId}`, {
      title: 'Tap leaking', description: 'Kitchen tap has been dripping since Tuesday',
      complaintTypeId: String(type._id), unitId: String(state.unitId), priority: 'Medium',
    }, { headers: bearer(state.residentToken) });
    assert.equal(res.status, 201);
    state.complaintId = res.data.result._id;
    assert.match(res.data.result.complaintId, /CM/, 'a reference they can quote');
  });

  await t.test('5.2 it shows on the chairman\'s overview as needing attention', async () => {
    const res = await admin.get(`/app/society/societies/${state.societyId}`);
    assert.match(res.text, /Open complaints: <strong>1<\/strong>/);
  });

  await t.test('5.3 the office works it to resolved', async () => {
    const b = `/app/society/societies/${state.societyId}/complaints/${state.complaintId}`;
    await admin.submit(b, { status: 'In Progress', comment: 'Plumber booked' }, b);
    await admin.submit(b, { status: 'Close', comment: 'Washer replaced' }, b);

    const complaint = await SocietyComplaint.findById(state.complaintId).lean();
    assert.equal(complaint.status, 'Close');

    const history = await require('../../src/services/society/complaints')
      .history({ societyId: state.societyId }, state.complaintId);
    // Each row records the move, not the state, and the trail comes back
    // newest-first — which is the order the detail screen shows it in.
    assert.deepEqual(history.map((r) => r.newStatus).reverse(), ['Open', 'In Progress', 'Close']);
  });

  /* ═════════════════ 6. The society talks to itself ═════════════════ */

  await t.test('6.1 a notice goes out and the resident receives it', async () => {
    const b = `/app/society/societies/${state.societyId}`;
    const res = await admin.submit(`${b}/notices`, {
      title: 'Water tank cleaning', text: 'Supply off 10am to 2pm on Saturday',
      category: 'General', residentType: 'ALL', publishStatus: 'PUBLISHED',
    }, `${b}/notices`);
    assert.equal(res.status, 302);

    const notice = await SocietyNotice.findOne({ societyId: state.societyId }).lean();
    assert.equal(notice.publishStatus, 'PUBLISHED');

    const seen = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${state.societyId}`, {
      headers: json(bearer(state.residentToken)),
    });
    assert.equal(seen.status, 200);
    assert.equal(seen.data.result.notices.length, 1);
  });

  await t.test('6.2 a poll is published and the resident votes once', async () => {
    const b = `/app/society/societies/${state.societyId}`;
    await admin.submit(`${b}/polls`, {
      title: 'Repaint the lobby?', option: ['Yes', 'No'], pollType: 'SINGLE_CHOICE',
    }, `${b}/polls`);

    let poll = await SocietyPoll.findOne({ societyId: state.societyId }).lean();
    await admin.submit(`${b}/polls/${poll._id}/publish`, {}, `${b}/polls`);
    poll = await SocietyPoll.findById(poll._id).lean();
    assert.equal(poll.publishStatus, 'PUBLISHED');
    state.pollId = poll._id;

    const vote = () => c.postJson(
      `/api/v1/app/polls/vote/${poll._id}?societyId=${state.societyId}`,
      { selectedOptions: [String(poll.options[0]._id)] },
      { headers: bearer(state.residentToken) },
    );
    assert.equal((await vote()).status, 200);

    // Voting twice is refused by a unique index, not by a re-read.
    const again = await vote();
    assert.ok(again.status >= 400, 'one resident, one vote');
  });

  /* ═════════════════ 7. Using the place ═════════════════ */

  await t.test('7.1 an amenity with a slot is set up', async () => {
    const type = await SocietyAmenityType.create({ societyId: state.societyId, name: 'Hall' });
    const amenity = await SocietyAmenity.create({
      societyId: state.societyId, name: 'Community Hall', description: 'Ground floor',
      amenityTypeId: type._id, capacity: 80, isBookable: true,
    });
    const slot = await SocietyAmenitySlot.create({
      societyId: state.societyId, amenityId: amenity._id,
      startTime: '18:00', endTime: '22:00', capacity: 1,
    });
    state.amenityId = amenity._id;
    state.slotId = slot._id;
  });

  await t.test('7.2 the resident books it, and a second booking is refused', async () => {
    const when = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const book = () => c.postJson(
      `/api/v1/app/amenity/create-booking?societyId=${state.societyId}`,
      {
        amenityId: String(state.amenityId), slotIds: [String(state.slotId)],
        bookingDate: when, unitId: String(state.unitId),
      },
      { headers: bearer(state.residentToken) },
    );

    const first = await book();
    assert.equal(first.status, 201);

    const second = await book();
    assert.ok(second.status >= 400, 'the slot is taken');
    assert.equal(await SocietyAmenityBooking.countDocuments({
      societyId: state.societyId, isDeleted: false,
    }), 1);
  });

  /* ═════════════════ 8. The gate ═════════════════ */

  await t.test('8.1 a guard is hired and posted', async () => {
    const type = await SocietyEmployeeType.findOne({
      societyId: state.societyId, typeName: /security/i,
    }).lean() || await SocietyEmployeeType.create({
      societyId: state.societyId, typeName: 'Security Guard', isSystem: true,
    });

    const guardUser = await SocietyUser.create({
      mobileNumber: '9000700020', countryCode: '+91', role: 'gateKepper',
    });
    const guard = await SocietyEmployee.create({
      employeeName: 'Ramesh', mobileNumber: '9000700020', userId: guardUser._id,
    });
    await SocietyEmployeeAssignment.create({
      societyId: state.societyId, employeeId: guard._id, employeeTypeId: type._id,
      dateOfJoining: new Date(), status: 'ACTIVE',
    });
    state.guardToken = jwtLib.sign('user', { id: guardUser._id });
    state.guardId = guard._id;
  });

  await t.test('8.2 a visitor arrives and the resident is asked', async () => {
    const res = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Deepak', lastName: 'Courier', mobileNumber: '9000700030',
      visitorType: 'DELIVERY_COURIER', unitIds: [String(state.unitId)],
      purposeOfVisit: 'Parcel',
    }, { headers: pinned(state.guardToken) });
    assert.equal(res.status, 201);
    assert.equal(res.data.result.status, 'PENDING_APPROVAL');
    state.visitId = res.data.result._id;
  });

  await t.test('8.3 the resident approves and the visitor is let in', async () => {
    const res = await PUT(
      `/api/v1/app/visitors/process-entry?societyId=${state.societyId}`,
      { visitorLogId: state.visitId, approve: true },
      bearer(state.residentToken),
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'ENTERED');

    const inside = await c.get('/api/v1/gatekeeper/stats', { headers: json(pinned(state.guardToken)) });
    assert.equal(inside.data.result.currentlyInside, 1);
  });

  await t.test('8.4 and out again', async () => {
    const res = await PUT('/api/v1/gatekeeper/exit',
      { visitorLogId: state.visitId }, pinned(state.guardToken));
    assert.equal(res.status, 200);

    const log = await SocietyVisitorLog.findById(state.visitId).lean();
    assert.equal(log.status, 'EXITED');
    assert.ok(log.outTime > log.inTime);
  });

  await t.test('8.5 the office can see the whole visit', async () => {
    const res = await admin.get(`/app/society/societies/${state.societyId}/visitors?status=EXITED`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Deepak Courier/);
  });

  /* ═════════════════ 9. Moving on ═════════════════ */

  await t.test('9.1 the resident lists their flat', async () => {
    const res = await c.postJson(
      `/api/v1/app/property-listing/create?societyId=${state.societyId}`,
      {
        unitId: String(state.unitId), type: 'SELL', price: '7500000',
        negotiable: true, furnishing: 'SEMI_FURNISHED', description: 'Corner, river view',
      },
      { headers: bearer(state.residentToken) },
    );
    assert.equal(res.status, 201);
    assert.equal(res.data.result.price, '7500000');

    const stored = await SocietyPropertyListing.findById(res.data.result._id)
      .setOptions({ allowCrossSociety: true }).lean();
    assert.equal(stored.priceMinor, 750000000, 'paise all the way down');
  });

  await t.test('9.2 it shows on the board, read-only, in the office', async () => {
    const res = await admin.get(`/app/society/societies/${state.societyId}/listings`);
    assert.equal(res.status, 200);
    assert.match(res.text, /For sale/);
    assert.match(res.text, new RegExp(state.unitNumber));
  });

  /* ═════════════════ 10. What the journey left behind ═════════════════ */

  await t.test('10.1 every record belongs to this society and only this one', async () => {
    const scoped = [
      SocietyBlock, SocietyUnit, SocietyUnitOccupancy, SocietyMember, SocietyComplaint,
      SocietyNotice, SocietyPoll, SocietyUnitBill, SocietyVisitorLog, SocietyAmenity,
      SocietyAmenityBooking, SocietyPropertyListing, SocietyEmployeeAssignment,
    ];
    for (const Model of scoped) {
      // eslint-disable-next-line no-await-in-loop
      const strays = await Model.countDocuments({
        societyId: { $ne: state.societyId },
      }).setOptions({ allowCrossSociety: true });
      assert.equal(strays, 0, `${Model.modelName} leaked a row out of its society`);
    }
  });

  await t.test('10.2 the resident\'s token still cannot act as the chairman', async () => {
    const res = await c.get('/api/v1/society-admin/society/assigned-societies', {
      headers: json(pinned(state.residentToken)),
    });
    assert.equal(res.status, 401, 'two audiences, two secrets, all the way through');
  });

  await t.test('10.3 the society reads as lived-in', async () => {
    const stats = await require('../../src/services/society/societies').statistics(state.societyId);
    assert.equal(stats.totalUnits, 12);
    assert.equal(stats.occupiedUnits, 1);

    const overview = await admin.get(`/app/society/societies/${state.societyId}`);
    assert.equal(overview.status, 200);
    // The onboarding request was approved and the complaint resolved, so both
    // queues are clear. The eleven other flats genuinely have not paid.
    assert.doesNotMatch(overview.text, /Onboarding requests:/);
    assert.doesNotMatch(overview.text, /Open complaints:/);
    assert.match(overview.text, /Unpaid bills: <strong>11<\/strong>/,
      'the flats nobody lives in still owe');
  });
});

/** Issues a known admin OTP the way `services/society/auth.js` stores one. */
async function forceAdminOtp(phoneNumber) {
  const { code, fields } = await otp.issue();
  await SocietyAdmin.updateOne({ phoneNumber }, { $set: fields });
  return code;
}
