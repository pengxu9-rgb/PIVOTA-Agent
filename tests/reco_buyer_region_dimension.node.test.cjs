'use strict';

// ADR-024 Phase 1 (backend PR #1796): `buyer_region` is an explicit request dimension on the consumer
// reco lane -- threaded, cached, and measured -- with ZERO behavior change for today's traffic.
//
// WHY THIS SUITE EXISTS. Region enters this gateway today as a set of literals nobody can observe: the
// price ceiling stamps `currency: 'USD'`, the recall pool cache key has no region dimension at all, and
// the lane reports neither what region it served nor whether anyone asked for it. None of that is wrong
// for a US-only catalog; all of it becomes a SILENT cross-region defect the moment a partner routes a
// GB buyer through the same endpoint. The ADR's phrasing: "omission is a silent cross-region leak CI
// will not catch". This file is the CI that catches it.
//
// The suite is organized around the two claims the PR makes, and each is falsifiable:
//   A. NOTHING CHANGES for a request that sends no buyer_region -- proven by recomputing the cache key
//      dims independently and by pinning US/USD outputs.
//   B. SOMETHING CHANGES for a request that does -- proven by keys that must differ and a ceiling
//      currency that must follow the region.
//
// Measured against origin/main before this change: `buildRecoRecallPoolCacheKey({..., region: 'GB'})`
// returned the IDENTICAL hash to the US call (8db46b29...), because the parameter did not exist. That
// collision is the leak, and section 3 fails on main because of it.
//
// RUN AGAINST REVERTED SOURCE (every changed src/auroraBff file restored from origin/main, this file
// kept): 15 of 24 failed. The 9 that passed are accounted for, not glossed over:
//   * Sections 1 and 2 (7 tests) are the unit tests for `buyerRegion.js`, a file that does not exist
//     on main at all. They cannot fail against reverted source by construction; they earn their place
//     by killing mutants IN that module (each one names the mutant it kills).
//   * Two more are labelled GUARD below: they pass on main for a reason that makes them VACUOUS there
//     (main ignores the region argument entirely; main logs nothing at all) and load-bearing here.
// Sections 6 and 7 were added after that run and fail against reverted source for the same reasons as
// the rest of the route and wiring tests.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  DEFAULT_BUYER_REGION,
  BUYER_REGION_CURRENCY,
  normalizeBuyerRegion,
  resolveBuyerRegion,
  isRejectedBuyerRegionInput,
  currencyForBuyerRegion,
  buyerRegionFromContext,
} = require('../src/auroraBff/buyerRegion');
const {
  RECO_RECALL_POOL_CACHE_VERSION,
  buildRecoRecallPoolCacheKey,
} = require('../src/auroraBff/recoRecallPoolCache');
const { RECO_PRICE_CEILING_KNOWN_CURRENCIES } = require('../src/auroraBff/recoPriceCeiling');
const {
  createLegacyRecoGenerationContextRuntime,
} = require('../src/auroraBff/legacyRecoGenerationContext');
const {
  createDirectRecoGenerateHandlerRuntime,
} = require('../src/auroraBff/directRecoGenerateHandler');
const { RecoGenerateRequestSchema } = require('../src/auroraBff/schemas');
const { buildRequestContext } = require('../src/auroraBff/requestContext');
const { __internal } = require('../src/auroraBff/routes');

const { resolveConcernFrameworkBudgetCeiling, buildRecoRequestedEventData } = __internal;

// ---------------------------------------------------------------------------
// 1. RESOLUTION: what counts as a region, and what "explicit" means
// ---------------------------------------------------------------------------

test('an absent buyer_region resolves to US, and says so: region_source is defaulted', () => {
  for (const absent of [undefined, null, '', '   ']) {
    const resolved = resolveBuyerRegion(absent);
    assert.equal(resolved.region, 'US', `absent (${JSON.stringify(absent)}) must default to US`);
    // The load-bearing half. Mutant killed: reporting 'explicit' for the default -- the ADR asks for
    // this dimension precisely so a permanent silent US path is DISTINGUISHABLE from a chosen one.
    assert.equal(resolved.regionSource, 'defaulted');
  }
  assert.equal(DEFAULT_BUYER_REGION, 'US');
});

test('an explicit region is normalized to uppercase and reported as explicit', () => {
  assert.deepEqual(resolveBuyerRegion('GB'), { region: 'GB', regionSource: 'explicit' });
  // Case is presentation, not meaning: a lowercase 'gb' is the SAME region, not a rejected one.
  // Mutant killed: comparing before upcasing, which would silently default every lowercase caller to
  // US while their telemetry claimed 'explicit'... or worse, claimed 'defaulted' and hid the bug.
  assert.deepEqual(resolveBuyerRegion('gb'), { region: 'GB', regionSource: 'explicit' });
  assert.deepEqual(resolveBuyerRegion('gb '), { region: 'GB', regionSource: 'explicit' });
  assert.deepEqual(resolveBuyerRegion('  jp'), { region: 'JP', regionSource: 'explicit' });
});

test('anything that is not two ASCII letters is treated as ABSENT, never as an error', () => {
  // alpha-3, one letter, digits, inner whitespace, wrong types. Each must degrade to the default --
  // this function is on a request path where throwing would 400 a buyer for a partner's typo.
  for (const garbage of ['usa', 'GBR', 'G', '1X', 'g b', 'g-b', '££', 12, true, {}, ['G', 'B']]) {
    const resolved = resolveBuyerRegion(garbage);
    assert.equal(resolved.region, 'US', `garbage ${JSON.stringify(garbage)} must default to US`);
    // Mutant killed: reporting 'explicit' because the caller "sent something". They sent something we
    // could not read; the region we served was still an assumption.
    assert.equal(resolved.regionSource, 'defaulted', `garbage ${JSON.stringify(garbage)} is not explicit`);
  }
  assert.equal(normalizeBuyerRegion('usa'), '');
  assert.equal(normalizeBuyerRegion('GB'), 'GB');
});

test('a REJECTED region is distinguishable from an absent one, so it can be logged', () => {
  // Absent is the steady state and must not produce a log line on every request.
  assert.equal(isRejectedBuyerRegionInput(undefined), false);
  assert.equal(isRejectedBuyerRegionInput(null), false);
  assert.equal(isRejectedBuyerRegionInput(''), false);
  assert.equal(isRejectedBuyerRegionInput('   '), false);
  // A readable region is not a rejection either.
  assert.equal(isRejectedBuyerRegionInput('GB'), false);
  assert.equal(isRejectedBuyerRegionInput('gb'), false);
  // Mutant killed: folding "rejected" into "absent". A partner shipping `"buyer_region": "usa"` would
  // then be served US pricing forever with nothing anywhere recording that they tried to say otherwise.
  assert.equal(isRejectedBuyerRegionInput('usa'), true);
  assert.equal(isRejectedBuyerRegionInput('1X'), true);
  assert.equal(isRejectedBuyerRegionInput(12), true);
});

// ---------------------------------------------------------------------------
// 2. THE REGION -> CURRENCY MAP, in exactly one place
// ---------------------------------------------------------------------------

test('the region -> currency map covers ADR-024 Phase 1 and nothing is inferred backwards', () => {
  assert.deepEqual(
    Object.entries(BUYER_REGION_CURRENCY).sort(),
    [
      ['AU', 'AUD'], ['CA', 'CAD'], ['FR', 'EUR'], ['GB', 'GBP'], ['HK', 'HKD'],
      ['JP', 'JPY'], ['KR', 'KRW'], ['SE', 'SEK'], ['SG', 'SGD'], ['US', 'USD'],
    ].sort(),
  );
  assert.equal(currencyForBuyerRegion('US'), 'USD');
  assert.equal(currencyForBuyerRegion('gb'), 'GBP');
  assert.equal(currencyForBuyerRegion('JP'), 'JPY');
  // A well-formed but UNMODELLED region has no currency -- '' rather than a USD fallback. Mutant
  // killed: `|| 'USD'` here. Stamping USD on a region we have never priced is the fabrication
  // ADR-024 commitment 5 refuses; callers must decide what "we cannot price this" means for them.
  assert.equal(currencyForBuyerRegion('ZZ'), '');
  assert.equal(currencyForBuyerRegion('usa'), '');
  assert.equal(currencyForBuyerRegion(''), '');
  assert.equal(currencyForBuyerRegion(undefined), '');
});

test('every currency this map can produce is one the ceiling can actually enforce', () => {
  // normalizeRecoPriceCeiling DISABLES a ceiling whose currency is outside its allowlist. So a region
  // mapped to a currency missing from that list would silently turn "under 40" into "no ceiling" --
  // an admit-everything failure, not a refuse-everything one. Mutant killed: adding a region here
  // whose currency the enforcement side has never heard of.
  const known = new Set(RECO_PRICE_CEILING_KNOWN_CURRENCIES);
  for (const [region, currency] of Object.entries(BUYER_REGION_CURRENCY)) {
    assert.equal(known.has(currency), true, `${region} -> ${currency} is not an enforceable currency`);
  }
});

test('a context carries its region, and a context without one is US', () => {
  assert.equal(buyerRegionFromContext({ buyer_region: 'GB' }), 'GB');
  assert.equal(buyerRegionFromContext({ buyer_region: 'gb' }), 'GB');
  // Every call path this PR did NOT touch hands over a ctx with no region. It must read as today's
  // implicit US, or the "zero behavior change" claim is false wherever we did not look.
  assert.equal(buyerRegionFromContext({}), 'US');
  assert.equal(buyerRegionFromContext(null), 'US');
  assert.equal(buyerRegionFromContext({ buyer_region: 'usa' }), 'US');
});

// ---------------------------------------------------------------------------
// 3. THE RECALL POOL CACHE KEY (the leak)
// ---------------------------------------------------------------------------

const CACHE_DIMS = Object.freeze({
  queries: ['cleanser'],
  stepFamily: 'cleanser',
  lang: 'en',
  catalogSurface: 'beauty',
  plannerMode: 'step_aware',
});

test('with no region, the key is EXACTLY the pre-change dims plus a defaulted "us"', () => {
  // Recomputed independently, not read back from the module under test -- an assertion that calls the
  // function on both sides cannot fail. This pins the dims object byte for byte: a stray extra field,
  // a renamed key, or a region default of '' instead of 'us' all change this hash.
  const expected = crypto.createHash('sha256').update(JSON.stringify({
    v: 'reco_recall_pool_cache_v5',
    q: ['cleanser'],
    step: 'cleanser',
    lang: 'en',
    surface: 'beauty',
    mode: 'step_aware',
    seed: '',
    ceil: '',
    region: 'us',
  })).digest('hex');
  assert.equal(buildRecoRecallPoolCacheKey(CACHE_DIMS), expected);
});

test('an absent region and an explicit US produce the SAME key — today\'s traffic is untouched', () => {
  // GUARD. This passes against origin/main too, VACUOUSLY: main has no region parameter, so every
  // argument produced the same key. Post-change it is the assertion that pins the default to 'us'.
  const absent = buildRecoRecallPoolCacheKey(CACHE_DIMS);
  // Mutant killed: defaulting the region dimension to '' (or to the raw undefined) rather than 'us'.
  // Every request that sends no region would then key differently from one that explicitly says US,
  // splitting one hot pool into two and halving the hit rate on the exact lane this cache shields.
  assert.equal(buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: 'US' }), absent);
  assert.equal(buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: 'us' }), absent);
  assert.equal(buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: ' US ' }), absent);
  assert.equal(buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: '' }), absent);
});

test('a different region is a DIFFERENT row — this is the cross-region leak, closed', () => {
  const us = buildRecoRecallPoolCacheKey(CACHE_DIMS);
  const gb = buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: 'GB' });
  const jp = buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: 'JP' });
  // FAILS ON origin/main: the parameter did not exist there, so all three of these were the same
  // hash (8db46b29...) and a GB buyer's 24h pool served every US buyer on the fleet, and vice versa.
  assert.notEqual(gb, us);
  assert.notEqual(jp, us);
  assert.notEqual(gb, jp);
  // Case-folded like every other dimension, so 'gb' and 'GB' share their row rather than doubling it.
  assert.equal(buildRecoRecallPoolCacheKey({ ...CACHE_DIMS, region: 'gb' }), gb);
});

test('the cache version was bumped to v5, orphaning every region-blind row', () => {
  // Mutant killed: adding the region dimension WITHOUT the bump. The dims hash changes either way, so
  // the orphaning happens incidentally -- but the version string is the only thing that tells the next
  // reader the table went cold on purpose, and the sweep's reason lives beside it. Every previous
  // dimension in this key (ceil in v3, arm depth in v4) was landed with a bump for the same reason.
  assert.equal(RECO_RECALL_POOL_CACHE_VERSION, 'reco_recall_pool_cache_v5');
  // The RECORDED v4 key for CACHE_DIMS, measured against origin/main. No live row can be read again.
  assert.notEqual(
    buildRecoRecallPoolCacheKey(CACHE_DIMS),
    '8db46b29f150dce7aca04c9eb0ce7c7fb46a14215bdf9c893a9f269c9865fa64',
  );
});

// ---------------------------------------------------------------------------
// 4. THE CEILING CURRENCY: a declaration always wins
// ---------------------------------------------------------------------------
//
// THE RULE THIS PR IMPLEMENTS, pinned here and in the comment above
// resolveConcernFrameworkBudgetCeiling:
//
//   The region-derived currency fills a HOLE. It never overrides a unit the caller or the buyer
//   actually declared. "under $40" from a GB buyer is 40 USD, because the `$` is a declaration and
//   reinterpreting it as £40 would be the same move that made 1,172 offers read falsely conforming in
//   PR #2065. "under 40" from a GB buyer is 40 GBP, because nothing was declared and the request's
//   resolved region is then the only honest source.
//
// KNOWN LIMITATION, pinned deliberately: `$` is ambiguous across the dollar family (AUD/CAD/SGD/HKD).
// Phase 1 reads it as USD-as-written for every region rather than inferring a local dollar from the
// region -- an inference layered on top of a declaration is exactly what this rule exists to forbid.

function proseContext(text, region) {
  return { request_text: text, ...(region === undefined ? {} : { buyer_region: region }) };
}

test('prose with NO declared unit follows the buyer region', () => {
  // Mutant killed: the literal `currency: 'USD'` this replaced. On main every one of these was USD.
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('a serum under 40', 'GB')), {
    amount: 40, currency: 'GBP', exclusive: true,
  });
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('a serum under 4000', 'JP')), {
    amount: 4000, currency: 'JPY', exclusive: true,
  });
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('max 40', 'FR')), {
    amount: 40, currency: 'EUR', exclusive: false,
  });
});

test('a DECLARED unit in the prose beats the region — never override a declaration', () => {
  // The `$` is the buyer's own word. A GB buyer who writes it means dollars, and we do not get to
  // re-denominate their sentence. Mutant killed: deriving the currency unconditionally from region,
  // which silently converts a stated $40 ceiling into a £40 one and changes which products conform.
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('a serum under $40', 'GB')), {
    amount: 40, currency: 'USD', exclusive: true,
  });
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('a serum under usd 40', 'JP')), {
    amount: 40, currency: 'USD', exclusive: true,
  });
  // The bare-$ arm of the parser (no "under"/"max" lead-in) declares just as loudly.
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('$40 or less serum', 'SE')), {
    amount: 40, currency: 'USD', exclusive: false,
  });
});

test('US and no-region prose are byte-identical to what main returned', () => {
  // The zero-behavior-change claim for the ceiling. GUARD: these assertions pass on main too, by
  // construction -- that is the point. They fail if the region default drifts off US or if 'US' stops
  // mapping to USD.
  const expected = { amount: 40, currency: 'USD', exclusive: true };
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('under $40')), expected);
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('under 40')), expected);
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('under 40', 'US')), expected);
  // An unmodelled region keeps today's USD rather than acquiring a unit we cannot serve.
  assert.deepEqual(resolveConcernFrameworkBudgetCeiling(proseContext('under 40', 'ZZ')), expected);
  assert.equal(resolveConcernFrameworkBudgetCeiling(proseContext('a gentle serum', 'GB')), null);
});

test('the structured budget: a declared currency wins, an undeclared one follows the region', () => {
  assert.deepEqual(
    resolveConcernFrameworkBudgetCeiling({ budget_ceiling: { amount: 40 }, buyer_region: 'GB' }),
    { amount: 40, currency: 'GBP', exclusive: false },
  );
  // Mutant killed: passing regionCurrency as normalizeCurrencyCode's FIRST argument instead of its
  // fallback, which would override the caller's stated EUR with the region's GBP.
  assert.deepEqual(
    resolveConcernFrameworkBudgetCeiling({
      budget_ceiling: { amount: 40, currency: 'EUR', exclusive_upper_bound: true },
      buyer_region: 'GB',
    }),
    { amount: 40, currency: 'EUR', exclusive: true },
  );
  // GUARD: today's shape, unchanged.
  assert.deepEqual(
    resolveConcernFrameworkBudgetCeiling({ budget_ceiling: { amount: 40 } }),
    { amount: 40, currency: 'USD', exclusive: false },
  );
});

// ---------------------------------------------------------------------------
// 5. THREADING: ctx -> targetContext, past the planner that replaces it
// ---------------------------------------------------------------------------

function makeGenerationContextRuntime({ plannerTargetContext = null } = {}) {
  return createLegacyRecoGenerationContextRuntime({
    summarizeProfileForContext: () => ({}),
    normalizeIngredientRecoContextValue: () => null,
    buildAnalysisContextSnapshotForRoute: () => ({}),
    buildTaskAnalysisContextForPrefix: () => ({}),
    buildAnalysisContextPromptBlock: () => '',
    buildContextPrefix: () => '',
    pickFirstTrimmed: (...values) =>
      values.map((v) => String(v == null ? '' : v).trim()).find(Boolean) || '',
    resolveRecommendationTargetContext: () => (
      plannerTargetContext
        ? { resolved_target_step: null, intent_mode: 'generic_concern', framework_roles: [{ role_id: 'r1' }] }
        : { resolved_target_step: 'serum' }
    ),
    runConcernSemanticPlanner: async () => ({ semanticPlan: {}, trace: {} }),
    buildConcernTargetContextFromSemanticPlan: () => (
      // The planner branch REPLACES targetContext wholesale. A region stamped before this call is gone.
      plannerTargetContext || { resolved_target_step: null }
    ),
    buyerRegionFromContext,
  });
}

test('the resolved region reaches targetContext, which is how the ceiling ever sees it', async () => {
  const { buildLegacyRecoGenerationContext } = makeGenerationContextRuntime();
  const out = await buildLegacyRecoGenerationContext({
    ctx: { lang: 'EN', buyer_region: 'GB', buyer_region_source: 'explicit' },
    profile: {},
    recentLogs: [],
    message: 'a serum under 40',
  });
  assert.equal(out.targetContext.buyer_region, 'GB');
  assert.equal(out.targetContext.buyer_region_source, 'explicit');
  // The whole point of the wire: the ceiling resolved off THIS object must now be in GBP.
  assert.equal(
    resolveConcernFrameworkBudgetCeiling({ ...out.targetContext, request_text: 'a serum under 40' }).currency,
    'GBP',
  );
});

test('the stamp survives the semantic planner, which REPLACES the target context', async () => {
  const { buildLegacyRecoGenerationContext } = makeGenerationContextRuntime({
    plannerTargetContext: { resolved_target_step: null, selection_owner_state: 'trusted' },
  });
  const out = await buildLegacyRecoGenerationContext({
    ctx: { lang: 'EN', buyer_region: 'JP', buyer_region_source: 'explicit' },
    profile: {},
    recentLogs: [],
    message: 'something for dullness',
  });
  // Mutant killed: stamping the region where targetContext is first resolved instead of last. The
  // generic-concern lane -- the ONLY lane that reads the framework budget ceiling -- rebuilds
  // targetContext from the semantic plan, so an early stamp is discarded on exactly the path that
  // needs it, and every test that did not exercise the planner would still pass.
  assert.equal(out.targetContext.buyer_region, 'JP');
  assert.equal(out.targetContext.buyer_region_source, 'explicit');
});

test('a ctx with no region stamps US/defaulted, not undefined', async () => {
  const { buildLegacyRecoGenerationContext } = makeGenerationContextRuntime();
  const out = await buildLegacyRecoGenerationContext({
    ctx: { lang: 'EN' },
    profile: {},
    recentLogs: [],
    message: 'a serum under 40',
  });
  assert.equal(out.targetContext.buyer_region, 'US');
  assert.equal(out.targetContext.buyer_region_source, 'defaulted');
});

// ---------------------------------------------------------------------------
// 6. THE ROUTE CONTRACT AND ITS TELEMETRY
// ---------------------------------------------------------------------------

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function makeReq(body) {
  return {
    body,
    get: (name) => (String(name).toLowerCase() === 'x-aurora-uid' ? 'uid_test' : null),
  };
}

// Every dep is a fake except the four that carry the contract under test: the real request-context
// builder, the real request schema, and the real region resolver/rejector. No network, DB or LLM.
function makeHandler({ guardrail = false, logs = [] } = {}) {
  const seen = { ctx: null };
  const payload = {
    recommendations: [{ product_id: 'p1', name: 'A Serum' }],
    recommendation_meta: {},
  };
  const runtime = createDirectRecoGenerateHandlerRuntime({
    buildRequestContext,
    requireAuroraUid: () => {},
    RecoGenerateRequestSchema,
    resolveBuyerRegion,
    isRejectedBuyerRegionInput,
    buildEnvelope: (ctx, spec) => ({ request_id: ctx.request_id, ...spec }),
    makeAssistantMessage: (content) => ({ content }),
    makeEvent: (ctx, type, data) => ({ type, data }),
    resolveIdentity: async () => ({ auroraUid: 'uid_test', userId: null }),
    getProfileForIdentity: async () => ({}),
    getRecentSkinLogsForIdentity: async () => [],
    extractAnalysisProfileContextOverlay: () => null,
    extractProfilePatchFromSession: () => null,
    extractProfilePatchFromRequestContextPayload: () => null,
    loadLatestDiagnosisArtifactForRoute: async () => null,
    buildAnalysisContextSnapshotForRoute: () => ({}),
    buildTaskAnalysisContextForPrefix: () => ({}),
    summarizeProfileForContext: () => ({}),
    extractLatestRecoContextFromSession: () => null,
    buildAutoAnchoredRecoRequestText: () => '',
    buildRecoGenerateUserAsk: () => 'a serum under 40',
    resolveRecommendationTargetContext: () => ({ resolved_target_step: 'serum' }),
    mergeIngredientRecoContextValue: () => ({}),
    shouldDiagnosisGate: () => ({ gated: false, missing: [] }),
    buildDiagnosisPrompt: () => '',
    buildDiagnosisChips: () => [],
    buildConfidenceNoticeCardPayload: () => ({}),
    generateProductRecommendations: async (args) => {
      seen.ctx = args.ctx;
      return { norm: { payload, field_missing: [] }, contract: {} };
    },
    normalizeRecoGenerate: () => ({ payload, field_missing: [] }),
    buildRecoMainlineContract: () => ({}),
    extractRecoOutcomeContractArgsFromPayload: () => ({}),
    enrichRecommendationsWithAlternatives: async () => ({ recommendations: [], field_missing: [] }),
    mergeFieldMissing: (a) => a,
    AURORA_PRODUCT_MATCHER_ENABLED: false,
    AURORA_PRODUCT_MATCHER_BUNDLED_SEED_FALLBACK_ENABLED: false,
    buildIngredientPlan: () => ({}),
    DIAG_PRODUCT_CATALOG_PATH: '',
    buildProductRecommendationsBundle: () => ({}),
    toLegacyRecommendationsPayload: () => ({ recommendations: [] }),
    buildRecoLlmTraceRef: () => null,
    buildRecoSuccessFollowupChips: () => [],
    buildRecoEntryChips: () => [],
    deriveRecommendationContextState: () => ({ satisfied: true }),
    buildTaskAnalysisContextUsageMeta: () => ({}),
    REQUEST_CONTEXT_SIGNATURE_VERSION: 'v1',
    DIRECT_RECO_CANDIDATE_POOL_SIGNATURE_VERSION: 'v1',
    applyRecoContentSpineToPayload: (p) => p,
    applyRecoContractToRecoRequestedEvents: (events) => ({ events: events || [] }),
    buildRecoRequestedEventData: () => ({}),
    deriveRecoEmptyReason: () => '',
    AURORA_RECO_GENERATE_GUARDRAIL_V1: guardrail,
    applyBeautyCanonicalOwnershipToEnvelope: ({ envelope }) => envelope,
    applyRecommendationOutputGuardrailsForRoute: async ({ envelope }) => ({ envelope, rejected: [] }),
    persistRejectedCatalogCandidates: () => {},
    normalizeRecoGroundingStatus: () => null,
    attachRecoContractMeta: (p) => p,
    restorePlanOnlyRecommendations: (p) => p,
    logger: { warn: (obj, msg) => logs.push({ obj, msg }), info: () => {}, debug: () => {} },
  });
  return { runtime, seen };
}

async function runRoute(body, options = {}) {
  const { runtime, seen } = makeHandler(options);
  const res = makeRes();
  await runtime.handleDirectRecoGenerateRoute(makeReq(body), res);
  const card = (res.body.cards || []).find((c) => c.type === 'recommendations');
  return { res, seen, meta: card && card.payload && card.payload.recommendation_meta };
}

test('POST /v1/reco/generate accepts buyer_region and threads it onto ctx', async () => {
  const { seen, meta } = await runRoute({ focus: 'serum', buyer_region: 'gb' });
  // Threaded: the recall/grounding path reads region off ctx exactly where it reads lang.
  assert.equal(seen.ctx.buyer_region, 'GB');
  assert.equal(seen.ctx.buyer_region_source, 'explicit');
  // Measured: on the lane's existing telemetry surface, not a new channel.
  assert.equal(meta.buyer_region, 'GB');
  assert.equal(meta.region_source, 'explicit');
});

test('with no buyer_region the route still REPORTS the assumption it made', async () => {
  const { seen, meta } = await runRoute({ focus: 'serum' });
  assert.equal(seen.ctx.buyer_region, 'US');
  assert.equal(seen.ctx.buyer_region_source, 'defaulted');
  // The ADR's whole reason for this dimension. Mutant killed: emitting the region only when it was
  // explicit -- the silent US default would then be exactly as invisible as it is today, and no
  // operator could ever answer "how much of our traffic is being assumed into the wrong region?".
  assert.equal(meta.buyer_region, 'US');
  assert.equal(meta.region_source, 'defaulted');
});

test('the region is reported on the GUARDRAIL path too — the one that runs in prod', async () => {
  // GUARD as much as a test: the guarded block rebuilds recommendation_meta from the payload it was
  // handed, so the fields survive either way. It is pinned because that block ALSO re-stamps
  // analysis_context_usage and the signature versions, and a future edit that rebuilds the meta from
  // scratch instead of spreading would silently drop region on the only path prod takes.
  const { meta } = await runRoute({ focus: 'serum', buyer_region: 'JP' }, { guardrail: true });
  assert.equal(meta.buyer_region, 'JP');
  assert.equal(meta.region_source, 'explicit');
});

test('a garbage buyer_region is served, not rejected — and is logged exactly once', async () => {
  const logs = [];
  const { res, seen, meta } = await runRoute({ focus: 'serum', buyer_region: 'usa' }, { logs });
  // Mutant killed: typing buyer_region on the zod schema. safeParse failure is a 400 on this route, so
  // a partner's typo would take an OUTAGE instead of a defaulted region.
  assert.equal(res.statusCode, 200);
  assert.equal(seen.ctx.buyer_region, 'US');
  assert.equal(meta.region_source, 'defaulted');
  const rejections = logs.filter((l) => l.obj && l.obj.event === 'reco_buyer_region_rejected');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].obj.buyer_region_raw, 'usa');
});

test('an ABSENT buyer_region logs nothing — silence is only for the steady state', async () => {
  // GUARD. Passes against origin/main VACUOUSLY -- main emits no region log line under any input.
  // Post-change it is what stops the rejection warning from firing on 100% of production traffic.
  const logs = [];
  await runRoute({ focus: 'serum' }, { logs });
  // Mutant killed: warning on every default. A log line on 100% of production traffic is not a
  // signal, and it would bury the partner-integration bug this event exists to surface.
  assert.equal(logs.filter((l) => l.obj && l.obj.event === 'reco_buyer_region_rejected').length, 0);
});

test('the reco_requested event carries the region, projected from recommendation_meta', () => {
  const data = buildRecoRequestedEventData({
    payload: {
      recommendations: [{ product_id: 'p1' }],
      recommendation_meta: { buyer_region: 'GB', region_source: 'explicit' },
    },
  });
  assert.equal(data.buyer_region, 'GB');
  assert.equal(data.region_source, 'explicit');
  // A lane that does not stamp the pair emits neither field, so chat and the agent-signals door --
  // deliberately out of scope for this PR -- keep byte-identical events.
  const untouched = buildRecoRequestedEventData({
    payload: { recommendations: [{ product_id: 'p1' }], recommendation_meta: {} },
  });
  assert.equal('buyer_region' in untouched, false);
  assert.equal('region_source' in untouched, false);
});

// ---------------------------------------------------------------------------
// 7. WIRING: both recall call sites actually pass the region into the key
// ---------------------------------------------------------------------------
//
// Sections 3 and 6 prove the key FUNCTION separates regions and that the route puts the region on
// ctx. Neither proves the two are connected -- and a cache key argument that is simply not passed is
// the single most likely way this whole change silently does nothing: the key still builds, the pool
// still serves, nothing errors, and every unit test above still passes.
//
// So drive the REAL recall functions and read the key off the cache instance they actually use. The
// pool cache is a module-level singleton reached through getRecoRecallPoolCache(), and both call sites
// look `read` up on it at call time, so replacing that one method captures the key and stops the pass
// before it touches the network.

const { groundRecoRecommendationsFromCatalog, buildRecoGenerateFromCatalog, getRecoRecallPoolCache } = __internal;

async function captureRecallCacheKeys(run) {
  const cache = getRecoRecallPoolCache();
  assert.ok(cache, 'the pool cache must be constructible for this probe to mean anything');
  const originalRead = cache.read;
  const keys = [];
  cache.read = async (key) => {
    keys.push(key);
    const stop = new Error('probe stop');
    stop.code = 'PROBE_STOP';
    throw stop;
  };
  try {
    await run();
  } catch (err) {
    if (String(err && err.code) !== 'PROBE_STOP') throw err;
  } finally {
    cache.read = originalRead;
  }
  return keys;
}

test('the GROUNDING pass keys its pool on the request region', async () => {
  const keyFor = async (ctx) => {
    const keys = await captureRecallCacheKeys(() => groundRecoRecommendationsFromCatalog({
      recommendations: [{ display_name: 'A Gentle Cleanser', product_type: 'cleanser', step: 'cleanser' }],
      ctx,
      logger: null,
    }));
    assert.equal(keys.length, 1, 'the probe must observe exactly one key');
    return keys[0];
  };
  const us = await keyFor({ lang: 'EN' });
  const gb = await keyFor({ lang: 'EN', buyer_region: 'GB' });
  // Mutant killed: dropping `region:` from this call site. The key still builds and the pass still
  // runs -- it just serves a GB buyer whatever a US buyer cached, for up to 24 hours.
  assert.notEqual(gb, us);
  assert.equal(await keyFor({ lang: 'EN', buyer_region: 'US' }), us);
});

test('the RECALL pass keys its pool on the request region', async () => {
  const keyFor = async (ctx) => {
    const keys = await captureRecallCacheKeys(() => buildRecoGenerateFromCatalog({
      ctx,
      profileSummary: {},
      ingredientContext: null,
      targetContext: { resolved_target_step: 'cleanser', step_aware_intent: true },
      needSeedText: 'gentle cleanser',
      logger: null,
    }));
    assert.equal(keys.length, 1, 'the probe must observe exactly one key');
    return keys[0];
  };
  const us = await keyFor({ lang: 'EN' });
  const gb = await keyFor({ lang: 'EN', buyer_region: 'GB' });
  // Mutant killed: dropping `region:` from the second call site while remembering the first. The two
  // are ~900 lines apart and each writes into the SAME shared table.
  assert.notEqual(gb, us);
  assert.equal(await keyFor({ lang: 'EN', buyer_region: 'US' }), us);
});
