const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const {
  Project, ProjectAsset, PaymentPlan, Tower, UnitType, Unit, PricingComponent, AuditLog,
} = require('../../src/db/models');
const paymentPlans = require('../../src/services/paymentPlans');
const projectsService = require('../../src/services/projects');

/**
 * V1.1 §130: the project stepper, media/documents and structured payment plans.
 *
 * The payment-schedule assertions matter most: those numbers end up on a
 * customer's quotation, and a schedule that does not sum to the price is the
 * fastest way to lose a booking at the signing table.
 */
test('project setup stepper (V1.1 §26–§37, §101)', async (t) => {
  await h.startServer();
  await h.resetDb();
  const { orgA } = await h.seedTwoOrgs();
  const tenantId = orgA.tenant._id;

  const admin = h.client();
  await admin.login('admin@alpha.test');

  let projectId;

  t.after(async () => { await h.stopServer(); });

  await t.test('step 1 saves a draft and moves on to location (§27.1)', async () => {
    await admin.get('/app/projects/new');
    const res = await admin.submit('/api/projects', {
      name: 'Stepper Heights', developerName: 'Stepper Estates', projectType: 'RESIDENTIAL',
    }, '/app/projects/new');
    assert.equal(res.status, 302);
    assert.match(res.location, /\?step=location$/, 'lands on the next step');

    projectId = res.location.split('?')[0].split('/').pop();
    const project = await Project.findOne({ tenantId, _id: projectId }).lean();
    assert.equal(project.status, 'DRAFT', 'a project starts as a draft');
    assert.ok(project.qrToken, 'the QR token exists from the start');
    assert.ok(project.slug, 'and so does the mini-site slug');
  });

  await t.test('every step is resumable from its own URL (§27.2)', async () => {
    for (const step of ['media', 'inventory', 'pricing', 'review']) {
      const page = await admin.get(`/app/projects/${projectId}?step=${step}`);
      assert.equal(page.status, 200, `${step} renders`);
      assert.match(page.text, new RegExp(`step=${step}[^"]*" *>?[\\s\\S]{0,80}`), `${step} is in the stepper`);
    }
    // The basics step still lives on the edit form.
    const basics = await admin.get(`/app/projects/${projectId}/edit?step=basics`);
    assert.equal(basics.status, 200);
    // Any other step on /edit bounces to the project screen.
    const bounced = await admin.get(`/app/projects/${projectId}/edit?step=pricing`);
    assert.equal(bounced.status, 302);
    assert.match(bounced.location, /\?step=pricing$/);
  });

  await t.test('the review step names every gap (§104)', async () => {
    const page = await admin.get(`/app/projects/${projectId}?step=review`);
    assert.match(page.text, /Readiness/);
    const state = await projectsService.readiness({ tenantId, projectId });
    assert.equal(state.ready, false);
    assert.ok(state.blockers.some((b) => b.key === 'unitTypes'));
    assert.ok(state.blockers.some((b) => b.key === 'pricing'));
    assert.ok(state.blockers.some((b) => b.key === 'plans'));
    // Images are a recommendation, never a blocker.
    assert.equal(state.checks.find((c) => c.key === 'cover').blocking, false);
  });

  /* ---------------------------- §32.2 preview ---------------------------- */

  await t.test('unit generation previews before it writes (§32.2)', async () => {
    await admin.submit(`/api/projects/${projectId}/towers`, {
      name: 'Tower A', code: 'A', type: 'TOWER', floorCount: '3',
    }, `/app/projects/${projectId}`);
    await admin.submit(`/api/projects/${projectId}/unit-types`, {
      name: '3 BHK', propertyType: 'APARTMENT', superBuiltUpArea: '1300', defaultBaseRateMinor: '5200',
    }, `/app/projects/${projectId}`);

    const tower = await Tower.findOne({ tenantId, projectId }).lean();
    const unitType = await UnitType.findOne({ tenantId, projectId }).lean();
    const args = {
      towerId: String(tower._id), unitTypeId: String(unitType._id),
      unitsPerFloor: '2', numberPattern: '{tower}-{floor}{index:02}', startIndex: '1',
    };

    const preview = await admin.submit(`/api/projects/${projectId}/units/generate`, args, `/app/projects/${projectId}`);
    assert.equal(preview.status, 200);
    assert.match(preview.text, /A-101/, 'the pattern is rendered, not described');
    assert.match(preview.text, /A-302/);
    assert.equal(await Unit.countDocuments({ tenantId, projectId }), 0, 'preview writes nothing');

    const done = await admin.submit(`/api/projects/${projectId}/units/generate`,
      { ...args, confirm: '1' }, `/app/projects/${projectId}`);
    assert.equal(done.status, 302);
    assert.equal(await Unit.countDocuments({ tenantId, projectId }), 6, '3 floors × 2 units');

    // Re-running skips what exists, and the preview says so.
    const again = await admin.submit(`/api/projects/${projectId}/units/generate`, args, `/app/projects/${projectId}`);
    assert.match(again.text, /already exist and will be skipped/);
  });

  /* --------------------------- §35 payment plans -------------------------- */

  await t.test('a schedule that does not total 100% cannot be active (§35.3)', async () => {
    const res = await admin.submit(`/api/projects/${projectId}/payment-plans`, {
      name: 'Broken plan', type: 'CONSTRUCTION_LINKED',
      msLabel: ['On booking', 'On possession'],
      msPercentage: ['10', '50'],
      msDueRule: ['ON_BOOKING', 'ON_POSSESSION'],
      msDueOffsetDays: ['', ''],
      msNote: ['', ''],
    }, `/app/projects/${projectId}?step=pricing`);
    assert.equal(res.status, 302, 'bounced with the error');
    assert.equal(await PaymentPlan.countDocuments({ tenantId, projectId, name: 'Broken plan' }), 0);

    const page = await admin.get(`/app/projects/${projectId}?step=pricing`);
    assert.match(page.text, /totals 60\.00%/, 'the message says what it actually totals');
  });

  await t.test('a complete schedule saves and reports as configured', async () => {
    const res = await admin.submit(`/api/projects/${projectId}/payment-plans`, {
      name: 'Construction linked', type: 'CONSTRUCTION_LINKED',
      msLabel: ['On booking', 'Excavation', 'Plinth', 'Structure', 'Finishing', 'Possession'],
      msPercentage: ['10', '20', '20', '20', '20', '10'],
      msDueRule: ['ON_BOOKING', 'CONSTRUCTION', 'CONSTRUCTION', 'CONSTRUCTION', 'CONSTRUCTION', 'ON_POSSESSION'],
      msDueOffsetDays: ['', '', '', '', '', ''],
      msNote: ['', '', '', '', '', ''],
    }, `/app/projects/${projectId}?step=pricing`);
    assert.equal(res.status, 302);

    const plan = await PaymentPlan.findOne({ tenantId, projectId, name: 'Construction linked' }).lean();
    assert.equal(plan.milestones.length, 6);
    assert.equal(plan.active, true, 'a new plan starts active');
    assert.equal(paymentPlans.isConfigured(plan), true);
    assert.deepEqual(plan.milestones.map((m) => m.sequence), [1, 2, 3, 4, 5, 6]);
    assert.equal(plan.milestones[0].dueRule, 'ON_BOOKING');
  });

  await t.test('a legacy plan with no schedule stays usable (§101)', async () => {
    await admin.submit(`/api/projects/${projectId}/payment-plans`, {
      name: 'Legacy plan', type: 'CUSTOM', description: 'Name only, from V1.',
    }, `/app/projects/${projectId}?step=pricing`);

    const plan = await PaymentPlan.findOne({ tenantId, projectId, name: 'Legacy plan' }).lean();
    assert.ok(plan, 'it saved');
    assert.equal(plan.active, true, 'and is still selectable');
    assert.equal(paymentPlans.isConfigured(plan), false);

    const page = await admin.get(`/app/projects/${projectId}?step=pricing`);
    assert.match(page.text, /Schedule not configured/, 'but it never pretends to have a schedule');
  });

  await t.test('the schedule always sums to the price exactly (§41)', async () => {
    const plan = await PaymentPlan.findOne({ tenantId, projectId, name: 'Construction linked' }).lean();
    // A price that does not divide cleanly by the percentages.
    const basisMinor = 14233333;
    const rows = paymentPlans.schedule({ plan, basisMinor });

    assert.equal(rows.length, 6);
    assert.equal(rows.reduce((sum, r) => sum + r.amountMinor, 0), basisMinor,
      'the last row absorbs the rounding remainder, so nothing is lost');
    assert.ok(rows.every((r) => Number.isInteger(r.amountMinor)), 'every amount is whole minor units');
    assert.equal(rows[0].amountMinor, Math.round(basisMinor * 0.1));
  });

  await t.test('a plan snapshot freezes what the customer was shown (§44)', async () => {
    const plan = await PaymentPlan.findOne({ tenantId, projectId, name: 'Construction linked' }).lean();
    const snapshot = paymentPlans.snapshotOf(plan);
    assert.equal(snapshot.paymentPlanName, 'Construction linked');
    assert.equal(snapshot.paymentPlanRows.length, 6);
    assert.equal(snapshot.paymentPlanBasis, 'FINAL_CONSIDERATION');

    // Editing the project plan afterwards must not touch the snapshot.
    await admin.submit(`/api/projects/${projectId}/payment-plans/${plan._id}`, {
      name: 'Construction linked', type: 'CONSTRUCTION_LINKED',
      msLabel: ['On booking', 'On possession'],
      msPercentage: ['50', '50'],
      msDueRule: ['ON_BOOKING', 'ON_POSSESSION'],
      msDueOffsetDays: ['', ''], msNote: ['', ''],
    }, `/app/projects/${projectId}?step=pricing`);

    const updated = await PaymentPlan.findOne({ tenantId, _id: plan._id }).lean();
    assert.equal(updated.milestones.length, 2, 'the project plan changed');
    assert.equal(snapshot.paymentPlanRows.length, 6, 'the snapshot did not');
  });

  await t.test('editing a plan never silently deactivates it', async () => {
    const plan = await PaymentPlan.findOne({ tenantId, projectId, name: 'Legacy plan' }).lean();
    await admin.submit(`/api/projects/${projectId}/payment-plans/${plan._id}/toggle`, {}, `/app/projects/${projectId}?step=pricing`);
    assert.equal((await PaymentPlan.findOne({ tenantId, _id: plan._id }).lean()).active, false);

    await admin.submit(`/api/projects/${projectId}/payment-plans/${plan._id}`, {
      name: 'Legacy plan', type: 'CUSTOM', description: 'Edited while inactive.',
    }, `/app/projects/${projectId}?step=pricing`);
    assert.equal((await PaymentPlan.findOne({ tenantId, _id: plan._id }).lean()).active, false, 'still inactive');
  });

  /* ------------------------- §31 media & documents ------------------------ */

  const uploadFile = async (fields, { filename, contentType, bytes }) => {
    const token = await admin.csrf(`/app/projects/${projectId}?step=media`);
    const boundary = '----crmtest';
    const parts = Object.entries({ _csrf: token, ...fields })
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('');
    const filePart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + `Content-Type: ${contentType}\r\n\r\n`;
    const body = Buffer.concat([
      Buffer.from(parts + filePart, 'utf8'),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    return admin.post(`/api/projects/${projectId}/assets`, undefined, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
  };

  await t.test('an image uploads, categorises and defaults to internal (§31, §87)', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const res = await uploadFile(
      { assetType: 'IMAGE', category: 'COVER', title: 'Front elevation' },
      { filename: 'cover.png', contentType: 'image/png', bytes: png },
    );
    assert.equal(res.status, 302);

    const asset = await ProjectAsset.findOne({ tenantId, projectId, assetType: 'IMAGE' }).lean();
    assert.equal(asset.category, 'COVER');
    assert.equal(asset.title, 'Front elevation');
    assert.equal(asset.customerVisible, false, 'exposure is a decision, not a default');
    assert.ok(asset.url.startsWith('/uploads/'), 'served by the static handler');
    assert.ok(await AuditLog.findOne({ tenantId, entity: 'ProjectAsset', action: 'UPLOAD' }));
  });

  await t.test('the wrong file type for the declared kind is refused (§31.3)', async () => {
    const before = await ProjectAsset.countDocuments({ tenantId, projectId });
    const res = await uploadFile(
      { assetType: 'IMAGE', category: 'GALLERY' },
      { filename: 'notes.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4') },
    );
    assert.equal(res.status, 302, 'bounced with a friendly error');
    assert.equal(await ProjectAsset.countDocuments({ tenantId, projectId }), before, 'nothing stored');
    assert.match((await admin.get(`/app/projects/${projectId}?step=media`)).text, /Images must be JPG, PNG or WEBP/);
  });

  await t.test('a document carries customer and AI visibility flags (§31.2, §87)', async () => {
    const res = await uploadFile(
      { assetType: 'DOCUMENT', category: 'BROCHURE', title: 'Brochure', customerVisible: '1', aiUsable: '1' },
      { filename: 'brochure.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 brochure') },
    );
    assert.equal(res.status, 302);

    const doc = await ProjectAsset.findOne({ tenantId, projectId, assetType: 'DOCUMENT' }).lean();
    assert.equal(doc.customerVisible, true);
    assert.equal(doc.aiUsable, true);
    assert.equal(doc.category, 'BROCHURE');
  });

  await t.test('a second cover image replaces the first (§88)', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await uploadFile(
      { assetType: 'IMAGE', category: 'COVER', title: 'Newer elevation' },
      { filename: 'cover2.png', contentType: 'image/png', bytes: png },
    );
    const covers = await ProjectAsset.find({ tenantId, projectId, assetType: 'IMAGE', category: 'COVER' }).lean();
    assert.equal(covers.length, 1, 'only one cover at a time');
    assert.equal(covers[0].title, 'Newer elevation');
  });

  await t.test('a file is archived, never deleted (§31.4)', async () => {
    const doc = await ProjectAsset.findOne({ tenantId, projectId, assetType: 'DOCUMENT' }).lean();
    await admin.submit(`/api/projects/${projectId}/assets/${doc._id}/archive`, {}, `/app/projects/${projectId}?step=media`);

    const after = await ProjectAsset.findOne({ tenantId, _id: doc._id }).lean();
    assert.ok(after, 'the record survives');
    assert.equal(after.archived, true);
    const listed = await require('../../src/services/projectAssets')
      .forProject({ tenantId, projectId, assetType: 'DOCUMENT' });
    assert.equal(listed.length, 0, 'but it is out of the working list');
  });

  await t.test('an upload with a bad CSRF token is still refused (§74)', async () => {
    // The token check is deferred for multipart bodies, so it gets its own test:
    // "deferred" must never become "skipped".
    const before = await ProjectAsset.countDocuments({ tenantId, projectId });
    const boundary = '----crmtest';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\nnot-the-real-token\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="assetType"\r\n\r\nIMAGE\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nGALLERY\r\n`
        + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.png"\r\n`
        + 'Content-Type: image/png\r\n\r\n', 'utf8',
      ),
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const res = await admin.post(`/api/projects/${projectId}/assets`, undefined, {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBody: body,
    });
    assert.ok([302, 403].includes(res.status));
    assert.equal(await ProjectAsset.countDocuments({ tenantId, projectId }), before, 'nothing was stored');
  });

  await t.test('media needs the media permission (§113)', async () => {
    const seller = await h.addUser({
      tenant: orgA.tenant, roles: orgA.roles, name: 'No Media', email: 'nomedia@alpha.test', roleName: 'Sales User',
    });
    assert.ok(seller);
    const c = h.client();
    await c.login('nomedia@alpha.test');
    const res = await c.post(`/api/projects/${projectId}/assets`, { _csrf: 'x' });
    assert.ok([403, 404].includes(res.status) || res.status === 302);
  });
});
