const {
  classifyActiveIngredientReadiness,
  classifyEffectiveProductIntel,
  classifyProductFamily,
  classifyProductIntelKbRow,
  classifyVariantReadiness,
  summarizeReadinessRows,
  buildReadinessRow,
} = require('../../src/services/externalSeedPdpReadiness');

function reviewedBundle(overrides = {}) {
  const qualityState = overrides.quality_state || 'verified';
  const evidenceProfile = overrides.evidence_profile || 'seller_plus_formula';
  const highlight = overrides.highlight === undefined ? 'Mineral SPF' : overrides.highlight;
  const bundle = {
    contract_version: 'pivota.product_intel.v1',
    quality_state: qualityState,
    evidence_profile: evidenceProfile,
    product_intel_core: {
      quality_state: qualityState,
      evidence_profile: evidenceProfile,
      what_it_is: {
        headline: 'Tinted mineral sunscreen',
        body: 'A zinc oxide mineral sunscreen with a fluid tint and daily SPF coverage.',
      },
      why_it_stands_out: [
        {
          headline: 'Zinc oxide protection',
          body: 'Uses zinc oxide for daily mineral UV protection.',
        },
      ],
      best_for: [{ label: 'Mineral SPF', tag: 'spf', confidence: 'moderate' }],
      watchouts: [{ body: 'Patch test before daily use.' }],
      routine_fit: { step: 'sunscreen', pairing_notes: ['Use as the final morning step.'] },
    },
    shopping_card: {
      title: 'Daily Mineral Sunscreen',
      subtitle: 'Tinted Mineral Sunscreen',
      ...(highlight ? { highlight } : {}),
    },
    search_card: {
      title_candidate: 'Daily Mineral Sunscreen',
      compact_candidate: 'Tinted Mineral Sunscreen',
      ...(highlight ? { highlight_candidate: highlight } : {}),
    },
    provenance: {
      generator: 'strict_human_manual_rewrite',
    },
    ...overrides,
  };
  if (overrides.reviewed === false) {
    bundle.provenance = {};
  }
  return bundle;
}

function kbRow(productId, bundle) {
  return {
    kb_key: `product:${productId}`,
    analysis: { product_intel_v1: bundle },
    source: 'aurora_product_intel_kb',
    source_meta: {},
  };
}

function seedRow(overrides = {}) {
  return {
    id: 'seed_1',
    external_product_id: 'ext_1',
    market: 'US',
    domain: 'example.com',
    title: 'Daily Mineral Sunscreen SPF 50',
    canonical_url: 'https://example.com/products/daily-mineral-sunscreen',
    destination_url: 'https://example.com/products/daily-mineral-sunscreen',
    seed_data: {
      snapshot: {},
      pdp_ingredients_raw: 'Water, Zinc Oxide, Glycerin',
    },
    ...overrides,
  };
}

describe('external seed PDP readiness audit helpers', () => {
  test('classifies sets and non-merch rows separately from single formula PDPs', () => {
    expect(classifyProductFamily(seedRow({ title: 'The Daily Set' }))).toBe('set_or_collection');
    expect(classifyProductFamily(seedRow({ title: 'Digital Gift Card' }))).toBe('non_merch');
    expect(classifyProductFamily(seedRow({ title: 'Niacinamide 10% + Zinc 1%' }))).toBe('single_formula');
  });

  test('does not classify setting powder or collection member shades as set PDPs', () => {
    expect(
      classifyProductFamily(
        seedRow({
          title: 'Invisimatte Instant Setting + Blotting Powder',
          canonical_url: 'https://fentybeauty.com/products/invisimatte-instant-setting-blotting-powder',
          destination_url: 'https://fentybeauty.com/products/invisimatte-instant-setting-blotting-powder',
        }),
      ),
    ).toBe('single_formula');
    expect(
      classifyProductFamily(
        seedRow({
          title: 'Glitty Lid Shimmer Liquid Eyeshadow Arcane Collection: Boozy Bronze',
          canonical_url: 'https://example.com/products/glitty-lid-boozy-bronze',
          destination_url: 'https://example.com/products/glitty-lid-boozy-bronze',
        }),
      ),
    ).toBe('single_formula');
  });

  test('classifies reviewed Pivota Insights with compact card highlight as high quality ready', () => {
    const result = classifyProductIntelKbRow(kbRow('ext_1', reviewedBundle()), { productId: 'ext_1' });

    expect(result.displayable).toBe(true);
    expect(result.high_quality_ready).toBe(true);
    expect(result.issues).not.toContain('missing_card_highlight');
    expect(result.issues).not.toContain('not_reviewed');
  });

  test('does not treat an unreviewed limited KB row as displayable coverage', () => {
    const result = classifyProductIntelKbRow(
      kbRow(
        'ext_1',
        reviewedBundle({
          reviewed: false,
          quality_state: 'limited',
          evidence_profile: 'seller_only',
        }),
      ),
      { productId: 'ext_1' },
    );

    expect(result.displayable).toBe(false);
    expect(result.high_quality_ready).toBe(false);
    expect(result.issues).toContain('not_reviewed');
    expect(result.issues).toContain('not_displayable_gate');
  });

  test('uses a high quality sibling KB when the direct product-line shade KB is not displayable', () => {
    const kbByProductId = new Map([
      [
        'ext_direct',
        kbRow(
          'ext_direct',
          reviewedBundle({
            reviewed: false,
            quality_state: 'eligible',
            evidence_profile: 'seller_plus_formula',
          }),
        ),
      ],
      ['ext_sibling', kbRow('ext_sibling', reviewedBundle())],
    ]);
    const productLineIdByProductId = new Map([
      ['ext_direct', 'pl_1'],
      ['ext_sibling', 'pl_1'],
    ]);
    const productIdsByLineId = new Map([['pl_1', ['ext_direct', 'ext_sibling']]]);

    const result = classifyEffectiveProductIntel(
      seedRow({ external_product_id: 'ext_direct', identity_product_line_id: 'pl_1' }),
      { kbByProductId, productLineIdByProductId, productIdsByLineId },
    );

    expect(result.direct.displayable).toBe(false);
    expect(result.effective.product_id).toBe('ext_sibling');
    expect(result.effective.high_quality_ready).toBe(true);
    expect(result.borrowed_from_sibling).toBe(true);
  });

  test('keeps SPF zinc oxide as regulatory active even when only the INCI raw text is present', () => {
    const result = classifyActiveIngredientReadiness(
      seedRow({
        title: 'Daily Mineral Sunscreen SPF 50',
        seed_data: {
          snapshot: {},
          pdp_ingredients_raw: 'Water, Zinc Oxide, Caprylic/Capric Triglyceride, Glycerin',
        },
      }),
    );

    expect(result.regulatory_expected).toBe(true);
    expect(result.status).toBe('ready_regulatory');
    expect(result.active_items).toContain('Zinc Oxide');
  });

  test('flags glycerin-only active ingredients as low signal instead of ready hero content', () => {
    const result = classifyActiveIngredientReadiness(
      seedRow({
        title: 'Multi-Peptide Lash and Brow Serum',
        canonical_url: 'https://example.com/products/multi-peptide-lash-brow-serum',
        destination_url: 'https://example.com/products/multi-peptide-lash-brow-serum',
        seed_data: {
          snapshot: {},
          active_ingredients: ['Glycerin'],
          pdp_ingredients_raw: 'Water, Glycerin, Myristoyl Pentapeptide-17, Caffeine',
          pdp_details_sections: [
            {
              heading: 'Details',
              content: 'A peptide serum for fuller-looking lashes and brows.',
            },
          ],
        },
      }),
    );

    expect(result.hero_expected).toBe(true);
    expect(result.status).toBe('low_signal_active');
    expect(result.issues).toContain('low_signal_active');
  });

  test('flags storefront fragments such as See as invalid active ingredient tokens', () => {
    const result = classifyActiveIngredientReadiness(
      seedRow({
        title: 'Sheer Shiny Lipstick',
        canonical_url: 'https://example.com/products/sheer-shiny-lipstick',
        destination_url: 'https://example.com/products/sheer-shiny-lipstick',
        seed_data: {
          snapshot: {},
          active_ingredients: ['See'],
          pdp_ingredients_raw: 'Ricinus Communis Seed Oil, Titanium Dioxide, Iron Oxides',
        },
      }),
    );

    expect(result.status).toBe('invalid_token_in_active');
    expect(result.issues).toContain('invalid_token_in_active');
  });

  test('passes default-only variants when seed-level product media can supply a size axis', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'Multi-Peptide Lash and Brow Serum',
        canonical_url: 'https://theordinary.com/en-us/multi-peptide-lash-brow-serum-100111.html',
        seed_data: {
          snapshot: {
            image_url:
              'https://theordinary.com/dw/image/v2/BFKJ_PRD/on/demandware.static/-/Sites-deciem-master/default/dw0fd80738/Images/products/The%20Ordinary/rdn-multi-peptide-lash-and-brow-serum-eu-5ml.png?sw=900&sh=900&sm=fit',
            variants: [
              {
                sku: '769915233636',
                variant_id: 'e3cf79a9b040',
                option_name: 'Offer',
                option_value: '769915233636',
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe('ready');
    expect(result.issues).not.toContain('default_option_size_evidence_missing_axis');
  });

  test('still flags multi-variant rows when product-level size evidence would mask mixed-product pollution', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: '100% Organic Virgin Chia Seed Oil',
        canonical_url: 'https://theordinary.com/en-us/100-organic-virgin-chia-seed-face-oil-100395.html',
        seed_data: {
          snapshot: {
            image_url:
              'https://theordinary.com/Images/products/The%20Ordinary/rdn-100pct-organic-cold-pressed-rose-hip-seed-oil-30ml.png',
            variants: [
              {
                sku: 'rdn-100pct-organic-cold-pressed-rose-hip-seed-oil-30ml',
                variant_id: 'rose-hip',
                option_name: 'Offer',
                option_value: 'rdn-100pct-organic-cold-pressed-rose-hip-seed-oil-30ml',
              },
              {
                sku: 'rdn-100pct-cold-pressed-virgin-marula-oil-30ml',
                variant_id: 'marula',
                option_name: 'Offer',
                option_value: 'rdn-100pct-cold-pressed-virgin-marula-oil-30ml',
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe('flagged');
    expect(result.issues).toContain('default_option_size_evidence_missing_axis');
    expect(result.examples.default_option_size_evidence_missing_axis[0].value).toContain('30ml');
  });

  test('flags named-size default variants when mini/full-size evidence is present but no axis is visible', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'Always An Optimist Pore Diffusing Primer Mini',
        canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
        seed_data: {
          snapshot: {
            variants: [
              {
                variant_id: 'mini-default',
                option_name: 'Title',
                option_value: 'Default Title',
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe('flagged');
    expect(result.issues).toContain('default_option_size_evidence_missing_axis');
    expect(result.examples.default_option_size_evidence_missing_axis[0].value).toMatch(/mini/i);
  });

  test('does not require a size axis for single-SKU lip color rows that only carry fixed net content', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'Stunna Lip Paint Longwear Fluid Lip Color — Uninterested',
        canonical_url: 'https://fentybeauty.com/products/stunna-lip-paint-uninterested',
        destination_url: 'https://fentybeauty.com/products/stunna-lip-paint-uninterested',
        seed_data: {
          snapshot: {
            product_volume: '4 mL',
            variants: [
              {
                variant_id: 'stunna-default',
                option_name: 'Title',
                option_value: 'Default Title',
              },
            ],
          },
        },
      }),
    );

    expect(result.issues).not.toContain('default_option_size_evidence_missing_axis');
  });

  test('flags identity default-title shade pollution from live identity context', () => {
    const row = seedRow({
      external_product_id: 'ext_rare_primer_mini',
      title: 'Always An Optimist Pore Diffusing Primer Mini',
      canonical_url: 'https://rarebeauty.com/products/always-an-optimist-pore-diffusing-primer-mini',
      seed_data: {
        snapshot: {
          variants: [
            {
              variant_id: 'mini-default',
              option_name: 'Title',
              option_value: 'Default Title',
            },
          ],
        },
      },
    });
    const result = classifyVariantReadiness(row, {
      variantAxesByProductId: new Map([
        ['ext_rare_primer_mini', { size: 'mini', shade: 'default title', multi_variant: false }],
      ]),
    });

    expect(result.status).toBe('flagged');
    expect(result.issues).toContain('identity_default_title_axis');
    expect(result.examples.identity_default_title_axis[0].value).toBe('default title');
  });

  test('does not flag tint balm shade variants as skincare axis drift', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'KISSKISS BEE GLOW 98% naturally-derived honey tint balm',
        canonical_url: 'https://www.guerlain.com/us/en-us/p/kisskiss-bee-glow-honey-tint-balm.html',
        seed_data: {
          snapshot: {
            variants: [
              {
                variant_id: '458',
                option_name: 'Shade',
                option_value: '458 Pop Rose Glow',
                image_url: 'https://www.guerlain.com/shades/458-pop-rose-glow.jpg',
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe('ready');
    expect(result.issues).not.toContain('wrong_axis_for_category');
  });

  test('does not flag dewy balm stick shade variants as skincare axis drift', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'Dewy Balm Stick',
        canonical_url: 'https://kyliecosmetics.com/products/dewy-balm-stick',
        seed_data: {
          snapshot: {
            category: 'Skincare',
            product_type: 'Balm',
            variants: [
              {
                variant_id: 'solar-glow',
                options: [{ name: 'Shade', value: 'Solar Glow', axis_kind: 'shade' }],
                image_url: 'https://cdn.shopify.com/dewy-balm-solar-glow.jpg',
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe('ready');
    expect(result.issues).not.toContain('wrong_axis_for_category');
  });

  test('does not flag lip cream or lip mask shade rows as wrong axis for category', () => {
    const glossBomb = classifyVariantReadiness(
      seedRow({
        title: 'Gloss Bomb Cream Color Drip Lip Cream — Fruit Snackz',
        canonical_url: 'https://fentybeauty.com/products/gloss-bomb-cream-fruit-snackz',
        destination_url: 'https://fentybeauty.com/products/gloss-bomb-cream-fruit-snackz',
        seed_data: {
          snapshot: {
            variants: [
              {
                variant_id: 'fruit-snackz',
                option_name: 'Shade',
                option_value: 'Fruit Snackz',
                image_url: 'https://fentybeauty.com/shades/fruit-snackz.jpg',
              },
            ],
          },
        },
      }),
    );
    const plushPuddin = classifyVariantReadiness(
      seedRow({
        title: "Plush Puddin' Intensive Recovery Lip Mask — Vanilla",
        canonical_url: 'https://fentybeauty.com/products/plush-puddin-vanilla',
        destination_url: 'https://fentybeauty.com/products/plush-puddin-vanilla',
        seed_data: {
          snapshot: {
            variants: [
              {
                variant_id: 'vanilla',
                option_name: 'Color',
                option_value: 'Vanilla',
                image_url: 'https://fentybeauty.com/shades/vanilla.jpg',
              },
            ],
          },
        },
      }),
    );

    expect(glossBomb.issues).not.toContain('wrong_axis_for_category');
    expect(plushPuddin.issues).not.toContain('wrong_axis_for_category');
  });

  test('does not require single variant size axes for sets that mention component sizes', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'Glow & Hydration Duo APRICOT',
        canonical_url: 'https://example.com/products/glow-hydration-duo-apricot',
        seed_data: {
          snapshot: {
            image_url:
              'https://cdn.shopify.com/s/files/1/0752/5643/0881/files/RadiantComplexionCreamApricot1.01fl.oz.jpg?v=1772122887',
            variants: [
              {
                variant_id: 'duo-default',
                option_name: 'Title',
                option_value: 'Default Title',
              },
            ],
          },
        },
      }),
    );

    expect(result.status).toBe('no_visible_variant_axis');
    expect(result.issues).not.toContain('default_option_size_evidence_missing_axis');
  });

  test('does not require single variant size axes for makeup look bundles', () => {
    const result = classifyVariantReadiness(
      seedRow({
        title: 'Perfect Nude Makeup Look',
        canonical_url: 'https://example.com/products/perfect-nude-makeup-look',
        seed_data: {
          snapshot: {
            image_url:
              'https://cdn.shopify.com/s/files/1/0752/5643/0881/files/RadiantComplexionCreamApricot1.01fl.oz.jpg?v=1772122887',
            variants: [
              {
                variant_id: 'look-default',
                option_name: 'Title',
                option_value: 'Default Title',
              },
            ],
          },
        },
      }),
    );

    expect(classifyProductFamily(seedRow({ title: 'Perfect Nude Makeup Look' }))).toBe('set_or_collection');
    expect(result.status).toBe('no_visible_variant_axis');
    expect(result.issues).not.toContain('default_option_size_evidence_missing_axis');
  });

  test('summarizes effective insights separately from direct KB coverage', () => {
    const kbByProductId = new Map([
      [
        'ext_direct',
        kbRow(
          'ext_direct',
          reviewedBundle({
            reviewed: false,
            quality_state: 'limited',
            evidence_profile: 'seller_only',
          }),
        ),
      ],
      ['ext_sibling', kbRow('ext_sibling', reviewedBundle())],
    ]);
    const context = {
      kbByProductId,
      productLineIdByProductId: new Map([
        ['ext_direct', 'pl_1'],
        ['ext_sibling', 'pl_1'],
      ]),
      productIdsByLineId: new Map([['pl_1', ['ext_direct', 'ext_sibling']]]),
    };
    const readinessRow = buildReadinessRow(
      seedRow({
        external_product_id: 'ext_direct',
        identity_product_line_id: 'pl_1',
      }),
      context,
    );
    const summary = summarizeReadinessRows([readinessRow]);

    expect(summary.pivota_insights.direct.not_displayable).toBe(1);
    expect(summary.pivota_insights.effective.high_quality_ready).toBe(1);
    expect(summary.pivota_insights.effective.borrowed_from_sibling).toBe(1);
  });

  test('does not count reviewed not-applicable accessories as missing INCI coverage', () => {
    const readinessRow = buildReadinessRow(
      seedRow({
        title: 'Trace’d Out Dual Pencil Sharpener',
        seed_data: {
          snapshot: {},
          ingredient_intel: {
            inci_applicability: {
              status: 'not_applicable',
              reason: 'product_family_accessory',
              review_state: 'reviewed',
            },
          },
          ingredient_remediation_v1: {
            field: 'ingredients_inci',
            action: 'mark_inci_not_applicable',
            source_origin: 'pivota_manual_component_repair',
          },
        },
      }),
    );
    const summary = summarizeReadinessRows([readinessRow]);

    expect(readinessRow.coverage.inci_applicability_status).toBe('not_applicable');
    expect(summary.coverage.missing_inci).toBe(0);
    expect(summary.coverage.missing_active_raw).toBe(0);
  });

  test('does not count reviewed component-linked gift sets as missing parent INCI coverage', () => {
    const readinessRow = buildReadinessRow(
      seedRow({
        title: 'The Rich Curls 3-Piece Curl-Defining Routine',
        seed_data: {
          bundle_component_refs: [
            { external_product_id: 'ext_shampoo', review_state: 'reviewed' },
            { external_product_id: 'ext_conditioner', review_state: 'reviewed' },
          ],
          snapshot: {
            bundle_component_refs: [
              { external_product_id: 'ext_shampoo', review_state: 'reviewed' },
              { external_product_id: 'ext_conditioner', review_state: 'reviewed' },
            ],
          },
          ingredient_intel: {
            source_review_queue: {
              status: 'component_refs_linked',
              review_state: 'queued',
            },
          },
          ingredient_remediation_v1: {
            field: 'ingredients_inci',
            action: 'component_refs_linked',
            source_origin: 'pivota_manual_component_repair',
          },
        },
      }),
    );
    const summary = summarizeReadinessRows([readinessRow]);

    expect(readinessRow.coverage.ingredient_review_status).toBe('component_refs_linked');
    expect(readinessRow.coverage.bundle_component_refs_count).toBe(2);
    expect(summary.coverage.missing_inci).toBe(0);
    expect(summary.coverage.missing_active_raw).toBe(0);
  });

  test('still counts single formulas queued for manual source review as missing INCI coverage', () => {
    const readinessRow = buildReadinessRow(
      seedRow({
        title: 'Match Stix Contour Skinstick — Suedish',
        seed_data: {
          snapshot: {},
          ingredient_intel: {
            source_review_queue: {
              status: 'manual_source_review_required',
              review_state: 'queued',
            },
          },
          ingredient_remediation_v1: {
            field: 'ingredients_inci',
            action: 'manual_source_review_required',
            source_origin: 'pivota_manual_component_repair',
          },
        },
      }),
    );
    const summary = summarizeReadinessRows([readinessRow]);

    expect(readinessRow.coverage.ingredient_review_status).toBe('manual_source_review_required');
    expect(summary.coverage.missing_inci).toBe(1);
  });

  test('does not count product-line shade rows as missing INCI when a sibling has reviewed INCI', () => {
    const sourceSibling = seedRow({
      external_product_id: 'ext_concealer_sibling',
      title: "Pro Filt'r Instant Retouch Concealer — #130",
      seed_data: {
        pdp_ingredients_raw: 'Water, Dimethicone, Glycerin, Iron Oxides.',
      },
    });
    const targetRow = seedRow({
      external_product_id: 'ext_concealer_target',
      title: "Pro Filt'r Instant Retouch Concealer — #120",
      seed_data: {
        ingredient_intel: {
          source_review_queue: {
            status: 'manual_source_review_required',
            review_state: 'queued',
          },
        },
        ingredient_remediation_v1: {
          field: 'ingredients_inci',
          action: 'manual_source_review_required',
          source_origin: 'pivota_manual_component_repair',
        },
      },
    });
    const context = {
      productLineIdByProductId: new Map([
        ['ext_concealer_target', 'pl_concealer'],
        ['ext_concealer_sibling', 'pl_concealer'],
      ]),
      productIdsByLineId: new Map([
        ['pl_concealer', ['ext_concealer_target', 'ext_concealer_sibling']],
      ]),
      seedRowByProductId: new Map([
        ['ext_concealer_target', targetRow],
        ['ext_concealer_sibling', sourceSibling],
      ]),
      directCoverageByProductId: new Map(),
      kbByProductId: new Map(),
    };
    const readinessRow = buildReadinessRow(targetRow, context);
    const summary = summarizeReadinessRows([readinessRow]);

    expect(readinessRow.coverage.inci_chars).toBe(0);
    expect(readinessRow.coverage.effective_inci_chars).toBeGreaterThan(0);
    expect(readinessRow.coverage.inci_borrowed_from_product_id).toBe('ext_concealer_sibling');
    expect(summary.coverage.missing_inci).toBe(0);
  });
});

describe('external seed PDP readiness audit script DB resilience', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/db');
  });

  test('skips unreadable identity rows instead of failing the whole audit context', async () => {
    const queryMock = jest.fn(async (sql, params) => {
      const values = params[0] || [];
      const isLineLookup = sql.includes('product_line_id = ANY');
      if (!isLineLookup && values.includes('ext_bad')) {
        throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
      }
      if (isLineLookup) {
        return {
          rows: [
            { product_id: 'ext_good', product_line_id: 'pl_1', variant_axes: { size: 'mini' } },
            { product_id: 'ext_sibling', product_line_id: 'pl_1', variant_axes: { size: 'full size' } },
          ],
        };
      }
      return {
        rows: values.includes('ext_good')
          ? [{ product_id: 'ext_good', product_line_id: 'pl_1', variant_axes: { size: 'mini' } }]
          : [],
      };
    });
    jest.doMock('../../src/db', () => ({
      query: queryMock,
      getPool: jest.fn(),
    }));

    const { fetchIdentityContext } = require('../../scripts/audit-external-seed-pdp-readiness');
    const context = await fetchIdentityContext(['ext_good', 'ext_bad']);

    expect(context.productLineIdByProductId.get('ext_good')).toBe('pl_1');
    expect(context.variantAxesByProductId.get('ext_good')).toEqual({ size: 'mini' });
    expect(context.productIdsByLineId.get('pl_1')).toEqual(['ext_good', 'ext_sibling']);
    expect(context.allProductIds).toEqual(expect.arrayContaining(['ext_good', 'ext_bad', 'ext_sibling']));
    expect(context.warnings).toEqual([
      expect.objectContaining({
        scope: 'pdp_identity_listing.product_id',
        value: 'ext_bad',
      }),
    ]);
  });

  test('targeted audit loads product-line sibling seed rows for effective INCI coverage', async () => {
    const target = seedRow({
      external_product_id: 'ext_target',
      title: "Pro Filt'r Instant Retouch Concealer — #120",
      seed_data: {
        ingredient_intel: {
          source_review_queue: {
            status: 'manual_source_review_required',
            review_state: 'queued',
          },
        },
      },
    });
    const sibling = seedRow({
      external_product_id: 'ext_sibling',
      title: "Pro Filt'r Instant Retouch Concealer — #130",
      seed_data: {
        pdp_ingredients_raw: 'Water, Dimethicone, Glycerin, Iron Oxides.',
      },
    });
    const queryMock = jest.fn(async (sql, params) => {
      if (/FROM aurora_product_intel_kb/i.test(sql)) return { rows: [] };
      if (/FROM external_product_seeds/i.test(sql)) {
        expect(params[0]).toEqual(['ext_sibling']);
        return { rows: [sibling] };
      }
      if (/FROM pdp_identity_listing/i.test(sql) && /product_line_id = ANY/i.test(sql)) {
        return {
          rows: [
            { product_id: 'ext_target', product_line_id: 'pl_concealer', variant_axes: { shade: '120' } },
            { product_id: 'ext_sibling', product_line_id: 'pl_concealer', variant_axes: { shade: '130' } },
          ],
        };
      }
      if (/FROM pdp_identity_listing/i.test(sql)) {
        return {
          rows: [
            { product_id: 'ext_target', product_line_id: 'pl_concealer', variant_axes: { shade: '120' } },
          ],
        };
      }
      return { rows: [] };
    });
    jest.doMock('../../src/db', () => ({
      query: queryMock,
      getPool: jest.fn(),
    }));

    const { buildReadinessAuditForSeedRows } = require('../../scripts/audit-external-seed-pdp-readiness');
    const audit = await buildReadinessAuditForSeedRows([target], {
      market: 'US',
      intelContext: 'effective',
      includeAttached: false,
      sampleLimit: 2,
    });

    expect(audit.rows[0].coverage.inci_chars).toBe(0);
    expect(audit.rows[0].coverage.effective_inci_chars).toBeGreaterThan(0);
    expect(audit.rows[0].coverage.inci_borrowed_from_product_id).toBe('ext_sibling');
    expect(audit.summary.coverage.missing_inci).toBe(0);
  });

  test('checkpointed audit writes and resumes per-domain payloads', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-readiness-checkpoint-'));
    const rows = [
      seedRow({ domain: 'brand-a.com', external_product_id: 'ext_a', title: 'Niacinamide Serum' }),
      seedRow({ domain: 'brand-b.com', external_product_id: 'ext_b', title: 'Daily Set' }),
    ];
    const queryMock = jest.fn(async (sql, params) => {
      if (/GROUP BY eps\.domain/i.test(sql)) {
        return {
          rows: [
            { domain: 'brand-a.com', seed_count: 1 },
            { domain: 'brand-b.com', seed_count: 1 },
          ],
        };
      }
      if (/FROM aurora_product_intel_kb/i.test(sql)) return { rows: [] };
      if (/FROM pdp_identity_listing/i.test(sql)) return { rows: [] };
      const domain = params.find((value) => value === 'brand-a.com' || value === 'brand-b.com');
      return { rows: rows.filter((row) => row.domain === domain) };
    });
    jest.doMock('../../src/db', () => ({
      query: queryMock,
      getPool: jest.fn(),
    }));

    const { buildCheckpointedReadinessAudit } = require('../../scripts/audit-external-seed-pdp-readiness');
    const first = await buildCheckpointedReadinessAudit({
      market: 'US',
      checkpointDir: tmpDir,
      checkpointMode: 'domain',
      intelContext: 'direct',
      includeAttached: false,
      limit: 10,
      sampleLimit: 2,
    });
    const second = await buildCheckpointedReadinessAudit({
      market: 'US',
      checkpointDir: tmpDir,
      checkpointMode: 'domain',
      intelContext: 'direct',
      includeAttached: false,
      limit: 10,
      sampleLimit: 2,
      resume: true,
    });

    expect(first.summary.scanned).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, 'domains', 'brand-a.com.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'domains', 'brand-b.com.json'))).toBe(true);
    expect(second.summary.scanned).toBe(2);
    expect(second.manifest.skipped_domains).toHaveLength(2);
  });

  test('checkpointed audit can scan by id cursor pages', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp-readiness-page-'));
    const rows = [
      seedRow({ id: 'eps_001', domain: 'brand-a.com', external_product_id: 'ext_a', title: 'Niacinamide Serum' }),
      seedRow({ id: 'eps_002', domain: 'brand-b.com', external_product_id: 'ext_b', title: 'Daily Set' }),
      seedRow({ id: 'eps_003', domain: 'brand-c.com', external_product_id: 'ext_c', title: 'Vitamin C Serum' }),
    ];
    const queryMock = jest.fn(async (sql, params) => {
      if (/FROM aurora_product_intel_kb/i.test(sql)) return { rows: [] };
      if (/FROM pdp_identity_listing/i.test(sql)) return { rows: [] };
      const cursor = params.find((value) => /^eps_/.test(String(value || ''))) || '';
      const limit = Number(params[params.length - 1] || 2);
      return { rows: rows.filter((row) => row.id > cursor).slice(0, limit) };
    });
    jest.doMock('../../src/db', () => ({
      query: queryMock,
      getPool: jest.fn(),
    }));

    const { buildCheckpointedReadinessAudit } = require('../../scripts/audit-external-seed-pdp-readiness');
    const first = await buildCheckpointedReadinessAudit({
      market: 'US',
      checkpointDir: tmpDir,
      checkpointMode: 'page',
      intelContext: 'direct',
      includeAttached: false,
      limit: 3,
      pageSize: 2,
      sampleLimit: 2,
    });
    const second = await buildCheckpointedReadinessAudit({
      market: 'US',
      checkpointDir: tmpDir,
      checkpointMode: 'page',
      intelContext: 'direct',
      includeAttached: false,
      limit: 3,
      pageSize: 2,
      sampleLimit: 2,
      resume: true,
    });

    expect(first.summary.scanned).toBe(3);
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'page-000001.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'pages', 'page-000002.json'))).toBe(true);
    expect(second.summary.scanned).toBe(3);
    expect(second.manifest.skipped_pages).toHaveLength(2);
  });
});
