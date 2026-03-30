const CANONICAL_FAMILY_ALIASES = Object.freeze({
  prompt_clarify: ['prompt_clarify'],
  conversation_progress_resume: ['conversation_progress_resume'],
  merchant_query: ['merchant_query', 'merchant_product_split'],
  exact_product_lookup: ['exact_product_lookup'],
  exactish_lookup: ['exactish_lookup'],
  strict_ingredient: ['strict_ingredient', 'strict_consistency'],
  strict_ingredient_budget: ['strict_ingredient_budget'],
  scenario_clarify: ['scenario_clarify', 'clarify_required'],
  aurora_guidance_cache_hit: ['aurora_guidance_cache_hit', 'aurora_guidance_only_cache_hit'],
  aurora_guidance_cache_miss: ['aurora_guidance_cache_miss', 'aurora_guidance_only_cache_miss'],
  aurora_guidance_direct_supplement: [
    'aurora_guidance_direct_supplement',
    'aurora_guidance_only_direct_supplement',
  ],
  broad_commerce_search: ['broad_commerce_search'],
  broad_discovery: ['broad_discovery'],
  public_search_contract: ['public_search_contract'],
  governance_orchestration_denied: ['governance_orchestration_denied'],
  governance_deep_pagination: ['governance_deep_pagination'],
  governance_merchant_sweep: ['governance_merchant_sweep'],
});

const ALIAS_TO_CANONICAL = new Map();
for (const [canonical, aliases] of Object.entries(CANONICAL_FAMILY_ALIASES)) {
  for (const alias of aliases) {
    const normalizedAlias = String(alias || '').trim();
    if (!normalizedAlias) continue;
    ALIAS_TO_CANONICAL.set(normalizedAlias, canonical);
  }
}

function normalizeAcceptanceFamily(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return ALIAS_TO_CANONICAL.get(normalized) || normalized;
}

function listAcceptanceFamilyAliases(value) {
  const canonical = normalizeAcceptanceFamily(value);
  if (!canonical) return [];
  return CANONICAL_FAMILY_ALIASES[canonical]
    ? [...CANONICAL_FAMILY_ALIASES[canonical]]
    : [canonical];
}

function acceptanceFamilyMatches(left, right) {
  const normalizedLeft = normalizeAcceptanceFamily(left);
  const normalizedRight = normalizeAcceptanceFamily(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
}

module.exports = {
  acceptanceFamilyMatches,
  listAcceptanceFamilyAliases,
  normalizeAcceptanceFamily,
};
