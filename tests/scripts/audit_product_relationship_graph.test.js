const {
  auditReport,
  auditUnsupportedClaims,
  renderMarkdownReport,
} = require('../../scripts/audit-product-relationship-graph');

const NOW = Date.parse('2026-05-25T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE_ISO = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST_ISO = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
const STALE_PRICE_ISO = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();

function approvedDupe(overrides = {}) {
  return {
    id: 'prel_clean_dupe',
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
    },
    relation_type: 'dupe',
    market: 'US',
    vertical: 'beauty',
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

function approvedNicheSpecialist(overrides = {}) {
  return {
    id: 'prel_clean_niche',
    anchor_type: 'need',
    anchor_ref: 'need:fragrance-free-barrier-repair',
    anchor_snapshot: {
      need_id: 'need:fragrance-free-barrier-repair',
      label: 'fragrance-free barrier repair',
      category_taxonomy: ['skincare', 'barrier repair', 'moisturizer'],
    },
    candidate_product_ref: 'product:niche_1',
    candidate_snapshot: {
      product_id: 'niche_1',
      brand: 'Niche Brand',
      name: 'Fragrance-Free Barrier Cream',
      category_taxonomy: ['skincare', 'barrier repair', 'moisturizer'],
      price: 24,
    },
    relation_type: 'niche_specialist',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare', 'barrier repair', 'moisturizer'],
    use_case: 'fragrance-free barrier repair',
    score_total: 0.78,
    score_breakdown: {
      category_use_case_match: 0.8,
      ingredient_functional_similarity: 0.72,
      score_total: 0.78,
    },
    price_evidence: {
      candidate_price_amount: 24,
      observed_at: NOW_ISO,
    },
    source_refs: [{ type: 'ingredient_kb', authoritative: true }],
    evidence_grade: 'B',
    review_status: 'approved',
    why_candidate: {
      summary: 'Need-specific source evidence is available.',
    },
    last_verified_at: NOW_ISO,
    expires_at: FUTURE_ISO,
    ...overrides,
  };
}

describe('audit-product-relationship-graph', () => {
  test('detects hard-fail quality gate violations', () => {
    const badDupe = approvedDupe({
      id: 'prel_bad_dupe_1',
      candidate_product_ref: 'product:same_brand_candidate',
      candidate_snapshot: {
        product_id: 'same_brand_candidate',
        brand: 'Top Brand',
        name: 'Same Brand Barrier Serum',
        category_taxonomy: ['skincare', 'serum'],
        price: 80,
      },
      category_taxonomy: [],
      use_case: '',
      price_evidence: {
        anchor_price_amount: 100,
        candidate_price_amount: 80,
        price_ratio: 0.8,
        observed_at: STALE_PRICE_ISO,
      },
      source_refs: [{ type: 'on_page_related' }],
      why_candidate: {
        summary: 'Identical formula with FDA approved results. TikTok viral.',
      },
      expires_at: PAST_ISO,
    });
    const duplicateBadDupe = {
      ...badDupe,
      id: 'prel_bad_dupe_2',
    };
    const missingSourceCompetitor = approvedDupe({
      id: 'prel_bad_competitor_missing_source',
      candidate_product_ref: 'product:competitor_no_source',
      candidate_snapshot: {
        product_id: 'competitor_no_source',
        brand: 'Other Brand',
        name: 'Barrier Serum Competitor',
        category_taxonomy: ['skincare', 'serum'],
        price: 95,
      },
      relation_type: 'competitive_alternative',
      score_total: 0.72,
      price_evidence: {
        anchor_price_amount: 100,
        candidate_price_amount: 95,
        price_ratio: 0.95,
        observed_at: NOW_ISO,
      },
      source_refs: [],
    });

    const audit = auditReport(
      {
        summary: { anchor_count: 1 },
        edges: [badDupe, duplicateBadDupe, missingSourceCompetitor],
      },
      { nowMs: NOW },
    );

    expect(audit.status).toBe('fail');
    expect(audit.metrics.duplicate_identity_count).toBe(1);
    expect(audit.metrics.same_brand_competitor_dupe_count).toBe(2);
    expect(audit.metrics.on_page_competitor_dupe_count).toBe(2);
    expect(audit.metrics.stale_price_missing_dupe_count).toBe(2);
    expect(audit.metrics.missing_source_category_use_case_count).toBe(3);
    expect(audit.metrics.missing_source_refs_count).toBe(1);
    expect(audit.metrics.expired_approved_count).toBe(2);
    expect(audit.metrics.unsupported_claim_count).toBeGreaterThanOrEqual(6);
    expect(audit.hard_gates.duplicate_edge_identity.status).toBe('fail');
    expect(audit.hard_gates.required_source_category_use_case.status).toBe('fail');
    expect(audit.hard_gates.unsupported_claims.status).toBe('fail');
  });

  test('passes a clean approved report and evaluates pilot thresholds when supplied', () => {
    const audit = auditReport(
      {
        summary: {
          anchor_count: 2,
          thresholds: {
            min_anchors_processed: 1,
            min_approved_alternative_percentage: 50,
            min_approved_niche_specialist_count: 1,
          },
        },
        edges: [approvedDupe(), approvedNicheSpecialist()],
        review_packets: [{ edge_id: 'prel_clean_dupe' }, { edge_id: 'prel_clean_niche' }],
      },
      { nowMs: NOW },
    );

    expect(audit.status).toBe('pass');
    expect(audit.metrics.validation_error_count).toBe(0);
    expect(audit.metrics.unsupported_claim_count).toBe(0);
    expect(audit.hard_gates.dupe_fresh_price.status).toBe('pass');
    expect(audit.pilot_acceptance.metrics.approved_alternative_anchor_percentage).toBe(50);
    expect(audit.pilot_acceptance.gates.approved_alternative_anchor_percentage.status).toBe('pass');
    expect(audit.pilot_acceptance.gates.approved_niche_specialist_count.status).toBe('pass');

    const markdown = renderMarkdownReport(audit);
    expect(markdown).toContain('Status: PASS');
    expect(markdown).toContain('| dupe_fresh_price | pass | 0 | 0 |');
  });

  test('requires social proof support terms while allowing sourced creator evidence', () => {
    const unsupported = auditUnsupportedClaims(
      approvedDupe({
        why_candidate: { summary: 'Creator favorite and viral on TikTok.' },
        source_refs: [{ type: 'products_cache', authoritative: true }],
      }),
      0,
    );
    expect(unsupported.map((item) => item.claim_id)).toContain('unsupported_social_proof');

    const supported = auditUnsupportedClaims(
      approvedDupe({
        why_candidate: { summary: 'Creator favorite and viral on TikTok.' },
        source_refs: [{ type: 'social_review', name: 'TikTok creator source' }],
      }),
      0,
    );
    expect(supported).toEqual([]);
  });
});
