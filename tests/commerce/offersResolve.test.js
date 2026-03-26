const {
  createOffersResolveOwner,
  normalizeOffersResolveReasonCode,
  buildOffersResolvePdpTargetExternal,
  buildOffersResolveResponse,
} = require('../../src/commerce/offers/resolveOffers');

describe('offers resolve owner', () => {
  test('normalizes failure reason codes consistently', () => {
    expect(normalizeOffersResolveReasonCode('db_error')).toBe('db_timeout');
    expect(normalizeOffersResolveReasonCode('timeout')).toBe('upstream_timeout');
    expect(normalizeOffersResolveReasonCode('stable_alias')).toBe('stable_alias_ref');
    expect(normalizeOffersResolveReasonCode('something_else', 'no_candidates')).toBe(
      'no_candidates',
    );
  });

  test('short-circuits canonical_product_ref without upstream calls', async () => {
    const owner = createOffersResolveOwner({
      axiosClient: { post: jest.fn() },
      pivotaApiBase: 'http://pivota.test',
      buildInvokeUpstreamAuthHeaders: jest.fn(() => ({})),
    });

    const result = await owner.handleOffersResolveOperation({
      payload: {
        product: {
          canonical_product_ref: {
            merchant_id: 'merchant_1',
            product_id: 'prod_1',
          },
          product_id: 'ignored_uuid',
        },
      },
      metadata: { source: 'shopping_agent' },
      checkoutToken: null,
    });

    expect(result.statusCode).toBe(200);
    expect(result.response.reason_code).toBe('canonical_ref_direct');
    expect(result.response.pdp_target?.v1?.product_ref).toEqual({
      merchant_id: 'merchant_1',
      product_id: 'prod_1',
    });
  });

  test('subject no_candidates with weak uuid skips cache search when configured', async () => {
    const axiosClient = {
      post: jest.fn().mockResolvedValue({
        status: 404,
        data: {
          reason_code: 'no_candidates',
          reason: 'no_candidates',
        },
      }),
    };
    const owner = createOffersResolveOwner({
      axiosClient,
      pivotaApiBase: 'http://pivota.test',
      buildInvokeUpstreamAuthHeaders: jest.fn(() => ({})),
      config: {
        skipCacheSearchOnSubjectTimeout: true,
        skipCacheSearchOnSubjectNoCandidates: true,
      },
    });

    const result = await owner.handleOffersResolveOperation({
      payload: {
        offers: {
          product: {
            product_id: '11111111-2222-4333-8444-555555555555',
            name: 'Unknown UUID Product',
          },
        },
      },
      metadata: { source: 'shopping_agent' },
      checkoutToken: null,
    });

    expect(axiosClient.post).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBe(200);
    expect(result.response.reason_code).toBe('no_candidates');
    expect(result.response.pdp_target?.v1 || null).toBeNull();
  });

  test('builds fail-closed external target and response envelope', () => {
    const target = buildOffersResolvePdpTargetExternal('ipsa toner', 'external_fallback');
    const response = buildOffersResolveResponse({
      upstreamBody: { status: 'success', offers: [] },
      reasonCode: 'fallback_external',
      pdpTargetV1: target,
      sourceTrace: [{ source: 'cache_search', ok: false, attempts: 1, latency_ms: 0 }],
      queryText: 'ipsa toner',
      startedAtMs: Date.now() - 5,
      failReasonCode: 'fallback_external',
    });

    expect(target.path).toBe('external');
    expect(response.reason_code).toBe('fallback_external');
    expect(response.metadata?.pdp_open_path).toBe('external');
  });
});
