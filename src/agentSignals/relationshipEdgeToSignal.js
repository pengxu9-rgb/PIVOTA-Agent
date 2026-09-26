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

function priceRatioOf(edge) {
  const pe = edge && edge.price_evidence;
  if (!pe || typeof pe !== 'object') return null;
  const r = pe.price_ratio != null ? Number(pe.price_ratio) : null;
  return Number.isFinite(r) ? r : null;
}

// Map ONE edge → ONE Signal. Returns null for an unusable edge (caller filters nulls out).
function relationshipEdgeToSignal(edge, { anchorId = null } = {}) {
  if (!edge || typeof edge !== 'object') return null;
  const relation = edge.relation_type;
  const signalType = RELATION_TO_SIGNAL_TYPE[relation] || 'alternative';
  const snapshot = edge.candidate_snapshot && typeof edge.candidate_snapshot === 'object' ? edge.candidate_snapshot : {};
  const score = typeof edge.score_total === 'number' ? edge.score_total : null;
  return {
    signal_type: signalType,
    subject: { kind: 'product', id: anchorId || edge.anchor_ref || null },
    value: {
      related: {
        ref: edge.candidate_product_ref || null,
        title: snapshot.title || null,
        brand: snapshot.brand || null,
        // COERCED, not passed through: the snapshot is a raw DB row spread and node-pg returns NUMERIC
        // as a string, which would break the published `number|null` contract (offerToSignal already
        // coerces for the same reason).
        price: Number.isFinite(Number(snapshot.price)) && snapshot.price !== null && snapshot.price !== ''
          ? Number(snapshot.price)
          : null,
        // Same raw-spread reason as price: the snapshot's currency key varies by producer (`currency` in
        // products_cache payloads, `price_currency` in seed/PDP payloads), so a one-key read here is how a
        // stored amount sheds its currency on the agent surface.
        currency: snapshot.currency || snapshot.price_currency || snapshot.priceCurrency || null,
        image_url: snapshot.image_url || null,
      },
      relation,
      score,
      // The cross-product price comparison (price_ratio etc.). Named distinctly from value.related.price
      // (the candidate's own numeric price) to avoid two same-named fields of different shape on one Signal.
      price_comparison: edge.price_evidence || null,
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
    const signal = relationshipEdgeToSignal(edge, { anchorId });
    if (signal) out.push(signal);
  }
  out.sort((a, b) => (b.value.score || 0) - (a.value.score || 0));
  const cap = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 50));
  return out.slice(0, cap);
}

module.exports = { relationshipEdgeToSignal, relationshipEdgesToSignals, RELATION_TO_SIGNAL_TYPE };
