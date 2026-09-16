const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyUnitOccupancy, SocietyVisitor, SocietyVisitorLog,
  SocietyVisitorPass, SocietyEmployee, SocietyEmployeeType,
  SocietyEmployeeAssignment, SocietyEmployeeAttendance, SocietyNotification,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');
const visitors = require('../../src/services/society/visitors');

/**
 * Phase 9: the gate.
 *
 * Two rules carry this phase and both are tested from the resident's side as
 * well as the guard's: approval is per unit, and a household's own
 * auto-approval setting decides whether they are disturbed at all.
 */

let base;
let society;
let adminToken;
let guardToken;
let resAToken;
let resBToken;
let unitA;
let unitB;
let guardId;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const gate = () => ({ Authorization: `Bearer ${guardToken}`, 'x-society-id': String(society._id) });
const gateJson = () => ({ ...gate(), accept: 'application/json' });
const asRes = (t) => ({ Authorization: `Bearer ${t}` });
const resJson = (t) => ({ ...asRes(t), accept: 'application/json' });

const call = (m) => (path, body, headers) => fetch(`${base}${path}`, {
  method: m,
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const put = call('PUT');

const ctx = () => ({ societyId: society._id });

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const role = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });
  await SocietyRole.create({
    key: 'security_guard', name: 'Security Guard', displayName: 'Security Guard',
    level: 5, scope: 'society', permissions: ['gate:*'],
  });

  society = await Society.create({
    societyName: 'Gate Test', societyCode: 'SOC-GT-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9000000801', email: 'chair@gt.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  const chairUser = await SocietyUser.create({ mobileNumber: '9000000801', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9000000801', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  // A guard, posted to this society — the posting is what the gate token checks.
  const empType = await SocietyEmployeeType.create({
    societyId: society._id, typeName: 'Security Guard', isSystem: true,
  });
  const guardUser = await SocietyUser.create({
    mobileNumber: '9033300801', countryCode: '+91', role: 'gateKepper',
  });
  const guard = await SocietyEmployee.create({
    employeeName: 'Mohan', mobileNumber: '9033300801', userId: guardUser._id,
  });
  guardId = guard._id;
  await SocietyEmployeeAssignment.create({
    societyId: society._id, employeeId: guard._id, employeeTypeId: empType._id,
    dateOfJoining: new Date(), status: 'ACTIVE',
  });
  guardToken = jwtLib.sign('user', { id: guardUser._id });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  unitA = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-GT-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-101',
  });
  unitB = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-GT-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-102',
  });

  const rA = await SocietyUser.create({
    mobileNumber: '9011100801', countryCode: '+91', firstName: 'Alka', societyId: society._id,
  });
  const rB = await SocietyUser.create({
    mobileNumber: '9011100802', countryCode: '+91', firstName: 'Bhavik', societyId: society._id,
  });
  resAToken = jwtLib.sign('user', { id: rA._id });
  resBToken = jwtLib.sign('user', { id: rB._id });

  await occupancy.assign({
    societyId: society._id, unitId: unitA._id, userId: rA._id, residentType: 'Owner',
    person: { firstName: 'Alka', lastName: 'Shah', mobileNumber: '9011100801' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitB._id, userId: rB._id, residentType: 'Owner',
    person: { firstName: 'Bhavik', lastName: 'Rao', mobileNumber: '9011100802' },
  });
});

test.after(async () => { await h.stopServer(); });

/* ------------------------------- gate identity -------------------------------- */

test('the gate is its own identity', async (t) => {
  const c = h.client();

  await t.test('a guard posted here can read the gate', async () => {
    const res = await c.get('/api/v1/gatekeeper/stats', { headers: gateJson() });
    assert.equal(res.status, 200);
  });

  await t.test('a resident token cannot', async () => {
    const res = await c.get('/api/v1/gatekeeper/stats', {
      headers: { ...asRes(resAToken), 'x-society-id': String(society._id), accept: 'application/json' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('ending the posting locks the guard out immediately', async () => {
    await SocietyEmployeeAssignment.updateMany(
      { societyId: society._id, employeeId: guardId }, { $set: { status: 'INACTIVE' } },
    );
    const res = await c.get('/api/v1/gatekeeper/stats', { headers: gateJson() });
    assert.equal(res.status, 401, 'authority is the posting, not the token');

    await SocietyEmployeeAssignment.updateMany(
      { societyId: society._id, employeeId: guardId }, { $set: { status: 'ACTIVE' } },
    );
  });
});

/* ------------------------------- approval flow --------------------------------- */

test('a visitor for one unit waits for that unit', async (t) => {
  const c = h.client();
  let logId;

  await t.test('the gate records an arrival and the resident is asked', async () => {
    const res = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Ravi', lastName: 'Courier', mobileNumber: '9777700001',
      visitorType: 'DELIVERY_COURIER', unitIds: [String(unitA._id)],
      purposeOfVisit: 'Parcel',
    }, { headers: gate() });
    assert.equal(res.status, 201);
    logId = res.data.result._id;

    assert.equal(res.data.result.status, 'PENDING_APPROVAL');
    assert.equal(res.data.result.inTime, null, 'nobody is inside until somebody says yes');

    const asked = await SocietyNotification.countDocuments({
      societyId: society._id, type: 'VISITOR', referenceId: logId,
    });
    assert.equal(asked, 1, 'only the unit they are here for');
  });

  await t.test('a resident of ANOTHER unit cannot answer', async () => {
    const res = await put(`/api/v1/app/visitors/process-entry?societyId=${society._id}`,
      { visitorLogId: logId, approve: true }, asRes(resBToken));
    assert.equal(res.status, 404, 'there is no pending approval for their unit');

    const still = await SocietyVisitorLog.findById(logId).lean();
    assert.equal(still.status, 'PENDING_APPROVAL');
  });

  await t.test('the right resident approves and the visitor is in', async () => {
    const res = await put(`/api/v1/app/visitors/process-entry?societyId=${society._id}`,
      { visitorLogId: logId, approve: true }, asRes(resAToken));
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'ENTERED');
    assert.ok(res.data.result.inTime);
  });

  await t.test('the gate can mark them out, but only once', async () => {
    const out = await put('/api/v1/gatekeeper/exit', { visitorLogId: logId }, gate());
    assert.equal(out.status, 200);
    assert.equal(out.data.result.status, 'EXITED');
    assert.ok(out.data.result.outTime);

    const again = await put('/api/v1/gatekeeper/exit', { visitorLogId: logId }, gate());
    assert.equal(again.status, 409, 'they are not inside any more');
  });

  await t.test('the returning visitor is recognised, not duplicated', async () => {
    await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Ravi', lastName: 'Courier', mobileNumber: '9777700001',
      visitorType: 'DELIVERY_COURIER', unitIds: [String(unitB._id)],
    }, { headers: gate() });

    const people = await SocietyVisitor.countDocuments({
      societyId: society._id, mobileNumber: '9777700001', isDeleted: false,
    });
    assert.equal(people, 1, 'one person');
    const visits = await SocietyVisitorLog.countDocuments({
      societyId: society._id, isDeleted: false,
    });
    assert.equal(visits, 2, 'two visits');
  });
});

/* ------------------------------ multi-unit visits ------------------------------- */

test('a visitor for three flats needs three answers', async (t) => {
  const c = h.client();
  let logId;

  await t.test('each named unit gets its own approval row', async () => {
    const res = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Suresh', lastName: 'Plumber', mobileNumber: '9777700002',
      visitorType: 'VENDOR', unitIds: [String(unitA._id), String(unitB._id)],
    }, { headers: gate() });
    assert.equal(res.status, 201);
    logId = res.data.result._id;
    assert.equal(res.data.result.unitApprovals.length, 2);
    assert.ok(res.data.result.unitApprovals.every((u) => u.status === 'PENDING'));
  });

  await t.test('one approval admits them without answering for the other', async () => {
    await put(`/api/v1/app/visitors/process-entry?societyId=${society._id}`,
      { visitorLogId: logId, approve: true }, asRes(resAToken));

    const log = await SocietyVisitorLog.findById(logId).lean();
    assert.equal(log.status, 'ENTERED', 'approved by anyone means they come in');

    const byUnit = new Map(log.unitApprovals.map((u) => [String(u.unitId), u.status]));
    assert.equal(byUnit.get(String(unitA._id)), 'APPROVED');
    assert.equal(byUnit.get(String(unitB._id)), 'PENDING',
      'the other household has still not been asked to decide');
  });

  await t.test('a rejection by everyone turns the visit away', async () => {
    const made = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Unknown', lastName: 'Caller', mobileNumber: '9777700003',
      visitorType: 'GUEST', unitIds: [String(unitA._id), String(unitB._id)],
    }, { headers: gate() });
    const id = made.data.result._id;

    await put(`/api/v1/app/visitors/process-entry?societyId=${society._id}`,
      { visitorLogId: id, approve: false }, asRes(resAToken));
    let log = await SocietyVisitorLog.findById(id).lean();
    assert.equal(log.status, 'PENDING_APPROVAL', 'one no is not everybody');

    await put(`/api/v1/app/visitors/process-entry?societyId=${society._id}`,
      { visitorLogId: id, approve: false }, asRes(resBToken));
    log = await SocietyVisitorLog.findById(id).lean();
    assert.equal(log.status, 'REJECTED');
    assert.equal(log.approvalStatus, 'REJECTED');
  });
});

/* ------------------------------- auto-approval ---------------------------------- */

test('a household that has opted in is not disturbed', async (t) => {
  const c = h.client();

  await t.before(async () => {
    await SocietyUnitOccupancy.updateMany(
      { societyId: society._id, unitId: unitA._id, isCurrent: true },
      { $set: { 'settings.visitor.guestAutoApproval': true } },
    );
    await SocietyNotification.deleteMany({ societyId: society._id });
  });

  await t.test('a GUEST is admitted straight away', async () => {
    const res = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Meera', lastName: 'Friend', mobileNumber: '9777700004',
      visitorType: 'GUEST', unitIds: [String(unitA._id)],
    }, { headers: gate() });

    assert.equal(res.status, 201);
    assert.equal(res.data.result.status, 'ENTERED');
    assert.ok(res.data.result.inTime);
    assert.equal(res.data.result.unitApprovals[0].status, 'APPROVED');

    assert.equal(await SocietyNotification.countDocuments({
      societyId: society._id, type: 'VISITOR',
    }), 0, 'nobody was woken up');
  });

  await t.test('a CAB is still stopped, because that flag is separate', async () => {
    const res = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Cab', lastName: 'Driver', mobileNumber: '9777700005',
      visitorType: 'CAB_AUTO', unitIds: [String(unitA._id)],
    }, { headers: gate() });
    assert.equal(res.data.result.status, 'PENDING_APPROVAL');
  });

  await t.test('the neighbour who did not opt in is still asked', async () => {
    const res = await c.postJson('/api/v1/gatekeeper/entry', {
      firstName: 'Another', lastName: 'Guest', mobileNumber: '9777700006',
      visitorType: 'GUEST', unitIds: [String(unitB._id)],
    }, { headers: gate() });
    assert.equal(res.data.result.status, 'PENDING_APPROVAL',
      'the setting belongs to the household, not the society');
  });
});

/* ---------------------------------- passes -------------------------------------- */

test('gate passes are single-use', async (t) => {
  let passNumber;

  await t.before(async () => {
    const log = await visitors.recordEntry(ctx(), {
      firstName: 'Pass', lastName: 'Holder', mobileNumber: '9777700007',
      visitorType: 'GUEST', unitIds: [unitB._id],
    }, {});
    const pass = await visitors.issuePass(ctx(), log._id, { validHours: 2 }, null);
    passNumber = pass.passNumber;
  });

  await t.test('a pass carries a QR and an expiry', async () => {
    const pass = await visitors.passByNumber(ctx(), passNumber);
    assert.match(pass.passNumber, /^VP-\d{4,}$/);
    assert.match(pass.qrCodeImage, /^data:image\/png;base64,/);
    assert.ok(pass.expiresAt > new Date());
    assert.equal(pass.isUsed, false);
  });

  await t.test('scanning it admits the visitor', async () => {
    const redeemed = await visitors.redeem(ctx(), passNumber, { employeeId: guardId });
    assert.equal(redeemed.isUsed, true);
    assert.ok(redeemed.usedAt);

    const log = await SocietyVisitorLog.findById(redeemed.visitorLogId).lean();
    assert.equal(log.status, 'ENTERED');
  });

  await t.test('scanning it twice is refused', async () => {
    await assert.rejects(
      () => visitors.redeem(ctx(), passNumber, { employeeId: guardId }),
      /already been used or has expired/,
    );
  });

  await t.test('two guards scanning at once admit the holder once', async () => {
    const log = await visitors.recordEntry(ctx(), {
      firstName: 'Race', lastName: 'Pass', mobileNumber: '9777700008',
      visitorType: 'GUEST', unitIds: [unitB._id],
    }, {});
    const pass = await visitors.issuePass(ctx(), log._id, {}, null);

    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => visitors.redeem(
      ctx(), pass.passNumber, { employeeId: guardId },
    )));
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((a) => a.status === 'rejected').length, 4);
  });

  await t.test('an expired pass is refused', async () => {
    const log = await visitors.recordEntry(ctx(), {
      firstName: 'Late', lastName: 'Pass', mobileNumber: '9777700009',
      visitorType: 'GUEST', unitIds: [unitB._id],
    }, {});
    const pass = await visitors.issuePass(ctx(), log._id, {}, null);
    await SocietyVisitorPass.updateOne(
      { societyId: society._id, _id: pass._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    await assert.rejects(
      () => visitors.redeem(ctx(), pass.passNumber, {}),
      /already been used or has expired/,
    );
  });
});

/* --------------------------------- gate reads ------------------------------------ */

test('what the guard sees', async (t) => {
  const c = h.client();

  await t.test('who is inside right now', async () => {
    const res = await c.get('/api/v1/gatekeeper/stats', { headers: gateJson() });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.currentlyInside >= 1);
    assert.ok(res.data.result.entriesToday >= 1);
  });

  await t.test('the member directory, for calling up', async () => {
    const res = await c.get('/api/v1/gatekeeper/members?search=Alka', { headers: gateJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.members.length, 1);
    assert.equal(res.data.result.members[0].unitId.unitNumber, 'A-101');
  });

  await t.test('expected arrivals for today', async () => {
    await visitors.recordEntry(ctx(), {
      firstName: 'Expected', lastName: 'Guest', mobileNumber: '9777700010',
      visitorType: 'GUEST', unitIds: [unitB._id], expectedDate: new Date(),
    }, {});
    const res = await c.get('/api/v1/gatekeeper/expected', { headers: gateJson() });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.expected.length >= 1);
  });
});

/* -------------------------------- attendance -------------------------------------- */

test('staff attendance at the gate', async (t) => {
  const c = h.client();

  await t.test('a guard clocks in once', async () => {
    const res = await c.postJson('/api/v1/attendance/clock-in', {}, { headers: gate() });
    assert.equal(res.status, 201);
    assert.equal(res.data.result.status, 'IN');

    const again = await c.postJson('/api/v1/attendance/clock-in', {}, { headers: gate() });
    assert.equal(again.status, 400, 'an open row already means on site');
  });

  await t.test('status reports them on site', async () => {
    const res = await c.get('/api/v1/attendance/status', { headers: gateJson() });
    assert.equal(res.data.result.onSite, true);
    assert.ok(res.data.result.since);
  });

  await t.test('clocking out closes the row and totals the shift', async () => {
    const res = await put('/api/v1/attendance/clock-out', {}, gate());
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'EXIT');
    assert.ok(res.data.result.totalSeconds >= 0);

    const after = await c.get('/api/v1/attendance/status', { headers: gateJson() });
    assert.equal(after.data.result.onSite, false);
  });

  await t.test('clocking out twice is refused', async () => {
    const res = await put('/api/v1/attendance/clock-out', {}, gate());
    assert.equal(res.status, 400);
  });

  await t.test('the monthly report counts the shift', async () => {
    const res = await c.get('/api/v1/attendance/monthly-report', { headers: adminJson() });
    assert.equal(res.status, 200);
    const row = res.data.result.employees.find((e) => String(e.employeeId) === String(guardId));
    assert.ok(row, 'the guard appears in the report');
    assert.equal(row.daysPresent, 1);
  });

  await t.test('an open shift contributes no hours yet', async () => {
    await SocietyEmployeeAttendance.create({
      societyId: society._id, employeeId: guardId, clockInTime: new Date(), status: 'IN',
    });
    const res = await c.get('/api/v1/attendance/monthly-report', { headers: adminJson() });
    const row = res.data.result.employees.find((e) => String(e.employeeId) === String(guardId));
    assert.ok(Number.isFinite(row.totalHours), 'still a number, not a partial guess');
  });
});
