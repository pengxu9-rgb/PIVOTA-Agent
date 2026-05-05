#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query, withClient } = require('../src/db');
const {
  buildIdentityListingSourcePayload,
  stringifyPostgresJsonb,
  sanitizeTextForPostgres,
} = require('./backfill-external-product-seeds-catalog');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function readIdsFile(filePath) {
  const normalized = normalizeString(filePath);
  if (!normalized) return [];
  return fs
    .readFileSync(normalized, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function uniqueStrings(values, limit = 5000) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function ensureJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function textLength(value) {
  return typeof value === 'string' ? value.trim().length : 0;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function pickReviewCount(value) {
  const payload = ensureJsonObject(value);
  const seedData = ensureJsonObject(payload.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const candidates = [
    payload.review_summary,
    payload.reviewSummary,
    seedData.review_summary,
    seedData.reviewSummary,
    snapshot.review_summary,
    snapshot.reviewSummary,
  ];
  for (const candidate of candidates) {
    const review = ensureJsonObject(candidate);
    const count = Number(review.count ?? review.review_count ?? review.reviews_count);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return 0;
}

function summarizePayload(payload) {
  const safe = ensureJsonObject(payload);
  const seedData = ensureJsonObject(safe.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  return {
    title: normalizeString(safe.title || seedData.title || snapshot.title),
    ingredients_top_len: textLength(safe.pdp_ingredients_raw),
    ingredients_seed_len: textLength(seedData.pdp_ingredients_raw),
    ingredients_snapshot_len: textLength(snapshot.pdp_ingredients_raw),
    how_to_top_len: textLength(safe.pdp_how_to_use_raw),
    how_to_seed_len: textLength(seedData.pdp_how_to_use_raw),
    how_to_snapshot_len: textLength(snapshot.pdp_how_to_use_raw),
    review_count: pickReviewCount(safe),
    variants_count: arrayLength(safe.variants) || arrayLength(seedData.variants) || arrayLength(snapshot.variants),
    details_count:
      arrayLength(safe.pdp_details_sections) ||
      arrayLength(seedData.pdp_details_sections) ||
      arrayLength(snapshot.pdp_details_sections),
    has_contract: Boolean(
      ensureJsonObject(seedData.external_seed_snapshot_contract).authoritative ||
        ensureJsonObject(snapshot.external_seed_snapshot_contract).authoritative,
    ),
  };
}

function buildDiff(beforePayload, afterPayload) {
  const before = summarizePayload(beforePayload);
  const after = summarizePayload(afterPayload);
  return {
    before,
    after,
    changed: JSON.stringify(beforePayload || {}) !== JSON.stringify(afterPayload || {}),
    gained_ingredients:
      before.ingredients_top_len + before.ingredients_seed_len + before.ingredients_snapshot_len === 0 &&
      after.ingredients_top_len + after.ingredients_seed_len + after.ingredients_snapshot_len > 0,
    gained_how_to:
      before.how_to_top_len + before.how_to_seed_len + before.how_to_snapshot_len === 0 &&
      after.how_to_top_len + after.how_to_seed_len + after.how_to_snapshot_len > 0,
    gained_reviews: before.review_count === 0 && after.review_count > 0,
    variant_count_changed: before.variants_count !== after.variants_count,
    contract_changed: before.has_contract !== after.has_contract,
  };
}

async function loadRows({ ids, market, limit }) {
  const params = [];
  const where = [`status = 'active'`];
  if (ids.length) {
    params.push(ids);
    where.push(`external_product_id = ANY($${params.length}::text[])`);
  }
  if (market) {
    params.push(market);
    where.push(`upper(market) = upper($${params.length})`);
  }
  params.push(limit);
  const res = await query(
    `
      SELECT *
      FROM external_product_seeds
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $${params.length}
    `,
    params,
  );
  return res.rows || [];
}

async function loadIdentityRows(sourceRefs) {
  if (!sourceRefs.length) return new Map();
  const res = await query(
    `
      SELECT source_listing_ref, source_payload, live_read_enabled, identity_status, review_required
      FROM pdp_identity_listing
      WHERE source_listing_ref = ANY($1::text[])
    `,
    [sourceRefs],
  );
  return new Map((res.rows || []).map((row) => [row.source_listing_ref, row]));
}

async function applyUpdates(updates, { createdBy }) {
  if (!updates.length) return { updated_rows: 0 };
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      let updatedRows = 0;
      for (const update of updates) {
        const reviewSummary = ensureJsonObject(update.payload.review_summary);
        const officialUrl = normalizeString(
          update.payload.canonical_url || update.payload.url || update.payload.destination_url,
        );
        const res = await client.query(
          `
            UPDATE pdp_identity_listing
            SET
              source_payload = $2::jsonb,
              review_summary = $3::jsonb,
              official_url = COALESCE(NULLIF($4, ''), official_url),
              updated_at = now()
            WHERE source_listing_ref = $1
              AND source_payload IS DISTINCT FROM $2::jsonb
          `,
          [
            sanitizeTextForPostgres(update.source_listing_ref),
            stringifyPostgresJsonb(update.payload),
            stringifyPostgresJsonb(reviewSummary),
            sanitizeTextForPostgres(officialUrl),
          ],
        );
        updatedRows += Number(res.rowCount || 0);
      }
      await client.query('COMMIT');
      return { updated_rows: updatedRows };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function main() {
  const ids = uniqueStrings([
    ...readIdsFile(argValue('external-product-ids-file')),
    ...normalizeString(argValue('external-product-ids'))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  ]);
  const market = normalizeString(argValue('market')).toUpperCase();
  const limit = Math.max(1, Math.min(5000, Number(argValue('limit') || ids.length || 500) || 500));
  const dryRun = !hasFlag('write');
  const out = normalizeString(argValue('out'));
  const outDir = normalizeString(argValue('out-dir'));
  const createdBy = normalizeString(argValue('created-by')) || 'sync_external_seed_identity_source_payloads';

  const rows = await loadRows({ ids, market, limit });
  const payloads = rows
    .map((row) => ({ row, payload: buildIdentityListingSourcePayload(row, row) }))
    .filter((item) => item.payload?.source_listing_ref && item.payload?.product);
  const identityRows = await loadIdentityRows(payloads.map((item) => item.payload.source_listing_ref));

  const results = [];
  const updates = [];
  for (const item of payloads) {
    const identityRow = identityRows.get(item.payload.source_listing_ref);
    if (!identityRow) {
      results.push({
        external_product_id: item.row.external_product_id,
        source_listing_ref: item.payload.source_listing_ref,
        status: 'skipped_missing_identity_listing',
      });
      continue;
    }
    const diff = buildDiff(identityRow.source_payload, item.payload.product);
    const result = {
      external_product_id: item.row.external_product_id,
      domain: item.row.domain,
      title: item.row.title,
      source_listing_ref: item.payload.source_listing_ref,
      live_read_enabled: identityRow.live_read_enabled === true,
      identity_status: identityRow.identity_status,
      review_required: identityRow.review_required === true,
      status: diff.changed ? (dryRun ? 'dry_run' : 'pending_apply') : 'unchanged',
      diff,
    };
    results.push(result);
    if (diff.changed) {
      updates.push({
        source_listing_ref: item.payload.source_listing_ref,
        payload: item.payload.product,
        result,
      });
    }
  }

  let applyResult = { updated_rows: 0 };
  if (!dryRun && updates.length) {
    applyResult = await applyUpdates(updates, { createdBy });
    for (const result of results) {
      if (result.status === 'pending_apply') result.status = 'updated';
    }
  }

  const summary = {
    dry_run: dryRun,
    scanned_rows: rows.length,
    payloads_built: payloads.length,
    changed_rows: updates.length,
    updated_rows: applyResult.updated_rows,
    skipped_missing_identity_listing: results.filter((item) => item.status === 'skipped_missing_identity_listing').length,
    gained_ingredients: results.filter((item) => item.diff?.gained_ingredients).length,
    gained_how_to: results.filter((item) => item.diff?.gained_how_to).length,
    gained_reviews: results.filter((item) => item.diff?.gained_reviews).length,
    variant_count_changed: results.filter((item) => item.diff?.variant_count_changed).length,
    contract_changed: results.filter((item) => item.diff?.contract_changed).length,
  };
  const report = {
    generated_at: new Date().toISOString(),
    summary,
    results,
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, dryRun ? 'dry-run.json' : 'apply.json'), JSON.stringify(report, null, 2));
  }
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: 'SYNC_EXTERNAL_SEED_IDENTITY_SOURCE_PAYLOADS_FAILED',
          message: err?.message || String(err),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
