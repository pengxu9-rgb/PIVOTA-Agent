const RECO_RECALL_TRANSPORT_POLICY_VERSION = 'aurora_reco_recall_transport_policy_v3';

function normalizeRecoRecallTransportMode(value) {
  const token = String(value || '').trim().toLowerCase();
  if (
    token === 'framework_first_turn'
    || token === 'step_aware'
    || token === 'product_grounding_exact'
    || token === 'default'
  ) {
    return token;
  }
  return 'default';
}

function buildRecoRecallTransportPolicy({ mode } = {}) {
  const normalizedMode = normalizeRecoRecallTransportMode(mode);
  if (normalizedMode === 'framework_first_turn') {
    return {
      version: RECO_RECALL_TRANSPORT_POLICY_VERSION,
      mode: normalizedMode,
      include_local_fallback: false,
      include_self_proxy: true,
      prefer_self_proxy_first: true,
      max_base_urls: 1,
      max_paths: 1,
      allow_secondary_base_failover: false,
      allow_secondary_path_failover: false,
      actual_http_attempt_limit_per_query: 1,
    };
  }
  if (normalizedMode === 'step_aware' || normalizedMode === 'product_grounding_exact') {
    return {
      version: RECO_RECALL_TRANSPORT_POLICY_VERSION,
      mode: normalizedMode,
      include_local_fallback: false,
      include_self_proxy: true,
      prefer_self_proxy_first: true,
      max_base_urls: 1,
      max_paths: 1,
      allow_secondary_base_failover: false,
      allow_secondary_path_failover: false,
      actual_http_attempt_limit_per_query: 1,
    };
  }
  return {
    version: RECO_RECALL_TRANSPORT_POLICY_VERSION,
    mode: 'default',
    include_local_fallback: true,
    include_self_proxy: true,
    prefer_self_proxy_first: false,
    max_base_urls: 0,
    max_paths: 0,
    allow_secondary_base_failover: true,
    allow_secondary_path_failover: true,
    actual_http_attempt_limit_per_query: 0,
  };
}

function resolveRecoRecallTransportModeForPlannerMode(plannerMode) {
  const token = String(plannerMode || '').trim().toLowerCase();
  if (token === 'framework_generic') return 'framework_first_turn';
  if (token === 'step_aware') return 'step_aware';
  if (token === 'product_grounding_exact') return 'product_grounding_exact';
  return 'default';
}

module.exports = {
  RECO_RECALL_TRANSPORT_POLICY_VERSION,
  normalizeRecoRecallTransportMode,
  buildRecoRecallTransportPolicy,
  resolveRecoRecallTransportModeForPlannerMode,
};
