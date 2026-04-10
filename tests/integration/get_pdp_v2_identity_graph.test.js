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
              variant_axes: { volume: '45ml' },
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
              variant_axes: { volume: '45ml' },
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
              variant_axes: { volume: '45ml' },
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
              variant_axes: { volume: '45ml' },
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
              variant_axes: { volume: '100ml' },
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
          include: ['offers', 'reviews_preview'],
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
    expect(reviewsModule?.data).toEqual(
      expect.objectContaining({
        aggregation_scope: 'product_line',
        exact_item_review_count: 16,
        product_line_review_count: 42,
      }),
    );
    expect(offersModule?.data?.product_group_id).toBe('sig_krave_45');
    expect(Array.isArray(offersModule?.data?.offers)).toBe(true);
    expect(offersModule.data.offers).toHaveLength(2);
  });
});
