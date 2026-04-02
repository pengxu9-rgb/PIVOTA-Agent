function getRecoRecallSelectedCount(candidateState) {
  if (Number.isFinite(Number(candidateState?.selected_candidate_count))) {
    return Math.max(0, Math.trunc(Number(candidateState.selected_candidate_count)));
  }
  return Array.isArray(candidateState?.selected_recommendations)
    ? candidateState.selected_recommendations.length
    : 0;
}

function shouldRunRecoRecallStage(stage, { stageResults = [], candidateState = null } = {}) {
  const stageObj = stage && typeof stage === 'object' && !Array.isArray(stage) ? stage : null;
  if (!stageObj) return { run: false, reason: 'stage_invalid' };
  const runIf = String(stageObj.run_if || 'always').trim().toLowerCase();
  const stageId = String(stageObj.stage_id || '').trim().toLowerCase();
  if (runIf === 'always') return { run: true, reason: 'always' };
  if (runIf === 'if_surface_count_below_target') {
    if (stageId.startsWith('framework_stage_c_support_') && candidateState?.primary_role_matched !== true) {
      return { run: false, reason: 'primary_role_unmatched' };
    }
    return getRecoRecallSelectedCount(candidateState) < 3
      ? { run: true, reason: 'surface_count_below_target' }
      : { run: false, reason: 'surface_count_satisfied' };
  }
  if (runIf === 'if_no_primary_viable_or_transient_only') {
    if (candidateState?.primary_role_matched === true) {
      return { run: false, reason: 'primary_role_already_matched' };
    }
    const previousStage = [...(Array.isArray(stageResults) ? stageResults : [])]
      .reverse()
      .find((row) => row && row.skipped !== true) || null;
    if (!previousStage) return { run: true, reason: 'no_previous_stage' };
    if (previousStage.primary_role_matched === true) {
      return { run: false, reason: 'previous_stage_matched_primary_role' };
    }
    if (previousStage.transient_only === true || Number(previousStage.selected_count || 0) <= 0) {
      return {
        run: true,
        reason: previousStage.transient_only === true ? 'previous_stage_transient_only' : 'previous_stage_empty',
      };
    }
    return { run: false, reason: 'previous_stage_satisfied' };
  }
  return { run: true, reason: 'default' };
}

module.exports = {
  getRecoRecallSelectedCount,
  shouldRunRecoRecallStage,
};
