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
    const m = /^aurora_reco_answer_path_total\{door="([^"]+)",path="([^"]+)"\} (\d+)/.exec(line);
    if (m) out[`${m[1]}/${m[2]}`] = Number(m[3]);
  }
  return out;
}

function delta(before, after, key) {
  return (after[key] || 0) - (before[key] || 0);
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
  assert.equal(delta(before, afterAgent, 'agent_tool/llm_primary'), 1,
    'the recommend_products agent door must count under its own name');

  await runLane({ entryType: 'direct', recoTriggerSource: 'typed_reco' });
  const afterConsumer = pathCounts();
  assert.equal(delta(afterAgent, afterConsumer, 'typed_reco/llm_primary'), 1,
    'the consumer /v1/reco/generate lane must count under its own name');
  assert.equal(delta(afterAgent, afterConsumer, 'agent_tool/llm_primary'), 0,
    'a consumer turn must not land on the agent door series — entryType is the same for both');

  // The chat lane sets no trigger source at all and is identified by its entry type instead.
  await runLane({ entryType: 'chat', recoTriggerSource: null });
  const afterChat = pathCounts();
  assert.equal(delta(afterConsumer, afterChat, 'chat/llm_primary'), 1);
  assert.equal(delta(afterConsumer, afterChat, 'other/llm_primary'), 0,
    'a chat turn must not fall through to the catch-all door');
});

test('every path the lane can answer from is its own countable series', async () => {
  // The point of the metric. `confidence_basis` cannot do this: it maps catalog_grounded and
  // catalog_transient_fallback both to 'positional', and legacy_notice to 'none' alongside a dead
  // leg. A mutant that reports any of these as another value fails here.
  for (const source of ['llm_primary', 'catalog_grounded', 'catalog_transient_fallback', 'legacy_notice']) {
    const before = pathCounts();
    await runLane({ recoTriggerSource: 'agent_tool', answeredFrom: source });
    const after = pathCounts();
    assert.equal(delta(before, after, `agent_tool/${source}`), 1,
      `a turn the lane answered from ${source} must count as ${source}`);
    for (const other of ['llm_primary', 'catalog_grounded', 'catalog_transient_fallback', 'legacy_notice']) {
      if (other === source) continue;
      assert.equal(delta(before, after, `agent_tool/${other}`), 0,
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
  assert.equal(delta(beforeDead, afterDead, 'agent_tool/none'), 1);
  assert.equal(delta(beforeDead, afterDead, 'agent_tool/unknown'), 0,
    'a dead leg is a known outcome, not an unrecognised path');

  const beforeNew = pathCounts();
  await runLane({ recoTriggerSource: 'agent_tool', answeredFrom: 'some_path_added_later' });
  const afterNew = pathCounts();
  assert.equal(delta(beforeNew, afterNew, 'agent_tool/unknown'), 1);
  assert.equal(delta(beforeNew, afterNew, 'agent_tool/none'), 0,
    'an unrecognised path must not hide among the dead legs');
  assert.ok(!Object.keys(afterNew).some((k) => k.endsWith('/some_path_added_later')),
    'an unrecognised path must not mint a new series');
});

test('an unrecognised door falls to the catch-all rather than minting a series', () => {
  // Prometheus label cardinality is a real cost and `recoTriggerSource` is not a closed set at its
  // source — the lane falls back to ctx.trigger_source, which callers control.
  const before = pathCounts();
  metrics.recordAuroraRecoAnswerPath({ door: 'partner_integration_47', path: 'llm_primary' });
  const after = pathCounts();
  assert.equal(delta(before, after, 'other/llm_primary'), 1);
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
    recordAuroraRecoAnswerPath: metrics.recordAuroraRecoAnswerPath,
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
  assert.equal(delta(before, after, 'chat/catalog_grounded'), 1);
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
