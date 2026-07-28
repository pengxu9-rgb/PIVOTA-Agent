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
  INDEX_FEED_ELECTED_CANONICAL_ENV,
  isIndexFeedSourceEnabled,
  isElectedCanonicalEnabled,
  isIndexFeedLaneServable,
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

// ---- the COUPLING between the two flags -------------------------------------
//
// `ACP_FEED_SOURCE=index_feed` without `INDEX_FEED_ELECTED_CANONICAL=1` is the
// state that republishes ~1.5% dead links (9 of 600 sampled prod rows are
// serving_eligible AND unrenderable; in 9/9 the ELECTED canonical resolves 200).
// Until the wiring commit that precondition existed ONLY as a comment, so the
// code was correct in prod purely because the operator set both. These tests
// exist so it is correct because the code says so.

test('the lane is servable ONLY when both flags agree', () => {
  const SRC = { [ACP_FEED_SOURCE_ENV]: 'index_feed' };
  const ELECT = { [INDEX_FEED_ELECTED_CANONICAL_ENV]: '1' };
  assert.equal(isIndexFeedLaneServable({}), false, 'neither flag');
  assert.equal(isIndexFeedLaneServable({ ...SRC }), false, 'source without election = the dead-link state');
  assert.equal(isIndexFeedLaneServable({ ...ELECT }), false, 'election without source is not a source selection');
  assert.equal(isIndexFeedLaneServable({ ...SRC, ...ELECT }), true, 'both = prod');
});

test('THE FEED ROUTE ACTUALLY CALLS THE LANE', () => {
  // The gap this PR exists to close, now pinned — because without this test,
  // deleting the wiring from src/server.js leaves EVERY suite green while the
  // feed silently returns to {"count":0}. That is verbatim the #1840 failure:
  // a fully-built, fully-tested lane that nothing called, with green CI.
  //
  // A source-text assertion is a blunt instrument, and it is used here for the
  // same reason the flag-name test below uses one: `getProducts` lives inside an
  // async closure in `getCommerceAcpRestAdapter()` that needs ACP_SIGNING_SECRET,
  // a token verifier, an executor and a DB before it can be reached, so there is
  // no import that can express "the route asks the gate and calls the lane".
  // Blunt and able to fail beats elegant and vacuous.
  const serverSrc = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.ok(
    serverSrc.includes('isIndexFeedLaneServable()'),
    'the feed must ASK the coupled gate — with no env arg, so it reads the same process.env the lane reads',
  );
  assert.ok(
    /fetchIndexFeedProducts\(query, \{\s*getProductEntityIndexFeed/.test(serverSrc),
    'the feed must actually CALL the lane, and hand it the real getProductEntityIndexFeed',
  );
});

test('the flag NAMES are LITERALS, and are the names the lane itself reads', () => {
  // Found by mutation testing, and worth stating why it needed to be: every
  // other test in this block builds its env off the EXPORTED constant, so
  // renaming the constant renames it in the tests too and the whole block stays
  // green while the guard reads an env var nobody sets. The name is a
  // cross-module contract — `services/productEntityIndexFeed` reads the string
  // `INDEX_FEED_ELECTED_CANONICAL` off process.env directly and cannot be
  // injected — so it is pinned as a literal here, on both sides.
  assert.equal(ACP_FEED_SOURCE_ENV, 'ACP_FEED_SOURCE');
  assert.equal(INDEX_FEED_ELECTED_CANONICAL_ENV, 'INDEX_FEED_ELECTED_CANONICAL');

  // Same assertion again, but through the guard, keyed by literal — so a rename
  // breaks behaviour here and not merely an equality check.
  assert.equal(isIndexFeedLaneServable({ ACP_FEED_SOURCE: 'index_feed', INDEX_FEED_ELECTED_CANONICAL: '1' }), true);
  assert.equal(isIndexFeedLaneServable({ ACP_FEED_SOURCE: 'index_feed' }), false);
  assert.equal(isElectedCanonicalEnabled({ INDEX_FEED_ELECTED_CANONICAL: '1' }), true);

  // The other side of the contract. There is no import that can express "these
  // two modules read the same env var", so the source text is the only place the
  // agreement can be checked at all — and an unchecked agreement between two
  // files is how half-contracts ship here.
  const laneSrc = require('node:fs').readFileSync(
    require.resolve('../src/services/productEntityIndexFeed'),
    'utf8',
  );
  assert.ok(
    laneSrc.includes('process.env.INDEX_FEED_ELECTED_CANONICAL'),
    'productEntityIndexFeed must read the same flag name this gate guards',
  );
});

test('the election flag accepts the same truthy vocabulary as its sibling in the lane', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
    assert.equal(isElectedCanonicalEnabled({ [INDEX_FEED_ELECTED_CANONICAL_ENV]: v }), true, `truthy: ${v}`);
  }
  for (const v of ['', '0', 'false', 'off', 'no', undefined]) {
    assert.equal(isElectedCanonicalEnabled({ [INDEX_FEED_ELECTED_CANONICAL_ENV]: v }), false, `falsy: ${v}`);
  }
});

test('the lane REFUSES to run in the dead-link state, and never reaches the DB', async () => {
  let called = false;
  await assert.rejects(
    () =>
      fetchIndexFeedProducts(
        {},
        {
          env: { [ACP_FEED_SOURCE_ENV]: 'index_feed' }, // election flag missing
          getProductEntityIndexFeed: async () => {
            called = true;
            return { products: [] };
          },
        },
      ),
    /INDEX_FEED_ELECTED_CANONICAL/,
    'a refused feed must not look like an empty one',
  );
  assert.equal(called, false, 'refusal happens BEFORE the query, not after');
});

test('with both flags set the lane runs normally', async () => {
  const products = await fetchIndexFeedProducts(
    {},
    {
      env: { [ACP_FEED_SOURCE_ENV]: 'index_feed', [INDEX_FEED_ELECTED_CANONICAL_ENV]: '1' },
      getProductEntityIndexFeed: async () => ({
        products: [{ product_entity_id: 'sig_abc123', title: 'T', price: 10, currency: 'USD' }],
      }),
    },
  );
  assert.equal(products.length, 1);
  assert.equal(products[0].id, 'sig_abc123');
});

test('the guard is scoped to the mis-wired COMBINATION, not to the election flag alone', async () => {
  // A caller driving the lane directly with no source flag (every other test in
  // this file, and the live get_product_entity_index_feed operation) must be
  // unaffected — otherwise the guard is a breaking change dressed as a safety fix.
  const products = await fetchIndexFeedProducts(
    {},
    {
      env: {},
      getProductEntityIndexFeed: async () => ({
        products: [{ product_entity_id: 'sig_def456', title: 'T', price: 5, currency: 'USD' }],
      }),
    },
  );
  assert.equal(products.length, 1);
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

test('END TO END: a schema.org brand object never reaches the feed as "[object Object]"', async () => {
  // Found by running the REAL lane against the REAL prod DB before merging, not
  // by any unit test: 12 of the 20 rows the ACP feed serves emitted
  // `brand: "[object Object]"`. Several seeds carry a schema.org-shaped brand
  // (`{"@type":"Brand","name":…}`), and `externalSeedProducts.firstNonEmptyString`
  // does `String(value || '')`, so the object arrives pre-stringified — a
  // non-empty string that WINS the coalesce and masks the clean
  // `catalog_products.brand` sitting later in the same chain.
  //
  // The fixture reproduces exactly that: an object at the front, the truth at the
  // back. Brand is a core matching field for shopping ingesters, and this feed's
  // whole wedge is brand visibility.
  const laneItem = buildProductEntityIndexFeedItem({
    ...REAL_LANE_ROW,
    brand: 'Anua', // the clean varchar, LAST in normalizeBrand's chain
    seed_data: {
      title: 'Barrier Repair Cream',
      brand: { '@type': 'Brand', name: 'Anua' }, // the poisoned candidate, FIRST
    },
  });
  assert.notEqual(laneItem.brand, '[object Object]', 'a coercion accident is not a brand');
  assert.equal(laneItem.brand, 'Anua', 'the clean value further down the chain must win');

  const products = await fetchIndexFeedProducts(
    { limit: 10 },
    { env: {}, getProductEntityIndexFeed: async () => ({ products: [laneItem] }) },
  );
  const item = buildAcpFeedItem(products[0], { buildPublicProductUrl: pdp });
  assert.equal(item.brand, 'Anua', 'and it must survive all the way to the emitted feed item');
});

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

test('the CONNECTED lane keeps its price gate', () => {
  // F1 from the #1846 Opus review. Mutating `filtered.filter((p) =>
  // isQuotableFeedItem(mapFeedItem(p)))` back to `filtered` — i.e. exactly
  // origin/main — left ALL 52 tests green. The gate had zero coverage, inside
  // the PR that added it, which is this repo's dominant defect class committed
  // inside a fix for it.
  //
  // Source-text for the same reason as the wiring test above: `getProducts` is
  // a closure inside getCommerceAcpRestAdapter() and cannot be imported.
  const serverSrc = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  assert.ok(
    /filtered\.filter\(\(p\) => isQuotableFeedItem\(mapFeedItem\(p\)\)\)/.test(serverSrc),
    'the connected lane must gate on the MAPPED item — gating the raw upstream row checks a different object than the feed emits',
  );
});

test('a priced-lane failure is LOGGED before it becomes a 500', () => {
  // F2 from the same review. The adapter's guard() turns a throw here into a
  // bare 500 INTERNAL_ERROR and logs NOTHING, and the route's try/catch never
  // sees it. Wiring the lane made the public feed query Postgres on every
  // request, so a DB blip became an UNLOGGED 500 on an externally-ingested
  // surface — undiagnosable from either side.
  //
  // `await` is load-bearing, not style: without it the promise rejection escapes
  // the try block entirely and this whole handler is decorative.
  const serverSrc = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  const block = serverSrc.slice(
    serverSrc.indexOf('if (isIndexFeedLaneServable()) {'),
    serverSrc.indexOf('if (isIndexFeedSourceEnabled()) {'),
  );
  const start = serverSrc.indexOf('if (isIndexFeedLaneServable()) {');
  const end = serverSrc.indexOf('if (isIndexFeedSourceEnabled()) {');
  // Assert the ORDER, not just non-emptiness. With a bare slice, if the second
  // marker ever moved or vanished, `slice(a, -1)` silently returns the rest of
  // the file, `length > 0` still passes, and the regexes below happily match
  // code from somewhere else entirely.
  assert.ok(start >= 0 && end > start, 'could not locate the priced-lane branch');
  assert.ok(
    /return await fetchIndexFeedProducts\(/.test(block),
    'the lane call must be AWAITED inside the try, or the rejection bypasses the catch',
  );
  assert.ok(/logger\.error\(/.test(block), 'a lane failure must be logged at error level');
  assert.ok(
    /throw err;/.test(block),
    'and must RETHROW — falling back to the connected lane would answer 200 with the wrong catalog',
  );
});

test('BEHAVIOURAL: the priced-lane catch actually runs, logs once, and preserves the error', async () => {
  // N1 from the re-review, and it was demonstrated rather than argued: the
  // three regexes above are all satisfied by code that keeps the lane call
  // OUTSIDE any try and parks `logger.error(...); throw err;` in an
  // unreachable branch of the same block. That passes `node --check`, matches
  // every pattern, and leaves a real lane failure exactly as unlogged as
  // before. A source-text test cannot tell reachable from unreachable.
  //
  // So execute the shipped block instead of matching it. Sliced out of
  // src/server.js and run with stubs, because `getProducts` is a closure inside
  // getCommerceAcpRestAdapter() that needs a signing secret, a verifier, an
  // executor and a DB before it can be reached.
  const serverSrc = require('node:fs').readFileSync(require.resolve('../src/server'), 'utf8');
  const start = serverSrc.indexOf('if (isIndexFeedLaneServable()) {');
  const end = serverSrc.indexOf('if (isIndexFeedSourceEnabled()) {');
  assert.ok(start >= 0 && end > start, 'could not locate the priced-lane branch');
  const block = serverSrc.slice(start, end);

  const boom = Object.assign(new Error('relation "content_canonical_election" does not exist'), { code: '42P01' });
  const errors = [];
  const logger = { error: (...a) => errors.push(a), warn() {}, info() {} };

  const run = new Function(
    'isIndexFeedLaneServable', 'fetchIndexFeedProducts', 'getProductEntityIndexFeed', 'logger',
    `return (async (query) => { ${block} })`,
  )(() => true, async () => { throw boom; }, {}, logger);

  const caught = await run({}).then(
    () => { throw new Error('the lane failure must NOT be swallowed — a silent 200 count:0 is the shape this guards'); },
    (e) => e,
  );

  assert.equal(caught, boom, 'the rethrow must preserve error identity, not wrap or replace it');
  assert.equal(errors.length, 1, 'exactly one error log per failed request');
  assert.equal(errors[0][0].surface, 'acp_public_feed');
  assert.equal(errors[0][0].code, '42P01');

  // A NON-EMPTY query too. Asserting only on `run({})` let a mutant route the
  // lane call through an unguarded early return for any query-bearing request
  // and still pass — and that shape is LIVE-REACHABLE, not theoretical:
  // `express.json()` ignores the method, so a GET carrying a JSON body arrives
  // here with a real query (measured on prod: `{"query":{"query":"serum"}}`
  // returns 17 rows). A single-input test cannot see that path at all.
  const caught2 = await run({ limit: 100, query: 'serum' }).then(
    () => { throw new Error('a query-bearing request must not bypass the catch'); },
    (e) => e,
  );
  assert.equal(caught2, boom);
  assert.equal(errors.length, 2, 'the query-bearing path must log too, not just the empty one');
});
