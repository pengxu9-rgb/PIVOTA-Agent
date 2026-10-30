const { once } = require('events');
const nock = require('nock');

function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

const API_BASE = 'http://localhost:8080';
const MERCHANT_ID = 'merch_208139f7600dbf42';
const PRODUCT_ID = 'BOTTLE_001';

const ENV_KEYS = [
  'API_MODE',
  'PIVOTA_API_BASE',
  'PIVOTA_API_KEY',
  'DATABASE_URL',
  'PGHOST',
  'AGENT_AUTH_INTROSPECT_URL',
  'AGENT_AUTH_INTROSPECT_INTERNAL_KEY',
  'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
  'PDP_SIMILAR_GRAPH_ONLY_ENABLED',
];
let previousEnv = null;
let recommendCalls = [];

function buildBottleProduct() {
  return {
    merchant_id: MERCHANT_ID,
    product_id: PRODUCT_ID,
    id: PRODUCT_ID,
    title: 'Insulated Water Bottle',
    brand: 'Pivota Test',
    currency: 'USD',
    price: { amount: 19, currency: 'USD' },
    platform: 'shopify',
    platform_product_id: PRODUCT_ID,
    in_stock: true,
  };
}

// The similar rails are served by the relationship graph only (PDP_SIMILAR_GRAPH_ONLY_ENABLED, default
// on): the dynamic recall lanes that filled prod rails with category filler are never called. A product
// with no reviewed edges shows an honest empty rail; a graph read that fails is an outage (find_similar
// 503, get_pdp_v2 similar unavailable). =false restores graph + dynamic recall.
const GRAPH_SIG = 'sig_00000000000000000000000000000a11';
const FILLER_SIG = 'sig_0000000000000000000000000000f111';
const graphCard = { product_id: GRAPH_SIG, pivota_signature_id: GRAPH_SIG, title: 'Steel Bottle', image_url: 'https://cdn.example.test/b.jpg',
  card_highlight: 'Insulated steel', price: 21, currency: 'USD', source: 'relationship_graph', recommendation_source: 'relationship_graph',
  relationship_edge_id: 'prel_graph', relationship_type: 'competitive_alternative' };
const fillerCard = { product_id: FILLER_SIG, pivota_signature_id: FILLER_SIG, merchant_id: 'external_seed', title: 'Bottle Shade 8',
  image_url: 'https://cdn.example.test/f.jpg', card_highlight: 'Same category', price: 20, currency: 'USD', source: 'external',
  reason: 'L3E:external:external_leaf_category' };

const manyCards = Array.from({ length: 8 }, (_, i) => ({ ...graphCard, product_id: `sig_0000000000000000000000000000c${String(i).padStart(3, '0')}`,
  pivota_signature_id: `sig_0000000000000000000000000000c${String(i).padStart(3, '0')}`, title: `Steel Bottle ${i}`, relationship_edge_id: `prel_many_${i}` }));
// A graph card the public surfaces must not show: an external-seed id with no public signature, priced in JPY.
const leakCard = { product_id: 'ext_leak_candidate', external_product_id: 'ext_leak_candidate', merchant_id: 'external_seed', title: 'Leaky Bottle',
  image_url: 'https://cdn.example.test/l.jpg', card_highlight: 'x', price: 3000, currency: 'JPY', source: 'relationship_graph',
  recommendation_source: 'relationship_graph', relationship_edge_id: 'prel_leak', relationship_type: 'competitive_alternative' };
// Recall output for an anchor with 2 cross-brand and 3 same-brand edges (tagged by recall).
const sameBrandRail = [
  ...manyCards.slice(0, 2),
  ...manyCards.slice(2, 5).map((card, i) => ({ ...card, title: `Own Brand ${i + 2}`, similar_same_brand: true })),
];
let graphAnchors = [];

// graphOnly: true/false sets the flag; 'unset' removes it (the default is OFF); a string is set as is.
async function startServer({ graph = 'items', graphOnly = true, graphSurface = true } = {}) {
  graphAnchors = [];
  jest.resetModules();
  nock.cleanAll();
  recommendCalls = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.API_MODE = 'REAL';
  process.env.PIVOTA_API_BASE = API_BASE;
  process.env.PIVOTA_API_KEY = 'ak_live_0000000000000000000000000000000000000000000000000000000000000000';
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED = graphSurface ? 'true' : 'false';
  if (graphOnly === 'unset') delete process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED;
  else if (typeof graphOnly === 'string') process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED = graphOnly;
  else process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED = graphOnly ? 'true' : 'false';
  delete process.env.DATABASE_URL;
  delete process.env.PGHOST;
  delete process.env.AGENT_AUTH_INTROSPECT_URL;
  delete process.env.AGENT_AUTH_INTROSPECT_INTERNAL_KEY;
  nock(API_BASE).persist().post('/agent/shop/v1/invoke', (body) => body?.operation === 'get_product_detail')
    .reply(200, { status: 'success', product: buildBottleProduct() });
  nock(API_BASE).persist().get(/.*/).reply(404, { error: 'NOT_FOUND' });
  nock(API_BASE).persist().post(/.*/).reply(404, { error: 'NOT_FOUND' });
  const actualRecommendationEngine = jest.requireActual('../../src/services/RecommendationEngine');
  jest.doMock('../../src/services/RecommendationEngine', () => ({
    ...actualRecommendationEngine,
    recommend: jest.fn(async (args) => {
      recommendCalls.push(args);
      return { status: 'success', strategy: 'related_products', items: [fillerCard], metadata: { similar_status: 'ready' } };
    }),
  }));
  const actualRecall = jest.requireActual('../../src/services/relationshipGraphRecall');
  jest.doMock('../../src/services/relationshipGraphRecall', () => ({
    ...actualRecall,
    fetchRelationshipGraphRecallForAnchor: jest.fn(async ({ anchorProduct }) => {
      graphAnchors.push(anchorProduct);
      if (graph === 'sameBrand') return { edges: [], items: sameBrandRail, metadata: { enabled: true, edge_count: 5, item_count: 5, read_status: 'ready', read_reason: null } };
      if (graph === 'many') return { edges: [], items: manyCards, metadata: { enabled: true, edge_count: 8, item_count: 8, read_status: 'ready', read_reason: null } };
      if (graph === 'leak') return { edges: [], items: [graphCard, leakCard], metadata: { enabled: true, edge_count: 2, item_count: 2, read_status: 'ready', read_reason: null } };
      if (graph === 'throw') throw new Error('graph read exploded');
      if (graph === 'unavailable') return { edges: [], items: [], metadata: { enabled: true, edge_count: 0, item_count: 0, read_status: 'unavailable', read_reason: 'read_failed' } };
      if (graph === 'empty') return { edges: [], items: [], metadata: { enabled: true, edge_count: 0, item_count: 0, read_status: 'empty', read_reason: 'no_eligible_edges' } };
      return { edges: [], items: [graphCard], metadata: { enabled: true, edge_count: 1, item_count: 1, read_status: 'ready', read_reason: null } };
    }),
  }));
  const app = require('../../src/server');
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopServer(server) {
  if (server) await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  nock.cleanAll();
  for (const [key, value] of Object.entries(previousEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv = null;
  jest.resetModules();
  jest.dontMock('../../src/services/RecommendationEngine');
  jest.dontMock('../../src/services/relationshipGraphRecall');
}

async function bothSurfaces(baseUrl) {
  const post = (payload) => fetch(`${baseUrl}/agent/shop/v1/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const pdpResponse = await post({ operation: 'get_pdp_v2', payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['similar'] } });
  const pdpBody = await pdpResponse.json();
  const similarModule = (pdpBody.modules || []).find((module) => module?.type === 'similar');
  const findResponse = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 6, options: { cache_bypass: true } } });
  const findBody = await findResponse.json();
  return { pdpResponse, pdpBody, similarModule, findResponse, findBody };
}
const ids = (items) => (items || []).map((item) => item.product_id).sort();

describeIfRuntimeDeps('similar rails are served by the relationship graph only', () => {
  test('with graph-only on, only graph cards are served on both surfaces and dynamic recall is never called', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { pdpResponse, similarModule, findResponse, findBody } = await bothSurfaces(baseUrl);
      expect(pdpResponse.status).toBe(200);
      expect(ids(similarModule.data.items)).toEqual([GRAPH_SIG]);
      expect(findResponse.status).toBe(200);
      expect(ids(findBody.products)).toEqual([GRAPH_SIG]);
      expect(findBody.metadata).toMatchObject({ similar_main_route: 'relationship_graph', dynamic_recall_skipped: true });
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test.each([['unset'], ['disabled'], ['ture'], ['0'], ['false']])('PDP_SIMILAR_GRAPH_ONLY_ENABLED=%s is off: graph + dynamic recall, as prod serves today (controller nits 1-2)', async (value) => {
    const { server, baseUrl } = await startServer({ graphOnly: value });
    try {
      const { findBody } = await bothSurfaces(baseUrl);
      expect([value, ids(findBody.products)]).toEqual([value, [FILLER_SIG, GRAPH_SIG].sort()]);
      expect(recommendCalls.length).toBeGreaterThan(0);
    } finally {
      await stopServer(server);
    }
  });

  test.each([['true'], ['1'], ['yes'], ['on'], ['enabled'], [' TRUE ']])('PDP_SIMILAR_GRAPH_ONLY_ENABLED=%s is on', async (value) => {
    const { server, baseUrl } = await startServer({ graphOnly: value });
    try {
      const { findBody } = await bothSurfaces(baseUrl);
      expect([value, ids(findBody.products)]).toEqual([value, [GRAPH_SIG]]);
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test('product intel (the 4th graph-only surface) answers without related products when the graph read fails, and says so in the log (controller nit 4)', async () => {
    const { server, baseUrl } = await startServer({ graph: 'throw' });
    const logger = require('../../src/logger');
    const warn = jest.spyOn(logger, 'warn');
    try {
      const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'get_product_recommendation_intents_v1', payload: { product_ref: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID } } }) });
      expect(response.status).toBe(200);
      expect((await response.json()).recommendation_intents?.similar).toEqual([]);
      expect(warn.mock.calls.some(([fields]) => fields?.event === 'product_intel_related_products_unavailable')).toBe(true);
    } finally {
      warn.mockRestore();
      await stopServer(server);
    }
  });

  test('no reviewed edges: an honest empty rail on both surfaces, not filler and not an outage', async () => {
    const { server, baseUrl } = await startServer({ graph: 'empty' });
    try {
      const { pdpResponse, similarModule, findResponse, findBody } = await bothSurfaces(baseUrl);
      expect(pdpResponse.status).toBe(200);
      expect(similarModule.reason).toBeUndefined();
      expect(similarModule.data).toEqual(expect.objectContaining({ items: [] }));
      expect(findResponse.status).toBe(200);
      expect(findBody.products).toEqual([]);
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test.each(['unavailable', 'throw'])('a graph read that is %s is an outage on both surfaces', async (graph) => {
    const { server, baseUrl } = await startServer({ graph });
    try {
      const { pdpResponse, similarModule, pdpBody, findResponse } = await bothSurfaces(baseUrl);
      expect(pdpResponse.status).toBe(200);
      expect(similarModule.data).toBeNull();
      expect(similarModule.reason).toBe('unavailable');
      expect(pdpBody.missing).toEqual(expect.arrayContaining([{ type: 'similar', reason: 'unavailable' }]));
      expect(findResponse.status).toBe(503);
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test('the legacy get_pdp recommendations are graph-only too', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'get_pdp', payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['recommendations'] } }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain(GRAPH_SIG);
      expect(text).not.toContain(FILLER_SIG);
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test('"load more" pages through the graph: exclude_items skips the cards already shown', async () => {
    const { server, baseUrl } = await startServer({ graph: 'many' });
    try {
      const post = (payload) => fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
      const page1 = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 3, options: { cache_bypass: true } } });
      expect(page1.products).toHaveLength(3);
      const shown = page1.products.map((p) => ({ product_id: p.product_id, merchant_id: p.merchant_id }));
      const page2 = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 3, exclude_items: shown, options: { cache_bypass: true } } });
      expect(page2.products).toHaveLength(3);
      // The read covers the shown cards too (they are dropped after it): k + shown (controller nit 3).
      const readLimits = require('../../src/services/relationshipGraphRecall').fetchRelationshipGraphRecallForAnchor.mock.calls.map(([args]) => args.limit);
      expect(readLimits[1]).toBe(Math.min(120, readLimits[0] + shown.length));
      expect(page2.products.map((p) => p.product_id).filter((id) => shown.some((s) => s.product_id === id))).toEqual([]);
      // Pages end when the graph is exhausted: 8 edges, pages of 3 -> 3, 3, 2.
      const shown2 = [...shown, ...page2.products.map((p) => ({ product_id: p.product_id }))];
      const page3 = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 3, exclude_items: shown2, options: { cache_bypass: true } } });
      expect(page3.products).toHaveLength(2);
      // A shown card re-labelled with its seller of record (not the edge snapshot's) still excludes it.
      const reSold = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 8, exclude_items: [{ product_id: manyCards[1].product_id, merchant_id: 'merch_obs_seller' }], options: { cache_bypass: true } } });
      expect(reSold.products.map((p) => p.product_id)).not.toContain(manyCards[1].product_id);
      // A title-only exclusion works too (recall's rule).
      const byTitle = await post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 8, exclude_items: [{ title: 'Steel Bottle 0', brand: 'Pivota Test' }], options: { cache_bypass: true } } });
      expect(byTitle.products.map((p) => p.title)).not.toContain('Steel Bottle 0');
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test('"load more" never lets a second same-brand card through: the cap is spent once a page showed one (review)', async () => {
    const { server, baseUrl } = await startServer({ graph: 'sameBrand' });
    try {
      const post = (payload) => fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json());
      const page = (exclude) => post({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 3, ...(exclude ? { exclude_items: exclude } : {}), options: { cache_bypass: true } } });
      const graphTitles = (body) => body.products.filter((p) => p.relationship_edge_id).map((p) => p.title);
      const page1 = await page();
      expect(graphTitles(page1)).toEqual(['Steel Bottle 0', 'Steel Bottle 1', 'Own Brand 2']);
      const page2 = await page(page1.products.map((p) => ({ product_id: p.product_id, merchant_id: p.merchant_id })));
      expect(graphTitles(page2)).toEqual([]);
      expect(page2.metadata).toMatchObject({ relationship_graph_same_brand_count: 3, relationship_graph_same_brand_spent_dropped_count: 2 });
      expect(JSON.stringify([page1, page2])).not.toContain('similar_same_brand');
      // A bundle component riding in exclude_items was never shown: it does not spend the cap.
      const component = { product_id: sameBrandRail[2].product_id, merchant_id: 'external_seed', retrieval_source: 'reviewed_component_ref' };
      expect(graphTitles(await page([component]))).toEqual(['Steel Bottle 0', 'Steel Bottle 1', 'Own Brand 3']);
    } finally {
      await stopServer(server);
    }
  });

  test('recall is asked for the same-brand handling only on the graph-only path', async () => {
    for (const [graphOnly, expected] of [[true, true], [false, false], ['unset', false]]) {
      const { server, baseUrl } = await startServer({ graph: 'sameBrand', graphOnly });
      try {
        const recall = require('../../src/services/relationshipGraphRecall');
        await fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 3, options: { cache_bypass: true } } }) });
        const calls = recall.fetchRelationshipGraphRecallForAnchor.mock.calls;
        expect([graphOnly, calls.length > 0, calls.every(([args]) => args.sameBrandCap === expected)]).toEqual([graphOnly, true, true]);
      } finally {
        await stopServer(server);
      }
    }
  });

  test('with graph-only off the same-brand cap does not apply (dynamic recall would backfill unreviewed same-brand cards)', async () => {
    const { server, baseUrl } = await startServer({ graph: 'sameBrand', graphOnly: false });
    try {
      const body = await fetch(`${baseUrl}/agent/shop/v1/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'find_similar_products', payload: { product_id: PRODUCT_ID, merchant_id: MERCHANT_ID, limit: 6, options: { cache_bypass: true } } }) }).then((r) => r.json());
      const ownBrand = body.products.filter((p) => String(p.title).startsWith('Own Brand'));
      expect(ownBrand).toHaveLength(3);
      expect(JSON.stringify(body)).not.toContain('similar_same_brand');
    } finally {
      await stopServer(server);
    }
  });

  test('the legacy get_pdp recommendations drop graph cards without a public id or in another currency', async () => {
    const { server, baseUrl } = await startServer({ graph: 'leak' });
    try {
      const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'get_pdp', payload: { product: { merchant_id: MERCHANT_ID, product_id: PRODUCT_ID }, include: ['recommendations'] } }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain(GRAPH_SIG);
      expect(text).not.toContain('ext_leak_candidate');
      expect(text).not.toContain('JPY');
    } finally {
      await stopServer(server);
    }
  });

  test('a disabled graph surface is an empty rail labelled with its reason, never filler', async () => {
    const { server, baseUrl } = await startServer({ graphSurface: false });
    try {
      const { findResponse, findBody } = await bothSurfaces(baseUrl);
      expect(findResponse.status).toBe(200);
      expect(findBody.products).toEqual([]);
      expect(findBody.metadata).toMatchObject({ empty_reason: 'relationship_graph_surface_disabled', relationship_graph_enabled: false });
      expect(recommendCalls).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  });

  test('the graph read is anchored on the requested product', async () => {
    const { server, baseUrl } = await startServer();
    try {
      await bothSurfaces(baseUrl);
      expect(graphAnchors.length).toBeGreaterThan(0);
      for (const anchor of graphAnchors) expect(anchor).toEqual(expect.objectContaining({ product_id: PRODUCT_ID, merchant_id: MERCHANT_ID }));
    } finally {
      await stopServer(server);
    }
  });

  test('the kill switch (=false) restores graph + dynamic recall', async () => {
    const { server, baseUrl } = await startServer({ graphOnly: false });
    try {
      const { similarModule, findBody } = await bothSurfaces(baseUrl);
      expect(ids(similarModule.data.items)).toEqual([GRAPH_SIG, FILLER_SIG].sort());
      expect(ids(findBody.products)).toEqual([GRAPH_SIG, FILLER_SIG].sort());
      expect(recommendCalls.length).toBeGreaterThan(0);
    } finally {
      await stopServer(server);
    }
  });
});
