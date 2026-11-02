const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LlmError } = require('../../src/llm/provider');
const { runReview } = require('../../scripts/review-relationship-candidate-labels');
const { runRoutineJob, parseArgs } = require('../../scripts/run-relationship-graph-routine-job');
const { surfaceReviewErrors, runSyncRoutine, parseArgs: syncArgs } = require('../../scripts/run-relationship-graph-sync-routine');
const { reviewMetrics, reviewErrorCodeKey, reviewErrorRelayLine, REVIEW_ERRORS_MARKER } = require('../../src/services/relationshipGraphServingProgress');
const { extractRelationshipGraphRunRecord } = require('../../src/services/relationshipGraphRunLedger');

// 2026-11-02: 156 of 426 reviews errored, the routine's review error gate failed the night, and no
// surviving record said why: the per-row reasons were only in the review's --out file in the
// container's /tmp. Codes now travel with the summary, the gate line and the ledger; messages, which
// can quote model output, go only to one bounded stderr line from the sync routine.
const cutoff = '2026-01-01T00:00:00Z';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-review-errors-'));
const MODEL_TEXT = 'private model prose';

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

test('a code is an upper-case identifier or OTHER', () => {
  expect(reviewErrorCodeKey('LLM_SCHEMA_INVALID')).toBe('LLM_SCHEMA_INVALID');
  for (const bad of ['', null, undefined, 42, 'llm_timeout', 'ERR {"x":1}', 'A'.repeat(81), `CODE ${MODEL_TEXT}`]) {
    expect(reviewErrorCodeKey(bad)).toBe('OTHER');
  }
});

describe('the review summary counts errors by code and carries no message', () => {
  let stdout;
  beforeEach(() => { stdout = []; jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true; }); });
  afterEach(() => jest.restoreAllMocks());

  test('codes are counted (unknown shapes as OTHER); messages stay in the decisions only', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(i));
    let call = 0;
    const provider = { __meta: { provider: 'gemini', model: 'm' }, analyzeTextToJson: jest.fn(async () => {
      const i = call; call += 1;
      if (i < 8) throw new LlmError('LLM_SCHEMA_INVALID', `Model JSON did not match expected schema: ${MODEL_TEXT}`);
      if (i < 10) throw new LlmError('LLM_TIMEOUT', 'LLM request timed out');
      if (i < 11) throw Object.assign(new Error(MODEL_TEXT), { code: `weird ${MODEL_TEXT}` });
      return reject;
    }) };
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows } : { rows: [] }));
    const { summary, decisions } = await runReview({ cutoff, minScore: 0, limit: 20, queryFn, provider, llmAttempts: 1, negativeTtlDays: 0 });
    expect(summary.review_error_count).toBe(11);
    expect(summary.review_error_by_code).toEqual({ LLM_SCHEMA_INVALID: 8, LLM_TIMEOUT: 2, OTHER: 1 });
    expect(summary).not.toHaveProperty('review_error_samples');
    expect(JSON.stringify(summary)).not.toContain(MODEL_TEXT);
    expect(stdout.join('')).not.toContain(MODEL_TEXT);
    // The --out decisions keep the per-row reasons for the sync routine's relay line.
    expect(decisions.filter((d) => d.review_error).length).toBe(11);
  });

  test('no errors, empty breakdown', async () => {
    const provider = { __meta: { provider: 'gemini', model: 'm' }, analyzeTextToJson: jest.fn(async () => reject) };
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows: [row(0)] } : { rows: [] }));
    const { summary } = await runReview({ cutoff, minScore: 0, limit: 5, queryFn, provider, llmAttempts: 1, negativeTtlDays: 0 });
    expect(summary.review_error_by_code).toEqual({});
  });
});

describe('the sync routine relays the reasons as one bounded stderr line', () => {
  const err = (id, code, message) => ({ id, verdict: 'error', review_error: { code, message } });

  test('counts by code, at most 8 distinct samples, messages cut to 240 characters', () => {
    const decisions = [
      err('t0', 'LLM_TIMEOUT', 'timed out'), err('t1', 'LLM_TIMEOUT', 'timed out'), err('t2', 'LLM_TIMEOUT', 'timed out'),
      ...Array.from({ length: 10 }, (_, i) => err(`s${i}`, 'LLM_SCHEMA_INVALID', `variant ${i}`)),
      { id: 'ok', verdict: 'reject' },
    ];
    const line = reviewErrorRelayLine(decisions, { runId: 'relgraph_sync_routine_x' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ severity: 'WARNING', message: REVIEW_ERRORS_MARKER, run_id: 'relgraph_sync_routine_x',
      review_error_count: 13, review_error_by_code: { LLM_TIMEOUT: 3, LLM_SCHEMA_INVALID: 10 } });
    // The three identical timeouts are one sample, so seven schema samples follow it.
    expect(parsed.samples).toHaveLength(8);
    expect(parsed.samples[0]).toEqual({ code: 'LLM_TIMEOUT', message: 'timed out', label_id: 't0' });
    expect(parsed.samples.slice(1).map((s) => s.label_id)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6']);
  });

  test('a long message is cut to 240 without splitting a character; whitespace collapses; codes are allowlisted', () => {
    const long = `${'x'.repeat(239)}\u{1F33F}${'y'.repeat(50)}`;
    const parsed = JSON.parse(reviewErrorRelayLine([err('a', 'not a code', long), err('b', 'LLM_TIMEOUT', 'line one\n  line two')]));
    expect(parsed.review_error_by_code).toEqual({ OTHER: 1, LLM_TIMEOUT: 1 });
    expect(parsed.samples[0].message).toBe('x'.repeat(239));
    expect(parsed.samples[0].message.length).toBeLessThanOrEqual(240);
    expect(parsed.samples[1].message).toBe('line one line two');
  });

  test('nothing to say, no line', () => {
    expect(reviewErrorRelayLine([{ id: 'a', verdict: 'reject' }])).toBe('');
    expect(reviewErrorRelayLine(null)).toBe('');
  });

  test('surfaceReviewErrors reads the --out file, writes stderr, and leaves the summary (and so the ledger) alone', () => {
    const dir = temp();
    const writes = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    try {
      const file = path.join(dir, 'review.json');
      fs.writeFileSync(file, JSON.stringify({ decisions: [err('a', 'LLM_SCHEMA_INVALID', MODEL_TEXT)] }));
      const summary = { run_id: 'r1', review_error_by_code: { LLM_SCHEMA_INVALID: 1 } };
      const before = JSON.stringify(summary);
      surfaceReviewErrors(summary, file);
      expect(JSON.stringify(summary)).toBe(before);
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0]).samples[0].message).toBe(MODEL_TEXT);
      surfaceReviewErrors(summary, path.join(dir, 'missing.json'));
      fs.writeFileSync(file, 'not json');
      surfaceReviewErrors(summary, file);
      expect(writes).toHaveLength(1);
    } finally { spy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test('the routine summary carries the codes', () => {
  expect(reviewMetrics({ reviewed_count: 10, review_error_count: 4, review_error_by_code: { LLM_TIMEOUT: 4 } }).review_error_by_code)
    .toEqual({ LLM_TIMEOUT: 4 });
});

describe('a failed review error gate names what it counted', () => {
  async function gateLine(reviewSummary) {
    const dir = temp();
    try {
      const options = parseArgs(['--cutoff', cutoff, '--skip-build', '--skip-validation', '--skip-serving-audit', '--out-dir', dir]);
      const runner = async (_command, args) => {
        fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ summary: { reviewed_count: 20, review_error_count: 8,
          approved_count: 0, ...reviewSummary }, decisions: [] }));
        return { exitCode: 0, stdout: '', stderr: '' };
      };
      const summary = await runRoutineJob(options, { runner, progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) })
        .then(() => null, (e) => e.summary);
      expect(summary.failed_step).toBe('ai_review');
      return summary.steps.find((s) => s.id === 'ai_review').stderr_tail;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  test('provider codes', async () => {
    expect(await gateLine({ review_error_by_code: { LLM_SCHEMA_INVALID: 6, LLM_TIMEOUT: 2 } }))
      .toBe('review error rate 0.4 exceeds 0.25; errors by code {"LLM_SCHEMA_INVALID":6,"LLM_TIMEOUT":2}');
  });
  test('approvals refused at apply count too', async () => {
    expect(await gateLine({ review_error_by_code: {}, approval_blocked_count: 8,
      approval_blocked_by_code: { RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED: 8 } }))
      .toBe('review error rate 0.4 exceeds 0.25; errors by code {"RECOMMENDATION_UTILITY_AI_APPROVAL_BLOCKED":8}');
  });
  test('no breakdown, no suffix', async () => {
    expect(await gateLine({ review_error_by_code: {} })).toBe('review error rate 0.4 exceeds 0.25');
  });
});

test('the ledger keeps allowlisted codes per row and per batch, never a message', () => {
  const dir = temp();
  try {
    const reviewPath = path.join(dir, 'routine', 'review.json');
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    fs.writeFileSync(reviewPath, JSON.stringify({ summary: { reviewed_count: 3, applied_count: 0, approved_applied_count: 0,
      review_error_by_code: { LLM_SCHEMA_INVALID: 1, [`bad ${MODEL_TEXT}`]: 1 } },
    decisions: [
      { id: 'e', verdict: 'error', applied: false, new_label_state: 'generated', review_error: { code: 'LLM_SCHEMA_INVALID', message: MODEL_TEXT } },
      { id: 'w', verdict: 'error', applied: false, new_label_state: 'generated', review_error: { code: `bad ${MODEL_TEXT}`, message: MODEL_TEXT } },
      { id: 'b', verdict: 'approval_blocked', applied: false, new_label_state: 'generated', approval_blocked: { code: 'DUPE_AI_APPROVAL_BLOCKED', message: MODEL_TEXT } },
    ] }));
    const summaryPath = path.join(dir, 'routine', 'routine_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ ok: false, artifacts: { review: reviewPath } }));
    const record = extractRelationshipGraphRunRecord({ run_id: 'relgraph_sync_routine_test', ok: false, out_dir: dir,
      artifacts: { routine_summary: summaryPath } });
    const batch = record.summary.recommendation_review_batch;
    expect(batch.review_error_by_code).toEqual({ LLM_SCHEMA_INVALID: 1, OTHER: 1 });
    expect(batch.decisions).toEqual([
      expect.objectContaining({ id: 'e', review_error_code: 'LLM_SCHEMA_INVALID' }),
      expect.objectContaining({ id: 'w', review_error_code: 'OTHER' }),
      expect.objectContaining({ id: 'b', approval_blocked_code: 'DUPE_AI_APPROVAL_BLOCKED' }),
    ]);
    expect(JSON.stringify(record.summary)).not.toContain(MODEL_TEXT);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a sync run relays the reasons on its own stderr, and neither its summary nor its ledger record carries a message', async () => {
  const outDir = temp();
  try {
    const options = syncArgs(['--skip-review', '--select-hours', '24', '--out-dir', outDir], { now: new Date('2026-11-02T10:37:00.000Z') });
    const runner = jest.fn(async (_command, args) => {
      if (args[0].endsWith('run-relationship-graph-routine-job.js')) {
        const routineOut = args[args.indexOf('--out-dir') + 1];
        fs.mkdirSync(routineOut, { recursive: true });
        const review = path.join(routineOut, 'relationship_graph_ai_review.json');
        fs.writeFileSync(review, JSON.stringify({ summary: { reviewed_count: 30, review_error_count: 1, review_error_by_code: { LLM_SCHEMA_INVALID: 1 } },
          decisions: [{ id: 'label_1', verdict: 'error', review_error: { code: 'LLM_SCHEMA_INVALID', message: MODEL_TEXT } }] }));
        fs.writeFileSync(path.join(routineOut, 'routine_summary.json'), JSON.stringify({ ok: true, artifacts: { review } }));
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const recorded = [];
    const writes = [];
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
    let summary;
    try {
      summary = await runSyncRoutine(options, { runner, now: new Date('2026-11-02T10:37:00.000Z'),
        progressReader: async () => ({ servedEdges: 0, anchors: new Set() }),
        ledgerRecorder: async (s) => { recorded.push(JSON.stringify(s)); return { recorded: true }; } });
    } finally { stderr.mockRestore(); }
    const relayed = writes.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((line) => line && line.message === REVIEW_ERRORS_MARKER);
    expect(relayed).toEqual([{ severity: 'WARNING', message: REVIEW_ERRORS_MARKER, run_id: summary.run_id, review_error_count: 1,
      review_error_by_code: { LLM_SCHEMA_INVALID: 1 }, samples: [{ code: 'LLM_SCHEMA_INVALID', message: MODEL_TEXT, label_id: 'label_1' }] }]);
    expect(summary.review_error_by_code).toEqual({ LLM_SCHEMA_INVALID: 1 });
    expect(JSON.stringify(summary)).not.toContain(MODEL_TEXT);
    expect(recorded.join('')).not.toContain(MODEL_TEXT);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

describe('#2529 review follow-ups', () => {
  test('consensus: a provider error code is allowlisted in the proof and the counts; its message reaches only review_error', async () => {
    const providers = [['openai', 'gpt-4.1'], ['gemini', 'gemini-3-flash-preview']].map(([provider, model]) => ({
      __meta: { provider, model },
      analyzeTextToJson: jest.fn(async () => {
        if (provider === 'openai') throw Object.assign(new Error(`socket hang up ${MODEL_TEXT}`), { code: `socket hang up ${MODEL_TEXT}` });
        return reject;
      }),
    }));
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows: [row(0)] } : { rows: [] }));
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { summary, decisions } = await runReview({ cutoff, minScore: 0, limit: 5, queryFn, reviewMode: 'consensus',
      consensusProviders: providers, llmAttempts: 1, negativeTtlDays: 0 });
    jest.restoreAllMocks();
    const decision = decisions[0];
    expect(summary.review_error_by_code).toEqual({ OTHER: 1 });
    expect(decision.cross_agent_review.reviews.find((r) => r.provider === 'openai').error).toEqual({ code: 'OTHER' });
    expect(JSON.stringify(decision.cross_agent_review)).not.toContain(MODEL_TEXT);
    expect(JSON.stringify(summary)).not.toContain(MODEL_TEXT);
    expect(decision.review_error).toEqual({ code: 'OTHER', message: `socket hang up ${MODEL_TEXT}` });
  });

  test('consensus: the failed provider message is bounded', async () => {
    const providers = [['openai', 'gpt-4.1'], ['gemini', 'gemini-3-flash-preview']].map(([provider, model]) => ({
      __meta: { provider, model },
      analyzeTextToJson: jest.fn(async () => { if (provider === 'gemini') throw new LlmError('LLM_TIMEOUT', 'x'.repeat(500)); return reject; }),
    }));
    const queryFn = jest.fn(async (sql) => (/label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows: [row(0)] } : { rows: [] }));
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { decisions } = await runReview({ cutoff, minScore: 0, limit: 5, queryFn, reviewMode: 'consensus',
      consensusProviders: providers, llmAttempts: 1, negativeTtlDays: 0 });
    jest.restoreAllMocks();
    expect(decisions[0].review_error).toEqual({ code: 'LLM_TIMEOUT', message: 'x'.repeat(240) });
  });

  test('a relay label_id is bounded to 160 characters', () => {
    const parsed = JSON.parse(reviewErrorRelayLine([{ id: 'p'.repeat(300), verdict: 'error', review_error: { code: 'LLM_TIMEOUT', message: 'm' } }]));
    expect(parsed.samples[0].label_id).toBe('p'.repeat(160));
  });

  test('the relay still goes out when the serving-progress database read fails', async () => {
    const outDir = temp();
    try {
      const options = syncArgs(['--skip-review', '--select-hours', '24', '--out-dir', outDir], { now: new Date('2026-11-02T10:37:00.000Z') });
      const runner = jest.fn(async (_command, args) => {
        if (args[0].endsWith('run-relationship-graph-routine-job.js')) {
          const routineOut = args[args.indexOf('--out-dir') + 1];
          fs.mkdirSync(routineOut, { recursive: true });
          const review = path.join(routineOut, 'relationship_graph_ai_review.json');
          fs.writeFileSync(review, JSON.stringify({ summary: { reviewed_count: 30, review_error_count: 1, review_error_by_code: { LLM_TIMEOUT: 1 } },
            decisions: [{ id: 'label_1', verdict: 'error', review_error: { code: 'LLM_TIMEOUT', message: 'timed out' } }] }));
          fs.writeFileSync(path.join(routineOut, 'routine_summary.json'), JSON.stringify({ ok: true, artifacts: { review } }));
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      let reads = 0;
      const progressReader = async () => { reads += 1; if (reads > 1) throw new Error('connection terminated'); return { servedEdges: 0, anchors: new Set() }; };
      const writes = [];
      const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
      let summary;
      try {
        summary = await runSyncRoutine(options, { runner, now: new Date('2026-11-02T10:37:00.000Z'), progressReader,
          ledgerRecorder: async () => ({ recorded: true }) }).catch((err) => err.summary);
      } finally { spy.mockRestore(); }
      expect(reads).toBe(2);
      expect(summary.serving_progress_error).toBe('connection terminated');
      const relayed = writes.map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((line) => line && line.message === REVIEW_ERRORS_MARKER);
      expect(relayed).toHaveLength(1);
      expect(relayed[0].review_error_by_code).toEqual({ LLM_TIMEOUT: 1 });
    } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
  });
});

