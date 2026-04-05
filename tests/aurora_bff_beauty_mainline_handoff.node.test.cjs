const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';

const { resolveRecommendationTargetContext } = require('../src/auroraBff/recommendationSharedStack');

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('deriveBeautyMainlineHandoff keeps explicit sunscreen asks on step-aware sunscreen semantics', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.deriveBeautyMainlineHandoff({
      primaryQuery: 'best sunscreen for oily skin',
      fallbackMessage: 'best sunscreen for oily skin',
      targetContext: resolveRecommendationTargetContext({
        text: 'best sunscreen for oily skin',
        focus: '',
        entryType: 'chat',
      }),
    });

    assert.equal(out.targetContext?.resolved_target_step, 'sunscreen');
    assert.equal(out.targetContext?.primary_role_id, 'daily_sunscreen');
    assert.equal(out.semanticContract?.planner_mode, 'step_aware');
    assert.equal(out.semanticContract?.target_step_family, 'sunscreen');
    assert.equal(out.semanticContract?.primary_role_id, 'daily_sunscreen');
    assert.equal(out.semanticContract?.semantic_family, 'sunscreen');
    assert.deepEqual(out.semanticContract?.ingredient_hypotheses, ['UV filters']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('deriveBeautyMainlineHandoff preserves explicit treatment semantics for oil-control asks', () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = __internal.deriveBeautyMainlineHandoff({
      primaryQuery: 'oil control treatment',
      fallbackMessage: 'oil control treatment',
      targetContext: resolveRecommendationTargetContext({
        text: 'oil control treatment',
        focus: '',
        entryType: 'chat',
      }),
    });

    assert.equal(out.targetContext?.resolved_target_step, 'treatment');
    assert.equal(out.semanticContract?.planner_mode, 'step_aware');
    assert.equal(out.semanticContract?.target_step_family, 'treatment');
    assert.equal(out.semanticContract?.primary_role_id, 'oil_control_treatment');
    assert.equal(out.semanticContract?.semantic_family, 'oil_control');
    assert.deepEqual(out.semanticContract?.ingredient_hypotheses, ['Niacinamide', 'Zinc PCA']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('handoffRecoToBeautyMainlineSearch passes sunscreen-aligned contract to backend search', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    let captured = null;
    const out = await __internal.handoffRecoToBeautyMainlineSearch({
      ctx: { lang: 'EN' },
      primaryQuery: 'best sunscreen for oily skin',
      fallbackMessage: 'best sunscreen for oily skin',
      targetContext: resolveRecommendationTargetContext({
        text: 'best sunscreen for oily skin',
        focus: '',
        entryType: 'chat',
      }),
      timeoutMs: 5000,
      minTimeoutMs: 5000,
      searchFn: async (args) => {
        captured = args;
        return {
          ok: true,
          products: [
            {
              product_id: 'spf_1',
              merchant_id: 'merchant_spf',
              title: 'Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30',
              category: 'Sunscreen',
              product_type: 'sunscreen',
              candidate_step: 'sunscreen',
            },
          ],
          decision_owner: 'shopping_agent_beauty_mainline',
          query_source: 'agent_products_search',
        };
      },
    });

    assert.equal(captured?.query, 'best sunscreen for oily skin');
    assert.equal(captured?.queryStepStrength, 'exact_step');
    assert.equal(captured?.targetStepFamily, 'sunscreen');
    assert.equal(captured?.semanticFamily, 'sunscreen');
    assert.equal(captured?.semanticContract?.planner_mode, 'step_aware');
    assert.equal(captured?.semanticContract?.primary_role_id, 'daily_sunscreen');
    assert.deepEqual(captured?.semanticContract?.ingredient_hypotheses, ['UV filters']);
    assert.deepEqual(
      out.recommendations.map((item) => item.display_name),
      ['Ultra Light Liquid Mineral Sunscreen with Zinc Oxide SPF 30'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});
