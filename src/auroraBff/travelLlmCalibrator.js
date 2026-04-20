const crypto = require('node:crypto')
const { extractJsonObject, parseJsonOnlyObject } = require('./jsonExtract')
const {
  hasAuroraGeminiApiKey,
  callAuroraGeminiGenerateContentRestWithMeta,
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

const STRING_SCHEMA = (description, maxLength = 180) => ({
  type: 'STRING',
  ...(description ? { description } : {}),
  maxLength: String(maxLength),
})

const STRING_ARRAY_SCHEMA = (description, maxItems = 4, maxLength = 140) => ({
  type: 'ARRAY',
  ...(description ? { description } : {}),
  maxItems: String(maxItems),
  items: STRING_SCHEMA('', maxLength),
})

const TRAVEL_LLM_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: ['travel_readiness_patch'],
  propertyOrdering: ['travel_readiness_patch', 'quality_flags', 'source_notes'],
  properties: {
    travel_readiness_patch: {
      type: 'OBJECT',
      propertyOrdering: [
        'adaptive_actions',
        'personal_focus',
        'jetlag_sleep',
        'shopping_preview',
        'confidence',
      ],
      properties: {
        adaptive_actions: {
          type: 'ARRAY',
          maxItems: '2',
          items: {
            type: 'OBJECT',
            properties: {
              why: STRING_SCHEMA('Trip-specific environmental or schedule reason.', 180),
              what_to_do: STRING_SCHEMA('Concrete action for pre-trip, flight, or first 48h.', 220),
            },
          },
        },
        personal_focus: {
          type: 'ARRAY',
          maxItems: '1',
          items: {
            type: 'OBJECT',
            properties: {
              focus: STRING_SCHEMA('Profile or meeting-readiness focus.', 80),
              why: STRING_SCHEMA('Why this matters for this user.', 180),
              what_to_do: STRING_SCHEMA('Concrete action.', 220),
            },
          },
        },
        jetlag_sleep: {
          type: 'OBJECT',
          properties: {
            tz_home: STRING_SCHEMA('Origin timezone.', 64),
            tz_destination: STRING_SCHEMA('Destination timezone.', 64),
            hours_diff: { type: 'NUMBER' },
            risk_level: {
              type: 'STRING',
              enum: ['low', 'medium', 'high'],
            },
            sleep_tips: STRING_ARRAY_SCHEMA('Sleep timing tips.', 3, 160),
            mask_tips: STRING_ARRAY_SCHEMA('Skin recovery or eye-care tips.', 3, 160),
          },
        },
        shopping_preview: {
          type: 'OBJECT',
          properties: {
            brand_candidates: {
              type: 'ARRAY',
              maxItems: '4',
              items: {
                type: 'OBJECT',
                properties: {
                  brand: STRING_SCHEMA('Brand candidate.', 80),
                  match_status: {
                    type: 'STRING',
                    enum: ['kb_verified', 'catalog_verified', 'llm_only'],
                  },
                  reason: STRING_SCHEMA('Why the brand is relevant.', 140),
                },
              },
            },
            buying_channels: STRING_ARRAY_SCHEMA('Where to buy locally.', 5, 60),
            city_hint: STRING_SCHEMA('Destination city.', 120),
            note: STRING_SCHEMA('Short caveat.', 160),
          },
        },
        confidence: {
          type: 'OBJECT',
          properties: {
            level: {
              type: 'STRING',
              enum: ['low', 'medium', 'high'],
            },
            missing_inputs: STRING_ARRAY_SCHEMA('Missing information.', 5, 80),
            improve_by: STRING_ARRAY_SCHEMA('How user can improve personalization.', 4, 160),
            score: { type: 'NUMBER' },
          },
        },
      },
    },
    quality_flags: {
      type: 'OBJECT',
      properties: {
        structured_complete: { type: 'BOOLEAN' },
        safety_conflict: { type: 'BOOLEAN' },
        categories_covered: STRING_ARRAY_SCHEMA('Covered category ids.', 8, 60),
      },
    },
    source_notes: {
      type: 'OBJECT',
      properties: {
        reasoning_mode: STRING_SCHEMA('Short source mode.', 80),
      },
    },
  },
}

const DEFAULT_TRAVEL_LLM_MODEL = String(
  process.env.AURORA_TRAVEL_LLM_MODEL ||
    process.env.TRAVEL_LLM_MODEL ||
    'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview'

const DEFAULT_TRAVEL_GEMINI_TRANSPORT = String(
  process.env.AURORA_TRAVEL_GEMINI_TRANSPORT || 'rest',
).trim().toLowerCase()

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
      match_status: normalizeMatchStatus(row.match_status || row.matchStatus),
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
      product_source: normalizeProductSource(row.product_source || row.productSource),
      price: normalizeNumber(row.price),
      currency: normalizeText(row.currency, 12) || null,
    })
    if (products.length >= 3) break
  }

  const channels = normalizeStringArray(value.buying_channels || value.buyingChannels, 8, 60)
    .map((x) => x.toLowerCase())
    .filter((x) => ALLOWED_BUYING_CHANNELS.has(x))

  const brandCandidates = normalizeBrandCandidates(value.brand_candidates || value.brandCandidates)

  const out = {
    ...(products.length ? { products } : {}),
    ...(channels.length ? { buying_channels: channels } : {}),
    ...(brandCandidates.length ? { brand_candidates: brandCandidates } : {}),
    ...(normalizeText(value.city_hint || value.cityHint, 120) ? { city_hint: normalizeText(value.city_hint || value.cityHint, 120) } : {}),
    ...(normalizeText(value.note, 220) ? { note: normalizeText(value.note, 220) } : {}),
  }

  return Object.keys(out).length ? out : undefined
}

function normalizePatchWhy(row, maxLen = 260) {
  const src = isPlainObject(row) ? row : {}
  return normalizeText(
    src.why ||
      src.reason ||
      src.reasoning ||
      src.scenario ||
      src.context ||
      src.rationale,
    maxLen,
  )
}

function normalizePatchAction(row, maxLen = 320) {
  const src = isPlainObject(row) ? row : {}
  const action = normalizeText(
    src.what_to_do ||
      src.whatToDo ||
      src.action ||
      src.recommendation ||
      src.advice ||
      src.instruction,
    maxLen,
  )
  const timing = normalizeText(src.timing || src.phase || src.when, 80)
  if (!action) return ''
  if (!timing) return action
  const lowerAction = action.toLowerCase()
  const lowerTiming = timing.toLowerCase()
  return lowerAction.includes(lowerTiming) ? action : normalizeText(`${timing}: ${action}`, maxLen)
}

function normalizePatchFocus(row, maxLen = 120) {
  const src = isPlainObject(row) ? row : {}
  return normalizeText(
    src.focus ||
      src.priority ||
      src.need ||
      src.concern ||
      src.goal,
    maxLen,
  )
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
    ...(normalizeText(profile.currentRoutine, 320) ? { currentRoutine: normalizeText(profile.currentRoutine, 320) } : {}),
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
    ...(normalizeText(input.question, 320) ? { question: normalizeText(input.question, 320) } : {}),
    ...(isPlainObject(input.analysis_context_hard)
      ? { analysis_context_hard: compactLooseObjectForPrompt(input.analysis_context_hard, { maxEntries: 8, maxDepth: 2, maxText: 120 }) }
      : {}),
    ...(isPlainObject(input.analysis_context_soft)
      ? { analysis_context_soft: compactLooseObjectForPrompt(input.analysis_context_soft, { maxEntries: 8, maxDepth: 2, maxText: 120 }) }
      : {}),
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

function compactLooseValueForPrompt(value, { maxEntries = 8, maxDepth = 2, maxText = 140 } = {}, depth = 0) {
  if (value == null) return null
  if (typeof value === 'string') return normalizeText(value, maxText) || null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const out = []
    for (const item of value.slice(0, Math.max(1, maxEntries))) {
      const next = compactLooseValueForPrompt(item, { maxEntries: Math.min(5, maxEntries), maxDepth, maxText }, depth + 1)
      if (next == null) continue
      if (isPlainObject(next) && !Object.keys(next).length) continue
      if (Array.isArray(next) && !next.length) continue
      out.push(next)
    }
    return out.length ? out : null
  }
  if (isPlainObject(value)) {
    if (depth >= maxDepth) {
      const text = normalizeText(JSON.stringify(value), maxText)
      return text || null
    }
    return compactLooseObjectForPrompt(value, { maxEntries, maxDepth, maxText }, depth + 1)
  }
  return null
}

function compactLooseObjectForPrompt(value, { maxEntries = 8, maxDepth = 2, maxText = 140 } = {}, depth = 0) {
  if (!isPlainObject(value)) return {}
  const out = {}
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, Math.max(1, maxEntries))) {
    const key = normalizeText(rawKey, 64)
    if (!key) continue
    const next = compactLooseValueForPrompt(rawValue, { maxEntries, maxDepth, maxText }, depth)
    if (next == null) continue
    if (isPlainObject(next) && !Object.keys(next).length) continue
    if (Array.isArray(next) && !next.length) continue
    out[key] = next
  }
  return out
}

function compactRecoBundleForPrompt(rows) {
  return normalizeRecoBundle(rows).slice(0, 6).map((row) => ({
    trigger: normalizeText(row.trigger, 80) || null,
    action: normalizeText(row.action, 150) || null,
    product_types: normalizeStringArray(row.product_types, 4, 80),
    ingredient_logic: normalizeText(row.ingredient_logic, 150) || null,
    reapply_rule: normalizeText(row.reapply_rule, 120) || null,
  })).filter((row) => row.trigger || row.action || row.product_types.length)
}

function compactCategoryRecommendationsForPrompt(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const raw of rows.slice(0, 6)) {
    const row = isPlainObject(raw) ? raw : {}
    const category = normalizeText(row.category, 60)
    if (!category) continue
    const products = Array.isArray(row.products)
      ? row.products.slice(0, 3).map((prod) => {
          const item = isPlainObject(prod) ? prod : {}
          return {
            name: normalizeText(item.name, 90) || null,
            usage: normalizeText(item.usage, 120) || null,
          }
        }).filter((item) => item.name)
      : []
    out.push({
      category,
      why: normalizeText(row.why, 150) || null,
      products,
      skip_reason: normalizeText(row.skip_reason, 100) || null,
    })
  }
  return out
}

function compactShoppingPreviewForPrompt(value) {
  const preview = normalizeShoppingPreview(value)
  if (!preview) return undefined
  return {
    ...(Array.isArray(preview.products) && preview.products.length
      ? {
          products: preview.products.slice(0, 4).map((product) => ({
            name: normalizeText(product.name, 90) || null,
            brand: normalizeText(product.brand, 60) || null,
            category: normalizeText(product.category, 60) || null,
            product_source: normalizeProductSource(product.product_source),
          })).filter((product) => product.name),
        }
      : {}),
    ...(Array.isArray(preview.brand_candidates) && preview.brand_candidates.length
      ? { brand_candidates: preview.brand_candidates.slice(0, 4) }
      : {}),
    ...(Array.isArray(preview.buying_channels) && preview.buying_channels.length
      ? { buying_channels: preview.buying_channels.slice(0, 6) }
      : {}),
    ...(normalizeText(preview.city_hint, 80) ? { city_hint: normalizeText(preview.city_hint, 80) } : {}),
  }
}

function compactTravelReadinessForPrompt(value) {
  const readiness = isPlainObject(value) ? value : {}
  const jetlag = isPlainObject(readiness.jetlag_sleep) ? readiness.jetlag_sleep : {}
  return {
    ...(isPlainObject(readiness.destination_context)
      ? { destination_context: compactLooseObjectForPrompt(readiness.destination_context, { maxEntries: 8, maxDepth: 1, maxText: 100 }) }
      : {}),
    ...(isPlainObject(readiness.origin_context)
      ? { origin_context: compactLooseObjectForPrompt(readiness.origin_context, { maxEntries: 6, maxDepth: 1, maxText: 100 }) }
      : {}),
    ...(isPlainObject(readiness.delta_vs_home)
      ? { delta_vs_home: compactLooseObjectForPrompt(readiness.delta_vs_home, { maxEntries: 8, maxDepth: 2, maxText: 80 }) }
      : {}),
    ...(isPlainObject(readiness.delta_vs_origin)
      ? { delta_vs_origin: compactLooseObjectForPrompt(readiness.delta_vs_origin, { maxEntries: 8, maxDepth: 2, maxText: 80 }) }
      : {}),
    ...(Array.isArray(readiness.forecast_window)
      ? { forecast_window: normalizeForecastWindow(readiness.forecast_window).slice(0, 5) }
      : {}),
    ...(Array.isArray(readiness.alerts) ? { alerts: normalizeAlerts(readiness.alerts).slice(0, 3) } : {}),
    ...(isPlainObject(readiness.jetlag_sleep)
      ? {
          jetlag_sleep: {
            ...(normalizeText(jetlag.tz_origin || jetlag.tz_home, 64) ? { tz_origin: normalizeText(jetlag.tz_origin || jetlag.tz_home, 64) } : {}),
            ...(normalizeText(jetlag.tz_destination, 64) ? { tz_destination: normalizeText(jetlag.tz_destination, 64) } : {}),
            ...(normalizeNumber(jetlag.hours_diff) != null ? { hours_diff: normalizeNumber(jetlag.hours_diff) } : {}),
            ...(normalizeText(jetlag.risk_level, 24) ? { risk_level: normalizeText(jetlag.risk_level, 24) } : {}),
          },
        }
      : {}),
    ...(isPlainObject(readiness.confidence)
      ? { confidence: compactLooseObjectForPrompt(readiness.confidence, { maxEntries: 5, maxDepth: 1, maxText: 100 }) }
      : {}),
  }
}

function normalizeTravelReadinessPatch(value) {
  if (!isPlainObject(value)) return {}
  const out = {}

  const adaptiveActionsRaw = Array.isArray(value.adaptive_actions)
    ? value.adaptive_actions
    : Array.isArray(value.adaptiveActions) ? value.adaptiveActions : []
  if (adaptiveActionsRaw.length) {
    const adaptiveActions = []
    for (const raw of adaptiveActionsRaw) {
      const row = isPlainObject(raw) ? raw : {}
      const why = normalizePatchWhy(row, 260)
      const whatToDo = normalizePatchAction(row, 320)
      if (!why && !whatToDo) continue
      adaptiveActions.push({
        ...(why ? { why } : {}),
        ...(whatToDo ? { what_to_do: whatToDo } : {}),
      })
      if (adaptiveActions.length >= 6) break
    }
    if (adaptiveActions.length) out.adaptive_actions = adaptiveActions
  }

  const recoBundle = normalizeRecoBundle(value.reco_bundle || value.recoBundle)
  if (recoBundle.length) out.reco_bundle = recoBundle

  const storeExamples = normalizeStoreExamples(value.store_examples || value.storeExamples)
  if (storeExamples.length) out.store_examples = storeExamples

  const personalFocusRaw = Array.isArray(value.personal_focus)
    ? value.personal_focus
    : Array.isArray(value.personalFocus) ? value.personalFocus : []
  if (personalFocusRaw.length) {
    const personalFocus = []
    for (const raw of personalFocusRaw) {
      const row = isPlainObject(raw) ? raw : {}
      const focus = normalizePatchFocus(row, 120)
      const why = normalizePatchWhy(row, 260)
      const whatToDo = normalizePatchAction(row, 320)
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

  const jetlagNode = isPlainObject(value.jetlag_sleep)
    ? value.jetlag_sleep
    : isPlainObject(value.jetlagSleep) ? value.jetlagSleep : null
  if (jetlagNode) {
    const node = jetlagNode
    const jetlagSleep = {
      ...(normalizeText(node.tz_home || node.tzHome || node.tz_origin || node.tzOrigin, 64)
        ? { tz_home: normalizeText(node.tz_home || node.tzHome || node.tz_origin || node.tzOrigin, 64) }
        : {}),
      ...(normalizeText(node.tz_destination || node.tzDestination, 64)
        ? { tz_destination: normalizeText(node.tz_destination || node.tzDestination, 64) }
        : {}),
      ...(normalizeNumber(node.hours_diff || node.hoursDiff) != null ? { hours_diff: normalizeNumber(node.hours_diff || node.hoursDiff) } : {}),
      ...(normalizeText(node.risk_level || node.riskLevel, 24) ? { risk_level: normalizeText(node.risk_level || node.riskLevel, 24) } : {}),
      ...(normalizeStringArray(node.sleep_tips || node.sleepTips, 4, 220).length ? { sleep_tips: normalizeStringArray(node.sleep_tips || node.sleepTips, 4, 220) } : {}),
      ...(normalizeStringArray(node.mask_tips || node.maskTips, 4, 220).length ? { mask_tips: normalizeStringArray(node.mask_tips || node.maskTips, 4, 220) } : {}),
    }
    if (Object.keys(jetlagSleep).length) out.jetlag_sleep = jetlagSleep
  }

  const shoppingPreview = normalizeShoppingPreview(value.shopping_preview || value.shoppingPreview)
  if (shoppingPreview) out.shopping_preview = shoppingPreview

  const confidenceNode = isPlainObject(value.confidence) ? value.confidence : null
  if (confidenceNode) {
    const node = confidenceNode
    const confidence = {
      ...(normalizeText(node.level, 24) ? { level: normalizeText(node.level, 24) } : {}),
      ...(normalizeStringArray(node.missing_inputs || node.missingInputs, 12, 80).length ? { missing_inputs: normalizeStringArray(node.missing_inputs || node.missingInputs, 12, 80) } : {}),
      ...(normalizeStringArray(node.improve_by || node.improveBy, 8, 220).length ? { improve_by: normalizeStringArray(node.improve_by || node.improveBy, 8, 220) } : {}),
      ...(normalizeNumber(node.score) != null ? { score: normalizeNumber(node.score) } : {}),
    }
    if (Object.keys(confidence).length) out.confidence = confidence
  }

  const categoryRecommendationsRaw = Array.isArray(value.category_recommendations)
    ? value.category_recommendations
    : Array.isArray(value.categoryRecommendations) ? value.categoryRecommendations : []
  if (categoryRecommendationsRaw.length) {
    const categoryRecs = []
    for (const raw of categoryRecommendationsRaw) {
      const row = isPlainObject(raw) ? raw : {}
      const category = normalizeText(row.category, 40)
      if (!category) continue
      const products = Array.isArray(row.products) ? row.products.slice(0, 4).map((p) => {
        const prod = isPlainObject(p) ? p : {}
        return {
          name: normalizeText(prod.name, 140) || null,
          ingredient_logic: normalizeText(prod.ingredient_logic || prod.ingredientLogic, 260) || null,
          usage: normalizeText(prod.usage, 260) || null,
        }
      }).filter((p) => p.name) : []
      categoryRecs.push({
        category,
        why: normalizeText(row.why, 320) || null,
        products,
        skip_reason: normalizeText(row.skip_reason || row.skipReason, 160) || null,
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
  const texts = []
  const pushText = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) return
    if (!texts.includes(text)) texts.push(text)
  }
  pushText(response.text)
  const direct = await maybeCallText(response)
  pushText(direct)
  const nested = await maybeCallText(response.response)
  pushText(nested)
  pushText(response?.response?.text)
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const parts = []
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    for (const part of contentParts) {
      if (part && typeof part.text === 'string' && part.text.trim()) parts.push(part.text.trim())
    }
  }
  pushText(parts.join('\n'))
  for (const text of texts) {
    if (parseJsonOnlyObject(text) || extractJsonObject(text)) return text
  }
  return texts.sort((a, b) => b.length - a.length)[0] || ''
}

function extractGeminiResponseDebugMeta(response) {
  if (!response || typeof response !== 'object') return {}
  const candidates = Array.isArray(response.candidates) ? response.candidates : []
  const first = candidates.length ? candidates[0] : null
  const usage = response.usageMetadata && typeof response.usageMetadata === 'object'
    ? response.usageMetadata
    : response.usage_metadata && typeof response.usage_metadata === 'object'
      ? response.usage_metadata
      : null
  return {
    ...(normalizeText(first && (first.finishReason || first.finish_reason), 80)
      ? { finish_reason: normalizeText(first.finishReason || first.finish_reason, 80) }
      : {}),
    ...(normalizeText(first && (first.finishMessage || first.finish_message), 140)
      ? { finish_message: normalizeText(first.finishMessage || first.finish_message, 140) }
      : {}),
    ...(normalizeNumber(usage && (usage.promptTokenCount || usage.prompt_token_count)) != null
      ? { prompt_token_count: normalizeNumber(usage.promptTokenCount || usage.prompt_token_count) }
      : {}),
    ...(normalizeNumber(usage && (usage.candidatesTokenCount || usage.candidates_token_count)) != null
      ? { candidates_token_count: normalizeNumber(usage.candidatesTokenCount || usage.candidates_token_count) }
      : {}),
    ...(normalizeNumber(usage && (usage.totalTokenCount || usage.total_token_count)) != null
      ? { total_token_count: normalizeNumber(usage.totalTokenCount || usage.total_token_count) }
      : {}),
  }
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
      temperature: 0.15,
      maxOutputTokens: 1000,
      responseMimeType: 'application/json',
      thinkingConfig: {
        includeThoughts: false,
        thinkingBudget: 64,
      },
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

  const systemPrompt = [
    'You are a dermatologist-level travel skincare calibration layer. Return strict JSON only.',
    'Never diagnose, prescribe, invent weather/date/location facts, or rewrite immutable baseline numbers.',
    'Use profile, current routine, goals, sensitivity, barrier status, destination deltas, forecast, UV, humidity, and jet lag.',
    'Advice must be specific to this trip: pre-trip, flight, first 48h, and local buying.',
    'Return only valid minified JSON matching the requested shape. No markdown, no prose outside JSON, no trailing commas.',
    'Keep strings short and complete. Do not use ellipses or cut-off fragments.',
    'This is a micro-patch: return only adaptive_actions, personal_focus, jetlag_sleep tips if needed, shopping_preview.brand_candidates/channels, and confidence.',
    'Do not return category_recommendations or shopping_preview.products; the deterministic travel kit already carries product categories.',
    'Use exact action keys only: why and what_to_do. If timing matters, include timing inside what_to_do; do not use scenario/timing/action keys.',
    'Avoid generic copy and absolute claims like best/most.',
    'High humidity favors lighter AM texture; travel/flight favors PM barrier repair; UV>=6 requires SPF50+ reapply cadence and post-sun repair.',
    'Jet lag >=5h should add depuffing/hydration eye-care and sleep timing.',
    'Deduplicate: adaptive_actions=environment shifts without product names; personal_focus=profile priorities; shopping_preview=concrete product types/brand candidates.',
    'analysis_context_hard is strong context; analysis_context_soft is uncertain. Explicit profile wins conflicts.',
    (isPregnantOrLactating
      ? 'Active pregnancy/lactation: exclude retinoids, high-dose salicylic acid (>2%), hydroquinone; suggest safer alternatives.'
      : '') +
      (contraindications.length ? ` Avoid contraindications: ${contraindications.join(', ')}.` : ''),
  ].filter(Boolean).join('\n')

  const userPrompt =
    `language=${lang}\n` +
    'Task: output one compact travel_readiness_patch with category-specific, personalized, non-redundant skincare guidance.\n' +
    (goals.length ? `User goals: ${goals.join(', ')}\n` : '') +
    (hasRoutine ? `Current routine available: yes (see profile.currentRoutine in input)\n` : 'Current routine: not provided\n') +
    (isPregnantOrLactating ? 'Pregnancy/lactation: active — apply ingredient restrictions.\n' : '') +
    'Return JSON shape only: {"travel_readiness_patch":{...},"quality_flags":{"structured_complete":true},"source_notes":{"reasoning_mode":"llm_calibration_v2"}}\n' +
    'Limits: adaptive_actions<=2, personal_focus<=1, sleep_tips<=2, mask_tips<=2, brand_candidates<=3. No category_recommendations. No shopping_preview.products.\n' +
    'Local buying can name grounded brand/channel candidates, but do not invent SKU-level facts.\n' +
    `Fact input JSON:${JSON.stringify(promptTravelLlmInput || {})}\n` +
    `Current travel_readiness JSON:${JSON.stringify(promptBaseTravelReadiness || {})}`

  return { systemPrompt, userPrompt }
}

function parseCalibrationPayload(text) {
  const parsed = parseJsonOnlyObject(text) || extractJsonObject(text)
  if (!isPlainObject(parsed)) return null
  const patch = isPlainObject(parsed.travel_readiness_patch)
    ? parsed.travel_readiness_patch
    : isPlainObject(parsed.travelReadinessPatch)
      ? parsed.travelReadinessPatch
    : isPlainObject(parsed.travel_readiness)
      ? parsed.travel_readiness
      : isPlainObject(parsed.travelReadiness)
        ? parsed.travelReadiness
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

function classifyCalibrationParseFailure(text) {
  const parsed = parseJsonOnlyObject(text) || extractJsonObject(text)
  if (isPlainObject(parsed)) {
    return {
      code: 'TRAVEL_LLM_EMPTY_PATCH',
      status: 'json_ok_empty_patch',
    }
  }
  return {
    code: 'TRAVEL_LLM_INVALID_JSON',
    status: 'invalid_json',
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
      const totalTimeoutMs = Math.max(1000, Math.trunc(Number(timeoutMs || 3500) || 3500))
      const queueTimeoutMs = Math.min(800, Math.max(200, Math.floor(totalTimeoutMs * 0.12)))
      const upstreamTimeoutMs = Math.max(1200, totalTimeoutMs - queueTimeoutMs)
      const realGeminiCaller =
        DEFAULT_TRAVEL_GEMINI_TRANSPORT === 'sdk'
          ? callAuroraGeminiGenerateContentWithMeta
          : callAuroraGeminiGenerateContentRestWithMeta
      const callResult = typeof geminiGenerateContent === 'function'
        ? {
            response: await withTimeout(
              geminiGenerateContent(geminiRequest),
              timeoutMs,
              'TRAVEL_LLM_TIMEOUT',
            ),
            meta: {},
          }
        : await realGeminiCaller({
            featureEnvVar: 'AURORA_TRAVEL_GEMINI_API_KEY',
            route: 'aurora_travel_llm_calibration',
            request: geminiRequest,
            queueTimeoutMs,
            upstreamTimeoutMs,
          })

      const responseMeta = extractGeminiResponseDebugMeta(callResult && callResult.response)
      const text = await extractGeminiText(callResult && callResult.response)
      const parsed = parseCalibrationPayload(text)
      if (!parsed) {
        const failure = classifyCalibrationParseFailure(text)
        const parseErr = new Error('travel_llm_invalid_json')
        parseErr.code = failure.code
        parseErr.raw_text_chars = String(text || '').length
        parseErr.raw_text_excerpt = normalizeText(text, 800)
        parseErr.meta = {
          ...(isPlainObject(callResult && callResult.meta) ? callResult.meta : {}),
          ...responseMeta,
          parse_status: failure.status,
        }
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
          ...responseMeta,
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
  const errorMeta = isPlainObject(lastErr && lastErr.meta) ? lastErr.meta : {}
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
      ...(normalizeText(lastErr && lastErr.timeout_stage, 40) ? { timeout_stage: normalizeText(lastErr.timeout_stage, 40) } : {}),
      ...(normalizeNumber(errorMeta.gate_wait_ms) != null ? { gate_wait_ms: normalizeNumber(errorMeta.gate_wait_ms) } : {}),
      ...(normalizeNumber(errorMeta.upstream_ms) != null ? { upstream_ms: normalizeNumber(errorMeta.upstream_ms) } : {}),
      ...(normalizeNumber(errorMeta.total_ms) != null ? { total_ms: normalizeNumber(errorMeta.total_ms) } : {}),
      ...(normalizeText(errorMeta.finish_reason, 80) ? { finish_reason: normalizeText(errorMeta.finish_reason, 80) } : {}),
      ...(normalizeText(errorMeta.finish_message, 140) ? { finish_message: normalizeText(errorMeta.finish_message, 140) } : {}),
      ...(normalizeText(errorMeta.parse_status, 80) ? { parse_status: normalizeText(errorMeta.parse_status, 80) } : {}),
      ...(normalizeNumber(errorMeta.prompt_token_count) != null ? { prompt_token_count: normalizeNumber(errorMeta.prompt_token_count) } : {}),
      ...(normalizeNumber(errorMeta.candidates_token_count) != null ? { candidates_token_count: normalizeNumber(errorMeta.candidates_token_count) } : {}),
      ...(normalizeNumber(errorMeta.total_token_count) != null ? { total_token_count: normalizeNumber(errorMeta.total_token_count) } : {}),
      ...(normalizeNumber(lastErr && lastErr.raw_text_chars) != null ? { raw_text_chars: normalizeNumber(lastErr.raw_text_chars) } : {}),
      ...(normalizeText(lastErr && lastErr.raw_text_excerpt, 800) ? { raw_text_excerpt: normalizeText(lastErr.raw_text_excerpt, 800) } : {}),
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
    compactLooseObjectForPrompt,
    compactRecoBundleForPrompt,
    compactCategoryRecommendationsForPrompt,
    compactShoppingPreviewForPrompt,
    sanitizeBaselineIntegrity,
    deepMerge,
    parseCalibrationPayload,
    buildTravelCalibrationPrompts,
    buildGeminiRequest,
    TRAVEL_LLM_RESPONSE_SCHEMA,
    classifyCalibrationParseFailure,
    extractGeminiText,
    extractGeminiResponseDebugMeta,
    compactTravelLlmInputForPrompt,
    compactTravelReadinessForPrompt,
    buildPromptInputSummary,
    buildPromptTelemetry,
  },
}
