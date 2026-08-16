const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, LeadSource, Project, AssignmentPool, User, Notification,
} = require('../../src/db/models');
const distribution = require('../../src/services/distribution');
const allocation = require('../../src/services/allocation');

/**
 * V1.1 §132: lead allocation.
 *
 * The rotation itself was already correct and concurrency-safe; these tests cover
 * the parts V1.1 adds — the project→default fallback (§72), the setup screen's
 * guarantees (§76), and the promise that reading the preview never moves the
 * cursor (§71).
 */
test('lead allocation setup (V1.1 §66–§76)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const priya = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Priya Nair', email: 'priya@alpha.test', roleName: 'Sales User',
  });
  const vikram = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Vikram Rao', email: 'vikram@alpha.test', roleName: 'Sales User',
  });
  const rahul = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Rahul Shah', email: 'rahul@alpha.test', roleName: 'Sales User',
  });

  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const project = await Project.create({ tenantId, name: 'Green Avenue', status: 'ACTIVE' });

  const admin = h.client();
  await admin.login('admin@alpha.test');

  // The default pool ships with just the admin; make it a real rotation.
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, {
    $set: { memberIds: [priya._id, vikram._id], cursor: 0 },
  });

  t.after(async () => { await h.stopServer(); });

  await t.test('the setup screen shows the pools and who is next', async () => {
    const page = await admin.get('/app/setup/lead-allocation');
    assert.equal(page.status, 200);
    assert.match(page.text, /Default sales pool/);
    assert.match(page.text, /Next assignments/);
    assert.match(page.text, /Priya Nair/);
  });

  await t.test('the preview never advances the live cursor (§71)', async () => {
    const pool = await AssignmentPool.findOne({ tenantId, isDefault: true }).lean();
    const before = pool.cursor;
    const upcoming = await distribution.preview({ tenantId, pool });
    assert.equal(upcoming.length, 6);
    assert.equal(upcoming[0].position, 1);
    const after = await AssignmentPool.findOne({ tenantId, isDefault: true }).lean();
    assert.equal(after.cursor, before, 'looking at the rotation did not change it');
  });

  await t.test('a project rule overrides the default pool (§69)', async () => {
    const res = await admin.submit('/api/setup/assignment-pools', {
      name: 'Green Avenue team',
      scopeType: 'PROJECT',
      projectId: String(project._id),
      memberUserIds: [String(rahul._id)],
    }, '/app/setup/lead-allocation');
    assert.equal(res.status, 302);

    const created = await admin.submit('/api/leads', {
      firstName: 'Alloc', primaryMobile: '9700000001',
      sourceId: String(source._id), projectId: String(project._id), assignmentMode: 'AUTO',
    }, '/app/leads/new');
    const lead = await Lead.findOne({ tenantId, _id: created.location.split('/').pop() }).lean();
    assert.equal(String(lead.ownerUserId), String(rahul._id), 'the project rule won');
  });

  await t.test('only one active rule per project (§76)', async () => {
    await admin.submit('/api/setup/assignment-pools', {
      name: 'Second Green Avenue team',
      scopeType: 'PROJECT',
      projectId: String(project._id),
      memberUserIds: [String(priya._id)],
    }, '/app/setup/lead-allocation');
    const pools = await AssignmentPool.countDocuments({ tenantId, projectId: project._id, active: true });
    assert.equal(pools, 1, 'the duplicate rule was refused');
  });

  await t.test('a suspended member is skipped at assignment time (§70)', async () => {
    await User.updateOne({ tenantId, _id: rahul._id }, { $set: { status: 'SUSPENDED' } });

    const created = await admin.submit('/api/leads', {
      firstName: 'Skip', primaryMobile: '9700000002',
      sourceId: String(source._id), projectId: String(project._id), assignmentMode: 'AUTO',
    }, '/app/leads/new');
    const lead = await Lead.findOne({ tenantId, _id: created.location.split('/').pop() }).lean();

    // §72: the project pool has nobody eligible, so the default pool takes over
    // instead of the lead falling into a hole.
    assert.ok(lead.ownerUserId, 'the lead still found an owner');
    assert.ok(
      [String(priya._id), String(vikram._id)].includes(String(lead.ownerUserId)),
      'it fell back to the default pool',
    );
    await User.updateOne({ tenantId, _id: rahul._id }, { $set: { status: 'ACTIVE' } });
  });

  await t.test('with nobody eligible anywhere the lead waits and management is told (§72)', async () => {
    await AssignmentPool.updateMany({ tenantId }, { $set: { memberIds: [] } });

    const created = await admin.submit('/api/leads', {
      firstName: 'Orphan', primaryMobile: '9700000003',
      sourceId: String(source._id), assignmentMode: 'AUTO',
    }, '/app/leads/new');
    const lead = await Lead.findOne({ tenantId, _id: created.location.split('/').pop() }).lean();
    assert.ok(!lead.ownerUserId, 'left unassigned rather than guessed at');
    assert.equal(lead.slaStatus, 'PENDING', 'the response clock still runs');

    const alert = await Notification.findOne({ tenantId, type: 'LEAD_UNASSIGNED' }).lean();
    assert.ok(alert, 'somebody was told');
    assert.equal(alert.severity, 'CRITICAL');

    await AssignmentPool.updateOne({ tenantId, isDefault: true }, {
      $set: { memberIds: [priya._id, vikram._id] },
    });
  });

  await t.test('manual transfer does not move the rotation cursor (§74)', async () => {
    const before = (await AssignmentPool.findOne({ tenantId, isDefault: true }).lean()).cursor;
    const created = await admin.submit('/api/leads', {
      firstName: 'Manual', primaryMobile: '9700000004',
      sourceId: String(source._id), assignmentMode: 'MANUAL', ownerUserId: String(priya._id),
    }, '/app/leads/new');
    const lead = await Lead.findOne({ tenantId, _id: created.location.split('/').pop() }).lean();
    assert.equal(String(lead.ownerUserId), String(priya._id));

    const after = (await AssignmentPool.findOne({ tenantId, isDefault: true }).lean()).cursor;
    assert.equal(after, before, 'a manual assignment is not a turn in the rotation');
  });

  await t.test('a sales user cannot hand a lead to somebody else (§11.3)', async () => {
    const seller = h.client();
    await seller.login('priya@alpha.test');
    const res = await seller.submit('/api/leads', {
      firstName: 'Sneaky', primaryMobile: '9700000005',
      sourceId: String(source._id), assignmentMode: 'MANUAL', ownerUserId: String(vikram._id),
    }, '/app/leads/new');
    assert.equal(res.status, 302, 'bounced with an error');
    assert.equal(await Lead.countDocuments({ tenantId, 'contactId': { $exists: true }, ownerUserId: vikram._id, createdBy: priya._id }), 0);
  });

  await t.test('members must be active users of this organization (§76)', async () => {
    await assert.rejects(
      () => allocation.create({
        tenantId,
        actor: null,
        data: { name: 'Bad pool', scopeType: 'DEFAULT', memberUserIds: [String(new (require('mongoose').Types.ObjectId)())] },
      }),
      /active user/i,
    );
  });

  await t.test('the same user cannot appear twice in one pool (§70)', async () => {
    await assert.rejects(
      () => allocation.validate({
        tenantId,
        data: { name: 'Dupes', scopeType: 'DEFAULT', memberUserIds: [String(priya._id), String(priya._id)] },
      }),
      /cannot appear twice/i,
    );
  });

  await t.test('the default pool cannot be emptied or switched off (§72)', async () => {
    const pool = await AssignmentPool.findOne({ tenantId, isDefault: true }).lean();
    await assert.rejects(
      () => allocation.update({
        tenantId, actor: null, poolId: pool._id, data: { name: 'Default sales pool', memberUserIds: [] },
      }),
      /at least one member/i,
    );
    await assert.rejects(
      () => allocation.toggle({ tenantId, actor: null, poolId: pool._id }),
      /cannot be switched off/i,
    );
  });

  await t.test('reordering changes the rotation but not its membership (§70)', async () => {
    const pool = await AssignmentPool.findOne({ tenantId, isDefault: true }).lean();
    const reversed = pool.memberIds.map(String).reverse();
    await admin.submit(`/api/setup/assignment-pools/${pool._id}/reorder`, {
      memberUserIds: reversed,
    }, '/app/setup/lead-allocation');

    const after = await AssignmentPool.findOne({ tenantId, isDefault: true }).lean();
    assert.deepEqual(after.memberIds.map(String), reversed);

    await assert.rejects(
      () => allocation.reorder({ tenantId, actor: null, poolId: pool._id, memberUserIds: [String(priya._id)] }),
      /cannot add or remove members/i,
    );
  });
});
