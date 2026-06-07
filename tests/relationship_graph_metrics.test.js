const {
  recordRelationshipGraphPostFilter,
  recordRelationshipGraphRecall,
  renderRelationshipGraphMetricsPrometheus,
  resetRelationshipGraphMetricsForTest,
} = require('../src/observability/relationshipGraphMetrics');

describe('relationship graph metrics', () => {
  beforeEach(() => {
    resetRelationshipGraphMetricsForTest();
  });

  afterEach(() => {
    resetRelationshipGraphMetricsForTest();
  });

  it('renders recall and post-filter metrics with surface/status labels', () => {
    recordRelationshipGraphRecall({
      surface: 'pdp_similar',
      status: 'success',
      latencyMs: 42,
      anchorRefCount: 3,
      edgeCount: 2,
      itemCount: 2,
    });
    recordRelationshipGraphPostFilter({
      surface: 'find_similar_products',
      status: 'empty',
      rawServedCount: 2,
      servedCount: 0,
      filteredCount: 2,
    });

    const metrics = renderRelationshipGraphMetricsPrometheus();

    expect(metrics).toContain(
      'relationship_graph_recall_requests_total{error="none",status="success",surface="pdp_similar"} 1',
    );
    expect(metrics).toContain(
      'relationship_graph_post_filter_total{error="none",status="empty",surface="find_similar_products"} 1',
    );
    expect(metrics).toContain(
      'relationship_graph_items_bucket{error="none",stage="filtered",status="empty",surface="find_similar_products",le="2"} 1',
    );
  });
});
