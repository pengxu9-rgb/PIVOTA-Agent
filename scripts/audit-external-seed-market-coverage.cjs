#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { query } = require('../src/db');
const {
  _internals: { normalizeTitleCore },
} = require('../src/services/pdpIdentityGraph');

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

function normalizeMarket(value) {
  const text = asString(value).toUpperCase();
  return text || 'US';
}

function normalizeCurrency(value) {
  const text = asString(value).toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : '';
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

function safeFilePart(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'all';
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

function buildSelectSql(options = {}) {
  const brandSql = `coalesce(eps.seed_data->>'brand', eps.seed_data#>>'{snapshot,brand}', '')`;
  const titleSql = `coalesce(eps.title, eps.seed_data->>'title', eps.seed_data#>>'{snapshot,title}', '')`;
  const where = [
    `eps.status = 'active'`,
    `eps.external_product_id LIKE 'ext_%'`,
  ];
  const params = [];

  if (!options.allMarkets) {
    where.push(`eps.market = ${bindParam(params, normalizeMarket(options.market || 'US'))}`);
  }
  if (options.brand) {
    where.push(`lower(${brandSql}) = ${bindParam(params, normalizeText(options.brand))}`);
  }
  if (options.domain) {
    where.push(`lower(coalesce(eps.domain, '')) = ${bindParam(params, normalizeHost(options.domain))}`);
  }
  if (options.externalProductId) {
    where.push(`eps.external_product_id = ${bindParam(params, asString(options.externalProductId))}`);
  }
  if (options.titleLike) {
    where.push(`lower(${titleSql}) LIKE ${bindParam(params, `%${normalizeText(options.titleLike)}%`)}`);
  }

  params.push(Math.max(1, Math.min(Number(options.limit || 1000), 20000)));
  const limitBind = `$${params.length}`;
  params.push(Math.max(0, Number(options.offset || 0)));
  const offsetBind = `$${params.length}`;

  return {
    sql: `
      SELECT
        eps.id,
        eps.external_product_id,
        eps.market,
        eps.tool,
        ${brandSql} AS brand,
        eps.domain,
        eps.title,
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
      OFFSET ${offsetBind}
    `,
    params,
  };
}

function deriveCoverageRow(row = {}) {
  const seedData = asPlainObject(row.seed_data);
  const snapshot = asPlainObject(seedData.snapshot);
  const brand = asString(row.brand || seedData.brand || snapshot.brand);
  const title = asString(row.title || seedData.title || snapshot.title);
  const titleCore = normalizeTitleCore(title, brand, null);
  const canonicalUrl = asString(row.canonical_url || seedData.canonical_url || snapshot.canonical_url);
  const destinationUrl = asString(row.destination_url || seedData.destination_url || snapshot.destination_url);
  const host = normalizeHost(row.domain || canonicalUrl || destinationUrl);
  const market = normalizeMarket(row.market || seedData.market || snapshot.market || 'US');
  const topFacts = asPlainObject(seedData.commerce_facts_v1);
  const snapFacts = asPlainObject(snapshot.commerce_facts_v1);
  const commerceFacts =
    topFacts.contract_version === 'commerce_facts.v1'
      ? topFacts
      : snapFacts.contract_version === 'commerce_facts.v1'
        ? snapFacts
        : null;
  const regionalPrice = asPlainObject(commerceFacts && commerceFacts.regional_price);
  const priceCurrency =
    normalizeCurrency(regionalPrice.observed_currency) ||
    normalizeCurrency(regionalPrice.currency) ||
    normalizeCurrency(row.price_currency || seedData.price_currency || snapshot.price_currency);
  const priceAmount =
    Number.isFinite(Number(regionalPrice.amount))
      ? Number(regionalPrice.amount)
      : Number.isFinite(Number(row.price_amount))
        ? Number(row.price_amount)
        : Number.isFinite(Number(seedData.price_amount))
          ? Number(seedData.price_amount)
          : null;
  return {
    id: row.id,
    external_product_id: asString(row.external_product_id),
    tool: asString(row.tool),
    brand,
    brand_norm: normalizeText(brand),
    title,
    title_core_norm: titleCore,
    market,
    domain: host,
    canonical_url: canonicalUrl,
    destination_url: destinationUrl,
    price_amount: priceAmount,
    price_currency: priceCurrency,
    availability: asString(row.availability || seedData.availability || snapshot.availability).toLowerCase() || 'unknown',
    commerce_facts_market_id: normalizeMarket(commerceFacts && commerceFacts.market_id),
    commerce_facts_currency_target: normalizeCurrency(commerceFacts && commerceFacts.currency_target),
  };
}

function buildMarketCoverageGroups(rows = []) {
  const groups = new Map();
  for (const rawRow of Array.isArray(rows) ? rows : []) {
    const row = deriveCoverageRow(rawRow);
    if (!row.brand_norm || !row.title_core_norm) continue;
    const key = `${row.brand_norm}|${row.title_core_norm}`;
    const current = groups.get(key) || {
      key,
      brand: row.brand,
      brand_norm: row.brand_norm,
      title_core_norm: row.title_core_norm,
      title_samples: [],
      domains: new Set(),
      tools: new Set(),
      markets: new Set(),
      currencies: new Set(),
      by_market: new Map(),
      rows: [],
    };
    current.title_samples.push(row.title);
    current.domains.add(row.domain);
    current.tools.add(row.tool);
    current.markets.add(row.market);
    if (row.price_currency) current.currencies.add(row.price_currency);
    const perMarket = current.by_market.get(row.market) || {
      market: row.market,
      row_count: 0,
      external_product_ids: [],
      domains: new Set(),
      currencies: new Set(),
      price_amounts: [],
      title_samples: [],
      availability_states: new Set(),
    };
    perMarket.row_count += 1;
    perMarket.external_product_ids.push(row.external_product_id);
    perMarket.domains.add(row.domain);
    if (row.price_currency) perMarket.currencies.add(row.price_currency);
    if (row.price_amount != null) perMarket.price_amounts.push(row.price_amount);
    if (row.title) perMarket.title_samples.push(row.title);
    if (row.availability) perMarket.availability_states.add(row.availability);
    current.by_market.set(row.market, perMarket);
    current.rows.push(row);
    groups.set(key, current);
  }

  return Array.from(groups.values()).map((group) => {
    const byMarket = Array.from(group.by_market.values())
      .sort((a, b) => a.market.localeCompare(b.market))
      .map((entry) => ({
        market: entry.market,
        row_count: entry.row_count,
        external_product_ids: Array.from(new Set(entry.external_product_ids)).sort(),
        domains: Array.from(entry.domains).filter(Boolean).sort(),
        currencies: Array.from(entry.currencies).filter(Boolean).sort(),
        price_amount_min: entry.price_amounts.length ? Math.min(...entry.price_amounts) : null,
        price_amount_max: entry.price_amounts.length ? Math.max(...entry.price_amounts) : null,
        availability_states: Array.from(entry.availability_states).filter(Boolean).sort(),
        title_samples: Array.from(new Set(entry.title_samples)).slice(0, 3),
      }));
    const markets = byMarket.map((entry) => entry.market);
    const currencies = Array.from(group.currencies).sort();
    const multiMarket = markets.length > 1;
    const currencyDivergence = currencies.length > 1;
    return {
      key: group.key,
      brand: group.brand,
      brand_norm: group.brand_norm,
      title_core_norm: group.title_core_norm,
      title_samples: Array.from(new Set(group.title_samples)).slice(0, 5),
      markets,
      market_count: markets.length,
      domains: Array.from(group.domains).filter(Boolean).sort(),
      tools: Array.from(group.tools).filter(Boolean).sort(),
      currencies,
      multi_market: multiMarket,
      currency_divergence: currencyDivergence,
      total_row_count: group.rows.length,
      by_market: byMarket,
    };
  });
}

function summarizeCoverageGroups(groups = []) {
  const rows = Array.isArray(groups) ? groups : [];
  const multiMarketGroups = rows.filter((row) => row.multi_market);
  const singleMarketGroups = rows.filter((row) => !row.multi_market);
  const currencyDivergenceGroups = rows.filter((row) => row.currency_divergence);
  return {
    total_groups: rows.length,
    multi_market_groups: multiMarketGroups.length,
    single_market_groups: singleMarketGroups.length,
    currency_divergence_groups: currencyDivergenceGroups.length,
    sample_multi_market_groups: multiMarketGroups.slice(0, 10).map((row) => ({
      brand: row.brand,
      title_core_norm: row.title_core_norm,
      markets: row.markets,
      currencies: row.currencies,
      total_row_count: row.total_row_count,
    })),
  };
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function main() {
  const options = {
    market: argValue('market') || 'US',
    brand: argValue('brand'),
    domain: argValue('domain'),
    externalProductId: argValue('external-product-id') || argValue('externalProductId'),
    titleLike: argValue('title-like') || argValue('titleLike'),
    limit: Number(argValue('limit') || 1000),
    offset: Number(argValue('offset') || 0),
    allMarkets: hasFlag('all-markets') || hasFlag('allMarkets'),
  };

  const defaultOut = path.resolve(
    '/Users/pengchydan/dev/PIVOTA-Agent/reports/k_beauty_seed_expansion_20260429',
    `external_seed_market_coverage_${safeFilePart(options.brand || options.domain || options.externalProductId || options.market || 'all')}.json`,
  );
  const outPath = path.resolve(argValue('out') || defaultOut);

  const { sql, params } = buildSelectSql(options);
  const res = await query(sql, params);
  const rawRows = res.rows || [];
  const coverageGroups = buildMarketCoverageGroups(rawRows);
  const summary = summarizeCoverageGroups(coverageGroups);
  const report = {
    generated_at: new Date().toISOString(),
    options: {
      ...options,
      out: outPath,
    },
    scanned_rows: rawRows.length,
    summary,
    groups: coverageGroups,
  };
  ensureParentDir(outPath);
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ out: outPath, scanned_rows: rawRows.length, summary }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error?.code || error?.name || 'market_coverage_audit_failed',
          message: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });
}

module.exports = {
  buildSelectSql,
  deriveCoverageRow,
  buildMarketCoverageGroups,
  summarizeCoverageGroups,
};
