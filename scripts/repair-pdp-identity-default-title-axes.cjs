#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { closePool, query } = require('../src/db');
const {
  buildIdentityListingFromProduct,
  _internals,
} = require('../src/services/pdpIdentityGraph');

const { stringifyPostgresJsonb } = _internals;

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

function text(value) {
  return String(value || '').trim();
}

function sanitizeTextForPostgres(value) {
  if (value === null || value === undefined) return value;
  return String(value || '').replace(/\u0000/g, '').replace(/\\+u0000/gi, '');
}

function readIdsFile(filePath) {
  const normalized = text(filePath);
  if (!normalized) return [];
  return fs.readFileSync(normalized, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = text(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function hasDefaultTitleAxis(value) {
  const raw = JSON.stringify(value || {}).toLowerCase();
  return /default title|\"shade\"\s*:\s*\"default\"|variant_axes:shade:default/.test(raw);
}

function defaultTitleAxisRemoved(beforeAxes, beforeMatchBasis, afterAxes, afterMatchBasis) {
  return (
    hasDefaultTitleAxis(beforeAxes) ||
    hasDefaultTitleAxis(beforeMatchBasis)
  ) && !hasDefaultTitleAxis(afterAxes) && !hasDefaultTitleAxis(afterMatchBasis);
}

async function loadRows({ ids, market, domain, limit }) {
  const params = [];
  const where = [
    `(variant_axes::text ILIKE '%default title%' OR match_basis::text ILIKE '%variant_axes:shade:default%')`,
  ];
  if (ids.length) {
    params.push(ids.map((id) => id.startsWith('external_seed:') ? id : `external_seed:${id}`));
    where.push(`source_listing_ref = ANY($${params.length}::text[])`);
  }
  if (market) {
    params.push(market);
    where.push(`upper(coalesce(source_payload->>'market', source_payload->'seed_data'->>'market', '')) = upper($${params.length})`);
  }
  if (domain) {
    params.push(domain);
    where.push(`lower(coalesce(official_domain, source_payload->>'domain', source_payload->'seed_data'->>'domain', '')) = lower($${params.length})`);
  }
  params.push(limit);
  const res = await query(
    `
      SELECT *
      FROM pdp_identity_listing
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC NULLS LAST, source_listing_ref
      LIMIT $${params.length}
    `,
    params,
  );
  return res.rows || [];
}

function buildRepair(row) {
  const sourcePayload = row?.source_payload && typeof row.source_payload === 'object'
    ? row.source_payload
    : null;
  if (!sourcePayload) {
    return {
      source_listing_ref: row?.source_listing_ref || '',
      status: 'skipped',
      reason: 'missing_source_payload',
    };
  }

  const rebuilt = buildIdentityListingFromProduct({
    merchantId: row.merchant_id,
    productId: row.product_id,
    sourceKind: row.source_kind,
    product: sourcePayload,
  });
  if (!rebuilt) {
    return {
      source_listing_ref: row.source_listing_ref,
      status: 'skipped',
      reason: 'rebuild_failed',
    };
  }

  const nextVariantAxes = rebuilt.variant_axes || {};
  const nextMatchBasis = Array.isArray(rebuilt.match_basis) ? rebuilt.match_basis : [];
  if (!defaultTitleAxisRemoved(row.variant_axes, row.match_basis, nextVariantAxes, nextMatchBasis)) {
    return {
      source_listing_ref: row.source_listing_ref,
      status: 'skipped',
      reason: 'default_title_axis_not_safely_removed',
      before: {
        variant_axes: row.variant_axes || {},
        match_basis: row.match_basis || [],
      },
      after: {
        variant_axes: nextVariantAxes,
        match_basis: nextMatchBasis,
      },
    };
  }

  return {
    source_listing_ref: row.source_listing_ref,
    product_id: row.product_id,
    title: sourcePayload.title || sourcePayload.name || '',
    official_url: rebuilt.official_url || row.official_url || null,
    official_domain: rebuilt.official_domain || row.official_domain || null,
    status: 'candidate',
    preserve_group_ids: {
      sellable_item_group_id: row.sellable_item_group_id,
      product_line_id: row.product_line_id,
      review_family_id: row.review_family_id,
    },
    before: {
      variant_axes: row.variant_axes || {},
      match_basis: row.match_basis || [],
      matched_by_rule: row.matched_by_rule || '',
      identity_confidence: row.identity_confidence,
    },
    after: {
      variant_axes: nextVariantAxes,
      match_basis: nextMatchBasis,
      matched_by_rule: rebuilt.matched_by_rule,
      identity_confidence: rebuilt.identity_confidence,
      strong_identity: rebuilt.strong_identity || {},
      soft_identity: rebuilt.soft_identity || {},
    },
  };
}

async function applyRepairs(candidates) {
  let updatedRows = 0;
  const errors = [];
  for (const item of candidates) {
    try {
      const res = await query(
        `
          UPDATE pdp_identity_listing
          SET
            variant_axes = $2::jsonb,
            match_basis = $3::jsonb,
            matched_by_rule = $4,
            identity_confidence = $5,
            strong_identity = $6::jsonb,
            soft_identity = $7::jsonb,
            official_url = COALESCE(NULLIF($8, ''), official_url),
            official_domain = COALESCE(NULLIF($9, ''), official_domain),
            updated_at = now()
          WHERE source_listing_ref = $1
            AND (
              variant_axes::text ILIKE '%default title%'
              OR match_basis::text ILIKE '%variant_axes:shade:default%'
            )
        `,
        [
          sanitizeTextForPostgres(item.source_listing_ref),
          stringifyPostgresJsonb(item.after.variant_axes || {}),
          stringifyPostgresJsonb(item.after.match_basis || []),
          sanitizeTextForPostgres(item.after.matched_by_rule || ''),
          Number(item.after.identity_confidence || 0),
          stringifyPostgresJsonb(item.after.strong_identity || {}),
          stringifyPostgresJsonb(item.after.soft_identity || {}),
          sanitizeTextForPostgres(item.official_url || ''),
          sanitizeTextForPostgres(item.official_domain || ''),
        ],
      );
      updatedRows += Number(res.rowCount || 0);
      item.status = Number(res.rowCount || 0) > 0 ? 'updated' : 'unchanged_after_apply';
    } catch (error) {
      item.status = 'apply_failed';
      item.error = error?.message || String(error);
      errors.push({ source_listing_ref: item.source_listing_ref, error: item.error });
    }
  }
  return { updated_rows: updatedRows, failed_rows: errors.length, errors };
}

async function run(options = {}) {
  const ids = uniqueStrings([
    ...readIdsFile(options.externalProductIdsFile),
    ...text(options.externalProductIds).split(',').map((item) => item.trim()).filter(Boolean),
  ]);
  const rows = await loadRows({
    ids,
    market: text(options.market).toUpperCase(),
    domain: text(options.domain),
    limit: Math.max(1, Math.min(5000, Number(options.limit || ids.length || 500) || 500)),
  });
  const results = rows.map(buildRepair);
  const candidates = results.filter((item) => item.status === 'candidate');
  const applyResult = options.write ? await applyRepairs(candidates) : { updated_rows: 0, failed_rows: 0, errors: [] };
  const summary = {
    dry_run: !options.write,
    filters: {
      market: text(options.market).toUpperCase() || null,
      domain: text(options.domain) || null,
      external_product_id_count: ids.length,
      limit: Math.max(1, Math.min(5000, Number(options.limit || ids.length || 500) || 500)),
    },
    scanned_rows: rows.length,
    candidate_rows: candidates.length,
    skipped_rows: results.filter((item) => item.status === 'skipped').length,
    updated_rows: applyResult.updated_rows,
    failed_rows: applyResult.failed_rows || 0,
  };
  const report = {
    generated_at: new Date().toISOString(),
    summary,
    apply_errors: applyResult.errors || [],
    results,
  };
  const outDir = text(options.outDir);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, options.write ? 'apply.json' : 'dry-run.json'), JSON.stringify(report, null, 2));
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return report;
}

async function main() {
  await run({
    market: argValue('market'),
    domain: argValue('domain'),
    externalProductIds: argValue('external-product-ids'),
    externalProductIdsFile: argValue('external-product-ids-file'),
    limit: argValue('limit'),
    outDir: argValue('out-dir'),
    write: hasFlag('write'),
  });
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool().catch(() => {});
    });
}

module.exports = {
  buildRepair,
  defaultTitleAxisRemoved,
  hasDefaultTitleAxis,
  run,
};
