'use strict';

const { query: defaultQuery } = require('../db');
const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');
const productRelationshipGraphSources = require('../auroraBff/productRelationshipGraphSources');

const relationshipGraphSourcesInternal = productRelationshipGraphSources.__internal || {};
const relationshipGraphFamilyIdentityKey =
  relationshipGraphSourcesInternal.familyIdentityKey ||
  productRelationshipGraphSources.familyIdentityKey ||
  (() => '');

const RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_ENABLED =
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_ENABLED !== 'false';
const RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE = new Map();
const RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS = {
  hits: 0,
  misses: 0,
  sets: 0,
  bypasses: 0,
};
const RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_TTL_MS = parseTimeoutMs(
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_TTL_MS ||
    process.env.RESOLVE_PRODUCT_GROUP_CACHE_TTL_MS,
  10 * 60 * 1000,
);

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function parseTimeoutMs(raw, fallbackMs) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.max(1_000, Math.floor(n));
}

function asPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return '';
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isSigId(value) {
  return /^sig_[a-z0-9]+$/i.test(asString(value));
}

function looksLikeRelationMissing(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return (
    err?.code === '42P01' ||
    message.includes('does not exist') ||
    message.includes('relation') ||
    message.includes('catalog_products') ||
    message.includes('product_group_members')
  );
}

function buildPublicProductUrl(entityId) {
  const normalizedEntityId = asString(entityId);
  return normalizedEntityId ? `https://agent.pivota.cc/products/${normalizedEntityId}` : '';
}

function normalizeRelationshipGraphRefForResolution(value) {
  const inputRef = asString(value);
  const normalizedRef = inputRef.toLowerCase();
  const refKey = normalizedRef.replace(/^[a-z][a-z0-9_+-]*:/i, '').trim();
  return {
    input_ref: inputRef,
    normalized_ref: normalizedRef,
    ref_key: refKey,
  };
}

function pickRelationshipGraphFamilyKey(product, fallbackRef) {
  const shaped = {
    ...(asPlainObject(product) || {}),
    product_ref: fallbackRef,
  };
  const explicitFamily = firstNonEmptyString(
    shaped.product_family_id,
    shaped.productFamilyId,
    shaped.product_line_id,
    shaped.productLineId,
    shaped.variant_of,
    shaped.variantOf,
  );
  if (explicitFamily) {
    return {
      family_key: `family:${asString(explicitFamily).toLowerCase()}`,
      family_key_source: 'product_family_id',
    };
  }
  const derived = relationshipGraphFamilyIdentityKey(shaped);
  if (asString(derived).startsWith('family:v1:')) {
    return {
      family_key: derived,
      family_key_source: 'derived_family_key',
    };
  }
  return {
    family_key: '',
    family_key_source: '',
  };
}

function fallbackRelationshipGraphResolutionContext(ref, snapshot = null) {
  const normalized = normalizeRelationshipGraphRefForResolution(ref);
  const fallbackSnapshot = asPlainObject(snapshot) || {};
  const family = pickRelationshipGraphFamilyKey(fallbackSnapshot, normalized.normalized_ref);
  return {
    input_ref: normalized.input_ref,
    normalized_ref: normalized.normalized_ref,
    brand: firstNonEmptyString(
      fallbackSnapshot.brand,
      fallbackSnapshot.brand_name,
      fallbackSnapshot.brandName,
      fallbackSnapshot.vendor,
    ) || null,
    title: firstNonEmptyString(
      fallbackSnapshot.title,
      fallbackSnapshot.name,
      fallbackSnapshot.display_name,
      fallbackSnapshot.displayName,
      fallbackSnapshot.product_name,
      fallbackSnapshot.productName,
    ) || null,
    category: firstNonEmptyString(fallbackSnapshot.category) || null,
    product_type: firstNonEmptyString(
      fallbackSnapshot.product_type,
      fallbackSnapshot.productType,
    ) || null,
    product_group_id: null,
    pivota_signature_id: null,
    canonical_entity_id: null,
    canonical_url: null,
    pivota_canonical_url: null,
    display_snapshot: Object.keys(fallbackSnapshot).length ? { ...fallbackSnapshot } : null,
    display_snapshot_source: Object.keys(fallbackSnapshot).length ? 'edge_snapshot' : 'fallback_ref',
    family_key: family.family_key || `ref:${normalized.normalized_ref}`,
    family_key_source: family.family_key_source || 'fallback_ref',
    resolved: false,
  };
}

function buildRelationshipGraphDisplaySnapshot(row = {}) {
  const productPayload = asPlainObject(row.product_payload) || {};
  const payloadSnapshot = asPlainObject(productPayload.snapshot) || {};
  const productFamilyId = firstNonEmptyString(row.product_family_id);
  const productGroupId = firstNonEmptyString(row.product_group_id);
  const pivotaSignatureId = firstNonEmptyString(row.pivota_signature_id);
  const sourceProductId = firstNonEmptyString(row.source_product_id);
  const canonicalEntityId = firstNonEmptyString(productFamilyId, productGroupId, pivotaSignatureId, sourceProductId);
  const publicUrl = buildPublicProductUrl(canonicalEntityId);
  const merchantCanonicalUrl = firstNonEmptyString(
    row.canonical_url,
    row.pivota_canonical_url,
    productPayload.canonical_url,
    productPayload.canonicalUrl,
    productPayload.url,
    payloadSnapshot.canonical_url,
    payloadSnapshot.url,
  );
  const title = firstNonEmptyString(row.title, productPayload.title, productPayload.name, payloadSnapshot.title, payloadSnapshot.name);
  const brand = firstNonEmptyString(row.brand, productPayload.brand, payloadSnapshot.brand);
  const imageUrl = firstNonEmptyString(
    row.image_url,
    productPayload.image_url,
    productPayload.imageUrl,
    payloadSnapshot.image_url,
    payloadSnapshot.image,
  );
  const category = firstNonEmptyString(row.category, productPayload.category, payloadSnapshot.category);
  const productType = firstNonEmptyString(row.product_type, productPayload.product_type, productPayload.productType);
  const price = firstNonEmptyString(
    productPayload.price_amount,
    productPayload.priceAmount,
    productPayload.price,
    payloadSnapshot.price_amount,
    payloadSnapshot.price,
  );
  return {
    ...(canonicalEntityId ? { id: canonicalEntityId, product_id: canonicalEntityId, canonical_entity_id: canonicalEntityId } : {}),
    ...(sourceProductId
      ? {
          source_product_id: sourceProductId,
          external_product_id: sourceProductId,
          external_seed_product_id: sourceProductId,
          platform_product_id: sourceProductId,
        }
      : {}),
    ...(productFamilyId ? { product_family_id: productFamilyId } : {}),
    ...(productGroupId ? { product_group_id: productGroupId } : {}),
    ...(pivotaSignatureId ? { pivota_signature_id: pivotaSignatureId, signature_id: pivotaSignatureId } : {}),
    ...(title ? { title, name: title } : {}),
    ...(brand ? { brand } : {}),
    ...(category ? { category } : {}),
    ...(productType ? { product_type: productType } : {}),
    ...(publicUrl ? { url: publicUrl, canonical_url: publicUrl, pivota_canonical_url: publicUrl } : {}),
    ...(merchantCanonicalUrl && merchantCanonicalUrl !== publicUrl ? { merchant_canonical_url: merchantCanonicalUrl } : {}),
    ...(imageUrl ? { image_url: imageUrl } : {}),
    ...(price ? { price } : {}),
  };
}

function relationshipGraphResolutionContextFromRow(row = {}, fallbackSnapshot = null) {
  const normalized = normalizeRelationshipGraphRefForResolution(row.input_ref || row.normalized_ref);
  const productFamilyId = firstNonEmptyString(row.product_family_id);
  const product = {
    product_ref: normalized.normalized_ref,
    product_family_id: productFamilyId,
    name: firstNonEmptyString(row.title),
    title: firstNonEmptyString(row.title),
    brand: firstNonEmptyString(row.brand),
    category: firstNonEmptyString(row.category),
    product_type: firstNonEmptyString(row.product_type),
  };
  let family = pickRelationshipGraphFamilyKey(product, normalized.normalized_ref);
  if (!family.family_key && fallbackSnapshot) {
    family = pickRelationshipGraphFamilyKey(fallbackSnapshot, normalized.normalized_ref);
  }
  const productGroupId = firstNonEmptyString(row.product_group_id);
  const pivotaSignatureId = firstNonEmptyString(row.pivota_signature_id);
  const canonicalEntityId = firstNonEmptyString(productFamilyId, productGroupId, pivotaSignatureId, row.source_product_id);
  const publicUrl = buildPublicProductUrl(canonicalEntityId);
  let displaySnapshotSource = 'canonical_catalog';
  if (productFamilyId) displaySnapshotSource = 'product_family_id';
  else if (row.is_primary === true) displaySnapshotSource = 'product_group_primary';
  else if (firstNonEmptyString(row.pdp_lifecycle_stage)) {
    displaySnapshotSource = `catalog_${firstNonEmptyString(row.pdp_lifecycle_stage).toLowerCase()}`;
  }
  return {
    input_ref: normalized.input_ref,
    normalized_ref: normalized.normalized_ref,
    brand: firstNonEmptyString(row.brand) || null,
    title: firstNonEmptyString(row.title) || null,
    category: firstNonEmptyString(row.category) || null,
    product_type: firstNonEmptyString(row.product_type) || null,
    product_group_id: productGroupId || null,
    pivota_signature_id: pivotaSignatureId || null,
    canonical_entity_id: canonicalEntityId || null,
    canonical_url: publicUrl || firstNonEmptyString(row.canonical_url, row.pivota_canonical_url) || null,
    pivota_canonical_url: publicUrl || firstNonEmptyString(row.pivota_canonical_url) || null,
    display_snapshot: buildRelationshipGraphDisplaySnapshot(row),
    display_snapshot_source: displaySnapshotSource,
    family_key: family.family_key || `ref:${normalized.normalized_ref}`,
    family_key_source: family.family_key_source || 'fallback_ref',
    resolved: true,
  };
}

function getRelationshipGraphRefResolutionCacheEntry(cacheKey) {
  const key = asString(cacheKey);
  if (!key) return null;
  const cached = RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE.get(key);
  if (!cached) {
    RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS.misses += 1;
    return null;
  }
  if (cached.expiresAtMs && cached.expiresAtMs < Date.now()) {
    RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE.delete(key);
    RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS.misses += 1;
    return null;
  }
  RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS.hits += 1;
  return cached.value;
}

function setRelationshipGraphRefResolutionCache(cacheKey, value, ttlMs = RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_TTL_MS) {
  const key = asString(cacheKey);
  if (!key || !value) return;
  const ttl = Number(ttlMs) || RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_TTL_MS;
  RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS.sets += 1;
  RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE.set(key, {
    value: { ...value },
    storedAtMs: Date.now(),
    expiresAtMs: Date.now() + Math.max(5_000, ttl),
  });
}

function normalizeRows(result) {
  return Array.isArray(result?.rows) ? result.rows.filter((row) => row && typeof row === 'object') : [];
}

function lifecycleRank(stage) {
  switch (asString(stage).toLowerCase()) {
    case 'published':
      return 0;
    case 'validated':
      return 1;
    case 'candidate':
      return 2;
    case 'draft':
      return 3;
    default:
      return 9;
  }
}

function comparePrimaryCandidates(left, right) {
  const leftPrimary = left?.is_primary === true ? 0 : 1;
  const rightPrimary = right?.is_primary === true ? 0 : 1;
  if (leftPrimary !== rightPrimary) return leftPrimary - rightPrimary;

  const leftLifecycle = lifecycleRank(left?.pdp_lifecycle_stage);
  const rightLifecycle = lifecycleRank(right?.pdp_lifecycle_stage);
  if (leftLifecycle !== rightLifecycle) return leftLifecycle - rightLifecycle;

  const leftMinted = Date.parse(left?.pivota_signature_minted_at || '');
  const rightMinted = Date.parse(right?.pivota_signature_minted_at || '');
  if (Number.isFinite(leftMinted) && Number.isFinite(rightMinted) && leftMinted !== rightMinted) {
    return leftMinted - rightMinted;
  }
  if (Number.isFinite(leftMinted)) return -1;
  if (Number.isFinite(rightMinted)) return 1;

  return asString(left?.product_key).localeCompare(asString(right?.product_key));
}

function pickPrimaryRow(rows, targetProductId = '') {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return null;
  const targetSig = isSigId(targetProductId) ? asString(targetProductId) : '';
  const sorted = safeRows.slice().sort(comparePrimaryCandidates);
  return (
    sorted.find((row) => row?.is_primary === true && isSigId(row?.pivota_signature_id)) ||
    sorted.find((row) => targetSig && asString(row?.pivota_signature_id) === targetSig) ||
    sorted.find((row) => isSigId(row?.pivota_signature_id)) ||
    sorted[0]
  );
}

function buildCatalogGroupMember(row, canonicalSigId) {
  const merchantId = firstNonEmptyString(row?.merchant_id);
  const productId = firstNonEmptyString(row?.source_product_id, row?.platform_product_id, row?.product_key);
  if (!merchantId || !productId) return null;
  const productPayload =
    row?.product_payload && typeof row.product_payload === 'object' && !Array.isArray(row.product_payload)
      ? row.product_payload
      : {};
  const payloadSnapshot =
    productPayload.snapshot && typeof productPayload.snapshot === 'object' && !Array.isArray(productPayload.snapshot)
      ? productPayload.snapshot
      : {};
  const sourcePayload = {
    ...productPayload,
    title: firstNonEmptyString(row?.product_title, row?.title, productPayload.title, productPayload.name, payloadSnapshot.title),
    brand: firstNonEmptyString(row?.brand, productPayload.brand, payloadSnapshot.brand),
    canonical_url: firstNonEmptyString(
      row?.canonical_url,
      row?.pivota_canonical_url,
      productPayload.canonical_url,
      productPayload.canonicalUrl,
      payloadSnapshot.canonical_url,
    ),
    image_url: firstNonEmptyString(
      row?.product_image_url,
      row?.image_url,
      productPayload.image_url,
      productPayload.imageUrl,
      payloadSnapshot.image_url,
    ),
    content_key: firstNonEmptyString(row?.content_key),
    pivota_signature_id: firstNonEmptyString(row?.pivota_signature_id),
    canonical_sig_id: canonicalSigId || undefined,
    product_group_id: canonicalSigId || undefined,
    internal_product_group_id: firstNonEmptyString(row?.internal_product_group_id, row?.product_group_id),
  };
  return {
    merchant_id: merchantId,
    merchant_name: firstNonEmptyString(row?.merchant_name) || undefined,
    product_id: productId,
    platform: firstNonEmptyString(row?.platform) || undefined,
    source_listing_ref:
      firstNonEmptyString(row?.pivota_signature_id)
        ? `catalog_signature:${firstNonEmptyString(row.pivota_signature_id)}`
        : `catalog_product:${firstNonEmptyString(row?.product_key, productId)}`,
    source_kind: 'canonical_catalog',
    source_tier: row?.is_primary === true ? 'brand' : 'merchant',
    product_key: firstNonEmptyString(row?.product_key) || undefined,
    pivota_signature_id: firstNonEmptyString(row?.pivota_signature_id) || undefined,
    content_key: firstNonEmptyString(row?.content_key) || undefined,
    internal_product_group_id: firstNonEmptyString(row?.internal_product_group_id, row?.product_group_id) || undefined,
    is_primary: row?.is_primary === true,
    source_payload: sourcePayload,
  };
}

function buildCanonicalCatalogGroup(rows, { productId = '' } = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return null;
  const primary = pickPrimaryRow(safeRows, productId);
  const canonicalSigId = firstNonEmptyString(primary?.pivota_signature_id, safeRows.find((row) => isSigId(row?.pivota_signature_id))?.pivota_signature_id);
  if (!isSigId(canonicalSigId)) return null;

  const members = safeRows
    .map((row) => buildCatalogGroupMember(row, canonicalSigId))
    .filter(Boolean)
    .map((member) => ({
      ...member,
      is_primary:
        member.is_primary === true ||
        (primary &&
          member.merchant_id === asString(primary.merchant_id) &&
          member.product_id === firstNonEmptyString(primary.source_product_id, primary.platform_product_id, primary.product_key)),
    }));

  const canonicalProductRef = members.find((member) => member.is_primary) || members[0] || null;
  if (!canonicalProductRef) return null;

  const memberSigIds = Array.from(
    new Set(safeRows.map((row) => firstNonEmptyString(row?.pivota_signature_id)).filter(isSigId)),
  );
  const internalProductGroupIds = Array.from(
    new Set(safeRows.map((row) => firstNonEmptyString(row?.internal_product_group_id, row?.product_group_id)).filter(Boolean)),
  );
  const sellerCount = new Set(members.map((member) => member.merchant_id).filter(Boolean)).size;
  const offerCount = safeRows.reduce((sum, row) => sum + Math.max(0, safeNumber(row?.offer_count, 0)), 0);

  return {
    status: 'success',
    source: 'canonical_catalog',
    product_group_id: canonicalSigId,
    sellable_item_group_id: canonicalSigId,
    canonical_sig_id: canonicalSigId,
    // Stable canonical product identity = the content-derived product group id
    // (pg_*), with sig_* fallback for ungrouped (standalone) products. Unlike the
    // primary listing's sig (above), pg_* does not change when the primary flips,
    // so it is the durable front-facing key; sig_* remains a per-listing alias.
    // Consumers should prefer canonical_entity_id for public product_id / URLs;
    // the sig fields stay for signature lineage / offer matching. (Additive.)
    canonical_entity_id: internalProductGroupIds[0] || canonicalSigId,
    internal_product_group_id: internalProductGroupIds[0] || null,
    internal_product_group_ids: internalProductGroupIds,
    content_key: firstNonEmptyString(primary?.content_key, safeRows[0]?.content_key) || null,
    canonical_product_ref: {
      merchant_id: canonicalProductRef.merchant_id,
      product_id: canonicalProductRef.product_id,
      ...(canonicalProductRef.platform ? { platform: canonicalProductRef.platform } : {}),
      ...(canonicalProductRef.product_key ? { product_key: canonicalProductRef.product_key } : {}),
      ...(canonicalProductRef.pivota_signature_id ? { pivota_signature_id: canonicalProductRef.pivota_signature_id } : {}),
    },
    members,
    group_members: members,
    member_sig_ids: memberSigIds,
    seller_count: sellerCount,
    member_count: members.length,
    offer_count: offerCount,
    has_multiple_offers: sellerCount > 1 || members.length > 1,
  };
}

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

async function resolveRelationshipGraphRefsToCanonicalEntities(refs = [], { queryFn = defaultQuery, bypassCache = false } = {}) {
  const inputs = [];
  const seen = new Set();
  const fallbackSnapshotsByRef = new Map();
  for (const raw of Array.isArray(refs) ? refs : [refs]) {
    const ref = asPlainObject(raw) ? raw.ref || raw.input_ref || raw.inputRef : raw;
    const normalized = normalizeRelationshipGraphRefForResolution(ref);
    if (!normalized.normalized_ref) continue;
    if (!seen.has(normalized.normalized_ref)) {
      seen.add(normalized.normalized_ref);
      inputs.push(normalized);
    }
    const snapshot = asPlainObject(raw) ? asPlainObject(raw.snapshot || raw.edge_snapshot || raw.edgeSnapshot) : null;
    if (snapshot && !fallbackSnapshotsByRef.has(normalized.normalized_ref)) {
      fallbackSnapshotsByRef.set(normalized.normalized_ref, snapshot);
    }
  }
  const out = new Map();
  if (!inputs.length || typeof queryFn !== 'function') return out;

  const cacheEnabled = RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_ENABLED && !bypassCache;
  if (!cacheEnabled) RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS.bypasses += 1;
  const refsToQuery = [];
  for (const input of inputs) {
    const cached = cacheEnabled ? getRelationshipGraphRefResolutionCacheEntry(input.normalized_ref) : null;
    if (cached) {
      out.set(input.normalized_ref, {
        ...cached,
        input_ref: input.input_ref,
        normalized_ref: input.normalized_ref,
      });
    } else {
      refsToQuery.push(input);
    }
  }

  if (refsToQuery.length) {
    try {
      const sql = `
        WITH input_refs AS (
          SELECT
            raw.input_ref,
            lower(raw.input_ref) AS normalized_ref,
            regexp_replace(lower(raw.input_ref), '^[a-z][a-z0-9_+-]*:', '') AS ref_key,
            raw.ordinality
          FROM unnest($1::text[]) WITH ORDINALITY AS raw(input_ref, ordinality)
        ),
        catalog_matches AS (
          SELECT
            i.input_ref,
            i.normalized_ref,
            i.ref_key,
            i.ordinality,
            0 AS match_rank,
            cp.product_key,
            cp.merchant_id,
            cp.platform,
            cp.source_product_id,
            cp.title,
            cp.brand,
            cp.category,
            cp.product_type,
            cp.canonical_url,
            cp.image_url,
            cp.product_payload,
            cp.pdp_lifecycle_stage,
            cp.pivota_signature_id,
            cp.pivota_canonical_url,
            cp.pivota_signature_minted_at,
            cp.updated_at,
            NULLIF(COALESCE(
              to_jsonb(cp)->>'product_family_id',
              cp.product_payload->>'product_family_id',
              cp.product_payload->>'productFamilyId',
              cp.product_payload->>'product_line_id',
              cp.product_payload->>'productLineId',
              cp.product_payload->>'variant_of',
              cp.product_payload->>'variantOf'
            ), '') AS product_family_id,
            pgm.product_group_id,
            COALESCE(pgm.is_primary, false) AS is_primary
          FROM input_refs i
          JOIN catalog_products cp
            ON lower(cp.source_product_id) = i.ref_key
            OR lower(cp.product_key) = i.ref_key
            OR lower(cp.pivota_signature_id) = i.ref_key
            OR lower(cp.canonical_url) = i.ref_key
            OR lower(cp.pivota_canonical_url) = i.ref_key
          LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
          LEFT JOIN product_group_members pgm
            ON pgm.merchant_id = cp.merchant_id
           AND pgm.platform = cp.platform
           AND pgm.platform_product_id = cp.source_product_id
          WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}

          UNION ALL

          SELECT
            i.input_ref,
            i.normalized_ref,
            i.ref_key,
            i.ordinality,
            10 AS match_rank,
            cp.product_key,
            cp.merchant_id,
            cp.platform,
            cp.source_product_id,
            cp.title,
            cp.brand,
            cp.category,
            cp.product_type,
            cp.canonical_url,
            cp.image_url,
            cp.product_payload,
            cp.pdp_lifecycle_stage,
            cp.pivota_signature_id,
            cp.pivota_canonical_url,
            cp.pivota_signature_minted_at,
            cp.updated_at,
            NULLIF(COALESCE(
              to_jsonb(cp)->>'product_family_id',
              cp.product_payload->>'product_family_id',
              cp.product_payload->>'productFamilyId',
              cp.product_payload->>'product_line_id',
              cp.product_payload->>'productLineId',
              cp.product_payload->>'variant_of',
              cp.product_payload->>'variantOf'
            ), '') AS product_family_id,
            pgm.product_group_id,
            COALESCE(pgm.is_primary, false) AS is_primary
          FROM input_refs i
          JOIN product_group_members pgm
            ON lower(pgm.product_group_id) = i.ref_key
          JOIN catalog_products cp
            ON cp.merchant_id = pgm.merchant_id
           AND cp.platform = pgm.platform
           AND cp.source_product_id = pgm.platform_product_id
          LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
          WHERE ${activeCatalogProductSourceWhere('cp', 'cm')}
        )
        SELECT DISTINCT ON (normalized_ref)
          input_ref, normalized_ref, ref_key, product_key, merchant_id, platform,
          source_product_id, title, brand, category, product_type, canonical_url,
          image_url, product_payload, pdp_lifecycle_stage, pivota_signature_id,
          pivota_canonical_url, pivota_signature_minted_at, updated_at,
          product_family_id, product_group_id, is_primary
        FROM catalog_matches
        ORDER BY
          normalized_ref,
          match_rank ASC,
          CASE WHEN is_primary = true THEN 0 ELSE 1 END,
          CASE pdp_lifecycle_stage
            WHEN 'published' THEN 0
            WHEN 'validated' THEN 1
            WHEN 'candidate' THEN 2
            WHEN 'draft' THEN 3
            ELSE 9
          END,
          pivota_signature_minted_at ASC NULLS LAST,
          updated_at DESC NULLS LAST,
          product_key ASC
      `;
      const rows = normalizeRows(await queryFn(sql, [refsToQuery.map((item) => item.input_ref)]));
      for (const row of rows) {
        const normalizedRef = asString(row.normalized_ref).toLowerCase();
        if (!normalizedRef) continue;
        const context = relationshipGraphResolutionContextFromRow(
          row,
          fallbackSnapshotsByRef.get(normalizedRef),
        );
        out.set(normalizedRef, context);
        if (cacheEnabled && context.resolved && context.family_key_source !== 'fallback_ref') {
          setRelationshipGraphRefResolutionCache(normalizedRef, context);
        }
      }
    } catch (err) {
      if (!looksLikeRelationMissing(err)) throw err;
    }
  }

  for (const input of inputs) {
    if (out.has(input.normalized_ref)) continue;
    out.set(
      input.normalized_ref,
      fallbackRelationshipGraphResolutionContext(
        input.input_ref,
        fallbackSnapshotsByRef.get(input.normalized_ref),
      ),
    );
  }

  return out;
}

async function resolveCanonicalCatalogEntityGroup(args = {}) {
  const queryFn = args.queryFn || args.query || defaultQuery;
  if (!process.env.DATABASE_URL || typeof queryFn !== 'function') return null;

  const productId = asString(args.productId || args.product_id);
  const merchantId = asString(args.merchantId || args.merchant_id);
  const productGroupId = asString(args.productGroupId || args.product_group_id);
  if (!productId && !productGroupId) return null;

  const params = [];
  const targetClauses = [];
  const targetOrder = [];

  if (productId) {
    const productParam = pushParam(params, productId);
    if (isSigId(productId)) {
      targetClauses.push(`cp.pivota_signature_id = ${productParam}`);
      targetOrder.push(`CASE WHEN cp.pivota_signature_id = ${productParam} THEN 0 ELSE 1 END`);
    } else {
      targetClauses.push(`(cp.source_product_id = ${productParam} OR cp.product_key = ${productParam} OR cp.pivota_signature_id = ${productParam})`);
    }
  }

  if (merchantId && productId) {
    const merchantParam = pushParam(params, merchantId);
    const productParam = pushParam(params, productId);
    targetClauses.push(`
      (
        cp.merchant_id = ${merchantParam}
        AND (
          cp.source_product_id = ${productParam}
          OR cp.product_key = ${productParam}
          OR cp.pivota_signature_id = ${productParam}
        )
      )
    `);
    targetOrder.push(`CASE WHEN cp.merchant_id = ${merchantParam} THEN 0 ELSE 1 END`);
  }

  if (productGroupId) {
    const groupParam = pushParam(params, productGroupId);
    targetClauses.push(`pgm.product_group_id = ${groupParam}`);
    if (isSigId(productGroupId)) {
      targetClauses.push(`cp.pivota_signature_id = ${groupParam}`);
    }
  }

  if (!targetClauses.length) return null;

  const sql = `
    WITH offer_stats AS (
      SELECT
        s.product_key,
        COUNT(DISTINCT o.offer_id)::int AS offer_count
      FROM catalog_skus s
      LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
      GROUP BY s.product_key
    ),
    target AS (
      SELECT
        cp.content_key,
        cp.product_key,
        cp.pivota_signature_id,
        pgm.product_group_id
      FROM catalog_products cp
      LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
      LEFT JOIN product_group_members pgm
        ON pgm.merchant_id = cp.merchant_id
       AND pgm.platform = cp.platform
       AND pgm.platform_product_id = cp.source_product_id
      WHERE (${targetClauses.join(' OR ')})
        AND ${activeCatalogProductSourceWhere('cp', 'cm')}
      ORDER BY
        ${targetOrder.length ? `${targetOrder.join(',')},` : ''}
        CASE WHEN pgm.is_primary = true THEN 0 ELSE 1 END,
        CASE cp.pdp_lifecycle_stage
          WHEN 'published' THEN 0
          WHEN 'validated' THEN 1
          WHEN 'candidate' THEN 2
          WHEN 'draft' THEN 3
          ELSE 9
        END,
        cp.pivota_signature_minted_at ASC NULLS LAST,
        cp.updated_at DESC NULLS LAST
      LIMIT 1
    )
    SELECT
      cp.product_key,
      cp.merchant_id,
      cp.platform,
      cp.source_product_id,
      cp.title AS product_title,
      cp.description AS product_description,
      cp.brand,
      cp.category,
      cp.product_type,
      cp.category_path,
      cp.canonical_url,
      cp.image_url AS product_image_url,
      cp.product_payload,
      cp.pdp_lifecycle_stage,
      cp.pivota_signature_id,
      cp.pivota_canonical_url,
      cp.pivota_signature_minted_at,
      cp.content_key,
      cp.updated_at,
      cm.merchant_name,
      pgm.product_group_id AS internal_product_group_id,
      COALESCE(pgm.is_primary, false) AS is_primary,
      COALESCE(offer_stats.offer_count, 0)::int AS offer_count
    FROM catalog_products cp
    LEFT JOIN catalog_merchants cm ON cm.merchant_id = cp.merchant_id
    LEFT JOIN product_group_members pgm
      ON pgm.merchant_id = cp.merchant_id
     AND pgm.platform = cp.platform
     AND pgm.platform_product_id = cp.source_product_id
    LEFT JOIN offer_stats ON offer_stats.product_key = cp.product_key
    WHERE (
      cp.content_key IN (SELECT content_key FROM target WHERE content_key IS NOT NULL)
      OR pgm.product_group_id IN (SELECT product_group_id FROM target WHERE product_group_id IS NOT NULL)
      OR cp.product_key IN (SELECT product_key FROM target WHERE product_key IS NOT NULL)
    )
      AND cp.pivota_signature_id IS NOT NULL
      AND ${activeCatalogProductSourceWhere('cp', 'cm')}
    ORDER BY
      CASE WHEN pgm.is_primary = true THEN 0 ELSE 1 END,
      CASE cp.pdp_lifecycle_stage
        WHEN 'published' THEN 0
        WHEN 'validated' THEN 1
        WHEN 'candidate' THEN 2
        WHEN 'draft' THEN 3
        ELSE 9
      END,
      cp.pivota_signature_minted_at ASC NULLS LAST,
      cp.updated_at DESC NULLS LAST,
      cp.product_key ASC
    LIMIT 100
  `;

  try {
    const rows = normalizeRows(await queryFn(sql, params));
    return buildCanonicalCatalogGroup(rows, { productId });
  } catch (err) {
    if (looksLikeRelationMissing(err)) return null;
    throw err;
  }
}

module.exports = {
  resolveCanonicalCatalogEntityGroup,
  resolveRelationshipGraphRefsToCanonicalEntities,
  _internals: {
    asString,
    buildCanonicalCatalogGroup,
    buildCatalogGroupMember,
    comparePrimaryCandidates,
    isSigId,
    looksLikeRelationMissing,
    normalizeRelationshipGraphRefForResolution,
    fallbackRelationshipGraphResolutionContext,
    relationshipGraphResolutionContextFromRow,
    RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE,
    RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_METRICS,
    RELATIONSHIP_GRAPH_REF_RESOLUTION_CACHE_TTL_MS,
  },
};
