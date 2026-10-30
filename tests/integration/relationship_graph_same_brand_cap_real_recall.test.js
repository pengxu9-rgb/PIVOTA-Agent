// The same-brand cap through the REAL recall and the real serving paths: only the edge read and the
// upstreams are mocked. The other suites mock fetchRelationshipGraphRecallForAnchor, which is why they
// passed while the mixed path diverged from main (controller review of #2415 @8f3b51efd, adapted from
// its differential probe). The cap set to -1 is main's behaviour (no reorder, over-read, tail, tag).
const { once } = require('events');
const nock = require('nock');

const API_BASE = 'http://localhost:8080';
const MERCHANT_ID = 'merch_208139f7600dbf42';
const PRODUCT_ID = 'BOTTLE_001';
const ANCHOR_BRAND = 'Pivota Test';
const sig = (n) => `sig_${String(n).padStart(32, '0')}`;
const NOW = new Date(Date.now() - 3600e3).toISOString();
const FUT = new Date(Date.now() + 30 * 86400e3).toISOString();

function edge(i, brand, score, { snap = {}, priceEvidence } = {}) {
  return {
    id: `edge_${i}`, anchor_type: 'product', anchor_ref: `product:${PRODUCT_ID}`,
    anchor_snapshot: { product_id: PRODUCT_ID, brand: ANCHOR_BRAND, name: 'Insulated Water Bottle' },
    candidate_product_ref: `product:${sig(1000 + i)}`,
    candidate_snapshot: { product_id: sig(1000 + i), pivota_signature_id: sig(1000 + i), brand, vendor: brand, name: `${brand} Bottle ${i}`,
      category: 'Bottle', url: `https://example.test/c${i}`, image_url: `https://cdn.example.test/c${i}.jpg`, price: 20 + i, currency: 'USD', ...snap },
    relation_type: 'competitive_alternative', display_label: 'alternative', market: 'US', vertical: 'home',
    category_taxonomy: ['home', 'bottle'], use_case: 'hydration', score_total: score, score_breakdown: {},
    price_evidence: priceEvidence || { amount: 20 + i, currency: 'USD' }, source_refs: [{ type: 'regression' }], evidence_grade: 'A',
    review_status: 'approved', why_candidate: { summary: `Insulated alternative ${i}` }, tradeoffs: [], watchouts: [], provenance: {},
    last_verified_at: NOW, expires_at: FUT, created_at: NOW, updated_at: NOW,
  };
}

const FIXTURES = {
  interleaved: [edge(1, ANCHOR_BRAND, 0.99), edge(2, 'Hydro Co', 0.98), edge(3, 'pivota test', 0.97), edge(4, 'Klean', 0.96), edge(5, 'PIVOTA-TEST', 0.95), edge(6, 'Yeti', 0.94)],
  big: Array.from({ length: 60 }, (_, i) => edge(100 + i, i % 3 === 0 ? ANCHOR_BRAND : `Brand ${i}`, 0.99 - i / 1000)),
  all_same: Array.from({ length: 5 }, (_, i) => edge(200 + i, ANCHOR_BRAND, 0.9 - i / 100)),
  // One valid same-brand card ahead of 30 cross-brand cards the currency guard kills (JPY on a US rail).
  dead_cross: [
    edge(400, ANCHOR_BRAND, 0.99),
    ...Array.from({ length: 30 }, (_, i) => edge(401 + i, `Dead ${i}`, 0.98 - i / 1000,
      { snap: { currency: 'JPY', price: 3000 }, priceEvidence: { amount: 3000, currency: 'JPY' } })),
  ],
};
const fillerCard = { product_id: sig(9999), pivota_signature_id: sig(9999), merchant_id: 'external_seed', title: 'Bottle Shade 8',
  image_url: 'https://cdn.example.test/f.jpg', card_highlight: 'Same category', price: 20, currency: 'USD', source: 'external', brand: ANCHOR_BRAND,
  reason: 'L1:external:same_brand' };

const ENV_KEYS = ['API_MODE', 'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'DATABASE_URL', 'PGHOST', 'AGENT_AUTH_INTROSPECT_URL',
  'AGENT_AUTH_INTROSPECT_INTERNAL_KEY', 'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED', 'PDP_SIMILAR_GRAPH_ONLY_ENABLED',
  'AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX'];
let savedEnv = null;
const edgeReadLimits = [];

async function startServer(fixture, { graphOnly, sameBrandMax }) {
  jest.resetModules();
  nock.cleanAll();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    API_MODE: 'REAL', PIVOTA_API_BASE: API_BASE,
    PIVOTA_API_KEY: 'ak_live_0000000000000000000000000000000000000000000000000000000000000000',
    AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED: 'true', PDP_SIMILAR_GRAPH_ONLY_ENABLED: graphOnly ? 'true' : 'false',
  });
  if (sameBrandMax === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX;
  else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX = String(sameBrandMax);
  for (const key of ['DATABASE_URL', 'PGHOST', 'AGENT_AUTH_INTROSPECT_URL', 'AGENT_AUTH_INTROSPECT_INTERNAL_KEY']) delete process.env[key];
  const product = { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID, id: PRODUCT_ID, title: 'Insulated Water Bottle', brand: ANCHOR_BRAND,
    vendor: ANCHOR_BRAND, currency: 'USD', price: { amount: 19, currency: 'USD' }, platform: 'shopify', platform_product_id: PRODUCT_ID, in_stock: true };
  nock(API_BASE).persist().post('/agent/shop/v1/invoke', (body) => body?.operation === 'get_product_detail').reply(200, { status: 'success', product });
  nock(API_BASE).persist().get(/.*/).reply(404, { error: 'NOT_FOUND' });
  nock(API_BASE).persist().post(/.*/).reply(404, { error: 'NOT_FOUND' });
  const actualEngine = jest.requireActual('../../src/services/RecommendationEngine');
  jest.doMock('../../src/services/RecommendationEngine', () => ({ ...actualEngine,
    recommend: jest.fn(async () => ({ status: 'success', strategy: 'related_products', items: [fillerCard], metadata: { similar_status: 'ready' } })) }));
  const actualGraph = jest.requireActual('../../src/auroraBff/productRelationshipGraph');
  jest.doMock('../../src/auroraBff/productRelationshipGraph', () => ({ ...actualGraph,
    readApprovedRelationshipEdgesForAnchor: jest.fn(async ({ limit }) => {
      edgeReadLimits.push(limit);
      return { edges: fixture.slice(0, limit).map((e) => JSON.parse(JSON.stringify(e))), diagnostics: { read_status: 'ready', read_reason: null } };
    }) }));
  const app = require('../../src/server');
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  await new Promise((resolve) => server.close(resolve));
  nock.cleanAll();
  for (const [key, value] of Object.entries(savedEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.resetModules();
  jest.dontMock('../../src/services/RecommendationEngine');
  jest.dontMock('../../src/auroraBff/productRelationshipGraph');
}

const REQUESTS = {
  find6: { operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 6, options: { cache_bypass: true } } },
  find12: { operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 12, options: { cache_bypass: true } } },
  pdpv2: { operation: 'get_pdp_v2', payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['similar'], options: { cache_bypass: true } } },
  pdpLegacy: { operation: 'get_pdp', payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['recommendations'] } },
};

// Timing, ids and build stamps differ run to run; everything else must match.
const VOLATILE = /(_ms$|^ms$|latency|timing|checkpoint|phase|duration|elapsed|request_id|requestid|generated_at|served_at|started_at|build|trace|timestamp|^time$|expires)/i;
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    // The pdp v2 timing block names its per-module latency map `modules` (response modules are an array).
    .filter(([key, v]) => !VOLATILE.test(key) && !(key === 'modules' && v && typeof v === 'object' && !Array.isArray(v)))
    .map(([key, v]) => [key, normalize(v)]));
}

async function collect(baseUrl) {
  const post = (payload) => fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  const out = {};
  for (const [name, payload] of Object.entries(REQUESTS)) out[name] = await post(payload);
  let shown = [];
  for (let page = 1; page <= 4; page += 1) {
    const response = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 2,
      ...(shown.length ? { exclude_items: shown } : {}), options: { cache_bypass: true } } });
    out[`page${page}`] = response;
    shown = [...shown, ...((response.body?.products || []).map((p) => ({ product_id: p.product_id, merchant_id: p.merchant_id })))];
  }
  return out;
}

async function run(fixture, options) {
  edgeReadLimits.length = 0;
  const { server, baseUrl } = await startServer(fixture, options);
  try {
    const responses = await collect(baseUrl);
    return { responses, readLimits: [...edgeReadLimits] };
  } finally {
    await stopServer(server);
  }
}

const servedTitles = (response) => (response.body?.products || [])
  .filter((product) => product.relationship_edge_id).map((product) => product.title);

describe('same-brand cap through the real recall', () => {
  test.each(Object.keys(FIXTURES))('graph-only off (%s): every surface serves exactly as with the cap off (main)', async (name) => {
    const capped = await run(FIXTURES[name], { graphOnly: false });
    const main = await run(FIXTURES[name], { graphOnly: false, sameBrandMax: -1 });
    expect(capped.readLimits).toEqual(main.readLimits);
    expect(normalize(capped.responses)).toEqual(normalize(main.responses));
    expect(JSON.stringify(capped.responses)).not.toMatch(/similar_same_brand|relationship_price_ref/);
  });

  test('graph-only on: a same-brand card behind a full rail of cross-brand cards the currency guard kills is still served (review)', async () => {
    const { responses } = await run(FIXTURES.dead_cross, { graphOnly: true });
    expect(servedTitles(responses.find6)).toEqual([`${ANCHOR_BRAND} Bottle 400`]);
    const legacyItems = (responses.pdpLegacy.body?.pdp_payload?.modules || []).find((module) => module?.type === 'recommendations')?.data?.items || [];
    expect(legacyItems.map((item) => item.title)).toContain(`${ANCHOR_BRAND} Bottle 400`);
  });

  test('graph-only on: at most one same-brand card on a rail, after the cross-brand ones, and none on later pages', async () => {
    const { responses } = await run(FIXTURES.interleaved, { graphOnly: true });
    expect(servedTitles(responses.find6)).toEqual(['Hydro Co Bottle 2', 'Klean Bottle 4', 'Yeti Bottle 6', `${ANCHOR_BRAND} Bottle 1`]);
    const paged = ['page1', 'page2', 'page3', 'page4'].flatMap((page) => servedTitles(responses[page]));
    expect(paged.filter((title) => /pivota/i.test(title))).toHaveLength(1);
    expect(JSON.stringify(responses)).not.toMatch(/similar_same_brand|relationship_price_ref/);
  });
});
