#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const repoRoot = path.resolve(__dirname, '..');
  const args = {
    repoRoot,
    outDir: path.join(repoRoot, 'reports', 'celestial-commerce-core-stabilization'),
    snapshot: path.join(
      repoRoot,
      'scripts',
      'fixtures',
      'celestial_commerce_core_stabilization_snapshot.json',
    ),
    steps: '',
    readinessSummary: '',
    readinessReport: '',
    gatewayDailySummary: '',
    gatewayDailyReport: '',
    stagingMatrixSummary: '',
    stagingMatrixReport: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    const next = argv[i + 1];
    if (token === '--repo-root' && next) args.repoRoot = path.resolve(String(next));
    if (token === '--out-dir' && next) args.outDir = path.resolve(String(next));
    if (token === '--snapshot' && next) args.snapshot = path.resolve(String(next));
    if (token === '--steps' && next) args.steps = path.resolve(String(next));
    if (token === '--readiness-summary' && next) args.readinessSummary = path.resolve(String(next));
    if (token === '--readiness-report' && next) args.readinessReport = path.resolve(String(next));
    if (token === '--gateway-daily-summary' && next) args.gatewayDailySummary = path.resolve(String(next));
    if (token === '--gateway-daily-report' && next) args.gatewayDailyReport = path.resolve(String(next));
    if (token === '--staging-matrix-summary' && next) args.stagingMatrixSummary = path.resolve(String(next));
    if (token === '--staging-matrix-report' && next) args.stagingMatrixReport = path.resolve(String(next));
  }

  return args;
}

function readJsonIfExists(filePath, fallbackValue) {
  if (!filePath) return fallbackValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallbackValue;
  }
}

function gitValue(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim();
  } catch (_error) {
    return '';
  }
}

function repoTruth(repoRoot) {
  return {
    repo_root: repoRoot,
    branch: gitValue(repoRoot, ['branch', '--show-current']) || 'unknown',
    head: gitValue(repoRoot, ['rev-parse', '--short', 'HEAD']) || 'unknown',
    origin_main: gitValue(repoRoot, ['rev-parse', '--short', 'origin/main']) || 'unknown',
    dirty_files: Number(gitValue(repoRoot, ['status', '--porcelain'])?.split('\n').filter(Boolean).length || 0),
  };
}

function collectScorecardBuckets(scorecard = {}) {
  const amber = [];
  const red = [];
  for (const [key, status] of Object.entries(scorecard || {})) {
    if (status === 'amber') amber.push(key);
    if (status === 'red') red.push(key);
  }
  return { amber, red };
}

function decideConclusion({ steps, scorecard, gatewayDaily, stagingMatrix }) {
  const failedSteps = (steps || []).filter((item) => item.status !== 'pass');
  const scorecardBuckets = collectScorecardBuckets(scorecard);
  const blockingFailures = [];
  const holdReasons = [];

  if (failedSteps.length > 0) {
    blockingFailures.push(
      `local baseline failures: ${failedSteps.map((item) => item.name).join(', ')}`,
    );
  }

  if (scorecardBuckets.red.length > 0) {
    blockingFailures.push(`readiness red dimensions: ${scorecardBuckets.red.join(', ')}`);
  }

  if (
    gatewayDaily &&
    gatewayDaily.alerts &&
    String(gatewayDaily.alerts.overall_status || '').trim() &&
    gatewayDaily.alerts.overall_status !== 'green'
  ) {
    blockingFailures.push(
      `gateway daily alert status is ${String(gatewayDaily.alerts.overall_status || 'missing')}`,
    );
  }

  if (
    gatewayDaily &&
    gatewayDaily.shadow_summary &&
    String(gatewayDaily.shadow_summary.readiness_status || '').trim() &&
    gatewayDaily.shadow_summary.readiness_status !== 'green'
  ) {
    blockingFailures.push(
      `gateway shadow readiness is ${String(
        gatewayDaily.shadow_summary.readiness_status || 'missing',
      )}`,
    );
  }

  if (
    stagingMatrix &&
    stagingMatrix.summary &&
    Number(stagingMatrix.summary.blocking_failures || 0) > 0
  ) {
    blockingFailures.push(
      `staging matrix blocking failures: ${String(stagingMatrix.summary.blocking_failures)}`,
    );
  }

  if (blockingFailures.length > 0) {
    return {
      decision: 'NO-GO',
      label: 'NO-GO',
      next_action: 'fix blocker regressions before any staging hardening or additional refactor',
      blocking_failures: blockingFailures,
      hold_reasons: [],
    };
  }

  if (
    stagingMatrix &&
    stagingMatrix.summary &&
    Number(stagingMatrix.summary.infra_blocked_count || 0) > 0
  ) {
    holdReasons.push(
      `staging infrastructure blocked live acceptance: ${String(
        stagingMatrix.summary.infra_blocked_count,
      )}`,
    );
  }

  if (scorecardBuckets.amber.length > 0) {
    holdReasons.push(`readiness amber dimensions: ${scorecardBuckets.amber.join(', ')}`);
  }

  if (
    stagingMatrix &&
    stagingMatrix.summary &&
    Number(stagingMatrix.summary.review_required_count || 0) > 0
  ) {
    holdReasons.push(
      `staging matrix manual reviews still pending: ${String(
        stagingMatrix.summary.review_required_count,
      )}`,
    );
  }

  if (!stagingMatrix || !stagingMatrix.summary) {
    holdReasons.push('staging matrix artifact missing');
  }

  if (holdReasons.length > 0) {
    return {
      decision: 'HOLD',
      label: 'HOLD for architecture stabilization',
      next_action: 'freeze new refactors, clear amber areas or complete manual staging review, then rerun acceptance',
      blocking_failures: [],
      hold_reasons: holdReasons,
    };
  }

  return {
    decision: 'GO',
    label: 'GO for continued staging hardening',
    next_action: 'continue with blocker-only fixes and prepare the next formal staging acceptance cycle',
    blocking_failures: [],
    hold_reasons: [],
  };
}

function markdownTableRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

function writeArtifacts(args, payload) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const markdownPath = path.join(args.outDir, 'README.md');
  const jsonPath = path.join(args.outDir, 'summary.json');

  const lines = [
    '# Celestial Commerce Core Stabilization Review',
    '',
    `- Generated at: ${payload.generated_at}`,
    `- Candidate decision: ${payload.decision.label}`,
    `- Repo root: \`${payload.repo.repo_root}\``,
    `- Readiness report: \`${payload.artifacts.readiness_report || 'missing'}\``,
    `- Gateway daily report: \`${payload.artifacts.gateway_daily_report || 'missing'}\``,
    `- Staging matrix report: \`${payload.artifacts.staging_matrix_report || 'missing'}\``,
    '',
    '## Candidate Snapshot',
    '',
    '### Completed',
    ...payload.snapshot.completed.map((item) => `- ${item}`),
    '',
    '### Incomplete',
    ...payload.snapshot.incomplete.map((item) => `- ${item}`),
    '',
    '### Deferred This Cycle',
    ...payload.snapshot.deferred.map((item) => `- ${item}`),
    '',
    '## Repo Truth',
    '',
    markdownTableRow(['Branch', 'HEAD', 'origin/main', 'Dirty files']),
    markdownTableRow(['---', '---', '---', '---:']),
    markdownTableRow([
      `\`${payload.repo.branch}\``,
      `\`${payload.repo.head}\``,
      `\`${payload.repo.origin_main}\``,
      String(payload.repo.dirty_files),
    ]),
    '',
    '## Automated Baseline',
    '',
    markdownTableRow(['Step', 'Status', 'Log']),
    markdownTableRow(['---', '---', '---']),
    ...payload.steps.map((step) =>
      markdownTableRow([step.name, step.status, `\`${step.log || 'n/a'}\``]),
    ),
    '',
    '## Readiness Scorecard',
    '',
    markdownTableRow(['Dimension', 'Status']),
    markdownTableRow(['---', '---']),
    ...Object.entries(payload.readiness.scorecard || {}).map(([key, value]) =>
      markdownTableRow([key, String(value)]),
    ),
    '',
    '## Staging Matrix Summary',
    '',
    markdownTableRow(['Metric', 'Value']),
    markdownTableRow(['---', '---:']),
    markdownTableRow(['total_cases', String(payload.staging.summary.total_cases || 0)]),
    markdownTableRow(['pass_count', String(payload.staging.summary.pass_count || 0)]),
    markdownTableRow(['fail_count', String(payload.staging.summary.fail_count || 0)]),
    markdownTableRow([
      'primary_path_degraded_count',
      String(payload.staging.summary.primary_path_degraded_count || 0),
    ]),
    markdownTableRow([
      'review_required_count',
      String(payload.staging.summary.review_required_count || 0),
    ]),
    markdownTableRow([
      'infra_blocked_count',
      String(payload.staging.summary.infra_blocked_count || 0),
    ]),
    markdownTableRow([
      'blocking_failures',
      String(payload.staging.summary.blocking_failures || 0),
    ]),
    markdownTableRow([
      'authoritative_endpoint',
      String(payload.readiness.authoritative_endpoint || 'missing'),
    ]),
    markdownTableRow([
      'authoritative_mode',
      String(payload.readiness.authoritative_mode || 'missing'),
    ]),
    markdownTableRow([
      'public_probe_non_authoritative',
      String(payload.readiness.public_probe_non_authoritative || 'false'),
    ]),
    '',
    '## Decision',
    '',
    `- Conclusion: ${payload.decision.label}`,
    `- Next action: ${payload.decision.next_action}`,
  ];

  if (payload.decision.blocking_failures.length > 0) {
    lines.push('- Blocking failures:');
    for (const item of payload.decision.blocking_failures) lines.push(`  - ${item}`);
  }

  if (payload.decision.hold_reasons.length > 0) {
    lines.push('- Hold reasons:');
    for (const item of payload.decision.hold_reasons) lines.push(`  - ${item}`);
  }

  lines.push('');
  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { markdownPath, jsonPath };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = readJsonIfExists(args.snapshot, {
    completed: [],
    incomplete: [],
    deferred: [],
  });
  const stepsPayload = readJsonIfExists(args.steps, { steps: [] });
  const readiness = readJsonIfExists(args.readinessSummary, { scorecard: {} });
  const gatewayDaily = readJsonIfExists(args.gatewayDailySummary, {
    shadow_summary: {},
    alerts: {},
  });
  const staging = readJsonIfExists(args.stagingMatrixSummary, {
    summary: {},
    results: [],
  });
  const repo = repoTruth(args.repoRoot);
  const decision = decideConclusion({
    steps: stepsPayload.steps || [],
    scorecard: readiness.scorecard || {},
    gatewayDaily,
    stagingMatrix: staging,
  });

  const payload = {
    generated_at: new Date().toISOString(),
    decision,
    repo,
    snapshot,
    steps: Array.isArray(stepsPayload.steps) ? stepsPayload.steps : [],
    readiness: {
      summary_path: args.readinessSummary || null,
      report_path: args.readinessReport || null,
      scorecard: readiness.scorecard || {},
      authoritative_endpoint: readiness.authoritative_endpoint || null,
      authoritative_mode: readiness.authoritative_mode || null,
      public_probe_non_authoritative: readiness.public_probe_non_authoritative || null,
    },
    gateway_daily: {
      summary_path: args.gatewayDailySummary || null,
      report_path: args.gatewayDailyReport || null,
      shadow_summary: gatewayDaily.shadow_summary || {},
      alerts: gatewayDaily.alerts || {},
    },
    staging: {
      summary_path: args.stagingMatrixSummary || null,
      report_path: args.stagingMatrixReport || null,
      summary: staging.summary || {},
      results: Array.isArray(staging.results) ? staging.results : [],
    },
    artifacts: {
      readiness_report: args.readinessReport || null,
      gateway_daily_report: args.gatewayDailyReport || null,
      staging_matrix_report: args.stagingMatrixReport || null,
    },
  };

  const { markdownPath, jsonPath } = writeArtifacts(args, payload);
  process.stdout.write(
    `${JSON.stringify(
      {
        decision: payload.decision.decision,
        label: payload.decision.label,
        markdown_path: markdownPath,
        json_path: jsonPath,
      },
      null,
      2,
    )}\n`,
  );
}

main();
