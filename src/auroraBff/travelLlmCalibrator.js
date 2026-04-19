const crypto = require('node:crypto')
const { extractJsonObject, parseJsonOnlyObject } = require('./jsonExtract')
const {
  hasAuroraGeminiApiKey,
  callAuroraGeminiGenerateContentWithMeta,
} = require('./auroraGeminiGlobalClient')
const { resolveNonImageGeminiModel } = require('../lib/geminiModelFloor')

const ALLOWED_BUYING_CHANNELS = new Set([
  'beauty_retail',
  'pharmacy',
  'department_store',
  'duty_free',
  'ecommerce',
])

const DEFAULT_TRAVEL_LLM_MODEL = String(
  process.env.AURORA_TRAVEL_LLM_MODEL ||
    process.env.TRAVEL_LLM_MODEL ||
    'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview'

function normalizeTravelGeminiModel(model) {
  return resolveNonImageGeminiModel({
    model: String(model || '').trim(),
    fallbackModel: 'gemini-3-flash-preview',
    envSource: 'AURORA_TRAVEL_LLM_MODEL',
    callPath: 'aurora_travel_llm_calibration',
  }).effectiveModel
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  return text.slice(0, maxLen)
}

function normalizeNumber(value) {
  if (value == null) return null
  if (typeof value === 'string' && !value.trim()) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeStringArray(value, maxItems = 8, maxLen = 120) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    const text = normalizeText(raw, maxLen)
    if (!text) continue
    out.push(text)
    if (out.length >= maxItems) break
  }
  return out
}

function isPregnancyOrLactationActive(profile) {
  const pregnancy = normalizeText(profile && profile.pregnancy_status, 20).toLowerCase()
  const lactation = normalizeText(profile && profile.lactation_status, 20).toLowerCase()
  return pregnancy === 'pregnant' || pregnancy === 'trying' || lactation === 'lactating'
}

function hashPromptPayload(value, tokenLen = 24) {
  const text = typeof value === 'string' ? value : String(value || '')
  const hash = crypto.createHash('sha256').update(text).digest('hex')
  const len = Number.isFinite(Number(tokenLen)) ? Math.max(8, Math.min(64, Math.trunc(Number(tokenLen)))) : 24
  return hash.slice(0, len)
}

function normalizeErrorCode(err, fallback = 'TRAVEL_LLM_ERROR') {
  const token = normalizeText(err && (err.code || err.message), 80)
  return token || fallback
}

function buildPromptInputSummary({ travelLlmInput = null, baseTravelReadiness = null } = {}) {
  const llmInput = isPlainObject(travelLlmInput) ? travelLlmInput : {}
  const readiness = isPlainObject(baseTravelReadiness) ? baseTravelReadiness : {}
  const destinationContext = isPlainObject(readiness.destination_context) ? readiness.destination_context : {}
  const profile = isPlainObject(llmInput.profile) ? llmInput.profile : {}

  const profileFieldsPresent = {
    skin_type: Boolean(normalizeText(profile.skinType != null ? profile.skinType : profile.skin_type, 80)),
    sensitivity: Boolean(normalizeText(profile.sensitivity, 80)),
    barrier_status: Boolean(normalizeText(profile.barrierStatus != null ? profile.barrierStatus : profile.barrier_status, 80)),
    region: Boolean(normalizeText(profile.region, 120)),
  }

  return {
    destination: normalizeText(llmInput.destination, 140) || normalizeText(destinationContext.destination, 140) || null,
    start_date: normalizeText(llmInput.start_date, 24) || normalizeText(destinationContext.start_date, 24) || null,
    end_date: normalizeText(llmInput.end_date, 24) || normalizeText(destinationContext.end_date, 24) || null,
    month_bucket: normalizeNumber(llmInput.month_bucket),
    weather_source: normalizeText(llmInput.weather_source, 40) || null,
    alerts_source: normalizeText(llmInput.alerts_source, 40) || null,
    kb_hit: typeof llmInput.kb_hit === 'boolean' ? llmInput.kb_hit : null,
    profile_fields_present: profileFieldsPresent,
  }
}

function buildPromptTelemetry({ systemPrompt, userPrompt, travelLlmInput = null, baseTravelReadiness = null } = {}) {
  const sys = typeof systemPrompt === 'string' ? systemPrompt : String(systemPrompt || '')
  const usr = typeof userPrompt === 'string' ? userPrompt : String(userPrompt || '')
  const promptPayload = `${sys}\n${usr}`
  return {
    prompt_hash: hashPromptPayload(promptPayload, 24),
    prompt_chars: promptPayload.length,
    input_summary: buildPromptInputSummary({ travelLlmInput, baseTravelReadiness }),
  }
}

function normalizeMatchStatus(value) {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'kb_verified' || token === 'catalog_verified' || token === 'llm_only') return token
  return 'llm_only'
}

function normalizeProductSource(value) {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'catalog' || token === 'rule_fallback' || token === 'llm_generated') return token
  if (token === 'llm_only') return 'llm_generated'
  return 'llm_generated'
}

function normalizeBrandCandidates(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value) {
    const row = isPlainObject(raw) ? raw : {}
    const brand = normalizeText(row.brand, 80)
    if (!brand) continue
    const key = brand.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      brand,
      match_status: normalizeMatchStatus(row.match_status),
      reason: normalizeText(row.reason, 180) || null,
    })
    if (out.length >= 6) break
  }
  return out
}

function normalizeForecastWindow(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    const row = isPlainObject(raw) ? raw : {}
    const date = normalizeText(row.date, 24)
    if (!date) continue
    out.push({
      date,
      temp_low_c: normalizeNumber(row.temp_low_c),
      temp_high_c: normalizeNumber(row.temp_high_c),
      humidity_mean: normalizeNumber(row.humidity_mean),
      uv_max: normalizeNumber(row.uv_max),
      precip_mm: normalizeNumber(row.precip_mm),
      wind_kph: normalizeNumber(row.wind_kph),
      condition_text: normalizeText(row.condition_text, 120) || null,
    })
    if (out.length >= 7) break
  }
  return out
}

function normalizeAlerts(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    const row = isPlainObject(raw) ? raw : {}
    const title = normalizeText(row.title, 160)
    const severity = normalizeText(row.severity, 24)
    if (!title && !severity) continue
    out.push({
      provider: normalizeText(row.provider, 80) || null,
      severity: severity || null,
      title: title || null,
      summary: normalizeText(row.summary, 260) || null,
      start_at: normalizeText(row.start_at, 64) || null,
      end_at: normalizeText(row.end_at, 64) || null,
      region: normalizeText(row.region, 120) || null,
      action_hint: normalizeText(row.action_hint, 220) || null,
    })
    if (out.length >= 4) break
  }
  return out
}

function normalizeRecoBundle(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    const row = isPlainObject(raw) ? raw : {}
    const trigger = normalizeText(row.trigger, 120)
    const action = normalizeText(row.action, 260)
    if (!trigger && !action) continue
    out.push({
      trigger: trigger || null,
      action: action || null,
      ingredient_logic: normalizeText(row.ingredient_logic, 220) || null,
      product_types: normalizeStringArray(row.product_types, 4, 140),
      reapply_rule: normalizeText(row.reapply_rule, 220) || null,
    })
    if (out.length >= 5) break
  }
  return out
}

function normalizeStoreExamples(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value) {
    const row = isPlainObject(raw) ? raw : {}
    const name = normalizeText(row.name, 120)
    if (!name) continue
    out.push({
      name,
      type: normalizeText(row.type, 80) || null,
      address: normalizeText(row.address, 180) || null,
      district: normalizeText(row.district, 80) || null,
      source: normalizeText(row.source, 60) || null,
    })
    if (out.length >= 6) break
  }
  return out
}

function normalizeShoppingPreview(value) {
  if (!isPlainObject(value)) return undefined
  const productsRaw = Array.isArray(value.products) ? value.products : []
  const products = []
  for (const raw of productsRaw) {
    const row = isPlainObject(raw) ? raw : {}
    const name = normalizeText(row.name, 140)
    if (!name) continue
    products.push({
      rank: normalizeNumber(row.rank),
      product_id: normalizeText(row.product_id, 120) || null,
      name,
      brand: normalizeText(row.brand, 80) || null,
      category: normalizeText(row.category, 80) || null,
      reasons: normalizeStringArray(row.reasons, 4, 120),
      product_source: normalizeProductSource(row.product_source),
      price: normalizeNumber(row.price),
      currency: normalizeText(row.currency, 12) || null,
    })
    if (products.length >= 3) break
  }

  const channels = normalizeStringArray(value.buying_channels, 8, 60)
    .map((x) => x.toLowerCase())
    .filter((x) => ALLOWED_BUYING_CHANNELS.has(x))

  const brandCandidates = normalizeBrandCandidates(value.brand_candidates)

  const out = {
    ...(products.length ? { products } : {}),
    ...(channels.length ? { buying_channels: channels } : {}),
    ...(brandCandidates.length ? { brand_candidates: brandCandidates } : {}),
    ...(normalizeText(value.city_hint, 120) ? { city_hint: normalizeText(value.city_hint, 120) } : {}),
    ...(normalizeText(value.note, 220) ? { note: normalizeText(value.note, 220) } : {}),
  }

  return Object.keys(out).length ? out : undefined
}

function compactProfileForPrompt(value) {
  const profile = isPlainObject(value) ? value : {}
  return {
    ...(normalizeText(profile.skinType || profile.skin_type, 40)
      ? { skinType: normalizeText(profile.skinType || profile.skin_type, 40) }
      : {}),
    ...(normalizeText(profile.sensitivity, 40) ? { sensitivity: normalizeText(profile.sensitivity, 40) } : {}),
    ...(normalizeText(profile.barrierStatus || profile.barrier_status, 40)
      ? { barrierStatus: normalizeText(profile.barrierStatus || profile.barrier_status, 40) }
      : {}),
    ...(normalizeText(profile.region, 120) ? { region: normalizeText(profile.region, 120) } : {}),
    ...(Array.isArray(profile.goals) ? { goals: normalizeStringArray(profile.goals, 8, 60) } : {}),
    ...(normalizeText(profile.budgetTier || profile.budget_tier, 40)
      ? { budgetTier: normalizeText(profile.budgetTier || profile.budget_tier, 40) }
      : {}),
    ...(normalizeText(profile.currentRoutine, 500) ? { currentRoutine: normalizeText(profile.currentRoutine, 500) } : {}),
    ...(Array.isArray(profile.contraindications)
      ? { contraindications: normalizeStringArray(profile.contraindications, 12, 80) }
      : {}),
    ...(normalizeText(profile.age_band, 24) ? { age_band: normalizeText(profile.age_band, 24) } : {}),
    ...(normalizeText(profile.pregnancy_status, 24) ? { pregnancy_status: normalizeText(profile.pregnancy_status, 24) } : {}),
    ...(normalizeText(profile.lactation_status, 24) ? { lactation_status: normalizeText(profile.lactation_status, 24) } : {}),
  }
}

function compactTravelLlmInputForPrompt(value) {
  const input = isPlainObject(value) ? value : {}
  return {
    ...(normalizeText(input.destination, 140) ? { destination: normalizeText(input.destination, 140) } : {}),
    ...(normalizeText(input.start_date, 24) ? { start_date: normalizeText(input.start_date, 24) } : {}),
    ...(normalizeText(input.end_date, 24) ? { end_date: normalizeText(input.end_date, 24) } : {}),
    ...(normalizeNumber(input.month_bucket) != null ? { month_bucket: normalizeNumber(input.month_bucket) } : {}),
    profile: compactProfileForPrompt(input.profile),
    ...(normalizeText(input.weather_source, 40) ? { weather_source: normalizeText(input.weather_source, 40) } : {}),
    ...(normalizeText(input.weather_reason, 80) ? { weather_reason: normalizeText(input.weather_reason, 80) } : {}),
    ...(normalizeText(input.alerts_source, 40) ? { alerts_source: normalizeText(input.alerts_source, 40) } : {}),
    ...(typeof input.kb_hit === 'boolean' ? { kb_hit: input.kb_hit } : {}),
    ...(normalizeText(input.question, 700) ? { question: normalizeText(input.question, 700) } : {}),
    ...(isPlainObject(input.analysis_context_hard) ? { analysis_context_hard: input.analysis_context_hard } : {}),
    ...(isPlainObject(input.analysis_context_soft) ? { analysis_context_soft: input.analysis_context_soft } : {}),
    ...(Array.isArray(input.analysis_context_evidence)
      ? {
          analysis_context_evidence: input.analysis_context_evidence
            .slice(0, 6)
            .map((item) => (isPlainObject(item) ? item : normalizeText(item, 180)))
            .filter(Boolean),
        }
      : {}),
    ...(Array.isArray(input.analysis_context_conflicts)
      ? {
          analysis_context_conflicts: input.analysis_context_conflicts
            .slice(0, 4)
            .map((item) => (isPlainObject(item) ? item : normalizeText(item, 180)))
            .filter(Boolean),
        }
      : {}),
  }
}

function compactTravelReadinessForPrompt(value) {
  const readiness = isPlainObject(value) ? value : {}
  return {
    ...(isPlainObject(readiness.destination_context) ? { destination_context: readiness.destination_context } : {}),
    ...(isPlainObject(readiness.origin_context) ? { origin_context: readiness.origin_context } : {}),
    ...(isPlainObject(readiness.delta_vs_home) ? { delta_vs_home: readiness.delta_vs_home } : {}),
    ...(isPlainObject(readiness.delta_vs_origin) ? { delta_vs_origin: readiness.delta_vs_origin } : {}),
    ...(Array.isArray(readiness.forecast_window)
      ? { forecast_window: normalizeForecastWindow(readiness.forecast_window).slice(0, 5) }
      : {}),
    ...(Array.isArray(readiness.alerts) ? { alerts: normalizeAlerts(readiness.alerts).slice(0, 3) } : {}),
    ...(Array.isArray(readiness.adaptive_actions) ? { adaptive_actions: readiness.adaptive_actions.slice(0, 5) } : {}),
    ...(Array.isArray(readiness.personal_focus) ? { personal_focus: readiness.personal_focus.slice(0, 4) } : {}),
    ...(isPlainObject(readiness.jetlag_sleep) ? { jetlag_sleep: readiness.jetlag_sleep } : {}),
    ...(Array.isArray(readiness.reco_bundle) ? { reco_bundle: normalizeRecoBundle(readiness.reco_bundle) } : {}),
    ...(isPlainObject(readiness.shopping_preview) ? { shopping_preview: normalizeShoppingPreview(readiness.shopping_preview) } : {}),
    ...(Array.isArray(readiness.category_recommendations)
      ? { category_recommendations: readiness.category_recommendations.slice(0, 8) }
      : {}),
    ...(isPlainObject(readiness.confidence) ? { confidence: readiness.confidence } : {}),
  }
}

function normalizeTravelReadinessPatch(value) {
  if (!isPlainObject(value)) return {}
  const out = {}

  if (Array.isArray(value.adaptive_actions)) {
    const adaptiveActions = []
    for (const raw of value.adaptive_actions) {
      const row = isPlainObject(raw) ? raw : {}
      const why = normalizeText(row.why, 260)
      const whatToDo = normalizeText(row.what_to_do, 320)
      if (!why && !whatToDo) continue
      adaptiveActions.push({
        ...(why ? { why } : {}),
        ...(whatToDo ? { what_to_do: whatToDo } : {}),
      })
      if (adaptiveActions.length >= 6) break
    }
    if (adaptiveActions.length) out.adaptive_actions = adaptiveActions
  }

  const recoBundle = normalizeRecoBundle(value.reco_bundle)
  if (recoBundle.length) out.reco_bundle = recoBundle

  const storeExamples = normalizeStoreExamples(value.store_examples)
  if (storeExamples.length) out.store_examples = storeExamples

  if (Array.isArray(value.personal_focus)) {
    const personalFocus = []
    for (const raw of value.personal_focus) {
      const row = isPlainObject(raw) ? raw : {}
      const focus = normalizeText(row.focus, 120)
      const why = normalizeText(row.why, 260)
      const whatToDo = normalizeText(row.what_to_do, 320)
      if (!focus && !why && !whatToDo) continue
      personalFocus.push({
        ...(focus ? { focus } : {}),
        ...(why ? { why } : {}),
        ...(whatToDo ? { what_to_do: whatToDo } : {}),
      })
      if (personalFocus.length >= 4) break
    }
    if (personalFocus.length) out.personal_focus = personalFocus
  }

  if (isPlainObject(value.jetlag_sleep)) {
    const node = value.jetlag_sleep
    const jetlagSleep = {
      ...(normalizeText(node.tz_home, 64) ? { tz_home: normalizeText(node.tz_home, 64) } : {}),
      ...(normalizeText(node.tz_destination, 64) ? { tz_destination: normalizeText(node.tz_destination, 64) } : {}),
      ...(normalizeNumber(node.hours_diff) != null ? { hours_diff: normalizeNumber(node.hours_diff) } : {}),
      ...(normalizeText(node.risk_level, 24) ? { risk_level: normalizeText(node.risk_level, 24) } : {}),
      ...(normalizeStringArray(node.sleep_tips, 4, 220).length ? { sleep_tips: normalizeStringArray(node.sleep_tips, 4, 220) } : {}),
      ...(normalizeStringArray(node.mask_tips, 4, 220).length ? { mask_tips: normalizeStringArray(node.mask_tips, 4, 220) } : {}),
    }
    if (Object.keys(jetlagSleep).length) out.jetlag_sleep = jetlagSleep
  }

  const shoppingPreview = normalizeShoppingPreview(value.shopping_preview)
  if (shoppingPreview) out.shopping_preview = shoppingPreview

  if (isPlainObject(value.confidence)) {
    const node = value.confidence
    const confidence = {
      ...(normalizeText(node.level, 24) ? { level: normalizeText(node.level, 24) } : {}),
      ...(normalizeStringArray(node.missing_inputs, 12, 80).length ? { missing_inputs: normalizeStringArray(node.missing_inputs, 12, 80) } : {}),
      ...(normalizeStringArray(node.improve_by, 8, 220).length ? { improve_by: normalizeStringArray(node.improve_by, 8, 220) } : {}),
      ...(normalizeNumber(node.score) != null ? { score: normalizeNumber(node.score) } : {}),
    }
    if (Object.keys(confidence).length) out.confidence = confidence
  }

  if (Array.isArray(value.category_recommendations)) {
    const categoryRecs = []
    for (const raw of value.category_recommendations) {
      const row = isPlainObject(raw) ? raw : {}
      const category = normalizeText(row.category, 40)
      if (!category) continue
      const products = Array.isArray(row.products) ? row.products.slice(0, 4).map((p) => {
        const prod = isPlainObject(p) ? p : {}
        return {
          name: normalizeText(prod.name, 140) || null,
          ingredient_logic: normalizeText(prod.ingredient_logic, 260) || null,
          usage: normalizeText(prod.usage, 260) || null,
        }
      }).filter((p) => p.name) : []
      categoryRecs.push({
        category,
        why: normalizeText(row.why, 320) || null,
        products,
        skip_reason: normalizeText(row.skip_reason, 160) || null,
      })
      if (categoryRecs.length >= 10) break
    }
    if (categoryRecs.length) out.category_recommendations = categoryRecs
  }

  return out
}

function sanitizeBaselineIntegrity(travelReadiness) {
  const payload = isPlainObject(travelReadiness) ? { ...travelReadiness } : {}
  const delta = isPlainObject(payload.delta_vs_home) ? { ...payload.delta_vs_home } : null
  if (!delta) return payload

  const baselineStatus = normalizeText(delta.baseline_status, 64).toLowerCase()
  if (baselineStatus !== 'baseline_unavailable') return payload

  const metricKeys = ['temperature', 'humidity', 'uv', 'wind', 'precip']
  for (const key of metricKeys) {
    const row = isPlainObject(delta[key]) ? { ...delta[key] } : null
    if (!row) continue
    row.home = null
    row.delta = null
    delta[key] = row
  }
  payload.delta_vs_home = delta
  return payload
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) {
    if (Array.isArray(patch) && patch.length) return patch
    return Array.isArray(base) ? base : []
  }

  if (!isPlainObject(base) && !isPlainObject(patch)) {
    return patch == null ? base : patch
  }

  const left = isPlainObject(base) ? base : {}
  const right = isPlainObject(patch) ? patch : {}
  const out = { ...left }
  for (const [key, value] of Object.entries(right)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      if (value.length) out[key] = value
      continue
    }
    if (isPlainObject(value)) {
      out[key] = deepMerge(left[key], value)
      continue
    }
    out[key] = value
  }
  return out
}

function extractCompletionText(response) {
  const choices = Array.isArray(response && response.choices) ? response.choices : []
  const first = choices[0] || {}
  const message = isPlainObject(first.message) ? first.message : {}
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    const textParts = []
    for (const part of message.content) {
      if (isPlainObject(part) && typeof part.text === 'string') textParts.push(part.text)
    }
    return textParts.join('\n').trim()
  }
  return ''
}

async function maybeCallText(target) {
  if (!target || typeof target.text !== 'function') return ''
  try {
    const out = await target.text()
    return String(out || '').trim()
  } catch {
    return ''
  }
}

async function extractGeminiText(response) {
  if (!response) return ''
  if (typeof response.text === 'string' && response.text.trim()) return response.text.trim()
  const direct = await maybeCallText(response)
  if (direct) return direct
  const nested = await maybeCallText(response.response)
  if (nested) return nested
  if (typeof response?.response?.text === 'string' && response.response.text.trim()) return response.response.text.trim()
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const parts = []
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of contentParts) {
      if (part && typeof part.text === 'string' && part.text.trim()) parts.push(part.text.trim())
    }
  }
  return parts.join('\n').trim()
}

function buildGeminiRequest({ model, systemPrompt, userPrompt } = {}) {
  return {
    model: normalizeTravelGeminiModel(model || DEFAULT_TRAVEL_LLM_MODEL),
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `${systemPrompt}\n\n${userPrompt}`,
          },
        ],
      },
    ],
    config: {
      temperature: 0.3,
      maxOutputTokens: 2000,
      responseMimeType: 'application/json',
    },
  }
}

function withTimeout(promise, timeoutMs, timeoutCode = 'TRAVEL_LLM_TIMEOUT') {
  const ms = Number.isFinite(Number(timeoutMs)) ? Math.max(1, Math.trunc(Number(timeoutMs))) : 0
  if (!ms) return promise
  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(timeoutCode)
      err.code = timeoutCode
      reject(err)
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function buildTravelCalibrationPrompts({ language = 'EN', travelLlmInput, baseTravelReadiness } = {}) {
  const lang = String(language || '').toUpperCase() === 'CN' ? 'CN' : 'EN'
  const promptTravelLlmInput = compactTravelLlmInputForPrompt(travelLlmInput)
  const promptBaseTravelReadiness = compactTravelReadinessForPrompt(baseTravelReadiness)

  const profileInput = isPlainObject(promptTravelLlmInput) && isPlainObject(promptTravelLlmInput.profile)
    ? promptTravelLlmInput.profile
    : {}
  const goals = Array.isArray(profileInput.goals) ? profileInput.goals : []
  const contraindications = Array.isArray(profileInput.contraindications) ? profileInput.contraindications : []
  const hasRoutine = Boolean(normalizeText(profileInput.currentRoutine, 10))
  const isPregnantOrLactating = isPregnancyOrLactationActive(profileInput)

  const systemPrompt =
    'You are a board-certified dermatologist-level travel skincare advisor. ' +
    'Return valid JSON only. Never output markdown, never diagnose, never prescribe.\n\n' +
    'IMMUTABLE FACTS:\n' +
    '- destination_context, delta_vs_home, forecast_window, alerts, epi, env_source, weather_reason, and all date/location/weather numbers are immutable baseline facts.\n' +
    '- Never add, edit, replace, or "correct" weather/date/source values. If facts seem sparse, work within them and lower confidence instead.\n\n' +
    'CATEGORY COVERAGE — evaluate ALL relevant categories for this trip:\n' +
    '1. Cleansing (+ double-cleanse / makeup removal when user wears makeup)\n' +
    '2. Antioxidant protection (vitamin C / niacinamide serum, especially UV>=5)\n' +
    '3. Sun protection — face SPF with tier + reapply cadence + body SPF if outdoor-heavy\n' +
    '4. Moisturization & barrier repair — differentiate AM (lighter) vs PM (repair); texture by humidity\n' +
    '5. Masks — pick by scenario: flight-recovery (hydrating+soothing), post-sun (cooling+anti-inflammatory), deep-hydration (dry climate)\n' +
    '6. Post-sun repair — aloe gel, panthenol serum, calming mist (trigger: UV>=6 or outdoor-heavy)\n' +
    '7. Brightening / dark-spot care — ONLY if user goals include dark_spots or brightening; advise travel-safe lower concentration\n' +
    '8. Eye care — eye cream + cooling patches (trigger: jet-lag >=5h or long-haul flight)\n' +
    '9. Body care — body SPF, body lotion, after-sun body (trigger: outdoor >2 days)\n' +
    '10. Emergency kit — pimple patches, lip balm, hand cream, hydrocortisone note\n\n' +
    'DEPTH RULES:\n' +
    '- For each category you include, provide: WHY needed in this specific scenario + ingredient logic + usage timing/frequency.\n' +
    '- BAD: "Apply sunscreen regularly." GOOD: "UV index 8: SPF50+ PA++++ with photostable UVA filters; reapply 2h outdoors, stick format for midday touch-ups."\n' +
    '- Tailor moisturizer texture to humidity delta: high-humidity → gel-cream AM; low-humidity → richer ceramide cream PM + occlusive seal.\n' +
    '- For masks, specify exact scenario trigger and ingredient rationale, not generic "hydrating mask."\n\n' +
    'PERSONALIZATION:\n' +
    '- Use skin_type, sensitivity, barrier_status, goals, contraindications, current_routine to differentiate.\n' +
    '- analysis_context_hard contains strong user-relevant context. analysis_context_soft contains supportive but uncertainty-bearing context.\n' +
    '- If explicit profile input conflicts with analysis_context_* signals, explicit profile wins.\n' +
    '- Treat stale, low-quality, or conflicting analysis-context signals conservatively. Do not restate them as if the user explicitly said them.\n' +
    '- If goals include dark_spots/brightening → add travel brightening protocol (lower vitamin C concentration during travel, resume post-trip).\n' +
    '- If goals include acne → prioritize non-comedogenic, add salicylic acid spot treatment.\n' +
    '- If goals include wrinkles/anti-aging → add antioxidant emphasis, retinoid travel pause note.\n' +
    '- If routine mentions makeup → emphasize double cleansing and thorough SPF removal.\n' +
    (isPregnantOrLactating
      ? '- CRITICAL: User is pregnant/lactating — exclude retinoids, high-dose salicylic acid (>2%), hydroquinone. Flag safe alternatives.\n'
      : '') +
    (contraindications.length
      ? `- CONTRAINDICATIONS to avoid: ${contraindications.join(', ')}.\n`
      : '') +
    '\nDEDUPLICATION:\n' +
    '- Each piece of advice must appear in EXACTLY ONE output field. Never repeat the same product/action across adaptive_actions, personal_focus, and shopping_preview.\n' +
    '- adaptive_actions = environment-triggered routine shifts (max 4, no product names).\n' +
    '- personal_focus = user-profile-driven priorities (max 3, reference goals/sensitivity).\n' +
    '- shopping_preview.products = concrete product types with ingredient logic (max 6).\n' +
    '- Do NOT duplicate SPF advice across all three.\n\n' +
    'SAFETY: Never diagnose conditions. Never prescribe medications. ' +
    'Flag any suggestion that approaches medical-grade as "consult your dermatologist." ' +
    'Do not block when routine data is missing; provide actionable guidance and lower confidence instead.'

  const userPrompt =
    `language=${lang}\n` +
    'Task: calibrate the travel_readiness payload with deep, category-specific, personalized, non-redundant skincare guidance.\n\n' +
    (goals.length ? `User goals: ${goals.join(', ')}\n` : '') +
    (hasRoutine ? `Current routine available: yes (see profile.currentRoutine in input)\n` : 'Current routine: not provided\n') +
    (isPregnantOrLactating ? 'Pregnancy/lactation: active — apply ingredient restrictions.\n' : '') +
    '\nOutput schema:\n' +
    '{\n' +
    '  "travel_readiness_patch": {\n' +
    '    "adaptive_actions": [{"why":"environment reason","what_to_do":"routine shift, no product names"}],\n' +
    '    "personal_focus": [{"focus":"label","why":"profile-based reason","what_to_do":"specific action"}],\n' +
    '    "jetlag_sleep": {...optional},\n' +
    '    "category_recommendations": [\n' +
    '      {"category":"cleansing|antioxidant|sun_protection|moisturization|masks|post_sun|brightening|eye_care|body_care|emergency",\n' +
    '       "why":"scenario-specific reason",\n' +
    '       "products":[{"name":"","ingredient_logic":"","usage":"timing+frequency"}],\n' +
    '       "skip_reason":"only if category skipped"}\n' +
    '    ],\n' +
    '    "shopping_preview": {\n' +
    '      "products": [{"name":"","brand":"","category":"","reasons":[],"product_source":"llm_generated"}],\n' +
    '      "brand_candidates": [{"brand":"","match_status":"kb_verified|catalog_verified|llm_only","reason":""}],\n' +
    '      "buying_channels": ["beauty_retail|pharmacy|department_store|duty_free|ecommerce"],\n' +
    '      "city_hint": "",\n' +
    '      "note": ""\n' +
    '    },\n' +
    '    "confidence": {"level":"low|medium|high","missing_inputs":[],"improve_by":[]}\n' +
    '  },\n' +
    '  "quality_flags": {"structured_complete":true|false,"safety_conflict":true|false,"categories_covered":["list of covered category ids"]},\n' +
    '  "source_notes": {"reasoning_mode":"llm_calibration_v2"}\n' +
    '}\n\n' +
    'Fact input JSON:\n' +
    `${JSON.stringify(promptTravelLlmInput || {}, null, 2)}\n` +
    'Current travel_readiness JSON:\n' +
    `${JSON.stringify(promptBaseTravelReadiness || {}, null, 2)}`

  return { systemPrompt, userPrompt }
}

function parseCalibrationPayload(text) {
  const parsed = parseJsonOnlyObject(text) || extractJsonObject(text)
  if (!isPlainObject(parsed)) return null
  const patch = isPlainObject(parsed.travel_readiness_patch)
    ? parsed.travel_readiness_patch
    : isPlainObject(parsed.travel_readiness)
      ? parsed.travel_readiness
      : parsed

  const travelReadinessPatch = normalizeTravelReadinessPatch(patch)
  if (!Object.keys(travelReadinessPatch).length) return null

  const qualityFlags = isPlainObject(parsed.quality_flags) ? parsed.quality_flags : {}
  const sourceNotes = isPlainObject(parsed.source_notes) ? parsed.source_notes : {}

  return {
    travel_readiness_patch: travelReadinessPatch,
    quality_flags: qualityFlags,
    source_notes: sourceNotes,
  }
}

async function calibrateTravelReadinessWithLlm({
  openaiClient = null,
  geminiGenerateContent = null,
  language = 'EN',
  travelLlmInput = null,
  baseTravelReadiness = null,
  timeoutMs = 3500,
  maxRetries = 1,
  model = DEFAULT_TRAVEL_LLM_MODEL,
  logger = null,
} = {}) {
  const stage = 'travel_readiness_calibration_v1'
  const baseline = sanitizeBaselineIntegrity(isPlainObject(baseTravelReadiness) ? baseTravelReadiness : {})
  const { systemPrompt, userPrompt } = buildTravelCalibrationPrompts({
    language,
    travelLlmInput,
    baseTravelReadiness: baseline,
  })
  const promptTelemetry = buildPromptTelemetry({
    systemPrompt,
    userPrompt,
    travelLlmInput,
    baseTravelReadiness: baseline,
  })
  const effectiveModel = normalizeTravelGeminiModel(model || DEFAULT_TRAVEL_LLM_MODEL)
  const geminiRequest = buildGeminiRequest({ model: effectiveModel, systemPrompt, userPrompt })
  const hasGeminiClient =
    typeof geminiGenerateContent === 'function' ||
    hasAuroraGeminiApiKey('AURORA_TRAVEL_GEMINI_API_KEY')

  if (!hasGeminiClient) {
    return {
      stage,
      used: false,
      outcome: 'skip_no_client',
      travel_readiness: baseline,
      quality_flags: {},
      source_meta: {
        reason: 'no_gemini_client',
        provider: 'gemini',
        model: effectiveModel,
        ...promptTelemetry,
        error_code: 'no_gemini_client',
      },
    }
  }

  const attempts = Math.max(1, Math.min(3, Math.trunc(Number(maxRetries) || 0) + 1))

  let lastErr = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      const queueTimeoutMs = Math.max(300, Math.floor(Number(timeoutMs || 3500) * 0.25))
      const upstreamTimeoutMs = Math.max(800, Math.floor(Number(timeoutMs || 3500) - queueTimeoutMs))
      const callResult = typeof geminiGenerateContent === 'function'
        ? {
            response: await withTimeout(
              geminiGenerateContent(geminiRequest),
              timeoutMs,
              'TRAVEL_LLM_TIMEOUT',
            ),
            meta: {},
          }
        : await callAuroraGeminiGenerateContentWithMeta({
            featureEnvVar: 'AURORA_TRAVEL_GEMINI_API_KEY',
            route: 'aurora_travel_llm_calibration',
            request: geminiRequest,
            queueTimeoutMs,
            upstreamTimeoutMs,
          })

      const text = await extractGeminiText(callResult && callResult.response)
      const parsed = parseCalibrationPayload(text)
      if (!parsed) {
        const parseErr = new Error('travel_llm_invalid_json')
        parseErr.code = 'TRAVEL_LLM_INVALID_JSON'
        lastErr = parseErr
        continue
      }

      const merged = sanitizeBaselineIntegrity(deepMerge(baseline, parsed.travel_readiness_patch))
      return {
        stage,
        used: true,
        outcome: 'call',
        travel_readiness: merged,
        quality_flags: parsed.quality_flags || {},
        source_meta: {
          provider: 'gemini',
          model: effectiveModel,
          attempt: i + 1,
          reasoning_mode: normalizeText(parsed.source_notes && parsed.source_notes.reasoning_mode, 80) || 'llm_calibration_v1',
          ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
          ...promptTelemetry,
        },
      }
    } catch (err) {
      lastErr = err
      logger?.warn(
        {
          err: err && (err.code || err.message) ? err.code || err.message : String(err),
          stage,
          attempt: i + 1,
          timeout_ms: timeoutMs,
        },
        'aurora bff: travel gemini calibration failed, retrying',
      )
    }
  }

  const timeoutErr = lastErr && /TIMEOUT/i.test(String(lastErr.code || lastErr.message || ''))
  const errorCode = normalizeErrorCode(lastErr, timeoutErr ? 'TRAVEL_LLM_TIMEOUT' : 'TRAVEL_LLM_ERROR')
  return {
    stage,
    used: false,
    outcome: timeoutErr ? 'timeout' : 'error',
    travel_readiness: baseline,
    quality_flags: {},
    source_meta: {
      reason: timeoutErr ? 'timeout' : 'error',
      provider: 'gemini',
      model: effectiveModel,
      ...promptTelemetry,
      error_code: errorCode,
      error: lastErr && (lastErr.code || lastErr.message) ? String(lastErr.code || lastErr.message).slice(0, 140) : 'unknown',
    },
  }
}

module.exports = {
  DEFAULT_TRAVEL_LLM_MODEL,
  calibrateTravelReadinessWithLlm,
  __internal: {
    normalizeTravelReadinessPatch,
    normalizeShoppingPreview,
    normalizeBrandCandidates,
    normalizeForecastWindow,
    normalizeAlerts,
    normalizeRecoBundle,
    normalizeStoreExamples,
    sanitizeBaselineIntegrity,
    deepMerge,
    parseCalibrationPayload,
    buildTravelCalibrationPrompts,
    compactTravelLlmInputForPrompt,
    compactTravelReadinessForPrompt,
    buildPromptInputSummary,
    buildPromptTelemetry,
  },
}
