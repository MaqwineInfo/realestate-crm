const { LeadStageHistory, Stage } = require('../db/models');

/**
 * V1.1 §17 + §18: the lead's actual journey through the stage master.
 *
 * `record()` is the only writer. It closes the open row and opens a new one, so
 * "entered and left" is a stored fact rather than an inference from list order.
 * Re-entering the same stage (a sub-stage change) updates the open row instead
 * of stacking duplicate entries.
 */
async function record({
  tenantId, leadId, stageId, subStageId, actor, sourceAction = 'MANUAL_OUTCOME', note, at = new Date(),
}) {
  const open = await LeadStageHistory.findOne({ tenantId, leadId, exitedAt: null })
    .sort({ enteredAt: -1 });

  if (open && String(open.stageId) === String(stageId)) {
    open.subStageId = subStageId || undefined;
    await open.save();
    return open;
  }
  if (open) {
    open.exitedAt = at;
    await open.save();
  }
  return LeadStageHistory.create({
    tenantId, leadId, stageId, subStageId, enteredAt: at, changedBy: actor?._id, sourceAction, note,
  });
}

const forLead = ({ tenantId, leadId }) => LeadStageHistory.find({ tenantId, leadId })
  .sort({ enteredAt: 1 })
  .populate('stageId', 'name colorToken semanticType')
  .populate('subStageId', 'name')
  .populate('changedBy', 'name')
  .lean();

/**
 * §17.2/§17.3: the funnel. `completed` comes from history alone — an earlier
 * position in the list never implies the lead went through it.
 *
 * Lost is deliberately excluded from the chain and returned as a branch (§17),
 * because a lost lead did not walk past Booked to get there.
 */
async function funnel({ tenantId, lead }) {
  const [stages, history] = await Promise.all([
    Stage.find({ tenantId, active: true }).sort({ displayOrder: 1 }).lean(),
    LeadStageHistory.find({ tenantId, leadId: lead._id }).sort({ enteredAt: 1 }).lean(),
  ]);

  const visited = new Map();
  for (const row of history) {
    const key = String(row.stageId);
    const previous = visited.get(key);
    visited.set(key, {
      enteredAt: previous?.enteredAt || row.enteredAt,
      exitedAt: row.exitedAt,
      sourceAction: row.sourceAction,
    });
  }

  const currentId = String(lead.stageId?._id || lead.stageId || '');
  const chain = stages.filter((s) => s.semanticType !== 'LOST');
  const currentIndex = chain.findIndex((s) => String(s._id) === currentId);

  const steps = chain.map((stage, index) => {
    const seen = visited.get(String(stage._id));
    const isCurrent = String(stage._id) === currentId;
    let state = 'future';
    if (isCurrent) state = 'current';
    else if (seen) state = 'completed';
    else if (currentIndex >= 0 && index < currentIndex) state = 'skipped';

    return {
      _id: stage._id,
      name: stage.name,
      semanticType: stage.semanticType,
      colorToken: stage.colorToken,
      terminal: stage.terminal,
      state,
      enteredAt: seen?.enteredAt || null,
      exitedAt: seen?.exitedAt || null,
      // §93: these two are only ever reached through their own business action.
      actionOnly: ['BLOCKED', 'BOOKED'].includes(stage.semanticType),
    };
  });

  const lostStage = stages.find((s) => s.semanticType === 'LOST');
  const isLost = lostStage && String(lostStage._id) === currentId;

  return {
    steps,
    lost: lostStage
      ? { _id: lostStage._id, name: lostStage.name, active: !!isLost }
      : null,
    currentSubStage: lead.subStageId?.name || null,
  };
}

module.exports = { record, forLead, funnel };
