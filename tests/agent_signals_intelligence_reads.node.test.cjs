'use strict';

// Unit tests for the agent intelligence projections (get_alternatives / get_offers).
// Pure adapters + injected handlers — no DB, no network. Run: node --test tests/agent_signals_intelligence_reads.node.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { relationshipEdgeToSignal, relationshipEdgesToSignals } = require('../src/agentSignals/relationshipEdgeToSignal');
const { offerToSignal, offersToSignals } = require('../src/agentSignals/offerToSignal');
const { makeGetAlternatives, makeGetOffers, mapOffersResolveResponse } = require('../src/agentSignals/intelligenceReads');

function sampleEdge(over = {}) {
  return {
    anchor_ref: 'prod_anchor',
    candidate_product_ref: 'prod_cand',
    candidate_snapshot: { title: 'Cand Serum', brand: 'BrandX', price: 19.99, currency: 'USD', image_url: 'https://x/y.jpg' },
    relation_type: 'competitive_alternative',
    display_label: 'Similar, cheaper',
    score_total: 0.88,
    price_evidence: { price_ratio: 0.8 },
    source_refs: [{ type: 'review', ref: 'r1', authoritative: true }],
    evidence_grade: 'B',
    why_candidate: { text: 'same actives' },
    tradeoffs: ['smaller size'],
    watchouts: ['different fragrance'],
    label_state: 'human_approved',
    last_verified_at: '2026-06-01T00:00:00Z',
    expires_at: '2026-07-01T00:00:00Z',
    ...over,
  };
}

test('relationshipEdgeToSignal: 1:1 field map incl. evidence/freshness/review_state', () => {
  const s = relationshipEdgeToSignal(sampleEdge(), { anchorId: 'prod_anchor' });
  assert.equal(s.signal_type, 'alternative');
  assert.deepEqual(s.subject, { kind: 'product', id: 'prod_anchor' });
  assert.equal(s.value.related.ref, 'prod_cand');
  assert.equal(s.value.related.title, 'Cand Serum');
  assert.equal(s.value.related.price, 19.99);
  assert.equal(s.value.relation, 'competitive_alternative');
  assert.equal(s.value.score, 0.88);
  assert.deepEqual(s.value.tradeoffs, ['smaller size']);
  assert.deepEqual(s.value.watchouts, ['different fragrance']);
  assert.equal(s.evidence.grade, 'B');
  assert.equal(s.evidence.confidence, null); // similarity score is NOT laundered into evidence confidence
  assert.equal(s.evidence.method, 'crawled');
  assert.equal(s.evidence.sources[0].authoritative, true);
  assert.equal(s.freshness.observed_at, '2026-06-01T00:00:00Z');
  assert.equal(s.freshness.fresh_until, '2026-07-01T00:00:00Z');
  assert.equal(s.review_state, 'human_approved');
  assert.equal(s.visibility, 'buyer_safe');
});

test('related_product → signal_type "related"', () => {
  const s = relationshipEdgeToSignal(sampleEdge({ relation_type: 'related_product' }));
  assert.equal(s.signal_type, 'related');
  assert.equal(s.value.relation, 'related_product');
});

test('dupe excluded unless includeDupes', () => {
  const edges = [sampleEdge({ relation_type: 'dupe' }), sampleEdge()];
  assert.equal(relationshipEdgesToSignals(edges, { includeDupes: false }).length, 1);
  assert.equal(relationshipEdgesToSignals(edges, { includeDupes: true }).length, 2);
});

test('evidence_grade D dropped', () => {
  const edges = [sampleEdge({ evidence_grade: 'D' }), sampleEdge({ evidence_grade: 'A' })];
  const out = relationshipEdgesToSignals(edges, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].evidence.grade, 'A');
});

test('max_price_ratio filters pricier candidates', () => {
  const edges = [sampleEdge({ price_evidence: { price_ratio: 1.4 } }), sampleEdge({ price_evidence: { price_ratio: 0.7 } })];
  const out = relationshipEdgesToSignals(edges, { maxPriceRatio: 1.0 });
  assert.equal(out.length, 1);
  assert.equal(out[0].value.price_comparison.price_ratio, 0.7);
});

test('edge with no price_evidence passes the maxPriceRatio filter (unknown ratio not dropped)', () => {
  const edges = [sampleEdge({ price_evidence: null }), sampleEdge({ price_evidence: { price_ratio: 2.0 } })];
  const out = relationshipEdgesToSignals(edges, { maxPriceRatio: 1.0 });
  assert.equal(out.length, 1); // the unknown-ratio one survives, the 2.0 one is dropped
  assert.equal(out[0].value.price_comparison, null);
});

test('signals ordered by score desc and limited', () => {
  const edges = [
    sampleEdge({ score_total: 0.5, candidate_product_ref: 'a' }),
    sampleEdge({ score_total: 0.9, candidate_product_ref: 'b' }),
    sampleEdge({ score_total: 0.7, candidate_product_ref: 'c' }),
  ];
  const out = relationshipEdgesToSignals(edges, { limit: 2 });
  assert.equal(out.length, 2);
  assert.equal(out[0].value.related.ref, 'b');
  assert.equal(out[1].value.related.ref, 'c');
});

function sampleOffer(over = {}) {
  return { merchant_id: 'm1', merchant_name: 'Shop One', price: 25.0, currency: 'USD', availability: 'in_stock', is_primary: false, ...over };
}

test('offerToSignal maps + seller_trust null', () => {
  const s = offerToSignal(sampleOffer({ price_confidence: 0.9 }), { productId: 'p1' });
  assert.equal(s.signal_type, 'offer');
  assert.deepEqual(s.subject, { kind: 'offer', id: 'm1:p1' });
  assert.equal(s.value.price, 25);
  assert.equal(s.evidence.confidence, 0.9);
  assert.equal(s.evidence.method, 'merchant_reported');
  assert.equal(s.seller_trust, null);
  assert.equal(s.visibility, 'buyer_safe');
});

test('offerToSignal surfaces attributed affiliate_url + purchase_route; absent → null', () => {
  const attributed = 'https://api.pivota.cc/r?token=eyJ2IjowfQ==.c2ln';
  const s = offerToSignal(
    sampleOffer({ affiliate_url: attributed, purchase_route: 'affiliate_outbound' }),
    { productId: 'p1' },
  );
  assert.equal(s.value.affiliate_url, attributed);
  assert.equal(s.value.purchase_route, 'affiliate_outbound');
  const bare = offerToSignal(sampleOffer(), { productId: 'p1' });
  assert.equal(bare.value.affiliate_url, null);
  assert.equal(bare.value.purchase_route, null);
});

test('offersToSignals: best = primary then lowest price', () => {
  const offers = [
    sampleOffer({ merchant_id: 'm1', price: 30 }),
    sampleOffer({ merchant_id: 'm2', price: 20 }),
    sampleOffer({ merchant_id: 'm3', price: 22, is_primary: true }),
  ];
  const { best_offer, signals } = offersToSignals(offers, { productId: 'p1' });
  assert.equal(signals.length, 3);
  assert.equal(best_offer.value.merchant_id, 'm3');
});

test('single offer → best, no fabricated competition', () => {
  const { best_offer, signals } = offersToSignals([sampleOffer({ price: 15 })], { productId: 'p1' });
  assert.equal(signals.length, 1);
  assert.equal(best_offer.value.price, 15);
});

test('all-unpriced offers → best_offer falls back to first signal', () => {
  const offers = [sampleOffer({ merchant_id: 'm1', price: undefined }), sampleOffer({ merchant_id: 'm2', price: undefined })];
  const { best_offer, signals } = offersToSignals(offers, { productId: 'p1' });
  assert.equal(signals.length, 2);
  assert.equal(best_offer.value.merchant_id, 'm1'); // no priced offers → signals[0]
  assert.equal(best_offer.value.price, null);
});

test('makeGetAlternatives: disabled → empty + reason, recall not called', async () => {
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async () => { throw new Error('should not be called'); },
    isEnabled: () => false,
  });
  const res = await handler({ payload: { product_id: 'p1' } });
  assert.deepEqual(res.signals, []);
  assert.equal(res.metadata.reason, 'disabled');
});

test('makeGetAlternatives: default relations exclude dupe; anchor refs passed', async () => {
  let captured;
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async (args) => { captured = args; return [sampleEdge()]; },
    buildAnchorRefsFromProduct: ({ product_id }) => [product_id],
    isEnabled: () => true,
  });
  const res = await handler({ payload: { product_id: 'p1' } });
  assert.ok(!captured.relationTypes.includes('dupe'));
  assert.deepEqual(captured.anchorRefs, ['p1']);
  assert.equal(res.signals.length, 1);
});

test('makeGetAlternatives: hydrateCandidates fills title-less candidate snapshots', async () => {
  // Real prod edges have brand but NO title in candidate_snapshot (titles are read-time resolved).
  const titleless = sampleEdge({ candidate_snapshot: { brand: '786 Cosmetics', price: 19.99, currency: 'USD' } });
  let hydrateRanWith = null;
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async () => [titleless],
    buildAnchorRefsFromProduct: ({ product_id }) => [product_id],
    isEnabled: () => true,
    hydrateCandidates: async (edges) => {
      hydrateRanWith = edges.length;
      for (const e of edges) {
        if (!e.candidate_snapshot.title) e.candidate_snapshot.title = 'Resolved Lip Gloss';
      }
    },
  });
  const res = await handler({ payload: { product_id: 'p1' } });
  assert.equal(hydrateRanWith, 1);
  assert.equal(res.signals[0].value.related.title, 'Resolved Lip Gloss');
  assert.equal(res.signals[0].value.related.brand, '786 Cosmetics');
});

test('makeGetAlternatives: a hydrateCandidates throw is fail-open (edges still served)', async () => {
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async () => [sampleEdge()],
    buildAnchorRefsFromProduct: ({ product_id }) => [product_id],
    isEnabled: () => true,
    hydrateCandidates: async () => { throw new Error('resolver down'); },
  });
  const res = await handler({ payload: { product_id: 'p1' } });
  assert.equal(res.signals.length, 1); // not dropped on hydration failure
});

test('makeGetAlternatives: relation:dupe requests dupes only', async () => {
  let captured;
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async (args) => { captured = args; return [sampleEdge({ relation_type: 'dupe' })]; },
    buildAnchorRefsFromProduct: ({ product_id }) => [product_id],
    isEnabled: () => true,
  });
  const res = await handler({ payload: { product_id: 'p1', relation: 'dupe' } });
  assert.deepEqual(captured.relationTypes, ['dupe']);
  assert.equal(res.signals.length, 1);
  assert.equal(res.signals[0].value.relation, 'dupe');
});

test('makeGetAlternatives: include_dupes adds dupe to default set', async () => {
  let captured;
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async (args) => { captured = args; return []; },
    buildAnchorRefsFromProduct: ({ product_id }) => [product_id],
    isEnabled: () => true,
  });
  await handler({ payload: { product_id: 'p1', include_dupes: true } });
  assert.ok(captured.relationTypes.includes('dupe'));
  assert.ok(captured.relationTypes.includes('competitive_alternative'));
});

test('makeGetAlternatives: no anchor → reason', async () => {
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async () => [],
    buildAnchorRefsFromProduct: () => [],
    isEnabled: () => true,
  });
  const res = await handler({ payload: {} });
  assert.equal(res.metadata.reason, 'no_anchor');
});

test('makeGetOffers: no fetchOffers → offers_source_unavailable (fail closed)', async () => {
  const res = await makeGetOffers({})({ payload: { product_id: 'p1' } });
  assert.equal(res.metadata.reason, 'offers_source_unavailable');
  assert.deepEqual(res.signals, []);
  assert.equal(res.best_offer, null);
});

test('makeGetOffers: maps fetched offers', async () => {
  const handler = makeGetOffers({ fetchOffers: async () => ({ offers: [sampleOffer({ price: 12 })], product_group_id: 'g1' }) });
  const res = await handler({ payload: { product_id: 'p1' } });
  assert.equal(res.signals.length, 1);
  assert.equal(res.best_offer.value.price, 12);
  assert.equal(res.metadata.product_group_id, 'g1');
});

test('mapOffersResolveResponse: maps offers[] + canonical_product_group_id', () => {
  const res = { offers: [sampleOffer({ merchant_id: 'm1' }), sampleOffer({ merchant_id: 'm2' })], mapping: { canonical_product_group_id: 'grp1' } };
  const out = mapOffersResolveResponse(res, 'fallback');
  assert.equal(out.offers.length, 2);
  assert.equal(out.product_group_id, 'grp1'); // mapping wins over fallback
});

test('mapOffersResolveResponse: missing offers → [] and fallback group id', () => {
  const out = mapOffersResolveResponse({}, 'fallback_grp');
  assert.deepEqual(out.offers, []);
  assert.equal(out.product_group_id, 'fallback_grp');
});

test('get_offers over a CROSS-MERCHANT offers.resolve response → best = lowest price', async () => {
  // Simulates the wired fetchOffers: offers.resolve returns offers across 2 merchants → mapOffersResolveResponse.
  const offersResolveResponse = {
    offers: [sampleOffer({ merchant_id: 'm1', price: 30 }), sampleOffer({ merchant_id: 'm2', price: 20 })],
    mapping: { canonical_product_group_id: 'grp1' },
  };
  const handler = makeGetOffers({ fetchOffers: async () => mapOffersResolveResponse(offersResolveResponse) });
  const res = await handler({ payload: { product_id: 'p1', merchant_id: 'm1' } });
  assert.equal(res.signals.length, 2); // cross-merchant
  assert.equal(res.best_offer.value.merchant_id, 'm2'); // lowest price
  assert.equal(res.metadata.product_group_id, 'grp1');
});

// ---------------------------------------------------------------------------------------------
// EXECUTION SPEC v0 — cart_prefilled.
//
// The card rail's handoff is only useful if the agent knows what it is handing off TO. The
// backend's redirect builder already decides whether `affiliate_url` resolves to a pre-filled
// cart or a bare PDP, but it stamped that into the signed token as `join_mode` and never
// returned it — so the agent holding the link could not tell. These pin the passthrough and,
// more importantly, that ABSENCE never reads as a promise.
// ---------------------------------------------------------------------------------------------

test('offer signal reports a pre-filled cart when the backend says so', () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const sig = offerToSignal(
    { merchant_id: 'm1', price: 19, currency: 'USD', affiliate_url: 'https://api.pivota.cc/r?token=x',
      purchase_route: 'affiliate_outbound', cart_prefilled: true },
    { productId: 'sig_1' },
  );
  assert.equal(sig.value.cart_prefilled, true);
  assert.equal(sig.value.affiliate_url, 'https://api.pivota.cc/r?token=x');
});

test('an offer that does not say so is NOT promised as a cart', () => {
  // Nothing short of an explicit backend `true` may be read as a promise of a cart.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  for (const offer of [
    { merchant_id: 'm1' },                                   // absent
    { merchant_id: 'm1', cart_prefilled: false },            // explicit false
    { merchant_id: 'm1', cart_prefilled: 'true' },           // a string is not a promise
    { merchant_id: 'm1', cart_prefilled: 1 },                // nor is a truthy number
    { merchant_id: 'm1', cart_prefilled: null },
  ]) {
    const sig = offerToSignal(offer, { productId: 'sig_1' });
    assert.notEqual(sig.value.cart_prefilled, true,
      `must not promise a cart for ${JSON.stringify(offer.cart_prefilled)}`);
  }
});

test('"nobody said" is null, NOT false — false is its own claim about where the buyer lands', () => {
  // The mirror of the test above, and the reason this field is not a boolean. An agent reading
  // `false` will tell the buyer "this link goes to a product page, you'll have to pick the
  // variant yourself". That is a POSITIVE claim, and it is fabricated whenever the backend
  // simply never said — an older backend, a non-external offer, or the ordinary state before
  // the backend half ships. Only an explicit backend `false` earns that sentence.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');

  const said = offerToSignal({ merchant_id: 'm1', cart_prefilled: false }, { productId: 'sig_1' });
  assert.equal(said.value.cart_prefilled, false, 'an explicit backend false IS a claim: keep it');

  for (const offer of [
    { merchant_id: 'm1' },                                   // older backend / non-external
    { merchant_id: 'm1', cart_prefilled: null },
    { merchant_id: 'm1', cart_prefilled: undefined },
    { merchant_id: 'm1', cart_prefilled: 'false' },          // a string is not a claim either
    { merchant_id: 'm1', cart_prefilled: 0 },
  ]) {
    const sig = offerToSignal(offer, { productId: 'sig_1' });
    assert.equal(sig.value.cart_prefilled, null,
      `absence must stay unknown, not become a PDP claim, for ${JSON.stringify(offer.cart_prefilled)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// EXECUTION SPEC v0 — the rest of the handoff contract.
//
// `cart_prefilled` answers "is there a cart". This answers "where exactly, with what in it, until
// when, and how is the click attributed". The backend composes every url in one function, so the
// gateway must PASS IT THROUGH rather than re-derive anything — but must also refuse to relay a
// value that is not the shape it claims to be, because every field here is a sentence an agent
// will say to a buyer.
// ---------------------------------------------------------------------------------------------

const FULL_SPEC = {
  merchant_domain: 'brand.com',
  pdp_url: 'https://brand.com/products/serum?utm_source=pivota&pvt_click_id=clk_abc',
  cart_url: 'https://brand.com/cart/40064041844877:1?attributes[pivota_click_id]=clk_abc',
  variant_id: '40064041844877',
  rail: 'shopify_cart',
  expires_at: '2026-09-01T00:00:00Z',
  tracking: {
    click_id: 'clk_abc',
    param: 'attributes[pivota_click_id]',
    join_mode: 'cart_permalink',
  },
};

test('the execution spec reaches the agent verbatim — the gateway re-derives nothing', () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const sig = offerToSignal(
    { merchant_id: 'm1', execution_spec: FULL_SPEC },
    { productId: 'sig_1' },
  );
  assert.deepEqual(sig.value.execution_spec, FULL_SPEC);
});

test('an offer with no spec reports null, NOT an empty spec', () => {
  // `{}` reads as "a spec exists and it is blank". `null` reads as "nobody said" — the truth for an
  // older backend or a non-external offer. Same reasoning as cart_prefilled.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  for (const offer of [
    { merchant_id: 'm1' },
    { merchant_id: 'm1', execution_spec: null },
    { merchant_id: 'm1', execution_spec: 'not an object' },
    { merchant_id: 'm1', execution_spec: 42 },
    { merchant_id: 'm1', execution_spec: [FULL_SPEC] }, // an array is not a spec
  ]) {
    const sig = offerToSignal(offer, { productId: 'sig_1' });
    assert.equal(sig.value.execution_spec, null,
      `must be null for ${JSON.stringify(offer.execution_spec)}`);
  }
});

test('a malformed field degrades alone and never costs a good one', () => {
  // A bad `expires_at` must not take `cart_url` down with it. Whole-spec rejection would make one
  // sloppy field silently remove a working handoff.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const sig = offerToSignal(
    {
      merchant_id: 'm1',
      execution_spec: { ...FULL_SPEC, expires_at: 1756684800, merchant_domain: '   ' },
    },
    { productId: 'sig_1' },
  );
  const spec = sig.value.execution_spec;
  assert.equal(spec.expires_at, null, 'a numeric timestamp is not the ISO string we promised');
  assert.equal(spec.merchant_domain, null, 'whitespace is not a domain');
  assert.equal(spec.cart_url, FULL_SPEC.cart_url, 'and the good fields are untouched');
  assert.equal(spec.variant_id, FULL_SPEC.variant_id);
});

test('a withheld pdp_url stays null rather than being back-filled', () => {
  // The backend withholds `pdp_url` when its host is not the one the domain allowlist approved.
  // Null here means "we will not vouch for a product page", never "there isn't one" — and the
  // gateway must not helpfully substitute cart_url or affiliate_url for it.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const sig = offerToSignal(
    {
      merchant_id: 'm1',
      affiliate_url: 'https://api.pivota.cc/r?token=abc.def',
      execution_spec: { ...FULL_SPEC, pdp_url: null },
    },
    { productId: 'sig_1' },
  );
  const spec = sig.value.execution_spec;
  assert.equal(spec.pdp_url, null);
  assert.equal(spec.cart_url, FULL_SPEC.cart_url, 'the cart is unaffected');
});

test('tracking is always an object, so reading tracking.click_id can never throw', () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  for (const tracking of [undefined, null, 'nope', 7, []]) {
    const sig = offerToSignal(
      { merchant_id: 'm1', execution_spec: { ...FULL_SPEC, tracking } },
      { productId: 'sig_1' },
    );
    const t = sig.value.execution_spec.tracking;
    assert.ok(t && typeof t === 'object' && !Array.isArray(t),
      `tracking must stay an object for ${JSON.stringify(tracking)}`);
    assert.equal(t.click_id, null);
    assert.equal(t.param, null);
    assert.equal(t.join_mode, null);
  }
});

test('tracking.param is relayed as sent — the carrier differs by join mode', () => {
  // A cart carries the join key as `attributes[pivota_click_id]`; a referral as a plain query
  // param. The gateway must not normalise these to one value: an agent uses `param` to FIND the
  // key in the url it was handed, and the wrong name means the key looks missing.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');

  const cart = offerToSignal(
    { merchant_id: 'm1', execution_spec: FULL_SPEC }, { productId: 'sig_1' },
  ).value.execution_spec;
  assert.equal(cart.tracking.param, 'attributes[pivota_click_id]');
  assert.ok(cart.cart_url.includes(`${cart.tracking.param}=${cart.tracking.click_id}`),
    'the named carrier must literally appear in the url it describes');

  const referral = offerToSignal(
    {
      merchant_id: 'm1',
      execution_spec: {
        ...FULL_SPEC,
        cart_url: null,
        rail: 'referral',
        tracking: { click_id: 'clk_abc', param: 'pvt_click_id', join_mode: 'referral_only' },
      },
    },
    { productId: 'sig_1' },
  ).value.execution_spec;
  assert.equal(referral.tracking.param, 'pvt_click_id');
  assert.ok(referral.pdp_url.includes(`${referral.tracking.param}=${referral.tracking.click_id}`));
});

test('an unknown rail from a newer backend is relayed, not nulled', () => {
  // `rail` is a label, not a promise about a url. Checking it against a hardcoded set would mean a
  // rail added on the backend silently disappears here — the allowlist-drops-the-new-value trap
  // this repo has paid for before. An agent can ignore a rail it does not recognise.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const sig = offerToSignal(
    { merchant_id: 'm1', execution_spec: { ...FULL_SPEC, rail: 'ucp_checkout' } },
    { productId: 'sig_1' },
  );
  assert.equal(sig.value.execution_spec.rail, 'ucp_checkout');
});
