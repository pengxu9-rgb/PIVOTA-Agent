#!/usr/bin/env node

process.env.AURORA_BFF_USE_MOCK = process.env.AURORA_BFF_USE_MOCK || 'true';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const nodePathCandidates = [
  process.env.NODE_PATH || '',
  path.join(process.cwd(), 'node_modules'),
  path.join(__dirname, '..', 'node_modules'),
  path.join(os.homedir(), 'dev', 'Pivota-cursor-create-project-directory-structure-8344', 'pivota-agent-backend', 'node_modules'),
  path.join(os.homedir(), 'Desktop', 'Pivota Infra', 'Pivota-cursor-create-project-directory-structure-8344', 'node_modules'),
].filter((candidate, index, arr) => {
  if (!candidate) return false;
  if (!fs.existsSync(candidate)) return false;
  return arr.indexOf(candidate) === index;
});

if (nodePathCandidates.length) {
  process.env.NODE_PATH = nodePathCandidates.join(path.delimiter);
  Module._initPaths();
}

const { __internal } = require('../src/auroraBff/routes');

const DEFAULT_BASE_URL = process.env.AURORA_AUDIT_BASE_URL || 'https://pivota-agent-production.up.railway.app';
const DEFAULT_LIMIT = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.AURORA_AUDIT_REQUEST_TIMEOUT_MS || '8000', 10) || 8000);
const DEFAULT_OUTPUT_ROOT = path.join(process.cwd(), 'output', 'live-smoke');
const CANONICAL_INGREDIENTS = Object.freeze([
  ['ceramide_np', 'Ceramide NP'],
  ['panthenol', 'Panthenol (B5)'],
  ['niacinamide', 'Niacinamide'],
  ['zinc_pca', 'Zinc PCA'],
  ['salicylic_acid', 'Salicylic acid (BHA)'],
  ['azelaic_acid', 'Azelaic acid'],
  ['ascorbic_acid', 'Vitamin C (Ascorbic acid)'],
  ['retinol', 'Retinol'],
  ['benzoyl_peroxide', 'Benzoyl peroxide'],
  ['sunscreen_filters', 'UV filters'],
  ['glycerin', 'Glycerin'],
  ['hyaluronic_acid', 'Hyaluronic acid'],
]);

function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    limit: DEFAULT_LIMIT,
    outPath: '',
    ingredients: [],
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const token = String(argv[idx] || '').trim();
    if (!token) continue;
    if (token === '--base-url') {
      out.baseUrl = String(argv[idx + 1] || '').trim() || DEFAULT_BASE_URL;
      idx += 1;
      continue;
    }
    if (token === '--limit') {
      out.limit = Math.max(1, Math.min(12, Number.parseInt(argv[idx + 1], 10) || DEFAULT_LIMIT));
      idx += 1;
      continue;
    }
    if (token === '--out') {
      out.outPath = String(argv[idx + 1] || '').trim();
      idx += 1;
      continue;
    }
    if (token === '--ingredient') {
      const value = String(argv[idx + 1] || '').trim();
      if (value) out.ingredients.push(value);
      idx += 1;
    }
  }
  return out;
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeSearchReason(body) {
  if (!body || typeof body !== 'object') return 'empty';
  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : null;
  const reasonCodes = Array.isArray(body.reason_codes) ? body.reason_codes.filter(Boolean) : [];
  const strictEmptyReason = metadata && typeof metadata.strict_empty_reason === 'string'
    ? metadata.strict_empty_reason.trim().toLowerCase()
    : '';
  if (strictEmptyReason) return strictEmptyReason;
  if (reasonCodes.length) return String(reasonCodes[0]).trim().toLowerCase();
  if (typeof body.reply === 'string' && body.reply.trim()) return 'clarification';
  return 'empty';
}

function summarizeProducts(products, limit = 3) {
  return (Array.isArray(products) ? products : [])
    .slice(0, Math.max(1, limit))
    .map((row) => ({
      product_id: String(row?.product_id || row?.productId || '').trim() || null,
      merchant_id: String(row?.merchant_id || row?.merchantId || '').trim() || null,
      name: String(row?.name || row?.title || row?.display_name || row?.displayName || '').trim() || null,
      brand: String(row?.brand || '').trim() || null,
      source: String(row?.source || row?.source_type || '').trim() || null,
      retrieval_source: String(row?.retrieval_source || '').trim() || null,
      url: String(
        row?.open_url ||
        row?.openUrl ||
        row?.product_url ||
        row?.productUrl ||
        row?.pdp_url ||
        row?.pdpUrl ||
        row?.url ||
        '',
      ).trim() || null,
    }));
}

function buildTarget(ingredientId, ingredientName) {
  return {
    ingredient_id: ingredientId,
    ingredient_name: ingredientName,
    products: {
      competitors: [],
      dupes: [],
    },
  };
}

function flattenTopProducts(queryRows, limit = 3) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(queryRows) ? queryRows : []) {
    for (const product of Array.isArray(row?.top_products) ? row.top_products : []) {
      const key = [
        product?.product_id || '',
        product?.merchant_id || '',
        product?.name || '',
      ].join('::');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(product);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

async function runLiveSearch({
  baseUrl,
  query,
  limit,
  allowExternalSeed,
  externalSeedStrategy,
  serviceCommitRef,
}) {
  const url = new URL('/agent/v1/products/search', baseUrl);
  url.searchParams.set('query', String(query || '').trim());
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fast_mode', 'true');
  if (allowExternalSeed !== undefined) url.searchParams.set('allow_external_seed', allowExternalSeed === true ? 'true' : 'false');
  if (externalSeedStrategy) url.searchParams.set('external_seed_strategy', String(externalSeedStrategy || '').trim());

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  let response = null;
  let body = {};
  let elapsedMs = 0;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    elapsedMs = Date.now() - startedAt;
    body = await response.json().catch(() => ({}));
  } catch (error) {
    clearTimeout(timeout);
    elapsedMs = Date.now() - startedAt;
    const reason = error && error.name === 'AbortError' ? 'upstream_timeout' : 'upstream_error';
    return {
      ok: false,
      products: [],
      reason,
      latency_ms: elapsedMs,
      raw_total: 0,
      selected_source: null,
      body: {
        error: String(error && error.message ? error.message : error || ''),
      },
    };
  }
  clearTimeout(timeout);
  const commitHeader = String(response.headers.get('x-service-commit') || '').trim();
  if (!serviceCommitRef.value && commitHeader) serviceCommitRef.value = commitHeader;
  const products = Array.isArray(body?.products) ? body.products : [];
  const ok = Boolean(body?.success === true || body?.status === 'success' || products.length > 0);
  return {
    ok,
    products,
    reason: normalizeSearchReason(body),
    latency_ms: elapsedMs,
    raw_total: Number.isFinite(Number(body?.total)) ? Math.trunc(Number(body.total)) : products.length,
    selected_source: String(body?.metadata?.discovery_source_used || '').trim() || null,
    body,
  };
}

async function auditIngredient({
  baseUrl,
  ingredientId,
  ingredientName,
  limit,
  serviceCommitRef,
}) {
  const target = buildTarget(ingredientId, ingredientName);
  const queryStages = __internal.collectIngredientPlanRecoveryQueryStagesForTarget({
    payload: {},
    target,
    maxQueries: 2,
    mode: 'lightweight',
  });

  const auditQuery = async ({
    query,
    queryClassification,
    retryStrategy = 'on_empty_only',
  }) => {
    const catalog = await runLiveSearch({
      baseUrl,
      query,
      limit,
      allowExternalSeed: false,
      externalSeedStrategy: '',
      serviceCommitRef,
    });
    let external = null;
    let finalResult = catalog;
    if ((catalog.raw_total || 0) === 0) {
      external = await runLiveSearch({
        baseUrl,
        query,
        limit,
        allowExternalSeed: true,
        externalSeedStrategy: retryStrategy,
        serviceCommitRef,
      });
      if ((external.raw_total || 0) > 0) finalResult = external;
    }
    return {
      query,
      query_classification: queryClassification,
      catalog_result_count: catalog.raw_total || 0,
      external_seed_result_count: external ? external.raw_total || 0 : 0,
      external_seed_retry_used: external !== null,
      recovered_product_count: Array.isArray(finalResult.products) ? finalResult.products.length : 0,
      selected_source: finalResult.selected_source || null,
      no_result_reason:
        (Array.isArray(finalResult.products) && finalResult.products.length > 0)
          ? null
          : finalResult.reason || catalog.reason || (external && external.reason) || 'empty',
      top_products: summarizeProducts(finalResult.products),
    };
  };

  const specificDiagnostics = await Promise.all(
    (Array.isArray(queryStages.ingredientSpecificQueries) ? queryStages.ingredientSpecificQueries : []).map((query, index) =>
      auditQuery({
        query,
        queryClassification: index === 0 ? 'exact' : index === 1 ? 'alias' : 'specific',
        retryStrategy: 'on_empty_only',
      })),
  );

  const exactAliasNonEmpty = specificDiagnostics.some((row) => (row.recovered_product_count || 0) > 0);
  let familyDiagnostics = [];
  if (!exactAliasNonEmpty) {
    familyDiagnostics = await Promise.all(
      (Array.isArray(queryStages.familyFallbackQueries) ? queryStages.familyFallbackQueries : []).map((query) =>
        auditQuery({
          query,
          queryClassification: 'family',
          retryStrategy: 'supplement_internal_first',
        })),
    );
  }

  return {
    ingredient_id: ingredientId,
    ingredient_name: ingredientName,
    exact_alias_queries: Array.isArray(queryStages.ingredientSpecificQueries) ? queryStages.ingredientSpecificQueries : [],
    family_queries: Array.isArray(queryStages.familyFallbackQueries) ? queryStages.familyFallbackQueries : [],
    exact_alias_results: specificDiagnostics.map((row) => ({
      query: row.query,
      query_classification: row.query_classification,
      catalog_result_count: row.catalog_result_count,
      external_seed_result_count: row.external_seed_result_count,
      external_seed_retry_used: row.external_seed_retry_used === true,
      recovered_product_count: row.recovered_product_count,
      selected_source: row.selected_source || null,
      no_result_reason: row.no_result_reason || null,
      top_products: row.top_products,
    })),
    family_results: familyDiagnostics.map((row) => ({
      query: row.query,
      query_classification: row.query_classification,
      catalog_result_count: row.catalog_result_count,
      external_seed_result_count: row.external_seed_result_count,
      external_seed_retry_used: row.external_seed_retry_used === true,
      recovered_product_count: row.recovered_product_count,
      selected_source: row.selected_source || null,
      no_result_reason: row.no_result_reason || null,
      top_products: row.top_products,
    })),
    exact_alias_non_empty: exactAliasNonEmpty,
    family_fallback_used: familyDiagnostics.some((row) => (row.recovered_product_count || 0) > 0),
    external_seed_retry_used:
      specificDiagnostics.some((row) => row.external_seed_retry_used === true) ||
      familyDiagnostics.some((row) => row.external_seed_retry_used === true),
    exact_alias_top_products: flattenTopProducts(specificDiagnostics),
    family_top_products: flattenTopProducts(familyDiagnostics),
  };
}

function filterIngredientList(selectedIngredients) {
  if (!Array.isArray(selectedIngredients) || selectedIngredients.length === 0) return CANONICAL_INGREDIENTS.slice();
  const requested = new Set(selectedIngredients.map((row) => String(row || '').trim().toLowerCase()).filter(Boolean));
  return CANONICAL_INGREDIENTS.filter(([ingredientId, ingredientName]) =>
    requested.has(String(ingredientId).toLowerCase()) ||
    requested.has(String(ingredientName).toLowerCase()),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  if (!baseUrl) {
    throw new Error('Missing --base-url');
  }

  const ingredients = filterIngredientList(args.ingredients);
  if (!ingredients.length) {
    throw new Error('No canonical ingredients matched the requested filters');
  }

  const serviceCommitRef = { value: '' };
  const startedAt = new Date().toISOString();
  const rows = [];
  for (const [ingredientId, ingredientName] of ingredients) {
    rows.push(await auditIngredient({
      baseUrl,
      ingredientId,
      ingredientName,
      limit: args.limit,
      serviceCommitRef,
    }));
  }

  const summary = {
    generated_at: startedAt,
    base_url: baseUrl,
    x_service_commit: serviceCommitRef.value || null,
    ingredient_recovery_query_policy_version: 'exact_alias_family_v1',
    ingredient_count: rows.length,
    exact_alias_non_empty_count: rows.filter((row) => row.exact_alias_non_empty).length,
    family_fallback_used_count: rows.filter((row) => row.family_fallback_used).length,
    external_seed_retry_used_count: rows.filter((row) => row.external_seed_retry_used).length,
    rows,
  };

  const outputJson = `${JSON.stringify(summary, null, 2)}\n`;
  process.stdout.write(outputJson);

  if (args.outPath) {
    const outPath = path.isAbsolute(args.outPath)
      ? args.outPath
      : path.join(DEFAULT_OUTPUT_ROOT, args.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, outputJson, 'utf8');
  }
  process.exit(0);
}

main().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
