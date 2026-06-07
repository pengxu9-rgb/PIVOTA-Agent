'use strict';

const {
  buildAnchorRefsFromProduct,
  listApprovedRelationshipEdgesForAnchor,
  relationshipEdgeToSimilarItem,
} = require('../auroraBff/productRelationshipGraph');

const SURFACE_FLAGS = Object.freeze({
  pdp_similar: 'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
  find_similar_products: 'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
  discovery_feed: 'AURORA_BFF_RELATIONSHIP_GRAPH_DISCOVERY_ENABLED',
  chat_alternatives: 'AURORA_BFF_RELATIONSHIP_GRAPH_CHAT_ALTERNATIVES_ENABLED',
});

function normalizeSurface(value) {
  const token = String(value || '').trim().toLowerCase();
  if (token === 'pdp' || token === 'similar') return 'pdp_similar';
  if (token === 'find_similar') return 'find_similar_products';
  if (token === 'discovery' || token === 'feed' || token === 'recommendation_feed') return 'discovery_feed';
  if (token === 'chat' || token === 'alternatives') return 'chat_alternatives';
  return token || 'pdp_similar';
}

function parseBooleanFlag(value) {
  const token = String(value ?? '').trim().toLowerCase();
  if (!token) return null;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(token)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(token)) return false;
  return null;
}

function isRelationshipGraphSurfaceEnabled(surface = 'pdp_similar', env = process.env) {
  const normalizedSurface = normalizeSurface(surface);
  const surfaceFlag = SURFACE_FLAGS[normalizedSurface];
  if (surfaceFlag) {
    const surfaceValue = parseBooleanFlag(env?.[surfaceFlag]);
    if (surfaceValue != null) return surfaceValue;
  }

  if (normalizedSurface === 'pdp_similar' || normalizedSurface === 'find_similar_products') {
    return parseBooleanFlag(env?.AURORA_BFF_RELATIONSHIP_GRAPH_ENABLED) === true;
  }

  return parseBooleanFlag(env?.AURORA_BFF_RELATIONSHIP_GRAPH_ALL_FEEDS_ENABLED) === true;
}

function buildRelationshipGraphFetchMetadata({
  surface,
  enabled,
  anchorRefs = [],
  edges = [],
  items = [],
  error = null,
} = {}) {
  return {
    source: 'relationship_graph',
    surface: normalizeSurface(surface),
    enabled: Boolean(enabled),
    query_attempted: Boolean(enabled && anchorRefs.length > 0),
    anchor_ref_count: Array.isArray(anchorRefs) ? anchorRefs.length : 0,
    edge_count: Array.isArray(edges) ? edges.length : 0,
    item_count: Array.isArray(items) ? items.length : 0,
    ...(error ? { error: String(error) } : {}),
  };
}

function uniqueStrings(values = [], max = 200) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

async function fetchRelationshipGraphRecallForAnchor({
  anchorProduct,
  surface = 'pdp_similar',
  market = 'US',
  relationTypes,
  limit = 24,
  queryFn,
  enabled,
  logger,
} = {}) {
  const normalizedSurface = normalizeSurface(surface);
  const surfaceEnabled =
    enabled == null ? isRelationshipGraphSurfaceEnabled(normalizedSurface) : enabled === true;
  if (!surfaceEnabled) {
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: false,
      }),
    };
  }

  const anchorRefs = buildAnchorRefsFromProduct(anchorProduct || {});
  if (!anchorRefs.length) {
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
      }),
    };
  }

  try {
    const edges = await listApprovedRelationshipEdgesForAnchor({
      anchorType: 'product',
      anchorRefs,
      market,
      relationTypes,
      limit: Math.max(1, Math.min(120, Number(limit) || 24)),
      ...(typeof queryFn === 'function' ? { queryFn } : {}),
    });
    const items = (Array.isArray(edges) ? edges : []).map(relationshipEdgeToSimilarItem).filter(Boolean);
    return {
      edges: Array.isArray(edges) ? edges : [],
      items,
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
        edges,
        items,
      }),
    };
  } catch (err) {
    logger?.warn?.(
      {
        err: err?.message || String(err),
        surface: normalizedSurface,
      },
      'relationship graph recall fetch failed',
    );
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
        error: err?.code || err?.message || 'fetch_failed',
      }),
    };
  }
}

async function fetchRelationshipGraphRecallForAnchors({
  anchorProducts = [],
  surface = 'discovery_feed',
  market = 'US',
  relationTypes,
  limit = 24,
  queryFn,
  enabled,
  logger,
} = {}) {
  const normalizedSurface = normalizeSurface(surface);
  const surfaceEnabled =
    enabled == null ? isRelationshipGraphSurfaceEnabled(normalizedSurface) : enabled === true;
  if (!surfaceEnabled) {
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: false,
      }),
    };
  }

  const anchorRefs = uniqueStrings(
    (Array.isArray(anchorProducts) ? anchorProducts : [])
      .flatMap((anchorProduct) => buildAnchorRefsFromProduct(anchorProduct || {})),
    240,
  );
  if (!anchorRefs.length) {
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
      }),
    };
  }

  try {
    const edges = await listApprovedRelationshipEdgesForAnchor({
      anchorType: 'product',
      anchorRefs,
      market,
      relationTypes,
      limit: Math.max(1, Math.min(120, Number(limit) || 24)),
      ...(typeof queryFn === 'function' ? { queryFn } : {}),
    });
    const items = (Array.isArray(edges) ? edges : []).map(relationshipEdgeToSimilarItem).filter(Boolean);
    return {
      edges: Array.isArray(edges) ? edges : [],
      items,
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
        edges,
        items,
      }),
    };
  } catch (err) {
    logger?.warn?.(
      {
        err: err?.message || String(err),
        surface: normalizedSurface,
      },
      'relationship graph recall fetch failed',
    );
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
        error: err?.code || err?.message || 'fetch_failed',
      }),
    };
  }
}

function fallbackRelationshipGraphDedupe(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const key = [
      item.merchant_id || item.merchantId || '',
      item.product_id || item.productId || item.external_product_id || item.id || '',
      item.canonical_url || item.url || '',
    ]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .join('::');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeRelationshipGraphRecallItems({
  graphItems = [],
  dynamicItems = [],
  limit,
  dedupeFn,
} = {}) {
  const graphRows = Array.isArray(graphItems) ? graphItems : [];
  const dynamicRows = Array.isArray(dynamicItems) ? dynamicItems : [];
  const merged = typeof dedupeFn === 'function'
    ? dedupeFn([...graphRows, ...dynamicRows])
    : fallbackRelationshipGraphDedupe([...graphRows, ...dynamicRows]);
  const numericLimit = Number(limit);
  return Number.isFinite(numericLimit) && numericLimit > 0
    ? merged.slice(0, Math.trunc(numericLimit))
    : merged;
}

function mapRelationshipGraphItemToDiscoveryProduct(item = {}, { rank = 0 } = {}) {
  if (!item || typeof item !== 'object') return null;
  const productId = String(item.product_id || item.external_product_id || item.id || '').trim();
  const merchantId = String(item.merchant_id || item.merchantId || '').trim();
  const title = String(item.title || item.name || '').trim();
  if (!productId || !merchantId || !title) return null;
  const url = String(item.canonical_url || item.url || item.destination_url || '').trim();
  const category = String(item.category || item.product_type || '').trim();
  return {
    ...item,
    id: productId,
    product_id: productId,
    external_product_id: String(item.external_product_id || productId).trim(),
    external_seed_product_id: String(item.external_product_id || productId).trim(),
    merchant_id: merchantId,
    title,
    name: title,
    ...(item.brand ? { brand: item.brand } : {}),
    ...(category ? { category, product_type: category } : {}),
    ...(url ? { canonical_url: url, destination_url: url, url } : {}),
    ...(item.image_url || item.imageUrl ? { image_url: item.image_url || item.imageUrl } : {}),
    ...(item.price != null ? { price: item.price } : {}),
    source: item.source || 'relationship_graph',
    recommendation_source: item.recommendation_source || 'relationship_graph',
    status: item.status || 'active',
    in_stock: item.in_stock !== false,
    __discovery_provider: 'relationship_graph',
    __relationship_graph_rank: rank,
    relationship_graph: {
      edge_id: item.relationship_edge_id || null,
      relationship_type: item.relationship_type || item.relation_type || null,
      score_total: Number.isFinite(Number(item.x_score)) ? Number(item.x_score) : null,
    },
  };
}

module.exports = {
  SURFACE_FLAGS,
  normalizeSurface,
  parseBooleanFlag,
  isRelationshipGraphSurfaceEnabled,
  fetchRelationshipGraphRecallForAnchor,
  fetchRelationshipGraphRecallForAnchors,
  mergeRelationshipGraphRecallItems,
  mapRelationshipGraphItemToDiscoveryProduct,
  __internal: {
    buildRelationshipGraphFetchMetadata,
    fallbackRelationshipGraphDedupe,
  },
};
