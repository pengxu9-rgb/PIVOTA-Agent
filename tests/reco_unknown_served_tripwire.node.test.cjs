'use strict';

// ADR-024's TRIPWIRE: a per-region census of the prices we ACTUALLY SERVED on POST /v1/reco/generate.
//
// WHY THIS SUITE EXISTS. The decision owner closed the FX question by DECLINING the ranker and asking
// for a measurement instead ("Resolved questions", 2026-08-21):
//
//   "FX-ranking -- DECIDED: not built ... every served pool is single-currency by construction, so
//    ranking never needs a rate. The residual case -- a foreign-currency row inside a region's pool --
//    is mislabeled supply (see the 433-EUR-as-US anomaly), an ingestion defect ... TRIPWIRE instead of
//    a ranker: count `unknown`-classified rows actually served, per region; materially nonzero means
//    clean data, not convert it."
//
// "Single-currency by construction" is a CLAIM, and this census is the only thing that can falsify it
// with our own telemetry. A materially nonzero `served_priced_foreign` for a region means MISLABELED
// SUPPLY -- clean the data, never convert the price. That is the whole enforcement arm of commitment 5
// ("No FX conversion reaches a buyer -- ever").
//
// THE OTHER HALF OF THE CONTRACT is that the census must be INERT. It is a read-only count taken after
// selection, after ranking, after the guardrail. Section 5 is a GUARD on exactly that: the served rows
// must be byte-identical with the census wired in and with it stubbed out. A tripwire that changes the
// answer has quietly become the ranker the ADR refused.
//
// RUN AGAINST REVERTED SOURCE. Deleting servedPriceRegionCensus.js too makes the whole file fail to
// LOAD, which proves nothing useful, so the recorded run reverts the three changed src files
// (routes.js, directRecoGenerateHandler.js, recoPriceCeiling.js) to origin/main and keeps the new
// module: 7 of 25 failed. The 18 that passed are accounted for, not glossed over:
//   * Sections 1-2 (12 tests) are unit tests for `servedPriceRegionCensus.js`, a module that does not
//     exist on main. They CANNOT fail against reverted source by construction; they earn their place
//     by killing mutants INSIDE it, and each one names the mutant it kills.
//   * Section 3's four REAL LANE tests call the census over rows the (unchanged) catalog lane built.
//     They also cannot fail with the module present -- their job is to prove the census can read what
//     the lane actually emits, which no hand-written fixture can establish, and a mutant in the
//     classifier kills all four.
//   * Two are labelled GUARD in section 5/6 and pass on main VACUOUSLY (with the wiring reverted the
//     census is never called, so both arms of the A/B are trivially equal; and the ceiling lane on
//     main is by definition unchanged from itself). They are load-bearing here, not there.
// A `Mutant killed:` label on a test that cannot fail is the house failure mode, so every such test
// above says which mutant it kills rather than claiming a regression it does not catch.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_BFF_PDP_CORE_PREFETCH_ENABLED = 'false';
process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
process.env.PIVOTA_BACKEND_BASE_URL = 'https://pivota-backend.test';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERVED_PRICE_REGION_CENSUS_META_KEYS,
  classifyServedRowPriceForRegion,
  buildServedPriceRegionCensus,
  pickServedPriceRegionCensusEventFields,
} = require('../src/auroraBff/servedPriceRegionCensus');
const {
  classifyRecoCandidateAgainstPriceCeiling,
  applyRecoPriceCeilingPreference,
  readRecoCandidatePriceForCeiling,
} = require('../src/auroraBff/recoPriceCeiling');
const {
  createDirectRecoGenerateHandlerRuntime,
} = require('../src/auroraBff/directRecoGenerateHandler');
const {
  resolveBuyerRegion,
  isRejectedBuyerRegionInput,
  currencyForBuyerRegion,
} = require('../src/auroraBff/buyerRegion');
const { RecoGenerateRequestSchema } = require('../src/auroraBff/schemas');
const { buildRequestContext } = require('../src/auroraBff/requestContext');
const { __internal } = require('../src/auroraBff/routes');
const dbModule = require('../src/db');

const {
  buildRecoGenerateFromCatalog,
  groundRecoRecommendationsFromCatalog,
  buildRecoRequestedEventData,
} = __internal;

const IN_REGION = 'served_priced_in_region';
const FOREIGN = 'served_priced_foreign';
const UNPRICED = 'served_unpriced';

/** A row in the shape mergeRecoPlanWithGroundedCandidate emits: a `price` object + a `currency` scalar. */
function servedRow(id, amount, currency) {
  const price = amount == null ? null : { amount, currency, unknown: false };
  return {
    product_id: id,
    merchant_id: 'm1',
    name: `Product ${id}`,
    display_name: `Product ${id}`,
    price,
    currency: price && price.currency ? price.currency : null,
    grounding_status: 'grounded',
  };
}

// ---------------------------------------------------------------------------
// 1. THE CENSUS, MECHANICALLY: three buckets, and they sum to what we served
// ---------------------------------------------------------------------------

test('an all-USD answer served to a US buyer reports ZERO foreign — the steady state', () => {
  const census = buildServedPriceRegionCensus(
    [servedRow('a', 12, 'USD'), servedRow('b', 45, 'USD'), servedRow('c', 6.5, 'USD')],
    'US',
  );
  // The number the ADR's "single-currency by construction" claim predicts for today's catalog. If this
  // ever moves in prod, the claim is falsified and the response is an ingestion fix.
  assert.deepEqual(census, { [IN_REGION]: 3, [FOREIGN]: 0, [UNPRICED]: 0 });
});

test('a GBP row served to a US buyer is FOREIGN — the mislabeled-supply signal', () => {
  const census = buildServedPriceRegionCensus(
    [servedRow('a', 12, 'USD'), servedRow('b', 88, 'GBP')],
    'US',
  );
  // Mutant killed: comparing amounts, or treating any priced row as in-region. The 433 EUR offers
  // stamped `market='US'` are exactly this row, and a census blind to the currency would report a
  // clean US pool while a US buyer was quoted 88 in a unit nobody converted.
  assert.deepEqual(census, { [IN_REGION]: 1, [FOREIGN]: 1, [UNPRICED]: 0 });
});

test('an UNPRICED row is unpriced, NEVER foreign', () => {
  const census = buildServedPriceRegionCensus(
    [servedRow('a', 12, 'USD'), servedRow('b', null, null)],
    'US',
  );
  // Mutant killed: folding "no price" into the foreign bucket. `served_priced_foreign` is the alarm
  // that sends someone hunting an ingestion defect; a missing price is a different (and much more
  // common) problem, and mixing them makes the alarm unactionable.
  assert.deepEqual(census, { [IN_REGION]: 1, [FOREIGN]: 0, [UNPRICED]: 1 });
});

test('a GB buyer served GBP rows counts them IN REGION — the census follows the request', () => {
  const rows = [servedRow('a', 88, 'GBP'), servedRow('b', 12, 'GBP'), servedRow('c', 45, 'USD')];
  // Mutant killed: hardcoding USD as the expected currency, which is the literal ADR-024 exists to
  // remove. Same rows, two regions, mirrored verdicts.
  assert.deepEqual(buildServedPriceRegionCensus(rows, 'GB'), { [IN_REGION]: 2, [FOREIGN]: 1, [UNPRICED]: 0 });
  assert.deepEqual(buildServedPriceRegionCensus(rows, 'US'), { [IN_REGION]: 1, [FOREIGN]: 2, [UNPRICED]: 0 });
});

test('an amount with NO readable unit is unpriced — it is not evidence of foreign supply', () => {
  const noUnit = { product_id: 'x', price: { amount: 40 }, currency: null };
  // Mutant killed: defaulting the row's currency to USD (or to the region's) when it declares none.
  // That is defect #2 (#2065) re-shipped: stamping a unit onto an amount that never had one. Here it
  // would ALSO make the tripwire silently under-report, because a stamped USD reads as in-region.
  assert.equal(classifyServedRowPriceForRegion(noUnit, 'US'), 'unpriced');
  assert.deepEqual(buildServedPriceRegionCensus([noUnit], 'US'), { [IN_REGION]: 0, [FOREIGN]: 0, [UNPRICED]: 1 });
});

test('a real currency OUTSIDE the ceiling allowlist is FOREIGN, not unpriced', () => {
  // INR is a real, well-formed currency that the ceiling lane's 14-currency allowlist does not carry.
  // Mutant killed: reusing the ceiling's allowlist normalizer for the census (i.e. dropping the
  // `normalizeCurrency` injection on readRecoCandidatePriceForCeiling). INR would then read as "no
  // currency" and be filed under `served_unpriced` -- burying ADR-024's own founding defect, the
  // Mintree INR prices, in the bucket for rows that have no price at all.
  const inr = servedRow('m', 4500, 'INR');
  assert.equal(classifyServedRowPriceForRegion(inr, 'US'), 'priced_foreign');
  assert.deepEqual(buildServedPriceRegionCensus([inr], 'US'), { [IN_REGION]: 0, [FOREIGN]: 1, [UNPRICED]: 0 });
});

test('a region we do not price for counts every priced row FOREIGN — ADR-024 allows no fallback', () => {
  // DE is not in BUYER_REGION_CURRENCY, so there is no expected currency at all.
  assert.equal(currencyForBuyerRegion('DE'), '');
  // Mutant killed: falling back to USD for an unmodelled region, which would report a DE buyer served
  // USD rows as a clean in-region answer. The ADR resolved the thin-region fallback as NONE -- "a
  // region with no priced offers gets an honest empty answer, not foreign-priced filler with a marker"
  // -- so serving priced rows there is the forbidden fallback and the tripwire must say so.
  assert.deepEqual(
    buildServedPriceRegionCensus([servedRow('a', 12, 'USD'), servedRow('b', null, null)], 'DE'),
    { [IN_REGION]: 0, [FOREIGN]: 1, [UNPRICED]: 1 },
  );
});

test('the three counts always sum to the rows served, and an empty answer is three zeros', () => {
  const rows = [servedRow('a', 12, 'USD'), servedRow('b', 88, 'GBP'), servedRow('c', null, null)];
  const census = buildServedPriceRegionCensus(rows, 'US');
  // Each count carries its own denominator; a foreign count with no total is a rate nobody can read.
  assert.equal(census[IN_REGION] + census[FOREIGN] + census[UNPRICED], rows.length);
  // Mutant killed: emitting the census only when something is nonzero. An ABSENT
  // `served_priced_foreign` and a ZERO one are the same dashboard reading, and "we served nothing
  // foreign" is the entire claim under measurement.
  assert.deepEqual(buildServedPriceRegionCensus([], 'US'), { [IN_REGION]: 0, [FOREIGN]: 0, [UNPRICED]: 0 });
  // Mutant killed: `rows || []` instead of an Array.isArray guard. A `null` answer survives that, but
  // a non-array truthy one throws inside the for..of -- and this census runs on the response path of a
  // live route, where a thrown TypeError is a 500 for a request that had a perfectly good answer.
  for (const notAList of [null, undefined, {}, 'nope', 7, true]) {
    assert.deepEqual(
      buildServedPriceRegionCensus(notAList, 'US'),
      { [IN_REGION]: 0, [FOREIGN]: 0, [UNPRICED]: 0 },
      `${JSON.stringify(notAList)} is not a list of served rows`,
    );
  }
});

test('the census READS the rows and never writes to them', () => {
  const rows = [servedRow('a', 12, 'USD'), servedRow('b', 88, 'GBP'), servedRow('c', null, null)];
  const before = JSON.stringify(rows);
  const identities = rows.slice();
  buildServedPriceRegionCensus(rows, 'GB');
  // Mutant killed: annotating each row with its verdict "for debugging". That is a field on the
  // response, and a field on the response is a thing a downstream reader can rank on.
  assert.equal(JSON.stringify(rows), before);
  assert.equal(rows.length, identities.length);
  rows.forEach((row, i) => assert.equal(row, identities[i], 'row identity must be untouched'));
});

// ---------------------------------------------------------------------------
// 2. THE EVENT PROJECTION: all three or none
// ---------------------------------------------------------------------------

test('a recommendation_meta carrying the census projects all three counts', () => {
  const fields = pickServedPriceRegionCensusEventFields({ [IN_REGION]: 2, [FOREIGN]: 1, [UNPRICED]: 0 });
  assert.deepEqual(fields, { [IN_REGION]: 2, [FOREIGN]: 1, [UNPRICED]: 0 });
  assert.deepEqual(Object.keys(fields).sort(), [...SERVED_PRICE_REGION_CENSUS_META_KEYS].sort());
});

test('a HALF-stamped meta projects NOTHING — a numerator with no denominator is not a metric', () => {
  assert.deepEqual(pickServedPriceRegionCensusEventFields({ [FOREIGN]: 3 }), {});
  assert.deepEqual(pickServedPriceRegionCensusEventFields({}), {});
  assert.deepEqual(pickServedPriceRegionCensusEventFields(null), {});
});

test('a NULL count is a missing census, not a census reporting zero', () => {
  // Mutant killed: validating with `Number(raw)` instead of `typeof raw === 'number'`. Number(null),
  // Number(''), Number(false) and Number([]) are all a finite, integral 0, so a coercing check would
  // publish "0 foreign rows served" for a lane that never took the census -- the same shape as #2069,
  // where a missing price passed a finite-number check and shipped as FREE.
  for (const empty of [null, '', false, [], '2']) {
    assert.deepEqual(
      pickServedPriceRegionCensusEventFields({ [IN_REGION]: 2, [FOREIGN]: empty, [UNPRICED]: 0 }),
      {},
      `a ${JSON.stringify(empty)} count must not read as a number`,
    );
  }
  assert.deepEqual(pickServedPriceRegionCensusEventFields({ [IN_REGION]: 2, [FOREIGN]: 1.5, [UNPRICED]: 0 }), {});
  assert.deepEqual(pickServedPriceRegionCensusEventFields({ [IN_REGION]: 2, [FOREIGN]: -1, [UNPRICED]: 0 }), {});
});

test('buildRecoRequestedEventData carries the census, and omits it for a lane that never stamps it', () => {
  const data = buildRecoRequestedEventData({
    payload: {
      recommendations: [{ product_id: 'p1' }],
      recommendation_meta: { buyer_region: 'US', region_source: 'defaulted', [IN_REGION]: 2, [FOREIGN]: 1, [UNPRICED]: 0 },
    },
  });
  // Mutant killed: dropping the projection. The census would then live only on the response card, and
  // the response card is not where anyone watches a per-region rate over time -- the whole point of a
  // tripwire is that it fires on the telemetry surface, next to the region it was counted against.
  assert.equal(data[FOREIGN], 1);
  assert.equal(data[IN_REGION], 2);
  assert.equal(data[UNPRICED], 0);
  assert.equal(data.buyer_region, 'US');
  // Chat and the agent-signals door do not take the census; their events must stay byte-identical.
  const untouched = buildRecoRequestedEventData({
    payload: { recommendations: [{ product_id: 'p1' }], recommendation_meta: {} },
  });
  for (const key of SERVED_PRICE_REGION_CENSUS_META_KEYS) assert.equal(key in untouched, false);
});

// ---------------------------------------------------------------------------
// 3. THE REAL SERVING PATH: rows built by the catalog lane, not by hand
// ---------------------------------------------------------------------------
//
// Sections 1-2 prove the census function. Neither proves it can read what the LANE actually emits --
// and a classifier that agrees with a hand-written fixture and disagrees with the real row shape is
// the most likely way this whole change silently reports zero forever. So drive the REAL
// buildRecoGenerateFromCatalog / groundRecoRecommendationsFromCatalog with the durable pool cache
// stubbed to a DB hit (the pattern in reco_strict_conforming_fill and reco_buyer_region_dimension),
// and census whatever comes out.

function poolRow(id, amount, currency, name) {
  return {
    product_id: id,
    merchant_id: 'm1',
    name,
    display_name: name,
    product_type: 'treatment',
    ...(amount == null ? {} : { price_amount: amount, currency }),
  };
}

async function withPool(pool, run) {
  const original = dbModule.query;
  dbModule.query = async (sql) => (/SELECT payload/.test(sql)
    ? { rows: [{ payload: pool, refreshed_at: new Date().toISOString() }] }
    : { rows: [], rowCount: 0 });
  try {
    return await run();
  } finally {
    dbModule.query = original;
  }
}

async function servedFromCatalog(pool, ctx = { lang: 'EN' }) {
  const out = await withPool(pool, () => buildRecoGenerateFromCatalog({
    ctx,
    profileSummary: null,
    ingredientContext: null,
    recommendationTaskContext: null,
    targetContext: { step_aware_intent: true, resolved_target_step: 'treatment', framework_roles: [] },
    needSeedText: 'a gentle exfoliant for sensitive skin',
    maxGenericQueries: 3,
    debug: false,
    logger: null,
  }));
  const rows = (out.structured && out.structured.recommendations) || [];
  assert.ok(rows.length > 0, 'the real catalog lane must produce rows for this probe to mean anything');
  return rows;
}

async function servedFromGrounding(pool, names, ctx = { lang: 'EN' }) {
  const out = await withPool(pool, () => groundRecoRecommendationsFromCatalog({
    recommendations: names.map((name) => ({ display_name: name, product_type: 'treatment', step: 'treatment' })),
    ctx,
    logger: null,
  }));
  const rows = out.recommendations || [];
  assert.ok(rows.length > 0, 'the real grounding pass must produce rows for this probe to mean anything');
  return rows;
}

test('REAL LANE: an all-USD pool served to a US buyer reports zero foreign', async () => {
  const rows = await servedFromCatalog([
    poolRow('a', 12, 'USD', 'AXIS-Y PHA Peel'),
    poolRow('b', 45, 'USD', 'COSRX AHA Serum'),
  ]);
  const census = buildServedPriceRegionCensus(rows, 'US');
  assert.equal(census[FOREIGN], 0);
  assert.equal(census[IN_REGION], rows.length);
});

test('REAL LANE: a GBP-priced GROUNDED row served to a US buyer is counted foreign', async () => {
  const rows = await servedFromGrounding(
    [poolRow('a', 12, 'USD', 'AXIS-Y PHA Peel'), poolRow('b', 88, 'GBP', 'Dear Barber Face Cream')],
    ['AXIS-Y PHA Peel', 'Dear Barber Face Cream'],
  );
  // The grounded row really does carry GBP end to end -- #2065 is what makes that true, and if it
  // regresses the row would arrive stamped USD and this census would report a clean pool.
  const gbp = rows.find((row) => row.price && row.price.currency === 'GBP');
  assert.ok(gbp, 'the GBP row must survive grounding with its declared currency');
  // Mutant killed: reading the row's price with a second, hand-rolled reader instead of the serving
  // path's own `readRecoCandidatePriceForCeiling`. The two readers would then be free to disagree
  // about what a row costs -- which is precisely how #2065 shipped.
  assert.deepEqual(buildServedPriceRegionCensus(rows, 'US'), { [IN_REGION]: 1, [FOREIGN]: 1, [UNPRICED]: 0 });
});

test('REAL LANE: an unpriced catalog row lands in `unpriced`, never in `foreign`', async () => {
  const rows = await servedFromCatalog([
    poolRow('a', 12, 'USD', 'AXIS-Y PHA Peel'),
    poolRow('c', null, null, 'Naturium PHA Exfoliant'),
  ]);
  const census = buildServedPriceRegionCensus(rows, 'US');
  assert.equal(census[UNPRICED], 1, JSON.stringify(rows.map((r) => r.price)));
  assert.equal(census[FOREIGN], 0);
});

test('REAL LANE: a GB buyer served GBP rows counts them in region', async () => {
  const pool = [poolRow('b', 88, 'GBP', 'Dear Barber Face Cream'), poolRow('d', 22, 'GBP', 'Dear Barber Balm')];
  const rows = await servedFromCatalog(pool, { lang: 'EN', buyer_region: 'GB' });
  assert.deepEqual(buildServedPriceRegionCensus(rows, 'GB'), { [IN_REGION]: rows.length, [FOREIGN]: 0, [UNPRICED]: 0 });
  // Same rows, US region: every one of them is the mislabeled-supply signal.
  assert.equal(buildServedPriceRegionCensus(rows, 'US')[FOREIGN], rows.length);
});

// ---------------------------------------------------------------------------
// 4. THE ROUTE: the counts reach recommendation_meta and the emitted event
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

// Every dep is a fake except the ones that carry the contract under test: the real request-context
// builder, the real schema, the real region resolver, the real census, and the REAL
// buildRecoRequestedEventData -- so the projection is exercised through the handler, not simulated.
function makeHandler({ guardrail = false, recommendations = [], census = buildServedPriceRegionCensus, guardrailDrop = 0 } = {}) {
  const emitted = [];
  const payload = { recommendations: recommendations.slice(), recommendation_meta: {} };
  const runtime = createDirectRecoGenerateHandlerRuntime({
    buildRequestContext,
    requireAuroraUid: () => {},
    RecoGenerateRequestSchema,
    resolveBuyerRegion,
    isRejectedBuyerRegionInput,
    buildServedPriceRegionCensus: census,
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
    buildRecoGenerateUserAsk: () => 'a serum',
    resolveRecommendationTargetContext: () => ({ resolved_target_step: 'serum' }),
    mergeIngredientRecoContextValue: () => ({}),
    shouldDiagnosisGate: () => ({ gated: false, missing: [] }),
    buildDiagnosisPrompt: () => '',
    buildDiagnosisChips: () => [],
    buildConfidenceNoticeCardPayload: () => ({}),
    generateProductRecommendations: async () => ({ norm: { payload, field_missing: [] }, contract: {} }),
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
    applyRecoContractToRecoRequestedEvents: (events, contract, opts) => {
      emitted.push(opts && opts.eventData);
      return { events: events || [] };
    },
    buildRecoRequestedEventData,
    deriveRecoEmptyReason: () => '',
    AURORA_RECO_GENERATE_GUARDRAIL_V1: guardrail,
    applyBeautyCanonicalOwnershipToEnvelope: ({ envelope }) => envelope,
    // Mirrors what the real guardrail does: it REJECTS rows and hands back a card whose payload holds
    // the surviving ones. `guardrailDrop` trims from the front.
    applyRecommendationOutputGuardrailsForRoute: async ({ envelope }) => {
      if (!guardrailDrop) return { envelope, rejected: [] };
      const cards = (envelope.cards || []).map((card) => (card.type === 'recommendations'
        ? { ...card, payload: { ...card.payload, recommendations: card.payload.recommendations.slice(guardrailDrop) } }
        : card));
      return { envelope: { ...envelope, cards }, rejected: payload.recommendations.slice(0, guardrailDrop) };
    },
    persistRejectedCatalogCandidates: () => {},
    normalizeRecoGroundingStatus: () => null,
    attachRecoContractMeta: (p) => p,
    restorePlanOnlyRecommendations: (p) => p,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  });
  return { runtime, emitted };
}

async function runRoute(body, options = {}) {
  const { runtime, emitted } = makeHandler(options);
  const res = makeRes();
  await runtime.handleDirectRecoGenerateRoute(makeReq(body), res);
  const card = (res.body.cards || []).find((c) => c.type === 'recommendations');
  return {
    res,
    emitted,
    meta: card && card.payload && card.payload.recommendation_meta,
    rows: (card && card.payload && card.payload.recommendations) || [],
  };
}

// DELIBERATELY ASYMMETRIC: two USD, one GBP, one unpriced. A 1-USD/1-GBP fixture would give a US
// buyer and a GB buyer the SAME three counts, and every "the census follows the request region"
// assertion built on it would be unfalsifiable -- an assertion that cannot fail is the house failure
// mode. Here US reads 2/1/1 and GB reads 1/2/1, so the region genuinely has to reach the census.
const MIXED = [
  servedRow('a', 12, 'USD'),
  servedRow('b', 45, 'USD'),
  servedRow('c', 88, 'GBP'),
  servedRow('d', null, null),
];

test('the census lands in recommendation_meta, right beside the region it was counted against', async () => {
  const { meta } = await runRoute({ focus: 'serum' }, { recommendations: MIXED });
  // Mutant killed: stamping the census without the region, or on a different surface. A count of
  // "1 foreign" is meaningless until you know which region it was foreign TO; the pair is the metric.
  assert.equal(meta.buyer_region, 'US');
  assert.equal(meta.region_source, 'defaulted');
  assert.equal(meta[IN_REGION], 2);
  assert.equal(meta[FOREIGN], 1);
  assert.equal(meta[UNPRICED], 1);
});

test('the census follows the REQUEST region, not a server-side constant', async () => {
  const { meta } = await runRoute({ focus: 'serum', buyer_region: 'gb' }, { recommendations: MIXED });
  assert.equal(meta.buyer_region, 'GB');
  // Mutant killed: censusing against DEFAULT_BUYER_REGION instead of ctx.buyer_region. Identical rows,
  // and the verdicts must swap with the region -- otherwise every non-US partner reads a US census.
  assert.equal(meta[IN_REGION], 1);
  assert.equal(meta[FOREIGN], 2);
  assert.equal(meta[UNPRICED], 1);
  assert.equal(meta[IN_REGION] + meta[FOREIGN] + meta[UNPRICED], MIXED.length);
});

test('the emitted reco_requested event carries the census', async () => {
  const { emitted } = await runRoute({ focus: 'serum', buyer_region: 'gb' }, { recommendations: MIXED });
  const data = emitted.filter(Boolean).pop();
  assert.ok(data, 'the route must emit reco_requested event data');
  // Through the REAL buildRecoRequestedEventData, off the REAL stamped meta -- the seam where a
  // key-name typo would leave the response card correct and the dashboard permanently empty.
  assert.equal(data.buyer_region, 'GB');
  assert.equal(data[FOREIGN], 2);
  assert.equal(data[IN_REGION], 1);
  assert.equal(data[UNPRICED], 1);
});

test('on the GUARDRAIL path the census counts the rows the guardrail LEFT, not the ones it dropped', async () => {
  const { meta, rows, emitted } = await runRoute(
    { focus: 'serum' },
    { recommendations: MIXED, guardrail: true, guardrailDrop: 2 },
  );
  // The guardrail rejected both USD rows; two remain (GBP + unpriced).
  assert.equal(rows.length, 2);
  // Mutant killed: omitting the census from the guardrail block, so `guardedMeta` carries the
  // PRE-guardrail counts forward (2 in-region). It would report in-region rows this buyer never saw,
  // and the guardrail path is the one that runs in prod -- i.e. the mutant is invisible in the one
  // place the measurement is for.
  assert.equal(meta[IN_REGION], 0);
  assert.equal(meta[FOREIGN], 1);
  assert.equal(meta[UNPRICED], 1);
  const data = emitted.filter(Boolean).pop();
  assert.equal(data[IN_REGION], 0, 'the guardrail path rebuilds the event from the guarded payload');
  assert.equal(data[FOREIGN], 1);
});

// ---------------------------------------------------------------------------
// 5. GUARD: the tripwire is INERT
// ---------------------------------------------------------------------------

test('GUARD: the served rows are BYTE-IDENTICAL with the census wired in and with it stubbed out', async () => {
  const withCensus = await runRoute({ focus: 'serum', buyer_region: 'gb' }, { recommendations: MIXED });
  const withoutCensus = await runRoute(
    { focus: 'serum', buyer_region: 'gb' },
    { recommendations: MIXED, census: () => ({}) },
  );
  // Mutant killed: ANY census that touches the answer -- sorting in-region rows first, dropping a
  // foreign row, annotating rows with their verdict, converting an amount. ADR-024 declined the FX
  // ranker and asked for a measurement; the moment a count moves a row, the measurement HAS BECOME the
  // ranker, and this assertion is the only thing standing between those two.
  assert.equal(JSON.stringify(withCensus.rows), JSON.stringify(withoutCensus.rows));
  assert.equal(withCensus.rows.length, MIXED.length);
  // ...and the stub really did disable it, so the comparison above is not two empty things.
  assert.equal(withCensus.meta[FOREIGN], 2);
  assert.equal(FOREIGN in withoutCensus.meta, false);
});

test('GUARD: the census also leaves the rest of the response alone', async () => {
  const strip = (out) => {
    const clone = JSON.parse(JSON.stringify(out.res.body));
    for (const card of clone.cards || []) {
      if (card.type !== 'recommendations') continue;
      for (const key of SERVED_PRICE_REGION_CENSUS_META_KEYS) delete card.payload.recommendation_meta[key];
    }
    // The request id is per-request by construction and says nothing about the census.
    return JSON.stringify(clone).split(clone.request_id).join('<rid>');
  };
  const withCensus = await runRoute({ focus: 'serum' }, { recommendations: MIXED });
  const withoutCensus = await runRoute({ focus: 'serum' }, { recommendations: MIXED, census: () => ({}) });
  // Mutant killed: the census reaching a contract field, a chip, a session patch or the empty-reason
  // -- anywhere a downstream branch could read it back. The three meta keys are its ENTIRE footprint.
  assert.equal(strip(withCensus), strip(withoutCensus));
});

// ---------------------------------------------------------------------------
// 6. THE CEILING LANE IS UNCHANGED by the currency-normalizer seam
// ---------------------------------------------------------------------------
//
// The census reads prices through `readRecoCandidatePriceForCeiling` with a LOOSER currency
// normalizer. That reader is also the price ceiling's, and the ceiling's whole job is to REFUSE a
// cross-currency comparison. So pin that the seam cannot loosen it.

test('GUARD: a currency outside the ceiling allowlist is STILL `unknown` against a USD ceiling', () => {
  // GUARD. Passes on origin/main by definition -- the ceiling lane there is unchanged from itself.
  // Load-bearing HERE because this PR hands that lane's reader a looser currency normalizer, and the
  // whole value of the ceiling is that it REFUSES a comparison it cannot make.
  const inr = servedRow('m', 4500, 'INR');
  // classifyRecoCandidateAgainstPriceCeiling re-normalizes with its OWN allowlist, so a loose reader
  // cannot leak into a verdict. Mutant killed: making normalizeCurrencyToken itself shape-only, which
  // would let 4500 INR be compared against a 40 USD ceiling and reported `over` -- a fabricated verdict
  // across units, exactly defect #4.
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(inr, { limit: 40, currency: 'USD' }), 'unknown');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(servedRow('g', 12, 'GBP'), { limit: 40, currency: 'USD' }), 'unknown');
  assert.equal(classifyRecoCandidateAgainstPriceCeiling(servedRow('u', 12, 'USD'), { limit: 40, currency: 'USD' }), 'conforming');
});

test('GUARD: the default reader is byte-identical to before the seam, and preference order is untouched', () => {
  const rows = [servedRow('over', 62, 'USD'), servedRow('inr', 4500, 'INR'), servedRow('ok', 5, 'USD')];
  // Default arg = today's allowlist normalizer: INR reads as no-currency for the ceiling, as it always
  // did. Mutant killed: changing the DEFAULT normalizer rather than adding an injection point.
  assert.deepEqual(readRecoCandidatePriceForCeiling(rows[1]), { amount: 4500, currency: '' });
  assert.deepEqual(readRecoCandidatePriceForCeiling(rows[2]), { amount: 5, currency: 'USD' });
  // conforming > unknown > over, unchanged.
  const ordered = applyRecoPriceCeilingPreference(rows, { limit: 40, currency: 'USD' });
  assert.deepEqual(ordered.map((r) => r.product_id), ['ok', 'inr', 'over']);
});
