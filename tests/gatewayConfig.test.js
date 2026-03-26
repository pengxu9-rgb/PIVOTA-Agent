const { createGatewayConfig, parsePdpCorePrewarmTargets } = require('../src/gatewayConfig');

describe('gatewayConfig', () => {
  test('defaults API_MODE to REAL when api key is configured', () => {
    const config = createGatewayConfig({
      env: {
        PIVOTA_API_KEY: 'secret',
      },
      logger: { info: jest.fn(), warn: jest.fn() },
      axiosClient: { defaults: {} },
      now: () => new Date('2026-03-23T00:00:00.000Z'),
    });

    expect(config.API_MODE).toBe('REAL');
    expect(config.USE_MOCK).toBe(false);
    expect(config.USE_HYBRID).toBe(false);
    expect(config.REAL_API_ENABLED).toBe(true);
  });

  test('clamps unsafe find_products_multi timeout and logs warning', () => {
    const logger = { info: jest.fn(), warn: jest.fn() };

    const config = createGatewayConfig({
      env: {
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS: '1000',
      },
      logger,
      axiosClient: { defaults: {} },
    });

    expect(config.UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS).toBe(6500);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('configures axios keep-alive defaults from env', () => {
    const axiosClient = { defaults: {} };
    const logger = { info: jest.fn(), warn: jest.fn() };

    createGatewayConfig({
      env: {
        AGENT_AXIOS_KEEPALIVE_ENABLED: 'true',
        AGENT_AXIOS_KEEPALIVE_MSECS: '120000',
        AGENT_AXIOS_KEEPALIVE_MAX_SOCKETS: '64',
        AGENT_AXIOS_KEEPALIVE_MAX_FREE_SOCKETS: '16',
        AGENT_AXIOS_KEEPALIVE_SCHEDULING: 'fifo',
      },
      logger,
      axiosClient,
    });

    expect(axiosClient.defaults.httpAgent).toBeTruthy();
    expect(axiosClient.defaults.httpAgent.options.keepAlive).toBe(true);
    expect(axiosClient.defaults.httpAgent.options.keepAliveMsecs).toBe(120000);
    expect(axiosClient.defaults.httpAgent.options.maxSockets).toBe(64);
    expect(axiosClient.defaults.httpAgent.options.maxFreeSockets).toBe(16);
    expect(axiosClient.defaults.httpAgent.options.scheduling).toBe('fifo');
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test('parsePdpCorePrewarmTargets dedupes and preserves merchant override', () => {
    expect(
      parsePdpCorePrewarmTargets(
        'prod_a,merch_2:prod_b,prod_a, merch_2:prod_b ,merch_3:prod_c',
        'merch_default',
      ),
    ).toEqual([
      { merchant_id: 'merch_default', product_id: 'prod_a' },
      { merchant_id: 'merch_2', product_id: 'prod_b' },
      { merchant_id: 'merch_3', product_id: 'prod_c' },
    ]);
  });

  test('getUpstreamTimeoutMs respects per-operation overrides', () => {
    const config = createGatewayConfig({
      env: {
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_MS: '2200',
        UPSTREAM_TIMEOUT_FIND_PRODUCTS_MULTI_MS: '7200',
        UPSTREAM_TIMEOUT_SLOW_MS: '51000',
        UPSTREAM_TIMEOUT_SEARCH_MS: '9000',
      },
      logger: { info: jest.fn(), warn: jest.fn() },
      axiosClient: { defaults: {} },
    });

    expect(config.getUpstreamTimeoutMs('find_products')).toBe(2200);
    expect(config.getUpstreamTimeoutMs('find_products_multi')).toBe(7200);
    expect(config.getUpstreamTimeoutMs('preview_quote')).toBe(51000);
    expect(config.getUpstreamTimeoutMs('track_product_click')).toBe(9000);
  });
});
