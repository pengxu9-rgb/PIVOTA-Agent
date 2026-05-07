#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { closePool, query } = require('../src/db');

function parseArgs(argv) {
  const args = {
    out: '',
    markdownOut: '',
    topN: 25,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--out') {
      args.out = next || '';
      i += 1;
    } else if (arg === '--markdown-out') {
      args.markdownOut = next || '';
      i += 1;
    } else if (arg === '--top-n') {
      const parsed = Number(next);
      args.topN = Number.isFinite(parsed) && parsed > 0 ? Math.min(100, Math.trunc(parsed)) : args.topN;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/audit-production-catalog-counts.cjs [options]

Read-only production catalog count audit.

Options:
  --out <path>            Write full JSON report
  --markdown-out <path>   Write compact Markdown summary
  --top-n <number>        Top breakdown size (default 25)
`);
}

async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || {};
}

async function many(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function tableExists(tableName) {
  const row = await one('SELECT to_regclass($1) AS regclass', [`public.${tableName}`]);
  return Boolean(row.regclass);
}

async function tableColumns(tableName) {
  const rows = await many(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  return new Set(rows.map((row) => row.column_name));
}

async function safeSection(name, fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      error: err?.message || String(err),
      section: name,
    };
  }
}

function normalizeCountRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (typeof value === 'bigint') out[key] = Number(value);
    else if (value && typeof value === 'object' && value.constructor?.name === 'BigInt') out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

async function auditExternalSeeds(topN) {
  if (!(await tableExists('external_product_seeds'))) {
    return { table_exists: false };
  }

  const totals = normalizeCountRow(
    await one(`
      SELECT
        COUNT(*)::int AS total_rows,
        COUNT(*) FILTER (WHERE lower(coalesce(status, '')) = 'active')::int AS active_rows,
        COUNT(*) FILTER (WHERE lower(coalesce(status, '')) <> 'active')::int AS non_active_rows,
        COUNT(*) FILTER (
          WHERE lower(coalesce(status, '')) = 'active'
            AND coalesce(attached_product_key, '') = ''
        )::int AS active_standalone_pdp_rows,
        COUNT(*) FILTER (
          WHERE lower(coalesce(status, '')) = 'active'
            AND coalesce(attached_product_key, '') <> ''
        )::int AS active_attached_rows,
        COUNT(DISTINCT external_product_id) FILTER (
          WHERE coalesce(external_product_id, '') <> ''
        )::int AS distinct_external_product_ids,
        COUNT(DISTINCT external_product_id) FILTER (
          WHERE lower(coalesce(status, '')) = 'active'
            AND coalesce(external_product_id, '') <> ''
        )::int AS distinct_active_external_product_ids,
        COUNT(DISTINCT lower(coalesce(domain, ''))) FILTER (
          WHERE coalesce(domain, '') <> ''
        )::int AS distinct_domains,
        COUNT(DISTINCT lower(coalesce(market, ''))) FILTER (
          WHERE coalesce(market, '') <> ''
        )::int AS distinct_markets
      FROM external_product_seeds
    `),
  );

  const byStatus = await many(
    `
      SELECT coalesce(nullif(status, ''), 'unknown') AS status, COUNT(*)::int AS rows
      FROM external_product_seeds
      GROUP BY 1
      ORDER BY rows DESC, status
    `,
  );

  const byMarket = await many(
    `
      SELECT coalesce(nullif(market, ''), 'unknown') AS market, COUNT(*)::int AS rows
      FROM external_product_seeds
      GROUP BY 1
      ORDER BY rows DESC, market
      LIMIT $1
    `,
    [topN],
  );

  const activeByMarket = await many(
    `
      SELECT coalesce(nullif(market, ''), 'unknown') AS market, COUNT(*)::int AS rows
      FROM external_product_seeds
      WHERE lower(coalesce(status, '')) = 'active'
      GROUP BY 1
      ORDER BY rows DESC, market
      LIMIT $1
    `,
    [topN],
  );

  const byTool = await many(
    `
      SELECT coalesce(nullif(tool, ''), 'unknown') AS tool, COUNT(*)::int AS rows
      FROM external_product_seeds
      GROUP BY 1
      ORDER BY rows DESC, tool
      LIMIT $1
    `,
    [topN],
  );

  const activeByDomain = await many(
    `
      SELECT coalesce(nullif(lower(domain), ''), 'unknown') AS domain, COUNT(*)::int AS rows
      FROM external_product_seeds
      WHERE lower(coalesce(status, '')) = 'active'
      GROUP BY 1
      ORDER BY rows DESC, domain
      LIMIT $1
    `,
    [topN],
  );

  const activeByBrand = await many(
    `
      WITH normalized AS (
        SELECT
          nullif(
            btrim(
              coalesce(
                seed_data#>>'{snapshot,brand}',
                seed_data->>'brand',
                seed_data#>>'{snapshot,vendor}',
                seed_data->>'vendor',
                seed_data#>>'{source,brand}',
                ''
              )
            ),
            ''
          ) AS brand
        FROM external_product_seeds
        WHERE lower(coalesce(status, '')) = 'active'
      )
      SELECT coalesce(brand, 'unknown') AS brand, COUNT(*)::int AS rows
      FROM normalized
      GROUP BY 1
      ORDER BY rows DESC, brand
      LIMIT $1
    `,
    [topN],
  );

  const activeByVertical = await many(
    `
      WITH normalized AS (
        SELECT
          nullif(
            btrim(
              coalesce(
                seed_data#>>'{recall_doc,semantic_vertical}',
                seed_data#>>'{snapshot,semantic_vertical}',
                seed_data#>>'{derived,recall,semantic_vertical}',
                seed_data#>>'{derived,semantic_vertical}',
                seed_data#>>'{snapshot,category}',
                seed_data->>'category',
                ''
              )
            ),
            ''
          ) AS vertical
        FROM external_product_seeds
        WHERE lower(coalesce(status, '')) = 'active'
      )
      SELECT coalesce(vertical, 'unknown') AS vertical, COUNT(*)::int AS rows
      FROM normalized
      GROUP BY 1
      ORDER BY rows DESC, vertical
      LIMIT $1
    `,
    [topN],
  );

  return {
    table_exists: true,
    totals,
    by_status: byStatus,
    by_market: byMarket,
    active_by_market: activeByMarket,
    by_tool: byTool,
    active_by_domain: activeByDomain,
    active_by_brand: activeByBrand,
    active_by_vertical: activeByVertical,
  };
}

async function auditProductsCache(topN) {
  if (!(await tableExists('products_cache'))) {
    return { table_exists: false };
  }

  const columns = await tableColumns('products_cache');
  const hasProductData = columns.has('product_data');
  const hasMerchantId = columns.has('merchant_id');
  const hasExpiresAt = columns.has('expires_at');

  const selectParts = ['COUNT(*)::int AS total_rows'];
  if (hasMerchantId) selectParts.push("COUNT(DISTINCT merchant_id)::int AS distinct_merchants");
  if (hasExpiresAt) {
    selectParts.push("COUNT(*) FILTER (WHERE expires_at IS NULL OR expires_at > now())::int AS unexpired_rows");
    selectParts.push("COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now())::int AS expired_rows");
  }
  if (hasProductData) {
    selectParts.push(
      "COUNT(*) FILTER (WHERE lower(coalesce(product_data->>'status', '')) IN ('active', 'published', 'enabled', 'live'))::int AS active_like_rows",
    );
    selectParts.push(
      "COUNT(*) FILTER (WHERE lower(coalesce(product_data->>'orderable', '')) IN ('true', '1', 'yes'))::int AS orderable_like_rows",
    );
    selectParts.push(
      "COUNT(*) FILTER (WHERE nullif(btrim(coalesce(product_data->>'title', '')), '') IS NOT NULL)::int AS rows_with_title",
    );
    selectParts.push(
      "COUNT(*) FILTER (WHERE nullif(btrim(coalesce(product_data->>'image_url', product_data->>'image', '')), '') IS NOT NULL)::int AS rows_with_image",
    );
  }

  const totals = normalizeCountRow(await one(`SELECT ${selectParts.join(',\n')} FROM products_cache`));

  const byMerchant = hasMerchantId
    ? await many(
        `
          SELECT coalesce(nullif(merchant_id, ''), 'unknown') AS merchant_id, COUNT(*)::int AS rows
          FROM products_cache
          GROUP BY 1
          ORDER BY rows DESC, merchant_id
          LIMIT $1
        `,
        [topN],
      )
    : [];

  const byStatus = hasProductData
    ? await many(
        `
          SELECT coalesce(nullif(lower(product_data->>'status'), ''), 'unknown') AS status, COUNT(*)::int AS rows
          FROM products_cache
          GROUP BY 1
          ORDER BY rows DESC, status
          LIMIT $1
        `,
        [topN],
      )
    : [];

  const byVendor = hasProductData
    ? await many(
        `
          SELECT coalesce(nullif(product_data->>'vendor', ''), 'unknown') AS vendor, COUNT(*)::int AS rows
          FROM products_cache
          GROUP BY 1
          ORDER BY rows DESC, vendor
          LIMIT $1
        `,
        [topN],
      )
    : [];

  return {
    table_exists: true,
    columns: Array.from(columns),
    totals,
    by_merchant: byMerchant,
    by_status: byStatus,
    by_vendor: byVendor,
  };
}

async function auditIdentityGraph(topN) {
  if (!(await tableExists('pdp_identity_listing'))) {
    return { table_exists: false };
  }

  const totals = normalizeCountRow(
    await one(`
      SELECT
        COUNT(*)::int AS total_listing_rows,
        COUNT(*) FILTER (WHERE live_read_enabled)::int AS live_read_enabled_rows,
        COUNT(DISTINCT sellable_item_group_id)::int AS distinct_sellable_item_groups,
        COUNT(DISTINCT product_line_id)::int AS distinct_product_lines,
        COUNT(DISTINCT review_family_id)::int AS distinct_review_families,
        COUNT(*) FILTER (WHERE merchant_id = 'external_seed')::int AS external_seed_listing_rows,
        COUNT(*) FILTER (WHERE merchant_id <> 'external_seed')::int AS non_external_seed_listing_rows,
        COUNT(*) FILTER (WHERE identity_status = 'verified')::int AS verified_rows,
        COUNT(*) FILTER (WHERE identity_status <> 'verified')::int AS non_verified_rows
      FROM pdp_identity_listing
    `),
  );

  const byMerchant = await many(
    `
      SELECT coalesce(nullif(merchant_id, ''), 'unknown') AS merchant_id, COUNT(*)::int AS rows
      FROM pdp_identity_listing
      GROUP BY 1
      ORDER BY rows DESC, merchant_id
      LIMIT $1
    `,
    [topN],
  );

  const byStatus = await many(
    `
      SELECT coalesce(nullif(identity_status, ''), 'unknown') AS identity_status, COUNT(*)::int AS rows
      FROM pdp_identity_listing
      GROUP BY 1
      ORDER BY rows DESC, identity_status
      LIMIT $1
    `,
    [topN],
  );

  const liveByMerchant = await many(
    `
      SELECT coalesce(nullif(merchant_id, ''), 'unknown') AS merchant_id, COUNT(*)::int AS rows
      FROM pdp_identity_listing
      WHERE live_read_enabled
      GROUP BY 1
      ORDER BY rows DESC, merchant_id
      LIMIT $1
    `,
    [topN],
  );

  return {
    table_exists: true,
    totals,
    by_merchant: byMerchant,
    by_status: byStatus,
    live_by_merchant: liveByMerchant,
  };
}

async function auditProductIntel() {
  if (!(await tableExists('aurora_product_intel_kb'))) {
    return { table_exists: false };
  }

  const totals = normalizeCountRow(
    await one(`
      SELECT
        COUNT(*)::int AS total_rows,
        COUNT(*) FILTER (WHERE kb_key LIKE 'product:%')::int AS product_kb_rows,
        COUNT(*) FILTER (WHERE last_success_at IS NOT NULL)::int AS rows_with_last_success
      FROM aurora_product_intel_kb
    `),
  );

  return {
    table_exists: true,
    totals,
  };
}

async function auditImageAssets() {
  if (!(await tableExists('external_seed_image_assets'))) {
    return { table_exists: false };
  }

  const totals = normalizeCountRow(
    await one(`
      SELECT
        COUNT(*)::int AS total_rows,
        COUNT(DISTINCT external_product_id)::int AS distinct_external_product_ids,
        COUNT(*) FILTER (WHERE status = 'cached')::int AS cached_rows,
        COUNT(*) FILTER (WHERE cached_url IS NOT NULL AND cached_url <> '')::int AS rows_with_cached_url
      FROM external_seed_image_assets
    `),
  );

  return {
    table_exists: true,
    totals,
  };
}

function firstNumber(obj, key) {
  const value = obj?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function buildDerivedCounts(report) {
  const external = report.external_product_seeds?.totals || {};
  const cache = report.products_cache?.totals || {};
  const identity = report.pdp_identity_listing?.totals || {};

  return {
    recommended_counting_guidance: {
      external_seed_catalog_pdp_rows:
        firstNumber(external, 'active_standalone_pdp_rows') ??
        firstNumber(external, 'active_rows') ??
        null,
      external_seed_active_listing_rows: firstNumber(external, 'active_rows'),
      merchant_cache_raw_rows: firstNumber(cache, 'total_rows'),
      merchant_cache_unexpired_rows: firstNumber(cache, 'unexpired_rows'),
      identity_dedup_sellable_groups: firstNumber(identity, 'distinct_sellable_item_groups'),
      identity_product_lines: firstNumber(identity, 'distinct_product_lines'),
    },
    notes: [
      'external_seed_catalog_pdp_rows is the best standalone external PDP count; attached rows are excluded to avoid double counting rows linked to internal products.',
      'merchant_cache_raw_rows is not deduplicated and may include expired/unavailable merchant cache rows.',
      'identity_dedup_sellable_groups is the best current dedup/product-group count where identity graph coverage exists; it is not yet a full-catalog total if identity coverage is incomplete.',
    ],
  };
}

function topRows(rows, labelKey, countKey = 'rows', limit = 10) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, limit)
    .map((row) => `| ${String(row[labelKey] ?? 'unknown').replace(/\|/g, '\\|')} | ${row[countKey]} |`)
    .join('\n');
}

function buildMarkdown(report) {
  const external = report.external_product_seeds?.totals || {};
  const cache = report.products_cache?.totals || {};
  const identity = report.pdp_identity_listing?.totals || {};
  const intel = report.aurora_product_intel_kb?.totals || {};
  const image = report.external_seed_image_assets?.totals || {};
  const guidance = report.derived?.recommended_counting_guidance || {};

  return `# Production Catalog Counts

Generated at: ${report.generated_at}

## Headline Counts

| Scope | Count |
| --- | ---: |
| External seed active standalone PDP rows | ${guidance.external_seed_catalog_pdp_rows ?? 'n/a'} |
| External seed active listing rows | ${guidance.external_seed_active_listing_rows ?? 'n/a'} |
| Products cache raw rows | ${guidance.merchant_cache_raw_rows ?? 'n/a'} |
| Products cache unexpired rows | ${guidance.merchant_cache_unexpired_rows ?? 'n/a'} |
| Identity dedup sellable groups | ${guidance.identity_dedup_sellable_groups ?? 'n/a'} |
| Identity product lines | ${guidance.identity_product_lines ?? 'n/a'} |

## External Product Seeds

| Metric | Count |
| --- | ---: |
| Total rows | ${external.total_rows ?? 'n/a'} |
| Active rows | ${external.active_rows ?? 'n/a'} |
| Active standalone PDP rows | ${external.active_standalone_pdp_rows ?? 'n/a'} |
| Active attached rows | ${external.active_attached_rows ?? 'n/a'} |
| Distinct active external_product_id | ${external.distinct_active_external_product_ids ?? 'n/a'} |
| Distinct domains | ${external.distinct_domains ?? 'n/a'} |
| Distinct markets | ${external.distinct_markets ?? 'n/a'} |

### Active By Market

| Market | Rows |
| --- | ---: |
${topRows(report.external_product_seeds?.active_by_market, 'market')}

### Active Top Brands

| Brand | Rows |
| --- | ---: |
${topRows(report.external_product_seeds?.active_by_brand, 'brand')}

## Products Cache

| Metric | Count |
| --- | ---: |
| Total rows | ${cache.total_rows ?? 'n/a'} |
| Unexpired rows | ${cache.unexpired_rows ?? 'n/a'} |
| Expired rows | ${cache.expired_rows ?? 'n/a'} |
| Distinct merchants | ${cache.distinct_merchants ?? 'n/a'} |
| Active-like rows | ${cache.active_like_rows ?? 'n/a'} |
| Orderable-like rows | ${cache.orderable_like_rows ?? 'n/a'} |

## Identity Graph

| Metric | Count |
| --- | ---: |
| Listing rows | ${identity.total_listing_rows ?? 'n/a'} |
| Live-read rows | ${identity.live_read_enabled_rows ?? 'n/a'} |
| Distinct sellable item groups | ${identity.distinct_sellable_item_groups ?? 'n/a'} |
| Distinct product lines | ${identity.distinct_product_lines ?? 'n/a'} |
| External seed listing rows | ${identity.external_seed_listing_rows ?? 'n/a'} |
| Non-external listing rows | ${identity.non_external_seed_listing_rows ?? 'n/a'} |

## Supporting Assets

| Scope | Count |
| --- | ---: |
| Product intel KB rows | ${intel.product_kb_rows ?? 'n/a'} |
| Image asset rows | ${image.total_rows ?? 'n/a'} |
| Image asset distinct external products | ${image.distinct_external_product_ids ?? 'n/a'} |
`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const report = {
    generated_at: new Date().toISOString(),
    scope: 'production_catalog_counts',
    read_only: true,
    external_product_seeds: await safeSection('external_product_seeds', () => auditExternalSeeds(args.topN)),
    products_cache: await safeSection('products_cache', () => auditProductsCache(args.topN)),
    pdp_identity_listing: await safeSection('pdp_identity_listing', () => auditIdentityGraph(args.topN)),
    aurora_product_intel_kb: await safeSection('aurora_product_intel_kb', auditProductIntel),
    external_seed_image_assets: await safeSection('external_seed_image_assets', auditImageAssets),
  };
  report.derived = buildDerivedCounts(report);

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${json}\n`);
  }
  if (args.markdownOut) {
    fs.mkdirSync(path.dirname(args.markdownOut), { recursive: true });
    fs.writeFileSync(args.markdownOut, buildMarkdown(report));
  }
  process.stdout.write(`${json}\n`);
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
