'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const dataset = require('../fixtures/relgraph_recommendation_benchmark');
const { buildCaseRow, caseFingerprint, datasetFingerprint, evaluateBenchmark } = require('../../src/services/relationshipRecommendationBenchmark');
const { runBenchmarkReviews, parseArgs } = require('../../scripts/eval-relationship-recommendation-benchmark');
const NOW = '2026-10-02T00:00:00.000Z';
function artifact(results, mode = 'imported_review') {
  return { schema_version: 'relgraph.benchmark_decisions.v1', dataset_fingerprint: datasetFingerprint(dataset),
    evaluated_at: NOW, mode, decisions: results.map(([id, verdict, kind]) => ({ case_id: id, verdict,
      relationship_kind: kind, case_fingerprint: caseFingerprint(dataset.cases.find(c => c.id === id), NOW) })) };
}

test('default CLI does not turn a curated corpus into measured model accuracy', () => {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/eval-relationship-recommendation-benchmark.js'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' } }));
  expect(report.overall).toMatchObject({ cases: 36, reviewed: 0, observed_approval_precision: null, useful_recommendation_recall: null });
  expect(report.production_precision).toBeNull();
  expect(report.gate).toMatchObject({ passed: false, failures: expect.arrayContaining(['review_incomplete']) });
});
test('a wrong dupe approval and approved variant cannot hide behind overall agreement', () => {
  const report = evaluateBenchmark(dataset, artifact([
    ['rgq007', 'approve', 'alternative'], ['rgq015', 'approve', 'dupe'],
    ['rgq001', 'approve', 'alternative'], ['rgq017', 'approve', 'dupe'],
  ]));
  expect(report.overall.observed_approval_precision).toBe(0.5);
  expect(report.by_approved_kind.dupe.observed_approval_precision).toBe(0.5);
  expect(report).toMatchObject({ variant_approval_count: 1, incorrect_dupe_approval_count: 1 });
  expect(report.gate.failures).toEqual(expect.arrayContaining(['variants_approved', 'incorrect_dupe_claims', 'review_incomplete']));
});
test('rejecting everything yields no approval precision and zero useful recall', () => {
  const report = evaluateBenchmark(dataset, artifact(dataset.cases.map(c => [c.id, 'reject', 'none'])));
  expect(report.overall.observed_approval_precision).toBeNull();
  expect(report.overall.useful_recommendation_recall).toBe(0);
  expect(report.gate.passed).toBe(false);
});
test('wrong kind is an incorrect approval; an unresolved approval remains unadjudicated', () => {
  const report = evaluateBenchmark(dataset, artifact([['rgq025','approve','alternative'], ['rgq034','approve','alternative']]));
  expect(report.overall).toMatchObject({ approvals: 2, incorrect_approvals: 1, unsupported_approvals: 1, correct_approvals: 0, approval_adjudication_coverage: 0.5 });
  expect(report.gate.failures).toContain('approvals_on_unresolved_evidence');
});
test('missing, duplicated, changed-clock and changed-fixture outputs cannot masquerade as a complete run', () => {
  const result = artifact([['rgq007','approve','alternative']]);
  expect(() => evaluateBenchmark(dataset, { ...result, decisions: [...result.decisions, ...result.decisions] })).toThrow('duplicate');
  expect(() => evaluateBenchmark(dataset, { ...result, evaluated_at: '2026-10-03T00:00:00Z' })).toThrow('stale');
  expect(() => evaluateBenchmark(dataset, { ...result, dataset_fingerprint: 'wrong' })).toThrow('match');
  expect(() => evaluateBenchmark(dataset, artifact([['rgq007','approve','variant']]))).toThrow('invalid');
});
test('mock perfect reviewer outcomes never qualify for release or production accuracy', () => {
  const mocked = artifact(dataset.cases.map(c => [c.id,c.expected.verdict,c.expected.relationship_kind]), 'synthetic_mock');
  const report = evaluateBenchmark(dataset, mocked);
  expect(report.overall.observed_approval_precision).toBe(1);
  expect(report.gate.failures).toContain('mock_reviews_do_not_qualify_for_release');
  expect(report.production_precision).toBeNull();
});
test('declaring live consensus cannot qualify missing or malformed reviewer proofs', () => {
  const forged = artifact(dataset.cases.map(c => [c.id,c.expected.verdict,c.expected.relationship_kind]), 'live_consensus');
  expect(() => evaluateBenchmark(dataset, { ...forged, reviewers: [] })).toThrow('reviewer identities');
  forged.reviewers = [{ provider:'openai',model:'gpt-fixture' }, { provider:'gemini',model:'gemini-fixture' }];
  forged.decisions.forEach(d => { d.cross_agent_review = { schema:'malformed',verdict:'reject',reviews:[] }; });
  expect(() => evaluateBenchmark(dataset, forged)).toThrow('consensus proof');
});
test('live artifacts bind providers, facts and final outcomes and verify guard rejections', async () => {
  const item=dataset.cases.find(c=>c.id==='rgq007');
  const small={...dataset,cases:[item]};
  const {consumerCopyForKind}=require('../../scripts/review-relationship-candidate-labels');
  const decision={verdict:'approve',confidence:0.95,relationship_kind:'alternative',rationale:'Both facts support the same facial moisturizer job.',
    shared_evidence:[{anchor_fact:item.anchor.title,candidate_fact:item.candidate.title}],...consumerCopyForKind('alternative')};
  const providers=['openai','gemini'].map(provider=>({__meta:{provider,model:provider==='openai'?'gpt-fixture':'gemini-fixture'},analyzeTextToJson:jest.fn(async()=>decision)}));
  const reviewed=await runBenchmarkReviews(small,{providers,mode:'live_consensus'});
  expect(evaluateBenchmark(small,reviewed).overall.correct_approvals).toBe(1);
  const cloned=()=>JSON.parse(JSON.stringify(reviewed));
  const changedVerdict=cloned();changedVerdict.decisions[0].verdict='reject';
  expect(()=>evaluateBenchmark(small,changedVerdict)).toThrow('consensus outcome');
  const changedProvider=cloned();changedProvider.reviewers[0].model='gpt-different';
  expect(()=>evaluateBenchmark(small,changedProvider)).toThrow('identity mismatch');
  const ungrounded=cloned();ungrounded.decisions[0].cross_agent_review.reviews[0].decision.shared_evidence[0].anchor_fact='Unstated clinical equivalence';
  expect(()=>evaluateBenchmark(small,ungrounded)).toThrow('approval evidence');
  const variant={...dataset,cases:[dataset.cases[0]]};
  const guarded=await runBenchmarkReviews(variant,{providers,mode:'live_consensus'});
  expect(evaluateBenchmark(variant,guarded).overall.rejections).toBe(1);
  guarded.decisions[0].guard_reasons=['invented_guard'];
  expect(()=>evaluateBenchmark(variant,guarded)).toThrow('guard rejection');
});
test('consensus runner sends facts without gold labels/strata to two independent reviewers', async () => {
  const item = dataset.cases.find(c => c.id === 'rgq007');
  const { consumerCopyForKind } = require('../../scripts/review-relationship-candidate-labels');
  const decision = { verdict:'approve',confidence:0.94,relationship_kind:'alternative',rationale:'Both products are facial moisturizers from distinct lines.',
    shared_evidence:[{anchor_fact:item.anchor.title,candidate_fact:item.candidate.title}],...consumerCopyForKind('alternative') };
  const providers = ['openai','gemini'].map(provider => ({ __meta:{provider,model:provider==='openai'?'gpt-fixture':'gemini-fixture'}, analyzeTextToJson:jest.fn(async()=>decision) }));
  const small = {...dataset,cases:[item]};
  const reviewed = await runBenchmarkReviews(small, { providers, evaluatedAt: NOW });
  expect(reviewed.decisions[0]).toMatchObject({ verdict:'approve',relationship_kind:'alternative' });
  const prompt = providers[0].analyzeTextToJson.mock.calls[0][0].prompt;
  expect(prompt).toBe(providers[1].analyzeTextToJson.mock.calls[0][0].prompt);
  expect(prompt).not.toContain(item.expected.basis);
  expect(prompt).not.toContain('cross_brand_alternative');
  expect(prompt).not.toContain('"expected"');
  expect(buildCaseRow(item,NOW).id).toBe('rgq007');
});
test('hash-consistent proofs cannot erase the full dupe price validation result', async () => {
  const item=dataset.cases.find(c=>c.id==='rgq015');
  const small={...dataset,cases:[item]};
  const {consumerCopyForKind}=require('../../scripts/review-relationship-candidate-labels');
  const {combineReviews}=require('../../src/services/relationshipCrossAgentReview');
  const {coerceRelationshipEdge}=require('../../src/auroraBff/productRelationshipGraph');
  const decision={verdict:'approve',confidence:0.95,relationship_kind:'dupe',rationale:'Curated synthetic formula facts support this pair.',
    shared_evidence:[{anchor_fact:item.anchor.title,candidate_fact:item.candidate.title}],...consumerCopyForKind('dupe')};
  const providers=['openai','gemini'].map(provider=>({__meta:{provider,model:provider==='openai'?'gpt-fixture':'gemini-fixture'},analyzeTextToJson:jest.fn(async()=>decision)}));
  const future=new Date(Date.now()+3*86400000).toISOString();
  const reviewed=await runBenchmarkReviews(small,{providers,mode:'live_consensus',evaluatedAt:future});
  expect(reviewed.decisions[0].verdict).toBe('human_review');
  expect(evaluateBenchmark(small,reviewed).overall.abstentions).toBe(1);
  const old=reviewed.decisions[0];
  expect(old.cross_agent_review.reviews.every(r=>r.validation_error==='dupe_price_observation_in_future')).toBe(true);
  old.cross_agent_review.reviews.forEach(r=>{ delete r.validation_error; });
  const recombined=combineReviews(coerceRelationshipEdge(buildCaseRow(item,future)),old.cross_agent_review.reviews,0.90);
  Object.assign(old,{verdict:recombined.verdict,relationship_kind:recombined.relationship_kind,confidence:recombined.confidence,cross_agent_review:recombined.cross_agent_review});
  expect(()=>evaluateBenchmark(small,reviewed)).toThrow('validation result');
});
test('variant fixtures are rejected by the actual review guard without spending model calls', async () => {
  const providers = ['openai','gemini'].map(provider => ({ __meta:{provider,model:provider==='openai'?'gpt-fixture':'gemini-fixture'}, analyzeTextToJson:jest.fn() }));
  const reviewed = await runBenchmarkReviews({...dataset,cases:[dataset.cases[0]]}, { providers, evaluatedAt: NOW });
  expect(reviewed.decisions[0].verdict).toBe('reject');
  expect(providers.every(p=>p.analyzeTextToJson.mock.calls.length===0)).toBe(true);
});
test('provider failures remain visible even when consensus routes them to human review', async () => {
  const item=dataset.cases.find(c=>c.id==='rgq007');
  const providers=['openai','gemini'].map(provider=>({__meta:{provider,model:provider==='openai'?'gpt-fixture':'gemini-fixture'},analyzeTextToJson:jest.fn(async()=>{throw Object.assign(new Error('Synthetic timeout'),{code:'LLM_TIMEOUT'});})}));
  const small={...dataset,cases:[item]};
  const reviewed=await runBenchmarkReviews(small,{providers,evaluatedAt:NOW});
  const report=evaluateBenchmark(small,reviewed);
  expect(report.overall).toMatchObject({reviewed:1,errors:1,abstentions:1,approvals:0});
  expect(report.gate.failures).toContain('review_errors');
});
test('the synthetic corpus retains valid pair opportunities through actual consensus validation', async () => {
  const {consumerCopyForKind}=require('../../scripts/review-relationship-candidate-labels');
  const providers=['openai','gemini'].map(provider=>({__meta:{provider,model:provider==='openai'?'gpt-fixture':'gemini-fixture'},analyzeTextToJson:jest.fn(async({prompt})=>{
    const facts=JSON.parse(prompt.split('Candidate evidence JSON:\n')[1]);
    const item=dataset.cases.find(c=>c.id===facts.id);
    const kind=item.expected.relationship_kind==='unknown'?'none':item.expected.relationship_kind;
    return {verdict:item.expected.verdict,confidence:0.95,relationship_kind:kind,rationale:'Synthetic plumbing regression, not a model quality measurement.',
      recommendation_reason:'Insufficient supporting facts.',tradeoffs:[],watchouts:[],shared_evidence:[{anchor_fact:facts.anchor.title,candidate_fact:facts.candidate.title}],...(consumerCopyForKind(kind)||{})};
  })}));
  const reviewed=await runBenchmarkReviews(dataset,{providers});
  expect(reviewed.decisions.filter(d=>d.verdict==='approve'&&d.relationship_kind==='alternative')).toHaveLength(8);
  expect(reviewed.decisions.filter(d=>d.verdict==='approve'&&d.relationship_kind==='dupe')).toHaveLength(2);
  expect(reviewed.decisions.filter(d=>d.verdict==='approve'&&d.relationship_kind==='complement')).toHaveLength(4);
  expect(reviewed.decisions.find(d=>d.case_id==='rgq034')).toMatchObject({verdict:'human_review'});
  expect(evaluateBenchmark(dataset,reviewed).gate.failures).toContain('mock_reviews_do_not_qualify_for_release');
});
test('gate CLI fails incomplete review and protects input artifacts from overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'relgraph-benchmark-'));
  try {
    const file = path.join(dir,'decisions.json');fs.writeFileSync(file,JSON.stringify(artifact([['rgq007','approve','alternative']])));
    const result=spawnSync(process.execPath,['scripts/eval-relationship-recommendation-benchmark.js','--decisions',file,'--gate'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'});
    expect(result.status).toBe(1);expect(JSON.parse(result.stdout).gate.failures).toContain('review_incomplete');
    expect(()=>parseArgs(['--decisions',file,'--out',file])).toThrow('overwrite');
    expect(()=>parseArgs(['--live-consensus','--decisions',file])).toThrow('Choose');
    expect(()=>parseArgs(['--apply'])).toThrow('Unknown');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
