#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_RUNS_DIR = path.join(ROOT, 'reports', 'travel-expert-multiturn', 'runs');
const DEFAULT_OUT_ROOT = path.join(ROOT, 'reports', 'travel-expert-multiturn', 'scoring-packets');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
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

function readJson(absPath, label) {
  if (!fs.existsSync(absPath)) throw new Error(`${label} not found: ${absPath}`);
  const raw = fs.readFileSync(absPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} invalid JSON: ${absPath} (${err.message})`);
  }
}

function sha256File(absPath) {
  const bytes = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function relativeToRoot(absPath) {
  const rel = path.relative(ROOT, absPath);
  return rel && !rel.startsWith('..') ? rel : absPath;
}

function resolveLatestRunPath(runsDir) {
  if (!fs.existsSync(runsDir)) throw new Error(`runs directory not found: ${runsDir}`);
  const rows = fs
    .readdirSync(runsDir)
    .filter((name) => /^multiturn-run-\d{8}_\d{6}\.json$/.test(name))
    .map((name) => {
      const abs = path.join(runsDir, name);
      const stat = fs.statSync(abs);
      return { name, abs, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  if (!rows.length) throw new Error(`no multiturn run report found in ${runsDir}`);
  return rows[0].abs;
}

function deriveRunToken(runPath) {
  const base = path.basename(runPath);
  const m = base.match(/^multiturn-run-(\d{8}_\d{6})\.json$/);
  if (m && m[1]) return m[1];
  return new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function caseFileName(id) {
  return String(id || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function writeCaseMarkdown(absPath, packet) {
  const lines = [];
  lines.push(`# ${packet.id} (${packet.alias || '?'})`);
  lines.push('');
  lines.push(`- language: ${packet.language}`);
  lines.push(`- category: ${packet.category}`);
  lines.push(`- transport: ${packet.ok_turns}/${packet.total_turns}`);
  lines.push(`- contract: ${packet.contract_pass_turns}/${packet.total_turns}`);
  lines.push(`- failed: ${String(Boolean(packet.failed))}`);
  lines.push(
    `- critical_fail_reasons: ${
      Array.isArray(packet.critical_fail_reasons) && packet.critical_fail_reasons.length
        ? packet.critical_fail_reasons.join(' | ')
        : 'none'
    }`,
  );
  lines.push('');
  lines.push('## Turns');
  lines.push('');
  for (const turn of Array.isArray(packet.turns) ? packet.turns : []) {
    lines.push(`### ${safeText(turn.turn_id)} (status=${toNum(turn.status)}, contract_pass=${String(Boolean(turn.contract_pass))})`);
    lines.push(`- card_types: ${(Array.isArray(turn.card_types) ? turn.card_types : []).join(', ') || 'none'}`);
    lines.push(`- events: ${(Array.isArray(turn.event_names) ? turn.event_names : []).join(', ') || 'none'}`);
    lines.push(`- errors: ${(Array.isArray(turn.errors) ? turn.errors : []).join(' | ') || 'none'}`);
    lines.push(`- warnings: ${(Array.isArray(turn.warnings) ? turn.warnings : []).join(' | ') || 'none'}`);
    lines.push('- assistant_message:');
    lines.push('```text');
    lines.push(safeText(turn.assistant_message) || '(empty)');
    lines.push('```');
    lines.push('- response_body:');
    lines.push('```json');
    lines.push(JSON.stringify(turn.response_body || {}, null, 2));
    lines.push('```');
    lines.push('');
  }
  fs.writeFileSync(absPath, `${lines.join('\n')}\n`, 'utf8');
}

function buildBundleMarkdown(bundle, relRunPath) {
  const lines = [];
  lines.push('# Travel EFGH Scoring Bundle');
  lines.push('');
  lines.push(`- run_report: ${relRunPath}`);
  lines.push(`- generated_at: ${bundle.generated_at}`);
  lines.push(`- total_cases: ${toNum(bundle.summary && bundle.summary.total_cases)}`);
  lines.push(`- passed_cases: ${toNum(bundle.summary && bundle.summary.passed_cases)}`);
  lines.push(`- failed_cases: ${toNum(bundle.summary && bundle.summary.failed_cases)}`);
  lines.push(`- transport_success_rate: ${toNum(bundle.summary && bundle.summary.transport_success_rate).toFixed(4)}`);
  lines.push(`- contract_pass_rate: ${toNum(bundle.summary && bundle.summary.contract_pass_rate).toFixed(4)}`);
  lines.push('');
  lines.push('| Alias | Case ID | Lang | Transport | Contract | Failed |');
  lines.push('|---|---|---|---|---|---|');
  for (const c of Array.isArray(bundle.cases) ? bundle.cases : []) {
    lines.push(
      `| ${safeText(c.alias)} | ${safeText(c.id)} | ${safeText(c.language)} | ${toNum(c.ok_turns)}/${toNum(c.total_turns)} | ${toNum(c.contract_pass_turns)}/${toNum(c.total_turns)} | ${String(Boolean(c.failed))} |`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildExternalPrompt() {
  return `You are an independent evaluator for travel-weather skincare planning quality.

Goals:
1) Score output quality.
2) Judge whether the response is reasonable and internally consistent.
3) Provide prioritized, implementation-ready optimization suggestions.

Input:
1) One case markdown file: case-travel_mt_00X.md
2) The target assistant output in that file (Aurora run result)

Scoring dimensions (0-5 each, keep exactly these keys):
- weather_accuracy
- delta_explainability
- actionability
- product_closure
- safety_risk_control
- followup_focus
- context_memory
- contract_completeness

Module flags:
- has_forecast_window
- has_alerts_or_none_statement
- has_reapply_rules
- has_store_or_channel_hint
- has_jetlag_logic

Reasonableness checks (required):
1) Conclusion must match evidence in the same turn (delta/forecast/alerts/actions).
2) No contradiction between narrative and payload fields.
3) If output relies on climate fallback instead of live weather, this limitation should be stated.
4) Safety advice should not conflict with stated risk profile.
5) Follow-up should stay focused on user question (no generic template replay).

Rules:
- Score only from provided case content; do not infer hidden context.
- If evidence is missing, lower the relevant score and mention missing evidence in findings.
- safety_violation=true only if there is clear unsafe advice.
- findings must be severity-ranked (critical -> warning -> info).
- notes must be concise (max 5 lines).
- Output STRICT JSON only, no markdown, no code fence.

Output JSON schema:
{
  "id": "travel_mt_001",
  "scores": {
    "weather_accuracy": 0,
    "delta_explainability": 0,
    "actionability": 0,
    "product_closure": 0,
    "safety_risk_control": 0,
    "followup_focus": 0,
    "context_memory": 0,
    "contract_completeness": 0
  },
  "safety_violation": false,
  "reasonableness": {
    "is_reasonable": false,
    "level": "low",
    "summary": ""
  },
  "modules": {
    "has_forecast_window": false,
    "has_alerts_or_none_statement": false,
    "has_reapply_rules": false,
    "has_store_or_channel_hint": false,
    "has_jetlag_logic": false
  },
  "findings": [
    {
      "severity": "critical",
      "category": "consistency",
      "evidence": "turn_2 delta_vs_home.humidity",
      "impact": "user may receive misleading plan",
      "fix": "align claim with numeric delta and add explicit threshold"
    }
  ],
  "optimization_plan": [
    {
      "priority": "P0",
      "owner": "backend",
      "change": "add missing reapply_rule per UV bucket",
      "expected_gain": "improve actionability and contract completeness"
    }
  ],
  "notes": ""
}
`;
}

function main() {
  const args = parseArgs(process.argv);
  const runsDir = path.resolve(ROOT, String(args['runs-dir'] || DEFAULT_RUNS_DIR));
  const runPath = args.run ? path.resolve(ROOT, String(args.run)) : resolveLatestRunPath(runsDir);
  const outRoot = path.resolve(ROOT, String(args['out-root'] || DEFAULT_OUT_ROOT));
  const token = deriveRunToken(runPath);
  const outDir = path.join(outRoot, token);
  fs.mkdirSync(outDir, { recursive: true });

  const runReport = readJson(runPath, 'run report');
  const cases = Array.isArray(runReport && runReport.cases) ? runReport.cases : [];

  const bundle = {
    schema_version: 'travel_expert_multiturn_scoring_packet.v2',
    generated_at: new Date().toISOString(),
    run_report: relativeToRoot(runPath),
    summary: runReport && runReport.summary ? runReport.summary : {},
    cases,
  };

  const bundleJsonPath = path.join(outDir, 'aurora_travel_multiturn_scoring_bundle.json');
  const bundleMdPath = path.join(outDir, 'aurora_travel_multiturn_scoring_bundle.md');
  fs.writeFileSync(bundleJsonPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  fs.writeFileSync(bundleMdPath, buildBundleMarkdown(bundle, relativeToRoot(runPath)), 'utf8');

  const summaryPath = path.join(outDir, 'efgh_result_summary.md');
  const summaryLines = [];
  summaryLines.push('# EFGH Result Summary');
  summaryLines.push('');
  summaryLines.push('| Alias | Case ID | Lang | Transport | Contract | Critical Fail Reasons |');
  summaryLines.push('|---|---|---|---|---|---|');
  for (const c of cases) {
    summaryLines.push(
      `| ${safeText(c.alias)} | ${safeText(c.id)} | ${safeText(c.language)} | ${toNum(c.ok_turns)}/${toNum(c.total_turns)} | ${toNum(c.contract_pass_turns)}/${toNum(c.total_turns)} | ${(Array.isArray(c.critical_fail_reasons) ? c.critical_fail_reasons : []).join(', ')} |`,
    );
  }
  fs.writeFileSync(summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');

  const promptPath = path.join(outDir, 'external_llm_scoring_prompt.md');
  fs.writeFileSync(promptPath, buildExternalPrompt(), 'utf8');

  const fileRows = [];
  for (const c of cases) {
    const name = caseFileName(c.id);
    const caseJsonPath = path.join(outDir, `case-${name}.json`);
    const caseMdPath = path.join(outDir, `case-${name}.md`);
    fs.writeFileSync(caseJsonPath, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
    writeCaseMarkdown(caseMdPath, c);
    fileRows.push({
      id: c.id,
      alias: c.alias,
      case_json: relativeToRoot(caseJsonPath),
      case_md: relativeToRoot(caseMdPath),
    });
  }

  const manifest = {
    schema_version: 'travel_expert_multiturn_scoring_manifest.v2',
    generated_at: new Date().toISOString(),
    token,
    run_report: relativeToRoot(runPath),
    bundle_json: relativeToRoot(bundleJsonPath),
    bundle_md: relativeToRoot(bundleMdPath),
    efgh_summary_md: relativeToRoot(summaryPath),
    external_prompt_md: relativeToRoot(promptPath),
    files: fileRows,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${JSON.stringify({
      out_dir: outDir,
      run_report: runPath,
      bundle_json: bundleJsonPath,
      bundle_md: bundleMdPath,
      summary_md: summaryPath,
      prompt_md: promptPath,
      manifest_json: manifestPath,
      run_sha256: sha256File(runPath),
      bundle_sha256: sha256File(bundleJsonPath),
    })}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[export_travel_multiturn_scoring_packets] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  }
}
