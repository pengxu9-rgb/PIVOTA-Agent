const test = require('node:test');
const assert = require('node:assert/strict');
// Resolved RELATIVE to this file. An absolute path here passes on the machine that wrote it and
// fails everywhere else -- which is exactly what happened: adopted with the author's scratchpad
// path baked in, green locally, MODULE_NOT_FOUND in CI.
const path = require('node:path').join(__dirname, '..', 'src', 'auroraBff', 'legacyRecoGenerationEngine');
const { createLegacyRecoGenerationEngineRuntime } = require(path);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const pickFirstTrimmed = (...v) => v.map((x) => String(x == null ? '' : x).trim()).find(Boolean) || '';
const id = (x) => x;

function makeEngine(over = {}) {
  const calls = { catalog: 0, llm: 0, ground: 0, metrics: [] };
  const CATALOG = {
    structured: { recommendations: [{ product_id: 'cat_1', name: 'A Cleanser', category: 'Cleanser' }] },
    candidate_pool: [{ product_id: 'cat_1' }],
    candidate_pool_state: { selected_candidate_count: 1, pre_llm_selected_candidate_count: 1, terminal_success: true },
    debug: { ok_count: 1 },
  };
  const deps = {
    pickFirstTrimmed,
    pickFirstString: pickFirstTrimmed,
    isPlainObject,
    asStringArray: (v, n) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n || 8) : []),
    uniqCaseInsensitiveStrings: (v) => (Array.isArray(v) ? Array.from(new Set(v)) : []),
    summarizeProfileForContext: () => ({}),
    normalizeIngredientRecoContextValue: () => null,
    buildAnalysisContextSnapshotForRoute: () => null,
    buildTaskAnalysisContextForPrefix: () => ({}),
    buildAnalysisContextPromptBlock: () => '',
    buildContextPrefix: () => '',
    resolveRecommendationTargetContext: () => ({ step_aware_intent: true, framework_roles: [] }),
    runConcernSemanticPlanner: async () => null,
    buildConcernTargetContextFromSemanticPlan: () => null,
    buyerRegionFromContext: () => 'US',
    normalizeRecoEffectiveFailureClass: (v) => v || 'none',
    normalizeRecoFailureClass: (v) => v || 'none',
    normalizeRecoFailureOrigin: (v) => v || 'none',
    normalizeRecoGroundingStatus: (v) => v || '',
    normalizeRecoViablePoolStrength: (v) => v || 'none',
    normalizeRecoTargetFidelityLevel: (v) => v || 'none',
    deriveRecoContractStatus: () => 'ok',
    deriveRecoMainlineStatus: () => 'ok',
    deriveRecoTelemetryFailureReason: () => null,
    buildRecoMainlineContract: () => ({}),
    applyRecoWarningVisibilityContract: (x) => x,
    attachRecoContractMeta: (x) => x,
    mergeFieldMissing: () => ({}),
    isRecoUngroundedItem: (r) => !r || !r.product_id,
    enrichRecommendationsWithPdpOpenContract: async ({ recommendations }) => ({ recommendations }),
    dedupeRecoRecommendationsStrict: (r) => ({ recommendations: Array.isArray(r) ? r : [] }),
    limitRecoKnownTestSeedRecommendations: (r) => ({ recommendations: Array.isArray(r) ? r : [], applied: false }),
    buildRecoDiversityHistoryKey: () => 'k',
    getRecoRecentExposureState: () => ({ tokens: [] }),
    applyRecoRecentDiversityGuard: (r) => ({ recommendations: Array.isArray(r) ? r : [], applied: false }),
    buildRecoDiversityToken: () => 't',
    updateRecoRecentExposureTokens: () => {},
    normalizeBudgetHint: () => null,
    hasItineraryContextForReco: () => false,
    runConcernSelectorRace: async () => null,
    applyConcernSelectorRaceOrdering: (r) => r,
    finalizeConcernFrameworkCandidatePools: () => ({ selected_recommendations: [], terminal_success: true }),
    finalizeRecommendationCandidatePools: () => ({ selected_recommendations: [], terminal_success: true, selected_candidate_count: 1 }),
    buildRecoGenerateFromCatalog: async () => { calls.catalog += 1; return CATALOG; },
    deriveRecoPdpFastFallbackReasonCode: () => null,
    buildRecoLlmPromptState: () => ({ promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] }, llmTraceSeed: {} }),
    runRecoLlmPrimary: async () => {
      calls.llm += 1;
      // A FLUENT, FULLY UNGROUNDED answer: the exact input shouldRecoverFullyUngroundedDirectAnswer exists for.
      const ANSWER = { recommendations: [{ name: 'Daily Broad Spectrum SPF 30 Sunscreen' }], warnings: [], missing_info: [] };
      return {
        promptBundle: { prompt_spec: {}, schema_chars: 0 }, query: 'q', promptContract: { ok: true, issues: [] },
        llmTrace: {}, upstream: {}, contextMeta: {}, upstreamFailureCode: '', llmFailureClass: '', llmLatencyMs: 5,
        answerJson: ANSWER, llmStructured: ANSWER, llmStructuredSource: 'llm_answer_json',
        initialLlmOutcome: 'success', llmInvoked: true,
      };
    },
    resolveConcernMainlineFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    resolveRecoEffectiveFailure: () => ({ effective_failure_class: 'none', failure_origin: 'none' }),
    hasEmptyStructuredRecommendations: (x) => Boolean(x && typeof x === 'object' && !Array.isArray(x) && Array.isArray(x.recommendations) && x.recommendations.length === 0),
    shouldUseRecoCatalogTransientFallback: () => false,
    buildRecoCatalogTransientFallbackStructured: () => null,
    recordAuroraRecoLlmCall: (a) => { calls.metrics.push(a); },
    recordAuroraRecoAnswerPath: (a) => { calls.metrics.push({ answer_path: a }); },
    groundRecoRecommendationsFromCatalog: async ({ recommendations }) => {
      calls.ground += 1;
      // NOTHING grounds: every row keeps a null product_id.
      return { recommendations, grounding_status: 'ungrounded', grounded_count: 0, ungrounded_count: recommendations.length, debug: {} };
    },
    coerceRecoItemForUi: (r) => r,
    normalizeRecoGenerate: (m) => ({ payload: isPlainObject(m) ? { ...m } : { recommendations: [] } }),
    buildConcernFrameworkDecisionTrace: () => [],
    deriveRecoFailureFromStepAwareLlmFallback: () => null,
    deriveStepAwareEmptyReason: () => 'weak_viable_pool',
    buildConcernFrameworkSummary: () => ({}),
    isProductionLikeAuroraBffEnv: () => false,
    RECO_CATALOG_GROUNDED_ENABLED: true,
    AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED: true,
    AURORA_BFF_RECO_DIRECT_RECALL_BEFORE_LLM_ENABLED: true,
    AURORA_BFF_RECO_DIRECT_RECALL_BEFORE_LLM_MAX_QUERIES: 2,
    AURORA_BFF_RECO_DIRECT_UNGROUNDED_RECOVERY_ENABLED: true,
    RECO_MAIN_PROMPT_TEMPLATE_ID: 'reco_main_v1_3',
    ...over,
  };
  const { generateProductRecommendations } = createLegacyRecoGenerationEngineRuntime(deps);
  return { generateProductRecommendations, calls };
}

const baseArgs = (o = {}) => ({
  ctx: { request_id: 'r', lang: 'EN' }, profile: null, recentLogs: [], message: 'x',
  focus: 'a bronzer for contouring', includeAlternatives: false, debug: true, logger: null,
  entryType: 'direct', ...o,
});


// ---------------------------------------------------------------------------
// GATE 1: deterministic catalog-first must NEVER fire on the agent door.
// Both doors get an identical, step-aware ask and the SAME env flag (true).
// ---------------------------------------------------------------------------
test('GATE 1 (consumer control): catalog-first still fires for typed_reco', async () => {
  const { generateProductRecommendations, calls } = makeEngine();
  const out = await generateProductRecommendations(baseArgs({ recoTriggerSource: 'typed_reco' }));
  assert.equal(out.structuredSource, 'catalog_grounded', 'control: the consumer lane still takes the shortcut');
  assert.equal(calls.ground, 0, 'control: catalog-first skips grounding entirely');
});

test('GATE 1: the agent door is NEVER answered by deterministic catalog-first', async () => {
  const { generateProductRecommendations, calls } = makeEngine();
  const out = await generateProductRecommendations(baseArgs({ recoTriggerSource: 'agent_tool' }));
  assert.equal(out.structuredSource, 'llm_primary',
    'the agent door must read the model back, not assign catalog_grounded before the call');
  assert.equal(calls.ground, 1, 'and the answer must go through grounding');
  assert.equal(calls.metrics.filter((m) => m.answer_path).pop().answer_path.path, 'llm_primary');
});

// ---------------------------------------------------------------------------
// GATE 2: the fully-ungrounded catalog recovery must NEVER fire on the agent door.
// Catalog-first is off for BOTH doors here so the only variable is the door.
// ---------------------------------------------------------------------------
const NO_CATALOG_FIRST = { AURORA_BFF_RECO_STEP_AWARE_CATALOG_FIRST_ENABLED: false };

test('GATE 2 (consumer control): a fully-ungrounded answer still recovers for typed_reco', async () => {
  const { generateProductRecommendations } = makeEngine(NO_CATALOG_FIRST);
  const out = await generateProductRecommendations(baseArgs({ recoTriggerSource: 'typed_reco' }));
  assert.equal(out.upstreamDebug.ungrounded_catalog_recovery_applied, true,
    'control: the consumer lane still swaps an ungrounded answer for catalog rows');
  assert.equal(out.structuredSource, 'catalog_grounded');
});

test('GATE 2: an ungrounded agent-door answer is NOT replaced by catalog rows', async () => {
  const { generateProductRecommendations } = makeEngine(NO_CATALOG_FIRST);
  const out = await generateProductRecommendations(baseArgs({ recoTriggerSource: 'agent_tool' }));
  assert.equal(out.upstreamDebug.ungrounded_catalog_recovery_applied, false,
    '"we do not carry a bronzer" must not become "here are three cleansers"');
  assert.equal(out.structuredSource, 'llm_primary');
});

// ---------------------------------------------------------------------------
// The chat lane sets NO recoTriggerSource at all. Neither gate may catch it.
// ---------------------------------------------------------------------------
test('GATE 1+2: the chat lane (no recoTriggerSource) is untouched by both door gates', async () => {
  const a = makeEngine();
  const outA = await a.generateProductRecommendations(baseArgs({ entryType: 'chat', recoTriggerSource: null }));
  assert.equal(outA.structuredSource, 'catalog_grounded', 'chat still takes catalog-first');
  const b = makeEngine(NO_CATALOG_FIRST);
  const outB = await b.generateProductRecommendations(baseArgs({ entryType: 'direct', recoTriggerSource: null }));
  assert.equal(outB.upstreamDebug.ungrounded_catalog_recovery_applied, true,
    'and an unlabelled direct turn still recovers');
});
