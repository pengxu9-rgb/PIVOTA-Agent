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
      reason: 'weather_api_ok',
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
        role_id: 'sun_protection',
        sku: {
          product_id: 'sku_2',
          merchant_id: 'm_paris',
          product_group_id: 'pg_spf_2',
          brand: 'BrandB',
          name: 'UV Shield SPF50',
          image_url: 'https://example.test/spf.jpg',
          price: 19,
          currency: 'EUR',
        },
        reasons: ['High UV destination support.'],
      },
      {
        step: 'Eye care',
        role_id: 'eye_care',
        sku: { product_id: 'sku_3', brand: 'BrandC', name: 'Caffeine Eye Gel' },
        reasons: ['Jet-lag eye-area support.'],
      },
      {
        step: 'Lip and hand support',
        role_id: 'body_lip_hand',
        sku: { product_id: 'sku_4', brand: 'BrandD', name: 'SPF Lip Balm' },
        reasons: ['Lip support for outdoor exposure.'],
      },
    ],
    nowMs: Date.parse('2026-03-01T12:00:00.000Z'),
  });

  assert.equal(typeof payload, 'object');
  assert.equal(payload.destination_context.destination, 'Paris');
  assert.equal(payload.destination_context.start_date, '2026-03-10');
  assert.equal(payload.destination_context.end_date, '2026-03-15');
  assert.equal(payload.destination_context.weather_reason, 'weather_api_ok');
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
  assert.ok(Array.isArray(payload.categorized_kit));
  const sunProtection = payload.categorized_kit.find((item) => item && item.id === 'sun_protection');
  const moisturization = payload.categorized_kit.find((item) => item && item.id === 'moisturization');
  assert.ok(sunProtection);
  assert.match(String(sunProtection.climate_link || ''), /UV/i);
  assert.equal(payload.shopping_preview.mode, 'grounded_products');
  assert.equal(payload.shopping_preview.coverage_status, 'grounded');
  assert.equal(payload.shopping_preview.products[0].product_source, 'catalog');
  assert.equal(payload.shopping_preview.products[0].authority_status, 'grounded');
  assert.equal(payload.shopping_preview.products.length, 4);
  assert.equal(payload.shopping_preview.products.some((item) => item && item.image_url === 'https://example.test/spf.jpg'), true);
  const spfPreview = payload.shopping_preview.products.find((item) => item && item.product_id === 'sku_2');
  assert.equal(spfPreview.merchant_id, 'm_paris');
  assert.equal(spfPreview.product_group_id, 'pg_spf_2');
  assert.equal(spfPreview.pdp_open.merchant_id, 'm_paris');
  assert.match(spfPreview.reasons.join(' '), /AM\/outdoor SPF step/);
  assert.match(spfPreview.reasons.join(' '), /reapply based on outdoor exposure time/);
  const lipPreview = payload.shopping_preview.products.find((item) => item && item.product_id === 'sku_4');
  assert.match(lipPreview.reasons.join(' '), /Use on lips/);
  assert.match(lipPreview.reasons.join(' '), /do not treat a lip product as hand or body care/);
  assert.equal(/AM\/outdoor SPF step/.test(lipPreview.reasons.join(' ')), false);
  assert.ok(Array.isArray(payload.phase_plan));
  assert.deepEqual(payload.phase_plan.map((phase) => phase.id), [
    'pre_trip_prepare',
    'flight_cabin',
    'arrival_first_48h',
    'during_trip_daily',
    'local_shopping',
  ]);
  assert.ok(payload.phase_plan.find((phase) => phase.id === 'pre_trip_prepare').product_ids.includes('sku_2'));
  assert.ok(payload.phase_plan.find((phase) => phase.id === 'flight_cabin').product_ids.includes('sku_3'));
  assert.ok(payload.phase_plan.find((phase) => phase.id === 'local_shopping').product_ids.includes('sku_4'));
  assert.ok(Array.isArray(sunProtection.brand_suggestions));
  assert.ok(sunProtection.brand_suggestions.some((item) => item && item.product === 'UV Shield SPF50'));
  assert.ok(moisturization);
  assert.ok(Array.isArray(moisturization.brand_suggestions));
  assert.ok(moisturization.brand_suggestions.some((item) => item && item.product === 'Barrier Rescue Serum'));
  assert.ok(Array.isArray(payload.shopping_preview.products));
  assert.ok(payload.shopping_preview.products.length >= 1);
  assert.ok(Array.isArray(payload.shopping_preview.buying_channels));
  assert.ok(payload.shopping_preview.buying_channels.includes('ecommerce'));
  assert.equal(payload.confidence.level, 'high');
  assert.ok(payload.confidence.missing_inputs.includes('recent_logs'));
  assert.ok(payload.confidence.missing_inputs.includes('current_routine'));
});

test('buildTravelReadiness uses product name before generic body-lip-hand category', () => {
  const payload = buildTravelReadiness({
    language: 'EN',
    profile: { skinType: 'oily', region: 'Seattle, WA' },
    recentLogs: [],
    destination: 'Tokyo',
    destinationWeather: {
      source: 'weather_api',
      location: { timezone: 'Asia/Tokyo' },
      summary: { temperature_max_c: 21, humidity_mean: 66, uv_index_max: 7.4 },
    },
    homeWeather: {
      source: 'weather_api',
      location: { timezone: 'America/Los_Angeles' },
      summary: { temperature_max_c: 16, humidity_mean: 77, uv_index_max: 6.3 },
    },
    recommendationCandidates: [
      {
        step: 'Body, lip, or hand support',
        role_id: 'body_lip_hand',
        sku: { product_id: 'jp_hand_1', brand: 'Kao Curel', name: 'Curel Hand Cream' },
        reasons: ['Category: Body, lip, or hand support.'],
      },
    ],
    nowMs: Date.parse('2026-04-20T12:00:00.000Z'),
  });

  const hand = payload.shopping_preview.products.find((item) => item && item.product_id === 'jp_hand_1');
  assert.ok(hand);
  assert.match(hand.reasons.join(' '), /Use on hands/);
  assert.equal(/Use on lips/.test(hand.reasons.join(' ')), false);
});

test('buildTravelReadiness keeps recovery mask use rationale ahead of hydrating category wording', () => {
  const payload = buildTravelReadiness({
    language: 'EN',
    profile: { skinType: 'oily', region: 'Seattle, WA' },
    recentLogs: [],
    destination: 'Seoul',
    destinationWeather: {
      source: 'weather_api',
      location: { timezone: 'Asia/Seoul' },
      summary: { temperature_max_c: 19, humidity_mean: 61, uv_index_max: 7.2 },
    },
    homeWeather: {
      source: 'weather_api',
      location: { timezone: 'America/Los_Angeles' },
      summary: { temperature_max_c: 16, humidity_mean: 77, uv_index_max: 6.3 },
    },
    recommendationCandidates: [
      {
        step: 'Hydrating or soothing mask',
        role_id: 'recovery_mask',
        sku: { product_id: 'mask_1', brand: 'Round Lab', name: 'Birch Juice Moisturizing Mask' },
        reasons: ['Category: Hydrating or soothing mask.'],
      },
    ],
    nowMs: Date.parse('2026-04-20T12:00:00.000Z'),
  });

  const mask = payload.shopping_preview.products.find((item) => item && item.product_id === 'mask_1');
  assert.ok(mask);
  assert.match(mask.reasons.join(' '), /optional night recovery/);
  assert.match(mask.reasons.join(' '), /already tolerated/);
  assert.equal(/Use under moisturizer/.test(mask.reasons.join(' ')), false);
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
      reason: 'geocode_no_results',
      location: { timezone: 'Europe/Paris' },
      summary: {
        temperature_max_c: 32,
        humidity_mean: 82,
        uv_index_max: 9.2,
        wind_kph_max: 18,
        precipitation_mm: 2.2,
      },
    },
    homeWeather: null,
    epiPayload: { env_source: 'climate_fallback', epi: 58 },
  });

  assert.equal(payload.delta_vs_home.baseline_status, 'baseline_unavailable');
  assert.equal(payload.destination_context.weather_reason, 'geocode_no_results');
  assert.ok(Array.isArray(payload.delta_vs_home.summary_tags));
  assert.ok(payload.delta_vs_home.summary_tags.includes('baseline_unavailable'));
  assert.ok(payload.delta_vs_home.summary_tags.includes('hot'));
  assert.ok(payload.delta_vs_home.summary_tags.includes('humid'));
  assert.ok(payload.delta_vs_home.summary_tags.includes('high_uv'));
  assert.equal(payload.confidence.level, 'medium');

  const genericPayload = buildTravelReadiness({
    language: 'EN',
    profile: {},
    destination: 'Paris',
    destinationWeather: {
      source: 'climate_fallback',
      reason: 'geocode_no_results',
      location: { timezone: 'Europe/Paris' },
      summary: {
        temperature_max_c: 32,
        humidity_mean: 82,
        uv_index_max: 9.2,
        wind_kph_max: 18,
        precipitation_mm: 2.2,
      },
    },
    homeWeather: null,
    epiPayload: { env_source: 'climate_fallback', epi: 58 },
  });

  assert.equal(typeof genericPayload, 'object');
  assert.ok(Array.isArray(genericPayload.personal_focus));
  assert.ok(genericPayload.personal_focus.some((item) => item && typeof item.focus === 'string'));
  assert.ok(genericPayload.personal_focus.some((item) => item && item.focus === 'High UV defense'));
  assert.ok(genericPayload.delta_vs_home.summary_tags.includes('hot'));
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

test('buildTravelReadiness exposes category-only shopping guidance when catalog products are missing', () => {
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
  assert.equal(payload.shopping_preview.mode, 'category_guidance');
  assert.equal(payload.shopping_preview.coverage_status, 'category_only');
  assert.equal(payload.shopping_preview.products[0].product_id, null);
  assert.equal(payload.shopping_preview.products[0].product_source, 'category_guidance');
  assert.equal(payload.shopping_preview.products[0].authority_status, 'category_only');
  assert.equal(payload.shopping_preview.products[0].display_mode, 'category_only');
  assert.equal(payload.shopping_preview.products[0].is_grounded, false);
  assert.ok(Array.isArray(payload.phase_plan));
  assert.equal(payload.phase_plan.length, 5);
  assert.equal(payload.phase_plan.find((phase) => phase.id === 'local_shopping').coverage_status, 'category_only');
  assert.equal(typeof payload.shopping_preview.products[0].name, 'string');
  assert.ok(payload.shopping_preview.products[0].name.length > 0);
  assert.ok(Array.isArray(payload.shopping_preview.products[0].reasons));
  assert.ok(payload.shopping_preview.products[0].reasons.length >= 1);
  assert.ok(Array.isArray(payload.categorized_kit));
  const bridgedPreviewName = payload.shopping_preview.products[0].name;
  assert.ok(
    payload.categorized_kit.some(
      (entry) =>
        (!Array.isArray(entry && entry.brand_suggestions) || entry.brand_suggestions.length === 0) &&
        Array.isArray(entry && entry.category_suggestions) &&
        entry.category_suggestions.some((item) => item && item.product === bridgedPreviewName),
    ),
  );
  assert.match(String(payload.shopping_preview.note || ''), /category guidance only/i);
});
