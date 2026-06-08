const {
  validateRelationshipEdge,
  edgeToRecoCandidate,
  splitEdgesForRecoBlocks,
  relationshipEdgeToSimilarItem,
  buildAnchorRefsFromProduct,
  expandAnchorRefsWithGroupSiblings,
  listApprovedRelationshipEdgesForAnchor,
  listApprovedRelationshipEdgesForAnchorUncollapsed,
  collapseApprovedRelationshipEdgesToFamilies,
  upsertRelationshipEdge,
  upsertRelationshipCandidateLabel,
  extractReasonFlags,
  extractFailureReasonFlags,
  __internal,
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

  test('anchor refs include requested external seed aliases after canonicalization', () => {
    expect(
      buildAnchorRefsFromProduct({
        product_id: 'sig_canonical',
        source_product_id: 'sig_canonical',
        requested_product_id: 'ext_requested_anchor',
      }),
    ).toEqual(
      expect.arrayContaining([
        'product:sig_canonical',
        'product:ext_requested_anchor',
        'ext_requested_anchor',
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

  test('relationshipEdgeToSimilarItem keeps original url/product_id precedence for flag-off raw edges', () => {
    // Regression: relationshipEdgeToSimilarItem is shared by flag-off and flag-on serving. A raw
    // edge (no candidate_* collapse fields) MUST keep the original precedence — snap.url first (not
    // canonical_url/pivota_canonical_url) and snap.product_id (not product_family_id/canonical_entity_id).
    const rawEdge = approvedDupe({
      candidate_snapshot: {
        product_id: 'candidate_1',
        product_family_id: 'pg_family_should_not_win',
        canonical_entity_id: 'pg_family_should_not_win',
        brand: 'Value Brand',
        name: 'Barrier Serum Alternative',
        url: 'https://example.test/candidate',
        canonical_url: 'https://example.test/CANONICAL',
        pivota_canonical_url: 'https://example.test/PIVOTA',
        price: 80,
      },
    });
    const item = relationshipEdgeToSimilarItem(rawEdge);
    expect(item.product_id).toBe('candidate_1');
    expect(item.external_product_id).toBe('candidate_1');
    expect(item.url).toBe('https://example.test/candidate');
    expect(item.canonical_url).toBe('https://example.test/candidate');
  });

  test('relationshipEdgeToSimilarItem hydrates family display only for collapsed edges', () => {
    // A collapsed edge carries candidate_* fields; only THEN do canonical id/url take precedence.
    const collapsedEdge = approvedDupe({
      candidate_family_key: 'family:v1:value brand::barrier serum alternative::',
      candidate_canonical_entity_id: 'pg_canonical_family',
      candidate_canonical_url: 'https://example.test/FAMILY',
      candidate_snapshot: {
        product_id: 'candidate_1',
        brand: 'Value Brand',
        name: 'Barrier Serum Alternative',
        url: 'https://example.test/candidate',
        price: 80,
      },
    });
    const item = relationshipEdgeToSimilarItem(collapsedEdge);
    expect(item.product_id).toBe('pg_canonical_family');
    expect(item.url).toBe('https://example.test/FAMILY');
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

  test('flag-off listApprovedRelationshipEdgesForAnchor is byte-identical to uncollapsed fetcher', async () => {
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    const prevPgFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED;
    delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED;
    const rows = [
      {
        ...approvedDupe({ id: 'prel_a', score_total: 0.91 }),
        vertical: 'beauty',
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
      },
      {
        ...approvedDupe({
          id: 'prel_b',
          candidate_product_ref: 'product:candidate_2',
          candidate_snapshot: { product_id: 'candidate_2', brand: 'Value Brand', name: 'Second', price: 70 },
          score_total: 0.87,
        }),
        vertical: 'beauty',
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
      },
    ];
    const makeQueryFn = () => jest.fn(async () => ({ rows }));
    const args = {
      anchorType: 'product',
      anchorRefs: ['product:anchor_1'],
      market: 'US',
      relationTypes: ['dupe'],
      limit: 7,
    };
    try {
      const rawQueryFn = makeQueryFn();
      const publicQueryFn = makeQueryFn();
      const raw = await listApprovedRelationshipEdgesForAnchorUncollapsed({ ...args, queryFn: rawQueryFn });
      const publicRows = await listApprovedRelationshipEdgesForAnchor({ ...args, queryFn: publicQueryFn });

      expect(publicRows).toEqual(raw);
      expect(publicQueryFn.mock.calls[0][0]).toBe(rawQueryFn.mock.calls[0][0]);
      expect(publicQueryFn.mock.calls[0][1]).toEqual(rawQueryFn.mock.calls[0][1]);
      expect(__internal.isRelationshipGraphFamilyCollapseEnabled()).toBe(false);
    } finally {
      if (prevFamilyFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = prevFamilyFlag;
      if (prevPgFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED = prevPgFlag;
    }
  });

  test('flag-on overfetches raw rows before collapsing shade families', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
    const rawRows = [
      ...Array.from({ length: 10 }, (_, index) => approvedDupe({
        id: `prel_shade_${index}`,
        anchor_ref: 'product:ext_anchor',
        anchor_snapshot: { product_id: 'ext_anchor', brand: 'Anchor Brand', name: 'Anchor Serum' },
        candidate_product_ref: `product:ext_concealer_${index}`,
        candidate_snapshot: {
          product_id: `ext_concealer_${index}`,
          brand: 'Value Brand',
          name: `Soft Matte Concealer - #${150 + index}`,
          price: 20 + index,
        },
        relation_type: 'competitive_alternative',
        score_total: 0.95 - index * 0.01,
      })),
      approvedDupe({
        id: 'prel_distinct_family',
        anchor_ref: 'product:ext_anchor',
        anchor_snapshot: { product_id: 'ext_anchor', brand: 'Anchor Brand', name: 'Anchor Serum' },
        candidate_product_ref: 'product:ext_powder',
        candidate_snapshot: {
          product_id: 'ext_powder',
          brand: 'Value Brand',
          name: 'Soft Focus Powder',
          price: 18,
        },
        relation_type: 'competitive_alternative',
        score_total: 0.7,
      }),
    ].map((row) => ({
      ...row,
      vertical: 'beauty',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    }));
    const catalogRowForRef = (ref) => {
      const normalized = String(ref || '').toLowerCase();
      const bare = normalized.replace(/^product:/, '');
      if (bare === 'ext_anchor') {
        return {
          input_ref: ref,
          normalized_ref: normalized,
          source_product_id: bare,
          title: 'Anchor Serum',
          brand: 'Anchor Brand',
          category: 'serum',
          product_type: 'serum',
          product_payload: {},
          pivota_signature_id: 'sig_anchor',
          product_group_id: 'pg_anchor',
          is_primary: true,
          pdp_lifecycle_stage: 'published',
        };
      }
      if (bare === 'ext_powder') {
        return {
          input_ref: ref,
          normalized_ref: normalized,
          source_product_id: bare,
          title: 'Soft Focus Powder',
          brand: 'Value Brand',
          category: 'powder',
          product_type: 'powder',
          product_payload: {},
          pivota_signature_id: 'sig_powder',
          product_group_id: 'pg_powder',
          is_primary: true,
          pdp_lifecycle_stage: 'published',
        };
      }
      return {
        input_ref: ref,
        normalized_ref: normalized,
        source_product_id: bare,
        title: 'Soft Matte Concealer - #150',
        brand: 'Value Brand',
        category: 'concealer',
        product_type: 'concealer',
        product_payload: {},
        pivota_signature_id: `sig_${bare}`,
        product_group_id: `pg_${bare}`,
        is_primary: bare.endsWith('_0'),
        pdp_lifecycle_stage: 'published',
      };
    };
    const queryFn = jest.fn(async (sql, params) => {
      if (/FROM product_relationship_edges/.test(sql)) return { rows: rawRows };
      if (/catalog_products/.test(sql)) {
        return { rows: (params[0] || []).map(catalogRowForRef) };
      }
      return { rows: [] };
    });

    try {
      const edges = await listApprovedRelationshipEdgesForAnchor({
        anchorRefs: ['product:ext_anchor'],
        market: 'US',
        limit: 2,
        queryFn,
      });
      const rawCall = queryFn.mock.calls.find(([sql]) => /FROM product_relationship_edges/.test(sql));
      expect(rawCall[0]).not.toMatch(/\blabel_state\b/);
      expect(rawCall[1][3]).toBe(500);
      expect(edges).toHaveLength(2);
      expect(edges.map((edge) => edge.provenance.relationship_family_collapse.collapsed_edge_count).sort((a, b) => b - a)).toEqual([10, 1]);
      expect(edges[0].candidate_family_key).toMatch(/^family:v1:/);
    } finally {
      if (prevFamilyFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = prevFamilyFlag;
      logger.info.mockRestore();
    }
  });

  test('flag-on fails closed to uncollapsed edges when the resolver query throws', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
    const rawRows = Array.from({ length: 5 }, (_, index) => ({
      ...approvedDupe({
        id: `prel_resolverfail_${index}`,
        anchor_ref: 'product:ext_anchor',
        candidate_product_ref: `product:ext_shade_${index}`,
        candidate_snapshot: { product_id: `ext_shade_${index}`, brand: 'Value Brand', name: `Concealer - #${150 + index}` },
        relation_type: 'competitive_alternative',
        score_total: 0.95 - index * 0.01,
      }),
      vertical: 'beauty',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    }));
    const queryFn = jest.fn(async (sql) => {
      if (/FROM product_relationship_edges/.test(sql)) return { rows: rawRows };
      if (/catalog_products/.test(sql)) throw new Error('Connection terminated unexpectedly');
      return { rows: [] };
    });
    try {
      const edges = await listApprovedRelationshipEdgesForAnchor({
        anchorRefs: ['product:ext_anchor'],
        market: 'US',
        limit: 2,
        queryFn,
      });
      // Must NOT throw; degrades to the raw uncollapsed edges sliced to the limit.
      expect(edges).toHaveLength(2);
      expect(edges.every((edge) => !edge.provenance?.relationship_family_collapse)).toBe(true);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      if (prevFamilyFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = prevFamilyFlag;
      logger.info.mockRestore();
      logger.warn.mockRestore();
    }
  });

  test('flag-on served collapse prefers human_approved over ai_approved in the same family', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
    const rawRows = [
      {
        ...approvedDupe({
          id: 'prel_served_ai',
          anchor_ref: 'product:label_state_anchor',
          anchor_snapshot: { product_id: 'label_state_anchor', brand: 'Anchor Brand', name: 'Anchor Serum' },
          candidate_product_ref: 'product:label_state_candidate_ai',
          candidate_snapshot: { product_id: 'label_state_candidate_ai', brand: 'Value Brand', name: 'Value Serum - Shade A' },
          label_state: 'ai_approved',
          score_total: 0.99,
          evidence_grade: 'A',
          updated_at: new Date(NOW + 5_000).toISOString(),
        }),
        vertical: 'beauty',
        created_at: NOW_ISO,
      },
      {
        ...approvedDupe({
          id: 'prel_served_human',
          anchor_ref: 'product:label_state_anchor',
          anchor_snapshot: { product_id: 'label_state_anchor', brand: 'Anchor Brand', name: 'Anchor Serum' },
          candidate_product_ref: 'product:label_state_candidate_human',
          candidate_snapshot: { product_id: 'label_state_candidate_human', brand: 'Value Brand', name: 'Value Serum - Shade B' },
          label_state: 'human_approved',
          score_total: 0.7,
          evidence_grade: 'B',
          updated_at: new Date(NOW + 1_000).toISOString(),
        }),
        vertical: 'beauty',
        created_at: NOW_ISO,
      },
    ];
    const queryFn = jest.fn(async (sql, params) => {
      if (/FROM product_relationship_edges/.test(sql)) return { rows: rawRows };
      if (/catalog_products/.test(sql)) {
        return {
          rows: (params[0] || []).map((ref) => {
            const normalized = String(ref || '').toLowerCase();
            const bare = normalized.replace(/^product:/, '');
            const isAnchor = bare === 'label_state_anchor';
            return {
              input_ref: ref,
              normalized_ref: normalized,
              source_product_id: bare,
              title: isAnchor ? 'Anchor Serum' : 'Value Serum',
              brand: isAnchor ? 'Anchor Brand' : 'Value Brand',
              category: 'serum',
              product_type: 'serum',
              product_payload: {},
              product_family_id: isAnchor ? 'pf_label_state_anchor' : 'pf_label_state_candidate',
              pivota_signature_id: `sig_${bare}`,
              product_group_id: isAnchor ? 'pg_label_state_anchor' : 'pg_label_state_candidate',
              is_primary: bare === 'label_state_candidate_human',
              pdp_lifecycle_stage: 'published',
            };
          }),
        };
      }
      return { rows: [] };
    });

    try {
      const edges = await listApprovedRelationshipEdgesForAnchor({
        anchorRefs: ['product:label_state_anchor'],
        market: 'US',
        limit: 10,
        queryFn,
      });
      expect(edges).toHaveLength(1);
      expect(edges[0].id).toBe('prel_served_human');
      expect(edges[0].label_state).toBe('human_approved');
      expect(edges[0].provenance.relationship_family_collapse).toMatchObject({
        collapsed_edge_count: 2,
        representative_edge_id: 'prel_served_human',
      });
    } finally {
      if (prevFamilyFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = prevFamilyFlag;
      logger.info.mockRestore();
    }
  });

  test('family collapse drops same-family product self-edges', () => {
    const edge = approvedDupe({
      id: 'prel_self',
      anchor_ref: 'product:ext_a_145',
      anchor_snapshot: { product_id: 'ext_a_145', brand: 'Fenty Beauty', name: "Pro Filt'r Concealer - #145" },
      candidate_product_ref: 'product:ext_a_150',
      candidate_snapshot: { product_id: 'ext_a_150', brand: 'Fenty Beauty', name: "Pro Filt'r Concealer - #150" },
      relation_type: 'related_product',
    });
    const collapsed = collapseApprovedRelationshipEdgesToFamilies([edge], { resolutionMap: new Map(), limit: 10 });
    expect(collapsed).toHaveLength(0);
    expect(collapsed.__collapse_stats.dropped_self_edge_count).toBe(1);
  });

  test('snapshot fallback family key strips structured prefix shade values', () => {
    const edge = approvedDupe({
      id: 'prel_structured_prefix_self',
      anchor_ref: 'product:ext_karachi',
      anchor_snapshot: {
        product_id: 'ext_karachi',
        brand: 'Nailkind',
        name: 'Karachi - Breathable Nail Polish',
        category: 'nail polish',
        variant_title: 'Shade: Karachi',
      },
      candidate_product_ref: 'product:ext_seville',
      candidate_snapshot: {
        product_id: 'ext_seville',
        brand: 'Nailkind',
        name: 'Seville - Breathable Nail Polish',
        category: 'nail polish',
        variant_title: 'Shade: Seville',
      },
      relation_type: 'related_product',
    });

    const collapsed = collapseApprovedRelationshipEdgesToFamilies([edge], { resolutionMap: new Map(), limit: 10 });
    expect(collapsed).toHaveLength(0);
    expect(collapsed.__collapse_stats.dropped_self_edge_count).toBe(1);
  });

  test('flag-on serving drops sibling-expanded anchor edges back to queried family', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
    const rawRows = [
      {
        ...approvedDupe({
          id: 'prel_sibling_self',
          anchor_ref: 'product:ext_primary',
          anchor_snapshot: { product_id: 'ext_primary', brand: 'Fenty Beauty', name: "Pro Filt'r Concealer - #145" },
          candidate_product_ref: 'product:ext_viewed',
          candidate_snapshot: { product_id: 'ext_viewed', brand: 'Fenty Beauty', name: "Pro Filt'r Concealer - #150" },
          relation_type: 'related_product',
        }),
        vertical: 'beauty',
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
      },
    ];
    const queryFn = jest.fn(async (sql, params) => {
      if (/FROM product_relationship_edges/.test(sql)) return { rows: rawRows };
      if (/catalog_products/.test(sql)) {
        return {
          rows: (params[0] || []).map((ref) => {
            const normalized = String(ref).toLowerCase();
            const bare = normalized.replace(/^product:/, '');
            return {
              input_ref: ref,
              normalized_ref: normalized,
              source_product_id: bare,
              title: bare === 'ext_primary' ? "Pro Filt'r Concealer - #145" : "Pro Filt'r Concealer - #150",
              brand: 'Fenty Beauty',
              category: 'concealer',
              product_type: 'concealer',
              product_payload: {},
              pivota_signature_id: `sig_${bare}`,
              product_group_id: `pg_${bare}`,
              is_primary: bare === 'ext_primary',
              pdp_lifecycle_stage: 'published',
            };
          }),
        };
      }
      return { rows: [{ sibling: 'ext_primary' }, { sibling: 'ext_viewed' }] };
    });

    try {
      const edges = await listApprovedRelationshipEdgesForAnchor({
        anchorRefs: ['product:ext_viewed'],
        market: 'US',
        limit: 4,
        queryFn,
      });
      expect(edges).toEqual([]);
      const rawCall = queryFn.mock.calls.find(([sql]) => /FROM product_relationship_edges/.test(sql));
      expect(rawCall[1][1]).toEqual(expect.arrayContaining(['product:ext_primary']));
    } finally {
      if (prevFamilyFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = prevFamilyFlag;
      logger.info.mockRestore();
    }
  });

  test('sibling expansion degrades to base refs when product_group_members lookup fails', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const queryFn = jest.fn(async () => {
      const err = new Error('Connection terminated unexpectedly');
      err.code = 'ECONNRESET';
      throw err;
    });

    try {
      const refs = await expandAnchorRefsWithGroupSiblings(['product:ext_viewed', 'ext_viewed'], { queryFn });

      expect(refs).toEqual(['product:ext_viewed', 'ext_viewed']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'metric',
          name: 'aurora_bff_relationship_graph_sibling_expansion_failed',
          code: 'ECONNRESET',
          base_ref_count: 2,
          ext_key_count: 1,
          degraded_to_base_refs: true,
        }),
        expect.stringContaining('serving base refs'),
      );
    } finally {
      logger.warn.mockRestore();
    }
  });

  test('flag-on serving uses base anchor refs when sibling expansion has a transient DB error', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
    const rawRows = [
      {
        ...approvedDupe({
          id: 'prel_base_ref_after_sibling_error',
          anchor_ref: 'product:ext_viewed',
          anchor_snapshot: { product_id: 'ext_viewed', brand: 'Anchor Brand', name: 'Anchor Serum' },
          candidate_product_ref: 'product:ext_candidate',
          candidate_snapshot: { product_id: 'ext_candidate', brand: 'Value Brand', name: 'Value Serum' },
          relation_type: 'competitive_alternative',
        }),
        vertical: 'beauty',
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
      },
    ];
    const queryFn = jest.fn(async (sql, params) => {
      if (/FROM product_group_members/.test(sql)) {
        const err = new Error('Connection terminated unexpectedly');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (/FROM product_relationship_edges/.test(sql)) return { rows: rawRows };
      if (/catalog_products/.test(sql)) {
        return {
          rows: (params[0] || []).map((ref) => {
            const normalized = String(ref).toLowerCase();
            const bare = normalized.replace(/^product:/, '');
            return {
              input_ref: ref,
              normalized_ref: normalized,
              source_product_id: bare,
              title: bare === 'ext_viewed' ? 'Anchor Serum' : 'Value Serum',
              brand: bare === 'ext_viewed' ? 'Anchor Brand' : 'Value Brand',
              category: 'serum',
              product_type: 'serum',
              product_payload: {},
              pivota_signature_id: `sig_${bare}`,
              product_group_id: `pg_${bare}`,
              is_primary: true,
              pdp_lifecycle_stage: 'published',
            };
          }),
        };
      }
      return { rows: [] };
    });

    try {
      const edges = await listApprovedRelationshipEdgesForAnchor({
        anchorRefs: ['product:ext_viewed'],
        market: 'US',
        limit: 4,
        queryFn,
      });

      expect(edges).toHaveLength(1);
      expect(edges[0].id).toBe('prel_base_ref_after_sibling_error');
      const rawCall = queryFn.mock.calls.find(([sql]) => /FROM product_relationship_edges/.test(sql));
      expect(rawCall[1][1]).toEqual(['product:ext_viewed']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'aurora_bff_relationship_graph_sibling_expansion_failed',
          degraded_to_base_refs: true,
        }),
        expect.any(String),
      );
    } finally {
      if (prevFamilyFlag === undefined) delete process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
      else process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = prevFamilyFlag;
      logger.info.mockRestore();
      logger.warn.mockRestore();
    }
  });

  test('family aggregation uses winning tier max score, best grade, latest dates, and capped refs', () => {
    const resolutionMap = new Map([
      ['product:anchor', {
        normalized_ref: 'product:anchor',
        family_key: 'family:v1:anchor::serum::',
        family_key_source: 'derived_family_key',
        resolved: true,
      }],
      ['product:candidate', {
        normalized_ref: 'product:candidate',
        family_key: 'family:v1:value::concealer::',
        family_key_source: 'derived_family_key',
        product_group_id: 'pg_candidate',
        display_snapshot: { product_id: 'pg_candidate', brand: 'Value', name: 'Value Concealer' },
        display_snapshot_source: 'product_group_primary',
        resolved: true,
      }],
    ]);
    const refs = Array.from({ length: 20 }, (_, index) => ({ type: `source_${index}` }));
    const edges = [
      approvedDupe({
        id: 'prel_ai',
        anchor_ref: 'product:anchor',
        candidate_product_ref: 'product:candidate',
        label_state: 'ai_approved',
        score_total: 0.99,
        evidence_grade: 'A',
        source_refs: refs.slice(0, 2),
        why_candidate: { summary: 'ai row' },
        expires_at: new Date(NOW + 5 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      approvedDupe({
        id: 'prel_human_rep',
        anchor_ref: 'product:anchor',
        candidate_product_ref: 'product:candidate',
        label_state: 'human_approved',
        score_total: 0.7,
        evidence_grade: 'B',
        source_refs: refs,
        why_candidate: { summary: 'human representative' },
        expires_at: new Date(NOW + 20 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(NOW + 2_000).toISOString(),
      }),
      approvedDupe({
        id: 'prel_human_score',
        anchor_ref: 'product:anchor',
        candidate_product_ref: 'product:candidate',
        label_state: 'human_approved',
        score_total: 0.91,
        evidence_grade: 'C',
        source_refs: refs.slice(3, 8),
        why_candidate: { summary: 'higher score row' },
        expires_at: new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString(),
        last_verified_at: new Date(NOW + 3_000).toISOString(),
      }),
    ];

    const [collapsed] = collapseApprovedRelationshipEdgesToFamilies(edges, { resolutionMap, limit: 10 });
    expect(collapsed.id).toBe('prel_human_rep');
    expect(collapsed.score_total).toBe(0.91);
    expect(collapsed.evidence_grade).toBe('B');
    expect(collapsed.expires_at).toBe(new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString());
    expect(collapsed.last_verified_at).toBe(new Date(NOW + 3_000).toISOString());
    expect(collapsed.source_refs).toHaveLength(16);
    expect(collapsed.why_candidate.summary).toBe('human representative');
    expect(collapsed.provenance.relationship_family_collapse).toMatchObject({
      collapsed_edge_count: 3,
      representative_edge_id: 'prel_human_rep',
      score_total_max: 0.91,
      evidence_grade_best: 'B',
    });
  });

  test('collapsed candidate display uses family representative instead of arbitrary shade title', () => {
    const resolutionMap = new Map([
      ['product:anchor', {
        normalized_ref: 'product:anchor',
        family_key: 'family:v1:anchor::serum::',
        family_key_source: 'derived_family_key',
        resolved: true,
      }],
      ['product:shade_150', {
        normalized_ref: 'product:shade_150',
        family_key: 'family:v1:value::soft matte concealer::concealer',
        family_key_source: 'derived_family_key',
        product_group_id: 'pg_shade_150',
        display_snapshot: { product_id: 'pg_shade_150', brand: 'Value', name: 'Soft Matte Concealer - #150' },
        display_snapshot_source: 'catalog_published',
        resolved: true,
      }],
      ['product:family_rep', {
        normalized_ref: 'product:family_rep',
        family_key: 'family:v1:value::soft matte concealer::concealer',
        family_key_source: 'derived_family_key',
        product_group_id: 'pg_family_rep',
        canonical_entity_id: 'pg_family_rep',
        display_snapshot: { product_id: 'pg_family_rep', brand: 'Value', name: 'Soft Matte Concealer' },
        display_snapshot_source: 'product_group_primary',
        resolved: true,
      }],
    ]);
    const edges = [
      approvedDupe({
        id: 'prel_high_score_shade',
        anchor_ref: 'product:anchor',
        candidate_product_ref: 'product:shade_150',
        candidate_snapshot: { product_id: 'shade_150', brand: 'Value', name: 'Soft Matte Concealer - #150' },
        score_total: 0.95,
        evidence_grade: 'A',
      }),
      approvedDupe({
        id: 'prel_primary_rep',
        anchor_ref: 'product:anchor',
        candidate_product_ref: 'product:family_rep',
        candidate_snapshot: { product_id: 'family_rep', brand: 'Value', name: 'Soft Matte Concealer' },
        score_total: 0.8,
        evidence_grade: 'B',
      }),
    ];

    const [collapsed] = collapseApprovedRelationshipEdgesToFamilies(edges, { resolutionMap, limit: 10 });
    expect(collapsed.id).toBe('prel_high_score_shade');
    expect(collapsed.candidate_display_snapshot.name).toBe('Soft Matte Concealer');
    expect(relationshipEdgeToSimilarItem(collapsed).title).toBe('Soft Matte Concealer');
    expect(relationshipEdgeToSimilarItem(collapsed).product_id).toBe('pg_family_rep');
  });

  test('relationshipEdgeToSimilarItem prefers collapsed family display snapshot', () => {
    const item = relationshipEdgeToSimilarItem({
      ...approvedDupe({
        candidate_product_ref: 'product:ext_shade_150',
        candidate_snapshot: {
          product_id: 'ext_shade_150',
          brand: 'Value Brand',
          name: 'Soft Matte Concealer - #150',
          url: 'https://merchant.example/shade-150',
        },
      }),
      candidate_canonical_entity_id: 'pg_value_concealer',
      candidate_canonical_url: 'https://agent.pivota.cc/products/pg_value_concealer',
      candidate_display_snapshot: {
        product_id: 'pg_value_concealer',
        brand: 'Value Brand',
        name: 'Soft Matte Concealer',
        canonical_url: 'https://agent.pivota.cc/products/pg_value_concealer',
      },
    });

    expect(item.product_id).toBe('pg_value_concealer');
    expect(item.title).toBe('Soft Matte Concealer');
    expect(item.url).toBe('https://agent.pivota.cc/products/pg_value_concealer');
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

  test('generated reruns do not demote existing reviewed labels on conflict', async () => {
    const queryFn = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    await upsertRelationshipCandidateLabel(
      { ...generatedEdge(), label_state: 'generated' },
      { queryFn },
    );
    const sql = queryFn.mock.calls[0][0];
    expect(sql).toContain("relationship_candidate_labels.label_state = ANY");
    expect(sql).toContain("'human_approved', 'ai_approved', 'human_rejected', 'needs_evidence'");
    expect(sql).toContain("'generated', 'review_ready'");
    expect(sql).not.toContain("'generated', 'prefilter_rejected', 'review_ready'");
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
