const {
  createIngredientRecoContextRuntime,
} = require('../src/auroraBff/ingredientRecoContextRuntime');

function pickFirstTrimmed(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeIngredientGoalToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'brightening' || token === 'acne' || token === 'barrier') return token;
  return '';
}

function normalizeIngredientSensitivityToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'sensitive' || token === 'reactive') return token;
  return 'unknown';
}

function normalizeIngredientCandidateList(raw, max = 6) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[、,;|/]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function extractActionDataObject(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  return action.data && typeof action.data === 'object' && !Array.isArray(action.data)
    ? action.data
    : null;
}

function buildRuntime() {
  return createIngredientRecoContextRuntime({
    pickFirstTrimmed,
    normalizeIngredientGoalToken,
    normalizeIngredientSensitivityToken,
    normalizeIngredientCandidateList,
    extractActionDataObject,
  });
}

describe('createIngredientRecoContextRuntime', () => {
  test('normalizeIngredientRecoContextValue canonicalizes query, goal, candidates, and metadata', () => {
    const runtime = buildRuntime();

    const out = runtime.normalizeIngredientRecoContextValue({
      ingredient_query: '  niacinamide serum  ',
      ingredient_goal: 'Brightening',
      ingredientSensitivity: 'Sensitive',
      ingredient_candidates: ['Niacinamide', 'Tranexamic Acid', 'Niacinamide'],
      product_candidates: [{ id: 'p1' }, { id: 'p2' }, null],
      trigger_source: ' ingredient_entry ',
      updatedAtMs: 1234.9,
    });

    expect(out).toEqual({
      query: 'niacinamide serum',
      goal: 'brightening',
      candidates: ['Niacinamide', 'Tranexamic Acid'],
      ingredient_candidates: ['Niacinamide', 'Tranexamic Acid'],
      product_candidates: [{ id: 'p1' }, { id: 'p2' }],
      sensitivity: 'sensitive',
      source: 'ingredient_entry',
      updated_at_ms: 1234,
    });
  });

  test('mergeIngredientRecoContextValue preserves newest metadata and merged candidates', () => {
    const runtime = buildRuntime();

    const out = runtime.mergeIngredientRecoContextValue(
      {
        query: 'niacinamide',
        goal: 'brightening',
        candidates: ['Niacinamide', 'Tranexamic Acid'],
        ingredient_candidates: ['Niacinamide', 'Tranexamic Acid'],
        product_candidates: [{ id: 'p_old' }],
        sensitivity: 'unknown',
        source: 'text',
        updated_at_ms: 100,
      },
      {
        ingredientQuery: 'azelaic acid',
        ingredientGoal: 'acne',
        ingredientCandidates: ['Azelaic Acid', 'Niacinamide'],
        productCandidates: [{ id: 'p_new' }],
        ingredientSensitivity: 'reactive',
        route_source: 'chip',
        updatedAtMs: 200,
      },
    );

    expect(out).toEqual({
      query: 'azelaic acid',
      goal: 'acne',
      candidates: ['Niacinamide', 'Tranexamic Acid', 'Azelaic Acid'],
      ingredient_candidates: ['Niacinamide', 'Tranexamic Acid', 'Azelaic Acid'],
      product_candidates: [{ id: 'p_new' }, { id: 'p_old' }],
      sensitivity: 'reactive',
      source: 'chip',
      updated_at_ms: 200,
    });
  });

  test('extractIngredientRecoContext reads action data and returns null when empty', () => {
    const runtime = buildRuntime();

    expect(
      runtime.extractIngredientRecoContext({
        data: {
          ingredient_goal: 'barrier',
          ingredient_sensitivity: 'Sensitive',
          ingredient_candidates: ['Ceramide', 'Cholesterol', 'Ceramide'],
        },
      }),
    ).toEqual({
      goal: 'barrier',
      sensitivity: 'sensitive',
      candidates: ['Ceramide', 'Cholesterol'],
    });

    expect(runtime.extractIngredientRecoContext({ data: {} })).toBeNull();
  });
});
