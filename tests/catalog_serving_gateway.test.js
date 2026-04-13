const {
  CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
  normalizeCatalogServingGatewayRequest,
  resolveCatalogServingGatewayShadowMode,
  searchCatalogServingGateway,
} = require('../src/services/catalogServingGateway');

describe('catalog serving gateway', () => {
  test('normalizeCatalogServingGatewayRequest clamps inputs and defaults to external-only shadow mode', () => {
    expect(
      normalizeCatalogServingGatewayRequest({
        query_text: '  barrier serum  ',
        brand_names: ['KraveBeauty', 'kravebeauty', 'Byoma'],
        categories: ['Serum', 'serum'],
        market: 'us',
        limit: 400,
        sort: 'price_asc',
        shadow_mode: 'unexpected',
      }),
    ).toEqual(
      expect.objectContaining({
        query_text: 'barrier serum',
        brand_names: ['KraveBeauty', 'Byoma'],
        categories: ['Serum'],
        market: 'US',
        limit: 100,
        sort: 'price_asc',
        shadow_mode: 'external_only',
      }),
    );
  });

  test('resolveCatalogServingGatewayShadowMode only allows explicit local shadow', () => {
    expect(resolveCatalogServingGatewayShadowMode('allow_local_shadow')).toBe('allow_local_shadow');
    expect(resolveCatalogServingGatewayShadowMode('external_only')).toBe('external_only');
    expect(resolveCatalogServingGatewayShadowMode('local')).toBe('external_only');
  });

  test('searchCatalogServingGateway keeps local shadow disabled by default', async () => {
    const searchCatalogServingIndexFn = jest.fn(async () => ({
      items: [],
      cursor_info: {
        next_cursor: null,
        has_next_page: false,
        serving_mode: 'exhaustive',
      },
      source: 'disabled',
    }));

    const result = await searchCatalogServingGateway(
      {
        query_text: 'barrier serum',
      },
      {
        env: {},
        searchCatalogServingIndexFn,
      },
    );

    expect(searchCatalogServingIndexFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query_text: 'barrier serum',
        market: 'US',
      }),
      expect.objectContaining({
        allowLocalShadow: false,
        env: {},
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        contract_version: CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
        gateway_mode: 'shadow',
        shadow_mode: 'external_only',
        source: 'disabled',
        debug_metadata: expect.objectContaining({
          external_index_enabled: false,
          local_shadow_requested: false,
          local_shadow_available: false,
          local_shadow_used: false,
        }),
      }),
    );
  });

  test('searchCatalogServingGateway can explicitly use local shadow for shadow-only contract checks', async () => {
    const searchCatalogServingIndexFn = jest.fn(async () => ({
      items: [{ doc_id: 'sellable:sig_1', title: 'Barrier Serum' }],
      cursor_info: {
        next_cursor: 'cursor_1',
        has_next_page: true,
        serving_mode: 'exhaustive',
      },
      source: 'local_shadow',
    }));

    const result = await searchCatalogServingGateway(
      {
        query_text: 'barrier serum',
        brand_names: ['KraveBeauty'],
        shadow_mode: 'allow_local_shadow',
      },
      {
        env: {
          DATABASE_URL: 'postgres://catalog-shadow.test/pivota',
        },
        searchCatalogServingIndexFn,
      },
    );

    expect(searchCatalogServingIndexFn).toHaveBeenCalledWith(
      expect.objectContaining({
        query_text: 'barrier serum',
        brand_names: ['KraveBeauty'],
      }),
      expect.objectContaining({
        allowLocalShadow: true,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        contract_version: CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
        shadow_mode: 'allow_local_shadow',
        source: 'local_shadow',
        items: [{ doc_id: 'sellable:sig_1', title: 'Barrier Serum' }],
        cursor_info: expect.objectContaining({
          next_cursor: 'cursor_1',
          has_next_page: true,
        }),
        debug_metadata: expect.objectContaining({
          local_shadow_requested: true,
          local_shadow_available: true,
          local_shadow_used: true,
        }),
      }),
    );
  });
});
