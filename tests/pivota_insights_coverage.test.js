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
        external_highlight_signals: [
          {
            signal_id: 'creator_1',
            source_type: 'creator_social_consensus',
            claim_type: 'card_hook',
            claim_text: 'Creators often point to the lightweight finish.',
            surface_text: 'Creators: lightweight finish',
            independence_count: 4,
            sponsorship_status: 'organic',
            evidence_strength: 'strong',
          },
        ],
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
    expect(candidate.shopping_card.highlight).toBeUndefined();
    expect(candidate.search_card.highlight_candidate).toBeUndefined();
    expect(candidate.external_highlight_preview).toEqual([
      expect.objectContaining({
        signal_id: 'creator_1',
        surfaceable: true,
      }),
    ]);
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
          subtitle: 'Vitamin C + retinol serum',
          highlight: 'Creators often point to the lightweight',
          proof_badge: '',
        },
        search_card: {
          compact_candidate: 'Vitamin C + retinol serum',
          highlight_candidate: 'Creators often point to the lightweight',
        },
        external_highlight_preview: [
          {
            signal_id: 'creator_1',
            source_type: 'creator_social_consensus',
            claim_type: 'card_hook',
            claim_text: 'Creators often point to the lightweight finish.',
            stance: 'positive',
            evidence_strength: 'strong',
            surfaceable: true,
            surface_targets: ['shopping_card_highlight', 'search_card_intro'],
          },
        ],
        highlight_sources_summary: [
          {
            signal_id: 'creator_1',
            source_type: 'creator_social_consensus',
            claim_type: 'card_hook',
            evidence_strength: 'strong',
            independence_count: 4,
            sponsorship_status: 'organic',
            surfaceable: true,
            source_labels: [],
          },
        ],
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
        review_decision: 'pending',
        shopping_card: expect.objectContaining({
          title: 'Naturium Vitamin C Super Serum Plus',
          subtitle: 'Vitamin C + retinol serum',
          highlight: 'Creators often point to the lightweight',
        }),
      }),
    );
  });
});
