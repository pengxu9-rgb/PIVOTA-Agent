const app = require('../src/server');

const {
  beautyQueryHasAcneOilControlIntent,
  beautyProductHasAcneOilControlEvidence,
  scoreBeautyExternalSeedProduct,
  compactBeautyMainlineProductForResponse,
} = app._debug;

describe('beauty external-seed mainline relevance', () => {
  const acneQuery = 'i have acne issue and oily skin in SF';
  const intent = {
    raw: acneQuery,
    normalized: 'i have acne issue and oily skin in sf',
    beautyLike: true,
    families: [],
    safety: [],
  };

  test('acne/oily intent rejects weak body fragrance treatment rows', () => {
    const bodyMist = {
      product_id: 'sig_body_mist',
      title: 'Allover Body Mist - Green Raspberry',
      brand: 'Fenty Beauty',
      category_path: ['beauty', 'skincare', 'treat', 'body_treatment'],
      catalog_category_path: 'beauty/skincare/treat/body_treatment',
      description: 'A body mist for allover fragrance layering.',
    };

    expect(beautyQueryHasAcneOilControlIntent(acneQuery)).toBe(true);
    expect(beautyProductHasAcneOilControlEvidence(bodyMist)).toBe(false);
    expect(
      scoreBeautyExternalSeedProduct({
        product: bodyMist,
        queryText: acneQuery,
        intent,
        normalizedQuery: intent.normalized,
        queryTokens: intent.normalized.split(/\s+/),
      }).relevant,
    ).toBe(false);
  });

  test('acne/oily face intent rejects body scrub and routine-set lane drift', () => {
    const driftRows = [
      {
        product_id: 'sig_body_scrub',
        title: 'Cherry Dub Triple Action AHA Body Scrub',
        brand: 'Fenty Beauty',
        category_path: ['beauty', 'skincare', 'treat', 'body_treatment'],
        catalog_category_path: 'beauty/skincare/treat/body_treatment',
        description: 'AHA body scrub for smoother body skin.',
      },
      {
        product_id: 'sig_routine',
        title: 'Day + Night Hydrating Routine: Dew N Plump Serum + Slushie Mask',
        brand: 'Fenty Beauty',
        category_path: ['beauty', 'skincare', 'treat', 'serum'],
        catalog_category_path: 'beauty/skincare/treat/serum',
        description: 'A routine set with niacinamide and pore-refining support.',
      },
    ];

    for (const product of driftRows) {
      expect(
        scoreBeautyExternalSeedProduct({
          product,
          queryText: acneQuery,
          intent,
          normalizedQuery: intent.normalized,
          queryTokens: intent.normalized.split(/\s+/),
        }).relevant,
      ).toBe(false);
    }
  });

  test('acne/oily intent promotes evidence-backed treatment rows and emits a reason', () => {
    const azelaic = {
      product_id: 'sig_azelaic',
      title: 'Azelaic Acid 10 Ampoule',
      brand: 'SKIN1004',
      category_path: ['beauty', 'skincare', 'treat', 'serum'],
      catalog_category_path: 'beauty/skincare/treat/serum',
      description: 'Azelaic acid ampoule for blemish-prone oily skin.',
    };

    const scored = scoreBeautyExternalSeedProduct({
      product: azelaic,
      queryText: acneQuery,
      intent,
      normalizedQuery: intent.normalized,
      queryTokens: intent.normalized.split(/\s+/),
    });
    const compact = compactBeautyMainlineProductForResponse(azelaic, intent, acneQuery);

    expect(scored.relevant).toBe(true);
    expect(scored.score).toBeGreaterThan(100);
    expect(compact.recommendation_reason).toMatch(/azelaic-acid support/i);
    expect(compact.shopping_card.highlight).toBe(compact.recommendation_reason);
  });

  test('canonical lipstick rows emit a deterministic recommendation reason', () => {
    const query = 'fenty beauty lipsticks';
    const lipstickIntent = {
      raw: query,
      normalized: query,
      beautyLike: true,
      families: [],
      safety: [],
    };
    const canonicalLipstick = {
      product_id: 'sig_lipstick',
      source: 'canonical_chain',
      search_recall_source: 'canonical_chain',
      catalog_source: 'canonical_chain',
      title: 'Fenty Icon Velvet Liquid Lipstick — Noodz & Dudez',
      brand: 'Fenty Beauty',
      category_path: ['beauty', 'makeup', 'lip', 'lipstick'],
      catalog_category_path: 'beauty/makeup/lip/lipstick',
    };

    const compact = compactBeautyMainlineProductForResponse(canonicalLipstick, lipstickIntent, query);

    expect(compact.recommendation_reason).toMatch(/Fenty Beauty lipstick request/i);
    expect(compact.search_card.highlight_candidate).toBe(compact.recommendation_reason);
    expect(compact.shopping_card.highlight).toBe(compact.recommendation_reason);
  });
});
