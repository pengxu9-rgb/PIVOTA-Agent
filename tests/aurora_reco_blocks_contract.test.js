const { validateRecoBlocksResponse } = require('../src/auroraBff/contracts/recoBlocksValidator');

function buildValidPayload() {
  return {
    competitors: {
      candidates: [
        {
          product_id: 'p_comp_1',
          brand: 'Brand A',
          name: 'Peptide Serum A',
          why_candidate: {
            summary: 'Strong category and ingredient match.',
            reasons_user_visible: [
              'Strong category/use-case match with the anchor product.',
              'Key ingredient functions are highly similar.',
              'Price band is close to the anchor product.',
            ],
            boundary_user_visible: 'Competitors are cross-brand by default.',
          },
          score_breakdown: {
            category_use_case_match: 0.9,
            ingredient_functional_similarity: 0.8,
            skin_fit_similarity: 0.75,
            social_reference_strength: 0.7,
            price_distance: 0.65,
            brand_constraint: 1,
            quality: 0.72,
            score_total: 0.79,
          },
          source: { type: 'catalog_search', name: 'pivota_catalog' },
          evidence_refs: [{ id: 'ev_1', source_type: 'catalog' }],
          price_band: 'mid',
          social_summary_user_visible: {
            themes: ['Barrier repair', 'Hydration'],
            top_keywords: ['barrier', 'hydration', 'soothing'],
            sentiment_hint: 'Overall social discussion is mostly positive.',
            volume_bucket: 'mid',
          },
        },
      ],
    },
    related_products: {
      candidates: [
        {
          name: 'Peptide Serum B',
          why_candidate: {
            summary: 'Related by brand and co-view patterns.',
            reasons_user_visible: [
              'High brand affinity indicates strong relation.',
              'Strong co-view signal.',
              'Strong KB routine association.',
            ],
          },
          score_breakdown: {
            category_use_case_match: 0.8,
            ingredient_functional_similarity: 0.5,
            skin_fit_similarity: 0.4,
            social_reference_strength: 0.4,
            price_distance: 0.6,
            brand_constraint: 0,
            brand_affinity: 1,
            co_view: 0.7,
            kb_routine: 0.5,
            score_total: 0.795,
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
          why_candidate: {
            summary: 'High functional similarity with better pricing.',
            reasons_user_visible: [
              'Strong category/use-case match with the anchor product.',
              'Key ingredient functions are highly similar.',
              'More budget-friendly with strong dupe potential.',
            ],
          },
          score_breakdown: {
            category_use_case_match: 0.9,
            ingredient_functional_similarity: 0.9,
            skin_fit_similarity: 0.8,
            social_reference_strength: 0.7,
            price_distance: 0.8,
            brand_constraint: 1,
            score_total: 0.84,
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
      social_channels_used: ['reddit', 'xiaohongshu'],
      dogfood_mode: true,
      dogfood_features_effective: {
        interleave: true,
        exploration: true,
        async_rerank: true,
        show_employee_feedback_controls: true,
      },
      interleave: {
        enabled: true,
        rankerA: 'ranker_v1',
        rankerB: 'ranker_v2',
      },
      async_ticket_id: 'ticket_1',
      lock_top_n_on_first_paint: 3,
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

  test('accepts legacy why_candidate array (dual-compat)', () => {
    const payload = buildValidPayload();
    payload.competitors.candidates[0].why_candidate = ['same category'];
    const validation = validateRecoBlocksResponse(payload);
    expect(validation.ok).toBe(true);
  });

  test('fails when social summary exceeds length limits', () => {
    const payload = buildValidPayload();
    payload.competitors.candidates[0].social_summary_user_visible = {
      themes: ['a', 'b', 'c', 'd'],
      top_keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'],
      volume_bucket: 'mid',
    };
    const validation = validateRecoBlocksResponse(payload);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/themes|top_keywords/i);
  });

  test('fails when social summary contains internal count-like fields', () => {
    const payload = buildValidPayload();
    payload.competitors.candidates[0].social_summary_user_visible = {
      themes: ['Hydration'],
      volume_bucket: 'low',
      mention_count: 123,
    };
    const validation = validateRecoBlocksResponse(payload);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/social_summary_user_visible/i);
  });
});
