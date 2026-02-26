const { SEARCH_PROFILE_IDS, SEARCH_PROFILE_MAP } = require('./index');

const FRAGRANCE_HINT_REGEX =
  /\b(perfume|fragrance|parfum|cologne|body\s*mist|eau\s+de\s+parfum|eau\s+de\s+toilette|tom ford|jo malone|diptyque|byredo|le labo|chanel|dior|ysl|yves saint laurent|armani|hermes|gucci|creed|kilian|amouage)\b|香水|香氛|古龙|古龍|フレグランス|コロン/i;
const LINGERIE_HINT_REGEX =
  /\b(lingerie|underwear|under wear|bra|bras|panties|panty|brief|briefs|thong|bralette|intimates|sleepwear)\b|内衣|內衣|文胸|胸罩|ブラ|ランジェリー/i;
const PET_HINT_REGEX = /\b(pet|dog|cat|puppy|kitten|harness|leash|litter|pet food)\b|宠物|寵物|犬|猫|貓/i;
const BEAUTY_HINT_REGEX =
  /\b(beauty|skincare|skin care|makeup|cosmetic|cosmetics|serum|toner|cleanser|sunscreen|moisturizer|lipstick|foundation)\b|护肤|護膚|彩妆|彩妝|化妆|化妝/i;

function normalizeHintId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (SEARCH_PROFILE_MAP[raw]) return raw;
  const aliasMap = {
    fragrance: SEARCH_PROFILE_IDS.FRAGRANCE_STRICT,
    perfume: SEARCH_PROFILE_IDS.FRAGRANCE_STRICT,
    lingerie: SEARCH_PROFILE_IDS.LINGERIE_STRICT,
    underwear: SEARCH_PROFILE_IDS.LINGERIE_STRICT,
    pet: SEARCH_PROFILE_IDS.PET_SUPPLIES,
    beauty: SEARCH_PROFILE_IDS.BEAUTY_GENERAL,
    skincare: SEARCH_PROFILE_IDS.BEAUTY_GENERAL,
    default: SEARCH_PROFILE_IDS.GENERAL,
  };
  return aliasMap[raw] || null;
}

function inferProfileIdFromSignals({
  queryText = '',
  queryClass = '',
  intent = null,
}) {
  const query = String(queryText || '');
  const normalizedClass = String(queryClass || intent?.query_class || '')
    .trim()
    .toLowerCase();
  const primaryDomain = String(intent?.primary_domain || '')
    .trim()
    .toLowerCase();
  const targetType = String(intent?.target_object?.type || '')
    .trim()
    .toLowerCase();

  if (FRAGRANCE_HINT_REGEX.test(query) || normalizedClass === 'brand') {
    return {
      profileId: SEARCH_PROFILE_IDS.FRAGRANCE_STRICT,
      confidence: FRAGRANCE_HINT_REGEX.test(query) ? 'high' : 'medium',
      reason: FRAGRANCE_HINT_REGEX.test(query)
        ? 'fragrance_keyword_match'
        : 'brand_query_class',
    };
  }

  if (LINGERIE_HINT_REGEX.test(query)) {
    return {
      profileId: SEARCH_PROFILE_IDS.LINGERIE_STRICT,
      confidence: 'high',
      reason: 'lingerie_keyword_match',
    };
  }

  if (PET_HINT_REGEX.test(query) || primaryDomain === 'pet' || targetType === 'pet_product') {
    return {
      profileId: SEARCH_PROFILE_IDS.PET_SUPPLIES,
      confidence: PET_HINT_REGEX.test(query) ? 'high' : 'medium',
      reason: PET_HINT_REGEX.test(query) ? 'pet_keyword_match' : 'pet_domain_intent',
    };
  }

  if (
    BEAUTY_HINT_REGEX.test(query) ||
    primaryDomain === 'beauty' ||
    targetType === 'beauty_product'
  ) {
    return {
      profileId: SEARCH_PROFILE_IDS.BEAUTY_GENERAL,
      confidence: BEAUTY_HINT_REGEX.test(query) ? 'medium' : 'low',
      reason: BEAUTY_HINT_REGEX.test(query)
        ? 'beauty_keyword_match'
        : 'beauty_domain_intent',
    };
  }

  return {
    profileId: SEARCH_PROFILE_IDS.GENERAL,
    confidence: 'low',
    reason: 'fallback_general',
  };
}

function buildRulesApplied(profile, resolvedReason) {
  if (!profile) return [];
  const rules = [
    `profile:${profile.id}`,
    `ambiguity:${profile.ambiguityPolicy}`,
    `supplement:${profile.supplementPolicy?.externalParticipation || 'unknown'}`,
    `seed_strategy:${profile.supplementPolicy?.defaultSeedStrategy || 'legacy'}`,
    `filter_mode:${profile.filterPolicy?.mode || 'balanced'}`,
  ];
  if (resolvedReason) rules.push(`resolver:${resolvedReason}`);
  return rules;
}

function resolveSearchProfile({
  hint = null,
  queryText = '',
  queryClass = '',
  intent = null,
} = {}) {
  const hintedId = normalizeHintId(hint);
  if (hintedId && SEARCH_PROFILE_MAP[hintedId]) {
    const profile = SEARCH_PROFILE_MAP[hintedId];
    return {
      profile,
      confidence: 'hint',
      reason: 'explicit_profile_hint',
      rulesApplied: buildRulesApplied(profile, 'explicit_profile_hint'),
    };
  }

  const inferred = inferProfileIdFromSignals({
    queryText,
    queryClass,
    intent,
  });
  const profile = SEARCH_PROFILE_MAP[inferred.profileId] || SEARCH_PROFILE_MAP[SEARCH_PROFILE_IDS.GENERAL];
  return {
    profile,
    confidence: inferred.confidence || 'low',
    reason: inferred.reason || 'fallback_general',
    rulesApplied: buildRulesApplied(profile, inferred.reason),
  };
}

module.exports = {
  SEARCH_PROFILE_IDS,
  SEARCH_PROFILE_MAP,
  normalizeHintId,
  resolveSearchProfile,
};
