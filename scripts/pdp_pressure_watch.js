#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeString(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeStringList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  return fallback.slice();
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.PDP_PRESSURE_BASE_URL || 'https://agent.pivota.cc',
    endpoint: process.env.PDP_PRESSURE_ENDPOINT || '/api/gateway',
    caseFile: process.env.PDP_PRESSURE_CASE_FILE || '',
    outDir: process.env.PDP_PRESSURE_OUT_DIR || 'reports',
    rounds: parsePositiveInt(process.env.PDP_PRESSURE_ROUNDS, 3),
    timeoutMs: parsePositiveInt(process.env.PDP_PRESSURE_TIMEOUT_MS, 8000),
    concurrency: parsePositiveInt(process.env.PDP_PRESSURE_CONCURRENCY, 4),
    cacheBypass:
      String(process.env.PDP_PRESSURE_CACHE_BYPASS || 'true').trim().toLowerCase() !== 'false',
    evalMode:
      String(process.env.PDP_PRESSURE_EVAL_MODE || '').trim().toLowerCase() === 'true',
    evalHeader: process.env.PDP_PRESSURE_EVAL_HEADER || 'X-Eval',
    evalHeaderValue: process.env.PDP_PRESSURE_EVAL_HEADER_VALUE || '1',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--case-file' && next) args.caseFile = String(next);
    if (token === '--out-dir' && next) args.outDir = String(next);
    if (token === '--rounds' && next) args.rounds = Math.max(1, parsePositiveInt(next, args.rounds));
    if (token === '--timeout-ms' && next) {
      args.timeoutMs = Math.max(500, parsePositiveInt(next, args.timeoutMs));
    }
    if (token === '--concurrency' && next) {
      args.concurrency = Math.max(1, parsePositiveInt(next, args.concurrency));
    }
    if (token === '--cache-bypass') args.cacheBypass = true;
    if (token === '--no-cache-bypass') args.cacheBypass = false;
    if (token === '--eval-mode') args.evalMode = true;
    if (token === '--eval-header' && next) args.evalHeader = String(next);
    if (token === '--eval-header-value' && next) args.evalHeaderValue = String(next);
  }

  return args;
}

function normalizeWatchCase(rawCase, index) {
  if (!rawCase || typeof rawCase !== 'object') return null;
  const productId = normalizeString(rawCase.product_id || rawCase.productId);
  if (!productId) return null;

  return {
    id: normalizeString(rawCase.id) || `case_${index + 1}`,
    bucket: normalizeString(rawCase.bucket) || 'pressure_watch',
    product_id: productId,
    merchant_id: normalizeString(rawCase.merchant_id || rawCase.merchantId),
    include: normalizeStringList(rawCase.include, []),
    notes: normalizeString(rawCase.notes),
  };
}

function loadCases(caseFile) {
  if (!caseFile) {
    throw new Error('Missing case file. Pass --case-file <path> or set PDP_PRESSURE_CASE_FILE.');
  }

  const fullPath = path.resolve(caseFile);
  const text = fs.readFileSync(fullPath, 'utf8');
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cases) ? parsed.cases : [];
  const cases = list.map((item, index) => normalizeWatchCase(item, index)).filter(Boolean);
  if (!cases.length) {
    throw new Error(`No valid cases found in ${fullPath}`);
  }
  return cases;
}

function buildEndpoint(baseUrl, endpoint) {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedBase) return normalizedEndpoint || '/api/gateway';
  if (!normalizedEndpoint) return normalizedBase;
  return normalizedEndpoint.startsWith('http')
    ? normalizedEndpoint
    : `${normalizedBase}${normalizedEndpoint.startsWith('/') ? '' : '/'}${normalizedEndpoint}`;
}

function buildInvokeBody(watchCase, cacheBypass) {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        product_id: watchCase.product_id,
        ...(watchCase.merchant_id ? { merchant_id: watchCase.merchant_id } : {}),
      },
      include: watchCase.include,
      options: {
        ...(cacheBypass ? { cache_bypass: true } : {}),
      },
      capabilities: {
        client: 'pdp_pressure_watch',
        client_version: '2026-04-09',
      },
    },
  };
}

function pickHeader(headers, names) {
  for (const name of names) {
    const value = headers?.[name];
    if (value == null) continue;
    const normalized = String(Array.isArray(value) ? value[0] : value).trim();
    if (normalized) return normalized;
  }
  return null;
}

function summarizeModuleReasons(modules) {
  if (!Array.isArray(modules)) return {};
  const output = {};
  for (const moduleEntry of modules) {
    const type = normalizeString(moduleEntry?.type);
    if (!type) continue;
    const reason = normalizeString(moduleEntry?.reason);
    if (!reason) continue;
    output[type] = reason;
  }
  return output;
}

function buildOutcomeKey(result) {
  if (result.transport_error) {
    return `transport:${result.transport_error}`;
  }
  return `status:${result.status ?? 'null'}|reason:${result.reason_code || '-'}`;
}

async function probeCase(args) {
  const startedAt = Date.now();
  const invokeBody = buildInvokeBody(args.watchCase, args.cacheBypass);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (args.evalMode && args.evalHeader && args.evalHeaderValue) {
    headers[args.evalHeader] = args.evalHeaderValue;
  }

  try {
    const response = await axios.post(args.url, invokeBody, {
      timeout: args.timeoutMs,
      validateStatus: () => true,
      headers,
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const data = response?.data && typeof response.data === 'object' ? response.data : {};
    const gatewayRequestId =
      normalizeString(data.gateway_request_id || data.request_id) ||
      pickHeader(response.headers, ['x-gateway-request-id']);
    const upstreamRequestId =
      normalizeString(data.upstream_request_id) ||
      pickHeader(response.headers, ['x-upstream-request-id', 'x-request-id', 'x-requestid']);
    const reasonCode = normalizeString(data.reason_code || data.error);
    const identityResolution =
      data?.metadata && typeof data.metadata === 'object' ? data.metadata.identity_resolution || null : null;
    const routeHealth =
      data?.metadata && typeof data.metadata === 'object' ? data.metadata.route_health || null : null;
    const moduleReasons = summarizeModuleReasons(data.modules);
    const missing = Array.isArray(data.missing) ? data.missing : [];

    const result = {
      id: args.watchCase.id,
      bucket: args.watchCase.bucket,
      round: args.round,
      product_id: args.watchCase.product_id,
      requested_merchant_id: args.watchCase.merchant_id || null,
      status: response.status,
      latency_ms: latencyMs,
      ok: response.status >= 200 && response.status < 300,
      reason_code: reasonCode,
      gateway_request_id: gatewayRequestId,
      upstream_request_id: upstreamRequestId,
      identity_resolution: identityResolution,
      route_health: routeHealth,
      module_reasons: moduleReasons,
      missing,
      transport_error: null,
      notes: args.watchCase.notes || null,
    };
    return {
      ...result,
      outcome_key: buildOutcomeKey(result),
    };
  } catch (err) {
    const result = {
      id: args.watchCase.id,
      bucket: args.watchCase.bucket,
      round: args.round,
      product_id: args.watchCase.product_id,
      requested_merchant_id: args.watchCase.merchant_id || null,
      status: err?.response?.status || null,
      latency_ms: Math.max(0, Date.now() - startedAt),
      ok: false,
      reason_code: null,
      gateway_request_id: null,
      upstream_request_id: null,
      identity_resolution: null,
      route_health: null,
      module_reasons: {},
      missing: [],
      transport_error: normalizeString(err?.code || err?.message) || 'TRANSPORT_ERROR',
      notes: args.watchCase.notes || null,
    };
    return {
      ...result,
      outcome_key: buildOutcomeKey(result),
    };
  }
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function summarizeEntries(results, keyName) {
  const groups = {};
  for (const result of results) {
    const key = result[keyName] || 'uncategorized';
    if (!groups[key]) {
      groups[key] = {
        key,
        total: 0,
        statuses: {},
        reason_codes: {},
        transport_errors: {},
        outcomes: {},
        latency_values: [],
      };
    }
    const entry = groups[key];
    entry.total += 1;
    entry.statuses[String(result.status ?? 'null')] = (entry.statuses[String(result.status ?? 'null')] || 0) + 1;
    if (result.reason_code) {
      entry.reason_codes[result.reason_code] = (entry.reason_codes[result.reason_code] || 0) + 1;
    }
    if (result.transport_error) {
      entry.transport_errors[result.transport_error] =
        (entry.transport_errors[result.transport_error] || 0) + 1;
    }
    entry.outcomes[result.outcome_key] = (entry.outcomes[result.outcome_key] || 0) + 1;
    if (Number.isFinite(result.latency_ms)) entry.latency_values.push(result.latency_ms);
  }

  return Object.values(groups)
    .map((entry) => ({
      [keyName]: entry.key,
      total: entry.total,
      distinct_outcomes: Object.keys(entry.outcomes).length,
      flapped: Object.keys(entry.outcomes).length > 1,
      p50_latency_ms: percentile(entry.latency_values, 50),
      p95_latency_ms: percentile(entry.latency_values, 95),
      statuses: entry.statuses,
      reason_codes: entry.reason_codes,
      transport_errors: entry.transport_errors,
      outcomes: entry.outcomes,
    }))
    .sort((a, b) => String(a[keyName]).localeCompare(String(b[keyName])));
}

function summarizeByBucket(results) {
  return summarizeEntries(results, 'bucket');
}

function summarizeByCase(results) {
  return summarizeEntries(results, 'id');
}

function formatObjectInline(input) {
  const entries = Object.entries(input || {});
  if (!entries.length) return '-';
  return entries
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}

function buildMarkdownReport(args) {
  const lines = [];
  lines.push('# PDP Pressure Watch');
  lines.push('');
  lines.push(`- Generated At (UTC): ${new Date().toISOString()}`);
  lines.push(`- URL: ${args.url}`);
  lines.push(`- Rounds: ${args.config.rounds}`);
  lines.push(`- Concurrency: ${args.config.concurrency}`);
  lines.push(`- Timeout Ms: ${args.config.timeoutMs}`);
  lines.push(`- Cache Bypass: ${args.config.cacheBypass}`);
  lines.push('');
  lines.push('## Bucket Summary');
  lines.push('');
  lines.push('| Bucket | Total | Distinct Outcomes | Flapped | P50 ms | P95 ms | Statuses | Transport Errors |');
  lines.push('| --- | ---: | ---: | --- | ---: | ---: | --- | --- |');
  for (const bucket of args.bucketSummary) {
    lines.push(
      `| ${bucket.bucket} | ${bucket.total} | ${bucket.distinct_outcomes} | ${
        bucket.flapped ? 'yes' : 'no'
      } | ${bucket.p50_latency_ms ?? '-'} | ${bucket.p95_latency_ms ?? '-'} | ${formatObjectInline(
        bucket.statuses,
      )} | ${formatObjectInline(bucket.transport_errors)} |`,
    );
  }
  lines.push('');
  lines.push('## Case Summary');
  lines.push('');
  lines.push('| Case | Distinct Outcomes | Flapped | Statuses | Transport Errors | Outcomes |');
  lines.push('| --- | ---: | --- | --- | --- | --- |');
  for (const item of args.caseSummary) {
    lines.push(
      `| ${item.id} | ${item.distinct_outcomes} | ${item.flapped ? 'yes' : 'no'} | ${formatObjectInline(
        item.statuses,
      )} | ${formatObjectInline(item.transport_errors)} | ${formatObjectInline(item.outcomes)} |`,
    );
  }
  lines.push('');
  lines.push('## Probe Results');
  lines.push('');
  lines.push('| Case | Bucket | Round | Status | Reason | Transport | Latency ms | Gateway Request ID |');
  lines.push('| --- | --- | ---: | ---: | --- | --- | ---: | --- |');
  for (const result of args.results) {
    lines.push(
      `| ${result.id} | ${result.bucket} | ${result.round} | ${result.status ?? '-'} | ${
        result.reason_code || '-'
      } | ${result.transport_error || '-'} | ${result.latency_ms} | ${result.gateway_request_id || '-'} |`,
    );
  }
  lines.push('');
  lines.push('## Node Chain');
  lines.push('');
  lines.push(
    'Concurrent production probe -> Next `/api/gateway` -> backend `/agent/shop/v1/invoke` -> `get_pdp_v2` core phases. Use this report to separate per-product identity failures from shared pressure or capacity jitter.',
  );
  return `${lines.join('\n')}\n`;
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

async function run() {
  const config = parseArgs(process.argv.slice(2));
  const url = buildEndpoint(config.baseUrl, config.endpoint);
  const cases = loadCases(config.caseFile);
  const results = [];

  for (let round = 1; round <= config.rounds; round += 1) {
    const roundResults = await mapLimit(cases, config.concurrency, async (watchCase) =>
      probeCase({
        url,
        timeoutMs: config.timeoutMs,
        cacheBypass: config.cacheBypass,
        evalMode: config.evalMode,
        evalHeader: config.evalHeader,
        evalHeaderValue: config.evalHeaderValue,
        watchCase,
        round,
      }),
    );
    for (const result of roundResults) {
      results.push(result);
      console.log(
        JSON.stringify({
          case_id: result.id,
          bucket: result.bucket,
          round: result.round,
          status: result.status,
          reason_code: result.reason_code,
          transport_error: result.transport_error || null,
          latency_ms: result.latency_ms,
          gateway_request_id: result.gateway_request_id,
          outcome_key: result.outcome_key,
        }),
      );
    }
  }

  const bucketSummary = summarizeByBucket(results);
  const caseSummary = summarizeByCase(results);
  const stamp = timestamp();
  const outDir = path.resolve(config.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `pdp_pressure_watch_${stamp}.json`);
  const mdPath = path.join(outDir, `pdp_pressure_watch_${stamp}.md`);
  const payload = {
    generated_at: new Date().toISOString(),
    url,
    config,
    bucket_summary: bucketSummary,
    case_summary: caseSummary,
    results,
  };

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    mdPath,
    buildMarkdownReport({
      url,
      config,
      bucketSummary,
      caseSummary,
      results,
    }),
    'utf8',
  );

  console.log(
    JSON.stringify({
      json_report: jsonPath,
      markdown_report: mdPath,
      buckets: bucketSummary.length,
      cases: caseSummary.length,
      total_results: results.length,
    }),
  );
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}

module.exports = {
  buildEndpoint,
  buildInvokeBody,
  buildOutcomeKey,
  normalizeWatchCase,
  parseArgs,
  summarizeByBucket,
  summarizeByCase,
};
