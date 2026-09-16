const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyComplaint, SocietyComplaintHistory, SocietyEmployee,
  SocietyEmployeeType, SocietyEmployeeAssignment, SocietyNotification,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');

/**
 * Phase 5: complaints, their history and their notifications.
 *
 * The property under test is that the timeline is complete — every state change
 * on every surface leaves a history row. The source changed status in five
 * controllers and logged it in three, so a complaint's history depended on
 * which screen moved it.
 */

let base;
let society;
let adminToken;
let residentToken;
let otherToken;
let unitA;
let unitB;
let typeId;
let employeeId;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const res1 = () => ({ Authorization: `Bearer ${residentToken}` });
const res1Json = () => ({ ...res1(), accept: 'application/json' });
const res2 = () => ({ Authorization: `Bearer ${otherToken}` });

const send = (method) => (path, body, headers) => fetch(`${base}${path}`, {
  method,
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const put = send('PUT');
const patch = send('PATCH');
const del = send('DELETE');

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const role = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });
  await SocietyRole.create({
    key: 'super_admin', name: 'Super', displayName: 'Super', level: 1, scope: 'global', permissions: ['*:*'],
  });

  society = await Society.create({
    societyName: 'Complaint Test', societyCode: 'SOC-CM-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9200000001', email: 'chair@cm.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  const chairUser = await SocietyUser.create({ mobileNumber: '9200000001', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9200000001', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman', fullName: 'Chair Person',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  unitA = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-CM-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-101',
  });
  unitB = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-CM-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-102',
  });

  const r1 = await SocietyUser.create({
    mobileNumber: '9211100001', countryCode: '+91', firstName: 'Sunil', societyId: society._id, fcmToken: 'tok-1',
  });
  const r2 = await SocietyUser.create({
    mobileNumber: '9211100002', countryCode: '+91', firstName: 'Priya', societyId: society._id,
  });
  residentToken = jwtLib.sign('user', { id: r1._id });
  otherToken = jwtLib.sign('user', { id: r2._id });

  await occupancy.assign({
    societyId: society._id, unitId: unitA._id, userId: r1._id, residentType: 'Owner',
    person: { firstName: 'Sunil', lastName: 'Verma', mobileNumber: '9211100001' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitB._id, userId: r2._id, residentType: 'Owner',
    person: { firstName: 'Priya', lastName: 'Nair', mobileNumber: '9211100002' },
  });

  const empType = await SocietyEmployeeType.create({ societyId: society._id, typeName: 'Technician' });
  const employee = await SocietyEmployee.create({ employeeName: 'Ramesh', mobileNumber: '9233300001' });
  employeeId = employee._id;
  await SocietyEmployeeAssignment.create({
    societyId: society._id, employeeId: employee._id, employeeTypeId: empType._id, dateOfJoining: new Date(),
  });
});

test.after(async () => { await h.stopServer(); });

/* --------------------------------- types ----------------------------------- */

test('complaint types', async (t) => {
  const c = h.client();

  await t.test('a type is created', async () => {
    const res = await c.postJson('/api/v1/society-admin/complaints/type/create', {
      typeName: 'Plumbing',
    }, { headers: admin() });
    assert.equal(res.status, 201);
    typeId = res.data.result._id;
  });

  await t.test('route ordering: /type/getAll is not read as an id', async () => {
    const res = await c.get('/api/v1/society-admin/complaints/type/getAll', { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.complaintTypes.length, 1);
  });

  await t.test('a deleted type frees its name for reuse', async () => {
    const made = await c.postJson('/api/v1/society-admin/complaints/type/create', {
      typeName: 'Temporary',
    }, { headers: admin() });
    await del(`/api/v1/society-admin/complaints/type/delete/${made.data.result._id}`, undefined, admin());

    const again = await c.postJson('/api/v1/society-admin/complaints/type/create', {
      typeName: 'Temporary',
    }, { headers: admin() });
    assert.equal(again.status, 201, 'the partial unique index must not burn the name');
  });
});

/* ------------------------------ reference ids ------------------------------- */

test('complaint ids are minted atomically', async () => {
  /**
   * The source read the latest complaint and added one, so two filed in the
   * same second collided on the unique index. `SocietyCounter` is a single
   * atomic `$inc`.
   */
  const c = h.client();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => c.postJson(
    '/api/v1/society-admin/complaints',
    {
      complaintTypeId: typeId,
      title: `Concurrent complaint ${i}`,
      description: 'Filed at the same instant as eleven others.',
      unitId: String(unitA._id),
    },
    { headers: admin() },
  )));

  assert.ok(results.every((r) => r.status === 201), 'all twelve must be accepted');
  const ids = results.map((r) => r.data.result.complaintId);
  assert.equal(new Set(ids).size, 12, 'and each must get a distinct reference');
  for (const id of ids) assert.match(id, /^CM-\d{3,}$/);
});

/* ------------------------------- the timeline -------------------------------- */

test('every state change leaves a history row', async (t) => {
  const c = h.client();
  let complaintId;

  await t.test('creating one opens the timeline', async () => {
    const res = await c.postJson('/api/v1/society-admin/complaints', {
      complaintTypeId: typeId, title: 'Tap leaking in the kitchen',
      description: 'Constant drip since Tuesday.', unitId: String(unitA._id), priority: 'High',
    }, { headers: admin() });
    assert.equal(res.status, 201);
    complaintId = res.data.result._id;

    const rows = await SocietyComplaintHistory.find({ societyId: society._id, complaintId }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'CREATED');
    assert.equal(rows[0].newStatus, 'Open');
  });

  await t.test('assigning logs who and when', async () => {
    const res = await put(`/api/v1/society-admin/complaints/${complaintId}`,
      { assignedTo: String(employeeId), comment: 'Sending Ramesh today.' }, admin());
    assert.equal(res.status, 200);
    assert.equal(String(res.data.result.assignedTo), String(employeeId));

    const latest = await SocietyComplaintHistory.findOne({ societyId: society._id, complaintId })
      .sort({ createdAt: -1 }).lean();
    assert.equal(latest.action, 'ASSIGNED');
    assert.equal(latest.changedByRole, 'SocietyAdmin');
  });

  await t.test('a status change records both sides', async () => {
    const res = await patch(`/api/v1/society-admin/complaints/${complaintId}/status`,
      { status: 'In Progress' }, admin());
    assert.equal(res.status, 200);

    const latest = await SocietyComplaintHistory.findOne({ societyId: society._id, complaintId })
      .sort({ createdAt: -1 }).lean();
    assert.equal(latest.action, 'STATUS_CHANGED');
    assert.equal(latest.previousStatus, 'Open');
    assert.equal(latest.newStatus, 'In Progress');
  });

  await t.test('closing stamps the closure', async () => {
    const res = await patch(`/api/v1/society-admin/complaints/${complaintId}/status`,
      { status: 'Close', resolutionNotes: 'Washer replaced.' }, admin());
    assert.equal(res.status, 200);
    assert.ok(res.data.result.closedAt);
    assert.equal(res.data.result.resolution.notes, 'Washer replaced.');
  });

  await t.test('closing an already-closed complaint is refused', async () => {
    const res = await patch(`/api/v1/society-admin/complaints/${complaintId}/status`,
      { status: 'Close' }, admin());
    assert.equal(res.status, 409);
  });

  await t.test('reopening clears the closure', async () => {
    const res = await patch(`/api/v1/society-admin/complaints/${complaintId}/status`,
      { status: 'Reopen', comment: 'Dripping again.' }, admin());
    assert.equal(res.status, 200);
    assert.equal(res.data.result.closedAt, null, 'a reopened complaint must not read as closed');

    const latest = await SocietyComplaintHistory.findOne({ societyId: society._id, complaintId })
      .sort({ createdAt: -1 }).lean();
    assert.equal(latest.action, 'REOPENED');
  });

  await t.test('the whole timeline reads back in order', async () => {
    const res = await c.get(`/api/v1/society-admin/complaints/${complaintId}`, { headers: adminJson() });
    const actions = res.data.result.history.map((x) => x.action);
    assert.deepEqual(actions, ['REOPENED', 'STATUS_CHANGED', 'STATUS_CHANGED', 'ASSIGNED', 'CREATED'],
      'newest first, nothing missing');
  });

  await t.test('a legacy status change lands in the SAME history', async () => {
    // The bug this guards: the admin panel and the app wrote to collections
    // whose names differed only in case, so neither could read the other.
    const before = await SocietyComplaintHistory.countDocuments({ societyId: society._id, complaintId });

    await put(`/api/v1/complaints/${complaintId}/status?societyId=${society._id}`,
      { status: 'On Hold', comment: 'Waiting for a part.' }, admin());

    const after = await SocietyComplaintHistory.countDocuments({ societyId: society._id, complaintId });
    assert.equal(after, before + 1, 'one collection, whichever surface wrote it');

    const collections = await SocietyComplaintHistory.db.db.listCollections().toArray();
    const historyCollections = collections
      .map((x) => x.name)
      .filter((n) => n.toLowerCase().includes('complainthistor'));
    assert.equal(historyCollections.length, 1, 'there must be exactly one history collection');
  });
});

/* ------------------------------ notifications -------------------------------- */

test('the resident is told when their complaint moves', async (t) => {
  const c = h.client();
  let complaintId;

  await t.before(async () => {
    const res = await c.postJson('/api/v1/society-admin/complaints', {
      complaintTypeId: typeId, title: 'Lift making a noise',
      description: 'Grinding sound between floors 3 and 4.', unitId: String(unitA._id),
    }, { headers: admin() });
    complaintId = res.data.result._id;
    await SocietyNotification.deleteMany({ societyId: society._id });
  });

  await t.test('a status change notifies the household', async () => {
    await patch(`/api/v1/society-admin/complaints/${complaintId}/status`,
      { status: 'In Progress' }, admin());

    const notes = await SocietyNotification.find({
      societyId: society._id, type: 'COMPLAINT', referenceId: complaintId,
    }).lean();
    assert.equal(notes.length, 1, 'the one resident of A-101');
    assert.match(notes[0].title, /is now In Progress/);
    assert.equal(notes[0].status, 'UNREAD');
  });

  await t.test('a change with no status move does not notify', async () => {
    await SocietyNotification.deleteMany({ societyId: society._id });
    await put(`/api/v1/society-admin/complaints/${complaintId}`, { priority: 'Urgent' }, admin());

    assert.equal(await SocietyNotification.countDocuments({ societyId: society._id }), 0,
      'editing the priority is not news');
  });
});

/* ------------------------------ resident scope -------------------------------- */

test('a resident sees and edits only their own', async (t) => {
  const c = h.client();
  let mine;
  let theirs;

  await t.before(async () => {
    const a = await c.postJson(`/api/v1/app/complaints/create?societyId=${society._id}`, {
      complaintTypeId: typeId, title: 'My own complaint', description: 'Raised from the app.',
    }, { headers: res1() });
    mine = a.data.result._id;

    const b = await c.postJson(`/api/v1/app/complaints/create?societyId=${society._id}`, {
      complaintTypeId: typeId, title: 'Their complaint', description: 'Raised by the neighbour.',
    }, { headers: res2() });
    theirs = b.data.result._id;
  });

  await t.test('a resident complaint is filed against their own unit', async () => {
    const row = await SocietyComplaint.findById(mine).lean();
    assert.equal(String(row.unitId), String(unitA._id), 'resolved from their occupancy, not the request');
    assert.equal(row.createdByRole, 'MEMBER');
  });

  await t.test('getMyComplaints returns only their household', async () => {
    const res = await c.get(`/api/v1/app/complaints/getMyComplaints?societyId=${society._id}`, {
      headers: res1Json(),
    });
    assert.equal(res.status, 200);
    const titles = res.data.result.complaints.map((x) => x.title);
    assert.ok(titles.includes('My own complaint'));
    assert.ok(!titles.includes('Their complaint'), 'the neighbour is not their business');
  });

  await t.test('they cannot edit the neighbour complaint', async () => {
    const res = await put(`/api/v1/app/complaints/${theirs}?societyId=${society._id}`,
      { title: 'Hacked' }, res1());
    assert.equal(res.status, 404);

    const row = await SocietyComplaint.findById(theirs).lean();
    assert.equal(row.title, 'Their complaint');
  });

  await t.test('they cannot delete it either', async () => {
    const res = await del(`/api/v1/app/complaints/${theirs}?societyId=${society._id}`, undefined, res1());
    assert.equal(res.status, 404);
    assert.equal((await SocietyComplaint.findById(theirs).lean()).isDeleted, false);
  });

  await t.test('a resident cannot change status through the edit route', async () => {
    // Only the admin surface may move a complaint's state.
    await put(`/api/v1/app/complaints/${mine}?societyId=${society._id}`,
      { status: 'Close', title: 'My own complaint, edited' }, res1());

    const row = await SocietyComplaint.findById(mine).lean();
    assert.equal(row.status, 'Open', 'the status field is not editable by the resident');
    assert.equal(row.title, 'My own complaint, edited', 'but the allowed fields are');
  });

  await t.test('a closed complaint can no longer be edited by the resident', async () => {
    await patch(`/api/v1/society-admin/complaints/${mine}/status`, { status: 'Close' }, admin());
    const res = await put(`/api/v1/app/complaints/${mine}?societyId=${society._id}`,
      { title: 'Too late' }, res1());
    assert.equal(res.status, 400);
  });

  await t.test('their stats count only their own', async () => {
    const res = await c.get(`/api/v1/app/complaints/stats?societyId=${society._id}`, {
      headers: res1Json(),
    });
    assert.equal(res.status, 200);
    const all = await c.get('/api/v1/society-admin/complaints/stats', { headers: adminJson() });
    assert.ok(res.data.result.total < all.data.result.total,
      'a resident total must be smaller than the society total');
  });
});

/* --------------------------------- legacy ----------------------------------- */

test('the legacy complaint surface', async (t) => {
  const c = h.client();
  let complaintId;

  await t.before(async () => {
    const res = await c.postJson('/api/v1/society-admin/complaints', {
      complaintTypeId: typeId, title: 'Legacy path', description: 'Filed for the façade tests.',
      unitId: String(unitB._id),
    }, { headers: admin() });
    complaintId = res.data.result._id;
  });

  await t.test('assign, resolve and comment all route through the same service', async () => {
    const assigned = await put(`/api/v1/complaints/${complaintId}/assign?societyId=${society._id}`,
      { assignedTo: String(employeeId) }, admin());
    assert.equal(assigned.status, 200);

    const commented = await c.postJson(
      `/api/v1/complaints/${complaintId}/comments?societyId=${society._id}`,
      { comment: 'Technician scheduled for Friday.' }, { headers: admin() },
    );
    assert.equal(commented.status, 201);

    const resolved = await put(`/api/v1/complaints/${complaintId}/resolve?societyId=${society._id}`,
      { resolutionNotes: 'Fixed on site.' }, admin());
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.result.status, 'Close');

    const actions = (await SocietyComplaintHistory.find({ societyId: society._id, complaintId })
      .sort({ createdAt: 1 }).lean()).map((x) => x.action);
    assert.deepEqual(actions, ['CREATED', 'ASSIGNED', 'COMMENT_ADDED', 'STATUS_CHANGED']);
  });

  await t.test('the units dropdown lists only units with complaints', async () => {
    const res = await c.get(`/api/v1/complaints/units/dropdown?societyId=${society._id}`, {
      headers: adminJson(),
    });
    assert.equal(res.status, 200);
    const numbers = res.data.result.units.map((u) => u.unitNumber).sort();
    assert.deepEqual(numbers, ['A-101', 'A-102']);
  });

  await t.test('societyId is required', async () => {
    const res = await c.get('/api/v1/complaints', {
      headers: { Authorization: `Bearer ${adminToken}`, accept: 'application/json' },
    });
    assert.equal(res.status, 400);
  });
});
