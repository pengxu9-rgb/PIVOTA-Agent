#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  buildGatewayGovernanceShadowSummary,
} = require('../src/modules/signals/readiness/buildGatewayGovernanceShadowSummary');

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

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function readRecords(inputPath) {
  const text = fs.readFileSync(inputPath, 'utf8');
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.ndjson' || ext === '.jsonl') {
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  const parsed = JSON.parse(trimmed);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.events)) return parsed.events;
  if (Array.isArray(parsed.records)) return parsed.records;
  if (Array.isArray(parsed.runtime_events)) return parsed.runtime_events;
  if (Array.isArray(parsed.samples)) return parsed.samples;
  return [parsed];
}

function formatCounterRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) return ['- none'];
  return rows.map((row) => `- ${row.key}: ${row.count}`);
}

function buildMarkdown({
  summary,
  fixturePath,
  runtimeSamplePath,
  jsonPath,
  generatedAtUtc,
}) {
  const lines = [];
  lines.push('# Gateway Governance Shadow Summary');
  lines.push('');
  lines.push(`- Generated at (UTC): ${generatedAtUtc}`);
  lines.push(`- Fixture: \`${fixturePath}\``);
  lines.push(`- JSON artifact: \`${jsonPath}\``);
  lines.push(`- Shadow mode: ${summary.shadow_mode ? 'true' : 'false'}`);
  lines.push(`- Readiness status: ${summary.readiness_status}`);
  lines.push(`- Matched scenarios: ${summary.matched_scenarios}/${summary.total_scenarios}`);
  lines.push(`- Would-enforce scenarios: ${summary.coverage.would_enforce_count}`);
  lines.push('');
  lines.push('## Counters');
  lines.push('');
  lines.push('### By Surface');
  lines.push(...formatCounterRows(summary.counters.by_surface));
  lines.push('');
  lines.push('### By Principal Type');
  lines.push(...formatCounterRows(summary.counters.by_principal_type));
  lines.push('');
  lines.push('### By Observed Action');
  lines.push(...formatCounterRows(summary.counters.by_observed_action));
  lines.push('');
  lines.push('### By Reason Code');
  lines.push(...formatCounterRows(summary.counters.by_reason_code));
  lines.push('');
  lines.push('## Scenario Results');
  lines.push('');
  lines.push('| Scenario | Surface | Entry layer | Principal | Observed | Effective | Would enforce | Matched |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of summary.scenarios) {
    lines.push(
      `| ${row.id} | ${row.invocation_surface || 'n/a'} | ${row.entry_layer || 'n/a'} | ${row.principal_type || 'n/a'} | ${row.observed_action} | ${row.effective_action} | ${row.would_enforce ? 'yes' : 'no'} | ${row.matched ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push('## Runtime Shadow Samples');
  lines.push('');
  lines.push(`- Runtime sample: \`${runtimeSamplePath || 'not_provided'}\``);
  lines.push(`- Total parsed events: ${summary.runtime_samples?.total_events || 0}`);
  lines.push(`- Shadow events: ${summary.runtime_samples?.shadow_events || 0}`);
  lines.push(`- Non-shadow events: ${summary.runtime_samples?.non_shadow_events || 0}`);
  lines.push(`- Ignored events: ${summary.runtime_samples?.ignored_events || 0}`);
  lines.push(`- Would-enforce shadow events: ${summary.runtime_samples?.coverage?.would_enforce_count || 0}`);
  lines.push(
    `- Blocked/throttled shadow events: ${summary.runtime_samples?.coverage?.blocked_or_throttled_observed_count || 0}`,
  );
  lines.push(
    `- Downgraded/truncated shadow events: ${summary.runtime_samples?.coverage?.downgraded_or_truncated_observed_count || 0}`,
  );
  lines.push(`- Latest shadow event (UTC): ${summary.runtime_samples?.latest_event_utc || 'missing'}`);
  lines.push('');
  lines.push('### Runtime By Surface');
  lines.push(...formatCounterRows(summary.runtime_samples?.counters?.by_surface));
  lines.push('');
  lines.push('### Runtime By Principal Type');
  lines.push(...formatCounterRows(summary.runtime_samples?.counters?.by_principal_type));
  lines.push('');
  lines.push('### Runtime By Observed Action');
  lines.push(...formatCounterRows(summary.runtime_samples?.counters?.by_observed_action));
  lines.push('');
  lines.push('### Runtime By Reason Code');
  lines.push(...formatCounterRows(summary.runtime_samples?.counters?.by_reason_code));
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(__dirname, '..');
  const fixturePath = path.resolve(
    args.fixture || path.join(repoRoot, 'scripts', 'fixtures', 'celestial_commerce_gateway_governance_baseline.json'),
  );
  const runtimeSamplePath = args['runtime-sample'] ? path.resolve(args['runtime-sample']) : null;
  const outDir = path.resolve(args['out-dir'] || path.join(repoRoot, 'reports', 'celestial-commerce-core-readiness'));
  const shadowMode = String(args['shadow-mode'] || 'true').trim().toLowerCase() !== 'false';

  const scenarios = readJson(fixturePath);
  const runtimeEvents = runtimeSamplePath ? readRecords(runtimeSamplePath) : [];
  const summary = buildGatewayGovernanceShadowSummary({
    scenarios,
    shadow_mode: shadowMode,
    runtime_events: runtimeEvents,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'gateway_governance_shadow_summary.json');
  const generatedAtUtc = new Date().toISOString();
  const enrichedSummary = {
    ...summary,
    generated_at_utc: generatedAtUtc,
    fixture_path: fixturePath,
    runtime_sample_path: runtimeSamplePath,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(enrichedSummary, null, 2)}\n`);

  const markdown = buildMarkdown({
    summary: enrichedSummary,
    fixturePath,
    runtimeSamplePath,
    jsonPath,
    generatedAtUtc,
  });
  const markdownPath = path.join(outDir, 'gateway_governance_shadow_summary.md');
  fs.writeFileSync(markdownPath, markdown);

  process.stdout.write(
    `${JSON.stringify({
      markdown_path: markdownPath,
      json_path: jsonPath,
      readiness_status: enrichedSummary.readiness_status,
      total_scenarios: enrichedSummary.total_scenarios,
      matched_scenarios: enrichedSummary.matched_scenarios,
      runtime_shadow_events: enrichedSummary.runtime_samples?.shadow_events || 0,
    })}\n`,
  );
}

main();
