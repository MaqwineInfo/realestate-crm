const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyUnitBill, SocietyUnitBillPayment, SocietyMaintenance,
  SocietyNotification,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');
const billing = require('../../src/services/society/billing');

/**
 * Phase 7: bills, maintenance runs, penalties and payments.
 *
 * Two properties get the attention: the fan-out is idempotent (a retried
 * maintenance run must not double-bill), and the money always reconciles —
 * base + GST = total, and payments never exceed what is owed.
 */

let base;
let society;
let adminToken;
let superToken;
let residentToken;
let categoryId;
let ledgerId;
let ownerUnit;
let tenantUnit;
let vacantUnit;
let resident;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const asRes = () => ({ Authorization: `Bearer ${residentToken}` });
const resJson = () => ({ ...asRes(), accept: 'application/json' });

const call = (method) => (path, body, headers) => fetch(`${base}${path}`, {
  method,
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
  await SocietyRole.create({
    key: 'super_admin', name: 'Super', displayName: 'Super', level: 1, scope: 'global', permissions: ['*:*'],
  });

  society = await Society.create({
    societyName: 'Money Test', societyCode: 'SOC-MN-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9000000501', email: 'chair@mn.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  const chairUser = await SocietyUser.create({ mobileNumber: '9000000501', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9000000501', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  // The legacy write endpoints are gated on `superAdminVerifyToken`.
  const superRole = await SocietyRole.findOne({ key: 'super_admin' });
  const superUser = await SocietyUser.create({ mobileNumber: '9000000599', countryCode: '+91' });
  const superAdmin = await SocietyAdmin.create({
    phoneNumber: '9000000599', countryCode: '+91', userId: superUser._id,
    roleId: superRole._id, role: 'SuperAdmin',
  });
  superToken = jwtLib.sign('admin', { id: superUser._id, adminId: superAdmin._id, role: 'SuperAdmin' });

  const block = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  const floor = await SocietyFloor.create({ societyId: society._id, blockId: block._id, floorNumber: 1 });
  const mk = (n) => SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-MN-001', blockId: block._id,
    floorId: floor._id, floorNumber: 1, unitNumber: n,
  });
  ownerUnit = await mk('A-101');
  tenantUnit = await mk('A-102');
  vacantUnit = await mk('A-103');

  resident = await SocietyUser.create({
    mobileNumber: '9011100501', countryCode: '+91', firstName: 'Nita', societyId: society._id,
  });
  residentToken = jwtLib.sign('user', { id: resident._id });

  await occupancy.assign({
    societyId: society._id, unitId: ownerUnit._id, userId: resident._id, residentType: 'Owner',
    person: { firstName: 'Nita', lastName: 'Desai', mobileNumber: '9011100501' },
  });
  const tenantUser = await SocietyUser.create({ mobileNumber: '9011100502', countryCode: '+91' });
  await occupancy.assign({
    societyId: society._id, unitId: tenantUnit._id, userId: tenantUser._id, residentType: 'Tenant',
    person: { firstName: 'Raj', lastName: 'Kumar', mobileNumber: '9011100502' },
  });
});

test.after(async () => { await h.stopServer(); });

/* --------------------------------- setup ---------------------------------- */

test('billing setup', async (t) => {
  const c = h.client();

  await t.test('a ledger account and a bill category are created', async () => {
    const ledger = await c.postJson('/api/v1/society-admin/balance-sheet/create', {
      name: 'Common Maintenance', accountCode: 'CM-01', type: 'INCOME', balanceSheetType: 'COMMON',
    }, { headers: admin() });
    assert.equal(ledger.status, 201);
    ledgerId = ledger.data.result._id;

    const cat = await c.postJson('/api/v1/society-admin/bill/category/create', {
      name: 'Water charges',
    }, { headers: admin() });
    assert.equal(cat.status, 201);
    categoryId = cat.data.result._id;
  });

  await t.test('route ordering: /category/list is not read as a bill id', async () => {
    const res = await c.get('/api/v1/society-admin/bill/category/list', { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.billCategories.length, 1);
  });
});

/* ------------------------------- bill fan-out ------------------------------- */

test('publishing a bill charges each unit its own rate', async (t) => {
  const c = h.client();
  let billId;

  await t.test('the bill fans out to all three units', async () => {
    const res = await c.postJson('/api/v1/society-admin/bill/create', {
      billCategoryId: categoryId,
      balanceSheetId: ledgerId,
      name: 'Water — March',
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      dueDate: '2026-04-10',
      priceOwnerMinor: 100000,
      priceTenantMinor: 120000,
      priceCloseUnitMinor: 50000,
      selectionType: 'ALL',
      publishStatus: 'PUBLISHED',
    }, { headers: admin() });
    assert.equal(res.status, 201);
    billId = res.data.result._id;
    assert.equal(res.data.result.generated.inserted, 3);
  });

  await t.test('each unit is charged by who lives in it', async () => {
    const rows = await SocietyUnitBill.find({ societyId: society._id, billId }).lean();
    const by = new Map();
    for (const r of rows) by.set(String(r.unitId), r);

    /**
     * Untaxed: the source's `bill` model carries no GST configuration at all —
     * only `maintenance` does — so a bill charges its face value. The unit-bill
     * GST columns exist for the maintenance path.
     */
    assert.equal(by.get(String(ownerUnit._id)).amountMinor, 100000);
    assert.equal(by.get(String(tenantUnit._id)).amountMinor, 120000);
    // A vacant flat still owes its share of common costs.
    assert.equal(by.get(String(vacantUnit._id)).amountMinor, 50000);
  });

  await t.test('every row reconciles', async () => {
    const rows = await SocietyUnitBill.find({ societyId: society._id, billId }).lean();
    for (const r of rows) {
      assert.equal(r.baseAmountMinor + r.gstAmountMinor, r.amountMinor,
        `base + gst must equal total for ${r.unitId}`);
    }
  });

  await t.test('publishing twice does not double-bill', async () => {
    const again = await billing.bills.publish(ctx(), billId, null);
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 3, 'the unique index turns a retry into skips');
    assert.equal(await SocietyUnitBill.countDocuments({ societyId: society._id, billId }), 3);
  });

  await t.test('the residents were told once', async () => {
    const notes = await SocietyNotification.countDocuments({
      societyId: society._id, type: 'BILL',
    });
    assert.equal(notes, 2, 'the two occupied units; a vacant flat has nobody to tell');
  });

  await t.test('payment status reports who owes what', async () => {
    const res = await c.get(`/api/v1/society-admin/bill/payment-status/${billId}`, { headers: adminJson() });
    assert.equal(res.status, 200);
    assert.equal(res.data.result.summary.count, 3);
    assert.equal(res.data.result.summary.billedMinor, 100000 + 120000 + 50000);
    assert.equal(res.data.result.summary.collectedMinor, 0);
    assert.equal(res.data.result.summary.paidUnits, 0);
  });
});

/* ------------------------------ block targeting ------------------------------ */

test('a bill can target one block only', async () => {
  const c = h.client();
  const otherBlock = await SocietyBlock.create({
    societyId: society._id, blockName: 'Block B', orderNo: 2,
  });
  const otherFloor = await SocietyFloor.create({
    societyId: society._id, blockId: otherBlock._id, floorNumber: 1,
  });
  const bUnit = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-MN-001', blockId: otherBlock._id,
    floorId: otherFloor._id, floorNumber: 1, unitNumber: 'B-101',
  });

  const res = await c.postJson('/api/v1/society-admin/bill/create', {
    billCategoryId: categoryId, balanceSheetId: ledgerId, name: 'Block B lift AMC',
    startDate: '2026-03-01', endDate: '2026-03-31', dueDate: '2026-04-10',
    priceOwnerMinor: 30000, priceTenantMinor: 30000, priceCloseUnitMinor: 30000,
    selectionType: 'BLOCK', blockIds: [String(otherBlock._id)],
    publishStatus: 'PUBLISHED',
  }, { headers: admin() });

  assert.equal(res.status, 201);
  assert.equal(res.data.result.generated.inserted, 1, 'only Block B');

  const row = await SocietyUnitBill.findOne({
    societyId: society._id, billId: res.data.result._id,
  }).lean();
  assert.equal(String(row.unitId), String(bUnit._id));
});

/* ----------------------------- maintenance runs ------------------------------- */

test('maintenance runs are idempotent per period', async (t) => {
  const c = h.client();
  let maintenanceId;

  await t.test('creating and publishing generates this month', async () => {
    const res = await c.postJson('/api/v1/society-admin/maintenance/create', {
      balanceSheetId: ledgerId,
      title: 'Monthly maintenance',
      maintenanceType: 'MONTH_WISE',
      dueDate: '2026-04-10',
      priceOwnerMinor: 200000,
      priceTenantMinor: 200000,
      priceCloseUnitMinor: 100000,
      selectionType: 'ALL',
      gstPercentage: 0,
      publishStatus: 'PUBLISHED',
    }, { headers: admin() });
    assert.equal(res.status, 201);
    maintenanceId = res.data.result._id;
    assert.ok(res.data.result.generated.inserted >= 3);
  });

  await t.test('re-running the SAME period adds nothing', async () => {
    const before = await SocietyUnitBill.countDocuments({ societyId: society._id, maintenanceId });
    const out = await billing.maintenances.run(ctx(), maintenanceId);
    assert.equal(out.inserted, 0);
    assert.ok(out.skipped > 0);
    assert.equal(await SocietyUnitBill.countDocuments({ societyId: society._id, maintenanceId }), before,
      'a retried run must never double-bill');
  });

  await t.test('a DIFFERENT period generates a fresh set', async () => {
    const before = await SocietyUnitBill.countDocuments({ societyId: society._id, maintenanceId });
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);

    const out = await billing.maintenances.run(ctx(), maintenanceId, { when: nextMonth });
    assert.ok(out.inserted > 0, 'next month is a new period');
    assert.equal(
      await SocietyUnitBill.countDocuments({ societyId: society._id, maintenanceId }),
      before + out.inserted,
    );
  });

  await t.test('the scheduler runs only what is due', async () => {
    await SocietyMaintenance.updateOne(
      { societyId: society._id, _id: maintenanceId },
      { $set: { autoGenerate: true, nextRunDate: new Date(Date.now() - 60000) } },
    );
    const out = await billing.maintenances.runDue();
    assert.ok(out.rules >= 1);

    const after = await SocietyMaintenance.findById(maintenanceId).lean();
    assert.ok(after.lastRunDate, 'the run is stamped');
    assert.ok(after.nextRunDate > new Date(), 'and the next one is scheduled');
  });
});

/* --------------------------------- payments ----------------------------------- */

test('payments', async (t) => {
  const c = h.client();
  let unitBillId;
  let owedMinor;

  await t.before(async () => {
    const row = await SocietyUnitBill.findOne({
      societyId: society._id, unitId: ownerUnit._id, status: 'UNPAID',
    }).lean();
    unitBillId = row._id;
    owedMinor = row.amountMinor;
  });

  await t.test('a part payment leaves the bill unpaid', async () => {
    const out = await billing.recordPayment(ctx(), unitBillId, { amountMinor: 50000 }, null);
    assert.equal(out.paidMinor, 50000);
    assert.equal(out.outstandingMinor, owedMinor - 50000);

    const row = await SocietyUnitBill.findById(unitBillId).lean();
    assert.equal(row.status, 'UNPAID', 'part payment is not payment');
  });

  await t.test('overpaying is refused', async () => {
    await assert.rejects(
      () => billing.recordPayment(ctx(), unitBillId, { amountMinor: owedMinor }, null),
      /more than the/,
      'a resident cannot pay more than they owe',
    );
  });

  await t.test('settling the balance marks it paid', async () => {
    const out = await billing.recordPayment(ctx(), unitBillId, { amountMinor: owedMinor - 50000 }, null);
    assert.equal(out.outstandingMinor, 0);

    const row = await SocietyUnitBill.findById(unitBillId).lean();
    assert.equal(row.status, 'PAID');
  });

  await t.test('the payments add up to exactly the bill', async () => {
    const rows = await SocietyUnitBillPayment.find({ societyId: society._id, unitBillId }).lean();
    assert.equal(rows.reduce((a, p) => a + p.amountMinor, 0), owedMinor);
    assert.equal(rows.length, 2, 'both instalments are recorded separately');
  });

  await t.test('a repeated gateway transaction id is refused', async () => {
    const other = await SocietyUnitBill.findOne({
      societyId: society._id, unitId: tenantUnit._id, status: 'UNPAID',
    }).lean();

    await billing.recordPayment(ctx(), other._id, { amountMinor: 1000, transactionId: 'TXN-1' }, null);
    await assert.rejects(
      () => billing.recordPayment(ctx(), other._id, { amountMinor: 1000, transactionId: 'TXN-1' }, null),
      /already been recorded/,
      'a retry must not book the money twice',
    );
  });
});

/* --------------------------------- penalties ------------------------------------ */

test('penalties', async (t) => {
  const c = h.client();
  let penaltyId;

  await t.test('the tax split is derived, not supplied', async () => {
    const res = await c.postJson('/api/v1/society-admin/penalties/create', {
      unitId: String(ownerUnit._id),
      description: 'Parking in a visitor bay',
      penaltyDate: '2026-03-20',
      amountMinor: 118000,
      taxValue: 18,
      gstAmountType: 'INCLUDED',
      balanceSheetId: ledgerId,
    }, { headers: admin() });
    assert.equal(res.status, 201);
    penaltyId = res.data.result._id;

    /**
     * The API answers in the source's shape (D2, §3.9): decimal-string rupees
     * under the unsuffixed names, not the integer-paise columns.
     */
    const p = res.data.result;
    assert.equal(p.baseAmount, '1000');
    assert.equal(p.gstAmount, '180');
    assert.equal(p.totalAmount, '1180');
    assert.equal(p.amountMinor, undefined, 'internal paise columns never reach the wire');

    const stored = await require('../../src/db/models/society').SocietyPenalty
      .findById(penaltyId).lean();
    assert.equal(stored.baseAmountMinor + stored.gstAmountMinor, stored.totalAmountMinor,
      'and in storage the three always reconcile');
  });

  await t.test('editing the amount recomputes the tax', async () => {
    const res = await put(`/api/v1/society-admin/penalties/update/${penaltyId}`,
      { amountMinor: 59000 }, admin());
    assert.equal(res.status, 200);
    assert.equal(res.data.result.baseAmount, '500');
    assert.equal(res.data.result.gstAmount, '90');
    assert.equal(res.data.result.totalAmount, '590');
  });

  await t.test('the resident is notified, and can be notified again', async () => {
    const before = await SocietyNotification.countDocuments({
      societyId: society._id, type: 'PENALTY',
    });
    assert.ok(before >= 1);

    const res = await c.postJson(
      `/api/v1/society-admin/penalties/resend-notification/${penaltyId}`, {}, { headers: admin() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.notified, 1);
  });

  await t.test('the resident sees their own penalty with its invoice', async () => {
    const list = await c.get(`/api/v1/app/penalty/list?societyId=${society._id}`, { headers: resJson() });
    assert.equal(list.status, 200);
    assert.equal(list.data.result.penalties.length, 1);

    const inv = await c.get(
      `/api/v1/app/penalty/download-invoice/${penaltyId}?societyId=${society._id}`,
      { headers: resJson() },
    );
    assert.equal(inv.status, 200);
    assert.equal(inv.data.result.tax.cgst + inv.data.result.tax.sgst,
      inv.data.result.gstAmountMinor, 'the halves sum to the whole');
    assert.ok(inv.data.result.gstAmountMinor > 0, 'and the split is of a real amount');
  });
});

/* --------------------------------- resident view --------------------------------- */

test('the resident sees only their own bills', async (t) => {
  const c = h.client();

  await t.test('their list covers their unit only', async () => {
    const res = await c.get(`/api/v1/app/bills/list?societyId=${society._id}`, { headers: resJson() });
    assert.equal(res.status, 200);
    assert.ok(res.data.result.bills.length > 0);

    const theirs = await SocietyUnitBill.find({
      societyId: society._id, unitId: ownerUnit._id, isDeleted: false,
    }).lean();
    assert.equal(res.data.result.pagination.total, theirs.length);
  });

  await t.test('a bill detail shows its payments and what is left', async () => {
    // The bill settled in the payments block, by id — picking "the first PAID
    // one" is not deterministic once maintenance runs have added more rows.
    const settled = await SocietyUnitBillPayment.findOne({ societyId: society._id }).lean();
    const res = await c.get(
      `/api/v1/app/bills/get-details/${settled.unitBillId}?societyId=${society._id}`,
      { headers: resJson() },
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.outstandingMinor, 0);
    assert.equal(res.data.result.payments.length, 2, 'both instalments are listed');
  });
});

test('a societyId arriving as a query string still matches in aggregations', async () => {
  /**
   * Regression, and a nasty one: `find()` casts a string id against the schema
   * path, but `aggregate()` does not — a `$match` on a string `societyId`
   * matches nothing and returns zero rows with no error. Every endpoint that
   * takes the society from a query parameter and then aggregates was affected;
   * `toSocietyId()` in the route helpers coerces once, centrally.
   *
   * This asserts through the resident surface, which is the path that passes
   * the id as a string.
   */
  const c = h.client();

  const viaQuery = await c.get(
    `/api/v1/maintenances/statistics?societyId=${society._id}`, { headers: adminJson() },
  );
  assert.equal(viaQuery.status, 200);
  assert.ok(viaQuery.data.result.billedMinor > 0,
    'the aggregation must see the rows when the id came in as text');

  const direct = await billing.societyStats({ societyId: society._id });
  assert.equal(viaQuery.data.result.billedMinor, direct.billedMinor,
    'and agree with the same call made with a real ObjectId');
});

/* ----------------------------------- legacy -------------------------------------- */

test('the legacy money surface', async (t) => {
  const c = h.client();

  await t.test('statistics reconcile against the unit bills', async () => {
    const res = await c.get(`/api/v1/maintenances/statistics?societyId=${society._id}`, {
      headers: adminJson(),
    });
    assert.equal(res.status, 200);
    const s = res.data.result;
    assert.equal(s.billedMinor - s.collectedMinor, s.outstandingMinor);
  });

  await t.test('legacy publish runs the same generator', async () => {
    const superAuth = { Authorization: `Bearer ${superToken}` };
    const made = await c.postJson(`/api/v1/maintenances?societyId=${society._id}`, {
      balanceSheetId: ledgerId, title: 'Legacy run', maintenanceType: 'FIXED',
      dueDate: '2026-05-10', priceOwnerMinor: 10000, priceTenantMinor: 10000,
      priceCloseUnitMinor: 10000, selectionType: 'ALL',
    }, { headers: superAuth });
    assert.equal(made.status, 201);

    const res = await c.postJson(
      `/api/v1/maintenances/${made.data.result._id}/publish?societyId=${society._id}`, {},
      { headers: superAuth },
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.result.inserted > 0);
  });
});

/**
 * The wire boundary itself, without a server.
 *
 * Every one of these was a real defect at some point: the double conversion in
 * `recordPayment`, the split invoice reading a serialized value, and — found
 * while generating the API document — an amount inside an array of
 * subdocuments that the dotted-path walk gave up on, shipping paise to clients
 * as if they were rupees.
 */
test('paise in, rupees out — including inside arrays', async (t) => {
  const serialize = require('../../src/lib/society/serialize');
  const Pricing = require('../../src/db/models/society/SocietyAmenityPricing');

  const doc = () => ({
    baseRateMinor: 250000,
    additionalChargeMinor: null,
    timeSlotRates: { morning: 100000, evening: null },
    featurePricing: [
      { featureName: 'Projector', amountMinor: 50000 },
      { featureName: 'Chairs', amountMinor: 0 },
    ],
  });

  await t.test('a top-level amount is renamed and converted', () => {
    const wire = serialize.toWire(doc(), Pricing.MONEY_FIELDS);
    assert.equal(wire.baseRate, '2500');
    assert.equal(wire.baseRateMinor, undefined, 'the storage column does not go out');
  });

  await t.test('an amount nested in an object is converted in place', () => {
    const wire = serialize.toWire(doc(), Pricing.MONEY_FIELDS);
    assert.equal(wire.timeSlotRates.morning, '1000');
  });

  await t.test('an amount inside an array of subdocuments is converted too', () => {
    const wire = serialize.toWire(doc(), Pricing.MONEY_FIELDS);
    assert.deepEqual(
      wire.featurePricing,
      [{ featureName: 'Projector', amount: '500' }, { featureName: 'Chairs', amount: '0' }],
      'every element, not just the first, and never the raw paise',
    );
  });

  await t.test('"not set" stays null rather than becoming zero', () => {
    const wire = serialize.toWire(doc(), Pricing.MONEY_FIELDS);
    assert.equal(wire.additionalCharge, null);
    assert.equal(wire.timeSlotRates.evening, null);
    assert.notEqual(wire.timeSlotRates.evening, '0', 'free is not the same as unpriced');
  });

  await t.test('and the whole thing round-trips back to the paise it started as', () => {
    const back = serialize.fromWire(serialize.toWire(doc(), Pricing.MONEY_FIELDS), Pricing.MONEY_FIELDS);
    assert.deepEqual(back.featurePricing, [
      { featureName: 'Projector', amountMinor: 50000 },
      { featureName: 'Chairs', amountMinor: 0 },
    ]);
    assert.equal(back.baseRateMinor, 250000);
    assert.equal(back.timeSlotRates.morning, 100000);
  });

  await t.test('every money column a model declares is reachable by the walk', () => {
    // A declared field the walk cannot reach is worse than an undeclared one:
    // it reads as handled. This is how `featurePricing.amountMinor` hid.
    const models = require('../../src/db/models/society');
    const unreachable = [];

    for (const Model of Object.values(models)) {
      for (const field of Model.MONEY_FIELDS || []) {
        const probe = {};
        let cursor = probe;
        const keys = field.split('.');
        const leaf = keys.pop();
        for (const key of keys) {
          const schemaPath = Model.schema.path(keys.slice(0, keys.indexOf(key) + 1).join('.'));
          cursor[key] = schemaPath?.instance === 'Array' ? [{}] : {};
          cursor = Array.isArray(cursor[key]) ? cursor[key][0] : cursor[key];
        }
        cursor[leaf] = 12345;

        const wire = serialize.toWire(probe, [field]);
        const holder = keys.reduce(
          (node, key) => (Array.isArray(node[key]) ? node[key][0] : node[key]),
          wire,
        );
        if (holder?.[leaf.replace(/Minor$/, '')] !== '123.45') {
          unreachable.push(`${Model.modelName}.${field}`);
        }
      }
    }
    assert.deepEqual(unreachable, []);
  });
});
