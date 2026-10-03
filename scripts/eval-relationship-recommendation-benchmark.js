#!/usr/bin/env node
'use strict';

// No DB/imported production samples. Network/model calls require --live-consensus.
const fs = require('node:fs');
const path = require('node:path');
const dataset = require('../tests/fixtures/relgraph_recommendation_benchmark');
const { buildCaseRow, caseFingerprint, datasetFingerprint, evaluateBenchmark } = require('../src/services/relationshipRecommendationBenchmark');
const { validReviewerIdentity } = require('../src/services/relationshipCrossAgentReview');

async function runBenchmarkReviews(cases, { providers, evaluatedAt = new Date().toISOString(), mode = 'synthetic_mock' } = {}) {
  const fingerprint = datasetFingerprint(cases);
  if (!['synthetic_mock', 'live_consensus'].includes(mode)) throw new Error('Invalid benchmark review mode');
  if (!Array.isArray(providers) || providers.length !== 2 || providers[0] === providers[1] ||
      !validReviewerIdentity(providers[0].__meta, 'openai') || !validReviewerIdentity(providers[1].__meta, 'gemini')) {
    throw new Error('Independent GPT and Gemini providers are required');
  }
  const { buildEvidence, reviewWithConsensus, servingGuardReasonsIfApproved } = require('./review-relationship-candidate-labels');
  const decisions = [];
  // One pair at a time caps each run at two independent provider requests in flight.
  for (const item of cases.cases) {
    const row = buildCaseRow(item, evaluatedAt); const guard = servingGuardReasonsIfApproved(row, { allowDupeAiApproval: true });
    let decision;
    if (guard.length) decision = { verdict: 'reject', relationship_kind: null, guard_reasons: guard };
    else decision = await reviewWithConsensus(row, buildEvidence(row, new Map()), providers, { attempts: 1, confidenceFloor: 0.90 });
    decisions.push({ case_id: item.id, case_fingerprint: caseFingerprint(item, evaluatedAt),
      verdict: decision.verdict, relationship_kind: decision.relationship_kind,
      confidence: decision.confidence ?? null,
      ...(decision.guard_reasons ? { guard_reasons: decision.guard_reasons } : {}),
      ...(decision.review_error ? { review_error: decision.review_error } : {}),
      ...(decision.cross_agent_review ? { cross_agent_review: decision.cross_agent_review } : {}),
    });
  }
  return { schema_version: 'relgraph.benchmark_decisions.v1', dataset_fingerprint: fingerprint,
    evaluated_at: evaluatedAt, mode,
    reviewers: providers.map(p => ({ provider: p.__meta.provider, model: p.__meta.model })), decisions };
}

function parseArgs(argv) {
  const args = { live: false, gate: false, decisions: '', out: '', decisionsOut: '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--live-consensus') args.live = true;
    else if (flag === '--gate') args.gate = true;
    else if (flag === '--help') args.help = true;
    else if (['--decisions', '--out', '--decisions-out'].includes(flag)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`Missing ${flag} path`);
      args[({ '--decisions': 'decisions', '--out': 'out', '--decisions-out': 'decisionsOut' })[flag]] = value;
    } else throw new Error(`Unknown benchmark option: ${flag}`);
  }
  if (args.live && args.decisions) throw new Error('Choose imported decisions or live consensus');
  if (args.decisionsOut && !args.live) throw new Error('--decisions-out requires --live-consensus');
  if (args.out && args.decisions && path.resolve(args.out) === path.resolve(args.decisions)) throw new Error('Do not overwrite the input review artifact');
  if (args.out && args.decisionsOut && path.resolve(args.out) === path.resolve(args.decisionsOut)) throw new Error('Evaluation and decision artifacts need separate paths');
  return args;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/eval-relationship-recommendation-benchmark.js [--decisions file | --live-consensus] [--out file] [--decisions-out file] [--gate]\nDefault reports reference-case readiness without database access or model calls.\n');
    return;
  }
  let artifact = args.decisions ? JSON.parse(fs.readFileSync(args.decisions, 'utf8')) : null;
  if (args.live) {
    const { createConsensusProviders } = require('./review-relationship-candidate-labels');
    artifact = await runBenchmarkReviews(dataset, { providers: createConsensusProviders(), mode: 'live_consensus' });
    if (args.decisionsOut) writeJson(args.decisionsOut, artifact);
  }
  const report = evaluateBenchmark(dataset, artifact);
  if (args.out) writeJson(args.out, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.gate && !report.gate.passed) process.exitCode = 1;
  return report;
}
if (require.main === module) main().catch(err => { process.stderr.write(`Benchmark failed: ${err.message}\n`); process.exitCode = 1; });
module.exports = { runBenchmarkReviews, parseArgs, main };
