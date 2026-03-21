const {
  getBestIngredientReferenceMatch,
  getIngredientReferenceStoreHealth,
} = require('./ingredientReferenceStore');
const {
  getBestIngredientSignalMatch,
  getIngredientSignalStoreHealth,
} = require('./ingredientSignalStore');

const LOCAL_INGREDIENT_RECALL_REGISTRY = Object.freeze({
  ceramide_np: Object.freeze({
    ingredient_id: 'ceramide_np',
    display_name: 'Ceramide NP',
    ingredient_class: 'barrier_support',
    exact_phrases: ['ceramide np'],
    alias_phrases: ['ceramide', 'ceramides'],
    family_phrases: ['barrier', 'repair', 'moisturizer', 'moisturiser', 'cream', 'sensitive'],
    expected_step_families: ['moisturizer', 'serum'],
  }),
  panthenol: Object.freeze({
    ingredient_id: 'panthenol',
    display_name: 'Panthenol (B5)',
    ingredient_class: 'soothing_humectant',
    exact_phrases: ['panthenol'],
    alias_phrases: ['vitamin b5', 'provitamin b5', 'dexpanthenol', 'b5'],
    family_phrases: ['barrier', 'repair', 'soothing', 'hydrating', 'sensitive', 'serum'],
    expected_step_families: ['serum', 'moisturizer'],
  }),
  niacinamide: Object.freeze({
    ingredient_id: 'niacinamide',
    display_name: 'Niacinamide',
    ingredient_class: 'balancing_active',
    exact_phrases: ['niacinamide'],
    alias_phrases: ['nicotinamide', 'vitamin b3'],
    family_phrases: ['balancing', 'oil control', 'clarifying', 'serum', 'gel'],
    expected_step_families: ['serum', 'treatment'],
  }),
  zinc_pca: Object.freeze({
    ingredient_id: 'zinc_pca',
    display_name: 'Zinc PCA',
    ingredient_class: 'balancing_active',
    exact_phrases: ['zinc pca'],
    alias_phrases: ['zinc'],
    family_phrases: ['balancing', 'oil control', 'clarifying', 'serum', 'gel'],
    expected_step_families: ['serum', 'treatment'],
  }),
  salicylic_acid: Object.freeze({
    ingredient_id: 'salicylic_acid',
    display_name: 'Salicylic acid',
    ingredient_class: 'exfoliant',
    exact_phrases: ['salicylic acid'],
    alias_phrases: ['bha'],
    family_phrases: ['blemish', 'acne', 'clarifying', 'gel', 'treatment', 'cleanser'],
    expected_step_families: ['treatment', 'serum', 'cleanser'],
  }),
  azelaic_acid: Object.freeze({
    ingredient_id: 'azelaic_acid',
    display_name: 'Azelaic acid',
    ingredient_class: 'tone_evening_active',
    exact_phrases: ['azelaic acid'],
    alias_phrases: ['azelaic'],
    family_phrases: ['redness', 'tone', 'cream', 'serum', 'treatment'],
    expected_step_families: ['treatment', 'cream', 'serum'],
  }),
  ascorbic_acid: Object.freeze({
    ingredient_id: 'ascorbic_acid',
    display_name: 'Vitamin C (Ascorbic acid)',
    ingredient_class: 'antioxidant',
    exact_phrases: ['ascorbic acid'],
    alias_phrases: ['vitamin c', 'l ascorbic acid'],
    family_phrases: ['brightening', 'antioxidant', 'serum', 'daily'],
    expected_step_families: ['serum', 'treatment'],
  }),
  retinol: Object.freeze({
    ingredient_id: 'retinol',
    display_name: 'Retinol',
    ingredient_class: 'retinoid',
    exact_phrases: ['retinol'],
    alias_phrases: ['retinoid', 'vitamin a'],
    family_phrases: ['night', 'renewal', 'treatment', 'serum', 'cream'],
    expected_step_families: ['serum', 'treatment', 'cream'],
  }),
  benzoyl_peroxide: Object.freeze({
    ingredient_id: 'benzoyl_peroxide',
    display_name: 'Benzoyl peroxide',
    ingredient_class: 'acne_active',
    exact_phrases: ['benzoyl peroxide'],
    alias_phrases: ['bpo'],
    family_phrases: ['blemish', 'acne', 'spot', 'gel', 'treatment'],
    expected_step_families: ['treatment', 'gel', 'cleanser'],
  }),
  sunscreen_filters: Object.freeze({
    ingredient_id: 'sunscreen_filters',
    display_name: 'UV filters',
    ingredient_class: 'uv_filter',
    exact_phrases: ['uv filters', 'uv filter'],
    alias_phrases: ['broad spectrum', 'sunscreen', 'spf', 'sun protection'],
    family_phrases: ['face sunscreen', 'daily spf', 'mineral sunscreen'],
    expected_step_families: ['sunscreen'],
  }),
  glycerin: Object.freeze({
    ingredient_id: 'glycerin',
    display_name: 'Glycerin',
    ingredient_class: 'humectant',
    exact_phrases: ['glycerin'],
    alias_phrases: ['glycerine'],
    family_phrases: ['hydrating', 'moisturizer', 'moisturiser', 'cream', 'barrier'],
    expected_step_families: ['moisturizer', 'serum'],
  }),
  hyaluronic_acid: Object.freeze({
    ingredient_id: 'hyaluronic_acid',
    display_name: 'Hyaluronic acid',
    ingredient_class: 'humectant',
    exact_phrases: ['hyaluronic acid'],
    alias_phrases: ['sodium hyaluronate', 'hyaluron'],
    family_phrases: ['hydrating', 'serum', 'moisture', 'plumping'],
    expected_step_families: ['serum', 'moisturizer'],
  }),
  alpha_arbutin: Object.freeze({
    ingredient_id: 'alpha_arbutin',
    display_name: 'Alpha Arbutin',
    ingredient_class: 'tone_evening_active',
    exact_phrases: ['alpha arbutin'],
    alias_phrases: ['alpha-arbutin', 'arbutin alpha'],
    family_phrases: ['brightening', 'tone', 'serum'],
    expected_step_families: ['serum', 'treatment'],
  }),
  squalane: Object.freeze({
    ingredient_id: 'squalane',
    display_name: 'Squalane',
    ingredient_class: 'emollient',
    exact_phrases: ['squalane'],
    alias_phrases: ['plant squalane'],
    family_phrases: ['barrier', 'moisturizer', 'oil', 'hydrating'],
    expected_step_families: ['moisturizer', 'oil', 'serum'],
  }),
  centella_asiatica: Object.freeze({
    ingredient_id: 'centella_asiatica',
    display_name: 'Centella asiatica',
    ingredient_class: 'soothing_botanical',
    exact_phrases: ['centella asiatica'],
    alias_phrases: ['centella', 'cica', 'madecassoside'],
    family_phrases: ['soothing', 'barrier', 'redness', 'serum', 'cream'],
    expected_step_families: ['serum', 'moisturizer', 'cream'],
  }),
  tranexamic_acid: Object.freeze({
    ingredient_id: 'tranexamic_acid',
    display_name: 'Tranexamic acid',
    ingredient_class: 'tone_evening_active',
    exact_phrases: ['tranexamic acid'],
    alias_phrases: ['tranexamic', 'txa'],
    family_phrases: ['brightening', 'tone', 'serum', 'treatment'],
    expected_step_families: ['serum', 'treatment'],
  }),
  peptides: Object.freeze({
    ingredient_id: 'peptides',
    display_name: 'Peptides',
    ingredient_class: 'peptide_complex',
    exact_phrases: ['peptides', 'peptide'],
    alias_phrases: ['multi peptide', 'copper peptide', 'tripeptide', 'tetrapeptide', 'hexapeptide'],
    family_phrases: ['firming', 'serum', 'anti aging'],
    expected_step_families: ['serum', 'treatment'],
  }),
  glycolic_acid: Object.freeze({
    ingredient_id: 'glycolic_acid',
    display_name: 'Glycolic acid',
    ingredient_class: 'exfoliant',
    exact_phrases: ['glycolic acid'],
    alias_phrases: ['aha', 'glycolic'],
    family_phrases: ['exfoliating', 'toner', 'peel', 'treatment'],
    expected_step_families: ['treatment', 'toner', 'serum'],
  }),
  lactic_acid: Object.freeze({
    ingredient_id: 'lactic_acid',
    display_name: 'Lactic acid',
    ingredient_class: 'exfoliant',
    exact_phrases: ['lactic acid'],
    alias_phrases: ['lactate'],
    family_phrases: ['exfoliating', 'serum', 'treatment'],
    expected_step_families: ['treatment', 'serum'],
  }),
  mandelic_acid: Object.freeze({
    ingredient_id: 'mandelic_acid',
    display_name: 'Mandelic acid',
    ingredient_class: 'exfoliant',
    exact_phrases: ['mandelic acid'],
    alias_phrases: ['mandelic'],
    family_phrases: ['exfoliating', 'serum', 'treatment'],
    expected_step_families: ['treatment', 'serum'],
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

const STEP_FAMILY_HINTS = Object.freeze({
  sunscreen: ['sunscreen', 'spf', 'sun protection', 'uv filter', 'uv filters'],
  moisturizer: ['moisturizer', 'moisturiser', 'cream', 'barrier repair', 'rich cream'],
  serum: ['serum', 'essence', 'ampoule'],
  treatment: ['treatment', 'spot treatment', 'suspension', 'peel'],
  cleanser: ['cleanser', 'wash', 'foam'],
  oil: ['oil', 'face oil'],
  toner: ['toner', 'pad', 'liquid exfoliant'],
});

let registryHealthCache = {
  checked_at: 0,
  health: null,
};

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

function uniqStrings(values, maxItems = 32) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 32)) break;
  }
  return out;
}

function cloneProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    ingredient_id: String(profile.ingredient_id || '').trim(),
    ingredient_name: String(profile.display_name || profile.ingredient_name || '').trim(),
    display_name: String(profile.display_name || profile.ingredient_name || '').trim(),
    ingredient_class: String(profile.ingredient_class || '').trim() || null,
    exact_phrases: uniqNormalizedStrings(profile.exact_phrases, 24),
    alias_phrases: uniqNormalizedStrings(profile.alias_phrases, 32),
    family_phrases: uniqNormalizedStrings(profile.family_phrases, 24),
    expected_step_families: uniqNormalizedStrings(profile.expected_step_families, 12),
  };
}

function buildLocalLookupTexts({ target = null, query = '', ingredientId = '' } = {}) {
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
  ], 10);
}

function inferStepFamiliesFromPhrases(values) {
  const text = uniqNormalizedStrings(values, 40).join(' ');
  const out = [];
  for (const [stepFamily, hints] of Object.entries(STEP_FAMILY_HINTS)) {
    if (Array.isArray(hints) && hints.some((hint) => text.includes(normalizeIngredientRecallText(hint)))) {
      out.push(stepFamily);
    }
  }
  return uniqNormalizedStrings(out, 12);
}

function slugifyIngredientId(value) {
  return normalizeIngredientRecallText(value).replace(/\s+/g, '_');
}

function inferIngredientClassFromReference(row = {}) {
  const flags = row.flags && typeof row.flags === 'object' ? row.flags : {};
  if (flags.is_uv_filter === true) return 'uv_filter';
  if (flags.is_retinoid === true) return 'retinoid';
  if (flags.is_exfoliant === true) return 'exfoliant';
  if (flags.is_barrier_support === true) return 'barrier_support';
  if (flags.is_humectant === true) return 'humectant';
  if (flags.is_surfactant === true) return 'surfactant';
  return String(row.primary_bucket || row.ingredient_family || '').trim() || null;
}

function inferStepFamiliesFromReference(row = {}) {
  const hints = [
    row.ingredient_family,
    row.primary_bucket,
    ...(Array.isArray(row.all_buckets_list) ? row.all_buckets_list : []),
    ...(Array.isArray(row.function_tags_list) ? row.function_tags_list : []),
    ...(Array.isArray(row.benefit_tags_list) ? row.benefit_tags_list : []),
  ];
  return inferStepFamiliesFromPhrases(hints);
}

function inferIngredientClassFromSignal(row = {}) {
  return String(row.signal_bucket || '').trim() || null;
}

function inferStepFamiliesFromSignal(row = {}) {
  return inferStepFamiliesFromPhrases([
    row.signal_bucket,
    ...(Array.isArray(row.top_categories_list) ? row.top_categories_list : []),
    ...(Array.isArray(row.resolution_rationales_list) ? row.resolution_rationales_list : []),
  ]);
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
  return cloneProfile({
    ingredient_id:
      String(ingredientId || '').trim() ||
      slugifyIngredientId(row.canonical_display_name || row.canonical_inci_name || row.us_label_name || ''),
    display_name: row.canonical_display_name || row.canonical_inci_name || row.us_label_name || '',
    ingredient_class: inferIngredientClassFromReference(row),
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
    expected_step_families: inferStepFamiliesFromReference(row),
  });
}

function buildSignalProfile(signalMatch, ingredientId = '') {
  const row = signalMatch && typeof signalMatch === 'object' ? signalMatch : null;
  if (!row) return null;
  return cloneProfile({
    ingredient_id:
      String(ingredientId || '').trim() || slugifyIngredientId(row.display_signal_name || row.signal_key || ''),
    display_name: row.display_signal_name || row.signal_key || '',
    ingredient_class: inferIngredientClassFromSignal(row),
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
    expected_step_families: inferStepFamiliesFromSignal(row),
  });
}

function mergeRecallProfiles(...profiles) {
  const valid = profiles.filter((profile) => profile && typeof profile === 'object');
  if (!valid.length) return null;
  return cloneProfile({
    ingredient_id: valid.find((profile) => String(profile.ingredient_id || '').trim())?.ingredient_id || '',
    display_name:
      valid.find((profile) => String(profile.display_name || profile.ingredient_name || '').trim())
        ?.display_name ||
      valid[0].ingredient_name ||
      '',
    ingredient_class:
      valid.find((profile) => String(profile.ingredient_class || '').trim())?.ingredient_class || null,
    exact_phrases: valid.flatMap((profile) => profile.exact_phrases || []),
    alias_phrases: valid.flatMap((profile) => profile.alias_phrases || []),
    family_phrases: valid.flatMap((profile) => profile.family_phrases || []),
    expected_step_families: valid.flatMap((profile) => profile.expected_step_families || []),
  });
}

function resolveLocalRegistryProfileIdFromText(value) {
  const normalized = normalizeIngredientRecallText(value);
  if (!normalized) return '';
  let bestId = '';
  let bestScore = 0;
  for (const [ingredientId, rawProfile] of Object.entries(LOCAL_INGREDIENT_RECALL_REGISTRY)) {
    const profile = cloneProfile(rawProfile);
    if (!profile) continue;
    if (profile.exact_phrases.includes(normalized)) return ingredientId;
    const exactScore = profile.exact_phrases.some((phrase) => normalized.includes(phrase)) ? 3 : 0;
    const aliasScore = profile.alias_phrases.some((phrase) => normalized.includes(phrase)) ? 2 : 0;
    const familyScore = profile.family_phrases.some((phrase) => normalized.includes(phrase)) ? 1 : 0;
    const score = exactScore + aliasScore + familyScore;
    if (score > bestScore) {
      bestScore = score;
      bestId = ingredientId;
    }
  }
  return bestScore > 0 ? bestId : '';
}

function resolveLocalRegistryProfile({ target = null, query = '', ingredientId = '' } = {}) {
  const directId = slugifyIngredientId(ingredientId);
  if (directId && LOCAL_INGREDIENT_RECALL_REGISTRY[directId]) {
    return cloneProfile(LOCAL_INGREDIENT_RECALL_REGISTRY[directId]);
  }
  for (const text of buildLocalLookupTexts({ target, query, ingredientId })) {
    const resolvedId = resolveLocalRegistryProfileIdFromText(text);
    if (resolvedId && LOCAL_INGREDIENT_RECALL_REGISTRY[resolvedId]) {
      return cloneProfile(LOCAL_INGREDIENT_RECALL_REGISTRY[resolvedId]);
    }
  }
  return null;
}

function resolveIngredientRecallProfileId({ target = null, query = '', ingredientId = '' } = {}) {
  const localProfile = resolveLocalRegistryProfile({ target, query, ingredientId });
  return String(localProfile?.ingredient_id || '').trim();
}

function resolveIngredientRecallProfile({ target = null, query = '', ingredientId = '' } = {}) {
  return resolveLocalRegistryProfile({ target, query, ingredientId });
}

function buildRegistrySource(registryParts) {
  const activeSources = Object.entries(registryParts)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
  if (!activeSources.length) return 'none';
  if (activeSources.length === 1) return activeSources[0];
  return activeSources.join('_plus_');
}

function hasIngredientRegistryIntentSignal(queryText) {
  return Boolean(resolveLocalRegistryProfile({ query: queryText }));
}

function hasConfiguredReferenceSource() {
  return Boolean(
    String(process.env.INGREDIENT_REFERENCE_DATABASE_URL || process.env.PIVOTA_KB_DATABASE_URL || '').trim(),
  );
}

function hasConfiguredSignalSource() {
  return Boolean(
    String(
      process.env.INGREDIENT_SIGNAL_DATABASE_URL ||
      process.env.INGREDIENT_REFERENCE_DATABASE_URL ||
      process.env.PIVOTA_KB_DATABASE_URL ||
      process.env.DATABASE_URL ||
      '',
    ).trim(),
  );
}

async function safeGetBestIngredientReferenceMatch(text) {
  const normalized = normalizeIngredientRecallText(text);
  if (!normalized) return null;
  try {
    return await getBestIngredientReferenceMatch(normalized);
  } catch (_err) {
    return null;
  }
}

async function safeGetBestIngredientSignalMatch(text) {
  const normalized = normalizeIngredientRecallText(text);
  if (!normalized) return null;
  try {
    return await getBestIngredientSignalMatch(normalized);
  } catch (_err) {
    return null;
  }
}

async function getIngredientRecallRegistryHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && registryHealthCache.health && now - Number(registryHealthCache.checked_at || 0) < 60_000) {
    return registryHealthCache.health;
  }
  const [referenceHealth, signalHealth] = await Promise.all([
    typeof getIngredientReferenceStoreHealth === 'function'
      ? getIngredientReferenceStoreHealth()
      : Promise.resolve({
          source: 'reference',
          configured: false,
          reachable: false,
          view_reachable: false,
          available: false,
          reason: 'health_not_implemented',
        }),
    typeof getIngredientSignalStoreHealth === 'function'
      ? getIngredientSignalStoreHealth()
      : Promise.resolve({
          source: 'signal',
          configured: false,
          reachable: false,
          view_reachable: false,
          available: false,
          reason: 'health_not_implemented',
        }),
  ]);
  const health = {
    ok:
      Boolean(referenceHealth?.available) ||
      Boolean(signalHealth?.available) ||
      Object.keys(LOCAL_INGREDIENT_RECALL_REGISTRY).length > 0,
    sources: {
      reference: referenceHealth,
      signal: signalHealth,
      local: {
        source: 'local',
        configured: true,
        reachable: true,
        view_reachable: true,
        available: Object.keys(LOCAL_INGREDIENT_RECALL_REGISTRY).length > 0,
        reason: null,
        profile_count: Object.keys(LOCAL_INGREDIENT_RECALL_REGISTRY).length,
      },
    },
    checked_at: new Date(now).toISOString(),
  };
  registryHealthCache = {
    checked_at: now,
    health,
  };
  return health;
}

async function resolveIngredientRecallProfileKnowledge({ target = null, query = '', ingredientId = '' } = {}) {
  const lookupTexts = buildLocalLookupTexts({ target, query, ingredientId });
  const localProfile = resolveLocalRegistryProfile({ target, query, ingredientId });

  let referenceMatch = null;
  for (const text of lookupTexts) {
    referenceMatch = await safeGetBestIngredientReferenceMatch(text);
    if (referenceMatch) break;
  }

  let signalMatch = null;
  for (const text of [
    referenceMatch?.canonical_display_name,
    referenceMatch?.canonical_inci_name,
    ...lookupTexts,
  ]) {
    signalMatch = await safeGetBestIngredientSignalMatch(text);
    if (signalMatch) break;
  }

  const resolvedIngredientId =
    String(ingredientId || '').trim() ||
    localProfile?.ingredient_id ||
    resolveLocalRegistryProfileIdFromText(referenceMatch?.canonical_display_name || referenceMatch?.canonical_inci_name || '') ||
    resolveLocalRegistryProfileIdFromText(signalMatch?.display_signal_name || signalMatch?.signal_key || '') ||
    slugifyIngredientId(referenceMatch?.canonical_display_name || referenceMatch?.canonical_inci_name || signalMatch?.display_signal_name || signalMatch?.signal_key || '');

  const referenceProfile = buildReferenceProfile(referenceMatch, resolvedIngredientId);
  const signalProfile = buildSignalProfile(signalMatch, resolvedIngredientId || referenceProfile?.ingredient_id || '');
  const mergedProfile = mergeRecallProfiles(localProfile, referenceProfile, signalProfile);
  const registrySource = buildRegistrySource({
    local: localProfile,
    reference: referenceProfile,
    signal: signalProfile,
  });
  const registryAvailable =
    hasConfiguredReferenceSource() ||
    hasConfiguredSignalSource() ||
    Object.keys(LOCAL_INGREDIENT_RECALL_REGISTRY).length > 0;
  const registryMatch = Boolean(mergedProfile);
  const registryUnavailable = registryAvailable !== true && registryMatch !== true;
  return {
    profile: mergedProfile,
    diagnostics: {
      registry_match: registryMatch,
      registry_source: registrySource,
      registry_source_breakdown: {
        local: localProfile ? 1 : 0,
        reference: referenceProfile ? 1 : 0,
        signal: signalProfile ? 1 : 0,
      },
      profile_source: registrySource === 'none' ? 'none' : registrySource,
      reference_match_found: Boolean(referenceMatch),
      signal_match_found: Boolean(signalMatch),
      local_match_found: Boolean(localProfile),
      lookup_texts: lookupTexts.slice(0, 6),
      registry_unavailable: registryUnavailable,
      registry_health: {
        reference_available: hasConfiguredReferenceSource(),
        signal_available: hasConfiguredSignalSource(),
        local_available: Object.keys(LOCAL_INGREDIENT_RECALL_REGISTRY).length > 0,
      },
    },
    referenceMatch,
    signalMatch,
    localProfile,
  };
}

module.exports = {
  LOCAL_INGREDIENT_RECALL_REGISTRY,
  BASE_INGREDIENT_RECALL_PROFILES: LOCAL_INGREDIENT_RECALL_REGISTRY,
  normalizeIngredientRecallText,
  resolveIngredientRecallProfileId,
  resolveIngredientRecallProfile,
  resolveIngredientRecallProfileKnowledge,
  hasIngredientRegistryIntentSignal,
  getIngredientRecallRegistryHealth,
  _internals: {
    cloneProfile,
    buildLocalLookupTexts,
    inferStepFamiliesFromPhrases,
    slugifyIngredientId,
    resolveLocalRegistryProfileIdFromText,
    resolveLocalRegistryProfile,
    mergeRecallProfiles,
  },
};
