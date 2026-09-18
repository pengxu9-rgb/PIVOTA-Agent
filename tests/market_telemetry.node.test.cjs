'use strict';

// Unit tests for src/services/marketTelemetry.js. The module is descriptive: it must report
// what the door did, never decide anything, and never invent a value it does not have.

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const test = require('node:test');

const mt = require('../src/services/marketTelemetry');
const { marketsForRequest } = require('../src/services/servedMarkets');

test('market_source distinguishes the two places a caller can name a market, and silence', () => {
  assert.equal(mt.resolveRequestedMarket({ market: 'SG' }, {}).source, 'explicit_search');
  assert.equal(mt.resolveRequestedMarket({}, { market: 'SG' }).source, 'explicit_metadata');
  assert.equal(mt.resolveRequestedMarket({}, {}).source, 'defaulted');
  // search wins, because that is the precedence the door applies.
  assert.equal(mt.resolveRequestedMarket({ market: 'SG' }, { market: 'US' }).requested, 'SG');
});

test('market_requested is verbatim; market_bound is what the DOOR binds, not a second opinion', () => {
  // The point of the module: it calls marketsForRequest rather than re-deriving. A lower-case
  // or padded request must therefore report exactly what the door would bind for it.
  for (const raw of ['sg', ' SG ', 'SG']) {
    const r = mt.resolveRequestedMarket({ market: raw }, {});
    assert.equal(r.requested, String(raw).trim(), raw);
    assert.deepEqual(r.bound, marketsForRequest(String(raw).trim()), raw);
  }
  // Silence binds the deployment's served list, whatever it is.
  assert.deepEqual(mt.resolveRequestedMarket({}, {}).bound, marketsForRequest(null));
  // A market the door cannot parse still reports what the caller SAID -- that is the point.
  const bad = mt.resolveRequestedMarket({ market: 'EU-DE' }, {});
  assert.equal(bad.requested, 'EU-DE');
  assert.deepEqual(bad.bound, marketsForRequest('EU-DE'));
});

test('served_currency_mismatch counts MIXED, and an unpriced row is not a mix', () => {
  const sgd = { currency: 'SGD' };
  const usd = { currency: 'USD' };
  const none = { title: 'no currency at all' };
  // The live case this counter exists for: SGD 28.20 beside USD 10.40 on one page.
  assert.equal(mt.summariseServedProducts([sgd, usd]).served_currency_mismatch, true);
  assert.equal(mt.summariseServedProducts([sgd, sgd]).served_currency_mismatch, false);
  // Incomplete is not mixed. Conflating them makes the counter useless for its question.
  assert.equal(mt.summariseServedProducts([sgd, none]).served_currency_mismatch, false);
  assert.equal(mt.summariseServedProducts([]).served_currency_mismatch, false);
  // A missing currency is reported as unknown, never stamped with a default.
  assert.deepEqual(mt.summariseServedProducts([none]).served_currencies, ['unknown']);
  assert.deepEqual(mt.summariseServedProducts([sgd, usd]).served_currencies, ['SGD', 'USD']);
});

test('served_price_sources counts rows by recall source', () => {
  const rows = [
    { currency: 'USD', source: 'canonical_chain' },
    { currency: 'USD', search_recall_source: 'canonical_chain' },
    { currency: 'SGD', catalog_source: 'external_seed' },
    { currency: 'SGD' },
  ];
  assert.deepEqual(mt.summariseServedProducts(rows).served_price_sources, {
    canonical_chain: 2, external_seed: 1, unknown: 1,
  });
});

test('lane comes from the stage breakdown the handler already records', () => {
  assert.equal(mt.laneFromStageBreakdown([{ stage: 'route_entry' }, { stage: 'recall', lane: 'early_indexed' }]), 'early_indexed');
  // The LAST lane wins: a request that falls through lanes is reported by what served it.
  assert.equal(mt.laneFromStageBreakdown([{ lane: 'early_indexed' }, { lane: 'mainline_direct' }]), 'mainline_direct');
  assert.equal(mt.laneFromStageBreakdown([{ stage: 'route_entry' }]), null);
  assert.equal(mt.laneFromStageBreakdown([]), null);
});

test('the record is emitted for find_products_multi ONLY, and is additive', () => {
  assert.deepEqual(mt.buildMarketTelemetry({ operation: 'get_offers', search: { market: 'SG' } }), {});
  assert.deepEqual(mt.buildMarketTelemetry({ operation: null }), {});
  const record = mt.buildMarketTelemetry({
    operation: 'find_products_multi',
    search: { market: 'SG' },
    metadata: { market: 'US' },
    products: [{ currency: 'SGD', source: 'canonical_chain' }],
    stages: [{ lane: 'early_indexed' }],
  });
  assert.deepEqual(record, {
    market_requested: 'SG',
    market_source: 'explicit_search',
    market_bound: marketsForRequest('SG'),
    served_currencies: ['SGD'],
    served_currency_mismatch: false,
    served_price_sources: { canonical_chain: 1 },
    lane: 'early_indexed',
  });
  // Every key is new: none of them collides with a field the invoke log line already emits.
  const existing = new Set(['gateway_request_id', 'client_channel', 'key_fingerprint', 'operation',
    'status', 'latency_ms', 'upstream_ms', 'gateway_retries', 'fpm_stage_breakdown',
    'fpm_stage_total_ms', 'fpm_unattributed_ms', 'fpm_upstream_http_ms']);
  for (const key of Object.keys(record)) assert.equal(existing.has(key), false, key);
});

test('a malformed request never throws: telemetry must not be able to fail a response', () => {
  for (const args of [
    { operation: 'find_products_multi', search: null, metadata: null, products: null, stages: null },
    { operation: 'find_products_multi', search: { market: 12345 }, products: [null, 'x', 7] },
    { operation: 'find_products_multi', search: { market: '' }, products: [{ currency: null }] },
  ]) {
    assert.doesNotThrow(() => mt.buildMarketTelemetry(args), JSON.stringify(args));
  }
});
