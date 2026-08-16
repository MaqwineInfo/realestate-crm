const { Stage, SubStage, ActionType, VisitOutcome, LeadSource } = require('../db/models');
const { badRequest, notFound } = require('../lib/errors');

/**
 * Spec §11: stages are tenant-configurable. Automation always resolves them by
 * `semanticType` (§11.3) so renaming a stage never breaks behaviour.
 */
const listStages = ({ tenantId, includeInactive = false }) => Stage.find({
  tenantId, ...(includeInactive ? {} : { active: true }),
}).sort({ displayOrder: 1 }).lean();

const listSubStages = ({ tenantId, stageId, includeInactive = false }) => SubStage.find({
  tenantId, ...(stageId ? { stageId } : {}), ...(includeInactive ? {} : { active: true }),
}).sort({ displayOrder: 1 }).lean();

const bySemantic = ({ tenantId, semanticType }) => Stage.findOne({ tenantId, semanticType, active: true }).lean();

async function requireStage({ tenantId, stageId }) {
  const stage = await Stage.findOne({ tenantId, _id: stageId }).lean();
  if (!stage) throw notFound('That stage no longer exists.');
  return stage;
}

/**
 * §11.5 / §52.2: a sub-stage must belong to the selected stage, and a stage
 * that requires one cannot be saved without it.
 */
async function validateStagePair({ tenantId, stage, subStageId }) {
  if (!subStageId) {
    if (stage.requiresSubStage) throw badRequest(`Select a ${stage.name} sub-stage.`);
    return null;
  }
  const subStage = await SubStage.findOne({ tenantId, _id: subStageId }).lean();
  if (!subStage) throw notFound('That sub-stage no longer exists.');
  if (String(subStage.stageId) !== String(stage._id)) {
    throw badRequest('That sub-stage does not belong to the selected stage.');
  }
  return subStage;
}

/** §11.5: inactive stages cannot be chosen for new changes; history keeps them. */
function assertSelectable(stage) {
  if (!stage.active) throw badRequest('That stage is no longer available. Choose an active stage.');
}

const listActionTypes = ({ tenantId, includeInactive = false }) => ActionType.find({
  tenantId, ...(includeInactive ? {} : { active: true }),
}).sort({ displayOrder: 1 }).lean();

const listVisitOutcomes = ({ tenantId, includeInactive = false }) => VisitOutcome.find({
  tenantId, ...(includeInactive ? {} : { active: true }),
}).sort({ displayOrder: 1 }).lean();

const listSources = ({ tenantId, includeInactive = false }) => LeadSource.find({
  tenantId, ...(includeInactive ? {} : { active: true }),
}).sort({ displayOrder: 1, name: 1 }).lean();

const sourceByCategory = ({ tenantId, category }) => LeadSource.findOne({ tenantId, category, active: true }).lean();

module.exports = {
  listStages, listSubStages, bySemantic, requireStage, validateStagePair, assertSelectable,
  listActionTypes, listVisitOutcomes, listSources, sourceByCategory,
};
