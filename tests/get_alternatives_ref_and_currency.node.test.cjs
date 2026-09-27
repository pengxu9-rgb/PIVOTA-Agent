'use strict';

// get_alternatives: two defects measured on the live gateway 2026-09-27 (d5f649b9, again on bf6ae5adf).
//
// 1. A bare sig ref found nothing. `product_ref: "sig_2a614e7c…"` returned signals: [] / edge_count 0 while
//    `product_ref: "product:sig_2a614e7c…"` returned 10 related_product edges (Impress colorFX). The graph
//    stores anchors as `product:<id>`, and product_ref was queried verbatim — it never took the identity path
//    product_id takes. The tool's own schema advertises "sig_… / url".
// 2. A price without a currency. value.related.price was 11.99 with currency null, and price_comparison
//    carried bare amounts. In prod every serving edge's stored amounts are currency-less (4,964/4,964 priced
//    candidates; 7,667/7,667 price_evidence rows) and seed catalog rows keep price only on catalog_offers.
//
// The anchor-ref builder here is the REAL one (productRelationshipGraph.buildAnchorRefsFromProduct), and the
// edge store below matches refs the way the serving SQL does (lower(anchor_ref) = ANY(refs)), so "resolves
// to the same edges" is decided by the production ref logic, not by a stub that agrees with the handler.
// Run: node --test tests/get_alternatives_ref_and_currency.node.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  makeGetAlternatives,
  pairCurrencyFromOfferPrices,
  fillStoredAmountCurrencies,
  parseProductRefArg,
} = require('../src/agentSignals/intelligenceReads');
const { relationshipEdgesToSignals } = require('../src/agentSignals/relationshipEdgeToSignal');
const {
  buildAnchorRefsFromProduct,
  listCatalogOfferPricesForRefs,
} = require('../src/auroraBff/productRelationshipGraph');

const SIG = 'sig_2a614e7c2e000119d7d75e46d9ae9882';

// Shaped like the prod rows (relationship_candidate_labels, 2026-09-27): anchor_ref `product:sig_…`, raw
// snapshots with `price` and no currency key, price_evidence with bare amounts.
function storedEdge(over = {}) {
  return {
    anchor_ref: `product:${SIG}`,
    anchor_snapshot: { name: 'colorFX Satellite', brand: 'Impress', price: 11.99 },
    candidate_product_ref: 'product:sig_1d21e41fb004ec089f4092166ef52d1c',
    candidate_snapshot: { title: 'colorFX Levels', brand: 'Impress', price: 11.99 },
    relation_type: 'related_product',
    score_total: 0.9059,
    price_evidence: { observed_at: '2026-09-27T04:23:06.791Z', price_ratio: 1, anchor_price_amount: 11.99, candidate_price_amount: 11.99 },
    source_refs: [],
    evidence_grade: 'B',
    ...over,
  };
}

// Stores edges by anchor_ref and answers the way the serving SQL filters: lower(anchor_ref) = ANY(lower refs).
function edgeStore(edges) {
  const calls = [];
  return {
    calls,
    list: async ({ anchorRefs }) => {
      calls.push(anchorRefs.slice());
      const wanted = new Set(anchorRefs.map((r) => String(r).toLowerCase()));
      return edges.filter((e) => wanted.has(String(e.anchor_ref).toLowerCase())).map((e) => structuredClone(e));
    },
  };
}

function handlerOver(store, extra = {}) {
  return makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: store.list,
    buildAnchorRefsFromProduct,
    isEnabled: () => true,
    ...extra,
  });
}

function relatedRefs(res) {
  return res.signals.map((s) => s.value.related.ref).sort();
}

// ---- 1. product_ref identity ----------------------------------------------------------------------------

test('a bare sig product_ref resolves to the same edges as the product:-prefixed ref', async () => {
  const store = edgeStore([
    storedEdge(),
    storedEdge({ candidate_product_ref: 'product:sig_4759c3dea5bed99cec8e37bfc113d537', score_total: 0.8973 }),
    storedEdge({ anchor_ref: 'product:sig_somebody_else', candidate_product_ref: 'product:sig_unrelated' }),
  ]);
  const handler = handlerOver(store);
  const prefixed = await handler({ payload: { product_ref: `product:${SIG}`, market: 'US' } });
  const bare = await handler({ payload: { product_ref: SIG, market: 'US' } });
  assert.equal(prefixed.signals.length, 2, 'control: the prefixed ref finds both stored edges');
  assert.deepEqual(relatedRefs(bare), relatedRefs(prefixed));
  assert.equal(bare.metadata.edge_count, prefixed.metadata.edge_count);
});

test('every id form an agent is handed reaches the same edges: product_id, pivota_signature_id, pivota_canonical_url', async () => {
  const store = edgeStore([storedEdge()]);
  const handler = handlerOver(store);
  const expected = relatedRefs(await handler({ payload: { product_ref: `product:${SIG}` } }));
  assert.equal(expected.length, 1);
  const forms = [
    { product_id: SIG }, // search_catalog: product_id / id
    { product_ref: SIG }, // search_catalog: pivota_signature_id
    { product_ref: `https://agent.pivota.cc/products/${SIG}` }, // search_catalog: pivota_canonical_url / url
    { product_ref: `https://agent.pivota.cc/products/${SIG}?utm_source=x#top` },
    { product_ref: `PRODUCT:${SIG.toUpperCase()}` },
    { product_ref: `  ${SIG}  ` },
    { merchant_id: 'merch_obs_9a86b1613336cfec', product_id: SIG, product_ref: SIG },
  ];
  for (const payload of forms) {
    const res = await handler({ payload });
    assert.deepEqual(relatedRefs(res), expected, `form ${JSON.stringify(payload)}`);
  }
});

test('a bare product_ref goes through identity hydration, like product_id — so grouped sibling edges match', async () => {
  // The anchor's edges live on a sibling listing's key; only identity hydration knows the sibling.
  const store = edgeStore([storedEdge({ anchor_ref: 'product:ext_sibling_listing' })]);
  const hydrated = [];
  const handler = handlerOver(store, {
    hydrateAnchorProduct: async (anchor) => {
      hydrated.push(anchor);
      return { ...anchor, member_source_ids: ['ext_sibling_listing'] };
    },
  });
  const res = await handler({ payload: { product_ref: SIG, merchant_id: 'm1' } });
  assert.deepEqual(hydrated, [{ product_id: SIG, merchant_id: 'm1' }]);
  assert.equal(res.signals.length, 1);
});

test('product_ref parsing: only product:/url:/text: are graph namespaces; a colon inside an id is part of the id', () => {
  assert.deepEqual(parseProductRefArg(SIG), { productId: SIG, refs: [] });
  assert.deepEqual(parseProductRefArg(`product:${SIG}`), { productId: SIG, refs: [`product:${SIG}`] });
  // search_catalog hands out product_id "retailer:1029…" and edges carry "ulta:…" refs: ids, not namespaces.
  assert.deepEqual(parseProductRefArg('retailer:1029d2577337253f35d8f06956351bf4'), {
    productId: 'retailer:1029d2577337253f35d8f06956351bf4',
    refs: [],
  });
  assert.deepEqual(parseProductRefArg('text:impress:colorfx levels'), { productId: null, refs: ['text:impress:colorfx levels'] });
  assert.deepEqual(parseProductRefArg('url:https://shop.example/p/1'), { productId: null, refs: ['url:https://shop.example/p/1'] });
  // A merchant URL is a url: anchor — never mistaken for a Pivota product page.
  assert.deepEqual(parseProductRefArg('https://www.kissusa.com/products/impress-levels'), {
    productId: null,
    refs: ['url:https://www.kissusa.com/products/impress-levels'],
  });
  assert.deepEqual(parseProductRefArg('https://evil.example/pivota.cc/products/sig_x'), {
    productId: null,
    refs: ['url:https://evil.example/pivota.cc/products/sig_x'],
  });
  assert.deepEqual(parseProductRefArg(`https://agent.pivota.cc/products/${SIG}`), { productId: SIG, refs: [] });
  assert.deepEqual(parseProductRefArg('   '), { productId: null, refs: [] });
});

test('a retailer:-style id as product_ref is queried under product:<id> and bare, like product_id', async () => {
  const store = edgeStore([storedEdge({ anchor_ref: 'product:retailer:abc' })]);
  const res = await handlerOver(store)({ payload: { product_ref: 'retailer:abc' } });
  assert.equal(res.signals.length, 1);
  assert.ok(store.calls[0].includes('product:retailer:abc'));
  assert.ok(!store.calls[0].includes('product:abc'), 'the retailer: prefix is never stripped');
});

// ---- 2. currency --------------------------------------------------------------------------------------------

// Offers keyed by lowercased input ref, as listCatalogOfferPricesForRefs returns them.
function offerBook(entries) {
  const calls = [];
  const map = new Map(Object.entries(entries));
  return {
    calls,
    resolve: async (refs) => {
      calls.push(refs.slice());
      return new Map(refs.filter((r) => map.has(r)).map((r) => [r, map.get(r)]));
    },
  };
}

const USD_1199 = [{ currency: 'USD', amounts: [11.99, 11.99, 11.99] }];

function assertEveryPriceCarriesACurrency(res) {
  for (const s of res.signals) {
    const rel = s.value.related;
    if (rel.price != null) assert.match(String(rel.currency), /^[A-Z]{3}$/, `related price ${rel.price} has no currency`);
    else assert.equal(rel.currency, null, 'no price → no stray currency');
    const pc = s.value.price_comparison;
    if (pc && (pc.anchor_price_amount != null || pc.candidate_price_amount != null)) {
      assert.match(String(pc.currency), /^[A-Z]{3}$/, 'price_comparison amounts without a currency');
      assert.ok(pc.anchor_price_amount != null && pc.candidate_price_amount != null, 'amounts travel as a pair');
    }
  }
}

test('the live case: a stored 11.99 is served as 11.99 USD, and the comparison names its currency', async () => {
  const book = offerBook({
    'product:sig_1d21e41fb004ec089f4092166ef52d1c': USD_1199,
    [`product:${SIG}`]: USD_1199,
  });
  const handler = handlerOver(edgeStore([storedEdge()]), {
    resolveOfferPrices: book.resolve,
    servingCurrencyForMarket: () => 'USD',
  });
  const res = await handler({ payload: { product_ref: SIG, market: 'US' } });
  const { related, price_comparison: pc } = res.signals[0].value;
  assert.equal(related.price, 11.99);
  assert.equal(related.currency, 'USD');
  assert.deepEqual(pc, {
    price_ratio: 1,
    anchor_price_amount: 11.99,
    candidate_price_amount: 11.99,
    currency: 'USD',
    observed_at: '2026-09-27T04:23:06.791Z',
  });
  assert.deepEqual(res.metadata.price_currency_fill, { needed: 2, filled: 2 });
  assert.equal(res.metadata.serving_currency, 'USD');
  assertEveryPriceCarriesACurrency(res);
});

test('unknown currency → the price is omitted, never shown bare', async () => {
  // No offers for either side (the 182 candidate listings with no offer rows in prod).
  const handler = handlerOver(edgeStore([storedEdge()]), {
    resolveOfferPrices: offerBook({}).resolve,
    servingCurrencyForMarket: () => 'USD',
  });
  const res = await handler({ payload: { product_ref: SIG } });
  const { related, price_comparison: pc } = res.signals[0].value;
  assert.equal(related.price, null);
  assert.equal(related.currency, null);
  assert.equal(pc.anchor_price_amount, undefined);
  assert.equal(pc.candidate_price_amount, undefined);
  assert.equal(pc.currency, undefined);
  assert.equal(pc.price_ratio, 1, 'the unitless ratio still serves');
  assert.equal(res.signals.length, 1, 'the alternative itself is still served');
  assertEveryPriceCarriesACurrency(res);
});

test('a currency is paired only on an amount match, and only when the matching offers agree on ONE', () => {
  assert.equal(pairCurrencyFromOfferPrices(11.99, USD_1199), 'USD');
  assert.equal(pairCurrencyFromOfferPrices('11.99', [{ currency: 'usd', amounts: ['11.990'] }]), 'USD');
  // A different listing's price: the offer does not prove the stored amount's currency.
  assert.equal(pairCurrencyFromOfferPrices(11.99, [{ currency: 'USD', amounts: [14.5] }]), null);
  // The same number in two currencies (a group spanning a US and a SG store): no single answer.
  assert.equal(pairCurrencyFromOfferPrices(20, [{ currency: 'USD', amounts: [20] }, { currency: 'SGD', amounts: [20] }]), null);
  // A non-matching offer in another currency does not veto a matching one.
  assert.equal(pairCurrencyFromOfferPrices(20, [{ currency: 'USD', amounts: [20] }, { currency: 'SGD', amounts: [27] }]), 'USD');
  assert.equal(pairCurrencyFromOfferPrices(20, [{ currency: '$', amounts: [20] }]), null, "'$' names no currency");
  assert.equal(pairCurrencyFromOfferPrices(0, [{ currency: 'USD', amounts: [0] }]), null, '0 is the not-buyable sentinel');
  assert.equal(pairCurrencyFromOfferPrices(null, USD_1199), null);
  assert.equal(pairCurrencyFromOfferPrices(11.99, undefined), null);
});

test('a price in another currency than the market serves is omitted (a JPY listing on a US answer)', async () => {
  const book = offerBook({
    'product:sig_1d21e41fb004ec089f4092166ef52d1c': [{ currency: 'JPY', amounts: [1650] }],
    [`product:${SIG}`]: USD_1199,
  });
  const handler = handlerOver(
    edgeStore([storedEdge({ candidate_snapshot: { title: 'T', brand: 'B', price: 1650 }, price_evidence: { price_ratio: 137.6, anchor_price_amount: 11.99, candidate_price_amount: 1650 } })]),
    { resolveOfferPrices: book.resolve, servingCurrencyForMarket: () => 'USD' },
  );
  const res = await handler({ payload: { product_ref: SIG, market: 'US' } });
  const { related, price_comparison: pc } = res.signals[0].value;
  assert.equal(related.price, null);
  assert.equal(related.currency, null);
  assert.equal(pc.price_ratio, undefined, 'a JPY/USD ratio compares nothing');
  assert.equal(pc.candidate_price_amount, undefined);
  assertEveryPriceCarriesACurrency(res);
});

test('a market with no currency (servingCurrency null) serves no price at all', async () => {
  const book = offerBook({ 'product:sig_1d21e41fb004ec089f4092166ef52d1c': USD_1199, [`product:${SIG}`]: USD_1199 });
  const handler = handlerOver(edgeStore([storedEdge()]), {
    resolveOfferPrices: book.resolve,
    servingCurrencyForMarket: () => null,
  });
  const res = await handler({ payload: { product_ref: SIG, market: 'US' } });
  assert.equal(res.signals[0].value.related.price, null);
  assert.equal(res.signals[0].value.price_comparison.currency, undefined);
  assertEveryPriceCarriesACurrency(res);
});

test('a snapshot that already carries its currency is never re-badged by the offers', async () => {
  const edge = storedEdge({ candidate_snapshot: { title: 'T', brand: 'B', price: 11.99, price_currency: 'USD' } });
  const book = offerBook({ 'product:sig_1d21e41fb004ec089f4092166ef52d1c': [{ currency: 'EUR', amounts: [11.99] }] });
  const edges = [edge];
  await fillStoredAmountCurrencies(edges, book.resolve);
  assert.equal(edges[0].candidate_snapshot.price_currency, 'USD');
  assert.equal(edges[0].candidate_snapshot.currency, undefined);
  assert.ok(!book.calls.flat().includes('product:sig_1d21e41fb004ec089f4092166ef52d1c'), 'not even looked up');
});

test('the anchor amount pairs with the ANCHOR listing, never the candidate', async () => {
  // Anchor offers are in SGD at the anchor amount; candidate in USD. The comparison has no shared currency.
  const book = offerBook({
    'product:sig_1d21e41fb004ec089f4092166ef52d1c': USD_1199,
    [`product:${SIG}`]: [{ currency: 'SGD', amounts: [11.99] }],
  });
  const res = await handlerOver(edgeStore([storedEdge()]), { resolveOfferPrices: book.resolve })({ payload: { product_ref: SIG } });
  const { related, price_comparison: pc } = res.signals[0].value;
  assert.equal(related.currency, 'USD', 'no market check without servingCurrencyForMarket');
  assert.equal(pc.currency, undefined);
  assert.equal(pc.anchor_price_amount, undefined);
  assert.equal(pc.price_ratio, undefined, 'SGD vs USD: no ratio');
  assertEveryPriceCarriesACurrency(res);
});

test('an offer lookup failure is fail-open: alternatives still served, prices withheld', async () => {
  const handler = handlerOver(edgeStore([storedEdge()]), {
    resolveOfferPrices: async () => { throw new Error('pool exhausted'); },
    servingCurrencyForMarket: () => 'USD',
  });
  const res = await handler({ payload: { product_ref: SIG } });
  assert.equal(res.signals.length, 1);
  assert.equal(res.signals[0].value.related.price, null);
  assert.deepEqual(res.metadata.price_currency_fill, { error: true });
  assertEveryPriceCarriesACurrency(res);
});

test('the mapper alone never emits a bare amount, whatever the stored edge holds', () => {
  const edges = [
    storedEdge(),
    storedEdge({ candidate_snapshot: { price: '19.00', currency: 'usd' }, candidate_product_ref: 'a' }),
    storedEdge({ candidate_snapshot: { price: 19, currency: '$' }, candidate_product_ref: 'b' }),
    storedEdge({ candidate_snapshot: { price: 19, priceCurrency: 'EUR' }, anchor_snapshot: { price: 11.99, currency: 'EUR' }, candidate_product_ref: 'c' }),
    storedEdge({ price_evidence: { anchor_price_amount: 5, candidate_price_amount: 4 }, candidate_product_ref: 'd' }),
    storedEdge({ price_evidence: null, candidate_product_ref: 'e' }),
  ];
  for (const servingCurrency of [undefined, 'USD', 'EUR', null]) {
    assertEveryPriceCarriesACurrency({ signals: relationshipEdgesToSignals(edges, { servingCurrency }) });
  }
  const byRef = Object.fromEntries(relationshipEdgesToSignals(edges, {}).map((s) => [s.value.related.ref, s.value]));
  assert.equal(byRef.a.related.currency, 'USD', 'a lower-case ISO code is normalised, not refused');
  assert.equal(byRef.a.related.price, 19);
  assert.equal(byRef.b.related.price, null, "'$' is not a currency");
  assert.equal(byRef.c.price_comparison.currency, 'EUR');
  assert.equal(byRef.e.price_comparison, null);
});

// ---- the offer reader --------------------------------------------------------------------------------------

test('listCatalogOfferPricesForRefs: lowercases + dedupes refs, groups rows per ref, drops currency-less rows', async () => {
  let sent;
  const queryFn = async (sql, params) => {
    sent = { sql, params };
    return {
      rows: [
        { input_ref: 'product:sig_a', currency: 'usd', list_price: '11.99', merchant_effective_price: '11.99', estimated_best_price: null },
        { input_ref: 'product:sig_a', currency: 'USD', list_price: '12.50', merchant_effective_price: null, estimated_best_price: null },
        { input_ref: 'product:sig_b', currency: '', list_price: '9', merchant_effective_price: null, estimated_best_price: null },
      ],
    };
  };
  const out = await listCatalogOfferPricesForRefs(['PRODUCT:SIG_A', 'product:sig_a', '', null, 'product:sig_b'], { queryFn });
  assert.deepEqual(sent.params, [['product:sig_a', 'product:sig_b']]);
  assert.match(sent.sql, /o\.suppressed_at IS NULL/, 'a suppressed offer never names a currency');
  assert.match(sent.sql, /regexp_replace\(raw, '\^product:', ''\)/, 'only product: is stripped');
  assert.deepEqual(out.get('product:sig_a'), [
    { currency: 'USD', amounts: [11.99, 11.99] },
    { currency: 'USD', amounts: [12.5] },
  ]);
  assert.equal(out.has('product:sig_b'), false);
});

test('listCatalogOfferPricesForRefs: no refs → no query; a missing table → empty; other errors throw', async () => {
  let called = false;
  assert.equal((await listCatalogOfferPricesForRefs([], { queryFn: async () => { called = true; } })).size, 0);
  assert.equal(called, false);
  const missing = Object.assign(new Error('relation "catalog_offers" does not exist'), { code: '42P01' });
  assert.equal((await listCatalogOfferPricesForRefs(['product:x'], { queryFn: async () => { throw missing; } })).size, 0);
  await assert.rejects(
    listCatalogOfferPricesForRefs(['product:x'], { queryFn: async () => { throw new Error('boom'); } }),
    /boom/,
  );
});
