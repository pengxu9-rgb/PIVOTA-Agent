'use strict';

const { digest, CONSENSUS_SCHEMA, combineReviews, evidenceFingerprint, validReviewerIdentity } = require('./relationshipCrossAgentReview');
const OUTCOMES = new Set(['approve', 'reject', 'uncertain', 'human_review', 'error']);
const KINDS = new Set(['dupe', 'alternative', 'substitute', 'complement', 'variant', 'none', 'unknown']);
const normalizedKind = kind => kind === 'substitute' ? 'alternative' : kind;
const ratio = (part, total) => total ? Number((part / total).toFixed(6)) : null;

function validateDataset(dataset) {
  if (dataset?.schema_version !== 'relgraph.recommendation_benchmark.v1' ||
      dataset.origin !== 'synthetic_curated' || !Array.isArray(dataset.cases) || !dataset.cases.length) {
    throw new Error('Expected a nonempty synthetic curated relationship benchmark');
  }
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!/^rgq\d{3}$/.test(item.id || '') || ids.has(item.id) || !item.stratum || !item.anchor || !item.candidate ||
        !['approve', 'reject', 'uncertain'].includes(item.expected?.verdict) ||
        !KINDS.has(item.expected?.relationship_kind) || !item.expected.basis ||
        (item.expected.verdict === 'approve' && !['dupe', 'alternative', 'complement'].includes(item.expected.relationship_kind))) {
      throw new Error('Invalid or duplicate benchmark case');
    }
    ids.add(item.id);
  }
  return dataset;
}

function buildCaseRow(item, evaluatedAt) {
  const now = new Date(evaluatedAt);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid benchmark clock');
  const snapshot = (product, side) => ({
    product_id: `${item.id}_${side}`, product_ref: `product:${item.id}_${side}`,
    name: product.title, price: 50, price_currency: 'USD', ...product,
  });
  const a = snapshot(item.anchor, 'a'); const b = snapshot(item.candidate, 'b');
  const observed = new Date(now.getTime() + (item.price_age_days == null ? 0 : -item.price_age_days) * 86400000).toISOString();
  return {
    id: item.id, anchor_type: 'product', anchor_ref: a.product_ref, candidate_product_ref: b.product_ref,
    anchor_snapshot: a, candidate_snapshot: b, relation_type: item.proposed_relation,
    market: 'US', vertical: 'beauty', label_state: 'generated',
    category_taxonomy: [a.category], use_case: item.use_case || a.category,
    score_total: 0.9, score_breakdown: { category_use_case_match: 0.9 },
    price_evidence: { anchor_price_amount: a.price, candidate_price_amount: b.price,
      anchor_price_currency: a.price_currency, candidate_price_currency: b.price_currency,
      price_ratio: a.price > 0 && a.price_currency === b.price_currency ? b.price / a.price : null, observed_at: observed },
    source_refs: [{ type: 'official_pdp', authoritative: true, name: 'Synthetic benchmark product facts' }], evidence_grade: 'B',
    provenance: item.curated_pair ? { curated_pair_evidence: {
      verified: true, relation_type: 'dupe', anchor_ref: a.product_ref,
      candidate_ref: item.curated_pair === 'wrong_pair' ? 'product:unrelated' : b.product_ref,
    } } : {},
  };
}

function caseFingerprint(item, evaluatedAt) { return digest(buildCaseRow(item, evaluatedAt)); }
function datasetFingerprint(dataset) { validateDataset(dataset); return digest(dataset); }
function validateLiveDecision(item, artifact, result) {
  const { coerceRelationshipEdge } = require('../auroraBff/productRelationshipGraph');
  const { servingGuardReasonsIfApproved, VerdictSchema, validateConsensusDecision, buildEvidence } = require('../../scripts/review-relationship-candidate-labels');
  const row = buildCaseRow(item, artifact.evaluated_at);
  if (result.guard_reasons != null) {
    const actual = servingGuardReasonsIfApproved(row, { allowDupeAiApproval: true });
    if (result.verdict !== 'reject' || result.cross_agent_review || !actual.length || digest(actual) !== digest(result.guard_reasons)) {
      throw new Error('Invalid benchmark guard rejection');
    }
    return;
  }
  const proof = result.cross_agent_review;
  const edge = coerceRelationshipEdge(row);
  if (!proof || proof.schema !== CONSENSUS_SCHEMA || !Array.isArray(proof.reviews) || proof.reviews.length !== 2 ||
      proof.evidence_fingerprint !== evidenceFingerprint(edge)) throw new Error('Invalid benchmark consensus proof');
  for (const reviewer of artifact.reviewers) {
    const review = proof.reviews.find(value => value.provider === reviewer.provider);
    if (!review || review.model !== reviewer.model) throw new Error('Benchmark reviewer identity mismatch');
    if (review.decision) {
      VerdictSchema.parse(review.decision);
      const validationError = validateConsensusDecision(row, review.decision, buildEvidence(row, new Map()));
      if ((review.validation_error || null) !== validationError) throw new Error('Invalid benchmark approval evidence or validation result');
    } else if (!review.error) throw new Error('Missing benchmark reviewer outcome');
  }
  const { review_fingerprint: fingerprint, ...payload } = proof;
  const recombined = combineReviews(edge, proof.reviews, proof.confidence_floor);
  if (fingerprint !== digest(payload) || fingerprint !== recombined.cross_agent_review.review_fingerprint ||
      result.verdict !== recombined.verdict || result.relationship_kind !== recombined.relationship_kind ||
      result.confidence !== recombined.confidence || digest(result.review_error || null) !== digest(recombined.review_error || null)) {
    throw new Error('Invalid or inconsistent benchmark consensus outcome');
  }
}
function emptyBucket() { return { cases: 0, reviewed: 0, expected_useful: 0, approvals: 0, correct_approvals: 0,
  incorrect_approvals: 0, unsupported_approvals: 0, rejections: 0, abstentions: 0, errors: 0 }; }
function finishBucket(bucket) {
  return { ...bucket, reviewed_coverage: ratio(bucket.reviewed, bucket.cases),
    adjudicated_approval_count: bucket.correct_approvals + bucket.incorrect_approvals,
    approval_adjudication_coverage: ratio(bucket.correct_approvals + bucket.incorrect_approvals, bucket.approvals),
    observed_approval_precision: ratio(bucket.correct_approvals, bucket.correct_approvals + bucket.incorrect_approvals),
    useful_recommendation_recall: bucket.reviewed ? ratio(bucket.correct_approvals, bucket.expected_useful) : null };
}

// Score final reviewer outcomes against separately authored case labels. A guard's
// answer, two-model agreement, or confidence never becomes the reference label.
function evaluateBenchmark(dataset, artifact = null, { minimumPrecision = 0.95, minimumRecall = 0.8 } = {}) {
  validateDataset(dataset);
  for (const value of [minimumPrecision, minimumRecall]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Gate thresholds must be in [0,1]');
  }
  if (artifact && (artifact.schema_version !== 'relgraph.benchmark_decisions.v1' ||
      artifact.dataset_fingerprint !== datasetFingerprint(dataset) || !Array.isArray(artifact.decisions) ||
      !['imported_review', 'synthetic_mock', 'live_consensus'].includes(artifact.mode))) {
    throw new Error('Review artifact does not match this benchmark');
  }
  if (artifact?.mode === 'live_consensus' && (!Array.isArray(artifact.reviewers) || artifact.reviewers.length !== 2 ||
      !validReviewerIdentity(artifact.reviewers[0], 'openai') || !validReviewerIdentity(artifact.reviewers[1], 'gemini'))) {
    throw new Error('Live benchmark requires pinned GPT and Gemini reviewer identities');
  }
  const byId = new Map(); const casesById = new Map(dataset.cases.map(item => [item.id, item]));
  for (const result of artifact?.decisions || []) {
    const item = casesById.get(result.case_id);
    if (!item || byId.has(result.case_id) || !OUTCOMES.has(result.verdict) ||
        result.case_fingerprint !== caseFingerprint(item, artifact.evaluated_at) ||
        (result.verdict === 'approve' && !['dupe', 'alternative', 'substitute', 'complement'].includes(result.relationship_kind))) {
      throw new Error('Unexpected, duplicate, stale or invalid benchmark decision');
    }
    if (artifact.mode === 'live_consensus') validateLiveDecision(item, artifact, result);
    byId.set(result.case_id, result);
  }
  const overall = emptyBucket(); const byStratum = {}; const byExpectedKind = {};
  const byApprovedKind = {}; const confusion = {}; let variantApprovals = 0; let wrongDupeApprovals = 0;
  const bump = (bucket, item, result) => {
    bucket.cases++; if (item.expected.verdict === 'approve') bucket.expected_useful++;
    if (!result) return;
    bucket.reviewed++;
    if (result.verdict !== 'error' && (result.review_error || result.cross_agent_review?.reviews?.some(review => review.error))) bucket.errors++;
    if (result.verdict === 'approve') {
      bucket.approvals++;
      if (item.expected.verdict === 'uncertain') bucket.unsupported_approvals++;
      else if (item.expected.verdict === 'approve' && normalizedKind(result.relationship_kind) === item.expected.relationship_kind) bucket.correct_approvals++;
      else bucket.incorrect_approvals++;
    } else if (result.verdict === 'reject') bucket.rejections++;
    else if (result.verdict === 'error') bucket.errors++;
    else bucket.abstentions++;
  };
  for (const item of dataset.cases) {
    const result = byId.get(item.id); const expectedKind = item.expected.relationship_kind;
    const stratum = byStratum[item.stratum] ||= emptyBucket(); const expected = byExpectedKind[expectedKind] ||= emptyBucket();
    [overall, stratum, expected].forEach(bucket => bump(bucket, item, result));
    const outcome = !result ? 'unreviewed' : result.verdict === 'approve' ? normalizedKind(result.relationship_kind) : result.verdict;
    confusion[expectedKind] ||= {}; confusion[expectedKind][outcome] = (confusion[expectedKind][outcome] || 0) + 1;
    if (result?.verdict === 'approve') {
      const kind = normalizedKind(result.relationship_kind); const approved = byApprovedKind[kind] ||= emptyBucket();
      bump(approved, item, result);
      if (expectedKind === 'variant') variantApprovals++;
      if (kind === 'dupe' && (item.expected.verdict !== 'approve' || expectedKind !== 'dupe')) wrongDupeApprovals++;
    }
  }
  const metrics = finishBucket(overall); const failures = [];
  if (metrics.reviewed !== metrics.cases) failures.push('review_incomplete');
  if (artifact?.mode === 'synthetic_mock') failures.push('mock_reviews_do_not_qualify_for_release');
  if (metrics.errors) failures.push('review_errors');
  if (metrics.unsupported_approvals) failures.push('approvals_on_unresolved_evidence');
  if (variantApprovals) failures.push('variants_approved');
  if (wrongDupeApprovals) failures.push('incorrect_dupe_claims');
  for (const kind of ['dupe', 'alternative', 'complement']) {
    const expected = finishBucket(byExpectedKind[kind] || emptyBucket());
    const approved = finishBucket(byApprovedKind[kind] || emptyBucket());
    if (!expected.expected_useful) failures.push(`${kind}_reference_cases_missing`);
    if (approved.observed_approval_precision == null || approved.observed_approval_precision < minimumPrecision) failures.push(`${kind}_precision_below_threshold`);
    if (expected.useful_recommendation_recall == null || expected.useful_recommendation_recall < minimumRecall) failures.push(`${kind}_recall_below_threshold`);
  }
  return {
    schema_version: 'relgraph.benchmark_evaluation.v1', dataset_fingerprint: datasetFingerprint(dataset),
    reference_origin: dataset.origin, reference_labeling: 'curated_synthetic_cases_not_model_or_guard_labels',
    review_mode: artifact?.mode || 'not_run', evaluated_at: artifact?.evaluated_at || null,
    overall: metrics, by_stratum: Object.fromEntries(Object.entries(byStratum).map(([key, value]) => [key, finishBucket(value)])),
    by_expected_kind: Object.fromEntries(Object.entries(byExpectedKind).map(([key, value]) => [key, finishBucket(value)])),
    by_approved_kind: Object.fromEntries(Object.entries(byApprovedKind).map(([key, value]) => [key, finishBucket(value)])),
    confusion, variant_approval_count: variantApprovals, incorrect_dupe_approval_count: wrongDupeApprovals,
    gate: { passed: failures.length === 0, minimum_precision_by_kind: minimumPrecision,
      minimum_recall_by_kind: minimumRecall, failures },
    production_precision: null,
    limits: ['Synthetic cases test reviewer behavior; they do not measure production-wide accuracy or product coverage.',
      'Confidence and GPT/Gemini agreement are not reference labels.',
      'No production DB access, graph approval, evidence export or page refresh is performed.'],
  };
}

module.exports = { validateDataset, buildCaseRow, datasetFingerprint, caseFingerprint, evaluateBenchmark };
