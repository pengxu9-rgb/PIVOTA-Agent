const path = require('path');
const {
  loadProdGateCases,
  loadStagingMatrixPayload,
  loadPromptLiveSmokeCases,
} = require('./commerce_shared_acceptance_corpus');

const DEFAULT_SHARED_CORPUS_PATH = path.join(
  __dirname,
  '..',
  'fixtures',
  'celestial_commerce_core_shared_acceptance_corpus.json',
);

const PROD_CANARY_SELECTORS = Object.freeze([
  {
    family: 'public_search_contract',
    source: 'search',
    preferred_case_ids: ['public_search_serum_default'],
  },
  {
    family: 'broad_commerce_search',
    source: 'shopping_agent',
    preferred_case_ids: ['shopping_agent_serum_broad'],
  },
  {
    family: 'broad_commerce_search',
    source: 'aurora-bff',
    preferred_case_ids: ['aurora_bff_serum_broad'],
  },
  {
    family: 'strict_ingredient',
    source: 'shopping_agent',
    preferred_case_ids: ['shopping_agent_strict_niacinamide_serum'],
  },
  {
    family: 'exact_product_lookup',
    source: 'shopping_agent',
    preferred_case_ids: ['shopping_agent_exact_ipsa_time_reset_aqua'],
  },
  {
    family: 'exactish_lookup',
    source: 'shopping_agent',
    preferred_case_ids: ['shopping_agent_strict_niacinamide'],
  },
  {
    family: 'merchant_query',
    source: 'shopping_agent',
    preferred_case_ids: ['shopping_agent_merchant_query_ipsa_products'],
  },
  {
    family: 'scenario_clarify',
    source: 'shopping_agent',
    preferred_case_ids: ['shopping_agent_clarify_date_makeup'],
  },
]);

const PROD_CANARY_CASE_IDS = Object.freeze(
  PROD_CANARY_SELECTORS.flatMap((selector) => selector.preferred_case_ids || []),
);

function selectProdCanaryCase(cases, selector) {
  const family = String(selector?.family || '').trim();
  const source = String(selector?.source || '').trim();
  const preferredCaseIds = Array.isArray(selector?.preferred_case_ids)
    ? selector.preferred_case_ids.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const candidates = cases.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    if (family && String(item.family || '').trim() !== family) return false;
    if (source && String(item.source || '').trim() !== source) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  for (const id of preferredCaseIds) {
    const exact = candidates.find((item) => String(item.id || '').trim() === id);
    if (exact) return exact;
  }
  return candidates[0] || null;
}

function buildProdGateView(inputPath = DEFAULT_SHARED_CORPUS_PATH) {
  return loadProdGateCases(inputPath);
}

function buildProdCanaryView(inputPath = DEFAULT_SHARED_CORPUS_PATH) {
  const cases = buildProdGateView(inputPath);
  return PROD_CANARY_SELECTORS.map((selector) => selectProdCanaryCase(cases, selector)).filter(
    Boolean,
  );
}

function buildStagingAcceptanceMatrixView(inputPath = DEFAULT_SHARED_CORPUS_PATH) {
  const payload = loadStagingMatrixPayload(inputPath);
  return {
    semantic_cases: Array.isArray(payload.semantic_cases) ? payload.semantic_cases : [],
    governance_cases: Array.isArray(payload.governance_cases) ? payload.governance_cases : [],
  };
}

function buildPromptLiveSmokeView(inputPath = DEFAULT_SHARED_CORPUS_PATH) {
  return {
    prompt_cases: loadPromptLiveSmokeCases(inputPath),
  };
}

module.exports = {
  DEFAULT_SHARED_CORPUS_PATH,
  PROD_CANARY_SELECTORS,
  PROD_CANARY_CASE_IDS,
  buildProdGateView,
  buildProdCanaryView,
  buildStagingAcceptanceMatrixView,
  buildPromptLiveSmokeView,
};
