describe('find_products_multi rerank LLM timeout bounds', () => {
  const ENV_KEYS = [
    'FIND_PRODUCTS_MULTI_LLM_ENABLED',
    'PIVOTA_RERANK_LLM_PROVIDER',
    'PIVOTA_RERANK_LLM_FALLBACK_PROVIDER',
    'PIVOTA_RERANK_LLM_TIMEOUT_MS',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'LLM_API_KEY',
  ];
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {};
    for (const key of ENV_KEYS) prevEnv[key] = process.env[key];
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    process.env.FIND_PRODUCTS_MULTI_LLM_ENABLED = 'true';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
  });

  afterEach(() => {
    jest.dontMock('axios');
    jest.resetModules();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  const buildRerankableResponse = () => ({
    products: [
      { product_id: 'int-1', title: 'Internal Lipstick', merchant_id: 'm1' },
      { product_id: 'ext-1', title: 'External Lipstick', merchant_id: 'external_seed' },
    ],
  });

  const geminiAxiosMock = (capture) => ({
    post: jest.fn(async (url, body, config) => {
      capture.timeout = config?.timeout;
      return {
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      items: [
                        { product_id: 'ext-1', source: 'external', rationale: 'exact match' },
                        { product_id: 'int-1', source: 'internal', rationale: 'close match' },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        },
      };
    }),
  });

  test('gemini call carries the configured bounded timeout', async () => {
    process.env.PIVOTA_RERANK_LLM_TIMEOUT_MS = '1800';
    const capture = {};
    jest.doMock('axios', () => geminiAxiosMock(capture));
    const { maybeRerankFindProductsMultiResponse } = require('../src/findProductsMulti/rerankLlm');

    const result = await maybeRerankFindProductsMultiResponse({
      response: buildRerankableResponse(),
      userQuery: 'lipstick',
      limit: 2,
    });

    expect(result.applied).toBe(true);
    expect(capture.timeout).toBe(1800);
  });

  test('timeout defaults to 2500ms and is clamped to at most 15000ms', async () => {
    const captureDefault = {};
    jest.doMock('axios', () => geminiAxiosMock(captureDefault));
    let mod = require('../src/findProductsMulti/rerankLlm');
    await mod.maybeRerankFindProductsMultiResponse({
      response: buildRerankableResponse(),
      userQuery: 'lipstick',
      limit: 2,
    });
    expect(captureDefault.timeout).toBe(2500);

    jest.resetModules();
    process.env.PIVOTA_RERANK_LLM_TIMEOUT_MS = '600000';
    const captureClamped = {};
    jest.doMock('axios', () => geminiAxiosMock(captureClamped));
    mod = require('../src/findProductsMulti/rerankLlm');
    await mod.maybeRerankFindProductsMultiResponse({
      response: buildRerankableResponse(),
      userQuery: 'lipstick',
      limit: 2,
    });
    // env asks for 600s; the per-provider deadline is clamped and the gemini
    // axios timeout additionally never exceeds its legacy 12s bound
    expect(captureClamped.timeout).toBeLessThanOrEqual(12000);
  });
});
