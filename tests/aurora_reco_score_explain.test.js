const { routeCandidates } = require('../src/auroraBff/competitorBlockRouter');
const {
  scoreCandidate,
  attachExplanations,
  sanitizeUserReasonText,
} = require('../src/auroraBff/recoScoreExplain');

function makeAnchor(overrides = {}) {
  return {
    brand_id: 'anchor_brand',
    category_taxonomy: ['serum', 'hydration'],
    price: 100,
    ingredient_tokens: ['niacinamide', 'panthenol', 'glycerin'],
    profile_skin_tags: ['oily', 'sensitive', 'impaired_barrier'],
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    product_id: 'cand_1',
    name: 'Candidate Serum',
    brand_id: 'other_brand',
    category_taxonomy: ['serum', 'hydration'],
    price: 95,
    source: { type: 'catalog_search' },
    key_ingredients: ['niacinamide', 'panthenol'],
    skin_type_tags: ['oily', 'sensitive'],
    evidence_refs: [{ id: 'existing', source_type: 'catalog' }],
    ...overrides,
  };
}

describe('recoScoreExplain', () => {
  test('normalizes score features to 0~1', () => {
    const scored = scoreCandidate('competitors', makeAnchor(), makeCandidate({
      score_breakdown: {
        category_use_case_match: 130,
        ingredient_functional_similarity: -10,
        skin_fit_similarity: 60,
        social_reference_strength: 0.7,
        price_distance: 20,
        brand_constraint: 2,
        quality: 50,
      },
    }));

    const breakdown = scored.score_breakdown;
    expect(breakdown.category_use_case_match).toBe(1);
    expect(breakdown.ingredient_functional_similarity).toBe(0);
    expect(breakdown.skin_fit_similarity).toBe(0.6);
    expect(breakdown.social_reference_strength).toBe(0.7);
    expect(breakdown.price_distance).toBe(0.2);
    expect(breakdown.brand_constraint).toBeGreaterThanOrEqual(0);
    expect(breakdown.brand_constraint).toBeLessThanOrEqual(1);
    expect(breakdown.quality).toBe(0.5);
    expect(breakdown.score_total).toBeGreaterThanOrEqual(0);
    expect(breakdown.score_total).toBeLessThanOrEqual(1);
  });

  test('computes expected competitor score_total with configured weights', () => {
    const scored = scoreCandidate('competitors', makeAnchor(), makeCandidate({
      score_breakdown: {
        category_use_case_match: 1,
        ingredient_functional_similarity: 0.5,
        skin_fit_similarity: 0.25,
        social_reference_strength: 0.5,
        price_distance: 1,
        brand_constraint: 1,
        quality: 1,
      },
    }));

    expect(scored.score_breakdown.score_total).toBeCloseTo(0.68, 2);
  });

  test('dupe scoring favors cheaper candidates via price_distance weight', () => {
    const anchor = makeAnchor({ price: 100 });
    const baseBreakdown = {
      category_use_case_match: 0.8,
      ingredient_functional_similarity: 0.8,
      skin_fit_similarity: 0.7,
      social_reference_strength: 0.7,
      brand_constraint: 1,
    };

    const cheap = scoreCandidate('dupes', anchor, makeCandidate({
      product_id: 'cheap',
      price: 60,
      score_breakdown: baseBreakdown,
    }));
    const expensive = scoreCandidate('dupes', anchor, makeCandidate({
      product_id: 'exp',
      price: 150,
      score_breakdown: baseBreakdown,
    }));

    expect(cheap.score_breakdown.price_distance).toBeGreaterThan(expensive.score_breakdown.price_distance);
    expect(cheap.score_breakdown.score_total).toBeGreaterThan(expensive.score_breakdown.score_total);
  });

  test('related scoring uses brand_affinity/co_view/kb_routine stub weights', () => {
    const scored = scoreCandidate('related_products', makeAnchor(), makeCandidate({
      brand_id: 'anchor_brand',
      score_breakdown: {
        brand_affinity: 1,
        co_view: 0.6,
        kb_routine: 0.5,
      },
    }));

    expect(scored.score_breakdown.score_total).toBeCloseTo(0.76, 2);
  });

  test('brand gate remains hard in router regardless of score', () => {
    const anchor = makeAnchor({ brand_id: 'same_brand' });
    const sameBrandCandidate = makeCandidate({
      brand_id: 'same_brand',
      similarity_score: 0.99,
      score_breakdown: {
        category_use_case_match: 1,
        ingredient_functional_similarity: 1,
        skin_fit_similarity: 1,
        social_reference_strength: 1,
        price_distance: 1,
        brand_constraint: 0,
        quality: 1,
      },
    });

    const routed = routeCandidates(anchor, [sameBrandCandidate], {
      allow_same_brand_competitors: false,
      allow_same_brand_dupes: false,
    });

    expect(Array.isArray(routed.comp_pool)).toBe(true);
    expect(routed.comp_pool.length).toBe(0);
  });

  test('reasons align with top feature contributions (alignment@3)', () => {
    const out = attachExplanations('competitors', makeAnchor(), [makeCandidate({
      score_breakdown: {
        category_use_case_match: 1,
        ingredient_functional_similarity: 0.9,
        skin_fit_similarity: 0.1,
        social_reference_strength: 0.1,
        price_distance: 1,
        quality: 1,
      },
    })], { lang: 'EN' });

    const candidate = out[0];
    const reasons = candidate.why_candidate.reasons_user_visible.join(' | ').toLowerCase();
    expect(candidate.why_candidate.reasons_user_visible.length).toBe(3);
    expect(reasons).toMatch(/category|ingredient|price|source quality|evidence coverage/);
  });

  test('user-visible reasons never leak internal codes/ref ids', () => {
    const out = attachExplanations('competitors', makeAnchor(), [makeCandidate({
      why_candidate: ['route_related_on_page_related_forced', 'ref_id=abc123'],
      score_breakdown: {
        category_use_case_match: 0.7,
        ingredient_functional_similarity: 0.7,
        skin_fit_similarity: 0.7,
        social_reference_strength: 0.7,
        price_distance: 0.7,
        quality: 0.7,
      },
    })], { lang: 'EN' });

    const text = JSON.stringify(out[0].why_candidate).toLowerCase();
    expect(text).not.toMatch(/route_|dedupe_|internal_|fallback_|ref_id|router\./);
    expect(sanitizeUserReasonText('route_comp_pool ref_id=123')).toBe('');
  });

  test('supports locale templates and EN fallback', () => {
    const cn = attachExplanations('competitors', makeAnchor(), [makeCandidate()], { lang: 'CN' })[0];
    const fallback = attachExplanations('competitors', makeAnchor(), [makeCandidate()], { lang: 'XX' })[0];

    expect(JSON.stringify(cn.why_candidate)).toMatch(/[\u4e00-\u9fa5]/);
    expect(JSON.stringify(fallback.why_candidate)).toMatch(/[A-Za-z]/);
  });

  test('evidence refs include taxonomy/ingredient/price/social when available', () => {
    const out = attachExplanations('competitors', makeAnchor({ price: 100 }), [makeCandidate({
      category_taxonomy: ['serum', 'hydration'],
      key_ingredients: ['niacinamide', 'panthenol'],
      price: 90,
      social_ref_score: 0.82,
      evidence_refs: [],
      score_breakdown: {
        category_use_case_match: 0.9,
        ingredient_functional_similarity: 0.9,
        skin_fit_similarity: 0.7,
        social_reference_strength: 0.82,
        price_distance: 0.9,
        quality: 0.8,
      },
    })], { lang: 'EN' });

    const refs = out[0].evidence_refs.map((r) => String(r.source_type || '').toLowerCase());
    expect(refs).toEqual(expect.arrayContaining(['taxonomy', 'ingredient', 'price', 'social']));
  });
});
