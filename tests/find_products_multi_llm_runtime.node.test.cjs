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
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER: undefined,
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_FALLBACK_PROVIDER: undefined,
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
      assert.deepEqual(semanticRuntime.providerChain, ['gemini']);
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
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER: 'gemini',
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_FALLBACK_PROVIDER: undefined,
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

test('gemini semantic rewrite preserves multipart JSON without injecting invalid separators', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER: 'gemini',
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_FALLBACK_PROVIDER: undefined,
      GEMINI_API_KEY: 'test-gemini-key',
      OPENAI_API_KEY: undefined,
      LLM_API_KEY: undefined,
    },
    async () => {
      const axios = require('axios');
      const { extractIntentRuleBased } = require('../src/findProductsMulti/intent');
      const originalPost = axios.post;
      const raw = JSON.stringify(extractIntentRuleBased('best sunscreen for oily skin', [], []));
      const splitAt = raw.indexOf('beauty') + 3;
      axios.post = async () => ({
        data: {
          candidates: [
            {
              content: {
                parts: [
                  { text: raw.slice(0, splitAt) },
                  { text: raw.slice(splitAt) },
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
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_OPENAI: 'gpt-5.1-mini',
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI: 'gemini-3-flash-preview',
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
      assert.equal(plan.primaryModelOwner, 'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI');
    },
  );
});

test('semantic rewrite ignores legacy shared model envs and keeps explicit model ownership local', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      OPENAI_API_KEY: 'sk-live-realish-openai-key',
      GEMINI_API_KEY: 'test-gemini-key',
      PIVOTA_INTENT_MODEL: 'gpt-5.1-mini',
      PIVOTA_INTENT_MODEL_GEMINI: 'gemini-1.5-flash',
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI: undefined,
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_OPENAI: undefined,
    },
    async () => {
      const { _debug } = loadIntentFresh();
      const geminiModel = _debug.resolveIntentGeminiModel();
      const openaiModel = _debug.resolveIntentOpenAiModel();

      assert.equal(geminiModel.model, 'gemini-3-flash-preview');
      assert.equal(geminiModel.model_owner, 'default_semantic_rewrite_gemini_model');
      assert.equal(openaiModel.model, 'gpt-5.1-mini');
      assert.equal(openaiModel.model_owner, 'default_semantic_rewrite_openai_model');
    },
  );
});

test('semantic rewrite input is compact and uses semantic contract summary instead of raw schema dump', async () => {
  await withEnv({}, async () => {
    const { _debug } = loadIntentFresh();
    const raw = _debug.buildIntentLlmInput(
      'best sunscreen for oily skin',
      ['need something for oily skin'],
      [{ role: 'user', content: 'best sunscreen for oily skin' }],
      {
        semanticContract: {
          version: 'beauty_semantic_contract_v1',
          owner: 'aurora_reco_planner',
          planner_mode: 'step_aware',
          request_class: 'sunscreen',
          target_step_family: 'sunscreen',
          primary_role_id: 'daily_sunscreen',
          support_role_ids: ['daily_sunscreen'],
          semantic_family: 'sunscreen',
          allowed_step_families: ['sunscreen'],
          ingredient_hypotheses: [],
          source_surface: 'aurora_beauty_strict',
        },
      },
    );
    const parsed = JSON.parse(raw);
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'schema'), false);
    assert.deepEqual(parsed.output_contract.required_keys.slice(0, 4), [
      'language',
      'primary_domain',
      'target_object.type',
      'target_object.age_group',
    ]);
    assert.equal(parsed.semantic_contract.request_class, 'sunscreen');
    assert.equal(parsed.semantic_contract.source_surface, 'aurora_beauty_strict');
  });
});

test('semantic rewrite llm failure preserves planned model metadata and exposes normalized gemini error details', async () => {
  await withEnv(
    {
      FIND_PRODUCTS_MULTI_LLM_ENABLED: undefined,
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER: 'gemini',
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_FALLBACK_PROVIDER: undefined,
      FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI: 'gemini-3-flash-preview',
      OPENAI_API_KEY: undefined,
      LLM_API_KEY: undefined,
      GEMINI_API_KEY: 'test-gemini-key',
      PIVOTA_GEMINI_API_KEY: undefined,
      AURORA_RECO_GEMINI_API_KEY: undefined,
      AURORA_SKIN_GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    },
    async () => {
      const axios = require('axios');
      const originalPost = axios.post;
      axios.post = async () => {
        const err = new Error('Request failed with status code 503');
        err.code = 'EUPSTREAM';
        err.response = {
          status: 503,
          data: {
            error: {
              status: 'UNAVAILABLE',
              message: 'provider overloaded',
            },
          },
        };
        throw err;
      };

      try {
        const { extractIntentWithMeta } = loadIntentFresh();
        const result = await extractIntentWithMeta('best sunscreen for oily skin', [], [], {
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

        assert.equal(result.meta.mode, 'deterministic_fallback');
        assert.equal(result.meta.provider, 'rule_based');
        assert.equal(result.meta.fallback_reason, 'llm_failed');
        assert.deepEqual(result.meta.llm_provider_chain, ['gemini']);
        assert.equal(result.meta.llm_primary_provider, 'gemini');
        assert.equal(result.meta.llm_model, 'gemini-3-flash-preview');
        assert.equal(
          result.meta.llm_model_owner,
          'FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_MODEL_GEMINI',
        );
        assert.equal(result.meta.llm_error_class, 'provider_error');
        assert.equal(result.meta.llm_error_stage, 'primary');
        assert.equal(result.meta.llm_error_provider, 'gemini');
        assert.equal(result.meta.llm_error_message, 'Request failed with status code 503');
        assert.equal(result.meta.llm_upstream_status, 503);
        assert.equal(result.meta.llm_upstream_error_code, 'UNAVAILABLE');
        assert.equal(result.meta.llm_upstream_error_message, 'provider overloaded');
      } finally {
        axios.post = originalPost;
      }
    },
  );
});
