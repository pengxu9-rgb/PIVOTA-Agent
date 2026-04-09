const {
  buildCoverageCandidate,
  buildCoverageReviewPacket,
} = require('../src/services/pivotaInsightsCoverage');

describe('pivotaInsightsCoverage', () => {
  test('builds a coverage candidate with shopping and search card payloads', () => {
    const candidate = buildCoverageCandidate({
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo_1',
      },
      productGroupId: 'pg:pid:ext_demo_1',
      product: {
        brand: 'Naturium',
        title: 'Vitamin C Super Serum Plus',
        category: 'Skincare/Serum',
        review_summary: {
          rating: 4.7,
          review_count: 228,
        },
      },
      productIntel: {
        evidence_profile: 'seller_only',
        quality_state: 'limited',
        product_intel_core: {
          what_it_is: {
            body: 'A multi-active treatment serum that targets tone and texture.',
          },
          routine_fit: {
            step: 'serum',
          },
          why_it_stands_out: [
            {
              headline: 'Multi-active formula',
              body: 'Combines multiple treatment functions in one serum step.',
            },
          ],
        },
      },
    });

    expect(candidate.shopping_card).toEqual(
      expect.objectContaining({
        contract_version: 'pivota.shopping_card.v1',
        title: 'Naturium Vitamin C Super Serum Plus',
        subtitle: 'Multi-Active Serum',
        proof_badge: '4.7★ (228)',
      }),
    );
    expect(candidate.search_card).toEqual(
      expect.objectContaining({
        title_candidate: 'Naturium Vitamin C Super Serum Plus',
        compact_candidate: 'Multi-Active Serum',
        proof_badge_candidate: '4.7★ (228)',
      }),
    );
  });

  test('builds a review packet from coverage candidates', () => {
    const packet = buildCoverageReviewPacket([
      {
        case_id: 'coverage_ext_demo_1',
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_demo_1',
        },
        selected_mode: 'service_draft',
        evidence_profile: 'seller_only',
        quality_state: 'limited',
        shopping_card: {
          title: 'Naturium Vitamin C Super Serum Plus',
          subtitle: 'Multi-Active Serum',
          proof_badge: '',
        },
        pivota_insights: {
          what_it_is: 'A multi-active treatment serum that targets tone and texture.',
          why_it_stands_out: [
            {
              headline: 'Multi-active formula',
              body: 'Combines multiple treatment functions in one serum step.',
            },
          ],
        },
      },
    ]);

    expect(packet.meta.report_cases).toBe(1);
    expect(packet.rows[0]).toEqual(
      expect.objectContaining({
        case_id: 'coverage_ext_demo_1',
        review_status: 'pending',
        decision: 'pending',
        shopping_card: expect.objectContaining({
          title: 'Naturium Vitamin C Super Serum Plus',
          subtitle: 'Multi-Active Serum',
        }),
      }),
    );
  });
});
