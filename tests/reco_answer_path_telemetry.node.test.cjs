'use strict';

// WHICH DOOR THE TURN CAME IN BY, AND WHICH PATH ANSWERED IT — as a number you can count rather
// than one you poll for.
//
// #2155 turns on this: the domain rules live in an LLM prompt, and only the LLM path reads one. The
// catalog paths answer without ever consulting it, which is how a bronzer need comes back as
// cleansers. Deciding whether to fix the prompt or the recall depends entirely on which path serves
// what share — and until now the only way to find out was to call the lane by hand and read the
// response body. Measured that way on 2026-09-09: the consumer lane answered `llm_primary` 16/16
// across skincare, makeup, haircare and fragrance needs, while the agent door produced both.
// Sixteen hand samples is not a rate.
//
// TWO LABELS, AND NEITHER IS `entryType`. The first cut of this counter labelled on entry type and
// was unmergeable for it: `recommend_products` and the consumer POST /v1/reco/generate BOTH pass
// entryType 'direct', so the one comparison above was collapsed into a single series by the very
// metric built to make it. `recoTriggerSource` separates them. The path label is `structuredSource`
// rather than the derived `confidence_basis`, because basis maps both catalog paths onto
// 'positional' and folds `legacy_notice` in with a dead leg.
//
// Every assertion below drives real code. The first version of this file hand-fed `positional`
// straight into the recorder, and a mutant that reported every catalog answer as `model_self_report`
// — the metric stating the exact opposite of the truth for the only path #2155 cares about — passed
// all five tests.

process.env.AURORA_BFF_USE_MOCK = 'false';
process.env.AURORA_DECISION_BASE_URL = 'https://decision.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const METRICS_ID = require.resolve('../src/auroraBff/visionMetrics');
const MAINLINE_ID = require.resolve('../src/auroraBff/legacyRecoMainlineExecution');
const metrics = require('../src/auroraBff/visionMetrics');

function pathCounts() {
  const out = {};
  for (const line of metrics.renderVisionMetricsPrometheus().split('\n')) {
    const m = /^aurora_reco_answer_path_total\{door="([^"]+)",path="([^"]+)",served="([^"]+)"\} (\d+)/.exec(line);
    if (m) out[`${m[1]}/${m[2]}/${m[3]}`] = Number(m[4]);
  }
  return out;
}

function delta(before, after, key) {
  return (after[key] || 0) - (before[key] || 0);
}

// Sum across the served axis. The PATH label and the SERVED label are independent claims, and a
// test about which producer answered should not also be pinning whether that answer had rows in it
// — that is the next test's job, and coupling them makes both brittle.
function pathDelta(before, after, door, path) {
  return delta(before, after, `${door}/${path}/yes`) + delta(before, after, `${door}/${path}/no`);
}

// Drop every auroraBff module EXCEPT the metrics registry, so a re-required engine re-binds to a
// patched mainline while the counter keeps accumulating in one place. Deleting only routes is not
// enough: legacyRecoGenerationEngine destructures the mainline factory at ITS load time and keeps
// the old binding, which silently made an earlier version of this harness assert nothing.
function resetAuroraModules() {
  for (const id of Object.keys(require.cache)) {
    if (id.includes(`${require('node:path').sep}auroraBff${require('node:path').sep}`) && id !== METRICS_ID) {
      delete require.cache[id];
    }
  }
}

const ANSWERING = async () => ({
  answer: JSON.stringify({
    recommendations: [{ brand: 'X', name: 'Y', step: 'treatment', query_terms: ['t'], reasons: ['r'] }],
    confidence: 0.7,
    warnings: [],
    missing_info: [],
  }),
});
const DEAD_LEG = async () => {
  const err = new Error('Upstream status 400');
  err.status = 400;
  throw err;
};

// Runs the REAL lane. `answeredFrom` wraps the real mainline and changes only which path it reports
// having answered from — everything after it (post-mainline, the grounding gate, the confidence
// derivation, the record call) is production code, so a mutant at the record site dies here.
async function runLane({ entryType = 'direct', recoTriggerSource = null, chat = ANSWERING, answeredFrom = null } = {}) {
  resetAuroraModules();
  const client = require('../src/auroraBff/auroraDecisionClient');
  client.auroraChat = chat;
  if (answeredFrom) {
    const mainline = require('../src/auroraBff/legacyRecoMainlineExecution');
    const realFactory = mainline.createLegacyRecoMainlineExecutionRuntime;
    mainline.createLegacyRecoMainlineExecutionRuntime = (deps) => {
      const runtime = realFactory(deps);
      return {
        ...runtime,
        runLegacyRecoMainlineExecution: async (args) => ({
          ...(await runtime.runLegacyRecoMainlineExecution(args)),
          structuredSource: answeredFrom,
        }),
      };
    };
  }
  try {
    const { __internal } = require('../src/auroraBff/routes');
    return await __internal.generateProductRecommendations({
      ctx: {
        request_id: 'r', trace_id: 't', aurora_uid: 'agent:test', lang: 'EN',
        trigger_source: 'agent_tool', state: null, backend_auth_headers: {},
      },
      profile: null, recentLogs: [], message: 'a gentle retinol', focus: 'a gentle retinol',
      includeAlternatives: false, debug: true, logger: null, budgetMs: 4000,
      entryType, recoTriggerSource,
    });
  } finally {
    delete require.cache[MAINLINE_ID];
  }
}

test('the two direct doors are countable apart', async () => {
  // THE REGRESSION TEST FOR THE REASON THIS PR WAS SENT BACK. Both doors below pass the SAME
  // entryType. If the label ever reverts to entry type they collapse into one series and the second
  // assertion fails, because the agent door's own row will have moved by two.
  const before = pathCounts();
  await runLane({ entryType: 'direct', recoTriggerSource: 'agent_tool' });
  const afterAgent = pathCounts();
  assert.equal(delta(before, afterAgent, 'agent_tool/llm_primary/no'), 1,
    'the recommend_products agent door must count under its own name');

  await runLane({ entryType: 'direct', recoTriggerSource: 'typed_reco' });
  const afterConsumer = pathCounts();
  assert.equal(delta(afterAgent, afterConsumer, 'typed_reco/llm_primary/no'), 1,
    'the consumer /v1/reco/generate lane must count under its own name');
  assert.equal(delta(afterAgent, afterConsumer, 'agent_tool/llm_primary/no'), 0,
    'a consumer turn must not land on the agent door series — entryType is the same for both');

  // The chat lane sets no trigger source at all and is identified by its entry type instead.
  await runLane({ entryType: 'chat', recoTriggerSource: null });
  const afterChat = pathCounts();
  assert.equal(delta(afterConsumer, afterChat, 'chat/llm_primary/no'), 1);
  assert.equal(delta(afterConsumer, afterChat, 'other/llm_primary/no'), 0,
    'a chat turn must not fall through to the catch-all door');
});

test('every path the lane can answer from is its own countable series', async () => {
  // The point of the metric. `confidence_basis` cannot do this: it maps catalog_grounded and
  // catalog_transient_fallback both to 'positional', and legacy_notice to 'none' alongside a dead
  // leg. A mutant that reports any of these as another value fails here.
  // These three are every value `structuredSource` can actually take. `legacy_notice` is NOT a
  // fourth: it is a source_mode, produced only when structuredSource is falsy, so a turn that
  // reaches it counts as 'none' and is covered by the dead-leg test below.
  const LANE_PATHS = ['llm_primary', 'catalog_grounded', 'catalog_transient_fallback'];
  for (const source of LANE_PATHS) {
    const before = pathCounts();
    await runLane({ recoTriggerSource: 'agent_tool', answeredFrom: source });
    const after = pathCounts();
    assert.equal(pathDelta(before, after, 'agent_tool', source), 1,
      `a turn the lane answered from ${source} must count as ${source}`);
    for (const other of LANE_PATHS) {
      if (other === source) continue;
      assert.equal(pathDelta(before, after, 'agent_tool', other), 0,
        `a ${source} turn must not be counted as ${other}`);
    }
  }
});

test('a dead leg counts as none; a path nobody declared counts as unknown', async () => {
  // A silently uncounted failure is the defect class that made the 2026-09-09 incident invisible, so
  // "no path served this" must be a row rather than an absence. But it must NOT share a row with a
  // structuredSource the allowlist has not been taught: that one is a path someone added without
  // updating this metric, and folding it in with the dead legs would hide it.
  const beforeDead = pathCounts();
  await runLane({ recoTriggerSource: 'agent_tool', chat: DEAD_LEG });
  const afterDead = pathCounts();
  assert.equal(delta(beforeDead, afterDead, 'agent_tool/none/no'), 1);
  assert.equal(delta(beforeDead, afterDead, 'agent_tool/none/yes'), 0,
    'a turn no path could serve cannot be marked served');
  assert.equal(delta(beforeDead, afterDead, 'agent_tool/unknown/yes'), 0,
    'a dead leg is a known outcome, not an unrecognised path');

  const beforeNew = pathCounts();
  await runLane({ recoTriggerSource: 'agent_tool', answeredFrom: 'some_path_added_later' });
  const afterNew = pathCounts();
  assert.equal(pathDelta(beforeNew, afterNew, 'agent_tool', 'unknown'), 1);
  assert.equal(pathDelta(beforeNew, afterNew, 'agent_tool', 'none'), 0,
    'an unrecognised path must not hide among the dead legs');
  assert.ok(!Object.keys(afterNew).some((k) => k.includes('/some_path_added_later/')),
    'an unrecognised path must not mint a new series');
});

test('an unrecognised door falls to the catch-all rather than minting a series', () => {
  // Prometheus label cardinality is a real cost and `recoTriggerSource` is a plain string supplied
  // by the caller. NOTE: the lane passes the RAW parameter here, deliberately — there is a
  // `pickFirstTrimmed(recoTriggerSource, ctx.trigger_source, 'text')` ladder elsewhere in the same
  // function, and using it would misfile every chat turn as whatever ctx.trigger_source says.
  const before = pathCounts();
  metrics.recordAuroraRecoAnswerPath({ door: 'partner_integration_47', path: 'llm_primary' });
  const after = pathCounts();
  assert.equal(delta(before, after, 'other/llm_primary/yes'), 1);
  assert.ok(!Object.keys(after).some((k) => k.startsWith('partner_integration_47/')));
});

test('the chat verified-context restore is counted, and the lane is not counted twice for it', async () => {
  // This answer never enters the reco lane: restoring from verified context sets `norm`, which makes
  // the guard below it skip generateProductRecommendations entirely. Left uncounted it would bias
  // the metric in the worst direction — it is a catalog answer, so omitting it overstates the share
  // of turns the prompt-reading path served.
  resetAuroraModules();
  const { createLegacyChatRecoExecutionRuntime } = require('../src/auroraBff/legacyChatRecoExecution');
  let laneCalls = 0;
  const { executeLegacyChatReco } = createLegacyChatRecoExecutionRuntime({
    summarizeProfileForContext: (profile) => profile,
    normalizeRecoSourceDetail: (value) => value,
    shouldUseLegacyVerifiedContextRestore: () => true,
    restoreRecoRecommendationsFromVerifiedContextCandidates: () => ({
      recommendations: [{ product_id: 'p1', brand: 'B', name: 'N' }],
    }),
    applyVerifiedCandidateRestoreToRecoPayload: (payload, recommendations) => ({
      payload: { ...payload, recommendations },
    }),
    generateProductRecommendations: async () => { laneCalls += 1; return { norm: null }; },
    normalizeRecoFailureClass: (value) => value || '',
  });

  const before = pathCounts();
  const result = await executeLegacyChatReco({
    ctx: { request_id: 'r', lang: 'EN' },
    profile: null, recentLogs: [], message: 'what should i use',
    includeAlternatives: false, logger: null,
    ingredientRecoOptInRequested: false, travelRecoHandoff: false,
    shouldApplySessionRecoContext: true, recoAutoAnchoredByAnalysis: false,
    effectiveRecoEntrySourceDetail: 'typed_reco', hasStableRecoTarget: true,
    recoIngredientContext: null, latestRecoContextPatch: {}, chatRecoTargetContext: null,
    recoTaskMode: 'goal_based_products', artifactConfidenceScore: null,
    artifactConfidenceLevel: 'medium', lowConfidenceArtifact: false,
    recoContextIngredientQuery: '', recoContextGoal: '', recoIngredientCandidates: [],
    matcherPayload: null, recoRequestMessageForMainline: 'what should i use',
    recoFocusForMainline: '', recoIngredientContextForMainline: null,
    analysisContextSnapshotForConversation: null, requestScopedProfileOverride: null,
    debugUpstream: false, catalogExternalSeedStrategyForMainline: '',
    AURORA_BFF_CHAT_RECO_BUDGET_MS: 4000,
  });
  const after = pathCounts();

  assert.equal(Array.isArray(result?.norm?.payload?.recommendations)
    && result.norm.payload.recommendations.length, 1, 'the restore must actually have produced an answer');
  assert.equal(laneCalls, 0, 'the restore short-circuits the lane — if it stops doing so this row double counts');
  assert.equal(delta(before, after, 'chat/verified_context_restore/yes'), 1,
    'the restore is its own producer — it replays session candidates and runs no recall at all');
});

test('the reco_requested event carries the path, distinctly from source_mode', () => {
  // `source` on the event is source_mode — a PRESENTATION label with its own fallback ladder, which
  // can read 'step_aware_mainline' on a turn the LLM actually answered. They must not be confused.
  //
  // Asserted against the BUILT event. The first version of this test read routes.js off disk and
  // regex-matched the source line, so commenting the field out left it green.
  resetAuroraModules();
  const { __internal } = require('../src/auroraBff/routes');
  const withBasis = __internal.buildRecoRequestedEventData({
    explicit: true,
    source: 'step_aware_mainline',
    payload: { recommendation_meta: { confidence_basis: 'positional' } },
  });
  assert.equal(withBasis.confidence_basis, 'positional');
  assert.equal(withBasis.source, 'step_aware_mainline',
    'source_mode must survive alongside it, not be replaced by it');

  // Control: absent on the meta means absent on the event, not an invented default.
  const withoutBasis = __internal.buildRecoRequestedEventData({
    explicit: true,
    source: 'step_aware_mainline',
    payload: { recommendation_meta: {} },
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(withoutBasis, 'confidence_basis'));
});

test('the restore counts only when it actually restored something', async () => {
  // CONTROL FOR THE TEST ABOVE. Without it, moving the record out of the
  // `restoredRecommendations.length > 0` branch — counting whenever the restore PREDICATE fires —
  // is invisible, and that mutant both over-counts and creates a genuine double count, because the
  // lane then runs and records its own row.
  resetAuroraModules();
  const { createLegacyChatRecoExecutionRuntime } = require('../src/auroraBff/legacyChatRecoExecution');
  let laneCalls = 0;
  const { executeLegacyChatReco } = createLegacyChatRecoExecutionRuntime({
    summarizeProfileForContext: (profile) => profile,
    normalizeRecoSourceDetail: (value) => value,
    // The predicate fires...
    shouldUseLegacyVerifiedContextRestore: () => true,
    // ...but there is nothing to restore.
    restoreRecoRecommendationsFromVerifiedContextCandidates: () => ({ recommendations: [] }),
    applyVerifiedCandidateRestoreToRecoPayload: (payload, recommendations) => ({
      payload: { ...payload, recommendations },
    }),
    generateProductRecommendations: async () => { laneCalls += 1; return { norm: null }; },
    normalizeRecoFailureClass: (value) => value || '',
    classifyRecoUpstreamFailureCode: () => '',
    isTransientRecoUpstreamFailureCode: () => false,
    recordAuroraRecoLlmCall: () => {},
  });

  const before = pathCounts();
  await executeLegacyChatReco({
    ctx: { request_id: 'r', lang: 'EN' },
    profile: null, recentLogs: [], message: 'what should i use',
    includeAlternatives: false, logger: null,
    ingredientRecoOptInRequested: false, travelRecoHandoff: false,
    shouldApplySessionRecoContext: true, recoAutoAnchoredByAnalysis: false,
    effectiveRecoEntrySourceDetail: 'typed_reco', hasStableRecoTarget: true,
    recoIngredientContext: null, latestRecoContextPatch: {}, chatRecoTargetContext: null,
    recoTaskMode: 'goal_based_products', artifactConfidenceScore: null,
    artifactConfidenceLevel: 'medium', lowConfidenceArtifact: false,
    recoContextIngredientQuery: '', recoContextGoal: '', recoIngredientCandidates: [],
    matcherPayload: null, recoRequestMessageForMainline: 'what should i use',
    recoFocusForMainline: '', recoIngredientContextForMainline: null,
    analysisContextSnapshotForConversation: null, requestScopedProfileOverride: null,
    debugUpstream: false, catalogExternalSeedStrategyForMainline: '',
    AURORA_BFF_CHAT_RECO_BUDGET_MS: 4000,
  });
  const after = pathCounts();

  assert.equal(delta(before, after, 'chat/verified_context_restore/yes'), 0,
    'a restore that restored nothing is not an answer and must not be counted');
  assert.equal(laneCalls, 1,
    'with nothing restored the lane DOES run — which is why counting the predicate would double count');
});

test('the travel preview early exit is counted', async () => {
  // A third chat producer that answers before the lane is ever reached: an early exit returning a
  // full recommendations card built from the travel skill contract. Same class as the other two.
  resetAuroraModules();
  const { createLegacyChatRecoEarlyExitsRuntime } = require('../src/auroraBff/legacyChatRecoEarlyExits');
  const { maybeBuildLegacyTravelRecoEnvelope } = createLegacyChatRecoEarlyExitsRuntime({
    buildEnvelope: (ctx, envelope) => envelope,
    makeAssistantMessage: (content) => ({ role: 'assistant', content }),
    makeEvent: (ctx, name, data) => ({ name, data }),
    buildConfidenceNoticeCardPayload: () => ({}),
    summarizeProfileForContext: (profile) => profile,
    appendLatestRecoContextToSessionPatch: () => {},
  });

  const before = pathCounts();
  const envelope = maybeBuildLegacyTravelRecoEnvelope({
    ctx: { request_id: 'r', lang: 'EN' },
    travelRecoHandoff: true,
    travelSkillsContracts: {
      __internal: {
        buildRecoPreview: () => ({ recommendations: [{ product_id: 'p1', name: 'Travel SPF' }] }),
      },
    },
    travelRecoContext: { travel_readiness: { env_source: 'test' }, destination: 'Tokyo' },
    profile: null,
  });
  const after = pathCounts();

  const card = (envelope?.cards || []).find((c) => c.type === 'recommendations');
  assert.ok(card, 'this path must actually have produced a recommendations card');
  assert.equal(card.payload.recommendations.length, 1);
  assert.equal(delta(before, after, 'chat/travel_preview/yes'), 1);
});

// KNOWN UNTESTED BRANCH, named rather than papered over.
//
// legacyRecoGenerationEngine's ungrounded-catalog recovery is the ONE place that flips a turn from
// llm_primary to catalog_grounded after the fact (a fluent LLM answer that grounds to zero products
// is swapped for the pre-LLM catalog answer). That flip is the exact misreport #2155 turns on, and
// recording the PRE-recovery value instead of the post-recovery one is a mutant that survives every
// test here. It is not reachable from this harness: shouldRecoverFullyUngroundedDirectAnswer
// requires catalogRecommendationCount > 0, which needs a real catalog behind the recall leg.
//
// Driving it needs a catalog fixture, not another stub. Until then the record's PLACEMENT after the
// recovery block is held only by reading the code.
test.todo('the ungrounded-catalog recovery counts the path it recovered TO, not the one it started from');

test('the lane-free producers record without anything being injected', async () => {
  // THIS REPLACES A WIRING TEST, because the wiring is gone. The recorder used to travel six hops
  // of by-name re-listing from routes.js down to each producer, and two rounds of review each found
  // a different hop that silently dropped it — the chat half counted zero in production while every
  // test stayed green. The three lane-free producers now require the recorder directly, which makes
  // that whole class of bug unrepresentable.
  //
  // What this pins is that they really do, and that nothing shadows it: a leftover
  // `const { recordAuroraRecoAnswerPath } = deps;` inside a factory would bind undefined over the
  // module-level require and throw here. The runtimes below are built with NO telemetry dep at all.
  resetAuroraModules();
  const { createLegacyChatRecoEarlyExitsRuntime } = require('../src/auroraBff/legacyChatRecoEarlyExits');
  const { maybeBuildLegacyTravelRecoEnvelope } = createLegacyChatRecoEarlyExitsRuntime({
    buildEnvelope: (ctx, envelope) => envelope,
    makeAssistantMessage: (content) => ({ role: 'assistant', content }),
    makeEvent: (ctx, name, data) => ({ name, data }),
    buildConfidenceNoticeCardPayload: () => ({}),
    summarizeProfileForContext: (profile) => profile,
    appendLatestRecoContextToSessionPatch: () => {},
  });
  const before = pathCounts();
  maybeBuildLegacyTravelRecoEnvelope({
    ctx: { request_id: 'r', lang: 'EN' },
    travelRecoHandoff: true,
    travelSkillsContracts: {
      __internal: { buildRecoPreview: () => ({ recommendations: [{ product_id: 'p1' }] }) },
    },
    travelRecoContext: { travel_readiness: { env_source: 'test' } },
    profile: null,
  });
  assert.equal(delta(before, pathCounts(), 'chat/travel_preview/yes'), 1,
    'the travel early exit must record with no recorder passed to its runtime');
});

test('a turn that served nothing is separable from one that did, on the same path', async () => {
  // THE LABEL THAT MAKES THIS METRIC USABLE FOR #2155. An `llm_primary` turn that grounds to ZERO
  // products is the makeup case exactly: the model understood the request, refused to substitute a
  // skincare product for a bronzer, and recall could not reach the category. Folding that into
  // path='none' would erase the distinction; leaving it indistinguishable from a served answer
  // would inflate `llm_primary` with every dead turn and hide the problem the other way.
  //
  // Both turns below take the SAME path. Only `served` separates them.
  const before = pathCounts();
  await runLane({ recoTriggerSource: 'agent_tool', chat: ANSWERING });
  const afterEmpty = pathCounts();
  assert.equal(delta(before, afterEmpty, 'agent_tool/llm_primary/no'), 1,
    'an LLM answer grounded away to nothing is an llm_primary turn that served nothing');
  assert.equal(delta(before, afterEmpty, 'agent_tool/llm_primary/yes'), 0);

  // ...and the same path with rows that survive.
  await runLane({ recoTriggerSource: 'agent_tool', answeredFrom: 'llm_primary', chat: ANSWERING });
  const afterServed = pathCounts();
  assert.equal(
    delta(afterEmpty, afterServed, 'agent_tool/llm_primary/yes')
      + delta(afterEmpty, afterServed, 'agent_tool/llm_primary/no'),
    1,
    'the second turn is the same path and must be counted once',
  );
});

test('the skill_router door is counted, served and unserved', async () => {
  // The chat door is not one producer. skill_router_v2 (AURORA_CHAT_SKILL_ROUTER_V2, default ON)
  // answers recommendation requests on its own lane, and three review rounds in a row found a chat
  // producer that counted nothing. It gets its own door rather than being folded into `chat`,
  // because it is a different route with different failure modes — shop.find_products is grounded
  // against the catalog, while reco.step_based can ship LLM-invented rows with no product_id.
  resetAuroraModules();
  const ShopFindProductsSkill = require('../src/auroraBff/skills/shop_find_products');

  const withRows = new ShopFindProductsSkill({
    client: {
      findProductsMulti: async () => ({
        products: [{
          product_id: 'p1', name: 'A cleanser', brand: 'B',
          price: 20, currency: 'USD', url: 'https://example.test/p1',
        }],
      }),
    },
  });
  const before = pathCounts();
  const served = await withRows.execute({ params: { query: 'a gentle cleanser' }, context: {} });
  const afterServed = pathCounts();
  assert.ok((served?.cards || []).some((c) => c.card_type === 'recommendations'),
    'this drive must actually have produced a recommendations card');
  assert.equal(delta(before, afterServed, 'skill_router/skill_find_products/yes'), 1);

  const withoutRows = new ShopFindProductsSkill({
    client: { findProductsMulti: async () => ({ products: [] }) },
  });
  await withoutRows.execute({ params: { query: 'a gentle cleanser' }, context: {} });
  const afterEmpty = pathCounts();
  assert.equal(delta(afterServed, afterEmpty, 'skill_router/skill_find_products/no'), 1,
    'a skill turn that found nothing is still a turn this door handled');
  assert.equal(delta(afterServed, afterEmpty, 'skill_router/skill_find_products/yes'), 0);
});

test('reco.step_based counts its turns, including the ones its LLM leg kills', async () => {
  // Counted but untested is how a record site rots: a review mutant deleted this call entirely and
  // every test stayed green. Both of this skill's exits are driven here.
  resetAuroraModules();
  const RecoStepBasedSkill = require('../src/auroraBff/skills/reco_step_based');
  const skill = new RecoStepBasedSkill();

  // The LLM answers, but nothing resolves to a product.
  const before = pathCounts();
  await skill.execute(
    { params: { target_step: 'treatment' }, context: { locale: 'en-US' } },
    { call: async () => ({ parsed: { answer_en: 'try a retinol', answer_zh: null, products: [] } }) },
  );
  const afterEmpty = pathCounts();
  assert.equal(delta(before, afterEmpty, 'skill_router/skill_step_based/no'), 1,
    'a step-based turn that resolved no product is still a turn this door handled');

  // The LLM leg dies outright.
  await skill.execute(
    { params: { target_step: 'treatment' }, context: { locale: 'en-US' } },
    { call: async () => { throw new Error('upstream exploded'); } },
  );
  const afterDead = pathCounts();
  assert.equal(delta(afterEmpty, afterDead, 'skill_router/skill_step_based/no'), 1,
    'a dead LLM leg must not vanish from the denominator — that biases served-share upward');
  assert.equal(delta(afterEmpty, afterDead, 'skill_router/skill_step_based/yes'), 0);
});

// SECOND KNOWN GAP, named rather than papered over.
//
// The two routine-lane record sites (routes.js, the S6_BUDGET branch and the
// looksLikeRoutineRequest branch) have no test. A review mutant relabelled BOTH of them to
// `agent_tool` / `llm_primary` and every test here stayed green -- and that particular lie would
// pollute the one series this metric exists to read. They are not reachable without driving
// /v1/chat through a routine turn with a stubbed upstream, and no harness for that exists anywhere
// in tests/ today (`grep -rln generateRoutineReco tests/` is empty).
//
// Until that harness exists, the routine sites' labels are held only by reading the code.
test.todo('the routine lane records under its own door and path');

test('the agent door records what the PARTNER received, not what the lane produced', async () => {
  // THE NUMBER THIS METRIC EXISTS FOR. The lane records `served` from its own final list, but this
  // bridge then drops every ungrounded row — so an all-ungrounded turn, which is the #2155 makeup
  // failure exactly (the model names a bronzer, refuses to substitute, and nothing grounds), was
  // recorded as SERVED while the partner agent received an empty list. That is backwards in the one
  // case Meitu MakeupPlus and Perfect Corp YouCam will hit hardest.
  //
  // The lane's own record is deferred for this door; the bridge records once, here, from `signals`.
  resetAuroraModules();
  const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');

  const groundedItem = {
    slot: 'treatment', step: 'treatment', score: 88, product_type: 'treatment',
    brand: "Paula's Choice", name: '2% BHA Liquid Exfoliant', display_name: '2% BHA Liquid Exfoliant',
    use_case: 'Unclogs pores', reasons: ['clears pores'], query_terms: ['bha'],
    sku: { brand: "Paula's Choice", name: '2% BHA Liquid Exfoliant', sku_id: 'sku_1', product_id: 'sig_abc' },
    merchant_id: 'merch_1', price: { amount: 35, currency: 'USD', unknown: false },
    url: 'https://shop.example/p/sig_abc', pdp_url: 'https://shop.example/p/sig_abc',
  };
  // Same shape, but ungrounded: no product_id and no merchant. The bridge drops these.
  const ungroundedItem = {
    slot: 'makeup', step: 'makeup', score: 88, product_type: 'makeup',
    brand: 'Some Brand', name: 'Warm-Toned Powder Bronzer', display_name: 'Warm-Toned Powder Bronzer',
    use_case: 'Contouring', reasons: ['warm undertone'], query_terms: ['bronzer'],
    sku: { brand: 'Some Brand', name: 'Warm-Toned Powder Bronzer' },
  };
  const lane = (items) => async () => ({
    structuredSource: 'llm_primary',
    norm: { payload: { recommendations: items, confidence: 0.72, grounding_status: 'grounded' } },
  });

  const served = makeRecommendProducts({ generate: lane([groundedItem]), isEnabled: () => true });
  const before = pathCounts();
  const good = await served({ payload: { need: 'a gentle exfoliant' } }, { agent_id: 'a' });
  const afterServed = pathCounts();
  assert.ok(good.signals.length > 0, 'the grounded turn must actually deliver something');
  assert.equal(delta(before, afterServed, 'agent_tool/llm_primary/yes'), 1);

  const empty = makeRecommendProducts({ generate: lane([ungroundedItem]), isEnabled: () => true });
  const bad = await empty({ payload: { need: 'a bronzer for contouring' } }, { agent_id: 'a' });
  const afterEmpty = pathCounts();
  assert.equal(bad.signals.length, 0, 'the ungrounded turn must deliver nothing — that is the setup');
  assert.equal(delta(afterServed, afterEmpty, 'agent_tool/llm_primary/no'), 1,
    'an llm_primary turn the partner got nothing from must count as UNSERVED');
  assert.equal(delta(afterServed, afterEmpty, 'agent_tool/llm_primary/yes'), 0,
    'the lane produced a row, but the partner received none — the door reports the partner');

  // And a lane that never returns is still a turn this door handled.
  const dead = makeRecommendProducts({
    generate: async () => { throw new Error('lane down'); }, isEnabled: () => true,
  });
  const out = await dead({ payload: { need: 'a gentle exfoliant' } }, { agent_id: 'a' });
  const afterDead = pathCounts();
  assert.equal(out.metadata.reason, 'lane_unavailable');
  assert.equal(delta(afterEmpty, afterDead, 'agent_tool/none/no'), 1);
});

test('the agent door records exactly once, through the REAL lane', async () => {
  // The test above stubs the lane, so it cannot see the two things that matter about the handoff:
  // that the lane actually HONOURS the defer flag (otherwise the turn is counted twice, once with
  // the lane's notion of served and once with the partner's), and that the real lane actually
  // SURFACES the path (otherwise every agent turn silently records path='none').
  //
  // So this one wires the production lane into the production bridge.
  resetAuroraModules();
  const client = require('../src/auroraBff/auroraDecisionClient');
  client.auroraChat = ANSWERING;
  const { __internal } = require('../src/auroraBff/routes');
  const { makeRecommendProducts } = require('../src/agentSignals/recommendProducts');

  const handler = makeRecommendProducts({
    generate: __internal.generateProductRecommendations,
    isEnabled: () => true,
    budgetMs: 4000,
  });

  const before = pathCounts();
  await handler({ payload: { need: 'a gentle retinol' } }, { agent_id: 'agent_test' });
  const after = pathCounts();

  const moved = Object.keys({ ...before, ...after })
    .filter((k) => delta(before, after, k) !== 0);
  assert.deepEqual(moved, ['agent_tool/llm_primary/no'],
    'exactly one series may move: the lane must defer to the bridge, and the bridge must know the path');
  assert.equal(delta(before, after, 'agent_tool/llm_primary/no'), 1,
    'and it must move by one — two means the lane recorded as well');
});
