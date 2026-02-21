const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeDateToken(value) {
  const token = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(token)) return '';
  return token;
}

function toIsoDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clampDateRange(startDate, endDate) {
  const now = new Date();
  const fallbackStart = toIsoDate(now);
  const fallbackEndDate = new Date(now);
  fallbackEndDate.setUTCDate(fallbackEndDate.getUTCDate() + 3);
  const fallbackEnd = toIsoDate(fallbackEndDate);

  const start = normalizeDateToken(startDate) || fallbackStart;
  const endCandidate = normalizeDateToken(endDate) || start || fallbackEnd;

  if (endCandidate < start) {
    return { start, end: start };
  }

  const startObj = new Date(`${start}T00:00:00.000Z`);
  const endObj = new Date(`${endCandidate}T00:00:00.000Z`);
  const diffDays = Math.floor((endObj.getTime() - startObj.getTime()) / 86400000);
  if (diffDays > 10) {
    const capped = new Date(startObj);
    capped.setUTCDate(capped.getUTCDate() + 10);
    return { start, end: toIsoDate(capped) };
  }

  return { start, end: endCandidate };
}

function normalizeDailyArray(value) {
  return Array.isArray(value) ? value : [];
}

function meanOf(values) {
  const nums = values
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function maxOf(values) {
  const nums = values
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  if (!nums.length) return null;
  return Math.max(...nums);
}

function buildWeatherSummary(daily = {}) {
  const tempMax = normalizeDailyArray(daily.temperature_2m_max);
  const tempMin = normalizeDailyArray(daily.temperature_2m_min);
  const uv = normalizeDailyArray(daily.uv_index_max);
  const precipitation = normalizeDailyArray(daily.precipitation_sum);
  const wind = normalizeDailyArray(daily.wind_speed_10m_max);
  const humidity = normalizeDailyArray(daily.relative_humidity_2m_mean);

  const tempSwingValues = tempMax
    .map((maxValue, idx) => {
      const maxNum = Number(maxValue);
      const minNum = Number(tempMin[idx]);
      if (!Number.isFinite(maxNum) || !Number.isFinite(minNum)) return null;
      return Math.max(0, maxNum - minNum);
    })
    .filter((v) => Number.isFinite(v));

  return {
    temperature_max_c: meanOf(tempMax),
    temperature_min_c: meanOf(tempMin),
    temp_swing_c: meanOf(tempSwingValues),
    uv_index_max: maxOf(uv),
    humidity_mean: meanOf(humidity),
    precipitation_mm: meanOf(precipitation),
    wind_kph_max: maxOf(wind),
    days_count: Math.max(
      tempMax.length,
      tempMin.length,
      uv.length,
      precipitation.length,
      wind.length,
      humidity.length,
    ),
  };
}

async function callJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reason: `http_${res.status}`, data: null };
    }
    const data = await res.json();
    return { ok: true, data, reason: null };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, reason, data: null };
  } finally {
    clearTimeout(timeout);
  }
}

function climateFallback({ destination, startDate, endDate } = {}) {
  const name = String(destination || '').trim();
  const { start, end } = clampDateRange(startDate, endDate);
  const month = Number((start || '').slice(5, 7)) || new Date().getUTCMonth() + 1;

  const coldSeason = month <= 2 || month >= 11;
  const hotSeason = month >= 6 && month <= 9;

  const summary = {
    temperature_max_c: hotSeason ? 30 : coldSeason ? 8 : 22,
    temperature_min_c: hotSeason ? 24 : coldSeason ? 1 : 14,
    temp_swing_c: hotSeason ? 7 : coldSeason ? 11 : 8,
    uv_index_max: hotSeason ? 8 : 5,
    humidity_mean: hotSeason ? 72 : 50,
    precipitation_mm: hotSeason ? 2.6 : 1.2,
    wind_kph_max: coldSeason ? 24 : 18,
    days_count: 3,
  };

  return {
    ok: true,
    source: 'climate_fallback',
    destination: name || null,
    date_range: { start, end },
    location: { name: name || null, latitude: null, longitude: null, timezone: null },
    summary,
    raw: null,
  };
}

async function getTravelWeather({
  destination,
  startDate,
  endDate,
  fetchImpl = global.fetch,
  geocodeTimeoutMs = 1600,
  forecastTimeoutMs = 1800,
} = {}) {
  const name = String(destination || '').trim();
  if (!name) {
    return {
      ok: false,
      source: 'none',
      reason: 'destination_missing',
      destination: null,
      date_range: null,
      location: null,
      summary: null,
      raw: null,
    };
  }

  const { start, end } = clampDateRange(startDate, endDate);
  const dateRange = { start, end };

  if (typeof fetchImpl !== 'function') {
    return {
      ...climateFallback({ destination: name, startDate: start, endDate: end }),
      reason: 'fetch_unavailable',
    };
  }

  const geoUrl = `${OPEN_METEO_GEOCODE_URL}?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const geocode = await callJson(geoUrl, fetchImpl, geocodeTimeoutMs);
  if (!geocode.ok) {
    return {
      ...climateFallback({ destination: name, startDate: start, endDate: end }),
      reason: `geocode_${geocode.reason || 'failed'}`,
    };
  }

  const result = Array.isArray(geocode.data && geocode.data.results) ? geocode.data.results[0] : null;
  const lat = Number(result && result.latitude);
  const lon = Number(result && result.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      ...climateFallback({ destination: name, startDate: start, endDate: end }),
      reason: 'geocode_no_results',
    };
  }

  const forecastUrl = `${OPEN_METEO_FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean` +
    `&timezone=auto&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;

  const forecast = await callJson(forecastUrl, fetchImpl, forecastTimeoutMs);
  if (!forecast.ok || !forecast.data || typeof forecast.data !== 'object') {
    return {
      ...climateFallback({ destination: name, startDate: start, endDate: end }),
      reason: `forecast_${forecast.reason || 'failed'}`,
    };
  }

  const summary = buildWeatherSummary(forecast.data.daily || {});

  return {
    ok: true,
    source: 'weather_api',
    reason: null,
    destination: name,
    date_range: dateRange,
    location: {
      name: String(result.name || name),
      latitude: lat,
      longitude: lon,
      timezone: String(forecast.data.timezone || result.timezone || ''),
      country: String(result.country || ''),
    },
    summary,
    raw: {
      daily: forecast.data.daily || null,
      generationtime_ms: forecast.data.generationtime_ms || null,
    },
  };
}

module.exports = {
  getTravelWeather,
  climateFallback,
  __internal: {
    buildWeatherSummary,
    clampDateRange,
  },
};
