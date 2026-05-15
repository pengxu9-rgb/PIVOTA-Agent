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
    expect(group.member_sig_ids).toEqual(['sig_primaryalpha', 'sig_memberalpha']);
    expect(group.members).toHaveLength(2);
    expect(group.members.find((member) => member.is_primary)).toEqual(
      expect.objectContaining({
        merchant_id: 'official',
        product_id: 'p1',
      }),
    );
  });
});
