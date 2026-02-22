#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.SEARCH_MATRIX_BASE_URL || 'https://agent.pivota.cc',
    endpoint: process.env.SEARCH_MATRIX_ENDPOINT || '/api/gateway',
    rounds: Number(process.env.SEARCH_MATRIX_ROUNDS || 20),
    timeoutMs: Number(process.env.SEARCH_MATRIX_TIMEOUT_MS || 10000),
    outDir: process.env.SEARCH_MATRIX_OUT_DIR || 'reports',
    queryFile: process.env.SEARCH_MATRIX_QUERY_FILE || '',
    source: process.env.SEARCH_MATRIX_SOURCE || 'shopping_agent',
    evalMode:
      String(process.env.SEARCH_MATRIX_EVAL_MODE || '').trim().toLowerCase() === 'true',
    evalHeader: process.env.SEARCH_MATRIX_EVAL_HEADER || 'X-Eval',
    evalHeaderValue: process.env.SEARCH_MATRIX_EVAL_HEADER_VALUE || '1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--rounds' && next) args.rounds = Math.max(1, Number(next) || 1);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(500, Number(next) || 10000);
    if (token === '--out-dir' && next) args.outDir = String(next);
    if (token === '--query-file' && next) args.queryFile = String(next);
    if (token === '--source' && next) args.source = String(next);
    if (token === '--eval-mode') args.evalMode = true;
    if (token === '--eval-header' && next) args.evalHeader = String(next);
    if (token === '--eval-header-value' && next) args.evalHeaderValue = String(next);
  }
  return args;
}

function defaultQueries() {
  return [
    'ipsa',
    '薇诺娜',
    'Winona products',
    'IPSA Time Reset Aqua',
    '推荐化妆刷',
    '我今晚有个约会，要化妆，要推荐点商品吧？',
    'foundation brush recommendation',
    '有没有狗链推荐？',
    'dog leash recommendation',
    '宠物背带推荐',
    '随便推荐点商品',
    '有什么适合今晚约会的',
  ];
}

function loadQueries(queryFile) {
  if (!queryFile) return defaultQueries();
  const fullPath = path.resolve(queryFile);
  const text = fs.readFileSync(fullPath, 'utf8');
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines : defaultQueries();
}

function normalizeText(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAnchorTokens(query) {
  const normalized = normalizeText(query);
  const tokens = normalized.split(' ').filter(Boolean);
  const blacklist = new Set([
    '有',
    '有没有',
    '推荐',
    '商品',
    'products',
    'recommendation',
    'recommend',
    'please',
    'what',
    'with',
    'for',
    'the',
  ]);
  return tokens.filter((tok) => tok.length >= 2 && !blacklist.has(tok)).slice(0, 8);
}

function isRelevantResult(query, products) {
  if (!Array.isArray(products) || products.length === 0) return true;
  const anchors = buildAnchorTokens(query);
  if (!anchors.length) return true;
  const top = products.slice(0, 5);
  return top.some((item) => {
    const text = normalizeText(
      [
        item?.title,
        item?.name,
        item?.brand,
        item?.vendor,
        item?.description,
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (!text) return false;
    if (anchors.length === 1) return text.includes(anchors[0]);
    const overlap = anchors.filter((tok) => text.includes(tok)).length;
    return overlap >= 2;
  });
}

function inferQueryClassFromQuery(query) {
  const text = normalizeText(query);
  if (!text) return 'exploratory';
  if (/gift|礼物|送礼|送禮/.test(text)) return 'gift';
  if (/how to|guide|教程|攻略|退货|退貨/.test(text)) return 'non_shopping';
  if (/date|约会|約會|travel|出差|hiking|徒步|登山|scenario/.test(text)) return 'scenario';
  if (/budget|预算|price|under|above|以内|以上|防水|无香/.test(text)) return 'attribute';
  if (/ipsa|winona|tom ford|fenty|sku|model|型号|型號|\b[a-z]{1,6}\d{2,}\b/.test(text)) {
    return 'lookup';
  }
  if (/recommend|推荐|products|商品/.test(text)) return 'category';
  return 'exploratory';
}

function classifyRow(row) {
  const requestError = !row?.ok;
  const errorText = String(row?.error || '');
  const requestTimeout = /timeout|etimedout|econnaborted/i.test(errorText);
  if (requestError) {
    return {
      timeout: requestTimeout,
      strictEmpty: false,
      fallback: false,
      irrelevant: false,
      querySource: 'request_error',
      productCount: 0,
      queryClass: inferQueryClassFromQuery(row?.query),
      finalDecision: 'request_error',
      clarifyTriggered: false,
      requestError: true,
    };
  }

  const data = row?.data || {};
  const metadata = (data && typeof data === 'object' && data.metadata && typeof data.metadata === 'object')
    ? data.metadata
    : {};
  const routeDebug =
    metadata && typeof metadata.route_debug === 'object' && !Array.isArray(metadata.route_debug)
      ? metadata.route_debug
      : {};
  const crossMerchantDebug =
    routeDebug && typeof routeDebug.cross_merchant_cache === 'object' && !Array.isArray(routeDebug.cross_merchant_cache)
      ? routeDebug.cross_merchant_cache
      : {};
  const policyAmbiguity =
    routeDebug &&
    routeDebug.policy &&
    typeof routeDebug.policy === 'object' &&
    routeDebug.policy.ambiguity &&
    typeof routeDebug.policy.ambiguity === 'object'
      ? routeDebug.policy.ambiguity
      : {};
  const policyPostQuality =
    policyAmbiguity &&
    policyAmbiguity.post_quality &&
    typeof policyAmbiguity.post_quality === 'object'
      ? policyAmbiguity.post_quality
      : {};
  const decisionPostQuality =
    metadata &&
    metadata.search_decision &&
    typeof metadata.search_decision === 'object' &&
    metadata.search_decision.post_quality &&
    typeof metadata.search_decision.post_quality === 'object'
      ? metadata.search_decision.post_quality
      : {};
  const postQuality = Object.keys(policyPostQuality).length
    ? policyPostQuality
    : decisionPostQuality;
  const routeHealth =
    metadata && typeof metadata.route_health === 'object' && !Array.isArray(metadata.route_health)
      ? metadata.route_health
      : {};
  const searchTrace =
    metadata && typeof metadata.search_trace === 'object' && !Array.isArray(metadata.search_trace)
      ? metadata.search_trace
      : {};
  const products = Array.isArray(data.products) ? data.products : [];
  const querySource = String(metadata.query_source || '');
  const upstreamCode = String(metadata.upstream_error_code || metadata?.proxy_search_fallback?.upstream_error_code || '');
  const timeout = upstreamCode.toUpperCase() === 'ECONNABORTED';
  const strictEmpty = Boolean(metadata.strict_empty) || (products.length === 0 && !data.clarification);
  const fallback = querySource === 'agent_products_error_fallback';
  const irrelevant = !isRelevantResult(row.query, products);
  const queryClass =
    String(searchTrace.query_class || metadata?.search_decision?.query_class || inferQueryClassFromQuery(row.query));
  return {
    timeout,
    strictEmpty,
    fallback,
    irrelevant,
    querySource,
    productCount: products.length,
    queryClass,
    finalDecision: String(searchTrace.final_decision || metadata?.search_decision?.final_decision || ''),
    clarifyTriggered: Boolean(routeHealth?.clarify_triggered || data?.clarification),
    postCandidates: Number.isFinite(
      Number(postQuality?.candidates ?? crossMerchantDebug?.products_count),
    )
      ? Number(postQuality?.candidates ?? crossMerchantDebug?.products_count)
      : null,
    postAnchorRatio: Number.isFinite(Number(postQuality?.anchor_ratio))
      ? Number(postQuality.anchor_ratio)
      : null,
    postDomainEntropy: Number.isFinite(Number(postQuality?.domain_entropy))
      ? Number(postQuality.domain_entropy)
      : null,
    postAnchorBasisSize: Number.isFinite(Number(postQuality?.anchor_basis_size))
      ? Number(postQuality.anchor_basis_size)
      : null,
    requestError: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const queries = loadQueries(args.queryFile);
  const runTs = timestamp();
  const baseUrl = args.baseUrl.replace(/\/$/, '');
  const endpoint = args.endpoint.startsWith('/') ? args.endpoint : `/${args.endpoint}`;
  const url = `${baseUrl}${endpoint}`;
  const results = [];
  const startedAt = Date.now();

  for (let round = 1; round <= args.rounds; round += 1) {
    for (const query of queries) {
      const started = Date.now();
      let row = {
        round,
        query,
        ok: false,
        status: 0,
        latency_ms: 0,
        data: null,
        error: null,
      };
      try {
        const resp = await axios.post(
          url,
          {
            operation: 'find_products_multi',
            payload: {
              search: {
                query,
                limit: 10,
                in_stock_only: false,
              },
            },
            metadata: {
              source: args.source,
              ...(args.evalMode ? { eval_mode: true } : {}),
            },
          },
          {
            timeout: args.timeoutMs,
            validateStatus: () => true,
            headers: {
              'Content-Type': 'application/json',
              ...(args.evalMode
                ? { [String(args.evalHeader || 'X-Eval')]: String(args.evalHeaderValue || '1') }
                : {}),
            },
          },
        );
        row = {
          ...row,
          ok: resp.status >= 200 && resp.status < 300,
          status: Number(resp.status || 0) || 0,
          latency_ms: Math.max(0, Date.now() - started),
          data: resp.data,
        };
      } catch (err) {
        row = {
          ...row,
          ok: false,
          status: 0,
          latency_ms: Math.max(0, Date.now() - started),
          error: String(err?.message || err),
        };
      }
      results.push(row);
    }
  }

  const classified = results.map((row) => ({ ...row, metrics: classifyRow(row) }));
  const total = classified.length;
  const timeoutCount = classified.filter((row) => row.metrics.timeout).length;
  const requestErrorCount = classified.filter((row) => row.metrics.requestError).length;
  const fallbackCount = classified.filter((row) => row.metrics.fallback).length;
  const strictEmptyCount = classified.filter((row) => row.metrics.strictEmpty).length;
  const irrelevantCount = classified.filter((row) => row.metrics.irrelevant).length;
  const nonEmptyCount = classified.filter((row) => row.metrics.productCount > 0).length;
  const clarifyCount = classified.filter((row) => row.metrics.clarifyTriggered).length;
  const perQueryClass = {};
  for (const row of classified) {
    const key = String(row.metrics.queryClass || 'unknown');
    if (!perQueryClass[key]) {
      perQueryClass[key] = {
        total: 0,
        timeout: 0,
        fallback: 0,
        strict_empty: 0,
        irrelevant: 0,
        non_empty: 0,
        clarify: 0,
      };
    }
    perQueryClass[key].total += 1;
    if (row.metrics.timeout) perQueryClass[key].timeout += 1;
    if (row.metrics.fallback) perQueryClass[key].fallback += 1;
    if (row.metrics.strictEmpty) perQueryClass[key].strict_empty += 1;
    if (row.metrics.irrelevant) perQueryClass[key].irrelevant += 1;
    if (row.metrics.productCount > 0) perQueryClass[key].non_empty += 1;
    if (row.metrics.clarifyTriggered) perQueryClass[key].clarify += 1;
  }
  const summary = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    endpoint,
    eval_mode: Boolean(args.evalMode),
    rounds: args.rounds,
    total_requests: total,
    total_duration_ms: Math.max(0, Date.now() - startedAt),
    timeout_rate: total ? timeoutCount / total : 0,
    request_error_rate: total ? requestErrorCount / total : 0,
    fallback_rate: total ? fallbackCount / total : 0,
    strict_empty_rate: total ? strictEmptyCount / total : 0,
    irrelevant_result_rate: total ? irrelevantCount / total : 0,
    non_empty_rate: total ? nonEmptyCount / total : 0,
    clarify_rate: total ? clarifyCount / total : 0,
    per_query_class: perQueryClass,
    queries,
  };

  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const baseName = `search_stability_matrix_${runTs}`;
  const jsonPath = path.join(outDir, `${baseName}.json`);
  const mdPath = path.join(outDir, `${baseName}.md`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        summary,
        rows: classified.map((row) => ({
          round: row.round,
          query: row.query,
          ok: row.ok,
          status: row.status,
          latency_ms: row.latency_ms,
          query_source: row.metrics.querySource,
          product_count: row.metrics.productCount,
          timeout: row.metrics.timeout,
          fallback: row.metrics.fallback,
          strict_empty: row.metrics.strictEmpty,
          irrelevant: row.metrics.irrelevant,
          query_class: row.metrics.queryClass,
          final_decision: row.metrics.finalDecision,
          clarify_triggered: row.metrics.clarifyTriggered,
          post_candidates: row.metrics.postCandidates,
          post_anchor_ratio: row.metrics.postAnchorRatio,
          post_domain_entropy: row.metrics.postDomainEntropy,
          post_anchor_basis_size: row.metrics.postAnchorBasisSize,
          error: row.error,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  const md = [
    '# Search Stability Matrix',
    '',
    `- generated_at: ${summary.generated_at}`,
    `- base_url: ${summary.base_url}`,
    `- endpoint: ${summary.endpoint}`,
    `- rounds: ${summary.rounds}`,
    `- total_requests: ${summary.total_requests}`,
    `- timeout_rate: ${summary.timeout_rate.toFixed(4)}`,
    `- request_error_rate: ${summary.request_error_rate.toFixed(4)}`,
    `- fallback_rate: ${summary.fallback_rate.toFixed(4)}`,
    `- strict_empty_rate: ${summary.strict_empty_rate.toFixed(4)}`,
    `- irrelevant_result_rate: ${summary.irrelevant_result_rate.toFixed(4)}`,
    `- non_empty_rate: ${summary.non_empty_rate.toFixed(4)}`,
    `- clarify_rate: ${summary.clarify_rate.toFixed(4)}`,
    '',
    '| metric | value |',
    '|---|---:|',
    `| timeout_count | ${timeoutCount} |`,
    `| request_error_count | ${requestErrorCount} |`,
    `| fallback_count | ${fallbackCount} |`,
    `| strict_empty_count | ${strictEmptyCount} |`,
    `| irrelevant_count | ${irrelevantCount} |`,
    `| non_empty_count | ${nonEmptyCount} |`,
    `| clarify_count | ${clarifyCount} |`,
    '',
    '## Per Query Class',
    '',
    '| query_class | total | timeout | fallback | strict_empty | irrelevant | non_empty | clarify |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(perQueryClass)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(
        ([queryClass, metrics]) =>
          `| ${queryClass} | ${metrics.total} | ${metrics.timeout} | ${metrics.fallback} | ${metrics.strict_empty} | ${metrics.irrelevant} | ${metrics.non_empty} | ${metrics.clarify} |`,
      ),
    '',
    `JSON: ${path.relative(process.cwd(), jsonPath)}`,
  ].join('\n');
  fs.writeFileSync(mdPath, md, 'utf8');

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ok: true, summary, json: jsonPath, markdown: mdPath }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
