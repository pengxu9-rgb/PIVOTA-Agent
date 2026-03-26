#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const request = require('supertest');

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseArgs(argv) {
  const args = {
    target: process.env.SEARCH_RUNTIME_TARGET || 'http',
    baseUrl: process.env.SEARCH_RUNTIME_BASE_URL || 'https://agent.pivota.cc',
    endpoint: process.env.SEARCH_RUNTIME_ENDPOINT || '/api/gateway',
    outDir: process.env.SEARCH_RUNTIME_OUT_DIR || 'reports/search-runtime-validation',
    timeoutMs: Number(process.env.SEARCH_RUNTIME_TIMEOUT_MS || 15000),
    casesFile: process.env.SEARCH_RUNTIME_CASES_FILE || '',
    upstreamBase:
      process.env.SEARCH_RUNTIME_PIVOTA_API_BASE ||
      process.env.PIVOTA_API_BASE ||
      'https://web-production-fedb.up.railway.app',
    endpointExplicit: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--target' && next) args.target = String(next);
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) {
      args.endpoint = String(next);
      args.endpointExplicit = true;
    }
    if (token === '--out-dir' && next) args.outDir = String(next);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(500, Number(next) || 15000);
    if (token === '--cases-file' && next) args.casesFile = String(next);
    if (token === '--upstream-base' && next) args.upstreamBase = String(next);
  }

  if (String(args.target || '').trim().toLowerCase() === 'app' && !args.endpointExplicit) {
    args.endpoint = '/agent/shop/v1/invoke';
  }
  return args;
}

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultCases() {
  return [
    {
      id: 'fp_exact_ipsa',
      label: 'find_products exact lookup',
      operation: 'find_products',
      payload: {
        search: {
          query: 'IPSA Time Reset Aqua',
        },
      },
      expect: {
        mode: 'strict',
        minProducts: 1,
        anchors: ['ipsa', 'time reset aqua'],
      },
    },
    {
      id: 'fp_generic_brush',
      label: 'find_products generic brush lookup',
      operation: 'find_products',
      payload: {
        search: {
          query: 'foundation brush',
        },
      },
      expect: {
        mode: 'strict',
        minProducts: 1,
        anchors: ['brush'],
      },
    },
    {
      id: 'fpm_exact_ipsa_eligible_only',
      label: 'find_products_multi exact lookup eligible-only',
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'IPSA Time Reset Aqua',
          limit: 10,
          in_stock_only: true,
          commerce_surface: 'agent_api',
        },
      },
      metadata: {
        source: 'shopping_agent',
      },
      expect: {
        mode: 'strict',
        minProducts: 1,
        anchors: ['ipsa', 'time reset aqua'],
        requireEligibleOnly: true,
        requireOfferSummary: true,
      },
    },
    {
      id: 'fpm_brand_winona',
      label: 'find_products_multi brand lookup',
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'Winona products',
          limit: 10,
          commerce_surface: 'agent_api',
        },
      },
      metadata: {
        source: 'shopping_agent',
      },
      expect: {
        mode: 'strict',
        minProducts: 1,
        anchors: ['winona'],
        requireEligibleOnly: true,
        requireOfferSummary: true,
      },
    },
    {
      id: 'fpm_tool_brush',
      label: 'find_products_multi tool-first brush query',
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'foundation brush recommendation',
          limit: 10,
          commerce_surface: 'agent_api',
        },
      },
      metadata: {
        source: 'shopping_agent',
      },
      expect: {
        mode: 'strict',
        minProducts: 1,
        anchors: ['brush'],
        requireEligibleOnly: true,
      },
    },
    {
      id: 'fpm_scenario_date_makeup',
      label: 'find_products_multi scenario query',
      operation: 'find_products_multi',
      payload: {
        search: {
          query: '我今晚有个约会，要化妆，要推荐点商品吧？',
          limit: 10,
          commerce_surface: 'agent_api',
        },
      },
      metadata: {
        source: 'shopping_agent',
      },
      expect: {
        mode: 'observe',
        minProducts: 0,
      },
    },
  ];
}

function loadCases(casesFile) {
  if (!casesFile) return defaultCases();
  const fullPath = path.resolve(casesFile);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function buildTitleText(products) {
  return (Array.isArray(products) ? products : [])
    .slice(0, 5)
    .map((product) =>
      [
        product?.title,
        product?.name,
        product?.brand,
        product?.vendor,
      ]
        .filter(Boolean)
        .join(' '),
    )
    .join(' ');
}

function collectTopProducts(products) {
  return (Array.isArray(products) ? products : []).slice(0, 3).map((product) => ({
    title: product?.title || product?.name || null,
    brand: product?.brand || product?.vendor || null,
    merchant_id: product?.merchant_id || null,
    product_id: product?.product_id || product?.id || null,
    commerce_surface: product?.commerce_surface || null,
    purchase_route: product?.top_offer_summary?.purchase_route || null,
    has_top_offer_summary: Boolean(product?.top_offer_summary),
    has_exact_resolution_identifiers: Boolean(product?.exact_resolution_identifiers),
  }));
}

function evaluateCase(testCase, responseData) {
  const products = Array.isArray(responseData?.products) ? responseData.products : [];
  const metadata =
    responseData && typeof responseData.metadata === 'object' && !Array.isArray(responseData.metadata)
      ? responseData.metadata
      : {};
  const clarification = responseData?.clarification || null;
  const expectConfig =
    testCase && typeof testCase.expect === 'object' && !Array.isArray(testCase.expect)
      ? testCase.expect
      : {};
  const titleText = normalizeText(buildTitleText(products));
  const anchors = Array.isArray(expectConfig.anchors) ? expectConfig.anchors : [];
  const anchorHits = anchors.filter((anchor) => titleText.includes(normalizeText(anchor)));
  const eligibleOnlyOk = !expectConfig.requireEligibleOnly || metadata.serving_mode === 'eligible_only';
  const offerSummaryOk =
    !expectConfig.requireOfferSummary ||
    products.slice(0, Math.max(1, Math.min(products.length, 3))).every((product) =>
      Boolean(product?.top_offer_summary) && Boolean(product?.exact_resolution_identifiers),
    );
  const minProductsOk = products.length >= Number(expectConfig.minProducts || 0);
  const relevanceOk = !anchors.length || anchorHits.length >= 1;
  const observeOnly = expectConfig.mode === 'observe';

  return {
    observe_only: observeOnly,
    min_products_ok: minProductsOk,
    relevance_ok: relevanceOk,
    eligible_only_ok: eligibleOnlyOk,
    offer_summary_ok: offerSummaryOk,
    clarification_triggered: Boolean(clarification),
    anchor_hits: anchorHits,
    product_count: products.length,
    overall_ok: observeOnly
      ? true
      : minProductsOk && relevanceOk && eligibleOnlyOk && offerSummaryOk,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = loadCases(args.casesFile);
  const target = String(args.target || 'http').trim().toLowerCase() === 'app' ? 'app' : 'http';
  const baseUrl = String(args.baseUrl || '').replace(/\/+$/, '');
  const endpoint = String(args.endpoint || '').startsWith('/')
    ? String(args.endpoint || '')
    : `/${String(args.endpoint || '')}`;
  const url = `${baseUrl}${endpoint}`;
  const runTs = timestamp();
  const rows = [];
  let app = null;

  if (target === 'app') {
    process.env.NODE_ENV = 'test';
    process.env.API_MODE = 'REAL';
    process.env.PIVOTA_API_BASE = String(args.upstreamBase || '').replace(/\/+$/, '');
    delete process.env.AGENT_AUTH_INTROSPECT_URL;
    delete process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY;
    const serverPath = path.resolve(__dirname, '../src/server');
    delete require.cache[serverPath];
    app = require(serverPath);
  }

  for (const testCase of cases) {
    const started = Date.now();
    try {
      const requestBody = {
        operation: testCase.operation,
        payload: testCase.payload,
        metadata: testCase.metadata,
      };
      const resp =
        target === 'app'
          ? await request(app)
              .post(endpoint)
              .set('Content-Type', 'application/json')
              .timeout({ response: args.timeoutMs, deadline: args.timeoutMs + 1000 })
              .send(requestBody)
          : await axios.post(
              url,
              requestBody,
              {
                timeout: args.timeoutMs,
                validateStatus: () => true,
                headers: {
                  'Content-Type': 'application/json',
                },
              },
            );

      const evaluation = evaluateCase(testCase, resp.data);
      rows.push({
        id: testCase.id,
        label: testCase.label,
        operation: testCase.operation,
        query:
          testCase?.payload?.search?.query ||
          testCase?.payload?.query ||
          '',
        status: Number(resp.status || 0) || 0,
        ok: resp.status >= 200 && resp.status < 300,
        latency_ms: Math.max(0, Date.now() - started),
        evaluation,
        response: {
          total: Number(resp.data?.total || 0) || 0,
          page_size: Number(resp.data?.page_size || 0) || 0,
          metadata: {
            query_source: resp.data?.metadata?.query_source || null,
            serving_mode: resp.data?.metadata?.serving_mode || null,
            commerce_surface: resp.data?.metadata?.commerce_surface || null,
            strict_empty: Boolean(resp.data?.metadata?.strict_empty),
            final_decision: resp.data?.metadata?.search_trace?.final_decision || null,
          },
          clarification: resp.data?.clarification
            ? {
                reason: resp.data?.clarification?.reason || null,
                question: resp.data?.clarification?.question || null,
                options_count: Array.isArray(resp.data?.clarification?.options)
                  ? resp.data.clarification.options.length
                  : 0,
              }
            : null,
          top_products: collectTopProducts(resp.data?.products),
        },
      });
    } catch (err) {
      rows.push({
        id: testCase.id,
        label: testCase.label,
        operation: testCase.operation,
        query:
          testCase?.payload?.search?.query ||
          testCase?.payload?.query ||
          '',
        status: 0,
        ok: false,
        latency_ms: Math.max(0, Date.now() - started),
        evaluation: {
          observe_only: false,
          min_products_ok: false,
          relevance_ok: false,
          eligible_only_ok: false,
          offer_summary_ok: false,
          clarification_triggered: false,
          anchor_hits: [],
          product_count: 0,
          overall_ok: false,
        },
        error: String(err?.message || err),
      });
    }
  }

  const strictRows = rows.filter((row) => !row.evaluation.observe_only);
  const strictPassCount = strictRows.filter((row) => row.evaluation.overall_ok).length;
  const strictFailCount = strictRows.length - strictPassCount;
  const summary = {
    generated_at: new Date().toISOString(),
    target,
    base_url: baseUrl,
    endpoint,
    upstream_base: target === 'app' ? String(args.upstreamBase || '').replace(/\/+$/, '') : null,
    total_cases: rows.length,
    strict_cases: strictRows.length,
    strict_pass_count: strictPassCount,
    strict_fail_count: strictFailCount,
    all_strict_green: strictFailCount === 0,
  };

  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `commerce_search_runtime_probe_${runTs}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const mdPath = path.join(outDir, `${baseName}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({ summary, rows }, null, 2), 'utf8');

  const md = [
    '# Commerce Search Runtime Probe',
    '',
    `- generated_at: ${summary.generated_at}`,
    `- base_url: ${summary.base_url}`,
    `- endpoint: ${summary.endpoint}`,
    `- total_cases: ${summary.total_cases}`,
    `- strict_cases: ${summary.strict_cases}`,
    `- strict_pass_count: ${summary.strict_pass_count}`,
    `- strict_fail_count: ${summary.strict_fail_count}`,
    `- all_strict_green: ${summary.all_strict_green}`,
    '',
    '| id | operation | status | latency_ms | products | overall_ok | query_source | serving_mode | top1 |',
    '|---|---|---:|---:|---:|---|---|---|---|',
    ...rows.map((row) => {
      const top1 = row?.response?.top_products?.[0]?.title || '';
      const querySource = row?.response?.metadata?.query_source || '';
      const servingMode = row?.response?.metadata?.serving_mode || '';
      return `| ${row.id} | ${row.operation} | ${row.status} | ${row.latency_ms} | ${row.evaluation.product_count} | ${row.evaluation.overall_ok} | ${querySource} | ${servingMode} | ${String(top1).replace(/\|/g, '\\|')} |`;
    }),
    '',
    '## Case Details',
    '',
    ...rows.flatMap((row) => {
      const lines = [
        `### ${row.id}`,
        '',
        `- label: ${row.label}`,
        `- operation: ${row.operation}`,
        `- query: ${row.query}`,
        `- status: ${row.status}`,
        `- latency_ms: ${row.latency_ms}`,
        `- overall_ok: ${row.evaluation.overall_ok}`,
        `- anchor_hits: ${row.evaluation.anchor_hits.join(', ') || '(none)'}`,
        `- clarification_triggered: ${row.evaluation.clarification_triggered}`,
      ];
      if (row.error) lines.push(`- error: ${row.error}`);
      if (row.response) {
        lines.push(
          `- query_source: ${row.response.metadata.query_source || '(none)'}`,
          `- serving_mode: ${row.response.metadata.serving_mode || '(none)'}`,
          `- commerce_surface: ${row.response.metadata.commerce_surface || '(none)'}`,
          `- top_products: ${
            row.response.top_products.map((item) => item.title || '(untitled)').join(' | ') || '(none)'
          }`,
        );
      }
      lines.push('');
      return lines;
    }),
    `JSON: ${path.relative(process.cwd(), jsonPath)}`,
  ].join('\n');

  fs.writeFileSync(mdPath, md, 'utf8');

  console.log(JSON.stringify({ ok: true, summary, json: jsonPath, markdown: mdPath }, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
