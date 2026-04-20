const crypto = require('node:crypto');

const { extractJsonObject, parseJsonOnlyObject } = require('./jsonExtract');
const {
  hasAuroraGeminiApiKey,
  callAuroraGeminiGenerateContentRestWithMeta,
  callAuroraGeminiGenerateContentWithMeta,
} = require('./auroraGeminiGlobalClient');
const { DEFAULT_TRAVEL_LLM_MODEL, __internal: travelLlmInternal } = require('./travelLlmCalibrator');
const { resolveNonImageGeminiModel } = require('../lib/geminiModelFloor');

const DEFAULT_TRAVEL_FINAL_REWRITE_MODEL = String(
  process.env.AURORA_TRAVEL_FINAL_REWRITE_MODEL ||
    process.env.AURORA_TRAVEL_LLM_MODEL ||
    DEFAULT_TRAVEL_LLM_MODEL ||
    'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview';

const DEFAULT_TRAVEL_FINAL_REWRITE_TRANSPORT = String(
  process.env.AURORA_TRAVEL_GEMINI_TRANSPORT || 'rest',
).trim().toLowerCase();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text) return '';
  return text.slice(0, maxLen);
}

function normalizeNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeLang(value) {
  return String(value || '').trim().toUpperCase() === 'CN' ? 'CN' : 'EN';
}

function normalizeTravelFinalRewriteModel(model) {
  return resolveNonImageGeminiModel({
    model: String(model || '').trim(),
    fallbackModel: 'gemini-3-flash-preview',
    envSource: 'AURORA_TRAVEL_FINAL_REWRITE_MODEL',
    callPath: 'aurora_travel_final_assistant_rewrite',
  }).effectiveModel;
}

function hashPromptPayload(value, tokenLen = 24) {
  const text = typeof value === 'string' ? value : String(value || '');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const len = Number.isFinite(Number(tokenLen)) ? Math.max(8, Math.min(64, Math.trunc(Number(tokenLen)))) : 24;
  return hash.slice(0, len);
}

function compactProfileForFinalRewrite(profile) {
  const p = isPlainObject(profile) ? profile : {};
  const goals = Array.isArray(p.goals) ? p.goals.map((v) => normalizeText(v, 80)).filter(Boolean).slice(0, 5) : [];
  return {
    ...(normalizeText(p.skinType || p.skin_type, 80) ? { skin_type: normalizeText(p.skinType || p.skin_type, 80) } : {}),
    ...(normalizeText(p.sensitivity, 80) ? { sensitivity: normalizeText(p.sensitivity, 80) } : {}),
    ...(normalizeText(p.barrierStatus || p.barrier_status, 80)
      ? { barrier_status: normalizeText(p.barrierStatus || p.barrier_status, 80) }
      : {}),
    ...(goals.length ? { goals } : {}),
    ...(normalizeText(p.currentRoutine || p.current_routine, 500)
      ? { current_routine: normalizeText(p.currentRoutine || p.current_routine, 500) }
      : {}),
    ...(normalizeText(p.skin_analysis_summary || p.skinAnalysisSummary, 500)
      ? { skin_analysis_summary: normalizeText(p.skin_analysis_summary || p.skinAnalysisSummary, 500) }
      : {}),
  };
}

function compactSafetyDecisionForFinalRewrite(safetyDecision) {
  const s = isPlainObject(safetyDecision) ? safetyDecision : null;
  if (!s) return null;
  const blockLevel = normalizeText(s.block_level || s.blockLevel, 40);
  const reasons = Array.isArray(s.reasons) ? s.reasons.map((line) => normalizeText(line, 220)).filter(Boolean).slice(0, 2) : [];
  const alternatives = Array.isArray(s.safe_alternatives)
    ? s.safe_alternatives.map((line) => normalizeText(line, 160)).filter(Boolean).slice(0, 2)
    : [];
  if (!blockLevel && !reasons.length && !alternatives.length) return null;
  return {
    ...(blockLevel ? { block_level: blockLevel } : {}),
    ...(reasons.length ? { reasons } : {}),
    ...(alternatives.length ? { safe_alternatives: alternatives } : {}),
  };
}

function compactStructuredSectionsForFinalRewrite(sections) {
  const src = isPlainObject(sections) ? sections : {};
  const pickLines = (key, maxItems, maxLen = 220) => (
    Array.isArray(src[key])
      ? src[key].map((line) => normalizeText(line, maxLen)).filter(Boolean).slice(0, maxItems)
      : []
  );
  return {
    key_deltas: pickLines('key_deltas', 4),
    routine_adjustments: pickLines('routine_adjustments', 4),
    jetlag_sleep: pickLines('jetlag_sleep', 3),
    flight_day_plan: pickLines('flight_day_plan', 3),
    active_handling: pickLines('active_handling', 3),
    phased_plan: pickLines('phased_plan', 3),
    travel_kit: pickLines('travel_kit', 8),
    product_guidance: pickLines('product_guidance', 6),
    troubleshooting: pickLines('troubleshooting', 3),
  };
}

function compactArrayRows(rows, mapper, maxItems = 6) {
  const out = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const mapped = typeof mapper === 'function' ? mapper(raw) : null;
    if (!mapped) continue;
    if (isPlainObject(mapped) && !Object.keys(mapped).length) continue;
    out.push(mapped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function compactTravelActionContextForFinalRewrite(travelReadiness) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  return {
    adaptive_actions: compactArrayRows(readiness.adaptive_actions, (raw) => {
      const row = isPlainObject(raw) ? raw : {};
      return {
        why: normalizeText(row.why, 220) || null,
        what_to_do: normalizeText(row.what_to_do || row.whatToDo, 260) || null,
      };
    }, 5),
    personal_focus: compactArrayRows(readiness.personal_focus, (raw) => {
      const row = isPlainObject(raw) ? raw : {};
      return {
        focus: normalizeText(row.focus, 100) || null,
        why: normalizeText(row.why, 220) || null,
        what_to_do: normalizeText(row.what_to_do || row.whatToDo, 260) || null,
      };
    }, 4),
    travel_kit_plan: compactArrayRows(readiness.reco_bundle, (raw) => {
      const row = isPlainObject(raw) ? raw : {};
      const productTypes = Array.isArray(row.product_types)
        ? row.product_types.map((value) => normalizeText(value, 90)).filter(Boolean).slice(0, 4)
        : [];
      return {
        trigger: normalizeText(row.trigger, 90) || null,
        action: normalizeText(row.action, 260) || null,
        ingredient_logic: normalizeText(row.ingredient_logic, 260) || null,
        product_types: productTypes,
        reapply_rule: normalizeText(row.reapply_rule, 180) || null,
      };
    }, 8),
    best_practice_principles: [
      'Keep travel skincare close to the at-home routine; avoid introducing unfamiliar actives right before or during travel.',
      'Use moisturizer when skin feels dry and after cleansing; cabin air and climate shifts can increase barrier stress.',
      'Use broad-spectrum sunscreen and reapply during outdoor exposure; include exposed body areas, lips, and hands when relevant.',
      'Use hydrating or soothing masks as optional recovery support only when already tolerated; avoid making them sound medically necessary.',
    ],
  };
}

function compactShoppingForFinalRewrite(travelReadiness) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  const shopping = isPlainObject(readiness.shopping_preview) ? readiness.shopping_preview : {};
  const products = Array.isArray(shopping.products) ? shopping.products : [];
  const inferredGroundedCount = products.filter((row) => {
    const product = isPlainObject(row) ? row : {};
    return (
      product.is_grounded === true ||
      normalizeText(product.product_source || product.productSource, 80).toLowerCase() === 'catalog' ||
      normalizeText(product.match_status || product.matchStatus, 80).toLowerCase() === 'catalog_verified'
    );
  }).length;
  return {
    ...(normalizeText(shopping.mode, 80) ? { mode: normalizeText(shopping.mode, 80) } : {}),
    ...(normalizeText(shopping.coverage_status || shopping.coverageStatus, 80)
      ? { coverage_status: normalizeText(shopping.coverage_status || shopping.coverageStatus, 80) }
      : {}),
    ...(normalizeNumber(shopping.grounded_count || shopping.groundedCount) != null || inferredGroundedCount > 0
      ? { grounded_count: normalizeNumber(shopping.grounded_count || shopping.groundedCount) ?? inferredGroundedCount }
      : {}),
    products: products.slice(0, 8).map((row) => {
      const product = isPlainObject(row) ? row : {};
      return {
        name: normalizeText(product.name, 120) || null,
        brand: normalizeText(product.brand, 80) || null,
        category: normalizeText(product.category, 80) || null,
        reasons: Array.isArray(product.reasons)
          ? product.reasons.map((line) => normalizeText(line, 140)).filter(Boolean).slice(0, 3)
          : [],
        price: normalizeNumber(product.price),
        currency: normalizeText(product.currency, 12) || null,
        product_source: normalizeText(product.product_source || product.productSource, 80) || null,
        display_mode: normalizeText(product.display_mode || product.displayMode, 80) || null,
        product_id: normalizeText(product.product_id || product.productId, 120) || null,
      };
    }).filter((row) => row.name),
    ...(Array.isArray(shopping.buying_channels) && shopping.buying_channels.length
      ? { buying_channels: shopping.buying_channels.map((v) => normalizeText(v, 80)).filter(Boolean).slice(0, 6) }
      : {}),
  };
}

function buildFinalRewritePromptInput({
  message,
  language,
  profile,
  travelReadiness,
  structuredSections,
  deterministicBrief,
  safetyDecision,
} = {}) {
  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {};
  return {
    language: normalizeLang(language),
    user_question: normalizeText(message, 800),
    profile: compactProfileForFinalRewrite(profile),
    travel_readiness: travelLlmInternal.compactTravelReadinessForPrompt(readiness),
    travel_action_context: compactTravelActionContextForFinalRewrite(readiness),
    structured_sections: compactStructuredSectionsForFinalRewrite(structuredSections),
    shopping: compactShoppingForFinalRewrite(readiness),
    safety: compactSafetyDecisionForFinalRewrite(safetyDecision),
    deterministic_brief: normalizeText(deterministicBrief, 1000),
  };
}

function buildTravelFinalRewritePrompts(input) {
  const promptInput = buildFinalRewritePromptInput(input);
  const lang = normalizeLang(promptInput.language);
  const shopping = isPlainObject(promptInput.shopping) ? promptInput.shopping : {};
  const coverageStatus = normalizeText(shopping.coverage_status, 80).toLowerCase();
  const shoppingMode = normalizeText(shopping.mode, 80).toLowerCase();
  const groundedCount = normalizeNumber(shopping.grounded_count) || 0;
  const categoryOnly =
    coverageStatus === 'category_only' ||
    shoppingMode === 'category_guidance' ||
    (!groundedCount && Array.isArray(shopping.products) && shopping.products.length > 0);
  const hasSafety = Boolean(promptInput.safety && Object.keys(promptInput.safety).length);

  const systemPrompt = [
    'You are Aurora, a senior travel skincare advisor writing the final user-facing answer.',
    'Use only the provided structured facts. Do not invent weather, dates, locations, products, stores, prices, clinical claims, or availability.',
    'Do not expose internal payload terms, fallback labels, source tiers, or debug wording.',
    'Do not use absolute marketing words: best, most, perfect, guaranteed, must-have, miracle, holy grail.',
    'Avoid over-strong clinical or marketing phrasing such as essential, critical, extreme, severe, or boost UV protection; prefer supports, helps, useful, or good category to review.',
    'Do not use these headings or phrases: Risk note, Practical alternatives, Suggested products, Daily forecast, Key deltas, Travel skincare kit, Source, rule_fallback.',
    'Write a concise plan that feels like an advisor synthesized the trip, not a dump of every payload field.',
    'Keep it under 2400 characters, with at most 5 short sections and at most 12 bullets total.',
    'Must explain the actual climate delta first: temperature, humidity, UV, precipitation/wind when provided, then state the skin implication rather than just reporting weather.',
    'Must cover skincare substance: before departure, flight/cabin, first 48 hours after arrival, face care, exposed body, lip, and hand care when those are present in the facts, and local buying guidance.',
    'For every product category or grounded product you mention, include a concrete reason tied to climate, flight, skin profile, routine, or UV exposure.',
    'Flight guidance may mention hydrating/soothing masks only as optional recovery if tolerated; do not make masks sound mandatory or clinical.',
    'If category-only shopping is provided, call it product categories or buying categories; explicitly do not present them as grounded product picks and do not call any category essential.',
    'If grounded products are provided, name the provided brand/product options and explain why each category is relevant; do not invent missing local brands.',
    'Integrate safety context naturally into UV/actives guidance; do not prepend a separate safety block.',
    'End with one useful follow-up question only if it would materially improve product narrowing.',
    'Return strict JSON only: {"assistant_text":"..."}',
  ].join('\n');

  const userPrompt = [
    `language=${lang}`,
    categoryOnly ? 'Shopping status: category_only. Be honest that these are categories, not specific grounded products.' : '',
    !categoryOnly && groundedCount > 0 ? `Shopping status: grounded_products with ${groundedCount} catalog-grounded option(s).` : '',
    hasSafety ? 'Safety status: integrate safety advice naturally; no Risk note heading.' : '',
    'Task: rewrite the final travel skincare answer from the facts below. Preserve all numeric facts if mentioned, and use travel_action_context as the skincare mechanism backbone.',
    `Fact JSON:${JSON.stringify(promptInput)}`,
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt, promptInput };
}

function buildGeminiRequest({ model, systemPrompt, userPrompt } = {}) {
  return {
    model: normalizeTravelFinalRewriteModel(model || DEFAULT_TRAVEL_FINAL_REWRITE_MODEL),
    contents: [
      {
        role: 'user',
        parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }],
      },
    ],
    config: {
      temperature: 0.22,
      maxOutputTokens: 1150,
      responseMimeType: 'application/json',
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: 96,
      },
    },
  };
}

function withTimeout(promise, timeoutMs, timeoutCode = 'TRAVEL_FINAL_REWRITE_TIMEOUT') {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0;
  if (!ms) return promise;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode);
      err.code = timeoutCode;
      reject(err);
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseTravelFinalRewritePayload(text) {
  const parsed = parseJsonOnlyObject(text) || extractJsonObject(text);
  if (!isPlainObject(parsed)) return null;
  const assistantText = normalizeText(parsed.assistant_text || parsed.assistantText || parsed.text, 3000);
  if (!assistantText) return null;
  return { assistant_text: assistantText };
}

function stringifyForRewriteQuality(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_) {
    return '';
  }
}

function matchesAny(text, patterns) {
  const haystack = String(text || '');
  return patterns.some((pattern) => pattern.test(haystack));
}

function buildTravelRewriteQualityContext(promptInput) {
  const input = isPlainObject(promptInput) ? promptInput : {};
  const shopping = isPlainObject(input.shopping) ? input.shopping : {};
  const actionContext = isPlainObject(input.travel_action_context) ? input.travel_action_context : {};
  const actionContextWithoutPrinciples = {
    ...(Array.isArray(actionContext.adaptive_actions) ? { adaptive_actions: actionContext.adaptive_actions } : {}),
    ...(Array.isArray(actionContext.personal_focus) ? { personal_focus: actionContext.personal_focus } : {}),
    ...(Array.isArray(actionContext.travel_kit_plan) ? { travel_kit_plan: actionContext.travel_kit_plan } : {}),
  };
  const factsText = stringifyForRewriteQuality({
    profile: input.profile,
    travel_readiness: input.travel_readiness,
    travel_action_context: actionContext,
    structured_sections: input.structured_sections,
    shopping,
    safety: input.safety,
  });
  const actionText = stringifyForRewriteQuality({
    travel_action_context: actionContextWithoutPrinciples,
    structured_sections: input.structured_sections,
  });
  const coverageStatus = normalizeText(shopping.coverage_status, 80).toLowerCase();
  const shoppingMode = normalizeText(shopping.mode, 80).toLowerCase();
  const groundedCount = normalizeNumber(shopping.grounded_count) || 0;
  const hasCategoryRows = Array.isArray(shopping.products) && shopping.products.length > 0;
  return {
    factsText,
    actionText,
    hasClimateFacts: /delta_vs_|delta_vs_home|delta_vs_origin|forecast_window|temperature|humidity|uv|precip|wind/i.test(factsText),
    hasFlightOrJetlagFacts: /flight|cabin|boarding|jetlag|time.?zone|tz_|hours_diff|飞行|机舱|飞机|时差/i.test(factsText),
    needsUvCare: /uv|sunscreen|spf|sun protection|outdoor|reapply|防晒|紫外|补涂/i.test(factsText),
    needsBarrierHydration: /humidity|humid|dry|cabin|flight|moisturizer|barrier|hydrating|hydration|serum|cream|mask|保湿|补水|屏障|面霜|精华|面膜/i.test(factsText),
    needsMaskNuance: /mask|面膜/i.test(actionText),
    needsBodyCare: /\b(body|exposed areas|exposed skin|arms?)\b|身体|暴露部位|外露皮肤|手臂/i.test(actionText),
    needsLipCare: /\b(lip|lips|lip balm)\b|嘴唇|唇部|润唇/i.test(actionText),
    needsHandCare: /\b(hand|hands|hand cream)\b|手部|双手|护手/i.test(actionText),
    hasShoppingContext: Boolean(
      coverageStatus ||
      shoppingMode ||
      groundedCount > 0 ||
      hasCategoryRows ||
      (Array.isArray(shopping.buying_channels) && shopping.buying_channels.length)
    ),
    categoryOnly: coverageStatus === 'category_only' || shoppingMode === 'category_guidance' || (!groundedCount && hasCategoryRows),
  };
}

function validateTravelFinalRewriteText(text, { promptInput } = {}) {
  const assistantText = normalizeText(text, 3000);
  if (!assistantText) return { ok: false, reason: 'empty_rewrite' };
  if (assistantText.length < 180) return { ok: false, reason: 'rewrite_too_short' };
  if (assistantText.length > 2800) return { ok: false, reason: 'rewrite_too_long' };
  if (/(^|\n)\s*(Risk note|Practical alternatives|Suggested products|Daily forecast|Key deltas|Travel skincare kit|Adjusted routine guidance|How to handle actives|Source)\s*:/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_forbidden_heading' };
  }
  if (/rule_fallback|fallback_source|Products actually selected|Primary recommendation focus/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_internal_terms' };
  }
  if (/\b(best|most|perfect|guaranteed|must-have|miracle|holy grail)\b/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_absolute_wording' };
  }
  if (/\b(essential|critical|extreme|severe)\b/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_overstrong_wording' };
  }
  if (/\bboost(?:s|ing)?\s+(?:uv\s+)?protection\b/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_overstrong_uv_claim' };
  }
  if (/\.\.\.|…|\[truncated\]/i.test(assistantText)) {
    return { ok: false, reason: 'rewrite_truncated_or_ellipsis' };
  }

  const quality = buildTravelRewriteQualityContext(promptInput);
  if (quality.hasClimateFacts && !matchesAny(assistantText, [
    /\b(temperature|warmer|cooler|hotter|colder|humid|humidity|uv|precipitation|rain|wind|climate)\b/i,
    /(温度|更热|更冷|湿度|潮湿|紫外|降雨|下雨|风|气候)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_climate_delta' };
  }
  if (quality.hasFlightOrJetlagFacts && !matchesAny(assistantText, [
    /\b(flight|cabin|boarding|plane|airplane|jet lag|time zone|sleep)\b/i,
    /(飞行|机舱|飞机|登机|时差|睡眠)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_flight_or_jetlag_plan' };
  }
  if (quality.hasFlightOrJetlagFacts && !matchesAny(assistantText, [
    /\b(before departure|pre[- ]?trip|pack|boarding|first 48|arrival|after landing|on[- ]?site)\b/i,
    /(出发前|行前|提前|打包|登机|到达|抵达|落地|前48小时|前 48 小时)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_trip_phase_plan' };
  }
  if (quality.needsUvCare && !matchesAny(assistantText, [
    /\b(sunscreen|spf|uv|sun protection|reapply)\b/i,
    /(防晒|紫外|补涂)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_uv_care' };
  }
  if (quality.needsBarrierHydration && !matchesAny(assistantText, [
    /\b(moisturizer|moisturise|moisturize|barrier|hydrating|hydration|serum|cream)\b/i,
    /(保湿|补水|屏障|精华|面霜|乳液)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_barrier_hydration' };
  }
  if (quality.needsUvCare && !matchesAny(assistantText, [
    /\b(body|lip|lips|hand|hands|exposed areas|exposed skin)\b/i,
    /(身体|嘴唇|唇部|手部|双手|暴露部位|外露皮肤)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_body_lip_hand_care' };
  }
  if (quality.needsBodyCare && !matchesAny(assistantText, [
    /\b(body|exposed areas|exposed skin|exposed arms|arms)\b/i,
    /(身体|暴露部位|外露皮肤|手臂)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_body_care' };
  }
  if (quality.needsLipCare && !matchesAny(assistantText, [
    /\b(lip|lips|lip balm)\b/i,
    /(嘴唇|唇部|润唇)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_lip_care' };
  }
  if (quality.needsHandCare && !matchesAny(assistantText, [
    /\b(hand|hands|hand cream)\b/i,
    /(手部|双手|护手)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_hand_care' };
  }
  if (quality.needsMaskNuance && !matchesAny(assistantText, [
    /\b(mask|masks)\b/i,
    /(面膜)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_mask_guidance' };
  }
  if (quality.needsMaskNuance && !matchesAny(assistantText, [
    /\b(optional|if tolerated|already tolerated|already tolerate|familiar|not new|avoid new)\b/i,
    /(可选|耐受|用过|熟悉|不要新开|别新开)/i,
  ])) {
    return { ok: false, reason: 'rewrite_overstates_mask_guidance' };
  }
  if (quality.hasShoppingContext && !matchesAny(assistantText, [
    /\b(buy|buying|shopping|local|category|categories|store|pharmacy|retail|grounded product|product categories)\b/i,
    /(购买|当地|本地|品类|类别|门店|药房|药妆|专柜|有权威商品)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_local_buying_boundary' };
  }
  if (!matchesAny(assistantText, [
    /\b(because|so|which|helps|support|reduce|avoid|due to|ties to|for that reason)\b/i,
    /(因为|所以|帮助|支持|减少|避免|对应|原因)/i,
  ])) {
    return { ok: false, reason: 'rewrite_missing_reasoning_links' };
  }

  const shopping = isPlainObject(promptInput && promptInput.shopping) ? promptInput.shopping : {};
  const coverageStatus = normalizeText(shopping.coverage_status, 80).toLowerCase();
  const shoppingMode = normalizeText(shopping.mode, 80).toLowerCase();
  const groundedCount = normalizeNumber(shopping.grounded_count) || 0;
  const hasCategoryRows = Array.isArray(shopping.products) && shopping.products.length > 0;
  const categoryOnly = coverageStatus === 'category_only' || shoppingMode === 'category_guidance' || (!groundedCount && hasCategoryRows);
  if (
    categoryOnly &&
    /\b(specific product picks|grounded products|product recommendations|recommended products)\b/i.test(assistantText) &&
    !/\b(not|not confirmed|not grounded|not specific|rather than|instead of|category|categories)\b/i.test(assistantText) &&
    !/(不是|并非|不要当作|非确认|类别|品类)/i.test(assistantText)
  ) {
    return { ok: false, reason: 'rewrite_overstates_category_guidance' };
  }

  const safety = isPlainObject(promptInput && promptInput.safety) ? promptInput.safety : null;
  if (safety && Object.keys(safety).length) {
    if (!/(sunscreen|spf|uv|active|actives|retinoid|acid|防晒|活性)/i.test(assistantText)) {
      return { ok: false, reason: 'rewrite_missing_safety_integration' };
    }
  }
  return { ok: true, reason: 'ok' };
}

function normalizeErrorCode(err, fallback = 'TRAVEL_FINAL_REWRITE_ERROR') {
  const token = normalizeText(err && (err.code || err.message), 80);
  return token || fallback;
}

async function rewriteTravelAssistantTextWithLlm({
  geminiGenerateContent = null,
  language = 'EN',
  message = '',
  profile = null,
  travelReadiness = null,
  structuredSections = null,
  deterministicBrief = '',
  safetyDecision = null,
  timeoutMs = 5200,
  model = DEFAULT_TRAVEL_FINAL_REWRITE_MODEL,
  logger = null,
} = {}) {
  const stage = 'travel_final_assistant_rewrite_v1';
  const { systemPrompt, userPrompt, promptInput } = buildTravelFinalRewritePrompts({
    language,
    message,
    profile,
    travelReadiness,
    structuredSections,
    deterministicBrief,
    safetyDecision,
  });
  const promptHash = hashPromptPayload(`${systemPrompt}\n${userPrompt}`);
  const promptChars = `${systemPrompt}\n${userPrompt}`.length;
  const effectiveModel = normalizeTravelFinalRewriteModel(model || DEFAULT_TRAVEL_FINAL_REWRITE_MODEL);
  const request = buildGeminiRequest({ model: effectiveModel, systemPrompt, userPrompt });
  const hasGeminiClient =
    typeof geminiGenerateContent === 'function' ||
    hasAuroraGeminiApiKey('AURORA_TRAVEL_GEMINI_API_KEY');

  if (!hasGeminiClient) {
    return {
      stage,
      used: false,
      outcome: 'skip_no_client',
      reason: 'no_gemini_client',
      assistant_text: '',
      source_meta: {
        provider: 'gemini',
        model: effectiveModel,
        prompt_hash: promptHash,
        prompt_chars: promptChars,
        error_code: 'no_gemini_client',
      },
    };
  }

  try {
    const totalTimeoutMs = Math.max(1200, Math.trunc(Number(timeoutMs || 5200) || 5200));
    const queueTimeoutMs = Math.min(900, Math.max(200, Math.floor(totalTimeoutMs * 0.12)));
    const upstreamTimeoutMs = Math.max(1400, totalTimeoutMs - queueTimeoutMs);
    const realGeminiCaller =
      DEFAULT_TRAVEL_FINAL_REWRITE_TRANSPORT === 'sdk'
        ? callAuroraGeminiGenerateContentWithMeta
        : callAuroraGeminiGenerateContentRestWithMeta;
    const callResult = typeof geminiGenerateContent === 'function'
      ? {
          response: await withTimeout(
            geminiGenerateContent(request),
            totalTimeoutMs,
            'TRAVEL_FINAL_REWRITE_TIMEOUT',
          ),
          meta: {},
        }
      : await realGeminiCaller({
          featureEnvVar: 'AURORA_TRAVEL_GEMINI_API_KEY',
          route: 'aurora_travel_final_assistant_rewrite',
          request,
          queueTimeoutMs,
          upstreamTimeoutMs,
        });

    const responseMeta = travelLlmInternal.extractGeminiResponseDebugMeta(callResult && callResult.response);
    const text = await travelLlmInternal.extractGeminiText(callResult && callResult.response);
    const parsed = parseTravelFinalRewritePayload(text);
    if (!parsed) {
      return {
        stage,
        used: false,
        outcome: 'error',
        reason: 'invalid_json',
        assistant_text: '',
        source_meta: {
          provider: 'gemini',
          model: effectiveModel,
          prompt_hash: promptHash,
          prompt_chars: promptChars,
          ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
          ...responseMeta,
          error_code: 'TRAVEL_FINAL_REWRITE_INVALID_JSON',
          raw_text_chars: String(text || '').length,
          raw_text_excerpt: normalizeText(text, 800),
        },
      };
    }

    const validation = validateTravelFinalRewriteText(parsed.assistant_text, { promptInput });
    if (!validation.ok) {
      return {
        stage,
        used: false,
        outcome: 'guard_reject',
        reason: validation.reason,
        assistant_text: '',
        source_meta: {
          provider: 'gemini',
          model: effectiveModel,
          prompt_hash: promptHash,
          prompt_chars: promptChars,
          ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
          ...responseMeta,
          error_code: validation.reason,
          raw_text_chars: String(text || '').length,
          raw_text_excerpt: normalizeText(text, 800),
        },
      };
    }

    return {
      stage,
      used: true,
      outcome: 'call',
      reason: 'ok',
      assistant_text: parsed.assistant_text,
      source_meta: {
        provider: 'gemini',
        model: effectiveModel,
        prompt_hash: promptHash,
        prompt_chars: promptChars,
        ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
        ...responseMeta,
      },
    };
  } catch (err) {
    const timeoutErr = /TIMEOUT/i.test(String(err && (err.code || err.message) || ''));
    const errorMeta = isPlainObject(err && err.meta) ? err.meta : {};
    logger?.warn(
      {
        err: normalizeErrorCode(err, timeoutErr ? 'TRAVEL_FINAL_REWRITE_TIMEOUT' : 'TRAVEL_FINAL_REWRITE_ERROR'),
        stage,
        timeout_ms: timeoutMs,
      },
      'aurora bff: travel final assistant rewrite failed',
    );
    return {
      stage,
      used: false,
      outcome: timeoutErr ? 'timeout' : 'error',
      reason: timeoutErr ? 'timeout' : 'error',
      assistant_text: '',
      source_meta: {
        provider: 'gemini',
        model: effectiveModel,
        prompt_hash: promptHash,
        prompt_chars: promptChars,
        error_code: normalizeErrorCode(err, timeoutErr ? 'TRAVEL_FINAL_REWRITE_TIMEOUT' : 'TRAVEL_FINAL_REWRITE_ERROR'),
        ...(normalizeText(err && err.timeout_stage, 40) ? { timeout_stage: normalizeText(err.timeout_stage, 40) } : {}),
        ...(normalizeNumber(errorMeta.gate_wait_ms) != null ? { gate_wait_ms: normalizeNumber(errorMeta.gate_wait_ms) } : {}),
        ...(normalizeNumber(errorMeta.upstream_ms) != null ? { upstream_ms: normalizeNumber(errorMeta.upstream_ms) } : {}),
        ...(normalizeNumber(errorMeta.total_ms) != null ? { total_ms: normalizeNumber(errorMeta.total_ms) } : {}),
      },
    };
  }
}

module.exports = {
  DEFAULT_TRAVEL_FINAL_REWRITE_MODEL,
  rewriteTravelAssistantTextWithLlm,
  __internal: {
    buildFinalRewritePromptInput,
    buildTravelFinalRewritePrompts,
    buildGeminiRequest,
    parseTravelFinalRewritePayload,
    validateTravelFinalRewriteText,
    compactShoppingForFinalRewrite,
    compactStructuredSectionsForFinalRewrite,
    compactSafetyDecisionForFinalRewrite,
  },
};
