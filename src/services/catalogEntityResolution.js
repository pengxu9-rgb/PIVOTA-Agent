'use strict';

const { query: defaultQuery } = require('../db');
const { activeCatalogProductSourceWhere } = require('./activeCatalogSourceSql');

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
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
  _internals: {
    asString,
    buildCanonicalCatalogGroup,
    buildCatalogGroupMember,
    comparePrimaryCandidates,
    isSigId,
    looksLikeRelationMissing,
  },
};
