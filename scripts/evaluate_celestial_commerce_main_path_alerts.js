#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { FALLBACK_QUERY_SOURCES } = require('./lib/commerce_primary_path');

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

function readJsonIfExists(filePath, fallbackValue = {}) {
  if (!filePath) return fallbackValue;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallbackValue;
  }
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAuthority(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function collectStagingRecords(summaryPayload = {}) {
  const results = Array.isArray(summaryPayload.results) ? summaryPayload.results : [];
  return results
    .filter((item) => String(item?.execution_mode || 'live').trim() !== 'manual')
    .map((item) => {
      const excerpt =
        item?.response_excerpt && typeof item.response_excerpt === 'object' ? item.response_excerpt : {};
      const decisionAuthority = normalizeAuthority(excerpt.decision_authority, excerpt.query_source);
      return {
        source: 'staging_matrix',
        mainPathPass: excerpt.main_path_pass === true,
        primaryPathDegraded: excerpt.primary_path_degraded === true,
        decisionLocked: excerpt.decision_locked === true,
        decisionAuthority,
        querySource: normalizeAuthority(excerpt.query_source, decisionAuthority),
        serviceVersionCommitPresent: excerpt.service_version_commit_present === true,
      };
    });
}

function collectSearchRecords(summaryPayload = {}) {
  const rows = Array.isArray(summaryPayload.rows) ? summaryPayload.rows : [];
  return rows.map((row) => {
    const decisionAuthority = normalizeAuthority(row?.decision_authority, row?.query_source);
    return {
      source: 'search_stability_matrix',
      mainPathPass: row?.main_path_pass === true,
      primaryPathDegraded: row?.primary_path_degraded === true,
      decisionLocked: row?.decision_locked === true,
      decisionAuthority,
      querySource: normalizeAuthority(row?.query_source, decisionAuthority),
      serviceVersionCommitPresent: row?.service_version_commit_present === true,
    };
  });
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

function buildMetrics({ stagingMatrixSummary = {}, searchStabilitySummary = {}, gatewayDailySummary = {} }) {
  const records = []
    .concat(collectStagingRecords(stagingMatrixSummary))
    .concat(collectSearchRecords(searchStabilitySummary));
  const totalRecords = records.length;
  const mainPathPassCount = records.filter((item) => item.mainPathPass).length;
  const primaryPathDegradedCount = records.filter((item) => item.primaryPathDegraded).length;
  const decisionUnlockedCount = records.filter((item) => item.decisionLocked !== true).length;
  const fallbackAuthorityCount = records.filter((item) =>
    FALLBACK_QUERY_SOURCES.has(normalizeAuthority(item.decisionAuthority, item.querySource)),
  ).length;
  const agentProductsErrorFallbackCount = records.filter(
    (item) =>
      normalizeAuthority(item.decisionAuthority, item.querySource) === 'agent_products_error_fallback',
  ).length;
  const serviceVersionCommitMissingCount = records.filter(
    (item) => item.serviceVersionCommitPresent !== true,
  ).length;
  const governanceWouldEnforceCount = toNumber(
    gatewayDailySummary?.shadow_summary?.runtime_would_enforce_count,
    0,
  );
  const authorityCounts = {};
  const sourceCounts = {};

  for (const item of records) {
    const authority = normalizeAuthority(item.decisionAuthority, item.querySource) || 'missing';
    authorityCounts[authority] = toNumber(authorityCounts[authority], 0) + 1;
    sourceCounts[item.source] = toNumber(sourceCounts[item.source], 0) + 1;
  }

  return {
    total_records: totalRecords,
    main_path_pass_count: mainPathPassCount,
    main_path_pass_rate: totalRecords > 0 ? mainPathPassCount / totalRecords : 0,
    primary_path_degraded_count: primaryPathDegradedCount,
    primary_path_degraded_rate: totalRecords > 0 ? primaryPathDegradedCount / totalRecords : 0,
    decision_unlocked_count: decisionUnlockedCount,
    fallback_authority_count: fallbackAuthorityCount,
    agent_products_error_fallback_count: agentProductsErrorFallbackCount,
    service_version_commit_missing_count: serviceVersionCommitMissingCount,
    governance_would_enforce_count: governanceWouldEnforceCount,
    authority_counts: authorityCounts,
    source_counts: sourceCounts,
  };
}

function buildAlerts(input = {}, thresholds = {}) {
  const metrics = buildMetrics(input);
  const alerts = [
    evaluateThresholdRule({
      key: 'min_total_records',
      observed: metrics.total_records,
      rule: thresholds.min_total_records || {},
    }),
    evaluateThresholdRule({
      key: 'min_main_path_pass_rate',
      observed: metrics.main_path_pass_rate,
      rule: thresholds.min_main_path_pass_rate || {},
    }),
    evaluateThresholdRule({
      key: 'max_primary_path_degraded_count',
      observed: metrics.primary_path_degraded_count,
      rule: thresholds.max_primary_path_degraded_count || {},
    }),
    evaluateThresholdRule({
      key: 'max_decision_unlocked_count',
      observed: metrics.decision_unlocked_count,
      rule: thresholds.max_decision_unlocked_count || {},
    }),
    evaluateThresholdRule({
      key: 'max_fallback_authority_count',
      observed: metrics.fallback_authority_count,
      rule: thresholds.max_fallback_authority_count || {},
    }),
    evaluateThresholdRule({
      key: 'max_agent_products_error_fallback_count',
      observed: metrics.agent_products_error_fallback_count,
      rule: thresholds.max_agent_products_error_fallback_count || {},
    }),
    evaluateThresholdRule({
      key: 'max_service_version_commit_missing_count',
      observed: metrics.service_version_commit_missing_count,
      rule: thresholds.max_service_version_commit_missing_count || {},
    }),
    evaluateThresholdRule({
      key: 'max_governance_would_enforce_count',
      observed: metrics.governance_would_enforce_count,
      rule: thresholds.max_governance_would_enforce_count || {},
    }),
  ];

  const overallStatus = alerts.some((alert) => alert.status === 'red')
    ? 'red'
    : alerts.some((alert) => alert.status === 'amber')
      ? 'amber'
      : 'green';

  return {
    schema_version: 'pivota.commerce.main_path_alerts.v1',
    overall_status: overallStatus,
    metrics,
    alerts,
  };
}

function buildMarkdown({
  evaluation,
  stagingMatrixSummaryPath,
  searchStabilitySummaryPath,
  gatewayDailySummaryPath,
  thresholdsPath,
  generatedAtUtc,
}) {
  const lines = [];
  lines.push('# Commerce Main-Path Alert Evaluation');
  lines.push('');
  lines.push(`- Generated at (UTC): ${generatedAtUtc}`);
  lines.push(`- Staging matrix summary: \`${stagingMatrixSummaryPath || 'not_provided'}\``);
  lines.push(`- Search stability summary: \`${searchStabilitySummaryPath || 'not_provided'}\``);
  lines.push(`- Gateway daily summary: \`${gatewayDailySummaryPath || 'not_provided'}\``);
  lines.push(`- Thresholds: \`${thresholdsPath}\``);
  lines.push(`- Overall status: ${evaluation.overall_status}`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | ---: |');
  lines.push(`| total_records | ${evaluation.metrics.total_records} |`);
  lines.push(`| main_path_pass_count | ${evaluation.metrics.main_path_pass_count} |`);
  lines.push(`| main_path_pass_rate | ${evaluation.metrics.main_path_pass_rate.toFixed(4)} |`);
  lines.push(`| primary_path_degraded_count | ${evaluation.metrics.primary_path_degraded_count} |`);
  lines.push(`| primary_path_degraded_rate | ${evaluation.metrics.primary_path_degraded_rate.toFixed(4)} |`);
  lines.push(`| decision_unlocked_count | ${evaluation.metrics.decision_unlocked_count} |`);
  lines.push(`| fallback_authority_count | ${evaluation.metrics.fallback_authority_count} |`);
  lines.push(
    `| agent_products_error_fallback_count | ${evaluation.metrics.agent_products_error_fallback_count} |`,
  );
  lines.push(
    `| service_version_commit_missing_count | ${evaluation.metrics.service_version_commit_missing_count} |`,
  );
  lines.push(`| governance_would_enforce_count | ${evaluation.metrics.governance_would_enforce_count} |`);
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
  const stagingMatrixSummaryPath = args['staging-matrix-summary']
    ? path.resolve(String(args['staging-matrix-summary']).trim())
    : '';
  const searchStabilitySummaryPath = args['search-stability-summary']
    ? path.resolve(String(args['search-stability-summary']).trim())
    : '';
  const gatewayDailySummaryPath = args['gateway-daily-summary']
    ? path.resolve(String(args['gateway-daily-summary']).trim())
    : '';

  if (!stagingMatrixSummaryPath && !searchStabilitySummaryPath) {
    throw new Error('--staging-matrix-summary or --search-stability-summary is required');
  }

  const thresholdsPath = path.resolve(
    String(
      args.thresholds ||
        path.join(repoRoot, 'scripts', 'fixtures', 'celestial_commerce_main_path_alert_thresholds.json'),
    ).trim(),
  );
  const outDir = path.resolve(
    args['out-dir'] ||
      path.dirname(stagingMatrixSummaryPath || searchStabilitySummaryPath || thresholdsPath),
  );

  const evaluation = buildAlerts(
    {
      stagingMatrixSummary: readJsonIfExists(stagingMatrixSummaryPath, {}),
      searchStabilitySummary: readJsonIfExists(searchStabilitySummaryPath, {}),
      gatewayDailySummary: readJsonIfExists(gatewayDailySummaryPath, {}),
    },
    readJsonIfExists(thresholdsPath, {}),
  );
  const generatedAtUtc = new Date().toISOString();

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'main_path_alerts.json');
  const markdownPath = path.join(outDir, 'main_path_alerts.md');
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        ...evaluation,
        generated_at_utc: generatedAtUtc,
        staging_matrix_summary_path: stagingMatrixSummaryPath || null,
        search_stability_summary_path: searchStabilitySummaryPath || null,
        gateway_daily_summary_path: gatewayDailySummaryPath || null,
        thresholds_path: thresholdsPath,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    markdownPath,
    buildMarkdown({
      evaluation,
      stagingMatrixSummaryPath,
      searchStabilitySummaryPath,
      gatewayDailySummaryPath,
      thresholdsPath,
      generatedAtUtc,
    }),
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
  buildMetrics,
};
