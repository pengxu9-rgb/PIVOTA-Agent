const {
  detectAuroraExternalSeedMonoculture,
  withStageBudget,
  shouldFallbackProxySearch,
  getFallbackAdoptUsableThreshold,
  shouldBypassSecondaryFallbackSkipOnPrimaryException,
} = require('../../src/commerce/catalog/searchFallbackRuntime');

describe('searchFallbackRuntime', () => {
  test('detectAuroraExternalSeedMonoculture detects dominant external seed brand for aurora', () => {
    const result = detectAuroraExternalSeedMonoculture({
      normalized: {
        products: [
          { merchant_id: 'external_seed', brand: 'IPSA' },
          { merchant_id: 'external_seed', brand: 'IPSA' },
          { merchant_id: 'external_seed', brand: 'IPSA' },
          { merchant_id: 'external_seed', brand: 'IPSA' },
          { merchant_id: 'm_internal', brand: 'Other' },
        ],
      },
      queryText: 'ipsa serum',
      source: 'aurora-bff',
    });

    expect(result).toMatchObject({
      detected: true,
      dominantBrand: 'ipsa',
      externalCount: 4,
      totalCount: 5,
    });
  });

  test('withStageBudget rejects when stage exceeds budget', async () => {
    await expect(
      withStageBudget(
        new Promise((resolve) => setTimeout(() => resolve('late'), 25)),
        5,
        'cache_stage',
      ),
    ).rejects.toMatchObject({
      code: 'STAGE_TIMEOUT',
      stage: 'cache_stage',
    });
  });

  test('shouldFallbackProxySearch detects unusable primary payloads', () => {
    expect(
      shouldFallbackProxySearch(
        {
          products: [{ merchant_id: 'm1' }],
          total: 1,
        },
        200,
      ),
    ).toBe(true);

    expect(
      shouldFallbackProxySearch(
        {
          products: [{ merchant_id: 'm1', product_id: 'p1' }],
          total: 1,
        },
        200,
      ),
    ).toBe(false);
  });

  test('getFallbackAdoptUsableThreshold relaxes aurora primary-irrelevant adopt threshold', () => {
    expect(
      getFallbackAdoptUsableThreshold(
        {
          operation: 'find_products_multi',
          source: 'aurora-bff',
          primaryUsableCount: 4,
          primaryIrrelevant: true,
        },
        {
          proxySearchAuroraRelaxPrimaryIrrelevantAdopt: true,
        },
      ),
    ).toBe(1);

    expect(
      getFallbackAdoptUsableThreshold(
        {
          operation: 'find_products_multi',
          source: 'shopping_agent',
          primaryUsableCount: 4,
          primaryIrrelevant: true,
        },
        {
          proxySearchAuroraRelaxPrimaryIrrelevantAdopt: true,
        },
      ),
    ).toBe(4);
  });

  test('shouldBypassSecondaryFallbackSkipOnPrimaryException only for retryable upstream failures', () => {
    expect(
      shouldBypassSecondaryFallbackSkipOnPrimaryException({
        err: { response: { status: 503 } },
      }),
    ).toBe(true);
    expect(
      shouldBypassSecondaryFallbackSkipOnPrimaryException({
        err: { code: 'ECONNRESET' },
      }),
    ).toBe(true);
    expect(
      shouldBypassSecondaryFallbackSkipOnPrimaryException({
        err: { response: { status: 400 }, message: 'bad request' },
      }),
    ).toBe(false);
  });
});
