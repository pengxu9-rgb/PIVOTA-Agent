'use strict';

const {
  buildAnchorRefsFromProduct,
  readApprovedRelationshipEdgesForAnchor,
  relationshipEdgeToSimilarItem,
} = require('../auroraBff/productRelationshipGraph');
const {
  recordRelationshipGraphRecall,
} = require('../observability/relationshipGraphMetrics');
const {
  resolveAnchorIdentityForRelationshipGraph,
  applyAnchorIdentity,
} = require('./catalogEntityResolution');

const SURFACE_FLAGS = Object.freeze({
  pdp_similar: 'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
  find_similar_products: 'AURORA_BFF_RELATIONSHIP_GRAPH_PDP_ENABLED',
  discovery_feed: 'AURORA_BFF_RELATIONSHIP_GRAPH_DISCOVERY_ENABLED',
  chat_alternatives: 'AURORA_BFF_RELATIONSHIP_GRAPH_CHAT_ALTERNATIVES_ENABLED',
  // Agent-facing surface (MCP get_alternatives). Gated independently from the consumer pilot so enabling
  // it for external agents is a deliberate, separate flip. Checked strictly (no ALL_FEEDS fallback) at the
  // wiring site in server.js so the agent surface never rides on a consumer flag.
  agent_alternatives: 'AURORA_BFF_RELATIONSHIP_GRAPH_AGENT_ENABLED',
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

// The relation types the shopper "similar" surfaces serve. `related_product` is held by default: the
// builder files every same-brand non-substitute pair there (prod 2026-10-08: 6,355 of 6,355 served
// related_product edges are same-brand) while the reviewer treats it as a complement, so it is not yet
// a relation a similar rail can stand behind. Every other type keeps being served. The variable
// AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES (comma list) overrides; an explicit caller list
// always wins. Other surfaces are unchanged.
const SIMILAR_SURFACES = new Set(['pdp_similar', 'find_similar_products']);
const DEFAULT_SIMILAR_RELATION_TYPES = Object.freeze(['dupe', 'competitive_alternative', 'niche_specialist']);
const KNOWN_RELATION_TYPES = new Set(['dupe', 'competitive_alternative', 'niche_specialist', 'related_product']);

function resolveServingRelationTypes(surface, relationTypes, env = process.env) {
  if (Array.isArray(relationTypes) && relationTypes.length) return relationTypes;
  if (!SIMILAR_SURFACES.has(normalizeSurface(surface))) return relationTypes;
  const configured = String(env?.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_RELATION_TYPES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => KNOWN_RELATION_TYPES.has(value));
  return configured.length ? Array.from(new Set(configured)) : [...DEFAULT_SIMILAR_RELATION_TYPES];
}

// A similar rail is for OTHER products a shopper could pick instead. Prod 2026-10-12: 743 of 7,116
// served alternatives were the anchor's own brand, and on 221 of 2,634 rails every card was (Elizabeth
// Arden Green Tea Pomegranate -> Red Door, Kose Clear Turn mask -> another Clear Turn mask). A rail
// shows at most AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX (default 1) same-brand cards,
// after every cross-brand card. Two steps, so the cap never empties a rail the filters would not:
// - recall puts cross-brand edges first and tags each same-brand item (similar_same_brand);
// - capSimilarSameBrandItems, run by the final public filter on the cards that SURVIVED serving
//   (renderable PDP, image, currency), keeps the first `max` tagged ones and strips the tag.
// A negative value turns the cap off. Edges are not changed: the reviewer and the other surfaces
// still see them.
const DEFAULT_SIMILAR_SAME_BRAND_MAX = 1;
const SAME_BRAND_TAG = 'similar_same_brand';

function resolveSimilarSameBrandMax(env = process.env) {
  const raw = String(env?.AURORA_BFF_RELATIONSHIP_GRAPH_SIMILAR_SAME_BRAND_MAX ?? '').trim();
  if (!/^-?\d+$/.test(raw)) return DEFAULT_SIMILAR_SAME_BRAND_MAX;
  const value = Number(raw);
  return value < 0 ? Infinity : value;
}

// The brand field only: a vendor can be a multi-brand reseller. Folds case, accents, punctuation and a
// leading "The" (The Ordinary / Ordinary); not romanisation or parent/sub-brands.
function brandKey(snapshot) {
  const src = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const brand = src.brand && typeof src.brand === 'object' ? src.brand.name : src.brand;
  return String(brand || src.brand_name || src.brandName || '')
    // Latin accents fold (é -> e); NFC then recomposes what other scripts mean (kana voicing: ガ != カ).
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^\s*the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function isSameBrandSimilarEdge(edge = {}, anchorBrandKey = '') {
  const candidateKeys = [brandKey(edge.candidate_display_snapshot), brandKey(edge.candidate_snapshot)].filter(Boolean);
  const anchorKeys = [anchorBrandKey, brandKey(edge.anchor_snapshot)].filter(Boolean);
  return candidateKeys.some((key) => anchorKeys.includes(key));
}

function orderSameBrandSimilarEdges(edges = [], { anchorProduct = {} } = {}) {
  const anchorBrandKey = brandKey(anchorProduct);
  const crossBrand = [];
  const sameBrand = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    (isSameBrandSimilarEdge(edge, anchorBrandKey) ? sameBrand : crossBrand).push(edge);
  }
  return { edges: [...crossBrand, ...sameBrand], sameBrandEdges: new Set(sameBrand) };
}

// The serving-side cap: keeps the first `max` tagged cards (in rail order), drops the rest, and strips
// the tag from every card. Untagged cards (cross-brand, dynamic recall) pass untouched.
function capSimilarSameBrandItems(items = [], max = resolveSimilarSameBrandMax()) {
  let kept = 0;
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || !(SAME_BRAND_TAG in item)) {
      out.push(item);
      continue;
    }
    const { [SAME_BRAND_TAG]: tagged, ...rest } = item;
    if (tagged === true) {
      if (kept >= max) continue;
      kept += 1;
    }
    out.push(rest);
  }
  return out;
}

function buildRelationshipGraphFetchMetadata({
  surface,
  enabled,
  anchorRefs = [],
  edges = [],
  items = [],
  error = null,
  diagnostics = null,
} = {}) {
  return {
    source: 'relationship_graph',
    surface: normalizeSurface(surface),
    enabled: Boolean(enabled),
    query_attempted: Boolean(enabled && anchorRefs.length > 0),
    anchor_ref_count: Array.isArray(anchorRefs) ? anchorRefs.length : 0,
    edge_count: Array.isArray(edges) ? edges.length : 0,
    item_count: Array.isArray(items) ? items.length : 0,
    edge_count_semantics: 'returned_eligible_edges',
    read_status: diagnostics?.read_status || (!enabled || !anchorRefs.length ? 'not_attempted' : error ? 'unavailable' : 'unknown'),
    read_reason: diagnostics?.read_reason ?? (!enabled ? 'disabled' : !anchorRefs.length ? 'no_anchor_refs' : error ? 'read_failed' : null),
    ...(error ? { error: String(error) } : {}),
  };
}

// An additive public contract. Old cached/mocked results remain unknown instead
// of being relabeled empty, and arbitrary database error text is never projected.
function relationshipGraphReadMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
  const statuses = new Set(['ready', 'empty', 'unavailable', 'not_attempted']);
  const reasons = new Set(['no_eligible_edges', 'no_database', 'schema_unavailable', 'no_anchor_refs', 'disabled', 'read_failed']);
  return {
    relationship_graph_read_status: statuses.has(metadata.read_status) ? metadata.read_status : 'unknown',
    relationship_graph_read_reason: reasons.has(metadata.read_reason) ? metadata.read_reason : null,
    relationship_graph_edge_count_semantics: 'returned_eligible_edges',
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
  const startedAt = Date.now();
  const normalizedSurface = normalizeSurface(surface);
  const surfaceEnabled =
    enabled == null ? isRelationshipGraphSurfaceEnabled(normalizedSurface) : enabled === true;
  if (!surfaceEnabled) {
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: 'disabled',
      latencyMs: Date.now() - startedAt,
    });
    return {
      edges: [],
      items: [],
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: false,
      }),
    };
  }

  // Hydrate the anchor with its full identity set (sig + grouped source ids) so the read path matches
  // both sig-keyed and source-keyed edges. Flag-gated + fail-open: on null/throw we keep the thin refs.
  let hydratedAnchor = anchorProduct || {};
  try {
    const identity = await resolveAnchorIdentityForRelationshipGraph({
      product_id: hydratedAnchor.product_id || hydratedAnchor.productId,
      merchant_id: hydratedAnchor.merchant_id || hydratedAnchor.merchantId,
    });
    if (identity) hydratedAnchor = applyAnchorIdentity(hydratedAnchor, identity);
  } catch {
    /* fail-open */
  }
  const anchorRefs = buildAnchorRefsFromProduct(hydratedAnchor);
  if (!anchorRefs.length) {
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: 'no_anchor_refs',
      latencyMs: Date.now() - startedAt,
      anchorRefCount: 0,
    });
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
    const requestedLimit = Math.max(1, Math.min(120, Number(limit) || 24));
    const sameBrandMax = SIMILAR_SURFACES.has(normalizedSurface) ? resolveSimilarSameBrandMax() : Infinity;
    const { edges: readEdges, diagnostics } = await readApprovedRelationshipEdgesForAnchor({
      anchorType: 'product',
      anchorRefs,
      market,
      relationTypes: resolveServingRelationTypes(normalizedSurface, relationTypes),
      // Read past the rail so the cross-brand cards behind the same-brand ones still fill it.
      limit: Number.isFinite(sameBrandMax) ? Math.min(120, requestedLimit * 2) : requestedLimit,
      ...(typeof queryFn === 'function' ? { queryFn } : {}),
    });
    const ordered = Number.isFinite(sameBrandMax)
      ? orderSameBrandSimilarEdges(readEdges, { anchorProduct: hydratedAnchor })
      : { edges: Array.isArray(readEdges) ? readEdges : [], sameBrandEdges: new Set() };
    // The rail keeps a short same-brand tail past its size: the serving cap needs a fallback when the
    // cross-brand cards fail the serving filters (dead PDP, no image, currency).
    const head = ordered.edges.slice(0, requestedLimit);
    const headSameBrand = head.filter((edge) => ordered.sameBrandEdges.has(edge)).length;
    const tailRoom = Number.isFinite(sameBrandMax) && sameBrandMax > 0 ? Math.max(0, sameBrandMax + 2 - headSameBrand) : 0;
    const edges = [...head, ...ordered.edges.slice(requestedLimit).filter((edge) => ordered.sameBrandEdges.has(edge)).slice(0, tailRoom)];
    const items = edges
      .map((edge) => {
        const item = relationshipEdgeToSimilarItem(edge);
        return item && ordered.sameBrandEdges.has(edge) ? { ...item, [SAME_BRAND_TAG]: true } : item;
      })
      .filter(Boolean);
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: diagnostics.read_status === 'unavailable' ? 'unavailable' : 'success',
      ...(diagnostics.read_status === 'unavailable' ? { error: diagnostics.read_reason } : {}),
      latencyMs: Date.now() - startedAt,
      anchorRefCount: anchorRefs.length,
      edgeCount: edges.length,
      itemCount: items.length,
    });
    return {
      edges,
      items,
      metadata: {
        ...buildRelationshipGraphFetchMetadata({
          surface: normalizedSurface,
          enabled: true,
          anchorRefs,
          edges,
          items,
          diagnostics,
        }),
        ...(Number.isFinite(sameBrandMax)
          ? { same_brand_max: sameBrandMax, same_brand_read_count: ordered.sameBrandEdges.size }
          : {}),
      },
    };
  } catch (err) {
    logger?.warn?.(
      {
        err: err?.message || String(err),
        surface: normalizedSurface,
      },
      'relationship graph recall fetch failed',
    );
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      anchorRefCount: anchorRefs.length,
      error: err?.code || err?.message || 'fetch_failed',
    });
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
  const startedAt = Date.now();
  const normalizedSurface = normalizeSurface(surface);
  const surfaceEnabled =
    enabled == null ? isRelationshipGraphSurfaceEnabled(normalizedSurface) : enabled === true;
  if (!surfaceEnabled) {
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: 'disabled',
      latencyMs: Date.now() - startedAt,
    });
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
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: 'no_anchor_refs',
      latencyMs: Date.now() - startedAt,
      anchorRefCount: 0,
    });
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
    const { edges, diagnostics } = await readApprovedRelationshipEdgesForAnchor({
      anchorType: 'product',
      anchorRefs,
      market,
      relationTypes: resolveServingRelationTypes(normalizedSurface, relationTypes),
      limit: Math.max(1, Math.min(120, Number(limit) || 24)),
      ...(typeof queryFn === 'function' ? { queryFn } : {}),
    });
    const items = (Array.isArray(edges) ? edges : []).map(relationshipEdgeToSimilarItem).filter(Boolean);
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: diagnostics.read_status === 'unavailable' ? 'unavailable' : 'success',
      ...(diagnostics.read_status === 'unavailable' ? { error: diagnostics.read_reason } : {}),
      latencyMs: Date.now() - startedAt,
      anchorRefCount: anchorRefs.length,
      edgeCount: Array.isArray(edges) ? edges.length : 0,
      itemCount: items.length,
    });
    return {
      edges: Array.isArray(edges) ? edges : [],
      items,
      metadata: buildRelationshipGraphFetchMetadata({
        surface: normalizedSurface,
        enabled: true,
        anchorRefs,
        edges,
        items,
        diagnostics,
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
    recordRelationshipGraphRecall({
      surface: normalizedSurface,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      anchorRefCount: anchorRefs.length,
      error: err?.code || err?.message || 'fetch_failed',
    });
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
  capSimilarSameBrandItems,
  orderSameBrandSimilarEdges,
  resolveSimilarSameBrandMax,
  SURFACE_FLAGS,
  relationshipGraphReadMetadata,
  normalizeSurface,
  parseBooleanFlag,
  isRelationshipGraphSurfaceEnabled,
  fetchRelationshipGraphRecallForAnchor,
  fetchRelationshipGraphRecallForAnchors,
  mergeRelationshipGraphRecallItems,
  mapRelationshipGraphItemToDiscoveryProduct,
  resolveServingRelationTypes,
  __internal: {
    buildRelationshipGraphFetchMetadata,
    fallbackRelationshipGraphDedupe,
  },
};
