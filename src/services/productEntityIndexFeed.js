const { query: defaultQuery } = require('../db');
const {
  buildExternalSeedProduct,
  EXTERNAL_SEED_MERCHANT_ID,
} = require('./externalSeedProducts');

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function nonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function safeJsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const decoded = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
  } catch (_err) {
    return null;
  }
}

function normalizeBrand(product, row, seedData, snapshot) {
  const productBrand = product && typeof product.brand === 'object' ? product.brand.name : product?.brand;
  return nonEmptyString(
    productBrand,
    product?.vendor,
    row.brand,
    seedData.brand,
    seedData.brand_name,
    seedData.vendor,
    snapshot.brand,
    snapshot.brand_name,
    snapshot.vendor,
  );
}

function normalizeCategory(product, row, seedData, snapshot) {
  const categoryPath = Array.isArray(product?.category_path) ? product.category_path.join(' > ') : '';
  return nonEmptyString(
    categoryPath,
    product?.category,
    product?.product_type,
    row.category,
    seedData.category,
    seedData.product_type,
    snapshot.category,
    snapshot.product_type,
  );
}

function buildProductEntityIndexFeedItem(row) {
  const seedData = safeJsonObject(row?.seed_data);
  const snapshot = safeJsonObject(seedData.snapshot);
  const product = buildExternalSeedProduct(row) || {};
  const sourceProductId = nonEmptyString(
    row.source_product_id,
    product.product_id,
    product.id,
    row.external_product_id,
    seedData.external_product_id,
    seedData.product_id,
    snapshot.product_id,
  );
  const productEntityId = nonEmptyString(row.product_entity_id, row.sellable_item_group_id);
  if (!/^sig_[a-z0-9]+$/i.test(productEntityId) || !sourceProductId) return null;
  const title = nonEmptyString(product.title, product.name, row.product_name, row.title, seedData.title, snapshot.title);
  return {
    id: sourceProductId,
    product_id: sourceProductId,
    external_seed_id: /^ext_[a-z0-9_]+$/i.test(sourceProductId) ? sourceProductId : nonEmptyString(row.external_seed_id),
    source_product_id: sourceProductId,
    merchant_id: nonEmptyString(row.merchant_id, product.merchant_id, EXTERNAL_SEED_MERCHANT_ID),
    merchant_name: nonEmptyString(row.merchant_name, product.merchant_name),
    source: nonEmptyString(row.source, product.source, 'canonical_catalog'),
    product_entity_id: productEntityId,
    product_group_id: productEntityId,
    sellable_item_group_id: productEntityId,
    canonical_sig_id: productEntityId,
    content_key: nonEmptyString(row.content_key),
    title,
    name: title,
    brand: normalizeBrand(product, row, seedData, snapshot),
    category: normalizeCategory(product, row, seedData, snapshot),
    canonical_url: product.canonical_url || row.canonical_url || snapshot.canonical_url || '',
    destination_url: product.destination_url || row.destination_url || snapshot.destination_url || '',
    image_url: product.image_url || row.image_url || snapshot.image_url || '',
    seller_count: Number(row.seller_count || 0) || undefined,
    member_count: Number(row.member_count || 0) || undefined,
    offer_count: Number(row.offer_count || 0) || undefined,
    member_refs: safeJsonArray(row.member_refs),
    updated_at: row.source_updated_at || row.updated_at || row.identity_updated_at || null,
  };
}

async function getProductEntityIndexFeed(payload = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const limit = clampInt(payload.limit, 100, 1, 500);
  const cursor = decodeCursor(payload.cursor);
  const page = clampInt(payload.page, 1, 1, 100000);
  const offset = cursor && Number.isFinite(Number(cursor.offset))
    ? Math.max(0, Math.floor(Number(cursor.offset)))
    : Math.max(0, (page - 1) * limit);
  const cursorSourceListingRef = nonEmptyString(cursor?.source_listing_ref);
  const cursorSortUpdatedAt = nonEmptyString(cursor?.sort_updated_at);
  const cursorProductEntityId = nonEmptyString(cursor?.product_entity_id);
  const cursorSourceProductId = nonEmptyString(cursor?.source_product_id);
  const useSourceRefCursor = Boolean(cursorSourceListingRef);
  const useSortKeysetCursor = !useSourceRefCursor && Boolean(
    cursorSortUpdatedAt && cursorProductEntityId && cursorSourceProductId,
  );
  const market = nonEmptyString(payload.market, process.env.EXTERNAL_SEED_MARKET, 'US');
  const tool = nonEmptyString(payload.tool, 'creator_agents');
  const includeAttached = payload.include_attached === true || payload.includeAttached === true;
  const fetchLimit = limit + 1;
  const params = [];
  let identityPaginationWhere = '';
  let paginationWhere = '';
  if (useSourceRefCursor) {
    const sourceRefParam = params.push(cursorSourceListingRef);
    identityPaginationWhere = `AND ('catalog_content_key:' || ranked.content_key) > $${sourceRefParam}`;
  } else if (useSortKeysetCursor) {
    const sortParam = params.push(cursorSortUpdatedAt);
    const productParam = params.push(cursorProductEntityId);
    const sourceParam = params.push(cursorSourceProductId);
    paginationWhere = `
      WHERE (
        sort_updated_at < $${sortParam}::timestamptz
        OR (
          sort_updated_at = $${sortParam}::timestamptz
          AND product_entity_id > $${productParam}
        )
        OR (
          sort_updated_at = $${sortParam}::timestamptz
          AND product_entity_id = $${productParam}
          AND source_product_id > $${sourceParam}
        )
      )
    `;
  }
  params.push(fetchLimit);
  const limitParam = params.length;
  let offsetClause = '';
  if (!useSourceRefCursor && !useSortKeysetCursor && offset > 0) {
    params.push(offset);
    offsetClause = `OFFSET $${params.length}`;
  }

  const result = await query(
    `
      WITH offer_stats AS (
        SELECT
          s.product_key,
          COUNT(DISTINCT o.offer_id)::int AS offer_count
        FROM catalog_skus s
        LEFT JOIN catalog_offers o ON o.sku_key = s.sku_key
        GROUP BY s.product_key
      ),
      canonical_rows AS (
        SELECT
          cp.content_key,
          cp.product_key,
          cp.merchant_id,
          cm.merchant_name,
          cp.platform,
          cp.source_product_id,
          cp.title AS product_name,
          cp.description AS product_description,
          cp.brand,
          cp.category,
          cp.product_type,
          cp.canonical_url,
          cp.pivota_canonical_url,
          cp.image_url,
          cp.product_payload,
          cp.pivota_signature_id,
          cp.pivota_signature_minted_at,
          cp.pdp_lifecycle_stage,
          cp.updated_at,
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
        WHERE cp.content_key IS NOT NULL
          AND cp.pivota_signature_id LIKE 'sig\\_%' ESCAPE '\\'
      ),
      ranked AS (
        SELECT
          cr.*,
          ROW_NUMBER() OVER (
            PARTITION BY cr.content_key
            ORDER BY
              CASE WHEN cr.is_primary = true THEN 0 ELSE 1 END,
              CASE cr.pdp_lifecycle_stage
                WHEN 'published' THEN 0
                WHEN 'validated' THEN 1
                WHEN 'candidate' THEN 2
                WHEN 'draft' THEN 3
                ELSE 9
              END,
              cr.pivota_signature_minted_at ASC NULLS LAST,
              cr.updated_at DESC NULLS LAST,
              cr.product_key ASC
          ) AS row_rank
        FROM canonical_rows cr
      ),
      stats AS (
        SELECT
          content_key,
          COUNT(*)::int AS member_count,
          COUNT(DISTINCT merchant_id)::int AS seller_count,
          COALESCE(SUM(offer_count), 0)::int AS offer_count,
          MAX(updated_at) AS sort_updated_at,
          jsonb_agg(
            jsonb_build_object(
              'merchant_id', merchant_id,
              'merchant_name', merchant_name,
              'product_id', source_product_id,
              'platform', platform,
              'product_key', product_key,
              'pivota_signature_id', pivota_signature_id,
              'is_primary', is_primary
            )
            ORDER BY
              CASE WHEN is_primary = true THEN 0 ELSE 1 END,
              product_key ASC
          ) AS member_refs
        FROM canonical_rows
        GROUP BY content_key
      ),
      mapped AS (
        SELECT
          'catalog_content_key:' || ranked.content_key AS source_listing_ref,
          ranked.pivota_signature_id AS product_entity_id,
          ranked.source_product_id AS source_product_id,
          null::text AS external_seed_row_id,
          ranked.source_product_id AS external_product_id,
          ranked.canonical_url AS destination_url,
          COALESCE(ranked.pivota_canonical_url, ranked.canonical_url) AS canonical_url,
          regexp_replace(lower(coalesce(ranked.canonical_url, ranked.pivota_canonical_url, '')), '^https?://(?:www\\.)?([^/]+).*$','\\1') AS domain,
          ranked.product_name,
          ranked.image_url,
          null::numeric AS price_amount,
          null::text AS price_currency,
          null::text AS availability,
          COALESCE(ranked.brand, '') AS brand,
          COALESCE(ranked.category, ranked.product_type, '') AS category,
          COALESCE(ranked.product_payload, '{}'::jsonb) AS seed_data,
          ranked.updated_at AS source_updated_at,
          COALESCE(stats.sort_updated_at, ranked.updated_at, '1970-01-01T00:00:00Z'::timestamptz) AS sort_updated_at,
          ranked.updated_at AS identity_updated_at,
          0.96::numeric AS identity_confidence,
          ranked.merchant_id,
          ranked.merchant_name,
          ranked.content_key,
          ranked.internal_product_group_id,
          stats.seller_count,
          stats.member_count,
          stats.offer_count,
          stats.member_refs,
          'canonical_catalog'::text AS source
        FROM ranked
        JOIN stats ON stats.content_key = ranked.content_key
        WHERE ranked.row_rank = 1
          ${identityPaginationWhere}
      )
      SELECT *, COUNT(*) OVER() AS total_rows
      FROM mapped
      ${paginationWhere}
      ORDER BY
        source_listing_ref ASC
      LIMIT $${limitParam}
      ${offsetClause}
    `,
    params,
  );

  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const pageRows = rows.slice(0, limit);
  const products = pageRows.map(buildProductEntityIndexFeedItem).filter(Boolean);
  const total = Math.max(0, Number(rows[0]?.total_rows || 0) || 0);
  const nextOffset = offset + pageRows.length;
  const hasNextPage = rows.length > limit;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor = hasNextPage && lastRow
    ? encodeCursor({
      source_listing_ref: lastRow.source_listing_ref,
      market,
      tool,
      include_attached: includeAttached,
    })
    : null;

  return {
    status: 'success',
    success: true,
    products,
    total,
    page: useSourceRefCursor || useSortKeysetCursor ? page : Math.floor(offset / limit) + 1,
    page_size: products.length,
    pagination: {
      limit,
      offset: useSourceRefCursor || useSortKeysetCursor ? null : offset,
      total_count: total || null,
      has_more: hasNextPage,
    },
    cursor_info: {
      next_cursor: nextCursor,
      has_next_page: hasNextPage,
      serving_mode: 'product_entity_index_feed',
    },
    metadata: {
      query_source: 'product_entity_index_feed',
      source: 'backend_external_seeds',
      market,
      tool,
      include_attached: includeAttached,
      cursor_mode: useSourceRefCursor
        ? 'source_listing_ref'
        : useSortKeysetCursor
          ? 'keyset'
          : 'initial_or_offset',
      rows_returned: pageRows.length,
      products_returned_count: products.length,
      next_offset: useSourceRefCursor || useSortKeysetCursor ? null : nextOffset,
    },
  };
}

module.exports = {
  getProductEntityIndexFeed,
  buildProductEntityIndexFeedItem,
};
