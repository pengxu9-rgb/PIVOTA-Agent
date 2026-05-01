#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { query, withClient } = require('../src/db');
const {
  applyLocalityFactsToSeedData,
  hasLocalityFactsValue,
  resolveExternalSeedLocalityFacts,
} = require('../src/services/externalSeedLocalityFacts');

function normalizeString(value, maxLen = 240) {
  if (value == null) return '';
  const text = String(value).trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, maxLen) : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureJsonObject(value) {
  if (isPlainObject(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function argValue(name, argv = process.argv) {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || value.startsWith('--')) return null;
  return value;
}

function hasFlag(name, argv = process.argv) {
  return argv.includes(`--${name}`);
}

function parseDelimitedList(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (isPlainObject(value)) {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableJson(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function parseOptions(argv = process.argv) {
  const seedIds = parseDelimitedList(argValue('seed-id', argv) || argValue('seed-ids', argv));
  const externalProductIds = parseDelimitedList(
    argValue('external-product-id', argv) || argValue('external-product-ids', argv),
  );
  return {
    apply: hasFlag('apply', argv),
    includeExisting: hasFlag('include-existing', argv),
    allStatus: hasFlag('all-status', argv),
    market: normalizeString(argValue('market', argv), 12).toUpperCase(),
    tool: normalizeString(argValue('tool', argv), 80),
    brand: normalizeString(argValue('brand', argv), 120),
    seedIds,
    externalProductIds,
    limit: Math.max(1, Math.min(Number(argValue('limit', argv)) || 100, 5000)),
    out: normalizeString(argValue('out', argv), 500),
  };
}

function buildSelectRowsSql(options = {}) {
  const where = [];
  const params = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (!options.allStatus) where.push(`status = 'active'`);
  if (options.market) where.push(`upper(market) = ${addParam(String(options.market).toUpperCase())}`);
  if (options.tool) where.push(`tool = ${addParam(options.tool)}`);
  if (options.brand) {
    where.push(
      `lower(coalesce(seed_data->>'brand', seed_data#>>'{snapshot,brand}', seed_data->>'brand_name', seed_data#>>'{snapshot,brand_name}', '')) = lower(${addParam(options.brand)})`,
    );
  }
  if (Array.isArray(options.seedIds) && options.seedIds.length) {
    where.push(`id::text = ANY(${addParam(options.seedIds)}::text[])`);
  }
  if (Array.isArray(options.externalProductIds) && options.externalProductIds.length) {
    where.push(`external_product_id = ANY(${addParam(options.externalProductIds)}::text[])`);
  }
  if (!options.includeExisting) {
    where.push(`seed_data->'locality_facts_v1' IS NULL`);
    where.push(`seed_data#>'{snapshot,locality_facts_v1}' IS NULL`);
  }
  const limitRef = addParam(Math.max(1, Math.min(Number(options.limit) || 100, 5000)));
  return {
    sql: `
      SELECT
        id,
        market,
        tool,
        status,
        domain,
        external_product_id,
        canonical_url,
        destination_url,
        title,
        seed_data,
        created_at,
        updated_at
      FROM external_product_seeds
      ${where.length ? `WHERE ${where.join('\n        AND ')}` : ''}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      LIMIT ${limitRef}
    `,
    params,
  };
}

function buildLocalityBackfillPlanForRow(row) {
  const seedData = ensureJsonObject(row?.seed_data);
  const snapshot = ensureJsonObject(seedData.snapshot);
  const facts = resolveExternalSeedLocalityFacts({ row, seedData, snapshot });
  const nextSeedData = applyLocalityFactsToSeedData(seedData, facts);
  const changed = JSON.stringify(stableJson(seedData)) !== JSON.stringify(stableJson(nextSeedData));
  const brand = normalizeString(seedData.brand || snapshot.brand || row?.brand || row?.seed_brand, 120);
  return {
    seed_id: normalizeString(row?.id, 80),
    external_product_id: normalizeString(row?.external_product_id, 160) || null,
    market: normalizeString(row?.market, 12).toUpperCase() || null,
    brand: brand || null,
    title: normalizeString(row?.title || seedData.title || snapshot.title, 220) || null,
    changed,
    has_locality_facts: hasLocalityFactsValue(facts),
    locality_facts_v1: facts,
    next_seed_data: nextSeedData,
  };
}

function summarizePlans(plans = []) {
  const changed = plans.filter((plan) => plan.changed);
  const unknownBrands = new Set();
  const markets = {};
  const localPurchaseMarkets = {};
  let travelSizeTrue = 0;
  for (const plan of plans) {
    const market = plan.market || 'unknown';
    markets[market] = (markets[market] || 0) + 1;
    const facts = plan.locality_facts_v1 || {};
    if (plan.brand && !facts.brand_home_market) unknownBrands.add(plan.brand);
    for (const localMarket of Array.isArray(facts.local_purchase_markets) ? facts.local_purchase_markets : []) {
      localPurchaseMarkets[localMarket] = (localPurchaseMarkets[localMarket] || 0) + 1;
    }
    if (facts.travel_size === true) travelSizeTrue += 1;
  }
  return {
    total_rows: plans.length,
    changed_rows: changed.length,
    unchanged_rows: plans.length - changed.length,
    market_counts: markets,
    local_purchase_market_counts: localPurchaseMarkets,
    travel_size_true_rows: travelSizeTrue,
    unknown_brand_home_market_count: unknownBrands.size,
    unknown_brand_home_market_sample: Array.from(unknownBrands).slice(0, 25),
  };
}

async function fetchRows(options = {}) {
  const { sql, params } = buildSelectRowsSql(options);
  const res = await query(sql, params);
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function applyPlans(plans = []) {
  const changed = plans.filter((plan) => plan.changed && plan.seed_id);
  if (!changed.length) return { updated_rows: 0 };
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const plan of changed) {
        await client.query(
          `UPDATE external_product_seeds
           SET seed_data = $2::jsonb, updated_at = now()
           WHERE id::text = $1`,
          [plan.seed_id, JSON.stringify(plan.next_seed_data)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
  return { updated_rows: changed.length };
}

function buildReport(plans, options = {}, applyResult = null) {
  return {
    report_version: 'external_seed_locality_backfill_report.v1',
    mode: options.apply ? 'apply' : 'dry_run',
    generated_at: new Date().toISOString(),
    filters: {
      market: options.market || null,
      tool: options.tool || null,
      brand: options.brand || null,
      seed_ids: options.seedIds || [],
      external_product_ids: options.externalProductIds || [],
      include_existing: Boolean(options.includeExisting),
      all_status: Boolean(options.allStatus),
      limit: options.limit,
    },
    summary: summarizePlans(plans),
    apply_result: applyResult,
    rows: plans.map((plan) => ({
      seed_id: plan.seed_id,
      external_product_id: plan.external_product_id,
      market: plan.market,
      brand: plan.brand,
      title: plan.title,
      changed: plan.changed,
      has_locality_facts: plan.has_locality_facts,
      locality_facts_v1: plan.locality_facts_v1,
    })),
  };
}

async function main() {
  const options = parseOptions(process.argv);
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to read external_product_seeds');
  }
  const rows = await fetchRows(options);
  const plans = rows.map(buildLocalityBackfillPlanForRow);
  const applyResult = options.apply ? await applyPlans(plans) : null;
  const report = buildReport(plans, options, applyResult);
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const outPath = path.resolve(process.cwd(), options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output);
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[locality-backfill] ${err?.message || err}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseOptions,
  buildSelectRowsSql,
  buildLocalityBackfillPlanForRow,
  summarizePlans,
  buildReport,
};
