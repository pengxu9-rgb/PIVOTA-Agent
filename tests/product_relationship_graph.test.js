const {
  validateRelationshipEdge,
  edgeToRecoCandidate,
  splitEdgesForRecoBlocks,
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
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('prel_test');
    expect(edges[0].source_refs).toEqual([{ type: 'products_cache', authoritative: true }]);
  });

  test('upsertRelationshipEdge writes only validated reviewed edges', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));

    const edge = await upsertRelationshipEdge(approvedDupe(), { queryFn, nowMs: NOW });
    expect(edge.review_status).toBe('approved');
    expect(queryFn).toHaveBeenCalledTimes(1);
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
        'approved',
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
