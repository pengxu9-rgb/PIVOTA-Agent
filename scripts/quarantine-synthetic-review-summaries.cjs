#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  _internals: {
    hasPublicReviewSignal,
    isSyntheticReviewSummary,
    summarizeReviewSummary,
  },
} = require('./audit-force-filled-review-social-proof.cjs');

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
    .filter((row) => row?.has_synthetic_public_social_proof && !row?.has_source_backed_review_summary)
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
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function shouldQuarantineReviewSummary(summary) {
  const object = ensureObject(summary);
  return isSyntheticReviewSummary(object) && hasPublicReviewSignal(object);
}

function buildQuarantinedReviewSummary(summary, nowIso = new Date().toISOString()) {
  return {
    status: 'quarantined',
    source: 'pivota_review_quarantine_v1',
    rating: 0,
    review_count: 0,
    preview_items: [],
    public_visible: false,
    quarantine_reason: 'synthetic_review_social_proof_not_public',
    quarantined_at: nowIso,
    previous_force_filled_estimate: summarizeReviewSummary(summary),
  };
}

function quarantineReviewPaths(source, reviewPaths, nowIso = new Date().toISOString()) {
  const next = cloneJson(source);
  const patchedPaths = [];
  for (const parts of reviewPaths) {
    const summary = ensureObject(getByPath(next, parts));
    if (!shouldQuarantineReviewSummary(summary)) continue;
    setByPath(next, parts, buildQuarantinedReviewSummary(summary, nowIso));
    patchedPaths.push(parts.join('.'));
  }
  return { next, patchedPaths };
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

async function applyRow(row, patched) {
  let externalProductSeeds = 0;
  if (patched.seedData) {
    const result = await query(
      `
        UPDATE external_product_seeds
        SET seed_data = $2::jsonb,
            updated_at = NOW()
        WHERE external_product_id = $1
      `,
      [row.external_product_id, stringifyPostgresJsonb(patched.seedData)],
    );
    externalProductSeeds += Number(result.rowCount || 0);
  }

  let catalogProducts = 0;
  for (const item of patched.catalogRows) {
    const result = await query(
      `
        UPDATE catalog_products
        SET product_payload = $2::jsonb,
            updated_at = NOW()
        WHERE product_key = $1
      `,
      [item.product_key, stringifyPostgresJsonb(item.product_payload)],
    );
    catalogProducts += Number(result.rowCount || 0);
  }

  let identityListings = 0;
  for (const item of patched.identityRows) {
    const result = await query(
      `
        UPDATE pdp_identity_listing
        SET review_summary = $2::jsonb,
            source_payload = $3::jsonb,
            updated_at = NOW()
        WHERE source_listing_ref = $1
      `,
      [item.source_listing_ref, stringifyPostgresJsonb(item.review_summary), stringifyPostgresJsonb(item.source_payload)],
    );
    identityListings += Number(result.rowCount || 0);
  }

  return {
    external_product_seeds: externalProductSeeds,
    catalog_products: catalogProducts,
    pdp_identity_listing: identityListings,
  };
}

function buildRowPatch(row, nowIso = new Date().toISOString()) {
  const patched = {
    seedData: null,
    seedPaths: [],
    catalogRows: [],
    identityRows: [],
  };

  const seedPatch = quarantineReviewPaths(row.seed_data, SEED_REVIEW_PATHS, nowIso);
  if (seedPatch.patchedPaths.length) {
    patched.seedData = seedPatch.next;
    patched.seedPaths = seedPatch.patchedPaths.map((item) => `external_product_seeds.seed_data.${item}`);
  }

  for (const catalogRow of asArray(row.catalog_rows)) {
    const productKey = normalizeText(catalogRow.product_key);
    if (!productKey) continue;
    const payloadPatch = quarantineReviewPaths(catalogRow.product_payload, PAYLOAD_REVIEW_PATHS, nowIso);
    if (!payloadPatch.patchedPaths.length) continue;
    patched.catalogRows.push({
      product_key: productKey,
      product_payload: payloadPatch.next,
      patched_paths: payloadPatch.patchedPaths.map((item) => `catalog_products[${productKey}].product_payload.${item}`),
    });
  }

  for (const identityRow of asArray(row.identity_rows)) {
    const sourceListingRef = normalizeText(identityRow.source_listing_ref);
    if (!sourceListingRef) continue;
    const reviewSummary = ensureObject(identityRow.review_summary);
    const patchedReviewSummary = shouldQuarantineReviewSummary(reviewSummary)
      ? buildQuarantinedReviewSummary(reviewSummary, nowIso)
      : reviewSummary;
    const sourcePayloadPatch = quarantineReviewPaths(identityRow.source_payload, PAYLOAD_REVIEW_PATHS, nowIso);
    const patchedReviewSummaryPath = patchedReviewSummary !== reviewSummary
      ? [`pdp_identity_listing[${sourceListingRef}].review_summary`]
      : [];
    if (!patchedReviewSummaryPath.length && !sourcePayloadPatch.patchedPaths.length) continue;
    patched.identityRows.push({
      source_listing_ref: sourceListingRef,
      review_summary: patchedReviewSummary,
      source_payload: sourcePayloadPatch.next,
      patched_paths: [
        ...patchedReviewSummaryPath,
        ...sourcePayloadPatch.patchedPaths.map((item) => `pdp_identity_listing[${sourceListingRef}].source_payload.${item}`),
      ],
    });
  }

  return patched;
}

function countPatchedPaths(patched) {
  return (
    patched.seedPaths.length +
    patched.catalogRows.reduce((sum, item) => sum + item.patched_paths.length, 0) +
    patched.identityRows.reduce((sum, item) => sum + item.patched_paths.length, 0)
  );
}

async function runQuarantine({ ids, limit, dryRun }) {
  const rows = await fetchRows(ids.slice(0, limit), limit);
  const results = [];
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    const patched = buildRowPatch(row, nowIso);
    const patchedPathCount = countPatchedPaths(patched);
    const result = {
      external_product_id: row.external_product_id,
      title: row.title,
      domain: row.domain,
      status: patchedPathCount > 0 ? (dryRun ? 'dry_run' : 'updated') : 'skipped',
      patched_path_count: patchedPathCount,
      seed_paths: patched.seedPaths,
      catalog_rows: patched.catalogRows.map((item) => ({
        product_key: item.product_key,
        patched_paths: item.patched_paths,
      })),
      identity_rows: patched.identityRows.map((item) => ({
        source_listing_ref: item.source_listing_ref,
        patched_paths: item.patched_paths,
      })),
    };
    if (patchedPathCount === 0) {
      result.reason = 'no_public_synthetic_review_summary';
      results.push(result);
      continue;
    }
    if (!dryRun) result.updated = await applyRow(row, patched);
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
    patched_paths: results.reduce((sum, item) => sum + Number(item.patched_path_count || 0), 0),
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
  const outDir = normalizeText(argValue('out-dir') || argValue('outDir'));
  const results = await runQuarantine({ ids, limit, dryRun });
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
    buildQuarantinedReviewSummary,
    buildRowPatch,
    quarantineReviewPaths,
    shouldQuarantineReviewSummary,
    summarizeResults,
  },
};
