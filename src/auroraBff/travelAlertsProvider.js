const VIGILANCE_ENTRY_URL = 'https://vigilance.meteofrance.fr/fr/paris';
const VIGILANCE_API_BASE = 'https://rwg.meteofrance.com/wsft/v3';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeLanguage(language) {
  const token = String(language || '').trim().toUpperCase();
  if (token === 'CN') return 'fr';
  return 'en';
}

function withTimeout(promise, timeoutMs) {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('timeout');
      err.code = 'timeout';
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function callJson(url, fetchImpl, timeoutMs, headers = {}) {
  try {
    const res = await withTimeout(
      fetchImpl(url, {
        method: 'GET',
        headers,
      }),
      timeoutMs,
    );
    if (!res || !res.ok) {
      return {
        ok: false,
        reason: `http_${res && Number.isFinite(Number(res.status)) ? Number(res.status) : 0}`,
        data: null,
      };
    }
    const data = await res.json();
    return { ok: true, reason: null, data };
  } catch (err) {
    const code = String((err && err.code) || '').trim().toLowerCase();
    return {
      ok: false,
      reason: code === 'timeout' ? 'timeout' : 'network_error',
      data: null,
    };
  }
}

function decodeRot13(value) {
  return String(value || '').replace(/[a-zA-Z]/g, (char) => {
    const code = char.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(base + ((code - base + 13) % 26));
  });
}

function extractMeteoFranceTokenFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') return '';

  let cookieValue = '';
  if (typeof headers.getSetCookie === 'function') {
    const cookies = headers.getSetCookie();
    if (Array.isArray(cookies) && cookies.length) cookieValue = cookies.join('; ');
  }
  if (!cookieValue && typeof headers.get === 'function') {
    cookieValue = String(headers.get('set-cookie') || '');
  }
  if (!cookieValue) return '';

  const match = cookieValue.match(/(?:^|[;,]\s*)mfsession=([^;,]+)/i);
  if (!match || !isNonEmptyString(match[1])) return '';
  return decodeRot13(match[1].trim());
}

async function getMeteoFranceBearerToken({ fetchImpl = global.fetch, timeoutMs = 2000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'fetch_unavailable', token: '' };
  }
  try {
    const res = await withTimeout(fetchImpl(VIGILANCE_ENTRY_URL, { method: 'GET' }), timeoutMs);
    if (!res || !res.ok) {
      return {
        ok: false,
        reason: `entry_http_${res && Number.isFinite(Number(res.status)) ? Number(res.status) : 0}`,
        token: '',
      };
    }
    const token = extractMeteoFranceTokenFromHeaders(res.headers);
    if (!token) return { ok: false, reason: 'token_missing', token: '' };
    return { ok: true, reason: null, token };
  } catch (err) {
    const code = String((err && err.code) || '').trim().toLowerCase();
    return {
      ok: false,
      reason: code === 'timeout' ? 'entry_timeout' : 'entry_network_error',
      token: '',
    };
  }
}

function toIsoFromEpochSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n * 1000).toISOString();
  } catch (_err) {
    return null;
  }
}

function normalizeSeverityFromColorId(colorIdRaw) {
  const colorId = Number(colorIdRaw);
  if (!Number.isFinite(colorId)) return null;
  if (colorId >= 4) return 'red';
  if (colorId === 3) return 'orange';
  if (colorId === 2) return 'yellow';
  return null;
}

function severityRank(severity) {
  if (severity === 'red') return 3;
  if (severity === 'orange') return 2;
  if (severity === 'yellow') return 1;
  return 0;
}

function buildPhenomenonNameMap(dictionaryPayload) {
  const out = new Map();
  const rows = Array.isArray(dictionaryPayload && dictionaryPayload.phenomenons)
    ? dictionaryPayload.phenomenons
    : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || row.phenomenon_id || '').trim();
    const name = String(row.name || row.label || '').trim();
    if (!id || !name) continue;
    out.set(id, name);
  }
  return out;
}

function inferFranceDomainId({ destination, preferredDomainId } = {}) {
  const preferred = String(preferredDomainId || '').trim().toUpperCase();
  if (/^\d{2}$/.test(preferred)) return preferred;
  if (preferred === 'FRA') return 'FRA';

  const text = String(destination || '').trim().toLowerCase();
  if (!text) return 'FRA';
  if (text.includes('paris')) return '75';
  return 'FRA';
}

function isFranceDestination({ destination, destinationCountry } = {}) {
  const country = String(destinationCountry || '').trim().toLowerCase();
  if (country === 'fr' || country === 'fra' || country.includes('france')) return true;

  const text = String(destination || '').trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes('france') ||
    text.includes('paris') ||
    text.includes('lyon') ||
    text.includes('marseille') ||
    text.includes('nice')
  );
}

function buildAlertsFromPayload({ warningFull, dictionary, destinationLabel, language }) {
  const phenomenonNameMap = buildPhenomenonNameMap(dictionary);
  const commentsText = Array.isArray(warningFull && warningFull.comments && warningFull.comments.text)
    ? warningFull.comments.text.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 2).join(' ')
    : '';
  const endValidity = toIsoFromEpochSeconds(warningFull && warningFull.end_validity_time);
  const updateAt = toIsoFromEpochSeconds(warningFull && warningFull.update_time);

  const timelapsByPhenomenon = new Map();
  const timelapsRows = Array.isArray(warningFull && warningFull.timelaps) ? warningFull.timelaps : [];
  for (const row of timelapsRows) {
    if (!row || typeof row !== 'object') continue;
    const phenomenonId = String(row.phenomenon_id || '').trim();
    if (!phenomenonId) continue;
    const items = Array.isArray(row.timelaps_items) ? row.timelaps_items : [];
    timelapsByPhenomenon.set(phenomenonId, items);
  }

  const phenomenonRows = Array.isArray(warningFull && warningFull.phenomenons_items)
    ? warningFull.phenomenons_items
    : [];
  const alerts = [];
  for (const row of phenomenonRows) {
    if (!row || typeof row !== 'object') continue;
    const phenomenonId = String(row.phenomenon_id || '').trim();
    if (!phenomenonId) continue;
    const severity = normalizeSeverityFromColorId(row.phenomenon_max_color_id);
    if (!severity) continue;

    const segments = Array.isArray(timelapsByPhenomenon.get(phenomenonId))
      ? timelapsByPhenomenon.get(phenomenonId)
      : [];
    let startAt = null;
    let endAt = null;
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      const segStart = toIsoFromEpochSeconds(seg.begin_time);
      const segEnd = toIsoFromEpochSeconds(seg.end_time);
      if (segStart && (!startAt || segStart < startAt)) startAt = segStart;
      if (segEnd && (!endAt || segEnd > endAt)) endAt = segEnd;
    }

    const phenomenonName = phenomenonNameMap.get(phenomenonId) || `Phenomenon ${phenomenonId}`;
    const title = language === 'CN'
      ? `官方预警：${phenomenonName}（${severity}）`
      : `Official alert: ${phenomenonName} (${severity})`;
    const actionHint = language === 'CN'
      ? '请在出行前和当天复核官方预警并调整户外安排。'
      : 'Re-check official alerts before outdoor plans and adjust exposure accordingly.';

    alerts.push({
      provider: 'Meteo-France Vigilance',
      severity,
      title,
      summary: commentsText || null,
      start_at: startAt || updateAt,
      end_at: endAt || endValidity,
      region: destinationLabel || null,
      action_hint: actionHint,
    });
  }

  alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return alerts.slice(0, 4);
}

async function getTravelAlerts({
  destination,
  destinationCountry,
  preferredDomainId,
  language = 'EN',
  fetchImpl = global.fetch,
  timeoutMs = 2200,
} = {}) {
  const destinationLabel = String(destination || '').trim() || null;
  if (!isFranceDestination({ destination: destinationLabel, destinationCountry })) {
    return {
      source: 'none',
      reason: 'unsupported_country',
      alerts: [],
      provider: 'none',
      domain: null,
      data_freshness_utc: new Date().toISOString(),
    };
  }

  const tokenRes = await getMeteoFranceBearerToken({ fetchImpl, timeoutMs });
  if (!tokenRes.ok || !tokenRes.token) {
    return {
      source: 'degraded',
      reason: tokenRes.reason || 'token_error',
      alerts: [],
      provider: 'meteo_france_vigilance',
      domain: null,
      data_freshness_utc: new Date().toISOString(),
    };
  }

  const lang = normalizeLanguage(language);
  const requestedDomain = inferFranceDomainId({
    destination: destinationLabel,
    preferredDomainId,
  });

  const callWarningForDomain = async (domain) => {
    const url = `${VIGILANCE_API_BASE}/warning/full?domain=${encodeURIComponent(domain)}&lang=${encodeURIComponent(lang)}`;
    return callJson(url, fetchImpl, timeoutMs, {
      Authorization: `Bearer ${tokenRes.token}`,
    });
  };

  let warningRes = await callWarningForDomain(requestedDomain);
  let usedDomain = requestedDomain;
  if (!warningRes.ok && requestedDomain !== 'FRA') {
    warningRes = await callWarningForDomain('FRA');
    usedDomain = 'FRA';
  }
  if (!warningRes.ok || !warningRes.data || typeof warningRes.data !== 'object') {
    return {
      source: 'degraded',
      reason: warningRes.reason || 'warning_fetch_failed',
      alerts: [],
      provider: 'meteo_france_vigilance',
      domain: usedDomain,
      data_freshness_utc: new Date().toISOString(),
    };
  }

  const dictUrl = `${VIGILANCE_API_BASE}/warning/dictionary?domain=FRA&lang=${encodeURIComponent(lang)}`;
  const dictRes = await callJson(dictUrl, fetchImpl, timeoutMs, {
    Authorization: `Bearer ${tokenRes.token}`,
  });
  const dictionary = dictRes.ok && dictRes.data && typeof dictRes.data === 'object' ? dictRes.data : {};

  const alerts = buildAlertsFromPayload({
    warningFull: warningRes.data,
    dictionary,
    destinationLabel,
    language: String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN',
  });

  return {
    source: 'official_api',
    reason: dictRes.ok ? 'live_ok' : 'dictionary_degraded',
    alerts,
    provider: 'meteo_france_vigilance',
    domain: usedDomain,
    data_freshness_utc: new Date().toISOString(),
  };
}

module.exports = {
  getTravelAlerts,
  __internal: {
    decodeRot13,
    extractMeteoFranceTokenFromHeaders,
    normalizeSeverityFromColorId,
    isFranceDestination,
    inferFranceDomainId,
    buildAlertsFromPayload,
  },
};
