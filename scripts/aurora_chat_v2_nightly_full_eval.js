#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!String(cur).startsWith('--')) continue;
    const key = String(cur).slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function runCommand(cmd, args, env = process.env) {
  const startedAt = new Date().toISOString();
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env,
  });
  const endedAt = new Date().toISOString();
  const ok = Number(res.status) === 0 && !res.error;
  return {
    cmd: [cmd, ...args].join(' '),
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: Number.isFinite(Number(res.status)) ? Number(res.status) : null,
    signal: res.signal || null,
    ok,
    error: res.error ? String(res.error.message || res.error) : null,
  };
}

function buildMarkdown(report) {
  const lines = [];
  lines.push('# Aurora Chat V2 Nightly Full Eval');
  lines.push('');
  lines.push(`- base: ${report.base}`);
  lines.push(`- started_at: ${report.started_at}`);
  lines.push(`- finished_at: ${report.finished_at}`);
  lines.push(`- status: ${report.status}`);
  lines.push(`- total_steps: ${report.steps.length}`);
  lines.push(`- failed_steps: ${report.steps.filter((s) => !s.ok).length}`);
  lines.push('');

  lines.push('## Step Results');
  lines.push('');
  for (const step of report.steps) {
    lines.push(`- ${step.ok ? 'PASS' : 'FAIL'}: \`${step.cmd}\` (exit=${step.exit_code == null ? 'null' : step.exit_code})`);
  }
  lines.push('');

  const failed = report.steps.filter((s) => !s.ok);
  if (failed.length) {
    lines.push('## Failure Clusters');
    lines.push('');
    for (const item of failed) {
      lines.push(`- command: \`${item.cmd}\``);
      if (item.error) lines.push(`- error: ${item.error}`);
      lines.push('');
    }
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- P0 blockers: unit/replay/local-mock-travel20/live-travel20.');
  lines.push('- Follow-up canary is included in nightly for conversation continuity drift.');
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const base = String(args.base || process.env.AURORA_EVAL_BASE_URL || 'https://pivota-agent-staging.up.railway.app').replace(/\/+$/, '');
  const stamp = nowStamp();
  const reportDir = 'reports';
  fs.mkdirSync(reportDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const steps = [];

  steps.push(runCommand('npm', ['run', 'test:aurora-bff:unit']));
  if (steps[steps.length - 1].ok) {
    steps.push(runCommand('npm', ['run', 'test:replay-quality']));
  }
  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('node', [
        'scripts/aurora_travel_gate.js',
        '--mode',
        'local-mock',
        '--strict-meta',
        'true',
        '--report-dir',
        reportDir,
      ]),
    );
  }
  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('node', [
        'scripts/aurora_travel_gate.js',
        '--mode',
        'staging-live',
        '--base',
        base,
        '--strict-meta',
        'false',
        '--report-dir',
        reportDir,
      ]),
    );
  }
  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('node', [
        'scripts/chat_followup_canary.mjs',
        '--base',
        base,
        '--out',
        path.join(reportDir, `chat_followup_canary_nightly_${stamp}.md`),
      ]),
    );
  }

  const failed = steps.filter((s) => !s.ok).length;
  const report = {
    schema_version: 'aurora.chat.nightly_full_eval.v1',
    base,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: failed > 0 ? 'failed' : 'passed',
    steps,
  };

  const jsonPath = path.join(reportDir, `aurora_chat_v2_nightly_full_${stamp}.json`);
  const mdPath = path.join(reportDir, `aurora_chat_v2_nightly_full_${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify({ report_json: jsonPath, report_md: mdPath, status: report.status })}\n`);

  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[aurora_chat_v2_nightly_full_eval] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  }
}
