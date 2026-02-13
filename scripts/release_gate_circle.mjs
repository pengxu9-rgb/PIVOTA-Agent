#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTimestampKey } from './internal_batch_helpers.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const DEFAULT_REPORT_DIR = 'reports';
const DEFAULT_LIMIT = 150;
const GATE_DEFAULTS = Object.freeze({
  iaa_min: 0.75,
  gold_strong_min: 0.55,
  forehead_hair_overlap_max: 0.25,
  under_eye_coverage_p50_min: 0.4,
  under_eye_leakage_bg_max: 0.1,
  crossset_leakage_bg_max: 0.1,
});

const HELP_TEXT = `release_gate_circle.mjs

Usage:
  node scripts/release_gate_circle.mjs [options]

Report-input mode (D1):
  --gold_jsonl <reports/eval_gold_*.jsonl>
  --ab_json <reports/eval_gold_ab_*.json>
  --crossset_json <reports/eval_circle_crossset_*.json>
  --iaa_json <reports/eval_gold_iaa_*.json>         optional

Orchestrated mode (D2):
  --ls_export <label_studio_export_round1_*.json>
  --review_jsonl <reports/review_pack_mixed_*.jsonl>
  --run_id <id>                                      optional but recommended
  --limit <n>                                        default 150

Common options:
  --report_dir <dir>                                 default: reports
  --help                                             show help
`;

function parseBool(value, fallback = false) {
  const token = String(value == null ? '' : value).trim().toLowerCase();
  if (!token) return fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function mean(values) {
  const valid = values.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (!valid.length) return null;
  return valid.reduce((acc, item) => acc + item, 0) / valid.length;
}

function percentile(values, p = 0.5) {
  const valid = values
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .sort((a, b) => a - b);
  if (!valid.length) return null;
  const rank = Math.max(0, Math.min(valid.length - 1, Math.floor((valid.length - 1) * p)));
  return valid[rank];
}

function toPosix(input) {
  return String(input || '').replace(/\\/g, '/');
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  const candidates = [args.ls_export, args.review_jsonl, args.gold_jsonl, args.ab_json, args.crossset_json];
  for (const item of candidates) {
    const base = path.basename(String(item || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

function parseArgs(argv) {
  const out = {
    help: false,
    run_id: process.env.RUN_ID || '',
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULT_REPORT_DIR,
    limit: process.env.LIMIT || DEFAULT_LIMIT,
    ls_export: process.env.LS_EXPORT || '',
    review_jsonl: process.env.REVIEW_JSONL || process.env.PRED_JSONL || '',
    gold_jsonl: process.env.GOLD_JSONL || '',
    ab_json: process.env.AB_JSON || '',
    iaa_json: process.env.IAA_JSON || '',
    crossset_json: process.env.CROSSSET_JSON || '',
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
    if (!next || String(next).startsWith('--')) continue;
    out[key] = String(next);
    i += 1;
  }
  out.help = parseBool(out.help, false);
  out.run_id = String(out.run_id || '').trim();
  out.report_dir = String(out.report_dir || DEFAULT_REPORT_DIR).trim() || DEFAULT_REPORT_DIR;
  out.limit = Math.max(1, Math.min(5000, Math.trunc(parseNumber(out.limit, DEFAULT_LIMIT, 1, 5000))));
  out.ls_export = String(out.ls_export || '').trim();
  out.review_jsonl = String(out.review_jsonl || '').trim();
  out.gold_jsonl = String(out.gold_jsonl || '').trim();
  out.ab_json = String(out.ab_json || '').trim();
  out.iaa_json = String(out.iaa_json || '').trim();
  out.crossset_json = String(out.crossset_json || '').trim();
  return out;
}

function parseJsonObject(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('empty_stdout');
  try {
    return JSON.parse(text);
  } catch (_error) {
    // fallback
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    const candidate = lines.slice(i).join('\n');
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // continue
    }
  }
  throw new Error('json_parse_failed');
}

async function readNdjson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

async function readJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function runNodeScript(scriptRelPath, args = [], options = {}) {
  const scriptPath = path.resolve(REPO_ROOT, scriptRelPath);
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
  });
  let payload = null;
  try {
    payload = parseJsonObject(run.stdout);
  } catch (_error) {
    payload = null;
  }
  const ok = Number(run.status || 0) === 0;
  if (!ok && !options.allowFailure) {
    const detail = String(run.stderr || run.stdout || '').slice(0, 800);
    throw new Error(`script_failed:${scriptRelPath}:${detail}`);
  }
  return {
    ok,
    status: Number.isFinite(run.status) ? run.status : 1,
    payload,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
  };
}

function pickBestVariantOverlapDelta(abPayload) {
  const groups = Array.isArray(abPayload && abPayload.groups) ? abPayload.groups : [];
  const candidates = groups.filter((group) => {
    const id = String(group.group_id || '');
    return id.startsWith('variant1') || id.startsWith('variant3');
  });
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => {
    const deltaA = Number(a.delta_vs_baseline && a.delta_vs_baseline.forehead_hair_overlap_rate_mean);
    const deltaB = Number(b.delta_vs_baseline && b.delta_vs_baseline.forehead_hair_overlap_rate_mean);
    return deltaA - deltaB;
  });
  const best = sorted[0];
  return {
    group_id: best.group_id,
    delta_forehead_overlap: round3(Number(best.delta_vs_baseline && best.delta_vs_baseline.forehead_hair_overlap_rate_mean)),
  };
}

function renderMarkdown({ runId, inputs, gate, metrics, recommendedGroup, topWorst, retrainDecision, files }) {
  const lines = [];
  lines.push(`# RELEASE GATE CIRCLE (${gate.pass ? 'PASS' : 'FAIL'})`);
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- gate: ${gate.pass ? 'PASS' : 'FAIL'}`);
  lines.push(`- recommended_group: ${recommendedGroup || '-'}`);
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push(`- gold_jsonl: \`${inputs.goldJsonlRel || '-'}\``);
  lines.push(`- ab_json: \`${inputs.abJsonRel || '-'}\``);
  lines.push(`- iaa_json: \`${inputs.iaaJsonRel || '-'}\``);
  lines.push(`- crossset_json: \`${inputs.crosssetJsonRel || '-'}\``);
  lines.push('');
  lines.push('## Gate Conditions');
  lines.push('');
  lines.push('| id | condition | observed | threshold | pass |');
  lines.push('|---:|---|---|---|---|');
  for (const condition of gate.conditions) {
    lines.push(
      `| ${condition.id} | ${condition.name} | ${condition.observed} | ${condition.threshold} | ${condition.pass ? 'PASS' : (condition.skipped ? 'SKIP' : 'FAIL')} |`,
    );
  }
  lines.push('');
  lines.push('## Key Metrics');
  lines.push('');
  lines.push(`- gold_strong_module_mIoU_mean: ${metrics.gold_strong_module_miou_mean ?? '-'}`);
  lines.push(`- gold_forehead_hair_overlap_rate_mean: ${metrics.gold_forehead_hair_overlap_rate_mean ?? '-'}`);
  lines.push(`- gold_under_eye_band_coverage_p50: ${metrics.gold_under_eye_band_coverage_p50 ?? '-'}`);
  lines.push(`- gold_under_eye_leakage_bg_mean: ${metrics.gold_under_eye_leakage_bg_mean ?? '-'}`);
  lines.push(`- crossset_celeb_lapa_leakage_bg_mean: ${metrics.crossset_celeb_lapa_leakage_bg_mean ?? '-'}`);
  lines.push(`- crossset_celeb_lapa_leakage_hair_mean: ${metrics.crossset_celeb_lapa_leakage_hair_mean ?? '-'}`);
  if (metrics.iaa_strong_module_miou_mean != null) {
    lines.push(`- iaa_strong_module_mIoU_A_vs_B_mean: ${metrics.iaa_strong_module_miou_mean}`);
  }
  lines.push('');
  lines.push('## Top20 Worst Gold Samples');
  lines.push('');
  lines.push('| rank | sample_hash | source | driver_score | strong_module_mIoU | under_eye_cov | under_eye_leak_bg | forehead_hair_overlap | fail_reason |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---|');
  if (!topWorst.length) {
    lines.push('| 1 | - | - | - | - | - | - | - | - |');
  } else {
    topWorst.forEach((row, idx) => {
      lines.push(
        `| ${idx + 1} | ${row.sample_hash || '-'} | ${row.source || '-'} | ${row.driver_score ?? '-'} | ${row.strong_module_miou_mean ?? '-'} | ${row.under_eye_band_coverage_mean ?? '-'} | ${row.under_eye_leakage_bg_mean ?? '-'} | ${row.forehead_hair_overlap_rate ?? '-'} | ${row.fail_reason || '-'} |`,
      );
    });
  }
  lines.push('');
  lines.push('## Retrain Decision');
  lines.push('');
  lines.push(`- decision: ${retrainDecision.decision}`);
  lines.push(`- rationale: ${retrainDecision.rationale}`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- report_md: \`${files.mdRel}\``);
  lines.push(`- report_json: \`${files.jsonRel}\``);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function resolveInputsOrRunPipeline(args, runId) {
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });

  let goldJsonlPath = args.gold_jsonl ? path.resolve(args.gold_jsonl) : '';
  let abJsonPath = args.ab_json ? path.resolve(args.ab_json) : '';
  let iaaJsonPath = args.iaa_json ? path.resolve(args.iaa_json) : '';
  let crosssetJsonPath = args.crossset_json ? path.resolve(args.crossset_json) : '';

  const missingCore = !goldJsonlPath || !abJsonPath || !crosssetJsonPath;
  if (!missingCore) {
    return { goldJsonlPath, abJsonPath, iaaJsonPath, crosssetJsonPath, orchestrated: false };
  }

  if (!args.ls_export || !args.review_jsonl) {
    throw new Error('missing_inputs: provide gold_jsonl+ab_json+crossset_json OR ls_export+review_jsonl');
  }

  const goldOutDir = path.resolve(REPO_ROOT, 'artifacts', `gold_round1_real_${runId}`);
  const goldLabelsPath = path.join(goldOutDir, 'gold_labels.ndjson');
  await fsp.mkdir(goldOutDir, { recursive: true });

  runNodeScript('scripts/gold_label_import.mjs', [
    '--in', path.resolve(args.ls_export),
    '--out', goldLabelsPath,
    '--run_id', runId,
    '--report_dir', reportDir,
  ]);

  const evalGold = runNodeScript('scripts/eval_gold.mjs', [
    '--gold_labels', goldLabelsPath,
    '--pred_jsonl', path.resolve(args.review_jsonl),
    '--report_dir', reportDir,
    '--rerun_local', 'true',
  ]);
  goldJsonlPath = path.resolve(REPO_ROOT, evalGold.payload.report_jsonl);

  const evalAb = runNodeScript('scripts/eval_gold_ab.mjs', [
    '--gold_labels', goldLabelsPath,
    '--pred_jsonl', path.resolve(args.review_jsonl),
    '--report_dir', reportDir,
    '--rerun_local', 'true',
  ]);
  abJsonPath = path.resolve(REPO_ROOT, evalAb.payload.report_json);

  const evalIaa = runNodeScript('scripts/eval_gold_iaa.mjs', [
    '--ls_export', path.resolve(args.ls_export),
    '--run_id', runId,
    '--report_dir', reportDir,
  ], { allowFailure: true });
  if (evalIaa.ok && evalIaa.payload && evalIaa.payload.report_json) {
    iaaJsonPath = path.resolve(REPO_ROOT, evalIaa.payload.report_json);
  } else {
    iaaJsonPath = '';
  }

  const crossset = runNodeScript('scripts/eval_circle_crossset.mjs', [
    '--datasets', 'celebamaskhq,lapa',
    '--limit', String(args.limit),
    '--report_dir', reportDir,
  ]);
  crosssetJsonPath = path.resolve(REPO_ROOT, crossset.payload.report_json);

  return { goldJsonlPath, abJsonPath, iaaJsonPath, crosssetJsonPath, orchestrated: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }

  const runId = inferRunId(args);
  const resolved = await resolveInputsOrRunPipeline(args, runId);

  if (!fs.existsSync(resolved.goldJsonlPath)) throw new Error(`gold_jsonl_not_found:${resolved.goldJsonlPath}`);
  if (!fs.existsSync(resolved.abJsonPath)) throw new Error(`ab_json_not_found:${resolved.abJsonPath}`);
  if (!fs.existsSync(resolved.crosssetJsonPath)) throw new Error(`crossset_json_not_found:${resolved.crosssetJsonPath}`);

  const goldRows = await readNdjson(resolved.goldJsonlPath);
  const abPayload = await readJson(resolved.abJsonPath);
  const crosssetPayload = await readJson(resolved.crosssetJsonPath);
  const iaaPayload = resolved.iaaJsonPath && fs.existsSync(resolved.iaaJsonPath) ? await readJson(resolved.iaaJsonPath) : null;

  const goldStrongMiouMean = mean(goldRows.map((row) => row.strong_module_miou_mean));
  const goldForeheadOverlapMean = mean(goldRows.map((row) => row.forehead_hair_overlap_rate));
  const goldUnderEyeCovP50 = percentile(goldRows.map((row) => row.under_eye_band_coverage_mean), 0.5);
  const goldUnderEyeLeakBgMean = mean(goldRows.map((row) => row.under_eye_leakage_bg_mean));

  const crosssetSummaries = Array.isArray(crosssetPayload && crosssetPayload.summaries) ? crosssetPayload.summaries : [];
  const celebLapaRows = crosssetSummaries.filter((row) => ['celebamaskhq', 'lapa'].includes(String(row.dataset || '').toLowerCase()));
  const crosssetLeakBgMean = mean(celebLapaRows.map((row) => row.leakage_bg_mean));
  const crosssetLeakHairMean = mean(celebLapaRows.map((row) => row.leakage_hair_mean));

  const iaaStrongMean = iaaPayload
    ? Number(
      iaaPayload.strong_module_miou_a_vs_b_mean
      ?? (iaaPayload.summary && iaaPayload.summary.strong_module_miou_a_vs_b_mean),
    )
    : null;

  const gateConditions = [
    {
      id: 1,
      name: 'IAA strong_module_mIoU_A_vs_B_mean',
      observed: iaaPayload ? `${round3(iaaStrongMean)}` : 'N/A',
      threshold: `>= ${GATE_DEFAULTS.iaa_min}`,
      pass: iaaPayload ? iaaStrongMean >= GATE_DEFAULTS.iaa_min : true,
      skipped: !iaaPayload,
    },
    {
      id: 2,
      name: 'Gold strong_module_mIoU_mean',
      observed: `${round3(goldStrongMiouMean)}`,
      threshold: `>= ${GATE_DEFAULTS.gold_strong_min}`,
      pass: Number(goldStrongMiouMean) >= GATE_DEFAULTS.gold_strong_min,
      skipped: false,
    },
    {
      id: 3,
      name: 'Gold forehead_hair_overlap_rate_mean',
      observed: `${round3(goldForeheadOverlapMean)}`,
      threshold: `<= ${GATE_DEFAULTS.forehead_hair_overlap_max}`,
      pass: Number(goldForeheadOverlapMean) <= GATE_DEFAULTS.forehead_hair_overlap_max,
      skipped: false,
    },
    {
      id: 4,
      name: 'Gold under-eye weak metrics',
      observed: `coverage_p50=${round3(goldUnderEyeCovP50)}, leakage_bg_mean=${round3(goldUnderEyeLeakBgMean)}`,
      threshold: `coverage_p50>=${GATE_DEFAULTS.under_eye_coverage_p50_min} and leakage_bg_mean<=${GATE_DEFAULTS.under_eye_leakage_bg_max}`,
      pass: Number(goldUnderEyeCovP50) >= GATE_DEFAULTS.under_eye_coverage_p50_min
        && Number(goldUnderEyeLeakBgMean) <= GATE_DEFAULTS.under_eye_leakage_bg_max,
      skipped: false,
    },
    {
      id: 5,
      name: 'Crossset Celeb+LaPa leakage_bg_mean',
      observed: `${round3(crosssetLeakBgMean)}`,
      threshold: `<= ${GATE_DEFAULTS.crossset_leakage_bg_max}`,
      pass: Number(crosssetLeakBgMean) <= GATE_DEFAULTS.crossset_leakage_bg_max,
      skipped: false,
    },
  ];
  const gatePass = gateConditions.every((item) => item.pass || item.skipped);

  const recommendedGroup = String(abPayload && abPayload.recommended_group ? abPayload.recommended_group : '');
  const bestOverlapDelta = pickBestVariantOverlapDelta(abPayload);

  let retrainDecision = {
    decision: 'DEFER_RETRAIN',
    rationale: 'Current evidence suggests parameter-level tuning can continue while collecting more Round1 labels.',
  };
  if (crosssetLeakHairMean != null && crosssetLeakHairMean > 0.12 && (!bestOverlapDelta || Number(bestOverlapDelta.delta_forehead_overlap) > -0.02)) {
    retrainDecision = {
      decision: 'RETRAIN_RECOMMENDED',
      rationale: `Crossset hair leakage remains high (${round3(crosssetLeakHairMean)}), while variant1/3 overlap gain is limited (${bestOverlapDelta ? bestOverlapDelta.delta_forehead_overlap : 'n/a'}). Prioritize skinmask/hair-mask retrain.`,
    };
  } else if (bestOverlapDelta && Number(bestOverlapDelta.delta_forehead_overlap) <= -0.03) {
    retrainDecision = {
      decision: 'RETRAIN_NOT_URGENT',
      rationale: `Variant ${bestOverlapDelta.group_id} already cuts forehead-hair overlap by ${bestOverlapDelta.delta_forehead_overlap}. Apply parameter update first, then re-check gold/crossset drift.`,
    };
  }

  const topWorst = [...goldRows]
    .sort((a, b) => Number(b.driver_score || -Infinity) - Number(a.driver_score || -Infinity))
    .slice(0, 20);

  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });
  const reportMdPath = path.join(reportDir, `RELEASE_GATE_CIRCLE_${runId}.md`);
  const reportJsonPath = path.join(reportDir, `RELEASE_GATE_CIRCLE_${runId}.json`);

  const payload = {
    ok: true,
    run_id: runId,
    pass: gatePass,
    recommended_group: recommendedGroup || null,
    inputs: {
      gold_jsonl: toPosix(path.relative(process.cwd(), resolved.goldJsonlPath)),
      ab_json: toPosix(path.relative(process.cwd(), resolved.abJsonPath)),
      iaa_json: resolved.iaaJsonPath ? toPosix(path.relative(process.cwd(), resolved.iaaJsonPath)) : null,
      crossset_json: toPosix(path.relative(process.cwd(), resolved.crosssetJsonPath)),
      orchestrated: resolved.orchestrated,
    },
    gate_conditions: gateConditions,
    metrics: {
      gold_strong_module_miou_mean: round3(goldStrongMiouMean),
      gold_forehead_hair_overlap_rate_mean: round3(goldForeheadOverlapMean),
      gold_under_eye_band_coverage_p50: round3(goldUnderEyeCovP50),
      gold_under_eye_leakage_bg_mean: round3(goldUnderEyeLeakBgMean),
      crossset_celeb_lapa_leakage_bg_mean: round3(crosssetLeakBgMean),
      crossset_celeb_lapa_leakage_hair_mean: round3(crosssetLeakHairMean),
      iaa_strong_module_miou_mean: iaaPayload ? round3(iaaStrongMean) : null,
      best_overlap_delta_group: bestOverlapDelta || null,
    },
    retrain_decision: retrainDecision,
    top_worst_samples: topWorst,
    report_md: toPosix(path.relative(process.cwd(), reportMdPath)),
    report_json: toPosix(path.relative(process.cwd(), reportJsonPath)),
  };
  await fsp.writeFile(reportJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const markdown = renderMarkdown({
    runId,
    inputs: {
      goldJsonlRel: payload.inputs.gold_jsonl,
      abJsonRel: payload.inputs.ab_json,
      iaaJsonRel: payload.inputs.iaa_json,
      crosssetJsonRel: payload.inputs.crossset_json,
    },
    gate: {
      pass: gatePass,
      conditions: gateConditions,
    },
    metrics: payload.metrics,
    recommendedGroup: payload.recommended_group,
    topWorst,
    retrainDecision,
    files: {
      mdRel: toPosix(path.relative(process.cwd(), reportMdPath)),
      jsonRel: toPosix(path.relative(process.cwd(), reportJsonPath)),
    },
  });
  await fsp.writeFile(reportMdPath, markdown, 'utf8');

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!gatePass) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`release_gate_circle_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});

