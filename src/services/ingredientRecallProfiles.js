const {
  getBestIngredientReferenceMatch,
} = require('./ingredientReferenceStore');
const {
  getBestIngredientSignalMatch,
} = require('./ingredientSignalStore');

const BASE_INGREDIENT_RECALL_PROFILES = Object.freeze({
  ceramide_np: Object.freeze({
    ingredient_id: 'ceramide_np',
    ingredient_name: 'Ceramide NP',
    exact_phrases: ['ceramide np'],
    alias_phrases: ['ceramide', 'ceramides'],
    family_phrases: ['barrier', 'repair', 'moisturizer', 'moisturiser', 'cream', 'sensitive'],
  }),
  panthenol: Object.freeze({
    ingredient_id: 'panthenol',
    ingredient_name: 'Panthenol (B5)',
    exact_phrases: ['panthenol'],
    alias_phrases: ['vitamin b5', 'provitamin b5', 'dexpanthenol', 'b5'],
    family_phrases: ['barrier', 'repair', 'soothing', 'hydrating', 'sensitive', 'serum'],
  }),
  niacinamide: Object.freeze({
    ingredient_id: 'niacinamide',
    ingredient_name: 'Niacinamide',
    exact_phrases: ['niacinamide'],
    alias_phrases: ['nicotinamide', 'vitamin b3'],
    family_phrases: ['balancing', 'oil control', 'clarifying', 'serum', 'gel'],
  }),
  zinc_pca: Object.freeze({
    ingredient_id: 'zinc_pca',
    ingredient_name: 'Zinc PCA',
    exact_phrases: ['zinc pca'],
    alias_phrases: ['zinc serum', 'zinc'],
    family_phrases: ['balancing', 'oil control', 'clarifying', 'serum', 'gel'],
  }),
  salicylic_acid: Object.freeze({
    ingredient_id: 'salicylic_acid',
    ingredient_name: 'Salicylic acid',
    exact_phrases: ['salicylic acid'],
    alias_phrases: ['bha'],
    family_phrases: ['blemish', 'acne', 'clarifying', 'lotion', 'treatment', 'serum'],
  }),
  azelaic_acid: Object.freeze({
    ingredient_id: 'azelaic_acid',
    ingredient_name: 'Azelaic acid',
    exact_phrases: ['azelaic acid'],
    alias_phrases: ['azelaic'],
    family_phrases: ['soothing', 'tone', 'cream', 'serum', 'treatment'],
  }),
  ascorbic_acid: Object.freeze({
    ingredient_id: 'ascorbic_acid',
    ingredient_name: 'Vitamin C (Ascorbic acid)',
    exact_phrases: ['ascorbic acid'],
    alias_phrases: ['vitamin c'],
    family_phrases: ['brightening', 'antioxidant', 'serum', 'daily'],
  }),
  retinol: Object.freeze({
    ingredient_id: 'retinol',
    ingredient_name: 'Retinol',
    exact_phrases: ['retinol'],
    alias_phrases: ['retinoid'],
    family_phrases: ['night', 'emulsion', 'renewal', 'treatment', 'serum'],
  }),
  benzoyl_peroxide: Object.freeze({
    ingredient_id: 'benzoyl_peroxide',
    ingredient_name: 'Benzoyl peroxide',
    exact_phrases: ['benzoyl peroxide'],
    alias_phrases: ['bpo'],
    family_phrases: ['blemish', 'acne', 'spot', 'gel', 'treatment'],
  }),
  sunscreen_filters: Object.freeze({
    ingredient_id: 'sunscreen_filters',
    ingredient_name: 'UV filters',
    exact_phrases: ['uv filters', 'uv filter'],
    alias_phrases: ['broad spectrum', 'sunscreen', 'spf', 'spf 50'],
    family_phrases: ['daily face', 'sun protection'],
  }),
  glycerin: Object.freeze({
    ingredient_id: 'glycerin',
    ingredient_name: 'Glycerin',
    exact_phrases: ['glycerin'],
    alias_phrases: ['glycerine'],
    family_phrases: ['hydrating', 'moisturizer', 'moisturiser', 'cream', 'barrier'],
  }),
  hyaluronic_acid: Object.freeze({
    ingredient_id: 'hyaluronic_acid',
    ingredient_name: 'Hyaluronic acid',
    exact_phrases: ['hyaluronic acid'],
    alias_phrases: ['sodium hyaluronate', 'hyaluron'],
    family_phrases: ['hydrating', 'serum', 'moisture', 'plumping'],
  }),
});

const REFERENCE_FLAG_FAMILY_PHRASES = Object.freeze({
  is_humectant: ['hydrating', 'moisture', 'plumping'],
  is_barrier_support: ['barrier', 'repair', 'moisturizer', 'cream'],
  is_retinoid: ['retinoid', 'night', 'renewal', 'serum', 'emulsion'],
  is_exfoliant: ['exfoliating', 'clarifying', 'toner', 'peel', 'treatment'],
  is_uv_filter: ['sunscreen', 'spf', 'broad spectrum', 'sun protection'],
  is_surfactant: ['cleanser', 'wash', 'foam'],
});

function normalizeIngredientRecallText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqNormalizedStrings(values, maxItems = 32) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeIngredientRecallText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 32)) break;
  }
  return out;
}

function cloneProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    ingredient_id: String(profile.ingredient_id || '').trim(),
    ingredient_name: String(profile.ingredient_name || '').trim(),
    exact_phrases: uniqNormalizedStrings(profile.exact_phrases, 24),
    alias_phrases: uniqNormalizedStrings(profile.alias_phrases, 32),
    family_phrases: uniqNormalizedStrings(profile.family_phrases, 24),
  };
}

function resolveIngredientRecallProfileIdFromText(value) {
  const normalized = normalizeIngredientRecallText(value);
  if (!normalized) return '';
  if (normalized === 'ceramide np' || normalized === 'ceramide') return 'ceramide_np';
  if (normalized === 'panthenol b5' || normalized === 'panthenol' || normalized === 'vitamin b5') return 'panthenol';
  if (normalized === 'niacinamide' || normalized === 'nicotinamide' || normalized === 'vitamin b3') return 'niacinamide';
  if (normalized === 'zinc pca' || normalized === 'zinc') return 'zinc_pca';
  if (normalized === 'salicylic acid bha' || normalized === 'salicylic acid' || normalized === 'bha') return 'salicylic_acid';
  if (normalized === 'azelaic acid' || normalized === 'azelaic') return 'azelaic_acid';
  if (normalized === 'vitamin c ascorbic acid' || normalized === 'vitamin c' || normalized === 'ascorbic acid') return 'ascorbic_acid';
  if (normalized === 'retinol' || normalized === 'retinoid') return 'retinol';
  if (normalized === 'benzoyl peroxide' || normalized === 'bpo') return 'benzoyl_peroxide';
  if (normalized === 'uv filters' || normalized === 'uv filter' || normalized === 'sunscreen filters') return 'sunscreen_filters';
  if (normalized === 'glycerin' || normalized === 'glycerine') return 'glycerin';
  if (normalized === 'hyaluronic acid' || normalized === 'sodium hyaluronate' || normalized === 'hyaluron') {
    return 'hyaluronic_acid';
  }
  for (const profile of Object.values(BASE_INGREDIENT_RECALL_PROFILES)) {
    const phrases = [
      ...profile.exact_phrases,
      ...profile.alias_phrases,
    ];
    if (phrases.some((phrase) => normalized.includes(normalizeIngredientRecallText(phrase)))) {
      return profile.ingredient_id;
    }
  }
  return '';
}

function buildCandidateLookupTexts({ target = null, query = '', ingredientId = '' } = {}) {
  const targetObj = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  return uniqNormalizedStrings([
    ingredientId,
    targetObj.ingredient_id,
    targetObj.ingredientId,
    targetObj.ingredient_name,
    targetObj.ingredientName,
    targetObj.ingredient,
    targetObj.name,
    targetObj.title,
    query,
  ], 8);
}

function resolveIngredientRecallProfileId({ target = null, query = '', ingredientId = '' } = {}) {
  const directId = normalizeIngredientRecallText(ingredientId).replace(/\s+/g, '_');
  if (directId && BASE_INGREDIENT_RECALL_PROFILES[directId]) return directId;
  for (const candidate of buildCandidateLookupTexts({ target, query, ingredientId })) {
    const resolved = resolveIngredientRecallProfileIdFromText(candidate);
    if (resolved) return resolved;
  }
  return '';
}

function resolveIngredientRecallProfile({ target = null, query = '', ingredientId = '' } = {}) {
  const profileId = resolveIngredientRecallProfileId({ target, query, ingredientId });
  return profileId ? cloneProfile(BASE_INGREDIENT_RECALL_PROFILES[profileId]) : null;
}

function buildReferenceFamilyPhrases(referenceMatch) {
  const row = referenceMatch && typeof referenceMatch === 'object' ? referenceMatch : {};
  const flags = row.flags && typeof row.flags === 'object' ? row.flags : {};
  const phrases = [
    row.ingredient_family,
    row.primary_bucket,
    ...(Array.isArray(row.all_buckets_list) ? row.all_buckets_list : []),
    ...(Array.isArray(row.function_tags_list) ? row.function_tags_list : []),
    ...(Array.isArray(row.benefit_tags_list) ? row.benefit_tags_list : []),
  ];
  for (const [flagName, familyPhrases] of Object.entries(REFERENCE_FLAG_FAMILY_PHRASES)) {
    if (flags[flagName] === true) phrases.push(...familyPhrases);
  }
  return uniqNormalizedStrings(phrases, 24);
}

function buildReferenceProfile(referenceMatch, ingredientId = '') {
  const row = referenceMatch && typeof referenceMatch === 'object' ? referenceMatch : null;
  if (!row) return null;
  const normalizedId =
    String(ingredientId || '').trim() ||
    resolveIngredientRecallProfileIdFromText(row.canonical_display_name || row.canonical_inci_name || '');
  return cloneProfile({
    ingredient_id: normalizedId,
    ingredient_name: row.canonical_display_name || row.canonical_inci_name || '',
    exact_phrases: [
      row.canonical_inci_name,
      row.canonical_display_name,
      row.us_label_name,
      row.eu_label_name,
    ],
    alias_phrases: [
      ...(Array.isArray(row.aliases_common_list) ? row.aliases_common_list : []),
      ...(Array.isArray(row.parser_variants_list) ? row.parser_variants_list : []),
      ...(Array.isArray(row.lookup_terms) ? row.lookup_terms : []),
      ...(Array.isArray(row.us_label_variants_list) ? row.us_label_variants_list : []),
      ...(Array.isArray(row.eu_label_variants_list) ? row.eu_label_variants_list : []),
    ],
    family_phrases: buildReferenceFamilyPhrases(row),
  });
}

function buildSignalProfile(signalMatch, ingredientId = '') {
  const row = signalMatch && typeof signalMatch === 'object' ? signalMatch : null;
  if (!row) return null;
  return cloneProfile({
    ingredient_id: String(ingredientId || '').trim(),
    ingredient_name: row.display_signal_name || row.signal_key || '',
    exact_phrases: [row.display_signal_name, row.signal_key],
    alias_phrases: [
      ...(Array.isArray(row.raw_token_variants_list) ? row.raw_token_variants_list : []),
      ...(Array.isArray(row.normalized_token_variants_list) ? row.normalized_token_variants_list : []),
    ],
    family_phrases: [
      row.signal_bucket,
      ...(Array.isArray(row.top_categories_list) ? row.top_categories_list : []),
      ...(Array.isArray(row.resolution_rationales_list) ? row.resolution_rationales_list : []),
    ],
  });
}

function mergeRecallProfiles(...profiles) {
  const valid = profiles.filter((profile) => profile && typeof profile === 'object');
  if (!valid.length) return null;
  const first = valid[0];
  return cloneProfile({
    ingredient_id: valid.find((profile) => String(profile.ingredient_id || '').trim())?.ingredient_id || '',
    ingredient_name: valid.find((profile) => String(profile.ingredient_name || '').trim())?.ingredient_name || '',
    exact_phrases: valid.flatMap((profile) => profile.exact_phrases || []),
    alias_phrases: valid.flatMap((profile) => profile.alias_phrases || []),
    family_phrases: valid.flatMap((profile) => profile.family_phrases || []),
  }) || cloneProfile(first);
}

async function safeGetBestReferenceMatch(input) {
  try {
    return await getBestIngredientReferenceMatch(input);
  } catch (_err) {
    return null;
  }
}

async function safeGetBestSignalMatch(input) {
  try {
    return await getBestIngredientSignalMatch(input);
  } catch (_err) {
    return null;
  }
}

async function resolveIngredientRecallProfileKnowledge({ target = null, query = '', ingredientId = '' } = {}) {
  const baseProfile = resolveIngredientRecallProfile({ target, query, ingredientId });
  const lookupTexts = buildCandidateLookupTexts({ target, query, ingredientId });
  let referenceMatch = null;
  for (const candidate of lookupTexts) {
    referenceMatch = await safeGetBestReferenceMatch(candidate);
    if (referenceMatch) break;
  }
  let signalMatch = null;
  for (const candidate of [
    referenceMatch?.canonical_display_name,
    referenceMatch?.canonical_inci_name,
    ...lookupTexts,
  ]) {
    const normalized = normalizeIngredientRecallText(candidate);
    if (!normalized) continue;
    signalMatch = await safeGetBestSignalMatch(normalized);
    if (signalMatch) break;
  }
  const resolvedIngredientId =
    baseProfile?.ingredient_id ||
    resolveIngredientRecallProfileIdFromText(referenceMatch?.canonical_display_name || referenceMatch?.canonical_inci_name || '') ||
    resolveIngredientRecallProfileIdFromText(signalMatch?.display_signal_name || signalMatch?.signal_key || '') ||
    '';
  const referenceProfile = buildReferenceProfile(referenceMatch, resolvedIngredientId);
  const signalProfile = buildSignalProfile(signalMatch, resolvedIngredientId || referenceProfile?.ingredient_id || '');
  const mergedProfile = mergeRecallProfiles(baseProfile, referenceProfile, signalProfile);
  const profileSource = mergedProfile
    ? referenceProfile || signalProfile
      ? baseProfile
        ? 'base_plus_kb'
        : 'kb_only'
      : 'base_only'
    : 'none';
  return {
    profile: mergedProfile,
    diagnostics: {
      profile_source: profileSource,
      reference_match_found: Boolean(referenceMatch),
      signal_match_found: Boolean(signalMatch),
      lookup_texts: lookupTexts.slice(0, 4),
    },
    referenceMatch,
    signalMatch,
  };
}

module.exports = {
  BASE_INGREDIENT_RECALL_PROFILES,
  normalizeIngredientRecallText,
  resolveIngredientRecallProfileId,
  resolveIngredientRecallProfile,
  resolveIngredientRecallProfileKnowledge,
};
