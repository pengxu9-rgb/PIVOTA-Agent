const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('buildPersistableLastAnalysisSnapshot merges ingredient plan and routine metadata into one payload', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.buildPersistableLastAnalysisSnapshot({
      analysis: {
        features: [{ observation: 'Barrier is stressed', confidence: 'somewhat_sure' }],
        strategy: 'Keep it gentle.',
      },
      ingredientPlan: {
        targets: [
          { ingredient_id: 'ing_1', ingredient_name: 'Ceramide NP', role: 'repair', priority: 'high' },
          { ingredient_id: 'ing_2', ingredient_name: 'Panthenol', role: 'repair', priority: 'medium' },
        ],
        avoid: [
          { ingredient_id: 'ing_3', ingredient_name: 'Fragrance', severity: 'medium', reason: 'sensitivity' },
        ],
      },
      routineFitCard: {
        payload: {
          overall_fit: 'mixed',
          key_issues: ['retinoid may be too frequent'],
        },
      },
      routineAnalysisV2Result: {
        persist_payload: {
          schema_version: 'aurora.routine_analysis.v2',
          recommendation_groups: [{ id: 'group_1' }],
        },
        legacy_compat: {
          schema_version: 'aurora.routine_analysis.legacy_compat.v1',
        },
      },
    });

    assert.ok(out);
    assert.equal(out.strategy, 'Keep it gentle.');
    assert.deepEqual(out.ingredient_plan, {
      targets: [
        { ingredient_id: 'ing_1', ingredient_name: 'Ceramide NP', role: 'repair', priority: 'high' },
        { ingredient_id: 'ing_2', ingredient_name: 'Panthenol', role: 'repair', priority: 'medium' },
      ],
      avoid: [
        { ingredient_id: 'ing_3', ingredient_name: 'Fragrance', severity: 'medium', reason: 'sensitivity' },
      ],
    });
    assert.deepEqual(out.routine_fit, {
      overall_fit: 'mixed',
      key_issues: ['retinoid may be too frequent'],
    });
    assert.deepEqual(out.routine_analysis_v2, {
      schema_version: 'aurora.routine_analysis.v2',
      recommendation_groups: [{ id: 'group_1' }],
    });
    assert.deepEqual(out.routine_analysis_legacy_compat, {
      schema_version: 'aurora.routine_analysis.legacy_compat.v1',
    });
  } finally {
    delete require.cache[moduleId];
  }
});

test('buildPersistableLastAnalysisSnapshot returns null without base analysis', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(
      __internal.buildPersistableLastAnalysisSnapshot({
        analysis: null,
        ingredientPlan: { targets: [{ ingredient_id: 'ing_1' }] },
      }),
      null,
    );
  } finally {
    delete require.cache[moduleId];
  }
});
