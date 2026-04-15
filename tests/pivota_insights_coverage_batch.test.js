const { buildReviewPacket, parseArgs } = require('../scripts/pivota_insights_coverage_batch');

describe('pivota_insights_coverage_batch', () => {
  test('parses batch args with coverage defaults', () => {
    const args = parseArgs([
      'node',
      'script',
      '--limit',
      '40',
      '--skip-gemini',
      '--identity-beauty-only',
      '--identity-brands',
      'Naturium,Olehenriksen',
      '--identity-top-brands',
      '3',
      '--identity-per-brand-limit',
      '2',
      '--identity-min-source-rows',
      '4',
      '--identity-min-review-ratio',
      '0.5',
    ]);

    expect(args.surface).toBe('');
    expect(args.pages).toBe(0);
    expect(args.frontendPaths).toEqual(['/products']);
    expect(args.manualOverrides).toBe('scripts/fixtures/product_intel_manual_overrides.json');
    expect(args.coveredReviewMode).toBe('strict_human');
    expect(args.strictReview).toBe(true);
    expect(args.limit).toBe(40);
    expect(args.excludeCovered).toBe(true);
    expect(args.skipGemini).toBe(true);
    expect(args.model).toBe('gemini-3-flash-preview');
    expect(args.fetchSourceFacts).toBe(true);
    expect(args.fetchSourceReviews).toBe(false);
    expect(args.identityBeautyOnly).toBe(true);
    expect(args.identityBrands).toEqual(['Naturium', 'Olehenriksen']);
    expect(args.identityTopBrands).toBe(3);
    expect(args.identityPerBrandLimit).toBe(2);
    expect(args.identityMinSourceRows).toBe(4);
    expect(args.identityMinReviewRatio).toBe(0.5);
  });

  test('defaults identity per-brand limit to 3 when not provided', () => {
    const args = parseArgs(['node', 'script']);

    expect(args.identityPerBrandLimit).toBe(3);
  });

  test('parses explicit product ids for manual expansion batches', () => {
    const args = parseArgs([
      'node',
      'script',
      '--product-ids',
      'ext_a,ext_b,ext_c',
      '--product-refs',
      'merch_demo:sku_a',
      '--supplemental-product-refs',
      'merch_demo:sku_b',
    ]);

    expect(args.productIds).toEqual(['ext_a', 'ext_b', 'ext_c', 'merch_demo:sku_a']);
    expect(args.supplementalProductIds).toEqual(['merch_demo:sku_b']);
  });

  test('parses source page enrichment controls for strict coverage batches', () => {
    const args = parseArgs([
      'node',
      'script',
      '--fetch-source-reviews',
      '--no-fetch-source-facts',
    ]);

    expect(args.fetchSourceReviews).toBe(true);
    expect(args.fetchSourceFacts).toBe(false);
  });

  test('builds a pending review packet from compare rows', () => {
    const packet = buildReviewPacket({
      rows: [
        {
          case_id: 'live_ext_demo',
          selected: {
            selected_mode: 'manual_override',
            field_sources: {
              what_it_is: 'manual',
            },
            bundle: {
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_demo',
              },
              evidence_profile: 'seller_only',
              quality_state: 'limited',
              shopping_card: {
                title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
                subtitle: 'Vitamin C + retinol serum',
                highlight: 'Five actives in one serum step',
                proof_badge: '',
              },
              search_card: {
                compact_candidate: 'Vitamin C + retinol serum',
                highlight_candidate: 'Five actives in one serum step',
                intro_candidate: 'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.',
              },
              product_intel_core: {
                what_it_is: {
                  body: 'A multi-active treatment serum for tone and texture.',
                },
                why_it_stands_out: [
                  {
                    headline: 'Multi-active formula',
                    body: 'Combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid.',
                  },
                ],
              },
            },
          },
        },
      ],
    });

    expect(packet.meta.report_cases).toBe(1);
    expect(packet.rows[0]).toEqual({
      case_id: 'live_ext_demo',
      product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_demo',
      },
      review_status: 'pending',
      reviewer: '',
      reviewer_kind: '',
      reviewed_at: '',
      decision: 'pending',
      notes: '',
      selected_mode: 'manual_override',
      field_sources: {
        what_it_is: 'manual',
      },
      evidence_profile: 'seller_only',
      quality_state: 'limited',
      review_decision: 'pending',
      rejection_reason: '',
      external_highlight_preview: [],
      highlight_sources_summary: [],
      shopping_card: {
        title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
        subtitle: 'Vitamin C + retinol serum',
        highlight: 'Five actives in one serum step',
        proof_badge: '',
      },
      search_card: {
        compact_candidate: 'Vitamin C + retinol serum',
        highlight_candidate: 'Five actives in one serum step',
        intro_candidate: 'Multi-active serum with vitamin C, retinol, niacinamide, hyaluronic and salicylic acids.',
        proof_badge_candidate: '',
      },
      pivota_insights: {
        what_it_is: 'A multi-active treatment serum for tone and texture.',
        why_it_stands_out: [
          {
            headline: 'Multi-active formula',
            body: 'Combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid.',
          },
        ],
      },
    });
  });

  test('builds a completed review packet when selected bundle carries reviewed override metadata', () => {
    const packet = buildReviewPacket({
      rows: [
        {
          case_id: 'reviewed_override_case',
          selected: {
            selected_mode: 'manual_override',
            field_sources: {
              what_it_is: 'manual',
            },
            bundle: {
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_reviewed',
              },
              evidence_profile: 'seller_only',
              quality_state: 'limited',
              provenance: {
                review_status: 'completed',
                review_decision: 'rewrite',
                reviewer: 'Codex',
                reviewer_kind: 'assistant',
                reviewed_at: '2026-04-15T14:10:00.000Z',
                external_highlight_review_status: 'rewrite',
              },
              product_intel_core: {
                what_it_is: {
                  body: 'A reviewed seller-grounded product-intel bundle.',
                },
              },
            },
          },
        },
      ],
    });

    expect(packet.meta.report_cases).toBe(1);
    expect(packet.meta.pending).toBe(0);
    expect(packet.rows[0]).toMatchObject({
      case_id: 'reviewed_override_case',
      review_status: 'completed',
      review_decision: 'rewrite',
      decision: 'rewrite',
      reviewer: 'Codex',
      reviewer_kind: 'assistant',
      reviewed_at: '2026-04-15T14:10:00.000Z',
      rejection_reason: '',
    });
  });

  test('rejects strict-review baseline_only rows', () => {
    const packet = buildReviewPacket({
      rows: [
        {
          case_id: 'strict_reject_case',
          selected: {
            selected_mode: 'baseline_only',
            bundle: {
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_reject',
              },
              evidence_profile: 'seller_only',
              quality_state: 'limited',
            },
          },
        },
      ],
    });

    expect(packet.meta.report_cases).toBe(1);
    expect(packet.meta.strict_review).toBe(true);
    expect(packet.meta.pending).toBe(0);
    expect(packet.rows[0]).toMatchObject({
      case_id: 'strict_reject_case',
      review_status: 'rejected',
      review_decision: 'reject',
      decision: 'reject',
      rejection_reason: 'Strict review policy requires non-baseline selected mode',
    });
  });
});
