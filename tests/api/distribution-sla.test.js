const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, User, AssignmentPool, Notification, Activity, Tenant, LeadSource, ActionType, Stage,
} = require('../../src/db/models');

test('round-robin distribution (§14)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  const distribution = require('../../src/services/distribution');
  const captureService = require('../../src/services/capture');

  const reps = [];
  for (const [name, email] of [['Rep One', 'r1@alpha.test'], ['Rep Two', 'r2@alpha.test'], ['Rep Three', 'r3@alpha.test']]) {
    reps.push(await h.addUser({ tenant: orgA.tenant, roles: orgA.roles, name, email, roleName: 'Sales User' }));
  }
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, {
    $set: { memberIds: reps.map((r) => r._id), escalationUserIds: [orgA.admin._id], cursor: 0 },
  });

  const capture = (mobile) => captureService.handleInquiry({
    tenantId,
    tenant: orgA.tenant,
    payload: { name: `Lead ${mobile}`, mobile, sourceCategory: 'API' },
  });

  t.after(async () => { await h.stopServer(); });

  await t.test('leads rotate evenly through the pool', async () => {
    for (let i = 0; i < 6; i += 1) await capture(`92000000${10 + i}`);
    const counts = await Promise.all(reps.map((r) => Lead.countDocuments({ tenantId, ownerUserId: r._id })));
    assert.deepEqual(counts, [2, 2, 2], 'six leads across three reps');
  });

  await t.test('concurrent captures never hand the same slot to two leads (§14.2)', async () => {
    await Lead.deleteMany({ tenantId });
    await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { cursor: 0 } });

    await Promise.all(Array.from({ length: 9 }, (_, i) => capture(`93000000${10 + i}`)));

    const counts = await Promise.all(reps.map((r) => Lead.countDocuments({ tenantId, ownerUserId: r._id })));
    assert.equal(counts.reduce((a, b) => a + b, 0), 9, 'every lead found an owner');
    assert.deepEqual(counts.sort(), [3, 3, 3], 'nine concurrent captures split evenly');
  });

  await t.test('inactive users are skipped (§14.2)', async () => {
    await User.updateOne({ tenantId, _id: reps[1]._id }, { $set: { status: 'INACTIVE' } });
    await Lead.deleteMany({ tenantId });

    for (let i = 0; i < 4; i += 1) await capture(`94000000${10 + i}`);
    assert.equal(await Lead.countDocuments({ tenantId, ownerUserId: reps[1]._id }), 0, 'the inactive rep got nothing');
    assert.equal(await Lead.countDocuments({ tenantId, ownerUserId: { $in: [reps[0]._id, reps[2]._id] } }), 4);

    await User.updateOne({ tenantId, _id: reps[1]._id }, { $set: { status: 'ACTIVE' } });
  });

  await t.test('with nobody eligible the lead waits in Unassigned and a manager is told (§14.3)', async () => {
    await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { memberIds: [] } });
    await Lead.deleteMany({ tenantId });
    await Notification.deleteMany({ tenantId });

    const { lead } = await capture('9500000010');
    const stored = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(stored.ownerUserId, null, 'left unassigned rather than given a fake owner');
    assert.ok(stored.slaTargetSeconds, 'the SLA clock still started (§14.3)');

    const notice = await Notification.findOne({ tenantId, type: 'LEAD_UNASSIGNED' }).lean();
    assert.ok(notice, 'a manager was notified');
    assert.equal(notice.severity, 'CRITICAL');

    const admin = h.client();
    await admin.login('admin@alpha.test');
    const manager = await admin.get('/app/dashboard?view=team&tile=unassigned');
    assert.equal(manager.status, 200);
    assert.match(h.queueSection(manager.text), /Lead 9500000010/);
  });

  await t.test('a manual transfer leaves the rotation pointer alone (§14.2)', async () => {
    await AssignmentPool.updateOne({ tenantId, isDefault: true }, { $set: { memberIds: reps.map((r) => r._id) } });
    const before = (await AssignmentPool.findOne({ tenantId, isDefault: true }).lean()).cursor;

    const { lead } = await capture('9600000010');
    const leadsService = require('../../src/services/leads');
    await leadsService.transfer({
      tenantId, actor: orgA.admin, leadId: lead._id, toUserId: reps[0]._id, reason: 'Manual',
    });

    const after = (await AssignmentPool.findOne({ tenantId, isDefault: true }).lean()).cursor;
    assert.equal(after, before + 1, 'only the capture moved the pointer, not the transfer');
  });
});

test('response SLA — warn, escalate, reassign (§16)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;
  const sla = require('../../src/services/sla');
  const captureService = require('../../src/services/capture');

  const reps = [];
  for (const [name, email] of [['SLA One', 's1@alpha.test'], ['SLA Two', 's2@alpha.test']]) {
    reps.push(await h.addUser({ tenant: orgA.tenant, roles: orgA.roles, name, email, roleName: 'Sales User' }));
  }
  const manager = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'SLA Manager', email: 'slamgr@alpha.test', roleName: 'Sales Manager',
  });
  await AssignmentPool.updateOne({ tenantId, isDefault: true }, {
    $set: { memberIds: reps.map((r) => r._id), escalationUserIds: [manager._id], cursor: 0 },
  });

  const tenant = await Tenant.findById(tenantId).lean();
  const minutesAgo = (n) => new Date(Date.now() - n * 60000);

  t.after(async () => { await h.stopServer(); });

  const captureAndAge = async (mobile, ageMinutes) => {
    const { lead } = await captureService.handleInquiry({
      tenantId, tenant, payload: { name: `SLA ${mobile}`, mobile, sourceCategory: 'API' },
    });
    await Lead.updateOne({ tenantId, _id: lead._id }, {
      $set: { assignedAt: minutesAgo(ageMinutes), capturedAt: minutesAgo(ageMinutes) },
    });
    return Lead.findOne({ tenantId, _id: lead._id }).lean();
  };

  await t.test('the configured target is stamped on the lead so later edits cannot rewrite it (§96)', async () => {
    const lead = await captureAndAge('9700000010', 0);
    assert.equal(lead.slaTargetSeconds, tenant.settings.slaResponseMinutes * 60);
    assert.equal(lead.slaStatus, 'PENDING');
  });

  await t.test('past the warning threshold the owner is warned once (§16.4)', async () => {
    const lead = await captureAndAge('9700000011', 6); // warning at 5 min
    await sla.tick({ tenantId });

    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(after.slaStatus, 'AT_RISK');
    assert.ok(after.slaWarningSentAt);
    assert.equal(await Notification.countDocuments({ tenantId, leadId: lead._id, type: 'SLA_WARNING' }), 1);

    await sla.tick({ tenantId });
    assert.equal(
      await Notification.countDocuments({ tenantId, leadId: lead._id, type: 'SLA_WARNING' }), 1,
      'a second pass does not send a duplicate warning',
    );
  });

  await t.test('past the escalation threshold the manager is told and the lead is breached', async () => {
    const lead = await captureAndAge('9700000012', 11); // escalation at 10 min
    await sla.tick({ tenantId });

    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(after.slaStatus, 'BREACHED');
    assert.equal(after.slaBreached, true);
    assert.ok(after.slaBreachSeconds > 0);

    const escalation = await Notification.findOne({ tenantId, leadId: lead._id, type: 'SLA_BREACHED' }).lean();
    assert.ok(escalation, 'the escalation recipient was notified');
    assert.equal(String(escalation.userId), String(manager._id));
    assert.ok(await Activity.findOne({ tenantId, leadId: lead._id, type: 'SLA_BREACHED' }));
  });

  await t.test('past the reassign threshold the lead moves to the next rep (§16.4 step 7)', async () => {
    const lead = await captureAndAge('9700000013', 16); // auto-reassign at 15 min
    const originalOwner = lead.ownerUserId;
    await sla.tick({ tenantId });

    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.notEqual(String(after.ownerUserId), String(originalOwner), 'a different rep now owns it');
    assert.equal(String(after.previousOwnerUserId), String(originalOwner));
    assert.equal(after.reassignmentCount, 1);
    assert.ok(await Activity.findOne({ tenantId, leadId: lead._id, type: 'LEAD_REASSIGNED' }));

    // §16.4: previous owner, new owner and manager all hear about it.
    assert.ok(await Notification.findOne({ tenantId, userId: originalOwner, type: 'LEAD_REASSIGNED_AWAY' }));
    assert.ok(await Notification.findOne({ tenantId, userId: after.ownerUserId, type: 'LEAD_ASSIGNED', leadId: lead._id }));
    assert.ok(await Notification.findOne({ tenantId, userId: manager._id, type: 'LEAD_REASSIGNED' }));
  });

  await t.test('reassignment stops at the configured maximum (§16.1)', async () => {
    const lead = await captureAndAge('9700000014', 40);
    await Lead.updateOne({ tenantId, _id: lead._id }, { $set: { reassignmentCount: 2 } }); // max is 2
    const before = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    await sla.tick({ tenantId });
    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(String(after.ownerUserId), String(before.ownerUserId), 'it stops bouncing');
    assert.equal(after.reassignmentCount, 2);
  });

  await t.test('a genuine first action stops the clock; a call alone does not (§16.2)', async () => {
    const lead = await captureAndAge('9700000015', 2);
    const owner = await User.findOne({ tenantId, _id: lead.ownerUserId }).lean();
    const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
    const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));

    const c = h.client();
    await c.login(owner.email);

    // A logged call with no next action leaves the clock running.
    await c.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id), note: 'Rang, no answer',
    }, `/app/leads/${lead._id}`);
    let after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(after.firstGenuineActionAt, undefined);
    assert.notEqual(after.slaStatus, 'WITHIN_SLA');

    const tz = require('../../src/lib/tz');
    await c.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      nextActionTypeId: String(actions.CALL._id),
      nextDate: tz.toDateInput(new Date(Date.now() + 86400000), 'Asia/Kolkata'),
      nextTime: '10:00',
    }, `/app/leads/${lead._id}`);

    after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.ok(after.firstGenuineActionAt, 'now it counts');
    assert.equal(after.slaStatus, 'WITHIN_SLA');
    assert.ok(after.firstResponseSeconds >= 120, 'response time measured from assignment (§92)');

    const before = await Notification.countDocuments({ tenantId, leadId: lead._id });
    await sla.tick({ tenantId });
    assert.equal(await Notification.countDocuments({ tenantId, leadId: lead._id }), before, 'an answered lead is left alone');
  });

  await t.test('a lead that already breached stays breached after a later answer (§16.5)', async () => {
    const lead = await captureAndAge('9700000016', 12);
    await sla.tick({ tenantId });
    const owner = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    const leadsService = require('../../src/services/leads');
    await leadsService.recordFirstGenuineAction({
      tenantId, lead: await Lead.findOne({ tenantId, _id: lead._id }).lean(),
    });
    const after = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(after.slaBreached, true);
    assert.equal(after.slaStatus, 'BREACHED');
    assert.ok(owner);
  });

  await t.test('a project SLA override wins over the organization default (§16.1)', async () => {
    const { Project, SlaRule } = require('../../src/db/models');
    const project = await Project.create({ tenantId, name: 'Fast Response Tower', status: 'ACTIVE' });
    await SlaRule.create({
      tenantId, projectId: project._id, responseMinutes: 2, warningMinutes: 2,
      escalationMinutes: 3, autoReassignMinutes: 4, maxAutoReassignments: 1,
    });

    const rule = await sla.resolveRule({ tenantId, tenant, projectId: project._id });
    assert.equal(rule.targetSeconds, 120);
    const orgRule = await sla.resolveRule({ tenantId, tenant, projectId: null });
    assert.equal(orgRule.targetSeconds, tenant.settings.slaResponseMinutes * 60);
  });
});
