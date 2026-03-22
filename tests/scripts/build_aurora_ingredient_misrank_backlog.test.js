const { _internals } = require('../../scripts/build_aurora_ingredient_misrank_backlog.cjs');

describe('build_aurora_ingredient_misrank_backlog', () => {
  test('flags kb-only lead without target anchor', () => {
    const entry = _internals.buildMisrankEntry(
      {
        ingredient_id: 'squalane',
        ingredient_name: 'Squalane',
        ingredient_class: 'oil',
        query: 'squalane serum',
        query_source: 'agent_products_ingredient_recall_direct',
        root_cause_bucket: 'direct_hit',
        top_products: [
          {
            name: 'Retinol 0.5% in Squalane',
            brand: 'The Ordinary',
            retrieval_source: 'unattached_seed',
            url: 'https://theordinary.com/en-us/retinol-05-in-squalane-serum-100440.html',
          },
        ],
        ranked_samples: [
          {
            title: 'Retinol 0.5% in Squalane',
            brand: 'The Ordinary',
            source_tag: 'unattached_seed',
            candidate_step: 'serum',
            family_relation: 'same_family',
            kb_explicit: 1,
            explicit_hits: 1,
            surface_explicit_hits: 0,
            strong_target_anchor_hits: 0,
            target_anchor_hits: 0,
          },
        ],
      },
      'sample.json',
    );

    expect(entry).toBeTruthy();
    expect(entry.misrank_reasons).toEqual(
      expect.arrayContaining(['kb_only_lead_without_target_anchor']),
    );
  });

  test('ignores clean direct hits with target-anchored lead', () => {
    const entry = _internals.buildMisrankEntry(
      {
        ingredient_id: 'alpha_arbutin',
        ingredient_name: 'Alpha arbutin',
        query: 'alpha arbutin serum',
        query_source: 'agent_products_ingredient_recall_direct',
        root_cause_bucket: 'direct_hit',
        top_products: [
          {
            name: 'Alpha Arbutin 2% + HA',
            brand: 'The Ordinary',
            retrieval_source: 'unattached_seed_target_anchored',
            url: 'https://theordinary.com/en-ge/alpha-arbutin-2-ha-serum-769915233674.html',
          },
        ],
        ranked_samples: [
          {
            title: 'Alpha Arbutin 2% + HA',
            kb_explicit: 0,
            explicit_hits: 9,
            surface_explicit_hits: 9,
            strong_target_anchor_hits: 1,
            target_anchor_hits: 0,
          },
        ],
      },
      'sample.json',
    );

    expect(entry).toBeNull();
  });

  test('aligns lead ranked sample to top product before flagging misrank', () => {
    const entry = _internals.buildMisrankEntry(
      {
        ingredient_id: 'hyaluronic_acid',
        ingredient_name: 'Hyaluronic acid',
        query: 'hyaluronic acid serum',
        query_source: 'agent_products_ingredient_recall_direct',
        root_cause_bucket: 'direct_hit',
        top_products: [
          {
            name: 'Hyaluronic Acid 2% + B5 (Original Formulation)',
            brand: 'The Ordinary',
            retrieval_source: 'unattached_seed_target_anchored',
            url: 'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-original-formulation-100425.html',
          },
        ],
        ranked_samples: [
          {
            title: 'Truth Serum',
            brand: 'Olehenriksen',
            candidate_url: 'https://olehenriksen.com/products/truth-serum',
            kb_explicit: 0,
            explicit_hits: 3,
            surface_explicit_hits: 3,
            strong_target_anchor_hits: 1,
            target_anchor_hits: 1,
          },
          {
            title: 'Hyaluronic Acid 2% + B5 (Original Formulation)',
            brand: 'The Ordinary',
            candidate_url: 'https://theordinary.com/en-us/hyaluronic-acid-2-b5-serum-original-formulation-100425.html',
            kb_explicit: 0,
            explicit_hits: 4,
            surface_explicit_hits: 4,
            strong_target_anchor_hits: 1,
            target_anchor_hits: 1,
          },
        ],
      },
      'sample.json',
    );

    expect(entry).toBeNull();
  });

  test('flags competing title anchor only when current ingredient is absent from lead title and url', () => {
    const entry = _internals.buildMisrankEntry(
      {
        ingredient_id: 'glycerin',
        ingredient_name: 'Glycerin',
        query: 'glycerin moisturizer',
        query_source: 'agent_products_ingredient_recall_direct',
        root_cause_bucket: 'direct_hit',
        top_products: [
          {
            name: 'Strength Trainer Peptide Boost Moisturizer',
            brand: 'Olehenriksen',
            retrieval_source: 'unattached_seed_target_anchored',
            url: 'https://olehenriksen.com/products/strength-trainer-peptide-boost-moisturizer',
          },
        ],
        ranked_samples: [
          {
            title: 'Strength Trainer Peptide Boost Moisturizer',
            brand: 'Olehenriksen',
            candidate_url: 'https://olehenriksen.com/products/strength-trainer-peptide-boost-moisturizer',
            kb_explicit: 0,
            explicit_hits: 2,
            surface_explicit_hits: 2,
            strong_target_anchor_hits: 1,
            target_anchor_hits: 1,
          },
        ],
      },
      'sample.json',
    );

    expect(entry).toBeTruthy();
    expect(entry.misrank_reasons).toEqual(
      expect.arrayContaining(['competing_title_or_url_anchor']),
    );
    expect(entry.conflicting_ingredient_ids).toContain('peptides');
  });
});
