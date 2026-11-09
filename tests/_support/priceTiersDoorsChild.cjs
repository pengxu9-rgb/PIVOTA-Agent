'use strict';

// ONE FLAG COMBINATION OF THE PRICE-TIER SURFACES, offline, in its own process: every agent door the price-log
// harness drives (/mcp, /ucp/mcp, /public/mcp, REST, invoke; tests/_support/priceLogDoors.cjs), plus the list
// surfaces this PR touches called directly: the search overlay's exits (maybeOverlayLiveSearchPrice: overlaid,
// price-capped, page 2), the find_products_multi transport projection, recommend_products' handler and
// get_alternatives' handler. Prints one JSON line: { cases: { name: { status, sha256, body } } }.
// Driven by tests/recommendation_price_tiers_doors.node.test.cjs.
//
// IT MUST RUN UNCHANGED ON origin/main (the defaults fixture is captured there): it requires nothing this PR adds,
// and loads every module from ROOT (argv[3], default: this tree), so the same file drives either tree.
//
// No store, backend or merchant is contacted: the doors' own interceptions, a fake storefront fetch for the
// `.json` overlay, the doors' fake UCP client, and fixed lane / edge fixtures. Date is frozen by doors.start.
//
// Usage: node tests/_support/priceTiersDoorsChild.cjs <port> [root]   (env: the flags under test)

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));
const fromRoot = (rel) => require(path.join(ROOT, rel));
const { mock } = require('node:test');

const { createPriceLogDoors, maskIds, NOW } = fromRoot('tests/_support/priceLogDoors.cjs');
const port = Number(process.argv[2]) || 4201;
// The door read caches as the env says (prod runs both ON; the harness default is off).
const cacheEnv = {};
for (const k of ['COMMERCE_READ_CACHE_ENABLED', 'PUBLIC_READ_CACHE_ENABLED']) if (process.env[k] !== undefined) cacheEnv[k] = process.env[k];
const doors = createPriceLogDoors({ port, env: cacheEnv });
const supertest = require(path.join(ROOT, 'node_modules', 'supertest'));

const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const STORE = 'tiers-shop.test';

// One served search page: a live-readable seed row, a dated canonical row, an undated row, a stale seed row.
const page = () => ({
  status: 'success',
  success: true,
  products: [
    {
      product_id: 'sig_t0', title: 'Tint 0', price: 20, currency: 'USD', source: 'external_seed', source_variant_id: '1000',
      destination_url: `https://${STORE}/products/tint-0`, seed_data: { snapshot: { extracted_at: iso(NOW - 2 * DAY) } },
    },
    { product_id: 'sig_t1', title: 'Tint 1', price: 21, currency: 'USD', price_source: 'catalog_offer', price_as_of: iso(NOW - DAY) },
    { product_id: 'sig_t2', title: 'Tint 2', price: 22, currency: 'USD' },
    {
      product_id: 'sig_t3', title: 'Tint 3', price: 23, currency: 'USD', source: 'external_seed', source_variant_id: '1003',
      destination_url: `https://${STORE}/products/tint-3`, seed_data: { snapshot: { extracted_at: iso(NOW - 30 * DAY) } },
    },
  ],
  total: 4,
  metadata: { query_source: 'agent_products_beauty_external_seed_mainline' },
});

const storefront = async (url) => {
  const m = String(url).match(/tint-(\d)\.json$/);
  if (!m) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ product: { variants: [{ id: 1000 + Number(m[1]), price: '19.00', price_currency: 'USD', available: true }] } }) };
};

const RECO = [
  { slot: 'serum', step: 'serum', brand: 'B', name: 'Serum A', display_name: 'Serum A', reasons: ['fits'], sku: { brand: 'B', name: 'Serum A', product_id: 'sig_ra', category: 'Serum' }, merchant_id: 'm', price: { amount: 30, currency: 'USD', unknown: false }, grounding_status: 'grounded' },
  { slot: 'serum', step: 'serum', brand: 'B', name: 'Serum B', display_name: 'Serum B', reasons: ['fits'], sku: { brand: 'B', name: 'Serum B', product_id: 'sig_rb', category: 'Serum' }, merchant_id: 'm', price: { amount: 20, currency: 'USD', unknown: false }, grounding_status: 'grounded' },
];
// recommend's price checks, answered by the REAL producers: a get_pdp_v2 page from pdpBuilder, the PDP live overlay
// over its own cache (the merchant answered 2 min before), the gateway's normalizePdpV2ToProductDetail, then the
// wiring's mapper -- this tree's verifyPriceAnswerOfPdpProduct when it has one, else the { price, currency,
// in_stock } the wiring returned before it existed.
const PDP_HOST = 'tiers-pdp.test';
const PDP_VARIANT = '48087970185268';
function pdpBody(id, amount, merchantAmount) {
  const { buildPdpPayload } = fromRoot('src/pdpBuilder');
  const { applyPdpLiveOverlay, createPdpLiveCache } = fromRoot('src/services/pdpLiveOverlay');
  const handle = `item-${id.replace(/_/g, '-')}`;
  const variant = { variant_id: PDP_VARIANT, title: 'One', options: [{ name: 'Size', value: 'One' }], price: { amount, currency: 'USD' }, in_stock: true, inventory_quantity: 3 };
  const product = {
    product_id: id, merchant_id: 'merch_obs_tiers', source: 'external_seed', title: id, image_url: 'https://cdn.example/x.jpg',
    price: { amount, currency: 'USD' }, currency: 'USD', destination_url: `https://${PDP_HOST}/products/${handle}`,
    default_variant_id: PDP_VARIANT, variants: [variant],
  };
  const pdp = buildPdpPayload({ product, relatedProducts: [], entryPoint: 'agent' });
  pdp.product = { ...pdp.product, price_as_of: iso(NOW - 20 * DAY) };
  const body = { status: 'success', pdp_version: '2.0', modules: [{ type: 'canonical', required: true, data: { pdp_payload: pdp } }], metadata: {} };
  if (merchantAmount === undefined) return body;
  let t = NOW - 2 * 60 * 1000;
  const cache = createPdpLiveCache({ now: () => t });
  cache.record({
    status: 'verified', host: PDP_HOST, country: 'US', currency: 'USD',
    live: new Map([[PDP_VARIANT, { handle, amount: merchantAmount, currency: 'USD', available: true }]]), notFound: new Set(), askedIds: [PDP_VARIANT],
  });
  t = NOW;
  const out = applyPdpLiveOverlay(body, { market: 'US', cache, now: () => t });
  return out ? out.payload : body;
}
const recoHandler = () => {
  const reco = fromRoot('src/agentSignals/recommendProducts');
  const map = typeof reco.verifyPriceAnswerOfPdpProduct === 'function'
    ? reco.verifyPriceAnswerOfPdpProduct
    : (p) => ({ price: p.price, currency: p.currency, in_stock: p.in_stock });
  const bodies = { sig_ra: pdpBody('sig_ra', 30), sig_rb: pdpBody('sig_rb', 21, 20) };
  return reco.makeRecommendProducts({
    generate: async () => ({ norm: { payload: { recommendations: JSON.parse(JSON.stringify(RECO)), confidence: 0.7, missing_info: [], warnings: [], grounding_status: 'grounded', recommendation_meta: { source_mode: 'catalog_grounded' } } } }),
    isEnabled: () => true,
    verifyPrice: async ({ product_id: id }) => {
      const { product } = doors.app._debug.normalizePdpV2ToProductDetail(bodies[id]);
      return product && typeof product.price === 'number' ? map(product) : null;
    },
  });
};
const EDGE = (ref, price, observedAt, score) => ({
  anchor_ref: 'product:sig_anchor', anchor_snapshot: { price: 30, currency: 'USD' },
  candidate_product_ref: ref, candidate_snapshot: { title: ref, brand: 'B', price, currency: 'USD' },
  relation_type: 'competitive_alternative', score_total: score,
  price_evidence: { observed_at: observedAt, price_ratio: price / 30, anchor_price_amount: 30, candidate_price_amount: price },
  source_refs: [], evidence_grade: 'B',
});
const altHandler = () => fromRoot('src/agentSignals/intelligenceReads').makeGetAlternatives({
  listApprovedRelationshipEdgesForAnchor: async () => [
    EDGE('product:sig_aold', 10, iso(NOW - 40 * DAY), 0.95),
    EDGE('product:sig_anew', 12, iso(NOW - DAY), 0.9),
  ],
  buildAnchorRefsFromProduct: () => ['product:sig_anchor'],
  isEnabled: () => true,
});

const asResponse = (value) => ({ status: 200, text: JSON.stringify(value) });
const CASES = {
  ...doors.CASES,
  mcp_tools_list: () => supertest(doors.app).post('/mcp').send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
  ucp_tools_list: () => supertest(doors.app).post('/ucp/mcp').send({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
  overlay_search: async () => asResponse(await doors.app._debug.maybeOverlayLiveSearchPrice(page(), { query: 'tint', market: 'US' }, { buyerMarket: 'US' })),
  overlay_search_capped: async () => asResponse(await doors.app._debug.maybeOverlayLiveSearchPrice(page(), { query: 'tint', market: 'US', price_max: 30 }, { buyerMarket: 'US' })),
  overlay_search_cheapest: async () => asResponse(await doors.app._debug.maybeOverlayLiveSearchPrice(page(), { query: 'cheapest tint', market: 'US' }, { buyerMarket: 'US' })),
  overlay_search_page2: async () => asResponse(await doors.app._debug.maybeOverlayLiveSearchPrice(page(), { query: 'tint', market: 'US', page: 2 }, { buyerMarket: 'US' })),
  overlay_search_no_market: async () => asResponse(await doors.app._debug.maybeOverlayLiveSearchPrice(page(), { query: 'tint' }, {})),
  transport_projection: async () => asResponse(doors.app._debug.projectFindProductsMultiTransportResponse(
    { ...page(), products: page().products.map((p, i) => (i === 0 ? { ...p, price_source: 'merchant_live', price_as_of: iso(NOW) } : p)) },
    { operation: 'find_products_multi' },
  )),
  recommend_handler: async () => asResponse(await recoHandler()({ payload: { need: 'vitamin c serum', limit: 2 } }, { agent_id: 'agent_t' })),
  recommend_handler_capped: async () => asResponse(await recoHandler()({ payload: { need: 'vitamin c serum', constraints: { price_max: 40 }, limit: 2 } }, { agent_id: 'agent_t' })),
  alternatives_handler: async () => asResponse(await altHandler()({ payload: { product_id: 'sig_anchor', market: 'US' } })),
  alternatives_handler_ratio: async () => asResponse(await altHandler()({ payload: { product_id: 'sig_anchor', market: 'US', max_price_ratio: 1 } })),
};

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

(async () => {
  doors.app._debug.useSearchOverlayFetchForTest(storefront);
  await doors.start(mock.timers);
  const out = { root: path.basename(ROOT), cases: {} };
  try {
    for (const [name, request] of Object.entries(CASES)) {
      const r = await doors.send(request, { flag: false });
      // Lines written after the answer (shadow reads) settle before the next case.
      await new Promise((res) => setTimeout(res, 20));
      const body = maskIds(r.text);
      out.cases[name] = { status: r.status, sha256: sha(body), body };
    }
  } finally {
    await doors.stop(mock.timers);
  }
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`${e && e.stack}\n`);
  process.exit(1);
});
