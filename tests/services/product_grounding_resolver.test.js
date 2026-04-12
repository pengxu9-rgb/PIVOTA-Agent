const {
  createProductGroundingResolver,
  _internals,
} = require('../../src/services/productGroundingResolver');

describe('productGroundingResolver', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.PIVOTA_BACKEND_BASE_URL = ORIGINAL_ENV.PIVOTA_BACKEND_BASE_URL;
    process.env.PIVOTA_API_BASE = ORIGINAL_ENV.PIVOTA_API_BASE;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = ORIGINAL_ENV.PIVOTA_BACKEND_AGENT_API_KEY;
    process.env.PIVOTA_API_KEY = ORIGINAL_ENV.PIVOTA_API_KEY;
  });

  afterAll(() => {
    process.env.PIVOTA_BACKEND_BASE_URL = ORIGINAL_ENV.PIVOTA_BACKEND_BASE_URL;
    process.env.PIVOTA_API_BASE = ORIGINAL_ENV.PIVOTA_API_BASE;
    process.env.PIVOTA_BACKEND_AGENT_API_KEY = ORIGINAL_ENV.PIVOTA_BACKEND_AGENT_API_KEY;
    process.env.PIVOTA_API_KEY = ORIGINAL_ENV.PIVOTA_API_KEY;
  });

  test('extractResolverHints includes search aliases in alias pack', () => {
    const out = _internals.extractResolverHints({
      brand: 'SKIN1004',
      name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
      search_aliases: [
        'Madagascar Centella Hyalu Cica Water Fit Sun Serum SPF 50 Plus',
        'Water-Fit Sun Serum',
      ],
      searchAliases: ['Skin1004 Water Fit Sun Serum'],
    });

    expect(out.aliases).toEqual(
      expect.arrayContaining([
        'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
        'SKIN1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
        'Madagascar Centella Hyalu Cica Water Fit Sun Serum SPF 50 Plus',
        'Water-Fit Sun Serum',
        'Skin1004 Water Fit Sun Serum',
      ]),
    );
  });

  test('buildExternalSeedResolverPatterns keeps normalized alias variants for recall lookup', () => {
    const patterns = _internals.buildExternalSeedResolverPatterns({
      query: 'SKIN1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
      aliases: [
        'Madagascar Centella Hyalu Cica Water Fit Sun Serum SPF 50 Plus',
        'Water Fit Sun Serum',
      ],
    });

    expect(patterns).toEqual(
      expect.arrayContaining([
        '%skin1004 madagascar centella hyalu-cica water-fit sun serum spf50+%',
        '%skin1004 madagascar centella hyalu cica water fit sun serum spf50 plus%',
        '%madagascar centella hyalu cica water fit sun serum spf 50 plus%',
        '%water fit sun serum%',
      ]),
    );
  });

  test('resolveProductRef reads upstream base and key from environment', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://catalog.test';
    process.env.PIVOTA_API_KEY = 'test_key';

    const fetchProductsCache = jest.fn().mockResolvedValue({ ok: false, products: [], reason: 'db_not_configured' });
    const fetchAgentSearch = jest.fn().mockResolvedValue({ ok: false, products: [], reason: 'no_results' });
    const fetchExternalSeedRecall = jest.fn().mockResolvedValue({ ok: false, products: [], reason: 'empty' });
    const resolve = createProductGroundingResolver({
      fetchCandidatesViaProductsCache: fetchProductsCache,
      fetchCandidatesViaAgentSearch: fetchAgentSearch,
      fetchCandidatesViaExternalSeedRecall: fetchExternalSeedRecall,
    });

    await resolve({
      query: 'Glossier Super Pure',
      options: {
        search_all_merchants: true,
        timeout_ms: 1600,
        upstream_retries: 0,
      },
    });

    expect(fetchAgentSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        pivotaApiBase: 'https://catalog.test',
        pivotaApiKey: 'test_key',
      }),
    );
  });

  test('resolveProductRef resolves exact external seed recall rows before broad search decides unresolved', async () => {
    process.env.PIVOTA_BACKEND_BASE_URL = 'https://catalog.test';
    process.env.PIVOTA_API_KEY = 'test_key';

    const fetchProductsCache = jest.fn().mockResolvedValue({ ok: false, products: [], reason: 'db_query_timeout' });
    const fetchAgentSearch = jest.fn().mockResolvedValue({ ok: false, products: [], reason: 'no_results' });
    const fetchExternalSeedRecall = jest.fn().mockResolvedValue({
      ok: true,
      reason: null,
      products: [
        {
          product_id: 'ext_skin1004_water_fit',
          merchant_id: 'external_seed',
          brand: 'SKIN1004',
          title: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
          name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
          display_name: 'Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
          product_type: 'Sunscreen',
          category: 'Sunscreen',
          source: 'external_seed',
        },
      ],
    });
    const resolve = createProductGroundingResolver({
      fetchCandidatesViaProductsCache: fetchProductsCache,
      fetchCandidatesViaAgentSearch: fetchAgentSearch,
      fetchCandidatesViaExternalSeedRecall: fetchExternalSeedRecall,
    });

    const out = await resolve({
      query: 'SKIN1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
      hints: {
        search_aliases: [
          'Madagascar Centella Hyalu Cica Water Fit Sun Serum SPF 50 Plus',
          'Water-Fit Sun Serum',
        ],
      },
      options: {
        allow_external_seed: true,
        search_all_merchants: true,
        timeout_ms: 1600,
        upstream_retries: 0,
      },
    });

    expect(fetchExternalSeedRecall).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'SKIN1004 Madagascar Centella Hyalu-Cica Water-Fit Sun Serum SPF50+',
        hintAliases: expect.arrayContaining([
          'Madagascar Centella Hyalu Cica Water Fit Sun Serum SPF 50 Plus',
          'Water-Fit Sun Serum',
        ]),
      }),
    );
    expect(out.resolved).toBe(true);
    expect(out.product_ref).toEqual({
      product_id: 'ext_skin1004_water_fit',
      merchant_id: 'external_seed',
    });
    expect(out.metadata.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'external_seed_local_recall',
          ok: true,
        }),
      ]),
    );
  });
});
