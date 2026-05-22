#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { closePool, query, withClient } = require('../src/db');
const {
  buildProductIntelDraftBundle,
  isHumanReviewedProductIntelBundle,
  normalizePublishedProductIntelBundle,
} = require('../src/pdpProductIntel');
const { buildExternalSeedProduct } = require('../src/services/externalSeedProducts');

const DEFAULT_LIMIT = 50;
const DEFAULT_SAMPLE_LIMIT = 10;
const DEFAULT_APPLY_MAX_ROWS_PER_RUN = 100;
const DEFAULT_APPLY_MAX_PER_DOMAIN = 25;
const DEFAULT_APPLY_MAX_PER_CATEGORY = 0;
const DEFAULT_APPLY_WORKERS = 1;
const MAX_APPLY_WORKERS = 4;
const DEFAULT_RETRY_BUDGET = 2;
const DEFAULT_BACKOFF_MS = 250;
const CANARY_LIMIT = 50;
const CANARY_MAX_PER_DOMAIN = 10;
const CANARY_MAX_PER_CATEGORY = 15;
const CLASSIFIER_VERSION = 'ws_a_phase2_mode_a_v1';
const REANALYSIS_CRITERIA = 'ws_a_phase2_mode_a_v1';
const SOURCE_VERSION_SUFFIX = '+ws_a_phase2_reanalysis_2026_05_22';
const UPDATE_FAILURE_ABORT_THRESHOLD = 0.05;
const NORMALIZE_FAILURE_ABORT_THRESHOLD = 0.05;
const DISALLOWED_PROFILE_ABORT_THRESHOLD = 0.20;

const REVIEW_PROVENANCE_FIELDS = [
  'review_status',
  'review_decision',
  'review_tier',
  'reviewer',
  'reviewer_kind',
  'reviewed_at',
  'selection_strategy',
  'field_sources',
  'gemini_quality_gate',
  'gemini_model',
  'generator',
  'external_highlight_review_status',
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
  'seller_plus_refill',
  'seller_plus_accessory',
  'official_pdp_reviewed_size_inheritance',
]);

const CLASSIFICATIONS = [
  'would_render_after_publish',
  'would_not_render_even_if_published',
  'would_graduate',
  'still_seller_only',
  'lost_review_provenance',
  'row_error',
];

const APPLY_CLASSIFICATIONS = [
  ...CLASSIFICATIONS,
  'skipped_already_graduated',
  'skipped_already_attempted',
  'skipped_cap',
  'unsafe_write_blocked',
  'aborted',
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
  if (value == null || value === '') return fallback;
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
  const hasValue = (...names) => names.some((name) => values.has(name) || flags.has(name));

  const apply = hasFlag('apply');
  const canary = hasFlag('canary');
  const limitProvided = hasValue('limit');
  const rawLimit = parseInteger(getValue('limit'), apply ? 0 : DEFAULT_LIMIT, { min: 0, max: 100000 });
  const limit = canary ? CANARY_LIMIT : rawLimit;
  const maxRowsPerRun = canary
    ? CANARY_LIMIT
    : parseInteger(getValue('max-rows-per-run', 'maxRowsPerRun'), apply ? DEFAULT_APPLY_MAX_ROWS_PER_RUN : 0, {
        min: 0,
        max: 100000,
      });
  const maxPerDomain = canary
    ? CANARY_MAX_PER_DOMAIN
    : parseInteger(getValue('max-per-domain', 'maxPerDomain'), apply ? DEFAULT_APPLY_MAX_PER_DOMAIN : 0, {
        min: 0,
        max: 100000,
      });
  const maxPerCategory = canary
    ? CANARY_MAX_PER_CATEGORY
    : parseInteger(getValue('max-per-category', 'maxPerCategory'), DEFAULT_APPLY_MAX_PER_CATEGORY, {
        min: 0,
        max: 100000,
      });

  return {
    limit,
    domain: normalizeText(getValue('domain')),
    categoryPrefix: normalizeText(getValue('category-prefix', 'categoryPrefix')),
    sampleLimit: parseInteger(getValue('sample-limit', 'sampleLimit'), DEFAULT_SAMPLE_LIMIT, { min: 0, max: 1000 }),
    outputJson: normalizeText(getValue('output-json', 'outputJson')),
    outputMd: normalizeText(getValue('output-md', 'outputMd')),
    requirePriority: hasFlag('require-priority', 'requirePriority'),
    apply,
    canary,
    maxPerDomain,
    maxPerCategory,
    maxRowsPerRun,
    workers: parseInteger(getValue('workers'), DEFAULT_APPLY_WORKERS, { min: 1, max: MAX_APPLY_WORKERS }),
    retryBudget: parseInteger(getValue('retry-budget', 'retryBudget'), DEFAULT_RETRY_BUDGET, { min: 0, max: 20 }),
    backoffMs: parseInteger(getValue('backoff-ms', 'backoffMs'), DEFAULT_BACKOFF_MS, { min: 0, max: 60000 }),
    snapshotDir: normalizeText(getValue('snapshot-dir', 'snapshotDir')),
    batchId: normalizeText(getValue('batch-id', 'batchId')),
    dryRunCompanionJson: normalizeText(getValue('dry-run-companion-json', 'dryRunCompanionJson')),
    forceResumeRow: normalizeText(getValue('force-resume-row', 'forceResumeRow')),
    limitProvided,
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
  const kbKeys = Array.isArray(options.kbKeys)
    ? Array.from(new Set(options.kbKeys.map(normalizeText).filter(Boolean)))
    : [];
  if (kbKeys.length) {
    latestFilters.push(`kb.kb_key = ANY(${pushParam(params, kbKeys)}::text[])`);
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
  WHERE ${
    options.includeNonSellerOnly
      ? 'TRUE'
      : `evidence_profile = 'seller_only'
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
    )`
  }
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

function deepCloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function appendSourceVersionSuffix(sourceVersion) {
  const current = normalizeText(sourceVersion) || 'pivota.product_intel.v1';
  if (current.includes(SOURCE_VERSION_SUFFIX)) return current;
  return `${current}${SOURCE_VERSION_SUFFIX}`;
}

function safeFileSegment(value) {
  return normalizeText(value).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 180) || 'row';
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

function buildPreImage(row) {
  return {
    kb_key: row.kb_key,
    analysis: deepCloneJson(row.analysis || {}),
    source_meta: deepCloneJson(row.source_meta || null),
    last_success_at: row.last_success_at || null,
    kb_updated_at: row.kb_updated_at || row.updated_at || null,
    source_product_id: row.source_product_id || null,
    external_product_id: row.external_product_id || null,
    pivota_signature_id: row.pivota_signature_id || null,
    product_key: row.product_key || null,
    seed_id: row.seed_id || null,
    seed_updated_at: row.seed_updated_at || null,
  };
}

function buildReanalysisAudit({ batchId, ranAt, classifierVersion, evidenceProfileBefore, evidenceProfileAfter }) {
  return {
    batch_id: batchId,
    ran_at: ranAt,
    evidence_profile_before: evidenceProfileBefore || null,
    evidence_profile_after: evidenceProfileAfter || null,
    classifier_version: classifierVersion,
  };
}

function appendAuditBlock(existing, auditBlock) {
  const source = asPlainObject(existing) || {};
  const existingAudit = source.reanalysis_audit;
  let reanalysisAudit = auditBlock;
  if (Array.isArray(existingAudit)) {
    reanalysisAudit = [...existingAudit, auditBlock];
  } else if (asPlainObject(existingAudit)) {
    reanalysisAudit = [existingAudit, auditBlock];
  }
  return {
    ...source,
    reanalysis_audit: reanalysisAudit,
  };
}

function buildModeAWriteBundle({ row, projection, batchId, ranAt, preImageHash, classifierVersion = CLASSIFIER_VERSION }) {
  const currentBundle = extractPublishedBundleFromAnalysis(row.analysis);
  if (!currentBundle) throw new Error('missing_product_intel_v1_bundle');
  const bundle = deepCloneJson(currentBundle);
  const afterProfile = normalizeLower(projection?.after?.evidence_profile);
  const afterQuality = normalizeLower(projection?.after?.quality_state);
  const afterSourceCoverage = asPlainObject(projection?.after?.source_coverage)
    ? deepCloneJson(projection.after.source_coverage)
    : null;
  const core = asPlainObject(bundle.product_intel_core) ? deepCloneJson(bundle.product_intel_core) : {};
  const freshnessSource = asPlainObject(bundle.freshness) || asPlainObject(core.freshness) || {};
  const preservedReviewProvenance = pickReviewProvenance(currentBundle.provenance, row.source_meta);

  return {
    ...bundle,
    evidence_profile: afterProfile,
    source_coverage: afterSourceCoverage,
    quality_state: afterQuality,
    product_intel_core: {
      ...core,
      evidence_profile: afterProfile,
      quality_state: afterQuality,
    },
    freshness: {
      ...deepCloneJson(freshnessSource),
      source_version: appendSourceVersionSuffix(freshnessSource.source_version),
    },
    provenance: {
      ...(asPlainObject(bundle.provenance) || {}),
      ...preservedReviewProvenance,
      reanalysis_meta: {
        batch_id: batchId,
        ran_at: ranAt,
        classifier_version: classifierVersion,
        pre_image_hash: preImageHash,
        criteria: REANALYSIS_CRITERIA,
      },
    },
  };
}

function buildUpdatedAnalysis(row, newBundle) {
  const analysis = asPlainObject(row.analysis) ? deepCloneJson(row.analysis) : {};
  analysis.product_intel_v1 = newBundle;
  return analysis;
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

function summarizeRows(rows, options = {}) {
  const classificationOrder = Array.isArray(options.classifications) && options.classifications.length
    ? options.classifications
    : CLASSIFICATIONS;
  const classifications = {};
  const evidenceClassifications = {};
  const byDomain = {};
  const byCategory = {};

  for (const name of classificationOrder) {
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

  const summary = {
    total_rows: rows.length,
    classifications,
    evidence_classifications: evidenceClassifications,
    would_graduate_total: rows.filter((row) => row.would_graduate).length,
    would_publish_total: rows.filter((row) => row.would_publish).length,
    lost_review_provenance_total: rows.filter((row) => row.classification === 'lost_review_provenance').length,
    by_domain: byDomain,
    by_category: byCategory,
  };
  if (options.includeFentyRollup) {
    const fentyCounts = {};
    for (const row of rows) {
      const domain = normalizeLower(row.domain);
      if (domain !== 'fentybeauty.com' && domain !== 'www.fentybeauty.com') continue;
      const classification = row.classification || 'row_error';
      fentyCounts[classification] = (fentyCounts[classification] || 0) + 1;
    }
    summary.fenty_rollup = fentyCounts;
  }
  return summary;
}

function buildReport({ rows, options, startedAt, finishedAt }) {
  const applyMode = Boolean(options.apply);
  const classificationOrder = applyMode ? APPLY_CLASSIFICATIONS : CLASSIFICATIONS;
  return {
    contract_version: applyMode
      ? 'pivota.product_intel_seller_only_mode_a_apply.v1'
      : 'pivota.product_intel_seller_only_mode_a_dry_run.v1',
    generated_at: finishedAt,
    started_at: startedAt,
    mode: applyMode ? 'mode_a_deterministic_apply' : 'mode_a_deterministic_dry_run',
    guardrails: {
      dry_run: !applyMode,
      writes_implemented: applyMode,
      llm_calls: false,
      publish_enabled: applyMode ? isPublishEnabled() : false,
    },
    options: {
      limit: options.limit,
      domain: options.domain || null,
      category_prefix: options.categoryPrefix || null,
      sample_limit: options.sampleLimit,
      require_priority: Boolean(options.requirePriority),
      kb_key: options.kbKey || null,
      ...(applyMode
        ? {
            canary: Boolean(options.canary),
            max_per_domain: options.maxPerDomain,
            max_per_category: options.maxPerCategory,
            max_rows_per_run: options.maxRowsPerRun,
            workers: options.workers,
            retry_budget: options.retryBudget,
            backoff_ms: options.backoffMs,
            snapshot_dir: options.snapshotDir || null,
            batch_id: options.batchId || null,
            dry_run_companion_json: options.dryRunCompanionJson || null,
            force_resume_row: options.forceResumeRow || null,
          }
        : {}),
    },
    classification_order: applyMode ? classificationOrder : undefined,
    summary: summarizeRows(rows, {
      classifications: classificationOrder,
      includeFentyRollup: applyMode,
    }),
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

function renderCrosstab(crosstab, label, classificationOrder = CLASSIFICATIONS) {
  const classifications = classificationOrder.filter((classification) =>
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
  const applyMode = report.mode === 'mode_a_deterministic_apply';
  const classificationOrder = Array.isArray(report.classification_order) && report.classification_order.length
    ? report.classification_order
    : CLASSIFICATIONS;
  lines.push(applyMode ? '# Mode A stale seller_only product_intel apply report' : '# Mode A stale seller_only product_intel dry-run');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push(
    applyMode
      ? `Guardrails: apply mode; no LLM calls; publish kill switch ${
          report.guardrails?.publish_enabled ? 'enabled' : 'disabled'
        }; writes require row-level snapshots.`
      : 'Guardrails: dry-run only; no DB writes; no LLM calls.',
  );
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
  lines.push(renderCrosstab(summary.by_domain, 'Domain', classificationOrder));
  lines.push('');
  lines.push('## Category x Classification');
  lines.push('');
  lines.push(renderCrosstab(summary.by_category, 'Category', classificationOrder));
  if (applyMode) {
    lines.push('');
    lines.push('## Fenty Rollup');
    lines.push('');
    const fentyRows = Object.entries(summary.fenty_rollup || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([classification, count]) => [classification, count]);
    lines.push(fentyRows.length ? markdownTable(['Classification', 'Count'], fentyRows) : '_No Fenty rows._');
  }
  lines.push('');
  lines.push('## Samples');
  for (const classification of classificationOrder) {
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

function fsyncDir(dirPath) {
  let fd = null;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch (_err) {
    // Some filesystems do not support directory fsync; the file fsync + rename is the critical path.
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_err) {
        // ignore best-effort close failure
      }
    }
  }
}

function writeJsonAtomic(filePath, value) {
  ensureParentDir(filePath);
  const resolved = path.resolve(filePath);
  const tmpPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, resolved);
    fsyncDir(path.dirname(resolved));
  } catch (err) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_closeErr) {
        // keep original error
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch (_unlinkErr) {
      // ignore cleanup failure
    }
    throw err;
  }
}

function appendJsonLine(filePath, value) {
  ensureParentDir(filePath);
  const fd = fs.openSync(path.resolve(filePath), 'a');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function buildPreImageSnapshotPath(snapshotDir, batchId, kbKey) {
  return path.join(path.resolve(snapshotDir), `${safeFileSegment(batchId)}__${safeFileSegment(kbKey)}.json`);
}

function buildPostImageJsonlPath(snapshotDir, batchId) {
  return path.join(path.resolve(snapshotDir), `${safeFileSegment(batchId)}__post.jsonl`);
}

function buildAbortedJsonPath(snapshotDir, batchId) {
  return path.join(path.resolve(snapshotDir), `${safeFileSegment(batchId)}__aborted.json`);
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

async function loadCandidates(options, deps = {}) {
  if (typeof deps.loadCandidates === 'function') return deps.loadCandidates(options);
  const { sql, params } = buildCandidateQuery(options);
  const result = await (deps.query || query)(sql, params);
  return result.rows || [];
}

function isEnvFalse(value) {
  return normalizeLower(value) === 'false';
}

function isReanalysisEnabled() {
  return !isEnvFalse(process.env.PIVOTA_INSIGHTS_REANALYSIS_ENABLED);
}

function isPublishEnabled() {
  return !isEnvFalse(process.env.PIVOTA_INSIGHTS_REANALYSIS_PUBLISH_ENABLED);
}

function validateApplyOptions(options) {
  if (!options.apply) return;
  if (options.canary && options.limitProvided) throw new Error('--canary is mutually exclusive with --limit');
  if (!options.batchId) throw new Error('--batch-id is required when --apply is used');
  if (!options.snapshotDir) throw new Error('--snapshot-dir is required when --apply is used');
}

function loadDryRunCompanionEligibility(filePath) {
  if (!filePath) return null;
  const payload = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  const rows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload) ? payload : [];
  const eligible = new Map();
  for (const row of rows) {
    const kbKey = normalizeText(row?.kb_key);
    if (kbKey && row?.classification === 'would_render_after_publish') eligible.set(kbKey, row);
  }
  return { file_path: filePath, eligible, eligible_keys: Array.from(eligible.keys()) };
}

function buildApplyCandidateOptions(options, companion) {
  return {
    ...options,
    limit: options.limitProvided ? options.limit : 0,
    includeNonSellerOnly: Boolean(companion),
    kbKeys: companion?.eligible_keys || undefined,
  };
}

function createQuotaTracker(options) {
  const domainCounts = new Map();
  const categoryCounts = new Map();
  let total = 0;
  const domainKey = (row) => normalizeLower(row?.domain) || '(none)';
  const categoryKey = (row) => normalizeText(row?.category_path) || '(none)';
  return {
    isGlobalFull() {
      const maxRows = Number(options.maxRowsPerRun || 0);
      return maxRows > 0 && total >= maxRows;
    },
    precheck(row) {
      const maxDomain = Number(options.maxPerDomain || 0);
      const maxCategory = Number(options.maxPerCategory || 0);
      const domain = domainKey(row);
      const category = categoryKey(row);
      if (maxDomain > 0 && (domainCounts.get(domain) || 0) >= maxDomain) return 'max_per_domain';
      if (maxCategory > 0 && (categoryCounts.get(category) || 0) >= maxCategory) return 'max_per_category';
      return null;
    },
    checkAndConsume(row) {
      const maxRows = Number(options.maxRowsPerRun || 0);
      const maxDomain = Number(options.maxPerDomain || 0);
      const maxCategory = Number(options.maxPerCategory || 0);
      const domain = domainKey(row);
      const category = categoryKey(row);
      if (maxRows > 0 && total >= maxRows) return { allowed: false, reason: 'max_rows_per_run' };
      if (maxDomain > 0 && (domainCounts.get(domain) || 0) >= maxDomain) return { allowed: false, reason: 'max_per_domain' };
      if (maxCategory > 0 && (categoryCounts.get(category) || 0) >= maxCategory) return { allowed: false, reason: 'max_per_category' };
      total += 1;
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      return { allowed: true, reason: null };
    },
  };
}

function buildRowEvent({ row, projection = null, classification, batchId, startedAtMs, error = null, extra = {} }) {
  const before = projection?.before || readIntelSummary(extractPublishedBundleFromAnalysis(row?.analysis), row?.source_meta, row?.evidence_profile);
  const after = projection?.after || {};
  const reviewPreserved = projection
    ? detectLostReviewProvenance(projection.review_provenance_before, { provenance: projection.review_provenance_after }).length === 0
    : null;
  return {
    ts: new Date().toISOString(),
    batch_id: batchId || null,
    kb_key: row?.kb_key || projection?.kb_key || null,
    domain: row?.domain || projection?.domain || null,
    category: row?.category_path || projection?.category_path || null,
    classification,
    evidence_profile_before: before?.evidence_profile || null,
    evidence_profile_after: after?.evidence_profile || null,
    quality_state_before: before?.quality_state || null,
    quality_state_after: after?.quality_state || null,
    review_provenance_preserved: reviewPreserved,
    elapsed_ms: Math.max(0, Date.now() - startedAtMs),
    error: error ? normalizeText(error?.message || error) : null,
    ...extra,
  };
}

function eventToReportRow(event, projection = null) {
  const afterProfile = normalizeLower(event.evidence_profile_after);
  const wouldGraduate = isGraduatedEvidenceProfile(afterProfile);
  return {
    ...(projection || {}),
    kb_key: event.kb_key,
    domain: event.domain,
    category_path: event.category,
    classification: event.classification,
    evidence_classification: projection?.evidence_classification || (wouldGraduate ? 'would_graduate' : event.classification),
    would_graduate: projection?.would_graduate ?? wouldGraduate,
    would_publish: projection?.would_publish ?? event.classification === 'would_render_after_publish',
    would_render_after_publish: projection?.would_render_after_publish ?? event.classification === 'would_render_after_publish',
    before: {
      evidence_profile: event.evidence_profile_before,
      quality_state: event.quality_state_before,
      source_coverage: projection?.before?.source_coverage || null,
    },
    after: {
      evidence_profile: event.evidence_profile_after,
      quality_state: event.quality_state_after,
      source_coverage: projection?.after?.source_coverage || null,
    },
    review_provenance_preserved: event.review_provenance_preserved,
    error: event.error,
  };
}

function emitApplyEvent(event, deps = {}) {
  const output = deps.stdout || process.stdout;
  output.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryRow(fn, options) {
  let lastErr = null;
  const retryBudget = Number(options.retryBudget || 0);
  const backoffMs = Number(options.backoffMs || 0);
  for (let attempt = 0; attempt <= retryBudget; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retryBudget) break;
      await sleep(backoffMs * (2 ** attempt));
    }
  }
  throw lastErr;
}

async function fetchFreshCandidateForUpdate(client, candidate) {
  const result = await client.query(
    `
      SELECT
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
      FROM aurora_product_intel_kb kb
      JOIN catalog_products cp
        ON cp.catalog_track = 'external_referral'
       AND kb.kb_key IN ('product:' || cp.source_product_id, 'product:' || cp.pivota_signature_id)
      JOIN external_product_seeds eps
        ON eps.status = 'active'
       AND eps.external_product_id = cp.source_product_id
      WHERE kb.kb_key = $1
        AND cp.source_product_id = $2
      ORDER BY
        CASE WHEN kb.kb_key = 'product:' || cp.source_product_id THEN 0 ELSE 1 END,
        kb.last_success_at DESC NULLS LAST,
        kb.updated_at DESC NULLS LAST
      LIMIT 1
      FOR UPDATE OF kb
    `,
    [candidate.kb_key, candidate.source_product_id],
  );
  return result.rows?.[0] || null;
}

function isAllowedPublishedProfile(profile) {
  return GRADUATED_EVIDENCE_PROFILES.has(normalizeLower(profile));
}

function shouldAbortRun(stats) {
  const attempted = Math.max(0, Number(stats.attempted || 0));
  if (!attempted) return null;
  if ((stats.updateFailures || 0) / attempted > UPDATE_FAILURE_ABORT_THRESHOLD) return 'update_failure_rate_exceeded';
  if ((stats.normalizeFailures || 0) / attempted > NORMALIZE_FAILURE_ABORT_THRESHOLD) return 'normalize_failure_rate_exceeded';
  if ((stats.disallowedProfiles || 0) / attempted > DISALLOWED_PROFILE_ABORT_THRESHOLD) return 'disallowed_profile_rate_exceeded';
  return null;
}

async function applyCandidate(candidate, context, deps = {}) {
  const startedAtMs = Date.now();
  const options = context.options;
  const batchId = options.batchId;
  const snapshotPath = buildPreImageSnapshotPath(options.snapshotDir, batchId, candidate.kb_key);
  const forceResume = options.forceResumeRow && options.forceResumeRow === candidate.kb_key;

  if (context.abortRequested || !isReanalysisEnabled()) {
    context.abortRequested = true;
    context.abortReason = context.abortReason || 'PIVOTA_INSIGHTS_REANALYSIS_ENABLED=false';
    return buildRowEvent({ row: candidate, classification: 'aborted', batchId, startedAtMs, error: context.abortReason });
  }
  if (!forceResume && fs.existsSync(snapshotPath)) {
    return buildRowEvent({ row: candidate, classification: 'skipped_already_attempted', batchId, startedAtMs, extra: { skip_reason: 'snapshot_exists', snapshot_path: snapshotPath } });
  }

  const withClientFn = deps.withClient || withClient;
  let updateFailed = false;
  let updateAttempted = false;
  let normalizeFailed = false;
  let disallowedProfile = false;

  try {
    return await retryRow(async () => withClientFn(async (client) => {
      let transactionOpen = false;
      let committed = false;
      let fresh = null;
      let projection = null;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        fresh = await fetchFreshCandidateForUpdate(client, candidate);
        if (!fresh) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: candidate, classification: 'skipped_already_graduated', batchId, startedAtMs, extra: { skip_reason: 'fresh_candidate_missing' } });
        }
        const currentSummary = readIntelSummary(extractPublishedBundleFromAnalysis(fresh.analysis), fresh.source_meta, fresh.evidence_profile);
        if (!isSellerOnlyEvidenceProfile(currentSummary.evidence_profile)) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, classification: 'skipped_already_graduated', batchId, startedAtMs, extra: { skip_reason: 'evidence_profile_not_seller_only' } });
        }
        projection = buildProjectionForCandidate(fresh, deps);
        const companionEligible = context.companion?.eligible;
        if (companionEligible && !companionEligible.has(fresh.kb_key)) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection, classification: 'skipped_cap', batchId, startedAtMs, extra: { skip_reason: 'not_in_dry_run_companion' } });
        }
        if (projection.classification !== 'would_render_after_publish') {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({
            row: fresh,
            projection,
            classification: companionEligible ? 'unsafe_write_blocked' : projection.classification,
            batchId,
            startedAtMs,
            error: companionEligible ? `dry_run_companion_mismatch:${projection.classification}` : null,
          });
        }
        const quota = context.quota.checkAndConsume(fresh);
        if (!quota.allowed) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection, classification: 'skipped_cap', batchId, startedAtMs, extra: { skip_reason: quota.reason } });
        }
        context.stats.attempted += 1;
        const preImage = buildPreImage(fresh);
        const preImageHash = sha256Json(preImage);
        const ranAt = new Date().toISOString();
        const newBundle = buildModeAWriteBundle({ row: fresh, projection, batchId, ranAt, preImageHash });
        const newSummary = readIntelSummary(newBundle);
        if (isSellerOnlyEvidenceProfile(newSummary.evidence_profile)) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection, classification: 'unsafe_write_blocked', batchId, startedAtMs, error: 'seller_only_write_blocked' });
        }
        if (!isAllowedPublishedProfile(newSummary.evidence_profile)) {
          disallowedProfile = true;
          context.stats.disallowedProfiles += 1;
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection, classification: 'unsafe_write_blocked', batchId, startedAtMs, error: `disallowed_evidence_profile:${newSummary.evidence_profile || '(none)'}` });
        }
        const lostReviewFields = detectLostReviewProvenance(projection.review_provenance_before, newBundle);
        if (lostReviewFields.length) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection, classification: 'unsafe_write_blocked', batchId, startedAtMs, error: `lost_review_provenance:${lostReviewFields.join(',')}` });
        }
        const normalizedPostWrite = (deps.normalizePublishedProductIntelBundle || normalizePublishedProductIntelBundle)(newBundle, {
          canonicalProductRef: buildCanonicalProductRef(fresh),
          productGroupId: normalizeText(fresh.product_key) || null,
          requireReviewed: true,
        });
        if (!normalizedPostWrite) {
          normalizeFailed = true;
          context.stats.normalizeFailures += 1;
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection, classification: 'unsafe_write_blocked', batchId, startedAtMs, error: 'post_write_normalize_rejected' });
        }
        writeJsonAtomic(snapshotPath, { batch_id: batchId, ran_at: ranAt, classifier_version: CLASSIFIER_VERSION, criteria: REANALYSIS_CRITERIA, pre_image_hash: preImageHash, pre_image: preImage });
        const nextAnalysis = buildUpdatedAnalysis(fresh, newBundle);
        const nextSourceMeta = appendAuditBlock(fresh.source_meta, buildReanalysisAudit({
          batchId,
          ranAt,
          classifierVersion: CLASSIFIER_VERSION,
          evidenceProfileBefore: projection.before?.evidence_profile,
          evidenceProfileAfter: newSummary.evidence_profile,
        }));
        if (!isPublishEnabled()) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return buildRowEvent({ row: fresh, projection: { ...projection, after: newSummary }, classification: 'would_render_after_publish', batchId, startedAtMs, extra: { publish_enabled: false, snapshot_path: snapshotPath } });
        }
        if (context.abortRequested || !isReanalysisEnabled()) throw new Error(context.abortReason || 'reanalysis_disabled_before_update');
        updateAttempted = true;
        const updateResult = await client.query(
          `
            UPDATE aurora_product_intel_kb
            SET analysis = $2::jsonb,
                source_meta = $3::jsonb,
                last_success_at = now(),
                updated_at = now()
            WHERE kb_key = $1
            RETURNING kb_key, analysis, source_meta, last_success_at, updated_at
          `,
          [fresh.kb_key, JSON.stringify(nextAnalysis), JSON.stringify(nextSourceMeta)],
        );
        if (!updateResult.rowCount) {
          updateFailed = true;
          throw new Error('update_returned_zero_rows');
        }
        await client.query('COMMIT');
        committed = true;
        transactionOpen = false;
        appendJsonLine(buildPostImageJsonlPath(options.snapshotDir, batchId), {
          batch_id: batchId,
          ran_at: ranAt,
          kb_key: fresh.kb_key,
          pre_image_hash: preImageHash,
          post_image: updateResult.rows?.[0] || { kb_key: fresh.kb_key, analysis: nextAnalysis, source_meta: nextSourceMeta },
        });
        return buildRowEvent({ row: fresh, projection: { ...projection, after: newSummary }, classification: 'would_render_after_publish', batchId, startedAtMs, extra: { publish_enabled: true, snapshot_path: snapshotPath } });
      } catch (err) {
        if (transactionOpen && !committed) {
          try {
            await client.query('ROLLBACK');
          } catch (_rollbackErr) {
            // preserve original error
          }
        }
        if (updateAttempted || /update/i.test(err?.message || '')) updateFailed = true;
        throw err;
      }
    }), options);
  } catch (err) {
    if (updateFailed) context.stats.updateFailures += 1;
    return buildRowEvent({ row: candidate, classification: context.abortRequested ? 'aborted' : 'row_error', batchId, startedAtMs, error: err, extra: { update_failed: updateFailed, normalize_failed: normalizeFailed, disallowed_profile: disallowedProfile } });
  }
}

async function runApply(options, deps = {}) {
  validateApplyOptions(options);
  if (!isReanalysisEnabled()) return null;
  const startedAt = new Date().toISOString();
  const companion = loadDryRunCompanionEligibility(options.dryRunCompanionJson);
  const candidateOptions = buildApplyCandidateOptions(options, companion);
  const candidates = companion && !companion.eligible_keys.length ? [] : await loadCandidates(candidateOptions, deps);
  const rows = [];
  const context = {
    options,
    companion,
    quota: createQuotaTracker(options),
    stats: { attempted: 0, updateFailures: 0, normalizeFailures: 0, disallowedProfiles: 0 },
    abortRequested: false,
    abortReason: null,
  };
  const signalHandler = (signal) => {
    context.abortRequested = true;
    context.abortReason = `signal:${signal}`;
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);
  let nextIndex = 0;
  async function workerLoop() {
    while (nextIndex < candidates.length) {
      if (context.abortRequested || context.quota.isGlobalFull()) break;
      if (!isReanalysisEnabled()) {
        context.abortRequested = true;
        context.abortReason = context.abortReason || 'PIVOTA_INSIGHTS_REANALYSIS_ENABLED=false';
        break;
      }
      const index = nextIndex;
      nextIndex += 1;
      const candidate = candidates[index];
      const preCapReason = context.quota.precheck(candidate);
      const event = preCapReason
        ? buildRowEvent({ row: candidate, classification: 'skipped_cap', batchId: options.batchId, startedAtMs: Date.now(), extra: { skip_reason: preCapReason, prechecked: true } })
        : await applyCandidate(candidate, context, deps);
      rows.push(eventToReportRow(event));
      emitApplyEvent(event, deps);
      const abortReason = shouldAbortRun(context.stats);
      if (abortReason) {
        context.abortRequested = true;
        context.abortReason = abortReason;
      }
    }
  }
  try {
    const workers = Math.max(1, Math.min(MAX_APPLY_WORKERS, Number(options.workers || 1)));
    await Promise.all(Array.from({ length: workers }, () => workerLoop()));
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
  }
  if (context.abortRequested && options.snapshotDir && options.batchId) {
    writeJsonAtomic(buildAbortedJsonPath(options.snapshotDir, options.batchId), {
      batch_id: options.batchId,
      aborted_at: new Date().toISOString(),
      reason: context.abortReason || 'aborted',
      stats: context.stats,
      processed_rows: rows.length,
    });
    const event = buildRowEvent({ row: {}, classification: 'aborted', batchId: options.batchId, startedAtMs: Date.now(), error: context.abortReason || 'aborted', extra: { stats: context.stats } });
    rows.push(eventToReportRow(event));
    emitApplyEvent(event, deps);
  }
  const finishedAt = new Date().toISOString();
  const report = buildReport({ rows, options, startedAt, finishedAt });
  report.apply_stats = context.stats;
  report.aborted = Boolean(context.abortRequested);
  report.abort_reason = context.abortReason || null;
  if (options.outputJson) writeJson(options.outputJson, report);
  if (options.outputMd) writeText(options.outputMd, renderMarkdownReport(report));
  return report;
}

async function run(options = parseArgs(), deps = {}) {
  if (options.apply) return runApply(options, deps);
  if (!isReanalysisEnabled()) return null;
  const startedAt = new Date().toISOString();
  const candidates = await loadCandidates(options, deps);
  const rows = [];

  console.log(`[dry-run] selected ${candidates.length} candidate row(s)`);
  for (const candidate of candidates) {
    let projected;
    try {
      projected = buildProjectionForCandidate(candidate, deps);
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
  if (!options.outputJson && !options.outputMd) console.log(renderMarkdownReport(report));
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
  APPLY_CLASSIFICATIONS,
  CLASSIFIER_VERSION,
  buildCandidateQuery,
  buildErrorProjection,
  buildModeAWriteBundle,
  buildPreImageSnapshotPath,
  buildProductLike,
  buildProjectionForCandidate,
  buildReport,
  buildUpdatedAnalysis,
  classifyProjection,
  detectLostReviewProvenance,
  extractPublishedBundleFromAnalysis,
  loadDryRunCompanionEligibility,
  parseArgs,
  pickReviewProvenance,
  readIntelSummary,
  renderMarkdownReport,
  run,
  summarizeRows,
};
