'use strict';

// A REFUSAL AND A BREAKAGE ARE DIFFERENT ANSWERS, and until now a partner agent could not tell them
// apart. #2173 made the lane honour a model decline instead of replacing it with catalog rows — so
// "a bronzer for contouring" stopped returning three cleansers. But the envelope it returns instead
// says almost nothing a machine can branch on:
//
//   structuredSource     'llm_primary'        — same as a served LLM answer
//   source_mode          'legacy_notice'      — the zero-length leaf of the sourceMode ladder
//   products_empty_reason'no_recommendations' — the same token as "the lane produced nothing"
//
// The reason survives only as prose in `missing_info`. The off-vertical gate already has a dedicated
// token for exactly this distinction (recommendProducts.js:805 → 'off_vertical'); a decline deserves
// one too, or a partner integration has to regex the model's English to decide whether to retry.

process.env.AURORA_BFF_USE_MOCK = 'false';
process.env.AURORA_DECISION_BASE_URL = 'https://decision.test';
// The decline contract belongs to reco_main_v1_3, and it is only honoured when that template is
// actually GRANTED — the wide id inherits the narrow one unless the env names a different template.
process.env.RECO_MAIN_WIDE_PROMPT_TEMPLATE_ID = 'reco_main_v1_3';

const test = require('node:test');
const assert = require('node:assert/strict');

const CLIENT_ID = require.resolve('../src/auroraBff/auroraDecisionClient');
const ROUTES_ID = require.resolve('../src/auroraBff/routes');

const DECLINE_REASON = 'The request asks for a bronzer, which falls under makeup.';

// Drives the REAL lane through the REAL agent bridge. The stub is the upstream, nothing else.
async function askAgentDoor(answer) {
  delete require.cache[ROUTES_ID];
  delete require.cache[CLIENT_ID];
  const client = require('../src/auroraBff/auroraDecisionClient');
  const original = client.auroraChat;
  client.auroraChat = async () => ({ answer: JSON.stringify(answer) });
  try {
    const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');
    const { __internal } = require('../src/auroraBff/routes');
    const handler = makeRecommendProducts({
      generate: __internal.generateProductRecommendations,
      isEnabled: () => true,
      budgetMs: 6000,
    });
    return await handler(
      { payload: { need: 'a bronzer for contouring my cheekbones, warm undertone' } },
      { agent_id: 'partner_test' },
    );
  } finally {
    client.auroraChat = original;
    delete require.cache[ROUTES_ID];
    delete require.cache[CLIENT_ID];
  }
}

test('a refusal reaches the partner as model_declined, not as "we produced nothing"', async () => {
  const out = await askAgentDoor({
    recommendations: [],
    confidence: 0.2,
    warnings: [],
    missing_info: [DECLINE_REASON],
  });

  assert.equal(out.signals.length, 0, 'the setup is a decline — nothing is served');
  assert.equal(out.metadata.products_empty_reason, 'model_declined',
    'the one field a partner agent can branch on must say the model refused');
  // The prose survives too — the token is what a machine reads, this is what a human reads.
  assert.ok((out.metadata.missing_info || []).includes(DECLINE_REASON),
    'and the reason itself is still carried, not replaced by the token');
});

test('a lane that simply produced nothing is NOT reported as a refusal', async () => {
  // THE CONTROL. Without it the fix could be "stamp model_declined on every empty shortlist", which
  // would relabel real failures as deliberate refusals — the opposite error, and a worse one: a
  // partner would stop retrying a lane that is actually broken.
  const out = await askAgentDoor({
    // A well-formed answer the model did NOT author as a refusal: no reason given at all.
    recommendations: [],
    confidence: 0.2,
    warnings: [],
    missing_info: [],
  });

  assert.equal(out.signals.length, 0);
  assert.notEqual(out.metadata.products_empty_reason, 'model_declined',
    'no stated reason is not a refusal — it must keep the generic account');
});

test('a turn where the model never spoke is never a refusal', async () => {
  // The flag defaults to false at function scope and is assigned only in the LLM-first branch. The
  // deterministic catalog-first branch skips that branch entirely — it assigns structuredSource
  // BEFORE the model is called and never reads the answer back — so on that path the default is the
  // whole answer. If it ever defaulted true, every empty catalog-first turn would be reported to a
  // partner as a deliberate refusal by a model that was never consulted.
  const { createLegacyRecoMainlineExecutionRuntime } = require('../src/auroraBff/legacyRecoMainlineExecution');
  let llmCalls = 0;
  const { runLegacyRecoMainlineExecution } = createLegacyRecoMainlineExecutionRuntime({
    pickFirstTrimmed: (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '',
    isPlainObject: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [] }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [] }),
    buildRecoGenerateFromCatalog: async () => ({
      structured: { recommendations: [] }, candidate_pool: [], candidate_pool_state: {}, debug: {},
    }),
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({
      promptBundle: { prompt_spec: { wide_template_active: true }, schema_chars: 0 },
      query: 'q', promptContract: { ok: true, issues: [] }, llmTraceSeed: {},
    }),
    runRecoLlmPrimary: async () => {
      llmCalls += 1;
      return {
        upstream: {}, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: '', llmLatencyMs: 5,
        answerJson: null, llmStructured: null, llmStructuredSource: null,
        llmTrace: {}, llmInvoked: true, initialLlmOutcome: 'success',
      };
    },
    resolveConcernMainlineFailure: () => ({}),
    resolveRecoEffectiveFailure: () => ({}),
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
    targetContext: { framework_roles: [], step_aware_intent: true },
    profileSummary: {}, debug: false, logger: null, ctx: { lang: 'EN' },
    entryType: 'direct', userAsk: 'a bronzer for contouring', prefix: '',
    recentLogs: [], globalStatus: {}, mainlineStageTimingsMs: {},
    promptDomainScope: 'beauty',
    // the branch that answers from the catalog before the model is consulted
    deterministicCatalogFirstEnabled: true,
  });

  assert.equal(out.llmDeclinedInItsOwnWords, false,
    'the catalog-first branch never reads a model answer, so it can never carry a refusal');
});
