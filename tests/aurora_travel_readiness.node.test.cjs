const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTravelReadiness, __internal } = require('../src/auroraBff/travelReadinessBuilder');

test('buildTravelReadiness returns actionable structure with deltas and shopping preview', () => {
  const payload = buildTravelReadiness({
    language: 'EN',
    profile: {
      skinType: 'oily',
      sensitivity: 'high',
      barrierStatus: 'impaired',
      goals: ['dark_spots'],
      region: 'San Francisco, CA',
    },
    recentLogs: [],
    destination: 'Paris',
    startDate: '2026-03-10',
    endDate: '2026-03-15',
    destinationWeather: {
      source: 'weather_api',
      location: { timezone: 'Europe/Paris' },
      summary: {
        temperature_max_c: 11,
        humidity_mean: 82,
        uv_index_max: 7.8,
        wind_kph_max: 28,
        precipitation_mm: 3.5,
      },
    },
    homeWeather: {
      source: 'weather_api',
      location: { timezone: 'America/Los_Angeles' },
      summary: {
        temperature_max_c: 18,
        humidity_mean: 55,
        uv_index_max: 4.2,
        wind_kph_max: 12,
        precipitation_mm: 1.1,
      },
    },
    epiPayload: { env_source: 'weather_api', epi: 74 },
    recommendationCandidates: [
      {
        step: 'Barrier Serum',
        sku: { product_id: 'sku_1', brand: 'BrandA', name: 'Barrier Rescue Serum' },
        reasons: ['Barrier repair and soothing support.'],
      },
      {
        step: 'Sunscreen',
        sku: { product_id: 'sku_2', brand: 'BrandB', name: 'UV Shield SPF50' },
        reasons: ['High UV destination support.'],
      },
    ],
    nowMs: Date.parse('2026-03-01T12:00:00.000Z'),
  });

  assert.equal(typeof payload, 'object');
  assert.equal(payload.destination_context.destination, 'Paris');
  assert.equal(payload.destination_context.start_date, '2026-03-10');
  assert.equal(payload.destination_context.end_date, '2026-03-15');
  assert.equal(payload.delta_vs_home.baseline_status, 'ok');
  assert.ok(Array.isArray(payload.delta_vs_home.summary_tags));
  assert.ok(payload.delta_vs_home.summary_tags.includes('colder'));
  assert.ok(payload.delta_vs_home.summary_tags.includes('more_humid'));
  assert.ok(payload.delta_vs_home.summary_tags.includes('higher_uv'));
  assert.ok(Array.isArray(payload.adaptive_actions));
  assert.ok(payload.adaptive_actions.length >= 3);
  assert.ok(Array.isArray(payload.personal_focus));
  assert.ok(payload.personal_focus.length >= 2);
  assert.ok(Array.isArray(payload.reco_bundle));
  assert.ok(payload.reco_bundle.some((item) => item && item.trigger === 'Eye care'));
  assert.ok(payload.reco_bundle.some((item) => item && item.trigger === 'Brightening / dark-spot care'));
  assert.ok(Array.isArray(payload.shopping_preview.products));
  assert.ok(payload.shopping_preview.products.length >= 1);
  assert.ok(Array.isArray(payload.shopping_preview.buying_channels));
  assert.ok(payload.shopping_preview.buying_channels.includes('ecommerce'));
  assert.equal(payload.confidence.level, 'high');
  assert.ok(payload.confidence.missing_inputs.includes('recent_logs'));
  assert.ok(payload.confidence.missing_inputs.includes('current_routine'));
});

test('buildTravelReadiness marks baseline_unavailable when home baseline cannot be resolved', () => {
  const payload = buildTravelReadiness({
    language: 'EN',
    profile: {
      skinType: 'combination',
      sensitivity: 'low',
      barrierStatus: 'healthy',
      goals: ['acne'],
    },
    destination: 'Paris',
    destinationWeather: {
      source: 'climate_fallback',
      location: { timezone: 'Europe/Paris' },
      summary: {
        temperature_max_c: 16,
        humidity_mean: 70,
        uv_index_max: 6,
        wind_kph_max: 18,
        precipitation_mm: 2.2,
      },
    },
    homeWeather: null,
    epiPayload: { env_source: 'climate_fallback', epi: 58 },
  });

  assert.equal(payload.delta_vs_home.baseline_status, 'baseline_unavailable');
  assert.ok(Array.isArray(payload.delta_vs_home.summary_tags));
  assert.ok(payload.delta_vs_home.summary_tags.includes('baseline_unavailable'));
  assert.equal(payload.confidence.level, 'medium');

  const genericPayload = buildTravelReadiness({
    language: 'EN',
    profile: {},
    destination: 'Paris',
    destinationWeather: {
      source: 'climate_fallback',
      location: { timezone: 'Europe/Paris' },
      summary: {
        temperature_max_c: 16,
        humidity_mean: 70,
        uv_index_max: 6,
        wind_kph_max: 18,
        precipitation_mm: 2.2,
      },
    },
    homeWeather: null,
    epiPayload: { env_source: 'climate_fallback', epi: 58 },
  });

  assert.equal(typeof genericPayload, 'object');
  assert.ok(Array.isArray(genericPayload.personal_focus));
  assert.equal(genericPayload.personal_focus[0].focus, 'Stability first');
  assert.ok(genericPayload.confidence.missing_inputs.includes('current_routine'));
});

test('buildJetlagSleep derives high risk for large timezone differences', () => {
  const jetlag = __internal.buildJetlagSleep({
    language: 'EN',
    profile: { region: 'US' },
    destinationWeather: {
      location: { timezone: 'Asia/Tokyo' },
    },
    homeWeather: {
      location: { timezone: 'America/Los_Angeles' },
    },
    nowMs: Date.parse('2026-02-23T12:00:00.000Z'),
  });

  assert.equal(typeof jetlag.hours_diff, 'number');
  assert.ok(jetlag.hours_diff >= 9);
  assert.equal(jetlag.risk_level, 'high');
  assert.ok(Array.isArray(jetlag.sleep_tips));
  assert.ok(jetlag.sleep_tips.length >= 1);
  assert.ok(Array.isArray(jetlag.mask_tips));
  assert.ok(jetlag.mask_tips.length >= 1);
});

test('buildJetlagSleep resolves timezone names from location labels when IANA tz is unavailable', () => {
  const jetlag = __internal.buildJetlagSleep({
    language: 'EN',
    profile: { region: 'San Francisco, CA' },
    destination: 'Tokyo',
    destinationWeather: {
      location: { name: 'Tokyo', timezone: null },
    },
    homeWeather: {
      location: { name: 'San Francisco, CA', timezone: null },
    },
    nowMs: Date.parse('2026-02-23T12:00:00.000Z'),
  });

  assert.equal(jetlag.tz_home, 'America/Los_Angeles');
  assert.equal(jetlag.tz_destination, 'Asia/Tokyo');
  assert.equal(typeof jetlag.hours_diff, 'number');
  assert.ok(jetlag.hours_diff >= 9);
  assert.equal(jetlag.risk_level, 'high');
});

test('buildTravelReadiness backfills shopping preview products from reco_bundle when catalog products are missing', () => {
  const payload = buildTravelReadiness({
    language: 'EN',
    profile: {
      skinType: 'oily',
      sensitivity: 'medium',
      barrierStatus: 'healthy',
      goals: ['pores'],
      region: 'San Francisco, CA',
    },
    recentLogs: [],
    destination: 'Paris',
    startDate: '2026-03-10',
    endDate: '2026-03-15',
    destinationWeather: {
      source: 'weather_api',
      location: { timezone: 'Europe/Paris' },
      summary: {
        temperature_max_c: 25,
        humidity_mean: 80,
        uv_index_max: 8.2,
        wind_kph_max: 19,
        precipitation_mm: 2.8,
      },
      forecast_window: [
        { date: '2026-03-10', temp_low_c: 15, temp_high_c: 25, humidity_mean: 80, uv_max: 8.2, precip_mm: 2.8, wind_kph: 19 },
      ],
    },
    homeWeather: {
      source: 'weather_api',
      location: { timezone: 'America/Los_Angeles' },
      summary: {
        temperature_max_c: 18,
        humidity_mean: 56,
        uv_index_max: 5.2,
        wind_kph_max: 10,
        precipitation_mm: 1.1,
      },
    },
    epiPayload: { env_source: 'weather_api', epi: 70 },
    recommendationCandidates: [],
    nowMs: Date.parse('2026-03-01T12:00:00.000Z'),
  });

  assert.ok(Array.isArray(payload.shopping_preview.products));
  assert.ok(payload.shopping_preview.products.length >= 1);
  assert.equal(payload.shopping_preview.products[0].product_id, null);
  assert.equal(typeof payload.shopping_preview.products[0].name, 'string');
  assert.ok(payload.shopping_preview.products[0].name.length > 0);
  assert.ok(Array.isArray(payload.shopping_preview.products[0].reasons));
  assert.ok(payload.shopping_preview.products[0].reasons.length >= 1);
});
