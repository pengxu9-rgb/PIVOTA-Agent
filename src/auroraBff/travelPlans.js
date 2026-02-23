const crypto = require('crypto');

const DATE_TOKEN_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TRAVEL_PLANS = 20;

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

function normalizeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return typeof maxLen === 'number' && maxLen > 0 ? text.slice(0, maxLen) : text;
}

function clampRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
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

  const destination = normalizeText(raw.destination, 100);
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
  const destination = normalizeText(plan.destination, 100);
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
  const updatedAtMs = Math.max(createdAtMs, updatedRaw);

  return {
    trip_id: tripId,
    destination: base.destination,
    start_date: base.start_date,
    end_date: base.end_date,
    ...(base.indoor_outdoor_ratio != null ? { indoor_outdoor_ratio: base.indoor_outdoor_ratio } : {}),
    ...(base.itinerary ? { itinerary: base.itinerary } : {}),
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
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
  const nonExpired = plans.filter((plan) => !isTravelPlanExpired(plan, { nowMs }));
  const inRange = nonExpired
    .filter((plan) => plan.start_date <= nowDate && nowDate <= plan.end_date)
    .sort((a, b) => Number(b.updated_at_ms || 0) - Number(a.updated_at_ms || 0));
  if (inRange.length) {
    return { trip: inRange[0], mode: 'in_range', non_expired_plans: nonExpired, expired_count: plans.length - nonExpired.length };
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
      expired_count: plans.length - nonExpired.length,
    };
  }

  return { trip: null, mode: 'none', non_expired_plans: nonExpired, expired_count: plans.length - nonExpired.length };
}

function toLegacyTravelPlan(trip) {
  if (!isPlainObject(trip)) return null;
  const destination = normalizeText(trip.destination, 100);
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
    out[matchIndex] = {
      ...prev,
      ...legacyTrip,
      trip_id: prev.trip_id || legacyTrip.trip_id,
      created_at_ms: Math.min(Number(prev.created_at_ms || nowMs), Number(legacyTrip.created_at_ms || nowMs)),
      updated_at_ms: Math.max(Number(prev.updated_at_ms || nowMs), Number(legacyTrip.updated_at_ms || nowMs)),
    };
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
  const destination = normalizeText(extraction.destination, 100);
  const startDate = normalizeDateToken(extraction.start_date || extraction.startDate);
  const endDate = normalizeDateToken(extraction.end_date || extraction.endDate);
  const itinerary = normalizeText(extraction.itinerary, 1200);
  const ratio = clampRatio(extraction.indoor_outdoor_ratio);

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
  toLegacyTravelPlan,
  applyTravelExtractionToProfile,
  __internal: {
    isTravelPlanComplete,
    isTravelPlanExpired,
    normalizeTravelPlanItem,
    mergeLegacyTravelPlanIntoTravelPlans,
    normalizeDateToken,
    parseDateStartMs,
  },
};
