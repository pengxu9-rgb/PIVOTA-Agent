#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');

function parseArgs(argv) {
  const args = {
    baseUrl:
      process.env.CELESTIAL_COMMERCE_STAGING_BASE_URL ||
      process.env.SEARCH_MATRIX_BASE_URL ||
      'https://pivota-agent-staging.up.railway.app',
    cases:
      process.env.CELESTIAL_COMMERCE_STAGING_MATRIX_CASES ||
      path.join(
        __dirname,
        'fixtures',
        'celestial_commerce_core_staging_acceptance_matrix.json',
      ),
    outDir:
      process.env.CELESTIAL_COMMERCE_STAGING_MATRIX_OUT_DIR ||
      path.join(__dirname, '..', 'reports', 'celestial-commerce-staging-matrix'),
    timeoutMs: Number(process.env.CELESTIAL_COMMERCE_STAGING_TIMEOUT_MS || 15000),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--cases' && next) args.cases = String(next);
    if (token === '--out-dir' && next) args.outDir = String(next);
    if (token === '--timeout-ms' && next) {
      args.timeoutMs = Math.max(500, Number(next) || 15000);
    }
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

function valuesEqual(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    return Number(left) === Number(right);
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Boolean(left) === Boolean(right);
  }
  return String(left) === String(right);
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      String(key || '').toLowerCase(),
      String(value == null ? '' : value),
    ]),
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value == null ? '' : value).trim();
    if (normalized) return normalized;
  }
  return '';
}

function toEnvKey(input) {
  const normalized = String(input || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || 'DEFAULT';
}

function resolveCaseAuth(testCase = {}) {
  const requiresAuth = testCase.requires_auth === true;
  const profile = String(testCase.auth_profile || 'default').trim() || 'default';
  if (!requiresAuth) {
    return {
      requiresAuth,
      profile,
      headers: {},
      missing: false,
    };
  }

  const profileEnvKey = toEnvKey(profile);
  const token = firstNonEmpty(
    process.env[`CELESTIAL_COMMERCE_STAGING_${profileEnvKey}_AUTH_TOKEN`],
    process.env[`STAGING_${profileEnvKey}_AUTH_TOKEN`],
    profileEnvKey === 'DEFAULT' ? process.env.CELESTIAL_COMMERCE_STAGING_AUTH_TOKEN : '',
    profileEnvKey === 'DEFAULT' ? process.env.STAGING_AUTH_TOKEN : '',
    profileEnvKey === 'DEFAULT'
      ? process.env.CELESTIAL_COMMERCE_STAGING_DEFAULT_AUTH_TOKEN
      : '',
    profileEnvKey === 'DEFAULT' ? process.env.STAGING_DEFAULT_AUTH_TOKEN : '',
  );
  const agentApiKey = firstNonEmpty(
    process.env[`CELESTIAL_COMMERCE_STAGING_${profileEnvKey}_AGENT_API_KEY`],
    process.env[`STAGING_${profileEnvKey}_AGENT_API_KEY`],
    profileEnvKey === 'DEFAULT' ? process.env.CELESTIAL_COMMERCE_STAGING_AGENT_API_KEY : '',
    profileEnvKey === 'DEFAULT' ? process.env.STAGING_AGENT_API_KEY : '',
    profileEnvKey === 'DEFAULT'
      ? process.env.CELESTIAL_COMMERCE_STAGING_DEFAULT_AGENT_API_KEY
      : '',
    profileEnvKey === 'DEFAULT' ? process.env.STAGING_DEFAULT_AGENT_API_KEY : '',
  );

  const headers = {};
  if (token) headers.Authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  if (agentApiKey) headers['X-Agent-API-Key'] = agentApiKey;

  return {
    requiresAuth,
    profile,
    headers,
    missing: Object.keys(headers).length === 0,
  };
}

function getPath(obj, rawPath) {
  const pathText = String(rawPath || '').trim();
  if (!pathText) return undefined;
  return pathText
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => {
      if (acc == null) return undefined;
      if (Array.isArray(acc)) {
        const index = Number(key);
        return Number.isInteger(index) ? acc[index] : undefined;
      }
      if (typeof acc === 'object') return acc[key];
      return undefined;
    }, obj);
}

function normalizeTitles(products) {
  return (Array.isArray(products) ? products : [])
    .map((item) => String(item?.title || item?.name || '').trim())
    .filter(Boolean);
}

function collectReasonCodes(body = {}) {
  const nestedReasonCodes = []
    .concat(Array.isArray(body?.reason_codes) ? body.reason_codes : [])
    .concat(
      Array.isArray(body?.metadata?.reason_codes) ? body.metadata.reason_codes : [],
      Array.isArray(body?.metadata?.gateway_governance?.reason_codes)
        ? body.metadata.gateway_governance.reason_codes
        : [],
      Array.isArray(body?.metadata?.gateway_governance?.query_governance?.reason_codes)
        ? body.metadata.gateway_governance.query_governance.reason_codes
        : [],
    );
  return Array.from(new Set(nestedReasonCodes.map((item) => String(item || '').trim()).filter(Boolean)));
}

function inferOutcomeKind(body = {}) {
  const products = Array.isArray(body?.products) ? body.products : [];
  const finalDecision = String(
    body?.metadata?.search_trace?.final_decision ||
      body?.metadata?.search_decision?.final_decision ||
      '',
  ).trim();
  if (products.length > 0) return 'products_nonempty';
  if (body?.clarification && typeof body.clarification === 'object' && body.clarification.question) {
    return 'clarify';
  }
  if (body?.metadata?.strict_empty === true || finalDecision === 'strict_empty') {
    return 'strict_empty';
  }
  if (Array.isArray(body?.products)) return 'products_empty';
  return 'unknown';
}

function assessPrimaryPath(body = {}) {
  const metadata =
    body && typeof body === 'object' && body.metadata && typeof body.metadata === 'object'
      ? body.metadata
      : {};
  const routeHealth =
    metadata.route_health &&
    typeof metadata.route_health === 'object' &&
    !Array.isArray(metadata.route_health)
      ? metadata.route_health
      : {};
  const proxySearchFallback =
    metadata.proxy_search_fallback &&
    typeof metadata.proxy_search_fallback === 'object' &&
    !Array.isArray(metadata.proxy_search_fallback)
      ? metadata.proxy_search_fallback
      : {};

  const querySource = String(metadata.query_source || '').trim();
  const primaryPathUsed = String(routeHealth.primary_path_used || '').trim();
  const fallbackReason = String(
    routeHealth.fallback_reason || proxySearchFallback.reason || '',
  ).trim();
  const reasons = [];

  if (
    querySource === 'agent_products_error_fallback' ||
    querySource === 'agent_products_resolver_fallback' ||
    querySource === 'agent_products_resolver_ref_fallback'
  ) {
    reasons.push(`query_source=${querySource}`);
  }

  if (proxySearchFallback.applied === true) {
    reasons.push('proxy_search_fallback.applied=true');
  }

  if (routeHealth.fallback_triggered === true) {
    reasons.push('route_health.fallback_triggered=true');
  }

  if (primaryPathUsed && /(fallback|primary_unusable)/i.test(primaryPathUsed)) {
    reasons.push(`route_health.primary_path_used=${primaryPathUsed}`);
  }

  if (fallbackReason) {
    reasons.push(`fallback_reason=${fallbackReason}`);
  }

  return {
    degraded: reasons.length > 0,
    reasons: Array.from(new Set(reasons)),
    querySource: querySource || null,
    primaryPathUsed: primaryPathUsed || null,
    fallbackReason: fallbackReason || null,
  };
}

function normalizeCase(rawCase = {}, kind) {
  const hasExplicitTimeout =
    rawCase && typeof rawCase === 'object'
      ? Object.prototype.hasOwnProperty.call(rawCase, 'timeout_ms') ||
        Object.prototype.hasOwnProperty.call(rawCase, 'timeoutMs')
      : false;
  const normalizedTimeoutMs = hasExplicitTimeout
    ? Math.max(500, Number(rawCase.timeout_ms ?? rawCase.timeoutMs) || 0)
    : null;
  return {
    kind,
    id: String(rawCase.id || '').trim(),
    title: String(rawCase.title || rawCase.id || '').trim(),
    family: String(rawCase.family || '').trim() || 'uncategorized',
    blocking: rawCase.blocking !== false,
    execution_mode: String(rawCase.execution_mode || 'live').trim() || 'live',
    endpoint: String(rawCase.endpoint || '').trim() || (kind === 'governance' ? '/agent/shop/v1/invoke' : '/api/gateway'),
    requires_auth: rawCase.requires_auth === true,
    auth_profile: String(rawCase.auth_profile || 'default').trim() || 'default',
    timeout_ms: normalizedTimeoutMs || null,
    headers:
      rawCase.headers && typeof rawCase.headers === 'object' && !Array.isArray(rawCase.headers)
        ? { ...rawCase.headers }
        : {},
    request:
      rawCase.request && typeof rawCase.request === 'object' && !Array.isArray(rawCase.request)
        ? rawCase.request
        : {},
    correctness:
      rawCase.correctness && typeof rawCase.correctness === 'object' && !Array.isArray(rawCase.correctness)
        ? rawCase.correctness
        : {},
    ownership:
      rawCase.ownership && typeof rawCase.ownership === 'object' && !Array.isArray(rawCase.ownership)
        ? rawCase.ownership
        : {},
    observability:
      rawCase.observability &&
      typeof rawCase.observability === 'object' &&
      !Array.isArray(rawCase.observability)
        ? rawCase.observability
        : {},
    manual_review:
      rawCase.manual_review &&
      typeof rawCase.manual_review === 'object' &&
      !Array.isArray(rawCase.manual_review)
        ? rawCase.manual_review
        : {},
  };
}

function loadCases(matrixPath) {
  const fullPath = path.resolve(matrixPath);
  const payload = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const semanticCases = Array.isArray(payload.semantic_cases)
    ? payload.semantic_cases.map((item) => normalizeCase(item, 'semantic')).filter((item) => item.id)
    : [];
  const governanceCases = Array.isArray(payload.governance_cases)
    ? payload.governance_cases
        .map((item) => normalizeCase(item, 'governance'))
        .filter((item) => item.id)
    : [];
  return {
    matrixPath: fullPath,
    cases: [...semanticCases, ...governanceCases],
  };
}

function evaluateRuleSet(ruleSet = {}, context = {}) {
  const reasons = [];
  const body = context.body || {};
  const headers = context.headers || {};
  const reasonCodes = context.reasonCodes || [];

  const mustHavePaths = Array.isArray(ruleSet.must_have_paths) ? ruleSet.must_have_paths : [];
  for (const rawPath of mustHavePaths) {
    const value = getPath(body, rawPath);
    const missing =
      value == null || (typeof value === 'string' && String(value).trim().length === 0);
    if (missing) reasons.push(`missing_path:${rawPath}`);
  }

  const mustEqualPaths =
    ruleSet.must_equal_paths && typeof ruleSet.must_equal_paths === 'object'
      ? ruleSet.must_equal_paths
      : {};
  for (const [rawPath, expected] of Object.entries(mustEqualPaths)) {
    const actual = getPath(body, rawPath);
    if (!valuesEqual(actual, expected)) {
      reasons.push(
        `path_mismatch:${rawPath}:expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  const mustOneOfPaths =
    ruleSet.must_one_of_paths && typeof ruleSet.must_one_of_paths === 'object'
      ? ruleSet.must_one_of_paths
      : {};
  for (const [rawPath, expectedValues] of Object.entries(mustOneOfPaths)) {
    const candidates = Array.isArray(expectedValues) ? expectedValues : [expectedValues];
    const actual = getPath(body, rawPath);
    const matched = candidates.some((expected) => valuesEqual(actual, expected));
    if (!matched) {
      reasons.push(
        `path_not_in_set:${rawPath}:expected=${JSON.stringify(candidates)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  const mustBePositivePaths = Array.isArray(ruleSet.must_be_positive_paths)
    ? ruleSet.must_be_positive_paths
    : [];
  for (const rawPath of mustBePositivePaths) {
    const actual = getPath(body, rawPath);
    if (!(Number(actual) > 0)) {
      reasons.push(`path_not_positive:${rawPath}:actual=${JSON.stringify(actual)}`);
    }
  }

  const mustHaveHeaders = Array.isArray(ruleSet.must_have_headers) ? ruleSet.must_have_headers : [];
  for (const rawHeader of mustHaveHeaders) {
    const headerKey = String(rawHeader || '').toLowerCase();
    const value = headers[headerKey];
    if (!String(value || '').trim()) reasons.push(`missing_header:${headerKey}`);
  }

  const mustEqualHeaders =
    ruleSet.must_equal_headers && typeof ruleSet.must_equal_headers === 'object'
      ? ruleSet.must_equal_headers
      : {};
  for (const [rawHeader, expected] of Object.entries(mustEqualHeaders)) {
    const headerKey = String(rawHeader || '').toLowerCase();
    const actual = headers[headerKey];
    if (!valuesEqual(actual, expected)) {
      reasons.push(
        `header_mismatch:${headerKey}:expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  const requiredReasonCodes = Array.isArray(ruleSet.must_have_reason_codes)
    ? ruleSet.must_have_reason_codes
    : [];
  for (const code of requiredReasonCodes) {
    const token = String(code || '').trim();
    if (token && !reasonCodes.includes(token)) reasons.push(`missing_reason_code:${token}`);
  }

  return {
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
  };
}

function evaluateCorrectness(ruleSet = {}, context = {}) {
  const reasons = [];
  const response = context.response || {};
  const body = context.body || {};
  const reasonCodes = context.reasonCodes || [];
  const products = Array.isArray(body?.products) ? body.products : [];
  const titles = normalizeTitles(products);
  const outcomeKind = inferOutcomeKind(body);
  const primaryPath = assessPrimaryPath(body);

  const expectedStatus =
    ruleSet.expect_http_status == null ? null : Number(ruleSet.expect_http_status);
  if (expectedStatus != null && Number(response.status) !== expectedStatus) {
    reasons.push(`http_status_mismatch:expected=${expectedStatus} actual=${response.status}`);
  }

  if (ruleSet.allow_zero_results === false && products.length === 0) {
    reasons.push('expected_non_empty_results');
  }

  if (typeof ruleSet.must_have_clarification === 'boolean') {
    const hasClarification = Boolean(
      body?.clarification &&
        typeof body.clarification === 'object' &&
        String(body.clarification.question || '').trim(),
    );
    if (hasClarification !== ruleSet.must_have_clarification) {
      reasons.push(
        `clarification_mismatch:expected=${JSON.stringify(
          ruleSet.must_have_clarification,
        )} actual=${JSON.stringify(hasClarification)}`,
      );
    }
  }

  const mustHaveReasonCodes = Array.isArray(ruleSet.must_have_reason_codes)
    ? ruleSet.must_have_reason_codes
    : [];
  for (const rawCode of mustHaveReasonCodes) {
    const token = String(rawCode || '').trim();
    if (token && !reasonCodes.includes(token)) reasons.push(`missing_reason_code:${token}`);
  }

  if (ruleSet.require_primary_path === true && primaryPath.degraded) {
    reasons.push(`primary_path_degraded:${primaryPath.reasons.join(',')}`);
  }

  const mustReturnOneOfTitles = Array.isArray(ruleSet.must_return_one_of_titles)
    ? ruleSet.must_return_one_of_titles
    : [];
  if (mustReturnOneOfTitles.length > 0) {
    const matched = mustReturnOneOfTitles.some((candidate) => {
      const normalizedCandidate = normalizeText(candidate);
      return normalizedCandidate
        ? titles.some((title) => normalizeText(title).includes(normalizedCandidate))
        : false;
    });
    if (!matched) {
      reasons.push(`missing_required_title:${mustReturnOneOfTitles.join(' | ')}`);
    }
  }

  const outcomeIn = Array.isArray(ruleSet.outcome_in) ? ruleSet.outcome_in : [];
  if (outcomeIn.length > 0 && !outcomeIn.includes(outcomeKind)) {
    reasons.push(
      `outcome_mismatch:expected=${JSON.stringify(outcomeIn)} actual=${JSON.stringify(outcomeKind)}`,
    );
  }

  const nestedRuleSet = {
    must_have_paths: ruleSet.must_have_paths,
    must_equal_paths: ruleSet.must_equal_paths,
    must_one_of_paths: ruleSet.must_one_of_paths,
    must_be_positive_paths: ruleSet.must_be_positive_paths,
  };
  const nested = evaluateRuleSet(nestedRuleSet, context);
  reasons.push(...nested.reasons);

  if (reasons.length > 0) {
    return { status: 'fail', reasons };
  }

  if (String(ruleSet.mode || '').trim() === 'manual') {
    return {
      status: 'review_required',
      reasons: [
        String(ruleSet.manual_reason || '').trim() ||
          'manual_result_review_required_for_staging_case',
      ],
    };
  }

  return { status: 'pass', reasons: [] };
}

function computeOverallStatus(sections = []) {
  if (sections.some((item) => item.status === 'fail')) return 'fail';
  if (sections.some((item) => item.status === 'review_required')) return 'review_required';
  return 'pass';
}

function detectStagingInfraBlock(response = {}) {
  const status = Number(response.status || 0);
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  const errorCode = String(body.error || '').trim();
  if (status === 503 && errorCode === 'AUTH_INTROSPECT_UNAVAILABLE') {
    return {
      outcome_kind: 'staging_auth_introspect_unavailable',
      reason: 'staging_auth_introspect_unavailable',
      manual_review: {
        expected_outcome:
          'Restore staging auth introspection availability, then rerun live acceptance for this case.',
        notes:
          'The request reached staging, but auth introspection returned AUTH_INTROSPECT_UNAVAILABLE before the owned commerce flow executed.',
      },
    };
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeLiveCase(baseUrl, testCase, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, '')}${String(testCase.endpoint || '').trim()}`;
  try {
    const auth = resolveCaseAuth(testCase);
    const response = await axios.post(url, testCase.request, {
      timeout: timeoutMs,
      validateStatus: () => true,
      headers: {
        'Content-Type': 'application/json',
        ...(auth.headers || {}),
        ...(testCase.headers || {}),
      },
    });
    return {
      ok: true,
      url,
      response: {
        status: Number(response.status || 0),
        headers: normalizeHeaders(response.headers),
        body:
          response.data && typeof response.data === 'object' && !Array.isArray(response.data)
            ? response.data
            : {},
      },
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: String(error?.message || error),
      response: {
        status: 0,
        headers: {},
        body: {},
      },
    };
  }
}

function buildLiveFailureResult(testCase, authProfile, execution) {
  return {
    id: testCase.id,
    title: testCase.title,
    family: testCase.family,
    kind: testCase.kind,
    blocking: testCase.blocking,
    execution_mode: 'live',
    auth_profile: authProfile,
    correctness: { status: 'fail', reasons: [`request_error:${execution.error}`] },
    ownership: { status: 'fail', reasons: ['request_error_prevented_ownership_check'] },
    observability: { status: 'fail', reasons: ['request_error_prevented_observability_check'] },
    overall_status: 'fail',
    url: execution.url,
    http_status: 0,
    outcome_kind: 'request_error',
    reason_codes: [],
    response_excerpt: {},
    request: testCase.request,
    error: execution.error,
  };
}

function buildLiveCaseResult(testCase, authProfile, execution) {
  if (!execution.ok) {
    return buildLiveFailureResult(testCase, authProfile, execution);
  }

  const body = execution.response.body;
  const headers = execution.response.headers;
  const infraBlock = detectStagingInfraBlock(execution.response);
  if (infraBlock) {
    return {
      id: testCase.id,
      title: testCase.title,
      family: testCase.family,
      kind: testCase.kind,
      blocking: testCase.blocking,
      execution_mode: 'live',
      auth_profile: authProfile,
      correctness: { status: 'review_required', reasons: [infraBlock.reason] },
      ownership: {
        status: 'review_required',
        reasons: ['staging_infra_blocked_prevented_ownership_check'],
      },
      observability: {
        status: 'review_required',
        reasons: ['staging_infra_blocked_prevented_observability_check'],
      },
      overall_status: 'review_required',
      url: execution.url,
      http_status: execution.response.status,
      outcome_kind: infraBlock.outcome_kind,
      reason_codes: [],
      response_excerpt: {
        error: String(body.error || '').trim() || null,
        message: String(body.message || '').trim() || null,
      },
      response_headers: {
        invocation_surface: headers['x-gateway-invocation-surface'] || null,
        governance_mode: headers['x-gateway-governance-mode'] || null,
        governance_observed_action: headers['x-gateway-governance-observed-action'] || null,
        governance_would_enforce: headers['x-gateway-governance-would-enforce'] || null,
        auth_degraded: headers['x-invoke-auth-degraded'] || null,
        auth_degraded_reason: headers['x-invoke-auth-degraded-reason'] || null,
        introspect_auth_source: headers['x-invoke-introspect-auth-source'] || null,
      },
      manual_review: infraBlock.manual_review,
      request: testCase.request,
    };
  }

  const reasonCodes = collectReasonCodes(body);
  const primaryPath = assessPrimaryPath(body);
  const context = {
    response: execution.response,
    body,
    headers,
    reasonCodes,
  };
  const correctness = evaluateCorrectness(testCase.correctness, context);
  const ownership = evaluateRuleSet(testCase.ownership, context);
  const observability = evaluateRuleSet(testCase.observability, context);
  const overall_status = computeOverallStatus([correctness, ownership, observability]);

  return {
    id: testCase.id,
    title: testCase.title,
    family: testCase.family,
    kind: testCase.kind,
    blocking: testCase.blocking,
    execution_mode: 'live',
    auth_profile: authProfile,
    correctness,
    ownership,
    observability,
    overall_status,
    url: execution.url,
    http_status: execution.response.status,
    outcome_kind: inferOutcomeKind(body),
    reason_codes: reasonCodes,
    response_excerpt: {
      query_source: getPath(body, 'metadata.query_source') || null,
      final_decision:
        getPath(body, 'metadata.search_trace.final_decision') ||
        getPath(body, 'metadata.search_decision.final_decision') ||
        null,
      invocation_surface: getPath(body, 'metadata.gateway_invocation.surface') || null,
      governance_mode: getPath(body, 'metadata.gateway_governance.mode') || null,
      governance_observed_action:
        getPath(body, 'metadata.gateway_governance.observed_action') || null,
      contract_path: getPath(body, 'metadata.contract_bridge.resolved_contract') || null,
      strict_constraint_reason: getPath(body, 'metadata.strict_constraint_reason') || null,
      auth_degraded: getPath(body, 'metadata.gateway_invocation.auth_degraded') === true,
      auth_degraded_reason:
        getPath(body, 'metadata.gateway_invocation.auth_degraded_reason') || null,
      introspect_auth_source:
        getPath(body, 'metadata.gateway_invocation.introspect_auth_source') || null,
      primary_path_degraded: primaryPath.degraded,
      primary_path_used: primaryPath.primaryPathUsed,
      primary_path_degraded_reasons: primaryPath.reasons,
      product_count: Array.isArray(body?.products) ? body.products.length : 0,
      clarification_question: getPath(body, 'clarification.question') || null,
    },
    response_headers: {
      invocation_surface: headers['x-gateway-invocation-surface'] || null,
      governance_mode: headers['x-gateway-governance-mode'] || null,
      governance_observed_action: headers['x-gateway-governance-observed-action'] || null,
      governance_would_enforce: headers['x-gateway-governance-would-enforce'] || null,
      auth_degraded: headers['x-invoke-auth-degraded'] || null,
      auth_degraded_reason: headers['x-invoke-auth-degraded-reason'] || null,
      introspect_auth_source: headers['x-invoke-introspect-auth-source'] || null,
    },
    request: testCase.request,
  };
}

async function runCase(baseUrl, testCase, timeoutMs) {
  const effectiveTimeoutMs = Math.max(
    500,
    Number(testCase.timeout_ms || 0) || Number(timeoutMs || 15000) || 15000,
  );
  const retryCount = Math.max(
    0,
    Number(
      testCase.retry_count == null ? (testCase.blocking ? 1 : 0) : testCase.retry_count,
    ) || 0,
  );
  if (testCase.execution_mode === 'manual') {
    return {
      id: testCase.id,
      title: testCase.title,
      family: testCase.family,
      kind: testCase.kind,
      blocking: testCase.blocking,
      execution_mode: 'manual',
      correctness: {
        status: 'review_required',
        reasons: [
          String(testCase.manual_review.expected_outcome || '').trim() ||
            'manual_review_required',
        ],
      },
      ownership: {
        status: 'review_required',
        reasons: ['manual_ownership_review_required'],
      },
      observability: {
        status: 'review_required',
        reasons: ['manual_observability_review_required'],
      },
      overall_status: 'review_required',
      url: `${baseUrl.replace(/\/+$/, '')}${String(testCase.endpoint || '').trim()}`,
      http_status: null,
      outcome_kind: 'manual_review',
      reason_codes: [],
      response_excerpt: {},
      manual_review: testCase.manual_review,
      request: testCase.request,
    };
  }

  const auth = resolveCaseAuth(testCase);
  if (auth.missing) {
    const reason = `missing_staging_auth_profile:${auth.profile}`;
    return {
      id: testCase.id,
      title: testCase.title,
      family: testCase.family,
      kind: testCase.kind,
      blocking: testCase.blocking,
      execution_mode: 'live',
      auth_profile: auth.profile,
      correctness: { status: 'review_required', reasons: [reason] },
      ownership: { status: 'review_required', reasons: [reason] },
      observability: { status: 'review_required', reasons: [reason] },
      overall_status: 'review_required',
      url: `${baseUrl.replace(/\/+$/, '')}${String(testCase.endpoint || '').trim()}`,
      http_status: null,
      outcome_kind: 'staging_auth_missing',
      reason_codes: [],
      response_excerpt: {},
      response_headers: {},
      manual_review: {
        expected_outcome: `Provide staging auth for profile "${auth.profile}" and rerun the live acceptance case.`,
        notes:
          'Use STAGING_AUTH_TOKEN / STAGING_AGENT_API_KEY for the default profile, or STAGING_<PROFILE>_AUTH_TOKEN / STAGING_<PROFILE>_AGENT_API_KEY for named governance profiles.',
      },
      request: testCase.request,
    };
  }

  let execution = await executeLiveCase(baseUrl, testCase, effectiveTimeoutMs);
  let result = buildLiveCaseResult(testCase, auth.profile, execution);
  const attemptHistory = [];

  for (let attempt = 1; attempt <= retryCount && result.overall_status === 'fail'; attempt += 1) {
    attemptHistory.push({
      attempt,
      overall_status: result.overall_status,
      outcome_kind: result.outcome_kind,
      http_status: result.http_status,
      correctness_reasons: result.correctness?.reasons || [],
      ownership_reasons: result.ownership?.reasons || [],
      observability_reasons: result.observability?.reasons || [],
      error: result.error || null,
    });
    await sleep(250);
    execution = await executeLiveCase(baseUrl, testCase, effectiveTimeoutMs);
    result = buildLiveCaseResult(testCase, auth.profile, execution);
  }

  result.attempt_count = 1 + attemptHistory.length;
  if (attemptHistory.length > 0) result.attempt_history = attemptHistory;
  if (attemptHistory.length > 0 && result.overall_status !== 'fail') {
    result.retry_recovered = true;
  }

  return result;
}

function buildSummary(results = [], args = {}, matrixPath = '') {
  const infraBlockedResults = results.filter(
    (item) =>
      item.execution_mode === 'live' &&
      item.overall_status === 'review_required' &&
      String(item.outcome_kind || '').startsWith('staging_'),
  );
  const summary = {
    generated_at: new Date().toISOString(),
    base_url: args.baseUrl,
    cases_path: matrixPath,
    total_cases: results.length,
    live_cases: results.filter((item) => item.execution_mode === 'live').length,
    manual_cases: results.filter((item) => item.execution_mode === 'manual').length,
    pass_count: results.filter((item) => item.overall_status === 'pass').length,
    fail_count: results.filter((item) => item.overall_status === 'fail').length,
    review_required_count: results.filter((item) => item.overall_status === 'review_required').length,
    infra_blocked_count: infraBlockedResults.length,
    auth_degraded_count: results.filter(
      (item) =>
        item.response_headers?.auth_degraded === 'true' ||
        item.response_excerpt?.auth_degraded === true,
    ).length,
    primary_path_degraded_count: results.filter(
      (item) => item.response_excerpt?.primary_path_degraded === true,
    ).length,
    retry_recovered_count: results.filter((item) => item.retry_recovered === true).length,
    blocking_failures: results.filter((item) => item.blocking && item.overall_status === 'fail').length,
    correctness: {
      pass: results.filter((item) => item.correctness.status === 'pass').length,
      fail: results.filter((item) => item.correctness.status === 'fail').length,
      review_required: results.filter((item) => item.correctness.status === 'review_required').length,
    },
    ownership: {
      pass: results.filter((item) => item.ownership.status === 'pass').length,
      fail: results.filter((item) => item.ownership.status === 'fail').length,
      review_required: results.filter((item) => item.ownership.status === 'review_required').length,
    },
    observability: {
      pass: results.filter((item) => item.observability.status === 'pass').length,
      fail: results.filter((item) => item.observability.status === 'fail').length,
      review_required: results.filter((item) => item.observability.status === 'review_required').length,
    },
    by_family: {},
  };

  for (const item of results) {
    if (!summary.by_family[item.family]) {
      summary.by_family[item.family] = {
        total: 0,
        pass: 0,
        fail: 0,
        review_required: 0,
      };
    }
    const bucket = summary.by_family[item.family];
    bucket.total += 1;
    if (item.overall_status === 'pass') bucket.pass += 1;
    if (item.overall_status === 'fail') bucket.fail += 1;
    if (item.overall_status === 'review_required') bucket.review_required += 1;
  }

  return summary;
}

function writeArtifacts(outDir, summary, results) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'celestial_commerce_core_staging_matrix.json');
  const markdownPath = path.join(outDir, 'celestial_commerce_core_staging_matrix.md');

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        summary,
        results,
      },
      null,
      2,
    ),
    'utf8',
  );

  const lines = [
    '# Celestial Commerce Core Staging Acceptance Matrix',
    '',
    `- Generated at: ${summary.generated_at}`,
    `- Base URL: ${summary.base_url}`,
    `- Cases file: \`${summary.cases_path}\``,
    `- Total cases: ${summary.total_cases}`,
    `- Pass: ${summary.pass_count}`,
    `- Fail: ${summary.fail_count}`,
    `- Review required: ${summary.review_required_count}`,
    `- Infra blocked: ${summary.infra_blocked_count || 0}`,
    `- Auth degraded: ${summary.auth_degraded_count || 0}`,
    `- Primary path degraded: ${summary.primary_path_degraded_count || 0}`,
    `- Retry recovered: ${summary.retry_recovered_count || 0}`,
    `- Blocking failures: ${summary.blocking_failures}`,
    '',
    '## Section Summary',
    '',
    '| Section | Pass | Fail | Review required |',
    '| --- | ---: | ---: | ---: |',
    `| Correctness | ${summary.correctness.pass} | ${summary.correctness.fail} | ${summary.correctness.review_required} |`,
    `| Ownership | ${summary.ownership.pass} | ${summary.ownership.fail} | ${summary.ownership.review_required} |`,
    `| Observability | ${summary.observability.pass} | ${summary.observability.fail} | ${summary.observability.review_required} |`,
    '',
    '## Cases',
    '',
    '| Case | Family | Mode | Overall | Correctness | Ownership | Observability | Outcome |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(
      (item) =>
        `| ${item.id} | ${item.family} | ${item.execution_mode} | ${item.overall_status} | ${item.correctness.status} | ${item.ownership.status} | ${item.observability.status} | ${item.outcome_kind} |`,
    ),
    '',
    '## Notes',
    '',
  ];

  for (const item of results) {
    lines.push(`### ${item.id}`);
    lines.push('');
    lines.push(`- Title: ${item.title}`);
    lines.push(`- Family: ${item.family}`);
    lines.push(`- Overall: ${item.overall_status}`);
    if (item.http_status != null) lines.push(`- HTTP status: ${item.http_status}`);
    if (item.url) lines.push(`- URL: \`${item.url}\``);
    if (item.attempt_count != null) lines.push(`- Attempts: ${item.attempt_count}`);
    if (item.retry_recovered === true) lines.push(`- Retry recovered: true`);
    if (item.response_excerpt && Object.keys(item.response_excerpt).length > 0) {
      lines.push(`- Response excerpt: \`${JSON.stringify(item.response_excerpt)}\``);
    }
    if (item.correctness.reasons.length > 0) {
      lines.push(`- Correctness notes: ${item.correctness.reasons.join('; ')}`);
    }
    if (item.ownership.reasons.length > 0) {
      lines.push(`- Ownership notes: ${item.ownership.reasons.join('; ')}`);
    }
    if (item.observability.reasons.length > 0) {
      lines.push(`- Observability notes: ${item.observability.reasons.join('; ')}`);
    }
    if (item.manual_review && Object.keys(item.manual_review).length > 0) {
      lines.push(`- Manual review: ${JSON.stringify(item.manual_review)}`);
    }
    lines.push('');
  }

  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, markdownPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadCases(args.cases);
  const results = [];
  for (const testCase of loaded.cases) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runCase(args.baseUrl, testCase, args.timeoutMs));
  }
  const summary = buildSummary(results, args, loaded.matrixPath);
  const { jsonPath, markdownPath } = writeArtifacts(path.resolve(args.outDir), summary, results);
  const payload = {
    ok: summary.blocking_failures === 0,
    summary,
    json_path: jsonPath,
    markdown_path: markdownPath,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.ok) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)}\n`,
  );
  process.exit(1);
});
