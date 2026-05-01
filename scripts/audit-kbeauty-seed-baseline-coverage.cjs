#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');

const DEFAULT_DTC_BASELINE_PATH = path.resolve(
  __dirname,
  '../data/beauty/k_beauty_validated_dtc_seed_baseline.json',
);
const DEFAULT_CHANNEL_BASELINE_PATH = path.resolve(
  __dirname,
  '../data/beauty/k_beauty_validated_channel_seed_baseline.json',
);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return asString(value).toLowerCase();
}

function normalizeComparableText(value) {
  return asString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeMarket(value) {
  const text = asString(value).toUpperCase();
  return text || 'US';
}

function normalizeHost(value) {
  const raw = asString(value).toLowerCase();
  if (!raw) return '';
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) {
    return raw.replace(/^www\./, '').replace(/\.+$/, '');
  }
  try {
    const url = new URL(raw);
    return String(url.hostname || '')
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.+$/, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

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

function bindParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function parseKnownBrandHints(value) {
  const parts = asString(value)
    .split(/[;,\n]+/)
    .map((item) => asString(item))
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const item of parts) {
    const norm = normalizeComparableText(item);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ label: item, norm });
  }
  return out;
}

function loadBaseline(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(parsed?.rows) ? parsed.rows : [];
}

function buildSelectSql(options = {}) {
  const brandSql = `coalesce(eps.seed_data->>'brand', eps.seed_data#>>'{snapshot,brand}', '')`;
  const titleSql = `coalesce(eps.title, eps.seed_data->>'title', eps.seed_data#>>'{snapshot,title}', '')`;
  const where = [
    `eps.status = 'active'`,
    `eps.external_product_id LIKE 'ext_%'`,
    `(eps.tool = '*' OR eps.tool = 'creator_agents')`,
  ];
  const params = [];

  if (!options.allMarkets) {
    where.push(`eps.market = ${bindParam(params, normalizeMarket(options.market || 'US'))}`);
  }

  params.push(Math.max(1, Math.min(Number(options.limit || 50000), 100000)));
  const limitBind = `$${params.length}`;

  return {
    sql: `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.tool,
        ${brandSql} AS brand,
        ${titleSql} AS title,
        eps.domain,
        eps.canonical_url,
        eps.destination_url,
        eps.price_amount,
        eps.price_currency,
        eps.availability,
        coalesce(eps.seed_data, '{}'::jsonb) AS seed_data
      FROM external_product_seeds eps
      WHERE ${where.join('\n        AND ')}
      ORDER BY lower(${brandSql}), lower(${titleSql}), eps.market, eps.id
      LIMIT ${limitBind}
    `,
    params,
  };
}

function deriveSeedRow(row = {}) {
  const seedData = asPlainObject(row.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const brand = asString(row.brand || seedData.brand || snapshot.brand);
  const title = asString(row.title || seedData.title || snapshot.title);
  const hosts = [
    normalizeHost(row.domain),
    normalizeHost(row.canonical_url || seedData.canonical_url || snapshot.canonical_url),
    normalizeHost(row.destination_url || seedData.destination_url || snapshot.destination_url),
  ].filter(Boolean);

  return {
    id: asString(row.id),
    external_product_id: asString(row.external_product_id),
    brand,
    brand_norm: normalizeComparableText(brand),
    title,
    title_norm: normalizeComparableText(title),
    market: normalizeMarket(row.market || seedData.market || snapshot.market || 'US'),
    tool: asString(row.tool),
    availability: asString(row.availability || seedData.availability || snapshot.availability).toLowerCase() || 'unknown',
    price_currency: asString(row.price_currency || seedData.price_currency || snapshot.price_currency).toUpperCase() || null,
    hosts: Array.from(new Set(hosts)),
  };
}

function summarizeMatchedRows(rows = []) {
  const markets = new Set();
  const brands = new Set();
  const currencies = new Set();
  let inStockCount = 0;
  for (const row of rows) {
    if (row.market) markets.add(row.market);
    if (row.brand) brands.add(row.brand);
    if (row.price_currency) currencies.add(row.price_currency);
    if (row.availability === 'in_stock') inStockCount += 1;
  }
  return {
    active_seed_count: rows.length,
    in_stock_count: inStockCount,
    markets: Array.from(markets).sort(),
    currencies: Array.from(currencies).sort(),
    matched_brands: Array.from(brands).sort(),
    sample_external_product_ids: rows.slice(0, 10).map((row) => row.external_product_id),
    sample_titles: rows.slice(0, 10).map((row) => row.title),
  };
}

function buildDtcCoverage(dtcBaselineRows = [], seedRows = []) {
  const results = dtcBaselineRows.map((entry) => {
    const officialHost = normalizeHost(entry.official_site);
    const matchedRows = seedRows.filter((row) => row.hosts.includes(officialHost));
    const coverage = summarizeMatchedRows(matchedRows);
    return {
      brand_name: asString(entry.brand_name),
      official_site: asString(entry.official_site),
      official_host: officialHost,
      region_focus: asString(entry.region_focus),
      priority_tier: asString(entry.priority_tier),
      transaction_ready: asString(entry.transaction_ready),
      validation_status: asString(entry.validation_status),
      covered: coverage.active_seed_count > 0,
      ...coverage,
    };
  });

  const covered = results.filter((row) => row.covered);
  return {
    baseline_brand_count: results.length,
    covered_brand_count: covered.length,
    covered_brand_names: covered.map((row) => row.brand_name),
    missing_brand_names: results.filter((row) => !row.covered).map((row) => row.brand_name),
    active_seed_count: covered.reduce((sum, row) => sum + row.active_seed_count, 0),
    rows: results,
  };
}

function buildChannelCoverage(channelBaselineRows = [], seedRows = []) {
  const results = channelBaselineRows.map((entry) => {
    const host = normalizeHost(entry.website);
    const knownBrandHints = parseKnownBrandHints(entry.seed_known_brands_to_check);
    const matchedRows = seedRows.filter((row) => row.hosts.includes(host));
    const coverage = summarizeMatchedRows(matchedRows);
    const matchedKnownBrands = knownBrandHints
      .map((hint) => ({
        label: hint.label,
        active_seed_count: matchedRows.filter((row) => row.brand_norm === hint.norm).length,
      }))
      .filter((item) => item.active_seed_count > 0);
    return {
      channel_name: asString(entry.channel_name),
      website: asString(entry.website),
      website_host: host,
      channel_type: asString(entry.channel_type),
      region_focus: asString(entry.region_focus),
      priority_tier: asString(entry.priority_tier),
      transaction_ready: asString(entry.transaction_ready),
      validation_status: asString(entry.validation_status),
      covered: coverage.active_seed_count > 0,
      matched_known_brand_count: matchedKnownBrands.length,
      matched_known_brands: matchedKnownBrands,
      known_brand_hint_count: knownBrandHints.length,
      ...coverage,
    };
  });

  const covered = results.filter((row) => row.covered);
  return {
    baseline_channel_count: results.length,
    covered_channel_count: covered.length,
    covered_channel_names: covered.map((row) => row.channel_name),
    missing_channel_names: results.filter((row) => !row.covered).map((row) => row.channel_name),
    active_seed_count: covered.reduce((sum, row) => sum + row.active_seed_count, 0),
    matched_known_brand_count: covered.reduce((sum, row) => sum + row.matched_known_brand_count, 0),
    rows: results,
  };
}

async function main() {
  const outPath = argValue('out');
  const options = {
    market: argValue('market') || 'US',
    allMarkets: hasFlag('all-markets'),
    limit: argValue('limit') || '50000',
    dtcBaselinePath: argValue('dtc-baseline') || DEFAULT_DTC_BASELINE_PATH,
    channelBaselinePath: argValue('channel-baseline') || DEFAULT_CHANNEL_BASELINE_PATH,
  };

  const dtcBaselineRows = loadBaseline(options.dtcBaselinePath);
  const channelBaselineRows = loadBaseline(options.channelBaselinePath);
  const { sql, params } = buildSelectSql(options);
  const res = await query(sql, params);
  const seedRows = (res.rows || []).map(deriveSeedRow);

  const dtc = buildDtcCoverage(dtcBaselineRows, seedRows);
  const channels = buildChannelCoverage(channelBaselineRows, seedRows);
  const summary = {
    generated_at: new Date().toISOString(),
    market: normalizeMarket(options.market),
    all_markets: Boolean(options.allMarkets),
    baseline_sources: {
      dtc: options.dtcBaselinePath,
      channels: options.channelBaselinePath,
    },
    seed_rows_scanned: seedRows.length,
    dtc,
    channels,
  };

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  }

  console.log(
    JSON.stringify(
      {
        generated_at: summary.generated_at,
        market: summary.market,
        all_markets: summary.all_markets,
        seed_rows_scanned: summary.seed_rows_scanned,
        dtc: {
          baseline_brand_count: dtc.baseline_brand_count,
          covered_brand_count: dtc.covered_brand_count,
          active_seed_count: dtc.active_seed_count,
          missing_brand_names: dtc.missing_brand_names,
        },
        channels: {
          baseline_channel_count: channels.baseline_channel_count,
          covered_channel_count: channels.covered_channel_count,
          active_seed_count: channels.active_seed_count,
          missing_channel_names: channels.missing_channel_names,
          matched_known_brand_count: channels.matched_known_brand_count,
        },
        out: outPath || null,
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  parseKnownBrandHints,
  buildSelectSql,
  deriveSeedRow,
  buildDtcCoverage,
  buildChannelCoverage,
};
