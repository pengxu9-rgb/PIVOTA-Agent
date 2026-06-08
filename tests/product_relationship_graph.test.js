const {
  validateRelationshipEdge,
  isRelationshipEdgeServingSafe,
  getRelationshipEdgeServingSuppressionReasons,
  edgeToRecoCandidate,
  splitEdgesForRecoBlocks,
  relationshipEdgeToSimilarItem,
  buildAnchorRefsFromProduct,
  listApprovedRelationshipEdgesForAnchor,
  upsertRelationshipEdge,
  upsertRelationshipCandidateLabel,
  extractReasonFlags,
  extractFailureReasonFlags,
} = require('../src/auroraBff/productRelationshipGraph');

const NOW = Date.parse('2026-05-25T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE_ISO = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();

function approvedDupe(overrides = {}) {
  return {
    anchor_type: 'product',
    anchor_ref: 'product:anchor_1',
    anchor_snapshot: {
      product_id: 'anchor_1',
      brand: 'Top Brand',
      name: 'Luxury Barrier Serum',
      category_taxonomy: ['skincare', 'serum'],
      price: 100,
    },
    candidate_product_ref: 'product:candidate_1',
    candidate_snapshot: {
      product_id: 'candidate_1',
      brand: 'Value Brand',
      name: 'Barrier Serum Alternative',
      category_taxonomy: ['skincare', 'serum'],
      price: 80,
      url: 'https://example.test/candidate',
    },
    relation_type: 'dupe',
    market: 'US',
    category_taxonomy: ['skincare', 'serum'],
    use_case: 'barrier serum',
    score_total: 0.86,
    score_breakdown: {
      category_use_case_match: 0.91,
      ingredient_functional_similarity: 0.84,
      score_total: 0.86,
    },
    price_evidence: {
      anchor_price_amount: 100,
      candidate_price_amount: 80,
      price_ratio: 0.8,
      observed_at: NOW_ISO,
    },
    source_refs: [{ type: 'products_cache', authoritative: true }],
    evidence_grade: 'A',
    review_status: 'approved',
    why_candidate: {
      summary: 'Similar product type and function at a lower price.',
      reasons_user_visible: ['Category and price evidence are present.'],
    },
    last_verified_at: NOW_ISO,
    expires_at: FUTURE_ISO,
    ...overrides,
  };
}

describe('product relationship graph edge validation', () => {
  test('approved high-confidence lower-price dupe is valid and maps to a graph reco candidate', () => {
    const validation = validateRelationshipEdge(approvedDupe(), { nowMs: NOW });

    expect(validation.ok).toBe(true);
    expect(validation.value.display_label).toBe('budget_alternative');

    const candidate = edgeToRecoCandidate(validation.value);
    expect(candidate.product_id).toBe('candidate_1');
    expect(candidate.source).toEqual(expect.objectContaining({ type: 'relationship_graph' }));
    expect(candidate.relationship_type).toBe('dupe');
    expect(candidate.score_breakdown.score_total).toBe(0.86);
    expect(candidate.price).toBe(80);
  });

  test('same-brand and on-page dupes are blocked before approval', () => {
    const sameBrand = validateRelationshipEdge(
      approvedDupe({
        candidate_snapshot: {
          product_id: 'candidate_1',
          brand: 'Top Brand',
          name: 'Same Brand Serum',
          category_taxonomy: ['skincare', 'serum'],
          price: 80,
        },
      }),
      { nowMs: NOW },
    );
    expect(sameBrand.ok).toBe(false);
    expect(sameBrand.errors).toContain('dupe_same_brand_blocked');

    const onPage = validateRelationshipEdge(
      approvedDupe({
        source_refs: [{ type: 'on_page_related' }],
      }),
      { nowMs: NOW },
    );
    expect(onPage.ok).toBe(false);
    expect(onPage.errors).toContain('dupe_on_page_source_blocked');
  });

  test('dupe requires fresh observed candidate price and threshold price ratio', () => {
    const stale = validateRelationshipEdge(
      approvedDupe({
        price_evidence: {
          anchor_price_amount: 100,
          candidate_price_amount: 80,
          price_ratio: 0.8,
          observed_at: '2026-05-01T00:00:00.000Z',
        },
      }),
      { nowMs: NOW },
    );
    expect(stale.ok).toBe(false);
    expect(stale.errors).toContain('dupe_price_stale');

    const expensive = validateRelationshipEdge(
      approvedDupe({
        price_evidence: {
          anchor_price_amount: 100,
          candidate_price_amount: 120,
          price_ratio: 1.2,
          observed_at: NOW_ISO,
        },
      }),
      { nowMs: NOW },
    );
    expect(expensive.ok).toBe(false);
    expect(expensive.errors).toContain('dupe_price_ratio_above_threshold');
  });

  test('dupe and competitive alternative require explicit cross-brand evidence', () => {
    const missingBrandDupe = validateRelationshipEdge(
      approvedDupe({
        anchor_snapshot: {
          product_id: 'anchor_1',
          name: 'Luxury Barrier Serum',
          category_taxonomy: ['skincare', 'serum'],
          price: 100,
        },
      }),
      { nowMs: NOW },
    );
    expect(missingBrandDupe.ok).toBe(false);
    expect(missingBrandDupe.errors).toContain('dupe_brand_missing');

    const missingBrandCompetitor = validateRelationshipEdge(
      approvedDupe({
        relation_type: 'competitive_alternative',
        score_total: 0.7,
        price_evidence: {
          anchor_price_amount: 100,
          candidate_price_amount: 120,
          price_ratio: 1.2,
          observed_at: NOW_ISO,
        },
        candidate_snapshot: {
          product_id: 'candidate_1',
          name: 'Barrier Serum Alternative',
          category_taxonomy: ['skincare', 'serum'],
          price: 120,
        },
      }),
      { nowMs: NOW },
    );
    expect(missingBrandCompetitor.ok).toBe(false);
    expect(missingBrandCompetitor.errors).toContain('competitive_alternative_brand_missing');
  });

  test('niche specialists require a need anchor, B-grade evidence, and credible source refs', () => {
    const valid = validateRelationshipEdge(
      approvedDupe({
        anchor_type: 'need',
        anchor_ref: 'need:fragrance-free-barrier-repair',
        anchor_snapshot: { need_id: 'need:fragrance-free-barrier-repair' },
        relation_type: 'niche_specialist',
        candidate_product_ref: 'product:niche_1',
        score_total: 0.74,
        price_evidence: { candidate_price_amount: 24, observed_at: NOW_ISO },
        source_refs: [{ type: 'ingredient_kb' }],
        evidence_grade: 'B',
      }),
      { nowMs: NOW },
    );
    expect(valid.ok).toBe(true);

    const weak = validateRelationshipEdge(
      approvedDupe({
        anchor_type: 'product',
        relation_type: 'niche_specialist',
        source_refs: [{ type: 'blog' }],
        evidence_grade: 'C',
      }),
      { nowMs: NOW },
    );
    expect(weak.ok).toBe(false);
    expect(weak.errors).toEqual(
      expect.arrayContaining([
        'niche_specialist_anchor_must_be_need',
        'niche_specialist_evidence_below_b',
        'niche_specialist_source_evidence_too_weak',
      ]),
    );
  });

  test('splitEdgesForRecoBlocks only emits approved fresh edges', () => {
    const valid = validateRelationshipEdge(approvedDupe(), { nowMs: NOW }).value;
    const pending = validateRelationshipEdge(approvedDupe({ review_status: 'pending' }), { nowMs: NOW }).value;
    const expired = validateRelationshipEdge(
      approvedDupe({
        review_status: 'expired',
        expires_at: '2026-05-20T00:00:00.000Z',
      }),
      { nowMs: NOW },
    ).value;

    const out = splitEdgesForRecoBlocks([valid, pending, expired]);
    expect(out.dupes.map((candidate) => candidate.product_id)).toEqual(['candidate_1']);
  });

  test('runtime serving guard suppresses AI-approved dupes but leaves human-approved dupes servable', () => {
    const aiApprovedDupe = approvedDupe({
      label_state: 'ai_approved',
      candidate_product_ref: 'product:candidate_ai_dupe',
      candidate_snapshot: {
        product_id: 'candidate_ai_dupe',
        brand: 'Value Brand',
        name: 'Generic Barrier Serum Alternative',
        category_taxonomy: ['skincare', 'serum'],
        price: 80,
      },
    });
    const humanApprovedDupe = approvedDupe({ label_state: 'human_approved' });

    expect(isRelationshipEdgeServingSafe(aiApprovedDupe)).toBe(false);
    expect(getRelationshipEdgeServingSuppressionReasons(aiApprovedDupe)).toContain('ai_approved_dupe_quarantined');
    expect(isRelationshipEdgeServingSafe(humanApprovedDupe)).toBe(true);

    const out = splitEdgesForRecoBlocks([aiApprovedDupe, humanApprovedDupe]);
    expect(out.dupes.map((candidate) => candidate.product_id)).toEqual(['candidate_1']);
  });

  test('runtime serving guard suppresses audited shade/SKU related-product floods', () => {
    const shadeMismatch = approvedDupe({
      label_state: 'ai_approved',
      relation_type: 'related_product',
      display_label: 'related_product',
      score_total: 1,
      anchor_snapshot: {
        product_id: 'fenty_concealer_130',
        brand: 'Fenty Beauty',
        name: "Pro Filt'r Instant Retouch Concealer - #130",
      },
      candidate_product_ref: 'product:fenty_foundation_315',
      candidate_snapshot: {
        product_id: 'fenty_foundation_315',
        brand: 'Fenty Beauty',
        name: "Soft'lit Naturally Luminous Longwear Foundation - 315",
      },
    });
    const sameFamilyVariant = approvedDupe({
      label_state: 'ai_approved',
      relation_type: 'related_product',
      display_label: 'related_product',
      anchor_snapshot: {
        product_id: 'boj_ln110',
        brand: 'Beauty of Joseon',
        name: 'Daily Tinted Fluid Sunscreen LN110',
      },
      candidate_product_ref: 'product:boj_dp320',
      candidate_snapshot: {
        product_id: 'boj_dp320',
        brand: 'Beauty of Joseon',
        name: 'Daily Tinted Fluid Sunscreen DP320',
      },
    });
    const trailingVariant = approvedDupe({
      label_state: 'ai_approved',
      relation_type: 'related_product',
      display_label: 'related_product',
      anchor_snapshot: {
        product_id: 'apricot_glow',
        brand: 'Embryolisse',
        name: 'Radiant Complexion Cream - Apricot Glow',
      },
      candidate_product_ref: 'product:pink_glow',
      candidate_snapshot: {
        product_id: 'pink_glow',
        brand: 'Embryolisse',
        name: 'Radiant Complexion Cream - Pink Glow',
      },
    });
    const sizeLikePair = approvedDupe({
      label_state: 'ai_approved',
      relation_type: 'related_product',
      display_label: 'related_product',
      anchor_snapshot: {
        product_id: 'serum_30',
        brand: 'Fixture Beauty',
        name: 'Barrier Serum - 30',
      },
      candidate_product_ref: 'product:cream_50',
      candidate_snapshot: {
        product_id: 'cream_50',
        brand: 'Fixture Beauty',
        name: 'Barrier Cream - 50',
      },
    });

    expect(getRelationshipEdgeServingSuppressionReasons(shadeMismatch)).toEqual(
      expect.arrayContaining([
        'related_product_mismatched_shade_sku',
        'related_product_fenty_complexion_sku_flood',
      ]),
    );
    expect(isRelationshipEdgeServingSafe(shadeMismatch)).toBe(false);
    expect(getRelationshipEdgeServingSuppressionReasons(sameFamilyVariant)).toContain(
      'related_product_mismatched_shade_sku',
    );
    expect(getRelationshipEdgeServingSuppressionReasons(trailingVariant)).toContain(
      'related_product_same_family_variant',
    );

    const out = splitEdgesForRecoBlocks([shadeMismatch, sameFamilyVariant, trailingVariant]);
    expect(out.related_products).toEqual([]);
    expect(getRelationshipEdgeServingSuppressionReasons(sizeLikePair)).not.toContain(
      'related_product_mismatched_shade_sku',
    );
    expect(isRelationshipEdgeServingSafe(sizeLikePair)).toBe(true);
  });
});

describe('product relationship graph store helpers', () => {
  test('anchor refs include stable product, url, and text identities', () => {
    expect(
      buildAnchorRefsFromProduct({
        product_id: 'sku_123',
        url: 'https://example.test/p/sku-123',
        brand: 'Top Brand',
        name: 'Luxury Serum',
      }),
    ).toEqual(
      expect.arrayContaining([
        'product:sku_123',
        'sku_123',
        'url:https://example.test/p/sku-123',
        'text:Top Brand:Luxury Serum',
      ]),
    );
  });

  test('anchor refs derive an ext_ product identity from external_product_id', () => {
    // External-seed PDPs sometimes carry a pivota signature as product_id while
    // the ext_ key (which the curated edges are anchored on) lives on
    // external_product_id. Matching must still resolve.
    expect(
      buildAnchorRefsFromProduct({
        product_id: 'sig_abc123',
        external_product_id: 'ext_066c4dfce36363f1dfd2c450',
      }),
    ).toEqual(
      expect.arrayContaining([
        'product:sig_abc123',
        'product:ext_066c4dfce36363f1dfd2c450',
        'ext_066c4dfce36363f1dfd2c450',
      ]),
    );
  });

  test('relationshipEdgeToSimilarItem maps a snapshot-backed edge to a similar item', () => {
    const item = relationshipEdgeToSimilarItem(approvedDupe());
    expect(item).toMatchObject({
      product_id: 'candidate_1',
      external_product_id: 'candidate_1',
      merchant_id: 'external_seed',
      title: 'Barrier Serum Alternative',
      brand: 'Value Brand',
      url: 'https://example.test/candidate',
      price: 80,
      source: 'relationship_graph',
      recommendation_source: 'relationship_graph',
      relationship_type: 'dupe',
    });
    expect(item.relationship_edge_id).toBeTruthy();
  });

  test('relationshipEdgeToSimilarItem strips the ref prefix when snapshot lacks a product id', () => {
    // Production edges store the candidate id only on candidate_product_ref
    // (`product:ext_<hash>`); the served product_id must be the bare ext_ key.
    const edge = approvedDupe({
      candidate_product_ref: 'product:ext_6f1c7d03a6e0dd364d151ebd',
      candidate_snapshot: {
        brand: 'Tomford Beauty',
        name: 'Traceless Soft Matte Concealer',
        url: 'https://www.tomfordbeauty.com/products/traceless-soft-matte-concealer',
      },
    });
    const item = relationshipEdgeToSimilarItem(edge);
    expect(item.product_id).toBe('ext_6f1c7d03a6e0dd364d151ebd');
    expect(item.merchant_id).toBe('external_seed');
    expect(item.title).toBe('Traceless Soft Matte Concealer');
  });

  test('relationshipEdgeToSimilarItem suppresses nested product refs that cannot resolve to catalog ids', () => {
    const edge = approvedDupe({
      candidate_product_ref: 'product:ulta:c43a0e805e8b643c',
      candidate_snapshot: {
        brand: 'Naturium',
        name: 'Multi-Peptide Moisturizer',
        url: 'https://example.test/naturium',
      },
    });

    expect(getRelationshipEdgeServingSuppressionReasons(edge)).toContain(
      'candidate_ref_unresolvable_nested_product_prefix',
    );
    expect(relationshipEdgeToSimilarItem(edge)).toBe(null);
  });

  test('listApprovedRelationshipEdgesForAnchor preserves source provenance from rows', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        {
          ...approvedDupe(),
          id: 'prel_test',
          vertical: 'beauty',
          created_at: NOW_ISO,
          updated_at: NOW_ISO,
        },
      ],
    }));

    const edges = await listApprovedRelationshipEdgesForAnchor({
      anchorRefs: ['product:anchor_1'],
      market: 'US',
      queryFn,
    });

    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/FROM relationship_candidate_labels/);
    expect(queryFn.mock.calls[0][0]).toMatch(/label_state IN \('human_approved','ai_approved'\)/);
    expect(queryFn.mock.calls[0][0]).toMatch(/NOT \(label_state = 'ai_approved' AND relation_type = 'dupe'\)/);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('prel_test');
    expect(edges[0].source_refs).toEqual([{ type: 'products_cache', authoritative: true }]);
  });

  test('upsertRelationshipEdge writes only validated reviewed edges', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));

    const edge = await upsertRelationshipEdge(approvedDupe(), { queryFn, nowMs: NOW });
    expect(edge.review_status).toBe('approved');
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(queryFn.mock.calls[0][0]).toMatch(/INSERT INTO relationship_candidate_labels/);
    expect(queryFn.mock.calls[0][0]).toMatch(/ON CONFLICT \(market, anchor_type, lower\(anchor_ref\), lower\(candidate_product_ref\), relation_type\)/);
    expect(queryFn.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        edge.id,
        'product',
        'product:anchor_1',
        'product:candidate_1',
        'dupe',
        'budget_alternative',
        'US',
        'beauty',
        0.86,
        'A',
        'human_approved',
      ]),
    );

    await expect(
      upsertRelationshipEdge(
        approvedDupe({
          candidate_snapshot: {
            product_id: 'candidate_1',
            brand: 'Top Brand',
            name: 'Same Brand Serum',
            category_taxonomy: ['skincare', 'serum'],
            price: 80,
          },
        }),
        { queryFn, nowMs: NOW },
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PRODUCT_RELATIONSHIP_EDGE',
      errors: expect.arrayContaining(['dupe_same_brand_blocked']),
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test('upsertRelationshipEdge preserves explicit compatible ai approval labels', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));

    await upsertRelationshipEdge(approvedDupe({ label_state: 'ai_approved' }), { queryFn, nowMs: NOW });

    const params = queryFn.mock.calls[0][1];
    expect(params[18]).toBe('ai_approved');
    expect(params[27]).toBe(NOW_ISO);

    await expect(
      upsertRelationshipEdge(approvedDupe({ label_state: 'human_rejected' }), { queryFn, nowMs: NOW }),
    ).rejects.toMatchObject({
      code: 'INCOMPATIBLE_REVIEW_STATUS_LABEL_STATE',
    });
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe('upsertRelationshipCandidateLabel — prefilter_reasons persistence', () => {
  function generatedEdge(overrides = {}) {
    // Minimal valid input for a 'generated' (pre-review) label.
    return {
      id: 'prel_gen_test_001',
      anchor_type: 'product',
      anchor_ref: 'product:ext_anchor_aaa',
      anchor_snapshot: { product_id: 'ext_anchor_aaa', brand: 'Brand A', name: 'A' },
      candidate_product_ref: 'product:ext_cand_bbb',
      candidate_snapshot: { product_id: 'ext_cand_bbb', brand: 'Brand B', name: 'B' },
      relation_type: 'competitive_alternative',
      market: 'US',
      ...overrides,
    };
  }

  test('persists prefilter_reasons on prefilter_rejected label', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    await upsertRelationshipCandidateLabel(
      {
        ...generatedEdge(),
        label_state: 'prefilter_rejected',
        prefilter_reasons: [
          'category_leaf_mismatch:lipstick_vs_foundation',
          'target_area_mismatch:lips_vs_face',
        ],
      },
      { queryFn },
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    const params = queryFn.mock.calls[0][1];
    expect(params).toEqual(
      expect.arrayContaining([
        [
          'category_leaf_mismatch:lipstick_vs_foundation',
          'target_area_mismatch:lips_vs_face',
        ],
      ]),
    );
  });

  test('throws MISSING_PREFILTER_REASONS when label_state is prefilter_rejected but no reasons given', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    await expect(
      upsertRelationshipCandidateLabel(
        { ...generatedEdge(), label_state: 'prefilter_rejected' },
        { queryFn },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_PREFILTER_REASONS' });
    expect(queryFn).not.toHaveBeenCalled();
  });

  test('throws MISSING_PREFILTER_REASONS when prefilter_rejected and reasons is empty array', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    await expect(
      upsertRelationshipCandidateLabel(
        {
          ...generatedEdge(),
          label_state: 'prefilter_rejected',
          prefilter_reasons: [],
        },
        { queryFn },
      ),
    ).rejects.toMatchObject({ code: 'MISSING_PREFILTER_REASONS' });
  });

  test('generated label may omit prefilter_reasons (column nullable)', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    await upsertRelationshipCandidateLabel(
      { ...generatedEdge(), label_state: 'generated' },
      { queryFn },
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    const params = queryFn.mock.calls[0][1];
    // prefilter_reasons param should be null (not provided)
    expect(params).toEqual(expect.arrayContaining([null]));
  });

  test('normalizes prefilter_reasons (lowercase, length-limited, drops empties)', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    await upsertRelationshipCandidateLabel(
      {
        ...generatedEdge(),
        label_state: 'prefilter_rejected',
        prefilter_reasons: ['CATEGORY_LEAF_MISMATCH:Lipstick_vs_FOUNDATION', '', null],
      },
      { queryFn },
    );
    const params = queryFn.mock.calls[0][1];
    expect(params).toEqual(
      expect.arrayContaining([
        ['category_leaf_mismatch:lipstick_vs_foundation'],
      ]),
    );
  });
});

describe('reason-flag projections', () => {
  // Real shape observed in pilot_stage10 reports: each reviewer_decisions lane
  // carries its own status, reason, and flags. Top-level human_review.flags
  // aggregates flags from ALL lanes regardless of status — which is what
  // extractReasonFlags also produces. extractFailureReasonFlags restricts to
  // flags from lanes whose status === 'reject'.
  const mixedHumanReview = {
    consensus_status: 'reject',
    reviewer_decisions: {
      ingredient_formula_form: {
        status: 'reject',
        flags: ['product_job_mismatch', 'weak_same_category'],
      },
      brand_category_price: {
        status: 'reject',
        flags: ['cross_brand', 'product_job_mismatch'],
      },
      effect_use_case_claims: {
        status: 'approve',
        flags: ['same_target_area', 'direct_category_use_case_supported'],
      },
      provenance_kol_source: {
        status: 'approve',
        flags: ['authoritative_product_intel_source_refs', 'no_kol_or_endorsement_dependency'],
      },
    },
  };

  test('extractReasonFlags returns the union across all lanes regardless of status', () => {
    expect(extractReasonFlags(mixedHumanReview)).toEqual([
      'authoritative_product_intel_source_refs',
      'cross_brand',
      'direct_category_use_case_supported',
      'no_kol_or_endorsement_dependency',
      'product_job_mismatch',
      'same_target_area',
      'weak_same_category',
    ]);
  });

  test('extractFailureReasonFlags includes only flags from lanes that voted reject', () => {
    expect(extractFailureReasonFlags(mixedHumanReview)).toEqual([
      'cross_brand',
      'product_job_mismatch',
      'weak_same_category',
    ]);
  });

  test('both projections return [] for empty or malformed input', () => {
    expect(extractReasonFlags(null)).toEqual([]);
    expect(extractReasonFlags({})).toEqual([]);
    expect(extractFailureReasonFlags(null)).toEqual([]);
    expect(extractFailureReasonFlags({ reviewer_decisions: 'not an object' })).toEqual([]);
  });

  test('extractFailureReasonFlags treats hold/approve/missing-status lanes as non-failure', () => {
    const r = extractFailureReasonFlags({
      reviewer_decisions: {
        a: { status: 'hold', flags: ['hold_flag'] },
        b: { status: 'approve', flags: ['approve_flag'] },
        c: { flags: ['no_status_flag'] },
        d: { status: 'reject', flags: ['reject_flag'] },
      },
    });
    expect(r).toEqual(['reject_flag']);
  });
});
