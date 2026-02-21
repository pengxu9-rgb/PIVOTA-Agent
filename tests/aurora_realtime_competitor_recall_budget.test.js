'use strict';

const nock = require('nock');

describe('aurora realtime competitor recall budget control', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
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
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_RESOLVE_FALLBACK = 'false';
    process.env.AURORA_BFF_RECO_COMPETITOR_MAIN_QUERY_FANOUT_CAP = '4';
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

  test('main path defaults to a single query fanout when resolve fallback is enabled', async () => {
    const { __internal } = require('../src/auroraBff/routes');
    const searchFn = jest.fn().mockResolvedValueOnce({ ok: true, products: [] });

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

    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(Array.isArray(out.queries)).toBe(true);
    expect(out.queries.length).toBe(1);
  });

  test('async backfill allocates most budget to first query timeout', async () => {
    const { __internal } = require('../src/auroraBff/routes');

    const searchFn = jest.fn().mockResolvedValueOnce({
      ok: true,
      products: [
        {
          product_id: 'comp_async_1',
          sku_id: 'comp_async_1',
          brand: 'Brand Async',
          name: 'Copper Peptide Async Candidate',
          display_name: 'Copper Peptide Async Candidate',
          category: 'serum',
          key_ingredients: ['Copper Tripeptide-1'],
        },
      ],
    });

    const timeoutBudgetMs = 8200;
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
      keyIngredients: ['Copper Tripeptide-1', 'Sodium Hyaluronate'],
      mode: 'async_backfill',
      maxQueries: 3,
      maxCandidates: 1,
      timeoutMs: timeoutBudgetMs,
      deadlineMs: Date.now() + timeoutBudgetMs,
      searchFn,
    });

    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(Array.isArray(out.candidates)).toBe(true);
    expect(out.candidates.length).toBeGreaterThan(0);
    const firstCall = searchFn.mock.calls[0][0] || {};
    expect(firstCall.timeoutMs).toBeGreaterThanOrEqual(6000);
    expect(firstCall.timeoutMs).toBeLessThanOrEqual(timeoutBudgetMs);
  });

  test('runRecoBlocksForUrl async_backfill can return competitors after long catalog latency', async () => {
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_BACKFILL_TIMEOUT_MS = '8200';
    process.env.AURORA_BFF_PRODUCT_URL_COMPETITOR_BACKFILL_MAX_QUERIES = '1';
    process.env.AURORA_BFF_RECO_BLOCKS_BUDGET_MS = '1200';
    process.env.AURORA_BFF_RECO_BLOCKS_TIMEOUT_CATALOG_ANN_MS = '450';

    nock('http://catalog.test')
      .persist()
      .get('/agent/v1/products/search')
      .query(true)
      .delayConnection(3500)
      .reply(200, {
        products: [
          {
            product_id: 'comp_async_latency_1',
            sku_id: 'comp_async_latency_1',
            brand: 'Another Brand',
            name: 'Copper Peptide Serum Alternative',
            display_name: 'Copper Peptide Serum Alternative',
            category: 'serum',
            key_ingredients: ['Copper Tripeptide-1', 'Acetyl Hexapeptide-8'],
          },
        ],
      });

    const { __internal } = require('../src/auroraBff/routes');
    const out = await __internal.runRecoBlocksForUrl({
      productUrl: 'https://theordinary.com/en-al/multi-peptide-copper-peptides-1-serum-100625.html',
      anchorProduct: {
        product_id: 'anchor_1',
        sku_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      parsedProduct: {
        product_id: 'anchor_1',
        sku_id: 'anchor_1',
        brand: 'The Ordinary',
        name: 'Multi-Peptide + Copper Peptides 1% Serum',
        category: 'serum',
      },
      keyIngredients: ['Copper Tripeptide-1', 'Acetyl Hexapeptide-8'],
      lang: 'EN',
      mode: 'async_backfill',
      budgetMs: 9000,
      maxCandidates: 4,
    });

    const competitors = Array.isArray(out?.competitors?.candidates) ? out.competitors.candidates : [];
    expect(competitors.length).toBeGreaterThan(0);
    expect(
      competitors.some((row) => String(row?.source?.type || row?.source_type || '').toLowerCase() === 'on_page_related'),
    ).toBe(false);
  }, 20000);
});
