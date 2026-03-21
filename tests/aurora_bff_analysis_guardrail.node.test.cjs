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

const CANONICAL_INGREDIENT_QUERY_STAGE_EXPECTATIONS = Object.freeze([
  ['ceramide_np', 'Ceramide NP', ['ceramide barrier moisturizer', 'ceramide moisturizer'], ['barrier repair moisturizer', 'sensitive skin moisturizer']],
  ['panthenol', 'Panthenol (B5)', ['panthenol repair serum', 'provitamin b5 repair serum'], ['barrier repair serum', 'soothing serum']],
  ['niacinamide', 'Niacinamide', ['niacinamide serum', 'vitamin b3 serum'], ['balancing serum', 'daily treatment serum']],
  ['zinc_pca', 'Zinc PCA', ['zinc pca serum', 'zinc serum'], ['balancing serum', 'daily treatment serum']],
  ['salicylic_acid', 'Salicylic acid (BHA)', ['salicylic acid serum', 'bha lotion'], ['blemish treatment serum', 'daily treatment serum']],
  ['azelaic_acid', 'Azelaic acid', ['azelaic acid cream', 'azelaic cream'], ['soothing treatment cream', 'daily treatment cream']],
  ['ascorbic_acid', 'Vitamin C (Ascorbic acid)', ['ascorbic acid serum', 'vitamin c serum'], ['brightening serum', 'daily antioxidant serum']],
  ['retinol', 'Retinol', ['retinol emulsion', 'night retinol emulsion'], ['retinoid night treatment', 'night treatment emulsion']],
  ['benzoyl_peroxide', 'Benzoyl peroxide', ['benzoyl peroxide gel', 'bpo spot gel'], ['blemish spot treatment', 'acne spot treatment']],
  ['sunscreen_filters', 'UV filters', ['broad spectrum sunscreen', 'spf 50 sunscreen'], ['daily face sunscreen']],
  ['glycerin', 'Glycerin', ['glycerin moisturizer', 'glycerine cream'], ['hydrating moisturizer', 'sensitive skin moisturizer']],
  ['hyaluronic_acid', 'Hyaluronic acid', ['hyaluronic acid serum', 'sodium hyaluronate serum'], ['hydrating serum', 'soothing serum']],
]);

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
    assert.equal(envelope.analysis_meta.ingredient_plan_guardrail_mode, 'lightweight');
    assert.equal(envelope.analysis_meta.guardrail_stage_reduced, true);
    assert.equal(Number(envelope.analysis_meta.stage_timings_ms.guardrail) >= 0, true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi keeps lightweight ingredient plan but still recovers deterministic products per target', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const fallbackCalls = [];
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_target_recovery',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'sunscreen_filters',
                ingredient_name: 'UV filters',
                products: {
                  competitors: [],
                  dupes: [],
                },
              },
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                products: {
                  competitors: [],
                  dupes: [],
                },
              },
            ],
            __missing_catalog_queries: [
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                query: 'ceramide barrier moisturizer',
                query_ladder_steps: [{ query: 'barrier repair ceramide moisturizer' }],
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
        allowExternalSeedSupplement: true,
        fallbackCandidateBuilder: async ({ query, externalSeedStrategy }) => {
          fallbackCalls.push({ query, externalSeedStrategy });
          if (!/ceramide/i.test(String(query || ''))) {
            return { ok: true, products: [], reason: 'empty', selected_source: 'none' };
          }
          return {
            ok: true,
            products: [
              {
                product_id: 'ceramide_ext_1',
                merchant_id: 'external_seed',
                name: 'Barrier Relief Moisturizer',
                brand: 'Shield Lab',
                category: 'moisturizer',
                product_type: 'moisturizer',
                pdp_url: 'https://agent.pivota.cc/products/ceramide_ext_1?merchant_id=external_seed',
                product_url: 'https://agent.pivota.cc/products/ceramide_ext_1?merchant_id=external_seed',
                url: 'https://agent.pivota.cc/products/ceramide_ext_1?merchant_id=external_seed',
                source: 'external_seed',
              },
            ],
            selected_source: 'external_seed',
          };
        },
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const targets = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets : [];
    const uvTarget = targets.find((row) => row && row.ingredient_id === 'sunscreen_filters');
    const ceramideTarget = targets.find((row) => row && row.ingredient_id === 'ceramide_np');

    assert.ok(uvTarget);
    assert.ok(ceramideTarget);
    assert.equal(Array.isArray(uvTarget?.products?.competitors), true);
    assert.equal(Array.isArray(ceramideTarget?.products?.competitors), true);
    assert.equal(uvTarget.products.competitors.length, 0);
    assert.equal(ceramideTarget.products.competitors.length, 1);
    assert.equal(ceramideTarget.products.competitors[0].name, 'Barrier Relief Moisturizer');
    assert.equal(out.lookup_meta.ingredient_plan_recovery_used, true);
    assert.equal(out.lookup_meta.ingredient_plan_recovery_recovered >= 1, true);
    assert.equal(
      fallbackCalls.some((row) => /ceramide barrier moisturizer/i.test(String(row.query || ''))),
      true,
    );
    assert.equal(
      fallbackCalls.some((row) => /ceramide moisturizer/i.test(String(row.query || ''))),
      true,
    );
    assert.equal(
      fallbackCalls.some((row) => /prefer moisturizer or barrier serum forms/i.test(String(row.query || ''))),
      false,
    );
    assert.equal(
      fallbackCalls.some(
        (row) =>
          /ceramide barrier moisturizer|ceramide moisturizer/i.test(String(row.query || ''))
          && row.externalSeedStrategy === 'on_empty_only',
      ),
      true,
    );
    assert.equal(
      fallbackCalls.some(
        (row) =>
          /broad spectrum sunscreen|spf 50 sunscreen|daily face sunscreen/i.test(String(row.query || ''))
          && row.externalSeedStrategy === 'supplement_internal_first',
      ),
      true,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi prefers KB and attached-seed ingredient recall before generic search recovery', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const fallbackCalls = [];
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_kb_attached_recall',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                products: { competitors: [], dupes: [] },
              },
              {
                ingredient_id: 'panthenol',
                ingredient_name: 'Panthenol (B5)',
                products: { competitors: [], dupes: [] },
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
        ingredientRecallBuilder: async ({ target }) => {
          if (String(target?.ingredient_id || '') === 'ceramide_np') {
            return {
              products: [
                {
                  product_id: 'rose_ceramide_attached',
                  merchant_id: 'external_seed',
                  name: 'Rose Ceramide Cream',
                  title: 'Rose Ceramide Cream',
                  brand: 'Pixi Beauty',
                  category: 'moisturizer',
                  product_type: 'moisturizer',
                  pdp_url: 'https://shop.example.com/products/rose-ceramide-cream',
                  product_url: 'https://shop.example.com/products/rose-ceramide-cream',
                  url: 'https://shop.example.com/products/rose-ceramide-cream',
                  source: 'external_seed',
                },
              ],
              diagnostics: {
                ingredient_intent_detected: true,
                kb_recall_attempted: true,
                kb_recall_recovered: 1,
                attached_seed_recall_attempted: true,
                attached_seed_recall_recovered: 1,
                recall_source_breakdown: {
                  kb_attached_seed: 1,
                },
              },
            };
          }
          return {
            products: [],
            diagnostics: {
              ingredient_intent_detected: true,
              kb_recall_attempted: true,
              kb_recall_recovered: 0,
              attached_seed_recall_attempted: true,
              attached_seed_recall_recovered: 0,
              recall_source_breakdown: {},
            },
          };
        },
        fallbackCandidateBuilder: async ({ query }) => {
          fallbackCalls.push(String(query || ''));
          if (/panthenol|b5/i.test(String(query || ''))) {
            return {
              ok: true,
              selected_source: 'catalog',
              products: [
                {
                  product_id: 'winona_panthenol_1',
                  merchant_id: 'catalog',
                  name: 'Winona Soothing Repair Serum',
                  brand: 'Winona',
                  category: 'serum',
                  product_type: 'serum',
                  tag_tokens: ['panthenol', 'repair'],
                  pdp_url: 'https://agent.pivota.cc/products/winona_panthenol_1?merchant_id=catalog',
                  url: 'https://agent.pivota.cc/products/winona_panthenol_1?merchant_id=catalog',
                  source: 'catalog',
                },
              ],
            };
          }
          return { ok: true, selected_source: 'none', products: [], reason: 'empty' };
        },
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const targets = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets : [];
    const ceramideTarget = targets.find((row) => row && row.ingredient_id === 'ceramide_np');
    const panthenolTarget = targets.find((row) => row && row.ingredient_id === 'panthenol');

    assert.equal(ceramideTarget?.products?.competitors?.[0]?.name, 'Rose Ceramide Cream');
    assert.equal(panthenolTarget?.products?.competitors?.[0]?.name, 'Winona Soothing Repair Serum');
    assert.equal(
      fallbackCalls.some((query) => /ceramide/i.test(query)),
      false,
    );
    assert.equal(
      fallbackCalls.some((query) => /panthenol|b5/i.test(query)),
      true,
    );
    assert.equal(out.lookup_meta.ingredient_plan_kb_recall_attempted, 2);
    assert.equal(out.lookup_meta.ingredient_plan_kb_recall_recovered, 1);
    assert.equal(out.lookup_meta.ingredient_plan_attached_seed_recall_attempted, 2);
    assert.equal(out.lookup_meta.ingredient_plan_attached_seed_recall_recovered, 1);
    assert.equal(out.lookup_meta.ingredient_plan_generic_search_recovered, 1);
    assert.deepEqual(out.lookup_meta.ingredient_plan_recall_source_breakdown, {
      kb_attached_seed: 1,
    });
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'kb_recall_empty'),
      true,
    );
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'attached_seed_recall_empty'),
      true,
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi refreshes sunscreen target quality even when other ingredient targets are already non-empty', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const recallCalls = [];
    const recallLimits = [];
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_partial_target_refresh',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                products: {
                  competitors: [
                    {
                      name: 'Rose Ceramide Cream',
                      title: 'Rose Ceramide Cream',
                      brand: 'Pixi Beauty',
                      category: 'moisturizer',
                      product_type: 'moisturizer',
                      pdp_url: 'https://shop.example.com/products/rose-ceramide-cream',
                      product_url: 'https://shop.example.com/products/rose-ceramide-cream',
                      url: 'https://shop.example.com/products/rose-ceramide-cream',
                    },
                  ],
                  dupes: [],
                },
              },
              {
                ingredient_id: 'sunscreen_filters',
                ingredient_name: 'UV filters',
                products: {
                  competitors: [
                    {
                      name: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 2',
                      title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 2',
                      brand: 'Fenty Skin',
                      category: 'sunscreen',
                      product_type: 'sunscreen',
                      pdp_url: 'https://shop.example.com/products/hydra-vizor-huez-2',
                      product_url: 'https://shop.example.com/products/hydra-vizor-huez-2',
                      url: 'https://shop.example.com/products/hydra-vizor-huez-2',
                    },
                    {
                      name: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 3',
                      title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 3',
                      brand: 'Fenty Skin',
                      category: 'sunscreen',
                      product_type: 'sunscreen',
                      pdp_url: 'https://shop.example.com/products/hydra-vizor-huez-3',
                      product_url: 'https://shop.example.com/products/hydra-vizor-huez-3',
                      url: 'https://shop.example.com/products/hydra-vizor-huez-3',
                    },
                  ],
                  dupes: [],
                },
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
        ingredientRecallBuilder: async ({ target, limit }) => {
          const ingredientId = String(target?.ingredient_id || '');
          recallCalls.push(ingredientId);
          recallLimits.push(Number(limit || 0));
          if (ingredientId !== 'sunscreen_filters') {
            return {
              products: [],
              diagnostics: {
                ingredient_intent_detected: true,
                kb_recall_attempted: true,
                kb_recall_recovered: 0,
                attached_seed_recall_attempted: true,
                attached_seed_recall_recovered: 0,
                recall_source_breakdown: {},
              },
            };
          }
          return {
            products: [
              {
                product_id: 'spf_shield',
                merchant_id: 'external_seed',
                name: 'On-the-Glow SHIELD SPF 50',
                title: 'On-the-Glow SHIELD SPF 50',
                category: 'sunscreen',
                product_type: 'sunscreen',
                pdp_url: 'https://shop.example.com/products/spf-shield',
                product_url: 'https://shop.example.com/products/spf-shield',
                url: 'https://shop.example.com/products/spf-shield',
              },
              {
                product_id: 'spf_hydra_base',
                merchant_id: 'external_seed',
                name: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
                title: 'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
                category: 'sunscreen',
                product_type: 'sunscreen',
                pdp_url: 'https://shop.example.com/products/hydra-vizor',
                product_url: 'https://shop.example.com/products/hydra-vizor',
                url: 'https://shop.example.com/products/hydra-vizor',
              },
              {
                product_id: 'spf_hydra_tint_1',
                merchant_id: 'external_seed',
                name: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 1',
                title: 'Hydra Vizor Huez Tinted Moisturizer Broad Spectrum Mineral SPF 30 Sunscreen Refill — 1',
                category: 'sunscreen',
                product_type: 'sunscreen',
                pdp_url: 'https://shop.example.com/products/hydra-vizor-huez-1',
                product_url: 'https://shop.example.com/products/hydra-vizor-huez-1',
                url: 'https://shop.example.com/products/hydra-vizor-huez-1',
              },
            ],
            diagnostics: {
              ingredient_intent_detected: true,
              kb_recall_attempted: true,
              kb_recall_recovered: 1,
              attached_seed_recall_attempted: true,
              attached_seed_recall_recovered: 1,
              recall_source_breakdown: {
                kb_attached_seed: 3,
              },
            },
          };
        },
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const targets = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets : [];
    const ceramideTarget = targets.find((row) => row && row.ingredient_id === 'ceramide_np');
    const sunscreenTarget = targets.find((row) => row && row.ingredient_id === 'sunscreen_filters');
    assert.deepEqual(recallCalls, ['sunscreen_filters']);
    assert.equal(recallLimits[0] >= 6, true);
    assert.equal(ceramideTarget?.products?.competitors?.[0]?.name, 'Rose Ceramide Cream');
    assert.deepEqual(
      new Set((sunscreenTarget?.products?.competitors || []).map((row) => row && row.name)),
      new Set([
        'On-the-Glow SHIELD SPF 50',
        'Hydra Vizor Broad Spectrum Mineral SPF 30 Sunscreen Moisturizer',
      ]),
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('collectIngredientPlanFallbackQueriesForTarget deprioritizes low-signal ingredient queries in lightweight mode', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const queries = __internal.collectIngredientPlanFallbackQueriesForTarget({
      payload: {
        __missing_catalog_queries: [
          {
            ingredient_id: 'sunscreen_filters',
            ingredient_name: 'UV filters',
            query: 'UV filters skincare product best',
            target_step_family: 'sunscreen',
            query_ladder_steps: [
              { query: 'broad spectrum sunscreen' },
              { query: 'spf 50 sunscreen' },
            ],
          },
        ],
      },
      target: {
        ingredient_id: 'sunscreen_filters',
        ingredient_name: 'UV filters',
        usage_guidance: [
          'Daily AM final step',
          'Reapply when sun exposure is extended',
        ],
      },
      maxQueries: 2,
      mode: 'lightweight',
    });

    assert.deepEqual(queries, [
      'broad spectrum sunscreen',
      'spf 50 sunscreen',
    ]);
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi strips obvious panthenol cross-family noise from existing target products', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_panthenol_existing_noise',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'panthenol',
                ingredient_name: 'Panthenol (B5)',
                products: {
                  competitors: [
                    {
                      name: '5% B5 Ceramide Barrier Relief Moisturizer',
                      title: '5% B5 Ceramide Barrier Relief Moisturizer',
                      category: 'moisturizer',
                      product_type: 'moisturizer',
                      pdp_url: 'https://shop.example.com/products/b5-ceramide-moisturizer',
                      product_url: 'https://shop.example.com/products/b5-ceramide-moisturizer',
                      url: 'https://shop.example.com/products/b5-ceramide-moisturizer',
                    },
                    {
                      name: 'Lower Lash Mascara',
                      title: 'Lower Lash Mascara',
                      category: 'makeup',
                      product_type: 'mascara',
                      pdp_url: 'https://shop.example.com/products/lower-lash-mascara',
                      product_url: 'https://shop.example.com/products/lower-lash-mascara',
                      url: 'https://shop.example.com/products/lower-lash-mascara',
                    },
                    {
                      name: 'Amino Acids + B5',
                      title: 'Amino Acids + B5',
                      category: 'serum',
                      product_type: 'serum',
                      pdp_url: 'https://shop.example.com/products/amino-acids-b5',
                      product_url: 'https://shop.example.com/products/amino-acids-b5',
                      url: 'https://shop.example.com/products/amino-acids-b5',
                    },
                  ],
                  dupes: [],
                },
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const target = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets[0] : null;
    assert.deepEqual(
      (target?.products?.competitors || []).map((row) => row && row.name),
      ['Amino Acids + B5'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('collectIngredientPlanFallbackQueriesForTarget uses discovery hints when target has no missing-catalog query', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const queries = __internal.collectIngredientPlanFallbackQueriesForTarget({
      payload: {},
      target: {
        ingredient_id: 'panthenol',
        ingredient_name: 'Panthenol (B5)',
        usage_guidance: [
          'AM/PM soothing support',
          'Use after cleansing on damp skin',
        ],
      },
      maxQueries: 2,
      mode: 'lightweight',
    });

    assert.deepEqual(queries, [
      'panthenol repair serum',
      'provitamin b5 repair serum',
    ]);
  } finally {
    delete require.cache[moduleId];
  }
});

test('collectIngredientPlanRecoveryQueryStagesForTarget keeps ceramide exact queries ahead of family fallback', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const queryStages = __internal.collectIngredientPlanRecoveryQueryStagesForTarget({
      payload: {
        __missing_catalog_queries: [
          {
            ingredient_id: 'ceramide_np',
            ingredient_name: 'Ceramide NP',
            query: 'Ceramide NP skincare product best',
            target_step_family: 'moisturizer',
            query_ladder_steps: [
              { query: 'ceramide barrier moisturizer' },
              { query: 'barrier repair ceramide moisturizer' },
            ],
          },
        ],
      },
      target: {
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
        usage_guidance: [
          'AM/PM as barrier support',
          'Prefer moisturizer or barrier serum forms',
        ],
      },
      maxQueries: 2,
      mode: 'lightweight',
    });

    assert.deepEqual(queryStages.ingredientSpecificQueries, [
      'ceramide barrier moisturizer',
      'ceramide moisturizer',
    ]);
    assert.deepEqual(queryStages.familyFallbackQueries, [
      'barrier repair moisturizer',
      'sensitive skin moisturizer',
    ]);
  } finally {
    delete require.cache[moduleId];
  }
});

test('collectIngredientPlanRecoveryQueryStagesForTarget keeps panthenol exact queries ahead of family fallback', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const queryStages = __internal.collectIngredientPlanRecoveryQueryStagesForTarget({
      payload: {},
      target: {
        ingredient_id: 'panthenol',
        ingredient_name: 'Panthenol (B5)',
        usage_guidance: [
          'AM/PM soothing support',
          'Use after cleansing on damp skin',
        ],
      },
      maxQueries: 2,
      mode: 'lightweight',
    });

    assert.deepEqual(queryStages.ingredientSpecificQueries, [
      'panthenol repair serum',
      'provitamin b5 repair serum',
    ]);
    assert.deepEqual(queryStages.familyFallbackQueries, [
      'barrier repair serum',
      'soothing serum',
    ]);
  } finally {
    delete require.cache[moduleId];
  }
});

test('collectIngredientPlanRecoveryQueryStagesForTarget keeps exact -> alias -> family ordering across canonical ingredient set', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    for (const [ingredientId, ingredientName, expectedSpecificQueries, expectedFamilyQueries] of CANONICAL_INGREDIENT_QUERY_STAGE_EXPECTATIONS) {
      const queryStages = __internal.collectIngredientPlanRecoveryQueryStagesForTarget({
        payload: {},
        target: {
          ingredient_id: ingredientId,
          ingredient_name: ingredientName,
          products: { competitors: [], dupes: [] },
        },
        maxQueries: 2,
        mode: 'lightweight',
      });

      assert.deepEqual(
        queryStages.ingredientSpecificQueries,
        expectedSpecificQueries,
        `${ingredientId} specific query stage order changed`,
      );
      assert.deepEqual(
        queryStages.familyFallbackQueries,
        expectedFamilyQueries,
        `${ingredientId} family fallback query stage order changed`,
      );
    }
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi drops low-signal CTA noise once ingredient plan has recovered products', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_cta_cleanup',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                products: {
                  competitors: [],
                  dupes: [],
                },
              },
            ],
            external_search_ctas: [
              {
                title: 'Open search result',
                url: 'https://www.google.com/search?q=Open%20search%20result',
                source: 'catalog_miss',
                reason: 'missing_openable_url_search_fallback',
              },
              {
                title: 'Barrier Relief Moisturizer',
                url: 'https://www.google.com/search?q=Barrier%20Relief%20Moisturizer',
                source: 'kb',
                reason: 'missing_openable_url_search_fallback',
              },
              {
                title: 'Amazon: Ceramide NP',
                url: 'https://www.amazon.com/s?k=Ceramide%20NP%20skincare%20product%20best',
                source: 'amazon',
                reason: 'search_url_demoted',
              },
            ],
            __missing_catalog_queries: [
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                query: 'ceramide barrier moisturizer',
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
        fallbackCandidateBuilder: async ({ query }) => {
          if (!/ceramide/i.test(String(query || ''))) {
            return { ok: true, products: [], reason: 'empty', selected_source: 'none' };
          }
          return {
            ok: true,
            products: [
              {
                product_id: 'ceramide_ext_2',
                merchant_id: 'external_seed',
                name: 'Barrier Repair Gel Cream',
                brand: 'Shield Lab',
                category: 'moisturizer',
                product_type: 'moisturizer',
                pdp_url: 'https://agent.pivota.cc/products/ceramide_ext_2?merchant_id=external_seed',
                product_url: 'https://agent.pivota.cc/products/ceramide_ext_2?merchant_id=external_seed',
                url: 'https://agent.pivota.cc/products/ceramide_ext_2?merchant_id=external_seed',
                source: 'external_seed',
              },
            ],
            external_search_ctas: [
              {
                title: 'Calm Recovery Serum',
                url: 'https://www.google.com/search?q=Calm%20Recovery%20Serum',
                source: 'kb',
                reason: 'missing_openable_url_search_fallback',
              },
            ],
            selected_source: 'external_seed',
          };
        },
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const targets = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets : [];
    assert.equal(targets.length, 1);
    assert.equal(Array.isArray(targets[0]?.products?.competitors), true);
    assert.equal(targets[0].products.competitors.length, 1);
    assert.equal(targets[0].products.competitors[0].name, 'Barrier Repair Gel Cream');

    const externalSearchCtas = Array.isArray(planCard?.payload?.external_search_ctas)
      ? planCard.payload.external_search_ctas
      : [];
    assert.deepEqual(externalSearchCtas, []);
  } finally {
    delete require.cache[moduleId];
  }
});

test('recoverPurchasableProductsFromQueries prefers focused single products over kits and samples', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['UV filters skincare'],
      strictFilter: true,
      fallbackCandidateBuilder: async () => ({
        ok: true,
        selected_source: 'external_seed',
        products: [
          {
            product_id: 'kit_uv_1',
            merchant_id: 'external_seed',
            name: 'Skincare Sampler Kit',
            brand: 'PIXI BEAUTY',
            category: 'external',
            pdp_url: 'https://agent.pivota.cc/products/kit_uv_1?merchant_id=external_seed',
            url: 'https://agent.pivota.cc/products/kit_uv_1?merchant_id=external_seed',
            source: 'external_seed',
          },
          {
            product_id: 'serum_uv_1',
            merchant_id: 'external_seed',
            name: 'UV Filters SPF 45 Serum',
            brand: 'The Ordinary',
            category: 'external',
            pdp_url: 'https://agent.pivota.cc/products/serum_uv_1?merchant_id=external_seed',
            url: 'https://agent.pivota.cc/products/serum_uv_1?merchant_id=external_seed',
            source: 'external_seed',
          },
          {
            product_id: 'mask_uv_1',
            merchant_id: 'external_seed',
            name: 'Masque Effet Peau Neuve (2ml)',
            brand: 'PATYKA',
            category: 'external',
            pdp_url: 'https://agent.pivota.cc/products/mask_uv_1?merchant_id=external_seed',
            url: 'https://agent.pivota.cc/products/mask_uv_1?merchant_id=external_seed',
            source: 'external_seed',
          },
        ],
      }),
      maxProducts: 3,
    });

    assert.deepEqual(
      out.products.map((row) => row.name),
      ['UV Filters SPF 45 Serum'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('recoverPurchasableProductsFromQueries prefers ingredient-explicit products in ingredient_specific mode', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['ceramide barrier moisturizer'],
      strictFilter: true,
      target: {
        ingredient_id: 'ceramide_np',
        ingredient_name: 'Ceramide NP',
      },
      precisionMode: 'ingredient_specific',
      fallbackCandidateBuilder: async () => ({
        ok: true,
        selected_source: 'catalog',
        products: [
          {
            product_id: 'barrier_generic_1',
            merchant_id: 'catalog',
            name: 'Barrier Relief Moisturizer',
            brand: 'Shield Lab',
            category: 'moisturizer',
            product_type: 'moisturizer',
            tag_tokens: ['barrier', 'repair', 'sensitive'],
            pdp_url: 'https://agent.pivota.cc/products/barrier_generic_1?merchant_id=catalog',
            url: 'https://agent.pivota.cc/products/barrier_generic_1?merchant_id=catalog',
            source: 'catalog',
          },
          {
            product_id: 'ceramide_explicit_1',
            merchant_id: 'catalog',
            name: 'Ceramide Barrier Cream',
            brand: 'Barrier Lab',
            category: 'moisturizer',
            product_type: 'moisturizer',
            tag_tokens: ['ceramide', 'barrier', 'repair'],
            pdp_url: 'https://agent.pivota.cc/products/ceramide_explicit_1?merchant_id=catalog',
            url: 'https://agent.pivota.cc/products/ceramide_explicit_1?merchant_id=catalog',
            source: 'catalog',
          },
        ],
      }),
      maxProducts: 2,
    });

    assert.deepEqual(
      out.products.map((row) => row.name),
      ['Ceramide Barrier Cream'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('recoverPurchasableProductsFromQueries allows panthenol query-guided exact recovery when product text lacks alias tokens', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['panthenol repair serum'],
      strictFilter: true,
      fallbackCandidateBuilder: async ({ query }) => {
        assert.equal(query, 'panthenol repair serum');
        return {
          ok: true,
          selected_source: 'catalog',
          products: [
            {
              product_id: 'panthenol_query_guided_1',
              merchant_id: 'catalog',
              name: 'Winona Soothing Repair Serum',
              brand: 'Winona',
              category: 'serum',
              product_type: 'serum',
              tag_tokens: ['repair', 'soothing'],
              pdp_url: 'https://agent.pivota.cc/products/panthenol_query_guided_1?merchant_id=catalog',
              url: 'https://agent.pivota.cc/products/panthenol_query_guided_1?merchant_id=catalog',
              source: 'catalog',
            },
            {
              product_id: 'panthenol_query_guided_2',
              merchant_id: 'catalog',
              name: 'The Ordinary Niacinamide 10% + Zinc 1%',
              brand: 'The Ordinary',
              category: 'serum',
              product_type: 'serum',
              tag_tokens: ['serum'],
              pdp_url: 'https://agent.pivota.cc/products/panthenol_query_guided_2?merchant_id=catalog',
              url: 'https://agent.pivota.cc/products/panthenol_query_guided_2?merchant_id=catalog',
              source: 'catalog',
            },
          ],
        };
      },
      target: {
        ingredient_id: 'panthenol',
        ingredient_name: 'Panthenol (B5)',
      },
      precisionMode: 'ingredient_specific',
      maxProducts: 3,
    });

    assert.deepEqual(
      (out.products || []).map((row) => row && row.name),
      ['Winona Soothing Repair Serum'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('recoverPurchasableProductsFromQueries keeps niacinamide and zinc targets ingredient-specific instead of generic balancing serum matches', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const niacinamideOut = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['niacinamide serum'],
      strictFilter: true,
      target: {
        ingredient_id: 'niacinamide',
        ingredient_name: 'Niacinamide',
      },
      precisionMode: 'ingredient_specific',
      fallbackCandidateBuilder: async () => ({
        ok: true,
        selected_source: 'catalog',
        products: [
          {
            product_id: 'niacinamide_explicit_1',
            merchant_id: 'catalog',
            name: 'Balance Niacinamide Gel',
            brand: 'Aurora Lab',
            category: 'serum',
            product_type: 'serum',
            tag_tokens: ['niacinamide', 'balancing'],
            pdp_url: 'https://agent.pivota.cc/products/niacinamide_explicit_1?merchant_id=catalog',
            url: 'https://agent.pivota.cc/products/niacinamide_explicit_1?merchant_id=catalog',
            source: 'catalog',
          },
          {
            product_id: 'niacinamide_generic_1',
            merchant_id: 'catalog',
            name: 'Balancing Daily Serum',
            brand: 'Calm Lab',
            category: 'serum',
            product_type: 'serum',
            tag_tokens: ['balancing', 'serum'],
            pdp_url: 'https://agent.pivota.cc/products/niacinamide_generic_1?merchant_id=catalog',
            url: 'https://agent.pivota.cc/products/niacinamide_generic_1?merchant_id=catalog',
            source: 'catalog',
          },
        ],
      }),
      maxProducts: 2,
    });
    assert.deepEqual(niacinamideOut.products.map((row) => row.name), ['Balance Niacinamide Gel']);

    const zincOut = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['zinc pca serum'],
      strictFilter: true,
      target: {
        ingredient_id: 'zinc_pca',
        ingredient_name: 'Zinc PCA',
      },
      precisionMode: 'ingredient_specific',
      fallbackCandidateBuilder: async () => ({
        ok: true,
        selected_source: 'catalog',
        products: [
          {
            product_id: 'zinc_explicit_1',
            merchant_id: 'catalog',
            name: 'Oil Control Zinc Serum',
            brand: 'Aurora Lab',
            category: 'serum',
            product_type: 'serum',
            tag_tokens: ['zinc', 'oil control'],
            pdp_url: 'https://agent.pivota.cc/products/zinc_explicit_1?merchant_id=catalog',
            url: 'https://agent.pivota.cc/products/zinc_explicit_1?merchant_id=catalog',
            source: 'catalog',
          },
          {
            product_id: 'zinc_generic_1',
            merchant_id: 'catalog',
            name: 'Balancing Daily Serum',
            brand: 'Calm Lab',
            category: 'serum',
            product_type: 'serum',
            tag_tokens: ['balancing', 'serum'],
            pdp_url: 'https://agent.pivota.cc/products/zinc_generic_1?merchant_id=catalog',
            url: 'https://agent.pivota.cc/products/zinc_generic_1?merchant_id=catalog',
            source: 'catalog',
          },
        ],
      }),
      maxProducts: 2,
    });
    assert.deepEqual(zincOut.products.map((row) => row.name), ['Oil Control Zinc Serum']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('buildPurchasableFallbackCandidates ranks external-seed supplement results before returning them', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.buildPurchasableFallbackCandidates({
      query: 'UV filters skincare',
      allowExternalSeed: true,
      searchFn: async ({ allowExternalSeed }) => {
        if (allowExternalSeed === true) {
          return {
            ok: true,
            products: [
              {
                product_id: 'kit_uv_1',
                merchant_id: 'external_seed',
                name: 'Skincare Sampler Kit',
                brand: 'PIXI BEAUTY',
                category: 'external',
                pdp_url: 'https://agent.pivota.cc/products/kit_uv_1?merchant_id=external_seed',
                url: 'https://agent.pivota.cc/products/kit_uv_1?merchant_id=external_seed',
                source: 'external_seed',
              },
              {
                product_id: 'serum_uv_1',
                merchant_id: 'external_seed',
                name: 'UV Filters SPF 45 Serum',
                brand: 'The Ordinary',
                category: 'external',
                pdp_url: 'https://agent.pivota.cc/products/serum_uv_1?merchant_id=external_seed',
                url: 'https://agent.pivota.cc/products/serum_uv_1?merchant_id=external_seed',
                source: 'external_seed',
              },
            ],
            reason: null,
          };
        }
        return { ok: true, products: [], reason: 'empty' };
      },
    });

    assert.equal(out.selected_source, 'external_seed');
    assert.deepEqual(
      out.products.map((row) => row.name),
      ['UV Filters SPF 45 Serum'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('buildPurchasableFallbackCandidates retries external seed only after internal empty when strategy is on_empty_only', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const calls = [];
    const out = await __internal.buildPurchasableFallbackCandidates({
      query: 'hyaluronic acid serum',
      allowExternalSeed: true,
      externalSeedStrategy: 'on_empty_only',
      searchFn: async ({ allowExternalSeed }) => {
        calls.push(allowExternalSeed === true ? 'external_seed' : 'catalog');
        if (allowExternalSeed === true) {
          return {
            ok: true,
            products: [
              {
                product_id: 'ha_ext_1',
                merchant_id: 'external_seed',
                name: 'Hydra Bounce HA Serum',
                brand: 'Aurora Lab',
                category: 'serum',
                product_type: 'serum',
                pdp_url: 'https://agent.pivota.cc/products/ha_ext_1?merchant_id=external_seed',
                url: 'https://agent.pivota.cc/products/ha_ext_1?merchant_id=external_seed',
                source: 'external_seed',
              },
            ],
            reason: null,
          };
        }
        return { ok: true, products: [], reason: 'empty' };
      },
    });

    assert.deepEqual(calls, ['catalog', 'external_seed']);
    assert.equal(out.selected_source, 'external_seed');
    assert.equal(out.stages.catalog.products.length, 0);
    assert.equal(out.stages.external_seed.products.length, 1);
    assert.deepEqual(out.products.map((row) => row.name), ['Hydra Bounce HA Serum']);
  } finally {
    delete require.cache[moduleId];
  }
});

test('recoverPurchasableProductsFromQueries keeps one best bundle-like product when no better single-product candidate exists', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['barrier repair serum'],
      strictFilter: true,
      fallbackCandidateBuilder: async () => ({
        ok: true,
        selected_source: 'external_seed',
        products: [
          {
            product_id: 'bundle_panthenol_1',
            merchant_id: 'external_seed',
            name: 'Barrier Repair Travel Set',
            brand: 'PIXI BEAUTY',
            category: 'external',
            pdp_url: 'https://agent.pivota.cc/products/bundle_panthenol_1?merchant_id=external_seed',
            url: 'https://agent.pivota.cc/products/bundle_panthenol_1?merchant_id=external_seed',
            source: 'external_seed',
          },
          {
            product_id: 'bundle_panthenol_2',
            merchant_id: 'external_seed',
            name: 'Skincare Sampler Kit',
            brand: 'PIXI BEAUTY',
            category: 'external',
            pdp_url: 'https://agent.pivota.cc/products/bundle_panthenol_2?merchant_id=external_seed',
            url: 'https://agent.pivota.cc/products/bundle_panthenol_2?merchant_id=external_seed',
            source: 'external_seed',
          },
        ],
      }),
      maxProducts: 2,
    });

    assert.equal(out.products.length, 1);
    assert.deepEqual(
      out.products.map((row) => row.name),
      ['Barrier Repair Travel Set'],
    );
  } finally {
    delete require.cache[moduleId];
  }
});

test('recoverPurchasableProductsFromQueries retries once on transient upstream failure and can recover products', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    let calls = 0;
    const out = await __internal.recoverPurchasableProductsFromQueries({
      queries: ['Ceramide NP'],
      strictFilter: true,
      fallbackCandidateBuilder: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            products: [],
            reason: 'upstream_timeout',
            selected_source: 'none',
          };
        }
        return {
          ok: true,
          selected_source: 'external_seed',
          products: [
            {
              product_id: 'ceramide_retry_1',
              merchant_id: 'external_seed',
              name: 'Barrier Relief Moisturizer',
              brand: 'Shield Lab',
              category: 'moisturizer',
              product_type: 'moisturizer',
              pdp_url: 'https://agent.pivota.cc/products/ceramide_retry_1?merchant_id=external_seed',
              url: 'https://agent.pivota.cc/products/ceramide_retry_1?merchant_id=external_seed',
              source: 'external_seed',
            },
          ],
        };
      },
      maxProducts: 2,
    });

    assert.equal(calls, 2);
    assert.equal(out.products.length, 1);
    assert.equal(out.products[0].name, 'Barrier Relief Moisturizer');
    assert.equal(out.transient_retry_attempted, 1);
    assert.equal(out.transient_retry_recovered, 1);
    assert.equal(out.no_result_reason, null);
  } finally {
    delete require.cache[moduleId];
  }
});

test('applyProductIntelGuardrailsToEnvelope surfaces target-level ingredient-plan empties in analysis_meta', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.applyProductIntelGuardrailsToEnvelope({
      envelope: {
        cards: [
          {
            card_id: 'plan_partial_empty_metrics',
            type: 'ingredient_plan_v2',
            payload: {
              schema_version: 'aurora.ingredient_plan.v2',
              targets: [
                {
                  ingredient_id: 'sunscreen_filters',
                  ingredient_name: 'UV filters',
                  products: {
                    competitors: [
                      {
                        title: 'UV Filters SPF 45 Serum',
                        brand: 'Shield Lab',
                        category: 'sunscreen',
                        product_type: 'sunscreen',
                        product_url: 'https://example.com/products/uv-filters-spf-45-serum',
                        open_url: 'https://example.com/products/uv-filters-spf-45-serum',
                        url: 'https://example.com/products/uv-filters-spf-45-serum',
                      },
                    ],
                    dupes: [],
                  },
                },
                {
                  ingredient_id: 'ceramide_np',
                  ingredient_name: 'Ceramide NP',
                  products: {
                    competitors: [],
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
        request_id: 'req_partial_empty_metrics',
        trace_id: 'trace_partial_empty_metrics',
      },
      profile: null,
      language: 'EN',
    });

    const envelope = out && out.envelope ? out.envelope : null;
    assert.ok(envelope && envelope.analysis_meta);
    assert.equal(envelope.analysis_meta.ingredient_plan_target_count, 2);
    assert.equal(envelope.analysis_meta.ingredient_plan_empty_target_count, 1);
    assert.equal(envelope.analysis_meta.ingredient_plan_empty_target_rate, 0.5);
    assert.equal(envelope.analysis_meta.empty_products_rate, 1);
    assert.equal(envelope.analysis_meta.ingredient_plan_products_empty_reason, 'target_level_partial_empty');
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi records ingredient-first precision and family fallback diagnostics', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const fallbackCalls = [];
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_precision_metrics',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'ceramide_np',
                ingredient_name: 'Ceramide NP',
                products: { competitors: [], dupes: [] },
              },
              {
                ingredient_id: 'panthenol',
                ingredient_name: 'Panthenol (B5)',
                products: { competitors: [], dupes: [] },
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
        fallbackCandidateBuilder: async ({ query }) => {
          fallbackCalls.push(String(query || ''));
          if (/ceramide/i.test(String(query || ''))) {
            return {
              ok: true,
              selected_source: 'catalog',
              products: [
                {
                  product_id: 'ceramide_precise_1',
                  merchant_id: 'catalog',
                  name: 'Ceramide Barrier Cream',
                  brand: 'Barrier Lab',
                  category: 'moisturizer',
                  product_type: 'moisturizer',
                  tag_tokens: ['ceramide', 'barrier', 'repair'],
                  pdp_url: 'https://agent.pivota.cc/products/ceramide_precise_1?merchant_id=catalog',
                  url: 'https://agent.pivota.cc/products/ceramide_precise_1?merchant_id=catalog',
                  source: 'catalog',
                },
              ],
            };
          }
          if (/^(soothing serum|hydrating serum|barrier repair serum)$/i.test(String(query || ''))) {
            return {
              ok: true,
              selected_source: 'catalog',
              products: [
                {
                  product_id: 'panthenol_family_1',
                  merchant_id: 'catalog',
                  name: 'Soothing Recovery Serum',
                  brand: 'Calm Lab',
                  category: 'serum',
                  product_type: 'serum',
                  tag_tokens: ['soothing', 'barrier', 'repair'],
                  pdp_url: 'https://agent.pivota.cc/products/panthenol_family_1?merchant_id=catalog',
                  url: 'https://agent.pivota.cc/products/panthenol_family_1?merchant_id=catalog',
                  source: 'catalog',
                },
              ],
            };
          }
          return { ok: true, selected_source: 'none', products: [], reason: 'empty' };
        },
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const targets = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets : [];
    const ceramideTarget = targets.find((row) => row && row.ingredient_id === 'ceramide_np');
    const panthenolTarget = targets.find((row) => row && row.ingredient_id === 'panthenol');
    assert.equal(ceramideTarget?.products?.competitors?.[0]?.name, 'Ceramide Barrier Cream');
    assert.equal(panthenolTarget?.products?.competitors?.[0]?.name, 'Soothing Recovery Serum');
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'ingredient_exact_query_empty'),
      true,
    );
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'ingredient_alias_query_empty'),
      true,
    );
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'ingredient_specific_recovery_empty'),
      true,
    );
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'ingredient_exact_query_empty_external_seed_retry_used'),
      false,
    );
    assert.equal(
      Array.isArray(panthenolTarget?.field_missing) &&
        panthenolTarget.field_missing.some((row) => row && row.reason === 'family_fallback_used'),
      true,
    );
    assert.equal(out.lookup_meta.ingredient_plan_recovery_precision_mode, 'ingredient_first_then_family_fallback');
    assert.equal(out.lookup_meta.ingredient_recovery_query_policy_version, 'exact_alias_family_v1');
    assert.equal(out.lookup_meta.ingredient_plan_exact_match_target_count, 1);
    assert.equal(out.lookup_meta.ingredient_exact_query_zero_target_count, 1);
    assert.equal(out.lookup_meta.ingredient_alias_query_zero_target_count, 1);
    assert.equal(out.lookup_meta.ingredient_external_seed_recovery_target_count, 0);
    assert.equal(out.lookup_meta.ingredient_plan_family_fallback_target_count, 1);
    assert.equal(fallbackCalls.includes('panthenol repair serum'), true);
    assert.equal(fallbackCalls.includes('provitamin b5 repair serum'), true);
    assert.equal(fallbackCalls.includes('soothing serum') || fallbackCalls.includes('hydrating serum'), true);
  } finally {
    delete require.cache[moduleId];
  }
});

test('sanitizeRecoCandidatesForUi records exact-query external seed recovery before family fallback', async () => {
  const { moduleId, __internal } = loadRouteInternals();
  try {
    const out = await __internal.sanitizeRecoCandidatesForUi(
      [
        {
          card_id: 'plan_exact_external_seed_recovery',
          type: 'ingredient_plan_v2',
          payload: {
            schema_version: 'aurora.ingredient_plan.v2',
            targets: [
              {
                ingredient_id: 'hyaluronic_acid',
                ingredient_name: 'Hyaluronic acid',
                products: { competitors: [], dupes: [] },
              },
            ],
          },
        },
      ],
      {
        strictFilter: true,
        ingredientPlanGuardrailMode: 'lightweight',
        allowExternalSeedSupplement: true,
        fallbackCandidateBuilder: ({ query, allowExternalSeed, externalSeedStrategy }) =>
          __internal.buildPurchasableFallbackCandidates({
            query,
            allowExternalSeed,
            externalSeedStrategy,
            searchFn: async ({ allowExternalSeed: stageAllowExternalSeed }) => {
              if (stageAllowExternalSeed === true) {
                return {
                  ok: true,
                  products: [
                    {
                      product_id: 'ha_ext_1',
                      merchant_id: 'external_seed',
                      name: 'Hydra Bounce HA Serum',
                      brand: 'Aurora Lab',
                      category: 'serum',
                      product_type: 'serum',
                      tag_tokens: ['sodium hyaluronate', 'hydrating'],
                      pdp_url: 'https://agent.pivota.cc/products/ha_ext_1?merchant_id=external_seed',
                      url: 'https://agent.pivota.cc/products/ha_ext_1?merchant_id=external_seed',
                      source: 'external_seed',
                    },
                  ],
                  reason: null,
                };
              }
              return {
                ok: true,
                products: [],
                reason: 'empty',
              };
            },
          }),
      },
    );

    const planCard = Array.isArray(out.cards)
      ? out.cards.find((card) => card && card.type === 'ingredient_plan_v2')
      : null;
    assert.ok(planCard);
    const target = Array.isArray(planCard?.payload?.targets) ? planCard.payload.targets[0] : null;
    assert.equal(target?.products?.competitors?.[0]?.name, 'Hydra Bounce HA Serum');
    assert.equal(
      Array.isArray(target?.field_missing) &&
        target.field_missing.some((row) => row && row.reason === 'ingredient_exact_query_empty_external_seed_retry_used'),
      true,
    );
    assert.equal(
      Array.isArray(target?.field_missing) &&
        target.field_missing.some((row) => row && row.reason === 'family_fallback_used'),
      false,
    );
    assert.equal(out.lookup_meta.ingredient_plan_exact_match_target_count, 1);
    assert.equal(out.lookup_meta.ingredient_plan_family_fallback_target_count, 0);
    assert.equal(out.lookup_meta.ingredient_external_seed_recovery_target_count, 1);
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
