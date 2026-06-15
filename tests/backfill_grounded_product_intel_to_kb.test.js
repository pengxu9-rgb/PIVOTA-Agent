const {
  countGradedClaims,
  decideGroundedWrite,
  buildGroundedKbEntry,
  extractGeneratorProductFromPdp,
  backfillOne,
  runBackfill,
  parseProductRef,
} = require('../scripts/backfill_grounded_product_intel_to_kb');

// Dossier authoring engine, Phase 1 — grounded backfill persists graded dossiers
// to aurora_product_intel_kb, outranking positioning blurbs but never overwriting
// protected genuine human/community dossiers. See docs/dossier-authoring-engine-plan.md.

function groundedBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: {
      what_it_is: { headline: 'Niacinamide serum', body: 'Niacinamide-forward formula.' },
      why_it_stands_out: [{ headline: 'Niacinamide', body: 'evens the look of tone', evidence_strength: 'clinical' }],
      evidence_claims: [
        { claim_text: 'evens the look of tone', source_ref: 'Niacinamide', source_type: 'ingredient_mechanism', evidence_grade: 'A', substantiation_status: 'substantiated' },
        { claim_text: 'supports the barrier', source_ref: 'Niacinamide', source_type: 'ingredient_mechanism', evidence_grade: 'B', substantiation_status: 'substantiated' },
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
const kbRow = (bundle, source = 'x') => ({ source, analysis: { product_intel_v1: bundle } });
const manualRewriteBlurb = () => ({
  contract_version: 'pivota.product_intel.v1',
  product_intel_core: { what_it_is: { headline: 'X', body: 'blurb' } },
  evidence_profile: 'seller_plus_formula',
  provenance: { generator: 'strict_human_manual_rewrite', review_tier: 'assistant_reviewed' },
});
const verifiedPivotaBundle = () => ({
  contract_version: 'pivota.product_intel.v1',
  product_intel_core: { what_it_is: { headline: 'X', body: 'verified' } },
  evidence_profile: 'pivota_reviewed',
  quality_state: 'verified',
  provenance: { source: 'aurora_product_intel_kb', reviewer_kind: 'human' },
});

const product = {
  product_id: 'p1',
  title: 'Cohort serum',
  ingredient_intel: { items: ['Niacinamide', 'Water', 'Glycerin', 'Butylene Glycol', 'Phenoxyethanol'] },
};

describe('countGradedClaims', () => {
  test('counts A/B/C claims with a status', () => {
    expect(countGradedClaims(groundedBundle())).toBe(2);
    expect(countGradedClaims({ product_intel_core: { evidence_claims: [{ evidence_grade: 'D', substantiation_status: 'x' }] } })).toBe(0);
  });
});

describe('decideGroundedWrite (precedence inversion)', () => {
  test('non-grounded candidate → no write', () => {
    expect(decideGroundedWrite({ groundedBundle: { provenance: {} } }).write).toBe(false);
  });
  test('no existing KB row → write (new)', () => {
    expect(decideGroundedWrite({ existingKbRow: null, groundedBundle: groundedBundle() })).toEqual({ write: true, reason: 'new' });
  });
  test('existing grounded → refresh', () => {
    const d = decideGroundedWrite({ existingKbRow: kbRow(groundedBundle()), groundedBundle: groundedBundle() });
    expect(d).toEqual({ write: true, reason: 'refresh_grounded' });
  });
  test('existing positioning blurb → replace', () => {
    const d = decideGroundedWrite({ existingKbRow: kbRow(manualRewriteBlurb()), groundedBundle: groundedBundle() });
    expect(d).toEqual({ write: true, reason: 'replace_positioning_blurb' });
  });
  test('existing protected genuine dossier → kept (no write)', () => {
    const d = decideGroundedWrite({ existingKbRow: kbRow(verifiedPivotaBundle()), groundedBundle: groundedBundle() });
    expect(d).toEqual({ write: false, reason: 'protected_dossier_kept' });
  });
});

describe('buildGroundedKbEntry', () => {
  test('produces the aurora_product_intel_kb shape', () => {
    const entry = buildGroundedKbEntry({
      productId: 'p1',
      canonicalProductRef: { product_id: 'p1', merchant_id: 'm1' },
      groundedBundle: groundedBundle(),
      now: '2026-06-15T00:00:00.000Z',
    });
    expect(entry.kb_key).toBe('product:p1');
    expect(entry.analysis.contract_version).toBe('pivota.product_intel.v1');
    expect(entry.analysis.product_intel_v1.provenance.tier).toBe('grounded');
    expect(entry.analysis.product_intel_v1.canonical_product_ref).toEqual({ product_id: 'p1', merchant_id: 'm1' });
    expect(entry.source).toBe('pivota_grounded_synthesis_v1');
    expect(entry.source_meta.tier).toBe('grounded');
    expect(entry.source_meta.evidence_profile).toBe('grounded_verified');
    expect(entry.source_meta.graded_claims).toBe(2);
    expect(entry.source_meta.active_slugs).toEqual(['niacinamide']);
    expect(entry.source_meta.replaced).toBeUndefined();
  });
  test('records what it replaced when overwriting an existing bundle', () => {
    const entry = buildGroundedKbEntry({
      productId: 'p1',
      groundedBundle: groundedBundle(),
      existingKbRow: kbRow(manualRewriteBlurb(), 'pilot_selected'),
    });
    expect(entry.source_meta.replaced).toEqual({
      previous_source: 'pilot_selected',
      previous_evidence_profile: 'seller_plus_formula',
      previous_review_tier: 'assistant_reviewed',
      previous_generator: 'strict_human_manual_rewrite',
    });
  });
});

describe('extractGeneratorProductFromPdp', () => {
  test('pulls INCI from an ingredients module + product node', () => {
    const response = {
      modules: [
        { type: 'canonical', data: { product: { product_id: 'p1', title: 'Glow Serum', brand: 'Acme' } } },
        { type: 'ingredients_inci', data: { items: [{ inci: 'Water' }, { inci: 'Niacinamide' }, 'Glycerin'] } },
      ],
    };
    const out = extractGeneratorProductFromPdp(response, { product_id: 'p1', merchant_id: 'm1' });
    expect(out.product_id).toBe('p1');
    expect(out.merchant_id).toBe('m1');
    expect(out.title).toBe('Glow Serum');
    expect(out.ingredient_intel.items).toEqual(['Water', 'Niacinamide', 'Glycerin']);
  });
  test('returns null when no INCI is present anywhere', () => {
    expect(extractGeneratorProductFromPdp({ modules: [{ type: 'offers', data: { offers: [] } }] }, { product_id: 'p1' })).toBeNull();
  });
});

describe('backfillOne + runBackfill (I/O injected)', () => {
  const loadProduct = async () => product;
  const buildGrounded = async () => groundedBundle();

  test('eligible when grounded synthesizes and no existing row', async () => {
    const r = await backfillOne({ ref: { product_id: 'p1', merchant_id: 'm1' }, loadProduct, getExisting: async () => null, buildGrounded });
    expect(r.status).toBe('eligible');
    expect(r.reason).toBe('new');
    expect(r.graded_claims).toBe(2);
    expect(r.entry.kb_key).toBe('product:p1');
  });

  test('skipped when product fails to load', async () => {
    const r = await backfillOne({ ref: { product_id: 'p1' }, loadProduct: async () => null, getExisting: async () => null, buildGrounded });
    expect(r).toMatchObject({ status: 'skipped', reason: 'product_not_loaded' });
  });

  test('skipped when no grounded bundle is produced', async () => {
    const r = await backfillOne({ ref: { product_id: 'p1' }, loadProduct, getExisting: async () => null, buildGrounded: async () => null });
    expect(r).toMatchObject({ status: 'skipped', reason: 'no_grounded_bundle' });
  });

  test('skipped (kept) when a protected dossier already occupies the slot', async () => {
    const r = await backfillOne({ ref: { product_id: 'p1' }, loadProduct, getExisting: async () => kbRow(verifiedPivotaBundle()), buildGrounded });
    expect(r).toMatchObject({ status: 'skipped', reason: 'protected_dossier_kept' });
  });

  test('runBackfill dry-run: eligible, never upserts', async () => {
    const upsert = jest.fn(async () => undefined);
    const summary = await runBackfill({
      refs: [{ product_id: 'p1', merchant_id: 'm1' }],
      loadProduct, getExisting: async () => null, buildGrounded, upsert, write: false, logger: { log() {} },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(summary.mode).toBe('dry_run');
    expect(summary.eligible).toBe(1);
    expect(summary.written).toBe(0);
    expect(summary.graded_claims_authored).toBe(2);
  });

  test('runBackfill write: upserts the grounded entry and marks written', async () => {
    const upsert = jest.fn(async () => undefined);
    const summary = await runBackfill({
      refs: [{ product_id: 'p1', merchant_id: 'm1' }],
      loadProduct, getExisting: async () => kbRow(manualRewriteBlurb()), buildGrounded, upsert, write: true, logger: { log() {} },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].kb_key).toBe('product:p1');
    expect(upsert.mock.calls[0][0].source).toBe('pivota_grounded_synthesis_v1');
    expect(summary.written).toBe(1);
    expect(summary.by_reason.replace_positioning_blurb).toBe(1);
  });
});

describe('parseProductRef', () => {
  test('parses merchant:product and bare product', () => {
    expect(parseProductRef('m1:p1')).toEqual({ merchant_id: 'm1', product_id: 'p1' });
    expect(parseProductRef('p1')).toEqual({ product_id: 'p1' });
    expect(parseProductRef('')).toBeNull();
  });
});
