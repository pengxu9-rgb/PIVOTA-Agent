// Response slimming for the PUBLIC (auth:none) read MCP tier (docs/openai_apps_v1_plan.md §3).
//
// The internal invoke/commerce responses are verbose by design (assistant text, decision diagnostics, ~44
// internal fields per product, envelope metadata with timestamps). The OpenAI Apps SDK review bar forbids
// returning diagnostics, telemetry, internal identifiers, or timestamps, and expects "only data directly
// relevant to the request." This module projects each read tool's raw result down to a small, stable,
// allowlisted shape — it is applied ONLY at the public surface; the commerce /mcp door and every internal
// contract are untouched.
//
// Design: ALLOWLIST, not denylist. Each projector builds its output from a fixed set of named fields, so any
// field not explicitly mapped is dropped — a new internal field added upstream can never leak here. The
// contract tests additionally assert (defense-in-depth) that no denylisted field name and no ISO-timestamp
// value survives.

// Public canonical PDP base (the citable URL host). Overridable so a future domain move needs no code change.
const DEFAULT_PDP_BASE = 'https://agent.pivota.cc';

// Output caps. The raw search path ignores the requested limit and can return 50 items × ~44 fields (~678KB
// measured). We cap hard here regardless of upstream.
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_SEARCH_RESULTS = 10;
const MAX_ALTERNATIVES = 10;
const MAX_ACTIVES = 5;
const MAX_IMAGES = 3;
const MAX_LIST_ITEMS = 6; // tradeoffs / watchouts / why / best_for / claims list caps
const MAX_CLAIMS = 6;
const MAX_CITATIONS = 3;
const DESCRIPTION_MAX = 600;
const TEXT_MAX = 400;

// Per-response byte budget (docs §3: ≤ ~25KB). Enforced by the contract tests; exported for reuse.
const MAX_RESPONSE_BYTES = 25 * 1024;

// Internal field names that must NEVER appear in a public response. The allowlist projectors already exclude
// them; this list is the shared source of truth for the defense-in-depth contract test.
const DENYLIST_FIELDS = Object.freeze([
  'assistant_message', 'assistant_text', 'reply', 'beauty_expert_v1', 'metadata',
  'external_seed_id', 'catalog_product_key', 'catalog_source', 'catalog_track',
  'search_recall_source', 'readiness_tier', 'truth_tier', 'pdp_scope', 'pdp_open',
  'pdp_field_quality_summary', 'pdp_ingredients_raw', 'raw_ingredient_text_clean',
  'source_product_id', 'platform_product_id', 'product_key', 'canonical_product_ref',
  'merchant_id', 'merchant_name', 'merchant_canonical_url', 'platform', 'vendor', 'source',
  'ingredient_intel', 'buyable', 'destination_url', 'review_state', 'visibility',
  'signals', 'subject', 'freshness', 'kb_key', 'score_total', 'candidate_snapshot',
]);

// ---- small pure helpers ----------------------------------------------------------------------------------

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
function clamp(v, n) {
  const s = str(v);
  return s == null ? null : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}
function finiteNum(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function strList(v, cap, maxLen = TEXT_MAX) {
  const out = [];
  for (const item of arr(v)) {
    const s = clamp(item, maxLen);
    if (s) out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}
function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function compact(obj) {
  // Drop null/undefined/empty-array/empty-string keys so the output carries only fields we could fill.
  const out = {};
  for (const [k, val] of Object.entries(obj)) {
    if (val == null) continue;
    if (typeof val === 'string' && val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    if (isObj(val) && Object.keys(val).length === 0) continue;
    out[k] = val;
  }
  return out;
}

// The one public product id: the Pivota signature / canonical id (product_id == sig for catalog rows).
function publicProductId(p) {
  return str(p.pivota_signature_id) || str(p.product_id) || str(p.id) || null;
}
const PIVOTA_HOST_RE = /^https:\/\/[^/]*\bpivota\.(cc|ai|com)\b/i;

function pdpUrl(p, base) {
  // The citable URL must be a PIVOTA-hosted canonical URL. Row URL fields are NOT trustworthy: for reseller/
  // referral rows even `pivota_canonical_url` is the reseller's page (e.g. ulta.com — verified in the live
  // capture). So we CONSTRUCT the canonical PDP from the public sig id, which is host-controlled and valid
  // for any sig-keyed product. Fall back to the row's pivota_canonical_url only if it is already on a Pivota
  // host, and never to `canonical_url`/`destination_url`.
  const id = publicProductId(p);
  if (id) return `${base}/products/${id}`;
  const canonical = str(p.pivota_canonical_url);
  return canonical && PIVOTA_HOST_RE.test(canonical) ? canonical : null;
}
function priceOf(p) {
  const amount = finiteNum(p.price);
  const currency = str(p.currency);
  if (amount == null) return null;
  return compact({ amount, currency });
}
const AVAILABILITY_IN_STOCK = new Set(['in_stock', 'in stock', 'instock', 'available']);
const AVAILABILITY_OUT_OF_STOCK = new Set([
  'out_of_stock', 'out of stock', 'outofstock', 'oos', 'sold out', 'sold_out', 'unavailable', 'discontinued',
]);
function availabilityOf(p) {
  // Prefer the row's availability STRING over the in_stock boolean. The two
  // fields are derived independently upstream and can disagree on the same
  // row: `availability` projects from the offer/recall chain while `in_stock`
  // aggregates per-variant booleans captured at seed-scrape time — verified
  // stale on prod 2026-08-01, where rows with only in-stock offers served
  // `availability: "in_stock", in_stock: false` and surfaced here as
  // out_of_stock. When the string is absent or unrecognized (e.g. "unknown"),
  // the boolean still carries signal, so fall back to it.
  const text = typeof p.availability === 'string' ? p.availability.trim().toLowerCase() : '';
  if (AVAILABILITY_IN_STOCK.has(text)) return 'in_stock';
  if (AVAILABILITY_OUT_OF_STOCK.has(text)) return 'out_of_stock';
  if (p.in_stock === true) return 'in_stock';
  if (p.in_stock === false) return 'out_of_stock';
  return 'unknown';
}
function imagesOf(p) {
  const seen = new Set();
  const out = [];
  const push = (u) => {
    const s = str(u);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  push(p.image_url);
  for (const u of arr(p.images)) push(u);
  for (const u of arr(p.image_urls)) push(u);
  return out.slice(0, MAX_IMAGES);
}
function activesOf(p) {
  const src = arr(p.active_ingredients).length
    ? p.active_ingredients
    : isObj(p.ingredient_intel)
      ? p.ingredient_intel.active_ingredients || p.ingredient_intel.key_ingredients
      : null;
  return strList(src, MAX_ACTIVES, 60);
}
function ingredientsOf(p) {
  const intel = isObj(p.ingredient_intel) ? p.ingredient_intel : {};
  const src = arr(intel.inci_list).length ? intel.inci_list : p.active_ingredients;
  return strList(src, 60, 80);
}

// ---- product summary (search rows + get_product base) ----------------------------------------------------

function productSummary(p, base) {
  if (!isObj(p)) return null;
  // No identifying content at all → not a real product row (drop from search, signals not-found for detail).
  if (!publicProductId(p) && !str(p.title) && !str(p.brand)) return null;
  return compact({
    product_id: publicProductId(p),
    brand: clamp(p.brand, 120),
    title: clamp(p.title, 200),
    category: clamp(p.category || p.product_type, 80),
    price: priceOf(p),
    availability: availabilityOf(p),
    image_url: imagesOf(p)[0] || null,
    key_actives: activesOf(p),
    pivota_url: pdpUrl(p, base),
  });
}

// ---- decision / intel projection -------------------------------------------------------------------------

// The get_intel Signal `value` (why/best_for/evidence_profile) + `evidence` (grade/claims) → a slim decision.
function decisionFrom(value, evidence) {
  const v = isObj(value) ? value : {};
  const e = isObj(evidence) ? evidence : {};
  const why = arr(v.why_it_stands_out)
    .map((w) => (isObj(w) ? clamp(w.headline || w.body, TEXT_MAX) : clamp(w, TEXT_MAX)))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
  const bestFor = arr(v.best_for)
    .map((b) => (isObj(b) ? clamp(b.label || b.tag, 80) : clamp(b, 80)))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
  const claims = claimsFrom(e.claims);
  return compact({
    summary: clamp(v.evidence_profile, TEXT_MAX),
    why,
    best_for: bestFor,
    grade: str(e.grade) ? e.grade.toUpperCase() : null,
    claims,
  });
}

function claimsFrom(raw) {
  const out = [];
  for (const c of arr(raw)) {
    if (!isObj(c)) continue;
    const text = clamp(c.claim_text || c.text, TEXT_MAX);
    if (!text) continue;
    out.push(
      compact({
        text,
        grade: str(c.evidence_grade || c.grade) ? String(c.evidence_grade || c.grade).toUpperCase() : null,
        citations: strList(c.source_refs || c.citations, MAX_CITATIONS, 300),
        concern: clamp(c.concern, 160),
      })
    );
    if (out.length >= MAX_CLAIMS) break;
  }
  return out;
}

// ---- per-tool projectors ---------------------------------------------------------------------------------

function projectSearchCatalog(raw, { base = DEFAULT_PDP_BASE, limit } = {}) {
  const r = isObj(raw) ? raw : {};
  const cap = Math.min(
    MAX_SEARCH_RESULTS,
    Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_SEARCH_RESULTS
  );
  const products = arr(r.products)
    .map((p) => productSummary(p, base))
    .filter(Boolean)
    .slice(0, cap);
  const total = finiteNum(r.total);
  // `products` is always present (even []) for a stable shape; optional scalars are omitted when absent.
  // page_size is the effective REQUESTED page size (the cap applied), not the count on this page — so
  // clients paginating by total/page_size aren't skewed by a short final page. `returned` gives the count.
  return {
    products,
    page: finiteNum(r.page) || 1,
    page_size: cap,
    returned: products.length,
    ...(total != null ? { total } : {}),
    ...(products.length === 0 ? { note: 'No products matched this search.' } : {}),
  };
}

function projectGetProduct(raw, { base = DEFAULT_PDP_BASE } = {}) {
  const r = isObj(raw) ? raw : {};
  const p = isObj(r.product) ? r.product : r;
  const summary = productSummary(p, base);
  if (!summary) return { note: 'Product not found.' };
  const detail = { ...summary };
  const description = clamp(p.description, DESCRIPTION_MAX);
  if (description) detail.description = description;
  const images = imagesOf(p);
  if (images.length) detail.images = images;
  const ingredients = ingredientsOf(p);
  if (ingredients.length) detail.ingredients = ingredients;
  if (isObj(p.decision)) {
    const decision = decisionFrom(p.decision, p.decision.evidence);
    if (Object.keys(decision).length) detail.decision = decision;
  }
  return compact(detail);
}

function projectGetIntel(raw, { base = DEFAULT_PDP_BASE } = {}) {
  const r = isObj(raw) ? raw : {};
  const productId = isObj(r.subject) ? str(r.subject.id) : null;
  const sig = arr(r.signals)[0];
  const pivota_url = productId ? `${base}/products/${productId}` : null;
  const urlPart = pivota_url ? { pivota_url } : {};
  if (!isObj(sig)) {
    // intel:null must be PRESENT (honest "nothing reviewed"), so this shape is not compacted.
    return {
      product_id: productId,
      intel: null,
      note: 'No reviewed intelligence for this product yet.',
      ...urlPart,
    };
  }
  const decision = decisionFrom(sig.value, sig.evidence);
  return {
    product_id: productId,
    intel: compact({ ...decision, reviewed: true }),
    ...urlPart,
  };
}

function projectGetAlternatives(raw, { base = DEFAULT_PDP_BASE } = {}) {
  const r = isObj(raw) ? raw : {};
  const anchorId = isObj(r.subject) ? str(r.subject.id) : null;
  const alternatives = arr(r.signals)
    .map((sig) => {
      if (!isObj(sig)) return null;
      const v = isObj(sig.value) ? sig.value : {};
      const related = isObj(v.related) ? v.related : {};
      const e = isObj(sig.evidence) ? sig.evidence : {};
      const priceAmt = finiteNum(related.price);
      const ratio = isObj(v.price_comparison) ? finiteNum(v.price_comparison.price_ratio) : null;
      const productId = str(related.ref) || null;
      return compact({
        product_id: productId,
        brand: clamp(related.brand, 120),
        title: clamp(related.title, 200),
        relation: str(v.relation),
        price: priceAmt != null ? compact({ amount: priceAmt, currency: str(related.currency) }) : null,
        price_vs_anchor: ratio != null ? formatRatio(ratio) : null,
        why: clamp(v.why, TEXT_MAX),
        tradeoffs: strList(v.tradeoffs, MAX_LIST_ITEMS),
        watchouts: strList(v.watchouts, MAX_LIST_ITEMS),
        grade: str(e.grade) ? e.grade.toUpperCase() : null,
        citations: strList(e.sources, MAX_CITATIONS, 300),
        pivota_url: productId ? `${base}/products/${productId}` : null,
      });
    })
    .filter(Boolean)
    .slice(0, MAX_ALTERNATIVES);
  // `alternatives` is always present (even []) for a stable shape.
  return {
    anchor: compact({ product_id: anchorId }),
    alternatives,
    ...(alternatives.length === 0 ? { note: 'No reviewed alternatives for this product yet.' } : {}),
  };
}

function formatRatio(ratio) {
  // ratio = candidate/anchor. 0.75 → "-25%", 1.2 → "+20%", 1.0 → "same price".
  const pct = Math.round((ratio - 1) * 100);
  if (pct === 0) return 'same price';
  return pct < 0 ? `${pct}%` : `+${pct}%`;
}

const PROJECTORS = Object.freeze({
  search_catalog: projectSearchCatalog,
  get_product: projectGetProduct,
  get_intel: projectGetIntel,
  get_alternatives: projectGetAlternatives,
});

/**
 * Project a public read tool's raw result to its slim public shape.
 * @param {string} toolName one of the four public read tools
 * @param {any} raw the sanitized result from the commerce surface
 * @param {{ base?: string, limit?: number }} [opts]
 * @returns {object} the slim, allowlisted public response
 */
function projectPublicReadResult(toolName, raw, opts = {}) {
  const projector = PROJECTORS[toolName];
  if (!projector) {
    // Unknown tool should never reach here (the surface allowlists first); fail closed to an empty object
    // rather than passing an unprojected (verbose) result through.
    return {};
  }
  return projector(raw, opts);
}

// ---- test-facing helpers (shared source of truth) --------------------------------------------------------

const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Recursively collect any denylisted key names or ISO-timestamp string values present in an object. */
function findLeakedFields(value, denylist = DENYLIST_FIELDS, path = '$') {
  const leaks = [];
  const deny = new Set(denylist);
  const walk = (v, p) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`));
      return;
    }
    if (isObj(v)) {
      for (const [k, val] of Object.entries(v)) {
        if (deny.has(k)) leaks.push(`${p}.${k}`);
        walk(val, `${p}.${k}`);
      }
      return;
    }
    if (typeof v === 'string' && ISO_TIMESTAMP_RE.test(v)) leaks.push(`${p} (timestamp: ${v})`);
  };
  walk(value, path);
  return leaks;
}

export {
  projectPublicReadResult,
  projectSearchCatalog,
  projectGetProduct,
  projectGetIntel,
  projectGetAlternatives,
  findLeakedFields,
  DENYLIST_FIELDS,
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_RESULTS,
};
