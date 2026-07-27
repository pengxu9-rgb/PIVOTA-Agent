'use strict';

// The priced serving lane behind GET /acp/feed (pivota-backend ADR-018).
//
// Every assertion here defends one of two things: that the flag genuinely leaves
// today's behaviour alone, and that a rig or a price-less row cannot reach a
// public, externally-ingested surface.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ACP_FEED_SOURCE_ENV,
  isIndexFeedSourceEnabled,
  resolveFeedMarket,
  fetchIndexFeedProducts,
} = require('../src/services/acpFeedSource');
const { buildAcpFeedItem, isQuotableFeedItem } = require('../src/acpFeedItem');
const { TEST_MERCHANT_IDS } = require('../src/services/testMerchantPolicy');

const pdp = (id) => `https://agent.pivota.cc/products/${id}`;

// ---- the flag ---------------------------------------------------------------

test('index-feed source is OFF unless explicitly selected', () => {
  assert.equal(isIndexFeedSourceEnabled({}), false);
  assert.equal(isIndexFeedSourceEnabled({ [ACP_FEED_SOURCE_ENV]: '' }), false);
  assert.equal(isIndexFeedSourceEnabled({ [ACP_FEED_SOURCE_ENV]: '1' }), false, 'truthy is not a source name');
  assert.equal(isIndexFeedSourceEnabled({ [ACP_FEED_SOURCE_ENV]: 'true' }), false);
  assert.equal(isIndexFeedSourceEnabled({ [ACP_FEED_SOURCE_ENV]: 'find_products' }), false);
});

test('index-feed source is ON only for the exact source name', () => {
  assert.equal(isIndexFeedSourceEnabled({ [ACP_FEED_SOURCE_ENV]: 'index_feed' }), true);
  assert.equal(isIndexFeedSourceEnabled({ [ACP_FEED_SOURCE_ENV]: '  INDEX_FEED  ' }), true);
});

test('feed market defaults to US and is upper-cased', () => {
  assert.equal(resolveFeedMarket({}), 'US');
  assert.equal(resolveFeedMarket({ ACP_FEED_MARKET: 'gb' }), 'GB');
  assert.equal(resolveFeedMarket({ ACP_FEED_MARKET: '   ' }), 'US');
});

// ---- rig exclusion ----------------------------------------------------------

test('test/demo merchants are dropped even when the SQL gate let them through', async () => {
  // Defence in depth is the whole point: on 2026-07-23 all 20 live feed items
  // were rigs because the lane in play was not covered by the SQL source gate.
  const rig = TEST_MERCHANT_IDS[0];
  const logged = [];
  const products = await fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: {},
      logger: { info: (meta, msg) => logged.push({ meta, msg }) },
      getProductEntityIndexFeed: async () => ({
        products: [
          { id: 'a', merchant_id: 'merch_real', price: 12, currency: 'USD' },
          { id: 'b', merchant_id: rig, price: 1.69, currency: 'USD' },
        ],
      }),
    },
  );
  assert.deepEqual(products.map((p) => p.id), ['a']);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].meta.dropped, 1);
  assert.equal(logged[0].meta.surface, 'acp_public_feed');
});

test('the env escape hatch can exclude a newly-spotted rig without a deploy', async () => {
  const products = await fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: { PIVOTA_TEST_MERCHANT_IDS: 'merch_new_rig' },
      getProductEntityIndexFeed: async () => ({
        products: [
          { id: 'a', merchant_id: 'merch_real' },
          { id: 'b', merchant_id: 'merch_new_rig' },
        ],
      }),
    },
  );
  assert.deepEqual(products.map((p) => p.id), ['a']);
});

test('a rig-free page logs nothing — the log line means something', async () => {
  const logged = [];
  await fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: {},
      logger: { info: () => logged.push(1) },
      getProductEntityIndexFeed: async () => ({ products: [{ id: 'a', merchant_id: 'merch_real' }] }),
    },
  );
  assert.equal(logged.length, 0);
});

// ---- what the lane is asked for ---------------------------------------------

test('the lane is asked for the pinned market and an identifiable tool', async () => {
  let seen = null;
  await fetchIndexFeedProducts(
    { limit: 7, cursor: 'abc' },
    {
      env: {},
      getProductEntityIndexFeed: async (payload) => {
        seen = payload;
        return { products: [] };
      },
    },
  );
  assert.equal(seen.market, 'US');
  assert.equal(seen.tool, 'acp_public_feed');
  assert.equal(seen.limit, 7);
  assert.equal(seen.cursor, 'abc');
});

test('an absurd limit is clamped rather than passed through', async () => {
  let seen = null;
  const deps = {
    env: {},
    getProductEntityIndexFeed: async (payload) => {
      seen = payload;
      return { products: [] };
    },
  };
  await fetchIndexFeedProducts({ limit: 100000 }, deps);
  assert.equal(seen.limit, 100);
  await fetchIndexFeedProducts({ limit: -5 }, deps);
  assert.equal(seen.limit, 1);
  await fetchIndexFeedProducts({ limit: 'nonsense' }, deps);
  assert.equal(seen.limit, 20);
});

test('a non-array products payload degrades to empty, never throws', async () => {
  for (const payload of [{}, { products: null }, { products: 'nope' }, null]) {
    const out = await fetchIndexFeedProducts({}, { env: {}, getProductEntityIndexFeed: async () => payload });
    assert.deepEqual(out, []);
  }
});

// ---- the price gate ---------------------------------------------------------

test('price-quotability requires an amount AND its own currency', () => {
  assert.equal(isQuotableFeedItem({ price: 12.5, currency: 'USD' }), true);
  assert.equal(isQuotableFeedItem({ price: 12.5, currency: 'INR' }), true, 'non-USD is still quotable');
  assert.equal(isQuotableFeedItem({ price: null, currency: 'USD' }), false, 'the price:null class');
  assert.equal(isQuotableFeedItem({ price: 12.5, currency: null }), false, 'currency is never defaulted');
  assert.equal(isQuotableFeedItem({ price: 12.5, currency: '  ' }), false);
  assert.equal(isQuotableFeedItem({ price: 0, currency: 'USD' }), false);
  assert.equal(isQuotableFeedItem({ price: -3, currency: 'USD' }), false);
  assert.equal(isQuotableFeedItem({ currency: 'USD' }), false);
  assert.equal(isQuotableFeedItem(undefined), false);
  assert.equal(isQuotableFeedItem('nope'), false);
});

test('a string amount from the DB numeric type still counts as quotable', () => {
  // catalog_offers prices arrive as strings through pg's numeric mapping.
  assert.equal(isQuotableFeedItem({ price: '18.50', currency: 'USD' }), true);
});

// ---- the two-field expression ----------------------------------------------

test('connection_layer and execution_path ride through the mapper', () => {
  const item = buildAcpFeedItem(
    {
      id: 'sig_x',
      title: 'Serum',
      price: 21,
      currency: 'USD',
      connection_layer: 1,
      execution_path: ['warm_handoff', 'attributed_redirect'],
    },
    { buildPublicProductUrl: pdp },
  );
  assert.equal(item.connection_layer, 1);
  assert.deepEqual(item.execution_path, ['warm_handoff', 'attributed_redirect']);
});

test('the two fields are absent — not invented — on the existing find_products lane', () => {
  // Today's source supplies neither, so the emitted item must be unchanged.
  const item = buildAcpFeedItem({ id: 'p1', title: 'T', price: 5, currency: 'USD' }, { buildPublicProductUrl: pdp });
  assert.equal(item.connection_layer, undefined);
  assert.equal(item.execution_path, undefined);
  assert.equal('connection_layer' in item, true, 'key present with undefined value is fine; a guessed value is not');
});

test('a redirect-only item is never advertised as one-click', () => {
  // The standing no-execution-layer-fallback rule, as an assertion: the mapper
  // must not derive a better path from a higher layer, or vice versa.
  const layer1Warm = buildAcpFeedItem(
    { id: 'a', price: 1, currency: 'USD', connection_layer: 1, execution_path: ['warm_handoff'] },
    { buildPublicProductUrl: pdp },
  );
  const layer2Cold = buildAcpFeedItem(
    { id: 'b', price: 1, currency: 'USD', connection_layer: 2, execution_path: ['attributed_redirect'] },
    { buildPublicProductUrl: pdp },
  );
  assert.deepEqual(layer1Warm.execution_path, ['warm_handoff']);
  assert.deepEqual(layer2Cold.execution_path, ['attributed_redirect']);
  assert.ok(
    layer2Cold.connection_layer > layer1Warm.connection_layer,
    'the higher layer here has the WORSE path — that asymmetry is real and must survive',
  );
});
