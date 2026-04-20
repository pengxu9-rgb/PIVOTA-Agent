const { buildProductIntelDraftBundle } = require('../src/pdpProductIntel');
const {
  mergeGeminiDraftIntoBaseline,
  evaluateGeminiCandidateQuality,
  buildSelectedBundle,
  buildFactsPack,
  buildHumanStandardRewriteOutput,
  inferProductKindFromContext,
  applyManualOverrideToSelected,
  buildShoppingCardPayload,
  normalizeGeminiDraftOutput,
} = require('../scripts/product_intel_pilot_compare');

describe('product_intel pilot compare selection', () => {
  test('human-standard rewrite preserves specialty body scrub product type over stale category', () => {
    const caseRow = {
      case_id: 'live_ext_body_scrub',
      product: {
        title: 'KP Bump Eraser Body Scrub 10% AHA Fresh Peach',
        category: 'Sunscreen',
        description: 'A body scrub for rough bumps and body texture.',
        ingredients_inci: ['Glycerin', 'Lactic Acid'],
      },
    };

    expect(inferProductKindFromContext({
      title: caseRow.product.title,
      category: caseRow.product.category,
      tags: [],
    })).toBe('body_scrub');

    const rewrite = buildHumanStandardRewriteOutput(
      caseRow,
      {
        product_intel_core: {
          what_it_is: {
            headline: 'Daily sunscreen',
            body: 'A daily sunscreen for AM UV protection.',
          },
          routine_fit: {
            step: 'sunscreen',
          },
        },
      },
      null,
    );

    expect(rewrite.product_intel_core.what_it_is.headline).toBe('Body exfoliating scrub');
    expect(rewrite.product_intel_core.what_it_is.body).toMatch(/body scrub|body exfoliating scrub/i);
    expect(rewrite.product_intel_core.what_it_is.body).not.toMatch(/sunscreen|moisturizer/i);
    expect(rewrite.product_intel_core.routine_fit.step).toBe('body exfoliation');
    expect(rewrite.product_intel_core.routine_fit.pairing_notes.join(' ')).toMatch(/body areas/i);
    expect(rewrite.product_intel_core.routine_fit.pairing_notes.join(' ')).not.toMatch(/makeup|sunscreen/i);
    expect(rewrite.product_intel_core.watchouts.map((item) => item.type)).not.toContain('spf');
    expect(rewrite.texture_finish.layering_notes.join(' ')).not.toMatch(/makeup|sunscreen/i);

    const baseline = buildProductIntelDraftBundle({
      product: {
        ...caseRow.product,
        product_id: 'ext_body_scrub',
        merchant_id: 'external_seed',
      },
      canonicalProductRef: {
        merchant_id: 'external_seed',
        product_id: 'ext_body_scrub',
      },
    });
    baseline.product_intel_core.routine_fit = {
      step: 'sunscreen',
      am_pm: ['am'],
      pairing_notes: ['Use as the last skincare step before makeup in the daytime.'],
    };
    baseline.product_intel_core.watchouts = [
      {
        type: 'spf',
        label: 'Reapplication still matters for daytime UV protection.',
        severity: 'medium',
      },
    ];
    baseline.texture_finish = {
      texture: '',
      finish: '',
      sensory_notes: [],
      layering_notes: ['Best used as the last skincare step before makeup.'],
    };

    const candidate = mergeGeminiDraftIntoBaseline(
      caseRow,
      baseline,
      rewrite,
      'deterministic-human-standard-rewrite',
    );
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);
    const selected = buildSelectedBundle(
      caseRow,
      baseline,
      candidate,
      quality,
      'deterministic-human-standard-rewrite',
    );

    expect(quality.field_decisions.routine_fit).toBe(true);
    expect(selected.bundle.product_intel_core.routine_fit.step).toBe('body exfoliation');
    expect(selected.bundle.product_intel_core.routine_fit.pairing_notes.join(' ')).not.toMatch(/makeup|sunscreen/i);
    expect(selected.bundle.product_intel_core.watchouts.map((item) => item.type)).not.toContain('spf');
    expect(selected.bundle.texture_finish.layering_notes.join(' ')).not.toMatch(/makeup|sunscreen/i);
  });

  test('human-standard rewrite preserves lip balm subtype instead of generic lip oil copy', () => {
    const caseRow = {
      case_id: 'live_ext_lip_balm',
      product: {
        title: 'Birch Moisturizing Lip Balm',
        category: 'Lip Balm',
        description: 'A moisturizing lip balm for soft-feeling lips.',
        ingredients_inci: ['Glycerin', 'Propanediol'],
      },
    };

    expect(
      inferProductKindFromContext({
        title: caseRow.product.title,
        category: caseRow.product.category,
        tags: [],
      }),
    ).toBe('lip_balm');

    const rewrite = buildHumanStandardRewriteOutput(
      caseRow,
      {
        product_intel_core: {
          what_it_is: {
            headline: 'Glossy lip oil',
            body: 'A lip product focused on glossy shine and fuller-looking lips.',
          },
          routine_fit: {
            step: 'makeup',
            pairing_notes: ['Use as a lip finishing step when shine fades.'],
          },
        },
      },
      null,
    );

    expect(rewrite.product_intel_core.what_it_is.headline).toBe('Lip balm');
    expect(rewrite.product_intel_core.what_it_is.body).toMatch(/lip balm/i);
    expect(rewrite.product_intel_core.what_it_is.body).not.toMatch(/lip oil|glossy/i);
    expect(rewrite.product_intel_core.routine_fit.step).toBe('lip balm');
    expect(rewrite.product_intel_core.routine_fit.pairing_notes.join(' ')).toMatch(/lip balm/i);
  });

  test('drops truncated PDP narrative descriptions from Gemini facts packs', () => {
    const facts = buildFactsPack({
      case_id: 'live_ext_daily_tinted',
      product: {
        title: 'Daily Tinted Fluid Sunscreen DN350',
        category: 'external',
        description:
          'Meet the Tint + SPF You’ll Actually Wear Naturally radiant, this tinted fluid sunscreen feels like ski…',
        source_url: 'https://brand.example/products/daily-tinted-fluid-sunscreen',
        how_to_use: 'Shake well before use.',
        ingredients_inci: ['Zinc Oxide'],
      },
    });

    expect(facts.description).toBe('');
    expect(facts.source_url).toBe('https://brand.example/products/daily-tinted-fluid-sunscreen');
    expect(facts.how_to_use).toBe('Shake well before use.');
    expect(facts.ingredients_inci).toEqual(['Zinc Oxide']);
  });

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
    const selected = buildSelectedBundle(caseRow, baseline, candidate, quality, 'gemini-test');

    expect(quality.seller_only_violation).toBe(true);
    expect(selected.selected_mode).toBe('baseline_only');
    expect(selected.bundle.product_intel_core.what_it_is.body).toBe(
      baseline.product_intel_core.what_it_is.body,
    );
    expect(selected.field_sources.what_it_is).toBe('baseline');
  });

  test('rejects category-incompatible best_for labels for lip products', () => {
    const caseRow = {
      case_id: 'pilot_lip_oil_bad_fit',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_lip_oil_bad_fit',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_lip_oil_bad_fit',
        brand: 'INNBEAUTY PROJECT',
        title: 'Glaze Lip Oil',
        category: 'Lip Oil',
        description: 'A glossy lip oil for shine, softness, and a plumper-looking lip finish.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Glossy lip oil',
          body: 'A glossy lip oil positioned for softness, shine, and fuller-looking lips without a sticky finish.',
        },
        best_for: [{ tag: 'oil_control', label: 'Oily or combination skin', confidence: 'moderate' }],
        why_it_stands_out: [
          {
            headline: 'Lip-oil finish focus',
            body: 'Targets shine, softness, and a fuller-looking lip finish in one lip-oil step.',
            evidence_strength: 'moderate',
          },
        ],
        routine_fit: {
          step: 'lip treatment',
          am_pm: ['am', 'pm'],
          pairing_notes: ['Use as a lip finishing step.'],
        },
        watchouts: [],
      },
      community_signals: {
        status: 'unavailable',
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);

    expect(quality.field_decisions.best_for).toBe(false);
    expect(quality.fail_reasons).toContain('incompatible_best_for');
  });

  test('normalizes long Gemini highlight headlines into complete compact phrases', () => {
    const normalized = normalizeGeminiDraftOutput({
      product_intel_core: {
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A lightweight serum for uneven tone and visible dark spots.',
        },
        best_for: [{ tag: 'uneven_tone', label: 'Uneven tone concerns' }],
        why_it_stands_out: [
          {
            headline:
              'Combines niacinamide and tranexamic acid with a vitamin-rich complex to target hyperpigmentation and support skin radiance.',
            body:
              'Combines niacinamide and tranexamic acid with a vitamin-rich complex to target hyperpigmentation and support skin radiance.',
            evidence_strength: 'limited',
          },
          {
            headline:
              'Combines a Pine Cica Activer complex—featuring pine leaf extract and five centella asiatica compounds—to calm visible redness and irritation during cleansing.',
            body:
              'Combines a Pine Cica Activer complex—featuring pine leaf extract and five centella asiatica compounds—to calm visible redness and irritation during cleansing.',
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
    });

    expect(normalized.product_intel_core.why_it_stands_out.map((item) => item.headline)).toEqual([
      'Combines niacinamide and tranexamic acid with a vitamin-rich complex',
      'Combines a Pine Cica Activer complex',
    ]);
  });

  test('normalizes Gemini body text by removing storefront read-more copy and HTML entities', () => {
    const normalized = normalizeGeminiDraftOutput({
      product_intel_core: {
        what_it_is: {
          headline: 'Prep or toner step',
          body:
            'A hydrating toner that helps balance sebum for skin that&#39;s glowy, not greasy. Read More.',
        },
        best_for: [{ tag: 'oil_control', label: 'Oily or combination skin' }],
        why_it_stands_out: [
          {
            headline: 'Dual-layer toner format',
            body: 'Pairs hydration and oil-balancing cues in one prep step.',
            evidence_strength: 'limited',
          },
        ],
        routine_fit: {
          step: 'toner',
          am_pm: ['am', 'pm'],
          pairing_notes: ['Use after cleansing.'],
        },
        watchouts: [],
      },
      community_signals: {
        status: 'unavailable',
      },
    });

    expect(normalized.product_intel_core.what_it_is.body).toBe(
      "A hydrating toner that helps balance sebum for skin that's glowy, not greasy.",
    );
  });

  test('drops non-text best_for objects instead of serializing object placeholders', () => {
    const normalized = normalizeGeminiDraftOutput({
      product_intel_core: {
        what_it_is: {
          headline: 'Firming cream',
          body: 'A firming face cream for moisturizer routines.',
        },
        best_for: [
          { tag: { nested: true }, label: { nested: true } },
          { tag: 'daily_moisture', label: 'Daily moisture support' },
        ],
        why_it_stands_out: [
          {
            headline: 'Barrier-comfort routine',
            body: 'Pairs moisturizing care with barrier-comfort claims for daily cream routines.',
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
    });

    expect(normalized.product_intel_core.best_for).toEqual([
      { tag: 'daily_moisture', label: 'Daily moisture support', confidence: 'moderate' },
    ]);
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
    const selected = buildSelectedBundle(caseRow, baseline, candidate, quality, 'gemini-test');

    expect(quality.overall_pass).toBe(true);
    expect(selected.selected_mode).toBe('hybrid_gemini');
    expect(selected.field_sources.what_it_is).toBe('gemini');
    expect(selected.field_sources.best_for).toBe('gemini');
    expect(selected.bundle.product_intel_core.what_it_is.body).toMatch(/overnight gel-cream moisturizer/i);
    expect(selected.bundle.evidence_profile).toBe(baseline.evidence_profile);
  });

  test('repairs selected truncated highlight headlines with human-standard rewrite', () => {
    const cases = [
      {
        title: 'Round Lab 1025 Dokdo Cleanser + Dokdo Toner 200ml',
        category: 'Skincare/Cleanser',
        description: 'A cleanser and toner set for daily cleansing and hydration routines.',
        headline: 'Utilizes mineral-rich water sourced from 5,000 feet below sea level, containing 72 types of',
      },
      {
        title: 'INNBEAUTY PROJECT Glaze Lip Oil',
        category: 'Lip Oil',
        description: 'A glossy lip oil for lip shine and comfort.',
        headline: 'Functions as a hybrid lip treatment, delivering the visual finish of a gloss alongside the',
      },
      {
        title: 'INNBEAUTY PROJECT Green Machine Serum',
        category: 'Skincare/Serum',
        description: 'A serum-oil product with vitamin C, tranexamic acid, and niacinamide.',
        headline: 'Combines the fast absorption of a serum with the barrier-nourishing properties of an oil in a',
      },
      {
        title: 'INNBEAUTY PROJECT Green Machine Serum',
        category: 'Skincare/Serum',
        description: 'A serum-oil product with vitamin C, tranexamic acid, and niacinamide.',
        headline: 'Utilizes an oil-jelly architecture that provides both deep serum penetration and oil-based',
      },
      {
        title: 'Fenty Skin Fat Water Niacinamide Pore-Refining Toner Serum',
        category: 'Skincare/Toner',
        description: 'A toner-serum step with niacinamide and Barbados cherry for pore and tone care.',
        headline: 'The 2-in-1 formula combines the balancing properties of a toner with the active potency of a',
      },
      {
        title: 'Round Lab Birch Moisturizing Intensive Cream',
        category: 'Skincare/Moisturizer',
        description:
          'A cushiony cream with birch sap, ectoin, ceramide NP, cholesterol, and fatty acids for dry, weakened skin.',
        headline: 'Utilizes the HYDRO KEEP BARRIER™ system, a blend of ceramide NP, cholesterol, and fatty acids,',
      },
      {
        title: 'Round Lab Vita Niacinamide Dark Spot Serum Mask',
        category: 'Skincare/Sheet Mask',
        description:
          'A brightening sheet mask with niacinamide, sea buckthorn, and vitamin C derivatives for uneven-looking tone.',
        headline: 'Utilizes Triple Vita Activer™, a blend of sea buckthorn and vitamin C derivatives,',
      },
      {
        title: 'Beauty of Joseon Calming Barrier Serum',
        category: 'Skincare/Serum',
        description:
          'A calming serum with green tea water, niacinamide, sodium hyaluronate, panthenol, centella, and ceramide NP.',
        headline:
          'Features Green Tea-HA™, an exclusive complex that delivers antioxidant benefits alongside deep',
      },
    ];

    for (const [index, item] of cases.entries()) {
      const caseRow = {
        case_id: `truncated_highlight_${index}`,
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: `ext_truncated_${index}`,
        },
        product: {
          merchant_id: 'external_seed',
          product_id: `ext_truncated_${index}`,
          brand: item.title.split(' ')[0],
          title: item.title,
          category: item.category,
          description: item.description,
        },
      };
      const baseline = buildProductIntelDraftBundle({
        product: caseRow.product,
        canonicalProductRef: caseRow.canonical_product_ref,
      });
      const candidate = JSON.parse(JSON.stringify(baseline));
      candidate.product_intel_core.why_it_stands_out = [
        {
          headline: item.headline,
          body: `${item.headline} complete explanatory body for the generated highlight.`,
          evidence_strength: 'limited',
        },
      ];
      const quality = {
        candidate_available: true,
        field_decisions: {
          what_it_is: false,
          best_for: false,
          why_it_stands_out: true,
          routine_fit: false,
          watchouts: false,
          texture_finish: false,
          community_signals: false,
        },
      };

      const selected = buildSelectedBundle(caseRow, baseline, candidate, quality, 'gemini-test');
      const selectedHeadline = selected.bundle.product_intel_core.why_it_stands_out[0].headline;

      expect(selected.field_sources.why_it_stands_out).toBe('human_standard');
      expect(selectedHeadline).not.toBe(item.headline);
      expect(selectedHeadline).not.toMatch(/\b(?:a|an|the|and|or|of|in|to|with|for)$/i);
    }
  });

  test('rejects generic Pivota Insights what-it-is headlines from generated candidates', () => {
    const caseRow = {
      case_id: 'generic_pivota_headline',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_generic_pivota_headline',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_generic_pivota_headline',
        brand: 'Beauty of Joseon',
        title: 'Green Plum Refreshing Cleanser',
        category: 'Cleanser',
        description:
          'A pH-balanced gentle daily cleanser with plum and mung bean extracts that deeply cleanses and refreshes while supporting your moisture barrier. Read More.',
        review_summary: {
          rating: 4.9,
          review_count: 2065,
        },
      },
    };
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Pivota Insights',
          body: "A gentle, slightly acidic daily cleanser formulated with 24% plum water and 3% mung bean extract to lift away impurities while protecting the skin's natural moisture barrier.",
        },
        best_for: [
          { tag: 'sensitive_skin', label: 'Sensitive skin', confidence: 'moderate' },
        ],
        why_it_stands_out: [
          {
            headline: 'Low-pH cleansing',
            body: 'Uses a low-pH cleansing profile to avoid the tight feel often caused by harsher foaming cleansers.',
            evidence_strength: 'limited',
          },
        ],
        routine_fit: {
          step: 'cleanser',
          am_pm: ['am', 'pm'],
          pairing_notes: ['Use before treatment and moisturizer steps.'],
        },
        watchouts: [],
      },
      texture_finish: {
        texture: 'gel',
        finish: 'clean',
      },
      community_signals: {
        status: 'available',
        top_loves: ['4.9★ average across 2.1k buyer reviews.'],
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);
    const selected = buildSelectedBundle(caseRow, baseline, candidate, quality, 'gemini-test');

    expect(quality.field_decisions.what_it_is).toBe(false);
    expect(quality.fail_reasons).toContain('generic_what_it_is_headline');
    expect(selected.field_sources.what_it_is).toBe('human_standard');
    expect(selected.bundle.product_intel_core.what_it_is.headline).toBe('Daily cleanser');
    expect(selected.bundle.product_intel_core.what_it_is.body).not.toMatch(/Read More/i);
  });

  test('allows specific generated best-for when community-supported baseline is a weak taxonomy fallback', () => {
    const caseRow = {
      case_id: 'weak_baseline_best_for',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_weak_baseline_best_for',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_weak_baseline_best_for',
        brand: 'Beauty of Joseon',
        title: 'Glow Serum : Propolis + Niacinamide',
        category: 'Serum',
        description:
          'A cushiony smoothing serum with niacinamide and propolis extract that helps refine pores, hydrate, and calm reactive skin for a glassy glow. Read More.',
        review_summary: {
          rating: 4.9,
          review_count: 1575,
        },
      },
    };
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    baseline.product_intel_core.best_for = [
      { tag: 'serum', label: 'Serum shoppers', confidence: 'low' },
    ];
    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Treatment serum',
          body: 'A concentrated serum formulated with 60% propolis extract and 2% niacinamide to manage sebum production and refine the appearance of pores.',
        },
        best_for: [
          {
            tag: 'oil_control',
            label: 'Oily or combination skin types prone to congestion',
            confidence: 'moderate',
          },
          {
            tag: 'redness',
            label: 'Skin experiencing redness or inflammation',
            confidence: 'moderate',
          },
        ],
        why_it_stands_out: [
          {
            headline: 'Propolis and niacinamide blend',
            body: 'Combines propolis extract with niacinamide to address sebum, pore appearance, and visible calm in one serum step.',
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
      texture_finish: {
        texture: 'serum',
        finish: 'dewy',
      },
      community_signals: {
        status: 'available',
        top_loves: ['4.9★ average across 1.6k buyer reviews.'],
      },
    };

    const candidate = mergeGeminiDraftIntoBaseline(caseRow, baseline, geminiOutput, 'gemini-test');
    const quality = evaluateGeminiCandidateQuality(baseline, candidate);
    const selected = buildSelectedBundle(caseRow, baseline, candidate, quality, 'gemini-test');

    expect(baseline.evidence_profile).toBe('community_supported');
    expect(quality.field_decisions.best_for).toBe(true);
    expect(selected.field_sources.best_for).toBe('gemini');
    expect(selected.bundle.product_intel_core.best_for.map((item) => item.label)).toContain(
      'Oily or combination skin types prone to congestion',
    );
  });

  test('repairs selected weak baseline best-for with human-standard output when no generated candidate is usable', () => {
    const caseRow = {
      case_id: 'weak_baseline_best_for_repair',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_weak_baseline_best_for_repair',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_weak_baseline_best_for_repair',
        brand: 'Beauty of Joseon',
        title: 'Glow Serum : Propolis + Niacinamide',
        category: 'Serum',
        description:
          'A cushiony smoothing serum with niacinamide and propolis extract that helps refine pores, hydrate, and calm reactive skin for a glassy glow. Read More.',
      },
    };
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    baseline.product_intel_core.best_for = [
      { tag: 'serum', label: 'Serum shoppers', confidence: 'low' },
    ];

    const selected = buildSelectedBundle(caseRow, baseline, null, null, 'gemini-test');

    expect(selected.field_sources.best_for).toBe('human_standard');
    expect(selected.bundle.product_intel_core.best_for.map((item) => item.label)).toEqual([
      'Oiliness and visible pores',
      'Breakout-prone routines',
    ]);
  });

  test('drops unsafe explicit card copy before rebuilding selected card payloads', () => {
    const caseRow = {
      case_id: 'unsafe_card_copy',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_unsafe_card_copy',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_unsafe_card_copy',
        brand: 'Beauty of Joseon',
        title: 'Day Dew Sunscreen 10ml',
        category: 'Skincare/Sunscreen',
        description: 'A compact sunscreen for daytime skin-care routines.',
      },
    };
    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    baseline.shopping_card = {
      ...(baseline.shopping_card || {}),
      intro: 'Meet our most innovative SPF yet- now in a handy 10ml size.',
      highlight: 'The Dokdo Cleanser is a gentle, s lightly acidic (pH 5.',
    };
    baseline.search_card = {
      ...(baseline.search_card || {}),
      intro_candidate: 'Meet our most innovative SPF yet- now in a handy 10ml size.',
      highlight_candidate: 'The Dokdo Cleanser is a gentle, s lightly acidic (pH 5.',
    };

    const selected = buildSelectedBundle(caseRow, baseline, null, null, 'gemini-test');

    expect(selected.bundle.shopping_card.intro).not.toMatch(/\b(our|we|us)\b|s lightly/i);
    expect(selected.bundle.search_card.intro_candidate).not.toMatch(/\b(our|we|us)\b|s lightly/i);
    expect(selected.bundle.shopping_card.highlight || '').not.toMatch(/\b(our|we|us)\b|s lightly/i);
    expect(selected.bundle.search_card.highlight_candidate || '').not.toMatch(/\b(our|we|us)\b|s lightly/i);
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

  test('rejects malformed Gemini copy with citation and missing-space artifacts', () => {
    const caseRow = {
      case_id: 'pilot_malformed_gemini_copy',
      canonical_product_ref: {
        merchant_id: 'external_seed',
        product_id: 'ext_good_molecules_niacinamide',
      },
      product: {
        merchant_id: 'external_seed',
        product_id: 'ext_good_molecules_niacinamide',
        brand: 'Good Molecules',
        title: 'Niacinamide Serum',
        category: 'Serum',
        description: 'A serum with 10% niacinamide for pores, texture, and uneven tone.',
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });

    const geminiOutput = {
      product_intel_core: {
        what_it_is: {
          headline: 'Pivota Insights',
          body: 'A water-based serum formulated with 10% niacinamide for pores and uneven tone.',
        },
        best_for: [
          {
            tag: 'combinationandoilyskintypesseekingporeandtexturerefinement_1_1',
            label: 'Combinationandoilyskintypesseekingporeandtexturerefinement[1.1].',
            confidence: 'moderate',
          },
        ],
        why_it_stands_out: [
          {
            headline: 'Deliversa10%concentrationofniacinamidetotargetenlargedpores, uneventone, anddullness[1.1].',
            body: 'Deliversa10%concentrationofniacinamidetotargetenlargedpores, uneventone, anddullness[1.1].',
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

    expect(quality.overall_pass).toBe(false);
    expect(quality.problematic_generated_text).toBe(true);
    expect(quality.fail_reasons).toContain('problematic_generated_text');
    expect(quality.field_decisions.best_for).toBe(false);
    expect(quality.field_decisions.why_it_stands_out).toBe(false);
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
      {
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_13c520e764f9f7d7f23c611b',
          brand: 'Naturium',
          title: 'Vitamin C Super Serum Plus - Jumbo',
          category: 'Serum',
          description:
            'Double up and save with this jumbo size of our supercharged serum with vitamin c, retinol, hyaluronic acid, niacinamide and salicylic acid.',
        },
      },
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

    const overridden = applyManualOverrideToSelected(
      {
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_13c520e764f9f7d7f23c611b',
          brand: 'Naturium',
          title: 'Vitamin C Super Serum Plus - Jumbo',
          category: 'Serum',
          description:
            'Double up and save with this jumbo size of our supercharged serum with vitamin c, retinol, hyaluronic acid, niacinamide and salicylic acid.',
        },
      },
      selected,
      {
      notes: 'curated rewrite',
      external_highlight_signals: [
        {
          signal_id: 'creator_1',
          source_type: 'creator_social_consensus',
          claim_type: 'card_hook',
          claim_text: 'Creators often point to the smooth finish.',
          surface_text: 'Creators: smooth finish',
          independence_count: 4,
          sponsorship_status: 'organic',
          evidence_strength: 'strong',
        },
      ],
      external_highlight_review_status: 'rewrite',
      review_status: 'completed',
      review_decision: 'rewrite',
      reviewer: 'Codex',
      reviewer_kind: 'assistant',
      reviewed_at: '2026-04-15T14:10:00.000Z',
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
    expect(overridden.bundle.provenance).toEqual(
      expect.objectContaining({
        review_status: 'completed',
        review_decision: 'rewrite',
        reviewer: 'Codex',
        reviewer_kind: 'assistant',
        reviewed_at: '2026-04-15T14:10:00.000Z',
      }),
    );
    expect(overridden.bundle.shopping_card).toEqual(
      expect.objectContaining({
        contract_version: 'pivota.shopping_card.v1',
        title: 'Naturium Vitamin C Super Serum Plus - Jumbo',
        subtitle: 'Multi-Active Serum',
      }),
    );
    expect(overridden.bundle.search_card).toEqual(
      expect.objectContaining({
        title_candidate: 'Naturium Vitamin C Super Serum Plus - Jumbo',
        compact_candidate: 'Multi-Active Serum',
        highlight_candidate: 'Creators: smooth finish',
      }),
    );
    expect(overridden.bundle.shopping_card.highlight).toBe('Creators: smooth finish');
    expect(overridden.field_sources.external_highlight_signals).toBe('manual');
  });

  test('builds shopping card payload from selected bundle and hard evidence', () => {
    const caseRow = {
      product: {
        merchant_id: 'merch_demo',
        product_id: 'prod_demo',
        brand: 'Olehenriksen',
        title: 'Banana Bright+ Vitamin CC Stick',
        category: 'Eye Treatment',
        review_summary: {
          rating: 4.8,
          review_count: 412,
        },
      },
    };

    const shoppingCard = buildShoppingCardPayload(caseRow, {
      evidence_profile: 'mixed',
      product_intel_core: {
        what_it_is: {
          headline: 'Color-correcting eye stick',
          body: 'A color-correcting eye stick that brightens and hydrates the under-eye area.',
        },
        routine_fit: {
          step: 'eye stick',
        },
      },
    });

    expect(shoppingCard).toEqual({
      contract_version: 'pivota.shopping_card.v1',
      title: 'Olehenriksen Banana Bright+ Vitamin CC Stick',
      subtitle: 'Color-Correcting Eye Stick',
      proof_badge: '4.8★ (412)',
      intro: 'A color-correcting eye stick that brightens and hydrates the under-eye area.',
      market_signal_badges: [
        {
          badge_type: 'review_signal',
          badge_label: '4.8★ (412)',
        },
      ],
      evidence_profile: 'mixed',
    });
  });

  test('manual override can inject reviewed card highlights without external signals', () => {
    const selected = {
      bundle: {
        canonical_product_ref: {
          merchant_id: 'external_seed',
          product_id: 'ext_manual_card_1',
        },
        product_intel_core: {
          what_it_is: {
            headline: 'Brightening moisturizer',
            body: 'A daily moisturizer that combines vitamin C and niacinamide with a hydration-first cream step for brightness and glow.',
          },
          routine_fit: {
            step: 'moisturizer',
          },
        },
      },
      field_sources: {},
      selected_field_count: 0,
      selected_mode: 'baseline_only',
    };

    const overridden = applyManualOverrideToSelected(
      {
        product: {
          merchant_id: 'external_seed',
          product_id: 'ext_manual_card_1',
          brand: 'Naturium',
          title: 'Vitamin C Complex Cream',
          category: 'Moisturizer',
          description: 'A daily moisturizer with vitamin C and niacinamide.',
        },
      },
      selected,
      {
        notes: 'manual reviewed card highlight',
        shopping_card: {
          highlight: 'Brightening actives in a cream step',
        },
        search_card: {
          highlight_candidate: 'Brightening actives in a cream step',
        },
        product_intel_core: {
          quality_state: 'limited',
          evidence_profile: 'seller_only',
          source_coverage: {
            seller: { available: true },
            formula: { available: false },
            reviews: { available: false, count: 0 },
          },
        },
        external_highlight_review_status: 'rewrite',
        external_review_batch: 'manual_card_highlight_2026_04_10',
      },
    );

    expect(overridden.selected_mode).toBe('manual_override');
    expect(overridden.bundle.shopping_card.highlight).toBe('Brightening actives in a cream step');
    expect(overridden.bundle.search_card.highlight_candidate).toBe('Brightening actives in a cream step');
    expect(overridden.bundle.quality_state).toBe('limited');
    expect(overridden.bundle.evidence_profile).toBe('seller_only');
    expect(overridden.bundle.source_coverage).toEqual(
      expect.objectContaining({
        seller: { available: true },
        formula: { available: false },
      }),
    );
    expect(overridden.bundle.product_intel_core.evidence_profile).toBe('seller_only');
    expect(overridden.bundle.provenance.external_highlight_review_status).toBe('rewrite');
    expect(overridden.bundle.provenance.external_review_batch).toBe('manual_card_highlight_2026_04_10');
  });

  test('selected bundle carries reviewed card evidence fields for downstream discovery surfaces', () => {
    const caseRow = {
      case_id: 'pilot_badge_ready',
      canonical_product_ref: {
        merchant_id: 'merch_demo',
        product_id: 'prod_badge_ready',
      },
      product: {
        merchant_id: 'merch_demo',
        product_id: 'prod_badge_ready',
        brand: 'Olehenriksen',
        title: 'Banana Bright+ Vitamin CC Stick',
        category: 'Eye Treatment',
        review_summary: {
          rating: 4.8,
          review_count: 412,
        },
        community_signals: {
          status: 'available',
          source_counts: {
            editorial: 4,
          },
        },
      },
    };

    const baseline = buildProductIntelDraftBundle({
      product: caseRow.product,
      canonicalProductRef: caseRow.canonical_product_ref,
    });
    const selected = buildSelectedBundle(caseRow, baseline, null, null, 'gemini-test');

    expect(selected.bundle.review_summary).toEqual({
      rating: 4.8,
      review_count: 412,
    });
    expect(selected.bundle.community_signals).toEqual(
      expect.objectContaining({
        status: 'available',
        top_loves: ['4.8★ average across 412 buyer reviews.'],
        review_stats: ['4.8★ average across 412 buyer reviews.'],
        source_counts: expect.objectContaining({
          reviews: 412,
          editorial: 4,
        }),
      }),
    );
    expect(selected.bundle.shopping_card).toEqual(
      expect.objectContaining({
        contract_version: 'pivota.shopping_card.v1',
        proof_badge: '4.8★ (412)',
      }),
    );
    expect(selected.bundle.market_signal_badges).toEqual([
      {
        badge_type: 'review_signal',
        badge_label: '4.8★ (412)',
      },
    ]);
  });
});
