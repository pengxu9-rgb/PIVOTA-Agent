#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  buildProductIntelDraftBundle,
  isHumanReviewedProductIntelBundle,
  normalizePublishedProductIntelBundle,
} = require('../src/pdpProductIntel');
const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');

const DEFAULT_LIMIT = 50;
const DEFAULT_SAMPLE_LIMIT = 10;

const REVIEW_PROVENANCE_FIELDS = [
  'review_status',
  'review_decision',
  'review_tier',
  'reviewer',
  'reviewer_kind',
  'reviewed_at',
];

const SELLER_ONLY_EVIDENCE_PROFILES = new Set([
  '',
  'seller_only',
  'seller_only_fallback',
]);

const GRADUATED_EVIDENCE_PROFILES = new Set([
  'seller_plus_formula',
  'seller_plus_formula_reviews',
  'seller_grounded',
  'seller_plus_external_review',
  'community_supported',
  'official_pdp_reviewed',
]);

const CLASSIFICATIONS = [
  'would_render_after_publish',
  'would_not_render_even_if_published',
  'would_graduate',
  'still_seller_only',
  'lost_review_provenance',
  'row_error',
];

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  const flags = new Set();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith('--')) continue;
    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      const key = withoutPrefix.slice(0, equalsIndex);
      const value = withoutPrefix.slice(equalsIndex + 1);
      values.set(key, value);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(withoutPrefix, next);
      index += 1;
    } else {
      flags.add(withoutPrefix);
    }
  }

  const getValue = (...names) => {
    for (const name of names) {
      if (values.has(name)) return values.get(name);
    }
    return '';
  };
  const hasFlag = (...names) => names.some((name) => flags.has(name) || values.get(name) === 'true');

  return {
    limit: parseInteger(getValue('limit'), DEFAULT_LIMIT, { min: 0, max: 100000 }),
    domain: normalizeText(getValue('domain')),
    categoryPrefix: normalizeText(getValue('category-prefix', 'categoryPrefix')),
    sampleLimit: parseInteger(getValue('sample-limit', 'sampleLimit'), DEFAULT_SAMPLE_LIMIT, { min: 0, max: 1000 }),
    outputJson: normalizeText(getValue('output-json', 'outputJson')),
    outputMd: normalizeText(getValue('output-md', 'outputMd')),
    requirePriority: hasFlag('require-priority', 'requirePriority'),
    apply: hasFlag('apply'),
    kbKey: normalizeText(getValue('kb-key', 'kbKey')),
  };
}

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function buildCandidateQuery(options = {}) {
  const params = [];
  const latestFilters = [];
  const candidateFilters = [];

  if (options.kbKey) {
    latestFilters.push(`kb.kb_key = ${pushParam(params, options.kbKey)}`);
  }
  if (options.domain) {
    candidateFilters.push(`lower(domain) = lower(${pushParam(params, options.domain)})`);
  }
  if (options.categoryPrefix) {
    candidateFilters.push(`category_path LIKE ${pushParam(params, `${options.categoryPrefix}%`)}`);
  }
  if (options.requirePriority) {
    candidateFilters.push('seed_updated_at > last_success_at');
  }

  const limitClause = options.limit > 0 ? `LIMIT ${pushParam(params, options.limit)}` : '';

  const sql = `
WITH latest_kb AS (
  SELECT DISTINCT ON (cp.source_product_id)
    cp.product_key,
    cp.source_product_id,
    cp.pivota_signature_id,
    cp.category_path,
    eps.id AS seed_id,
    eps.external_product_id,
    eps.domain,
    eps.title,
    eps.destination_url,
    eps.canonical_url,
    eps.image_url,
    eps.price_amount,
    eps.price_currency,
    eps.availability,
    eps.status AS seed_status,
    eps.attached_product_key,
    eps.created_at AS seed_created_at,
    coalesce(eps.seed_data, '{}'::jsonb) AS seed_data,
    eps.updated_at AS seed_updated_at,
    kb.kb_key,
    kb.analysis,
    kb.source_meta,
    kb.last_success_at,
    kb.updated_at AS kb_updated_at,
    lower(coalesce(
      kb.analysis->'product_intel_v1'->>'evidence_profile',
      kb.analysis->'product_intel_v1'->'product_intel_core'->>'evidence_profile',
      kb.source_meta->>'evidence_profile',
      'unknown'
    )) AS evidence_profile,
    lower(nullif(coalesce(
      kb.source_meta->>'review_decision',
      kb.analysis->'product_intel_v1'->'provenance'->>'review_decision',
      kb.source_meta->>'external_highlight_review_status',
      kb.analysis->'product_intel_v1'->'provenance'->>'external_highlight_review_status',
      ''
    ), '')) AS review_decision
  FROM catalog_products cp
  JOIN external_product_seeds eps
    ON eps.status = 'active'
   AND eps.external_product_id = cp.source_product_id
  JOIN aurora_product_intel_kb kb
    ON kb.kb_key IN (
      'product:' || cp.source_product_id,
      'product:' || cp.pivota_signature_id
    )
  WHERE cp.catalog_track = 'external_referral'
    ${latestFilters.length ? `AND ${latestFilters.join('\n    AND ')}` : ''}
  ORDER BY cp.source_product_id,
    CASE WHEN kb.kb_key = 'product:' || cp.source_product_id THEN 0 ELSE 1 END,
    kb.last_success_at DESC NULLS LAST,
    kb.updated_at DESC NULLS LAST
),
candidates AS (
  SELECT *
  FROM latest_kb
  WHERE evidence_profile = 'seller_only'
    AND (
      nullif(seed_data->>'inci_list', '') IS NOT NULL
      OR nullif(seed_data->>'pdp_ingredients_raw', '') IS NOT NULL
      OR nullif(seed_data->>'raw_ingredient_text_clean', '') IS NOT NULL
      OR (seed_data ? 'ingredient_intel' AND seed_data->'ingredient_intel' <> '{}'::jsonb)
      OR nullif(seed_data->'snapshot'->>'inci_list', '') IS NOT NULL
      OR nullif(seed_data->'snapshot'->>'pdp_ingredients_raw', '') IS NOT NULL
      OR nullif(seed_data->'snapshot'->>'raw_ingredient_text_clean', '') IS NOT NULL
      OR (
        seed_data->'snapshot' ? 'ingredient_intel'
        AND seed_data->'snapshot'->'ingredient_intel' <> '{}'::jsonb
      )
    )
)
SELECT *
FROM candidates
${candidateFilters.length ? `WHERE ${candidateFilters.join('\n  AND ')}` : ''}
ORDER BY
  CASE WHEN seed_updated_at > COALESCE(last_success_at, kb_updated_at) THEN 0 ELSE 1 END,
  domain NULLS LAST,
  category_path NULLS LAST,
  source_product_id
${limitClause}
`;

  return { sql, params };
}

function extractPublishedBundleFromAnalysis(analysis) {
  const source = asPlainObject(analysis);
  if (!source) return null;
  return (
    asPlainObject(source.product_intel_v1) ||
    asPlainObject(source.product_intel) ||
    (normalizeText(source.contract_version) === 'pivota.product_intel.v1' ? source : null)
  );
}

function pickReviewProvenance(provenance, sourceMeta = null) {
  const source = asPlainObject(provenance) || {};
  const meta = asPlainObject(sourceMeta) || {};
  const out = {};
  for (const field of REVIEW_PROVENANCE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      out[field] = source[field];
    } else if (Object.prototype.hasOwnProperty.call(meta, field)) {
      out[field] = meta[field];
    }
  }
  return out;
}

function hasAnyReviewProvenance(reviewProvenance) {
  return Object.keys(asPlainObject(reviewProvenance) || {}).length > 0;
}

function readIntelSummary(bundle, sourceMeta = null, fallbackEvidenceProfile = '') {
  const source = asPlainObject(bundle) || {};
  const core = asPlainObject(source.product_intel_core) || {};
  const meta = asPlainObject(sourceMeta) || {};
  return {
    evidence_profile: normalizeLower(source.evidence_profile || core.evidence_profile || meta.evidence_profile || fallbackEvidenceProfile),
    source_coverage: asPlainObject(source.source_coverage) || asPlainObject(core.source_coverage) || asPlainObject(meta.source_coverage) || null,
    quality_state: normalizeLower(source.quality_state || core.quality_state || meta.quality_state),
  };
}

function inferCategoryLabel(categoryPath) {
  const parts = normalizeText(categoryPath)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || '';
}

function buildSeedRowForRuntime(row) {
  return {
    id: row.seed_id,
    external_product_id: row.external_product_id || row.source_product_id,
    destination_url: row.destination_url,
    canonical_url: row.canonical_url,
    domain: row.domain,
    title: row.title,
    image_url: row.image_url,
    price_amount: row.price_amount,
    price_currency: row.price_currency,
    availability: row.availability,
    seed_data: row.seed_data || {},
    status: row.seed_status || 'active',
    attached_product_key: row.attached_product_key,
    created_at: row.seed_created_at,
    updated_at: row.seed_updated_at,
  };
}

function buildProductLike(row, deps = {}) {
  const buildProduct = deps.buildExternalSeedProduct || buildExternalSeedProduct;
  const runtimeProduct = buildProduct(buildSeedRowForRuntime(row));
  if (!runtimeProduct) {
    throw new Error('buildExternalSeedProduct returned null');
  }
  const categoryLabel = inferCategoryLabel(row.category_path);
  return {
    ...runtimeProduct,
    product_key: row.product_key || runtimeProduct.product_key,
    source_product_id: row.source_product_id || runtimeProduct.source_product_id,
    external_product_id: row.external_product_id || row.source_product_id || runtimeProduct.external_product_id,
    pivota_signature_id: row.pivota_signature_id || runtimeProduct.pivota_signature_id,
    category_path: row.category_path || runtimeProduct.category_path,
    category: runtimeProduct.category || categoryLabel || undefined,
    updated_at: row.seed_updated_at || runtimeProduct.updated_at || row.kb_updated_at,
  };
}

function buildCanonicalProductRef(row) {
  return {
    merchant_id: 'external_seed',
    product_id: normalizeText(row.source_product_id || row.external_product_id),
  };
}

function overlayReviewProvenance(bundle, reviewProvenance) {
  const source = asPlainObject(bundle);
  if (!source) return null;
  const preserved = asPlainObject(reviewProvenance) || {};
  return {
    ...source,
    provenance: {
      ...(asPlainObject(source.provenance) || {}),
      ...preserved,
    },
  };
}

function detectLostReviewProvenance(existingReviewProvenance, projectedBundle) {
  const expected = asPlainObject(existingReviewProvenance) || {};
  const projected = asPlainObject(projectedBundle?.provenance) || {};
  const lostFields = [];
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (!Object.prototype.hasOwnProperty.call(projected, field)) {
      lostFields.push(field);
      continue;
    }
    if (JSON.stringify(projected[field]) !== JSON.stringify(expectedValue)) {
      lostFields.push(field);
    }
  }
  return lostFields;
}

function isSellerOnlyEvidenceProfile(profile) {
  return SELLER_ONLY_EVIDENCE_PROFILES.has(normalizeLower(profile));
}

function isGraduatedEvidenceProfile(profile) {
  return GRADUATED_EVIDENCE_PROFILES.has(normalizeLower(profile));
}

function classifyProjection({ before, after, projectedBundle, reviewProvenance, renderable }) {
  const lostReviewProvenanceFields = detectLostReviewProvenance(reviewProvenance, projectedBundle);
  const afterProfile = normalizeLower(after?.evidence_profile);
  const wouldGraduate = isGraduatedEvidenceProfile(afterProfile);

  if (lostReviewProvenanceFields.length) {
    return {
      classification: 'lost_review_provenance',
      evidence_classification: wouldGraduate ? 'would_graduate' : 'still_seller_only',
      would_graduate: wouldGraduate,
      would_publish: false,
      would_render_after_publish: false,
      lost_review_provenance_fields: lostReviewProvenanceFields,
      delta_status: 'blocked',
    };
  }

  if (isSellerOnlyEvidenceProfile(afterProfile)) {
    return {
      classification: 'still_seller_only',
      evidence_classification: 'still_seller_only',
      would_graduate: false,
      would_publish: false,
      would_render_after_publish: false,
      lost_review_provenance_fields: [],
      delta_status: 'no_delta',
    };
  }

  if (!wouldGraduate) {
    return {
      classification: 'still_seller_only',
      evidence_classification: 'still_seller_only',
      would_graduate: false,
      would_publish: false,
      would_render_after_publish: false,
      lost_review_provenance_fields: [],
      delta_status: before?.evidence_profile === afterProfile ? 'no_delta' : 'non_target_profile_delta',
    };
  }

  if (renderable) {
    return {
      classification: 'would_render_after_publish',
      evidence_classification: 'would_graduate',
      would_graduate: true,
      would_publish: true,
      would_render_after_publish: true,
      lost_review_provenance_fields: [],
      delta_status: 'profile_delta',
    };
  }

  const hasReview = hasAnyReviewProvenance(reviewProvenance);
  return {
    classification: 'would_not_render_even_if_published',
    evidence_classification: 'would_graduate',
    would_graduate: true,
    would_publish: false,
    would_render_after_publish: false,
    lost_review_provenance_fields: [],
    delta_status: 'profile_delta',
    render_rejection_hint: hasReview ? inferRenderRejectionHint(projectedBundle) : 'missing_review_provenance',
  };
}

function inferRenderRejectionHint(bundle) {
  const source = asPlainObject(bundle) || {};
  const provenance = asPlainObject(source.provenance) || {};
  const reviewDecision = normalizeLower(provenance.review_decision);
  if (reviewDecision === 'seller_only_fallback') return 'seller_only_fallback_review_decision';
  if (!isHumanReviewedProductIntelBundle(source)) return 'not_human_reviewed';
  return 'normalize_require_reviewed_rejected';
}

function buildProjectionForCandidate(row, deps = {}) {
  const buildDraft = deps.buildProductIntelDraftBundle || buildProductIntelDraftBundle;
  const normalizePublished = deps.normalizePublishedProductIntelBundle || normalizePublishedProductIntelBundle;
  const currentBundle = extractPublishedBundleFromAnalysis(row.analysis);
  const reviewProvenance = pickReviewProvenance(currentBundle?.provenance, row.source_meta);
  const product = buildProductLike(row, deps);
  const canonicalProductRef = buildCanonicalProductRef(row);
  const productGroupId = normalizeText(row.product_key) || null;
  const draftBundle = buildDraft({
    product,
    canonicalProductRef,
    productGroupId,
  });
  if (!draftBundle) throw new Error('buildProductIntelDraftBundle returned null');

  const projectedBundle = overlayReviewProvenance(draftBundle, reviewProvenance);
  const before = readIntelSummary(currentBundle, row.source_meta, row.evidence_profile);
  const after = readIntelSummary(projectedBundle);
  const renderable = Boolean(
    normalizePublished(projectedBundle, {
      canonicalProductRef,
      productGroupId,
      requireReviewed: true,
    }),
  );
  const classification = classifyProjection({
    before,
    after,
    projectedBundle,
    reviewProvenance,
    renderable,
  });

  return {
    kb_key: row.kb_key,
    source_product_id: row.source_product_id,
    external_product_id: row.external_product_id,
    pivota_signature_id: row.pivota_signature_id,
    product_key: row.product_key,
    seed_id: row.seed_id,
    domain: row.domain,
    category_path: row.category_path,
    title: row.title,
    seed_updated_at: row.seed_updated_at,
    kb_updated_at: row.kb_updated_at,
    last_success_at: row.last_success_at,
    current_review_decision: row.review_decision || normalizeLower(reviewProvenance.review_decision),
    before,
    after,
    diff: {
      evidence_profile_changed: before.evidence_profile !== after.evidence_profile,
      source_coverage_changed: JSON.stringify(before.source_coverage || null) !== JSON.stringify(after.source_coverage || null),
      quality_state_changed: before.quality_state !== after.quality_state,
    },
    review_provenance_before: reviewProvenance,
    review_provenance_after: pickReviewProvenance(projectedBundle.provenance, row.source_meta),
    ...classification,
  };
}

function buildErrorProjection(row, err) {
  return {
    kb_key: row.kb_key,
    source_product_id: row.source_product_id,
    external_product_id: row.external_product_id,
    pivota_signature_id: row.pivota_signature_id,
    product_key: row.product_key,
    seed_id: row.seed_id,
    domain: row.domain,
    category_path: row.category_path,
    title: row.title,
    seed_updated_at: row.seed_updated_at,
    kb_updated_at: row.kb_updated_at,
    last_success_at: row.last_success_at,
    current_review_decision: row.review_decision || null,
    before: readIntelSummary(extractPublishedBundleFromAnalysis(row.analysis), row.source_meta, row.evidence_profile),
    after: {
      evidence_profile: null,
      source_coverage: null,
      quality_state: null,
    },
    diff: {
      evidence_profile_changed: false,
      source_coverage_changed: false,
      quality_state_changed: false,
    },
    review_provenance_before: pickReviewProvenance(extractPublishedBundleFromAnalysis(row.analysis)?.provenance, row.source_meta),
    review_provenance_after: {},
    classification: 'row_error',
    evidence_classification: 'row_error',
    would_graduate: false,
    would_publish: false,
    would_render_after_publish: false,
    lost_review_provenance_fields: [],
    delta_status: 'error',
    error: err?.message || String(err),
  };
}

function incrementNestedCount(map, key, classification) {
  const normalizedKey = normalizeText(key) || '(none)';
  if (!map[normalizedKey]) {
    map[normalizedKey] = {};
  }
  map[normalizedKey][classification] = (map[normalizedKey][classification] || 0) + 1;
}

function summarizeRows(rows) {
  const classifications = {};
  const evidenceClassifications = {};
  const byDomain = {};
  const byCategory = {};

  for (const name of CLASSIFICATIONS) {
    classifications[name] = 0;
  }

  for (const row of rows) {
    const classification = row.classification || 'row_error';
    classifications[classification] = (classifications[classification] || 0) + 1;
    const evidenceClassification = row.evidence_classification || classification;
    evidenceClassifications[evidenceClassification] = (evidenceClassifications[evidenceClassification] || 0) + 1;
    incrementNestedCount(byDomain, row.domain, classification);
    incrementNestedCount(byCategory, row.category_path, classification);
  }

  return {
    total_rows: rows.length,
    classifications,
    evidence_classifications: evidenceClassifications,
    would_graduate_total: rows.filter((row) => row.would_graduate).length,
    would_publish_total: rows.filter((row) => row.would_publish).length,
    lost_review_provenance_total: rows.filter((row) => row.classification === 'lost_review_provenance').length,
    by_domain: byDomain,
    by_category: byCategory,
  };
}

function buildReport({ rows, options, startedAt, finishedAt }) {
  return {
    contract_version: 'pivota.product_intel_seller_only_mode_a_dry_run.v1',
    generated_at: finishedAt,
    started_at: startedAt,
    mode: 'mode_a_deterministic_dry_run',
    guardrails: {
      dry_run: true,
      writes_implemented: false,
      llm_calls: false,
    },
    options: {
      limit: options.limit,
      domain: options.domain || null,
      category_prefix: options.categoryPrefix || null,
      sample_limit: options.sampleLimit,
      require_priority: Boolean(options.requirePriority),
      kb_key: options.kbKey || null,
    },
    summary: summarizeRows(rows),
    rows,
  };
}

function sortCrosstabEntries(crosstab) {
  return Object.entries(crosstab || {}).sort((a, b) => {
    const totalA = Object.values(a[1] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const totalB = Object.values(b[1] || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    if (totalA !== totalB) return totalB - totalA;
    return a[0].localeCompare(b[0]);
  });
}

function markdownTable(headers, rows) {
  const out = [];
  out.push(`| ${headers.join(' | ')} |`);
  out.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    out.push(`| ${row.map((cell) => normalizeMarkdownCell(cell)).join(' | ')} |`);
  }
  return out.join('\n');
}

function normalizeMarkdownCell(value) {
  return normalizeText(value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function renderClassificationCounts(summary) {
  const rows = Object.entries(summary.classifications || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([classification, count]) => [classification, count]);
  if (!rows.length) return '_No rows._';
  return markdownTable(['Classification', 'Count'], rows);
}

function renderEvidenceCounts(summary) {
  const rows = Object.entries(summary.evidence_classifications || {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([classification, count]) => [classification, count]);
  if (!rows.length) return '_No rows._';
  return markdownTable(['Evidence Classification', 'Count'], rows);
}

function renderCrosstab(crosstab, label) {
  const classifications = CLASSIFICATIONS.filter((classification) =>
    Object.values(crosstab || {}).some((counts) => counts[classification] > 0),
  );
  if (!classifications.length) return '_No rows._';
  const rows = sortCrosstabEntries(crosstab).map(([key, counts]) => [
    key,
    ...classifications.map((classification) => counts[classification] || 0),
  ]);
  return markdownTable([label, ...classifications], rows);
}

function renderSampleRows(rows, classification, sampleLimit) {
  const sample = rows.filter((row) => row.classification === classification).slice(0, sampleLimit);
  if (!sample.length) return '_No rows._';
  return markdownTable(
    ['kb_key', 'sig', 'domain', 'category', 'before', 'after', 'quality', 'publish'],
    sample.map((row) => [
      row.kb_key,
      row.pivota_signature_id,
      row.domain,
      row.category_path,
      row.before?.evidence_profile || '',
      row.after?.evidence_profile || '',
      `${row.before?.quality_state || ''} -> ${row.after?.quality_state || ''}`,
      row.would_publish ? 'yes' : 'no',
    ]),
  );
}

function renderMarkdownReport(report) {
  const lines = [];
  const summary = report.summary;
  lines.push('# Mode A stale seller_only product_intel dry-run');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push('Guardrails: dry-run only; no DB writes; no LLM calls; `--apply` is intentionally rejected in this PR.');
  lines.push('');
  lines.push('## Options');
  lines.push('');
  lines.push(markdownTable(['Option', 'Value'], Object.entries(report.options).map(([key, value]) => [key, value == null || value === '' ? '(none)' : value])));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`Rows analyzed: ${summary.total_rows}`);
  lines.push('');
  lines.push(renderClassificationCounts(summary));
  lines.push('');
  lines.push(`Would graduate evidence-profile rollup: ${summary.would_graduate_total}`);
  lines.push(`Would publish/render after Phase 2 write rollup: ${summary.would_publish_total}`);
  lines.push(`Lost review provenance: ${summary.lost_review_provenance_total}`);
  lines.push('');
  lines.push('## Evidence Graduation Rollup');
  lines.push('');
  lines.push(renderEvidenceCounts(summary));
  lines.push('');
  lines.push('## Domain x Classification');
  lines.push('');
  lines.push(renderCrosstab(summary.by_domain, 'Domain'));
  lines.push('');
  lines.push('## Category x Classification');
  lines.push('');
  lines.push(renderCrosstab(summary.by_category, 'Category'));
  lines.push('');
  lines.push('## Samples');
  for (const classification of CLASSIFICATIONS) {
    lines.push('');
    lines.push(`### ${classification}`);
    lines.push('');
    lines.push(renderSampleRows(report.rows, classification, report.options.sample_limit));
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function ensureParentDir(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, value, 'utf8');
}

function printRowDiff(row) {
  const beforeProfile = row.before?.evidence_profile || '(none)';
  const afterProfile = row.after?.evidence_profile || '(none)';
  const beforeQuality = row.before?.quality_state || '(none)';
  const afterQuality = row.after?.quality_state || '(none)';
  console.log(
    [
      '[dry-run]',
      row.classification,
      row.kb_key,
      row.domain || '(domain:none)',
      row.category_path || '(category:none)',
      `${beforeProfile}/${beforeQuality} -> ${afterProfile}/${afterQuality}`,
    ].join(' | '),
  );
}

async function loadCandidates(options) {
  const { sql, params } = buildCandidateQuery(options);
  const result = await query(sql, params);
  return result.rows || [];
}

async function run(options = parseArgs()) {
  if (options.apply) {
    console.error('writes not implemented in this PR');
    process.exitCode = 2;
    return null;
  }

  const startedAt = new Date().toISOString();
  const candidates = await loadCandidates(options);
  const rows = [];

  console.log(`[dry-run] selected ${candidates.length} candidate row(s)`);

  for (const candidate of candidates) {
    let projected;
    try {
      projected = buildProjectionForCandidate(candidate);
    } catch (err) {
      projected = buildErrorProjection(candidate, err);
    }
    rows.push(projected);
    printRowDiff(projected);
  }

  const finishedAt = new Date().toISOString();
  const report = buildReport({ rows, options, startedAt, finishedAt });

  if (options.outputJson) {
    writeJson(options.outputJson, report);
    console.log(`[dry-run] wrote JSON report: ${options.outputJson}`);
  }
  if (options.outputMd) {
    writeText(options.outputMd, renderMarkdownReport(report));
    console.log(`[dry-run] wrote Markdown report: ${options.outputMd}`);
  }
  if (!options.outputJson && !options.outputMd) {
    console.log(renderMarkdownReport(report));
  }

  return report;
}

if (require.main === module) {
  run()
    .catch((err) => {
      console.error(err?.stack || err?.message || String(err));
      process.exitCode = 1;
    })
    .finally(() => {
      closePool().catch(() => {});
    });
}

module.exports = {
  CLASSIFICATIONS,
  GRADUATED_EVIDENCE_PROFILES,
  REVIEW_PROVENANCE_FIELDS,
  SELLER_ONLY_EVIDENCE_PROFILES,
  buildCandidateQuery,
  buildErrorProjection,
  buildProductLike,
  buildProjectionForCandidate,
  buildReport,
  classifyProjection,
  detectLostReviewProvenance,
  extractPublishedBundleFromAnalysis,
  parseArgs,
  pickReviewProvenance,
  readIntelSummary,
  renderMarkdownReport,
  summarizeRows,
};
