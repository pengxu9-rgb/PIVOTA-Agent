const crypto = require('node:crypto');

const { getTravelWeather, climateFallback } = require('../weatherAdapter');
const { normalizeDestinationPlace, resolveDestinationInput } = require('../destinationResolver');
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
  recordAuroraTravelLlmTrigger,
  recordAuroraTravelLlmSkip,
  recordAuroraTravelSkillSkip,
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
    destinationPlace: normalizeDestinationPlace(travelPlan.destination_place || travelPlan.destinationPlace),
    startDate: normalizeDateToken(travelPlan.start_date),
    endDate: normalizeDateToken(travelPlan.end_date),
    homeRegion: normalizeText(p.region, 140),
    travelPlan,
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

function buildDestinationClarificationAssistantText({ language, destination, candidates } = {}) {
  const lang = normalizeLang(language);
  const query = normalizeText(destination, 120);
  const options = Array.isArray(candidates) ? candidates.map((row) => normalizeText(row && row.label, 160)).filter(Boolean) : [];
  if (lang === 'CN') {
    return [
      query ? `我找到多个可能的目的地“${query}”，先确认具体地点，我再给你准确天气和护肤建议。` : '我找到多个可能的目的地，先确认具体地点，我再给你准确天气和护肤建议。',
      options.length ? `可选：${options.slice(0, 3).join(' / ')}` : '',
    ].filter(Boolean).join('\n');
  }
  return [
    query
      ? `I found multiple possible destinations for "${query}". Pick the exact place first and I’ll give you accurate weather and skincare guidance.`
      : 'I found multiple possible destinations. Pick the exact place first and I’ll give you accurate weather and skincare guidance.',
    options.length ? `Options: ${options.slice(0, 3).join(' / ')}` : '',
  ].filter(Boolean).join('\n');
}

function buildDestinationClarificationChips({
  language,
  candidates,
  baseTravelPlan,
} = {}) {
  const lang = normalizeLang(language);
  const travelPlan = isPlainObject(baseTravelPlan) ? baseTravelPlan : {};
  const out = [];
  const rows = Array.isArray(candidates) ? candidates : [];
  for (const [index, row] of rows.slice(0, 3).entries()) {
    const candidate = normalizeDestinationPlace(row, { resolutionSource: 'user_selected' });
    if (!candidate) continue;
    out.push({
      chip_id: `chip.travel.destination_candidate.${index + 1}`,
      label: candidate.label,
      kind: 'quick_reply',
      data: {
        reply_text:
          lang === 'CN'
            ? `目的地选 ${candidate.label}`
            : `Destination ${candidate.label}`,
        profile_patch: {
          travel_plan: {
            ...(normalizeText(travelPlan.start_date, 24) ? { start_date: normalizeText(travelPlan.start_date, 24) } : {}),
            ...(normalizeText(travelPlan.end_date, 24) ? { end_date: normalizeText(travelPlan.end_date, 24) } : {}),
            ...(Number.isFinite(Number(travelPlan.indoor_outdoor_ratio))
              ? { indoor_outdoor_ratio: Number(travelPlan.indoor_outdoor_ratio) }
              : {}),
            ...(normalizeText(travelPlan.itinerary, 1200) ? { itinerary: normalizeText(travelPlan.itinerary, 1200) } : {}),
            ...(normalizeText(travelPlan.trip_id, 80) ? { trip_id: normalizeText(travelPlan.trip_id, 80) } : {}),
            destination: candidate.label,
            destination_place: candidate,
          },
        },
      },
    });
  }
  return out;
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

function decideLlmCalibrationTrigger({ destination } = {}) {
  if (!TRAVEL_LLM_CALIBRATION_ENABLED) {
    return {
      triggered: false,
      trigger_reason: null,
      skip_reason: 'disabled',
      outcome: 'skip_disabled',
    };
  }
  if (!normalizeText(destination, 120)) {
    return {
      triggered: false,
      trigger_reason: null,
      skip_reason: 'destination_missing',
      outcome: 'skip_destination_missing',
    };
  }
  return {
    triggered: true,
    trigger_reason: 'destination_present',
    skip_reason: null,
    outcome: 'call',
  };
}

function shouldTriggerLlmCalibration({ destination } = {}) {
  return decideLlmCalibrationTrigger({ destination }).triggered;
}

function normalizeLlmTraceOutcome(outcome) {
  const token = normalizeText(outcome, 64).toLowerCase();
  if (token === 'call' || token === 'timeout' || token === 'error') return token;
  if (token === 'skip_no_client') return 'error';
  return 'error';
}

function normalizeRecoSkipReason(reason) {
  const token = normalizeText(reason, 80).toLowerCase();
  if (
    token === 'trigger_not_matched' ||
    token === 'destination_missing' ||
    token === 'destination_ambiguous' ||
    token === 'no_products'
  ) return token;
  return 'trigger_not_matched';
}

function normalizeStoreSkipReason(reason) {
  const token = normalizeText(reason, 80).toLowerCase();
  if (
    token === 'trigger_not_matched' ||
    token === 'destination_missing' ||
    token === 'destination_ambiguous' ||
    token === 'no_channels'
  ) return token;
  return 'trigger_not_matched';
}

function normalizeKbWriteSkipReason(reason) {
  const token = normalizeText(reason, 80).toLowerCase();
  if (
    token === 'safety_conflict' ||
    token === 'incomplete_structure' ||
    token === 'backpressure_drop' ||
    token === 'entry_invalid'
  ) {
    return token;
  }
  return 'incomplete_structure';
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
 * @property {Object} travel_skill_invocation_matrix
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
  let llmCalled = false;
  let llmSkipReason = null;
  let recoCalled = false;
  let recoSkipReason = null;
  let storeCalled = false;
  let storeSkipReason = null;
  let kbWriteSkipReason = null;

  const intentStartedAt = Date.now();
  const profileCtx = pickTravelContextFromProfile(profile);
  const intentCtx = pickTravelContextFromIntent(canonicalIntent);
  const destinationInput = intentCtx.destination || profileCtx.destination;
  let destination = destinationInput;
  let destinationPlace = profileCtx.destinationPlace || null;
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
      destination_place_present: Boolean(destinationPlace),
      start_date: startDate || null,
      end_date: endDate || null,
      month_bucket: monthBucket,
      required_fields_count: requiredFields.length,
    },
  });

  let destinationResolution = null;
  if (!destinationPlace && destination && travelWeatherLiveEnabled) {
    try {
      destinationResolution = await resolveDestinationInput({
        destination,
        destinationPlace: null,
        userLocale,
        fetchImpl: global.fetch,
        timeoutMs: 1600,
        count: 8,
      });
      if (destinationResolution && destinationResolution.ok && !destinationResolution.ambiguous && destinationResolution.resolved_place) {
        destinationPlace = destinationResolution.resolved_place;
        destination = destinationPlace.label || destination;
      }
    } catch (_err) {
      destinationResolution = null;
    }
  }

  if (destinationResolution && destinationResolution.ambiguous) {
    recordAuroraTravelKbHit({ mode: 'miss' });
    pushTrace(trace, {
      skill: 'travel_kb_read_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: { reason: 'destination_ambiguous' },
    });
    recordAuroraTravelSkillSkip({ skill: 'travel_env_context_skill', reason: 'destination_ambiguous' });
    pushTrace(trace, {
      skill: 'travel_env_context_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: { reason: 'destination_ambiguous' },
    });
    recordAuroraTravelSkillSkip({ skill: 'travel_readiness_skill', reason: 'destination_ambiguous' });
    pushTrace(trace, {
      skill: 'travel_readiness_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: { reason: 'destination_ambiguous' },
    });
    recordAuroraTravelLlmSkip({ reason: 'destination_ambiguous' });
    recordAuroraTravelLlmCall({ outcome: 'skip_destination_ambiguous' });
    pushTrace(trace, {
      skill: 'travel_llm_calibration_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: {
        triggered: false,
        trigger_reason: null,
        skip_reason: 'destination_ambiguous',
        outcome: 'skip_destination_ambiguous',
      },
    });
    recordAuroraTravelSkillSkip({ skill: 'travel_reco_preview_skill', reason: 'destination_ambiguous' });
    pushTrace(trace, {
      skill: 'travel_reco_preview_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: { reason: 'destination_ambiguous' },
    });
    recordAuroraTravelSkillSkip({ skill: 'travel_store_channel_skill', reason: 'destination_ambiguous' });
    pushTrace(trace, {
      skill: 'travel_store_channel_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: { reason: 'destination_ambiguous' },
    });

    const clarificationText = buildDestinationClarificationAssistantText({
      language,
      destination: destinationInput,
      candidates: destinationResolution.candidates,
    });
    const clarificationChips = buildDestinationClarificationChips({
      language,
      candidates: destinationResolution.candidates,
      baseTravelPlan: {
        ...(isPlainObject(profileCtx.travelPlan) ? profileCtx.travelPlan : {}),
        ...(normalizeText(startDate, 24) ? { start_date: startDate } : {}),
        ...(normalizeText(endDate, 24) ? { end_date: endDate } : {}),
      },
    });
    recordAuroraTravelReplyMode({ mode: 'clarification' });
    recordAuroraTravelResponseSource({ source: 'clarification' });
    pushTrace(trace, {
      skill: 'travel_followup_reply_skill',
      status: 'clarify',
      startedAtMs: Date.now(),
      meta: {
        mode: 'clarification',
        focus: 'destination',
        has_official_alerts: false,
      },
    });
    recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'incomplete_structure' });
    recordAuroraTravelSkillSkip({ skill: 'travel_kb_write_skill', reason: 'incomplete_structure' });
    pushTrace(trace, {
      skill: 'travel_kb_write_skill',
      status: 'skip',
      startedAtMs: Date.now(),
      meta: { reason: 'incomplete_structure' },
    });

    return {
      ok: true,
      travel_skills_version: TRAVEL_SKILLS_VERSION,
      travel_skills_trace: trace,
      assistant_text: clarificationText,
      suggested_chips: clarificationChips,
      pending_clarification: {
        type: 'destination_ambiguous',
        normalized_query: destinationResolution.normalized_query || destinationInput || null,
        candidates: Array.isArray(destinationResolution.candidates) ? destinationResolution.candidates.slice(0, 5) : [],
      },
      env_stress_patch: null,
      travel_readiness: null,
      travel_kb_hit: false,
      travel_kb_write_queued: false,
      travel_skill_invocation_matrix: {
        llm_called: false,
        llm_skip_reason: 'destination_ambiguous',
        reco_called: false,
        reco_skip_reason: 'destination_ambiguous',
        store_called: false,
        store_skip_reason: 'destination_ambiguous',
        kb_write_queued: false,
        kb_write_skip_reason: 'incomplete_structure',
      },
      travel_followup_state: {
        focus: 'destination',
        reply_sig: 'destination_ambiguous',
        question_hash: questionHash,
        updated_at_ms: nowMs,
      },
      reco_preview: null,
      store_channel: null,
      env_source: 'pending_clarification',
      degraded: true,
      quality_reason: 'destination_ambiguous',
    };
  }

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
        destinationPlace: destinationPlace || null,
        startDate,
        endDate,
        userLocale,
      });
    } else {
      destinationWeather = climateFallback({
        destination,
        destinationPlace: destinationPlace || null,
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
    destinationWeather = climateFallback({
      destination,
      destinationPlace: destinationPlace || null,
      startDate,
      endDate,
      reason: 'live_error',
      userLocale,
    });
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
  const llmDecision = decideLlmCalibrationTrigger({ destination });
  const travelLlmInput = {
    destination,
    start_date: startDate,
    end_date: endDate,
    month_bucket: monthBucket,
    profile: {
      skinType: pickProfileText(profile, 'skinType', 'skin_type', 40),
      sensitivity: pickProfileText(profile, 'sensitivity', 'sensitivity', 40),
      barrierStatus: pickProfileText(profile, 'barrierStatus', 'barrier_status', 40),
      region: homeRegion || null,
      goals: Array.isArray(profile.goals) ? profile.goals.slice(0, 8).map((g) => normalizeText(g, 60)).filter(Boolean) : [],
      budgetTier: pickProfileText(profile, 'budgetTier', 'budget_tier', 40),
      currentRoutine: normalizeText(
        typeof profile.currentRoutine === 'string'
          ? profile.currentRoutine
          : isPlainObject(profile.currentRoutine) ? JSON.stringify(profile.currentRoutine) : '',
        600,
      ) || null,
      contraindications: Array.isArray(profile.contraindications)
        ? profile.contraindications.slice(0, 12).map((c) => normalizeText(c, 80)).filter(Boolean)
        : [],
      age_band: pickProfileText(profile, 'age_band', 'age_band', 24),
      pregnancy_status: pickProfileText(profile, 'pregnancy_status', 'pregnancy_status', 24),
      lactation_status: pickProfileText(profile, 'lactation_status', 'lactation_status', 24),
    },
    weather_source: normalizeText(destinationWeather && destinationWeather.source, 40) || null,
    weather_reason: normalizeText(destinationWeather && destinationWeather.reason, 80) || null,
    alerts_source: normalizeText(alertsPayload && alertsPayload.source, 40) || null,
    kb_hit: kbHit,
    question: message,
  };

  if (llmDecision.triggered) {
    llmCalled = true;
    recordAuroraTravelLlmTrigger({ reason: llmDecision.trigger_reason });
    try {
      llmResult = await calibrateTravelReadinessWithLlm({
        openaiClient,
        language,
        travelLlmInput,
        baseTravelReadiness: travelReadiness,
        timeoutMs: 3500,
        maxRetries: 1,
        logger,
      });

      if (isPlainObject(llmResult) && isPlainObject(llmResult.travel_readiness)) {
        travelReadiness = llmResult.travel_readiness;
      }

      const llmRawOutcome = normalizeText(llmResult && llmResult.outcome, 40) || 'error';
      const llmOutcome = normalizeLlmTraceOutcome(llmRawOutcome);
      const llmSourceMeta = isPlainObject(llmResult && llmResult.source_meta) ? llmResult.source_meta : {};
      const llmErrorCode =
        normalizeText(llmSourceMeta.error_code || llmResult?.error_reason || llmSourceMeta.reason, 120) || null;
      recordAuroraTravelLlmCall({ outcome: llmOutcome });
      pushTrace(trace, {
        skill: 'travel_llm_calibration_skill',
        status: llmOutcome,
        startedAtMs: llmStartedAt,
        meta: {
          triggered: true,
          trigger_reason: llmDecision.trigger_reason,
          skip_reason: null,
          outcome: llmOutcome,
          used: Boolean(llmResult && llmResult.used),
          model: normalizeText(llmSourceMeta.model, 120) || null,
          prompt_hash: normalizeText(llmSourceMeta.prompt_hash, 48) || null,
          prompt_chars: toNumber(llmSourceMeta.prompt_chars),
          error_code: llmErrorCode,
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
          triggered: true,
          trigger_reason: llmDecision.trigger_reason,
          skip_reason: null,
          outcome: 'error',
          error_code: normalizeText(err && (err.code || err.message), 120) || 'llm_calibration_error',
        },
      });
    }
  } else {
    llmSkipReason = llmDecision.skip_reason;
    recordAuroraTravelLlmSkip({ reason: llmSkipReason });
    recordAuroraTravelLlmCall({ outcome: llmDecision.outcome });
    pushTrace(trace, {
      skill: 'travel_llm_calibration_skill',
      status: 'skip',
      startedAtMs: llmStartedAt,
      meta: {
        triggered: false,
        trigger_reason: null,
        skip_reason: llmSkipReason,
        outcome: llmDecision.outcome,
      },
    });
  }

  const recoStartedAt = Date.now();
  const recoTriggeredByMessage = shouldTriggerRecoPreview(message);
  if (!destination) {
    recoSkipReason = normalizeRecoSkipReason('destination_missing');
    recordAuroraTravelSkillSkip({ skill: 'travel_reco_preview_skill', reason: recoSkipReason });
    pushTrace(trace, {
      skill: 'travel_reco_preview_skill',
      status: 'skip',
      startedAtMs: recoStartedAt,
      meta: { reason: recoSkipReason },
    });
  } else if (!recoTriggeredByMessage) {
    recoSkipReason = normalizeRecoSkipReason('trigger_not_matched');
    recordAuroraTravelSkillSkip({ skill: 'travel_reco_preview_skill', reason: recoSkipReason });
    pushTrace(trace, {
      skill: 'travel_reco_preview_skill',
      status: 'skip',
      startedAtMs: recoStartedAt,
      meta: { reason: recoSkipReason },
    });
  } else {
    recoCalled = true;
    try {
      recoPreview = buildRecoPreview({
        travelReadiness,
        profile,
        language,
      });
      const recoCount = Array.isArray(recoPreview && recoPreview.recommendations)
        ? recoPreview.recommendations.length
        : 0;
      if (!recoCount) {
        recoPreview = null;
        recoSkipReason = normalizeRecoSkipReason('no_products');
        recordAuroraTravelSkillSkip({ skill: 'travel_reco_preview_skill', reason: recoSkipReason });
        pushTrace(trace, {
          skill: 'travel_reco_preview_skill',
          status: 'skip',
          startedAtMs: recoStartedAt,
          meta: { reason: recoSkipReason },
        });
      } else {
        pushTrace(trace, {
          skill: 'travel_reco_preview_skill',
          status: 'ok',
          startedAtMs: recoStartedAt,
          meta: {
            source: normalizeText(recoPreview && recoPreview.source, 80) || null,
            recommendations: recoCount,
          },
        });
      }
    } catch (err) {
      recoPreview = null;
      pushTrace(trace, {
        skill: 'travel_reco_preview_skill',
        status: 'error',
        startedAtMs: recoStartedAt,
        meta: {
          reason: normalizeText(err && (err.code || err.message), 120) || 'error',
        },
      });
    }
  }

  const storeStartedAt = Date.now();
  const storeTriggeredByMessage = shouldTriggerStoreChannel(message);
  if (!destination) {
    storeSkipReason = normalizeStoreSkipReason('destination_missing');
    recordAuroraTravelSkillSkip({ skill: 'travel_store_channel_skill', reason: storeSkipReason });
    pushTrace(trace, {
      skill: 'travel_store_channel_skill',
      status: 'skip',
      startedAtMs: storeStartedAt,
      meta: { reason: storeSkipReason },
    });
  } else if (!storeTriggeredByMessage) {
    storeSkipReason = normalizeStoreSkipReason('trigger_not_matched');
    recordAuroraTravelSkillSkip({ skill: 'travel_store_channel_skill', reason: storeSkipReason });
    pushTrace(trace, {
      skill: 'travel_store_channel_skill',
      status: 'skip',
      startedAtMs: storeStartedAt,
      meta: { reason: storeSkipReason },
    });
  } else {
    storeCalled = true;
    try {
      storeChannel = buildStoreChannel({ travelReadiness, destination });
      const channelCount = Array.isArray(storeChannel && storeChannel.buying_channels)
        ? storeChannel.buying_channels.length
        : 0;
      const storeCount = Array.isArray(storeChannel && storeChannel.store_examples)
        ? storeChannel.store_examples.length
        : 0;
      if (!channelCount) {
        storeChannel = null;
        storeSkipReason = normalizeStoreSkipReason('no_channels');
        recordAuroraTravelSkillSkip({ skill: 'travel_store_channel_skill', reason: storeSkipReason });
        pushTrace(trace, {
          skill: 'travel_store_channel_skill',
          status: 'skip',
          startedAtMs: storeStartedAt,
          meta: { reason: storeSkipReason },
        });
      } else {
        pushTrace(trace, {
          skill: 'travel_store_channel_skill',
          status: 'ok',
          startedAtMs: storeStartedAt,
          meta: {
            channels: channelCount,
            stores: storeCount,
          },
        });
      }
    } catch (err) {
      storeChannel = null;
      pushTrace(trace, {
        skill: 'travel_store_channel_skill',
        status: 'error',
        startedAtMs: storeStartedAt,
        meta: {
          reason: normalizeText(err && (err.code || err.message), 120) || 'error',
        },
      });
    }
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

  if (isPlainObject(travelReadiness) && isPlainObject(followupReply && followupReply.structured_sections)) {
    travelReadiness = {
      ...travelReadiness,
      structured_sections: followupReply.structured_sections,
    };
  }

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
          kbWriteSkipReason = normalizeKbWriteSkipReason('backpressure_drop');
          recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'backpressure_drop' });
        } else {
          kbWriteQueued = true;
          kbWriteSkipReason = null;
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
        kbWriteSkipReason = normalizeKbWriteSkipReason('entry_invalid');
        recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'entry_invalid' });
      }

      if (!kbWriteQueued) {
        recordAuroraTravelSkillSkip({
          skill: 'travel_kb_write_skill',
          reason: kbWriteSkipReason || normalizeKbWriteSkipReason('incomplete_structure'),
        });
      }
      pushTrace(trace, {
        skill: 'travel_kb_write_skill',
        status: kbWriteQueued ? 'queued' : 'skip',
        startedAtMs: kbWriteStartedAt,
        meta: {
          reason: kbWriteQueued
            ? 'queued'
            : kbWriteSkipReason || normalizeKbWriteSkipReason('incomplete_structure'),
        },
      });
    } else {
      kbWriteSkipReason = normalizeKbWriteSkipReason(
        normalizeText(kbBackfill && kbBackfill.reason, 80) === 'safety_conflict'
          ? 'safety_conflict'
          : 'incomplete_structure',
      );
      recordAuroraTravelKbWrite({
        outcome: 'skip',
        reason: kbWriteSkipReason,
      });
      recordAuroraTravelSkillSkip({
        skill: 'travel_kb_write_skill',
        reason: kbWriteSkipReason,
      });
      pushTrace(trace, {
        skill: 'travel_kb_write_skill',
        status: 'skip',
        startedAtMs: kbWriteStartedAt,
        meta: {
          reason: kbWriteSkipReason,
        },
      });
    }
  } else {
    kbWriteSkipReason = normalizeKbWriteSkipReason('incomplete_structure');
    recordAuroraTravelKbWrite({ outcome: 'skip', reason: 'disabled' });
    recordAuroraTravelSkillSkip({
      skill: 'travel_kb_write_skill',
      reason: kbWriteSkipReason,
    });
    pushTrace(trace, {
      skill: 'travel_kb_write_skill',
      status: 'skip',
      startedAtMs: kbWriteStartedAt,
      meta: { reason: kbWriteSkipReason },
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
  const invocationMatrix = {
    llm_called: llmCalled,
    llm_skip_reason: llmCalled ? null : llmSkipReason,
    reco_called: recoCalled,
    reco_skip_reason: recoCalled ? recoSkipReason : recoSkipReason || null,
    store_called: storeCalled,
    store_skip_reason: storeCalled ? storeSkipReason : storeSkipReason || null,
    kb_write_queued: kbWriteQueued,
    kb_write_skip_reason: kbWriteQueued ? 'queued' : kbWriteSkipReason || 'incomplete_structure',
  };

  return {
    ok: Boolean(quality.ok),
    travel_skills_version: TRAVEL_SKILLS_VERSION,
    travel_skills_trace: trace,
    assistant_text: assistantText,
    env_stress_patch: envStressPatch,
    travel_readiness: travelReadiness,
    travel_kb_hit: kbHit,
    travel_kb_write_queued: kbWriteQueued,
    travel_skill_invocation_matrix: invocationMatrix,
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
  buildDestinationClarificationAssistantText,
  buildDestinationClarificationChips,
  __internal: {
    buildDestinationClarificationAssistantText,
    buildDestinationClarificationChips,
    shouldTriggerRecoPreview,
    shouldTriggerStoreChannel,
    shouldTriggerLlmCalibration,
    decideLlmCalibrationTrigger,
    mergeKbPrefillIntoReadiness,
    buildRecoPreview,
    buildStoreChannel,
    normalizeRecoSkipReason,
    normalizeStoreSkipReason,
    normalizeKbWriteSkipReason,
  },
};
