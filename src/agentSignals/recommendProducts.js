'use strict';

// recommend_products — a NEED in natural language → a reasoned shortlist, as agent-facing Signals.
//
// This is the bridge from Pivota's prompt-level recommendation lane (the Aurora BFF's
// `generateProductRecommendations`, the engine behind POST /v1/reco/generate) to the commerce doors. The
// lane is injected, not imported: it is a large closure over the Aurora routes module, so this file owns
// only (a) the agent-side contract (what the model sends, what it gets back) and (b) the projection of the
// lane's UI envelope into the `{ subject, signals[], metadata }` shape every other insights tool uses.
//
// HONEST LIMITS, stated in the tool description too:
//  - the lane is the Aurora BEAUTY engine today: its prompts, catalog grounding and guardrails are tuned for
//    skincare/beauty. An off-vertical need answers with an empty shortlist + `missing_info`, not with
//    fabricated products;
//  - it calls an external decision service (AURORA_DECISION_BASE_URL) — seconds, not milliseconds; the door's
//    heartbeat keeps the connection alive; `budgetMs` bounds the call;
//  - results are NOT cached: the lane keeps a per-caller diversity memory, so two identical calls may differ
//    on purpose.
//
// IDENTITY. The lane keys profile / anti-repeat memory on a uid. Here the uid is a NAMESPACED synthetic per
// calling agent (`agent:<agent_id>`), never a consumer uid, so an agent call can neither read a consumer's
// stored profile nor write into one. No bearer is passed, so the lane's identity-link write never runs.
//
// SANITIZER-SAFE BY CONSTRUCTION. The commerce surface strips `score`/`confidence` from product-shaped nodes
// and drops `score_breakdown`/`candidate_source`/`debug` anywhere (safety-kernel/src/protocol/resultSanitizer).
// Per-item certainty therefore lives under `value.fit` (not a bare `confidence`), and the overall certainty
// sits on `metadata` (not a product node).

const MAX_NEED_CHARS = 500;
const MAX_CONSTRAINT_KEYS = 8;
const MAX_CONSTRAINT_VALUE_CHARS = 120;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_BUDGET_MS = 9000;

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}
function firstString(...values) {
  for (const v of values) if (nonEmpty(v)) return v.trim();
  return null;
}
function asStringArray(v, max = 6) {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter(Boolean).slice(0, max);
  if (nonEmpty(v)) return [v.trim()];
  return [];
}
function finiteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** The agent's uid for the lane: namespaced, stable per calling agent, never a consumer uid. */
function agentLaneUid(ctx) {
  const agentId = str(ctx?.agent_id) || str(ctx?.invokeAuth?.agent_id);
  return `agent:${agentId || 'anonymous'}`;
}

/** Normalize + bound the model's constraints into the lane's free-form map (strings only, bounded). */
function normalizeConstraints(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = str(key);
    if (!k || k.length > 64 || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    let rendered;
    if (Array.isArray(value)) rendered = value.map((x) => str(typeof x === 'number' ? String(x) : x)).filter(Boolean).slice(0, 8).join(', ');
    else if (typeof value === 'number' && Number.isFinite(value)) rendered = String(value);
    else if (typeof value === 'boolean') rendered = value ? 'yes' : 'no';
    else if (isPlainObject(value)) {
      try { rendered = JSON.stringify(value); } catch { rendered = ''; }
    } else rendered = str(value);
    if (!rendered) continue;
    out[k] = rendered.slice(0, MAX_CONSTRAINT_VALUE_CHARS);
    if (Object.keys(out).length >= MAX_CONSTRAINT_KEYS) break;
  }
  return out;
}

/** One lane recommendation item → one `recommendation` Signal. Returns null for an item with no identity. */
function recommendationItemToSignal(item, { rank } = {}) {
  if (!isPlainObject(item)) return null;
  const sku = isPlainObject(item.sku) ? item.sku : isPlainObject(item.product) ? item.product : {};
  const pdpOpen = isPlainObject(item.pdp_open) ? item.pdp_open : {};
  const canonicalRef = isPlainObject(pdpOpen.canonicalProductRef) ? pdpOpen.canonicalProductRef : {};
  const external = isPlainObject(pdpOpen.external) ? pdpOpen.external : {};

  const productId = firstString(sku.product_id, sku.productId, item.product_id, item.productId, canonicalRef.product_id);
  const merchantId = firstString(sku.merchant_id, item.merchant_id, canonicalRef.merchant_id);
  const title = firstString(sku.display_name, sku.displayName, sku.name, item.display_name, item.displayName, item.name, item.title);
  const brand = firstString(sku.brand, item.brand);
  const category = firstString(sku.category, item.category);
  const url = firstString(pdpOpen.directUrl, external.url, item.pdp_url, item.pdpUrl, item.url, item.product_url);
  const imageUrl = firstString(sku.image_url, sku.imageUrl, item.image_url, item.imageUrl);
  const price = finiteNumber(sku.price ?? item.price);
  const currency = firstString(sku.currency, item.currency);
  const grounded = item.grounding_status !== 'ungrounded';

  // A recommendation with neither an id nor a name is not something an agent can act on.
  if (!productId && !title) return null;

  const why = isPlainObject(item.why_candidate)
    ? [str(item.why_candidate.summary), ...asStringArray(item.why_candidate.reasons_user_visible ?? item.why_candidate.reasons)].filter(Boolean)
    : asStringArray(item.why_candidate ?? item.why ?? item.reason);
  const notes = asStringArray(item.notes);
  const watchouts = asStringArray(item.watchouts ?? item.cautions ?? item.boundary_user_visible, 4);

  return {
    signal_type: 'recommendation',
    subject: { kind: 'product', id: productId || null },
    value: {
      rank: Number.isInteger(rank) ? rank : null,
      product: {
        product_id: productId || null,
        merchant_id: merchantId || null,
        title: title || null,
        brand: brand || null,
        category: category || null,
        price,
        currency: currency || null,
        url: url || null,
        image_url: imageUrl || null,
      },
      why: why.slice(0, 6),
      watchouts,
      notes: notes.slice(0, 4),
      routine_step: firstString(item.step, item.slot),
      // Grounded = resolved to a product in Pivota's catalog; ungrounded = the lane named a product it could
      // not resolve, and such items carry NO url/price by construction (the lane strips them).
      grounding: grounded ? 'catalog' : 'ungrounded',
      fit: {
        // Not a bare `confidence`: the sanitizer removes that key from product-shaped nodes. Lane-level
        // certainty is on metadata.confidence_overall.
        level: firstString(item.fit_level, item.confidence_level) || null,
      },
    },
    evidence: {
      grade: firstString(item.evidence_grade) || null,
      method: grounded ? 'llm_recommendation_catalog_grounded' : 'llm_recommendation',
      sources: asStringArray(item.evidence_refs ?? item.sources, 6),
    },
    visibility: 'buyer_safe',
  };
}

/**
 * @param {{
 *   generate: (args:object) => Promise<object>,   // Aurora routes.__internal.generateProductRecommendations
 *   buildAsk?: ({focus, constraints, lang}) => string, // routes.__internal.buildRecoGenerateUserAsk
 *   isEnabled?: () => boolean,                     // agent-surface flag (fail-closed when absent)
 *   logger?: { warn?: Function, info?: Function },
 *   budgetMs?: number,
 *   now?: () => number,
 * }} deps
 */
function makeRecommendProducts(deps = {}) {
  const { generate, buildAsk, isEnabled, logger } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const budgetMs = Number.isFinite(deps.budgetMs) && deps.budgetMs > 0 ? deps.budgetMs : DEFAULT_BUDGET_MS;
  if (typeof generate !== 'function') throw new Error('makeRecommendProducts requires generate');

  return async function recommendProducts(params = {}, ctx = {}) {
    const p = (params && params.payload) || params || {};
    const need = str(p.need).slice(0, MAX_NEED_CHARS);
    const subject = { kind: 'need', id: need || null };

    if (typeof isEnabled === 'function' && !isEnabled()) {
      return { subject, signals: [], metadata: { reason: 'disabled' } };
    }
    if (!need) {
      return { subject, signals: [], metadata: { reason: 'need_required' } };
    }

    const constraints = normalizeConstraints(p.constraints);
    const limitRaw = Number(p.limit);
    const limit = Number.isInteger(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, limitRaw)) : DEFAULT_LIMIT;
    const lang = str(p.language).toUpperCase() === 'CN' ? 'CN' : 'EN';
    const uid = agentLaneUid(ctx);
    const requestId = `rp_${Math.random().toString(36).slice(2, 12)}`;
    const laneCtx = {
      request_id: requestId,
      trace_id: requestId,
      aurora_uid: uid,
      brief_id: null,
      lang,
      ui_lang: lang,
      match_lang: lang,
      language_mismatch: false,
      language_resolution_source: 'agent_tool',
      trigger_source: 'agent_tool',
      state: null,
      backend_auth_headers: {},
    };
    const message = typeof buildAsk === 'function'
      ? buildAsk({ focus: need, constraints, lang })
      : `Recommend a few products for me with focus on ${need}.`;

    const startedAt = now();
    let result;
    try {
      result = await generate({
        ctx: laneCtx,
        profile: null,
        recentLogs: [],
        message,
        focus: need,
        analysisContextSnapshot: null,
        requestOverride: null,
        includeAlternatives: false,
        debug: false,
        logger,
        recoTriggerSource: 'agent_tool',
        entryType: 'direct',
        budgetMs,
      });
    } catch (err) {
      logger?.warn?.({ err: err?.message || String(err) }, 'recommend_products lane failed');
      return { subject, signals: [], metadata: { reason: 'lane_unavailable', latency_ms: now() - startedAt } };
    }
    const latencyMs = now() - startedAt;

    const norm = isPlainObject(result?.norm) ? result.norm : null;
    const payload = isPlainObject(norm?.payload) ? norm.payload : isPlainObject(norm) ? norm : {};
    const items = Array.isArray(payload.recommendations) ? payload.recommendations : [];
    const signals = [];
    for (const item of items) {
      const s = recommendationItemToSignal(item, { rank: signals.length + 1 });
      if (s) signals.push(s);
      if (signals.length >= limit) break;
    }
    const meta = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
    const confidence = finiteNumber(payload.confidence);

    return {
      subject,
      signals,
      metadata: {
        need,
        constraints,
        limit,
        returned: signals.length,
        // Lane-level certainty. On metadata on purpose: the sanitizer strips `confidence` from PRODUCT nodes;
        // this node carries no product identity.
        confidence_overall: confidence,
        missing_info: asStringArray(payload.missing_info, 8),
        warnings: asStringArray(payload.warnings, 8),
        grounding_status: firstString(payload.grounding_status, meta.grounding_status) || null,
        source_mode: firstString(meta.source_mode, payload.source) || null,
        products_empty_reason: signals.length === 0 ? firstString(payload.products_empty_reason, result?.upstreamFailureCode) || 'no_recommendations' : null,
        vertical: 'beauty',
        latency_ms: latencyMs,
        ...(signals.length === 0 && items.length > 0 ? { dropped_unidentified_items: items.length } : {}),
      },
    };
  };
}

module.exports = { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid };
