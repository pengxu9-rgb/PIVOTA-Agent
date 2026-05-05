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
    merchant_id: EXTERNAL_SEED_MERCHANT_ID,
    source: 'external_seed',
    product_entity_id: productEntityId,
    product_group_id: productEntityId,
    sellable_item_group_id: productEntityId,
    title,
    name: title,
    brand: normalizeBrand(product, row, seedData, snapshot),
    category: normalizeCategory(product, row, seedData, snapshot),
    canonical_url: product.canonical_url || row.canonical_url || snapshot.canonical_url || '',
    destination_url: product.destination_url || row.destination_url || snapshot.destination_url || '',
    image_url: product.image_url || row.image_url || snapshot.image_url || '',
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
  const cursorSortUpdatedAt = nonEmptyString(cursor?.sort_updated_at);
  const cursorProductEntityId = nonEmptyString(cursor?.product_entity_id);
  const cursorSourceProductId = nonEmptyString(cursor?.source_product_id);
  const useKeysetCursor = Boolean(
    cursorSortUpdatedAt && cursorProductEntityId && cursorSourceProductId,
  );
  const market = nonEmptyString(payload.market, process.env.EXTERNAL_SEED_MARKET, 'US');
  const tool = nonEmptyString(payload.tool, 'creator_agents');
  const includeAttached = payload.include_attached === true || payload.includeAttached === true;
  const fetchLimit = limit + 1;
  const params = [includeAttached, market, tool];
  let paginationWhere = '';
  if (useKeysetCursor) {
    params.push(cursorSortUpdatedAt, cursorProductEntityId, cursorSourceProductId);
    paginationWhere = `
      WHERE (
        sort_updated_at < $4::timestamptz
        OR (
          sort_updated_at = $4::timestamptz
          AND product_entity_id > $5
        )
        OR (
          sort_updated_at = $4::timestamptz
          AND product_entity_id = $5
          AND source_product_id > $6
        )
      )
    `;
  }
  params.push(fetchLimit);
  const limitParam = params.length;
  let offsetClause = '';
  if (!useKeysetCursor && offset > 0) {
    params.push(offset);
    offsetClause = `OFFSET $${params.length}`;
  }

  const result = await query(
    `
      WITH mapped AS (
        SELECT
          pil.sellable_item_group_id AS product_entity_id,
          pil.product_id AS source_product_id,
          eps.id::text AS external_seed_row_id,
          eps.external_product_id,
          eps.destination_url,
          eps.canonical_url,
          eps.domain,
          coalesce(
            eps.title,
            pil.source_payload->>'title',
            pil.source_payload->>'name',
            pil.title_norm
          ) AS product_name,
          eps.image_url,
          eps.price_amount,
          eps.price_currency,
          eps.availability,
          coalesce(
            eps.seed_data->>'brand',
            eps.seed_data->'snapshot'->>'brand',
            eps.seed_data->>'vendor',
            eps.seed_data->'snapshot'->>'vendor',
            pil.source_payload->>'brand',
            pil.source_payload->>'vendor',
            pil.brand_norm,
            ''
          ) AS brand,
          coalesce(
            eps.seed_data->>'category',
            eps.seed_data->'snapshot'->>'category',
            eps.seed_data->>'product_type',
            eps.seed_data->'snapshot'->>'product_type',
            pil.source_payload->>'category',
            pil.source_payload->>'product_type',
            ''
          ) AS category,
          coalesce(eps.seed_data, pil.source_payload, '{}'::jsonb) AS seed_data,
          eps.updated_at AS source_updated_at,
          coalesce(
            pil.updated_at,
            eps.updated_at,
            eps.created_at,
            '1970-01-01T00:00:00Z'::timestamptz
          ) AS sort_updated_at,
          pil.updated_at AS identity_updated_at,
          pil.identity_confidence
        FROM pdp_identity_listing pil
        JOIN LATERAL (
          SELECT
            eps.id,
            eps.external_product_id,
            eps.destination_url,
            eps.canonical_url,
            eps.domain,
            eps.title,
            eps.image_url,
            eps.price_amount,
            eps.price_currency,
            eps.availability,
            eps.seed_data,
            eps.updated_at,
            eps.created_at
          FROM external_product_seeds eps
          WHERE eps.status = 'active'
            AND ($1::boolean = true OR eps.attached_product_key IS NULL)
            AND eps.external_product_id = pil.product_id
            AND eps.market = $2
            AND ($3 = '*' OR eps.tool = $3 OR eps.tool = '*' OR eps.tool IS NULL OR eps.tool = '')
            AND coalesce(lower(eps.seed_data#>>'{suppression_flags,exclude_from_recall}'), 'false') <> 'true'
            AND coalesce(lower(eps.seed_data#>>'{derived,recall,suppression_flags,exclude_from_recall}'), 'false') <> 'true'
          ORDER BY eps.updated_at DESC NULLS LAST, eps.id DESC
          LIMIT 1
        ) eps ON true
        WHERE pil.sellable_item_group_id LIKE 'sig\\_%' ESCAPE '\\'
          AND pil.source_listing_ref LIKE 'external_seed:%'
          AND pil.product_id IS NOT NULL
          AND pil.identity_status = 'approved'
          AND pil.live_read_enabled = true
      )
      SELECT *
      FROM mapped
      ${paginationWhere}
      ORDER BY
        sort_updated_at DESC,
        product_entity_id ASC,
        source_product_id ASC
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
      sort_updated_at: lastRow.sort_updated_at,
      product_entity_id: lastRow.product_entity_id,
      source_product_id: lastRow.source_product_id,
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
    page: useKeysetCursor ? page : Math.floor(offset / limit) + 1,
    page_size: products.length,
    pagination: {
      limit,
      offset: useKeysetCursor ? null : offset,
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
      cursor_mode: useKeysetCursor ? 'keyset' : 'initial_or_offset',
      rows_returned: pageRows.length,
      products_returned_count: products.length,
      next_offset: useKeysetCursor ? null : nextOffset,
    },
  };
}

module.exports = {
  getProductEntityIndexFeed,
  buildProductEntityIndexFeedItem,
};
