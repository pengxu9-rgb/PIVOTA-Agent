'use strict';
const { z } = require('zod');
const { digest } = require('./relationshipCrossAgentReview');
const clone = value => JSON.parse(JSON.stringify(value));
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const AUDIT_KINDS = ['dupe', 'alternative', 'substitute', 'complement', 'variant', 'none', 'unknown'];
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; }
const FACT_FIELDS = ['title', 'brand', 'category', 'category_taxonomy', 'tags', 'price', 'price_currency', 'description',
  'ingredient_text', 'ingredient_text_truncated', 'ingredient_evidence_conflict', 'ingredient_evidence_incomplete',
  'product_intel_evidence_incomplete', 'routine_fit', 'best_for', 'watchouts', 'why_it_stands_out',
  'evidence_profile', 'confidence_tier', 'source_coverage', 'intel_review', 'freshness'];
function blindProduct(product) {
  const out = Object.fromEntries(FACT_FIELDS.filter(key => product[key] !== undefined).map(key => [key, clone(product[key])]));
  out.ingredient_evidence = (product.ingredient_evidence || []).map(row => Object.fromEntries(
    ['ingredient_text', 'ingredient_text_truncated', 'observed_at', 'review_status', 'audit_status'].filter(key => row[key] !== undefined).map(key => [key, row[key]])));
  for (const key of ['market_signal_badges', 'external_highlight_signals']) out[key] = (product[key] || []).map(signal => Object.fromEntries(
    ['claim_text', 'source_type', 'claim_type', 'evidence_strength', 'sponsorship_status', 'independence_count', 'confidence', 'review_status', 'sponsored', 'freshness']
      .filter(field => signal[field] !== undefined).map(field => [field, signal[field]])));
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/score|relation|recommendation|curated|provenance|(?:^|_)pair(?:_|$)|(?:^|_)(?:ref|id|url)(?:_|$)/i.test(key))
      .map(([key, item]) => [key, scrub(item)]));
    return value;
  };
  return scrub(out);
}
function blindedFacts(evidence, row) {
  const aOffer = row.anchor_snapshot?._evaluation_offer_evidence || {};
  const bOffer = row.candidate_snapshot?._evaluation_offer_evidence || {};
  return deepFreeze({ market: evidence.market, frozen_at: row.provenance?.generated_at || null,
    product_a: { ...blindProduct(evidence.anchor), market: row.anchor_snapshot?.market || row.anchor_snapshot?.recall_market || null },
    product_b: { ...blindProduct(evidence.candidate), market: row.candidate_snapshot?.market || row.candidate_snapshot?.recall_market || null },
    // Builder dates can be generated defaults: disclose origin, never synthesize an observed offer.
    price_observation: { product_a_observed_at: row.anchor_snapshot?.price_observed_at || null,
      product_b_observed_at: row.candidate_snapshot?.price_observed_at || row.candidate_snapshot?.observed_at || null,
      product_a_origin_last_crawled_at: aOffer.origin_last_crawled_at || null,
      product_b_origin_last_crawled_at: bOffer.origin_last_crawled_at || null,
      verified_fresh_offer: aOffer.verified_fresh_offer === true && bOffer.verified_fresh_offer === true } });
}
function auditSchema(z) {
  return z.object({ assessment: z.enum(['useful', 'incorrect', 'uncertain']), expected_kind: z.enum(AUDIT_KINDS),
    confidence: z.number().min(0).max(1), rationale: z.string().min(1).max(1000),
    shared_evidence: z.array(z.object({ product_a_fact: z.string().min(1).max(350), product_b_fact: z.string().min(1).max(350) })).max(6) }).strict();
}
function grounded(product, quote) {
  const needle = norm(quote); if (needle.length < 8 || needle === norm(product.brand) || needle === norm(product.category)) return false;
  const values = [];
  const collect = value => { if (typeof value === 'string') values.push(norm(value)); else if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === 'object') Object.values(value).forEach(collect); };
  // Factual claims only: review statuses, confidence labels and identity alone cannot support usefulness.
  collect({ description: product.description, ingredient_text: product.ingredient_text, ingredient_evidence: (product.ingredient_evidence || []).map(row => row.ingredient_text),
    routine_fit: product.routine_fit, best_for: product.best_for, watchouts: product.watchouts, why_it_stands_out: product.why_it_stands_out });
  return values.some(value => value.includes(needle));
}
const AUDIT_INVALID_REASONS = new Set(['missing_grounded_quotes', 'unsupported_grounded_quotes', 'missing_dupe_material']);
function invalidAudit(reason) { const err = new Error('EVAL_AUDIT_INVALID'); err.code = 'EVAL_AUDIT_INVALID'; err.audit_invalid_reason = reason; throw err; }
function validateAudit(review, facts) {
  if (review.assessment === 'useful' && !review.shared_evidence.length) invalidAudit('missing_grounded_quotes');
  if (review.assessment === 'useful' && !review.shared_evidence.every(pair =>
    grounded(facts.product_a, pair.product_a_fact) && grounded(facts.product_b, pair.product_b_fact))) invalidAudit('unsupported_grounded_quotes');
  if (review.assessment === 'useful' && review.expected_kind === 'dupe' && !dupeMaterialEvidence(facts)) invalidAudit('missing_dupe_material');
  return review;
}
function dupeMaterialEvidence(facts) {
  const a = facts.product_a; const b = facts.product_b;
  const frozenAt = new Date(facts.frozen_at || '').getTime();
  const observationDates = [facts.price_observation?.product_a_observed_at, facts.price_observation?.product_b_observed_at,
    facts.price_observation?.product_a_origin_last_crawled_at, facts.price_observation?.product_b_origin_last_crawled_at];
  return facts.price_observation?.verified_fresh_offer === true && !!a.price_currency && a.price_currency === b.price_currency &&
    a.market === facts.market && b.market === facts.market && Number.isFinite(frozenAt) &&
    observationDates.every(value => { const at = new Date(value || '').getTime(); return Number.isFinite(at) && at <= frozenAt; }) &&
    Number.isFinite(a.price) && Number.isFinite(b.price) && a.price > 0 && b.price > 0 && b.price < a.price &&
    [a, b].every(product => product.ingredient_text && !product.ingredient_evidence_conflict && !product.ingredient_evidence_incomplete && !product.ingredient_text_truncated);
}
function normalizedKind(kind) { return kind === 'substitute' ? 'alternative' : kind; }
function adjudicateAudit(pair, reviews) {
  if (!reviews || reviews.length !== 2 || !reviews[0] || !reviews[1] || reviews.some(review => review.error)) return { assessment: 'unreviewed', expected_kind: 'unknown' };
  const a = reviews[0].decision; const b = reviews[1].decision;
  if (a.confidence < 0.9 || b.confidence < 0.9 || a.assessment === 'uncertain' || b.assessment === 'uncertain' ||
      a.assessment !== b.assessment || normalizedKind(a.expected_kind) !== normalizedKind(b.expected_kind)) return { assessment: 'uncertain', expected_kind: 'unknown' };
  const kind = normalizedKind(a.expected_kind);
  const lane = pair.row.relation_type === 'dupe' ? 'dupe' : 'alternative';
  return { assessment: a.assessment === 'useful' && kind === lane ? 'useful' : 'incorrect', expected_kind: kind };
}

module.exports = { blindedFacts, auditSchema: () => auditSchema(z), validateAudit, dupeMaterialEvidence, grounded, normalizedKind, adjudicateAudit, factsFingerprint: digest };
