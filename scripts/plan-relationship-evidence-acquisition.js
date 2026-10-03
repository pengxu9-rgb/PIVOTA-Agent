#!/usr/bin/env node
'use strict';

// Offline input only. Never connects to DB/model APIs or publishes evidence.
const fs = require('node:fs');
const { summarizeRelationshipEvidenceReadiness, buildRelationshipEvidenceAcquisitionPlan } = require('../src/services/relationshipEvidenceReadiness');
const MAX_BYTES = 4 * 1024 * 1024;
function parseArgs(argv = process.argv.slice(2)) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--input', '--manifest-out', '--now', '--max-tasks'].includes(argv[i]) || values[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_evidence_plan_arguments');
    values[argv[i]] = argv[i + 1];
  }
  if (!values['--input']) throw new Error('evidence_plan_input_required');
  const nowMs = values['--now'] ? new Date(values['--now']).getTime() : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error('invalid_evidence_plan_clock');
  const maxTasks = values['--max-tasks'] === undefined ? 100 : Number(values['--max-tasks']);
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 200) throw new Error('invalid_evidence_plan_bound');
  return { inputFile: values['--input'], manifestOut: values['--manifest-out'] || null, nowMs, maxTasks };
}
function run({ options = parseArgs(), readInput, writeManifest } = {}) {
  const read = readInput || ((file) => {
    const fd = fs.openSync(file, 'r');
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > MAX_BYTES) throw new Error('evidence_plan_input_exceeds_size');
      const buffer = Buffer.alloc(MAX_BYTES + 1); const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > MAX_BYTES) throw new Error('evidence_plan_input_exceeds_size');
      return JSON.parse(buffer.subarray(0, count).toString('utf8'));
    } finally { fs.closeSync(fd); }
  });
  const input = read(options.inputFile);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_evidence_plan_input');
  const config = { products: input.products || [], pairs: input.pairs || [], nowMs: options.nowMs, maxTasks: options.maxTasks };
  const summary = summarizeRelationshipEvidenceReadiness(config);
  if (options.manifestOut) {
    const manifest = buildRelationshipEvidenceAcquisitionPlan(config);
    (writeManifest || ((file, body) => fs.writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600, flag: 'wx' })))(options.manifestOut, manifest);
    summary.planned_tasks = manifest.tasks.length;
    summary.omitted_gap_tasks = manifest.omitted_gap_tasks;
  }
  return summary;
}
if (require.main === module) {
  try { process.stdout.write(`RELGRAPH_EVIDENCE_PLAN ${JSON.stringify(run())}\n`); }
  catch (_) { process.stderr.write('RELGRAPH_EVIDENCE_PLAN failed; no evidence was acquired or published\n'); process.exitCode = 1; }
}
module.exports = { parseArgs, run };
