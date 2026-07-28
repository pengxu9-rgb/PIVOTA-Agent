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
          { product_entity_id: 'sig_aaa111', merchant_id: 'merch_real', price: 12, currency: 'USD' },
          { product_entity_id: 'sig_bbb222', merchant_id: rig, price: 1.69, currency: 'USD' },
        ],
      }),
    },
  );
  assert.deepEqual(products.map((p) => p.id), ['sig_aaa111']);
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
          { product_entity_id: 'sig_aaa111', merchant_id: 'merch_real', price: 9, currency: 'USD' },
          { product_entity_id: 'sig_bbb222', merchant_id: 'merch_new_rig', price: 9, currency: 'USD' },
        ],
      }),
    },
  );
  assert.deepEqual(products.map((p) => p.id), ['sig_aaa111']);
});

test('a rig-free page logs nothing — the log line means something', async () => {
  const logged = [];
  await fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: {},
      logger: { info: () => logged.push(1) },
      getProductEntityIndexFeed: async () => ({ products: [{ product_entity_id: 'sig_aaa111', merchant_id: 'merch_real', price: 9, currency: 'USD' }] }),
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

test('connection_layer and execution_path ride through the mapper when the flag is on', () => {
  const item = buildAcpFeedItem(
    {
      id: 'sig_x',
      title: 'Serum',
      price: 21,
      currency: 'USD',
      connection_layer: 1,
      execution_path: ['warm_handoff', 'attributed_redirect'],
    },
    { buildPublicProductUrl: pdp, env: { CONNECTION_LAYER_FIELD_ENABLED: '1' } },
  );
  assert.equal(item.connection_layer, 1);
  assert.deepEqual(item.execution_path, ['warm_handoff', 'attributed_redirect']);
});

test('the two fields are ABSENT unless CONNECTION_LAYER_FIELD_ENABLED', () => {
  // The backend gate for this contract has the SAME name. Without a gate here,
  // flipping it backend-side would grow two fields on the PUBLIC feed with no
  // gateway flag and no gateway deploy — including a layer 3 the sibling lane
  // refuses to claim. So the default must be silence, and the KEY must be
  // absent rather than present-and-undefined.
  const item = buildAcpFeedItem(
    { id: 'p1', title: 'T', price: 5, currency: 'USD', connection_layer: 3, execution_path: ['pivota_psp_checkout'] },
    { buildPublicProductUrl: pdp, env: {} },
  );
  assert.equal('connection_layer' in item, false);
  assert.equal('execution_path' in item, false);
});

test('a redirect-only item is never advertised as one-click', () => {
  // The standing no-execution-layer-fallback rule, as an assertion: the mapper
  // must not derive a better path from a higher layer, or vice versa.
  const on = { buildPublicProductUrl: pdp, env: { CONNECTION_LAYER_FIELD_ENABLED: '1' } };
  const layer1Warm = buildAcpFeedItem(
    { id: 'a', price: 1, currency: 'USD', connection_layer: 1, execution_path: ['warm_handoff'] },
    on,
  );
  const layer2Cold = buildAcpFeedItem(
    { id: 'b', price: 1, currency: 'USD', connection_layer: 2, execution_path: ['attributed_redirect'] },
    on,
  );
  assert.deepEqual(layer1Warm.execution_path, ['warm_handoff']);
  assert.deepEqual(layer2Cold.execution_path, ['attributed_redirect']);
  assert.ok(
    layer2Cold.connection_layer > layer1Warm.connection_layer,
    'the higher layer here has the WORSE path — that asymmetry is real and must survive',
  );
});

test('the price gate is applied BY THE LANE, not left to the caller', () => {
  // The lane's best-offer join is a LEFT JOIN LATERAL, so price-less rows come
  // back rather than being dropped. This module advertises itself as "the whole
  // swap minus one line", so if the gate lived in the caller an integrator doing
  // exactly what the handoff says would ship price:null to ChatGPT/Google. A
  // documented requirement is not a gate.
  return fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: {},
      getProductEntityIndexFeed: async () => ({
        products: [
          { product_entity_id: 'sig_priced', merchant_id: 'm', price: 12, currency: 'USD' },
          { product_entity_id: 'sig_noprice', merchant_id: 'm', price: null, currency: null },
          { product_entity_id: 'sig_nocur', merchant_id: 'm', price: 12, currency: null },
          { product_entity_id: 'sig_zero', merchant_id: 'm', price: 0, currency: 'USD' },
        ],
      }),
    },
  ).then((products) => {
    assert.deepEqual(products.map((p) => p.id), ['sig_priced']);
  });
});

test('dropping unquotable items is logged, so a silent feed shrink is visible', async () => {
  const logged = [];
  await fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: {},
      logger: { info: (meta) => logged.push(meta) },
      getProductEntityIndexFeed: async () => ({
        products: [
          { product_entity_id: 'sig_aaa', merchant_id: 'm', price: 5, currency: 'USD' },
          { product_entity_id: 'sig_bbb', merchant_id: 'm', price: null, currency: null },
        ],
      }),
    },
  );
  const priceLog = logged.find((m) => m.reason === 'not_price_quotable');
  assert.ok(priceLog, 'a dropped-for-price event must be observable');
  assert.equal(priceLog.dropped, 1);
});

// ---- END TO END: the test that would have caught the dead-link defect -------
//
// Every other test in this file feeds synthetic stubs. That is precisely why the
// PR's first two revisions shipped a projection that would have made 100% of the
// feed's `link`s live 500s: no test ever ran a REAL lane row through the real
// chain. This one does — buildProductEntityIndexFeedItem → fetchIndexFeedProducts
// → buildAcpFeedItem — and asserts the emitted link, which is the only field a
// shopping ingester actually dereferences.

const { buildProductEntityIndexFeedItem } = require('../src/services/productEntityIndexFeed');

// Shaped after a real prod row. `product_entity_id` is a sig; `source_product_id`
// is an ext_* seed id. Both are real shapes, verified live:
//   /products/sig_1b4d53ca07835e10cdaada553bc26ed6 -> 200
//   /products/ext_0feb1c58f18d9f6694955e7e         -> 500 (as a bogus id would)
const REAL_LANE_ROW = {
  product_entity_id: 'sig_1b4d53ca07835e10cdaada553bc26ed6',
  source_product_id: 'ext_0feb1c58f18d9f6694955e7e',
  content_key: 'catalog_content_key:ck_real',
  catalog_track: 'external_referral',
  merchant_id: 'external_seed',
  product_name: 'Barrier Repair Cream',
  product_description: 'A real product description.',
  image_url: 'https://cdn.example/i.jpg',
  canonical_url: 'https://brand.example/p',
  price_amount: '18.50',
  price_currency: 'USD',
  availability: 'in_stock',
  seed_data: { title: 'Barrier Repair Cream', brand: 'ANUKO' },
};

test('END TO END: the emitted ACP link is a sig PDP, never the ext_ seed id', async () => {
  const laneItem = buildProductEntityIndexFeedItem(REAL_LANE_ROW);
  assert.equal(laneItem.id, 'ext_0feb1c58f18d9f6694955e7e', 'precondition: the lane really does key on ext_');

  const products = await fetchIndexFeedProducts(
    { limit: 10 },
    { env: {}, getProductEntityIndexFeed: async () => ({ products: [laneItem] }) },
  );
  assert.equal(products.length, 1);

  const item = buildAcpFeedItem(products[0], { buildPublicProductUrl: pdp });
  assert.match(
    item.link,
    /^https:\/\/agent\.pivota\.cc\/products\/sig_[a-z0-9]+$/i,
    `link must be a resolvable sig PDP, got ${item.link}`,
  );
  assert.ok(!item.link.includes('ext_'), 'an ext_ id in the link is a guaranteed 500');
  assert.equal(item.id, 'sig_1b4d53ca07835e10cdaada553bc26ed6');
  assert.equal(item.description, 'A real product description.');
  assert.equal(item.price, 18.5);
  assert.equal(item.currency, 'USD');
});

test('a lane row with no resolvable signature is dropped, not published dead', async () => {
  const logged = [];
  const products = await fetchIndexFeedProducts(
    { limit: 10 },
    {
      env: {},
      logger: { warn: (meta) => logged.push(meta) },
      getProductEntityIndexFeed: async () => ({
        products: [
          { product_entity_id: 'sig_ok111', merchant_id: 'm', price: 5, currency: 'USD' },
          { product_entity_id: 'ext_not_a_sig', merchant_id: 'm', price: 5, currency: 'USD' },
          { merchant_id: 'm', price: 5, currency: 'USD' },
        ],
      }),
    },
  );
  assert.deepEqual(products.map((p) => p.id), ['sig_ok111']);
  const warn = logged.find((m) => m.reason === 'unresolvable_pdp_id');
  assert.ok(warn, 'an unresolvable id is a data problem and must be observable');
  assert.equal(warn.dropped, 2);
});

test('the lane is asked to apply the price gate in SQL, so LIMIT counts quotable rows', async () => {
  let seen = null;
  await fetchIndexFeedProducts(
    { limit: 20 },
    { env: {}, getProductEntityIndexFeed: async (p) => { seen = p; return { products: [] }; } },
  );
  assert.equal(seen.priced_only, true, 'without this a page silently under-delivers by ~24%');
});
