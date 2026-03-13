const { buildRequestContext } = require('../requestContext');
const {
  TravelPlanCreateSchema,
  TravelPlanUpdateSchema,
  TravelPlanListQuerySchema,
} = require('../schemas');
const {
  getProfileForIdentity,
  upsertProfileForIdentity,
  appendActivityEventForIdentity,
} = require('../memoryStore');
const {
  listTravelPlansForView,
  normalizeTravelProfilePatch,
  resolveTravelPlansState,
} = require('../travelPlans');
const { resolveDestinationInput } = require('../destinationResolver');
const {
  recordAuroraRoute404,
  recordAuroraTravelPlansNonJson,
} = require('../visionMetrics');

function isTravelDateRangeValid(startDate, endDate) {
  const start = typeof startDate === 'string' ? startDate.trim() : '';
  const end = typeof endDate === 'string' ? endDate.trim() : '';
  if (!start || !end) return true;
  return start <= end;
}

function findTravelPlanByTripId(plans, tripId) {
  const id = String(tripId || '').trim();
  if (!id) return null;
  const list = Array.isArray(plans) ? plans : [];
  return list.find((plan) => String(plan && plan.trip_id ? plan.trip_id : '').trim() === id) || null;
}

function buildTravelPlanActivityPayload(plan) {
  const target = plan && typeof plan === 'object' ? plan : {};
  return {
    trip_id: typeof target.trip_id === 'string' ? target.trip_id : null,
    destination: typeof target.destination === 'string' ? target.destination : null,
    departure_region: typeof target.departure_region === 'string' ? target.departure_region : null,
    start_date: typeof target.start_date === 'string' ? target.start_date : null,
    end_date: typeof target.end_date === 'string' ? target.end_date : null,
    is_archived: Boolean(target.is_archived),
    itinerary: typeof target.itinerary === 'string' ? target.itinerary.slice(0, 220) : null,
    indoor_outdoor_ratio: Number.isFinite(Number(target.indoor_outdoor_ratio))
      ? Number(target.indoor_outdoor_ratio)
      : null,
  };
}

function getRouteUserLocale(req, ctx) {
  const acceptLanguage = req && req.headers ? String(req.headers['accept-language'] || '').trim() : '';
  if (acceptLanguage) return acceptLanguage;
  return String(ctx && ctx.lang ? ctx.lang : 'EN');
}

async function resolvePersistedPlace({
  text,
  place,
  ambiguityCode = 'DESTINATION_AMBIGUOUS',
  field = 'destination',
  userLocale,
  fetchImpl = global.fetch,
} = {}) {
  const placeText = typeof text === 'string' ? text.trim() : '';
  const resolution = await resolveDestinationInput({
    destination: placeText,
    destinationPlace: place,
    userLocale,
    fetchImpl,
  });

  if (resolution && resolution.ambiguous) {
    const err = new Error(ambiguityCode);
    err.status = 409;
    err.code = ambiguityCode;
    err.body = {
      error: ambiguityCode,
      field,
      normalized_query: resolution.normalized_query || placeText,
      candidates: Array.isArray(resolution.candidates) ? resolution.candidates : [],
    };
    throw err;
  }

  if (resolution && resolution.ok && resolution.resolved_place) {
    return {
      text: resolution.resolved_place.label || placeText,
      place: resolution.resolved_place,
    };
  }

  return {
    text: placeText,
    place: null,
  };
}

function toTravelPlansStorageError(err, classifyStorageError) {
  const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
  if (dbError) {
    return {
      status: 503,
      body: {
        error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : 'DB_UNAVAILABLE',
        ...(code ? { code } : {}),
      },
    };
  }

  const status =
    err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
      ? err.status
      : 500;

  return {
    status,
    body: {
      error: status >= 400 && status < 500 ? String((err && err.code) || 'BAD_REQUEST') : 'TRAVEL_PLANS_FAILED',
    },
  };
}

function normalizeTravelPlansRouteForMetrics(req) {
  const rawPath = `${String(req?.baseUrl || '').trim()}${String(req?.path || '').trim()}`.replace(/\/+$/, '') || '/v1/travel-plans';
  if (rawPath === '/v1/travel-plans') return '/v1/travel-plans';
  if (/^\/v1\/travel-plans\/[^/]+\/archive$/i.test(rawPath)) return '/v1/travel-plans/:trip_id/archive';
  if (/^\/v1\/travel-plans\/[^/]+$/i.test(rawPath)) return '/v1/travel-plans/:trip_id';
  return '/v1/travel-plans';
}

function mountTravelPlansResponseObserver(app, { logger } = {}) {
  app.use('/v1/travel-plans', (req, res, next) => {
    res.once('finish', () => {
      const route = normalizeTravelPlansRouteForMetrics(req);
      const status = Number(res.statusCode || 0);
      const contentType = String(res.getHeader('content-type') || '').toLowerCase();

      if (status === 404) {
        recordAuroraRoute404({ route });
      }

      if (!contentType.includes('application/json')) {
        recordAuroraTravelPlansNonJson({ route, status });
        logger?.warn?.(
          {
            route,
            status,
            content_type: contentType || null,
          },
          'travel plans route returned non-json response',
        );
      }
    });

    next();
  });
}

function ensureDependency(name, value) {
  if (typeof value === 'function') return value;
  throw new Error(`travel plans routes missing dependency: ${name}`);
}

function mountTravelPlansRoutes(app, deps = {}) {
  const logger = deps && typeof deps.logger === 'object' ? deps.logger : null;
  const requireAuroraUid = ensureDependency('requireAuroraUid', deps.requireAuroraUid);
  const resolveIdentity = ensureDependency('resolveIdentity', deps.resolveIdentity);
  const classifyStorageError = ensureDependency('classifyStorageError', deps.classifyStorageError);
  const appendActivity = typeof deps.appendActivityForIdentity === 'function'
    ? deps.appendActivityForIdentity
    : async ({
        auroraUid,
        userId,
        eventType,
        payload,
        deeplink,
        source,
        occurredAtMs,
      }) => appendActivityEventForIdentity(
        { auroraUid, userId },
        {
          event_type: eventType,
          payload,
          deeplink,
          source,
          occurred_at_ms: occurredAtMs,
        },
      );
  const saveActivityDetail = typeof deps.upsertActivityDetail === 'function'
    ? deps.upsertActivityDetail
    : null;

  mountTravelPlansResponseObserver(app, { logger });

  app.get('/v1/travel-plans', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = TravelPlanListQuerySchema.safeParse({
        include_archived:
          req.query && Object.prototype.hasOwnProperty.call(req.query, 'include_archived')
            ? req.query.include_archived
            : undefined,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.format() });
      }

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      });
      const out = listTravelPlansForView(profile, {
        includeArchived: parsed.data.include_archived,
        lang: ctx.lang,
      });
      return res.status(200).json(out);
    } catch (err) {
      const fail = toTravelPlansStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'travel plans list failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });

  app.get('/v1/travel-plans/:trip_id', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const tripId = String((req && req.params && req.params.trip_id) || '').trim();
      if (!tripId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      });
      const listOut = listTravelPlansForView(profile, {
        includeArchived: true,
        lang: ctx.lang,
      });
      const plan = findTravelPlanByTripId(listOut.plans, tripId);
      if (!plan) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });

      return res.status(200).json({ plan, summary: listOut.summary });
    } catch (err) {
      const fail = toTravelPlansStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'travel plans get failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });

  app.post('/v1/travel-plans', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = TravelPlanCreateSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.format() });
      }
      if (!isTravelDateRangeValid(parsed.data.start_date, parsed.data.end_date)) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: { date_range: 'start_date_must_be_before_or_equal_end_date' } });
      }

      const resolvedDestination = await resolvePersistedPlace({
        text: parsed.data.destination,
        place: parsed.data.destination_place,
        ambiguityCode: 'DESTINATION_AMBIGUOUS',
        field: 'destination',
        userLocale: getRouteUserLocale(req, ctx),
      });
      const resolvedDeparture = await resolvePersistedPlace({
        text: parsed.data.departure_region,
        place: parsed.data.departure_place,
        ambiguityCode: 'DEPARTURE_AMBIGUOUS',
        field: 'departure',
        userLocale: getRouteUserLocale(req, ctx),
      });

      const nowMs = Date.now();
      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      });
      const baseProfile = profile && typeof profile === 'object' ? profile : {};
      const baseState = resolveTravelPlansState(baseProfile, { nowMs });
      const baseTripIds = new Set(
        (Array.isArray(baseState.travel_plans) ? baseState.travel_plans : [])
          .map((plan) => String((plan && plan.trip_id) || '').trim())
          .filter(Boolean),
      );

      const normalizedPatch = normalizeTravelProfilePatch({
        baseProfile,
        patch: {
          travel_plans: [
            {
              destination: resolvedDestination.text || parsed.data.destination,
              ...(resolvedDestination.place ? { destination_place: resolvedDestination.place } : {}),
              departure_region: resolvedDeparture.text || parsed.data.departure_region,
              ...(resolvedDeparture.place ? { departure_place: resolvedDeparture.place } : {}),
              start_date: parsed.data.start_date,
              end_date: parsed.data.end_date,
              ...(Number.isFinite(Number(parsed.data.indoor_outdoor_ratio))
                ? { indoor_outdoor_ratio: Number(parsed.data.indoor_outdoor_ratio) }
                : {}),
              ...(typeof parsed.data.itinerary === 'string' && parsed.data.itinerary.trim()
                ? { itinerary: parsed.data.itinerary.trim() }
                : {}),
            },
          ],
        },
        options: { nowMs },
      });

      const normalizedPlans = Array.isArray(normalizedPatch && normalizedPatch.travel_plans)
        ? normalizedPatch.travel_plans
        : [];
      const createdCandidate =
        normalizedPlans
          .filter((plan) => !baseTripIds.has(String((plan && plan.trip_id) || '').trim()))
          .sort((a, b) => Number((b && b.updated_at_ms) || 0) - Number((a && a.updated_at_ms) || 0))[0] || null;
      const createdTripId = String((createdCandidate && createdCandidate.trip_id) || '').trim();

      const updated = await upsertProfileForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        normalizedPatch,
      );
      const listOut = listTravelPlansForView(updated, {
        includeArchived: true,
        lang: ctx.lang,
        nowMs,
      });

      let createdPlan = createdTripId ? findTravelPlanByTripId(listOut.plans, createdTripId) : null;
      if (!createdPlan) {
        createdPlan =
          (Array.isArray(listOut.plans) ? listOut.plans : []).find(
            (plan) =>
              String((plan && plan.destination) || '').trim() ===
                String(resolvedDestination.text || parsed.data.destination || '').trim() &&
              String((plan && plan.departure_region) || '').trim() ===
                String(resolvedDeparture.text || parsed.data.departure_region || '').trim() &&
              String((plan && plan.start_date) || '').trim() === String(parsed.data.start_date || '').trim() &&
              String((plan && plan.end_date) || '').trim() === String(parsed.data.end_date || '').trim(),
          ) || null;
      }
      if (!createdPlan && Array.isArray(listOut.plans) && listOut.plans.length > 0) {
        createdPlan = listOut.plans[0];
      }
      try {
        const payload = buildTravelPlanActivityPayload(createdPlan);
        const activity = await appendActivity({
          auroraUid: identity.auroraUid,
          userId: identity.userId,
          eventType: 'travel_plan_created',
          payload,
          deeplink: payload.trip_id ? `/plans/${encodeURIComponent(payload.trip_id)}` : '/plans',
          source: 'travel_plans_api',
          occurredAtMs: nowMs,
        });
        if (saveActivityDetail && activity && activity.activity_id) {
          await saveActivityDetail({
            activityId: activity.activity_id,
            detailKind: 'travel_plan',
            detailJson: payload,
          });
        }
      } catch (activityErr) {
        logger?.warn?.(
          {
            err: activityErr && activityErr.message ? activityErr.message : String(activityErr),
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          },
          'travel plans create activity append failed',
        );
      }

      return res.status(200).json({ plan: createdPlan || null, summary: listOut.summary });
    } catch (err) {
      if (err && (err.code === 'DESTINATION_AMBIGUOUS' || err.code === 'DEPARTURE_AMBIGUOUS') && err.body) {
        return res.status(409).json(err.body);
      }
      const fail = toTravelPlansStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'travel plans create failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });

  app.patch('/v1/travel-plans/:trip_id', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const tripId = String((req && req.params && req.params.trip_id) || '').trim();
      if (!tripId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const parsed = TravelPlanUpdateSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: parsed.error.format() });
      }

      const nowMs = Date.now();
      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      });
      const baseProfile = profile && typeof profile === 'object' ? profile : {};
      const state = resolveTravelPlansState(baseProfile, { nowMs });
      const existing = findTravelPlanByTripId(state.travel_plans, tripId);
      if (!existing) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });

      const mergedPlan = {
        ...existing,
        ...parsed.data,
        trip_id: existing.trip_id,
        created_at_ms: Number(existing.created_at_ms || nowMs),
        updated_at_ms: nowMs,
      };
      const destinationWasUpdated = Object.prototype.hasOwnProperty.call(parsed.data, 'destination');
      const destinationPlaceWasUpdated = Object.prototype.hasOwnProperty.call(parsed.data, 'destination_place');
      const departureWasUpdated = Object.prototype.hasOwnProperty.call(parsed.data, 'departure_region');
      const departurePlaceWasUpdated = Object.prototype.hasOwnProperty.call(parsed.data, 'departure_place');
      if (destinationWasUpdated || destinationPlaceWasUpdated) {
        const resolvedDestination = await resolvePersistedPlace({
          text:
            typeof mergedPlan.destination === 'string' && mergedPlan.destination.trim()
              ? mergedPlan.destination
              : existing.destination,
          place: destinationPlaceWasUpdated
            ? parsed.data.destination_place
            : destinationWasUpdated
              ? null
              : existing.destination_place,
          ambiguityCode: 'DESTINATION_AMBIGUOUS',
          field: 'destination',
          userLocale: getRouteUserLocale(req, ctx),
        });
        mergedPlan.destination = resolvedDestination.text || mergedPlan.destination;
        if (resolvedDestination.place) mergedPlan.destination_place = resolvedDestination.place;
        else delete mergedPlan.destination_place;
      }
      if (departureWasUpdated || departurePlaceWasUpdated) {
        const resolvedDeparture = await resolvePersistedPlace({
          text:
            typeof mergedPlan.departure_region === 'string' && mergedPlan.departure_region.trim()
              ? mergedPlan.departure_region
              : existing.departure_region,
          place: departurePlaceWasUpdated
            ? parsed.data.departure_place
            : departureWasUpdated
              ? null
              : existing.departure_place,
          ambiguityCode: 'DEPARTURE_AMBIGUOUS',
          field: 'departure',
          userLocale: getRouteUserLocale(req, ctx),
        });
        mergedPlan.departure_region = resolvedDeparture.text || mergedPlan.departure_region;
        if (resolvedDeparture.place) mergedPlan.departure_place = resolvedDeparture.place;
        else delete mergedPlan.departure_place;
      }
      if (!isTravelDateRangeValid(mergedPlan.start_date, mergedPlan.end_date)) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: { date_range: 'start_date_must_be_before_or_equal_end_date' } });
      }
      if (typeof mergedPlan.departure_region !== 'string' || !mergedPlan.departure_region.trim()) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: { departure_region: 'required' } });
      }
      if (parsed.data.is_archived === true) {
        mergedPlan.is_archived = true;
        mergedPlan.archived_at_ms = Math.max(Number(existing.archived_at_ms || 0), nowMs);
      } else if (parsed.data.is_archived === false) {
        mergedPlan.is_archived = false;
        delete mergedPlan.archived_at_ms;
      }

      const normalizedPatch = normalizeTravelProfilePatch({
        baseProfile,
        patch: { travel_plans: [mergedPlan] },
        options: { nowMs },
      });
      const updated = await upsertProfileForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        normalizedPatch,
      );
      const listOut = listTravelPlansForView(updated, {
        includeArchived: true,
        lang: ctx.lang,
        nowMs,
      });
      const nextPlan = findTravelPlanByTripId(listOut.plans, tripId);
      if (!nextPlan) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });
      try {
        const payload = buildTravelPlanActivityPayload(nextPlan);
        const activity = await appendActivity({
          auroraUid: identity.auroraUid,
          userId: identity.userId,
          eventType: 'travel_plan_updated',
          payload,
          deeplink: payload.trip_id ? `/plans/${encodeURIComponent(payload.trip_id)}` : '/plans',
          source: 'travel_plans_api',
          occurredAtMs: nowMs,
        });
        if (saveActivityDetail && activity && activity.activity_id) {
          await saveActivityDetail({
            activityId: activity.activity_id,
            detailKind: 'travel_plan',
            detailJson: payload,
          });
        }
      } catch (activityErr) {
        logger?.warn?.(
          {
            err: activityErr && activityErr.message ? activityErr.message : String(activityErr),
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          },
          'travel plans patch activity append failed',
        );
      }

      return res.status(200).json({ plan: nextPlan, summary: listOut.summary });
    } catch (err) {
      if (err && (err.code === 'DESTINATION_AMBIGUOUS' || err.code === 'DEPARTURE_AMBIGUOUS') && err.body) {
        return res.status(409).json(err.body);
      }
      const fail = toTravelPlansStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'travel plans patch failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });

  app.post('/v1/travel-plans/:trip_id/archive', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const tripId = String((req && req.params && req.params.trip_id) || '').trim();
      if (!tripId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const nowMs = Date.now();
      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({
        auroraUid: identity.auroraUid,
        userId: identity.userId,
      });
      const baseProfile = profile && typeof profile === 'object' ? profile : {};
      const state = resolveTravelPlansState(baseProfile, { nowMs });
      const existing = findTravelPlanByTripId(state.travel_plans, tripId);
      if (!existing) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });

      const archivedPlan = {
        ...existing,
        trip_id: existing.trip_id,
        is_archived: true,
        archived_at_ms: Math.max(Number(existing.archived_at_ms || 0), nowMs),
        updated_at_ms: nowMs,
      };

      const normalizedPatch = normalizeTravelProfilePatch({
        baseProfile,
        patch: { travel_plans: [archivedPlan] },
        options: { nowMs },
      });
      const updated = await upsertProfileForIdentity(
        { auroraUid: identity.auroraUid, userId: identity.userId },
        normalizedPatch,
      );
      const listOut = listTravelPlansForView(updated, {
        includeArchived: true,
        lang: ctx.lang,
        nowMs,
      });
      const nextPlan = findTravelPlanByTripId(listOut.plans, tripId);
      if (!nextPlan) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });
      try {
        const payload = buildTravelPlanActivityPayload(nextPlan);
        const activity = await appendActivity({
          auroraUid: identity.auroraUid,
          userId: identity.userId,
          eventType: 'travel_plan_archived',
          payload,
          deeplink: payload.trip_id ? `/plans/${encodeURIComponent(payload.trip_id)}` : '/plans',
          source: 'travel_plans_api',
          occurredAtMs: nowMs,
        });
        if (saveActivityDetail && activity && activity.activity_id) {
          await saveActivityDetail({
            activityId: activity.activity_id,
            detailKind: 'travel_plan',
            detailJson: payload,
          });
        }
      } catch (activityErr) {
        logger?.warn?.(
          {
            err: activityErr && activityErr.message ? activityErr.message : String(activityErr),
            request_id: ctx.request_id,
            trace_id: ctx.trace_id,
          },
          'travel plans archive activity append failed',
        );
      }

      return res.status(200).json({ plan: nextPlan, summary: listOut.summary });
    } catch (err) {
      const fail = toTravelPlansStorageError(err, classifyStorageError);
      logger?.warn?.(
        {
          err: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : null,
          status: fail.status,
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
        },
        'travel plans archive failed',
      );
      return res.status(fail.status).json(fail.body);
    }
  });
}

module.exports = {
  mountTravelPlansRoutes,
  __internal: {
    isTravelDateRangeValid,
    findTravelPlanByTripId,
    normalizeTravelPlansRouteForMetrics,
    toTravelPlansStorageError,
  },
};
