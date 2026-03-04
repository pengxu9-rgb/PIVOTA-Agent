const { buildRequestContext } = require('../requestContext');
const {
  TravelPlanCreateSchema,
  TravelPlanUpdateSchema,
  TravelPlanListQuerySchema,
} = require('../schemas');
const {
  getProfileForIdentity,
  upsertProfileForIdentity,
} = require('../memoryStore');
const {
  listTravelPlansForView,
  normalizeTravelProfilePatch,
  resolveTravelPlansState,
} = require('../travelPlans');
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
              destination: parsed.data.destination,
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
              String((plan && plan.destination) || '').trim() === String(parsed.data.destination || '').trim() &&
              String((plan && plan.start_date) || '').trim() === String(parsed.data.start_date || '').trim() &&
              String((plan && plan.end_date) || '').trim() === String(parsed.data.end_date || '').trim(),
          ) || null;
      }
      if (!createdPlan && Array.isArray(listOut.plans) && listOut.plans.length > 0) {
        createdPlan = listOut.plans[0];
      }

      return res.status(200).json({ plan: createdPlan || null, summary: listOut.summary });
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
      if (!isTravelDateRangeValid(mergedPlan.start_date, mergedPlan.end_date)) {
        return res.status(400).json({ error: 'BAD_REQUEST', details: { date_range: 'start_date_must_be_before_or_equal_end_date' } });
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
