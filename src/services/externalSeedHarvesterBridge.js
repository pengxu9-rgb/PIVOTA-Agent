const crypto = require('node:crypto');

const { ensureJsonObject, normalizeSeedVariants } = require('./externalSeedProducts');
const { auditExternalSeedRow, ANOMALY_SEVERITY } = require('./externalSeedContentAudit');

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeUrlLike(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^https?:\/\//i.test(normalized) ? normalized : '';
}

function buildVariantSourceUrl(baseUrl, variantId) {
  const normalizedUrl = normalizeUrlLike(baseUrl);
  const normalizedVariantId = normalizeNonEmptyString(variantId);
  if (!normalizedUrl || !normalizedVariantId) return normalizedUrl;

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.searchParams.has('variant')) return parsed.toString();
    parsed.searchParams.set('variant', normalizedVariantId);
    return parsed.toString();
  } catch {
    return normalizedUrl;
  }
}

function sanitizeKeySegment(value, fallback = 'product') {
  const normalized = normalizeNonEmptyString(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

const EXCLUDED_PRODUCT_PATTERNS = [
  /\be-?gift\s*card\b/i,
  /\bgift\s*card\b/i,
  /\bdefault\s+title\b/i,
  /\bbundle\b/i,
  /\bkit\b/i,
  /\bset\b/i,
  /\bduo\b/i,
  /\btrio\b/i,
  /\bcollection\b/i,
  /\bmystery\s+box\b/i,
];

const SKINCARE_ALLOW_PATTERNS = [
  /\bcleanser\b/i,
  /\bface\s+wash\b/i,
  /\bserum\b/i,
  /\bessence\b/i,
  /\btoner\b/i,
  /\bmoisturi[sz]er\b/i,
  /\bcream\b/i,
  /\blotion\b/i,
  /\bface\s+oil\b/i,
  /\boil\b/i,
  /\bmask\b/i,
  /\bsunscreen\b/i,
  /\bspf\b/i,
  /\btreatment\b/i,
  /\bexfoliant\b/i,
  /\bpeel\b/i,
  /\bmist\b/i,
  /\beye\s+cream\b/i,
  /\beye\s+serum\b/i,
  /\bpatches?\b/i,
];

const NON_SKINCARE_BLOCK_PATTERNS = [
  /\bblush\b/i,
  /\bbronzer?\b/i,
  /\bpowder\b/i,
  /\bfoundation\b/i,
  /\bskin\s*tint\b/i,
  /\bskinveil\b/i,
  /\bconcealer\b/i,
  /\bhighlighter\b/i,
  /\bcontour\b/i,
  /\bmascara\b/i,
  /\beyeliner\b/i,
  /\beye\s*shadow\b/i,
  /\bpalette\b/i,
  /\bbrow\b/i,
  /\blash\b/i,
  /\blipstick\b/i,
  /\blip\s*gloss\b/i,
];

const SKINCARE_REVIEW_PATTERNS = [
  /\blip\b/i,
  /\bbalm\b/i,
  /\bprimer\b/i,
  /\bbase\b/i,
  /\btint\b/i,
];

function extractRawIngredientText(description) {
  const text = normalizeNonEmptyString(description);
  if (!text) return '';

  const labeledMatch =
    text.match(/ingredients and safety:\s*([\s\S]+)$/i) ||
    text.match(/ingredients?\s*:\s*([\s\S]+)$/i);
  if (!labeledMatch) return '';

  const raw = normalizeNonEmptyString(labeledMatch[1]);
  if (!raw) return '';

  return raw
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 4000);
}

function buildCandidateId(row, variant, index) {
  const seedId = normalizeNonEmptyString(row?.id);
  const tokenBase =
    normalizeNonEmptyString(variant?.variant_id) ||
    normalizeNonEmptyString(variant?.id) ||
    normalizeNonEmptyString(variant?.sku) ||
    `variant-${index + 1}`;
  const token = sanitizeKeySegment(tokenBase, `variant-${index + 1}`);
  const prefix = seedId ? `extseed:${seedId}` : `extseed:${stableHash(JSON.stringify({ row, token }))}`;
  return `${prefix}:${token}`;
}

function buildProductName(baseTitle, variant) {
  const title = normalizeNonEmptyString(baseTitle);
  const optionValue = normalizeNonEmptyString(variant?.option_value || variant?.title);
  if (!optionValue || /^default$/i.test(optionValue)) return title;
  return `${title} - ${optionValue}`;
}

function shouldExcludeCandidate(candidate) {
  const productName = normalizeNonEmptyString(candidate?.product_name);
  if (!productName) return false;
  return EXCLUDED_PRODUCT_PATTERNS.some((pattern) => pattern.test(productName));
}

function candidateScopeText(row, candidate) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const parts = [
    candidate?.product_name,
    candidate?.source_ref,
    candidate?.url,
    row?.title,
    row?.canonical_url,
    row?.destination_url,
    row?.domain,
    seedData?.product_type,
    snapshot?.product_type,
    seedData?.category,
    snapshot?.category,
    Array.isArray(seedData?.categories) ? seedData.categories.join(' ') : '',
    Array.isArray(snapshot?.categories) ? snapshot.categories.join(' ') : '',
  ];
  return parts
    .map((value) => normalizeNonEmptyString(value))
    .filter(Boolean)
    .join(' ');
}

function classifyIngredientScope(row, candidate) {
  const haystack = candidateScopeText(row, candidate);
  if (!haystack) {
    return { decision: 'review', reason: 'missing_scope_signals' };
  }

  if (NON_SKINCARE_BLOCK_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { decision: 'block', reason: 'non_skincare_product_class' };
  }

  if (SKINCARE_REVIEW_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { decision: 'review', reason: 'ambiguous_non_face_scope' };
  }

  if (SKINCARE_ALLOW_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return { decision: 'allow', reason: 'skincare_signals_present' };
  }

  return { decision: 'review', reason: 'missing_explicit_skincare_signals' };
}

function buildExternalSeedHarvesterCandidates(row, options = {}) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const baseTitle = normalizeNonEmptyString(snapshot.title || row?.title || seedData.title || row?.id);
  const brand = normalizeNonEmptyString(seedData.brand || snapshot.brand || row?.brand || row?.domain);
  const market = normalizeNonEmptyString(row?.market || snapshot.market || seedData.market || 'US').toUpperCase();
  const variants = normalizeSeedVariants(seedData, row);
  const sourceUrl =
    normalizeUrlLike(snapshot.canonical_url) ||
    normalizeUrlLike(row?.canonical_url) ||
    normalizeUrlLike(snapshot.destination_url) ||
    normalizeUrlLike(row?.destination_url);
  const productLevelIngredientText =
    extractRawIngredientText(snapshot.description) ||
    extractRawIngredientText(seedData.description) ||
    extractRawIngredientText(row?.description);

  if (variants.length === 0) {
    const candidateId = buildCandidateId(row, { variant_id: 'product', sku: 'product' }, 0);
    return [
      {
        candidate_id: candidateId,
        sku_key: candidateId,
        external_seed_id: normalizeNonEmptyString(row?.id),
        external_product_id: normalizeNonEmptyString(row?.external_product_id),
        market,
        brand,
        product_name: baseTitle,
        variant_sku: '',
        variant_id: '',
        source_type: 'external_seed',
        source_ref: sourceUrl,
        url: sourceUrl,
        raw_ingredient_text: productLevelIngredientText,
      },
    ].filter((candidate) => !shouldExcludeCandidate(candidate));
  }

  return variants
    .map((variant, index) => {
      const candidateId = buildCandidateId(row, variant, index);
      const variantId = normalizeNonEmptyString(variant?.variant_id || variant?.id);
      const variantUrl = buildVariantSourceUrl(normalizeUrlLike(variant?.url) || sourceUrl, variantId);
      const rawIngredientText =
        extractRawIngredientText(variant?.description) ||
        extractRawIngredientText(snapshot.description) ||
        productLevelIngredientText;
      return {
        candidate_id: candidateId,
        sku_key: candidateId,
        external_seed_id: normalizeNonEmptyString(row?.id),
        external_product_id: normalizeNonEmptyString(row?.external_product_id),
        market,
        brand,
        product_name: buildProductName(baseTitle, variant),
        variant_sku: normalizeNonEmptyString(variant?.sku),
        variant_id: variantId,
        source_type: 'external_seed',
        source_ref: variantUrl,
        url: variantUrl,
        raw_ingredient_text: rawIngredientText,
      };
    })
    .filter((candidate) => !shouldExcludeCandidate(candidate));
}

function filterCandidatesForHarvester(rows, options = {}) {
  const includeBlocked = options.includeBlocked === true;
  const includeNonSkincare = options.includeNonSkincare === true;
  const out = [];
  const skipped = [];

  for (const row of rows) {
    const audit = auditExternalSeedRow(row, options.auditOptions);
    const blockerFindings = audit.findings.filter((finding) => finding.severity === ANOMALY_SEVERITY.blocker);
    if (!includeBlocked && blockerFindings.length > 0) {
      skipped.push({
        row_id: normalizeNonEmptyString(row?.id),
        reason: 'blocked_by_audit',
        findings: blockerFindings,
      });
      continue;
    }

    const candidates = buildExternalSeedHarvesterCandidates(row, options);
    const scopedCandidates = candidates
      .map((candidate) => ({
        candidate,
        scope: classifyIngredientScope(row, candidate),
      }));
    const allowedCandidates = includeNonSkincare
      ? scopedCandidates.map((item) => item.candidate)
      : scopedCandidates.filter((item) => item.scope.decision === 'allow').map((item) => item.candidate);

    if (allowedCandidates.length === 0) {
      skipped.push({
        row_id: normalizeNonEmptyString(row?.id),
        reason:
          scopedCandidates.length > 0
            ? 'non_skincare_candidate'
            : 'candidate_policy_filtered',
        findings:
          scopedCandidates.length > 0
            ? scopedCandidates.map((item) => ({
                anomaly_type: 'non_skincare_candidate',
                severity: item.scope.decision === 'block' ? 'blocker' : 'review',
                evidence: {
                  product_name: normalizeNonEmptyString(item.candidate?.product_name),
                  source_ref: normalizeNonEmptyString(item.candidate?.source_ref),
                  scope_reason: item.scope.reason,
                  scope_decision: item.scope.decision,
                },
              }))
            : [],
      });
      continue;
    }

    out.push({
      row,
      audit,
      candidates: allowedCandidates,
    });
  }

  return {
    exported: out,
    skipped,
  };
}

module.exports = {
  buildCandidateId,
  buildVariantSourceUrl,
  buildExternalSeedHarvesterCandidates,
  classifyIngredientScope,
  extractRawIngredientText,
  filterCandidatesForHarvester,
  shouldExcludeCandidate,
};
