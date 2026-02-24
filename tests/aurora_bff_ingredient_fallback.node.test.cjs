const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('ingredient fallback executor: builds realtime candidates from search + crawl', async () => {
  const out = await routeInternals.runIngredientExternalExecutorForIngredient({
    ingredientId: 'azelaic_acid',
    ingredientName: 'Azelaic Acid',
    budgetTier: 'mid',
    deadlineMs: Date.now() + 1800,
    searchFn: async () => ({
      ok: true,
      reason: null,
      products: [
        {
          product_id: 'amz_az_1',
          name: 'Azelaic Face Serum SPF 30',
          brand: 'Brand A',
          category: 'Facial treatment serum',
          why_match: 'Topical face serum for azelaic acid routine',
          pdp_url: 'https://www.amazon.com/dp/B00TEST123',
          image_url: 'https://images.example.com/az_1.jpg',
        },
      ],
    }),
    fetchHtmlFn: async () =>
      `<html>
        <meta property="product:price:currency" content="USD" />
        <meta property="product:price:amount" content="22.50" />
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.4","reviewCount":"120"}}
        </script>
      </html>`,
    llmExtractFn: async () => null,
  });

  assert.ok(out);
  assert.equal(out.capture_mode, 'sync_external_executor');
  assert.equal(out.status, 'external_executor_returned');
  assert.equal(Array.isArray(out.candidates), true);
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].source, 'amazon');
  assert.equal(out.candidates[0].price, 22.5);
  assert.equal(out.candidates[0].currency, 'USD');
  assert.equal(out.candidates[0].rating_value, 4.4);
  assert.equal(out.candidates[0].rating_count, 120);
});

test('ingredient fallback executor: returns google fallback metadata when search misses', async () => {
  const out = await routeInternals.runIngredientExternalExecutorForIngredient({
    ingredientId: 'panthenol',
    ingredientName: 'Panthenol',
    budgetTier: 'mid',
    deadlineMs: Date.now() + 1200,
    searchFn: async () => ({
      ok: false,
      reason: 'upstream_timeout',
      products: [],
    }),
    fetchHtmlFn: async () => '',
    llmExtractFn: async () => null,
  });

  assert.ok(out);
  assert.equal(out.capture_mode, 'sync_external_executor');
  assert.equal(out.status, 'external_executor_empty');
  assert.equal(out.failure_reason, 'upstream_timeout');
  assert.equal(Array.isArray(out.candidates), true);
  assert.equal(out.candidates.length, 0);
  assert.equal(typeof out.candidate_url, 'string');
  assert.equal(out.candidate_url.includes('google.com/search'), true);
});

test('ingredient fallback relevance: rejects non-skincare tool candidates for UV filters', () => {
  const decision = routeInternals.evaluateIngredientCandidateSkincareRelevance({
    ingredientId: 'uv_filters',
    ingredientName: 'UV filters',
    strictFilterEnabled: true,
    candidate: {
      name: 'Contour Brush - Sculpt & Soften',
      category: 'Beauty tool',
      source: 'google',
      why_match: 'Fallback from Google',
      pdp_url: 'https://example.com/brush',
    },
  });

  assert.ok(decision && typeof decision === 'object');
  assert.equal(decision.pass, false);
  assert.equal(String(decision.reason || '').startsWith('negative_keyword:'), true);
});

test('ingredient fallback executor: all non-skincare candidates are dropped and downgraded to google fallback', async () => {
  const out = await routeInternals.runIngredientExternalExecutorForIngredient({
    ingredientId: 'uv_filters',
    ingredientName: 'UV Filters',
    budgetTier: 'mid',
    deadlineMs: Date.now() + 1800,
    searchFn: async () => ({
      ok: true,
      reason: null,
      products: [
        {
          product_id: 'brush_1',
          name: 'Contour Brush - With Pouch',
          brand: 'Tool Brand',
          category: 'Makeup brush',
          pdp_url: 'https://example.com/brush_1',
        },
        {
          product_id: 'brush_2',
          name: 'Soft Synthetic Brush',
          brand: 'Tool Brand',
          category: 'Beauty tools',
          pdp_url: 'https://example.com/brush_2',
        },
      ],
    }),
    fetchHtmlFn: async () => '',
    llmExtractFn: async () => null,
  });

  assert.ok(out);
  assert.equal(out.status, 'external_executor_empty');
  assert.equal(Array.isArray(out.candidates), true);
  assert.equal(out.candidates.length, 0);
  assert.equal(typeof out.candidate_url, 'string');
  assert.equal(out.candidate_url.includes('google.com/search'), true);
  assert.equal(Array.isArray(out.rejected_candidates), true);
  assert.equal(out.rejected_candidates.length >= 1, true);
});
