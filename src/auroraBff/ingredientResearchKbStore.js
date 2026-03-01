const crypto = require('crypto')
const { query } = require('../db')

const MAX_IN_MEMORY_ENTRIES = (() => {
  const n = Number(process.env.AURORA_INGREDIENT_RESEARCH_KB_MAX_MEM_ENTRIES || 1200)
  const v = Number.isFinite(n) ? Math.trunc(n) : 1200
  return Math.max(200, Math.min(12000, v))
})()

const DEFAULT_TTL_DAYS = (() => {
  const n = Number(process.env.AURORA_INGREDIENT_RESEARCH_KB_TTL_DAYS || 30)
  const v = Number.isFinite(n) ? Math.trunc(n) : 30
  return Math.max(1, Math.min(365, v))
})()

const state = {
  memIndex: new Map(),
  dbUnavailable: false,
}

function normalizeLang(lang) {
  const token = String(lang || 'EN').trim().toUpperCase()
  return token === 'CN' ? 'CN' : 'EN'
}

function normalizeQueryText(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  return raw
    .replace(/[^\p{L}\p{N}\s+\-/,().]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

function normalizeStatus(value) {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'ready' || token === 'fallback' || token === 'queued' || token === 'failed') return token
  return 'ready'
}

function normalizeLayer(value) {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'variant') return 'variant'
  return 'generic'
}

function normalizeVariantKey(value) {
  const token = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:=+-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return token.slice(0, 120)
}

function normalizeProvider(value) {
  const token = String(value || '').trim().toLowerCase()
  if (token === 'gemini' || token === 'openai') return token
  return null
}

function buildIngredientResearchKbKey({ query, lang, layer = 'generic', goal = '', sensitivity = '', variantKey = '' } = {}) {
  const q = normalizeQueryText(query)
  const language = normalizeLang(lang)
  const kbLayer = normalizeLayer(layer)
  const normalizedVariantKey =
    kbLayer === 'variant'
      ? normalizeVariantKey(
          variantKey || [goal ? `goal=${String(goal).trim().toLowerCase()}` : '', sensitivity ? `sensitivity=${String(sensitivity).trim().toLowerCase()}` : '']
            .filter(Boolean)
            .join(';'),
        )
      : ''
  if (!q) return null
  const hash = crypto.createHash('sha1').update(`${language}:${kbLayer}:${normalizedVariantKey}:${q}`).digest('hex')
  return `ing_research:${language}:${kbLayer}:${normalizedVariantKey}:${hash}`
}

function normalizeJsonbParam(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return JSON.stringify(value)
    if (s[0] === '{' || s[0] === '[' || s[0] === '"') return value
    return JSON.stringify(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return null
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

function touchLru(map, key, value) {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_IN_MEMORY_ENTRIES) {
    const oldestKey = map.keys().next().value
    if (!oldestKey) break
    map.delete(oldestKey)
  }
}

function mapRowToEntry(row) {
  if (!row) return null
  const kbKey = String(row.kb_key || '').trim()
  const queryNorm = String(row.query_norm || '').trim()
  if (!kbKey || !queryNorm) return null
  const payload =
    row.ingredient_profile_json && typeof row.ingredient_profile_json === 'object'
      ? row.ingredient_profile_json
      : coerceJson(row.ingredient_profile_json)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

  return {
    kb_key: kbKey,
    query_norm: queryNorm,
    lang: normalizeLang(row.lang),
    kb_layer: normalizeLayer(row.kb_layer),
    variant_key: normalizeVariantKey(row.variant_key),
    revision: Number.isFinite(Number(row.revision)) ? Math.max(1, Math.trunc(Number(row.revision))) : 1,
    status: normalizeStatus(row.status),
    provider: normalizeProvider(row.provider),
    error_code: String(row.error_code || '').trim() || null,
    ingredient_profile_json: payload,
    source_meta:
      row.source_meta && typeof row.source_meta === 'object'
        ? row.source_meta
        : coerceJson(row.source_meta) || {},
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  }
}

async function readFromDb(kbKey) {
  if (state.dbUnavailable) return null
  try {
    const res = await query(
      `
        SELECT
          kb_key,
          query_norm,
          lang,
          kb_layer,
          variant_key,
          revision,
          status,
          provider,
          error_code,
          ingredient_profile_json,
          source_meta,
          updated_at,
          expires_at
        FROM aurora_ingredient_research_kb
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
  const queryNorm = normalizeQueryText(entry && entry.query_norm)
  if (!kbKey || !queryNorm) return

  const lang = normalizeLang(entry.lang)
  const kbLayer = normalizeLayer(entry.kb_layer)
  const variantKey = normalizeVariantKey(entry.variant_key)
  const revision = Number.isFinite(Number(entry.revision)) ? Math.max(1, Math.trunc(Number(entry.revision))) : 1
  const status = normalizeStatus(entry.status)
  const provider = normalizeProvider(entry.provider)
  const errorCode = String(entry.error_code || '').trim() || null
  const payload = normalizeJsonbParam(entry.ingredient_profile_json || {})
  const sourceMeta = normalizeJsonbParam(entry.source_meta || {})
  const updatedAt = entry.updated_at ? new Date(entry.updated_at).toISOString() : new Date().toISOString()
  const expiresAt = entry.expires_at
    ? new Date(entry.expires_at).toISOString()
    : new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000).toISOString()

  try {
    await query(
      `
        INSERT INTO aurora_ingredient_research_kb (
          kb_key,
          query_norm,
          lang,
          kb_layer,
          variant_key,
          revision,
          status,
          provider,
          error_code,
          ingredient_profile_json,
          source_meta,
          updated_at,
          expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10::jsonb, $11::jsonb, $12::timestamptz, $13::timestamptz
        )
        ON CONFLICT (kb_key) DO UPDATE SET
          query_norm = EXCLUDED.query_norm,
          lang = EXCLUDED.lang,
          kb_layer = EXCLUDED.kb_layer,
          variant_key = EXCLUDED.variant_key,
          revision = EXCLUDED.revision,
          status = EXCLUDED.status,
          provider = EXCLUDED.provider,
          error_code = EXCLUDED.error_code,
          ingredient_profile_json = EXCLUDED.ingredient_profile_json,
          source_meta = EXCLUDED.source_meta,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at
      `,
      [
        kbKey,
        queryNorm,
        lang,
        kbLayer,
        variantKey,
        revision,
        status,
        provider,
        errorCode,
        payload,
        sourceMeta,
        updatedAt,
        expiresAt,
      ],
    )
  } catch (err) {
    const code = err && err.code ? String(err.code) : ''
    if (code === 'NO_DATABASE' || code === '42P01') state.dbUnavailable = true
    throw err
  }
}

async function getIngredientResearchKbEntry({ query, lang = 'EN', layer = 'generic', goal = '', sensitivity = '', variantKey = '' } = {}) {
  const kbKey = buildIngredientResearchKbKey({ query, lang, layer, goal, sensitivity, variantKey })
  if (!kbKey) return null

  const memHit = state.memIndex.get(kbKey)
  if (memHit) return memHit

  const dbHit = await readFromDb(kbKey)
  if (!dbHit) return null

  touchLru(state.memIndex, kbKey, dbHit)
  return dbHit
}

async function upsertIngredientResearchKbEntry(entry) {
  const kbKey = String(entry && entry.kb_key ? entry.kb_key : '').trim()
  const queryNorm = normalizeQueryText(entry && entry.query_norm)
  if (!kbKey || !queryNorm) return

  const normalized = {
    kb_key: kbKey,
    query_norm: queryNorm,
    lang: normalizeLang(entry.lang),
    kb_layer: normalizeLayer(entry.kb_layer),
    variant_key: normalizeVariantKey(entry.variant_key),
    revision: Number.isFinite(Number(entry.revision)) ? Math.max(1, Math.trunc(Number(entry.revision))) : 1,
    status: normalizeStatus(entry.status),
    provider: normalizeProvider(entry.provider),
    error_code: String(entry.error_code || '').trim() || null,
    ingredient_profile_json:
      entry.ingredient_profile_json &&
      typeof entry.ingredient_profile_json === 'object' &&
      !Array.isArray(entry.ingredient_profile_json)
        ? entry.ingredient_profile_json
        : {},
    source_meta:
      entry.source_meta &&
      typeof entry.source_meta === 'object' &&
      !Array.isArray(entry.source_meta)
        ? entry.source_meta
        : {},
    updated_at: entry.updated_at || new Date().toISOString(),
    expires_at: entry.expires_at || new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000).toISOString(),
  }

  touchLru(state.memIndex, kbKey, normalized)
  await upsertToDb(normalized)
}

module.exports = {
  buildIngredientResearchKbKey,
  getIngredientResearchKbEntry,
  upsertIngredientResearchKbEntry,
}
