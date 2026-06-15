const {
  isProtectedDossierBundle,
  isPositioningBlurbBundle,
  isServableProductIntelBundle,
  isGroundedProductIntelBundle,
  hydrateProductWithGroundedIntel,
} = require('../src/pdpProductIntel');

// Dossier authoring engine, Phase 1 — grounded dossier is the PRIMARY tier; it
// outranks a positioning blurb but yields to a protected genuine human/community
// dossier. See docs/dossier-authoring-engine-plan.md.

function groundedBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: {
      what_it_is: { headline: 'Niacinamide serum', body: 'Niacinamide-forward formula.' },
      why_it_stands_out: [{ headline: 'Niacinamide', body: 'evens the look of tone', evidence_strength: 'clinical' }],
      best_for: [{ tag: 'uneven_tone', label: 'uneven tone' }],
      evidence_claims: [
        { claim_text: 'evens the look of tone', source_ref: 'Niacinamide', source_type: 'ingredient_mechanism', evidence_grade: 'A', substantiation_status: 'substantiated' },
      ],
      evidence_profile: 'grounded_verified',
      quality_state: 'eligible',
    },
    evidence_profile: 'grounded_verified',
    quality_state: 'eligible',
    provenance: {
      tier: 'grounded',
      review_tier: 'grounded',
      reviewer_kind: 'automated_grounded',
      review_status: 'completed',
      review_decision: 'grounded_pass',
      grounding: { inci_verified: true, citations_present: true, claim_safety: 'cosmetic_screened', active_slugs: ['niacinamide'] },
    },
    freshness: { generated_at: '2026-06-15' },
  };
}

// A SERVABLE positioning blurb: a strict_human_manual_rewrite seller summary
// (served as "human" today) — the demoted tier grounded should outrank.
function manualRewriteBlurb() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: {
      what_it_is: { headline: 'Niacinamide serum', body: 'A niacinamide serum positioned for daily brightening.' },
      why_it_stands_out: [{ headline: 'Brightening', body: 'targets uneven tone' }],
      best_for: [{ tag: 'brightening', label: 'brightening' }],
    },
    evidence_profile: 'seller_plus_formula',
    quality_state: 'reviewed',
    provenance: { generator: 'strict_human_manual_rewrite', review_tier: 'assistant_reviewed' },
  };
}

// Protected genuine dossiers (must NOT be outranked):
function communityBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: { what_it_is: { headline: 'X', body: 'real niacinamide reviews' }, why_it_stands_out: [{ headline: 'A', body: 'b' }] },
    evidence_profile: 'community_supported',
    provenance: { reviewer_kind: 'assistant', review_tier: 'assistant_reviewed' },
    freshness: { source_version: 'community' },
  };
}
function verifiedPivotaBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: { what_it_is: { headline: 'X', body: 'verified niacinamide copy' }, why_it_stands_out: [{ headline: 'A', body: 'b' }] },
    evidence_profile: 'pivota_reviewed',
    quality_state: 'verified',
    provenance: { source: 'aurora_product_intel_kb', reviewer_kind: 'human' },
  };
}
function pilotHumanBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: { what_it_is: { headline: 'X', body: 'human niacinamide copy' }, why_it_stands_out: [{ headline: 'A', body: 'b' }], freshness: { source_version: 'pilot_selected:strict_human_reviewed' } },
    freshness: { source_version: 'pilot_selected:strict_human_reviewed' },
    provenance: { source: 'strict_human' },
  };
}
// A bare seller_only bundle — NOT servable (so not a "positioning blurb" per the
// helper, which is about servable-but-demotable bundles).
function sellerOnlyBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: { what_it_is: { headline: 'X', body: 'niacinamide seller copy' } },
    evidence_profile: 'seller_only',
    provenance: { reviewer_kind: 'none' },
  };
}

describe('isProtectedDossierBundle', () => {
  test('protects genuine human/community dossiers', () => {
    expect(isProtectedDossierBundle(communityBundle())).toBe(true);
    expect(isProtectedDossierBundle(verifiedPivotaBundle())).toBe(true);
    expect(isProtectedDossierBundle(pilotHumanBundle())).toBe(true);
  });
  test('does NOT protect a strict_human_manual_rewrite seller summary (demoted tier)', () => {
    expect(isProtectedDossierBundle(manualRewriteBlurb())).toBe(false);
  });
  test('does NOT protect bare seller copy', () => {
    expect(isProtectedDossierBundle(sellerOnlyBundle())).toBe(false);
  });
});

describe('isPositioningBlurbBundle', () => {
  test('a servable strict_human_manual_rewrite blurb IS a positioning blurb', () => {
    const blurb = manualRewriteBlurb();
    expect(isServableProductIntelBundle(blurb)).toBe(true); // served as "human" today
    expect(isPositioningBlurbBundle(blurb)).toBe(true);
  });
  test('grounded + protected dossiers are NOT positioning blurbs', () => {
    expect(isPositioningBlurbBundle(groundedBundle())).toBe(false);
    expect(isPositioningBlurbBundle(communityBundle())).toBe(false);
    expect(isPositioningBlurbBundle(verifiedPivotaBundle())).toBe(false);
    expect(isPositioningBlurbBundle(pilotHumanBundle())).toBe(false);
  });
  test('a non-servable seller_only bundle is not a positioning blurb (already bypassable)', () => {
    expect(isServableProductIntelBundle(sellerOnlyBundle())).toBe(false);
    expect(isPositioningBlurbBundle(sellerOnlyBundle())).toBe(false);
  });
});

describe('hydrateProductWithGroundedIntel — grounded outranks blurb', () => {
  const ENV = ['PDP_GROUNDED_PRODUCT_INTEL_ENABLED', 'PDP_GROUNDED_OUTRANKS_BLURB'];
  let saved;
  beforeEach(() => { saved = ENV.map((k) => process.env[k]); ENV.forEach((k) => delete process.env[k]); });
  afterEach(() => { ENV.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; }); });

  const product = { product_id: 'p1', title: 'Cohort serum', inci: 'Niacinamide, Water' };

  test('injected generator outranks a positioning blurb (replaces it with the dossier)', async () => {
    const withBlurb = { ...product, product_intel: manualRewriteBlurb() };
    const buildGrounded = jest.fn(async () => groundedBundle());
    const out = await hydrateProductWithGroundedIntel({ product: withBlurb, buildGrounded });
    expect(buildGrounded).toHaveBeenCalled();
    expect(out.product_intel.provenance.tier).toBe('grounded');
    expect(isGroundedProductIntelBundle(out.product_intel)).toBe(true);
  });

  test('injected generator does NOT outrank a protected genuine dossier', async () => {
    const withProtected = { ...product, product_intel: verifiedPivotaBundle() };
    const buildGrounded = jest.fn(async () => groundedBundle());
    const out = await hydrateProductWithGroundedIntel({ product: withProtected, buildGrounded });
    expect(buildGrounded).not.toHaveBeenCalled();
    expect(out.product_intel).toBe(withProtected.product_intel);
  });

  test('env serve path: base flag on but OUTRANK flag off → blurb kept (no synthesis)', async () => {
    process.env.PDP_GROUNDED_PRODUCT_INTEL_ENABLED = 'true';
    const withBlurb = { ...product, product_intel: manualRewriteBlurb() };
    const out = await hydrateProductWithGroundedIntel({ product: withBlurb });
    expect(out.product_intel).toBe(withBlurb.product_intel); // unchanged, blurb retained
  });

  test('env serve path: base flag off → no-op even with OUTRANK flag on', async () => {
    process.env.PDP_GROUNDED_OUTRANKS_BLURB = 'true';
    const withBlurb = { ...product, product_intel: manualRewriteBlurb() };
    const out = await hydrateProductWithGroundedIntel({ product: withBlurb });
    expect(out.product_intel).toBe(withBlurb.product_intel);
  });
});
