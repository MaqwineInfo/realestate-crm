const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyParking, SocietyParkingAllocation, SocietyVehicle,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');
const parking = require('../../src/services/society/parking');

/**
 * Phase 8: parking levels, slots, allocation and vehicles.
 *
 * The property worth proving is that a slot has at most one holder under
 * concurrency. Every transition is a conditional update naming the status it
 * expects, so the database arbitrates rather than a read-then-write.
 */

let base;
let society;
let adminToken;
let superToken;
let resAToken;
let resBToken;
let unitA;
let unitB;
let levelId;
let slotIds = [];

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const superAuth = () => ({ Authorization: `Bearer ${superToken}` });
const asRes = (t) => ({ Authorization: `Bearer ${t}` });
const resJson = (t) => ({ ...asRes(t), accept: 'application/json' });

const call = (m) => (path, body, headers) => fetch(`${base}${path}`, {
  method: m,
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const put = call('PUT');
const del = call('DELETE');

const ctx = () => ({ societyId: society._id });

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const role = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });
  const superRole = await SocietyRole.create({
    key: 'super_admin', name: 'Super', displayName: 'Super', level: 1, scope: 'global', permissions: ['*:*'],
  });

  society = await Society.create({
    societyName: 'Parking Test', societyCode: 'SOC-PK-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9000000701', email: 'chair@pk.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  const chairUser = await SocietyUser.create({ mobileNumber: '9000000701', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9000000701', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  const superUser = await SocietyUser.create({ mobileNumber: '9000000799', countryCode: '+91' });
  const superAdmin = await SocietyAdmin.create({
    phoneNumber: '9000000799', countryCode: '+91', userId: superUser._id,
    roleId: superRole._id, role: 'SuperAdmin',
  });
  superToken = jwtLib.sign('admin', { id: superUser._id, adminId: superAdmin._id, role: 'SuperAdmin' });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  unitA = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-PK-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-101',
  });
  unitB = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-PK-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-102',
  });

  const rA = await SocietyUser.create({
    mobileNumber: '9011100701', countryCode: '+91', firstName: 'Anil', societyId: society._id,
  });
  const rB = await SocietyUser.create({
    mobileNumber: '9011100702', countryCode: '+91', firstName: 'Bela', societyId: society._id,
  });
  resAToken = jwtLib.sign('user', { id: rA._id });
  resBToken = jwtLib.sign('user', { id: rB._id });

  await occupancy.assign({
    societyId: society._id, unitId: unitA._id, userId: rA._id, residentType: 'Owner',
    person: { firstName: 'Anil', lastName: 'Shah', mobileNumber: '9011100701' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitB._id, userId: rB._id, residentType: 'Owner',
    person: { firstName: 'Bela', lastName: 'Rao', mobileNumber: '9011100702' },
  });
});

test.after(async () => { await h.stopServer(); });

/* -------------------------------- structure ---------------------------------- */

test('levels and slots', async (t) => {
  const c = h.client();

  await t.test('a level is created', async () => {
    const res = await c.postJson(`${'/api/v1/society-admin/parking'}/levels`, {
      levelName: 'Basement 1', levelType: 'Basement', levelNumber: -1, capacity: 20,
    }, { headers: admin() });
    assert.equal(res.status, 201);
    levelId = res.data.result._id;
  });

  await t.test('a duplicate level name is refused', async () => {
    const res = await c.postJson('/api/v1/society-admin/parking/levels', {
      levelName: 'Basement 1',
    }, { headers: admin() });
    assert.equal(res.status, 409);
  });

  await t.test('adding a run of slots is idempotent', async () => {
    const first = await parking.levels.addSlots(ctx(), levelId, { from: 1, to: 5 }, null);
    assert.equal(first.inserted, 5);

    const overlap = await parking.levels.addSlots(ctx(), levelId, { from: 4, to: 8 }, null);
    assert.equal(overlap.inserted, 3, 'slots 6-8 only');
    assert.equal(overlap.skipped, 2, 'slots 4-5 already existed');

    const rows = await SocietyParking.find({ societyId: society._id, parkingLevelId: levelId })
      .sort({ slotNumber: 1 }).lean();
    assert.equal(rows.length, 8);
    slotIds = rows.map((r) => r._id);
  });

  await t.test('the grid reports availability per level', async () => {
    const res = await c.get('/api/v1/society-admin/parking/spot/grid', { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.totals.total, 8);
    assert.equal(res.data.result.totals.available, 8);
    assert.equal(res.data.result.levels[0].counts.available, 8);
  });
});

/* ------------------------------- the request flow ------------------------------ */

test('request, approve, release', async (t) => {
  const c = h.client();
  const slot = () => String(slotIds[0]);

  await t.test('a resident requests a free slot', async () => {
    const res = await c.postJson(
      `/api/v1/app/parkings/${slot()}/request?societyId=${society._id}`, {}, { headers: asRes(resAToken) },
    );
    assert.equal(res.status, 201);
    assert.equal(res.data.result.status, 'PENDING_REQUEST');
  });

  await t.test('a second resident cannot request the same slot', async () => {
    const res = await c.postJson(
      `/api/v1/app/parkings/${slot()}/request?societyId=${society._id}`, {}, { headers: asRes(resBToken) },
    );
    assert.equal(res.status, 409);
  });

  await t.test('the request appears in the admin queue', async () => {
    const res = await c.get('/api/v1/society-admin/parking/requests', { headers: adminJson() });
    assert.equal(res.data.result.requests.length, 1);
  });

  await t.test('approving allocates it to the requester unit', async () => {
    const res = await c.postJson(
      `/api/v1/society-admin/parking/spot/${slot()}/process`, { approve: true }, { headers: admin() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'ALLOCATED');
    assert.equal(String(res.data.result.unitId), String(unitA._id),
      'resolved from who asked, not from the request body');
  });

  await t.test('the audit trail records both steps', async () => {
    const rows = await SocietyParkingAllocation.find({
      societyId: society._id, slotId: slotIds[0],
    }).sort({ createdAt: 1 }).lean();
    assert.deepEqual(rows.map((r) => r.action), ['REQUESTED', 'REQUEST_APPROVED']);
    assert.equal(rows[1].slotNumber, 1, 'the location is denormalised so history survives renaming');
    assert.match(rows[1].locationAssigned, /Basement 1/);
  });

  await t.test('it shows in the resident own parkings', async () => {
    const res = await c.get(`/api/v1/app/parkings/my-parkings?societyId=${society._id}`, {
      headers: resJson(resAToken),
    });
    assert.equal(res.data.result.slots.length, 1);
    assert.equal(res.data.result.slots[0].parkingLevelId.levelName, 'Basement 1');
  });

  await t.test('another resident cannot release it', async () => {
    const res = await c.postJson(
      `/api/v1/app/parkings/${slot()}/release?societyId=${society._id}`, {}, { headers: asRes(resBToken) },
    );
    assert.equal(res.status, 404, 'not their slot, and its existence is not their business');

    const still = await SocietyParking.findById(slotIds[0]).lean();
    assert.equal(still.status, 'ALLOCATED');
  });

  await t.test('the holder can release it, and the trail closes', async () => {
    const res = await c.postJson(
      `/api/v1/app/parkings/${slot()}/release?societyId=${society._id}`, {}, { headers: asRes(resAToken) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'AVAILABLE');
    assert.equal(res.data.result.unitId, null);

    const open = await SocietyParkingAllocation.countDocuments({
      societyId: society._id, slotId: slotIds[0], actualEndTime: null, action: { $ne: 'DEALLOCATED' },
    });
    assert.equal(open, 0, 'no allocation is left hanging open');
  });

  await t.test('rejecting a request frees the slot', async () => {
    await c.postJson(
      `/api/v1/app/parkings/${slot()}/request?societyId=${society._id}`, {}, { headers: asRes(resBToken) },
    );
    const res = await c.postJson(
      `/api/v1/society-admin/parking/spot/${slot()}/process`, { approve: false }, { headers: admin() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'AVAILABLE');

    const trail = await SocietyParkingAllocation.findOne({
      societyId: society._id, slotId: slotIds[0], action: 'REQUEST_REJECTED',
    }).lean();
    assert.ok(trail);
  });
});

/* --------------------------------- the race ----------------------------------- */

test('ten residents requesting the last slot', async () => {
  /**
   * The reason every transition names its expected status. A read-then-write
   * lets all ten pass the availability check; a conditional update lets exactly
   * one row change.
   */
  const c = h.client();
  const contested = String(slotIds[7]);

  const attempts = await Promise.all(Array.from({ length: 10 }, () => c.postJson(
    `/api/v1/app/parkings/${contested}/request?societyId=${society._id}`,
    {}, { headers: asRes(resAToken) },
  )));

  const won = attempts.filter((r) => r.status === 201);
  const lost = attempts.filter((r) => r.status === 409);
  assert.equal(won.length, 1, 'exactly one request may be created');
  assert.equal(lost.length, 9);

  const slot = await SocietyParking.findById(slotIds[7]).lean();
  assert.equal(slot.status, 'PENDING_REQUEST');

  const requested = await SocietyParkingAllocation.countDocuments({
    societyId: society._id, slotId: slotIds[7], action: 'REQUESTED',
  });
  assert.equal(requested, 1, 'and the trail records one request, not ten');
});

test('two admins allocating the same slot simultaneously', async () => {
  const c = h.client();
  const contested = String(slotIds[6]);

  const attempts = await Promise.all([
    c.postJson(`/api/v1/parking/allocations?societyId=${society._id}`,
      { slotId: contested, unitId: String(unitA._id) }, { headers: superAuth() }),
    c.postJson(`/api/v1/parking/allocations?societyId=${society._id}`,
      { slotId: contested, unitId: String(unitB._id) }, { headers: superAuth() }),
  ]);

  assert.equal(attempts.filter((r) => r.status === 201).length, 1);
  assert.equal(attempts.filter((r) => r.status === 409).length, 1);

  const slot = await SocietyParking.findById(slotIds[6]).lean();
  assert.equal(slot.status, 'ALLOCATED');
  assert.ok(slot.unitId, 'exactly one unit holds it');
});

/* --------------------------------- vehicles ------------------------------------ */

test('vehicles', async (t) => {
  const c = h.client();
  let vehicleId;

  await t.test('a resident registers a vehicle against their own unit', async () => {
    const res = await c.postJson(`/api/v1/app/vehicles?societyId=${society._id}`, {
      vehicleNumber: 'gj01ab1234', vehicleType: 'Car', vehicleName: 'Swift',
    }, { headers: asRes(resAToken) });
    assert.equal(res.status, 201);
    vehicleId = res.data.result._id;

    assert.equal(res.data.result.vehicleNumber, 'GJ01AB1234', 'plates are stored uppercase');
    assert.equal(String(res.data.result.unitId), String(unitA._id),
      'resolved from their occupancy, not the request');
  });

  await t.test('the same plate cannot be registered twice', async () => {
    const res = await c.postJson(`/api/v1/app/vehicles?societyId=${society._id}`, {
      vehicleNumber: 'GJ01AB1234', vehicleType: 'Car',
    }, { headers: asRes(resBToken) });
    assert.equal(res.status, 409);
  });

  await t.test('another resident cannot read or edit it', async () => {
    const read = await c.get(`/api/v1/app/vehicles/${vehicleId}?societyId=${society._id}`, {
      headers: resJson(resBToken),
    });
    assert.equal(read.status, 404);

    const write = await put(`/api/v1/app/vehicles/${vehicleId}?societyId=${society._id}`,
      { vehicleName: 'Hacked' }, asRes(resBToken));
    assert.equal(write.status, 404);

    const row = await SocietyVehicle.findById(vehicleId).lean();
    assert.equal(row.vehicleName, 'Swift');
  });

  await t.test('the owner can edit and remove their own', async () => {
    const up = await put(`/api/v1/app/vehicles/${vehicleId}?societyId=${society._id}`,
      { vehicleName: 'Baleno' }, asRes(resAToken));
    assert.equal(up.status, 200);
    assert.equal(up.data.result.vehicleName, 'Baleno');

    const gone = await del(`/api/v1/app/vehicles/${vehicleId}?societyId=${society._id}`,
      undefined, asRes(resAToken));
    assert.equal(gone.status, 200);
    assert.equal((await SocietyVehicle.findById(vehicleId).lean()).isDeleted, true);
  });

  await t.test('a deleted plate can be registered again', async () => {
    const res = await c.postJson(`/api/v1/app/vehicles?societyId=${society._id}`, {
      vehicleNumber: 'GJ01AB1234', vehicleType: 'Car',
    }, { headers: asRes(resBToken) });
    assert.equal(res.status, 201, 'the unique index is partial on isDeleted');
  });
});

/* --------------------------------- protection ---------------------------------- */

test('a level with allocated slots cannot be deleted', async () => {
  const res = await del('/api/v1/society-admin/parking/levels/' + levelId, undefined, admin());
  assert.equal(res.status, 409);

  assert.ok(await SocietyParking.countDocuments({
    societyId: society._id, parkingLevelId: levelId, isDeleted: false,
  }) > 0, 'and its slots survive');
});

/* ----------------------------------- legacy ------------------------------------- */

test('the legacy parking surface reads the canonical models', async (t) => {
  const c = h.client();

  await t.test('slots and levels come from the same rows', async () => {
    const legacy = await c.get(`/api/v1/parking/slots?societyId=${society._id}`, {
      headers: { Authorization: `Bearer ${adminToken}`, accept: 'application/json' },
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.result.pagination.total, 8);
  });

  await t.test('tracking shows what is parked where', async () => {
    const res = await c.get(`/api/v1/parking/tracking?societyId=${society._id}`, {
      headers: { Authorization: `Bearer ${adminToken}`, accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.parked.length >= 1);
    assert.ok(res.data.result.parked[0].slotNumber);
  });

  await t.test('releasing by allocation id releases the slot', async () => {
    const allocation = await SocietyParkingAllocation.findOne({
      societyId: society._id, slotId: slotIds[6], action: 'ALLOCATED',
    }).lean();
    assert.ok(allocation);

    const res = await put(
      `/api/v1/parking/allocations/${allocation._id}/release?societyId=${society._id}`,
      {}, superAuth(),
    );
    assert.equal(res.status, 200);
    assert.equal((await SocietyParking.findById(slotIds[6]).lean()).status, 'AVAILABLE');
  });

  await t.test('societyId is required', async () => {
    const res = await c.get('/api/v1/parking/slots', {
      headers: { Authorization: `Bearer ${adminToken}`, accept: 'application/json' },
    });
    assert.equal(res.status, 400);
  });
});
