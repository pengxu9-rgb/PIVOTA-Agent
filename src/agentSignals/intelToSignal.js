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
    core: asPlainObject(bundle.product_intel_core),
    provenance: asPlainObject(bundle.provenance) || {},
  };
}

function intelToSignal(entry, { productId = null } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const bundle = unwrapIntelBundle(entry.analysis);
  if (!bundle || !bundle.core) return null;
  const { core, provenance } = bundle;

  const reviewDecision = nonEmptyString(provenance.review_decision) ? provenance.review_decision.trim() : null;
  if (reviewDecision && REJECTED_REVIEW_DECISIONS.has(reviewDecision.toLowerCase())) return null;

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

  // Nothing meaningful to say → no signal (never fabricate a hollow decision block).
  if (!why.length && !bestFor.length && !evidenceProfile) return null;

  return {
    signal_type: 'decision',
    subject: { kind: 'product', id: productId || null },
    value: {
      why_it_stands_out: why,
      best_for: bestFor,
      evidence_profile: evidenceProfile,
    },
    evidence: {
      grade: null,
      confidence: null,
      method: 'published_intel',
      sources: nonEmptyString(entry.kb_key) ? [{ type: 'product_intel_kb', ref: entry.kb_key }] : [],
    },
    freshness: { observed_at: entry.last_success_at || entry.updated_at || null, fresh_until: null },
    review_state: reviewDecision,
    visibility: 'buyer_safe',
  };
}

module.exports = { intelToSignal, PRODUCT_INTEL_CONTRACT_VERSION };
