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

  test('normalizes cents-style external seed offer prices for beauty identity payloads', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_olehenriksen_sunscreen_eu',
      debug: true,
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_olehenriksen_sunscreen_eu',
          source_kind: 'external_seed',
          source_payload: {
            title: 'Banana Bright Mineral Sunscreen SPF 30 - EU',
            brand: 'Olehenriksen',
            price: { amount: 2963, currency: 'USD' },
            currency: 'USD',
            canonical_url: 'https://olehenriksen.com/products/banana-bright-mineral-sunscreen-spf-31',
            category: 'Sunscreen',
            variants: [
              {
                variant_id: '42385365991596',
                sku: '50915',
                title: '1.7 oz',
                options: [{ name: 'Size', value: '1.7 oz' }],
                price: { current: { amount: 2963, currency: 'USD' } },
                currency: 'USD',
              },
            ],
          },
        },
      ],
    });

    expect(offersData.offers).toHaveLength(1);
    expect(offersData.offers[0].price).toEqual({ amount: 29.63, currency: 'USD' });
    expect(offersData.offers[0].variants[0].price.current).toEqual({
      amount: 29.63,
      currency: 'USD',
    });
  });

  test('keeps offer variant price coherent with already-normalized external seed product price', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_minor_unit_coherence',
      debug: true,
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_minor_unit_coherence',
          source_kind: 'external_seed',
          source_payload: {
            title: '1.7 oz',
            brand: 'Olehenriksen',
            price: { current: { amount: 29.63, currency: 'USD' } },
            currency: 'USD',
            variants: [
              {
                variant_id: 'v_cents',
                title: '1.7 oz',
                options: [{ name: 'Size', value: '1.7 oz' }],
                price: { current: { amount: 2963, currency: 'USD' } },
                currency: 'USD',
              },
            ],
          },
        },
      ],
    });

    expect(offersData.offers).toHaveLength(1);
    expect(offersData.offers[0].price).toEqual({ amount: 29.63, currency: 'USD' });
    expect(offersData.offers[0].variants[0].price.current).toEqual({
      amount: 29.63,
      currency: 'USD',
    });
  });

  test('does not turn missing external seed offer prices into zero-dollar offers', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'pg_unknown_retailer_price',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_tom_ford_unknown_price',
          source_kind: 'external_seed',
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_tom_ford_unknown_price',
          title: 'Tom Ford Beauty Shade And Illuminate Soft Radiance Foundation',
          brand: 'Tom Ford Beauty',
          merchant_name: 'Sephora',
          destination_url: 'https://www.sephora.com/product/example',
          price: { current: { amount: 0, currency: 'USD' } },
          source_payload: {
            origin: 'catalog_group_prefetch',
          },
          variants: [
            {
              variant_id: 'shade-1',
              title: 'Shade 1',
              price: { current: { amount: 0, currency: 'USD' } },
              currency: 'USD',
            },
            {
              variant_id: 'shade-2',
              title: 'Shade 2',
            },
          ],
        },
      ],
    });

    expect(offersData.offers).toHaveLength(1);
    expect(offersData.offers[0].price).toBeUndefined();
    expect(offersData.offers[0].variants).toEqual([
      expect.not.objectContaining({ price: expect.anything() }),
      expect.not.objectContaining({ price: expect.anything() }),
    ]);
  });

  test('falls back to product-level offer price when selected external seed variant has zero price', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'pg_reviewed_retailer_offer_price',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ulta-beauty:a3d445cc5b1e21b1',
          source_kind: 'external_seed',
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'external_seed',
          product_id: 'ulta-beauty:a3d445cc5b1e21b1',
          title: 'Roller Lash Curling Mascara',
          merchant_name: 'Ulta Beauty',
          destination_url: 'https://www.ulta.com/p/roller-lash-curling-lifting-mascara-xlsImpprod11951085?sku=2285068',
          price: 29,
          currency: 'USD',
          variants: [
            {
              variant_id: 'ulta-beauty:a3d445cc5b1e21b1::canonical',
              sku: 'ulta-beauty:a3d445cc5b1e21b1',
              title: 'Mascara',
              price: 0,
              currency: 'USD',
            },
          ],
        },
      ],
    });

    expect(offersData.offers).toHaveLength(1);
    expect(offersData.offers[0].price).toEqual({ amount: 29, currency: 'USD' });
    expect(offersData.offers[0].variants[0]).toEqual(
      expect.not.objectContaining({ price: expect.anything() }),
    );
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
    const merchantPromotions = [
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
    ];
    jest.doMock('../src/promotionStore', () => ({
      getAllPromotions: async () => merchantPromotions,
      getPromotionsForMerchant: async (merchantId) =>
        merchantId === 'merch_shopify' ? merchantPromotions : [],
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

  test('preserves commerce facts across merged internal and external offers with checkout modes', async () => {
    const app = require('../src/server');
    const externalCommerceFacts = {
      contract_version: 'commerce_facts.v1',
      market_id: 'US',
      country: 'US',
      currency_target: 'USD',
      source_authority: 'catalog_extract_v2',
      captured_at: '2026-04-29T00:00:00.000Z',
      evidence_url: 'https://sokoglam.com/products/cosrx-ceramide-skin-barrier-moisturizer',
      sellable_region: {
        status: 'unknown',
        countries: [],
        evidence_source: 'catalog_extract_v2',
        confidence: 'unknown',
        checked_at: '2026-04-29T00:00:00.000Z',
        reason_codes: ['shipping_destination_not_verified'],
      },
      regional_price: {
        amount: 22,
        currency: 'USD',
        observed_currency: 'USD',
        price_type: 'list',
        confidence: 'medium',
        market_switch_status: 'ok',
        source_url: 'https://sokoglam.com/products/cosrx-ceramide-skin-barrier-moisturizer',
        captured_at: '2026-04-29T00:00:00.000Z',
      },
      availability: {
        status: 'in_stock',
        source: 'catalog_extract_v2',
        confidence: 'medium',
        captured_at: '2026-04-29T00:00:00.000Z',
      },
      shipping: {
        status: 'unknown',
        source: 'catalog_extract_v2',
        confidence: 'unknown',
        reason_codes: ['external_checkout_not_queried'],
        checked_at: '2026-04-29T00:00:00.000Z',
      },
      promotions: [],
      returns: {
        status: 'unknown',
        source: 'catalog_extract_v2',
        confidence: 'unknown',
        reason_codes: ['external_returns_not_extracted'],
        checked_at: '2026-04-29T00:00:00.000Z',
      },
    };

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_cosrx_ceramide_moisturizer',
      debug: true,
      members: [
        {
          merchant_id: 'merch_cosrx_sandbox',
          product_id: 'cosrx_internal_1',
          merchant_name: 'COSRX Sandbox',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_soko_cosrx_ceramide',
          source_kind: 'external_seed',
          source_tier: 'merchant',
          source_payload: {
            title: 'COSRX Ceramide Skin Barrier Moisturizer',
            brand: 'COSRX',
            merchant_name: 'Soko Glam',
            price: 22,
            currency: 'USD',
            in_stock: true,
            destination_url: 'https://sokoglam.com/products/cosrx-ceramide-skin-barrier-moisturizer',
            commerce_facts_v1: externalCommerceFacts,
          },
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'merch_cosrx_sandbox',
          product_id: 'cosrx_internal_1',
          title: 'COSRX Ceramide Skin Barrier Moisturizer',
          brand: 'COSRX',
          merchant_name: 'COSRX Sandbox',
          price: 26,
          currency: 'USD',
          in_stock: true,
          shipping: {
            method_label: 'Standard',
            cost: { amount: 4.95, currency: 'USD' },
          },
          returns: { policy_label: '30-day returns' },
        },
      ],
    });

    expect(offersData.offers_count).toBe(2);
    const internalOffer = offersData.offers.find((offer) => offer.merchant_id === 'merch_cosrx_sandbox');
    const externalOffer = offersData.offers.find((offer) => offer.merchant_id === 'external_seed');

    expect(internalOffer).toEqual(
      expect.objectContaining({
        purchase_route: 'internal_checkout',
        commerce_mode: 'merchant_embedded_checkout',
        checkout_handoff: 'embedded',
      }),
    );
    expect(externalOffer).toEqual(
      expect.objectContaining({
        purchase_route: 'affiliate_outbound',
        commerce_mode: 'links_out',
        checkout_handoff: 'redirect',
        merchant_checkout_url: 'https://sokoglam.com/products/cosrx-ceramide-skin-barrier-moisturizer',
        commerce_facts_v1: expect.objectContaining({
          market_id: 'US',
          regional_price: expect.objectContaining({
            currency: 'USD',
            market_switch_status: 'ok',
          }),
          shipping: expect.objectContaining({
            status: 'unknown',
          }),
        }),
        agent_safe_commerce_facts: expect.objectContaining({
          shipping: expect.objectContaining({
            status: 'unknown',
            reason: 'verify_at_checkout',
          }),
        }),
      }),
    );
    expect(offersData.default_offer_id).toBe(internalOffer.offer_id);
    expect(offersData.best_price_offer_id).toBe(externalOffer.offer_id);
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

  test('does not let top-level PDP cache bypass poison similar recommendation cache', () => {
    const app = require('../src/server');

    expect(
      app._debug.resolvePdpSimilarCacheBypass({
        options: { cache_bypass: true },
      }),
    ).toBe(false);

    expect(
      app._debug.resolvePdpSimilarCacheBypass({
        options: { no_cache: true },
      }),
    ).toBe(true);

    expect(
      app._debug.resolvePdpSimilarCacheBypass({
        options: { cache_bypass: true },
        similar: { options: { cache_bypass: true } },
      }),
    ).toBe(true);

    const args = app._debug.buildPdpSimilarFetchArgs({
      payload: {
        options: { cache_bypass: true },
        similar: { limit: 6 },
      },
      canonicalProductForPdp: {
        merchant_id: 'external_seed',
        product_id: 'ext_rare_blush',
        title: 'Rare Beauty Blush',
        currency: 'USD',
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_rare_blush',
      },
      bypassCache: app._debug.resolvePdpSimilarCacheBypass({
        options: { cache_bypass: true },
        similar: { limit: 6 },
      }),
    });

    expect(args.candidateLimit).toBeGreaterThanOrEqual(6);
    expect(args.fetchArgs.options).toEqual(
      expect.objectContaining({
        no_cache: false,
        cache_bypass: false,
        bypass_cache: false,
      }),
    );
  });

  test('uses a minimal external seed base for PDP similar recall', () => {
    const app = require('../src/server');

    const args = app._debug.buildPdpSimilarFetchArgs({
      payload: { similar: { limit: 12 } },
      canonicalProductForPdp: {
        merchant_id: 'external_seed',
        product_id: 'sig_public_should_not_drive_recall',
        source_product_id: 'ext_bundle_source',
        title: 'Bundle title that can over-constrain similar recall',
        category: 'Bundles',
        product_line_id: 'line_bundle',
        sellable_item_group_id: 'sig_bundle',
        currency: 'USD',
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_bundle_source',
      },
    });

    expect(args.fetchArgs.pdp_product).toEqual({
      merchant_id: 'external_seed',
      product_id: 'ext_bundle_source',
      external_product_id: 'ext_bundle_source',
      source: 'external_seed',
      currency: 'USD',
    });
  });

  test('detects missing similar card images separately from highlight readiness', () => {
    const app = require('../src/server');

    expect(
      app._debug.hasSimilarCardImage({
        title: 'Ready highlight without image',
        card_highlight: 'Soft glow finish',
      }),
    ).toBe(false);

    expect(
      app._debug.hasSimilarCardImage({
        title: 'Ready image',
        card_highlight: 'Soft glow finish',
        image_url: 'https://example.test/image.jpg',
      }),
    ).toBe(true);
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

  test('builds distinct offer ids for multiple external-seed offers in the same group', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_boj_dynasty_cream',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_boj_official_dynasty',
          source_kind: 'external_seed',
          source_tier: 'brand',
          source_payload: {
            title: 'Dynasty Cream',
            brand: 'Beauty of Joseon',
            merchant_name: 'Beauty of Joseon',
            price: 15,
            currency: 'USD',
            in_stock: true,
            destination_url: 'https://beautyofjoseon.com/products/dynasty-cream',
          },
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_boj_ohlolly_dynasty',
          source_kind: 'external_seed',
          source_tier: 'merchant',
          source_payload: {
            title: 'Beauty of Joseon Dynasty Cream',
            brand: 'Beauty of Joseon',
            merchant_name: 'Ohlolly',
            price: 24,
            currency: 'USD',
            in_stock: true,
            destination_url: 'https://ohlolly.com/products/beauty-of-joseon-dynasty-cream',
          },
        },
      ],
    });

    expect(offersData.offers_count).toBe(2);
    expect(new Set(offersData.offers.map((offer) => offer.offer_id)).size).toBe(2);
    expect(offersData.offers.map((offer) => offer.merchant_name)).toEqual(
      expect.arrayContaining(['Beauty of Joseon', 'Ohlolly']),
    );
  });

  test('labels external-seed marketplace offers from the source host when merchant name is just product brand', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_tf_lost_cherry',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'tom-ford:lch-sephora',
          source_kind: 'canonical_catalog',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_tf_lch_official',
          source_kind: 'external_seed',
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'external_seed',
          product_id: 'tom-ford:lch-sephora',
          title: 'Lost Cherry Eau de Parfum',
          brand: 'Tom Ford',
          merchant_name: 'Tom Ford',
          price: 255,
          currency: 'USD',
          in_stock: true,
          source_url: 'https://sephora.com/products/tom-ford-lost-cherry-eau-de-parfum',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_tf_lch_official',
          title: 'Lost Cherry Eau de Parfum',
          brand: 'Tom Ford Beauty',
          merchant_name: 'www.tomfordbeauty.com',
          price: 90,
          currency: 'USD',
          in_stock: true,
          source_url: 'https://www.tomfordbeauty.com/products/lost-cherry-eau-de-parfum',
        },
      ],
    });

    expect(offersData.offers.map((offer) => offer.merchant_name)).toEqual(
      expect.arrayContaining(['Sephora', 'Tom Ford Beauty']),
    );
    expect(offersData.offers.map((offer) => offer.merchant_name)).not.toContain('Tom Ford');
    expect(offersData.offers.map((offer) => offer.merchant_name)).not.toContain('www.tomfordbeauty.com');
  });

  test('does not select zero-price unavailable link-out rows as best price', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_tf_lost_cherry',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'tom-ford:lch-sephora-oos',
          source_kind: 'canonical_catalog',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_tf_lch_official',
          source_kind: 'external_seed',
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'external_seed',
          product_id: 'tom-ford:lch-sephora-oos',
          title: 'Lost Cherry Eau de Parfum',
          brand: 'Tom Ford',
          merchant_name: 'Tom Ford',
          price: 0,
          currency: 'USD',
          in_stock: false,
          source_url: 'https://sephora.com/products/tom-ford-lost-cherry-eau-de-parfum',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_tf_lch_official',
          title: 'Lost Cherry Eau de Parfum',
          brand: 'Tom Ford Beauty',
          merchant_name: 'www.tomfordbeauty.com',
          price: 90,
          currency: 'USD',
          in_stock: true,
          source_url: 'https://www.tomfordbeauty.com/products/lost-cherry-eau-de-parfum',
        },
      ],
    });

    const bestOffer = offersData.offers.find((offer) => offer.offer_id === offersData.best_price_offer_id);
    expect(bestOffer).toEqual(
      expect.objectContaining({
        product_id: 'ext_tf_lch_official',
        merchant_name: 'Tom Ford Beauty',
        price: { amount: 90, currency: 'USD' },
      }),
    );
  });

  test('collapses duplicate offers that are the same merchant listing', async () => {
    const app = require('../src/server');

    // Three external_seed scrape records of the ONE merchant listing — same
    // merchant, same checkout URL, same price, only the seed product_id
    // differs. They must collapse to a single offer instead of rendering as
    // three "sellers".
    const dynastySeedPayload = () => ({
      title: 'Dynasty Cream',
      brand: 'Beauty of Joseon',
      merchant_name: 'Beauty of Joseon',
      price: 15,
      currency: 'USD',
      in_stock: true,
      destination_url: 'https://beautyofjoseon.com/products/dynasty-cream',
    });

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_boj_dynasty_cream',
      debug: true,
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_boj_dynasty_scrape_a',
          source_kind: 'external_seed',
          source_payload: dynastySeedPayload(),
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_boj_dynasty_scrape_b',
          source_kind: 'external_seed',
          source_payload: dynastySeedPayload(),
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_boj_dynasty_scrape_c',
          source_kind: 'external_seed',
          source_payload: dynastySeedPayload(),
        },
      ],
    });

    expect(offersData.offers_count).toBe(1);
    expect(offersData.offers).toHaveLength(1);
    expect(offersData.diagnostics.deduped_offer_count).toBe(2);
    expect(offersData.offers[0].merchant_name).toBe('Beauty of Joseon');
  });

  test('marks external-seed offers even when group member rows do not carry source_kind', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'pg_ext_source_kind_contract',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_missing_source_kind',
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_missing_source_kind',
          title: 'Contract Lipstick',
          price: 25,
          currency: 'USD',
          in_stock: true,
          variants: [
            {
              variant_id: 'external-seller-default',
              title: 'Default',
              price: 25,
              currency: 'USD',
              in_stock: true,
            },
          ],
        },
      ],
    });

    expect(offersData.offers[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_missing_source_kind',
        source_kind: 'external_seed',
      }),
    );
  });

  test('does not create zero-price external-seed offers from lightweight catalog member payloads', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_ordinary_niacinamide',
      debug: true,
      members: [
        {
          merchant_id: 'merch_store',
          product_id: 'internal_ordinary_niacinamide',
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ext_minimal_catalog_alias',
          source_kind: 'canonical_catalog',
          source_payload: {
            title: 'Niacinamide 10% + Zinc 1%',
            brand: 'The Ordinary',
            canonical_url: 'https://theordinary.com/en-us/niacinamide-10-zinc-1-serum-100436.html',
            content_key: 'ck_ordinary_niacinamide',
            pivota_signature_id: 'sig_member_alias',
          },
        },
      ],
      prefetchedProducts: [
        {
          merchant_id: 'merch_store',
          product_id: 'internal_ordinary_niacinamide',
          title: 'Niacinamide 10% + Zinc 1%',
          brand: 'The Ordinary',
          price: 12,
          currency: 'USD',
          in_stock: true,
        },
      ],
    });

    expect(offersData.offers_count).toBe(1);
    expect(offersData.offers).toHaveLength(1);
    expect(offersData.offers[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'merch_store',
        product_id: 'internal_ordinary_niacinamide',
        price: { amount: 12, currency: 'USD' },
      }),
    );
    expect(offersData.offers.some((offer) => offer.merchant_id === 'external_seed')).toBe(false);
    expect(offersData.diagnostics.build_sources.identity_payload).toBe(0);
    expect(offersData.diagnostics.unresolved_members).toEqual([
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_minimal_catalog_alias',
        reason: 'member_unavailable',
      }),
    ]);
  });

  test('decorates canonical PDP payloads with identity graph group and offer metadata', () => {
    const app = require('../src/server');

    const payload = app._debug.decoratePdpPayloadWithIdentity(
      {
        product: {
          product_id: 'sig_contract_lipstick',
          title: 'Contract Lipstick',
        },
      },
      {
        productGroupId: 'pg_ext_contract_lipstick',
        productLineId: 'pl_ext_contract_lipstick',
        reviewFamilyId: 'pl_ext_contract_lipstick',
        canonicalScope: 'multi_merchant_canonical',
        offersCount: 2,
      },
    );

    expect(payload).toEqual(
      expect.objectContaining({
        product_group_id: 'pg_ext_contract_lipstick',
        sellable_item_group_id: 'pg_ext_contract_lipstick',
        product_line_id: 'pl_ext_contract_lipstick',
        review_family_id: 'pl_ext_contract_lipstick',
        canonical_scope: 'multi_merchant_canonical',
        offers_count: 2,
        has_multiple_offers: true,
      }),
    );
    expect(payload.product).toEqual(
      expect.objectContaining({
        product_group_id: 'pg_ext_contract_lipstick',
        sellable_item_group_id: 'pg_ext_contract_lipstick',
        product_line_id: 'pl_ext_contract_lipstick',
        review_family_id: 'pl_ext_contract_lipstick',
        canonical_scope: 'multi_merchant_canonical',
        offers_count: 2,
        has_multiple_offers: true,
      }),
    );
  });

  test('hydrates zero canonical PDP product price from the default positive offer', () => {
    const app = require('../src/server');

    const defaultOfferId = 'of:v1:external_seed:sig_tf_lost_cherry:merchant:default__ext_official';
    const payload = app._debug.hydrateCanonicalPdpPayloadFromOffers(
      {
        product: {
          product_id: 'sig_tf_lost_cherry',
          title: 'Lost Cherry Eau de Parfum',
          price: { current: { amount: 0, currency: 'USD' } },
          price_amount: 0,
          currency: 'USD',
        },
      },
      {
        default_offer_id: defaultOfferId,
        best_price_offer_id: defaultOfferId,
        offers: [
          {
            offer_id: 'of:v1:external_seed:sig_tf_lost_cherry:merchant:default__sephora',
            merchant_name: 'Sephora',
            price: { amount: 0, currency: 'USD' },
            inventory: { in_stock: false },
          },
          {
            offer_id: defaultOfferId,
            merchant_name: 'Tom Ford Beauty',
            price: { amount: 90, currency: 'USD' },
            inventory: { in_stock: true },
          },
        ],
      },
    );

    expect(payload.product).toEqual(
      expect.objectContaining({
        default_offer_id: defaultOfferId,
        best_price_offer_id: defaultOfferId,
        price_amount: 90,
        currency: 'USD',
        price_source: 'default_offer',
      }),
    );
    expect(payload.product.price.current).toEqual({ amount: 90, currency: 'USD' });
  });

  test('does not overwrite an existing positive canonical PDP product price', () => {
    const app = require('../src/server');

    const payload = app._debug.hydrateCanonicalPdpPayloadFromOffers(
      {
        product: {
          product_id: 'sig_positive_price',
          title: 'Existing Price Product',
          price: { current: { amount: 120, currency: 'USD' } },
          price_amount: 120,
          currency: 'USD',
        },
      },
      {
        default_offer_id: 'offer_discount',
        best_price_offer_id: 'offer_discount',
        offers: [
          {
            offer_id: 'offer_discount',
            merchant_name: 'Discount Seller',
            price: { amount: 90, currency: 'USD' },
            inventory: { in_stock: true },
          },
        ],
      },
    );

    expect(payload.product.price.current).toEqual({ amount: 120, currency: 'USD' });
    expect(payload.product.price_amount).toBe(120);
    expect(payload.product.default_offer_id).toBe('offer_discount');
    expect(payload.product.price_source).toBeUndefined();
  });

  test('projects group-fused default offer price over canonical content price', () => {
    const app = require('../src/server');

    const payload = app._debug.hydrateCanonicalPdpPayloadFromOffers(
      {
        product: {
          product_id: 'ext_cosrx_official_eye',
          title: 'Advanced Snail Peptide Eye Cream',
          price: { current: { amount: 28, currency: 'USD' } },
          price_amount: 28,
          currency: 'USD',
        },
      },
      {
        offer_source: 'group_fused',
        default_offer_id: 'of_ulta_eye',
        best_price_offer_id: 'of_ulta_eye',
        offers: [
          {
            offer_id: 'of_ulta_eye',
            merchant_id: 'external_seed',
            product_id: 'ulta:eye',
            merchant_name: 'Ulta Beauty',
            price: { amount: 22, currency: 'USD' },
            inventory: { in_stock: true },
          },
        ],
      },
    );

    expect(payload.product.price.current).toEqual({ amount: 22, currency: 'USD' });
    expect(payload.product.price_amount).toBe(22);
    expect(payload.product.price_source).toBe('default_offer');
  });

  test('removes zero canonical PDP product price when no positive offer price exists', () => {
    const app = require('../src/server');

    const payload = app._debug.hydrateCanonicalPdpPayloadFromOffers(
      {
        product: {
          product_id: 'sig_unknown_price',
          title: 'Unknown Price Product',
          price: { current: { amount: 0, currency: 'USD' } },
          price_amount: 0,
          priceAmount: 0,
          currency: 'USD',
        },
      },
      {
        default_offer_id: 'offer_unknown',
        best_price_offer_id: 'offer_unknown',
        offers: [
          {
            offer_id: 'offer_unknown',
            merchant_name: 'Retailer',
            inventory: { in_stock: true },
          },
        ],
      },
    );

    expect(payload.product.price).toBeUndefined();
    expect(payload.product.price_amount).toBeUndefined();
    expect(payload.product.priceAmount).toBeUndefined();
  });

  test('hydrates empty canonical PDP media from the default offer variant images', () => {
    const app = require('../src/server');

    const payload = app._debug.hydrateCanonicalPdpPayloadFromOffers(
      {
        product: {
          product_id: 'sig_tf_lost_cherry',
          title: 'Lost Cherry Eau de Parfum',
          price: { current: { amount: 0, currency: 'USD' } },
          availability: { in_stock: false },
          variants: [
            {
              variant_id: 'canonical_empty',
              price: { current: { amount: 0, currency: 'USD' } },
              availability: { in_stock: false },
            },
          ],
        },
        modules: [],
      },
      {
        default_offer_id: 'offer_tom_ford',
        best_price_offer_id: 'offer_tom_ford',
        offers: [
          {
            offer_id: 'offer_tom_ford',
            merchant_name: 'Tom Ford Beauty',
            price: { amount: 90, currency: 'USD' },
            inventory: { in_stock: true },
            variants: [
              {
                variant_id: 'T81201',
                image_url:
                  'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T81201_2000x2000_0_8359c3e5-56ed-4121-b16b-14768c0c2c64.png?v=1777211432',
              },
              {
                variant_id: 'T8ML01',
                image_url:
                  'https://pivota-agent-production.up.railway.app/catalog-image-cache/cc/cc717e19f368e4114ca16966224f788e2566f5416ac913c1405898d86039e915.webp',
              },
              {
                variant_id: 'T8ML02',
                image_url:
                  'https://pivota-agent-production.up.railway.app/catalog-image-cache/a7/a7b2c6fc65f11cc3037c6ba5d180064a1d84e1ae77814d77ecc9ef742c47e9c4.webp',
              },
            ],
          },
        ],
      },
    );

    expect(payload.product.image_url).toContain('/catalog-image-cache/cc/');
    expect(payload.product.images).toHaveLength(2);
    expect(payload.product.image_source).toBe('default_offer');
    const mediaGallery = payload.modules.find((module) => module.type === 'media_gallery');
    expect(mediaGallery?.data?.items).toEqual([
      expect.objectContaining({
        type: 'image',
        url: expect.stringContaining('/catalog-image-cache/cc/'),
        source: 'default_offer',
      }),
      expect.objectContaining({
        type: 'image',
        url: expect.stringContaining('/catalog-image-cache/a7/'),
        source: 'default_offer',
      }),
    ]);
    expect(payload.product.images.some((url) => url.includes('tf_sku_T81201_2000x2000_0'))).toBe(false);
  });

  test('preserves existing canonical PDP media gallery when present', () => {
    const app = require('../src/server');

    const payload = app._debug.hydrateCanonicalPdpPayloadFromOffers(
      {
        product: {
          product_id: 'sig_has_media',
          title: 'Has Media',
          image_url: 'https://example.com/existing.jpg',
          images: ['https://example.com/existing.jpg'],
          price: { current: { amount: 10, currency: 'USD' } },
        },
        modules: [
          {
            module_id: 'm_media',
            type: 'media_gallery',
            priority: 100,
            data: {
              items: [{ type: 'image', url: 'https://example.com/existing.jpg' }],
            },
          },
        ],
      },
      {
        default_offer_id: 'offer_with_media',
        offers: [
          {
            offer_id: 'offer_with_media',
            price: { amount: 9, currency: 'USD' },
            images: ['https://example.com/offer.jpg'],
          },
        ],
      },
    );

    expect(payload.product.image_url).toBe('https://example.com/existing.jpg');
    expect(payload.product.image_source).toBeUndefined();
    expect(payload.modules.find((module) => module.type === 'media_gallery')?.data?.items).toEqual([
      { type: 'image', url: 'https://example.com/existing.jpg' },
    ]);
  });

  test('builds external-seed offers from serialized mirror source payloads', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'pg_ext_mac_russian_red',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_mac_russian_red_ulta',
          source_kind: 'external_seed',
          source_payload: {
            seed_data: JSON.stringify({
              title: 'MAC MACximal Silky Matte Lipstick',
              brand: 'MAC',
              merchant_name: 'Ulta Beauty',
              price_amount: '25.00',
              price_currency: 'USD',
              in_stock: true,
              destination_url: 'https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2044115',
              image_urls: ['https://images.ulta.com/mac-russian-red.jpg'],
              variants: [
                {
                  variant_id: 'ulta-russian-red',
                  title: 'Russian Red',
                  price_amount: '25.00',
                  currency: 'USD',
                  in_stock: true,
                },
              ],
            }),
            external_seed: JSON.stringify({
              external_product_id: 'ext_mac_russian_red_ulta',
              merchant_name: 'Ulta Beauty',
            }),
          },
        },
      ],
    });

    expect(offersData.offers_count).toBe(1);
    expect(offersData.offers[0]).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        product_id: 'ext_mac_russian_red_ulta',
        merchant_name: 'Ulta Beauty',
        source_url: 'https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2044115',
        inventory: { in_stock: true },
      }),
    );
    expect(offersData.offers[0].variants[0]).toEqual(
      expect.objectContaining({
        variant_id: 'ulta-russian-red',
        title: 'Russian Red',
      }),
    );
  });

  test('uses preferred external-seed product id as default offer when merchant id is shared', async () => {
    const app = require('../src/server');

    const offersData = await app._debug.buildOffersFromGroupMembers({
      productGroupId: 'sig_cosrx_eye',
      preferredMerchantId: 'external_seed',
      preferredProductId: 'ulta:cosrx-eye',
      members: [
        {
          merchant_id: 'external_seed',
          product_id: 'ext_cosrx_eye_official',
          source_kind: 'canonical_catalog',
          source_payload: {
            title: 'Advanced Snail Peptide Eye Cream',
            brand: 'COSRX',
            merchant_name: 'COSRX',
            price_amount: 28,
            price_currency: 'USD',
            destination_url: 'https://www.cosrx.com/products/advanced-snail-peptide-eye-cream',
            variants: [
              {
                variant_id: 'official_085',
                title: '0.85 fl oz',
                price: '28.00',
                currency: 'USD',
              },
            ],
          },
          is_primary: true,
        },
        {
          merchant_id: 'external_seed',
          product_id: 'ulta:cosrx-eye',
          source_kind: 'canonical_catalog',
          source_payload: {
            title: 'Advanced Snail Peptide Eye Cream',
            brand: 'COSRX',
            merchant_name: 'Ulta Beauty',
            price_amount: 22,
            price_currency: 'USD',
            destination_url: 'https://www.ulta.com/p/advanced-snail-peptide-eye-cream',
            variants: [
              {
                variant_id: 'ulta_085',
                title: '0.85 fl oz',
                price: '22.00',
                currency: 'USD',
              },
            ],
          },
        },
      ],
    });

    const defaultOffer = offersData.offers.find((offer) => offer.offer_id === offersData.default_offer_id);
    expect(offersData.offers_count).toBe(2);
    expect(defaultOffer).toEqual(
      expect.objectContaining({
        product_id: 'ulta:cosrx-eye',
        price: { amount: 22, currency: 'USD' },
      }),
    );
  });
});
