const {
  CURATED_NEED_NODES,
  buildProductRelationshipGraphDryRun,
} = require('../src/auroraBff/productRelationshipGraphBuilder');
const {
  buildCandidatesByAnchorFromSources,
} = require('../src/auroraBff/productRelationshipGraphSources');

const NOW = '2026-05-25T00:00:00.000Z';

function anchor(overrides = {}) {
  return {
    product_id: 'anchor_lux_serum',
    brand: 'Top Brand',
    name: 'Luxury Barrier Serum',
    category_taxonomy: ['skincare', 'serum'],
    price: 100,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    product_id: 'value_serum',
    brand: 'Value Brand',
    name: 'Barrier Serum Alternative',
    category_taxonomy: ['skincare', 'serum'],
    price: 80,
    category_use_case_match: 0.9,
    ingredient_functional_similarity: 0.84,
    similarity_score: 0.86,
    price_observed_at: NOW,
    source_refs: [{ type: 'products_cache', authoritative: true }],
    evidence_grade: 'B',
    ...overrides,
  };
}

describe('product relationship graph dry-run builder', () => {
  test('builds review packets, dedupes product families, and rejects below-threshold candidates', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [anchor()],
      candidatesByAnchor: {
        'product:anchor_lux_serum': [
          candidate({
            product_id: 'value_serum_a',
            product_family_id: 'fam_value_serum',
            price: 80,
          }),
          candidate({
            product_id: 'value_serum_b',
            product_family_id: 'fam_value_serum',
            price: 79,
            similarity_score: 0.88,
          }),
          candidate({
            product_id: 'premium_alt',
            brand: 'Other Premium',
            name: 'Premium Barrier Serum',
            price: 130,
            similarity_score: 0.74,
            category_use_case_match: 0.82,
          }),
          candidate({
            product_id: 'low_match',
            brand: 'Other Brand',
            name: 'Body Lotion',
            category_taxonomy: ['body care', 'lotion'],
            price: 12,
            similarity_score: 0.2,
            category_use_case_match: 0.2,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
      limit: 200,
    });

    expect(out.summary.anchor_count).toBe(1);
    expect(out.summary.edge_count).toBe(2);
    expect(out.summary.relation_counts.dupe).toBe(1);
    expect(out.summary.relation_counts.competitive_alternative).toBe(1);
    expect(out.review_packets).toHaveLength(2);
    expect(out.rejected_edges.map((row) => row.candidate_ref)).toContain('product:low_match');
    expect(out.edges.filter((edge) => edge.candidate_product_ref.includes('value_serum'))).toHaveLength(1);
  });

  test('emits one review edge for derived shade-family duplicates', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'anchor_concealer',
          brand: 'Top Brand',
          name: 'Precision Retouch Concealer',
          category: 'complexion',
          category_taxonomy: ['complexion', 'concealer'],
          price: 32,
        }),
      ],
      candidatesByAnchor: {
        'product:anchor_concealer': [
          candidate({
            product_id: 'value_concealer_100',
            brand: 'Value Brand',
            name: 'Instant Retouch Concealer - 100',
            category: null,
            category_taxonomy: ['complexion', 'concealer'],
            price: 12,
            similarity_score: 0.86,
          }),
          candidate({
            product_id: 'value_concealer_banana',
            brand: 'Value Brand',
            name: 'Instant Retouch Concealer - Banana',
            category: null,
            category_taxonomy: ['complexion', 'concealer'],
            price: 11,
            similarity_score: 0.88,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(1);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0].candidate_product_ref).toBe('product:value_concealer_100');
  });

  test('adds curated need-node niche specialists with B-grade evidence', () => {
    const need = CURATED_NEED_NODES.find((item) => item.need_id === 'need:fragrance-free-barrier-repair');
    const out = buildProductRelationshipGraphDryRun({
      anchors: [],
      needs: [need],
      needCandidatesById: {
        [need.need_id]: [
          candidate({
            product_id: 'barrier_specialist',
            brand: 'Niche Brand',
            name: 'Fragrance-Free Barrier Cream',
            category_taxonomy: ['skincare', 'barrier repair', 'moisturizer'],
            price: 24,
            score_total: 0.78,
            source_refs: [{ type: 'ingredient_kb' }],
            evidence_grade: 'B',
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.niche_specialist_count).toBe(1);
    expect(out.edges[0]).toEqual(
      expect.objectContaining({
        anchor_type: 'need',
        anchor_ref: need.need_id,
        relation_type: 'niche_specialist',
        evidence_grade: 'B',
      }),
    );
  });

  test('rejects broad category-only competitive alternatives without specific use-case overlap', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'complexion_set',
          name: 'Powder Foundation and Skin Tint Duo',
          category_taxonomy: ['set', 'makeup set'],
          category: 'set',
        }),
      ],
      candidatesByAnchor: {
        'product:complexion_set': [
          candidate({
            product_id: 'lip_set',
            brand: 'Other Brand',
            name: 'Lip Care Essentials',
            category_taxonomy: ['set', 'makeup set'],
            category: 'set',
            category_use_case_match: 1,
            similarity_score: 1,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(0);
    expect(out.rejected_edges).toEqual([
      expect.objectContaining({
        anchor_ref: 'product:complexion_set',
        candidate_ref: 'product:lip_set',
        errors: ['candidate_below_relationship_threshold'],
      }),
    ]);
  });

  test('rejects product-form mismatches before routing broad alternatives', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'eye_brush',
          brand: 'Tool Brand',
          name: 'Eyeshadow Packing Brush',
          category: 'tool',
          category_taxonomy: ['tool', 'eyeshadow brush'],
        }),
        anchor({
          product_id: 'body_loofah',
          brand: 'Bath Brand',
          name: 'Body Loofah',
          category: 'body_cleanse',
          category_taxonomy: ['body_cleanse', 'loofah'],
        }),
      ],
      candidatesByAnchor: {
        'product:eye_brush': [
          candidate({
            product_id: 'face_brush',
            brand: 'Other Tools',
            name: 'Face and Body Kabuki Brush',
            category: 'tool',
            category_taxonomy: ['tool', 'face brush'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 0.9,
            similarity_score: 1,
          }),
        ],
        'product:body_loofah': [
          candidate({
            product_id: 'body_wash',
            brand: 'Other Bath',
            name: 'Oaty Shake Body Wash Concentrate',
            category: 'body_cleanse',
            category_taxonomy: ['body_cleanse', 'body wash'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 0.9,
            similarity_score: 1,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(0);
    expect(out.rejected_edges.map((row) => row.candidate_ref).sort()).toEqual([
      'product:body_wash',
      'product:face_brush',
    ]);
  });

  test('routes only focused set-to-set alternatives with matching composition', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'lip_oil_bundle',
          brand: 'Top Brand',
          name: 'Lip Oil Bundle',
          category: 'set',
          category_taxonomy: ['set', 'lip care'],
        }),
        anchor({
          product_id: 'blush_brush_duo',
          brand: 'Top Brand',
          name: 'Pressed Blush Powder & Brush Duo',
          category: 'set',
          category_taxonomy: ['set', 'blush', 'brush'],
        }),
        anchor({
          product_id: 'glam_bundle',
          brand: 'Top Brand',
          name: "Kylie's Bronzy Glam Look Bundle",
          category: 'set',
          category_taxonomy: ['set', 'makeup set'],
        }),
        anchor({
          product_id: 'matte_lip_kit',
          brand: 'Top Brand',
          name: 'Mini Matte Lip Kit',
          category: 'set',
          category_taxonomy: ['set', 'lip color'],
        }),
      ],
      candidatesByAnchor: {
        'product:lip_oil_bundle': [
          candidate({
            product_id: 'lip_care_set',
            brand: 'Other Brand',
            name: 'Lip Care Essentials',
            category: 'set',
            category_taxonomy: ['set', 'lip care'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:blush_brush_duo': [
          candidate({
            product_id: 'blush_brush_bundle',
            brand: 'Other Brand',
            name: 'Build Your Own Blush + Brush Bundle',
            category: 'set',
            category_taxonomy: ['set', 'blush', 'brush'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:glam_bundle': [
          candidate({
            product_id: 'lip_care_set_bad',
            brand: 'Other Brand',
            name: 'Lip Care Essentials',
            category: 'set',
            category_taxonomy: ['set', 'lip care'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:matte_lip_kit': [
          candidate({
            product_id: 'lip_care_set_mismatch',
            brand: 'Other Brand',
            name: 'Lip Care Essentials',
            category: 'set',
            category_taxonomy: ['set', 'lip care'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(2);
    expect(out.edges.map((edge) => edge.candidate_product_ref).sort()).toEqual([
      'product:blush_brush_bundle',
      'product:lip_care_set',
    ]);
    expect(out.rejected_edges.map((row) => row.candidate_ref).sort()).toEqual([
      'product:lip_care_set_bad',
      'product:lip_care_set_mismatch',
    ]);
  });

  test('rejects broad category matches with different product jobs', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'softlit_foundation',
          brand: 'Complexion Brand',
          name: "Soft'lit Naturally Luminous Longwear Foundation",
          category: 'complexion',
          category_taxonomy: ['complexion', 'foundation'],
        }),
        anchor({
          product_id: 'lip_balm',
          brand: 'Lip Brand',
          name: 'Ultra-Hydrating Cherry Lip Balm',
          category: 'lip_color',
          category_taxonomy: ['lip_color', 'lip care'],
        }),
        anchor({
          product_id: 'eye_cream',
          brand: 'Skin Brand',
          name: 'Rich Peptide Eye Cream',
          category: 'skin_care',
          category_taxonomy: ['skin_care', 'eye cream'],
        }),
        anchor({
          product_id: 'concealer_brush',
          brand: 'Tool Brand',
          name: 'Precision Concealer Brush',
          category: 'tool',
          category_taxonomy: ['tool', 'concealer brush'],
        }),
      ],
      candidatesByAnchor: {
        'product:softlit_foundation': [
          candidate({
            product_id: 'soft_matte_concealer',
            brand: 'Other Brand',
            name: 'Traceless Soft Matte Concealer',
            category: 'complexion',
            category_taxonomy: ['complexion', 'concealer'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:lip_balm': [
          candidate({
            product_id: 'lip_color',
            brand: 'Other Brand',
            name: 'Ultra-Shine Lip Color',
            category: 'lip_color',
            category_taxonomy: ['lip_color', 'lipstick'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:eye_cream': [
          candidate({
            product_id: 'face_cream',
            brand: 'Other Brand',
            name: 'Rich Face Cream',
            category: 'skin_care',
            category_taxonomy: ['skin_care', 'face cream'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:concealer_brush': [
          candidate({
            product_id: 'blush_brush',
            brand: 'Other Brand',
            name: 'Blush Brush',
            category: 'tool',
            category_taxonomy: ['tool', 'blush brush'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(0);
    expect(out.rejected_edges.map((row) => row.candidate_ref).sort()).toEqual([
      'product:blush_brush',
      'product:face_cream',
      'product:lip_color',
      'product:soft_matte_concealer',
    ]);
  });

  test('keeps same-job broad category alternatives eligible for review', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'concealer_a',
          brand: 'Complexion Brand',
          name: 'Instant Retouch Concealer',
          category: 'complexion',
          category_taxonomy: ['complexion', 'concealer'],
        }),
        anchor({
          product_id: 'lip_oil',
          brand: 'Lip Brand',
          name: 'Hydrating Lip Oil',
          category: 'lip_care',
          category_taxonomy: ['lip_care', 'lip oil'],
        }),
        anchor({
          product_id: 'moisturizer_a',
          brand: 'Skin Brand',
          name: 'Rich Face Moisturizer',
          category: 'skin_care',
          category_taxonomy: ['skin_care', 'moisturizer'],
        }),
      ],
      candidatesByAnchor: {
        'product:concealer_a': [
          candidate({
            product_id: 'concealer_b',
            brand: 'Other Brand',
            name: 'Soft Matte Concealer',
            category: 'complexion',
            category_taxonomy: ['complexion', 'concealer'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:lip_oil': [
          candidate({
            product_id: 'lip_balm',
            brand: 'Other Brand',
            name: 'Clear Lip Care Balm',
            category: 'lip_care',
            category_taxonomy: ['lip_care', 'lip care'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:moisturizer_a': [
          candidate({
            product_id: 'moisturizer_b',
            brand: 'Other Brand',
            name: 'Rich Face Cream',
            category: 'skin_care',
            category_taxonomy: ['skin_care', 'moisturizer'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(3);
    expect(out.edges.map((edge) => edge.candidate_product_ref).sort()).toEqual([
      'product:concealer_b',
      'product:lip_balm',
      'product:moisturizer_b',
    ]);
  });

  test('rejects reviewed noise patterns from expanded product batches', () => {
    const out = buildProductRelationshipGraphDryRun({
      anchors: [
        anchor({
          product_id: 'ha_serum',
          brand: 'Skin Brand',
          name: '4-in-1 Hyaluronic Face Serum',
          category: 'skin_care',
          category_taxonomy: ['skin_care', 'serum'],
        }),
        anchor({
          product_id: 'setting_powder',
          brand: 'Complexion Brand',
          name: 'Soft Radiance Setting Powder',
          category: 'complexion',
          category_taxonomy: ['complexion', 'setting powder'],
        }),
        anchor({
          product_id: 'body_bundle',
          brand: 'Body Brand',
          name: 'Body Start Set Full Size Bundle',
          category: 'set',
          category_taxonomy: ['set', 'body care'],
        }),
        anchor({
          product_id: 'hair_rinse',
          brand: 'Hair Brand',
          name: 'Antarctic ACV Hair Shine Glass Rinse for pH Balance',
          category: 'hair_care',
          category_taxonomy: ['hair_care', 'hair rinse'],
        }),
        anchor({
          product_id: 'body_milk',
          brand: 'Body Brand',
          name: 'Butta Drop Hydrating Body Milk',
          category: 'body_care',
          category_taxonomy: ['body_care', 'body milk'],
        }),
        anchor({
          product_id: 'shampoo',
          brand: 'Hair Brand',
          name: 'Antioxidant Shampoo',
          category: 'hair_care',
          category_taxonomy: ['hair_care', 'shampoo'],
        }),
        anchor({
          product_id: 'rare_sweatshirt',
          brand: 'Rare Beauty',
          name: 'Everyday Quarter Zip Sweatshirt',
          category: 'apparel',
          category_taxonomy: ['apparel', 'sweatshirt'],
        }),
      ],
      candidatesByAnchor: {
        'product:ha_serum': [
          candidate({
            product_id: 'kojic_serum',
            brand: 'Other Skin',
            name: 'Kojic Brightening Serum',
            category: 'skin_care',
            category_taxonomy: ['skin_care', 'serum'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:setting_powder': [
          candidate({
            product_id: 'powder_foundation',
            brand: 'Other Complexion',
            name: 'Soft Matte Powder Foundation',
            category: 'complexion',
            category_taxonomy: ['complexion', 'powder foundation'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:body_bundle': [
          candidate({
            product_id: 'face_spa_trio',
            brand: 'Other Set',
            name: 'Mini Spa Trio Face Cleanser Set',
            category: 'set',
            category_taxonomy: ['set', 'face skincare'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:hair_rinse': [
          candidate({
            product_id: 'conditioner',
            brand: 'Other Hair',
            name: 'Mekabu Hydrating Conditioner',
            category: 'hair_care',
            category_taxonomy: ['hair_care', 'conditioner'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:body_milk': [
          candidate({
            product_id: 'deodorant',
            brand: 'Other Body',
            name: 'Eucalyptus Natural Deodorant',
            category: 'body_care',
            category_taxonomy: ['body_care', 'deodorant'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:shampoo': [
          candidate({
            product_id: 'hydrating_conditioner',
            brand: 'Other Hair',
            name: 'Hydrating Conditioner',
            category: 'hair_care',
            category_taxonomy: ['hair_care', 'conditioner'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
        'product:rare_sweatshirt': [
          candidate({
            product_id: 'rare_keychain',
            brand: 'Rare Beauty',
            name: 'Mini Puffy Tote Keychain',
            category: 'accessory',
            category_taxonomy: ['accessory', 'keychain'],
            category_use_case_match: 1,
            ingredient_functional_similarity: 1,
            similarity_score: 1,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.edge_count).toBe(0);
    expect(out.rejected_edges.map((row) => row.candidate_ref).sort()).toEqual([
      'product:conditioner',
      'product:deodorant',
      'product:face_spa_trio',
      'product:hydrating_conditioner',
      'product:kojic_serum',
      'product:powder_foundation',
      'product:rare_keychain',
    ]);
  });

  test('gates niche specialists to need-specific evidence', () => {
    const peptideNeed = CURATED_NEED_NODES.find((item) => item.need_id === 'need:budget-peptide-serum');
    const barrierNeed = CURATED_NEED_NODES.find((item) => item.need_id === 'need:fragrance-free-barrier-repair');
    const out = buildProductRelationshipGraphDryRun({
      anchors: [],
      needs: [peptideNeed, barrierNeed],
      needCandidatesById: {
        [peptideNeed.need_id]: [
          candidate({
            product_id: 'peptide_serum_no_price',
            brand: 'Niche Brand',
            name: 'Peptide Serum',
            category: 'skin_care',
            category_taxonomy: ['skin_care', 'serum', 'peptide'],
            price: null,
            score_total: 0.9,
          }),
          candidate({
            product_id: 'peptide_serum_with_price',
            brand: 'Niche Brand',
            name: 'Peptide Serum',
            category: 'skin_care',
            category_taxonomy: ['skin_care', 'serum', 'peptide'],
            price: 18,
            score_total: 0.9,
          }),
        ],
        [barrierNeed.need_id]: [
          candidate({
            product_id: 'body_barrier',
            brand: 'Body Brand',
            name: 'Fragrance-Free Body Barrier Cream',
            category: 'body_care',
            category_taxonomy: ['body_care', 'body cream'],
            price: 18,
            score_total: 0.9,
          }),
          candidate({
            product_id: 'face_barrier',
            brand: 'Face Brand',
            name: 'Fragrance-Free Sensitive Barrier Repair Cream',
            category: 'skin_care',
            category_taxonomy: ['skin_care', 'barrier repair', 'moisturizer'],
            price: 22,
            score_total: 0.9,
          }),
        ],
      },
      now: new Date(NOW),
      reviewStatus: 'pending',
    });

    expect(out.summary.niche_specialist_count).toBe(2);
    expect(out.edges.map((edge) => edge.candidate_product_ref).sort()).toEqual([
      'product:face_barrier',
      'product:peptide_serum_with_price',
    ]);
    expect(out.rejected_edges.map((row) => row.candidate_ref).sort()).toEqual([
      'product:body_barrier',
      'product:peptide_serum_no_price',
    ]);
  });
});

describe('product relationship graph source candidate fan-out', () => {
  function familyAnchor(productId) {
    return {
      product_id: productId,
      brand: 'Anchor Brand',
      name: 'Hydrating Barrier Serum',
      category: 'serum',
      category_taxonomy: ['skincare', 'serum'],
      product_family_id: 'fam_anchor_serum',
      price: 42,
    };
  }

  test('can fan representative family candidates out to sibling anchors behind a flag', () => {
    const anchors = [familyAnchor('anchor_serum_30ml'), familyAnchor('anchor_serum_50ml')];
    const products = [
      ...anchors,
      {
        product_id: 'value_serum',
        brand: 'Value Brand',
        name: 'Hydrating Barrier Serum Alternative',
        category: 'serum',
        category_taxonomy: ['skincare', 'serum'],
        price: 18,
        source_refs: [{ type: 'product_intel_kb', authoritative: true }],
      },
    ];

    const defaults = buildCandidatesByAnchorFromSources({
      anchors,
      products,
      includeTransitiveRecall: false,
    });
    const withFanout = buildCandidatesByAnchorFromSources({
      anchors,
      products,
      includeTransitiveRecall: false,
      fanOutFamilyCandidatesToSiblingAnchors: true,
    });

    const defaultCoveredAnchors = ['product:anchor_serum_30ml', 'product:anchor_serum_50ml']
      .filter((ref) => Array.isArray(defaults[ref]) && defaults[ref].length > 0);
    expect(defaultCoveredAnchors).toHaveLength(1);
    expect(withFanout['product:anchor_serum_30ml'].map((item) => item.product_id)).toContain('value_serum');
    expect(withFanout['product:anchor_serum_50ml'].map((item) => item.product_id)).toContain('value_serum');
  });
});
