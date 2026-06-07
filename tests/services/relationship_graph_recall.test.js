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
    });

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
