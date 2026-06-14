const {
  isGroundedProductIntelBundle,
  resolveProductIntelTier,
  isServableProductIntelBundle,
  isHumanReviewedProductIntelBundle,
  normalizePublishedProductIntelBundle,
  hydrateProductWithGroundedIntel,
} = require('../src/pdpProductIntel');
const { buildGroundedProductIntelBundle, extractActiveTerms } = require('../src/groundedProductIntel');

// ADR-002 item 9 — the tiered serving gate: human | grounded | reject.
// See docs/tier-g-evidence-claims-reconciliation.md (joint decision 4).

// A minimal Tier-G bundle carrying every grounding predicate the gate requires.
function groundedBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: {
      what_it_is: { headline: 'Test serum — Niacinamide forward', body: 'Niacinamide-forward formula.' },
      why_it_stands_out: [
        { headline: 'Niacinamide', body: 'evens the look of tone via melanosome transfer', evidence_strength: 'clinical' },
      ],
      best_for: [{ tag: 'uneven_tone', label: 'uneven tone' }],
      evidence_claims: [
        {
          claim_text: 'evens the look of tone',
          source_ref: 'Niacinamide',
          source_type: 'ingredient_mechanism',
          evidence_grade: 'A',
          substantiation_status: 'substantiated',
        },
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
      grounding: {
        inci_verified: true,
        citations_present: true,
        claim_safety: 'cosmetic_screened',
        active_slugs: ['niacinamide'],
      },
    },
  };
}

// isHumanReviewedProductIntelBundle's simplest accept marker.
function humanBundle() {
  return {
    contract_version: 'pivota.product_intel.v1',
    product_intel_core: {
      what_it_is: { headline: 'Human serum', body: 'Reviewed copy.' },
      why_it_stands_out: [{ headline: 'X', body: 'human-written specific claim' }],
      best_for: [{ tag: 'dryness', label: 'dryness' }],
      freshness: { source_version: 'pilot_selected:strict_human_reviewed' },
    },
    freshness: { source_version: 'pilot_selected:strict_human_reviewed' },
    provenance: { source: 'strict_human' },
  };
}

describe('tiered product-intel gate (human | grounded | reject)', () => {
  test('a fully-grounded bundle resolves to grounded + servable', () => {
    const b = groundedBundle();
    expect(isGroundedProductIntelBundle(b)).toBe(true);
    expect(resolveProductIntelTier(b)).toBe('grounded');
    expect(isServableProductIntelBundle(b)).toBe(true);
    // grounded must NOT be mislabeled as human-reviewed
    expect(isHumanReviewedProductIntelBundle(b)).toBe(false);
  });

  test('human-reviewed bundle still resolves to human (unchanged)', () => {
    const b = humanBundle();
    expect(resolveProductIntelTier(b)).toBe('human');
    expect(isServableProductIntelBundle(b)).toBe(true);
    expect(isGroundedProductIntelBundle(b)).toBe(false);
  });

  test('failing ANY one grounding predicate drops to reject (Tier-L blocked)', () => {
    const mutators = {
      'wrong tier': (b) => { b.provenance.tier = 'llm'; b.provenance.review_tier = 'llm'; },
      'reviewer_kind not automated_grounded': (b) => { b.provenance.reviewer_kind = 'assistant'; },
      'review_status not completed': (b) => { b.provenance.review_status = 'pending'; },
      'review_decision not grounded_pass': (b) => { b.provenance.review_decision = 'pass'; },
      'inci not verified': (b) => { b.provenance.grounding.inci_verified = false; },
      'no citations': (b) => { b.provenance.grounding.citations_present = false; },
      'claim safety not screened': (b) => { b.provenance.grounding.claim_safety = 'unscreened'; },
      'grounding missing': (b) => { delete b.provenance.grounding; },
      'no evidence_claims': (b) => { b.product_intel_core.evidence_claims = []; },
      'no provenance': (b) => { delete b.provenance; },
    };
    for (const [label, mutate] of Object.entries(mutators)) {
      const b = groundedBundle();
      mutate(b);
      expect(`${label}: ${isGroundedProductIntelBundle(b)}`).toBe(`${label}: false`);
      expect(resolveProductIntelTier(b)).toBe('reject');
      expect(isServableProductIntelBundle(b)).toBe(false);
    }
  });

  test('grounded bundle passes the public serving gate (requireReviewed)', () => {
    const normalized = normalizePublishedProductIntelBundle(groundedBundle(), { requireReviewed: true });
    expect(normalized).not.toBeNull();
    expect(normalized.evidence_profile).toBe('grounded_verified');
  });

  test('a Tier-L (ungrounded) bundle is rejected by the serving gate', () => {
    const b = groundedBundle();
    b.provenance.tier = 'llm';
    b.provenance.review_tier = 'llm';
    b.provenance.review_decision = 'draft';
    expect(normalizePublishedProductIntelBundle(b, { requireReviewed: true })).toBeNull();
  });
});

describe('produce → gate (real generator output is servable)', () => {
  function entry(slug, grade, o) {
    return {
      status: 'ready',
      source_meta: { tier: 'grounded', seed_slug: slug },
      ingredient_profile_json: {
        status: 'ready',
        ingredient: { display_name: o.name, inci: o.name, marketing_vs_reality: o.mvr || [] },
        benefits: o.benefits || [],
        safety: { watchouts: o.watchouts || [] },
        usage: { routine_step: 'treatment', pair_well: o.pair || [] },
        evidence: { grade, citations: o.cites || [] },
      },
    };
  }
  const FAKE = {
    niacinamide: entry('niacinamide', 'A', {
      name: 'Niacinamide',
      mvr: [{ claim_in_market: "niacinamide 'shrinks pores'", reality: 'it refines the look of pores by normalizing sebum' }],
      benefits: [
        { concern: 'uneven tone', strength: 3, what_it_means: 'evens the look of tone', mechanism: 'limits melanosome transfer' },
        { concern: 'barrier support', strength: 2, what_it_means: 'supports the barrier', mechanism: 'boosts ceramide synthesis' },
      ],
      watchouts: [{ issue: 'Niacin allergy (rare)', what_to_do: 'patch test' }],
      cites: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/16766489/' }],
    }),
    'centella asiatica extract': entry('centella', 'C', {
      name: 'Centella asiatica',
      benefits: [{ concern: 'barrier support', strength: 2, what_it_means: 'looks calmer', mechanism: 'triterpene saponins support barrier proteins' }],
      cites: [{ url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9983323/' }],
    }),
  };
  const kbLookup = async (term) => FAKE[term] || null;

  test('generator output passes isGrounded + the serving gate; emits canonical claim atoms', async () => {
    const bundle = await buildGroundedProductIntelBundle(
      { role_label: 'Test serum', key_ingredients: ['Niacinamide'], inci: 'Niacinamide, Centella Asiatica Extract, Water' },
      { kbLookup, now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    expect(isGroundedProductIntelBundle(bundle)).toBe(true);
    expect(isServableProductIntelBundle(bundle)).toBe(true);
    expect(normalizePublishedProductIntelBundle(bundle, { requireReviewed: true })).not.toBeNull();

    // canonical ProductClaim atoms (joint decision 1) + closed status vocab (decision 2)
    const claims = bundle.product_intel_core.evidence_claims;
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(typeof c.claim_text).toBe('string');
      expect(c.claim_text.length).toBeGreaterThan(0);
      expect(['unverified', 'substantiated', 'flagged', 'rejected']).toContain(c.substantiation_status);
    }
    // honesty claim kind survives (decision 3)
    expect(claims.some((c) => c.source_type === 'marketing_vs_reality')).toBe(true);
    // grounded = observed, not human reviewed (decision 3)
    expect(bundle.product_intel_core.evidence_review_state).toBe('observed');
  });

  test('returns null when no active is KB-grounded (caller falls back untouched)', async () => {
    const bundle = await buildGroundedProductIntelBundle(
      { inci: 'Water, Glycerin, Fragrance' },
      { kbLookup },
    );
    expect(bundle).toBeNull();
  });
});

describe('hydrateProductWithGroundedIntel (flag-gated fallback)', () => {
  const product = { product_id: 'p1', title: 'Cohort serum', inci: 'Niacinamide, Water' };

  test('flag off + no injected generator → no-op', async () => {
    delete process.env.PDP_GROUNDED_PRODUCT_INTEL_ENABLED;
    const out = await hydrateProductWithGroundedIntel({ product });
    expect(out).toEqual(product);
    expect(out.product_intel).toBeUndefined();
  });

  test('injected generator (bypasses flag) → stamps grounded bundle + provenance', async () => {
    const buildGrounded = async () => groundedBundle();
    const out = await hydrateProductWithGroundedIntel({ product, buildGrounded });
    expect(out.product_intel).toBeDefined();
    expect(out.product_intel.provenance.tier).toBe('grounded');
    expect(out.provenance.tier).toBe('grounded');
    expect(isServableProductIntelBundle(out.product_intel)).toBe(true);
  });

  test('does not override an already-servable published bundle (precedence)', async () => {
    const withHuman = { ...product, product_intel: humanBundle() };
    const buildGrounded = jest.fn(async () => groundedBundle());
    const out = await hydrateProductWithGroundedIntel({ product: withHuman, buildGrounded });
    expect(buildGrounded).not.toHaveBeenCalled();
    expect(out.product_intel).toBe(withHuman.product_intel); // unchanged
  });

  test('generator returning a non-grounded bundle is dropped (Tier-L not stamped)', async () => {
    const tierL = groundedBundle();
    tierL.provenance.tier = 'llm';
    tierL.provenance.review_tier = 'llm';
    const buildGrounded = async () => tierL;
    const out = await hydrateProductWithGroundedIntel({ product, buildGrounded });
    expect(out.product_intel).toBeUndefined();
  });

  test('resolves authoritative ingredients into the product handed to the generator', async () => {
    // Real external_seed PDPs carry INCI in ingredients_inci (object), NOT on
    // product.ingredient_intel. hydrate must resolve it via the authoritative
    // view so the generator can see the actives.
    let received = null;
    const buildGrounded = async (p) => { received = p; return groundedBundle(); };
    const src = { product_id: 'p9', title: 'Centella serum', ingredients_inci: { raw_text: 'Water, Niacinamide, Centella Asiatica Extract' } };
    await hydrateProductWithGroundedIntel({ product: src, buildGrounded });
    expect(received).toBeTruthy();
    const items = received.ingredient_intel && received.ingredient_intel.items;
    expect(Array.isArray(items)).toBe(true);
    const joined = items.join(' | ').toLowerCase();
    expect(joined).toContain('niacinamide');
    expect(joined).toContain('centella');
  });
});

describe('batched KB lookup (load fix: one query, not N serial reads)', () => {
  function groundedEntry(slug, name) {
    return {
      status: 'ready',
      source_meta: { tier: 'grounded', seed_slug: slug },
      ingredient_profile_json: {
        status: 'ready',
        ingredient: { display_name: name, inci: name, marketing_vs_reality: [] },
        benefits: [{ concern: 'hydration', strength: 3, what_it_means: 'hydrates', mechanism: 'humectant' }],
        safety: { watchouts: [] },
        usage: { routine_step: 'treatment', pair_well: [] },
        evidence: { grade: 'A', citations: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/0/' }] },
      },
    };
  }
  const KB = { niacinamide: groundedEntry('niacinamide', 'Niacinamide'), 'sodium hyaluronate': groundedEntry('ha', 'Sodium Hyaluronate') };

  test('a long INCI triggers exactly ONE batch lookup (no per-token fan-out)', async () => {
    const longInci = 'Water, Niacinamide, Glycerin, Butylene Glycol, Dimethicone, Phenoxyethanol, Sodium Hyaluronate, Fragrance, Tocopherol, Allantoin, Panthenol, Carbomer, Xanthan Gum, Disodium EDTA, Citric Acid';
    const kbLookupBatch = jest.fn(async (terms) => {
      const m = new Map();
      for (const t of terms) m.set(t, KB[t] || null);
      return m;
    });
    const bundle = await buildGroundedProductIntelBundle({ role_label: 'Serum', inci: longInci }, { kbLookupBatch, now: '2026-06-14' });
    expect(kbLookupBatch).toHaveBeenCalledTimes(1); // ONE round-trip, not ~15
    const terms = kbLookupBatch.mock.calls[0][0];
    expect(Array.isArray(terms)).toBe(true);
    expect(terms.length).toBeGreaterThan(5); // all terms resolved in the single call
    expect(isGroundedProductIntelBundle(bundle)).toBe(true); // still builds correctly
  });

  test('caps the term list (MAX_LOOKUP_TERMS) for pathological INCI', async () => {
    const hugeInci = Array.from({ length: 200 }, (_, i) => `Ingredient ${i}`).join(', ');
    const kbLookupBatch = jest.fn(async () => new Map());
    await buildGroundedProductIntelBundle({ inci: hugeInci }, { kbLookupBatch });
    expect(kbLookupBatch).toHaveBeenCalledTimes(1);
    expect(kbLookupBatch.mock.calls[0][0].length).toBeLessThanOrEqual(64);
  });

  test('back-compat: a single-term opts.kbLookup is still honored', async () => {
    const kbLookup = jest.fn(async (t) => KB[t] || null);
    const bundle = await buildGroundedProductIntelBundle({ inci: 'Niacinamide, Water, Sodium Hyaluronate' }, { kbLookup, now: '2026-06-14' });
    expect(kbLookup).toHaveBeenCalled();
    expect(isGroundedProductIntelBundle(bundle)).toBe(true);
  });
});

describe('ingredient_intel shape (real PDP) feeds the generator', () => {
  test('extractActiveTerms reads ingredient_intel.items + strips parens + adds botanical core/extract', () => {
    const terms = extractActiveTerms({
      ingredient_intel: { items: ['Water', 'Centella Asiatica Leaf Water(389,929ppm)', 'Niacinamide', 'Sodium Hyaluronate'] },
    });
    expect(terms).toContain('niacinamide');
    expect(terms).toContain('sodium hyaluronate');
    // botanical suffix -> core + "<core> extract" so it matches curated KB keys
    expect(terms).toContain('centella asiatica');
    expect(terms).toContain('centella asiatica extract');
    // parenthetical ppm noise is stripped, never queried
    expect(terms.some((t) => /ppm|929/.test(t))).toBe(false);
  });

  test('extractActiveTerms reads ingredient_intel.active_items objects + raw_text', () => {
    const terms = extractActiveTerms({
      ingredient_intel: { active_items: [{ display_name: 'Adenosine' }], raw_text: 'Glycine Soja (Soybean) Seed Extract, Panthenol' },
    });
    expect(terms).toContain('adenosine');
    expect(terms).toContain('panthenol');
    expect(terms).toContain('glycine soja'); // soybean parenthetical dropped, core extracted
  });

  test('a product carrying actives ONLY in ingredient_intel (no top-level inci) now produces grounded intel', async () => {
    // Mirrors a real external_seed PDP: ingredients live in ingredient_intel, and
    // the curated KB is keyed by the active core (e.g. "centella asiatica extract").
    function groundedEntry(slug, name) {
      return {
        status: 'ready',
        source_meta: { tier: 'grounded', seed_slug: slug },
        ingredient_profile_json: {
          status: 'ready',
          ingredient: { display_name: name, inci: name, marketing_vs_reality: [] },
          benefits: [{ concern: 'barrier support', strength: 2, what_it_means: 'supports the barrier', mechanism: 'mechanism' }],
          safety: { watchouts: [] },
          usage: { routine_step: 'treatment', pair_well: [] },
          evidence: { grade: 'A', citations: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/0/' }] },
        },
      };
    }
    const KB = {
      'centella asiatica extract': groundedEntry('centella', 'Centella Asiatica'),
      niacinamide: groundedEntry('niacinamide', 'Niacinamide'),
      'sodium hyaluronate': groundedEntry('ha', 'Sodium Hyaluronate'),
    };
    const kbLookup = jest.fn(async (t) => KB[t] || null);
    const product = {
      title: 'Hyalu-Cica Blue Serum',
      ingredient_intel: { items: ['Water', 'Centella Asiatica Leaf Water(389,929ppm)', 'Niacinamide', 'Sodium Hyaluronate', 'Butylene Glycol'] },
      // deliberately NO top-level inci / key_ingredients
    };
    const bundle = await buildGroundedProductIntelBundle(product, { kbLookup, now: '2026-06-14' });
    expect(bundle).not.toBeNull();
    expect(isGroundedProductIntelBundle(bundle)).toBe(true);
    // the botanical-core candidate ("centella asiatica extract") was queried
    expect(kbLookup.mock.calls.map((c) => c[0])).toContain('centella asiatica extract');
  });
});
