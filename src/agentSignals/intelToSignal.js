'use strict';

// Pure projection: an aurora_product_intel_kb entry (contract `pivota.product_intel.v1`) → the decision
// Signal envelope from docs/agent-data-exposure-spec.md. No I/O, no app deps — unit-tested in isolation,
// mirroring offerToSignal / relationshipEdgeToSignal.
//
// This surfaces the "why / fit / evidence" substrate that today is chat-only. We never fabricate: an entry
// with no usable intel (or a review_decision that rejected it) yields null, not an empty-but-present signal.

const PRODUCT_INTEL_CONTRACT_VERSION = 'pivota.product_intel.v1';
// review_decision values that mean the bundle did NOT pass review → must not reach a buyer-facing agent.
const REJECTED_REVIEW_DECISIONS = new Set(['reject', 'reject_external', 'rejected', 'blocked', 'suppressed']);
// Higher = stronger. Used to surface the bundle's best public-safe claim grade on evidence.grade.
const GRADE_RANK = { A: 3, B: 2, C: 1 };
const CLAIM_LIMIT = 6;

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function asPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// Unwrap the product_intel_v1 bundle from the KB entry's `analysis` JSONB (nested or contract-at-root),
// matching how pdpProductIntel.js reads it.
function unwrapIntelBundle(analysis) {
  const a = asPlainObject(analysis);
  if (!a) return null;
  const bundle =
    asPlainObject(a.product_intel_v1) ||
    asPlainObject(a.product_intel) ||
    (String(a.contract_version || '') === PRODUCT_INTEL_CONTRACT_VERSION ? a : null);
  if (!bundle) return null;
  return {
    bundle,
    core: asPlainObject(bundle.product_intel_core),
    provenance: asPlainObject(bundle.provenance) || {},
  };
}

function intelToSignal(entry, { productId = null, isReviewed = null, filterPublicSafeClaims = null } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const unwrapped = unwrapIntelBundle(entry.analysis);
  if (!unwrapped || !unwrapped.core) return null;
  const { bundle, core, provenance } = unwrapped;

  const reviewDecision = nonEmptyString(provenance.review_decision) ? provenance.review_decision.trim() : null;
  if (reviewDecision && REJECTED_REVIEW_DECISIONS.has(reviewDecision.toLowerCase())) return null;

  // Require-reviewed gate: when a predicate is injected, only a bundle that PASSES review reaches a
  // buyer-facing agent. This drops thin/pilot/unreviewed entries (review_state null) that would
  // otherwise surface as low-quality "decision" content. Fail-closed: a throw is treated as not-reviewed.
  if (typeof isReviewed === 'function') {
    let reviewed = false;
    try {
      reviewed = isReviewed(bundle) === true;
    } catch {
      reviewed = false;
    }
    if (!reviewed) return null;
  }

  const why = asArray(core.why_it_stands_out)
    .map((item) => {
      const r = asPlainObject(item) || {};
      return {
        headline: nonEmptyString(r.headline) ? r.headline.trim() : '',
        body: nonEmptyString(r.body) ? r.body.trim() : '',
      };
    })
    .filter((r) => r.headline || r.body)
    .slice(0, 6);

  const bestFor = asArray(core.best_for)
    .map((item) => {
      const r = asPlainObject(item) || {};
      const label = nonEmptyString(r.label) ? r.label.trim() : nonEmptyString(r.tag) ? r.tag.trim() : '';
      return { label, tag: nonEmptyString(r.tag) ? r.tag.trim() : null };
    })
    .filter((r) => r.label)
    .slice(0, 8);

  const evidenceProfile = nonEmptyString(core.evidence_profile)
    ? core.evidence_profile.trim()
    : nonEmptyString(provenance.evidence_profile)
      ? provenance.evidence_profile.trim()
      : null;

  // Public-safe grounded claims (substantiated + grade A–C, with citation URLs) — the SAME subset the
  // public PDP JSON-LD publishes. The FTC per-claim rule is single-sourced in
  // pivotaInsightsQuality.filterPublicSafeClaims; we take it as an injected fn so this projection stays
  // pure (no app deps / no require cycle). When the fn is absent (flag off / not wired), no claims surface
  // and the evidence block is byte-for-byte the prior shape. This is the citation substrate a frontier
  // agent needs to CITE Pivota (claim_text + grade + PubMed source_refs), not just paraphrase it.
  let publicClaims = [];
  if (typeof filterPublicSafeClaims === 'function') {
    try {
      const filtered = filterPublicSafeClaims(asArray(core.evidence_claims));
      publicClaims = asArray(filtered)
        .map((c) => {
          const r = asPlainObject(c) || {};
          const grade = nonEmptyString(r.evidence_grade) ? r.evidence_grade.trim().toUpperCase() : null;
          return {
            claim_text: nonEmptyString(r.claim_text) ? r.claim_text.trim() : '',
            evidence_grade: grade && GRADE_RANK[grade] ? grade : null,
            source_refs: asArray(r.source_refs)
              .map((u) => (nonEmptyString(u) ? u.trim() : null))
              .filter(Boolean)
              .slice(0, 3),
            concern: nonEmptyString(r.concern) ? r.concern.trim() : null,
            ...(nonEmptyString(r.source_type) ? { source_type: r.source_type.trim() } : {}),
          };
        })
        .filter((c) => c.claim_text);
    } catch {
      publicClaims = [];
    }
  }
  // Bundle-level grade = the strongest claim grade present (A beats B beats C).
  const bestGrade = publicClaims.reduce((best, c) => {
    if (!c.evidence_grade) return best;
    if (!best || GRADE_RANK[c.evidence_grade] > GRADE_RANK[best]) return c.evidence_grade;
    return best;
  }, null);

  // Nothing meaningful to say → no signal (never fabricate a hollow decision block).
  if (!why.length && !bestFor.length && !evidenceProfile && !publicClaims.length) return null;

  return {
    signal_type: 'decision',
    subject: { kind: 'product', id: productId || null },
    value: {
      why_it_stands_out: why,
      best_for: bestFor,
      evidence_profile: evidenceProfile,
    },
    evidence: {
      grade: bestGrade,
      confidence: null,
      method: 'published_intel',
      sources: nonEmptyString(entry.kb_key) ? [{ type: 'product_intel_kb', ref: entry.kb_key }] : [],
      ...(publicClaims.length ? { claims: publicClaims } : {}),
    },
    freshness: { observed_at: entry.last_success_at || entry.updated_at || null, fresh_until: null },
    review_state: reviewDecision,
    visibility: 'buyer_safe',
  };
}

function addReviewedMerchantClaims(signal, claims, { productId, filterPublicSafeClaims } = {}) {
  if (!asArray(claims).length || typeof filterPublicSafeClaims !== 'function') return signal;
  const merchantSignal = intelToSignal({
    analysis: {
      contract_version: PRODUCT_INTEL_CONTRACT_VERSION,
      product_intel_core: { evidence_claims: claims },
    },
  }, {
    productId,
    filterPublicSafeClaims: (items) => {
      const sourceByClaim = new Map(items.map((claim) =>
        [JSON.stringify([claim.claim_text.trim(), claim.source_ref]), claim.source_type]));
      return asArray(filterPublicSafeClaims(items))
        .filter((claim) => asArray(claim.source_refs).length)
        .map((claim) => ({
          ...claim,
          source_type: sourceByClaim.get(JSON.stringify([claim.claim_text, claim.source_ref])),
        }));
    },
  });
  if (!merchantSignal) return signal;

  const existing = asArray(signal?.evidence?.claims);
  const seen = new Set(existing.map((claim) => claim.claim_text.toLowerCase()));
  const combined = [...existing];
  for (const claim of merchantSignal.evidence.claims) {
    if (combined.length >= CLAIM_LIMIT) break;
    const key = claim.claim_text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(claim);
  }
  if (combined.length === existing.length) return signal;

  const base = signal || {
    ...merchantSignal,
    evidence: { grade: null, confidence: null, method: 'staff_verified_merchant_evidence', sources: [] },
    review_state: 'staff_verified',
  };
  const grade = combined.reduce((best, claim) =>
    (GRADE_RANK[claim.evidence_grade] > (GRADE_RANK[best] || 0) ? claim.evidence_grade : best), base.evidence.grade);
  return {
    ...base,
    evidence: {
      ...base.evidence,
      grade,
      claims: combined,
      sources: [...base.evidence.sources, { type: 'staff_verified_merchant_evidence' }],
    },
  };
}

module.exports = { intelToSignal, addReviewedMerchantClaims, PRODUCT_INTEL_CONTRACT_VERSION };
