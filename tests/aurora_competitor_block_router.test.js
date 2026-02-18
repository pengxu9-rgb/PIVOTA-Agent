const { routeCandidates } = require('../src/auroraBff/competitorBlockRouter');

function makeAnchor(overrides = {}) {
  return {
    brand_id: 'brand_anchor',
    category_taxonomy: ['serum', 'face'],
    price: 100,
    ...overrides,
  };
}

function makeCandidate(overrides = {}) {
  return {
    product_id: `p_${Math.random().toString(36).slice(2, 9)}`,
    brand_id: 'brand_other',
    category_match: 0.9,
    similarity_score: 0.72,
    price: 95,
    source: { type: 'catalog_search' },
    ...overrides,
  };
}

describe('competitor block router hard gates', () => {
  test('on_page_related is always routed to related_products (never competitors/dupes)', () => {
    const anchor = makeAnchor();
    const candidate = makeCandidate({
      product_id: 'on_page_1',
      similarity_score: 0.96,
      price: 60,
      source: { type: 'on_page_related' },
    });

    const out = routeCandidates(anchor, [candidate], {});

    expect(out.comp_pool).toHaveLength(0);
    expect(out.dupe_pool).toHaveLength(0);
    expect(out.rel_pool).toHaveLength(1);
    expect(out.rel_pool[0].product_id).toBe('on_page_1');
  });

  test('competitors hard gate blocks same-brand candidate by default', () => {
    const anchor = makeAnchor({ brand_id: 'brand_same' });
    const candidate = makeCandidate({
      product_id: 'same_brand_1',
      brand_id: 'brand_same',
      category_match: 0.95,
      similarity_score: 0.7,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [candidate], {});

    expect(out.comp_pool).toHaveLength(0);
    const trace = out.internal_reason_codes.find((x) => x.candidate_key === 'same_brand_1');
    expect(trace?.reason_codes || []).toContain('competitor_same_brand_blocked');
  });

  test('competitors can allow same brand when explicitly enabled', () => {
    const anchor = makeAnchor({ brand_id: 'brand_same' });
    const candidate = makeCandidate({
      product_id: 'same_brand_allowed',
      brand_id: 'brand_same',
      category_match: 0.9,
      similarity_score: 0.7,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [candidate], { allow_same_brand_competitors: true });

    expect(out.comp_pool).toHaveLength(1);
    expect(out.comp_pool[0].product_id).toBe('same_brand_allowed');
  });

  test('dupe hard gate requires cross-brand + high similarity + cheaper/equal price', () => {
    const anchor = makeAnchor({ brand_id: 'brand_anchor', price: 100 });
    const dupeCandidate = makeCandidate({
      product_id: 'dupe_ok_1',
      brand_id: 'brand_other',
      category_match: 0.9,
      similarity_score: 0.9,
      price: 85,
      source: { type: 'catalog_search' },
    });
    const lowSimCandidate = makeCandidate({
      product_id: 'dupe_low_sim',
      brand_id: 'brand_other2',
      category_match: 0.9,
      similarity_score: 0.7,
      price: 80,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [dupeCandidate, lowSimCandidate], {});

    expect(out.dupe_pool.map((x) => x.product_id)).toContain('dupe_ok_1');
    expect(out.dupe_pool.map((x) => x.product_id)).not.toContain('dupe_low_sim');
  });

  test('dupe hard gate blocks expensive candidate even when similarity is high', () => {
    const anchor = makeAnchor({ price: 100 });
    const candidate = makeCandidate({
      product_id: 'dupe_price_blocked',
      similarity_score: 0.92,
      price: 130,
      category_match: 0.9,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [candidate], {});

    expect(out.dupe_pool).toHaveLength(0);
    expect(out.comp_pool.map((x) => x.product_id)).toContain('dupe_price_blocked');
    const trace = out.internal_reason_codes.find((x) => x.candidate_key === 'dupe_price_blocked');
    expect(trace?.reason_codes || []).toContain('dupe_price_ratio_above_threshold');
  });

  test('competitors must pass category/use-case threshold', () => {
    const anchor = makeAnchor();
    const candidate = makeCandidate({
      product_id: 'cat_mismatch_1',
      category_match: 0.2,
      similarity_score: 0.4,
      price: 90,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [candidate], {});

    expect(out.comp_pool).toHaveLength(0);
    const trace = out.internal_reason_codes.find((x) => x.candidate_key === 'cat_mismatch_1');
    expect(trace?.reason_codes || []).toContain('competitor_category_match_below_threshold');
  });

  test('dedupes variant family by product_family_id before routing', () => {
    const anchor = makeAnchor({ price: 100 });
    const weaker = makeCandidate({
      product_id: 'family_low',
      product_family_id: 'fam_1',
      similarity_score: 0.55,
      category_match: 0.9,
      price: 120,
      source: { type: 'catalog_search' },
    });
    const stronger = makeCandidate({
      product_id: 'family_high',
      product_family_id: 'fam_1',
      similarity_score: 0.88,
      category_match: 0.9,
      price: 115,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [weaker, stronger], {});
    const allIds = [...out.comp_pool, ...out.dupe_pool, ...out.rel_pool].map((x) => x.product_id);

    expect(allIds).toContain('family_high');
    expect(allIds).not.toContain('family_low');
    expect(out.internal_reason_codes.some((x) => (x.reason_codes || []).includes('dedupe_product_family_id'))).toBe(true);
  });

  test('dedupes variant family by variant_of before routing', () => {
    const anchor = makeAnchor({ price: 100 });
    const weaker = makeCandidate({
      product_id: 'variant_low',
      variant_of: 'root_1',
      similarity_score: 0.6,
      category_match: 0.9,
      price: 110,
      source: { type: 'catalog_search' },
    });
    const stronger = makeCandidate({
      product_id: 'variant_high',
      variant_of: 'root_1',
      similarity_score: 0.86,
      category_match: 0.9,
      price: 112,
      source: { type: 'catalog_search' },
    });

    const out = routeCandidates(anchor, [weaker, stronger], {});
    const allIds = [...out.comp_pool, ...out.dupe_pool, ...out.rel_pool].map((x) => x.product_id);

    expect(allIds).toContain('variant_high');
    expect(allIds).not.toContain('variant_low');
    expect(out.internal_reason_codes.some((x) => (x.reason_codes || []).includes('dedupe_variant_of'))).toBe(true);
  });

  test('on_page_related never enters dupe pool even if dupe thresholds pass', () => {
    const anchor = makeAnchor({ price: 100 });
    const candidate = makeCandidate({
      product_id: 'on_page_dupe_like',
      similarity_score: 0.99,
      price: 60,
      source: { type: 'on_page_related' },
    });

    const out = routeCandidates(anchor, [candidate], {
      allow_same_brand_competitors: true,
      allow_same_brand_dupes: true,
    });

    expect(out.dupe_pool).toHaveLength(0);
    expect(out.rel_pool.map((x) => x.product_id)).toContain('on_page_dupe_like');
  });

  test('acceptance ratios: same-brand competitors=0, on-page competitors/dupes=0 in default mode', () => {
    const anchor = makeAnchor({ brand_id: 'brand_anchor', price: 100 });
    const candidates = [
      makeCandidate({ product_id: 'c1', brand_id: 'brand_anchor', category_match: 0.9, source: { type: 'catalog_search' } }),
      makeCandidate({ product_id: 'c2', brand_id: 'brand_other', similarity_score: 0.9, price: 80, category_match: 0.9, source: { type: 'on_page_related' } }),
      makeCandidate({ product_id: 'c3', brand_id: 'brand_other', similarity_score: 0.88, price: 95, category_match: 0.9, source: { type: 'catalog_search' } }),
    ];

    const out = routeCandidates(anchor, candidates, {});

    const sameBrandCompetitorRatio = out.comp_pool.length
      ? out.comp_pool.filter((x) => String(x.brand_id || '').toLowerCase() === 'brand_anchor').length / out.comp_pool.length
      : 0;
    const onPageCompetitorRatio = out.comp_pool.length
      ? out.comp_pool.filter((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related').length / out.comp_pool.length
      : 0;
    const onPageDupeRatio = out.dupe_pool.length
      ? out.dupe_pool.filter((x) => String(x?.source?.type || '').toLowerCase() === 'on_page_related').length / out.dupe_pool.length
      : 0;

    expect(sameBrandCompetitorRatio).toBe(0);
    expect(onPageCompetitorRatio).toBe(0);
    expect(onPageDupeRatio).toBe(0);
  });
});
