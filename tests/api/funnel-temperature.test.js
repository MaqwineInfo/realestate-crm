const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Lead, LeadSource, Stage, SubStage, ActionType, LeadStageHistory, Activity, AuditLog,
  Project, Tower, UnitType, Unit, PricingComponent, UnitShortlist, SiteVisit, VisitOutcome,
} = require('../../src/db/models');
const stageHistory = require('../../src/services/stageHistory');
const temperature = require('../../src/services/temperature');

/**
 * V1.1 §128 (funnel) and §129 (temperature).
 *
 * The funnel assertions all come back to one rule: a stage is only "completed"
 * if the lead genuinely went through it. Sorting earlier in the list is not a
 * journey, and the whole point of §17.3 is that the UI stops pretending it is.
 */
test('stage funnel and lead temperature (V1.1 §14, §17, §18)', async (t) => {
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
  const connectedSub = await SubStage.findOne({ tenantId, stageId: stages.CONNECTED._id, name: 'Interested' }).lean();

  const admin = h.client();
  await admin.login('admin@alpha.test');

  const tomorrow = () => {
    const d = new Date(Date.now() + 86400000);
    return { date: d.toISOString().slice(0, 10), time: '11:00' };
  };

  const newLead = async (mobile, name = 'Funnel Customer') => {
    const res = await admin.submit('/api/leads', {
      firstName: name, primaryMobile: mobile, sourceId: String(source._id), ownerUserId: String(seller._id),
    }, '/app/leads/new');
    return res.location.split('/').pop();
  };

  t.after(async () => { await h.stopServer(); });

  /* ------------------------------- funnel ------------------------------- */

  await t.test('capture opens the journey at the New stage', async () => {
    const leadId = await newLead('9811100001');
    const rows = await LeadStageHistory.find({ tenantId, leadId }).lean();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].stageId), String(stages.NEW._id));
    assert.equal(rows[0].exitedAt, null, 'the lead is still sitting in New');
    assert.equal(rows[0].sourceAction, 'CAPTURE');

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    const funnel = await stageHistory.funnel({ tenantId, lead });
    const byName = Object.fromEntries(funnel.steps.map((s) => [s.semanticType, s.state]));
    assert.equal(byName.NEW, 'current');
    assert.equal(byName.CONNECTED, 'future');
    assert.equal(byName.BOOKED, 'future');
    assert.ok(!funnel.steps.some((s) => s.semanticType === 'LOST'), 'Lost is a branch, not a step');
  });

  await t.test('New → Connected closes the first row and opens the second', async () => {
    const leadId = await newLead('9811100002');
    const next = tomorrow();
    const res = await admin.submit(`/api/leads/${leadId}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      subStageId: String(connectedSub._id),
      note: 'Spoke to the customer',
      nextActionTypeId: String(actions.SITE_VISIT._id),
      nextDate: next.date,
      nextTime: next.time,
    }, `/app/leads/${leadId}`);
    assert.equal(res.status, 302);

    const rows = await LeadStageHistory.find({ tenantId, leadId }).sort({ enteredAt: 1 }).lean();
    assert.equal(rows.length, 2);
    assert.ok(rows[0].exitedAt, 'New was exited');
    assert.equal(rows[1].exitedAt, null);
    assert.equal(rows[1].sourceAction, 'MANUAL_OUTCOME');

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    const funnel = await stageHistory.funnel({ tenantId, lead });
    const byName = Object.fromEntries(funnel.steps.map((s) => [s.semanticType, s.state]));
    assert.equal(byName.NEW, 'completed');
    assert.equal(byName.CONNECTED, 'current');
  });

  await t.test('a skipped stage is never ticked just because it sorts earlier (§17.3)', async () => {
    const leadId = await newLead('9811100003');
    const next = tomorrow();
    // New → Connected, then straight to Visit Done. Visit Planned never happens.
    await admin.submit(`/api/leads/${leadId}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      nextActionTypeId: String(actions.CALL._id), nextDate: next.date, nextTime: next.time,
    }, `/app/leads/${leadId}`);

    const pending = await require('../../src/db/models').Followup
      .findOne({ tenantId, leadId, status: 'PENDING' }).lean();
    await admin.submit(`/api/followups/${pending._id}/complete`, {
      stageId: String(stages.VISIT_DONE._id),
      nextActionTypeId: String(actions.CALL._id), nextDate: next.date, nextTime: next.time,
    }, `/app/leads/${leadId}`);

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    const funnel = await stageHistory.funnel({ tenantId, lead });
    const byName = Object.fromEntries(funnel.steps.map((s) => [s.semanticType, s.state]));
    assert.equal(byName.NEW, 'completed');
    assert.equal(byName.CONNECTED, 'completed');
    assert.equal(byName.VISIT_PLANNED, 'skipped', 'never entered, so never completed');
    assert.equal(byName.VISIT_DONE, 'current');
    assert.equal(byName.BLOCKED, 'future');
  });

  await t.test('Lost is an exit branch, and reopening records the return', async () => {
    const leadId = await newLead('9811100004');
    const lostSub = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();

    await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.LOST._id), subStageId: String(lostSub._id), note: 'Bought elsewhere',
    }, `/app/leads/${leadId}`);

    let lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    let funnel = await stageHistory.funnel({ tenantId, lead });
    assert.ok(funnel.lost.active, 'the lost branch is flagged');
    assert.ok(!funnel.steps.some((s) => s.state === 'current'), 'no chain step is current while lost');

    await admin.submit(`/api/leads/${leadId}/reopen`, {
      stageId: String(stages.CONNECTED._id), reason: 'Customer called back',
    }, `/app/leads/${leadId}`);

    lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    funnel = await stageHistory.funnel({ tenantId, lead });
    assert.equal(funnel.lost.active, false);
    assert.equal(funnel.steps.find((s) => s.semanticType === 'CONNECTED').state, 'current');

    const rows = await LeadStageHistory.find({ tenantId, leadId }).sort({ enteredAt: 1 }).lean();
    assert.equal(rows[rows.length - 1].sourceAction, 'REOPEN');
  });

  await t.test('Blocked and Booked are marked action-only in the funnel (§93)', async () => {
    const leadId = await newLead('9811100005');
    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    const funnel = await stageHistory.funnel({ tenantId, lead });
    const actionOnly = funnel.steps.filter((s) => s.actionOnly).map((s) => s.semanticType).sort();
    assert.deepEqual(actionOnly, ['BLOCKED', 'BOOKED']);
  });

  /* ---------------------------- temperature ----------------------------- */

  await t.test('an unattended new lead is WARM, never COLD (§14.2)', async () => {
    const leadId = await newLead('9811100010');
    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperature, 'WARM');
    assert.equal(lead.temperatureMode, 'AUTO');

    const result = await temperature.evaluate({ tenantId, lead });
    assert.equal(result.temperature, 'WARM');
    assert.equal(result.unattended, true);
    assert.match(result.signals[0].label, /not attended yet/i);
  });

  await t.test('recorded progress heats the lead up, and the score explains itself', async () => {
    const leadId = await newLead('9811100011');
    const next = tomorrow();
    await admin.submit(`/api/leads/${leadId}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      nextActionTypeId: String(actions.SITE_VISIT._id), nextDate: next.date, nextTime: next.time,
    }, `/app/leads/${leadId}`);

    // A completed visit and a shortlisted unit are the real signals.
    const project = await Project.create({ tenantId, name: 'Signal Heights', status: 'ACTIVE' });
    const tower = await Tower.create({ tenantId, projectId: project._id, name: 'T1' });
    const unitType = await UnitType.create({ tenantId, projectId: project._id, name: '3 BHK', superBuiltUpArea: 1200 });
    const unit = await Unit.create({
      tenantId, projectId: project._id, towerId: tower._id, unitTypeId: unitType._id,
      unitNumber: 'S-101', saleableArea: 1200, status: 'AVAILABLE',
    });
    await PricingComponent.create({
      tenantId, projectId: project._id, name: 'Base', kind: 'BASE', calcType: 'PER_AREA', rateMinor: 500000,
    });
    const outcome = await VisitOutcome.findOne({ tenantId, name: 'Highly Interested' }).lean();
    await SiteVisit.create({
      tenantId, leadId, projectId: project._id, scheduledAt: new Date(), status: 'COMPLETED',
      outcomeId: outcome._id, salesUserId: seller._id,
      contactId: (await Lead.findOne({ tenantId, _id: leadId }).lean()).contactId,
    });
    await UnitShortlist.create({ tenantId, leadId, unitId: unit._id, projectId: project._id, active: true });
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $set: { budgetMaxMinor: 900000000, purpose: 'INVESTMENT', lastActivityAt: new Date() },
    });

    const result = await temperature.recalculate({ tenantId, leadId });
    // visit 20 + shortlist 10 + budget 5 + investment 5 + recent activity 10 = 50
    assert.equal(result.score, 50);
    assert.equal(result.temperature, 'WARM');
    assert.ok(result.signals.some((s) => /site visit/i.test(s.label)), 'the visit is cited');
    assert.ok(result.signals.every((s) => typeof s.points === 'number'), 'every signal carries its points');

    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperature, 'WARM');
    assert.equal(lead.temperatureScore, 50);
  });

  await t.test('a long silence cools the lead down (§14.3)', async () => {
    const leadId = await newLead('9811100012');
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $set: { firstGenuineActionAt: new Date(), lastActivityAt: new Date(Date.now() - 30 * 86400000) },
    });
    const result = await temperature.recalculate({ tenantId, leadId });
    assert.equal(result.temperature, 'COLD');
    assert.ok(result.signals.some((s) => s.points === -20), 'the 21-day decay applied');
  });

  await t.test('manual override needs a reason, and sticks until returned to auto (§14.6)', async () => {
    const leadId = await newLead('9811100013');

    const refused = await admin.submit(`/api/leads/${leadId}/temperature`, {
      mode: 'MANUAL', temperature: 'HOT',
    }, `/app/leads/${leadId}`);
    assert.equal(refused.status, 302, 'bounced back to the page with the error');
    let lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperatureMode, 'AUTO', 'a reasonless override changes nothing');

    await admin.submit(`/api/leads/${leadId}/temperature`, {
      mode: 'MANUAL', temperature: 'HOT', reason: 'Customer confirmed a decision this week',
    }, `/app/leads/${leadId}`);
    lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperature, 'HOT');
    assert.equal(lead.temperatureMode, 'MANUAL');
    assert.match(lead.temperatureOverrideReason, /confirmed a decision/);

    // Automatic scoring must not quietly undo a human decision.
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $set: { firstGenuineActionAt: new Date(), lastActivityAt: new Date(Date.now() - 40 * 86400000) },
    });
    assert.equal(await temperature.recalculate({ tenantId, leadId }), null);
    lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperature, 'HOT', 'the pin held');

    const logged = await Activity.findOne({ tenantId, leadId, type: 'TEMPERATURE_CHANGED' }).lean();
    assert.ok(logged, 'the decision is on the timeline');
    const audited = await AuditLog.findOne({ tenantId, entityId: leadId, action: 'TEMPERATURE_OVERRIDE' }).lean();
    assert.ok(audited, 'and in the audit trail');

    await admin.submit(`/api/leads/${leadId}/temperature`, { mode: 'AUTO' }, `/app/leads/${leadId}`);
    lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperatureMode, 'AUTO');
    assert.equal(lead.temperature, 'COLD', 'scoring resumed and the neglect showed');
  });

  await t.test('a closed lead shows its outcome, not a temperature (§14.5)', async () => {
    const leadId = await newLead('9811100014');
    const lostSub = await SubStage.findOne({ tenantId, stageId: stages.LOST._id }).lean();
    await admin.submit(`/api/leads/${leadId}/stage`, {
      stageId: String(stages.LOST._id), subStageId: String(lostSub._id),
    }, `/app/leads/${leadId}`);

    assert.equal(await temperature.recalculate({ tenantId, leadId }), null, 'terminal leads are not scored');

    const page = await admin.get(`/app/leads/${leadId}`);
    assert.match(page.text, /badge b-slate">Lost</, 'the badge says Lost');
    assert.doesNotMatch(page.text, /Temperature<\/h2>/, 'and the temperature card is gone');
  });

  await t.test('the decay sweep only touches stale automatic leads', async () => {
    const leadId = await newLead('9811100015');
    await Lead.updateOne({ tenantId, _id: leadId }, {
      $set: {
        firstGenuineActionAt: new Date(),
        lastActivityAt: new Date(Date.now() - 30 * 86400000),
        temperatureUpdatedAt: new Date(Date.now() - 86400000),
      },
    });
    const result = await temperature.sweep({ tenantId });
    assert.ok(result.scanned >= 1);
    const lead = await Lead.findOne({ tenantId, _id: leadId }).lean();
    assert.equal(lead.temperature, 'COLD');
  });
});
