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
      { role_label: 'Test serum', key_ingredients: ['Niacinamide'], inci: 'Niacinamide, Centella Asiatica Extract, Glycerin, Water, Butylene Glycol, Phenoxyethanol' },
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
    // >=5 INCI tokens (clears the hygiene gate) with niacinamide as a top-third hero.
    const bundle = await buildGroundedProductIntelBundle({ inci: 'Water, Niacinamide, Glycerin, Sodium Hyaluronate, Butylene Glycol, Phenoxyethanol' }, { kbLookup, now: '2026-06-14' });
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

describe('hardening: concentration gate, single-active provenance, hygiene', () => {
  function entry(slug, grade, o) {
    return {
      status: 'ready',
      source_meta: { tier: 'grounded', seed_slug: slug },
      ingredient_profile_json: {
        status: 'ready',
        ingredient: { display_name: o.name, inci: o.name, marketing_vs_reality: o.mvr || [] },
        benefits: o.benefits || [{ concern: 'barrier support', strength: 2, what_it_means: 'supports the barrier', mechanism: 'mechanism' }],
        safety: { watchouts: [] },
        usage: { routine_step: 'treatment', pair_well: [] },
        evidence: { grade, citations: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/0/' }] },
      },
    };
  }
  const KB = {
    niacinamide: entry('niacinamide', 'A', { name: 'Niacinamide', benefits: [{ concern: 'barrier support', strength: 3, what_it_means: 'supports the barrier', mechanism: 'boosts ceramide synthesis' }] }),
    panthenol: entry('panthenol', 'B', { name: 'Panthenol', benefits: [{ concern: 'barrier support', strength: 2, what_it_means: 'soothes and supports the barrier', mechanism: 'provitamin b5 humectant' }] }),
    'sodium hyaluronate': entry('ha', 'A', { name: 'Sodium Hyaluronate', benefits: [{ concern: 'hydration', strength: 3, what_it_means: 'hydrates', mechanism: 'humectant' }] }),
  };
  const kb = (KBoverride) => async (t) => (KBoverride || KB)[t] || null;

  test('trace-only grounded match (bottom of INCI) is NOT served', async () => {
    // HA appears only at the very end of a 10-ingredient INCI → trace → no hero.
    const bundle = await buildGroundedProductIntelBundle(
      { inci: 'Water, Glycerin, Butylene Glycol, Dimethicone, Fragrance, Phenoxyethanol, Carbomer, Xanthan Gum, Disodium EDTA, Sodium Hyaluronate' },
      { kbLookup: kb(), now: '2026-06-14' },
    );
    expect(bundle).toBeNull();
  });

  test('brand-declared key ingredient that is TRACE in the INCI is NOT featured (declared does not bypass the gate)', async () => {
    // Brand markets HA as a "key ingredient", but it sits dead last in a
    // 10-item INCI → trace. Niacinamide is #2 (real hero). HA must be excluded.
    const bundle = await buildGroundedProductIntelBundle(
      {
        key_ingredients: ['Hyaluronic Acid', 'Niacinamide'],
        inci: 'Water, Niacinamide, Glycerin, Butylene Glycol, Dimethicone, Fragrance, Phenoxyethanol, Carbomer, Xanthan Gum, Sodium Hyaluronate',
      },
      { kbLookup: kb(), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull(); // niacinamide #2 is a legit hero
    const featured = bundle.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase());
    expect(featured.some((h) => /niacinamide/.test(h))).toBe(true);
    expect(featured.some((h) => /hyaluron/.test(h))).toBe(false); // declared but trace → dropped
  });

  test('high ppm overrides late position (active served as hero via concentration)', async () => {
    const bundle = await buildGroundedProductIntelBundle(
      { ingredient_intel: { items: ['Water', 'Glycerin', 'Butylene Glycol', 'Dimethicone', 'Fragrance', 'Phenoxyethanol', 'Carbomer', 'Xanthan Gum', 'Disodium EDTA', 'Sodium Hyaluronate(8000ppm)'] } },
      { kbLookup: kb(), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    expect(isGroundedProductIntelBundle(bundle)).toBe(true);
  });

  test('each evidence_claim binds to a SINGLE active — no cross-active splicing', async () => {
    // Both declared as actives → both heroes; both claim "barrier support".
    const bundle = await buildGroundedProductIntelBundle(
      { key_ingredients: ['Niacinamide', 'Panthenol'], inci: 'Water, Niacinamide, Panthenol, Glycerin, Phenoxyethanol, Butylene Glycol' },
      { kbLookup: kb(), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    const claims = bundle.product_intel_core.evidence_claims;
    // no source_ref lists multiple actives (the "Panthenol, Adenosine" splice bug)
    for (const c of claims) {
      expect(String(c.source_ref || '')).not.toMatch(/,/);
      if (Array.isArray(c.drivers)) expect(c.drivers.length).toBeLessThanOrEqual(1);
    }
    // both actives' barrier-support claims survive as separate, single-attributed claims
    const barrier = claims.filter((c) => /barrier/i.test(c.claim_text || c.concern || ''));
    const refs = new Set(barrier.map((c) => c.source_ref));
    expect(refs.has('Niacinamide')).toBe(true);
    expect(refs.has('Panthenol')).toBe(true);
  });

  test('headline is neutral — no unverifiable "[active] forward" claim', async () => {
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Glow Serum', inci: 'Water, Niacinamide, Glycerin, Panthenol, Phenoxyethanol' },
      { kbLookup: kb(), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    const headline = bundle.product_intel_core.what_it_is.headline;
    expect(headline).not.toMatch(/forward/i);
    expect(headline).toContain('Glow Serum'); // uses the real product name
  });

  test('too-short / truncated INCI is NOT served — even with brand-declared actives (no declared bypass)', async () => {
    const short = await buildGroundedProductIntelBundle({ inci: 'Niacinamide, Mineral Salts, Aloe' }, { kbLookup: kb(), now: '2026-06-14' });
    expect(short).toBeNull();
    // brand declaring the active no longer rescues a 3-token extraction (the
    // loophole that let a truncated record carry a clinical claim is closed)
    const declared = await buildGroundedProductIntelBundle({ key_ingredients: ['Niacinamide'], inci: 'Niacinamide, Mineral Salts, Aloe' }, { kbLookup: kb(), now: '2026-06-14' });
    expect(declared).toBeNull();
    // a real-length INCI with the same active IS served
    const full = await buildGroundedProductIntelBundle({ inci: 'Water, Niacinamide, Glycerin, Butylene Glycol, Panthenol, Phenoxyethanol' }, { kbLookup: kb(), now: '2026-06-14' });
    expect(full).not.toBeNull();
    expect(isGroundedProductIntelBundle(full)).toBe(true);
  });

  test('long bodies are clipped at a word boundary (never mid-word)', async () => {
    const longMech = 'this is a deliberately long mechanism description that keeps going and going well past the truncation limit so that the clip helper must cut it and it should end cleanly at a word boundary with an ellipsis rather than slicing a word in half abruptly midway through some token here'.repeat(2);
    const localKB = { niacinamide: entry('niacinamide', 'A', { name: 'Niacinamide', benefits: [{ concern: 'uneven tone', strength: 3, what_it_means: longMech, mechanism: longMech }] }) };
    const bundle = await buildGroundedProductIntelBundle({ inci: 'Water, Niacinamide, Glycerin, Panthenol, Phenoxyethanol' }, { kbLookup: kb(localKB), now: '2026-06-14' });
    expect(bundle).not.toBeNull();
    const bodies = bundle.product_intel_core.why_it_stands_out.map((w) => w.body).filter((b) => b && b.length >= 50);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      // clipped bodies carry a trailing ellipsis (old code did a bare mid-word slice with none)
      expect(b.endsWith('…')).toBe(true);
      expect(b.length).toBeLessThanOrEqual(305);
      // the word-boundary clip leaves a complete word before the ellipsis, not a dangling fragment+space
      expect(b).not.toMatch(/\s…$/);
    }
  });
});

// ADR-002 — low-dose actives (retinoids, adenosine, peptides, soy isoflavones)
// are efficacious far below the generic 0.1% / top-third hero bar, so INCI
// position under-features them. A curated efficacy floor (ingredient_profile_json
// .efficacy.low_dose_active / .min_efficacious_ppm) lowers the hero bar for the
// FLAGGED active only — non-flagged trace dustings stay excluded.
describe('low-dose-active efficacy floor (hero despite low INCI position)', () => {
  function entry(slug, grade, o) {
    return {
      status: 'ready',
      source_meta: { tier: 'grounded', seed_slug: slug },
      ingredient_profile_json: {
        status: 'ready',
        ingredient: { display_name: o.name, inci: o.name, marketing_vs_reality: o.mvr || [] },
        benefits: o.benefits || [{ concern: 'firmness / elasticity', strength: 2, what_it_means: 'helps skin look firmer over weeks', mechanism: 'up-regulates procollagen' }],
        safety: { watchouts: [] },
        usage: { routine_step: 'treatment', pair_well: [] },
        evidence: { grade, citations: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/0/' }] },
        ...(o.efficacy !== undefined ? { efficacy: o.efficacy } : {}),
      },
    };
  }
  const kb = (KB) => async (t) => KB[t] || null;
  // Aruen "Tofu Collagen"-shaped INCI: soy isoflavones (Glycine Soja Seed Extract)
  // sits at #11 of 14 → trace by generic position, but the real firming driver.
  const ARUEN_INCI =
    'Water, Niacinamide, Glycerin, Butylene Glycol, Dimethicone, Caprylic/Capric Triglyceride, Cetearyl Alcohol, Panthenol, Carbomer, Phenoxyethanol, Glycine Soja (Soybean) Seed Extract, Tocopherol, Disodium EDTA, Fragrance';
  // KB keyed under the DISCRIMINATING candidate ("glycine soja seed extract") — the
  // shipped alias set excludes bare "glycine soja" so soybean OIL can't borrow it.
  const soyKB = (efficacy) => ({ 'glycine soja seed extract': entry('genistein_soy_isoflavones', 'B', { name: 'Soy isoflavones (genistein / daidzein)', efficacy }) });

  test('a flagged low-dose active low in the INCI now heroes (was trace)', async () => {
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Tofu Collagen Dual-Firming Jelly Cream', inci: ARUEN_INCI },
      { kbLookup: kb(soyKB({ low_dose_active: true })), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    expect(isGroundedProductIntelBundle(bundle)).toBe(true);
    const featured = bundle.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase());
    expect(featured.some((h) => /soy|genistein|isoflav/.test(h))).toBe(true);
  });

  test('the SAME active WITHOUT the flag stays trace → not served (control)', async () => {
    // Identical product + KB but no efficacy block → soy is trace → no hero.
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Tofu Collagen Dual-Firming Jelly Cream', inci: ARUEN_INCI },
      { kbLookup: kb(soyKB(undefined)), now: '2026-06-14' },
    );
    expect(bundle).toBeNull();
  });

  test('a non-low-dose trace active stays excluded even when the bundle IS served', async () => {
    // Niacinamide (#2) is a real hero; soy (#11, NOT flagged) must NOT be featured.
    const KB = {
      niacinamide: entry('niacinamide', 'A', { name: 'Niacinamide', benefits: [{ concern: 'uneven tone', strength: 3, what_it_means: 'evens the look of tone', mechanism: 'limits melanosome transfer' }] }),
      'glycine soja seed extract': entry('genistein_soy_isoflavones', 'B', { name: 'Soy isoflavones (genistein / daidzein)' }), // no efficacy flag
    };
    const bundle = await buildGroundedProductIntelBundle({ title: 'Brightening Cream', inci: ARUEN_INCI }, { kbLookup: kb(KB), now: '2026-06-14' });
    expect(bundle).not.toBeNull();
    const featured = bundle.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase());
    expect(featured.some((h) => /niacinamide/.test(h))).toBe(true);
    expect(featured.some((h) => /soy|genistein|isoflav/.test(h))).toBe(false); // trace, not flagged → dropped
  });

  test('a flagged low-dose active that is BOTH declared and INCI-positioned still heroes (declaration must not demote the position)', async () => {
    // Regression: candidate-presence keeps every signal so the hero-worthy INCI
    // position is chosen under the efficacy lens — a brand declaration (which alone
    // maxes at supportive) must never hide it.
    const KB = soyKB({ low_dose_active: true });
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Tofu Collagen', key_ingredients: ['Glycine Soja Seed Extract'], inci: ARUEN_INCI },
      { kbLookup: kb(KB), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    const featured = bundle.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase());
    expect(featured.some((h) => /soy|genistein|isoflav/.test(h))).toBe(true);
  });

  test('soybean OIL does not borrow the isoflavone entry (discriminating alias prevents mis-attribution)', async () => {
    // Glycine Soja Oil is a bland emollient with negligible isoflavones. The KB is
    // keyed only under the seed-extract form, so the oil's form-word-stripped
    // candidate ("glycine soja") must NOT match → no firming claim attached to oil.
    const KB = soyKB({ low_dose_active: true });
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Soybean Oil Balm', inci: 'Water, Glycerin, Butylene Glycol, Glycine Soja Oil, Phenoxyethanol, Tocopherol' },
      { kbLookup: kb(KB), now: '2026-06-14' },
    );
    expect(bundle).toBeNull();
  });

  test('declared / active_items do not bypass even WITH the flag (needs a real INCI position or ppm)', async () => {
    // Soy is declared as a key ingredient + auto-detected active, but is NOT in
    // the ordered INCI → only a position-less supportive signal. The flag relaxes
    // POSITION/ppm; it does not promote a bare declaration to hero.
    const bundle = await buildGroundedProductIntelBundle(
      {
        key_ingredients: ['Soy isoflavones'],
        ingredient_intel: { active_items: [{ display_name: 'Soy isoflavones' }] },
        inci: 'Water, Glycerin, Butylene Glycol, Dimethicone, Phenoxyethanol, Tocopherol',
      },
      { kbLookup: kb({ 'soy isoflavones': entry('genistein_soy_isoflavones', 'B', { name: 'Soy isoflavones', efficacy: { low_dose_active: true } }) }), now: '2026-06-14' },
    );
    expect(bundle).toBeNull(); // supportive only → no hero → not served
  });

  test('disclosed ppm: low-dose active heroes at >= min_efficacious_ppm, below the floor → not served', async () => {
    const adKB = { adenosine: entry('adenosine', 'B', { name: 'Adenosine', efficacy: { low_dose_active: true, min_efficacious_ppm: 400 } }) };
    const tailInci = (ppm) => `Water, Glycerin, Butylene Glycol, Dimethicone, Phenoxyethanol, Carbomer, Xanthan Gum, Disodium EDTA, Fragrance, Adenosine(${ppm}ppm)`;
    // 0.05% (500ppm) >= 400ppm floor → hero even dead-last by position
    const hero = await buildGroundedProductIntelBundle({ inci: tailInci(500) }, { kbLookup: kb(adKB), now: '2026-06-14' });
    expect(hero).not.toBeNull();
    expect(hero.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase()).some((h) => /adenosine/.test(h))).toBe(true);
    // 0.015% (150ppm) is below the 400ppm floor → sub-efficacious dusting → not served
    const sub = await buildGroundedProductIntelBundle({ inci: tailInci(150) }, { kbLookup: kb(adKB), now: '2026-06-14' });
    expect(sub).toBeNull();
  });
});

describe('presenceTier / readEfficacy unit (efficacy floor)', () => {
  const { presenceTier, readEfficacy } = require('../src/groundedProductIntel')._internal;
  const lowDose = { lowDoseActive: true };

  test('position: a late active is trace by default but heroes when flagged low-dose', () => {
    expect(presenceTier({ index: 10, total: 14 })).toBe('trace'); // frac .714 — generic bar
    expect(presenceTier({ index: 10, total: 14 }, lowDose)).toBe('hero');
  });

  test('low-dose still excludes the deep INCI tail (below the bottom quartile)', () => {
    expect(presenceTier({ index: 13, total: 14 }, lowDose)).toBe('trace'); // frac .93 > .75
  });

  test('ppm: normal active needs 0.1%; min_efficacious_ppm lowers the hero bar', () => {
    expect(presenceTier({ ppm: 500 })).toBe('supportive'); // <1000ppm generic
    expect(presenceTier({ ppm: 500 }, { lowDoseActive: true, minEfficaciousPpm: 400 })).toBe('hero');
    expect(presenceTier({ ppm: 250 }, { lowDoseActive: true, minEfficaciousPpm: 400 })).toBe('supportive'); // [200,400)
    expect(presenceTier({ ppm: 150 }, { lowDoseActive: true, minEfficaciousPpm: 400 })).toBe('trace'); // <200
  });

  test('ppm bar and position bar are decoupled: min_efficacious_ppm alone does NOT relax position', () => {
    const ppmOnly = { lowDoseActive: false, minEfficaciousPpm: 400 };
    expect(presenceTier({ ppm: 500 }, ppmOnly)).toBe('hero'); // ppm bar relaxed
    expect(presenceTier({ index: 7, total: 14 }, ppmOnly)).toBe('supportive'); // position bar NOT relaxed (generic)
    expect(presenceTier({ index: 7, total: 14 }, { lowDoseActive: true })).toBe('hero'); // flag relaxes position
  });

  test('readEfficacy: decoupled levers + sanity-floored ppm', () => {
    expect(readEfficacy({ efficacy: { low_dose_active: true } })).toEqual({ lowDoseActive: true, minEfficaciousPpm: null });
    // min_efficacious_ppm alone marks the ppm bar but NOT low_dose_active (decoupled)
    expect(readEfficacy({ efficacy: { min_efficacious_ppm: 400 } })).toEqual({ lowDoseActive: false, minEfficaciousPpm: 400 });
    expect(readEfficacy({ efficacy: { low_dose_active: true, min_efficacious_ppm: 400 } })).toEqual({ lowDoseActive: true, minEfficaciousPpm: 400 });
    expect(readEfficacy({ efficacy: { min_efficacious_ppm: '400' } })).toEqual({ lowDoseActive: false, minEfficaciousPpm: 400 }); // numeric string coerced
    expect(readEfficacy({ efficacy: { min_efficacious_ppm: 5 } })).toBeNull(); // below sanity floor (typo guard)
    expect(readEfficacy({ efficacy: { min_efficacious_ppm: 0 } })).toBeNull();
    expect(readEfficacy({ efficacy: { min_efficacious_ppm: -1 } })).toBeNull();
    expect(readEfficacy({})).toBeNull();
    expect(readEfficacy(null)).toBeNull();
  });
});

// ADR-002 — FORM-AWARE candidate guard (FTC mis-attribution, defense-in-depth).
// addTermVariants strips INCI form-words to a botanical core so suffixed names
// resolve to curated KB keys. That strip is FORM-AWARE: an INERT form (oil / butter
// / wax / sterols / protein / lecithin) is the lipid/bulk fraction and carries
// negligible of the genus's signaling actives, so it must NOT reduce to the bare
// genus and borrow an active-bearing KB entry. "Glycine Soja Oil" (a bland
// emollient) must never inherit the soy-isoflavone FIRMING claim that "Glycine Soja
// Seed Extract" legitimately earns.
//
// The pre-existing DATA-LAYER guard (KB keyed under the discriminating seed-extract
// alias, never bare "glycine soja" — see the _alias_note in pivota-backend
// ingredient_kb seeds) still holds. These tests add a RUNTIME guard so the safety
// no longer lives ONLY in curation discipline: they key the isoflavone entry under
// the BARE genus (the future-backfill trap the alias note warns against) and prove
// the oil still cannot borrow it.
describe('form-aware candidate guard (inert forms cannot borrow active-bearing KB entries)', () => {
  const { extractActiveTerms } = require('../src/groundedProductIntel');
  function entry(slug, grade, o) {
    return {
      status: 'ready',
      source_meta: { tier: 'grounded', seed_slug: slug },
      ingredient_profile_json: {
        status: 'ready',
        ingredient: { display_name: o.name, inci: o.name, marketing_vs_reality: o.mvr || [] },
        benefits: o.benefits || [{ concern: 'firmness / elasticity', strength: 2, what_it_means: 'helps skin look firmer over weeks', mechanism: 'up-regulates procollagen' }],
        safety: { watchouts: [] },
        usage: { routine_step: 'treatment', pair_well: [] },
        evidence: { grade, citations: [{ url: 'https://pubmed.ncbi.nlm.nih.gov/0/' }] },
        ...(o.efficacy !== undefined ? { efficacy: o.efficacy } : {}),
      },
    };
  }
  const kb = (KB) => async (t) => KB[t] || null;
  // Aruen "Tofu Collagen"-shaped INCI: soy isoflavones (seed extract) at #11 of 14.
  const ARUEN_INCI =
    'Water, Niacinamide, Glycerin, Butylene Glycol, Dimethicone, Caprylic/Capric Triglyceride, Cetearyl Alcohol, Panthenol, Carbomer, Phenoxyethanol, Glycine Soja (Soybean) Seed Extract, Tocopherol, Disodium EDTA, Fragrance';
  const SOYBEAN_OIL_INCI = 'Water, Glycerin, Butylene Glycol, Glycine Soja Oil, Phenoxyethanol, Tocopherol';

  // --- candidate-generation unit (the core of the fix) ---
  test('active-bearing form (seed extract) still reduces to the genus core', () => {
    const terms = extractActiveTerms({ ingredient_intel: { items: ['Water', 'Glycine Soja (Soybean) Seed Extract', 'Glycerin'] } });
    expect(terms).toContain('glycine soja seed extract'); // full form
    expect(terms).toContain('glycine soja'); // bare genus — resolves the curated soy entry
    expect(terms).toContain('glycine soja extract');
  });

  test('inert form (oil) keeps ONLY its full token — no bare genus, no synthesized extract', () => {
    const terms = extractActiveTerms({ ingredient_intel: { items: ['Water', 'Glycine Soja Oil', 'Glycerin'] } });
    expect(terms).toContain('glycine soja oil'); // a deliberately oil-keyed entry can still match
    expect(terms).not.toContain('glycine soja'); // <-- the guard: oil never reduces to the genus
    expect(terms).not.toContain('glycine soja extract');
  });

  test('inert form wins even when a botanical source word precedes it (seed OIL is still oil)', () => {
    const terms = extractActiveTerms({ ingredient_intel: { items: ['Water', 'Helianthus Annuus Seed Oil', 'Glycerin'] } });
    expect(terms).toContain('helianthus annuus seed oil');
    expect(terms).not.toContain('helianthus annuus');
    expect(terms).not.toContain('helianthus annuus extract');
  });

  test('butter (another inert form) gets the same treatment', () => {
    const terms = extractActiveTerms({ ingredient_intel: { items: ['Water', 'Butyrospermum Parkii (Shea) Butter', 'Glycerin'] } });
    expect(terms).toContain('butyrospermum parkii butter');
    expect(terms).not.toContain('butyrospermum parkii');
    expect(terms).not.toContain('butyrospermum parkii extract');
  });

  // --- end-to-end: the FUTURE-BACKFILL TRAP (entry mis-keyed under bare genus) ---
  const BARE_GENUS_KB = { 'glycine soja': entry('genistein_soy_isoflavones', 'B', { name: 'Soy isoflavones (genistein / daidzein)', efficacy: { low_dose_active: true } }) };

  test('seed extract STILL heroes when the entry is keyed under bare genus (legitimate match preserved)', async () => {
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Tofu Collagen Dual-Firming Jelly Cream', inci: ARUEN_INCI },
      { kbLookup: kb(BARE_GENUS_KB), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    const featured = bundle.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase());
    expect(featured.some((h) => /soy|genistein|isoflav/.test(h))).toBe(true);
  });

  test('soybean OIL does NOT borrow the bare-genus isoflavone entry (runtime defense-in-depth)', async () => {
    // Even with the entry mis-keyed under bare "glycine soja" (the curation trap the
    // data-layer alias note warns against), the oil's form-aware candidates never
    // include "glycine soja" → no match → not served. The safety holds at runtime
    // regardless of how the KB is keyed.
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Soybean Oil Balm', inci: SOYBEAN_OIL_INCI },
      { kbLookup: kb(BARE_GENUS_KB), now: '2026-06-14' },
    );
    expect(bundle).toBeNull();
  });

  test('oil also cannot borrow an entry mis-keyed under the synthesized "<genus> extract" form', async () => {
    // addTermVariants used to synthesize a "glycine soja extract" candidate for the
    // oil too; form-awareness drops it, so a generic-extract-keyed entry is unreachable.
    const EXTRACT_KEYED_KB = { 'glycine soja extract': entry('genistein_soy_isoflavones', 'B', { name: 'Soy isoflavones (genistein / daidzein)', efficacy: { low_dose_active: true } }) };
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Soybean Oil Balm', inci: SOYBEAN_OIL_INCI },
      { kbLookup: kb(EXTRACT_KEYED_KB), now: '2026-06-14' },
    );
    expect(bundle).toBeNull();
  });

  test('form-aware ≠ blanket block: an entry deliberately keyed under the exact inert form still matches the oil', async () => {
    // Glycine Soja Oil sits at #4 of 6 (top half). An emollient entry KEYED under the
    // exact inert form ("glycine soja oil") is reachable via the full-token candidate,
    // so legitimate oil intel is not lost — only the genus-core borrow is suppressed.
    const OIL_KEYED_KB = {
      'glycine soja oil': entry('glycine_soja_oil', 'B', {
        name: 'Soybean Oil',
        efficacy: { low_dose_active: true }, // relax position so #4/6 heroes
        benefits: [{ concern: 'dryness', strength: 2, what_it_means: 'softens and conditions the skin surface', mechanism: 'occlusive emollient lipids reduce water loss' }],
      }),
    };
    const bundle = await buildGroundedProductIntelBundle(
      { title: 'Soybean Oil Balm', inci: SOYBEAN_OIL_INCI },
      { kbLookup: kb(OIL_KEYED_KB), now: '2026-06-14' },
    );
    expect(bundle).not.toBeNull();
    const featured = bundle.product_intel_core.why_it_stands_out.map((w) => w.headline.toLowerCase());
    expect(featured.some((h) => /soy|oil/.test(h))).toBe(true);
    // and it is NOT carrying the isoflavone firming claim (different entry entirely)
    expect(featured.some((h) => /genistein|isoflav|firm/.test(h))).toBe(false);
  });
});
