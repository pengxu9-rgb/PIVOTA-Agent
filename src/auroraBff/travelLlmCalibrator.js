const { extractJsonObject, parseJsonOnlyObject } = require('./jsonExtract')

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
    process.env.AURORA_SKIN_VISION_MODEL_OPENAI ||
    'gpt-4o-mini',
).trim() || 'gpt-4o-mini'

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

function normalizeMatchStatus(value) {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'kb_verified' || token === 'catalog_verified' || token === 'llm_only') return token
  return 'llm_only'
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

function normalizeTravelReadinessPatch(value) {
  if (!isPlainObject(value)) return {}
  const out = {}

  if (isPlainObject(value.destination_context)) {
    const node = value.destination_context
    const destinationContext = {
      ...(normalizeText(node.destination, 140) ? { destination: normalizeText(node.destination, 140) } : {}),
      ...(normalizeText(node.start_date, 24) ? { start_date: normalizeText(node.start_date, 24) } : {}),
      ...(normalizeText(node.end_date, 24) ? { end_date: normalizeText(node.end_date, 24) } : {}),
      ...(normalizeText(node.env_source, 48) ? { env_source: normalizeText(node.env_source, 48) } : {}),
      ...(normalizeNumber(node.epi) != null ? { epi: normalizeNumber(node.epi) } : {}),
    }
    if (Object.keys(destinationContext).length) out.destination_context = destinationContext
  }

  if (isPlainObject(value.delta_vs_home)) {
    const node = value.delta_vs_home
    const deltaVsHome = {
      ...(isPlainObject(node.temperature) ? { temperature: node.temperature } : {}),
      ...(isPlainObject(node.humidity) ? { humidity: node.humidity } : {}),
      ...(isPlainObject(node.uv) ? { uv: node.uv } : {}),
      ...(isPlainObject(node.wind) ? { wind: node.wind } : {}),
      ...(isPlainObject(node.precip) ? { precip: node.precip } : {}),
      ...(normalizeStringArray(node.summary_tags, 8, 48).length ? { summary_tags: normalizeStringArray(node.summary_tags, 8, 48) } : {}),
      ...(normalizeText(node.baseline_status, 48) ? { baseline_status: normalizeText(node.baseline_status, 48) } : {}),
    }
    if (Object.keys(deltaVsHome).length) out.delta_vs_home = deltaVsHome
  }

  const forecastWindow = normalizeForecastWindow(value.forecast_window)
  if (forecastWindow.length) out.forecast_window = forecastWindow

  const alerts = normalizeAlerts(value.alerts)
  if (alerts.length) out.alerts = alerts

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
  const systemPrompt =
    'You are a dermatology-safe travel skincare calibration assistant. ' +
    'Return valid JSON only. Never output markdown. ' +
    'Do not block when routine is missing; keep guidance actionable and lower confidence instead. ' +
    'Respect safety-first wording and avoid medical diagnosis.'

  const userPrompt =
    `language=${lang}\n` +
    'Task: improve the travel_readiness payload for execution quality.\n' +
    'Output schema:\n' +
    '{\n' +
    '  "travel_readiness_patch": {\n' +
    '    "delta_vs_home": {...optional},\n' +
    '    "adaptive_actions": [{"why":"", "what_to_do":""}],\n' +
    '    "personal_focus": [{"focus":"", "why":"", "what_to_do":""}],\n' +
    '    "jetlag_sleep": {...optional},\n' +
    '    "shopping_preview": {\n' +
    '      "products": [{"name":"", "brand":"", "category":"", "reasons":[]}],\n' +
    '      "brand_candidates": [{"brand":"", "match_status":"kb_verified|catalog_verified|llm_only", "reason":""}],\n' +
    '      "buying_channels": ["beauty_retail|pharmacy|department_store|duty_free|ecommerce"],\n' +
    '      "city_hint": "",\n' +
    '      "note": ""\n' +
    '    },\n' +
    '    "confidence": {"level":"low|medium|high", "missing_inputs":[], "improve_by":[]}\n' +
    '  },\n' +
    '  "quality_flags": {"structured_complete":true|false, "safety_conflict":true|false},\n' +
    '  "source_notes": {"reasoning_mode":"llm_calibration_v1"}\n' +
    '}\n' +
    'If you are unsure about local brands, still provide best-effort candidates with match_status="llm_only".\n' +
    'Fact input JSON:\n' +
    `${JSON.stringify(travelLlmInput || {}, null, 2)}\n` +
    'Current travel_readiness JSON:\n' +
    `${JSON.stringify(baseTravelReadiness || {}, null, 2)}`

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
  language = 'EN',
  travelLlmInput = null,
  baseTravelReadiness = null,
  timeoutMs = 1800,
  maxRetries = 1,
  model = DEFAULT_TRAVEL_LLM_MODEL,
  logger = null,
} = {}) {
  const stage = 'travel_readiness_calibration_v1'
  const baseline = sanitizeBaselineIntegrity(isPlainObject(baseTravelReadiness) ? baseTravelReadiness : {})

  if (!openaiClient || !openaiClient.chat || !openaiClient.chat.completions) {
    return {
      stage,
      used: false,
      outcome: 'skip_no_client',
      travel_readiness: baseline,
      quality_flags: {},
      source_meta: { reason: 'no_client', model },
    }
  }

  const attempts = Math.max(1, Math.min(3, Math.trunc(Number(maxRetries) || 0) + 1))
  const { systemPrompt, userPrompt } = buildTravelCalibrationPrompts({
    language,
    travelLlmInput,
    baseTravelReadiness: baseline,
  })

  let lastErr = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await withTimeout(
        openaiClient.chat.completions.create({
          model: String(model || DEFAULT_TRAVEL_LLM_MODEL),
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        timeoutMs,
        'TRAVEL_LLM_TIMEOUT',
      )

      const text = extractCompletionText(response)
      const parsed = parseCalibrationPayload(text)
      if (!parsed) {
        lastErr = new Error('travel_llm_invalid_json')
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
          model: String(model || DEFAULT_TRAVEL_LLM_MODEL),
          attempt: i + 1,
          reasoning_mode: normalizeText(parsed.source_notes && parsed.source_notes.reasoning_mode, 80) || 'llm_calibration_v1',
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
        'aurora bff: travel llm calibration failed, trying fallback',
      )
    }
  }

  const timeoutErr = lastErr && String(lastErr.code || '').trim() === 'TRAVEL_LLM_TIMEOUT'
  return {
    stage,
    used: false,
    outcome: timeoutErr ? 'timeout' : 'error',
    travel_readiness: baseline,
    quality_flags: {},
    source_meta: {
      reason: timeoutErr ? 'timeout' : 'error',
      model: String(model || DEFAULT_TRAVEL_LLM_MODEL),
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
  },
}
