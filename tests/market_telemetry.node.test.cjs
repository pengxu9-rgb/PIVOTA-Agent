'use strict';

// Unit tests for src/services/marketTelemetry.js. The module reports what the door BOUND, as
// the door observed it; it must never re-derive the market, and never invent a value.

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const test = require('node:test');

const mt = require('../src/services/marketTelemetry');

test('the door precedence and truthiness, on the door values -- no trimming, no stringifying first', () => {
  // Review of #2239: trimming and stringifying BEFORE the || made the telemetry disagree with
  // the bind on exactly these inputs.
  assert.deepEqual(mt.describeRequested({ market: 'SG' }, { market: 'US' }), { requested: 'SG', source: 'explicit_search' });
  assert.deepEqual(mt.describeRequested({}, { market: 'SG' }), { requested: 'SG', source: 'explicit_metadata' });
  assert.deepEqual(mt.describeRequested({}, {}), { requested: null, source: 'defaulted' });
  // Whitespace is TRUTHY for the door: it wins over metadata, as it does at the bind.
  assert.deepEqual(mt.describeRequested({ market: '   ' }, { market: 'SG' }), { requested: '   ', source: 'explicit_search' });
  // false and 0 are FALSY for the door: metadata wins, as it does at the bind.
  assert.deepEqual(mt.describeRequested({ market: false }, { market: 'SG' }), { requested: 'SG', source: 'explicit_metadata' });
  assert.deepEqual(mt.describeRequested({ market: 0 }, { market: 'SG' }), { requested: 'SG', source: 'explicit_metadata' });
  assert.deepEqual(mt.describeRequested(null, null), { requested: null, source: 'defaulted' });
});

test('market_requested is capped: free text cannot bloat every line or become an unbounded label', () => {
  const long = 'X'.repeat(500);
  const { requested } = mt.describeRequested({ market: long }, {});
  assert.equal(requested.length, mt.MAX_REQUESTED_CHARS + 1, 'cap plus the ellipsis');
  assert.ok(requested.startsWith('X'.repeat(mt.MAX_REQUESTED_CHARS)));
  assert.equal(mt.describeRequested({ market: 'SG' }, {}).requested, 'SG', 'a real code is untouched');
});

test('observeBoundMarket records exactly what the door hands it, and never throws', () => {
  const store = {};
  mt.observeBoundMarket(store, { search: { market: 'SG' }, metadata: {}, markets: ['SG'] });
  assert.deepEqual(store, { market_observed: true, market_requested: 'SG', market_source: 'explicit_search', market_bound: ['SG'], market_buyer_currency: null });
  // A copy, so a later mutation of the door's array cannot rewrite history.
  const markets = ['US'];
  const store2 = {};
  mt.observeBoundMarket(store2, { search: {}, metadata: {}, markets });
  markets.push('SG');
  assert.deepEqual(store2.market_bound, ['US']);
  // Outside a request there is no store: a no-op, not a throw.
  assert.doesNotThrow(() => mt.observeBoundMarket(null, { markets: ['US'] }));
  assert.doesNotThrow(() => mt.observeBoundMarket(undefined, {}));
});

test('Stage 0a: the buyer currency the door scoped by is recorded beside what it bound, and reaches the record', () => {
  const store = {};
  mt.observeBoundMarket(store, { search: { market: 'SG' }, metadata: {}, markets: ['US', 'SG'], buyerCurrency: 'SGD' });
  assert.equal(store.market_buyer_currency, 'SGD');
  assert.deepEqual(store.market_bound, ['US', 'SG']);
  const record = mt.buildMarketTelemetry({ operation: 'find_products_multi', observation: store, body: { products: [] }, stages: [] });
  assert.equal(record.market_buyer_currency, 'SGD');
  // Absent (flag off, or a market it could not price) is null, never a guessed currency.
  const off = {};
  mt.observeBoundMarket(off, { search: { market: 'SG' }, metadata: {}, markets: ['SG'] });
  assert.equal(off.market_buyer_currency, null);
});

test('an unbound request reads a FLAT payload the way the early lane does, and claims no binding', () => {
  // Review of #2239 case B/C: `{query, market}` with no `search` object was counted as
  // `defaulted`. The early lane reads the payload itself when `search` is not a plain object.
  assert.deepEqual(mt.describeUnboundRequest({ query: 'x', market: 'SG' }, {}),
    { market_observed: false, market_requested: 'SG', market_source: 'explicit_search', market_bound: null, market_buyer_currency: null });
  assert.deepEqual(mt.describeUnboundRequest({ search: { market: 'SG' } }, {}).market_requested, 'SG');
  // A non-object `search` falls back to the payload, as the lane does.
  assert.equal(mt.describeUnboundRequest({ search: 'oops', market: 'JP' }, {}).market_requested, 'JP');
  assert.equal(mt.describeUnboundRequest({ search: ['a'], market: 'JP' }, {}).market_requested, 'JP');
  assert.deepEqual(mt.describeUnboundRequest(null, { market: 'SG' }).market_source, 'explicit_metadata');
  // It never claims a bind it did not see.
  assert.equal(mt.describeUnboundRequest({ market: 'SG' }, {}).market_bound, null);
});

test('an observation, when present, WINS over anything re-readable from the request', () => {
  // The point of the rewrite: the bind is the truth. Here the payload says SG, but the door
  // observed (and bound) US -- the record must say US.
  const record = mt.buildMarketTelemetry({
    operation: 'find_products_multi',
    observation: { market_observed: true, market_requested: '   ', market_source: 'explicit_search', market_bound: ['US'] },
    payload: { search: { market: 'SG' } },
    metadata: {},
    body: { products: [] },
    stages: [],
  });
  assert.equal(record.market_observed, true);
  assert.deepEqual(record.market_bound, ['US']);
  assert.equal(record.market_requested, '   ');
});

test('served_currency_mismatch counts MIXED; an unpriced row is not a mix; case is normalised', () => {
  const sgd = { currency: 'SGD' };
  const usd = { currency: 'USD' };
  const none = { title: 'no currency at all' };
  assert.equal(mt.summariseServedProducts([sgd, usd]).served_currency_mismatch, true);
  assert.equal(mt.summariseServedProducts([sgd, sgd]).served_currency_mismatch, false);
  assert.equal(mt.summariseServedProducts([sgd, none]).served_currency_mismatch, false);
  assert.equal(mt.summariseServedProducts([]).served_currency_mismatch, false);
  assert.deepEqual(mt.summariseServedProducts([none]).served_currencies, ['unknown']);
  // Review of #2239 R14: case normalisation was unpinned. 'sgd' and 'SGD' are one currency --
  // counting them as two would report a mixed page that is not.
  assert.deepEqual(mt.summariseServedProducts([{ currency: 'sgd' }, { currency: 'SGD' }]).served_currencies, ['SGD']);
  assert.equal(mt.summariseServedProducts([{ currency: 'sgd' }, { currency: 'SGD' }]).served_currency_mismatch, false);
  assert.deepEqual(mt.summariseServedProducts([{ price_currency: ' usd ' }]).served_currencies, ['USD']);
});

test('served_price_sources counts rows by recall source', () => {
  const rows = [
    { currency: 'USD', source: 'canonical_chain' },
    { currency: 'USD', search_recall_source: 'canonical_chain' },
    { currency: 'SGD', catalog_source: 'external_seed' },
    { currency: 'SGD' },
  ];
  assert.deepEqual(mt.summariseServedProducts(rows).served_price_sources, { canonical_chain: 2, external_seed: 1, unknown: 1 });
});

test('the products are read from body.products -- the page actually sent', () => {
  // Review of #2239 R12: reading products from the wrong key survived every test, because the
  // integration environment serves an empty page either way. The read now lives here.
  const body = { products: [{ currency: 'SGD' }, { currency: 'USD' }], items: [{ currency: 'JPY' }] };
  const record = mt.buildMarketTelemetry({ operation: 'find_products_multi', body, observation: {} });
  assert.deepEqual(record.served_currencies, ['SGD', 'USD']);
  assert.equal(record.served_currency_mismatch, true);
  // A body with no products array is an empty page, not an error.
  assert.deepEqual(mt.buildMarketTelemetry({ operation: 'find_products_multi', body: { error: 'x' } }).served_currencies, []);
  assert.deepEqual(mt.buildMarketTelemetry({ operation: 'find_products_multi', body: ['not', 'an', 'object'] }).served_currencies, []);
});

test('lane is the LAST lane recorded', () => {
  assert.equal(mt.laneFromStageBreakdown([{ stage: 'route_entry' }, { stage: 'recall', lane: 'early_indexed' }]), 'early_indexed');
  assert.equal(mt.laneFromStageBreakdown([{ lane: 'early_indexed' }, { lane: 'mainline_direct' }]), 'mainline_direct');
  assert.equal(mt.laneFromStageBreakdown([{ stage: 'route_entry' }]), null);
  assert.equal(mt.laneFromStageBreakdown([]), null);
});

test('query_source and primary_path_used are read from the page sent, for lanes that set no stage', () => {
  // Measured 2026-09-26: the discovery bridge and ingredient-direct lanes record no fpm stage and
  // no lane, so 31% of 30 days of traffic could not be attributed to the lane that served it.
  const body = {
    products: [],
    metadata: { query_source: 'beauty_discovery_mainline', route_health: { primary_path_used: 'local_discovery_bridge' } },
  };
  const record = mt.buildMarketTelemetry({ operation: 'find_products_multi', body, stages: [{ stage: 'route_entry' }] });
  assert.equal(record.query_source, 'beauty_discovery_mainline');
  assert.equal(record.primary_path_used, 'local_discovery_bridge');
  assert.equal('lane' in record, false);
});

test('served-by fields are absent, never empty, when the page does not say; and capped', () => {
  for (const body of [null, {}, { metadata: null }, { metadata: [] }, { metadata: { query_source: '  ' } },
    { metadata: { query_source: 7, route_health: 'x' } }]) {
    const served = mt.servedByFromBody(body);
    assert.deepEqual(served, {}, JSON.stringify(body));
  }
  const long = mt.servedByFromBody({ metadata: { query_source: 'q'.repeat(500) } });
  assert.equal(long.query_source.length, 65);
});

test('the record is emitted for find_products_multi ONLY, and its keys are all new', () => {
  assert.deepEqual(mt.buildMarketTelemetry({ operation: 'get_offers', payload: { search: { market: 'SG' } } }), {});
  assert.deepEqual(mt.buildMarketTelemetry({ operation: null }), {});
  const record = mt.buildMarketTelemetry({
    operation: 'find_products_multi',
    observation: { market_observed: true, market_requested: 'SG', market_source: 'explicit_search', market_bound: ['SG'] },
    body: {
      products: [{ currency: 'SGD', source: 'canonical_chain' }],
      metadata: { query_source: 'agent_products_beauty_external_seed_mainline', route_health: { primary_path_used: 'beauty_external_seed_mainline' } },
    },
    stages: [{ lane: 'early_indexed' }],
  });
  assert.deepEqual(record, {
    market_observed: true, market_requested: 'SG', market_source: 'explicit_search', market_bound: ['SG'], market_buyer_currency: null,
    served_currencies: ['SGD'], served_currency_mismatch: false, served_price_sources: { canonical_chain: 1 },
    lane: 'early_indexed',
    query_source: 'agent_products_beauty_external_seed_mainline', primary_path_used: 'beauty_external_seed_mainline',
  });
  const existing = new Set(['gateway_request_id', 'client_channel', 'key_fingerprint', 'operation', 'status',
    'latency_ms', 'upstream_ms', 'gateway_retries', 'fpm_stage_breakdown', 'fpm_stage_total_ms',
    'fpm_unattributed_ms', 'fpm_upstream_http_ms']);
  for (const key of Object.keys(record)) assert.equal(existing.has(key), false, key);
});

test('malformed input never throws: telemetry must not be able to fail a response', () => {
  for (const args of [
    { operation: 'find_products_multi', observation: null, payload: null, metadata: null, body: null, stages: null },
    { operation: 'find_products_multi', payload: { search: { market: 12345 } }, body: { products: [null, 'x', 7] } },
    { operation: 'find_products_multi', payload: { market: {} }, body: { products: [{ currency: null }] } },
  ]) {
    assert.doesNotThrow(() => mt.buildMarketTelemetry(args), JSON.stringify(args));
  }
});
