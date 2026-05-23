const {
  buildContentRepairReport,
  buildContentRepairRow,
  cleanSourceText,
  isMultiItemText,
} = require('../../scripts/build_protected_insight_content_repair_report');
const {
  classifyProductIntelKbRow,
} = require('../../src/services/externalSeedPdpReadiness');
const { hasCommerceTruthClaim } = require('../../src/services/pivotaInsightsQuality');

function seedRow(overrides = {}) {
  return {
    external_product_id: 'ext_pixi_content_repair',
    title: 'Mini Hydrating Milky Mist',
    canonical_url: 'https://pixibeauty.com/products/mini-hydrating-milky-mist-30ml',
    destination_url: 'https://pixibeauty.com/products/mini-hydrating-milky-mist-30ml',
    seed_data: {
      description:
        'A deeply hydrating mist that provides an invisible layer of skin-soothers, making it the ultimate remedy for dry skin - now in travel-size.',
      snapshot: {
        review_summary: {
          rating: 4.89,
          scale: 5,
          review_count: 532,
          aggregation_scope: 'group',
        },
        pdp_details_sections: [
          {
            heading: 'Key Ingredients',
            body: '• Hyaluronic Acid helps to moisturize\n• Black Oat Extract contains valuable vitamins\n• B Vitamin Complex strengthens skin\nFull Ingredient List',
          },
          {
            heading: 'Details',
            body: '• This featherlight mist provides an instant surge of hydration with Hyaluronic Acid.\n• Suitable for all skin types\n• Paraben-free\n• Volume: 80 ml / 2.70 fl oz',
          },
        ],
        raw_ingredient_text_clean:
          '• Hyaluronic Acid helps to moisturize\n• Black Oat Extract contains valuable vitamins\n• B Vitamin Complex strengthens skin\nFull Ingredient List',
      },
    },
    ...overrides,
  };
}

function protectedBundle(overrides = {}) {
  return {
    contract_version: 'pivota.product_intel.v1',
    canonical_product_ref: {
      merchant_id: 'external_seed',
      product_id: 'ext_pixi_content_repair',
    },
    display_name: 'Pivota Insights',
    quality_state: 'eligible',
    evidence_profile: 'community_supported',
    product_intel_core: {
      display_name: 'Pivota Insights',
      quality_state: 'eligible',
      evidence_profile: 'community_supported',
      what_it_is: {
        headline: 'Facial mist',
        body: '• This featherlight mist provides an instant surge of hydration with Hyaluronic Acid. • Suitable for all skin types • Paraben-free • Volume: 80 ml / 2.70 fl oz.',
      },
      why_it_stands_out: [
        {
          headline: 'Formula angle',
          body: '• This featherlight mist provides an instant surge of hydration with Hyaluronic Acid.',
          evidence_strength: 'seller_grounded',
        },
      ],
      best_for: [{ tag: 'daytime_use', label: 'Daytime wear', confidence: 'high' }],
      routine_fit: {
        step: 'mist',
        am_pm: ['am', 'pm'],
        pairing_notes: ['Apply before moisturizer; follow with SPF if used in the morning.'],
      },
      watchouts: [],
      confidence: {
        overall: 'moderate',
        fields: {
          what_it_is: 'high',
          best_for: 'moderate',
          why_it_stands_out: 'moderate',
          routine_fit: 'moderate',
          watchouts: 'moderate',
        },
      },
      source_coverage: {
        seller: { available: true },
        reviews: { available: false, count: 0 },
      },
    },
    shopping_card: {
      contract_version: 'pivota.shopping_card.v1',
      title: 'PIXI BEAUTY Mini Hydrating Milky Mist',
      subtitle: 'Facial Mist',
      intro: '• This featherlight mist provides an instant surge of hydration with Hyaluronic Acid.',
      evidence_profile: 'seller_only',
    },
    search_card: {
      title_candidate: 'PIXI BEAUTY Mini Hydrating Milky Mist',
      compact_candidate: 'Facial Mist',
      intro_candidate: '• This featherlight mist provides an instant surge of hydration with Hyaluronic Acid.',
    },
    source_coverage: {
      seller: { available: true },
      reviews: { available: true, count: 532 },
    },
    community_signals: {
      status: 'unavailable',
      confidence: 'low',
      evidence_profile: 'seller_only',
      unavailable_reason: 'insufficient_feedback',
    },
    provenance: {
      source: 'product_intel_pilot_compare',
      generator: 'baseline_only',
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer: 'operator',
      reviewer_kind: 'human',
      review_tier: 'strict_human',
      reviewed_at: '2026-04-22T19:53:20.410Z',
      selection_strategy: 'baseline_first_gemini_guarded',
      external_highlight_review_status: 'rewrite',
    },
    ...overrides,
  };
}

function kbRow(bundle = protectedBundle()) {
  return {
    kb_key: 'product:ext_pixi_content_repair',
    source: 'aurora_product_intel_kb',
    source_meta: {},
    analysis: {
      product_intel_v1: bundle,
    },
  };
}

describe('protected insight content repair report', () => {
  test('cleans generic and commerce-like source fragments before publishing', () => {
    expect(cleanSourceText('Save 20% • Suitable for all skin types • Volume: 80 ml / 2.70 fl oz')).not.toMatch(
      /all skin types|Volume/i,
    );
    expect(isMultiItemText('Cleanser 15ml - Cleanser. Milky Tonic 40ml - Tonic. Lotion 15ml - Lotion.')).toBe(
      true,
    );
  });

  test('builds a public-quality protected repair without downgrading community evidence', () => {
    const row = buildContentRepairRow(seedRow(), kbRow(), {
      reviewer: 'codex_quality_reviewer',
      reviewedAt: '2026-05-23T17:30:00.000Z',
    });

    expect(row.skipped).toBeUndefined();
    expect(row.case_id).toBe('ext_pixi_content_repair');
    expect(row.reviewer_kind).toBe('assistant');
    expect(row.selected.selected_mode).toBe('protected_community_content_repair');
    expect(row.quality_improvement_review).toMatchObject({
      decision: 'approved_replacement',
      reviewer_kind: 'assistant',
      owner_delegated: true,
    });

    const bundle = row.selected.bundle;
    expect(bundle.evidence_profile).toBe('community_supported');
    expect(bundle.product_intel_core.evidence_profile).toBe('community_supported');
    expect(bundle.shopping_card.highlight).toBe('Hydrating facial mist');
    expect(bundle.search_card.highlight_candidate).toBe('Hydrating facial mist');
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/all skin types|Volume:/i);
    expect(bundle.product_intel_core.watchouts).toHaveLength(3);
    expect(bundle.review_summary).toMatchObject({
      rating: 4.89,
      review_count: 532,
      source: 'merchant_public_review_summary',
    });
    expect(bundle.community_signals).toMatchObject({
      status: 'available',
      evidence_profile: 'community_supported',
    });
    expect(hasCommerceTruthClaim(bundle)).toBe(false);

    const classification = classifyProductIntelKbRow(
      {
        kb_key: 'product:ext_pixi_content_repair',
        analysis: { product_intel_v1: bundle },
      },
      { productId: 'ext_pixi_content_repair' },
    );
    expect(classification.displayable).toBe(true);
    expect(classification.high_quality_ready).toBe(true);
    expect(classification.blocking_issues).toEqual([]);
  });

  test('repairs a single tonic row while ignoring kit-contaminated details', () => {
    const row = buildContentRepairRow(
      seedRow({
        title: 'Milky Tonic Mini Size',
        seed_data: {
          description:
            'Our most gentle tonic that balances and soothes even the most sensitive skin. Enriched with Jojoba Milk & Oat Extract.',
          snapshot: {
            review_summary: {
              rating: 5,
              scale: 5,
              review_count: 29,
            },
            pdp_details_sections: [
              {
                heading: 'Details',
                body: '• Hydrating Milky Cleanser 15ml - Rich cleanser.\n• Milky Tonic 40ml - Calming tonic.\n• Hydrating Milky Lotion 15ml - Moisture lotion.',
              },
            ],
          },
        },
      }),
      kbRow(
        protectedBundle({
          shopping_card: {
            contract_version: 'pivota.shopping_card.v1',
            title: 'PIXI BEAUTY Milky Tonic Mini Size',
            subtitle: 'Prep Or Toner Step',
            intro: '• Hydrating Milky Cleanser 15ml - Rich cleanser.',
          },
          search_card: {
            title_candidate: 'PIXI BEAUTY Milky Tonic Mini Size',
            compact_candidate: 'Prep Or Toner Step',
            intro_candidate: '• Hydrating Milky Cleanser 15ml - Rich cleanser.',
          },
        }),
      ),
      {
        reviewedAt: '2026-05-23T17:30:00.000Z',
      },
    );

    expect(row.skipped).toBeUndefined();
    expect(row.review_packet.multi_item_details_ignored).toBe(true);
    expect(row.selected.bundle.shopping_card.highlight).toBe('Milky toner step');
    expect(row.selected.bundle.product_intel_core.what_it_is.body).not.toMatch(/Cleanser 15ml|Lotion 15ml/);
  });

  test('skips non-protected seller-only rows and separates skipped rows in the report', () => {
    const sellerOnly = protectedBundle({
      evidence_profile: 'seller_only',
      product_intel_core: {
        ...protectedBundle().product_intel_core,
        evidence_profile: 'seller_only',
      },
    });
    const report = buildContentRepairReport(
      [seedRow(), seedRow({ external_product_id: 'ext_seller_only' })],
      [kbRow(), { ...kbRow(sellerOnly), kb_key: 'product:ext_seller_only' }],
      {
        reviewedAt: '2026-05-23T17:30:00.000Z',
      },
    );

    expect(report.rows).toHaveLength(1);
    expect(report.skipped_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          case_id: 'ext_seller_only',
          reason: 'not_community_supported:seller_only',
        }),
      ]),
    );
  });
});
