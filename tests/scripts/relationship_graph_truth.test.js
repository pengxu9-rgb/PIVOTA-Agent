const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const samples = require('../fixtures/relgraph_0930_titles.json');
const { getRelationshipEdgeServingSuppressionReasons: reasons } = require('../../src/auroraBff/productRelationshipGraph');
const { parseArgs: reviewArgs, runReview, applyApproval } = require('../../scripts/review-relationship-candidate-labels');
const { runRoutineJob, parseArgs } = require('../../scripts/run-relationship-graph-routine-job');
const { readServingSnapshot, servingProgress, reviewErrorGateExceeded, reviewMetrics } = require('../../src/services/relationshipGraphServingProgress');
const { buildCronArgs } = require('../../scripts/run-relationship-graph-sync-routine-cron');
const { buildSyncRoutineSteps, parseArgs: syncArgs, runSyncRoutine } = require('../../scripts/run-relationship-graph-sync-routine');
const REASON = 'related_product_same_product_across_listings_or_sizes';
const cutoff = '2026-09-01T00:00:00Z';
function edge(anchor, candidate, state = 'ai_approved', relation = 'related_product') {
  const snapshot = (title) => ({ brand: title.split(' | ')[0], title });
  return { anchor_type: 'product', anchor_ref: 'product:a', candidate_product_ref: 'product:b',
    anchor_snapshot: snapshot(anchor), candidate_snapshot: snapshot(candidate), label_state: state, relation_type: relation };
}
let dirs = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relgraph-truth-')); dirs.push(dir); return dir; };
afterEach(() => { jest.restoreAllMocks(); dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })); dirs = []; });

test.each(samples)('sample $i retains only the two known listing defects', ({ i, rel, anchor, cand }) => {
  const suppressed = reasons(edge(anchor, cand, 'ai_approved', rel));
  if ([12, 20].includes(i)) expect(suppressed).toContain(REASON);
  else expect(suppressed).toEqual([]);
});
test.each([
  ['Test | Barrier Support Cream 30ml', 'test | Barrier Support Cream - 0.5 oz', true],
  ['Test | Barrier Support Cream Travel Size', 'Test | Barrier Support Cream Full Size', true],
  ['Test | Barrier Support Cream', 'Test | Barrier Support Cream', true],
  ['Test | Barrier Serum 30ml', 'test | Barrier Serum 50ml', true],
  ['Test | Retinol 0.2% in Squalane 30ml', 'Test | Retinol 1% in Squalane 30ml', false],
  ['Test | Barrier Support Cream', 'Test | Barrier Support Cream with Retinol', false],
  ['Test | Barrier Support Cream', 'Other | Barrier Support Cream', false],
  ['Test | Barrier Support Cream Mini', 'Test | Barrier Support Cream with Retinol', false],
  ['Test | Daily Face Sunscreen SPF 30', 'Test | Daily Face Sunscreen SPF 50', false],
])('listing normalization %s vs %s', (a, b, suppressed) => expect(reasons(edge(a, b)).includes(REASON)).toBe(suppressed));
test('same-product reason is AI-only, missing brands and other relations stay untouched', () => {
  expect(reasons(edge(samples[19].anchor, samples[19].cand, 'human_approved'))).toEqual([]);
  const unknown = edge(samples[19].anchor, samples[19].cand); unknown.anchor_snapshot.brand = ''; unknown.candidate_snapshot.brand = '';
  expect(reasons(unknown)).toEqual([]);
  expect(reasons(edge(samples[19].anchor, samples[19].cand, 'ai_approved', 'competitive_alternative'))).toEqual([]);
});
test('confidence floor clamps and defence in depth refuses without a database write', async () => {
  expect(reviewArgs(['--cutoff', cutoff]).minApprovalConfidence).toBe(0.7);
  expect(reviewArgs(['--cutoff', cutoff, '--min-approval-confidence', '0']).minApprovalConfidence).toBe(0.5);
  expect(reviewArgs(['--cutoff', cutoff, '--min-approval-confidence', '2']).minApprovalConfidence).toBe(0.99);
  const queryFn = jest.fn();
  await expect(applyApproval({ id: 'a' }, { confidence: 0.69 }, queryFn)).rejects.toMatchObject({ code: 'LOW_CONFIDENCE_AI_APPROVAL_BLOCKED' });
  await expect(applyApproval({ id: 'a' }, {}, queryFn)).rejects.toMatchObject({ code: 'LOW_CONFIDENCE_AI_APPROVAL_BLOCKED' });
  expect(queryFn).not.toHaveBeenCalled();
});
test.each([false, true])('LLM/replay obey confidence floor (replay=%s)', async (replay) => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const rows = [0.69999, 0.70].map((confidence, i) => ({ ...edge('Test | Hydrating Face Cream', 'Test | Gentle Face Cleanser', 'generated'), id: `r${i}`, confidence }));
  const verdict = (confidence) => ({ verdict: 'approve', confidence, rationale: 'Complementary products in one facial care routine.' });
  const provider = { analyzeTextToJson: jest.fn(async () => verdict(rows[provider.analyzeTextToJson.mock.calls.length - 1].confidence)) };
  const dir = temp(); const replayFile = path.join(dir, 'verdicts.json');
  fs.writeFileSync(replayFile, JSON.stringify(rows.map((r) => ({ id: r.id, ...verdict(r.confidence) }))));
  const queryFn = jest.fn(async (sql, params) => /label_state = 'generated'/.test(sql) && /SELECT/.test(sql) ? { rows }
    : /UPDATE relationship_candidate_labels/.test(sql) ? { rows: [{ id: params[0] }] } : { rows: [] });
  const oldGate = process.env.RELGRAPH_AI_REVIEW_APPLY; process.env.RELGRAPH_AI_REVIEW_APPLY = '1';
  try {
    const result = await runReview({ cutoff, minScore: 0, limit: 10, apply: true, queryFn, provider, verdictsFile: replay ? replayFile : '' });
    expect(result.decisions.map((d) => [d.verdict, d.new_label_state, d.applied])).toEqual([
      ['low_confidence', 'generated', false], ['approve', 'ai_approved', true],
    ]);
    expect(result.summary).toMatchObject({ low_confidence_count: 1, applied_count: 1, approved_count: 1 });
  } finally { if (oldGate === undefined) delete process.env.RELGRAPH_AI_REVIEW_APPLY; else process.env.RELGRAPH_AI_REVIEW_APPLY = oldGate; }
});
test.each([[20, 20, true], [250, 15, false], [19, 19, false], [20, 5, false], [20, 6, true]])('routine review gate %i/%i errors', async (reviewed, errors, fail) => {
  const dir = temp(); const options = parseArgs(['--cutoff', cutoff, '--skip-build', '--skip-validation', '--skip-serving-audit', '--out-dir', dir]);
  const runner = async (_command, args) => {
    fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ summary: { reviewed_count: reviewed, review_error_count: errors, approved_count: 0 }, decisions: [] }));
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const progressReader = async () => ({ servedEdges: 0, anchors: new Set() });
  const result = await runRoutineJob(options, { runner, progressReader }).catch((err) => err.summary);
  expect(result.ok).toBe(!fail);
  expect(result.review_error_rate).toBe(errors / reviewed);
  if (fail) expect(result).toMatchObject({ failed_step: 'ai_review', steps: [expect.objectContaining({ exit_code: 1, status: 'failed' })] });
});
test('missing review artifact fails closed', async () => {
  const options = parseArgs(['--cutoff', cutoff, '--skip-build', '--skip-validation', '--skip-serving-audit', '--out-dir', temp()]);
  await expect(runRoutineJob(options, { runner: async () => ({ exitCode: 0 }), progressReader: async () => ({ servedEdges: 0, anchors: new Set() }) })).rejects.toMatchObject({ summary: { failed_step: 'ai_review' } });
});
test('progress excludes hidden labels and counts new anchors, not more edges on old anchors', async () => {
  const safe = edge('Test | Hydrating Face Cream', 'Test | Gentle Face Cleanser');
  const before = await readServingSnapshot({ queryFn: async () => ({ rows: [safe, edge(samples[19].anchor, samples[19].cand)] }) });
  const after = await readServingSnapshot({ queryFn: async () => ({ rows: [safe, { ...safe, candidate_product_ref: 'product:c' }, { ...safe, anchor_ref: 'product:new' }] }) });
  expect(servingProgress(before, after)).toEqual({ served_edges_before: 1, served_edges_after: 3, distinct_anchors_served_before: 1, distinct_anchors_served_after: 2, anchors_newly_covered: 1 });
});
test('error gate uses the raw fraction and supports explicit thresholds', () => {
  expect(reviewErrorGateExceeded(reviewMetrics({ reviewed_count: 21, review_error_count: 5 }), { maxReviewErrorRate: 0.23 })).toBe(true);
  expect(reviewErrorGateExceeded(reviewMetrics({ reviewed_count: 5, review_error_count: 5 }), { minReviewsForErrorGate: 5 })).toBe(true);
});
test('sync progress includes renewal and reaches the ledger summary', async () => {
  const dir = temp(); const options = syncArgs(['--cutoff', cutoff, '--affected-products-file', path.join(dir, 'affected.json'), '--out-dir', dir, '--record-run-ledger']);
  fs.writeFileSync(options.affectedProductsFile, JSON.stringify({ affected_products: [] }));
  let renewed = false;
  const progressReader = jest.fn(async () => ({ servedEdges: renewed ? 2 : 1, anchors: new Set(renewed ? ['old', 'new'] : ['old']) }));
  const ledgerRecorder = jest.fn(async (summary) => { expect(summary).toMatchObject({ served_edges_before: 1, served_edges_after: 2, anchors_newly_covered: 1 }); return { run_id: summary.run_id }; });
  await runSyncRoutine(options, { progressReader, ledgerRecorder, runner: async () => { expect(progressReader).toHaveBeenCalled(); renewed = true; return { exitCode: 0 }; } });
  expect(ledgerRecorder).toHaveBeenCalledTimes(1);
});

test('cron error rate and confidence options reach sync, routine and reviewer', () => {
  const config = buildCronArgs({ RELGRAPH_SYNC_MAX_REVIEW_ERROR_RATE:'0.06', RELGRAPH_SYNC_MIN_REVIEWS_FOR_ERROR_GATE:'30', RELGRAPH_SYNC_MIN_APPROVAL_CONFIDENCE:'0.85' });
  const sync = syncArgs(config.args);
  const child = buildSyncRoutineSteps(sync).steps.find((step) => step.id === 'relationship_graph_routine');
  const routine = parseArgs(child.args.slice(1));
  expect(routine).toMatchObject({ maxReviewErrorRate:0.06, minReviewsForErrorGate:30, minApprovalConfidence:0.85 });
  const reviewer = require('../../scripts/run-relationship-graph-routine-job').buildRoutineSteps(routine).steps.find((step) => step.id === 'ai_review');
  expect(reviewArgs(reviewer.args.slice(1)).minApprovalConfidence).toBe(0.85);
});
test('all schema-invalid LLM results fail the routine without opening the transport breaker', async () => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const options = parseArgs(['--cutoff',cutoff,'--skip-build','--skip-validation','--skip-serving-audit','--out-dir',temp()]);
  const rows = Array.from({length:20}, (_,i) => ({...edge('Test | Hydrating Face Cream','Test | Gentle Face Cleanser','generated'),id:`schema_${i}`}));
  let review;
  const runner = async (_command,args) => {
    review = await runReview({cutoff,minScore:0,limit:20,llmAttempts:1,out:args[args.indexOf('--out')+1],
      queryFn:async(sql) => ({rows:/SELECT/.test(sql) && /label_state = 'generated'/.test(sql) ? rows:[]}),
      provider:{analyzeTextToJson:async()=>{const err=new Error('schema invalid');err.code='LLM_SCHEMA_INVALID';throw err;}}});
    return {exitCode:0};
  };
  await expect(runRoutineJob(options,{runner,progressReader:async()=>({servedEdges:0,anchors:new Set()})})).rejects.toMatchObject({summary:{failed_step:'ai_review',review_error_count:20,review_error_rate:1}});
  expect(review.summary.review_circuit_open).toBe(false);
});
test('the quarantine command can target the new reason by name', () => {
  const { selectUnsafeRows } = require('../../scripts/quarantine-relationship-graph-serving-unsafe');
  const row = edge(samples[19].anchor,samples[19].cand);
  const result = selectUnsafeRows([row],{reasons:[REASON]});
  expect(result.selected).toHaveLength(1);
});
test('a previous low-confidence review output can be replayed without promotion', async () => {
  jest.spyOn(process.stdout,'write').mockImplementation(()=>true);
  const replayFile=path.join(temp(),'low.json');
  fs.writeFileSync(replayFile,JSON.stringify({decisions:[{id:'low',verdict:'low_confidence',confidence:0.69,rationale:'Plausible routine relation with partial evidence.'}]}));
  const row={...edge('Test | Hydrating Face Cream','Test | Gentle Face Cleanser','generated'),id:'low'};
  const result=await runReview({cutoff,minScore:0,limit:1,verdictsFile:replayFile,queryFn:async(sql)=>({rows:/SELECT/.test(sql)&&/label_state = 'generated'/.test(sql)?[row]:[]})});
  expect(result.decisions[0]).toMatchObject({verdict:'low_confidence',new_label_state:'generated',applied:false});
});
test('progress query failure after work fails the run and records the failure', async () => {
  const dir=temp();fs.writeFileSync(path.join(dir,'affected.json'),'{}');
  const options=syncArgs(['--cutoff',cutoff,'--skip-renewal','--affected-products-file',path.join(dir,'affected.json'),'--out-dir',dir,'--record-run-ledger']);
  let reads=0;
  const ledgerRecorder=jest.fn(async(summary)=>{expect(summary).toMatchObject({ok:false,failed_step:'serving_progress',served_edges_after:null});return{};});
  await expect(runSyncRoutine(options,{runner:async()=>({exitCode:0}),ledgerRecorder,progressReader:async()=>{if(reads++)throw new Error('snapshot unavailable');return {servedEdges:1,anchors:new Set(['old'])};}})).rejects.toMatchObject({summary:{serving_progress_error:'snapshot unavailable'}});
  expect(ledgerRecorder).toHaveBeenCalledTimes(1);
});
