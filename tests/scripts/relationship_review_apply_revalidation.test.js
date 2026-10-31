const {
  validateRecommendationDecision, consumerCopyForKind, applyApproval, runReview, APPROVAL_BLOCKED_CODES,
} = require('../../scripts/review-relationship-candidate-labels');
const { reviewMetrics } = require('../../src/services/relationshipGraphServingProgress');

// 2026-10-31: the nightly review aborted at apply with "AI approval lacks matching recommendation
// utility evidence". The review validates the model's approval (grounding its quotes in the products'
// facts) and applyApproval validates the decision it is handed AGAIN, on the quotes the first pass
// kept. An elided quote is stored as the fact's own text from its first part to its last, which can
// outgrow the 350-character quote cap; read back cut mid-word, it no longer grounded, so the second
// validation refused what the first had approved, and the throw stopped the whole run.
const product = (brand, title, other = {}) => ({ product_id: `${brand}-${title}`, brand, title, name: title, price: 30, price_currency: 'USD', ...other });
// One description whose three sentences an elided quote spans across two long, neutral gaps.
const GAP = 'Lightweight daily formula that layers easily under makeup and sunscreen and sinks in within seconds leaving comfortable finish on cheeks';
const LONG_DESCRIPTION = `Gently calms visible redness. ${GAP}. Panthenol supports the moisture barrier. ${GAP}. Allantoin soothes after cleansing.`;
const ELIDED_QUOTE = 'Gently calms visible redness ... Panthenol supports the moisture barrier ... Allantoin soothes after cleansing';
const toner = (brand, title, other = {}) => product(brand, title, { category: 'toner', ...other });
const ANCHOR = toner('FINDIVE', 'Calming Toner', { ingredient_text: 'Water, Niacinamide, Allantoin, Panthenol', description: LONG_DESCRIPTION });
const CANDIDATE = toner('DERMAFIRM', 'Soothing Toner', { ingredient_text: 'Water, Glycerin, Niacinamide, Allantoin' });

const labelRow = (id, anchor = ANCHOR, candidate = CANDIDATE) => ({
  id, edge_id: id, anchor_type: 'product', anchor_ref: `product:anchor_${id}`, candidate_product_ref: `product:candidate_${id}`,
  anchor_snapshot: { ...anchor, product_id: `anchor_${id}` }, candidate_snapshot: { ...candidate, product_id: `candidate_${id}` },
  relation_type: 'competitive_alternative', market: 'US', vertical: 'beauty', label_state: 'generated', score_total: 0.9,
  score_breakdown: { category_use_case_match: 0.9 }, source_refs: [{ type: 'catalog_products' }], provenance: {},
  created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
});
const approve = (shared_evidence, overrides = {}) => ({ verdict: 'approve', confidence: 0.9, rationale: 'Shared job and actives from the supplied facts.',
  relationship_kind: 'alternative', ...consumerCopyForKind('alternative'), shared_evidence, ...overrides });
const SHORT_QUOTE = { anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' };
const LONG_QUOTE = { anchor_fact: ELIDED_QUOTE, candidate_fact: 'Soothing Toner' };

const twice = (row, decision) => {
  const first = validateRecommendationDecision(row, decision);
  return [first, validateRecommendationDecision(row, first)];
};

describe('validating an approved decision again gives the same verdict (idempotent)', () => {
  test('an elided passage longer than the quote cap is not kept, so the second pass agrees with the first', () => {
    const row = labelRow('long_only');
    const [first, second] = twice(row, approve([LONG_QUOTE]));
    // Before the fix: first = approve (a 380-character passage stored), second = reject.
    expect(second.verdict).toBe(first.verdict);
    expect(first.verdict).toBe('reject');
    expect(first.utility_rejection).toBe('recommendation_facts_not_supplied');
  });

  test('beside a quote that holds, the long passage is dropped and the approval is stable', () => {
    const row = labelRow('long_and_short');
    const [first, second] = twice(row, approve([LONG_QUOTE, SHORT_QUOTE]));
    expect(first.verdict).toBe('approve');
    expect(first.shared_evidence).toEqual([{ anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' }]);
    expect(second.verdict).toBe('approve');
    expect(second.shared_evidence).toEqual(first.shared_evidence);
  });

  test('an elided passage within the cap is still kept whole, and stays the same on the second pass', () => {
    const anchor = { ...ANCHOR, description: 'Gently calms redness. Lightweight watery texture absorbs fast.' };
    const row = labelRow('short_passage', anchor);
    const [first, second] = twice(row, approve([{ anchor_fact: 'Gently calms redness ... watery texture absorbs fast', candidate_fact: 'Soothing Toner' }]));
    expect(first.verdict).toBe('approve');
    expect(first.shared_evidence[0].anchor_fact).toBe('Gently calms redness. Lightweight watery texture absorbs fast');
    expect(second).toEqual(first);
  });

  test('applyApproval accepts every decision the review approved, and writes what the review kept', async () => {
    const writes = [];
    const queryFn = async (sql, params) => { writes.push({ sql, params }); return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: 'ai_approved' }] }; };
    const row = labelRow('apply_after_validate');
    const validated = validateRecommendationDecision(row, approve([LONG_QUOTE, SHORT_QUOTE]));
    await expect(applyApproval(row, validated, queryFn)).resolves.toEqual(expect.objectContaining({ new_label_state: 'ai_approved' }));
    const why = JSON.parse(writes[0].params[3]);
    expect(why.shared_evidence).toEqual([{ anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' }]);
  });
});

test('every row-level refusal applyApproval throws is one the review records instead of aborting on', async () => {
  const queryFn = jest.fn(async () => ({ rows: [] }));
  const refusal = async (row, decision) => applyApproval(row, decision, queryFn).then(() => null, (err) => err.code);
  const variant = (title) => toner('LASHFIX', title, { category: 'False Lashes' });
  const variantRow = { ...labelRow('variant', variant('LASHFIX Pre-Glued False Eyelashes - Demi Soft | 48 Clusters'),
    variant('LASHFIX Pre-Glued False Eyelashes - Demi Bold | 48 Clusters')), relation_type: 'related_product' };
  const codes = [
    await refusal(labelRow('low'), approve([SHORT_QUOTE], { confidence: 0.2 })),
    await refusal({ ...labelRow('dupe'), relation_type: 'dupe' }, approve([SHORT_QUOTE])),
    await refusal(variantRow, approve([SHORT_QUOTE], { relationship_kind: 'complement', ...consumerCopyForKind('complement') })),
    await refusal(labelRow('invented'), approve([{ anchor_fact: 'clinically proven 48 hour hydration', candidate_fact: 'Soothing Toner' }])),
  ];
  expect(codes).toEqual(['LOW_CONFIDENCE_AI_APPROVAL_BLOCKED', 'DUPE_AI_APPROVAL_BLOCKED', 'SERVING_GUARD_AI_APPROVAL_BLOCKED',
    'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED']);
  expect([...APPROVAL_BLOCKED_CODES].sort()).toEqual([...codes].sort());
  expect(queryFn).not.toHaveBeenCalled();
});

describe('a row whose approval is refused at apply does not abort the review', () => {
  let savedApply;
  beforeEach(() => { savedApply = process.env.RELGRAPH_AI_REVIEW_APPLY; process.env.RELGRAPH_AI_REVIEW_APPLY = '1'; });
  afterEach(() => {
    if (savedApply === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
    else process.env.RELGRAPH_AI_REVIEW_APPLY = savedApply;
    jest.restoreAllMocks();
  });

  const rows = ['row_ok_1', 'row_odd', 'row_ok_2', 'row_ok_3'].map((id) => labelRow(id));
  // The prompt carries the evidence, and so the row's own anchor id.
  const providerFor = (byId) => ({
    analyzeTextToJson: jest.fn(async ({ prompt }) => {
      const id = rows.map((row) => row.id).find((candidate) => prompt.includes(`anchor_${candidate}`));
      return byId[id] || approve([SHORT_QUOTE]);
    }),
  });
  const fakeDb = ({ failUpdateFor = null } = {}) => jest.fn(async (sql, params) => {
    if (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql)) return { rows };
    if (/SET\s+label_state = 'ai_approved'/.test(sql)) {
      if (params[0] === failUpdateFor) {
        const err = new Error('terminating connection due to administrator command');
        err.code = '57P01';
        throw err;
      }
      return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: 'ai_approved' }] };
    }
    return { rows: [] };
  });
  const approvedIds = (queryFn) => queryFn.mock.calls
    .filter(([sql]) => /SET\s+label_state = 'ai_approved'/.test(sql)).map(([, params]) => params[0]).sort();
  const run = (queryFn, provider) => runReview({
    cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, apply: true, concurrency: 2, negativeTtlDays: 0, queryFn, provider,
  });

  test('the prod shape: a long elided quote among several rows is rejected once, the rest are applied', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const queryFn = fakeDb();
    const result = await run(queryFn, providerFor({ row_odd: approve([LONG_QUOTE]) }));
    expect(approvedIds(queryFn)).toEqual(['row_ok_1', 'row_ok_2', 'row_ok_3']);
    const odd = result.decisions.find((d) => d.id === 'row_odd');
    expect(odd).toEqual(expect.objectContaining({ verdict: 'reject', utility_rejection: 'recommendation_facts_not_supplied', applied: false }));
    expect(result.summary).toEqual(expect.objectContaining({ reviewed_count: 4, approved_count: 3, approved_applied_count: 3,
      approval_blocked_count: 0 }));
  });

  test('an approval refused by apply\'s re-check is recorded as approval_blocked, counted by code, and not written', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const queryFn = fakeDb();
    // A provider answer without a finite confidence passes the review's floor check (NaN < floor is
    // false) and is refused by applyApproval's own (LOW_CONFIDENCE_AI_APPROVAL_BLOCKED).
    const result = await run(queryFn, providerFor({ row_odd: approve([SHORT_QUOTE], { confidence: undefined }) }));
    expect(approvedIds(queryFn)).toEqual(['row_ok_1', 'row_ok_2', 'row_ok_3']);
    const odd = result.decisions.find((d) => d.id === 'row_odd');
    expect(odd).toEqual(expect.objectContaining({
      verdict: 'approval_blocked', applied: false, new_label_state: 'generated',
      approval_blocked: expect.objectContaining({ code: 'LOW_CONFIDENCE_AI_APPROVAL_BLOCKED' }),
    }));
    expect(result.summary).toEqual(expect.objectContaining({
      reviewed_count: 4, approved_count: 3, approved_applied_count: 3, applied_count: 3, unclaimed_count: 0,
      approval_blocked_count: 1, approval_blocked_by_code: { LOW_CONFIDENCE_AI_APPROVAL_BLOCKED: 1 },
    }));
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toMatch(/approval refused at apply.*row_odd.*LOW_CONFIDENCE_AI_APPROVAL_BLOCKED/);
    // The routine summary carries the count.
    expect(reviewMetrics(result.summary)).toEqual(expect.objectContaining({
      approval_blocked_count: 1, approval_blocked_by_code: { LOW_CONFIDENCE_AI_APPROVAL_BLOCKED: 1 },
    }));
  });

  test('a database error at apply still fails the run', async () => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const queryFn = fakeDb({ failUpdateFor: 'row_odd' });
    await expect(run(queryFn, providerFor({}))).rejects.toThrow('terminating connection due to administrator command');
  });

  test('a verdict replay of an --out file skips approval_blocked rows instead of refusing the file', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-review-replay-'));
    const verdictsFile = path.join(dir, 'review.json');
    fs.writeFileSync(verdictsFile, JSON.stringify({ decisions: [
      { id: 'row_ok_1', ...approve([SHORT_QUOTE]) },
      { id: 'row_blocked', verdict: 'approval_blocked', confidence: 0, rationale: 'approval refused at apply (LOW_CONFIDENCE_AI_APPROVAL_BLOCKED)' },
    ] }));
    const queryFn = jest.fn(async (sql) => (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql) ? { rows: [rows[0]] } : { rows: [] }));
    const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, verdictsFile, queryFn, negativeTtlDays: 0 });
    expect(result.summary).toEqual(expect.objectContaining({ verdicts_file_count: 1, approved_count: 1 }));
  });
});
