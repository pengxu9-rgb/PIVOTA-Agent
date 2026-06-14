const { query } = require('../db');
const {
  buildAuthoritativeIngredientView,
  mergeIngredientIntelWithAuthority,
  _internals: ingredientAuthorityInternals,
} = require('./pdpIngredientAuthority');

const TABLE_CHECK_TTL_MS = 60 * 1000;
const AUTHORITY_CACHE_TTL_MS = 60 * 1000;
const AUTHORITY_CACHE_MAX_ENTRIES = 500;
const tableAvailabilityCache = new Map();
const authorityCache = new Map();

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function uniqStrings(values, limit = 80) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = asString(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function coerceJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitIngredientText(value) {
  const text = asString(value);
  if (!text) return [];
  return ingredientAuthorityInternals.splitIngredientText(text);
}

function normalizeIngredientItems(values, max = 180) {
  return ingredientAuthorityInternals.normalizeIngredientItems(values, { max });
}

function flattenIngredientValue(value, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    const text = asString(value);
    if (!text) return [];
    return /[,;\n|•]/.test(text) ? splitIngredientText(text) : [text];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenIngredientValue(entry, depth + 1));
  }
  const obj = asPlainObject(value);
  if (!obj) return [];
  const direct = [
    obj.inci,
    obj.inci_name,
    obj.inciName,
    obj.name,
    obj.display_name,
    obj.displayName,
    obj.ingredient,
    obj.value,
    obj.text,
    obj.label,
  ].map(asString).filter(Boolean);
  if (direct.length) return direct;
  const nested = [
    obj.items,
    obj.values,
    obj.ingredients,
    obj.ingredient_list,
    obj.ingredientList,
    obj.inci_list,
    obj.inciList,
    obj.inci,
    obj.active_ingredients,
    obj.activeIngredients,
  ];
  return nested.flatMap((entry) => flattenIngredientValue(entry, depth + 1));
}

function buildReviewedIngredientKeyCandidates(product = {}, canonicalProductRef = null) {
  const merchantId = asString(
    canonicalProductRef?.merchant_id ||
      canonicalProductRef?.merchantId ||
      product.merchant_id ||
      product.merchantId ||
      product.merchant?.id,
  );
  const baseIds = uniqStrings([
    canonicalProductRef?.product_id,
    canonicalProductRef?.productId,
    product.product_id,
    product.productId,
    product.id,
    product.platform_product_id,
    product.platformProductId,
    product.shopify_id,
    product.shopifyId,
  ], 24);
  const scopedIds = [];
  for (const id of baseIds) {
    scopedIds.push(id);
    scopedIds.push(`product:${id}`);
    if (merchantId) {
      scopedIds.push(`${merchantId}:${id}`);
      scopedIds.push(`${merchantId}::${id}`);
      scopedIds.push(`merchant:${merchantId}:product:${id}`);
    }
  }
  return {
    merchantId: merchantId || null,
    keys: uniqStrings(scopedIds, 80),
  };
}

function buildAuthorityCacheKey({ keys, merchantId } = {}) {
  const normalizedKeys = uniqStrings(keys, 80).join('|');
  if (!normalizedKeys) return '';
  return `${asString(merchantId).toLowerCase()}::${normalizedKeys.toLowerCase()}`;
}

function readCachedAuthority(cacheKey, nowMs = Date.now()) {
  if (!cacheKey) return undefined;
  const cached = authorityCache.get(cacheKey);
  if (!cached) return undefined;
  if (Number(cached.expiresAtMs || 0) <= nowMs) {
    authorityCache.delete(cacheKey);
    return undefined;
  }
  authorityCache.delete(cacheKey);
  authorityCache.set(cacheKey, cached);
  return cached.authority || null;
}

function writeCachedAuthority(cacheKey, authority, nowMs = Date.now()) {
  if (!cacheKey) return;
  authorityCache.delete(cacheKey);
  authorityCache.set(cacheKey, {
    authority: authority || null,
    expiresAtMs: nowMs + AUTHORITY_CACHE_TTL_MS,
  });
  while (authorityCache.size > AUTHORITY_CACHE_MAX_ENTRIES) {
    const oldestKey = authorityCache.keys().next().value;
    if (!oldestKey) break;
    authorityCache.delete(oldestKey);
  }
}

function hasUsableAuthoritativeIngredientSource(product) {
  const authority = buildAuthoritativeIngredientView(product);
  return (
    authority?.purity_status === 'authoritative' &&
    ((Array.isArray(authority.items) && authority.items.length >= 3) ||
      (Array.isArray(authority.active_items) && authority.active_items.length > 0))
  );
}

async function isTableAvailable(regclassName, queryFn = query) {
  const key = asString(regclassName);
  if (!key) return false;
  const now = Date.now();
  const cached = tableAvailabilityCache.get(key);
  if (cached && now - cached.checkedAtMs < TABLE_CHECK_TTL_MS) {
    return cached.available === true;
  }
  try {
    const res = await queryFn(`SELECT to_regclass($1) AS table_name`, [key]);
    const available = Boolean(res?.rows?.[0]?.table_name);
    tableAvailabilityCache.set(key, { available, checkedAtMs: now });
    return available;
  } catch {
    tableAvailabilityCache.set(key, { available: false, checkedAtMs: now });
    return false;
  }
}

function buildAuthorityFromReviewedRow(row, sourceTable) {
  const normalizedJson =
    coerceJson(row?.normalized_ingredients_json) ||
    coerceJson(row?.normalizedIngredientsJson) ||
    coerceJson(row?.normalized_ingredients) ||
    coerceJson(row?.inci_json);
  const activeJson =
    coerceJson(row?.active_ingredients_json) ||
    coerceJson(row?.activeIngredientsJson) ||
    coerceJson(row?.active_ingredients);
  const rawText = asString(
    row?.raw_inci ||
      row?.rawInci ||
      row?.raw_ingredient_text_clean ||
      row?.inci_list ||
      row?.ingredients,
  );
  const items = normalizeIngredientItems([
    ...flattenIngredientValue(normalizedJson),
    ...splitIngredientText(rawText),
  ]);
  const activeItems = normalizeIngredientItems(flattenIngredientValue(activeJson), 32);
  if (!items.length && !activeItems.length) return null;

  return {
    raw_text: rawText || (items.length ? items.join(', ') : undefined),
    items,
    active_items: activeItems,
    source_origin: 'kb_reviewed',
    purity_status: 'authoritative',
    generated_at:
      asString(row?.updated_at) ||
      asString(row?.created_at) ||
      asString(row?.last_success_at) ||
      new Date().toISOString(),
    source_ref: {
      table: sourceTable,
      sku_key: asString(row?.sku_key) || undefined,
      product_key: asString(row?.product_key) || undefined,
      source_system: asString(row?.source_system) || asString(row?.source) || undefined,
    },
  };
}

async function fetchBeautySkuIngredientAuthority({ keys, merchantId, queryFn = query } = {}) {
  if (!Array.isArray(keys) || !keys.length) return null;
  if (!(await isTableAvailable('public.beauty_sku_ingredients', queryFn))) return null;
  try {
    const res = await queryFn(
      `
        SELECT
          sku_key,
          product_key,
          merchant_id,
          raw_inci,
          normalized_ingredients_json,
          active_ingredients_json,
          evidence_refs_json,
          source_system,
          created_at,
          updated_at
        FROM public.beauty_sku_ingredients
        WHERE
          (sku_key = ANY($1::text[]) OR product_key = ANY($1::text[]))
          AND (
            $2::text IS NULL
            OR merchant_id IS NULL
            OR merchant_id = ''
            OR merchant_id = $2::text
          )
        ORDER BY
          CASE
            WHEN merchant_id = $2::text THEN 0
            WHEN merchant_id IS NULL OR merchant_id = '' THEN 1
            ELSE 2
          END,
          updated_at DESC NULLS LAST,
          created_at DESC NULLS LAST,
          sku_key ASC
        LIMIT 4
      `,
      [keys, merchantId || null],
    );
    for (const row of Array.isArray(res?.rows) ? res.rows : []) {
      const authority = buildAuthorityFromReviewedRow(row, 'beauty_sku_ingredients');
      if (authority) return authority;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchPciSkuIngredientAuthority({ keys, queryFn = query } = {}) {
  if (!Array.isArray(keys) || !keys.length) return null;
  if (!(await isTableAvailable('pci_kb.sku_ingredients', queryFn))) return null;
  try {
    const res = await queryFn(
      `
        SELECT
          sku_key,
          raw_ingredient_text_clean,
          inci_list,
          source_ref,
          parse_status,
          review_status,
          audit_status,
          ingest_allowed,
          created_at
        FROM pci_kb.sku_ingredients
        WHERE
          sku_key = ANY($1::text[])
          AND (
            ingest_allowed = TRUE
            OR upper(coalesce(parse_status, '')) = 'OK'
          )
          AND lower(coalesce(review_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed')
          AND lower(coalesce(audit_status, '')) NOT IN ('reject', 'rejected', 'blocked', 'failed')
        ORDER BY created_at DESC NULLS LAST, sku_key ASC
        LIMIT 4
      `,
      [keys],
    );
    for (const row of Array.isArray(res?.rows) ? res.rows : []) {
      const authority = buildAuthorityFromReviewedRow(row, 'pci_kb.sku_ingredients');
      if (authority) return authority;
    }
  } catch {
    return null;
  }
  return null;
}

function buildContentKeyCandidate(product = {}, canonicalProductRef = null) {
  return asString(
    canonicalProductRef?.content_key ||
      canonicalProductRef?.contentKey ||
      product.content_key ||
      product.contentKey ||
      product.canonical_content_key,
  ) || null;
}

function hasEvidenceClaims(product = {}) {
  const ep = asPlainObject(product.evidence_profile);
  return !!(ep && Array.isArray(ep.claims) && ep.claims.length);
}

// Graded, provenance-backed claims (ProductClaim) the supplier-evidence intake
// writes to beauty_product_profiles.evidence_profile (per product_key). The
// canonical record is shared across the content_key cluster, so select the
// HIGHEST-PRECEDENCE one (brand-official / external_seed > supplier, per
// ADR-001), resolved by content_key — mirrors the backend agent_pdp_view
// assembler. Best-effort: returns null on any miss so the PDP never breaks.
async function fetchEvidenceProfileForContentKey({ contentKey, queryFn = query } = {}) {
  if (!contentKey) return null;
  if (!(await isTableAvailable('public.beauty_product_profiles', queryFn))) return null;
  try {
    const res = await queryFn(
      `
        SELECT bpp.evidence_profile, bpp.required_disclaimers
        FROM public.beauty_product_profiles bpp
        JOIN public.catalog_products cp ON cp.product_key = bpp.product_key
        WHERE cp.content_key = $1
          AND bpp.evidence_profile IS NOT NULL
        ORDER BY (bpp.merchant_id = 'external_seed') DESC, bpp.updated_at DESC NULLS LAST
        LIMIT 1
      `,
      [contentKey],
    );
    const row = Array.isArray(res?.rows) ? res.rows[0] : null;
    if (!row) return null;
    const evidenceProfile = coerceJson(row.evidence_profile);
    if (!evidenceProfile || !Array.isArray(evidenceProfile.claims) || !evidenceProfile.claims.length) {
      return null;
    }
    return {
      evidence_profile: evidenceProfile,
      required_disclaimers: coerceJson(row.required_disclaimers) || null,
    };
  } catch {
    return null;
  }
}

async function fetchReviewedIngredientAuthority({ product, canonicalProductRef = null, queryFn = query } = {}) {
  const { keys, merchantId } = buildReviewedIngredientKeyCandidates(product, canonicalProductRef);
  if (!keys.length) return null;
  const cacheKey = buildAuthorityCacheKey({ keys, merchantId });
  const cached = readCachedAuthority(cacheKey);
  if (cached !== undefined) return cached;
  const authority =
    (await fetchBeautySkuIngredientAuthority({ keys, merchantId, queryFn })) ||
    (await fetchPciSkuIngredientAuthority({ keys, queryFn })) ||
    null;
  writeCachedAuthority(cacheKey, authority);
  return authority;
}

async function hydrateProductWithReviewedIngredientAuthority({
  product,
  canonicalProductRef = null,
  queryFn = query,
} = {}) {
  let result = asPlainObject(product) || {};

  // Reviewed ingredient authority (actives / INCI) — gated: skip when the
  // product already carries a usable authoritative source.
  if (!hasUsableAuthoritativeIngredientSource(result)) {
    const authority = await fetchReviewedIngredientAuthority({
      product: result,
      canonicalProductRef,
      queryFn,
    });
    if (authority) {
      result = {
        ...result,
        ingredient_intel: mergeIngredientIntelWithAuthority(result.ingredient_intel, authority),
      };
    }
  }

  // Graded, claim-safe CLAIMS (evidence_profile) — the justify block. Attached
  // independently of the ingredient gate (a product can have ingredient
  // authority but not yet authored claims), fill-only-when-absent, best-effort.
  if (!hasEvidenceClaims(result)) {
    const contentKey = buildContentKeyCandidate(result, canonicalProductRef);
    const evidence = await fetchEvidenceProfileForContentKey({ contentKey, queryFn });
    if (evidence) {
      result = {
        ...result,
        evidence_profile: evidence.evidence_profile,
        ...(evidence.required_disclaimers
          ? { required_disclaimers: evidence.required_disclaimers }
          : {}),
      };
    }
  }

  return result;
}

module.exports = {
  fetchReviewedIngredientAuthority,
  hydrateProductWithReviewedIngredientAuthority,
  _internals: {
    buildAuthorityFromReviewedRow,
    buildAuthorityCacheKey,
    buildReviewedIngredientKeyCandidates,
    buildContentKeyCandidate,
    hasEvidenceClaims,
    fetchEvidenceProfileForContentKey,
    flattenIngredientValue,
    hasUsableAuthoritativeIngredientSource,
    isTableAvailable,
    resetTableAvailabilityCacheForTest: () => {
      tableAvailabilityCache.clear();
      authorityCache.clear();
    },
  },
};
