const ORIGINAL_ENV = process.env;

describe('PDP grouped offers', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      PDP_OFFER_GROUP_MEMBER_FETCH_TIMEOUT_MS: '50',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('returns resolved offers without blocking on unresolved external seed members', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_krave_gbr',
      debug: true,
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_krave_gbr',
          source_kind: 'external_seed',
          source_payload: {
            title: 'Great Barrier Relief',
            brand: 'KraveBeauty',
            price: { amount: 28, currency: 'USD' },
            store_discount_badges: ['Should not leak'],
            payment_offer_badges: ['Should not leak either'],
            variants: [
              {
                variant_id: 'seed-standard',
                title: 'Standard - 45 mL',
                price: { amount: 28, currency: 'USD' },
                store_discount_badges: ['Variant should not leak'],
              },
            ],
          },
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_missing_member',
          source_kind: 'external_seed',
        },
      ],
    });

    expect(offersData).toEqual(expect.objectContaining({
      product_group_id: 'sig_krave_gbr',
      offers_count: 1,
    }));
    expect(offersData.offers).toHaveLength(1);
    expect(offersData.offers[0]).toEqual(
      expect.not.objectContaining({
        store_discount_badges: expect.anything(),
        payment_offer_badges: expect.anything(),
      }),
    );
    expect(offersData.offers[0].variants[0]).toEqual(
      expect.not.objectContaining({
        store_discount_badges: expect.anything(),
      }),
    );
    expect(offersData.diagnostics.build_sources.unresolved).toBe(1);
    expect(offersData.diagnostics.unresolved_members).toEqual([
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_missing_member',
        reason: 'member_unavailable',
      }),
    ]);
  });

  test('defers slow similar results at the PDP module budget boundary', async () => {
    const app = require('../src/server');
    const startedAt = Date.now();

    const result = await app._debug.resolvePdpSimilarWithBudget(
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            status: 'success',
            strategy: 'related_products',
            items: [{ product_id: 'late_1', title: 'Late similar' }],
            metadata: { similar_status: 'ready' },
          });
        }, 120);
      }),
      40,
    );

    expect(Date.now() - startedAt).toBeLessThan(120);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'deferred',
        strategy: 'related_products',
        items: [],
        metadata: expect.objectContaining({
          similar_status: 'deferred',
          reason_code: 'SIMILAR_STAGE_BUDGET_EXCEEDED',
          sync_budget_ms: 40,
        }),
      }),
    );
  });

  test('preserves recommendation metadata when similar items are returned through canonical payload', () => {
    const app = require('../src/server');

    const merged = app._debug.mergeRecommendationModuleWithEnvelope(
      {
        strategy: 'related_products',
        items: [{ product_id: 'similar_1', title: 'Similar' }],
      },
      {
        status: 'success',
        metadata: {
          similar_status: 'ready',
          similar_confidence: 'medium',
          low_confidence: false,
          retrieval_mix: { external: 1, internal: 0 },
        },
      },
    );

    expect(merged).toEqual(
      expect.objectContaining({
        status: 'success',
        metadata: expect.objectContaining({
          similar_status: 'ready',
          similar_confidence: 'medium',
          retrieval_mix: { external: 1, internal: 0 },
        }),
      }),
    );
  });
});
