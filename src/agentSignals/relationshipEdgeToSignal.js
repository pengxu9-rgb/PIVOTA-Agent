'use strict';

// Pure projection: a relationship-graph edge (a row from the `product_relationship_edges` serving view,
// as returned by listApprovedRelationshipEdgesForAnchor) → the agent-facing Signal envelope described in
// docs/agent-data-exposure-spec.md. No I/O, no app deps — a pure mapper, unit-tested in isolation.
//
// The serving view already applies the quality gates (label_state IN human_approved/ai_approved, fresh,
// non-expired, ai_approved dupes excluded). This module applies the AGENT-surface presentation gates:
// the dupe intent-gate (dupes only when explicitly requested), the evidence-grade floor, the price-ratio
// filter, and the ordering/limit. It never invents data — every Signal field comes straight off the edge.

const RELATION_TO_SIGNAL_TYPE = Object.freeze({
  dupe: 'alternative',
  competitive_alternative: 'alternative',
  niche_specialist: 'alternative',
  related_product: 'related',
});

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function finiteAmount(value) {
  // COERCED, not passed through: snapshots are raw DB row spreads and node-pg returns NUMERIC as a string,
  // which would break the published `number|null` contract (offerToSignal coerces for the same reason).
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The snapshot's currency key varies by producer (`currency` in products_cache payloads, `price_currency`
// in seed/PDP payloads), so a one-key read is how a stored amount sheds its currency. Only an ISO-4217
// alpha code counts: '$' or '' names no currency.
function snapshotCurrency(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const raw = snap.currency || snap.price_currency || snap.priceCurrency;
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

// A price reaches an agent only with its currency, and only in the currency the buyer's market is priced in
// (Pivota's rule: a price must carry its market currency). `servingCurrency` undefined = the caller named
// none (no market check); null = the market has no single currency, so no price is servable at all.
function servablePrice(amount, currency, servingCurrency) {
  if (amount == null || !currency) return null;
  if (servingCurrency !== undefined && currency !== servingCurrency) return null;
  return { amount, currency };
}

// The anchor's amount was taken from the anchor snapshot, so its currency is read from there — never
// borrowed from the candidate.
function priceComparisonCurrencies(edge) {
  return {
    anchor: snapshotCurrency(edge && edge.anchor_snapshot),
    candidate: snapshotCurrency(edge && edge.candidate_snapshot),
  };
}

function priceRatioOf(edge) {
  const pe = edge && edge.price_evidence;
  if (!pe || typeof pe !== 'object') return null;
  // A ratio of two amounts in DIFFERENT currencies compares nothing.
  const cur = priceComparisonCurrencies(edge);
  if (cur.anchor && cur.candidate && cur.anchor !== cur.candidate) return null;
  const r = pe.price_ratio != null ? Number(pe.price_ratio) : null;
  return Number.isFinite(r) ? r : null;
}

// The stored price_evidence carries bare amounts (the builder never wrote a currency). The amounts travel
// only as a pair under ONE currency both sides are known to share and the market serves; otherwise they are
// withheld and the unitless ratio stands alone. Built field by field, never spread: passing the stored
// object through is how bare amounts reached agents.
function buildPriceComparison(edge, servingCurrency) {
  const pe = edge.price_evidence;
  if (!pe || typeof pe !== 'object') return null;
  const cur = priceComparisonCurrencies(edge);
  const anchor = servablePrice(finiteAmount(pe.anchor_price_amount), cur.anchor, servingCurrency);
  const candidate = servablePrice(finiteAmount(pe.candidate_price_amount), cur.candidate, servingCurrency);
  const out = {};
  const ratio = priceRatioOf(edge);
  if (ratio != null) out.price_ratio = ratio;
  if (anchor && candidate && anchor.currency === candidate.currency) {
    out.anchor_price_amount = anchor.amount;
    out.candidate_price_amount = candidate.amount;
    out.currency = candidate.currency;
  }
  if (pe.observed_at) out.observed_at = pe.observed_at;
  return out;
}

// Map ONE edge → ONE Signal. Returns null for an unusable edge (caller filters nulls out).
function relationshipEdgeToSignal(edge, { anchorId = null, servingCurrency } = {}) {
  if (!edge || typeof edge !== 'object') return null;
  const relation = edge.relation_type;
  const signalType = RELATION_TO_SIGNAL_TYPE[relation] || 'alternative';
  const snapshot = edge.candidate_snapshot && typeof edge.candidate_snapshot === 'object' ? edge.candidate_snapshot : {};
  const score = typeof edge.score_total === 'number' ? edge.score_total : null;
  const price = servablePrice(finiteAmount(snapshot.price), snapshotCurrency(snapshot), servingCurrency);
  return {
    signal_type: signalType,
    subject: { kind: 'product', id: anchorId || edge.anchor_ref || null },
    value: {
      related: {
        ref: edge.candidate_product_ref || null,
        title: snapshot.title || snapshot.name || null,
        brand: snapshot.brand || null,
        // Amount and currency travel together or not at all: a bare amount invites the reader to assume
        // the anchor's (or the market's) currency, which fabricates a price when they differ.
        price: price ? price.amount : null,
        currency: price ? price.currency : null,
        image_url: snapshot.image_url || null,
      },
      relation,
      relationship_kind: edge.why_candidate?.relationship_kind || null,
      score,
      // The cross-product price comparison (price_ratio etc.). Named distinctly from value.related.price
      // (the candidate's own numeric price) to avoid two same-named fields of different shape on one Signal.
      price_comparison: buildPriceComparison(edge, servingCurrency),
      tradeoffs: Array.isArray(edge.tradeoffs) ? edge.tradeoffs : [],
      watchouts: Array.isArray(edge.watchouts) ? edge.watchouts : [],
      why: edge.why_candidate || null,
    },
    label: nonEmptyString(edge.display_label) ? edge.display_label : null,
    evidence: {
      grade: edge.evidence_grade || null,
      // Intentionally NOT the similarity score: per the data-exposure spec, confidence must never be a
      // laundered similarity score. The similarity lives in value.score; the edge carries no separate
      // evidence-confidence today, so this stays null until a real one exists.
      confidence: null,
      method: 'crawled',
      sources: Array.isArray(edge.source_refs) ? edge.source_refs : [],
    },
    freshness: {
      observed_at: edge.last_verified_at || null,
      fresh_until: edge.expires_at || null,
    },
    review_state: edge.label_state || null,
    visibility: 'buyer_safe',
  };
}

// Map many edges → Signals, applying agent-surface gates: dupe intent-gate, evidence-grade floor,
// price-ratio filter, score-desc ordering, limit.
function relationshipEdgesToSignals(edges, opts = {}) {
  const {
    anchorId = null,
    maxPriceRatio = null,
    includeDupes = false,
    dropGrades = ['D'],
    limit = 20,
    servingCurrency,
  } = opts;
  if (!Array.isArray(edges)) return [];
  const out = [];
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') continue;
    // dupe intent gate: a dupe is surfaced to an agent ONLY when explicitly requested.
    if (edge.relation_type === 'dupe' && !includeDupes) continue;
    // evidence-grade floor: never surface the weakest grade as a confident recommendation.
    if (edge.evidence_grade && dropGrades.includes(edge.evidence_grade)) continue;
    // price-ratio filter (e.g. max_price_ratio = 1.0 → only equal-or-cheaper).
    if (maxPriceRatio != null) {
      const ratio = priceRatioOf(edge);
      if (ratio != null && ratio > maxPriceRatio) continue;
    }
    const signal = relationshipEdgeToSignal(edge, { anchorId, servingCurrency });
    if (signal) out.push(signal);
  }
  out.sort((a, b) => (b.value.score || 0) - (a.value.score || 0));
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 50));
  return out.slice(0, cap);
}

module.exports = { relationshipEdgeToSignal, relationshipEdgesToSignals, RELATION_TO_SIGNAL_TYPE };
