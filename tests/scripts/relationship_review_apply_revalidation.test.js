const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateRecommendationDecision, consumerCopyForKind, applyApproval, runReview, buildEvidence, APPROVAL_BLOCKED_CODES,
  REVALIDATION_MISMATCH_MARKER, approvalBlockedLogLines, __quoteGrounding: { groundQuotePairs, capPassage },
} = require('../../scripts/review-relationship-candidate-labels');
const { reviewMetrics, reviewErrorGateExceeded } = require('../../src/services/relationshipGraphServingProgress');
const { runRoutineJob, parseArgs: routineArgs } = require('../../scripts/run-relationship-graph-routine-job');

// 2026-10-31: the nightly review aborted at apply with "AI approval lacks matching recommendation
// utility evidence". The review validates the model's approval (grounding its quotes in the products'
// facts) and applyApproval validates the decision it is handed AGAIN, on the quotes the first pass
// kept. An elided quote is stored as the fact's own text from its first part to its last, which can
// outgrow the 350-character quote cap; read back cut mid-word, it no longer grounded, so the second
// validation refused what the first had approved, and the throw stopped the whole run.
const product = (brand, title, other = {}) => ({ product_id: `${brand}-${title}`, brand, title, name: title, price: 30, price_currency: 'USD', ...other });
const INGREDIENTS = 'Water, Niacinamide, Allantoin, Panthenol, Squalane, Ceramide NP, Madecassoside';
const toner = (brand, title, other = {}) => product(brand, title, { category: 'toner', ingredient_text: INGREDIENTS, ...other });

// Anchor: three sentences an elided quote spans across two long, neutral stretches (a 380-character
// passage whose 350-character cut lands mid-word).
const GAP = 'Lightweight daily formula that layers easily under makeup and sunscreen and sinks in within seconds leaving comfortable finish on cheeks';
const LONG_DESCRIPTION = `Gently calms visible redness. ${GAP}. Panthenol supports the moisture barrier. ${GAP}. Allantoin soothes after cleansing.`;
const LONG_PASSAGE = LONG_DESCRIPTION.slice(0, -1);
const ELIDED_QUOTE = 'Gently calms visible redness ... Panthenol supports the moisture barrier ... Allantoin soothes after cleansing';
// The same shape whose last sentence carries a caveat: cutting it off would change what it says.
const CAVEAT_DESCRIPTION = `Gently calms visible redness. ${GAP}. Panthenol supports the moisture barrier. ${GAP}. Allantoin soothes irritated skin without stinging.`;
const CAVEAT_QUOTE = 'Gently calms visible redness ... Panthenol supports the moisture barrier ... Allantoin soothes irritated skin without stinging';
// Candidate: a passage over the cap whose 350-character cut lands on a word boundary.
const CGAP = 'Pairs well with light serums and emulsions and absorbs within a minute leaving skin balanced and comfortable through the afternoon';
const BOUNDARY_DESCRIPTION = `Balances oily zones swift. ${CGAP}. Rice water brightens dull areas. ${CGAP}. Ceramides help the barrier overnight.`;
const BOUNDARY_QUOTE = 'Balances oily zones swift ... Rice water brightens dull areas ... Ceramides help the barrier overnight';
// Candidate: "Tags: balancing toner" grounds in the description; read back alone, "Tags:" is taken as
// the key and the fact becomes "balancing toner", from the tags field.
const REKEYED = { tags: ['balancing toner'], description: 'Tags: balancing toner with rice water.' };
const REKEYED_QUOTE = { anchor_fact: 'Calming Toner', candidate_fact: 'description": "Tags: balancing toner' };

const ANCHOR = toner('Fixture Brand A', 'Calming Toner', { description: LONG_DESCRIPTION });
const CANDIDATE = toner('Fixture Brand B', 'Soothing Toner', { description: BOUNDARY_DESCRIPTION });

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
const INVENTED_QUOTE = { anchor_fact: 'clinically proven 48 hour hydration', candidate_fact: 'Soothing Toner' };

const twice = (row, decision) => {
  const first = validateRecommendationDecision(row, decision);
  return [first, validateRecommendationDecision(row, first)];
};

describe('validating an approved decision again gives the same result (idempotent)', () => {
  test('an over-cap passage cut mid-word on a second read is stored cut at its last whole word, and stays so', () => {
    const [first, second] = twice(labelRow('mid_word'), approve([LONG_QUOTE]));
    // Before the fix: first = approve with the 380-character passage, second = reject.
    expect(LONG_PASSAGE.length).toBeGreaterThan(350);
    expect(LONG_PASSAGE[350]).toMatch(/\p{L}/u);
    expect(first.verdict).toBe('approve');
    const stored = first.shared_evidence[0].anchor_fact;
    expect(stored.length).toBeLessThanOrEqual(350);
    expect(LONG_PASSAGE.startsWith(stored)).toBe(true);
    expect(LONG_PASSAGE[stored.length]).toBe(' ');
    expect(stored).toMatch(/^Gently calms visible redness\. .* on cheeks\.$/);
    expect(second).toEqual(first);
  });

  test('candidate side: an over-cap passage whose 350 cut lands on a word boundary keeps exactly that cut, on both passes', () => {
    const passage = BOUNDARY_DESCRIPTION.slice(0, -1);
    expect(passage.length).toBeGreaterThan(350);
    expect(passage[350]).toBe(' ');
    const [first, second] = twice(labelRow('boundary'), approve([{ anchor_fact: 'Calming Toner', candidate_fact: BOUNDARY_QUOTE }]));
    expect(first.verdict).toBe('approve');
    // What main wrote for this shape (its 350-character cut), now also what the review keeps.
    expect(first.shared_evidence).toEqual([{ anchor_fact: 'Calming Toner', candidate_fact: passage.slice(0, 350) }]);
    expect(second).toEqual(first);
  });

  test('a cut that would drop a caveat is refused: the pair is not kept, alone it is a reject on both passes', () => {
    const row = labelRow('caveat', toner('Fixture Brand A', 'Calming Toner', { description: CAVEAT_DESCRIPTION }));
    expect(capPassage(CAVEAT_DESCRIPTION.slice(0, -1))).toBe('');
    const caveat = { anchor_fact: CAVEAT_QUOTE, candidate_fact: 'Soothing Toner' };
    const [first, second] = twice(row, approve([caveat]));
    expect(first).toEqual(expect.objectContaining({ verdict: 'reject', utility_rejection: 'recommendation_facts_not_supplied' }));
    expect(second.verdict).toBe('reject');
    const [kept, again] = twice(row, approve([caveat, SHORT_QUOTE]));
    expect(kept.verdict).toBe('approve');
    expect(kept.shared_evidence).toEqual([SHORT_QUOTE]);
    expect(again).toEqual(kept);
  });

  test('candidate side: a fact that re-reads as a different fact is not kept (the read-back backstop)', () => {
    const row = labelRow('rekeyed', ANCHOR, toner('Fixture Brand B', 'Soothing Toner', REKEYED));
    const [first, second] = twice(row, approve([REKEYED_QUOTE, SHORT_QUOTE]));
    expect(first.verdict).toBe('approve');
    expect(first.shared_evidence).toEqual([SHORT_QUOTE]);
    expect(second).toEqual(first);
  });

  test('what is kept is a subset of the first six grounded pairs: a dropped pair never lets a seventh in', () => {
    const row = labelRow('six_cap', ANCHOR, toner('Fixture Brand B', 'Soothing Toner', REKEYED));
    const quotes = [
      REKEYED_QUOTE, // pair 1, does not read back
      { anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' },
      { anchor_fact: 'allantoin', candidate_fact: 'Allantoin' },
      { anchor_fact: 'panthenol', candidate_fact: 'Panthenol' },
      { anchor_fact: 'squalane', candidate_fact: 'Squalane' },
      { anchor_fact: 'ingredients": ["Ceramide NP", "Madecassoside"]', candidate_fact: 'Madecassoside' }, // pairs 6 and 7
    ];
    const grounded = groundQuotePairs(quotes, buildEvidence(row, new Map()));
    expect(grounded).toHaveLength(7);
    const [first, second] = twice(row, approve(quotes));
    expect(first.verdict).toBe('approve');
    expect(first.shared_evidence).toEqual(grounded.slice(1, 6));
    expect(first.shared_evidence).not.toContainEqual(grounded[6]);
    expect(second).toEqual(first);
  });

  test('a passage within the cap is still kept whole, unchanged on the second pass', () => {
    const anchor = toner('Fixture Brand A', 'Calming Toner', { description: 'Gently calms redness. Lightweight watery texture absorbs fast.' });
    const [first, second] = twice(labelRow('short_passage', anchor),
      approve([{ anchor_fact: 'Gently calms redness ... watery texture absorbs fast', candidate_fact: 'Soothing Toner' }]));
    expect(first.verdict).toBe('approve');
    expect(first.shared_evidence[0].anchor_fact).toBe('Gently calms redness. Lightweight watery texture absorbs fast');
    expect(second).toEqual(first);
  });

  test('applyApproval accepts a decision the review approved, and writes what the review kept', async () => {
    const writes = [];
    const queryFn = async (sql, params) => { writes.push({ sql, params }); return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: 'ai_approved' }] }; };
    const row = labelRow('apply_after_validate');
    const validated = validateRecommendationDecision(row, approve([LONG_QUOTE, SHORT_QUOTE]));
    await expect(applyApproval(row, validated, queryFn)).resolves.toEqual(expect.objectContaining({ new_label_state: 'ai_approved' }));
    expect(JSON.parse(writes[0].params[3]).shared_evidence).toEqual(validated.shared_evidence);
  });
});

test('every row-level refusal applyApproval throws is one the review records instead of aborting on', async () => {
  const queryFn = jest.fn(async () => ({ rows: [] }));
  const refusal = async (row, decision) => applyApproval(row, decision, queryFn).then(() => null, (err) => err.code);
  const variant = (title) => toner('Fixture Brand C', title, { category: 'False Lashes' });
  const variantRow = { ...labelRow('variant', variant('Fixture Brand C Pre-Glued False Eyelashes - Style One | 40 Clusters'),
    variant('Fixture Brand C Pre-Glued False Eyelashes - Style Two | 40 Clusters')), relation_type: 'related_product' };
  const codes = [
    await refusal(labelRow('low'), approve([SHORT_QUOTE], { confidence: 0.2 })),
    await refusal({ ...labelRow('dupe'), relation_type: 'dupe' }, approve([SHORT_QUOTE])),
    await refusal(variantRow, approve([SHORT_QUOTE], { relationship_kind: 'complement', ...consumerCopyForKind('complement') })),
    await refusal(labelRow('invented'), approve([INVENTED_QUOTE])),
  ];
  expect(codes).toEqual(['LOW_CONFIDENCE_AI_APPROVAL_BLOCKED', 'DUPE_AI_APPROVAL_BLOCKED', 'SERVING_GUARD_AI_APPROVAL_BLOCKED',
    'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED']);
  expect([...APPROVAL_BLOCKED_CODES].sort()).toEqual([...codes].sort());
  expect(queryFn).not.toHaveBeenCalled();
});

test('a RECOMMENDATION_UTILITY refusal logs a distinct marker line a log-based metric can count; other codes do not', () => {
  const parse = (lines) => lines.map((line) => JSON.parse(line));
  const mismatch = parse(approvalBlockedLogLines({ runId: 'run_1', labelId: 'row_1', code: 'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED' }));
  expect(mismatch).toContainEqual({ severity: 'ERROR', message: REVALIDATION_MISMATCH_MARKER, run_id: 'run_1', label_id: 'row_1',
    code: 'RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED' });
  expect(REVALIDATION_MISMATCH_MARKER).toBe('RELGRAPH_REVIEW_REVALIDATION_MISMATCH');
  const low = parse(approvalBlockedLogLines({ runId: 'run_1', labelId: 'row_1', code: 'LOW_CONFIDENCE_AI_APPROVAL_BLOCKED' }));
  expect(low.map((line) => line.message)).toEqual(['relationship graph AI review: approval refused at apply']);
});

describe('a row whose approval is refused at apply does not abort the review', () => {
  let savedApply;
  let dirs = [];
  beforeEach(() => {
    savedApply = process.env.RELGRAPH_AI_REVIEW_APPLY; process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    if (savedApply === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY;
    else process.env.RELGRAPH_AI_REVIEW_APPLY = savedApply;
    jest.restoreAllMocks();
    dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); dirs = [];
  });
  const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-review-revalidation-')); dirs.push(dir); return dir; };

  const makeRows = (ids) => ids.map((id) => labelRow(id));
  const ROWS = makeRows(['row_ok_1', 'row_odd', 'row_ok_2', 'row_ok_3']);
  // The prompt carries the evidence, and so the row's own anchor id.
  const providerFor = (rows, byId, fallback = approve([SHORT_QUOTE])) => ({
    analyzeTextToJson: jest.fn(async ({ prompt }) => {
      const id = rows.map((row) => row.id).find((candidate) => prompt.includes(`anchor_${candidate}"`));
      return byId[id] || fallback;
    }),
  });
  const fakeDb = (rows, { failUpdateFor = null } = {}) => jest.fn(async (sql, params) => {
    if (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql)) return { rows };
    if (/SET\s+label_state = 'ai_approved'/.test(sql)) {
      if (params[0] === failUpdateFor) {
        const err = new Error('terminating connection due to administrator command');
        err.code = '57P01';
        throw err;
      }
      return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: 'ai_approved' }] };
    }
    if (/^\s*UPDATE/i.test(sql)) return { rows: [{ id: params[0], old_label_state: 'generated', new_label_state: 'generated' }] };
    return { rows: [] };
  });
  const approvedIds = (queryFn) => queryFn.mock.calls
    .filter(([sql]) => /SET\s+label_state = 'ai_approved'/.test(sql)).map(([, params]) => params[0]).sort();
  const writesFor = (queryFn, id) => queryFn.mock.calls
    .filter(([sql, params]) => /\b(?:UPDATE|INSERT|DELETE)\b/i.test(sql) && JSON.stringify(params || []).includes(`"${id}"`));
  const run = (rows, queryFn, provider, options = {}) => runReview({
    cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: rows.length, apply: true, concurrency: 2, negativeTtlDays: 0, queryFn, provider, ...options,
  });
  // A provider answer without a finite confidence passes the review's floor check (NaN < floor is
  // false) and is refused by applyApproval's own (LOW_CONFIDENCE_AI_APPROVAL_BLOCKED).
  const NO_CONFIDENCE = approve([SHORT_QUOTE], { confidence: undefined });

  test('the prod shape: an over-cap elided quote among several rows is approved with the cut passage, the run completes', async () => {
    const queryFn = fakeDb(ROWS);
    const result = await run(ROWS, queryFn, providerFor(ROWS, { row_odd: approve([LONG_QUOTE]) }));
    expect(approvedIds(queryFn)).toEqual(['row_odd', 'row_ok_1', 'row_ok_2', 'row_ok_3']);
    expect(result.summary).toEqual(expect.objectContaining({ reviewed_count: 4, approved_count: 4, approved_applied_count: 4,
      approval_blocked_count: 0, review_error_count: 0 }));
  });

  test('a refused approval is recorded as approval_blocked, counted, and nothing at all is written for it', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const queryFn = fakeDb(ROWS);
    const result = await run(ROWS, queryFn, providerFor(ROWS, { row_odd: NO_CONFIDENCE }));
    expect(approvedIds(queryFn)).toEqual(['row_ok_1', 'row_ok_2', 'row_ok_3']);
    expect(writesFor(queryFn, 'row_odd')).toEqual([]);
    expect(result.decisions.find((d) => d.id === 'row_odd')).toEqual(expect.objectContaining({
      verdict: 'approval_blocked', applied: false, new_label_state: 'generated',
      approval_blocked: expect.objectContaining({ code: 'LOW_CONFIDENCE_AI_APPROVAL_BLOCKED' }),
    }));
    expect(result.summary).toEqual(expect.objectContaining({
      reviewed_count: 4, approved_count: 3, approved_applied_count: 3, applied_count: 3, unclaimed_count: 0,
      approval_blocked_count: 1, approval_blocked_by_code: { LOW_CONFIDENCE_AI_APPROVAL_BLOCKED: 1 }, review_error_count: 1,
    }));
    const logged = stderr.mock.calls.map(([line]) => String(line)).join('');
    expect(logged).toMatch(/approval refused at apply.*row_odd.*LOW_CONFIDENCE_AI_APPROVAL_BLOCKED/);
    expect(logged).not.toContain(REVALIDATION_MISMATCH_MARKER);
    expect(reviewMetrics(result.summary)).toEqual(expect.objectContaining({
      review_error_count: 1, approval_blocked_count: 1, approval_blocked_by_code: { LOW_CONFIDENCE_AI_APPROVAL_BLOCKED: 1 },
    }));
  });

  test('a refused approval is never remembered as a negative verdict (a rejected row in the same run is)', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const rows = makeRows(['row_blocked', 'row_rejected']);
    const queryFn = fakeDb(rows);
    const result = await run(rows, queryFn, providerFor(rows, { row_blocked: NO_CONFIDENCE, row_rejected: approve([INVENTED_QUOTE]) }),
      { negativeTtlDays: 30 });
    expect(result.decisions.map((d) => [d.id, d.verdict])).toEqual([['row_blocked', 'approval_blocked'], ['row_rejected', 'reject']]);
    const memos = queryFn.mock.calls.filter(([sql]) => /ai_review_last/.test(sql)).map(([, params]) => params[0]);
    expect(memos).toEqual(['row_rejected']);
    expect(writesFor(queryFn, 'row_blocked')).toEqual([]);
  });

  test('a database error at apply still fails the run', async () => {
    const queryFn = fakeDb(ROWS, { failUpdateFor: 'row_odd' });
    await expect(run(ROWS, queryFn, providerFor(ROWS, {}))).rejects.toThrow('terminating connection due to administrator command');
  });

  const routine = async (blockedCount) => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const rows = makeRows(Array.from({ length: 20 }, (_, i) => `gate_${String(i).padStart(2, '0')}`));
    const blocked = Object.fromEntries(rows.slice(0, blockedCount).map((row) => [row.id, NO_CONFIDENCE]));
    const options = routineArgs(['--cutoff', '2026-06-01T00:00:00Z', '--skip-build', '--skip-validation', '--skip-serving-audit', '--out-dir', tempDir()]);
    let review = null;
    const runner = async (_command, args) => {
      review = await run(rows, fakeDb(rows), providerFor(rows, blocked), { out: args[args.indexOf('--out') + 1] });
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const summary = await runRoutineJob(options, { runner, progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) })
      .catch((err) => err.summary);
    return { summary, review };
  };

  test('every approval refused at apply fails the review step through the error gate', async () => {
    const { summary, review } = await routine(20);
    expect(review.summary).toEqual(expect.objectContaining({ approved_applied_count: 0, approval_blocked_count: 20, review_error_count: 20 }));
    expect(reviewErrorGateExceeded(reviewMetrics(review.summary))).toBe(true);
    expect(summary).toEqual(expect.objectContaining({ ok: false, failed_step: 'ai_review', approval_blocked_count: 20 }));
  });

  test('one approval refused at apply does not fail the review step on its own', async () => {
    const { summary, review } = await routine(1);
    expect(review.summary).toEqual(expect.objectContaining({ approved_applied_count: 19, approval_blocked_count: 1 }));
    expect(summary.ok).toBe(true);
  });

  test('a verdict replay of an --out file skips approval_blocked rows instead of refusing the file', async () => {
    const verdictsFile = path.join(tempDir(), 'review.json');
    fs.writeFileSync(verdictsFile, JSON.stringify({ decisions: [
      { id: 'row_ok_1', ...approve([SHORT_QUOTE]) },
      { id: 'row_blocked', verdict: 'approval_blocked', confidence: 0, rationale: 'approval refused at apply (LOW_CONFIDENCE_AI_APPROVAL_BLOCKED)' },
    ] }));
    delete process.env.RELGRAPH_AI_REVIEW_APPLY;
    const queryFn = jest.fn(async (sql) => (/^\s*SELECT[\s\S]*FROM relationship_candidate_labels/i.test(sql) ? { rows: [ROWS[0]] } : { rows: [] }));
    const result = await runReview({ cutoff: '2026-06-01T00:00:00Z', minScore: 0, limit: 10, verdictsFile, queryFn, negativeTtlDays: 0 });
    expect(result.summary).toEqual(expect.objectContaining({ verdicts_file_count: 1, approved_count: 1 }));
  });
});
