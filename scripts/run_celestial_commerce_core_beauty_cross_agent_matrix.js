#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  loadBeautyCrossAgentCases,
} = require('./lib/commerce_shared_acceptance_corpus');
const {
  resolveInvokeRequestedLayerWithInput,
} = require('../src/api/gateway/invocation/buildInvokeIngressGatewayInput');

const DEFAULT_INVOKE_BASE_URL =
  process.env.CELESTIAL_COMMERCE_STAGING_BASE_URL ||
  process.env.STAGING_BASE_URL ||
  'https://pivota-agent-staging.up.railway.app';
const DEFAULT_AURORA_BASE_URL =
  process.env.AURORA_BASE_URL ||
  process.env.CELESTIAL_COMMERCE_PROMPT_SMOKE_BASE_URL ||
  process.env.COMMERCE_CORE_PROMPT_SMOKE_BASE_URL ||
  'https://pivota-agent-production.up.railway.app';
const DEFAULT_CASES = path.join(
  __dirname,
  'fixtures',
  'celestial_commerce_core_beauty_cross_agent_corpus.json',
);
const DEFAULT_OUT_DIR = path.join(
  __dirname,
  '..',
  'reports',
  'celestial-commerce-beauty-cross-agent-matrix',
);

const BEAUTY_ACTION_TYPES = new Set([
  'consider_skin_analysis',
  'ask_missing_constraint',
  'open_pdp',
  'show_alternatives',
  'compare_same_type',
]);

const BANNED_INTERNAL_TERMS = [
  'same-slot',
  'semantic owner',
  'selected products',
  'primary recommendation focus',
  'products actually selected this time',
];

const BEAUTY_PRODUCT_TERMS = [
  'acne',
  'aha',
  'bha',
  'barrier',
  'beauty of joseon',
  'cleanser',
  'cream',
  'exfoliant',
  'glossier',
  'good molecules',
  'inkey list',
  'kravebeauty',
  'la roche posay',
  'lotion',
  'moisturizer',
  'niacinamide',
  'paula',
  'peptide',
  'retinol',
  'round lab',
  'serum',
  'skin1004',
  'skincare',
  'spf',
  'sunscreen',
  'supergoop',
  'toner',
  'tretinoin',
  'vanicream',
  'winona',
];

const NON_BEAUTY_DOMAIN_RULES = [
  {
    id: 'luggage',
    intent: ['carry on', 'carry-on', 'luggage', 'suitcase'],
    product: ['carry on', 'carry-on', 'hardshell', 'luggage', 'spinner', 'suitcase', 'travelpro', 'samsonite', 'monos', 'away', 'calpak'],
  },
  {
    id: 'espresso',
    intent: ['coffee', 'espresso'],
    product: ['bambino', 'breville', 'coffee', 'delonghi', 'espresso', 'gaggia', 'grinder'],
  },
  {
    id: 'camera',
    intent: ['camera', 'lifestyle creator', 'beginner lifestyle creator'],
    product: ['camera', 'canon', 'fujifilm', 'lens', 'mirrorless', 'nikon', 'panasonic', 'sony', 'vlogging'],
  },
];

function parseArgs(argv) {
  const args = {
    invokeBaseUrl: DEFAULT_INVOKE_BASE_URL,
    auroraBaseUrl: DEFAULT_AURORA_BASE_URL,
    cases: DEFAULT_CASES,
    outDir: DEFAULT_OUT_DIR,
    invokeTimeoutMs: Number(process.env.CELESTIAL_COMMERCE_BEAUTY_INVOKE_TIMEOUT_MS || 25000),
    auroraTimeoutMs: Number(process.env.CELESTIAL_COMMERCE_BEAUTY_AURORA_TIMEOUT_MS || 30000),
    skipInvoke: false,
    skipAurora: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (token === '--invoke-base-url' && next) args.invokeBaseUrl = String(next);
    if (token === '--aurora-base-url' && next) args.auroraBaseUrl = String(next);
    if (token === '--cases' && next) args.cases = path.resolve(String(next));
    if (token === '--out-dir' && next) args.outDir = path.resolve(String(next));
    if (token === '--invoke-timeout-ms' && next) args.invokeTimeoutMs = Math.max(1000, Number(next) || 25000);
    if (token === '--aurora-timeout-ms' && next) args.auroraTimeoutMs = Math.max(1000, Number(next) || 30000);
    if (token === '--skip-invoke') args.skipInvoke = true;
    if (token === '--skip-aurora') args.skipAurora = true;
  }

  return args;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      asArray(values)
        .map((item) => asString(item))
        .filter(Boolean),
    ),
  );
}

function deepClone(value, fallback = null) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function utcTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function buildAuroraIds(execution) {
  const base = `${sanitizeId(execution.case_id)}_${sanitizeId(execution.source)}_${execution.run_index}`;
  const uid = `matrix_${base}`.slice(0, 64);
  const traceId = `trace_${base}`.slice(0, 64);
  const briefId = `brief_${base}`.slice(0, 64);
  return { uid, traceId, briefId };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmpty(...value);
      if (nested) return nested;
      continue;
    }
    const token = asString(value);
    if (token) return token;
  }
  return '';
}

function titlesFromProducts(products) {
  return asArray(products)
    .map((item) =>
      firstNonEmpty(
        item?.title,
        item?.name,
        item?.display_name,
      ),
    )
    .filter(Boolean);
}

function collectVisibleProductText(normalized = {}) {
  return [
    ...asArray(normalized.lead_pick_titles),
    ...asArray(normalized.support_pick_titles),
    ...asArray(normalized.raw_card_titles),
    ...asArray(normalized.visible_compare_reasons),
  ]
    .map((item) => asString(item))
    .filter(Boolean);
}

function containsAnyNormalized(haystack, needles = []) {
  const text = normalizeText(haystack);
  if (!text) return false;
  return asArray(needles)
    .map((needle) => normalizeText(needle))
    .filter(Boolean)
    .some((needle) => text.includes(needle));
}

function inferNonBeautyDomainRule(testCase = {}) {
  const prompt = normalizeText(testCase.prompt);
  return NON_BEAUTY_DOMAIN_RULES.find((rule) => containsAnyNormalized(prompt, rule.intent)) || null;
}

function findNonBeautyProductContamination(testCase = {}, normalized = {}) {
  const productTextRows = collectVisibleProductText(normalized);
  if (productTextRows.length === 0) return [];

  const reasons = [];
  const joined = productTextRows.join(' | ');
  if (containsAnyNormalized(joined, BEAUTY_PRODUCT_TERMS)) {
    reasons.push('beauty_product_returned_for_non_beauty_prompt');
  }

  const inferredRule = inferNonBeautyDomainRule(testCase);
  if (inferredRule) {
    const aligned = productTextRows.some((row) => containsAnyNormalized(row, inferredRule.product));
    if (!aligned) reasons.push(`product_domain_mismatch:${inferredRule.id}`);
  }

  return uniqueStrings(reasons);
}

function extractRecommendationCard(body = {}) {
  return asArray(body.cards || body.cards_v1 || body.chat_cards).find((card) => {
    const type = normalizeText(card?.type || card?.card_type);
    return type === 'recommendations';
  }) || null;
}

function extractCardProducts(body = {}) {
  const card = extractRecommendationCard(body);
  const sections = asArray(card?.sections);
  const rows = [];
  for (const section of sections) {
    for (const product of asArray(section?.products)) {
      if (asPlainObject(product)) rows.push(product);
    }
  }
  if (rows.length > 0) return rows;
  return asArray(body.products);
}

function extractVisibleReasons(body = {}) {
  return extractCardProducts(body)
    .map((item) => firstNonEmpty(item?.why_this_one, item?.short_description, item?.description))
    .filter(Boolean);
}

function extractVisibleText(body = {}) {
  return firstNonEmpty(
    body?.assistant_message?.content,
    body?.reply,
    body?.assistant,
    body?.message,
  );
}

function extractBeautyExpert(body = {}) {
  return asPlainObject(body?.beauty_expert_v1);
}

function normalizeLeadPicks(beautyExpert, body = {}) {
  const bundle = asPlainObject(beautyExpert?.reco_bundle) || {};
  const lead = titlesFromProducts(bundle.lead_picks);
  const support = titlesFromProducts(bundle.support_picks);
  if (lead.length > 0 || support.length > 0) {
    return {
      lead_titles: lead,
      support_titles: support,
    };
  }

  const cardTitles = titlesFromProducts(extractCardProducts(body));
  return {
    lead_titles: cardTitles.slice(0, 1),
    support_titles: cardTitles.slice(1, 4),
  };
}

function normalizeCompareAxes(beautyExpert) {
  return uniqueStrings(
    asArray(beautyExpert?.compare_axes)
      .map((item) => asPlainObject(item)?.label || item?.label || item)
      .map((item) => asString(item)),
  );
}

function normalizeNextActions(body = {}, beautyExpert = null) {
  const source = asArray(beautyExpert?.next_actions).length > 0
    ? beautyExpert.next_actions
    : body?.next_actions;
  return uniqueStrings(
    asArray(source)
      .map((item) => firstNonEmpty(item?.type, item?.action_type, item?.target_skill_id))
      .filter(Boolean),
  );
}

function toEnvKey(input) {
  const normalized = String(input || '')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return normalized || 'DEFAULT';
}

function resolveInvokeAuth(profile = 'default') {
  const profileKey = toEnvKey(profile);
  const authToken = firstNonEmpty(
    process.env[`CELESTIAL_COMMERCE_STAGING_${profileKey}_AUTH_TOKEN`],
    process.env[`STAGING_${profileKey}_AUTH_TOKEN`],
    profileKey === 'DEFAULT' ? process.env.CELESTIAL_COMMERCE_STAGING_AUTH_TOKEN : '',
    profileKey === 'DEFAULT' ? process.env.STAGING_AUTH_TOKEN : '',
  );
  const agentApiKey = firstNonEmpty(
    process.env[`CELESTIAL_COMMERCE_STAGING_${profileKey}_AGENT_API_KEY`],
    process.env[`STAGING_${profileKey}_AGENT_API_KEY`],
    profileKey === 'DEFAULT' ? process.env.CELESTIAL_COMMERCE_STAGING_AGENT_API_KEY : '',
    profileKey === 'DEFAULT' ? process.env.STAGING_AGENT_API_KEY : '',
  );
  const headers = {};
  if (authToken) headers.Authorization = /^Bearer\s+/i.test(authToken) ? authToken : `Bearer ${authToken}`;
  if (agentApiKey) headers['X-Agent-API-Key'] = agentApiKey;
  return {
    profile,
    headers,
    missing: Object.keys(headers).length === 0,
  };
}

function normalizeCase(rawCase = {}) {
  const invoke = asPlainObject(rawCase.invoke) || {};
  const aurora = asPlainObject(rawCase.aurora) || {};
  return {
    id: asString(rawCase.id),
    title: asString(rawCase.title || rawCase.id),
    family: asString(rawCase.family || 'uncategorized'),
    prompt: asString(rawCase.prompt || rawCase.query),
    expected_domain: asString(rawCase.expected_domain || 'beauty'),
    expected_beauty_mode: rawCase.expected_beauty_mode == null ? null : asString(rawCase.expected_beauty_mode),
    expected_delegated_layer: rawCase.expected_delegated_layer == null ? null : asString(rawCase.expected_delegated_layer),
    expected_next_actions_any: uniqueStrings(rawCase.expected_next_actions_any),
    expected_compare_axes_any: uniqueStrings(rawCase.expected_compare_axes_any),
    expected_lead_pick_titles_any: uniqueStrings(rawCase.expected_lead_pick_titles_any),
    expect_beauty_expert: rawCase.expect_beauty_expert === true,
    expect_non_beauty_isolation: rawCase.expect_non_beauty_isolation === true,
    invoke: {
      sources: uniqueStrings(invoke.sources && invoke.sources.length > 0 ? invoke.sources : ['shopping_agent', 'creator_agent']),
      requires_auth: invoke.requires_auth !== false,
      auth_profile: asString(invoke.auth_profile || 'default'),
      operation: asString(invoke.operation || 'find_products_multi'),
      payload: deepClone(invoke.payload, {}),
      metadata: deepClone(invoke.metadata, {}),
      context: deepClone(invoke.context, null),
    },
    aurora: {
      surfaces: uniqueStrings(aurora.surfaces || []),
      request: deepClone(aurora.request, null),
    },
  };
}

function loadCases(casesPath) {
  return loadBeautyCrossAgentCases(casesPath)
    .map((item) => normalizeCase(item))
    .filter((item) => item.id && item.prompt);
}

function buildInvokeRequest(testCase, source) {
  const metadata = {
    ...deepClone(testCase.invoke.metadata, {}),
    source,
  };
  return {
    operation: testCase.invoke.operation,
    payload: deepClone(testCase.invoke.payload, {}),
    metadata,
    ...(testCase.invoke.context ? { context: deepClone(testCase.invoke.context, {}) } : {}),
  };
}

function buildAuroraRequest(testCase) {
  const request = deepClone(testCase.aurora.request, {}) || {};
  if (!request.message && testCase.prompt) request.message = testCase.prompt;
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    request.messages = [{ role: 'user', content: request.message || testCase.prompt }];
  }
  if (!request.language) request.language = 'EN';
  if (!request.client_state) request.client_state = { state: 'IDLE_CHAT' };
  if (!request.context) request.context = { locale: 'en' };
  return request;
}

function buildWave1Executions(cases, args) {
  const executions = [];
  for (const testCase of cases) {
    if (!args.skipInvoke) {
      for (const source of testCase.invoke.sources) {
        executions.push({
          wave: 1,
          run_index: 1,
          case_id: testCase.id,
          surface_key: `invoke:${source}`,
          surface_type: 'invoke',
          source,
          endpoint: source === 'creator_agent' ? '/agent/creator/v1/invoke' : '/agent/shop/v1/invoke',
          testCase,
        });
      }
    }
    if (!args.skipAurora) {
      for (const surface of testCase.aurora.surfaces) {
        executions.push({
          wave: 1,
          run_index: 1,
          case_id: testCase.id,
          surface_key: `aurora:${surface}`,
          surface_type: 'aurora',
          source: surface,
          endpoint: surface === 'v2_chat' ? '/v2/chat' : '/v1/chat',
          testCase,
        });
      }
    }
  }
  return executions;
}

function createRequestRecord(execution, args) {
  if (execution.surface_type === 'invoke') {
    const requestBody = buildInvokeRequest(execution.testCase, execution.source);
    return {
      baseUrl: args.invokeBaseUrl,
      endpoint: execution.endpoint,
      timeoutMs: args.invokeTimeoutMs,
      body: requestBody,
      headers: {
        'Content-Type': 'application/json',
        ...resolveInvokeAuth(execution.testCase.invoke.auth_profile).headers,
      },
    };
  }

  const auroraBody = buildAuroraRequest(execution.testCase);
  const auroraIds = buildAuroraIds(execution);
  return {
    baseUrl: args.auroraBaseUrl,
    endpoint: execution.endpoint,
    timeoutMs: args.auroraTimeoutMs,
    body: auroraBody,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Aurora-Uid': auroraIds.uid,
      'X-Trace-ID': auroraIds.traceId,
      'X-Brief-ID': auroraIds.briefId,
      'X-Lang': asString(auroraBody.language || 'EN') || 'EN',
      'X-Aurora-Lang': normalizeText(auroraBody.language || 'en') === 'cn' ? 'cn' : 'en',
    },
  };
}

async function requestJson(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    let json = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch (_error) {
      json = { _raw: rawText };
    }
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[String(key || '').toLowerCase()] = String(value || '').trim();
    });
    return {
      ok: true,
      status: response.status,
      body: json,
      headers: responseHeaders,
      elapsed_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {
        error: error?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED',
        message: String(error?.message || error),
      },
      headers: {},
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeInvokeExecution(execution, requestRecord, response) {
  const body = asPlainObject(response.body) || {};
  const beautyExpert = extractBeautyExpert(body);
  const requestedLayer = resolveInvokeRequestedLayerWithInput(
    execution.testCase.invoke.operation,
    execution.source,
    {
      payload: requestRecord.body.payload,
      metadata: requestRecord.body.metadata,
      declaredCapabilities: requestRecord.body.metadata?.capabilities,
    },
  );
  const actualLayer = firstNonEmpty(
    body.layer,
    body.entry_layer,
    beautyExpert?.delegation_trace?.entry_layer,
  ) || null;
  const delegatedLayer = firstNonEmpty(
    beautyExpert?.delegation_trace?.delegated_layer,
    body.delegated_layer,
  ) || null;
  const picks = normalizeLeadPicks(beautyExpert, body);
  const compareAxes = normalizeCompareAxes(beautyExpert);
  const nextActions = normalizeNextActions(body, beautyExpert);
  return {
    surface_type: 'invoke',
    surface_key: execution.surface_key,
    requested_layer: requestedLayer,
    actual_layer: actualLayer,
    beauty_expert_v1: Boolean(beautyExpert),
    mode: beautyExpert?.mode || null,
    delegated_layer: delegatedLayer,
    lead_pick_titles: picks.lead_titles,
    support_pick_titles: picks.support_titles,
    compare_axes: compareAxes,
    next_actions: nextActions,
    delegation_trace: deepClone(beautyExpert?.delegation_trace, null),
    visible_text: extractVisibleText(body),
    visible_compare_reasons: extractVisibleReasons(body),
    raw_card_titles: titlesFromProducts(extractCardProducts(body)),
    http_status: response.status,
    elapsed_ms: response.elapsed_ms,
    reply_mode: firstNonEmpty(body?.reply_mode, body?.meta?.reply_mode),
  };
}

function normalizeAuroraExecution(execution, _requestRecord, response) {
  const body = asPlainObject(response.body) || {};
  const beautyExpert = extractBeautyExpert(body);
  const picks = normalizeLeadPicks(beautyExpert, body);
  const cardTitles = titlesFromProducts(extractCardProducts(body));
  return {
    surface_type: 'aurora',
    surface_key: execution.surface_key,
    requested_layer: 'orchestration',
    actual_layer: firstNonEmpty(body.layer, beautyExpert?.delegation_trace?.entry_layer) || null,
    beauty_expert_v1: Boolean(beautyExpert),
    mode: beautyExpert?.mode || null,
    delegated_layer: firstNonEmpty(beautyExpert?.delegation_trace?.delegated_layer) || null,
    lead_pick_titles: picks.lead_titles,
    support_pick_titles: picks.support_titles,
    compare_axes: normalizeCompareAxes(beautyExpert),
    next_actions: normalizeNextActions(body, beautyExpert),
    delegation_trace: deepClone(beautyExpert?.delegation_trace, null),
    visible_text: extractVisibleText(body),
    visible_compare_reasons: extractVisibleReasons(body),
    raw_card_titles: cardTitles,
    http_status: response.status,
    elapsed_ms: response.elapsed_ms,
  };
}

function overlaps(left = [], right = []) {
  const rightTokens = new Set(asArray(right).map((item) => normalizeText(item)).filter(Boolean));
  return asArray(left).some((item) => rightTokens.has(normalizeText(item)));
}

function fuzzyTextOverlaps(left = [], right = []) {
  const rightTokens = asArray(right)
    .map((item) => normalizeText(item))
    .filter(Boolean);
  return asArray(left)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .some((leftToken) =>
      rightTokens.some(
        (rightToken) =>
          leftToken === rightToken ||
          leftToken.includes(rightToken) ||
          rightToken.includes(leftToken),
      ),
    );
}

function classifyExecution(execution, normalized, response) {
  const failures = [];
  const testCase = execution.testCase;
  const body = asPlainObject(response.body) || {};
  const expectedBeauty = testCase.expect_beauty_expert === true;
  const hasVisibleText = Boolean(asString(normalized.visible_text));
  const lowerText = normalizeText(normalized.visible_text);

  if (!response.ok || response.status === 0 || response.status >= 500) {
    failures.push('latency_or_timeout');
  }

  if (expectedBeauty) {
    if (!normalized.beauty_expert_v1) {
      failures.push('beauty_route_miss');
    }
    if (execution.surface_type === 'invoke' && normalized.requested_layer !== 'orchestration') {
      failures.push('beauty_route_miss');
    }
    if (execution.surface_type === 'invoke' && normalized.actual_layer && normalized.actual_layer !== 'orchestration') {
      failures.push('beauty_route_miss');
    }
    if (
      testCase.expected_beauty_mode &&
      asString(normalized.mode) &&
      normalized.mode !== testCase.expected_beauty_mode
    ) {
      failures.push('beauty_mode_miss');
    }
    if (
      testCase.expected_delegated_layer &&
      asString(normalized.delegated_layer) &&
      normalized.delegated_layer !== testCase.expected_delegated_layer
    ) {
      failures.push('beauty_mode_miss');
    }
    if (
      testCase.expected_next_actions_any.length > 0 &&
      !overlaps(normalized.next_actions, testCase.expected_next_actions_any)
    ) {
      failures.push(
        testCase.expected_beauty_mode === 'guided_beauty_reco'
          ? 'clarify_policy_miss'
          : 'content_quality_miss',
      );
    }
    if (
      testCase.expected_compare_axes_any.length > 0 &&
      normalized.compare_axes.length > 0 &&
      !overlaps(normalized.compare_axes, testCase.expected_compare_axes_any)
    ) {
      failures.push('beauty_truth_split');
    }
    if (
      testCase.expected_lead_pick_titles_any.length > 0 &&
      normalized.lead_pick_titles.length > 0 &&
      !fuzzyTextOverlaps(normalized.lead_pick_titles, testCase.expected_lead_pick_titles_any)
    ) {
      failures.push('beauty_truth_split');
    }
    if (
      execution.surface_type === 'aurora' &&
      normalized.lead_pick_titles.length > 0 &&
      normalized.raw_card_titles.length > 0 &&
      !overlaps(normalized.lead_pick_titles, normalized.raw_card_titles)
    ) {
      failures.push('surface_projection_split');
    }
    if (hasVisibleText) {
      const bannedHit = BANNED_INTERNAL_TERMS.some((token) => lowerText.includes(normalizeText(token)));
      if (bannedHit) failures.push('content_quality_miss');
      if (
        testCase.expected_beauty_mode === 'category_compare' &&
        !/(instead of|leans|more sense if|better if|while|between|rather than)/i.test(
          normalized.visible_text,
        )
      ) {
        failures.push('content_quality_miss');
      }
      if (
        testCase.expected_beauty_mode === 'guided_beauty_reco' &&
        normalized.next_actions.length > 0 &&
        !/(need more context|need more detail|share more|skin analysis|current routine|current skincare situation)/i.test(
          normalized.visible_text,
        ) &&
        (normalized.lead_pick_titles.length > 0 || normalizeText(body?.mainline_status) === 'grounded_success')
      ) {
        failures.push('clarify_policy_miss');
      }
    }
  }

  if (testCase.expect_non_beauty_isolation) {
    if (normalized.beauty_expert_v1) failures.push('non_beauty_false_positive');
    if (normalized.next_actions.some((item) => BEAUTY_ACTION_TYPES.has(item))) {
      failures.push('non_beauty_false_positive');
    }
    if (normalized.compare_axes.length > 0 && normalized.compare_axes.some(Boolean)) {
      failures.push('non_beauty_false_positive');
    }
    if (findNonBeautyProductContamination(testCase, normalized).length > 0) {
      failures.push('non_beauty_false_positive');
    }
  }

  return uniqueStrings(failures);
}

function executionIdentity(execution) {
  return `${execution.case_id}::${execution.surface_key}`;
}

function summarizeCrossSurfaceRun(caseExecutions = [], testCase) {
  const failures = [];
  const beautyExecutions = caseExecutions.filter((item) => item.normalized.beauty_expert_v1);
  if (testCase.expect_beauty_expert) {
    const leadSets = beautyExecutions
      .map((item) => item.normalized.lead_pick_titles)
      .filter((titles) => titles.length > 0);
    if (leadSets.length >= 2) {
      let allAligned = true;
      for (let index = 1; index < leadSets.length; index += 1) {
        if (!overlaps(leadSets[0], leadSets[index])) {
          allAligned = false;
          break;
        }
      }
      if (!allAligned) failures.push('beauty_truth_split');
    }

    const axisSets = beautyExecutions
      .map((item) => item.normalized.compare_axes)
      .filter((axes) => axes.length > 0);
    if (axisSets.length >= 2) {
      let axisAligned = true;
      for (let index = 1; index < axisSets.length; index += 1) {
        if (!overlaps(axisSets[0], axisSets[index])) {
          axisAligned = false;
          break;
        }
      }
      if (!axisAligned) failures.push('beauty_truth_split');
    }

    const auroraSurfaces = caseExecutions.filter((item) => item.execution.surface_type === 'aurora');
    if (auroraSurfaces.length >= 2) {
      const withCards = auroraSurfaces.filter((item) => item.normalized.raw_card_titles.length > 0);
      if (withCards.length >= 2) {
        const base = withCards[0].normalized.raw_card_titles;
        for (let index = 1; index < withCards.length; index += 1) {
          if (!overlaps(base, withCards[index].normalized.raw_card_titles)) {
            failures.push('surface_projection_split');
            break;
          }
        }
      }
    }
  }
  return uniqueStrings(failures);
}

function collectInstability(caseSurfaceExecutions = []) {
  const modes = uniqueStrings(caseSurfaceExecutions.map((item) => item.normalized.mode).filter(Boolean));
  const leadGroups = caseSurfaceExecutions
    .map((item) => item.normalized.lead_pick_titles)
    .filter((titles) => titles.length > 0);
  const axisGroups = caseSurfaceExecutions
    .map((item) => item.normalized.compare_axes)
    .filter((axes) => axes.length > 0);
  const failures = [];
  if (modes.length > 1) failures.push('beauty_mode_miss');
  if (leadGroups.length >= 2) {
    let aligned = true;
    for (let index = 1; index < leadGroups.length; index += 1) {
      if (!overlaps(leadGroups[0], leadGroups[index])) {
        aligned = false;
        break;
      }
    }
    if (!aligned) failures.push('beauty_truth_split');
  }
  if (axisGroups.length >= 2) {
    let aligned = true;
    for (let index = 1; index < axisGroups.length; index += 1) {
      if (!overlaps(axisGroups[0], axisGroups[index])) {
        aligned = false;
        break;
      }
    }
    if (!aligned) failures.push('beauty_truth_split');
  }
  return uniqueStrings(failures);
}

function writeArtifact(outDir, execution, requestRecord, response, normalized, failureClasses) {
  const rawDir = path.join(
    outDir,
    'raw',
    `wave_${execution.wave}`,
  );
  fs.mkdirSync(rawDir, { recursive: true });
  const fileName = `${sanitizeId(execution.case_id)}__${sanitizeId(execution.surface_key)}__run_${execution.run_index}.json`;
  const artifactPath = path.join(rawDir, fileName);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        execution,
        request: {
          url: `${requestRecord.baseUrl.replace(/\/+$/, '')}${execution.endpoint}`,
          headers: requestRecord.headers,
          body: requestRecord.body,
          timeout_ms: requestRecord.timeoutMs,
        },
        response,
        normalized,
        failure_classes: failureClasses,
      },
      null,
      2,
    ),
    'utf8',
  );
  return artifactPath;
}

async function executeSingle(execution, args, outDir) {
  const testCase = execution.testCase;
  if (execution.surface_type === 'invoke') {
    const auth = resolveInvokeAuth(testCase.invoke.auth_profile);
    if (testCase.invoke.requires_auth && auth.missing) {
      const normalized = {
        surface_type: 'invoke',
        surface_key: execution.surface_key,
        requested_layer: resolveInvokeRequestedLayerWithInput(
          testCase.invoke.operation,
          execution.source,
          {
            payload: buildInvokeRequest(testCase, execution.source).payload,
            metadata: buildInvokeRequest(testCase, execution.source).metadata,
          },
        ),
        actual_layer: null,
        beauty_expert_v1: false,
        mode: null,
        delegated_layer: null,
        lead_pick_titles: [],
        support_pick_titles: [],
        compare_axes: [],
        next_actions: [],
        delegation_trace: null,
        visible_text: '',
        visible_compare_reasons: [],
        raw_card_titles: [],
        http_status: null,
        elapsed_ms: 0,
        reply_mode: null,
      };
      const artifactPath = writeArtifact(
        outDir,
        execution,
        {
          baseUrl: args.invokeBaseUrl,
          endpoint: execution.endpoint,
          timeoutMs: args.invokeTimeoutMs,
          headers: auth.headers,
          body: buildInvokeRequest(testCase, execution.source),
        },
        {
          ok: false,
          status: 0,
          headers: {},
          body: {
            error: 'AUTH_MISSING',
            message: `missing invoke auth for profile ${testCase.invoke.auth_profile}`,
          },
          elapsed_ms: 0,
        },
        normalized,
        ['latency_or_timeout'],
      );
      return {
        execution,
        normalized,
        failure_classes: [],
        skipped: 'missing_auth',
        artifact_path: artifactPath,
        response: {
          ok: false,
          status: 0,
          headers: {},
          body: {
            error: 'AUTH_MISSING',
            message: `missing invoke auth for profile ${testCase.invoke.auth_profile}`,
          },
          elapsed_ms: 0,
        },
      };
    }
  }

  const requestRecord = createRequestRecord(execution, args);
  const response = await requestJson(
    `${requestRecord.baseUrl.replace(/\/+$/, '')}${execution.endpoint}`,
    requestRecord.body,
    requestRecord.headers,
    requestRecord.timeoutMs,
  );
  const normalized = execution.surface_type === 'invoke'
    ? normalizeInvokeExecution(execution, requestRecord, response)
    : normalizeAuroraExecution(execution, requestRecord, response);
  const failureClasses = classifyExecution(execution, normalized, response);
  const artifactPath = writeArtifact(outDir, execution, requestRecord, response, normalized, failureClasses);
  return {
    execution,
    normalized,
    failure_classes: failureClasses,
    skipped: null,
    artifact_path: artifactPath,
    response,
  };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function buildWave2Executions(casesById, wave1Results) {
  const selectedKeys = new Set();
  for (const result of wave1Results) {
    const testCase = result.execution.testCase;
    if (testCase.expect_beauty_expert || result.failure_classes.length > 0) {
      selectedKeys.add(executionIdentity(result.execution));
    }
  }
  const executions = [];
  for (const key of selectedKeys) {
    const [caseId, surfaceKey] = key.split('::');
    const testCase = casesById.get(caseId);
    if (!testCase) continue;
    const [surfaceType, source] = surfaceKey.split(':');
    for (const runIndex of [2, 3]) {
      executions.push({
        wave: 2,
        run_index: runIndex,
        case_id: caseId,
        surface_key: surfaceKey,
        surface_type: surfaceType,
        source,
        endpoint:
          surfaceType === 'invoke'
            ? source === 'creator_agent'
              ? '/agent/creator/v1/invoke'
              : '/agent/shop/v1/invoke'
            : source === 'v2_chat'
              ? '/v2/chat'
              : '/v1/chat',
        testCase,
      });
    }
  }
  return executions;
}

function buildWave3Executions(casesById, completedResults) {
  const selected = new Map();
  const byCaseSurface = groupBy(completedResults, (item) => executionIdentity(item.execution));
  for (const [key, items] of byCaseSurface.entries()) {
    const instability = collectInstability(items);
    const hasDirectFailures = items.some((item) => item.failure_classes.length > 0);
    if (instability.length > 0 || hasDirectFailures) {
      const [caseId, surfaceKey] = key.split('::');
      selected.set(key, { caseId, surfaceKey });
    }
  }

  const executions = [];
  for (const { caseId, surfaceKey } of selected.values()) {
    const [surfaceType, source] = surfaceKey.split(':');
    const testCase = casesById.get(caseId);
    if (!testCase) continue;
    executions.push({
      wave: 3,
      run_index: 4,
      case_id: caseId,
      surface_key: surfaceKey,
      surface_type: surfaceType,
      source,
      endpoint:
        surfaceType === 'invoke'
          ? source === 'creator_agent'
            ? '/agent/creator/v1/invoke'
            : '/agent/shop/v1/invoke'
          : source === 'v2_chat'
            ? '/v2/chat'
            : '/v1/chat',
      testCase,
    });
  }
  return executions;
}

function summarizeResults(allResults, cases) {
  const casesById = new Map(cases.map((item) => [item.id, item]));
  const byCaseRun = groupBy(allResults, (item) => `${item.execution.case_id}::${item.execution.run_index}`);
  const byCaseSurface = groupBy(allResults, (item) => executionIdentity(item.execution));
  const crossRunFailures = new Map();
  for (const [key, items] of byCaseRun.entries()) {
    const caseId = key.split('::')[0];
    const testCase = casesById.get(caseId);
    if (!testCase) continue;
    crossRunFailures.set(key, summarizeCrossSurfaceRun(items, testCase));
  }

  const instabilityByCaseSurface = new Map();
  for (const [key, items] of byCaseSurface.entries()) {
    instabilityByCaseSurface.set(key, collectInstability(items));
  }

  const caseSummaries = [];
  const driftBuckets = {
    beauty_route_miss: [],
    beauty_mode_miss: [],
    beauty_truth_split: [],
    content_quality_miss: [],
    non_beauty_false_positive: [],
    clarify_policy_miss: [],
    latency_or_timeout: [],
    surface_projection_split: [],
  };

  for (const testCase of cases) {
    const related = allResults.filter((item) => item.execution.case_id === testCase.id);
    const failureClasses = new Set();
    const skippedSurfaces = [];
    const surfaceSummary = {};
    for (const item of related) {
      const key = item.execution.surface_key;
      if (!surfaceSummary[key]) {
        surfaceSummary[key] = {
          runs: [],
          instability: instabilityByCaseSurface.get(`${testCase.id}::${key}`) || [],
        };
      }
      surfaceSummary[key].runs.push({
        wave: item.execution.wave,
        run_index: item.execution.run_index,
        status: item.response.status,
        skipped: item.skipped,
        mode: item.normalized.mode,
        lead_pick_titles: item.normalized.lead_pick_titles,
        support_pick_titles: item.normalized.support_pick_titles,
        raw_card_titles: item.normalized.raw_card_titles,
        compare_axes: item.normalized.compare_axes,
        visible_text: item.normalized.visible_text,
        failure_classes: item.failure_classes,
        artifact_path: item.artifact_path,
      });
      for (const failure of item.failure_classes) failureClasses.add(failure);
      if (item.skipped) skippedSurfaces.push(key);
    }
    for (const [caseRunKey, failures] of crossRunFailures.entries()) {
      if (!caseRunKey.startsWith(`${testCase.id}::`)) continue;
      for (const failure of failures) failureClasses.add(failure);
    }
    for (const [surfaceKey, entry] of Object.entries(surfaceSummary)) {
      for (const failure of entry.instability || []) failureClasses.add(failure);
    }
    const failureList = Array.from(failureClasses);
    for (const failure of failureList) {
      if (driftBuckets[failure]) {
        driftBuckets[failure].push(testCase.id);
      }
    }
    caseSummaries.push({
      id: testCase.id,
      title: testCase.title,
      family: testCase.family,
      prompt: testCase.prompt,
      expected_domain: testCase.expected_domain,
      expected_beauty_mode: testCase.expected_beauty_mode,
      expect_beauty_expert: testCase.expect_beauty_expert,
      expect_non_beauty_isolation: testCase.expect_non_beauty_isolation,
      failure_classes: failureList,
      surface_summary: surfaceSummary,
      skipped_surfaces: uniqueStrings(skippedSurfaces),
    });
  }

  const perSurface = {};
  for (const result of allResults) {
    const key = result.execution.surface_key;
    if (!perSurface[key]) {
      perSurface[key] = {
        total_runs: 0,
        failed_runs: 0,
        skipped_runs: 0,
        beauty_expert_runs: 0,
      };
    }
    perSurface[key].total_runs += 1;
    if (result.failure_classes.length > 0) perSurface[key].failed_runs += 1;
    if (result.skipped) perSurface[key].skipped_runs += 1;
    if (result.normalized.beauty_expert_v1) perSurface[key].beauty_expert_runs += 1;
  }

  const repeatedRunInstability = Array.from(instabilityByCaseSurface.entries())
    .filter(([, failures]) => failures.length > 0)
    .map(([key, failures]) => ({
      case_surface: key,
      failure_classes: failures,
    }));

  const blockerCases = caseSummaries
    .filter((item) => item.failure_classes.length > 0)
    .sort((left, right) => right.failure_classes.length - left.failure_classes.length)
    .slice(0, 10);

  return {
    generated_at: new Date().toISOString(),
    total_executions: allResults.length,
    total_cases: cases.length,
    per_surface: perSurface,
    failure_buckets: Object.fromEntries(
      Object.entries(driftBuckets).map(([key, value]) => [key, uniqueStrings(value)]),
    ),
    repeated_run_instability: repeatedRunInstability,
    blocker_cases: blockerCases,
    case_summaries: caseSummaries,
  };
}

function writeReport(outDir, args, summary, allResults) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'celestial_commerce_beauty_cross_agent_matrix.json');
  const markdownPath = path.join(outDir, 'celestial_commerce_beauty_cross_agent_matrix.md');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        args,
        summary,
        results: allResults.map((item) => ({
          execution: item.execution,
          normalized: item.normalized,
          failure_classes: item.failure_classes,
          skipped: item.skipped,
          artifact_path: item.artifact_path,
          response_status: item.response.status,
          elapsed_ms: item.response.elapsed_ms,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  const lines = [
    '# Celestial Commerce Beauty Cross-Agent Matrix',
    '',
    `- Generated at: ${summary.generated_at}`,
    `- Invoke base URL: ${args.invokeBaseUrl}`,
    `- Aurora base URL: ${args.auroraBaseUrl}`,
    `- Cases file: \`${args.cases}\``,
    `- Total cases: ${summary.total_cases}`,
    `- Total executions: ${summary.total_executions}`,
    '',
    '## Failure Buckets',
    '',
    '| Failure class | Case count | Cases |',
    '| --- | ---: | --- |',
    ...Object.entries(summary.failure_buckets).map(
      ([key, value]) =>
        `| ${key} | ${value.length} | ${value.length > 0 ? value.join(', ') : '-'} |`,
    ),
    '',
    '## Per-Surface Summary',
    '',
    '| Surface | Total runs | Failed runs | Skipped runs | beauty_expert runs |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.per_surface).map(
      ([key, value]) =>
        `| ${key} | ${value.total_runs} | ${value.failed_runs} | ${value.skipped_runs} | ${value.beauty_expert_runs} |`,
    ),
    '',
    '## Repeated-Run Instability',
    '',
    summary.repeated_run_instability.length === 0
      ? '- None'
      : '| Case surface | Failure classes |\n| --- | --- |\n' +
        summary.repeated_run_instability
          .map((item) => `| ${item.case_surface} | ${item.failure_classes.join(', ')} |`)
          .join('\n'),
    '',
    '## Top 10 Blocker Cases',
    '',
  ];

  if (summary.blocker_cases.length === 0) {
    lines.push('- No blocker cases.');
  } else {
    for (const blocker of summary.blocker_cases) {
      lines.push(`### ${blocker.id}`);
      lines.push('');
      lines.push(`- Prompt: ${blocker.prompt}`);
      lines.push(`- Failure classes: ${blocker.failure_classes.join(', ')}`);
      for (const [surfaceKey, surfaceSummary] of Object.entries(blocker.surface_summary || {})) {
        const latest = asArray(surfaceSummary.runs).slice(-1)[0] || {};
        lines.push(`- ${surfaceKey}: mode=${latest.mode || 'n/a'}, lead=${asArray(latest.lead_pick_titles).join(' | ') || 'n/a'}, axes=${asArray(latest.compare_axes).join(' | ') || 'n/a'}, artifact=\`${latest.artifact_path || 'n/a'}\``);
      }
      lines.push('');
    }
  }

  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, markdownPath };
}

async function runWave(executions, args, outDir) {
  const results = [];
  for (const execution of executions) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await executeSingle(execution, args, outDir));
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir, utcTag());
  const cases = loadCases(args.cases);
  const casesById = new Map(cases.map((item) => [item.id, item]));

  const wave1Executions = buildWave1Executions(cases, args);
  const wave1Results = await runWave(wave1Executions, args, outDir);

  const wave2Executions = buildWave2Executions(casesById, wave1Results);
  const wave2Results = await runWave(wave2Executions, args, outDir);

  const preWave3Results = [...wave1Results, ...wave2Results];
  const wave3Executions = buildWave3Executions(casesById, preWave3Results);
  const wave3Results = await runWave(wave3Executions, args, outDir);

  const allResults = [...wave1Results, ...wave2Results, ...wave3Results];
  const summary = summarizeResults(allResults, cases);
  const { jsonPath, markdownPath } = writeReport(outDir, args, summary, allResults);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        summary,
        json_path: jsonPath,
        markdown_path: markdownPath,
        out_dir: outDir,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2)}\n`,
    );
    process.exit(1);
  });
}

module.exports = {
  normalizeCase,
  loadCases,
  normalizeInvokeExecution,
  normalizeAuroraExecution,
  classifyExecution,
  summarizeResults,
  buildWave1Executions,
  buildWave2Executions,
  buildWave3Executions,
};
