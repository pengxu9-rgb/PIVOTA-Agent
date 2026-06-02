describe('catalogEntityResolution', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  test('resolves any member sig to the primary canonical sig and group members', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgres://test',
    };
    const { resolveCanonicalCatalogEntityGroup } = require('../../src/services/catalogEntityResolution');
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          content_key: 'ck_alpha',
          product_key: 'prod::official::shopify::p1',
          merchant_id: 'official',
          merchant_name: 'Official Store',
          platform: 'shopify',
          source_product_id: 'p1',
          product_title: 'Alpha Barrier Serum',
          brand: 'Alpha Beauty',
          pivota_signature_id: 'sig_primaryalpha',
          internal_product_group_id: 'pg_alpha',
          is_primary: true,
          offer_count: 1,
          pdp_lifecycle_stage: 'published',
          pivota_signature_minted_at: '2026-01-01T00:00:00.000Z',
        },
        {
          content_key: 'ck_alpha',
          product_key: 'prod::retail::shopify::p2',
          merchant_id: 'retail',
          merchant_name: 'Retailer',
          platform: 'shopify',
          source_product_id: 'p2',
          product_title: 'Alpha Barrier Serum',
          brand: 'Alpha Beauty',
          pivota_signature_id: 'sig_memberalpha',
          internal_product_group_id: 'pg_alpha',
          is_primary: false,
          offer_count: 1,
          pdp_lifecycle_stage: 'validated',
          pivota_signature_minted_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    }));

    const group = await resolveCanonicalCatalogEntityGroup({
      productId: 'sig_memberalpha',
      queryFn,
    });

    expect(group.product_group_id).toBe('sig_primaryalpha');
    expect(group.canonical_sig_id).toBe('sig_primaryalpha');
    // canonical_entity_id is the stable pg_* (does not flip with the primary).
    expect(group.canonical_entity_id).toBe('pg_alpha');
    expect(group.member_sig_ids).toEqual(['sig_primaryalpha', 'sig_memberalpha']);
    expect(group.members).toHaveLength(2);
    expect(group.members.find((member) => member.is_primary)).toEqual(
      expect.objectContaining({
        merchant_id: 'official',
        product_id: 'p1',
      }),
    );
  });

  test('projects catalog commerce payload into canonical group members for offer building', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgres://test',
    };
    const { resolveCanonicalCatalogEntityGroup } = require('../../src/services/catalogEntityResolution');
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          content_key: 'ck_cosrx_eye',
          product_key: 'prod::external_seed::external_seed::ext_official',
          merchant_id: 'external_seed',
          merchant_name: 'COSRX',
          platform: 'external_seed',
          source_product_id: 'ext_official',
          product_title: 'Advanced Snail Peptide Eye Cream',
          brand: 'COSRX',
          canonical_url: 'https://www.cosrx.com/products/advanced-snail-peptide-eye-cream',
          product_image_url: 'https://cdn.example/official.png',
          product_payload: {
            price_amount: 28,
            price_currency: 'USD',
            availability: 'in_stock',
            variants: [
              {
                variant_id: 'official_085',
                title: '0.85 fl oz',
                price: '28.00',
                currency: 'USD',
              },
            ],
          },
          pivota_signature_id: 'sig_cosrxofficial',
          internal_product_group_id: 'pg_cosrx_eye',
          is_primary: true,
          offer_count: 1,
          pdp_lifecycle_stage: 'published',
          pivota_signature_minted_at: '2026-01-01T00:00:00.000Z',
        },
        {
          content_key: 'ck_cosrx_eye',
          product_key: 'prod::external_seed::external_seed::ulta_eye',
          merchant_id: 'external_seed',
          merchant_name: 'Ulta Beauty',
          platform: 'external_seed',
          source_product_id: 'ulta:eye',
          product_title: 'Advanced Snail Peptide Eye Cream',
          brand: 'COSRX',
          canonical_url: 'https://www.ulta.com/p/advanced-snail-peptide-eye-cream',
          product_payload: {
            price_amount: 22,
            price_currency: 'USD',
            availability: 'in_stock',
            variants: [
              {
                variant_id: 'ulta_085',
                title: '0.85 fl oz',
                price: '22.00',
                currency: 'USD',
              },
            ],
          },
          pivota_signature_id: 'sig_cosrxulta',
          internal_product_group_id: 'pg_cosrx_eye',
          is_primary: false,
          offer_count: 1,
          pdp_lifecycle_stage: 'validated',
          pivota_signature_minted_at: '2026-01-02T00:00:00.000Z',
        },
      ],
    }));

    const group = await resolveCanonicalCatalogEntityGroup({
      productId: 'ulta:eye',
      merchantId: 'external_seed',
      queryFn,
    });

    expect(group.product_group_id).toBe('sig_cosrxofficial');
    const ultaMember = group.members.find((member) => member.product_id === 'ulta:eye');
    expect(ultaMember).toEqual(
      expect.objectContaining({
        merchant_id: 'external_seed',
        merchant_name: 'Ulta Beauty',
        product_id: 'ulta:eye',
      }),
    );
    expect(ultaMember.source_payload).toEqual(
      expect.objectContaining({
        price_amount: 22,
        price_currency: 'USD',
        availability: 'in_stock',
        canonical_url: 'https://www.ulta.com/p/advanced-snail-peptide-eye-cream',
        variants: [
          expect.objectContaining({
            variant_id: 'ulta_085',
            price: '22.00',
            currency: 'USD',
          }),
        ],
      }),
    );
  });

  test('standalone product (no product group) falls back canonical_entity_id to sig', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgres://test',
    };
    const { resolveCanonicalCatalogEntityGroup } = require('../../src/services/catalogEntityResolution');
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          content_key: 'ck_lonely',
          product_key: 'prod::external_seed::external_seed::ext_lonely',
          merchant_id: 'external_seed',
          merchant_name: 'Solo Store',
          platform: 'external_seed',
          source_product_id: 'ext_lonely',
          product_title: 'Lonely Standalone Serum',
          brand: 'Solo',
          pivota_signature_id: 'sig_lonely',
          internal_product_group_id: null, // ungrouped: no pg_*
          is_primary: true,
          offer_count: 1,
          pdp_lifecycle_stage: 'published',
          pivota_signature_minted_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

    const group = await resolveCanonicalCatalogEntityGroup({
      productId: 'sig_lonely',
      queryFn,
    });

    // No pg_* → canonical_entity_id falls back to the sig (which is stable for a singleton).
    expect(group.canonical_entity_id).toBe('sig_lonely');
    expect(group.canonical_sig_id).toBe('sig_lonely');
    expect(group.internal_product_group_id).toBeNull();
  });

  test('batch resolves relationship graph ext refs to one derived family key', async () => {
    const {
      resolveRelationshipGraphRefsToCanonicalEntities,
      _internals,
    } = require('../../src/services/catalogEntityResolution');
    _internals.RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE.clear();
    const queryFn = jest.fn(async (sql, params) => {
      expect(sql).toMatch(/unnest\(\$1::text\[\]\)/);
      expect(params[0]).toEqual(['product:ext_concealer_150', 'product:ext_concealer_160']);
      return {
        rows: [
          {
            input_ref: 'product:ext_concealer_150',
            normalized_ref: 'product:ext_concealer_150',
            source_product_id: 'ext_concealer_150',
            title: "Pro Filt'r Instant Retouch Concealer - #150",
            brand: 'Fenty Beauty',
            category: 'concealer',
            product_type: 'concealer',
            product_payload: {},
            pivota_signature_id: 'sig_concealer150',
            product_group_id: 'pg_concealer150',
            is_primary: true,
            pdp_lifecycle_stage: 'published',
          },
          {
            input_ref: 'product:ext_concealer_160',
            normalized_ref: 'product:ext_concealer_160',
            source_product_id: 'ext_concealer_160',
            title: "Pro Filt'r Instant Retouch Concealer - #160",
            brand: 'Fenty Beauty',
            category: 'concealer',
            product_type: 'concealer',
            product_payload: {},
            pivota_signature_id: 'sig_concealer160',
            product_group_id: 'pg_concealer160',
            is_primary: false,
            pdp_lifecycle_stage: 'published',
          },
        ],
      };
    });

    const resolved = await resolveRelationshipGraphRefsToCanonicalEntities(
      ['product:ext_concealer_150', 'product:ext_concealer_160'],
      { queryFn, bypassCache: true },
    );

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(resolved.get('product:ext_concealer_150').family_key).toBe(
      resolved.get('product:ext_concealer_160').family_key,
    );
    expect(resolved.get('product:ext_concealer_150')).toMatchObject({
      family_key_source: 'derived_family_key',
      product_group_id: 'pg_concealer150',
      pivota_signature_id: 'sig_concealer150',
      display_snapshot_source: 'product_group_primary',
    });
    expect(resolved.get('product:ext_concealer_150').family_key).toMatch(/^family:v1:/);
  });

  test('relationship graph resolver falls back to snapshot-derived family before bare ref', async () => {
    const { resolveRelationshipGraphRefsToCanonicalEntities, _internals } = require('../../src/services/catalogEntityResolution');
    _internals.RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE.clear();
    const queryFn = jest.fn(async () => ({ rows: [] }));

    const resolved = await resolveRelationshipGraphRefsToCanonicalEntities(
      [
        {
          ref: 'product:ext_missing',
          snapshot: {
            product_id: 'ext_missing',
            brand: 'Rare Beauty',
            name: 'Soft Pinch Liquid Blush - Joy',
            category: 'blush',
          },
        },
        'product:sig_unresolved',
      ],
      { queryFn, bypassCache: true },
    );

    expect(resolved.get('product:ext_missing').family_key).toMatch(/^family:v1:/);
    expect(resolved.get('product:ext_missing').family_key_source).toBe('derived_family_key');
    expect(resolved.get('product:sig_unresolved')).toMatchObject({
      family_key: 'ref:product:sig_unresolved',
      family_key_source: 'fallback_ref',
      display_snapshot_source: 'fallback_ref',
    });
  });

  test('relationship graph resolver does not use sig or pg ids as family keys', async () => {
    const { resolveRelationshipGraphRefsToCanonicalEntities, _internals } = require('../../src/services/catalogEntityResolution');
    _internals.RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE.clear();
    const queryFn = jest.fn(async (sql, params) => ({
      rows: params[0].map((ref) => ({
        input_ref: ref,
        normalized_ref: String(ref).toLowerCase(),
        source_product_id: 'ext_listing',
        title: 'Gloss Bomb Universal Lip Luminizer - Fenty Glow',
        brand: 'Fenty Beauty',
        category: 'lip gloss',
        product_type: 'lip gloss',
        product_payload: {},
        pivota_signature_id: 'sig_listing',
        product_group_id: 'pg_offer',
        is_primary: true,
        pdp_lifecycle_stage: 'published',
      })),
    }));

    const resolved = await resolveRelationshipGraphRefsToCanonicalEntities(
      ['product:sig_listing', 'product:pg_offer'],
      { queryFn, bypassCache: true },
    );

    const sigContext = resolved.get('product:sig_listing');
    const pgContext = resolved.get('product:pg_offer');
    expect(sigContext.family_key).toBe(pgContext.family_key);
    expect(sigContext.family_key).toMatch(/^family:v1:/);
    expect(sigContext.family_key).not.toBe('sig_listing');
    expect(pgContext.family_key).not.toBe('pg_offer');
    expect(sigContext).toMatchObject({
      pivota_signature_id: 'sig_listing',
      product_group_id: 'pg_offer',
    });
  });
});
