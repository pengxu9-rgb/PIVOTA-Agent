const crypto = require('crypto');

const DATE_TOKEN_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TRAVEL_PLANS = 20;
const NON_DESTINATION_HINT_RE = /\b(weather|climate|this week|next week|this month|next month|today|tomorrow|tonight|skincare|routine|plan)\b/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toIsoDateUtc(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDateToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return DATE_TOKEN_RE.test(token) ? token : '';
}

function parseDateStartMs(dateToken) {
  const token = normalizeDateToken(dateToken);
  if (!token) return null;
  const ts = Date.parse(`${token}T00:00:00.000Z`);
  return Number.isFinite(ts) ? ts : null;
}

function diffDays(targetDateToken, fromDateToken) {
  const targetMs = parseDateStartMs(targetDateToken);
  const fromMs = parseDateStartMs(fromDateToken);
  if (!Number.isFinite(targetMs) || !Number.isFinite(fromMs)) return null;
  return Math.round((targetMs - fromMs) / DAY_MS);
}

function normalizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return typeof maxLen === 'number' && maxLen > 0 ? text.slice(0, maxLen) : text;
}

function normalizeDestinationText(value, maxLen = 100) {
  const text = normalizeText(value, maxLen);
  if (!text) return '';
  if (!/[A-Za-z\u00C0-\u024F\u4E00-\u9FFF]/.test(text)) return '';
  if (NON_DESTINATION_HINT_RE.test(text)) return '';
  return text;
}

function clampRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function coerceBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return fallback;
  const t = value.trim().toLowerCase();
  if (!t) return fallback;
  if (t === 'true' || t === '1' || t === 'yes' || t === 'y' || t === 'on') return true;
  if (t === 'false' || t === '0' || t === 'no' || t === 'n' || t === 'off') return false;
  return fallback;
}

function safeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.trunc(Number(fallback) || Date.now());
  return Math.trunc(n);
}

function buildTripId() {
  if (typeof crypto.randomUUID === 'function') return `trip_${crypto.randomUUID()}`;
  return `trip_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeLegacyTravelPlan(raw) {
  if (!isPlainObject(raw)) return null;

  const destination = normalizeDestinationText(raw.destination, 100);
  const startDate = normalizeDateToken(raw.start_date);
  let endDate = normalizeDateToken(raw.end_date);
  const ratio = clampRatio(raw.indoor_outdoor_ratio);
  const itinerary = normalizeText(raw.itinerary, 1200);
  const tripId = normalizeText(raw.trip_id, 80);
  const createdAt = Number.isFinite(Number(raw.created_at_ms)) ? safeInt(raw.created_at_ms, Date.now()) : null;
  const updatedAt = Number.isFinite(Number(raw.updated_at_ms)) ? safeInt(raw.updated_at_ms, Date.now()) : null;

  // Keep partial legacy data, but discard obviously invalid reversed ranges.
  if (startDate && endDate && startDate > endDate) endDate = '';

  const out = {
    ...(destination ? { destination } : {}),
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(ratio != null ? { indoor_outdoor_ratio: ratio } : {}),
    ...(itinerary ? { itinerary } : {}),
    ...(tripId ? { trip_id: tripId } : {}),
    ...(createdAt != null ? { created_at_ms: createdAt } : {}),
    ...(updatedAt != null ? { updated_at_ms: updatedAt } : {}),
  };
  return Object.keys(out).length ? out : null;
}

function isTravelPlanComplete(plan) {
  if (!isPlainObject(plan)) return false;
  const destination = normalizeDestinationText(plan.destination, 100);
  const startDate = normalizeDateToken(plan.start_date);
  const endDate = normalizeDateToken(plan.end_date);
  if (!destination || !startDate || !endDate) return false;
  return startDate <= endDate;
}

function normalizeTravelPlanItem(raw, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const base = normalizeLegacyTravelPlan(raw);
  if (!base || !isTravelPlanComplete(base)) return null;

  const tripId = normalizeText(raw && raw.trip_id, 80) || buildTripId();
  const createdAtMs = safeInt(raw && raw.created_at_ms, nowMs);
  const updatedRaw = safeInt(raw && raw.updated_at_ms, createdAtMs);
  const isArchived = coerceBoolean(raw && raw.is_archived, false);
  const archivedAtRaw = raw && Number.isFinite(Number(raw.archived_at_ms))
    ? safeInt(raw.archived_at_ms, updatedRaw)
    : null;
  const archivedAtMs = isArchived ? Math.max(createdAtMs, archivedAtRaw != null ? archivedAtRaw : updatedRaw) : null;
  const updatedAtMs = Math.max(createdAtMs, updatedRaw, archivedAtMs != null ? archivedAtMs : 0);

  return {
    trip_id: tripId,
    destination: base.destination,
    start_date: base.start_date,
    end_date: base.end_date,
    ...(base.indoor_outdoor_ratio != null ? { indoor_outdoor_ratio: base.indoor_outdoor_ratio } : {}),
    ...(base.itinerary ? { itinerary: base.itinerary } : {}),
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    is_archived: isArchived,
    ...(archivedAtMs != null ? { archived_at_ms: archivedAtMs } : {}),
  };
}

function isTravelPlanExpired(plan, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const endStartMs = parseDateStartMs(plan && plan.end_date);
  if (!Number.isFinite(endStartMs)) return true;
  // expire at (end_date + 24h) using date granularity.
  const expiresAtMs = endStartMs + 2 * DAY_MS;
  return nowMs > expiresAtMs;
}

function normalizeTravelPlans(rawPlans, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(1, Math.min(100, Math.trunc(Number(options.maxItems))))
    : DEFAULT_MAX_TRAVEL_PLANS;
  const incoming = Array.isArray(rawPlans) ? rawPlans : [];
  const dedup = new Map();

  for (const raw of incoming) {
    const norm = normalizeTravelPlanItem(raw, { nowMs });
    if (!norm) continue;
    const prev = dedup.get(norm.trip_id);
    if (!prev || Number(norm.updated_at_ms || 0) >= Number(prev.updated_at_ms || 0)) {
      dedup.set(norm.trip_id, norm);
    }
  }

  let plans = Array.from(dedup.values()).sort((a, b) => Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0));
  if (plans.length <= maxItems) return plans;

  // Trim policy: drop oldest expired first, then oldest overall.
  const working = plans.slice();
  const expiredByOldest = working
    .filter((plan) => isTravelPlanExpired(plan, { nowMs }))
    .sort((a, b) => Number(a.updated_at_ms || 0) - Number(b.updated_at_ms || 0));

  const removeByTripId = (tripId) => {
    const idx = working.findIndex((plan) => String(plan.trip_id || '') === String(tripId || ''));
    if (idx >= 0) working.splice(idx, 1);
  };

  for (const plan of expiredByOldest) {
    if (working.length <= maxItems) break;
    removeByTripId(plan.trip_id);
  }

  if (working.length > maxItems) {
    working.sort((a, b) => Number(a.updated_at_ms || 0) - Number(b.updated_at_ms || 0));
    while (working.length > maxItems) working.shift();
  }

  plans = working.sort((a, b) => Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0));
  return plans;
}

function selectActiveTrip(rawPlans, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const plans = normalizeTravelPlans(rawPlans, { nowMs, maxItems: 100 });
  const nowDate = normalizeDateToken(options.nowDate) || toIsoDateUtc(new Date(nowMs));
  const nonArchived = plans.filter((plan) => !plan.is_archived);
  const nonExpired = nonArchived.filter((plan) => !isTravelPlanExpired(plan, { nowMs }));
  const expiredCount = nonArchived.length - nonExpired.length;
  const archivedCount = plans.length - nonArchived.length;
  const inRange = nonExpired
    .filter((plan) => plan.start_date <= nowDate && nowDate <= plan.end_date)
    .sort((a, b) => Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0));
  if (inRange.length) {
    return {
      trip: inRange[0],
      mode: 'in_range',
      non_expired_plans: nonExpired,
      expired_count: expiredCount,
      archived_count: archivedCount,
    };
  }

  const upcoming = nonExpired
    .filter((plan) => plan.start_date > nowDate)
    .sort((a, b) => {
      const byStart = String(a.start_date).localeCompare(String(b.start_date));
      if (byStart !== 0) return byStart;
      return Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0);
    });
  if (upcoming.length) {
    return {
      trip: upcoming[0],
      mode: 'nearest_upcoming',
      non_expired_plans: nonExpired,
      expired_count: expiredCount,
      archived_count: archivedCount,
    };
  }

  return {
    trip: null,
    mode: 'none',
    non_expired_plans: nonExpired,
    expired_count: expiredCount,
    archived_count: archivedCount,
  };
}

function computeTravelPlanStatus(plan, options = {}) {
  if (!isPlainObject(plan)) return 'upcoming';
  if (coerceBoolean(plan.is_archived, false)) return 'archived';
  const nowMs = safeInt(options.nowMs, Date.now());
  const nowDate = normalizeDateToken(options.nowDate) || toIsoDateUtc(new Date(nowMs));
  const startDate = normalizeDateToken(plan.start_date);
  const endDate = normalizeDateToken(plan.end_date);
  if (startDate && endDate) {
    if (nowDate < startDate) return 'upcoming';
    if (nowDate > endDate) return 'completed';
    return 'in_trip';
  }
  return 'upcoming';
}

function buildPrepChecklist(plan, options = {}) {
  const lang = String(options.lang || 'EN').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
  const status = computeTravelPlanStatus(plan, options);
  const ratio = clampRatio(plan && plan.indoor_outdoor_ratio);
  const itinerary = normalizeText(plan && plan.itinerary, 1200);
  const itineraryLower = itinerary.toLowerCase();
  const hasFlightCue = /(flight|air|red eye|red-eye|plane|机场|航班|飞行)/i.test(itinerary);
  const highOutdoor = ratio != null && ratio >= 0.6;
  const startDate = normalizeDateToken(plan && plan.start_date);
  const endDate = normalizeDateToken(plan && plan.end_date);
  const spanDaysRaw =
    startDate && endDate && Number.isFinite(parseDateStartMs(startDate)) && Number.isFinite(parseDateStartMs(endDate))
      ? Math.max(1, Math.round((parseDateStartMs(endDate) - parseDateStartMs(startDate)) / DAY_MS) + 1)
      : 0;
  const longTrip = spanDaysRaw >= 7;
  const destination = normalizeDestinationText(plan && plan.destination, 100);
  const homeRegion = normalizeText(options.homeRegion, 120);
  const crossRegion = Boolean(destination && homeRegion && destination.toLowerCase() !== homeRegion.toLowerCase());

  const out = [];
  const add = (cn, en) => out.push(lang === 'CN' ? cn : en);

  if (status === 'upcoming') {
    add('出发前 48 小时避免新上高刺激活性（强酸/高浓维A）。', 'Avoid introducing strong actives 48h before departure.');
    add('准备基础三件套：温和洁面、保湿修护、防晒。', 'Pack the core trio: gentle cleanser, moisturizer, and sunscreen.');
    add('先做局部试用，确认新产品不过敏。', 'Patch-test any new products before travel.');
  } else if (status === 'in_trip') {
    add('白天严格防晒并按需补涂。', 'Prioritize daytime UV protection and reapply sunscreen.');
    add('夜间以修护保湿为主，避免过度去角质。', 'Keep PM routine barrier-focused and avoid over-exfoliation.');
    add('若出现刺痛/泛红，立即切换到简化护理。', 'If irritation appears, switch to a simplified routine immediately.');
  } else if (status === 'completed') {
    add('返程后 2-3 天先做修护，减少高刺激活性。', 'For 2-3 days after the trip, focus on recovery and reduce strong actives.');
    add('观察皮肤状态再逐步恢复常规节奏。', 'Resume your usual routine gradually based on skin tolerance.');
  }

  if (highOutdoor) {
    add('户外比例高：准备防晒补涂工具（帽子/太阳镜/便携防晒）。', 'High outdoor exposure: prepare sun-protection extras (hat/sunglasses/portable SPF).');
  }
  if (hasFlightCue) {
    add('飞行日增加保湿与饮水，避免机舱环境导致屏障受损。', 'On flight days, increase hydration and keep barrier care simple.');
  }
  if (longTrip) {
    add('行程较长：准备旅行装与补给清单，避免中途断货。', 'Long trip: pack travel-size backups to avoid running out mid-trip.');
  }
  if (crossRegion) {
    add('跨地区气候变化明显：前 2-3 天优先低风险稳态方案。', 'For climate transitions, use a conservative routine for the first 2-3 days.');
  }
  if (/ski|snow|high uv|beach|沙滩|滑雪|暴晒|强紫外/.test(itineraryLower)) {
    add('高紫外场景：提高防晒等级并增加晒后舒缓。', 'High-UV scenario: strengthen UV defense and add post-sun soothing.');
  }

  const dedup = [];
  const seen = new Set();
  for (const item of out) {
    const key = String(item).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(key);
    if (dedup.length >= 8) break;
  }
  return dedup;
}

function compareTravelPlansForDisplay(a, b) {
  const rank = (status) => {
    if (status === 'in_trip') return 0;
    if (status === 'upcoming') return 1;
    if (status === 'completed') return 2;
    if (status === 'archived') return 3;
    return 4;
  };
  const statusA = computeTravelPlanStatus(a);
  const statusB = computeTravelPlanStatus(b);
  const byRank = rank(statusA) - rank(statusB);
  if (byRank !== 0) return byRank;

  if (statusA === 'upcoming') {
    const byStart = String(a.start_date || '').localeCompare(String(b.start_date || ''));
    if (byStart !== 0) return byStart;
  } else if (statusA === 'completed') {
    const byEndDesc = String(b.end_date || '').localeCompare(String(a.end_date || ''));
    if (byEndDesc !== 0) return byEndDesc;
  } else if (statusA === 'archived') {
    const byArchivedDesc = Number(b.archived_at_ms || 0) - Number(a.archived_at_ms || 0);
    if (byArchivedDesc !== 0) return byArchivedDesc;
  } else if (statusA === 'in_trip') {
    const byEnd = String(a.end_date || '').localeCompare(String(b.end_date || ''));
    if (byEnd !== 0) return byEnd;
  }

  return Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0);
}

function listTravelPlansForView(profile, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const nowDate = normalizeDateToken(options.nowDate) || toIsoDateUtc(new Date(nowMs));
  const includeArchived = coerceBoolean(options.includeArchived, false);
  const lang = String(options.lang || 'EN').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
  const state = resolveTravelPlansState(profile, { nowMs, maxItems: options.maxItems });

  const enriched = state.travel_plans.map((plan) => {
    const status = computeTravelPlanStatus(plan, { nowMs, nowDate });
    return {
      ...plan,
      status,
      days_to_start: diffDays(plan.start_date, nowDate),
      days_to_end: diffDays(plan.end_date, nowDate),
      prep_checklist: buildPrepChecklist(plan, { nowMs, nowDate, lang, homeRegion: state.home_region }),
    };
  });

  const visiblePlans = enriched
    .filter((plan) => (includeArchived ? true : !plan.is_archived))
    .sort(compareTravelPlansForDisplay);

  const counts = { in_trip: 0, upcoming: 0, completed: 0, archived: 0 };
  for (const plan of enriched) {
    const key = plan.status;
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
  }

  return {
    plans: visiblePlans,
    summary: {
      active_trip_id: state.active_trip ? state.active_trip.trip_id : null,
      counts,
    },
  };
}

function toLegacyTravelPlan(trip) {
  if (!isPlainObject(trip)) return null;
  const destination = normalizeDestinationText(trip.destination, 100);
  const startDate = normalizeDateToken(trip.start_date);
  const endDate = normalizeDateToken(trip.end_date);
  if (!destination && !startDate && !endDate) return null;
  const ratio = clampRatio(trip.indoor_outdoor_ratio);
  const itinerary = normalizeText(trip.itinerary, 1200);
  const tripId = normalizeText(trip.trip_id, 80);
  const createdAt = Number.isFinite(Number(trip.created_at_ms)) ? safeInt(trip.created_at_ms, Date.now()) : null;
  const updatedAt = Number.isFinite(Number(trip.updated_at_ms)) ? safeInt(trip.updated_at_ms, Date.now()) : null;
  return {
    ...(destination ? { destination } : {}),
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(ratio != null ? { indoor_outdoor_ratio: ratio } : {}),
    ...(itinerary ? { itinerary } : {}),
    ...(tripId ? { trip_id: tripId } : {}),
    ...(createdAt != null ? { created_at_ms: createdAt } : {}),
    ...(updatedAt != null ? { updated_at_ms: updatedAt } : {}),
  };
}

function mergeLegacyTravelPlanIntoTravelPlans(travelPlans, legacyTravelPlan, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(1, Math.min(100, Math.trunc(Number(options.maxItems))))
    : DEFAULT_MAX_TRAVEL_PLANS;
  const basePlans = normalizeTravelPlans(travelPlans, { nowMs, maxItems: 100 });
  const legacy = normalizeLegacyTravelPlan(legacyTravelPlan);
  if (!legacy || !isTravelPlanComplete(legacy)) {
    return normalizeTravelPlans(basePlans, { nowMs, maxItems });
  }

  const legacyTrip = normalizeTravelPlanItem(legacy, { nowMs });
  if (!legacyTrip) return normalizeTravelPlans(basePlans, { nowMs, maxItems });

  const out = basePlans.slice();
  const matchIndex = out.findIndex((plan) => {
    if (legacyTrip.trip_id && plan.trip_id === legacyTrip.trip_id) return true;
    return (
      String(plan.destination || '').toLowerCase() === String(legacyTrip.destination || '').toLowerCase() &&
      String(plan.start_date || '') === String(legacyTrip.start_date || '') &&
      String(plan.end_date || '') === String(legacyTrip.end_date || '')
    );
  });

  if (matchIndex >= 0) {
    const prev = out[matchIndex];
    const prevUpdatedAt = Number(prev.updated_at_ms || 0);
    const legacyUpdatedAt = Number(legacyTrip.updated_at_ms || 0);
    const preferLegacy = legacyUpdatedAt > prevUpdatedAt;
    const merged = preferLegacy ? { ...prev, ...legacyTrip } : { ...legacyTrip, ...prev };
    const keepArchived = coerceBoolean(prev.is_archived, false) && !coerceBoolean(legacyTrip.is_archived, false);
    const nextArchived = keepArchived ? true : coerceBoolean(merged.is_archived, false);
    const nextArchivedAt = nextArchived
      ? Math.max(
          Number(prev.archived_at_ms || 0),
          Number(legacyTrip.archived_at_ms || 0),
          Number(merged.updated_at_ms || 0),
        )
      : null;

    const nextItem = {
      ...merged,
      trip_id: prev.trip_id || legacyTrip.trip_id,
      created_at_ms: Math.min(Number(prev.created_at_ms || nowMs), Number(legacyTrip.created_at_ms || nowMs)),
      updated_at_ms: Math.max(Number(prev.updated_at_ms || nowMs), Number(legacyTrip.updated_at_ms || nowMs)),
      is_archived: nextArchived,
    };
    if (nextArchivedAt != null) nextItem.archived_at_ms = nextArchivedAt;
    else delete nextItem.archived_at_ms;
    out[matchIndex] = nextItem;
  } else {
    out.push(legacyTrip);
  }

  return normalizeTravelPlans(out, { nowMs, maxItems });
}

function resolveTravelPlansState(profile, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(1, Math.min(100, Math.trunc(Number(options.maxItems))))
    : DEFAULT_MAX_TRAVEL_PLANS;
  const source = isPlainObject(profile) ? profile : {};

  const legacyRaw = isPlainObject(source.travel_plan)
    ? source.travel_plan
    : isPlainObject(source.travelPlan)
      ? source.travelPlan
      : null;
  const legacy = normalizeLegacyTravelPlan(legacyRaw);
  const mergedTravelPlans = mergeLegacyTravelPlanIntoTravelPlans(source.travel_plans, legacy, { nowMs, maxItems });
  const selected = selectActiveTrip(mergedTravelPlans, { nowMs });
  const activeTrip = selected.trip;
  const legacySnapshot = activeTrip ? toLegacyTravelPlan(activeTrip) : legacy;

  return {
    home_region: normalizeText(source.region, 120) || null,
    travel_plans: mergedTravelPlans,
    travel_plans_count: mergedTravelPlans.length,
    active_trip: activeTrip || null,
    active_mode: selected.mode,
    legacy_travel_plan: legacySnapshot || null,
    expired_count: selected.expired_count,
    archived_count: selected.archived_count,
  };
}

function normalizeTravelProfilePatch({ baseProfile, patch, options = {} } = {}) {
  const rawPatch = isPlainObject(patch) ? patch : {};
  const hasTravelPlansMutation = Object.prototype.hasOwnProperty.call(rawPatch, 'travel_plans');
  const hasTravelMutation =
    Object.prototype.hasOwnProperty.call(rawPatch, 'travel_plan') ||
    Object.prototype.hasOwnProperty.call(rawPatch, 'travelPlan') ||
    hasTravelPlansMutation;
  if (!hasTravelMutation) return rawPatch;

  const base = isPlainObject(baseProfile) ? baseProfile : {};
  const nowMs = safeInt(options.nowMs, Date.now());
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(1, Math.min(100, Math.trunc(Number(options.maxItems))))
    : DEFAULT_MAX_TRAVEL_PLANS;
  let merged = { ...base, ...rawPatch };

  // `/plans` first release is append-only. Keep existing trips and add incoming ones.
  if (hasTravelPlansMutation && Array.isArray(rawPatch.travel_plans)) {
    const baseState = resolveTravelPlansState(base, { nowMs, maxItems });
    merged = {
      ...merged,
      travel_plans: [...baseState.travel_plans, ...rawPatch.travel_plans],
    };
  }

  const state = resolveTravelPlansState(merged, { nowMs, maxItems });

  const out = { ...rawPatch };
  out.travel_plans = state.travel_plans;
  out.travel_plan = state.legacy_travel_plan;
  return out;
}

function applyTravelExtractionToProfile(profile, extraction = {}, options = {}) {
  const nowMs = safeInt(options.nowMs, Date.now());
  const maxItems = Number.isFinite(Number(options.maxItems))
    ? Math.max(1, Math.min(100, Math.trunc(Number(options.maxItems))))
    : DEFAULT_MAX_TRAVEL_PLANS;
  const source = isPlainObject(profile) ? profile : {};
  const currentState = resolveTravelPlansState(source, { nowMs, maxItems });
  const destination = normalizeDestinationText(extraction.destination, 100);
  const startDate = normalizeDateToken(extraction.start_date || extraction.startDate);
  const endDate = normalizeDateToken(extraction.end_date || extraction.endDate);
  const itinerary = normalizeText(extraction.itinerary, 1200);
  const ratio = clampRatio(extraction.indoor_outdoor_ratio);

  // Ignore empty/invalid extractions and avoid mutating profile state with metadata-only travel_plan objects.
  if (!destination && !startDate && !endDate && !itinerary && ratio == null) {
    return { nextProfile: source, patch: null, state: currentState };
  }

  const nextLegacy = {
    ...(isPlainObject(currentState.legacy_travel_plan) ? currentState.legacy_travel_plan : {}),
    ...(destination ? { destination } : {}),
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate ? { end_date: endDate } : {}),
    ...(itinerary ? { itinerary } : {}),
    ...(ratio != null ? { indoor_outdoor_ratio: ratio } : {}),
    updated_at_ms: nowMs,
  };

  const normalizedLegacy = normalizeLegacyTravelPlan(nextLegacy);
  if (!normalizedLegacy) {
    return { nextProfile: source, patch: null, state: currentState };
  }

  const nextPlans = mergeLegacyTravelPlanIntoTravelPlans(currentState.travel_plans, normalizedLegacy, { nowMs, maxItems });
  const selected = selectActiveTrip(nextPlans, { nowMs });
  const syncedLegacy = selected.trip ? toLegacyTravelPlan(selected.trip) : normalizedLegacy;
  const patch = {
    travel_plan: syncedLegacy,
    travel_plans: nextPlans,
  };
  const nextProfile = { ...source, ...patch };
  const nextState = resolveTravelPlansState(nextProfile, { nowMs, maxItems });
  return { nextProfile, patch, state: nextState };
}

module.exports = {
  DEFAULT_MAX_TRAVEL_PLANS,
  normalizeLegacyTravelPlan,
  normalizeTravelPlans,
  normalizeTravelProfilePatch,
  resolveTravelPlansState,
  selectActiveTrip,
  computeTravelPlanStatus,
  buildPrepChecklist,
  listTravelPlansForView,
  toLegacyTravelPlan,
  applyTravelExtractionToProfile,
  __internal: {
    isTravelPlanComplete,
    isTravelPlanExpired,
    normalizeTravelPlanItem,
    mergeLegacyTravelPlanIntoTravelPlans,
    normalizeDateToken,
    parseDateStartMs,
    diffDays,
    coerceBoolean,
    compareTravelPlansForDisplay,
  },
};
