#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTimestampKey } from './internal_batch_helpers.mjs';
import { readJsonlRows, toPosix } from './local_image_loader.mjs';

const runExecFile = promisify(execFile);

const HELP_TEXT = `preference_eval_final.mjs

Usage:
  node scripts/preference_eval_final.mjs --manifest <manifest.json> --base_exports <export1.json,export2.json,...> [options]

Required:
  --manifest <path>                       preference round1 manifest
  --base_exports <csv>                    base Label Studio exports (csv/json list)

Options:
  --adj_exports <csv>                     optional adjudication Label Studio exports (csv/json list)
  --run_id <id>                           run id (default: infer from paths)
  --out_dir <dir>                         output working dir (default: artifacts/preference_round1_<run_id>/final)
  --report_dir <dir>                      report dir for eval/gate/final md (default: reports)
  --all_annotations <bool>                import all annotations (default: true)

  --overall_delta_min <n>                 gate threshold passthrough (default: 0.05)
  --forehead_delta_min <n>                gate threshold passthrough (default: 0.10)
  --cannot_tell_max <n>                   gate threshold passthrough (default: 0.25)
  --iaa_kappa_min <n>                     gate threshold passthrough (default: 0.2)
  --iaa_agreement_min <n>                 gate threshold passthrough (default: 0.6)
  --limit_top <n>                         gate contentious top limit (default: 20)

  --help                                  show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function splitList(raw) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    help: false,
    manifest: process.env.MANIFEST || '',
    base_exports: process.env.BASE_EXPORTS || '',
    adj_exports: process.env.ADJ_EXPORTS || '',
    run_id: process.env.RUN_ID || '',
    out_dir: process.env.OUT || process.env.OUT_DIR || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || 'reports',
    all_annotations: process.env.PREFERENCE_IMPORT_ALL_ANNOTATIONS || 'true',
    overall_delta_min: process.env.OVERALL_DELTA_MIN || '0.05',
    forehead_delta_min: process.env.FOREHEAD_DELTA_MIN || '0.10',
    cannot_tell_max: process.env.CANNOT_TELL_MAX || '0.25',
    iaa_kappa_min: process.env.IAA_KAPPA_MIN || '0.2',
    iaa_agreement_min: process.env.IAA_AGREEMENT_MIN || '0.6',
    limit_top: process.env.LIMIT_TOP || '20',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (!(key in out)) continue;
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = String(next);
    i += 1;
  }

  out.help = parseBool(out.help, false);
  out.manifest = String(out.manifest || '').trim();
  out.base_exports = splitList(out.base_exports).map((item) => path.resolve(item));
  out.adj_exports = splitList(out.adj_exports).map((item) => path.resolve(item));
  out.run_id = String(out.run_id || '').trim();
  out.out_dir = String(out.out_dir || '').trim();
  out.report_dir = String(out.report_dir || 'reports').trim() || 'reports';
  out.all_annotations = parseBool(out.all_annotations, true);
  out.overall_delta_min = String(out.overall_delta_min || '0.05').trim();
  out.forehead_delta_min = String(out.forehead_delta_min || '0.10').trim();
  out.cannot_tell_max = String(out.cannot_tell_max || '0.25').trim();
  out.iaa_kappa_min = String(out.iaa_kappa_min || '0.2').trim();
  out.iaa_agreement_min = String(out.iaa_agreement_min || '0.6').trim();
  out.limit_top = String(out.limit_top || '20').trim();
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [args.manifest, ...args.base_exports, ...args.adj_exports]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function parseJsonStdout(stdout, label) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error(`${label}: empty stdout`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid json stdout (${String(error && error.message ? error.message : error)})`);
  }
}

async function runNodeScript(scriptName, scriptArgs) {
  const scriptPath = path.resolve('scripts', scriptName);
  const { stdout } = await runExecFile('node', [scriptPath, ...scriptArgs], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024 * 64,
  });
  return parseJsonStdout(stdout, scriptName);
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function findModule(summary, moduleId) {
  if (!summary || !Array.isArray(summary.per_module)) return null;
  return summary.per_module.find((row) => String(row.module_id || '') === moduleId) || null;
}

function metricsFromEvalAndGate(evalSummary, gateSummary) {
  const overall = evalSummary && evalSummary.overall ? evalSummary.overall : {};
  const forehead = findModule(evalSummary, 'forehead');
  const iaa = evalSummary && evalSummary.iaa ? evalSummary.iaa : {};

  return {
    verdict: gateSummary ? gateSummary.verdict : null,
    baseline_win_rate: overall.baseline_win_rate ?? null,
    variant1_win_rate: overall.variant1_win_rate ?? null,
    variant1_minus_baseline:
      overall.variant1_win_rate != null && overall.baseline_win_rate != null
        ? round3(Number(overall.variant1_win_rate) - Number(overall.baseline_win_rate))
        : null,
    forehead_baseline_win_rate: forehead ? forehead.baseline_win_rate : null,
    forehead_variant1_win_rate: forehead ? forehead.variant1_win_rate : null,
    forehead_variant1_minus_baseline:
      forehead && forehead.variant1_win_rate != null && forehead.baseline_win_rate != null
        ? round3(Number(forehead.variant1_win_rate) - Number(forehead.baseline_win_rate))
        : null,
    cannot_tell_rate: overall.cannot_tell_rate ?? null,
    overlap_iaa_kappa: iaa.overall_kappa ?? null,
    overlap_iaa_agreement: iaa.overall_simple_agreement ?? null,
    overlap_samples_total: iaa.overlap_samples_total ?? null,
    overlap_samples_labeled_by_2plus: iaa.overlap_samples_labeled_by_2plus ?? null,
  };
}

function renderMetricsTable(title, metrics) {
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| verdict | ${metrics.verdict || '-'} |`);
  lines.push(`| baseline_win_rate | ${metrics.baseline_win_rate ?? '-'} |`);
  lines.push(`| variant1_win_rate | ${metrics.variant1_win_rate ?? '-'} |`);
  lines.push(`| variant1_minus_baseline | ${metrics.variant1_minus_baseline ?? '-'} |`);
  lines.push(`| forehead_baseline_win_rate | ${metrics.forehead_baseline_win_rate ?? '-'} |`);
  lines.push(`| forehead_variant1_win_rate | ${metrics.forehead_variant1_win_rate ?? '-'} |`);
  lines.push(`| forehead_variant1_minus_baseline | ${metrics.forehead_variant1_minus_baseline ?? '-'} |`);
  lines.push(`| cannot_tell_rate | ${metrics.cannot_tell_rate ?? '-'} |`);
  lines.push(`| overlap_iaa_kappa | ${metrics.overlap_iaa_kappa ?? '-'} |`);
  lines.push(`| overlap_iaa_agreement | ${metrics.overlap_iaa_agreement ?? '-'} |`);
  lines.push(`| overlap_samples_total | ${metrics.overlap_samples_total ?? '-'} |`);
  lines.push(`| overlap_samples_labeled_by_2plus | ${metrics.overlap_samples_labeled_by_2plus ?? '-'} |`);
  lines.push('');
  return lines;
}

function computeDelta(preMetrics, postMetrics) {
  return {
    variant1_minus_baseline_delta:
      preMetrics.variant1_minus_baseline != null && postMetrics.variant1_minus_baseline != null
        ? round3(Number(postMetrics.variant1_minus_baseline) - Number(preMetrics.variant1_minus_baseline))
        : null,
    cannot_tell_rate_delta:
      preMetrics.cannot_tell_rate != null && postMetrics.cannot_tell_rate != null
        ? round3(Number(postMetrics.cannot_tell_rate) - Number(preMetrics.cannot_tell_rate))
        : null,
    iaa_kappa_delta:
      preMetrics.overlap_iaa_kappa != null && postMetrics.overlap_iaa_kappa != null
        ? round3(Number(postMetrics.overlap_iaa_kappa) - Number(preMetrics.overlap_iaa_kappa))
        : null,
  };
}

function renderDeltaTable(delta) {
  const lines = [];
  lines.push('## Delta Summary (Post - Pre)');
  lines.push('');
  lines.push('| metric | delta |');
  lines.push('|---|---:|');
  lines.push(`| variant1_minus_baseline_delta | ${delta.variant1_minus_baseline_delta ?? '-'} |`);
  lines.push(`| cannot_tell_rate_delta | ${delta.cannot_tell_rate_delta ?? '-'} |`);
  lines.push(`| overlap_iaa_kappa_delta | ${delta.iaa_kappa_delta ?? '-'} |`);
  lines.push('');
  return lines;
}

function summarizeFinalAdjudicatedWinners(rows) {
  const bySample = new Map();
  for (const row of rows) {
    const decisionSource = String(row.decision_source || '').trim().toLowerCase();
    if (decisionSource !== 'adjudication') continue;
    const moduleId = String(row.module_id || 'overall').trim().toLowerCase() || 'overall';
    if (moduleId !== 'overall') continue;

    const sampleId = String(row.sample_id || row.sample_hash || '').trim();
    if (!sampleId) continue;
    if (!bySample.has(sampleId)) {
      bySample.set(sampleId, {
        sample_id: sampleId,
        counts: { baseline: 0, variant1: 0, tie: 0, cannot_tell: 0 },
        votes_total: 0,
      });
    }

    const winner = String(row.winner || '').trim().toLowerCase();
    const entry = bySample.get(sampleId);
    if (Object.prototype.hasOwnProperty.call(entry.counts, winner)) {
      entry.counts[winner] += 1;
      entry.votes_total += 1;
    }
  }

  const orderedChoices = ['variant1', 'baseline', 'tie', 'cannot_tell'];
  const items = [...bySample.values()].map((entry) => {
    const finalWinner = orderedChoices
      .map((choice) => ({ choice, count: entry.counts[choice] || 0 }))
      .sort((a, b) => b.count - a.count || a.choice.localeCompare(b.choice))[0];

    return {
      sample_id: entry.sample_id,
      votes_total: entry.votes_total,
      final_winner: finalWinner.count > 0 ? finalWinner.choice : null,
      counts: entry.counts,
    };
  });

  return items.sort((a, b) => String(a.sample_id).localeCompare(String(b.sample_id)));
}

function renderFinalReport({
  runId,
  inputs,
  preMetrics,
  postMetrics,
  delta,
  adjudicatedFinal,
  artifacts,
}) {
  const lines = [];
  lines.push('# Preference Final Report');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- manifest: \`${inputs.manifest}\``);
  lines.push('- base_exports:');
  inputs.base_exports.forEach((token) => lines.push(`  - \`${token}\``));
  if (inputs.adj_exports.length) {
    lines.push('- adj_exports:');
    inputs.adj_exports.forEach((token) => lines.push(`  - \`${token}\``));
  } else {
    lines.push('- adj_exports: -');
  }
  lines.push('');

  lines.push(...renderMetricsTable('Pre-Adjudication', preMetrics));
  if (inputs.adj_exports.length) {
    lines.push(...renderMetricsTable('Post-Adjudication', postMetrics));
    lines.push(...renderDeltaTable(delta));
  }

  lines.push('## Adjudicated Sample Final Winners');
  lines.push('');
  lines.push('| rank | sample_id | final_winner | votes_total | baseline_votes | variant1_votes | tie_votes | cannot_tell_votes |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|');
  if (!adjudicatedFinal.length) {
    lines.push('| 1 | - | - | - | - | - | - | - |');
  } else {
    adjudicatedFinal.forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id} | ${row.final_winner || '-'} | ${row.votes_total} | ${row.counts.baseline} | ${row.counts.variant1} | ${row.counts.tie} | ${row.counts.cannot_tell} |`);
    });
  }
  lines.push('');

  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- base_labels_ndjson: \`${artifacts.base_labels_ndjson}\``);
  if (artifacts.adjudication_labels_ndjson) {
    lines.push(`- adjudication_labels_ndjson: \`${artifacts.adjudication_labels_ndjson}\``);
  }
  if (artifacts.merged_labels_ndjson) {
    lines.push(`- merged_labels_ndjson: \`${artifacts.merged_labels_ndjson}\``);
  }
  lines.push(`- pre_eval_json: \`${artifacts.pre_eval_json}\``);
  lines.push(`- pre_gate_md: \`${artifacts.pre_gate_md}\``);
  if (artifacts.post_eval_json) {
    lines.push(`- post_eval_json: \`${artifacts.post_eval_json}\``);
  }
  if (artifacts.post_gate_md) {
    lines.push(`- post_gate_md: \`${artifacts.post_gate_md}\``);
  }
  lines.push(`- final_report_md: \`${artifacts.final_report_md}\``);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function runEvalAndGate({
  runId,
  labelsPath,
  manifestPath,
  reportDir,
  gateArgs,
}) {
  const evalSummary = await runNodeScript('eval_preference.mjs', [
    '--labels', labelsPath,
    '--manifest', manifestPath,
    '--run_id', runId,
    '--report_dir', reportDir,
  ]);

  const gateSummary = await runNodeScript('preference_release_gate.mjs', [
    '--eval_jsonl', path.resolve(evalSummary.artifacts.report_jsonl),
    '--eval_md', path.resolve(evalSummary.artifacts.report_md),
    '--eval_json', path.resolve(evalSummary.artifacts.report_json),
    '--manifest', manifestPath,
    '--run_id', runId,
    '--report_dir', reportDir,
    '--overall_delta_min', gateArgs.overall_delta_min,
    '--forehead_delta_min', gateArgs.forehead_delta_min,
    '--cannot_tell_max', gateArgs.cannot_tell_max,
    '--iaa_kappa_min', gateArgs.iaa_kappa_min,
    '--iaa_agreement_min', gateArgs.iaa_agreement_min,
    '--limit_top', gateArgs.limit_top,
  ]);

  return { evalSummary, gateSummary };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }

  if (!args.manifest) {
    process.stderr.write('preference_eval_final: missing --manifest\n');
    process.exit(2);
    return;
  }
  if (!args.base_exports.length) {
    process.stderr.write('preference_eval_final: missing --base_exports\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const manifestPath = path.resolve(args.manifest);
  const reportDir = path.resolve(args.report_dir);
  const outDir = path.resolve(args.out_dir || path.join('artifacts', `preference_round1_${runId}`, 'final'));

  await Promise.all([
    fsp.mkdir(reportDir, { recursive: true }),
    fsp.mkdir(outDir, { recursive: true }),
  ]);

  const baseLabelsPath = path.resolve(path.join(outDir, 'base_labels.ndjson'));
  const adjudicationLabelsPath = path.resolve(path.join(outDir, 'adjudication_labels.ndjson'));
  const mergedLabelsPath = path.resolve(path.join(outDir, 'preference_labels_merged.ndjson'));

  const gateArgs = {
    overall_delta_min: args.overall_delta_min,
    forehead_delta_min: args.forehead_delta_min,
    cannot_tell_max: args.cannot_tell_max,
    iaa_kappa_min: args.iaa_kappa_min,
    iaa_agreement_min: args.iaa_agreement_min,
    limit_top: args.limit_top,
  };

  const baseImport = await runNodeScript('preference_label_import.mjs', [
    '--exports', args.base_exports.join(','),
    '--manifest', manifestPath,
    '--out', baseLabelsPath,
    '--run_id', `${runId}_base`,
    '--all_annotations', args.all_annotations ? 'true' : 'false',
    '--report_dir', reportDir,
  ]);

  const preRunId = `${runId}_pre`;
  const pre = await runEvalAndGate({
    runId: preRunId,
    labelsPath: baseLabelsPath,
    manifestPath,
    reportDir,
    gateArgs,
  });

  let post = pre;
  let mergeSummary = null;
  let adjImport = null;
  let adjudicatedFinal = [];
  let finalLabelsPath = baseLabelsPath;

  if (args.adj_exports.length) {
    adjImport = await runNodeScript('preference_label_import.mjs', [
      '--exports', args.adj_exports.join(','),
      '--manifest', manifestPath,
      '--out', adjudicationLabelsPath,
      '--run_id', `${runId}_adj`,
      '--all_annotations', args.all_annotations ? 'true' : 'false',
      '--report_dir', reportDir,
    ]);

    mergeSummary = await runNodeScript('preference_merge_adjudication.mjs', [
      '--base_labels', baseLabelsPath,
      '--adj_labels', adjudicationLabelsPath,
      '--out', mergedLabelsPath,
      '--run_id', `${runId}_merge`,
      '--report_dir', reportDir,
    ]);

    finalLabelsPath = mergedLabelsPath;

    const postRunId = `${runId}_post`;
    post = await runEvalAndGate({
      runId: postRunId,
      labelsPath: mergedLabelsPath,
      manifestPath,
      reportDir,
      gateArgs,
    });

    const mergedRows = await readJsonlRows(mergedLabelsPath);
    adjudicatedFinal = summarizeFinalAdjudicatedWinners(mergedRows);
  }

  const preMetrics = metricsFromEvalAndGate(pre.evalSummary, pre.gateSummary);
  const postMetrics = metricsFromEvalAndGate(post.evalSummary, post.gateSummary);
  const delta = computeDelta(preMetrics, postMetrics);

  const finalMdPath = path.resolve(path.join(reportDir, `PREFERENCE_FINAL_${runId}.md`));
  const finalJsonPath = path.resolve(path.join(outDir, `preference_final_${runId}.json`));

  const reportText = renderFinalReport({
    runId,
    inputs: {
      manifest: toPosix(path.relative(process.cwd(), manifestPath)),
      base_exports: args.base_exports.map((token) => toPosix(path.relative(process.cwd(), token))),
      adj_exports: args.adj_exports.map((token) => toPosix(path.relative(process.cwd(), token))),
    },
    preMetrics,
    postMetrics,
    delta,
    adjudicatedFinal,
    artifacts: {
      base_labels_ndjson: toPosix(path.relative(process.cwd(), baseLabelsPath)),
      adjudication_labels_ndjson: args.adj_exports.length ? toPosix(path.relative(process.cwd(), adjudicationLabelsPath)) : null,
      merged_labels_ndjson: args.adj_exports.length ? toPosix(path.relative(process.cwd(), mergedLabelsPath)) : null,
      pre_eval_json: pre.evalSummary.artifacts.report_json,
      pre_gate_md: pre.gateSummary.artifacts.release_gate_md,
      post_eval_json: args.adj_exports.length ? post.evalSummary.artifacts.report_json : null,
      post_gate_md: args.adj_exports.length ? post.gateSummary.artifacts.release_gate_md : null,
      final_report_md: toPosix(path.relative(process.cwd(), finalMdPath)),
    },
  });

  await Promise.all([
    fsp.writeFile(finalMdPath, reportText, 'utf8'),
    fsp.writeFile(finalJsonPath, `${JSON.stringify({
      ok: true,
      run_id: runId,
      inputs: {
        manifest: toPosix(path.relative(process.cwd(), manifestPath)),
        base_exports: args.base_exports.map((token) => toPosix(path.relative(process.cwd(), token))),
        adj_exports: args.adj_exports.map((token) => toPosix(path.relative(process.cwd(), token))),
      },
      pre: {
        import: baseImport,
        eval: pre.evalSummary,
        gate: pre.gateSummary,
      },
      post: args.adj_exports.length ? {
        import: adjImport,
        merge: mergeSummary,
        eval: post.evalSummary,
        gate: post.gateSummary,
      } : null,
      metrics: {
        pre: preMetrics,
        post: postMetrics,
        delta,
      },
      adjudicated_final_winners: adjudicatedFinal,
      artifacts: {
        base_labels_ndjson: toPosix(path.relative(process.cwd(), baseLabelsPath)),
        adjudication_labels_ndjson: args.adj_exports.length ? toPosix(path.relative(process.cwd(), adjudicationLabelsPath)) : null,
        merged_labels_ndjson: args.adj_exports.length ? toPosix(path.relative(process.cwd(), mergedLabelsPath)) : null,
        final_report_md: toPosix(path.relative(process.cwd(), finalMdPath)),
        final_summary_json: toPosix(path.relative(process.cwd(), finalJsonPath)),
      },
      final_labels_path: toPosix(path.relative(process.cwd(), finalLabelsPath)),
      final_verdict: postMetrics.verdict,
      generated_at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8'),
  ]);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    final_verdict: postMetrics.verdict,
    pre_verdict: preMetrics.verdict,
    post_verdict: postMetrics.verdict,
    adjudication_applied: args.adj_exports.length > 0,
    adjudicated_samples_total: adjudicatedFinal.length,
    artifacts: {
      base_labels_ndjson: toPosix(path.relative(process.cwd(), baseLabelsPath)),
      adjudication_labels_ndjson: args.adj_exports.length ? toPosix(path.relative(process.cwd(), adjudicationLabelsPath)) : null,
      merged_labels_ndjson: args.adj_exports.length ? toPosix(path.relative(process.cwd(), mergedLabelsPath)) : null,
      final_report_md: toPosix(path.relative(process.cwd(), finalMdPath)),
      final_summary_json: toPosix(path.relative(process.cwd(), finalJsonPath)),
      pre_eval_json: pre.evalSummary.artifacts.report_json,
      post_eval_json: args.adj_exports.length ? post.evalSummary.artifacts.report_json : null,
      pre_gate_md: pre.gateSummary.artifacts.release_gate_md,
      post_gate_md: args.adj_exports.length ? post.gateSummary.artifacts.release_gate_md : null,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_eval_final_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
