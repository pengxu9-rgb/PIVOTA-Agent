jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

const ORIGINAL_ENV = process.env;

function loadServerWithDb() {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test',
  };
  const db = require('../src/db');
  db.query.mockReset();
  const app = require('../src/server');
  return { db, debug: app._debug };
}

describe('external seed product detail hydration', () => {
  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('fetchProductDetailForOffers returns enriched external seed detail for external_seed merchant', async () => {
    const { db, debug } = loadServerWithDb();

    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'eps_rare_1',
          external_product_id: 'ext_rare_1',
          canonical_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          destination_url:
            'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
          title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
          image_url: 'https://cdn.example.com/rare.jpg',
          price_amount: '30.00',
          price_currency: 'USD',
          availability: 'In Stock',
          seed_data: {
            brand: 'Rare Beauty',
            pdp_description_raw: 'A flexible tinted moisturizer.',
            pdp_ingredients_raw: 'Water, Niacinamide, Ceramide NP',
            pdp_active_ingredients_raw: 'Niacinamide',
            pdp_how_to_use_raw: 'Blend with fingers or brush.',
            seed_description_origin: 'pdp_product_description',
            pdp_field_capture_status: {
              description_raw: 'present',
              details_sections: 'present',
              ingredients_raw: 'present',
              active_ingredients_raw: 'present',
              how_to_use_raw: 'present',
            },
            active_ingredients: ['Niacinamide'],
            key_ingredients: ['Ceramide NP'],
            ingredient_intel: {
              raw_ingredient_text_clean: 'Water, Niacinamide, Ceramide NP',
              inci_list: ['Water', 'Niacinamide', 'Ceramide NP'],
            },
            pdp_details_sections: [
              { heading: 'How to use', body: 'Blend with fingers or brush.' },
              { heading: 'Details', body: 'Light to medium coverage.' },
            ],
            snapshot: {
              canonical_url:
                'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
              variants: [
                {
                  variant_id: '39775686983815',
                  price: '30.00',
                  currency: 'USD',
                  stock: 'In Stock',
                },
              ],
            },
          },
        },
      ],
    });

    const product = await debug.fetchProductDetailForOffers({
      merchantId: 'external_seed',
      productId: 'ext_rare_1',
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(product).toMatchObject({
      merchant_id: 'external_seed',
      product_id: 'ext_rare_1',
      pdp_description_raw: 'A flexible tinted moisturizer.',
      pdp_ingredients_raw: 'Water, Niacinamide, Ceramide NP',
      pdp_active_ingredients_raw: 'Niacinamide',
      pdp_how_to_use_raw: 'Blend with fingers or brush.',
      raw_ingredient_text_clean: 'Water, Niacinamide, Ceramide NP',
      seed_description_origin: 'pdp_product_description',
    });
    expect(product.inci_list).toEqual(['Water', 'Niacinamide', 'Ceramide NP']);
    expect(product.active_ingredients).toEqual(['Niacinamide']);
    expect(product.pdp_details_sections).toHaveLength(2);
  });
});
