const express = require('express');
const { z } = require('zod');
const { requireAuth, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const f = require('../lib/fields');
const { notFound } = require('../lib/errors');

const societies = require('../services/society/societies');
const developers = require('../services/society/developers');
const inquiries = require('../services/society/inquiries');
const stagesService = require('../services/society/stages');
const rolesService = require('../services/society/roles');
const { Society, SocietyAdmin } = require('../db/models/society');

/**
 * `/app/society/*` — the society admin UI, in EJS.
 *
 * A separate surface from `/api/v1/*`, deliberately. That one reproduces the
 * mobile contract for the resident app and the gate device; this one is for CRM
 * staff and speaks this codebase's own idiom — session cookie, CSRF token,
 * `requirePermission`, zod validation, form posts that redirect.
 *
 * Both call the same `services/society/*`, so a rule fixed once is fixed for
 * both. Nothing here is a proxy to the JSON API.
 */
const router = express.Router();

router.use('/app/society', requireAuth);

/** The society services take a `ctx`; CRM staff act platform-wide. */
const ctx = (req) => ({ actorId: req.user?._id || null });

const flash = (req, message, type = 'success') => {
  req.session.flash = { type, message };
};

/* -------------------------------- societies -------------------------------- */

const societySchema = z.object({
  societyName: f.requiredText(150, 'Enter the society name.'),
  societyCode: f.optionalText(20),
  description: f.optionalText(500),
  projectType: f.enumField(['Residential', 'Commercial', 'Mixed Use']),
  developerId: f.optionalId,
  totalBlocks: f.optionalNumber,
  totalFloors: f.optionalNumber,
  totalUnits: f.optionalNumber,
  includeGroundFloor: f.optionalText(10),
  contactPersonName: f.requiredText(120, 'Enter the contact person.'),
  contactNumber: f.requiredText(20, 'Enter a contact number.'),
  email: f.requiredText(150, 'Enter an email address.'),
  alternateContact: f.optionalText(20),
  status: f.enumField(['Active', 'Pending', 'Inactive']),
  'address.street': f.requiredText(200, 'Enter the street.'),
  'address.city': f.requiredText(80, 'Enter the city.'),
  'address.state': f.requiredText(80, 'Enter the state.'),
  'address.pincode': f.requiredText(12, 'Enter the pincode.'),
});

/** Flat `address.city` form fields back into the nested shape the model wants. */
function shapeSociety(data) {
  const out = { ...data };
  out.address = {
    street: out['address.street'],
    city: out['address.city'],
    state: out['address.state'],
    pincode: out['address.pincode'],
  };
  for (const k of Object.keys(out)) if (k.startsWith('address.')) delete out[k];
  out.includeGroundFloor = String(data.includeGroundFloor) === 'true';
  if (!out.societyCode) delete out.societyCode;
  if (!out.developerId) out.developerId = null;
  return out;
}

router.get('/app/society/societies', requirePermission('society.view'), async (req, res, next) => {
  try {
    const page = await societies.list(ctx(req), { ...req.query, limit: 20 });
    const stats = await societies.platformStats();

    // One aggregate for the whole page's unit counts, not one query per row.
    const { SocietyUnit } = require('../db/models/society');
    const counts = await SocietyUnit.aggregate([
      { $match: { societyId: { $in: page.societies.map((s) => s._id) }, isDeleted: false } },
      { $group: { _id: '$societyId', n: { $sum: 1 } } },
    ]).option({ allowCrossSociety: true });
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));

    res.render('pages/society/list', {
      title: 'Societies',
      societies: page.societies.map((s) => ({ ...s, unitCount: byId.get(String(s._id)) || 0 })),
      pagination: page.pagination,
      stats,
      filters: {
        search: req.query.search || '',
        status: req.query.status || '',
        projectType: req.query.projectType || '',
      },
    });
  } catch (err) { next(err); }
});

router.get('/app/society/societies/new', requirePermission('society.create'), async (req, res, next) => {
  try {
    res.render('pages/society/form', {
      title: 'New society',
      society: null,
      developers: await developers.all(ctx(req), {}),
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies', requirePermission('society.create'), validate(societySchema), async (req, res, next) => {
  try {
    const result = await societies.create(ctx(req), shapeSociety(req.data), req.user._id);
    const { blocks, floors, units } = result.structure;
    flash(req, `${result.society.societyName} created — ${blocks.inserted} blocks, ${floors.inserted} floors, ${units.inserted} units generated.`);
    res.redirect(`/app/society/societies/${result.society._id}`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id', requirePermission('society.view'), async (req, res, next) => {
  try {
    const [{ society, blocks }, stats] = await Promise.all([
      societies.details(req.params.id),
      societies.statistics(req.params.id),
    ]);

    /**
     * The chairman's dashboard is a list of things waiting on a person, not a
     * chart. Each figure is a queue somebody has to clear, and each links to
     * the screen that clears it — a number with nowhere to go is decoration.
     */
    const c = { societyId: society._id, society };
    const [complaintStats, moneyStats, requests, gate, parkingQueue] = await Promise.all([
      require('../services/society/complaints').stats(c),
      require('../services/society/billing').societyStats(c),
      require('../services/society/onboarding').list(c, { status: 'Pending', limit: 1 }),
      require('../services/society/visitors').stats(c),
      require('../services/society/parking').pendingRequests(c),
    ]);

    res.render('pages/society/detail', {
      title: society.societyName,
      society,
      blocks,
      stats,
      attention: {
        onboarding: requests.pagination?.total ?? 0,
        complaints: complaintStats.open,
        unassignedComplaints: complaintStats.unassigned,
        unpaidBills: moneyStats.unpaidCount,
        outstandingMinor: moneyStats.outstandingMinor,
        visitorsWaiting: gate.awaitingApproval,
        visitorsInside: gate.currentlyInside,
        parkingRequests: parkingQueue.length,
      },
    });
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/edit', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const society = await Society.findOne({ _id: req.params.id, isDeleted: false }).lean();
    if (!society) throw notFound('That society could not be found.');
    res.render('pages/society/form', {
      title: `Edit ${society.societyName}`,
      society,
      developers: await developers.all(ctx(req), {}),
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id', requirePermission('society.edit'), validate(societySchema), async (req, res, next) => {
  try {
    const data = shapeSociety(req.data);
    // The code is the society's permanent identifier; the form renders it
    // read-only and the service must not accept a change through this path.
    delete data.societyCode;
    const society = await societies.update(ctx(req), req.params.id, data, req.user._id);
    flash(req, `${society.societyName} updated.`);
    res.redirect(`/app/society/societies/${req.params.id}`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/delete', requirePermission('society.delete'), async (req, res, next) => {
  try {
    const society = await societies.remove(ctx(req), req.params.id, req.user._id);
    flash(req, `${society.societyName} deactivated.`);
    res.redirect('/app/society/societies');
  } catch (err) { next(err); }
});

/* --------------------- one society: structure and people -------------------- */

const blocksService = require('../services/society/blocks');
const floorsService = require('../services/society/floors');
const unitsService = require('../services/society/units');
const employeesService = require('../services/society/employees');
const onboardingService = require('../services/society/onboarding');
const occupancyService = require('../services/society/occupancy');
const { SocietyUnitOccupancy } = require('../db/models/society');

/**
 * The per-society screens act inside one society, so their context carries a
 * `societyId` — which is what `societyGuard` requires of every query beneath.
 * It comes from the URL and the society is loaded to prove it exists.
 */
async function societyCtx(req) {
  const society = await Society.findOne({ _id: req.params.id, isDeleted: false }).lean();
  if (!society) throw notFound('That society could not be found.');
  return { society, societyId: society._id, actorId: req.user?._id || null };
}

router.get('/app/society/societies/:id/structure', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [blocks, stats] = await Promise.all([
      blocksService.withFloors(c),
      blocksService.stats(c),
    ]);
    const { SocietyUnit } = require('../db/models/society');
    const counts = await SocietyUnit.aggregate([
      { $match: { societyId: c.societyId, isDeleted: false } },
      { $group: { _id: '$blockId', n: { $sum: 1 } } },
    ]);
    const byBlock = new Map(counts.map((x) => [String(x._id), x.n]));

    res.render('pages/society/structure', {
      title: `${c.society.societyName} — structure`,
      society: c.society,
      blocks: blocks.map((b) => ({ ...b, unitCount: byBlock.get(String(b._id)) || 0 })),
      stats,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/blocks', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await blocksService.create(c, { blockName: req.body.blockName }, c.actorId);
    flash(req, `${req.body.blockName} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/structure`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/blocks/:blockId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await blocksService.remove(c, req.params.blockId, c.actorId);
    flash(req, 'Block deleted.');
    res.redirect(`/app/society/societies/${req.params.id}/structure`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/floors/bulk', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const out = await floorsService.bulkCreate(c, req.body, c.actorId);
    flash(req, `${out.inserted} floor(s) added${out.skipped ? `, ${out.skipped} already existed` : ''}.`);
    res.redirect(`/app/society/societies/${req.params.id}/structure`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/units', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, blocks, stats] = await Promise.all([
      unitsService.list(c, { ...req.query, limit: 25 }),
      blocksService.dropdown(c),
      blocksService.stats(c),
    ]);
    res.render('pages/society/units', {
      title: `${c.society.societyName} — units`,
      society: c.society,
      units: page.units,
      pagination: page.pagination,
      blocks,
      stats,
      filters: {
        search: req.query.search || '',
        blockId: req.query.blockId || '',
        occupancyStatus: req.query.occupancyStatus || '',
      },
    });
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/units/:unitId', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const unit = await unitsService.detail(c, req.params.unitId);
    const history = await SocietyUnitOccupancy.find({
      societyId: c.societyId, unitId: req.params.unitId, isCurrent: false, isDeleted: false,
    }).sort({ endDate: -1 }).lean();

    res.render('pages/society/unit-detail', {
      title: unit.unitNumber,
      society: c.society,
      unit,
      residents: unit.residents,
      history,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/units/:unitId/assign', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await unitsService.assignResident(c, req.params.unitId, req.body, c.actorId);
    flash(req, 'Resident assigned.');
    res.redirect(`/app/society/societies/${req.params.id}/units/${req.params.unitId}`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/units/:unitId/release', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await occupancyService.release({
      societyId: c.societyId, occupancyId: req.body.occupancyId, actorId: c.actorId,
    });
    flash(req, 'Resident moved out.');
    res.redirect(`/app/society/societies/${req.params.id}/units/${req.params.unitId}`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/employees', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, typePage] = await Promise.all([
      employeesService.list(c, { ...req.query, limit: 25 }),
      employeesService.types.list(c, { limit: 100 }),
    ]);
    res.render('pages/society/employees', {
      title: `${c.society.societyName} — staff`,
      society: c.society,
      employees: page.employees,
      pagination: page.pagination,
      types: typePage.employeeTypes,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/employee-types', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await employeesService.types.create(c, { typeName: req.body.typeName }, c.actorId);
    flash(req, `${req.body.typeName} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/employees`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/employee-types/:typeId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await employeesService.types.remove(c, req.params.typeId, c.actorId);
    flash(req, 'Employee type deleted.');
    res.redirect(`/app/society/societies/${req.params.id}/employees`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/employees', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const e = await employeesService.create(c, req.body, c.actorId);
    flash(req, `${e.employeeName} hired — gate MPIN ${e.mpin}.`);
    res.redirect(`/app/society/societies/${req.params.id}/employees`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/employees/:employeeId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await employeesService.remove(c, req.params.employeeId, c.actorId);
    flash(req, 'Posting ended.');
    res.redirect(`/app/society/societies/${req.params.id}/employees`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/onboarding', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const page = await onboardingService.list(c, { ...req.query, limit: 25 });
    res.render('pages/society/onboarding', {
      title: `${c.society.societyName} — onboarding`,
      society: c.society,
      requests: page.requests,
      pagination: page.pagination,
      filters: { status: req.query.status || '' },
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/onboarding/:requestId', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const out = await onboardingService.process(c, req.params.requestId, {
      action: req.body.action, rejectedReason: req.body.rejectedReason,
    }, c.actorId);
    flash(req, `Request ${out.status.toLowerCase()}.`);
    res.redirect(`/app/society/societies/${req.params.id}/onboarding`);
  } catch (err) { next(err); }
});

const membersService = require('../services/society/members');
const committeeService = require('../services/society/committee');

router.get('/app/society/societies/:id/members', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const page = await membersService.societyMembers(c, { ...req.query, limit: 25 });

    // Family counts for the page in one query, rather than one per household.
    const ids = page.members.map((m) => m._id);
    const family = await SocietyUnitOccupancy.aggregate([
      {
        $match: {
          societyId: c.societyId, parentOccupancyId: { $in: ids }, isCurrent: true, isDeleted: false,
        },
      },
      { $group: { _id: '$parentOccupancyId', n: { $sum: 1 } } },
    ]);
    const byParent = new Map(family.map((f) => [String(f._id), f.n]));

    const [owners, tenants, familyTotal] = await Promise.all([
      SocietyUnitOccupancy.countDocuments({
        societyId: c.societyId, memberRole: 'PRIMARY', residentType: 'Owner', isCurrent: true, isDeleted: false,
      }),
      SocietyUnitOccupancy.countDocuments({
        societyId: c.societyId, memberRole: 'PRIMARY', residentType: 'Tenant', isCurrent: true, isDeleted: false,
      }),
      SocietyUnitOccupancy.countDocuments({
        societyId: c.societyId, memberRole: 'FAMILY', isCurrent: true, isDeleted: false,
      }),
    ]);

    res.render('pages/society/members', {
      title: `${c.society.societyName} — members`,
      society: c.society,
      members: page.members.map((m) => ({ ...m, familyCount: byParent.get(String(m._id)) || 0 })),
      pagination: page.pagination,
      counts: {
        total: page.pagination.total, owners, tenants, family: familyTotal,
      },
      filters: { search: req.query.search || '', residentType: req.query.residentType || '' },
    });
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/committee', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, roles] = await Promise.all([
      committeeService.list(c, { ...req.query, limit: 50 }),
      committeeService.roles(),
    ]);
    res.render('pages/society/committee', {
      title: `${c.society.societyName} — committee`,
      society: c.society,
      committeeMembers: page.committeeMembers,
      pagination: page.pagination,
      roles,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/committee', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await committeeService.create(c, req.body, c.actorId);
    flash(req, `${req.body.firstName} added to the committee.`);
    res.redirect(`/app/society/societies/${req.params.id}/committee`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/committee/:seatId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await committeeService.remove(c, req.params.seatId, c.actorId);
    flash(req, 'Seat removed.');
    res.redirect(`/app/society/societies/${req.params.id}/committee`);
  } catch (err) { next(err); }
});

const amenitiesService = require('../services/society/amenities');
const money = require('../lib/money');
const {
  SocietyAmenitySlot, SocietyAmenityPackage,
} = require('../db/models/society');

router.get('/app/society/societies/:id/amenities', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, typePage] = await Promise.all([
      amenitiesService.list(c, { ...req.query, limit: 25 }),
      amenitiesService.types.list(c, { limit: 100 }),
    ]);

    // Slot and package counts for the whole page in two queries.
    const ids = page.amenities.map((a) => a._id);
    const [slots, packs] = await Promise.all([
      SocietyAmenitySlot.aggregate([
        { $match: { societyId: c.societyId, amenityId: { $in: ids }, isDeleted: false } },
        { $group: { _id: '$amenityId', n: { $sum: 1 } } },
      ]),
      SocietyAmenityPackage.aggregate([
        { $match: { societyId: c.societyId, amenityId: { $in: ids }, isDeleted: false } },
        { $group: { _id: '$amenityId', n: { $sum: 1 } } },
      ]),
    ]);
    const slotBy = new Map(slots.map((x) => [String(x._id), x.n]));
    const packBy = new Map(packs.map((x) => [String(x._id), x.n]));

    res.render('pages/society/amenities', {
      title: `${c.society.societyName} — amenities`,
      society: c.society,
      amenities: page.amenities.map((a) => ({
        ...a,
        slotCount: slotBy.get(String(a._id)) || 0,
        packageCount: packBy.get(String(a._id)) || 0,
      })),
      pagination: page.pagination,
      types: typePage.amenityTypes,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/amenity-types', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await amenitiesService.types.create(c, { name: req.body.name }, c.actorId);
    flash(req, `${req.body.name} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/amenities`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/amenities', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const a = await amenitiesService.create(c, req.body, c.actorId);
    flash(req, `${a.name} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/amenities/${a._id}`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/amenities/:amenityId', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const amenity = await amenitiesService.detail(c, req.params.amenityId);
    res.render('pages/society/amenity-detail', {
      title: amenity.name, society: c.society, amenity,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/amenities/:amenityId/slots', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await amenitiesService.addSlot(c, req.params.amenityId, req.body, c.actorId);
    flash(req, 'Slot added.');
    res.redirect(`/app/society/societies/${req.params.id}/amenities/${req.params.amenityId}`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/amenities/:amenityId/slots/:slotId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await amenitiesService.slots.remove(c, req.params.slotId, c.actorId);
    flash(req, 'Slot deleted.');
    res.redirect(`/app/society/societies/${req.params.id}/amenities/${req.params.amenityId}`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/amenities/:amenityId/packages', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    // The form takes rupees; storage is paise.
    await amenitiesService.addPackage(c, req.params.amenityId, {
      name: req.body.name,
      capacity: Number(req.body.capacity),
      priceMinor: money.toMinor(req.body.price),
    }, c.actorId);
    flash(req, 'Price tier added.');
    res.redirect(`/app/society/societies/${req.params.id}/amenities/${req.params.amenityId}`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/amenities/:amenityId/packages/:packageId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await amenitiesService.packages.remove(c, req.params.packageId, c.actorId);
    flash(req, 'Price tier deleted.');
    res.redirect(`/app/society/societies/${req.params.id}/amenities/${req.params.amenityId}`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/bookings', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, amenityPage] = await Promise.all([
      amenitiesService.bookings.list(c, { ...req.query, limit: 25 }),
      amenitiesService.list(c, { limit: 100 }),
    ]);

    const { SocietyUnit: Unit } = require('../db/models/society');
    const unitIds = page.bookings.map((b) => b.unitId).filter(Boolean);
    const units = await Unit.find({ societyId: c.societyId, _id: { $in: unitIds } })
      .select('unitNumber').lean();
    const byUnit = new Map(units.map((u) => [String(u._id), u.unitNumber]));

    res.render('pages/society/bookings', {
      title: `${c.society.societyName} — bookings`,
      society: c.society,
      bookings: page.bookings.map((b) => ({ ...b, unitNumber: byUnit.get(String(b.unitId)) })),
      pagination: page.pagination,
      amenities: amenityPage.amenities,
      filters: {
        amenityId: req.query.amenityId || '',
        status: req.query.status || '',
        paymentStatus: req.query.paymentStatus || '',
      },
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/bookings/:bookingId/cancel', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await amenitiesService.cancel(c, req.params.bookingId, { reason: req.body.reason }, c.actorId);
    flash(req, 'Booking cancelled — the slot is free again.');
    res.redirect(`/app/society/societies/${req.params.id}/bookings`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/bookings/:bookingId/verify', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await amenitiesService.verifyPayment(c, req.params.bookingId, req.body, c.actorId);
    flash(req, 'Payment recorded.');
    res.redirect(`/app/society/societies/${req.params.id}/bookings`);
  } catch (err) { next(err); }
});

const complaintsService = require('../services/society/complaints');

router.get('/app/society/societies/:id/complaints', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, stats, typePage] = await Promise.all([
      complaintsService.list(c, { ...req.query, limit: 25 }),
      complaintsService.stats(c),
      complaintsService.types.list(c, { limit: 100 }),
    ]);

    // Resolve unit numbers and assignee names for the page in two queries.
    const { SocietyUnit: Unit, SocietyEmployee: Emp } = require('../db/models/society');
    const [units, staff] = await Promise.all([
      Unit.find({
        societyId: c.societyId, _id: { $in: page.complaints.map((x) => x.unitId).filter(Boolean) },
      }).select('unitNumber').lean(),
      Emp.find({
        _id: { $in: page.complaints.map((x) => x.assignedTo).filter(Boolean) },
      }).select('employeeName').lean(),
    ]);
    const unitBy = new Map(units.map((u) => [String(u._id), u.unitNumber]));
    const staffBy = new Map(staff.map((e) => [String(e._id), e.employeeName]));

    res.render('pages/society/complaints', {
      title: `${c.society.societyName} — complaints`,
      society: c.society,
      complaints: page.complaints.map((x) => ({
        ...x,
        unitNumber: unitBy.get(String(x.unitId)),
        assigneeName: staffBy.get(String(x.assignedTo)),
      })),
      pagination: page.pagination,
      stats,
      types: typePage.complaintTypes,
      filters: {
        search: req.query.search || '',
        status: req.query.status || '',
        priority: req.query.priority || '',
        complaintTypeId: req.query.complaintTypeId || '',
      },
    });
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/complaints/:complaintId', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const complaint = await complaintsService.detail(c, req.params.complaintId);

    const { SocietyUnit: Unit, SocietyEmployeeAssignment: Assign } = require('../db/models/society');
    const [unit, assignments] = await Promise.all([
      complaint.unitId ? Unit.findById(complaint.unitId).select('unitNumber').lean() : null,
      Assign.find({ societyId: c.societyId, isDeleted: false, status: 'ACTIVE' })
        .populate('employeeId', 'employeeName').lean(),
    ]);
    const employees = assignments
      .map((a) => a.employeeId)
      .filter(Boolean);

    res.render('pages/society/complaint-detail', {
      title: complaint.title,
      society: c.society,
      complaint,
      unitNumber: unit?.unitNumber,
      assigneeName: employees.find((e) => String(e._id) === String(complaint.assignedTo))?.employeeName,
      employees,
      statuses: complaintsService.ALL_STATUSES,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/complaints/:complaintId', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const change = {};
    for (const k of ['status', 'priority', 'comment']) {
      if (req.body[k]) change[k] = req.body[k];
    }
    // An empty select means "unassign", which is a real instruction.
    if (req.body.assignedTo !== undefined) change.assignedTo = req.body.assignedTo || null;
    if (req.body.resolutionNotes?.trim()) change.resolutionNotes = req.body.resolutionNotes.trim();

    await complaintsService.transition(c, req.params.complaintId, change, {
      adminId: req.user._id, name: req.user.name,
    });
    flash(req, 'Complaint updated.');
    res.redirect(`/app/society/societies/${req.params.id}/complaints/${req.params.complaintId}`);
  } catch (err) { next(err); }
});

const noticesService = require('../services/society/notices');
const pollsService = require('../services/society/polls');
const societyEnums = require('../db/models/society/enums');

router.get('/app/society/societies/:id/notices', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [page, stats, blocks] = await Promise.all([
      noticesService.list(c, { ...req.query, limit: 25 }),
      noticesService.stats(c),
      blocksService.dropdown(c),
    ]);
    res.render('pages/society/notices', {
      title: `${c.society.societyName} — notices`,
      society: c.society,
      notices: page.notices,
      pagination: page.pagination,
      stats,
      blocks,
      categories: societyEnums.noticeCategory,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/notices', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const data = {
      title: req.body.title,
      text: req.body.text,
      category: req.body.category,
      residentType: req.body.residentType,
      // The form offers one block or "All"; the model takes an array either way.
      targetBlocks: req.body.targetBlocks ? [req.body.targetBlocks] : ['All'],
      publishStatus: req.body.publishStatus,
    };
    if (req.body.publishStatus === 'SCHEDULED' && req.body.scheduledAt) {
      data.scheduledAt = new Date(req.body.scheduledAt);
    }
    await noticesService.create(c, data, c.actorId);
    flash(req, req.body.publishStatus === 'PUBLISHED' ? 'Notice published.' : 'Notice saved.');
    res.redirect(`/app/society/societies/${req.params.id}/notices`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/notices/:noticeId/publish', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await noticesService.publish(c, req.params.noticeId, c.actorId);
    flash(req, 'Notice published.');
    res.redirect(`/app/society/societies/${req.params.id}/notices`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/notices/:noticeId/delete', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await noticesService.remove(c, req.params.noticeId, c.actorId);
    flash(req, 'Notice deleted.');
    res.redirect(`/app/society/societies/${req.params.id}/notices`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/polls', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const page = await pollsService.list(c, { ...req.query, limit: 25 });
    res.render('pages/society/polls', {
      title: `${c.society.societyName} — polls`,
      society: c.society,
      polls: page.polls,
      pagination: page.pagination,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/polls', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    // Repeating fields arrive as one value or an array, depending on how many
    // the browser sent — the same pattern the projects form uses.
    const raw = req.body.option;
    const options = (Array.isArray(raw) ? raw : [raw])
      .filter((x) => x && x.trim())
      .map((text) => ({ text: text.trim() }));

    await pollsService.create(c, {
      title: req.body.title,
      description: req.body.description,
      pollType: req.body.pollType,
      options,
      votingEndAt: req.body.votingEndAt ? new Date(req.body.votingEndAt) : null,
    }, c.actorId);
    flash(req, 'Poll created as a draft — publish it when you are ready.');
    res.redirect(`/app/society/societies/${req.params.id}/polls`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/polls/:pollId/publish', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const poll = await pollsService.publish(c, req.params.pollId, c.actorId);
    flash(req, `Poll published to ${poll.eligibleVotersCount} household(s).`);
    res.redirect(`/app/society/societies/${req.params.id}/polls`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/polls/:pollId/close', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await pollsService.close(c, req.params.pollId);
    flash(req, 'Poll closed.');
    res.redirect(`/app/society/societies/${req.params.id}/polls`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/polls/:pollId', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [poll, voters] = await Promise.all([
      pollsService.detail(c, req.params.pollId, { isAdmin: true }),
      pollsService.voters(c, req.params.pollId),
    ]);
    const byId = new Map(poll.options.map((o) => [String(o._id), o.text]));
    res.render('pages/society/poll-detail', {
      title: poll.title,
      society: c.society,
      poll,
      voters,
      optionText: (id) => byId.get(String(id)) || '—',
    });
  } catch (err) { next(err); }
});

const billingService = require('../services/society/billing');

router.get('/app/society/societies/:id/billing', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [billPage, ledgerPage, catPage, stats] = await Promise.all([
      billingService.bills.list(c, { limit: 25 }),
      billingService.balanceSheets.list(c, { limit: 100 }),
      billingService.categories.list(c, { limit: 100 }),
      billingService.societyStats(c),
    ]);
    res.render('pages/society/billing', {
      title: `${c.society.societyName} — billing`,
      society: c.society,
      bills: billPage.bills,
      ledgers: ledgerPage.balanceSheets,
      categories: catPage.billCategories,
      stats,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/ledger', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await billingService.balanceSheets.create(c, req.body, c.actorId);
    flash(req, `${req.body.name} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/billing`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/bill-categories', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await billingService.categories.create(c, { name: req.body.name }, c.actorId);
    flash(req, `${req.body.name} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/billing`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/bills', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    // The form takes rupees; storage is paise.
    const bill = await billingService.bills.create(c, {
      name: req.body.name,
      billCategoryId: req.body.billCategoryId,
      balanceSheetId: req.body.balanceSheetId,
      dueDate: req.body.dueDate,
      startDate: req.body.dueDate,
      endDate: req.body.dueDate,
      selectionType: 'ALL',
      priceOwnerMinor: money.toMinor(req.body.priceOwner),
      priceTenantMinor: money.toMinor(req.body.priceTenant),
      priceCloseUnitMinor: money.toMinor(req.body.priceCloseUnit),
      publishStatus: req.body.publishStatus,
    }, c.actorId);

    flash(req, bill.generated
      ? `${bill.name} raised against ${bill.generated.inserted} unit(s).`
      : `${bill.name} saved as a draft.`);
    res.redirect(`/app/society/societies/${req.params.id}/billing`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/bills/:billId', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [bill, status] = await Promise.all([
      billingService.bills.detail(c, req.params.billId),
      billingService.paymentStatus(c, { billId: req.params.billId }),
    ]);
    res.render('pages/society/bill-detail', {
      title: bill.name, society: c.society, bill, units: status.units, summary: status.summary,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/unit-bills/:unitBillId/pay', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const out = await billingService.recordPayment(c, req.params.unitBillId, {
      amount: req.body.amount, paymentMethod: req.body.paymentMethod,
    }, c.actorId);
    flash(req, out.outstandingMinor === 0
      ? 'Payment recorded — that unit is settled.'
      : `Payment recorded. ${money.format(out.outstandingMinor)} still outstanding.`);
    res.redirect(req.get('referer') || `/app/society/societies/${req.params.id}/billing`);
  } catch (err) { next(err); }
});

const parkingService = require('../services/society/parking');

router.get('/app/society/societies/:id/parking', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [grid, requests, unitList] = await Promise.all([
      parkingService.grid(c),
      parkingService.pendingRequests(c),
      unitsService.dropdown(c),
    ]);
    res.render('pages/society/parking', {
      title: `${c.society.societyName} — parking`,
      society: c.society,
      levels: grid.levels,
      totals: grid.totals,
      requests,
      units: unitList,
    });
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/parking/levels', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await parkingService.levels.create(c, req.body, c.actorId);
    flash(req, `${req.body.levelName} added.`);
    res.redirect(`/app/society/societies/${req.params.id}/parking`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/parking/slots', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const out = await parkingService.levels.addSlots(c, req.body.levelId, req.body, c.actorId);
    flash(req, `${out.inserted} slot(s) added${out.skipped ? `, ${out.skipped} already existed` : ''}.`);
    res.redirect(`/app/society/societies/${req.params.id}/parking`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/parking/:slotId/approve', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await parkingService.processRequest(c, req.params.slotId, { approve: true }, c.actorId);
    flash(req, 'Slot allocated.');
    res.redirect(`/app/society/societies/${req.params.id}/parking`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/parking/:slotId/reject', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await parkingService.processRequest(c, req.params.slotId, { approve: false }, c.actorId);
    flash(req, 'Request rejected — the slot is free again.');
    res.redirect(`/app/society/societies/${req.params.id}/parking`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/parking/:slotId/allocate', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await parkingService.allocate(c, req.params.slotId, { unitId: req.body.unitId }, c.actorId);
    flash(req, 'Slot allocated.');
    res.redirect(`/app/society/societies/${req.params.id}/parking`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/parking/:slotId/release', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await parkingService.release(c, req.params.slotId, c.actorId);
    flash(req, 'Slot released.');
    res.redirect(`/app/society/societies/${req.params.id}/parking`);
  } catch (err) { next(err); }
});

/* ------------------------------ property board ------------------------------ */

const listingsService = require('../services/society/propertyListings');

/**
 * Read-only, deliberately. The board belongs to the residents: an office that
 * can edit or withdraw somebody's advertisement is a support ticket waiting to
 * happen, and the API has no admin write surface either.
 */
router.get('/app/society/societies/:id/listings', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const board = await listingsService.list(c, { ...req.query, perPage: 50 });
    res.render('pages/society/listings', {
      title: `${c.society.societyName} — property board`,
      society: c.society,
      listings: board.listings,
      pagination: board.pagination,
      filter: { type: req.query.type || '', furnishing: req.query.furnishing || '' },
    });
  } catch (err) { next(err); }
});

/* ------------------------------ visitors & gate ----------------------------- */

const visitorsService = require('../services/society/visitors');

router.get('/app/society/societies/:id/visitors', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const [stats, insideNow, expectedToday, recent] = await Promise.all([
      visitorsService.stats(c),
      visitorsService.inside(c),
      visitorsService.expected(c, {}),
      visitorsService.logs.list(c, { limit: 40, ...req.query }),
    ]);
    res.render('pages/society/visitors', {
      title: `${c.society.societyName} — gate`,
      society: c.society,
      stats,
      insideNow,
      expectedToday,
      recent: recent.visits,
      pagination: recent.pagination,
      filter: { status: req.query.status || '' },
    });
  } catch (err) { next(err); }
});

/**
 * An admin override, not a second approval path: `allowEntry` is the same
 * single write the gate device uses, so a visitor admitted from the office and
 * one waved through at the gate leave the same record.
 */
router.post('/app/society/societies/:id/visitors/:logId/allow', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await visitorsService.allowEntry(c, req.params.logId, { userId: c.actorId });
    flash(req, 'Visitor admitted.');
    res.redirect(`/app/society/societies/${req.params.id}/visitors`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/visitors/:logId/exit', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    await visitorsService.recordExit(c, req.params.logId, { userId: c.actorId });
    flash(req, 'Marked as left.');
    res.redirect(`/app/society/societies/${req.params.id}/visitors`);
  } catch (err) { next(err); }
});

router.post('/app/society/societies/:id/visitors/:logId/pass', requirePermission('society.edit'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const pass = await visitorsService.issuePass(
      c, req.params.logId, { validHours: Number(req.body.validHours) || 24 }, c.actorId,
    );
    flash(req, `Pass ${pass.passNumber} issued — valid until ${res.locals.h.dateTime(pass.expiresAt)}.`);
    res.redirect(`/app/society/societies/${req.params.id}/visitors`);
  } catch (err) { next(err); }
});

router.get('/app/society/societies/:id/attendance', requirePermission('society.view'), async (req, res, next) => {
  try {
    const c = await societyCtx(req);
    const report = await employeesService.monthlyReport(c, req.query);
    res.render('pages/society/attendance', {
      title: `${c.society.societyName} — staff attendance`,
      society: c.society,
      report,
    });
  } catch (err) { next(err); }
});

/* -------------------------------- analytics -------------------------------- */

router.get('/app/society/analytics', requirePermission('society.report.view'), async (req, res, next) => {
  try {
    const stats = await societies.platformStats();
    const all = await Society.find({ isDeleted: false }).sort({ societyName: 1 }).lean();
    const rows = await Promise.all(all.map(async (s) => ({
      ...await societies.statistics(s._id),
      city: s.address?.city,
    })));

    const totalUnits = rows.reduce((a, r) => a + r.totalUnits, 0);
    const occupied = rows.reduce((a, r) => a + r.occupiedUnits, 0);

    res.render('pages/society/analytics', {
      title: 'Society analytics',
      stats,
      rows,
      portfolio: { occupancyRate: totalUnits ? Number(((occupied / totalUnits) * 100).toFixed(2)) : 0 },
    });
  } catch (err) { next(err); }
});

/* -------------------------------- enquiries -------------------------------- */

router.get('/app/society/enquiries', requirePermission('society.enquiry.view'), async (req, res, next) => {
  try {
    const page = await inquiries.list(ctx(req), { ...req.query, limit: 20 });
    const [counts, tree] = await Promise.all([
      inquiries.followupCount(ctx(req), {}),
      stagesService.tree(),
    ]);
    const now = new Date();
    const query = new URLSearchParams(
      Object.entries(req.query).filter(([, v]) => v).map(([k, v]) => [k, String(v)]),
    ).toString();

    res.render('pages/society/enquiries', {
      title: 'Society enquiries',
      inquiries: page.inquiries.map((i) => ({
        ...i, isOverdue: !!i.followupDate && new Date(i.followupDate) < now && i.status === 'Pending',
      })),
      pagination: page.pagination,
      counts,
      stages: tree,
      exportQuery: query ? `?${query}` : '',
      filters: {
        search: req.query.search || '',
        status: req.query.status || '',
        stageId: req.query.stageId || '',
      },
    });
  } catch (err) { next(err); }
});

router.get('/app/society/enquiries/export', requirePermission('society.enquiry.view'), async (req, res, next) => {
  try {
    const rows = await inquiries.exportRows(ctx(req), req.query);
    const columns = rows.length ? Object.keys(rows[0]) : ['Society Name'];
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="society-enquiries.csv"');
    res.send([columns.join(','), ...rows.map((r) => columns.map((c) => escape(r[c])).join(','))].join('\n'));
  } catch (err) { next(err); }
});

router.get('/app/society/enquiries/:id', requirePermission('society.enquiry.view'), async (req, res, next) => {
  try {
    const [inquiry, history, tree] = await Promise.all([
      inquiries.detail(ctx(req), req.params.id),
      inquiries.history(req.params.id),
      stagesService.tree(),
    ]);
    const names = new Map(tree.map((s) => [String(s._id), s.title]));
    res.render('pages/society/enquiry-detail', {
      title: inquiry.societyName,
      inquiry,
      history,
      stages: tree,
      stageName: (id) => (id ? names.get(String(id)) || '—' : '—'),
    });
  } catch (err) { next(err); }
});

router.post('/app/society/enquiries/:id/followup', requirePermission('society.enquiry.manage'), async (req, res, next) => {
  try {
    await inquiries.addFollowup(ctx(req), {
      inquiryId: req.params.id,
      comments: req.body.comments,
      followupDate: req.body.followupDate || null,
      ...(req.body.stageId ? { stageId: req.body.stageId } : {}),
    }, req.user._id);

    if (req.body.status) {
      await inquiries.update(ctx(req), req.params.id, { status: req.body.status }, req.user._id);
    }
    flash(req, 'Follow-up saved.');
    res.redirect(`/app/society/enquiries/${req.params.id}`);
  } catch (err) { next(err); }
});

/* ------------------------------- developers -------------------------------- */

router.get('/app/society/developers', requirePermission('society.developer.manage'), async (req, res, next) => {
  try {
    const page = await developers.list(ctx(req), { ...req.query, perPage: 20 });
    const counts = await Society.aggregate([
      { $match: { isDeleted: false, developerId: { $ne: null } } },
      { $group: { _id: '$developerId', n: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    res.render('pages/society/developers', {
      title: 'Developers',
      developers: page.developers.map((d) => ({ ...d, societyCount: byId.get(String(d._id)) || 0 })),
      pagination: page.pagination,
    });
  } catch (err) { next(err); }
});

const developerSchema = z.object({
  firstName: f.requiredText(80, 'Enter a first name.'),
  lastName: f.requiredText(80, 'Enter a last name.'),
  mobileNumber: f.requiredText(20, 'Enter a mobile number.'),
  email: f.requiredText(150, 'Enter an email address.'),
  companyName: f.optionalText(150),
});

router.post('/app/society/developers', requirePermission('society.developer.manage'), validate(developerSchema), async (req, res, next) => {
  try {
    const dev = await developers.create(ctx(req), req.data, req.user._id);
    flash(req, `${dev.firstName} ${dev.lastName} added.`);
    res.redirect('/app/society/developers');
  } catch (err) { next(err); }
});

router.post('/app/society/developers/:id/delete', requirePermission('society.developer.manage'), async (req, res, next) => {
  try {
    await developers.remove(ctx(req), req.params.id, req.user._id);
    flash(req, 'Developer removed.');
    res.redirect('/app/society/developers');
  } catch (err) { next(err); }
});

/* ---------------------------------- roles ----------------------------------- */

router.get('/app/society/roles', requirePermission('society.role.manage'), async (req, res, next) => {
  try {
    const page = await rolesService.list(ctx(req), { perPage: 100 });
    res.render('pages/society/roles', { title: 'Society roles', roles: page.roles });
  } catch (err) { next(err); }
});

router.post('/app/society/roles/:id/delete', requirePermission('society.role.manage'), async (req, res, next) => {
  try {
    await rolesService.remove(ctx(req), req.params.id, req.user._id);
    flash(req, 'Role deleted.');
    res.redirect('/app/society/roles');
  } catch (err) { next(err); }
});

/* --------------------------------- pipeline --------------------------------- */

router.get('/app/society/pipeline', requirePermission('society.stage.manage'), async (req, res, next) => {
  try {
    res.render('pages/society/pipeline', { title: 'Enquiry pipeline', stages: await stagesService.tree() });
  } catch (err) { next(err); }
});

router.post('/app/society/pipeline', requirePermission('society.stage.manage'), async (req, res, next) => {
  try {
    const { level, parentId, title, orderBy } = req.body;
    const payload = { title, orderBy: Number(orderBy) || 0 };
    const c = ctx(req);

    if (level === 'sub') {
      await stagesService.createSubStage(c, { ...payload, societyStageId: parentId }, req.user._id);
    } else if (level === 'child') {
      await stagesService.createChildStage(c, { ...payload, societySubStageId: parentId }, req.user._id);
    } else {
      await stagesService.stages.create(c, payload, req.user._id);
    }
    flash(req, `${title} added to the pipeline.`);
    res.redirect('/app/society/pipeline');
  } catch (err) { next(err); }
});

module.exports = router;
