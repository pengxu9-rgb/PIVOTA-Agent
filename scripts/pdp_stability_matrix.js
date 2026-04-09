#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { DEFAULT_PUBLIC_ENDPOINT } = require('./lib/commerce_invoke_contract');

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.PDP_STABILITY_BASE_URL || 'https://agent.pivota.cc',
    endpoint: process.env.PDP_STABILITY_ENDPOINT || DEFAULT_PUBLIC_ENDPOINT,
    caseFile: process.env.PDP_STABILITY_CASE_FILE || '',
    outDir: process.env.PDP_STABILITY_OUT_DIR || 'reports',
    rounds: parsePositiveInt(process.env.PDP_STABILITY_ROUNDS, 1),
    timeoutMs: parsePositiveInt(process.env.PDP_STABILITY_TIMEOUT_MS, 20000),
    cacheBypass:
      String(process.env.PDP_STABILITY_CACHE_BYPASS || 'true').trim().toLowerCase() !== 'false',
    evalMode:
      String(process.env.PDP_STABILITY_EVAL_MODE || '').trim().toLowerCase() === 'true',
    evalHeader: process.env.PDP_STABILITY_EVAL_HEADER || 'X-Eval',
    evalHeaderValue: process.env.PDP_STABILITY_EVAL_HEADER_VALUE || '1',
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
    if (token === '--cache-bypass') args.cacheBypass = true;
    if (token === '--no-cache-bypass') args.cacheBypass = false;
    if (token === '--eval-mode') args.evalMode = true;
    if (token === '--eval-header' && next) args.evalHeader = String(next);
    if (token === '--eval-header-value' && next) args.evalHeaderValue = String(next);
  }

  return args;
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

function normalizeCase(rawCase, index) {
  if (!rawCase || typeof rawCase !== 'object') return null;
  const productId = normalizeString(rawCase.product_id || rawCase.productId);
  if (!productId) return null;

  const expectReasonCodes = normalizeStringList(
    rawCase.expect_reason_codes || rawCase.expectReasonCodes || rawCase.expect_reason_code,
  );
  const include = normalizeStringList(
    rawCase.include,
    ['offers', 'reviews_preview', 'similar'],
  );

  return {
    id: normalizeString(rawCase.id) || `case_${index + 1}`,
    bucket: normalizeString(rawCase.bucket) || 'uncategorized',
    product_id: productId,
    merchant_id: normalizeString(rawCase.merchant_id || rawCase.merchantId),
    include,
    expect_status:
      rawCase.expect_status == null ? null : Number(rawCase.expect_status || rawCase.expectStatus || 0) || null,
    expect_reason_codes: expectReasonCodes,
    expect_resolved_merchant_id: normalizeString(
      rawCase.expect_resolved_merchant_id || rawCase.expectResolvedMerchantId,
    ),
    expect_canonicalization_applied:
      rawCase.expect_canonicalization_applied == null &&
      rawCase.expectCanonicalizationApplied == null
        ? null
        : Boolean(
            rawCase.expect_canonicalization_applied ?? rawCase.expectCanonicalizationApplied,
          ),
    expect_transport_error: normalizeString(
      rawCase.expect_transport_error || rawCase.expectTransportError,
    ),
    notes: normalizeString(rawCase.notes),
  };
}

function loadCases(caseFile) {
  if (!caseFile) {
    throw new Error('Missing case file. Pass --case-file <path> or set PDP_STABILITY_CASE_FILE.');
  }

  const fullPath = path.resolve(caseFile);
  const text = fs.readFileSync(fullPath, 'utf8');
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cases) ? parsed.cases : [];
  const cases = list.map((item, index) => normalizeCase(item, index)).filter(Boolean);
  if (!cases.length) {
    throw new Error(`No valid cases found in ${fullPath}`);
  }
  return cases;
}

function buildEndpoint(baseUrl, endpoint) {
  const normalizedBase = String(baseUrl || '').trim().replace(/\/+$/, '');
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedBase) return normalizedEndpoint || DEFAULT_PUBLIC_ENDPOINT;
  if (!normalizedEndpoint) return normalizedBase;
  return normalizedEndpoint.startsWith('http')
    ? normalizedEndpoint
    : `${normalizedBase}${normalizedEndpoint.startsWith('/') ? '' : '/'}${normalizedEndpoint}`;
}

function buildInvokeBody(stabilityCase, cacheBypass) {
  return {
    operation: 'get_pdp_v2',
    payload: {
      product_ref: {
        product_id: stabilityCase.product_id,
        ...(stabilityCase.merchant_id ? { merchant_id: stabilityCase.merchant_id } : {}),
      },
      include: stabilityCase.include,
      options: {
        ...(cacheBypass ? { cache_bypass: true } : {}),
      },
      capabilities: {
        client: 'pdp_stability_matrix',
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

function evaluateCase(stabilityCase, probe) {
  const failures = [];
  if (stabilityCase.expect_status != null && probe.status !== stabilityCase.expect_status) {
    failures.push(`expected status ${stabilityCase.expect_status}, got ${probe.status}`);
  }
  if (
    stabilityCase.expect_reason_codes.length > 0 &&
    !stabilityCase.expect_reason_codes.includes(String(probe.reason_code || '').trim())
  ) {
    failures.push(
      `expected reason_code in [${stabilityCase.expect_reason_codes.join(', ')}], got ${
        probe.reason_code || 'null'
      }`,
    );
  }
  if (
    stabilityCase.expect_resolved_merchant_id &&
    stabilityCase.expect_resolved_merchant_id !== probe.identity_resolution?.resolved_merchant_id
  ) {
    failures.push(
      `expected resolved merchant ${stabilityCase.expect_resolved_merchant_id}, got ${
        probe.identity_resolution?.resolved_merchant_id || 'null'
      }`,
    );
  }
  if (
    stabilityCase.expect_canonicalization_applied != null &&
    Boolean(probe.identity_resolution?.canonicalization_applied) !==
      stabilityCase.expect_canonicalization_applied
  ) {
    failures.push(
      `expected canonicalization_applied=${stabilityCase.expect_canonicalization_applied}, got ${
        Boolean(probe.identity_resolution?.canonicalization_applied)
      }`,
    );
  }
  if (
    stabilityCase.expect_transport_error &&
    stabilityCase.expect_transport_error !== String(probe.transport_error || '').trim()
  ) {
    failures.push(
      `expected transport_error ${stabilityCase.expect_transport_error}, got ${
        probe.transport_error || 'null'
      }`,
    );
  }
  return {
    passed: failures.length === 0,
    failures,
  };
}

async function probeCase(args) {
  const startedAt = Date.now();
  const invokeBody = buildInvokeBody(args.stabilityCase, args.cacheBypass);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (args.evalMode && args.evalHeader && args.evalHeaderValue) {
    headers[args.evalHeader] = args.evalHeaderValue;
  }

  let probe;
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
      pickHeader(response.headers, [
        'x-upstream-request-id',
        'x-request-id',
        'x-requestid',
        'x-railway-request-id',
      ]);
    const reasonCode = normalizeString(data.reason_code || data.error);
    const identityResolution =
      data?.metadata && typeof data.metadata === 'object' ? data.metadata.identity_resolution || null : null;
    const routeHealth =
      data?.metadata && typeof data.metadata === 'object' ? data.metadata.route_health || null : null;
    const moduleReasons = summarizeModuleReasons(data.modules);
    const missing = Array.isArray(data.missing) ? data.missing : [];

    probe = {
      id: args.stabilityCase.id,
      bucket: args.stabilityCase.bucket,
      round: args.round,
      product_id: args.stabilityCase.product_id,
      requested_merchant_id: args.stabilityCase.merchant_id || null,
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
      notes: args.stabilityCase.notes || null,
    };
  } catch (err) {
    const transportError = normalizeString(err?.code || err?.message) || 'TRANSPORT_ERROR';
    probe = {
      id: args.stabilityCase.id,
      bucket: args.stabilityCase.bucket,
      round: args.round,
      product_id: args.stabilityCase.product_id,
      requested_merchant_id: args.stabilityCase.merchant_id || null,
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
      transport_error: transportError,
      notes: args.stabilityCase.notes || null,
    };
  }

  const evaluation = evaluateCase(args.stabilityCase, probe);
  return {
    ...probe,
    passed: evaluation.passed,
    failures: evaluation.failures,
  };
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function summarizeResults(results) {
  const buckets = {};
  for (const result of results) {
    const bucket = result.bucket || 'uncategorized';
    if (!buckets[bucket]) {
      buckets[bucket] = {
        bucket,
        total: 0,
        passed: 0,
        failed: 0,
        statuses: {},
        reason_codes: {},
        latency_values: [],
      };
    }
    const entry = buckets[bucket];
    entry.total += 1;
    if (result.passed) entry.passed += 1;
    else entry.failed += 1;
    entry.statuses[String(result.status || 'null')] = (entry.statuses[String(result.status || 'null')] || 0) + 1;
    if (result.reason_code) {
      entry.reason_codes[result.reason_code] = (entry.reason_codes[result.reason_code] || 0) + 1;
    }
    if (Number.isFinite(result.latency_ms)) entry.latency_values.push(result.latency_ms);
  }

  return Object.values(buckets)
    .map((entry) => ({
      bucket: entry.bucket,
      total: entry.total,
      passed: entry.passed,
      failed: entry.failed,
      p50_latency_ms: percentile(entry.latency_values, 50),
      p95_latency_ms: percentile(entry.latency_values, 95),
      statuses: entry.statuses,
      reason_codes: entry.reason_codes,
    }))
    .sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
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
  lines.push('# PDP Stability Matrix');
  lines.push('');
  lines.push(`- Generated At (UTC): ${new Date().toISOString()}`);
  lines.push(`- URL: ${args.url}`);
  lines.push(`- Rounds: ${args.config.rounds}`);
  lines.push(`- Timeout Ms: ${args.config.timeoutMs}`);
  lines.push(`- Cache Bypass: ${args.config.cacheBypass}`);
  lines.push('');
  lines.push('## Bucket Summary');
  lines.push('');
  lines.push('| Bucket | Total | Passed | Failed | P50 ms | P95 ms | Statuses | Reason Codes |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const bucket of args.bucketSummary) {
    lines.push(
      `| ${bucket.bucket} | ${bucket.total} | ${bucket.passed} | ${bucket.failed} | ${
        bucket.p50_latency_ms ?? '-'
      } | ${bucket.p95_latency_ms ?? '-'} | ${formatObjectInline(bucket.statuses)} | ${formatObjectInline(
        bucket.reason_codes,
      )} |`,
    );
  }
  lines.push('');
  lines.push('## Case Results');
  lines.push('');
  lines.push(
    '| Case | Bucket | Round | Status | Reason | Transport | Passed | Gateway Request ID | Resolved Merchant | Canonicalized | Missing Modules | Module Reasons |',
  );
  lines.push('| --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const result of args.results) {
    const identity = result.identity_resolution || {};
    lines.push(
      `| ${result.id} | ${result.bucket} | ${result.round} | ${result.status} | ${
        result.reason_code || '-'
      } | ${result.transport_error || '-'} | ${result.passed ? 'yes' : 'no'} | ${result.gateway_request_id || '-'} | ${
        identity.resolved_merchant_id || '-'
      } | ${identity.canonicalization_applied ? 'yes' : 'no'} | ${
        Array.isArray(result.missing) && result.missing.length
          ? result.missing.map((item) => `${item.type}:${item.reason}`).join(', ')
          : '-'
      } | ${formatObjectInline(result.module_reasons)} |`,
    );
    if (Array.isArray(result.failures) && result.failures.length) {
      lines.push(`Failure Detail: ${result.failures.join('; ')}`);
    }
  }
  lines.push('');
  lines.push('## Node Chain');
  lines.push('');
  lines.push(
    `Browser or probe -> Next \`${DEFAULT_PUBLIC_ENDPOINT}\` -> backend \`/agent/shop/v1/invoke\` -> \`get_pdp_v2\` phases -> upstream detail/group/reviews/similar nodes.`,
  );
  return `${lines.join('\n')}\n`;
}

async function run() {
  const config = parseArgs(process.argv.slice(2));
  const url = buildEndpoint(config.baseUrl, config.endpoint);
  const cases = loadCases(config.caseFile);
  const results = [];

  for (let round = 1; round <= config.rounds; round += 1) {
    for (const stabilityCase of cases) {
      const result = await probeCase({
        url,
        timeoutMs: config.timeoutMs,
        cacheBypass: config.cacheBypass,
        evalMode: config.evalMode,
        evalHeader: config.evalHeader,
        evalHeaderValue: config.evalHeaderValue,
        stabilityCase,
        round,
      });
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
          passed: result.passed,
        }),
      );
    }
  }

  const bucketSummary = summarizeResults(results);
  const stamp = timestamp();
  const outDir = path.resolve(config.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `pdp_stability_matrix_${stamp}.json`);
  const mdPath = path.join(outDir, `pdp_stability_matrix_${stamp}.md`);

  const payload = {
    generated_at: new Date().toISOString(),
    url,
    config,
    bucket_summary: bucketSummary,
    results,
  };

  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(
    mdPath,
    buildMarkdownReport({
      url,
      config,
      bucketSummary,
      results,
    }),
    'utf8',
  );

  console.log(
    JSON.stringify({
      json_report: jsonPath,
      markdown_report: mdPath,
      buckets: bucketSummary.length,
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
  buildInvokeBody,
  buildEndpoint,
  evaluateCase,
  loadCases,
  normalizeCase,
  parseArgs,
  summarizeResults,
};
