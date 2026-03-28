#!/usr/bin/env node
const axios = require('axios');
const {
  normalizeRailMode,
  normalizeEndpoint,
  resolveBaseUrl,
  assertRailAuth,
} = require('./lib/commerce_invoke_contract');
const { assessPrimaryPath } = require('./lib/commerce_primary_path');

function parseArgs(argv) {
  const railMode = normalizeRailMode(process.env.RAIL_MODE || process.env.WARM_RUNTIME_RAIL_MODE || '');
  const envAuthToken =
    process.env.AUTH_TOKEN ||
    process.env.WARM_RUNTIME_AUTH_TOKEN ||
    process.env.COMMERCE_CORE_PROD_AUTH_TOKEN ||
    '';
  const envAgentApiKey =
    process.env.AGENT_API_KEY ||
    process.env.WARM_RUNTIME_AGENT_API_KEY ||
    process.env.COMMERCE_CORE_PROD_AGENT_API_KEY ||
    '';
  const args = {
    railMode,
    baseUrl: resolveBaseUrl(
      process.env.WARM_RUNTIME_BASE_URL || process.env.COMMERCE_CORE_PROD_SMOKE_BASE_URL || '',
      railMode,
    ),
    endpoint: normalizeEndpoint(
      process.env.WARM_RUNTIME_ENDPOINT || process.env.COMMERCE_CORE_PROD_SMOKE_ENDPOINT || '',
      railMode,
    ),
    authToken: envAuthToken,
    agentApiKey: envAgentApiKey,
    query: process.env.WARM_RUNTIME_QUERY || 'serum',
    source: process.env.WARM_RUNTIME_SOURCE || 'search',
    attempts: Math.max(1, Number(process.env.WARM_RUNTIME_ATTEMPTS || 2) || 2),
    delayMs: Math.max(0, Number(process.env.WARM_RUNTIME_DELAY_MS || 3000) || 3000),
    timeoutMs: Math.max(1000, Number(process.env.WARM_RUNTIME_TIMEOUT_MS || 25000) || 25000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--rail-mode' && next) args.railMode = normalizeRailMode(next);
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--auth-token' && next) args.authToken = String(next);
    if (token === '--agent-api-key' && next) args.agentApiKey = String(next);
    if (token === '--query' && next) args.query = String(next);
    if (token === '--source' && next) args.source = String(next);
    if (token === '--attempts' && next) args.attempts = Math.max(1, Number(next) || 1);
    if (token === '--delay-ms' && next) args.delayMs = Math.max(0, Number(next) || 0);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(1000, Number(next) || 1000);
  }
  args.baseUrl = resolveBaseUrl(args.baseUrl, args.railMode);
  args.endpoint = normalizeEndpoint(args.endpoint, args.railMode);
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertRailAuth({
    railMode: args.railMode,
    authToken: args.authToken,
    agentApiKey: args.agentApiKey,
    context: 'warm_find_products_multi_runtime',
  });
  const url = `${String(args.baseUrl || '').replace(/\/$/, '')}${normalizeEndpoint(
    args.endpoint,
    args.railMode,
  )}`;
  const attemptResults = [];
  let lastError = null;

  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const resp = await axios.post(
        url,
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
        {
          timeout: args.timeoutMs,
          validateStatus: () => true,
          headers: {
            'Content-Type': 'application/json',
            ...(args.authToken
              ? {
                  Authorization: /^Bearer\s+/i.test(args.authToken)
                    ? args.authToken
                    : `Bearer ${args.authToken}`,
                }
              : {}),
            ...(args.agentApiKey ? { 'X-Agent-API-Key': args.agentApiKey } : {}),
          },
        },
      );
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const metadata =
        resp?.data && typeof resp.data === 'object' && resp.data.metadata && typeof resp.data.metadata === 'object'
          ? resp.data.metadata
          : {};
      const titles = Array.isArray(resp?.data?.products)
        ? resp.data.products.map((item) => String(item?.title || item?.name || '').trim()).filter(Boolean).slice(0, 3)
        : [];
      const primaryPath = assessPrimaryPath(resp?.data || {});
      const result = {
        attempt,
        status: Number(resp.status || 0) || 0,
        latency_ms: latencyMs,
        query_source: metadata.query_source || null,
        primary_path_degraded: primaryPath.degraded,
        primary_path_degraded_reasons: primaryPath.reasons,
        titles,
      };
      attemptResults.push(result);
      if (
        resp.status >= 200 &&
        resp.status < 300 &&
        titles.length > 0 &&
        primaryPath.degraded !== true
      ) {
        console.log(JSON.stringify({ ok: true, warmed: true, attempt: result.attempt, result, attempts: attemptResults }, null, 2));
        return;
      }
      lastError = new Error(
        primaryPath.degraded
          ? `warmup_primary_path_degraded:${primaryPath.reasons.join(',')}`
          : titles.length === 0
            ? 'warmup_empty_results'
            : `warmup_status_${resp.status}`,
      );
    } catch (err) {
      lastError = err;
      attemptResults.push({
        attempt,
        error: String(err?.message || err),
      });
    }

    if (attempt < args.attempts && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        warmed: false,
        query: args.query,
        attempts: attemptResults,
        error: String(lastError?.message || lastError || 'warmup_failed'),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exitCode = 1;
});
