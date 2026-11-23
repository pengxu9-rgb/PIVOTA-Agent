'use strict';

// get_alternatives SERVES STORED PRICES ONLY, and the door caches rely on it.
//
// The door caches' price-freshness cap (DOOR_CACHE_PRICE_FRESHNESS_CAP; src/observability/priceVerificationFacts.js)
// ends a cache entry when the merchant answer it holds is 10 minutes old. It looks for merchant answers in
// search_catalog and get_product answers only. The public tier also caches get_alternatives (10 min fresh, 60 min
// stale), and the cap leaves those entries on their own clocks. That is right only while an alternative's price is
// Pivota's stored copy (the relationship-graph edge's candidate_snapshot.price) and never something a merchant
// answered for this request or from a price cache.
//
// This file pins that, through the real producer (makeGetAlternatives + relationshipEdgeToSignal):
//   1. no row is a merchant answer, flags off or on, even when the stored edge itself carries merchant-looking
//      fields (a graph build that one day copies them from its source row);
//   2. the request reads nothing from outside the process;
//   3. the cap's own reader finds no merchant answer in a get_alternatives answer.
// IF YOU ARE HERE BECAUSE YOU ADDED A LIVE OR CACHED MERCHANT PRICE TO get_alternatives: first teach the door cap
// to read it (mcp-server/src/publicReadToolSurface.js publicEarliestMerchantAnswerMs, and pricedItemsOf in
// priceVerificationFacts.js), or the public tier will replay that merchant answer for up to an hour. Then change
// this file.
// Every product, brand and ref below is a placeholder. Nothing leaves the process.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');

const FLAGS = ['LIST_ROW_PRICE_AS_OF', 'PRICE_STALENESS_DEMOTE', 'DOOR_CACHE_PRICE_FRESHNESS_CAP', 'PRICE_CACHE_STORE', 'PRICE_CACHE_MODE'];
for (const k of FLAGS) delete process.env[k];

const { makeGetAlternatives } = require('../src/agentSignals/intelligenceReads');
const { buildAnchorRefsFromProduct } = require('../src/auroraBff/productRelationshipGraph');
const facts = require('../src/observability/priceVerificationFacts');

const ANCHOR = 'sig_00000000000000000000000000000a01';
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

function edge(n, snapshot, over = {}) {
  return {
    anchor_ref: `product:${ANCHOR}`,
    anchor_snapshot: { name: 'Placeholder Anchor', brand: 'Brand A', price: 20, currency: 'USD' },
    candidate_product_ref: `product:sig_00000000000000000000000000000b0${n}`,
    candidate_snapshot: { title: `Placeholder Alternative ${n}`, brand: 'Brand B', ...snapshot },
    relation_type: 'related_product',
    score_total: 0.9 - n / 100,
    price_evidence: { observed_at: iso(NOW - DAY), price_ratio: 1, anchor_price_amount: 20, candidate_price_amount: 20 },
    source_refs: [],
    evidence_grade: 'B',
    ...over,
  };
}

// 1: an ordinary stored price, read two days ago. 2: a stored price whose edge ALSO carries what a merchant answer
// carries (the hostile case). 3: priced a minute ago by the graph build. 4: no price.
const EDGES = [
  edge(1, { price: 20, currency: 'USD', price_checked_at: iso(NOW - 2 * DAY) }),
  edge(2, {
    price: 18, currency: 'USD', price_as_of: iso(NOW), price_checked_at: iso(NOW),
    price_source: 'merchant_live', merchant_price_verified: true,
    live_read: { status: 'verified', checked_at: iso(NOW) }, freshness: { observed_at: iso(NOW) },
  }, { price_source: 'merchant_cache', merchant_price_verified: true, last_verified_at: iso(NOW) }),
  edge(3, { price: 22, currency: 'USD', price_checked_at: iso(NOW - MIN) }),
  edge(4, {}),
];

/** Counts every way this process could reach a store, while `fn` runs. */
async function countingOutbound(fn) {
  const calls = [];
  const saved = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
  const trap = (name) => (...args) => {
    calls.push(name);
    throw new Error(`get_alternatives reached outside the process (${name}: ${String(args[0] && (args[0].href || args[0].hostname || args[0]))})`);
  };
  globalThis.fetch = trap('fetch');
  http.request = trap('http.request');
  http.get = trap('http.get');
  https.request = trap('https.request');
  https.get = trap('https.get');
  try {
    // The trap is live: a call through it is counted (so "zero calls" below is not an empty claim).
    assert.throws(() => globalThis.fetch('https://trap-self-check.example.com/'), /reached outside the process/);
    assert.deepEqual(calls.splice(0), ['fetch']);
    return { out: await fn(), calls };
  } finally {
    globalThis.fetch = saved.fetch;
    http.request = saved.httpRequest;
    http.get = saved.httpGet;
    https.request = saved.httpsRequest;
    https.get = saved.httpsGet;
  }
}

async function withFlags(env, fn) {
  for (const k of FLAGS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of FLAGS) delete process.env[k];
  }
}

function realHandler() {
  const listCalls = [];
  const handler = makeGetAlternatives({
    listApprovedRelationshipEdgesForAnchor: async (args) => {
      listCalls.push(args);
      return EDGES.map((e) => structuredClone(e));
    },
    buildAnchorRefsFromProduct,
    isEnabled: () => true,
  });
  return { handler, listCalls };
}

const MERCHANT_KEYS = ['price_source', 'merchant_price_verified', 'live_read', 'price_as_of', 'price_checked_at', 'freshness'];
const relatedOf = (answer) => answer.signals.map((s) => s.value.related);

test('CONTROL: the detector this file relies on does see a merchant answer when a row is one', () => {
  for (const row of [
    { price: 18, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) },
    { price: 18, currency: 'USD', price_source: 'merchant_cache', price_as_of: iso(NOW) },
    { price: 18, currency: 'USD', price_source: 'live', price_as_of: iso(NOW) },
    { price: 18, currency: 'USD', price_source: 'cache', price_as_of: iso(NOW) },
    { price: 18, currency: 'USD', merchant_price_verified: true },
  ]) assert.equal(facts.priceFactOf(row).merchant, true, JSON.stringify(row));
  assert.equal(facts.priceFactOf({ price: 18, currency: 'USD', price_source: 'stored' }).merchant, false);
  assert.equal(facts.earliestMerchantAnswerMsOfItems([{ price: 18, currency: 'USD', price_source: 'merchant_live', price_as_of: iso(NOW) }]), Date.parse(iso(NOW)));
});

test('flags off: every alternative is a stored price; no row carries a merchant source, verdict or read time; nothing is read from outside', async () => {
  const { handler, listCalls } = realHandler();
  const { out, calls } = await withFlags({}, () => countingOutbound(() => handler({ payload: { product_id: ANCHOR, market: 'US' } })));
  assert.deepEqual(calls, [], 'no fetch and no http(s) request: the answer comes from the stored graph edges alone');
  assert.equal(listCalls.length, 1, 'one read of the stored edges');
  const rows = relatedOf(out);
  assert.equal(rows.length, 4, 'all four stored edges are served');
  // The rows ARE priced (so "not a merchant answer" below is a statement about real prices, not about empty rows).
  assert.deepEqual(rows.map((r) => [r.price, r.currency]), [[20, 'USD'], [18, 'USD'], [22, 'USD'], [null, null]]);
  for (const [i, row] of rows.entries()) {
    assert.deepEqual(Object.keys(row).sort(), ['brand', 'currency', 'image_url', 'price', 'ref', 'title'], `row ${i}: the stored snapshot's own fields only`);
    for (const k of MERCHANT_KEYS) assert.equal(k in row, false, `row ${i} carries no ${k}`);
    assert.equal(facts.priceFactOf(row).merchant, false, `row ${i} is not a merchant answer`);
    // Nor is the signal that wraps it, by any field the price facts read.
    assert.equal(facts.priceFactOf(out.signals[i]).merchant, false);
    assert.equal(facts.priceFactOf(out.signals[i].value).merchant, false);
  }
});

test('LIST_ROW_PRICE_AS_OF=on: every priced alternative is labelled `stored`, never `live` or `cache`, however recent its stored read', async () => {
  const { handler } = realHandler();
  const { out, calls } = await withFlags({ LIST_ROW_PRICE_AS_OF: 'on' }, () => countingOutbound(() => handler({ payload: { product_id: ANCHOR, market: 'US' } })));
  assert.deepEqual(calls, []);
  const rows = relatedOf(out);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.price_source), ['stored', 'stored', 'stored', 'stored']);
  // The label dates the stored read; a read a minute old is still the stored copy, not a merchant answer.
  assert.equal(rows[2].price_as_of, iso(NOW - MIN));
  for (const [i, row] of rows.entries()) {
    assert.equal(facts.priceFactOf(row).merchant, false, `row ${i} is not a merchant answer`);
    assert.equal('merchant_price_verified' in row, false);
    assert.equal('live_read' in row, false);
  }
  // With the staleness rule on as well, the same holds.
  const both = await withFlags({ LIST_ROW_PRICE_AS_OF: 'on', PRICE_STALENESS_DEMOTE: 'on' }, () => handler({ payload: { product_id: ANCHOR, market: 'US' } }));
  assert.deepEqual(relatedOf(both).map((r) => r.price_source).sort(), ['stored', 'stored', 'stored', 'stored']);
  for (const row of relatedOf(both)) assert.equal(facts.priceFactOf(row).merchant, false);
});

test('the door cap finds no merchant answer in a get_alternatives answer, cap on or off, with the shared price cache in read mode too', async () => {
  for (const env of [
    {},
    { DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on' },
    { DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on', LIST_ROW_PRICE_AS_OF: 'on' },
    // No project is named, so no store is built; the flags alone must not make this path read a price cache.
    { DOOR_CACHE_PRICE_FRESHNESS_CAP: 'on', LIST_ROW_PRICE_AS_OF: 'on', PRICE_CACHE_STORE: 'firestore', PRICE_CACHE_MODE: 'read' },
  ]) {
    const label = JSON.stringify(env);
    const { handler } = realHandler();
    const { out, calls } = await withFlags(env, () => countingOutbound(() => handler({ payload: { product_id: ANCHOR, market: 'US' } })));
    assert.deepEqual(calls, [], label);
    const rows = relatedOf(out);
    assert.equal(rows.filter((r) => r.price != null).length, 3, `${label}: three priced rows`);
    // Whatever shape a reader takes the rows in, none dates a merchant answer.
    assert.equal(facts.earliestMerchantAnswerMsOfItems(rows), null, label);
    assert.equal(facts.earliestMerchantAnswerMsOfItems(out.signals), null, label);
    assert.equal(facts.earliestMerchantAnswerMsOfItems(out.signals.map((s) => s.value)), null, label);
    // And the cap's own per-tool reader has nothing for this tool: its entries keep their own clocks.
    assert.equal(facts.earliestMerchantAnswerMs('get_alternatives', out), null, label);
    assert.deepEqual(facts.pricedItemsOf('get_alternatives', out), [], label);
  }
});
