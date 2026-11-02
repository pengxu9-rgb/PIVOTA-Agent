const {
  applyApproval, applyGuardBlock, applyConsensusDisposition, validateRecommendationDecision, consumerCopyForKind, rememberNegativeVerdict,
} = require('../scripts/review-relationship-candidate-labels');
const { recordRelationshipGraphRun } = require('../src/services/relationshipGraphRunLedger');
const { loadProductRelationshipGraphTargetRecall } = require('../src/auroraBff/productRelationshipGraphTargetRecall');
const { filterProductsByCatalogServingGate } = require('../src/auroraBff/relationshipCatalogServingGate');
const { upsertBeautyAttributes } = require('../src/auroraBff/productBeautyAttributes');
const { writeManifestBatch } = require('../src/services/relgraphOpsManifest');
const { upsertRelationshipCandidateLabel, upsertRelationshipEdge } = require('../src/auroraBff/productRelationshipGraph');
const { reviewErrorRelayLine } = require('../src/services/relationshipGraphServingProgress');

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

// NUL is refused in a TEXT parameter too (22021, "invalid byte sequence for encoding UTF8: 0x00"):
// the label and edge upserts bind ids, labels, use_case, flags and reasons as text, and one refused
// row would abort the build exactly as the 2026-11-02 jsonb refusal did.
const NUL = '\u0000';
const NOW_MS = Date.now();
const edgeFixture = (overrides = {}) => ({
  anchor_type: 'product', anchor_ref: 'product:anchor_1',
  anchor_snapshot: { product_id: 'anchor_1', brand: 'Top Brand', name: 'Luxury Barrier Serum', category_taxonomy: ['skincare', 'serum'], price: 100 },
  candidate_product_ref: 'product:candidate_1',
  candidate_snapshot: { product_id: 'candidate_1', brand: 'Value Brand', name: 'Barrier Serum Alternative', category_taxonomy: ['skincare', 'serum'],
    price: 80, url: 'https://example.test/candidate' },
  relation_type: 'dupe', market: 'US', category_taxonomy: ['skincare', 'serum'], use_case: 'barrier serum', score_total: 0.86,
  score_breakdown: { category_use_case_match: 0.91, ingredient_functional_similarity: 0.84, score_total: 0.86 },
  price_evidence: { anchor_price_amount: 100, candidate_price_amount: 80, price_ratio: 0.8, observed_at: new Date(NOW_MS).toISOString() },
  source_refs: [{ type: 'products_cache', authoritative: true }], evidence_grade: 'A', review_status: 'approved',
  why_candidate: { summary: 'Similar product type and function at a lower price.', reasons_user_visible: ['Category and price evidence are present.'] },
  last_verified_at: new Date(NOW_MS).toISOString(), expires_at: new Date(NOW_MS + 7 * 86400000).toISOString(), ...overrides,
});
const noNulOrHalf = (params) => {
  for (const value of params.flatMap((p) => (Array.isArray(p) ? p : [p]))) {
    if (typeof value !== 'string') continue;
    expect(value).not.toContain(NUL);
    expect(value).not.toMatch(LONE_CHAR);
  }
};

test.each([
  ['use_case', { use_case: `barrier${NUL} serum` }],
  ['display_label', { display_label: `budget${NUL}` }],
  ['source_report', { source_report: `report${NUL}` }],
  ['reason_flags', { reason_flags: [`flag${NUL}`, `half ${HALF}`] }],
  ['anchor_ref', { anchor_ref: `product:anchor${NUL}_w` }],
])('the label upsert binds no NUL or lone half in a text parameter (%s)', async (_field, extra) => {
  const { calls, queryFn } = capture();
  await upsertRelationshipCandidateLabel({ ...labelRow(), label_state: 'generated', ...extra }, { queryFn });
  expect(calls).toHaveLength(1);
  noNulOrHalf(calls[0].params);
});

test.each([
  ['use_case', { use_case: `barrier${NUL} serum` }],
  ['evidence_grade', { evidence_grade: `A${NUL}` }],
])('the edge upsert binds no NUL in a text parameter (%s)', async (_field, extra) => {
  const { calls, queryFn } = capture();
  await upsertRelationshipEdge(edgeFixture(extra), { queryFn, nowMs: NOW_MS });
  expect(calls).toHaveLength(1);
  noNulOrHalf(calls[0].params);
});

test('jsonb parameters pass through the text repair unchanged', async () => {
  const { calls, queryFn } = capture();
  await upsertRelationshipEdge(edgeFixture({ anchor_snapshot: { product_id: 'anchor_1', brand: 'Top Brand', name: `Serum ${NUL}${HALF}`,
    category_taxonomy: ['skincare', 'serum'], price: 100 } }), { queryFn, nowMs: NOW_MS });
  const snapshot = calls[0].params[3];
  expect(JSON.parse(snapshot).name).toBe('Serum \uFFFD');
});

test('the review-errors relay repairs a provider message cut through an emoji', () => {
  const parsed = JSON.parse(reviewErrorRelayLine([{ id: 'a', verdict: 'error', review_error: { code: 'LLM_PARSE_FAILED', message: `output ${HALF}` } }]));
  expect(parsed.samples[0].message).toBe('output \uFFFD');
});

