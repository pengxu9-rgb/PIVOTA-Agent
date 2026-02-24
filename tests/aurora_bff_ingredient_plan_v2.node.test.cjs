const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildIngredientPlanV2 } = require('../src/auroraBff/ingredientMapperV1');

function createTempCatalog(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-ing-v2-'));
  const file = path.join(dir, 'catalog.json');
  fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
  return { dir, file };
}

test('ingredient_plan_v2 deduplicates canonical targets and keeps 2 competitors + 1 dupe', () => {
  const { dir, file } = createTempCatalog([
    {
      product_id: 'mid_1',
      name: 'Niacinamide Mid 1',
      brand: 'Brand Mid',
      ingredient_ids: ['niacinamide'],
      price_tier: 'mid',
      price: 42,
      currency: 'USD',
    },
    {
      product_id: 'high_1',
      name: 'Niacinamide High 1',
      brand: 'Brand High',
      ingredient_ids: ['niacinamide'],
      price_tier: 'high',
      price: 88,
      currency: 'USD',
    },
    {
      product_id: 'low_1',
      name: 'Niacinamide Low 1',
      brand: 'Brand Low',
      ingredient_ids: ['niacinamide'],
      price_tier: 'low',
      price: 16,
      currency: 'USD',
    },
    {
      product_id: 'retinol_mid',
      name: 'Retinol Mid',
      ingredient_ids: ['retinol'],
      price_tier: 'mid',
      price: 55,
      currency: 'USD',
    },
  ]);

  try {
    const plan = buildIngredientPlanV2({
      plan: {
        intensity: 'active',
        targets: [
          { ingredient_id: 'niacinamide', priority: 90, confidence: { rationale: ['rule_a'] } },
          { ingredient_id: 'nicotinamide', priority: 75, confidence: { rationale: ['rule_b'] } },
          { ingredient_id: 'retinol', priority: 88, confidence: { rationale: ['rule_retinol'] } },
        ],
        avoid: [{ ingredient_id: 'retinol', severity: 'avoid', reason: ['avoid for tolerance'] }],
        conflicts: [],
      },
      profile: { budgetTier: 'mid' },
      catalogPath: file,
    });

    assert.ok(plan);
    assert.equal(plan.schema_version, 'aurora.ingredient_plan.v2');
    assert.equal(plan.intensity.level, 'active');

    const targetIds = plan.targets.map((item) => item.ingredient_id);
    assert.equal(targetIds.includes('niacinamide'), true);
    assert.equal(targetIds.includes('retinol'), false);
    assert.equal(targetIds.filter((id) => id === 'niacinamide').length, 1);

    const niacinamide = plan.targets.find((item) => item.ingredient_id === 'niacinamide');
    assert.ok(niacinamide);
    assert.equal(Array.isArray(niacinamide.products.competitors), true);
    assert.equal(Array.isArray(niacinamide.products.dupes), true);
    assert.equal(niacinamide.products.competitors.length, 2);
    assert.equal(niacinamide.products.dupes.length, 1);
    assert.equal(niacinamide.products.competitors[0].price_tier, 'mid');
    assert.equal(niacinamide.products.dupes[0].source_block, 'dupe');

    const avoidIds = plan.avoid.map((item) => item.ingredient_id);
    assert.equal(avoidIds.includes('retinol'), true);
    assert.equal(
      plan.conflicts.some((item) => String(item.description || '').toLowerCase().includes('deprioritized')),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingredient_plan_v2 diversifies tiers when budget is unknown', () => {
  const { dir, file } = createTempCatalog([
    {
      product_id: 'low_niacinamide',
      name: 'Low Niacinamide',
      ingredient_ids: ['niacinamide'],
      price_tier: 'low',
      price: 12,
      currency: 'USD',
    },
    {
      product_id: 'mid_niacinamide',
      name: 'Mid Niacinamide',
      ingredient_ids: ['niacinamide'],
      price_tier: 'mid',
      price: 38,
      currency: 'USD',
    },
    {
      product_id: 'high_niacinamide',
      name: 'High Niacinamide',
      ingredient_ids: ['niacinamide'],
      price_tier: 'high',
      price: 84,
      currency: 'USD',
    },
  ]);

  try {
    const plan = buildIngredientPlanV2({
      plan: {
        intensity: 'balanced',
        targets: [{ ingredient_id: 'niacinamide', priority: 82 }],
        avoid: [],
        conflicts: [],
      },
      profile: {},
      catalogPath: file,
    });

    assert.ok(plan);
    assert.equal(plan.budget_context.effective_tier, 'unknown');
    assert.equal(plan.budget_context.diversified_when_unknown, true);

    const target = plan.targets[0];
    assert.ok(target);
    assert.equal(target.products.dupes[0].price_tier, 'low');
    const competitorTiers = target.products.competitors.map((item) => item.price_tier);
    assert.equal(competitorTiers.includes('mid') || competitorTiers.includes('high'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ingredient_plan_v2 consumes realtime external candidates when provided', () => {
  const { dir, file } = createTempCatalog([]);
  try {
    const plan = buildIngredientPlanV2({
      plan: {
        intensity: 'balanced',
        targets: [{ ingredient_id: 'azelaic_acid', priority: 86 }],
        avoid: [],
        conflicts: [],
      },
      profile: { budgetTier: 'mid' },
      catalogPath: file,
      externalCandidatesByIngredient: {
        azelaic_acid: [
          {
            product_id: 'amz_az_1',
            name: 'Azelaic Serum 10%',
            brand: 'Test Brand',
            price: 24.99,
            currency: 'USD',
            price_tier: 'mid',
            source: 'amazon',
            source_confidence: 0.78,
            rating_value: 4.5,
            rating_count: 1280,
            pdp_url: 'https://www.amazon.com/dp/B00TEST001',
            thumb_url: 'https://images.example.com/azelaic.jpg',
            fallback_type: 'external',
            open_target: 'external',
          },
        ],
      },
      externalMetaByIngredient: {
        azelaic_acid: {
          query: 'azelaic acid skincare mid range',
          normalized_query: 'azelaic_acid_skincare_mid_range',
          capture_mode: 'sync_external_executor',
          status: 'external_executor_returned',
        },
      },
    });

    assert.ok(plan);
    const target = plan.targets.find((item) => item.ingredient_id === 'azelaic_acid');
    assert.ok(target);
    const merged = [...target.products.competitors, ...target.products.dupes];
    assert.equal(merged.some((item) => item.product_id === 'amz_az_1'), true);
    assert.equal(merged.some((item) => item.source === 'amazon'), true);
    assert.equal(plan.external_fallback_used, true);
    assert.equal(Array.isArray(plan.__missing_catalog_queries), true);
    assert.equal(plan.__missing_catalog_queries.length >= 1, true);
    assert.equal(plan.__missing_catalog_queries[0].capture_mode, 'sync_external_executor');
    assert.equal(plan.__missing_catalog_queries[0].status, 'external_executor_returned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
