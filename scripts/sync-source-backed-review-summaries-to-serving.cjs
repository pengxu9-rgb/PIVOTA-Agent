#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  _internals: {
    isSourceBackedReviewSummary,
    isSyntheticReviewSummary,
    summarizeReviewSummary,
  },
} = require('./audit-force-filled-review-social-proof.cjs');

const REVIEW_PATHS = [
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

function readIdsFromAudit(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized) return [];
  const report = JSON.parse(fs.readFileSync(normalized, 'utf8'));
  return asArray(report.rows)
    .filter((row) => row?.recommended_action === 'sync_existing_source_backed_review_summary_to_serving_paths')
    .map((row) => normalizeText(row.external_product_id))
    .filter(Boolean);
}

function parsePositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function getByPath(source, parts) {
  let cursor = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setByPath(source, parts, value) {
  let cursor = source;
  for (let idx = 0; idx < parts.length - 1; idx += 1) {
    const part = parts[idx];
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function reviewPreviewCount(summary) {
  return asArray(summary?.preview_items || summary?.reviews || summary?.items).length;
}

function reviewCount(summary) {
  return Number(summarizeReviewSummary(summary).review_count || 0);
}

function sourceBackedScore(summary, pathLabel) {
  const compact = summarizeReviewSummary(summary);
  const origin = `${compact.source_origin} ${compact.source_kind} ${compact.source}`.toLowerCase();
  let score = 0;
  if (origin.includes('official')) score += 1000;
  if (origin.includes('merchant')) score += 500;
  if (origin.includes('yotpo') || origin.includes('okendo') || origin.includes('stamped') || origin.includes('bazaarvoice')) {
    score += 250;
  }
  score += Math.min(200, reviewPreviewCount(summary) * 20);
  score += Math.min(100, reviewCount(summary) / 10);
  if (/pdp_identity_listing.*review_summary/i.test(pathLabel)) score += 50;
  if (/external_product_seeds\.seed_data\.review_summary$/i.test(pathLabel)) score += 25;
  return score;
}

function collectSourceBackedReviewCandidates(row) {
  const candidates = [];
  const seedData = ensureObject(row.seed_data);
  for (const parts of [['review_summary'], ['pdp_review_summary'], ['snapshot', 'review_summary'], ['snapshot', 'pdp_review_summary']]) {
    const summary = ensureObject(getByPath(seedData, parts));
    if (isSourceBackedReviewSummary(summary)) {
      const pathLabel = `external_product_seeds.seed_data.${parts.join('.')}`;
      candidates.push({ path: pathLabel, score: sourceBackedScore(summary, pathLabel), summary });
    }
  }
  for (const catalogRow of asArray(row.catalog_rows)) {
    const productKey = normalizeText(catalogRow.product_key) || '?';
    const payload = ensureObject(catalogRow.product_payload);
    for (const parts of REVIEW_PATHS) {
      const summary = ensureObject(getByPath(payload, parts));
      if (isSourceBackedReviewSummary(summary)) {
        const pathLabel = `catalog_products[${productKey}].product_payload.${parts.join('.')}`;
        candidates.push({ path: pathLabel, score: sourceBackedScore(summary, pathLabel), summary });
      }
    }
  }
  for (const identityRow of asArray(row.identity_rows)) {
    const ref = normalizeText(identityRow.source_listing_ref) || '?';
    const identitySummary = ensureObject(identityRow.review_summary);
    if (isSourceBackedReviewSummary(identitySummary)) {
      const pathLabel = `pdp_identity_listing[${ref}].review_summary`;
      candidates.push({ path: pathLabel, score: sourceBackedScore(identitySummary, pathLabel), summary: identitySummary });
    }
    const payload = ensureObject(identityRow.source_payload);
    for (const parts of REVIEW_PATHS) {
      const summary = ensureObject(getByPath(payload, parts));
      if (isSourceBackedReviewSummary(summary)) {
        const pathLabel = `pdp_identity_listing[${ref}].source_payload.${parts.join('.')}`;
        candidates.push({ path: pathLabel, score: sourceBackedScore(summary, pathLabel), summary });
      }
    }
  }
  candidates.sort((left, right) => right.score - left.score || reviewCount(right.summary) - reviewCount(left.summary));
  return candidates;
}

function normalizeSourceBackedReviewSummary(summary) {
  const next = cloneJson(summary);
  delete next.force_filled;
  delete next.forceFilled;
  delete next.distribution_estimated;
  delete next.distributionEstimated;
  delete next.approved_estimate;
  delete next.approvedEstimate;
  if (/estimated|synthetic|force/i.test(normalizeText(next.status))) delete next.status;
  if (!normalizeText(next.status)) next.status = 'ready';
  return next;
}

function patchSeedDataReviewSummary(seedData, reviewSummary) {
  const next = cloneJson(seedData);
  const snapshot = ensureObject(next.snapshot);
  next.review_summary = reviewSummary;
  next.pdp_review_summary = reviewSummary;
  next.snapshot = {
    ...snapshot,
    review_summary: reviewSummary,
    pdp_review_summary: reviewSummary,
  };
  return next;
}

function patchServingPayloadReviewSummary(payload, reviewSummary) {
  const next = cloneJson(payload);
  next.review_summary = reviewSummary;
  next.pdp_review_summary = reviewSummary;
  const seedData = ensureObject(next.seed_data);
  const snapshot = ensureObject(seedData.snapshot);
  next.seed_data = {
    ...seedData,
    review_summary: reviewSummary,
    pdp_review_summary: reviewSummary,
    snapshot: {
      ...snapshot,
      review_summary: reviewSummary,
      pdp_review_summary: reviewSummary,
    },
  };
  return next;
}

function stringifyPostgresJsonb(value) {
  let text = JSON.stringify(value || {});
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/\\+u0000/gi, '')
      .replace(/\u0000/g, '');
  }
  return text;
}

function hasSyntheticReviewSocialProofInPayload(payload) {
  for (const parts of REVIEW_PATHS) {
    const summary = ensureObject(getByPath(payload, parts));
    if (isSyntheticReviewSummary(summary)) return true;
  }
  return false;
}

async function fetchRows(ids, limit) {
  if (!ids.length) return [];
  const result = await query(
    `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.seed_data,
        eps.title,
        eps.domain,
        eps.market,
        COALESCE(cp.catalog_rows, '[]'::jsonb) AS catalog_rows,
        COALESCE(pil.identity_rows, '[]'::jsonb) AS identity_rows
      FROM external_product_seeds eps
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'product_key', cp.product_key,
            'pivota_signature_id', cp.pivota_signature_id,
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
            'review_summary', pil.review_summary,
            'source_payload', pil.source_payload
          )
          ORDER BY pil.updated_at DESC NULLS LAST, pil.created_at DESC NULLS LAST
        ) AS identity_rows
        FROM pdp_identity_listing pil
        WHERE pil.source_listing_ref = 'external_seed:' || eps.external_product_id
      ) pil ON true
      WHERE eps.external_product_id = ANY($1::text[])
        AND eps.status = 'active'
      ORDER BY eps.updated_at DESC NULLS LAST
      LIMIT $2
    `,
    [ids, limit],
  );
  return result.rows || [];
}

async function applyRowSync(row, reviewSummary) {
  const seedData = patchSeedDataReviewSummary(row.seed_data, reviewSummary);
  await query(
    `
      UPDATE external_product_seeds
      SET seed_data = $2::jsonb,
          updated_at = NOW()
      WHERE external_product_id = $1
    `,
    [row.external_product_id, stringifyPostgresJsonb(seedData)],
  );

  let catalogProducts = 0;
  for (const catalogRow of asArray(row.catalog_rows)) {
    const productKey = normalizeText(catalogRow.product_key);
    if (!productKey) continue;
    const productPayload = patchServingPayloadReviewSummary(catalogRow.product_payload, reviewSummary);
    const result = await query(
      `
        UPDATE catalog_products
        SET product_payload = $2::jsonb,
            updated_at = NOW()
        WHERE product_key = $1
      `,
      [productKey, stringifyPostgresJsonb(productPayload)],
    );
    catalogProducts += Number(result.rowCount || 0);
  }

  let identityListings = 0;
  for (const identityRow of asArray(row.identity_rows)) {
    const sourceListingRef = normalizeText(identityRow.source_listing_ref);
    if (!sourceListingRef) continue;
    const sourcePayload = patchServingPayloadReviewSummary(identityRow.source_payload, reviewSummary);
    const result = await query(
      `
        UPDATE pdp_identity_listing
        SET review_summary = $2::jsonb,
            source_payload = $3::jsonb,
            updated_at = NOW()
        WHERE source_listing_ref = $1
      `,
      [sourceListingRef, stringifyPostgresJsonb(reviewSummary), stringifyPostgresJsonb(sourcePayload)],
    );
    identityListings += Number(result.rowCount || 0);
  }

  return {
    external_product_seeds: 1,
    catalog_products: catalogProducts,
    pdp_identity_listing: identityListings,
  };
}

async function runSync({ ids, limit, dryRun, batchSize = 50 }) {
  const targetIds = ids.slice(0, Math.max(0, limit));
  const rows = [];
  for (let start = 0; start < targetIds.length; start += batchSize) {
    const batchIds = targetIds.slice(start, start + batchSize);
    rows.push(...(await fetchRows(batchIds, batchIds.length)));
  }
  const results = [];
  for (const row of rows) {
    const candidates = collectSourceBackedReviewCandidates(row);
    const chosen = candidates[0];
    const result = {
      external_product_id: row.external_product_id,
      title: row.title,
      domain: row.domain,
      status: 'skipped',
      source_path: chosen?.path || '',
      source_summary: chosen ? summarizeReviewSummary(chosen.summary) : null,
      catalog_rows: asArray(row.catalog_rows).length,
      identity_rows: asArray(row.identity_rows).length,
      stale_synthetic_catalog_payloads: asArray(row.catalog_rows).filter((item) =>
        hasSyntheticReviewSocialProofInPayload(ensureObject(item.product_payload)),
      ).length,
      stale_synthetic_identity_payloads: asArray(row.identity_rows).filter((item) =>
        hasSyntheticReviewSocialProofInPayload(ensureObject(item.source_payload)) ||
        isSyntheticReviewSummary(ensureObject(item.review_summary)),
      ).length,
    };
    if (!chosen) {
      result.reason = 'missing_source_backed_review_summary';
      results.push(result);
      continue;
    }
    const reviewSummary = normalizeSourceBackedReviewSummary(chosen.summary);
    result.status = dryRun ? 'dry_run' : 'updated';
    if (dryRun) {
      result.planned_updates = {
        external_product_seeds: 1,
        catalog_products: asArray(row.catalog_rows).length,
        pdp_identity_listing: asArray(row.identity_rows).length,
      };
    } else {
      result.updated = await applyRowSync(row, reviewSummary);
    }
    results.push(result);
  }
  return results;
}

function summarizeResults(results) {
  return {
    scanned: results.length,
    dry_run: results.filter((item) => item.status === 'dry_run').length,
    updated: results.filter((item) => item.status === 'updated').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    missing_source_backed_review_summary: results.filter((item) => item.reason === 'missing_source_backed_review_summary').length,
    catalog_payloads_with_stale_synthetic_before_sync: results.reduce(
      (sum, item) => sum + Number(item.stale_synthetic_catalog_payloads || 0),
      0,
    ),
    identity_payloads_with_stale_synthetic_before_sync: results.reduce(
      (sum, item) => sum + Number(item.stale_synthetic_identity_payloads || 0),
      0,
    ),
  };
}

async function main() {
  const ids = Array.from(
    new Set([
      ...readIdsFromAudit(argValue('audit-json') || argValue('auditJson')),
      ...parseDelimitedIds(argValue('external-product-ids') || argValue('externalProductIds')),
      ...readIdsFile(argValue('external-product-ids-file') || argValue('externalProductIdsFile')),
    ]),
  );
  if (!ids.length) throw new Error('missing_external_product_ids_or_audit_json');
  const dryRun = hasFlag('dry-run') || hasFlag('dryRun');
  const limit = parsePositiveInt(argValue('limit'), ids.length, 1, Math.max(ids.length, 1));
  const batchSize = parsePositiveInt(argValue('batch-size') || argValue('batchSize'), 50, 1, 250);
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const results = await runSync({ ids, limit, dryRun, batchSize });
  const report = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    requested_ids: ids.length,
    summary: summarizeResults(results),
    results,
  };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, dryRun ? 'dry-run.json' : 'apply.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report.summary, null, 2));
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
    collectSourceBackedReviewCandidates,
    normalizeSourceBackedReviewSummary,
    patchSeedDataReviewSummary,
    patchServingPayloadReviewSummary,
    summarizeResults,
  },
};
