'use strict';

describe('aurora realtime competitor recall budget control', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      PIVOTA_BACKEND_BASE_URL: 'http://catalog.test',
      AURORA_BFF_RECO_CATALOG_SEARCH_BASE_URLS: 'http://catalog.test',
      AURORA_BFF_RECO_BLOCKS_DAG_ENABLED: 'true',
      AURORA_BFF_PRODUCT_URL_COMPETITOR_PREFERRED_COUNT: '2',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('main path stops additional query fanout once enough candidates are found', async () => {
    const { __internal } = require('../src/auroraBff/routes');

    const searchFn = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        products: [
          {
            product_id: 'comp_1',
            sku_id: 'comp_1',
            brand: 'Brand A',
            name: 'Copper Peptide Serum A',
            display_name: 'Copper Peptide Serum A',
            category: 'serum',
            key_ingredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
          },
          {
            product_id: 'comp_2',
            sku_id: 'comp_2',
            brand: 'Brand B',
            name: 'Copper Peptide Serum B',
            display_name: 'Copper Peptide Serum B',
            category: 'serum',
            key_ingredients: ['Copper Tripeptide-1'],
          },
        ],
      })
      .mockImplementation(() =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              products: [
                {
                  product_id: 'slow_comp',
                  sku_id: 'slow_comp',
                  brand: 'Brand Slow',
                  name: 'Slow Candidate',
                  category: 'serum',
                },
              ],
            });
          }, 400);
        }),
      );

    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      parsedProduct: {
        product_id: 'anchor_1',
        sku_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      anchorProduct: {
        product_id: 'anchor_1',
        sku_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate', 'Acetyl Hexapeptide-8'],
      mode: 'main_path',
      maxQueries: 4,
      maxCandidates: 4,
      timeoutMs: 1000,
      deadlineMs: Date.now() + 1000,
      searchFn,
    });

    expect(Array.isArray(out.candidates)).toBe(true);
    expect(out.candidates.length).toBeGreaterThan(0);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(Array.isArray(out.queries)).toBe(true);
    expect(out.queries.length).toBe(1);
  });

  test('main path continues to next query when first query returns no candidates', async () => {
    const { __internal } = require('../src/auroraBff/routes');

    const searchFn = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, products: [] })
      .mockResolvedValueOnce({
        ok: true,
        products: [
          {
            product_id: 'comp_3',
            sku_id: 'comp_3',
            brand: 'Brand C',
            name: 'Peptide Alternative C',
            display_name: 'Peptide Alternative C',
            category: 'serum',
            key_ingredients: ['Copper Tripeptide-1'],
          },
        ],
      });

    const out = await __internal.buildRealtimeCompetitorCandidates({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      parsedProduct: {
        product_id: 'anchor_1',
        sku_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      anchorProduct: {
        product_id: 'anchor_1',
        sku_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate', 'Acetyl Hexapeptide-8'],
      mode: 'main_path',
      maxQueries: 4,
      maxCandidates: 4,
      timeoutMs: 1200,
      deadlineMs: Date.now() + 1200,
      searchFn,
    });

    expect(searchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(out.candidates)).toBe(true);
    expect(out.candidates.length).toBeGreaterThan(0);
  });
});
