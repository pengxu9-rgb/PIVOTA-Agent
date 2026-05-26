const {
  buildPublishPlan,
  parseDecisionRecordsText,
  publishReviewReport,
  stampApprovedEdge,
} = require('../../scripts/publish-product-relationship-graph-review');

const NOW = '2026-05-25T00:00:00.000Z';
const FUTURE = '2026-08-23T00:00:00.000Z';

function relationshipEdge(overrides = {}) {
  return {
    id: 'prel_fixture_1',
    anchor_type: 'product',
    anchor_ref: 'product:anchor_1',
    anchor_snapshot: {
      product_id: 'anchor_1',
      brand: 'Top Brand',
      name: 'Luxury Barrier Serum',
      category_taxonomy: ['skincare', 'serum'],
      price: 100,
    },
    candidate_product_ref: 'product:candidate_1',
    candidate_snapshot: {
      product_id: 'candidate_1',
      brand: 'Value Brand',
      name: 'Barrier Serum Alternative',
      category_taxonomy: ['skincare', 'serum'],
      price: 80,
      url: 'https://example.test/candidate',
    },
    relation_type: 'dupe',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare', 'serum'],
    use_case: 'barrier serum',
    score_total: 0.86,
    score_breakdown: {
      category_use_case_match: 0.91,
      ingredient_functional_similarity: 0.84,
      score_total: 0.86,
    },
    price_evidence: {
      anchor_price_amount: 100,
      candidate_price_amount: 80,
      price_ratio: 0.8,
      observed_at: NOW,
    },
    source_refs: [{ type: 'products_cache', authoritative: true }],
    evidence_grade: 'A',
    review_status: 'pending',
    why_candidate: {
      summary: 'Similar product type and function at a lower price.',
      reasons_user_visible: ['Category and price evidence are present.'],
    },
    tradeoffs: [],
    watchouts: [],
    provenance: {
      pipeline: 'product_relationship_graph_builder.v1',
      generated_at: NOW,
    },
    last_verified_at: null,
    expires_at: null,
    ...overrides,
  };
}

describe('publish-product-relationship-graph-review helpers', () => {
  test('parses JSON object decisions and JSONL decisions', () => {
    expect(
      parseDecisionRecordsText(
        JSON.stringify({
          decisions: [
            { edge_id: 'prel_fixture_1', decision: 'approved' },
            { edge_id: 'prel_fixture_2', decision: 'rejected' },
          ],
        }),
      ).map((row) => row.edge_id),
    ).toEqual(['prel_fixture_1', 'prel_fixture_2']);

    expect(
      parseDecisionRecordsText(
        [
          JSON.stringify({ edge_id: 'prel_fixture_1', decision: 'approved' }),
          JSON.stringify({ edge_id: 'prel_fixture_2', decision: 'hold' }),
        ].join('\n'),
      ).map((row) => row.decision),
    ).toEqual(['approved', 'hold']);
  });

  test('stamps approved decisions while preserving source refs and builder provenance', () => {
    const edge = relationshipEdge();
    const stamped = stampApprovedEdge(
      edge,
      {
        edge_id: edge.id,
        decision: 'approved',
        reviewer: 'human_reviewer',
        reviewed_at: NOW,
        last_verified_at: NOW,
        expires_at: FUTURE,
        reason: 'Manual review passed.',
      },
      { now: NOW },
    );

    expect(stamped.review_status).toBe('approved');
    expect(stamped.last_verified_at).toBe(NOW);
    expect(stamped.expires_at).toBe(FUTURE);
    expect(stamped.source_refs).toEqual(edge.source_refs);
    expect(stamped.provenance.pipeline).toBe('product_relationship_graph_builder.v1');
    expect(stamped.provenance.review_publish).toEqual(
      expect.objectContaining({
        contract_version: 'product_relationship_graph.review_publish.v1',
        reviewer: 'human_reviewer',
        reason: 'Manual review passed.',
      }),
    );
  });

  test('builds a dry-run plan for approved edges and skips rejected decisions', () => {
    const approved = relationshipEdge({ id: 'prel_approved' });
    const rejected = relationshipEdge({
      id: 'prel_rejected',
      candidate_product_ref: 'product:candidate_2',
      candidate_snapshot: {
        product_id: 'candidate_2',
        brand: 'Other Brand',
        name: 'Barrier Serum Other',
        category_taxonomy: ['skincare', 'serum'],
        price: 85,
      },
    });
    const plan = buildPublishPlan(
      { edges: [approved, rejected] },
      [
        {
          edge_id: 'prel_approved',
          decision: 'approved',
          reviewer: 'human_reviewer',
          last_verified_at: NOW,
          expires_at: FUTURE,
        },
        {
          edge_id: 'prel_rejected',
          decision: 'rejected',
          reviewer: 'human_reviewer',
        },
      ],
      { now: NOW },
    );

    expect(plan.summary).toEqual(
      expect.objectContaining({
        report_edges: 2,
        approved_decisions: 1,
        publishable: 1,
        published: 0,
        invalid: 0,
        skipped: 1,
        rejected_decisions: 1,
      }),
    );
    expect(plan.rows.map((row) => row.status)).toEqual(['publishable', 'skipped']);
    expect(plan.rows[0].edge.review_status).toBe('approved');
  });

  test('apply mode calls upsert only for publishable approved edges', async () => {
    const upsertFn = jest.fn(async (edge) => edge);
    const result = await publishReviewReport({
      report: {
        edges: [
          relationshipEdge({ id: 'prel_approved' }),
          relationshipEdge({ id: 'prel_skipped', candidate_product_ref: 'product:skip_1' }),
        ],
      },
      decisions: [
        {
          edge_id: 'prel_approved',
          decision: 'approved',
          reviewer: 'human_reviewer',
          last_verified_at: NOW,
          expires_at: FUTURE,
        },
      ],
      apply: true,
      upsertFn,
      now: NOW,
    });

    expect(upsertFn).toHaveBeenCalledTimes(1);
    expect(upsertFn.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        id: 'prel_approved',
        review_status: 'approved',
        last_verified_at: NOW,
        expires_at: FUTURE,
      }),
    );
    expect(result.summary).toEqual(
      expect.objectContaining({
        report_edges: 2,
        publishable: 1,
        published: 1,
        invalid: 0,
        skipped: 1,
      }),
    );
    expect(result.rows.map((row) => row.status)).toEqual(['published', 'skipped']);
  });

  test('approved decisions with invalid edges are rejected with validation reasons', () => {
    const invalid = relationshipEdge({
      candidate_snapshot: {
        product_id: 'candidate_1',
        brand: 'Top Brand',
        name: 'Same Brand Serum',
        category_taxonomy: ['skincare', 'serum'],
        price: 80,
      },
    });
    const plan = buildPublishPlan(
      { edges: [invalid] },
      [
        {
          edge_id: invalid.id,
          decision: 'approved',
          reviewer: 'human_reviewer',
          last_verified_at: NOW,
          expires_at: FUTURE,
        },
      ],
      { now: NOW },
    );

    expect(plan.summary.invalid).toBe(1);
    expect(plan.summary.publishable).toBe(0);
    expect(plan.rows[0]).toEqual(
      expect.objectContaining({
        status: 'invalid',
        reason: 'validation_failed',
        errors: expect.arrayContaining(['dupe_same_brand_blocked']),
      }),
    );
  });
});
