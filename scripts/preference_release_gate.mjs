#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runTimestampKey } from './internal_batch_helpers.mjs';
import { readJsonlRows, toPosix } from './local_image_loader.mjs';

const DEFAULTS = Object.freeze({
  overall_delta_min: 0.05,
  forehead_delta_min: 0.1,
  cannot_tell_max: 0.25,
  iaa_kappa_min: 0.2,
  iaa_agreement_min: 0.6,
  limit_top: 20,
  report_dir: 'reports',
});

const HELP_TEXT = `preference_release_gate.mjs

Usage:
  node scripts/preference_release_gate.mjs --eval_jsonl <reports/eval_preference_<run_id>.jsonl> --eval_md <reports/eval_preference_<run_id>.md> --manifest <artifacts/preference_round1_<run_id>/manifest.json> [options]

Required:
  --eval_jsonl <path>                     eval_preference per-sample jsonl
  --eval_md <path>                        eval_preference markdown report
  --manifest <path>                       preference round1 manifest

Options:
  --eval_json <path>                      eval_preference summary json (default: sibling of eval_jsonl)
  --run_id <id>                           run id (default: infer from path)
  --overall_delta_min <n>                 default: 0.05
  --forehead_delta_min <n>                default: 0.10
  --cannot_tell_max <n>                   default: 0.25
  --iaa_kappa_min <n>                     default: 0.2
  --iaa_agreement_min <n>                 default: 0.6
  --limit_top <n>                         top contentious samples in report (default: 20)
  --report_dir <dir>                      output dir (default: reports)
  --out <path>                            explicit report path
  --help                                  show help
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

function parseArgs(argv) {
  const out = {
    help: false,
    eval_jsonl: process.env.EVAL_JSONL || '',
    eval_md: process.env.EVAL_MD || '',
    eval_json: process.env.EVAL_JSON || '',
    manifest: process.env.MANIFEST || '',
    run_id: process.env.RUN_ID || '',
    overall_delta_min: process.env.OVERALL_DELTA_MIN || DEFAULTS.overall_delta_min,
    forehead_delta_min: process.env.FOREHEAD_DELTA_MIN || DEFAULTS.forehead_delta_min,
    cannot_tell_max: process.env.CANNOT_TELL_MAX || DEFAULTS.cannot_tell_max,
    iaa_kappa_min: process.env.IAA_KAPPA_MIN || DEFAULTS.iaa_kappa_min,
    iaa_agreement_min: process.env.IAA_AGREEMENT_MIN || DEFAULTS.iaa_agreement_min,
    limit_top: process.env.LIMIT_TOP || DEFAULTS.limit_top,
    report_dir: process.env.EVAL_REPORT_DIR || process.env.REPORT_DIR || DEFAULTS.report_dir,
    out: process.env.OUT || '',
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
  out.eval_jsonl = String(out.eval_jsonl || '').trim();
  out.eval_md = String(out.eval_md || '').trim();
  out.eval_json = String(out.eval_json || '').trim();
  out.manifest = String(out.manifest || '').trim();
  out.run_id = String(out.run_id || '').trim();
  out.overall_delta_min = parseNumber(out.overall_delta_min, DEFAULTS.overall_delta_min, -1, 1);
  out.forehead_delta_min = parseNumber(out.forehead_delta_min, DEFAULTS.forehead_delta_min, -1, 1);
  out.cannot_tell_max = parseNumber(out.cannot_tell_max, DEFAULTS.cannot_tell_max, 0, 1);
  out.iaa_kappa_min = parseNumber(out.iaa_kappa_min, DEFAULTS.iaa_kappa_min, -1, 1);
  out.iaa_agreement_min = parseNumber(out.iaa_agreement_min, DEFAULTS.iaa_agreement_min, 0, 1);
  out.limit_top = Math.max(1, Math.min(1000, Math.trunc(parseNumber(out.limit_top, DEFAULTS.limit_top, 1, 1000))));
  out.report_dir = String(out.report_dir || DEFAULTS.report_dir).trim() || DEFAULTS.report_dir;
  out.out = String(out.out || '').trim();
  return out;
}

function inferRunId(args) {
  if (args.run_id) return args.run_id;
  for (const token of [args.eval_jsonl, args.eval_md, args.manifest]) {
    const base = path.basename(String(token || ''));
    const match = base.match(/(\d{15}|\d{8}_\d{6,9})/);
    if (match) return match[1];
  }
  return runTimestampKey();
}

async function readJsonIfExists(filePath) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function computeOverallFromJsonl(rows) {
  const total = rows.reduce((acc, row) => acc + Number(row.total_votes || 0), 0);
  const baseline = rows.reduce((acc, row) => acc + Number(row.baseline_votes || 0), 0);
  const variant1 = rows.reduce((acc, row) => acc + Number(row.variant1_votes || 0), 0);
  const cannotTell = rows.reduce((acc, row) => acc + Number(row.cannot_tell_votes || 0), 0);
  const head = baseline + variant1;
  return {
    total_votes: total,
    baseline_win_rate: head > 0 ? round3(baseline / head) : null,
    variant1_win_rate: head > 0 ? round3(variant1 / head) : null,
    cannot_tell_rate: total > 0 ? round3(cannotTell / total) : null,
  };
}

function chooseVerdict({
  variantCriterion,
  cannotCriterion,
  iaaCriterion,
}) {
  if (!cannotCriterion || !iaaCriterion) return 'NEED_ADJUDICATION';
  if (variantCriterion) return 'SHIP_VARIANT1';
  return 'KEEP_BASELINE';
}

function buildReport({ runId, inputs, metrics, criteria, verdict, reasons, topContentious, outputRel }) {
  const lines = [];
  lines.push('# Preference Release Gate');
  lines.push('');
  lines.push(`- run_id: ${runId}`);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- eval_jsonl: \`${inputs.eval_jsonl}\``);
  lines.push(`- eval_md: \`${inputs.eval_md}\``);
  lines.push(`- eval_json: ${inputs.eval_json ? `\`${inputs.eval_json}\`` : '-'}`);
  lines.push(`- manifest: \`${inputs.manifest}\``);
  lines.push('');

  lines.push('## Verdict');
  lines.push('');
  lines.push(`- verdict: **${verdict}**`);
  lines.push('');

  lines.push('## Metrics');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---:|');
  lines.push(`| overall_baseline_win_rate | ${metrics.overall_baseline_win_rate ?? '-'} |`);
  lines.push(`| overall_variant1_win_rate | ${metrics.overall_variant1_win_rate ?? '-'} |`);
  lines.push(`| overall_variant1_minus_baseline | ${metrics.overall_delta ?? '-'} |`);
  lines.push(`| forehead_baseline_win_rate | ${metrics.forehead_baseline_win_rate ?? '-'} |`);
  lines.push(`| forehead_variant1_win_rate | ${metrics.forehead_variant1_win_rate ?? '-'} |`);
  lines.push(`| forehead_variant1_minus_baseline | ${metrics.forehead_delta ?? '-'} |`);
  lines.push(`| cannot_tell_rate | ${metrics.cannot_tell_rate ?? '-'} |`);
  lines.push(`| overlap_iaa_kappa | ${metrics.iaa_kappa ?? '-'} |`);
  lines.push(`| overlap_iaa_simple_agreement | ${metrics.iaa_agreement ?? '-'} |`);
  lines.push(`| overlap_samples_total | ${metrics.overlap_samples_total ?? '-'} |`);
  lines.push(`| overlap_samples_labeled_by_2plus | ${metrics.overlap_samples_labeled_by_2plus ?? '-'} |`);
  lines.push('');

  lines.push('## Criteria');
  lines.push('');
  lines.push(`1. variant improvement: ${criteria.variantCriterion ? 'PASS' : 'FAIL'}`);
  lines.push(`2. cannot_tell guard: ${criteria.cannotCriterion ? 'PASS' : 'FAIL'}`);
  lines.push(`3. overlap IAA guard: ${criteria.iaaCriterion ? 'PASS' : 'FAIL'}`);
  lines.push('');

  lines.push('## Reasons');
  lines.push('');
  if (!reasons.length) {
    lines.push('- no blocking reasons');
  } else {
    reasons.forEach((reason) => lines.push(`- ${reason}`));
  }
  lines.push('');

  lines.push('## Top 20 Contentious Samples');
  lines.push('');
  lines.push('| rank | sample_id | source | task_batch | contentious_score | cannot_tell_rate | disagreement_overlap_rate | low_confidence_rate |');
  lines.push('|---:|---|---|---|---:|---:|---:|---:|');
  if (!topContentious.length) {
    lines.push('| 1 | - | - | - | - | - | - | - |');
  } else {
    topContentious.forEach((row, idx) => {
      lines.push(`| ${idx + 1} | ${row.sample_id || '-'} | ${row.source || '-'} | ${row.task_batch || '-'} | ${row.contentious_score ?? '-'} | ${row.cannot_tell_rate ?? '-'} | ${row.disagreement_overlap_rate ?? row.disagreement_rate ?? '-'} | ${row.low_confidence_rate ?? '-'} |`);
    });
  }
  lines.push('');
  lines.push('## Artifact');
  lines.push('');
  lines.push(`- release_gate_report: \`${outputRel}\``);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    process.exit(0);
    return;
  }
  if (!args.eval_jsonl) {
    process.stderr.write('preference_release_gate: missing --eval_jsonl\n');
    process.exit(2);
    return;
  }
  if (!args.eval_md) {
    process.stderr.write('preference_release_gate: missing --eval_md\n');
    process.exit(2);
    return;
  }
  if (!args.manifest) {
    process.stderr.write('preference_release_gate: missing --manifest\n');
    process.exit(2);
    return;
  }

  const runId = inferRunId(args);
  const evalJsonlPath = path.resolve(args.eval_jsonl);
  const evalMdPath = path.resolve(args.eval_md);
  const manifestPath = path.resolve(args.manifest);
  const evalJsonPath = path.resolve(args.eval_json || evalJsonlPath.replace(/\.jsonl$/i, '.json'));
  const reportDir = path.resolve(args.report_dir);
  await fsp.mkdir(reportDir, { recursive: true });
  const reportPath = path.resolve(args.out || path.join(reportDir, `RELEASE_GATE_PREFERENCE_${runId}.md`));

  const [evalRows, manifestRaw, evalJsonMaybe] = await Promise.all([
    readJsonlRows(evalJsonlPath),
    fsp.readFile(manifestPath, 'utf8'),
    readJsonIfExists(evalJsonPath),
  ]);
  await fsp.stat(evalMdPath);

  const manifest = JSON.parse(manifestRaw);

  const overall = evalJsonMaybe && evalJsonMaybe.overall
    ? evalJsonMaybe.overall
    : computeOverallFromJsonl(evalRows);

  const forehead = evalJsonMaybe && Array.isArray(evalJsonMaybe.per_module)
    ? evalJsonMaybe.per_module.find((row) => String(row.module_id || '') === 'forehead')
    : null;

  const iaa = evalJsonMaybe && evalJsonMaybe.iaa ? evalJsonMaybe.iaa : {};

  const overallDelta =
    overall.variant1_win_rate != null && overall.baseline_win_rate != null
      ? round3(Number(overall.variant1_win_rate) - Number(overall.baseline_win_rate))
      : null;
  const foreheadDelta =
    forehead && forehead.variant1_win_rate != null && forehead.baseline_win_rate != null
      ? round3(Number(forehead.variant1_win_rate) - Number(forehead.baseline_win_rate))
      : null;

  const variantCriterion = Boolean(
    (overallDelta != null && overallDelta >= args.overall_delta_min)
    || (foreheadDelta != null && foreheadDelta >= args.forehead_delta_min),
  );
  const cannotCriterion = overall.cannot_tell_rate != null
    ? Number(overall.cannot_tell_rate) <= args.cannot_tell_max
    : false;

  const iaaKappa = iaa.overall_kappa != null ? Number(iaa.overall_kappa) : null;
  const iaaAgreement = iaa.overall_simple_agreement != null ? Number(iaa.overall_simple_agreement) : null;
  const iaaCriterion = iaaKappa != null
    ? iaaKappa >= args.iaa_kappa_min
    : iaaAgreement != null
      ? iaaAgreement >= args.iaa_agreement_min
      : false;

  const verdict = chooseVerdict({
    variantCriterion,
    cannotCriterion,
    iaaCriterion,
  });

  const reasons = [];
  if (!variantCriterion) {
    reasons.push(
      `variant gain not met (overall delta=${overallDelta ?? '-'}, forehead delta=${foreheadDelta ?? '-'}; thresholds overall>=${args.overall_delta_min}, forehead>=${args.forehead_delta_min})`,
    );
  }
  if (!cannotCriterion) {
    reasons.push(`cannot_tell_rate too high (${overall.cannot_tell_rate ?? '-'} > ${args.cannot_tell_max})`);
  }
  if (!iaaCriterion) {
    reasons.push(`overlap IAA below threshold (kappa=${iaaKappa ?? '-'}, agreement=${iaaAgreement ?? '-'}; thresholds kappa>=${args.iaa_kappa_min} or agreement>=${args.iaa_agreement_min})`);
  }

  if (Number(evalJsonMaybe && evalJsonMaybe.risk_features_missing_count || 0) > 0) {
    reasons.push(`missing risk features for ${evalJsonMaybe.risk_features_missing_count} samples`);
  }

  const topContentious = [...evalRows]
    .sort((a, b) => {
      const scoreDelta = Number(b.contentious_score || 0) - Number(a.contentious_score || 0);
      if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
      const cannotDelta = Number(b.cannot_tell_rate || 0) - Number(a.cannot_tell_rate || 0);
      if (Math.abs(cannotDelta) > 1e-9) return cannotDelta;
      const disagreementDelta = Number((b.disagreement_overlap_rate || b.disagreement_rate || 0)) - Number((a.disagreement_overlap_rate || a.disagreement_rate || 0));
      if (Math.abs(disagreementDelta) > 1e-9) return disagreementDelta;
      return String(a.sample_id || '').localeCompare(String(b.sample_id || ''));
    })
    .slice(0, args.limit_top);

  const reportMarkdown = buildReport({
    runId,
    inputs: {
      eval_jsonl: toPosix(path.relative(process.cwd(), evalJsonlPath)),
      eval_md: toPosix(path.relative(process.cwd(), evalMdPath)),
      eval_json: evalJsonMaybe ? toPosix(path.relative(process.cwd(), evalJsonPath)) : null,
      manifest: toPosix(path.relative(process.cwd(), manifestPath)),
    },
    metrics: {
      overall_baseline_win_rate: overall.baseline_win_rate ?? null,
      overall_variant1_win_rate: overall.variant1_win_rate ?? null,
      overall_delta: overallDelta,
      forehead_baseline_win_rate: forehead ? forehead.baseline_win_rate : null,
      forehead_variant1_win_rate: forehead ? forehead.variant1_win_rate : null,
      forehead_delta: foreheadDelta,
      cannot_tell_rate: overall.cannot_tell_rate ?? null,
      iaa_kappa: iaaKappa,
      iaa_agreement: iaaAgreement,
      overlap_samples_total: iaa.overlap_samples_total ?? (manifest.overlap && manifest.overlap.overlap_count) ?? null,
      overlap_samples_labeled_by_2plus: iaa.overlap_samples_labeled_by_2plus ?? null,
    },
    criteria: {
      variantCriterion,
      cannotCriterion,
      iaaCriterion,
    },
    verdict,
    reasons,
    topContentious,
    outputRel: toPosix(path.relative(process.cwd(), reportPath)),
  });

  await fsp.writeFile(reportPath, reportMarkdown, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    run_id: runId,
    verdict,
    criteria: {
      variant_improvement: variantCriterion,
      cannot_tell_guard: cannotCriterion,
      overlap_iaa_guard: iaaCriterion,
    },
    metrics: {
      overall_delta: overallDelta,
      forehead_delta: foreheadDelta,
      cannot_tell_rate: overall.cannot_tell_rate ?? null,
      iaa_kappa: iaaKappa,
      iaa_agreement: iaaAgreement,
    },
    top_contentious_sample_ids: topContentious.map((row) => String(row.sample_id || row.sample_hash || '').trim()).filter(Boolean),
    artifacts: {
      release_gate_md: toPosix(path.relative(process.cwd(), reportPath)),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`preference_release_gate_failed: ${String(error && error.message ? error.message : error)}\n`);
  process.exit(1);
});
