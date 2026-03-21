const { query } = require('../db');
const { kbQuery } = require('./pciKbClient');
const { buildExternalSeedProduct } = require('./externalSeedProducts');
const {
  LOCAL_INGREDIENT_RECALL_REGISTRY,
  normalizeIngredientRecallText,
} = require('./ingredientRecallRegistry');
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
const INGREDIENT_RECALL_OBVIOUS_NOISE_RE =
  /\b(concealer|foundation|brush|powder|spa|coupon|mascara|lash|eyeliner|brow)\b/i;
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
const EVIDENCE_MODE = 'canonical_ingredient_id_evidence_v1';
const OFF_SURFACE_PATTERNS = [
  ['hand', /\bhands?\b/i],
  ['body', /\bbody\b/i],
  ['lip', /\blips?\b/i],
  ['foot', /\b(feet|foot|heel)\b/i],
  ['hair', /\b(hair|scalp)\b/i],
];
const TARGET_STEP_NEGATIVE_PATTERNS = Object.freeze({
  moisturizer: /\b(bundle|duo|set|kit|skin tint|tinted|foundation|primer|peel|exfoliant|spf|sunscreen|cleanser|mask|toner)\b/i,
  serum: /\b(bundle|duo|set|kit|skin tint|tinted|foundation|primer|peel|exfoliant|spf|sunscreen|cleanser|mask|moisturizer|moisturiser|cream)\b/i,
  treatment: /\b(bundle|duo|set|kit|skin tint|tinted|foundation|primer|sunscreen|spf|cleanser|body lotion|body cream|body wash)\b/i,
  sunscreen: /\b(bundle|duo|set|kit|cleanser|toner|mask|primer|foundation|peel|exfoliant)\b/i,
});

let kbAvailabilityCache = {
  checked_at: 0,
  available: false,
};

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

function buildPhrasePatterns(phrases) {
  return uniqNormalizedStrings(phrases, 16).map((phrase) => `%${phrase}%`);
}

function countPhraseMatches(text, phrases) {
  const haystack = ` ${normalizeIngredientRecallText(text)} `;
  if (!haystack.trim()) return 0;
  let hits = 0;
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const normalized = normalizeIngredientRecallText(phrase);
    if (!normalized) continue;
    if (haystack.includes(` ${normalized} `)) hits += 1;
  }
  return hits;
}

function countStrongFamilyMatches(text, phrases) {
  const haystack = ` ${normalizeIngredientRecallText(text)} `;
  if (!haystack.trim()) return 0;
  let hits = 0;
  for (const phrase of Array.isArray(phrases) ? phrases : []) {
    const normalized = normalizeIngredientRecallText(phrase);
    if (!normalized || WEAK_FAMILY_ONLY_PHRASES.has(normalized)) continue;
    if (haystack.includes(` ${normalized} `)) hits += 1;
  }
  return hits;
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
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
  return title ? normalizeIngredientRecallText(title) : '';
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
  const dedupeKey = typeof options.dedupeKey === 'function' ? options.dedupeKey : null;
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
    row.ingredient_name,
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []),
    normalizeUrl(row.url),
    normalizeUrl(row.canonical_url),
    normalizeUrl(row.destination_url),
    snapshot.title,
    snapshot.category,
    normalizeUrl(snapshot.canonical_url),
    normalizeUrl(snapshot.destination_url),
  ]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function buildRecallCandidateFieldTexts(product) {
  const row = product && typeof product === 'object' ? product : {};
  const seedData = row.seed_data && typeof row.seed_data === 'object' ? row.seed_data : {};
  const snapshot = seedData.snapshot && typeof seedData.snapshot === 'object' ? seedData.snapshot : {};
  const titleValues = [
    row.title,
    row.name,
    row.display_name,
    row.product_name,
    snapshot.title,
  ];
  const ingredientValues = [
    row.ingredient_name,
    ...(Array.isArray(row.ingredient_tokens) ? row.ingredient_tokens : []),
  ];
  const urlValues = [
    normalizeUrl(row.url),
    normalizeUrl(row.canonical_url),
    normalizeUrl(row.destination_url),
    normalizeUrl(snapshot.canonical_url),
    normalizeUrl(snapshot.destination_url),
  ];
  const supportValues = [
    row.category,
    row.product_type,
    ...(Array.isArray(row.tag_tokens) ? row.tag_tokens : []),
    ...(Array.isArray(row.skin_type_tags) ? row.skin_type_tags : []),
    snapshot.category,
  ];
  const familyValues = [
    ...titleValues,
    ...ingredientValues,
    ...supportValues,
    row.description,
    snapshot.description,
  ];
  const join = (values) =>
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  return {
    title: join(titleValues),
    ingredient_tokens: join(ingredientValues),
    urls: join(urlValues),
    support: join(supportValues),
    family: join(familyValues),
  };
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

function extractSeedIdFromSkuKey(skuKey) {
  const normalized = String(skuKey || '').trim();
  return normalized.match(/^extseed:([^:]+):/)?.[1] || '';
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

function mapSeedRowToRecallProduct(row, sourceTag) {
  const product = buildExternalSeedProduct(row);
  if (!product) return null;
  return {
    ...product,
    source: 'external_seed',
    retrieval_source: String(sourceTag || '').trim() || 'external_seed',
    retrieval_reason: String(sourceTag || '').trim() || 'external_seed',
    ...(String(row?.attached_product_key || '').trim()
      ? { attached_product_key: String(row.attached_product_key).trim() }
      : {}),
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

function isBundleLikeRecallProduct(product) {
  const title = normalizeIngredientRecallText(product?.title || product?.name || product?.display_name || '');
  return Boolean(title) && BUNDLE_LIKE_RE.test(title);
}

function hasConflictingIngredientSurfaceSignal(text, profile) {
  const normalizedText = String(text || '').trim().toLowerCase();
  if (!normalizedText) return false;
  const currentExplicitHits =
    countPhraseMatches(normalizedText, profile?.exact_phrases) +
    countPhraseMatches(normalizedText, profile?.alias_phrases);
  if (currentExplicitHits > 0) return false;
  for (const otherProfile of Object.values(LOCAL_INGREDIENT_RECALL_REGISTRY)) {
    if (!otherProfile || otherProfile.ingredient_id === profile?.ingredient_id) continue;
    const otherHits =
      countPhraseMatches(normalizedText, otherProfile.exact_phrases) +
      countPhraseMatches(normalizedText, otherProfile.alias_phrases);
    if (otherHits > 0) return true;
  }
  return false;
}

function buildConflictingIngredientSurfaceText(fieldTexts = {}) {
  return [
    fieldTexts.title,
    fieldTexts.ingredient_tokens,
    fieldTexts.urls,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function collectRequestedSurfaces(text) {
  const normalized = normalizeIngredientRecallText(text);
  const out = new Set();
  if (!normalized) return out;
  for (const [surface, pattern] of OFF_SURFACE_PATTERNS) {
    if (pattern.test(normalized)) out.add(surface);
  }
  return out;
}

function hasDisallowedOffSurfaceSignal(fieldTexts = {}, queryText = '') {
  const requestedSurfaces = collectRequestedSurfaces(queryText);
  const candidateText = [
    fieldTexts.title,
    fieldTexts.support,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!candidateText) return false;
  for (const [surface, pattern] of OFF_SURFACE_PATTERNS) {
    if (requestedSurfaces.has(surface)) continue;
    if (pattern.test(candidateText)) return true;
  }
  return false;
}

function hasTargetStepNegativeSignal(fieldTexts = {}, targetStepFamily = '', queryText = '') {
  const family = normalizeRecoTargetStep(targetStepFamily);
  if (!family) return false;
  const pattern = TARGET_STEP_NEGATIVE_PATTERNS[family];
  if (!pattern) return false;
  const requestedSurfaces = collectRequestedSurfaces(queryText);
  const titleAndSupport = [
    fieldTexts.title,
    fieldTexts.support,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!titleAndSupport) return false;
  if (requestedSurfaces.has('body') && /\bbody\b/i.test(titleAndSupport)) return false;
  return pattern.test(titleAndSupport);
}

function mergeBreakdown(target, sourceTag, amount = 1) {
  const key = String(sourceTag || '').trim() || 'unknown';
  target[key] = Number(target[key] || 0) + Math.max(0, Math.trunc(Number(amount) || 0));
}

function buildCandidateEvidence(
  product,
  {
    profile,
    targetStepFamily = '',
    allowFamilyOnly = false,
    kbEvidence = null,
    queryText = '',
  } = {},
) {
  const fieldTexts = buildRecallCandidateFieldTexts(product);
  const candidateStep = resolveRecallCandidateStep(product);
  const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
  const familyRelation = normalizedTargetStepFamily
    ? getRecoTargetFamilyRelation(normalizedTargetStepFamily, candidateStep)
    : null;

  if (normalizedTargetStepFamily && familyRelation === 'incompatible_family') {
    return { reject_reason: 'step_family_mismatch' };
  }

  const kbExactHits = Math.max(0, Number(kbEvidence?.exact_hits || 0) || 0);
  const kbAliasHits = Math.max(0, Number(kbEvidence?.alias_hits || 0) || 0);
  const kbExplicitHits = kbExactHits + kbAliasHits;

  const titleExactHits = countPhraseMatches(fieldTexts.title, profile?.exact_phrases);
  const titleAliasHits = countPhraseMatches(fieldTexts.title, profile?.alias_phrases);
  const tokenExactHits = countPhraseMatches(fieldTexts.ingredient_tokens, profile?.exact_phrases);
  const tokenAliasHits = countPhraseMatches(fieldTexts.ingredient_tokens, profile?.alias_phrases);
  const urlExactHits = countPhraseMatches(fieldTexts.urls, profile?.exact_phrases);
  const urlAliasHits = countPhraseMatches(fieldTexts.urls, profile?.alias_phrases);
  const familyHits = countPhraseMatches(fieldTexts.family, profile?.family_phrases) + Math.max(0, Number(kbEvidence?.family_hits || 0) || 0);
  const strongFamilyHits =
    countStrongFamilyMatches(fieldTexts.family, profile?.family_phrases) +
    Math.max(0, Number(kbEvidence?.strong_family_hits || 0) || 0);
  const offSurfaceSignal = hasDisallowedOffSurfaceSignal(fieldTexts, queryText);
  const targetStepNegativeSignal = hasTargetStepNegativeSignal(fieldTexts, targetStepFamily, queryText);

  if (
    titleExactHits + titleAliasHits + tokenExactHits + tokenAliasHits + urlExactHits + urlAliasHits <= 0 &&
    kbExplicitHits > 0 &&
    hasConflictingIngredientSurfaceSignal(
      buildConflictingIngredientSurfaceText(fieldTexts),
      profile,
    )
  ) {
    return { reject_reason: 'all_candidates_filtered_noise' };
  }

  const evidence = {
    kb_explicit: kbExplicitHits > 0 ? 1 : 0,
    title_exact: titleExactHits,
    title_alias: titleAliasHits,
    ingredient_token_exact: tokenExactHits,
    ingredient_token_alias: tokenAliasHits,
    url_alias: urlExactHits + urlAliasHits,
    family_only: 0,
    explicit_hits:
      kbExplicitHits +
      titleExactHits +
      titleAliasHits +
      tokenExactHits +
      tokenAliasHits +
      urlExactHits +
      urlAliasHits,
    family_hits: familyHits,
    strong_family_hits: strongFamilyHits,
    candidate_step: candidateStep || null,
    family_relation: familyRelation || null,
  };
  evidence.family_only = evidence.explicit_hits <= 0 && strongFamilyHits > 0 ? 1 : 0;

  if (
    evidence.explicit_hits <= 0 &&
    hasConflictingIngredientSurfaceSignal(
      buildConflictingIngredientSurfaceText(fieldTexts),
      profile,
    )
  ) {
    return { reject_reason: 'all_candidates_filtered_noise', evidence };
  }
  if (offSurfaceSignal) {
    return { reject_reason: 'all_candidates_filtered_noise', evidence };
  }
  if (targetStepNegativeSignal && evidence.family_only === 1) {
    return { reject_reason: 'step_family_mismatch', evidence };
  }
  if (targetStepNegativeSignal && evidence.explicit_hits > 0 && normalizedTargetStepFamily) {
    return { reject_reason: 'step_family_mismatch', evidence };
  }

  if (evidence.explicit_hits <= 0 && !allowFamilyOnly) {
    return { reject_reason: 'no_explicit_sku_evidence', evidence };
  }
  if (
    evidence.family_only === 1 &&
    normalizedTargetStepFamily &&
    familyRelation !== 'same_family'
  ) {
    return { reject_reason: 'step_family_mismatch', evidence };
  }
  if (normalizedTargetStepFamily && !candidateStep && evidence.explicit_hits <= 0) {
    return { reject_reason: 'step_family_mismatch', evidence };
  }
  return { evidence };
}

function scoreCandidateEvidence(candidate, sourceRank = 0) {
  const title = normalizeIngredientRecallText(
    candidate?.product?.title || candidate?.product?.name || candidate?.product?.display_name || '',
  );
  const tinted = /\btinted\b/.test(title);
  const refill = /\brefill\b/.test(title);
  const obviousNoise = INGREDIENT_RECALL_OBVIOUS_NOISE_RE.test(title);
  const bundleLike = isBundleLikeRecallProduct(candidate?.product);
  let score = Number(sourceRank || 0);
  score += Number(candidate?.evidence?.kb_explicit || 0) * 220;
  score += Number(candidate?.evidence?.title_exact || 0) * 180;
  score += Number(candidate?.evidence?.title_alias || 0) * 140;
  score += Number(candidate?.evidence?.ingredient_token_exact || 0) * 130;
  score += Number(candidate?.evidence?.ingredient_token_alias || 0) * 100;
  score += Number(candidate?.evidence?.url_alias || 0) * 60;
  score += Number(candidate?.evidence?.strong_family_hits || 0) * (candidate?.evidence?.explicit_hits > 0 ? 10 : 16);
  score += Number(candidate?.evidence?.family_hits || 0) * (candidate?.evidence?.explicit_hits > 0 ? 4 : 2);
  if (candidate?.evidence?.family_relation === 'same_family') score += 40;
  if (candidate?.evidence?.family_relation === 'adjacent_family') score -= 10;
  if (obviousNoise) score -= 80;
  if (bundleLike) score -= 24;
  if (candidate?.product?.url || candidate?.product?.canonical_url || candidate?.product?.destination_url) score += 4;
  return {
    tinted,
    refill,
    obviousNoise,
    bundleLike,
    score,
  };
}

function stabilizeIngredientRecallProducts(products, { recallProfile = null, targetStepFamily = '', queryText = '', maxProducts = 0 } = {}) {
  const list = Array.isArray(products) ? products : [];
  if (!list.length) return [];
  const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
  const normalizedQuery = normalizeIngredientRecallText(queryText);
  const queryRequestsTinted = /\btinted\b/.test(normalizedQuery);
  const queryRequestsRefill = /\brefill\b/.test(normalizedQuery);

  let rows = list
    .map((product, index) => {
      const text = buildIngredientRecallProductText(product);
      const fieldTexts = buildRecallCandidateFieldTexts(product);
      const exactHits = countPhraseMatches(text, recallProfile?.exact_phrases);
      const aliasHits = countPhraseMatches(text, recallProfile?.alias_phrases);
      const explicitHits = exactHits + aliasHits;
      const candidateStep = resolveRecallCandidateStep(product);
      const familyRelation = normalizedTargetStepFamily
        ? getRecoTargetFamilyRelation(normalizedTargetStepFamily, candidateStep)
        : null;
      if (normalizedTargetStepFamily && candidateStep && familyRelation === 'incompatible_family') {
        return null;
      }
      if (hasDisallowedOffSurfaceSignal(fieldTexts, queryText)) {
        return null;
      }
      if (hasTargetStepNegativeSignal(fieldTexts, normalizedTargetStepFamily, queryText)) {
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

async function fetchSeedRowsByIdentity({ seedIds = [], urls = [], market = DEFAULT_MARKET, tool = DEFAULT_TOOL, attachedState = null, limit = 24 } = {}) {
  const ids = uniqStrings(seedIds, 80);
  const normalizedUrls = uniqStrings((Array.isArray(urls) ? urls : []).map(normalizeUrl).filter(Boolean), 80);
  if (!ids.length && !normalizedUrls.length) return [];
  const sqlParams = [
    String(market || DEFAULT_MARKET).trim().toUpperCase() || DEFAULT_MARKET,
    String(tool || DEFAULT_TOOL).trim() || DEFAULT_TOOL,
  ];
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

async function fetchSeedRowsByPatterns({ patterns = [], market = DEFAULT_MARKET, tool = DEFAULT_TOOL, attachedState = null, limit = 24, inStockOnly = false } = {}) {
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
      OR lower(coalesce(canonical_url, '')) LIKE ANY($3::text[])
      OR lower(coalesce(destination_url, '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'title', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'canonical_url', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'destination_url', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'title', '')) LIKE ANY($3::text[])
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
          ) THEN 3
          ELSE 4
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

function resolveSourceRank(sourceTag) {
  if (sourceTag === 'kb_attached_seed') return 480;
  if (sourceTag === 'attached_seed') return 360;
  if (sourceTag === 'kb_unattached_seed') return 260;
  if (sourceTag === 'unattached_seed') return 210;
  if (sourceTag === 'family_attached_seed') return 140;
  if (sourceTag === 'family_unattached_seed') return 100;
  return 60;
}

function buildDirectMissReason({ registryDiagnostics, explicitAttempted, allCandidates, scoredCandidates, stepMismatchCount, noiseFilteredCount, finalProducts }) {
  if (registryDiagnostics?.registry_unavailable === true) return 'registry_unavailable';
  if (registryDiagnostics?.registry_match !== true) return 'no_registry_match';
  if (!explicitAttempted) return 'no_explicit_sku_evidence';
  if (Array.isArray(finalProducts) && finalProducts.length > 0) return null;
  if (stepMismatchCount > 0 && (!Array.isArray(scoredCandidates) || scoredCandidates.length === 0)) {
    return 'step_family_mismatch';
  }
  if (Array.isArray(allCandidates) && allCandidates.length > 0 && noiseFilteredCount >= allCandidates.length) {
    return 'all_candidates_filtered_noise';
  }
  return 'no_explicit_sku_evidence';
}

async function recallIngredientProductsFromProfile({
  profile = null,
  registryDiagnostics = {},
  query = '',
  targetStepFamily = '',
  market = DEFAULT_MARKET,
  tool = DEFAULT_TOOL,
  limit = 6,
  inStockOnly = false,
  allowFamilyFallback = false,
} = {}) {
  const diagnostics = {
    ingredient_intent_detected: Boolean(profile),
    ingredient_id: profile?.ingredient_id || null,
    ingredient_registry_match: registryDiagnostics.registry_match === true,
    ingredient_registry_source: registryDiagnostics.registry_source || 'none',
    ingredient_profile_source: registryDiagnostics.profile_source || 'none',
    ingredient_registry_source_breakdown:
      registryDiagnostics.registry_source_breakdown && typeof registryDiagnostics.registry_source_breakdown === 'object'
        ? { ...registryDiagnostics.registry_source_breakdown }
        : {},
    ingredient_reference_match_found: registryDiagnostics.reference_match_found === true,
    ingredient_signal_match_found: registryDiagnostics.signal_match_found === true,
    ingredient_evidence_mode: EVIDENCE_MODE,
    ingredient_candidate_evidence_breakdown: {
      kb_explicit: 0,
      title_exact: 0,
      title_alias: 0,
      ingredient_token_exact: 0,
      ingredient_token_alias: 0,
      url_alias: 0,
      family_only: 0,
    },
    ingredient_direct_miss_reason: null,
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
    diagnostics.ingredient_direct_miss_reason =
      registryDiagnostics.registry_unavailable === true ? 'registry_unavailable' : 'no_registry_match';
    return { products: [], diagnostics };
  }
  if (!process.env.DATABASE_URL) {
    diagnostics.ingredient_direct_miss_reason = 'registry_unavailable';
    return { products: [], diagnostics };
  }

  const seen = new Set();
  const explicitCandidates = [];
  let stepMismatchCount = 0;
  let noiseFilteredCount = 0;

  const kbRows = await fetchKbRowsForProfile({
    profile,
    limit: Math.max(8, Number(limit) * 6 || 24),
  });
  const kbEvidenceLookup = buildKbEvidenceLookup(profile, kbRows);
  const kbSeedIds = uniqStrings(kbRows.map((row) => extractSeedIdFromSkuKey(row?.sku_key)).filter(Boolean), 80);
  const kbUrls = uniqStrings(kbRows.map((row) => normalizeUrl(row?.source_ref)).filter(Boolean), 80);

  const addRows = (rows, sourceTag, { allowFamilyOnly = false, useKbEvidence = false } = {}) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const product = mapSeedRowToRecallProduct(row, sourceTag);
      if (!product) continue;
      const key = buildCandidateKey(product);
      if (!key || seen.has(key)) continue;
      const kbEvidence = useKbEvidence ? resolveKbEvidenceForSeedRow(row, kbEvidenceLookup) : null;
      const scored = buildCandidateEvidence(product, {
        profile,
        targetStepFamily,
        allowFamilyOnly,
        kbEvidence,
        queryText: query,
      });
      if (!scored || !scored.evidence) {
        if (scored?.reject_reason === 'step_family_mismatch') stepMismatchCount += 1;
        else noiseFilteredCount += 1;
        continue;
      }
      seen.add(key);
      explicitCandidates.push({
        product,
        evidence: scored.evidence,
        source_tag: sourceTag,
        ...scoreCandidateEvidence(
          {
            product,
            evidence: scored.evidence,
          },
          resolveSourceRank(sourceTag),
        ),
      });
    }
  };

  diagnostics.kb_recall_attempted = true;
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
  diagnostics.unattached_seed_recovered =
    kbUnattachedRows.length > 0 || unattachedSeedRows.length > 0 ? 1 : 0;
  addRows(kbUnattachedRows, 'kb_unattached_seed', { useKbEvidence: true });
  addRows(unattachedSeedRows, 'unattached_seed');

  let candidates = explicitCandidates.slice();
  const explicitRows = candidates.filter((row) => Number(row?.evidence?.explicit_hits || 0) > 0);
  if (explicitRows.length) candidates = explicitRows;
  const sameFamilyRows = candidates.filter((row) => row?.evidence?.family_relation === 'same_family');
  if (sameFamilyRows.length) candidates = sameFamilyRows;
  const nonNoiseRows = candidates.filter((row) => row.obviousNoise !== true);
  if (nonNoiseRows.length) candidates = nonNoiseRows;
  const nonBundleRows = candidates.filter((row) => row.bundleLike !== true);
  if (nonBundleRows.length) candidates = nonBundleRows;

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
      const familyCandidates = explicitCandidates.filter((row) => row.evidence.family_only === 1);
      diagnostics.family_fallback_recovered = familyCandidates.length > 0 ? 1 : 0;
      diagnostics.family_fallback_used = familyCandidates.length > 0;
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.evidence.kb_explicit !== left.evidence.kb_explicit) {
      return right.evidence.kb_explicit - left.evidence.kb_explicit;
    }
    if (right.evidence.title_exact !== left.evidence.title_exact) {
      return right.evidence.title_exact - left.evidence.title_exact;
    }
    if (right.evidence.title_alias !== left.evidence.title_alias) {
      return right.evidence.title_alias - left.evidence.title_alias;
    }
    if (right.evidence.ingredient_token_exact !== left.evidence.ingredient_token_exact) {
      return right.evidence.ingredient_token_exact - left.evidence.ingredient_token_exact;
    }
    if (right.evidence.ingredient_token_alias !== left.evidence.ingredient_token_alias) {
      return right.evidence.ingredient_token_alias - left.evidence.ingredient_token_alias;
    }
    return String(left.product?.title || left.product?.name || '').localeCompare(
      String(right.product?.title || right.product?.name || ''),
    );
  });

  const rankedRows = candidates.slice(0, Math.max(1, Number(limit) || 6));
  for (const row of rankedRows) {
    mergeBreakdown(diagnostics.recall_source_breakdown, row.source_tag, 1);
    diagnostics.ingredient_candidate_evidence_breakdown.kb_explicit += Number(row.evidence.kb_explicit || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.title_exact += Number(row.evidence.title_exact || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.title_alias += Number(row.evidence.title_alias || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.ingredient_token_exact += Number(row.evidence.ingredient_token_exact || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.ingredient_token_alias += Number(row.evidence.ingredient_token_alias || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.url_alias += Number(row.evidence.url_alias || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.family_only += Number(row.evidence.family_only || 0) > 0 ? 1 : 0;
  }

  const stabilizedProducts = stabilizeIngredientRecallProducts(
    rankedRows.map((row) => row.product),
    {
      recallProfile: profile,
      targetStepFamily,
      queryText: query,
      maxProducts: Math.max(1, Number(limit) || 6),
    },
  );

  diagnostics.ingredient_direct_miss_reason = buildDirectMissReason({
    registryDiagnostics,
    explicitAttempted: diagnostics.kb_recall_attempted || diagnostics.attached_seed_recall_attempted || diagnostics.unattached_seed_recall_attempted,
    allCandidates: explicitCandidates,
    scoredCandidates: candidates,
    stepMismatchCount,
    noiseFilteredCount,
    finalProducts: stabilizedProducts,
  });
  if (stabilizedProducts.length > 0) diagnostics.ingredient_direct_miss_reason = null;

  return {
    products: stabilizedProducts,
    diagnostics,
  };
}

module.exports = {
  EVIDENCE_MODE,
  recallIngredientProductsFromProfile,
  stabilizeIngredientRecallProducts,
  _internals: {
    buildRecallCandidateFieldTexts,
    buildCandidateEvidence,
    scoreCandidateEvidence,
    buildKbEvidence,
    buildKbEvidenceLookup,
    resolveKbEvidenceForSeedRow,
    fetchKbRowsForProfile,
    fetchSeedRowsByIdentity,
    fetchSeedRowsByPatterns,
    collapseIngredientRecallProducts,
    normalizeUrl,
  },
};
