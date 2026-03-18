const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AURORA_BFF_USE_MOCK = 'true';
process.env.AURORA_DECISION_BASE_URL = '';
process.env.AURORA_ANALYSIS_LIGHTWEIGHT_INGREDIENT_PLAN_GUARDRAIL_ON_DEGRADED = 'true';

function loadRouteInternals() {
  const moduleId = require.resolve('../src/auroraBff/routes');
  delete require.cache[moduleId];
  const { __internal } = require('../src/auroraBff/routes');
  return { moduleId, __internal };
}

test('applyProductIntelGuardrailsToEnvelope uses lightweight ingredient-plan guardrail after degraded report stage', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.applyProductIntelGuardrailsToEnvelope({
      envelope: {
        cards: [
          {
            card_id: 'plan_1',
            type: 'ingredient_plan_v2',
            payload: {
              schema_version: 'aurora.ingredient_plan.v2',
              targets: [
                {
                  ingredient: 'ceramide',
                  products: {
                    competitors: [
                      {
                        title: 'Barrier Repair Cream',
                        brand: 'Test Brand',
                        category: 'moisturizer',
                        product_type: 'moisturizer',
                        product_url: 'https://example.com/products/barrier-repair-cream',
                        open_url: 'https://example.com/products/barrier-repair-cream',
                        url: 'https://example.com/products/barrier-repair-cream',
                      },
                    ],
                    dupes: [],
                  },
                },
              ],
            },
          },
        ],
        analysis_meta: {
          analysis_mode: 'analysis_summary',
          report_stage_outcome: 'budget_timeout',
          stage_timings_ms: {
            report: 3500,
          },
          slowest_stage: 'report',
          slowest_stage_ms: 3500,
          slowest_stage_status: 'timeout',
        },
      },
      ctx: {
        request_id: 'req_guardrail',
        trace_id: 'trace_guardrail',
      },
      profile: null,
      language: 'EN',
    });

    const envelope = out && out.envelope ? out.envelope : null;
    assert.ok(envelope && envelope.analysis_meta);
    assert.equal(envelope.analysis_meta.guardrail_stage_mode, 'lightweight');
    assert.equal(envelope.analysis_meta.guardrail_stage_reduced, true);
    assert.equal(Number.isFinite(Number(envelope.analysis_meta.guardrail_stage_elapsed_ms)), true);
    assert.equal(Number(envelope.analysis_meta.stage_timings_ms.guardrail) >= 0, true);

    const planCard = Array.isArray(envelope.cards)
      ? envelope.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    assert.ok(Array.isArray(planCard.field_missing));
    assert.equal(
      planCard.field_missing.some(
        (row) =>
          row &&
          row.field === 'payload.targets[].products' &&
          row.reason === 'lightweight_guardrail',
      ),
      true,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('resolveAnalysisStoryForcedSkipReason skips story LLM on routine-only summary fast path', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(
      __internal.resolveAnalysisStoryForcedSkipReason({
        report_stage_outcome: 'skipped_policy',
        report_stage_budget_profile: 'routine_only',
      }),
      'routine_summary_fast_path_skip_story_llm',
    );
    assert.equal(
      __internal.resolveAnalysisStoryForcedSkipReason({
        report_stage_outcome: 'skipped_policy',
        report_stage_budget_profile: 'default',
      }),
      null,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyProductIntelGuardrailsToEnvelope uses lightweight guardrail on routine-only summary fast path', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.applyProductIntelGuardrailsToEnvelope({
      envelope: {
        cards: [
          {
            card_id: 'plan_2',
            type: 'ingredient_plan_v2',
            payload: {
              schema_version: 'aurora.ingredient_plan.v2',
              targets: [
                {
                  ingredient: 'niacinamide',
                  products: {
                    competitors: [
                      {
                        title: 'Niacinamide Serum',
                        brand: 'Test Brand',
                        category: 'serum',
                        product_type: 'serum',
                        product_url: 'https://example.com/products/niacinamide-serum',
                        open_url: 'https://example.com/products/niacinamide-serum',
                        url: 'https://example.com/products/niacinamide-serum',
                      },
                    ],
                    dupes: [],
                  },
                },
              ],
            },
          },
        ],
        analysis_meta: {
          analysis_mode: 'analysis_summary',
          report_stage_outcome: 'skipped_policy',
          report_stage_budget_profile: 'routine_only',
        },
      },
      ctx: {
        request_id: 'req_guardrail_fast_path',
        trace_id: 'trace_guardrail_fast_path',
      },
      profile: null,
      language: 'EN',
    });

    const envelope = out && out.envelope ? out.envelope : null;
    assert.ok(envelope && envelope.analysis_meta);
    assert.equal(envelope.analysis_meta.guardrail_stage_mode, 'lightweight');
    assert.equal(envelope.analysis_meta.guardrail_stage_reduced, true);
    assert.equal(Number(envelope.analysis_meta.stage_timings_ms.guardrail) >= 0, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('shouldUseRoutineOnlyAnalysisMemoryFastPath only enables shallow memory load for no-photo routine summary requests', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(
      __internal.shouldUseRoutineOnlyAnalysisMemoryFastPath({
        parsedBody: {
          currentRoutine: {
            schema_version: 'aurora.routine_intake.v1',
            am: [{ step: 'cleanser', product: 'Test Cleanser' }],
          },
        },
        rawBody: {},
        summaryFirstEnabled: true,
      }),
      true,
    );
    assert.equal(
      __internal.shouldUseRoutineOnlyAnalysisMemoryFastPath({
        parsedBody: {
          use_photo: true,
          currentRoutine: {
            schema_version: 'aurora.routine_intake.v1',
            am: [{ step: 'cleanser', product: 'Test Cleanser' }],
          },
        },
        rawBody: {},
        summaryFirstEnabled: true,
      }),
      false,
    );
    assert.equal(
      __internal.shouldUseRoutineOnlyAnalysisMemoryFastPath({
        parsedBody: {
          currentRoutine: {
            schema_version: 'aurora.routine_intake.v1',
            am: [{ step: 'cleanser', product: 'Test Cleanser' }],
          },
          photos: [{ slot_id: 'front', photo_id: 'photo_123', qc_status: 'passed' }],
        },
        rawBody: {},
        summaryFirstEnabled: true,
      }),
      false,
    );
  } finally {
    delete require.cache[moduleId];
  }
});
