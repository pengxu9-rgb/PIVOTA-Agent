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
      PIVOTA_INTENT_LLM_ENABLED: 'true',
      FIND_PRODUCTS_MULTI_RERANK_LLM_ENABLED: 'true',
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
      PIVOTA_INTENT_LLM_ENABLED: undefined,
      FIND_PRODUCTS_MULTI_RERANK_LLM_ENABLED: undefined,
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

test('legacy feature-specific llm disable flags no longer override the unified shopping llm owner', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      PIVOTA_INTENT_LLM_ENABLED: 'false',
      FIND_PRODUCTS_MULTI_RERANK_LLM_ENABLED: 'false',
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
      assert.equal(semanticRuntime.enableOwner, 'provider_auto_enable');
      assert.equal(semanticRuntime.legacyFeatureGateIgnored, 'PIVOTA_INTENT_LLM_ENABLED');
      assert.equal(semanticRuntime.legacyFeatureGateValue, false);

      assert.equal(rerankRuntime.enabled, true);
      assert.equal(rerankRuntime.enableOwner, 'provider_auto_enable');
      assert.equal(rerankRuntime.legacyFeatureGateIgnored, 'FIND_PRODUCTS_MULTI_RERANK_LLM_ENABLED');
      assert.equal(rerankRuntime.legacyFeatureGateValue, false);
    },
  );
});

test('intent llm uses gemini fallback key aliases and enters llm mode without explicit feature flag', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      PIVOTA_INTENT_LLM_ENABLED: undefined,
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

test('intent llm still enters llm mode when legacy intent gate is false but provider keys are present', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      PIVOTA_INTENT_LLM_ENABLED: 'false',
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
        assert.equal(result.meta.enable_owner, 'provider_auto_enable');
        assert.equal(result.meta.legacy_feature_gate_ignored, 'PIVOTA_INTENT_LLM_ENABLED');
        assert.equal(result.meta.legacy_feature_gate_value, false);
      } finally {
        axios.post = originalPost;
      }
    },
  );
});
