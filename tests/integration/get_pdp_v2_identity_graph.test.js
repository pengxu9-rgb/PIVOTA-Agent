const nock = require('nock');
const request = require('supertest');

jest.mock('../../src/db', () => ({
  query: jest.fn(),
  withClient: jest.fn(async (fn) =>
    fn({
      query: jest.fn(),
    })),
}));

const ORIGINAL_ENV = process.env;

function loadServerWithDb(envOverrides = {}) {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
    PIVOTA_API_BASE: 'http://localhost:8080',
    PIVOTA_API_KEY: 'test-token',
    PDP_IDENTITY_GRAPH_ENABLED: 'true',
    PDP_IDENTITY_GRAPH_AUTO_ENABLE_LIVE: 'true',
    PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST: 'KraveBeauty',
    ...envOverrides,
  };
  const db = require('../../src/db');
  db.query.mockReset();
  const app = require('../../src/server');
  return { app, db };
}

describe('get_pdp_v2 identity graph live read', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('returns synthetic canonical identity metadata and product-line review scope', async () => {
    const { app, db } = loadServerWithDb();

    db.query.mockImplementation(async (sql, params) => {
      const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim();
      if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('merchant_id = $1')) {
        return {
          rows: [
            {
              source_listing_ref: 'external_seed:ext_krave_gbr_45',
              merchant_id: 'external_seed',
              product_id: 'ext_krave_gbr_45',
              source_kind: 'external_seed',
              source_tier: 'brand',
              live_read_enabled: true,
              sellable_item_group_id: 'sig_krave_45',
              product_line_id: 'pl_krave_gbr',
              review_family_id: 'rf_krave_gbr',
              identity_status: 'approved',
              identity_confidence: 0.94,
              match_basis: ['official_url:https://kravebeauty.com/products/great-barrier-relief', 'variant_axes:volume:45ml'],
              strong_identity: {},
              soft_identity: {},
              variant_axes: { size: 'standard 45 ml', volume: '45ml', multi_variant: true },
              source_payload: {
                product_id: 'ext_krave_gbr_45',
                merchant_id: 'external_seed',
                title: 'Great Barrier Relief',
                brand: 'KraveBeauty',
                description: 'Barrier support serum.',
                images: [{ url: 'https://cdn.example.com/gbr-45-main.jpg' }],
                product_intel: {
                  contract_version: 'pivota.product_intel.v1',
                  quality_state: 'verified',
                  evidence_profile: 'pivota_reviewed',
                  freshness: { generated_at: '2026-04-10T00:00:00.000Z' },
                  provenance: { source: 'aurora_product_intel_kb' },
                  product_intel_core: {
                    what_it_is: {
                      body: 'Pivota-reviewed barrier support serum for compromised skin.',
                    },
                    why_it_stands_out: [
                      {
                        headline: 'Barrier-first support',
                        body: 'Reviewed and normalized by Pivota.',
                      },
                    ],
                    confidence: { overall: 'high' },
                    freshness: { generated_at: '2026-04-10T00:00:00.000Z' },
                    quality_state: 'verified',
                    evidence_profile: 'pivota_reviewed',
                  },
                },
              },
              review_summary: {
                rating: 4.5,
                review_count: 12,
              },
            },
          ],
        };
      }
      if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('sellable_item_group_id = $1')) {
        return {
          rows: [
            {
              source_listing_ref: 'external_seed:ext_krave_gbr_45',
              merchant_id: 'external_seed',
              product_id: 'ext_krave_gbr_45',
              source_kind: 'external_seed',
              source_tier: 'brand',
              live_read_enabled: true,
              sellable_item_group_id: 'sig_krave_45',
              product_line_id: 'pl_krave_gbr',
              review_family_id: 'rf_krave_gbr',
              identity_status: 'approved',
              identity_confidence: 0.94,
              match_basis: ['official_url:https://kravebeauty.com/products/great-barrier-relief', 'variant_axes:volume:45ml'],
              strong_identity: {},
              soft_identity: {},
              variant_axes: { size: 'standard 45 ml', volume: '45ml', multi_variant: true },
              source_payload: {
                product_id: 'ext_krave_gbr_45',
                merchant_id: 'external_seed',
                title: 'Great Barrier Relief',
                brand: 'KraveBeauty',
                description: 'Barrier support serum.',
                images: [{ url: 'https://cdn.example.com/gbr-45-main.jpg' }],
              },
              review_summary: {
                rating: 4.5,
                review_count: 12,
              },
            },
            {
              source_listing_ref: 'merch_krave:10008793153864',
              merchant_id: 'merch_krave',
              product_id: '10008793153864',
              source_kind: 'internal',
              source_tier: 'merchant',
              live_read_enabled: true,
              sellable_item_group_id: 'sig_krave_45',
              product_line_id: 'pl_krave_gbr',
              review_family_id: 'rf_krave_gbr',
              identity_status: 'approved',
              identity_confidence: 0.84,
              match_basis: ['brand:kravebeauty', 'title_core:great barrier relief', 'variant_axes:volume:45ml'],
              strong_identity: {},
              soft_identity: {},
              variant_axes: { size: 'standard 45 ml', volume: '45ml', multi_variant: true },
              source_payload: {
                product_id: '10008793153864',
                merchant_id: 'merch_krave',
                title: 'Great Barrier Relief',
                vendor: 'KraveBeauty',
                images: [{ url: 'https://cdn.example.com/gbr-45-internal.jpg' }],
              },
              review_summary: {
                rating: 4.4,
                review_count: 4,
              },
            },
          ],
        };
      }
      if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('product_line_id = $1')) {
        return {
          rows: [
            {
              source_listing_ref: 'external_seed:ext_krave_gbr_45',
              merchant_id: 'external_seed',
              product_id: 'ext_krave_gbr_45',
              source_kind: 'external_seed',
              source_tier: 'brand',
              live_read_enabled: true,
              sellable_item_group_id: 'sig_krave_45',
              product_line_id: 'pl_krave_gbr',
              review_family_id: 'rf_krave_gbr',
              identity_status: 'approved',
              identity_confidence: 0.94,
              match_basis: ['official_url:https://kravebeauty.com/products/great-barrier-relief', 'variant_axes:volume:45ml'],
              strong_identity: {},
              soft_identity: {},
              variant_axes: { size: 'standard 45 ml', volume: '45ml', multi_variant: true },
              source_payload: {
                product_id: 'ext_krave_gbr_45',
                merchant_id: 'external_seed',
                title: 'Great Barrier Relief',
                brand: 'KraveBeauty',
                description: 'Barrier support serum.',
                images: [{ url: 'https://cdn.example.com/gbr-45-main.jpg' }],
                product_intel: {
                  contract_version: 'pivota.product_intel.v1',
                  quality_state: 'verified',
                  evidence_profile: 'pivota_reviewed',
                  freshness: { generated_at: '2026-04-10T00:00:00.000Z' },
                  provenance: { source: 'aurora_product_intel_kb' },
                  product_intel_core: {
                    what_it_is: {
                      body: 'Pivota-reviewed barrier support serum for compromised skin.',
                    },
                    why_it_stands_out: [
                      {
                        headline: 'Barrier-first support',
                        body: 'Reviewed and normalized by Pivota.',
                      },
                    ],
                    confidence: { overall: 'high' },
                    freshness: { generated_at: '2026-04-10T00:00:00.000Z' },
                    quality_state: 'verified',
                    evidence_profile: 'pivota_reviewed',
                  },
                },
              },
              review_summary: {
                rating: 4.5,
                review_count: 12,
              },
            },
            {
              source_listing_ref: 'external_seed:ext_krave_gbr_100',
              merchant_id: 'external_seed',
              product_id: 'ext_krave_gbr_100',
              source_kind: 'external_seed',
              source_tier: 'brand',
              live_read_enabled: true,
              sellable_item_group_id: 'sig_krave_100',
              product_line_id: 'pl_krave_gbr',
              review_family_id: 'rf_krave_gbr',
              identity_status: 'approved',
              identity_confidence: 0.92,
              match_basis: ['official_url:https://kravebeauty.com/products/great-barrier-relief', 'variant_axes:volume:100ml'],
              strong_identity: {},
              soft_identity: {},
              variant_axes: { size: 'jumbo 100 ml', volume: '100ml', multi_variant: true },
              source_payload: {
                product_id: 'ext_krave_gbr_100',
                merchant_id: 'external_seed',
                title: 'Great Barrier Relief Jumbo',
                brand: 'KraveBeauty',
                images: [{ url: 'https://cdn.example.com/gbr-100-main.jpg' }],
              },
              review_summary: {
                rating: 4.7,
                review_count: 30,
              },
            },
          ],
        };
      }
      if (normalizedSql.includes('FROM merchant_stores') && normalizedSql.includes('merchant_onboarding')) {
        return {
          rows: [
            {
              merchant_id: 'merch_krave',
              merchant_name: 'Pivota Market',
            },
          ],
        };
      }
      return { rows: [] };
    });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/external_seed/ext_krave_gbr_45')
      .twice()
      .reply(200, {
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_krave_gbr_45',
          source: 'external_seed',
          title: 'Great Barrier Relief',
          brand: 'KraveBeauty',
          currency: 'EUR',
          price: { amount: 28, currency: 'EUR' },
          image_url: 'https://cdn.example.com/gbr-upstream.jpg',
          platform: 'external',
          platform_product_id: 'ext_krave_gbr_45',
          variants: [
            {
              variant_id: '13760798457931',
              title: 'Standard - 45 mL',
              options: [{ name: 'Size', value: 'Standard - 45 mL' }],
              price: { amount: 28, currency: 'EUR' },
            },
            {
              variant_id: '40160623329355',
              title: 'Jumbo - 100 mL',
              options: [{ name: 'Size', value: 'Jumbo - 100 mL' }],
              price: { amount: 50, currency: 'EUR' },
            },
          ],
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/merch_krave/10008793153864')
      .reply(200, {
        product: {
          merchant_id: 'merch_krave',
          product_id: '10008793153864',
          title: 'Great Barrier Relief',
          vendor: 'KraveBeauty',
          currency: 'EUR',
          price: { amount: 30, currency: 'EUR' },
          platform: 'shopify',
          platform_product_id: '10008793153864',
          variants: [
            {
              id: '52876964495688',
              title: 'Standard - 45 mL',
              options: { Size: 'Standard - 45 mL' },
              price: { amount: 28, currency: 'EUR' },
              sku: 'GBR-45',
            },
            {
              id: '52876964528456',
              title: 'Jumbo - 100 mL',
              options: { Size: 'Jumbo - 100 mL' },
              price: { amount: 50, currency: 'EUR' },
              sku: 'GBR-100',
            },
          ],
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_krave_gbr_45')
      .reply(404, { error: 'PRODUCT_GROUP_NOT_FOUND' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['offers', 'reviews_preview', 'product_intel'],
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_krave_gbr_45',
          },
        },
      })
      .expect(200);

    const canonicalModule = res.body.modules.find((module) => module.type === 'canonical');
    const reviewsModule = res.body.modules.find((module) => module.type === 'reviews_preview');
    const offersModule = res.body.modules.find((module) => module.type === 'offers');
    const productIntelModule = res.body.modules.find((module) => module.type === 'product_intel');

    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        resolution_source: 'identity_graph_live',
      }),
    );
    expect(res.body.metadata.identity_graph).toEqual(
      expect.objectContaining({
        sellable_item_group_id: 'sig_krave_45',
        product_line_id: 'pl_krave_gbr',
        review_family_id: 'rf_krave_gbr',
        canonical_scope: 'synthetic',
      }),
    );
    expect(canonicalModule?.data).toEqual(
      expect.objectContaining({
        sellable_item_group_id: 'sig_krave_45',
        product_line_id: 'pl_krave_gbr',
        review_family_id: 'rf_krave_gbr',
        canonical_scope: 'synthetic',
      }),
    );
    expect(canonicalModule?.data?.pdp_payload?.modules?.find((module) => module.type === 'media_gallery')?.data)
      .toEqual(
        expect.objectContaining({
          gallery_scope: 'exact_item',
          preview_scope: 'product_line',
          preview_items: [
            expect.objectContaining({
              url: 'https://cdn.example.com/gbr-100-main.jpg',
            }),
          ],
        }),
      );
    const canonicalPayloadModuleTypes = (canonicalModule?.data?.pdp_payload?.modules || []).map(
      (module) => module.type,
    );
    expect(canonicalPayloadModuleTypes).not.toEqual(
      expect.arrayContaining(['product_intel', 'recommendations', 'reviews_preview', 'similar']),
    );
    expect(
      app._debug.stripResponseOwnedPdpModulesFromCanonicalPayload({
        modules: [
          { type: 'media_gallery' },
          { type: 'product_intel' },
          { type: 'recommendations' },
          { type: 'reviews_preview' },
          { type: 'similar' },
        ],
      }).modules,
    ).toEqual([{ type: 'media_gallery' }]);
    expect(reviewsModule?.data).toEqual(
      expect.objectContaining({
        aggregation_scope: 'product_line',
        exact_item_review_count: 16,
        product_line_review_count: 42,
        scoped_summaries: expect.objectContaining({
          product_line: expect.objectContaining({
            review_count: 42,
          }),
          exact_item: expect.objectContaining({
            review_count: 16,
          }),
        }),
      }),
    );
    expect(offersModule?.data?.product_group_id).toBe('sig_krave_45');
    expect(Array.isArray(offersModule?.data?.offers)).toBe(true);
    expect(offersModule.data.offers).toHaveLength(2);
    const internalOffer = offersModule.data.offers.find((offer) => offer.merchant_id === 'merch_krave');
    expect(internalOffer).toEqual(
      expect.objectContaining({
        merchant_name: 'Pivota Market',
        variant_id: '52876964495688',
        selected_variant_id: '52876964495688',
        sku_id: 'GBR-45',
        price: { amount: 28, currency: 'EUR' },
      }),
    );
    expect(internalOffer?.selected_options).toEqual({ size: 'standard - 45 ml' });
    expect(internalOffer?.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          variant_id: '52876964495688',
          title: 'Standard - 45 mL',
          price: {
            current: { amount: 28, currency: 'EUR' },
          },
          options: [{ name: 'size', value: 'standard - 45 ml' }],
        }),
        expect.objectContaining({
          variant_id: '52876964528456',
          title: 'Jumbo - 100 mL',
          price: {
            current: { amount: 50, currency: 'EUR' },
          },
          options: [{ name: 'size', value: 'jumbo - 100 ml' }],
        }),
      ]),
    );
    expect(productIntelModule).toEqual(
      expect.objectContaining({
        required: true,
        data: expect.objectContaining({
          display_name: 'Pivota Insights',
          evidence_profile: 'pivota_reviewed',
          provenance: expect.objectContaining({
            source: 'aurora_product_intel_kb',
          }),
        }),
      }),
    );
  });

  test('keeps identity graph live when product intel is not yet published for the selected line item', async () => {
    const { app, db } = loadServerWithDb({
      PDP_IDENTITY_GRAPH_BRAND_ALLOWLIST: 'Beauty of Joseon',
    });

    const dn310Listing = {
      source_listing_ref: 'external_seed:ext_boj_dn310',
      merchant_id: 'external_seed',
      product_id: 'ext_boj_dn310',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: true,
      sellable_item_group_id: 'sig_boj_dn310',
      product_line_id: 'pl_boj_daily_tinted_spf',
      review_family_id: 'rf_boj_daily_tinted_spf',
      identity_status: 'approved',
      identity_confidence: 0.93,
      match_basis: ['official_url:https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn310'],
      strong_identity: {},
      soft_identity: {},
      variant_axes: { shade: 'dn310', multi_variant: true },
      brand_norm: 'beauty of joseon',
      source_payload: {
        product_id: 'ext_boj_dn310',
        merchant_id: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN310',
        brand: 'Beauty of Joseon',
        source_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn310',
        images: [{ url: 'https://cdn.example.com/boj-dn310-main.jpg' }],
      },
    };
    const dn350Listing = {
      source_listing_ref: 'external_seed:ext_boj_dn350',
      merchant_id: 'external_seed',
      product_id: 'ext_boj_dn350',
      source_kind: 'external_seed',
      source_tier: 'brand',
      live_read_enabled: true,
      sellable_item_group_id: 'sig_boj_dn350',
      product_line_id: 'pl_boj_daily_tinted_spf',
      review_family_id: 'rf_boj_daily_tinted_spf',
      identity_status: 'approved',
      identity_confidence: 0.92,
      match_basis: ['official_url:https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350'],
      strong_identity: {},
      soft_identity: {},
      variant_axes: { shade: 'dn350', multi_variant: true },
      brand_norm: 'beauty of joseon',
      source_payload: {
        product_id: 'ext_boj_dn350',
        merchant_id: 'external_seed',
        title: 'Daily Tinted Fluid Sunscreen DN350',
        brand: 'Beauty of Joseon',
        source_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
        images: [{ url: 'https://cdn.example.com/boj-dn350-main.jpg' }],
      },
    };

    db.query.mockImplementation(async (sql) => {
      const normalizedSql = String(sql || '').replace(/\s+/g, ' ').trim();
      if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('merchant_id = $1')) {
        return { rows: [dn310Listing] };
      }
      if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('sellable_item_group_id = $1')) {
        return { rows: [dn310Listing] };
      }
      if (normalizedSql.includes('FROM pdp_identity_listing') && normalizedSql.includes('product_line_id = $1')) {
        return { rows: [dn310Listing, dn350Listing] };
      }
      if (normalizedSql.includes('FROM aurora_product_intel_kb')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/products/external_seed/ext_boj_dn310')
      .times(3)
      .reply(200, {
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_boj_dn310',
          source: 'external_seed',
          title: 'Daily Tinted Fluid Sunscreen DN310',
          brand: 'Beauty of Joseon',
          image_url: 'https://cdn.example.com/boj-dn310-upstream.jpg',
          platform: 'external',
          platform_product_id: 'ext_boj_dn310',
        },
      });

    nock(process.env.PIVOTA_API_BASE)
      .get('/agent/v1/product-groups/resolve-by-product-id')
      .query((query) => query && query.product_id === 'ext_boj_dn310')
      .reply(404, { error: 'PRODUCT_GROUP_NOT_FOUND' });

    const res = await request(app)
      .post('/agent/shop/v1/invoke')
      .send({
        operation: 'get_pdp_v2',
        payload: {
          include: ['offers', 'variant_selector', 'product_intel'],
          product_ref: {
            merchant_id: 'external_seed',
            product_id: 'ext_boj_dn310',
          },
        },
      })
      .expect(200);

    const canonicalModule = res.body.modules.find((module) => module.type === 'canonical');
    const variantSelectorModule = canonicalModule?.data?.pdp_payload?.modules?.find(
      (module) => module.type === 'variant_selector',
    );

    expect(res.body.metadata.identity_resolution).toEqual(
      expect.objectContaining({
        resolution_source: 'identity_graph_live',
      }),
    );
    expect(canonicalModule?.data).toEqual(
      expect.objectContaining({
        canonical_scope: 'synthetic',
        product_line_id: 'pl_boj_daily_tinted_spf',
      }),
    );
    expect(canonicalModule?.data?.pdp_payload?.product?.product_line_options).toEqual([
      expect.objectContaining({ label: 'DN310', product_id: 'ext_boj_dn310', selected: true }),
      expect.objectContaining({ label: 'DN350', product_id: 'ext_boj_dn350', selected: false }),
    ]);
    expect(variantSelectorModule?.data?.product_line_options).toHaveLength(2);
  });
});
