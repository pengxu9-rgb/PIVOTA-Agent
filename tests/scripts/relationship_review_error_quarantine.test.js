const { LlmError } = require('../../src/llm/provider');
const review = require('../../scripts/review-relationship-candidate-labels');
const { reviewMetrics, reviewErrorGateExceeded, reviewGateFailureLine, reviewQuarantineShare } = require('../../src/services/relationshipGraphServingProgress');

const { runReview, buildReviewErrorMemo, isQuarantinedForErrors, reviewErrorQuarantineDays, REVIEW_VALIDATOR_VERSION } = review;

// 2026-11-02: error verdicts wrote no memo, so the rows the model could not answer for (deterministic
// at temperature 0) stayed first in line every night; at ~107 of ~202 rows the review error gate failed
// every attempt. Two consecutive errors on the same evidence and model now quarantine a row for a
// bounded window; transport errors never count; a verdict clears the run; the gate still measures
// every review that ran.
const DAY = 86400000;
const T0 = Date.parse('2026-11-03T10:40:00Z');
const cutoff = '2026-01-01T00:00:00Z';
const reject = { verdict: 'reject', confidence: 0.9, rationale: 'Different product jobs for the shopper here.',
  relationship_kind: 'none', recommendation_reason: '', shared_evidence: [], tradeoffs: [], watchouts: [] };

function label(i) {
  return { id: `prel_${i}`, anchor_type: 'product', anchor_ref: `product:a${i}`, candidate_product_ref: `product:c${i}`,
    anchor_snapshot: { product_id: `a${i}`, title: 'Barrier Peptide Face Cream', brand: 'Aster', category: 'face cream' },
    candidate_snapshot: { product_id: `c${i}`, title: 'Barrier Peptide Face Cream', brand: 'Birch', category: 'face cream' },
    relation_type: 'competitive_alternative', market: 'US', vertical: 'beauty', category_taxonomy: ['face cream'],
    use_case: 'face cream', score_total: 0.9 - i / 1000, score_breakdown: {}, price_evidence: {}, source_refs: [], evidence_grade: 'B',
    label_state: 'generated', provenance: {}, updated_at: '2026-10-02T00:00:00Z' };
}

// A stateful stand-in for relationship_candidate_labels: the queue SELECT returns the generated rows,
// the two memo UPDATEs change provenance as the SQL does (a negative memo also drops ai_review_error).
function fakeDb(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const queryFn = jest.fn(async (sql, params = []) => {
    if (/UPDATE relationship_candidate_labels/.test(sql) && /'\{ai_review_error\}'/.test(sql)) {
      const row = byId.get(params[0]); row.provenance = { ...row.provenance, ai_review_error: JSON.parse(params[1]) };
      return { rows: [{ id: row.id }] };
    }
    if (/UPDATE relationship_candidate_labels/.test(sql) && /'\{ai_review_last\}'/.test(sql)) {
      expect(sql).toMatch(/- 'ai_review_error'/);
      const row = byId.get(params[0]); const { ai_review_error: _drop, ...rest } = row.provenance;
      row.provenance = { ...rest, ai_review_last: JSON.parse(params[1]) };
      return { rows: [{ id: row.id }] };
    }
    if (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql)) {
      // fetchCandidates binds LIMIT as $3 and, when paging, OFFSET as $N; rows come in score order.
      const limit = Number(params[2]) || 1000;
      const offsetParam = sql.match(/OFFSET \$(\d+)::int/);
      const offset = offsetParam ? Number(params[Number(offsetParam[1]) - 1]) || 0 : 0;
      const queue = [...byId.values()].filter((row) => row.label_state === 'generated').sort((a, b) => b.score_total - a.score_total);
      return { rows: queue.slice(offset, offset + limit) };
    }
    return { rows: [] };
  });
  return { byId, queryFn };
}
function provider(behaviour) {
  return { __meta: { provider: 'gemini', model: 'gemini-2.5-flash' }, analyzeTextToJson: jest.fn(async ({ prompt }) => behaviour(prompt)) };
}
const idIn = (prompt) => (prompt.match(/"id":\s*"(prel_\d+)"/) || prompt.match(/(prel_\d+)/) || [])[1];

let savedApply;
beforeEach(() => {
  savedApply = process.env.RELGRAPH_AI_REVIEW_APPLY; process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (savedApply === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY; else process.env.RELGRAPH_AI_REVIEW_APPLY = savedApply;
});
const night = (db, prov, at, extra = {}) => runReview({ cutoff, minScore: 0, limit: 50, apply: true, queryFn: db.queryFn, provider: prov,
  llmAttempts: 1, negativeTtlDays: 30, clock: () => at, ...extra });

describe('a row whose review keeps erroring is quarantined, then retried', () => {
  test('two consecutive errors quarantine it; the third night skips it; after the window it is reviewed again', async () => {
    const db = fakeDb([label(0), label(1)]);
    // prel_0 always comes back unparseable; prel_1 is rejected (and so memoed, skipped later).
    const prov = provider((prompt) => {
      if (prompt.includes('product:a0')) throw new LlmError('LLM_PARSE_FAILED', 'Failed to parse JSON from model output');
      return reject;
    });
    const n1 = await night(db, prov, T0);
    expect(n1.summary).toMatchObject({ review_error_count: 1, error_memo_recorded_count: 1, error_quarantine_entered_count: 0, error_quarantine_skipped_count: 0 });
    expect(db.byId.get('prel_0').provenance.ai_review_error).toMatchObject({ consecutive: 1, last_code: 'LLM_PARSE_FAILED',
      model: 'gemini-2.5-flash', validator_version: REVIEW_VALIDATOR_VERSION });

    const n2 = await night(db, prov, T0 + DAY);
    expect(n2.summary).toMatchObject({ review_error_count: 1, error_quarantine_entered_count: 1, error_quarantine_skipped_count: 0 });
    expect(n2.decisions.find((d) => d.id === 'prel_0')).toMatchObject({ verdict: 'error', error_quarantined: true });
    expect(db.byId.get('prel_0').provenance.ai_review_error).toMatchObject({ consecutive: 2,
      first_at: new Date(T0).toISOString(), last_at: new Date(T0 + DAY).toISOString() });

    const calls = prov.analyzeTextToJson.mock.calls.length;
    const n3 = await night(db, prov, T0 + 2 * DAY);
    expect(n3.summary).toMatchObject({ reviewed_count: 0, review_error_count: 0, error_quarantine_skipped_count: 1, negative_memory_skipped_count: 1 });
    expect(prov.analyzeTextToJson.mock.calls.length).toBe(calls);

    // 7-day window from the last error: on day 8 after it the row is reviewed again.
    const n4 = await night(db, prov, T0 + DAY + 7 * DAY + 60000);
    // Its next error re-quarantines it, and is counted as such.
    expect(n4.summary).toMatchObject({ reviewed_count: 1, review_error_count: 1, error_quarantine_skipped_count: 0, error_quarantine_entered_count: 1 });
    expect(n4.decisions.find((d) => d.id === 'prel_0')).toMatchObject({ error_quarantined: true });
    expect(db.byId.get('prel_0').provenance.ai_review_error.consecutive).toBe(3);
  });

  test('transport errors never count toward quarantine', async () => {
    const db = fakeDb([label(0)]);
    const prov = provider(() => { throw new LlmError('LLM_TIMEOUT', 'LLM request timed out'); });
    for (let day = 0; day < 3; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { summary } = await night(db, prov, T0 + day * DAY);
      expect(summary).toMatchObject({ reviewed_count: 1, review_error_count: 1, error_memo_recorded_count: 0, error_quarantine_skipped_count: 0 });
    }
    expect(db.byId.get('prel_0').provenance.ai_review_error).toBeUndefined();
  });

  test('a verdict between errors ends the run', async () => {
    const db = fakeDb([label(0)]);
    let fail = true;
    const prov = provider(() => { if (fail) throw new LlmError('LLM_SCHEMA_INVALID', 'Model JSON did not match expected schema'); return reject; });
    await night(db, prov, T0);
    expect(db.byId.get('prel_0').provenance.ai_review_error.consecutive).toBe(1);
    fail = false;
    await night(db, prov, T0 + DAY);
    expect(db.byId.get('prel_0').provenance.ai_review_error).toBeUndefined();
    expect(db.byId.get('prel_0').provenance.ai_review_last).toMatchObject({ verdict: 'reject' });
  });

  test('the gate still measures the reviews that ran: fresh errors trip it, quarantined rows are not in it', async () => {
    // Four rows quarantined over two nights, then twenty fresh rows arrive: half of them error.
    const db = fakeDb(Array.from({ length: 4 }, (_, i) => label(i)));
    const seed = provider(() => { throw new LlmError('LLM_PARSE_FAILED', 'x'); });
    for (const at of [T0, T0 + DAY]) {
      // eslint-disable-next-line no-await-in-loop
      await night(db, seed, at);
    }
    for (const id of ['prel_0', 'prel_1', 'prel_2', 'prel_3']) expect(db.byId.get(id).provenance.ai_review_error.consecutive).toBe(2);
    for (let i = 4; i < 24; i += 1) db.byId.set(`prel_${i}`, label(i));
    const fresh = provider((prompt) => {
      const m = prompt.match(/product:a(\d+)"/); const i = m ? Number(m[1]) : 0;
      if (i % 2 === 0) throw new LlmError('LLM_PARSE_FAILED', 'x');
      return reject;
    });
    const { summary } = await night(db, fresh, T0 + 2 * DAY);
    expect(summary).toMatchObject({ error_quarantine_skipped_count: 4, reviewed_count: 20, review_error_count: 10 });
    expect(reviewErrorGateExceeded(reviewMetrics(summary))).toBe(true);
    expect(reviewMetrics(summary)).toMatchObject({ error_quarantine_skipped_count: 4, review_error_rate: 0.5 });
  });
});

describe('memo and window rules', () => {
  const fp = 'f'.repeat(64);
  const row = (memo) => ({ provenance: { ai_review_error: memo } });
  const memo2 = (over = {}) => ({ consecutive: 2, pair_fingerprint: fp, model: 'm', rubric: review.RUBRIC_VERSION,
    validator_version: REVIEW_VALIDATOR_VERSION, last_at: new Date(T0).toISOString(), ...over });
  test('the run grows only on the same evidence, model, validator and rubric', () => {
    const err = { verdict: 'error', review_error: { code: 'LLM_PARSE_FAILED' } };
    const first = buildReviewErrorMemo({ provenance: {} }, err, { fingerprint: fp, model: 'm', reviewedAt: 'A' });
    expect(first).toMatchObject({ consecutive: 1, first_at: 'A', last_at: 'A', last_code: 'LLM_PARSE_FAILED' });
    expect(buildReviewErrorMemo(row(first), err, { fingerprint: fp, model: 'm', reviewedAt: 'B' })).toMatchObject({ consecutive: 2, first_at: 'A', last_at: 'B' });
    expect(buildReviewErrorMemo(row(first), err, { fingerprint: 'g'.repeat(64), model: 'm', reviewedAt: 'B' })).toMatchObject({ consecutive: 1, first_at: 'B' });
    expect(buildReviewErrorMemo(row(first), err, { fingerprint: fp, model: 'other', reviewedAt: 'B' }).consecutive).toBe(1);
    expect(buildReviewErrorMemo(row({ ...first, validator_version: 'old' }), err, { fingerprint: fp, model: 'm', reviewedAt: 'B' }).consecutive).toBe(1);
    expect(buildReviewErrorMemo(row(first), { verdict: 'error', review_error: { code: 'weird text' } }, { fingerprint: fp, model: 'm', reviewedAt: 'B' }).last_code).toBe('OTHER');
  });
  test('quarantined only at the threshold, inside the window, for the same evidence and model', () => {
    const at = { days: 7, nowMs: T0 + DAY, model: 'm' };
    expect(isQuarantinedForErrors(row(memo2()), fp, at)).toBe(true);
    expect(isQuarantinedForErrors(row(memo2({ consecutive: 1 })), fp, at)).toBe(false);
    expect(isQuarantinedForErrors(row(memo2()), 'g'.repeat(64), at)).toBe(false);
    expect(isQuarantinedForErrors(row(memo2()), fp, { ...at, model: 'other' })).toBe(false);
    expect(isQuarantinedForErrors(row(memo2({ rubric: 'old' })), fp, at)).toBe(false);
    expect(isQuarantinedForErrors(row(memo2()), fp, { ...at, nowMs: T0 + 7 * DAY })).toBe(false);
    expect(isQuarantinedForErrors(row(memo2()), fp, { ...at, nowMs: T0 + 7 * DAY - 1 })).toBe(true);
    expect(isQuarantinedForErrors(row(memo2({ last_at: new Date(T0 + 3 * DAY).toISOString() })), fp, at)).toBe(false);
    expect(isQuarantinedForErrors(row(memo2()), fp, { ...at, days: 0 })).toBe(false);
  });
  test('RELGRAPH_REVIEW_ERROR_QUARANTINE_DAYS: default 7, 0 disables, bounded', () => {
    expect(reviewErrorQuarantineDays({})).toBe(7);
    expect(reviewErrorQuarantineDays({ RELGRAPH_REVIEW_ERROR_QUARANTINE_DAYS: '0' })).toBe(0);
    expect(reviewErrorQuarantineDays({ RELGRAPH_REVIEW_ERROR_QUARANTINE_DAYS: '1000' })).toBe(90);
  });
});

test('an approval ends the error run too', async () => {
  const toner = (brand, title) => ({ product_id: `${brand}-${title}`, brand, title, name: title, category: 'toner', price: 30, price_currency: 'USD',
    ingredient_text: 'Water, Niacinamide, Allantoin, Panthenol, Squalane' });
  const row = { ...label(9), anchor_snapshot: toner('Brand A', 'Calming Toner'), candidate_snapshot: toner('Brand B', 'Soothing Toner'),
    provenance: { ai_review_error: { consecutive: 1 } } };
  const decision = review.validateRecommendationDecision(row, { verdict: 'approve', confidence: 0.9, relationship_kind: 'alternative',
    rationale: 'Shared job and actives from the supplied facts.', ...review.consumerCopyForKind('alternative'),
    shared_evidence: [{ anchor_fact: 'niacinamide', candidate_fact: 'Niacinamide' }] });
  const sqls = [];
  await review.applyApproval(row, decision, async (sql, params) => { sqls.push(sql); return { rows: [{ id: params[0] }] }; });
  expect(sqls.join('\n')).toMatch(/COALESCE\(provenance, '\{\}'::jsonb\) - 'ai_review_error', '\{ai_review\}'/);
});

test('the run ledger keeps the quarantine counts with the batch', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { extractRelationshipGraphRunRecord } = require('../../src/services/relationshipGraphRunLedger');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-quarantine-ledger-'));
  try {
    const reviewPath = path.join(dir, 'review.json');
    fs.writeFileSync(reviewPath, JSON.stringify({ summary: { reviewed_count: 1, error_quarantine_skipped_count: 107, error_quarantine_entered_count: 3 },
      decisions: [{ id: 'a', verdict: 'reject', applied: false, new_label_state: 'generated' }] }));
    const routinePath = path.join(dir, 'routine_summary.json');
    fs.writeFileSync(routinePath, JSON.stringify({ ok: true, artifacts: { review: reviewPath } }));
    const record = extractRelationshipGraphRunRecord({ run_id: 'relgraph_sync_routine_q', ok: true, out_dir: dir, artifacts: { routine_summary: routinePath } });
    expect(record.summary.recommendation_review_batch).toMatchObject({ error_quarantine_skipped_count: 107, error_quarantine_entered_count: 3 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with negative memory off, the selection still pages past quarantined rows to fill the limit', async () => {
  const db = fakeDb(Array.from({ length: 4 }, (_, i) => label(i)));
  const failFirstThree = provider((prompt) => { if (/product:a[0-2]"/.test(prompt)) throw new LlmError('LLM_PARSE_FAILED', 'x'); return reject; });
  for (const at of [T0, T0 + DAY]) {
    // eslint-disable-next-line no-await-in-loop
    await night(db, failFirstThree, at, { limit: 3, ids: ['prel_0', 'prel_1', 'prel_2'], idsScopeRequested: true });
  }
  for (const id of ['prel_0', 'prel_1', 'prel_2']) expect(db.byId.get(id).provenance.ai_review_error.consecutive).toBe(2);
  const { summary, decisions } = await night(db, failFirstThree, T0 + 2 * DAY, { limit: 2, negativeTtlDays: 0 });
  expect(summary.error_quarantine_skipped_count).toBe(3);
  expect(decisions.map((d) => d.id)).toEqual(['prel_3']);
});

describe('a model that fails every row cannot go quiet behind the quarantine', () => {
  // Controller simulation (2026-11-02): with the quarantine alone, a fully broken model quarantined the
  // whole queue by night 2 and passed from night 3 on 0 reviews.
  test('a broken model on a static queue trips the gate every night, including on 0 reviews', async () => {
    const db = fakeDb(Array.from({ length: 30 }, (_, i) => label(i)));
    const broken = provider(() => { throw new LlmError('LLM_PARSE_FAILED', 'x'); });
    const lines = [];
    for (let day = 0; day < 4; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { summary } = await night(db, broken, T0 + day * DAY, { limit: 250 });
      const metrics = reviewMetrics(summary);
      expect(reviewErrorGateExceeded(metrics)).toBe(true);
      lines.push(reviewGateFailureLine(metrics));
    }
    expect(lines[0]).toBe('review error rate 1 exceeds 0.25');
    expect(lines[1]).toBe('review error rate 1 exceeds 0.25');
    expect(lines[2]).toBe('error-quarantined share 1 exceeds 0.5 (30 skipped, 0 reviewed)');
    expect(lines[3]).toBe(lines[2]);
  });

  test('a short night (fewer than 20 reviews) behind a big quarantine still trips', () => {
    const metrics = reviewMetrics({ reviewed_count: 10, review_error_count: 10, error_quarantine_skipped_count: 50 });
    expect(reviewQuarantineShare(metrics)).toBeCloseTo(50 / 60);
    expect(reviewErrorGateExceeded(metrics)).toBe(true);
    expect(reviewGateFailureLine(metrics)).toBe('error-quarantined share 0.8333 exceeds 0.5 (50 skipped, 10 reviewed)');
  });

  test('a stable residue beside a normal night does not trip; the line still names it', () => {
    const metrics = reviewMetrics({ reviewed_count: 250, review_error_count: 10, error_quarantine_skipped_count: 107 });
    expect(reviewErrorGateExceeded(metrics)).toBe(false);
    expect(reviewGateFailureLine(metrics)).toBe('error-quarantined rows skipped 107');
    const both = reviewMetrics({ reviewed_count: 30, review_error_count: 20, error_quarantine_skipped_count: 107 });
    expect(reviewGateFailureLine(both)).toBe('review error rate 0.6666666666666666 exceeds 0.25; error-quarantined share 0.781 exceeds 0.5 (107 skipped, 30 reviewed)');
  });

  test('below the minimum of skipped rows the share alone does not trip; the threshold is configurable', () => {
    expect(reviewErrorGateExceeded(reviewMetrics({ reviewed_count: 0, error_quarantine_skipped_count: 19 }))).toBe(false);
    expect(reviewErrorGateExceeded(reviewMetrics({ reviewed_count: 0, error_quarantine_skipped_count: 20 }))).toBe(true);
    const half = reviewMetrics({ reviewed_count: 40, error_quarantine_skipped_count: 40 });
    expect(reviewErrorGateExceeded(half)).toBe(false);
    expect(reviewErrorGateExceeded(half, { maxReviewQuarantineShare: 0.4 })).toBe(true);
  });

  test('the routine job fails the night on the quarantine share and says so', async () => {
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const { runRoutineJob, parseArgs } = require('../../scripts/run-relationship-graph-routine-job');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-quarantine-gate-'));
    try {
      const options = parseArgs(['--cutoff', cutoff, '--skip-build', '--skip-validation', '--skip-serving-audit', '--out-dir', dir]);
      expect(options.maxReviewQuarantineShare).toBe(0.5);
      expect(parseArgs(['--cutoff', cutoff, '--max-review-quarantine-share', '0.3', '--out-dir', dir]).maxReviewQuarantineShare).toBe(0.3);
      const runner = async (_command, args) => {
        fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ summary: { reviewed_count: 0, review_error_count: 0, approved_count: 0,
          error_quarantine_skipped_count: 202, review_error_by_code: {} }, decisions: [] }));
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const summary = await runRoutineJob(options, { runner, progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) })
        .then(() => null, (e) => e.summary);
      expect(summary).toMatchObject({ failed_step: 'ai_review', error_quarantine_skipped_count: 202 });
      expect(summary.steps.find((st) => st.id === 'ai_review').stderr_tail).toBe('error-quarantined share 1 exceeds 0.5 (202 skipped, 0 reviewed)');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('the option reaches the routine from the sync routine and the cron env', () => {
    const { buildCronArgs } = require('../../scripts/run-relationship-graph-sync-routine-cron');
    const sync = require('../../scripts/run-relationship-graph-sync-routine');
    const now = new Date('2026-11-03T10:37:00Z');
    expect(buildCronArgs({ RELGRAPH_SYNC_MAX_REVIEW_QUARANTINE_SHARE: '0.4' }, { now }).args.join(' ')).toContain('--max-review-quarantine-share 0.4');
    const opts = sync.parseArgs(['--cutoff', cutoff, '--external-product-ids', 'seed_1', '--max-review-quarantine-share', '0.4', '--out-dir', '/tmp/rq'], { now });
    expect(opts.maxReviewQuarantineShare).toBe(0.4);
    const routineStep = sync.buildSyncRoutineSteps(opts).steps.find((st) => st.id === 'relationship_graph_routine');
    expect(routineStep.args.join(' ')).toContain('--max-review-quarantine-share 0.4');
  });
});

test('the error memo carries codes and hashes, never model text', async () => {
  const db = fakeDb([label(0)]);
  const secret = 'PRIVATE model prose that must not be stored';
  await night(db, provider(() => { throw new LlmError('LLM_PARSE_FAILED', `Failed to parse JSON from model output: ${secret}`); }), T0);
  const memo = db.byId.get('prel_0').provenance.ai_review_error;
  expect(JSON.stringify(memo)).not.toContain('PRIVATE');
  expect(Object.keys(memo).sort()).toEqual(['consecutive', 'first_at', 'last_at', 'last_code', 'model', 'pair_fingerprint', 'rubric', 'run_id', 'validator_version'].filter((k) => k !== 'run_id' || 'run_id' in memo).sort());
});

