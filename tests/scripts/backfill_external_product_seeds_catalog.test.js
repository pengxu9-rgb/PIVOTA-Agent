const axios = require('axios');

const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  processRow,
  buildSeedUpdatePayload,
  buildVariantSeedRows,
  comparableSeedData,
  normalizeComparableUrlKey,
  normalizeTargetUrlForMarket,
  recoverTargetUrlFromDiagnostics,
  parseDelimitedIds,
  sanitizeSeedImageUrls,
  validateNextRowImageHealth,
  collectBackfilledExternalProductIds,
} = require('../../scripts/backfill-external-product-seeds-catalog');

describe('backfill-external-product-seeds-catalog', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('parses external product id lists from comma or newline input', () => {
    expect(parseDelimitedIds('ext_a, ext_b\next_a\n\next_c')).toEqual(['ext_a', 'ext_b', 'ext_c']);
  });

  test('collects updated external product ids for post-backfill Pivota Insights coverage', () => {
    expect(
      collectBackfilledExternalProductIds([
        { status: 'skipped', row: { external_product_id: 'ext_skipped' } },
        { status: 'updated', row: { external_product_id: 'ext_parent' } },
        {
          status: 'updated',
          row: { external_product_id: 'ext_parent' },
          payload: {
            variant_seed_rows: [
              { external_product_id: 'ext_child_a' },
              { external_product_id: 'ext_child_b' },
            ],
          },
        },
      ]),
    ).toEqual(['ext_parent', 'ext_child_a', 'ext_child_b']);
  });

  test('filters broken image URLs before seed writes while preserving Shopify asset identity', async () => {
    jest
      .spyOn(axios, 'head')
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
      .mockResolvedValueOnce({
        status: 404,
        headers: { 'content-type': 'text/html' },
      });

    const validUrl =
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807';
    const brokenUrl =
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png';

    const result = await validateNextRowImageHealth({
      image_url: validUrl,
      seed_data: {
        image_url: validUrl,
        image_urls: [validUrl, brokenUrl],
        snapshot: {
          image_urls: [validUrl, brokenUrl],
        },
      },
    });

    expect(result.validation).toEqual(
      expect.objectContaining({
        status: 'filtered_broken_images',
        scanned_count: 2,
        valid_count: 1,
        broken_count: 1,
      }),
    );
    expect(result.nextRow.image_url).toBe(validUrl);
    expect(result.nextRow.seed_data.image_urls).toEqual([validUrl]);
    expect(result.nextRow.seed_data.snapshot.diagnostics.image_health_validation.status).toBe(
      'filtered_broken_images',
    );
  });

  test('sanitizes decorative image URLs without stripping versioned Shopify assets', () => {
    expect(
      sanitizeSeedImageUrls([
        'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
        'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
      ]),
    ).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    ]);
  });

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

  test('prefers variant destination URL for expanded exact-item seeds', () => {
    const row = {
      canonical_url: 'https://example.com/products/pro-c-serum',
      destination_url: 'https://example.com/products/pro-c-serum?variant=42771629506608',
      seed_data: {
        source_listing_scope: 'variant',
        parent_external_product_id: 'ext_parent',
        selected_variant_id: '42771629506608',
        snapshot: {
          canonical_url: 'https://example.com/products/pro-c-serum',
          destination_url: 'https://example.com/products/pro-c-serum?variant=42771629506608',
        },
      },
    };

    expect(pickSeedTargetUrl(row)).toBe('https://example.com/products/pro-c-serum?variant=42771629506608');
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

  test('matches singular and plural product PDP paths when choosing the representative product', () => {
    const row = {
      canonical_url: 'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
      destination_url: 'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
      seed_data: {
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
        },
      },
    };

    const product = chooseRepresentativeProduct(
      {
        products: [
          {
            title: 'Gel Eyeliner',
            url: 'https://www.tomfordbeauty.com/products/gel-eyeliner',
          },
        ],
      },
      'https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa',
      row,
    );

    expect(product.url).toBe('https://www.tomfordbeauty.com/products/gel-eyeliner');
    expect(normalizeComparableUrlKey(product.url)).toBe(
      normalizeComparableUrlKey('https://www.tomfordbeauty.com/product/gel-eyeliner?shade=02_Cocoa'),
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

  test('skips direct PDP backfill when extractor only returns unrelated collection products', async () => {
    const row = {
      id: 'eps_tomford_missing_handle',
      title: 'Shade and Illuminate Soft Radiance Foundation SPF 50',
      market: 'US',
      canonical_url:
        'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=9.7_Cool_Dusk',
      destination_url:
        'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=9.7_Cool_Dusk',
      seed_data: {
        snapshot: {
          canonical_url:
            'https://www.tomfordbeauty.com/product/shade-and-illuminate-soft-radiance-foundation-spf-50?shade=9.7_Cool_Dusk',
        },
      },
    };

    jest
      .spyOn(axios, 'post')
      .mockResolvedValueOnce({
        data: {
          products: [
            {
              title: 'Architecture Radiance Hydrating Foundation Broad Spectrum SPF 50+',
              url: 'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
              description_raw: 'A different product.',
              variants: [],
            },
          ],
          variants: [],
          diagnostics: {
            http_trace: [
              {
                url: 'https://www.tomfordbeauty.com/products/shade-and-illuminate-soft-radiance-foundation-spf-50.js',
                status: 404,
              },
              {
                url: 'https://www.tomfordbeauty.com/collections/makeup',
                status: 200,
              },
            ],
          },
        },
      });

    const result = await processRow(row, {
      dryRun: true,
      baseUrl: 'https://catalog.test',
      validateImageHealth: false,
      expandVariants: false,
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('representative_product_not_found');
    expect(result.payload.candidate_product_urls).toEqual([
      'https://www.tomfordbeauty.com/products/architecture-radiance-hydrating-foundation-broad-spectrum-spf-50',
    ]);
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
            faq_items: [
              {
                question: 'NEED HELP? NEED HELP?',
                answer: 'TRACK MY ORDER SERVICES SHIPPING & RETURNS FAQS STORE LOCATOR CONTACT US',
                source_kind: 'merchant_faq',
                source_url: 'https://rarebeauty.com/pages/faqs',
              },
              {
                question: 'Can I wear this every day?',
                answer: 'Yes, apply before sun exposure as part of your daytime routine.',
                source_kind: 'merchant_faq',
              },
            ],
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
    expect(payload.nextRow.seed_data.pdp_faq_items).toEqual([
      {
        question: 'Can I wear this every day?',
        answer: 'Yes, apply before sun exposure as part of your daytime routine.',
        source_kind: 'merchant_faq',
      },
    ]);
    expect(payload.nextRow.seed_data.seed_description_origin).toBe('pdp_product_description');
    expect(payload.nextRow.seed_data.pdp_field_capture_status).toEqual({
      description_raw: 'present',
      details_sections: 'present',
      ingredients_raw: 'present',
      active_ingredients_raw: 'present',
      how_to_use_raw: 'present',
      faq_items: 'present',
    });
    expect(payload.nextRow.seed_data.snapshot.pdp_details_sections).toEqual([
      {
        heading: 'Ingredients',
        body: 'Titanium Dioxide 3.4%, Zinc Oxide 14.37%',
        source_kind: 'accordion_ingredients',
      },
    ]);
    expect(payload.nextRow.seed_data.snapshot.pdp_faq_items).toEqual([
      {
        question: 'Can I wear this every day?',
        answer: 'Yes, apply before sun exposure as part of your daytime routine.',
        source_kind: 'merchant_faq',
      },
    ]);
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

  test('drops decorative extracted images and stale active ingredients during backfill refresh', () => {
    const row = {
      id: 'eps_tom_ford_cleanup',
      title: 'TOM FORD RESEARCH Cleansing Concentrate',
      canonical_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
      destination_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
      image_url: 'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
      price_amount: 100,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Tom Ford Beauty',
        active_ingredients: ['Glycerin', 'Hyaluronic acid'],
        image_urls: [
          'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774376808',
          'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png?v=1774376808&width=2000',
          'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
          'https://sdcdn.io/tf/tf_sku_TAGL01_2000x2000_0.png?width=650px&height=750px',
        ],
        snapshot: {
          canonical_url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
          image_urls: [
            'https://www.tomfordbeauty.com/cdn/shop/files/icon-cart.svg?v=1758691434&width=24',
          ],
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'TOM FORD RESEARCH Cleansing Concentrate',
            url: 'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
            image_url: 'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
              'https://www.tomfordbeauty.com/cdn/shop/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807&width=2000',
              'https://www.tomfordbeauty.com/cdn/shop/files/Menu.svg?v=1771253635&width=24',
            ],
            variants: [],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://www.tomfordbeauty.com/products/tom-ford-research-cleansing-concentrate',
    );

    expect(payload.nextRow.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    );
    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0761/9690/5173/files/tf_sku_T93Y01_2000x2000_0.png?v=1774596807',
    ]);
    expect(payload.nextRow.seed_data.active_ingredients).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.active_ingredients).toBeUndefined();
  });

  test('writes a cleaned derived recall document during catalog backfill', () => {
    const row = {
      id: 'eps_recall_doc_1',
      title: 'Fenty Beauty - Instant Reset Overnight Recovery Gel-Cream',
      canonical_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
      destination_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
      price_amount: 42,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Fenty Skin',
        description:
          'OFFICIAL: A night moisturizer for skin recovery. /// SOCIAL HIGHLIGHTS: customer service.',
        snapshot: {
          canonical_url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Instant Reset Overnight Recovery Gel-Cream',
            url: 'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
            description_raw:
              'A plush overnight gel-cream that helps recharge skin with hydration and barrier support.',
            details_sections: [
              { heading: 'Overview', body: 'A plush overnight gel-cream for hydrated, rested-looking skin.' },
              { heading: 'Support', body: 'Customer service, privacy policy and donation terms.' },
            ],
            variants: [
              {
                id: 'SKU-OVN-1',
                sku: 'SKU-OVN-1',
                description:
                  'A plush overnight gel-cream that helps recharge skin with hydration and barrier support.',
                price: '42.00',
                currency: 'USD',
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://fentyskin.com/products/instant-reset-overnight-recovery-gel-cream',
    );

    expect(payload.nextRow.seed_data.derived.recall).toEqual(
      expect.objectContaining({
        retrieval_title: 'Instant Reset Overnight Recovery Gel-Cream',
        retrieval_summary: expect.stringContaining('A plush overnight gel-cream'),
        brand: 'Fenty Skin',
      }),
    );
    expect(payload.nextRow.seed_data.derived.recall.retrieval_body).not.toMatch(
      /customer service|privacy policy|donation/i,
    );
  });

  test('preserves base PDP scope while retaining extractor variant deep links for expansion', () => {
    const row = {
      id: 'eps_inn_extreme',
      external_product_id: 'ext_parent_extreme',
      market: 'US',
      tool: 'creator_agents',
      title: 'Extreme Cream',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream',
      image_url: 'https://cdn.example.com/full-size.jpg',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'INNBEAUTY Project',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Extreme Cream',
            url: 'https://innbeautyproject.com/products/extreme-cream',
            image_url: 'https://cdn.example.com/full-size.jpg',
            image_urls: ['https://cdn.example.com/full-size.jpg', 'https://cdn.example.com/refill.jpg'],
            variants: [
              {
                id: '41148734668848',
                sku: '0190',
                option_name: 'Option',
                option_value: 'Full Size',
                price: '50.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                image_url: 'https://cdn.example.com/full-size.jpg',
                image_urls: ['https://cdn.example.com/full-size.jpg'],
              },
              {
                id: '41148734701616',
                sku: '0191',
                option_name: 'Option',
                option_value: 'Refill',
                price: '44.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                image_url: 'https://cdn.example.com/refill.jpg',
                image_urls: ['https://cdn.example.com/refill.jpg'],
              },
            ],
          },
        ],
        variants: [
          {
            id: '41148734668848',
            sku: '0190',
            deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
            product_url: 'https://innbeautyproject.com/products/extreme-cream',
          },
          {
            id: '41148734701616',
            sku: '0191',
            deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
            product_url: 'https://innbeautyproject.com/products/extreme-cream',
          },
        ],
        diagnostics: {},
      },
      'https://innbeautyproject.com/products/extreme-cream',
    );

    expect(payload.nextRow.destination_url).toBe('https://innbeautyproject.com/products/extreme-cream');
    expect(payload.nextRow.price_amount).toBe(44);
    expect(payload.nextRow.seed_data.selected_variant_id).toBeUndefined();
    expect(payload.nextRow.seed_data.snapshot.variants[0]).toEqual(
      expect.objectContaining({
        variant_id: '41148734668848',
        url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
      }),
    );
  });

  test('builds exact-item child seeds from variant deep links without mutating the base seed identity', () => {
    const row = {
      id: 'eps_inn_extreme',
      external_product_id: 'ext_parent_extreme',
      market: 'US',
      tool: 'creator_agents',
      domain: 'innbeautyproject.com',
      title: 'Extreme Cream',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream',
      image_url: 'https://cdn.example.com/full-size.jpg',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'INNBEAUTY Project',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
        },
      },
    };
    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Extreme Cream',
            url: 'https://innbeautyproject.com/products/extreme-cream',
            variants: [
              {
                id: '41148734668848',
                sku: '0190',
                option_name: 'Option',
                option_value: 'Full Size',
                price: '50.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
                image_url: 'https://cdn.example.com/full-size.jpg',
                image_urls: ['https://cdn.example.com/full-size.jpg'],
              },
              {
                id: '41148734701616',
                sku: '0191',
                option_name: 'Option',
                option_value: 'Refill',
                price: '44.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://innbeautyproject.com/products/extreme-cream',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
                image_url: 'https://cdn.example.com/refill.jpg',
                image_urls: ['https://cdn.example.com/refill.jpg'],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://innbeautyproject.com/products/extreme-cream',
    );

    const rows = buildVariantSeedRows(row, payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^epsv_[0-9a-f]{24}$/),
        external_product_id: expect.stringMatching(/^ext_[0-9a-f]{24}$/),
        destination_url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
        price_amount: 50,
        image_url: 'https://cdn.example.com/full-size.jpg',
      }),
    );
    expect(rows[0].seed_data).toEqual(
      expect.objectContaining({
        source_listing_scope: 'variant',
        parent_external_product_id: 'ext_parent_extreme',
        selected_variant_id: '41148734668848',
        default_variant_id: '41148734668848',
        variant_title: 'Full Size',
      }),
    );
    expect(rows[0].seed_data.snapshot.variants).toHaveLength(1);
    expect(rows[1].seed_data.variant_title).toBe('Refill');
    expect(rows[1].price_amount).toBe(44);
  });

  test('selects exact variant fields when refreshing a variant deep-link seed', () => {
    const row = {
      id: 'epsv_inn_extreme_refill',
      external_product_id: 'ext_variant_refill',
      market: 'US',
      tool: 'creator_agents',
      title: 'Extreme Cream',
      canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
      destination_url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
      image_url: 'https://cdn.example.com/refill.jpg',
      price_amount: 44,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'INNBEAUTY Project',
        source_listing_scope: 'variant',
        parent_external_product_id: 'ext_parent_extreme',
        selected_variant_id: '41148734701616',
        snapshot: {
          canonical_url: 'https://innbeautyproject.com/products/extreme-cream',
          destination_url: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Extreme Cream',
            url: 'https://innbeautyproject.com/products/extreme-cream',
            image_url: 'https://cdn.example.com/full-size.jpg',
            image_urls: ['https://cdn.example.com/full-size.jpg', 'https://cdn.example.com/refill.jpg'],
            variants: [
              {
                id: '41148734668848',
                sku: '0190',
                option_name: 'Option',
                option_value: 'Full Size',
                price: '50.00',
                currency: 'USD',
                stock: 'In Stock',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734668848',
                image_url: 'https://cdn.example.com/full-size.jpg',
                image_urls: ['https://cdn.example.com/full-size.jpg'],
              },
              {
                id: '41148734701616',
                sku: '0191',
                option_name: 'Option',
                option_value: 'Refill',
                price: '44.00',
                currency: 'USD',
                stock: 'In Stock',
                deep_link: 'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
                image_url: 'https://cdn.example.com/refill.jpg',
                image_urls: ['https://cdn.example.com/refill.jpg'],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
    );

    expect(payload.nextRow.destination_url).toBe(
      'https://innbeautyproject.com/products/extreme-cream?variant=41148734701616',
    );
    expect(payload.nextRow.price_amount).toBe(44);
    expect(payload.nextRow.image_url).toBe('https://cdn.example.com/refill.jpg');
    expect(payload.nextRow.seed_data.image_urls).toEqual(['https://cdn.example.com/refill.jpg']);
    expect(payload.nextRow.seed_data.selected_variant_id).toBe('41148734701616');
    expect(payload.nextRow.seed_data.variant_title).toBe('Refill');
    expect(buildVariantSeedRows(row, payload)).toEqual([]);
  });

  test('merges product gallery when selected variant only repeats the product thumbnail', () => {
    const row = {
      id: 'eps_boj_daily_tinted_dn350',
      external_product_id: 'ext_7b89e40cf21f7b8782783e15',
      market: 'US',
      tool: 'creator_agents',
      title: 'Daily Tinted Fluid Sunscreen DN350',
      canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      destination_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
      price_amount: 10,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Beauty of Joseon',
        selected_variant_id: '52402575442292',
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
          selected_variant_id: '52402575442292',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Daily Tinted Fluid Sunscreen DN350',
            url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
            image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/241127JOSEON0307_1.webp?v=1770142124',
            ],
            variants: [
              {
                id: '52402575442292',
                sku: '01BU013',
                option_name: 'Size',
                option_value: '1.69 fl. oz. (50ml)',
                price: '10.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
                image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                ],
              },
              {
                id: '52402575475060',
                sku: '01BU027',
                option_name: 'Size',
                option_value: '0.23 fl. oz. (7ml)',
                price: '2.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
                image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
    );

    expect(payload.nextRow.image_url).toBe(
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
    );
    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/241127JOSEON0307_1.webp?v=1770142124',
    ]);
    expect(payload.nextRow.seed_data.snapshot.image_urls).toEqual(payload.nextRow.seed_data.image_urls);
  });

  test('merges PDP content images when selected variant images are a product gallery subset', () => {
    const row = {
      id: 'eps_boj_daily_tinted_dn350',
      external_product_id: 'ext_7b89e40cf21f7b8782783e15',
      market: 'US',
      tool: 'creator_agents',
      title: 'Daily Tinted Fluid Sunscreen DN350',
      canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      destination_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
      image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg',
      price_amount: 10,
      price_currency: 'USD',
      availability: 'in_stock',
      seed_data: {
        brand: 'Beauty of Joseon',
        selected_variant_id: '52402575442292',
        snapshot: {
          canonical_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
          selected_variant_id: '52402575442292',
        },
      },
    };

    const payload = buildSeedUpdatePayload(
      row,
      {
        products: [
          {
            title: 'Daily Tinted Fluid Sunscreen DN350',
            url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
            image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
            image_urls: [
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
              'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Untitled_design_95.jpg?v=1763500000',
            ],
            variants: [
              {
                id: '52402575442292',
                sku: '01BU013',
                option_name: 'Size',
                option_value: '1.69 fl. oz. (50ml)',
                price: '10.00',
                currency: 'USD',
                stock: 'In Stock',
                product_url: 'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
                image_url: 'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                image_urls: [
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
                  'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
                ],
              },
            ],
          },
        ],
        variants: [],
        diagnostics: {},
      },
      'https://beautyofjoseon.com/products/daily-tinted-fluid-sunscreen-dn350',
    );

    expect(payload.nextRow.seed_data.image_urls).toEqual([
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/DTFS_DN350_Thumbnail_1.jpg?v=1763453373',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Daily-Tinted-Fluid-Sunscreen-DN350_Beauty-of-Joseon_59516391-51502368031092.jpg?v=1763451773',
      'https://cdn.shopify.com/s/files/1/0558/4135/7989/files/Untitled_design_95.jpg?v=1763500000',
    ]);
  });
});
