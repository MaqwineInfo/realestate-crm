const { crud } = require('./factory');
const { notFound } = require('../../lib/errors');
const {
  SocietyStage, SocietySubStage, SocietyChildStage,
} = require('../../db/models/society');

/**
 * The three-level society-enquiry pipeline.
 *
 * The source exposes three creates and a single list that returns the whole
 * tree, so the three levels share one module. Each level is factory CRUD; the
 * only real logic is the parent check on create and assembling the tree.
 */
const stages = crud({ Model: SocietyStage, listKey: 'stages', filterFields: ['status'], sort: { orderBy: 1 } });
const subStages = crud({ Model: SocietySubStage, listKey: 'subStages', filterFields: ['status', 'societyStageId'], sort: { orderBy: 1 } });
const childStages = crud({ Model: SocietyChildStage, listKey: 'childStages', filterFields: ['status', 'societySubStageId'], sort: { orderBy: 1 } });

/** A sub-stage cannot dangle: its parent stage must exist and be live. */
async function createSubStage(ctx, data, actorId) {
  const parent = await SocietyStage.findOne({ _id: data.societyStageId, isDeleted: false }).lean();
  if (!parent) throw notFound('Inquiry stage not found');
  return subStages.create(ctx, data, actorId);
}

async function createChildStage(ctx, data, actorId) {
  const parent = await SocietySubStage.findOne({ _id: data.societySubStageId, isDeleted: false }).lean();
  if (!parent) throw notFound('Inquiry stage not found');
  return childStages.create(ctx, data, actorId);
}

/**
 * The whole pipeline as one nested tree, ordered by `orderBy` at every level.
 *
 * Read as three queries and stitched in memory rather than with `populate` of
 * virtuals: the pipeline is a handful of rows per level and this is one round
 * trip per level regardless of how many stages exist, instead of one per parent.
 */
async function tree() {
  const live = { isDeleted: false };
  const [top, subs, children] = await Promise.all([
    SocietyStage.find(live).sort({ orderBy: 1 }).lean(),
    SocietySubStage.find(live).sort({ orderBy: 1 }).lean(),
    SocietyChildStage.find(live).sort({ orderBy: 1 }).lean(),
  ]);

  const childrenBySub = new Map();
  for (const c of children) {
    const k = String(c.societySubStageId);
    if (!childrenBySub.has(k)) childrenBySub.set(k, []);
    childrenBySub.get(k).push(c);
  }
  const subsByStage = new Map();
  for (const s of subs) {
    const k = String(s.societyStageId);
    if (!subsByStage.has(k)) subsByStage.set(k, []);
    subsByStage.get(k).push({ ...s, childStages: childrenBySub.get(String(s._id)) || [] });
  }
  return top.map((s) => ({ ...s, subStages: subsByStage.get(String(s._id)) || [] }));
}

module.exports = {
  stages, subStages, childStages, createSubStage, createChildStage, tree,
};
