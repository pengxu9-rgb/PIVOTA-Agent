const { buildTravelKbKey, normalizeDestination, normalizeLang, normalizeMonthBucket } = require('./travelKbStore')

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value, maxLen = 220) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  return text.slice(0, maxLen)
}

function confidenceLevelToScore(level) {
  const token = String(level || '').trim().toLowerCase()
  if (token === 'high') return 0.9
  if (token === 'medium') return 0.72
  if (token === 'low') return 0.5
  return 0.5
}

function inferConfidenceScore(confidenceNode) {
  const node = isPlainObject(confidenceNode) ? confidenceNode : {}
  const numeric = Number(node.score)
  if (Number.isFinite(numeric)) {
    if (numeric <= 1) return Math.max(0, Math.min(1, numeric))
    if (numeric <= 100) return Math.max(0, Math.min(1, numeric / 100))
  }
  return confidenceLevelToScore(node.level)
}

function hasCompleteTravelReadiness(readiness) {
  const node = isPlainObject(readiness) ? readiness : {}
  const destinationContext = isPlainObject(node.destination_context) ? node.destination_context : null
  const deltaVsHome = isPlainObject(node.delta_vs_home) ? node.delta_vs_home : null
  const jetlagSleep = isPlainObject(node.jetlag_sleep) ? node.jetlag_sleep : null
  const shoppingPreview = isPlainObject(node.shopping_preview) ? node.shopping_preview : null

  const destinationOk = Boolean(normalizeText(destinationContext && destinationContext.destination, 140))
  const deltaOk = Boolean(
    deltaVsHome &&
      (
        Array.isArray(deltaVsHome.summary_tags) && deltaVsHome.summary_tags.length > 0 ||
        isPlainObject(deltaVsHome.temperature) ||
        isPlainObject(deltaVsHome.humidity) ||
        isPlainObject(deltaVsHome.uv) ||
        isPlainObject(deltaVsHome.wind) ||
        isPlainObject(deltaVsHome.precip)
      ),
  )
  const adaptiveOk = Array.isArray(node.adaptive_actions) && node.adaptive_actions.length > 0
  const focusOk = Array.isArray(node.personal_focus) && node.personal_focus.length > 0
  const jetlagOk = Boolean(jetlagSleep && (Number.isFinite(Number(jetlagSleep.hours_diff)) || normalizeText(jetlagSleep.risk_level, 40)))
  const shoppingOk = Boolean(
    shoppingPreview &&
      (
        Array.isArray(shoppingPreview.products) && shoppingPreview.products.length > 0 ||
        Array.isArray(shoppingPreview.brand_candidates) && shoppingPreview.brand_candidates.length > 0
      ) &&
      Array.isArray(shoppingPreview.buying_channels) &&
      shoppingPreview.buying_channels.length > 0,
  )
  const confidenceOk = isPlainObject(node.confidence)
  return destinationOk && deltaOk && adaptiveOk && focusOk && jetlagOk && shoppingOk && confidenceOk
}

function normalizeBrandMatchStatus(raw) {
  const token = String(raw || '').trim().toLowerCase()
  if (token === 'kb_verified' || token === 'catalog_verified' || token === 'llm_only') return token
  return 'llm_only'
}

function normalizeBrandCandidates(readiness) {
  const node = isPlainObject(readiness) ? readiness : {}
  const shoppingPreview = isPlainObject(node.shopping_preview) ? node.shopping_preview : {}
  const fromPayload = Array.isArray(shoppingPreview.brand_candidates) ? shoppingPreview.brand_candidates : []
  const out = []
  const seen = new Set()

  for (const row of fromPayload) {
    const item = isPlainObject(row) ? row : {}
    const brand = normalizeText(item.brand, 80)
    if (!brand) continue
    const key = brand.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      brand,
      match_status: normalizeBrandMatchStatus(item.match_status),
      reason: normalizeText(item.reason, 180) || null,
    })
    if (out.length >= 6) break
  }

  if (out.length >= 3) return out
  const products = Array.isArray(shoppingPreview.products) ? shoppingPreview.products : []
  for (const row of products) {
    const item = isPlainObject(row) ? row : {}
    const brand = normalizeText(item.brand, 80)
    if (!brand) continue
    const key = brand.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      brand,
      match_status: 'catalog_verified',
      reason: normalizeText(item.category, 80) || null,
    })
    if (out.length >= 6) break
  }

  return out
}

function normalizeProductTypeRecos(readiness) {
  const node = isPlainObject(readiness) ? readiness : {}
  const shoppingPreview = isPlainObject(node.shopping_preview) ? node.shopping_preview : {}
  const products = Array.isArray(shoppingPreview.products) ? shoppingPreview.products : []
  const out = []
  const seen = new Set()
  for (const row of products) {
    const item = isPlainObject(row) ? row : {}
    const category = normalizeText(item.category, 60)
    if (!category) continue
    const key = category.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      category,
      top_reason:
        Array.isArray(item.reasons) && item.reasons.length > 0
          ? normalizeText(item.reasons[0], 180) || null
          : null,
    })
    if (out.length >= 6) break
  }
  return out
}

function evaluateTravelKbBackfill({
  travelReadiness,
  minConfidence = 0.72,
  hasSafetyConflict = false,
} = {}) {
  if (!isPlainObject(travelReadiness)) {
    return { eligible: false, reason: 'missing_travel_readiness', confidence_score: 0 }
  }

  if (!hasCompleteTravelReadiness(travelReadiness)) {
    return { eligible: false, reason: 'incomplete_structure', confidence_score: 0 }
  }

  const confidenceScore = inferConfidenceScore(travelReadiness.confidence)
  if (confidenceScore < Math.max(0, Math.min(1, Number(minConfidence) || 0.72))) {
    return {
      eligible: false,
      reason: 'low_confidence',
      confidence_score: confidenceScore,
    }
  }

  if (hasSafetyConflict) {
    return {
      eligible: false,
      reason: 'safety_conflict',
      confidence_score: confidenceScore,
    }
  }

  return {
    eligible: true,
    reason: 'eligible',
    confidence_score: confidenceScore,
  }
}

function inferMonthBucketFromTravelReadiness(readiness) {
  const node = isPlainObject(readiness) ? readiness : {}
  const ctx = isPlainObject(node.destination_context) ? node.destination_context : {}
  const token = normalizeText(ctx.start_date, 16)
  if (!token || !/^\d{4}-\d{2}-\d{2}$/.test(token)) return new Date().getUTCMonth() + 1
  const month = Number(token.slice(5, 7))
  return normalizeMonthBucket(month) || (new Date().getUTCMonth() + 1)
}

function buildTravelKbUpsertEntry({
  destination,
  monthBucket,
  lang = 'EN',
  travelReadiness,
  confidenceScore = null,
  qualityFlags = {},
  sourceMeta = {},
  ttlDays = 45,
  nowMs = Date.now(),
} = {}) {
  const destinationNorm = normalizeDestination(destination)
  const bucket = normalizeMonthBucket(monthBucket || inferMonthBucketFromTravelReadiness(travelReadiness))
  const langCode = normalizeLang(lang)
  const kbKey = buildTravelKbKey({ destination: destinationNorm, monthBucket: bucket, lang: langCode })
  if (!kbKey) return null

  const readiness = isPlainObject(travelReadiness) ? travelReadiness : {}
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const ttl = Math.max(1, Math.min(120, Math.trunc(Number(ttlDays) || 45)))
  const expiresAt = new Date(now + ttl * 24 * 3600 * 1000).toISOString()

  const computedScore =
    Number.isFinite(Number(confidenceScore)) ? Number(confidenceScore) : inferConfidenceScore(readiness.confidence)

  return {
    kb_key: kbKey,
    destination_norm: destinationNorm,
    month_bucket: bucket,
    lang: langCode,
    climate_delta_profile: isPlainObject(readiness.delta_vs_home) ? readiness.delta_vs_home : {},
    adaptive_actions: Array.isArray(readiness.adaptive_actions) ? readiness.adaptive_actions.slice(0, 8) : [],
    product_type_recos: normalizeProductTypeRecos(readiness),
    local_brand_candidates: normalizeBrandCandidates(readiness),
    confidence: Math.max(0, Math.min(1, computedScore)),
    quality_flags: isPlainObject(qualityFlags) ? qualityFlags : {},
    source_meta: isPlainObject(sourceMeta) ? sourceMeta : {},
    last_success_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  }
}

module.exports = {
  confidenceLevelToScore,
  inferConfidenceScore,
  evaluateTravelKbBackfill,
  buildTravelKbUpsertEntry,
  normalizeBrandMatchStatus,
  __internal: {
    hasCompleteTravelReadiness,
    normalizeBrandCandidates,
    normalizeProductTypeRecos,
    inferMonthBucketFromTravelReadiness,
  },
}
