#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  buildIdentityListingSourcePayload,
  stringifyPostgresJsonb,
  sanitizeTextForPostgres,
} = require('./backfill-external-product-seeds-catalog');
const {
  buildPayloadDiff,
  classifyIdentityPayloadDrift,
} = require('../src/services/pdpIdentityPayloadDrift');

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

function parseCursor(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const [updatedAt, id] = normalized.split('|');
  if (!normalizeString(updatedAt) || !normalizeString(id)) return null;
  return { updatedAt: normalizeString(updatedAt), id: normalizeString(id) };
}

function buildCursor(row) {
  if (!row?.updated_at || !row?.id) return '';
  const updatedAt =
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : normalizeString(row.updated_at);
  return updatedAt && row.id ? `${updatedAt}|${row.id}` : '';
}

function ensureJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

async function loadRows({ ids, market, limit, domain, brand, updatedSince, cursor }) {
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
  if (domain) {
    params.push(domain);
    where.push(`lower(domain) = lower($${params.length})`);
  }
  if (brand) {
    params.push(`%${brand}%`);
    where.push(`(
      seed_data->>'brand' ILIKE $${params.length}
      OR seed_data->>'vendor' ILIKE $${params.length}
      OR seed_data->>'brand_name' ILIKE $${params.length}
      OR seed_data->'snapshot'->>'brand' ILIKE $${params.length}
      OR seed_data->'snapshot'->>'vendor' ILIKE $${params.length}
      OR title ILIKE $${params.length}
    )`);
  }
  if (updatedSince) {
    params.push(updatedSince);
    where.push(`updated_at >= $${params.length}::timestamptz`);
  }
  const parsedCursor = parseCursor(cursor);
  if (parsedCursor) {
    params.push(parsedCursor.updatedAt);
    params.push(parsedCursor.id);
    where.push(`(
      updated_at < $${params.length - 1}::timestamptz
      OR (updated_at = $${params.length - 1}::timestamptz AND id < $${params.length})
    )`);
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
      SELECT source_listing_ref, source_payload, live_read_enabled, identity_status, review_required, updated_at
      FROM pdp_identity_listing
      WHERE source_listing_ref = ANY($1::text[])
    `,
    [sourceRefs],
  );
  return new Map((res.rows || []).map((row) => [row.source_listing_ref, row]));
}

async function applyUpdates(updates, { createdBy }) {
  if (!updates.length) return { updated_rows: 0, failed_rows: 0, errors: [] };
  let updatedRows = 0;
  const errors = [];
  for (const update of updates) {
    const reviewSummary = ensureJsonObject(update.payload.review_summary);
    const officialUrl = normalizeString(
      update.payload.canonical_url || update.payload.url || update.payload.destination_url,
    );
    try {
      const res = await query(
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
      if (res.rowCount > 0) update.result.status = 'updated';
    } catch (error) {
      update.result.status = 'apply_failed';
      update.result.error = String(error?.message || error);
      errors.push({
        external_product_id: update.result.external_product_id,
        source_listing_ref: update.source_listing_ref,
        title: update.result.title,
        error: update.result.error,
      });
    }
  }
  return { updated_rows: updatedRows, failed_rows: errors.length, errors };
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
  const domain = normalizeString(argValue('domain'));
  const brand = normalizeString(argValue('brand'));
  const updatedSince = normalizeString(argValue('updated-since') || argValue('updatedSince'));
  const rawBatchSize = Number(argValue('batch-size') || argValue('batchSize') || 0);
  const batchSize = Number.isFinite(rawBatchSize) && rawBatchSize > 0
    ? Math.max(1, Math.min(5000, Math.floor(rawBatchSize)))
    : 0;
  const limit = batchSize || Math.max(1, Math.min(5000, Number(argValue('limit') || ids.length || 500) || 500));
  const cursor = normalizeString(argValue('cursor'));
  const dryRun = !hasFlag('write');
  const out = normalizeString(argValue('out'));
  const outDir = normalizeString(argValue('out-dir'));
  const createdBy = normalizeString(argValue('created-by')) || 'sync_external_seed_identity_source_payloads';

  const rows = await loadRows({ ids, market, limit, domain, brand, updatedSince, cursor });
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
    const diff = buildPayloadDiff(identityRow.source_payload, item.payload.product, item.row.title);
    const drift = classifyIdentityPayloadDrift({
      seedPayload: item.payload.product,
      identityPayload: identityRow.source_payload,
      title: item.row.title,
      seedUpdatedAt: item.row.updated_at,
      identityUpdatedAt: identityRow.updated_at,
    });
    const skipReason = drift.identity_summary.strict_blocker
      ? 'strict_source_blocker'
      : drift.audit_scope_mismatch
        ? 'audit_scope_mismatch'
        : '';
    let status = 'unchanged';
    if (diff.changed) {
      if (skipReason) {
        status = `skipped_${skipReason}`;
      } else {
        status = dryRun ? 'dry_run' : 'pending_apply';
      }
    }
    const result = {
      external_product_id: item.row.external_product_id,
      domain: item.row.domain,
      title: item.row.title,
      source_listing_ref: item.payload.source_listing_ref,
      live_read_enabled: identityRow.live_read_enabled === true,
      identity_status: identityRow.identity_status,
      review_required: identityRow.review_required === true,
      status,
      skip_reason: skipReason,
      diff,
      drift,
    };
    results.push(result);
    if (diff.changed && !skipReason) {
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
      if (result.status === 'pending_apply') result.status = 'unchanged_after_apply';
    }
  }

  const summary = {
    dry_run: dryRun,
    filters: {
      market: market || null,
      domain: domain || null,
      brand: brand || null,
      updated_since: updatedSince || null,
      cursor: cursor || null,
      limit,
    },
    scanned_rows: rows.length,
    payloads_built: payloads.length,
    diff_changed_rows: results.filter((item) => item.diff?.changed).length,
    changed_rows: updates.length,
    updated_rows: applyResult.updated_rows,
    failed_rows: applyResult.failed_rows || 0,
    skipped_missing_identity_listing: results.filter((item) => item.status === 'skipped_missing_identity_listing').length,
    skipped_audit_scope_mismatch: results.filter((item) => item.skip_reason === 'audit_scope_mismatch').length,
    skipped_strict_source_blocker: results.filter((item) => item.skip_reason === 'strict_source_blocker').length,
    gained_active_evidence: results.filter((item) => item.diff?.gained_active_evidence).length,
    gained_ingredients: results.filter((item) => item.diff?.gained_ingredients).length,
    gained_how_to: results.filter((item) => item.diff?.gained_how_to).length,
    gained_details: results.filter((item) => item.diff?.gained_details).length,
    gained_content_images: results.filter((item) => item.diff?.gained_content_images).length,
    gained_reviews: results.filter((item) => item.diff?.gained_reviews).length,
    variant_count_changed: results.filter((item) => item.diff?.variant_count_changed).length,
    contract_changed: results.filter((item) => item.diff?.contract_changed).length,
    field_quality_changed: results.filter((item) => item.diff?.field_quality_changed).length,
    seed_active_expected: results.filter((item) => item.drift?.seed_expects_active_ingredients).length,
    identity_payload_stale: results.filter((item) => item.drift?.identity_payload_stale).length,
    seed_active_identity_inactive: results.filter(
      (item) => item.drift?.seed_has_active_evidence && !item.drift?.identity_payload_has_active_evidence,
    ).length,
    next_cursor: rows.length >= limit ? buildCursor(rows[rows.length - 1]) || null : null,
  };
  const report = {
    generated_at: new Date().toISOString(),
    summary,
    apply_errors: applyResult.errors || [],
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

if (require.main === module) {
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
}

module.exports = {
  parseCursor,
  buildCursor,
  loadRows,
  loadIdentityRows,
  applyUpdates,
  main,
};
