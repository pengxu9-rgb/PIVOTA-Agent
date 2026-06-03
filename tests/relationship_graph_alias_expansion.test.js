const {
  expandAnchorRefsWithGroupSiblings,
  listApprovedRelationshipEdgesForAnchor,
} = require('../src/auroraBff/productRelationshipGraph');

const NOW = Date.parse('2026-05-25T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const FUTURE_ISO = new Date(NOW + 30 * 24 * 60 * 60 * 1000).toISOString();

function makeQueryFn(siblingsByExt = {}) {
  // Responds to the sibling-expansion query: given anchor ext keys, returns all
  // siblings sharing a group.
  return jest.fn(async (sql, params) => {
    if (/product_group_members/.test(sql)) {
      const anchorKeys = Array.isArray(params?.[0]) ? params[0] : [];
      const siblings = new Set();
      for (const k of anchorKeys) {
        for (const s of (siblingsByExt[k] || [])) siblings.add(s);
      }
      return { rows: Array.from(siblings).map((sibling) => ({ sibling })) };
    }
    return { rows: [] };
  });
}

function approvedEdgeRow(overrides = {}) {
  return {
    id: 'prel_alias_1',
    anchor_type: 'product',
    anchor_ref: 'product:ext_a',
    anchor_snapshot: {},
    candidate_product_ref: 'product:ext_candidate',
    candidate_snapshot: { product_id: 'ext_candidate', name: 'Candidate' },
    relation_type: 'competitive_alternative',
    display_label: 'alternative',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: [],
    use_case: null,
    score_total: 0.9,
    score_breakdown: {},
    price_evidence: null,
    source_refs: [],
    evidence_grade: 'B',
    review_status: 'approved',
    why_candidate: null,
    tradeoffs: null,
    watchouts: null,
    provenance: null,
    last_verified_at: NOW_ISO,
    expires_at: FUTURE_ISO,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

describe('expandAnchorRefsWithGroupSiblings', () => {
  test('adds sibling ext refs (product: and bare) for a grouped product', async () => {
    // ext_a is grouped with ext_b and ext_c
    const qFn = makeQueryFn({ ext_a: ['ext_a', 'ext_b', 'ext_c'] });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_a', 'ext_a'], { queryFn: qFn });
    expect(out).toEqual(expect.arrayContaining([
      'product:ext_a', 'ext_a',
      'product:ext_b', 'ext_b',
      'product:ext_c', 'ext_c',
    ]));
  });

  test('non-primary listing now matches sibling-anchored edges', async () => {
    // user views ext_b; edges live on ext_a (the primary). Group: a,b,c
    const qFn = makeQueryFn({ ext_b: ['ext_a', 'ext_b', 'ext_c'] });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_b'], { queryFn: qFn });
    expect(out).toContain('product:ext_a'); // ← the primary's anchor is now in the ref list
  });

  test('standalone product (no group) is a no-op', async () => {
    const qFn = makeQueryFn({}); // no siblings for anything
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_lonely'], { queryFn: qFn });
    expect(out).toEqual(['product:ext_lonely']);
  });

  test('no ext keys → no query, returns base refs unchanged', async () => {
    const qFn = jest.fn(async () => ({ rows: [] }));
    const out = await expandAnchorRefsWithGroupSiblings(['text:Glow:Serum', 'url:https://x'], { queryFn: qFn });
    expect(out).toEqual(['text:Glow:Serum', 'url:https://x']);
    expect(qFn).not.toHaveBeenCalled();
  });

  test('does not duplicate refs already present', async () => {
    const qFn = makeQueryFn({ ext_a: ['ext_a', 'ext_b'] });
    const out = await expandAnchorRefsWithGroupSiblings(['product:ext_a', 'product:ext_b'], { queryFn: qFn });
    const count = out.filter((r) => r === 'product:ext_b').length;
    expect(count).toBe(1);
  });

  test('missing product_group_members table → graceful no-op (serves base refs)', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const qFn = jest.fn(async () => { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; });
    try {
      const out = await expandAnchorRefsWithGroupSiblings(['product:ext_a'], { queryFn: qFn });
      expect(out).toEqual(['product:ext_a']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'metric',
          name: 'aurora_bff_relationship_graph_sibling_expansion_failed',
          error: 'relation does not exist',
          code: '42P01',
        }),
        expect.any(String),
      );
    } finally {
      logger.warn.mockRestore();
    }
  });

  test('transient DB error degrades to base refs', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const qFn = jest.fn(async () => { const e = new Error('terminating connection due to administrator command'); e.code = '57P01'; throw e; });
    try {
      await expect(expandAnchorRefsWithGroupSiblings(['product:ext_a'], { queryFn: qFn })).resolves.toEqual(['product:ext_a']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'metric',
          name: 'aurora_bff_relationship_graph_sibling_expansion_failed',
          error: 'terminating connection due to administrator command',
          code: '57P01',
        }),
        expect.any(String),
      );
    } finally {
      logger.warn.mockRestore();
    }
  });

  test('scopes anchor group lookup to the external_seed namespace', async () => {
    const qFn = jest.fn(async (sql, params) => {
      expect(sql).toMatch(/pgm\.merchant_id = \$2/);
      expect(sql).toMatch(/pgm\.platform = \$3/);
      expect(params).toEqual([['ext_a'], 'external_seed', 'external_seed']);
      return { rows: [] };
    });

    await expandAnchorRefsWithGroupSiblings(['product:EXT_A'], { queryFn: qFn });
    expect(qFn).toHaveBeenCalledTimes(1);
  });
});

describe('listApprovedRelationshipEdgesForAnchor alias expansion interactions', () => {
  test('flag-on transient sibling-expansion error still serves base-ref edges', async () => {
    const logger = require('../src/logger');
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const prevFamilyFlag = process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED;
    process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
    const queryFn = jest.fn(async (sql, params) => {
      if (/product_group_members/.test(sql) && !/catalog_products/.test(sql)) {
        const err = new Error('terminating connection due to administrator command');
        err.code = '57P01';
        throw err;
      }
      if (/FROM product_relationship_edges/.test(sql)) {
        return {
          rows: [
            approvedEdgeRow({
              id: 'prel_base_after_sibling_error',
              anchor_ref: 'product:ext_a',
              candidate_product_ref: 'product:ext_candidate',
              candidate_snapshot: { product_id: 'ext_candidate', brand: 'Value Brand', name: 'Candidate Serum' },
            }),
          ],
        };
      }
      if (/catalog_products/.test(sql)) {
        return {
          rows: (params[0] || []).map((ref) => {
            const normalized = String(ref || '').toLowerCase();
            const bare = normalized.replace(/^product:/, '');
            return {
              input_ref: ref,
              normalized_ref: normalized,
              source_product_id: bare,
              title: bare === 'ext_a' ? 'Anchor Serum' : 'Candidate Serum',
              brand: bare === 'ext_a' ? 'Anchor Brand' : 'Value Brand',
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
        anchorRefs: ['product:ext_a'],
        market: 'US',
        queryFn,
      });
      const rawCall = queryFn.mock.calls.find(([sql]) => /FROM product_relationship_edges/.test(sql));
      expect(rawCall[1][1]).toEqual(['product:ext_a']);
      expect(edges).toHaveLength(1);
      expect(edges[0].id).toBe('prel_base_after_sibling_error');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'aurora_bff_relationship_graph_sibling_expansion_failed',
          code: '57P01',
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

  test('dedupes equivalent candidate edges returned from sibling anchors', async () => {
    const queryFn = jest.fn(async () => ({
      rows: [
        approvedEdgeRow({ id: 'prel_primary', anchor_ref: 'product:ext_a' }),
        approvedEdgeRow({ id: 'prel_sibling', anchor_ref: 'product:ext_b', score_total: 0.88 }),
      ],
    }));

    const edges = await listApprovedRelationshipEdgesForAnchor({
      anchorRefs: ['product:ext_a', 'product:ext_b'],
      market: 'US',
      queryFn,
    });

    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe('prel_primary');
  });
});
