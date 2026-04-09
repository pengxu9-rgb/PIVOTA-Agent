const { buildProductIntelDraftBundle } = require('../src/pdpProductIntel');
const {
  mergeGeminiDraftIntoBaseline,
  evaluateGeminiCandidateQuality,
  buildSelectedBundle,
  applyManualOverrideToSelected,
} = require('../scripts/product_intel_pilot_compare');

describe('product_intel pilot compare selection', () => {
  test('keeps deterministic evidence fields and suppresses fake community output', () => {
    const caseRow = {
      case_id: 'pilot_naturium_dew_glow_spf50',
      canonical_product_ref: {
        merchant_id: 'pilot_naturium',
        product_id: 'pilot_naturium_dew_glow_spf50',
      },
      product: {
        merchant_id: 'pilot_naturium',
        product_id: 'pilot_naturium_dew_glow_spf50',
        brand: 'Naturium',
        title: 'Dew-Glow Moisturizer SPF 50',
        category: 'Skincare/Sunscreen',
        description: 'A glow-leaning daily moisturizer with SPF 50 designed to hydrate and protect with a dewy finish.',
        tags: ['spf', 'daily', 'dewy'],
        texture: 'light cream',
        finish: 'dewy',
        ingredients_inci: ['Zinc Oxide', 'Squalane', 'Glycerin', 'Tocopherol'],
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Daily sunscreen',
          body: 'A glow-forward daily sunscreen designed for hydration and comfortable daytime wear.',
        },
        best_for: [{ tag: 'daytime_use', label: 'Daily UV protection', confidence: 'moderate' }],
        why_it_stands_out: [
          {
            headline: 'Glow-forward finish',
            body: 'Balances daily SPF wear with a dewy finish and moisturizer-style positioning.',
            evidence_strength: 'moderate',
          },
        ],
        routine_fit: {
          step: 'sunscreen',
          am_pm: ['am'],
          pairing_notes: ['Use as the last skincare step before makeup.'],
        },
        watchouts: [{ type: 'spf', label: 'Reapplication still matters for daytime wear.', severity: 'medium' }],
      },
      texture_finish: {
        texture: 'light cream',
        finish: 'dewy',
        sensory_notes: ['Comfortable daily wear'],
        layering_notes: ['Layers best as the last skincare step before makeup.'],
      },
      community_signals: {
        status: 'available',
        top_loves: ['People love the glow'],
        top_complaints: [],
        best_fit_users: [],
        mixed_feedback: [],
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');

    expect(candidate.evidence_profile).toBe(baseline.evidence_profile);
    expect(candidate.quality_state).toBe(baseline.quality_state);
    expect(candidate.source_coverage).toEqual(baseline.source_coverage);
    expect(candidate.community_signals.status).toBe('unavailable');
    expect(candidate.product_intel_core.routine_fit.step).toBe(
      baseline.product_intel_core.routine_fit.step,
    );
  });

  test('falls back to baseline when seller-only gemini copy uses fake community language', () => {
    const caseRow = {
      case_id: 'pilot_tom_ford_noir_de_noir',
      canonical_product_ref: {
        merchant_id: 'pilot_tom_ford',
        product_id: 'pilot_tom_ford_noir_de_noir',
      },
      product: {
        merchant_id: 'pilot_tom_ford',
        product_id: 'pilot_tom_ford_noir_de_noir',
        brand: 'Tom Ford',
        title: 'Noir de Noir Eau de Parfum',
        category: 'Fragrance/Perfume',
        description: 'A warm floral fragrance built around saffron, black rose, truffle, vanilla, patchouli, and oud wood.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Warm floral fragrance',
          body: 'People love this warm floral fragrance for evening wear and social media keeps praising the scent trail.',
        },
        best_for: [{ tag: 'evening', label: 'Evening wear', confidence: 'moderate' }],
        why_it_stands_out: [
          {
            headline: 'Popular signature scent',
            body: 'Users often praise the truffle-rose contrast and luxurious feel.',
            evidence_strength: 'moderate',
          },
        ],
        routine_fit: {
          step: 'fragrance',
          am_pm: ['pm'],
          pairing_notes: ['Spray on pulse points.'],
        },
        watchouts: [],
      },
      texture_finish: null,
      community_signals: {
        status: 'unavailable',
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);
    const selected = buildSelectedBundle(baseline, candidate, quality, 'gemini-test');

    expect(quality.seller_only_violation).toBe(true);
    expect(selected.selected_mode).toBe('baseline_only');
    expect(selected.bundle.product_intel_core.what_it_is.body).toBe(
      baseline.product_intel_core.what_it_is.body,
    );
    expect(selected.field_sources.what_it_is).toBe('baseline');
  });

  test('uses gemini narrative fields when they pass the quality gate', () => {
    const caseRow = {
      case_id: 'pilot_fenty_instant_reset',
      canonical_product_ref: {
        merchant_id: 'pilot_fenty',
        product_id: 'pilot_fenty_instant_reset',
      },
      product: {
        merchant_id: 'pilot_fenty',
        product_id: 'pilot_fenty_instant_reset',
        brand: 'Fenty Skin',
        title: 'Instant Reset Overnight Recovery Gel-Cream',
        category: 'Skincare/Moisturizer',
        description: 'An overnight gel-cream that hydrates, supports the skin barrier, and helps skin feel comfortable by morning.',
        tags: ['overnight', 'hydrating', 'barrier'],
        texture: 'gel-cream',
        finish: 'natural',
        ingredients_inci: ['Niacinamide', 'Hyaluronic Acid', 'Kalahari Melon Oil'],
        how_to_use: 'Apply in the evening after serum as the last skincare step.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Overnight gel-cream moisturizer',
          body: 'An overnight gel-cream moisturizer designed to support hydration and barrier comfort while skin rests.',
        },
        best_for: [
          { tag: 'overnight_hydration', label: 'Overnight hydration support', confidence: 'moderate' },
          { tag: 'barrier_support', label: 'Barrier comfort routines', confidence: 'moderate' },
        ],
        why_it_stands_out: [
          {
            headline: 'Night-focused hydration',
            body: 'Positions itself as an overnight moisturizer with a hydration-first, comfort-led story.',
            evidence_strength: 'moderate',
          },
          {
            headline: 'Barrier-support angle',
            body: 'Leans on barrier support and next-morning comfort rather than aggressive treatment claims.',
            evidence_strength: 'moderate',
          },
        ],
        routine_fit: {
          step: 'moisturizer',
          am_pm: ['pm'],
          pairing_notes: ['Use after serum as the last skincare step at night.'],
        },
        watchouts: [{ type: 'usage', label: 'Best suited to nighttime routines rather than daytime SPF replacement.', severity: 'low' }],
      },
      texture_finish: {
        texture: 'gel-cream',
        finish: 'natural',
        sensory_notes: ['Lightweight cushiony feel'],
        layering_notes: ['Works as the final skincare step in an evening routine.'],
      },
      community_signals: {
        status: 'unavailable',
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);
    const selected = buildSelectedBundle(baseline, candidate, quality, 'gemini-test');

    expect(quality.overall_pass).toBe(true);
    expect(selected.selected_mode).toBe('hybrid_gemini');
    expect(selected.field_sources.what_it_is).toBe('gemini');
    expect(selected.field_sources.best_for).toBe('gemini');
    expect(selected.bundle.product_intel_core.what_it_is.body).toMatch(/overnight gel-cream moisturizer/i);
    expect(selected.bundle.evidence_profile).toBe(baseline.evidence_profile);
  });

  test('rejects seller-only gemini highlights that are just merchandising or pack-size copy', () => {
    const caseRow = {
      case_id: 'pilot_naturium_jumbo',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_13c520e764f9f7d7f23c611b',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_13c520e764f9f7d7f23c611b',
        brand: 'Naturium',
        title: 'Vitamin C Super Serum Plus - Jumbo',
        category: 'Serum',
        description:
          'A multi-benefit serum with vitamin c, retinol, niacinamide, hyaluronic acid and salicylic acid.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A multi-benefit serum designed for uneven tone and texture.',
        },
        best_for: [{ tag: 'uneven_tone', label: 'Uneven tone concerns', confidence: 'moderate' }],
        why_it_stands_out: [
          {
            headline: 'Offered in a jumbo size for extended use.',
            body: 'Offered in a jumbo size for extended use.',
            evidence_strength: 'limited',
          },
        ],
        routine_fit: {
          step: 'serum',
          am_pm: ['am', 'pm'],
          pairing_notes: ['Apply before moisturizer; follow with SPF if used in the morning.'],
        },
        watchouts: [],
      },
      community_signals: {
        status: 'unavailable',
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);

    expect(quality.field_decisions.why_it_stands_out).toBe(false);
    expect(quality.fail_reasons).toContain('weak_highlights');
  });

  test('rejects seller-only gemini highlights that are generic claim or format filler', () => {
    const caseRow = {
      case_id: 'pilot_generic_claims',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_generic_claims',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_generic_claims',
        brand: 'Brand',
        title: 'Daily Brightening Moisturizer',
        category: 'Moisturizer',
        description: 'A daily moisturizer with vitamin C and niacinamide for brighter-looking skin.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Moisturizer',
          body: 'Our multi-benefit moisturizer designed to brighten and hydrate skin every day.',
        },
        best_for: [{ tag: 'dullness', label: 'Dullness concerns', confidence: 'moderate' }],
        why_it_stands_out: [
          {
            headline: 'Designed to provide up to 24 hours of hydration',
            body: 'Designed to provide up to 24 hours of hydration.',
            evidence_strength: 'limited',
          },
          {
            headline: 'Features a lightweight texture for daily use',
            body: 'Features a lightweight texture for daily use.',
            evidence_strength: 'limited',
          },
        ],
        routine_fit: {
          step: 'moisturizer',
          am_pm: ['am', 'pm'],
          pairing_notes: ['Apply after serum.'],
        },
        watchouts: [],
      },
      community_signals: {
        status: 'unavailable',
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);

    expect(quality.field_decisions.what_it_is).toBe(false);
    expect(quality.field_decisions.why_it_stands_out).toBe(false);
    expect(quality.fail_reasons).toContain('weak_what_it_is');
    expect(quality.fail_reasons).toContain('weak_highlights');
  });

  test('rejects seller-only gemini highlights that use positioning or story language instead of product substance', () => {
    const caseRow = {
      case_id: 'pilot_positioning_copy',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_positioning_copy',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_positioning_copy',
        brand: 'Brand',
        title: 'Brightening Serum',
        category: 'Serum',
        description: 'A serum with niacinamide and vitamin C for dullness and uneven tone.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Serum',
          body: 'A brightening serum with niacinamide and vitamin C.',
        },
        best_for: [{ tag: 'dullness', label: 'Dullness concerns', confidence: 'moderate' }],
        why_it_stands_out: [
          {
            headline: 'Brightening positioning',
            body: 'Positions itself as a dedicated treatment step for radiance and tone correction.',
            evidence_strength: 'limited',
          },
        ],
        routine_fit: {
          step: 'serum',
          am_pm: ['am', 'pm'],
          pairing_notes: ['Apply before moisturizer.'],
        },
        watchouts: [],
      },
      community_signals: {
        status: 'unavailable',
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);

    expect(quality.field_decisions.why_it_stands_out).toBe(false);
    expect(quality.fail_reasons).toContain('weak_highlights');
  });

  test('manual override replaces selected narrative fields when a curated rewrite exists', () => {
    const baseline = buildProductIntelDraftBundle({
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_13c520e764f9f7d7f23c611b',
        title: 'Vitamin C Super Serum Plus - Jumbo',
        category: 'Serum',
        description:
          'Double up and save with this jumbo size of our supercharged serum with vitamin c, retinol, hyaluronic acid, niacinamide and salicylic acid.',
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_13c520e764f9f7d7f23c611b',
      },
    });

    const selected = buildSelectedBundle(
      baseline,
      null,
      {
        candidate_available: false,
        overall_pass: false,
        quality_score: 0,
        fail_reasons: ['missing_candidate'],
        field_decisions: {},
      },
      'gemini-test',
    );

    const overridden = applyManualOverrideToSelected(selected, {
      notes: 'curated rewrite',
      product_intel_core: {
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A multi-active treatment serum for tone, texture, and early fine-line support.',
        },
        why_it_stands_out: [
          {
            headline: 'Multi-active formula',
            body: 'Brings together vitamin C, retinol, niacinamide, hyaluronic acid, and salicylic acid in one step.',
          },
        ],
      },
    });

    expect(overridden.selected_mode).toBe('manual_override');
    expect(overridden.field_sources.what_it_is).toBe('manual');
    expect(overridden.field_sources.why_it_stands_out).toBe('manual');
    expect(overridden.bundle.product_intel_core.what_it_is.body).toMatch(/multi-active treatment serum/i);
    expect(overridden.bundle.provenance.generator).toBe('curated_override');
  });
});
