const { once } = require('events');

function hasRuntimeDeps() {
  for (const dep of ['dotenv', 'express', 'axios']) {
    try {
      require.resolve(dep);
    } catch {
      return false;
    }
  }
  return true;
}

const describeIfRuntimeDeps = hasRuntimeDeps() ? describe : describe.skip;

async function startServerWithRecommendationResult(recommendationResult) {
  jest.resetModules();
  process.env.API_MODE = 'MOCK';
  delete process.env.PIVOTA_API_KEY;
  const actualRecommendationEngine = jest.requireActual('../../src/services/RecommendationEngine');
  jest.doMock('../../src/services/RecommendationEngine', () => ({
    recommend: jest.fn(async () => recommendationResult),
    getCacheStats: jest.fn(() => ({
      enabled: true,
      ttl_ms: 600000,
      max_entries: 2000,
      size: 0,
      hits: 0,
      misses: 0,
      sets: 0,
      bypasses: 0,
      evictions: 0,
    })),
    _internals: actualRecommendationEngine._internals,
  }));
  const app = require('../../src/server');
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

async function stopServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  delete process.env.API_MODE;
  jest.resetModules();
  jest.dontMock('../../src/services/RecommendationEngine');
}

describeIfRuntimeDeps('/agent/shop/v1/invoke PDP similar contracts', () => {
  test('healthy empty similar remains ready instead of unavailable', async () => {
    const { server, baseUrl } = await startServerWithRecommendationResult({
      strategy: 'related_products',
      status: 'success',
      items: [],
      metadata: {
        similar_status: 'empty',
        similar_sources: {
          internal: { attempted: true, timed_out: false, returned: 0, skipped: false },
          external: { attempted: true, timed_out: false, returned: 0, skipped: false },
        },
        empty_reason: 'no_same_brand_candidates',
      },
    });

    try {
      const pdpResponse = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'get_pdp_v2',
          payload: {
            product: {
              merchant_id: 'merch_208139f7600dbf42',
              product_id: 'BOTTLE_001',
            },
            include: ['similar'],
          },
        }),
      });
      const pdpBody = await pdpResponse.json();
      const similarModule = Array.isArray(pdpBody.modules)
        ? pdpBody.modules.find((module) => module?.type === 'similar')
        : null;

      expect(pdpResponse.status).toBe(200);
      expect(similarModule).toBeTruthy();
      expect(similarModule.reason).toBeUndefined();
      expect(similarModule.data).toEqual(
        expect.objectContaining({
          status: 'empty',
          items: [],
        }),
      );
      expect(pdpBody.metadata.similar_status).toBe('empty');

      const similarResponse = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'find_similar_products',
          payload: {
            similar: {
              merchant_id: 'merch_208139f7600dbf42',
              product_id: 'BOTTLE_001',
              limit: 6,
            },
          },
        }),
      });
      const similarBody = await similarResponse.json();
      expect(similarResponse.status).toBe(200);
      expect(similarBody.products).toEqual([]);
      expect(similarBody.metadata).toEqual(
        expect.objectContaining({
          similar_status: 'empty',
          empty_reason: 'no_same_brand_candidates',
        }),
      );
    } finally {
      await stopServer(server);
    }
  });

  test('hard failure still surfaces as unavailable', async () => {
    const { server, baseUrl } = await startServerWithRecommendationResult({
      strategy: 'related_products',
      status: 'unavailable',
      items: [],
      metadata: {
        similar_status: 'unavailable',
        similar_sources: {
          internal: {
            attempted: true,
            timed_out: true,
            returned: 0,
            skipped: false,
            error_code: 'timeout',
          },
          external: {
            attempted: true,
            timed_out: true,
            returned: 0,
            skipped: false,
            error_code: 'timeout',
          },
        },
        empty_reason: 'all_sources_failed',
      },
    });

    try {
      const response = await fetch(`${baseUrl}/agent/shop/v1/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'get_pdp_v2',
          payload: {
            product: {
              merchant_id: 'merch_208139f7600dbf42',
              product_id: 'BOTTLE_001',
            },
            include: ['similar'],
          },
        }),
      });
      const body = await response.json();
      const similarModule = Array.isArray(body.modules)
        ? body.modules.find((module) => module?.type === 'similar')
        : null;

      expect(response.status).toBe(200);
      expect(similarModule).toBeTruthy();
      expect(similarModule.data).toBeNull();
      expect(similarModule.reason).toBe('unavailable');
      expect(body.metadata.similar_status).toBe('unavailable');
    } finally {
      await stopServer(server);
    }
  });
});
