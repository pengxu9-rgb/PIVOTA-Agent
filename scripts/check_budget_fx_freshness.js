#!/usr/bin/env node
const https = require('https');
const { URL } = require('url');
const {
  normalizeRailMode,
  normalizeEndpoint,
  resolveBaseUrl,
  assertRailAuth,
} = require('./lib/commerce_invoke_contract');
const { assessPrimaryPath: assessPrimaryPathBase } = require('./lib/commerce_primary_path');

function parseArgs(argv) {
  const railMode = normalizeRailMode(process.env.RAIL_MODE || process.env.BUDGET_FX_PREFLIGHT_RAIL_MODE || '');
  const envAuthToken = process.env.AUTH_TOKEN || process.env.COMMERCE_CORE_PROD_AUTH_TOKEN || '';
  const envAgentApiKey =
    process.env.AGENT_API_KEY || process.env.COMMERCE_CORE_PROD_AGENT_API_KEY || '';
  const args = {
    railMode,
    baseUrl: resolveBaseUrl(
      process.env.BASE_URL || process.env.COMMERCE_CORE_PROD_SMOKE_BASE_URL || '',
      railMode,
    ),
    endpoint: normalizeEndpoint(
      process.env.ENDPOINT || process.env.COMMERCE_CORE_PROD_SMOKE_ENDPOINT || '',
      railMode,
    ),
    authToken: envAuthToken,
    agentApiKey: envAgentApiKey,
    source: process.env.SEARCH_MATRIX_SOURCE || 'search',
    query: process.env.BUDGET_FX_PREFLIGHT_QUERY || 'vitamin c serum under €30',
    timeoutMs: Number(process.env.BUDGET_FX_PREFLIGHT_TIMEOUT_MS || 15000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--rail-mode' && next) args.railMode = normalizeRailMode(next);
    if (token === '--auth-token' && next) args.authToken = String(next);
    if (token === '--agent-api-key' && next) args.agentApiKey = String(next);
    if (token === '--source' && next) args.source = String(next);
    if (token === '--query' && next) args.query = String(next);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(1000, Number(next) || 15000);
  }
  args.baseUrl = resolveBaseUrl(args.baseUrl, args.railMode);
  args.endpoint = normalizeEndpoint(args.endpoint, args.railMode);
  return args;
}

function assessPrimaryPath(metadata) {
  return assessPrimaryPathBase(metadata);
}

function requestJson(url, payload, timeoutMs, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...extraHeaders,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode || 0,
              data: JSON.parse(data),
            });
          } catch (error) {
            reject(new Error(`invalid_json_response:${data.slice(0, 400)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertRailAuth({
    railMode: args.railMode,
    authToken: args.authToken,
    agentApiKey: args.agentApiKey,
    context: 'check_budget_fx_freshness',
  });
  const baseUrl = String(args.baseUrl || '').replace(/\/$/, '');
  const endpoint = normalizeEndpoint(args.endpoint, args.railMode);
  const response = await requestJson(
    `${baseUrl}${endpoint}`,
    {
      operation: 'find_products_multi',
      payload: {
        search: {
          query: args.query,
          limit: 10,
          in_stock_only: true,
        },
      },
      metadata: {
        source: args.source,
      },
    },
    args.timeoutMs,
    {
      ...(args.authToken
        ? {
            Authorization: /^Bearer\s+/i.test(args.authToken)
              ? args.authToken
              : `Bearer ${args.authToken}`,
          }
        : {}),
      ...(args.agentApiKey ? { 'X-Agent-API-Key': args.agentApiKey } : {}),
    },
  );

  const metadata =
    response.data && typeof response.data === 'object' && response.data.metadata
      ? response.data.metadata
      : {};
  const products = Array.isArray(response.data?.products) ? response.data.products : [];
  const routeTrace =
    metadata && typeof metadata.route_trace === 'object' && !Array.isArray(metadata.route_trace)
      ? metadata.route_trace
      : {};
  const serviceVersion =
    metadata && typeof metadata.service_version === 'object' && !Array.isArray(metadata.service_version)
      ? metadata.service_version
      : {};
  const primaryPath = assessPrimaryPath(metadata);
  const serviceVersionCommit = String(serviceVersion.commit || '').trim();
  const result = {
    ok: false,
    status: response.status,
    query: args.query,
    source: args.source,
    total: Number(response.data?.total || 0),
    titles: products.map((item) => item?.title).filter(Boolean).slice(0, 5),
    query_source: metadata.query_source || null,
    final_decision:
      metadata.search_decision && typeof metadata.search_decision === 'object'
        ? metadata.search_decision.final_decision || null
        : metadata.final_decision || null,
    strict_constraint_reason: metadata.strict_constraint_reason || null,
    budget_currency: metadata.budget_currency || null,
    budget_fx_applied: metadata.budget_fx_applied === true,
    budget_fx_rate: metadata.budget_fx_rate ?? null,
    budget_fx_source: metadata.budget_fx_source ?? null,
    budget_fx_candidate_currency: metadata.budget_fx_candidate_currency ?? null,
    budget_fx_unresolved: metadata.budget_fx_unresolved === true,
    rail_mode: args.railMode,
    authoritative_endpoint: args.railMode === 'authoritative_commerce' ? `${baseUrl}${endpoint}` : null,
    primary_path_degraded: primaryPath.degraded,
    primary_path_degraded_reasons: primaryPath.reasons,
    decision_authority: primaryPath.decisionAuthority || null,
    decision_locked: primaryPath.decisionLocked === true,
    decision_lock_reason: primaryPath.decisionLockReason || null,
    observer_nodes: primaryPath.observerNodes || [],
    primary_path_used: primaryPath.primaryPathUsed,
    fallback_used: primaryPath.degraded === true,
    main_path_pass: false,
    matched_ingredient_ids: Array.isArray(metadata.matched_ingredient_ids)
      ? metadata.matched_ingredient_ids
      : [],
    service_version: serviceVersion || null,
    service_version_commit_present: Boolean(serviceVersionCommit),
    failure_stage: routeTrace.failure_stage || null,
    node_timings_ms:
      routeTrace.node_timings_ms && typeof routeTrace.node_timings_ms === 'object'
        ? routeTrace.node_timings_ms
        : null,
  };

  result.main_path_pass =
    response.status === 200 &&
    products.length > 0 &&
    result.budget_fx_applied === true &&
    result.budget_fx_rate != null &&
    result.budget_fx_source != null &&
    result.budget_fx_unresolved !== true &&
    primaryPath.degraded !== true &&
    Boolean(serviceVersionCommit);
  result.ok = result.main_path_pass;
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(error && error.message ? error.message : error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
