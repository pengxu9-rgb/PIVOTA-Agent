const {
  pickSeedTargetUrl,
  buildExtractRequestBody,
  chooseRepresentativeProduct,
  buildSeedUpdatePayload,
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
});
