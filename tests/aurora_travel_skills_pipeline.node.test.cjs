const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT_CONTRACTS = '../src/auroraBff/travelSkills/contracts';
const ROOT_KB_STORE = '../src/auroraBff/travelKbStore';
const ROOT_METRICS = '../src/auroraBff/visionMetrics';
const ROOT_READINESS = '../src/auroraBff/travelReadinessBuilder';
const ROOT_CALIBRATOR = '../src/auroraBff/travelLlmCalibrator';
const ROOT_REPLY_COMPOSER = '../src/auroraBff/travelReplyComposer';
const ROOT_WEATHER = '../src/auroraBff/weatherAdapter';
const ROOT_ALERTS = '../src/auroraBff/travelAlertsProvider';
const ROOT_KB_POLICY = '../src/auroraBff/travelKbPolicy';

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
  delete require.cache[contractsId];
  delete require.cache[kbStoreId];
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
          'travel_llm_calibration_skill',
          'travel_reco_preview_skill',
          'travel_store_channel_skill',
          'travel_followup_reply_skill',
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
      assert.equal(typeof matrix.store_called, 'boolean');
      assert.equal('store_skip_reason' in matrix, true);
      assert.equal(typeof matrix.kb_write_queued, 'boolean');
      assert.equal(typeof matrix.kb_write_skip_reason, 'string');
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
