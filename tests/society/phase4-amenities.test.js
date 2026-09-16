const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyAmenityBooking,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');
const gst = require('../../src/services/society/gst');

/**
 * Phase 4: amenities, slots, packages and bookings.
 *
 * The centrepiece is the double-booking race. The source guarded it with a read
 * inside a transaction that a standalone `mongod` does not provide; this build
 * puts a multikey unique index on (amenity, date, slot) and lets the database
 * arbitrate. The concurrency test below is the reason that index exists.
 */

let base;
let society;
let adminToken;
let residentToken;
let unit;
let amenityId;
let slotMorning;
let slotEvening;
let packageId;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const resident = () => ({ Authorization: `Bearer ${residentToken}` });
const residentJson = () => ({ ...resident(), accept: 'application/json' });

const patch = (path, body, headers) => fetch(`${base}${path}`, {
  method: 'PATCH',
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, data: await r.json() }));

/** Tomorrow, so it is inside the default 7-day booking window. */
const tomorrow = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

test.before(async () => {
  base = await h.startServer();
  await h.resetDb();

  const role = await SocietyRole.create({
    key: 'chairman', name: 'Chairman', displayName: 'Chairman',
    level: 2, scope: 'society', permissions: ['*:*'],
  });
  society = await Society.create({
    societyName: 'Amenity Test', societyCode: 'SOC-AM-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9300000001', email: 'chair@am.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
    upiDetails: { upiId: 'amenitytest@ybl', upiDisplayName: 'Amenity Test Society' },
  });
  const chairUser = await SocietyUser.create({ mobileNumber: '9300000001', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9300000001', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  unit = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-AM-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: 'A-101',
  });

  const res = await SocietyUser.create({
    mobileNumber: '9311100001', countryCode: '+91', firstName: 'Meena', societyId: society._id,
  });
  residentToken = jwtLib.sign('user', { id: res._id });
  await occupancy.assign({
    societyId: society._id, unitId: unit._id, userId: res._id, residentType: 'Owner',
    person: { firstName: 'Meena', lastName: 'Rao', mobileNumber: '9311100001' },
  });
});

test.after(async () => { await h.stopServer(); });

/* --------------------------------- setup ---------------------------------- */

test('amenity setup', async (t) => {
  const c = h.client();
  let typeId;

  await t.test('a type and a paid amenity are created', async () => {
    const type = await c.postJson('/api/v1/society-admin/amenities/type/create', {
      name: 'Clubhouse',
    }, { headers: admin() });
    assert.equal(type.status, 201);
    typeId = type.data.result._id;

    const amenity = await c.postJson('/api/v1/society-admin/amenities/create', {
      amenityTypeId: typeId, name: 'Party Hall',
      description: 'The big hall on the podium level',
      pricingType: 'PAID', taxValue: 18, gstAmountType: 'INCLUDED', advanceBookingDays: 7,
    }, { headers: admin() });
    assert.equal(amenity.status, 201);
    amenityId = amenity.data.result._id;
  });

  await t.test('slots are added, and an overnight window is recognised', async () => {
    const morning = await c.postJson(`/api/v1/society-admin/amenities/${amenityId}/slots`, {
      startTime: '09:00', endTime: '12:00',
    }, { headers: admin() });
    assert.equal(morning.status, 201);
    assert.equal(morning.data.result.isOvernight, false);
    slotMorning = morning.data.result._id;

    const evening = await c.postJson(`/api/v1/society-admin/amenities/${amenityId}/slots`, {
      startTime: '18:00', endTime: '21:00',
    }, { headers: admin() });
    slotEvening = evening.data.result._id;

    const overnight = await c.postJson(`/api/v1/society-admin/amenities/${amenityId}/slots`, {
      startTime: '22:00', endTime: '02:00',
    }, { headers: admin() });
    assert.equal(overnight.data.result.isOvernight, true,
      'a window ending before it starts crosses midnight, it is not negative-length');
  });

  await t.test('a package carries its price in paise', async () => {
    const res = await c.postJson(`/api/v1/society-admin/amenities/${amenityId}/packages`, {
      name: 'Up to 100 guests', capacity: 100, priceMinor: 590000,
    }, { headers: admin() });
    assert.equal(res.status, 201);
    packageId = res.data.result._id;
  });

  await t.test('detail returns the amenity with its slots and packages', async () => {
    const res = await c.get(`/api/v1/society-admin/amenities/get-details/${amenityId}`, {
      headers: adminJson(),
    });
    assert.equal(res.data.result.slots.length, 3);
    assert.equal(res.data.result.packages.length, 1);
  });

  await t.test('route ordering: /type/list is not read as an amenity id', async () => {
    const res = await c.get('/api/v1/society-admin/amenities/type/list', { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.amenityTypes.length, 1);
  });
});

/* -------------------------------- pricing --------------------------------- */

test('pricing is exact', async (t) => {
  const c = h.client();

  await t.test('an inclusive quote splits without losing a paisa', async () => {
    const res = await c.get(
      `/api/v1/amenity/calculate-price?societyId=${society._id}&amenityId=${amenityId}&packageId=${packageId}`,
      { headers: adminJson() },
    );
    assert.equal(res.status, 200);
    const q = res.data.result;
    // 5900.00 inclusive of 18% -> base 5000.00, GST 900.00
    assert.equal(q.totalAmountMinor, 590000);
    assert.equal(q.baseAmountMinor, 500000);
    assert.equal(q.gstAmountMinor, 90000);
    assert.equal(q.baseAmountMinor + q.gstAmountMinor, q.totalAmountMinor);
  });

  await t.test('the CGST/SGST halves always sum back to the whole', () => {
    // Property check across odd amounts, where naive halving loses a paisa.
    for (let amount = 1; amount < 500; amount += 7) {
      const split = gst.split(amount);
      assert.equal(split.cgst + split.sgst, amount, `split of ${amount} must be exact`);
    }
  });
});

/* ------------------------------ availability ------------------------------- */

test('availability and booking', async (t) => {
  const c = h.client();
  let bookingId;

  await t.test('every slot is free before anything is booked', async () => {
    const res = await c.get(
      `/api/v1/society-admin/amenities/check-availability/${amenityId}?date=${tomorrow()}`,
      { headers: adminJson() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.availableCount, 3);
  });

  await t.test('a resident books their own slot and gets a UPI link', async () => {
    const res = await c.postJson(`/api/v1/app/amenity/create-booking?societyId=${society._id}`, {
      amenityId, slotIds: [slotMorning], packageId, bookingDate: tomorrow(),
    }, { headers: resident() });
    assert.equal(res.status, 201, res.data.message);
    bookingId = res.data.result._id;

    assert.equal(res.data.result.paymentStatus, 'PENDING');
    assert.match(res.data.result.upiLink, /^upi:\/\/pay\?pa=amenitytest%40ybl/);
    assert.match(res.data.result.upiLink, /am=5900\.00/);
    assert.equal(String(res.data.result.unitId), String(unit._id),
      'the resident booked against their own unit, not one from the request');
  });

  await t.test('that slot now reads as taken', async () => {
    const res = await c.get(
      `/api/v1/app/amenity/availability/${amenityId}?societyId=${society._id}&date=${tomorrow()}`,
      { headers: residentJson() },
    );
    assert.equal(res.data.result.availableCount, 2);
    const morning = res.data.result.slots.find((s) => String(s._id) === String(slotMorning));
    assert.equal(morning.available, false);
  });

  await t.test('booking the SAME slot again is refused', async () => {
    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId, slotIds: [slotMorning], packageId, bookingDate: tomorrow(), unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(res.status, 409);
  });

  await t.test('a DIFFERENT slot on the same day is fine', async () => {
    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId, slotIds: [slotEvening], bookingDate: tomorrow(), unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(res.status, 201);
  });

  await t.test('cancelling releases the slot for someone else', async () => {
    const res = await patch(`/api/v1/society-admin/amenities/bookings/${bookingId}/cancel`,
      { reason: 'Plans changed' }, admin());
    assert.equal(res.status, 200);
    assert.equal(res.data.result.status, 'CANCELLED');

    const avail = await c.get(
      `/api/v1/society-admin/amenities/check-availability/${amenityId}?date=${tomorrow()}`,
      { headers: adminJson() },
    );
    const morning = avail.data.result.slots.find((s) => String(s._id) === String(slotMorning));
    assert.equal(morning.available, true, 'the unique index is partial on CONFIRMED, so cancelling frees it');

    const rebook = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId, slotIds: [slotMorning], bookingDate: tomorrow(), unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(rebook.status, 201);
  });
});

/* ---------------------------- the actual race ------------------------------ */

test('two residents booking the same slot at the same instant', async () => {
  /**
   * The test this phase exists for.
   *
   * Ten simultaneous requests for one slot. Exactly one may win. The source
   * checked availability and then wrote, which leaves a window every one of
   * these ten can pass through; the unique index closes it in the database, so
   * the outcome does not depend on timing, load, or transaction support.
   */
  const c = h.client();
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + 3);
  const date = day.toISOString().slice(0, 10);

  const attempts = await Promise.all(Array.from({ length: 10 }, () => c.postJson(
    '/api/v1/society-admin/amenities/bookings/create',
    {
      amenityId, slotIds: [slotMorning], bookingDate: date, unitId: String(unit._id),
    },
    { headers: admin() },
  )));

  const created = attempts.filter((r) => r.status === 201);
  const rejected = attempts.filter((r) => r.status === 409);

  assert.equal(created.length, 1, 'exactly one booking may be created');
  assert.equal(rejected.length, 9, 'the other nine must be told the slot is taken');

  const stored = await SocietyAmenityBooking.countDocuments({
    societyId: society._id, amenityId, bookingDate: new Date(`${date}T00:00:00.000Z`), status: 'CONFIRMED',
  });
  assert.equal(stored, 1, 'and the database holds exactly one');
});

/* -------------------------------- payment ---------------------------------- */

test('payment verification', async (t) => {
  const c = h.client();
  let bookingId;

  await t.before(async () => {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 4);
    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId,
      slotIds: [slotEvening],
      packageId,
      bookingDate: day.toISOString().slice(0, 10),
      unitId: String(unit._id),
    }, { headers: admin() });
    bookingId = res.data.result._id;
  });

  await t.test('an admin can confirm the transfer arrived', async () => {
    const res = await patch(`/api/v1/society-admin/amenities/bookings/${bookingId}/verify-payment`,
      { transactionId: 'UPI123456', paymentType: 'UPI' }, admin());
    assert.equal(res.status, 200);
    assert.equal(res.data.result.paymentStatus, 'PAID');
    assert.ok(res.data.result.verifiedBy);
  });

  await t.test('verifying twice is refused', async () => {
    const res = await patch(`/api/v1/society-admin/amenities/bookings/${bookingId}/verify-payment`,
      { transactionId: 'UPI123456' }, admin());
    assert.equal(res.status, 404, 'there is no unpaid booking left to verify');
  });

  await t.test('the invoice spells out the tax split', async () => {
    const res = await c.get(
      `/api/v1/app/amenity/bookings/${bookingId}/invoice?societyId=${society._id}`,
      { headers: residentJson() },
    );
    assert.equal(res.status, 200);
    const { tax, booking } = res.data.result;
    assert.equal(tax.cgst + tax.sgst, booking.gstAmountMinor);
  });
});

/* ------------------------------ booking rules ------------------------------- */

test('booking rules', async (t) => {
  const c = h.client();

  await t.test('a date in the past is refused', async () => {
    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId, slotIds: [slotMorning], bookingDate: '2020-01-01', unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(res.status, 400);
  });

  await t.test('beyond the advance window is refused', async () => {
    const far = new Date();
    far.setUTCDate(far.getUTCDate() + 90);
    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId, slotIds: [slotMorning], bookingDate: far.toISOString().slice(0, 10), unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(res.status, 400);
  });

  await t.test('a slot from another amenity is refused', async () => {
    const other = await c.postJson('/api/v1/society-admin/amenities/create', {
      amenityTypeId: (await c.get('/api/v1/society-admin/amenities/type/list', { headers: adminJson() }))
        .data.result.amenityTypes[0]._id,
      name: 'Gym', description: 'Weights and cardio', pricingType: 'FREE',
    }, { headers: admin() });

    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId: other.data.result._id, slotIds: [slotMorning],
      bookingDate: tomorrow(), unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(res.status, 400);
  });

  await t.test('an inactive amenity cannot be booked', async () => {
    await patch(`/api/v1/society-admin/amenities/${amenityId}/status`, { status: 'INACTIVE' }, admin());
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 5);
    const res = await c.postJson('/api/v1/society-admin/amenities/bookings/create', {
      amenityId, slotIds: [slotEvening], bookingDate: day.toISOString().slice(0, 10), unitId: String(unit._id),
    }, { headers: admin() });
    assert.equal(res.status, 400);
    await patch(`/api/v1/society-admin/amenities/${amenityId}/status`, { status: 'ACTIVE' }, admin());
  });

  await t.test('a non-resident cannot book', async () => {
    const stranger = await SocietyUser.create({
      mobileNumber: '9399900001', countryCode: '+91', societyId: society._id,
    });
    const token = jwtLib.sign('user', { id: stranger._id });
    const res = await c.postJson(`/api/v1/app/amenity/create-booking?societyId=${society._id}`, {
      amenityId, slotIds: [slotEvening], bookingDate: tomorrow(),
    }, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400);
  });
});
