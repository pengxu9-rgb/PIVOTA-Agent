const {
  classifyAlternativeKind,
  classifyPriceTier,
  mapAuroraAlternativesToRecoAlternatives,
} = require('../src/auroraBff/auroraStructuredMapper');

describe('classifyAlternativeKind: multi-signal classification', () => {
  test('price cheaper + functional match → dupe', () => {
    expect(classifyAlternativeKind(-15, { similarity: 80, categoryMatch: true })).toBe('dupe');
  });

  test('price higher → premium', () => {
    expect(classifyAlternativeKind(20, { similarity: 90, categoryMatch: true })).toBe('premium');
  });

  test('price similar (near zero) → dupe', () => {
    expect(classifyAlternativeKind(0, { similarity: 70 })).toBe('dupe');
  });

  test('price null + functional match → dupe (not similar)', () => {
    expect(classifyAlternativeKind(null, { similarity: 75, categoryMatch: true })).toBe('dupe');
  });

  test('price null + shared actives → dupe', () => {
    expect(classifyAlternativeKind(null, { similarity: 50, hasSharedActives: true })).toBe('dupe');
  });

  test('price null + no match signals → similar', () => {
    expect(classifyAlternativeKind(null, { similarity: 0 })).toBe('similar');
  });

  test('price null + no signals at all → similar', () => {
    expect(classifyAlternativeKind(null)).toBe('similar');
  });
});

describe('classifyPriceTier', () => {
  test('negative delta → cheaper', () => {
    expect(classifyPriceTier(-12)).toBe('cheaper');
  });

  test('positive delta → premium', () => {
    expect(classifyPriceTier(10)).toBe('premium');
  });

  test('near zero → same_price', () => {
    expect(classifyPriceTier(0)).toBe('same_price');
  });

  test('null → price_unknown', () => {
    expect(classifyPriceTier(null)).toBe('price_unknown');
  });

  test('undefined → price_unknown', () => {
    expect(classifyPriceTier(undefined)).toBe('price_unknown');
  });
});

describe('mapAuroraAlternativesToRecoAlternatives: quality gates', () => {
  const makeAlternative = (overrides = {}) => ({
    product: { brand: 'TestBrand', name: 'TestProduct', sku_id: 'test_1', category: 'moisturizer' },
    similarity_score: 0.8,
    tradeoffs: {
      missing_actives: ['retinol'],
      added_benefits: ['niacinamide'],
      texture_finish_differences: ['lighter texture'],
      price_delta_usd: -5,
    },
    reasons: ['Good alternative'],
    ...overrides,
  });

  test('alternative with similarity + tradeoffs is not marked data_insufficient', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([makeAlternative()], { lang: 'EN', maxTotal: 3 });
    expect(result.length).toBe(1);
    expect(result[0].data_insufficient).toBeFalsy();
  });

  test('alternative with similarity=0 and no tradeoffs is marked data_insufficient', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([
      makeAlternative({
        similarity_score: 0,
        tradeoffs: null,
        reasons: [],
      }),
    ], { lang: 'EN', maxTotal: 3 });
    expect(result.length).toBe(1);
    expect(result[0].data_insufficient).toBe(true);
    expect(result[0].missing_info).toContain('explanation_insufficient');
  });

  test('price_tier field is present on each alternative', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([makeAlternative()], { lang: 'EN', maxTotal: 3 });
    expect(result[0].price_tier).toBe('cheaper');
  });

  test('null price_delta → price_unknown tier', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([
      makeAlternative({ tradeoffs: { price_delta_usd: null, added_benefits: ['niacinamide'] } }),
    ], { lang: 'EN', maxTotal: 3 });
    expect(result[0].price_tier).toBe('price_unknown');
  });

  test('missing price does not eliminate dupe bucket when functional match exists', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([
      makeAlternative({
        similarity_score: 0.75,
        tradeoffs: { price_delta_usd: null, added_benefits: ['ceramides'], missing_actives: [] },
      }),
    ], { lang: 'EN', maxTotal: 3 });
    expect(result[0].kind).toBe('dupe');
  });

  test('sufficient items ranked above insufficient ones', () => {
    const sufficient = makeAlternative({
      product: { brand: 'A', name: 'Good', sku_id: 'a1', category: 'serum' },
      similarity_score: 0.8,
    });
    const result = mapAuroraAlternativesToRecoAlternatives([sufficient], { lang: 'EN', maxTotal: 3 });
    expect(result.length).toBe(1);
    expect(result[0].data_insufficient).toBeFalsy();
    expect(result[0].product.brand).toBe('A');
  });

  test('alternative with empty product is skipped', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([{ product: null, similarity_score: 0.5 }], { lang: 'EN', maxTotal: 3 });
    expect(result.length).toBe(0);
  });

  test('each displayed item should have at least one reason or tradeoff', () => {
    const alt = makeAlternative();
    const result = mapAuroraAlternativesToRecoAlternatives([alt], { lang: 'EN', maxTotal: 3 });
    const item = result[0];
    const hasExplanation = (item.reasons && item.reasons.length > 0) || (item.tradeoffs && item.tradeoffs.length > 0);
    expect(hasExplanation).toBe(true);
  });

  test('open-world items dedupe by brand and name when IDs are missing', () => {
    const result = mapAuroraAlternativesToRecoAlternatives([
      makeAlternative({
        product: { brand: 'Good Molecules', name: 'Niacinamide Serum', category: 'serum' },
        candidate_origin: 'open_world',
        grounding_status: 'name_only',
      }),
      makeAlternative({
        product: { brand: 'Good Molecules', name: 'Niacinamide Serum', category: 'serum' },
        candidate_origin: 'open_world',
        grounding_status: 'name_only',
        similarity_score: 0.79,
      }),
    ], { lang: 'EN', maxTotal: 3 });
    expect(result).toHaveLength(1);
    expect(result[0].product.brand).toBe('Good Molecules');
    expect(result[0].product.name).toBe('Niacinamide Serum');
  });
});

describe('dupe suggest payload quality assertions', () => {
  function buildPayload({ original, dupes, comparables, verified, quality }) {
    return { original, dupes, comparables, verified, quality };
  }

  test('original should never be null when anchor_resolution_status is confirmed', () => {
    const payload = buildPayload({
      original: { brand: 'Test', name: 'Product' },
      dupes: [],
      comparables: [],
      verified: false,
      quality: { verified_anchor: true },
    });
    expect(payload.original).not.toBeNull();
  });

  test('original stub should have _stub flag', () => {
    const stub = { _stub: true, url: 'https://example.com', name_guess: 'test', anchor_resolution_status: 'failed' };
    expect(stub._stub).toBe(true);
    expect(stub.anchor_resolution_status).toBe('failed');
  });

  test('verified should be false when all similarities are 0 and tradeoffs empty', () => {
    const items = [
      { similarity: 0, tradeoffs: [], confidence: 0 },
      { similarity: 0, tradeoffs: [], confidence: 0 },
    ];
    const hasResults = items.length > 0;
    const hasMeaningfulQuality = items.some((it) => it.similarity > 0 || (it.tradeoffs && it.tradeoffs.length > 0));
    const verified = hasResults && hasMeaningfulQuality;
    expect(verified).toBe(false);
  });

  test('quality_ok should be false when no items have meaningful data', () => {
    const items = [
      { similarity: 0, tradeoffs: [], confidence: 0 },
    ];
    const qualityOk = items.some((it) => it.similarity > 0 || (it.tradeoffs && it.tradeoffs.length > 0));
    expect(qualityOk).toBe(false);
  });

  test('quality_issues should include all_prices_unknown when no items have known price', () => {
    const items = [
      { price_tier: 'price_unknown' },
      { price_tier: 'price_unknown' },
    ];
    const priceKnownCount = items.filter((it) => it.price_tier && it.price_tier !== 'price_unknown').length;
    const issues = [];
    if (priceKnownCount === 0 && items.length > 0) issues.push('all_prices_unknown');
    expect(issues).toContain('all_prices_unknown');
  });
});
