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
