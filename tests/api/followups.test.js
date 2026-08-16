const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, Followup, Activity, LeadSource, Stage, SubStage, ActionType,
} = require('../../src/db/models');
const tz = require('../../src/lib/tz');

const tomorrow = (time = '10:00') => ({
  date: tz.toDateInput(new Date(Date.now() + 86400000), 'Asia/Kolkata'),
  time,
});

test('follow-up engine — no active lead without a next action (§18, §55)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Sam Seller', email: 'sam@alpha.test', roleName: 'Sales User',
  });
  const source = await LeadSource.findOne({ tenantId, category: 'MANUAL' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));
  const leadsService = require('../../src/services/leads');

  const c = h.client();
  await c.login('sam@alpha.test');

  const makeLead = async (mobile, name = 'Test Customer') => {
    const { lead } = await leadsService.create({
      tenantId, tenant: orgA.tenant, actor: orgA.admin,
      data: { firstName: name, primaryMobile: mobile, sourceId: source._id, ownerUserId: seller._id },
    });
    return lead;
  };

  t.after(async () => { await h.stopServer(); });

  await t.test('a new lead sits on the New Leads tile until it is genuinely worked (§8.2)', async () => {
    const lead = await makeLead('9811100001', 'Tile Customer');
    const before = await c.get('/app/dashboard?tile=new');
    assert.match(h.queueSection(before.text), /Tile Customer/);

    // §16.2: an interaction logged with no next action must not clear the tile.
    const rejected = await c.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      note: 'Spoke briefly',
    }, `/app/leads/${lead._id}`);
    assert.equal(rejected.status, 302);
    assert.match((await c.get(`/app/leads/${lead._id}`)).text, /cannot be left without one/i);

    const untouched = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(untouched.firstGenuineActionAt, undefined, 'the SLA clock is still running');
    assert.equal(String(untouched.stageId), String(stages.NEW._id), 'nothing was written at all');
    assert.equal(await Followup.countDocuments({ tenantId, leadId: lead._id }), 0);
    assert.match(h.queueSection((await c.get('/app/dashboard?tile=new')).text), /Tile Customer/);
  });

  await t.test('outcome plus next action clears it, and only then (§55.3)', async () => {
    const lead = await makeLead('9811100002', 'Cleared Customer');
    const sub = await SubStage.findOne({ tenantId, stageId: stages.CONNECTED._id, name: 'Interested' }).lean();
    const next = tomorrow('11:30');

    const res = await c.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      subStageId: String(sub._id),
      note: 'Wants a 3BHK facing east',
      nextActionTypeId: String(actions.BROCHURE._id),
      nextDate: next.date,
      nextTime: next.time,
    }, `/app/leads/${lead._id}`);
    assert.equal(res.status, 302);

    const updated = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.ok(updated.firstGenuineActionAt, 'the SLA clock stopped');
    assert.equal(String(updated.stageId), String(stages.CONNECTED._id));
    assert.equal(String(updated.subStageId), String(sub._id));
    assert.ok(updated.nextActionAt, 'the lead carries its next action');
    assert.equal(String(updated.nextActionTypeId), String(actions.BROCHURE._id));

    const pending = await Followup.find({ tenantId, leadId: lead._id, status: 'PENDING' }).lean();
    assert.equal(pending.length, 1);
    assert.ok(new Date(pending[0].dueAt) > new Date(), 'the next action is in the future');

    const dash = await c.get('/app/dashboard?tile=new');
    assert.ok(!h.queueSection(dash.text).includes('Cleared Customer'), 'gone from the New Leads queue');
    assert.equal(h.tileCounts(dash.text)['New leads'], 1, 'only the untouched lead remains');
  });

  await t.test('completing a follow-up without the next action is refused (§18.3)', async () => {
    const lead = await makeLead('9811100003');
    const followupsService = require('../../src/services/followups');
    const followup = await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id,
      actionTypeId: actions.CALL._id, dueAt: new Date(Date.now() + 3600000),
    });

    const res = await c.submit(`/api/followups/${followup._id}/complete`, {
      note: 'Called, no answer',
    }, `/app/leads/${lead._id}`);
    assert.equal(res.status, 302);
    assert.match((await c.get(`/app/leads/${lead._id}`)).text, /cannot be left without one/i);

    const after = await Followup.findOne({ tenantId, _id: followup._id }).lean();
    assert.equal(after.status, 'PENDING', 'the follow-up was not closed');
    assert.equal(await Followup.countDocuments({ tenantId, leadId: lead._id }), 1, 'nothing extra was created');
  });

  await t.test('completing with a next action closes one and opens the next (§18.4)', async () => {
    const lead = await makeLead('9811100004');
    const followupsService = require('../../src/services/followups');
    const followup = await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id,
      actionTypeId: actions.CALL._id, dueAt: new Date(Date.now() + 3600000),
    });
    const next = tomorrow('15:00');

    const res = await c.submit(`/api/followups/${followup._id}/complete`, {
      stageId: String(stages.CONNECTED._id),
      note: 'Connected, sending options',
      nextActionTypeId: String(actions.WHATSAPP._id),
      nextDate: next.date,
      nextTime: next.time,
    }, `/app/leads/${lead._id}`);
    assert.equal(res.status, 302);

    const closed = await Followup.findOne({ tenantId, _id: followup._id }).lean();
    assert.equal(closed.status, 'COMPLETED');
    assert.ok(closed.completedAt);
    assert.equal(closed.completedOnTime, true);
    assert.ok(closed.nextFollowupId, 'it points at the follow-up that replaced it');

    const successor = await Followup.findOne({ tenantId, _id: closed.nextFollowupId }).lean();
    assert.equal(successor.status, 'PENDING');
    assert.equal(String(successor.actionTypeId), String(actions.WHATSAPP._id));

    const types = (await Activity.find({ tenantId, leadId: lead._id }).lean()).map((a) => a.type);
    assert.ok(types.includes('CALL_COMPLETED'), 'the interaction is on the timeline');
    assert.ok(types.includes('FOLLOWUP_CREATED'));
    assert.ok(types.includes('STAGE_CHANGED'));
  });

  await t.test('a closing outcome needs no next action and cancels the open ones (§82, §113)', async () => {
    const lead = await makeLead('9811100005');
    const followupsService = require('../../src/services/followups');
    const followup = await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id,
      actionTypeId: actions.CALL._id, dueAt: new Date(Date.now() + 3600000),
    });
    await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id,
      actionTypeId: actions.WHATSAPP._id, dueAt: new Date(Date.now() + 7200000),
    });
    const lostReason = await SubStage.findOne({ tenantId, stageId: stages.LOST._id, name: 'Budget' }).lean();

    const res = await c.submit(`/api/followups/${followup._id}/complete`, {
      stageId: String(stages.LOST._id),
      subStageId: String(lostReason._id),
      note: 'Bought elsewhere',
    }, `/app/leads/${lead._id}`);
    assert.equal(res.status, 302);

    const updated = await Lead.findOne({ tenantId, _id: lead._id }).lean();
    assert.equal(updated.status, 'TERMINAL');
    assert.equal(updated.nextActionAt, undefined, 'a closed lead carries no next action');
    assert.equal(await Followup.countDocuments({ tenantId, leadId: lead._id, status: 'PENDING' }), 0);
    assert.equal((await Followup.findOne({ tenantId, _id: followup._id }).lean()).status, 'COMPLETED');
  });

  await t.test('a next action in the past is refused (§18.6)', async () => {
    const lead = await makeLead('9811100006');
    const res = await c.submit(`/api/leads/${lead._id}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      nextActionTypeId: String(actions.CALL._id),
      nextDate: tz.toDateInput(new Date(Date.now() - 172800000), 'Asia/Kolkata'),
      nextTime: '09:00',
    }, `/app/leads/${lead._id}`);
    assert.equal(res.status, 302);
    assert.match((await c.get(`/app/leads/${lead._id}`)).text, /scheduled in the future/i);
    assert.equal(await Followup.countDocuments({ tenantId, leadId: lead._id }), 0);
  });

  await t.test('a closed lead takes no new follow-ups (§18.6)', async () => {
    const lead = await makeLead('9811100007');
    const lostReason = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    const leadsService = require('../../src/services/leads');
    await leadsService.changeStage({
      tenantId, actor: orgA.admin, leadId: lead._id,
      stageId: stages.LOST._id, subStageId: lostReason._id,
    });

    const next = tomorrow();
    const res = await c.submit(`/api/leads/${lead._id}/followups`, {
      actionTypeId: String(actions.CALL._id), date: next.date, time: next.time,
    }, '/app/leads');
    assert.equal(res.status, 302);
    assert.equal(await Followup.countDocuments({ tenantId, leadId: lead._id }), 0);
  });

  await t.test('an overdue follow-up becomes Missed and shows on the tile (§18.5)', async () => {
    const lead = await makeLead('9811100008', 'Missed Customer');
    const followupsService = require('../../src/services/followups');
    await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id, actionTypeId: actions.CALL._id,
      dueAt: new Date(Date.now() - 3600000), allowPast: true,
    });

    const result = await followupsService.markMissed({ tenantId });
    assert.ok(result.missed >= 1);
    const followup = await Followup.findOne({ tenantId, leadId: lead._id }).lean();
    assert.equal(followup.status, 'MISSED');
    assert.ok(await Activity.findOne({ tenantId, leadId: lead._id, type: 'FOLLOWUP_MISSED' }));

    const dash = await c.get('/app/dashboard?tile=missed');
    assert.match(h.queueSection(dash.text), /Missed Customer/);

    // Running the job twice must not log the same miss twice (§106).
    const second = await followupsService.markMissed({ tenantId });
    assert.equal(second.missed, 0);
  });

  await t.test('a missed follow-up can still be completed, and is marked late (§92)', async () => {
    const lead = await Lead.findOne({ tenantId, requirementNote: null, status: 'ACTIVE' }).sort({ createdAt: -1 }).lean();
    const followup = await Followup.findOne({ tenantId, status: 'MISSED' }).lean();
    const next = tomorrow('12:00');

    const res = await c.submit(`/api/followups/${followup._id}/complete`, {
      note: 'Called late',
      nextActionTypeId: String(actions.CALL._id),
      nextDate: next.date,
      nextTime: next.time,
    }, `/app/leads/${followup.leadId}`);
    assert.equal(res.status, 302);

    const closed = await Followup.findOne({ tenantId, _id: followup._id }).lean();
    assert.equal(closed.status, 'COMPLETED');
    assert.equal(closed.completedOnTime, false, 'follow-up discipline sees this as late');
    assert.ok(lead || true);
  });

  await t.test('after completing from a queue the user lands back on that queue (§50)', async () => {
    const lead = await makeLead('9811100009');
    const followupsService = require('../../src/services/followups');
    const followup = await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id, actionTypeId: actions.CALL._id,
      dueAt: new Date(Date.now() + 3600000),
    });
    const next = tomorrow('16:00');

    const res = await c.submit(`/api/followups/${followup._id}/complete`, {
      returnTo: '/app/dashboard?tile=today',
      nextActionTypeId: String(actions.CALL._id),
      nextDate: next.date,
      nextTime: next.time,
    }, '/app/dashboard?tile=today');
    assert.equal(res.location, '/app/dashboard?tile=today');
  });

  await t.test('a returnTo pointing off-site is ignored', async () => {
    const lead = await makeLead('9811100010');
    const followupsService = require('../../src/services/followups');
    const followup = await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id, actionTypeId: actions.CALL._id,
      dueAt: new Date(Date.now() + 3600000),
    });
    const next = tomorrow('17:00');

    const res = await c.submit(`/api/followups/${followup._id}/complete`, {
      returnTo: 'https://evil.example.com/steal',
      nextActionTypeId: String(actions.CALL._id),
      nextDate: next.date,
      nextTime: next.time,
    }, `/app/leads/${lead._id}`);
    assert.equal(res.location, `/app/leads/${lead._id}`);
  });

  await t.test('another user cannot complete work assigned to someone else', async () => {
    const other = await h.addUser({
      tenant: orgA.tenant, roles: orgA.roles, name: 'Other Rep', email: 'other@alpha.test', roleName: 'Sales User',
    });
    const lead = await makeLead('9811100011');
    const followupsService = require('../../src/services/followups');
    const followup = await followupsService.create({
      tenantId, actor: orgA.admin, leadId: lead._id, actionTypeId: actions.CALL._id,
      dueAt: new Date(Date.now() + 3600000),
    });

    const intruder = h.client();
    await intruder.login('other@alpha.test');
    const next = tomorrow();
    const res = await intruder.submit(`/api/followups/${followup._id}/complete`, {
      nextActionTypeId: String(actions.CALL._id), nextDate: next.date, nextTime: next.time,
    }, '/app/dashboard');
    assert.notEqual(res.status, 200);
    assert.equal((await Followup.findOne({ tenantId, _id: followup._id }).lean()).status, 'PENDING');
    assert.ok(other._id);
  });
});
