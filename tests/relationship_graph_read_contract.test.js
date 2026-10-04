const {
  readApprovedRelationshipEdgesForAnchor,
  readApprovedRelationshipEdgesForAnchorUncollapsed,
  listApprovedRelationshipEdgesForAnchor,
  listApprovedRelationshipEdgesForAnchorUncollapsed,
  getRelationshipGraphCandidatesForAnchor,
  getRelationshipEdgeServingSuppressionReasons,
  collapseApprovedRelationshipEdgesToFamilies,
  buildAnchorRefsFromProduct,
} = require('../src/auroraBff/productRelationshipGraph');
const {
  fetchRelationshipGraphRecallForAnchor,
  fetchRelationshipGraphRecallForAnchors,
  relationshipGraphReadMetadata,
} = require('../src/services/relationshipGraphRecall');
const { correctedAnchorFixture } = require('./fixtures/relationship_graph_corrected_anchor.cjs');
const { renderRelationshipGraphMetricsPrometheus, resetRelationshipGraphMetricsForTest } = require('../src/observability/relationshipGraphMetrics');

const flags = ['AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED', 'AURORA_BFF_RELATIONSHIP_GRAPH_PG_COLLAPSE_ENABLED'];
let savedFlags;
beforeEach(() => {
  savedFlags = flags.map((key) => process.env[key]);
  flags.forEach((key) => delete process.env[key]);
  resetRelationshipGraphMetricsForTest();
});
afterEach(() => {
  flags.forEach((key, i) => savedFlags[i] === undefined ? delete process.env[key] : process.env[key] = savedFlags[i]);
  jest.restoreAllMocks();
});
const unavailable = (code) => jest.fn(async () => { throw Object.assign(new Error('private SQL/connection details'), { code }); });

it.each([
  ['NO_DATABASE', 'no_database'], ['42P01', 'schema_unavailable'],
])('distinguishes %s from a valid empty read without changing legacy []', async (code, reason) => {
  const args = { anchorRefs: ['product:fixture_anchor'], queryFn: unavailable(code) };
  for (const read of [readApprovedRelationshipEdgesForAnchor, readApprovedRelationshipEdgesForAnchorUncollapsed]) {
    expect(await read(args)).toEqual({
      edges: [],
      diagnostics: {
        read_status: 'unavailable', read_reason: reason, edge_count_semantics: 'returned_eligible_edges',
        serving_rows_read: null, serving_guard_dropped_count: null,
      },
    });
  }
  for (const list of [listApprovedRelationshipEdgesForAnchor, listApprovedRelationshipEdgesForAnchorUncollapsed]) {
    expect(await list(args)).toEqual([]);
  }
});

it('reports only a bounded eligible miss on successful empty reads', async () => {
  const queryFn = jest.fn(async () => ({ rows: [] }));
  const result = await readApprovedRelationshipEdgesForAnchor({ anchorRefs: ['product:fixture_anchor'], queryFn, limit: 5 });
  expect(result).toEqual({ edges: [], diagnostics: {
    read_status: 'empty', read_reason: 'no_eligible_edges', edge_count_semantics: 'returned_eligible_edges',
    serving_rows_read: 0, serving_guard_dropped_count: 0,
  } });
  const [sql, args] = queryFn.mock.calls[0];
  for (const predicate of ["anchor_type = $1", "lower(anchor_ref) = ANY($2::text[])", "lower(market) = $3", "vertical = 'beauty'", "review_status = 'approved'", 'last_verified_at IS NOT NULL', 'expires_at > now()', 'LIMIT $4']) expect(sql).toContain(predicate);
  expect(args).toEqual(['product', ['product:fixture_anchor'], 'us', 10]);
  expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
});

it('does not attempt a read without an anchor', async () => {
  const queryFn = jest.fn();
  const result = await readApprovedRelationshipEdgesForAnchor({ queryFn });
  expect(result.diagnostics).toMatchObject({ read_status: 'not_attempted', read_reason: 'no_anchor_refs' });
  expect(queryFn).not.toHaveBeenCalled();
});

it('preserves thrown unexpected errors on list/read APIs', async () => {
  const args = { anchorRefs: ['product:fixture_anchor'], queryFn: unavailable('ETIMEDOUT') };
  await expect(readApprovedRelationshipEdgesForAnchor(args)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  await expect(listApprovedRelationshipEdgesForAnchor(args)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
});

it('replays the corrected complement and excludes same-product, retailer duplicates, and variants', async () => {
  const fixture = correctedAnchorFixture();
  jest.spyOn(require('../src/logger'), 'warn').mockImplementation(() => {});
  expect(getRelationshipEdgeServingSuppressionReasons(fixture.positive)).toEqual([]);
  expect(getRelationshipEdgeServingSuppressionReasons(fixture.sameProduct)).toContain('competitive_alternative_same_product_across_listings_or_sizes');
  expect(getRelationshipEdgeServingSuppressionReasons(fixture.sameListing)).toContain('related_product_same_product_across_listings_or_sizes');
  expect(getRelationshipEdgeServingSuppressionReasons(fixture.shade)).toContain('related_product_same_family_variant');
  const result = await fetchRelationshipGraphRecallForAnchors({
    anchorProducts: fixture.rows.map((row) => row.anchor_snapshot), enabled: true,
    queryFn: jest.fn(async () => ({ rows: fixture.rows })),
  });
  expect(result.metadata).toMatchObject({ read_status: 'ready', read_reason: null, edge_count: 1, item_count: 1, edge_count_semantics: 'returned_eligible_edges' });
  expect(result.edges.map((edge) => edge.id)).toEqual([fixture.positive.id]);
  expect(result.items).toEqual([expect.objectContaining({
    product_id: fixture.positive.candidate_snapshot.product_id,
    merchant_id: 'external_seed', relationship_edge_id: fixture.positive.id,
    relationship_type: 'related_product', evidence_refs: fixture.positive.source_refs,
    why_candidate: fixture.positive.why_candidate,
  })]);
  expect(result.edges[0].anchor_snapshot.product_line_id).toBe(result.edges[0].candidate_snapshot.product_line_id);
  expect(result.edges[0].anchor_snapshot.product_group_id).not.toBe(result.edges[0].candidate_snapshot.product_group_id);
});

it.each([['NO_DATABASE', 'no_database'], ['42P01', 'schema_unavailable'], ['ETIMEDOUT', 'read_failed']])('propagates %s on single and multi-anchor recall without serving items', async (code, reason) => {
  const anchor = { product_id: 'fixture_anchor' };
  for (const run of [
    () => fetchRelationshipGraphRecallForAnchor({ anchorProduct: anchor, enabled: true, queryFn: unavailable(code) }),
    () => fetchRelationshipGraphRecallForAnchors({ anchorProducts: [anchor], enabled: true, queryFn: unavailable(code) }),
  ]) {
    const result = await run();
    expect(result.items).toEqual([]);
    expect(result.metadata).toMatchObject({ edge_count: 0, read_status: 'unavailable', read_reason: reason });
    expect(JSON.stringify(relationshipGraphReadMetadata(result.metadata))).not.toContain('private SQL');
  }
  expect(renderRelationshipGraphMetricsPrometheus()).toContain(code === 'ETIMEDOUT' ? 'status="error"' : 'status="unavailable"');
});

it('reports the BFF provider unavailable separately from a miss', async () => {
  const result = await getRelationshipGraphCandidatesForAnchor({ anchor: { product_id: 'fixture_anchor' }, queryFn: unavailable('42P01') });
  expect(result.meta).toMatchObject({ relationship_graph_read_status: 'unavailable', reason_counts: { relationship_graph_unavailable: 1 } });
});

it('keeps unavailable status when family collapse is enabled', async () => {
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
  const result = await readApprovedRelationshipEdgesForAnchor({ anchorRefs: ['product:fixture_anchor'], queryFn: unavailable('42P01') });
  expect(result.diagnostics.read_status).toBe('unavailable');
});

it('does not invent read status for legacy cached metadata or expose arbitrary diagnostics', () => {
  expect(relationshipGraphReadMetadata(null).relationship_graph_read_status).toBe('unknown');
  expect(relationshipGraphReadMetadata({ edge_count: 0 })).toEqual({
    relationship_graph_read_status: 'unknown', relationship_graph_read_reason: null,
    relationship_graph_edge_count_semantics: 'returned_eligible_edges',
  });
  expect(relationshipGraphReadMetadata({ read_status: 'private_connection', read_reason: 'secret', evidence: { token: 'secret' } }).relationship_graph_read_reason).toBeNull();
});

it('keeps a typed complement across known distinct groups despite shared line/review-family axes', () => {
  const fixture = correctedAnchorFixture();
  const collapsed = collapseApprovedRelationshipEdgesToFamilies([fixture.positive]);
  expect(collapsed).toHaveLength(1);
  expect(collapsed[0].relation_type).toBe('related_product');
  const refs = buildAnchorRefsFromProduct(fixture.anchor);
  expect(refs).not.toContain('product:fixture_line_shared');
  expect(refs).not.toContain('product:fixture_reviews_shared');
});

it('family collapse reports empty if it removes a self-family edge', async () => {
  process.env.AURORA_BFF_RELATIONSHIP_GRAPH_FAMILY_COLLAPSE_ENABLED = 'true';
  jest.spyOn(require('../src/logger'), 'info').mockImplementation(() => {});
  const fixture = correctedAnchorFixture();
  const row = { ...fixture.positive, label_state: 'human_approved',
    candidate_product_ref: fixture.positive.anchor_ref,
    candidate_snapshot: fixture.positive.anchor_snapshot };
  const queryFn = jest.fn(async (sql) => ({ rows: sql.includes('FROM product_relationship_edges') ? [row] : [] }));
  const result = await readApprovedRelationshipEdgesForAnchor({ anchorRefs: [row.anchor_ref], queryFn });
  expect(result.edges).toEqual([]);
  expect(result.diagnostics).toMatchObject({ read_status: 'empty', read_reason: 'no_eligible_edges', serving_rows_read: 1, family_collapse_status: 'completed' });
});
