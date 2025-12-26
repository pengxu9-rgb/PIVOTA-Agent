const fs = require('fs');
const path = require('path');

const { OutcomeSampleV0Schema } = require('../../telemetry/schemas/outcomeSampleV0');
const { listOutcomeSamplesUS } = require('../../telemetry/outcomeStore');
const { analyzeKBHealthUS } = require('./analyzeKBHealth');
const { renderKBHealthReportMD } = require('./report');

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

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  return lines.map((l) => OutcomeSampleV0Schema.parse(JSON.parse(l)));
}

function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = args.sample ? Math.max(0, Math.min(Number(args.sample) || 0, 50000)) : 1000;
  const fixture = args.fixture ? String(args.fixture) : null;
  const outDir = args.outDir
    ? String(args.outDir)
    : path.join(__dirname, '..', '..', '..', '..', 'artifacts', 'kb', 'us');

  let samples = [];
  if (fixture) {
    samples = readJsonl(fixture);
  } else {
    samples = await listOutcomeSamplesUS({ limit });
  }

  ensureDir(outDir);

  if (!samples.length) {
    const empty = analyzeKBHealthUS([]);
    fs.writeFileSync(path.join(outDir, 'kb_health_summary.json'), JSON.stringify(empty, null, 2));
    fs.writeFileSync(path.join(outDir, 'kb_health_report.md'), renderKBHealthReportMD(empty));
    fs.writeFileSync(path.join(outDir, 'kb_gap_candidates.jsonl'), '');
    // eslint-disable-next-line no-console
    console.log('[kb] No outcome samples found; wrote empty report.');
    return;
  }

  const summary = analyzeKBHealthUS(samples);
  fs.writeFileSync(path.join(outDir, 'kb_health_summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, 'kb_health_report.md'), renderKBHealthReportMD(summary));

  const candidates = Array.isArray(summary.gap_candidates) ? summary.gap_candidates : [];
  const lines = [];
  for (const c of candidates) {
    for (const jobId of c.jobIds.slice(0, 200)) {
      lines.push({ jobId, clusterKey: c.key, priority: c.priority, count: c.count });
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

