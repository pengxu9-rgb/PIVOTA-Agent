'use strict';

// WHAT HAPPENED TO THE LLM LEG — as a recorded fact rather than something you infer from
// latency. On 2026-09-09 the decision service rejected an unregistered PROMPT_TEMPLATE_ID
// with HTTP 400 on every call of the `recommend_products` door. The lane recorded that as
// `error_class: 'empty_structured'` / `mainline_status: 'empty_structured'` — "the model
// answered nothing" — answered from its catalog path, and returned plausible products. The
// only tell in prod was latency: ~6s with the leg alive, ~2.5s without.
//
// Measured on the tree before this change, driving the real lane with the client stubbed:
//
//   HTTP 400 rejection      error_class=empty_structured  mainline_status=empty_structured
//   base URL not configured error_class=empty_structured  mainline_status=empty_structured
//   model declines in schema error_class=empty_structured mainline_status=empty_structured
//
// Three different things, one record. These tests pin them apart.
//
// SCOPE, stated because the PR header originally overstated it: this fixes `error_class` and adds
// `llm_leg`. It does NOT fix `mainline_status`, which still returns 'empty_structured' for all
// three — deriveRecoMainlineStatus has no branch for a non-transient upstream failure. For HTTP 4xx
// `failure_class` and `telemetry_failure_reason` go ABSENT for every NON-TRANSIENT throw — not
// just 4xx, which is how an earlier version of this note put it. A 5xx keeps them ('timeout' /
// 'timeout_degraded'). `upstream_failure_code` is now always non-empty, so a dimension exists for
// every throw, but the failure_class one is still missing and is filed rather than fixed.
//
// AND THE DOOR THE INCIDENT HAPPENED ON CARRIES NEITHER. recommend_products emits no
// reco_requested event and forwards `upstream_failure_code` only as products_empty_reason when the
// shortlist is EMPTY — which it was not, in the incident. On that door the only signals are the
// metric bucket and the pre-existing warn log, which did already carry 'Upstream status 400'. So
// "invisible" meant invisible to structured fields, not absent everywhere. And note what actually reaches telemetry: `upstream_failure_code` is on the
// reco_requested event; `llm_leg` is NOT (buildRecoLlmTraceRef whitelists three fields), so it
// lives only in the response body. Build an alert on the former.
//
// ORDERING MATTERS: routes.js destructures `auroraChat` at module load
// (`const { auroraChat } = require('./auroraDecisionClient')`), so the stub has to be in
// place BEFORE routes is required. Both are cleared from the cache per case.

process.env.AURORA_BFF_USE_MOCK = 'false';
process.env.USE_AURORA_BFF_MOCK = 'false';
process.env.AURORA_DECISION_BASE_URL = 'https://decision.test';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CLIENT_ID = require.resolve('../src/auroraBff/auroraDecisionClient');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');

const DECLINE_WARNING =
  'Makeup items such as bronzers are outside the skincare domain boundary and were excluded.';

function withStubbedLlm(impl, fn) {
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const original = client.auroraChat;
  client.auroraChat = impl;
  try {
    return fn(require('../src/auroraBff/routes').__internal);
  } finally {
    client.auroraChat = original;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
}

async function laneOutcome(impl) {
  return withStubbedLlm(impl, async (internal) => {
    const res = await internal.generateProductRecommendations({
      ctx: {
        request_id: 'req_prov', trace_id: 'trace_prov', aurora_uid: 'agent:test',
        lang: 'EN', trigger_source: 'agent_tool', state: null, backend_auth_headers: {},
      },
      profile: null, recentLogs: [],
      message: 'a bronzer for contouring my cheekbones',
      focus: 'a bronzer for contouring my cheekbones',
      includeAlternatives: false, debug: true, logger: null, budgetMs: 4000,
      entryType: 'direct', recoTriggerSource: 'agent_tool',
    });
    return res.llmTrace || {};
  });
}

const httpError = (status) => () => {
  const err = new Error(`Upstream status ${status}`);
  err.status = status;
  throw err;
};
const notConfigured = () => {
  const err = new Error('AURORA_DECISION_BASE_URL not configured');
  err.code = 'AURORA_NOT_CONFIGURED';
  throw err;
};
const answering = (payload) => async () => ({ answer: JSON.stringify(payload) });

test('a rejected leg, an unreachable leg and a declining model are three different records', async () => {
  const rejected = await laneOutcome(httpError(400));
  assert.equal(rejected.llm_leg.outcome, 'http_400', 'an HTTP rejection must name itself');
  assert.equal(rejected.llm_leg.upstream_status, 400);
  assert.equal(rejected.llm_leg.invoked, true, 'we did reach the wire; the far side refused');

  const unreachable = await laneOutcome(notConfigured);
  assert.equal(unreachable.llm_leg.outcome, 'not_configured');
  assert.equal(unreachable.llm_leg.upstream_status, null);

  const declined = await laneOutcome(answering({
    recommendations: [], confidence: 0.2, warnings: [DECLINE_WARNING], missing_info: ['Skin type'],
  }));
  assert.equal(declined.llm_leg.outcome, 'empty_structured',
    'a model that answers in schema with no items DECLINED — that is not an upstream failure');
  assert.equal(declined.llm_leg.upstream_status, null);

  const ok = await laneOutcome(answering({
    recommendations: [{ brand: 'X', name: 'Y', step: 'treatment', query_terms: ['salicylic acid'], reasons: ['r'] }],
    confidence: 0.7, warnings: [], missing_info: [],
  }));
  assert.equal(ok.llm_leg.outcome, 'ok');
  assert.equal(ok.llm_leg.invoked, true);

  // The whole point: all four must be mutually distinguishable.
  const outcomes = [rejected, unreachable, declined, ok].map((t) => t.llm_leg.outcome);
  assert.equal(new Set(outcomes).size, 4, `expected four distinct outcomes, got ${outcomes.join(', ')}`);

  // AND THE OLD RECORD MUST STOP LYING. `llm_leg` is a new field, so adding it alone would
  // leave every existing consumer reading the same wrong story: the relabel below the catch
  // rewrote a throw as `empty_structured` because only the transient branch set
  // llmFailureClass. A rejected leg must not claim the model returned an empty answer.
  assert.notEqual(rejected.error_class, 'empty_structured',
    'an upstream rejection is not the model answering nothing');
  assert.notEqual(unreachable.error_class, 'empty_structured');
  // The genuine decline still reports it, because that IS what happened.
  assert.equal(declined.error_class, 'empty_structured');
});

test('a 5xx is transient and a 4xx is ours — they must not read the same', async () => {
  const server = await laneOutcome(httpError(503));
  const client = await laneOutcome(httpError(422));
  assert.equal(server.llm_leg.outcome, 'http_503');
  assert.equal(client.llm_leg.outcome, 'http_422');
  // 5xx routes to the timeout-shaped story (retry is meaningful); 4xx does not, because the
  // request will keep being built the same wrong way until someone changes it.
  assert.equal(server.error_class, 'timeout');
  assert.notEqual(client.error_class, 'timeout');
});

test('a leg that was genuinely never invoked reports not_invoked, and invoked:false', async () => {
  // The real not-invoked path: the prompt contract fails its precheck and the call is never
  // made. Distinct from `not_configured`, where we DID attempt and the client refused —
  // `invoked` is about whether the wire was reached, and the earlier cases all assert true.
  const before = process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH;
  process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH = 'true';
  try {
    const trace = await laneOutcome(answering({ recommendations: [], warnings: [], missing_info: [] }));
    assert.equal(trace.llm_leg.invoked, false);
    assert.equal(trace.llm_leg.outcome, 'prompt_contract_mismatch');
  } finally {
    if (before === undefined) delete process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH;
    else process.env.AURORA_RECO_FORCE_PROMPT_CONTRACT_MISMATCH = before;
  }
});

const DECLINED = { recommendations: [], confidence: 0.2, warnings: [DECLINE_WARNING], missing_info: ['Skin type'] };

test('a DECLINE is served as the answer, and keeps its provenance', async () => {
  // REWRITTEN 2026-09-10. This test used to assert `structuredSource === 'catalog_grounded'` with
  // the comment "the catalog did replace the declined answer" — it pinned the defect. Measured in
  // prod that same day on the agent door: "a bronzer for contouring" returned three CLEANSERS with
  // the model's refusal pasted onto them as missing_info. The model was right and the lane
  // overrode it. The decline is now the answer; the catalog does not get to speak for it.
  const LLM_ANSWER = DECLINED;
  const LLM_FAILURE = 'empty_structured';
  const LLM_SOURCE = 'llm_answer_json';
  const { createLegacyRecoMainlineExecutionRuntime } = require('../src/auroraBff/legacyRecoMainlineExecution');
  const CATALOG = { recommendations: [{ product_id: 'p1', name: 'A Cleanser' }], warnings: [], missing_info: [] };
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime({
    pickFirstTrimmed: (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async () => ({ structured: CATALOG, candidate_pool: [{ product_id: 'p1' }], debug: {} }),
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({ promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] }, llmTraceSeed: {} }),
    runRecoLlmPrimary: async () => ({
      promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] },
      llmTrace: { error_class: LLM_FAILURE, llm_leg: { invoked: true, outcome: LLM_FAILURE, upstream_status: null, latency_ms: 5 } },
      // llmFailureClass 'empty_structured' is what makes the recovery block strip error_class;
      // with '' the strip never fires and this test would assert nothing about it.
      upstream: {}, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: LLM_FAILURE, llmLatencyMs: 5,
      answerJson: LLM_ANSWER, llmStructured: LLM_ANSWER, llmStructuredSource: LLM_SOURCE,
      initialLlmOutcome: LLM_FAILURE, llmInvoked: true,
    }),
    resolveConcernMainlineFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    resolveRecoEffectiveFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    normalizeRecoFailureClass: (v) => v || 'none',
    // Mirrors routes.js hasEmptyStructuredRecommendations exactly: a non-array `recommendations`
    // is SCHEMA-INVALID, not an empty answer. A looser fake would let the fixture disagree with
    // production about what counts as a decline — the whole distinction under test.
    hasEmptyStructuredRecommendations: (x) => Boolean(
      x && typeof x === 'object' && !Array.isArray(x)
      && Array.isArray(x.recommendations) && x.recommendations.length === 0,
    ),
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: () => {},
  });
  const out = await runLegacyRecoMainlineExecution({
    targetContext: { framework_roles: [] }, profileSummary: {}, debug: false, logger: null,
    ctx: { request_id: 'r', lang: 'EN' }, entryType: 'direct', userAsk: 'a bronzer for contouring',
    prefix: '', recentLogs: [], globalStatus: {}, mainlineStageTimingsMs: {},
  });
  assert.equal(out.structuredSource, 'llm_primary',
    'the model answered — "no" is an answer, and it is not the catalog\'s');
  assert.deepEqual(out.structured.recommendations, [],
    'the cleanser in the catalog must NOT become the answer to a bronzer request');
  assert.deepEqual(out.structured.warnings, [DECLINE_WARNING]);
  assert.deepEqual(out.structured.missing_info, ['Skin type']);
  // error_class is NOT stripped here, and that is right: the strip belongs to the recovery, and
  // nothing recovered. The sibling below covers the case where it does.
  assert.equal(out.llmTrace.error_class, 'empty_structured');
  assert.deepEqual(out.llmTrace.llm_leg, { invoked: true, outcome: 'empty_structured', upstream_status: null, latency_ms: 5 },
    'and the provenance survives either way');
});

test('a SCHEMA-INVALID answer lends nothing, even though it carries a warnings array', async () => {
  // Kills the mutant that passes `declined: true` unconditionally at the call site. A malformed
  // answer can still contain prose in `warnings`; presenting it as the reason a catalog
  // shortlist looks the way it does attributes a decision the model never made. The gate is
  // llmStructuredRecoEmpty, which requires recommendations to be an ARRAY of length 0.
  const LLM_ANSWER = { recommendations: 'not-an-array', warnings: ['half-written thought'], missing_info: ['Nope'] };
  const LLM_FAILURE = 'schema_invalid';
  const LLM_SOURCE = 'llm_answer_json';
  // The recovery block deletes `error_class` from the trace when the catalog rescues an empty
  // or schema-invalid answer — which was the last surviving hint that anything went wrong.
  // `llm_leg` must not be stripped with it, or the rescue erases the evidence all over again.
  const { createLegacyRecoMainlineExecutionRuntime } = require('../src/auroraBff/legacyRecoMainlineExecution');
  const CATALOG = { recommendations: [{ product_id: 'p1', name: 'A Cleanser' }], warnings: [], missing_info: [] };
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime({
    pickFirstTrimmed: (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async () => ({ structured: CATALOG, candidate_pool: [{ product_id: 'p1' }], debug: {} }),
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({ promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] }, llmTraceSeed: {} }),
    runRecoLlmPrimary: async () => ({
      promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] },
      llmTrace: { error_class: LLM_FAILURE, llm_leg: { invoked: true, outcome: LLM_FAILURE, upstream_status: null, latency_ms: 5 } },
      // llmFailureClass 'empty_structured' is what makes the recovery block strip error_class;
      // with '' the strip never fires and this test would assert nothing about it.
      upstream: {}, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: LLM_FAILURE, llmLatencyMs: 5,
      answerJson: LLM_ANSWER, llmStructured: LLM_ANSWER, llmStructuredSource: LLM_SOURCE,
      initialLlmOutcome: LLM_FAILURE, llmInvoked: true,
    }),
    resolveConcernMainlineFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    resolveRecoEffectiveFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    normalizeRecoFailureClass: (v) => v || 'none',
    // Mirrors routes.js hasEmptyStructuredRecommendations exactly: a non-array `recommendations`
    // is SCHEMA-INVALID, not an empty answer. A looser fake would let the fixture disagree with
    // production about what counts as a decline — the whole distinction under test.
    hasEmptyStructuredRecommendations: (x) => Boolean(
      x && typeof x === 'object' && !Array.isArray(x)
      && Array.isArray(x.recommendations) && x.recommendations.length === 0,
    ),
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: () => {},
  });
  const out = await runLegacyRecoMainlineExecution({
    targetContext: { framework_roles: [] }, profileSummary: {}, debug: false, logger: null,
    ctx: { request_id: 'r', lang: 'EN' }, entryType: 'direct', userAsk: 'a bronzer for contouring',
    prefix: '', recentLogs: [], globalStatus: {}, mainlineStageTimingsMs: {},
  });
  assert.equal(out.structuredSource, 'catalog_grounded', 'the catalog did replace the malformed answer');
  assert.deepEqual(out.structured.warnings, [], 'a malformed answer is not a considered refusal');
  assert.deepEqual(out.structured.missing_info, []);
});

// --- the decline carry -------------------------------------------------------------

const { carryRecoDeclineNotes } = require('../src/auroraBff/legacyRecoMainlineExecution');

test('a schema-invalid answer is not a decline, and lends nothing', () => {
  // `declined` must be gated on llmStructuredRecoEmpty — the model answering IN SCHEMA with an
  // empty list. A malformed answer may still carry a `warnings` array, but it is not a
  // considered refusal, and presenting its text as the reason a shortlist looks the way it
  // does would be attributing a decision the model never made.
  const catalog = { recommendations: [{ product_id: 'p1' }], warnings: [], missing_info: [] };
  const malformed = { recommendations: 'not-an-array', warnings: ['half-written thought'] };
  assert.equal(carryRecoDeclineNotes(catalog, { declined: false, declinedAnswer: malformed }), catalog);
});

test('a declined answer lends its reasons to whatever replaces it', () => {
  const catalog = { recommendations: [{ product_id: 'p1' }], warnings: [], missing_info: [] };
  const declined = { recommendations: [], warnings: [DECLINE_WARNING], missing_info: ['Skin type'] };
  const out = carryRecoDeclineNotes(catalog, { declined: true, declinedAnswer: declined });
  assert.deepEqual(out.warnings, [DECLINE_WARNING]);
  assert.deepEqual(out.missing_info, ['Skin type']);
  assert.deepEqual(out.recommendations, catalog.recommendations, 'the replacement still supplies the items');
});

test('nothing is carried when the model did not decline', () => {
  const catalog = { recommendations: [{ product_id: 'p1' }], warnings: [], missing_info: [] };
  const declined = { recommendations: [], warnings: [DECLINE_WARNING] };
  // A leg that threw has no reasons to lend; inventing them would be fabricating an
  // explanation the model never gave.
  assert.equal(carryRecoDeclineNotes(catalog, { declined: false, declinedAnswer: declined }), catalog);
  assert.equal(carryRecoDeclineNotes(catalog, { declined: true, declinedAnswer: null }), catalog);
  assert.equal(carryRecoDeclineNotes(null, { declined: true, declinedAnswer: declined }), null);
});

test("the replacement's own notes lead, and duplicates collapse", () => {
  const catalog = { recommendations: [{ id: 1 }], warnings: ['Catalog note'], missing_info: ['Budget'] };
  const declined = {
    recommendations: [],
    warnings: ['catalog note', DECLINE_WARNING],
    missing_info: ['budget', 'Skin type'],
  };
  const out = carryRecoDeclineNotes(catalog, { declined: true, declinedAnswer: declined });
  assert.deepEqual(out.warnings, ['Catalog note', DECLINE_WARNING]);
  assert.deepEqual(out.missing_info, ['Budget', 'Skin type']);
});

test('the carry is bounded and drops empty strings', () => {
  const many = Array.from({ length: 20 }, (_, i) => `note ${i}`);
  const out = carryRecoDeclineNotes(
    { recommendations: [], warnings: ['keep'], missing_info: [] },
    { declined: true, declinedAnswer: { recommendations: [], warnings: ['', '   ', ...many] } },
  );
  assert.equal(out.warnings.length, 8);
  assert.equal(out.warnings[0], 'keep');
  assert.ok(out.warnings.every((w) => w.trim() !== ''));
});

test('a routine mapped by OUR mapper is not a decline, and lends nothing', async () => {
  // The upstream answered 200 with a routine and no reco JSON, so llmStructured is
  // mapAuroraRoutineToRecoGenerate's output. That mapper SYNTHESIZES missing_info from our own
  // logic — 'routine_missing' when it cannot parse steps, 'budget_unknown' when no budget is set —
  // and it has an empty recommendations array, so the empty-array test alone calls it a decline.
  // normalize.js then promotes 'routine_missing' into user-visible warnings. Carrying it puts words
  // WE wrote into a healthy catalog answer, attributed to the model.
  const { createLegacyRecoMainlineExecutionRuntime } = require('../src/auroraBff/legacyRecoMainlineExecution');
  const MAPPED = { recommendations: [], missing_info: ['routine_missing', 'budget_unknown'], warnings: [] };
  const CATALOG = { recommendations: [{ product_id: 'p1', name: 'A Cleanser' }], warnings: [], missing_info: [] };
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime({
    pickFirstTrimmed: (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async () => ({ structured: CATALOG, candidate_pool: [{ product_id: 'p1' }], debug: {} }),
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({ promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] }, llmTraceSeed: {} }),
    runRecoLlmPrimary: async () => ({
      promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] },
      llmTrace: { llm_leg: { invoked: true, outcome: 'empty_structured', upstream_status: null, latency_ms: 5 } },
      upstream: {}, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: 'empty_structured', llmLatencyMs: 5,
      answerJson: null, llmStructured: MAPPED,
      // THE DISCRIMINATOR. Not 'llm_answer_json' — our mapper built this object, not the model.
      llmStructuredSource: 'llm_context_routine',
      initialLlmOutcome: 'empty_structured', llmInvoked: true,
    }),
    resolveConcernMainlineFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    resolveRecoEffectiveFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    normalizeRecoFailureClass: (v) => v || 'none',
    hasEmptyStructuredRecommendations: (x) => Boolean(
      x && typeof x === 'object' && !Array.isArray(x)
      && Array.isArray(x.recommendations) && x.recommendations.length === 0,
    ),
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: () => {},
  });
  const out = await runLegacyRecoMainlineExecution({
    targetContext: { framework_roles: [] }, profileSummary: {}, debug: false, logger: null,
    ctx: { request_id: 'r', lang: 'EN' }, entryType: 'direct', userAsk: 'a bronzer for contouring',
    prefix: '', recentLogs: [], globalStatus: {}, mainlineStageTimingsMs: {},
  });
  assert.equal(out.structuredSource, 'catalog_grounded');
  assert.deepEqual(out.structured.missing_info, [],
    "our mapper's synthesized codes must not travel as the model's reason for declining");
  assert.deepEqual(out.structured.warnings, []);
});

test('every throw is countable ON THE LANE — code and metric, for all four shapes', async () => {
  // The previous version of this called recordAuroraRecoLlmCall DIRECTLY, so it pinned the
  // allowlist and not the lane: deleting the emission at the call site was green. It also missed
  // that the emission was gated on `!llmFailureClass`, which made it unreachable for a 5xx — the
  // transient branch sets llmFailureClass = 'timeout' first, so a 503 recorded NOTHING and the
  // `upstream_timeout` token was dead on arrival.
  //
  // A blank `upstream_failure_code` is the other half: it was '' for AURORA_NOT_CONFIGURED and for
  // any unrecognised code, so a decision service that was DOWN produced no failure dimension at all
  // while products were still in the response — which reads as success.
  const metrics = require('../src/auroraBff/visionMetrics');
  const cases = [
    ['http 4xx', () => { const e = new Error('Upstream status 400'); e.status = 400; throw e; }, 'HTTP_400', 'upstream_dependency_failure'],
    ['http 5xx', () => { const e = new Error('Upstream status 503'); e.status = 503; throw e; }, 'HTTP_503', 'upstream_timeout'],
    ['not configured', () => { const e = new Error('nc'); e.code = 'AURORA_NOT_CONFIGURED'; throw e; }, 'NOT_CONFIGURED', 'upstream_dependency_failure'],
    ['unclassified', () => { const e = new Error('boom'); e.code = 'ECONNREFUSED'; throw e; }, 'UPSTREAM_ERROR', 'upstream_dependency_failure'],
  ];
  for (const [label, thrower, expectedCode, expectedOutcome] of cases) {
    const recorded = [];
    const original = metrics.recordAuroraRecoLlmCall;
    metrics.recordAuroraRecoLlmCall = (args) => { recorded.push(args && args.outcome); return original(args); };
    try {
      const res = await withStubbedLlm(async () => { thrower(); }, async (internal) => internal.generateProductRecommendations({
        ctx: { request_id: 'r', trace_id: 't', aurora_uid: 'agent:test', lang: 'EN', trigger_source: 'agent_tool', state: null, backend_auth_headers: {} },
        profile: null, recentLogs: [], message: 'x', focus: 'x', includeAlternatives: false,
        debug: true, logger: null, budgetMs: 4000, entryType: 'direct', recoTriggerSource: 'agent_tool',
      }));
      const meta = res?.norm?.payload?.recommendation_meta || {};
      assert.equal(meta.upstream_failure_code, expectedCode, `${label}: every throw needs a non-empty code`);
      assert.ok(recorded.includes(expectedOutcome), `${label}: expected ${expectedOutcome}, got ${JSON.stringify(recorded)}`);
    } finally {
      metrics.recordAuroraRecoLlmCall = original;
    }
  }
});

test('an upstream failure is counted as itself, not as the catch-all bucket', () => {
  // recordAuroraRecoLlmCall funnels through normalizeAuroraRecoLlmCallOutcome, whose allowlist did
  // not contain either upstream token — so the incident counted as 'provider_error', which is ALSO
  // that function's default for an unrecognised token. A bucket that means both "the upstream
  // refused us" and "we do not know what this is" cannot support an alert.
  const metrics = require('../src/auroraBff/visionMetrics');
  for (const outcome of ['upstream_dependency_failure', 'upstream_timeout']) {
    metrics.recordAuroraRecoLlmCall({ stage: 'main', outcome });
  }
  const rendered = metrics.renderVisionMetricsPrometheus();
  assert.match(rendered, /aurora_reco_llm_call_total\{stage="main",outcome="upstream_dependency_failure"\}/);
  assert.match(rendered, /aurora_reco_llm_call_total\{stage="main",outcome="upstream_timeout"\}/);
});

test('the provenance survives the catalog recovery that strips error_class', async () => {
  // The coverage the decline test above used to carry, now on a fixture where the recovery ACTUALLY
  // fires. `routine_mapped` is not the model's own account of recommending — the mapper synthesises
  // missing_info from our logic — so this is a genuine gap the catalog may fill, and the recovery
  // deletes `error_class` from the trace. `llm_leg` must not be deleted with it, or the rescue
  // erases the evidence that anything went wrong all over again.
  const { createLegacyRecoMainlineExecutionRuntime } = require('../src/auroraBff/legacyRecoMainlineExecution');
  const MAPPED_EMPTY = { recommendations: [], warnings: [], missing_info: ['routine_missing'] };
  const CATALOG = { recommendations: [{ product_id: 'p1', name: 'A Cleanser' }], warnings: [], missing_info: [] };
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime({
    pickFirstTrimmed: (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async () => ({ structured: CATALOG, candidate_pool: [{ product_id: 'p1' }], debug: {} }),
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({ promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] }, llmTraceSeed: {} }),
    runRecoLlmPrimary: async () => ({
      promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] },
      llmTrace: { error_class: 'empty_structured', llm_leg: { invoked: true, outcome: 'empty_structured', upstream_status: null, latency_ms: 5 } },
      upstream: {}, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: 'empty_structured', llmLatencyMs: 5,
      answerJson: MAPPED_EMPTY, llmStructured: MAPPED_EMPTY, llmStructuredSource: 'routine_mapped',
      initialLlmOutcome: 'empty_structured', llmInvoked: true,
    }),
    resolveConcernMainlineFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    resolveRecoEffectiveFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    normalizeRecoFailureClass: (v) => v || 'none',
    hasEmptyStructuredRecommendations: (x) => Boolean(
      x && typeof x === 'object' && !Array.isArray(x)
      && Array.isArray(x.recommendations) && x.recommendations.length === 0,
    ),
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: () => {},
  });
  const out = await runLegacyRecoMainlineExecution({
    targetContext: { framework_roles: [] }, profileSummary: {}, debug: false, logger: null,
    ctx: { request_id: 'r', lang: 'EN' }, entryType: 'direct', userAsk: 'what should i use',
    prefix: '', recentLogs: [], globalStatus: {}, mainlineStageTimingsMs: {},
  });

  assert.equal(out.structuredSource, 'catalog_grounded',
    'a gap the model did not author is still the catalog\'s to fill');
  assert.equal(out.structured.recommendations.length, 1);
  assert.deepEqual(out.structured.missing_info, [],
    'and nothing the mapper synthesised may be presented as the model\'s reasoning');
  assert.equal(out.llmTrace.error_class, undefined, 'the recovery still clears error_class');
  assert.deepEqual(out.llmTrace.llm_leg, { invoked: true, outcome: 'empty_structured', upstream_status: null, latency_ms: 5 },
    'but the provenance survives it');
});
