const {
  prepareGatewayGovernanceEnvelope,
} = require('../../../api/gateway/layerDispatcher');
const {
  buildGatewayShadowAudit,
} = require('../../../api/gateway/access/buildGatewayShadowAudit');

const BLOCKING_ACTIONS = new Set(['block', 'throttle']);
const DEGRADING_ACTIONS = new Set(['downgrade', 'truncate']);

function incrementCounter(map, key) {
  const token = String(key || '').trim() || 'unknown';
  map.set(token, (map.get(token) || 0) + 1);
}

function mapToSortedRows(map) {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.key.localeCompare(right.key);
    });
}

function firstNonEmptyString(values = []) {
  for (const value of values) {
    const token = String(value || '').trim();
    if (token) return token;
  }
  return null;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function firstBoolean(values = []) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (!normalized) continue;
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
    }
  }
  return null;
}

function normalizeRuntimeShadowEvent(event = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;

  const metadata =
    event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? event.metadata
      : {};
  const nestedInvocation =
    metadata.gateway_invocation &&
    typeof metadata.gateway_invocation === 'object' &&
    !Array.isArray(metadata.gateway_invocation)
      ? metadata.gateway_invocation
      : {};
  const nestedGovernance =
    metadata.gateway_governance &&
    typeof metadata.gateway_governance === 'object' &&
    !Array.isArray(metadata.gateway_governance)
      ? metadata.gateway_governance
      : {};
  const topLevelInvocation =
    event.invocation && typeof event.invocation === 'object' && !Array.isArray(event.invocation)
      ? event.invocation
      : {};
  const topLevelAccess =
    event.access && typeof event.access === 'object' && !Array.isArray(event.access)
      ? event.access
      : {};
  const nestedAccess =
    nestedGovernance.access &&
    typeof nestedGovernance.access === 'object' &&
    !Array.isArray(nestedGovernance.access)
      ? nestedGovernance.access
      : {};
  const topLevelQueryGovernance =
    event.query_governance && typeof event.query_governance === 'object' && !Array.isArray(event.query_governance)
      ? event.query_governance
      : {};
  const nestedQueryGovernance =
    nestedGovernance.query_governance &&
    typeof nestedGovernance.query_governance === 'object' &&
    !Array.isArray(nestedGovernance.query_governance)
      ? nestedGovernance.query_governance
      : {};

  const mode = firstNonEmptyString([event.mode, event.governance_mode, nestedGovernance.mode]) || 'unknown';
  const observedAction =
    firstNonEmptyString([
      event.observed_action,
      event.governance_observed_action,
      nestedGovernance.observed_action,
      topLevelQueryGovernance.action,
      nestedQueryGovernance.action,
    ]) || 'allow';
  const effectiveAction =
    firstNonEmptyString([
      event.effective_action,
      event.governance_effective_action,
      nestedGovernance.effective_action,
    ]) ||
    (mode === 'shadow' ? 'allow' : observedAction);
  const wouldEnforce =
    firstBoolean([event.would_enforce, event.governance_would_enforce, nestedGovernance.would_enforce]) ??
    (observedAction !== 'allow');
  const reasonCodes = Array.from(
    new Set([
      ...asStringArray(event.reason_codes),
      ...asStringArray(event.governance_reason_codes),
      ...asStringArray(nestedGovernance.reason_codes),
      ...asStringArray(topLevelQueryGovernance.reason_codes),
      ...asStringArray(nestedQueryGovernance.reason_codes),
    ]),
  );
  const invocationSurface = firstNonEmptyString([
    event.invocation_surface,
    topLevelInvocation.surface,
    nestedInvocation.surface,
  ]);
  const principalType = firstNonEmptyString([
    event.principal_type,
    topLevelAccess.principal_type,
    nestedAccess.principal_type,
  ]);
  const partnerTier = firstNonEmptyString([
    event.partner_tier,
    topLevelAccess.partner_tier,
    nestedAccess.partner_tier,
  ]);
  const entryLayer = firstNonEmptyString([event.entry_layer, nestedGovernance.entry_layer]);
  const requestId = firstNonEmptyString([
    event.gateway_request_id,
    event.request_id,
    event.correlation_id,
  ]);
  const eventTimestampUtc = firstNonEmptyString([
    event.timestamp_utc,
    event.timestamp,
    event.time,
    event.logged_at_utc,
  ]);

  if (
    mode === 'unknown' &&
    !invocationSurface &&
    !principalType &&
    observedAction === 'allow' &&
    effectiveAction === 'allow' &&
    reasonCodes.length === 0
  ) {
    return null;
  }

  return {
    mode,
    invocation_surface: invocationSurface,
    principal_type: principalType,
    partner_tier: partnerTier,
    entry_layer: entryLayer,
    request_id: requestId,
    observed_action: observedAction,
    effective_action: effectiveAction,
    would_enforce: wouldEnforce === true,
    reason_codes: reasonCodes,
    event_timestamp_utc: eventTimestampUtc,
  };
}

function normalizeScenarioExpectation(result, spec = {}) {
  const expectedAction = String(spec.expected_action || 'allow').trim() || 'allow';
  const expectedReasonCode = String(spec.expected_reason_code || '').trim() || null;
  const observedAction = String(result.audit?.observed_action || '').trim() || 'allow';
  const matchedAction = observedAction === expectedAction;
  const matchedReason =
    !expectedReasonCode ||
    (Array.isArray(result.audit?.reason_codes) && result.audit.reason_codes.includes(expectedReasonCode));

  return {
    expected_action: expectedAction,
    expected_reason_code: expectedReasonCode,
    matched_action: matchedAction,
    matched_reason: matchedReason,
    matched: matchedAction && matchedReason,
  };
}

function buildRuntimeSamplesSummary(runtimeEvents = []) {
  const bySurface = new Map();
  const byPrincipalType = new Map();
  const byPartnerTier = new Map();
  const byObservedAction = new Map();
  const byEffectiveAction = new Map();
  const byReasonCode = new Map();

  let totalEvents = 0;
  let shadowEvents = 0;
  let nonShadowEvents = 0;
  let ignoredEvents = 0;
  let wouldEnforceCount = 0;
  let blockedObservedCount = 0;
  let downgradedObservedCount = 0;
  let latestEventUtc = null;

  for (const event of runtimeEvents) {
    const normalized = normalizeRuntimeShadowEvent(event);
    if (!normalized) {
      ignoredEvents += 1;
      continue;
    }

    totalEvents += 1;
    if (normalized.mode !== 'shadow') {
      nonShadowEvents += 1;
      continue;
    }

    shadowEvents += 1;
    if (normalized.would_enforce === true) wouldEnforceCount += 1;
    if (BLOCKING_ACTIONS.has(normalized.observed_action)) blockedObservedCount += 1;
    if (DEGRADING_ACTIONS.has(normalized.observed_action)) downgradedObservedCount += 1;
    if (normalized.event_timestamp_utc && (!latestEventUtc || normalized.event_timestamp_utc > latestEventUtc)) {
      latestEventUtc = normalized.event_timestamp_utc;
    }

    incrementCounter(bySurface, normalized.invocation_surface);
    incrementCounter(byPrincipalType, normalized.principal_type);
    incrementCounter(byPartnerTier, normalized.partner_tier || 'none');
    incrementCounter(byObservedAction, normalized.observed_action);
    incrementCounter(byEffectiveAction, normalized.effective_action);
    for (const reasonCode of normalized.reason_codes) {
      incrementCounter(byReasonCode, reasonCode);
    }
  }

  return {
    total_events: totalEvents,
    shadow_events: shadowEvents,
    non_shadow_events: nonShadowEvents,
    ignored_events: ignoredEvents,
    latest_event_utc: latestEventUtc,
    coverage: {
      would_enforce_count: wouldEnforceCount,
      blocked_or_throttled_observed_count: blockedObservedCount,
      downgraded_or_truncated_observed_count: downgradedObservedCount,
    },
    counters: {
      by_surface: mapToSortedRows(bySurface),
      by_principal_type: mapToSortedRows(byPrincipalType),
      by_partner_tier: mapToSortedRows(byPartnerTier),
      by_observed_action: mapToSortedRows(byObservedAction),
      by_effective_action: mapToSortedRows(byEffectiveAction),
      by_reason_code: mapToSortedRows(byReasonCode),
    },
  };
}

function buildGatewayGovernanceShadowSummary(options = {}) {
  const scenarios = Array.isArray(options.scenarios) ? options.scenarios : [];
  const runtimeEvents = Array.isArray(options.runtime_events) ? options.runtime_events : [];
  const shadowMode = options.shadow_mode !== false;

  const bySurface = new Map();
  const byPrincipalType = new Map();
  const byObservedAction = new Map();
  const byEffectiveAction = new Map();
  const byReasonCode = new Map();
  const scenarioResults = [];

  let wouldEnforceCount = 0;
  let mismatchCount = 0;
  let blockedObservedCount = 0;
  let downgradedObservedCount = 0;

  for (const spec of scenarios) {
    const envelope = prepareGatewayGovernanceEnvelope(spec);
    const audit = buildGatewayShadowAudit(envelope, { shadow_mode: shadowMode });
    const expectation = normalizeScenarioExpectation({ audit }, spec);

    if (audit?.would_enforce === true) wouldEnforceCount += 1;
    if (['block', 'throttle'].includes(String(audit?.observed_action || ''))) blockedObservedCount += 1;
    if (['downgrade', 'truncate'].includes(String(audit?.observed_action || ''))) downgradedObservedCount += 1;
    if (!expectation.matched) mismatchCount += 1;

    incrementCounter(bySurface, audit?.invocation?.surface || envelope?.invocation_context?.invocation_profile?.surface);
    incrementCounter(byPrincipalType, audit?.access?.principal_type || envelope?.agent_identity?.principal_type);
    incrementCounter(byObservedAction, audit?.observed_action || 'allow');
    incrementCounter(byEffectiveAction, audit?.effective_action || 'allow');
    for (const reasonCode of Array.isArray(audit?.reason_codes) ? audit.reason_codes : []) {
      incrementCounter(byReasonCode, reasonCode);
    }

    scenarioResults.push({
      id: String(spec.id || '').trim() || `scenario_${scenarioResults.length + 1}`,
      source: envelope?.source_profile?.source || null,
      entry_layer: envelope?.entry_layer || null,
      invocation_surface: audit?.invocation?.surface || null,
      principal_type: audit?.access?.principal_type || null,
      observed_action: audit?.observed_action || 'allow',
      effective_action: audit?.effective_action || 'allow',
      would_enforce: audit?.would_enforce === true,
      reason_codes: Array.isArray(audit?.reason_codes) ? audit.reason_codes : [],
      expected_action: expectation.expected_action,
      expected_reason_code: expectation.expected_reason_code,
      matched: expectation.matched,
    });
  }

  const totalScenarios = scenarioResults.length;
  const matchedScenarios = totalScenarios - mismatchCount;
  let readinessStatus = 'red';
  if (totalScenarios > 0 && mismatchCount === 0) {
    readinessStatus = 'green';
  } else if (matchedScenarios > 0) {
    readinessStatus = 'amber';
  }

  return {
    schema_version: 'pivota.gateway.governance.shadow_summary.v1',
    shadow_mode: shadowMode,
    total_scenarios: totalScenarios,
    matched_scenarios: matchedScenarios,
    mismatch_count: mismatchCount,
    readiness_status: readinessStatus,
    coverage: {
      would_enforce_count: wouldEnforceCount,
      blocked_observed_count: blockedObservedCount,
      downgraded_or_truncated_observed_count: downgradedObservedCount,
    },
    counters: {
      by_surface: mapToSortedRows(bySurface),
      by_principal_type: mapToSortedRows(byPrincipalType),
      by_observed_action: mapToSortedRows(byObservedAction),
      by_effective_action: mapToSortedRows(byEffectiveAction),
      by_reason_code: mapToSortedRows(byReasonCode),
    },
    scenarios: scenarioResults,
    runtime_samples: buildRuntimeSamplesSummary(runtimeEvents),
  };
}

module.exports = {
  buildGatewayGovernanceShadowSummary,
  normalizeRuntimeShadowEvent,
};
