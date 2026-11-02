const {
  applyApproval, applyGuardBlock, applyConsensusDisposition, validateRecommendationDecision, consumerCopyForKind, rememberNegativeVerdict,
} = require('../scripts/review-relationship-candidate-labels');
const { recordRelationshipGraphRun } = require('../src/services/relationshipGraphRunLedger');
const { loadProductRelationshipGraphTargetRecall } = require('../src/auroraBff/productRelationshipGraphTargetRecall');
const { filterProductsByCatalogServingGate } = require('../src/auroraBff/relationshipCatalogServingGate');
const { upsertBeautyAttributes } = require('../src/auroraBff/productBeautyAttributes');
const { writeManifestBatch } = require('../src/services/relgraphOpsManifest');
const { upsertRelationshipCandidateLabel } = require('../src/auroraBff/productRelationshipGraph');

// Every relationship-graph writer that binds product or model text to a parameter, fed text with a
// lone surrogate half (what a code-unit cut through an emoji leaves). None may hand Postgres one: in a
// jsonb parameter it is refused ("invalid input syntax for type json", 2026-11-02), in a text
// parameter it is silently stored as U+FFFD.
const HALF = '\uD83C';
const LONE_ESCAPE = /\\ud[89a-f][0-9a-f]{2}/i;
const LONE_CHAR = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function capture() {
  const calls = [];
  const queryFn = jest.fn(async (sql, params = []) => { calls.push({ sql, params }); return { rows: [{ id: params[0] }], rowCount: 1 }; });
  return { calls, queryFn };
}
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  return out;
}

const toner = (brand, title) => ({ product_id: `${brand}-${title}`, brand, title, name: title, category: 'toner', price: 30, price_currency: 'USD',
  ingredient_text: 'Water, Niacinamide, Allantoin, Panthenol, Squalane' });
const labelRow = (extra = {}) => ({ id: 'prel_w', edge_id: 'prel_w', anchor_type: 'product', anchor_ref: 'product:anchor_w', candidate_product_ref: 'product:cand_w',
  anchor_snapshot: { ...toner('Brand A', `Calming Toner ${HALF}`), product_id: 'anchor_w' },
  candidate_snapshot: { ...toner('Brand B', 'Soothing Toner'), product_id: 'cand_w' },
  relation_type: 'competitive_alternative', market: 'US', vertical: 'beauty', label_state: 'generated', score_total: 0.9,
  score_breakdown: { category_use_case_match: 0.9 }, source_refs: [{ type: 'catalog_products', name: `seed ${HALF}` }], provenance: {},
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', review_row_version: '2026-10-01 00:00:00+00', ...extra });

const WRITERS = [
  ['review approval (ai_review, why_candidate, tradeoffs, watchouts)', async (queryFn) => {
    const row = labelRow();
    const decision = validateRecommendationDecision(row, { verdict: 'approve', confidence: 0.9, relationship_kind: 'alternative',
      rationale: `Shared job and actives from the supplied facts ${HALF}`, ...consumerCopyForKind('alternative'),
      shared_evidence: [{ anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' }] });
    await applyApproval(row, decision, queryFn);
  }],
  ['review negative memo', async (queryFn) => {
    await rememberNegativeVerdict({ id: 'prel_w' }, { verdict: 'reject', rationale: `no ${HALF}`, reviewed_at: '2026-11-02T00:00:00Z' }, queryFn);
  }],
  // Guard reasons are the guard's own codes; this writer binds no product or model text, so the case
  // only proves the row's text is not carried into its parameters.
  ['review serving-guard block', async (queryFn) => {
    await applyGuardBlock(labelRow(), ['competitive_alternative_fragrance_no_shared_scent_family'], queryFn, { runId: 'run_w' });
  }, { freeText: false }],
  ['review consensus disposition (cross_agent_review and the row-revision CAS)', async (queryFn) => {
    await applyConsensusDisposition(labelRow({ provenance: { curated_pair_evidence: { note: `curated ${HALF}` } } }),
      { verdict: 'human_review', cross_agent_review: { escalation_reason: 'reviewer_uncertain', rationale: `split ${HALF}` } }, queryFn, { runId: 'run_w' });
  }],
  ['run ledger summary', async (queryFn) => {
    await recordRelationshipGraphRun({ run_id: 'relgraph_sync_routine_w', status: 'failed', stderr_tail: `tail ${HALF}` }, { queryFn });
  }],
  ['target recall profiles', async (queryFn) => {
    await loadProductRelationshipGraphTargetRecall({ queryFn, market: 'US',
      anchors: [{ product_ref: 'product:anchor_w', product_id: 'anchor_w', brand: `Brand ${HALF}`, title: `Calming Toner ${HALF}`,
        category: 'toner', category_path: ['skincare', 'toner'], use_case_tags: [`hydrating ${HALF}`] }] });
  }],
  ['catalog serving gate subjects', async (queryFn) => {
    await filterProductsByCatalogServingGate([{ product_ref: `product:sig_w${HALF}`, product_id: `sig_w${HALF}`, pivota_signature_id: `w${HALF}` }], { queryFn });
  }],
  ['beauty attributes raw_extraction', async (queryFn) => {
    await upsertBeautyAttributes({ product_key: 'pk_w', extractor_version: 'v1', raw_extraction: { model_text: `cut ${HALF}`, [`k${HALF}`]: 1 } }, { queryFn });
  }],
  ['ops manifest batch', async (queryFn) => {
    await writeManifestBatch({ queryFn, runId: 'ops_w', kind: 'rescore', batchIndex: 0, rows: [{ id: 'prel_w', title: `t ${HALF}` }] });
  }],
];

describe.each(WRITERS)('%s', (_name, write, { freeText = true } = {}) => {
  test('binds no lone surrogate half', async () => {
    const { calls, queryFn } = capture();
    await write(queryFn);
    const bound = calls.flatMap(({ params }) => strings(params));
    expect(calls.length).toBeGreaterThan(0);
    // The fixture's text reached a parameter, repaired (else the case proves nothing).
    if (freeText) expect(bound.some((value) => value.includes('\uFFFD'))).toBe(true);
    for (const value of bound) {
      expect(value).not.toMatch(LONE_ESCAPE);
      expect(value).not.toMatch(LONE_CHAR);
    }
  });
});

test('the label upsert still stores an unserialisable value as JSON null rather than failing the row', async () => {
  // safeJsonbParam throws on a cycle like JSON.stringify; the upsert's own helper always stored null.
  const { calls, queryFn } = capture();
  const cyclic = { note: 'x' }; cyclic.self = cyclic;
  await upsertRelationshipCandidateLabel({ ...labelRow(), label_state: 'generated', score_breakdown: cyclic }, { queryFn });
  const params = calls[0].params;
  expect(params).toContain('null');
  expect(params.filter((p) => typeof p === 'string').every((p) => !LONE_ESCAPE.test(p))).toBe(true);
});

