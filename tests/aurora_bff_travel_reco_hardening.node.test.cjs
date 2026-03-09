const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');

const routes = require('../src/auroraBff/routes');

const ROUTES_MODULE_ID = require.resolve('../src/auroraBff/routes');
const TRAVEL_CONTRACTS_MODULE_ID = require.resolve('../src/auroraBff/travelSkills/contracts');

function withEnv(patch, fn) {
  const keys = Object.keys(patch || {});
  const previous = {};
  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    const next = patch[key];
    if (next === undefined || next === null) delete process.env[key];
    else process.env[key] = String(next);
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function loadRoutesFresh() {
  delete require.cache[ROUTES_MODULE_ID];
  return require('../src/auroraBff/routes');
}

function loadTravelContractsFresh() {
  delete require.cache[TRAVEL_CONTRACTS_MODULE_ID];
  return require('../src/auroraBff/travelSkills/contracts');
}

function buildHeaders(uid, suffix = 'travel_reco') {
  return {
    'X-Aurora-UID': uid,
    'X-Trace-ID': `trace_${suffix}_${Date.now()}`,
    'X-Brief-ID': `brief_${suffix}_${Date.now()}`,
    'X-Lang': 'EN',
  };
}

async function seedTravelProfile(app, headers, destination = 'Singapore') {
  const travelPlan = {
    destination,
    start_date: '2026-03-16',
    end_date: '2026-03-20',
  };
  await supertest(app)
    .post('/v1/profile/update')
    .set(headers)
    .send({
      skinType: 'combination',
      sensitivity: 'medium',
      barrierStatus: 'stable',
      goals: ['hydration', 'barrier support'],
      region: 'San Francisco, CA',
      travel_plan: travelPlan,
      travel_plans: [travelPlan],
    })
    .expect(200);
}

function findCard(cards, type) {
  const list = Array.isArray(cards) ? cards : [];
  return list.find((card) => card && card.type === type) || null;
}

function findTravelMainlineCard(cards) {
  return findCard(cards, 'travel') || findCard(cards, 'env_stress');
}

function hasRulesOnlyFallback(cards) {
  return (Array.isArray(cards) ? cards : []).some((card) => {
    if (!card || card.type !== 'confidence_notice') return false;
    const details = Array.isArray(card.payload?.details) ? card.payload.details : [];
    return details.includes('rules_only_structured_fallback');
  });
}

function buildTravelPipelineFixture() {
  const travelReadiness = {
    destination_context: {
      destination: 'Singapore',
      start_date: '2026-03-16',
      end_date: '2026-03-20',
    },
    confidence: {
      score: 0.88,
      level: 'high',
    },
    reco_bundle: [
      { slot: 'sunscreen', label: 'High UV sunscreen' },
      { slot: 'cleanser', label: 'Gentle cleanser' },
    ],
    shopping_preview: {
      categories: ['sunscreen', 'cleanser', 'barrier repair moisturizer'],
      note: 'Focus on sunscreen, cleanser, and barrier support for humid travel.',
    },
  };
  return {
    ok: true,
    assistant_text: 'Singapore next week will be hot and humid. Keep the travel kit on sunscreen, cleanser, and barrier support.',
    env_source: 'travel_skills_fixture',
    degraded: false,
    env_stress_patch: {
      schema_version: 'aurora.ui.env_stress.v1',
      ess: 68,
      epi: 68,
      tier: 'elevated',
      tier_description: 'Humid heat plus UV raises irritation and congestion risk.',
      travel_readiness: travelReadiness,
    },
    travel_readiness: travelReadiness,
    travel_skills_version: 'travel_skills_dag_v1',
    travel_skills_trace: [],
    travel_kb_hit: false,
    travel_kb_write_queued: false,
    travel_skill_invocation_matrix: {
      llm_called: false,
      llm_skip_reason: 'fixture',
      reco_called: true,
      reco_skip_reason: 'preview_only',
      store_called: false,
      store_skip_reason: 'not_requested',
      kb_write_queued: false,
      kb_write_skip_reason: 'fixture',
    },
    travel_followup_state: {
      focus: 'travel_readiness',
      reply_sig: 'travel_ready',
      question_hash: 'fixture_hash',
      updated_at_ms: Date.now(),
    },
    reco_preview: null,
    store_channel: null,
  };
}

test('travel/env quality contract no longer requires routine expert modules', () => {
  const quality = routes.__internal.evaluateQualityContractForEnvelope({
    envelope: {
      cards: [
        {
          type: 'env_stress',
          payload: {
            schema_version: 'aurora.ui.env_stress.v1',
            travel_readiness: {
              destination_context: {
                destination: 'Singapore',
                start_date: '2026-03-16',
                end_date: '2026-03-20',
              },
            },
          },
        },
      ],
    },
    policyMeta: {
      intent_canonical: 'travel_planning',
    },
    assistantText: 'Travel environment guidance ready.',
    profile: {
      travel_plan: {
        destination: 'Singapore',
        start_date: '2026-03-16',
        end_date: '2026-03-20',
      },
    },
  });

  assert.equal(quality.contract_pass, true);
  assert.equal(quality.stall_hit, false);
  assert.equal(quality.critical_fail_reasons.includes('module_fail'), false);
});

test('travel reco handoff keeps only travel-relevant skincare products', async () => {
  const result = await routes.__internal.sanitizeRecoCandidatesForUi(
    [
      {
        type: 'recommendations',
        payload: {
          recommendation_meta: {
            task_mode: 'travel_readiness_products',
            trigger_source: 'travel_handoff',
            handoff_source: 'travel_readiness',
          },
          recommendations: [
            {
              slot: 'other',
              category: 'sunscreen',
              name: 'Light Gel Sunscreen SPF50',
              url: 'https://example.com/products/sunscreen',
              pdp_url: 'https://example.com/products/sunscreen',
              sku: {
                product_id: 'sku_travel_1',
                merchant_id: 'm_demo',
                name: 'Light Gel Sunscreen SPF50',
                category: 'sunscreen',
                url: 'https://example.com/products/sunscreen',
                pdp_url: 'https://example.com/products/sunscreen',
              },
            },
            {
              slot: 'other',
              category: 'makeup brush',
              name: 'Small Eyeshadow Brush',
              url: 'https://example.com/products/brush',
              pdp_url: 'https://example.com/products/brush',
              sku: {
                product_id: 'sku_bad_1',
                merchant_id: 'm_demo',
                name: 'Small Eyeshadow Brush',
                category: 'makeup brush',
                url: 'https://example.com/products/brush',
                pdp_url: 'https://example.com/products/brush',
              },
            },
          ],
        },
      },
    ],
    {
      strictFilter: false,
      qaMode: 'off',
      allowOpenAiFallback: false,
    },
  );

  const recoCard = Array.isArray(result.cards) ? result.cards[0] : null;
  const recs = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
  assert.equal(recs.length, 1);
  assert.match(String(recs[0]?.name || recs[0]?.sku?.name || ''), /sunscreen/i);
  assert.equal(JSON.stringify(recs).toLowerCase().includes('brush'), false);
});

test('raw PDP-shaped reco rows are repaired before reaching the UI contract', async () => {
  const result = await routes.__internal.sanitizeRecoCandidatesForUi(
    [
      {
        type: 'recommendations',
        payload: {
          recommendations: [
            {
              status: 'success',
              pdp_version: '2.0',
              subject: {
                type: 'product',
                id: 'ext_reco_1',
                canonical_product_ref: {
                  merchant_id: 'external_seed',
                  product_id: 'ext_reco_1',
                },
              },
              modules: [
                {
                  type: 'canonical',
                  data: {
                    canonical_product_ref: {
                      merchant_id: 'external_seed',
                      product_id: 'ext_reco_1',
                    },
                    pdp_payload: {
                      product: {
                        product_id: 'ext_reco_1',
                        merchant_id: 'external_seed',
                        title: 'Barrier Repair Cream',
                        brand: { name: 'Aurora Lab' },
                        category_path: ['Skincare', 'Moisturizer'],
                        url: 'https://example.com/products/barrier-repair-cream',
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    {
      strictFilter: false,
      qaMode: 'off',
      allowOpenAiFallback: false,
    },
  );

  const recoCard = Array.isArray(result.cards) ? result.cards[0] : null;
  const recs = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
  assert.equal(recs.length, 1);
  assert.equal(String(recs[0]?.name || recs[0]?.display_name || recs[0]?.sku?.name || ''), 'Barrier Repair Cream');
  assert.equal(JSON.stringify(recs[0]).includes('"pdp_version"'), false);
  assert.equal(JSON.stringify(recs[0]).includes('"subject"'), false);
});

test('reco ui coercion keeps why-candidate reasons user-visible', () => {
  const coerced = routes.__internal.coerceRecoItemForUi(
    {
      brand: 'Aurora Lab',
      name: 'Barrier Repair Cream',
      category: 'moisturizer',
      why_candidate: {
        summary: 'Barrier support helps offset humid travel and indoor A/C.',
        reasons_user_visible: [
          'Useful when skin swings between outdoor heat and indoor dryness.',
        ],
      },
      compare_highlights: [
        'Lighter gel-cream texture is easier to tolerate in humidity.',
      ],
    },
    { lang: 'EN' },
  );

  assert.ok(Array.isArray(coerced?.notes));
  assert.equal(coerced.notes.some((line) => /humid travel/i.test(String(line))), true);
  assert.equal(coerced.notes.some((line) => /indoor dryness/i.test(String(line))), true);
  assert.equal(coerced.notes.some((line) => /gel-cream texture/i.test(String(line))), true);
});

test('/v1/chat: singapore next-week travel turn stays on mainline without rules-only fallback', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
    },
    async () => {
      const contracts = loadTravelContractsFresh();
      const originalRunTravelPipeline = contracts.runTravelPipeline;
      contracts.runTravelPipeline = async () => buildTravelPipelineFixture();

      try {
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = buildHeaders(`uid_singapore_${Date.now()}`, 'singapore');
        await seedTravelProfile(app, headers, 'Singapore');

        const resp = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            message: 'I am going to Singapore next week. What should I prepare for my skin?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const cards = Array.isArray(resp.body?.cards) ? resp.body.cards : [];
        assert.ok(findTravelMainlineCard(cards));
        assert.equal(hasRulesOnlyFallback(cards), false);
        assert.equal(JSON.stringify(resp.body).includes('rules_only_structured_fallback'), false);
        assert.equal(Boolean(resp.body?.session_patch?.last_travel_readiness), true);
      } finally {
        contracts.runTravelPipeline = originalRunTravelPipeline;
        delete require.cache[ROUTES_MODULE_ID];
        delete require.cache[TRAVEL_CONTRACTS_MODULE_ID];
      }
    },
  );
});

test('/v1/chat: travel handoff returns travel-aware recommendations and strips malformed/raw rows', async () => {
  await withEnv(
    {
      AURORA_QA_PLANNER_V1_ENABLED: 'true',
      AURORA_TRAVEL_WEATHER_LIVE_ENABLED: 'false',
      AURORA_CHAT_RESPONSE_META_ENABLED: 'true',
      AURORA_BFF_RETENTION_DAYS: '0',
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
    },
    async () => {
      const contracts = loadTravelContractsFresh();
      const originalRunTravelPipeline = contracts.runTravelPipeline;
      const originalBuildRecoPreview = contracts.__internal.buildRecoPreview;
      let capturedTravelRecoArgs = null;

      contracts.runTravelPipeline = async () => buildTravelPipelineFixture();
      contracts.__internal.buildRecoPreview = ({ travelReadiness, profile, language }) => {
        capturedTravelRecoArgs = { travelReadiness, profile, language };
        return {
          source: 'travel_reco_fixture',
          confidence: { score: 0.84, level: 'high', rationale: ['travel_fixture'] },
          recommendations: [
            {
              status: 'success',
              pdp_version: '2.0',
              subject: {
                type: 'product',
                id: 'ext_barrier_1',
                canonical_product_ref: {
                  merchant_id: 'external_seed',
                  product_id: 'ext_barrier_1',
                },
              },
              modules: [
                {
                  type: 'canonical',
                  data: {
                    canonical_product_ref: {
                      merchant_id: 'external_seed',
                      product_id: 'ext_barrier_1',
                    },
                    pdp_payload: {
                      product: {
                        product_id: 'ext_barrier_1',
                        merchant_id: 'external_seed',
                        title: 'Barrier Repair Cream',
                        brand: { name: 'Aurora Lab' },
                        category_path: ['Skincare', 'Moisturizer'],
                        url: 'https://example.com/products/barrier-repair-cream',
                      },
                    },
                  },
                },
              ],
            },
            {
              slot: 'protect',
              category: 'sunscreen',
              name: 'Light Gel Sunscreen SPF50',
              url: 'https://example.com/products/light-gel-sunscreen',
              pdp_url: 'https://example.com/products/light-gel-sunscreen',
              sku: {
                product_id: 'sku_spf_1',
                merchant_id: 'm_demo',
                name: 'Light Gel Sunscreen SPF50',
                category: 'sunscreen',
                url: 'https://example.com/products/light-gel-sunscreen',
                pdp_url: 'https://example.com/products/light-gel-sunscreen',
              },
            },
            {
              slot: 'other',
              category: 'makeup brush',
              name: 'Small Eyeshadow Brush',
              url: 'https://example.com/products/brush',
              pdp_url: 'https://example.com/products/brush',
              sku: {
                product_id: 'sku_bad_1',
                merchant_id: 'm_demo',
                name: 'Small Eyeshadow Brush',
                category: 'makeup brush',
                url: 'https://example.com/products/brush',
                pdp_url: 'https://example.com/products/brush',
              },
            },
          ],
        };
      };

      try {
        const { mountAuroraBffRoutes } = loadRoutesFresh();
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        mountAuroraBffRoutes(app, { logger: null });

        const headers = buildHeaders(`uid_travel_handoff_${Date.now()}`, 'travel_handoff');
        await seedTravelProfile(app, headers, 'Singapore');

        const travelResp = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            message: 'I am going to Singapore next week. What should I prepare for my skin?',
            session: { state: 'idle' },
            language: 'EN',
          })
          .expect(200);

        const handoffSession = {
          state: 'idle',
          ...(travelResp.body?.session_patch && typeof travelResp.body.session_patch === 'object' ? travelResp.body.session_patch : {}),
        };

        const recoResp = await supertest(app)
          .post('/v1/chat')
          .set(headers)
          .send({
            action: {
              action_id: 'chip.start.reco_products',
              kind: 'chip',
              data: {
                reply_text: 'See full recommendations',
                force_route: 'reco_products',
                trigger_source: 'travel_handoff',
                source_card_type: 'travel',
              },
            },
            session: handoffSession,
            language: 'EN',
          })
          .expect(200);

        const recoCard = findCard(recoResp.body?.cards, 'recommendations');
        const recs = Array.isArray(recoCard?.payload?.recommendations) ? recoCard.payload.recommendations : [];
        const serialized = JSON.stringify(recs).toLowerCase();

        assert.ok(recoCard);
        assert.equal(capturedTravelRecoArgs?.travelReadiness?.destination, 'Singapore');
        assert.equal(recoCard?.payload?.task_mode, 'travel_readiness_products');
        assert.equal(recoCard?.payload?.recommendation_meta?.source_mode, 'travel_handoff');
        assert.equal(recoCard?.payload?.recommendation_meta?.handoff_source, 'travel_readiness');
        assert.equal(Boolean(recoCard?.payload?.metadata?.travel_handoff), true);
        assert.deepEqual(
          recs.map((row) => String(row?.name || row?.display_name || row?.sku?.name || '')).sort(),
          ['Barrier Repair Cream', 'Light Gel Sunscreen SPF50'],
        );
        assert.equal(serialized.includes('brush'), false);
        assert.equal(serialized.includes('"pdp_version"'), false);
        assert.equal(serialized.includes('"subject"'), false);
        assert.equal(hasRulesOnlyFallback(recoResp.body?.cards), false);
      } finally {
        contracts.runTravelPipeline = originalRunTravelPipeline;
        contracts.__internal.buildRecoPreview = originalBuildRecoPreview;
        delete require.cache[ROUTES_MODULE_ID];
        delete require.cache[TRAVEL_CONTRACTS_MODULE_ID];
      }
    },
  );
});
