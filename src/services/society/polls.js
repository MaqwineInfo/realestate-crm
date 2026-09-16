const { crud } = require('./factory');
const notices = require('./notices');
const messaging = require('./messaging');
const { badRequest, notFound, conflict } = require('../../lib/errors');
const {
  SocietyPoll, SocietyPollVote, SocietyUnitOccupancy, SocietyCounter,
  SocietyNotification, SocietyUser,
} = require('../../db/models/society');

/**
 * Polls put to residents, and their votes.
 *
 * One vote per (poll, user, unit) — the unit is in the key deliberately:
 * someone who owns two flats gets a vote per flat, which is how society
 * resolutions actually work. The unique index enforces it; `vote()` catches the
 * duplicate rather than checking first.
 *
 * Tallies are denormalised counters moved with atomic `$inc` alongside the vote
 * write. Recounting `SocietyPollVote` on every read would make the results
 * screen the slowest page in the product, and `eligibleVotersCount` is
 * snapshotted at publish so turnout stays meaningful after people move in or out.
 */
const base = crud({
  Model: SocietyPoll,
  listKey: 'polls',
  searchFields: ['title', 'description'],
  filterFields: ['publishStatus', 'status', 'residentType', 'pollType'],
  pageParam: 'limit',
  sort: { createdAt: -1 },
});

async function create(ctx, data, actorId) {
  const options = (data.options || []).filter((o) => o?.text?.trim());
  if (options.length < 2) throw badRequest('A poll needs at least two options.');

  const societyCode = ctx.society?.societyCode
    || (await require('../../db/models/society').Society.findById(ctx.societyId)
      .select('societyCode').lean())?.societyCode;

  return base.create(ctx, {
    ...data,
    pollId: await SocietyCounter.nextRef({
      societyCode, kind: 'poll', date: 'ALL', prefix: 'PL', width: 3,
    }),
    options: options.map((o, i) => ({ text: o.text.trim(), order: o.order ?? i, voteCount: 0 })),
    publishStatus: 'DRAFT',
  }, actorId);
}

/**
 * Publishing snapshots the electorate and notifies it.
 *
 * `eligibleVotersCount` is fixed here rather than computed on read: turnout
 * against a moving denominator is not a number anyone can act on.
 */
async function publish(ctx, id, actorId) {
  const poll = await SocietyPoll.findOne({
    societyId: ctx.societyId, _id: id, isDeleted: false,
  }).lean();
  if (!poll) throw notFound('Poll not found');
  if (poll.publishStatus === 'CLOSED') throw conflict('That poll is already closed.');

  const eligible = await notices.audience(ctx, poll);

  const updated = await SocietyPoll.findOneAndUpdate(
    { societyId: ctx.societyId, _id: id },
    {
      $set: {
        publishStatus: 'PUBLISHED',
        publishedAt: poll.publishedAt || new Date(),
        publishedBy: actorId || null,
        eligibleVotersCount: eligible.length,
      },
    },
    { new: true },
  ).lean();

  if (!poll.notificationSent && eligible.length) {
    await SocietyNotification.insertMany(eligible.map((r) => ({
      societyId: ctx.societyId,
      userId: r.userId,
      unitId: r.unitId,
      title: 'New poll',
      body: poll.title,
      type: 'POLL',
      subType: 'PUBLISHED',
      referenceId: poll._id,
    })));
    const users = await SocietyUser.find({
      _id: { $in: eligible.map((r) => r.userId) }, isDeleted: false,
    }).select('fcmToken').lean();
    await messaging.push({
      tokens: users.map((u) => u.fcmToken),
      title: 'New poll',
      body: poll.title,
      data: { type: 'POLL', pollId: String(poll._id) },
    });
    await SocietyPoll.updateOne({ societyId: ctx.societyId, _id: id }, { $set: { notificationSent: true } });
  }

  return updated;
}

const isOpen = (poll, now = new Date()) => poll.publishStatus === 'PUBLISHED'
  && (!poll.votingStartAt || poll.votingStartAt <= now)
  && (!poll.votingEndAt || poll.votingEndAt >= now);

/**
 * Casts or changes a vote.
 *
 * The counters and the vote row move together: `$inc` on the chosen options,
 * decrement on any previous choice, and the vote row itself carries the
 * history. A changed vote must not inflate `totalVoters`, which is why that
 * only increments on a first vote.
 */
async function vote(ctx, pollId, { selectedOptions = [] }, actor) {
  const poll = await SocietyPoll.findOne({
    societyId: ctx.societyId, _id: pollId, isDeleted: false,
  }).lean();
  if (!poll) throw notFound('Poll not found');
  if (!isOpen(poll)) throw badRequest('This poll is not open for voting.');

  const chosen = [...new Set(selectedOptions.map(String))];
  if (!chosen.length) throw badRequest('Choose an option.');

  const valid = new Set(poll.options.map((o) => String(o._id)));
  if (chosen.some((o) => !valid.has(o))) throw badRequest('That option is not on this poll.');

  const max = poll.pollType === 'SINGLE_CHOICE' ? 1 : (poll.maxSelections || poll.options.length);
  if (chosen.length > max) throw badRequest(`Choose at most ${max} option(s).`);

  const occupancy = await SocietyUnitOccupancy.findOne({
    societyId: ctx.societyId, userId: actor.userId, isCurrent: true, isDeleted: false,
  }).lean();
  if (!occupancy) throw badRequest('You are not registered as a resident of this society.');

  const existing = await SocietyPollVote.findOne({
    societyId: ctx.societyId, pollId, userId: actor.userId, unitId: occupancy.unitId,
  });

  if (existing && !poll.settings?.allowChangeVote) {
    throw conflict('You have already voted in this poll.');
  }

  const previous = existing ? existing.selectedOptions.map(String) : [];
  const added = chosen.filter((o) => !previous.includes(o));
  const removed = previous.filter((o) => !chosen.includes(o));

  if (existing) {
    existing.voteHistory.push({ selectedOptions: existing.selectedOptions, changedAt: new Date() });
    existing.selectedOptions = chosen;
    existing.votedAt = new Date();
    await existing.save();
  } else {
    try {
      await SocietyPollVote.create({
        societyId: ctx.societyId,
        pollId,
        userId: actor.userId,
        occupancyId: occupancy._id,
        unitId: occupancy.unitId,
        selectedOptions: chosen,
        isAnonymous: Boolean(poll.settings?.allowAnonymous && actor.anonymous),
      });
    } catch (err) {
      // Two taps on the same button: the index says one vote, and it wins.
      if (err.code === 11000) throw conflict('You have already voted in this poll.');
      throw err;
    }
  }

  await applyTally(ctx, pollId, { added, removed, firstVote: !existing });
  return detail(ctx, pollId);
}

/** Moves the denormalised counters. Atomic per option. */
async function applyTally(ctx, pollId, { added, removed, firstVote }) {
  const inc = {};
  for (const id of added) inc[`options.$[o${added.indexOf(id)}].voteCount`] = 1;

  // Positional filters cannot be built dynamically in one update cleanly, so
  // each option is moved on its own — still one atomic write per counter.
  for (const id of added) {
    // eslint-disable-next-line no-await-in-loop
    await SocietyPoll.updateOne(
      { societyId: ctx.societyId, _id: pollId, 'options._id': id },
      { $inc: { 'options.$.voteCount': 1, totalVotes: 1 } },
    );
  }
  for (const id of removed) {
    // eslint-disable-next-line no-await-in-loop
    await SocietyPoll.updateOne(
      { societyId: ctx.societyId, _id: pollId, 'options._id': id },
      { $inc: { 'options.$.voteCount': -1, totalVotes: -1 } },
    );
  }
  if (firstVote) {
    await SocietyPoll.updateOne(
      { societyId: ctx.societyId, _id: pollId }, { $inc: { totalVoters: 1 } },
    );
  }
  return inc;
}

/** A poll with its results, respecting whether results are visible yet. */
async function detail(ctx, id, viewer = {}) {
  const poll = await base.detail(ctx, id);
  const closed = poll.publishStatus === 'CLOSED'
    || (poll.votingEndAt && poll.votingEndAt < new Date());

  const showResults = viewer.isAdmin
    || (closed ? poll.settings?.showResultsAfter !== false : poll.settings?.showResultsDuring !== false);

  const myVote = viewer.userId
    ? await SocietyPollVote.findOne({
      societyId: ctx.societyId, pollId: id, userId: viewer.userId,
    }).select('selectedOptions votedAt').lean()
    : null;

  return {
    ...poll,
    closed,
    turnout: poll.eligibleVotersCount
      ? Number(((poll.totalVoters / poll.eligibleVotersCount) * 100).toFixed(1))
      : 0,
    // Hiding results means hiding the counts, not the options.
    options: showResults ? poll.options : poll.options.map((o) => ({ ...o, voteCount: undefined })),
    resultsVisible: showResults,
    myVote,
  };
}

const close = (ctx, id) => SocietyPoll.findOneAndUpdate(
  { societyId: ctx.societyId, _id: id, isDeleted: false },
  { $set: { publishStatus: 'CLOSED' } },
  { new: true },
).lean();

/** The scheduler's sweep: close polls whose voting window has passed. */
async function closeExpired(now = new Date()) {
  const res = await SocietyPoll.updateMany(
    { publishStatus: 'PUBLISHED', votingEndAt: { $lte: now }, isDeleted: false },
    { $set: { publishStatus: 'CLOSED' } },
  ).setOptions({ allowCrossSociety: true });
  return { closed: res.modifiedCount || 0 };
}

/** Who voted for what — hidden for anonymous votes. */
async function voters(ctx, pollId) {
  const rows = await SocietyPollVote.find({ societyId: ctx.societyId, pollId })
    .populate('unitId', 'unitNumber')
    .sort({ votedAt: -1 })
    .lean();
  return rows.map((v) => (v.isAnonymous
    ? { ...v, userId: null, unitId: null, anonymous: true }
    : v));
}

module.exports = {
  ...base, create, publish, vote, detail, close, closeExpired, voters, isOpen,
};
