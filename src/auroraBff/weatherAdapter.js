const { getAuroraKbV0 } = require('./kbV0/loader');
const { recordAuroraKbV0ClimateFallback } = require('./visionMetrics');
const { normalizeDestinationPlace, resolveDestinationInput } = require('./destinationResolver');

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
  fallbackEndDate.setUTCDate(fallbackEndDate.getUTCDate() + 4);
  const fallbackEnd = toIsoDate(fallbackEndDate);

  const start = normalizeDateToken(startDate) || fallbackStart;
  const endCandidate = normalizeDateToken(endDate) || fallbackEnd;

  if (endCandidate < start) {
    return { start, end: start };
  }

  const startObj = new Date(`${start}T00:00:00.000Z`);
  const endObj = new Date(`${endCandidate}T00:00:00.000Z`);
  const diffDays = Math.floor((endObj.getTime() - startObj.getTime()) / 86400000);
  if (diffDays > 6) {
    const capped = new Date(startObj);
    capped.setUTCDate(capped.getUTCDate() + 6);
    return { start, end: toIsoDate(capped) };
  }

  return { start, end: endCandidate };
}

function normalizeDailyArray(value) {
  return Array.isArray(value) ? value : [];
}

function roundTo(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const base = 10 ** digits;
  return Math.round(n * base) / base;
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

function normalizeWeatherCode(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function mapWeatherCodeToConditionText(weatherCodeRaw, precipitationMmRaw) {
  const code = normalizeWeatherCode(weatherCodeRaw);
  const precipitationMm = Number(precipitationMmRaw);
  const hasNotablePrecip = Number.isFinite(precipitationMm) && precipitationMm >= 0.5;
  if (code == null) {
    return hasNotablePrecip ? 'Chance of rain' : 'Variable conditions';
  }

  if (code === 0) return 'Clear sky';
  if (code === 1) return 'Mainly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code === 51 || code === 53 || code === 55) return 'Drizzle';
  if (code === 56 || code === 57) return 'Freezing drizzle';
  if (code === 61 || code === 63 || code === 65) return 'Rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if (code === 71 || code === 73 || code === 75) return 'Snow';
  if (code === 77) return 'Snow grains';
  if (code === 80 || code === 81 || code === 82) return 'Rain showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code === 95) return 'Thunderstorm';
  if (code === 96 || code === 99) return 'Thunderstorm with hail';
  return hasNotablePrecip ? 'Unsettled with precipitation' : 'Variable conditions';
}

function buildForecastWindow(daily = {}, maxDays = 7) {
  const dates = normalizeDailyArray(daily.time);
  const tempMax = normalizeDailyArray(daily.temperature_2m_max);
  const tempMin = normalizeDailyArray(daily.temperature_2m_min);
  const uv = normalizeDailyArray(daily.uv_index_max);
  const precipitation = normalizeDailyArray(daily.precipitation_sum);
  const wind = normalizeDailyArray(daily.wind_speed_10m_max);
  const humidity = normalizeDailyArray(daily.relative_humidity_2m_mean);
  const weatherCode = normalizeDailyArray(daily.weather_code);

  const rowCount = Math.min(dates.length || 0, maxDays);
  const rows = [];
  for (let i = 0; i < rowCount; i += 1) {
    const dateToken = String(dates[i] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateToken)) continue;

    const precipMm = roundTo(precipitation[i], 1);
    rows.push({
      date: dateToken,
      temp_low_c: roundTo(tempMin[i], 1),
      temp_high_c: roundTo(tempMax[i], 1),
      humidity_mean: roundTo(humidity[i], 1),
      uv_max: roundTo(uv[i], 1),
      precip_mm: precipMm,
      wind_kph: roundTo(wind[i], 1),
      condition_text: mapWeatherCodeToConditionText(weatherCode[i], precipMm),
    });
  }

  return rows;
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

const CLIMATE_MONTH_BUCKETS = Object.freeze([1, 4, 7, 10]);
const SOUTHERN_HEMISPHERE_COUNTRIES = new Set([
  'AU',
  'NZ',
  'ZA',
  'AR',
  'CL',
  'UY',
  'PY',
  'BO',
  'PE',
  'BR',
]);

function hashText(input) {
  const text = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function nearestMonthBucket(monthRaw) {
  const month = Number(monthRaw);
  const current = Number.isFinite(month) ? Math.max(1, Math.min(12, Math.trunc(month))) : new Date().getUTCMonth() + 1;
  let best = CLIMATE_MONTH_BUCKETS[0];
  let bestDelta = Math.abs(current - best);
  for (const bucket of CLIMATE_MONTH_BUCKETS.slice(1)) {
    const delta = Math.abs(current - bucket);
    if (delta < bestDelta) {
      best = bucket;
      bestDelta = delta;
    }
  }
  return best;
}

function inferLocaleCountryCode(userLocaleRaw) {
  const locale = String(userLocaleRaw || '').trim();
  if (!locale) return '';
  const token = locale.replace('_', '-');
  const parts = token.split('-').filter(Boolean);
  if (parts.length >= 2 && /^[a-z]{2}$/i.test(parts[1])) {
    return parts[1].toUpperCase();
  }
  return '';
}

function hemisphereFromCountryCode(countryCodeRaw) {
  const code = String(countryCodeRaw || '').trim().toUpperCase();
  if (!code) return '';
  return SOUTHERN_HEMISPHERE_COUNTRIES.has(code) ? 'south' : 'north';
}

function selectClimateRegion({ destination, month, userLocale } = {}) {
  const kb = getAuroraKbV0();
  const regions = Array.isArray(kb && kb.climate_normals && kb.climate_normals.regions) ? kb.climate_normals.regions : [];
  if (!regions.length) return null;

  const bucket = nearestMonthBucket(month);
  const name = String(destination || '').trim().toLowerCase();
  let selectedBy = 'default';
  let region = null;
  if (name) {
    const regionIndex = hashText(name) % regions.length;
    region = regions[regionIndex] || regions[0];
    selectedBy = 'destination_hash';
  } else {
    const localeCountry = inferLocaleCountryCode(userLocale || process.env.AURORA_KB_CLIMATE_USER_LOCALE || process.env.LC_ALL || process.env.LANG);
    const localeHemisphere = hemisphereFromCountryCode(localeCountry);
    if (localeHemisphere) {
      region = regions.find((item) => String(item && item.hemisphere || '').trim().toLowerCase() === localeHemisphere) || null;
      if (region) selectedBy = 'user_locale';
    }
    if (!region && regions.length > 0) {
      const monthIndex = CLIMATE_MONTH_BUCKETS.indexOf(bucket);
      const regionIndex = monthIndex >= 0 ? monthIndex % regions.length : 0;
      region = regions[regionIndex] || regions[0];
      selectedBy = 'month';
    }
  }
  region = region || regions[0];
  if (!region || typeof region !== 'object') return null;

  const profiles = Array.isArray(region.month_profiles) ? region.month_profiles : [];
  let profile = profiles.find((item) => Number(item && item.month) === bucket) || null;
  if (!profile && profiles.length > 0) {
    profile = profiles
      .slice()
      .sort((a, b) => Math.abs(Number(a.month) - bucket) - Math.abs(Number(b.month) - bucket))[0];
  }
  if (!profile) return null;

  return {
    region,
    profile,
    month_bucket: bucket,
    selected_by: selectedBy,
  };
}

function mapUvLevelToIndex(levelRaw) {
  const level = String(levelRaw || '').trim().toLowerCase();
  if (level === 'extreme') return 11;
  if (level === 'high') return 9;
  if (level === 'medium') return 6;
  return 3;
}

function mapHumidityToMean(levelRaw) {
  const level = String(levelRaw || '').trim().toLowerCase();
  if (level === 'humid') return 78;
  if (level === 'balanced') return 58;
  return 38;
}

function mapTempSwingToC(levelRaw) {
  const level = String(levelRaw || '').trim().toLowerCase();
  if (level === 'high') return 14;
  if (level === 'medium') return 9;
  return 5;
}

function mapWindToKph(levelRaw) {
  const level = String(levelRaw || '').trim().toLowerCase();
  if (level === 'high') return 34;
  if (level === 'medium') return 22;
  return 12;
}

function mapPollutionToPrecipitation(levelRaw, humidityRaw) {
  const pollution = String(levelRaw || '').trim().toLowerCase();
  const humidity = String(humidityRaw || '').trim().toLowerCase();
  if (humidity === 'humid') return pollution === 'high' ? 4.0 : 3.0;
  if (humidity === 'balanced') return pollution === 'high' ? 2.1 : 1.5;
  return 0.8;
}

function mapArchetypeTemps(archetypeRaw, monthBucket) {
  const archetype = String(archetypeRaw || '').trim().toLowerCase();
  const bucket = Number(monthBucket) || 7;
  const warmMonth = bucket === 7;
  const coolMonth = bucket === 1;

  if (archetype.includes('desert')) {
    return warmMonth ? { max: 34, min: 21 } : coolMonth ? { max: 18, min: 7 } : { max: 27, min: 14 };
  }
  if (archetype.includes('tropical')) {
    return { max: 31, min: 24 };
  }
  if (archetype.includes('subarctic') || archetype.includes('polar')) {
    return warmMonth ? { max: 13, min: 4 } : coolMonth ? { max: -5, min: -14 } : { max: 4, min: -2 };
  }
  if (archetype.includes('continental')) {
    return warmMonth ? { max: 29, min: 18 } : coolMonth ? { max: 4, min: -4 } : { max: 18, min: 9 };
  }
  if (archetype.includes('mediterranean')) {
    return warmMonth ? { max: 31, min: 21 } : coolMonth ? { max: 13, min: 7 } : { max: 23, min: 14 };
  }
  return warmMonth ? { max: 30, min: 22 } : coolMonth ? { max: 9, min: 2 } : { max: 22, min: 14 };
}

function buildSyntheticForecastWindow({ startDate, endDate, summary, maxDays = 7 } = {}) {
  const { start, end } = clampDateRange(startDate, endDate);
  const startObj = new Date(`${start}T00:00:00.000Z`);
  const endObj = new Date(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startObj.getTime()) || !Number.isFinite(endObj.getTime())) return [];
  const rows = [];
  let cursor = new Date(startObj);
  while (cursor <= endObj && rows.length < maxDays) {
    const date = toIsoDate(cursor);
    rows.push({
      date,
      temp_low_c: roundTo(summary && summary.temperature_min_c, 1),
      temp_high_c: roundTo(summary && summary.temperature_max_c, 1),
      humidity_mean: roundTo(summary && summary.humidity_mean, 1),
      uv_max: roundTo(summary && summary.uv_index_max, 1),
      precip_mm: roundTo(summary && summary.precipitation_mm, 1),
      wind_kph: roundTo(summary && summary.wind_kph_max, 1),
      condition_text: 'Climate baseline estimate',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
}

function buildDefaultSummaryForMonth(monthRaw) {
  const month = Number(monthRaw) || new Date().getUTCMonth() + 1;
  const coldSeason = month <= 2 || month >= 11;
  const hotSeason = month >= 6 && month <= 9;
  return {
    temperature_max_c: hotSeason ? 30 : coldSeason ? 8 : 22,
    temperature_min_c: hotSeason ? 24 : coldSeason ? 1 : 14,
    temp_swing_c: hotSeason ? 7 : coldSeason ? 11 : 8,
    uv_index_max: hotSeason ? 8 : 5,
    humidity_mean: hotSeason ? 72 : 50,
    precipitation_mm: hotSeason ? 2.6 : 1.2,
    wind_kph_max: coldSeason ? 24 : 18,
    days_count: 5,
  };
}

function buildStaticClimateFallback({ destination, destinationPlace, startDate, endDate, reason } = {}) {
  const explicitPlace = normalizeDestinationPlace(destinationPlace, {
    resolutionSource: destinationPlace && destinationPlace.resolution_source,
  });
  const name = String(explicitPlace && explicitPlace.label ? explicitPlace.label : destination || '').trim();
  const { start, end } = clampDateRange(startDate, endDate);
  const month = Number((start || '').slice(5, 7)) || new Date().getUTCMonth() + 1;
  const metricReason = String(reason || 'unknown').trim().toLowerCase() || 'unknown';
  const summary = buildDefaultSummaryForMonth(month);

  return {
    ok: true,
    source: 'climate_fallback',
    destination: name || null,
    reason: metricReason,
    date_range: { start, end },
    location: {
      name: name || null,
      latitude: explicitPlace ? explicitPlace.latitude : null,
      longitude: explicitPlace ? explicitPlace.longitude : null,
      timezone: explicitPlace ? explicitPlace.timezone : null,
      country: explicitPlace ? explicitPlace.country : null,
      country_code: explicitPlace ? explicitPlace.country_code : null,
      admin1: explicitPlace ? explicitPlace.admin1 : null,
    },
    summary,
    forecast_window: [],
    data_freshness_utc: new Date().toISOString(),
    days_covered: 0,
    raw: {
      climate_profile: {
        region_id: null,
        archetype: null,
        month_bucket: nearestMonthBucket(month),
        archetype_selected_by: 'static_default',
      },
    },
  };
}

function buildPendingDestinationClarification({
  destination,
  destinationPlace,
  startDate,
  endDate,
  reason,
  normalizedQuery,
  candidates,
} = {}) {
  const explicitPlace = normalizeDestinationPlace(destinationPlace, {
    resolutionSource: destinationPlace && destinationPlace.resolution_source,
  });
  const name = String(explicitPlace && explicitPlace.label ? explicitPlace.label : destination || '').trim();
  const { start, end } = clampDateRange(startDate, endDate);
  const rows = Array.isArray(candidates) ? candidates.map((row) => normalizeDestinationPlace(row)).filter(Boolean) : [];
  return {
    ok: true,
    source: 'pending_clarification',
    destination: name || null,
    reason: String(reason || 'destination_ambiguous').trim().toLowerCase() || 'destination_ambiguous',
    normalized_query: String(normalizedQuery || name || '').trim() || null,
    candidates: rows.slice(0, 5),
    date_range: { start, end },
    location: {
      name: name || null,
      latitude: explicitPlace ? explicitPlace.latitude : null,
      longitude: explicitPlace ? explicitPlace.longitude : null,
      timezone: explicitPlace ? explicitPlace.timezone : null,
      country: explicitPlace ? explicitPlace.country : null,
      country_code: explicitPlace ? explicitPlace.country_code : null,
      admin1: explicitPlace ? explicitPlace.admin1 : null,
    },
    summary: null,
    forecast_window: [],
    data_freshness_utc: new Date().toISOString(),
    days_covered: 0,
    raw: {
      clarification_type: 'destination_ambiguous',
    },
  };
}

function safeClimateFallback(args = {}) {
  try {
    return climateFallback(args);
  } catch (err) {
    const fallback = buildStaticClimateFallback(args);
    const fallbackError = String((err && err.message) || err || '').trim();
    if (!fallbackError) return fallback;
    return {
      ...fallback,
      raw: {
        ...(fallback.raw || {}),
        fallback_error: fallbackError.slice(0, 220),
      },
    };
  }
}

function climateFallback({ destination, destinationPlace, startDate, endDate, reason, userLocale } = {}) {
  const explicitPlace = normalizeDestinationPlace(destinationPlace, {
    resolutionSource: destinationPlace && destinationPlace.resolution_source,
  });
  const name = String(explicitPlace && explicitPlace.label ? explicitPlace.label : destination || '').trim();
  const { start, end } = clampDateRange(startDate, endDate);
  const month = Number((start || '').slice(5, 7)) || new Date().getUTCMonth() + 1;
  const selected = selectClimateRegion({ destination: name, month, userLocale });
  const metricReason = String(reason || 'unknown').trim().toLowerCase() || 'unknown';
  recordAuroraKbV0ClimateFallback({ reason: metricReason });

  const defaultSummary = buildDefaultSummaryForMonth(month);

  const summary = selected
    ? (() => {
      const profile = selected.profile || {};
      const archetype = String(selected.region && selected.region.archetype ? selected.region.archetype : '');
      const temps = mapArchetypeTemps(archetype, selected.month_bucket);
      return {
        temperature_max_c: temps.max,
        temperature_min_c: temps.min,
        temp_swing_c: mapTempSwingToC(profile.temp_swing),
        uv_index_max: mapUvLevelToIndex(profile.uv_level),
        humidity_mean: mapHumidityToMean(profile.humidity),
        precipitation_mm: mapPollutionToPrecipitation(profile.pollution, profile.humidity),
        wind_kph_max: mapWindToKph(profile.wind),
        days_count: 5,
      };
    })()
    : defaultSummary;
  return {
    ok: true,
    source: 'climate_fallback',
    destination: name || null,
    reason: metricReason,
    date_range: { start, end },
    location: {
      name: name || null,
      latitude: explicitPlace ? explicitPlace.latitude : null,
      longitude: explicitPlace ? explicitPlace.longitude : null,
      timezone: explicitPlace ? explicitPlace.timezone : null,
      country: explicitPlace ? explicitPlace.country : null,
      country_code: explicitPlace ? explicitPlace.country_code : null,
      admin1: explicitPlace ? explicitPlace.admin1 : null,
    },
    summary,
    forecast_window: [],
    data_freshness_utc: new Date().toISOString(),
    days_covered: 0,
    raw: {
      climate_profile: selected
        ? {
          region_id: String(selected.region.region_id || '').trim() || null,
          archetype: String(selected.region.archetype || '').trim() || null,
          month_bucket: selected.month_bucket,
          archetype_selected_by: selected.selected_by || 'default',
        }
        : {
          region_id: null,
          archetype: null,
          month_bucket: nearestMonthBucket(month),
          archetype_selected_by: 'default',
        },
    },
  };
}

async function getTravelWeather({
  destination,
  destinationPlace,
  startDate,
  endDate,
  userLocale,
  fetchImpl = global.fetch,
  geocodeTimeoutMs = 1600,
  forecastTimeoutMs = 1800,
} = {}) {
  const explicitPlace = normalizeDestinationPlace(destinationPlace, {
    resolutionSource: destinationPlace && destinationPlace.resolution_source,
  });
  const name = String(explicitPlace && explicitPlace.label ? explicitPlace.label : destination || '').trim();
  const { start, end } = clampDateRange(startDate, endDate);
  const fallback = (reason) => safeClimateFallback({
    destination: name,
    destinationPlace: explicitPlace,
    startDate: start,
    endDate: end,
    reason,
    userLocale,
  });

  try {
    if (!name) {
      return safeClimateFallback({
        destination: '',
        destinationPlace: explicitPlace,
        startDate: start,
        endDate: end,
        reason: 'destination_missing',
        userLocale,
      });
    }
    const dateRange = { start, end };

    if (typeof fetchImpl !== 'function') {
      return {
        ...fallback('fetch_unavailable'),
        reason: 'fetch_unavailable',
      };
    }

    let resolvedPlace = explicitPlace;
    if (!resolvedPlace) {
      const geocode = await resolveDestinationInput({
        destination: name,
        destinationPlace: null,
        userLocale,
        fetchImpl,
        timeoutMs: geocodeTimeoutMs,
        count: 8,
      });
      if (!geocode.ok) {
        return {
          ...fallback(geocode.reason || 'geocode_failed'),
          reason: geocode.reason || 'geocode_failed',
        };
      }
      if (geocode.ambiguous || !geocode.resolved_place) {
        const reason = geocode.ambiguous ? 'destination_ambiguous' : geocode.reason || 'geocode_no_results';
        if (geocode.ambiguous) {
          return buildPendingDestinationClarification({
            destination: name,
            destinationPlace: explicitPlace,
            startDate: start,
            endDate: end,
            reason,
            normalizedQuery: geocode.normalized_query,
            candidates: geocode.candidates,
          });
        }
        return {
          ...fallback(reason),
          reason,
        };
      }
      resolvedPlace = geocode.resolved_place;
    }

    const lat = Number(resolvedPlace && resolvedPlace.latitude);
    const lon = Number(resolvedPlace && resolvedPlace.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {
        ...fallback('geocode_no_results'),
        reason: 'geocode_no_results',
      };
    }

    const forecastUrl = `${OPEN_METEO_FORECAST_URL}?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean,weather_code` +
      `&timezone=auto&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;

    const forecast = await callJson(forecastUrl, fetchImpl, forecastTimeoutMs);
    if (!forecast.ok || !forecast.data || typeof forecast.data !== 'object') {
      return {
        ...fallback(`forecast_${forecast.reason || 'failed'}`),
        reason: `forecast_${forecast.reason || 'failed'}`,
      };
    }

    const summary = buildWeatherSummary(forecast.data.daily || {});
    const forecastWindow = buildForecastWindow(forecast.data.daily || {});

    return {
      ok: true,
      source: 'weather_api',
      reason: 'weather_api_ok',
      destination: resolvedPlace && resolvedPlace.label ? resolvedPlace.label : name,
      date_range: dateRange,
      location: {
        name: String((resolvedPlace && resolvedPlace.label) || name),
        latitude: lat,
        longitude: lon,
        timezone: String(forecast.data.timezone || (resolvedPlace && resolvedPlace.timezone) || ''),
        country: String((resolvedPlace && resolvedPlace.country) || ''),
        country_code: String((resolvedPlace && resolvedPlace.country_code) || ''),
        admin1: String((resolvedPlace && resolvedPlace.admin1) || ''),
      },
      summary,
      forecast_window: forecastWindow,
      data_freshness_utc: new Date().toISOString(),
      days_covered: forecastWindow.length,
      raw: {
        daily: forecast.data.daily || null,
        generationtime_ms: forecast.data.generationtime_ms || null,
      },
    };
  } catch (err) {
    const fallbackReason = err && err.name === 'AbortError' ? 'unexpected_abort' : 'unexpected_exception';
    return {
      ...fallback(fallbackReason),
      reason: fallbackReason,
    };
  }
}

module.exports = {
  getTravelWeather,
  climateFallback,
  buildPendingDestinationClarification,
  __internal: {
    buildWeatherSummary,
    buildForecastWindow,
    clampDateRange,
    mapWeatherCodeToConditionText,
    buildSyntheticForecastWindow,
  },
};
