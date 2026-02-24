const { query } = require('../db')

const MAX_IN_MEMORY_ENTRIES = (() => {
  const n = Number(process.env.AURORA_TRAVEL_KB_MAX_MEM_ENTRIES || 800)
  const v = Number.isFinite(n) ? Math.trunc(n) : 800
  return Math.max(100, Math.min(8000, v))
})()

const state = {
  memIndex: new Map(),
  dbUnavailable: false,
}

function normalizeDestination(destination) {
  const raw = String(destination || '').trim().toLowerCase()
  if (!raw) return ''
  return raw
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160)
}

function normalizeMonthBucket(monthBucket) {
  const n = Number(monthBucket)
  if (!Number.isFinite(n)) return 0
  return Math.max(1, Math.min(12, Math.trunc(n)))
}

function normalizeLang(lang) {
  const token = String(lang || 'EN').trim().toUpperCase()
  return token === 'CN' ? 'CN' : 'EN'
}

function buildTravelKbKey({ destination, monthBucket, lang } = {}) {
  const destinationNorm = normalizeDestination(destination)
  const bucket = normalizeMonthBucket(monthBucket)
  const langCode = normalizeLang(lang)
  if (!destinationNorm || !bucket) return null
  return `${destinationNorm}:${bucket}:${langCode}`
}

function touchLru(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_IN_MEMORY_ENTRIES) {
    const oldestKey = map.keys().next().value
    if (!oldestKey) break
    map.delete(oldestKey)
  }
}

function coerceJson(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function normalizeJsonbParam(value) {
  if (value === undefined) return undefined
  if (value === null) return null

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return JSON.stringify(value)
    const first = trimmed[0]
    if (first === '{' || first === '[' || first === '"') return value
    return JSON.stringify(value)
  }

  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function mapRowToEntry(row) {
  if (!row) return null
  const kbKey = String(row.kb_key || '').trim()
  if (!kbKey) return null
  return {
    kb_key: kbKey,
    destination_norm: String(row.destination_norm || '').trim() || null,
    month_bucket: normalizeMonthBucket(row.month_bucket),
    lang: normalizeLang(row.lang),
    climate_delta_profile:
      row.climate_delta_profile && typeof row.climate_delta_profile === 'object'
        ? row.climate_delta_profile
        : coerceJson(row.climate_delta_profile) || {},
    adaptive_actions:
      Array.isArray(row.adaptive_actions)
        ? row.adaptive_actions
        : coerceJson(row.adaptive_actions) || [],
    product_type_recos:
      Array.isArray(row.product_type_recos)
        ? row.product_type_recos
        : coerceJson(row.product_type_recos) || [],
    local_brand_candidates:
      Array.isArray(row.local_brand_candidates)
        ? row.local_brand_candidates
        : coerceJson(row.local_brand_candidates) || [],
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
    quality_flags:
      row.quality_flags && typeof row.quality_flags === 'object'
        ? row.quality_flags
        : coerceJson(row.quality_flags) || {},
    source_meta:
      row.source_meta && typeof row.source_meta === 'object'
        ? row.source_meta
        : coerceJson(row.source_meta) || {},
    last_success_at: row.last_success_at ? new Date(row.last_success_at).toISOString() : null,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

async function readFromDb(kbKey) {
  if (state.dbUnavailable) return null
  try {
    const res = await query(
      `
        SELECT
          kb_key,
          destination_norm,
          month_bucket,
          lang,
          climate_delta_profile,
          adaptive_actions,
          product_type_recos,
          local_brand_candidates,
          confidence,
          quality_flags,
          source_meta,
          last_success_at,
          expires_at,
          created_at,
          updated_at
        FROM aurora_travel_context_kb
        WHERE kb_key = $1
          AND expires_at > now()
        LIMIT 1
      `,
      [kbKey],
    )
    const row = res && Array.isArray(res.rows) ? res.rows[0] : null
    return mapRowToEntry(row)
  } catch (err) {
    const code = err && err.code ? String(err.code) : ''
    if (code === 'NO_DATABASE' || code === '42P01') {
      state.dbUnavailable = true
      return null
    }
    return null
  }
}

async function upsertToDb(entry) {
  if (state.dbUnavailable) {
    const err = new Error('NO_DATABASE')
    err.code = 'NO_DATABASE'
    throw err
  }
  const kbKey = String(entry && entry.kb_key ? entry.kb_key : '').trim()
  if (!kbKey) return

  const destinationNorm = normalizeDestination(entry.destination_norm)
  const monthBucket = normalizeMonthBucket(entry.month_bucket)
  const lang = normalizeLang(entry.lang)
  if (!destinationNorm || !monthBucket) return

  const climateDeltaProfile = normalizeJsonbParam(entry.climate_delta_profile || {})
  const adaptiveActions = normalizeJsonbParam(Array.isArray(entry.adaptive_actions) ? entry.adaptive_actions : [])
  const productTypeRecos = normalizeJsonbParam(Array.isArray(entry.product_type_recos) ? entry.product_type_recos : [])
  const localBrandCandidates = normalizeJsonbParam(Array.isArray(entry.local_brand_candidates) ? entry.local_brand_candidates : [])
  const qualityFlags = normalizeJsonbParam(entry.quality_flags || {})
  const sourceMeta = normalizeJsonbParam(entry.source_meta || {})
  const confidence = Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0
  const lastSuccessAt = entry.last_success_at ? new Date(entry.last_success_at).toISOString() : new Date().toISOString()
  const expiresAt = entry.expires_at ? new Date(entry.expires_at).toISOString() : new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString()

  try {
    await query(
      `
        INSERT INTO aurora_travel_context_kb (
          kb_key,
          destination_norm,
          month_bucket,
          lang,
          climate_delta_profile,
          adaptive_actions,
          product_type_recos,
          local_brand_candidates,
          confidence,
          quality_flags,
          source_meta,
          last_success_at,
          expires_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4,
          $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb,
          $9, $10::jsonb, $11::jsonb,
          $12::timestamptz, $13::timestamptz,
          now()
        )
        ON CONFLICT (kb_key) DO UPDATE SET
          destination_norm = EXCLUDED.destination_norm,
          month_bucket = EXCLUDED.month_bucket,
          lang = EXCLUDED.lang,
          climate_delta_profile = EXCLUDED.climate_delta_profile,
          adaptive_actions = EXCLUDED.adaptive_actions,
          product_type_recos = EXCLUDED.product_type_recos,
          local_brand_candidates = EXCLUDED.local_brand_candidates,
          confidence = EXCLUDED.confidence,
          quality_flags = EXCLUDED.quality_flags,
          source_meta = EXCLUDED.source_meta,
          last_success_at = EXCLUDED.last_success_at,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      `,
      [
        kbKey,
        destinationNorm,
        monthBucket,
        lang,
        climateDeltaProfile,
        adaptiveActions,
        productTypeRecos,
        localBrandCandidates,
        confidence,
        qualityFlags,
        sourceMeta,
        lastSuccessAt,
        expiresAt,
      ],
    )
  } catch (err) {
    const code = err && err.code ? String(err.code) : ''
    if (code === 'NO_DATABASE' || code === '42P01') state.dbUnavailable = true
    throw err
  }
}

async function getTravelContextKbEntry({ destination, monthBucket, lang = 'EN' } = {}) {
  const kbKey = buildTravelKbKey({ destination, monthBucket, lang })
  if (!kbKey) return null

  const memHit = state.memIndex.get(kbKey)
  if (memHit) return memHit

  const dbHit = await readFromDb(kbKey)
  if (!dbHit) return null

  touchLru(state.memIndex, kbKey, dbHit)
  return dbHit
}

async function upsertTravelContextKbEntry(entry) {
  const kbKey = String(entry && entry.kb_key ? entry.kb_key : '').trim()
  if (!kbKey) return

  const normalized = {
    kb_key: kbKey,
    destination_norm: normalizeDestination(entry.destination_norm),
    month_bucket: normalizeMonthBucket(entry.month_bucket),
    lang: normalizeLang(entry.lang),
    climate_delta_profile:
      entry.climate_delta_profile && typeof entry.climate_delta_profile === 'object' && !Array.isArray(entry.climate_delta_profile)
        ? entry.climate_delta_profile
        : {},
    adaptive_actions: Array.isArray(entry.adaptive_actions) ? entry.adaptive_actions : [],
    product_type_recos: Array.isArray(entry.product_type_recos) ? entry.product_type_recos : [],
    local_brand_candidates: Array.isArray(entry.local_brand_candidates) ? entry.local_brand_candidates : [],
    confidence: Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : 0,
    quality_flags:
      entry.quality_flags && typeof entry.quality_flags === 'object' && !Array.isArray(entry.quality_flags)
        ? entry.quality_flags
        : {},
    source_meta:
      entry.source_meta && typeof entry.source_meta === 'object' && !Array.isArray(entry.source_meta)
        ? entry.source_meta
        : {},
    last_success_at: entry.last_success_at || new Date().toISOString(),
    expires_at: entry.expires_at || new Date(Date.now() + 45 * 24 * 3600 * 1000).toISOString(),
  }

  if (!normalized.destination_norm || !normalized.month_bucket) return

  touchLru(state.memIndex, kbKey, normalized)
  await upsertToDb(normalized)
}

module.exports = {
  normalizeDestination,
  normalizeMonthBucket,
  normalizeLang,
  buildTravelKbKey,
  getTravelContextKbEntry,
  upsertTravelContextKbEntry,
}
