#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const { processRow } = require('./backfill-external-product-seeds-catalog');

const DEFAULT_CATALOG_BASE_URL =
  process.env.CATALOG_INTELLIGENCE_BASE_URL ||
  'https://pivota-catalog-intelligence-production.up.railway.app';

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

function normalizeNonEmptyString(value) {
  return String(value || '').trim();
}

function normalizeCurrency(value) {
  return normalizeNonEmptyString(value).toUpperCase();
}

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function collectVariantCurrencies(seedData) {
  const nextSeedData = ensureObject(seedData);
  const snapshot = ensureObject(nextSeedData.snapshot);
  const variants = Array.isArray(snapshot.variants)
    ? snapshot.variants
    : Array.isArray(nextSeedData.variants)
    ? nextSeedData.variants
    : [];
  return unique(variants.map((variant) => normalizeCurrency(variant?.currency)).filter(Boolean)).sort();
}

function classifyCalibrationAction(row, probeResult) {
  if (probeResult?.status === 'failed') {
    return {
      action: 'probe_failed',
      row_currency: normalizeCurrency(row?.price_currency),
      live_currency: null,
      variant_currencies: [],
      reason: normalizeNonEmptyString(probeResult?.error?.message || probeResult?.error || 'probe_failed'),
    };
  }

  const nextRow = ensureObject(probeResult?.payload?.nextRow);
  const liveCurrency = normalizeCurrency(nextRow.price_currency);
  const variantCurrencies = collectVariantCurrencies(nextRow.seed_data);
  const effectiveCurrencies = unique([liveCurrency, ...variantCurrencies].filter(Boolean));
  const allUsd = effectiveCurrencies.length > 0 && effectiveCurrencies.every((currency) => currency === 'USD');

  if (allUsd) {
    return {
      action: 'refresh_to_usd',
      row_currency: normalizeCurrency(row?.price_currency),
      live_currency: liveCurrency || 'USD',
      variant_currencies: variantCurrencies,
      reason: 'live_usd_currency',
    };
  }

  return {
    action: 'quarantine_inactive',
    row_currency: normalizeCurrency(row?.price_currency),
    live_currency: liveCurrency || null,
    variant_currencies: variantCurrencies,
    reason: effectiveCurrencies.length ? 'live_non_usd_currency' : 'live_missing_currency_signal',
  };
}

async function fetchCandidateRows(options) {
  const where = [`status = 'active'`, `market = 'US'`];
  const params = [];
  let idx = 0;
  const bind = (value) => {
    params.push(value);
    idx += 1;
    return `$${idx}`;
  };

  if (options.seedId) where.push(`id::text = ${bind(options.seedId)}`);
  if (options.domain) where.push(`domain = ${bind(options.domain)}`);
  if (options.brand) where.push(`lower(coalesce(seed_data->>'brand', '')) = lower(${bind(options.brand)})`);

  where.push(`(
    upper(coalesce(price_currency, '')) <> 'USD'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(coalesce(seed_data->'snapshot'->'variants', '[]'::jsonb)) AS v(elem)
      WHERE upper(trim(coalesce(v.elem->>'currency', ''))) <> ''
        AND upper(trim(coalesce(v.elem->>'currency', ''))) <> 'USD'
    )
  )`);

  params.push(options.limit);
  const limitBind = `$${params.length}`;
  params.push(options.offset);
  const offsetBind = `$${params.length}`;

  const sql = `
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
    WHERE ${where.join('\n      AND ')}
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT ${limitBind}
    OFFSET ${offsetBind}
  `;
  const res = await query(sql, params);
  return res.rows || [];
}

async function quarantineRow(row, decision) {
  const payload = {
    blocked: true,
    reason: 'market_currency_mismatch',
    market: 'US',
    source: 'calibrate_us_market_currency_seeds',
    live_currency: decision.live_currency || null,
    variant_currencies: decision.variant_currencies || [],
    previous_row_currency: decision.row_currency || null,
    note: 'US seed stayed non-USD after live catalog probe; row quarantined from active pool.',
  };

  const res = await query(
    `
      UPDATE external_product_seeds
      SET
        status = 'inactive',
        seed_data = jsonb_set(
          jsonb_set(COALESCE(seed_data, '{}'::jsonb), '{market_currency_calibration}', $2::jsonb, true),
          '{snapshot,diagnostics,market_currency_calibration}',
          $2::jsonb,
          true
        ),
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, canonical_url, price_currency
    `,
    [row.id, JSON.stringify(payload)],
  );
  return res.rows?.[0] || null;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const current = next++;
      if (current >= list.length) break;
      results[current] = await fn(list[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function processCandidate(row, options) {
  const dryProbe = await processRow(row, {
    baseUrl: options.baseUrl,
    dryRun: true,
  });
  const decision = classifyCalibrationAction(row, dryProbe);

  if (options.dryRun) {
    return {
      seed_id: row.id,
      domain: row.domain,
      canonical_url: row.canonical_url,
      previous_row_currency: normalizeCurrency(row.price_currency),
      decision,
      probe_status: dryProbe.status,
    };
  }

  if (decision.action === 'refresh_to_usd') {
    const applied = await processRow(row, {
      baseUrl: options.baseUrl,
      dryRun: false,
    });
    return {
      seed_id: row.id,
      domain: row.domain,
      canonical_url: row.canonical_url,
      previous_row_currency: normalizeCurrency(row.price_currency),
      decision,
      apply_status: applied.status,
    };
  }

  if (decision.action === 'quarantine_inactive') {
    const updated = await quarantineRow(row, decision);
    return {
      seed_id: row.id,
      domain: row.domain,
      canonical_url: row.canonical_url,
      previous_row_currency: normalizeCurrency(row.price_currency),
      decision,
      apply_status: updated ? 'quarantined' : 'failed',
    };
  }

  return {
    seed_id: row.id,
    domain: row.domain,
    canonical_url: row.canonical_url,
    previous_row_currency: normalizeCurrency(row.price_currency),
    decision,
    apply_status: 'skipped',
  };
}

function summarize(results, options) {
  const summary = {
    mode: options.dryRun ? 'dry_run' : 'apply',
    scanned: results.length,
    refresh_to_usd: 0,
    quarantine_inactive: 0,
    probe_failed: 0,
    updated: 0,
    quarantined: 0,
    failed: 0,
    by_domain: {},
  };
  for (const item of results) {
    const action = item?.decision?.action || 'unknown';
    if (Object.prototype.hasOwnProperty.call(summary, action)) summary[action] += 1;
    if (item?.apply_status === 'updated') summary.updated += 1;
    if (item?.apply_status === 'quarantined') summary.quarantined += 1;
    if (item?.apply_status === 'failed' || action === 'probe_failed') summary.failed += 1;
    const domain = normalizeNonEmptyString(item?.domain) || 'unknown';
    summary.by_domain[domain] = summary.by_domain[domain] || {
      scanned: 0,
      refresh_to_usd: 0,
      quarantine_inactive: 0,
      probe_failed: 0,
      updated: 0,
      quarantined: 0,
      failed: 0,
    };
    const bucket = summary.by_domain[domain];
    bucket.scanned += 1;
    if (Object.prototype.hasOwnProperty.call(bucket, action)) bucket[action] += 1;
    if (item?.apply_status === 'updated') bucket.updated += 1;
    if (item?.apply_status === 'quarantined') bucket.quarantined += 1;
    if (item?.apply_status === 'failed' || action === 'probe_failed') bucket.failed += 1;
  }
  return summary;
}

async function main() {
  const options = {
    seedId: argValue('seed-id') || null,
    domain: argValue('domain') || null,
    brand: argValue('brand') || null,
    limit: Math.max(1, Math.min(Number(argValue('limit') || 500), 5000)),
    offset: Math.max(0, Number(argValue('offset') || 0)),
    concurrency: Math.max(1, Math.min(Number(argValue('concurrency') || 3), 10)),
    dryRun: hasFlag('dry-run') || !hasFlag('apply'),
    out: normalizeNonEmptyString(argValue('out')),
    baseUrl: normalizeNonEmptyString(argValue('base-url') || process.env.CATALOG_INTELLIGENCE_BASE_URL) || DEFAULT_CATALOG_BASE_URL,
  };

  const rows = await fetchCandidateRows(options);
  const results = await mapWithConcurrency(rows, options.concurrency, async (row) => processCandidate(row, options));
  const output = {
    generated_at: new Date().toISOString(),
    options,
    summary: summarize(results, options),
    items: results,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(serialized);
  if (options.out) {
    ensureParentDir(options.out);
    fs.writeFileSync(options.out, serialized, 'utf8');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  _internals: {
    normalizeCurrency,
    collectVariantCurrencies,
    classifyCalibrationAction,
    summarize,
  },
};
