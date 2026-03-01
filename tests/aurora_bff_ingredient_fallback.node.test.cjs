const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildIngredientPlanV2 } = require('../src/auroraBff/ingredientMapperV1');
const { __internal: routeInternals } = require('../src/auroraBff/routes');

test.afterEach(() => {
  routeInternals.__resetCallGeminiJsonObjectForTest();
});

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

test('ingredient fallback llm: recovers realtime candidates from LLM JSON payload', async () => {
  routeInternals.__setCallGeminiJsonObjectForTest(async () => ({
    ok: true,
    json: {
      products: [
        {
          name: 'Azelaic Face Serum SPF 30',
          brand: 'Brand A',
          category: 'Facial treatment serum',
          why: 'Topical face serum for azelaic acid routine',
          pdp_url: 'https://www.amazon.com/dp/B00TEST123',
        },
      ],
    },
  }));

  const out = await routeInternals.recoverProductsWithLlmFallbackFromQueries({
    queries: ['azelaic acid serum'],
    strictFilter: true,
    maxProducts: 3,
  });

  assert.ok(out);
  assert.equal(out.llm_used, true);
  assert.equal(Array.isArray(out.products), true);
  assert.equal(out.products.length, 1);
  assert.equal(out.products[0].source, 'llm_fallback');
  assert.equal(out.products[0].retrieval_source, 'llm_fallback');
  assert.equal(out.products[0].pdp_url, 'https://www.amazon.com/dp/B00TEST123');
  assert.equal(out.stage_counts.recovered >= 1, true);
  assert.equal(out.last_reason, 'llm_recovered');
});

test('ingredient fallback llm: timeout-like upstream failure yields timeout stage and empty products', async () => {
  routeInternals.__setCallGeminiJsonObjectForTest(async () => ({
    ok: false,
    error: 'upstream_timeout',
  }));

  const out = await routeInternals.recoverProductsWithLlmFallbackFromQueries({
    queries: ['panthenol moisturizer'],
    strictFilter: true,
    maxProducts: 3,
  });

  assert.ok(out);
  assert.equal(out.llm_used, false);
  assert.equal(Array.isArray(out.products), true);
  assert.equal(out.products.length, 0);
  assert.equal(out.stage_counts.timeout, 1);
  assert.equal(out.last_reason, 'llm_timeout');
});

test('ingredient fallback relevance: rejects non-skincare tool candidates for UV filters', async () => {
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
      qaContext: null,
    },
  );

  assert.ok(decision && typeof decision === 'object');
  assert.equal(decision.pass, false);
  assert.equal(String(decision.reject_reason || '').includes('heuristic_relevance_reject'), true);
});

test('ingredient fallback llm: all non-skincare candidates are filtered out', async () => {
  routeInternals.__setCallGeminiJsonObjectForTest(async () => ({
    ok: true,
    json: {
      products: [
        {
          name: 'Contour Brush - With Pouch',
          brand: 'Tool Brand',
          category: 'Makeup brush',
          pdp_url: 'https://example.com/brush_1',
        },
        {
          name: 'Soft Synthetic Brush',
          brand: 'Tool Brand',
          category: 'Beauty tools',
          pdp_url: 'https://example.com/brush_2',
        },
      ],
    },
  }));

  const out = await routeInternals.recoverProductsWithLlmFallbackFromQueries({
    queries: ['uv filters'],
    strictFilter: true,
    maxProducts: 3,
  });

  assert.ok(out);
  assert.equal(out.llm_used, true);
  assert.equal(Array.isArray(out.products), true);
  assert.equal(out.products.length, 0);
  assert.equal(Array.isArray(out.rejected), true);
  assert.equal(out.rejected.length >= 1, true);
  assert.equal(out.stage_counts.empty >= 1, true);
  assert.equal(out.last_reason, 'llm_empty_after_filter');
});
