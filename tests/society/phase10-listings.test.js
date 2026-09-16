const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyPropertyListing, SocietyNotification, SocietyStage,
  SocietyInquiry, SocietyInquiryHistory, SocietyResidentOnboardingRequest,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');
const listings = require('../../src/services/society/propertyListings');

/**
 * Phase 10: property listings, the resident front door, and the app's own
 * view of societies.
 *
 * The rule that carries the listings half is that a flat can be advertised
 * once, and only by somebody who actually owns it — both proved against the
 * database rather than against a status field.
 */

let base;
let society;
let otherSociety;
let adminToken;
let ownerToken;
let tenantToken;
let neighbourToken;
let ownerId;
let tenantId;
let neighbourId;
let unitA;
let unitB;
let unitC;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const asRes = (t) => ({ Authorization: `Bearer ${t}` });
const resJson = (t) => ({ ...asRes(t), accept: 'application/json' });

const call = (m) => (path, body, headers) => fetch(`${base}${path}`, {
  method: m,
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const put = call('PUT');
const del = call('DELETE');

const q = `?societyId=`;
const ctx = () => ({ societyId: society._id });

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const role = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });

  const make = async (name, code, phone) => Society.create({
    societyName: name, societyCode: code, projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: phone, email: `${code.toLowerCase()}@pl.test`,
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  society = await make('Listing Test', 'SOC-PL-001', '9000000901');
  otherSociety = await make('Elsewhere', 'SOC-PL-002', '9000000902');

  const chairUser = await SocietyUser.create({ mobileNumber: '9000000901', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9000000901', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  const unit = (n) => SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-PL-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, blockNumber: 'A', unitNumber: n,
  });
  unitA = await unit('A-101');
  unitB = await unit('A-102');
  unitC = await unit('A-103');

  const resident = async (phone, first) => SocietyUser.create({
    mobileNumber: phone, countryCode: '+91', firstName: first, societyId: society._id,
  });
  const owner = await resident('9011100901', 'Owner');
  const tenant = await resident('9011100902', 'Tenant');
  const neighbour = await resident('9011100903', 'Neighbour');
  ownerId = owner._id; tenantId = tenant._id; neighbourId = neighbour._id;
  ownerToken = jwtLib.sign('user', { id: owner._id });
  tenantToken = jwtLib.sign('user', { id: tenant._id });
  neighbourToken = jwtLib.sign('user', { id: neighbour._id });

  await occupancy.assign({
    societyId: society._id, unitId: unitA._id, userId: owner._id, residentType: 'Owner',
    person: { firstName: 'Owner', lastName: 'One', mobileNumber: '9011100901' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitB._id, userId: tenant._id, residentType: 'Tenant',
    person: { firstName: 'Tenant', lastName: 'Two', mobileNumber: '9011100902' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitC._id, userId: neighbour._id, residentType: 'Owner',
    person: { firstName: 'Neighbour', lastName: 'Three', mobileNumber: '9011100903' },
  });
});

test.after(async () => { await h.stopServer(); });

/* ------------------------------ who may list -------------------------------- */

test('only the owner of that exact flat may list it', async (t) => {
  const c = h.client();
  const body = { unitId: String(unitA._id), type: 'RENT', price: '25000' };

  await t.test('a tenant of another flat cannot', async () => {
    const res = await c.postJson(`/api/v1/app/property-listing/create${q}${society._id}`,
      body, { headers: asRes(tenantToken) });
    assert.equal(res.status, 403);
    assert.match(res.data.message, /Only owners of this unit/);
  });

  await t.test('an owner of a DIFFERENT flat cannot', async () => {
    const res = await c.postJson(`/api/v1/app/property-listing/create${q}${society._id}`,
      body, { headers: asRes(neighbourToken) });
    assert.equal(res.status, 403, 'owning A-103 says nothing about A-101');
  });

  await t.test('the tenant cannot list the flat they rent', async () => {
    const res = await c.postJson(`/api/v1/app/property-listing/create${q}${society._id}`,
      { unitId: String(unitB._id), type: 'RENT', price: '20000' },
      { headers: asRes(tenantToken) });
    assert.equal(res.status, 403, 'living there is not owning it');
  });

  await t.test('the owner can, and the price lands as paise', async () => {
    const res = await c.postJson(`/api/v1/app/property-listing/create${q}${society._id}`,
      { ...body, negotiable: true, furnishing: 'SEMI_FURNISHED', description: 'Corner flat' },
      { headers: asRes(ownerToken) });
    assert.equal(res.status, 201);
    assert.equal(res.data.result.price, '25000', 'rupees on the wire');
    assert.equal(res.data.result.priceMinor, undefined, 'paise stay inside');

    const stored = await SocietyPropertyListing.findById(res.data.result._id)
      .setOptions({ allowCrossSociety: true }).lean();
    assert.equal(stored.priceMinor, 2500000, 'paise in the database');
    assert.equal(stored.status, 'ACTIVE');
  });

  await t.test('listedBy points at the occupancy, not the user', async () => {
    const stored = await SocietyPropertyListing.findOne({ societyId: society._id }).lean();
    const occ = await require('../../src/db/models/society').SocietyUnitOccupancy
      .findOne({ societyId: society._id, _id: stored.listedBy }).lean();
    assert.ok(occ, 'resolves to a real occupancy');
    assert.equal(String(occ.userId), String(ownerId));
    assert.equal(String(occ.unitId), String(unitA._id));
  });

  await t.test('the neighbours were told, the lister was not', async () => {
    // Announcing is deliberately not awaited by `create` — the listing must not
    // fail because a push did — so this polls rather than assuming it has run.
    const told = await h.eventually(
      async () => {
        const rows = await SocietyNotification.find({
          societyId: society._id, type: 'PROPERTY_LISTING',
        }).lean();
        return rows.length ? rows : null;
      },
      { what: 'the listing announcement' },
    );
    assert.ok(!told.some((n) => String(n.userId) === String(ownerId)),
      'nobody is notified about their own listing');
    assert.ok(told.some((n) => String(n.userId) === String(neighbourId)));
  });
});

/* --------------------------- one listing per flat ---------------------------- */

test('a flat can be advertised once', async (t) => {
  const c = h.client();

  await t.test('a second listing on the same flat is refused', async () => {
    const res = await c.postJson(`/api/v1/app/property-listing/create${q}${society._id}`,
      { unitId: String(unitA._id), type: 'SELL', price: '9000000' },
      { headers: asRes(ownerToken) });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /already exists/);
  });

  await t.test('the database, not the read, is what holds under a race', async () => {
    // Two phones, one flat, at the same instant. The check-then-write in the
    // service cannot see the other request; the unique index can.
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => listings.create(
      ctx(), { unitId: unitC._id, type: 'RENT', price: '18000' }, neighbourId,
    )));
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);

    const live = await SocietyPropertyListing.countDocuments({
      societyId: society._id, unitId: unitC._id, status: 'ACTIVE', isDeleted: false,
    });
    assert.equal(live, 1);
  });

  await t.test('withdrawing frees the flat to be listed again', async () => {
    const mine = await SocietyPropertyListing.findOne({
      societyId: society._id, unitId: unitC._id, status: 'ACTIVE',
    }).lean();

    const gone = await del(`/api/v1/app/property-listing/delete/${mine._id}${q}${society._id}`,
      undefined, asRes(neighbourToken));
    assert.equal(gone.status, 200);

    const after = await SocietyPropertyListing.findById(mine._id)
      .setOptions({ allowCrossSociety: true }).lean();
    assert.equal(after.isDeleted, true);
    assert.equal(after.status, 'INACTIVE',
      'the status must clear too, or the unique index stays occupied by a hidden row');

    const again = await listings.create(
      ctx(), { unitId: unitC._id, type: 'SELL', price: '8500000' }, neighbourId,
    );
    assert.equal(again.status, 'ACTIVE');
  });
});

/* ------------------------------- reading them -------------------------------- */

test('the community board', async (t) => {
  const c = h.client();

  await t.test('lists active ones with the unit and the lister', async () => {
    const res = await c.get(`/api/v1/app/property-listing/list?societyId=${society._id}`, {
      headers: resJson(neighbourToken),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.listings.length, 2);
    assert.ok(res.data.result.imagePath);
    const flat = res.data.result.listings.find((l) => l.unitId?.unitNumber === 'A-101');
    assert.ok(flat, 'the unit is populated, not just its id');
    assert.equal(flat.price, '25000');
  });

  await t.test('a price filter is read in rupees', async () => {
    const cheap = await c.get(
      `/api/v1/app/property-listing/list?societyId=${society._id}&maxPrice=30000`,
      { headers: resJson(neighbourToken) },
    );
    assert.equal(cheap.data.result.listings.length, 1, 'the ₹85 lakh sale is out');
    assert.equal(cheap.data.result.listings[0].price, '25000');
  });

  await t.test('a type filter narrows it', async () => {
    const sale = await c.get(
      `/api/v1/app/property-listing/list?societyId=${society._id}&type=SELL`,
      { headers: resJson(neighbourToken) },
    );
    assert.equal(sale.data.result.listings.length, 1);
  });

  await t.test('my-list shows mine and nobody else\'s', async () => {
    const res = await c.get(`/api/v1/app/property-listing/my-list?societyId=${society._id}`, {
      headers: resJson(neighbourToken),
    });
    assert.equal(res.status, 200);
    // Their live SELL on A-103. The RENT they withdrew is gone, and the owner's
    // A-101 listing is not theirs — the factory drops a filter it was not told
    // about, so an unscoped `listedBy` would have shown both.
    assert.equal(res.data.result.listings.length, 1);
    assert.equal(res.data.result.listings[0].unitId.unitNumber, 'A-103');
    assert.equal(res.data.result.listings[0].type, 'SELL');
  });

  await t.test('a resident with no flat here gets an empty list, not an error', async () => {
    const stranger = await SocietyUser.create({ mobileNumber: '9011100999', countryCode: '+91' });
    const res = await c.get(`/api/v1/app/property-listing/my-list?societyId=${society._id}`, {
      headers: resJson(jwtLib.sign('user', { id: stranger._id })),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.result.listings, []);
  });

  await t.test('the chairman can read the board but not write to it', async () => {
    const read = await c.get(`/api/v1/society-admin/property-listing/list`, { headers: adminJson() });
    assert.equal(read.status, 200);
    assert.equal(read.data.result.listings.length, 2);

    const write = await c.postJson('/api/v1/society-admin/property-listing/create', {}, { headers: admin() });
    assert.equal(write.status, 404, 'there is no admin write surface');
    assert.equal(await SocietyPropertyListing.countDocuments({
      societyId: society._id, isDeleted: false, status: 'ACTIVE',
    }), 2, 'and nothing was created');
  });
});

/* -------------------------------- editing ------------------------------------ */

test('a listing is editable only by the person who made it', async (t) => {
  const c = h.client();
  let id;

  await t.before(async () => {
    const row = await SocietyPropertyListing.findOne({
      societyId: society._id, unitId: unitA._id, isDeleted: false,
    }).lean();
    id = row._id;
  });

  await t.test('a neighbour cannot edit it', async () => {
    const res = await put(`/api/v1/app/property-listing/update/${id}${q}${society._id}`,
      { price: '1' }, asRes(neighbourToken));
    assert.equal(res.status, 403);

    const still = await SocietyPropertyListing.findById(id)
      .setOptions({ allowCrossSociety: true }).lean();
    assert.equal(still.priceMinor, 2500000);
  });

  await t.test('the owner can, and the price converts', async () => {
    const res = await put(`/api/v1/app/property-listing/update/${id}${q}${society._id}`,
      { price: '27500', description: 'Reduced' }, asRes(ownerToken));
    assert.equal(res.status, 200);
    assert.equal(res.data.result.price, '27500');

    const stored = await SocietyPropertyListing.findById(id)
      .setOptions({ allowCrossSociety: true }).lean();
    assert.equal(stored.priceMinor, 2750000);
  });

  await t.test('the flat it advertises cannot be switched', async () => {
    await put(`/api/v1/app/property-listing/update/${id}${q}${society._id}`,
      { unitId: String(unitC._id), listedBy: String(neighbourId) }, asRes(ownerToken));

    const stored = await SocietyPropertyListing.findById(id)
      .setOptions({ allowCrossSociety: true }).lean();
    assert.equal(String(stored.unitId), String(unitA._id), 'still A-101');
  });

  await t.test('a neighbour cannot withdraw it either', async () => {
    const res = await del(`/api/v1/app/property-listing/delete/${id}${q}${society._id}`,
      undefined, asRes(neighbourToken));
    assert.equal(res.status, 403);
  });
});

/* --------------------------- the resident front door -------------------------- */

test('signing in to the app', async (t) => {
  const c = h.client();

  await t.test('an unknown number is told to contact the admin, not enumerated', async () => {
    const res = await c.postJson('/api/v1/app/users/register', {
      mobileNumber: '9999999999', countryCode: '+91',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /contact admin/);
  });

  await t.test('a known number is sent a code, and the code is not in the reply', async () => {
    const res = await c.postJson('/api/v1/app/users/register', {
      mobileNumber: '9011100901', countryCode: '+91', fcmToken: 'tok-1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.mobileNumber, '9011100901');
    assert.equal(res.data.result.otp, undefined, 'the source echoed it; that is an account takeover');

    const stored = await SocietyUser.findById(ownerId).select('+otp +otpExpiresAt').lean();
    assert.ok(stored.otp, 'a code was issued');
    assert.notEqual(stored.otp.length, 6, 'and it is hashed, not the six digits');
    assert.equal(stored.fcmToken, 'tok-1');
  });

  await t.test('a wrong code is refused', async () => {
    const res = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: '000000',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /OTP is invalid/);
  });

  await t.test('an expired code is refused even when correct', async () => {
    const code = await forceOtp(ownerId, { expired: true });
    const res = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: code,
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /expired/);
  });

  await t.test('the right code returns a token and the resident identity', async () => {
    const code = await forceOtp(ownerId);
    const res = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: code,
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.token);
    assert.equal(res.data.result.isMobileVerified, true);
    assert.equal(res.data.result.unitNumber, 'A-101', 'resolved from the occupancy');
    assert.equal(res.data.result.property.societyCode, 'SOC-PL-001');
    assert.equal(res.data.result.isProfileComplete, false, 'no email yet');

    const spent = await SocietyUser.findById(ownerId).select('+otp').lean();
    assert.equal(spent.otp ?? null, null, 'the code is spent, not reusable');
  });

  await t.test('the token it issues is a resident token, not an admin one', async () => {
    const code = await forceOtp(ownerId);
    const login = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: code,
    });
    const token = login.data.result.token;

    const mine = await c.get('/api/v1/app/users/profile', { headers: resJson(token) });
    assert.equal(mine.status, 200);

    const theirs = await c.get('/api/v1/society-admin/property-listing/list', {
      headers: { ...resJson(token), 'x-society-id': String(society._id) },
    });
    assert.equal(theirs.status, 401, 'signed with the user secret; the admin routes will not take it');
  });

  await t.test('a profile can be completed, and duplicate emails are refused', async () => {
    const code = await forceOtp(ownerId);
    const login = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: code,
    });
    const token = login.data.result.token;

    const res = await put('/api/v1/app/users/profile',
      { firstName: 'Owner', lastName: 'One', email: 'owner@pl.test', role: 'owner' },
      asRes(token));
    assert.equal(res.status, 200);
    assert.equal(res.data.result.isProfileComplete, true);

    await SocietyUser.updateOne({ _id: tenantId }, { $set: { email: 'taken@pl.test' } });
    const clash = await put('/api/v1/app/users/profile', { email: 'taken@pl.test' }, asRes(token));
    assert.equal(clash.status, 400);
    assert.match(clash.data.message, /already exists/i);
  });

  await t.test('the phone number is not editable through the profile', async () => {
    const code = await forceOtp(ownerId);
    const login = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: code,
    });
    await put('/api/v1/app/users/profile',
      { mobileNumber: '9011199999' }, asRes(login.data.result.token));

    const still = await SocietyUser.findById(ownerId).lean();
    assert.equal(still.mobileNumber, '9011100901', 'identity is not a profile field');
  });

  await t.test('logging out revokes the token immediately', async () => {
    const code = await forceOtp(ownerId);
    const login = await c.postJson('/api/v1/app/users/verify-otp', {
      mobileNumber: '9011100901', countryCode: '+91', otp: code,
    });
    const token = login.data.result.token;

    assert.equal((await c.get('/api/v1/app/users/profile', { headers: resJson(token) })).status, 200);
    assert.equal((await c.postJson('/api/v1/app/users/logout', {}, { headers: asRes(token) })).status, 200);
    assert.equal((await c.get('/api/v1/app/users/profile', { headers: resJson(token) })).status, 401);
  });
});

/** Issues a real code by going through the service, then reads it back. */
async function forceOtp(userId, { expired = false } = {}) {
  const otp = require('../../src/services/society/otp');
  const { code, fields } = await otp.issueForUser();
  if (expired) fields.otpExpiresAt = new Date(Date.now() - 1000);
  await SocietyUser.updateOne({ _id: userId }, { $set: fields });
  return code;
}

/* ---------------------------- the app's societies ----------------------------- */

test('finding and joining a society from the app', async (t) => {
  const c = h.client();

  await t.test('browse excludes the ones you already live in', async () => {
    const res = await c.get('/api/v1/app/society', { headers: resJson(ownerToken) });
    assert.equal(res.status, 200);
    const names = res.data.result.societies.map((s) => s.societyName);
    assert.ok(names.includes('Elsewhere'));
    assert.ok(!names.includes('Listing Test'), 'they already live there');
  });

  await t.test('browse counts blocks, floors and units live', async () => {
    const stranger = await SocietyUser.create({ mobileNumber: '9011100998', countryCode: '+91' });
    const res = await c.get('/api/v1/app/society', {
      headers: resJson(jwtLib.sign('user', { id: stranger._id })),
    });
    const row = res.data.result.societies.find((s) => s.societyName === 'Listing Test');
    assert.equal(row.totalUnits, 3, 'counted, not read off the creation-time estimate');
    assert.equal(row.totalBlocks, 1);
    assert.equal(row.totalMembers, 3);
  });

  await t.test('the unit picker groups every flat block by floor', async () => {
    const res = await c.get(`/api/v1/app/society/${society._id}/details`, {
      headers: resJson(ownerToken),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.societyInfo.code, 'SOC-PL-001');
    assert.equal(res.data.result.blocks.length, 1);

    const [block] = res.data.result.blocks;
    assert.equal(block.totalUnits, 3);
    assert.equal(block.floors.length, 1);
    const a101 = block.floors[0].units.find((u) => u.unitNumber === 'A-101');
    assert.equal(a101.residentType, 'Owner', 'so the app can grey out taken flats');
  });

  await t.test('my-societies reports the units you hold', async () => {
    const res = await c.get('/api/v1/app/society/my-societies', { headers: resJson(ownerToken) });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.societies.length, 1);
    assert.equal(res.data.result.societies[0].myUnits[0].unitNumber, 'A-101');
    assert.equal(res.data.result.societies[0].myUnits[0].residentType, 'Owner');
  });

  await t.test('and says so plainly when you hold none', async () => {
    const stranger = await SocietyUser.create({ mobileNumber: '9011100997', countryCode: '+91' });
    const res = await c.get('/api/v1/app/society/my-societies', {
      headers: resJson(jwtLib.sign('user', { id: stranger._id })),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.message, 'No societies found');
    assert.deepEqual(res.data.result.societies, []);
  });

  await t.test('society-details resolves the building you live in', async () => {
    const res = await c.get('/api/v1/app/society/user/society-details', {
      headers: resJson(ownerToken),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.societyInfo.code, 'SOC-PL-001');
  });

  await t.test('a family member sees their building too', async () => {
    // The source resolved this from Unit.currentOwnerId, so anybody who was not
    // the primary occupant got a 404 on their own address.
    const son = await SocietyUser.create({ mobileNumber: '9011100996', countryCode: '+91' });
    await occupancy.assign({
      societyId: society._id, unitId: unitA._id, userId: son._id, residentType: 'Owner',
      memberRole: 'FAMILY', relation: 'Son',
      parentOccupancyId: (await require('../../src/db/models/society').SocietyUnitOccupancy
        .findOne({ societyId: society._id, unitId: unitA._id, memberRole: 'PRIMARY' }).lean())._id,
      person: { firstName: 'Son', lastName: 'One', mobileNumber: '9011100996' },
    });

    const res = await c.get('/api/v1/app/society/user/society-details', {
      headers: resJson(jwtLib.sign('user', { id: son._id })),
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.societyInfo.code, 'SOC-PL-001');
  });
});

/* ------------------------- claiming a flat from the app ------------------------ */

test('claiming a flat raises a request, never residency', async (t) => {
  const c = h.client();
  let claimant;
  let token;

  await t.before(async () => {
    claimant = await SocietyUser.create({ mobileNumber: '9011100995', countryCode: '+91' });
    token = jwtLib.sign('user', { id: claimant._id });
    await SocietyUnit.create({
      societyId: society._id, societyCode: 'SOC-PL-001', blockId: unitA.blockId,
      floorId: unitA.floorId, floorNumber: 1, blockNumber: 'A', unitNumber: 'A-104',
    });
  });

  const free = () => SocietyUnit.findOne({ societyId: society._id, unitNumber: 'A-104' }).lean();

  await t.test('a claim lands as Pending and grants nothing', async () => {
    const unit = await free();
    const res = await c.postJson('/api/v1/app/society/register-resident', {
      societyId: String(society._id), unitId: String(unit._id), residentType: 'Owner',
      firstName: 'Claim', lastName: 'Ant', mobileNumber: '9011100995',
    }, { headers: asRes(token) });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.requestId);

    const request = await SocietyResidentOnboardingRequest.findById(res.data.result.requestId).lean();
    assert.equal(request.status, 'Pending');

    const granted = await require('../../src/db/models/society').SocietyUnitOccupancy.countDocuments({
      societyId: society._id, unitId: unit._id, isCurrent: true,
    });
    assert.equal(granted, 0, 'asking is not moving in');
  });

  await t.test('claiming twice is refused', async () => {
    const unit = await free();
    const res = await c.postJson('/api/v1/app/society/register-resident', {
      societyId: String(society._id), unitId: String(unit._id), residentType: 'Owner',
      firstName: 'Claim', lastName: 'Ant', mobileNumber: '9011100995',
    }, { headers: asRes(token) });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /pending request/);
  });

  await t.test('a flat that already has an owner cannot be claimed as owner', async () => {
    await SocietyUnit.updateOne(
      { societyId: society._id, _id: unitA._id }, { $set: { currentOwnerId: ownerId } },
    );
    const res = await c.postJson('/api/v1/app/society/register-resident', {
      societyId: String(society._id), unitId: String(unitA._id), residentType: 'Owner',
      firstName: 'Claim', lastName: 'Ant', mobileNumber: '9011100995',
    }, { headers: asRes(token) });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /already has an owner/);
  });

  await t.test('the owner of a flat is not told to file a request for it', async () => {
    const res = await c.postJson('/api/v1/app/society/register-resident', {
      societyId: String(society._id), unitId: String(unitC._id), residentType: 'Owner',
      firstName: 'Neighbour', lastName: 'Three', mobileNumber: '9011100903',
    }, { headers: asRes(neighbourToken) });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /already registered for this unit/);
  });

  await t.test('an owner cannot also claim to be the tenant of their own flat', async () => {
    const res = await c.postJson('/api/v1/app/society/register-resident', {
      societyId: String(society._id), unitId: String(unitC._id), residentType: 'Tenant',
      firstName: 'Neighbour', lastName: 'Three', mobileNumber: '9011100903',
    }, { headers: asRes(neighbourToken) });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /already registered as Owner.*Cannot register as Tenant/);
  });
});

/* --------------------------- a society enquiry from the app -------------------- */

test('an enquiry from the app enters the pipeline assigned', async (t) => {
  const c = h.client();

  await t.before(async () => {
    await SocietyStage.create({ title: 'New Inquiry', orderNo: 1 });
  });

  await t.test('it lands at the first stage with a Create history row', async () => {
    const res = await c.postJson('/api/v1/app/society/society-request', {
      societyName: 'Hopeful Heights', societyAddress: '9 New Rd, Ahmedabad',
      firstName: 'Asha', lastName: 'Mehta', mobileNumber: '9012000001',
      countryCode: '+91', email: 'asha@hopeful.test', noOfUnit: 48,
      notes: 'Looking to onboard', sourceName: 'App',
    }, { headers: asRes(ownerToken) });
    assert.equal(res.status, 200);

    const inquiry = await SocietyInquiry.findById(res.data.result._id).lean();
    assert.equal(inquiry.societyName, 'Hopeful Heights');
    assert.equal(inquiry.isAction, false);
    assert.ok(inquiry.stageId, 'placed at New Inquiry');

    const history = await SocietyInquiryHistory.find({ inquiryId: inquiry._id }).lean();
    assert.equal(history.length, 1);
    assert.equal(history[0].actionType, 'Create');
  });

  await t.test('an executive owns it, on both the enquiry and its history', async () => {
    const inquiry = await SocietyInquiry.findOne({ societyName: 'Hopeful Heights' }).lean();
    assert.ok(inquiry.currentOwnerId, 'assigned, not left in a pool');
    assert.ok(inquiry.assignedAt);
    assert.equal(String(inquiry.originalOwnerId), String(inquiry.currentOwnerId));

    const history = await SocietyInquiryHistory.findOne({ inquiryId: inquiry._id }).lean();
    assert.equal(String(history.newOwnerId), String(inquiry.currentOwnerId),
      'the trail records who it went to, not just that it moved');
  });

  await t.test('assignment spreads across executives rather than piling up', async () => {
    const role = await SocietyRole.findOne({ key: 'chairman' }).lean();
    const second = await SocietyUser.create({ mobileNumber: '9000000903', countryCode: '+91' });
    await SocietyAdmin.create({
      phoneNumber: '9000000903', countryCode: '+91', userId: second._id,
      societyId: society._id, roleId: role._id, role: 'Chairman',
    });

    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await c.postJson('/api/v1/app/society/society-request', {
        societyName: `Batch ${i}`, societyAddress: 'Rd', firstName: 'A', lastName: 'B',
        mobileNumber: `901200001${i}`, countryCode: '+91', noOfUnit: 10,
      }, { headers: asRes(ownerToken) });
    }

    const rows = await SocietyInquiry.find({ societyName: /^Batch/ }).lean();
    const owners = new Set(rows.map((r) => String(r.currentOwnerId)));
    assert.equal(owners.size, 2, 'both executives got work');

    const counts = [...owners].map((o) => rows.filter((r) => String(r.currentOwnerId) === o).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'and evenly');
  });
});

/* --------------------------- the legacy society CRUD --------------------------- */

test('the legacy /society surface is the same data, not a copy', async (t) => {
  const c = h.client();
  let superToken;

  await t.before(async () => {
    const globalRole = await SocietyRole.create({
      key: 'super_admin', name: 'Super Admin', displayName: 'Super Admin',
      level: 1, scope: 'global', permissions: ['*:*'],
    });
    const su = await SocietyUser.create({ mobileNumber: '9000000904', countryCode: '+91' });
    const admin = await SocietyAdmin.create({
      phoneNumber: '9000000904', countryCode: '+91', userId: su._id,
      roleId: globalRole._id, role: 'SuperAdmin',
    });
    superToken = jwtLib.sign('admin', { id: su._id, adminId: admin._id, role: 'SuperAdmin' });
  });

  const su = () => ({ Authorization: `Bearer ${superToken}`, accept: 'application/json' });

  await t.test('it needs a super admin', async () => {
    const res = await c.get('/api/v1/society', { headers: resJson(ownerToken) });
    assert.equal(res.status, 401);
  });

  await t.test('it lists the same societies the new surface does', async () => {
    const legacy = await c.get('/api/v1/society', { headers: su() });
    const modern = await c.get('/api/v1/super-admin/society', { headers: su() });
    assert.equal(legacy.status, 200);
    assert.deepEqual(
      legacy.data.result.societies.map((s) => s.societyCode).sort(),
      modern.data.result.societies.map((s) => s.societyCode).sort(),
    );
  });

  await t.test('creating through the legacy URL is visible on the new one', async () => {
    const made = await c.postJson('/api/v1/society/create', {
      societyName: 'Legacy Made', societyCode: 'SOC-PL-003', projectType: 'Residential',
      contactPersonName: 'Chair', contactNumber: '9000000905', email: 'lm@pl.test',
      address: { street: '3 Rd', city: 'Rajkot', state: 'GJ', pincode: '360001' },
    }, { headers: { Authorization: `Bearer ${superToken}` } });
    // The legacy surface answered 200, not 201 — its clients branch on that.
    assert.equal(made.status, 200);

    const seen = await c.get('/api/v1/super-admin/society?search=Legacy Made', { headers: su() });
    assert.equal(seen.data.result.societies.length, 1);

    const detail = await c.get(`/api/v1/society/${made.data.result.society._id}`, { headers: su() });
    assert.equal(detail.data.result.societyCode, 'SOC-PL-003');
  });

  await t.test('updating and deleting reach the same rows', async () => {
    const row = await Society.findOne({ societyCode: 'SOC-PL-003' }).lean();

    const up = await put(`/api/v1/society/${row._id}`, { societyName: 'Renamed' },
      { Authorization: `Bearer ${superToken}` });
    assert.equal(up.status, 200);
    assert.equal((await Society.findById(row._id).lean()).societyName, 'Renamed');

    const gone = await del(`/api/v1/society/${row._id}`, undefined,
      { Authorization: `Bearer ${superToken}` });
    assert.equal(gone.status, 200);
    assert.equal((await Society.findById(row._id).lean()).isDeleted, true);
  });
});
