'use strict';

// The direct reco lane (consumer POST /v1/reco/generate and the agent-door tool `recommend_products`,
// both entryType 'direct') used to prompt the LLM with `candidates: []` and only run catalog recall
// afterwards, when the answer was missing / schema_invalid / empty. A fluent, entirely invented answer
// therefore SUPPRESSED recall, and the caller got archetypes with no product_id and no price.
//
// These tests drive the three pieces of the fix:
//   1. `legacyRecoMainlineExecution` — recall runs BEFORE the LLM on the direct lane, and the chat lane
//      is byte-identical to before.
//   2. `recoTargetStep` — bare "exfoliant" is in the treatment vocabulary.
//   3. `buildRecoNeedSeedQueries` / `buildRecoCatalogQueries` — the generic ladder is seeded from the
//      need text instead of only the static ['cleanser','moisturizer','sunscreen'] base.
//
// `legacyRecoMainlineExecution` is a dependency-free DI factory (its module body has zero requires), so
// every dep below is a fake and no network, DB, or LLM is touched.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLegacyRecoMainlineExecutionRuntime,
  isDirectRecoEntryType,
  shouldRecoverFullyUngroundedDirectAnswer,
} = require('../src/auroraBff/legacyRecoMainlineExecution');
const {
  normalizeRecoTargetStep,
  resolveRecoTargetStepIntent,
} = require('../src/auroraBff/recoTargetStep');
const { __internal } = require('../src/auroraBff/routes');

const CATALOG_POOL = [
  { product_id: 'prod_1', merchant_id: 'm1', name: 'Gentle PHA Exfoliant', price: 28 },
  { product_id: 'prod_2', merchant_id: 'm1', name: 'Mild Lactic Acid Toner', price: 34 },
];

function makeDeps(overrides = {}) {
  const calls = {
    catalog: [],
    promptStates: [],
    llm: 0,
  };
  const deps = {
    calls,
    pickFirstTrimmed: (...values) =>
      values.map((v) => String(v == null ? '' : v).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async (args) => {
      calls.catalog.push(args);
      return {
        structured: { recommendations: [{ product_id: 'prod_1', name: 'Gentle PHA Exfoliant' }] },
        candidate_pool: CATALOG_POOL,
        candidate_pool_state: { selected_candidate_count: 2, terminal_success: true },
        debug: { ok_count: 2, query_count: 2 },
      };
    },
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: (args) => {
      calls.promptStates.push(args);
      return {
        promptBundle: { prompt_spec: { template_id: 't', llm_mode: null }, schema_chars: 0 },
        query: 'q',
        promptContract: { ok: true, issues: [] },
        llmTraceSeed: {},
      };
    },
    runRecoLlmPrimary: async () => {
      calls.llm += 1;
      return {
        upstream: null,
        contextMeta: {},
        upstreamFailureCode: '',
        llmFailureClass: '',
        llmLatencyMs: 10,
        answerJson: null,
        // A fluent answer with NO product identity — exactly the archetype shape.
        llmStructured: { recommendations: [{ name: 'A gentle exfoliating treatment' }] },
        llmStructuredSource: 'llm_primary',
        llmTrace: {},
        llmInvoked: true,
        initialLlmOutcome: 'success',
      };
    },
    resolveConcernMainlineFailure: () => ({}),
    resolveRecoEffectiveFailure: () => ({}),
    normalizeRecoFailureClass: (v) => String(v || '').trim().toLowerCase(),
    hasEmptyStructuredRecommendations: (structured) =>
      !structured ||
      !Array.isArray(structured.recommendations) ||
      structured.recommendations.length === 0,
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: () => {},
    ...overrides,
  };
  return deps;
}

function baseArgs(overrides = {}) {
  return {
    frameworkCatalogFirstEnabled: false,
    deterministicCatalogFirstEnabled: false,
    targetContext: { step_aware_intent: false, framework_roles: [] },
    recommendationTaskContext: null,
    profileSummary: null,
    normalizedIngredientContext: null,
    ctx: { lang: 'EN' },
    entryType: 'direct',
    userAsk: 'a gentle exfoliant for sensitive skin under $40',
    prefix: '',
    recentLogs: [],
    globalStatus: {},
    mainlineStageTimingsMs: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Recall runs before the LLM on the direct lane
// ---------------------------------------------------------------------------

test('direct lane: catalog recall runs BEFORE the LLM and the pool reaches the prompt', async () => {
  const deps = makeDeps();
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  const out = await runLegacyRecoMainlineExecution(baseArgs());

  assert.equal(deps.calls.catalog.length, 1, 'catalog recall must run exactly once');
  assert.equal(deps.calls.promptStates.length, 1);
  // Mutant killed: "pass catalogCandidatePool (still []) into buildRecoLlmPromptState" — i.e. leaving
  // the pre-LLM recall out, or running it after the prompt is built.
  assert.deepEqual(
    deps.calls.promptStates[0].candidates,
    CATALOG_POOL,
    'the LLM prompt must carry the recalled candidates, not an empty pool',
  );
  assert.equal(out.directRecallBeforeLlmApplied, true);
  assert.equal(deps.calls.llm, 1);
});

test('direct lane: the pre-LLM recall is seeded with the need text and a bounded query budget', async () => {
  const deps = makeDeps();
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  await runLegacyRecoMainlineExecution(baseArgs());

  const call = deps.calls.catalog[0];
  // Mutant killed: "drop needSeedText" — the generic ladder then falls back to the static
  // ['cleanser','moisturizer','sunscreen'] base, which cannot retrieve an exfoliant.
  assert.equal(call.needSeedText, 'a gentle exfoliant for sensitive skin under $40');
  // Mutant killed: "drop maxGenericQueries" — an unbounded pre-LLM fan-out on the request path.
  assert.equal(call.maxGenericQueries, 3);
});

test('direct lane: the kill switch restores the old empty-pool prompt exactly', async () => {
  const deps = makeDeps();
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  const out = await runLegacyRecoMainlineExecution(
    baseArgs({ RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED: false }),
  );

  // Mutant killed: "ignore RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED" / "default it to true inside the
  // branch condition" — ops must be able to turn this off without a deploy.
  assert.equal(deps.calls.catalog.length, 0);
  assert.deepEqual(deps.calls.promptStates[0].candidates, []);
  assert.equal(out.directRecallBeforeLlmApplied, false);
});

test('chat lane: behavior is unchanged — no recall before the LLM', async () => {
  const deps = makeDeps();
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  const out = await runLegacyRecoMainlineExecution(baseArgs({ entryType: 'chat' }));

  // Mutant killed: "run the pre-LLM recall for every entryType" — that changes the chat lane, which
  // this PR is explicitly not allowed to touch.
  assert.equal(deps.calls.catalog.length, 0, 'chat must not gain a pre-LLM recall');
  assert.deepEqual(deps.calls.promptStates[0].candidates, []);
  assert.equal(out.directRecallBeforeLlmApplied, false);
  assert.equal(out.structuredSource, 'llm_primary');
});

test('direct lane: an LLM success still reports llm_primary and does not adopt the catalog answer', async () => {
  const deps = makeDeps();
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  const out = await runLegacyRecoMainlineExecution(baseArgs());

  // Mutant killed: "absorb the pre-LLM result into catalogStructured unconditionally" — that flips
  // structuredSource for every successful direct request and misreports the lane.
  assert.equal(out.structuredSource, 'llm_primary');
  assert.equal(out.catalogStructured, null);
  assert.equal(out.catalogCandidateState, null);
  // ...but it is carried separately so the ungrounded-recovery pass can use it with no second search.
  assert.ok(out.preLlmCatalogStructured);
  assert.equal(out.preLlmCatalogStructured.recommendations.length, 1);
});

test('direct lane: an empty LLM answer recovers from the pre-LLM pool without a SECOND search', async () => {
  const deps = makeDeps({
    runRecoLlmPrimary: async () => ({
      upstream: null,
      contextMeta: {},
      upstreamFailureCode: '',
      llmFailureClass: 'empty_structured',
      llmLatencyMs: 10,
      answerJson: null,
      llmStructured: { recommendations: [] },
      llmStructuredSource: 'llm_primary',
      llmTrace: {},
      llmInvoked: true,
      initialLlmOutcome: 'empty_structured',
    }),
  });
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  const out = await runLegacyRecoMainlineExecution(baseArgs());

  // Mutant killed: "call buildRecoGenerateFromCatalog again in the recovery branch" — that doubles the
  // upstream cost for an answer already in hand.
  assert.equal(deps.calls.catalog.length, 1, 'recovery must reuse the pre-LLM recall');
  assert.equal(out.structuredSource, 'catalog_grounded');
  assert.equal(out.structured.recommendations.length, 1);
});

test('non-direct lane with an empty LLM answer still performs its own recovery search', async () => {
  const deps = makeDeps({
    runRecoLlmPrimary: async () => ({
      upstream: null,
      contextMeta: {},
      upstreamFailureCode: '',
      llmFailureClass: 'empty_structured',
      llmLatencyMs: 10,
      answerJson: null,
      llmStructured: { recommendations: [] },
      llmStructuredSource: 'llm_primary',
      llmTrace: {},
      llmInvoked: true,
      initialLlmOutcome: 'empty_structured',
    }),
  });
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime(deps);
  const out = await runLegacyRecoMainlineExecution(baseArgs({ entryType: 'chat' }));

  // Mutant killed: "gate the recovery search on directRecallBeforeLlmApplied" — that would delete
  // recovery entirely for the chat lane.
  assert.equal(deps.calls.catalog.length, 1);
  assert.equal(deps.calls.catalog[0].needSeedText, undefined);
  assert.equal(out.structuredSource, 'catalog_grounded');
});

test('isDirectRecoEntryType covers both direct doors and nothing else', () => {
  assert.equal(isDirectRecoEntryType('direct'), true);
  assert.equal(isDirectRecoEntryType('agent_tool'), true);
  assert.equal(isDirectRecoEntryType('DIRECT'), true);
  // Mutant killed: "treat every non-chat entryType as direct".
  assert.equal(isDirectRecoEntryType('chat'), false);
  assert.equal(isDirectRecoEntryType(''), false);
  assert.equal(isDirectRecoEntryType(null), false);
  assert.equal(isDirectRecoEntryType('framework'), false);
});

// ---------------------------------------------------------------------------
// 1b. "Non-empty but 100% ungrounded" is a recovery trigger
// ---------------------------------------------------------------------------

const UNGROUNDED = Object.freeze({
  enabled: true,
  entryType: 'direct',
  structuredSource: 'llm_primary',
  groundingApplied: true,
  groundedCount: 0,
  answerRecommendationCount: 3,
  catalogRecommendationCount: 2,
});

test('a fully ungrounded direct answer triggers recovery', () => {
  assert.equal(shouldRecoverFullyUngroundedDirectAnswer({ ...UNGROUNDED }), true);
  assert.equal(
    shouldRecoverFullyUngroundedDirectAnswer({ ...UNGROUNDED, entryType: 'agent_tool' }),
    true,
  );
});

test('recovery does NOT trigger for anything that is already handled or out of scope', () => {
  const cases = [
    // Mutant killed: "drop the kill switch check".
    [{ enabled: false }, 'kill switch off'],
    // Mutant killed: "apply to every lane" — chat must stay byte-identical.
    [{ entryType: 'chat' }, 'chat lane'],
    // Mutant killed: "trigger for any structuredSource" — a catalog answer would swap for itself.
    [{ structuredSource: 'catalog_grounded' }, 'already catalog grounded'],
    [{ structuredSource: 'catalog_transient_fallback' }, 'transient fallback'],
    [{ structuredSource: null }, 'no source'],
    // Mutant killed: "drop the groundingApplied check" — with grounding skipped (fail-fast open,
    // catalog disabled) grounded_count is 0 for reasons that say nothing about the answer.
    [{ groundingApplied: false }, 'grounding never ran'],
    // Mutant killed: "trigger on partially grounded" — >= 0 instead of === 0.
    [{ groundedCount: 1 }, 'partially grounded'],
    [{ groundedCount: 3 }, 'fully grounded'],
    // Mutant killed: "drop the non-empty check" — an EMPTY answer is already covered by the mainline
    // recovery gate; double-handling it would run recovery twice.
    [{ answerRecommendationCount: 0 }, 'empty answer'],
    // Mutant killed: "swap in an empty catalog answer" — that turns an ungrounded response into an
    // empty one, which is strictly worse for the caller.
    [{ catalogRecommendationCount: 0 }, 'nothing to swap in'],
  ];
  for (const [override, label] of cases) {
    assert.equal(
      shouldRecoverFullyUngroundedDirectAnswer({ ...UNGROUNDED, ...override }),
      false,
      `expected no recovery for: ${label}`,
    );
  }
});

test('recovery defaults are safe when the predicate is called with nothing', () => {
  // Mutant killed: "default enabled/entryType so a bare call returns true" — a mis-wired call site
  // must fail closed, not silently rewrite every response.
  assert.equal(shouldRecoverFullyUngroundedDirectAnswer(), false);
  assert.equal(shouldRecoverFullyUngroundedDirectAnswer({}), false);
});

// ---------------------------------------------------------------------------
// 2. Step vocabulary
// ---------------------------------------------------------------------------

test('bare "exfoliant" resolves to the treatment step', () => {
  // Mutant killed: reverting the vocabulary hunk. Before the fix the treatment patterns required
  // exfoliator | exfoliating treatment | liquid exfoliant | resurfacing treatment, so a bare
  // "exfoliant" fell through to generic.
  assert.equal(normalizeRecoTargetStep('exfoliant'), 'treatment');
  assert.equal(normalizeRecoTargetStep('exfoliants'), 'treatment');
  assert.equal(normalizeRecoTargetStep('exfoliators'), 'treatment');

  const resolved = resolveRecoTargetStepIntent({
    text: 'a gentle exfoliant for sensitive skin under $40',
  });
  assert.equal(resolved.resolved_target_step, 'treatment');
  assert.equal(resolved.resolved_target_step_confidence, 'high');
});

test('the exfoliant pattern is word-anchored and does not swallow neighbouring steps', () => {
  // Mutant killed: writing the pattern unanchored (/exfoliant/) — "exfoliating cleanser" would then
  // match two families and collapse to generic, silently widening the blast radius.
  assert.equal(normalizeRecoTargetStep('exfoliating cleanser'), 'cleanser');
  assert.equal(normalizeRecoTargetStep('cleanser'), 'cleanser');
  assert.equal(normalizeRecoTargetStep('moisturizer'), 'moisturizer');
  assert.equal(normalizeRecoTargetStep('sunscreen'), 'sunscreen');
});

// ---------------------------------------------------------------------------
// 3. Need-seeded generic queries
// ---------------------------------------------------------------------------

test('need-seed queries drop request boilerplate and price tails', () => {
  const queries = __internal.buildRecoNeedSeedQueries(
    'please recommend a gentle exfoliant for sensitive skin under $40',
  );
  assert.ok(queries.length >= 1 && queries.length <= 2, `bounded, got ${queries.length}`);
  // Mutant killed: "pass the raw sentence through" — "$40" and "under"/"recommend"/"please" are junk
  // tokens that defeat the phrase and all-token-coverage arms of the catalog search.
  for (const query of queries) {
    assert.ok(!/\$|\bunder\b|\brecommend\b|\bplease\b|\bfor\b/.test(query), `junk in "${query}"`);
  }
  assert.ok(queries[0].includes('exfoliant'), 'the product-type noun must survive');
});

test('need-seed queries are capped at 2 and never exceed the bound', () => {
  const queries = __internal.buildRecoNeedSeedQueries(
    'a gentle fragrance free lightweight hydrating exfoliant for sensitive dehydrated skin',
    { maxQueries: 2 },
  );
  // Mutant killed: "return every generated variant" — this runs on the request path before the LLM.
  assert.ok(queries.length <= 2, `expected <= 2, got ${queries.length}`);
});

test('need-seed queries are empty for empty input', () => {
  assert.deepEqual(__internal.buildRecoNeedSeedQueries(''), []);
  assert.deepEqual(__internal.buildRecoNeedSeedQueries(null), []);
  // Mutant killed: "emit a query for a boilerplate-only ask" — a pure-stopword ask has no signal, and
  // an empty-string query would be a wasted upstream call.
  assert.deepEqual(__internal.buildRecoNeedSeedQueries('please recommend some products for me'), []);
});

test('the generic ladder puts need-derived queries in FRONT of the static base', () => {
  const queries = __internal.buildRecoCatalogQueries({
    profileSummary: null,
    lang: 'EN',
    ingredientContext: null,
    needSeedText: 'a gentle exfoliant for sensitive skin under $40',
    maxQueries: 3,
  });
  assert.equal(queries.length, 3);
  // Mutant killed: "append the need seeds instead of unshifting them" — with maxQueries=3 the static
  // cleanser/moisturizer/sunscreen base would consume every slot and the need would never be searched.
  assert.ok(queries[0].query.includes('exfoliant'), `got "${queries[0].query}"`);
  assert.ok(
    !['cleanser', 'moisturizer', 'sunscreen'].includes(queries[0].query.toLowerCase()),
    'the static base must not occupy the first slot when a need is supplied',
  );
});

test('the generic ladder is unchanged when no need text is supplied', () => {
  const queries = __internal.buildRecoCatalogQueries({
    profileSummary: null,
    lang: 'EN',
    ingredientContext: null,
  });
  // Mutant killed: "seed need queries from something other than needSeedText" (e.g. always-on
  // profile text) — every existing caller must keep its current ladder byte-for-byte.
  assert.deepEqual(
    queries.map((q) => q.query),
    ['cleanser', 'moisturizer', 'sunscreen'],
  );
});

test('maxQueries only ever narrows the ladder; 0 means the historical cap of 8', () => {
  const unbounded = __internal.buildRecoCatalogQueries({
    profileSummary: { goal_primary: 'acne', goals: ['hydration'] },
    lang: 'EN',
    ingredientContext: null,
  });
  const bounded = __internal.buildRecoCatalogQueries({
    profileSummary: { goal_primary: 'acne', goals: ['hydration'] },
    lang: 'EN',
    ingredientContext: null,
    maxQueries: 2,
  });
  // Mutant killed: "treat maxQueries=0 as 0 queries" — every existing caller passes nothing.
  assert.ok(unbounded.length > 2, `expected the historical ladder, got ${unbounded.length}`);
  assert.equal(bounded.length, 2);
  assert.deepEqual(bounded.map((q) => q.query), unbounded.slice(0, 2).map((q) => q.query));
});
