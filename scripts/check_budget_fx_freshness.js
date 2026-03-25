#!/usr/bin/env node
const https = require('https');

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.BASE_URL || 'https://agent.pivota.cc',
    endpoint: process.env.ENDPOINT || '/api/gateway',
    source: process.env.SEARCH_MATRIX_SOURCE || 'search',
    query: process.env.BUDGET_FX_PREFLIGHT_QUERY || 'vitamin c serum under €30',
    timeoutMs: Number(process.env.BUDGET_FX_PREFLIGHT_TIMEOUT_MS || 15000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--source' && next) args.source = String(next);
    if (token === '--query' && next) args.query = String(next);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(1000, Number(next) || 15000);
  }
  return args;
}

function requestJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
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
  );

  const metadata =
    response.data && typeof response.data === 'object' && response.data.metadata
      ? response.data.metadata
      : {};
  const products = Array.isArray(response.data?.products) ? response.data.products : [];
  const result = {
    ok: false,
    status: response.status,
    query: args.query,
    source: args.source,
    total: Number(response.data?.total || 0),
    titles: products.map((item) => item?.title).filter(Boolean).slice(0, 5),
    strict_constraint_reason: metadata.strict_constraint_reason || null,
    budget_currency: metadata.budget_currency || null,
    budget_fx_applied: metadata.budget_fx_applied === true,
    budget_fx_rate: metadata.budget_fx_rate ?? null,
    budget_fx_source: metadata.budget_fx_source ?? null,
    budget_fx_candidate_currency: metadata.budget_fx_candidate_currency ?? null,
    budget_fx_unresolved: metadata.budget_fx_unresolved === true,
    matched_ingredient_ids: Array.isArray(metadata.matched_ingredient_ids)
      ? metadata.matched_ingredient_ids
      : [],
    service_version: metadata.service_version || null,
  };

  result.ok = response.status === 200 && result.budget_fx_unresolved !== true;
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
