/**
 * Unified error taxonomy for /recommend.
 * Keep string enums stable for logging and client handling.
 */
const ERROR_CODES = {
  RECALL_EMPTY: 'RECALL_EMPTY',
  CATALOG_STALE: 'CATALOG_STALE',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  VALIDATION_FAIL: 'VALIDATION_FAIL',
  PROVIDER_DOWN: 'PROVIDER_DOWN',
  BUDGET_SKIP: 'BUDGET_SKIP',
  RERANK_EMPTY: 'RERANK_EMPTY',
  OUT_OF_DOMAIN: 'OUT_OF_DOMAIN',
};

module.exports = {
  ERROR_CODES,
};
