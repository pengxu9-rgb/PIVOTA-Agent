#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');

const SYNTHETIC_REVIEW_SOURCE_RE =
  /(?:pivota[_-]?force[_-]?fill|force[_-]?filled?|force[_-]?fill|synthetic|estimated|estimate|generated|mock|placeholder|demo)/i;
const SOURCE_BACKED_REVIEW_RE =
  /(?:official|merchant|origin|yotpo|okendo|stamped|bazaarvoice|powerreviews|judge\.?me|shopify|json[_-]?ld|reviews?[_-]?api|rendered[_-]?html)/i;

const SEED_REVIEW_PATHS = [
  ['review_summary'],
  ['pdp_review_summary'],
  ['snapshot', 'review_summary'],
  ['snapshot', 'pdp_review_summary'],
];

const PAYLOAD_REVIEW_PATHS = [
  ['review_summary'],
  ['pdp_review_summary'],
  ['seed_data', 'review_summary'],
  ['seed_data', 'pdp_review_summary'],
  ['seed_data', 'snapshot', 'review_summary'],
  ['seed_data', 'snapshot', 'pdp_review_summary'],
];

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return '';
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return '';
  return String(value).trim();
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseDelimitedIds(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function readIdsFile(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized) return [];
  return parseDelimitedIds(fs.readFileSync(normalized, 'utf8'));
}

function getByPath(source, parts) {
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim().replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function reviewCount(summary) {
  return Math.max(
    0,
    toNumber(summary?.review_count),
    toNumber(summary?.reviewCount),
    toNumber(summary?.count),
    toNumber(summary?.total_reviews),
    toNumber(summary?.totalReviews),
  );
}

function reviewRating(summary) {
  return Math.max(
    0,
    toNumber(summary?.rating),
    toNumber(summary?.average_rating),
    toNumber(summary?.averageRating),
    toNumber(summary?.avg_rating),
  );
}

function previewCount(summary) {
  return asArray(summary?.preview_items || summary?.reviews || summary?.items).length;
}

function reviewSourceSignals(summary) {
  const object = ensureObject(summary);
  return [
    object.source,
    object.source_origin,
    object.sourceOrigin,
    object.source_kind,
    object.sourceKind,
    object.review_source,
    object.reviewSource,
    object.source_type,
    object.sourceType,
    object.status,
    object.content_review_state,
    object.contentReviewState,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function isSyntheticReviewSummary(summary) {
  const object = ensureObject(summary);
  if (!Object.keys(object).length) return false;
  if (
    object.force_filled === true ||
    object.forceFilled === true ||
    object.distribution_estimated === true ||
    object.distributionEstimated === true ||
    object.approved_estimate === true ||
    object.approvedEstimate === true
  ) {
    return true;
  }
  return SYNTHETIC_REVIEW_SOURCE_RE.test(reviewSourceSignals(object));
}

function hasPublicReviewSignal(summary) {
  return reviewCount(summary) > 0 || reviewRating(summary) > 0 || previewCount(summary) > 0;
}

function isSourceBackedReviewSummary(summary) {
  const object = ensureObject(summary);
  if (!Object.keys(object).length || isSyntheticReviewSummary(object)) return false;
  return hasPublicReviewSignal(object) && SOURCE_BACKED_REVIEW_RE.test(reviewSourceSignals(object));
}

function summarizeReviewSummary(summary) {
  const object = ensureObject(summary);
  return {
    rating: reviewRating(object),
    review_count: reviewCount(object),
    preview_count: previewCount(object),
    source: normalizeText(object.source),
    source_origin: normalizeText(object.source_origin || object.sourceOrigin),
    source_kind: normalizeText(object.source_kind || object.sourceKind),
    status: normalizeText(object.status),
    force_filled: object.force_filled === true || object.forceFilled === true,
    distribution_estimated: object.distribution_estimated === true || object.distributionEstimated === true,
  };
}

function collectReviewPathFindings({ scope, basePath, source }) {
  const out = {
    synthetic_public_paths: [],
    source_backed_paths: [],
    review_paths: [],
  };
  for (const parts of basePath === 'external_product_seeds.seed_data' ? SEED_REVIEW_PATHS : PAYLOAD_REVIEW_PATHS) {
    const value = getByPath(source, parts);
    const summary = ensureObject(value);
    if (!Object.keys(summary).length) continue;
    const pathLabel = `${basePath}.${parts.join('.')}`;
    const compact = {
      scope,
      path: pathLabel,
      ...summarizeReviewSummary(summary),
    };
    out.review_paths.push(compact);
    if (isSyntheticReviewSummary(summary) && hasPublicReviewSignal(summary)) {
      out.synthetic_public_paths.push(compact);
    } else if (isSourceBackedReviewSummary(summary)) {
      out.source_backed_paths.push(compact);
    }
  }
  return out;
}

function pickRowUrl(row) {
  const seedData = ensureObject(row.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  for (const value of [
    row.canonical_url,
    row.destination_url,
    seedData.canonical_url,
    seedData.destination_url,
    snapshot.canonical_url,
    snapshot.destination_url,
    snapshot.url,
  ]) {
    const normalized = normalizeText(value);
    if (/^https?:\/\//i.test(normalized)) return normalized;
  }
  return '';
}

function hostFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function uniqueStrings(values) {
  return Array.from(
    new Set(
      asArray(values)
        .map((item) => normalizeText(item))
        .filter(Boolean),
    ),
  );
}

function classifyAuditedRow(row) {
  const seedData = ensureObject(row.seed_data);
  const syntheticPublicPaths = [];
  const sourceBackedPaths = [];
  const allReviewPaths = [];
  const catalogRows = asArray(row.catalog_rows);
  const identityRows = asArray(row.identity_rows);

  const addFindings = (findings) => {
    syntheticPublicPaths.push(...findings.synthetic_public_paths);
    sourceBackedPaths.push(...findings.source_backed_paths);
    allReviewPaths.push(...findings.review_paths);
  };

  addFindings(
    collectReviewPathFindings({
      scope: 'seed',
      basePath: 'external_product_seeds.seed_data',
      source: seedData,
    }),
  );

  for (const catalogRow of catalogRows) {
    addFindings(
      collectReviewPathFindings({
        scope: 'catalog_products',
        basePath: `catalog_products[${normalizeText(catalogRow.product_key) || '?'}].product_payload`,
        source: ensureObject(catalogRow.product_payload),
      }),
    );
  }

  for (const identityRow of identityRows) {
    const sourceListingRef = normalizeText(identityRow.source_listing_ref) || '?';
    const reviewSummary = ensureObject(identityRow.review_summary);
    if (Object.keys(reviewSummary).length) {
      const compact = {
        scope: 'pdp_identity_listing',
        path: `pdp_identity_listing[${sourceListingRef}].review_summary`,
        ...summarizeReviewSummary(reviewSummary),
      };
      allReviewPaths.push(compact);
      if (isSyntheticReviewSummary(reviewSummary) && hasPublicReviewSignal(reviewSummary)) {
        syntheticPublicPaths.push(compact);
      } else if (isSourceBackedReviewSummary(reviewSummary)) {
        sourceBackedPaths.push(compact);
      }
    }
    addFindings(
      collectReviewPathFindings({
        scope: 'pdp_identity_listing',
        basePath: `pdp_identity_listing[${sourceListingRef}].source_payload`,
        source: ensureObject(identityRow.source_payload),
      }),
    );
  }

  const url = pickRowUrl(row);
  const pivotaSignatureIds = uniqueStrings([
    ...catalogRows.map((item) => item.pivota_signature_id),
    ...identityRows.map((item) => item.sellable_item_group_id),
    ...identityRows.map((item) => item.product_line_id),
    seedData.pivota_signature_id,
    ensureObject(seedData.snapshot).pivota_signature_id,
  ]).filter((value) => /^sig_/i.test(value));
  const hasSyntheticPublicSocialProof = syntheticPublicPaths.length > 0;
  const hasSourceBackedReviewSummary = sourceBackedPaths.length > 0;
  const recommendedAction = !hasSyntheticPublicSocialProof
    ? 'none'
    : hasSourceBackedReviewSummary
      ? 'sync_existing_source_backed_review_summary_to_serving_paths'
      : url
        ? 'run_official_html_review_summary_backfill_dry_run'
        : 'hide_or_quarantine_synthetic_review_summary';

  return {
    external_product_id: normalizeText(row.external_product_id),
    seed_id: normalizeText(row.id),
    market: normalizeText(row.market),
    domain: normalizeText(row.domain) || hostFromUrl(url),
    title: normalizeText(row.title),
    url,
    pivota_signature_ids: pivotaSignatureIds,
    catalog_row_count: catalogRows.length,
    identity_row_count: identityRows.length,
    has_synthetic_public_social_proof: hasSyntheticPublicSocialProof,
    has_source_backed_review_summary: hasSourceBackedReviewSummary,
    recommended_action: recommendedAction,
    synthetic_public_paths: syntheticPublicPaths,
    source_backed_paths: sourceBackedPaths,
    all_review_paths: allReviewPaths,
  };
}

function csvEscape(value) {
  if (value == null) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows, columns) {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function increment(map, key) {
  const normalized = normalizeText(key) || 'unknown';
  map[normalized] = (map[normalized] || 0) + 1;
}

function summarizeRows(rows) {
  const byDomain = {};
  const byPath = {};
  const byAction = {};
  for (const row of rows) {
    increment(byDomain, row.domain || 'unknown');
    increment(byAction, row.recommended_action);
    for (const finding of row.synthetic_public_paths) {
      increment(byPath, finding.path.replace(/\[[^\]]+\]/g, '[]'));
    }
  }
  return {
    scanned: rows.length,
    with_synthetic_public_social_proof: rows.filter((row) => row.has_synthetic_public_social_proof).length,
    with_source_backed_review_summary: rows.filter((row) => row.has_source_backed_review_summary).length,
    backfill_dry_run_candidates: rows.filter(
      (row) => row.recommended_action === 'run_official_html_review_summary_backfill_dry_run',
    ).length,
    sync_existing_source_backed_candidates: rows.filter(
      (row) => row.recommended_action === 'sync_existing_source_backed_review_summary_to_serving_paths',
    ).length,
    by_domain: byDomain,
    by_action: byAction,
    by_synthetic_path: byPath,
  };
}

async function fetchRows(options) {
  const params = [];
  const where = [`eps.status = 'active'`];
  const ids = options.ids || [];
  if (ids.length) {
    params.push(ids);
    where.push(`eps.external_product_id = ANY($${params.length}::text[])`);
  }
  if (options.market) {
    params.push(options.market);
    where.push(`upper(eps.market) = upper($${params.length})`);
  }
  if (options.domain) {
    params.push(options.domain.toLowerCase());
    where.push(`lower(eps.domain) = $${params.length}`);
  }
  if (options.brand) {
    params.push(`%${options.brand}%`);
    where.push(`(
      eps.title ILIKE $${params.length}
      OR eps.seed_data->>'brand' ILIKE $${params.length}
      OR eps.seed_data->>'vendor' ILIKE $${params.length}
      OR eps.seed_data->'snapshot'->>'brand' ILIKE $${params.length}
      OR eps.seed_data->'snapshot'->>'vendor' ILIKE $${params.length}
    )`);
  }
  let suspectJoin = '';
  if (options.suspectsOnly) {
    const suspectPattern =
      '(pivota[_-]?force[_-]?fill|force[_-]?filled?|force_filled|distribution_estimated|approved_estimate|synthetic|estimated)';
    params.push(suspectPattern);
    const patternBind = `$${params.length}`;
    suspectJoin = `
      JOIN (
        SELECT external_product_id
        FROM external_product_seeds
        WHERE seed_data::text ~* ${patternBind}
        UNION
        SELECT source_product_id AS external_product_id
        FROM catalog_products
        WHERE merchant_id = 'external_seed'
          AND platform = 'external_seed'
          AND source_product_id IS NOT NULL
          AND product_payload::text ~* ${patternBind}
        UNION
        SELECT substring(source_listing_ref from '^external_seed:(.+)$') AS external_product_id
        FROM pdp_identity_listing
        WHERE source_listing_ref LIKE 'external_seed:%'
          AND (
            COALESCE(review_summary, '{}'::jsonb)::text ~* ${patternBind}
            OR COALESCE(source_payload, '{}'::jsonb)::text ~* ${patternBind}
          )
      ) suspect_rows
        ON suspect_rows.external_product_id = eps.external_product_id
    `;
  }
  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;
  const result = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.domain,
        eps.canonical_url,
        eps.destination_url,
        eps.title,
        eps.seed_data,
        eps.updated_at,
        COALESCE(cp.catalog_rows, '[]'::jsonb) AS catalog_rows,
        COALESCE(pil.identity_rows, '[]'::jsonb) AS identity_rows
      FROM external_product_seeds eps
      ${suspectJoin}
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'product_key', cp.product_key,
            'pivota_signature_id', cp.pivota_signature_id,
            'updated_at', cp.updated_at,
            'product_payload', cp.product_payload
          )
          ORDER BY cp.updated_at DESC NULLS LAST, cp.created_at DESC NULLS LAST
        ) AS catalog_rows
        FROM catalog_products cp
        WHERE cp.merchant_id = 'external_seed'
          AND cp.platform = 'external_seed'
          AND cp.source_product_id = eps.external_product_id
      ) cp ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'source_listing_ref', pil.source_listing_ref,
            'sellable_item_group_id', pil.sellable_item_group_id,
            'product_line_id', pil.product_line_id,
            'identity_status', pil.identity_status,
            'live_read_enabled', pil.live_read_enabled,
            'updated_at', pil.updated_at,
            'review_summary', pil.review_summary,
            'source_payload', pil.source_payload
          )
          ORDER BY pil.updated_at DESC NULLS LAST, pil.created_at DESC NULLS LAST
        ) AS identity_rows
        FROM pdp_identity_listing pil
        WHERE pil.source_listing_ref = 'external_seed:' || eps.external_product_id
      ) pil ON true
      WHERE ${where.join('\n        AND ')}
      ORDER BY eps.updated_at DESC NULLS LAST, eps.created_at DESC NULLS LAST
      LIMIT ${limitBind}
      OFFSET ${offsetBind}
    `,
    params,
  );
  return result.rows || [];
}

function buildCsvRows(rows) {
  return rows.map((row) => {
    const firstSynthetic = row.synthetic_public_paths[0] || {};
    const firstSourceBacked = row.source_backed_paths[0] || {};
    return {
      external_product_id: row.external_product_id,
      market: row.market,
      domain: row.domain,
      title: row.title,
      url: row.url,
      pivota_signature_ids: row.pivota_signature_ids,
      recommended_action: row.recommended_action,
      synthetic_path_count: row.synthetic_public_paths.length,
      synthetic_paths: row.synthetic_public_paths.map((item) => item.path),
      first_synthetic_rating: firstSynthetic.rating || '',
      first_synthetic_review_count: firstSynthetic.review_count || '',
      first_synthetic_source: firstSynthetic.source || firstSynthetic.source_origin || firstSynthetic.source_kind || '',
      source_backed_path_count: row.source_backed_paths.length,
      source_backed_paths: row.source_backed_paths.map((item) => item.path),
      first_source_backed_review_count: firstSourceBacked.review_count || '',
      first_source_backed_source: firstSourceBacked.source_origin || firstSourceBacked.source || firstSourceBacked.source_kind || '',
    };
  });
}

async function main() {
  const ids = [
    ...parseDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds')),
    ...readIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
  ];
  const options = {
    ids,
    market: normalizeText(argValue('market') || 'US').toUpperCase(),
    domain: normalizeText(argValue('domain')).toLowerCase(),
    brand: normalizeText(argValue('brand')),
    limit: parsePositiveInt(argValue('limit'), 1000, 1, 25000),
    offset: parsePositiveInt(argValue('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
    suspectsOnly: hasFlag('suspects-only') || hasFlag('suspectsOnly'),
  };
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const includeClean = hasFlag('include-clean') || hasFlag('includeClean');
  const rows = (await fetchRows(options)).map(classifyAuditedRow);
  const findings = includeClean ? rows : rows.filter((row) => row.has_synthetic_public_social_proof);
  const summary = summarizeRows(findings);
  const report = {
    generated_at: new Date().toISOString(),
    options,
    summary,
    rows: findings,
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'force-filled-review-social-proof-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeCsv(
      path.join(outDir, 'force-filled-review-social-proof-audit.csv'),
      buildCsvRows(findings),
      [
        'external_product_id',
        'market',
        'domain',
        'title',
        'url',
        'pivota_signature_ids',
        'recommended_action',
        'synthetic_path_count',
        'synthetic_paths',
        'first_synthetic_rating',
        'first_synthetic_review_count',
        'first_synthetic_source',
        'source_backed_path_count',
        'source_backed_paths',
        'first_source_backed_review_count',
        'first_source_backed_source',
      ],
    );
    fs.writeFileSync(
      path.join(outDir, 'force-filled-review-backfill-candidate-ids.txt'),
      `${findings
        .filter((row) => row.recommended_action === 'run_official_html_review_summary_backfill_dry_run')
        .map((row) => row.external_product_id)
        .join('\n')}\n`,
      'utf8',
    );
  }

  console.log(JSON.stringify(summary, null, 2));
  if (hasFlag('fail-on-findings') && summary.with_synthetic_public_social_proof > 0) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
      if (process.exitCode) process.exit(process.exitCode);
    });
}

module.exports = {
  _internals: {
    collectReviewPathFindings,
    classifyAuditedRow,
    hasPublicReviewSignal,
    isSourceBackedReviewSummary,
    isSyntheticReviewSummary,
    reviewCount,
    reviewRating,
    reviewSourceSignals,
    summarizeReviewSummary,
    summarizeRows,
  },
};
