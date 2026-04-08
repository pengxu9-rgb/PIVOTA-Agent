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
  });
});
