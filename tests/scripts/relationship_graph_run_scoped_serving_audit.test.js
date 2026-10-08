jest.mock('../../src/services/relationshipGraphServingProgress', () => ({
  ...jest.requireActual('../../src/services/relationshipGraphServingProgress'),
  readServingSnapshot: jest.fn(async () => ({ servedEdges: 0, anchors: new Set() })),
  readReviewMetrics: jest.fn(() => ({ reviewed_count: 0, approved_count: 0, review_error_count: 0, review_error_rate: 0, guard_blocked_count: 0 })),
}));

// The routine's serving-audit gate scans the whole live approved table. On 2026-10-02..08 it failed
// every night on rows approved weeks earlier that the 10-01 guard widening had since made
// "suppressed" (and that the read path already hides), after build + review had committed. These
// tests pin the gate to the rows the run itself approved or renewed, using the real audit
// summarizer, threshold evaluator, renewal evaluator and step wiring.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summarizeSuppressionRows, parseArgs: parseAuditArgs } = require('../../scripts/audit-relationship-graph-serving-guard');
const {
  RUN_SCOPE_CLOCK_SKEW_MS,
  buildRoutineSteps,
  evaluateServingAuditThresholds,
  parseArgs,
  runRoutineJob,
} = require('../../scripts/run-relationship-graph-routine-job');
const { evaluateRenewalCandidates } = require('../../scripts/renew-relationship-ai-approved-labels');
const {
  DEFAULT_FAIL_REASONS,
  buildSyncRoutineSteps,
  parseArgs: parseSyncArgs,
  runSyncRoutine,
} = require('../../scripts/run-relationship-graph-sync-routine');

const RUN_START = new Date('2026-10-08T10:37:00.000Z');
const LEGACY_VERIFIED_AT = '2026-09-12T10:41:00.000Z';
const RUN_VERIFIED_AT = '2026-10-08T10:52:00.000Z';
// The production job's flags (relgraph-sync, 2026-10-08).
const PROD_GATE = {
  maxServingSuppressedPct: 1,
  maxServingSuppressedRows: 25,
  failOnServingSuppressionReasons: DEFAULT_FAIL_REASONS,
};

const tempRoots = [];
afterAll(() => tempRoots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function tempOutDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-run-scope-'));
  tempRoots.push(root);
  return path.join(root, 'out');
}

function approvedRow(id, overrides = {}) {
  return {
    id,
    anchor_type: 'product',
    anchor_ref: `product:ext_anchor_${id}`,
    anchor_snapshot: { brand: 'Anchor Co', title: `Barrier Serum ${id}` },
    candidate_product_ref: `product:ext_candidate_${id}`,
    candidate_snapshot: { brand: 'Candidate Co', title: `Ceramide Moisturizer ${id}` },
    relation_type: 'competitive_alternative',
    market: 'US',
    vertical: 'beauty',
    category_taxonomy: ['skincare'],
    use_case: 'barrier support',
    score_total: 0.82,
    score_breakdown: { score_total: 0.82 },
    price_evidence: {},
    source_refs: [{ type: 'external_product_seeds', authoritative: true }],
    evidence_grade: 'B',
    label_state: 'ai_approved',
    why_candidate: {},
    tradeoffs: [],
    watchouts: [],
    provenance: {},
    last_verified_at: RUN_VERIFIED_AT,
    expires_at: '2026-11-22T10:52:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: RUN_VERIFIED_AT,
    ...overrides,
  };
}

// The pair the 2026-10-08 audit printed: two sizes of one Dear Barber product, approved weeks before
// the guard learned to suppress same-product-across-sizes.
function dearBarberRow(id, overrides = {}) {
  return approvedRow(id, {
    anchor_snapshot: { brand: 'Dear Barber', title: 'Fibre 100ml - Barber' },
    candidate_snapshot: { brand: 'Dear Barber', title: 'Fibre 20ml - Barber' },
    relation_type: 'related_product',
    last_verified_at: LEGACY_VERIFIED_AT,
    ...overrides,
  });
}

function legacyTable() {
  // 30 legacy suppressed rows (above the 25-row cap) in a small table (well above 1%).
  const legacy = Array.from({ length: 30 }, (_, i) => dearBarberRow(`legacy_${i}`));
  const legacySafe = Array.from({ length: 50 }, (_, i) => approvedRow(`legacy_safe_${i}`, { last_verified_at: LEGACY_VERIFIED_AT }));
  const runSafe = Array.from({ length: 24 }, (_, i) => approvedRow(`run_safe_${i}`));
  return [...legacy, ...legacySafe, ...runSafe];
}

function auditFor(rows, since = new Date(RUN_START.getTime() - RUN_SCOPE_CLOCK_SKEW_MS).toISOString()) {
  return summarizeSuppressionRows(rows, { examplesPerReason: 8, generatedAt: '2026-10-08T11:20:00.000Z', runVerifiedSince: since });
}

describe('serving audit gate scoped to the rows this run wrote', () => {
  test('fixture: the Dear Barber pair really is suppressed by the guard', () => {
    const audit = summarizeSuppressionRows([dearBarberRow('legacy_probe')]);
    expect(audit.suppressed_rows).toBe(1);
    expect(audit.by_reason).toEqual({ related_product_same_product_across_listings_or_sizes: 1 });
  });

  test('2026-10-08 regression: legacy suppressed rows + a clean run passes the production gate', () => {
    const audit = auditFor(legacyTable());
    // The whole-table numbers that failed production are still in the artifact...
    expect(audit.suppressed_rows).toBe(30);
    expect(audit.suppressed_pct).toBeGreaterThan(1);
    // ...split by who wrote them.
    expect(audit.run_total_rows).toBe(24);
    expect(audit.run_suppressed_rows).toBe(0);
    expect(audit.legacy_total_rows).toBe(80);
    expect(audit.legacy_suppressed_rows).toBe(30);
    expect(audit.legacy_suppressed_by_reason).toEqual({ related_product_same_product_across_listings_or_sizes: 30 });
    expect(audit.legacy_suppressed_examples.related_product_same_product_across_listings_or_sizes).toHaveLength(8);

    expect(evaluateServingAuditThresholds(audit, PROD_GATE)).toEqual([]);
  });

  test('2026-10-08 regression: the same table + ONE unsafe row this run approved fails', () => {
    const audit = auditFor([...legacyTable(), dearBarberRow('run_unsafe', { last_verified_at: RUN_VERIFIED_AT })]);
    expect(audit.run_suppressed_rows).toBe(1);
    expect(audit.run_suppressed_examples.related_product_same_product_across_listings_or_sizes.map((ex) => ex.id)).toEqual(['run_unsafe']);

    expect(evaluateServingAuditThresholds(audit, PROD_GATE)).toEqual([
      expect.objectContaining({ metric: 'run_suppressed_rows', observed: 1, max: 0 }),
    ]);
  });

  test('the fail-on reasons list still applies to the run\'s own rows (and only to them)', () => {
    const nestedRef = { candidate_product_ref: 'product:product:ext_nested' };
    const legacyNested = approvedRow('legacy_nested', { ...nestedRef, last_verified_at: LEGACY_VERIFIED_AT });
    expect(evaluateServingAuditThresholds(auditFor([...legacyTable(), legacyNested]), PROD_GATE)).toEqual([]);

    const runNested = approvedRow('run_nested', nestedRef);
    expect(evaluateServingAuditThresholds(auditFor([...legacyTable(), runNested]), PROD_GATE)).toEqual([
      expect.objectContaining({ metric: 'run_suppressed_rows', observed: 1, max: 0 }),
      expect.objectContaining({
        metric: 'suppression_reason',
        scope: 'run',
        reason: 'candidate_ref_unresolvable_nested_product_prefix',
        observed: 1,
        max: 0,
      }),
    ]);
  });

  test('a renewal this run applied counts as this run (last_verified_at moved to the run)', () => {
    // Renewal stamps last_verified_at = now(); a renewed row is indistinguishable from a fresh approval.
    const renewed = dearBarberRow('renewed_unsafe', { last_verified_at: RUN_VERIFIED_AT, provenance: { re_verify: { first_verified_at: LEGACY_VERIFIED_AT } } });
    expect(evaluateServingAuditThresholds(auditFor([renewed]), PROD_GATE)).toEqual([
      expect.objectContaining({ metric: 'run_suppressed_rows', observed: 1 }),
    ]);
  });

  test('an artifact without the run split is still gated on the whole table (fail closed)', () => {
    const wholeTable = summarizeSuppressionRows(legacyTable());
    expect(wholeTable.run_verified_since).toBeUndefined();
    expect(evaluateServingAuditThresholds(wholeTable, PROD_GATE).map((v) => v.metric)).toEqual(['suppressed_rows', 'suppressed_pct']);
  });

  test('the audit CLI accepts --run-verified-since', () => {
    expect(parseAuditArgs(['--run-verified-since', '2026-10-08T10:35:00.000Z']).runVerifiedSince).toBe('2026-10-08T10:35:00.000Z');
    expect(parseAuditArgs([]).runVerifiedSince).toBe('');
  });

  test('the routine passes its run start (minus clock skew) to the audit step', () => {
    const options = parseArgs(['--skip-review', '--run-started-at', RUN_START.toISOString(), '--out-dir', '/tmp/x'], { now: new Date('2026-10-08T10:40:00Z') });
    const audit = buildRoutineSteps(options).steps.find((step) => step.id === 'serving_guard_audit');
    const since = audit.args[audit.args.indexOf('--run-verified-since') + 1];
    expect(since).toBe(new Date(RUN_START.getTime() - RUN_SCOPE_CLOCK_SKEW_MS).toISOString());

    // Standalone (no wrapper): the routine's own start.
    const standalone = parseArgs(['--skip-review', '--out-dir', '/tmp/x'], { now: RUN_START });
    expect(standalone.runStartedAt).toBe(RUN_START.toISOString());
  });

  test('the sync wrapper stamps its own start (before renewal) on the routine step', () => {
    const options = parseSyncArgs(['--skip-review', '--select-hours', '24'], { now: RUN_START, cwd: '/tmp/pivota' });
    const { steps } = buildSyncRoutineSteps(options);
    expect(steps[0].id).toBe('ai_approval_renewal');
    const routine = steps.find((step) => step.id === 'relationship_graph_routine');
    expect(routine.args[routine.args.indexOf('--run-started-at') + 1]).toBe(RUN_START.toISOString());
  });

  test('runRoutineJob: legacy suppression is reported + warned, does not fail; run suppression fails', async () => {
    async function run(rows) {
      const outDir = tempOutDir();
      const options = parseArgs([
        '--skip-review', '--skip-build', '--skip-validation', '--skip-lock', '--out-dir', outDir,
        '--run-started-at', RUN_START.toISOString(),
        '--max-serving-suppressed-pct', '1', '--max-serving-suppressed-rows', '25',
        '--fail-on-serving-suppression-reasons', DEFAULT_FAIL_REASONS.join(','),
      ], { now: RUN_START });
      // The fake audit child computes its artifact with the real summarizer from the args the
      // routine actually passed it.
      const runner = jest.fn(async (_command, args) => {
        const since = args[args.indexOf('--run-verified-since') + 1];
        const out = args[args.indexOf('--out') + 1];
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(summarizeSuppressionRows(rows, { runVerifiedSince: since })));
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const summary = await runRoutineJob(options, { runner, now: RUN_START });
        return { summary, warnings: stderr.mock.calls.map(([line]) => String(line)) };
      } catch (err) {
        return { error: err, summary: err.summary, warnings: stderr.mock.calls.map(([line]) => String(line)) };
      } finally {
        stderr.mockRestore();
      }
    }

    const clean = await run(legacyTable());
    expect(clean.error).toBeUndefined();
    expect(clean.summary.ok).toBe(true);
    expect(clean.summary.serving_audit_scope).toEqual(expect.objectContaining({
      run_total_rows: 24,
      run_suppressed_rows: 0,
      legacy_suppressed_rows: 30,
      legacy_suppressed_by_reason: { related_product_same_product_across_listings_or_sizes: 30 },
    }));
    expect(clean.summary.serving_audit_scope.legacy_suppressed_examples.related_product_same_product_across_listings_or_sizes[0])
      .toEqual(expect.objectContaining({ anchor_title: 'Fibre 100ml - Barber', candidate_title: 'Fibre 20ml - Barber' }));
    expect(clean.summary.warnings).toEqual([expect.stringMatching(/30 legacy approved edges are suppressed/)]);
    const warningLine = clean.warnings.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find(Boolean);
    expect(warningLine).toEqual(expect.objectContaining({ severity: 'WARNING', legacy_suppressed_rows: 30 }));
    expect(clean.summary.steps[0].threshold_status).toBe('passed');

    const unsafe = await run([...legacyTable(), dearBarberRow('run_unsafe', { last_verified_at: RUN_VERIFIED_AT })]);
    expect(unsafe.error).toMatchObject({ code: 'SERVING_AUDIT_THRESHOLD_VIOLATION' });
    expect(unsafe.summary.failed_step).toBe('serving_guard_audit_thresholds');
    expect(unsafe.summary.serving_audit_scope.run_suppressed_rows).toBe(1);
    expect(unsafe.summary.steps[0].threshold_violations).toEqual([
      expect.objectContaining({ metric: 'run_suppressed_rows', observed: 1, max: 0 }),
    ]);
  });
});

test('the sync wrapper re-emits the routine\'s legacy-suppression WARNING and keeps the split', async () => {
  const outDir = tempOutDir();
  const options = parseSyncArgs(['--skip-review', '--select-hours', '24', '--out-dir', outDir], { now: RUN_START });
  const scope = {
    run_verified_since: '2026-10-08T10:35:00.000Z',
    run_total_rows: 24,
    run_suppressed_rows: 0,
    legacy_suppressed_rows: 30,
    legacy_suppressed_pct: 0.32,
    legacy_suppressed_by_reason: { related_product_same_product_across_listings_or_sizes: 30 },
  };
  const runner = jest.fn(async (_command, args) => {
    if (args[0].endsWith('run-relationship-graph-routine-job.js')) {
      const routineOut = args[args.indexOf('--out-dir') + 1];
      fs.mkdirSync(routineOut, { recursive: true });
      fs.writeFileSync(path.join(routineOut, 'routine_summary.json'), JSON.stringify({ ok: true, artifacts: {}, serving_audit_scope: scope }));
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let summary;
  let written;
  try {
    summary = await runSyncRoutine(options, { runner, now: RUN_START });
  } finally {
    written = stderr.mock.calls.map(([line]) => String(line));
    stderr.mockRestore();
  }
  expect(summary.ok).toBe(true);
  expect(summary.serving_audit_scope).toEqual(scope);
  expect(summary.warnings).toEqual([expect.stringMatching(/^30 legacy approved edges are suppressed/)]);
  const lines = written.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  expect(lines).toEqual([expect.objectContaining({ severity: 'WARNING', legacy_suppressed_rows: 30, run_suppressed_rows: 0 })]);
});

describe('renewal never renews a guard-suppressed row', () => {
  const resolvable = new Set(['ext_anchor_legacy_db', 'ext_candidate_legacy_db', 'ext_anchor_safe', 'ext_candidate_safe']);

  test('the Dear Barber legacy row is skipped as suppressed; a safe row renews', () => {
    const suppressed = dearBarberRow('legacy_db', { expires_at: '2026-10-10T00:00:00.000Z' });
    const safe = approvedRow('safe', { last_verified_at: LEGACY_VERIFIED_AT, expires_at: '2026-10-10T00:00:00.000Z' });
    // Sanity: the audit's verdict on the same row.
    expect(summarizeSuppressionRows([suppressed]).suppressed_rows).toBe(1);

    const result = evaluateRenewalCandidates([suppressed, safe], resolvable, { nowMs: RUN_START.getTime() });
    expect(result.renewableIds).toEqual(['safe']);
    expect(result.skipped.suppressed).toBe(1);
    expect(result.suppressionReasons).toEqual({ related_product_same_product_across_listings_or_sizes: 1 });
  });

  test('every reason the audit can report on an approved row blocks renewal (same guard function)', () => {
    const rows = [
      dearBarberRow('legacy_db'),
      approvedRow('safe', { candidate_product_ref: 'product:product:ext_candidate_safe' }),
      approvedRow('safe', { relation_type: 'dupe', id: 'dupe_row' }),
    ].map((row) => ({ ...row, expires_at: '2026-10-10T00:00:00.000Z' }));
    const audit = summarizeSuppressionRows(rows);
    expect(audit.suppressed_rows).toBe(rows.length);
    const result = evaluateRenewalCandidates(rows, new Set([...resolvable, 'product:ext_candidate_safe']), { nowMs: RUN_START.getTime() });
    expect(result.renewableIds).toEqual([]);
    expect(result.skipped.suppressed).toBe(rows.length);
  });
});
