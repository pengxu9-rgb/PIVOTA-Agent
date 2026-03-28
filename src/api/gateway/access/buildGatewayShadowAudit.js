function uniqueStrings(values = []) {
  return Array.from(new Set(values.map((item) => String(item || '').trim()).filter(Boolean)));
}

function buildGatewayShadowAudit(envelope = {}, options = {}) {
  if (!envelope || typeof envelope !== 'object') return null;

  const shadowMode = options.shadow_mode !== false;
  const rateLimit = envelope.rate_limit_decision || {};
  const queryGovernance = envelope.query_governance_decision || {};
  const observedPhase =
    rateLimit.allowed === false
      ? 'rate_limit'
      : 'query_governance';
  const observedAction =
    rateLimit.allowed === false
      ? rateLimit.action || 'throttle'
      : queryGovernance.action || 'allow';
  const wouldEnforce =
    rateLimit.allowed === false ||
    queryGovernance.allowed === false ||
    ['downgrade', 'truncate', 'throttle', 'block'].includes(observedAction);

  return {
    mode: shadowMode ? 'shadow' : 'enforce',
    source: envelope.source_profile?.source || null,
    entry_layer: envelope.entry_layer || null,
    task_type: envelope.task_type || null,
    effective_action: shadowMode ? 'allow' : observedAction,
    observed_phase: observedPhase,
    observed_action: observedAction,
    would_enforce: wouldEnforce,
    reason_codes: uniqueStrings([
      ...(Array.isArray(rateLimit.reason_codes) ? rateLimit.reason_codes : []),
      ...(Array.isArray(queryGovernance.reason_codes) ? queryGovernance.reason_codes : []),
    ]),
    invocation: {
      surface: envelope.invocation_context?.invocation_profile?.surface || null,
      protocol_family: envelope.invocation_context?.invocation_profile?.protocol_family || null,
      protocol_version: envelope.invocation_context?.invocation_profile?.protocol_version || null,
      response_mode: envelope.invocation_context?.invocation_profile?.response_mode || null,
      continuation_mode: envelope.invocation_context?.invocation_profile?.continuation_mode || null,
    },
    access: {
      principal_type: envelope.agent_identity?.principal_type || null,
      principal_id: envelope.agent_identity?.principal_id || null,
      partner_tier: envelope.agent_identity?.partner_tier || null,
      trust_tier: envelope.agent_identity?.trust_tier || null,
      result_depth: envelope.access_scope?.result_depth || null,
      max_results_per_request: envelope.access_scope?.max_results_per_request ?? null,
      max_pages: envelope.access_scope?.max_pages ?? null,
      max_variant_expansions: envelope.access_scope?.max_variant_expansions ?? null,
      allow_checkout_handoff: envelope.access_scope?.allow_checkout_handoff === true,
    },
    rate_limit: {
      allowed: rateLimit.allowed !== false,
      action: rateLimit.action || 'allow',
      reason_codes: Array.isArray(rateLimit.reason_codes) ? rateLimit.reason_codes : [],
      profile_id: rateLimit.profile_id || envelope.rate_limit_profile?.profile_id || null,
    },
    query_governance: {
      allowed: queryGovernance.allowed !== false,
      action: queryGovernance.action || 'allow',
      reason_codes: Array.isArray(queryGovernance.reason_codes) ? queryGovernance.reason_codes : [],
      effective_result_depth: queryGovernance.effective_result_depth || null,
      max_results_per_request: queryGovernance.max_results_per_request ?? null,
      max_pages: queryGovernance.max_pages ?? null,
      max_variant_expansions: queryGovernance.max_variant_expansions ?? null,
      query_classes: Array.isArray(envelope.query_classification?.query_classes)
        ? envelope.query_classification.query_classes
        : [],
    },
  };
}

module.exports = {
  buildGatewayShadowAudit,
};
