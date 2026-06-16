'use strict';

// Phase-0 fix: extend the PUBLIC quality-lane gate so Tier-G grounded bundles reach
// public_ready (so their claims can be published as citable structured data), behind
// PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED. Verifies grounded flips ONLY with the flag, while
// human stays public and seller-only stays blocked either way.
// See docs/kbeauty_merchant_appearance_enrichment_scope.md.

const MODULE = require.resolve('../src/services/pivotaInsightsQuality.js');

function load(flagValue) {
  let mod;
  jest.isolateModules(() => {
    const prev = process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
    if (flagValue === undefined) delete process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
    else process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = flagValue;
    try {
      mod = require(MODULE);
    } finally {
      if (prev == null) delete process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
      else process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = prev;
    }
  });
  return mod;
}

// A classification with .issues[] + .status is returned as-is by classifyKbLike — exactly
// the shape classifyProductIntelKbRow produces for each tier (confirmed by reading it +
// empirically: isHumanReviewedProductIntelBundle(grounded)=false, isGrounded=true, so
// displayable=true via normalize's reviewedForPublicDisplay, high_quality_ready=false via
// the not_reviewed blocking issue, evidence_profile='grounded_verified').
const GROUNDED = {
  product_id: 'p1', kb_key: 'product:p1', status: 'displayable', kb_exists: true,
  displayable: true, high_quality_ready: false, human_reviewed: false,
  issues: ['not_reviewed'], blocking_issues: ['not_reviewed'],
  quality_state: 'reviewed', evidence_profile: 'grounded_verified',
};
const HUMAN = {
  product_id: 'p2', kb_key: 'product:p2', status: 'displayable', kb_exists: true,
  displayable: true, high_quality_ready: true, human_reviewed: true,
  issues: [], blocking_issues: [],
  quality_state: 'reviewed', evidence_profile: 'pivota_reviewed',
};
const SELLER_ONLY = {
  product_id: 'p3', kb_key: 'product:p3', status: 'displayable', kb_exists: true,
  displayable: true, high_quality_ready: false, human_reviewed: false,
  issues: ['seller_only_evidence'], blocking_issues: [],
  quality_state: 'reviewed', evidence_profile: 'seller_only',
};
const cleanBundle = (profile) => ({
  provenance: { review_tier: profile === 'grounded_verified' ? 'grounded' : 'human' },
  product_intel_core: { evidence_profile: profile, watchouts: ['patch test first'] },
});

describe('public quality-lane gate — Tier-G grounded', () => {
  test('flag OFF (default): grounded is NOT public_ready', () => {
    const { classifyPivotaInsightQualityLane: classify } = load(undefined);
    const r = classify(GROUNDED, { bundle: cleanBundle('grounded_verified') });
    expect(r.public_ready).toBe(false);
    expect(r.lane).not.toBe('keep');
  });

  test('flag ON: grounded becomes public_ready via the KEEP lane', () => {
    const { classifyPivotaInsightQualityLane: classify } = load('true');
    const r = classify(GROUNDED, { bundle: cleanBundle('grounded_verified') });
    expect(r.lane).toBe('keep');
    expect(r.public_ready).toBe(true);
  });

  test('human-reviewed stays public_ready regardless of the flag', () => {
    for (const flag of [undefined, 'true']) {
      const { classifyPivotaInsightQualityLane: classify } = load(flag);
      const r = classify(HUMAN, { bundle: cleanBundle('pivota_reviewed') });
      expect(r.public_ready).toBe(true);
    }
  });

  test('seller-only stays NOT public_ready regardless of the flag (no widening)', () => {
    for (const flag of [undefined, 'true']) {
      const { classifyPivotaInsightQualityLane: classify } = load(flag);
      const r = classify(SELLER_ONLY, { bundle: cleanBundle('seller_only') });
      expect(r.public_ready).toBe(false);
    }
  });
});
