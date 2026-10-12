const {
  fetchRelationshipGraphRecallForAnchor,
  isRelationshipGraphSurfaceEnabled,
  mapRelationshipGraphItemToDiscoveryProduct,
  mergeRelationshipGraphRecallItems,
} = require('../../src/services/relationshipGraphRecall');

const NOW_ISO = '2026-06-07T00:00:00.000Z';
const FUTURE_ISO = '2026-07-22T00:00:00.000Z';

function approvedEdge(overrides = {}) {
  return {
    id: 'edge_fixture',
    anchor_type: 'product',
    anchor_ref: 'product:anchor_1',
    anchor_snapshot: { product_id: 'anchor_1', brand: 'Anchor Brand', name: 'Anchor Serum' },
    candidate_product_ref: 'product:candidate_1',
    candidate_snapshot: {
      product_id: 'candidate_1',
      brand: 'Candidate Brand',
      name: 'Barrier Serum Alternative',
      category: 'Serum',
      url: 'https://example.test/candidate',
      image_url: 'https://example.test/candidate.jpg',
      price: 22,
    },
    relation_type: 'dupe',
    display_label: 'budget alternative',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare', 'serum'],
    use_case: 'barrier support',
    score_total: 0.91,
    score_breakdown: {},
    price_evidence: {},
    source_refs: [{ type: 'relationship_graph_test' }],
    evidence_grade: 'A',
    review_status: 'approved',
    why_candidate: {},
    tradeoffs: [],
    watchouts: [],
    provenance: {},
    last_verified_at: NOW_ISO,
    expires_at: FUTURE_ISO,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

describe('relationshipGraphRecall', () => {
  test('surface flags preserve legacy PDP behavior and keep discovery separate', () => {
    expect(
      isRelationshipGraphSurfaceEnabled('pdp_similar', {
        AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(
      isRelationshipGraphSurfaceEnabled('discovery_feed', {
        AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED: 'true',
      }),
    ).toBe(false);
    expect(
      isRelationshipGraphSurfaceEnabled('discovery_feed', {
        AURORA_BFF_RELATIONSHIP_GRAPH_DISCOVERY_ENABLED: 'true',
      }),
    ).toBe(true);
    expect(
      isRelationshipGraphSurfaceEnabled('discovery_feed', {
        AURORA_BFF_RELATIONSHIP_GRAPH_DISCOVERY_ENABLED: 'false',
        AURORA_BFF_RELATIONSHIP_GRAPH_ALL_FEEDS_ENABLED: 'true',
      }),
    ).toBe(false);
  });

  test('fetchRelationshipGraphRecallForAnchor returns mapped graph items when enabled', async () => {
    const queryFn = jest.fn(async () => ({ rows: [approvedEdge()] }));

    const result = await fetchRelationshipGraphRecallForAnchor({
      anchorProduct: {
        product_id: 'anchor_1',
        brand: 'Anchor Brand',
        title: 'Anchor Serum',
      },
      surface: 'pdp_similar',
      market: 'US',
      enabled: true,
      queryFn,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(result.metadata).toEqual(
      expect.objectContaining({
        enabled: true,
        query_attempted: true,
        edge_count: 1,
        item_count: 1,
      }),
    );
    expect(result.items[0]).toMatchObject({
      product_id: 'candidate_1',
      merchant_id: 'external_seed',
      title: 'Barrier Serum Alternative',
      source: 'relationship_graph',
      recommendation_source: 'relationship_graph',
      relationship_type: 'dupe',
    });
  });

  test('mergeRelationshipGraphRecallItems keeps graph rows ahead of dynamic duplicates', () => {
    const merged = mergeRelationshipGraphRecallItems({
      graphItems: [
        { merchant_id: 'external_seed', product_id: 'candidate_1', source: 'relationship_graph' },
      ],
      dynamicItems: [
        { merchant_id: 'external_seed', product_id: 'candidate_1', source: 'dynamic' },
        { merchant_id: 'external_seed', product_id: 'candidate_2', source: 'dynamic' },
      ],
      limit: 5,
    });

    expect(merged).toEqual([
      { merchant_id: 'external_seed', product_id: 'candidate_1', source: 'relationship_graph' },
      { merchant_id: 'external_seed', product_id: 'candidate_2', source: 'dynamic' },
    ]);
  });

  test('mapRelationshipGraphItemToDiscoveryProduct emits feed-compatible candidate shape', () => {
    const product = mapRelationshipGraphItemToDiscoveryProduct({
      product_id: 'candidate_1',
      external_product_id: 'candidate_1',
      merchant_id: 'external_seed',
      title: 'Barrier Serum Alternative',
      brand: 'Candidate Brand',
      category: 'Serum',
      url: 'https://example.test/candidate',
      price: 22,
      relationship_edge_id: 'edge_fixture',
      relationship_type: 'dupe',
      x_score: 0.91,
      relationship_price_ref: 'ext_internal_seed',
    });
    // The internal similar-card price key never reaches the feed (it spreads candidates into responses).
    expect(product).not.toHaveProperty('relationship_price_ref');

    expect(product).toMatchObject({
      id: 'candidate_1',
      product_id: 'candidate_1',
      merchant_id: 'external_seed',
      title: 'Barrier Serum Alternative',
      product_type: 'Serum',
      source: 'relationship_graph',
      recommendation_source: 'relationship_graph',
      __discovery_provider: 'relationship_graph',
      relationship_graph: {
        edge_id: 'edge_fixture',
        relationship_type: 'dupe',
        score_total: 0.91,
      },
    });
  });
});

describe('a similar rail keeps at most one same-brand card, after every cross-brand card', () => {
  // Prod 2026-10-12: 743 of 7,116 served alternatives were the anchor's own brand; on 221 rails every
  // card was (Kose Clear Turn Collagen mask -> Kose Clear Turn Vitamin C mask).
  const {
    capSimilarSameBrandItems,
    orderSameBrandSimilarEdges,
    resolveSimilarSameBrandMax,
  } = require('../../src/services/relationshipGraphRecall');
  const anchorProduct = { product_id: 'anchor_1', brand: 'Kosé', title: 'Clear Turn Collagen Mask' };
  const altEdge = (i, brand, score) => approvedEdge({
    id: `edge_${i}`,
    relation_type: 'competitive_alternative',
    display_label: null,
    anchor_snapshot: { product_id: 'anchor_1', brand: 'Kosé', name: 'Clear Turn Collagen Mask' },
    candidate_product_ref: `product:candidate_${i}`,
    candidate_snapshot: { ...approvedEdge().candidate_snapshot, product_id: `candidate_${i}`, brand, name: `Sheet Mask ${i}`,
      url: `https://example.test/c${i}`, image_url: `https://example.test/c${i}.jpg` },
    score_total: score,
  });
  const rail = () => [
    altEdge(1, 'KOSE', 0.95),
    altEdge(2, 'Kosé', 0.94),
    altEdge(3, 'Mediheal', 0.9),
    altEdge(4, 'kose', 0.89),
    altEdge(5, 'Dr. Jart+', 0.85),
  ];
  const fetchRail = (rows, extra = {}) => {
    const queryFn = jest.fn(async () => ({ rows }));
    return fetchRelationshipGraphRecallForAnchor({ anchorProduct, surface: 'pdp_similar', market: 'US', enabled: true, queryFn, limit: 4, ...extra })
      .then((result) => ({ result, queryFn }));
  };
  const ids = (items) => items.map((item) => item.product_id);
  const savedMax = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX;
  afterEach(() => {
    if (savedMax === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX;
    else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX = savedMax;
  });

  test('recall puts cross-brand cards first (in score order) and tags the same-brand ones; it drops none', async () => {
    const { result } = await fetchRail(rail());
    // Rail of 4, plus a same-brand tail up to max + 2 same-brand cards in all (the serving fallback).
    expect(ids(result.items)).toEqual(['candidate_3', 'candidate_5', 'candidate_1', 'candidate_2', 'candidate_4']);
    expect(result.items.map((item) => item.similar_same_brand === true)).toEqual([false, false, true, true, true]);
    expect(result.metadata).toMatchObject({ edge_count: 5, item_count: 5, same_brand_max: 1, same_brand_read_count: 3 });
  });

  test('the serving cap keeps only the first same-brand card of what survived, and strips the tag', async () => {
    const { result } = await fetchRail(rail());
    const served = capSimilarSameBrandItems(result.items);
    expect(ids(served)).toEqual(['candidate_3', 'candidate_5', 'candidate_1']);
    expect(served.some((item) => 'similar_same_brand' in item)).toBe(false);
  });

  test('a kept same-brand card dropped downstream (dead PDP) leaves the next one, so the rail never empties (review)', async () => {
    const { result } = await fetchRail([altEdge(1, 'Kosé', 0.9), altEdge(2, 'Kosé', 0.8), altEdge(4, 'Kosé', 0.7)]);
    const survivors = result.items.filter((item) => item.product_id !== 'candidate_1');
    expect(ids(capSimilarSameBrandItems(survivors))).toEqual(['candidate_2']);
  });

  test('the read goes past the rail size so the cross-brand cards behind same-brand ones fill it', async () => {
    const { queryFn } = await fetchRail(rail());
    // limit 4 -> read 8 (the uncollapsed reader then over-reads x2 in SQL).
    expect(queryFn.mock.calls[0][1][3]).toBe(16);
    const big = await fetchRail(rail(), { limit: 100 });
    expect(big.queryFn.mock.calls[0][1][3]).toBe(240);
  });

  test('a full cross-brand rail still carries a short same-brand tail, the fallback if the cross-brand cards fail serving (review)', async () => {
    const many = Array.from({ length: 8 }, (_, i) => altEdge(i + 10, `Brand ${i}`, 0.9 - i / 100));
    const own = [1, 2, 4, 6].map((i) => altEdge(i, 'Kosé', 0.99 - i / 100));
    const { result } = await fetchRail([...own, ...many]);
    expect(ids(result.items)).toEqual(['candidate_10', 'candidate_11', 'candidate_12', 'candidate_13', 'candidate_1', 'candidate_2', 'candidate_4']);
    // Every cross-brand card dropped downstream: the best same-brand one is served.
    expect(ids(capSimilarSameBrandItems(result.items.filter((item) => item.similar_same_brand === true)))).toEqual(['candidate_1']);
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX = '0';
    expect((await fetchRail([...own, ...many])).result.items).toHaveLength(4);
  });

  test('the cap is tunable by env: 0 serves no same-brand card, a negative value turns ordering and cap off', async () => {
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX = '0';
    expect(ids(capSimilarSameBrandItems((await fetchRail(rail())).result.items))).toEqual(['candidate_3', 'candidate_5']);
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX = '-1';
    const off = await fetchRail(rail());
    expect(ids(capSimilarSameBrandItems(off.result.items))).toEqual(['candidate_1', 'candidate_2', 'candidate_3', 'candidate_4']);
    expect(off.result.metadata.same_brand_max).toBeUndefined();
    expect(off.queryFn.mock.calls[0][1][3]).toBe(8);
  });

  test('an unparseable env value keeps the default of one', () => {
    for (const value of [undefined, '', 'off', '1.5', 'two']) {
      expect(resolveSimilarSameBrandMax({ AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX: value })).toBe(1);
    }
    expect(resolveSimilarSameBrandMax({ AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX: '3' })).toBe(3);
    expect(resolveSimilarSameBrandMax({ AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX: '-1' })).toBe(Infinity);
  });

  test('sameBrandCap: false reads exactly as without the cap: no reorder, over-read, tail or tag', async () => {
    const { result, queryFn } = await fetchRail(rail(), { sameBrandCap: false });
    expect(ids(result.items)).toEqual(['candidate_1', 'candidate_2', 'candidate_3', 'candidate_4']);
    expect(result.items.some((item) => 'similar_same_brand' in item)).toBe(false);
    expect(result.metadata.same_brand_max).toBeUndefined();
    expect(queryFn.mock.calls[0][1][3]).toBe(8);
  });

  test('a non-similar surface is neither reordered nor tagged', async () => {
    const { result } = await fetchRail(rail(), { surface: 'chat_alternatives' });
    expect(ids(result.items)).toEqual(['candidate_1', 'candidate_2', 'candidate_3', 'candidate_4']);
    expect(result.items.some((item) => 'similar_same_brand' in item)).toBe(false);
    expect(result.metadata.same_brand_max).toBeUndefined();
  });

  test('untagged cards (cross-brand, dynamic recall) pass the serving cap untouched', () => {
    const card = { product_id: 'x' };
    expect(capSimilarSameBrandItems([card, null], 0)).toEqual([card, null]);
  });

  test('brand matching: case, accents, punctuation, a leading "The", non-Latin; the PDP anchor; the display member; never a vendor', () => {
    const edge = (candidate, anchorBrand = 'Other', extra = {}) => ({
      anchor_snapshot: { brand: anchorBrand }, candidate_snapshot: { brand: candidate }, ...extra,
    });
    const sameCount = (edges, anchor = {}) => orderSameBrandSimilarEdges(edges, { anchorProduct: anchor }).sameBrandEdges.size;
    expect(sameCount([edge('DR. JART+', 'Dr Jart')])).toBe(1);
    expect(sameCount([edge('Decorté', 'DECORTE')])).toBe(1);
    expect(sameCount([edge('The Ordinary', 'Ordinary')])).toBe(1);
    expect(sameCount([edge({ name: 'Kosé' })], { brand: 'KOSE' })).toBe(1);
    expect(sameCount([edge('', 'Other', { candidate_display_snapshot: { brand: 'Kose' } })], { brand: 'Kosé' })).toBe(1);
    expect(sameCount([edge('Mediheal', 'Kose')], { brand: 'Kose' })).toBe(0);
    // A non-Latin brand keeps its letters (an ASCII-only key would be empty and never match).
    expect(sameCount([edge('설화수', '설화수')])).toBe(1);
    expect(sameCount([edge('설화수', '라네즈')])).toBe(0);
    // Kana voicing is part of the name (ガ is not カ); only Latin accents fold.
    expect(sameCount([edge('ガロ', 'カロ')])).toBe(0);
    expect(sameCount([edge('ガロ', 'ｶﾞﾛ')])).toBe(1);
    // A vendor can be a multi-brand reseller: two vendor-only snapshots are not the same brand.
    expect(sameCount([{ anchor_snapshot: { vendor: 'Ulta' }, candidate_snapshot: { vendor: 'Ulta' } }])).toBe(0);
    expect(sameCount([edge('', '')], { brand: '' })).toBe(0);
  });
});
