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
      const variantUrl = normalizeUrlLike(variant?.url) || sourceUrl;
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
        variant_id: normalizeNonEmptyString(variant?.variant_id || variant?.id),
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
    if (candidates.length === 0) {
      skipped.push({
        row_id: normalizeNonEmptyString(row?.id),
        reason: 'candidate_policy_filtered',
        findings: [],
      });
      continue;
    }

    out.push({
      row,
      audit,
      candidates,
    });
  }

  return {
    exported: out,
    skipped,
  };
}

module.exports = {
  buildCandidateId,
  buildExternalSeedHarvesterCandidates,
  extractRawIngredientText,
  filterCandidatesForHarvester,
  shouldExcludeCandidate,
};
