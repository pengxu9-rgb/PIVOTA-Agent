#!/usr/bin/env node
const https = require('https');
const { URL } = require('url');

function parseArgs(argv) {
  const envAuthToken = process.env.AUTH_TOKEN || process.env.COMMERCE_CORE_PROD_AUTH_TOKEN || '';
  const envAgentApiKey =
    process.env.AGENT_API_KEY || process.env.COMMERCE_CORE_PROD_AGENT_API_KEY || '';
  const defaultEndpoint =
    process.env.ENDPOINT ||
    process.env.COMMERCE_CORE_PROD_SMOKE_ENDPOINT ||
    (envAuthToken || envAgentApiKey ? '/agent/shop/v1/invoke' : '/api/gateway');
  const args = {
    baseUrl:
      process.env.BASE_URL ||
      process.env.COMMERCE_CORE_PROD_SMOKE_BASE_URL ||
      'https://agent.pivota.cc',
    endpoint: defaultEndpoint,
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
    if (token === '--auth-token' && next) args.authToken = String(next);
    if (token === '--agent-api-key' && next) args.agentApiKey = String(next);
    if (token === '--source' && next) args.source = String(next);
    if (token === '--query' && next) args.query = String(next);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(1000, Number(next) || 15000);
  }
  return args;
}

function assessPrimaryPath(metadata) {
  const routeHealth =
    metadata && typeof metadata.route_health === 'object' && !Array.isArray(metadata.route_health)
      ? metadata.route_health
      : {};
  const proxySearchFallback =
    metadata &&
    typeof metadata.proxy_search_fallback === 'object' &&
    !Array.isArray(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : {};
  const querySource = String(metadata?.query_source || '').trim();
  const primaryPathUsed = String(routeHealth.primary_path_used || '').trim();
  const reasons = [];

  if (
    querySource === 'agent_products_error_fallback' ||
    querySource === 'agent_products_resolver_fallback' ||
    querySource === 'agent_products_resolver_ref_fallback'
  ) {
    reasons.push(`query_source=${querySource}`);
  }
  if (proxySearchFallback.applied === true) reasons.push('proxy_search_fallback.applied=true');
  if (routeHealth.fallback_triggered === true) reasons.push('route_health.fallback_triggered=true');
  if (/(fallback|primary_unusable)/i.test(primaryPathUsed)) {
    reasons.push(`route_health.primary_path_used=${primaryPathUsed}`);
  }

  return {
    degraded: reasons.length > 0,
    reasons,
    primaryPathUsed: primaryPathUsed || null,
  };
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
  const baseUrl = String(args.baseUrl || '').replace(/\/$/, '');
  const endpoint = String(args.endpoint || '').startsWith('/')
    ? String(args.endpoint)
    : `/${args.endpoint}`;
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
  const primaryPath = assessPrimaryPath(metadata);
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
    primary_path_degraded: primaryPath.degraded,
    primary_path_degraded_reasons: primaryPath.reasons,
    primary_path_used: primaryPath.primaryPathUsed,
    matched_ingredient_ids: Array.isArray(metadata.matched_ingredient_ids)
      ? metadata.matched_ingredient_ids
      : [],
    service_version: metadata.service_version || null,
  };

  result.ok =
    response.status === 200 &&
    products.length > 0 &&
    result.budget_fx_applied === true &&
    result.budget_fx_rate != null &&
    result.budget_fx_source != null &&
    result.budget_fx_unresolved !== true &&
    primaryPath.degraded !== true;
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
