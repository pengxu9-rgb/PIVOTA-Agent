const test = require('node:test');
const assert = require('node:assert/strict');

const { composeTravelReply } = require('../src/auroraBff/travelReplyComposer');

function buildReadiness({ baselineStatus = 'ok' } = {}) {
  return {
    destination_context: {
      destination: 'Paris',
      start_date: '2026-02-27',
      end_date: '2026-03-03',
      env_source: 'climate_fallback',
      epi: 65,
    },
    delta_vs_home: {
      temperature: { home: 18, destination: 11, delta: -7, unit: 'C' },
      humidity: {
        home: baselineStatus === 'ok' ? 56 : null,
        destination: 76,
        delta: baselineStatus === 'ok' ? 20 : null,
        unit: '%',
      },
      uv: { home: 4, destination: 6, delta: 2, unit: '' },
      summary_tags: ['colder', 'more_humid', 'higher_uv'],
      baseline_status: baselineStatus,
    },
    adaptive_actions: [
      { why: 'Humidity increase', what_to_do: 'Switch to lighter moisturizer in AM.' },
      { why: 'Higher UV', what_to_do: 'Reapply sunscreen during outdoor hours.' },
      { why: 'Wind swings', what_to_do: 'Prioritize barrier-repair cream at night.' },
    ],
    forecast_window: [
      { date: '2026-02-27', temp_low_c: 7, temp_high_c: 13, condition_text: 'Cloudy' },
      { date: '2026-02-28', temp_low_c: 6, temp_high_c: 14, condition_text: 'Showers' },
      { date: '2026-03-01', temp_low_c: 7, temp_high_c: 15, condition_text: 'Rain' },
      { date: '2026-03-02', temp_low_c: 8, temp_high_c: 15, condition_text: 'Cloudy' },
      { date: '2026-03-03', temp_low_c: 7, temp_high_c: 14, condition_text: 'Cloudy' },
      { date: '2026-03-04', temp_low_c: 6, temp_high_c: 13, condition_text: 'Rain' },
    ],
    alerts: [
      {
        provider: 'Meteo-France',
        severity: 'yellow',
        title: 'Flood',
        summary: 'Moderate flooding warning',
        start_at: '2026-02-24T06:00:00Z',
        end_at: '2026-02-25T00:00:00Z',
        action_hint: 'Keep informed and avoid flood-prone routes.',
      },
    ],
    personal_focus: [
      { focus: 'Barrier first', why: 'Sensitivity', what_to_do: 'Avoid stacking strong actives nightly.' },
    ],
    jetlag_sleep: {
      tz_home: 'America/Los_Angeles',
      tz_destination: 'Europe/Paris',
      hours_diff: 9,
      risk_level: 'high',
      sleep_tips: ['Shift sleep earlier for 2-3 days pre-trip.'],
      mask_tips: ['Use a recovery hydration mask after flight.'],
    },
    shopping_preview: {
      products: [
        { name: 'Barrier Gel Cream' },
        { name: 'UV Shield SPF50' },
      ],
      buying_channels: ['pharmacy', 'ecommerce'],
    },
    store_examples: [
      { name: 'Citypharma', district: '6th arrondissement' },
      { name: 'Pharmacie Monge', district: '5th arrondissement' },
    ],
    confidence: {
      level: baselineStatus === 'ok' ? 'high' : 'medium',
      missing_inputs: baselineStatus === 'ok' ? [] : ['home_baseline_weather'],
      improve_by: [],
    },
  };
}

test('travelReplyComposer answers humidity question with explicit home-vs-destination delta', () => {
  const result = composeTravelReply({
    message: '那边天气怎么样？会不会很湿？',
    language: 'CN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'climate_fallback',
  });

  assert.equal(result.reply_mode, 'focused');
  assert.equal(result.focus, 'humidity');
  assert.match(result.text, /出发地：San Francisco, CA -> 目的地：Paris/);
  assert.match(result.text, /湿度: 56% -> 76% \(变化 \+20%\)/);
});

test('travelReplyComposer surfaces baseline gap when home weather baseline is unavailable', () => {
  const result = composeTravelReply({
    message: 'Will it be humid there?',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'baseline_unavailable' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'climate_fallback',
  });

  assert.equal(result.reply_mode, 'focused');
  assert.match(result.text, /Departure: San Francisco, CA -> Destination: Paris/);
  assert.match(result.text, /Departure baseline is unavailable/i);
  assert.match(result.text, /Humidity: 76%/i);
  assert.doesNotMatch(result.text, /0%\s*->\s*76%/i);
  assert.doesNotMatch(result.text, /0C\s*->\s*11C/i);
  assert.equal(result.home_baseline_available, false);
});

test('travelReplyComposer explicitly states climate fallback limitation and re-check timing', () => {
  const result = composeTravelReply({
    message: 'How is weather there next week?',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'climate_fallback',
  });

  assert.match(result.text, /Live forecast is unavailable; using a climate baseline/i);
  assert.match(result.text, /48-72 hours/i);
});

test('travelReplyComposer renders full forecast window including end-date row', () => {
  const result = composeTravelReply({
    message: 'Will it be humid there?',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.match(result.text, /2026-03-04/);
});

test('travelReplyComposer surfaces alert action hint when alerts exist', () => {
  const result = composeTravelReply({
    message: 'Any weather alerts?',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.match(result.text, /Official alerts:/i);
  assert.match(result.text, /Keep informed and avoid flood-prone routes\./i);
});

test('travelReplyComposer trace fixture: Tokyo request keeps destination-only deltas and avoids unsupported no-alert claim', () => {
  const result = composeTravelReply({
    message:
      'Please adjust my skincare based on this travel plan. Destination: tokyo. Dates: 2026-03-12 to 2026-03-17.',
    language: 'EN',
    travelReadiness: {
      destination_context: {
        destination: 'Tokyo',
        start_date: '2026-03-12',
        end_date: '2026-03-17',
        env_source: 'climate_fallback',
        epi: 62,
      },
      delta_vs_home: {
        temperature: { home: null, destination: 14, delta: null, unit: 'C' },
        humidity: { home: null, destination: 58, delta: null, unit: '%' },
        uv: { home: null, destination: 6, delta: null, unit: '' },
        summary_tags: ['baseline_unavailable'],
        baseline_status: 'baseline_unavailable',
      },
      forecast_window: [
        { date: '2026-03-12', temp_low_c: 6, temp_high_c: 14, condition_text: 'Cloudy', precip_mm: 0.6 },
      ],
      alerts: [],
      adaptive_actions: [],
      personal_focus: [{ focus: 'Stability first', what_to_do: 'Keep routine simple for first 48 hours.' }],
      jetlag_sleep: { hours_diff: 8, risk_level: 'high' },
      shopping_preview: { products: [{ name: 'Barrier Cream' }] },
    },
    destination: 'Tokyo',
    homeRegion: 'San Francisco, CA',
    envSource: 'climate_fallback',
  });

  assert.match(result.text, /Destination: Tokyo \(2026-03-12 -> 2026-03-17\)/);
  assert.match(result.text, /Humidity: 58%/i);
  assert.doesNotMatch(result.text, /0%\s*->/i);
  assert.doesNotMatch(result.text, /0C\s*->/i);
  assert.doesNotMatch(result.text, /No official weather alert currently/i);
});

test('travelReplyComposer avoids unsupported temperature-swing claim in humidity-only follow-up', () => {
  const readiness = buildReadiness({ baselineStatus: 'ok' });
  readiness.delta_vs_home.humidity = { home: 56, destination: 58, delta: 2, unit: '%' };
  readiness.delta_vs_home.temperature = { home: 18, destination: 18, delta: 0, unit: 'C' };
  readiness.adaptive_actions = [];

  const result = composeTravelReply({
    message: 'How humid is it there?',
    language: 'EN',
    travelReadiness: readiness,
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.doesNotMatch(result.text, /temperature swings/i);
  assert.match(result.text, /humidity is close to your departure baseline/i);
});

test('travelReplyComposer keeps humidity-only answer grounded even when temperature delta is large', () => {
  const readiness = buildReadiness({ baselineStatus: 'ok' });
  readiness.delta_vs_home.humidity = { home: 78, destination: 58, delta: -20, unit: '%' };
  readiness.delta_vs_home.temperature = { home: 31, destination: 22, delta: -9, unit: 'C' };
  readiness.adaptive_actions = [];

  const result = composeTravelReply({
    message: 'Will it be humid there?',
    language: 'EN',
    travelReadiness: readiness,
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.match(result.text, /Humidity: 78% -> 58%/);
  assert.doesNotMatch(result.text, /temperature swings/i);
  assert.match(result.text, /drier/i);
});

test('travelReplyComposer dedupes near-duplicate barrier actions in routine_adjustments', () => {
  const readiness = buildReadiness({ baselineStatus: 'ok' });
  readiness.delta_vs_home.humidity = { home: 78, destination: 58, delta: -20, unit: '%' };
  readiness.adaptive_actions = [
    { why: 'Dryness', what_to_do: 'Upgrade to barrier hydration and add an occlusive seal at night.' },
    { why: 'Dryness+', what_to_do: 'Upgrade AM/PM to richer barrier hydration with an occlusive seal on dry areas.' },
  ];

  const result = composeTravelReply({
    message: 'Will it be humid there?',
    language: 'EN',
    travelReadiness: readiness,
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  const routineSection = result.structured_sections.routine_adjustments || [];
  assert.ok(routineSection.length <= 3, 'routine_adjustments should be concise after dedup');
  assert.ok(result.text.includes('drier') || result.text.includes('Destination is drier'));
});

test('travelReplyComposer avoids same-text replay for repeated same focus in-session', () => {
  const first = composeTravelReply({
    message: 'How humid is it there?',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  const second = composeTravelReply({
    message: 'How humid is it there?',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
    previousFocus: first.focus,
    previousReplySig: first.reply_sig,
  });

  assert.equal(first.focus, 'humidity');
  assert.equal(second.focus, 'humidity');
  assert.notEqual(first.text, second.text);
  assert.match(second.text, /More specifically/i);
});

test('travelReplyComposer shifts focus for follow-up temperature question', () => {
  const result = composeTravelReply({
    message: '那温度呢？',
    language: 'CN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
    previousFocus: 'humidity',
    previousReplySig: 'humidity|paris|san francisco, ca|+20|ok',
  });

  assert.equal(result.focus, 'temperature');
  assert.match(result.text, /温度: 18C -> 11C \(变化 -7C\)/);
});

test('travelReplyComposer handles mixed humidity + product follow-up in one answer', () => {
  const readiness = buildReadiness({ baselineStatus: 'ok' });
  readiness.reco_bundle = [
    {
      trigger: 'Elevated UV',
      action: 'Face SPF50+ PA++++, reapply every 2h outdoors. Body: apply body sunscreen on exposed areas.',
      ingredient_logic: 'Photostable UVA filters.',
      product_types: ['Face SPF50+ PA++++ sunscreen'],
      reapply_rule: 'Reapply every 2h.',
    },
  ];
  readiness.category_recommendations = [
    {
      category: 'sun_protection',
      why: 'UV is elevated',
      products: [{ name: 'SPF stick', usage: 'Midday reapply', ingredient_logic: 'Portable touch-up format' }],
    },
  ];

  const result = composeTravelReply({
    message: '巴黎湿度有变化吗？有什么面霜或者面膜可以提前准备？',
    language: 'CN',
    travelReadiness: readiness,
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.equal(result.focus, 'humidity+products');
  assert.match(result.text, /湿度: 56% -> 76% \(变化 \+20%\)/);
  assert.match(result.text, /(面霜|面膜|防晒档位|主推单品)/);
  assert.match(result.text, /示例门店|Example stores/);
  assert.ok(Array.isArray(result.structured_sections.travel_kit));
  assert.ok(result.structured_sections.travel_kit.some((line) => /Elevated UV/.test(line)));
  assert.equal(result.structured_sections.travel_kit.some((line) => /【sun_protection】/.test(line)), false);
});

test('travelReplyComposer adds phased plan for multi-day trip window', () => {
  const result = composeTravelReply({
    message: 'Please adjust my skincare for Paris weather this week.',
    language: 'EN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.match(result.text, /Phased plan:/);
  assert.match(result.text, /Pre-trip \(T-2 to T-1\)/);
  assert.match(result.text, /Flight day:/);
  assert.match(result.text, /On-site days:/);
});

test('travelReplyComposer keeps travel kit copy complete and user-readable', () => {
  const readiness = buildReadiness({ baselineStatus: 'ok' });
  readiness.destination_context.destination = 'Shanghai, China';
  readiness.reco_bundle = [
    {
      trigger: 'Elevated UV',
      action: 'Use a face SPF50+ PA++++ sunscreen before outdoor business transit.',
      ingredient_logic: 'Prioritize photostable UVA filters plus antioxidant film-formers; use a body SPF in fluid texture for easy large-area application.',
      product_types: ['Face SPF50+ PA++++ sunscreen', 'Portable reapply format'],
      reapply_rule: 'Outdoors over 90 minutes: reapply every 2 hours and after sweat or wipe-off.',
    },
  ];
  readiness.shopping_preview.buying_channels = ['beauty_retail', 'pharmacy', 'department_store', 'ecommerce'];
  readiness.shopping_preview.mode = 'category_guidance';
  readiness.shopping_preview.coverage_status = 'category_only';
  readiness.shopping_preview.products = [
    {
      name: 'Face SPF50+ PA++++ sunscreen',
      product_source: 'category_guidance',
      authority_status: 'category_only',
    },
    {
      name: 'Portable reapply format',
      product_source: 'category_guidance',
      authority_status: 'category_only',
    },
  ];

  const result = composeTravelReply({
    message: 'Build me a skincare trip plan for Shanghai.',
    language: 'EN',
    travelReadiness: readiness,
    destination: 'Shanghai, China',
    homeRegion: 'Seattle, WA',
    envSource: 'weather_api',
  });

  assert.doesNotMatch(result.text, /\.\.\./);
  assert.match(result.text, /easy large-area application/i);
  assert.match(result.text, /Suggested product categories: Face SPF50\+ PA\+\+\+\+ sunscreen \/ Portable reapply format\./i);
  assert.doesNotMatch(result.text, /Suggested products:/i);
  assert.match(result.text, /Local buying in Shanghai, China: beauty retailers \/ pharmacies \/ department-store beauty counters \/ local e-commerce/i);
  assert.doesNotMatch(result.text, /beauty_retail|department_store/i);
});

test('travelReplyComposer labels grounded shopping rows as product options', () => {
  const readiness = buildReadiness({ baselineStatus: 'ok' });
  readiness.shopping_preview.mode = 'grounded_products';
  readiness.shopping_preview.coverage_status = 'grounded';
  readiness.shopping_preview.products = [
    {
      name: 'Grounded SPF Fluid',
      product_id: 'sku_grounded_spf',
      product_source: 'catalog',
      authority_status: 'grounded',
    },
  ];

  const result = composeTravelReply({
    message: 'Build me a skincare trip plan for Shanghai.',
    language: 'EN',
    travelReadiness: readiness,
    destination: 'Shanghai, China',
    homeRegion: 'Seattle, WA',
    envSource: 'weather_api',
  });

  assert.match(result.text, /Product options to review: Grounded SPF Fluid\./i);
  assert.doesNotMatch(result.text, /Suggested product categories: Grounded SPF Fluid/i);
});
