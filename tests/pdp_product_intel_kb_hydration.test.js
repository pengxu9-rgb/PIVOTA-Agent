describe('pdpProductIntel KB hydration', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.dontMock('../src/auroraBff/productIntelKbStore');
    jest.dontMock('../src/auroraBff/normalize');
  });

  test('hydrates product intel from aurora_product_intel_kb when runtime product lacks explicit intel', async () => {
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry: jest.fn(async (kbKey) => {
        if (kbKey !== 'product:ext_case_1') return null;
        return {
          kb_key: kbKey,
          source: 'url_realtime_product_intel_kb_hit',
          last_success_at: '2026-04-08T10:00:00.000Z',
          analysis: {
            assessment: {
              summary: 'A dewy daily sunscreen designed for hydration and UV protection.',
              best_for: ['Daily UV protection', 'Dry or dehydrated skin'],
              formula_intent: ['Hydration support', 'UV protection'],
            },
            evidence: {
              science: {
                key_ingredients: ['Zinc Oxide', 'Glycerin'],
                risk_notes: [],
              },
              social_signals: {
                typical_positive: ['comfortable finish', 'easy daily wear'],
                typical_negative: [],
                risk_for_groups: [],
              },
            },
            confidence: 0.82,
          },
        };
      }),
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const product = {
      merchant_id: 'm_ext',
      product_id: 'ext_case_1',
      title: 'Hydra Dew SPF 50',
      category: 'Skincare/Sunscreen',
      description: 'A hydrating daily sunscreen.',
      texture: 'light cream',
      finish: 'dewy',
      ingredients_inci: ['Zinc Oxide', 'Glycerin'],
    };

    const hydrated = await hydrateProductWithPublishedIntel({
      product,
      canonicalProductRef: {
        merchant_id: 'm_ext',
        product_id: 'ext_case_1',
      },
    });

    expect(hydrated.assessment.summary).toMatch(/daily sunscreen/i);
    expect(hydrated.evidence.science.key_ingredients).toEqual(
      expect.arrayContaining(['Zinc Oxide', 'Glycerin']),
    );
    expect(hydrated.provenance.kb_key).toBe('product:ext_case_1');

    const bundle = buildProductIntelBundle({
      product: hydrated,
      canonicalProductRef: {
        merchant_id: 'm_ext',
        product_id: 'ext_case_1',
      },
    });

    expect(bundle).toBeTruthy();
    expect(bundle.display_name).toBe('Pivota Insights');
    expect(bundle.evidence_profile).toBe('community_supported');
  });

  test('hydrates direct product_intel_v1 bundles from aurora_product_intel_kb', async () => {
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry: jest.fn(async (kbKey) => {
        if (kbKey !== 'product:ext_case_bundle_1') return null;
        return {
          kb_key: kbKey,
          source: 'pivota_product_intel_pilot_selected',
          last_success_at: '2026-04-08T12:00:00.000Z',
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              display_name: 'Pivota Insights',
              canonical_product_ref: {
                merchant_id: 'm_ext',
                product_id: 'ext_case_bundle_1',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Daily moisturizer',
                  body: 'A daily moisturizer focused on hydration and barrier comfort.',
                },
                best_for: [{ tag: 'dryness', label: 'Dry or dehydrated skin', confidence: 'moderate' }],
                why_it_stands_out: [
                  {
                    headline: 'Barrier support',
                    body: 'Leans on barrier comfort rather than aggressive treatment positioning.',
                    evidence_strength: 'limited',
                  },
                ],
                routine_fit: {
                  step: 'moisturizer',
                  am_pm: ['am', 'pm'],
                  pairing_notes: ['Use after serum and before SPF in the daytime.'],
                },
                watchouts: [],
                confidence: { overall: 'moderate' },
                freshness: {
                  generated_at: '2026-04-08T12:00:00.000Z',
                  source_version: 'pilot_selected:gemini-3-pro-preview',
                },
                quality_state: 'limited',
                evidence_profile: 'seller_plus_formula',
                source_coverage: {
                  seller: { available: true },
                  formula: { available: true },
                  reviews: { available: false, count: 0 },
                  creator: { available: false, count: 0 },
                  editorial: { available: false, count: 0 },
                },
              },
              community_signals: {
                status: 'unavailable',
                unavailable_reason: 'insufficient_feedback',
                confidence: 'low',
                evidence_profile: 'seller_plus_formula',
              },
              external_highlight_signals: [
                {
                  signal_id: 'creator_1',
                  source_type: 'creator_social_consensus',
                  claim_type: 'card_hook',
                  claim_text: 'Creators often point to the lightweight finish.',
                  independence_count: 4,
                  sponsorship_status: 'organic',
                  evidence_strength: 'strong',
                },
              ],
              shopping_card: {
                contract_version: 'pivota.shopping_card.v1',
                title: 'Cloud Barrier Cream',
                subtitle: 'Daily Moisturizer',
                highlight: 'Creators often point to the lightweight',
              },
              search_card: {
                title_candidate: 'Cloud Barrier Cream',
                compact_candidate: 'Daily Moisturizer',
                highlight_candidate: 'Creators often point to the lightweight',
              },
              quality_state: 'limited',
              evidence_profile: 'seller_plus_formula',
              source_coverage: {
                seller: { available: true },
                formula: { available: true },
                reviews: { available: false, count: 0 },
                creator: { available: false, count: 0 },
                editorial: { available: false, count: 0 },
              },
              confidence: { overall: 'moderate' },
              freshness: {
                generated_at: '2026-04-08T12:00:00.000Z',
                source_version: 'pilot_selected:gemini-3-pro-preview',
              },
              provenance: {
                source: 'product_intel_pilot_compare',
                generator: 'baseline_plus_gemini',
              },
            },
          },
        };
      }),
      upsertProductIntelKbEntry: jest.fn(async () => null),
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const product = {
      merchant_id: 'm_ext',
      product_id: 'ext_case_bundle_1',
      title: 'Cloud Barrier Cream',
      category: 'Skincare/Moisturizer',
      description: 'A barrier-supporting moisturizer.',
    };

    const hydrated = await hydrateProductWithPublishedIntel({
      product,
      canonicalProductRef: {
        merchant_id: 'm_ext',
        product_id: 'ext_case_bundle_1',
      },
    });

    expect(hydrated.product_intel.contract_version).toBe('pivota.product_intel.v1');

    const bundle = buildProductIntelBundle({
      product: hydrated,
      canonicalProductRef: {
        merchant_id: 'm_ext',
        product_id: 'ext_case_bundle_1',
      },
    });

    expect(bundle).toBeTruthy();
    expect(bundle.product_intel_core.what_it_is.body).toMatch(/hydration and barrier comfort/i);
    expect(bundle.evidence_profile).toBe('seller_plus_formula');
    expect(bundle.external_highlight_signals).toEqual([
      expect.objectContaining({
        signal_id: 'creator_1',
        surfaceable: true,
      }),
    ]);
    expect(bundle.shopping_card.highlight).toBe('Creators often point to the lightweight');
    expect(bundle.search_card.highlight_candidate).toBe('Creators often point to the lightweight');
  });

  test('hydrates synthetic product-line products from sibling product intel KB keys', async () => {
    const getProductIntelKbEntry = jest.fn(async (kbKey) => {
      if (kbKey !== 'product:ext_line_reviewed') return null;
      return {
        kb_key: kbKey,
        source: 'pivota_product_intel_pilot_selected',
        last_success_at: '2026-04-14T14:18:04.353Z',
        analysis: {
          product_intel_v1: {
            contract_version: 'pivota.product_intel.v1',
            display_name: 'Pivota Insights',
            canonical_product_ref: {
              merchant_id: 'external_seed',
              product_id: 'ext_line_reviewed',
            },
            product_intel_core: {
              what_it_is: {
                headline: 'Daily tinted sunscreen',
                body: 'A lightweight tinted sunscreen line with multiple shade options.',
              },
              best_for: [{ tag: 'daily_spf', label: 'Daily SPF wear', confidence: 'moderate' }],
              why_it_stands_out: [
                {
                  headline: 'Shade-flexible format',
                  body: 'The line uses the same sunscreen positioning across shade-specific PDPs.',
                  evidence_strength: 'seller_grounded',
                },
              ],
              routine_fit: {
                step: 'sunscreen',
                am_pm: ['am'],
                pairing_notes: ['Use as the final morning skincare step.'],
              },
              watchouts: [],
              confidence: { overall: 'moderate' },
              freshness: {
                generated_at: '2026-04-14T14:18:04.353Z',
                source_version: 'pilot_selected:line_level',
              },
              quality_state: 'limited',
              evidence_profile: 'seller_only',
            },
            quality_state: 'limited',
            evidence_profile: 'seller_only',
            freshness: {
              generated_at: '2026-04-14T14:18:04.353Z',
              source_version: 'pilot_selected:line_level',
            },
            provenance: {
              source: 'product_intel_pilot_compare',
              generator: 'curated_override',
            },
          },
        },
      };
    });
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry,
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const product = {
      merchant_id: 'external_seed',
      product_id: 'ext_line_selected',
      title: 'Daily Tinted Fluid Sunscreen DN310',
      canonical_scope: 'synthetic',
      product_line_options: [
        {
          label: 'DN310',
          product_id: 'ext_line_selected',
          selected: true,
        },
        {
          label: 'DN350',
          product_id: 'ext_line_reviewed',
          selected: false,
        },
      ],
    };

    const hydrated = await hydrateProductWithPublishedIntel({
      product,
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_line_selected',
      },
    });

    expect(getProductIntelKbEntry).toHaveBeenCalledWith('product:ext_line_selected');
    expect(getProductIntelKbEntry).toHaveBeenCalledWith('product:ext_line_reviewed');
    expect(hydrated.product_intel.contract_version).toBe('pivota.product_intel.v1');
    expect(hydrated.provenance.kb_key).toBe('product:ext_line_reviewed');

    const bundle = buildProductIntelBundle({
      product: hydrated,
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_line_selected',
      },
    });

    expect(bundle.product_intel_core.what_it_is.body).toMatch(/multiple shade options/i);
    expect(bundle.canonical_product_ref).toEqual({
      merchant_id: 'external_seed',
      product_id: 'ext_line_selected',
    });
  });

  test('prefers direct product_intel_v1 bundle from aurora_product_intel_kb over stale legacy assessment', async () => {
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry: jest.fn(async (kbKey) => {
        if (kbKey !== 'product:ext_case_bundle_legacy_1') return null;
        return {
          kb_key: kbKey,
          source: 'pivota_product_intel_pilot_selected',
          last_success_at: '2026-04-09T03:58:54.000Z',
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              display_name: 'Pivota Insights',
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_case_bundle_legacy_1',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Treatment serum',
                  body: 'A multi-active treatment serum that combines vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid to target tone, texture, and early signs of aging in one step.',
                },
                best_for: [{ tag: 'tone', label: 'Dullness and uneven tone', confidence: 'moderate' }],
                why_it_stands_out: [
                  {
                    headline: 'Multi-active formula',
                    body: 'Brings together vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid in one treatment step.',
                    evidence_strength: 'seller_grounded',
                  },
                ],
                routine_fit: {
                  step: 'serum',
                  am_pm: ['pm'],
                  pairing_notes: ['Use after cleansing and before moisturizer.'],
                },
                watchouts: [],
                confidence: { overall: 'moderate' },
                freshness: {
                  generated_at: '2026-04-09T03:58:54.000Z',
                  source_version: 'pilot_selected:manual_override',
                },
                quality_state: 'limited',
                evidence_profile: 'seller_only',
              },
              community_signals: {
                status: 'unavailable',
                unavailable_reason: 'insufficient_feedback',
                confidence: 'low',
                evidence_profile: 'seller_only',
              },
              quality_state: 'limited',
              evidence_profile: 'seller_only',
              freshness: {
                generated_at: '2026-04-09T03:58:54.000Z',
                source_version: 'pilot_selected:manual_override',
              },
              provenance: {
                source: 'product_intel_pilot_compare',
                generator: 'curated_override',
              },
            },
          },
        };
      }),
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const product = {
      merchant_id: 'external_seed',
      product_id: 'ext_case_bundle_legacy_1',
      title: 'Vitamin C Super Serum Plus - Jumbo',
      category: 'Skincare/Serum',
      description: 'A multi-benefit serum.',
      assessment: {
        summary:
          'Double up and save with this jumbo size of our supercharged serum formulated to improve the look of fine lines and wrinkles.',
      },
      evidence: {
        science: {
          key_ingredients: ['Vitamin C', 'Retinol'],
        },
      },
    };

    const hydrated = await hydrateProductWithPublishedIntel({
      product,
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_case_bundle_legacy_1',
      },
    });

    expect(hydrated.product_intel.contract_version).toBe('pivota.product_intel.v1');

    const bundle = buildProductIntelBundle({
      product: hydrated,
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_case_bundle_legacy_1',
      },
    });

    expect(bundle.product_intel_core.what_it_is.body).toMatch(/multi-active treatment serum/i);
    expect(bundle.product_intel_core.why_it_stands_out[0].headline).toBe('Multi-active formula');
    expect(bundle.product_intel_core.what_it_is.body).not.toMatch(/Double up and save/i);
  });

  test('prefers fresher KB product_intel_v1 over stale embedded product_intel on the source product', async () => {
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry: jest.fn(async (kbKey) => {
        if (kbKey !== 'product:ext_case_bundle_stale_embedded_1') return null;
        return {
          kb_key: kbKey,
          source: 'pivota_product_intel_pilot_selected',
          last_success_at: '2026-04-09T06:40:00.000Z',
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              display_name: 'Pivota Insights',
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_case_bundle_stale_embedded_1',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Treatment serum',
                  body: 'A multi-active treatment serum for uneven tone, texture, and early fine-line concerns.',
                },
                best_for: [{ tag: 'tone', label: 'Uneven tone concerns', confidence: 'moderate' }],
                why_it_stands_out: [
                  {
                    headline: 'Multi-concern treatment scope',
                    body: 'Addresses uneven tone, texture, and early fine-line concerns in one serum step.',
                    evidence_strength: 'seller_grounded',
                  },
                ],
                routine_fit: {
                  step: 'serum',
                  am_pm: ['am', 'pm'],
                  pairing_notes: ['Apply before moisturizer; use SPF in the morning.'],
                },
                watchouts: [],
                confidence: { overall: 'moderate' },
                freshness: {
                  generated_at: '2026-04-09T06:40:00.000Z',
                  source_version: 'pilot_selected:manual_override',
                },
                quality_state: 'limited',
                evidence_profile: 'seller_only',
              },
              community_signals: {
                status: 'unavailable',
                unavailable_reason: 'insufficient_feedback',
                confidence: 'low',
                evidence_profile: 'seller_only',
              },
              quality_state: 'limited',
              evidence_profile: 'seller_only',
              freshness: {
                generated_at: '2026-04-09T06:40:00.000Z',
                source_version: 'pilot_selected:manual_override',
              },
              provenance: {
                source: 'product_intel_pilot_compare',
                generator: 'curated_override',
              },
            },
          },
        };
      }),
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const product = {
      merchant_id: 'external_seed',
      product_id: 'ext_case_bundle_stale_embedded_1',
      title: 'Vitamin C Super Serum Plus - Jumbo',
      category: 'Skincare/Serum',
      description: 'A multi-benefit serum.',
      product_intel: {
        contract_version: 'pivota.product_intel.v1',
        product_intel_core: {
          what_it_is: {
            headline: 'Treatment serum',
            body: 'Our supercharged serum for brightness and texture.',
          },
          best_for: [{ tag: 'tone', label: 'Tone concerns', confidence: 'moderate' }],
          why_it_stands_out: [
            {
              headline: 'Broad concern coverage',
              body: 'Targets brightness, smoother texture, and visible fine-line support rather than a one-note active.',
            },
          ],
          routine_fit: {
            step: 'serum',
            am_pm: ['am', 'pm'],
            pairing_notes: ['Apply before moisturizer.'],
          },
          watchouts: [],
          confidence: { overall: 'moderate' },
          freshness: {
            generated_at: '2026-04-08T03:58:54.000Z',
            source_version: 'pilot_selected:baseline_only',
          },
          quality_state: 'limited',
          evidence_profile: 'seller_only',
        },
        community_signals: {
          status: 'unavailable',
          unavailable_reason: 'insufficient_feedback',
          confidence: 'low',
          evidence_profile: 'seller_only',
        },
        quality_state: 'limited',
        evidence_profile: 'seller_only',
      },
    };

    const hydrated = await hydrateProductWithPublishedIntel({
      product,
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_case_bundle_stale_embedded_1',
      },
    });

    expect(hydrated.product_intel.product_intel_core.what_it_is.body).toMatch(/multi-active treatment serum/i);
    expect(hydrated.product_intel.product_intel_core.what_it_is.body).not.toMatch(/supercharged/i);

    const bundle = buildProductIntelBundle({
      product: hydrated,
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_case_bundle_stale_embedded_1',
      },
    });

    expect(bundle.product_intel_core.why_it_stands_out[0].headline).toBe('Multi-concern treatment scope');
    expect(bundle.product_intel_core.why_it_stands_out[0].body).toMatch(/uneven tone, texture, and early fine-line concerns/i);
  });

  test('allows assistant-reviewed seller-grounded curated overrides for public PDP insights', async () => {
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry: jest.fn(async (kbKey) => {
        if (kbKey !== 'product:ext_assistant_reviewed_spf') return null;
        return {
          kb_key: kbKey,
          source: 'pivota_product_intel_pilot_selected',
          last_success_at: '2026-04-15T13:31:28.252Z',
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              display_name: 'Pivota Insights',
              canonical_product_ref: {
                merchant_id: 'external_seed',
                product_id: 'ext_assistant_reviewed_spf',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Tinted mineral sunscreen',
                  body: 'A daily tinted mineral sunscreen centered on zinc oxide, flexible shade coverage, and a fluid skin-like finish.',
                },
                best_for: [{ tag: 'daily_spf', label: 'Daily mineral SPF users', confidence: 'high' }],
                why_it_stands_out: [
                  {
                    headline: 'Tint plus mineral SPF',
                    body: 'Combines zinc oxide mineral UV protection with a sheer tint.',
                    evidence_strength: 'seller_grounded',
                  },
                ],
                routine_fit: { step: 'sunscreen', am_pm: ['am'] },
                watchouts: [],
              },
              quality_state: 'eligible',
              evidence_profile: 'seller_plus_formula',
              provenance: {
                source: 'product_intel_pilot_compare',
                generator: 'curated_override',
                selection_strategy: 'curated_override',
                review_status: 'completed',
                review_decision: 'rewrite',
                reviewer: 'Codex',
                reviewer_kind: 'assistant',
                reviewed_at: '2026-04-15T13:30:00.000Z',
              },
            },
          },
        };
      }),
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const hydrated = await hydrateProductWithPublishedIntel({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_assistant_reviewed_spf',
        title: 'Daily Tinted Fluid Sunscreen',
        category: 'Skincare/Sunscreen',
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_assistant_reviewed_spf',
      },
      requireReviewedBundle: true,
      allowLegacyAnalysisFallback: false,
    });

    expect(hydrated.product_intel?.product_intel_core?.what_it_is?.headline).toBe(
      'Tinted mineral sunscreen',
    );
    expect(
      buildProductIntelBundle({
        product: hydrated,
        canonicalProductRef: {
          merchant_id: 'external_seed',
          product_id: 'ext_assistant_reviewed_spf',
        },
        requireReviewedBundle: true,
      })?.product_intel_core?.what_it_is?.body,
    ).toMatch(/zinc oxide/i);
  });

  test('does not downgrade rejected reviewed-path KB bundles into generated legacy insights', async () => {
    jest.doMock('../src/auroraBff/productIntelKbStore', () => ({
      getProductIntelKbEntry: jest.fn(async (kbKey) => {
        if (kbKey !== 'product:ext_unreviewed_direct_1') return null;
        return {
          kb_key: kbKey,
          source: 'pivota_product_intel_pilot_selected',
          last_success_at: '2026-04-15T12:00:00.000Z',
          analysis: {
            product_intel_v1: {
              contract_version: 'pivota.product_intel.v1',
              display_name: 'Pivota Insights',
              provenance: {
                generator: 'baseline_plus_gemini',
                review_status: 'pending',
                review_decision: 'pending',
              },
              product_intel_core: {
                what_it_is: {
                  headline: 'Treatment serum',
                  body: 'A product format focused on routine context and acting like a dedicated treatment step.',
                },
                best_for: [{ label: 'Routine role' }],
                why_it_stands_out: [
                  {
                    headline: 'Formula focus',
                    body: 'Anchors the product in routine context.',
                  },
                ],
                routine_fit: { step: 'treatment', am_pm: ['pm'] },
                quality_state: 'eligible',
                evidence_profile: 'seller_plus_formula',
              },
              quality_state: 'eligible',
              evidence_profile: 'seller_plus_formula',
            },
            assessment: {
              summary: 'Legacy assessment that used to regenerate generic public insights.',
              best_for: ['Routine role'],
            },
            evidence: {
              social_signals: {
                typical_positive: ['generic routine fit'],
              },
            },
          },
        };
      }),
    }));

    jest.doMock('../src/auroraBff/normalize', () => ({
      normalizeProductAnalysis: jest.fn((raw) => ({
        payload: raw,
      })),
    }));

    const { hydrateProductWithPublishedIntel, buildProductIntelBundle } = require('../src/pdpProductIntel');

    const hydrated = await hydrateProductWithPublishedIntel({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_unreviewed_direct_1',
        title: 'Generic Treatment Serum',
        category: 'Skincare/Serum',
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_unreviewed_direct_1',
      },
      requireReviewedBundle: true,
      allowLegacyAnalysisFallback: false,
    });

    expect(hydrated.product_intel).toBeUndefined();
    expect(hydrated.assessment).toBeUndefined();
    expect(hydrated.product_intel_unavailable).toEqual(
      expect.objectContaining({
        reason: 'needs_review',
        kb_key: 'product:ext_unreviewed_direct_1',
      }),
    );
    expect(
      buildProductIntelBundle({
        product: hydrated,
        canonicalProductRef: {
          merchant_id: 'external_seed',
          product_id: 'ext_unreviewed_direct_1',
        },
        requireReviewedBundle: true,
      }),
    ).toBeNull();
  });
});
