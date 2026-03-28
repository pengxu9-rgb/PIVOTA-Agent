#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !String(next).startsWith('--')) {
      out[key] = next;
      index += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function readJson(inputPath) {
  return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
}

function findCounterValue(rows = [], key) {
  const target = String(key || '').trim();
  const row = Array.isArray(rows) ? rows.find((item) => String(item?.key || '').trim() === target) : null;
  return row && Number.isFinite(Number(row.count)) ? Number(row.count) : 0;
}

function evaluateThresholdRule({ key, observed, rule }) {
  const severity = String(rule?.severity || 'amber').trim().toLowerCase() || 'amber';
  const description = String(rule?.description || '').trim() || null;
  let status = 'green';
  const hasMin = Number.isFinite(Number(rule?.min));
  const hasMax = Number.isFinite(Number(rule?.max));
  const comparator = hasMin ? 'min' : hasMax ? 'max' : null;
  const target = hasMin ? Number(rule.min) : hasMax ? Number(rule.max) : null;

  if (hasMin && observed < Number(rule.min)) {
    status = severity;
  } else if (hasMax && observed > Number(rule.max)) {
    status = severity;
  }

  return {
    key,
    status,
    observed,
    comparator,
    target,
    description,
  };
}

function buildAlerts(summary = {}, thresholds = {}) {
  const runtime = summary.runtime_samples && typeof summary.runtime_samples === 'object' ? summary.runtime_samples : {};
  const counters = runtime.counters && typeof runtime.counters === 'object' ? runtime.counters : {};
  const metrics = {
    runtime_shadow_events: Number(runtime.shadow_events || 0),
    unknown_principal_shadow_events: findCounterValue(counters.by_principal_type, 'unknown'),
    unknown_surface_shadow_events: findCounterValue(counters.by_surface, 'unknown'),
    merchant_sweep_blocked_events: findCounterValue(counters.by_reason_code, 'merchant_sweep_blocked'),
    deep_pagination_blocked_events: findCounterValue(counters.by_reason_code, 'deep_pagination_blocked'),
    checkout_handoff_not_allowed_events: findCounterValue(counters.by_reason_code, 'checkout_handoff_not_allowed'),
  };

  const alerts = [
    evaluateThresholdRule({
      key: 'min_runtime_shadow_events',
      observed: metrics.runtime_shadow_events,
      rule: thresholds.min_runtime_shadow_events || {},
    }),
    evaluateThresholdRule({
      key: 'max_unknown_principal_shadow_events',
      observed: metrics.unknown_principal_shadow_events,
      rule: thresholds.max_unknown_principal_shadow_events || {},
    }),
    evaluateThresholdRule({
      key: 'max_unknown_surface_shadow_events',
      observed: metrics.unknown_surface_shadow_events,
      rule: thresholds.max_unknown_surface_shadow_events || {},
    }),
    evaluateThresholdRule({
      key: 'max_merchant_sweep_blocked_events',
      observed: metrics.merchant_sweep_blocked_events,
      rule: thresholds.max_merchant_sweep_blocked_events || {},
    }),
    evaluateThresholdRule({
      key: 'max_deep_pagination_blocked_events',
      observed: metrics.deep_pagination_blocked_events,
      rule: thresholds.max_deep_pagination_blocked_events || {},
    }),
    evaluateThresholdRule({
      key: 'max_checkout_handoff_not_allowed_events',
      observed: metrics.checkout_handoff_not_allowed_events,
      rule: thresholds.max_checkout_handoff_not_allowed_events || {},
    }),
  ];

  const overallStatus = alerts.some((alert) => alert.status === 'red')
    ? 'red'
    : alerts.some((alert) => alert.status === 'amber')
      ? 'amber'
      : 'green';

  return {
    schema_version: 'pivota.gateway.governance.alerts.v1',
    overall_status: overallStatus,
    metrics,
    alerts,
  };
}

function buildMarkdown({ evaluation, summaryPath, thresholdsPath, generatedAtUtc }) {
  const lines = [];
  lines.push('# Gateway Governance Alert Evaluation');
  lines.push('');
  lines.push(`- Generated at (UTC): ${generatedAtUtc}`);
  lines.push(`- Summary JSON: \`${summaryPath}\``);
  lines.push(`- Thresholds: \`${thresholdsPath}\``);
  lines.push(`- Overall status: ${evaluation.overall_status}`);
  lines.push('');
  lines.push('## Alert Results');
  lines.push('');
  lines.push('| Rule | Status | Observed | Threshold | Description |');
  lines.push('| --- | --- | ---: | --- | --- |');
  for (const alert of evaluation.alerts) {
    const threshold =
      alert.comparator && alert.target != null
        ? `${alert.comparator === 'min' ? '>=' : '<='} ${alert.target}`
        : 'n/a';
    lines.push(
      `| ${alert.key} | ${alert.status} | ${alert.observed} | ${threshold} | ${alert.description || 'n/a'} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const summaryPath = path.resolve(String(args.summary || '').trim());
  if (!summaryPath) {
    throw new Error('--summary is required');
  }
  const thresholdsPath = path.resolve(
    String(
      args.thresholds ||
        path.join(repoRoot, 'scripts', 'fixtures', 'celestial_commerce_gateway_governance_alert_thresholds.json'),
    ).trim(),
  );
  const outDir = path.resolve(args['out-dir'] || path.dirname(summaryPath));

  const summary = readJson(summaryPath);
  const thresholds = readJson(thresholdsPath);
  const evaluation = buildAlerts(summary, thresholds);
  const generatedAtUtc = new Date().toISOString();

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'gateway_governance_alerts.json');
  const markdownPath = path.join(outDir, 'gateway_governance_alerts.md');
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        ...evaluation,
        generated_at_utc: generatedAtUtc,
        summary_path: summaryPath,
        thresholds_path: thresholdsPath,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    markdownPath,
    buildMarkdown({ evaluation, summaryPath, thresholdsPath, generatedAtUtc }),
  );

  process.stdout.write(
    `${JSON.stringify({
      overall_status: evaluation.overall_status,
      alert_count: evaluation.alerts.filter((alert) => alert.status !== 'green').length,
      json_path: jsonPath,
      markdown_path: markdownPath,
    })}\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAlerts,
};
