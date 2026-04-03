const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch || {})) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function loadRuntimeFresh() {
  const moduleId = require.resolve('../src/findProductsMulti/llmRuntime');
  delete require.cache[moduleId];
  return require('../src/findProductsMulti/llmRuntime');
}

function loadIntentFresh() {
  const moduleId = require.resolve('../src/findProductsMulti/intentLlm');
  delete require.cache[moduleId];
  return require('../src/findProductsMulti/intentLlm');
}

test('find_products_multi llm master gate disables semantic rewrite and rerank together', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: 'false',
      OPENAI_API_KEY: 'test-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
    },
    async () => {
      const { resolveFindProductsLlmRuntime } = loadRuntimeFresh();
      const semanticRuntime = resolveFindProductsLlmRuntime('semantic_rewrite');
      const rerankRuntime = resolveFindProductsLlmRuntime('rerank');

      assert.equal(semanticRuntime.enabled, false);
      assert.equal(semanticRuntime.disabledReason, 'master_disabled');
      assert.equal(rerankRuntime.enabled, false);
      assert.equal(rerankRuntime.disabledReason, 'master_disabled');
    },
  );
});

test('find_products_multi llm runtime auto-enables from provider availability when no explicit flag is set', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      OPENAI_API_KEY: undefined,
      LLM_API_KEY: undefined,
      AURORA_RECO_GEMINI_API_KEY: undefined,
      PIVOTA_GEMINI_API_KEY: 'pivota-gemini-key',
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const { resolveFindProductsLlmRuntime } = loadRuntimeFresh();
      const semanticRuntime = resolveFindProductsLlmRuntime('semantic_rewrite');
      const rerankRuntime = resolveFindProductsLlmRuntime('rerank');

      assert.equal(semanticRuntime.enabled, true);
      assert.equal(semanticRuntime.primaryProvider, 'gemini');
      assert.deepEqual(semanticRuntime.providerChain, ['gemini']);
      assert.equal(rerankRuntime.enabled, true);
      assert.equal(rerankRuntime.primaryProvider, 'gemini');
      assert.deepEqual(rerankRuntime.providerChain, ['gemini']);
    },
  );
});

test('shopping llm auto-select prefers gemini for both semantic rewrite and rerank when both providers are available', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      FIND_PRODUCTS_MULTI_LLM_PROVIDER: undefined,
      FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER: undefined,
      PIVOTA_INTENT_LLM_PROVIDER: undefined,
      PIVOTA_INTENT_LLM_FALLBACK_PROVIDER: undefined,
      PIVOTA_RERANK_LLM_PROVIDER: undefined,
      PIVOTA_RERANK_LLM_FALLBACK_PROVIDER: undefined,
      OPENAI_API_KEY: 'sk-live-realish-openai-key',
      LLM_API_KEY: undefined,
      GEMINI_API_KEY: 'test-gemini-key',
      PIVOTA_GEMINI_API_KEY: undefined,
      AURORA_RECO_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const { resolveFindProductsLlmRuntime } = loadRuntimeFresh();
      const semanticRuntime = resolveFindProductsLlmRuntime('semantic_rewrite');
      const rerankRuntime = resolveFindProductsLlmRuntime('rerank');

      assert.equal(semanticRuntime.enabled, true);
      assert.equal(semanticRuntime.primaryProvider, 'gemini');
      assert.deepEqual(semanticRuntime.providerChain, ['gemini', 'openai']);
      assert.equal(rerankRuntime.enabled, true);
      assert.equal(rerankRuntime.primaryProvider, 'gemini');
      assert.deepEqual(rerankRuntime.providerChain, ['gemini', 'openai']);
    },
  );
});

test('fake openai placeholder key is ignored so gemini remains the only available provider', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      OPENAI_API_KEY: 'fake-openai-key',
      LLM_API_KEY: undefined,
      GEMINI_API_KEY: 'test-gemini-key',
      PIVOTA_GEMINI_API_KEY: undefined,
      AURORA_RECO_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const { resolveFindProductsLlmRuntime, resolveFindProductsOpenAiApiKey } = loadRuntimeFresh();
      const semanticRuntime = resolveFindProductsLlmRuntime('semantic_rewrite');
      assert.equal(resolveFindProductsOpenAiApiKey(), '');
      assert.deepEqual(semanticRuntime.availableProviders, ['gemini']);
      assert.deepEqual(semanticRuntime.providerChain, ['gemini']);
    },
  );
});

test('intent llm uses gemini fallback key aliases and enters llm mode without explicit feature flag', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      OPENAI_API_KEY: undefined,
      LLM_API_KEY: undefined,
      AURORA_RECO_GEMINI_API_KEY: undefined,
      PIVOTA_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: 'skin-gemini-key',
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
      PIVOTA_INTENT_LLM_PROVIDER: 'gemini',
      PIVOTA_INTENT_LLM_FALLBACK_PROVIDER: undefined,
    },
    async () => {
      const axios = require('axios');
      const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');
      const originalPost = axios.post;
      axios.post = async () => ({
        data: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify(extractIntentRuleBased('best sunscreen for oily skin', [], [])),
                  },
                ],
              },
            },
          ],
        },
      });

      try {
        const { extractIntentWithMeta } = loadIntentFresh();
        const result = await extractIntentWithMeta('best sunscreen for oily skin', [], []);
        assert.equal(result.meta.mode, 'llm');
        assert.equal(result.meta.provider, 'gemini');
        assert.equal(result.intent.primary_domain, 'beauty');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});

test('aurora strict semantic contract locks intent llm to a single provider and surfaces model metadata', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      FIND_PRODUCTS_MULTI_LLM_PROVIDER: undefined,
      FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER: undefined,
      OPENAI_API_KEY: 'sk-live-realish-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      PIVOTA_INTENT_MODEL: 'gpt-5.1-mini',
      PIVOTA_INTENT_MODEL_GEMINI: undefined,
    },
    async () => {
      const { _debug } = loadIntentFresh();
      const plan = _debug.resolveIntentLlmExecutionPlan({
        semanticContract: {
          version: 'beauty_semantic_contract_v1',
          owner: 'aurora_reco_planner',
          planner_mode: 'step_aware',
          request_class: 'sunscreen',
          target_step_family: 'sunscreen',
          primary_role_id: 'daily_sunscreen',
          source_surface: 'aurora_beauty_strict',
        },
      });

      assert.equal(plan.enabled, true);
      assert.equal(plan.primaryProvider, 'gemini');
      assert.equal(plan.fallbackProvider, null);
      assert.deepEqual(plan.providerChain, ['gemini']);
      assert.equal(plan.singleProviderLocked, true);
      assert.equal(plan.primaryModel, 'gemini-3-flash-preview');
      assert.ok(plan.primaryModelOwner);
    },
  );
});
