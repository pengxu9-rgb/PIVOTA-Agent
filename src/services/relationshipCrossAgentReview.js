'use strict';

const crypto = require('node:crypto');

const CONSENSUS_SCHEMA = 'relgraph.cross_agent_review.v1';
const CONSENSUS_MIN_CONFIDENCE = 0.90;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// Callers supply coerceRelationshipEdge's normalized representation. Approval copy,
// freshness and row timestamps change on apply/renewal; source facts must not change.
function evidenceFingerprint(edge) {
  const fields = ['anchor_type', 'anchor_ref', 'anchor_snapshot', 'candidate_product_ref',
    'candidate_snapshot', 'relation_type', 'market', 'vertical', 'category_taxonomy',
    'use_case', 'score_total', 'score_breakdown', 'price_evidence', 'source_refs', 'evidence_grade'];
  const material = Object.fromEntries(fields.map((key) => [key, edge[key] ?? null]));
  material.curated_pair_evidence = edge.provenance?.curated_pair_evidence ?? null;
  return digest(material);
}

function validReviewerIdentity(review, provider) {
  const prefix = provider === 'openai' ? /^gpt-/ : /^(?:models\/)?gemini-/;
  return review?.provider === provider && prefix.test(review.model || '');
}

function combineReviews(edge, reviews, confidenceFloor = CONSENSUS_MIN_CONFIDENCE) {
  const floor = Math.max(CONSENSUS_MIN_CONFIDENCE, Number.isFinite(confidenceFloor) ? confidenceFloor : CONSENSUS_MIN_CONFIDENCE);
  const byProvider = new Map(reviews.map((review) => [review?.provider, review]));
  const gpt = byProvider.get('openai'); const gemini = byProvider.get('gemini');
  let reason = '';
  if (reviews.length !== 2 || !validReviewerIdentity(gpt, 'openai') || !validReviewerIdentity(gemini, 'gemini')) reason = 'reviewer_identity_invalid';
  else if (reviews.some((review) => review.error)) reason = 'reviewer_failed';
  else if (reviews.some((review) => review.validation_error)) reason = 'review_evidence_invalid';
  else if (reviews.some((review) => !Number.isFinite(review.decision?.confidence) || review.decision.confidence < floor)) reason = 'reviewer_uncertain';
  else if (reviews.some((review) => !['approve', 'reject'].includes(review.decision?.verdict))) reason = 'reviewer_uncertain';
  else if (reviews.some((review) => review.decision.verdict === 'approve' &&
      !['dupe', 'substitute', 'alternative', 'complement'].includes(review.decision.relationship_kind))) reason = 'relationship_kind_invalid';
  else if (gpt.decision.verdict !== gemini.decision.verdict) reason = 'verdict_disagreement';
  else if (gpt.decision.verdict === 'approve' && gpt.decision.relationship_kind !== gemini.decision.relationship_kind) reason = 'relationship_kind_disagreement';
  const verdict = reason ? 'human_review' : gpt.decision.verdict;
  const confidence = reason ? 0 : Math.min(gpt.decision.confidence, gemini.decision.confidence);
  const proof = {
    schema: CONSENSUS_SCHEMA, evidence_fingerprint: evidenceFingerprint(edge),
    verdict, relationship_kind: reason || gpt.decision.relationship_kind !== gemini.decision.relationship_kind ? null : gpt.decision.relationship_kind,
    confidence_floor: floor, reviews, escalation_reason: reason || null,
  };
  proof.review_fingerprint = digest(proof);
  const failure = reviews.find((review) => ['LLM_TIMEOUT', 'LLM_REQUEST_FAILED'].includes(review?.error?.code)) || reviews.find((review) => review?.error);
  return {
    ...(reason ? {} : gpt.decision), verdict, confidence, relationship_kind: proof.relationship_kind,
    rationale: reason ? `Cross-agent review requires human review: ${reason}.` : `GPT and Gemini agree: ${gpt.decision.rationale}`.slice(0, 700),
    cross_agent_review: proof,
    ...(failure ? { review_error: { code: failure.error.code, message: 'Independent reviewer failed.' } } : {}),
  };
}

function hasValidConsensusApproval(edge, proof = edge.provenance?.ai_review?.cross_agent_review) {
  if (!proof || proof.schema !== CONSENSUS_SCHEMA || proof.verdict !== 'approve' ||
      proof.evidence_fingerprint !== evidenceFingerprint(edge)) return false;
  const { review_fingerprint: fingerprint, ...payload } = proof;
  if (fingerprint !== digest(payload) || !Array.isArray(proof.reviews)) return false;
  const recombined = combineReviews(edge, proof.reviews, proof.confidence_floor);
  return recombined.verdict === 'approve' && recombined.cross_agent_review.review_fingerprint === fingerprint;
}

module.exports = { CONSENSUS_SCHEMA, CONSENSUS_MIN_CONFIDENCE, digest, evidenceFingerprint,
  combineReviews, hasValidConsensusApproval, validReviewerIdentity };
