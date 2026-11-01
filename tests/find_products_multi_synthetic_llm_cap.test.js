// G6 (src/guardrails/syntheticContext.js): a synthetic call runs the find_products_multi LLM passes only within its
// own cap, one in flight per instance. Past it the pass takes its deterministic fallback without dialling the
// provider; a real call is never capped.
describe('find_products_multi LLM passes under the synthetic cap', () => {
  const ENV_KEYS = [
    'FIND_PRODUCTS_MULTI_LLM_ENABLED',
    'PIVOTA_RERANK_LLM_PROVIDER',
    'PIVOTA_RERANK_LLM_FALLBACK_PROVIDER',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'LLM_API_KEY',
    'SYNTHETIC_LLM_MAX_CALLS_PER_HOUR',
  ];
  const SYNTHETIC = { synthetic: true, synthetic_caller: 'iss|mcpc_eval', gw_request_id: 'gw-1' };
  let prevEnv;
  let posts;

  beforeEach(() => {
    jest.resetModules();
    prevEnv = {};
    for (const key of ENV_KEYS) prevEnv[key] = process.env[key];
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.PIVOTA_RERANK_LLM_FALLBACK_PROVIDER;
    delete process.env.SYNTHETIC_LLM_MAX_CALLS_PER_HOUR;
    process.env.FIND_PRODUCTS_MULTI_LLM_ENABLED = 'true';
    process.env.PIVOTA_RERANK_LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    posts = 0;
    jest.doMock('axios', () => ({
      post: jest.fn(async () => {
        posts += 1;
        return {
          data: {
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    items: [
                      { product_id: 'ext-1', source: 'external', rationale: 'exact match' },
                      { product_id: 'int-1', source: 'internal', rationale: 'close match' },
                    ],
                  }),
                }],
              },
            }],
          },
        };
      }),
    }));
  });

  afterEach(() => {
    jest.dontMock('axios');
    jest.resetModules();
    for (const key of ENV_KEYS) {
      if (prevEnv[key] === undefined) delete process.env[key];
      else process.env[key] = prevEnv[key];
    }
  });

  const rerankable = () => ({
    products: [
      { product_id: 'int-1', title: 'Internal Lipstick', merchant_id: 'm1' },
      { product_id: 'ext-1', title: 'External Lipstick', merchant_id: 'external_seed' },
    ],
  });

  test('rerank: a synthetic call past the cap never dials the provider; within it, it runs and frees the slot', async () => {
    const ctx = require('../src/guardrails/syntheticContext');
    const { maybeRerankFindProductsMultiResponse } = require('../src/findProductsMulti/rerankLlm');
    const run = () => maybeRerankFindProductsMultiResponse({ response: rerankable(), userQuery: 'red lipstick', limit: 2 });

    const held = ctx.INVOKE_AUTH_CONTEXT.run(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot());
    await expect(ctx.INVOKE_AUTH_CONTEXT.run(SYNTHETIC, run)).rejects.toThrow(/synthetic_llm_cap/);
    expect(posts).toBe(0);

    // A real call is not capped, even while the synthetic slot is held.
    const real = await ctx.INVOKE_AUTH_CONTEXT.run({ synthetic: false }, run);
    expect(real.applied).toBe(true);
    expect(posts).toBe(1);

    held();
    const syn = await ctx.INVOKE_AUTH_CONTEXT.run(SYNTHETIC, run);
    expect(syn.applied).toBe(true);
    expect(posts).toBe(2);
    // Released when the chain settled: the next synthetic call gets the slot again.
    const again = ctx.INVOKE_AUTH_CONTEXT.run(SYNTHETIC, () => ctx.acquireSyntheticLlmSlot());
    expect(typeof again).toBe('function');
    again();
    ctx.__resetSyntheticLlmStateForTests();
  });

  test('intent rewrite: a synthetic call past the cap takes the deterministic intent without dialling', async () => {
    const ctx = require('../src/guardrails/syntheticContext');
    const { extractIntentWithMeta } = require('../src/findProductsMulti/intentLlm');
    process.env.SYNTHETIC_LLM_MAX_CALLS_PER_HOUR = '0';
    const out = await ctx.INVOKE_AUTH_CONTEXT.run(SYNTHETIC, () => extractIntentWithMeta('red lipstick under 20', [], []));
    expect(posts).toBe(0);
    expect(out.meta.mode).toBe('deterministic_fallback');
    expect(JSON.stringify(out.meta)).toContain('llm_synthetic_cap');
    ctx.__resetSyntheticLlmStateForTests();
  });
});
