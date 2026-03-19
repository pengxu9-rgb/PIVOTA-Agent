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

test('resolveAnalysisProfileFastTimeoutMs uses a tighter timeout for guest routine-only fast path without request overlay', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const guestTimeout = __internal.resolveAnalysisProfileFastTimeoutMs({
      identity: { auroraUid: 'guest_timeout_123', userId: null },
      requestProfileOverlayApplied: false,
    });
    const loggedInTimeout = __internal.resolveAnalysisProfileFastTimeoutMs({
      identity: { auroraUid: 'guest_timeout_123', userId: 'user_timeout_123' },
      requestProfileOverlayApplied: false,
    });
    const overlayTimeout = __internal.resolveAnalysisProfileFastTimeoutMs({
      identity: { auroraUid: 'guest_timeout_123', userId: null },
      requestProfileOverlayApplied: true,
    });

    assert.equal(Number.isFinite(guestTimeout), true);
    assert.equal(Number.isFinite(loggedInTimeout), true);
    assert.equal(guestTimeout <= loggedInTimeout, true);
    assert.equal(overlayTimeout, loggedInTimeout);
  } finally {
    delete require.cache[moduleId];
  }
});

test('buildAnalysisResponseTimingMeta computes total, stage sum, and unattributed latency', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  const realNow = Date.now;
  try {
    Date.now = () => 2500;
    assert.deepEqual(
      __internal.buildAnalysisResponseTimingMeta({
        analysisMeta: {
          stage_timings_ms: {
            quality: 200.4,
            artifact: 10.2,
            guardrail: 5.1,
          },
        },
        startedAtMs: 2000,
      }),
      {
        server_total_ms: 500,
        server_stage_sum_ms: 215.7,
        server_unattributed_ms: 284.3,
      },
    );
  } finally {
    Date.now = realNow;
    delete require.cache[moduleId];
  }
});

test('buildAnalysisServerTimingHeader formats server timing metrics for the response header', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const header = __internal.buildAnalysisServerTimingHeader({
      server_total_ms: 500,
      server_stage_sum_ms: 215.7,
      server_unattributed_ms: 284.3,
      stage_timings_ms: {
        quality: 200.4,
        artifact: 10.2,
        guardrail: 5.1,
        report: 0,
      },
    });
    assert.equal(
      header,
      'total;dur=500.0, stages;dur=215.7, unattributed;dur=284.3, quality;dur=200.4, artifact;dur=10.2, guardrail;dur=5.1, report;dur=0.0',
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('shouldUseRoutineOnlyAnalysisArtifactFastPath mirrors routine-only no-photo fast-path gating', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    assert.equal(
      __internal.shouldUseRoutineOnlyAnalysisArtifactFastPath({
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
      __internal.shouldUseRoutineOnlyAnalysisArtifactFastPath({
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
  } finally {
    delete require.cache[moduleId];
  }
});

test('deferDiagnosisArtifactPersistence saves artifact and plan asynchronously with stable ids', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const calls = [];
    assert.equal(
      __internal.deferDiagnosisArtifactPersistence({
        identity: { auroraUid: 'guest_123', userId: 'user_123' },
        sessionId: 'brief_123',
        diagnosisArtifact: {
          artifact_id: 'artifact_123',
          created_at: '2026-03-19T00:00:00.000Z',
          overall_confidence: { score: 0.82, level: 'high' },
        },
        ingredientPlanPayload: {
          intensity: 'balanced',
          targets: [{ ingredient_id: 'ceramide' }],
        },
        ingredientPlanId: 'plan_123',
        saveDiagnosisArtifactFn: async (args) => {
          calls.push({ kind: 'artifact', args });
          return { artifact_id: args.artifactId, artifact_json: args.artifact, created_at: args.artifact.created_at };
        },
        saveIngredientPlanFn: async (args) => {
          calls.push({ kind: 'plan', args });
          return { plan_id: args.planId, artifact_id: args.artifactId, plan_json: args.plan };
        },
      }),
      true,
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, 'artifact');
    assert.equal(calls[0].args.artifactId, 'artifact_123');
    assert.equal(calls[1].kind, 'plan');
    assert.equal(calls[1].args.artifactId, 'artifact_123');
    assert.equal(calls[1].args.planId, 'plan_123');
  } finally {
    delete require.cache[moduleId];
  }
});

test('deferProfilePatchPersistence saves profile patch asynchronously', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const calls = [];
    assert.equal(
      __internal.deferProfilePatchPersistence({
        identity: { auroraUid: 'guest_patch_123', userId: 'user_patch_123' },
        patch: { pregnancy_status: 'not_pregnant' },
        upsertProfileForIdentityFn: async (identity, patch) => {
          calls.push({ identity, patch });
          return { ok: true };
        },
      }),
      true,
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      identity: { auroraUid: 'guest_patch_123', userId: 'user_patch_123' },
      patch: { pregnancy_status: 'not_pregnant' },
    });
  } finally {
    delete require.cache[moduleId];
  }
});
