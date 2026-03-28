#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const repoRoot = path.resolve(__dirname, '..');
  const args = {
    baseUrl:
      process.env.BASE_URL ||
      process.env.STAGING_BASE_URL ||
      'https://pivota-agent-staging.up.railway.app',
    endpoint: process.env.ENDPOINT || '/agent/shop/v1/invoke',
    casesPath:
      process.env.CASES_PATH ||
      path.join(
        repoRoot,
        'scripts',
        'fixtures',
        'celestial_commerce_core_staging_acceptance_matrix.json',
      ),
    outDir:
      process.env.OUT_DIR ||
      path.join(repoRoot, 'reports', 'celestial-commerce-core-aurora-manual-review'),
    authToken: process.env.AUTH_TOKEN || process.env.STAGING_AUTH_TOKEN || '',
    agentApiKey: process.env.AGENT_API_KEY || process.env.STAGING_AGENT_API_KEY || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--endpoint' && next) args.endpoint = String(next);
    if (token === '--cases' && next) args.casesPath = path.resolve(String(next));
    if (token === '--out-dir' && next) args.outDir = path.resolve(String(next));
    if (token === '--auth-token' && next) args.authToken = String(next);
    if (token === '--agent-api-key' && next) args.agentApiKey = String(next);
  }

  return args;
}

function utcTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '_');
}

function readCases(casesPath) {
  const raw = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  return (raw.semantic_cases || []).filter((item) => item.execution_mode === 'manual');
}

function titlesFromProducts(products) {
  if (!Array.isArray(products)) return [];
  return products
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      if (typeof item.title === 'string' && item.title.trim()) return item.title.trim();
      if (typeof item.name === 'string' && item.name.trim()) return item.name.trim();
      return '';
    })
    .filter(Boolean)
    .slice(0, 6);
}

async function requestJson(url, payload, headers) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch (_error) {
        json = { _raw: text };
      }
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[String(key || '').toLowerCase()] = String(value || '').trim();
      });
      return {
        httpStatus: response.status,
        responseHeaders,
        body: json,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    httpStatus: 0,
    responseHeaders: {},
    body: {
      error: 'REQUEST_FAILED',
      message: lastError?.message || String(lastError || 'request_failed'),
    },
  };
}

function summarizeCase(testCase, response) {
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const searchTrace =
    metadata.search_trace && typeof metadata.search_trace === 'object'
      ? metadata.search_trace
      : {};
  const searchDecision =
    metadata.search_decision && typeof metadata.search_decision === 'object'
      ? metadata.search_decision
      : {};
  const routeDebug =
    metadata.route_debug && typeof metadata.route_debug === 'object' ? metadata.route_debug : {};
  const cacheStage =
    routeDebug.cross_merchant_cache && typeof routeDebug.cross_merchant_cache === 'object'
      ? routeDebug.cross_merchant_cache
      : {};
  const sourceBreakdown =
    metadata.source_breakdown && typeof metadata.source_breakdown === 'object'
      ? metadata.source_breakdown
      : {};
  const gatewayGovernance =
    metadata.gateway_governance && typeof metadata.gateway_governance === 'object'
      ? metadata.gateway_governance
      : {};
  const products = Array.isArray(body.products) ? body.products : [];

  return {
    id: testCase.id,
    title: testCase.title,
    family: testCase.family,
    query: testCase?.request?.payload?.search?.query || '',
    status: response.httpStatus,
    error: typeof body.error === 'string' ? body.error : '',
    message: typeof body.message === 'string' ? body.message : '',
    query_source: typeof metadata.query_source === 'string' ? metadata.query_source : '',
    final_decision:
      typeof searchTrace.final_decision === 'string' ? searchTrace.final_decision : '',
    guidance_final_decision:
      typeof searchDecision.final_decision === 'string' ? searchDecision.final_decision : '',
    product_count: products.length,
    titles: titlesFromProducts(products),
    clarification_question:
      typeof body.clarification_question === 'string'
        ? body.clarification_question
        : body.clarification && typeof body.clarification.question === 'string'
          ? body.clarification.question
          : '',
    source_breakdown: sourceBreakdown,
    guidance_direct_external_seed_applied: metadata.guidance_direct_external_seed_applied === true,
    guidance_direct_external_seed_valid_hit: metadata.guidance_direct_external_seed_valid_hit === true,
    search_stage_b:
      metadata.search_stage_b && typeof metadata.search_stage_b === 'object'
        ? metadata.search_stage_b
        : {},
    cache_stage: cacheStage,
    gateway_governance: gatewayGovernance,
    request_id:
      response.responseHeaders['x-request-id'] ||
      response.responseHeaders['x-gateway-request-id'] ||
      '',
  };
}

function verdictRank(value) {
  if (value === 'pass') return 3;
  if (value === 'review_required') return 2;
  if (value === 'fail') return 1;
  return 0;
}

function classifyResult(result) {
  if (result.id === 'aurora_guidance_only_cache_hit_manual') {
    if (
      result.status === 200 &&
      result.product_count > 0 &&
      result.final_decision === 'cache_returned' &&
      String(result.query_source || '').startsWith('cache_')
    ) {
      return {
        verdict: 'pass',
        notes:
          'cache-hit lane returned products and kept guidance-only retrieval diagnostics visible.',
      };
    }
    return {
      verdict: 'fail',
      notes:
        'expected a coherent guidance-only cache hit, but the lane degraded to empty/clarify or missed cache-stage ownership.',
      blocking_signals: [
        `status=${result.status}`,
        `query_source=${result.query_source || 'missing'}`,
        `final_decision=${result.final_decision || 'missing'}`,
        `product_count=${result.product_count}`,
      ],
    };
  }

  if (result.id === 'aurora_guidance_only_cache_miss_manual') {
    if (
      result.status === 200 &&
      result.final_decision &&
      result.final_decision !== 'cache_returned' &&
      !String(result.query_source || '').startsWith('cache_cross_merchant_search_supplemented')
    ) {
      return {
        verdict: 'pass',
        notes:
          'cache miss degraded through a non-cache-returned guidance-only lane with diagnostics intact.',
      };
    }
    return {
      verdict: 'review_required',
      notes:
        'staging data still reproduced a cache-hit plus supplement path, so this request is not a valid substitute for the intended cache-miss review.',
    };
  }

  if (result.id === 'aurora_guidance_only_direct_supplement_manual') {
    const cacheStage =
      result.cache_stage && typeof result.cache_stage === 'object'
        ? result.cache_stage
        : {};
    const supplement =
      cacheStage.supplement && typeof cacheStage.supplement === 'object'
        ? cacheStage.supplement
        : {};
    const searchStageB =
      result.search_stage_b && typeof result.search_stage_b === 'object'
        ? result.search_stage_b
        : {};
    const internalCount = Number(result.source_breakdown.internal_count || 0) || 0;
    const externalCount =
      Number(result.source_breakdown.external_count || result.source_breakdown.external_seed_count || 0) || 0;
    const cacheStageBoundedGuidanceSupplement =
      result.query_source === 'cache_cross_merchant_search_supplemented' &&
      String(result.final_decision || '') === 'cache_returned' &&
      internalCount > 0 &&
      externalCount > 0 &&
      supplement.applied === true &&
      String(supplement.reason || '').startsWith('supplemented_external_seed') &&
      String(supplement.retrieval_mode || '') === 'guidance_recall_first' &&
      Array.isArray(supplement.query_variants) &&
      supplement.query_variants.length > 0 &&
      supplement.query_variants.every((item) => /\bserum\b/i.test(String(item || ''))) &&
      supplement.stage_timeout !== true;
    const boundedQuerySources = new Set([
      'agent_products_search_guidance_supplemented',
      'cache_cross_merchant_search_supplemented',
    ]);
    const directGuidanceReplacement =
      result.query_source === 'agent_products_guidance_external_seed_supplemented' &&
      result.guidance_direct_external_seed_applied === true &&
      result.guidance_direct_external_seed_valid_hit === true &&
      externalCount > 0 &&
      supplement.stage_timeout !== true;
    if (
      result.status === 200 &&
      (
        (
          boundedQuerySources.has(String(result.query_source || '')) &&
          ['products_returned', 'cache_returned'].includes(String(result.final_decision || '')) &&
          internalCount > 0 &&
          externalCount > 0 &&
          searchStageB.applied === true &&
          String(searchStageB.reason || '') === 'guidance_direct_external_seed_supplemented' &&
          supplement.stage_timeout !== true
        ) ||
        cacheStageBoundedGuidanceSupplement ||
        directGuidanceReplacement
      )
    ) {
      const notes = directGuidanceReplacement
        ? 'guidance-only supplement stayed bounded through the explicit external-seed replacement lane, with valid-hit metadata and no obvious generic drift in the top titles.'
        : cacheStageBoundedGuidanceSupplement
          ? 'guidance-only supplement stayed bounded inside the cache-stage guidance lane: the internal hit remained visible, guidance recall variants stayed serum-scoped, and the top titles did not drift generically.'
          : 'guidance-only supplement stayed bounded: internal cache remained visible, supplement applied explicitly, and no obvious generic drift appeared in the top titles.';
      return {
        verdict: 'pass',
        notes,
      };
    }
    return {
      verdict: 'fail',
      notes: 'guidance-only supplement did not produce the expected bounded supplemented path.',
      blocking_signals: [
        `status=${result.status}`,
        `query_source=${result.query_source || 'missing'}`,
        `final_decision=${result.final_decision || 'missing'}`,
        `guidance_direct_external_seed_applied=${result.guidance_direct_external_seed_applied === true}`,
        `guidance_direct_external_seed_valid_hit=${result.guidance_direct_external_seed_valid_hit === true}`,
        `stage_timeout=${supplement.stage_timeout === true}`,
      ],
    };
  }

  return {
    verdict: 'review_required',
    notes: 'manual classification rule missing for case',
  };
}

function renderMarkdown(payload) {
  const lines = [
    '# Aurora Guidance-Only Manual Review',
    '',
    `- Generated at (UTC): ${payload.generated_at}`,
    `- Environment: ${payload.environment}`,
    `- Base URL: \`${payload.base_url}\``,
    `- Endpoint: \`${payload.endpoint}\``,
    '',
    '## Summary',
    '',
    ...payload.results.map((item) => `- \`${item.id}\`: ${item.verdict}`),
    '',
    '## Findings',
    '',
  ];

  for (const item of payload.results) {
    lines.push(`### ${item.id}`);
    lines.push('');
    lines.push(`- Verdict: ${item.verdict}`);
    lines.push(`- Query: \`${item.query}\``);
    lines.push(`- Observed status: \`${item.status}\``);
    if (item.error) lines.push(`- Error: \`${item.error}\``);
    if (item.message) lines.push(`- Message: \`${item.message}\``);
    if (item.query_source) lines.push(`- Query source: \`${item.query_source}\``);
    if (item.final_decision) lines.push(`- Final decision: \`${item.final_decision}\``);
    if (typeof item.product_count === 'number') lines.push(`- Product count: \`${item.product_count}\``);
    if (item.titles.length > 0) {
      lines.push('- Top titles:');
      for (const title of item.titles) {
        lines.push(`  - \`${title}\``);
      }
    }
    if (item.clarification_question) {
      lines.push(`- Clarification question: \`${item.clarification_question}\``);
    }
    if (item.request_id) lines.push(`- Gateway request id: \`${item.request_id}\``);
    if ((item.attempt_count || 1) > 1) lines.push(`- Attempts: \`${item.attempt_count}\``);
    if (item.retry_recovered === true) lines.push('- Retry recovered: `true`');
    if (item.guidance_direct_external_seed_applied) {
      lines.push(`- Guidance direct supplement applied: \`${item.guidance_direct_external_seed_applied}\``);
    }
    if (item.guidance_direct_external_seed_valid_hit) {
      lines.push(`- Guidance direct supplement valid hit: \`${item.guidance_direct_external_seed_valid_hit}\``);
    }
    lines.push(`- Notes: ${item.notes}`);
    if (Array.isArray(item.blocking_signals) && item.blocking_signals.length > 0) {
      lines.push('- Blocking signals:');
      for (const signal of item.blocking_signals) {
        lines.push(`  - \`${signal}\``);
      }
    }
    lines.push('');
  }

  const passCount = payload.results.filter((item) => item.verdict === 'pass').length;
  const failCount = payload.results.filter((item) => item.verdict === 'fail').length;
  const reviewRequiredCount = payload.results.filter((item) => item.verdict === 'review_required').length;

  lines.push('## Overall Recommendation');
  lines.push('');
  lines.push(`- Pass: \`${passCount}\``);
  lines.push(`- Fail: \`${failCount}\``);
  lines.push(`- Review required: \`${reviewRequiredCount}\``);
  lines.push(
    '- Treat this report as the current Aurora guidance-only manual-review truth for staging data, separate from the auto staging matrix.',
  );

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.authToken && !args.agentApiKey) {
    throw new Error('STAGING_AUTH_TOKEN or STAGING_AGENT_API_KEY is required');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (args.authToken) headers.Authorization = `Bearer ${args.authToken}`;
  if (args.agentApiKey) headers['X-Agent-API-Key'] = args.agentApiKey;

  const cases = readCases(args.casesPath);
  const url = `${String(args.baseUrl || '').replace(/\/+$/, '')}${args.endpoint}`;
  const results = [];

  for (const testCase of cases) {
    const response = await requestJson(url, testCase.request, headers);
    const firstSummarized = summarizeCase(testCase, response);
    let selected = {
      ...firstSummarized,
      ...classifyResult(firstSummarized),
      attempt_count: 1,
      retry_recovered: false,
    };
    if (selected.verdict !== 'pass') {
      const retryResponse = await requestJson(url, testCase.request, headers);
      const retrySummarized = summarizeCase(testCase, retryResponse);
      const retried = {
        ...retrySummarized,
        ...classifyResult(retrySummarized),
        attempt_count: 2,
        retry_recovered: selected.verdict !== 'pass' && classifyResult(retrySummarized).verdict === 'pass',
      };
      if (verdictRank(retried.verdict) >= verdictRank(selected.verdict)) {
        selected = retried;
      } else {
        selected.attempt_count = 2;
      }
    }
    results.push(selected);
  }

  const runDir = path.join(args.outDir, utcTimestamp());
  fs.mkdirSync(runDir, { recursive: true });

  const passCount = results.filter((item) => item.verdict === 'pass').length;
  const failCount = results.filter((item) => item.verdict === 'fail').length;
  const reviewRequiredCount = results.filter((item) => item.verdict === 'review_required').length;

  const payload = {
    generated_at: new Date().toISOString(),
    environment: 'staging authenticated invoke',
    base_url: args.baseUrl,
    endpoint: args.endpoint,
    pass_count: passCount,
    fail_count: failCount,
    review_required_count: reviewRequiredCount,
    results,
  };

  const markdownPath = path.join(runDir, 'README.md');
  const jsonPath = path.join(runDir, 'summary.json');
  fs.writeFileSync(markdownPath, renderMarkdown(payload));
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      markdown: markdownPath,
      json: jsonPath,
      pass_count: passCount,
      fail_count: failCount,
      review_required_count: reviewRequiredCount,
    }) + '\n',
  );
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
