const OPEN_METEO_GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const EXACT_MATCH_AUTO_RESOLVE_GAP = 40;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function normalizeSearchToken(value) {
  const text = normalizeText(value, 200).toLowerCase();
  if (!text) return '';
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocaleLanguage(userLocaleRaw) {
  const raw = normalizeText(userLocaleRaw, 40).replace(/_/g, '-').toLowerCase();
  if (!raw) return '';
  if (raw === 'cn') return 'zh';
  const first = raw.split('-').filter(Boolean)[0] || '';
  if (first === 'cn') return 'zh';
  return /^[a-z]{2,3}$/.test(first) ? first : '';
}

function buildLanguageAttempts(userLocale) {
  const localeLanguage = normalizeLocaleLanguage(userLocale);
  const out = [];
  const push = (value) => {
    const token = normalizeText(value, 12).toLowerCase();
    if (out.includes(token)) return;
    out.push(token);
  };
  if (localeLanguage) push(localeLanguage);
  push('');
  push('en');
  return out;
}

function callJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve()
    .then(() => fetchImpl(url, { method: 'GET', signal: controller.signal }))
    .then(async (res) => {
      if (!res.ok) {
        return { ok: false, reason: `http_${res.status}`, data: null };
      }
      return { ok: true, reason: null, data: await res.json() };
    })
    .catch((err) => {
      const reason = err && err.name === 'AbortError' ? 'timeout' : 'network_error';
      return { ok: false, reason, data: null };
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}

function featureCodeWeight(featureCodeRaw) {
  const code = normalizeText(featureCodeRaw, 24).toUpperCase();
  if (code === 'PPLC' || code === 'PCLI') return 40;
  if (code === 'PPLA' || code === 'PPLA2') return 28;
  if (code === 'PPL' || code === 'PPLL') return 18;
  if (code === 'AIRP' || code === 'ISL' || code === 'MT') return -22;
  return 0;
}

function featureCodeLooksPlace(featureCodeRaw) {
  return featureCodeWeight(featureCodeRaw) > 0;
}

function populationBonus(populationRaw) {
  const population = Number(populationRaw);
  if (!Number.isFinite(population) || population <= 0) return 0;
  return Math.min(80, Math.round(Math.log10(population + 1) * 12));
}

function buildPlaceLabel({ name, admin1, country } = {}) {
  const parts = [];
  const push = (value) => {
    const token = normalizeText(value, 160);
    if (!token) return;
    if (parts.some((item) => item.toLowerCase() === token.toLowerCase())) return;
    parts.push(token);
  };
  push(name);
  push(admin1);
  push(country);
  return parts.join(', ');
}

function normalizeDestinationPlace(value, options = {}) {
  const row = isPlainObject(value) ? value : {};
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const canonicalName =
    normalizeText(row.canonical_name, 160) ||
    normalizeText(row.name, 160) ||
    normalizeText(row.label, 160);
  const country = normalizeText(row.country, 120);
  const admin1 = normalizeText(row.admin1, 120);
  const label =
    normalizeText(row.label, 160) ||
    buildPlaceLabel({
      name: canonicalName,
      admin1,
      country,
    });
  if (!canonicalName || !label) return null;

  const resolutionSourceRaw = normalizeText(
    row.resolution_source != null ? row.resolution_source : options.resolutionSource,
    40,
  ).toLowerCase();
  const resolutionSource = resolutionSourceRaw === 'user_selected' ? 'user_selected' : 'auto_resolved';

  return {
    label,
    canonical_name: canonicalName,
    latitude: Math.round(latitude * 100000) / 100000,
    longitude: Math.round(longitude * 100000) / 100000,
    country_code: normalizeText(row.country_code, 8).toUpperCase() || null,
    country: country || null,
    admin1: admin1 || null,
    timezone: normalizeText(row.timezone, 80) || null,
    resolution_source: resolutionSource,
  };
}

function scoreCandidate(row, queryKey) {
  const name = normalizeText(row.name, 160);
  const nameKey = normalizeSearchToken(name);
  const countryKey = normalizeSearchToken(row.country);
  const adminKey = normalizeSearchToken(row.admin1);
  const featureCode = normalizeText(row.feature_code, 24).toUpperCase();

  let score = 0;
  if (nameKey && queryKey && nameKey === queryKey) {
    score += 100;
  } else if (nameKey && queryKey && (nameKey.startsWith(queryKey) || queryKey.startsWith(nameKey))) {
    score += 36;
  } else if (
    queryKey &&
    (
      nameKey.includes(queryKey) ||
      queryKey.includes(nameKey) ||
      adminKey === queryKey ||
      countryKey === queryKey
    )
  ) {
    score += 18;
  }

  score += featureCodeWeight(featureCode);
  score += populationBonus(row.population);

  if (countryKey && queryKey && countryKey === queryKey) score += 24;
  if (adminKey && queryKey && adminKey === queryKey) score += 12;
  return score;
}

function normalizeRawCandidate(row, queryKey, resolutionSource = 'auto_resolved') {
  if (!isPlainObject(row)) return null;
  const place = normalizeDestinationPlace(
    {
      label: buildPlaceLabel({
        name: row.name,
        admin1: row.admin1,
        country: row.country,
      }),
      canonical_name: row.name,
      latitude: row.latitude,
      longitude: row.longitude,
      country_code: row.country_code,
      country: row.country,
      admin1: row.admin1,
      timezone: row.timezone,
      resolution_source: resolutionSource,
    },
    { resolutionSource },
  );
  if (!place) return null;
  return {
    ...place,
    _name_key: normalizeSearchToken(row.name),
    _score: scoreCandidate(row, queryKey),
    _feature_code: normalizeText(row.feature_code, 24).toUpperCase(),
    _population: Number.isFinite(Number(row.population)) ? Number(row.population) : 0,
  };
}

function stripInternalCandidateFields(candidate) {
  const out = { ...candidate };
  delete out._name_key;
  delete out._score;
  delete out._feature_code;
  delete out._population;
  return out;
}

function compareCandidates(a, b) {
  const scoreDelta = Number(b._score || 0) - Number(a._score || 0);
  if (scoreDelta !== 0) return scoreDelta;
  const populationDelta = Number(b._population || 0) - Number(a._population || 0);
  if (populationDelta !== 0) return populationDelta;
  return String(a.label || '').localeCompare(String(b.label || ''));
}

function dedupeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const out = [];
  for (const row of list) {
    if (!isPlainObject(row)) continue;
    const nameKey = normalizeSearchToken(row.name);
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!nameKey || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = [
      nameKey,
      String(Math.round(lat * 100000)),
      String(Math.round(lon * 100000)),
      normalizeText(row.country_code, 8).toUpperCase(),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function resolveDestinationQuery({
  query,
  userLocale,
  fetchImpl = global.fetch,
  timeoutMs = 1600,
  count = 8,
} = {}) {
  const normalizedQuery = normalizeText(query, 160);
  if (!normalizedQuery) {
    return {
      ok: false,
      ambiguous: false,
      normalized_query: '',
      resolved_place: null,
      candidates: [],
      reason: 'query_missing',
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      ambiguous: false,
      normalized_query: normalizedQuery,
      resolved_place: null,
      candidates: [],
      reason: 'fetch_unavailable',
    };
  }

  const queryKey = normalizeSearchToken(normalizedQuery);
  const attempts = buildLanguageAttempts(userLocale);
  let rawResults = [];
  let lastReason = 'geocode_no_results';

  for (const language of attempts) {
    const languageParam = language ? `&language=${encodeURIComponent(language)}` : '';
    const url = `${OPEN_METEO_GEOCODE_URL}?name=${encodeURIComponent(normalizedQuery)}&count=${Math.max(
      1,
      Math.min(10, Math.trunc(Number(count) || 8)),
    )}${languageParam}&format=json`;
    const result = await callJson(url, fetchImpl, timeoutMs);
    if (!result.ok) {
      lastReason = `geocode_${result.reason || 'failed'}`;
      continue;
    }
    const rows = Array.isArray(result.data && result.data.results) ? result.data.results : [];
    if (!rows.length) {
      lastReason = 'geocode_no_results';
      continue;
    }
    rawResults = rows;
    lastReason = 'ok';
    break;
  }

  if (!rawResults.length) {
    return {
      ok: false,
      ambiguous: false,
      normalized_query: normalizedQuery,
      resolved_place: null,
      candidates: [],
      reason: lastReason || 'geocode_no_results',
    };
  }

  const candidates = dedupeRows(rawResults)
    .map((row) => normalizeRawCandidate(row, queryKey))
    .filter(Boolean)
    .sort(compareCandidates);

  if (!candidates.length) {
    return {
      ok: false,
      ambiguous: false,
      normalized_query: normalizedQuery,
      resolved_place: null,
      candidates: [],
      reason: 'geocode_no_results',
    };
  }

  const exactPlaceMatches = candidates.filter(
    (candidate) => candidate._name_key === queryKey && featureCodeLooksPlace(candidate._feature_code),
  );
  if (exactPlaceMatches.length >= 2) {
    const rankedExactMatches = exactPlaceMatches.slice().sort(compareCandidates);
    const top = rankedExactMatches[0];
    const second = rankedExactMatches[1];
    const gap = Number(top._score || 0) - Number(second._score || 0);
    if (!(Number(top._score || 0) >= 180 && gap >= EXACT_MATCH_AUTO_RESOLVE_GAP)) {
      return {
        ok: true,
        ambiguous: true,
        normalized_query: normalizedQuery,
        resolved_place: null,
        candidates: rankedExactMatches.slice(0, 5).map(stripInternalCandidateFields),
        reason: 'destination_ambiguous',
      };
    }
  }

  return {
    ok: true,
    ambiguous: false,
    normalized_query: normalizedQuery,
    resolved_place: stripInternalCandidateFields(candidates[0]),
    candidates: candidates.slice(0, 5).map(stripInternalCandidateFields),
    reason: 'resolved',
  };
}

async function resolveDestinationInput({
  destination,
  destinationPlace,
  userLocale,
  fetchImpl = global.fetch,
  timeoutMs = 1600,
  count = 8,
} = {}) {
  const explicitPlace = normalizeDestinationPlace(destinationPlace, {
    resolutionSource: isPlainObject(destinationPlace) ? destinationPlace.resolution_source : undefined,
  });
  if (explicitPlace) {
    return {
      ok: true,
      ambiguous: false,
      normalized_query: normalizeText(destination, 160) || explicitPlace.label,
      resolved_place: explicitPlace,
      candidates: [explicitPlace],
      reason: 'provided',
    };
  }
  return resolveDestinationQuery({
    query: destination,
    userLocale,
    fetchImpl,
    timeoutMs,
    count,
  });
}

module.exports = {
  resolveDestinationQuery,
  resolveDestinationInput,
  normalizeDestinationPlace,
  __internal: {
    normalizeSearchToken,
    normalizeLocaleLanguage,
    buildLanguageAttempts,
    buildPlaceLabel,
    featureCodeWeight,
    populationBonus,
    scoreCandidate,
  },
};
