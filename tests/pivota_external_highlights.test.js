const { buildProductIntelDraftBundle } = require('../src/pdpProductIntel');
const {
  applyExternalHighlightReviewDecision,
  augmentProductIntelWithHighlights,
  collectExternalHighlightSignals,
} = require('../src/services/pivotaExternalHighlights');
const {
  collectFromCases,
} = require('../scripts/collect_product_external_evidence_v1');
const {
  buildEvidenceBackedProduct,
  generateFromEvidenceReport,
} = require('../scripts/generate_product_intel_with_highlights_v1');
const {
  reviewGeneratedReport,
} = require('../scripts/review_product_intel_highlights_v1');

describe('pivota external highlights pipeline', () => {
  const caseRow = {
    case_id: 'coverage_ext_demo_1',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: 'ext_demo_1',
    },
    product: {
      merchant_id: 'external_seed',
      product_id: 'ext_demo_1',
      brand: 'Naturium',
      title: 'Vitamin C Super Serum Plus',
      category: 'Skincare/Serum',
      description: 'A multi-active treatment serum that targets tone and texture.',
      review_summary: {
        rating: 4.7,
        review_count: 228,
      },
      community_signals: {
        source_counts: {
          creator_mentions: 4,
        },
        top_loves: ['Lightweight finish under makeup'],
        top_complaints: ['Can feel active on compromised skin'],
      },
    },
  };

  test('collects surfaceable creator consensus signals from structured community evidence', () => {
    const collected = collectExternalHighlightSignals({
      product: caseRow.product,
    });

    expect(collected.external_highlight_signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: 'creator_social_consensus',
          claim_text: 'Lightweight finish under makeup',
          surfaceable: true,
        }),
        expect.objectContaining({
          claim_type: 'watchout',
          claim_text: 'Can feel active on compromised skin',
        }),
      ]),
    );
  });

  test('augments bundle with external highlights without rewriting what_it_is', () => {
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    const collected = collectExternalHighlightSignals({
      product: caseRow.product,
    });

    const generated = augmentProductIntelWithHighlights({
      baseBundle: baseline,
      product: caseRow.product,
      externalHighlightSignals: collected.external_highlight_signals,
      evidenceModel: 'external_highlight_pipeline_v1',
    });

    expect(generated.product_intel_core.what_it_is.body).toBe(
      baseline.product_intel_core.what_it_is.body,
    );
    expect(generated.product_intel_core.why_it_stands_out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidence_strength: 'external_highlight',
        }),
      ]),
    );
    expect(generated.shopping_card.highlight).toBeUndefined();
    expect(generated.search_card.highlight_candidate).toBeUndefined();
    expect(generated.provenance.external_highlight_review_status).toBe('pending');
  });

  test('does not expose incomplete card highlights from long claim text', () => {
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const generatedWithoutSurfaceText = augmentProductIntelWithHighlights({
      baseBundle: baseline,
      product: caseRow.product,
      externalHighlightSignals: [
        {
          signal_id: 'long_claim_without_surface_text',
          source_type: 'verified_reviews',
          claim_type: 'card_hook',
          claim_text:
            'Reviewers often describe it as a quick-absorbing serum that feels lightweight instead of sticky.',
          rating_summary: {
            rating: 4.7,
            review_count: 228,
          },
          evidence_strength: 'strong',
          independence_count: 228,
        },
      ],
    });

    expect(generatedWithoutSurfaceText.shopping_card.highlight).toBeUndefined();
    expect(generatedWithoutSurfaceText.search_card.highlight_candidate).toBeUndefined();

    const generatedWithSurfaceText = augmentProductIntelWithHighlights({
      baseBundle: baseline,
      product: caseRow.product,
      externalHighlightSignals: [
        {
          signal_id: 'long_claim_with_surface_text',
          source_type: 'verified_reviews',
          claim_type: 'card_hook',
          claim_text:
            'Reviewers often describe it as a quick-absorbing serum that feels lightweight instead of sticky.',
          surface_text: 'Reviewers: quick, non-sticky finish',
          rating_summary: {
            rating: 4.7,
            review_count: 228,
          },
          evidence_strength: 'strong',
          independence_count: 228,
        },
      ],
    });

    expect(generatedWithSurfaceText.shopping_card.highlight).toBeUndefined();
    expect(generatedWithSurfaceText.search_card.highlight_candidate).toBeUndefined();
  });

  test('reject_external strips visible external highlights back out of the bundle', () => {
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    const collected = collectExternalHighlightSignals({
      product: caseRow.product,
    });
    const generated = augmentProductIntelWithHighlights({
      baseBundle: baseline,
      product: caseRow.product,
      externalHighlightSignals: collected.external_highlight_signals,
    });

    const reviewed = applyExternalHighlightReviewDecision({
      bundle: generated,
      product: caseRow.product,
      decision: 'reject_external',
      reviewBatch: 'batch_a',
    });

    expect(reviewed.external_highlight_signals).toEqual([]);
    expect(reviewed.shopping_card.highlight).toBeUndefined();
    expect(reviewed.search_card.highlight_candidate).toBeUndefined();
    expect(reviewed.provenance.external_highlight_review_status).toBe('reject_external');
  });

  test('collect/generate/review scripts preserve the publish-ready review contract', () => {
    const evidenceReport = collectFromCases([caseRow]);
    const generatedReport = generateFromEvidenceReport([caseRow], evidenceReport, 'external_highlight_pipeline_v1');
    const reviewedReport = reviewGeneratedReport(
      generatedReport,
      {
        coverage_ext_demo_1: {
          review_decision: 'rewrite',
          notes: 'tighten card highlight',
          rewrite: {
            shopping_card: {
              highlight: 'Creator-loved lightweight finish',
            },
            search_card: {
              highlight_candidate: 'Creator-loved lightweight finish',
            },
          },
        },
      },
      'batch_demo',
    );

    expect(reviewedReport.rows[0]).toEqual(
      expect.objectContaining({
        review_decision: 'rewrite',
        selected: expect.objectContaining({
          selected_mode: 'external_highlight_rewrite',
        }),
        highlight_sources_summary: expect.any(Array),
      }),
    );
    expect(reviewedReport.rows[0].selected.bundle.shopping_card.highlight).toBe(
      'Creator-loved lightweight finish',
    );
    expect(reviewedReport.rows[0].selected.bundle.provenance.external_review_batch).toBe(
      'batch_demo',
    );
  });

  test('generation merges proof-layer evidence from raw evidence packs into the bundle', () => {
    const evidenceRow = {
      case_id: 'coverage_ext_demo_1',
      raw_evidence_pack: {
        review_summary: {
          rating: 4.8,
          review_count: 412,
        },
        market_signal_badges: [
          {
            badge_type: 'review_signal',
            badge_label: '4.8★ (412)',
            review_summary: {
              rating: 4.8,
              review_count: 412,
            },
          },
        ],
      },
      external_highlight_signals: [
        {
          signal_id: 'verified_reviews_1',
          source_type: 'verified_reviews',
          claim_type: 'card_hook',
          claim_text: 'Reviewers repeatedly call out the lightweight finish under makeup.',
          rating_summary: {
            rating: 4.8,
            review_count: 412,
          },
          evidence_strength: 'strong',
          sponsorship_status: 'unknown',
          independence_count: 412,
        },
      ],
    };

    expect(buildEvidenceBackedProduct({ ...caseRow.product, review_summary: null }, evidenceRow)).toEqual(
      expect.objectContaining({
        review_summary: {
          rating: 4.8,
          review_count: 412,
        },
        market_signal_badges: [
          expect.objectContaining({
            badge_type: 'review_signal',
            badge_label: '4.8★ (412)',
          }),
        ],
      }),
    );

    const generatedReport = generateFromEvidenceReport(
      [{ ...caseRow, product: { ...caseRow.product, review_summary: null, market_signal_badges: undefined } }],
      { rows: [evidenceRow] },
      'external_highlight_pipeline_v1',
    );
    const generatedBundle = generatedReport.rows[0].generated.bundle;

    expect(generatedBundle.review_summary).toEqual({
      rating: 4.8,
      review_count: 412,
    });
    expect(generatedBundle.shopping_card.proof_badge).toBe('4.8★ (412)');
    expect(generatedBundle.search_card.proof_badge_candidate).toBe('4.8★ (412)');
  });
});
