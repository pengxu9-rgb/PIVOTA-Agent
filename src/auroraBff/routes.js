const axios = require('axios');
const OpenAI = require('openai');
const sharp = require('sharp');
const fs = require('fs');
const { buildRequestContext } = require('./requestContext');
const { buildEnvelope, makeAssistantMessage, makeEvent } = require('./envelope');
const { createStageProfiler } = require('./skinAnalysisProfiling');
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
  AuthStartRequestSchema,
  AuthVerifyRequestSchema,
  AuthPasswordSetRequestSchema,
  AuthPasswordLoginRequestSchema,
} = require('./schemas');
const {
  getProfileForIdentity,
  upsertProfileForIdentity,
  upsertSkinLogForIdentity,
  getRecentSkinLogsForIdentity,
  saveLastAnalysisForIdentity,
  isCheckinDue,
  upsertIdentityLink,
  migrateGuestDataToUser,
} = require('./memoryStore');
const {
  createOtpChallenge,
  verifyOtpChallenge,
  createSession,
  resolveSessionFromToken,
  revokeSessionToken,
  getBearerToken,
  setUserPassword,
  verifyPasswordForEmail,
} = require('./authStore');
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
const { extractJsonObject, extractJsonObjectByKeys } = require('./jsonExtract');
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
  const n = Number(process.env.AURORA_BFF_RECO_ALTERNATIVES_MAX_PRODUCTS || 5);
  const v = Number.isFinite(n) ? Math.trunc(n) : 5;
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

async function runOpenAIVisionSkinAnalysis({ imageBuffer, language, profileSummary, recentLogsSummary, profiler } = {}) {
  if (!SKIN_VISION_ENABLED) return { ok: false, reason: 'vision_disabled' };
  const client = getOpenAIClient();
  if (!client) return { ok: false, reason: 'openai_not_configured' };
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || !imageBuffer.length) return { ok: false, reason: 'image_missing' };

  const optimized =
    profiler && typeof profiler.time === 'function'
      ? await profiler.time(
          'decode',
          async () =>
            sharp(imageBuffer)
              .rotate()
              .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toBuffer(),
          { kind: 'vision_prepare' },
        )
      : await sharp(imageBuffer)
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
    const callOpenAI = async () =>
      client.chat.completions.create(
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

    const resp =
      profiler && typeof profiler.timeLlmCall === 'function'
        ? await profiler.timeLlmCall({ provider: 'openai', model: SKIN_VISION_MODEL, kind: 'skin_vision' }, callOpenAI)
        : await callOpenAI();

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
  const routineRaw = p.currentRoutine;
  const routineText =
    typeof routineRaw === 'string'
      ? routineRaw
      : routineRaw && typeof routineRaw === 'object'
        ? JSON.stringify(routineRaw)
        : '';
  const routineTextLower = String(routineText || '').toLowerCase();

  const hasStingingSignal =
    /\bsting\b|\bstinging\b|\bburn\b|\bburning\b|\birritat|\bredness\b|\bflak|\bpeel/.test(routineTextLower);

  const features = [];
  if (p.barrierStatus === 'impaired') {
    features.push({
      observation:
        lang === 'CN'
          ? '你自述屏障不稳定（易刺痛/泛红）→ 先把“舒缓修护”放在优先级第一。'
          : 'You reported an irritated barrier → prioritize calming + repair first.',
      confidence: 'pretty_sure',
    });
  } else if (hasStingingSignal) {
    features.push({
      observation:
        lang === 'CN'
          ? '你提到最近有刺痛/泛红/脱皮信号 → 先按“屏障压力”处理，建议先降阶与简化。'
          : 'You mentioned stinging/redness/flaking signals → treat this as barrier stress and simplify first.',
      confidence: 'somewhat_sure',
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

  // Very light routine heuristic: only surface broad safety signals (no brand recommendations).
  if (routineTextLower) {
    const hasRetinoid = /\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b/.test(routineTextLower);
    const hasExfoliatingAcid =
      /\bglycolic\b|\blactic\b|\bmandelic\b|\bsalicylic\b|\bbha\b|\baha\b/.test(routineTextLower);
    const hasBpo = /\bbenzoyl\b|\bbpo\b/.test(routineTextLower);
    const hasHighStrengthVitC = /\bascorbic\b|\bl-ascorbic\b|\bvitamin c\b|\bhigh[- ]?strength\b/.test(routineTextLower);
    if (hasRetinoid || hasExfoliatingAcid || hasBpo) {
      const actives = [
        ...(hasRetinoid ? [lang === 'CN' ? '维A类' : 'retinoid'] : []),
        ...(hasExfoliatingAcid ? [lang === 'CN' ? '酸类' : 'acids'] : []),
        ...(hasBpo ? [lang === 'CN' ? '过氧化苯甲酰(BPO)' : 'benzoyl peroxide (BPO)'] : []),
      ];
      features.push({
        observation:
          lang === 'CN'
            ? `你当前 routine 里包含 ${actives.join(' / ')} → 先避免叠加、从低频开始，降低刺激风险。`
            : `Your current routine includes ${actives.join(' / ')} → avoid stacking and start low-frequency to reduce irritation risk.`,
        confidence: 'somewhat_sure',
      });
    }

    if (hasRetinoid && hasStingingSignal) {
      features.push({
        observation:
          lang === 'CN'
            ? '你提到用维A后会刺痛 → 常见原因是频率过高/叠加刺激/屏障压力；先暂停几晚再用更低频。'
            : 'Stinging after a retinoid often means frequency/stacking is too aggressive; pause a few nights and restart lower.',
        confidence: 'somewhat_sure',
      });
    }

    if (hasExfoliatingAcid && hasHighStrengthVitC && (p.barrierStatus === 'impaired' || hasStingingSignal)) {
      features.push({
        observation:
          lang === 'CN'
            ? '酸类 + 高浓 VC 同期叠加在屏障压力期更容易刺激 → 建议分开天用或先停一类。'
            : 'Acids + high-strength vitamin C can be harsh during barrier stress → separate days or pause one active.',
        confidence: 'somewhat_sure',
      });
    }
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

  const goalText = goals.map((g) => String(g || '').trim().toLowerCase()).filter(Boolean);
  const wantsPoresOrAcne = goalText.includes('pores') || goalText.includes('acne');
  const wantsWrinkles = goalText.includes('wrinkles') || goalText.includes('anti-aging') || goalText.includes('aging');

  const plan = [];
  if (lang === 'CN') {
    plan.push('少而稳：温和洁面 + 保湿 + 白天 SPF。');
    plan.push(
      p.barrierStatus === 'impaired' || hasStingingSignal
        ? '若刺痛/泛红：先停 5–7 天强刺激活性（酸/高浓 VC/维A），以修护为主。'
        : '活性只引入 1 个：从低频（每周 1–2 次）开始，观察 72 小时。'
    );
    plan.push(
      wantsPoresOrAcne
        ? '毛孔/闭口：等皮肤稳定后再从每周 2 次开始，别和维A同晚叠加。'
        : wantsWrinkles
          ? '细纹/抗老：优先 SPF + 补水；维A等稳定后再慢慢加。'
          : '如果你愿意，我可以先按“最少新增”给你一个 3–4 步 AM/PM 框架。'
    );
  } else {
    plan.push('Keep it minimal: gentle cleanser + moisturizer + daytime SPF.');
    plan.push(
      p.barrierStatus === 'impaired' || hasStingingSignal
        ? 'If stinging/redness: pause strong actives for 5–7 days (acids/high-strength vitamin C/retinoids) and focus on repair.'
        : 'Introduce only ONE active at a time: start 1–2×/week and watch the 72h response.'
    );
    plan.push(
      wantsPoresOrAcne
        ? 'For pores/texture: wait until calm, then start 2×/week; avoid stacking with a retinoid on the same night.'
        : wantsWrinkles
          ? 'For fine lines: prioritize SPF + hydration; consider retinoid only after skin feels stable.'
          : 'If you want, I can draft a minimal 3–4 step AM/PM framework with minimal new purchases.'
    );
  }

  const question =
    lang === 'CN'
      ? /\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b/.test(routineTextLower)
        ? '你现在维A大概每周用几晚？会不会和酸/VC同晚叠加？'
        : '你最近有刺痛或泛红吗？'
      : /\bretinol\b|\badapalene\b|\btretinoin\b|\bretinoid\b/.test(routineTextLower)
        ? 'How many nights/week are you using your retinoid, and are you stacking it with acids/vitamin C?'
        : 'Any stinging or redness recently?';

  const strategy = `${lang === 'CN' ? '接下来 7 天建议：' : 'Next 7 days:'}\n1) ${plan[0]}\n2) ${plan[1]}\n3) ${plan[2]}\n\n${question}`;

  return {
    features: features.slice(0, 6),
    strategy: strategy.slice(0, 1200),
    needs_risk_check: false,
  };
}

function buildLowConfidenceBaselineSkinAnalysis({ profile, language }) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const p = profile || {};
  const goals = Array.isArray(p.goals) ? p.goals : [];

  const features = [];
  if (p.barrierStatus === 'impaired') {
    features.push({
      observation:
        lang === 'CN'
          ? '你自述屏障可能不稳定 → 建议先走“舒缓修护”优先路线。'
          : 'You may have a stressed barrier → prioritize calming + repair first.',
      confidence: 'somewhat_sure',
    });
  }
  if (p.skinType) {
    features.push({
      observation:
        lang === 'CN'
          ? `你自述肤质为 ${String(p.skinType)} → 我会先给“低风险通用策略”。`
          : `You reported ${String(p.skinType)} skin → I’ll start with low-risk baseline guidance.`,
      confidence: 'somewhat_sure',
    });
  }
  if (goals.length) {
    features.push({
      observation:
        lang === 'CN'
          ? `你的目标包含 ${goals.slice(0, 2).join(' / ')} → 但在缺少更多输入时只能给方向性建议。`
          : `Your goals include ${goals.slice(0, 2).join(' / ')} → but without more inputs I can only give directional guidance.`,
      confidence: 'not_sure',
    });
  }

  const strategy =
    lang === 'CN'
      ? '当前信息不足（缺少你正在用的产品/步骤），我先给低风险的 7 天基线：\n1) 少而稳：温和洁面 + 保湿 + 白天 SPF。\n2) 若刺痛/泛红：先停用强刺激活性（酸/高浓 VC/视黄醇），以修护为主。\n3) 任何新活性都从低频开始（每周 1–2 次），观察 72 小时。\n\n为了把建议做得更准：请把你现在 AM/PM 用的产品（洁面/活性/保湿/SPF，名字或链接都行）发我；如果方便，也可以补一张自然光自拍（可选）。'
      : "I don't have your current products/steps yet, so this is a low-confidence baseline:\n1) Keep it minimal: gentle cleanser + moisturizer + daytime SPF.\n2) If stinging/redness: pause strong actives (acids/high-strength vitamin C/retinoids) and focus on repair.\n3) Any new active: start 1–2×/week and watch the 72h response.\n\nTo personalize this safely: please share your current AM/PM products (cleanser/actives/moisturizer/SPF, names or links). If you'd like, you can also add a daylight selfie (optional).";

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

async function resolveIdentity(req, ctx) {
  const token = getBearerToken(req);
  if (!token) return { auroraUid: ctx.aurora_uid, userId: null, userEmail: null, token: null, auth_invalid: false };

  let session = null;
  try {
    session = await resolveSessionFromToken(token);
  } catch {
    session = null;
  }

  if (!session) return { auroraUid: ctx.aurora_uid, userId: null, userEmail: null, token: null, auth_invalid: true };

  if (ctx.aurora_uid) {
    try {
      await upsertIdentityLink(ctx.aurora_uid, session.userId);
    } catch {
      // ignore
    }
  }

  return { auroraUid: ctx.aurora_uid, userId: session.userId, userEmail: session.email, token, auth_invalid: false };
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

function classifyStorageError(err) {
  const code = err && err.code ? String(err.code) : null;
  const sqlState = code && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  const netCodes = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

  const dbNotConfigured = code === 'NO_DATABASE';
  const dbSchemaError = sqlState === '42P01' || sqlState === '42703' || sqlState === '42883';
  const dbError = dbNotConfigured || Boolean(sqlState) || netCodes.has(code);
  return { code, sqlState, dbError, dbNotConfigured, dbSchemaError };
}

function extractIncludeAlternativesFromAction(action) {
  if (!action || typeof action !== 'object') return false;
  const data = action.data && typeof action.data === 'object' ? action.data : null;
  if (!data) return false;
  return coerceBoolean(data.include_alternatives ?? data.includeAlternatives);
}

function summarizeProfileForContext(profile) {
  if (!profile) return null;
  const currentRoutineRaw = profile.currentRoutine;
  let currentRoutine = null;
  if (typeof currentRoutineRaw === 'string') {
    const t = currentRoutineRaw.trim();
    currentRoutine = t ? t.slice(0, 4000) : null;
  } else if (currentRoutineRaw && typeof currentRoutineRaw === 'object') {
    try {
      const json = JSON.stringify(currentRoutineRaw);
      currentRoutine = json.length > 5000 ? `${json.slice(0, 5000)}…` : json;
    } catch {
      currentRoutine = null;
    }
  }

  const itineraryRaw = profile.itinerary;
  let itinerary = null;
  if (typeof itineraryRaw === 'string') {
    const t = itineraryRaw.trim();
    itinerary = t ? t.slice(0, 1200) : null;
  } else if (itineraryRaw && typeof itineraryRaw === 'object') {
    try {
      const json = JSON.stringify(itineraryRaw);
      itinerary = json.length > 1500 ? `${json.slice(0, 1500)}…` : json;
    } catch {
      itinerary = null;
    }
  }

  const contraindications = Array.isArray(profile.contraindications)
    ? profile.contraindications.filter((v) => typeof v === 'string' && v.trim()).slice(0, 12)
    : [];

  return {
    skinType: profile.skinType || null,
    sensitivity: profile.sensitivity || null,
    barrierStatus: profile.barrierStatus || null,
    goals: Array.isArray(profile.goals) ? profile.goals : [],
    region: profile.region || null,
    budgetTier: profile.budgetTier || null,
    currentRoutine,
    itinerary,
    contraindications,
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

function stripInternalKbRefsFromText(text) {
  const input = typeof text === 'string' ? text : '';
  if (!input.trim()) return input;

  const withoutKb = input.replace(
    /\bkb:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,})\b/gi,
    '',
  );

  const cleaned = withoutKb
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^(evidence|citation|citations|source|sources)[:：]?\s*$/i.test(t)) return false;
      if (/^(证据|引用|来源)[:：]?\s*$/.test(t)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

function sanitizeUpstreamAnswer(answer, { language, hasCards, hasStructured, stripInternalRefs } = {}) {
  let t = typeof answer === 'string' ? answer : '';
  if (stripInternalRefs) t = stripInternalKbRefsFromText(t);
  if (!looksLikeJsonOrCode(t)) return t;

  const lang = language === 'CN' ? 'CN' : 'EN';
  const hasAnything = Boolean(hasCards) || Boolean(hasStructured);
  if (lang === 'CN') {
    return hasAnything ? '我已经把结果整理成结构化卡片（见下方）。' : '我已收到你的信息。';
  }
  return hasAnything ? 'I formatted the result into structured cards below.' : 'Got it.';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp0to100(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function titleCase(value) {
  const t = String(value || '').trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function buildEnvStressUiModelFromUpstream(value, { language } = {}) {
  if (!isPlainObject(value)) return null;
  const schema = typeof value.schema_version === 'string' ? value.schema_version : '';

  if (schema === 'aurora.ui.env_stress.v1') return value;
  if (schema !== 'aurora.env_stress.v1') return null;

  const essRaw = coerceNumber(value.ess);
  const ess = essRaw == null ? null : clamp0to100(essRaw);
  const tier = typeof value.tier === 'string' ? value.tier.trim() || null : null;

  const contributors = Array.isArray(value.contributors) ? value.contributors : [];
  const weights = contributors.map((c) => {
    if (!isPlainObject(c)) return null;
    const w = coerceNumber(c.weight);
    return w == null || w < 0 ? null : w;
  });

  const weightSum = weights.reduce((acc, w) => acc + (w ?? 0), 0);
  const denom = weightSum > 0 ? weightSum : contributors.length;

  const radar = [];
  for (let i = 0; i < contributors.length; i += 1) {
    const c = contributors[i];
    if (!isPlainObject(c)) continue;
    const axisRaw = typeof c.key === 'string' ? c.key.trim() : '';
    if (!axisRaw) continue;
    const w = weightSum > 0 ? (weights[i] ?? 0) / denom : 1 / denom;
    const v = ess == null ? 0 : clamp0to100(Math.round(ess * w));
    radar.push({ axis: titleCase(axisRaw).slice(0, 40), value: v });
    if (radar.length >= 8) break;
  }

  const notes = [];
  const missing = Array.isArray(value.missing_inputs) ? value.missing_inputs : [];
  const missingFlat = missing.map((m) => String(m || '').trim()).filter(Boolean);
  if (missingFlat.length) {
    notes.push(
      language === 'CN'
        ? `缺少：${missingFlat.slice(0, 4).join(' / ')}`
        : `Missing: ${missingFlat.slice(0, 4).join(' / ')}`,
    );
  }

  for (const c of contributors) {
    if (!isPlainObject(c)) continue;
    const note = typeof c.note === 'string' ? c.note.trim() : '';
    if (!note) continue;
    notes.push(note.slice(0, 220));
    if (notes.length >= 4) break;
  }

  return {
    schema_version: 'aurora.ui.env_stress.v1',
    ess,
    tier,
    radar,
    notes,
  };
}

function looksLikeWeatherOrEnvironmentQuestion(message) {
  const t = String(message || '').trim();
  if (!t) return false;

  const lower = t.toLowerCase();

  // English
  if (
    /\b(snow|rain|weather|humidity|uv|climate|wind|dry air|cold|heat|sun exposure|travel|itinerary|destination|flight|ski)\b/i.test(
      lower,
    )
  )
    return true;

  // Chinese (keep focused on environment, not general skin symptoms)
  if (
    /(下雪|雪天|下雨|雨天|天气|气温|温度|湿度|紫外线|UV|风大|大风|寒冷|冷空气|高温|热浪|干燥(空气|天气)?|雾霾|污染|花粉|旅行|出差|飞行|飞机|高原|海边|滑雪|户外)/.test(
      t,
    )
  )
    return true;

  return false;
}

function extractWeatherScenario(message) {
  const t = String(message || '').trim();
  if (!t) return 'unknown';
  const lower = t.toLowerCase();

  if (/(下雪|雪天|滑雪)/.test(t) || /\bsnow|ski\b/i.test(lower)) return 'snow';
  if (/(下雨|雨天|暴雨)/.test(t) || /\brain|storm\b/i.test(lower)) return 'rain';
  if (/(紫外线|UV|日晒|阳光|晒)/.test(t) || /\buv|sun|sunlight\b/i.test(lower)) return 'uv';
  if (/(湿度|潮湿|闷热)/.test(t) || /\bhumid|humidity\b/i.test(lower)) return 'humid';
  if (/(干燥|干冷|冷空气)/.test(t) || /\bdry air|dry|dehydrating\b/i.test(lower)) return 'dry';
  if (/(寒冷|冷|低温)/.test(t) || /\bcold|freez(e|ing)\b/i.test(lower)) return 'cold';
  if (/(大风|风大|风|刮风)/.test(t) || /\bwind|windy\b/i.test(lower)) return 'wind';
  if (/(旅行|出差|飞行|飞机|高原|海边)/.test(t) || /\btravel|flight|itinerary|destination\b/i.test(lower)) return 'travel';
  return 'unknown';
}

function buildEnvStressUiModelFromLocal({ profile, recentLogs, message, language } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';

  const barrier = String(profile && profile.barrierStatus ? profile.barrierStatus : '').trim().toLowerCase();
  const sensitivity = String(profile && profile.sensitivity ? profile.sensitivity : '').trim().toLowerCase();

  let ess = 35;
  if (barrier === 'impaired' || barrier === 'damaged') ess = 75;
  else if (barrier === 'healthy' || barrier === 'stable') ess = 20;
  else if (barrier) ess = 35;

  if (sensitivity === 'high' || sensitivity === 'sensitive') ess += 10;

  const scenario = extractWeatherScenario(message);
  const bumpMap = {
    snow: 18,
    cold: 15,
    wind: 12,
    dry: 15,
    uv: 15,
    rain: 8,
    humid: 8,
    travel: 12,
    unknown: 6,
  };
  ess += bumpMap[scenario] ?? 6;
  ess = clamp0to100(ess);

  const tier = ess <= 30 ? 'Low' : ess <= 60 ? 'Medium' : 'High';

  const barrierScore = barrier === 'impaired' || barrier === 'damaged' ? 80 : barrier === 'healthy' || barrier === 'stable' ? 20 : 40;
  const weatherScore = scenario === 'snow' || scenario === 'cold' || scenario === 'dry' || scenario === 'wind' ? 70 : scenario === 'rain' || scenario === 'humid' ? 45 : scenario === 'travel' ? 55 : 35;
  const uvScore = scenario === 'uv' || scenario === 'snow' ? 65 : 30;

  const radar = [
    { axis: 'Barrier', value: clamp0to100(barrierScore) },
    { axis: 'Weather', value: clamp0to100(weatherScore) },
    { axis: 'UV', value: clamp0to100(uvScore) },
  ];

  const missing = [];
  if (!String(profile && profile.sensitivity ? profile.sensitivity : '').trim()) missing.push('profile.sensitivity');
  if (!Array.isArray(recentLogs) || recentLogs.length === 0) missing.push('recent_logs');

  const notes = [];
  if (missing.length) {
    notes.push(lang === 'CN' ? `缺少：${missing.slice(0, 4).join(' / ')}` : `Missing: ${missing.slice(0, 4).join(' / ')}`);
  }
  if (barrier) notes.push(`barrier_status=${barrier}`.slice(0, 220));
  if (scenario && scenario !== 'unknown') notes.push((lang === 'CN' ? `场景：${scenario}（推断）` : `Scenario: ${scenario} (inferred)`).slice(0, 220));

  return {
    schema_version: 'aurora.ui.env_stress.v1',
    ess,
    tier,
    radar,
    notes: notes.slice(0, 4),
  };
}

function buildWeatherAdviceMessage({ language, scenario, profile } = {}) {
  const lang = language === 'CN' ? 'CN' : 'EN';
  const skin = String(profile && profile.skinType ? profile.skinType : '').trim();

  const skinLine =
    skin && lang === 'CN'
      ? `你的肤质：${skin}。`
      : skin && lang === 'EN'
        ? `Your skin type: ${skin}.`
        : '';

  if (lang === 'CN') {
    if (scenario === 'snow') {
      return [
        '雪天的皮肤压力通常来自：低温 + 干燥 + 大风 + 雪地反光导致的 UV（更容易晒/更容易干裂）。',
        skinLine,
        '',
        '**护肤要点（优先级从高到低）**',
        '1) **保湿 + 封闭**：面霜稍厚一点；口周/鼻翼/脸颊干处可薄薄封一层凡士林类。',
        '2) **防晒**：即使阴天/下雪也建议 SPF30+（雪地反光会加剧 UV）。',
        '3) **温和清洁**：避免强清洁/磨砂；回家后用温和洁面即可。',
        '4) **活性减量**：如果你晚上用维A/酸，雪天更容易刺痛；更稳妥是把强酸和维A错开晚用。',
        '',
        '想要我根据你现有产品给你一个「雪天 AM/PM 版本」吗？也可以直接点下面的选项继续。',
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (scenario === 'uv') {
      return [
        '这类问题更像是「紫外线/日晒压力」场景：主要风险是晒黑/反黑、屏障受刺激、炎症后色沉加重。',
        skinLine,
        '',
        '**护肤要点**',
        '1) 防晒优先：足量 SPF30+，户外注意补涂。',
        '2) 轻薄但够保湿：避免晒后紧绷脱皮。',
        '3) 活性分开用：敏感/刺痛时先停酸/维A，先修护。',
      ]
        .filter(Boolean)
        .join('\n');
    }

    return [
      '我把你的问题理解成「天气/环境变化对皮肤的影响」。',
      skinLine,
      '',
      '**通用要点**',
      '1) 保湿与屏障优先（面霜/修护类）。',
      '2) 容易刺痛就先减量/停用强活性（酸/维A）。',
      '3) 白天注意防晒（户外更重要）。',
      '',
      '如果你告诉我你明天大概会在户外多久、以及最近是否有刺痛/爆皮，我可以把建议进一步细化。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // EN
  if (scenario === 'snow') {
    return [
      'Snowy days usually stress skin via: cold + dry air + wind + higher UV exposure from snow reflection.',
      skinLine,
      '',
      '**Skincare priorities**',
      '1) **Moisturize + seal**: use a richer moisturizer; consider a thin occlusive layer on dry-prone areas.',
      '2) **Sunscreen**: SPF 30+ even on cloudy/snowy days (reflection matters).',
      '3) **Gentle cleanse**: avoid harsh cleansing or scrubs.',
      '4) **Reduce actives**: if you use retinoids/acids, avoid stacking them on the same night—snowy weather increases irritation risk.',
      '',
      'Want me to adapt this into a simple AM/PM “snow day routine” for what you already use?',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'I’m treating this as a “weather / environment stress” question for skin.',
    skinLine,
    '',
    '**General guidance**',
    '1) Prioritize barrier support (moisturizer, gentle routine).',
    '2) If you feel stinging/flaking, reduce strong actives (acids/retinoids).',
    '3) Use sunscreen for outdoor exposure.',
  ]
    .filter(Boolean)
    .join('\n');
}

function mergeExternalVerificationIntoStructured(structured, contextRaw) {
  const s = isPlainObject(structured) ? structured : null;
  if (!s) return structured;

  const hasExt = isPlainObject(s.external_verification) || isPlainObject(s.externalVerification);
  if (hasExt) return structured;

  const ctx = isPlainObject(contextRaw) ? contextRaw : null;
  if (!ctx) return structured;

  const ext = isPlainObject(ctx.external_verification) ? ctx.external_verification : isPlainObject(ctx.externalVerification) ? ctx.externalVerification : null;
  if (!ext) return structured;

  return { ...s, external_verification: ext };
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

function buildAuroraProductRecommendationsQuery({ profile, requestText, lang }) {
  const skinType = profile && typeof profile.skinType === 'string' ? profile.skinType : 'unknown';
  const barrierStatus = mapBarrierStatus(profile && profile.barrierStatus);
  const concerns = mapConcerns(profile && profile.goals);
  const region = profile && typeof profile.region === 'string' && profile.region.trim() ? profile.region.trim() : 'US';
  const budget = normalizeBudgetHint(profile && profile.budgetTier) || 'unknown';
  const concernsStr = concerns.length ? concerns.join(', ') : 'none';
  const replyLang = lang === 'CN' ? 'Chinese' : 'English';
  const req = typeof requestText === 'string' ? requestText.trim() : '';

  return (
    `User profile: skin type ${skinType}; barrier status: ${barrierStatus}; concerns: ${concernsStr}; region: ${region}; budget: ${budget}.\n` +
    (req ? `User request: ${req}\n` : '') +
    `Task: Generate skincare product picks (NOT a full AM/PM routine).\n` +
    `Return ONLY a JSON object with keys: recommendations (array), evidence (object), confidence (0..1), missing_info (string[]), warnings (string[]).\n` +
    `recommendations: up to 5 items, ranked.\n` +
    `Each recommendation item MUST include:\n` +
    `- slot: "other"\n` +
    `- step: category label (cleanser/sunscreen/treatment/moisturizer/other)\n` +
    `- score: integer 0..100 (fit score)\n` +
    `- sku: {brand,name,display_name,sku_id,product_id,category,availability(string[]),price{usd,cny,unknown}}\n` +
    `- reasons: string[] (max 4). Reasons must be end-user readable and user-specific.\n` +
    `  - Include at least one reason that explicitly references the user's profile (skin type / sensitivity / barrier / goals / budget).\n` +
    `  - If recent_logs were provided, include one reason that references the last 7 days trend; otherwise add warnings: "recent_logs_missing".\n` +
    `  - If upcoming plan/travel context is not available, add warnings: "itinerary_unknown" (do NOT guess).\n` +
    `- evidence_pack: {keyActives,sensitivityFlags,pairingRules,comparisonNotes,citations} (omit unknown keys; do NOT fabricate).\n` +
    `- missing_info: string[] (per-item; ONLY user-provided fields like budget_unknown)\n` +
    `- warnings: string[] (per-item; quality signals like over_budget/price_unknown/recent_logs_missing)\n` +
    `Rules:\n` +
    `- Do NOT include checkout links.\n` +
    `- Do NOT recommend the exact same sku_id/product_id twice.\n` +
    `- If unsure, use null/unknown and list missing_info/warnings (do not fabricate).\n` +
    `- All free-text strings should be in ${replyLang}.\n`
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

async function fetchRecoAlternativesForProduct({ ctx, profileSummary, recentLogs, productInput, productObj, anchorId, debug, logger }) {
  const inputText = String(productInput || '').trim();
  const productJson = productObj && typeof productObj === 'object' ? JSON.stringify(productObj).slice(0, 1400) : '';
  const anchor = anchorId ? String(anchorId).trim() : '';
  const bestInput = inputText || anchor;
  if (!bestInput) return { ok: false, alternatives: [], field_missing: [{ field: 'alternatives', reason: 'product_identity_missing' }] };

  const prefix = buildContextPrefix({
    profile: profileSummary || null,
    recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
    lang: ctx.lang,
    trigger_source: ctx.trigger_source,
    intent: 'alternatives',
    action_id: 'chip.action.dupe_compare',
  });

  const query =
    `${prefix}` +
    `Task: Deep-scan this product and return alternatives (dupe/similar/premium) tailored to this user if possible.\n` +
    `Return ONLY a JSON object with keys: alternatives (array).\n` +
    `Each alternative item should include: product (object), similarity_score (0..1 or 0..100), tradeoffs (object), reasons (string[] max 2), evidence (object), missing_info (string[]).\n` +
    `Reasons must be end-user readable and explain why this alternative is useful for THIS user's profile/logs/budget (do NOT guess missing info; use missing_info).\n` +
    `Product: ${bestInput}\n` +
    (productJson ? `Product JSON: ${productJson}\n` : '');

  let upstream = null;
  try {
    upstream = await auroraChat({
      baseUrl: AURORA_DECISION_BASE_URL,
      query,
      timeoutMs: Math.max(RECO_ALTERNATIVES_TIMEOUT_MS, 14000),
      ...(anchor ? { anchor_product_id: anchor } : {}),
    });
  } catch (err) {
    logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: alternatives upstream failed');
    return {
      ok: false,
      alternatives: [],
      field_missing: [{ field: 'alternatives', reason: 'upstream_error' }],
      ...(debug
        ? {
          debug: {
            input: bestInput.slice(0, 200),
            anchor_id: anchor || null,
            product_json_preview: productJson ? productJson.slice(0, 300) : null,
            error: err && err.message ? err.message : String(err),
          },
        }
        : {}),
    };
  }

  const answerJson = upstream && typeof upstream.answer === 'string' ? extractJsonObjectByKeys(upstream.answer, ['alternatives']) : null;
  const structuredFallback = getUpstreamStructuredOrJson(upstream);
  const structured =
    answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) && Array.isArray(answerJson.alternatives)
      ? answerJson
      : structuredFallback || answerJson;
  const alternativesRaw = structured && Array.isArray(structured.alternatives) ? structured.alternatives : [];
  const mapped = mapAuroraAlternativesToRecoAlternatives(alternativesRaw, { lang: ctx.lang, maxTotal: 3 });

  return {
    ok: true,
    alternatives: mapped,
    field_missing: mapped.length ? [] : [{ field: 'alternatives', reason: structured ? 'upstream_missing_or_empty' : 'upstream_missing_or_unstructured' }],
    ...(debug
      ? {
        debug: {
          input: bestInput.slice(0, 200),
          anchor_id: anchor || null,
          product_json_preview: productJson ? productJson.slice(0, 300) : null,
          upstream_intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
          has_structured: Boolean(upstream && upstream.structured),
          structured_keys:
            upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
              ? Object.keys(upstream.structured).slice(0, 24)
              : [],
          extracted_answer_json_keys:
            answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? Object.keys(answerJson).slice(0, 24) : [],
          extracted_structured_keys:
            structured && typeof structured === 'object' && !Array.isArray(structured) ? Object.keys(structured).slice(0, 24) : [],
          alternatives_raw_count: alternativesRaw.length,
          alternatives_mapped_count: mapped.length,
        },
      }
      : {}),
  };
}

async function enrichRecommendationsWithAlternatives({ ctx, profileSummary, recentLogs, recommendations, debug, logger }) {
  const recos = Array.isArray(recommendations) ? recommendations : [];
  const maxProducts = RECO_ALTERNATIVES_MAX_PRODUCTS;
  if (!recos.length || maxProducts <= 0) return { recommendations: recos, field_missing: [] };

  if (!AURORA_DECISION_BASE_URL && !USE_AURORA_BFF_MOCK) {
    return { recommendations: recos, field_missing: [{ field: 'recommendations[].alternatives', reason: 'aurora_not_configured' }] };
  }

  const firstBySlot = { am: null, pm: null, other: null };
  for (let i = 0; i < recos.length; i += 1) {
    const item = recos[i];
    const slot = item && typeof item === 'object' ? String(item.slot || '').trim().toLowerCase() : '';
    const key = slot === 'am' ? 'am' : slot === 'pm' ? 'pm' : 'other';
    if (firstBySlot[key] == null) firstBySlot[key] = i;
  }

  const orderedIdx = [];
  const seenIdx = new Set();
  for (const key of ['am', 'pm', 'other']) {
    const idx = firstBySlot[key];
    if (typeof idx !== 'number') continue;
    if (seenIdx.has(idx)) continue;
    seenIdx.add(idx);
    orderedIdx.push(idx);
  }
  for (let i = 0; i < recos.length; i += 1) {
    if (seenIdx.has(i)) continue;
    orderedIdx.push(i);
  }

  const targets = [];
  for (const idx of orderedIdx) {
    if (targets.length >= maxProducts) break;
    const item = recos[idx];
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
    targets.push({ idx, inputText, anchorId, productObj: candidate });
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
      productObj: t.productObj,
      anchorId: t.anchorId,
      debug,
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
  const debugInfo = debug
    ? results
      .map((r) => (r && typeof r === 'object' && r.debug ? { idx: r.idx, ...r.debug } : null))
      .filter(Boolean)
      .slice(0, 8)
    : null;
  return { recommendations: enriched, field_missing, ...(debugInfo ? { debug: debugInfo } : {}) };
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
  norm.payload = { ...norm.payload, intent: 'routine', profile: profileSummary || null };

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

  const budgetKnown = normalizeBudgetHint(profileSummary && profileSummary.budgetTier);
  if (budgetKnown && Array.isArray(norm.payload?.missing_info)) {
    norm.payload.missing_info = norm.payload.missing_info.filter((code) => String(code) !== 'budget_unknown');
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

async function generateProductRecommendations({ ctx, profile, recentLogs, message, includeAlternatives, debug, logger }) {
  const profileSummary = summarizeProfileForContext(profile);
  const analysisSummary =
    profile && profile.lastAnalysis && (!profile.lastAnalysisLang || profile.lastAnalysisLang === ctx.lang) ? profile.lastAnalysis : null;
  const analysisSummaryAt = profile && profile.lastAnalysisAt ? profile.lastAnalysisAt : null;
  const prefix = buildContextPrefix({
    profile: profileSummary || null,
    recentLogs: Array.isArray(recentLogs) ? recentLogs : [],
    lang: ctx.lang,
    state: ctx.state,
    trigger_source: ctx.trigger_source,
    action_id: 'chip.start.reco_products',
    intent: 'reco_products',
    ...(analysisSummary ? { analysis_summary: analysisSummary } : {}),
    ...(analysisSummaryAt ? { analysis_summary_at: analysisSummaryAt } : {}),
  });
  const userAsk =
    String(message || '').trim() ||
    (ctx.lang === 'CN' ? '给我推荐几款护肤产品（按我的肤况与目标）' : 'Recommend a few skincare products for my profile and goals.');

  const query =
    `${prefix}` +
    buildAuroraProductRecommendationsQuery({
      profile: profileSummary || {},
      requestText: userAsk,
      lang: ctx.lang,
    });

  let upstream = null;
  try {
    upstream = await auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query, timeoutMs: 22000 });
  } catch (err) {
    if (err && err.code !== 'AURORA_NOT_CONFIGURED') {
      logger?.warn({ err: err.message }, 'aurora bff: product reco upstream failed');
    }
  }

  const contextObj = upstream && upstream.context && typeof upstream.context === 'object' ? upstream.context : null;
  const routine = contextObj ? contextObj.routine : null;
  const contextMeta = contextObj && typeof contextObj === 'object' && !Array.isArray(contextObj) ? { ...contextObj } : {};
  if (profileSummary && profileSummary.budgetTier && !contextMeta.budget && !contextMeta.budget_cny) {
    contextMeta.budget = profileSummary.budgetTier;
  }

  const answerJson = upstream && typeof upstream.answer === 'string' ? extractJsonObjectByKeys(upstream.answer, ['recommendations']) : null;
  const structuredFallback = getUpstreamStructuredOrJson(upstream);

  // Prefer: explicit JSON (from answer) → routine object (from context) → any structured blob.
  let structured = answerJson;
  let structuredSource = answerJson ? 'answer_json' : null;
  if (!structured && routine) {
    structured = mapAuroraRoutineToRecoGenerate(routine, contextMeta);
    structuredSource = 'context_routine';
  }
  if (!structured) {
    structured = structuredFallback;
    structuredSource = structuredFallback ? 'structured_fallback' : null;
  }
  const upstreamDebug = debug
    ? {
      intent: upstream && typeof upstream.intent === 'string' ? upstream.intent : null,
      has_structured: Boolean(upstream && upstream.structured),
      structured_keys:
        upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
          ? Object.keys(upstream.structured).slice(0, 24)
          : [],
      answer_preview:
        upstream && typeof upstream.answer === 'string' ? upstream.answer.slice(0, 800) : null,
      cards_types: Array.isArray(upstream && upstream.cards)
        ? upstream.cards
          .map((c) => (c && typeof c === 'object' && typeof c.type === 'string' ? c.type : null))
          .filter(Boolean)
          .slice(0, 12)
        : [],
      clarification:
        upstream && upstream.clarification && typeof upstream.clarification === 'object' ? upstream.clarification : null,
      context_keys:
        upstream && upstream.context && typeof upstream.context === 'object' && !Array.isArray(upstream.context)
          ? Object.keys(upstream.context).slice(0, 24)
          : [],
      structured_source: structuredSource,
      extracted_answer_json_keys:
        answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? Object.keys(answerJson).slice(0, 24) : [],
      extracted_structured_keys:
        structured && typeof structured === 'object' && !Array.isArray(structured) ? Object.keys(structured).slice(0, 24) : [],
    }
    : null;
  const mapped = structured && typeof structured === 'object' && !Array.isArray(structured) ? { ...structured } : null;
  if (mapped && Array.isArray(mapped.recommendations)) {
    mapped.recommendations = mapped.recommendations.map((r) => coerceRecoItemForUi(r, { lang: ctx.lang }));
  }

  const norm = normalizeRecoGenerate(mapped);
  norm.payload = { ...norm.payload, intent: 'reco_products', profile: profileSummary || null };
  if (Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length) {
    const deduped = [];
    const seen = new Set();
    for (const item of norm.payload.recommendations) {
      if (!item || typeof item !== 'object') continue;
      const base = item && typeof item === 'object' && !Array.isArray(item) ? item : null;
      const candidate =
        base && base.sku && typeof base.sku === 'object'
          ? base.sku
          : base && base.product && typeof base.product === 'object'
            ? base.product
            : base;
      const anchorId = extractAnchorIdFromProductLike(candidate) || extractAnchorIdFromProductLike(base);
      const inputText = buildProductInputText(candidate, null);
      const key = String(anchorId || inputText || '').trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({ ...base, slot: 'other' });
      if (deduped.length >= 8) break;
    }
    norm.payload = { ...norm.payload, recommendations: deduped };
  }
  let alternativesDebug = null;

  if (includeAlternatives) {
    const alt = await enrichRecommendationsWithAlternatives({
      ctx,
      profileSummary,
      recentLogs,
      recommendations: norm.payload.recommendations,
      debug,
      logger,
    });
    norm.payload = { ...norm.payload, recommendations: alt.recommendations };
    norm.field_missing = mergeFieldMissing(norm.field_missing, alt.field_missing);
    if (debug && alt && typeof alt === 'object' && alt.debug) {
      alternativesDebug = alt.debug;
    }
  }

  const budgetKnown = normalizeBudgetHint(profileSummary && profileSummary.budgetTier);
  if (budgetKnown && Array.isArray(norm.payload?.missing_info)) {
    norm.payload.missing_info = norm.payload.missing_info.filter((code) => String(code) !== 'budget_unknown');
  }

  return { norm, upstreamDebug, alternativesDebug };
}

function mountAuroraBffRoutes(app, { logger }) {
  app.post('/v1/auth/start', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthStartRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const challenge = await createOtpChallenge({ email: parsed.data.email, language: ctx.lang });
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          ctx.lang === 'CN'
            ? '我已把验证码发送到你的邮箱。请输入验证码完成登录。'
            : "I've sent a sign-in code to your email. Enter the code to continue.",
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_start_${ctx.request_id}`,
            type: 'auth_challenge',
            payload: {
              email: challenge.email,
              challenge_id: challenge.challengeId,
              expires_at: challenge.expiresAt,
              expires_in_seconds: challenge.expiresInSeconds,
              delivery: challenge.delivery,
              ...(challenge.debug_code ? { debug_code: challenge.debug_code } : {}),
              ...(challenge.delivery_error ? { delivery_error: challenge.delivery_error } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_started', { delivery: challenge.delivery })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_START_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status = code === 'INVALID_EMAIL' ? 400 : code === 'AUTH_NOT_CONFIGURED' ? 503 : dbError ? 503 : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'AUTH_NOT_CONFIGURED'
            ? ctx.lang === 'CN'
              ? '登录暂不可用（缺少配置）。'
              : 'Sign-in is not configured yet.'
            : dbError
              ? ctx.lang === 'CN'
                ? '登录暂不可用（存储未就绪）。请稍后重试。'
                : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.'
            : ctx.lang === 'CN'
              ? '验证码发送失败，请稍后重试。'
              : "Couldn't send a sign-in code. Please try again.",
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/verify', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthVerifyRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const verification = await verifyOtpChallenge({ email: parsed.data.email, code: parsed.data.code });
      if (!verification.ok) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            ctx.lang === 'CN' ? '验证码无效或已过期。' : 'Invalid or expired code.',
          ),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'INVALID_CODE', reason: verification.reason } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'INVALID_CODE', reason: verification.reason })],
        });
        return res.status(401).json(envelope);
      }

      const session = await createSession({ userId: verification.userId });

      if (ctx.aurora_uid) {
        try {
          await upsertIdentityLink(ctx.aurora_uid, verification.userId);
        } catch {
          // ignore
        }
        try {
          await migrateGuestDataToUser({ auroraUid: ctx.aurora_uid, userId: verification.userId });
        } catch (err) {
          logger?.warn({ err: err?.message || String(err) }, 'aurora bff: guest->account migration failed');
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '登录成功。' : 'Signed in.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_${ctx.request_id}`,
            type: 'auth_session',
            payload: {
              token: session.token,
              expires_at: session.expiresAt,
              user: { user_id: verification.userId, email: verification.email },
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_verified', { user_id: verification.userId })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_VERIFY_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status = code === 'AUTH_NOT_CONFIGURED' ? 503 : dbError ? 503 : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'AUTH_NOT_CONFIGURED'
            ? ctx.lang === 'CN'
              ? '登录暂不可用（缺少配置）。'
              : 'Sign-in is not configured yet.'
            : dbError
              ? ctx.lang === 'CN'
                ? '登录暂不可用（存储未就绪）。请稍后重试。'
                : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.'
            : ctx.lang === 'CN'
              ? '登录失败，请稍后重试。'
              : 'Sign-in failed. Please try again.',
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/password/login', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const parsed = AuthPasswordLoginRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      const verification = await verifyPasswordForEmail({ email: parsed.data.email, password: parsed.data.password });
      if (!verification.ok) {
        const isLocked = verification.reason === 'locked';
        const status = isLocked ? 429 : verification.reason === 'no_password_set' ? 409 : 401;
        const message =
          verification.reason === 'no_password_set'
            ? ctx.lang === 'CN'
              ? '该邮箱尚未设置密码，请先用邮箱验证码登录后再设置密码。'
              : 'No password is set for this email yet. Use an email code to sign in first, then set a password.'
            : isLocked
              ? ctx.lang === 'CN'
                ? '尝试次数过多，请稍后再试。'
                : 'Too many attempts. Please try again later.'
              : ctx.lang === 'CN'
                ? '邮箱或密码错误。'
                : 'Invalid email or password.';

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(message),
          suggested_chips: [],
          cards: [
            {
              card_id: `err_${ctx.request_id}`,
              type: 'error',
              payload: {
                error: isLocked ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS',
                reason: verification.reason,
                ...(verification.locked_until ? { locked_until: verification.locked_until } : {}),
              },
            },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: isLocked ? 'PASSWORD_LOCKED' : 'INVALID_CREDENTIALS' })],
        });
        return res.status(status).json(envelope);
      }

      const session = await createSession({ userId: verification.userId });

      if (ctx.aurora_uid) {
        try {
          await upsertIdentityLink(ctx.aurora_uid, verification.userId);
        } catch {
          // ignore
        }
        try {
          await migrateGuestDataToUser({ auroraUid: ctx.aurora_uid, userId: verification.userId });
        } catch (err) {
          logger?.warn({ err: err?.message || String(err) }, 'aurora bff: guest->account migration failed');
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '登录成功。' : 'Signed in.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_${ctx.request_id}`,
            type: 'auth_session',
            payload: {
              token: session.token,
              expires_at: session.expiresAt,
              user: { user_id: verification.userId, email: verification.email },
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_verified', { user_id: verification.userId, method: 'password' })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_PASSWORD_LOGIN_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status = code === 'AUTH_NOT_CONFIGURED' ? 503 : dbError ? 503 : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'AUTH_NOT_CONFIGURED'
            ? ctx.lang === 'CN'
              ? '登录暂不可用（缺少配置）。'
              : 'Sign-in is not configured yet.'
            : dbError
              ? ctx.lang === 'CN'
                ? '登录暂不可用（存储未就绪）。请稍后重试。'
                : 'Sign-in is not ready yet (storage unavailable). Please try again shortly.'
            : ctx.lang === 'CN'
              ? '登录失败，请稍后重试。'
              : 'Sign-in failed. Please try again.',
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/password/set', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      if (!identity.userId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '请先登录。' : 'Please sign in first.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UNAUTHORIZED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UNAUTHORIZED' })],
        });
        return res.status(401).json(envelope);
      }

      const parsed = AuthPasswordSetRequestSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage('Invalid request.'),
          suggested_chips: [],
          cards: [
            { card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'BAD_REQUEST', details: parsed.error.format() } },
          ],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'BAD_REQUEST' })],
        });
        return res.status(400).json(envelope);
      }

      await setUserPassword({ userId: identity.userId, password: parsed.data.password });

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          ctx.lang === 'CN'
            ? '密码已设置。下次你可以用邮箱 + 密码直接登录（仍可用邮箱验证码）。'
            : 'Password set. Next time you can sign in with email + password (OTP still works too).',
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `auth_password_set_${ctx.request_id}`,
            type: 'auth_password_set',
            payload: { ok: true },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_password_set', { user_id: identity.userId })],
      });
      return res.json(envelope);
    } catch (err) {
      const fallbackCode = err && err.code ? err.code : err && err.message ? err.message : 'AUTH_PASSWORD_SET_FAILED';
      const { code: storageCode, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const code = storageCode || fallbackCode;
      const status =
        code === 'INVALID_PASSWORD'
          ? 400
          : code === 'UNAUTHORIZED'
            ? 401
            : code === 'AUTH_NOT_CONFIGURED'
              ? 503
              : dbError
                ? 503
                : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(
          code === 'INVALID_PASSWORD'
            ? ctx.lang === 'CN'
              ? '密码格式不正确（至少 8 位）。'
              : 'Invalid password (min 8 characters).'
            : code === 'AUTH_NOT_CONFIGURED'
              ? ctx.lang === 'CN'
                ? '登录暂不可用（缺少配置）。'
                : 'Sign-in is not configured yet.'
              : dbError
                ? ctx.lang === 'CN'
                  ? '暂时无法保存密码（存储未就绪）。请稍后重试。'
                  : "Couldn't save password yet (storage unavailable). Please try again shortly."
              : ctx.lang === 'CN'
                ? '设置密码失败，请稍后重试。'
                : "Couldn't set password. Please try again.",
        ),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error: dbNotConfigured ? 'DB_NOT_CONFIGURED' : dbSchemaError ? 'DB_SCHEMA_NOT_READY' : dbError ? 'DB_UNAVAILABLE' : code,
              ...(storageCode ? { code: storageCode } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/auth/me', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const identity = await resolveIdentity(req, ctx);
      if (!identity.userId) {
        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '未登录。' : 'Not signed in.'),
          suggested_chips: [],
          cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: 'UNAUTHORIZED' } }],
          session_patch: {},
          events: [makeEvent(ctx, 'error', { code: 'UNAUTHORIZED' })],
        });
        return res.status(401).json(envelope);
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `me_${ctx.request_id}`,
            type: 'auth_me',
            payload: {
              user: { user_id: identity.userId, email: identity.userEmail },
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'value_moment', { kind: 'auth_me' })],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to load session.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'AUTH_ME_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'AUTH_ME_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.post('/v1/auth/logout', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const token = getBearerToken(req);
      if (token) {
        try {
          await revokeSessionToken(token);
        } catch {
          // ignore
        }
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(ctx.lang === 'CN' ? '已退出登录。' : 'Signed out.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `logout_${ctx.request_id}`,
            type: 'auth_logout',
            payload: { ok: true },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'auth_logout', {})],
      });
      return res.json(envelope);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage('Failed to sign out.'),
        suggested_chips: [],
        cards: [{ card_id: `err_${ctx.request_id}`, type: 'error', payload: { error: err.code || 'AUTH_LOGOUT_FAILED' } }],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: err.code || 'AUTH_LOGOUT_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

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

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const commonMeta = {
        profile: profileSummary,
        recentLogs,
        lang: ctx.lang,
        state: ctx.state || 'idle',
        trigger_source: ctx.trigger_source,
      };
      const parsePrefix = buildContextPrefix({ ...commonMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
      const prefix = buildContextPrefix({ ...commonMeta, intent: 'product_analyze', action_id: 'chip.action.analyze_product' });

      const input = parsed.data.url || parsed.data.name || JSON.stringify(parsed.data.product || {});
      let parsedProduct = parsed.data.product || null;
      let anchorId = parsedProduct && (parsedProduct.sku_id || parsedProduct.product_id);

      // If caller only provided a name/url, try to parse into an anchor product first to improve KB hit rate.
      if (!anchorId && input) {
        try {
          const parseQuery = `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
            `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
            `Input: ${input}`;

          const parseUpstream = await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: parseQuery,
            timeoutMs: 12000,
            ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
          });

          const parseStructured = (() => {
            if (parseUpstream && parseUpstream.structured && typeof parseUpstream.structured === 'object' && !Array.isArray(parseUpstream.structured)) {
              return parseUpstream.structured;
            }
            const a =
              parseUpstream && typeof parseUpstream.answer === 'string'
                ? extractJsonObjectByKeys(parseUpstream.answer, ['product', 'parse', 'anchor_product', 'anchorProduct'])
                : null;
            return a;
          })();
          const parseMapped =
            parseStructured && parseStructured.parse && typeof parseStructured.parse === 'object'
              ? mapAuroraProductParse(parseStructured)
              : parseStructured;
          const parseNorm = normalizeProductParse(parseMapped);
          parsedProduct = parseNorm.payload.product || parsedProduct;
          anchorId =
            parsedProduct && (parsedProduct.sku_id || parsedProduct.product_id)
              ? String(parsedProduct.sku_id || parsedProduct.product_id)
              : anchorId;
        } catch (err) {
          // ignore; continue without anchor id
        }
      }

      const query = `${prefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
        `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
        `Evidence must include science/social_signals/expert_notes.\n` +
        `Product: ${input}`;

      const runDeepScan = async ({ queryText, timeoutMs }) => {
        try {
          return await auroraChat({
            baseUrl: AURORA_DECISION_BASE_URL,
            query: queryText,
            timeoutMs,
            ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
            ...(parsed.data.url ? { anchor_product_url: parsed.data.url } : {}),
          });
        } catch {
          return null;
        }
      };

      let upstream = await runDeepScan({ queryText: query, timeoutMs: 16000 });

      const upstreamStructured = upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
        ? upstream.structured
        : null;
      const upstreamAnswerJson =
        upstream && typeof upstream.answer === 'string'
          ? extractJsonObjectByKeys(upstream.answer, [
            'assessment',
            'evidence',
            'confidence',
            'missing_info',
            'missingInfo',
            'analyze',
            'verdict',
            'reasons',
            'science_evidence',
            'social_signals',
            'expert_notes',
          ])
          : null;
      const upstreamAnswerObj = upstreamAnswerJson && typeof upstreamAnswerJson === 'object' && !Array.isArray(upstreamAnswerJson) ? upstreamAnswerJson : null;
      const answerLooksLikeProductAnalysis =
        upstreamAnswerObj &&
        (upstreamAnswerObj.assessment != null ||
          upstreamAnswerObj.evidence != null ||
          upstreamAnswerObj.analyze != null ||
          upstreamAnswerObj.confidence != null ||
          upstreamAnswerObj.missing_info != null ||
          upstreamAnswerObj.missingInfo != null);

      // Prefer answer JSON when `structured` exists but is missing `analyze`.
      const structuredOrJson =
        upstreamStructured && upstreamStructured.analyze && typeof upstreamStructured.analyze === 'object'
          ? upstreamStructured
          : answerLooksLikeProductAnalysis
            ? upstreamAnswerObj
            : upstreamStructured || upstreamAnswerObj;

      const mapped = structuredOrJson && structuredOrJson.analyze && typeof structuredOrJson.analyze === 'object'
        ? mapAuroraProductAnalysis(structuredOrJson)
        : structuredOrJson;
      let norm = normalizeProductAnalysis(mapped);

      // If personalized scan fails (often due to upstream echoing context or dropping analysis),
      // retry once with a minimal prefix to improve reliability. Mark the payload as less personalized.
      if (!norm.payload.assessment && profileSummary && input) {
        const minimalPrefix = buildContextPrefix({
          lang: ctx.lang,
          state: ctx.state || 'idle',
          trigger_source: ctx.trigger_source,
          intent: 'product_analyze_fallback',
          action_id: 'chip.action.analyze_product_fallback',
        });
        const minimalQuery =
          `${minimalPrefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
          `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
          `Evidence must include science/social_signals/expert_notes.\n` +
          `Product: ${input}`;
        const upstream2 = await runDeepScan({ queryText: minimalQuery, timeoutMs: 14000 });
        const structured2 = upstream2 && upstream2.structured && typeof upstream2.structured === 'object' && !Array.isArray(upstream2.structured)
          ? upstream2.structured
          : null;
        const answer2 =
          upstream2 && typeof upstream2.answer === 'string'
            ? extractJsonObjectByKeys(upstream2.answer, [
              'assessment',
              'evidence',
              'confidence',
              'missing_info',
              'missingInfo',
              'analyze',
              'verdict',
              'reasons',
              'science_evidence',
              'social_signals',
              'expert_notes',
            ])
            : null;
        const structuredOrJson2 =
          structured2 && structured2.analyze && typeof structured2.analyze === 'object'
            ? structured2
            : answer2 && typeof answer2 === 'object' && !Array.isArray(answer2)
              ? answer2
              : structured2 || answer2;
        const mapped2 = structuredOrJson2 && structuredOrJson2.analyze && typeof structuredOrJson2.analyze === 'object'
          ? mapAuroraProductAnalysis(structuredOrJson2)
          : structuredOrJson2;
        const norm2 = normalizeProductAnalysis(mapped2);
        if (norm2 && norm2.payload && norm2.payload.assessment) {
          const missingInfo = Array.isArray(norm2.payload.missing_info) ? norm2.payload.missing_info : [];
          norm = {
            payload: { ...norm2.payload, missing_info: Array.from(new Set([...missingInfo, 'profile_context_dropped_for_reliability'])) },
            field_missing: norm2.field_missing,
          };
        }
      }

      let payload = enrichProductAnalysisPayload(norm.payload, { lang: ctx.lang });
      if (parsedProduct && payload && typeof payload === 'object') {
        const a = payload.assessment && typeof payload.assessment === 'object' ? payload.assessment : null;
        if (a && !a.anchor_product && !a.anchorProduct) {
          payload = { ...payload, assessment: { ...a, anchor_product: parsedProduct } };
        }
      }

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

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
      const profileSummary = summarizeProfileForContext(profile);
      const commonMeta = {
        profile: profileSummary,
        recentLogs,
        lang: ctx.lang,
        state: ctx.state || 'idle',
        trigger_source: ctx.trigger_source,
      };
      const parsePrefix = buildContextPrefix({ ...commonMeta, intent: 'product_parse', action_id: 'chip.action.parse_product' });
      const analyzePrefix = buildContextPrefix({ ...commonMeta, intent: 'product_analyze', action_id: 'chip.action.analyze_product' });
      const comparePrefix = buildContextPrefix({ ...commonMeta, intent: 'dupe_compare', action_id: 'chip.action.dupe_compare' });

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
        `${parsePrefix}Task: Parse the user's product input into a normalized product entity.\n` +
        `Return ONLY a JSON object with keys: product, confidence, missing_info (string[]).\n` +
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

      const originalText = buildProductInputText(originalAnchor, parsed.data.original_url) || originalInput;
      const dupeText = buildProductInputText(dupeAnchor, parsed.data.dupe_url) || dupeInput;

      const compareQuery =
        `${comparePrefix}Task: Compare the original product vs the dupe/alternative.\n` +
        `Return ONLY a JSON object with keys: original, dupe, tradeoffs (string[]), evidence, confidence (0..1), missing_info (string[]).\n` +
        `Evidence must include science/social_signals/expert_notes.\n` +
        `Original: ${originalText}\n` +
        `Dupe: ${dupeText}`;

      let compareUpstream = null;
      try {
        const originalAnchorId = originalAnchor && (originalAnchor.sku_id || originalAnchor.product_id);
        compareUpstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query: compareQuery,
          timeoutMs: 18000,
          ...(originalAnchorId ? { anchor_product_id: String(originalAnchorId) } : {}),
          ...(parsed.data.original_url ? { anchor_product_url: parsed.data.original_url } : {}),
        });
      } catch (err) {
        // ignore; fall back below
      }

      const compareStructured = (() => {
        const structured = compareUpstream && compareUpstream.structured && typeof compareUpstream.structured === 'object' && !Array.isArray(compareUpstream.structured)
          ? compareUpstream.structured
          : null;
        const answerJson =
          compareUpstream && typeof compareUpstream.answer === 'string'
            ? extractJsonObjectByKeys(compareUpstream.answer, [
              'tradeoffs',
              'tradeoffs_detail',
              'tradeoffsDetail',
              'evidence',
              'original',
              'dupe',
              'alternatives',
              'compare',
            ])
            : null;
        const answerObj = answerJson && typeof answerJson === 'object' && !Array.isArray(answerJson) ? answerJson : null;
        if (structured && Array.isArray(structured.alternatives)) return structured;
        if (answerObj && (Array.isArray(answerObj.tradeoffs) || answerObj.tradeoffs_detail || answerObj.tradeoffsDetail)) return answerObj;
        return structured || answerObj;
      })();

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
        const origRisk = Array.isArray(orig.evidence?.science?.risk_notes) ? orig.evidence.science.risk_notes : [];
        const dupRisk = Array.isArray(dup.evidence?.science?.risk_notes) ? dup.evidence.science.risk_notes : [];

        const barrierRaw = profileSummary && typeof profileSummary.barrierStatus === 'string' ? profileSummary.barrierStatus.trim().toLowerCase() : '';
        const barrierImpaired = barrierRaw === 'impaired' || barrierRaw === 'damaged';

        const ingredientSignals = (items) => {
          const out = {
            occlusives: [],
            humectants: [],
            soothing: [],
            exfoliants: [],
            brightening: [],
            peptides: [],
            fragrance: [],
            alcohol: [],
          };

          const seen = new Set();
          const add = (k, v) => {
            const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
            if (!s) return;
            const key = `${k}:${s.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            out[k].push(s);
          };

          for (const raw of Array.isArray(items) ? items : []) {
            const s = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
            if (!s) continue;
            const n = s.toLowerCase();

            // Ignore trivial carriers.
            if (n === 'water' || n === 'aqua') continue;

            if (
              n.includes('petrolatum') ||
              n.includes('petroleum jelly') ||
              n.includes('mineral oil') ||
              n.includes('paraffin') ||
              n.includes('dimethicone') ||
              n.includes('lanolin') ||
              n.includes('wax') ||
              n.includes('beeswax') ||
              n.includes('shea butter') ||
              n.includes('cocoa butter')
            ) {
              add('occlusives', s);
            }

            if (
              n.includes('glycerin') ||
              n.includes('hyaluronic') ||
              n.includes('sodium hyaluronate') ||
              n.includes('panthenol') ||
              n.includes('urea') ||
              n.includes('betaine') ||
              n.includes('sodium pca') ||
              n.includes('trehalose') ||
              n.includes('propanediol') ||
              n.includes('butylene glycol') ||
              n.includes('sorbitol')
            ) {
              add('humectants', s);
            }

            if (
              n.includes('panthenol') ||
              n.includes('allantoin') ||
              n.includes('madecassoside') ||
              n.includes('centella') ||
              n.includes('ceramide') ||
              n.includes('cholesterol') ||
              n.includes('beta-glucan') ||
              n.includes('cica')
            ) {
              add('soothing', s);
            }

            if (
              n.includes('glycolic') ||
              n.includes('lactic') ||
              n.includes('mandelic') ||
              n.includes('salicylic') ||
              n.includes('gluconolactone') ||
              n.includes('pha') ||
              n.includes('bha') ||
              n.includes('aha')
            ) {
              add('exfoliants', s);
            }

            if (
              n.includes('niacinamide') ||
              n.includes('tranexamic') ||
              n.includes('azelaic') ||
              n.includes('ascorbic') ||
              n.includes('vitamin c') ||
              n.includes('arbutin') ||
              n.includes('kojic') ||
              n.includes('licorice')
            ) {
              add('brightening', s);
            }

            if (n.includes('peptide')) add('peptides', s);

            if (
              n.includes('fragrance') ||
              n.includes('parfum') ||
              n.includes('essential oil') ||
              n.includes('limonene') ||
              n.includes('linalool') ||
              n.includes('citral')
            ) {
              add('fragrance', s);
            }

            if (n.includes('alcohol denat') || n.includes('denatured alcohol')) add('alcohol', s);
          }

          return out;
        };

        const pickFew = (arr, max) => Array.from(new Set(Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : [])).slice(0, max);
        const joinFew = (arr, max) => pickFew(arr, max).join(', ');
        const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

        const origSig = ingredientSignals(origKeys);
        const dupSig = ingredientSignals(dupKeys);

        const tradeoffs = [];
        if (nonEmpty(origSig.occlusives) && !nonEmpty(dupSig.occlusives) && nonEmpty(dupSig.humectants)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `质地/封闭性：原产品更偏封闭锁水（例如 ${joinFew(origSig.occlusives, 2)}）；平替更偏补水（例如 ${joinFew(dupSig.humectants, 2)}）→ 通常更清爽，但可能需要叠加面霜来“锁水”。`
              : `Texture/finish: Original is more occlusive (e.g., ${joinFew(origSig.occlusives, 2)}) while the dupe is more humectant (e.g., ${joinFew(dupSig.humectants, 2)}) → lighter feel, but may need a moisturizer on top to seal.`,
          );
        } else if (nonEmpty(origSig.occlusives) && nonEmpty(dupSig.occlusives)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `共同点：两者都含封闭/油脂类成分（原：${joinFew(origSig.occlusives, 2)}；平替：${joinFew(dupSig.occlusives, 2)}）→ 都可能偏“锁水/滋润”，差异更多来自比例与配方。`
              : `Shared: Both include occlusive/emollient components (orig: ${joinFew(origSig.occlusives, 2)}; dupe: ${joinFew(dupSig.occlusives, 2)}) → both can be “sealing”; differences may come from formula balance.`,
          );
        }

        if (nonEmpty(origSig.humectants) && nonEmpty(dupSig.humectants) && tradeoffs.length < 2) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `共同点：两者都含常见保湿成分（原：${joinFew(origSig.humectants, 2)}；平替：${joinFew(dupSig.humectants, 2)}）→ 都能提升含水量，但“锁水力度”仍取决于封闭类成分。`
              : `Shared: Both include humectants (orig: ${joinFew(origSig.humectants, 2)}; dupe: ${joinFew(dupSig.humectants, 2)}) → both support hydration; how “sealing” it feels depends on occlusives.`,
          );
        }

        if (nonEmpty(dupSig.exfoliants)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `刺激风险：平替含去角质类成分（例如 ${joinFew(dupSig.exfoliants, 2)}）→ ${barrierImpaired ? '屏障受损时更容易不耐受，建议低频' : '更易刺激，建议低频'}，不要叠加强活性。`
              : `Irritation risk: Dupe includes exfoliant-like actives (e.g., ${joinFew(dupSig.exfoliants, 2)}) → ${barrierImpaired ? 'higher irritation risk if your barrier is impaired; start low' : 'higher irritation risk; start low'}, avoid stacking strong actives.`,
          );
        }

        if (nonEmpty(dupSig.fragrance) && !nonEmpty(origSig.fragrance)) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `气味/敏感风险：平替可能含香精/香料相关成分（例如 ${joinFew(dupSig.fragrance, 1)}）→ 更敏感人群需要谨慎。`
              : `Fragrance risk: Dupe may include fragrance-related ingredients (e.g., ${joinFew(dupSig.fragrance, 1)}) → higher risk for sensitive skin.`,
          );
        }

        const addedRisks = dupRisk.filter((k) => !origRisk.includes(k));
        if (addedRisks.length) {
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `平替风险提示：${addedRisks.slice(0, 2).join(' · ')}`
              : `Dupe risk notes: ${addedRisks.slice(0, 2).join(' · ')}`,
          );
        }

        if (!tradeoffs.length) {
          const origPreview = pickFew([...origSig.occlusives, ...origSig.humectants, ...origSig.soothing, ...origSig.brightening, ...origSig.exfoliants], 3);
          const dupPreview = pickFew([...dupSig.occlusives, ...dupSig.humectants, ...dupSig.soothing, ...dupSig.brightening, ...dupSig.exfoliants], 3);
          tradeoffs.push(
            ctx.lang === 'CN'
              ? `关键成分侧重（简要）：原产品—${origPreview.length ? origPreview.join(' / ') : '未知'}；平替—${dupPreview.length ? dupPreview.join(' / ') : '未知'}。`
              : `Key ingredient emphasis (brief): original — ${origPreview.length ? origPreview.join(' / ') : 'unknown'}; dupe — ${dupPreview.length ? dupPreview.join(' / ') : 'unknown'}.`,
          );
        }

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

      const mappedFromOriginalAlts =
        originalStructured && originalStructured.alternatives
          ? mapAuroraAlternativesToDupeCompare(originalStructured, dupeAnchor, {
            fallbackAnalyze,
            originalAnchorFallback: originalAnchor,
          })
          : null;

      const mapped = (() => {
        // Prefer structured.alternatives (when present) because it yields stable similarity/tradeoffs.
        if (mappedFromOriginalAlts && Array.isArray(mappedFromOriginalAlts.tradeoffs) && mappedFromOriginalAlts.tradeoffs.length) {
          return mappedFromOriginalAlts;
        }
        if (compareStructured) {
          if (compareStructured.alternatives) {
            return mapAuroraAlternativesToDupeCompare(compareStructured, dupeAnchor, {
              fallbackAnalyze,
              originalAnchorFallback: originalAnchor,
            });
          }
          return compareStructured;
        }
        if (mappedFromOriginalAlts) return mappedFromOriginalAlts;
        return fallbackAnalyze();
      })();

      const norm = normalizeDupeCompare(mapped);
      let payload = norm.payload;
      let field_missing = norm.field_missing;
      if (!payload.original && originalAnchor) payload = { ...payload, original: originalAnchor };
      if (!payload.dupe && dupeAnchor) payload = { ...payload, dupe: dupeAnchor };

      const uniqStrings = (arr) => {
        const out = [];
        const seen = new Set();
        for (const v of Array.isArray(arr) ? arr : []) {
          const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
          if (!s) continue;
          if (seen.has(s)) continue;
          seen.add(s);
          out.push(s);
        }
        return out;
      };

      const isMissingTradeoffs = !Array.isArray(payload.tradeoffs) || payload.tradeoffs.length === 0;
      if (isMissingTradeoffs) {
        const deepScanQuery = (input) => (
          `${analyzePrefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
          `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
          `Evidence must include science/social_signals/expert_notes.\n` +
          `Product: ${input}`
        );

        const scanOne = async ({ productText, productObj, productUrl }) => {
          const anchorId = extractAnchorIdFromProductLike(productObj);
          const bestText = String(productText || '').trim() || (anchorId ? String(anchorId) : '');
          if (!bestText) return null;
          let upstream = null;
          try {
            upstream = await auroraChat({
              baseUrl: AURORA_DECISION_BASE_URL,
              query: deepScanQuery(bestText),
              timeoutMs: 12000,
              ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
              ...(productUrl ? { anchor_product_url: productUrl } : {}),
            });
          } catch (err) {
            return null;
          }

          const upStructured = upstream && upstream.structured && typeof upstream.structured === 'object' && !Array.isArray(upstream.structured)
            ? upstream.structured
            : null;
          const upAnswerJson =
            upstream && typeof upstream.answer === 'string'
              ? extractJsonObjectByKeys(upstream.answer, [
                'assessment',
                'evidence',
                'confidence',
                'missing_info',
                'missingInfo',
                'analyze',
                'verdict',
                'reasons',
                'science_evidence',
                'social_signals',
                'expert_notes',
              ])
              : null;
          const upAnswerObj = upAnswerJson && typeof upAnswerJson === 'object' && !Array.isArray(upAnswerJson) ? upAnswerJson : null;
          const answerLooksLikeProductAnalysis =
            upAnswerObj &&
            (upAnswerObj.assessment != null ||
              upAnswerObj.evidence != null ||
              upAnswerObj.analyze != null ||
              upAnswerObj.confidence != null ||
              upAnswerObj.missing_info != null ||
              upAnswerObj.missingInfo != null);
          const structuredOrJson =
            upStructured && upStructured.analyze && typeof upStructured.analyze === 'object'
              ? upStructured
              : answerLooksLikeProductAnalysis
                ? upAnswerObj
                : upStructured || upAnswerObj;

          const mappedAnalyze = structuredOrJson && structuredOrJson.analyze && typeof structuredOrJson.analyze === 'object'
            ? mapAuroraProductAnalysis(structuredOrJson)
            : structuredOrJson;
          let normAnalyze = normalizeProductAnalysis(mappedAnalyze);

          if (!normAnalyze.payload.assessment && profileSummary && bestText) {
            // Retry without personalized context if upstream dropped the analysis.
            try {
              const minimalPrefix = buildContextPrefix({
                lang: ctx.lang,
                state: ctx.state || 'idle',
                trigger_source: ctx.trigger_source,
                intent: 'product_analyze_fallback',
                action_id: 'chip.action.analyze_product_fallback',
              });
              const minimalQuery =
                `${minimalPrefix}Task: Deep-scan this product for suitability vs the user's profile.\n` +
                `Return ONLY a JSON object with keys: assessment, evidence, confidence (0..1), missing_info (string[]).\n` +
                `Evidence must include science/social_signals/expert_notes.\n` +
                `Product: ${bestText}`;
              const upstream2 = await auroraChat({
                baseUrl: AURORA_DECISION_BASE_URL,
                query: minimalQuery,
                timeoutMs: 10000,
                ...(anchorId ? { anchor_product_id: String(anchorId) } : {}),
                ...(productUrl ? { anchor_product_url: productUrl } : {}),
              });
              const structured2 = upstream2 && upstream2.structured && typeof upstream2.structured === 'object' && !Array.isArray(upstream2.structured)
                ? upstream2.structured
                : null;
              const answer2 =
                upstream2 && typeof upstream2.answer === 'string'
                  ? extractJsonObjectByKeys(upstream2.answer, [
                    'assessment',
                    'evidence',
                    'confidence',
                    'missing_info',
                    'missingInfo',
                    'analyze',
                    'verdict',
                    'reasons',
                    'science_evidence',
                    'social_signals',
                    'expert_notes',
                  ])
                  : null;
              const structuredOrJson2 =
                structured2 && structured2.analyze && typeof structured2.analyze === 'object'
                  ? structured2
                  : answer2 && typeof answer2 === 'object' && !Array.isArray(answer2)
                    ? answer2
                    : structured2 || answer2;
              const mapped2 = structuredOrJson2 && structuredOrJson2.analyze && typeof structuredOrJson2.analyze === 'object'
                ? mapAuroraProductAnalysis(structuredOrJson2)
                : structuredOrJson2;
              const norm2 = normalizeProductAnalysis(mapped2);
              if (norm2 && norm2.payload && norm2.payload.assessment) {
                const missingInfo = Array.isArray(norm2.payload.missing_info) ? norm2.payload.missing_info : [];
                normAnalyze = {
                  payload: { ...norm2.payload, missing_info: Array.from(new Set([...missingInfo, 'profile_context_dropped_for_reliability'])) },
                  field_missing: norm2.field_missing,
                };
              }
            } catch {
              // ignore
            }
          }

          const enriched = enrichProductAnalysisPayload(normAnalyze.payload, { lang: ctx.lang });
          return { payload: enriched, field_missing: normAnalyze.field_missing };
        };

        const [origScan, dupeScan] = await Promise.all([
          scanOne({ productText: originalText, productObj: originalAnchor, productUrl: parsed.data.original_url }),
          scanOne({ productText: dupeText, productObj: dupeAnchor, productUrl: parsed.data.dupe_url }),
        ]);

        const origPayload = origScan && origScan.payload && typeof origScan.payload === 'object' ? origScan.payload : null;
        const dupePayload = dupeScan && dupeScan.payload && typeof dupeScan.payload === 'object' ? dupeScan.payload : null;

        const extractEvidence = (p) => {
          const ev = p && typeof p === 'object' ? p.evidence : null;
          const sci = ev && typeof ev === 'object' ? ev.science : null;
          const soc = ev && typeof ev === 'object' ? (ev.social_signals || ev.socialSignals) : null;
          return {
            key: uniqStrings(sci && Array.isArray(sci.key_ingredients || sci.keyIngredients) ? (sci.key_ingredients || sci.keyIngredients) : []),
            mech: uniqStrings(sci && Array.isArray(sci.mechanisms) ? sci.mechanisms : []),
            fit: uniqStrings(sci && Array.isArray(sci.fit_notes || sci.fitNotes) ? (sci.fit_notes || sci.fitNotes) : []),
            risk: uniqStrings(sci && Array.isArray(sci.risk_notes || sci.riskNotes) ? (sci.risk_notes || sci.riskNotes) : []),
            pos: uniqStrings(soc && Array.isArray(soc.typical_positive || soc.typicalPositive) ? (soc.typical_positive || soc.typicalPositive) : []),
            neg: uniqStrings(soc && Array.isArray(soc.typical_negative || soc.typicalNegative) ? (soc.typical_negative || soc.typicalNegative) : []),
            expert: uniqStrings(ev && Array.isArray(ev.expert_notes || ev.expertNotes) ? (ev.expert_notes || ev.expertNotes) : []),
            missing: uniqStrings(ev && Array.isArray(ev.missing_info || ev.missingInfo) ? (ev.missing_info || ev.missingInfo) : []),
            conf: ev && typeof ev.confidence === 'number' ? ev.confidence : null,
          };
        };

        const origEv = extractEvidence(origPayload);
        const dupEv = extractEvidence(dupePayload);

        const isCn = ctx.lang === 'CN';

        const ingredientSignals = (items) => {
          const out = {
            occlusives: [],
            humectants: [],
            soothing: [],
            exfoliants: [],
            brightening: [],
            peptides: [],
            fragrance: [],
            alcohol: [],
          };

          const seen = new Set();
          const add = (k, v) => {
            const s = typeof v === 'string' ? v.trim() : String(v || '').trim();
            if (!s) return;
            const key = `${k}:${s.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            out[k].push(s);
          };

          for (const raw of Array.isArray(items) ? items : []) {
            const s = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
            if (!s) continue;
            const n = s.toLowerCase();

            // Ignore trivial carriers.
            if (n === 'water' || n === 'aqua') continue;

            if (
              n.includes('petrolatum') ||
              n.includes('petroleum jelly') ||
              n.includes('mineral oil') ||
              n.includes('paraffin') ||
              n.includes('dimethicone') ||
              n.includes('lanolin') ||
              n.includes('wax') ||
              n.includes('beeswax') ||
              n.includes('shea butter') ||
              n.includes('cocoa butter')
            ) {
              add('occlusives', s);
            }

            if (
              n.includes('glycerin') ||
              n.includes('hyaluronic') ||
              n.includes('sodium hyaluronate') ||
              n.includes('panthenol') ||
              n.includes('urea') ||
              n.includes('betaine') ||
              n.includes('sodium pca') ||
              n.includes('trehalose') ||
              n.includes('propanediol') ||
              n.includes('butylene glycol') ||
              n.includes('sorbitol')
            ) {
              add('humectants', s);
            }

            if (
              n.includes('panthenol') ||
              n.includes('allantoin') ||
              n.includes('madecassoside') ||
              n.includes('centella') ||
              n.includes('ceramide') ||
              n.includes('cholesterol') ||
              n.includes('beta-glucan') ||
              n.includes('cica')
            ) {
              add('soothing', s);
            }

            if (
              n.includes('glycolic') ||
              n.includes('lactic') ||
              n.includes('mandelic') ||
              n.includes('salicylic') ||
              n.includes('gluconolactone') ||
              n.includes('pha') ||
              n.includes('bha') ||
              n.includes('aha')
            ) {
              add('exfoliants', s);
            }

            if (
              n.includes('niacinamide') ||
              n.includes('tranexamic') ||
              n.includes('azelaic') ||
              n.includes('ascorbic') ||
              n.includes('vitamin c') ||
              n.includes('arbutin') ||
              n.includes('kojic') ||
              n.includes('licorice')
            ) {
              add('brightening', s);
            }

            if (n.includes('peptide')) add('peptides', s);

            if (
              n.includes('fragrance') ||
              n.includes('parfum') ||
              n.includes('essential oil') ||
              n.includes('limonene') ||
              n.includes('linalool') ||
              n.includes('citral')
            ) {
              add('fragrance', s);
            }

            if (n.includes('alcohol denat') || n.includes('denatured alcohol')) add('alcohol', s);
          }

          return out;
        };

        const pickFew = (arr, max) => uniqStrings(arr).slice(0, max);
        const joinFew = (arr, max) => pickFew(arr, max).join(', ');
        const nonEmpty = (arr) => Array.isArray(arr) && arr.length > 0;

        const origSig = ingredientSignals(origEv.key);
        const dupSig = ingredientSignals(dupEv.key);

        const derivedTradeoffs = [];

        // More human, high-signal comparisons (avoid dumping full INCI).
        if (nonEmpty(origSig.occlusives) && !nonEmpty(dupSig.occlusives) && nonEmpty(dupSig.humectants)) {
          derivedTradeoffs.push(
            isCn
              ? `质地/封闭性：原产品更偏封闭锁水（例如 ${joinFew(origSig.occlusives, 2)}）；平替更偏补水（例如 ${joinFew(dupSig.humectants, 2)}）→ 通常更清爽，但可能需要叠加面霜来“锁水”。`
              : `Texture/finish: Original is more occlusive (e.g., ${joinFew(origSig.occlusives, 2)}) while the dupe is more humectant (e.g., ${joinFew(dupSig.humectants, 2)}) → lighter feel, but may need a moisturizer on top to seal.`,
          );
        } else if (nonEmpty(dupSig.occlusives) && !nonEmpty(origSig.occlusives) && nonEmpty(origSig.humectants)) {
          derivedTradeoffs.push(
            isCn
              ? `质地/封闭性：平替更偏封闭锁水（例如 ${joinFew(dupSig.occlusives, 2)}）；原产品更偏补水（例如 ${joinFew(origSig.humectants, 2)}）→ 平替通常更厚重、更“锁水”。`
              : `Texture/finish: Dupe is more occlusive (e.g., ${joinFew(dupSig.occlusives, 2)}) while the original is more humectant (e.g., ${joinFew(origSig.humectants, 2)}) → dupe may feel richer and more sealing.`,
          );
        } else if (nonEmpty(origSig.occlusives) && nonEmpty(dupSig.occlusives)) {
          derivedTradeoffs.push(
            isCn
              ? `共同点：两者都含封闭/油脂类成分（原：${joinFew(origSig.occlusives, 2)}；平替：${joinFew(dupSig.occlusives, 2)}）→ 都可能偏“锁水/滋润”，差异更多来自比例与配方。`
              : `Shared: Both include occlusive/emollient components (orig: ${joinFew(origSig.occlusives, 2)}; dupe: ${joinFew(dupSig.occlusives, 2)}) → both can be “sealing”; differences may come from formula balance.`,
          );
        }

        if (nonEmpty(origSig.humectants) && nonEmpty(dupSig.humectants) && derivedTradeoffs.length < 2) {
          derivedTradeoffs.push(
            isCn
              ? `共同点：两者都含常见保湿成分（原：${joinFew(origSig.humectants, 2)}；平替：${joinFew(dupSig.humectants, 2)}）→ 都能提升含水量，但“锁水力度”仍取决于封闭类成分。`
              : `Shared: Both include humectants (orig: ${joinFew(origSig.humectants, 2)}; dupe: ${joinFew(dupSig.humectants, 2)}) → both support hydration; how “sealing” it feels depends on occlusives.`,
          );
        }

        if (nonEmpty(dupSig.exfoliants)) {
          derivedTradeoffs.push(
            isCn
              ? `刺激风险：平替含去角质类成分（例如 ${joinFew(dupSig.exfoliants, 2)}）→ 屏障受损/刺痛时更容易不耐受，建议低频、不要叠加强活性。`
              : `Irritation risk: Dupe includes exfoliant-like actives (e.g., ${joinFew(dupSig.exfoliants, 2)}) → higher irritation risk if your barrier is impaired; start low and avoid stacking strong actives.`,
          );
        }

        if (nonEmpty(dupSig.fragrance) && !nonEmpty(origSig.fragrance)) {
          derivedTradeoffs.push(
            isCn
              ? `气味/敏感风险：平替可能含香精/香料相关成分（例如 ${joinFew(dupSig.fragrance, 1)}）→ 更敏感人群需要谨慎。`
              : `Fragrance risk: Dupe may include fragrance-related ingredients (e.g., ${joinFew(dupSig.fragrance, 1)}) → higher risk for sensitive skin.`,
          );
        }

        const addedRisks = dupEv.risk.filter((k) => !origEv.risk.includes(k));
        if (addedRisks.length) {
          derivedTradeoffs.push(
            isCn
              ? `平替风险提示：${addedRisks.slice(0, 2).join(' · ')}`
              : `Dupe risk notes: ${addedRisks.slice(0, 2).join(' · ')}`,
          );
        }

        if (!derivedTradeoffs.length) {
          const origPreview = pickFew([...origSig.occlusives, ...origSig.humectants, ...origSig.soothing, ...origSig.brightening, ...origSig.exfoliants], 3);
          const dupPreview = pickFew([...dupSig.occlusives, ...dupSig.humectants, ...dupSig.soothing, ...dupSig.brightening, ...dupSig.exfoliants], 3);
          if (origPreview.length || dupPreview.length) {
            derivedTradeoffs.push(
              isCn
                ? `关键成分侧重（简要）：原产品—${origPreview.length ? origPreview.join(' / ') : '未知'}；平替—${dupPreview.length ? dupPreview.join(' / ') : '未知'}。`
                : `Key ingredient emphasis (brief): original — ${origPreview.length ? origPreview.join(' / ') : 'unknown'}; dupe — ${dupPreview.length ? dupPreview.join(' / ') : 'unknown'}.`,
            );
          }
        }

        const origHero = origPayload && origPayload.assessment && typeof origPayload.assessment === 'object'
          ? (origPayload.assessment.hero_ingredient || origPayload.assessment.heroIngredient)
          : null;
        const dupHero = dupePayload && dupePayload.assessment && typeof dupePayload.assessment === 'object'
          ? (dupePayload.assessment.hero_ingredient || dupePayload.assessment.heroIngredient)
          : null;
        if (origHero && dupHero && origHero.name && dupHero.name && String(origHero.name).toLowerCase() !== String(dupHero.name).toLowerCase()) {
          derivedTradeoffs.push(`Hero ingredient shift: ${origHero.name} → ${dupHero.name}`);
        }

        const outConfidence = typeof origEv.conf === 'number' && typeof dupEv.conf === 'number'
          ? (origEv.conf + dupEv.conf) / 2
          : (origEv.conf || dupEv.conf || null);

        const labelLines = (label, arr, max) => uniqStrings(arr).slice(0, max).map((x) => `${label}: ${x}`);

        const mergedEvidence = {
          science: {
            key_ingredients: uniqStrings([...origEv.key, ...dupEv.key]),
            mechanisms: uniqStrings([...origEv.mech, ...dupEv.mech]).slice(0, 8),
            fit_notes: uniqStrings([...labelLines('Original', origEv.fit, 3), ...labelLines('Dupe', dupEv.fit, 3)]),
            risk_notes: uniqStrings([...labelLines('Original', origEv.risk, 3), ...labelLines('Dupe', dupEv.risk, 3)]),
          },
          social_signals: {
            typical_positive: uniqStrings([...labelLines('Original', origEv.pos, 3), ...labelLines('Dupe', dupEv.pos, 3)]),
            typical_negative: uniqStrings([...labelLines('Original', origEv.neg, 3), ...labelLines('Dupe', dupEv.neg, 3)]),
            risk_for_groups: [],
          },
          expert_notes: uniqStrings([...labelLines('Original', origEv.expert, 2), ...labelLines('Dupe', dupEv.expert, 2)]),
          confidence: outConfidence,
          missing_info: uniqStrings(['tradeoffs_from_product_analyze_diff', ...origEv.missing, ...dupEv.missing]),
        };

        const origAnchorOut =
          (origPayload && origPayload.assessment && typeof origPayload.assessment === 'object'
            ? (origPayload.assessment.anchor_product || origPayload.assessment.anchorProduct)
            : null) || payload.original || null;
        const dupeAnchorOut =
          (dupePayload && dupePayload.assessment && typeof dupePayload.assessment === 'object'
            ? (dupePayload.assessment.anchor_product || dupePayload.assessment.anchorProduct)
            : null) || payload.dupe || null;

        if (derivedTradeoffs.length) {
          const rawOut = {
            original: origAnchorOut,
            dupe: dupeAnchorOut,
            ...(payload.similarity != null ? { similarity: payload.similarity } : {}),
            ...(payload.tradeoffs_detail ? { tradeoffs_detail: payload.tradeoffs_detail } : {}),
            tradeoffs: derivedTradeoffs.slice(0, 6),
            evidence: mergedEvidence,
            confidence: outConfidence,
            missing_info: uniqStrings([
              ...uniqStrings(payload.missing_info).filter((c) => c !== 'evidence_missing'),
              'compare_tradeoffs_missing_used_deepscan_diff',
            ]),
          };
          const norm2 = normalizeDupeCompare(rawOut);
          payload = norm2.payload;
          field_missing = mergeFieldMissing(field_missing.filter((x) => x && x.field !== 'tradeoffs'), norm2.field_missing);
          field_missing = mergeFieldMissing(field_missing, mergeFieldMissing(origScan && origScan.field_missing, dupeScan && dupeScan.field_missing));
        }
      }

      if (!Array.isArray(payload.tradeoffs) || payload.tradeoffs.length === 0) {
        const note =
          ctx.lang === 'CN'
            ? '上游未返回可用的取舍对比细节（仅能提供有限对比）。你可以提供平替的链接/完整名称，或从推荐的替代里选择再比对。'
            : 'No tradeoff details were returned (comparison is limited). Provide the dupe link/full name or pick from suggested alternatives to compare again.';
        payload = { ...payload, tradeoffs: [note] };
      }

      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `dupe_${ctx.request_id}`,
            type: 'dupe_compare',
            payload,
            ...(field_missing?.length ? { field_missing: field_missing.slice(0, 8) } : {}),
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

      const identity = await resolveIdentity(req, ctx);
      const profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }).catch(() => null);
      const recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7).catch(() => []);
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
    const profiler = createStageProfiler();
    profiler.skip('face', 'not_implemented');
    profiler.skip('skin_roi', 'not_implemented');
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
      profiler.start('quality', { kind: 'memory' });
      const identity = await resolveIdentity(req, ctx);
      try {
        profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId });
        recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);
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

      let profileSummary = summarizeProfileForContext(profile);
      const recentLogsSummary = Array.isArray(recentLogs) ? recentLogs.slice(0, 7) : [];
      const routineFromRequest = parsed.data.currentRoutine;

      if (routineFromRequest !== undefined) {
        // Best-effort persistence. Analysis should still proceed even if storage is unavailable.
        profile = { ...(profile || {}), currentRoutine: routineFromRequest };
        try {
          profile = await upsertProfileForIdentity(
            { auroraUid: identity.auroraUid, userId: identity.userId },
            { currentRoutine: routineFromRequest },
          );
        } catch (err) {
          logger?.warn({ err: err.code || err.message }, 'aurora bff: failed to persist current routine for analysis');
        }
        profileSummary = summarizeProfileForContext(profile);
      }

      const routineCandidate = routineFromRequest !== undefined ? routineFromRequest : profileSummary && profileSummary.currentRoutine;
      const hasRoutine = Boolean(
        routineCandidate != null &&
          (typeof routineCandidate === 'string'
            ? String(routineCandidate).trim().length > 0
            : Array.isArray(routineCandidate)
              ? routineCandidate.length > 0
              : typeof routineCandidate === 'object'
                ? Object.keys(routineCandidate).length > 0
                : false),
      );
      profiler.end('quality', { kind: 'memory', has_routine: hasRoutine, logs_n: recentLogsSummary.length });

      // "Dual input" policy: photos optional, routine strongly recommended.
      // Treat missing routine as low-confidence and fall back to a baseline when no other primary signals exist.
      const hasPrimaryInput = hasRoutine || recentLogsSummary.length > 0;

      const userRequestedPhoto = parsed.data.use_photo === true;
      const usePhoto = userRequestedPhoto && hasPrimaryInput;
      const analysisFieldMissing = [];
      let usedPhotos = false;
      let analysisSource = 'rule_based';

      let analysis = null;
      if (userRequestedPhoto && photosProvided && !hasPrimaryInput) {
        analysisFieldMissing.push({ field: 'analysis.used_photos', reason: 'routine_or_recent_logs_required' });
      }
      if (usePhoto) {
        const chosen = chooseVisionPhoto(passedPhotos);
        if (!chosen) {
          analysisFieldMissing.push({ field: 'photos', reason: 'no_passed_photo' });
        } else {
          let photoBytes = null;
          try {
            profiler.start('decode', { kind: 'photo_fetch', slot: chosen.slot_id });
            const resp = await fetchPhotoBytesFromPivotaBackend({ req, photoId: chosen.photo_id });
            if (resp && resp.ok) photoBytes = resp.buffer;
            else {
              analysisFieldMissing.push({
                field: 'analysis.used_photos',
                reason: resp && resp.reason ? resp.reason : 'photo_fetch_failed',
              });
            }
            profiler.end('decode', { kind: 'photo_fetch', ok: Boolean(photoBytes), bytes: photoBytes ? photoBytes.length : 0 });
          } catch (err) {
            analysisFieldMissing.push({
              field: 'analysis.used_photos',
              reason: 'photo_fetch_failed',
            });
            profiler.fail('decode', err, { kind: 'photo_fetch', slot: chosen.slot_id });
            logger?.warn({ err: err.message }, 'aurora bff: failed to fetch photo bytes');
          }

          if (photoBytes) {
            const vision = await runOpenAIVisionSkinAnalysis({
              imageBuffer: photoBytes,
              language: ctx.lang,
              profileSummary,
              recentLogsSummary,
              profiler,
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

      if (!analysis && hasPrimaryInput && AURORA_DECISION_BASE_URL && !USE_AURORA_BFF_MOCK) {
        const replyLanguage = ctx.lang === 'CN' ? 'Simplified Chinese' : 'English';
        const replyInstruction = ctx.lang === 'CN'
          ? '请只用简体中文回答，不要使用英文。'
          : 'IMPORTANT: Reply ONLY in English. Do not use Chinese.';

        const profileLine = `profile=${JSON.stringify(profileSummary || {})}`;
        const logsLine = recentLogsSummary.length ? `recent_logs=${JSON.stringify(recentLogsSummary)}` : '';
        const photoLine = `photos_provided=${photosProvided ? 'yes' : 'no'}; photo_qc=${photoQcParts.length ? photoQcParts.join(', ') : 'none'}; photos_accessible=no.`;
        let routineText = '';
        if (hasRoutine) {
          if (typeof routineCandidate === 'string') routineText = routineCandidate;
          else {
            try {
              routineText = JSON.stringify(routineCandidate);
            } catch {
              routineText = '';
            }
          }
        }
        const routineLine = routineText ? `current_routine=${routineText.slice(0, 6000)}` : '';

        const prompt =
          `${profileLine}\n` +
          `${logsLine ? `${logsLine}\n` : ''}` +
          `${routineLine ? `${routineLine}\n` : ''}` +
          `${photoLine}\n` +
          `Task: Provide a skin assessment that is honest about uncertainty and feels like a cautious dermatologist.\n` +
          `If current_routine is provided, also flag likely irritation/conflict risks and suggest minimal, safe adjustments (do NOT recommend new brands).\n\n` +
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
          `- DO NOT recommend specific products/brands (you may reference the user's own products if provided).\n` +
          `- Keep it concise: 4–6 features; strategy under 900 characters.\n` +
          `Language: ${replyLanguage}.\n` +
          `${replyInstruction}\n`;

        let upstream = null;
        try {
          upstream = await profiler.timeLlmCall({ provider: 'aurora', model: null, kind: 'skin_text' }, async () =>
            auroraChat({ baseUrl: AURORA_DECISION_BASE_URL, query: prompt, timeoutMs: 12000 }),
          );
        } catch (err) {
          logger?.warn({ err: err.message }, 'aurora bff: skin analysis upstream failed');
        }
        const answer = upstream && typeof upstream.answer === 'string' ? upstream.answer : '';
        const parsedObj = extractJsonObjectByKeys(answer, ['features', 'strategy', 'needs_risk_check']) || extractJsonObject(answer);
        analysis = normalizeSkinAnalysisFromLLM(parsedObj, { language: ctx.lang });
        if (analysis) analysisSource = 'aurora_text';
      }

      if (!analysis) {
        if (!hasPrimaryInput) {
          analysis = profiler.timeSync(
            'detector',
            () => buildLowConfidenceBaselineSkinAnalysis({ profile: profileSummary || profile, language: ctx.lang }),
            { kind: 'baseline_low_confidence' },
          );
          analysisSource = 'baseline_low_confidence';
        } else {
          analysis = profiler.timeSync(
            'detector',
            () => buildRuleBasedSkinAnalysis({ profile: profileSummary || profile, recentLogs, language: ctx.lang }),
            { kind: 'rule_based' },
          );
        }
      }

      if (analysis) {
        try {
          await saveLastAnalysisForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, { analysis, lang: ctx.lang });
        } catch (err) {
          logger?.warn({ err: err && err.message ? err.message : String(err) }, 'aurora bff: failed to persist last analysis');
        }
      }

      profiler.start('render', { kind: 'envelope' });
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [
          {
            card_id: `analysis_${ctx.request_id}`,
            type: 'analysis_summary',
            payload: {
              analysis,
              low_confidence: analysisSource === 'baseline_low_confidence',
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
      profiler.end('render', { kind: 'envelope' });

      const report = profiler.report();
      logger?.info(
        {
          kind: 'skin_analysis_profile',
          request_id: ctx.request_id,
          trace_id: ctx.trace_id,
          total_ms: report.total_ms,
          llm_summary: report.llm_summary,
          stages: report.stages,
        },
        'aurora bff: skin analysis profile',
      );
      logger?.info({ kind: 'metric', name: 'aurora.skin_analysis.total_ms', value: report.total_ms }, 'metric');

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
      const identity = await resolveIdentity(req, ctx);
      try {
        profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId });
        recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);
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

      const identity = await resolveIdentity(req, ctx);
      const updated = await upsertProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, parsed.data);

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
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'profile update failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to save profile.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'PROFILE_SAVE_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'PROFILE_SAVE_FAILED' })],
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

      const identity = await resolveIdentity(req, ctx);
      const saved = await upsertSkinLogForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, parsed.data);
      const recent = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);

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
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'tracker log failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to save tracker log.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'TRACKER_LOG_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'TRACKER_LOG_FAILED' })],
      });
      return res.status(status).json(envelope);
    }
  });

  app.get('/v1/tracker/recent', async (req, res) => {
    const ctx = buildRequestContext(req, {});
    try {
      requireAuroraUid(ctx);
      const days = req.query.days ? Number(req.query.days) : 7;
      const identity = await resolveIdentity(req, ctx);
      const recent = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, days);
      const envelope = buildEnvelope(ctx, {
        assistant_message: null,
        suggested_chips: [],
        cards: [{ card_id: `recent_${ctx.request_id}`, type: 'tracker_recent', payload: { days, logs: recent } }],
        session_patch: { recent_logs: recent, checkin_due: isCheckinDue(recent) },
        events: [makeEvent(ctx, 'tracker_loaded', { days })],
      });
      return res.json(envelope);
    } catch (err) {
      const { code, dbError, dbNotConfigured, dbSchemaError } = classifyStorageError(err);
      const status =
        err && typeof err.status === 'number' && Number.isFinite(err.status) && err.status >= 400 && err.status < 600
          ? err.status
          : dbError
            ? 503
            : 500;
      logger?.warn({ err: err?.message || String(err), code, status }, 'tracker recent failed');
      const envelope = buildEnvelope(ctx, {
        assistant_message:
          status >= 400 && status < 500
            ? makeAssistantMessage('Invalid request.')
            : makeAssistantMessage(dbError ? 'Storage is not ready yet. Please try again shortly.' : 'Failed to load tracker logs.'),
        suggested_chips: [],
        cards: [
          {
            card_id: `err_${ctx.request_id}`,
            type: 'error',
            payload: {
              error:
                status >= 400 && status < 500
                  ? err.code || 'BAD_REQUEST'
                  : dbNotConfigured
                    ? 'DB_NOT_CONFIGURED'
                    : dbSchemaError
                      ? 'DB_SCHEMA_NOT_READY'
                      : dbError
                        ? 'DB_UNAVAILABLE'
                        : 'TRACKER_LOAD_FAILED',
              ...(status >= 400 && status < 500 ? {} : code ? { code } : {}),
            },
          },
        ],
        session_patch: {},
        events: [makeEvent(ctx, 'error', { code: (status >= 400 && status < 500 ? err.code : code) || 'TRACKER_LOAD_FAILED' })],
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

      const identity = await resolveIdentity(req, ctx);

      // Best-effort context injection.
      let profile = null;
      let recentLogs = [];
      try {
        profile = await getProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId });
        recentLogs = await getRecentSkinLogsForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, 7);
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
            profile = await upsertProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, patchParsed.data);
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
      const debugHeader = req.get('X-Debug') ?? req.get('X-Aurora-Debug');
      const debugFromHeader = debugHeader == null ? undefined : coerceBoolean(debugHeader);
      const debugFromBody = typeof parsed.data.debug === 'boolean' ? parsed.data.debug : undefined;
      const debugUpstream = debugFromHeader ?? debugFromBody;
      const anchorProductId =
        typeof parsed.data.anchor_product_id === 'string' && parsed.data.anchor_product_id.trim()
          ? parsed.data.anchor_product_id.trim()
          : '';
      const anchorProductUrl =
        typeof parsed.data.anchor_product_url === 'string' && parsed.data.anchor_product_url.trim()
          ? parsed.data.anchor_product_url.trim()
          : '';
      const upstreamMessages = Array.isArray(parsed.data.messages) ? parsed.data.messages : null;

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
            profile = await upsertProfileForIdentity({ auroraUid: identity.auroraUid, userId: identity.userId }, { budgetTier: rawBudget });
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
        const { norm, upstreamDebug, alternativesDebug } = await generateProductRecommendations({
          ctx,
          profile,
          recentLogs,
          message,
          includeAlternatives,
          debug: debugUpstream,
          logger,
        });

        const hasRecs = Array.isArray(norm.payload.recommendations) && norm.payload.recommendations.length > 0;
        const nextState = hasRecs && stateChangeAllowed(ctx.trigger_source) ? 'S7_PRODUCT_RECO' : undefined;

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(
            hasRecs
              ? ctx.lang === 'CN'
                ? '我给你整理了几款可以直接开始的产品（见下方卡片）。'
                : 'I pulled a few products you can start with (see the card below).'
              : ctx.lang === 'CN'
                ? '我还没能从上游拿到可结构化的产品推荐结果。你可以先告诉我你想要的品类（例如：洁面/精华/面霜/防晒），我再继续。'
                : "I couldn't get a structured product recommendation from upstream yet. Tell me what category you want (cleanser / serum / moisturizer / sunscreen), and I’ll continue.",
          ),
          suggested_chips: [],
          cards: [
            {
              card_id: `reco_${ctx.request_id}`,
              type: 'recommendations',
              payload: norm.payload,
              ...(norm.field_missing?.length ? { field_missing: norm.field_missing.slice(0, 8) } : {}),
            },
            ...(debugUpstream && upstreamDebug
              ? [
                {
                  card_id: `aurora_debug_${ctx.request_id}`,
                  type: 'aurora_debug',
                  payload: upstreamDebug,
                },
                ...(alternativesDebug
                  ? [
                    {
                      card_id: `aurora_alt_debug_${ctx.request_id}`,
                      type: 'aurora_alt_debug',
                      payload: { items: alternativesDebug },
                    },
                  ]
                  : []),
              ]
              : []),
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
      if (looksLikeWeatherOrEnvironmentQuestion(message) && ctx.trigger_source === 'text') {
        const scenario = extractWeatherScenario(message);
        const envStressUi = buildEnvStressUiModelFromLocal({ profile, recentLogs, message, language: ctx.lang });
        const advice = buildWeatherAdviceMessage({ language: ctx.lang, scenario, profile });

        const lang = ctx.lang === 'CN' ? 'CN' : 'EN';
        const suggestedChips = [
          {
            chip_id: 'chip.start.routine',
            label: lang === 'CN' ? '生成雪天 AM/PM 护肤流程' : 'Build a snow-day AM/PM routine',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '帮我按雪天生成 AM/PM 护肤流程' : 'Build an AM/PM routine for snow-day conditions' },
          },
          {
            chip_id: 'chip.start.reco_products',
            label: lang === 'CN' ? '推荐雪天防护产品' : 'Recommend protective products',
            kind: 'quick_reply',
            data: { reply_text: lang === 'CN' ? '雪天我应该用什么类型的防护产品？' : 'What protective products should I use for snow-day conditions?' },
          },
        ];

        const envelope = buildEnvelope(ctx, {
          assistant_message: makeAssistantMessage(advice, 'markdown'),
          suggested_chips: suggestedChips,
          cards: envStressUi
            ? [{ card_id: `env_${ctx.request_id}`, type: 'env_stress', payload: envStressUi }]
            : [],
          session_patch: {},
          events: [makeEvent(ctx, 'value_moment', { kind: 'weather_advice', scenario })],
        });
        return res.json(envelope);
      }

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
        upstream = await auroraChat({
          baseUrl: AURORA_DECISION_BASE_URL,
          query,
          timeoutMs: 12000,
          debug: debugUpstream,
          ...(anchorProductId ? { anchor_product_id: anchorProductId } : {}),
          ...(anchorProductUrl ? { anchor_product_url: anchorProductUrl } : {}),
          ...(upstreamMessages && upstreamMessages.length ? { messages: upstreamMessages } : {}),
        });
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
      const derivedCards = [];
      const envStressActionRequested = typeof actionId === 'string' && /env[_-]?stress|environment[_-]?stress|weather|itinerary/i.test(actionId);
      const looksEnv = looksLikeWeatherOrEnvironmentQuestion(message);
      const wantsEnvStressCard = Boolean(debugUpstream) || envStressActionRequested || looksEnv;

      const isEnvStressCard = (card) => {
        if (!card || typeof card !== 'object') return false;
        const t = typeof card.type === 'string' ? card.type.trim().toLowerCase() : '';
        if (/^(env_stress|environment_stress|envstress|environmentstress)$/.test(t)) return true;
        if (t.includes('env') && t.includes('stress')) return true;
        const payload = card.payload && typeof card.payload === 'object' ? card.payload : null;
        const schema = payload && typeof payload.schema_version === 'string' ? payload.schema_version.trim() : '';
        if (schema === 'aurora.ui.env_stress.v1' || schema === 'aurora.env_stress.v1') return true;
        return false;
      };

      if (!wantsEnvStressCard && Array.isArray(cards) && cards.length) {
        const before = cards.length;
        cards = cards.filter((c) => !isEnvStressCard(c));
        if (before !== cards.length) fieldMissing.push({ field: 'cards.env_stress', reason: 'not_requested' });
      }

      let envStressUi = null;
      if (contextRaw) {
        const envStressRaw = isPlainObject(contextRaw.env_stress) ? contextRaw.env_stress : isPlainObject(contextRaw.envStress) ? contextRaw.envStress : null;
        envStressUi = buildEnvStressUiModelFromUpstream(envStressRaw, { language: ctx.lang });
      }
      if (!envStressUi && (envStressActionRequested || looksEnv)) {
        envStressUi = buildEnvStressUiModelFromLocal({ profile, recentLogs, message, language: ctx.lang });
      }
      if (envStressUi && wantsEnvStressCard) {
        derivedCards.push({
          card_id: `env_${ctx.request_id}`,
          type: 'env_stress',
          payload: envStressUi,
        });
      }

      if (contextRaw) {
        const conflictDetector = isPlainObject(contextRaw.conflict_detector)
          ? contextRaw.conflict_detector
          : isPlainObject(contextRaw.conflictDetector)
            ? contextRaw.conflictDetector
            : null;
        if (conflictDetector && typeof conflictDetector.safe === 'boolean') {
          derivedCards.push({
            card_id: `conflicts_${ctx.request_id}`,
            type: 'routine_simulation',
            payload: conflictDetector,
          });
          derivedCards.push({
            card_id: `heatmap_${ctx.request_id}`,
            type: 'conflict_heatmap',
            payload: { schema_version: 'aurora.ui.conflict_heatmap.v1' },
          });
        }
      }

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
      const structuredWithExternalVerification = mergeExternalVerificationIntoStructured(structured, contextRaw);

      const safeAnswer = sanitizeUpstreamAnswer(answer, {
        language: ctx.lang,
        hasCards: rawCards.length > 0,
        hasStructured: Boolean(structured && !structuredBlocked),
        stripInternalRefs: !debugUpstream,
      });

      const envelope = buildEnvelope(ctx, {
        assistant_message: makeAssistantMessage(safeAnswer, 'markdown'),
        suggested_chips: suggestedChips,
        cards: [
          ...(structuredWithExternalVerification && !structuredBlocked
            ? [{
              card_id: `structured_${ctx.request_id}`,
              type: 'aurora_structured',
              payload: structuredWithExternalVerification,
            }]
            : []),
          ...derivedCards,
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

const __internal = {
  runOpenAIVisionSkinAnalysis,
  buildLowConfidenceBaselineSkinAnalysis,
  buildRuleBasedSkinAnalysis,
  normalizeSkinAnalysisFromLLM,
};

module.exports = { mountAuroraBffRoutes, __internal };
