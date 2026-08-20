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
// Live price re-verification bounds: check only the items that could reach the shortlist (limit plus a
// small margin for slots freed by the ceiling pass), and never let one slow PDP lookup hold the whole
// tool call — the race resolves null and the item degrades to its snapshot price, explicitly marked.
const PRICE_VERIFY_EXTRA = 2;
const PRICE_VERIFY_RACE_MS = 2500;
const PRICE_VERIFY_MAX_CHECKS = 8;

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

// Structured price-ceiling constraint keys (canonicalized: lowercased, separators removed). The VALUE
// must be a number, or a bare currency-marked numeral under one of these keys (`40`, `"40.00"`,
// `"40 USD"`, `"USD 40"`). Prose is refused: `budget: "under $40"` is free text the LLM may honour or
// not, and parsing an amount out of a sentence is exactly the guessing this pass must not do.
const PRICE_MAX_KEYS = new Set(['pricemax', 'maxprice', 'budget', 'budgetmax', 'maxbudget', 'pricelimit', 'priceceiling']);
// Keys whose value declares the CURRENCY the ceiling is denominated in. DERIVED from the ceiling keys
// rather than hand-listed: a hand-listed set covered `budget_currency` but not `budget_max_currency`,
// silently dropping a declaration and enforcing the number as USD.
const PRICE_CURRENCY_KEYS = new Set(['currency', 'pricecurrency']);
// Currencies the catalog plausibly carries. An allowlist, not a shape test: it keeps a key like
// `budget_cap` from being read as a ceiling denominated in "CAP".
const KNOWN_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'KRW', 'HKD', 'SGD', 'TWD', 'CHF', 'SEK', 'NZD']);
// The serving path normalizes catalog prices to USD (Shopify Markets USD; see the no_us_offer work), so
// an undeclared ceiling is read as USD. `metadata.price_max_currency` reports which it used, and a
// declared currency always wins — the assumption is visible to the caller, never silent.
const DEFAULT_PRICE_MAX_CURRENCY = 'USD';
for (const k of PRICE_MAX_KEYS) PRICE_CURRENCY_KEYS.add(`${k}currency`);

// Detecting a claim that the item MEETS the price constraint. Deliberately NOT a bare price-word match:
// watchouts is fed by the lane's `warnings` (its SAFETY field), where "Limit use to 2-3 times per week"
// and "Keep the cap closed" are ordinary copy — deleting a safety warning to suppress a budget claim is
// a worse trade than the defect it fixes. So a line is stripped only when it either
//   (a) asserts affordability outright (afford/cheap/inexpensive — inherently a claim about price), or
//   (b) pairs a price token with a FIT assertion ("within your $40 budget", "under the dollar cap").
// A subjective quality judgment ("a great price for the size") asserts nothing about the ceiling and is
// left alone: the marker and `constraint_violations` already carry the truth. Word-anchored so
// "Priceless glow" is not read as a price claim, and bilingual — `language: 'CN'` is a first-class
// parameter of this tool.
const AFFORDABILITY_CLAIM_RE = /\b(afford\w*|cheap\w*|inexpensive|budget-friendly|bargain)\b|便宜|实惠|划算|预算友好/i;
// A price token names MONEY. `value` is deliberately absent: it earns no strip on its own, and pairing
// it with a fit word deletes true copy ("a great-value serum that layers under makeup"). `spend`/`cost`
// are NOT bare tokens: in this lane's safety copy they are routinely about TIME and TOLERANCE ("limit
// the time you spend in the sun", "this acid costs you UV tolerance"), and a bare match pairs them with
// the fit word `limit` to delete a photosensitivity warning — a worse trade than the claim it suppresses.
// They count as money only inside an explicitly monetary construction (MONETARY_PHRASE_RE); when they sit
// next to an actual amount, the `[$£€¥]\s*\d` alternative already carries the line without their help.
const PRICE_TOKEN_RE = /\b(budget|price[ds]?|pricing|dollars?|usd)\b|[$£€¥]\s*\d|预算|价格|美元|价钱/i;
// The monetary idioms of `spend`/`cost` that appear WITHOUT an amount: a ceiling compound ("your stated
// spend limit", "spending cap") with the gap clause-bounded so "the time you spend in the sun … cap" in a
// later clause never joins, and a cost comparative ("costs less than you allowed", "the cost is lower
// than your maximum"). `spend under/below` is deliberately NOT here: that shape is the sunlight warning
// ("reduce the time you spend under direct sunlight"), while a real monetary "spends under your budget"
// still strips via its budget/amount token.
const MONETARY_PHRASE_RE = /\b(?:spend\w*|costs?)\b[^.;,，。；]{0,30}?\b(?:limit|cap|ceiling|budget|maximum|max)\b|\bcosts?\s+(?:is\s+|are\s+)?(?:much\s+|far\s+)?(?:less|lower|below|under)\b/i;
// A fit assertion names the CONSTRAINT being met — containment, comparison, or negated exceedance.
// `limit`/`cap`/`ceiling`/`maximum` live HERE rather than among the price tokens: alone they are
// ordinary skincare copy ("limit use to 2-3x per week", "keep the cap closed") and strip nothing; they
// only ever fire alongside a money word, which is exactly when they mean the buyer's ceiling.
const FIT_ASSERTION_RE = new RegExp([
  '\\b(within|under|below|inside|beneath|fits?|fitting|comfortably|meets?|stays?|keeps?)\\b',
  '\\b(less than|lower than|cheaper than|no more than|at most|respects?)\\b',
  '\\b(limit|cap|ceiling|maximum|max)\\b',
  "\\b(wo|do|does|will|is|are)n'?t\\s+(exceed|break|go over|top)\\b",
  '\\bwill not exceed\\b',
  '之内|以内|不超过|低于|范围内|预算内|不会超出|不高于',
].join('|'), 'i');

function assertsBudgetFit(line) {
  return AFFORDABILITY_CLAIM_RE.test(line)
    || ((PRICE_TOKEN_RE.test(line) || MONETARY_PHRASE_RE.test(line)) && FIT_ASSERTION_RE.test(line));
}

/**
 * Canonical form of a constraint key: lowercased, separators and punctuation removed. DIGITS ARE KEPT —
 * stripping them would fold a distinct key like `budget2` into `budget` and enforce a ceiling the caller
 * never asked for.
 */
function canonKey(key) {
  return str(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A ceiling value → `{ amount, currency }`, or null when it is not a bare numeral. */
function parseCeilingValue(value) {
  const n = finiteNumber(value);
  if (n !== null) return { amount: n, currency: null };
  // A structured numeral carrying its own ISO code — "40 USD" / "USD 40". NOT prose: anything with a
  // surrounding word ("under $40") fails this anchor and is refused.
  const m = /^([A-Z]{3})\s*([0-9]+(?:\.[0-9]+)?)$|^([0-9]+(?:\.[0-9]+)?)\s*([A-Z]{3})$/.exec(str(value).toUpperCase());
  if (!m) return null;
  const currency = m[1] || m[4];
  if (!KNOWN_CURRENCIES.has(currency)) return null;
  return { amount: Number(m[2] !== undefined ? m[2] : m[3]), currency };
}

/**
 * The buyer's structured price ceiling, read from the RAW constraints object (pre-normalization, so a
 * numeric 40 is still a number). Returns `{ limit, currency, declared }` for the smallest recognized
 * ceiling, or null when none is present. `unstructured` reports a budget-shaped key whose value was
 * prose — enforcement did not run, and the caller is told so rather than left to assume it did.
 */
function extractPriceMax(raw) {
  if (!isPlainObject(raw)) return null;
  let best = null;
  let declaredCurrency = null;
  let unstructured = null;
  for (const [key, value] of Object.entries(raw)) {
    const k = canonKey(key);
    if (PRICE_CURRENCY_KEYS.has(k)) {
      const c = str(value).toUpperCase();
      if (KNOWN_CURRENCIES.has(c)) declaredCurrency = c;
      continue;
    }
    // A currency-suffixed ceiling key: `price_max_usd` → ceiling in USD.
    let keyCurrency = null;
    let base = k;
    if (!PRICE_MAX_KEYS.has(k) && k.length > 3) {
      const suffix = k.slice(-3).toUpperCase();
      if (KNOWN_CURRENCIES.has(suffix) && PRICE_MAX_KEYS.has(k.slice(0, -3))) {
        base = k.slice(0, -3);
        keyCurrency = suffix;
      }
    }
    if (!PRICE_MAX_KEYS.has(base)) continue;
    const parsed = parseCeilingValue(value);
    if (parsed === null || parsed.amount <= 0) {
      // A refused value under a ceiling key is DISCLOSED, whatever its type: `nonEmpty` only sees
      // strings, so `price_max: [40]` (schema-legal) used to produce no metadata at all — byte-identical
      // to sending no constraint, which is the ambiguity this disclosure exists to remove.
      if (value !== null && value !== undefined && value !== '') {
        unstructured = parsed === null ? 'unstructured_value' : 'out_of_range_value';
      }
      continue;
    }
    // The winning (smallest) ceiling carries its own currency; a losing ceiling never lends it one.
    if (best === null || parsed.amount < best.limit) best = { limit: parsed.amount, currency: parsed.currency || keyCurrency };
  }
  if (best === null) return unstructured ? { unstructured } : null;
  const currency = best.currency || declaredCurrency;
  return { limit: best.limit, currency: currency || DEFAULT_PRICE_MAX_CURRENCY, declared: Boolean(currency), unstructured };
}

/**
 * Deterministic comparison of a structured price ceiling against the GROUNDED catalog price on a
 * projected signal — the check the LLM cannot be trusted to do (live 2026-08-20: a $45 product answered
 * "under $40" with a why[] line claiming budget fit).
 *
 * Returns 'ok' | 'violation' | 'unverifiable'. A price in a DIFFERENT currency than the ceiling is
 * `unverifiable`, never a violation: this bridge holds no FX rates, and comparing 4500 JPY against a
 * ceiling of 40 would fabricate both directions — a clean pass for 35 GBP over a $40 cap, and a bogus
 * violation for a ¥4500 item well under it. A price with NO currency is unverifiable for the same
 * reason: every grounded row carries one (normalizePriceObject stamps a currency on every return path),
 * so a currency-less amount is an unnormalized row whose unit is genuinely unknown — assuming the
 * ceiling's own would fabricate exactly the comparison this function exists to refuse. An item with no
 * resolvable price is likewise unverifiable (ungrounded items carry no price by construction).
 */
function checkPriceMax(signal, ceiling) {
  const product = signal?.value?.product || {};
  const price = product.price;
  if (typeof price !== 'number') return 'unverifiable';
  if (!nonEmpty(product.currency)) return 'unverifiable';
  if (product.currency.toUpperCase() !== ceiling.currency) return 'unverifiable';
  return price > ceiling.limit ? 'violation' : 'ok';
}

function stripBudgetClaims(lines) {
  return lines.filter((line) => !assertsBudgetFit(line));
}

/** Mark a violating signal in place: fit downgraded, machine-readable violation, false claims stripped. */
function markPriceViolation(signal, ceiling) {
  const v = signal.value;
  const price = v.product.price;
  // Guaranteed present: checkPriceMax only returns 'violation' for a price whose currency matches the
  // ceiling's. Never fall back to the ceiling's currency here — that would launder an ASSUMED unit into
  // the machine-readable field partner agents are told to trust.
  const currency = v.product.currency.toUpperCase();
  // Any budget-fit claim on an item that FAILED the comparison is false — strip it rather than forward
  // it to a partner agent that will trust it. This is the bridge's job, not the sanitizer's. watchouts
  // is stripped too: `constraint_notes` is the lane's OWN field for constraint commentary, so it is the
  // likeliest home for "stays under your $40 budget" — the very claim this pass exists to kill.
  v.why = stripBudgetClaims(v.why);
  v.notes = stripBudgetClaims(v.notes);
  const marker = `exceeds price_max ${ceiling.limit} ${ceiling.currency}: price ${price} ${currency}`;
  // The marker leads so the 6-item watchouts cap can never truncate it away.
  v.watchouts = dedupe([marker, ...stripBudgetClaims(v.watchouts)]).slice(0, 6);
  // Only ever a DOWNGRADE: where the lane emitted no score there is no band to assert, and inventing
  // one would be the same fabrication this file's header guards against.
  v.fit = { ...v.fit, level: v.fit.level === null ? null : 'low' };
  v.constraint_violations = [{
    constraint: 'price_max',
    limit: ceiling.limit,
    limit_currency: ceiling.currency,
    price,
    currency,
  }];
  return signal;
}

/**
 * An item whose price could not be compared (no price, no currency, or a different currency) carries an
 * explicit marker so a partner agent can tell "checked and clean" from "could not be checked".
 *
 * Budget-FIT assertions are stripped here too. An unverified claim is not a proven-false one, but the
 * premise of this whole pass is that a partner agent trusts `why[]`: forwarding "fits comfortably within
 * your $40 budget" on an item the bridge has just declared uncheckable relays precisely the assertion it
 * cannot stand behind. Only fit assertions go — every other reason, including subjective price praise
 * and every safety warning, survives untouched.
 */
function markPriceUnverifiable(signal, ceiling) {
  const v = signal.value;
  const product = v.product;
  let detail;
  if (typeof product.price !== 'number') detail = 'no catalog price';
  else if (!nonEmpty(product.currency)) detail = 'price carries no currency';
  else detail = `price in ${product.currency}, ceiling in ${ceiling.currency}`;
  v.why = stripBudgetClaims(v.why);
  v.notes = stripBudgetClaims(v.notes);
  v.watchouts = dedupe([
    `price_max ${ceiling.limit} ${ceiling.currency} not verified: ${detail}`,
    ...stripBudgetClaims(v.watchouts),
  ]).slice(0, 6);
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
  // Real caution content: the per-item warnings the lane emits (its SAFETY field — photosensitivity,
  // patch-testing, interactions) and constraint_notes (why a constraint forced or blocked something).
  // WARNINGS LEAD on purpose: downstream passes prepend up to three bookkeeping lines (ceiling marker,
  // price-update, out-of-stock) against the 6-slot cap, and whatever sits LAST in this array is what
  // eviction takes first. With constraint_notes first, four of them plus the markers pushed every
  // safety warning off the list — the #2036 failure class reached by eviction instead of deletion.
  const watchouts = [...asStringArray(item.warnings, 4), ...asStringArray(item.constraint_notes, 4)];

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
        //
        // UNGROUNDED items carry NO band (live 2026-08-20: an invented "Hydrating Amino Acid Gel
        // Cleanser" rode fit=high above a real catalog item — while the deterministic price gate had
        // capped the REAL item to fit=low, so the model's own score outranked the only thing an agent
        // could actually buy). Fit-to-catalog is unmeasurable for a product that is not in the catalog;
        // an asserted band there is a model claim with no object, the class this file exists to strip.
        level: grounded ? scoreBand(finiteNumber(item.score)) : null,
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
 *   verifyPrice?: ({product_id, merchant_id, product_ref}) => Promise<{price, currency, in_stock?}|null>,
 *     // live PDP/offer lookup for a grounded item (server.js wires get_pdp_v2 over loopback); absent =
 *     // no re-verification, items keep their catalog-snapshot price with no price_verified key at all
 *   logger?: { warn?: Function, info?: Function },
 *   budgetMs?: number,
 *   now?: () => number,
 * }} deps
 */
function makeRecommendProducts(deps = {}) {
  const { generate, buildAsk, isEnabled, logger, verifyPrice } = deps;
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
    const ceiling = extractPriceMax(isPlainObject(p.constraints) ? p.constraints : null);
    const enforcing = ceiling !== null && Number.isFinite(ceiling.limit);
    const projected = [];
    for (const item of items) {
      const s = recommendationItemToSignal(item, {});
      if (s) projected.push(s);
    }
    // GROUNDED BEFORE UNGROUNDED, always. An ungrounded item is the lane's advisory ("look for this
    // kind of product") with no product_id, no price and nothing to open or buy — it may take a
    // leftover slot, but a commerce door must never rank it above a real catalog item (live
    // 2026-08-20: an invented cleanser sat at #1 above the only purchasable result). Lane order is
    // preserved within each group.
    const groundedSignals = projected.filter((s) => s.value.grounding === 'catalog');
    const ungroundedSignals = projected.filter((s) => s.value.grounding !== 'catalog');

    // LIVE PRICE RE-VERIFICATION (grounded items only; there is nothing to verify on an invented
    // product). The lane's price is a catalog-offer snapshot; the injected `verifyPrice` resolves the
    // same PDP/offer lane the public product page renders from, so a stale snapshot is corrected
    // BEFORE the ceiling is enforced — the gate must judge the price the buyer would actually see.
    // Bounded: only items that could reach the shortlist are checked, in parallel, and a failed or
    // slow check degrades to the snapshot price with `price_verified: false` — never an error, never
    // a dropped item. Each signal records the outcome so a partner agent knows what it is holding.
    let verification = null;
    if (typeof verifyPrice === 'function' && groundedSignals.length > 0) {
      // The window is sized to what can actually RETURN: without a ceiling the first `limit` grounded
      // items ARE the shortlist, so nothing beyond them is checked (each check is a loopback invoke —
      // fanning out for items that cannot appear is pure backend load); with a ceiling, re-slotting can
      // pull items from just past the limit, so a small margin rides along. Hard-capped regardless: a
      // limit-10 caller must not turn one tool call into 12 concurrent PDP lookups against a pool this
      // repo has wedged before. Anything returned UNCHECKED is marked `price_verified: false` and
      // counted below — an absent key must never read as "checked and clean".
      const toVerify = groundedSignals.slice(0, Math.min(
        enforcing ? limit + PRICE_VERIFY_EXTRA : limit,
        PRICE_VERIFY_MAX_CHECKS,
      ));
      verification = { checked: toVerify.length, confirmed: 0, updated: 0, unavailable: 0, unchecked: 0 };
      await Promise.all(toVerify.map(async (s) => {
        const product = s.value.product;
        let live = null;
        try {
          live = await Promise.race([
            verifyPrice({ product_id: product.product_id, merchant_id: product.merchant_id, product_ref: product.product_ref }),
            new Promise((resolve) => { const t = setTimeout(() => resolve(null), PRICE_VERIFY_RACE_MS); if (t.unref) t.unref(); }),
          ]);
        } catch { live = null; }
        const livePrice = finiteNumber(isPlainObject(live) ? live.price : null);
        const liveCurrency = isPlainObject(live) ? str(live.currency).toUpperCase() : '';
        // A live answer is trusted only when it is a POSITIVE amount in a KNOWN currency. `price: 0` is a
        // documented broken-offer shape in this catalog (offer_price_missing) — writing it through would
        // flip a $45 violator to "live-verified, within budget" at price 0, the strongest claim this
        // surface can make, on a fabrication. And an unrecognized currency must not launder a hard
        // violation into "unverifiable" — the same allowlist that guards the CEILING side (a caller's
        // `price_max_currency: 'XYZ'` cannot suppress enforcement) guards the live side here.
        if (livePrice === null || livePrice <= 0 || !liveCurrency || !KNOWN_CURRENCIES.has(liveCurrency)) {
          product.price_verified = false;
          verification.unavailable += 1;
          return;
        }
        const changed = product.price !== livePrice || str(product.currency).toUpperCase() !== liveCurrency;
        if (changed) {
          // Said out loud on the item: a partner that cached the snapshot price learns it moved.
          s.value.watchouts = dedupe([
            `price updated by live check: ${product.price ?? 'unknown'} ${product.currency || ''} -> ${livePrice} ${liveCurrency}`.replace(/\s+/g, ' '),
            ...s.value.watchouts,
          ]).slice(0, 6);
          product.price = livePrice;
          product.currency = liveCurrency;
          verification.updated += 1;
        } else {
          verification.confirmed += 1;
        }
        product.price_verified = true;
        if (isPlainObject(live) && live.in_stock === false) {
          s.value.watchouts = dedupe(['live availability check: out of stock', ...s.value.watchouts]).slice(0, 6);
        }
      }));
    }

    let signals;
    let violationsReturned = 0;
    let unverifiedReturned = 0;
    if (!enforcing) {
      signals = [...groundedSignals, ...ungroundedSignals].slice(0, limit);
    } else {
      // Verified-conforming first, then price-unverifiable, then known violations — and only then
      // ungrounded advisories: a slot never goes to an item known to breach the ceiling while one that
      // honours it is waiting, and never to an invented product while any real one (even a flagged
      // near-miss) is waiting.
      const verdicts = new Map(groundedSignals.map((s) => [s, checkPriceMax(s, ceiling)]));
      signals = groundedSignals.filter((s) => verdicts.get(s) === 'ok').slice(0, limit);
      for (const rung of ['unverifiable', 'violation']) {
        for (const s of groundedSignals) {
          if (signals.length >= limit) break;
          if (verdicts.get(s) !== rung) continue;
          if (rung === 'violation') { signals.push(markPriceViolation(s, ceiling)); violationsReturned += 1; }
          else { signals.push(markPriceUnverifiable(s, ceiling)); unverifiedReturned += 1; }
        }
      }
      for (const s of ungroundedSignals) {
        if (signals.length >= limit) break;
        signals.push(markPriceUnverifiable(s, ceiling));
        unverifiedReturned += 1;
      }
    }
    signals.forEach((s, i) => { s.value.rank = i + 1; });
    const ungroundedReturned = signals.filter((s) => s.value.grounding !== 'catalog').length;
    // Coverage honesty: with a ceiling, re-slotting can return a grounded item from beyond the
    // verification window (a conforming item the lane ranked low). It carries `price_verified: false`
    // like any other unchecked price, and `unchecked` counts it — otherwise "checked N, unavailable 0"
    // over a shortlist containing an unexamined #1 reads as full coverage, the exact absence-as-clean
    // misreading this metadata exists to prevent.
    if (verification) {
      for (const s of signals) {
        if (s.value.grounding !== 'catalog') continue;
        if (s.value.product.price_verified === undefined) {
          s.value.product.price_verified = false;
          verification.unchecked += 1;
        }
      }
    }
    const meta = isPlainObject(payload.recommendation_meta) ? payload.recommendation_meta : {};
    const confidence = finiteNumber(payload.confidence);
    // Measured HERE, after verification and slotting: a 2s live-price pass is real wall time the
    // partner waited; stamping the lane's latency alone would understate the call by that much.
    const latencyMs = now() - startedAt;

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
        // How many returned signals are advisory archetypes rather than catalog products — said out
        // loud so "returned: 2" is never read as "2 purchasable products" when one of them cannot be
        // opened or bought.
        ...(ungroundedReturned > 0 ? { ungrounded_returned: ungroundedReturned } : {}),
        // Live-price check tallies (only when a verifier is wired and grounded items existed):
        // checked = confirmed + updated + unavailable; `updated` items carry the corrected price and a
        // watchout naming the move; `unavailable` items keep the snapshot with price_verified: false.
        ...(verification ? { price_verification: verification } : {}),
        // What this pass actually enforced, so a partner agent can tell "all conforming" from "includes
        // flagged near-misses" from "could not be checked" — without rescanning items, and without
        // reading an absent marker as a clean bill of health.
        ...(enforcing ? {
          price_max_enforced: ceiling.limit,
          price_max_currency: ceiling.currency,
          // false = the ceiling's currency was assumed (see DEFAULT_PRICE_MAX_CURRENCY), not declared.
          price_max_currency_declared: ceiling.declared,
          constraint_violations_returned: violationsReturned,
          price_unverified_returned: unverifiedReturned,
          // Nothing in the shortlist could actually be compared (e.g. a ceiling declared in a currency
          // this catalog does not carry). `price_max_enforced: N` + `constraint_violations_returned: 0`
          // otherwise reads as "checked and all clean", which is the exact misreading this key exists
          // to prevent — so say it out loud even though a ceiling WAS present.
          ...(signals.length > 0 && unverifiedReturned === signals.length
            ? { price_constraint_unenforced: 'nothing_verifiable' }
            : {}),
        } : {}),
        // A budget-shaped constraint whose value could not be read as a ceiling: that constraint was not
        // enforced — including when a DIFFERENT, structured ceiling WAS (`{price_max: 40, budget: "under
        // $30"}` must not read as "enforced at 40, all clean" when the buyer asked for 30). Said out loud
        // so absence is never read as "checked and clean". Order matters: this spread sits after the
        // enforcing block, so in the corner where both fire (enforced ceiling, nothing verifiable, plus an
        // unreadable second constraint) the key reports the unread constraint — either value already means
        // "do not treat this shortlist as fully price-checked".
        ...(ceiling !== null && ceiling.unstructured ? { price_constraint_unenforced: ceiling.unstructured } : {}),
        ...(signals.length === 0 && items.length > 0 ? { dropped_unidentified_items: items.length } : {}),
      },
    };
  };
}

module.exports = { makeRecommendProducts, recommendationItemToSignal, normalizeConstraints, agentLaneUid, extractPriceMax };
