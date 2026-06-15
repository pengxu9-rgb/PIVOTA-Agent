const { buildProductIntelBundle } = require('../src/pdpProductIntel');

// Agents must read structured, self-describing Pivota context — the
// pivota.agent_product_context.v1 bundle (facts + confidence/source tier +
// guardrails) — not just the "Pivota Insights" display name. buildProductIntelBundle
// is the single serve choke point (both get_pdp_v2 paths funnel through it), so the
// context must be attached on its output.

function groundedIntelBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    display_name: 'Pivota Insights',
    product_intel_core: {
      display_name: 'Pivota Insights',
      what_it_is: { headline: 'Niacinamide serum', body: 'A niacinamide-forward serum for uneven tone.' },
      why_it_stands_out: [{ headline: 'Niacinamide', body: 'evens the look of tone', evidence_strength: 'clinical' }],
      best_for: [{ tag: 'uneven_tone', label: 'uneven tone' }],
      watchouts: [{ type: 'safety', label: 'Niacin sensitivity (rare)', severity: 'mild' }],
      evidence_claims: [
        { claim_text: 'evens the look of tone', source_ref: 'Niacinamide', source_type: 'ingredient_mechanism', evidence_grade: 'A', substantiation_status: 'substantiated' },
      ],
      evidence_profile: 'grounded_verified',
      quality_state: 'eligible',
    },
    evidence_profile: 'grounded_verified',
    quality_state: 'eligible',
    provenance: {
      tier: 'grounded', review_tier: 'grounded', reviewer_kind: 'automated_grounded',
      review_status: 'completed', review_decision: 'grounded_pass',
      grounding: { inci_verified: true, citations_present: true, claim_safety: 'cosmetic_screened', active_slugs: ['niacinamide'] },
    },
  };
}

describe('agent_context is attached to served product-intel bundles', () => {
  test('buildProductIntelBundle stamps pivota.agent_product_context.v1 with facts + guardrails', () => {
    const product = {
      merchant_id: 'm1',
      product_id: 'p1',
      title: 'Niacinamide Serum',
      product_intel: groundedIntelBundle(),
    };
    const bundle = buildProductIntelBundle({
      product,
      canonicalProductRef: { merchant_id: 'm1', product_id: 'p1' },
    });

    expect(bundle).toBeTruthy();
    expect(bundle.display_name).toBe('Pivota Insights');
    const ctx = bundle.agent_context;
    expect(ctx).toBeTruthy();
    expect(ctx.contract_version).toBe('pivota.agent_product_context.v1');
    // self-describing source/quality the agent can read directly
    expect(ctx.source_tier).toBe('grounded_verified');
    expect(ctx.quality_state).toBe('eligible');
    // structured facts mirror the decision intelligence
    expect(ctx.facts.what_it_is).toMatch(/niacinamide/i);
    expect(ctx.facts.why_it_stands_out.length).toBeGreaterThan(0);
    // guardrails travel with the data (agents must not invent price/availability)
    expect(ctx.guardrails.no_price_or_availability_claims).toBe(true);
    expect(ctx.guardrails.commerce_truth_source).toBe('commerce_mainline_only');
  });

  test('returns null product-intel unchanged (best-effort, no throw)', () => {
    const bundle = buildProductIntelBundle({ product: { merchant_id: 'm1', product_id: 'p2', title: 'No intel' } });
    expect(bundle).toBeNull();
  });
});
