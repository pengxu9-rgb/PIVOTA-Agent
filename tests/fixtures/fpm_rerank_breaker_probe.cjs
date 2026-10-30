'use strict';

// Boots the gateway with the rerank model breaker ALREADY OPEN, issues one find_products_multi invoke, and lets
// the server's own logger write the `fpm_stage_breakdown` line to stdout. Run as a child process by
// tests/fpm_llm_rerank_breaker_stage.node.test.cjs (pino writes straight to fd 1; see fpm_stage_probe.cjs).
//
// Nothing listens on either upstream: the search upstream fails fast, and OPENAI_BASE_URL points at a closed
// local port so no LLM call could leave the machine even if one were attempted.

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_CHAT_RESPONSE_FORMAT = 'legacy';
process.env.API_MODE = 'REAL';
process.env.PIVOTA_API_BASE = 'http://127.0.0.1:4699';
process.env.OPENAI_BASE_URL = 'http://127.0.0.1:4699/v1';
process.env.OPENAI_API_KEY = 'sk-fpm-breaker-probe';
process.env.FIND_PRODUCTS_MULTI_LLM_ENABLED = 'true';
process.env.PIVOTA_RERANK_LLM_PROVIDER = 'openai';
process.env.FIND_PRODUCTS_MULTI_SEMANTIC_REWRITE_PROVIDER = 'openai';
for (const key of [
  'PIVOTA_RERANK_MODEL', 'PIVOTA_RERANK_MODEL_OPENAI', 'PIVOTA_RERANK_LLM_FALLBACK_PROVIDER',
  'FIND_PRODUCTS_MULTI_LLM_FALLBACK_PROVIDER', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'PIVOTA_GEMINI_API_KEY',
  'AURORA_RECO_GEMINI_API_KEY', 'AURORA_SKIN_GEMINI_API_KEY',
]) {
  delete process.env[key];
}
const TEST_KEY = `ak_${'c'.repeat(64)}`;
process.env.PIVOTA_API_KEY = TEST_KEY;

const supertest = require('supertest');
const app = require('../../src/server');
const breaker = require('../../src/findProductsMulti/llmModelBreaker');

// The answer the provider gives for a model it does not serve (the shape openai's NotFoundError carries).
const modelNotFound = {
  status: 404,
  error: { message: 'The model `gpt-5.1-mini` does not exist or you do not have access to it.', code: 'model_not_found' },
};
if (process.argv[2] !== 'closed') {
  breaker.recordModelFailure({ feature: 'rerank', provider: 'openai', model: 'gpt-5.1-mini', err: modelNotFound });
}
breaker.recordModelFailure({ feature: 'semantic_rewrite', provider: 'openai', model: 'gpt-5.1-mini', err: modelNotFound });

(async () => {
  await supertest(app)
    .post('/agent/shop/v1/invoke')
    .set('x-agent-api-key', TEST_KEY)
    .send({
      operation: 'find_products_multi',
      metadata: { source: 'shopping_agent' },
      payload: { search: { query: 'rerank breaker probe running shoes', page_size: 5 } },
    });
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.exit(0);
})().catch((err) => {
  console.error('PROBE_FAILED', err && err.message);
  process.exit(1);
});
