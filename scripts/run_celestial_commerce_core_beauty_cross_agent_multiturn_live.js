#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  resolveInvokeRequestedLayerWithInput,
} = require('../src/api/gateway/invocation/buildInvokeIngressGatewayInput');

const DEFAULT_BASE_URL =
  process.env.CELESTIAL_COMMERCE_STAGING_BASE_URL ||
  process.env.STAGING_BASE_URL ||
  'https://pivota-agent-staging.up.railway.app';
const DEFAULT_OUT_DIR = path.join(
  __dirname,
  '..',
  'reports',
  'celestial-commerce-beauty-cross-agent-multiturn-live',
);

const INTERNAL_TERMS = [
  'same-slot',
  'semantic owner',
  'selected products',
  'primary recommendation focus',
  'products actually selected this time',
];

const BEAUTY_PRODUCT_TERMS = [
  'barrier',
  'beauty of joseon',
  'cleanser',
  'cream',
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
  'spf',
  'sunscreen',
  'supergoop',
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

const CASES = Object.freeze([
  {
    id: 'shopping_oily_sunscreen_humid_makeup',
    sources: ['shopping_agent'],
    turns: [
      {
        message: 'I have oily skin, what sunscreen should I buy?',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'oily' },
          scenario_context: { use_case: 'daily sunscreen' },
        },
      },
      {
        message: 'I live in Houston and wear makeup. I get shiny by noon.',
        effective_goal:
          'I have oily skin in hot humid Houston, wear makeup, and get shiny by noon. What sunscreen should I buy?',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'oily' },
          scenario_context: { location: 'Houston', climate: 'hot humid', use_case: 'under makeup' },
          constraints: { finish: 'less shiny by noon' },
        },
        expected_visible_terms_all: ['Houston', 'humid', 'makeup', 'shiny'],
      },
      {
        message: 'Show me alternatives and explain tradeoffs.',
        effective_goal:
          'Compare sunscreen alternatives for oily skin under makeup in hot humid Houston.',
        expected_mode: 'category_compare',
        require_tradeoff_copy: true,
      },
    ],
  },
  {
    id: 'shopping_dry_sensitive_tretinoin_budget',
    sources: ['shopping_agent'],
    turns: [
      {
        message: 'My skin feels dry and tight after washing. What moisturizer should I use first?',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive', barrier_status: 'tight after washing' },
          scenario_context: { use_case: 'first moisturizer step' },
        },
      },
      {
        message: 'I use tretinoin at night and want to stay under $30.',
        effective_goal:
          'I have dry sensitive skin, use tretinoin at night, and want a moisturizer under $30.',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive', barrier_status: 'retinoid-stressed' },
          routine_context: { actives: ['tretinoin'] },
          constraints: { budget_max: 30 },
        },
        expected_visible_terms_all: ['tretinoin', 'under USD 30'],
      },
      {
        message: 'Which one should I use first versus later in the routine?',
        effective_goal:
          'For dry sensitive retinoid-stressed skin, compare which moisturizer to use first versus later in the routine.',
        expected_mode: 'category_compare',
        require_tradeoff_copy: true,
        expected_visible_terms_all: ['first', 'later', 'routine'],
      },
    ],
  },
  {
    id: 'shopping_guided_context_recovery',
    sources: ['shopping_agent'],
    turns: [
      {
        message: 'What should I use for my skin?',
        expected_mode: 'guided_beauty_reco',
        beauty_request: { domain: 'beauty' },
        expected_next_actions_any: ['consider_skin_analysis', 'ask_missing_constraint'],
        expect_no_products: true,
        require_clarify_copy: true,
      },
      {
        message: 'Combination skin, clogged pores, Seattle winter, simple routine.',
        effective_goal:
          'I have combination skin with clogged pores in Seattle winter and want a simple routine.',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'combination', concerns: ['clogged pores'] },
          scenario_context: { location: 'Seattle', season: 'winter' },
          constraints: { routine_complexity: 'simple' },
        },
      },
      {
        message: 'What should I buy first if I only buy one?',
        effective_goal:
          'For combination skin with clogged pores in Seattle winter, pick the first product to buy if I only buy one.',
        expected_mode: 'category_compare',
        require_tradeoff_copy: true,
        expected_visible_terms_all: ['only buy one', 'Seattle winter'],
      },
    ],
  },
  {
    id: 'creator_oily_under_makeup_roundup',
    sources: ['creator_agent'],
    turns: [
      {
        message: "I'm making a skincare roundup for oily skin under makeup. What sunscreen options should I feature?",
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'oily' },
          scenario_context: { audience: 'skincare roundup', use_case: 'under makeup' },
        },
        require_creator_copy: true,
      },
      {
        message: 'Can you split them by price band and the angle I should use in content?',
        effective_goal:
          'For a creator sunscreen roundup for oily skin under makeup, split options by price band and content angle.',
        expected_mode: 'category_compare',
        require_creator_copy: true,
        require_tradeoff_copy: true,
      },
      {
        message: 'Also tell me what claims not to overstate.',
        effective_goal:
          'For the creator sunscreen roundup, explain cautious claims and avoid overstating finish or clinical benefits.',
        expected_mode: 'category_compare',
        require_creator_copy: true,
      },
    ],
  },
  {
    id: 'creator_dry_sensitive_moisturizer_audience',
    sources: ['creator_agent'],
    turns: [
      {
        message: 'My audience has dry sensitive skin, what moisturizer should I recommend?',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive' },
          scenario_context: { audience: 'creator audience' },
        },
        require_creator_copy: true,
      },
      {
        message: 'They are mostly beginners and some use retinoids.',
        effective_goal:
          'Recommend beginner-friendly moisturizers for a dry sensitive audience where some use retinoids.',
        expected_mode: 'category_compare',
        beauty_request: {
          domain: 'beauty',
          skin_context: { skin_type: 'dry sensitive' },
          routine_context: { audience_actives: ['retinoids'] },
          scenario_context: { audience: 'beginner creator audience' },
        },
        require_creator_copy: true,
      },
      {
        message: 'Give me three bullets that explain why each one, not just product names.',
        effective_goal:
          'For a dry sensitive beginner audience, explain why each moisturizer earns a slot versus the other options.',
        expected_mode: 'category_compare',
        require_creator_copy: true,
        require_tradeoff_copy: true,
        expected_visible_terms_all: ['three slot reasons', 'versus'],
      },
    ],
  },
  {
    id: 'shopping_non_beauty_luggage',
    sources: ['shopping_agent'],
    expect_beauty: false,
    turns: [
      {
        message: 'I need a carry-on suitcase under $200.',
      },
      {
        message: 'Prefer lightweight hard-shell and a front laptop pocket.',
        effective_goal:
          'I need a carry-on suitcase under $200, lightweight hard-shell, with a front laptop pocket.',
      },
    ],
  },
  {
    id: 'creator_non_beauty_camera',
    sources: ['creator_agent'],
    expect_beauty: false,
    turns: [
      {
        message: 'What camera should a beginner lifestyle creator buy?',
      },
      {
        message: 'They mostly shoot short-form video at home and want easy autofocus.',
        effective_goal:
          'Recommend a beginner lifestyle creator camera for short-form home video with easy autofocus.',
      },
    ],
  },
]);

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    outDir: DEFAULT_OUT_DIR,
    rounds: 1,
    timeoutMs: Number(process.env.CELESTIAL_COMMERCE_BEAUTY_MULTITURN_TIMEOUT_MS || 25000),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    const next = argv[index + 1];
    if (token === '--base-url' && next) args.baseUrl = String(next);
    if (token === '--out-dir' && next) args.outDir = path.resolve(String(next));
    if (token === '--rounds' && next) args.rounds = Math.max(1, Number(next) || 1);
    if (token === '--timeout-ms' && next) args.timeoutMs = Math.max(1000, Number(next) || 25000);
  }
  return args;
}

function text(value) {
  return String(value || '').trim();
}

function normalizeText(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value, fallback = null) {
  if (value == null) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function utcTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeId(value) {
  return text(value)
    .replace(/[^a-z0-9_-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmpty(...value);
      if (nested) return nested;
      continue;
    }
    const token = text(value);
    if (token) return token;
  }
  return '';
}

function unique(values = []) {
  return Array.from(new Set(asArray(values).map((item) => text(item)).filter(Boolean)));
}

function containsAny(haystack, needles = []) {
  const normalized = normalizeText(haystack);
  if (!normalized) return false;
  return asArray(needles)
    .map((needle) => normalizeText(needle))
    .filter(Boolean)
    .some((needle) => normalized.includes(needle));
}

function toEnvKey(input) {
  return text(input)
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'DEFAULT';
}

function resolveAuth(profile = 'default') {
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
    headers,
    missing: Object.keys(headers).length === 0,
  };
}

function mergeBeautyRequest(previous = {}, next = {}, userGoal = '') {
  return {
    domain: 'beauty',
    ...(clone(previous, {}) || {}),
    ...(clone(next, {}) || {}),
    user_goal: userGoal || next.user_goal || previous.user_goal || null,
    skin_context: {
      ...(previous.skin_context || {}),
      ...(next.skin_context || {}),
    },
    routine_context: {
      ...(previous.routine_context || {}),
      ...(next.routine_context || {}),
    },
    product_context: {
      ...(previous.product_context || {}),
      ...(next.product_context || {}),
    },
    scenario_context: {
      ...(previous.scenario_context || {}),
      ...(next.scenario_context || {}),
    },
    constraints: {
      ...(previous.constraints || {}),
      ...(next.constraints || {}),
    },
  };
}

function buildContext({ source, testCase, turn, previousBeautyRequest, messages }) {
  const expectedBeauty = testCase.expect_beauty !== false;
  const goal = text(turn.effective_goal || turn.message);
  const beautyRequest = expectedBeauty
    ? mergeBeautyRequest(previousBeautyRequest || {}, turn.beauty_request || {}, goal)
    : null;
  return {
    source_profile: {
      source,
      default_entry_layer: expectedBeauty ? 'orchestration' : 'decisioning',
    },
    task_type: 'discovery',
    vertical: expectedBeauty ? 'beauty' : null,
    category: expectedBeauty ? 'skincare' : null,
    raw_user_goal: goal,
    normalized_need: beautyRequest ? { beauty_request: beautyRequest } : { query: goal },
    conversation_state: {
      messages: messages.slice(-8),
      turn_count: messages.length,
    },
    decision_state: {},
    execution_state: {},
  };
}

function buildRequest({ source, testCase, turn, previousBeautyRequest, messages }) {
  const expectedBeauty = testCase.expect_beauty !== false;
  const context = buildContext({ source, testCase, turn, previousBeautyRequest, messages });
  const query = text(turn.effective_goal || turn.message);
  const metadata = {
    source,
    allow_orchestration_delegate: true,
    requested_projection: 'normalized_only',
    ...(expectedBeauty ? { beauty_domain_hint: 'beauty', catalog_surface: 'beauty' } : {}),
  };
  return {
    operation: 'find_products_multi',
    payload: {
      search: {
        query,
        limit: 6,
        in_stock_only: true,
        ...(expectedBeauty ? { catalog_surface: 'beauty' } : {}),
      },
      context,
    },
    context,
    metadata,
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
    return {
      ok: true,
      status: response.status,
      body: json,
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
      elapsed_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function productTitle(product = {}) {
  return firstNonEmpty(
    product.title,
    product.name,
    product.display_name,
    product.product_name,
  );
}

function extractProducts(body = {}) {
  const rows = [];
  if (Array.isArray(body.products)) rows.push(...body.products.filter(isPlainObject));
  for (const card of asArray(body.cards || body.cards_v1 || body.chat_cards)) {
    for (const section of asArray(card?.sections)) {
      for (const product of asArray(section?.products)) {
        if (isPlainObject(product)) rows.push(product);
      }
    }
  }
  return rows;
}

function extractBundleProducts(beautyExpert = null) {
  return [
    ...asArray(beautyExpert?.reco_bundle?.lead_picks),
    ...asArray(beautyExpert?.reco_bundle?.support_picks),
  ].filter(isPlainObject);
}

function normalizeResponse(body = {}, requestBody = {}, source = '') {
  const beautyExpert = isPlainObject(body.beauty_expert_v1) ? body.beauty_expert_v1 : null;
  const bundleProducts = extractBundleProducts(beautyExpert);
  const rawProducts = extractProducts(body);
  const lead = bundleProducts.length > 0 ? bundleProducts.slice(0, 1) : rawProducts.slice(0, 1);
  const support = bundleProducts.length > 0 ? bundleProducts.slice(1, 4) : rawProducts.slice(1, 4);
  return {
    requested_layer: resolveInvokeRequestedLayerWithInput('find_products_multi', source, {
      payload: requestBody.payload,
      metadata: requestBody.metadata,
    }),
    actual_layer: firstNonEmpty(body.layer, body.entry_layer, beautyExpert?.delegation_trace?.entry_layer) || null,
    beauty_expert_v1: Boolean(beautyExpert),
    mode: beautyExpert?.mode || null,
    delegated_layer: firstNonEmpty(beautyExpert?.delegation_trace?.delegated_layer, body.delegated_layer) || null,
    lead_pick_titles: lead.map(productTitle).filter(Boolean),
    support_pick_titles: support.map(productTitle).filter(Boolean),
    raw_product_titles: rawProducts.map(productTitle).filter(Boolean),
    compare_axes: unique(asArray(beautyExpert?.compare_axes).map((axis) => firstNonEmpty(axis?.label, axis))),
    next_actions: unique(asArray(beautyExpert?.next_actions || body.next_actions).map((action) => firstNonEmpty(action?.type, action?.action_type))),
    reply: firstNonEmpty(
      body.reply,
      body.assistant,
      body.message,
      body.assistant_message?.content,
    ),
    reply_mode: firstNonEmpty(body.reply_mode, body.meta?.reply_mode),
    mainline_status: firstNonEmpty(body.mainline_status, body.metadata?.mainline_status),
    beauty_intent: clone(beautyExpert?.beauty_intent, null),
  };
}

function inferNonBeautyDomainRule(goal = '') {
  return NON_BEAUTY_DOMAIN_RULES.find((rule) => containsAny(goal, rule.intent)) || null;
}

function productDomainFailures({ testCase, turn, normalized }) {
  if (testCase.expect_beauty !== false) return [];
  const productText = [
    ...normalized.lead_pick_titles,
    ...normalized.support_pick_titles,
    ...normalized.raw_product_titles,
  ].join(' | ');
  const failures = [];
  if (containsAny(productText, BEAUTY_PRODUCT_TERMS)) failures.push('non_beauty_false_positive');
  const rule = inferNonBeautyDomainRule(turn.effective_goal || turn.message);
  if (rule && normalized.raw_product_titles.length > 0) {
    const aligned = normalized.raw_product_titles.some((title) => containsAny(title, rule.product));
    if (!aligned) failures.push('non_beauty_false_positive');
  }
  return failures;
}

function classifyTurn({ testCase, turn, normalized, response }) {
  const failures = [];
  const expectedBeauty = testCase.expect_beauty !== false;
  const reply = normalized.reply || '';
  const normalizedReply = normalizeText(reply);
  const productCount = normalized.lead_pick_titles.length + normalized.support_pick_titles.length;

  if (!response.ok || response.status === 0 || response.status >= 500) failures.push('latency_or_timeout');
  if (expectedBeauty && !normalized.beauty_expert_v1) failures.push('beauty_route_miss');
  if (!expectedBeauty && normalized.beauty_expert_v1) failures.push('non_beauty_false_positive');
  if (expectedBeauty && normalized.requested_layer !== 'orchestration') failures.push('beauty_route_miss');
  if (turn.expected_mode && normalized.mode !== turn.expected_mode) failures.push('beauty_mode_miss');
  if (expectedBeauty && turn.expected_mode !== 'guided_beauty_reco' && productCount === 0) {
    failures.push('beauty_truth_split');
  }
  if (expectedBeauty && productCount > 1 && normalized.compare_axes.length === 0) {
    failures.push('beauty_truth_split');
  }
  if (turn.expect_no_products && productCount > 0) failures.push('clarify_policy_miss');
  if (
    asArray(turn.expected_next_actions_any).length > 0 &&
    !turn.expected_next_actions_any.some((expected) => normalized.next_actions.includes(expected))
  ) {
    failures.push('clarify_policy_miss');
  }
  if (
    turn.require_clarify_copy &&
    !/\b(more context|skin analysis|skin type|routine|climate|budget|tell me|share)\b/i.test(reply)
  ) {
    failures.push('clarify_policy_miss');
  }
  if (
    turn.require_tradeoff_copy &&
    !/\b(compared with|tradeoff|versus|instead of|while|whereas|better if|leans)\b/i.test(reply)
  ) {
    failures.push('content_quality_miss');
  }
  if (
    turn.require_creator_copy &&
    !/\b(creator|audience|roundup|content|feature|followers|viewers)\b/i.test(reply)
  ) {
    failures.push('content_quality_miss');
  }
  const expectedVisibleTermsAll = asArray(turn.expected_visible_terms_all).map((item) => text(item)).filter(Boolean);
  if (
    expectedVisibleTermsAll.length > 0 &&
    !expectedVisibleTermsAll.every((term) => normalizedReply.includes(normalizeText(term)))
  ) {
    failures.push('content_quality_miss');
  }
  if (
    expectedBeauty &&
    reply &&
    /^here are some more suitable picks based on your request\.?$/i.test(reply.trim())
  ) {
    failures.push('content_quality_miss');
  }
  if (INTERNAL_TERMS.some((term) => normalizedReply.includes(normalizeText(term)))) {
    failures.push('content_quality_miss');
  }
  failures.push(...productDomainFailures({ testCase, turn, normalized }));
  return unique(failures);
}

function writeRawArtifact(outDir, runId, request, response, normalized, failures) {
  const rawDir = path.join(outDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const artifactPath = path.join(rawDir, `${sanitizeId(runId)}.json`);
  fs.writeFileSync(
    artifactPath,
    JSON.stringify({ request, response, normalized, failure_classes: failures }, null, 2),
    'utf8',
  );
  return artifactPath;
}

async function runTurn({ args, outDir, source, testCase, turn, roundIndex, turnIndex, messages, previousBeautyRequest }) {
  messages.push({ role: 'user', content: turn.message });
  const requestBody = buildRequest({ source, testCase, turn, previousBeautyRequest, messages });
  const auth = resolveAuth('default');
  const endpoint = source === 'creator_agent' ? '/agent/creator/v1/invoke' : '/agent/shop/v1/invoke';
  const runId = `${testCase.id}_${source}_round_${roundIndex}_turn_${turnIndex}`;
  if (auth.missing) {
    const normalized = {
      requested_layer: resolveInvokeRequestedLayerWithInput('find_products_multi', source, {
        payload: requestBody.payload,
        metadata: requestBody.metadata,
      }),
      actual_layer: null,
      beauty_expert_v1: false,
      mode: null,
      delegated_layer: null,
      lead_pick_titles: [],
      support_pick_titles: [],
      raw_product_titles: [],
      compare_axes: [],
      next_actions: [],
      reply: '',
      reply_mode: null,
      mainline_status: null,
      beauty_intent: null,
    };
    const response = {
      ok: false,
      status: 0,
      body: { error: 'AUTH_MISSING', message: 'missing staging invoke auth' },
      elapsed_ms: 0,
    };
    const artifactPath = writeRawArtifact(outDir, runId, requestBody, response, normalized, ['latency_or_timeout']);
    return {
      turn_index: turnIndex,
      request: {
        source,
        endpoint,
        message: turn.message,
        effective_goal: turn.effective_goal || turn.message,
      },
      response,
      normalized,
      failure_classes: [],
      skipped: 'missing_auth',
      artifact_path: artifactPath,
      next_beauty_request: previousBeautyRequest || turn.beauty_request || null,
    };
  }

  const response = await requestJson(
    `${args.baseUrl.replace(/\/+$/, '')}${endpoint}`,
    requestBody,
    {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...auth.headers,
    },
    args.timeoutMs,
  );
  const normalized = normalizeResponse(response.body, requestBody, source);
  const failures = classifyTurn({ testCase, turn, normalized, response });
  const artifactPath = writeRawArtifact(outDir, runId, requestBody, response, normalized, failures);
  messages.push({ role: 'assistant', content: normalized.reply || JSON.stringify({
    mode: normalized.mode,
    lead: normalized.lead_pick_titles,
    support: normalized.support_pick_titles,
  }) });
  return {
    turn_index: turnIndex,
    request: {
      source,
      endpoint,
      message: turn.message,
      effective_goal: turn.effective_goal || turn.message,
    },
    response: {
      ok: response.ok,
      status: response.status,
      elapsed_ms: response.elapsed_ms,
    },
    normalized,
    failure_classes: failures,
    skipped: null,
    artifact_path: artifactPath,
    next_beauty_request: normalized.beauty_intent || previousBeautyRequest || turn.beauty_request || null,
  };
}

async function runCaseSurface({ args, outDir, testCase, source, roundIndex }) {
  const messages = [];
  let previousBeautyRequest = null;
  const turns = [];
  for (const [index, turn] of testCase.turns.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runTurn({
      args,
      outDir,
      source,
      testCase,
      turn,
      roundIndex,
      turnIndex: index + 1,
      messages,
      previousBeautyRequest,
    });
    previousBeautyRequest = result.next_beauty_request;
    turns.push(result);
  }
  return {
    case_id: testCase.id,
    source,
    round_index: roundIndex,
    turns,
    failed: turns.some((turn) => turn.failure_classes.length > 0),
    skipped: turns.every((turn) => turn.skipped),
  };
}

function summarize(runs) {
  const failureBuckets = {};
  let totalTurns = 0;
  let failedTurns = 0;
  let skippedTurns = 0;
  const perSource = {};
  for (const run of runs) {
    if (!perSource[run.source]) {
      perSource[run.source] = { runs: 0, turns: 0, failed_turns: 0, skipped_turns: 0 };
    }
    perSource[run.source].runs += 1;
    for (const turn of run.turns) {
      totalTurns += 1;
      perSource[run.source].turns += 1;
      if (turn.skipped) {
        skippedTurns += 1;
        perSource[run.source].skipped_turns += 1;
      }
      if (turn.failure_classes.length > 0) {
        failedTurns += 1;
        perSource[run.source].failed_turns += 1;
      }
      for (const failure of turn.failure_classes) {
        if (!failureBuckets[failure]) failureBuckets[failure] = [];
        failureBuckets[failure].push(`${run.case_id}:${run.source}:round${run.round_index}:turn${turn.turn_index}`);
      }
    }
  }
  return {
    generated_at: new Date().toISOString(),
    total_runs: runs.length,
    total_turns: totalTurns,
    failed_turns: failedTurns,
    skipped_turns: skippedTurns,
    per_source: perSource,
    failure_buckets: Object.fromEntries(
      Object.entries(failureBuckets).map(([key, values]) => [key, Array.from(new Set(values))]),
    ),
  };
}

function writeReports(outDir, args, summary, runs) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'celestial_commerce_beauty_cross_agent_multiturn_live.json');
  const mdPath = path.join(outDir, 'celestial_commerce_beauty_cross_agent_multiturn_live.md');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ args, summary, runs }, null, 2),
    'utf8',
  );

  const lines = [
    '# Celestial Commerce Beauty Cross-Agent Multi-Turn Live Matrix',
    '',
    `- Generated at: ${summary.generated_at}`,
    `- Base URL: ${args.baseUrl}`,
    `- Runs: ${summary.total_runs}`,
    `- Turns: ${summary.total_turns}`,
    `- Failed turns: ${summary.failed_turns}`,
    `- Skipped turns: ${summary.skipped_turns}`,
    '',
    '## Failure Buckets',
    '',
    '| Failure class | Count | Locations |',
    '| --- | ---: | --- |',
    ...Object.entries(summary.failure_buckets).map(
      ([key, values]) => `| ${key} | ${values.length} | ${values.join(', ')} |`,
    ),
    ...(Object.keys(summary.failure_buckets).length === 0 ? ['| - | 0 | - |'] : []),
    '',
    '## Per Source',
    '',
    '| Source | Runs | Turns | Failed turns | Skipped turns |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.per_source).map(
      ([key, value]) => `| ${key} | ${value.runs} | ${value.turns} | ${value.failed_turns} | ${value.skipped_turns} |`,
    ),
    '',
    '## Actual Outputs',
    '',
  ];

  for (const run of runs) {
    lines.push(`### ${run.case_id} / ${run.source} / round ${run.round_index}`);
    lines.push('');
    for (const turn of run.turns) {
      lines.push(`- Turn ${turn.turn_index}: ${turn.request.message}`);
      lines.push(`  - effective_goal: ${turn.request.effective_goal}`);
      lines.push(`  - status: ${turn.response.status || 'n/a'} (${turn.response.elapsed_ms || 0} ms)`);
      lines.push(`  - requested_layer: ${turn.normalized.requested_layer || 'n/a'}`);
      lines.push(`  - actual_layer: ${turn.normalized.actual_layer || 'n/a'}`);
      lines.push(`  - beauty_expert_v1: ${turn.normalized.beauty_expert_v1}`);
      lines.push(`  - mode: ${turn.normalized.mode || 'n/a'}`);
      lines.push(`  - lead: ${turn.normalized.lead_pick_titles.join(' | ') || 'n/a'}`);
      lines.push(`  - support: ${turn.normalized.support_pick_titles.join(' | ') || 'n/a'}`);
      lines.push(`  - raw_products: ${turn.normalized.raw_product_titles.join(' | ') || 'n/a'}`);
      lines.push(`  - axes: ${turn.normalized.compare_axes.join(' | ') || 'n/a'}`);
      lines.push(`  - next_actions: ${turn.normalized.next_actions.join(' | ') || 'n/a'}`);
      lines.push(`  - failures: ${turn.failure_classes.join(' | ') || 'none'}`);
      lines.push(`  - reply: ${turn.normalized.reply || 'n/a'}`);
      lines.push(`  - artifact: \`${turn.artifact_path}\``);
    }
    lines.push('');
  }

  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.outDir, utcTag());
  const runs = [];
  for (let round = 1; round <= args.rounds; round += 1) {
    for (const testCase of CASES) {
      for (const source of testCase.sources) {
        // eslint-disable-next-line no-await-in-loop
        runs.push(await runCaseSurface({ args, outDir, testCase, source, roundIndex: round }));
      }
    }
  }
  const summary = summarize(runs);
  const { jsonPath, mdPath } = writeReports(outDir, args, summary, runs);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        summary,
        json_path: jsonPath,
        markdown_path: mdPath,
        out_dir: outDir,
      },
      null,
      2,
    )}\n`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  CASES,
  buildRequest,
  normalizeResponse,
  classifyTurn,
  summarize,
};
