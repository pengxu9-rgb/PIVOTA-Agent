const { query } = require('../db');
const { kbQuery } = require('./pciKbClient');
const { buildExternalSeedProduct } = require('./externalSeedProducts');
const {
  getRecoTargetFamilyRelation,
  normalizeRecoTargetStep,
  resolveRecoTargetStepIntent,
} = require('../auroraBff/recoTargetStep');

const DEFAULT_MARKET = String(process.env.CREATOR_CATEGORIES_EXTERNAL_SEED_MARKET || 'US')
  .trim()
  .toUpperCase() || 'US';
const DEFAULT_TOOL = 'creator_agents';
const BUNDLE_LIKE_RE =
  /\b(sample|sampler|mini|travel|kit|set|bundle|duo|trio|quartet|collection|collector|starter|discovery|routine|regimen)\b/i;
const WEAK_FAMILY_ONLY_PHRASES = new Set([
  'serum',
  'moisturizer',
  'moisturiser',
  'cream',
  'gel',
  'lotion',
  'daily',
  'treatment',
  'emulsion',
  'face',
]);
const INGREDIENT_RECALL_OBVIOUS_NOISE_RE =
  /\b(concealer|foundation|brush|powder|spa|coupon|mascara|lash|eyeliner|brow)\b/i;

const INGREDIENT_RECALL_PROFILES = Object.freeze({
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

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9%+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqStrings(values, maxItems = 24) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= Math.max(1, Number(maxItems) || 24)) break;
  }
  return out;
}

function resolveIngredientIdFromText(value) {
  const normalized = normalizeText(value);
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
  if (
    normalized === 'hyaluronic acid' ||
    normalized === 'sodium hyaluronate' ||
    normalized === 'hyaluron'
  ) return 'hyaluronic_acid';
  for (const profile of Object.values(INGREDIENT_RECALL_PROFILES)) {
    const phrases = [
      ...profile.exact_phrases,
      ...profile.alias_phrases,
    ];
    if (phrases.some((phrase) => normalizeText(phrase) && normalized.includes(normalizeText(phrase)))) {
      return profile.ingredient_id;
    }
  }
  return '';
}

function resolveIngredientRecallProfile({ target = null, query = '', ingredientId = '' } = {}) {
  const explicitId = normalizeText(ingredientId).replace(/\s+/g, '_');
  if (explicitId && INGREDIENT_RECALL_PROFILES[explicitId]) return INGREDIENT_RECALL_PROFILES[explicitId];
  const targetObj = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  const targetId = resolveIngredientIdFromText(
    targetObj.ingredient_id ||
      targetObj.ingredientId ||
      targetObj.ingredient_name ||
      targetObj.ingredientName ||
      targetObj.ingredient ||
      targetObj.name ||
      targetObj.title ||
      '',
  );
  if (targetId && INGREDIENT_RECALL_PROFILES[targetId]) return INGREDIENT_RECALL_PROFILES[targetId];
  const queryId = resolveIngredientIdFromText(query);
  return queryId ? INGREDIENT_RECALL_PROFILES[queryId] || null : null;
}

function buildPhrasePatterns(phrases) {
  return uniqStrings(
    (Array.isArray(phrases) ? phrases : [])
      .map((phrase) => normalizeText(phrase))
      .filter(Boolean)
      .map((phrase) => `%${phrase}%`),
    16,
  );
}

function countPhraseMatches(text, phrases) {
  const haystack = ` ${normalizeText(text)} `;
  if (!haystack.trim()) return 0;
  let hits = 0;
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const normalized = normalizeText(phrase);
    if (!normalized) continue;
    if (haystack.includes(` ${normalized} `)) hits += 1;
  }
  return hits;
}

function countStrongFamilyMatches(text, phrases) {
  const haystack = ` ${normalizeText(text)} `;
  if (!haystack.trim()) return 0;
  let hits = 0;
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const normalized = normalizeText(phrase);
    if (!normalized || WEAK_FAMILY_ONLY_PHRASES.has(normalized)) continue;
    if (haystack.includes(` ${normalized} `)) hits += 1;
  }
  return hits;
}

function normalizeIngredientRecallTitleForDedupe(product) {
  if (!product || typeof product !== 'object') return '';
  const title = String(
    product.title ||
      product.name ||
      product.display_name ||
      product.product_name ||
      '',
  ).trim();
  return title ? normalizeText(title) : '';
}

function buildIngredientRecallProductText(product) {
  const row = product && typeof product === 'object' ? product : {};
  const seedData = row.seed_data && typeof row.seed_data === 'object' ? row.seed_data : {};
  const snapshot = seedData.snapshot && typeof seedData.snapshot === 'object' ? seedData.snapshot : {};
  return [
    row.title,
    row.name,
    row.display_name,
    row.product_name,
    row.brand,
    row.vendor,
    row.category,
    row.product_type,
    row.description,
    ...(Array.isArray(row.tag_tokens) ? row.tag_tokens : []),
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []),
    ...(Array.isArray(row.skin_type_tags) ? row.skin_type_tags : []),
    snapshot.title,
    snapshot.description,
    snapshot.category,
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function resolveIngredientRecallCandidateStep(product) {
  const row = product && typeof product === 'object' ? product : {};
  const direct =
    normalizeRecoTargetStep(row.category) ||
    normalizeRecoTargetStep(row.product_type) ||
    normalizeRecoTargetStep(row.title) ||
    normalizeRecoTargetStep(row.name);
  if (direct) return direct;
  const resolved = resolveRecoTargetStepIntent({
    text: [
      row.title,
      row.name,
      row.display_name,
      row.category,
      row.product_type,
      row.description,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' '),
  });
  return normalizeRecoTargetStep(resolved?.resolved_target_step || '');
}

function buildIngredientRecallDisplayDedupeKey(product, { targetStepFamily = '' } = {}) {
  let titleKey = normalizeIngredientRecallTitleForDedupe(product);
  if (!titleKey) return '';
  if (normalizeRecoTargetStep(targetStepFamily) !== 'sunscreen') return titleKey;
  titleKey = titleKey
    .replace(/\brefill\b/g, ' ')
    .replace(/\beu\b/g, ' ')
    .replace(/\s+\d+\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return titleKey;
}

function collapseIngredientRecallProducts(products, options = {}) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return [];
  const perTitleLimitRaw = Number(options.perTitleLimit);
  const perTitleLimit =
    Number.isFinite(perTitleLimitRaw) && perTitleLimitRaw >= 1
      ? Math.floor(perTitleLimitRaw)
      : 1;
  const counts = new Map();
  const seenDedupeKeys = new Set();
  const dedupeKey =
    typeof options.dedupeKey === 'function'
      ? options.dedupeKey
      : null;
  const out = [];
  for (const product of list) {
    const productDedupeKey = dedupeKey ? String(dedupeKey(product) || '').trim() : '';
    if (productDedupeKey) {
      if (seenDedupeKeys.has(productDedupeKey)) continue;
      seenDedupeKeys.add(productDedupeKey);
    }
    const titleKey = normalizeIngredientRecallTitleForDedupe(product);
    if (!titleKey) {
      out.push(product);
      continue;
    }
    const count = Number(counts.get(titleKey) || 0);
    if (count >= perTitleLimit) continue;
    counts.set(titleKey, count + 1);
    out.push(product);
  }
  return out;
}

function stabilizeIngredientRecallProducts(
  products,
  { recallProfile = null, targetStepFamily = '', queryText = '', maxProducts = 0 } = {},
) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return [];
  const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
  const normalizedQuery = normalizeText(queryText);
  const queryRequestsTinted = /\btinted\b/.test(normalizedQuery);
  const queryRequestsRefill = /\brefill\b/.test(normalizedQuery);

  let rows = list
    .map((product, index) => {
      const text = buildIngredientRecallProductText(product);
      const exactHits = countPhraseMatches(text, recallProfile?.exact_phrases);
      const aliasHits = countPhraseMatches(text, recallProfile?.alias_phrases);
      const explicitHits = exactHits + aliasHits;
      const candidateStep = resolveIngredientRecallCandidateStep(product);
      const familyRelation = normalizedTargetStepFamily
        ? getRecoTargetFamilyRelation(normalizedTargetStepFamily, candidateStep)
        : null;
      if (normalizedTargetStepFamily && candidateStep && familyRelation === 'incompatible_family') {
        return null;
      }

      const titleText = normalizeIngredientRecallTitleForDedupe(product);
      const tinted = /\btinted\b/.test(titleText);
      const refill = /\brefill\b/.test(titleText);
      const obviousNoise = INGREDIENT_RECALL_OBVIOUS_NOISE_RE.test(titleText);
      let score = 0;
      if (familyRelation === 'same_family') score += 80;
      else if (familyRelation === 'adjacent_family') score -= 20;
      else if (normalizedTargetStepFamily && !candidateStep) score -= 8;
      score += exactHits * 40;
      score += aliasHits * 24;
      if (normalizedTargetStepFamily === 'sunscreen' && tinted && !queryRequestsTinted) score -= 18;
      if (normalizedTargetStepFamily === 'sunscreen' && refill && !queryRequestsRefill) score -= 12;
      if (obviousNoise) score -= 60;

      return {
        product,
        index,
        score,
        exactHits,
        aliasHits,
        explicitHits,
        familyRelation,
        tinted,
        refill,
        obviousNoise,
      };
    })
    .filter(Boolean);

  if (!rows.length) return [];

  const sameFamilyRows = rows.filter((row) => row.familyRelation === 'same_family');
  if (sameFamilyRows.length) rows = sameFamilyRows;

  const explicitRows = rows.filter((row) => row.explicitHits > 0);
  if (explicitRows.length) rows = explicitRows;

  const nonNoiseRows = rows.filter((row) => row.obviousNoise !== true);
  if (nonNoiseRows.length) rows = nonNoiseRows;

  if (normalizedTargetStepFamily === 'sunscreen' && !queryRequestsTinted) {
    const nonTintedRows = rows.filter((row) => row.tinted !== true);
    if (nonTintedRows.length) rows = nonTintedRows;
  }
  if (normalizedTargetStepFamily === 'sunscreen' && !queryRequestsRefill) {
    const nonRefillRows = rows.filter((row) => row.refill !== true);
    if (nonRefillRows.length) rows = nonRefillRows;
  }

  rows.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.exactHits !== left.exactHits) return right.exactHits - left.exactHits;
    if (right.aliasHits !== left.aliasHits) return right.aliasHits - left.aliasHits;
    return left.index - right.index;
  });

  const collapsed = collapseIngredientRecallProducts(
    rows.map((row) => row.product),
    {
      perTitleLimit: 1,
      dedupeKey: (product) =>
        buildIngredientRecallDisplayDedupeKey(product, {
          targetStepFamily: normalizedTargetStepFamily,
        }),
    },
  );

  const cappedMaxProducts = Number.isFinite(Number(maxProducts)) && Number(maxProducts) > 0
    ? Math.max(1, Math.floor(Number(maxProducts)))
    : 0;
  return cappedMaxProducts > 0 ? collapsed.slice(0, cappedMaxProducts) : collapsed;
}

function buildKbEvidence(profile, row) {
  const text = [
    row?.raw_ingredient_text_clean,
    row?.inci_list,
    row?.product_name,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) {
    return {
      exact_hits: 0,
      alias_hits: 0,
      family_hits: 0,
      strong_family_hits: 0,
      explicit_hits: 0,
    };
  }
  const exactHits = countPhraseMatches(text, profile?.exact_phrases);
  const aliasHits = countPhraseMatches(text, profile?.alias_phrases);
  const familyHits = countPhraseMatches(text, profile?.family_phrases);
  const strongFamilyHits = countStrongFamilyMatches(text, profile?.family_phrases);
  return {
    exact_hits: exactHits,
    alias_hits: aliasHits,
    family_hits: familyHits,
    strong_family_hits: strongFamilyHits,
    explicit_hits: exactHits + aliasHits,
  };
}

function mergeKbEvidence(target, evidence) {
  if (!evidence || typeof evidence !== 'object') return target;
  const next = target && typeof target === 'object'
    ? { ...target }
    : {
        exact_hits: 0,
        alias_hits: 0,
        family_hits: 0,
        strong_family_hits: 0,
        explicit_hits: 0,
      };
  next.exact_hits = Math.max(0, Number(next.exact_hits || 0), Number(evidence.exact_hits || 0));
  next.alias_hits = Math.max(0, Number(next.alias_hits || 0), Number(evidence.alias_hits || 0));
  next.family_hits = Math.max(0, Number(next.family_hits || 0), Number(evidence.family_hits || 0));
  next.strong_family_hits = Math.max(
    0,
    Number(next.strong_family_hits || 0),
    Number(evidence.strong_family_hits || 0),
  );
  next.explicit_hits = Math.max(0, Number(next.exact_hits || 0) + Number(next.alias_hits || 0));
  return next;
}

function buildKbEvidenceLookup(profile, kbRows) {
  const bySeedId = new Map();
  const byUrl = new Map();
  for (const row of Array.isArray(kbRows) ? kbRows : []) {
    const evidence = buildKbEvidence(profile, row);
    if ((Number(evidence.explicit_hits || 0) <= 0) && (Number(evidence.strong_family_hits || 0) <= 0)) continue;
    const seedId = extractSeedIdFromSkuKey(row?.sku_key);
    if (seedId) {
      bySeedId.set(seedId, mergeKbEvidence(bySeedId.get(seedId), evidence));
    }
    const sourceUrl = normalizeUrl(row?.source_ref);
    if (sourceUrl) {
      byUrl.set(sourceUrl, mergeKbEvidence(byUrl.get(sourceUrl), evidence));
    }
  }
  return { bySeedId, byUrl };
}

function resolveKbEvidenceForSeedRow(row, kbEvidenceLookup) {
  const lookup = kbEvidenceLookup && typeof kbEvidenceLookup === 'object' ? kbEvidenceLookup : null;
  if (!lookup) return null;
  let evidence = null;
  const seedId = String(row?.id || '').trim();
  if (seedId && lookup.bySeedId instanceof Map && lookup.bySeedId.has(seedId)) {
    evidence = mergeKbEvidence(evidence, lookup.bySeedId.get(seedId));
  }
  const urls = uniqStrings([
    normalizeUrl(row?.canonical_url),
    normalizeUrl(row?.destination_url),
    normalizeUrl(row?.seed_data?.canonical_url),
    normalizeUrl(row?.seed_data?.destination_url),
    normalizeUrl(row?.seed_data?.snapshot?.canonical_url),
    normalizeUrl(row?.seed_data?.snapshot?.destination_url),
  ]);
  for (const url of urls) {
    if (lookup.byUrl instanceof Map && lookup.byUrl.has(url)) {
      evidence = mergeKbEvidence(evidence, lookup.byUrl.get(url));
    }
  }
  return evidence;
}

function extractSeedIdFromSkuKey(skuKey) {
  const normalized = String(skuKey || '').trim();
  return normalized.match(/^extseed:([^:]+):/)?.[1] || '';
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

function buildRecallCandidateText(product) {
  const row = product && typeof product === 'object' ? product : {};
  const seedData = row.seed_data && typeof row.seed_data === 'object' ? row.seed_data : {};
  const snapshot = seedData.snapshot && typeof seedData.snapshot === 'object' ? seedData.snapshot : {};
  return [
    row.title,
    row.name,
    row.display_name,
    row.brand,
    row.category,
    row.product_type,
    row.description,
    snapshot.title,
    snapshot.description,
    snapshot.category,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function hasConflictingIngredientSurfaceSignal(text, profile) {
  const normalizedText = String(text || '').trim().toLowerCase();
  if (!normalizedText) return false;
  const currentExplicitHits =
    countPhraseMatches(normalizedText, profile?.exact_phrases) +
    countPhraseMatches(normalizedText, profile?.alias_phrases);
  if (currentExplicitHits > 0) return false;
  for (const otherProfile of Object.values(INGREDIENT_RECALL_PROFILES)) {
    if (!otherProfile || otherProfile.ingredient_id === profile?.ingredient_id) continue;
    const otherHits =
      countPhraseMatches(normalizedText, otherProfile.exact_phrases) +
      countPhraseMatches(normalizedText, otherProfile.alias_phrases);
    if (otherHits > 0) return true;
  }
  return false;
}

function resolveRecallCandidateStep(product) {
  const row = product && typeof product === 'object' ? product : {};
  const direct =
    normalizeRecoTargetStep(row.category) ||
    normalizeRecoTargetStep(row.product_type) ||
    normalizeRecoTargetStep(row.title) ||
    normalizeRecoTargetStep(row.name);
  if (direct) return direct;
  const resolved = resolveRecoTargetStepIntent({
    text: [row.title, row.name, row.category, row.product_type, row.description]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' '),
  });
  return normalizeRecoTargetStep(resolved?.resolved_target_step || '');
}

function isBundleLikeRecallProduct(product) {
  const title = normalizeText(product?.title || product?.name || product?.display_name || '');
  return Boolean(title) && BUNDLE_LIKE_RE.test(title);
}

function scoreRecallProduct(
  product,
  { profile, targetStepFamily = '', sourceRank = 0, allowFamilyOnly = false, kbEvidence = null } = {},
) {
  const text = buildRecallCandidateText(product);
  const kbExactHits = Math.max(0, Number(kbEvidence?.exact_hits || 0) || 0);
  const kbAliasHits = Math.max(0, Number(kbEvidence?.alias_hits || 0) || 0);
  const kbFamilyHits = Math.max(0, Number(kbEvidence?.family_hits || 0) || 0);
  const kbStrongFamilyHits = Math.max(0, Number(kbEvidence?.strong_family_hits || 0) || 0);
  const surfaceExactHits = countPhraseMatches(text, profile?.exact_phrases);
  const surfaceAliasHits = countPhraseMatches(text, profile?.alias_phrases);
  const surfaceExplicitHits = surfaceExactHits + surfaceAliasHits;
  const kbExplicitHits = kbExactHits + kbAliasHits;
  if (
    surfaceExplicitHits <= 0 &&
    kbExplicitHits > 0 &&
    hasConflictingIngredientSurfaceSignal(text, profile)
  ) {
    return null;
  }
  const exactHits = surfaceExactHits + kbExactHits;
  const aliasHits = surfaceAliasHits + kbAliasHits;
  const familyHits = countPhraseMatches(text, profile?.family_phrases) + kbFamilyHits;
  const strongFamilyHits = countStrongFamilyMatches(text, profile?.family_phrases) + kbStrongFamilyHits;
  const explicitHits = exactHits + aliasHits;
  if (explicitHits <= 0 && (!allowFamilyOnly || strongFamilyHits <= 0)) return null;

  const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
  const candidateStep = resolveRecallCandidateStep(product);
  const familyRelation = normalizedTargetStepFamily
    ? getRecoTargetFamilyRelation(normalizedTargetStepFamily, candidateStep)
    : null;
  if (normalizedTargetStepFamily) {
    if (!candidateStep) {
      if (surfaceExplicitHits <= 0) return null;
    }
    if (familyRelation === 'incompatible_family') return null;
    if (surfaceExplicitHits <= 0 && (kbExactHits + kbAliasHits) > 0 && familyRelation !== 'same_family') {
      return null;
    }
  }

  const family = normalizeText(normalizedTargetStepFamily || targetStepFamily);
  const category = normalizeText(product?.category || product?.product_type || '');
  const title = normalizeText(product?.title || product?.name || '');
  let score = Number(sourceRank || 0);
  score += surfaceExplicitHits * 120;
  score += kbExplicitHits * 12;
  score += exactHits * 30;
  score += aliasHits * 18;
  score += strongFamilyHits * (explicitHits > 0 ? 6 : 12);
  score += familyHits * (explicitHits > 0 ? 3 : 2);
  if (family && (category.includes(family) || title.includes(family))) score += 8;
  if (familyRelation === 'same_family') score += 12;
  if (familyRelation === 'adjacent_family') score += 4;
  if (normalizeUrl(product?.url) || normalizeUrl(product?.canonical_url) || normalizeUrl(product?.destination_url)) {
    score += 3;
  }
  if (BUNDLE_LIKE_RE.test(title)) score -= 24;
  return {
    score,
    exact_hits: exactHits,
    alias_hits: aliasHits,
    family_hits: familyHits,
    strong_family_hits: strongFamilyHits,
    explicit_hits: explicitHits,
    surface_explicit_hits: surfaceExplicitHits,
    kb_explicit_hits: kbExplicitHits,
    family_only: explicitHits <= 0,
    candidate_step: candidateStep || null,
    family_relation: familyRelation || null,
  };
}

function filterBundleLikeRecallCandidates(rows) {
  const ranked = Array.isArray(rows) ? rows : [];
  if (!ranked.length) return [];
  const nonBundleRows = ranked.filter((row) => !isBundleLikeRecallProduct(row?.product));
  if (nonBundleRows.length) return nonBundleRows;
  return ranked.length > 1 ? [ranked[0]] : ranked;
}

async function runKbQuery(text, params) {
  try {
    const result = await kbQuery(text, params);
    if (result) return result;
    return await query(text, params);
  } catch (_err) {
    return null;
  }
}

async function runAppQuery(text, params) {
  try {
    return await query(text, params);
  } catch (_err) {
    return null;
  }
}

let kbAvailabilityCache = {
  checked_at: 0,
  available: false,
};

async function isKbTableAvailable() {
  const now = Date.now();
  if (now - Number(kbAvailabilityCache.checked_at || 0) < 60_000) {
    return kbAvailabilityCache.available === true;
  }
  const result = await runKbQuery(`SELECT to_regclass('pci_kb.sku_ingredients') AS table_name`);
  const available = Boolean(result?.rows?.[0]?.table_name);
  kbAvailabilityCache = {
    checked_at: now,
    available,
  };
  return available;
}

async function fetchKbRowsForProfile({ profile, limit = 24 } = {}) {
  if (!profile) return [];
  if (!(await isKbTableAvailable())) return [];
  const patterns = buildPhrasePatterns([
    ...(Array.isArray(profile.exact_phrases) ? profile.exact_phrases : []),
    ...(Array.isArray(profile.alias_phrases) ? profile.alias_phrases : []),
  ]);
  if (!patterns.length) return [];
  const res = await runKbQuery(
    `
      SELECT
        sku_key,
        brand,
        product_name,
        source_ref,
        raw_ingredient_text_clean,
        inci_list,
        created_at
      FROM pci_kb.sku_ingredients
      WHERE
        lower(coalesce(raw_ingredient_text_clean, '')) LIKE ANY($1::text[])
        OR lower(coalesce(inci_list, '')) LIKE ANY($1::text[])
        OR lower(coalesce(product_name, '')) LIKE ANY($1::text[])
      ORDER BY created_at DESC NULLS LAST, sku_key ASC
      LIMIT $2
    `,
    [patterns, Math.max(8, Number(limit) || 24)],
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

function buildSeedIdentityWhere(seedIds, urls, sqlParams) {
  const clauses = [];
  if (Array.isArray(seedIds) && seedIds.length) {
    sqlParams.push(seedIds);
    const bind = `$${sqlParams.length}`;
    clauses.push(`id = ANY(${bind}::text[])`);
  }
  if (Array.isArray(urls) && urls.length) {
    sqlParams.push(urls);
    const bind = `$${sqlParams.length}`;
    clauses.push(
      `(
        canonical_url = ANY(${bind}::text[])
        OR destination_url = ANY(${bind}::text[])
        OR seed_data->>'canonical_url' = ANY(${bind}::text[])
        OR seed_data->>'destination_url' = ANY(${bind}::text[])
        OR seed_data->'snapshot'->>'canonical_url' = ANY(${bind}::text[])
        OR seed_data->'snapshot'->>'destination_url' = ANY(${bind}::text[])
      )`,
    );
  }
  return clauses;
}

async function fetchSeedRowsByIdentity({
  seedIds = [],
  urls = [],
  market = DEFAULT_MARKET,
  tool = DEFAULT_TOOL,
  attachedState = null,
  limit = 24,
} = {}) {
  const ids = uniqStrings(seedIds, 80);
  const normalizedUrls = uniqStrings((Array.isArray(urls) ? urls : []).map(normalizeUrl).filter(Boolean), 80);
  if (!ids.length && !normalizedUrls.length) return [];

  const sqlParams = [String(market || DEFAULT_MARKET).trim().toUpperCase() || DEFAULT_MARKET, String(tool || DEFAULT_TOOL).trim() || DEFAULT_TOOL];
  const filters = buildSeedIdentityWhere(ids, normalizedUrls, sqlParams);
  if (!filters.length) return [];
  if (attachedState === 'attached') filters.push(`coalesce(attached_product_key, '') <> ''`);
  if (attachedState === 'unattached') filters.push(`coalesce(attached_product_key, '') = ''`);
  sqlParams.push(Math.max(6, Number(limit) || 24));
  const limitBind = `$${sqlParams.length}`;
  const res = await runAppQuery(
    `
      SELECT
        id,
        external_product_id,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        attached_product_key,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND market = $1
        AND (tool = '*' OR tool = $2)
        AND (${filters.join('\n        OR ')})
      ORDER BY
        CASE WHEN coalesce(attached_product_key, '') <> '' THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST
      LIMIT ${limitBind}
    `,
    sqlParams,
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function fetchSeedRowsByPatterns({
  patterns = [],
  market = DEFAULT_MARKET,
  tool = DEFAULT_TOOL,
  attachedState = null,
  limit = 24,
  inStockOnly = false,
} = {}) {
  const normalizedPatterns = uniqStrings(patterns, 16);
  if (!normalizedPatterns.length) return [];
  const sqlParams = [
    String(market || DEFAULT_MARKET).trim().toUpperCase() || DEFAULT_MARKET,
    String(tool || DEFAULT_TOOL).trim() || DEFAULT_TOOL,
    normalizedPatterns,
  ];
  const filters = [
    `(
      lower(coalesce(title, '')) LIKE ANY($3::text[])
      OR lower(coalesce(domain, '')) LIKE ANY($3::text[])
      OR lower(coalesce(canonical_url, '')) LIKE ANY($3::text[])
      OR lower(coalesce(destination_url, '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'title', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'category', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'canonical_url', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'destination_url', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'title', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'description', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'category', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'canonical_url', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'destination_url', '')) LIKE ANY($3::text[])
    )`,
  ];
  if (attachedState === 'attached') filters.push(`coalesce(attached_product_key, '') <> ''`);
  if (attachedState === 'unattached') filters.push(`coalesce(attached_product_key, '') = ''`);
  if (inStockOnly) {
    filters.push(`coalesce(lower(availability), '') NOT IN ('out of stock', 'out_of_stock', 'outofstock', 'oos')`);
  }
  sqlParams.push(Math.max(6, Number(limit) || 24));
  const limitBind = `$${sqlParams.length}`;
  const res = await runAppQuery(
    `
      SELECT
        id,
        external_product_id,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        attached_product_key,
        updated_at,
        created_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND market = $1
        AND (tool = '*' OR tool = $2)
        AND ${filters.join('\n        AND ')}
      ORDER BY
        CASE
          WHEN lower(coalesce(title, '')) LIKE ANY($3::text[]) THEN 0
          WHEN lower(coalesce(seed_data->>'title', '')) LIKE ANY($3::text[]) THEN 1
          WHEN lower(coalesce(seed_data->'snapshot'->>'title', '')) LIKE ANY($3::text[]) THEN 2
          WHEN (
            lower(coalesce(canonical_url, '')) LIKE ANY($3::text[])
            OR lower(coalesce(destination_url, '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->>'canonical_url', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->>'destination_url', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'canonical_url', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'destination_url', '')) LIKE ANY($3::text[])
          ) THEN 3
          WHEN (
            lower(coalesce(seed_data->>'category', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'category', '')) LIKE ANY($3::text[])
          ) THEN 4
          WHEN lower(coalesce(seed_data->'snapshot'->>'description', '')) LIKE ANY($3::text[]) THEN 5
          ELSE 6
        END,
        CASE WHEN coalesce(attached_product_key, '') <> '' THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        created_at DESC NULLS LAST
      LIMIT ${limitBind}
    `,
    sqlParams,
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

function mapSeedRowToRecallProduct(row, sourceTag) {
  const product = buildExternalSeedProduct(row);
  if (!product) return null;
  return {
    ...product,
    source: 'external_seed',
    retrieval_source: String(sourceTag || '').trim() || 'external_seed',
    retrieval_reason: String(sourceTag || '').trim() || 'external_seed',
    ...(String(row?.attached_product_key || '').trim() ? { attached_product_key: String(row.attached_product_key).trim() } : {}),
  };
}

function buildCandidateKey(product) {
  const url = normalizeUrl(product?.canonical_url || product?.destination_url || product?.url || '');
  return [
    String(product?.merchant_id || '').trim().toLowerCase(),
    String(product?.product_id || product?.id || '').trim().toLowerCase(),
    url.toLowerCase(),
  ].join('::');
}

function mergeRecallSourceBreakdown(target, sourceTag, amount = 1) {
  const key = String(sourceTag || '').trim() || 'unknown';
  target[key] = Number(target[key] || 0) + Math.max(0, Math.trunc(Number(amount) || 0));
}

async function recallIngredientProducts({
  target = null,
  query = '',
  ingredientId = '',
  targetStepFamily = '',
  market = DEFAULT_MARKET,
  tool = DEFAULT_TOOL,
  limit = 6,
  inStockOnly = false,
  allowFamilyFallback = false,
} = {}) {
  const profile = resolveIngredientRecallProfile({ target, query, ingredientId });
  const diagnostics = {
    ingredient_intent_detected: Boolean(profile),
    ingredient_id: profile?.ingredient_id || null,
    kb_recall_attempted: false,
    kb_recall_recovered: 0,
    attached_seed_recall_attempted: false,
    attached_seed_recall_recovered: 0,
    unattached_seed_recall_attempted: false,
    unattached_seed_recall_recovered: 0,
    family_fallback_attempted: false,
    family_fallback_recovered: 0,
    family_fallback_used: false,
    recall_source_breakdown: {},
  };
  if (!profile) {
    return {
      products: [],
      diagnostics,
    };
  }
  if (!process.env.DATABASE_URL) {
    return {
      products: [],
      diagnostics,
    };
  }

  const seen = new Set();
  const candidates = [];
  const kbRows = await fetchKbRowsForProfile({
    profile,
    limit: Math.max(8, Number(limit) * 6 || 24),
  });
  const kbEvidenceLookup = buildKbEvidenceLookup(profile, kbRows);
  const resolveSourceRank = (sourceTag) => {
    if (sourceTag === 'kb_attached_seed') return 400;
    if (sourceTag === 'attached_seed') return 300;
    if (sourceTag === 'kb_unattached_seed') return 220;
    if (sourceTag === 'unattached_seed') return 180;
    if (sourceTag === 'family_attached_seed') return 140;
    if (sourceTag === 'family_unattached_seed') return 90;
    return 60;
  };
  const addRows = (rows, sourceTag, { allowFamilyOnly = false, useKbEvidence = false } = {}) => {
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const product = mapSeedRowToRecallProduct(row, sourceTag);
      if (!product) continue;
      const key = buildCandidateKey(product);
      if (!key || seen.has(key)) continue;
      const kbEvidence = useKbEvidence ? resolveKbEvidenceForSeedRow(row, kbEvidenceLookup) : null;
      const evidence = scoreRecallProduct(product, {
        profile,
        targetStepFamily,
        sourceRank: resolveSourceRank(sourceTag),
        allowFamilyOnly,
        kbEvidence,
      });
      if (!evidence) continue;
      seen.add(key);
      candidates.push({
        product,
        evidence,
        source_tag: sourceTag,
      });
    }
  };

  diagnostics.kb_recall_attempted = true;
  const kbSeedIds = uniqStrings(kbRows.map((row) => extractSeedIdFromSkuKey(row?.sku_key)).filter(Boolean), 80);
  const kbUrls = uniqStrings(kbRows.map((row) => normalizeUrl(row?.source_ref)).filter(Boolean), 80);
  const kbAttachedRows = await fetchSeedRowsByIdentity({
    seedIds: kbSeedIds,
    urls: kbUrls,
    market,
    tool,
    attachedState: 'attached',
    limit: Math.max(8, Number(limit) * 4 || 24),
  });
  diagnostics.kb_recall_recovered = kbAttachedRows.length > 0 ? 1 : 0;
  addRows(kbAttachedRows, 'kb_attached_seed', { useKbEvidence: true });

  diagnostics.attached_seed_recall_attempted = true;
  const explicitPatterns = buildPhrasePatterns([
    ...(Array.isArray(profile.exact_phrases) ? profile.exact_phrases : []),
    ...(Array.isArray(profile.alias_phrases) ? profile.alias_phrases : []),
  ]);
  const attachedSeedRows = await fetchSeedRowsByPatterns({
    patterns: explicitPatterns,
    market,
    tool,
    attachedState: 'attached',
    limit: Math.max(8, Number(limit) * 5 || 30),
    inStockOnly,
  });
  diagnostics.attached_seed_recall_recovered = attachedSeedRows.length > 0 ? 1 : 0;
  addRows(attachedSeedRows, 'attached_seed');

  diagnostics.unattached_seed_recall_attempted = true;
  const kbUnattachedRows = await fetchSeedRowsByIdentity({
    seedIds: kbSeedIds,
    urls: kbUrls,
    market,
    tool,
    attachedState: 'unattached',
    limit: Math.max(6, Number(limit) * 3 || 18),
  });
  const unattachedSeedRows = await fetchSeedRowsByPatterns({
    patterns: explicitPatterns,
    market,
    tool,
    attachedState: 'unattached',
    limit: Math.max(8, Number(limit) * 6 || 36),
    inStockOnly,
  });
  const uniqueUnattachedRows = [
    ...kbUnattachedRows,
    ...unattachedSeedRows,
  ];
  diagnostics.unattached_seed_recovered = uniqueUnattachedRows.length > 0 ? 1 : 0;
  addRows(kbUnattachedRows, 'kb_unattached_seed', { useKbEvidence: true });
  addRows(unattachedSeedRows, 'unattached_seed');

  if (!candidates.length && allowFamilyFallback) {
    diagnostics.family_fallback_attempted = true;
    const familyPatterns = buildPhrasePatterns(profile.family_phrases);
    if (familyPatterns.length) {
      const familyAttachedRows = await fetchSeedRowsByPatterns({
        patterns: familyPatterns,
        market,
        tool,
        attachedState: 'attached',
        limit: Math.max(6, Number(limit) * 4 || 24),
        inStockOnly,
      });
      const familyUnattachedRows = await fetchSeedRowsByPatterns({
        patterns: familyPatterns,
        market,
        tool,
        attachedState: 'unattached',
        limit: Math.max(6, Number(limit) * 4 || 24),
        inStockOnly,
      });
      addRows(familyAttachedRows, 'family_attached_seed', { allowFamilyOnly: true });
      addRows(familyUnattachedRows, 'family_unattached_seed', { allowFamilyOnly: true });
      diagnostics.family_fallback_recovered = candidates.length > 0 ? 1 : 0;
    }
  }

  const ranked = filterBundleLikeRecallCandidates(
    candidates
    .slice()
    .sort((left, right) => {
      if (right.evidence.surface_explicit_hits !== left.evidence.surface_explicit_hits) {
        return right.evidence.surface_explicit_hits - left.evidence.surface_explicit_hits;
      }
      if (right.evidence.score !== left.evidence.score) return right.evidence.score - left.evidence.score;
      if (right.evidence.explicit_hits !== left.evidence.explicit_hits) {
        return right.evidence.explicit_hits - left.evidence.explicit_hits;
      }
      if (right.evidence.strong_family_hits !== left.evidence.strong_family_hits) {
        return right.evidence.strong_family_hits - left.evidence.strong_family_hits;
      }
      const leftTitle = normalizeText(left.product?.title || left.product?.name || '');
      const rightTitle = normalizeText(right.product?.title || right.product?.name || '');
      return leftTitle.localeCompare(rightTitle);
    })
    .slice(0, Math.max(1, Number(limit) || 6)),
  );

  diagnostics.family_fallback_used = ranked.some((row) =>
    String(row?.source_tag || '').startsWith('family_'),
  );

  for (const row of ranked) {
    mergeRecallSourceBreakdown(diagnostics.recall_source_breakdown, row.source_tag, 1);
  }

  return {
    products: ranked.map((row) => row.product),
    diagnostics,
  };
}

module.exports = {
  INGREDIENT_RECALL_PROFILES,
  resolveIngredientRecallProfile,
  recallIngredientProducts,
  stabilizeIngredientRecallProducts,
};
