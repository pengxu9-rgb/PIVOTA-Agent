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

  test('builds display-safe Shopify store discount evidence from promotion metadata', () => {
    const app = require('../src/server');

    const evidenceByTarget = app._debug.resolveStoreDiscountEvidenceFromPromotionMetadata({
      promotions: [
        {
          id: 'promo_shopify_amount10',
          merchantId: 'merch_shopify',
          name: 'PIVOTA_TEST_AMOUNT10',
          type: 'MULTI_BUY_DISCOUNT',
          status: 'ACTIVE',
          startAt: '2025-01-01T00:00:00Z',
          endAt: null,
          scope: {
            shopifyItems: {
              __typename: 'DiscountProducts',
              productIds: ['gid://shopify/Product/10064558096681'],
            },
          },
          config: {
            source: 'shopify_discount_node',
            shopifyDiscountNodeId: 'gid://shopify/DiscountNode/1',
            discountMethod: 'code',
            discountType: 'basic',
            status: 'ACTIVE',
            summary: '$10 off test product',
            discountClasses: ['PRODUCT'],
            combinesWith: { orderDiscounts: true, productDiscounts: false, shippingDiscounts: true },
            codes: ['PIVOTA_TEST_AMOUNT10'],
          },
        },
        {
          id: 'promo_manual_should_skip',
          merchantId: 'merch_shopify',
          name: 'Manual fallback promo',
          type: 'MULTI_BUY_DISCOUNT',
          status: 'ACTIVE',
          startAt: '2025-01-01T00:00:00Z',
          endAt: null,
          scope: { global: true },
          config: { source: 'manual', summary: 'Should not display as store-native evidence' },
        },
      ],
      targets: [
        {
          target_id: 'merch_shopify:10064558096681',
          merchant_id: 'merch_shopify',
          product_id: '10064558096681',
          quantity: 1,
          subtotal: 28,
          currency: 'USD',
        },
      ],
    });

    const evidence = evidenceByTarget['merch_shopify:10064558096681'];
    expect(evidence).toEqual(
      expect.objectContaining({
        pricing_confidence: 'metadata_available',
        resolver_scope: 'store_discount_metadata',
        presentation_contract_version: 'savings.v1',
      }),
    );
    expect(evidence.offers).toHaveLength(1);
    expect(evidence.offers[0]).toEqual(
      expect.objectContaining({
        store_discount_id: 'promo_shopify_amount10',
        source_system: 'shopify_discount_node',
        platform: 'shopify',
        discount_method: 'code',
        discount_type: 'basic',
        status: 'available',
        scope_reason: 'product_scope_match',
        codes: ['PIVOTA_TEST_AMOUNT10'],
        application_policy: expect.objectContaining({
          affects_checkout_total_before_quote: false,
          requires_storefront_allocation_for_applied_amount: true,
        }),
      }),
    );
    expect(app._debug.summarizeStoreDiscountEvidence(evidence)).toEqual(
      expect.objectContaining({
        has_store_discounts: true,
        offers_count: 1,
        badges: ['Code PIVOTA_TEST_AMOUNT10'],
      }),
    );
  });

  test('attaches Shopify store discount evidence to internal offers without polluting external seeds', async () => {
    jest.doMock('../src/promotionStore', () => ({
      getAllPromotions: async () => [
        {
          id: 'promo_shopify_bxgy',
          merchantId: 'merch_shopify',
          name: 'PIVOTA_TEST_BXGY',
          type: 'MULTI_BUY_DISCOUNT',
          status: 'ACTIVE',
          startAt: '2025-01-01T00:00:00Z',
          endAt: null,
          scope: {
            shopifyItems: {
              __typename: 'AllDiscountItems',
            },
          },
          config: {
            source: 'shopify_discount_node',
            shopifyDiscountNodeId: 'gid://shopify/DiscountNode/2',
            discountMethod: 'code',
            discountType: 'bxgy',
            status: 'ACTIVE',
            summary: 'Buy 3, get 1 free',
            minimumRequirement: {
              __typename: 'DiscountMinimumQuantity',
              greaterThanOrEqualToQuantity: 3,
            },
            codes: ['PIVOTA_TEST_BXGY'],
          },
        },
      ],
      getPromotionById: jest.fn(),
      upsertPromotion: jest.fn(),
      softDeletePromotion: jest.fn(),
    }));
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_krave_gbr',
      debug: true,
      members: [
        {
          merchant_id: 'merch_shopify',
          product_id: '10064558096681',
          merchant_name: 'Shopify Test Store',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_krave_gbr',
          source_kind: 'external_seed',
          source_payload: {
            title: 'Great Barrier Relief',
            brand: 'KraveBeauty',
            price: { amount: 28, currency: 'USD' },
            store_discount_evidence: {
              offers: [{ store_discount_id: 'should_not_leak' }],
            },
          },
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'merch_shopify',
          product_id: '10064558096681',
          title: 'Great Barrier Relief',
          brand: 'KraveBeauty',
          price: { amount: 28, currency: 'USD' },
        },
      ],
    });

    const internalOffer = offersData.offers.find((offer) => offer.merchant_id === 'merch_shopify');
    const externalOffer = offersData.offers.find((offer) => offer.merchant_id === 'external_seed');
    expect(internalOffer?.store_discount_evidence).toEqual(
      expect.objectContaining({
        pricing_confidence: 'metadata_unlockable',
        offers: [
          expect.objectContaining({
            store_discount_id: 'promo_shopify_bxgy',
            discount_type: 'bxgy',
            status: 'unlockable',
            minimum_requirement: expect.objectContaining({
              quantity_required: 3,
              current_quantity: 1,
              remaining_quantity: 2,
            }),
          }),
        ],
      }),
    );
    expect(internalOffer?.store_discount_summary).toEqual(
      expect.objectContaining({
        has_store_discounts: true,
        offers_count: 1,
        badges: ['Buy 3, get 1 free'],
      }),
    );
    expect(externalOffer?.store_discount_evidence).toBeUndefined();
    expect(offersData.diagnostics.store_discount_evidence).toEqual(
      expect.objectContaining({
        result: 'success',
        attached_count: 1,
      }),
    );
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
