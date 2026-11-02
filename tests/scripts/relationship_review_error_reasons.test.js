const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LlmError } = require('../../src/llm/provider');
const { runReview } = require('../../scripts/review-relationship-candidate-labels');
const { runRoutineJob, parseArgs } = require('../../scripts/run-relationship-graph-routine-job');
const { reviewMetrics } = require('../../src/services/relationshipGraphServingProgress');
const { extractRelationshipGraphRunRecord } = require('../../src/services/relationshipGraphRunLedger');

// 2026-11-02: 156 of 426 reviews errored, the routine's review error gate failed the night, and no
// surviving record said why. The per-row reasons were only in the review's --out file in the container's
// /tmp; the summary, the routine summary, the gate's failure line and the ledger carried a count.
const cutoff = '2026-01-01T00:00:00Z';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-review-errors-'));

function row(i) {
  return { id: `prel_${i}`, anchor_type: 'product', anchor_ref: `product:a${i}`, candidate_product_ref: `product:c${i}`,
    anchor_snapshot: { product_id: `a${i}`, title: 'Barrier Peptide Face Cream', brand: 'Aster', category: 'face cream' },
    candidate_snapshot: { product_id: `c${i}`, title: 'Barrier Peptide Face Cream', brand: 'Birch', category: 'face cream' },
    relation_type: 'competitive_alternative', market: 'US', vertical: 'beauty', category_taxonomy: ['face cream'],
    use_case: 'face cream', score_total: 0.9, score_breakdown: {}, price_evidence: {}, source_refs: [], evidence_grade: 'B',
    label_state: 'generated', provenance: {}, updated_at: '2026-10-02T00:00:00Z' };
}
const reject = { verdict: 'reject', confidence: 0.9, rationale: 'Different product jobs for the shopper here.',
  relationship_kind: 'none', recommendation_reason: '', shared_evidence: [], tradeoffs: [], watchouts: [] };

describe('a review error says why', () => {
  beforeEach(() => jest.spyOn(process.stdout, 'write').mockImplementation(() => true));
  afterEach(() => jest.restoreAllMocks());

  test('the summary counts errors by code and keeps a few distinct sample messages', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(i));
    let call = 0;
    const provider = { __meta: { provider: 'gemini', model: 'm' }, analyzeTextToJson: jest.fn(async () => {
      const i = call; call += 1;
      if (i < 9) throw new LlmError('LLM_SCHEMA_INVALID', `Model JSON did not match expected schema (variant ${i % 3})`);
      if (i < 12) throw new LlmError('LLM_TIMEOUT', 'LLM request timed out');
      return reject;
    }) };
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows } : { rows: [] }));
    const { summary, decisions } = await runReview({ cutoff, minScore: 0, limit: 20, queryFn, provider, llmAttempts: 1, negativeTtlDays: 0 });
    expect(summary.review_error_count).toBe(12);
    expect(summary.review_error_by_code).toEqual({ LLM_SCHEMA_INVALID: 9, LLM_TIMEOUT: 3 });
    // Distinct (code, message) pairs, at most eight, each naming a row.
    expect(summary.review_error_samples).toHaveLength(4);
    expect(new Set(summary.review_error_samples.map((s) => `${s.code}|${s.message}`)).size).toBe(4);
    expect(summary.review_error_samples[0]).toEqual({ code: 'LLM_SCHEMA_INVALID',
      message: 'Model JSON did not match expected schema (variant 0)', label_id: decisions[0].id });
    expect(summary.review_error_samples.map((s) => s.code)).toContain('LLM_TIMEOUT');
  });

  test('samples stop at eight', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i));
    let call = 0;
    const provider = { __meta: { provider: 'gemini', model: 'm' },
      analyzeTextToJson: jest.fn(async () => { call += 1; throw new LlmError('LLM_SCHEMA_INVALID', `distinct ${call}`); }) };
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows } : { rows: [] }));
    const { summary } = await runReview({ cutoff, minScore: 0, limit: 20, queryFn, provider, llmAttempts: 1, negativeTtlDays: 0 });
    expect(summary.review_error_by_code).toEqual({ LLM_SCHEMA_INVALID: 12 });
    expect(summary.review_error_samples).toHaveLength(8);
  });

  test('no errors, empty breakdown', async () => {
    const rows = [row(0)];
    const provider = { __meta: { provider: 'gemini', model: 'm' }, analyzeTextToJson: jest.fn(async () => reject) };
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows } : { rows: [] }));
    const { summary } = await runReview({ cutoff, minScore: 0, limit: 5, queryFn, provider, llmAttempts: 1, negativeTtlDays: 0 });
    expect(summary.review_error_by_code).toEqual({});
    expect(summary.review_error_samples).toEqual([]);
  });
});

test('the routine summary carries the codes, not the messages', () => {
  const metrics = reviewMetrics({ reviewed_count: 10, review_error_count: 4, review_error_by_code: { LLM_TIMEOUT: 4 },
    review_error_samples: [{ code: 'LLM_TIMEOUT', message: 'model text', label_id: 'x' }] });
  expect(metrics.review_error_by_code).toEqual({ LLM_TIMEOUT: 4 });
  expect(metrics).not.toHaveProperty('review_error_samples');
});

test('a failed review error gate names the codes in its failure line', async () => {
  const dir = temp();
  try {
    const options = parseArgs(['--cutoff', cutoff, '--skip-build', '--skip-validation', '--skip-serving-audit', '--out-dir', dir]);
    const runner = async (_command, args) => {
      fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ summary: { reviewed_count: 20, review_error_count: 8,
        approved_count: 0, review_error_by_code: { LLM_SCHEMA_INVALID: 6, LLM_TIMEOUT: 2 } }, decisions: [] }));
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const summary = await runRoutineJob(options, { runner, progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) })
      .then(() => null, (err) => err.summary);
    expect(summary).toMatchObject({ failed_step: 'ai_review', review_error_by_code: { LLM_SCHEMA_INVALID: 6, LLM_TIMEOUT: 2 } });
    const step = summary.steps.find((s) => s.id === 'ai_review');
    expect(step.stderr_tail).toBe('review error rate 0.4 exceeds 0.25; errors by code {"LLM_SCHEMA_INVALID":6,"LLM_TIMEOUT":2}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the ledger keeps each error code with its row and the breakdown, never the message', () => {
  const dir = temp();
  try {
    const reviewPath = path.join(dir, 'routine', 'review.json');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify({ summary: { reviewed_count: 2, applied_count: 0, approved_applied_count: 0,
      review_error_by_code: { LLM_SCHEMA_INVALID: 1 }, review_error_samples: [{ code: 'LLM_SCHEMA_INVALID', message: 'private model prose', label_id: 'e' }] },
    decisions: [
      { id: 'e', verdict: 'error', applied: false, new_label_state: 'generated', review_error: { code: 'LLM_SCHEMA_INVALID', message: 'private model prose' } },
      { id: 'b', verdict: 'approval_blocked', applied: false, new_label_state: 'generated', approval_blocked: { code: 'DUPE_AI_APPROVAL_BLOCKED', message: 'x' } },
    ] }));
    const summaryPath = path.join(dir, 'routine', 'routine_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ ok: false, artifacts: { review: reviewPath } }));
    const record = extractRelationshipGraphRunRecord({ run_id: 'relgraph_sync_routine_test', ok: false, out_dir: dir,
      artifacts: { routine_summary: summaryPath } });
    const batch = record.summary.recommendation_review_batch;
    expect(batch.review_error_by_code).toEqual({ LLM_SCHEMA_INVALID: 1 });
    expect(batch.decisions).toEqual([
      expect.objectContaining({ id: 'e', verdict: 'error', review_error_code: 'LLM_SCHEMA_INVALID' }),
      expect.objectContaining({ id: 'b', verdict: 'approval_blocked', approval_blocked_code: 'DUPE_AI_APPROVAL_BLOCKED' }),
    ]);
    expect(JSON.stringify(batch)).not.toContain('private model prose');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
