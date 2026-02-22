#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  lines.push('# Aurora Chat V2 PR Lite Gate');
  lines.push('');
  lines.push(`- started_at: ${report.started_at}`);
  lines.push(`- finished_at: ${report.finished_at}`);
  lines.push(`- status: ${report.status}`);
  lines.push(`- total_steps: ${report.steps.length}`);
  lines.push(`- failed_steps: ${report.steps.filter((s) => !s.ok).length}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  for (const step of report.steps) {
    lines.push(`- ${step.ok ? 'PASS' : 'FAIL'}: \`${step.cmd}\` (exit=${step.exit_code == null ? 'null' : step.exit_code})`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main() {
  const startedAt = new Date().toISOString();
  const stamp = nowStamp();
  const reportDir = 'reports';
  fs.mkdirSync(reportDir, { recursive: true });

  const steps = [];
  steps.push(
    runCommand('node', [
      '--test',
      'tests/aurora_rollout.node.test.cjs',
      'tests/aurora_rollout_probe.node.test.cjs',
      'tests/aurora_bff_chat_v2_policy.node.test.cjs',
      'tests/aurora_travel_gate.node.test.cjs',
    ]),
  );

  if (steps[steps.length - 1].ok) {
    steps.push(
      runCommand('node', [
        'scripts/aurora_travel_gate.js',
        '--mode',
        'local-mock',
        '--strict-meta',
        'true',
        '--report-dir',
        'reports',
      ]),
    );
  }

  const failed = steps.filter((s) => !s.ok).length;
  const report = {
    schema_version: 'aurora.chat.pr_lite_gate.v1',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status: failed > 0 ? 'failed' : 'passed',
    steps,
  };

  const jsonPath = path.join(reportDir, `aurora_chat_v2_pr_lite_${stamp}.json`);
  const mdPath = path.join(reportDir, `aurora_chat_v2_pr_lite_${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, buildMarkdown(report), 'utf8');
  process.stdout.write(`${JSON.stringify({ report_json: jsonPath, report_md: mdPath, status: report.status })}\n`);

  if (failed > 0) process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[aurora_chat_v2_pr_lite_gate] fatal: ${String(err && err.stack ? err.stack : err)}\n`);
    process.exit(1);
  }
}
