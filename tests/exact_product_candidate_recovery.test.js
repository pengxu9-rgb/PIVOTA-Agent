describe('exact product candidate detail-scan recovery', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.resetModules();
    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('recovers internal exact-id candidates from configured merchants', async () => {
    const app = require('../src/server');
    const { recoverExactProductCandidatesByDetailScan } = app._debug;
    const seenMerchantIds = [];

    const result = await recoverExactProductCandidatesByDetailScan({
      productId: '9860766990664',
      merchantIds: ['merch_a', 'merch_b'],
      limit: 10,
      fetchDetail: async ({ merchantId, productId }) => {
        seenMerchantIds.push(merchantId);
        if (merchantId !== 'merch_b') return null;
        return {
          merchant_id: merchantId,
          merchant_name: 'Nina Studio',
          product_id: productId,
          platform: 'shopify',
          price: 23.09,
          currency: 'EUR',
        };
      },
    });

    expect(seenMerchantIds).toEqual(['merch_a', 'merch_b']);
    expect(result.product_group_id).toBe('pg:pid:9860766990664');
    expect(result.members).toEqual([
      {
        merchant_id: 'merch_b',
        merchant_name: 'Nina Studio',
        product_id: '9860766990664',
        platform: 'shopify',
        is_primary: true,
      },
    ]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0].merchant_id).toBe('merch_b');
  });

  test('probes external seed merchant for ext_* product ids', async () => {
    const app = require('../src/server');
    const { recoverExactProductCandidatesByDetailScan } = app._debug;
    const seenMerchantIds = [];

    const result = await recoverExactProductCandidatesByDetailScan({
      productId: 'ext_89fd8f89ad4e033bce6b98c2',
      merchantIds: ['merch_a'],
      limit: 10,
      fetchDetail: async ({ merchantId, productId }) => {
        seenMerchantIds.push(merchantId);
        if (merchantId !== 'external_seed') return null;
        return {
          merchant_id: merchantId,
          merchant_name: 'External Seed Catalog',
          product_id: productId,
          platform: 'external_seed',
          price: 20,
          currency: 'USD',
        };
      },
    });

    expect(seenMerchantIds).toContain('external_seed');
    expect(result.members).toEqual([
      {
        merchant_id: 'external_seed',
        merchant_name: 'External Seed Catalog',
        product_id: 'ext_89fd8f89ad4e033bce6b98c2',
        platform: 'external_seed',
        is_primary: true,
      },
    ]);
    expect(result.products).toHaveLength(1);
    expect(result.products[0].merchant_id).toBe('external_seed');
  });
});
