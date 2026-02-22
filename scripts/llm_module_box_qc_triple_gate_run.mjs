#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const HELP_TEXT = `llm_module_box_qc_triple_gate_run.mjs

Usage:
  node scripts/llm_module_box_qc_triple_gate_run.mjs --manifest <path> [options]

Required:
  --manifest <path>                      path to preference manifest.json

Options:
  --out_root <dir>                       output root dir (default: <manifest_dir>/llm_qc_triple_gate_<ts>)
  --tasks_json <path>                    tasks.json path (default: read from manifest.artifacts.tasks_json)
  --provider <mock|gemini|openai>        primary provider (default: gemini)
  --allow_mock_provider <bool>           require explicit opt-in when any run stage uses mock provider (default: false)
  --model <name>                         primary model (default: gemini-2.5-flash)
  --escalate_provider <mock|gemini|openai|none>  second-pass provider (default: gemini)
  --escalate_model <name>                second-pass model (default: gemini-2.5-pro)
  --escalate_min_confidence <0-1>        trigger second pass below confidence (default: 0.78)
  --escalate_min_risk_reasons <n>        trigger second pass when risk reasons >= n (default: 1)
  --escalate_on_decisions <csv>          trigger second pass for decisions (default: revise,reject)
  --escalate_if_error <bool>             trigger second pass on provider error (default: true)
  --both_bad_score_max <n>               third-gate low-quality score threshold (default: 0.24)
  --both_bad_max_diff <n>                third-gate max score diff when both low quality (default: 0.22)
  --both_bad_winner_not_clean_score_max <n>  winner-not-clean gate threshold (default: 0.4)
  --both_bad_min_corrected <n>           min corrected modules for low-quality side (default: 2)
  --both_bad_min_mean_delta <n>          min mean_delta_l1 for low-quality side (default: 0.09)
  --both_bad_min_severity_penalty <n>    min violation severity penalty for low-quality side (default: 0.18)
  --both_bad_risk_gate_enabled <bool>    enable risk-reason hard gate (default: true)
  --both_bad_risk_reasons_csv <csv>      risk reasons used by hard gate (default: module_guard_triggered,module_pixels_min_low)
  --decision_mode <qa|consumer>          third-gate policy mode (default: consumer)
  --hard_block_only <bool>               block only hard-failure both_bad (default: true in consumer, false in qa)
  --manual_delta_guard_enabled <bool>    move high-delta pairs into manual_review queue (default: true in consumer, false in qa)
  --manual_delta_guard_pair_max <n>      pair max mean_delta_l1 threshold for manual_review guard (default: 0.19)
  --manual_delta_guard_min_corrected <n> min corrected modules for manual_review delta guard (default: 3)
  --manual_delta_guard_decisions <csv>   decisions considered by manual delta guard (default: revise)
  --limit <n>                            max candidate sides to process (default: 58)
  --risk_only <bool>                     process only risk candidates (default: true)
  --risk_min_pixels <n>                  low pixel threshold (default: 56)
  --risk_min_geometry_score <0-1>        low geometry threshold (default: 0.88)
  --risk_max_abs_yaw <0-1>               high yaw threshold (default: 0.55)
  --pre_geometry_seed_enabled <bool>     run deterministic geometry seed before LLM pass (default: false)
  --pre_geometry_seed_max_modules <n>    max changed modules allowed in pre-geometry seed (default: 5)
  --pre_geometry_seed_max_pair_mean_delta <n> max mean_delta_l1 allowed in pre-geometry seed (default: 0.19)
  --write_report_shortcut <bool>         write shortcut html into reports/ (default: true)
  --update_latest_redirects <bool>       whether this run updates reports/*latest*.html redirects (default: true for non-mock runs, false for mock runs)
  --dry_run <bool>                       skip provider calls (default: false)
  --help                                 show help
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > -1) {
      const key = token.slice(2, eq).trim();
      const val = token.slice(eq + 1);
      out[key] = val;
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function parseBool(value, fallback) {
  if (value == null) return fallback;
  const token = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return fallback;
}

function parseNumber(value, fallback, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toPosix(p) {
  return String(p || '').split(path.sep).join('/');
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

async function existsFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

async function resolveMaybePath(rawPath, { manifestDir, cwd }) {
  const token = String(rawPath || '').trim();
  if (!token) return null;
  const candidates = [];
  if (path.isAbsolute(token)) candidates.push(token);
  candidates.push(path.resolve(manifestDir, token));
  candidates.push(path.resolve(cwd, token));
  for (const c of candidates) {
    if (await existsFile(c)) return c;
  }
  return path.isAbsolute(token) ? token : path.resolve(manifestDir, token);
}

async function runNodeScript({ cwd, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): node ${args.join(' ')}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function htmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function writeLatestHtmlRedirect({
  reportsDir,
  latestFileName,
  targetPath,
  title,
}) {
  const latestPath = path.join(reportsDir, latestFileName);
  let rel = toPosix(path.relative(reportsDir, targetPath));
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = `./${rel}`;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0; url=${htmlEscape(rel)}" />
  <title>${htmlEscape(title)}</title>
</head>
<body style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0b0e12;color:#e8eef7;padding:16px;">
  <div>Redirecting to <a href="${htmlEscape(rel)}">${htmlEscape(rel)}</a></div>
</body>
</html>
`;
  await fsp.writeFile(latestPath, html, 'utf8');
  return latestPath;
}

async function writeShortcutReport({
  repoDir,
  outRoot,
  llmOutDir,
  abOutDir,
  llmSummary,
  abSummary,
}) {
  const reportsDir = path.join(repoDir, 'reports');
  await fsp.mkdir(reportsDir, { recursive: true });
  const stamp = nowStamp();
  const fileName = `ab_label_triple_gate_shortcut_${stamp}.html`;
  const outPath = path.join(reportsDir, fileName);

  const rel = (p) => toPosix(path.relative(reportsDir, p));
  const allPath = path.join(abOutDir, 'review_all_with_images.html');
  const manualPath = path.join(abOutDir, 'review_manual_with_images.html');
  const blockedPath = path.join(abOutDir, 'review_blocked_with_images.html');
  const llmSummaryPath = path.join(llmOutDir, 'llm_qc_summary.json');
  const abSummaryPath = path.join(abOutDir, 'summary.json');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Triple-Gate Shortcut</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0b0e12; color: #e8eef7; margin: 0; padding: 16px; }
    .card { background: #121722; border: 1px solid #2c3445; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
    a { color: #8ab4ff; }
    code { color: #c9d8ff; }
  </style>
</head>
<body>
  <div class="card">
    <div><b>Triple-Gate Shortcut</b></div>
    <div>out_root: <code>${htmlEscape(rel(outRoot))}</code></div>
    <div>provider/model: <code>${htmlEscape(String(llmSummary.provider || '-'))}</code> / <code>${htmlEscape(String(llmSummary.model || '-'))}</code></div>
    <div>escalation: <code>${htmlEscape(JSON.stringify(llmSummary.escalation || {}))}</code></div>
    <div>ab counts: <code>${htmlEscape(JSON.stringify((abSummary && abSummary.decision_class_counts) || {}))}</code></div>
  </div>
  <div class="card">
    <div><a href="${htmlEscape(rel(allPath))}" target="_blank">Open All Decisions</a></div>
    <div><a href="${htmlEscape(rel(blockedPath))}" target="_blank">Open Blocked Queue (both_bad)</a></div>
    <div><a href="${htmlEscape(rel(manualPath))}" target="_blank">Open Manual Queue</a></div>
  </div>
  <div class="card">
    <div>llm summary: <code>${htmlEscape(rel(llmSummaryPath))}</code></div>
    <div>ab summary: <code>${htmlEscape(rel(abSummaryPath))}</code></div>
  </div>
</body>
</html>
`;
  await fsp.writeFile(outPath, html, 'utf8');
  return outPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBool(args.help, false)) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const manifestRaw = String(args.manifest || '').trim();
  if (!manifestRaw) {
    process.stderr.write('Missing --manifest\n');
    process.exitCode = 2;
    return;
  }

  const repoDir = process.cwd();
  const manifestPath = path.resolve(manifestRaw);
  const manifestDir = path.dirname(manifestPath);
  const manifestObj = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));

  const dryRun = parseBool(args.dry_run, false);
  const provider = String(args.provider || 'gemini').trim().toLowerCase();
  const allowMockProvider = parseBool(args.allow_mock_provider, false);
  const model = String(args.model || 'gemini-2.5-flash').trim();
  const escalateProviderRaw = String(args.escalate_provider || 'gemini').trim().toLowerCase();
  const escalateProvider = (!escalateProviderRaw || escalateProviderRaw === 'none') ? null : escalateProviderRaw;
  const escalateModel = String(args.escalate_model || 'gemini-2.5-pro').trim();
  const mockProvidersInRun = [];
  if (provider === 'mock') mockProvidersInRun.push('primary');
  if (escalateProvider === 'mock') mockProvidersInRun.push('escalate');
  const hasMockProviderInRun = mockProvidersInRun.length > 0;
  if (hasMockProviderInRun && !allowMockProvider) {
    process.stderr.write(
      `Mock provider detected in stages [${mockProvidersInRun.join(', ')}]. Re-run with --allow_mock_provider true if intentional.\n`,
    );
    process.exitCode = 2;
    return;
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(parseNumber(args.limit, 58, 1, 500))));
  const riskOnly = parseBool(args.risk_only, true);
  const writeReportShortcut = parseBool(args.write_report_shortcut, true);
  const preGeometrySeedEnabled = parseBool(args.pre_geometry_seed_enabled, false);
  const preGeometrySeedMaxModules = Math.trunc(parseNumber(args.pre_geometry_seed_max_modules, 5, 1, 20));
  const preGeometrySeedMaxPairMeanDelta = parseNumber(args.pre_geometry_seed_max_pair_mean_delta, 0.19, 0, 2);
  const bothBadScoreMax = parseNumber(args.both_bad_score_max, 0.24, -2, 1);
  const bothBadMaxDiff = parseNumber(args.both_bad_max_diff, 0.22, 0, 2);
  const bothBadWinnerNotCleanScoreMax = parseNumber(args.both_bad_winner_not_clean_score_max, 0.4, -2, 1);
  const bothBadMinCorrected = Math.trunc(parseNumber(args.both_bad_min_corrected, 2, 0, 20));
  const bothBadMinMeanDelta = parseNumber(args.both_bad_min_mean_delta, 0.09, 0, 2);
  const bothBadMinSeverityPenalty = parseNumber(args.both_bad_min_severity_penalty, 0.18, 0, 1);
  const bothBadRiskGateEnabled = parseBool(args.both_bad_risk_gate_enabled, true);
  const bothBadRiskReasonsCsv = String(
    args.both_bad_risk_reasons_csv || 'module_guard_triggered,module_pixels_min_low',
  );
  const decisionModeToken = String(args.decision_mode || 'consumer').trim().toLowerCase();
  const decisionMode = decisionModeToken === 'qa' ? 'qa' : 'consumer';
  const hardBlockOnly = parseBool(args.hard_block_only, decisionMode === 'consumer');
  const manualDeltaGuardEnabled = parseBool(args.manual_delta_guard_enabled, decisionMode === 'consumer');
  const manualDeltaGuardPairMax = parseNumber(args.manual_delta_guard_pair_max, 0.19, 0, 2);
  const manualDeltaGuardMinCorrected = Math.trunc(parseNumber(args.manual_delta_guard_min_corrected, 3, 0, 20));
  const manualDeltaGuardDecisions = String(args.manual_delta_guard_decisions || 'revise').trim();
  const updateLatestRedirects = parseBool(args.update_latest_redirects, !hasMockProviderInRun);

  if (!dryRun && (provider === 'gemini' || escalateProvider === 'gemini')) {
    const hasGeminiKey = Boolean(
      String(process.env.GEMINI_API_KEY || '').trim()
      || String(process.env.GOOGLE_API_KEY || '').trim(),
    );
    if (!hasGeminiKey) {
      process.stderr.write(
        'GEMINI_API_KEY/GOOGLE_API_KEY is missing in current shell. Export key first, then rerun.\n',
      );
      process.exitCode = 2;
      return;
    }
  }

  const tasksJsonFromManifest =
    manifestObj
    && manifestObj.artifacts
    && typeof manifestObj.artifacts.tasks_json === 'string'
      ? manifestObj.artifacts.tasks_json
      : null;
  const tasksJsonResolved = await resolveMaybePath(String(args.tasks_json || tasksJsonFromManifest || ''), {
    manifestDir,
    cwd: repoDir,
  });

  const outRoot = path.resolve(
    String(args.out_root || path.join(manifestDir, `llm_qc_triple_gate_${nowStamp()}`)).trim(),
  );
  const llmOutDir = path.join(outRoot, 'llm_qc');
  const abOutDir = path.join(outRoot, 'ab_label');
  await fsp.mkdir(llmOutDir, { recursive: true });
  await fsp.mkdir(abOutDir, { recursive: true });

  const llmArgs = [
    'scripts/llm_module_box_qc_poc.mjs',
    '--manifest', manifestPath,
    '--provider', provider,
    '--model', model,
    '--out', llmOutDir,
    '--limit', String(limit),
    '--risk_only', String(riskOnly),
    '--risk_min_pixels', String(Math.trunc(parseNumber(args.risk_min_pixels, 56, 1, 4096))),
    '--risk_min_geometry_score', String(parseNumber(args.risk_min_geometry_score, 0.88, 0, 1)),
    '--risk_max_abs_yaw', String(parseNumber(args.risk_max_abs_yaw, 0.55, 0, 1)),
    '--pre_geometry_seed_enabled', String(preGeometrySeedEnabled),
    '--pre_geometry_seed_max_modules', String(preGeometrySeedMaxModules),
    '--pre_geometry_seed_max_pair_mean_delta', String(preGeometrySeedMaxPairMeanDelta),
    '--escalate_provider', String(escalateProvider || 'none'),
    '--escalate_model', escalateModel,
    '--escalate_min_confidence', String(parseNumber(args.escalate_min_confidence, 0.78, 0, 1)),
    '--escalate_min_risk_reasons', String(Math.trunc(parseNumber(args.escalate_min_risk_reasons, 1, 0, 20))),
    '--escalate_on_decisions', String(args.escalate_on_decisions || 'revise,reject'),
    '--escalate_if_error', String(parseBool(args.escalate_if_error, true)),
    '--dry_run', String(dryRun),
  ];
  await runNodeScript({ cwd: repoDir, args: llmArgs });

  const llmResultsPath = path.join(llmOutDir, 'llm_qc_results.jsonl');
  const llmSummaryPath = path.join(llmOutDir, 'llm_qc_summary.json');
  const llmSummary = JSON.parse(await fsp.readFile(llmSummaryPath, 'utf8'));

  const abArgs = [
    'scripts/llm_module_box_qc_ab_label.mjs',
    '--llm_results', llmResultsPath,
    '--out', abOutDir,
    '--decision_mode', decisionMode,
    '--hard_block_only', String(hardBlockOnly),
    '--enable_both_bad', 'true',
    '--both_bad_score_max', String(bothBadScoreMax),
    '--both_bad_max_diff', String(bothBadMaxDiff),
    '--both_bad_ignore_diff_if_both_low', String(parseBool(args.both_bad_ignore_diff_if_both_low, true)),
    '--both_bad_winner_not_clean_enabled', String(parseBool(args.both_bad_winner_not_clean_enabled, true)),
    '--both_bad_winner_not_clean_score_max', String(bothBadWinnerNotCleanScoreMax),
    '--both_bad_winner_not_clean_min_violations', String(Math.trunc(parseNumber(args.both_bad_winner_not_clean_min_violations, 1, 0, 20))),
    '--both_bad_winner_not_clean_require_loser_low', String(parseBool(args.both_bad_winner_not_clean_require_loser_low, true)),
    '--both_bad_min_corrected', String(bothBadMinCorrected),
    '--both_bad_min_mean_delta', String(bothBadMinMeanDelta),
    '--both_bad_min_severity_penalty', String(bothBadMinSeverityPenalty),
    '--both_bad_risk_gate_enabled', String(bothBadRiskGateEnabled),
    '--both_bad_risk_reasons_csv', bothBadRiskReasonsCsv,
    '--manual_delta_guard_enabled', String(manualDeltaGuardEnabled),
    '--manual_delta_guard_pair_max', String(manualDeltaGuardPairMax),
    '--manual_delta_guard_min_corrected', String(manualDeltaGuardMinCorrected),
    '--manual_delta_guard_decisions', manualDeltaGuardDecisions,
  ];
  if (tasksJsonResolved) {
    abArgs.push('--tasks_json', tasksJsonResolved);
  }
  await runNodeScript({ cwd: repoDir, args: abArgs });

  const abSummaryPath = path.join(abOutDir, 'summary.json');
  const abSummary = JSON.parse(await fsp.readFile(abSummaryPath, 'utf8'));
  const reviewAllPath = path.join(abOutDir, 'review_all_with_images.html');
  const reviewManualPath = path.join(abOutDir, 'review_manual_with_images.html');
  const reviewBlockedPath = path.join(abOutDir, 'review_blocked_with_images.html');

  let shortcutPath = null;
  let latestShortcutPath = null;
  let latestRealShortcutPath = null;
  let latestAllPath = null;
  let latestManualPath = null;
  let latestBlockedPath = null;
  if (writeReportShortcut) {
    const reportsDir = path.join(repoDir, 'reports');
    await fsp.mkdir(reportsDir, { recursive: true });
    shortcutPath = await writeShortcutReport({
      repoDir,
      outRoot,
      llmOutDir,
      abOutDir,
      llmSummary,
      abSummary,
    });
    if (updateLatestRedirects) {
      latestShortcutPath = await writeLatestHtmlRedirect({
        reportsDir,
        latestFileName: 'ab_label_triple_gate_latest.html',
        targetPath: shortcutPath,
        title: 'Triple-Gate Shortcut (Latest)',
      });
      if (!hasMockProviderInRun) {
        latestRealShortcutPath = await writeLatestHtmlRedirect({
          reportsDir,
          latestFileName: 'ab_label_triple_gate_latest_real.html',
          targetPath: shortcutPath,
          title: 'Triple-Gate Shortcut (Latest Real)',
        });
      }
      latestAllPath = await writeLatestHtmlRedirect({
        reportsDir,
        latestFileName: 'ab_label_review_all_latest.html',
        targetPath: reviewAllPath,
        title: 'A/B Review All (Latest)',
      });
      latestManualPath = await writeLatestHtmlRedirect({
        reportsDir,
        latestFileName: 'ab_label_review_manual_latest.html',
        targetPath: reviewManualPath,
        title: 'A/B Review Manual (Latest)',
      });
      latestBlockedPath = await writeLatestHtmlRedirect({
        reportsDir,
        latestFileName: 'ab_label_review_blocked_latest.html',
        targetPath: reviewBlockedPath,
        title: 'A/B Review Blocked (Latest)',
      });
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mock_guard: {
      allow_mock_provider: allowMockProvider,
      has_mock_provider_in_run: hasMockProviderInRun,
      mock_provider_stages: mockProvidersInRun,
      update_latest_redirects: updateLatestRedirects,
    },
    manifest_path: manifestPath,
    tasks_json_path: tasksJsonResolved,
    out_root: outRoot,
    llm: {
      summary_path: llmSummaryPath,
      results_path: llmResultsPath,
      decision_counts: llmSummary.decision_counts || {},
      escalation: llmSummary.escalation || {},
      pre_geometry_seed: llmSummary.pre_geometry_seed || null,
    },
    ab: {
      summary_path: abSummaryPath,
      decision_policy: {
        mode: decisionMode,
        hard_block_only: hardBlockOnly,
      },
      manual_delta_guard: {
        enabled: manualDeltaGuardEnabled,
        pair_max: manualDeltaGuardPairMax,
        min_corrected: manualDeltaGuardMinCorrected,
        decisions: manualDeltaGuardDecisions,
      },
      decision_class_counts: abSummary.decision_class_counts || {},
      manual_review_total: Number(abSummary.manual_review_total || 0),
      blocked_total: Number(abSummary.blocked_total || 0),
      review_all_html: reviewAllPath,
      review_manual_html: reviewManualPath,
      review_blocked_html: reviewBlockedPath,
    },
    report_shortcut_html: shortcutPath,
    reports_latest: {
      shortcut: latestShortcutPath,
      shortcut_real: latestRealShortcutPath,
      review_all: latestAllPath,
      review_manual: latestManualPath,
      review_blocked: latestBlockedPath,
    },
  }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`llm_module_box_qc_triple_gate_run failed: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});
