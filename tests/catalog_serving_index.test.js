const {
  backfillCatalogServingIndex,
  buildCatalogServingBackfillDocs,
  buildCatalogServingDoc,
  buildCatalogServingSearchBody,
  bulkUpsertCatalogServingDocs,
  decodeCatalogServingCursor,
  encodeCatalogServingCursor,
  getCatalogServingIndexConfig,
  isCatalogServingIndexEnabled,
  searchCatalogServingIndex,
} = require('../src/services/catalogServingIndex');

describe('catalog serving index', () => {
  test('buildCatalogServingDoc maps exact-item identity and offer fields into a serving document', () => {
    const doc = buildCatalogServingDoc(
      {
        product_id: 'gbr_45ml',
        merchant_id: 'external_seed',
        sellable_item_group_id: 'sig_krave_gbr_45ml',
        product_line_id: 'pl_krave_gbr',
        review_family_id: 'rf_krave_gbr',
        title: 'Great Barrier Relief',
        card_subtitle: 'Barrier serum',
        brand: 'KraveBeauty',
        category: 'Skincare',
        product_type: 'Serum',
        image_url: 'https://example.com/gbr.jpg',
        price: 28,
        default_offer_id: 'offer_1',
        offers: [
          { offer_id: 'offer_1', price: { amount: 28 }, merchant_id: 'external_seed', redirect_url: 'https://brand.example/gbr' },
          { offer_id: 'offer_2', price: { amount: 30 }, merchant_id: 'merch_internal' },
        ],
        tags: ['editorial: barrier repair'],
        group_members: [
          { merchant_id: 'external_seed', product_id: 'gbr_45ml' },
          { merchant_id: 'merch_internal', product_id: 'gbr_internal_45ml' },
        ],
        card_intro: 'Reviewed by Pivota.',
      },
      { market: 'US', publish_state: 'public' },
    );

    expect(doc).toEqual(
      expect.objectContaining({
        doc_id: 'sellable:sig_krave_gbr_45ml',
        sellable_item_group_id: 'sig_krave_gbr_45ml',
        product_line_id: 'pl_krave_gbr',
        review_family_id: 'rf_krave_gbr',
        brand_name: 'KraveBeauty',
        category_paths: ['Skincare', 'Serum'],
        market: 'US',
        publish_state: 'public',
        title: 'Great Barrier Relief',
        subtitle: 'Barrier serum',
        price_min: 28,
        price_max: 30,
        default_offer_id: 'offer_1',
        internal_offer_exists: true,
        external_offer_exists: true,
        pivota_insight_status: 'available',
        pivota_insight_summary: 'Reviewed by Pivota.',
        hero_media: expect.objectContaining({
          url: 'https://example.com/gbr.jpg',
        }),
        source_refs: ['external_seed:gbr_45ml', 'merch_internal:gbr_internal_45ml'],
      }),
    );
  });

  test('buildCatalogServingSearchBody emits public exact-item search filters and search_after', () => {
    const cursor = encodeCatalogServingCursor([42.5, '2026-04-12T00:00:00Z', 'sig_123']);
    const body = buildCatalogServingSearchBody({
      query_text: 'barrier serum',
      brand_names: ['KraveBeauty'],
      categories: ['Serum'],
      market: 'US',
      limit: 36,
      cursor,
      sort: 'popular',
    });

    expect(body).toEqual(
      expect.objectContaining({
        size: 36,
        track_total_hits: false,
        search_after: [42.5, '2026-04-12T00:00:00Z', 'sig_123'],
        sort: [
          { browse_score: 'desc' },
          { updated_at: 'desc' },
          { sellable_item_group_id: 'asc' },
        ],
      }),
    );
    expect(body.query.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { publish_state: 'public' } },
        { term: { market: 'US' } },
        { terms: { brand_name: ['KraveBeauty'] } },
        { terms: { category_paths: ['Serum'] } },
      ]),
    );
    expect(body.query.bool.must).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          multi_match: expect.objectContaining({
            query: 'barrier serum',
          }),
        }),
      ]),
    );
  });

  test('searchCatalogServingIndex queries the OpenSearch-compatible endpoint and returns cursor_info', async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: {
          hits: {
            hits: [
              {
                _source: {
                  sellable_item_group_id: 'sig_1',
                  title: 'Doc 1',
                },
                sort: [12.4, '2026-04-12T00:00:00Z', 'sig_1'],
              },
            ],
          },
        },
      })),
    };

    const result = await searchCatalogServingIndex(
      {
        query_text: 'doc',
        limit: 1,
      },
      {
        httpClient,
        env: {
          CATALOG_SERVING_INDEX_BASE_URL: 'https://search.example',
          CATALOG_SERVING_INDEX_NAME: 'catalog_public_v1',
          CATALOG_SERVING_INDEX_API_KEY: 'secret',
        },
      },
    );

    expect(httpClient.post).toHaveBeenCalledWith(
      'https://search.example/catalog_public_v1/_search',
      expect.objectContaining({ size: 1 }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'ApiKey secret',
        }),
      }),
    );
    expect(result.items).toEqual([{ sellable_item_group_id: 'sig_1', title: 'Doc 1' }]);
    expect(result.cursor_info).toEqual(
      expect.objectContaining({
        has_next_page: true,
        next_cursor: expect.any(String),
        serving_mode: 'exhaustive',
      }),
    );
    expect(decodeCatalogServingCursor(result.cursor_info.next_cursor)).toEqual([
      12.4,
      '2026-04-12T00:00:00Z',
      'sig_1',
    ]);
  });

  test('bulkUpsertCatalogServingDocs emits ndjson bulk payloads', async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: { errors: false },
      })),
    };

    const result = await bulkUpsertCatalogServingDocs(
      [
        { doc_id: 'sellable:sig_1', title: 'Doc 1' },
        { doc_id: 'sellable:sig_2', title: 'Doc 2' },
      ],
      {
        httpClient,
        env: {
          CATALOG_SERVING_INDEX_BASE_URL: 'https://search.example',
          CATALOG_SERVING_INDEX_NAME: 'catalog_public_v1',
        },
        refresh: true,
      },
    );

    expect(result.indexed).toBe(2);
    expect(httpClient.post).toHaveBeenCalledWith(
      'https://search.example/_bulk?refresh=true',
      expect.stringContaining('sellable:sig_1'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/x-ndjson',
        }),
      }),
    );
  });

  test('buildCatalogServingBackfillDocs emits a public exact-item doc from live identity members only', () => {
    const sourceRows = [
      {
        merchant_id: 'external_seed',
        product_id: 'seed_gbr_45ml',
        source_kind: 'external_seed',
        product: {
          product_id: 'seed_gbr_45ml',
          title: 'Great Barrier Relief',
          brand: 'KraveBeauty',
          description: 'Barrier serum from brand source',
          canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
          image_url: 'https://images.example/gbr-brand.jpg',
          price: 28,
          destination_url: 'https://kravebeauty.com/products/great-barrier-relief',
          card_intro: 'Reviewed by Pivota.',
        },
        source_meta: {
          market: 'US',
          updated_at: '2026-04-12T02:00:00Z',
        },
      },
      {
        merchant_id: 'merch_internal',
        product_id: 'internal_gbr_45ml',
        source_kind: 'internal',
        product: {
          product_id: 'internal_gbr_45ml',
          title: 'Great Barrier Relief 45ml',
          brand: 'KraveBeauty',
          canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
          image_url: 'https://images.example/gbr-internal.jpg',
          default_offer_id: 'offer_internal',
          offers: [
            {
              offer_id: 'offer_internal',
              merchant_id: 'merch_internal',
              price: { amount: 30 },
            },
          ],
        },
        source_meta: {
          updated_at: '2026-04-12T03:00:00Z',
        },
      },
      {
        merchant_id: 'merch_shadow',
        product_id: 'shadow_gbr_45ml',
        source_kind: 'internal',
        product: {
          product_id: 'shadow_gbr_45ml',
          title: 'Shadow GBR listing',
          brand: 'KraveBeauty',
          canonical_url: 'https://kravebeauty.com/products/great-barrier-relief',
          description: 'Should not leak into public exact-item serving',
          offers: [
            {
              offer_id: 'offer_shadow',
              merchant_id: 'merch_shadow',
              price: { amount: 31 },
            },
          ],
        },
      },
    ];
    const identityRows = [
      {
        source_listing_ref: 'external_seed:seed_gbr_45ml',
        sellable_item_group_id: 'sig_gbr_45ml',
        product_line_id: 'pl_gbr',
        review_family_id: 'rf_gbr',
        source_tier: 'brand',
        identity_status: 'approved',
        live_read_enabled: true,
        variant_axes: { volume: '45ml' },
      },
      {
        source_listing_ref: 'merch_internal:internal_gbr_45ml',
        sellable_item_group_id: 'sig_gbr_45ml',
        product_line_id: 'pl_gbr',
        review_family_id: 'rf_gbr',
        source_tier: 'merchant',
        identity_status: 'approved',
        live_read_enabled: true,
        variant_axes: { volume: '45ml' },
      },
    ];

    const docs = buildCatalogServingBackfillDocs(sourceRows, {
      identityRows,
      includeNonPublic: true,
      market: 'US',
    });

    expect(docs).toHaveLength(2);
    const publicDoc = docs.find((doc) => doc.publish_state === 'public');
    expect(publicDoc).toEqual(
      expect.objectContaining({
        doc_id: 'sellable:sig_gbr_45ml',
        publish_state: 'public',
        title: 'Great Barrier Relief',
        brand_name: 'KraveBeauty',
        default_offer_id: 'offer_internal',
        internal_offer_exists: true,
        external_offer_exists: true,
        source_refs: ['external_seed:seed_gbr_45ml', 'merch_internal:internal_gbr_45ml'],
      }),
    );
    expect(publicDoc.source_refs).not.toContain('merch_shadow:shadow_gbr_45ml');
    expect(publicDoc.price_min).toBe(28);
    expect(publicDoc.price_max).toBe(30);
    expect(docs.find((doc) => doc.source_refs.includes('merch_shadow:shadow_gbr_45ml'))).toEqual(
      expect.objectContaining({
        publish_state: 'eligible',
      }),
    );
  });

  test('backfillCatalogServingIndex reports publish-state breakdown during dry run', async () => {
    const result = await backfillCatalogServingIndex(
      {
        limit: 10,
        dryRun: true,
        includeNonPublic: true,
        market: 'US',
      },
      {
        fetchBackfillProductsFn: jest.fn(async () => [
          {
            merchant_id: 'external_seed',
            product_id: 'eligible_serum',
            source_kind: 'external_seed',
            product: {
              product_id: 'eligible_serum',
              title: 'Barrier Serum',
              brand: 'KraveBeauty',
              canonical_url: 'https://kravebeauty.com/products/barrier-serum',
              image_url: 'https://images.example/eligible.jpg',
            },
            source_meta: { market: 'US' },
          },
          {
            merchant_id: 'merch_multi',
            product_id: 'review_required_serum',
            source_kind: 'internal',
            product: {
              product_id: 'review_required_serum',
              title: 'Mystery Multi Variant Serum',
              brand: 'KraveBeauty',
              variants: [{ sku: 'a' }, { sku: 'b' }],
            },
            source_meta: { market: 'US' },
          },
        ]),
        identityRowsResolverFn: jest.fn(async () => []),
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        dry_run: true,
        source_rows_scanned: 2,
        live_identity_rows: 0,
        docs_built: 2,
        public_docs_built: 0,
        non_public_docs_built: 2,
        publish_state_breakdown: {
          eligible: 1,
          shadow: 1,
        },
        indexed: 0,
        source: 'dry_run',
      }),
    );
  });

  test('index config reports disabled state when base url is missing', () => {
    expect(getCatalogServingIndexConfig({}).enabled).toBe(false);
    expect(isCatalogServingIndexEnabled({})).toBe(false);
  });
});
