'use strict';

// Unit tests for the agent intelligence projections (get_alternatives / get_offers).
// Pure adapters + injected handlers — no DB, no network. Run: node --test tests/agent_signals_intelligence_reads.node.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { relationshipEdgeToSignal, relationshipEdgesToSignals } = require('../src/agentSignals/relationshipEdgeToSignal');
const { offerToSignal, offersToSignals } = require('../src/agentSignals/offerToSignal');
const {
  makeGetAlternatives,
  makeGetOffers,
  mapOffersResolveResponse,
  candidateSnapshotNeedsHydration,
  hydrateCandidateSnapshotFromEntity,
} = require('../src/agentSignals/intelligenceReads');

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

test('relationshipEdgeToSignal: currency read tolerates producer key variants (price_currency)', () => {
  // The stored candidate_snapshot is a raw product spread whose currency key varies by producer.
  // Verified in prod 2026-08-25: a one-key `snapshot.currency` read served a $49 alternative with an
  // amount and no currency next to a currency-carrying anchor.
  const viaPriceCurrency = relationshipEdgeToSignal(
    sampleEdge({ candidate_snapshot: { title: 'T', brand: 'B', price: 49, price_currency: 'USD' } }),
  );
  assert.equal(viaPriceCurrency.value.related.price, 49);
  assert.equal(viaPriceCurrency.value.related.currency, 'USD');
  const viaCamel = relationshipEdgeToSignal(
    sampleEdge({ candidate_snapshot: { title: 'T', brand: 'B', price: 49, priceCurrency: 'EUR' } }),
  );
  assert.equal(viaCamel.value.related.currency, 'EUR');
  // `currency` stays the first-read key when several are present.
  const both = relationshipEdgeToSignal(
    sampleEdge({ candidate_snapshot: { title: 'T', brand: 'B', price: 49, currency: 'GBP', price_currency: 'USD' } }),
  );
  assert.equal(both.value.related.currency, 'GBP');
  // Still honest when nothing carries a currency: null, never a guess.
  const none = relationshipEdgeToSignal(
    sampleEdge({ candidate_snapshot: { title: 'T', brand: 'B', price: 49 } }),
  );
  assert.equal(none.value.related.currency, null);
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

test('candidateSnapshotNeedsHydration: title-less, or priced without any currency key', () => {
  assert.equal(candidateSnapshotNeedsHydration({ brand: 'B', price: 19.99, currency: 'USD' }), true, 'no title');
  assert.equal(candidateSnapshotNeedsHydration({ title: 'T', price: 49 }), true, 'priced, currency-less');
  assert.equal(candidateSnapshotNeedsHydration({ title: 'T', price: 49, price_currency: 'USD' }), false);
  assert.equal(candidateSnapshotNeedsHydration({ title: 'T', price: 49, currency: 'USD' }), false);
  // EVERY currency key the signal mapper reads must count as "has a currency" here, or hydration
  // overrides a producer's own currency (review F1).
  assert.equal(candidateSnapshotNeedsHydration({ title: 'T', price: 4900, priceCurrency: 'JPY' }), false);
  assert.equal(candidateSnapshotNeedsHydration({ title: 'T', brand: 'B' }), false, 'unpriced needs no currency');
});

test('hydrateCandidateSnapshotFromEntity: fills the stored amount’s missing currency from the canonical row', () => {
  const snap = { title: 'T', brand: 'B', price: 49 };
  const hydrated = hydrateCandidateSnapshotFromEntity(snap, {
    title: 'T',
    display_snapshot: { title: 'T', price: '49.00', currency: 'USD' },
  });
  assert.equal(hydrated.currency, 'USD');
  assert.equal(hydrated.price, 49, 'the STORED amount is kept — only its currency is filled');
});

test('hydrateCandidateSnapshotFromEntity: never overwrites a currency the snapshot already carries', () => {
  const kept = hydrateCandidateSnapshotFromEntity(
    { title: 'T', price: 49, price_currency: 'EUR' },
    { display_snapshot: { price: '49.00', currency: 'USD' } },
  );
  assert.equal(kept, null, 'nothing to fill — edge kept as-is');
  // The camelCase producer key counts too — the mapper reads it, so hydration must respect it (review F1).
  const keptCamel = hydrateCandidateSnapshotFromEntity(
    { title: 'T', price: 4900, priceCurrency: 'JPY' },
    { display_snapshot: { price: '4900', currency: 'USD' } },
  );
  assert.equal(keptCamel, null, 'a priceCurrency:JPY snapshot must not be re-badged USD');
});

test('hydrateCandidateSnapshotFromEntity: an amount MISMATCH refuses the pairing (different member listing)', () => {
  // A sig/group-keyed ref can resolve to the group's PRIMARY member — a different merchant's listing,
  // possibly in another currency (review F2). Only a matching amount licenses the currency pairing;
  // otherwise the price stays currency-less and the projection withholds it (honest omission).
  const mismatched = hydrateCandidateSnapshotFromEntity(
    { title: 'T', price: 4900 },
    { title: 'T', display_snapshot: { price: '49.00', currency: 'USD' } },
  );
  assert.equal(mismatched, null, 'stored 4900 vs canonical 49.00 — no currency fill');
  // A canonical row with a currency but NO price cannot prove it is the same listing either.
  assert.equal(
    hydrateCandidateSnapshotFromEntity({ title: 'T', price: 49 }, { title: 'T', display_snapshot: { currency: 'USD' } }),
    null,
  );
});

test('hydrateCandidateSnapshotFromEntity: fills title (with brand fallback) and is null on a no-op', () => {
  const titled = hydrateCandidateSnapshotFromEntity(
    { price: 19.99, currency: 'USD' },
    { title: 'Resolved Lip Gloss', brand: '786 Cosmetics' },
  );
  assert.equal(titled.title, 'Resolved Lip Gloss');
  assert.equal(titled.brand, '786 Cosmetics');
  assert.equal(hydrateCandidateSnapshotFromEntity({ title: 'T', brand: 'B' }, { title: 'X' }), null);
  assert.equal(hydrateCandidateSnapshotFromEntity({ price: 49 }, null), null, 'unresolved ref is a no-op');
  // A resolved row with no currency of its own fills nothing rather than guessing.
  assert.equal(
    hydrateCandidateSnapshotFromEntity({ title: 'T', price: 49 }, { title: 'T', display_snapshot: { price: '49.00' } }),
    null,
  );
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
  // The live-verification half. Present in the fixture so the verbatim-passthrough assertion
  // below covers the COMPLETE published shape — a deep-equal that omits half the spec would go
  // green while those fields were being silently dropped.
  expected_item_total: 19.99,
  expected_currency: 'USD',
  expected_quantity: 1,
  expected_total_expires_at: '2026-08-26T03:10:00Z',
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

// ---------------------------------------------------------------------------------------------
// LIVE VERIFICATION — what the merchant said, just now.
//
// The backend asks the merchant's own storefront before a handoff. Without these keys an agent
// gets a spec that looks IDENTICAL whether we checked it a second ago or are reciting an index
// row that is, on the audit's measurement, wrong 31.1% of the time. Three separate facts because
// they fail separately, and absence is never a claim.
// ---------------------------------------------------------------------------------------------

const VERIFIED_OFFER = {
  merchant_id: 'm1',
  price: 19.99,
  currency: 'USD',
  stock_verified: true,
  merchant_price_verified: true,
  execution_spec: {
    merchant_domain: 'brand.com',
    cart_url: 'https://brand.com/cart/40064041844877:1',
    expected_item_total: 19.99,
    expected_currency: 'USD',
    expected_quantity: 1,
    expected_total_expires_at: '2026-08-26T03:10:00Z',
  },
};

test('a verified offer carries what the merchant said, and when it stops being true', () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const v = offerToSignal(VERIFIED_OFFER, { productId: 'sig_1' }).value;

  assert.equal(v.stock_verified, true);
  assert.equal(v.merchant_price_verified, true);
  assert.equal(v.execution_spec.expected_item_total, 19.99);
  assert.equal(v.execution_spec.expected_currency, 'USD');
  assert.equal(v.execution_spec.expected_quantity, 1);
  assert.equal(v.execution_spec.expected_total_expires_at, '2026-08-26T03:10:00Z');
});

test('stock and price verify SEPARATELY — one can hold while the other does not', () => {
  // The storefront endpoint the backend reads carries an amount with NO currency code, so a
  // price is only verified once the shop's declared currency is known to match the offer's.
  // Stock is currency-free and holds regardless. Folding these into one flag is what published
  // a yen amount under a dollar label in an earlier cut.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const v = offerToSignal(
    { ...VERIFIED_OFFER, merchant_price_verified: false,
      execution_spec: { merchant_domain: 'brand.com' } },
    { productId: 'sig_1' },
  ).value;

  assert.equal(v.stock_verified, true, 'stock is currency-free and still established');
  assert.equal(v.merchant_price_verified, false);
  assert.equal(v.execution_spec.expected_item_total, null,
    'no total may be published for a price we could not verify');
});

test('an offer nobody checked reports null, NOT false', () => {
  // "We did not look" and "we looked and it failed" are different facts. An offer outside the
  // verified top-3, a non-external offer, or an older backend has no verdict at all — and
  // flattening that into `false` would make the measurement useless AND defame a fine merchant.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  for (const offer of [
    { merchant_id: 'm1' },
    { merchant_id: 'm1', stock_verified: null },
    { merchant_id: 'm1', stock_verified: 'true' },
    { merchant_id: 'm1', stock_verified: 1 },
  ]) {
    const v = offerToSignal(offer, { productId: 'sig_1' }).value;
    assert.equal(v.stock_verified, null,
      `absence must stay null for ${JSON.stringify(offer.stock_verified)}`);
    assert.equal(v.merchant_price_verified, null);
  }
});

test('an explicit false IS relayed — it is a real answer', () => {
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  const v = offerToSignal(
    { merchant_id: 'm1', stock_verified: false, merchant_price_verified: false },
    { productId: 'sig_1' },
  ).value;
  assert.equal(v.stock_verified, false);
  assert.equal(v.merchant_price_verified, false);
});

test('a total is a NUMBER — a numeric-looking string is not money', () => {
  // It would sort and compare as text wherever an agent does arithmetic on it, which is worse
  // than not having it: "9.99" < "10.00" is false as a string.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  for (const bad of ['19.99', '', {}, [], true, NaN, Infinity]) {
    const v = offerToSignal(
      { merchant_id: 'm1', execution_spec: { expected_item_total: bad } },
      { productId: 'sig_1' },
    ).value;
    assert.equal(v.execution_spec.expected_item_total, null,
      `must not publish ${JSON.stringify(bad)} as a total`);
  }
});

test('rank_one_unverified surfaces only when the backend asserts it', () => {
  // The backend sets this when the WHOLE shortlist came back unverified, so rank 1 cannot be
  // presented as confidently checked. Absent means the ordinary case, not a denial.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  assert.equal(
    offerToSignal({ merchant_id: 'm1', rank_one_unverified: true }, { productId: 's' })
      .value.rank_one_unverified,
    true,
  );
  assert.equal(
    offerToSignal({ merchant_id: 'm1' }, { productId: 's' }).value.rank_one_unverified,
    null,
  );
});

test('the verification keys survive the shared sanitizer', () => {
  // Everything an agent sees passes through it, and it has previously eaten a cart url whose
  // variant id looked like a card number. A total and a boolean must come through untouched.
  const { sanitizeResult } = require('../safety-kernel/src/protocol/resultSanitizer.js');
  const out = sanitizeResult({ offers: [VERIFIED_OFFER] }).offers[0];
  assert.equal(out.stock_verified, true);
  assert.equal(out.merchant_price_verified, true);
  assert.equal(out.execution_spec.expected_item_total, 19.99);
  assert.equal(out.execution_spec.cart_url, VERIFIED_OFFER.execution_spec.cart_url);
});

test('rank_one_unverified needs an explicit true, not a truthy value', () => {
  // It is a warning that the top result was NOT confirmed. A stray string or a 1 arriving from
  // a future backend must not be able to raise it — a false alarm here tells an agent to distrust
  // a shortlist we actually checked.
  const { offerToSignal } = require('../src/agentSignals/offerToSignal');
  for (const truthy of ['true', 1, {}, []]) {
    const v = offerToSignal(
      { merchant_id: 'm1', rank_one_unverified: truthy }, { productId: 's' },
    ).value;
    assert.equal(v.rank_one_unverified, null,
      `must not raise the warning for ${JSON.stringify(truthy)}`);
  }
});
