const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  buildSeedUpdatePayload,
  comparableSeedData,
  normalizeComparableUrlKey,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
} = require('../../scripts/backfill-external-product-seeds-catalog');

describe('backfill-external-product-seeds-catalog', () => {
  test('prefers canonical URL when building extract target', () => {
    const row = {
      canonical_url: 'https://example.com/p/canonical-product',
      destination_url: 'https://example.com/p/destination-product',
      seed_data: {
        canonical_url: 'https://example.com/p/fallback-canonical',
      },
    };

    expect(pickSeedTargetUrl(row)).toBe('https://example.com/p/canonical-product');
  });

  test('passes the seed market through to catalog-intelligence', () => {
    const row = {
      id: 'eps_theordinary_1',
      market: 'us',
      domain: 'theordinary.com',
      title: 'UV Filters SPF 45 Serum',
      seed_data: {
        brand: 'The Ordinary',
      },
    };

    expect(buildExtractRequestBody('https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html', row)).toEqual({
      brand: 'The Ordinary',
      domain: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      limit: 50,
      market: 'US',
    });
  });

  test('matches locale-normalized product URLs when choosing the representative product', () => {
    const row = {
      canonical_url: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      destination_url: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      seed_data: {
        snapshot: {
          canonical_url: 'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'UV Filters SPF 45 Serum',
            url: 'https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html',
          },
        ],
      },
      'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
      row,
    );

    expect(product.url).toBe('https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html');
    expect(normalizeComparableUrlKey(product.url)).toBe(
      normalizeComparableUrlKey('https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html'),
    );
  });

  test('normalizes locale-prefixed seed targets to the requested market locale', () => {
    expect(
      normalizeTargetUrlForMarket(
        'https://theordinary.com/de-de/uv-filters-spf-45-serum-100720.html',
        'US',
      ),
    ).toBe('https://theordinary.com/en-us/uv-filters-spf-45-serum-100720.html');
  });

  test('does not accept an unrelated fallback product for direct PDP targets', () => {
    const row = {
      canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      destination_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      seed_data: {
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Promotional Terms & Conditions',
            url: 'https://theordinary.com/en-nl/contact-us.html',
          },
        ],
      },
      'https://theordinary.com/en-us/the-clear-set-100630.html',
      row,
    );

    expect(product).toBeNull();
  });

  test('accepts a strong successor PDP for stale direct product targets when title affinity and PDP fields are present', () => {
    const row = {
      title: 'Shade and Illuminate Soft Radiance Foundation SPF 50',
      canonical_url: 'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
      destination_url:
        'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
      seed_data: {
        snapshot: {
          canonical_url:
            'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
            url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
            description_raw: 'A skincare-infused foundation with SPF 50+.',
            ingredients_raw: 'Water, Glycerin, Niacinamide',
            details_sections: [
              {
                heading: 'How To Use',
                body: 'Apply onto primed skin.',
                source_kind: 'accordion_how_to_use',
              },
            ],
          },
          {
            title: 'Lip Color',
            url: 'https://www.tomfordbeauty.com/products/lip-color',
            description_raw: 'A lipstick.',
            ingredients_raw: 'Wax, Pigments',
            details_sections: [
              {
                heading: 'Details',
                body: 'Satin finish.',
                source_kind: 'accordion_details',
              },
            ],
          },
        ],
      },
      'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
      row,
    );

    expect(product.title).toBe('Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+');
    expect(product.url).toBe(
      'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
    );
  });

  test('recovers the original PDP target from diagnostics when the stored URL drifted to contact-us', () => {
    const row = {
      canonical_url: 'https://theordinary.com/en-us/contact-us.html',
      destination_url: 'https://theordinary.com/en-us/contact-us.html',
      seed_data: {
        snapshot: {
          diagnostics: {
            http_trace: [
              { url: 'https://theordinary.com/products.json?limit=1', status: 404 },
              { url: 'https://theordinary.com/en-us/the-clear-set-100630.html', status: 404 },
              { url: 'https://theordinary.com/contact-us.html', status: 200 },
            ],
          },
        },
      },
    };

    expect(recoverTargetUrlFromDiagnostics(row)).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
    expect(pickSeedTargetUrl(row)).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
  });

  test('preserves existing images and variants when extraction returns empty', () => {
    const row = {
      id: 'eps_1',
      title: 'Existing Product',
      canonical_url: 'https://example.com/p/existing-product',
      destination_url: 'https://example.com/p/existing-product',
      image_url: 'https://example.com/existing.jpg',
      price_amount: 25,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        image_url: 'https://example.com/existing.jpg',
        image_urls: ['https://example.com/existing.jpg', 'https://example.com/existing-2.jpg'],
        snapshot: {
          canonical_url: 'https://example.com/p/existing-product',
          image_urls: ['https://example.com/existing.jpg', 'https://example.com/existing-2.jpg'],
          variants: [
            {
              sku: 'EXISTING-001',
              variant_id: 'EXISTING-001',
              price: '25.00',
              currency: 'USD',
              stock: 'In Stock',
              image_url: 'https://example.com/existing.jpg',
              image_urls: ['https://example.com/existing.jpg', 'https://example.com/existing-2.jpg'],
            },
          ],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'bot_challenge' },
      },
      'https://example.com/p/existing-product',
    );

    expect(payload.nextRow.image_url).toBe('https://example.com/existing.jpg');
    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://example.com/existing.jpg',
      'https://example.com/existing-2.jpg',
    ]);
    expect(payload.nextRow.seed_data.snapshot.variants).toHaveLength(1);
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual({ failure_category: 'bot_challenge' });
  });

  test('drops polluted fallback variants when a contact-us row is recovered to a direct PDP target', () => {
    const row = {
      id: 'eps_contact_drift',
      title: 'Promotional Terms & Conditions',
      canonical_url: 'https://theordinary.com/en-us/contact-us.html',
      destination_url: 'https://theordinary.com/en-us/contact-us.html',
      image_url: '',
      price_amount: null,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'The Clear Set',
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/contact-us.html',
          variants: [
            {
              sku: 'CONTACT-US',
              variant_id: 'CONTACT-US',
              url: 'https://theordinary.com/en-us/contact-us.html',
              price: '',
              currency: 'USD',
              stock: 'In Stock',
              description: 'Our Customer Happiness team is here to help.',
            },
          ],
          diagnostics: {
            http_trace: [
              { url: 'https://theordinary.com/en-us/the-clear-set-100630.html', status: 404 },
              { url: 'https://theordinary.com/contact-us.html', status: 200 },
            ],
          },
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'no_product_urls' },
      },
      'https://theordinary.com/en-us/the-clear-set-100630.html',
    );

    expect(payload.nextRow.title).toBe('The Clear Set');
    expect(payload.nextRow.canonical_url).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
    expect(payload.nextRow.destination_url).toBe('https://theordinary.com/en-us/the-clear-set-100630.html');
    expect(payload.nextRow.seed_data.snapshot.variants).toEqual([]);
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual({ failure_category: 'no_product_urls' });
  });

  test('syncs top-level seed description to the refreshed variant description', () => {
    const row = {
      id: 'eps_salicylic',
      title: 'Salicylic Acid 2% Solution',
      canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      destination_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
      image_url: 'https://example.com/salicylic.jpg',
      price_amount: 6.7,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Salicylic Acid 2% Solution',
        description: 'Ein gezieltes Serum für die zu Unreinheiten neigende Haut.',
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
          description: 'Ein gezieltes Serum für die zu Unreinheiten neigende Haut.',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Salicylic Acid 2% Solution',
            url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            variants: [
              {
                id: '769915231731',
                sku: '769915231731',
                description:
                  'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
              },
            ],
          },
        ],
        variants: [
          {
            id: '769915231731',
            sku: '769915231731',
            product_url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            url: 'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
            description:
              'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
            image_url: 'https://example.com/salicylic.jpg',
            image_urls: ['https://example.com/salicylic.jpg'],
            price: '6.70',
            currency: 'USD',
            stock: 'In Stock',
          },
        ],
        diagnostics: { failure_category: null },
      },
      'https://theordinary.com/en-us/salicylic-acid-2-solution-acne-control-100098.html',
    );

    expect(payload.nextRow.seed_data.description).toBe(
      'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
    );
    expect(payload.nextRow.seed_data.snapshot.description).toBe(
      'Formulated with Salicylic Acid for acne, this water-based Beta Hydroxy Acid (BHA) serum contains a 2% concentration to offer surface-level exfoliation.',
    );
  });

  test('persists PDP raw fields and provenance when extractor returns module-level product data', () => {
    const row = {
      id: 'eps_rare_spf',
      title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
      canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      destination_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
      image_url: '',
      price_amount: 32,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        description: 'OFFICIAL: stale synthetic summary',
        snapshot: {
          canonical_url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Positive Light Tinted Moisturizer Broad Spectrum SPF 20 Sunscreen',
            url: 'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
            description_raw: 'A breathable tinted moisturizer with SPF 20.',
            details_sections: [
              {
                heading: 'Ingredients',
                body: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
                source_kind: 'accordion_ingredients',
              },
            ],
            ingredients_raw: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
            active_ingredients_raw: 'Titanium Dioxide, Zinc Oxide',
            how_to_use_raw: 'Apply before sun exposure.',
            field_capture_status: {
              description_raw: 'present',
              details_sections: 'present',
              ingredients_raw: 'present',
              active_ingredients_raw: 'present',
              how_to_use_raw: 'present',
            },
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://rarebeauty.com/products/positive-light-tinted-moisturizer-broad-spectrum-spf-20-sunscreen',
    );

    expect(payload.nextRow.seed_data.pdp_description_raw).toBe('A breathable tinted moisturizer with SPF 20.');
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe('Titanium Dioxide 3.4%, Zinc Oxide 14.37%');
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBe('Titanium Dioxide, Zinc Oxide');
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe('Apply before sun exposure.');
    expect(payload.nextRow.seed_data.seed_description_origin).toBe('pdp_product_description');
    expect(payload.nextRow.seed_data.snapshot.pdp_details_sections).toEqual([
      {
        heading: 'Ingredients',
        body: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
        source_kind: 'accordion_ingredients',
      },
    ]);
  });

  test('upgrades stale direct product seeds to a successor PDP when the extractor returns a stronger replacement', () => {
    const row = {
      id: 'eps_tomford_foundation',
      title: 'Shade and Illuminate Soft Radiance Foundation SPF 50',
      canonical_url: 'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
      destination_url:
        'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
      image_url: '',
      price_amount: 95,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'Shade and Illuminate Soft Radiance Foundation SPF 50',
        snapshot: {
          canonical_url:
            'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
            url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
            description_raw: 'A skincare-infused foundation with SPF 50+.',
            details_sections: [
              {
                heading: 'Ingredients',
                body: 'Water, Glycerin, Niacinamide',
                source_kind: 'accordion_ingredients',
              },
            ],
            ingredients_raw: 'Water, Glycerin, Niacinamide',
            active_ingredients_raw: 'Niacinamide',
            how_to_use_raw: 'Apply onto primed skin.',
            field_capture_status: {
              description_raw: 'present',
              details_sections: 'present',
              ingredients_raw: 'present',
              active_ingredients_raw: 'present',
              how_to_use_raw: 'present',
            },
            variants: [],
          },
        ],
        variants: [
          {
            id: 'TCT117',
            sku: 'TCT117',
            product_url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
            url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50?variant=53059916267733',
            description: '',
            image_url: 'https://www.tomfordbeauty.com/cdn/shop/files/tct117.png',
            image_urls: ['https://www.tomfordbeauty.com/cdn/shop/files/tct117.png'],
            price: '95.00',
            currency: 'USD',
            stock: 'In Stock',
          },
        ],
        diagnostics: { failure_category: null },
      },
      'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=11.0_Dusk',
    );

    expect(payload.nextRow.title).toBe('Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+');
    expect(payload.nextRow.canonical_url).toBe(
      'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
    );
    expect(payload.nextRow.destination_url).toBe(
      'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50?variant=53059916267733',
    );
    expect(payload.nextRow.seed_data.seed_description_origin).toBe('pdp_product_description');
    expect(payload.nextRow.seed_data.pdp_description_raw).toBe('A skincare-infused foundation with SPF 50+.');
    expect(payload.nextRow.seed_data.pdp_ingredients_raw).toBe('Water, Glycerin, Niacinamide');
    expect(payload.nextRow.seed_data.pdp_active_ingredients_raw).toBe('Niacinamide');
    expect(payload.nextRow.seed_data.pdp_how_to_use_raw).toBe('Apply onto primed skin.');
    expect(payload.nextRow.seed_data.snapshot.canonical_url).toBe(
      'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
    );
  });

  test('marks PDP field capture status as present when raw fields exist even if extractor status is stale', () => {
    const row = {
      id: 'eps_fenty_fat_water',
      title: 'Fat Water Niacinamide Pore-Refining Toner Serum',
      canonical_url: 'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
      destination_url: 'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
      image_url: '',
      price_amount: 12.6,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        seed_description_origin: 'pdp_variant_description',
        snapshot: {},
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Fat Water Niacinamide Pore-Refining Toner Serum with Barbados Cherry',
            url: 'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
            description_raw: 'A serum-toner hybrid that refines pores.',
            details_sections: [
              {
                heading: 'Ingredients',
                body: 'Niacinamide, Barbados Cherry, Australian Lemon Myrtle',
                source_kind: 'accordion_ingredients',
              },
            ],
            ingredients_raw: 'Niacinamide, Barbados Cherry, Australian Lemon Myrtle',
            field_capture_status: {
              description_raw: 'missing',
              details_sections: 'missing',
              ingredients_raw: 'missing',
              active_ingredients_raw: 'missing',
              how_to_use_raw: 'missing',
            },
            variants: [],
          },
        ],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://fentybeauty.com/products/fat-water-niacinamide-pore-refining-toner-serum-with-barbados-cherry',
    );

    expect(payload.nextRow.seed_data.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      active_ingredients_raw: 'missing',
      how_to_use_raw: 'missing',
    });
    expect(payload.nextRow.seed_data.snapshot.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      active_ingredients_raw: 'missing',
      how_to_use_raw: 'missing',
    });
  });

  test('clears stale top-level seed description when a blocked seed still has no product URLs', () => {
    const row = {
      id: 'eps_blocked_collection',
      title: 'The Hair & Scalp Collection',
      canonical_url: 'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
      destination_url: 'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
      image_url: '',
      price_amount: 0,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'The Hair & Scalp Collection',
        description: 'Eine tägliche Kollektion für gesünder aussehendes Haar und Kopfhaut.',
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
          description: 'Eine tägliche Kollektion für gesünder aussehendes Haar und Kopfhaut.',
          diagnostics: { failure_category: 'no_product_urls' },
        },
        variants: [],
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'no_product_urls' },
      },
      'https://theordinary.com/en-us/the-hair-and-scalp-collection-300127.html',
    );

    expect(payload.nextRow.seed_data.description).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.description).toBe('');
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual({ failure_category: 'no_product_urls' });
  });

  test('preserves manual description overrides even when the refreshed seed remains blocked', () => {
    const row = {
      id: 'eps_manual_clear_set',
      title: 'The Clear Set',
      canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      destination_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
      image_url: '',
      price_amount: 0,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        title: 'The Clear Set',
        description: 'A 3-step regimen with Salicylic Acid 2% Solution for clearer skin',
        manual_overrides: {
          description: 'A 3-step regimen with Salicylic Acid 2% Solution for clearer skin',
        },
        snapshot: {
          canonical_url: 'https://theordinary.com/en-us/the-clear-set-100630.html',
          description: '',
          diagnostics: { failure_category: 'no_product_urls' },
        },
        variants: [],
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: 'no_product_urls' },
      },
      'https://theordinary.com/en-us/the-clear-set-100630.html',
    );

    expect(payload.nextRow.seed_data.description).toBe(
      'A 3-step regimen with Salicylic Acid 2% Solution for clearer skin',
    );
  });

  test('applies manual image overrides when extraction and stored seed images are both empty', () => {
    const row = {
      id: 'eps_patyka_bundle',
      title: 'Duo Mousse Nettoyante Detox - BOUTIQUE SPA',
      canonical_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      destination_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
      image_url: '',
      price_amount: 23.85,
      price_currency: 'EUR',
      availability: 'in_stock',
      seed_data: {
        brand: 'Patyka',
        snapshot: {
          canonical_url: 'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [],
        variants: [],
        diagnostics: { failure_category: null },
      },
      'https://patyka.com/products/duo-mousse-nettoyante-detox-boutique-spa',
    );

    expect(payload.nextRow.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Duo_Mousse_Nettoyante_Detox_-_Packshot.jpg?v=1750422282',
    );
    expect(payload.nextRow.seed_data.image_urls).toContain(
      'https://cdn.shopify.com/s/files/1/2139/2967/files/Mousse_Nettoyante_Detox_-_Texture.jpg?v=1763980849',
    );
    expect(payload.nextRow.seed_data.snapshot.diagnostics).toEqual(
      expect.objectContaining({
        failure_category: null,
        manual_image_override: expect.objectContaining({
          applied: true,
          source: 'manual_seed_override',
        }),
      }),
    );
  });

  test('comparableSeedData ignores enrichment synced_at churn for idempotent postchecks', () => {
    const base = comparableSeedData({
      ingredient_intel: {
        external_seed_enrichment: {
          source: 'pdp_ingredient_fields',
          synced_at: '2026-03-23T01:00:00.000Z',
        },
      },
      snapshot: {
        extracted_at: '2026-03-23T01:00:00.000Z',
        ingredient_intel: {
          external_seed_enrichment: {
            source: 'pdp_ingredient_fields',
            synced_at: '2026-03-23T01:00:00.000Z',
          },
        },
      },
    });
    const next = comparableSeedData({
      ingredient_intel: {
        external_seed_enrichment: {
          source: 'pdp_ingredient_fields',
          synced_at: '2026-03-23T02:00:00.000Z',
        },
      },
      snapshot: {
        extracted_at: '2026-03-23T02:00:00.000Z',
        ingredient_intel: {
          external_seed_enrichment: {
            source: 'pdp_ingredient_fields',
            synced_at: '2026-03-23T02:00:00.000Z',
          },
        },
      },
    });

    expect(base).toEqual(next);
    expect(base.ingredient_intel.external_seed_enrichment.synced_at).toBeNull();
    expect(base.snapshot.ingredient_intel.external_seed_enrichment.synced_at).toBeNull();
  });

  test('comparableSeedData ignores object key ordering churn inside pdp sections and variants', () => {
    const before = comparableSeedData({
      pdp_details_sections: [
        {
          body: 'Water, Glycerin',
          heading: 'Ingredients',
          source_kind: 'accordion_button',
        },
      ],
      variants: [
        {
          sku: '83008',
          url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
          price: '24.00',
          stock: 'In Stock',
          currency: 'USD',
          image_url: 'https://example.com/rose.jpg',
          image_urls: ['https://example.com/rose.jpg'],
          variant_id: '12268097536096',
          description: '',
          option_name: 'Title',
          option_value: 'Default Title',
        },
      ],
      snapshot: {
        pdp_details_sections: [
          {
            body: 'Water, Glycerin',
            heading: 'Ingredients',
            source_kind: 'accordion_button',
          },
        ],
        variants: [
          {
            sku: '83008',
            url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
            price: '24.00',
            stock: 'In Stock',
            currency: 'USD',
            image_url: 'https://example.com/rose.jpg',
            image_urls: ['https://example.com/rose.jpg'],
            variant_id: '12268097536096',
            description: '',
            option_name: 'Title',
            option_value: 'Default Title',
          },
        ],
      },
    });

    const after = comparableSeedData({
      pdp_details_sections: [
        {
          heading: 'Ingredients',
          body: 'Water, Glycerin',
          source_kind: 'accordion_button',
        },
      ],
      variants: [
        {
          sku: '83008',
          variant_id: '12268097536096',
          url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
          option_name: 'Title',
          option_value: 'Default Title',
          price: '24.00',
          currency: 'USD',
          stock: 'In Stock',
          image_url: 'https://example.com/rose.jpg',
          image_urls: ['https://example.com/rose.jpg'],
          description: '',
        },
      ],
      snapshot: {
        pdp_details_sections: [
          {
            heading: 'Ingredients',
            body: 'Water, Glycerin',
            source_kind: 'accordion_button',
          },
        ],
        variants: [
          {
            sku: '83008',
            variant_id: '12268097536096',
            url: 'https://pixibeauty.example.com/products/rose-ceramide-cream',
            option_name: 'Title',
            option_value: 'Default Title',
            price: '24.00',
            currency: 'USD',
            stock: 'In Stock',
            image_url: 'https://example.com/rose.jpg',
            image_urls: ['https://example.com/rose.jpg'],
            description: '',
          },
        ],
      },
    });

    expect(before).toEqual(after);
  });
});
