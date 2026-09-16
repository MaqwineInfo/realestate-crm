const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyUnitOccupancy, SocietyCommitteeMember,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const password = require('../../src/lib/password');
const occupancy = require('../../src/services/society/occupancy');

/**
 * Phase 3: members, family, committee — and the first resident-identity surface.
 *
 * The rule under test throughout is that a resident may only write their own
 * household. The app sends `societyId` and `unitId` as query parameters, so the
 * interesting cases are the ones where a resident sends someone else's.
 */

let base;
let society;
let adminToken;
let unitA;
let unitB;
let residentA;
let residentB;
let tokenA;
let tokenB;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const asResident = (t) => ({ Authorization: `Bearer ${t}` });
const residentJson = (t) => ({ ...asResident(t), accept: 'application/json' });

const put = (path, body, headers) => fetch(`${base}${path}`, {
  method: 'PUT', headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const del = (path, headers) => fetch(`${base}${path}`, {
  method: 'DELETE', headers: { ...headers, accept: 'application/json' },
}).then(async (r) => ({ status: r.status, data: await r.json() }));

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const chairRole = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });
  await SocietyRole.create({
    key: 'secretary', name: 'Secretary', displayName: 'Secretary',
    level: 3, scope: 'society', permissions: ['society:read'],
  });
  await SocietyRole.create({
    key: 'platform', name: 'Platform', displayName: 'Platform', level: 1, scope: 'global', permissions: [],
  });

  society = await Society.create({
    societyName: 'Member Test', societyCode: 'SOC-MB-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9400000001', email: 'chair@mb.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });

  const chairUser = await SocietyUser.create({ mobileNumber: '9400000001', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9400000001', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: chairRole._id, role: 'Chairman',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  unitA = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-MB-001', blockId: block._id, floorId: floor._id,
    floorNumber: 1, unitNumber: 'A-101',
  });
  unitB = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-MB-001', blockId: block._id, floorId: floor._id,
    floorNumber: 1, unitNumber: 'A-102',
  });

  residentA = await SocietyUser.create({ mobileNumber: '9411100001', countryCode: '+91', firstName: 'Asha' });
  residentB = await SocietyUser.create({ mobileNumber: '9411100002', countryCode: '+91', firstName: 'Bhavin' });
  tokenA = jwtLib.sign('user', { id: residentA._id });
  tokenB = jwtLib.sign('user', { id: residentB._id });

  await occupancy.assign({
    societyId: society._id, unitId: unitA._id, userId: residentA._id, residentType: 'Owner',
    person: { firstName: 'Asha', lastName: 'Shah', mobileNumber: '9411100001' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitB._id, userId: residentB._id, residentType: 'Owner',
    person: { firstName: 'Bhavin', lastName: 'Patel', mobileNumber: '9411100002' },
  });
});

test.after(async () => { await h.stopServer(); });

/* ------------------------------- identity --------------------------------- */

test('the resident surface is its own identity', async (t) => {
  const c = h.client();
  const q = `?societyId=${society._id}&unitId=${unitA._id}`;

  await t.test('an ADMIN token cannot read the resident surface', async () => {
    // The mirror of the Phase 1 assertion: the two audiences are signed with
    // different secrets, so neither token works on the other's routes.
    const res = await c.get(`/api/v1/app/members/family/list${q}`, {
      headers: { Authorization: `Bearer ${adminToken}`, accept: 'application/json' },
    });
    assert.equal(res.status, 401);
  });

  await t.test('a resident token cannot reach the admin surface', async () => {
    const res = await c.get('/api/v1/society-admin/society/blocks', {
      headers: { ...asResident(tokenA), 'x-society-id': String(society._id), accept: 'application/json' },
    });
    assert.equal(res.status, 401);
  });
});

test('every society-admin prefix is authenticated', async (t) => {
  const c = h.client();
  /**
   * Regression: the guard was mounted on the `/society` prefix only, leaving
   * `/committee-members`, `/users` and `/society-admins` open to anyone who
   * knew the URL. Each sibling prefix is probed with no token.
   */
  const probes = [
    '/api/v1/society-admin/society/blocks',
    '/api/v1/society-admin/committee-members/list',
    '/api/v1/society-admin/committee-members/roles',
    '/api/v1/society-admin/users/service-users',
    '/api/v1/society-admin/society-admins/society-admins',
  ];

  for (const path of probes) {
    await t.test(path, async () => {
      const res = await c.get(path, { headers: { accept: 'application/json' } });
      assert.equal(res.status, 401, `${path} must require a token`);
    });
  }
});

/* -------------------------------- directory -------------------------------- */

test('the resident directory', async (t) => {
  const c = h.client();

  await t.test('the committee roster is readable', async () => {
    await SocietyCommitteeMember.create({
      societyId: society._id, firstName: 'Chair', lastName: 'Person',
      email: 'chair@mb.test', countryCode: '+91', phoneNumber: '9400000001',
      userId: (await SocietyUser.findOne({ mobileNumber: '9400000001' }).lean())._id,
      designation: 'Chairman',
    });
    const res = await c.get(`/api/v1/app/members/committee?societyId=${society._id}`, {
      headers: residentJson(tokenA),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.committeeMembers.length, 1);
  });

  await t.test('the member directory lists primary residents only', async () => {
    const res = await c.get(`/api/v1/app/members/society?societyId=${society._id}`, {
      headers: residentJson(tokenA),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.members.length, 2, 'Asha and Bhavin, one row each');
    assert.ok(res.data.result.members.every((m) => m.memberRole === 'PRIMARY'));
    assert.ok(res.data.result.members[0].unitId.unitNumber, 'the unit is resolved for display');
  });
});

/* -------------------------------- settings --------------------------------- */

test('visitor settings live on the tenure, not the person', async (t) => {
  const c = h.client();
  const qA = `?societyId=${society._id}&unitId=${unitA._id}`;

  await t.test('defaults are returned before anything is set', async () => {
    const res = await c.get(`/api/v1/app/members/settings${qA}`, { headers: residentJson(tokenA) });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.settings.visitor.guestAutoApproval, false);
    assert.equal(res.data.result.settings.visitor.notifications, true);
  });

  await t.test('a resident can change their own', async () => {
    const res = await put(`/api/v1/app/members/settings${qA}`,
      { visitor: { guestAutoApproval: true, cabAutoApproval: true } }, asResident(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.data.result.settings.visitor.guestAutoApproval, true);
    assert.equal(res.data.result.settings.visitor.notifications, true, 'untouched keys survive');
  });

  await t.test('a resident CANNOT change another household settings', async () => {
    // Bhavin points at Asha's unit. There is no occupancy for him there, so it
    // resolves to nothing rather than editing her preferences.
    const res = await put(`/api/v1/app/members/settings${qA}`,
      { visitor: { guestAutoApproval: false } }, asResident(tokenB));
    assert.equal(res.status, 404);

    const asha = await SocietyUnitOccupancy.findOne({
      societyId: society._id, userId: residentA._id, unitId: unitA._id, isCurrent: true,
    }).lean();
    assert.equal(asha.settings.visitor.guestAutoApproval, true, 'her setting is untouched');
  });
});

/* ------------------------------ family members ------------------------------ */

test('family members', async (t) => {
  const c = h.client();
  const qA = `?societyId=${society._id}&unitId=${unitA._id}`;
  let familyId;

  await t.test('adding one requires the family member own OTP', async () => {
    await SocietyUser.create({
      mobileNumber: '9411100003',
      countryCode: '+91',
      otp: await password.hash('123456'),
      otpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });

    const wrong = await c.postJson(`/api/v1/app/members/family/create${qA}`, {
      firstName: 'Riya', lastName: 'Shah', relation: 'Daughter',
      mobileNumber: '9411100003', otp: '000000',
    }, { headers: asResident(tokenA) });
    assert.equal(wrong.status, 400, 'a wrong code must not enrol the number');
    assert.equal(await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId: unitA._id, memberRole: 'FAMILY', isCurrent: true,
    }), 0);
  });

  await t.test('the right OTP adds them to the household', async () => {
    const res = await c.postJson(`/api/v1/app/members/family/create${qA}`, {
      firstName: 'Riya', lastName: 'Shah', relation: 'Daughter',
      mobileNumber: '9411100003', otp: '123456', gender: 'Female',
    }, { headers: asResident(tokenA) });
    assert.equal(res.status, 201, res.data.message);
    familyId = res.data.result._id;

    assert.equal(res.data.result.memberRole, 'FAMILY');
    assert.equal(res.data.result.residentType, 'Owner', 'they inherit the household type');
    assert.ok(res.data.result.parentOccupancyId, 'and hang off the primary resident');
  });

  await t.test('the unit still reads as having one owner', async () => {
    // Regression: a family member is an 'Owner' row, and must not be counted
    // as a second owner of the unit.
    const owners = await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId: unitA._id, residentType: 'Owner',
      memberRole: 'PRIMARY', isCurrent: true,
    });
    assert.equal(owners, 1);
  });

  await t.test('the same mobile cannot be added to the unit twice', async () => {
    const res = await c.postJson(`/api/v1/app/members/family/create${qA}`, {
      firstName: 'Riya', lastName: 'Shah', relation: 'Sister', mobileNumber: '9411100003',
    }, { headers: asResident(tokenA) });
    assert.equal(res.status, 409);
  });

  await t.test('the household lists its own family', async () => {
    const res = await c.get(`/api/v1/app/members/family/list${qA}`, { headers: residentJson(tokenA) });
    assert.equal(res.data.result.familyMembers.length, 1);
    assert.equal(res.data.result.familyMembers[0].firstName, 'Riya');
  });

  await t.test('ANOTHER resident cannot read or edit that family member', async () => {
    const qB = `?societyId=${society._id}&unitId=${unitB._id}`;

    // Bhavin's own household is empty.
    const own = await c.get(`/api/v1/app/members/family/list${qB}`, { headers: residentJson(tokenB) });
    assert.equal(own.data.result.familyMembers.length, 0);

    // And Asha's daughter is not reachable by id from his household.
    const read = await c.get(`/api/v1/app/members/family/get-details/${familyId}${qB}`, {
      headers: residentJson(tokenB),
    });
    assert.equal(read.status, 404);

    const write = await put(`/api/v1/app/members/family/update/${familyId}${qB}`,
      { firstName: 'Hacked' }, asResident(tokenB));
    assert.equal(write.status, 404);

    const still = await SocietyUnitOccupancy.findById(familyId).lean();
    assert.equal(still.firstName, 'Riya');
  });

  await t.test('the owner can update their own family member', async () => {
    const res = await put(`/api/v1/app/members/family/update/${familyId}${qA}`,
      { firstName: 'Riya', lastName: 'Mehta' }, asResident(tokenA));
    assert.equal(res.status, 200);
    assert.equal(res.data.result.lastName, 'Mehta');
  });

  await t.test('removing one ends the tenure but keeps the history', async () => {
    const res = await del(`/api/v1/app/members/family/delete/${familyId}${qA}`, asResident(tokenA));
    assert.equal(res.status, 200);

    assert.equal(await SocietyUnitOccupancy.countDocuments({
      societyId: society._id, _id: familyId, isCurrent: true,
    }), 0);
    const row = await SocietyUnitOccupancy.findById(familyId).lean();
    assert.ok(row.endDate, 'the row survives with an end date');
  });
});

/* -------------------------------- committee -------------------------------- */

test('committee administration', async (t) => {
  const c = h.client();
  let seatId;

  await t.test('the society roles are offered', async () => {
    const res = await c.get('/api/v1/society-admin/committee-members/roles', { headers: adminJson() });
    assert.equal(res.status, 200);
    const keys = res.data.result.roles.map((r) => r.key);
    assert.ok(keys.includes('secretary'));
    assert.ok(!keys.includes('platform'), 'global roles are not committee seats');
  });

  await t.test('creating a seat also gives them a login', async () => {
    const res = await c.postJson('/api/v1/society-admin/committee-members/create', {
      firstName: 'Nita', lastName: 'Joshi', email: 'nita@mb.test',
      countryCode: '+91', phoneNumber: '9422200001', designation: 'Secretary',
    }, { headers: admin() });
    assert.equal(res.status, 201);
    seatId = res.data.result._id;

    const user = await SocietyUser.findOne({ mobileNumber: '9422200001' }).lean();
    assert.ok(user, 'a committee member must be reachable in the app');
    assert.equal(String(res.data.result.userId), String(user._id));
  });

  await t.test('the roster shows them to residents', async () => {
    const res = await c.get(`/api/v1/app/members/committee?societyId=${society._id}`, {
      headers: residentJson(tokenA),
    });
    assert.ok(res.data.result.committeeMembers.some((m) => m.firstName === 'Nita'));
  });

  await t.test('a seat can be updated and removed', async () => {
    const up = await put(`/api/v1/society-admin/committee-members/update/${seatId}`,
      { designation: 'Treasurer' }, admin());
    assert.equal(up.status, 200);
    assert.equal(up.data.result.designation, 'Treasurer');

    const gone = await del(`/api/v1/society-admin/committee-members/delete/${seatId}`, admin());
    assert.equal(gone.status, 200);
    assert.equal(await SocietyCommitteeMember.countDocuments({
      societyId: society._id, isDeleted: false,
    }), 1, 'only the chairman seat remains');
  });
});

/* ------------------------------ admin surfaces ------------------------------ */

test('the chairman user surfaces', async (t) => {
  const c = h.client();

  await t.test('/users/society/:id returns units with their residents', async () => {
    const res = await c.get(`/api/v1/society-admin/users/society/${society._id}`, { headers: adminJson() });
    assert.equal(res.status, 200);
    const a101 = res.data.result.users.find((u) => u.unitNumber === 'A-101');
    assert.equal(a101.residentName, 'Asha Shah', 'the primary resident is resolved onto the unit');
  });

  await t.test('internal lookups resolve users and occupancy', async () => {
    const ids = await c.get(
      `/api/v1/society-admin/users/internal-users/get-society-user-ids/${society._id}`,
      { headers: adminJson() },
    );
    assert.ok(ids.data.result.userIds.includes(String(residentA._id)));

    const occ = await c.get(
      `/api/v1/society-admin/users/internal-users/get-user-occupancy?userId=${residentA._id}`,
      { headers: adminJson() },
    );
    assert.equal(occ.data.result.occupancies.length, 1);
    assert.equal(occ.data.result.occupancies[0].unitId.unitNumber, 'A-101');
  });

  await t.test('route ordering: /service-users is not read as /:id', async () => {
    const res = await c.get('/api/v1/society-admin/users/service-users', { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.result.users));
  });
});

/* --------------------------------- legacy ---------------------------------- */

test('the legacy society-users façade', async (t) => {
  const c = h.client();
  const q = `?societyId=${society._id}`;

  await t.test('it splits the old single collection by population', async () => {
    const membersRes = await c.get(`/api/v1/society-users/members${q}`, { headers: adminJson() });
    assert.equal(membersRes.status, 200);
    assert.equal(membersRes.data.result.members.length, 2);

    const committeeRes = await c.get(`/api/v1/society-users/committee${q}`, { headers: adminJson() });
    assert.equal(committeeRes.status, 200);

    const employeesRes = await c.get(`/api/v1/society-users/employees${q}`, { headers: adminJson() });
    assert.equal(employeesRes.status, 200);
    assert.deepEqual(employeesRes.data.result.employees, []);
  });

  await t.test('the undifferentiated list defaults to members', async () => {
    const res = await c.get(`/api/v1/society-users${q}`, { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.members.length, 2);
  });

  await t.test('one user resolves to their occupancies', async () => {
    const res = await c.get(`/api/v1/society-users/${residentA._id}${q}`, { headers: adminJson() });
    assert.equal(res.data.result.occupancies.length, 1);
  });
});
