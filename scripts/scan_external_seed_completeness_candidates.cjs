#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { processRow } = require('./backfill-external-product-seeds-catalog');
const { buildGuardDecision } = require('./run_external_seed_completeness_tranche.cjs');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readSeedValue(seedData, key) {
  const nextSeedData = ensureObject(seedData);
  const snapshot = ensureObject(nextSeedData.snapshot);
  return normalizeNonEmptyString(nextSeedData[key] || snapshot[key]);
}

function readDetailsCount(seedData) {
  const nextSeedData = ensureObject(seedData);
  const snapshot = ensureObject(nextSeedData.snapshot);
  const details = Array.isArray(nextSeedData.pdp_details_sections)
    ? nextSeedData.pdp_details_sections
    : Array.isArray(snapshot.pdp_details_sections)
    ? snapshot.pdp_details_sections
    : [];
  return details.length;
}

function summarizeNextState(row, nextRow) {
  const mergedSeedData = ensureObject(nextRow?.seed_data);
  return {
    seed_id: normalizeNonEmptyString(row?.id),
    title: normalizeNonEmptyString(nextRow?.title || row?.title),
    canonical_url: normalizeNonEmptyString(nextRow?.canonical_url || row?.canonical_url || row?.destination_url),
    seed_description_origin: readSeedValue(mergedSeedData, 'seed_description_origin') || null,
    pdp_description_raw_present: Boolean(readSeedValue(mergedSeedData, 'pdp_description_raw')),
    pdp_ingredients_raw_present: Boolean(readSeedValue(mergedSeedData, 'pdp_ingredients_raw')),
    pdp_active_ingredients_raw_present: Boolean(readSeedValue(mergedSeedData, 'pdp_active_ingredients_raw')),
    pdp_how_to_use_raw_present: Boolean(readSeedValue(mergedSeedData, 'pdp_how_to_use_raw')),
    pdp_details_sections_count: readDetailsCount(mergedSeedData),
    raw_ingredient_text_clean_present: Boolean(readSeedValue(mergedSeedData, 'raw_ingredient_text_clean')),
  };
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchBlankRows({ domain, market, limit, offset }) {
  const res = await query(
    `
      SELECT
        id,
        external_product_id,
        market,
        tool,
        destination_url,
        canonical_url,
        domain,
        title,
        image_url,
        price_amount,
        price_currency,
        availability,
        seed_data,
        status,
        attached_product_key,
        created_at,
        updated_at
      FROM external_product_seeds
      WHERE status = 'active'
        AND market = $1
        AND domain = $2
        AND coalesce(seed_data->>'pdp_description_raw', seed_data#>>'{snapshot,pdp_description_raw}', '') = ''
        AND coalesce(seed_data->>'pdp_ingredients_raw', seed_data#>>'{snapshot,pdp_ingredients_raw}', '') = ''
        AND coalesce(seed_data->>'pdp_active_ingredients_raw', seed_data#>>'{snapshot,pdp_active_ingredients_raw}', '') = ''
        AND coalesce(seed_data->>'pdp_how_to_use_raw', seed_data#>>'{snapshot,pdp_how_to_use_raw}', '') = ''
        AND coalesce(seed_data->>'raw_ingredient_text_clean', seed_data#>>'{snapshot,raw_ingredient_text_clean}', '') = ''
        AND coalesce(
          jsonb_array_length(
            CASE
              WHEN jsonb_typeof(seed_data->'pdp_details_sections') = 'array' THEN seed_data->'pdp_details_sections'
              WHEN jsonb_typeof(seed_data#>'{snapshot,pdp_details_sections}') = 'array' THEN seed_data#>'{snapshot,pdp_details_sections}'
              ELSE '[]'::jsonb
            END
          ),
          0
        ) = 0
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT $3
      OFFSET $4
    `,
    [market, domain, limit, offset],
  );
  return res.rows || [];
}

function summarizeResults(results) {
  const summary = {
    scanned: results.length,
    dry_run: 0,
    skipped: 0,
    failed: 0,
    guard_apply_allowed: 0,
    guard_apply_blocked: 0,
    blocked_by_reason: {},
  };

  for (const result of results) {
    if (result.status === 'dry_run') summary.dry_run += 1;
    if (result.status === 'skipped') summary.skipped += 1;
    if (result.status === 'failed') summary.failed += 1;
    if (result.guard?.allow_apply) {
      summary.guard_apply_allowed += 1;
      continue;
    }
    if (result.status === 'dry_run') {
      summary.guard_apply_blocked += 1;
      for (const reason of Array.isArray(result.guard?.reasons) ? result.guard.reasons : []) {
        summary.blocked_by_reason[reason] = (summary.blocked_by_reason[reason] || 0) + 1;
      }
    }
  }

  return summary;
}

async function main() {
  const domain = normalizeNonEmptyString(argValue('domain'));
  const market = normalizeNonEmptyString(argValue('market') || 'US').toUpperCase();
  const limit = Math.max(1, Math.min(Number(argValue('limit') || 25), 200));
  const offset = Math.max(0, Number(argValue('offset') || 0));
  const concurrency = Math.max(1, Math.min(Number(argValue('concurrency') || 2), 5));
  const outPath = normalizeNonEmptyString(argValue('out'));
  const baseUrl =
    normalizeNonEmptyString(argValue('base-url')) ||
    process.env.CATALOG_INTELLIGENCE_BASE_URL ||
    'https://pivota-catalog-intelligence-production.up.railway.app';

  if (!domain) {
    throw new Error('Usage: node scripts/scan_external_seed_completeness_candidates.cjs --domain <domain> [--market US] [--limit 25] [--offset 0] [--out file]');
  }

  const rows = await fetchBlankRows({ domain, market, limit, offset });
  const results = await mapWithConcurrency(rows, concurrency, async (row) => {
    const dry = await processRow(row, {
      baseUrl,
      market,
      concurrency,
      dryRun: true,
      limit: 1,
      offset: 0,
    });
    const nextState = dry.payload?.nextRow ? summarizeNextState(row, dry.payload.nextRow) : null;
    const item = {
      seed_id: normalizeNonEmptyString(row?.id),
      title: normalizeNonEmptyString(row?.title),
      canonical_url: normalizeNonEmptyString(row?.canonical_url || row?.destination_url),
      status: dry.status,
      reason: dry.reason || null,
      target_url: dry.targetUrl || null,
      next_state: nextState,
    };
    item.guard = buildGuardDecision(item, market);
    return item;
  });

  const payload = {
    generated_at: new Date().toISOString(),
    domain,
    market,
    limit,
    offset,
    summary: summarizeResults(results),
    candidates: results.filter((item) => item.guard?.allow_apply),
    results,
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  summarizeNextState,
  summarizeResults,
};
