#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_BASE = 'https://pivota-agent-production.up.railway.app';
const DEFAULT_OUTPUT_DIR = 'reports';

function parseArgs(argv) {
  const out = {
    base: DEFAULT_BASE,
    outDir: DEFAULT_OUTPUT_DIR,
    date: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (!next) continue;
    if (token === '--base') {
      out.base = next;
      index += 1;
      continue;
    }
    if (token === '--out') {
      out.outDir = next;
      index += 1;
      continue;
    }
    if (token === '--date') {
      out.date = next;
      index += 1;
    }
  }
  return out;
}

function normalizeDateParts(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    return { dateKey: `${y}${m}${d}`, stamp: `${hh}${mm}` };
  }
  if (/^\d{8}$/.test(raw)) return { dateKey: raw, stamp: '0000' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { dateKey: raw.replace(/-/g, ''), stamp: '0000' };
  throw new Error(`invalid --date value: ${raw}`);
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pct(part, total) {
  if (!total) return 0;
  return Number((part / total).toFixed(3));
}

function parseLabels(raw) {
  const labels = {};
  if (!raw) return labels;
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g;
  let match = re.exec(raw);
  while (match) {
    labels[match[1]] = match[2];
    match = re.exec(raw);
  }
  return labels;
}

function parsePromMetrics(raw) {
  const byStatus = new Map();
  const byReason = new Map();
  const byHttpClass = new Map();
  let budgetGuard = 0;
  let circuitOpen = 0;
  let verifySkips = 0;
  let successLatencySum = 0;
  let successLatencyCount = 0;
  let failLatencySum = 0;
  let failLatencyCount = 0;

  for (const rawLine of String(raw || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const metricMatch = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/);
    if (!metricMatch) continue;
    const metricName = metricMatch[1];
    const labels = parseLabels(metricMatch[3] || '');
    const value = safeNumber(metricMatch[4], 0);

    if (metricName === 'verify_calls_total') {
      const status = labels.status || 'unknown';
      byStatus.set(status, safeNumber(byStatus.get(status), 0) + value);
      continue;
    }
    if (metricName === 'verify_fail_total') {
      const reason = labels.reason || 'UNKNOWN';
      byReason.set(reason, safeNumber(byReason.get(reason), 0) + value);
      const statusClass = labels.http_status_class || 'unknown';
      byHttpClass.set(statusClass, safeNumber(byHttpClass.get(statusClass), 0) + value);
      continue;
    }
    if (metricName === 'verify_skip_total') {
      verifySkips += value;
      continue;
    }
    if (metricName === 'verify_budget_guard_total') {
      budgetGuard += value;
      continue;
    }
    if (metricName === 'verify_circuit_open_total') {
      circuitOpen += value;
      continue;
    }
    if (metricName === 'verify_latency_ms_success_sum') {
      successLatencySum += value;
      continue;
    }
    if (metricName === 'verify_latency_ms_success_count') {
      successLatencyCount += value;
      continue;
    }
    if (metricName === 'verify_latency_ms_fail_sum') {
      failLatencySum += value;
      continue;
    }
    if (metricName === 'verify_latency_ms_fail_count') {
      failLatencyCount += value;
    }
  }

  const callsTotal = Array.from(byStatus.values()).reduce((acc, value) => acc + value, 0);
  const failTotal = Array.from(byReason.values()).reduce((acc, value) => acc + value, 0);
  const topReasons = Array.from(byReason.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return String(left[0]).localeCompare(String(right[0]));
    })
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count, rate_vs_calls: pct(count, callsTotal), rate_vs_fails: pct(count, failTotal) }));

  return {
    verify_calls_total: callsTotal,
    verify_fail_total: failTotal,
    verify_skip_total: verifySkips,
    verify_budget_guard_total: budgetGuard,
    verify_circuit_open_total: circuitOpen,
    calls_by_status: Array.from(byStatus.entries())
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .map(([status, count]) => ({ status, count })),
    fail_by_reason: topReasons,
    fail_by_http_status_class: Array.from(byHttpClass.entries())
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      .map(([http_status_class, count]) => ({ http_status_class, count, rate_vs_fails: pct(count, failTotal) })),
    success_latency_avg_ms: successLatencyCount > 0 ? Number((successLatencySum / successLatencyCount).toFixed(2)) : null,
    fail_latency_avg_ms: failLatencyCount > 0 ? Number((failLatencySum / failLatencyCount).toFixed(2)) : null,
  };
}

function toMarkdown(summary, base, commit, generatedAt) {
  const lines = [];
  lines.push(`# Verify Live Metrics Report`);
  lines.push('');
  lines.push(`Generated at (UTC): ${generatedAt}`);
  lines.push(`Source: ${base}/metrics`);
  lines.push(`x-service-commit: ${commit || 'unknown'}`);
  lines.push('');
  lines.push('## Overview');
  lines.push(`- verify_calls_total: ${summary.verify_calls_total}`);
  lines.push(`- verify_fail_total: ${summary.verify_fail_total}`);
  lines.push(`- verify_skip_total: ${summary.verify_skip_total}`);
  lines.push(`- verify_budget_guard_total: ${summary.verify_budget_guard_total}`);
  lines.push(`- verify_circuit_open_total: ${summary.verify_circuit_open_total}`);
  lines.push(`- success_latency_avg_ms: ${summary.success_latency_avg_ms == null ? 'n/a' : summary.success_latency_avg_ms}`);
  lines.push(`- fail_latency_avg_ms: ${summary.fail_latency_avg_ms == null ? 'n/a' : summary.fail_latency_avg_ms}`);
  lines.push('');
  lines.push('## Calls By Status');
  lines.push('');
  lines.push('| status | count |');
  lines.push('| --- | --- |');
  for (const row of summary.calls_by_status) {
    lines.push(`| ${row.status} | ${row.count} |`);
  }
  if (!summary.calls_by_status.length) lines.push('| n/a | 0 |');
  lines.push('');
  lines.push('## Fail By Reason');
  lines.push('');
  if (!summary.fail_by_reason.length) {
    lines.push('_No verifier failures in current metrics snapshot._');
  } else {
    lines.push('| reason | count | rate_vs_calls | rate_vs_fails |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of summary.fail_by_reason) {
      lines.push(`| ${row.reason} | ${row.count} | ${row.rate_vs_calls} | ${row.rate_vs_fails} |`);
    }
  }
  lines.push('');
  lines.push('## Fail By HTTP Status Class');
  lines.push('');
  if (!summary.fail_by_http_status_class.length) {
    lines.push('_No verifier failures in current metrics snapshot._');
  } else {
    lines.push('| http_status_class | count | rate_vs_fails |');
    lines.push('| --- | --- | --- |');
    for (const row of summary.fail_by_http_status_class) {
      lines.push(`| ${row.http_status_class} | ${row.count} | ${row.rate_vs_fails} |`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`request failed (${res.status}) for ${url}: ${text.slice(0, 240)}`);
  }
  return text;
}

async function fetchCommit(base) {
  try {
    const res = await fetch(`${base}/v1/session/bootstrap`, { method: 'HEAD' });
    return res.headers.get('x-service-commit') || '';
  } catch (_err) {
    return '';
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = String(args.base || DEFAULT_BASE).replace(/\/+$/, '');
  const { dateKey, stamp } = normalizeDateParts(args.date);
  const outDir = args.outDir || DEFAULT_OUTPUT_DIR;
  const generatedAt = new Date().toISOString();

  const metricsRaw = await fetchText(`${base}/metrics`);
  const commit = await fetchCommit(base);
  const summary = parsePromMetrics(metricsRaw);
  const payload = {
    generated_at_utc: generatedAt,
    source_base: base,
    x_service_commit: commit || null,
    summary,
  };

  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `verify_live_${dateKey}_${stamp}.json`);
  const mdPath = path.join(outDir, `verify_live_${dateKey}_${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2));
  await fs.writeFile(mdPath, toMarkdown(summary, base, commit, generatedAt));
  process.stdout.write(`${path.resolve(jsonPath)}\n${path.resolve(mdPath)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  parsePromMetrics,
  parseArgs,
  normalizeDateParts,
};
