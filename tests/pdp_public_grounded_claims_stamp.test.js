'use strict';

// Phase 1a: serve-path stamp of public-safe grounded claims onto the served bundle, so
// the public PDP JSON-LD can publish citable claims. filterPublicSafeClaims is the single
// source of the FTC per-claim rule; stampPublicGroundedClaims is additive + flag-gated.
// See docs/kbeauty_merchant_appearance_enrichment_scope.md.

const { filterPublicSafeClaims } = require('../src/services/pivotaInsightsQuality.js');

const PDP_MODULE = require.resolve('../src/pdpProductIntel.js');
function loadPdp(flagValue) {
  let mod;
  jest.isolateModules(() => {
    const prev = process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
    if (flagValue === undefined) delete process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
    else process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = flagValue;
    try {
      mod = require(PDP_MODULE);
    } finally {
      if (prev == null) delete process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
      else process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = prev;
    }
  });
  return mod;
}

const CLAIMS = [
  { claim_text: 'Adenosine supports firmness', source_ref: 'Adenosine', concern: 'firmness', evidence_grade: 'A', substantiation_status: 'substantiated', source_refs: ['http://a', 'http://b', 'http://c', 'http://d'] },
  { claim_text: 'Niacinamide helps the barrier', source_ref: 'Niacinamide', evidence_grade: 'B', substantiation_status: 'substantiated', source_refs: ['http://x'] },
  { claim_text: 'Unverified mechanism', evidence_grade: 'C', substantiation_status: 'unverified', source_refs: [] },
  { claim_text: 'Weak evidence', evidence_grade: 'D', substantiation_status: 'substantiated' },
  { claim_text: 'Marketing vs reality', evidence_grade: null, substantiation_status: 'flagged' },
];
const groundedBundle = (claims = CLAIMS) => ({
  provenance: {
    review_tier: 'grounded', reviewer_kind: 'automated_grounded', review_status: 'completed',
    review_decision: 'grounded_pass',
    grounding: { inci_verified: true, citations_present: true, claim_safety: 'cosmetic_screened' },
  },
  evidence_profile: 'grounded_verified',
  product_intel_core: { evidence_profile: 'grounded_verified', evidence_claims: claims },
});

describe('filterPublicSafeClaims (single-sourced FTC rule)', () => {
  test('keeps only substantiated + grade A–C, drops unverified / D / flagged', () => {
    const out = filterPublicSafeClaims(CLAIMS);
    expect(out.map((c) => c.evidence_grade)).toEqual(['A', 'B']);
    expect(out.map((c) => c.claim_text)).toEqual(['Adenosine supports firmness', 'Niacinamide helps the barrier']);
  });
  test('caps source_refs at 3 and uppercases the grade', () => {
    expect(filterPublicSafeClaims(CLAIMS)[0].source_refs).toEqual(['http://a', 'http://b', 'http://c']);
  });
  test('caps total claims and is safe on junk input', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ claim_text: `c${i}`, evidence_grade: 'A', substantiation_status: 'substantiated' }));
    expect(filterPublicSafeClaims(many).length).toBe(6);
    expect(filterPublicSafeClaims(null)).toEqual([]);
    expect(filterPublicSafeClaims('nope')).toEqual([]);
  });
});

describe('stampPublicGroundedClaims (additive, flag-gated)', () => {
  test('flag OFF (default): bundle returned unchanged', () => {
    const { stampPublicGroundedClaims: stamp } = loadPdp(undefined);
    const b = groundedBundle();
    const r = stamp(b);
    expect(r.public_ready).toBeUndefined();
    expect(r.product_intel_core.public_claims).toBeUndefined();
  });

  test('flag ON + grounded: stamps public_ready + public_claims WITHOUT mutating evidence_claims', () => {
    const { stampPublicGroundedClaims: stamp } = loadPdp('true');
    const b = groundedBundle();
    const r = stamp(b);
    expect(r.public_ready).toBe(true);
    expect(r.product_intel_core.public_claims.map((c) => c.claim_text)).toEqual([
      'Adenosine supports firmness', 'Niacinamide helps the barrier',
    ]);
    // additive: the full evidence_claims set is preserved for the agent surface
    expect(r.product_intel_core.evidence_claims).toHaveLength(CLAIMS.length);
  });

  test('flag ON + NON-grounded bundle: unchanged', () => {
    const { stampPublicGroundedClaims: stamp } = loadPdp('true');
    const human = { provenance: { review_tier: 'strict_human' }, product_intel_core: { evidence_claims: CLAIMS } };
    expect(stamp(human).public_ready).toBeUndefined();
  });

  test('flag ON + grounded but no public-safe claims: unchanged (no empty publish)', () => {
    const { stampPublicGroundedClaims: stamp } = loadPdp('true');
    const onlyUnsafe = groundedBundle([
      { claim_text: 'x', evidence_grade: 'D', substantiation_status: 'substantiated' },
      { claim_text: 'y', evidence_grade: 'A', substantiation_status: 'unverified' },
    ]);
    expect(stamp(onlyUnsafe).public_ready).toBeUndefined();
  });
});
