function loadRecoBlocks({ mockRouter = false } = {}) {
  let recoBlocks;
  jest.isolateModules(() => {
    if (mockRouter) {
      jest.doMock('../src/auroraBff/competitorBlockRouter', () => ({
        routeCandidates: jest.fn(() => ({
          comp_pool: [],
          rel_pool: [],
          dupe_pool: [],
        })),
      }));
    } else {
      jest.unmock('../src/auroraBff/competitorBlockRouter');
    }
    jest.unmock('../src/auroraBff/recoBlocksDag');
    ({ recoBlocks } = require('../src/auroraBff/recoBlocksDag'));
  });
  return recoBlocks;
}

describe('aurora reco blocks dag on-page fallback adoption', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.dontMock('../src/auroraBff/competitorBlockRouter');
    jest.dontMock('../src/auroraBff/recoBlocksDag');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.resetModules();
    jest.dontMock('../src/auroraBff/competitorBlockRouter');
    jest.dontMock('../src/auroraBff/recoBlocksDag');
  });

  test('related_on_page_fallback still adopts on-page candidates when router returns empty rel_pool', async () => {
    const recoBlocks = loadRecoBlocks({ mockRouter: true });

    const out = await recoBlocks(
      {
        brand_id: 'anchor_brand',
        category_taxonomy: ['serum'],
        price: 100,
      },
      {
        mode: 'main_path',
        timeouts_ms: {
          catalog_ann: 25,
          ingredient_index: 25,
          skin_fit_light: 25,
          kb_backfill: 25,
          dupe_pipeline: 25,
          on_page_related: 80,
        },
        sources: {
          catalog_ann: async () => ({ candidates: [] }),
          ingredient_index: async () => ({ candidates: [] }),
          skin_fit_light: async () => ({ candidates: [] }),
          kb_backfill: async () => ({ candidates: [], competitors: [], dupes: [] }),
          dupe_pipeline: async () => ({ candidates: [] }),
          on_page_related: async () => ({
            candidates: [
              {
                product_id: 'on_page_1',
                brand_id: 'other_brand',
                category_match: 0.9,
                similarity_score: 0.94,
                price: 75,
                source: { type: 'on_page_related' },
              },
            ],
          }),
        },
      },
      300,
    );

    const competitors = Array.isArray(out?.competitors?.candidates) ? out.competitors.candidates : [];
    const related = Array.isArray(out?.related_products?.candidates) ? out.related_products.candidates : [];

    expect(competitors).toEqual([]);
    expect(related.map((item) => item.product_id)).toContain('on_page_1');
    expect(
      related.some((item) => String(item?.source?.type || '').toLowerCase() === 'on_page_related'),
    ).toBe(true);
    expect(Array.isArray(out?.provenance_patch?.fallbacks_used)).toBe(true);
    expect(out.provenance_patch.fallbacks_used).toContain('related_on_page_fallback');
  });
});
