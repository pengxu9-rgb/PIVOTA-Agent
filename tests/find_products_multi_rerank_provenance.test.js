function restoreEnv(previousEnv) {
  Object.entries(previousEnv).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
}

function configureRerankEnv() {
  process.env.OPENAI_API_KEY = 'sk-rerank-provenance';
  process.env.FIND_PRODUCTS_MULTI_LLM_ENABLED = 'true';
  process.env.PIVOTA_RERANK_LLM_PROVIDER = 'openai';
  delete process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER;
  delete process.env.FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER;
  delete process.env.AURORA_RECO_GEMINI_API_KEY;
  delete process.env.PIVOTA_GEMINI_API_KEY;
  delete process.env.AURORA_SKIN_GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
}

function loadRerankModule(llmJson) {
  const create = jest.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify(llmJson),
        },
      },
    ],
  });
  const logger = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  jest.doMock('../src/logger', () => logger);
  jest.doMock('openai', () =>
    jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create,
        },
      },
    })),
  );

  return {
    ...require('../src/findProductsMulti/rerankLlm'),
    create,
    logger,
  };
}

function makeResponse() {
  return {
    products: [
      {
        merchant_id: 'merchant_internal',
        product_id: 'internal_lipstick',
        title: 'Internal Satin Lipstick',
        brand: { name: 'Glow' },
        category: 'Lipstick',
      },
      {
        merchant_id: 'external_seed',
        source: 'external_seed',
        product_id: 'external_lipstick',
        title: 'Glow Satin Lipstick',
        brand: { name: 'Glow' },
        category: 'Lipstick',
      },
    ],
  };
}

describe('find_products_multi llm rerank provenance', () => {
  let previousEnv;

  beforeEach(() => {
    previousEnv = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      FIND_PRODUCTS_MULTI_LLM_ENABLED: process.env.FIND_PRODUCTS_MULTI_LLM_ENABLED,
      PIVOTA_RERANK_LLM_PROVIDER: process.env.PIVOTA_RERANK_LLM_PROVIDER,
      PIVOTA_RERANK_LLM_FALLBACK_PROVIDER: process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER,
      FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER: process.env.FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER,
      AURORA_RECO_GEMINI_API_KEY: process.env.AURORA_RECO_GEMINI_API_KEY,
      PIVOTA_GEMINI_API_KEY: process.env.PIVOTA_GEMINI_API_KEY,
      AURORA_SKIN_GEMINI_API_KEY: process.env.AURORA_SKIN_GEMINI_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    };
    jest.resetModules();
    configureRerankEnv();
  });

  afterEach(() => {
    restoreEnv(previousEnv);
    jest.dontMock('../src/logger');
    jest.dontMock('openai');
    jest.resetModules();
  });

  test('marks rerank output without rationale as unprovenanced and logs a warning', async () => {
    const { maybeRerankFindProductsMultiResponse, logger } = loadRerankModule({
      items: [
        { product_id: 'external_lipstick', source: 'external', reason: 'brand match' },
        { product_id: 'internal_lipstick', source: 'internal', reason: 'similar item' },
      ],
    });

    const result = await maybeRerankFindProductsMultiResponse({
      response: makeResponse(),
      userQuery: 'glow lipstick',
      limit: 2,
    });

    expect(result.applied).toBe(true);
    expect(result.evidence_profile).toBe('llm_rerank_unprovenanced');
    expect(result.response.evidence_profile).toBe('llm_rerank_unprovenanced');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        items_count: 2,
        missing_count: 2,
        evidence_profile: 'llm_rerank_unprovenanced',
      }),
      'find_products_multi llm rerank missing provenance',
    );
  });

  test('marks rerank output with rationale as provenanced and surfaces rationale on products', async () => {
    const { maybeRerankFindProductsMultiResponse, logger } = loadRerankModule({
      items: [
        {
          product_id: 'external_lipstick',
          source: 'external',
          reason: 'brand match',
          rationale: 'Exact brand and category match',
        },
        {
          product_id: 'internal_lipstick',
          source: 'internal',
          reason: 'backup option',
          rationale: 'Similar product form',
        },
      ],
    });

    const result = await maybeRerankFindProductsMultiResponse({
      response: makeResponse(),
      userQuery: 'glow lipstick',
      limit: 2,
    });

    expect(result.applied).toBe(true);
    expect(result.evidence_profile).toBe('llm_rerank_with_rationale');
    expect(result.response.evidence_profile).toBe('llm_rerank_with_rationale');
    expect(result.response.products[0]).toEqual(
      expect.objectContaining({
        product_id: 'external_lipstick',
        rerank_rationale: 'Exact brand and category match',
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
