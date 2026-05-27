const {
  buildContentRepairReport,
  buildContentRepairRow,
  classifyTitle,
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

  test('classifies targeted wrinkle treatments without resurfacing fallback', () => {
    expect(classifyTitle('Targeted Wrinkle Corrector')).toMatchObject({
      headline: 'Wrinkle treatment',
      highlight: 'Targeted wrinkle treatment',
    });
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

  test('repairs Fenty protected community rows without Pixi wording or generic product copy', () => {
    const row = buildContentRepairRow(
      seedRow({
        external_product_id: 'ext_fenty_water_boi',
        title: 'The Water Boi Reparative Leave-In Detangling Conditioner Spray',
        canonical_url: 'https://fentybeauty.com/products/the-water-boi-reparative-leave-in-conditioner-spray',
        destination_url: 'https://fentybeauty.com/products/the-water-boi-reparative-leave-in-conditioner-spray',
        seed_data: {
          brand: 'Fenty Beauty',
          description:
            'A leave-in conditioner spray for detangling, conditioning, and supporting smoother-feeling hair routines.',
          snapshot: {
            review_summary: {
              rating: 4.7,
              scale: 5,
              review_count: 84,
            },
            raw_ingredient_text_clean:
              'Aqua/Water/Eau, Glycerin, Cetearyl Alcohol, Behentrimonium Chloride, Panthenol, Fragrance.',
          },
        },
      }),
      {
        ...kbRow(
          protectedBundle({
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_fenty_water_boi',
            },
          }),
        ),
        kb_key: 'product:ext_fenty_water_boi',
      },
      {
        reviewer: 'codex_quality_reviewer',
        reviewedAt: '2026-05-24T00:00:00.000Z',
      },
    );

    expect(row.skipped).toBeUndefined();
    const bundle = row.selected.bundle;
    expect(bundle.evidence_profile).toBe('community_supported');
    expect(bundle.shopping_card.subtitle).toBe('Leave-in conditioner spray');
    expect(bundle.shopping_card.highlight).toBe('Detangling leave-in spray');
    expect(bundle.product_intel_core.what_it_is.body).toContain('A Fenty Beauty leave-in conditioner spray');
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/A Pixi|beauty product listed/i);
    expect(classifyProductIntelKbRow(
      {
        kb_key: 'product:ext_fenty_water_boi',
        analysis: { product_intel_v1: bundle },
      },
      { productId: 'ext_fenty_water_boi' },
    ).blocking_issues).toEqual([]);
  });

  test('repairs Murad cleanser rows with non-generic card copy', () => {
    const row = buildContentRepairRow(
      seedRow({
        external_product_id: 'ext_murad_cleanser',
        title: 'Renewing Cleansing Cream Travel Size',
        canonical_url: 'https://www.murad.com/products/renewing-cleansing-cream-travel-size',
        destination_url: 'https://www.murad.com/products/renewing-cleansing-cream-travel-size',
        seed_data: {
          brand: 'Murad',
          description:
            'Creamy cleanser removes impurities and gently exfoliates without over-drying skin.',
          snapshot: {
            review_summary: {
              rating: 4.8,
              scale: 5,
              review_count: 126,
            },
            raw_ingredient_text_clean:
              'Water, Glycerin, Glycolic Acid, Jojoba Esters, Tocopherol.',
          },
        },
      }),
      {
        ...kbRow(
          protectedBundle({
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_murad_cleanser',
            },
            shopping_card: {
              contract_version: 'pivota.shopping_card.v1',
              subtitle: 'Product identity',
              highlight: 'Official product detail',
              intro: 'Official product detail.',
              evidence_profile: 'community_supported',
            },
            search_card: {
              compact_candidate: 'Product identity',
              highlight_candidate: 'Official product detail',
              intro_candidate: 'Official product detail.',
            },
          }),
        ),
        kb_key: 'product:ext_murad_cleanser',
      },
      {
        reviewer: 'codex_quality_reviewer',
        reviewedAt: '2026-05-27T00:00:00.000Z',
      },
    );

    expect(row.skipped).toBeUndefined();
    const bundle = row.selected.bundle;
    expect(bundle.shopping_card.title).toBe('Murad Renewing Cleansing Cream Travel Size');
    expect(bundle.shopping_card.subtitle).toBe('Face cleanser');
    expect(bundle.shopping_card.highlight).toBe('Cream cleanser');
    expect(bundle.search_card.highlight_candidate).toBe('Cream cleanser');
    expect(bundle.product_intel_core.what_it_is.body).toContain('A Murad face cleanser');
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/beauty product listed/i);
    expect(bundle.product_intel_core.why_it_stands_out[0].headline).toBe('Face cleanser positioning');
    expect(classifyProductIntelKbRow(
      {
        kb_key: 'product:ext_murad_cleanser',
        analysis: { product_intel_v1: bundle },
      },
      { productId: 'ext_murad_cleanser' },
    ).blocking_issues).toEqual([]);
  });

  test('repairs Murad larger-size retinol rows without cult-favorite value copy', () => {
    const row = buildContentRepairRow(
      seedRow({
        external_product_id: 'ext_murad_retinol_larger',
        title: 'Retinol Youth Renewal Serum Larger Size',
        canonical_url: 'https://www.murad.com/products/retinol-youth-renewal-serum-larger-size',
        destination_url: 'https://www.murad.com/products/retinol-youth-renewal-serum-larger-size',
        seed_data: {
          brand: 'Murad',
          description:
            'Bigger = definitely better. Our cult-favorite, clinically-proven retinol serum is now available in a larger size ($156.00 value).',
          snapshot: {
            review_summary: {
              rating: 4.7,
              scale: 5,
              review_count: 312,
            },
            raw_ingredient_text_clean:
              'Water, Glycerin, Retinol, Hydroxypinacolone Retinoate, Niacinamide.',
          },
        },
      }),
      {
        ...kbRow(
          protectedBundle({
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_murad_retinol_larger',
            },
            shopping_card: {
              contract_version: 'pivota.shopping_card.v1',
              title: 'Murad Retinol Youth Renewal Serum Larger Size',
              subtitle: 'Treatment serum',
              intro: 'Retinol serum details.',
              evidence_profile: 'community_supported',
            },
            search_card: {
              title_candidate: 'Murad Retinol Youth Renewal Serum Larger Size',
              compact_candidate: 'Treatment serum',
              intro_candidate: 'Retinol serum details.',
            },
          }),
        ),
        kb_key: 'product:ext_murad_retinol_larger',
      },
      {
        reviewer: 'codex_quality_reviewer',
        reviewedAt: '2026-05-27T00:00:00.000Z',
      },
    );

    expect(row.skipped).toBeUndefined();
    const bundle = row.selected.bundle;
    expect(bundle.shopping_card.highlight).toBe('Retinoid serum');
    expect(bundle.product_intel_core.what_it_is.body).toContain('larger-size format');
    expect(JSON.stringify(bundle).toLowerCase()).not.toMatch(/cult-favorite|clinically-proven|\\$156|definitely better/);
    expect(classifyProductIntelKbRow(
      {
        kb_key: 'product:ext_murad_retinol_larger',
        analysis: { product_intel_v1: bundle },
      },
      { productId: 'ext_murad_retinol_larger' },
    ).blocking_issues).toEqual([]);
  });

  test('repairs Ole Henriksen sunscreen rows with SPF-specific card copy', () => {
    const row = buildContentRepairRow(
      seedRow({
        external_product_id: 'ext_ole_spf',
        title: 'Banana Bright Mineral Sunscreen SPF 30',
        canonical_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
        destination_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-30',
        seed_data: {
          brand: 'Ole Henriksen',
          description:
            'A mineral sunscreen with SPF 30 for a bright-looking daily morning skincare routine.',
          snapshot: {
            review_summary: {
              rating: 4.5,
              scale: 5,
              review_count: 241,
            },
          },
        },
      }),
      {
        ...kbRow(
          protectedBundle({
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_ole_spf',
            },
          }),
        ),
        kb_key: 'product:ext_ole_spf',
      },
      {
        reviewedAt: '2026-05-27T00:00:00.000Z',
      },
    );

    expect(row.skipped).toBeUndefined();
    expect(row.selected.bundle.shopping_card.subtitle).toBe('Daily sunscreen');
    expect(row.selected.bundle.shopping_card.highlight).toBe('Daily SPF 30');
    expect(row.selected.bundle.product_intel_core.what_it_is.body).toContain(
      'An Ole Henriksen daily sunscreen',
    );
  });

  test('repairs named INNBeauty serum rows without generic serum highlight fallback', () => {
    const row = buildContentRepairRow(
      seedRow({
        external_product_id: 'ext_innbeauty_green_machine',
        title: 'Green Machine Serum',
        canonical_url: 'https://www.innbeautyproject.com/products/green-machine-serum',
        destination_url: 'https://www.innbeautyproject.com/products/green-machine-serum',
        seed_data: {
          brand: 'INNBeauty Project',
          description:
            'An oil-jelly serum built around stable vitamin C and azelaic-acid positioning for brighter-looking, smoother-feeling skin.',
          snapshot: {
            review_summary: {
              rating: 4.6,
              scale: 5,
              review_count: 83,
            },
          },
        },
      }),
      {
        ...kbRow(
          protectedBundle({
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_innbeauty_green_machine',
            },
          }),
        ),
        kb_key: 'product:ext_innbeauty_green_machine',
      },
      {
        reviewedAt: '2026-05-27T00:00:00.000Z',
      },
    );

    expect(row.skipped).toBeUndefined();
    expect(row.selected.bundle.shopping_card.subtitle).toBe('Treatment serum');
    expect(row.selected.bundle.shopping_card.highlight).toBe('Oil-jelly serum');
    expect(row.selected.bundle.product_intel_core.what_it_is.body).toContain(
      'An INNBeauty Project treatment serum',
    );
  });

  test('skips unsupported generic protected rows instead of publishing fallback card copy', () => {
    const row = buildContentRepairRow(
      seedRow({
        external_product_id: 'ext_unknown_generic',
        title: 'Mystery Product 1',
        seed_data: {
          brand: 'Murad',
          description: 'A product page description with enough official text to build a sentence.',
          snapshot: {
            review_summary: {
              rating: 4.2,
              scale: 5,
              review_count: 40,
            },
          },
        },
      }),
      {
        ...kbRow(
          protectedBundle({
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_unknown_generic',
            },
          }),
        ),
        kb_key: 'product:ext_unknown_generic',
      },
      {
        reviewedAt: '2026-05-27T00:00:00.000Z',
      },
    );

    expect(row).toMatchObject({
      skipped: true,
      case_id: 'ext_unknown_generic',
      reason: 'candidate_unavailable',
    });
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
