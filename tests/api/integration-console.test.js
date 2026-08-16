const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Integration, Lead, LeadSource, Project, Stage, ActionType,
} = require('../../src/db/models');
const secretbox = require('../../src/lib/secretbox');

/**
 * V1.1 §122: the integration API console, and §99 report additions.
 *
 * The console exists so nobody has to guess the webhook contract. The one thing
 * it must never do is leak the stored signing secret while documenting how the
 * signature works.
 */
test('integration API console and report updates (V1.1 §58–§65, §99)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const seller = await h.addUser({
    tenant: orgA.tenant, roles: orgA.roles, name: 'Rep One', email: 'rep@alpha.test', roleName: 'Sales User',
  });
  const project = await Project.create({ tenantId, name: 'Console Park', status: 'ACTIVE' });
  const source = await LeadSource.findOne({ tenantId, category: 'WEBSITE' }).lean();
  const stages = Object.fromEntries((await Stage.find({ tenantId }).lean()).map((s) => [s.semanticType, s]));
  const actions = Object.fromEntries((await ActionType.find({ tenantId }).lean()).map((a) => [a.semantic, a]));

  const admin = h.client();
  await admin.login('admin@alpha.test');

  await Integration.updateOne({ tenantId, category: 'WEBSITE_WEBHOOK' }, {
    $set: { defaultProjectId: project._id, defaultSourceId: source._id },
  });

  t.after(async () => { await h.stopServer(); });

  await t.test('the console documents the whole contract (§58–§63)', async () => {
    const page = await admin.get('/app/setup/integrations');
    assert.equal(page.status, 200);

    const integration = await Integration.findOne({ tenantId, category: 'WEBSITE_WEBHOOK' }).lean();
    assert.match(page.text, new RegExp(`api/webhooks/leads/${integration.webhookKey}`), 'the endpoint URL');
    assert.match(page.text, /curl --request POST/, 'a copyable cURL');
    assert.match(page.text, /x-idempotency-key/, 'the idempotency header');
    assert.match(page.text, /Field mapping/, 'the field mapping table');
    assert.match(page.text, /Mobile is the only mandatory field/, 'and which field is mandatory');
    assert.match(page.text, /Console Park/, 'the configured default project is stated');
  });

  await t.test('every response a provider will actually get is documented (§62)', async () => {
    const page = await admin.get('/app/setup/integrations');
    assert.match(page.text, /"reinquiry": false/, '201 new lead');
    assert.match(page.text, /"reinquiry": true/, '201 re-inquiry');
    assert.match(page.text, /"duplicate": true/, '200 duplicate delivery');
    assert.match(page.text, /A valid mobile number is required/, '400');
    assert.match(page.text, /Invalid signature/, '401');
    assert.match(page.text, /Unknown webhook endpoint/, '404');
  });

  await t.test('the signature is documented but the secret is never rendered (§65)', async () => {
    const secret = 'super-secret-signing-value';
    await Integration.updateOne({ tenantId, category: 'WEBSITE_WEBHOOK' }, {
      $set: { secrets: { signingSecret: secretbox.seal(secret) } },
    });

    const page = await admin.get('/app/setup/integrations');
    assert.match(page.text, /HMAC_SHA256\(raw_request_body, signing_secret\)/, 'the rule is explained');
    assert.equal(page.text.includes(secret), false, 'the secret itself never appears');
    assert.match(page.text, /never displayed again/);

    await Integration.updateOne({ tenantId, category: 'WEBSITE_WEBHOOK' }, { $unset: { secrets: '' } });
  });

  await t.test('the test console creates a real lead and reports what resolved (§64)', async () => {
    const integration = await Integration.findOne({ tenantId, category: 'WEBSITE_WEBHOOK' }).lean();
    const before = await Lead.countDocuments({ tenantId });

    const page = await admin.get('/app/setup/integrations');
    assert.match(page.text, /creates a <strong>real lead<\/strong>/, 'the warning is explicit (§64)');

    const res = await admin.submit(`/api/setup/integrations/${integration._id}/test`, {
      mobile: '9700000123', name: 'Console Test',
    }, '/app/setup/integrations');
    assert.equal(res.status, 302);
    assert.equal(await Lead.countDocuments({ tenantId }), before + 1);

    const lead = await Lead.findOne({ tenantId }).sort({ createdAt: -1 }).lean();
    assert.equal(String(lead.projectId), String(project._id), 'the default project resolved');
    assert.equal(String(lead.latestSourceId), String(source._id), 'and the default source');
    assert.match(lead.createdVia, /^TEST:/);

    const after = await admin.get('/app/setup/integrations');
    assert.match(after.text, /Test lead created/);
    assert.match(after.text, /Console Park/);
  });

  await t.test('rotating the key changes the documented URL (§59)', async () => {
    const before = await Integration.findOne({ tenantId, category: 'WEBSITE_WEBHOOK' }).lean();
    await admin.submit(`/api/setup/integrations/${before._id}/rotate-key`, {}, '/app/setup/integrations');
    const after = await Integration.findOne({ tenantId, _id: before._id }).lean();
    assert.notEqual(after.webhookKey, before.webhookKey);

    const page = await admin.get('/app/setup/integrations');
    assert.match(page.text, new RegExp(after.webhookKey));
    assert.equal(page.text.includes(before.webhookKey), false, 'the dead URL is gone from the console');
  });

  /* ------------------------------- §99 reports ---------------------------- */

  await t.test('the lead report carries temperature and the next action (§99)', async () => {
    const created = await admin.submit('/api/leads', {
      firstName: 'Report', primaryMobile: '9700000124', sourceId: String(source._id),
      assignmentMode: 'MANUAL', ownerUserId: String(seller._id),
      purchaseTimeline: 'MONTHS_1_3', fundingType: 'HOME_LOAN',
    }, '/app/leads/new');
    const leadId = created.location.split('?')[0].split('/').pop();

    const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const rep = h.client();
    await rep.login('rep@alpha.test');
    await rep.submit(`/api/leads/${leadId}/log-action`, {
      actionTypeId: String(actions.CALL._id),
      stageId: String(stages.CONNECTED._id),
      nextActionTypeId: String(actions.CALL._id), nextDate: soon, nextTime: '10:00',
    }, `/app/leads/${leadId}`);

    const page = await admin.get('/app/reports/leads');
    assert.equal(page.status, 200);
    assert.match(page.text, /<th>Temp<\/th>/);
    assert.match(page.text, /<th>Next action<\/th>/);
    assert.match(page.text, /Temperature<\/label>/, 'and it is filterable');

    const csv = await admin.get('/app/reports/leads/export');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /Temperature,Temperature mode,Purchase timeline,Funding,Next action/);
    assert.match(csv.text, /MONTHS_1_3/);
    assert.match(csv.text, /HOME_LOAN/);
  });

  await t.test('the temperature filter actually filters (§14.8)', async () => {
    const hot = await Lead.findOne({ tenantId, status: 'ACTIVE' }).lean();
    await Lead.updateOne({ tenantId, _id: hot._id }, { $set: { temperature: 'HOT', temperatureMode: 'MANUAL' } });

    const reports = require('../../src/services/reports');
    const filtered = await reports.leadReport({
      tenantId, query: { temperature: 'HOT' }, zone: 'Asia/Kolkata', scope: {},
    });
    assert.ok(filtered.rows.length >= 1);
    assert.ok(filtered.rows.every((r) => r.temperature === 'HOT'));

    const cold = await reports.leadReport({
      tenantId, query: { temperature: 'COLD' }, zone: 'Asia/Kolkata', scope: {},
    });
    assert.ok(cold.rows.every((r) => r.temperature === 'COLD'));
  });

  await t.test('the sales report shows the shape of each book (§99)', async () => {
    const page = await admin.get('/app/reports/sales');
    assert.equal(page.status, 200);
    assert.match(page.text, /Hot \/ warm \/ cold/);
    assert.match(page.text, /not a performance measure/, 'and says what it is not');

    const reports = require('../../src/services/reports');
    const data = await reports.salesReport({ tenantId, query: {}, zone: 'Asia/Kolkata', scope: {} });
    const row = data.rows.find((r) => r.leads > 0);
    assert.ok(row, 'a row with leads exists');
    assert.equal(typeof row.hot, 'number');
    assert.equal(typeof row.warm, 'number');
    assert.equal(typeof row.cold, 'number');

    const csv = await admin.get('/app/reports/sales/export');
    assert.match(csv.text, /Hot active,Warm active,Cold active/);
  });
});
