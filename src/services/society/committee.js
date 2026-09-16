const { crud } = require('./factory');
const { notFound } = require('../../lib/errors');
const { SocietyCommitteeMember, SocietyRole, SocietyUser } = require('../../db/models/society');

/**
 * The elected committee — the roster residents see in the app.
 *
 * A seat is not access: `SocietyAdmin` is what grants a login, and it links
 * back here through `committeeMemberId`. Someone can hold a seat with no admin
 * account, and an admin can exist with no seat.
 */
const base = crud({
  Model: SocietyCommitteeMember,
  listKey: 'committeeMembers',
  searchFields: ['firstName', 'lastName', 'email', 'phoneNumber', 'designation'],
  filterFields: ['status', 'roleId'],
  populate: ['roleId'],
  pageParam: 'limit',
  sort: { designation: 1, firstName: 1 },
});

/**
 * A committee member needs a user to be reachable in the app, so one is
 * created for their number if it does not exist yet — the same upsert-on-mobile
 * rule used everywhere else.
 */
async function create(ctx, data, actorId) {
  let { userId } = data;
  if (!userId && data.phoneNumber) {
    await SocietyUser.updateOne(
      { mobileNumber: data.phoneNumber },
      {
        $setOnInsert: { mobileNumber: data.phoneNumber, countryCode: data.countryCode || '+91' },
        $set: {
          firstName: data.firstName || '',
          lastName: data.lastName || '',
          email: data.email || null,
          societyId: ctx.societyId,
        },
      },
      { upsert: true },
    );
    userId = (await SocietyUser.findOne({ mobileNumber: data.phoneNumber }).select('_id').lean())?._id;
  }
  return base.create(ctx, { ...data, userId }, actorId);
}

/** The society-scoped roles a committee seat can carry. */
async function roles() {
  return SocietyRole.find({ scope: 'society', isDeleted: false, isActive: true })
    .select('key name displayName level description')
    .sort({ level: 1 })
    .lean();
}

module.exports = { ...base, create, roles };
