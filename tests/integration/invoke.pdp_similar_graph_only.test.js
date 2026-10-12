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
let graphAnchors = [];

async function startServer({ graph = 'items', graphOnly, graphSurface = true } = {}) {
  graphAnchors = [];
  jest.resetModules();
  nock.cleanAll();
  recommendCalls = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.API_MODE = 'REAL';
  process.env.PIVOTA_API_BASE = API_BASE;
  process.env.PIVOTA_API_KEY = 'ak_live_0000000000000000000000000000000000000000000000000000000000000000';
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED = graphSurface ? 'true' : 'false';
  if (graphOnly === undefined) delete process.env.PDP_SIMILAR_GRAPH_ONLY_ENABLED;
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
  test('by default only graph cards are served on both surfaces and dynamic recall is never called', async () => {
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
