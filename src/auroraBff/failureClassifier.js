'use strict';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecoFailureOrigin(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'user_input' || token === 'upstream_dependency' || token === 'internal_contract') return token;
  return 'none';
}

function normalizeRecoViablePoolStrength(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'strong' || token === 'weak') return token;
  return 'unknown';
}

function deriveConcernCatalogFailure(catalogDebug) {
  const debugObj = isPlainObject(catalogDebug) ? catalogDebug : {};
  const candidateDropStage = String(debugObj.candidate_drop_stage || '').trim().toLowerCase();
  if (candidateDropStage === 'upstream_timeout_primary_role') {
    return {
      effective_failure_class: 'upstream_timeout_primary_role',
      failure_origin: 'upstream_dependency',
    };
  }
  if (candidateDropStage === 'no_recall_from_planned_sources') {
    return {
      effective_failure_class: 'no_recall_from_planned_sources',
      failure_origin: 'user_input',
    };
  }
  if (candidateDropStage === 'filtered_after_recall' || candidateDropStage === 'weak_viable_pool') {
    return {
      effective_failure_class: 'weak_viable_pool',
      failure_origin: 'user_input',
    };
  }
  return {
    effective_failure_class: '',
    failure_origin: 'none',
  };
}

function resolveConcernMainlineFailure({
  plannerBlocked = false,
  plannerFailureClass = '',
  viablePoolState = null,
  catalogDebug = null,
  postGuardrailCount = null,
} = {}) {
  if (plannerBlocked) {
    return {
      effective_failure_class: 'planner_untrusted',
      failure_origin: plannerFailureClass === 'timeout' ? 'upstream_dependency' : 'internal_contract',
    };
  }
  const poolState = isPlainObject(viablePoolState) ? viablePoolState : {};
  const preLlmSelectedCandidateCount = Number.isFinite(Number(poolState.pre_llm_selected_candidate_count))
    ? Math.max(0, Math.trunc(Number(poolState.pre_llm_selected_candidate_count)))
    : Number.isFinite(Number(poolState.selected_candidate_count))
      ? Math.max(0, Math.trunc(Number(poolState.selected_candidate_count)))
      : 0;
  const finalCount = Number.isFinite(Number(postGuardrailCount))
    ? Math.max(0, Math.trunc(Number(postGuardrailCount)))
    : Number.isFinite(Number(poolState.final_selected_candidate_count))
      ? Math.max(0, Math.trunc(Number(poolState.final_selected_candidate_count)))
      : preLlmSelectedCandidateCount;
  if (preLlmSelectedCandidateCount > 0 && finalCount === 0) {
    return {
      effective_failure_class: 'weak_viable_pool',
      failure_origin: 'user_input',
    };
  }
  const catalogFailure = deriveConcernCatalogFailure(catalogDebug);
  if (catalogFailure.effective_failure_class) return catalogFailure;
  if (normalizeRecoViablePoolStrength(poolState.viable_pool_strength) === 'weak' || poolState.weak_viable_pool === true) {
    return {
      effective_failure_class: 'weak_viable_pool',
      failure_origin: 'user_input',
    };
  }
  if (preLlmSelectedCandidateCount <= 0) {
    return {
      effective_failure_class: 'no_recall_from_planned_sources',
      failure_origin: 'user_input',
    };
  }
  return {
    effective_failure_class: 'none',
    failure_origin: 'none',
  };
}

module.exports = {
  resolveConcernMainlineFailure,
};
