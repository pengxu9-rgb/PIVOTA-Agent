const test = require('node:test');
const assert = require('node:assert/strict');

const { climateFallback, getTravelWeather, __internal } = require('../src/auroraBff/weatherAdapter');

const { clampDateRange } = __internal;

function diffDays(start, end) {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  return Math.floor((endMs - startMs) / 86400000);
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

test('weather adapter clampDateRange defaults to 5-day window', () => {
  const out = clampDateRange();
  assert.equal(typeof out.start, 'string');
  assert.equal(typeof out.end, 'string');
  assert.equal(diffDays(out.start, out.end), 4);
});

test('weather adapter clampDateRange caps any range to max 7 days', () => {
  const out = clampDateRange('2026-03-01', '2026-03-20');
  assert.equal(out.start, '2026-03-01');
  assert.equal(out.end, '2026-03-07');
  assert.equal(diffDays(out.start, out.end), 6);
});

test('weather adapter climate fallback uses 5-day default summary/window', () => {
  const out = climateFallback({
    destination: 'Paris',
    reason: 'geocode_failed',
    userLocale: 'EN',
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.equal(out.summary.days_count, 5);
  assert.ok(Array.isArray(out.forecast_window));
  assert.equal(out.forecast_window.length, 0);
  assert.equal(out.days_covered, 0);
});

test('weather adapter climate fallback respects 7-day hard cap', () => {
  const out = climateFallback({
    destination: 'Paris',
    startDate: '2026-03-01',
    endDate: '2026-03-28',
    reason: 'geocode_failed',
    userLocale: 'EN',
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.equal(out.date_range.start, '2026-03-01');
  assert.equal(out.date_range.end, '2026-03-07');
  assert.ok(Array.isArray(out.forecast_window));
  assert.equal(out.forecast_window.length, 0);
  assert.equal(out.days_covered, 0);
});

test('weather adapter resolves 新加坡 with locale-aware geocode and returns live hot weather', async () => {
  const seenUrls = [];
  const out = await getTravelWeather({
    destination: '新加坡',
    startDate: '2026-03-10',
    endDate: '2026-03-12',
    userLocale: 'zh-CN',
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      if (String(url).includes('geocoding-api.open-meteo.com')) {
        return jsonResponse({
          results: [
            {
              name: 'Singapore',
              latitude: 1.28967,
              longitude: 103.85007,
              country_code: 'SG',
              country: 'Singapore',
              admin1: 'Central Singapore',
              timezone: 'Asia/Singapore',
              feature_code: 'PPLC',
              population: 5638700,
            },
          ],
        });
      }
      if (String(url).includes('api.open-meteo.com')) {
        return jsonResponse({
          timezone: 'Asia/Singapore',
          daily: {
            time: ['2026-03-10', '2026-03-11', '2026-03-12'],
            temperature_2m_max: [31.8, 32.1, 31.5],
            temperature_2m_min: [26.4, 26.8, 26.1],
            uv_index_max: [10.2, 10.1, 9.8],
            precipitation_sum: [2.2, 1.3, 3.1],
            wind_speed_10m_max: [16.4, 18.2, 14.9],
            relative_humidity_2m_mean: [81.5, 82.2, 80.7],
            weather_code: [61, 3, 80],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'weather_api');
  assert.equal(out.reason, 'weather_api_ok');
  assert.ok(String(seenUrls[0] || '').includes('language=zh'));
  assert.ok(out.location.name.includes('Singapore'));
  assert.ok(Number(out.summary.temperature_max_c) >= 31);
  assert.ok(Array.isArray(out.forecast_window));
  assert.equal(out.forecast_window.length, 3);
});

test('weather adapter uses destination_place coordinates directly and skips geocode', async () => {
  const seenUrls = [];
  const out = await getTravelWeather({
    destination: 'Singapore',
    destinationPlace: {
      label: 'Singapore, Central Singapore, Singapore',
      canonical_name: 'Singapore',
      latitude: 1.28967,
      longitude: 103.85007,
      country_code: 'SG',
      country: 'Singapore',
      admin1: 'Central Singapore',
      timezone: 'Asia/Singapore',
      resolution_source: 'user_selected',
    },
    startDate: '2026-03-10',
    endDate: '2026-03-12',
    userLocale: 'zh-CN',
    fetchImpl: async (url) => {
      seenUrls.push(String(url));
      return jsonResponse({
        timezone: 'Asia/Singapore',
        daily: {
          time: ['2026-03-10', '2026-03-11', '2026-03-12'],
          temperature_2m_max: [31.8, 32.1, 31.5],
          temperature_2m_min: [26.4, 26.8, 26.1],
          uv_index_max: [10.2, 10.1, 9.8],
          precipitation_sum: [2.2, 1.3, 3.1],
          wind_speed_10m_max: [16.4, 18.2, 14.9],
          relative_humidity_2m_mean: [81.5, 82.2, 80.7],
          weather_code: [61, 3, 80],
        },
      });
    },
  });

  assert.equal(out.source, 'weather_api');
  assert.equal(seenUrls.length, 1);
  assert.ok(seenUrls[0].includes('latitude=1.28967'));
  assert.equal(seenUrls[0].includes('geocoding-api.open-meteo.com'), false);
});

test('weather adapter returns geocode_no_results instead of unexpected_exception for empty geocode results', async () => {
  const out = await getTravelWeather({
    destination: 'Atlantis',
    userLocale: 'zh-CN',
    fetchImpl: async (url) => {
      if (String(url).includes('geocoding-api.open-meteo.com')) {
        return jsonResponse({ results: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'climate_fallback');
  assert.equal(out.reason, 'geocode_no_results');
  assert.equal(out.forecast_window.length, 0);
});

test('weather adapter returns destination clarification instead of silent fallback for ambiguous cities', async () => {
  const out = await getTravelWeather({
    destination: 'Athens',
    startDate: '2026-03-12',
    endDate: '2026-03-15',
    userLocale: 'EN',
    fetchImpl: async (url) => {
      if (String(url).includes('geocoding-api.open-meteo.com')) {
        return jsonResponse({
          results: [
            {
              name: 'Athens',
              latitude: 37.98376,
              longitude: 23.72784,
              country_code: 'GR',
              country: 'Greece',
              admin1: 'Attica',
              timezone: 'Europe/Athens',
              feature_code: 'PPLC',
              population: 664046,
            },
            {
              name: 'Athens',
              latitude: 33.96095,
              longitude: -83.37794,
              country_code: 'US',
              country: 'United States',
              admin1: 'Georgia',
              timezone: 'America/New_York',
              feature_code: 'PPLA2',
              population: 127315,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'pending_clarification');
  assert.equal(out.reason, 'destination_ambiguous');
  assert.equal(Array.isArray(out.candidates), true);
  assert.ok(out.candidates.some((row) => String(row.label || '').includes('Athens, Attica, Greece')));
  assert.equal(out.forecast_window.length, 0);
});

test('weather adapter returns live weather for Athens, Greece once destination is explicit', async () => {
  const out = await getTravelWeather({
    destination: 'Athens, Greece',
    startDate: '2026-03-12',
    endDate: '2026-03-15',
    userLocale: 'EN',
    fetchImpl: async (url) => {
      if (String(url).includes('geocoding-api.open-meteo.com')) {
        return jsonResponse({
          results: [
            {
              name: 'Athens',
              latitude: 37.98376,
              longitude: 23.72784,
              country_code: 'GR',
              country: 'Greece',
              admin1: 'Attica',
              timezone: 'Europe/Athens',
              feature_code: 'PPLC',
              population: 664046,
            },
          ],
        });
      }
      if (String(url).includes('api.open-meteo.com')) {
        return jsonResponse({
          timezone: 'Europe/Athens',
          daily: {
            time: ['2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'],
            temperature_2m_max: [18.1, 17.6, 15.8, 15.8],
            temperature_2m_min: [5.6, 5.1, 4.0, 6.7],
            uv_index_max: [5.9, 5.9, 5.7, 5.8],
            precipitation_sum: [0, 0, 0, 0],
            wind_speed_10m_max: [5.9, 11.8, 9.8, 15.8],
            relative_humidity_2m_mean: [62, 54, 67, 62],
            weather_code: [3, 3, 3, 3],
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  assert.equal(out.ok, true);
  assert.equal(out.source, 'weather_api');
  assert.equal(out.reason, 'weather_api_ok');
  assert.equal(String(out.location.country_code || ''), 'GR');
  assert.ok(Number(out.summary.temperature_max_c) < 22);
});
