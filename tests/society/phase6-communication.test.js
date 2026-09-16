const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Society, SocietyAdmin, SocietyRole, SocietyUser, SocietyBlock, SocietyFloor,
  SocietyUnit, SocietyNotice, SocietyPoll, SocietyPollVote, SocietyNotification,
  SocietyLostAndFound, SocietyGallery,
} = require('../../src/db/models/society');
const jwtLib = require('../../src/lib/society/jwt');
const occupancy = require('../../src/services/society/occupancy');
const notices = require('../../src/services/society/notices');
const polls = require('../../src/services/society/polls');

/**
 * Phase 6: notices, polls, galleries, documents, emergency numbers,
 * lost & found and the notification inbox.
 *
 * The two things worth testing hard are notice targeting (who actually sees a
 * notice) and poll voting (one vote per flat, counters that stay honest).
 */

let base;
let society;
let adminToken;
let ownerAToken;
let tenantBToken;
let blockA;
let blockB;
let unitA;
let unitB;
let ownerA;
let tenantB;

const admin = () => ({ Authorization: `Bearer ${adminToken}`, 'x-society-id': String(society._id) });
const adminJson = () => ({ ...admin(), accept: 'application/json' });
const asRes = (t) => ({ Authorization: `Bearer ${t}` });
const resJson = (t) => ({ ...asRes(t), accept: 'application/json' });

const call = (method) => (path, body, headers) => fetch(`${base}${path}`, {
  method,
  headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const put = call('PUT');
const patch = call('PATCH');
const del = call('DELETE');

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
    societyName: 'Comms Test', societyCode: 'SOC-CO-001', projectType: 'Residential',
    contactPersonName: 'Chair', contactNumber: '9100000001', email: 'chair@co.test',
    address: { street: '1 Rd', city: 'Ahmedabad', state: 'GJ', pincode: '380001' },
  });
  const chairUser = await SocietyUser.create({ mobileNumber: '9100000001', countryCode: '+91' });
  const chair = await SocietyAdmin.create({
    phoneNumber: '9100000001', countryCode: '+91', userId: chairUser._id,
    societyId: society._id, roleId: role._id, role: 'Chairman', fullName: 'Chair',
  });
  adminToken = jwtLib.sign('admin', { id: chairUser._id, adminId: chair._id, role: 'Chairman' });

  blockA = await SocietyBlock.create({ societyId: society._id, blockName: 'Block A', orderNo: 1 });
  blockB = await SocietyBlock.create({ societyId: society._id, blockName: 'Block B', orderNo: 2 });
  const fA = await SocietyFloor.create({ societyId: society._id, blockId: blockA._id, floorNumber: 1 });
  const fB = await SocietyFloor.create({ societyId: society._id, blockId: blockB._id, floorNumber: 1 });

  unitA = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-CO-001', blockId: blockA._id,
    floorId: fA._id, floorNumber: 1, unitNumber: 'A-101',
  });
  unitB = await SocietyUnit.create({
    societyId: society._id, societyCode: 'SOC-CO-001', blockId: blockB._id,
    floorId: fB._id, floorNumber: 1, unitNumber: 'B-101',
  });

  ownerA = await SocietyUser.create({
    mobileNumber: '9111100001', countryCode: '+91', firstName: 'Owner', societyId: society._id, fcmToken: 'tok-a',
  });
  tenantB = await SocietyUser.create({
    mobileNumber: '9111100002', countryCode: '+91', firstName: 'Tenant', societyId: society._id,
  });
  ownerAToken = jwtLib.sign('user', { id: ownerA._id });
  tenantBToken = jwtLib.sign('user', { id: tenantB._id });

  await occupancy.assign({
    societyId: society._id, unitId: unitA._id, userId: ownerA._id, residentType: 'Owner',
    person: { firstName: 'Owner', lastName: 'A', mobileNumber: '9111100001' },
  });
  await occupancy.assign({
    societyId: society._id, unitId: unitB._id, userId: tenantB._id, residentType: 'Tenant',
    person: { firstName: 'Tenant', lastName: 'B', mobileNumber: '9111100002' },
  });
});

test.after(async () => { await h.stopServer(); });

/* -------------------------------- notices ---------------------------------- */

test('notice targeting decides who sees what', async (t) => {
  const c = h.client();
  const ctx = { societyId: society._id };

  await t.test('a draft is invisible to residents', async () => {
    await c.postJson('/api/v1/society-admin/notices', {
      title: 'Draft notice', text: 'Not published yet.', category: 'General',
    }, { headers: admin() });

    const res = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${society._id}`, {
      headers: resJson(ownerAToken),
    });
    assert.equal(res.data.result.notices.length, 0, 'a draft is not on the board');
  });

  await t.test('a published notice for everyone reaches both residents', async () => {
    const made = await c.postJson('/api/v1/society-admin/notices', {
      title: 'Water supply', text: 'Tanker at 6pm.', category: 'General',
      residentType: 'ALL', targetBlocks: ['All'], publishStatus: 'PUBLISHED',
    }, { headers: admin() });
    assert.equal(made.status, 201);

    for (const [token, name] of [[ownerAToken, 'owner'], [tenantBToken, 'tenant']]) {
      const res = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${society._id}`, {
        headers: resJson(token),
      });
      assert.ok(res.data.result.notices.some((n) => n.title === 'Water supply'), `${name} should see it`);
    }
  });

  await t.test('an OWNER-only notice is hidden from the tenant', async () => {
    await notices.create(ctx, {
      title: 'AGM for owners', text: 'Sunday 11am.', category: 'Administrative',
      residentType: 'OWNER', publishStatus: 'PUBLISHED',
    }, null);

    const owner = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${society._id}`, {
      headers: resJson(ownerAToken),
    });
    const tenant = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${society._id}`, {
      headers: resJson(tenantBToken),
    });
    assert.ok(owner.data.result.notices.some((n) => n.title === 'AGM for owners'));
    assert.ok(!tenant.data.result.notices.some((n) => n.title === 'AGM for owners'),
      'a tenant is not an owner');
  });

  await t.test('a block-targeted notice reaches only that block', async () => {
    await notices.create(ctx, {
      title: 'Block B lift repair', text: 'Out of service Tuesday.', category: 'Maintenance',
      targetBlocks: [blockB._id], publishStatus: 'PUBLISHED',
    }, null);

    const owner = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${society._id}`, {
      headers: resJson(ownerAToken),
    });
    const tenant = await c.get(`/api/v1/app/notices/getAllNotices?societyId=${society._id}`, {
      headers: resJson(tenantBToken),
    });
    assert.ok(!owner.data.result.notices.some((n) => n.title === 'Block B lift repair'),
      'Block A does not need to know');
    assert.ok(tenant.data.result.notices.some((n) => n.title === 'Block B lift repair'));
  });

  await t.test('publishing notifies each targeted resident exactly once', async () => {
    await SocietyNotification.deleteMany({ societyId: society._id });
    const notice = await notices.create(ctx, {
      title: 'Fire drill', text: 'Saturday 10am.', category: 'Emergency', publishStatus: 'PUBLISHED',
    }, null);

    const sent = await SocietyNotification.countDocuments({
      societyId: society._id, type: 'NOTICE', referenceId: notice._id,
    });
    assert.equal(sent, 2, 'both residents');

    // Re-publishing must not send again.
    await notices.publish(ctx, notice._id, null);
    const after = await SocietyNotification.countDocuments({
      societyId: society._id, type: 'NOTICE', referenceId: notice._id,
    });
    assert.equal(after, 2, 'notificationSent makes a retry safe');
  });

  await t.test('the scheduler publishes what is due and leaves what is not', async () => {
    const due = await notices.create(ctx, {
      title: 'Scheduled past', text: 'Should go out.', category: 'General',
      publishStatus: 'SCHEDULED', scheduledAt: new Date(Date.now() - 60000),
    }, null);
    const future = await notices.create(ctx, {
      title: 'Scheduled future', text: 'Not yet.', category: 'General',
      publishStatus: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3600000),
    }, null);

    const out = await notices.publishDue();
    assert.ok(out.published >= 1);

    assert.equal((await SocietyNotice.findById(due._id).lean()).publishStatus, 'PUBLISHED');
    assert.equal((await SocietyNotice.findById(future._id).lean()).publishStatus, 'SCHEDULED');
  });

  await t.test('a scheduled notice needs a time', async () => {
    const res = await c.postJson('/api/v1/society-admin/notices', {
      title: 'No time', text: 'x', publishStatus: 'SCHEDULED',
    }, { headers: admin() });
    assert.equal(res.status, 400);
  });
});

/* --------------------------------- polls ------------------------------------ */

test('polls', async (t) => {
  const c = h.client();
  let pollId;
  let optionA;
  let optionB;

  await t.test('a poll needs at least two options', async () => {
    const res = await c.postJson('/api/v1/society-admin/polls/create', {
      title: 'One choice', options: [{ text: 'Only' }],
    }, { headers: admin() });
    assert.equal(res.status, 400);
  });

  await t.test('a poll is created as a draft with a reference', async () => {
    const res = await c.postJson('/api/v1/society-admin/polls/create', {
      title: 'Repaint the lobby?',
      description: 'Two colour options.',
      pollType: 'SINGLE_CHOICE',
      options: [{ text: 'Warm white' }, { text: 'Soft grey' }],
      settings: { allowChangeVote: true, showResultsDuring: false },
    }, { headers: admin() });
    assert.equal(res.status, 201);
    pollId = res.data.result._id;
    assert.match(res.data.result.pollId, /^PL-\d{3,}$/);
    assert.equal(res.data.result.publishStatus, 'DRAFT');
    [optionA, optionB] = res.data.result.options.map((o) => o._id);
  });

  await t.test('a draft cannot be voted in', async () => {
    const res = await c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [optionA] }, { headers: asRes(ownerAToken) },
    );
    assert.equal(res.status, 400);
  });

  await t.test('publishing snapshots the electorate', async () => {
    const res = await patch(`/api/v1/society-admin/polls/publish/${pollId}`, {}, admin());
    assert.equal(res.status, 200);
    assert.equal(res.data.result.eligibleVotersCount, 2, 'both residents were eligible at publish');
  });

  await t.test('a resident votes and the tally moves', async () => {
    const res = await c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [optionA] }, { headers: asRes(ownerAToken) },
    );
    assert.equal(res.status, 200, res.data.message);

    const poll = await SocietyPoll.findById(pollId).lean();
    assert.equal(poll.totalVotes, 1);
    assert.equal(poll.totalVoters, 1);
    assert.equal(poll.options.find((o) => String(o._id) === String(optionA)).voteCount, 1);
  });

  await t.test('results are hidden while voting is open, if configured so', async () => {
    const res = await c.get(`/api/v1/app/polls/get-details/${pollId}?societyId=${society._id}`, {
      headers: resJson(tenantBToken),
    });
    assert.equal(res.data.result.resultsVisible, false);
    assert.equal(res.data.result.options[0].voteCount, undefined, 'counts hidden, options shown');
    assert.equal(res.data.result.options.length, 2);
  });

  await t.test('an admin always sees the counts', async () => {
    const res = await c.get(`/api/v1/society-admin/polls/getById/${pollId}`, { headers: adminJson() });
    assert.equal(res.data.result.resultsVisible, true);
    assert.equal(res.data.result.turnout, 50, '1 of 2 eligible');
  });

  await t.test('changing a vote moves the counters without inflating the voter count', async () => {
    const res = await c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [optionB] }, { headers: asRes(ownerAToken) },
    );
    assert.equal(res.status, 200);

    const poll = await SocietyPoll.findById(pollId).lean();
    assert.equal(poll.options.find((o) => String(o._id) === String(optionA)).voteCount, 0);
    assert.equal(poll.options.find((o) => String(o._id) === String(optionB)).voteCount, 1);
    assert.equal(poll.totalVotes, 1, 'still one vote');
    assert.equal(poll.totalVoters, 1, 'still one voter');

    const vote = await SocietyPollVote.findOne({
      societyId: society._id, pollId, userId: ownerA._id,
    }).lean();
    assert.equal(vote.voteHistory.length, 1, 'the previous choice is kept');
  });

  await t.test('choosing more options than allowed is refused', async () => {
    const res = await c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [optionA, optionB] }, { headers: asRes(tenantBToken) },
    );
    assert.equal(res.status, 400, 'a single-choice poll takes one');
  });

  await t.test('an option from another poll is refused', async () => {
    const other = await c.postJson('/api/v1/society-admin/polls/create', {
      title: 'Other', options: [{ text: 'X' }, { text: 'Y' }],
    }, { headers: admin() });
    const foreign = other.data.result.options[0]._id;

    const res = await c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [foreign] }, { headers: asRes(tenantBToken) },
    );
    assert.equal(res.status, 400);
  });

  await t.test('two simultaneous first votes cannot both count', async () => {
    // The unique index on (poll, user, unit) is what makes this safe.
    const attempts = await Promise.all(Array.from({ length: 6 }, () => c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [optionA] }, { headers: asRes(tenantBToken) },
    )));
    const ok = attempts.filter((r) => r.status === 200);
    assert.ok(ok.length >= 1, 'at least one must land');

    const votes = await SocietyPollVote.countDocuments({
      societyId: society._id, pollId, userId: tenantB._id,
    });
    assert.equal(votes, 1, 'one voter, one row, whatever the timing');

    const poll = await SocietyPoll.findById(pollId).lean();
    assert.equal(poll.totalVoters, 2, 'two people have now voted');
  });

  await t.test('closing stops further voting and reveals results', async () => {
    await patch(`/api/v1/society-admin/polls/close/${pollId}`, {}, admin());

    const vote = await c.postJson(
      `/api/v1/app/polls/vote/${pollId}?societyId=${society._id}`,
      { selectedOptions: [optionA] }, { headers: asRes(ownerAToken) },
    );
    assert.equal(vote.status, 400);

    const res = await c.get(`/api/v1/app/polls/results/${pollId}?societyId=${society._id}`, {
      headers: resJson(ownerAToken),
    });
    assert.equal(res.data.result.closed, true);
    assert.equal(res.data.result.resultsVisible, true, 'showResultsAfter defaults on');
  });

  await t.test('the scheduler closes polls whose window has passed', async () => {
    const expiring = await polls.create({ societyId: society._id }, {
      title: 'Expiring', options: [{ text: 'A' }, { text: 'B' }],
      votingEndAt: new Date(Date.now() - 60000),
    }, null);
    await polls.publish({ societyId: society._id }, expiring._id, null);

    const out = await polls.closeExpired();
    assert.ok(out.closed >= 1);
    assert.equal((await SocietyPoll.findById(expiring._id).lean()).publishStatus, 'CLOSED');
  });
});

/* ------------------------------ lost and found ------------------------------- */

test('lost and found', async (t) => {
  const c = h.client();

  await t.test('item references are minted atomically', async () => {
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => c.postJson(
      `/api/v1/app/lost-found/create?societyId=${society._id}`,
      { type: 'LOST', itemName: `Item ${i}`, description: 'Left in the lobby.' },
      { headers: asRes(ownerAToken) },
    )));
    assert.ok(made.every((r) => r.status === 201));
    const ids = made.map((r) => r.data.result.itemId);
    assert.equal(new Set(ids).size, 8);
    for (const id of ids) assert.match(id, /^LF-\d{3,}$/);
  });

  await t.test('a resident report records who reported it', async () => {
    const item = await SocietyLostAndFound.findOne({ societyId: society._id }).lean();
    assert.equal(item.reporterModel, 'SocietyUnitOccupancy');
    assert.ok(item.reportedBy);
  });

  await t.test('an admin report records the admin instead', async () => {
    const res = await c.postJson('/api/v1/society-admin/lost-found/add', {
      type: 'FOUND', itemName: 'Set of keys', description: 'Handed in at the gate.',
    }, { headers: admin() });
    assert.equal(res.status, 201);
    assert.equal(res.data.result.reporterModel, 'SocietyAdmin');
  });
});

/* ---------------------------- the rest of the module -------------------------- */

test('galleries, documents and emergency numbers', async (t) => {
  const c = h.client();

  await t.test('block galleries and society galleries are one collection', async () => {
    await c.postJson('/api/v1/society-admin/building-galleries/create-gallary', {
      galleryType: 'Block', title: 'Block A facade', blockId: [String(blockA._id)],
      images: ['/uploads/a1.jpg', '/uploads/a2.jpg'],
    }, { headers: admin() });

    const legacy = await c.get(`/api/v1/society-galleries/blocks?societyId=${society._id}`, {
      headers: adminJson(),
    });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.data.result.galleries.length, 1, 'the legacy path reads the same rows');
    assert.equal(await SocietyGallery.countDocuments({ societyId: society._id, isDeleted: false }), 1,
      'and there is only one copy');
  });

  await t.test('an image can be removed without deleting the gallery', async () => {
    const gallery = await SocietyGallery.findOne({ societyId: society._id }).lean();
    const res = await put(
      `/api/v1/society-admin/building-galleries/remove-image/${gallery._id}`,
      { image: '/uploads/a1.jpg' }, admin(),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.result.images, ['/uploads/a2.jpg']);
  });

  await t.test('a document type in use cannot be deleted', async () => {
    const type = await c.postJson('/api/v1/society-admin/society-documents/type/create', {
      typeName: 'Bye-laws',
    }, { headers: admin() });
    const typeId = type.data.result._id;

    await c.postJson('/api/v1/society-admin/society-documents/document/create', {
      documentName: 'Bye-laws 2026', documentTypeId: typeId, documentFile: 'private/byelaws.pdf',
    }, { headers: admin() });

    const res = await del(`/api/v1/society-admin/society-documents/type/delete/${typeId}`, undefined, admin());
    assert.equal(res.status, 409);
  });

  await t.test('residents see only active emergency numbers', async () => {
    await c.postJson('/api/v1/society-admin/emergency-numbers/create', {
      name: 'Fire', emergencyNumber: '101', countryCode: '+91',
    }, { headers: admin() });
    const inactive = await c.postJson('/api/v1/society-admin/emergency-numbers/create', {
      name: 'Old office', emergencyNumber: '999', countryCode: '+91',
    }, { headers: admin() });
    await put(`/api/v1/society-admin/emergency-numbers/update/${inactive.data.result._id}`,
      { status: 'INACTIVE' }, admin());

    const res = await c.get(`/api/v1/app/emergency/list?societyId=${society._id}`, {
      headers: resJson(ownerAToken),
    });
    const names = res.data.result.emergencyNumbers.map((x) => x.name);
    assert.ok(names.includes('Fire'));
    assert.ok(!names.includes('Old office'));
  });
});

/* ------------------------------ notification inbox ----------------------------- */

test('the resident notification inbox', async (t) => {
  const c = h.client();

  await t.test('it counts unread', async () => {
    const res = await c.get(
      `/api/v1/app/notifications/getMyNotifications?societyId=${society._id}`,
      { headers: resJson(ownerAToken) },
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.result.unreadCount > 0, 'the notices sent earlier are waiting');
    assert.ok(res.data.result.notifications.every((n) => String(n.userId) === String(ownerA._id)),
      'only their own');
  });

  await t.test('marking one read decrements the count', async () => {
    const before = await c.get(
      `/api/v1/app/notifications/getMyNotifications?societyId=${society._id}`,
      { headers: resJson(ownerAToken) },
    );
    const first = before.data.result.notifications.find((n) => n.status === 'UNREAD');

    const res = await patch(
      `/api/v1/app/notifications/markAsRead/${first._id}?societyId=${society._id}`, {}, asRes(ownerAToken),
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.result.read, 1);

    const after = await c.get(
      `/api/v1/app/notifications/getMyNotifications?societyId=${society._id}`,
      { headers: resJson(ownerAToken) },
    );
    assert.equal(after.data.result.unreadCount, before.data.result.unreadCount - 1);
  });
});
