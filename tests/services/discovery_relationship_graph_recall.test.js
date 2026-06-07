const {
  _internals: {
    buildRelationshipGraphDiscoveryAnchors,
    loadRelationshipGraphDiscoveryCandidates,
    normalizeDiscoveryRequest,
  },
} = require('../../src/services/discoveryFeed');

describe('discovery relationship graph recall', () => {
  test('buildRelationshipGraphDiscoveryAnchors preserves external ids from recent views', () => {
    const request = normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      limit: 6,
      context: {
        recent_views: [
          {
            merchant_id: 'external_seed',
            product_id: 'sig_anchor',
            external_product_id: 'ext_anchor',
            source_product_id: 'ext_anchor',
            title: 'Anchor Serum',
            brand: 'Anchor Brand',
            category: 'Serum',
            product_type: 'Serum',
          },
        ],
      },
    });

    expect(buildRelationshipGraphDiscoveryAnchors(request)).toEqual([
      expect.objectContaining({
        product_id: 'sig_anchor',
        external_product_id: 'ext_anchor',
        source_product_id: 'ext_anchor',
        merchant_id: 'external_seed',
        title: 'Anchor Serum',
      }),
    ]);
  });

  test('loadRelationshipGraphDiscoveryCandidates maps graph recall into feed candidates', async () => {
    const request = normalizeDiscoveryRequest({
      surface: 'home_hot_deals',
      limit: 6,
      context: {
        recent_views: [
          {
            merchant_id: 'external_seed',
            product_id: 'ext_anchor',
            title: 'Anchor Serum',
            brand: 'Anchor Brand',
            category: 'Serum',
            product_type: 'Serum',
          },
        ],
      },
    });
    const recallFn = jest.fn(async ({ anchorProducts, surface, enabled }) => ({
      items: [
        {
          product_id: 'ext_candidate',
          external_product_id: 'ext_candidate',
          merchant_id: 'external_seed',
          title: 'Barrier Serum Alternative',
          brand: 'Candidate Brand',
          category: 'Serum',
          url: 'https://example.test/candidate',
          relationship_edge_id: 'edge_fixture',
          relationship_type: 'dupe',
          source: 'relationship_graph',
          x_score: 0.92,
        },
      ],
      metadata: {
        enabled,
        surface,
        anchor_ref_count: anchorProducts.length,
        edge_count: 1,
        item_count: 1,
      },
    }));

    const result = await loadRelationshipGraphDiscoveryCandidates({
      request,
      enabled: true,
      recallFn,
    });

    expect(recallFn).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'discovery_feed',
        enabled: true,
      }),
    );
    expect(result.products).toEqual([
      expect.objectContaining({
        product_id: 'ext_candidate',
        merchant_id: 'external_seed',
        __discovery_provider: 'relationship_graph',
        relationship_graph: expect.objectContaining({
          edge_id: 'edge_fixture',
          relationship_type: 'dupe',
        }),
      }),
    ]);
    expect(result.stats).toEqual(
      expect.objectContaining({
        enabled: true,
        attempted: true,
        anchor_count: 1,
        edge_count: 1,
        candidate_count: 1,
      }),
    );
    expect(result.recallSummary[0]).toEqual(
      expect.objectContaining({
        provider: 'relationship_graph',
        label: 'relationship_graph_recent_view',
        returned: 1,
      }),
    );
  });
});
