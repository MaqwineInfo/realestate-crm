const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyDeveloper,
  SocietyBlock, SocietyFloor, SocietyUnit, SocietyEmployeeType,
  SocietyCommitteeMember, SocietyCounter,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const password = require('../../src/lib/password');

/**
 * Phase 1 over HTTP: auth, developers, roles, stages, society lifecycle.
 *
 * Exercised through the real routes rather than the services, because the
 * things most likely to break in a contract port are the envelope, the status
 * codes and the route ordering — none of which a service-level test sees.
 */

let base;
let superToken;
let superAdmin;

const auth = (token = superToken) => ({ Authorization: `Bearer ${token}` });

async function makeSuperAdmin() {
  const role = await SocietyRole.create({
    key: 'super_admin', name: 'Super Admin', displayName: 'Super Admin',
    level: 1, scope: 'global', permissions: ['*:*'], isSystem: true,
  });
  const user = await SocietyUser.create({ mobileNumber: '9000000001', countryCode: '+91' });
  const admin = await SocietyAdmin.create({
    phoneNumber: '9000000001', countryCode: '+91', userId: user._id,
    roleId: role._id, role: 'SuperAdmin', fullName: 'Platform Owner',
  });
  return { admin, role, user };
}

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();
  const made = await makeSuperAdmin();
  superAdmin = made.admin;
  superToken = jwtLib.sign('admin', { id: made.user._id, adminId: made.admin._id, role: 'SuperAdmin' });
  // The chairman role the society saga looks for when creating a society.
  await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman (Society Head)',
    level: 2, scope: 'society', permissions: ['society:*'],
  });
  await SocietyRole.create({
    key: 'security_guard', name: 'Security Guard', displayName: 'Security Guard',
    level: 5, scope: 'society', permissions: ['gate:*'],
  });
});

test.after(async () => { await h.stopServer(); });

/* ------------------------------- envelope -------------------------------- */

test('the wire envelope is the source shape, not the CRM shape', async () => {
  const c = h.client();
  const res = await c.get('/api/v1/super-admin/developers/list', { headers: { ...auth(), accept: 'application/json' } });
  assert.equal(res.status, 200);
  assert.ok('message' in res.data, 'response must carry `message`');
  assert.ok('result' in res.data, 'response must carry `result`');
  assert.equal(res.data.message, 'Developers fetched successfully');
  assert.equal(res.data.ok, undefined, 'the CRM `{ok,error}` shape must not leak here');
});

test('an error also answers in the society envelope', async () => {
  const c = h.client();
  const res = await c.get('/api/v1/super-admin/developers/detail/000000000000000000000000', { headers: { ...auth(), accept: 'application/json' } });
  assert.equal(res.status, 404);
  assert.equal(typeof res.data.message, 'string');
  assert.deepEqual(res.data.result, {});
});

/* --------------------------------- auth ---------------------------------- */

test('identity separation', async (t) => {
  await t.test('a request with no token is refused', async () => {
    const c = h.client();
    const res = await c.get('/api/v1/super-admin/developers/list', { headers: { accept: 'application/json' } });
    assert.equal(res.status, 401);
  });

  await t.test('a RESIDENT token cannot reach the admin surface', async () => {
    // The whole point of two audiences: a resident who signs in on the app must
    // not be able to replay that token against super-admin.
    const residentToken = jwtLib.sign('user', { id: String(superAdmin.userId) });
    const c = h.client();
    const res = await c.get('/api/v1/super-admin/developers/list', { headers: { ...auth(residentToken), accept: 'application/json' } });
    assert.equal(res.status, 401);
  });

  await t.test('a revoked token stops working', async () => {
    const throwaway = jwtLib.sign('admin', { id: String(superAdmin.userId), adminId: String(superAdmin._id) });
    const c = h.client();
    assert.equal((await c.get('/api/v1/super-admin/developers/list', { headers: { ...auth(throwaway), accept: 'application/json' } })).status, 200);

    await c.postJson('/api/v1/auth/logout', {}, { headers: auth(throwaway) });

    const after = await c.get('/api/v1/super-admin/developers/list', { headers: { ...auth(throwaway), accept: 'application/json' } });
    assert.equal(after.status, 401, 'a logged-out token must be refused');
  });
});

test('society admin OTP sign-in', async (t) => {
  const societyCode = 'SOC-TEST-001';
  let society;
  let chairman;

  await t.before(async () => {
    society = await Society.create({
      societyName: 'OTP Test Society', societyCode, projectType: 'Residential',
      contactPersonName: 'Asha', contactNumber: '9111100001', email: 'asha@test.local',
      address: { street: '1 Road', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
    });
    const role = await SocietyRole.findOne({ key: 'chairman' });
    chairman = await SocietyAdmin.create({
      phoneNumber: '9111100001', countryCode: '+91', societyId: society._id,
      roleId: role._id, role: 'Chairman', fullName: 'Asha',
    });
  });

  await t.test('send-otp stores the code hashed, never in plaintext', async () => {
    const c = h.client();
    const res = await c.postJson('/api/v1/auth/send-otp', {
      societyCode, countryCode: '+91', phoneNumber: '9111100001',
    });
    assert.equal(res.status, 200);

    // `otp` is `select: false` on the model, so even this test has to ask.
    const row = await SocietyAdmin.findById(chairman._id).select('+otp').lean();
    assert.ok(row.otp, 'an OTP should be stored');
    assert.ok(row.otp.startsWith('scrypt$'), 'the OTP must be hashed at rest');
    assert.ok(!/^\d{6}$/.test(row.otp), 'the six digits must not be readable in the database');
  });

  await t.test('a wrong OTP is rejected', async () => {
    const c = h.client();
    const res = await c.postJson('/api/v1/auth/verify-otp', {
      societyCode, countryCode: '+91', phoneNumber: '9111100001', otp: '999999',
    });
    assert.equal(res.status, 400);
  });

  await t.test('the right OTP returns a working admin token', async () => {
    // The plaintext code only exists in the SMS, so the test sets a known hash.
    const known = '424242';
    await SocietyAdmin.updateOne({ _id: chairman._id }, {
      $set: { otp: await password.hash(known), otpDatetime: new Date() },
    });

    const c = h.client();
    const res = await c.postJson('/api/v1/auth/verify-otp', {
      societyCode, countryCode: '+91', phoneNumber: '9111100001', otp: known,
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.accessToken, 'sign-in must return an access token');
    assert.equal(res.data.result.societyCode, societyCode);

    const cleared = await SocietyAdmin.findById(chairman._id).select('+otp').lean();
    assert.equal(cleared.otp, undefined, 'the OTP must be consumed on use');
  });

  await t.test('an expired OTP is rejected even when correct', async () => {
    const known = '515151';
    await SocietyAdmin.updateOne({ _id: chairman._id }, {
      $set: {
        otp: await password.hash(known),
        otpDatetime: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    const c = h.client();
    const res = await c.postJson('/api/v1/auth/verify-otp', {
      societyCode, countryCode: '+91', phoneNumber: '9111100001', otp: known,
    });
    assert.equal(res.status, 400);
  });

  await t.test('an OTP issued for one society cannot be redeemed for another', async () => {
    const other = await Society.create({
      societyName: 'Other', societyCode: 'SOC-TEST-002', projectType: 'Residential',
      contactPersonName: 'B', contactNumber: '9111100002', email: 'b@test.local',
      address: { street: '2 Road', city: 'Ahmedabad', state: 'GJ', pincode: '380002' },
    });
    const known = '616161';
    await SocietyAdmin.updateOne({ _id: chairman._id }, {
      $set: { otp: await password.hash(known), otpDatetime: new Date() },
    });
    const c = h.client();
    const res = await c.postJson('/api/v1/auth/verify-otp', {
      societyCode: other.societyCode, countryCode: '+91', phoneNumber: '9111100001', otp: known,
    });
    assert.notEqual(res.status, 200);
  });
});

/* ------------------------------- developers ------------------------------- */

test('developers CRUD', async (t) => {
  const c = h.client();
  let id;

  await t.test('create', async () => {
    const res = await c.postJson('/api/v1/super-admin/developers/create', {
      firstName: 'Ravi', lastName: 'Patel', mobileNumber: '9822200001',
      email: 'Ravi@Builders.test', companyName: 'Ravi Builders',
    }, { headers: auth() });
    assert.equal(res.status, 201);
    assert.equal(res.data.message, 'Developer created successfully');
    id = res.data.result._id;
    assert.equal(res.data.result.email, 'ravi@builders.test', 'email should be lowercased');
  });

  await t.test('a duplicate mobile number is refused', async () => {
    const res = await c.postJson('/api/v1/super-admin/developers/create', {
      firstName: 'Copy', lastName: 'Cat', mobileNumber: '9822200001', email: 'other@test.local',
    }, { headers: auth() });
    assert.equal(res.status, 409);
  });

  await t.test('list paginates in the source shape', async () => {
    const res = await c.get('/api/v1/super-admin/developers/list?page=1&perPage=5', { headers: { ...auth(), accept: 'application/json' } });
    const { pagination, developers } = res.data.result;
    assert.ok(Array.isArray(developers));
    assert.deepEqual(Object.keys(pagination).sort(),
      ['hasNextPage', 'hasPrevPage', 'page', 'perPage', 'total', 'totalPages'].sort());
  });

  await t.test('search matches across the indexed fields', async () => {
    const res = await c.get('/api/v1/super-admin/developers/list?search=Ravi', { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(res.data.result.developers.length, 1);
  });

  await t.test('update and detail', async () => {
    const up = await c.request?.() ?? null;
    const res = await fetch(`${base}/api/v1/super-admin/developers/update/${id}`, {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ companyName: 'Ravi Estates' }),
    });
    assert.equal(res.status, 200);
    const detail = await c.get(`/api/v1/super-admin/developers/detail/${id}`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(detail.data.result.companyName, 'Ravi Estates');
    assert.equal(up, null);
  });

  await t.test('delete is soft, and frees the mobile number for reuse', async () => {
    const res = await fetch(`${base}/api/v1/super-admin/developers/delete/${id}`, {
      method: 'DELETE', headers: { ...auth(), accept: 'application/json' },
    });
    assert.equal(res.status, 200);

    const row = await SocietyDeveloper.findById(id).lean();
    assert.equal(row.isDeleted, true, 'the row must survive as a soft delete');

    const reuse = await c.postJson('/api/v1/super-admin/developers/create', {
      firstName: 'New', lastName: 'Owner', mobileNumber: '9822200001', email: 'new@test.local',
    }, { headers: auth() });
    assert.equal(reuse.status, 201, 'a deleted developer must not hold its number forever');
  });
});

/* ---------------------------------- roles ---------------------------------- */

test('role guards', async (t) => {
  const c = h.client();

  await t.test('a system role cannot be deleted', async () => {
    const sys = await SocietyRole.findOne({ key: 'super_admin' });
    const res = await fetch(`${base}/api/v1/super-admin/roles/delete/${sys._id}`, {
      method: 'DELETE', headers: { ...auth(), accept: 'application/json' },
    });
    assert.equal(res.status, 400);
  });

  await t.test('a role still held by an active admin cannot be deleted', async () => {
    const chairmanRole = await SocietyRole.findOne({ key: 'chairman' });
    const res = await fetch(`${base}/api/v1/super-admin/roles/delete/${chairmanRole._id}`, {
      method: 'DELETE', headers: { ...auth(), accept: 'application/json' },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.message, /admin\(s\) are assigned/, 'the error should name the blocking admins');
  });

  await t.test('list reports how many admins hold each role', async () => {
    const res = await c.get('/api/v1/super-admin/roles/list', { headers: { ...auth(), accept: 'application/json' } });
    const chairman = res.data.result.roles.find((r) => r.key === 'chairman');
    assert.ok(chairman.adminCount >= 1);
  });
});

/* -------------------------------- societies -------------------------------- */

test('society lifecycle', async (t) => {
  const c = h.client();
  let created;

  await t.test('generated codes are sequential and never collide', async () => {
    // The source re-rolled 3 random digits until free — a loop that cannot
    // terminate past the thousandth society in a year.
    const codes = await Promise.all(Array.from({ length: 25 }, async () => {
      const res = await c.postJson('/api/v1/super-admin/society/generate-code', {}, { headers: auth() });
      return res.data.result.societyCode;
    }));
    assert.equal(new Set(codes).size, 25, '25 concurrent requests must yield 25 distinct codes');
    for (const code of codes) assert.match(code, /^SOC-\d{4}-\d{3,}$/);
  });

  await t.test('creating a society builds its whole structure', async () => {
    const res = await c.postJson('/api/v1/super-admin/society', {
      societyName: 'Green Valley', projectType: 'Residential',
      totalBlocks: 2, totalFloors: 3, totalUnits: 4, includeGroundFloor: false,
      contactPersonName: 'Meera Shah', contactNumber: '9333300001', email: 'meera@gv.test',
      address: { street: '5 Ring Road', city: 'Ahmedabad', state: 'GJ', pincode: '380015' },
      unitConfiguration: { unitBasicRateMinor: 550000 },
    }, { headers: auth() });

    assert.equal(res.status, 201);
    created = res.data.result.society;

    const societyId = created._id;
    const [blocks, floors, units] = await Promise.all([
      SocietyBlock.countDocuments({ societyId, isDeleted: false }),
      SocietyFloor.countDocuments({ societyId, isDeleted: false }),
      SocietyUnit.countDocuments({ societyId, isDeleted: false }),
    ]);
    assert.equal(blocks, 2, '2 blocks');
    assert.equal(floors, 6, '3 floors per block');
    assert.equal(units, 24, '4 units per floor per block');
  });

  await t.test('units are numbered A-101 style and carry the rate card', async () => {
    const unit = await SocietyUnit.findOne({ societyId: created._id, unitNumber: 'A-101' }).lean();
    assert.ok(unit, 'A-101 should exist');
    assert.equal(unit.unitBasicRateMinor, 550000, 'the society rate card should be stamped onto units');
    assert.equal(unit.societyCode, created.societyCode);
  });

  await t.test('the chairman, committee seat and system employee types are created', async () => {
    const societyId = created._id;
    const admin = await SocietyAdmin.findOne({ societyId, isDeleted: false }).lean();
    assert.ok(admin, 'a chairman admin should exist');
    assert.equal(admin.phoneNumber, '9333300001');

    const user = await SocietyUser.findOne({ mobileNumber: '9333300001' }).lean();
    assert.equal(user.isSocietyAdmin, true);

    const seat = await SocietyCommitteeMember.findOne({ societyId, isDeleted: false }).lean();
    assert.equal(seat.designation, 'Chairman');

    const types = await SocietyEmployeeType.find({ societyId, isDeleted: false }).lean();
    assert.deepEqual(types.map((x) => x.typeName).sort(), ['Security Guard', 'Technician']);
    assert.ok(types.every((x) => x.isSystem));
  });

  await t.test('statistics count the generated structure', async () => {
    const res = await c.get(`/api/v1/super-admin/society/${created._id}/statistics`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(res.data.result.totalUnits, 24);
    assert.equal(res.data.result.totalBlocks, 2);
    assert.equal(res.data.result.occupancyRate, 0);
  });

  await t.test('block and floor lookups resolve by letter', async () => {
    const block = await c.get(`/api/v1/super-admin/society/${created._id}/blocks/A`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(block.status, 200);
    assert.equal(block.data.result.units.length, 12);

    const floor = await c.get(`/api/v1/super-admin/society/${created._id}/blocks/A/floors/1`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(floor.data.result.units.length, 4);
  });

  await t.test('route ordering: /:id does not swallow /stats or /code/:code', async () => {
    const stats = await c.get('/api/v1/super-admin/society/stats', { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(stats.status, 200);
    assert.ok(stats.data.result.totalSocieties >= 1);

    const byCode = await c.get(`/api/v1/super-admin/society/code/${created.societyCode}`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(byCode.status, 200);
    assert.equal(byCode.data.result._id, created._id);
  });

  await t.test('the /users/* façade returns units, not identities', async () => {
    const res = await c.get(`/api/v1/super-admin/users/society/${created._id}?perPage=5`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.users.length, 5);
    assert.ok(res.data.result.users[0].unitNumber, 'rows under `users` are units');

    const stats = await c.get(`/api/v1/super-admin/users/society/${created._id}/stats`, { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(stats.data.result.totalUnits, 24);
    assert.equal(stats.data.result.vacantUnits, 24);
  });

  await t.test('/users/service-users returns identities, not units', async () => {
    const res = await c.get('/api/v1/super-admin/users/service-users', { headers: { ...auth(), accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.users.some((u) => u.mobileNumber === '9333300001'));
    assert.ok(res.data.result.users.every((u) => u.otp === undefined), 'OTPs must never be listed');
    assert.ok(res.data.result.users.every((u) => u.otpExpiresAt === undefined));
  });

  await t.test('re-running creation with the same code is refused, not duplicated', async () => {
    const res = await c.postJson('/api/v1/super-admin/society', {
      societyName: 'Green Valley Again', societyCode: created.societyCode,
      projectType: 'Residential', totalBlocks: 1, totalFloors: 1, totalUnits: 1,
      contactPersonName: 'X', contactNumber: '9333300099', email: 'x@gv.test',
      address: { street: 'a', city: 'b', state: 'c', pincode: '380001' },
    }, { headers: auth() });
    assert.equal(res.status, 409);
    assert.equal(await Society.countDocuments({ societyCode: created.societyCode }), 1);
  });
});

/* --------------------------------- stages ---------------------------------- */

test('the enquiry pipeline is a real tree', async (t) => {
  const c = h.client();
  let stageId;
  let subId;

  await t.test('stages nest three deep', async () => {
    const stage = await c.postJson('/api/v1/super-admin/stages/create', { title: 'Contacted', orderBy: 1 }, { headers: auth() });
    stageId = stage.data.result._id;

    const sub = await c.postJson('/api/v1/super-admin/stages/sub-stages/create', {
      societyStageId: stageId, title: 'Demo booked', orderBy: 1,
    }, { headers: auth() });
    subId = sub.data.result._id;

    const child = await c.postJson('/api/v1/super-admin/stages/child-stages/create', {
      societySubStageId: subId, title: 'Demo done', orderBy: 1,
    }, { headers: auth() });
    assert.equal(child.status, 201);

    const list = await c.get('/api/v1/super-admin/stages/list', { headers: { ...auth(), accept: 'application/json' } });
    const found = list.data.result.stages.find((s) => s._id === stageId);
    assert.equal(found.subStages[0].childStages[0].title, 'Demo done');
  });

  await t.test('a sub-stage cannot dangle off a stage that does not exist', async () => {
    const res = await c.postJson('/api/v1/super-admin/stages/sub-stages/create', {
      societyStageId: '000000000000000000000000', title: 'Orphan',
    }, { headers: auth() });
    assert.equal(res.status, 404);
  });
});
