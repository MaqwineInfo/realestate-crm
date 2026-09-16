const crypto = require('node:crypto');
const { crud } = require('./factory');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyEmployee, SocietyEmployeeType, SocietyEmployeeAssignment,
  SocietyEmployeeAttendance, SocietyRole,
} = require('../../db/models/society');

/**
 * Society staff: the person, the type they work as, and their posting.
 *
 * `SocietyEmployee` is platform-level and `SocietyEmployeeAssignment` is what
 * ties them to a society, so a guard can be posted to two societies without
 * being duplicated. The API presents them as one thing, which is why creating
 * an "employee" here writes both rows.
 */

const types = crud({
  Model: SocietyEmployeeType,
  listKey: 'employeeTypes',
  searchFields: ['typeName'],
  filterFields: ['status'],
  unique: ['typeName'],
  populate: ['roleId'],
  pageParam: 'limit',
  sort: { typeName: 1 },
});

/** A system type is seeded on society creation and must survive. */
async function removeType(ctx, id, actorId) {
  const type = await SocietyEmployeeType.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!type) throw notFound('Employee type not found');
  if (type.isSystem) throw badRequest('Cannot delete a system employee type.');

  const inUse = await SocietyEmployeeAssignment.countDocuments({
    societyId: ctx.societyId, employeeTypeId: id, isDeleted: false, status: 'ACTIVE',
  });
  if (inUse > 0) throw conflict(`Cannot delete this type — ${inUse} employee(s) are assigned to it.`);
  return types.remove(ctx, id, actorId);
}

/**
 * A 4-digit MPIN, unique within the society.
 *
 * `crypto.randomInt` rather than `Math.random`: this is a credential a guard
 * types into the gate device. The retry loop handles collisions, and the
 * partial unique index on `(societyId, mpin)` is what actually guarantees it —
 * the loop only avoids the error.
 */
async function generateMpin(societyId, attempts = 10) {
  for (let i = 0; i < attempts; i += 1) {
    const mpin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const taken = await SocietyEmployeeAssignment.findOne({
      societyId, mpin, isDeleted: false,
    }).select('_id').lean();
    if (!taken) return mpin;
  }
  throw conflict('Could not allocate a free MPIN for this society.');
}

/** Employees of this society, joined through their postings. */
async function list(ctx, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const size = Math.max(1, parseInt(query.limit, 10) || 10);

  const filter = { societyId: ctx.societyId, isDeleted: false };
  if (query.employeeTypeId) filter.employeeTypeId = query.employeeTypeId;
  if (query.status) filter.status = query.status;

  const [assignments, total] = await Promise.all([
    SocietyEmployeeAssignment.find(filter)
      .populate('employeeId')
      .populate('employeeTypeId', 'typeName roleId')
      .sort({ createdAt: -1 }).skip((page - 1) * size).limit(size)
      .lean(),
    SocietyEmployeeAssignment.countDocuments(filter),
  ]);

  // Search matches the person, which lives on the joined document.
  let rows = assignments;
  if (query.search?.trim()) {
    const re = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    rows = rows.filter((a) => re.test(a.employeeId?.employeeName || '')
      || re.test(a.employeeId?.mobileNumber || ''));
  }

  return {
    employees: rows.map(shape),
    pagination: { total, page, limit: size, totalPages: Math.ceil(total / size) },
  };
}

/** One row per posting, flattened the way the source's clients expect. */
const shape = (a) => ({
  _id: a.employeeId?._id,
  assignmentId: a._id,
  employeeName: a.employeeId?.employeeName,
  mobileNumber: a.employeeId?.mobileNumber,
  countryCode: a.employeeId?.countryCode,
  email: a.employeeId?.email,
  address: a.employeeId?.address,
  profilePicture: a.employeeId?.profilePicture,
  policeVerificationStatus: a.employeeId?.policeVerificationStatus,
  employeeType: a.employeeTypeId?.typeName,
  employeeTypeId: a.employeeTypeId?._id,
  dateOfJoining: a.dateOfJoining,
  dateOfLeaving: a.dateOfLeaving,
  salaryPerMonth: a.salaryPerMonthMinor,
  phoneLock: a.phoneLock,
  mpin: a.mpin,
  status: a.status,
});

async function detail(ctx, employeeId) {
  const assignment = await SocietyEmployeeAssignment.findOne({
    societyId: ctx.societyId, employeeId, isDeleted: false,
  }).populate('employeeId').populate('employeeTypeId', 'typeName roleId').lean();
  if (!assignment) throw notFound('Employee not found in this society');
  return shape(assignment);
}

/**
 * Registers a person and posts them to this society.
 *
 * Upsert on mobile number, because the platform-level employee may already
 * exist from another society. A second posting to the *same* society is
 * refused by the assignment's partial unique index.
 */
async function create(ctx, data, actorId) {
  if (!data.mobileNumber) throw badRequest('A mobile number is required.');
  const type = await SocietyEmployeeType.findOne({
    societyId: ctx.societyId, _id: data.employeeTypeId, isDeleted: false,
  }).lean();
  if (!type) throw badRequest('That employee type does not exist in this society.');

  await SocietyEmployee.updateOne(
    { mobileNumber: data.mobileNumber, isDeleted: false },
    {
      $setOnInsert: { mobileNumber: data.mobileNumber, createdBy: actorId || null },
      $set: {
        employeeName: data.employeeName,
        countryCode: data.countryCode || '+91',
        email: data.email || null,
        address: data.address || null,
        profilePicture: data.profilePicture || null,
        idProofFront: data.idProofFront || null,
        idProofBack: data.idProofBack || null,
        policeVerificationDoc: data.policeVerificationDoc || null,
        ...(data.policeVerificationStatus ? { policeVerificationStatus: data.policeVerificationStatus } : {}),
      },
    },
    { upsert: true },
  );
  const employee = await SocietyEmployee.findOne({
    mobileNumber: data.mobileNumber, isDeleted: false,
  }).lean();

  const existing = await SocietyEmployeeAssignment.findOne({
    societyId: ctx.societyId, employeeId: employee._id, isDeleted: false,
  }).lean();
  if (existing) throw conflict('That person is already an employee of this society.');

  const assignment = await SocietyEmployeeAssignment.create({
    societyId: ctx.societyId,
    employeeId: employee._id,
    employeeTypeId: type._id,
    dateOfJoining: data.dateOfJoining || new Date(),
    salaryPerMonthMinor: data.salaryPerMonth ? Number(data.salaryPerMonth) : null,
    phoneLock: Boolean(data.phoneLock),
    mpin: await generateMpin(ctx.societyId),
  });

  return shape({ ...assignment.toObject(), employeeId: employee, employeeTypeId: type });
}

async function update(ctx, employeeId, data, actorId) {
  const assignment = await SocietyEmployeeAssignment.findOne({
    societyId: ctx.societyId, employeeId, isDeleted: false,
  });
  if (!assignment) throw notFound('Employee not found in this society');

  const person = {};
  for (const k of ['employeeName', 'email', 'address', 'profilePicture',
    'idProofFront', 'idProofBack', 'policeVerificationDoc', 'policeVerificationStatus']) {
    if (data[k] !== undefined) person[k] = data[k];
  }
  if (Object.keys(person).length) {
    await SocietyEmployee.updateOne({ _id: employeeId }, { $set: { ...person, updatedBy: actorId } });
  }

  const posting = {};
  if (data.employeeTypeId !== undefined) posting.employeeTypeId = data.employeeTypeId;
  if (data.dateOfJoining !== undefined) posting.dateOfJoining = data.dateOfJoining;
  if (data.dateOfLeaving !== undefined) posting.dateOfLeaving = data.dateOfLeaving;
  if (data.salaryPerMonth !== undefined) posting.salaryPerMonthMinor = Number(data.salaryPerMonth);
  if (data.phoneLock !== undefined) posting.phoneLock = Boolean(data.phoneLock);
  if (data.status !== undefined) posting.status = data.status;
  if (Object.keys(posting).length) {
    await SocietyEmployeeAssignment.updateOne({ _id: assignment._id }, { $set: posting });
  }

  return detail(ctx, employeeId);
}

/** Ends the posting, not the person — they may still work elsewhere. */
async function remove(ctx, employeeId, actorId) {
  const assignment = await SocietyEmployeeAssignment.findOneAndUpdate(
    { societyId: ctx.societyId, employeeId, isDeleted: false },
    { $set: { isDeleted: true, deletedAt: new Date(), status: 'INACTIVE', dateOfLeaving: new Date() } },
    { new: true },
  ).lean();
  if (!assignment) throw notFound('Employee not found in this society');
  return { employeeId, endedAt: assignment.dateOfLeaving };
}

/**
 * One employee's month of attendance, with the totals the report shows.
 * Hours come from `totalSeconds`, which is written when the row is closed —
 * an open row (still on site) contributes nothing rather than a partial day.
 */
async function monthlyAttendance(ctx, employeeId, { month, year }) {
  const m = Number(month) || new Date().getMonth() + 1;
  const y = Number(year) || new Date().getFullYear();
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));

  const rows = await SocietyEmployeeAttendance.find({
    societyId: ctx.societyId, employeeId, clockInTime: { $gte: from, $lt: to },
  }).sort({ clockInTime: 1 }).lean();

  const seconds = rows.reduce((a, r) => a + (r.totalSeconds || 0), 0);
  const days = new Set(rows.map((r) => new Date(r.clockInTime).toISOString().slice(0, 10)));

  return {
    employeeId,
    month: m,
    year: y,
    daysPresent: days.size,
    totalSeconds: seconds,
    totalHours: Number((seconds / 3600).toFixed(2)),
    entries: rows,
  };
}

/** Every employee's totals for a month — the society-wide report. */
async function monthlyReport(ctx, { month, year }) {
  const m = Number(month) || new Date().getMonth() + 1;
  const y = Number(year) || new Date().getFullYear();
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));

  const grouped = await SocietyEmployeeAttendance.aggregate([
    { $match: { societyId: ctx.societyId, clockInTime: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: '$employeeId',
        totalSeconds: { $sum: { $ifNull: ['$totalSeconds', 0] } },
        days: { $addToSet: { $dateToString: { format: '%Y-%m-%d', date: '$clockInTime' } } },
      },
    },
  ]);

  const employees = await SocietyEmployee.find({
    _id: { $in: grouped.map((g) => g._id) },
  }).select('employeeName mobileNumber').lean();
  const byId = new Map(employees.map((e) => [String(e._id), e]));

  return {
    month: m,
    year: y,
    employees: grouped.map((g) => ({
      employeeId: g._id,
      employeeName: byId.get(String(g._id))?.employeeName || null,
      mobileNumber: byId.get(String(g._id))?.mobileNumber || null,
      daysPresent: g.days.length,
      totalSeconds: g.totalSeconds,
      totalHours: Number((g.totalSeconds / 3600).toFixed(2)),
    })),
  };
}

module.exports = {
  types: { ...types, remove: removeType },
  list,
  detail,
  create,
  update,
  remove,
  generateMpin,
  monthlyAttendance,
  monthlyReport,
};
