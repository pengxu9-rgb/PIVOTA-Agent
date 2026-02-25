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
  assert.match(result.text, /常驻地：San Francisco, CA -> 目的地：Paris/);
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
  assert.match(result.text, /Home region: San Francisco, CA -> Destination: Paris/);
  assert.match(result.text, /Home baseline is unavailable/i);
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
  assert.match(result.text, /humidity shift is mild/i);
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
  assert.match(result.text, /destination humidity is lower than home/i);
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
  const result = composeTravelReply({
    message: '巴黎湿度有变化吗？有什么面霜或者面膜可以提前准备？',
    language: 'CN',
    travelReadiness: buildReadiness({ baselineStatus: 'ok' }),
    destination: 'Paris',
    homeRegion: 'San Francisco, CA',
    envSource: 'weather_api',
  });

  assert.equal(result.focus, 'humidity+products');
  assert.match(result.text, /湿度: 56% -> 76% \(变化 \+20%\)/);
  assert.match(result.text, /(面霜|面膜|防晒档位|主推单品)/);
  assert.match(result.text, /示例门店|Example stores/);
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
