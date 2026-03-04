const crypto = require('node:crypto');

const { getTravelWeather, climateFallback } = require('../weatherAdapter');
const { buildEpiPayload } = require('../epiCalculator');
const { getTravelAlerts } = require('../travelAlertsProvider');
const { buildTravelReadiness } = require('../travelReadinessBuilder');
const { calibrateTravelReadinessWithLlm } = require('../travelLlmCalibrator');
const { composeTravelReply } = require('../travelReplyComposer');
const { getTravelContextKbEntry, upsertTravelContextKbEntry } = require('../travelKbStore');
const { evaluateTravelKbBackfill, buildTravelKbUpsertEntry } = require('../travelKbPolicy');
const { buildProductRecommendationsBundle, toLegacyRecommendationsPayload } = require('../productMatcherV1');
const {
  recordAuroraTravelLlmCall,
  recordAuroraTravelKbHit,
  recordAuroraTravelKbWrite,
  recordAuroraTravelResponseSource,
  recordAuroraTravelWeatherSource,
  recordAuroraTravelForecastSource,
  recordAuroraTravelAlertSource,
  recordAuroraTravelBaselineIntegrity,
  recordAuroraTravelResponseQuality,
  recordAuroraTravelReplyMode,
} = require('../visionMetrics');

const TRAVEL_SKILLS_VERSION = 'travel_skills_dag_v1';
const TRAVEL_KB_ASYNC_BACKFILL_ENABLED = (() => {
  const raw = String(process.env.TRAVEL_KB_ASYNC_BACKFILL_ENABLED || 'true').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
const TRAVEL_KB_WRITE_CONFIDENCE_MIN = (() => {
  const n = Number(process.env.TRAVEL_KB_WRITE_CONFIDENCE_MIN || 0.72);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.72;
})();
const TRAVEL_KB_WRITE_MAX_IN_FLIGHT = (() => {
  const n = Number(process.env.TRAVEL_KB_WRITE_MAX_IN_FLIGHT || 32);
  return Number.isFinite(n) ? Math.max(0, Math.min(2048, Math.trunc(n))) : 32;
})();
const TRAVEL_LLM_CALIBRATION_ENABLED = (() => {
  const raw = String(process.env.AURORA_TRAVEL_LLM_CALIBRATION_ENABLED || 'true').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on';
})();
let travelKbWriteInFlight = 0;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function normalizeLang(value) {
  return String(value || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeDateToken(value) {
  const token = normalizeText(value, 24);
  return /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : '';
}

function nowMonthBucket(nowMs) {
  const d = new Date(Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  return d.getUTCMonth() + 1;
}

function monthBucketFromDate(dateToken, nowMs) {
  const token = normalizeDateToken(dateToken);
  if (!token) return nowMonthBucket(nowMs);
  const m = Number(token.slice(5, 7));
  if (!Number.isFinite(m)) return nowMonthBucket(nowMs);
  return Math.max(1, Math.min(12, Math.trunc(m)));
}

function pickTravelContextFromProfile(profile) {
  const p = isPlainObject(profile) ? profile : {};
  const travelPlan = isPlainObject(p.travel_plan) ? p.travel_plan : isPlainObject(p.travelPlan) ? p.travelPlan : {};
  return {
    destination: normalizeText(travelPlan.destination, 120),
    startDate: normalizeDateToken(travelPlan.start_date),
    endDate: normalizeDateToken(travelPlan.end_date),
    homeRegion: normalizeText(p.region, 140),
  };
}

function pickTravelContextFromIntent(canonicalIntent) {
  const entities =
    canonicalIntent && isPlainObject(canonicalIntent.entities)
      ? canonicalIntent.entities
      : {};
  const dateRange = isPlainObject(entities.date_range) ? entities.date_range : {};
  return {
    destination: normalizeText(entities.destination, 120),
    startDate: normalizeDateToken(dateRange.start),
    endDate: normalizeDateToken(dateRange.end),
  };
}

function sha1(input) {
  return crypto.createHash('sha1').update(String(input || '')).digest('hex');
}

function pickProfileText(profile, camelKey, snakeKey, maxLen = 120) {
  const p = isPlainObject(profile) ? profile : {};
  return normalizeText(p[camelKey] != null ? p[camelKey] : p[snakeKey], maxLen) || null;
}

function shouldTriggerRecoPreview(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const asksStore =
    /\b(where to buy|where can i buy|which store|availability|in stock|offer|channel|pharmacy|sephora|drugstore)\b/i.test(lower) ||
    /(哪里买|在哪里买|门店|渠道|有货|库存|优惠|折扣|药妆店|专柜)/.test(text);
  if (asksStore) return false;
  return (
    /\b(what should i buy|what to buy|what should i bring|what to pack|packing list|product types|recommend products)\b/i.test(lower) ||
    /(买什么|带什么|带哪些|囤什么|准备哪些|推荐产品|产品推荐|护肤包)/.test(text)
  );
}

function shouldTriggerStoreChannel(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    /\b(where to buy|where can i buy|which store|store nearby|availability|in stock|offer|discount|channel|pharmacy|drugstore|duty free)\b/i.test(lower) ||
    /(哪里买|在哪里买|附近门店|渠道|有货|库存|买得到|优惠|折扣|药妆店|免税店|专柜)/.test(text)
  );
}

function shouldTriggerLlmCalibration({ travelReadiness, weatherSource, alertSource, message } = {}) {
  if (!TRAVEL_LLM_CALIBRATION_ENABLED) return false;
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const confidence = isPlainObject(readiness.confidence) ? readiness.confidence : {};
  const level = normalizeText(confidence.level, 24).toLowerCase();
  const scoreRaw = toNumber(confidence.score);
  const score = scoreRaw == null ? null : scoreRaw > 1 ? scoreRaw / 100 : scoreRaw;

  const degradedEnv = String(weatherSource || '').toLowerCase() !== 'weather_api';
  const degradedAlerts = String(alertSource || '').toLowerCase() === 'degraded';
  const lowConfidence = level === 'low' || (score != null && score < 0.72);
  const complexQuery = /\b(and|also|compare|difference|plus|products?|store|channel|buy)\b/i.test(String(message || '').toLowerCase());

  return Boolean(lowConfidence || degradedEnv || degradedAlerts || complexQuery);
}

function inferPseudoIngredientTargets(readiness) {
  const out = [];
  const seen = new Set();
  const push = (ingredientId, priority, role = 'support') => {
    const id = normalizeText(ingredientId, 80).toLowerCase();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ ingredient_id: id, priority, role });
  };

  const recoBundle = Array.isArray(readiness && readiness.reco_bundle) ? readiness.reco_bundle : [];
  for (const row of recoBundle) {
    const productTypes = Array.isArray(row && row.product_types) ? row.product_types : [];
    for (const rawType of productTypes) {
      const token = normalizeText(rawType, 120).toLowerCase();
      if (!token) continue;
      if (token.includes('spf') || token.includes('sunscreen') || token.includes('防晒')) push('sunscreen_filters', 90, 'hero');
      if (token.includes('moistur') || token.includes('repair') || token.includes('保湿') || token.includes('修护')) {
        push('ceramide_np', 72, 'support');
        push('panthenol', 60, 'support');
      }
      if (token.includes('oil') || token.includes('acne') || token.includes('控油') || token.includes('痘')) {
        push('niacinamide', 58, 'support');
      }
      if (token.includes('soothing') || token.includes('舒缓')) push('allantoin', 50, 'support');
    }
  }

  if (!out.length) {
    push('sunscreen_filters', 70, 'hero');
    push('ceramide_np', 60, 'support');
  }
  return out;
}

function buildRecoPreview({ travelReadiness, profile, language }) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const shoppingPreview = isPlainObject(readiness.shopping_preview) ? readiness.shopping_preview : {};
  const seedProducts = Array.isArray(shoppingPreview.products) ? shoppingPreview.products : [];

  if (!seedProducts.length) {
    return {
      source: 'travel_readiness_only',
      recommendations: [],
      confidence: { score: 0.45, level: 'low', rationale: ['no_seed_products'] },
    };
  }

  const ingredientPlan = {
    targets: inferPseudoIngredientTargets(readiness),
    avoid: [],
    confidence: isPlainObject(readiness.confidence) ? readiness.confidence : { score: 0.62, level: 'medium' },
  };

  const bundle = buildProductRecommendationsBundle({
    ingredientPlan,
    profile: isPlainObject(profile) ? profile : {},
    language: normalizeLang(language),
    maxPerSlot: 2,
    seedRecommendations: seedProducts,
    disallowTreatment: String(readiness?.confidence?.level || '').toLowerCase() === 'low',
  });
  const legacy = toLegacyRecommendationsPayload(bundle, { language: normalizeLang(language) });
  const recs = Array.isArray(legacy && legacy.recommendations) ? legacy.recommendations : [];

  return {
    source: 'product_matcher_v1',
    recommendations: recs.slice(0, 4).map((item) => ({
      slot: normalizeText(item && item.slot, 20) || null,
      product_id: normalizeText(item && item.product_id, 120) || null,
      name: normalizeText(item && item.name, 140) || null,
      brand: normalizeText(item && item.brand, 100) || null,
      reasons: Array.isArray(item && item.reasons) ? item.reasons.slice(0, 3) : [],
      score: toNumber(item && item.score),
      routine_slot: normalizeText(item && item.routine_slot, 40) || null,
      price_band: normalizeText(item && item.price_band, 24) || null,
    })),
    confidence: isPlainObject(legacy && legacy.confidence) ? legacy.confidence : { score: 0.6, level: 'medium', rationale: [] },
  };
}

function buildStoreChannel({ travelReadiness, destination }) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const shoppingPreview = isPlainObject(readiness.shopping_preview) ? readiness.shopping_preview : {};
  const buyingChannels = Array.isArray(shoppingPreview.buying_channels) ? shoppingPreview.buying_channels : [];
  const brandCandidates = Array.isArray(shoppingPreview.brand_candidates) ? shoppingPreview.brand_candidates : [];
  const stores = Array.isArray(readiness.store_examples) ? readiness.store_examples : [];

  return {
    source: 'travel_readiness_channels_v1',
    destination: normalizeText(destination, 120) || normalizeText(readiness?.destination_context?.destination, 120) || null,
    buying_channels: buyingChannels.slice(0, 8),
    store_examples: stores.slice(0, 6),
    brand_candidates: brandCandidates.slice(0, 6),
    offers_path_supported: true,
    offers_path_hint: '/v1/offers/resolve',
    note: normalizeText(
      shoppingPreview.note,
      240,
    ) || 'Use buying channels first; nearby store map is not available in this version.',
  };
}

function mergeKbPrefillIntoReadiness(baseReadiness, kbEntry) {
  const base = isPlainObject(baseReadiness) ? { ...baseReadiness } : {};
  const kb = isPlainObject(kbEntry) ? kbEntry : null;
  if (!kb) return base;

  const kbClimate = isPlainObject(kb.climate_delta_profile) ? kb.climate_delta_profile : {};
  const baseDelta = isPlainObject(base.delta_vs_home) ? { ...base.delta_vs_home } : {};
  const mergedDelta = {
    ...kbClimate,
    ...baseDelta,
  };

  const baseAdaptive = Array.isArray(base.adaptive_actions) ? base.adaptive_actions : [];
  const kbAdaptive = Array.isArray(kb.adaptive_actions) ? kb.adaptive_actions : [];
  const adaptiveActions = baseAdaptive.length ? baseAdaptive : kbAdaptive;

  const shoppingPreview = isPlainObject(base.shopping_preview) ? { ...base.shopping_preview } : {};
  const baseBrandCandidates = Array.isArray(shoppingPreview.brand_candidates) ? shoppingPreview.brand_candidates : [];
  const kbBrands = Array.isArray(kb.local_brand_candidates) ? kb.local_brand_candidates : [];
  const brandCandidates = baseBrandCandidates.length ? baseBrandCandidates : kbBrands;

  const baseProducts = Array.isArray(shoppingPreview.products) ? shoppingPreview.products : [];
  const kbProducts = Array.isArray(kb.product_type_recos)
    ? kb.product_type_recos.map((row, idx) => ({
        rank: idx + 1,
        product_id: null,
        name: normalizeText(row && row.category, 80) || `Category ${idx + 1}`,
        brand: null,
        category: normalizeText(row && row.category, 80) || null,
        reasons: normalizeText(row && row.top_reason, 180) ? [normalizeText(row.top_reason, 180)] : [],
      }))
    : [];
  const products = baseProducts.length ? baseProducts : kbProducts;

  return {
    ...base,
    delta_vs_home: mergedDelta,
    adaptive_actions: adaptiveActions,
    shopping_preview: {
      ...shoppingPreview,
      ...(products.length ? { products } : {}),
      ...(brandCandidates.length ? { brand_candidates: brandCandidates } : {}),
    },
  };
}

function formatRecoPreviewText({ language, recoPreview }) {
  const lang = normalizeLang(language);
  const recs = Array.isArray(recoPreview && recoPreview.recommendations) ? recoPreview.recommendations : [];
  if (!recs.length) return '';
  if (lang === 'CN') {
    return [
      '旅行产品预览：',
      ...recs.slice(0, 3).map((row) => {
        const head = [row.name, row.brand].filter(Boolean).join(' · ');
        const reason = Array.isArray(row.reasons) && row.reasons.length ? `（${row.reasons[0]}）` : '';
        return `- ${head || '候选产品'}${reason}`;
      }),
    ].join('\n');
  }
  return [
    'Travel product preview:',
    ...recs.slice(0, 3).map((row) => {
      const head = [row.name, row.brand].filter(Boolean).join(' · ');
      const reason = Array.isArray(row.reasons) && row.reasons.length ? ` (${row.reasons[0]})` : '';
      return `- ${head || 'Candidate product'}${reason}`;
    }),
  ].join('\n');
}

function formatStoreChannelText({ language, storeChannel }) {
  const lang = normalizeLang(language);
  const channels = Array.isArray(storeChannel && storeChannel.buying_channels) ? storeChannel.buying_channels : [];
  const stores = Array.isArray(storeChannel && storeChannel.store_examples) ? storeChannel.store_examples : [];
  const channelLine = channels.length ? channels.slice(0, 4).join(', ') : (lang === 'CN' ? '无' : 'none');

  if (lang === 'CN') {
    const lines = [`购买渠道建议：${channelLine}`];
    if (stores.length) {
      lines.push('示例门店：');
      for (const row of stores.slice(0, 2)) {
        const name = normalizeText(row && row.name, 120);
        const addr = normalizeText(row && row.address, 180);
        if (!name && !addr) continue;
        lines.push(`- ${[name, addr].filter(Boolean).join(' · ')}`);
      }
    }
    lines.push('如需查具体库存/优惠，可继续提供品牌或产品名。');
    return lines.join('\n');
  }

  const lines = [`Buying channels: ${channelLine}`];
  if (stores.length) {
    lines.push('Store examples:');
    for (const row of stores.slice(0, 2)) {
      const name = normalizeText(row && row.name, 120);
      const addr = normalizeText(row && row.address, 180);
      if (!name && !addr) continue;
      lines.push(`- ${[name, addr].filter(Boolean).join(' · ')}`);
    }
  }
  lines.push('Share a specific product/brand if you want me to narrow stock and offer checks.');
  return lines.join('\n');
}

function pushTrace(trace, { skill, status, startedAtMs, meta } = {}) {
  const started = Number.isFinite(Number(startedAtMs)) ? Number(startedAtMs) : Date.now();
  const ended = Date.now();
  const durationMs = Math.max(0, ended - started);
  const out = {
    skill: normalizeText(skill, 80) || 'unknown_skill',
    status: normalizeText(status, 32) || 'unknown',
    started_at_ms: started,
    ended_at_ms: ended,
    duration_ms: durationMs,
  };
  if (isPlainObject(meta) && Object.keys(meta).length) out.meta = meta;
  trace.push(out);
}

function evaluatePipelineQuality({
  assistantText,
  destination,
  travelReadiness,
  destinationWeather,
  kbHit,
  llmResult,
} = {}) {
  const normalizedAssistant = normalizeText(assistantText, 12000);
  if (!normalizedAssistant) {
    return { ok: false, reason: 'assistant_text_empty' };
  }

  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const hasDestinationSignal = Boolean(
    normalizeText(destination, 120) ||
      normalizeText(readiness?.destination_context?.destination, 120),
  );
  const hasForecastSignal = Boolean(
    (Array.isArray(readiness.forecast_window) && readiness.forecast_window.length > 0) ||
      isPlainObject(destinationWeather && destinationWeather.summary),
  );
  const hasAdaptiveActions = Array.isArray(readiness.adaptive_actions) && readiness.adaptive_actions.length > 0;
  const hasLlmUsed = Boolean(llmResult && llmResult.used);
  const coreSignalsMissing = !hasDestinationSignal && !hasForecastSignal && !hasAdaptiveActions && !kbHit && !hasLlmUsed;
  if (coreSignalsMissing) {
    return { ok: false, reason: 'core_signals_missing' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * @typedef {Object} TravelPipelineInput
 * @property {string} message
 * @property {string} language
 * @property {Object} profile
 * @property {Array} recentLogs
 * @property {Object} canonicalIntent
 * @property {Object} plannerDecision
 * @property {Object} chatContext
 * @property {boolean} travelWeatherLiveEnabled
 * @property {Object|null} openaiClient
 * @property {Object|null} logger
 * @property {number=} nowMs
 * @property {string=} userLocale
 * @property {boolean=} hasSafetyConflict
 */

/**
 * @typedef {Object} TravelPipelineOutput
 * @property {boolean} ok
 * @property {string} travel_skills_version
 * @property {Array} travel_skills_trace
 * @property {string} assistant_text
 * @property {Object|null} env_stress_patch
 * @property {Object|null} travel_readiness
 * @property {boolean} travel_kb_hit
 * @property {boolean} travel_kb_write_queued
 * @property {Object|null} travel_followup_state
 * @property {Object|null} reco_preview
 * @property {Object|null} store_channel
 * @property {string|null} env_source
 * @property {boolean} degraded
 */

async function runTravelPipeline(input = {}) {
  const trace = [];
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const language = normalizeLang(input.language);
  const profile = isPlainObject(input.profile) ? input.profile : {};
  const canonicalIntent = isPlainObject(input.canonicalIntent) ? input.canonicalIntent : {};
  const plannerDecision = isPlainObject(input.plannerDecision) ? input.plannerDecision : {};
  const chatContext = isPlainObject(input.chatContext) ? input.chatContext : {};
  const message = normalizeText(input.message, 1400);
  const logger = input.logger;
  const openaiClient = input.openaiClient;
  const travelWeatherLiveEnabled = Boolean(input.travelWeatherLiveEnabled);
  const userLocale = normalizeText(input.userLocale, 40) || null;
  const hasSafetyConflict = Boolean(input.hasSafetyConflict);

  let kbHit = false;
  let kbWriteQueued = false;
  let kbEntry = null;
  let travelReadiness = null;
  let destinationWeather = null;
  let homeWeather = null;
  let alertsPayload = null;
  let epiPayload = null;
  let llmResult = null;
  let recoPreview = null;
  let storeChannel = null;

  const intentStartedAt = Date.now();
  const profileCtx = pickTravelContextFromProfile(profile);
  const intentCtx = pickTravelContextFromIntent(canonicalIntent);
  const destination = intentCtx.destination || profileCtx.destination;
  const startDate = intentCtx.startDate || profileCtx.startDate;
  const endDate = intentCtx.endDate || profileCtx.endDate;
  const homeRegion = profileCtx.homeRegion;
  const monthBucket = monthBucketFromDate(startDate || endDate, nowMs);
  const questionHash = sha1(String(message || '').trim().toLowerCase());
  const requiredFields = Array.isArray(plannerDecision.required_fields) ? plannerDecision.required_fields.slice(0, 8) : [];

  pushTrace(trace, {
    skill: 'travel_intent_profile_skill',
    status: 'ok',
    startedAtMs: intentStartedAt,
    meta: {
      destination: destination || null,
      start_date: startDate || null,
      end_date: endDate || null,
      month_bucket: monthBucket,
      required_fields_count: requiredFields.length,
    },
  });

  const kbReadStartedAt = Date.now();
  if (destination) {
    try {
      kbEntry = await getTravelContextKbEntry({
        destination,
        monthBucket,
        lang: language,
      });
      kbHit = Boolean(kbEntry);
      recordAuroraTravelKbHit({ mode: kbHit ? 'hit' : 'miss' });
      pushTrace(trace, {
        skill: 'travel_kb_read_skill',
        status: kbHit ? 'hit' : 'miss',
        startedAtMs: kbReadStartedAt,
        meta: {
          kb_key: kbEntry && kbEntry.kb_key ? kbEntry.kb_key : null,
        },
      });
    } catch (err) {
      kbHit = false;
      recordAuroraTravelKbHit({ mode: 'miss' });
      pushTrace(trace, {
        skill: 'travel_kb_read_skill',
        status: 'error',
        startedAtMs: kbReadStartedAt,
        meta: { reason: normalizeText(err && (err.code || err.message), 120) || 'error' },
      });
    }
  } else {
    recordAuroraTravelKbHit({ mode: 'miss' });
    pushTrace(trace, {
      skill: 'travel_kb_read_skill',
      status: 'skip',
      startedAtMs: kbReadStartedAt,
      meta: { reason: 'destination_missing' },
    });
  }

  const envStartedAt = Date.now();
  try {
    if (travelWeatherLiveEnabled) {
      destinationWeather = await getTravelWeather({
        destination,
        startDate,
        endDate,
        userLocale,
      });
    } else {
      destinationWeather = climateFallback({
        destination,
        startDate,
        endDate,
        reason: 'live_disabled',
        userLocale,
      });
      destinationWeather.reason = destinationWeather.reason || 'live_disabled';
    }

    if (homeRegion) {
      if (travelWeatherLiveEnabled) {
        homeWeather = await getTravelWeather({
          destination: homeRegion,
          startDate,
          endDate,
          userLocale,
        });
      } else {
        homeWeather = climateFallback({
          destination: homeRegion,
          startDate,
          endDate,
          reason: 'live_disabled',
          userLocale,
        });
      }
    }

    if (travelWeatherLiveEnabled) {
      const destinationCountry = normalizeText(
        destinationWeather?.location?.country_code || destinationWeather?.location?.country,
        40,
      );
      alertsPayload = await getTravelAlerts({
        destination,
        destinationCountry,
        language,
      });
    } else {
      alertsPayload = {
        source: 'none',
        reason: 'live_disabled',
        alerts: [],
        provider: 'none',
        domain: null,
        data_freshness_utc: new Date().toISOString(),
      };
    }
    epiPayload = buildEpiPayload({
      weather: destinationWeather,
      profile,
      language,
      userReportedConditions: { condition: message },
    });

    const weatherSource = normalizeText(destinationWeather && destinationWeather.source, 40) || 'climate_fallback';
    const weatherReason = normalizeText(destinationWeather && destinationWeather.reason, 80) || 'unknown';
    const alertSource = normalizeText(alertsPayload && alertsPayload.source, 40) || 'none';

    recordAuroraTravelWeatherSource({ source: weatherSource, reason: weatherReason });
    recordAuroraTravelForecastSource({ source: weatherSource });
    recordAuroraTravelAlertSource({ source: alertSource });
    recordAuroraTravelBaselineIntegrity({
      status: homeWeather && isPlainObject(homeWeather.summary) ? 'ok' : 'missing',
    });

    pushTrace(trace, {
      skill: 'travel_env_context_skill',
      status: 'ok',
      startedAtMs: envStartedAt,
      meta: {
        weather_source: weatherSource,
        weather_reason: weatherReason,
        alert_source: alertSource,
      },
    });
  } catch (err) {
    destinationWeather = climateFallback({ destination, startDate, endDate, reason: 'live_error', userLocale });
    alertsPayload = {
      source: 'degraded',
      reason: 'env_context_error',
      alerts: [],
      provider: 'none',
      domain: null,
      data_freshness_utc: new Date().toISOString(),
    };
    epiPayload = buildEpiPayload({
      weather: destinationWeather,
      profile,
      language,
      userReportedConditions: { condition: message },
    });
    recordAuroraTravelWeatherSource({ source: 'climate_fallback', reason: 'live_error' });
    recordAuroraTravelForecastSource({ source: 'climate_fallback' });
    recordAuroraTravelAlertSource({ source: 'degraded' });
    recordAuroraTravelBaselineIntegrity({ status: 'missing' });
    pushTrace(trace, {
      skill: 'travel_env_context_skill',
      status: 'degraded',
      startedAtMs: envStartedAt,
      meta: { reason: normalizeText(err && (err.code || err.message), 120) || 'error' },
    });
  }

  const readinessStartedAt = Date.now();
  try {
    travelReadiness = buildTravelReadiness({
      language,
      profile,
      recentLogs: Array.isArray(input.recentLogs) ? input.recentLogs : [],
      destination,
      startDate,
      endDate,
      destinationWeather,
      homeWeather,
      travelAlerts: Array.isArray(alertsPayload && alertsPayload.alerts) ? alertsPayload.alerts : [],
      epiPayload,
      recommendationCandidates: [],
      nowMs,
    });
    travelReadiness = mergeKbPrefillIntoReadiness(travelReadiness, kbEntry);
    pushTrace(trace, {
      skill: 'travel_readiness_skill',
      status: 'ok',
      startedAtMs: readinessStartedAt,
      meta: {
        destination: normalizeText(travelReadiness?.destination_context?.destination, 120) || null,
        forecast_rows: Array.isArray(travelReadiness?.forecast_window) ? travelReadiness.forecast_window.length : 0,
        alerts_rows: Array.isArray(travelReadiness?.alerts) ? travelReadiness.alerts.length : 0,
      },
    });
  } catch (err) {
    const degradedReadiness = {
      destination_context: {
        destination: destination || null,
        start_date: startDate || null,
        end_date: endDate || null,
      },
      forecast_window: [],
      adaptive_actions: [],
      alerts: [],
      confidence: { score: 0.35, level: 'low', rationale: ['readiness_build_failed'] },
    };
    travelReadiness = mergeKbPrefillIntoReadiness(degradedReadiness, kbEntry);
    pushTrace(trace, {
      skill: 'travel_readiness_skill',
      status: 'degraded',
      startedAtMs: readinessStartedAt,
      meta: { reason: normalizeText(err && (err.code || err.message), 120) || 'error' },
    });
  }

  const llmStartedAt = Date.now();
  const llmTriggered = shouldTriggerLlmCalibration({
    travelReadiness,
    weatherSource: destinationWeather && destinationWeather.source,
    alertSource: alertsPayload && alertsPayload.source,
    message,
  });

  if (llmTriggered) {
    try {
      llmResult = await calibrateTravelReadinessWithLlm({
        openaiClient,
        language,
        travelLlmInput: {
          destination,
          start_date: startDate,
          end_date: endDate,
          month_bucket: monthBucket,
          profile: {
            skinType: pickProfileText(profile, 'skinType', 'skin_type', 40),
            sensitivity: pickProfileText(profile, 'sensitivity', 'sensitivity', 40),
            barrierStatus: pickProfileText(profile, 'barrierStatus', 'barrier_status', 40),
            region: homeRegion || null,
          },
          weather_source: normalizeText(destinationWeather && destinationWeather.source, 40) || null,
          weather_reason: normalizeText(destinationWeather && destinationWeather.reason, 80) || null,
          alerts_source: normalizeText(alertsPayload && alertsPayload.source, 40) || null,
          kb_hit: kbHit,
          question: message,
        },
        baseTravelReadiness: travelReadiness,
        timeoutMs: 1800,
        maxRetries: 1,
        logger,
      });

      if (isPlainObject(llmResult) && isPlainObject(llmResult.travel_readiness)) {
        travelReadiness = llmResult.travel_readiness;
      }

      const llmOutcome = normalizeText(llmResult && llmResult.outcome, 40) || 'error';
      recordAuroraTravelLlmCall({ outcome: llmOutcome });
      pushTrace(trace, {
        skill: 'travel_llm_calibration_skill',
        status: llmOutcome,
        startedAtMs: llmStartedAt,
        meta: {
          used: Boolean(llmResult && llmResult.used),
          model: normalizeText(llmResult?.source_meta?.model, 120) || null,
        },
      });
    } catch (err) {
      llmResult = {
        used: false,
        outcome: 'error',
        error_reason: normalizeText(err && (err.code || err.message), 120) || 'llm_calibration_error',
      };
      recordAuroraTravelLlmCall({ outcome: 'error' });
      pushTrace(trace, {
        skill: 'travel_llm_calibration_skill',
        status: 'degraded',
        startedAtMs: llmStartedAt,
        meta: {
          reason: normalizeText(err && (err.code || err.message), 120) || 'llm_calibration_error',
        },
      });
    }
  } else {
    recordAuroraTravelLlmCall({
      outcome: TRAVEL_LLM_CALIBRATION_ENABLED ? 'skip_conditions_not_matched' : 'skip_disabled',
    });
    pushTrace(trace, {
      skill: 'travel_llm_calibration_skill',
      status: 'skip',
      startedAtMs: llmStartedAt,
      meta: { reason: 'conditions_not_matched' },
    });
  }

  const recoStartedAt = Date.now();
  const recoTriggered = shouldTriggerRecoPreview(message);
  if (recoTriggered) {
    try {
      recoPreview = buildRecoPreview({
        travelReadiness,
        profile,
        language,
      });
      pushTrace(trace, {
        skill: 'travel_reco_preview_skill',
        status: 'ok',
        startedAtMs: recoStartedAt,
        meta: {
          source: normalizeText(recoPreview && recoPreview.source, 80) || null,
          recommendations: Array.isArray(recoPreview && recoPreview.recommendations)
            ? recoPreview.recommendations.length
            : 0,
        },
      });
    } catch (err) {
      recoPreview = null;
      pushTrace(trace, {
        skill: 'travel_reco_preview_skill',
        status: 'error',
        startedAtMs: recoStartedAt,
        meta: { reason: normalizeText(err && (err.code || err.message), 120) || 'error' },
      });
    }
  } else {
    pushTrace(trace, {
      skill: 'travel_reco_preview_skill',
      status: 'skip',
      startedAtMs: recoStartedAt,
      meta: { reason: 'trigger_not_matched' },
    });
  }

  const storeStartedAt = Date.now();
  const storeTriggered = shouldTriggerStoreChannel(message);
  if (storeTriggered) {
    try {
      storeChannel = buildStoreChannel({ travelReadiness, destination });
      pushTrace(trace, {
        skill: 'travel_store_channel_skill',
        status: 'ok',
        startedAtMs: storeStartedAt,
        meta: {
          channels: Array.isArray(storeChannel && storeChannel.buying_channels)
            ? storeChannel.buying_channels.length
            : 0,
          stores: Array.isArray(storeChannel && storeChannel.store_examples)
            ? storeChannel.store_examples.length
            : 0,
        },
      });
    } catch (err) {
      storeChannel = null;
      pushTrace(trace, {
        skill: 'travel_store_channel_skill',
        status: 'error',
        startedAtMs: storeStartedAt,
        meta: { reason: normalizeText(err && (err.code || err.message), 120) || 'error' },
      });
    }
  } else {
    pushTrace(trace, {
      skill: 'travel_store_channel_skill',
      status: 'skip',
      startedAtMs: storeStartedAt,
      meta: { reason: 'trigger_not_matched' },
    });
  }

  const replyStartedAt = Date.now();
  const prevFollowup = isPlainObject(chatContext.travel_followup)
    ? chatContext.travel_followup
    : isPlainObject(chatContext.travelFollowup)
      ? chatContext.travelFollowup
      : {};

  const followupReply = composeTravelReply({
    message,
    language,
    travelReadiness,
    destination,
    homeRegion,
    envSource: epiPayload && epiPayload.env_source,
    previousFocus: normalizeText(prevFollowup.focus, 80),
    previousReplySig: normalizeText(prevFollowup.reply_sig, 320),
    previousQuestionHash: normalizeText(prevFollowup.question_hash, 80),
    questionHash,
  });

  let assistantText = normalizeText(followupReply && (followupReply.text_brief || followupReply.text), 12000);
  if (!assistantText) {
    assistantText =
      language === 'CN'
        ? '我先按当前可得信息给你旅行护肤建议。'
        : 'Here is a practical travel skincare plan based on currently available data.';
  }
  if (recoPreview) {
    const block = formatRecoPreviewText({ language, recoPreview });
    if (block) assistantText = [assistantText, block].filter(Boolean).join('\n\n');
  }
  if (storeChannel) {
    const block = formatStoreChannelText({ language, storeChannel });
    if (block) assistantText = [assistantText, block].filter(Boolean).join('\n\n');
  }

  const qualitySections = Array.isArray(followupReply && followupReply.quality_sections)
    ? followupReply.quality_sections
    : [];
  for (const section of qualitySections) {
    recordAuroraTravelResponseQuality({ section });
  }
  recordAuroraTravelReplyMode({ mode: normalizeText(followupReply && followupReply.reply_mode, 40) || 'fallback' });
  recordAuroraTravelResponseSource({
    source: llmResult && llmResult.used ? 'llm_enriched' : 'rules_only',
  });

  pushTrace(trace, {
    skill: 'travel_followup_reply_skill',
    status: 'ok',
    startedAtMs: replyStartedAt,
    meta: {
      mode: normalizeText(followupReply && followupReply.reply_mode, 40) || 'fallback',
      focus: normalizeText(followupReply && followupReply.focus, 80) || null,
      has_official_alerts: Boolean(followupReply && followupReply.has_official_alerts),
    },
  });

  const kbWriteStartedAt = Date.now();
  if (TRAVEL_KB_ASYNC_BACKFILL_ENABLED) {
    const kbBackfill = evaluateTravelKbBackfill({
      travelReadiness,
      minConfidence: TRAVEL_KB_WRITE_CONFIDENCE_MIN,
      hasSafetyConflict,
    });
    if (kbBackfill && kbBackfill.eligible && destination) {
      const entry = buildTravelKbUpsertEntry({
        destination,
        monthBucket,
        lang: language,
        travelReadiness,
        confidenceScore: kbBackfill.confidence_score,
        qualityFlags: isPlainObject(llmResult && llmResult.quality_flags) ? llmResult.quality_flags : {},
        sourceMeta: {
          stage: llmResult && llmResult.used ? 'travel_readiness_calibration_v1' : 'travel_readiness_rules',
          weather_source: normalizeText(destinationWeather && destinationWeather.source, 40) || null,
          alert_source: normalizeText(alertsPayload && alertsPayload.source, 40) || null,
          kb_hit: kbHit,
        },
        ttlDays: 45,
        nowMs,
      });

      if (entry) {
        if (travelKbWriteInFlight >= TRAVEL_KB_WRITE_MAX_IN_FLIGHT) {
          kbWriteQueued = false;
          recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'backpressure_drop' });
        } else {
          kbWriteQueued = true;
          travelKbWriteInFlight += 1;
          recordAuroraTravelKbWrite({ outcome: 'queued', reason: 'eligible' });
          Promise.resolve()
            .then(() => upsertTravelContextKbEntry(entry))
            .then(() => {
              recordAuroraTravelKbWrite({ outcome: 'success', reason: 'upsert_ok' });
            })
            .catch((err) => {
              recordAuroraTravelKbWrite({
                outcome: 'error',
                reason: normalizeText(err && (err.code || err.message), 120) || 'upsert_error',
              });
              logger?.warn(
                {
                  err: err && (err.code || err.message) ? err.code || err.message : 'unknown',
                  kb_key: entry.kb_key,
                },
                'aurora bff: travel kb async backfill failed',
              );
            })
            .finally(() => {
              travelKbWriteInFlight = Math.max(0, travelKbWriteInFlight - 1);
            });
        }
      } else {
        recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'entry_invalid' });
      }

      pushTrace(trace, {
        skill: 'travel_kb_write_skill',
        status: kbWriteQueued ? 'queued' : 'skip',
        startedAtMs: kbWriteStartedAt,
        meta: {
          reason: kbWriteQueued ? 'eligible' : entry ? 'backpressure_drop' : 'entry_invalid',
        },
      });
    } else {
      recordAuroraTravelKbWrite({
        outcome: 'skip',
        reason: normalizeText(kbBackfill && kbBackfill.reason, 80) || 'not_eligible',
      });
      pushTrace(trace, {
        skill: 'travel_kb_write_skill',
        status: 'skip',
        startedAtMs: kbWriteStartedAt,
        meta: {
          reason: normalizeText(kbBackfill && kbBackfill.reason, 80) || 'not_eligible',
        },
      });
    }
  } else {
    recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'disabled' });
    pushTrace(trace, {
      skill: 'travel_kb_write_skill',
      status: 'skip',
      startedAtMs: kbWriteStartedAt,
      meta: { reason: 'disabled' },
    });
  }

  const envSource = normalizeText(epiPayload && epiPayload.env_source, 40) || normalizeText(destinationWeather && destinationWeather.source, 40) || null;
  const envStressPatch = {
    epi: toNumber(epiPayload && epiPayload.epi),
    components: isPlainObject(epiPayload && epiPayload.components) ? epiPayload.components : {},
    reco_weights: isPlainObject(epiPayload && epiPayload.reco_weights) ? epiPayload.reco_weights : {},
    env_source: envSource,
    travel_context: isPlainObject(destinationWeather && destinationWeather.date_range) ? destinationWeather.date_range : null,
    travel_readiness: travelReadiness,
  };
  const quality = evaluatePipelineQuality({
    assistantText,
    destination,
    travelReadiness,
    destinationWeather,
    kbHit,
    llmResult,
  });

  return {
    ok: Boolean(quality.ok),
    travel_skills_version: TRAVEL_SKILLS_VERSION,
    travel_skills_trace: trace,
    assistant_text: assistantText,
    env_stress_patch: envStressPatch,
    travel_readiness: travelReadiness,
    travel_kb_hit: kbHit,
    travel_kb_write_queued: kbWriteQueued,
    travel_followup_state: {
      focus: normalizeText(followupReply && followupReply.focus, 80) || null,
      reply_sig: normalizeText(followupReply && followupReply.reply_sig, 320) || null,
      question_hash: questionHash,
      updated_at_ms: nowMs,
    },
    reco_preview: recoPreview,
    store_channel: storeChannel,
    env_source: envSource,
    degraded:
      envSource !== 'weather_api' ||
      trace.some((row) => row && (row.status === 'degraded' || row.status === 'error')),
    quality_reason: quality.reason,
  };
}

module.exports = {
  TRAVEL_SKILLS_VERSION,
  runTravelPipeline,
  __internal: {
    shouldTriggerRecoPreview,
    shouldTriggerStoreChannel,
    shouldTriggerLlmCalibration,
    mergeKbPrefillIntoReadiness,
    buildRecoPreview,
    buildStoreChannel,
  },
};
