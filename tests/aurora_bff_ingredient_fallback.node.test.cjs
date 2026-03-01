const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AURORA_PRODUCT_LOOKUP_LLM_FALLBACK_ENABLED = 'true';
process.env.AURORA_PURCHASABLE_FALLBACK_ENABLED = 'true';

const { buildIngredientPlanV2 } = require('../src/auroraBff/ingredientMapperV1');
const { __internal: routeInternals } = require('../src/auroraBff/routes');

function createTempCatalog(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-ing-fallback-'));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
  return { dir, file };
}

test('ingredient fallback: catalog miss returns external search candidates and missing-catalog signal', () => {
  const { dir, file } = createTempCatalog([]);
  try {
    const plan = buildIngredientPlanV2({
      plan: {
        intensity: 'balanced',
        targets: [{ ingredient_id: 'azelaic_acid', priority: 78 }],
        avoid: [],
        conflicts: [],
      },
      profile: { budgetTier: 'mid' },
      catalogPath: file,
    });

    assert.ok(plan);
    assert.equal(plan.schema_version, 'aurora.ingredient_plan.v2');
    assert.equal(plan.external_fallback_used, true);
    assert.ok(Array.isArray(plan.__missing_catalog_queries));
    assert.equal(plan.__missing_catalog_queries.length >= 1, true);
    assert.equal(typeof plan.__missing_catalog_queries[0].candidate_url === 'string', true);
    assert.equal(String(plan.__missing_catalog_queries[0].candidate_url).startsWith('https://'), true);
    assert.equal(plan.__missing_catalog_queries[0].capture_mode, 'sync_external_fallback');

    const target = plan.targets.find((item) => item.ingredient_id === 'azelaic_acid');
    assert.ok(target);
    assert.equal(Array.isArray(target.products.competitors), true);
    assert.equal(Array.isArray(target.products.dupes), true);
    assert.equal(target.products.competitors.length, 2);
    assert.equal(target.products.dupes.length, 1);

    const merged = [...target.products.competitors, ...target.products.dupes];
    assert.equal(merged.every((item) => item.fallback_type === 'search'), true);
    assert.equal(merged.every((item) => typeof item.pdp_url === 'string' && item.pdp_url.length > 0), true);
    assert.equal(merged.some((item) => String(item.pdp_url).includes('amazon.com')), true);
    assert.equal(merged.some((item) => String(item.pdp_url).includes('google.com/search')), true);
    assert.equal(
      merged.every((item) => item.open_target === 'external'),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingredient fallback: partial catalog keeps local hit and supplements remainder with external candidates', () => {
  const { dir, file } = createTempCatalog([
    {
      product_id: 'local_mid_1',
      name: 'Local Azelaic Serum',
      brand: 'KB Brand',
      ingredient_ids: ['azelaic_acid'],
      price_tier: 'mid',
      price: 35,
      currency: 'USD',
      pdp_url: 'https://example.com/pdp/local_mid_1',
      source: 'kb',
    },
  ]);

  try {
    const plan = buildIngredientPlanV2({
      plan: {
        intensity: 'balanced',
        targets: [{ ingredient_id: 'azelaic_acid', priority: 80 }],
        avoid: [],
        conflicts: [],
      },
      profile: { budgetTier: 'mid' },
      catalogPath: file,
    });

    assert.ok(plan);
    assert.equal(plan.external_fallback_used, true);
    const target = plan.targets.find((item) => item.ingredient_id === 'azelaic_acid');
    assert.ok(target);

    const merged = [...target.products.competitors, ...target.products.dupes];
    assert.equal(merged.length, 3);
    assert.equal(merged.some((item) => item.product_id === 'local_mid_1'), true);
    assert.equal(merged.some((item) => item.source === 'kb'), true);
    assert.equal(merged.some((item) => item.source !== 'kb'), true);
    assert.equal(merged.some((item) => item.fallback_type === 'search'), true);
    assert.equal(merged.every((item) => item.open_target === 'external'), true);
    assert.equal(plan.__missing_catalog_queries.length >= 1, true);
    assert.equal(plan.__missing_catalog_queries[0].status === 'external_fallback_returned' || plan.__missing_catalog_queries[0].status === 'catalog_partial', true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingredient fallback relevance: evaluateIngredientCandidateWithQaMode rejects non-skincare tool candidates', async () => {
  const decision = await routeInternals.evaluateIngredientCandidateWithQaMode(
    {
      name: 'Contour Brush - Sculpt & Soften',
      category: 'Beauty tool',
      source: 'google',
      why_match: 'Fallback from Google',
      pdp_url: 'https://example.com/brush',
    },
    {
      qaMode: 'off',
      singleProvider: 'gemini',
      allowOpenAiFallback: false,
    },
  );

  assert.ok(decision && typeof decision === 'object');
  assert.equal(decision.pass, false);
  assert.equal(decision.reject_reason, 'heuristic_relevance_reject');
});

test('ingredient fallback recovery: recoverPurchasableProductsFromQueries keeps skincare candidates with https PDP', async () => {
  const out = await routeInternals.recoverPurchasableProductsFromQueries({
    queries: ['azelaic acid serum'],
    strictFilter: true,
    qaMode: 'off',
    singleProvider: 'gemini',
    allowOpenAiFallback: false,
    fallbackCandidateBuilder: async () => ({
      selected_source: 'internal',
      products: [
        {
          product_id: 'az_1',
          merchant_id: 'm1',
          name: 'Azelaic Serum 10%',
          brand: 'Brand A',
          category: 'Facial treatment serum',
          pdp_url: 'https://example.com/pdp/az_1',
          source: 'catalog',
        },
      ],
    }),
  });

  assert.ok(out);
  assert.equal(Array.isArray(out.products), true);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].product_id, 'az_1');
  assert.equal(
    String(out.products[0].pdp_url || out.products[0].url || out.products[0].product_url || ''),
    'https://example.com/pdp/az_1',
  );
  assert.equal(out.rejected.length, 0);
});

test('ingredient fallback recovery: recoverPurchasableProductsFromQueries drops non-skincare and emits rejection details', async () => {
  const out = await routeInternals.recoverPurchasableProductsFromQueries({
    queries: ['uv filter'],
    strictFilter: true,
    qaMode: 'off',
    singleProvider: 'gemini',
    allowOpenAiFallback: false,
    fallbackCandidateBuilder: async () => ({
      selected_source: 'external',
      products: [
        {
          product_id: 'brush_1',
          merchant_id: 'm1',
          name: 'Contour Brush - With Pouch',
          category: 'Makeup brush',
          pdp_url: 'https://example.com/brush_1',
          source: 'google',
        },
      ],
    }),
  });

  assert.ok(out);
  assert.equal(out.products.length, 0);
  assert.equal(Array.isArray(out.rejected), true);
  assert.equal(out.rejected.length >= 1, true);
  assert.equal(String(out.rejected[0].reject_reason || '').length > 0, true);
});

test('ingredient fallback llm recovery: non-skincare LLM candidates are filtered and demoted to external search CTA', async () => {
  try {
    routeInternals.__setCallGeminiJsonObjectForTest(async () => ({
      ok: true,
      json: {
        products: [
          {
            name: 'Soft Synthetic Brush',
            brand: 'Tool Brand',
            category: 'Beauty tools',
            pdp_url: 'https://example.com/brush_2',
            why: 'Not skincare',
          },
        ],
      },
    }));
    const out = await routeInternals.recoverProductsWithLlmFallbackFromQueries({
      queries: ['uv filters'],
      strictFilter: true,
      qaMode: 'off',
      singleProvider: 'gemini',
      allowOpenAiFallback: false,
    });

    assert.ok(out);
    assert.equal(out.llm_used, true);
    assert.equal(out.products.length, 0);
    assert.equal(Array.isArray(out.external_search_ctas), true);
    assert.equal(Array.isArray(out.rejected), true);
    assert.equal(out.rejected.length >= 1, true);
  } finally {
    routeInternals.__resetCallGeminiJsonObjectForTest();
  }
});
