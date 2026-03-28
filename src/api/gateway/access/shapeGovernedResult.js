function cloneJsonSafe(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function clipArray(value, maxItems) {
  if (!Array.isArray(value)) return value;
  if (!Number.isFinite(maxItems) || maxItems < 0) return value;
  return value.slice(0, maxItems);
}

function limitVariantRefs(candidates, maxVariantExpansions) {
  if (!Array.isArray(candidates)) return candidates;
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') return candidate;
    return {
      ...candidate,
      variant_refs: clipArray(candidate.variant_refs, maxVariantExpansions),
    };
  });
}

function shapeGovernedResult(result = {}, envelope = {}) {
  const out = cloneJsonSafe(result || {});
  const governance = envelope.query_governance_decision || null;
  if (!governance || !out || typeof out !== 'object') return out;

  const maxResults = governance.max_results_per_request;
  out.ranked_candidates = limitVariantRefs(clipArray(out.ranked_candidates, maxResults), governance.max_variant_expansions);
  out.shortlist = clipArray(out.shortlist, maxResults);
  out.responseProducts = clipArray(out.responseProducts, maxResults);
  out.products = clipArray(out.products, maxResults);
  out.results = clipArray(out.results, maxResults);
  out.compare_matrix = clipArray(out.compare_matrix, maxResults);

  if (envelope.access_scope && envelope.access_scope.allow_deep_offer_fields !== true && out.resolved_offer) {
    out.resolved_offer = {
      offer_id: out.resolved_offer.offer_id || null,
      price: out.resolved_offer.price || null,
    };
  }

  out.gateway_governance = {
    action: governance.action,
    reason_codes: governance.reason_codes || [],
    effective_result_depth: governance.effective_result_depth,
    invocation_surface: envelope.invocation_context?.invocation_profile?.surface || null,
    principal_type: envelope.agent_identity?.principal_type || null,
    partner_tier: envelope.agent_identity?.partner_tier || null,
  };

  return out;
}

module.exports = {
  shapeGovernedResult,
};
