const {
  CATALOG_SERVING_GATEWAY_CONTRACT_VERSION,
  normalizeCatalogServingGatewayRequest,
  resolveCatalogServingGatewayServingMode,
  resolveCatalogServingGatewayShadowMode,
  searchCatalogServingGateway,
} = require('../src/services/catalogServingGateway');

describe('catalog serving gateway', () => {
  test('normalizeCatalogServingGatewayRequest clamps inputs and defaults to auto serving mode', () => {
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
        serving_mode: 'auto',
        shadow_mode: 'external_only',
      }),
    );
  });

  test('resolveCatalogServingGatewayServingMode supports db serving and legacy local shadow aliases', () => {
    expect(resolveCatalogServingGatewayServingMode('db_serving')).toBe('db_serving');
    expect(resolveCatalogServingGatewayServingMode('allow_local_shadow')).toBe('db_serving');
    expect(resolveCatalogServingGatewayServingMode('serving_eligible_only')).toBe('serving_eligible_only');
    expect(resolveCatalogServingGatewayServingMode('external_only')).toBe('external_only');
    expect(resolveCatalogServingGatewayServingMode('unexpected')).toBe('auto');
  });

  test('resolveCatalogServingGatewayShadowMode keeps legacy request aliases stable', () => {
    expect(resolveCatalogServingGatewayShadowMode('allow_local_shadow')).toBe('allow_local_shadow');
    expect(resolveCatalogServingGatewayShadowMode('db_serving')).toBe('allow_local_shadow');
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
        gateway_mode: 'disabled',
        serving_mode: 'external_only',
        requested_serving_mode: 'auto',
        shadow_mode: 'external_only',
        source: 'disabled',
        debug_metadata: expect.objectContaining({
          external_index_enabled: false,
          db_serving_requested: false,
          db_serving_available: false,
          db_serving_used: false,
          local_shadow_requested: false,
          local_shadow_available: false,
          local_shadow_used: false,
        }),
      }),
    );
  });

  test('searchCatalogServingGateway can explicitly use DB serving', async () => {
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
        serving_mode: 'db_serving',
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
        gateway_mode: 'db_serving',
        serving_mode: 'db_serving',
        requested_serving_mode: 'db_serving',
        shadow_mode: 'allow_local_shadow',
        source: 'db_serving',
        items: [{ doc_id: 'sellable:sig_1', title: 'Barrier Serum' }],
        cursor_info: expect.objectContaining({
          next_cursor: 'cursor_1',
          has_next_page: true,
        }),
        debug_metadata: expect.objectContaining({
          db_serving_requested: true,
          db_serving_available: true,
          db_serving_used: true,
          local_shadow_requested: true,
          local_shadow_available: true,
          local_shadow_used: true,
        }),
      }),
    );
  });

  test('searchCatalogServingGateway auto-promotes to DB serving when external index is not configured', async () => {
    const searchCatalogServingIndexFn = jest.fn(async () => ({
      items: [{ doc_id: 'sellable:sig_2', title: 'Barrier Cream' }],
      cursor_info: {
        next_cursor: null,
        has_next_page: false,
        serving_mode: 'exhaustive',
      },
      source: 'local_shadow',
    }));

    const result = await searchCatalogServingGateway(
      {
        query_text: 'barrier cream',
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
        query_text: 'barrier cream',
      }),
      expect.objectContaining({
        allowLocalShadow: true,
        servingEligibleOnly: false,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        gateway_mode: 'db_serving',
        serving_mode: 'db_serving',
        requested_serving_mode: 'auto',
        shadow_mode: 'allow_local_shadow',
        source: 'db_serving',
      }),
    );
  });
});
