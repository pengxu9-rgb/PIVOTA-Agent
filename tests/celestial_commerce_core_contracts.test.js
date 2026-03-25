describe('Celestial commerce core source contracts', () => {
  let prevEnv;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {
      PIVOTA_API_BASE: process.env.PIVOTA_API_BASE,
      PIVOTA_API_KEY: process.env.PIVOTA_API_KEY,
      API_MODE: process.env.API_MODE,
      DATABASE_URL: process.env.DATABASE_URL,
      AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED: process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED,
    };
    process.env.PIVOTA_API_BASE = 'http://pivota.test';
    process.env.PIVOTA_API_KEY = 'test_key';
    process.env.API_MODE = 'REAL';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.AURORA_BFF_PDP_HOTSET_PREWARM_ENABLED = 'false';
  });

  afterEach(() => {
    jest.resetModules();
    if (!prevEnv) return;
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('public search strips external seed strategy overrides while shopping_agent keeps them', () => {
    const app = require('../src/server');
    const { applyFindProductsMultiSourceContract } = app._debug;

    const payload = {
      search: {
        query: 'serum',
        external_seed_strategy: 'unified_relevance',
      },
    };

    const publicOut = applyFindProductsMultiSourceContract(payload, { source: 'search' }, 'find_products_multi');
    expect(publicOut.search.query).toBe('serum');
    expect(publicOut.search.external_seed_strategy).toBeUndefined();

    const shoppingOut = applyFindProductsMultiSourceContract(payload, { source: 'shopping_agent' }, 'find_products_multi');
    expect(shoppingOut.search.external_seed_strategy).toBe('unified_relevance');
  });

  test('public search query guards strip override params from incoming query params', () => {
    const app = require('../src/server');
    const { applyShoppingCatalogQueryGuards } = app._debug;

    const guarded = applyShoppingCatalogQueryGuards(
      {
        query: 'serum',
        external_seed_strategy: 'supplement_internal_first',
        page: '1',
      },
      'search',
    );

    expect(guarded.query).toBe('serum');
    expect(guarded.page).toBe('1');
    expect(guarded.external_seed_strategy).toBeUndefined();
  });

  test('shopping agent loop-break builds a scenario-aware retry query from short user selection', () => {
    const app = require('../src/server');
    const { uiChatBuildLoopBreakRetryArgs } = app._debug;

    const args = {
      operation: 'find_products_multi',
      payload: {
        search: {
          query: 'serum',
        },
      },
    };

    const messages = [
      { role: 'user', content: '帮我买一款 serum' },
      { role: 'assistant', content: '你更偏哪种场景？' },
      { role: 'user', content: '约会' },
    ];

    const toolResult = {
      clarification: {
        reason_code: 'scenario_missing',
        question: 'Which scenario do you want to prioritize?',
      },
      metadata: {
        search_trace: {
          final_decision: 'clarify',
        },
      },
    };

    const out = uiChatBuildLoopBreakRetryArgs(args, messages, toolResult);
    expect(out).toBeTruthy();
    expect(out.scenario).toBe('date');
    expect(out.baseQuery).toBe('帮我买一款 serum');
    expect(out.nextQuery).toContain('使用场景：约会');
    expect(out.nextArgs.payload.search.query).toContain('使用场景：约会');
    expect(out.nextArgs.metadata.ui_chat_loop_break).toBe('scenario_selection_retry');
  });
});
