const {
  configurePdpUpstreamAdapters,
  fetchReviewSummaryCached,
  fetchSimilarProductsDeduped,
  __internal,
} = require('../../src/commerce/pdp/upstreamAdapters');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pdp upstream adapters', () => {
  beforeEach(() => {
    __internal.resetPdpUpstreamAdapterCaches();
    configurePdpUpstreamAdapters({
      axios: jest.fn(),
      buildQueryString: jest.fn((params) => {
        const query = new URLSearchParams(params);
        const serialized = query.toString();
        return serialized ? `?${serialized}` : '';
      }),
      buildInvokeUpstreamAuthHeaders: jest.fn(() => ({})),
      callUpstreamWithOptionalRetry: jest.fn(async () => ({
        data: {
          review_summary: { rating_average: 4.8 },
        },
      })),
      getUpstreamTimeoutMs: jest.fn(() => 1500),
      pivotaApiBase: 'http://localhost:8080',
      reviewsApiBase: 'http://localhost:8081',
      upstreamTimeoutReviewsMs: 2500,
      recommendPdpProducts: jest.fn(async () => ({
        items: [{ merchant_id: 'm2', product_id: 'p2' }],
      })),
    });
  });

  test('caches review summary results by merchant/platform/product', async () => {
    const first = await fetchReviewSummaryCached({
      merchantId: 'm1',
      platform: 'shopify',
      platformProductId: 'gid://shopify/Product/1',
    });
    const second = await fetchReviewSummaryCached({
      merchantId: 'm1',
      platform: 'shopify',
      platformProductId: 'gid://shopify/Product/1',
    });

    expect(first).toEqual({ rating_average: 4.8 });
    expect(second).toEqual({ rating_average: 4.8 });
  });

  test('dedupes inflight similar-product recommendation requests', async () => {
    const deferred = createDeferred();
    const recommendPdpProducts = jest.fn(() => deferred.promise);
    configurePdpUpstreamAdapters({
      recommendPdpProducts,
    });

    const args = {
      pdp_product: {
        merchant_id: 'm1',
        product_id: 'p1',
        currency: 'USD',
      },
      k: 6,
      locale: 'en-US',
      currency: 'USD',
    };

    const firstPromise = fetchSimilarProductsDeduped(args);
    const secondPromise = fetchSimilarProductsDeduped(args);
    deferred.resolve({
      items: [{ merchant_id: 'm2', product_id: 'p2' }],
    });

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(recommendPdpProducts).toHaveBeenCalledTimes(1);
    expect(first).toEqual([{ merchant_id: 'm2', product_id: 'p2' }]);
    expect(second).toEqual([{ merchant_id: 'm2', product_id: 'p2' }]);
  });
});
