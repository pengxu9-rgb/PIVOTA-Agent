// Relationship-graph cards must reach the similar surfaces with production-shaped data.
//
// Prod 2026-10-08 (read-only census + live debug on gateway c80daa230): 7,364 of 9,478 servable edges
// are external-seed -> external-seed; their 1,499 candidates each have exactly one live catalog row,
// but under an ADR-009 observed seller (0 of 27,655 external-seed catalog rows are still under the
// sentinel merchant). The sentinel-keyed public-id lookup resolved none, so the public filter dropped
// every graph card (Fibre 7->0, Shampoo 4->0, Ordinary 12->0, Missha 1->0). Candidate snapshots carry
// no image, no currency (85 of 4,770 priced ones do), and no platform/merchant/signature.
//
// The snapshots and catalog rows below are shaped like those rows; only the DB driver is mocked, so
// the real reader, projection, enrichment, filters and route run.

const ANCHOR = 'ext_7cb8f972973c76d5c73c6918';
const candidateId = (i) => `ext_00000000000000000000000${i}`;
const sigOf = (i) => `sig_${String(i).repeat(32)}`;
const NOW = Date.now();

function edgeRow(i, relationType) {
  return {
    id: `prel_rekey_${i}`,
    anchor_type: 'product',
    anchor_ref: `product:${ANCHOR}`,
    anchor_snapshot: { product_id: ANCHOR, name: 'Fibre 100ml - Barber', brand: 'Dear Barber', category: 'Hair Styling', price: '18' },
    candidate_product_ref: `product:${candidateId(i)}`,
    candidate_snapshot: {
      product_id: candidateId(i),
      product_ref: `product:${candidateId(i)}`,
      name: `Matte Clay Pomade ${i}`,
      brand: i % 2 ? 'Hanz de Fuko' : 'Baxter of California',
      category: 'Hair Styling',
      price: '39',
      url: `https://shop.example.test/products/pomade-${i}`,
      description: 'Strong hold matte finish hair clay.',
    },
    relation_type: relationType,
    display_label: null,
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: 'hair/styling',
    use_case: null,
    score_total: 0.8 - i / 100,
    score_breakdown: {},
    price_evidence: { candidate_price_amount: '39' },
    source_refs: [{ type: 'product_page', url: `https://shop.example.test/products/pomade-${i}` }],
    evidence_grade: 'B',
    review_status: 'approved',
    label_state: 'ai_approved',
    why_candidate: { summary: 'A distinct product option for the same shopper job; compare the supplied product facts.' },
    tradeoffs: [],
    watchouts: [],
    provenance: { source: 'ai_review' },
    last_verified_at: new Date(NOW - 864e5).toISOString(),
    expires_at: new Date(NOW + 30 * 864e5).toISOString(),
    created_at: new Date(NOW - 864e5).toISOString(),
    updated_at: new Date(NOW - 864e5).toISOString(),
  };
}

const seedRow = (id) => ({
  external_product_id: id,
  matched_signature_product_id: null,
  brand: 'Hanz de Fuko',
  category: 'Hair Styling',
  product_type: 'Pomade',
  title: `Matte Clay Pomade ${id.slice(-1)}`,
  image_url: `https://cdn.example.test/${id}.jpg`,
  price_amount: '39',
  price_currency: 'USD',
  pdp_description_raw: '',
  description: 'Strong hold matte finish hair clay.',
  pdp_details_sections: [],
});

const catalogRow = (id, overrides = {}) => ({
  merchant_id: 'merch_obs_0e4ea7ad6e6d9e43',
  platform: 'external_seed',
  source_product_id: id,
  product_key: `pk_${id}`,
  pivota_signature_id: sigOf(Number(id.slice(-1))),
  title: `Matte Clay Pomade ${id.slice(-1)}`,
  description: 'Strong hold matte finish hair clay.',
  brand: 'Hanz de Fuko',
  category: 'Hair Styling',
  product_type: 'Pomade',
  category_path: ['beauty', 'hair', 'styling'],
  image_url: `https://cdn.example.test/${id}.jpg`,
  canonical_url: `https://shop.example.test/products/pomade-${id.slice(-1)}`,
  product_payload: {},
  sync_status: 'live',
  ...overrides,
});

const state = { edges: [], catalog: (ids) => ids.map((id) => catalogRow(id)), render: () => [], recommend: null, sql: [] };
const defaultQuery = async (sql, params = []) => {
  const text = String(sql);
  state.sql.push({ text, params });
  if (text.includes('FROM product_relationship_edges')) {
    const wanted = Array.isArray(params[4]) ? params[4] : null;
    return { rows: state.edges.filter((edge) => !wanted || wanted.includes(edge.relation_type)) };
  }
  if (text.includes('similar_relationship_graph_renderability')) {
    if (state.render === 'throw') throw new Error('render read exploded');
    return { rows: state.render((params[0] || []).slice()) };
  }
  const ids = (params || []).flat().filter((value) => typeof value === 'string' && value.startsWith('ext_0000'));
  if (text.includes('FROM external_product_seeds') && !text.includes('pdp_identity_listing')) {
    return { rows: ids.map(seedRow) };
  }
  if (text.includes('FROM catalog_products') && text.includes('source_product_id = ANY')) {
    // Re-keyed data: no row is still under the sentinel merchant.
    if (/merchant_id = \$1/.test(text)) return { rows: [] };
    return { rows: state.catalog(ids) };
  }
  return { rows: [] };
};
const queryMock = jest.fn(defaultQuery);

let app;
let request;
let relationshipGraph;
let recall;
const ENV_KEYS = [
  'API_MODE', 'PIVOTA_API_BASE', 'PIVOTA_API_KEY', 'DATABASE_URL',
  'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED', 'AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES',
];
const savedEnv = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  jest.resetModules();
  Object.assign(process.env, {
    API_MODE: 'REAL',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'offline-fixture',
    DATABASE_URL: 'postgres://offline-fixture',
    AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED: 'true',
  });
  delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES;
  jest.doMock('../src/db', () => ({ ...jest.requireActual('../src/db'), query: (...args) => queryMock(...args) }));
  jest.doMock('../src/services/RecommendationEngine', () => ({
    ...jest.requireActual('../src/services/RecommendationEngine'),
    recommend: jest.fn(async (...args) => (state.recommend ? state.recommend(...args) : { items: [], metadata: { similar_status: 'empty' } })),
    hydrateRecommendationItemsWithReviewedProductIntel: jest.fn(async (items) => ({ items, stats: {} })),
  }));
  app = require('../src/server');
  request = require('supertest');
  relationshipGraph = require('../src/auroraBff/productRelationshipGraph');
  recall = require('../src/services/relationshipGraphRecall');
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.dontMock('../src/db');
  jest.dontMock('../src/services/RecommendationEngine');
});

beforeEach(() => {
  state.edges = [
    edgeRow(1, 'related_product'),
    edgeRow(2, 'competitive_alternative'),
    edgeRow(3, 'competitive_alternative'),
    edgeRow(4, 'competitive_alternative'),
    edgeRow(5, 'niche_specialist'),
  ];
  state.catalog = (ids) => ids.map((id) => catalogRow(id));
  state.render = () => [];
  state.recommend = null;
  state.sql = [];
  delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES;
});

async function findSimilar() {
  const res = await request(app)
    .post('/agent/shop/v1/invoke')
    .send({
      operation: 'find_similar_products',
      payload: { product_id: ANCHOR, limit: 12, options: { cache_bypass: true } },
      metadata: { market: 'US' },
    })
    .expect(200);
  return res.body;
}

describe('find_similar_products serves re-keyed external-seed graph candidates', () => {
  test('prod-shaped candidates resolve to their observed seller and public signature, priced as a pair', async () => {
    const body = await findSimilar();
    const graphCards = body.products.filter((product) => product.relationship_edge_id);
    expect(graphCards.map((card) => card.relationship_edge_id).sort()).toEqual([
      'prel_rekey_2', 'prel_rekey_3', 'prel_rekey_4', 'prel_rekey_5',
    ]);
    for (const card of graphCards) {
      expect(card.product_id).toMatch(/^sig_\d{32}$/);
      // The public card is keyed by signature; the observed seller travels as provenance.
      expect(card.source_provenance).toMatchObject({ merchant_id: 'merch_obs_0e4ea7ad6e6d9e43', platform: 'external_seed' });
      expect(card.image_url).toMatch(/^https:\/\/cdn\.example\.test\//);
      expect(readMoney(card)).toEqual({ amount: 39, currency: 'USD' });
    }
    expect(body.metadata.relationship_graph_served_count).toBe(4);
    expect(body.metadata.public_external_id_filtered_count).toBe(0);
  });

  test('the public-id lookup is keyed by the seed platform, never the sentinel merchant', async () => {
    await findSimilar();
    const lookup = state.sql.find(({ text }) => text.includes('FROM catalog_products') && text.includes('source_product_id = ANY'));
    expect(lookup.text).not.toMatch(/merchant_id = \$1/);
    expect(lookup.text).toMatch(/WHERE platform = \$1/);
    expect(lookup.params[0]).toBe('external_seed');
  });

  test('a source id listed under two signatures resolves to neither and is filtered', async () => {
    state.catalog = (ids) => ids.flatMap((id) => (id === candidateId(2)
      ? [catalogRow(id), catalogRow(id, { merchant_id: 'merch_obs_other', pivota_signature_id: sigOf(9) })]
      : [catalogRow(id)]));
    const body = await findSimilar();
    const served = body.products.filter((product) => product.relationship_edge_id).map((card) => card.relationship_edge_id);
    expect(served).not.toContain('prel_rekey_2');
    expect(served).toEqual(expect.arrayContaining(['prel_rekey_3', 'prel_rekey_4', 'prel_rekey_5']));
    expect(body.metadata.public_external_id_filtered_count).toBe(1);
  });

  test('related_product is held from the similar surfaces by default and served when configured', async () => {
    let body = await findSimilar();
    expect(body.products.map((product) => product.relationship_edge_id)).not.toContain('prel_rekey_1');
    const read = state.sql.find(({ text }) => text.includes('FROM product_relationship_edges'));
    expect(read.params[4]).toEqual(['dupe', 'competitive_alternative', 'niche_specialist']);

    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES = 'competitive_alternative,related_product';
    state.sql = [];
    body = await findSimilar();
    const served = body.products.map((product) => product.relationship_edge_id);
    expect(served).toContain('prel_rekey_1');
    expect(served).not.toContain('prel_rekey_5');
  });

  test('a dynamic-recall failure no longer hides the graph, but stays visible and keeps its 503', async () => {
    state.recommend = async () => { throw new Error('recall exploded'); };
    const body = await findSimilar();
    expect(body.products.filter((product) => product.relationship_edge_id)).toHaveLength(4);
    expect(body.metadata.dynamic_recall_failed).toBe(true);

    const send = () => request(app).post('/agent/shop/v1/invoke').send({ operation: 'find_similar_products',
      payload: { product_id: ANCHOR, limit: 12, options: { cache_bypass: true } }, metadata: { market: 'US' } });
    state.edges = [];
    let res = await send();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('SIMILAR_MAINLINE_UNAVAILABLE');

    // Graph items that all fail the public filter are not an answer either.
    state.edges = [edgeRow(2, 'competitive_alternative')];
    state.catalog = () => [];
    res = await send();
    expect(res.status).toBe(503);
  });

  test('the dedupe step re-raises a recall failure when the graph has nothing to serve', async () => {
    state.recommend = async () => { throw new Error('recall exploded'); };
    state.edges = [];
    await expect(app._debug.fetchSimilarProductsDeduped({
      pdp_product: { product_id: ANCHOR, merchant_id: 'external_seed', market: 'US' }, k: 12, cache_bypass: true,
    })).rejects.toThrow('recall exploded');
  });

  test('a human-approved dupe is served on the similar surfaces by default; an AI-approved one stays quarantined', async () => {
    state.edges = [{ ...edgeRow(3, 'dupe'), label_state: 'human_approved' }, edgeRow(4, 'dupe')];
    const body = await findSimilar();
    expect(body.products.map((product) => product.relationship_edge_id)).toEqual(['prel_rekey_3']);
  });

  test('an ambiguous source id never reaches the identity-listing fallback', async () => {
    state.catalog = (ids) => ids.flatMap((id) => (id === candidateId(2)
      ? [catalogRow(id), catalogRow(id, { merchant_id: 'merch_obs_other', pivota_signature_id: sigOf(9) })]
      : [catalogRow(id)]));
    queryMock.mockImplementation(async (sql, params = []) => {
      if (String(sql).includes('FROM pdp_identity_listing')) {
        state.sql.push({ text: String(sql), params });
        return { rows: [{ product_id: candidateId(2), sellable_item_group_id: sigOf(7) }] };
      }
      return defaultQuery(sql, params);
    });
    try {
      const body = await findSimilar();
      expect(body.products.map((product) => product.relationship_edge_id)).not.toContain('prel_rekey_2');
      const fallback = state.sql.filter(({ text }) => text.includes('FROM pdp_identity_listing'));
      for (const call of fallback) expect(JSON.stringify(call.params)).not.toContain(candidateId(2));
    } finally {
      queryMock.mockImplementation(defaultQuery);
    }
  });

  test('an archived listing under another signature does not make a live listing ambiguous', async () => {
    state.catalog = (ids) => ids.flatMap((id) => (id === candidateId(2)
      ? [catalogRow(id), catalogRow(id, { merchant_id: 'merch_obs_old', pivota_signature_id: sigOf(9), sync_status: 'archived' })]
      : [catalogRow(id)]));
    const body = await findSimilar();
    const card = body.products.find((product) => product.relationship_edge_id === 'prel_rekey_2');
    expect(card.product_id).toBe(sigOf(2));
  });
});

function readMoney(card) {
  const amount = typeof card.price === 'object' && card.price ? Number(card.price.amount) : Number(card.price);
  const currency = card.currency || card.price?.currency;
  return { amount, currency };
}

describe('graph card money is one record\'s amount and currency', () => {
  const edge = (overrides = {}) => ({ ...edgeRow(2, 'competitive_alternative'), ...overrides });

  test('a bare evidence or snapshot amount projects no price', () => {
    const card = relationshipGraph.relationshipEdgeToSimilarItem(edge());
    expect(card.price).toBeUndefined();
    expect(card.currency).toBeUndefined();
  });

  test('evidence with its own currency, or a snapshot price object, projects the pair', () => {
    expect(relationshipGraph.relationshipEdgeToSimilarItem(edge({
      price_evidence: { candidate_price_amount: 24, candidate_price_currency: 'usd' },
    }))).toMatchObject({ price: 24, currency: 'USD' });
    expect(relationshipGraph.relationshipEdgeToSimilarItem(edge({
      price_evidence: {},
      candidate_snapshot: { ...edgeRow(2).candidate_snapshot, price: { amount: 17, currency: 'EUR' } },
    }))).toMatchObject({ price: 17, currency: 'EUR' });
  });

  test('an evidence amount borrows a snapshot currency only when the snapshot quotes the same amount', () => {
    const snapshot = { ...edgeRow(2).candidate_snapshot, price: 30, currency: 'USD' };
    expect(relationshipGraph.relationshipEdgeToSimilarItem(edge({
      price_evidence: { candidate_price_amount: 30 }, candidate_snapshot: snapshot,
    }))).toMatchObject({ price: 30, currency: 'USD' });
    const mismatch = relationshipGraph.relationshipEdgeToSimilarItem(edge({
      price_evidence: { candidate_price_amount: 20 }, candidate_snapshot: snapshot,
    }));
    expect(mismatch.price).toBeUndefined();
  });

  test('a collapsed edge prices from its display snapshot only as a pair', () => {
    const collapsed = edge({
      price_evidence: {},
      candidate_snapshot: { ...edgeRow(2).candidate_snapshot, price: undefined },
      candidate_family_key: 'family:pomade',
      candidate_display_snapshot: { product_id: candidateId(2), name: 'Matte Clay Pomade', price: { amount: 41, currency: 'USD' } },
    });
    expect(relationshipGraph.relationshipEdgeToSimilarItem(collapsed)).toMatchObject({ price: 41, currency: 'USD' });
    const bare = edge({ ...collapsed, candidate_display_snapshot: { product_id: candidateId(2), name: 'Matte Clay Pomade', price: 41 } });
    expect(relationshipGraph.relationshipEdgeToSimilarItem(bare).price).toBeUndefined();
  });

  test('non-positive amounts project nothing', () => {
    for (const amount of [0, '0.00', -5]) {
      const card = relationshipGraph.relationshipEdgeToSimilarItem(edge({
        price_evidence: { candidate_price_amount: amount, candidate_price_currency: 'USD' },
      }));
      expect(card.price).toBeUndefined();
    }
  });

  test('enrichment copies a complete pair whole and never completes half of one', () => {
    const { mergeSimilarCardEnrichment } = app._debug;
    const graphCard = { product_id: 'ext_x', source: 'relationship_graph', relationship_edge_id: 'e', price: 20 };
    expect(mergeSimilarCardEnrichment(graphCard, { price: { amount: 25, currency: 'USD' } }))
      .toMatchObject({ price: { amount: 25, currency: 'USD' }, currency: 'USD' });
    const unpaired = mergeSimilarCardEnrichment(graphCard, { price: 25 });
    expect(unpaired.price).toBeUndefined();
    expect(unpaired.currency).toBeUndefined();
    expect(mergeSimilarCardEnrichment(graphCard, { currency: 'USD' }).currency).toBeUndefined();

    const heuristic = { product_id: 'sig_h', price: 10, currency: 'USD' };
    expect(mergeSimilarCardEnrichment(heuristic, { price: { amount: 99, currency: 'EUR' } }))
      .toMatchObject({ price: 10, currency: 'USD' });
  });

  test('ambiguous comma amounts are not amounts; grouped thousands are', () => {
    const { readSimilarCardMoneyPair } = app._debug;
    expect(readSimilarCardMoneyPair({ price: '12,50', currency: 'EUR' })).toBeNull();
    expect(readSimilarCardMoneyPair({ price: '1,234.56', currency: 'USD' })).toEqual({ amount: 1234.56, currency: 'USD' });
    expect(readSimilarCardMoneyPair({ price: { amount: 0, currency: 'USD' } })).toBeNull();
    expect(readSimilarCardMoneyPair({ price: 9, currency: '$' })).toBeNull();
  });

  test('a seed with a blank currency is unpriced, not USD', async () => {
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ ...seedRow(candidateId(1)), price_amount: '20', price_currency: '' }],
    }));
    const sources = await app._debug.fetchExternalSeedSimilarCardSourcesFromDb([candidateId(1)]);
    expect(sources.get(candidateId(1)).price).toBeNull();
  });
});

describe('graph cards whose product page will not render are withheld', () => {
  // Rows shaped like the renderability query: the PDP's own inputs, read live.
  const gateRow = (sig, overrides = {}) => ({
    pivota_signature_id: sig, merchant_id: 'merch_obs_x', platform: 'external_seed', source_system: 'external_product_seeds_mirror_v1',
    source_product_id: 'ext_x', content_key: 'ck_x', product_key: 'pk_x', sync_status: 'live', pdp_lifecycle_stage: 'published',
    source_active: true, pdp_seed_route_ok: true, serving_eligible: true, blocker_code: null, blocker_detail: null,
    content_quality_score: 90, active_external_seed_source_match: true, mirror_seed_inactive: false, ...overrides,
  });
  const noUsOffer = { serving_eligible: false, blocker_code: 'no_us_offer' };
  const served = (body) => body.products.filter((product) => product.relationship_edge_id).map((card) => card.relationship_edge_id).sort();
  const all = ['prel_rekey_2', 'prel_rekey_3', 'prel_rekey_4', 'prel_rekey_5'];

  test('a signature with no row passing source, route and serving gate is withheld and counted', async () => {
    // Prod 2026-10-09: sig_69612c2d… / sig_e72d8709… (no_us_offer) answered PRODUCT_NOT_SERVABLE.
    state.render = () => [gateRow(sigOf(2), noUsOffer), gateRow(sigOf(3))];
    const body = await findSimilar();
    expect(served(body)).toEqual(['prel_rekey_3', 'prel_rekey_4', 'prel_rekey_5']);
    expect(body.metadata.relationship_graph_not_renderable_withheld_count).toBe(1);
    const read = state.sql.find(({ text }) => text.includes('similar_relationship_graph_renderability'));
    expect(read.params[0].sort()).toEqual([sigOf(2), sigOf(3), sigOf(4), sigOf(5)]);
  });

  test.each([
    ['no resolvable content route (sampled PDPs answered 410)', { pdp_seed_route_ok: false }],
    ['an excluded catalog source', { source_active: false }],
    ['an inactive mirror seed (its content route does not resolve)', { pdp_seed_route_ok: false, active_external_seed_source_match: false }],
    ['a shopify row (no measured route)', { platform: 'shopify', source_system: 'shopify', source_product_id: '8123' }],
  ])('%s is withheld', async (_label, overrides) => {
    state.render = () => [gateRow(sigOf(2), overrides)];
    expect(served(await findSimilar())).toEqual(['prel_rekey_3', 'prel_rekey_4', 'prel_rekey_5']);
  });

  test.each([
    ['the newest active-source row is refused (an older one renders)', () => [
      gateRow(sigOf(2), { updated_at: '2026-09-01T00:00:00Z' }), gateRow(sigOf(2), { ...noUsOffer, updated_at: '2026-10-01T00:00:00Z' })]],
    ['the mirror row get_pdp_v2 picks is refused although a newer minted row passes', () => [
      gateRow(sigOf(2), { ...noUsOffer, updated_at: '2026-09-01T00:00:00Z' }),
      gateRow(sigOf(2), { source_system: 'catalog_enrichment_agent_v1', updated_at: '2026-10-01T00:00:00Z' })]],
  ])('%s: the card follows the row get_pdp_v2 judges', async (_label, render) => {
    state.render = render;
    expect(served(await findSimilar())).toEqual(['prel_rekey_3', 'prel_rekey_4', 'prel_rekey_5']);
  });

  test.each([
    ['the newest active-source row renders (an older one is refused)', () => [
      gateRow(sigOf(2), { ...noUsOffer, updated_at: '2026-09-01T00:00:00Z' }), gateRow(sigOf(2), { updated_at: '2026-10-01T00:00:00Z' })]],
    ['an inactive-source row is skipped by the pick', () => [gateRow(sigOf(2), { source_active: false, updated_at: '2026-10-05T00:00:00Z' }),
      gateRow(sigOf(2), { updated_at: '2026-10-01T00:00:00Z' })]],
    ['a mirror row whose seed status is blank but whose route resolves', () => [gateRow(sigOf(2), { active_external_seed_source_match: false })]],
    ['the published-but-unscored override', () => [gateRow(sigOf(2), { serving_eligible: false, blocker_code: 'not_scored',
      blocker_detail: 'No quality snapshot found for this product', content_quality_score: null })]],
    ['no catalog row at all', () => []],
    ['a read error', 'throw'],
  ])('%s keeps the card', async (_label, render) => {
    state.render = render;
    const body = await findSimilar();
    expect(served(body)).toEqual(all);
    expect(body.metadata.relationship_graph_not_renderable_withheld_count).toBe(0);
  });

  test('only relationship-graph cards with a sig_ link are checked; heuristic and pg_ cards are untouched', async () => {
    const { hydrateVisibleSimilarProductSigIdsFromCatalog } = app._debug;
    state.render = () => [gateRow('sig_heuristic', noUsOffer), gateRow('sig_graph', noUsOffer)];
    state.sql = [];
    const heuristic = { product_id: 'sig_heuristic', pivota_signature_id: 'sig_heuristic', image_url: 'https://cdn.example.test/h.jpg', card_highlight: 'x' };
    const family = { product_id: 'pg_catalog_family', source: 'relationship_graph', relationship_edge_id: 'edge_pg', image_url: 'https://cdn.example.test/p.jpg' };
    const graph = { product_id: 'sig_graph', pivota_signature_id: 'sig_graph', source: 'relationship_graph', relationship_edge_id: 'edge_sig', image_url: 'https://cdn.example.test/g.jpg' };
    const out = await hydrateVisibleSimilarProductSigIdsFromCatalog([heuristic, family, graph], { bypassCache: true });
    const read = state.sql.find(({ text }) => text.includes('similar_relationship_graph_renderability'));
    expect(read.params[0]).toEqual(['sig_graph']);
    expect(out.find((p) => p.product_id === 'sig_graph').similar_render_status).toBe('not_renderable');
    expect(out.find((p) => p.product_id === 'sig_heuristic').similar_render_status).toBeUndefined();
    expect(out.find((p) => p.product_id === 'pg_catalog_family').similar_render_status).toBeUndefined();
    expect(app._debug.filterPublicVisibleSimilarProducts(out, { servingCurrency: 'USD' }).map((p) => p.product_id))
      .toEqual(['sig_heuristic', 'pg_catalog_family']);
  });
});

describe('presentation filter keeps reviewed graph cards', () => {
  test('four highlighted heuristic cards do not evict an imaged graph card without card copy', () => {
    const heuristic = [0, 1, 2, 3, 4].map((i) => ({
      product_id: `sig_h${i}`, image_url: 'https://cdn.example.test/h.jpg', card_highlight: 'A shampoo',
    }));
    const graph = { product_id: 'sig_g', image_url: 'https://cdn.example.test/g.jpg', source: 'relationship_graph', relationship_edge_id: 'edge_g' };
    const kept = app._debug.filterSimilarProductsWithCardHighlights([graph, ...heuristic], { baseProduct: {} });
    expect(kept.map((item) => item.product_id)).toContain('sig_g');
    // A graph card does not count toward the heuristic highlight threshold either (review R5).
    const mixed = [
      graph,
      ...[0, 1, 2].map((i) => ({ product_id: `sig_hl${i}`, image_url: 'https://cdn.example.test/h.jpg', card_highlight: 'A shampoo' })),
      ...[0, 1, 2, 3].map((i) => ({ product_id: `sig_img${i}`, image_url: 'https://cdn.example.test/i.jpg' })),
    ];
    expect(app._debug.filterSimilarProductsWithCardHighlights(mixed, { baseProduct: {} })).toHaveLength(8);
    // Highlighted graph cards must not lift the heuristic pool over the threshold.
    const highlightedGraph = [0, 1, 2].map((i) => ({ ...graph, product_id: `sig_g${i}`, relationship_edge_id: `edge_g${i}`, card_highlight: 'Reviewed' }));
    const heuristicMix = [
      { product_id: 'sig_hl', image_url: 'https://cdn.example.test/h.jpg', card_highlight: 'A shampoo' },
      ...[0, 1, 2].map((i) => ({ product_id: `sig_plain${i}`, image_url: 'https://cdn.example.test/i.jpg' })),
    ];
    expect(app._debug.filterSimilarProductsWithCardHighlights([...highlightedGraph, ...heuristicMix], { baseProduct: {} })).toHaveLength(7);
    const noImage = { ...graph, image_url: '' };
    expect(app._debug.filterSimilarProductsWithCardHighlights([noImage, ...heuristic], { baseProduct: {} })
      .map((item) => item.product_id)).not.toContain('sig_g');
  });
});

describe('group-sibling anchor expansion follows the seed lane', () => {
  test('the sibling lookup is keyed by platform, not the sentinel merchant', async () => {
    const calls = [];
    const refs = await relationshipGraph.expandAnchorRefsWithGroupSiblings(['product:ext_anchor'], {
      queryFn: async (sql, params) => {
        calls.push({ sql: String(sql), params });
        return { rows: [{ sibling: 'ext_sibling' }] };
      },
    });
    expect(calls[0].sql).not.toMatch(/merchant_id/);
    expect(calls[0].sql).toMatch(/LIMIT 100/);
    expect(calls[0].params).toEqual([['ext_anchor'], 'external_seed']);
    expect(refs).toEqual(expect.arrayContaining(['product:ext_sibling', 'ext_sibling']));
  });
});

describe('similar-surface relation allowlist', () => {
  test('defaults, override and explicit caller lists', () => {
    const { resolveServingRelationTypes } = recall;
    expect(resolveServingRelationTypes('pdp_similar', undefined, {})).toEqual(['dupe', 'competitive_alternative', 'niche_specialist']);
    expect(resolveServingRelationTypes('find_similar_products', undefined, {})).toEqual(['dupe', 'competitive_alternative', 'niche_specialist']);
    expect(resolveServingRelationTypes('pdp_similar', undefined, {
      AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES: 'related_product, bogus ,competitive_alternative',
    })).toEqual(['related_product', 'competitive_alternative']);
    expect(resolveServingRelationTypes('pdp_similar', ['dupe'], {})).toEqual(['dupe']);
    expect(resolveServingRelationTypes('discovery_feed', undefined, {})).toBeUndefined();
    expect(resolveServingRelationTypes('pdp_similar', undefined, {
      AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES: 'bogus',
    })).toEqual(['dupe', 'competitive_alternative', 'niche_specialist']);
  });
});
