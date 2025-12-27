const fs = require('fs');
const path = require('path');

const { normalizeMarket } = require('../markets/market');
const { OutcomeSampleV0Schema } = require('../telemetry/schemas/outcomeSampleV0');
const { ReplayCandidateLineSchema, replayFromOutcomeSample } = require('./replay/replayLayer2');
const { listOutcomeSamples } = require('../telemetry/outcomeStore');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = String(a || '').match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (String(a) === '--ci') out.ci = true;
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function maybeReadJsonl(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  return readJsonl(filePath);
}

function indexSamplesByJobId(samples) {
  const map = new Map();
  for (const s of samples) map.set(s.jobId, s);
  return map;
}

function renderMarkdownReport({ market, inputPath, sampleLimit, results, skipped }) {
  const total = results.length + skipped.length;
  const improvedFallback = results.filter((r) => r.baseline.anyFallbackUsed && !r.replay.kbFallbackUsed).length;
  const regressedFallback = results.filter((r) => !r.baseline.anyFallbackUsed && r.replay.kbFallbackUsed).length;
  const improvedLow = results.filter((r) => r.baseline.anyAdjustmentLowConfidence && !r.replay.anyLowConfidence).length;
  const regressedLow = results.filter((r) => !r.baseline.anyAdjustmentLowConfidence && r.replay.anyLowConfidence).length;

  const lines = [];
  lines.push(`# Layer2 KB Replay Report (${market})`);
  lines.push('');
  lines.push(`- input: \`${inputPath}\``);
  lines.push(`- sample: ${sampleLimit}`);
  lines.push(`- processed: ${results.length}`);
  lines.push(`- skipped: ${skipped.length}`);
  lines.push(`- total: ${total}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- fallback improved: ${improvedFallback}`);
  lines.push(`- fallback regressed: ${regressedFallback}`);
  lines.push(`- low-confidence improved: ${improvedLow}`);
  lines.push(`- low-confidence regressed: ${regressedLow}`);
  lines.push('');

  if (skipped.length) {
    lines.push('## Skipped');
    lines.push('');
    for (const s of skipped.slice(0, 20)) {
      lines.push(`- jobId=${s.jobId}: ${s.reason}`);
    }
    if (skipped.length > 20) lines.push(`- ... (${skipped.length - 20} more)`);
    lines.push('');
  }

  lines.push('## Details');
  lines.push('');
  for (const r of results) {
    const headerBits = [];
    if (r.candidate.clusterKey) headerBits.push(`cluster=${r.candidate.clusterKey}`);
    if (typeof r.candidate.priority === 'number') headerBits.push(`priority=${r.candidate.priority}`);
    lines.push(`### ${r.jobId}${headerBits.length ? ` (${headerBits.join(', ')})` : ''}`);
    lines.push('');
    lines.push(`- baseline: fallback=${r.baseline.anyFallbackUsed} lowConfidence=${r.baseline.anyAdjustmentLowConfidence} techniques=${r.baseline.usedTechniquesCount}`);
    lines.push(
      `- replay: kbFallback=${r.replay.kbFallbackUsed} lowConfidence=${r.replay.anyLowConfidence} missingTechniqueIds=${r.replay.missingTechniqueIds.length} techniques=${r.replay.usedTechniquesCount}`,
    );
    if (r.replay.missingTechniqueIds.length) {
      lines.push(`- missing technique ids: ${r.replay.missingTechniqueIds.join(', ')}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const market = normalizeMarket(args.market, normalizeMarket(process.env.DEFAULT_MARKET, 'US'));
  const inputPath =
    args.input || path.join(__dirname, '..', '..', '..', 'artifacts', 'kb', market.toLowerCase(), 'kb_gap_candidates.jsonl');
  const outDir = args.outDir || path.join(__dirname, '..', '..', '..', 'artifacts', 'kb', market.toLowerCase());
  const sampleLimit = args.sample ? Math.max(0, Math.min(Number(args.sample) || 0, 5000)) : 50;

  const fixtureSamplesPath = args.samples || null;
  const fixtureCandidatesPath = String(inputPath);

  if (!fs.existsSync(fixtureCandidatesPath)) {
    // eslint-disable-next-line no-console
    console.log(`[kb:replay] input not found: ${fixtureCandidatesPath}`);
    process.exitCode = 1;
    return;
  }

  ensureDir(outDir);

  const candidateLinesAll = readJsonl(fixtureCandidatesPath).map((l) => ReplayCandidateLineSchema.parse(l));
  const candidateLines = candidateLinesAll.slice(0, sampleLimit);

  // Prefer fixture samples file if provided/exists; otherwise load from store (DB/mem).
  let sampleIndex = new Map();
  if (fixtureSamplesPath && fs.existsSync(fixtureSamplesPath)) {
    const samples = readJsonl(fixtureSamplesPath).map((l) => OutcomeSampleV0Schema.parse(l));
    sampleIndex = indexSamplesByJobId(samples.filter((s) => s.market === market));
  } else {
    const samples = await listOutcomeSamples({ market, limit: 50000 });
    sampleIndex = indexSamplesByJobId(samples);
  }

  const results = [];
  const skipped = [];

  for (const c of candidateLines) {
    const jobId = c.jobId;
    const sample = sampleIndex.get(jobId);
    if (!sample) {
      skipped.push({ jobId, reason: 'outcome_sample_not_found' });
      continue;
    }
    const replay = replayFromOutcomeSample(sample, market);
    if (!replay.ok) {
      skipped.push({ jobId, reason: replay.reason });
      continue;
    }

    results.push({
      jobId,
      candidate: c,
      baseline: {
        anyFallbackUsed: Boolean(sample.qualityFlags?.anyFallbackUsed),
        anyAdjustmentLowConfidence: Boolean(sample.qualityFlags?.anyAdjustmentLowConfidence),
        usedTechniquesCount: Array.isArray(sample.usedTechniques) ? sample.usedTechniques.length : 0,
      },
      replay: {
        kbFallbackUsed: Boolean(replay.kbFallbackUsed),
        anyLowConfidence: Boolean(replay.anyLowConfidence),
        missingTechniqueIds: replay.missingTechniqueIds,
        usedTechniquesCount: Array.isArray(replay.usedTechniques) ? replay.usedTechniques.length : 0,
      },
    });
  }

  // Deterministic ordering: by candidate priority desc (if present), then jobId.
  results.sort((a, b) => {
    const pa = typeof a.candidate.priority === 'number' ? a.candidate.priority : -Infinity;
    const pb = typeof b.candidate.priority === 'number' ? b.candidate.priority : -Infinity;
    if (pa !== pb) return pb - pa;
    return a.jobId.localeCompare(b.jobId);
  });

  const reportPath = path.join(outDir, 'replay_report.md');
  fs.writeFileSync(
    reportPath,
    renderMarkdownReport({ market, inputPath: fixtureCandidatesPath, sampleLimit, results, skipped }),
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log(`[kb:replay] wrote ${reportPath}`);

  if (args.ci) {
    const regressedFallback = results.filter((r) => !r.baseline.anyFallbackUsed && r.replay.kbFallbackUsed).length;
    const regressedLow = results.filter((r) => !r.baseline.anyAdjustmentLowConfidence && r.replay.anyLowConfidence).length;
    if (regressedFallback > 0 || regressedLow > 0) process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main };
