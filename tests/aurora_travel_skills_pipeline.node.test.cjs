const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT_CONTRACTS = '../src/auroraBff/travelSkills/contracts';
const ROOT_KB_STORE = '../src/auroraBff/travelKbStore';
const ROOT_METRICS = '../src/auroraBff/visionMetrics';
const ROOT_READINESS = '../src/auroraBff/travelReadinessBuilder';
const ROOT_CALIBRATOR = '../src/auroraBff/travelLlmCalibrator';
const ROOT_FINAL_REWRITER = '../src/auroraBff/travelFinalAssistantRewriter';
const ROOT_REPLY_COMPOSER = '../src/auroraBff/travelReplyComposer';
const ROOT_WEATHER = '../src/auroraBff/weatherAdapter';
const ROOT_ALERTS = '../src/auroraBff/travelAlertsProvider';
const ROOT_KB_POLICY = '../src/auroraBff/travelKbPolicy';

function withEnv(patch, fn) {
  const effectivePatch = {
    AURORA_TRAVEL_FINAL_REWRITE_ENABLED: 'false',
    ...(patch || {}),
  };
  const keys = Object.keys(effectivePatch);
  const previous = {};
  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
    const next = effectivePatch[key];
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

function withModuleOverrides(overrides, fn) {
  const restores = [];
  for (const [modulePath, patch] of Object.entries(overrides || {})) {
    // eslint-disable-next-line global-require
    const mod = require(modulePath);
    for (const [name, replacement] of Object.entries(patch || {})) {
      const original = mod[name];
      mod[name] = replacement;
      restores.push(() => {
        mod[name] = original;
      });
    }
  }
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const restore of restores.reverse()) restore();
    });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function withMockFetch(fetchImpl, fn) {
  const previous = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      global.fetch = previous;
    });
}

function loadFreshPipeline() {
  const contractsId = require.resolve(ROOT_CONTRACTS);
  const kbStoreId = require.resolve(ROOT_KB_STORE);
  const finalRewriterId = require.resolve(ROOT_FINAL_REWRITER);
  delete require.cache[contractsId];
  delete require.cache[kbStoreId];
  delete require.cache[finalRewriterId];
  // eslint-disable-next-line global-require
  return require(ROOT_CONTRACTS);
}

function resetTravelMetrics() {
  // eslint-disable-next-line global-require
  const metrics = require(ROOT_METRICS);
  if (typeof metrics.resetVisionMetrics === 'function') metrics.resetVisionMetrics();
}

function snapshotTravelMetrics() {
  // eslint-disable-next-line global-require
  const metrics = require(ROOT_METRICS);
  return typeof metrics.snapshotVisionMetrics === 'function' ? metrics.snapshotVisionMetrics() : {};
}

function buildProfile() {
  return {
    skinType: 'combination',
    sensitivity: 'medium',
    barrierStatus: 'stable',
    goals: ['hydration'],
    region: 'San Francisco, CA',
    travel_plan: {
      destination: 'Tokyo',
      destination_place: {
        label: 'Tokyo, Japan',
        canonical_name: 'Tokyo',
        latitude: 35.6895,
        longitude: 139.69171,
        country_code: 'JP',
        country: 'Japan',
        admin1: 'Tokyo',
        timezone: 'Asia/Tokyo',
        resolution_source: 'auto_resolved',
      },
      start_date: '2026-03-10',
      end_date: '2026-03-15',
    },
  };
}

function buildInput(message, overrides = {}) {
  return {
    message,
    language: 'EN',
    profile: buildProfile(),
    recentLogs: [],
    canonicalIntent: {
      intent: 'travel_planning',
      entities: {
        destination: 'Tokyo',
        date_range: { start: '2026-03-10', end: '2026-03-15' },
      },
    },
    plannerDecision: { next_step: 'answer', required_fields: [], can_answer_now: true },
    chatContext: {},
    travelWeatherLiveEnabled: false,
    openaiClient: null,
    logger: null,
    ...overrides,
  };
}

test('travel skills pipeline: DAG order + trace includes started/ended/duration', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'true',
      TRAVEL_KB_WRITE_CONFIDENCE_MIN: '0',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(buildInput('How humid will Tokyo be next week?'));

      assert.equal(out.ok, true);
      assert.equal(out.travel_skills_version, 'travel_skills_dag_v1');
      assert.equal(Array.isArray(out.travel_skills_trace), true);
      assert.deepEqual(
        out.travel_skills_trace.map((row) => row.skill),
        [
          'travel_intent_profile_skill',
          'travel_kb_read_skill',
          'travel_env_context_skill',
          'travel_readiness_skill',
          'travel_packable_product_authority_skill',
          'travel_local_product_authority_skill',
          'travel_llm_calibration_skill',
          'travel_reco_preview_skill',
          'travel_store_channel_skill',
          'travel_followup_reply_skill',
          'travel_final_reply_rewrite_skill',
          'travel_kb_write_skill',
        ],
      );

      for (const row of out.travel_skills_trace) {
        assert.equal(typeof row.status, 'string');
        assert.equal(Number.isFinite(Number(row.started_at_ms)), true);
        assert.equal(Number.isFinite(Number(row.ended_at_ms)), true);
        assert.equal(Number(row.ended_at_ms) >= Number(row.started_at_ms), true);
        assert.equal(Number.isFinite(Number(row.duration_ms)), true);
        assert.equal(Number(row.duration_ms) >= 0, true);
      }
      const matrix = out.travel_skill_invocation_matrix || {};
      assert.equal(typeof matrix.llm_called, 'boolean');
      assert.equal('llm_skip_reason' in matrix, true);
      assert.equal(typeof matrix.reco_called, 'boolean');
      assert.equal('reco_skip_reason' in matrix, true);
      assert.equal(typeof matrix.packable_product_authority_called, 'boolean');
      assert.equal('packable_product_authority_reason' in matrix, true);
      assert.equal(typeof matrix.store_called, 'boolean');
      assert.equal('store_skip_reason' in matrix, true);
      assert.equal(typeof matrix.final_rewrite_used, 'boolean');
      assert.equal('final_rewrite_reason' in matrix, true);
      assert.equal(typeof matrix.kb_write_queued, 'boolean');
      assert.equal(typeof matrix.kb_write_skip_reason, 'string');
    },
  );
});

test('travel skills pipeline: final rewrite becomes visible prose authority and integrates travel safety', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
      AURORA_TRAVEL_FINAL_REWRITE_ENABLED: 'true',
    },
    async () => {
      const rewrittenText = [
        'Seattle to Shanghai means a warmer, more humid routine window with stronger UV exposure, so keep the plan simple and reapplication-focused.',
        '',
        '- Before departure: pack a gentle cleanser, lightweight moisturizer, and SPF50 so the routine does not change too much mid-trip.',
        '- Flight day: avoid experimenting with new actives; use moisturizer before boarding, and use a hydrating mask only if already tolerated.',
        '- First 48 hours: use SPF every morning and reapply during outdoor transit, then keep evening care calm while jet lag settles.',
        '- Exposed areas: bring body sunscreen for arms, plus lip balm and hand cream because higher UV and cabin dryness do not only affect the face.',
        '- Buying categories in Shanghai: look for sunscreen, a light barrier moisturizer, and a simple hydrating serum if luggage space is tight.',
        '',
        'If you share whether you will be mostly indoors or outdoors between meetings, I can narrow the category priority.',
      ].join('\n');
      const mockGemini = async () => ({
        text: JSON.stringify({ assistant_text: rewrittenText }),
      });

      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput('Business trip skincare planner: Seattle to Shanghai next week.', {
          travelFinalRewriteGeminiGenerateContent: mockGemini,
          profile: {
            skinType: 'combination',
            sensitivity: 'medium',
            barrierStatus: 'stable',
            goals: ['hydration', 'oil control'],
            travel_plan: {
              destination: 'Shanghai',
              departure_region: 'Seattle',
              start_date: '2026-04-20',
              end_date: '2026-04-24',
            },
          },
          canonicalIntent: {
            intent: 'travel_planning',
            entities: {
              destination: 'Shanghai',
              departure_region: 'Seattle',
              date_range: { start: '2026-04-20', end: '2026-04-24' },
            },
          },
          safetyDecision: {
            block_level: 'WARN',
            reasons: ['Retinoids and acids can increase UV sensitivity during a high-UV trip.'],
            safe_alternatives: ['SPF50 sunscreen', 'barrier moisturizer'],
          },
        }),
      );

      assert.equal(out.ok, true);
      assert.equal(out.assistant_final_rewrite_used, true);
      assert.equal(out.assistant_final_rewrite_reason, 'ok');
      assert.equal(out.safety_notice_integrated, true);
      assert.equal(out.assistant_text, rewrittenText);
      assert.equal(/Travel skincare kit:|Adjusted routine guidance:|Risk note:/i.test(out.assistant_text), false);
      assert.equal(out.travel_skill_invocation_matrix?.final_rewrite_used, true);
      const rewriteTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_final_reply_rewrite_skill');
      assert.equal(Boolean(rewriteTrace), true);
      assert.equal(rewriteTrace.status, 'ok');
      assert.equal(rewriteTrace.meta?.used, true);
      assert.equal(rewriteTrace.meta?.reason, 'ok');
    },
  );
});

test('travel skills pipeline: failed final rewrite uses phase-plan brief instead of legacy baseline', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
      AURORA_TRAVEL_FINAL_REWRITE_ENABLED: 'true',
    },
    async () => {
      const mockGemini = async () => ({
        text: JSON.stringify({ assistant_text: 'Tokyo has higher UV. Use sunscreen.' }),
      });
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput('I am traveling to Tokyo next week. Build a phased skincare plan.', {
          travelFinalRewriteGeminiGenerateContent: mockGemini,
        }),
      );

      assert.equal(out.assistant_final_rewrite_used, false);
      assert.match(out.assistant_final_rewrite_reason, /^rewrite_/);
      assert.match(out.assistant_text, /Before you leave|Before departure/i);
      assert.match(out.assistant_text, /On the flight/i);
      assert.match(out.assistant_text, /Local shopping|Shop locally/i);
      assert.equal(/Travel product preview:|Key deltas:|Travel skincare kit:/i.test(out.assistant_text), false);
    },
  );
});

test('travel skills pipeline: destination-present request triggers llm skill with prompt telemetry', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      resetTravelMetrics();
      await withModuleOverrides(
        {
          [ROOT_READINESS]: {
            buildTravelReadiness: () => ({
              destination_context: {
                destination: 'Tokyo',
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
              delta_vs_home: {
                uv: { home: 4, destination: 7, delta: 3, unit: '' },
              },
              forecast_window: [{ date: '2026-03-10' }],
              reco_bundle: [
                {
                  trigger: 'Elevated UV',
                  action: 'Use SPF50+ sunscreen',
                  ingredient_logic: 'Photostable filters',
                  product_types: ['Face SPF50+ sunscreen'],
                  reapply_rule: 'Reapply every 2 hours outdoors.',
                },
              ],
              shopping_preview: {
                products: [
                  {
                    name: 'UV Shield SPF50',
                    brand: 'BrandB',
                    category: 'sun_protection',
                    reasons: ['High UV destination support.'],
                    match_status: 'catalog_verified',
                  },
                ],
                buying_channels: ['pharmacy'],
              },
              adaptive_actions: ['use_spf'],
              alerts: [],
              confidence: { score: 0.95, level: 'high' },
            }),
          },
          [ROOT_WEATHER]: {
            getTravelWeather: async () => ({
              source: 'weather_api',
              reason: 'live_ok',
              summary: { temperature_max_c: 26, humidity_mean: 62 },
              date_range: { start: '2026-03-10', end: '2026-03-15' },
              forecast_window: [{ date: '2026-03-10' }],
            }),
          },
          [ROOT_ALERTS]: {
            getTravelAlerts: async () => ({ source: 'none', reason: 'none', alerts: [] }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(buildInput('Tokyo weather?', { travelWeatherLiveEnabled: true }));
          assert.equal(out.ok, true);

          const llmTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_llm_calibration_skill');
          assert.equal(Boolean(llmTrace), true);
          assert.equal(Boolean(llmTrace.meta?.triggered), true);
          assert.equal(llmTrace.meta?.trigger_reason, 'destination_present');
          assert.equal(llmTrace.meta?.skip_reason, null);
          assert.equal(typeof llmTrace.meta?.outcome, 'string');
          assert.equal(typeof llmTrace.meta?.prompt_hash, 'string');
          assert.equal(llmTrace.meta.prompt_hash.length >= 16, true);
          assert.equal(Number.isFinite(Number(llmTrace.meta?.prompt_chars)), true);
          assert.equal(Number(llmTrace.meta.prompt_chars) > 0, true);
          assert.equal(String(llmTrace.meta.prompt_hash || '').includes('Task: improve the travel_readiness payload'), false);
          assert.ok(Array.isArray(out.travel_readiness?.categorized_kit));
          const sunProtection = out.travel_readiness.categorized_kit.find((item) => item && item.id === 'sun_protection');
          assert.ok(sunProtection);
          assert.ok(Array.isArray(sunProtection.brand_suggestions));
          assert.ok(sunProtection.brand_suggestions.some((item) => item && item.product === 'UV Shield SPF50'));

          const metrics = snapshotTravelMetrics();
          const llmTriggerEntries = Array.isArray(metrics.auroraTravelLlmTrigger) ? metrics.auroraTravelLlmTrigger : [];
          const hasDestinationTrigger = llmTriggerEntries.some(([key]) => String(key).includes('destination_present'));
          assert.equal(hasDestinationTrigger, true);
          const llmEntries = Array.isArray(metrics.auroraTravelLlmCall) ? metrics.auroraTravelLlmCall : [];
          const hasOldSkip = llmEntries.some(([key]) => String(key).includes('skip_conditions_not_matched'));
          assert.equal(hasOldSkip, false);
        },
      );
    },
  );
});

test('travel skills pipeline: readiness throw is degraded (does not crash)', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_READINESS]: {
            buildTravelReadiness: () => {
              throw new Error('readiness_crash');
            },
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(buildInput('Travel plan please.'));
          const readinessTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_readiness_skill');
          assert.equal(Boolean(readinessTrace), true);
          assert.equal(readinessTrace.status, 'degraded');
          assert.equal(typeof out.assistant_text, 'string');
          assert.equal(out.assistant_text.length > 0, true);
        },
      );
    },
  );
});

test('travel skills pipeline: llm throw is degraded (does not crash)', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_CALIBRATOR]: {
            calibrateTravelReadinessWithLlm: async () => {
              throw new Error('llm_timeout');
            },
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(buildInput('Need travel strategy and products.'));
          const llmTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_llm_calibration_skill');
          assert.equal(Boolean(llmTrace), true);
          assert.equal(llmTrace.status, 'degraded');
          assert.equal(typeof out.assistant_text, 'string');
          assert.equal(out.assistant_text.length > 0, true);
        },
      );
    },
  );
});

test('travel skills pipeline: empty compose output falls back to non-empty assistant text', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_REPLY_COMPOSER]: {
            composeTravelReply: () => ({ text: '', text_brief: '' }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(buildInput('Travel plan in brief.'));
          assert.equal(
            out.assistant_text,
            'Here is a practical travel skincare plan based on currently available data.',
          );
        },
      );
    },
  );
});

test('travel skills pipeline: conservative ok gate returns false when core signals are all missing', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_WEATHER]: {
            climateFallback: () => ({
              source: 'climate_fallback',
              reason: 'live_disabled',
              summary: null,
              date_range: null,
              forecast_window: [],
            }),
          },
          [ROOT_READINESS]: {
            buildTravelReadiness: () => ({
              destination_context: { destination: null, start_date: null, end_date: null },
              forecast_window: [],
              adaptive_actions: [],
              alerts: [],
              confidence: { score: 0.95, level: 'high' },
            }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(
            buildInput('Help me.', {
              profile: {},
              canonicalIntent: { intent: 'weather_env', entities: {} },
              travelWeatherLiveEnabled: false,
            }),
          );
          assert.equal(out.ok, false);
          assert.equal(out.quality_reason, 'core_signals_missing');
          const llmTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_llm_calibration_skill');
          const recoTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_reco_preview_skill');
          const storeTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_store_channel_skill');
          assert.equal(llmTrace?.status, 'skip');
          assert.equal(llmTrace?.meta?.skip_reason, 'destination_missing');
          assert.equal(llmTrace?.meta?.outcome, 'skip_destination_missing');
          assert.equal(recoTrace?.status, 'skip');
          assert.equal(recoTrace?.meta?.reason, 'destination_missing');
          assert.equal(storeTrace?.status, 'skip');
          assert.equal(storeTrace?.meta?.reason, 'destination_missing');
        },
      );
    },
  );
});

test('travel skills pipeline: first miss then second hit for travel KB', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'true',
      TRAVEL_KB_WRITE_CONFIDENCE_MIN: '0',
      TRAVEL_KB_WRITE_MAX_IN_FLIGHT: '32',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();

      const first = await runTravelPipeline(buildInput('Please build my Tokyo travel skincare plan.'));
      assert.equal(first.ok, true);
      assert.equal(first.travel_kb_hit, false);
      assert.equal(first.travel_kb_write_queued, true);

      await new Promise((resolve) => setTimeout(resolve, 30));

      const second = await runTravelPipeline(buildInput('Please recheck the same Tokyo trip plan.'));
      assert.equal(second.ok, true);
      assert.equal(second.travel_kb_hit, true);
    },
  );
});

test('travel skills pipeline: kb async write respects backpressure drop when in-flight is full', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'true',
      TRAVEL_KB_WRITE_CONFIDENCE_MIN: '0',
      TRAVEL_KB_WRITE_MAX_IN_FLIGHT: '0',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_KB_POLICY]: {
            evaluateTravelKbBackfill: () => ({
              eligible: true,
              reason: 'eligible',
              confidence_score: 0.99,
            }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(buildInput('Backpressure check for KB write.'));
          assert.equal(out.travel_kb_write_queued, false);
          const kbWriteTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_kb_write_skill');
          assert.equal(Boolean(kbWriteTrace), true);
          assert.equal(kbWriteTrace.status, 'skip');
          assert.equal(kbWriteTrace.meta.reason, 'backpressure_drop');
        },
      );
    },
  );
});

test('travel skills pipeline: reco/store skip reasons are explicit when triggered but no data', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_READINESS]: {
            buildTravelReadiness: () => ({
              destination_context: {
                destination: 'Tokyo',
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
              forecast_window: [{ date: '2026-03-10' }],
              adaptive_actions: ['use_spf'],
              alerts: [],
              shopping_preview: {
                products: [],
                buying_channels: [],
                brand_candidates: [],
              },
              store_examples: [],
              confidence: { score: 0.85, level: 'high' },
            }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();

          const recoOut = await runTravelPipeline(buildInput('What should I buy for Tokyo travel?'));
          const recoTrace = recoOut.travel_skills_trace.find((row) => row.skill === 'travel_reco_preview_skill');
          assert.equal(recoTrace?.status, 'skip');
          assert.equal(recoTrace?.meta?.reason, 'no_products');
          assert.equal(recoOut.travel_skill_invocation_matrix?.reco_called, true);
          assert.equal(recoOut.travel_skill_invocation_matrix?.reco_skip_reason, 'no_products');

          const storeOut = await runTravelPipeline(buildInput('Where can I buy these products in Tokyo?'));
          const storeTrace = storeOut.travel_skills_trace.find((row) => row.skill === 'travel_store_channel_skill');
          assert.equal(storeTrace?.status, 'skip');
          assert.equal(storeTrace?.meta?.reason, 'no_channels');
          assert.equal(storeOut.travel_skill_invocation_matrix?.store_called, true);
          assert.equal(storeOut.travel_skill_invocation_matrix?.store_skip_reason, 'no_channels');
        },
      );
    },
  );
});

test('travel skills pipeline: local product wording triggers both reco preview and store channel', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput('I am flying from Seattle to Shanghai for a business trip from April 27 to May 1, 2026. Build me a travel skincare plan. Please cover weather changes, time difference and jet lag, temperature and humidity shift, what to prepare before leaving, what to do after arrival, and skincare categories I can buy locally in Shanghai.', {
          canonicalIntent: {
            intent: 'travel_planning',
            entities: {
              destination: 'Shanghai',
              departure_region: 'Seattle',
              date_range: { start: '2026-04-20', end: '2026-04-24' },
            },
          },
          profile: {
            skinType: 'combination',
            sensitivity: 'medium',
            barrierStatus: 'stable',
            goals: ['hydration'],
          },
          travelLocalProductAuthorityLoader: async ({ authoritySurface }) => {
            if (authoritySurface === 'packable') {
              return {
                ok: true,
                reason: 'ok',
                candidates: [
                  {
                    product_id: 'ext_us_spf_1',
                    display_name: 'US Packable SPF50 Fluid',
                    name: 'US Packable SPF50 Fluid',
                    brand: 'US Sun Lab',
                    category: 'Sunscreen',
                    step: 'Sun protection',
                    role_id: 'sun_protection',
                    price: 24,
                    currency: 'USD',
                    image_url: 'https://example.com/us-spf.jpg',
                    canonical_url: 'https://example.com/us-spf',
                    product_source: 'catalog',
                    authority_status: 'grounded',
                    match_status: 'catalog_verified',
                    reasons: ['Packable authority match for pre-trip SPF.'],
                  },
                ],
                meta: {
                  market: 'US',
                  market_source: 'destination_text',
                  coverage_status: 'grounded',
                  query_count: 3,
                  candidate_count: 2,
                  selected_count: 1,
                },
              };
            }
            return {
              ok: true,
              reason: 'ok',
              candidates: [
                {
                  product_id: 'ext_cn_spf_1',
                  display_name: 'Shanghai Local SPF50 Fluid',
                  name: 'Shanghai Local SPF50 Fluid',
                  brand: 'CN Sun Lab',
                  category: 'Sunscreen',
                  step: 'Sun protection',
                  price: 128,
                  currency: 'CNY',
                  image_url: 'https://example.com/spf.jpg',
                  canonical_url: 'https://example.com/spf',
                  product_source: 'catalog',
                  authority_status: 'grounded',
                  match_status: 'catalog_verified',
                  reasons: ['Local catalog authority match for sun protection.'],
                },
              ],
              meta: {
                market: 'CN',
                market_source: 'destination_text',
                coverage_status: 'grounded',
                query_count: 3,
                candidate_count: 2,
                selected_count: 1,
              },
            };
          },
        }),
      );

      const intentTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_intent_profile_skill');
      const packableTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_packable_product_authority_skill');
      const authorityTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_local_product_authority_skill');
      const recoTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_reco_preview_skill');
      const storeTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_store_channel_skill');
      assert.equal(intentTrace?.meta?.departure_region, 'Seattle');
      assert.equal(packableTrace?.status, 'ok');
      assert.equal(packableTrace?.meta?.market, 'US');
      assert.equal(authorityTrace?.status, 'ok');
      assert.equal(authorityTrace?.meta?.market, 'CN');
      assert.equal(out.travel_skill_invocation_matrix?.packable_product_authority_coverage_status, 'grounded');
      assert.equal(out.travel_skill_invocation_matrix?.local_product_authority_coverage_status, 'grounded');
      assert.notEqual(recoTrace?.meta?.reason, 'trigger_not_matched');
      assert.notEqual(storeTrace?.meta?.reason, 'trigger_not_matched');
      assert.equal(out.travel_skill_invocation_matrix?.reco_called, true);
      assert.equal(out.travel_skill_invocation_matrix?.store_called, true);
      assert.equal(out.travel_readiness?.shopping_preview?.coverage_status, 'grounded');
      assert.equal(out.travel_readiness?.shopping_preview?.products?.some((item) => item?.name === 'US Packable SPF50 Fluid'), true);
      assert.equal(out.travel_readiness?.shopping_preview?.products?.some((item) => item?.name === 'Shanghai Local SPF50 Fluid'), true);
    },
  );
});

test('travel skills pipeline: look-for-locally wording triggers local authority', async () => {
  const contracts = loadFreshPipeline();
  assert.equal(
    contracts.__internal.shouldTriggerRecoPreview(
      'What Japanese sunscreen or skincare should I look for locally?',
    ),
    true,
  );
  assert.equal(
    contracts.__internal.shouldTriggerStoreChannel(
      'What Japanese sunscreen or skincare should I look for locally?',
    ),
    true,
  );
  assert.equal(
    contracts.__internal.shouldTriggerRecoPreview(
      'What can I shop locally in Seoul for skincare?',
    ),
    true,
  );
  assert.equal(
    contracts.__internal.shouldTriggerStoreChannel(
      'What can I shop locally in Seoul for skincare?',
    ),
    true,
  );
  assert.equal(
    contracts.__internal.shouldTriggerRecoPreview(
      'Give me local skincare shopping ideas for Seoul.',
    ),
    true,
  );
  assert.equal(
    contracts.__internal.shouldTriggerStoreChannel(
      'Give me local skincare shopping ideas for Seoul.',
    ),
    true,
  );
});

test('travel skills pipeline: Seoul local shopping wording reaches KR authority products', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput(
          'I am flying from Seattle to Seoul next Monday for a work trip. Please cover climate changes, flight skincare, after-arrival routine, and what I can shop locally.',
          {
            canonicalIntent: {
              intent: 'travel_planning',
              entities: {
                destination: 'Seoul, South Korea',
                departure_region: 'Seattle',
                date_range: { start: '2026-04-27', end: '2026-05-02' },
              },
            },
            profile: {
              skinType: 'combination',
              sensitivity: 'medium',
              barrierStatus: 'stable',
              goals: ['hydration'],
            },
            travelLocalProductAuthorityLoader: async ({ authoritySurface }) => {
              if (authoritySurface === 'packable') {
                return {
                  ok: true,
                  reason: 'ok',
                  candidates: [
                    {
                      product_id: 'ext_us_moisturizer_1',
                      display_name: 'US Packable Barrier Moisturizer',
                      name: 'US Packable Barrier Moisturizer',
                      brand: 'US Barrier Lab',
                      category: 'Moisturizer',
                      step: 'Lightweight moisturizer',
                      role_id: 'lightweight_moisturizer',
                      price: 22,
                      currency: 'USD',
                      image_url: 'https://example.com/us-moisturizer.jpg',
                      canonical_url: 'https://example.com/us-moisturizer',
                      product_source: 'external_seed',
                      authority_status: 'grounded',
                      match_status: 'catalog_verified',
                      reasons: ['Packable moisturizer for cabin dryness.'],
                    },
                  ],
                  meta: {
                    market: 'US',
                    market_source: 'destination_text',
                    coverage_status: 'grounded',
                    query_count: 4,
                    candidate_count: 2,
                    selected_count: 1,
                  },
                };
              }
              return {
                ok: true,
                reason: 'ok',
                candidates: [
                  {
                    product_id: 'ext_kr_spf_1',
                    display_name: 'Round Lab Birch Juice Moisturizing Sunscreen',
                    name: 'Round Lab Birch Juice Moisturizing Sunscreen',
                    brand: 'Round Lab',
                    category: 'Sunscreen',
                    step: 'Sun protection',
                    role_id: 'sun_protection',
                    price: 28000,
                    currency: 'KRW',
                    image_url: 'https://example.com/round-lab-spf.jpg',
                    canonical_url: 'https://example.com/round-lab-spf',
                    product_source: 'external_seed',
                    authority_status: 'grounded',
                    match_status: 'catalog_verified',
                    reasons: ['Grounded KR sunscreen option for higher-UV daytime wear.'],
                  },
                ],
                meta: {
                  market: 'KR',
                  market_source: 'destination_text',
                  coverage_status: 'grounded',
                  query_count: 4,
                  candidate_count: 3,
                  selected_count: 1,
                },
              };
            },
          },
        ),
      );

      const packableTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_packable_product_authority_skill');
      const authorityTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_local_product_authority_skill');
      const recoTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_reco_preview_skill');
      const storeTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_store_channel_skill');
      assert.equal(packableTrace?.status, 'ok');
      assert.equal(packableTrace?.meta?.market, 'US');
      assert.equal(authorityTrace?.status, 'ok');
      assert.equal(authorityTrace?.meta?.market, 'KR');
      assert.notEqual(authorityTrace?.meta?.reason, 'trigger_not_matched');
      assert.notEqual(recoTrace?.meta?.reason, 'trigger_not_matched');
      assert.notEqual(storeTrace?.meta?.reason, 'trigger_not_matched');
      assert.equal(out.travel_skill_invocation_matrix?.local_product_authority_called, true);
      assert.equal(out.travel_skill_invocation_matrix?.packable_product_authority_called, true);
      assert.equal(out.travel_skill_invocation_matrix?.packable_product_authority_coverage_status, 'grounded');
      assert.equal(out.travel_skill_invocation_matrix?.local_product_authority_coverage_status, 'grounded');
      assert.equal(out.travel_readiness?.shopping_preview?.coverage_status, 'grounded');
      const localProduct = out.travel_readiness?.shopping_preview?.products?.find((item) => item?.product_id === 'ext_kr_spf_1');
      const packableProduct = out.travel_readiness?.shopping_preview?.products?.find((item) => item?.product_id === 'ext_us_moisturizer_1');
      assert.equal(localProduct?.currency, 'KRW');
      assert.equal(localProduct?.name, 'Round Lab Birch Juice Moisturizing Sunscreen');
      assert.equal(localProduct?.travel_usage_scope, 'local_shopping');
      assert.equal(packableProduct?.currency, 'USD');
      assert.equal(packableProduct?.travel_usage_scope, 'phase_products');
      const phasePlan = Array.isArray(out.travel_readiness?.phase_plan) ? out.travel_readiness.phase_plan : [];
      assert.equal(phasePlan.find((phase) => phase.id === 'local_shopping')?.coverage_status, 'grounded');
      assert.ok(phasePlan.find((phase) => phase.id === 'local_shopping')?.product_ids?.includes('ext_kr_spf_1'));
      assert.ok(phasePlan.find((phase) => phase.id === 'flight_cabin')?.product_ids?.includes('ext_us_moisturizer_1'));
      assert.equal(
        phasePlan
          .filter((phase) => phase.id !== 'local_shopping')
          .some((phase) => (phase.product_ids || []).includes('ext_kr_spf_1')),
        false,
      );
    },
  );
});

test('travel skills pipeline: category-only rows do not become fake reco products', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput('What skincare categories can I buy locally in Shanghai?', {
          canonicalIntent: {
            intent: 'travel_planning',
            entities: {
              destination: 'Shanghai',
              departure_region: 'Seattle',
              date_range: { start: '2026-04-20', end: '2026-04-24' },
            },
          },
          profile: {
            skinType: 'combination',
            sensitivity: 'medium',
            barrierStatus: 'stable',
            goals: ['hydration'],
          },
          travelLocalProductAuthorityLoader: async () => ({
            ok: false,
            reason: 'coverage_miss',
            candidates: [],
            meta: {
              market: 'CN',
              market_source: 'destination_text',
              coverage_status: 'coverage_miss',
              query_count: 3,
              candidate_count: 0,
              selected_count: 0,
            },
          }),
        }),
      );

      const authorityTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_local_product_authority_skill');
      const recoTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_reco_preview_skill');
      assert.equal(authorityTrace?.status, 'skip');
      assert.equal(authorityTrace?.meta?.coverage_status, 'coverage_miss');
      assert.equal(out.travel_readiness?.shopping_preview?.coverage_status, 'category_only');
      assert.equal(recoTrace?.status, 'skip');
      assert.equal(recoTrace?.meta?.reason, 'no_products');
      assert.equal(out.travel_skill_invocation_matrix?.reco_called, true);
      assert.equal(out.travel_skill_invocation_matrix?.reco_skip_reason, 'no_products');
    },
  );
});

test('travel skills pipeline: phase plan is restored when upstream readiness omits new contract field', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      await withModuleOverrides(
        {
          [ROOT_READINESS]: {
            buildTravelReadiness: () => ({
              destination_context: {
                destination: 'Tokyo, Japan',
                start_date: '2026-04-27',
                end_date: '2026-05-02',
                env_source: 'weather_api',
              },
              origin_context: { label: 'Seattle, WA', source: 'trip_departure' },
              delta_vs_home: {
                humidity: { home: 77, destination: 65, delta: -12, unit: '%' },
                uv: { home: 6.3, destination: 7.4, delta: 1.1, unit: '' },
                summary_tags: ['warmer', 'drier'],
                baseline_status: 'ok',
              },
              forecast_window: [{ date: '2026-04-27' }],
              jetlag_sleep: {
                hours_diff: 16,
                risk_level: 'high',
              },
              reco_bundle: [
                {
                  trigger: 'Elevated UV',
                  action: 'Face: SPF50+ PA++++ and reapply outdoors.',
                  product_types: ['Face SPF50+ PA++++ sunscreen'],
                },
              ],
              shopping_preview: {
                mode: 'grounded_products',
                coverage_status: 'grounded',
                grounded_count: 1,
                products: [
                  {
                    product_id: 'ext_jp_spf_1',
                    name: 'Biore UV Aqua Rich Watery Essence',
                    brand: 'Biore UV',
                    category: 'Sun protection',
                    product_source: 'catalog',
                    authority_status: 'grounded',
                    match_status: 'catalog_verified',
                    is_grounded: true,
                    price: 1078,
                    currency: 'JPY',
                    pdp_open: {
                      merchant_id: 'external_seed',
                      product_id: 'ext_jp_spf_1',
                      canonical_url: 'https://example.com/jp-spf',
                    },
                  },
                ],
                buying_channels: ['pharmacy'],
              },
              adaptive_actions: [],
              alerts: [],
              confidence: { score: 0.9, level: 'high' },
            }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(
            buildInput('I am traveling from Seattle to Tokyo. What should I buy locally and how should I prepare?'),
          );

          const phasePlan = Array.isArray(out.travel_readiness?.phase_plan)
            ? out.travel_readiness.phase_plan
            : [];
          assert.equal(phasePlan.length, 5);
          assert.deepEqual(phasePlan.map((phase) => phase.id), [
            'pre_trip_prepare',
            'flight_cabin',
            'arrival_first_48h',
            'during_trip_daily',
            'local_shopping',
          ]);
          const localShopping = phasePlan.find((phase) => phase.id === 'local_shopping');
          assert.equal(localShopping?.coverage_status, 'grounded');
          assert.ok(localShopping.product_ids.includes('ext_jp_spf_1'));
          assert.equal(
            phasePlan
              .filter((phase) => phase.id !== 'local_shopping')
              .some((phase) => (phase.product_ids || []).includes('ext_jp_spf_1')),
            false,
          );
        },
      );
    },
  );
});

test('travel skills pipeline: ambiguous destination returns clarification chips instead of fake weather', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'true',
    },
    async () => {
      await withMockFetch(async (url) => {
        if (String(url).includes('geocoding-api.open-meteo.com')) {
          return jsonResponse({
            results: [
              {
                name: 'Paris',
                latitude: 48.85341,
                longitude: 2.3488,
                country: 'France',
                country_code: 'FR',
                admin1: 'Ile-de-France',
                timezone: 'Europe/Paris',
                population: 2148000,
                feature_code: 'PPLA',
              },
              {
                name: 'Paris',
                latitude: 33.66094,
                longitude: -95.55551,
                country: 'United States',
                country_code: 'US',
                admin1: 'Texas',
                timezone: 'America/Chicago',
                population: 24900,
                feature_code: 'PPLA2',
              },
            ],
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }, async () => {
        const { runTravelPipeline } = loadFreshPipeline();
        const out = await runTravelPipeline(
          buildInput('Build my Paris travel plan.', {
            travelWeatherLiveEnabled: true,
            profile: {
              ...buildProfile(),
              travel_plan: {
                destination: 'Paris',
                start_date: '2026-03-10',
                end_date: '2026-03-15',
              },
            },
            canonicalIntent: {
              intent: 'travel_planning',
              entities: {
                destination: 'Paris',
                date_range: { start: '2026-03-10', end: '2026-03-15' },
              },
            },
          }),
        );

        assert.equal(out.ok, true);
        assert.equal(out.env_source, 'pending_clarification');
        assert.equal(out.quality_reason, 'destination_ambiguous');
        assert.equal(out.pending_clarification?.type, 'destination_ambiguous');
        assert.ok(Array.isArray(out.pending_clarification?.candidates));
        assert.ok(out.pending_clarification.candidates.length >= 2);
        assert.equal(out.travel_readiness, null);
        assert.ok(Array.isArray(out.suggested_chips));
        assert.ok(out.suggested_chips.length >= 2);
        assert.equal(out.travel_skill_invocation_matrix?.llm_skip_reason, 'destination_ambiguous');
        const envTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_env_context_skill');
        const replyTrace = out.travel_skills_trace.find((row) => row.skill === 'travel_followup_reply_skill');
        assert.equal(envTrace?.status, 'skip');
        assert.equal(replyTrace?.status, 'clarify');
      });
    },
  );
});

test('travel skills pipeline: plan flow uses trip departure baseline instead of profile region fallback', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const weatherCalls = [];
      await withModuleOverrides(
        {
          [ROOT_WEATHER]: {
            getTravelWeather: async ({ destination, destinationPlace }) => {
              weatherCalls.push({
                destination: destination || null,
                canonical_name: destinationPlace?.canonical_name || null,
              });
              const key = destinationPlace?.canonical_name || destination;
              if (key === 'Tokyo') {
                return {
                  source: 'weather_api',
                  reason: 'live_ok',
                  summary: {
                    temperature_max_c: 26,
                    humidity_mean: 72,
                    uv_index_max: 8,
                    wind_kph_max: 15,
                    precipitation_mm: 2,
                  },
                  location: { name: 'Tokyo', timezone: 'Asia/Tokyo' },
                  forecast_window: [{ date: '2026-03-10' }],
                };
              }
              return {
                source: 'weather_api',
                reason: 'live_ok',
                summary: {
                  temperature_max_c: 31,
                  humidity_mean: 84,
                  uv_index_max: 10,
                  wind_kph_max: 11,
                  precipitation_mm: 4,
                },
                location: { name: 'Singapore', timezone: 'Asia/Singapore' },
                forecast_window: [{ date: '2026-03-10' }],
              };
            },
          },
          [ROOT_ALERTS]: {
            getTravelAlerts: async () => ({ source: 'none', reason: 'none', alerts: [] }),
          },
        },
        async () => {
          const { runTravelPipeline } = loadFreshPipeline();
          const out = await runTravelPipeline(
            buildInput('Build my Tokyo travel plan.', {
              travelWeatherLiveEnabled: true,
              profile: {
                ...buildProfile(),
                region: 'New York, NY',
                travel_plan: {
                  trip_id: 'trip_tokyo_departure',
                  destination: 'Tokyo',
                  destination_place: {
                    label: 'Tokyo, Japan',
                    canonical_name: 'Tokyo',
                    latitude: 35.6895,
                    longitude: 139.69171,
                    country_code: 'JP',
                    country: 'Japan',
                    admin1: 'Tokyo',
                    timezone: 'Asia/Tokyo',
                    resolution_source: 'auto_resolved',
                  },
                  departure_region: 'Singapore',
                  departure_place: {
                    label: 'Singapore',
                    canonical_name: 'Singapore',
                    latitude: 1.28967,
                    longitude: 103.85007,
                    country_code: 'SG',
                    country: 'Singapore',
                    admin1: 'Singapore',
                    timezone: 'Asia/Singapore',
                    resolution_source: 'auto_resolved',
                  },
                  start_date: '2026-03-10',
                  end_date: '2026-03-15',
                },
              },
            }),
          );

          assert.equal(out.ok, true);
          assert.equal(out.travel_readiness?.origin_context?.label, 'Singapore');
          assert.equal(out.travel_readiness?.delta_vs_origin?.temperature?.home, 31);
          assert.equal(out.travel_readiness?.delta_vs_home?.temperature?.home, 31);
          assert.equal(weatherCalls.some((row) => row.destination === 'New York, NY'), false);
          assert.equal(weatherCalls.some((row) => row.canonical_name === 'Singapore'), true);
        },
      );
    },
  );
});

test('travel skills pipeline: inactive pregnancy status does not create pregnancy focus and dates survive', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput('Build my Seattle to Shanghai business trip skincare plan.', {
          profile: {
            skinType: 'combination',
            sensitivity: 'medium',
            barrierStatus: 'stable',
            goals: ['hydration', 'oil control'],
            pregnancy_status: 'not_pregnant',
            lactation_status: 'not_lactating',
            travel_plan: {
              destination: 'Shanghai',
              departure_region: 'Seattle',
              start_date: '2026-04-20',
              end_date: '2026-04-24',
            },
          },
          canonicalIntent: {
            intent: 'travel_planning',
            entities: {
              destination: 'Shanghai',
              departure_region: 'Seattle',
            },
          },
        }),
      );

      assert.equal(out.ok, true);
      assert.equal(out.travel_readiness?.destination_context?.start_date, '2026-04-20');
      assert.equal(out.travel_readiness?.destination_context?.end_date, '2026-04-24');
      const personalFocus = Array.isArray(out.travel_readiness?.personal_focus)
        ? out.travel_readiness.personal_focus
        : [];
      assert.equal(personalFocus.some((row) => /pregnan|lactat/i.test(String(row?.focus || ''))), false);
    },
  );
});

test('travel skills pipeline: legacy trip flow without departure blocks with departure_missing clarification', async () => {
  await withEnv(
    {
      TRAVEL_KB_ASYNC_BACKFILL_ENABLED: 'false',
      AURORA_TRAVEL_LLM_CALIBRATION_ENABLED: 'false',
    },
    async () => {
      const { runTravelPipeline } = loadFreshPipeline();
      const out = await runTravelPipeline(
        buildInput('Build my Tokyo travel plan.', {
          profile: {
            ...buildProfile(),
            region: 'New York, NY',
            travel_plan: {
              trip_id: 'trip_missing_departure',
              destination: 'Tokyo',
              start_date: '2026-03-10',
              end_date: '2026-03-15',
            },
          },
          canonicalIntent: {
            intent: 'travel_planning',
            entities: {
              destination: 'Tokyo',
              date_range: { start: '2026-03-10', end: '2026-03-15' },
            },
          },
        }),
      );

      assert.equal(out.ok, true);
      assert.equal(out.env_source, 'pending_clarification');
      assert.equal(out.quality_reason, 'departure_missing');
      assert.equal(out.pending_clarification?.type, 'departure_missing');
      assert.equal(out.pending_clarification?.field, 'departure_region');
      assert.equal(out.travel_readiness, null);
      assert.equal(out.travel_skill_invocation_matrix?.llm_skip_reason, 'departure_missing');
    },
  );
});
