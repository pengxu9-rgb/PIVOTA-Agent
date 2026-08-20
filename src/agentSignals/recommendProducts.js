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
//  - it calls an external decision service (AURORA_DECISION_BASE_URL) — seconds, not milliseconds; the
//    door's heartbeat keeps the connection alive. `budgetMs` is passed to the lane's own deadline for its
//    enrichment/framework passes; the upstream LLM leg is bounded separately by the lane's
//    AURORA_BFF_RECO_UPSTREAM_TIMEOUT_MS (8s, hard cap 12s), so it is a hint, not a hard ceiling;
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
function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** The lane's integer 0-100 score as a band an agent can act on (never the raw score: see `fit`). */
function scoreBand(score) {
  if (score === null) return null;
  if (score >= 80) return 'high';
  if (score >= 55) return 'medium';
  return 'low';
}

function finiteNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Structured price-ceiling constraint keys (canonicalized: lowercased, separators removed). Only a
// NUMERIC value under one of these counts — `budget: "under $40"` is free text the LLM may honour or
// not, and parsing dollar amounts out of prose is exactly the guessing this pass must not do.
const PRICE_MAX_KEYS = new Set(['pricemax', 'maxprice', 'budget', 'budgetmax', 'maxbudget', 'pricelimit', 'priceceiling']);
// A why/notes line that asserts price/budget fit. Only consulted on an item that FAILED the price
// comparison, where any such claim is by definition false or unverifiable.
const BUDGET_FIT_CLAIM_RE = /budget|price|afford|cheap|inexpensive|\$\s*\d/i;

/**
 * The buyer's structured price ceiling, read from the RAW constraints object (pre-normalization, so a
 * numeric 40 is still a number). Returns the smallest recognized ceiling, or null when none is present.
 */
function extractPriceMax(raw) {
  if (!isPlainObject(raw)) return null;
  let min = null;
  for (const [key, value] of Object.entries(raw)) {
    const k = str(key).toLowerCase().replace(/[^a-z]/g, '');
    if (!PRICE_MAX_KEYS.has(k)) continue;
    const n = finiteNumber(value);
    if (n === null || n <= 0) continue;
    if (min === null || n < min) min = n;
  }
  return min;
}

/**
 * Deterministic enforcement of a structured price ceiling against the GROUNDED catalog price on a
 * projected signal — the check the LLM cannot be trusted to do (live 2026-08-20: a $45 product answered
 * "under $40" with a why[] line claiming budget fit). An item whose price is unknown cannot be verified
 * and is left alone; ungrounded items carry no price by construction.
 */
function violatesPriceMax(signal, priceMax) {
  const price = signal?.value?.product?.price;
  return typeof price === 'number' && price > priceMax;
}

/** Mark a violating signal in place: fit downgraded, machine-readable violation, false why lines stripped. */
function markPriceViolation(signal, priceMax) {
  const v = signal.value;
  const price = v.product.price;
  const currency = v.product.currency;
  // Any budget/price-fit claim on an item that FAILED the comparison is false — strip rather than
  // forward it to a partner agent that will trust it. This is the bridge's job, not the sanitizer's.
  v.why = v.why.filter((line) => !BUDGET_FIT_CLAIM_RE.test(line));
  v.notes = v.notes.filter((line) => !BUDGET_FIT_CLAIM_RE.test(line));
  const marker = `exceeds price_max ${priceMax}: price ${price}${currency ? ` ${currency}` : ''}`;
  // The marker leads so the 6-item watchouts cap can never truncate it away.
  v.watchouts = dedupe([marker, ...v.watchouts]).slice(0, 6);
  v.fit = { ...v.fit, level: 'low' };
  v.constraint_violations = [{ constraint: 'price_max', limit: priceMax, price, currency: currency || null }];
  return signal;
}

/**
 * The agent's uid for the lane: namespaced, stable per calling agent, never a consumer uid.
 *
 * The lane keys its anti-repeat diversity memory on this, so it must be stable per caller AND
 * distinct between callers: one shared `agent:anonymous` bucket would let one caller's history
 * filter another's results. Callers with no resolved agent_id fall back to the auth key's
 * fingerprint (already non-reversible), and only a wholly unauthenticated context lands in the
 * shared bucket.
 */
function agentLaneUid(ctx) {
  const agentId = str(ctx?.agent_id) || str(ctx?.invokeAuth?.agent_id);
  if (agentId) return `agent:${agentId}`;
  const fingerprint = str(ctx?.invokeAuth?.key_fingerprint);
  if (fingerprint) return `agentkey:${fingerprint}`;
  return 'agent:anonymous';
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

/**
 * One lane recommendation item → one `recommendation` Signal. Returns null for an item with no identity.
 *
 * THE FIELD NAMES COME FROM THE LANE'S OWN OUTPUT CONTRACT — prompts/reco_main_v1_2.user_schema.json
 * (`output_schema.recommendations[]`): slot, step, score, product_type, brand, name, display_name,
 * use_case, concern_match, skin_fit, constraint_notes, query_terms, reasons, sku{…}, missing_info,
 * warnings — plus what `buildRecoVisibleProductFields` attaches on the grounded path (price as a
 * `{amount, currency}` OBJECT, image_url, url/pdp_url/product_url) and what `coerceRecoItemForUi`
 * normalizes (notes, pdp_open, grounding_status). An earlier version read `why_candidate`,
 * `watchouts`, `fit_level`, `evidence_grade` and `pdp_open.directUrl` — none of which this lane
 * emits — so every real call answered with empty reasoning and a null price.
 */
function recommendationItemToSignal(item, { rank } = {}) {
  if (!isPlainObject(item)) return null;
  const sku = isPlainObject(item.sku) ? item.sku : isPlainObject(item.product) ? item.product : {};
  const pdpOpen = isPlainObject(item.pdp_open) ? item.pdp_open : {};
  const external = isPlainObject(pdpOpen.external) ? pdpOpen.external : {};
  const pdpSubject = isPlainObject(pdpOpen.subject) ? pdpOpen.subject : {};

  const productId = firstString(sku.product_id, sku.productId, item.product_id, item.productId);
  const merchantId = firstString(sku.merchant_id, item.merchant_id);
  const title = firstString(sku.display_name, sku.displayName, sku.name, item.display_name, item.displayName, item.name, item.title);
  const brand = firstString(sku.brand, item.brand);
  const category = firstString(sku.category, item.category, item.product_type);
  const url = firstString(external.url, item.pdp_url, item.pdpUrl, item.url, item.product_url, sku.pdp_url);
  // Internally-grounded items open through Pivota rather than a direct URL: surface the ref the
  // platform can hand back to get_product instead of leaving the agent with an id it cannot open.
  const productRef = firstString(pdpOpen.product_ref, pdpSubject.product_group_id, pdpSubject.id);
  const imageUrl = firstString(sku.image_url, sku.imageUrl, item.image_url, item.imageUrl);
  // The lane's price is a normalized OBJECT ({amount, currency, unknown}) built by
  // extractCatalogCandidatePrice; a bare number/string only appears on unnormalized rows.
  const priceObj = isPlainObject(item.price) ? item.price : isPlainObject(sku.price) ? sku.price : null;
  const price = finiteNumber(priceObj ? priceObj.amount : (sku.price ?? item.price));
  const currency = firstString(priceObj && priceObj.currency, sku.currency, item.currency);
  const grounded = item.grounding_status !== 'ungrounded';

  // A recommendation with neither an id nor a name is not something an agent can act on.
  if (!productId && !title) return null;

  // `reasons` is the lane's per-item rationale; `use_case`, `concern_match` and `skin_fit` say who
  // and what it is for. coerceRecoItemForUi folds some of these into `notes`, so both are read and
  // deduplicated.
  const why = [
    ...asStringArray(item.reasons, 6),
    ...asStringArray(item.use_case, 1),
    ...asStringArray(item.concern_match, 3),
    ...asStringArray(item.skin_fit, 3),
  ];
  const notes = asStringArray(item.notes, 6).filter((n) => !why.includes(n));
  // Real caution content: constraint_notes (why a constraint forced or blocked something) and the
  // per-item warnings the lane emits.
  const watchouts = [...asStringArray(item.constraint_notes, 4), ...asStringArray(item.warnings, 4)];

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
        // A canonical ref the platform can pass to get_product when there is no direct URL.
        product_ref: productRef || null,
        image_url: imageUrl || null,
      },
      why: dedupe(why).slice(0, 8),
      watchouts: dedupe(watchouts).slice(0, 6),
      notes: notes.slice(0, 4),
      routine_step: firstString(item.step, item.slot),
      product_type: firstString(item.product_type),
      // Grounded = resolved to a product in Pivota's catalog; ungrounded = the lane named a product it could
      // not resolve, and such items carry NO url/price by construction (the lane strips them).
      grounding: grounded ? 'catalog' : 'ungrounded',
      fit: {
        // Not a bare `confidence`/`score`: the sanitizer removes those keys from product-shaped nodes.
        // The lane emits an integer 0-100 `score`; it is surfaced as a BAND, which is what an agent can
        // act on, and lane-level certainty stays on metadata.confidence_overall.
        level: scoreBand(finiteNumber(item.score)),
      },
    },
    evidence: {
      // This lane is an LLM recommendation grounded (or not) in Pivota's catalog — it carries no
      // graded evidence bundle. `get_intel` is the tool that does; the description says so, and
      // inventing a grade here would be exactly the fabrication this repo keeps removing.
      method: grounded ? 'llm_recommendation_catalog_grounded' : 'llm_recommendation',
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
    // `text`, NOT `id`: resultSanitizer exempts id-shaped keys from PAN redaction on the premise that
    // their values are Pivota's own identifiers. This is buyer-authored prose, so it must sit under a
    // key that stays scrubbed.
    const subject = { kind: 'need', text: need || null };

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
    // DETERMINISTIC CONSTRAINT ENFORCEMENT. The lane only ever sees constraints as prompt text
    // (normalizeConstraints → buildAsk), so nothing upstream guarantees the shortlist honours them —
    // live 2026-08-20 a "under $40" need answered with a $45 product whose why[] asserted budget fit.
    // With a structured price ceiling present, verified-conforming items fill the limit FIRST (lane
    // order preserved); violating items are kept only in slots left over, each carrying an explicit
    // machine-readable violation — so a near-miss is still visible when the shortlist is thin, but can
    // never displace a conforming item, and never travels as a clean recommendation.
    const priceMax = extractPriceMax(isPlainObject(p.constraints) ? p.constraints : null);
    const projected = [];
    for (const item of items) {
      const s = recommendationItemToSignal(item, {});
      if (s) projected.push(s);
      if (priceMax === null && projected.length >= limit) break;
    }
    let signals;
    let violationsReturned = 0;
    if (priceMax === null) {
      signals = projected;
    } else {
      const conforming = projected.filter((s) => !violatesPriceMax(s, priceMax));
      signals = conforming.slice(0, limit);
      for (const s of projected) {
        if (signals.length >= limit) break;
        if (!violatesPriceMax(s, priceMax)) continue;
        signals.push(markPriceViolation(s, priceMax));
        violationsReturned += 1;
      }
    }
    signals.forEach((s, i) => { s.value.rank = i + 1; });
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
        // The ceiling this pass actually enforced (null = no structured ceiling, nothing was checked)
        // and how many returned signals carry a price violation marker — so a partner agent can tell
        // "all conforming" from "the shortlist includes flagged near-misses" without rescanning items.
        ...(priceMax !== null ? { price_max_enforced: priceMax, constraint_violations_returned: violationsReturned } : {}),
        ...(signals.length === 0 && items.length > 0 ? { dropped_unidentified_items: items.length } : {}),
      },
    };
  };
}

module.exports = { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid, extractPriceMax };
