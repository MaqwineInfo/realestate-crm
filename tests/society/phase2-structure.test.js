const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyUnitOccupancy, SocietyEmployeeType, SocietyEmployee,
  SocietyEmployeeAssignment, SocietyResidentOnboardingRequest, SocietyMember,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');

/**
 * Phase 2: blocks, floors, units, occupancy, staff and onboarding — over HTTP.
 *
 * The occupancy rules get the most attention, because the source implemented
 * them twice (admin assign vs onboarding approve) and they disagreed. These
 * assert that both routes now land on the same behaviour.
 */

let base;
let society;
let token;      // chairman: the /society-admin surface
let superToken; // platform super admin: the legacy write endpoints require it

const auth = () => ({ Authorization: `Bearer ${token}`, 'x-society-id': String(society._id) });
const json = () => ({ ...auth(), accept: 'application/json' });
/**
 * The legacy structure writes are gated on `superAdminVerifyToken` in the
 * source, so the façade keeps that. Reads accept any admin.
 */
const superAuth = () => ({ Authorization: `Bearer ${superToken}` });

const put = (path, body) => fetch(`${base}${path}`, {
  method: 'PUT', headers: { ...json(), 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const del = (path) => fetch(`${base}${path}`, { method: 'DELETE', headers: json() })
  .then(async (r) => ({ status: r.status, data: await r.json() }));

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const role = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });
  society = await Society.create({
    societyName: 'Structure Test', societyCode: 'SOC-ST-001', projectType: 'Residential',
    totalBlocks: 2, totalFloors: 2, totalUnits: 2,
    contactPersonName: 'Chair', contactNumber: '9500000001', email: 'chair@st.test',
    address: { street: '1 St', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  const user = await SocietyUser.create({ mobileNumber: '9500000001', countryCode: '+91' });
  const admin = await SocietyAdmin.create({
    phoneNumber: '9500000001', countryCode: '+91', userId: user._id,
    societyId: society._id, roleId: role._id, role: 'Chairman',
  });
  token = jwtLib.sign('admin', { id: user._id, adminId: admin._id, role: 'Chairman' });

  const superRole = await SocietyRole.create({
    key: 'super_admin', name: 'Super Admin', displayName: 'Super Admin',
    level: 1, scope: 'global', permissions: ['*:*'], isSystem: true,
  });
  const superUser = await SocietyUser.create({ mobileNumber: '9500000099', countryCode: '+91' });
  const superAdmin = await SocietyAdmin.create({
    phoneNumber: '9500000099', countryCode: '+91', userId: superUser._id,
    roleId: superRole._id, role: 'SuperAdmin',
  });
  superToken = jwtLib.sign('admin', { id: superUser._id, adminId: superAdmin._id, role: 'SuperAdmin' });
});

test.after(async () => { await h.stopServer(); });

/* ------------------------------- the pin ---------------------------------- */

test('x-society-id is enforced, not trusted', async (t) => {
  const c = h.client();

  await t.test('a missing header is a 400, not a silent all-societies read', async () => {
    const res = await c.get('/api/v1/society-admin/society/blocks', {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    assert.equal(res.status, 400);
  });

  await t.test('a society the admin does not run is refused', async () => {
    const other = await Society.create({
      societyName: 'Not Mine', societyCode: 'SOC-ST-999', projectType: 'Residential',
      contactPersonName: 'X', contactNumber: '9500009999', email: 'x@st.test',
      address: { street: 'a', city: 'b', state: 'c', pincode: '1' },
    });
    const res = await c.get('/api/v1/society-admin/society/blocks', {
      headers: { Authorization: `Bearer ${token}`, 'x-society-id': String(other._id), accept: 'application/json' },
    });
    assert.equal(res.status, 401);
  });
});

/* ------------------------------- structure -------------------------------- */

test('blocks, floors and units', async (t) => {
  const c = h.client();
  let blockId;
  let floorId;

  await t.test('a block gets its order number assigned', async () => {
    const a = await c.postJson('/api/v1/society-admin/society/blocks', { blockName: 'Block A' }, { headers: auth() });
    assert.equal(a.status, 201);
    assert.equal(a.data.result.orderNo, 1);
    blockId = a.data.result._id;

    const b = await c.postJson('/api/v1/society-admin/society/blocks', { blockName: 'Block B' }, { headers: auth() });
    assert.equal(b.data.result.orderNo, 2, 'the next block follows the last, without being told');
  });

  await t.test('a duplicate block name is refused', async () => {
    const res = await c.postJson('/api/v1/society-admin/society/blocks', { blockName: 'Block A' }, { headers: auth() });
    assert.equal(res.status, 409);
  });

  await t.test('bulk floor creation is idempotent', async () => {
    const first = await c.postJson('/api/v1/society-admin/society/floors/bulk', {
      blockId, from: 1, to: 5, unitsPerFloor: 2,
    }, { headers: auth() });
    assert.equal(first.data.result.inserted, 5);

    // Re-running an overlapping range must add only what is missing.
    const again = await c.postJson('/api/v1/society-admin/society/floors/bulk', {
      blockId, from: 3, to: 8, unitsPerFloor: 2,
    }, { headers: auth() });
    assert.equal(again.data.result.inserted, 3, 'floors 6-8 only');
    assert.equal(again.data.result.skipped, 3, 'floors 3-5 already existed');

    assert.equal(await SocietyFloor.countDocuments({ societyId: society._id, blockId, isDeleted: false }), 8);
  });

  await t.test('a unit inherits its block and floor labels', async () => {
    const floor = await SocietyFloor.findOne({ societyId: society._id, blockId, floorNumber: 1 }).lean();
    floorId = floor._id;

    const res = await c.postJson('/api/v1/society-admin/society/units', {
      floorId: String(floorId), unitNumber: 'A-101',
    }, { headers: auth() });
    assert.equal(res.status, 201);
    assert.equal(res.data.result.blockNumber, 'Block A', 'derived, not taken from the request');
    assert.equal(res.data.result.floorNumber, 1);
    assert.equal(res.data.result.societyCode, 'SOC-ST-001');
  });

  await t.test('blocks-with-floors nests in one call', async () => {
    const res = await c.get('/api/v1/society-admin/society/blocks-with-floors', { headers: json() });
    const a = res.data.result.blocks.find((b) => b.blockName === 'Block A');
    assert.equal(a.floors.length, 8);
  });

  await t.test('route ordering: /units/dropdown is not read as an id', async () => {
    const res = await c.get('/api/v1/society-admin/society/units/dropdown', { headers: json() });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.result.units));
  });
});

/* ------------------------------- occupancy -------------------------------- */

test('occupancy rules hold on every route that writes them', async (t) => {
  const c = h.client();
  let unitId;

  await t.before(async () => {
    const unit = await SocietyUnit.findOne({ societyId: society._id, unitNumber: 'A-101' }).lean();
    unitId = unit._id;
  });

  await t.test('assigning an owner marks the unit occupied', async () => {
    const res = await c.postJson(
      `/api/v1/units/${unitId}/assign?societyId=${society._id}`,
      { residentType: 'Owner', firstName: 'Owner', lastName: 'One', mobileNumber: '9611100001' },
      { headers: superAuth() },
    );
    assert.equal(res.status, 200);

    const unit = await SocietyUnit.findById(unitId).lean();
    assert.equal(unit.occupancyStatus, 'OCCUPIED');
    assert.equal(unit.residentType, 'Owner');
    assert.ok(unit.currentOwnerId, 'the cached owner pointer is maintained by the service');
  });

  await t.test('a member profile is created for them', async () => {
    const member = await SocietyMember.findOne({ societyId: society._id, mobileNumber: '9611100001' }).lean();
    assert.ok(member, 'assigning a resident should give them a member profile');
  });

  await t.test('a SECOND owner is refused', async () => {
    // The legacy assign endpoint used to overwrite the previous owner silently.
    const res = await c.postJson(
      `/api/v1/units/${unitId}/assign?societyId=${society._id}`,
      { residentType: 'Owner', firstName: 'Owner', lastName: 'Two', mobileNumber: '9611100002' },
      { headers: superAuth() },
    );
    assert.equal(res.status, 409);
    assert.equal(await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId, residentType: 'Owner', isCurrent: true,
    }), 1);
  });

  await t.test('a tenant may live alongside the owner, and reads as the resident', async () => {
    const res = await c.postJson(
      `/api/v1/units/${unitId}/assign?societyId=${society._id}`,
      { residentType: 'Tenant', firstName: 'Tenant', lastName: 'One', mobileNumber: '9611100003' },
      { headers: superAuth() },
    );
    assert.equal(res.status, 200);

    const unit = await SocietyUnit.findById(unitId).lean();
    assert.equal(unit.residentType, 'Tenant', 'a tenant in residence is what the unit reads as');
    assert.ok(unit.currentOwnerId && unit.currentTenantId, 'both pointers stay set');
  });

  await t.test('a NEW tenant ends the previous tenancy instead of coexisting', async () => {
    await c.postJson(
      `/api/v1/units/${unitId}/assign?societyId=${society._id}`,
      { residentType: 'Tenant', firstName: 'Tenant', lastName: 'Two', mobileNumber: '9611100004' },
      { headers: superAuth() },
    );
    const current = await SocietyUnitOccupancy.find({
      societyId: society._id, unitId, residentType: 'Tenant', isCurrent: true,
    }).lean();
    assert.equal(current.length, 1, 'only one tenancy is current');
    assert.equal(current[0].lastName, 'Two');

    const ended = await SocietyUnitOccupancy.findOne({
      societyId: society._id, unitId, residentType: 'Tenant', isCurrent: false, lastName: 'One',
    }).lean();
    assert.ok(ended.endDate, 'the previous tenancy is closed, not deleted');
  });

  await t.test('a unit with residents cannot be deleted', async () => {
    const res = await del(`/api/v1/society-admin/society/units/${unitId}`);
    assert.equal(res.status, 409);
  });

  await t.test('unassign clears the unit and everyone in it', async () => {
    const res = await c.postJson(
      `/api/v1/units/${unitId}/unassign?societyId=${society._id}`, {}, { headers: superAuth() },
    );
    assert.equal(res.status, 200);

    const unit = await SocietyUnit.findById(unitId).lean();
    assert.equal(unit.occupancyStatus, 'VACANT');
    assert.equal(unit.residentType, 'Vacant');
    assert.equal(unit.currentOwnerId, null);
    assert.equal(await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId, isCurrent: true,
    }), 0);
    // History survives.
    assert.ok(await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId, isCurrent: false,
    }) >= 3);
  });

  await t.test('the update route cannot forge occupancy fields', async () => {
    const res = await put('/api/v1/society-admin/society/units', {
      unitId: String(unitId), occupancyStatus: 'OCCUPIED', residentType: 'Owner', direction: 'East',
    });
    assert.equal(res.status, 200);
    const unit = await SocietyUnit.findById(unitId).lean();
    assert.equal(unit.occupancyStatus, 'VACANT', 'occupancy is owned by the occupancy service alone');
    assert.equal(unit.direction, 'East', 'ordinary fields still update');
  });
});

/* ------------------------------- onboarding -------------------------------- */

test('resident onboarding goes through the same occupancy rules', async (t) => {
  const c = h.client();
  let unitId;
  let requestId;

  await t.before(async () => {
    const floor = await SocietyFloor.findOne({ societyId: society._id, floorNumber: 2 }).lean();
    const unit = await SocietyUnit.create({
      societyId: society._id, societyCode: 'SOC-ST-001', blockId: floor.blockId,
      floorId: floor._id, floorNumber: 2, unitNumber: 'A-201',
    });
    unitId = unit._id;

    const applicant = await SocietyUser.create({ mobileNumber: '9622200001', countryCode: '+91' });
    const req = await SocietyResidentOnboardingRequest.create({
      societyId: society._id, unitId, userId: applicant._id, residentType: 'Owner',
      firstName: 'Aarti', lastName: 'Mehta', mobileNumber: '9622200001',
      familyMembers: [{ firstName: 'Kabir', lastName: 'Mehta', relation: 'Son' }],
    });
    requestId = req._id;
  });

  await t.test('pending requests are listed', async () => {
    const res = await c.get('/api/v1/society-admin/society/resident-onboarding-requests?status=Pending', {
      headers: json(),
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.requests.some((r) => String(r._id) === String(requestId)));
  });

  await t.test('approving creates the member, occupancy and family', async () => {
    const res = await put(
      `/api/v1/society-admin/society/resident-onboarding-requests/${requestId}`, { action: 'approve' },
    );
    assert.equal(res.status, 200, `approve failed: ${res.data.message}`);
    assert.equal(res.data.result.status, 'Approved');
    assert.equal(res.data.result.familyMembersCreated, 1);

    const rows = await SocietyUnitOccupancy.find({
      societyId: society._id, unitId, isCurrent: true,
    }).lean();
    assert.equal(rows.length, 2, 'the resident and one family member');
    const primary = rows.find((r) => r.memberRole === 'PRIMARY');
    const family = rows.find((r) => r.memberRole === 'FAMILY');
    assert.equal(String(family.parentOccupancyId), String(primary._id));
    assert.equal(family.relation, 'Son');

    const unit = await SocietyUnit.findById(unitId).lean();
    assert.equal(unit.occupancyStatus, 'OCCUPIED');
  });

  await t.test('a family member does not trip the one-owner rule', async () => {
    // Regression: a family member is stored with the household's own
    // residentType, so an owner's son is an 'Owner' row. Without exempting
    // rows that carry a parentOccupancyId, adding them was refused as a
    // "second owner" of the unit their parent owns.
    const rows = await SocietyUnitOccupancy.find({
      societyId: society._id, unitId, isCurrent: true, residentType: 'Owner',
    }).lean();
    assert.equal(rows.length, 2, 'the owner and their son are both Owner rows');
    assert.equal(rows.filter((r) => r.memberRole === 'PRIMARY').length, 1,
      'but only one of them is the primary resident');
  });

  await t.test('approving twice is refused', async () => {
    const res = await put(
      `/api/v1/society-admin/society/resident-onboarding-requests/${requestId}`, { action: 'approve' },
    );
    assert.equal(res.status, 400);
  });

  await t.test('approval into an owned unit is refused and leaves the request pending', async () => {
    const other = await SocietyUser.create({ mobileNumber: '9622200002', countryCode: '+91' });
    const req = await SocietyResidentOnboardingRequest.create({
      societyId: society._id, unitId, userId: other._id, residentType: 'Owner',
      firstName: 'Second', lastName: 'Owner', mobileNumber: '9622200002',
    });

    const res = await put(
      `/api/v1/society-admin/society/resident-onboarding-requests/${req._id}`, { action: 'approve' },
    );
    assert.equal(res.status, 409);

    const after = await SocietyResidentOnboardingRequest.findById(req._id).lean();
    assert.equal(after.status, 'Pending', 'a refused approval must not half-process the request');
  });

  await t.test('releasing the resident releases their family too', async () => {
    const primary = await SocietyUnitOccupancy.findOne({
      societyId: society._id, unitId, memberRole: 'PRIMARY', isCurrent: true,
    }).lean();
    const occupancy = require('../../src/services/society/occupancy');
    await occupancy.release({ societyId: society._id, occupancyId: primary._id });

    assert.equal(await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId, isCurrent: true,
    }), 0, 'a moved-out household must not leave family members current');
  });
});

/* --------------------------------- staff ---------------------------------- */

test('employees and their postings', async (t) => {
  const c = h.client();
  let typeId;
  let employeeId;

  await t.test('an employee type is created', async () => {
    const res = await c.postJson('/api/v1/society-admin/society/employee-types', {
      typeName: 'Housekeeping', description: 'Cleans common areas',
    }, { headers: auth() });
    assert.equal(res.status, 201);
    typeId = res.data.result._id;
  });

  await t.test('hiring creates the person, the posting and an MPIN', async () => {
    const res = await c.postJson('/api/v1/society-admin/society/employees', {
      employeeName: 'Ram Singh', mobileNumber: '9733300001',
      employeeTypeId: typeId, salaryPerMonth: 1800000,
    }, { headers: auth() });
    assert.equal(res.status, 201);
    employeeId = res.data.result._id;

    assert.match(res.data.result.mpin, /^\d{4}$/, 'a 4-digit gate code is allocated');
    assert.equal(res.data.result.employeeType, 'Housekeeping');

    assert.ok(await SocietyEmployee.findOne({ mobileNumber: '9733300001' }).lean());
    assert.ok(await SocietyEmployeeAssignment.findOne({
      societyId: society._id, employeeId, isDeleted: false,
    }).lean());
  });

  await t.test('MPINs are unique within the society', async () => {
    for (let i = 2; i <= 6; i += 1) {
      await c.postJson('/api/v1/society-admin/society/employees', {
        employeeName: `Staff ${i}`, mobileNumber: `97333000${String(i).padStart(2, '0')}`,
        employeeTypeId: typeId,
      }, { headers: auth() });
    }
    const rows = await SocietyEmployeeAssignment.find({ societyId: society._id, isDeleted: false }).lean();
    const pins = rows.map((r) => r.mpin);
    assert.equal(new Set(pins).size, pins.length, 'two guards must not share a gate code');
  });

  await t.test('hiring the same person twice into one society is refused', async () => {
    const res = await c.postJson('/api/v1/society-admin/society/employees', {
      employeeName: 'Ram Singh', mobileNumber: '9733300001', employeeTypeId: typeId,
    }, { headers: auth() });
    assert.equal(res.status, 409);
  });

  await t.test('a type still in use cannot be deleted', async () => {
    const res = await del(`/api/v1/society-admin/society/employee-types/${typeId}`);
    assert.equal(res.status, 409);
  });

  await t.test('a system type cannot be deleted at all', async () => {
    const sys = await SocietyEmployeeType.create({
      societyId: society._id, typeName: 'Security Guard', isSystem: true,
    });
    const res = await del(`/api/v1/society-admin/society/employee-types/${sys._id}`);
    assert.equal(res.status, 400);
  });

  await t.test('removing an employee ends the posting, not the person', async () => {
    const res = await del(`/api/v1/society-admin/society/employees/${employeeId}`);
    assert.equal(res.status, 200);

    const person = await SocietyEmployee.findById(employeeId).lean();
    assert.equal(person.isDeleted, false, 'they may still work at another society');

    const posting = await SocietyEmployeeAssignment.findOne({ societyId: society._id, employeeId }).lean();
    assert.equal(posting.isDeleted, true);
    assert.ok(posting.dateOfLeaving);
  });
});

/* --------------------------------- legacy ---------------------------------- */

test('the legacy façade reads the canonical models', async (t) => {
  const c = h.client();

  await t.test('societyId is required as a query parameter', async () => {
    const res = await c.get('/api/v1/blocks', {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    assert.equal(res.status, 400);
  });

  await t.test('legacy /blocks returns the same rows as the newer surface', async () => {
    const legacy = await c.get(`/api/v1/blocks?societyId=${society._id}`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const modern = await c.get('/api/v1/society-admin/society/blocks', { headers: json() });

    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.result.blocks.length, modern.data.result.blocks.length);
    assert.deepEqual(
      legacy.data.result.blocks.map((b) => b.blockName).sort(),
      modern.data.result.blocks.map((b) => b.blockName).sort(),
      'one dataset behind two URLs',
    );
  });

  await t.test('legacy /units/dropdown is not matched as /units/:unitId', async () => {
    const res = await c.get(`/api/v1/units/dropdown?societyId=${society._id}`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.result.units));
  });
});
