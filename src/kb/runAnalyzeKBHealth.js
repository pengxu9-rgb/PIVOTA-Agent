const fs = require('fs');
const path = require('path');

const { normalizeMarket } = require('../markets/market');
const { OutcomeSampleV0Schema } = require('../telemetry/schemas/outcomeSampleV0');
const { listOutcomeSamples } = require('../telemetry/outcomeStore');

// Reuse the deterministic metrics/analyzer implementation.
const { analyzeKBHealthUS } = require('./us/analyzeKBHealth');
const { renderKBHealthReportMD } = require('./us/report');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = String(a || '').match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonl(filePath, market) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const parsed = lines.map((l) => OutcomeSampleV0Schema.parse(JSON.parse(l)));
  return parsed.filter((s) => s.market === market);
}

function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = normalizeMarket(args.market, normalizeMarket(process.env.DEFAULT_MARKET, 'US'));
  const limit = args.sample ? Math.max(0, Math.min(Number(args.sample) || 0, 50000)) : 1000;
  const fixture = args.fixture ? String(args.fixture) : null;
  const outDir = args.outDir
    ? String(args.outDir)
    : path.join(__dirname, '..', '..', '..', 'artifacts', 'kb', market.toLowerCase());

  let samples = [];
  if (fixture) {
    samples = readJsonl(fixture, market);
  } else {
    samples = await listOutcomeSamples({ market, limit });
  }

  ensureDir(outDir);

  // The analyzer is market-agnostic as long as we pass market-filtered samples.
  const summary = analyzeKBHealthUS(samples);
  summary.market = market;

  fs.writeFileSync(path.join(outDir, 'kb_health_summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'kb_health_report.md'), renderKBHealthReportMD(summary));

  if (!samples.length) {
    fs.writeFileSync(path.join(outDir, 'kb_gap_candidates.jsonl'), '');
    // eslint-disable-next-line no-console
    console.log(`[kb] No outcome samples found for market=${market}; wrote empty report.`);
    return;
  }

  const candidates = Array.isArray(summary.gap_candidates) ? summary.gap_candidates : [];
  const lines = [];
  for (const c of candidates) {
    for (const jobId of c.jobIds.slice(0, 200)) {
      lines.push({ jobId, clusterKey: c.key, priority: c.priority, count: c.count, market });
    }
  }
  writeJsonl(path.join(outDir, 'kb_gap_candidates.jsonl'), lines);

  // eslint-disable-next-line no-console
  console.log(`[kb] wrote artifacts to ${outDir}`);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };

