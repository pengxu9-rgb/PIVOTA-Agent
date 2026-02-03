const axios = require('axios');
const OpenAI = require('openai');
const sharp = require('sharp');
const fs = require('fs');
const { buildRequestContext } = require('./requestContext');
const { buildEnvelope, makeAssistantMessage, makeEvent } = require('./envelope');
const {
  V1ChatRequestSchema,
  UserProfilePatchSchema,
  TrackerLogSchema,
  RoutineSimulateRequestSchema,
  OffersResolveRequestSchema,
  AffiliateOutcomeRequestSchema,
  ProductParseRequestSchema,
  ProductAnalyzeRequestSchema,
  DupeCompareRequestSchema,
  RecoGenerateRequestSchema,
  PhotosPresignRequestSchema,
  PhotosConfirmRequestSchema,
  SkinAnalysisRequestSchema,
} = require('./schemas');
const {
  getUserProfile,
  upsertUserProfile,
  upsertSkinLog,
  getRecentSkinLogs,
  isCheckinDue,
} = require('./memoryStore');
const {
  profileCompleteness,
  looksLikeDiagnosisStart,
  recommendationsAllowed,
  stateChangeAllowed,
  shouldDiagnosisGate,
  buildDiagnosisPrompt,
  buildDiagnosisChips,
  stripRecommendationCards,
} = require('./gating');
const {
  normalizeProductParse,
  normalizeProductAnalysis,
  enrichProductAnalysisPayload,
  normalizeDupeCompare,
  normalizeRecoGenerate,
} = require('./normalize');
const { simulateConflicts } = require('./routineRules');
const { auroraChat, buildContextPrefix } = require('./auroraDecisionClient');
const { extractJsonObject } = require('./jsonExtract');
const { parseMultipart, rmrf } = require('../lookReplicator/multipart');
const {
  normalizeBudgetHint,
  mapConcerns,
  mapBarrierStatus,
  mapAuroraProductParse,
  mapAuroraProductAnalysis,
  mapAuroraAlternativesToDupeCompare,
  mapAuroraAlternativesToRecoAlternatives,
  mapAuroraRoutineToRecoGenerate,
} = require('./auroraStructuredMapper');

const AURORA_DECISION_BASE_URL = String(process.env.AURORA_DECISION_BASE_URL || '').replace(/\/$/, '');
const PIVOTA_BACKEND_BASE_URL = String(process.env.PIVOTA_BACKEND_BASE_URL || process.env.PIVOTA_API_BASE || '')
  .replace(/\/$/, '');
const INCLUDE_RAW_AURORA_CONTEXT = String(process.env.AURORA_BFF_INCLUDE_RAW_CONTEXT || '').toLowerCase() === 'true';
const USE_AURORA_BFF_MOCK = String(process.env.AURORA_BFF_USE_MOCK || '').toLowerCase() === 'true';
const PIVOTA_BACKEND_AGENT_API_KEY = String(
  process.env.PIVOTA_BACKEND_AGENT_API_KEY ||
    process.env.PIVOTA_BACKEND_API_KEY ||
    process.env.PIVOTA_API_KEY ||
    process.env.SHOP_GATEWAY_AGENT_API_KEY ||
    process.env.PIVOTA_AGENT_API_KEY ||
    process.env.AGENT_API_KEY ||
    '',
).trim();
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || '').trim();
const SKIN_VISION_ENABLED = String(process.env.AURORA_SKIN_VISION_ENABLED || '').toLowerCase() === 'true';
const SKIN_VISION_MODEL = String(process.env.AURORA_SKIN_VISION_MODEL || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
const SKIN_VISION_TIMEOUT_MS = Math.max(
  2000,
  Math.min(30000, Number(process.env.AURORA_SKIN_VISION_TIMEOUT_MS || 12000)),
);
const PHOTO_UPLOAD_PROXY_MAX_BYTES = Math.max(
  1024 * 1024,
  Math.min(25 * 1024 * 1024, Number(process.env.AURORA_PHOTO_UPLOAD_MAX_BYTES || 10 * 1024 * 1024)),
);

const RECO_ALTERNATIVES_TIMEOUT_MS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_TIMEOUT_MS || 9000);
  const v = Number.isFinite(n) ? Math.trunc(n) : 9000;
  return Math.max(2000, Math.min(20000, v));
})();

const RECO_ALTERNATIVES_MAX_PRODUCTS = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_MAX_PRODUCTS || 2);
  const v = Number.isFinite(n) ? Math.trunc(n) : 2;
  return Math.max(0, Math.min(6, v));
})();

const RECO_ALTERNATIVES_CONCURRENCY = (() => {
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_CONCURRENCY || 2);
  const v = Number.isFinite(n) ? Math.trunc(n) : 2;
  return Math.max(1, Math.min(4, v));
})();

function getCheckoutToken(req) {
  const v = req.get('X-Checkout-Token') || req.get('x-checkout-token');
  return v ? String(v).trim() : '';
}

function buildPivotaBackendAuthHeaders(req) {
  const checkoutToken = getCheckoutToken(req);
  if (checkoutToken) return { 'X-Checkout-Token': checkoutToken };
  if (PIVOTA_BACKEND_AGENT_API_KEY) {
    return { 'X-API-Key': PIVOTA_BACKEND_AGENT_API_KEY, Authorization: `Bearer ${PIVOTA_BACKEND_AGENT_API_KEY}` };
  }
  return {};
}

let openaiClient;
function getOpenAIClient() {
  if (!OPENAI_API_KEY) return null;
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: OPENAI_API_KEY,
      ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
    });
  }
  return openaiClient;
}

function chooseVisionPhoto(passedPhotos) {
  if (!Array.isArray(passedPhotos) || !passedPhotos.length) return null;
  return (
    passedPhotos.find((p) => String(p.slot_id || '').trim().toLowerCase() === 'daylight') ||
    passedPhotos[0] ||
    null
  );
}

async function fetchPhotoBytesFromPivotaBackend({ req, photoId } = {}) {
  if (!photoId) return { ok: false, reason: 'photo_id_missing' };
  if (!PIVOTA_BACKEND_BASE_URL) return { ok: false, reason: 'pivota_backend_not_configured' };

  const authHeaders = buildPivotaBackendAuthHeaders(req);
  if (!Object.keys(authHeaders).length) return { ok: false, reason: 'pivota_backend_auth_not_configured' };

  const upstreamResp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}/photos/download-url`, {
    timeout: 12000,
    validateStatus: () => true,
    headers: authHeaders,
    params: { upload_id: photoId },
  });

  const download = upstreamResp && upstreamResp.data && upstreamResp.data.download ? upstreamResp.data.download : null;
  const downloadUrl = download && typeof download.url === 'string' ? download.url.trim() : '';
  if (upstreamResp.status !== 200 || !downloadUrl) {
    const detail = pickUpstreamErrorDetail(upstreamResp.data);
    return {
      ok: false,
      reason: 'pivota_backend_download_url_failed',
      status: upstreamResp.status,
      detail: detail || null,
    };
  }

  const contentTypeUpstream =
    typeof upstreamResp.data.content_type === 'string' && upstreamResp.data.content_type.trim()
      ? upstreamResp.data.content_type.trim()
      : null;

  const blobResp = await axios.get(downloadUrl, {
    timeout: 12000,
    validateStatus: () => true,
    responseType: 'arraybuffer',
    maxBodyLength: 15 * 1024 * 1024,
    maxContentLength: 15 * 1024 * 1024,
  });
  if (blobResp.status !== 200 || !blobResp.data) {
    return { ok: false, reason: 'photo_download_failed', status: blobResp.status };
  }
  const buffer = Buffer.from(blobResp.data);
  const contentTypeHeader =
    blobResp.headers && (blobResp.headers['content-type'] || blobResp.headers['Content-Type'])
      ? String(blobResp.headers['content-type'] || blobResp.headers['Content-Type']).trim()
      : null;
  return {
    ok: true,
    buffer,
    contentType: contentTypeHeader || contentTypeUpstream || 'image/jpeg',
  };
}

async function runOpenAIVisionSkinAnalysis({ imageBuffer, language, profileSummary, recentLogsSummary } = {}) {
  if (!SKIN_VISION_ENABLED) return { ok: false, reason: 'vision_disabled' };
  const client = getOpenAIClient();
  if (!client) return { ok: false, reason: 'openai_not_configured' };
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return { ok: false, reason: 'image_missing' };

  const optimized = await sharp(imageBuffer)
    .rotate()
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const dataUrl = `data:image/jpeg;base64,${optimized.toString('base64')}`;

  const replyLanguage = language === 'CN' ? 'Simplified Chinese' : 'English';
  const replyInstruction =
    language === 'CN' ? '请只用简体中文回答，不要使用英文。' : 'IMPORTANT: Reply ONLY in English. Do not use Chinese.';

  const profileLine = `profile=${JSON.stringify(profileSummary || {})}`;
  const logsLine = Array.isArray(recentLogsSummary) && recentLogsSummary.length ? `recent_logs=${JSON.stringify(recentLogsSummary)}` : '';

  const prompt =
    `${profileLine}\n` +
    `${logsLine ? `${logsLine}\n` : ''}` +
    `Task: You are a cautious skincare assistant. Use the provided daylight selfie photo ONLY to infer *visible* skin signals (redness, acne, oiliness/shine, dryness/flaking, pigmentation, texture). Do NOT diagnose medical conditions.\n\n` +
    `Return ONLY a valid JSON object (no markdown) with this exact shape:\n` +
    `{\n` +
    `  "features": [\n` +
    `    {"observation": "…", "confidence": "pretty_sure" | "somewhat_sure" | "not_sure"}\n` +
    `  ],\n` +
    `  "strategy": "…",\n` +
    `  "needs_risk_check": true | false\n` +
    `}\n\n` +
    `Rules:\n` +
    `- DO NOT output any numeric scores/percentages.\n` +
    `- DO NOT infer age, race/ethnicity, pregnancy status, or health conditions.\n` +
    `- Observations must be cautious and actionable (barrier, acne risk, pigmentation, irritation, hydration, safety).\n` +
    `- Strategy must be stepwise and END with ONE direct clarifying question (must include a '?' or '？').\n` +
    `- DO NOT recommend specific products/brands.\n` +
    `- Keep it concise: 4–6 features; strategy under 900 characters.\n` +
    `Language: ${replyLanguage}.\n` +
    `${replyInstruction}\n`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SKIN_VISION_TIMEOUT_MS);
  try {
    const resp = await client.chat.completions.create(
      {
        model: SKIN_VISION_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You produce ONLY JSON.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      { signal: controller.signal },
    );

    const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message ? resp.choices[0].message.content : '';
    const parsedObj = extractJsonObject(content);
    const analysis = normalizeSkinAnalysisFromLLM(parsedObj, { language });
    if (!analysis) return { ok: false, reason: 'vision_output_invalid' };
    return { ok: true, analysis };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, reason: 'vision_timeout' };
    return { ok: false, reason: 'vision_failed', error: err && (err.code || err.message) ? String(err.code || err.message) : null };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function secondsUntilIso(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

function pickUpstreamErrorDetail(data) {
  if (!data) return null;
  if (typeof data === 'string') return data;
  if (data.detail) return data.detail;
  if (data.error) return data.error;
  if (data.message) return data.message;
  return null;
}

function normalizeSkinAnalysisFromLLM(obj, { language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const o = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  if (!o) return null;

  const featuresRaw = Array.isArray(o.features) ? o.features : [];
  const features = [];
  for (const raw of featuresRaw) {
    const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    if (!f) continue;
    const observation = typeof f.observation === 'string' ? f.observation.trim() : '';
    if (!observation) continue;
    const c = typeof f.confidence === 'string' ? f.confidence.trim() : '';
    const confidence = c === 'pretty_sure' || c === 'somewhat_sure' || c === 'not_sure' ? c : 'somewhat_sure';
    features.push({ observation, confidence });
  }

  const strategyRaw = typeof o.strategy === 'string' ? o.strategy.trim() : '';
  const needsRiskCheckRaw = o.needs_risk_check ?? o.needsRiskCheck;
  const needs_risk_check = typeof needsRiskCheckRaw === 'boolean' ? needsRiskCheckRaw : false;

  const strategy = strategyRaw || (lang === 'CN' ? '我需要再确认一点信息：你最近是否有刺痛/泛红？' : 'Quick check: have you had stinging or redness recently?');

  if (!features.length && !strategyRaw) return null;

  return {
    features: features.slice(0, 6),
    strategy: strategy.slice(0, 1200),
    needs_risk_check,
  };
}

function buildRuleBasedSkinAnalysis({ profile, recentLogs, language }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const p = profile || {};
  const goals = Array.isArray(p.goals) ? p.goals : [];

  const features = [];
  if (p.barrierStatus === 'impaired') {
    features.push({
      observation:
        lang === 'CN'
          ? '你自述屏障不稳定（易刺痛/泛红）→ 先把“舒缓修护”放在优先级第一。'
          : 'You reported an irritated barrier → prioritize calming + repair first.',
      confidence: 'pretty_sure',
    });
  }
  if (p.skinType === 'oily' || p.skinType === 'combination') {
    features.push({
      observation:
        lang === 'CN'
          ? '偏油/混油更容易出现堵塞与闭口，但也可能“外油内干”，不要过度清洁。'
          : 'Oily/combination skin is more clog-prone; avoid over-cleansing (oiliness can still be dehydration).',
      confidence: 'somewhat_sure',
    });
  }
  if (p.sensitivity === 'high') {
    features.push({
      observation:
        lang === 'CN'
          ? '敏感度偏高时，活性成分需要更慢的引入节奏（频率/浓度/叠加要保守）。'
          : 'If sensitivity is high, introduce actives slowly (frequency/strength/stacking should be conservative).',
      confidence: 'pretty_sure',
    });
  }
  if (goals.includes('pores') || goals.includes('acne')) {
    features.push({
      observation:
        lang === 'CN'
          ? '你的目标包含毛孔/控痘 → 后续更适合“温和去角质 + 控油”路线，但要以不刺激为前提。'
          : 'Your goals include pores/acne → gentle exfoliation + oil control may help later, if tolerated.',
      confidence: 'somewhat_sure',
    });
  }

  const latest = Array.isArray(recentLogs) && recentLogs[0] ? recentLogs[0] : null;
  if (latest && (typeof latest.redness === 'number' || typeof latest.acne === 'number' || typeof latest.hydration === 'number')) {
    const redness = typeof latest.redness === 'number' ? latest.redness : null;
    const acne = typeof latest.acne === 'number' ? latest.acne : null;
    const hydration = typeof latest.hydration === 'number' ? latest.hydration : null;
    const parts = [];
    if (redness != null) parts.push(lang === 'CN' ? `泛红 ${redness}/5` : `redness ${redness}/5`);
    if (acne != null) parts.push(lang === 'CN' ? `痘痘 ${acne}/5` : `acne ${acne}/5`);
    if (hydration != null) parts.push(lang === 'CN' ? `补水 ${hydration}/5` : `hydration ${hydration}/5`);
    if (parts.length) {
      features.push({
        observation:
          lang === 'CN'
            ? `你最近一次打卡：${parts.join(' · ')}（我会按这个趋势给建议）。`
            : `Latest check-in: ${parts.join(' · ')} (I’ll tailor advice to this trend).`,
        confidence: 'pretty_sure',
      });
    }
  }

  const strategy =
    lang === 'CN'
      ? '接下来 7 天建议：\n1) 护肤先“少而稳”：温和洁面 + 保湿 + 白天 SPF。\n2) 如果刺痛/泛红：先停用强刺激活性（酸/高浓 VC/视黄醇），以修护为主。\n3) 若想开始控毛孔/闭口：先从低频（每周 2 次）开始，观察 72 小时反应。\n\n你最近有刺痛/泛红吗？'
      : 'Next 7 days:\n1) Keep it minimal: gentle cleanser + moisturizer + daytime SPF.\n2) If stinging/redness: pause harsh actives (acids/high-strength vitamin C/retinoids) and focus on repair.\n3) If you want pores/texture work: start low frequency (2x/week) and watch the 72h response.\n\nDo you have stinging or redness recently?';

  return {
    features: features.slice(0, 6),
    strategy: strategy.slice(0, 1200),
    needs_risk_check: false,
  };
}

function requireAuroraUid(ctx) {
  const uid = String(ctx.aurora_uid || '').trim();
  if (!uid) {
    const err = new Error('Missing X-Aurora-UID');
    err.status = 400;
    err.code = 'MISSING_AURORA_UID';
    throw err;
  }
  return uid;
}

function parseProfilePatchFromAction(action) {
  if (!action) return null;
  if (typeof action === 'object' && action.data && typeof action.data === 'object') {
    const patch = action.data.profile_patch || action.data.profilePatch;
    if (patch && typeof patch === 'object') return patch;
  }

  // Fallback: parse chip ids like "profile.skinType.oily".
  const id = typeof action === 'string' ? action : action && action.action_id;
  if (!id || typeof id !== 'string') return null;
  const parts = id.split('.');
  if (parts.length < 3 || parts[0] !== 'profile') return null;
  const key = parts[1];
  const value = parts.slice(2).join('.');
  if (!key || !value) return null;
  if (key === 'goals') return { goals: [value] };
  if (key === 'skinType') return { skinType: value };
  if (key === 'sensitivity') return { sensitivity: value };
  if (key === 'barrierStatus') return { barrierStatus: value };
  return null;
}

function extractReplyTextFromAction(action) {
  if (!action || typeof action !== 'object') return null;
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return null;
  const raw =
    (typeof data.reply_text === 'string' && data.reply_text) ||
    (typeof data.replyText === 'string' && data.replyText) ||
    (typeof data.text === 'string' && data.text) ||
    null;
  const text = raw ? String(raw).trim() : '';
  return text || null;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const s = value.trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on';
}

function extractIncludeAlternativesFromAction(action) {
  if (!action || typeof action !== 'object') return false;
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return false;
  return coerceBoolean(data.include_alternatives ?? data.includeAlternatives);
}

function summarizeProfileForContext(profile) {
  if (!profile) return null;
  return {
    skinType: profile.skinType || null,
    sensitivity: profile.sensitivity || null,
    barrierStatus: profile.barrierStatus || null,
    goals: Array.isArray(profile.goals) ? profile.goals : [],
    region: profile.region || null,
    budgetTier: profile.budgetTier || null,
  };
}

function deepHasKey(obj, predicate, depth = 0) {
  if (depth > 6) return false;
  if (!obj) return false;
  if (Array.isArray(obj)) return obj.some((v) => deepHasKey(v, predicate, depth + 1));
  if (typeof obj !== 'object') return false;
  for (const [k, v] of Object.entries(obj)) {
    if (predicate(k)) return true;
    if (deepHasKey(v, predicate, depth + 1)) return true;
  }
  return false;
}

function structuredContainsCommerceLikeFields(structured) {
  const commerceKeys = new Set([
    'recommendations',
    'reco',
    'offers',
    'offer',
    'checkout',
    'purchase_route',
    'purchaseroute',
    'affiliate_url',
    'affiliateurl',
    'internal_checkout',
    'internalcheckout',
  ]);
  return deepHasKey(structured, (k) => commerceKeys.has(String(k || '').trim().toLowerCase()));
}

function getUpstreamStructuredOrJson(upstream) {
  if (upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)) {
    return upstream.structured;
  }
  if (upstream && typeof upstream.answer === 'string') return extractJsonObject(upstream.answer);
  return null;
}

function unwrapCodeFence(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('```')) return t;
  const firstNewline = t.indexOf('\n');
  const lastFence = t.lastIndexOf('```');
  if (firstNewline === -1 || lastFence === -1 || lastFence <= firstNewline) return t;
  return t.slice(firstNewline + 1, lastFence).trim();
}

function looksLikeJsonOrCode(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) return true;

  if (t.startsWith('```')) {
    const firstLine = t.split('\n')[0].toLowerCase();
    if (firstLine.includes('json') || firstLine.includes('typescript') || firstLine.includes('javascript') || firstLine.includes('ts') || firstLine.includes('js')) {
      return true;
    }
    const inner = unwrapCodeFence(t);
    if ((inner.startsWith('{') && inner.endsWith('}')) || (inner.startsWith('[') && inner.endsWith(']'))) return true;
  }

  return false;
}

function sanitizeUpstreamAnswer(answer, { language, hasCards, hasStructured } = {}) {
  const t = typeof answer === 'string' ? answer : '';
  if (!looksLikeJsonOrCode(t)) return t;

  const lang = language === 'CN' ? 'CN' : 'EN';
  const hasAnything = Boolean(hasCards) || Boolean(hasStructured);
  if (lang === 'CN') {
    return hasAnything ? '我已经把结果整理成结构化卡片（见下方）。' : '我已收到你的信息。';
  }
  return hasAnything ? 'I formatted the result into structured cards below.' : 'Got it.';
}

function buildProductInputText(inputObj, url) {
  if (typeof url === 'string' && url.trim()) return url.trim();
  const o = inputObj && typeof inputObj === 'object' && !Array.isArray(inputObj) ? inputObj : null;
  if (!o) return null;
  const brand = typeof o.brand === 'string' ? o.brand.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const display = typeof o.display_name === 'string' ? o.display_name.trim() : typeof o.displayName === 'string' ? o.displayName.trim() : '';
  const sku = typeof o.sku_id === 'string' ? o.sku_id.trim() : typeof o.skuId === 'string' ? o.skuId.trim() : '';
  const pid = typeof o.product_id === 'string' ? o.product_id.trim() : typeof o.productId === 'string' ? o.productId.trim() : '';
  const bestName = display || name;
  if (brand && bestName) return `${brand} ${bestName}`.trim();
  if (bestName) return bestName;
  if (sku) return sku;
  if (pid) return pid;
  return null;
}

function coerceRecoItemForUi(item, { lang } = {}) {
  const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
  if (!base) return item;

  const skuCandidate =
    base.sku && typeof base.sku === 'object' && !Array.isArray(base.sku)
      ? base.sku
      : base.product && typeof base.product === 'object' && !Array.isArray(base.product)
        ? base.product
        : null;

  const skuId =
    (skuCandidate && typeof skuCandidate.sku_id === 'string' ? skuCandidate.sku_id : null) ||
    (skuCandidate && typeof skuCandidate.skuId === 'string' ? skuCandidate.skuId : null) ||
    (typeof base.sku_id === 'string' ? base.sku_id : null) ||
    (typeof base.skuId === 'string' ? base.skuId : null) ||
    (skuCandidate && typeof skuCandidate.product_id === 'string' ? skuCandidate.product_id : null) ||
    (skuCandidate && typeof skuCandidate.productId === 'string' ? skuCandidate.productId : null) ||
    (typeof base.product_id === 'string' ? base.product_id : null) ||
    (typeof base.productId === 'string' ? base.productId : null) ||
    null;

  const productId =
    (skuCandidate && typeof skuCandidate.product_id === 'string' ? skuCandidate.product_id : null) ||
    (skuCandidate && typeof skuCandidate.productId === 'string' ? skuCandidate.productId : null) ||
    (typeof base.product_id === 'string' ? base.product_id : null) ||
    (typeof base.productId === 'string' ? base.productId : null) ||
    skuId ||
    null;

  const brand =
    (skuCandidate && typeof skuCandidate.brand === 'string' ? skuCandidate.brand.trim() : '') ||
    (typeof base.brand === 'string' ? base.brand.trim() : '') ||
    '';
  const name =
    (skuCandidate && typeof skuCandidate.name === 'string' ? skuCandidate.name.trim() : '') ||
    (typeof base.name === 'string' ? base.name.trim() : '') ||
    '';
  const displayName =
    (skuCandidate && typeof skuCandidate.display_name === 'string' ? skuCandidate.display_name.trim() : '') ||
    (skuCandidate && typeof skuCandidate.displayName === 'string' ? skuCandidate.displayName.trim() : '') ||
    (typeof base.display_name === 'string' ? base.display_name.trim() : '') ||
    (typeof base.displayName === 'string' ? base.displayName.trim() : '') ||
    name ||
    '';
  const category =
    (skuCandidate && typeof skuCandidate.category === 'string' ? skuCandidate.category.trim() : '') ||
    (typeof base.category === 'string' ? base.category.trim() : '') ||
    '';

  const slotRaw = typeof base.slot === 'string' ? base.slot.trim().toLowerCase() : '';
  const slot = slotRaw === 'am' || slotRaw === 'pm' ? slotRaw : 'other';
  const step =
    (typeof base.step === 'string' && base.step.trim()) ||
    (typeof base.category === 'string' && base.category.trim()) ||
    category ||
    (String(lang || '').toUpperCase() === 'CN' ? '推荐' : 'Recommendation');

  const notesRaw =
    Array.isArray(base.notes) ? base.notes
      : Array.isArray(base.reasons) ? base.reasons
        : Array.isArray(base.why) ? base.why
          : typeof base.reason === 'string' ? [base.reason]
            : typeof base.why === 'string' ? [base.why]
              : [];

  const notes = Array.isArray(notesRaw)
    ? notesRaw
      .map((v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()))
      .filter(Boolean)
      .slice(0, 8)
    : [];

  const nextSku = skuCandidate || skuId || productId || brand || name || displayName || category
    ? {
      ...(skuCandidate && typeof skuCandidate === 'object' ? skuCandidate : {}),
      ...(skuId ? { sku_id: skuId } : {}),
      ...(productId ? { product_id: productId } : {}),
      ...(brand ? { brand } : {}),
      ...(name ? { name } : {}),
      ...(displayName ? { display_name: displayName } : {}),
      ...(category ? { category } : {}),
    }
    : null;

  return {
    ...base,
    slot,
    step,
    ...(nextSku ? { sku: nextSku } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function buildAuroraRoutineQuery({ profile, focus, constraints, lang }) {
  const skinType = profile && typeof profile.skinType === 'string' ? profile.skinType : 'unknown';
  const barrierStatus = mapBarrierStatus(profile && profile.barrierStatus);
  const concerns = mapConcerns(profile && profile.goals);
  const region = profile && typeof profile.region === 'string' && profile.region.trim() ? profile.region.trim() : 'US';
  const budget = normalizeBudgetHint(profile && profile.budgetTier) || normalizeBudgetHint(constraints && constraints.budget) || '不确定';
  const goal = typeof focus === 'string' && focus.trim()
    ? focus.trim()
    : constraints && typeof constraints.goal === 'string' && constraints.goal.trim()
      ? constraints.goal.trim()
      : 'balanced routine';
  const preference = constraints && typeof constraints.preference === 'string' && constraints.preference.trim()
    ? constraints.preference.trim()
    : 'No special preference';

  const concernsStr = concerns.length ? concerns.join(', ') : 'none';
  const reply = lang === 'CN' ? 'Chinese' : 'English';

  const productsNote = profile && profile.currentRoutine ? `Current routine: ${JSON.stringify(profile.currentRoutine).slice(0, 1000)}\n` : '';

  return (
    `User profile: skin type ${skinType}; barrier status: ${barrierStatus}; concerns: ${concernsStr}; region: ${region}; budget: ${budget}.\n` +
    `Goal: ${goal}.\n` +
    `${productsNote}` +
    `Preference: ${preference}.\n` +
    `Please recommend a simple AM/PM skincare routine within my budget. Reply in ${reply}.`
  );
}

function looksLikeRoutineRequest(message, action) {
  const text = String(message || '').trim().toLowerCase();
  const id =
    typeof action === 'string'
      ? action
      : action && typeof action === 'object'
        ? action.action_id
        : '';
  const idText = String(id || '').trim().toLowerCase();

  if (idText.includes('routine') || idText.includes('reco_routine')) return true;
  if (!text) return false;
  if (text.includes('routine')) return true;
  if (/am\s*\/\s*pm/.test(text)) return true;
  if (/生成.*(早晚|am|pm).*(护肤|routine)/.test(text)) return true;
  if (/(早晚护肤|护肤方案)/.test(text)) return true;
  return false;
}

function buildBudgetGatePrompt(language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  if (lang === 'CN') {
    return (
      '为了继续生成你的 AM/PM routine，我需要先确认 1 个信息：\n' +
      '你的月预算大概是多少？（点选即可）'
    );
  }
  return 'To continue building your AM/PM routine, what is your monthly budget? (tap one)';
}

function buildBudgetGateChips(language) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const opts = [
    ['¥200', '¥200'],
    ['¥500', '¥500'],
    ['¥1000+', '¥1000+'],
    ['不确定', lang === 'CN' ? '不确定' : 'Not sure'],
  ];
  return opts.map(([tier, label]) => ({
    chip_id: `chip.budget.${tier.replace(/[^\w]+/g, '_')}`,
    label,
    kind: 'quick_reply',
    data: { profile_patch: { budgetTier: tier }, include_alternatives: true },
  }));
}

async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];

  const concurrency = Math.max(1, Math.min(8, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 1));
  const out = new Array(list.length);
  let cursor = 0;

  async function runOne() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        out[idx] = await worker(list[idx], idx);
      } catch (err) {
        out[idx] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => runOne());
  await Promise.all(workers);
  return out;
}

function extractAnchorIdFromProductLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw =
    (typeof obj.sku_id === 'string' && obj.sku_id) ||
    (typeof obj.skuId === 'string' && obj.skuId) ||
    (typeof obj.product_id === 'string' && obj.product_id) ||
    (typeof obj.productId === 'string' && obj.productId) ||
    null;
  const v = raw ? String(raw).trim() : '';
  return v || null;
}

function mergeFieldMissing(a, b) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue;
    const field = typeof item.field === 'string' ? item.field.trim() : '';
    const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
    if (!field || !reason) continue;
    const key = `${field}::${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ field, reason });
  }
  return out;
}

async function fetchRecoAlternativesForProduct({ ctx, profileSummary, recentLogs, productInput, anchorId, logger }) {
  const inputText = String(productInput || '').trim();
  const anchor = anchorId ? String(anchorId).trim() : '';
  const bestInput = inputText || anchor;
  if (!bestInput) return { ok: false, alternatives: [], field_missing: [{ field: 'alternatives', reason: 'product_identity_missing' }] };

  const prefix = buildContextPrefix({
    profile: profileSummary || null,
    recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
    lang: ctx.lang,
    trigger_source: ctx.trigger_source,
    intent: 'alternatives',
  });

  const query =
    `${prefix}` +
    `Task: Parse the user's product input into a normalized product entity.\n` +
    `Input: ${bestInput}`;

  let upstream = null;
  try {
    upstream = await auroraChat({
      baseUrl: AURORA_DECISION_BASE_URL,
      query,
      timeoutMs: RECO_ALTERNATIVES_TIMEOUT_MS,
      ...(anchor ? { anchor_product_id: anchor } : {}),
    });
  } catch (err) {
    logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: alternatives upstream failed');
    return { ok: false, alternatives: [], field_missing: [{ field: 'alternatives', reason: 'upstream_error' }] };
  }

  const structured = getUpstreamStructuredOrJson(upstream);
  const alternativesRaw = structured && Array.isArray(structured.alternatives) ? structured.alternatives : [];
  const mapped = mapAuroraAlternativesToRecoAlternatives(alternativesRaw, { lang: ctx.lang, maxTotal: 3 });

  return {
    ok: true,
    alternatives: mapped,
    field_missing: mapped.length ? [] : [{ field: 'alternatives', reason: structured ? 'upstream_missing_or_empty' : 'upstream_missing_or_unstructured' }],
  };
}

async function enrichRecommendationsWithAlternatives({ ctx, profileSummary, recentLogs, recommendations, logger }) {
  const recos = Array.isArray(recommendations) ? recommendations : [];
  const maxProducts = RECO_ALTERNATIVES_MAX_PRODUCTS;
  if (!recos.length || maxProducts <= 0) return { recommendations: recos, field_missing: [] };

  if (!AURORA_DECISION_BASE_URL && !USE_AURORA_BFF_MOCK) {
    return { recommendations: recos, field_missing: [{ field: 'recommendations[].alternatives', reason: 'aurora_not_configured' }] };
  }

  const targets = [];
  for (let i = 0; i < recos.length; i += 1) {
    if (targets.length >= maxProducts) break;
    const item = recos[i];
    const base = item && typeof item === 'object' ? item : null;
    const candidate =
      base && base.sku && typeof base.sku === 'object'
        ? base.sku
        : base && base.product && typeof base.product === 'object'
          ? base.product
          : base;

    const inputText = buildProductInputText(candidate, base && typeof base.url === 'string' ? base.url : null);
    const anchorId = extractAnchorIdFromProductLike(candidate) || extractAnchorIdFromProductLike(base);
    if (!inputText && !anchorId) continue;
    targets.push({ idx: i, inputText, anchorId });
  }

  if (!targets.length) {
    return { recommendations: recos, field_missing: [{ field: 'recommendations[].alternatives', reason: 'recommendations_missing_product_identity' }] };
  }

  const results = await mapWithConcurrency(targets, RECO_ALTERNATIVES_CONCURRENCY, async (t) => {
    const out = await fetchRecoAlternativesForProduct({
      ctx,
      profileSummary,
      recentLogs,
      productInput: t.inputText,
      anchorId: t.anchorId,
      logger,
    });
    return { ...out, idx: t.idx };
  });

  const enriched = recos.slice();
  let anyEmpty = false;
  for (const r of results) {
    if (!r || typeof r !== 'object' || typeof r.idx !== 'number') continue;
    const base = enriched[r.idx];
    const next = base && typeof base === 'object' ? { ...base } : {};
    next.alternatives = Array.isArray(r.alternatives) ? r.alternatives : [];
    enriched[r.idx] = next;
    if (!next.alternatives.length) anyEmpty = true;
  }

  const field_missing = anyEmpty ? [{ field: 'recommendations[].alternatives', reason: 'alternatives_partial' }] : [];
  return { recommendations: enriched, field_missing };
}

async function generateRoutineReco({ ctx, profile, recentLogs, focus, constraints, includeAlternatives, logger }) {
  const profileSummary = summarizeProfileForContext(profile);
  const query = buildAuroraRoutineQuery({
    profile: { ...profileSummary, ...(profile && profile.currentRoutine ? { currentRoutine: profile.currentRoutine } : {}) },
    focus,
    constraints: constraints || {},
    lang: ctx.lang,
  });

  let upstream = null;
  try {
    upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 22000 });
  } catch (err) {
    if (err && err.code !== 'AURORA_NOT_CONFIGURED') {
      logger?.warn({ err: err.message }, 'aurora bff: routine upstream failed');
    }
  }

  const contextObj = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
  const routine = contextObj ? contextObj.routine : null;
  const contextMeta = contextObj && typeof contextObj === 'object' && !Array.isArray(contextObj) ? { ...contextObj } : {};
  if (profileSummary && profileSummary.budgetTier && !contextMeta.budget && !contextMeta.budget_cny) {
    contextMeta.budget = profileSummary.budgetTier;
  }
  const mapped = mapAuroraRoutineToRecoGenerate(routine, contextMeta);
  const norm = normalizeRecoGenerate(mapped);

  if (includeAlternatives) {
    const alt = await enrichRecommendationsWithAlternatives({
      ctx,
      profileSummary,
      recentLogs,
      recommendations: norm.payload.recommendations,
      logger,
    });
    norm.payload = { ...norm.payload, recommendations: alt.recommendations };
    norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
  }

  const suggestedChips = [];
  const nextActions = upstream && Array.isArray(upstream.next_actions) ? upstream.next_actions : [];
  if ((!norm.payload.recommendations || norm.payload.recommendations.length === 0) && nextActions.length) {
    for (const act of nextActions.slice(0, 8)) {
      if (!act || typeof act !== 'object') continue;
      const label = typeof act.label === 'string' ? act.label.trim() : typeof act.text === 'string' ? act.text.trim() : '';
      const text = typeof act.text === 'string' ? act.text.trim() : label;
      const id = typeof act.id === 'string' ? act.id.trim() : '';
      if (!label) continue;
      suggestedChips.push({
        chip_id: `chip.aurora.next_action.${id || label.replace(/\\s+/g, '_')}`.slice(0, 80),
        label,
        kind: 'quick_reply',
        data: { reply_text: text, aurora_action_id: id || null },
      });
    }
  }

  return { norm, suggestedChips };
}

async function generateProductRecommendations({ ctx, profile, recentLogs, message, includeAlternatives, logger }) {
  const profileSummary = summarizeProfileForContext(profile);
  const prefix = buildContextPrefix({
    profile: profileSummary || null,
    recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
    lang: ctx.lang,
    trigger_source: ctx.trigger_source,
    intent: 'reco_products',
  });

  const userAsk =
    String(message || '').trim() ||
    (ctx.lang === 'CN' ? '给我推荐几款护肤产品（按我的肤况与目标）' : 'Recommend a few skincare products for my profile and goals.');

  const query =
    `${prefix}` +
    `Task: Generate skincare recommendations.\n` +
    `Return ONLY a JSON object with keys: recommendations (array), evidence (object), confidence (0..1), missing_info (string[]).\n` +
    `Each recommendation item should include: slot ("am"|"pm"|"other"), step, sku {brand,name,display_name,sku_id,product_id,category}, notes (string[]), evidence_pack.\n` +
    `Rules:\n` +
    `- Do NOT include checkout links.\n` +
    `- If unsure, use null/unknown and list missing_info (do not fabricate).\n` +
    `User request: ${userAsk}`;

  let upstream = null;
  try {
    upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 22000 });
  } catch (err) {
    if (err && err.code !== 'AURORA_NOT_CONFIGURED') {
      logger?.warn({ err: err.message }, 'aurora bff: product reco upstream failed');
    }
  }

  const structured = getUpstreamStructuredOrJson(upstream);
  const mapped = structured && typeof structured === 'object' && !Array.isArray(structured) ? { ...structured } : null;
  if (mapped && Array.isArray(mapped.recommendations)) {
    mapped.recommendations = mapped.recommendations.map((r) => coerceRecoItemForUi(r, { lang: ctx.lang }));
  }

  const norm = normalizeRecoGenerate(mapped);

  if (includeAlternatives) {
    const alt = await enrichRecommendationsWithAlternatives({
      ctx,
      profileSummary,
      recentLogs,
      recommendations: norm.payload.recommendations,
      logger,
    });
    norm.payload = { ...norm.payload, recommendations: alt.recommendations };
    norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
  }

  return norm;
}

function mountAuroraBffRoutes(app, { logger }) {
  app.post('/v1/product/parse', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ProductParseRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const input = parsed.data.url || parsed.data.text;
      const query = `Task: Parse the user's product input into a normalized product entity.\n` +
        `Return ONLY a JSON object with keys: product (object), confidence (0..1), missing_info (string[]).\n` +
        `Input: ${input}`;

      let upstream = null;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 12000 });
      } catch (err) {
        // ignore; fall back below
      }

      const structured = getUpstreamStructuredOrJson(upstream);
      const mapped = structured && structured.parse && typeof structured.parse === 'object'
        ? mapAuroraProductParse(structured)
        : structured;
      const norm = normalizeProductParse(mapped);
      const payload = norm.payload;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `parse_${ctx.request_id}`,
            type: 'product_parse',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'product_parse' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to parse product.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_PARSE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_PARSE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/product/analyze', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = ProductAnalyzeRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const profile = await getUserProfile(ctx.aurora_uid).catch(() => null);
      const recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const prefix = buildContextPrefix({ profile: profileSummary, recentLogs });

      const input = parsed.data.url || parsed.data.name || JSON.stringify(parsed.data.product || {});
      const query = `${prefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
        `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
        `Evidence must include science/social_signals/expert_notes.\n` +
        `Product: ${input}`;

      let upstream = null;
      try {
        const anchorId = parsed.data.product && (parsed.data.product.sku_id || parsed.data.product.product_id);
        upstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query,
          timeoutMs: 16000,
          ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
          ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
        });
      } catch (err) {
        // ignore; fall back
      }

      const structured = getUpstreamStructuredOrJson(upstream);
      const mapped = structured && structured.analyze && typeof structured.analyze === 'object'
        ? mapAuroraProductAnalysis(structured)
        : structured;
      const norm = normalizeProductAnalysis(mapped);
      const payload = enrichProductAnalysisPayload(norm.payload, { lang: ctx.lang });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `analyze_${ctx.request_id}`,
            type: 'product_analysis',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'product_analyze' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to analyze product.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PRODUCT_ANALYZE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PRODUCT_ANALYZE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/dupe/compare', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = DupeCompareRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const profile = await getUserProfile(ctx.aurora_uid).catch(() => null);
      const recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const prefix = buildContextPrefix({ profile: profileSummary, recentLogs });

      const originalInput = buildProductInputText(parsed.data.original, parsed.data.original_url);
      const dupeInput = buildProductInputText(parsed.data.dupe, parsed.data.dupe_url);

      if (!originalInput || !dupeInput) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: 'original and dupe are required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const productQuery = (input) => (
        `${prefix}Task: Parse the user's product input into a normalized product entity.\n` +
        `Input: ${input}`
      );

      let originalUpstream = null;
      let dupeUpstream = null;
      try {
        const originalAnchor = parsed.data.original && (parsed.data.original.sku_id || parsed.data.original.product_id);
        originalUpstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: productQuery(originalInput),
          timeoutMs: 16000,
          ...(originalAnchor ? { anchor_product_id: String(originalAnchor) } : {}),
          ...(parsed.data.original_url ? { anchor_product_url: parsed.data.original_url } : {}),
        });
      } catch (err) {
        // ignore
      }
      try {
        const dupeAnchor = parsed.data.dupe && (parsed.data.dupe.sku_id || parsed.data.dupe.product_id);
        dupeUpstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: productQuery(dupeInput),
          timeoutMs: 16000,
          ...(dupeAnchor ? { anchor_product_id: String(dupeAnchor) } : {}),
          ...(parsed.data.dupe_url ? { anchor_product_url: parsed.data.dupe_url } : {}),
        });
      } catch (err) {
        // ignore
      }

      const originalStructured = getUpstreamStructuredOrJson(originalUpstream);
      const dupeStructured = getUpstreamStructuredOrJson(dupeUpstream);
      const originalAnchorFromUpstream = originalStructured && originalStructured.parse && typeof originalStructured.parse === 'object'
        ? (originalStructured.parse.anchor_product || originalStructured.parse.anchorProduct)
        : null;
      const dupeAnchorFromUpstream = dupeStructured && dupeStructured.parse && typeof dupeStructured.parse === 'object'
        ? (dupeStructured.parse.anchor_product || dupeStructured.parse.anchorProduct)
        : null;

      const originalAnchor = originalAnchorFromUpstream || parsed.data.original || null;
      const dupeAnchor = dupeAnchorFromUpstream || parsed.data.dupe || null;

      const fallbackAnalyze = () => {
        if (!originalStructured || !dupeStructured) {
          return {
            original: originalAnchor || null,
            dupe: dupeAnchor || null,
            tradeoffs: [],
            evidence: null,
            confidence: null,
            missing_info: ['upstream_missing_or_unstructured'],
          };
        }
        const orig = mapAuroraProductAnalysis(originalStructured);
        const dup = mapAuroraProductAnalysis(dupeStructured);

        const origKeys = Array.isArray(orig.evidence?.science?.key_ingredients) ? orig.evidence.science.key_ingredients : [];
        const dupKeys = Array.isArray(dup.evidence?.science?.key_ingredients) ? dup.evidence.science.key_ingredients : [];
        const missing = origKeys.filter((k) => !dupKeys.includes(k));
        const added = dupKeys.filter((k) => !origKeys.includes(k));

        const tradeoffs = [];
        if (missing.length) tradeoffs.push(`Missing actives vs original: ${missing.join(', ')}`);
        if (added.length) tradeoffs.push(`Added actives: ${added.join(', ')}`);

        const confidence = typeof orig.confidence === 'number' && typeof dup.confidence === 'number'
          ? (orig.confidence + dup.confidence) / 2
          : (orig.confidence || dup.confidence || null);

        const evidence = {
          science: {
            key_ingredients: Array.from(new Set([...origKeys, ...dupKeys])),
            mechanisms: Array.from(new Set([...(orig.evidence?.science?.mechanisms || []), ...(dup.evidence?.science?.mechanisms || [])])),
            fit_notes: Array.from(new Set([...(orig.evidence?.science?.fit_notes || []), ...(dup.evidence?.science?.fit_notes || [])])),
            risk_notes: Array.from(new Set([...(orig.evidence?.science?.risk_notes || []), ...(dup.evidence?.science?.risk_notes || [])])),
          },
          social_signals: { typical_positive: [], typical_negative: [], risk_for_groups: [] },
          expert_notes: Array.from(new Set([...(orig.evidence?.expert_notes || []), ...(dup.evidence?.expert_notes || [])])),
          confidence,
          missing_info: ['dupe_not_in_alternatives_used_analyze_diff'],
        };

        return {
          original: originalAnchor || null,
          dupe: dupeAnchor || null,
          tradeoffs,
          evidence,
          confidence,
          missing_info: ['dupe_not_found_in_alternatives'],
        };
      };

      const mapped = originalStructured && originalStructured.alternatives
        ? mapAuroraAlternativesToDupeCompare(originalStructured, dupeAnchor, { fallbackAnalyze, originalAnchorFallback: originalAnchor })
        : fallbackAnalyze();

      const norm = normalizeDupeCompare(mapped);
      const payload = norm.payload;

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_${ctx.request_id}`,
            type: 'dupe_compare',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'dupe_compare' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to compare products.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'DUPE_COMPARE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'DUPE_COMPARE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/reco/generate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RecoGenerateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const profile = await getUserProfile(ctx.aurora_uid).catch(() => null);
      const recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);

      const gate = shouldDiagnosisGate({ message: 'recommend', triggerSource: 'action', profile });
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(prompt),
          suggested_chips: chips,
          cards: [
            {
              card_id: `diag_${ctx.request_id}`,
              type: 'diagnosis_gate',
              payload: { reason: gate.reason, missing_fields: gate.missing, wants: 'recommendation', profile: profileSummary, recent_logs: recentLogs },
            },
          ],
          session_patch: { next_state: 'S2_DIAGNOSIS' },
          events: [makeEvent({ ...ctx, trigger_source: 'action' }, 'state_entered', { next_state: 'S2_DIAGNOSIS', reason: gate.reason })],
        });
        return res.json(envelope);
      }

      const query = buildAuroraRoutineQuery({
        profile: { ...profileSummary, ...(profile && profile.currentRoutine ? { currentRoutine: profile.currentRoutine } : {}) },
        focus: parsed.data.focus,
        constraints: parsed.data.constraints || {},
        lang: ctx.lang,
      });

      let upstream = null;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 22000 });
      } catch (err) {
        // ignore
      }

      const routine = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context.routine : null;
      const mapped = mapAuroraRoutineToRecoGenerate(routine, upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null);
      const norm = normalizeRecoGenerate(mapped);
      if (parsed.data.include_alternatives) {
        const alt = await enrichRecommendationsWithAlternatives({
          ctx,
          profileSummary,
          recentLogs,
          recommendations: norm.payload.recommendations,
          logger,
        });
        norm.payload = { ...norm.payload, recommendations: alt.recommendations };
        norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
      }
      const payload = norm.payload;

      const suggestedChips = [];
      const nextActions = upstream && Array.isArray(upstream.next_actions) ? upstream.next_actions : [];
      if ((!payload.recommendations || payload.recommendations.length === 0) && nextActions.length) {
        for (const act of nextActions.slice(0, 8)) {
          if (!act || typeof act !== 'object') continue;
          const label = typeof act.label === 'string' ? act.label.trim() : typeof act.text === 'string' ? act.text.trim() : '';
          const text = typeof act.text === 'string' ? act.text.trim() : label;
          const id = typeof act.id === 'string' ? act.id.trim() : '';
          if (!label) continue;
          suggestedChips.push({
            chip_id: `chip.aurora.next_action.${id || label.replace(/\\s+/g, '_')}`.slice(0, 80),
            label,
            kind: 'quick_reply',
            data: { reply_text: text, aurora_action_id: id || null },
          });
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: suggestedChips,
        cards: [
          {
            card_id: `reco_${ctx.request_id}`,
            type: 'recommendations',
            payload,
            ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
          },
        ],
        session_patch: payload.recommendations && payload.recommendations.length ? { next_state: 'S7_PRODUCT_RECO' } : {},
        events: [makeEvent({ ...ctx, trigger_source: 'action' }, 'recos_requested', { explicit: true })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to generate recommendations.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'RECO_GENERATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'RECO_GENERATE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/photos/presign', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosPresignRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      if (USE_AURORA_BFF_MOCK) {
        // Stub: real storage/QC should be wired via pivota-backend photos endpoints.
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'mock_mode' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      if (!PIVOTA_BACKEND_BASE_URL) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!Object.keys(authHeaders).length) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: parsed.data.slot_id,
          upload: {
            method: 'PUT',
            url: null,
            headers: {},
            expires_in_seconds: 600,
          },
        };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `presign_${ctx.request_id}`,
              type: 'photo_presign',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
        });
        return res.json(envelope);
      }

      const contentType =
        typeof parsed.data.content_type === 'string' && parsed.data.content_type.trim()
          ? parsed.data.content_type.trim()
          : 'image/jpeg';
      const byteSize = typeof parsed.data.bytes === 'number' && Number.isFinite(parsed.data.bytes) ? parsed.data.bytes : null;

      const upstreamResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/presign`,
        {
          content_type: contentType,
          ...(byteSize ? { byte_size: byteSize } : {}),
          consent: true,
          user_id: ctx.aurora_uid,
        },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (upstreamResp.status !== 200 || !upstreamResp.data || !upstreamResp.data.upload_id || !upstreamResp.data.upload) {
        const detail = pickUpstreamErrorDetail(upstreamResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to presign upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: 'PHOTO_PRESIGN_UPSTREAM_FAILED',
                status: upstreamResp.status,
                detail: detail || null,
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: upstreamResp.status })],
        });
        return res.status(upstreamResp.status >= 400 ? upstreamResp.status : 502).json(envelope);
      }

      const uploadId = String(upstreamResp.data.upload_id);
      const upstreamUpload = upstreamResp.data.upload || {};
      const expiresInSeconds = secondsUntilIso(upstreamResp.data.expires_at) ?? 900;

      const payload = {
        photo_id: uploadId,
        slot_id: parsed.data.slot_id,
        upload: {
          method: upstreamUpload.method || 'PUT',
          url: upstreamUpload.url || null,
          headers: upstreamUpload.headers || {},
          expires_in_seconds: expiresInSeconds,
        },
        ...(typeof upstreamResp.data.max_bytes === 'number' ? { max_bytes: upstreamResp.data.max_bytes } : {}),
        ...(upstreamResp.data.tips ? { tips: upstreamResp.data.tips } : {}),
      };

      const fieldMissing = [];
      if (!payload.upload.url) fieldMissing.push({ field: 'upload.url', reason: 'upstream_missing_upload_url' });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `presign_${ctx.request_id}`,
            type: 'photo_presign',
            payload,
            ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_presign' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to presign upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PHOTO_PRESIGN_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PHOTO_PRESIGN_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  // Proxy upload to avoid browser-to-storage CORS issues.
  // Request: multipart/form-data with fields:
  // - slot_id (required)
  // - consent=true (required)
  // - file field: photo (required)
  app.post('/v1/photos/upload', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    let tmpDir = null;
    try {
      requireAuroraUid(ctx);

      if (USE_AURORA_BFF_MOCK) {
        const photoId = `photo_${ctx.request_id}_${Date.now()}`;
        const payload = {
          photo_id: photoId,
          slot_id: 'daylight',
          qc_status: 'passed',
          qc: { state: 'done', qc_status: 'passed', advice: { summary: 'Mock: photo looks good.', suggestions: [] } },
        };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'upload.url', reason: 'mock_mode' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_upload', qc_status: 'passed' })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!PIVOTA_BACKEND_BASE_URL) {
        const payload = { photo_id: null, slot_id: null, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Photo upload is not configured.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'photo_id', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_NOT_CONFIGURED' })],
        });
        return res.status(501).json(envelope);
      }
      if (!Object.keys(authHeaders).length) {
        const payload = { photo_id: null, slot_id: null, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Photo upload auth is not configured.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'photo_id', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_AUTH_NOT_CONFIGURED' })],
        });
        return res.status(501).json(envelope);
      }

      const reqContentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!reqContentType.includes('multipart/form-data') || !reqContentType.includes('boundary=')) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', detail: 'multipart_required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const { fields, files, tmpDir: parsedTmpDir } = await parseMultipart(req, {
        maxBytes: PHOTO_UPLOAD_PROXY_MAX_BYTES,
        allowedContentTypes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']),
        requiredFields: ['slot_id', 'consent'],
      });
      tmpDir = parsedTmpDir;

      const slotId = String(fields.slot_id || '').trim();
      if (!slotId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Missing slot_id.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', detail: 'slot_id_required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const consentRaw = String(fields.consent || '').trim().toLowerCase();
      const consent = consentRaw === 'true' || consentRaw === '1' || consentRaw === 'yes';
      if (!consent) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('User consent is required.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'USER_CONSENT_REQUIRED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'USER_CONSENT_REQUIRED' })],
        });
        return res.status(400).json(envelope);
      }

      const fileEntry = files.photo || files.file || files.image || Object.values(files || {})[0];
      if (!fileEntry || !fileEntry.path) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Missing photo file.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', detail: 'photo_file_required' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const stat = fs.statSync(fileEntry.path);
      const byteSize = Number.isFinite(stat.size) ? stat.size : null;
      const contentType = fileEntry.contentType || 'image/jpeg';

      const presignResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/presign`,
        {
          content_type: contentType,
          ...(byteSize ? { byte_size: byteSize } : {}),
          consent: true,
          user_id: ctx.aurora_uid,
        },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (presignResp.status !== 200 || !presignResp.data || !presignResp.data.upload_id || !presignResp.data.upload) {
        const detail = pickUpstreamErrorDetail(presignResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to start photo upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: presignResp.status, detail: detail || null },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_PRESIGN_UPSTREAM_FAILED', status: presignResp.status })],
        });
        return res.status(presignResp.status >= 400 ? presignResp.status : 502).json(envelope);
      }

      const uploadId = String(presignResp.data.upload_id);
      const upstreamUpload = presignResp.data.upload || {};
      const uploadUrl = typeof upstreamUpload.url === 'string' ? upstreamUpload.url.trim() : '';
      const uploadMethod = typeof upstreamUpload.method === 'string' && upstreamUpload.method.trim()
        ? upstreamUpload.method.trim().toUpperCase()
        : 'PUT';
      const uploadHeaders = upstreamUpload.headers && typeof upstreamUpload.headers === 'object' ? upstreamUpload.headers : {};

      if (!uploadUrl) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Upload URL is missing from upstream.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UPSTREAM_MISSING_UPLOAD_URL' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UPSTREAM_MISSING_UPLOAD_URL' })],
        });
        return res.status(502).json(envelope);
      }

      const hasHeader = (headersObj, key) => {
        const wanted = String(key || '').toLowerCase();
        for (const k of Object.keys(headersObj || {})) {
          if (String(k).toLowerCase() === wanted) return true;
        }
        return false;
      };

      const finalUploadHeaders = { ...uploadHeaders };
      // Some S3-compatible providers require a Content-Length (otherwise 411 Length Required).
      if (byteSize && !hasHeader(finalUploadHeaders, 'content-length')) {
        finalUploadHeaders['Content-Length'] = String(byteSize);
      }
      // Ensure Content-Type is present if upstream didn't include it.
      if (contentType && !hasHeader(finalUploadHeaders, 'content-type')) {
        finalUploadHeaders['Content-Type'] = contentType;
      }

      const uploadResp = await axios.request({
        method: uploadMethod,
        url: uploadUrl,
        headers: finalUploadHeaders,
        data: fs.createReadStream(fileEntry.path),
        timeout: 120000,
        maxBodyLength: 30 * 1024 * 1024,
        maxContentLength: 30 * 1024 * 1024,
        validateStatus: () => true,
      });

      if (uploadResp.status < 200 || uploadResp.status >= 300) {
        const detail =
          typeof uploadResp.data === 'string'
            ? uploadResp.data.slice(0, 4000)
            : uploadResp.data && typeof uploadResp.data === 'object'
              ? JSON.stringify(uploadResp.data).slice(0, 4000)
              : null;
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to upload photo bytes.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_UPLOAD_BYTES_FAILED', status: uploadResp.status, detail },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_UPLOAD_BYTES_FAILED', status: uploadResp.status })],
        });
        return res.status(502).json(envelope);
      }

      const confirmResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/confirm`,
        { upload_id: uploadId, ...(byteSize ? { byte_size: byteSize } : {}) },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (confirmResp.status !== 200 || !confirmResp.data) {
        const detail = pickUpstreamErrorDetail(confirmResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to confirm upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: { error: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status, detail: detail || null },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status })],
        });
        return res.status(confirmResp.status >= 400 ? confirmResp.status : 502).json(envelope);
      }

      let qcStatus =
        typeof confirmResp.data.qc_status === 'string' && confirmResp.data.qc_status ? confirmResp.data.qc_status : null;
      let qc = confirmResp.data.qc && typeof confirmResp.data.qc === 'object' ? confirmResp.data.qc : null;
      let nextPollMs = typeof confirmResp.data.next_poll_ms === 'number' ? confirmResp.data.next_poll_ms : null;

      const deadlineMs = Date.now() + 6000;
      let lastQcData = null;
      while (!qcStatus && Date.now() < deadlineMs) {
        const waitMs = Math.min(1200, Math.max(400, nextPollMs || 1000));
        await sleep(waitMs);

        const qcResp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}/photos/qc`, {
          timeout: 12000,
          validateStatus: () => true,
          headers: authHeaders,
          params: { upload_id: uploadId },
        });

        if (qcResp.status !== 200 || !qcResp.data) break;
        lastQcData = qcResp.data;
        qcStatus = typeof qcResp.data.qc_status === 'string' && qcResp.data.qc_status ? qcResp.data.qc_status : null;
        qc = qcResp.data.qc && typeof qcResp.data.qc === 'object' ? qcResp.data.qc : qc;
        nextPollMs = typeof qcResp.data.next_poll_ms === 'number' ? qcResp.data.next_poll_ms : nextPollMs;
      }

      const payload = {
        photo_id: uploadId,
        slot_id: slotId,
        qc_status: qcStatus,
        ...(qc ? { qc } : {}),
        ...(typeof nextPollMs === 'number' ? { next_poll_ms: nextPollMs } : {}),
        ...(lastQcData && lastQcData.qc_status == null ? { qc_pending: true } : {}),
      };

      const fieldMissing = [];
      if (!qcStatus) fieldMissing.push({ field: 'qc_status', reason: 'qc_pending' });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `confirm_${ctx.request_id}`,
            type: 'photo_confirm',
            payload,
            ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_upload', qc_status: qcStatus })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      const code = err?.code || 'PHOTO_UPLOAD_FAILED';
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to upload photo.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: code } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    } finally {
      if (tmpDir) rmrf(tmpDir);
    }
  });

  app.post('/v1/photos/confirm', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = PhotosConfirmRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      if (USE_AURORA_BFF_MOCK) {
        const qcStatus = 'passed';
        const payload = { ...parsed.data, qc_status: qcStatus };

        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [{ card_id: `confirm_${ctx.request_id}`, type: 'photo_confirm', payload }],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus })],
        });
        return res.json(envelope);
      }

      if (!PIVOTA_BACKEND_BASE_URL) {
        const payload = { ...parsed.data, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'qc_status', reason: 'pivota_backend_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: null })],
        });
        return res.json(envelope);
      }

      const authHeaders = buildPivotaBackendAuthHeaders(req);
      if (!Object.keys(authHeaders).length) {
        const payload = { ...parsed.data, qc_status: null };
        const envelope = buildEnvelope(ctx, {
          assistant_message: null,
          suggested_chips: [],
          cards: [
            {
              card_id: `confirm_${ctx.request_id}`,
              type: 'photo_confirm',
              payload,
              field_missing: [{ field: 'qc_status', reason: 'pivota_backend_auth_not_configured' }],
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: null })],
        });
        return res.json(envelope);
      }

      const uploadId = parsed.data.photo_id;
      const confirmResp = await axios.post(
        `${PIVOTA_BACKEND_BASE_URL}/photos/confirm`,
        { upload_id: uploadId },
        {
          timeout: 12000,
          validateStatus: () => true,
          headers: { 'Content-Type': 'application/json', ...authHeaders },
        },
      );

      if (confirmResp.status !== 200 || !confirmResp.data) {
        const detail = pickUpstreamErrorDetail(confirmResp.data);
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Failed to confirm upload.'),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: 'PHOTO_CONFIRM_UPSTREAM_FAILED',
                status: confirmResp.status,
                detail: detail || null,
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'PHOTO_CONFIRM_UPSTREAM_FAILED', status: confirmResp.status })],
        });
        return res.status(confirmResp.status >= 400 ? confirmResp.status : 502).json(envelope);
      }

      let qcStatus =
        typeof confirmResp.data.qc_status === 'string' && confirmResp.data.qc_status ? confirmResp.data.qc_status : null;
      let qc = confirmResp.data.qc && typeof confirmResp.data.qc === 'object' ? confirmResp.data.qc : null;
      let nextPollMs = typeof confirmResp.data.next_poll_ms === 'number' ? confirmResp.data.next_poll_ms : null;

      const deadlineMs = Date.now() + 6000;
      let lastQcData = null;
      while (!qcStatus && Date.now() < deadlineMs) {
        const waitMs = Math.min(1200, Math.max(400, nextPollMs || 1000));
        await sleep(waitMs);

        const qcResp = await axios.get(`${PIVOTA_BACKEND_BASE_URL}/photos/qc`, {
          timeout: 12000,
          validateStatus: () => true,
          headers: authHeaders,
          params: { upload_id: uploadId },
        });

        if (qcResp.status !== 200 || !qcResp.data) break;

        lastQcData = qcResp.data;
        qcStatus = typeof qcResp.data.qc_status === 'string' && qcResp.data.qc_status ? qcResp.data.qc_status : null;
        qc = qcResp.data.qc && typeof qcResp.data.qc === 'object' ? qcResp.data.qc : qc;
        nextPollMs = typeof qcResp.data.next_poll_ms === 'number' ? qcResp.data.next_poll_ms : nextPollMs;
      }

      const payload = {
        ...parsed.data,
        qc_status: qcStatus,
        ...(qc ? { qc } : {}),
        ...(typeof nextPollMs === 'number' ? { next_poll_ms: nextPollMs } : {}),
        ...(lastQcData && lastQcData.qc_status == null ? { qc_pending: true } : {}),
      };

      const fieldMissing = [];
      if (!qcStatus) fieldMissing.push({ field: 'qc_status', reason: 'qc_pending' });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `confirm_${ctx.request_id}`,
            type: 'photo_confirm',
            payload,
            ...(fieldMissing.length ? { field_missing: fieldMissing } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'photo_confirm', qc_status: qcStatus })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to confirm upload.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'PHOTO_CONFIRM_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PHOTO_CONFIRM_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/analysis/skin', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = SkinAnalysisRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      let profile = null;
      let recentLogs = [];
      try {
        profile = await getUserProfile(ctx.aurora_uid);
        recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7);
      } catch (err) {
        logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to load memory context');
      }

      const photos = Array.isArray(parsed.data.photos) ? parsed.data.photos : [];
      const photoQcParts = [];
      const passedPhotos = [];
      let passedCount = 0;
      for (const p of photos) {
        const slot = String(p.slot_id || '').trim();
        const qc = String(p.qc_status || '').trim().toLowerCase();
        const photoId = typeof p.photo_id === 'string' ? p.photo_id.trim() : '';
        if (slot && qc) photoQcParts.push(`${slot}:${qc}`);
        if (qc === 'passed') {
          passedCount += 1;
          if (slot && photoId) passedPhotos.push({ slot_id: slot, photo_id: photoId, qc_status: qc });
        }
      }
      const photosProvided = passedCount > 0;

      const profileSummary = summarizeProfileForContext(profile);
      const recentLogsSummary = Array.isArray(recentLogs) ? recentLogs.slice(0, 7) : [];

      const usePhoto = parsed.data.use_photo === true;
      const analysisFieldMissing = [];
      let usedPhotos = false;
      let analysisSource = 'rule_based';

      let analysis = null;
      if (usePhoto) {
        const chosen = chooseVisionPhoto(passedPhotos);
        if (!chosen) {
          analysisFieldMissing.push({ field: 'photos', reason: 'no_passed_photo' });
        } else {
          let photoBytes = null;
          try {
            const resp = await fetchPhotoBytesFromPivotaBackend({ req, photoId: chosen.photo_id });
            if (resp && resp.ok) photoBytes = resp.buffer;
            else {
              analysisFieldMissing.push({
                field: 'analysis.used_photos',
                reason: resp && resp.reason ? resp.reason : 'photo_fetch_failed',
              });
            }
          } catch (err) {
            analysisFieldMissing.push({
              field: 'analysis.used_photos',
              reason: 'photo_fetch_failed',
            });
            logger?.warn({ err: err.message }, 'aurora bff: failed to fetch photo bytes');
          }

          if (photoBytes) {
            const vision = await runOpenAIVisionSkinAnalysis({
              imageBuffer: photoBytes,
              language: ctx.lang,
              profileSummary,
              recentLogsSummary,
            });
            if (vision && vision.ok && vision.analysis) {
              analysis = vision.analysis;
              usedPhotos = true;
              analysisSource = 'vision_openai';
            } else if (vision && !vision.ok) {
              analysisFieldMissing.push({
                field: 'analysis.used_photos',
                reason: vision.reason || 'vision_failed',
              });
              if (vision.error) logger?.warn({ err: vision.error }, 'aurora bff: vision skin analysis failed');
            }
          }
        }
      }

      if (!analysis && AURORA_DECISION_BASE_URL && !USE_AURORA_BFF_MOCK) {
        const replyLanguage = ctx.lang === 'CN' ? 'Simplified Chinese' : 'English';
        const replyInstruction = ctx.lang === 'CN'
          ? '请只用简体中文回答，不要使用英文。'
          : 'IMPORTANT: Reply ONLY in English. Do not use Chinese.';

        const profileLine = `profile=${JSON.stringify(profileSummary || {})}`;
        const logsLine = recentLogsSummary.length ? `recent_logs=${JSON.stringify(recentLogsSummary)}` : '';
        const photoLine = `photos_provided=${photosProvided ? 'yes' : 'no'}; photo_qc=${photoQcParts.length ? photoQcParts.join(', ') : 'none'}; photos_accessible=no.`;

        const prompt =
          `${profileLine}\n` +
          `${logsLine ? `${logsLine}\n` : ''}` +
          `${photoLine}\n` +
          `Task: Provide a skin assessment that is honest about uncertainty and feels like a cautious dermatologist.\n\n` +
          `Return ONLY a valid JSON object (no markdown) with this exact shape:\n` +
          `{\n` +
          `  "features": [\n` +
          `    {"observation": "…", "confidence": "pretty_sure" | "somewhat_sure" | "not_sure"}\n` +
          `  ],\n` +
          `  "strategy": "…",\n` +
          `  "needs_risk_check": true | false\n` +
          `}\n\n` +
          `Rules:\n` +
          `- DO NOT output any numeric scores/percentages.\n` +
          `- DO NOT claim you can see the user's skin in the photo. Photos are for quality checks only.\n` +
          `- Observations must be about barrier, acne risk, pigmentation, irritation, hydration, and safety.\n` +
          `- Strategy must be actionable and stepwise and END with ONE direct clarifying question (must include a '?' or '？').\n` +
          `- DO NOT recommend specific products/brands.\n` +
          `- Keep it concise: 4–6 features; strategy under 900 characters.\n` +
          `Language: ${replyLanguage}.\n` +
          `${replyInstruction}\n`;

        let upstream = null;
        try {
          upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query: prompt, timeoutMs: 12000 });
        } catch (err) {
          logger?.warn({ err: err.message }, 'aurora bff: skin analysis upstream failed');
        }
        const answer = upstream && typeof upstream.answer === 'string' ? upstream.answer : '';
        const parsedObj = extractJsonObject(answer);
        analysis = normalizeSkinAnalysisFromLLM(parsedObj, { language: ctx.lang });
        if (analysis) analysisSource = 'aurora_text';
      }

      if (!analysis) analysis = buildRuleBasedSkinAnalysis({ profile: profileSummary || profile, recentLogs, language: ctx.lang });

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `analysis_${ctx.request_id}`,
            type: 'analysis_summary',
            payload: {
              analysis,
              photos_provided: photosProvided,
              photo_qc: photoQcParts,
              used_photos: usedPhotos,
              analysis_source: analysisSource,
            },
            ...(analysisFieldMissing.length ? { field_missing: analysisFieldMissing } : {}),
          },
        ],
        session_patch: { next_state: 'S5_ANALYSIS_SUMMARY' },
        events: [makeEvent(ctx, 'value_moment', { kind: 'skin_analysis', used_photos: usedPhotos, analysis_source: analysisSource })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to generate skin analysis.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'ANALYSIS_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'ANALYSIS_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/session/bootstrap', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      let profile = null;
      let recentLogs = [];
      let dbError = null;
      try {
        profile = await getUserProfile(ctx.aurora_uid);
        recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7);
      } catch (err) {
        dbError = err;
      }

      const isReturning = Boolean(profile) || recentLogs.length > 0;
      const checkinDue = isCheckinDue(recentLogs);

      const cards = [
        {
          card_id: `bootstrap_${ctx.request_id}`,
          type: 'session_bootstrap',
          payload: {
            profile: summarizeProfileForContext(profile),
            recent_logs: recentLogs,
            checkin_due: checkinDue,
            is_returning: isReturning,
            db_ready: !dbError,
          },
          ...(dbError
            ? { field_missing: [{ field: 'profile', reason: 'db_not_configured_or_unavailable' }] }
            : {}),
        },
      ];

      const events = [makeEvent(ctx, 'state_entered', { state: ctx.state || 'unknown', trigger_source: ctx.trigger_source })];
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards,
        session_patch: {
          profile: summarizeProfileForContext(profile),
          recent_logs: recentLogs,
          checkin_due: checkinDue,
          is_returning: isReturning,
        },
        events,
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.warn({ err: err.message, status }, 'session bootstrap failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to bootstrap session.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'BOOTSTRAP_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'BOOTSTRAP_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/profile/update', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = UserProfilePatchSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const updated = await upsertUserProfile(ctx.aurora_uid, parsed.data);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          { card_id: `profile_${ctx.request_id}`, type: 'profile', payload: { profile: summarizeProfileForContext(updated) } },
        ],
        session_patch: { profile: summarizeProfileForContext(updated) },
        events: [makeEvent(ctx, 'profile_saved', { fields: Object.keys(parsed.data) })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.code === 'NO_DATABASE' ? 503 : 500;
      logger?.warn({ err: err.message, status }, 'profile update failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to save profile.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: err.code === 'NO_DATABASE' ? 'DB_NOT_CONFIGURED' : 'PROFILE_SAVE_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'PROFILE_SAVE_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/tracker/log', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = TrackerLogSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const saved = await upsertSkinLog(ctx.aurora_uid, parsed.data);
      const recent = await getRecentSkinLogs(ctx.aurora_uid, 7);

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          { card_id: `tracker_${ctx.request_id}`, type: 'tracker_log', payload: { log: saved, recent_logs: recent } },
        ],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_logged', { date: saved?.date || null })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.code === 'NO_DATABASE' ? 503 : 500;
      logger?.warn({ err: err.message, status }, 'tracker log failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to save tracker log.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: { error: err.code === 'NO_DATABASE' ? 'DB_NOT_CONFIGURED' : 'TRACKER_LOG_FAILED' },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'TRACKER_LOG_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/tracker/recent', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const days = req.query.days ? Number(req.query.days) : 7;
      const recent = await getRecentSkinLogs(ctx.aurora_uid, days);
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `recent_${ctx.request_id}`, type: 'tracker_recent', payload: { days, logs: recent } }],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_loaded', { days })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.code === 'NO_DATABASE' ? 503 : 500;
      logger?.warn({ err: err.message, status }, 'tracker recent failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to load tracker logs.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'TRACKER_LOAD_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'TRACKER_LOAD_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/routine/simulate', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = RoutineSimulateRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const routine = parsed.data.routine || {};
      const testProduct = parsed.data.test_product || null;
      const sim = simulateConflicts({ routine, testProduct });
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `sim_${ctx.request_id}`,
            type: 'routine_simulation',
            payload: { safe: sim.safe, conflicts: sim.conflicts, summary: sim.summary },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'simulate_conflict', { safe: sim.safe, conflicts: sim.conflicts.length })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'routine simulate failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to simulate routine.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'SIMULATE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'SIMULATE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/offers/resolve', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = OffersResolveRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const market = String(parsed.data.market || 'US').trim() || 'US';
      const items = parsed.data.items;

      const resolved = [];
      const fieldMissing = [];

      for (const item of items) {
        const product = item.product;
        const offer = item.offer;
        const url = offer && (offer.affiliate_url || offer.affiliateUrl || offer.url);

        if (USE_AURORA_BFF_MOCK) {
          resolved.push({
            product: { ...product, image_url: product.image_url || 'https://img.example.com/mock.jpg' },
            offer: { ...offer, price: typeof offer.price === 'number' && offer.price > 0 ? offer.price : 12.34, currency: offer.currency || 'USD' },
          });
          continue;
        }

        if (!url) {
          resolved.push(item);
          fieldMissing.push({ field: 'offer.affiliate_url', reason: 'missing_affiliate_url' });
          continue;
        }
        if (!PIVOTA_BACKEND_BASE_URL) {
          resolved.push(item);
          fieldMissing.push({ field: 'offer.snapshot', reason: 'pivota_backend_not_configured' });
          continue;
        }

        try {
          const resp = await axios.post(
            `${PIVOTA_BACKEND_BASE_URL}/api/offers/external/resolve`,
            { market, url, forceRefresh: false },
            { timeout: 12000, validateStatus: () => true },
          );
          if (resp.status !== 200 || !resp.data || !resp.data.ok || !resp.data.offer) {
            resolved.push(item);
            fieldMissing.push({ field: 'offer.snapshot', reason: 'external_offer_resolve_failed' });
            continue;
          }
          const snap = resp.data.offer;
          const patchedProduct = { ...product };
          const patchedOffer = { ...offer };

          if (snap.imageUrl) patchedProduct.image_url = snap.imageUrl;
          if (snap.title && !patchedProduct.name) patchedProduct.name = snap.title;
          if (snap.brand && !patchedProduct.brand) patchedProduct.brand = snap.brand;
          if (snap.price && typeof snap.price === 'object') {
            if (typeof snap.price.amount === 'number') patchedOffer.price = snap.price.amount;
            if (typeof snap.price.currency === 'string') patchedOffer.currency = snap.price.currency;
          }
          if (snap.canonicalUrl) patchedOffer.affiliate_url = snap.canonicalUrl;

          resolved.push({ product: patchedProduct, offer: patchedOffer });
        } catch (err) {
          resolved.push(item);
          fieldMissing.push({ field: 'offer.snapshot', reason: 'external_offer_resolve_timeout_or_network' });
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `offers_${ctx.request_id}`,
            type: 'offers_resolved',
            payload: { items: resolved, market },
            ...(fieldMissing.length ? { field_missing: fieldMissing.slice(0, 8) } : {}),
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'offers_resolved', { count: resolved.length, market })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'offers resolve failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to resolve offers.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OFFERS_RESOLVE_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OFFERS_RESOLVE_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/affiliate/outcome', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AffiliateOutcomeRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `out_${ctx.request_id}`, type: 'affiliate_outcome', payload: parsed.data }],
        session_patch: {},
        events: [makeEvent(ctx, 'outbound_opened', { outcome: parsed.data.outcome, url: parsed.data.url || null })],
      });
      return res.json(envelope);
    } catch (err) {
      logger?.warn({ err: err.message }, 'affiliate outcome failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to record outcome.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'OUTCOME_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: 'OUTCOME_FAILED' })],
      });
      return res.status(500).json(envelope);
    }
  });

  app.post('/v1/chat', async (req, res) => {
    const parsed = V1ChatRequestSchema.safeParse(req.body || {});
    const ctx = buildRequestContext(req, parsed.success ? parsed.data : req.body || {});

    try {
      requireAuroraUid(ctx);
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      // Best-effort context injection.
      let profile = null;
      let recentLogs = [];
      try {
        profile = await getUserProfile(ctx.aurora_uid);
        recentLogs = await getRecentSkinLogs(ctx.aurora_uid, 7);
      } catch (err) {
        logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to load memory context');
      }

      // Allow chips/actions to patch profile inline (so chat can progress without an extra API call).
      const profilePatchFromAction = parseProfilePatchFromAction(parsed.data.action);
      let appliedProfilePatch = null;
      if (profilePatchFromAction) {
        const patchParsed = UserProfilePatchSchema.safeParse(profilePatchFromAction);
        if (patchParsed.success) {
          appliedProfilePatch = patchParsed.data;
          // Always apply inline for gating even if DB is unavailable.
          profile = { ...(profile || {}), ...patchParsed.data };
          try {
            profile = await upsertUserProfile(ctx.aurora_uid, patchParsed.data);
          } catch (err) {
            logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to apply profile chip patch');
          }
        }
      }

      const actionReplyText = extractReplyTextFromAction(parsed.data.action);
      const message = String(parsed.data.message || '').trim() || actionReplyText || '';
      const actionId =
        parsed.data.action && typeof parsed.data.action === 'object'
          ? parsed.data.action.action_id
          : typeof parsed.data.action === 'string'
            ? parsed.data.action
            : null;
      const includeAlternatives = extractIncludeAlternativesFromAction(parsed.data.action);

      // Explicit "Start diagnosis" should always enter the diagnosis flow (even if a profile already exists),
      // otherwise users can get stuck in an upstream "what next?" loop.
      if (actionId === 'chip.start.diagnosis' || looksLikeDiagnosisStart(message)) {
        const { score, missing } = profileCompleteness(profile);
        const required = score >= 4 ? ['skinType', 'sensitivity', 'barrierStatus', 'goals'] : missing;
        const prompt = buildDiagnosisPrompt(ctx.lang, required);
        const chips = buildDiagnosisChips(ctx.lang, required);
        const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(prompt),
          suggested_chips: chips,
          cards: [
            {
              card_id: `diag_${ctx.request_id}`,
              type: 'diagnosis_gate',
              payload: {
                reason: 'diagnosis_start',
                missing_fields: required,
                wants: 'diagnosis',
                profile: summarizeProfileForContext(profile),
                recent_logs: recentLogs,
              },
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events: [makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: 'diagnosis_start' })],
        });
        return res.json(envelope);
      }

      // Phase 0 gate: Diagnosis-first (no recos/offers before minimal profile).
      const gate = shouldDiagnosisGate({ message, triggerSource: ctx.trigger_source, profile });
      if (gate.gated) {
        const prompt = buildDiagnosisPrompt(ctx.lang, gate.missing);
        const chips = buildDiagnosisChips(ctx.lang, gate.missing);
        const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

        const events = [
          makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: gate.reason }),
        ];

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(prompt),
          suggested_chips: chips,
          cards: [
            {
              card_id: `diag_${ctx.request_id}`,
              type: 'diagnosis_gate',
              payload: {
                reason: gate.reason,
                missing_fields: gate.missing,
                wants: gate.wants,
                profile: summarizeProfileForContext(profile),
                recent_logs: recentLogs,
              },
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events,
        });
        return res.json(envelope);
      }

      // Budget gate + routing: when waiting for budget selection, proceed to routine generation.
      if (ctx.state === 'S6_BUDGET') {
        const rawBudget =
          normalizeBudgetHint(appliedProfilePatch && appliedProfilePatch.budgetTier) ||
          normalizeBudgetHint(profile && profile.budgetTier) ||
          normalizeBudgetHint(message);

        if (!rawBudget) {
          const envelope = buildEnvelope(ctx, {
            assistant_message: makeAssistantMessage(buildBudgetGatePrompt(ctx.lang)),
            suggested_chips: buildBudgetGateChips(ctx.lang),
            cards: [
              {
                card_id: `budget_${ctx.request_id}`,
                type: 'budget_gate',
                payload: { reason: 'budget_required_for_routine', profile: summarizeProfileForContext(profile) },
              },
            ],
            session_patch: stateChangeAllowed(ctx.trigger_source) ? { next_state: 'S6_BUDGET' } : {},
            events: [makeEvent(ctx, 'state_entered', { next_state: 'S6_BUDGET', reason: 'budget_required_for_routine' })],
          });
          return res.json(envelope);
        }

        if (!profile || profile.budgetTier !== rawBudget) {
          profile = { ...(profile || {}), budgetTier: rawBudget };
          try {
            profile = await upsertUserProfile(ctx.aurora_uid, { budgetTier: rawBudget });
          } catch (err) {
            logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to persist budgetTier');
          }
        }

        const { norm, suggestedChips } = await generateRoutineReco({
          ctx,
          profile,
          recentLogs,
          focus: 'daily routine',
          constraints: { simplicity: 'high' },
          includeAlternatives,
          logger,
        });

        const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
        const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            ctx.lang === 'CN'
              ? '已收到预算信息。我生成了一个简洁 AM/PM routine（见下方卡片）。'
              : 'Got it. I generated a simple AM/PM routine (see the card below).',
          ),
          suggested_chips: suggestedChips,
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload: norm.payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'routine_generated' }),
            makeEvent(ctx, 'recos_requested', { explicit: true }),
          ],
        });
        return res.json(envelope);
      }

      // If user explicitly asks to build an AM/PM routine, route to the routine generator (budget-gated).
      if (
        looksLikeRoutineRequest(message, parsed.data.action) &&
        recommendationsAllowed({ triggerSource: ctx.trigger_source, actionId, message })
      ) {
        const budget = normalizeBudgetHint(profile && profile.budgetTier);
        if (!budget) {
          const envelope = buildEnvelope(ctx, {
            assistant_message: makeAssistantMessage(buildBudgetGatePrompt(ctx.lang)),
            suggested_chips: buildBudgetGateChips(ctx.lang),
            cards: [
              {
                card_id: `budget_${ctx.request_id}`,
                type: 'budget_gate',
                payload: { reason: 'budget_required_for_routine', profile: summarizeProfileForContext(profile) },
              },
            ],
            session_patch: stateChangeAllowed(ctx.trigger_source) ? { next_state: 'S6_BUDGET' } : {},
            events: [makeEvent(ctx, 'state_entered', { next_state: 'S6_BUDGET', reason: 'budget_required_for_routine' })],
          });
          return res.json(envelope);
        }

        const { norm, suggestedChips } = await generateRoutineReco({
          ctx,
          profile,
          recentLogs,
          focus: 'daily routine',
          constraints: { simplicity: 'high' },
          includeAlternatives,
          logger,
        });

        const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
        const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            ctx.lang === 'CN'
              ? '我生成了一个简洁 AM/PM routine（见下方卡片）。'
              : 'I generated a simple AM/PM routine (see the card below).',
          ),
          suggested_chips: suggestedChips,
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload: norm.payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'routine_generated' }),
            makeEvent(ctx, 'recos_requested', { explicit: true }),
          ],
        });
        return res.json(envelope);
      }

      // If user explicitly asks for a few product recommendations, generate them deterministically
      // (some upstream chat flows only return clarifying chips without a recommendations card).
      if (actionId === 'chip.start.reco_products' && recommendationsAllowed({ triggerSource: ctx.trigger_source, actionId, message })) {
        const norm = await generateProductRecommendations({
          ctx,
          profile,
          recentLogs,
          message,
          includeAlternatives,
          logger,
        });

        const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
        const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            ctx.lang === 'CN'
              ? '我给你整理了几款可以直接开始的产品（见下方卡片）。'
              : 'I pulled a few products you can start with (see the card below).',
          ),
          suggested_chips: [],
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload: norm.payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
          ],
          session_patch: nextState ? { next_state: nextState } : {},
          events: [
            makeEvent(ctx, 'value_moment', { kind: 'product_reco' }),
            makeEvent(ctx, 'recos_requested', { explicit: true }),
          ],
        });
        return res.json(envelope);
      }

      // If user just patched profile via chip/action, continue the diagnosis flow without calling upstream.
      if (appliedProfilePatch && !message) {
        const { score, missing } = profileCompleteness(profile);
        if (score < 3) {
          const prompt = buildDiagnosisPrompt(ctx.lang, missing);
          const chips = buildDiagnosisChips(ctx.lang, missing);
          const nextState = stateChangeAllowed(ctx.trigger_source) ? 'S2_DIAGNOSIS' : undefined;

          const envelope = buildEnvelope(ctx, {
            assistant_message: makeAssistantMessage(prompt),
            suggested_chips: chips,
            cards: [
              {
                card_id: `diag_${ctx.request_id}`,
                type: 'diagnosis_gate',
                payload: {
                  reason: 'diagnosis_progress',
                  missing_fields: missing,
                  wants: 'recommendation',
                  profile: summarizeProfileForContext(profile),
                  recent_logs: recentLogs,
                },
              },
            ],
            session_patch: nextState ? { next_state: nextState } : {},
            events: [
              makeEvent(ctx, 'profile_saved', { fields: Object.keys(appliedProfilePatch) }),
              makeEvent(ctx, 'state_entered', { next_state: nextState || null, reason: 'diagnosis_progress' }),
            ],
          });
          return res.json(envelope);
        }

        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const suggestedChips = [
          {
            chip_id: 'chip.action.reco_routine',
            label: lang === 'CN' ? '生成早晚护肤 routine' : 'Build an AM/PM routine',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '生成一套早晚护肤 routine' : 'Build an AM/PM skincare routine' },
          },
          {
            chip_id: 'chip.action.analyze_product',
            label: lang === 'CN' ? '评估某个产品适合吗' : 'Evaluate a specific product',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '评估这款产品是否适合我' : 'Evaluate a specific product for me' },
          },
          {
            chip_id: 'chip.action.dupe_compare',
            label: lang === 'CN' ? '找平替/对比替代品' : 'Find dupes / alternatives',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '帮我找平替并比较 tradeoffs' : 'Find dupes and compare tradeoffs' },
          },
        ];

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            lang === 'CN'
              ? '已记录你的肤况。接下来你想做什么？'
              : 'Got it. What would you like to do next?',
          ),
          suggested_chips: suggestedChips,
          cards: [
            {
              card_id: `profile_${ctx.request_id}`,
              type: 'profile',
              payload: { profile: summarizeProfileForContext(profile) },
            },
          ],
          session_patch: stateChangeAllowed(ctx.trigger_source) ? { next_state: 'S3_PHOTO_OPTION' } : {},
          events: [makeEvent(ctx, 'profile_saved', { fields: Object.keys(appliedProfilePatch) })],
        });
        return res.json(envelope);
      }

      // Upstream Aurora decision system (best-effort).
      let upstream = null;
      const profileSummary = summarizeProfileForContext(profile);
      const prefix = buildContextPrefix({
        profile: profileSummary,
        recentLogs,
        lang: ctx.lang,
        state: ctx.state,
        trigger_source: ctx.trigger_source,
        action_id: parsed.data.action && typeof parsed.data.action === 'object' ? parsed.data.action.action_id : null,
        clarification_id:
          parsed.data.action &&
          typeof parsed.data.action === 'object' &&
          parsed.data.action.data &&
          typeof parsed.data.action.data === 'object'
            ? parsed.data.action.data.clarification_id || parsed.data.action.data.clarificationId || null
            : null,
      });
      const query = `${prefix}${message || '(no message)'}`;
      try {
        upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 12000 });
      } catch (err) {
        if (err.code !== 'AURORA_NOT_CONFIGURED') {
          logger?.warn({ err: err.message }, 'aurora bff: aurora upstream failed');
        }
      }

      const answer = upstream && typeof upstream.answer === 'string'
        ? upstream.answer
        : ctx.lang === 'CN'
          ? '（我已收到。Aurora 上游暂不可用或未配置，当前仅能提供门控与记忆能力。）'
          : '(Received. Aurora upstream is unavailable or not configured; returning a gated/memory-aware fallback response.)';

      const rawCards = upstream && Array.isArray(upstream.cards) ? upstream.cards : [];
      const allowRecs = recommendationsAllowed({ triggerSource: ctx.trigger_source, actionId, message });
      let cards = allowRecs ? rawCards : stripRecommendationCards(rawCards);
      const fieldMissing = [];
      if (!allowRecs && rawCards.length !== cards.length) {
        fieldMissing.push({ field: 'cards', reason: 'recommendations_not_requested' });
      }

      if (allowRecs && includeAlternatives && Array.isArray(cards) && cards.length) {
        const recoIdx = cards.findIndex((c) => {
          if (!c || typeof c !== 'object') return false;
          const t = typeof c.type === 'string' ? c.type.trim().toLowerCase() : '';
          if (t !== 'recommendations') return false;
          const payload = c.payload && typeof c.payload === 'object' ? c.payload : null;
          return payload && Array.isArray(payload.recommendations);
        });

        if (recoIdx !== -1) {
          const card = cards[recoIdx];
          const basePayload = card.payload && typeof card.payload === 'object' ? card.payload : {};
          const alt = await enrichRecommendationsWithAlternatives({
            ctx,
            profileSummary,
            recentLogs,
            recommendations: basePayload.recommendations,
            logger,
          });
          const nextCard = {
            ...card,
            payload: { ...basePayload, recommendations: alt.recommendations },
            field_missing: mergeFieldMissing(card.field_missing, alt.field_missing),
          };
          cards = cards.map((c, i) => (i === recoIdx ? nextCard : c));
        }
      }

      const clarification = upstream && upstream.clarification && typeof upstream.clarification === 'object'
        ? upstream.clarification
        : null;

      const suggestedChips = [];
      if (clarification && Array.isArray(clarification.questions) && clarification.questions[0]) {
        const q0 = clarification.questions[0];
        const qid = q0 && typeof q0.id === 'string' ? q0.id : 'clarify';
        const options = q0 && Array.isArray(q0.options) ? q0.options : [];
        for (const opt of options.slice(0, 8)) {
          if (typeof opt !== 'string' || !opt.trim()) continue;
          suggestedChips.push({
            chip_id: `chip.clarify.${qid}.${opt.trim().slice(0, 40).replace(/\s+/g, '_')}`,
            label: opt.trim(),
            kind: 'quick_reply',
            data: { reply_text: opt.trim(), clarification_id: qid },
          });
        }
      }

      const contextRaw = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
      const contextCard = INCLUDE_RAW_AURORA_CONTEXT && contextRaw
        ? [{
          card_id: `aurora_ctx_${ctx.request_id}`,
          type: 'aurora_context_raw',
          payload: {
            intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
            clarification,
            context: contextRaw,
          },
        }]
        : [];

      const structured = getUpstreamStructuredOrJson(upstream);
      const structuredBlocked = Boolean(structured) && !allowRecs && structuredContainsCommerceLikeFields(structured);
      if (structuredBlocked) {
        fieldMissing.push({ field: 'aurora_structured', reason: 'recommendations_not_requested' });
      }

      const safeAnswer = sanitizeUpstreamAnswer(answer, {
        language: ctx.lang,
        hasCards: rawCards.length > 0,
        hasStructured: Boolean(structured && !structuredBlocked),
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(safeAnswer, 'markdown'),
        suggested_chips: suggestedChips,
        cards: [
          ...(structured && !structuredBlocked
            ? [{
              card_id: `structured_${ctx.request_id}`,
              type: 'aurora_structured',
              payload: structured,
            }]
            : []),
          ...cards.map((c, idx) => ({
            card_id: c.card_id || `aurora_${ctx.request_id}_${idx}`,
            type: c.type || 'aurora_card',
            title: c.title,
            payload: c.payload || c,
            ...(Array.isArray(c.field_missing) ? { field_missing: c.field_missing } : {}),
          })),
          ...contextCard,
          ...(fieldMissing.length
            ? [{ card_id: `gate_${ctx.request_id}`, type: 'gate_notice', payload: {}, field_missing: fieldMissing }]
            : []),
        ],
        session_patch: {},
        events: [
          makeEvent(ctx, 'value_moment', { kind: 'chat_reply' }),
          ...(allowRecs ? [makeEvent(ctx, 'recos_requested', { explicit: true })] : []),
        ],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err.status || 500;
      logger?.error({ err: err.message, status }, 'aurora bff chat failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to process chat.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'CHAT_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'CHAT_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });
}

module.exports = { mountAuroraBffRoutes };
