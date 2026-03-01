#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BASE_URL = String(process.env.AURORA_BASE_URL || 'https://pivota-agent-production.up.railway.app').replace(/\/+$/, '');
const REPORT_DIR = String(process.env.AURORA_REPORT_DIR || path.join(process.cwd(), 'reports'));

const METRIC_KEYS = [
  'aurora_skin_reco_generated_rate',
  'aurora_skin_reco_timeout_degraded_rate',
  'aurora_skin_low_confidence_rate',
  'aurora_skin_analysis_timeout_degraded_rate',
  'aurora_skin_routine_timeout_degraded_rate',
  'aurora_ingredients_text_route_drift_rate',
];

function nowTag() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseMetricLines(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.exec(trimmed);
    if (!m) continue;
    const name = m[1];
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (METRIC_KEYS.includes(name)) out[name] = value;
  }
  return out;
}

async function main() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Please run with Node 20+.');
  }
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const startedAt = Date.now();
  const res = await fetch(`${BASE_URL}/metrics`, { method: 'GET' });
  const text = await res.text();
  const parsed = parseMetricLines(text);
  const report = {
    base_url: BASE_URL,
    status: res.status,
    latency_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    metrics: parsed,
    missing_metrics: METRIC_KEYS.filter((k) => !(k in parsed)),
  };
  const outPath = path.join(REPORT_DIR, `aurora_reco_baseline_snapshot_${nowTag()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Snapshot saved: ${outPath}`);
  console.log(JSON.stringify(report.metrics, null, 2));
}

main().catch((err) => {
  console.error('aurora_reco_baseline_snapshot failed:', err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});

