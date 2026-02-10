function mergeIngredientActionWithEvidence({
  action,
  evidence,
  market,
} = {}) {
  const base = action && typeof action === 'object' ? { ...action } : {};
  if (!evidence || typeof evidence !== 'object') return base;

  const normalizedMarket = String(market || 'US').trim().toUpperCase() || 'US';
  const allowedClaims = Array.isArray(evidence.allowed_claims) ? evidence.allowed_claims.slice(0, 6) : [];

  return {
    ...base,
    evidence_grade: evidence.evidence_grade || 'C',
    market_scope: Array.isArray(evidence.market_scope) ? evidence.market_scope : [normalizedMarket],
    citations: Array.isArray(evidence.citations) ? evidence.citations : [],
    allowed_claims: allowedClaims,
    allowed_claims_by_market: {
      [normalizedMarket]: allowedClaims,
    },
    disallowed_claims: Array.isArray(evidence.disallowed_claims) ? evidence.disallowed_claims : [],
    safety_flags: Array.isArray(evidence.safety_flags) ? evidence.safety_flags : [],
    do_not_mix: Array.isArray(evidence.do_not_mix) ? evidence.do_not_mix : [],
    policy_refs: Array.isArray(evidence.policy_refs) ? evidence.policy_refs : [],
    risk_tier: evidence.risk_tier || 'standard',
    evidence_limited: Boolean(evidence.evidence_limited),
  };
}

module.exports = {
  mergeIngredientActionWithEvidence,
};
