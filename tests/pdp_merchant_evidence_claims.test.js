'use strict';

// Phase 2b serving half: merge substantiated MERCHANT evidence (general
// product_evidence store) into the served get_pdp_v2 product_intel bundle so
// non-beauty products — and beauty products with merchant lab evidence — publish
// citable claims. Additive + flag-gated; the public/FTC gate stays single-sourced
// in pivotaInsightsQuality.filterPublicSafeClaims.

// PUBLIC publishing additionally respects PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED (the
// public-surface kill-switch, read at module load). Default these tests with it ON
// (prod reality); a dedicated test below reloads with it OFF.
process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = 'true';
const { mergeMerchantEvidenceClaims } = require('../src/pdpProductIntel.js');

const A = { claim_text: 'SPF 30 verified', source_ref: 'art_1', evidence_grade: 'a', substantiation_status: 'substantiated' };
const B = { claim_text: 'Editor pick', source_ref: 'http://press', evidence_grade: 'b', substantiation_status: 'substantiated' };
const D = { claim_text: 'Weak lab note', evidence_grade: 'd', substantiation_status: 'substantiated' };

function withFlag(val, fn) {
  const prev = process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED;
  if (val === undefined) delete process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED;
  else process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED = val;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED;
    else process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED = prev;
  }
}

describe('mergeMerchantEvidenceClaims (flag-gated, additive)', () => {
  test('flag OFF (default): bundle returned unchanged', () => {
    withFlag(undefined, () => {
      const b = { product_intel_core: { evidence_claims: [] } };
      expect(mergeMerchantEvidenceClaims(b, [A])).toBe(b);
    });
  });

  test('flag ON, no merchant claims: unchanged', () => {
    withFlag('true', () => {
      const b = { product_intel_core: { evidence_claims: [] } };
      expect(mergeMerchantEvidenceClaims(b, [])).toBe(b);
      expect(mergeMerchantEvidenceClaims(b, null)).toBe(b);
    });
  });

  test('flag ON + existing INCI bundle: appends to evidence_claims, publishes A/B, drops grade D', () => {
    withFlag('true', () => {
      const inci = { claim_text: 'Niacinamide supports the barrier', evidence_grade: 'a', substantiation_status: 'substantiated' };
      const b = { product_intel_core: { evidence_claims: [inci] } };
      const r = mergeMerchantEvidenceClaims(b, [A, B, D]);
      // agent surface keeps the full set (INCI + all merchant claims)
      expect(r.product_intel_core.evidence_claims).toHaveLength(4);
      // public surface: substantiated + grade a/b/c only
      expect(r.public_ready).toBe(true);
      const pub = r.product_intel_core.public_claims.map((c) => c.claim_text);
      expect(pub).toContain('SPF 30 verified');
      expect(pub).toContain('Editor pick');
      expect(pub).not.toContain('Weak lab note');
    });
  });

  test('flag ON + NO bundle (non-beauty): synthesizes a merchant-evidence bundle', () => {
    withFlag('true', () => {
      const r = mergeMerchantEvidenceClaims(null, [A, B]);
      expect(r.contract_version).toBe('pivota.product_intel.v1');
      expect(r.intel_tier).toBe('merchant_evidence');
      expect(r.public_ready).toBe(true);
      expect(r.product_intel_core.public_claims.map((c) => c.claim_text)).toEqual([
        'SPF 30 verified',
        'Editor pick',
      ]);
      expect(r.product_intel_core.evidence_claims).toHaveLength(2);
    });
  });

  test('flag ON + NO bundle, only grade-D: agent surface only, public_ready false', () => {
    withFlag('true', () => {
      const r = mergeMerchantEvidenceClaims(null, [D]);
      expect(r.public_ready).toBe(false);
      expect(r.product_intel_core.public_claims).toBeUndefined();
      expect(r.product_intel_core.evidence_claims).toHaveLength(1);
    });
  });

  test('flag ON: dedupes by claim_text across existing + merchant', () => {
    withFlag('true', () => {
      const dup = { claim_text: 'SPF 30 verified', evidence_grade: 'a', substantiation_status: 'substantiated' };
      const b = { product_intel_core: { evidence_claims: [dup] } };
      const r = mergeMerchantEvidenceClaims(b, [A]); // A shares the claim_text
      expect(r.product_intel_core.evidence_claims).toHaveLength(1);
    });
  });
});

describe('mergeMerchantEvidenceClaims respects the public kill-switch', () => {
  test('public flag OFF: agent surface merges, but NO public_claims published', () => {
    // Reload the module with PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED unset.
    jest.isolateModules(() => {
      const prevPub = process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
      const prevMerch = process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED;
      delete process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
      process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED = 'true';
      try {
        const { mergeMerchantEvidenceClaims: merge } = require('../src/pdpProductIntel.js');
        // existing-bundle case: evidence_claims still merge (agent surface)…
        const b = { product_intel_core: { evidence_claims: [] } };
        const r = merge(b, [A, B]);
        expect(r.product_intel_core.evidence_claims).toHaveLength(2);
        // …but the public surface stays dark.
        expect(r.public_ready).toBeUndefined();
        expect(r.product_intel_core.public_claims).toBeUndefined();
        // synthesized (non-beauty) case: bundle exists for agents, public_ready false.
        const s = merge(null, [A, B]);
        expect(s.product_intel_core.evidence_claims).toHaveLength(2);
        expect(s.public_ready).toBe(false);
        expect(s.product_intel_core.public_claims).toBeUndefined();
      } finally {
        if (prevPub == null) delete process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED;
        else process.env.PDP_PUBLIC_GROUNDED_CLAIMS_ENABLED = prevPub;
        if (prevMerch == null) delete process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED;
        else process.env.PDP_MERCHANT_EVIDENCE_CLAIMS_ENABLED = prevMerch;
      }
    });
  });
});
