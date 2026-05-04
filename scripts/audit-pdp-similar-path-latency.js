#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_GATEWAY_URL = 'https://agent.pivota.cc/api/gateway';
const DEFAULT_BRANDS = ['skin1004', 'tirtir', 'medicube'];
const FULL_INCLUDE = [
  'offers',
  'variant_selector',
  'product_intel',
  'active_ingredients',
  'ingredients_inci',
  'how_to_use',
  'product_overview',
  'supplemental_details',
  'reviews_preview',
  'similar',
];

function parseArgs(argv) {
  const args = {
    gatewayUrl: process.env.PDP_AUDIT_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    out: '',
    limit: 20,
    market: process.env.PDP_AUDIT_MARKET || 'US',
    products: [],
    brands: DEFAULT_BRANDS,
    timeoutMs: 15000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--gateway-url' && next) {
      args.gatewayUrl = next;
      i += 1;
    } else if (token === '--out' && next) {
      args.out = next;
      i += 1;
    } else if (token === '--limit' && next) {
      args.limit = Math.max(1, Math.min(200, Number(next) || args.limit));
      i += 1;
    } else if (token === '--market' && next) {
      args.market = String(next || '').trim().toUpperCase() || args.market;
      i += 1;
    } else if ((token === '--product' || token === '--product-id') && next) {
      args.products.push(next);
      i += 1;
    } else if (token === '--products' && next) {
      args.products.push(
        ...String(next)
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      );
      i += 1;
    } else if (token === '--products-file' && next) {
      const text = fs.readFileSync(next, 'utf8');
      args.products.push(
        ...text
          .split(/\r?\n/)
          .flatMap((line) => line.split(','))
          .map((value) => value.trim())
          .filter((value) => value && value.startsWith('ext_')),
      );
      i += 1;
    } else if (token === '--brands' && next) {
      args.brands = String(next)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (token === '--timeout-ms' && next) {
      args.timeoutMs = Math.max(1000, Number(next) || args.timeoutMs);
      i += 1;
    }
  }
  args.products = Array.from(new Set(args.products));
  return args;
}

function percentile(values, pct) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function readSimilarModule(body) {
  const modules = Array.isArray(body?.modules) ? body.modules : [];
  return modules.find((module) => module?.type === 'similar' || module?.type === 'recommendations') || null;
}

function summarizeResponse(label, productId, status, elapsedMs, body) {
  const routeHealth = body?.metadata?.route_health || body?.route_health || {};
  const similarModule = readSimilarModule(body);
  const similarMetadata = similarModule?.metadata || similarModule?.data?.metadata || {};
  const items = Array.isArray(similarModule?.data?.items) ? similarModule.data.items : [];
  return {
    label,
    product_id: productId,
    http_status: status,
    elapsed_ms: elapsedMs,
    total_latency_ms: routeHealth.total_latency_ms ?? null,
    precheck_entry_product_ms: routeHealth.phases?.precheck_entry_product ?? null,
    resolve_group_cached_ms: routeHealth.phases?.resolve_group_cached ?? null,
    similar_ms: routeHealth.modules?.similar ?? null,
    card_enrichment_ms: routeHealth.modules?.similar_card_enrichment ?? null,
    similar_status: body?.metadata?.similar_status || similarMetadata.similar_status || null,
    visible_count: items.length,
    underfill: similarMetadata.underfill ?? null,
    fallback_policy: similarMetadata.fallback_policy || body?.metadata?.fallback_policy || null,
    low_confidence_reason_codes: similarMetadata.low_confidence_reason_codes || [],
    route_health: routeHealth,
  };
}

async function invokeGateway({ gatewayUrl, productId, include, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'get_pdp_v2',
        payload: {
          product_ref: {
            merchant_id: 'external_seed',
            product_id: productId,
          },
          include,
          options: { debug: true },
        },
      }),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - startedAt;
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { parse_error: true, body_preview: text.slice(0, 500) };
    }
    return { status: response.status, elapsedMs, body };
  } catch (err) {
    return {
      status: 0,
      elapsedMs: Date.now() - startedAt,
      body: {
        error: err?.name === 'AbortError' ? 'TIMEOUT' : err?.message || String(err),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loadProductIdsFromDb({ brands, market, limit }) {
  if (!process.env.DATABASE_URL) return [];
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      `
        SELECT external_product_id
        FROM external_product_seeds
        WHERE status = 'active'
          AND market = $1
          AND attached_product_key IS NULL
          AND lower(coalesce(
            seed_data->>'brand',
            seed_data->>'brand_name',
            seed_data->>'vendor',
            seed_data->'snapshot'->>'brand',
            seed_data->'snapshot'->>'vendor',
            ''
          )) = ANY($2)
          AND coalesce(external_product_id, '') <> ''
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT $3
      `,
      [market, brands, limit],
    );
    return result.rows.map((row) => row.external_product_id).filter(Boolean);
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const productIds = args.products.length
    ? args.products.slice(0, args.limit)
    : await loadProductIdsFromDb(args);
  if (!productIds.length) {
    throw new Error('No product ids provided. Pass --products/--products-file or set DATABASE_URL for DB sampling.');
  }

  const cases = [
    ['full', FULL_INCLUDE],
    ['no_similar', FULL_INCLUDE.filter((item) => item !== 'similar')],
    ['similar_only', ['similar']],
    ['core_only', []],
  ];
  const results = [];
  for (const productId of productIds.slice(0, args.limit)) {
    for (const [label, include] of cases) {
      const response = await invokeGateway({
        gatewayUrl: args.gatewayUrl,
        productId,
        include,
        timeoutMs: args.timeoutMs,
      });
      results.push(summarizeResponse(label, productId, response.status, response.elapsedMs, response.body));
    }
  }

  const byLabel = {};
  for (const label of cases.map(([value]) => value)) {
    const rows = results.filter((row) => row.label === label);
    byLabel[label] = {
      count: rows.length,
      elapsed_p50_ms: percentile(rows.map((row) => row.elapsed_ms), 50),
      elapsed_p95_ms: percentile(rows.map((row) => row.elapsed_ms), 95),
      precheck_p95_ms: percentile(rows.map((row) => row.precheck_entry_product_ms), 95),
      group_resolve_p95_ms: percentile(rows.map((row) => row.resolve_group_cached_ms), 95),
      similar_p95_ms: percentile(rows.map((row) => row.similar_ms), 95),
      card_enrichment_p95_ms: percentile(rows.map((row) => row.card_enrichment_ms), 95),
      timeout_count: rows.filter((row) => row.http_status === 0).length,
    };
  }

  const report = {
    generated_at: new Date().toISOString(),
    gateway_url: args.gatewayUrl,
    product_count: productIds.length,
    products: productIds,
    summary: byLabel,
    rows: results,
  };

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
