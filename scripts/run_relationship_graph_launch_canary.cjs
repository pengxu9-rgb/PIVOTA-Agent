#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_TIMEOUT_MS = 60000;

const DEFAULT_CASES = [
  {
    name: 'naturium_multi_peptide_rich_cream',
    product: {
      merchant_id: 'external_seed',
      product_id: 'ulta:626db4449ae27a79',
      external_product_id: 'ulta:626db4449ae27a79',
      source_product_id: 'ulta:626db4449ae27a79',
      title: 'Multi-Peptide Rich Cream',
      brand: 'Naturium',
      category: 'Skincare',
      product_type: 'Moisturizer',
    },
    expect: {
      graph_edges_min: 1,
      pdp_served_min: 1,
      discovery_selected_min: 1,
    },
  },
];

function parseArgs(argv = []) {
  const args = {
    baseUrl: process.env.RELGRAPH_CANARY_BASE_URL || process.env.BASE_URL || DEFAULT_BASE_URL,
    caseFile: process.env.RELGRAPH_CANARY_CASE_FILE || '',
    outFile: process.env.RELGRAPH_CANARY_OUT || '',
    timeoutMs: Number(process.env.RELGRAPH_CANARY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    limit: Number(process.env.RELGRAPH_CANARY_LIMIT || 6) || 6,
    discoveryLimit: Number(process.env.RELGRAPH_CANARY_DISCOVERY_LIMIT || 8) || 8,
    metrics: process.env.RELGRAPH_CANARY_SKIP_METRICS !== 'true',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--base-url') args.baseUrl = next();
    else if (arg === '--case-file') args.caseFile = next();
    else if (arg === '--out') args.outFile = next();
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next()) || args.timeoutMs;
    else if (arg === '--limit') args.limit = Number(next()) || args.limit;
    else if (arg === '--discovery-limit') args.discoveryLimit = Number(next()) || args.discoveryLimit;
    else if (arg === '--skip-metrics') args.metrics = false;
    else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.baseUrl = String(args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  args.timeoutMs = Math.max(1000, Math.min(180000, Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS));
  args.limit = Math.max(1, Math.min(30, Number(args.limit) || 6));
  args.discoveryLimit = Math.max(1, Math.min(30, Number(args.discoveryLimit) || 8));
  return args;
}

function printHelp() {
  console.log(`
Usage:
  AGENT_API_KEY=... node scripts/run_relationship_graph_launch_canary.cjs [options]

Options:
  --base-url <url>          Gateway base URL. Default: ${DEFAULT_BASE_URL}
  --case-file <json>        JSON array or {"cases":[...]} canary matrix.
  --out <json>              Write full result artifact.
  --timeout-ms <ms>         Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --limit <n>               PDP/direct similar display limit. Default: 6
  --discovery-limit <n>     Discovery feed limit. Default: 8
  --skip-metrics            Skip /metrics validation.

Case shape:
  {
    "name": "merchant_anchor_name",
    "product": {
      "merchant_id": "external_seed",
      "product_id": "ulta:...",
      "external_product_id": "ulta:...",
      "title": "...",
      "brand": "...",
      "category": "..."
    },
    "expect": {
      "graph_edges_min": 1,
      "pdp_served_min": 1,
      "discovery_selected_min": 1
    }
  }
`.trim());
}

function pickApiKey() {
  return (
    process.env.AGENT_API_KEY ||
    process.env.SHOP_GATEWAY_AGENT_API_KEY ||
    process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
    process.env.PIVOTA_AGENT_API_KEY ||
    process.env.COMMERCE_CORE_PROD_AGENT_API_KEY ||
    ''
  ).trim();
}

function loadCases(caseFile) {
  if (!caseFile) return DEFAULT_CASES;
  const filePath = path.resolve(caseFile);
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cases = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cases) ? parsed.cases : [];
  if (!cases.length) throw new Error(`No cases found in ${filePath}`);
  return cases;
}

function normalizeCase(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const product = source.product && typeof source.product === 'object' ? source.product : source;
  const productId = String(product.product_id || product.productId || product.id || '').trim();
  if (!productId) throw new Error(`case[${index}] is missing product.product_id`);
  const name = String(source.name || product.title || productId || `case_${index + 1}`)
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();
  return {
    name,
    product: {
      merchant_id: String(product.merchant_id || product.merchantId || 'external_seed').trim(),
      product_id: productId,
      external_product_id: String(product.external_product_id || product.externalProductId || '').trim() || productId,
      source_product_id: String(product.source_product_id || product.sourceProductId || '').trim() || productId,
      title: String(product.title || product.name || '').trim(),
      brand: String(product.brand || product.vendor || '').trim(),
      category: String(product.category || '').trim(),
      product_type: String(product.product_type || product.productType || '').trim(),
    },
    expect: {
      graph_edges_min: Number(source.expect?.graph_edges_min ?? source.graph_edges_min ?? 0) || 0,
      pdp_served_min: Number(source.expect?.pdp_served_min ?? source.pdp_served_min ?? 0) || 0,
      discovery_selected_min:
        Number(source.expect?.discovery_selected_min ?? source.discovery_selected_min ?? 0) || 0,
    },
  };
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 1000) };
    }
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function invoke({ baseUrl, apiKey, operation, payload, timeoutMs }) {
  const { response, data } = await fetchJson(
    `${baseUrl}/agent/shop/v1/invoke`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Agent-API-Key': apiKey,
      },
      body: JSON.stringify({ operation, payload }),
    },
    timeoutMs,
  );
  return {
    http_status: response.status,
    ok: response.ok,
    data,
  };
}

function toCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function isRelationshipGraphProduct(product = {}) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false;
  const source = String(product.source || product.recommendation_source || product.recommendationSource || '')
    .trim()
    .toLowerCase();
  return source === 'relationship_graph' || Boolean(product.relationship_edge_id || product.relationshipEdgeId);
}

function summarizeProducts(products = []) {
  return (Array.isArray(products) ? products : []).slice(0, 8).map((product) => ({
    id: product.product_id || product.id || null,
    title: product.title || product.name || null,
    brand: product.brand || null,
    source: product.source || null,
    relation_type: product.relation_type || product.relationship_type || null,
  }));
}

function graphMetadataFromSimilarModule(module) {
  const metadata = module?.data?.metadata || module?.metadata || {};
  return {
    enabled: metadata.relationship_graph_enabled === true,
    edge_count: toCount(metadata.relationship_graph_edge_count),
    curated_count: toCount(metadata.relationship_graph_curated_count),
    raw_served_count: toCount(metadata.relationship_graph_raw_served_count),
    served_count: toCount(metadata.relationship_graph_served_count),
    filtered_count: toCount(metadata.relationship_graph_filtered_count),
  };
}

async function runPdpCase({ baseUrl, apiKey, testCase, limit, timeoutMs }) {
  const result = await invoke({
    baseUrl,
    apiKey,
    operation: 'get_pdp_v2',
    timeoutMs,
    payload: {
      product: {
        product_id: testCase.product.product_id,
        ...(testCase.product.merchant_id ? { merchant_id: testCase.product.merchant_id } : {}),
      },
      include: ['similar'],
      similar: {
        limit,
        mode: 'background',
        options: { no_cache: true, debug: true },
      },
      options: { no_cache: true, similar_no_cache: true, similar_mode: 'background', debug: true },
    },
  });
  const similarModule = Array.isArray(result.data?.modules)
    ? result.data.modules.find((module) => module?.type === 'similar')
    : null;
  const items = similarModule?.data?.items || similarModule?.items || [];
  return {
    surface: 'pdp_similar',
    http_status: result.http_status,
    ok: result.ok,
    status: similarModule?.data?.status || similarModule?.status || null,
    product_count: Array.isArray(items) ? items.length : 0,
    relationship_graph: graphMetadataFromSimilarModule(similarModule),
    products: summarizeProducts(items),
  };
}

async function runDirectSimilarCase({ baseUrl, apiKey, testCase, limit, timeoutMs }) {
  const result = await invoke({
    baseUrl,
    apiKey,
    operation: 'find_similar_products',
    timeoutMs,
    payload: {
      similar: {
        product_id: testCase.product.product_id,
        ...(testCase.product.merchant_id ? { merchant_id: testCase.product.merchant_id } : {}),
        limit,
        options: { no_cache: true, debug: true },
      },
    },
  });
  const products = result.data?.products || result.data?.data?.products || [];
  const metadata = result.data?.metadata || result.data?.data?.metadata || {};
  const graphProductCount = (Array.isArray(products) ? products : []).filter(isRelationshipGraphProduct).length;
  return {
    surface: 'find_similar_products',
    http_status: result.http_status,
    ok: result.ok,
    status: result.data?.status || null,
    product_count: Array.isArray(products) ? products.length : 0,
    graph_product_count: graphProductCount,
    relationship_graph: {
      enabled: metadata.relationship_graph_enabled === true,
      edge_count: toCount(metadata.relationship_graph_edge_count),
      curated_count: toCount(metadata.relationship_graph_curated_count),
      raw_served_count: toCount(metadata.relationship_graph_raw_served_count),
      served_count: toCount(metadata.relationship_graph_served_count),
      filtered_count: toCount(metadata.relationship_graph_filtered_count),
    },
    products: summarizeProducts(products),
  };
}

async function runDiscoveryCase({ baseUrl, apiKey, testCase, discoveryLimit, timeoutMs }) {
  const result = await invoke({
    baseUrl,
    apiKey,
    operation: 'get_discovery_feed',
    timeoutMs,
    payload: {
      surface: 'home_hot_deals',
      page: 1,
      limit: discoveryLimit,
      debug: true,
      context: {
        auth_state: 'authenticated',
        locale: 'en-US',
        recent_views: [
          {
            ...testCase.product,
            viewed_at: new Date().toISOString(),
          },
        ],
        recent_queries: [
          [testCase.product.brand, testCase.product.category || testCase.product.product_type]
            .filter(Boolean)
            .join(' ')
            .trim() || 'beauty product',
        ],
      },
    },
  });
  const products = result.data?.products || result.data?.data?.products || [];
  const metadata = result.data?.metadata || result.data?.data?.metadata || {};
  return {
    surface: 'discovery_feed',
    http_status: result.http_status,
    ok: result.ok,
    product_count: Array.isArray(products) ? products.length : 0,
    relationship_graph: metadata.relationship_graph || null,
    candidate_source: metadata.candidate_source || null,
    selected_graph_count: (Array.isArray(products) ? products : []).filter(isRelationshipGraphProduct).length,
    recall_summary: Array.isArray(metadata.rank_debug?.recall_summary)
      ? metadata.rank_debug.recall_summary.filter((row) => row.provider === 'relationship_graph')
      : [],
    products: summarizeProducts(products),
  };
}

async function runMetricsCheck({ baseUrl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text = '';
  try {
    response = await fetch(`${baseUrl}/metrics`, { method: 'GET', signal: controller.signal });
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
  return {
    http_status: response.status,
    ok: response.ok,
    has_relationship_graph_recall_metric: text.includes('relationship_graph_recall_requests_total'),
    has_relationship_graph_post_filter_metric: text.includes('relationship_graph_post_filter_total'),
  };
}

function evaluateCase(testCase, result) {
  const failures = [];
  if (!result.pdp.ok) failures.push('pdp_http_failed');
  if (!result.discovery.ok) failures.push('discovery_http_failed');
  if (!result.direct.ok) failures.push('direct_http_failed');

  if (toCount(result.pdp.relationship_graph.edge_count) < testCase.expect.graph_edges_min) {
    failures.push('pdp_graph_edges_below_min');
  }
  if (toCount(result.pdp.relationship_graph.served_count) < testCase.expect.pdp_served_min) {
    failures.push('pdp_graph_served_below_min');
  }
  if (toCount(result.discovery.relationship_graph?.selected_count) < testCase.expect.discovery_selected_min) {
    failures.push('discovery_graph_selected_below_min');
  }

  const directServed = toCount(result.direct.relationship_graph.served_count);
  if (directServed > result.direct.product_count) {
    failures.push('direct_graph_served_exceeds_visible_products');
  }
  if (directServed !== result.direct.graph_product_count) {
    failures.push('direct_graph_served_mismatches_visible_graph_products');
  }

  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const apiKey = pickApiKey();
  if (!apiKey) {
    throw new Error('AGENT_API_KEY, SHOP_GATEWAY_AGENT_API_KEY, PIVOTA_BACKEND_AGENT_API_KEY, or PIVOTA_AGENT_API_KEY is required');
  }

  const cases = loadCases(args.caseFile).map(normalizeCase);
  const results = [];
  for (const testCase of cases) {
    const pdp = await runPdpCase({ ...args, apiKey, testCase });
    const discovery = await runDiscoveryCase({ ...args, apiKey, testCase });
    const direct = await runDirectSimilarCase({ ...args, apiKey, testCase });
    const failures = evaluateCase(testCase, { pdp, discovery, direct });
    results.push({
      name: testCase.name,
      product: testCase.product,
      expect: testCase.expect,
      pass: failures.length === 0,
      failures,
      pdp,
      discovery,
      direct,
    });
  }

  const metrics = args.metrics ? await runMetricsCheck(args) : null;
  const summary = {
    ok: results.every((result) => result.pass) &&
      (!metrics || (metrics.ok && metrics.has_relationship_graph_recall_metric && metrics.has_relationship_graph_post_filter_metric)),
    base_url: args.baseUrl,
    case_count: results.length,
    passed_count: results.filter((result) => result.pass).length,
    failed_count: results.filter((result) => !result.pass).length,
    metrics,
    results,
    generated_at: new Date().toISOString(),
  };

  if (args.outFile) {
    const outPath = path.resolve(args.outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2));
  process.exit(1);
});
