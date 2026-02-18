const { validateRecoBlocksResponse } = require('../src/auroraBff/contracts/recoBlocksValidator');

function buildValidPayload() {
  return {
    competitors: {
      candidates: [
        {
          product_id: 'p_comp_1',
          brand: 'Brand A',
          name: 'Peptide Serum A',
          why_candidate: ['same_category'],
          score_breakdown: {
            category_score: 0.9,
            ingredient_similarity: 0.8,
            skin_fit_similarity: 0.75,
            social_reference_score: 0.7,
            query_overlap_score: 0.65,
            brand_score: 0.5,
          },
          source: { type: 'catalog_search', name: 'pivota_catalog' },
          evidence_refs: [{ id: 'ev_1', source_type: 'catalog' }],
          price_band: 'mid',
        },
      ],
    },
    related_products: {
      candidates: [
        {
          name: 'Peptide Serum B',
          why_candidate: ['on_page_related'],
          score_breakdown: {
            category_score: 0.8,
            ingredient_similarity: 0.5,
            skin_fit_similarity: 0.4,
            social_reference_score: 0.4,
            query_overlap_score: 0.6,
            brand_score: 0.3,
          },
          source: { type: 'on_page_related' },
          evidence_refs: [],
          price_band: 'premium',
        },
      ],
    },
    dupes: {
      candidates: [
        {
          name: 'Peptide Serum C',
          why_candidate: ['high_similarity'],
          score_breakdown: {
            category_score: 0.9,
            ingredient_similarity: 0.9,
            skin_fit_similarity: 0.8,
            social_reference_score: 0.7,
            query_overlap_score: 0.7,
            brand_score: 0.4,
          },
          source: { type: 'dupe_engine' },
          evidence_refs: [{ id: 'ev_dupe_1' }],
          price_band: 'budget',
        },
      ],
    },
    confidence_by_block: {
      competitors: { score: 0.72, level: 'med', reasons: ['coverage=70%'] },
      related_products: { score: 0.66, level: 'med', reasons: ['coverage=60%'] },
      dupes: { score: 0.61, level: 'med', reasons: ['coverage=55%'] },
    },
    provenance: {
      generated_at: new Date().toISOString(),
      contract_version: 'aurora.product_intel.contract.v2',
      pipeline: 'aurora_product_intel_main_path',
      source: 'aurora_bff_routes',
      validation_mode: 'soft_fail',
    },
    missing_info_internal: [],
    missing_info: [],
  };
}

describe('Aurora reco blocks response contract (v2)', () => {
  test('accepts minimal valid payload', () => {
    const validation = validateRecoBlocksResponse(buildValidPayload());
    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test('fails when required candidate field is missing', () => {
    const payload = buildValidPayload();
    delete payload.competitors.candidates[0].score_breakdown;
    const validation = validateRecoBlocksResponse(payload);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/score_breakdown/i);
  });

  test('fails when source is not a structured object', () => {
    const payload = buildValidPayload();
    payload.competitors.candidates[0].source = ['catalog_search'];
    const validation = validateRecoBlocksResponse(payload);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/source/i);
  });
});
