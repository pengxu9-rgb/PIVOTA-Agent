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
const TARGET_STEP_ANCHOR_PHRASES = Object.freeze({
  moisturizer: ['moisturizer', 'moisturiser', 'cream', 'lotion', 'emulsion', 'gel cream', 'gel-cream'],
  serum: ['serum', 'ampoule', 'essence', 'booster'],
  treatment: ['treatment', 'gel', 'solution', 'suspension', 'spot treatment', 'acne treatment'],
  sunscreen: ['sunscreen', 'spf', 'sunblock', 'sun fluid', 'sun lotion'],
  cleanser: ['cleanser', 'face wash', 'facial wash', 'wash', 'foam', 'cleansing'],
  toner: ['toner', 'mist', 'pad'],
  oil: ['oil', 'face oil', 'facial oil'],
});
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
const TREATMENT_LEANING_INGREDIENT_CLASSES = new Set([
  'tone_evening_active',
  'acne_active',
  'retinoid',
  'exfoliant',
  'balancing_active',
]);
const SAME_FAMILY_EXPLICIT_REQUIRED_INGREDIENT_CLASSES = new Set([
  'humectant',
  'soothing_humectant',
]);

let kbAvailabilityCache = {
  checked_at: 0,
  available: false,
};

const PRODUCTS_CACHE_STRONG_TEXT_SQL = `
  lower(
    concat_ws(
      ' ',
      coalesce(pc.product_data->>'title', ''),
      coalesce(pc.product_data->>'name', ''),
      coalesce(pc.product_data->>'product_type', ''),
      coalesce(pc.product_data->>'productType', ''),
      coalesce(pc.product_data->>'category', ''),
      coalesce(pc.product_data->>'vendor', ''),
      coalesce(pc.product_data->>'brand', ''),
      coalesce(pc.product_data->>'url', ''),
      coalesce(pc.product_data->>'canonical_url', ''),
      coalesce(pc.product_data->>'destination_url', ''),
      coalesce((pc.product_data->'ingredient_tokens')::text, ''),
      coalesce((pc.product_data->'key_actives')::text, ''),
      coalesce((pc.product_data->'keyActives')::text, ''),
      coalesce((pc.product_data->'active_ingredients')::text, ''),
      coalesce((pc.product_data->'activeIngredients')::text, ''),
      coalesce((pc.product_data->'key_ingredients')::text, ''),
      coalesce((pc.product_data->'keyIngredients')::text, ''),
      coalesce((pc.product_data->'ingredients')::text, '')
    )
  )
`;

const EXTERNAL_SEED_STRONG_TEXT_SQL = `
  lower(
    concat_ws(
      ' ',
      coalesce(title, ''),
      coalesce(canonical_url, ''),
      coalesce(destination_url, ''),
      coalesce(seed_data->>'title', ''),
      coalesce(seed_data->>'canonical_url', ''),
      coalesce(seed_data->>'destination_url', ''),
      coalesce(seed_data->>'category', ''),
      coalesce(seed_data->>'product_type', ''),
      coalesce(seed_data->'snapshot'->>'title', ''),
      coalesce(seed_data->'snapshot'->>'canonical_url', ''),
      coalesce(seed_data->'snapshot'->>'destination_url', ''),
      coalesce(seed_data->'snapshot'->>'category', ''),
      coalesce(seed_data->'snapshot'->>'product_type', ''),
      coalesce(seed_data->>'raw_ingredient_text_clean', ''),
      coalesce(seed_data->>'inci_list', ''),
      coalesce((seed_data->'ingredient_tokens')::text, ''),
      coalesce((seed_data->'key_ingredients')::text, ''),
      coalesce((seed_data->'keyIngredients')::text, ''),
      coalesce((seed_data->'hero_ingredients')::text, ''),
      coalesce((seed_data->'active_ingredients')::text, ''),
      coalesce((seed_data->'ingredients')::text, ''),
      coalesce((seed_data->'science'->'key_ingredients')::text, ''),
      coalesce((seed_data->'science'->'keyIngredients')::text, ''),
      coalesce((seed_data->'ingredient_intel'->'inci_normalized')::text, ''),
      coalesce((seed_data->'ingredient_intel'->'inciNormalized')::text, ''),
      coalesce(seed_data->'ingredient_intel'->>'inci_raw', ''),
      coalesce(seed_data->'ingredient_intel'->>'raw_ingredient_text_clean', ''),
      coalesce(seed_data->'ingredient_intel'->>'inci_list', ''),
      coalesce(seed_data->'snapshot'->>'raw_ingredient_text_clean', ''),
      coalesce(seed_data->'snapshot'->>'inci_list', ''),
      coalesce((seed_data->'snapshot'->'ingredient_tokens')::text, ''),
      coalesce((seed_data->'snapshot'->'key_ingredients')::text, ''),
      coalesce((seed_data->'snapshot'->'keyIngredients')::text, ''),
      coalesce((seed_data->'snapshot'->'hero_ingredients')::text, ''),
      coalesce((seed_data->'snapshot'->'active_ingredients')::text, ''),
      coalesce((seed_data->'snapshot'->'ingredients')::text, ''),
      coalesce((seed_data->'snapshot'->'science'->'key_ingredients')::text, ''),
      coalesce((seed_data->'snapshot'->'science'->'keyIngredients')::text, ''),
      coalesce((seed_data->'snapshot'->'ingredient_intel'->'inci_normalized')::text, ''),
      coalesce((seed_data->'snapshot'->'ingredient_intel'->'inciNormalized')::text, ''),
      coalesce(seed_data->'snapshot'->'ingredient_intel'->>'inci_raw', ''),
      coalesce(seed_data->'snapshot'->'ingredient_intel'->>'raw_ingredient_text_clean', ''),
      coalesce(seed_data->'snapshot'->'ingredient_intel'->>'inci_list', '')
    )
  )
`;

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
  const out = [];
  const seen = new Set();
  for (const phrase of uniqNormalizedStrings(phrases, 16)) {
    const normalized = normalizeIngredientRecallText(phrase);
    if (!normalized) continue;
    const tokens = normalized.split(' ').filter(Boolean);
    const candidates = [`%${normalized}%`];
    if (tokens.length > 1) {
      candidates.push(`%${tokens.join('%')}%`);
      candidates.push(`%${tokens.join('-')}%`);
      candidates.push(`%${tokens.join('_')}%`);
    }
    for (const candidate of candidates) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

function resolveTargetAnchorPhrases(targetStepFamily, queryText = '') {
  const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
  const base = Array.isArray(TARGET_STEP_ANCHOR_PHRASES[normalizedTargetStepFamily])
    ? TARGET_STEP_ANCHOR_PHRASES[normalizedTargetStepFamily]
    : [];
  if (!base.length) return [];
  const normalizedQuery = normalizeIngredientRecallText(queryText);
  const requested = normalizedQuery
    ? base.filter((phrase) => normalizedQuery.includes(normalizeIngredientRecallText(phrase)))
    : [];
  return uniqNormalizedStrings([...requested, ...base], 8);
}

function buildTargetAnchoredExplicitPatterns({ profile, targetStepFamily = '', queryText = '' } = {}) {
  const phrases = uniqNormalizedStrings([
    ...(Array.isArray(profile?.exact_phrases) ? profile.exact_phrases : []),
    ...(Array.isArray(profile?.alias_phrases) ? profile.alias_phrases : []),
  ], 20);
  const anchors = resolveTargetAnchorPhrases(targetStepFamily, queryText);
  if (!phrases.length || !anchors.length) return [];
  const combined = [];
  for (const phrase of phrases) {
    for (const anchor of anchors) {
      if (!phrase || !anchor) continue;
      combined.push(`${phrase} ${anchor}`);
      combined.push(`${anchor} ${phrase}`);
    }
  }
  return buildPhrasePatterns(combined);
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
      candidate_step_hints: [],
    };
  }
  const exactHits = countPhraseMatches(text, profile?.exact_phrases);
  const aliasHits = countPhraseMatches(text, profile?.alias_phrases);
  const familyHits = countPhraseMatches(text, profile?.family_phrases);
  const strongFamilyHits = countStrongFamilyMatches(text, profile?.family_phrases);
  const candidateStepHints = [];
  const kbStepHint = inferIngredientAwareKbStepHint(profile, [
    row?.product_name,
    row?.source_ref,
  ]);
  if (kbStepHint) candidateStepHints.push(kbStepHint);
  return {
    exact_hits: exactHits,
    alias_hits: aliasHits,
    family_hits: familyHits,
    strong_family_hits: strongFamilyHits,
    explicit_hits: exactHits + aliasHits,
    candidate_step_hints: uniqNormalizedStrings(candidateStepHints, 4),
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
        candidate_step_hints: [],
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
  next.candidate_step_hints = uniqNormalizedStrings([
    ...(Array.isArray(next.candidate_step_hints) ? next.candidate_step_hints : []),
    ...(Array.isArray(evidence.candidate_step_hints) ? evidence.candidate_step_hints : []),
  ], 4);
  return next;
}

function normalizeExpectedStepFamilies(profile) {
  return uniqNormalizedStrings(profile?.expected_step_families, 8)
    .map((value) => normalizeRecoTargetStep(value))
    .filter(Boolean);
}

function inferIngredientAwareKbStepHint(profile, values) {
  const text = (Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!text) return null;
  const direct = normalizeRecoTargetStep(text);
  if (direct) return direct;

  const normalizedText = normalizeIngredientRecallText(text);
  if (!normalizedText) return null;
  const expectedFamilies = new Set(normalizeExpectedStepFamilies(profile));
  const ingredientClass = String(profile?.ingredient_class || '').trim().toLowerCase();
  const treatmentLeaning = TREATMENT_LEANING_INGREDIENT_CLASSES.has(ingredientClass);

  if (/\b(cleanser|face wash|facial wash|wash|foam|cleansing)\b/.test(normalizedText) && expectedFamilies.has('cleanser')) {
    return 'cleanser';
  }
  if (/\b(serum|ampoule|essence|booster)\b/.test(normalizedText) && expectedFamilies.has('serum')) {
    return 'serum';
  }
  if (/\b(toner|mist|pad)\b/.test(normalizedText) && expectedFamilies.has('toner')) {
    return 'toner';
  }
  if (/\b(spf|sunscreen|sunblock|sun fluid|sun lotion)\b/.test(normalizedText) && expectedFamilies.has('sunscreen')) {
    return 'sunscreen';
  }
  if (/\b(face oil|facial oil|oil)\b/.test(normalizedText) && expectedFamilies.has('oil')) {
    return 'oil';
  }
  if (
    /\b(gel|spot treatment|spot|suspension|solution|acid|retinol|retinoid|blemish|acne)\b/.test(normalizedText) &&
    (expectedFamilies.has('treatment') || treatmentLeaning)
  ) {
    return 'treatment';
  }
  if (/\b(cream|lotion|moisturi[sz]er|emulsion|gel cream|gel-cream|day cream|night cream)\b/.test(normalizedText)) {
    if (treatmentLeaning && expectedFamilies.has('treatment')) return 'treatment';
    if (expectedFamilies.has('moisturizer')) return 'moisturizer';
    if (expectedFamilies.has('treatment')) return 'treatment';
  }
  return null;
}

function extractSeedIdFromSkuKey(skuKey) {
  const normalized = String(skuKey || '').trim();
  return normalized.match(/^extseed:([^:]+):/)?.[1] || '';
}

function buildKbEvidenceLookup(profile, kbRows) {
  const bySeedId = new Map();
  const byUrl = new Map();
  const byTitle = new Map();
  const byTitleBrand = new Map();
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
    const titleKey = normalizeIngredientRecallText(row?.product_name);
    if (titleKey) {
      byTitle.set(titleKey, mergeKbEvidence(byTitle.get(titleKey), evidence));
      const brandKey = normalizeIngredientRecallText(row?.brand);
      if (brandKey) {
        byTitleBrand.set(`${brandKey}::${titleKey}`, mergeKbEvidence(byTitleBrand.get(`${brandKey}::${titleKey}`), evidence));
      }
    }
  }
  return { bySeedId, byUrl, byTitle, byTitleBrand };
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
  const titleKeys = uniqStrings([
    normalizeIngredientRecallText(row?.title),
    normalizeIngredientRecallText(row?.seed_data?.title),
    normalizeIngredientRecallText(row?.seed_data?.snapshot?.title),
  ]).map(normalizeIngredientRecallText).filter(Boolean);
  const brandKeys = uniqStrings([
    normalizeIngredientRecallText(row?.brand),
    normalizeIngredientRecallText(row?.seed_data?.brand),
    normalizeIngredientRecallText(row?.seed_data?.snapshot?.brand),
  ]).map(normalizeIngredientRecallText).filter(Boolean);
  for (const titleKey of titleKeys) {
    if (lookup.byTitle instanceof Map && lookup.byTitle.has(titleKey)) {
      evidence = mergeKbEvidence(evidence, lookup.byTitle.get(titleKey));
    }
    for (const brandKey of brandKeys) {
      const compositeKey = `${brandKey}::${titleKey}`;
      if (lookup.byTitleBrand instanceof Map && lookup.byTitleBrand.has(compositeKey)) {
        evidence = mergeKbEvidence(evidence, lookup.byTitleBrand.get(compositeKey));
      }
    }
  }
  return evidence;
}

function resolveKbEvidenceForProduct(product, kbEvidenceLookup) {
  const lookup = kbEvidenceLookup && typeof kbEvidenceLookup === 'object' ? kbEvidenceLookup : null;
  if (!lookup || !product || typeof product !== 'object') return null;
  let evidence = null;
  const urls = uniqStrings([
    normalizeUrl(product?.canonical_url),
    normalizeUrl(product?.destination_url),
    normalizeUrl(product?.url),
  ]);
  for (const url of urls) {
    if (lookup.byUrl instanceof Map && lookup.byUrl.has(url)) {
      evidence = mergeKbEvidence(evidence, lookup.byUrl.get(url));
    }
  }
  const titleKeys = uniqStrings([
    normalizeIngredientRecallText(product?.title),
    normalizeIngredientRecallText(product?.name),
    normalizeIngredientRecallText(product?.display_name),
    normalizeIngredientRecallText(product?.product_name),
  ]).map(normalizeIngredientRecallText).filter(Boolean);
  const brandKeys = uniqStrings([
    normalizeIngredientRecallText(product?.brand),
    normalizeIngredientRecallText(product?.vendor),
  ]).map(normalizeIngredientRecallText).filter(Boolean);
  for (const titleKey of titleKeys) {
    if (lookup.byTitle instanceof Map && lookup.byTitle.has(titleKey)) {
      evidence = mergeKbEvidence(evidence, lookup.byTitle.get(titleKey));
    }
    for (const brandKey of brandKeys) {
      const compositeKey = `${brandKey}::${titleKey}`;
      if (lookup.byTitleBrand instanceof Map && lookup.byTitleBrand.has(compositeKey)) {
        evidence = mergeKbEvidence(evidence, lookup.byTitleBrand.get(compositeKey));
      }
    }
  }
  return evidence;
}

function buildKbProductNamePatterns(kbRows, maxItems = 16) {
  return buildPhrasePatterns(
    uniqStrings(
      (Array.isArray(kbRows) ? kbRows : [])
        .map((row) => String(row?.product_name || '').trim())
        .filter(Boolean),
      maxItems,
    ),
  );
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

function attachIngredientRecallMeta(product, meta) {
  if (!product || typeof product !== 'object' || !meta || typeof meta !== 'object') return product;
  const nextMeta = {
    evidence: meta.evidence && typeof meta.evidence === 'object' ? { ...meta.evidence } : {},
    candidate_step: String(meta.candidate_step || '').trim() || null,
    family_relation: String(meta.family_relation || '').trim() || null,
    source_tag: String(meta.source_tag || '').trim() || null,
  };
  try {
    Object.defineProperty(product, '__ingredient_recall_meta', {
      value: nextMeta,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch (_err) {
    product.__ingredient_recall_meta = nextMeta;
  }
  return product;
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

function requiresSameFamilyExplicitGate(profile = null, targetStepFamily = '') {
  if (!normalizeRecoTargetStep(targetStepFamily)) return false;
  const ingredientClass = normalizeIngredientRecallText(profile?.ingredient_class || '');
  return SAME_FAMILY_EXPLICIT_REQUIRED_INGREDIENT_CLASSES.has(ingredientClass);
}

function resolveRecallFetchLimit(profile, limit, multiplier = 1, fallbackLimit = 24) {
  const baseLimit = Math.max(6, Number(limit) || fallbackLimit);
  const ingredientClass = normalizeIngredientRecallText(profile?.ingredient_class || '');
  const boostedMultiplier = SAME_FAMILY_EXPLICIT_REQUIRED_INGREDIENT_CLASSES.has(ingredientClass)
    ? Math.max(multiplier, 10)
    : multiplier;
  return Math.max(8, Math.min(120, Math.floor(baseLimit * boostedMultiplier)));
}

function mergeBreakdown(target, sourceTag, amount = 1) {
  const key = String(sourceTag || '').trim() || 'unknown';
  target[key] = Number(target[key] || 0) + Math.max(0, Math.trunc(Number(amount) || 0));
}

function pushCandidateSample(target, sample, maxItems = 5) {
  if (!Array.isArray(target) || !sample || typeof sample !== 'object') return;
  if (target.length >= Math.max(1, Number(maxItems) || 5)) return;
  target.push(sample);
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
  const normalizedTargetStepFamily = normalizeRecoTargetStep(targetStepFamily);
  const targetAnchorPhrases = resolveTargetAnchorPhrases(normalizedTargetStepFamily, queryText);
  const targetAnchorHits = countPhraseMatches(
    [fieldTexts.title, fieldTexts.support].join(' '),
    targetAnchorPhrases,
  );
  const candidateStep =
    resolveRecallCandidateStep(product) ||
    normalizeRecoTargetStep(Array.isArray(kbEvidence?.candidate_step_hints) ? kbEvidence.candidate_step_hints[0] : '') ||
    inferIngredientAwareKbStepHint(profile, [
      product?.title,
      product?.name,
      product?.display_name,
      product?.category,
      product?.product_type,
      product?.description,
      product?.canonical_url,
      product?.destination_url,
      product?.url,
    ]);
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
  const surfaceExplicitHits =
    titleExactHits + titleAliasHits + tokenExactHits + tokenAliasHits + urlExactHits + urlAliasHits;
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
  if (
    evidence.explicit_hits > 0 &&
    normalizedTargetStepFamily &&
    requiresSameFamilyExplicitGate(profile, normalizedTargetStepFamily) &&
    candidateStep &&
    familyRelation !== 'same_family'
  ) {
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
  if (
    evidence.explicit_hits > 0 &&
    surfaceExplicitHits <= 0 &&
    kbExplicitHits > 0 &&
    normalizedTargetStepFamily &&
    requiresSameFamilyExplicitGate(profile, normalizedTargetStepFamily) &&
    familyRelation === 'same_family'
  ) {
    const kbStepHints = Array.isArray(kbEvidence?.candidate_step_hints)
      ? kbEvidence.candidate_step_hints
      : [];
    const hasSameFamilyKbHint = kbStepHints.some(
      (value) => normalizeRecoTargetStep(value) === normalizedTargetStepFamily,
    );
    if (targetAnchorHits <= 0 && !hasSameFamilyKbHint) {
      return { reject_reason: 'no_explicit_sku_evidence', evidence };
    }
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
      const recallMeta =
        product && typeof product === 'object' && product.__ingredient_recall_meta && typeof product.__ingredient_recall_meta === 'object'
          ? product.__ingredient_recall_meta
          : null;
      const text = buildIngredientRecallProductText(product);
      const fieldTexts = buildRecallCandidateFieldTexts(product);
      const exactHits = recallMeta
        ? Math.max(
            0,
            Number(recallMeta.evidence?.title_exact || 0) +
              Number(recallMeta.evidence?.ingredient_token_exact || 0),
          )
        : countPhraseMatches(text, recallProfile?.exact_phrases);
      const aliasHits = recallMeta
        ? Math.max(
            0,
            Number(recallMeta.evidence?.title_alias || 0) +
              Number(recallMeta.evidence?.ingredient_token_alias || 0) +
              Number(recallMeta.evidence?.url_alias || 0),
          )
        : countPhraseMatches(text, recallProfile?.alias_phrases);
      const explicitHits =
        (recallMeta ? Math.max(0, Number(recallMeta.evidence?.kb_explicit || 0)) : 0) +
        exactHits +
        aliasHits;
      const surfaceExplicitHits = exactHits + aliasHits;
      const candidateStep = recallMeta?.candidate_step || resolveRecallCandidateStep(product);
      const familyRelation = normalizedTargetStepFamily
        ? recallMeta?.family_relation || getRecoTargetFamilyRelation(normalizedTargetStepFamily, candidateStep)
        : recallMeta?.family_relation || null;
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
        surfaceExplicitHits,
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
  const surfaceExplicitRows = rows.filter((row) => row.surfaceExplicitHits > 0);
  if (surfaceExplicitRows.length) rows = surfaceExplicitRows;
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
        OR lower(coalesce(source_ref, '')) LIKE ANY($1::text[])
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

function appendProductsCacheIngredientTokens(out, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendProductsCacheIngredientTokens(out, item);
    return;
  }
  if (typeof value === 'string') {
    const normalized = String(value || '').trim();
    if (normalized) out.push(normalized);
    return;
  }
  if (typeof value !== 'object') return;
  appendProductsCacheIngredientTokens(out, value.inci);
  appendProductsCacheIngredientTokens(out, value.inci_name);
  appendProductsCacheIngredientTokens(out, value.ingredient_name);
  appendProductsCacheIngredientTokens(out, value.name);
  appendProductsCacheIngredientTokens(out, value.display_name);
  appendProductsCacheIngredientTokens(out, value.title);
}

function collectProductsCacheIngredientTokens(productData) {
  const data = productData && typeof productData === 'object' && !Array.isArray(productData)
    ? productData
    : {};
  const out = [];
  const sources = [
    data.ingredient_tokens,
    data.key_actives,
    data.keyActives,
    data.active_ingredients,
    data.activeIngredients,
    data.key_ingredients,
    data.keyIngredients,
    data.hero_ingredients,
    data.heroIngredients,
    data.ingredients,
    data.inci,
    data.inci_list,
    data.raw_ingredient_text_clean,
  ];
  for (const source of sources) appendProductsCacheIngredientTokens(out, source);
  return uniqStrings(out, 64);
}

function mapProductsCacheRowToRecallProduct(row, sourceTag) {
  const productData =
    row?.product_data && typeof row.product_data === 'object' && !Array.isArray(row.product_data)
      ? row.product_data
      : null;
  if (!productData) return null;
  const ingredientTokens = collectProductsCacheIngredientTokens(productData);
  const title =
    String(
      productData.title ||
        productData.name ||
        productData.display_name ||
        productData.product_name ||
        '',
    ).trim() || undefined;
  const description = String(productData.description || '').trim() || undefined;
  const category =
    String(productData.category || productData.product_category || '').trim() || undefined;
  const productType =
    String(productData.product_type || productData.productType || category || '').trim() || undefined;
  const vendor = String(productData.vendor || productData.brand || '').trim() || undefined;
  const brand = String(productData.brand || productData.vendor || '').trim() || undefined;
  const tags = Array.isArray(productData.tags)
    ? productData.tags.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const url = normalizeUrl(
    productData.url ||
      productData.canonical_url ||
      productData.destination_url ||
      productData.product_url,
  );
  const canonicalUrl = normalizeUrl(productData.canonical_url || productData.url || productData.product_url);
  const destinationUrl = normalizeUrl(
    productData.destination_url || productData.url || productData.product_url,
  );
  return {
    ...productData,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(productType ? { product_type: productType } : {}),
    ...(vendor ? { vendor } : {}),
    ...(brand ? { brand } : {}),
    ...(url ? { url } : {}),
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(destinationUrl ? { destination_url: destinationUrl } : {}),
    ...(ingredientTokens.length ? { ingredient_tokens: ingredientTokens } : {}),
    ...(tags.length ? { tag_tokens: tags } : {}),
    ...(String(row?.merchant_id || '').trim() ? { merchant_id: String(row.merchant_id).trim() } : {}),
    ...(String(row?.merchant_name || '').trim()
      ? { merchant_name: String(row.merchant_name).trim() }
      : {}),
    source: 'products_cache',
    retrieval_source: String(sourceTag || '').trim() || 'products_cache',
    retrieval_reason: String(sourceTag || '').trim() || 'products_cache',
  };
}

async function fetchProductsCacheRowsByPatterns({ patterns = [], limit = 24 } = {}) {
  const normalizedPatterns = uniqStrings(patterns, 16);
  if (!normalizedPatterns.length) return [];
  const sqlParams = [normalizedPatterns, Math.max(6, Number(limit) || 24)];
  const limitBind = `$${sqlParams.length}`;
  const res = await runAppQuery(
    `
      SELECT
        pc.merchant_id,
        mo.business_name AS merchant_name,
        pc.product_data,
        pc.cached_at,
        pc.id
      FROM products_cache pc
      JOIN merchant_onboarding mo
        ON mo.merchant_id = pc.merchant_id
      WHERE (pc.expires_at IS NULL OR pc.expires_at > now())
        AND COALESCE(lower(pc.product_data->>'status'), 'active') = 'active'
        AND COALESCE(lower(pc.product_data->>'orderable'), 'true') <> 'false'
        AND mo.status NOT IN ('deleted', 'rejected')
        AND mo.psp_connected = true
        AND (
          lower(coalesce(pc.product_data->>'title', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'name', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'description', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'product_type', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'productType', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'category', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'vendor', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'brand', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'url', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'canonical_url', '')) LIKE ANY($1::text[])
          OR lower(coalesce(pc.product_data->>'destination_url', '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'ingredient_tokens')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'key_actives')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'keyActives')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'active_ingredients')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'activeIngredients')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'key_ingredients')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'keyIngredients')::text, '')) LIKE ANY($1::text[])
          OR lower(coalesce((pc.product_data->'ingredients')::text, '')) LIKE ANY($1::text[])
          OR ${PRODUCTS_CACHE_STRONG_TEXT_SQL} LIKE ANY($1::text[])
        )
      ORDER BY
        CASE
          WHEN lower(coalesce(pc.product_data->>'title', '')) LIKE ANY($1::text[]) THEN 0
          WHEN ${PRODUCTS_CACHE_STRONG_TEXT_SQL} LIKE ANY($1::text[]) THEN 1
          WHEN (
            lower(coalesce((pc.product_data->'ingredient_tokens')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'key_actives')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'keyActives')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'active_ingredients')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'activeIngredients')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'key_ingredients')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'keyIngredients')::text, '')) LIKE ANY($1::text[])
            OR lower(coalesce((pc.product_data->'ingredients')::text, '')) LIKE ANY($1::text[])
          ) THEN 2
          WHEN lower(coalesce(pc.product_data->>'product_type', '')) LIKE ANY($1::text[]) THEN 3
          WHEN lower(coalesce(pc.product_data->>'description', '')) LIKE ANY($1::text[]) THEN 4
          ELSE 5
        END,
        pc.cached_at DESC NULLS LAST,
        pc.id DESC
      LIMIT ${limitBind}
    `,
    sqlParams,
  );
  return Array.isArray(res?.rows) ? res.rows : [];
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
      OR lower(coalesce(seed_data->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->>'inci_list', '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'ingredient_tokens')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'key_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'keyIngredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'hero_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'active_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'science'->'key_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'science'->'keyIngredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'ingredient_intel'->'inci_normalized')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'ingredient_intel'->'inciNormalized')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'ingredient_intel'->>'inci_raw', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'ingredient_intel'->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'ingredient_intel'->>'inci_list', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->>'inci_list', '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'ingredient_tokens')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'key_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'keyIngredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'hero_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'active_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'science'->'key_ingredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'science'->'keyIngredients')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'ingredient_intel'->'inci_normalized')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce((seed_data->'snapshot'->'ingredient_intel'->'inciNormalized')::text, '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->'ingredient_intel'->>'inci_raw', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->'ingredient_intel'->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
      OR lower(coalesce(seed_data->'snapshot'->'ingredient_intel'->>'inci_list', '')) LIKE ANY($3::text[])
      OR ${EXTERNAL_SEED_STRONG_TEXT_SQL} LIKE ANY($3::text[])
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
          WHEN ${EXTERNAL_SEED_STRONG_TEXT_SQL} LIKE ANY($3::text[]) THEN 1
          WHEN (
            lower(coalesce(seed_data->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->>'inci_list', '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'ingredient_tokens')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'key_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'keyIngredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'hero_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'active_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'science'->'key_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'science'->'keyIngredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'ingredient_intel'->'inci_normalized')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'ingredient_intel'->'inciNormalized')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'ingredient_intel'->>'inci_raw', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'ingredient_intel'->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'ingredient_intel'->>'inci_list', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->>'inci_list', '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'ingredient_tokens')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'key_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'keyIngredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'hero_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'active_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'science'->'key_ingredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'science'->'keyIngredients')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'ingredient_intel'->'inci_normalized')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce((seed_data->'snapshot'->'ingredient_intel'->'inciNormalized')::text, '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->'ingredient_intel'->>'inci_raw', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->'ingredient_intel'->>'raw_ingredient_text_clean', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->'snapshot'->'ingredient_intel'->>'inci_list', '')) LIKE ANY($3::text[])
          ) THEN 2
          WHEN lower(coalesce(seed_data->>'title', '')) LIKE ANY($3::text[]) THEN 3
          WHEN lower(coalesce(seed_data->'snapshot'->>'title', '')) LIKE ANY($3::text[]) THEN 4
          WHEN (
            lower(coalesce(canonical_url, '')) LIKE ANY($3::text[])
            OR lower(coalesce(destination_url, '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->>'canonical_url', '')) LIKE ANY($3::text[])
            OR lower(coalesce(seed_data->>'destination_url', '')) LIKE ANY($3::text[])
          ) THEN 5
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

function resolveSourceRank(sourceTag) {
  if (sourceTag === 'kb_attached_seed_target_anchored') return 500;
  if (sourceTag === 'kb_attached_seed') return 480;
  if (sourceTag === 'kb_named_attached_seed_target_anchored') return 450;
  if (sourceTag === 'kb_named_attached_seed') return 430;
  if (sourceTag === 'attached_seed_target_anchored') return 390;
  if (sourceTag === 'attached_seed') return 360;
  if (sourceTag === 'kb_named_products_cache_target_anchored') return 350;
  if (sourceTag === 'kb_named_products_cache') return 340;
  if (sourceTag === 'products_cache_target_anchored') return 330;
  if (sourceTag === 'products_cache') return 320;
  if (sourceTag === 'kb_unattached_seed_target_anchored') return 280;
  if (sourceTag === 'kb_unattached_seed') return 260;
  if (sourceTag === 'kb_named_unattached_seed_target_anchored') return 250;
  if (sourceTag === 'kb_named_unattached_seed') return 240;
  if (sourceTag === 'unattached_seed_target_anchored') return 220;
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
    products_cache_recall_attempted: false,
    products_cache_recall_recovered: 0,
    unattached_seed_recall_attempted: false,
    unattached_seed_recall_recovered: 0,
    family_fallback_attempted: false,
    family_fallback_recovered: 0,
    family_fallback_used: false,
    recall_source_breakdown: {},
    ingredient_candidate_reject_breakdown: {},
    ingredient_rejected_candidate_samples: [],
    ingredient_ranked_candidate_samples: [],
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
    limit: resolveRecallFetchLimit(profile, limit, 6, 24),
  });
  const kbEvidenceLookup = buildKbEvidenceLookup(profile, kbRows);
  const kbProductNamePatterns = buildKbProductNamePatterns(kbRows, 20);
  const kbSeedIds = uniqStrings(kbRows.map((row) => extractSeedIdFromSkuKey(row?.sku_key)).filter(Boolean), 80);
  const kbUrls = uniqStrings(kbRows.map((row) => normalizeUrl(row?.source_ref)).filter(Boolean), 80);

  const addProduct = (product, sourceTag, { allowFamilyOnly = false, kbEvidence = null } = {}) => {
    if (!product) return;
    const key = buildCandidateKey(product);
    if (!key || seen.has(key)) return;
    const scored = buildCandidateEvidence(product, {
      profile,
      targetStepFamily,
      allowFamilyOnly,
      kbEvidence,
      queryText: query,
    });
    if (!scored || !scored.evidence) {
      const rejectReason = String(scored?.reject_reason || 'all_candidates_filtered_noise').trim() || 'all_candidates_filtered_noise';
      if (rejectReason === 'step_family_mismatch') stepMismatchCount += 1;
      else noiseFilteredCount += 1;
      mergeBreakdown(diagnostics.ingredient_candidate_reject_breakdown, rejectReason, 1);
      pushCandidateSample(diagnostics.ingredient_rejected_candidate_samples, {
        title:
          String(product?.title || product?.name || product?.display_name || '').trim() || null,
        source_tag: sourceTag,
        reject_reason: rejectReason,
        candidate_step: scored?.evidence?.candidate_step || resolveRecallCandidateStep(product) || null,
        family_relation: scored?.evidence?.family_relation || null,
        kb_explicit: Number(kbEvidence?.explicit_hits || 0) > 0 ? 1 : 0,
      });
      return;
    }
    seen.add(key);
    attachIngredientRecallMeta(product, {
      evidence: scored.evidence,
      candidate_step: scored.evidence?.candidate_step,
      family_relation: scored.evidence?.family_relation,
      source_tag: sourceTag,
    });
    explicitCandidates.push({
      product,
      evidence: scored.evidence,
      source_tag: sourceTag,
      ...scoreCandidateEvidence(
        product,
        {
          evidence: scored.evidence,
          product,
        },
        resolveSourceRank(sourceTag),
      ),
    });
  };

  const addRows = (
    rows,
    sourceTag,
    {
      allowFamilyOnly = false,
      useKbEvidence = false,
      mapper = mapSeedRowToRecallProduct,
      kbResolver = (row, _product, lookup) => resolveKbEvidenceForSeedRow(row, lookup),
    } = {},
  ) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const product = mapper(row, sourceTag);
      if (!product) continue;
      const kbEvidence = useKbEvidence ? kbResolver(row, product, kbEvidenceLookup) : null;
      addProduct(product, sourceTag, { allowFamilyOnly, kbEvidence });
    }
  };

  diagnostics.kb_recall_attempted = true;
  const kbAttachedRows = await fetchSeedRowsByIdentity({
    seedIds: kbSeedIds,
    urls: kbUrls,
    market,
    tool,
    attachedState: 'attached',
    limit: resolveRecallFetchLimit(profile, limit, 4, 24),
  });
  diagnostics.kb_recall_recovered = kbAttachedRows.length > 0 ? 1 : 0;
  addRows(kbAttachedRows, 'kb_attached_seed', { useKbEvidence: true });
  const kbNamedAttachedRows = await fetchSeedRowsByPatterns({
    patterns: kbProductNamePatterns,
    market,
    tool,
    attachedState: 'attached',
    limit: resolveRecallFetchLimit(profile, limit, 4, 24),
    inStockOnly,
  });
  if (kbNamedAttachedRows.length > 0) diagnostics.kb_recall_recovered = 1;
  addRows(kbNamedAttachedRows, 'kb_named_attached_seed', { useKbEvidence: true });

  diagnostics.attached_seed_recall_attempted = true;
  const targetAnchoredExplicitPatterns = buildTargetAnchoredExplicitPatterns({
    profile,
    targetStepFamily,
    queryText: query,
  });
  const explicitPatterns = buildPhrasePatterns([
    ...(Array.isArray(profile.exact_phrases) ? profile.exact_phrases : []),
    ...(Array.isArray(profile.alias_phrases) ? profile.alias_phrases : []),
  ]);
  const attachedAnchoredRows = await fetchSeedRowsByPatterns({
    patterns: targetAnchoredExplicitPatterns,
    market,
    tool,
    attachedState: 'attached',
    limit: resolveRecallFetchLimit(profile, limit, 4, 24),
    inStockOnly,
  });
  if (attachedAnchoredRows.length > 0) diagnostics.attached_seed_recall_recovered = 1;
  addRows(attachedAnchoredRows, 'attached_seed_target_anchored');
  const attachedSeedRows = await fetchSeedRowsByPatterns({
    patterns: explicitPatterns,
    market,
    tool,
    attachedState: 'attached',
    limit: resolveRecallFetchLimit(profile, limit, 6, 30),
    inStockOnly,
  });
  diagnostics.attached_seed_recall_recovered =
    diagnostics.attached_seed_recall_recovered || (attachedSeedRows.length > 0 ? 1 : 0);
  addRows(attachedSeedRows, 'attached_seed');

  diagnostics.products_cache_recall_attempted = true;
  const cacheAnchoredRows = await fetchProductsCacheRowsByPatterns({
    patterns: targetAnchoredExplicitPatterns,
    limit: resolveRecallFetchLimit(profile, limit, 4, 24),
  });
  if (cacheAnchoredRows.length > 0) diagnostics.products_cache_recall_recovered = 1;
  addRows(cacheAnchoredRows, 'products_cache_target_anchored', {
    mapper: mapProductsCacheRowToRecallProduct,
    kbResolver: (_row, product, lookup) => resolveKbEvidenceForProduct(product, lookup),
    useKbEvidence: true,
  });
  const cacheExplicitRows = await fetchProductsCacheRowsByPatterns({
    patterns: explicitPatterns,
    limit: resolveRecallFetchLimit(profile, limit, 6, 30),
  });
  diagnostics.products_cache_recall_recovered =
    diagnostics.products_cache_recall_recovered || (cacheExplicitRows.length > 0 ? 1 : 0);
  addRows(cacheExplicitRows, 'products_cache', {
    mapper: mapProductsCacheRowToRecallProduct,
    kbResolver: (_row, product, lookup) => resolveKbEvidenceForProduct(product, lookup),
    useKbEvidence: true,
  });
  const kbNamedCacheRows = await fetchProductsCacheRowsByPatterns({
    patterns: kbProductNamePatterns,
    limit: resolveRecallFetchLimit(profile, limit, 4, 24),
  });
  if (kbNamedCacheRows.length > 0) diagnostics.products_cache_recall_recovered = 1;
  addRows(kbNamedCacheRows, 'kb_named_products_cache', {
    mapper: mapProductsCacheRowToRecallProduct,
    kbResolver: (_row, product, lookup) => resolveKbEvidenceForProduct(product, lookup),
    useKbEvidence: true,
  });

  diagnostics.unattached_seed_recall_attempted = true;
  const kbUnattachedRows = await fetchSeedRowsByIdentity({
    seedIds: kbSeedIds,
    urls: kbUrls,
    market,
    tool,
    attachedState: 'unattached',
    limit: resolveRecallFetchLimit(profile, limit, 4, 18),
  });
  const unattachedAnchoredRows = await fetchSeedRowsByPatterns({
    patterns: targetAnchoredExplicitPatterns,
    market,
    tool,
    attachedState: 'unattached',
    limit: resolveRecallFetchLimit(profile, limit, 4, 18),
    inStockOnly,
  });
  if (unattachedAnchoredRows.length > 0) diagnostics.unattached_seed_recall_recovered = 1;
  addRows(unattachedAnchoredRows, 'unattached_seed_target_anchored');
  const unattachedSeedRows = await fetchSeedRowsByPatterns({
    patterns: explicitPatterns,
    market,
    tool,
    attachedState: 'unattached',
    limit: resolveRecallFetchLimit(profile, limit, 8, 36),
    inStockOnly,
  });
  diagnostics.unattached_seed_recall_recovered =
    diagnostics.unattached_seed_recall_recovered ||
    (kbUnattachedRows.length > 0 || unattachedSeedRows.length > 0 ? 1 : 0);
  addRows(kbUnattachedRows, 'kb_unattached_seed', { useKbEvidence: true });
  const kbNamedUnattachedRows = await fetchSeedRowsByPatterns({
    patterns: kbProductNamePatterns,
    market,
    tool,
    attachedState: 'unattached',
    limit: resolveRecallFetchLimit(profile, limit, 4, 18),
    inStockOnly,
  });
  if (kbNamedUnattachedRows.length > 0) diagnostics.unattached_seed_recall_recovered = 1;
  addRows(kbNamedUnattachedRows, 'kb_named_unattached_seed', { useKbEvidence: true });
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

  const sampleRows = candidates.slice(0, Math.max(1, Number(limit) || 6));
  for (const row of sampleRows) {
    diagnostics.ingredient_candidate_evidence_breakdown.kb_explicit += Number(row.evidence.kb_explicit || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.title_exact += Number(row.evidence.title_exact || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.title_alias += Number(row.evidence.title_alias || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.ingredient_token_exact += Number(row.evidence.ingredient_token_exact || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.ingredient_token_alias += Number(row.evidence.ingredient_token_alias || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.url_alias += Number(row.evidence.url_alias || 0) > 0 ? 1 : 0;
    diagnostics.ingredient_candidate_evidence_breakdown.family_only += Number(row.evidence.family_only || 0) > 0 ? 1 : 0;
    pushCandidateSample(diagnostics.ingredient_ranked_candidate_samples, {
      title: String(row.product?.title || row.product?.name || row.product?.display_name || '').trim() || null,
      source_tag: row.source_tag || null,
      candidate_step: row.evidence?.candidate_step || null,
      family_relation: row.evidence?.family_relation || null,
      kb_explicit: Number(row.evidence?.kb_explicit || 0) > 0 ? 1 : 0,
      explicit_hits: Number(row.evidence?.explicit_hits || 0) || 0,
      family_only: Number(row.evidence?.family_only || 0) > 0 ? 1 : 0,
    });
  }

  const stabilizationRows = candidates.slice(
    0,
    Math.max(
      Math.max(1, Number(limit) || 6),
      Math.min(48, Math.max(12, Math.floor((Number(limit) || 6) * 4))),
    ),
  );

  const stabilizedProducts = stabilizeIngredientRecallProducts(
    stabilizationRows.map((row) => row.product),
    {
      recallProfile: profile,
      targetStepFamily,
      queryText: query,
      maxProducts: Math.max(1, Number(limit) || 6),
    },
  );
  diagnostics.recall_source_breakdown = {};
  for (const product of stabilizedProducts) {
    const sourceTag = String(product?.__ingredient_recall_meta?.source_tag || '').trim() || 'unknown';
    mergeBreakdown(diagnostics.recall_source_breakdown, sourceTag, 1);
  }

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
    fetchProductsCacheRowsByPatterns,
    fetchSeedRowsByIdentity,
    fetchSeedRowsByPatterns,
    buildTargetAnchoredExplicitPatterns,
    collapseIngredientRecallProducts,
    normalizeUrl,
  },
};
