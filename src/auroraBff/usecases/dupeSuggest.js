'use strict';

const { normalizeProductUrlInput } = require('../services/urlAliasNormalizer');
const { applyDupeSuggestQualityGate, hasMeaningfulTradeoffs, isHollowItem } = require('../qualityGates/dupeSuggestGate');
const {
  buildProductInputText,
  extractAnchorIdFromProductLike,
  resolveOriginalForPayload,
  buildDupeSuggestKbKey,
  normalizeCandidatePoolMeta,
  buildDupeSuggestQualityAssessment,
} = require('../mappers/dupeSuggestMapper');
const {
  sanitizeCandidates,
  filterSelfReferences,
  deduplicateCandidates,
  getCandidateIdentity,
  hasSyntheticRecommendationSuffix,
  buildAnchorIdentity,
  buildAnchorFingerprint,
  detectSelfReference,
} = require('../skills/dupe_utils');

const DUPE_SUGGEST_KB_CONTRACT_VERSION = 'dupe_suggest_v9';
let dupeKbContractPurgePromise = null;
const PLACEHOLDER_REASON_PATTERNS = [
  /^grounded alternatives derived from resolved candidate pool\.?$/i,
  /^based on resolved product candidates\.?$/i,
  /^\d+\s*%\s*similar$/i,
  /^相似度\s*\d+\s*%$/i,
  /^基于已解析商品候选给出 grounded alternatives。?$/i,
];
const DUPE_POOL_ACTIVE_THEME_RULES = [
  { key: 'niacinamide', patterns: [/\bniacinamide\b/i, /烟酰胺/] },
  { key: 'zinc', patterns: [/\bzinc\b/i, /锌/] },
  { key: 'salicylic_acid', patterns: [/\bsalicylic\b/i, /\bbha\b/i, /水杨酸/] },
  { key: 'hyaluronic_acid', patterns: [/\bhyaluronic\b/i, /\bha\b/i, /\bsodium hyaluronate\b/i, /玻尿酸/, /透明质酸/] },
  { key: 'vitamin_c', patterns: [/\bvitamin c\b/i, /\bascorb/i, /维c/, /维C/, /抗坏血酸/] },
  { key: 'retinol', patterns: [/\bretinol\b/i, /\bretinal\b/i, /\bretinoid\b/i, /视黄醇/, /a醇/, /维a/] },
  { key: 'ceramide', patterns: [/\bceramide\b/i, /神经酰胺/] },
  { key: 'peptide', patterns: [/\bpeptide\b/i, /肽/] },
  { key: 'azelaic_acid', patterns: [/\bazelaic\b/i, /壬二酸/] },
  { key: 'tranexamic_acid', patterns: [/\btranexamic\b/i, /传明酸/, /氨甲环酸/] },
  { key: 'panthenol', patterns: [/\bpanthenol\b/i, /\bprovitamin b5\b/i, /泛醇/, /维生素b5/, /维B5/] },
  { key: 'snail_mucin', patterns: [/\bsnail\b/i, /\bmucin\b/i, /蜗牛/] },
];

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function summarizeFieldMissingReasons(entries) {
  return uniqStrings(
    (Array.isArray(entries) ? entries : []).map((row) => (
      row && typeof row === 'object' && !Array.isArray(row) ? row.reason : ''
    )),
  );
}

function mergeFieldMissingEntries(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const row of Array.isArray(list) ? list : []) {
      if (!row || typeof row !== 'object') continue;
      const field = String(row.field || '').trim();
      const reason = String(row.reason || '').trim();
      if (!field || !reason) continue;
      const key = `${field.toLowerCase()}::${reason.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ field, reason });
    }
  }
  return out;
}

function hasMeaningfulProfileSummary(profileSummary) {
  const profile = profileSummary && typeof profileSummary === 'object' && !Array.isArray(profileSummary)
    ? profileSummary
    : null;
  if (!profile) return false;
  if (typeof profile.skinType === 'string' && profile.skinType.trim()) return true;
  if (typeof profile.sensitivity === 'string' && profile.sensitivity.trim()) return true;
  if (typeof profile.barrierStatus === 'string' && profile.barrierStatus.trim()) return true;
  if (Array.isArray(profile.goals) && profile.goals.some((item) => typeof item === 'string' && item.trim())) return true;
  return false;
}

function resolveDupeSuggestionModes({ candidateCount = 0, profileSummary = null } = {}) {
  const profileMode = hasMeaningfulProfileSummary(profileSummary) ? 'personalized' : 'anchor_only';
  return { recommendationMode: 'pool_only', profileMode };
}

function buildSourceHitCounts(poolMetaRaw, items) {
  const poolMeta = poolMetaRaw && typeof poolMetaRaw === 'object' && !Array.isArray(poolMetaRaw) ? poolMetaRaw : {};
  const out = {
    catalog_search: Number.isFinite(Number(poolMeta.source_hit_counts && poolMeta.source_hit_counts.catalog_search))
      ? Math.max(0, Math.trunc(Number(poolMeta.source_hit_counts.catalog_search)))
      : 0,
    product_embedded: Number.isFinite(Number(poolMeta.source_hit_counts && poolMeta.source_hit_counts.product_embedded))
      ? Math.max(0, Math.trunc(Number(poolMeta.source_hit_counts.product_embedded)))
      : 0,
    open_world_fallback: 0,
  };
  for (const item of Array.isArray(items) ? items : []) {
    const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
    if (origin === 'open_world') out.open_world_fallback += 1;
  }
  return out;
}

function buildFinalSourceMix(items, recommendationMode) {
  const sourceMix = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
    if (origin === 'open_world') sourceMix.add('open_world');
    if (origin === 'catalog') sourceMix.add('catalog');
  }
  if (!sourceMix.size && recommendationMode === 'open_world_only') sourceMix.add('open_world');
  return Array.from(sourceMix);
}

function buildStableCandidateKey(item) {
  const identity = getCandidateIdentity(item);
  const productId = String(identity.product_id || '').trim().toLowerCase();
  if (productId) return `product:${productId}`;
  const skuId = String(identity.sku_id || '').trim().toLowerCase();
  if (skuId) return `sku:${skuId}`;
  const url = String(identity.url || '').trim().toLowerCase();
  if (url) return `url:${url}`;
  const brand = String(identity.brand || '').trim().toLowerCase();
  const name = String(identity.name || '').trim().toLowerCase();
  if (brand || name) return `name:${brand}::${name}`;
  return '';
}

function normalizeTextToken(value) {
  return String(value || '').trim().toLowerCase();
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function extractDupePoolActiveThemesFromText(...values) {
  const joined = values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!joined) return [];
  const out = [];
  for (const rule of DUPE_POOL_ACTIVE_THEME_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(joined))) out.push(rule.key);
  }
  return uniqStrings(out);
}

function computeArrayOverlap(left, right) {
  const leftTokens = uniqStrings(left).map((value) => normalizeTextToken(value)).filter(Boolean);
  const rightSet = new Set(uniqStrings(right).map((value) => normalizeTextToken(value)).filter(Boolean));
  if (!leftTokens.length || !rightSet.size) return 0;
  let hits = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) hits += 1;
  }
  return hits / Math.max(1, leftTokens.length);
}

function tokenizePoolCandidateText(...values) {
  return String(
    values
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' '),
  )
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function buildPoolFallbackAnchorContext({ original = null, inputText = '' } = {}) {
  const anchor = original && typeof original === 'object' && !Array.isArray(original) ? original : {};
  const brand = String(anchor.brand || '').trim();
  const name = String(anchor.display_name || anchor.name || anchor.product_name || '').trim();
  const category = String(anchor.category || anchor.product_type || anchor.type || '').trim();
  const usageRole = inferDupePoolUsageRole(name, category, inputText);
  const label = [brand, name].filter(Boolean).join(' ').trim();
  const activeThemes = extractDupePoolActiveThemesFromText(
    name,
    category,
    inputText,
    anchor.ingredients,
    anchor.hero_ingredients,
    anchor.known_actives,
    anchor.claims,
  );
  return {
    label,
    brand,
    name,
    category,
    usageRole,
    activeThemes,
    textTokens: tokenizePoolCandidateText(label, inputText),
  };
}

function classifyPoolFallbackDropReason(row, anchorIdentity, anchorFingerprint, anchorContext) {
  const candidate = row && typeof row === 'object' && !Array.isArray(row) ? row : null;
  if (!candidate) return 'invalid_candidate';
  const candidateName = String(candidate.name || candidate.display_name || candidate.displayName || '').trim();
  const candidateUrl = String(candidate.pdp_url || candidate.url || '').trim() || null;
  const candidateIdentity = {
    product_id: candidate.product_id || candidate.sku_id || null,
    sku_id: candidate.sku_id || candidate.product_id || null,
    brand: candidate.brand || null,
    name: candidateName || null,
    display_name: candidateName || null,
    url: candidateUrl,
    category: candidate.category || null,
  };
  const selfRef = detectSelfReference(candidateIdentity, anchorIdentity, anchorFingerprint);
  if (selfRef.isSelfRef) return 'self_ref_filtered';
  if (hasSyntheticRecommendationSuffix(candidateName)) return 'synthetic_candidates_removed';
  const productLabel = [candidate.brand, candidateName].filter(Boolean).join(' ').trim();
  if (!productLabel) return 'missing_identity';
  const activeThemes = extractDupePoolActiveThemesFromText(candidateName, candidate.category, candidate.signals);
  const usageRole = inferDupePoolUsageRole(candidate.category, candidateName, candidate.signals);
  if (anchorContext.activeThemes.length && !computeArrayOverlap(anchorContext.activeThemes, activeThemes) && usageRole !== anchorContext.usageRole && normalizeTextToken(candidate.category) !== normalizeTextToken(anchorContext.category)) {
    return 'backend_hits_role_mismatch_filtered';
  }
  return null;
}

function buildPoolRankFallbackAlternatives(poolCandidates, anchorOriginal, { inputText = '', maxTotal = 3 } = {}) {
  const anchorContext = buildPoolFallbackAnchorContext({ original: anchorOriginal, inputText });
  const anchorIdentity = buildAnchorIdentity(anchorOriginal);
  const anchorFingerprint = buildAnchorFingerprint(anchorOriginal);
  const dropReasons = {
    self_ref_filtered: 0,
    synthetic_candidates_removed: 0,
    missing_identity: 0,
    backend_hits_role_mismatch_filtered: 0,
  };
  const scored = [];

  for (const row of Array.isArray(poolCandidates) ? poolCandidates : []) {
    const candidate = row && typeof row === 'object' && !Array.isArray(row) ? row : null;
    if (!candidate) continue;
    const dropReason = classifyPoolFallbackDropReason(candidate, anchorIdentity, anchorFingerprint, anchorContext);
    if (dropReason) {
      dropReasons[dropReason] = (dropReasons[dropReason] || 0) + 1;
      continue;
    }
    const candidateName = String(candidate.name || candidate.display_name || candidate.displayName || '').trim();
    const candidateRole = inferDupePoolUsageRole(candidate.category, candidateName, candidate.signals);
    const candidateThemes = extractDupePoolActiveThemesFromText(candidateName, candidate.category, candidate.signals);
    const candidateTokens = tokenizePoolCandidateText(candidate.brand, candidateName, candidate.category, candidate.signals);
    const activeOverlap = computeArrayOverlap(anchorContext.activeThemes, candidateThemes);
    const roleExact = anchorContext.usageRole && anchorContext.usageRole !== 'unknown' && candidateRole === anchorContext.usageRole ? 1 : 0;
    const categoryExact = normalizeTextToken(candidate.category) && normalizeTextToken(candidate.category) === normalizeTextToken(anchorContext.category) ? 1 : 0;
    const nameTokenOverlap = computeArrayOverlap(anchorContext.textTokens, candidateTokens);
    const canonicalRefBonus = candidate.product_id || candidate.sku_id || candidate.pdp_url ? 0.14 : 0;
    const upstreamSimilarityRaw = Number(candidate.similarity_score);
    const upstreamSimilarity = Number.isFinite(upstreamSimilarityRaw)
      ? Math.max(0, Math.min(1, upstreamSimilarityRaw > 1 ? upstreamSimilarityRaw / 100 : upstreamSimilarityRaw))
      : 0;
    const score = (
      activeOverlap * 0.42 +
      roleExact * 0.24 +
      categoryExact * 0.16 +
      nameTokenOverlap * 0.08 +
      upstreamSimilarity * 0.1 +
      canonicalRefBonus
    );
    if (score < 0.34) {
      dropReasons.backend_hits_role_mismatch_filtered += 1;
      continue;
    }
    scored.push({
      row: candidate,
      score,
      activeOverlap,
      roleExact,
      categoryExact,
      candidateRole,
      candidateThemes,
    });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return String(left.row.name || '').localeCompare(String(right.row.name || ''));
  });

  const out = [];
  const seen = new Set();
  for (const entry of scored) {
    const row = entry.row;
    const rowName = String(row.name || row.display_name || row.displayName || '').trim();
    const rowUrl = String(row.pdp_url || row.url || '').trim();
    const key = buildStableCandidateKey({
      product: {
        product_id: row.product_id || null,
        sku_id: row.sku_id || null,
        brand: row.brand || null,
        name: rowName || null,
        url: rowUrl || null,
      },
    });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const productType = String(row.category || '').trim() || null;
    const productLabel = [row.brand, rowName].filter(Boolean).join(' ').trim();
    const overlapTheme = entry.candidateThemes.find((theme) => anchorContext.activeThemes.includes(theme)) || anchorContext.activeThemes[0] || '';
    const reasons = [];
    if (entry.activeOverlap > 0 && overlapTheme) reasons.push(`Matches the anchor's ${overlapTheme.replace(/_/g, ' ')} theme in the Pivota product pool.`);
    else if (entry.roleExact && anchorContext.usageRole && anchorContext.usageRole !== 'unknown') reasons.push(`Same ${anchorContext.usageRole} step in the Pivota product pool.`);
    else if (entry.categoryExact && anchorContext.category) reasons.push(`Same ${anchorContext.category} category in the Pivota product pool.`);
    if (!reasons.length) reasons.push('Close catalog match from the Pivota product pool.');

    const tradeoffs = [];
    if (entry.activeOverlap > 0 && entry.activeOverlap < 1) tradeoffs.push('Active-theme overlap is partial rather than exact.');
    else if (entry.activeOverlap === 0) tradeoffs.push('Formula overlap remains uncertain.');
    if (tradeoffs.length === 0 && row.signals && row.signals.length) {
      tradeoffs.push('Catalog text supports a compare, but exact formula detail remains uncertain.');
    }
    const similarity = Math.max(56, Math.min(92, Math.round(entry.score * 100)));
    const confidence = Math.max(0.28, Math.min(0.82, Number((entry.score * 0.9).toFixed(2))));
    out.push({
      kind: entry.activeOverlap > 0 && entry.roleExact ? 'dupe' : 'similar',
      candidate_origin: 'catalog',
      grounding_status: 'catalog_verified',
      ranking_mode: 'pool_rank_fallback',
      product: {
        ...(row.product_id ? { product_id: row.product_id } : {}),
        ...(row.sku_id ? { sku_id: row.sku_id } : {}),
        ...(row.brand ? { brand: row.brand } : {}),
        ...(rowName ? { name: rowName } : {}),
        ...(productType ? { category: productType } : {}),
        ...(rowUrl ? { url: rowUrl, pdp_url: rowUrl } : {}),
        ...(row.price && typeof row.price === 'object' ? { price: row.price } : {}),
      },
      ...(row.brand ? { brand: row.brand } : {}),
      ...(rowName ? { name: rowName } : {}),
      similarity,
      confidence,
      reasons,
      tradeoffs,
      evidence: {
        confidence,
        missing_info: entry.activeOverlap > 0 ? [] : ['formula_overlap_uncertain'],
      },
      missing_info: entry.activeOverlap > 0 ? [] : ['formula_overlap_uncertain'],
      pdp_open: {
        path: rowUrl ? 'external' : 'resolve',
        ...(rowUrl ? { external: { url: rowUrl, query: productLabel } } : { external: { query: productLabel } }),
      },
      metadata: {
        compare_stage: 'pool_rank_fallback',
        raw_similarity_score: Number(entry.score.toFixed(3)),
      },
    });
    if (out.length >= Math.max(1, Math.min(3, Number(maxTotal) || 3))) break;
  }

  return {
    alternatives: out,
    dropReasons,
  };
}

function normalizePoolSelectorAlternative(item) {
  const row = item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : null;
  if (!row) return null;
  const product = row.product && typeof row.product === 'object' && !Array.isArray(row.product)
    ? { ...row.product }
    : {};
  const productBrand = String(product.brand || row.brand || '').trim();
  const productName = String(product.name || row.name || row.display_name || row.product_name || '').trim();
  const productCategory = String(product.category || row.category || row.product_type || '').trim();
  const productUrl = String(product.url || product.pdp_url || row.url || row.pdp_url || '').trim();
  row.product = {
    ...product,
    ...(productBrand ? { brand: productBrand } : {}),
    ...(productName ? { name: productName } : {}),
    ...(productCategory ? { category: productCategory } : {}),
    ...(productUrl ? { url: productUrl, pdp_url: productUrl } : {}),
  };
  if (productBrand && !row.brand) row.brand = productBrand;
  if (productName && !row.name) row.name = productName;
  if (!String(row.candidate_origin || '').trim()) row.candidate_origin = 'catalog';
  if (!String(row.grounding_status || '').trim()) row.grounding_status = 'catalog_verified';
  if (!String(row.ranking_mode || '').trim()) row.ranking_mode = 'pool_selector';
  return row;
}

function scoreResolvedDupeCandidate(item, anchorOriginal, { inputText = '' } = {}) {
  const row = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  if (!row) return 0;
  const anchorContext = buildPoolFallbackAnchorContext({ original: anchorOriginal, inputText });
  const brand = String(
    (row.product && row.product.brand) || row.brand || '',
  ).trim();
  const name = String(
    (row.product && row.product.name) || row.name || '',
  ).trim();
  const category = String(
    (row.product && row.product.category) || row.category || row.product_type || '',
  ).trim();
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  const tradeoffs = Array.isArray(row.tradeoffs) ? row.tradeoffs : [];
  const sourceText = [brand, name, category, reasons.join(' '), tradeoffs.join(' ')].join(' ');
  const candidateThemes = extractDupePoolActiveThemesFromText(sourceText);
  const overlapCount = anchorContext.activeThemes.filter((theme) => candidateThemes.includes(theme)).length;
  const activeRecall = anchorContext.activeThemes.length ? overlapCount / anchorContext.activeThemes.length : 0;
  const activePrecision = candidateThemes.length ? overlapCount / candidateThemes.length : 0;
  const candidateRole = inferDupePoolUsageRole(category, name, reasons, tradeoffs);
  const roleExact = anchorContext.usageRole && anchorContext.usageRole !== 'unknown' && candidateRole === anchorContext.usageRole ? 1 : 0;
  const categoryExact = normalizeTextToken(category) && normalizeTextToken(category) === normalizeTextToken(anchorContext.category) ? 1 : 0;
  const similarity = Number(row.similarity);
  const confidence = Number(row.confidence);
  const normalizedSimilarity = Number.isFinite(similarity) ? clamp01(similarity > 1 ? similarity / 100 : similarity) : 0;
  const normalizedConfidence = Number.isFinite(confidence) ? clamp01(confidence) : 0;
  return (
    activeRecall * 0.34 +
    activePrecision * 0.22 +
    roleExact * 0.18 +
    categoryExact * 0.1 +
    normalizedSimilarity * 0.1 +
    normalizedConfidence * 0.06
  );
}

function mergePoolSelectorWithFallback(selectorItems, fallbackItems, anchorOriginal, { inputText = '', limit = 3 } = {}) {
  const maxItems = Math.max(1, Math.min(6, Number(limit) || 3));
  const combined = [];
  for (const item of Array.isArray(selectorItems) ? selectorItems : []) {
    const normalized = normalizePoolSelectorAlternative(item);
    if (normalized) combined.push(normalized);
  }
  for (const item of Array.isArray(fallbackItems) ? fallbackItems : []) {
    if (item && typeof item === 'object') combined.push(item);
  }
  const deduped = [];
  const seen = new Set();
  for (const item of combined) {
    const key = buildStableCandidateKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  deduped.sort((left, right) => {
    const scoreDiff = scoreResolvedDupeCandidate(right, anchorOriginal, { inputText }) - scoreResolvedDupeCandidate(left, anchorOriginal, { inputText });
    if (scoreDiff !== 0) return scoreDiff;
    const rightOrigin = String(right.candidate_origin || '').trim().toLowerCase();
    const leftOrigin = String(left.candidate_origin || '').trim().toLowerCase();
    if (leftOrigin !== rightOrigin) {
      if (leftOrigin === 'catalog') return -1;
      if (rightOrigin === 'catalog') return 1;
    }
    return String((left.product && left.product.name) || left.name || '').localeCompare(String((right.product && right.product.name) || right.name || ''));
  });
  return deduped.slice(0, maxItems);
}

function inferDupePoolUsageRole(...values) {
  const text = values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return 'unknown';
  if (/\bspf\b|sunscreen|sun screen|uv|sunblock|防晒/.test(text)) return 'sunscreen';
  if (/cleanser|face wash|washing foam|cleansing|洁面|洗面/.test(text)) return 'cleanser';
  if (/toner|lotion toner|化妆水|爽肤水/.test(text)) return 'toner';
  if (/essence|精华水|精华液/.test(text)) return 'essence';
  if (/serum|ampoule|booster|精华/.test(text)) return 'serum';
  if (/moisturizer|moisturiser|cream|lotion|gel cream|face cream|乳液|面霜/.test(text)) return 'moisturizer';
  if (/retinol|retinal|acid|bha|aha|treatment|spot|exfoliat|修护精华|祛痘/.test(text)) return 'treatment';
  if (/mask|sleeping mask|面膜/.test(text)) return 'mask';
  if (/\boil\b|facial oil|精油/.test(text)) return 'oil';
  return 'unknown';
}

function scorePoolCandidateForSelector(row, anchorContext = {}) {
  const candidate = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  const anchorRole = normalizeTextToken(anchorContext.usageRole);
  const candidateRole = inferDupePoolUsageRole(
    candidate.category,
    candidate.product_type,
    candidate.type,
    candidate.display_name,
    candidate.name,
  );
  const anchorCategory = normalizeTextToken(anchorContext.category);
  const candidateCategory = normalizeTextToken(candidate.category || candidate.product_type || candidate.type);
  const similarity = Number(candidate.similarity_score ?? candidate.similarity ?? 0);
  const normalizedSimilarity = Number.isFinite(similarity)
    ? Math.max(0, Math.min(1, similarity > 1 ? similarity / 100 : similarity))
    : 0;
  const hasStableRef = Boolean(String(candidate.product_id || candidate.sku_id || candidate.url || candidate.pdp_url || '').trim());
  const source = normalizeTextToken(candidate._pool_source || candidate.retrieval_source);
  let score = 0;
  if (anchorRole && anchorRole !== 'unknown' && candidateRole === anchorRole) score += 4;
  else if (candidateRole !== 'unknown') score += 1;
  if (anchorCategory && candidateCategory && anchorCategory === candidateCategory) score += 3;
  score += normalizedSimilarity * 3;
  if (hasStableRef) score += 1.5;
  if (source === 'product_embedded') score += 1.25;
  else if (source === 'catalog_search') score += 0.75;
  return score;
}

function sumReasonCounts(mapLike) {
  const source = mapLike && typeof mapLike === 'object' && !Array.isArray(mapLike) ? mapLike : {};
  return Object.values(source).reduce((sum, value) => (
    Number.isFinite(Number(value)) ? sum + Math.max(0, Math.trunc(Number(value))) : sum
  ), 0);
}

function isDeterministicWeakAnchorEmpty({ hasResults = false, terminalEmptyReason = '', sourceMeta = null } = {}) {
  if (hasResults) return false;
  if (String(terminalEmptyReason || '').trim() === 'anchor_signal_insufficient_for_open_world') return true;
  const meta = sourceMeta && typeof sourceMeta === 'object' && !Array.isArray(sourceMeta) ? sourceMeta : {};
  return String(meta.final_empty_reason || '').trim() === 'anchor_signal_insufficient_for_open_world';
}

function buildEmptyRawOutputSummary() {
  return {
    raw_output_item_count: 0,
    raw_items_with_product_object: 0,
    raw_items_with_nested_brand_name: 0,
    raw_items_with_flat_brand_name: 0,
    raw_items_with_tradeoffs_object: 0,
    raw_preview: [],
  };
}

function buildRecommendationPassTrace(pass, { fallbackTemplateId = null } = {}) {
  const upstreamOut = pass && typeof pass === 'object' ? (pass.upstreamOut || {}) : {};
  const llmTrace = upstreamOut && typeof upstreamOut.llm_trace === 'object' && !Array.isArray(upstreamOut.llm_trace)
    ? upstreamOut.llm_trace
    : {};
  const upstreamStatusRaw = llmTrace.upstream_status;
  const rawSummary = upstreamOut && typeof upstreamOut.raw_output_summary === 'object' && !Array.isArray(upstreamOut.raw_output_summary)
    ? upstreamOut.raw_output_summary
    : buildEmptyRawOutputSummary();
  const mapped = Array.isArray(pass && pass.mapped) ? pass.mapped : [];
  const liveEvaluation = pass && pass.liveEvaluation && typeof pass.liveEvaluation === 'object'
    ? pass.liveEvaluation
    : {};
  return {
    recommendation_mode: String(pass && pass.recommendationMode || '').trim() || null,
    template_id: String(upstreamOut.template_id || fallbackTemplateId || '').trim() || null,
    source_mode: String(llmTrace.source_mode || upstreamOut.source_mode || '').trim() || null,
    fallback_source: String(upstreamOut.fallback_source || '').trim() || null,
    failure_class: String(upstreamOut.failure_class || '').trim() || null,
    llm_error_class: String(llmTrace.error_class || '').trim() || null,
    provider_reason: String(llmTrace.provider_reason || '').trim() || null,
    provider_detail: String(llmTrace.provider_detail || '').trim() || null,
    provider_route: String(llmTrace.provider_route || '').trim() || null,
    provider_model: String(llmTrace.provider_model || '').trim() || null,
    provider_timeout_stage: String(llmTrace.provider_timeout_stage || '').trim() || null,
    provider_result_reason: String(llmTrace.provider_result_reason || '').trim() || null,
    finish_reason: String(llmTrace.finish_reason || '').trim() || null,
    parse_status: String(llmTrace.parse_status || '').trim() || null,
    provider_total_ms: Number.isFinite(Number(llmTrace.provider_total_ms))
      ? Math.max(0, Math.trunc(Number(llmTrace.provider_total_ms)))
      : null,
    provider_upstream_ms: Number.isFinite(Number(llmTrace.provider_upstream_ms))
      ? Math.max(0, Math.trunc(Number(llmTrace.provider_upstream_ms)))
      : null,
    upstream_status: (upstreamStatusRaw === null || upstreamStatusRaw === undefined || upstreamStatusRaw === '')
      ? null
      : Number.isFinite(Number(upstreamStatusRaw))
      ? Math.trunc(Number(upstreamStatusRaw))
      : null,
    upstream_error_code: String(llmTrace.upstream_error_code || '').trim() || null,
    upstream_error_message: String(llmTrace.upstream_error_message || '').trim() || null,
    no_result_reason: String(upstreamOut.no_result_reason || '').trim() || null,
    candidate_pool_size: Number.isFinite(Number(pass && pass.candidatePoolSize))
      ? Math.max(0, Math.trunc(Number(pass.candidatePoolSize)))
      : 0,
    selector_input_count: Number.isFinite(Number(upstreamOut && upstreamOut.selector_meta && upstreamOut.selector_meta.input_count))
      ? Math.max(0, Math.trunc(Number(upstreamOut.selector_meta.input_count)))
      : 0,
    selector_timeout_ms: Number.isFinite(Number(upstreamOut && upstreamOut.selector_meta && upstreamOut.selector_meta.timeout_ms))
      ? Math.max(0, Math.trunc(Number(upstreamOut.selector_meta.timeout_ms)))
      : 0,
    pool_rank_fallback_used: upstreamOut && upstreamOut.selector_meta && upstreamOut.selector_meta.local_rank_fallback_used === true,
    duration_ms: Number.isFinite(Number(pass && pass.durationMs))
      ? Math.max(0, Math.trunc(Number(pass.durationMs)))
      : 0,
    raw_output_item_count: Number.isFinite(Number(rawSummary.raw_output_item_count))
      ? Math.max(0, Math.trunc(Number(rawSummary.raw_output_item_count)))
      : 0,
    mapped_output_item_count: mapped.length,
    raw_items_with_product_object: Number.isFinite(Number(rawSummary.raw_items_with_product_object))
      ? Math.max(0, Math.trunc(Number(rawSummary.raw_items_with_product_object)))
      : 0,
    raw_items_with_nested_brand_name: Number.isFinite(Number(rawSummary.raw_items_with_nested_brand_name))
      ? Math.max(0, Math.trunc(Number(rawSummary.raw_items_with_nested_brand_name)))
      : 0,
    raw_items_with_flat_brand_name: Number.isFinite(Number(rawSummary.raw_items_with_flat_brand_name))
      ? Math.max(0, Math.trunc(Number(rawSummary.raw_items_with_flat_brand_name)))
      : 0,
    raw_items_with_tradeoffs_object: Number.isFinite(Number(rawSummary.raw_items_with_tradeoffs_object))
      ? Math.max(0, Math.trunc(Number(rawSummary.raw_items_with_tradeoffs_object)))
      : 0,
    raw_preview: Array.isArray(rawSummary.raw_preview) ? rawSummary.raw_preview.slice(0, 3) : [],
    field_missing_reasons: summarizeFieldMissingReasons(upstreamOut.field_missing),
    failure_reasons: uniqStrings(Array.isArray(liveEvaluation.failureReasons) ? liveEvaluation.failureReasons : []),
  };
}

function mergeRankedItems(primaryItems, secondaryItems, { limit = 3 } = {}) {
  const out = [];
  const seen = new Set();
  const maxItems = Math.max(0, Math.trunc(Number(limit) || 0));
  const pushOne = (item) => {
    const key = buildStableCandidateKey(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  for (const item of Array.isArray(primaryItems) ? primaryItems : []) {
    pushOne(item);
    if (out.length >= maxItems) return out.slice(0, maxItems);
  }
  for (const item of Array.isArray(secondaryItems) ? secondaryItems : []) {
    pushOne(item);
    if (out.length >= maxItems) break;
  }
  return out.slice(0, maxItems);
}

function buildTerminalEmptyReason({ poolResult, poolPass, openWorldPass, finalLiveEvaluation, profileMode } = {}) {
  const liveEvaluation = finalLiveEvaluation && typeof finalLiveEvaluation === 'object' ? finalLiveEvaluation : {};
  const failureReasons = Array.isArray(liveEvaluation.failureReasons) ? liveEvaluation.failureReasons : [];
  const onlySelfOrPlaceholder = failureReasons.length > 0 && failureReasons.every((reason) => (
    reason === 'self_ref_filtered' ||
    reason === 'placeholder_candidates_removed' ||
    reason === 'synthetic_candidates_removed' ||
    reason === 'missing_identity'
  ));
  if (onlySelfOrPlaceholder) return 'all_candidates_filtered_as_self_or_placeholder';

  const openWorldNoResultReason = String(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.no_result_reason || '').trim();
  if (openWorldNoResultReason === 'anchor_signal_insufficient_for_open_world') {
    return 'anchor_signal_insufficient_for_open_world';
  }

  const poolNoResultReason = String(poolPass && poolPass.upstreamOut && poolPass.upstreamOut.no_result_reason || '').trim();
  if (poolNoResultReason === 'pool_rank_fallback_exhausted') return 'pool_rank_fallback_exhausted';

  const poolFailureClass = String(poolPass && poolPass.upstreamOut && poolPass.upstreamOut.failure_class || '').trim();
  if (poolFailureClass === 'timeout') return 'pool_selector_timeout';

  const poolMeta = poolResult && poolResult.meta && typeof poolResult.meta === 'object' && !Array.isArray(poolResult.meta)
    ? poolResult.meta
    : {};
  const poolCount = Number.isFinite(Number(poolMeta.count)) ? Math.max(0, Math.trunc(Number(poolMeta.count))) : 0;
  const filterDrops = sumReasonCounts(poolMeta.pool_filter_drop_reasons);
  if (poolCount === 0 && filterDrops === 0) return 'backend_zero_hits';
  if (poolCount === 0 && filterDrops > 0) return 'backend_hits_all_filtered';

  if (poolFailureClass === 'empty_structured') return 'pool_selector_empty_structured';

  const openWorldFailureClass = String(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.failure_class || '').trim();
  if (openWorldFailureClass === 'empty_structured') return 'open_world_empty_structured';

  if (profileMode === 'personalized' && openWorldNoResultReason === 'all_candidates_conflict_with_profile') {
    return 'all_candidates_conflict_with_profile';
  }
  return 'open_world_empty_structured';
}

function hasUsableAnchorIdentity({ anchorId = '', originalObj = null, originalUrl = '', inputText = '' } = {}) {
  if (String(anchorId || '').trim()) return true;
  if (String(originalUrl || '').trim()) return true;
  const productIdentity = buildProductInputText(originalObj, null);
  if (String(productIdentity || '').trim()) return true;
  return Boolean(String(inputText || '').trim());
}

function getItemMissingInfoCodes(item) {
  const row = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  const evidence = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {};
  return uniqStrings([...(Array.isArray(row.missing_info) ? row.missing_info : []), ...(Array.isArray(evidence.missing_info) ? evidence.missing_info : [])]).map((code) => code.toLowerCase());
}

function hasMeaningfulReasons(item) {
  const reasons = Array.isArray(item && item.reasons) ? item.reasons : [];
  return reasons.some((entry) => {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (!text) return false;
    return !PLACEHOLDER_REASON_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function hasMinimumComparableIdentity(item) {
  const identity = getCandidateIdentity(item);
  const origin = String(item && typeof item === 'object' ? item.candidate_origin : '').trim().toLowerCase();
  const hasName = Boolean(String(identity.name || '').trim());
  const hasBrand = Boolean(String(identity.brand || '').trim());
  const hasCanonicalRef = Boolean(String(identity.product_id || '').trim() || String(identity.url || '').trim());
  if (!hasName) return false;
  if (hasCanonicalRef) return true;
  if (origin === 'open_world') return hasBrand && hasName;
  return hasName;
}

function isLegacySyntheticCandidate(item) {
  const identity = getCandidateIdentity(item);
  const missingCodes = getItemMissingInfoCodes(item);
  if (missingCodes.includes('local_fallback_seed')) return true;
  const hasCanonicalRef = Boolean(String(identity.product_id || '').trim() || String(identity.url || '').trim());
  return Boolean(!hasCanonicalRef && hasSyntheticRecommendationSuffix(identity.name || ''));
}

function isPlaceholderLikeCandidate(item) {
  const hasReasons = hasMeaningfulReasons(item);
  const hasTradeoffs = hasMeaningfulTradeoffs(item);
  const sim = Number(item && item.similarity);
  const conf = Number(item && item.confidence);
  const hasSignal = (Number.isFinite(sim) && sim > 0) || (Number.isFinite(conf) && conf > 0);
  return !hasReasons && !hasTradeoffs && !hasSignal;
}

function evaluateDupeCandidates(items, anchor, { maxDupes = 3, maxComparables = 2 } = {}) {
  const sanitizeResult = sanitizeCandidates(items);
  const selfRefResult = filterSelfReferences(sanitizeResult.sanitized, anchor);
  const dedupeResult = deduplicateCandidates(selfRefResult.kept);

  const afterIdentity = dedupeResult.deduplicated.filter((item) => hasMinimumComparableIdentity(item));
  const afterSynthetic = afterIdentity.filter((item) => !isLegacySyntheticCandidate(item));
  const viableItems = afterSynthetic.filter((item) => {
    const missingCodes = getItemMissingInfoCodes(item);
    const hasReasons = hasMeaningfulReasons(item);
    const hasTradeoffs = hasMeaningfulTradeoffs(item);
    const hollow = isHollowItem(item);
    if (hollow) return false;
    if (!hasReasons && !hasTradeoffs && missingCodes.includes('tradeoffs_detail_missing')) return false;
    return true;
  });

  const kindOf = (row) => String(row && typeof row === 'object' ? row.kind : '').trim().toLowerCase();
  const dupes = viableItems.filter((item) => kindOf(item) === 'dupe').slice(0, maxDupes);
  const comparables = viableItems.filter((item) => kindOf(item) !== 'dupe').slice(0, maxComparables);
  const finalItems = [...dupes, ...comparables];
  const viable = finalItems.length > 0;
  const failureReasons = [];

  if (!viable) {
    if (selfRefResult.stats.self_ref_dropped_count > 0 && viableItems.length === 0) failureReasons.push('self_ref_filtered');
    if (sanitizeResult.issues.some((issue) => String(issue && issue.code || '').toUpperCase() === 'NAME_IS_URL')) {
      failureReasons.push('name_url_sanitized');
    }
    if (dedupeResult.duplicateIssues.length > 0) failureReasons.push('duplicate_candidates_removed');
    if (afterIdentity.length < dedupeResult.deduplicated.length) failureReasons.push('missing_identity');
    if (afterSynthetic.length < afterIdentity.length) failureReasons.push('synthetic_candidates_removed');
    if (afterSynthetic.length > 0 && afterSynthetic.every((item) => isHollowItem(item))) failureReasons.push('all_items_hollow');
    if (afterSynthetic.length > 0 && afterSynthetic.every((item) => !hasMeaningfulReasons(item) && !hasMeaningfulTradeoffs(item))) {
      failureReasons.push('placeholder_only');
    }
  }

  return {
    dupes,
    comparables,
    finalItems,
    viable,
    hasMeaningfulQuality: viable,
    rawCount: Array.isArray(items) ? items.length : 0,
    candidateCountAfterSanitize: sanitizeResult.sanitized.length,
    candidateCountAfterSelfRef: selfRefResult.kept.length,
    candidateCountAfterDedupe: dedupeResult.deduplicated.length,
    candidateCountAfterIdentity: afterIdentity.length,
    candidateCountAfterSynthetic: afterSynthetic.length,
    candidateCountAfterViability: viableItems.length,
    selfRefDroppedCount: selfRefResult.stats.self_ref_dropped_count,
    failureReasons: uniqStrings(failureReasons),
  };
}

function evaluateLiveDupeCandidates(items, anchor, { maxDupes = 3, maxComparables = 2 } = {}) {
  const sanitizeResult = sanitizeCandidates(items);
  const selfRefResult = filterSelfReferences(sanitizeResult.sanitized, anchor);
  const dedupeResult = deduplicateCandidates(selfRefResult.kept);

  const afterIdentity = dedupeResult.deduplicated.filter((item) => hasMinimumComparableIdentity(item));
  const afterSynthetic = afterIdentity.filter((item) => !isLegacySyntheticCandidate(item));
  const afterPlaceholder = afterSynthetic.filter((item) => !isPlaceholderLikeCandidate(item));

  const kindOf = (row) => String(row && typeof row === 'object' ? row.kind : '').trim().toLowerCase();
  const dupes = afterPlaceholder.filter((item) => kindOf(item) === 'dupe').slice(0, maxDupes);
  const comparables = afterPlaceholder.filter((item) => kindOf(item) !== 'dupe').slice(0, maxComparables);
  const finalItems = [...dupes, ...comparables];
  const viable = finalItems.length > 0;
  const failureReasons = [];

  if (!viable) {
    if (selfRefResult.stats.self_ref_dropped_count > 0) failureReasons.push('self_ref_filtered');
    if (sanitizeResult.issues.some((issue) => String(issue && issue.code || '').toUpperCase() === 'NAME_IS_URL')) {
      failureReasons.push('name_url_sanitized');
    }
    if (dedupeResult.duplicateIssues.length > 0) failureReasons.push('duplicate_candidates_removed');
    if (afterIdentity.length < dedupeResult.deduplicated.length) failureReasons.push('missing_identity');
    if (afterSynthetic.length < afterIdentity.length) failureReasons.push('synthetic_candidates_removed');
    if (afterPlaceholder.length < afterSynthetic.length) failureReasons.push('placeholder_candidates_removed');
  }

  const hasMeaningfulQuality = finalItems.some((item) => {
    if (hasMeaningfulTradeoffs(item)) return true;
    if (hasMeaningfulReasons(item)) return true;
    const sim = Number(item && item.similarity);
    if (Number.isFinite(sim) && sim > 0) return true;
    const conf = Number(item && item.confidence);
    return Number.isFinite(conf) && conf > 0;
  });

  return {
    dupes,
    comparables,
    finalItems,
    viable,
    hasMeaningfulQuality,
    rawCount: Array.isArray(items) ? items.length : 0,
    candidateCountAfterSanitize: sanitizeResult.sanitized.length,
    candidateCountAfterSelfRef: selfRefResult.kept.length,
    candidateCountAfterDedupe: dedupeResult.deduplicated.length,
    candidateCountAfterIdentity: afterIdentity.length,
    candidateCountAfterSynthetic: afterSynthetic.length,
    candidateCountAfterPlaceholder: afterPlaceholder.length,
    candidateCountAfterViability: finalItems.length,
    selfRefDroppedCount: selfRefResult.stats.self_ref_dropped_count,
    failureReasons: uniqStrings(failureReasons),
  };
}

function getKbSourceMeta(entry) {
  return entry && entry.source_meta && typeof entry.source_meta === 'object' && !Array.isArray(entry.source_meta)
    ? entry.source_meta
    : {};
}

function assessKbCompatibility(entry, resolvedOriginal, { maxDupes = 3, maxComparables = 2 } = {}) {
  const sourceMeta = getKbSourceMeta(entry);
  const items = [
    ...(Array.isArray(entry && entry.dupes) ? entry.dupes : []),
    ...(Array.isArray(entry && entry.comparables) ? entry.comparables : []),
  ];
  const evaluation = evaluateDupeCandidates(items, resolvedOriginal.original, { maxDupes, maxComparables });
  const contractVersion = String(sourceMeta.contract_version || '').trim();
  const deterministicEmpty = isDeterministicWeakAnchorEmpty({
    hasResults: items.length > 0,
    sourceMeta,
  });
  const compatible = contractVersion === DUPE_SUGGEST_KB_CONTRACT_VERSION
    && Boolean(String(sourceMeta.recommendation_mode || '').trim())
    && Boolean(String(sourceMeta.profile_mode || '').trim())
    && !items.some((item) => isLegacySyntheticCandidate(item))
    && (deterministicEmpty || items.length === 0 || evaluation.viable);
  return {
    compatible,
    sourceMeta,
    evaluation,
    contractVersion,
    deterministicEmpty,
  };
}

/**
 * Execute the full dupe_suggest orchestration.
 *
 * @param {object} options
 * @param {object} options.ctx              – request context (lang, request_id, trace_id, ...)
 * @param {object} options.input            – validated request body (DupeSuggestRequestSchema output)
 * @param {object} options.services         – async service dependencies (see below)
 * @param {object} [options.logger]         – optional pino-style logger
 * @param {object} [options.flags]          – feature flags / env vars
 *
 * services shape:
 *   getDupeKbEntry(key) → entry | null
 *   upsertDupeKbEntry(payload) → void
 *   normalizeDupeKbKey(raw) → string
 *   searchPivotaBackendProducts({ query, limit, ... }) → { ok, products }
 *   buildExternalSeedCompareSearchQueries({ productObj, productInput, lang }) → string[]
 *   buildRecoAlternativesCandidatePool({ sharedCandidates, productObj, anchorId, maxCandidates }) → array
 *   fetchRecoAlternativesForProduct({ ctx, ... }) → { alternatives, field_missing, source_mode, ... }
 *   auroraChat({ baseUrl, query, ... }) → upstream response
 *   buildContextPrefix(meta) → string
 *   getUpstreamStructuredOrJson(upstream) → object | null
 *   extractJsonObjectByKeys(text, keys) → object | null
 *
 * flags shape:
 *   AURORA_DECISION_BASE_URL: string
 *   DUPE_KB_ASYNC_BACKFILL_ENABLED: boolean
 *
 * Returns: { ok, payload, event_kind, status_code }
 */
async function executeDupeSuggest({ ctx, input, profileSummary = null, recentLogs = [], services, logger, flags = {} }) {
  const {
    getDupeKbEntry,
    upsertDupeKbEntry,
    purgeDupeKbEntriesByContractVersion,
    normalizeDupeKbKey,
    searchPivotaBackendProducts,
    buildExternalSeedCompareSearchQueries,
    buildRecoAlternativesCandidatePool,
    fetchRecoAlternativesForProduct,
    auroraChat,
    buildContextPrefix,
    getUpstreamStructuredOrJson,
    extractJsonObjectByKeys,
  } = services;

  if (!dupeKbContractPurgePromise) {
    dupeKbContractPurgePromise = (async () => {
      if (typeof purgeDupeKbEntriesByContractVersion !== 'function') return null;
      try {
        return await purgeDupeKbEntriesByContractVersion(DUPE_SUGGEST_KB_CONTRACT_VERSION);
      } catch (err) {
        logger?.warn?.(
          { err: err?.message || String(err), request_id: ctx?.request_id, trace_id: ctx?.trace_id },
          'aurora bff: dupe kb contract purge failed',
        );
        return null;
      }
    })();
  }
  await dupeKbContractPurgePromise;

  function buildDupeSuggestTestSeedCandidates({ inputText, productObj, maxCandidates = 16 } = {}) {
    const queryText = String(inputText || '').trim();
    const productName = String(
      productObj && typeof productObj === 'object' && !Array.isArray(productObj)
        ? (productObj.display_name || productObj.name || '')
        : '',
    ).trim();
    if (!/DUPE_SUGGEST_TEST/i.test(queryText) && !/DUPE_SUGGEST_TEST/i.test(productName)) return [];
    const baseName = productName || queryText || 'DUPE_SUGGEST_TEST Target Cleanser';
    return [
      {
        sku_id: 'mock_pool_dupe_1',
        product_id: 'mock_pool_dupe_1',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Dupe 1`,
        category: 'cleanser',
        price_usd: 18,
        url: 'https://mock.test/dupe-1',
      },
      {
        sku_id: 'mock_pool_dupe_2',
        product_id: 'mock_pool_dupe_2',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Dupe 2`,
        category: 'cleanser',
        price_usd: 16,
        url: 'https://mock.test/dupe-2',
      },
      {
        sku_id: 'mock_pool_similar_1',
        product_id: 'mock_pool_similar_1',
        brand: 'MockBrand',
        display_name: `${baseName} Mock Similar`,
        category: 'cleanser',
        price_usd: 24,
        url: 'https://mock.test/similar-1',
      },
    ].slice(0, Math.max(1, Math.min(6, Number(maxCandidates) || 3)));
  }

  async function buildDupeSuggestCandidatePool({ productObj, anchorId, inputText, originalUrl, logger: _logger, maxCandidates = 16 } = {}) {
    const sources = [];
    const allCandidates = [];
    const anchor = String(anchorId || '').trim().toLowerCase();
    const limit = Math.max(8, Math.min(30, maxCandidates));
    const selectorLimit = Math.max(1, Math.min(8, limit));
    const sourceHitCounts = {
      catalog_search: 0,
      product_embedded: 0,
    };
    const poolQueryHits = {};
    const poolFilterDropReasons = {
      missing_identity: 0,
      anchor_match: 0,
      duplicate: 0,
    };
    const product = productObj && typeof productObj === 'object' && !Array.isArray(productObj) ? productObj : {};
    const brandToken = String(product.brand || '').trim();
    const nameToken = String(product.display_name || product.name || '').trim();
    const categoryToken = String(product.category || product.product_type || product.type || '').trim();
    const usageRole = inferDupePoolUsageRole(categoryToken, nameToken);
    const fallbackQueries = [];
    if (brandToken && nameToken) fallbackQueries.push(`${brandToken} ${nameToken}`);
    if (categoryToken && brandToken) fallbackQueries.push(`${categoryToken} ${brandToken}`);
    if (categoryToken && !brandToken && nameToken) fallbackQueries.push(`${categoryToken} ${nameToken}`);
    const textQuery = String(inputText || '').trim();
    if (textQuery && !fallbackQueries.some((q) => q.toLowerCase() === textQuery.toLowerCase())) fallbackQueries.push(textQuery);
    const attemptedQueriesRaw = typeof buildExternalSeedCompareSearchQueries === 'function'
      ? buildExternalSeedCompareSearchQueries({
        productObj,
        productInput: inputText,
        lang: ctx?.lang || 'EN',
      })
      : fallbackQueries;
    const attemptedQueries = uniqStrings(attemptedQueriesRaw).slice(0, 6);

    for (const q of attemptedQueries) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await searchPivotaBackendProducts({
          query: q,
          limit: Math.ceil(limit / 2),
          logger: _logger,
          timeoutMs: 3000,
          mode: 'main_path',
          searchAllMerchants: true,
          allowExternalSeed: true,
          externalSeedStrategy: 'supplement_internal_first',
          fastMode: true,
        });
        const products = res && res.ok && Array.isArray(res.products) ? res.products : [];
        poolQueryHits[q] = products.length;
        if (products.length > 0) {
          sources.push('catalog_search');
          sourceHitCounts.catalog_search += products.length;
        }
        for (const p of products) {
          if (!p || typeof p !== 'object') continue;
          allCandidates.push({ ...p, _pool_source: 'catalog_search' });
        }
      } catch (err) {
        poolQueryHits[q] = 0;
        _logger?.warn({ err: err?.message, query: q }, 'dupe suggest: catalog search failed for pool');
      }
    }

    const embeddedPool = buildRecoAlternativesCandidatePool({ sharedCandidates: [], productObj, anchorId, maxCandidates: limit });
    if (embeddedPool.length > 0) {
      sources.push('product_embedded');
      sourceHitCounts.product_embedded += embeddedPool.length;
      for (const row of embeddedPool) {
        allCandidates.push({ ...(row || {}), _pool_source: 'product_embedded' });
      }
    }

    if (allCandidates.length === 0) {
      const testSeed = buildDupeSuggestTestSeedCandidates({ inputText, productObj, maxCandidates: limit });
      if (testSeed.length > 0) {
        sources.push('test_seed');
        for (const row of testSeed) allCandidates.push({ ...(row || {}), _pool_source: 'test_seed' });
      }
    }

    const seen = new Set();
    const deduped = [];
    const anchorLabels = uniqStrings([
      [product.brand, product.display_name || product.name].filter(Boolean).join(' '),
      product.display_name,
      product.name,
      inputText,
    ]).map((value) => normalizeTextToken(value));
    for (const row of allCandidates) {
      if (!row || typeof row !== 'object') continue;
      const key = String(
        row.sku_id
        || row.product_id
        || row.id
        || row.url
        || row.pdp_url
        || ([row.brand, row.display_name || row.name].filter(Boolean).join('::'))
        || row.name
        || '',
      ).trim().toLowerCase();
      if (!key) {
        poolFilterDropReasons.missing_identity += 1;
        continue;
      }
      const label = normalizeTextToken([row.brand, row.display_name || row.name].filter(Boolean).join(' '));
      if ((anchor && key === anchor) || (label && anchorLabels.includes(label))) {
        poolFilterDropReasons.anchor_match += 1;
        continue;
      }
      if (seen.has(key)) {
        poolFilterDropReasons.duplicate += 1;
        continue;
      }
      seen.add(key);
      deduped.push(row);
    }

    deduped.sort((left, right) => {
      const leftScore = scorePoolCandidateForSelector(left, { usageRole, category: categoryToken });
      const rightScore = scorePoolCandidateForSelector(right, { usageRole, category: categoryToken });
      if (rightScore !== leftScore) return rightScore - leftScore;
      return String(left.display_name || left.name || '').localeCompare(String(right.display_name || right.name || ''));
    });
    const selectorCandidates = deduped.slice(0, selectorLimit);
    const priceCoverage = deduped.filter((r) => {
      const p = r.price || r.price_usd || (r.pricing && r.pricing.price);
      return typeof p === 'number' && Number.isFinite(p) && p > 0;
    }).length;

    return {
      candidates: deduped.slice(0, limit),
      selector_candidates: selectorCandidates,
      meta: {
        count: deduped.length,
        selector_input_count: selectorCandidates.length,
        sources_used: Array.from(new Set(sources)),
        price_coverage_rate: deduped.length > 0 ? priceCoverage / deduped.length : 0,
        degraded: deduped.length < 3,
        attempted_queries: attemptedQueries,
        source_hit_counts: sourceHitCounts,
        pool_query_hits: poolQueryHits,
        pool_query_zero_hit_count: Object.values(poolQueryHits).filter((count) => Number(count) === 0).length,
        pool_filter_drop_reasons: poolFilterDropReasons,
      },
    };
  }

  const { AURORA_DECISION_BASE_URL, DUPE_KB_ASYNC_BACKFILL_ENABLED } = flags;

  const maxDupes = Math.max(1, Math.min(6, Number.isFinite(input.max_dupes) ? input.max_dupes : 3));
  const maxComparables = Math.max(1, Math.min(6, Number.isFinite(input.max_comparables) ? input.max_comparables : 2));
  const forceRefresh = input.force_refresh === true;
  const forceValidate = input.force_validate === true;

  const { canonical_url: originalUrl } = normalizeProductUrlInput(input);
  let originalObj =
    input.original && typeof input.original === 'object' && !Array.isArray(input.original) ? input.original : null;
  let anchorId = extractAnchorIdFromProductLike(originalObj);

  const inputText =
    buildProductInputText(originalObj, originalUrl) ||
    (typeof input.original_text === 'string' ? input.original_text.trim() : '') ||
    '';

  if (!inputText) {
    return {
      ok: false,
      status_code: 400,
      error_code: 'BAD_REQUEST',
      error_details: 'original is required',
      payload: null,
      event_kind: 'error',
    };
  }

  const _buildKbKey = (args) => buildDupeSuggestKbKey(args, normalizeDupeKbKey);

  // --- helper: build KB-served response payload --------------------------
  const buildKbPayload = (kbEntry, kbKey, resolvedOriginal, compatibility) => {
    const kbEvaluation = compatibility && compatibility.evaluation ? compatibility.evaluation : evaluateDupeCandidates(
      [
        ...(Array.isArray(kbEntry.dupes) ? kbEntry.dupes : []),
        ...(Array.isArray(kbEntry.comparables) ? kbEntry.comparables : []),
      ],
      resolvedOriginal.original,
      { maxDupes, maxComparables },
    );
    const sourceMeta = compatibility && compatibility.sourceMeta ? compatibility.sourceMeta : getKbSourceMeta(kbEntry);
    const dupesKb = kbEvaluation.dupes;
    const comparablesKb = kbEvaluation.comparables;
    const hasMeaningfulQualityKb = kbEvaluation.hasMeaningfulQuality;
    const verifiedKb = dupesKb.length + comparablesKb.length > 0 && hasMeaningfulQualityKb;
    const candidatePoolMeta = normalizeCandidatePoolMeta(
      sourceMeta.candidate_pool_meta || {
        count: sourceMeta.pre_filter_candidate_count,
        sources_used: sourceMeta.final_source_mix,
      },
    );
    const qualityAssessmentKb = buildDupeSuggestQualityAssessment({
      resolvedOriginal,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      hasMeaningfulQuality: hasMeaningfulQualityKb,
      candidatePoolMeta,
    });
    return {
      kb_key: kbKey,
      original: resolvedOriginal.original,
      anchor_resolution_status: resolvedOriginal.anchor_resolution_status,
      dupes: dupesKb,
      comparables: comparablesKb,
      verified: verifiedKb,
      verified_at: kbEntry.verified_at || null,
      source: kbEntry.source || 'kb',
      quality: qualityAssessmentKb,
      qualityAssessment: qualityAssessmentKb,
      candidate_pool_meta: candidatePoolMeta,
      ...(sourceMeta.final_empty_reason ? { empty_state_reason: sourceMeta.final_empty_reason } : {}),
      meta: {
        served_from_kb: true,
        validated_now: false,
        recommendation_mode: sourceMeta.recommendation_mode || null,
        recommendation_mode_initial: sourceMeta.recommendation_mode_initial || sourceMeta.recommendation_mode || null,
        recommendation_mode_final: sourceMeta.recommendation_mode_final || sourceMeta.recommendation_mode || null,
        profile_mode: sourceMeta.profile_mode || null,
        profile_context_present: sourceMeta.profile_context_present === true,
        attempted_queries: Array.isArray(sourceMeta.attempted_queries) ? sourceMeta.attempted_queries.slice(0, 6) : [],
        pool_query_hits: sourceMeta.pool_query_hits || {},
        pool_query_zero_hit_count: Number.isFinite(Number(sourceMeta.pool_query_zero_hit_count))
          ? Math.max(0, Math.trunc(Number(sourceMeta.pool_query_zero_hit_count)))
          : 0,
        pool_filter_drop_reasons: sourceMeta.pool_filter_drop_reasons || {},
        source_hit_counts: sourceMeta.source_hit_counts || { catalog_search: 0, product_embedded: 0, open_world_fallback: 0 },
        final_source_mix: Array.isArray(sourceMeta.final_source_mix) ? sourceMeta.final_source_mix : [],
        final_empty_reason: sourceMeta.final_empty_reason || null,
        viability_failure_reasons: Array.isArray(sourceMeta.viability_failure_reasons) ? sourceMeta.viability_failure_reasons : [],
        escalated_to_open_world: sourceMeta.escalated_to_open_world === true,
        has_anchor_identity: sourceMeta.has_anchor_identity === true,
        candidate_pool_meta: candidatePoolMeta,
      },
    };
  };

  // 1) KB fast-path
  let kbKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  let kbEntry = kbKey ? await getDupeKbEntry(kbKey) : null;
  const initialResolvedOriginal = resolveOriginalForPayload(kbEntry && kbEntry.original ? kbEntry.original : originalObj, originalUrl, inputText);
  const kbCompatibility1 = kbEntry
    ? assessKbCompatibility(kbEntry, initialResolvedOriginal, { maxDupes, maxComparables })
    : null;
  const canServeKb1 = kbEntry
    && kbCompatibility1
    && kbCompatibility1.compatible
    && (kbEntry.verified === true || kbCompatibility1.deterministicEmpty === true)
    && !forceRefresh
    && !forceValidate;
  if (canServeKb1) {
    const resolved = initialResolvedOriginal;
    return {
      ok: true,
      payload: buildKbPayload(kbEntry, kbKey, resolved, kbCompatibility1),
      event_kind: 'value_moment',
      event_source: 'kb',
    };
  }

  // 2) Best-effort parse
  if (!anchorId && inputText) {
    const upstreamMeta = {
      lang: ctx.lang,
      state: ctx.state || 'idle',
      trigger_source: ctx.trigger_source,
    };
    const parsePrefix = buildContextPrefix({ ...upstreamMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
    const parseQuery =
      `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
      `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
      `Input: ${inputText}`;
    try {
      const _llmParseStart = Date.now();
      const upstream = await auroraChat({
        baseUrl: AURORA_DECISION_BASE_URL,
        query: parseQuery,
        timeoutMs: 9000,
        ...(originalUrl ? { anchor_product_url: originalUrl } : {}),
        prompt_template_id: 'dupe_suggest_parse',
        trace_id: ctx.trace_id,
        request_id: ctx.request_id,
      });
      logger?.info({
        event: 'llm_call_trace',
        task_mode: 'dupe_suggest',
        step: 'parse',
        template_id: 'dupe_suggest_parse',
        has_anchor: hasUsableAnchorIdentity({ anchorId, originalObj, originalUrl, inputText }),
        has_url: Boolean(originalUrl),
        duration_ms: Date.now() - _llmParseStart,
        has_structured: Boolean(upstream && upstream.structured),
      }, 'aurora bff: dupe_suggest parse llm trace');

      const structured = getUpstreamStructuredOrJson(upstream);
      const answerJson =
        upstream && typeof upstream.answer === 'string'
          ? extractJsonObjectByKeys(upstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
          : null;
      const obj =
        structured && typeof structured === 'object' && !Array.isArray(structured)
          ? structured
          : answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson)
            ? answerJson
            : null;
      const anchor =
        obj && obj.parse && typeof obj.parse === 'object'
          ? (obj.parse.anchor_product || obj.parse.anchorProduct)
          : obj && obj.product && typeof obj.product === 'object'
            ? obj.product
            : null;
      if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
        originalObj = originalObj || anchor;
        anchorId = anchorId || extractAnchorIdFromProductLike(anchor);
      }
    } catch {
      // ignore parse failures
    }
  }

  // Re-check KB with stable key
  const stableKey = _buildKbKey({ anchor: anchorId, url: originalUrl, text: inputText });
  if (stableKey && stableKey !== kbKey) {
    kbKey = stableKey;
    kbEntry = await getDupeKbEntry(kbKey);
    const stableResolvedOriginal = resolveOriginalForPayload(kbEntry && kbEntry.original ? kbEntry.original : originalObj, originalUrl, inputText);
    const kbCompatibility2 = kbEntry
      ? assessKbCompatibility(kbEntry, stableResolvedOriginal, { maxDupes, maxComparables })
      : null;
    const canServeKb2 = kbEntry
      && kbCompatibility2
      && kbCompatibility2.compatible
      && (kbEntry.verified === true || kbCompatibility2.deterministicEmpty === true)
      && !forceRefresh
      && !forceValidate;
    if (canServeKb2) {
      return {
        ok: true,
        payload: buildKbPayload(kbEntry, kbKey, stableResolvedOriginal, kbCompatibility2),
        event_kind: 'value_moment',
        event_source: 'kb',
      };
    }
  }

  // 3) Build candidate pool
  const total = Math.max(2, Math.min(6, maxDupes + maxComparables));
  const poolResult = await buildDupeSuggestCandidatePool({
    productObj: originalObj,
    anchorId,
    inputText,
    originalUrl,
    logger,
    maxCandidates: Math.max(12, total * 3),
  });
  const { recommendationMode, profileMode } = resolveDupeSuggestionModes({ profileSummary });
  const hasAnchorIdentity = hasUsableAnchorIdentity({
    anchorId,
    originalObj,
    originalUrl,
    inputText,
  });

  // 4) Fetch alternatives from LLM
  const runRecommendationPass = async (mode) => {
    const modeCandidatePool = mode === 'open_world_only'
      ? []
      : (Array.isArray(poolResult.selector_candidates) ? poolResult.selector_candidates : []);
    const anchorForEvaluation = resolveOriginalForPayload(originalObj, originalUrl, inputText).original;
    if (mode === 'pool_only' && modeCandidatePool.length === 0) {
      const zeroHitReason = Number(poolResult?.meta?.count || 0) === 0
        ? (sumReasonCounts(poolResult?.meta?.pool_filter_drop_reasons) > 0 ? 'backend_hits_all_filtered' : 'backend_zero_hits')
        : 'backend_hits_all_filtered';
      const emptyEvaluation = evaluateLiveDupeCandidates([], anchorForEvaluation, { maxDupes, maxComparables });
      return {
        recommendationMode: mode,
        candidatePoolSize: 0,
        upstreamOut: {
          alternatives: [],
          field_missing: [],
          source_mode: 'pool_only',
          fallback_source: 'none',
          no_result_reason: zeroHitReason,
          template_id: 'reco_alternatives_v1_0',
          raw_output_summary: buildEmptyRawOutputSummary(),
          selector_meta: {
            input_count: 0,
            timeout_ms: 10000,
          },
        },
        mapped: [],
        liveEvaluation: emptyEvaluation,
        persistEvaluation: evaluateDupeCandidates([], anchorForEvaluation, { maxDupes, maxComparables }),
        durationMs: 0,
        maxConfidence: 0,
      };
    }
    const startedAt = Date.now();
    const upstreamOutRaw = await fetchRecoAlternativesForProduct({
      ctx,
      profileSummary,
      recentLogs,
      productInput: inputText,
      productObj: originalObj,
      anchorId,
      maxTotal: mode === 'open_world_only'
        ? Math.max(1, total - poolPass.liveEvaluation.finalItems.length)
        : total,
      candidatePool: modeCandidatePool,
      debug: false,
      logger,
      options: {
        recommendation_mode: mode,
        profile_mode: profileMode,
        context_action_id: 'chip.action.find_dupe',
        disable_fallback: true,
        disable_synthetic_local_fallback: true,
        ignore_selector_candidates: mode === 'open_world_only',
        selector_seed_only: mode === 'pool_only',
        selector_timeout_ms: mode === 'pool_only' ? 10000 : undefined,
      },
    });
    const upstreamOut = upstreamOutRaw && typeof upstreamOutRaw === 'object' && !Array.isArray(upstreamOutRaw)
      ? { ...upstreamOutRaw }
      : {};
    let mapped = Array.isArray(upstreamOut.alternatives) ? upstreamOut.alternatives.map(normalizePoolSelectorAlternative).filter(Boolean) : [];
    let liveEvaluation = evaluateLiveDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
    let persistEvaluation = evaluateDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
    let poolRankFallbackUsed = false;
    let poolRankFallback = null;
    if (mode === 'pool_only' && modeCandidatePool.length > 0) {
      poolRankFallback = buildPoolRankFallbackAlternatives(
        modeCandidatePool,
        anchorForEvaluation,
        { inputText, maxTotal: total },
      );
    }
    if (
      mode === 'pool_only' &&
      !liveEvaluation.viable &&
      modeCandidatePool.length > 0 &&
      ['timeout', 'empty_structured'].includes(String(upstreamOut.failure_class || '').trim())
    ) {
      if (poolRankFallback && poolRankFallback.alternatives.length > 0) {
        poolRankFallbackUsed = true;
        mapped = poolRankFallback.alternatives;
        liveEvaluation = evaluateLiveDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
        persistEvaluation = evaluateDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
        upstreamOut.alternatives = mapped;
        upstreamOut.field_missing = [];
        upstreamOut.fallback_source = 'pool_rank_fallback';
        upstreamOut.selector_meta = {
          ...(upstreamOut.selector_meta && typeof upstreamOut.selector_meta === 'object' ? upstreamOut.selector_meta : {}),
          input_count: modeCandidatePool.length,
          timeout_ms: 10000,
          local_rank_fallback_used: true,
        };
        upstreamOut.raw_output_summary = buildEmptyRawOutputSummary();
      } else {
        upstreamOut.no_result_reason = 'pool_rank_fallback_exhausted';
        upstreamOut.selector_meta = {
          ...(upstreamOut.selector_meta && typeof upstreamOut.selector_meta === 'object' ? upstreamOut.selector_meta : {}),
          input_count: modeCandidatePool.length,
          timeout_ms: 10000,
          local_rank_fallback_used: false,
          local_rank_fallback_drop_reasons: poolRankFallback ? poolRankFallback.dropReasons : {},
        };
      }
    } else if (
      mode === 'pool_only' &&
      poolRankFallback &&
      poolRankFallback.alternatives.length > 0 &&
      mapped.length > 0
    ) {
      const mergedPoolCandidates = mergePoolSelectorWithFallback(
        mapped,
        poolRankFallback.alternatives,
        anchorForEvaluation,
        { inputText, limit: total },
      );
      if (mergedPoolCandidates.length > 0) {
        mapped = mergedPoolCandidates;
        liveEvaluation = evaluateLiveDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
        persistEvaluation = evaluateDupeCandidates(mapped, anchorForEvaluation, { maxDupes, maxComparables });
        poolRankFallbackUsed = mapped.some((item) => String(item && item.ranking_mode || '').trim() === 'pool_rank_fallback');
        upstreamOut.alternatives = mapped;
        upstreamOut.selector_meta = {
          ...(upstreamOut.selector_meta && typeof upstreamOut.selector_meta === 'object' ? upstreamOut.selector_meta : {}),
          input_count: modeCandidatePool.length,
          timeout_ms: 10000,
          local_rank_fallback_used: poolRankFallbackUsed,
        };
      }
    }
    const maxConfidence = mapped.reduce((mx, it) => {
      const confidence = it && typeof it === 'object' ? Number(it.confidence) : 0;
      return Number.isFinite(confidence) && confidence > mx ? confidence : mx;
    }, 0);
    return {
      recommendationMode: mode,
      candidatePoolSize: Array.isArray(modeCandidatePool) ? modeCandidatePool.length : 0,
      upstreamOut,
      mapped,
      liveEvaluation,
      persistEvaluation,
      poolRankFallbackUsed,
      durationMs: Date.now() - startedAt,
      maxConfidence,
    };
  };

  const poolPass = await runRecommendationPass('pool_only');
  const openWorldNeeded = poolPass.liveEvaluation.finalItems.length < total;
  const openWorldPass = openWorldNeeded ? await runRecommendationPass('open_world_only') : null;

  const recommendationModeFinal = openWorldPass ? 'open_world_only' : recommendationMode;
  const openWorldSupplementUsed = Boolean(openWorldPass);
  const escalatedToOpenWorld = openWorldSupplementUsed;
  const poolPassTrace = buildRecommendationPassTrace(poolPass, { fallbackTemplateId: 'reco_alternatives_v1_0' });
  const openWorldPassTrace = openWorldPass
    ? buildRecommendationPassTrace(openWorldPass, { fallbackTemplateId: 'reco_alternatives_open_world_v1' })
    : null;
  const dupes = mergeRankedItems(
    poolPass.liveEvaluation.dupes,
    openWorldPass ? openWorldPass.liveEvaluation.dupes : [],
    { limit: maxDupes },
  );
  const comparables = mergeRankedItems(
    poolPass.liveEvaluation.comparables,
    openWorldPass ? openWorldPass.liveEvaluation.comparables : [],
    { limit: maxComparables },
  );
  const finalItems = [...dupes, ...comparables];
  const combinedMapped = [
    ...(Array.isArray(poolPass.mapped) ? poolPass.mapped : []),
    ...(openWorldPass && Array.isArray(openWorldPass.mapped) ? openWorldPass.mapped : []),
  ];
  const finalPersistEvaluation = evaluateDupeCandidates(
    finalItems,
    resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
    { maxDupes, maxComparables },
  );
  const finalLiveEvaluation = evaluateLiveDupeCandidates(
    finalItems,
    resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
    { maxDupes, maxComparables },
  );
  const viabilityFailureReasons = [];
  const hasResults = dupes.length > 0 || comparables.length > 0;
  viabilityFailureReasons.push(...poolPass.liveEvaluation.failureReasons);
  if (openWorldPass) viabilityFailureReasons.push(...openWorldPass.liveEvaluation.failureReasons);
  const hasMeaningfulQuality = finalLiveEvaluation.hasMeaningfulQuality;
  const verified = hasResults && finalPersistEvaluation.viable;
  const terminalEmptyReason = hasResults
    ? null
    : buildTerminalEmptyReason({
      poolResult,
      poolPass,
      openWorldPass,
      finalLiveEvaluation,
      profileMode,
    });
  const finalSourceMix = buildFinalSourceMix(finalItems, recommendationModeFinal);
  const sourceHitCounts = buildSourceHitCounts(poolResult && poolResult.meta, finalItems);
  const rawOutputItemCount = poolPassTrace.raw_output_item_count + (openWorldPassTrace ? openWorldPassTrace.raw_output_item_count : 0);

  // LLM trace
  logger?.info({
    event: 'llm_call_trace',
    task_mode: 'dupe_suggest',
    step: 'alternatives',
    template_id: (openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.template_id)
      || (poolPass.upstreamOut && poolPass.upstreamOut.template_id)
      || (recommendationModeFinal === 'pool_only' ? 'reco_alternatives_v1_0' : 'reco_alternatives_open_world_v1'),
    has_candidates: poolResult.candidates.length > 0,
    candidate_count: poolResult.candidates.length,
    has_anchor: hasAnchorIdentity,
    duration_ms: poolPass.durationMs + (openWorldPass ? openWorldPass.durationMs : 0),
    output_item_count: combinedMapped.length,
    raw_output_item_count: rawOutputItemCount,
    output_dupe_count: dupes.length,
    output_comparable_count: comparables.length,
    output_max_confidence: Math.max(poolPass.maxConfidence, openWorldPass ? openWorldPass.maxConfidence : 0),
    has_meaningful_quality: hasMeaningfulQuality,
    source_mode: openWorldPass && openWorldPass.upstreamOut
      ? openWorldPass.upstreamOut.source_mode || null
      : poolPass.upstreamOut ? poolPass.upstreamOut.source_mode || null : null,
    fallback_source: openWorldPass && openWorldPass.upstreamOut
      ? openWorldPass.upstreamOut.fallback_source || null
      : poolPass.upstreamOut ? poolPass.upstreamOut.fallback_source || null : null,
    recommendation_mode_initial: recommendationMode,
    recommendation_mode_final: recommendationModeFinal,
    profile_mode: profileMode,
    escalated_to_open_world: escalatedToOpenWorld,
    open_world_supplement_used: openWorldSupplementUsed,
    viability_failure_reasons: uniqStrings(viabilityFailureReasons),
    output_preview_products: finalItems
      .slice(0, 3)
      .map((item) => {
        const product = item && typeof item === 'object' ? item.product : null;
        const brand = product && typeof product === 'object' ? String(product.brand || '').trim() : '';
        const name = product && typeof product === 'object' ? String(product.name || '').trim() : '';
        return [brand, name].filter(Boolean).join(' ').trim() || null;
      })
      .filter(Boolean),
    pre_post_filter_counts: {
      raw: combinedMapped.length,
      after_sanitize: poolPass.liveEvaluation.candidateCountAfterSanitize + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterSanitize : 0),
      after_self_ref: poolPass.liveEvaluation.candidateCountAfterSelfRef + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterSelfRef : 0),
      after_dedupe: poolPass.liveEvaluation.candidateCountAfterDedupe + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterDedupe : 0),
      after_identity: poolPass.liveEvaluation.candidateCountAfterIdentity + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterIdentity : 0),
      after_synthetic: poolPass.liveEvaluation.candidateCountAfterSynthetic + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterSynthetic : 0),
      after_placeholder: poolPass.liveEvaluation.candidateCountAfterPlaceholder + (openWorldPass ? openWorldPass.liveEvaluation.candidateCountAfterPlaceholder : 0),
      after_viability: finalLiveEvaluation.candidateCountAfterViability,
    },
    pass_traces: {
      pool_only: poolPassTrace,
      ...(openWorldPassTrace ? { open_world_only: openWorldPassTrace } : {}),
    },
  }, 'aurora bff: dupe_suggest alternatives llm trace');

  // 5) KB backfill
  const kbGatePayload = {
    dupes,
    comparables,
    candidate_pool_meta: normalizeCandidatePoolMeta(poolResult && poolResult.meta),
    empty_state_reason: terminalEmptyReason,
    meta: {
      final_empty_reason: terminalEmptyReason,
    },
  };
  const kbGateResult = applyDupeSuggestQualityGate(kbGatePayload, { lang: ctx.lang });
  const deterministicWeakAnchorEmpty = isDeterministicWeakAnchorEmpty({
    hasResults,
    terminalEmptyReason,
  });
  const kbPersistAllowed = (hasResults && !kbGateResult.gated) || deterministicWeakAnchorEmpty;
  if (kbKey && kbPersistAllowed) {
    const kbWritePayload = {
      kb_key: kbKey,
      original: resolveOriginalForPayload(originalObj, originalUrl, inputText).original,
      dupes,
      comparables,
      verified,
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? 'aurora_llm' : null,
      source: hasResults ? 'llm_generate' : 'llm_generate_empty',
      source_meta: {
        contract_version: DUPE_SUGGEST_KB_CONTRACT_VERSION,
        generated_at: new Date().toISOString(),
        max_dupes: maxDupes,
        max_comparables: maxComparables,
        recommendation_mode: recommendationModeFinal,
        recommendation_mode_initial: recommendationMode,
        recommendation_mode_final: recommendationModeFinal,
        profile_mode: profileMode,
        profile_context_present: profileMode === 'personalized',
        open_world_supplement_used: openWorldSupplementUsed,
        attempted_queries: Array.isArray(poolResult?.meta?.attempted_queries) ? poolResult.meta.attempted_queries.slice(0, 6) : [],
        pool_query_hits: poolResult?.meta?.pool_query_hits || {},
        pool_query_zero_hit_count: Number.isFinite(Number(poolResult?.meta?.pool_query_zero_hit_count))
          ? Math.max(0, Math.trunc(Number(poolResult.meta.pool_query_zero_hit_count)))
          : 0,
        pool_filter_drop_reasons: poolResult?.meta?.pool_filter_drop_reasons || {},
        source_hit_counts: sourceHitCounts,
        final_source_mix: finalSourceMix,
        final_empty_reason: terminalEmptyReason,
        pre_filter_candidate_count: combinedMapped.length,
        post_filter_candidate_count: finalPersistEvaluation.candidateCountAfterViability,
        candidate_pool_meta: normalizeCandidatePoolMeta(poolResult && poolResult.meta),
        escalated_to_open_world: escalatedToOpenWorld,
        viability_failure_reasons: uniqStrings(viabilityFailureReasons),
        has_anchor_identity: hasAnchorIdentity,
      },
    };
    if (DUPE_KB_ASYNC_BACKFILL_ENABLED) {
      upsertDupeKbEntry(kbWritePayload).catch((err) => {
        logger?.warn(
          { err: err?.message || String(err), kb_key: kbKey },
          'aurora bff: async dupe kb backfill failed',
        );
      });
    } else {
      await upsertDupeKbEntry(kbWritePayload);
    }
  } else if (kbKey && logger) {
    logger.info(
      {
        event: 'dupe_suggest_kb_backfill_blocked',
        request_id: ctx.request_id,
        kb_key: kbKey,
        reason: kbGateResult.reason || 'kb_persist_gate_failed',
      },
      'aurora bff: dupe_suggest kb backfill blocked',
    );
  }

  // 6) Assemble payload
  const resolvedOriginalFinal = resolveOriginalForPayload(originalObj, originalUrl, inputText);
  const candidatePoolMeta = normalizeCandidatePoolMeta(poolResult && poolResult.meta);
  const qualityAssessmentFinal = buildDupeSuggestQualityAssessment({
    resolvedOriginal: resolvedOriginalFinal,
    dupes,
    comparables,
    verified,
    hasMeaningfulQuality,
    candidatePoolMeta,
  });

  const payload = {
    kb_key: kbKey,
    original: resolvedOriginalFinal.original,
    anchor_resolution_status: resolvedOriginalFinal.anchor_resolution_status,
    dupes,
    comparables,
    verified,
    verified_at: verified ? new Date().toISOString() : null,
    source: hasResults ? 'llm_generate' : 'llm_generate_empty',
    quality: qualityAssessmentFinal,
    qualityAssessment: qualityAssessmentFinal,
    candidate_pool_meta: candidatePoolMeta,
    ...(terminalEmptyReason ? { empty_state_reason: terminalEmptyReason } : {}),
    meta: {
      served_from_kb: false,
      validated_now: true,
      force_refresh: forceRefresh,
      force_validate: forceValidate,
      kb_backfill_mode: DUPE_KB_ASYNC_BACKFILL_ENABLED ? 'async' : 'sync',
      recommendation_mode: recommendationModeFinal,
      recommendation_mode_initial: recommendationMode,
      recommendation_mode_final: recommendationModeFinal,
      profile_mode: profileMode,
      profile_context_present: profileMode === 'personalized',
      open_world_supplement_used: openWorldSupplementUsed,
      escalated_to_open_world: escalatedToOpenWorld,
      viability_failure_reasons: uniqStrings(viabilityFailureReasons),
      has_anchor_identity: hasAnchorIdentity,
      attempted_queries: Array.isArray(poolResult?.meta?.attempted_queries) ? poolResult.meta.attempted_queries.slice(0, 6) : [],
      pool_query_hits: poolResult?.meta?.pool_query_hits || {},
      pool_query_zero_hit_count: Number.isFinite(Number(poolResult?.meta?.pool_query_zero_hit_count))
        ? Math.max(0, Math.trunc(Number(poolResult.meta.pool_query_zero_hit_count)))
        : 0,
      pool_filter_drop_reasons: poolResult?.meta?.pool_filter_drop_reasons || {},
      source_hit_counts: sourceHitCounts,
      final_source_mix: finalSourceMix,
      final_empty_reason: terminalEmptyReason,
      pre_filter_candidate_count: combinedMapped.length,
      post_filter_candidate_count: finalLiveEvaluation.candidateCountAfterViability,
      candidate_pool_meta: candidatePoolMeta,
      llm_trace: {
        task_mode: 'dupe_suggest',
        template_id: (openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.template_id)
          || (poolPass.upstreamOut && poolPass.upstreamOut.template_id)
          || (recommendationModeFinal === 'pool_only' ? 'reco_alternatives_v1_0' : 'reco_alternatives_open_world_v1'),
        candidate_count: poolResult.candidates.length,
        has_anchor: hasAnchorIdentity,
        output_item_count: combinedMapped.length,
        raw_output_item_count: rawOutputItemCount,
        output_max_confidence: Math.max(poolPass.maxConfidence, openWorldPass ? openWorldPass.maxConfidence : 0),
        quality_flags: qualityAssessmentFinal.quality_issues,
        pass_traces: {
          pool_only: poolPassTrace,
          ...(openWorldPassTrace ? { open_world_only: openWorldPassTrace } : {}),
        },
      },
      ...(kbPersistAllowed ? {} : { kb_backfill_blocked_reason: kbGateResult.reason || 'kb_persist_gate_failed' }),
    },
    ...(mergeFieldMissingEntries(
      Array.isArray(poolPass.upstreamOut && poolPass.upstreamOut.field_missing) ? poolPass.upstreamOut.field_missing : [],
      Array.isArray(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.field_missing) ? openWorldPass.upstreamOut.field_missing : [],
    ).length ? {
      field_missing: mergeFieldMissingEntries(
        Array.isArray(poolPass.upstreamOut && poolPass.upstreamOut.field_missing) ? poolPass.upstreamOut.field_missing : [],
        Array.isArray(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.field_missing) ? openWorldPass.upstreamOut.field_missing : [],
      ),
    } : {}),
  };

  return {
    ok: true,
    payload,
    event_kind: hasResults ? 'value_moment' : 'empty_state',
    event_source: 'llm',
    quality_gated: false,
    event_reason: null,
    field_missing: mergeFieldMissingEntries(
      Array.isArray(poolPass.upstreamOut && poolPass.upstreamOut.field_missing) ? poolPass.upstreamOut.field_missing : [],
      Array.isArray(openWorldPass && openWorldPass.upstreamOut && openWorldPass.upstreamOut.field_missing) ? openWorldPass.upstreamOut.field_missing : [],
    ),
  };
}

function __resetDupeSuggestContractPurgeForTest() {
  dupeKbContractPurgePromise = null;
}

module.exports = {
  executeDupeSuggest,
  __resetDupeSuggestContractPurgeForTest,
};
